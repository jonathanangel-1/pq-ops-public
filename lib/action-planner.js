"use strict";

const {
  autonomyForChannel,
  autonomyForInternalAction,
  betaDraftModeContract,
  operatorApprovedInternalContract,
  safetyForChannel,
  safetyForInternalAction,
} = require("./action-safety");
const {
  allShipmentParticipants,
  counterpartyGreeting,
  matchParticipantsToNames,
  parseAddressList,
  participantMatchesName,
  resolvePhoneContact,
  resolveRecipients,
  threadParticipants,
} = require("./action-recipients");

const PLANNER_VERSION = "canonical-action-planner-v1";
const CUSTOMS_CONTEST_ACTION_LABEL = "Confirm customs release/DO with the airline — driver is onsite and blocked; do not treat TMS 'released' as final until confirmed.";

// Grading and replay need a pinned clock: golden expectations rot when
// "recently asked -> wait" windows expire with wall time. Callers may pass
// context.now to buildCanonicalActionPlan; builders read plannerNow().
let CURRENT_PLAN_NOW = null;
function plannerNow(explicit) {
  if (explicit) return explicit instanceof Date ? explicit : new Date(explicit);
  return CURRENT_PLAN_NOW || new Date();
}
const AWB_PREFIX_AIRLINES = {
  "016": "United",
  "114": "EL AL",
  "238": "Arkia",
  "700": "Challenge",
  "932": "Virgin Atlantic",
};

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function displayAwb(value) {
  const normalized = normalizeAwb(value);
  return normalized.length === 11 ? `${normalized.slice(0, 3)}-${normalized.slice(3)}` : String(value || "");
}

function compact(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function unique(values) {
  return [...new Set((values || []).map((item) => String(item || "").trim()).filter(Boolean))];
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function actionBody(lines) {
  return (lines || []).filter(Boolean).join("\n");
}

function parseEtaText(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const cleaned = text
    .replace(/\s+[A-Z]{3}\s*$/, "")
    .replace(/\s*\/\s*/, " ")
    .trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function etaMetadataForShipment(shipment = {}, now = new Date()) {
  const etaText = shipment.eta || shipment.liveTracking?.scheduledArrival || shipment.flightDetails?.etaHint || "";
  // An unresolved relative label ("ARRIVE MON 10:15" with no anchor) is not a
  // date; it must never read as ETA passed/due (INC-2026-07-05).
  if (shipment.etaUnresolvedRelative) {
    return { etaStatus: "", etaLabel: "", etaDetail: "", etaText };
  }
  if (!etaText && shipment.trackingException?.type !== "eta-passed-no-arrival-proof") {
    return { etaStatus: "", etaLabel: "", etaDetail: "", etaText: "" };
  }
  const eta = parseEtaText(etaText);
  const passed = shipment.trackingException?.type === "eta-passed-no-arrival-proof" || (eta && eta.getTime() <= now.getTime());
  return {
    etaStatus: passed ? "passed" : "due-soon",
    etaLabel: passed ? "ETA passed" : "ETA due",
    etaDetail: passed
      ? "ETA has passed, but station arrival/availability proof is still missing."
      : "ETA is due soon, and station arrival/availability proof is still missing.",
    etaText,
  };
}

function phaseForShipment(shipment = {}) {
  return String(shipment.opsState?.phase || shipment.canonicalState?.phase || shipment.phase || "").toLowerCase();
}

function nextActionForShipment(shipment = {}) {
  return String(shipment.opsState?.nextAction || shipment.nextAction || shipment.canonicalState?.nextAction || "").trim();
}

function factText(row = {}) {
  if (!row) return "";
  if (typeof row === "string") return row;
  return [
    row.type,
    row.label,
    row.summary,
    row.note,
    row.evidence,
    row.nextAction,
    row.subject,
    row.from,
    row.to,
  ].filter(Boolean).join(" ");
}

function shipmentText(shipment = {}) {
  return [
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    shipment.nextAction,
    shipment.currentState,
    shipment.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.events || []).map(factText),
    ...(shipment.emailValidation?.proof || []).map(factText),
    ...(shipment.facts || []).map(factText),
    ...(shipment.factLedger || []).map(factText),
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.nextAction,
    ...(shipment.opsState?.exceptions || []).map((item) => `${item.type || ""} ${item.summary || ""} ${item.nextAction || ""}`),
    ...(shipment.opsState?.events || []).map(factText),
  ].filter(Boolean).join(" ");
}

function terminalRecoveryActionForShipment(shipment = {}) {
  const exceptions = Array.isArray(shipment.opsState?.exceptions) ? shipment.opsState.exceptions : [];
  const recovery = exceptions.find((item) =>
    /\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|wrong recipient|misdelivered|delivered by mistake|another customer|another cnee|delivery[-_\s]?blocked)\b/i.test(
      `${item.type || ""} ${item.exceptionType || ""} ${item.impact || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`,
    )
  );
  if (recovery?.nextAction) return recovery.nextAction;
  if (recovery) {
    return "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.";
  }
  return "";
}

function actionText(action = {}) {
  return [
    action.type,
    action.label,
    action.reason,
    action.problem,
    action.nextAction,
    action.subject,
    action.body,
  ].filter(Boolean).join(" ");
}

function hasUsableEmail(value) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      !/\b(?:unknown|not found|missing|n\/a|none|confirm)\b/i.test(text) &&
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
  );
}

function hasDatePhoneContactContamination(value) {
  const text = String(value || "");
  return (
    /\b(?:phone|call|tel|ext|at)?\s*20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/i.test(text) ||
    /\b\d{1,5}\s+20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/i.test(text)
  );
}

function hasUsablePhone(value) {
  const text = String(value || "").trim();
  if (!text || hasDatePhoneContactContamination(text)) return false;
  if (/\b(?:unknown|not found|missing|n\/a|none|confirm)\b/i.test(text)) return false;
  return text.replace(/\D/g, "").length >= 7;
}

function inferredAirlineFromAwb(awb) {
  return AWB_PREFIX_AIRLINES[normalizeAwb(awb).slice(0, 3)] || "";
}

function bestStationContactFromContext(shipment = {}) {
  const stations = shipment.stationContext?.stations || [];
  const airport = String(shipment.station || shipment.airport || "").toUpperCase();
  const airline = String(shipment.airline || inferredAirlineFromAwb(shipment.awb) || "").toLowerCase();
  return stations
    .filter((station) => !airport || String(station.airport || station.station || "").toUpperCase() === airport)
    .map((station) => {
      const aliasText = [
        station.airline,
        station.handlerName,
        station.stationName,
        ...(station.aliases || []),
      ].join(" ").toLowerCase();
      let score = 0;
      if (hasUsableEmail(station.stationEmail)) score += 4;
      if (hasUsablePhone(station.stationPhone)) score += 3;
      if (airline && aliasText.includes(airline)) score += 2;
      if (station.confidence === "high") score += 1;
      return { station, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.station || null;
}

function usableName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || /\b(?:unknown|not found|missing|n\/a|none|confirm)\b/i.test(text)) return "";
  return text;
}

function cleanDispatchBrokerName(value) {
  const broker = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .replace(/^(?:done|sent|broker[-\s]?awarded|awarded|dispatched)\s+/i, "")
    .replace(/\b(?:broker|carrier|dispatch|pickup|quote|rate|status request)\b$/i, "")
    .trim();
  if (!broker || /^(?:broker|carrier|pickup broker|dispatch|unknown|not found)$/i.test(broker)) return "";
  return broker;
}

function dispatchBrokerFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+(?:was\s+)?(?:approved|awarded|selected|confirmed)\s+for\s+pickup\b/i,
    /\b(?:approved|awarded|selected|confirmed)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+for\s+pickup\b/i,
    /\b(?:pickup|recovery)\s+(?:with|to|by)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)(?:\s+(?:at|for|on)\b|[.;,]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const broker = cleanDispatchBrokerName(match?.[1]);
    if (broker) return broker;
  }
  return "";
}

function stationRelationForShipment(shipment = {}) {
  const contextContact = bestStationContactFromContext(shipment);
  const directContact = shipment.contacts?.station || {};
  const airline = shipment.airline || inferredAirlineFromAwb(shipment.awb);
  const airport = String(shipment.station || shipment.airport || "").toUpperCase();
  const name = (
    directContact.name ||
    directContact.stationName ||
    directContact.handlerName ||
    contextContact?.handlerName ||
    contextContact?.stationName ||
    shipment.stationContext?.handlerName ||
    (airline && airport ? `${airline} Cargo ${airport}` : "") ||
    airport ||
    "station"
  );
  const email = hasUsableEmail(shipment.stationEmail)
    ? shipment.stationEmail
    : hasUsableEmail(directContact.email)
    ? directContact.email
    : hasUsableEmail(directContact.stationEmail)
    ? directContact.stationEmail
    : hasUsableEmail(shipment.stationContext?.email)
    ? shipment.stationContext.email
    : hasUsableEmail(contextContact?.stationEmail)
    ? contextContact.stationEmail
    : "";
  const phone = hasUsablePhone(shipment.stationPhone)
    ? shipment.stationPhone
    : hasUsablePhone(directContact.phone)
    ? directContact.phone
    : hasUsablePhone(directContact.stationPhone)
    ? directContact.stationPhone
    : hasUsablePhone(shipment.stationContext?.phone)
    ? shipment.stationContext.phone
    : hasUsablePhone(contextContact?.stationPhone)
    ? contextContact.stationPhone
    : "";
  return {
    type: "station",
    airport,
    airline,
    name,
    email,
    phone,
    source: contextContact?.id || shipment.stationContext?.contactSource || "",
    relationStatus: email || phone ? "known" : "missing-contact",
  };
}

function pickupRelationForShipment(shipment = {}, candidateActions = []) {
  const broker = shipment.freightBroker || {};
  const sourceRows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
  ];
  const dispatchText = [
    shipment.opsState?.gates?.dispatch?.broker,
    shipment.opsState?.gates?.dispatch?.evidence,
    shipment.opsState?.gates?.dispatch?.summary,
    ...(shipment.opsState?.events || []).map((event) => `${event.type || ""} ${event.label || ""} ${event.summary || ""} ${event.evidence || ""}`),
    ...(shipment.factLedger || []).map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`),
    ...(shipment.facts || []).map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`),
  ].filter(Boolean).join(" ");
  const evidenceBroker = dispatchBrokerFromText(dispatchText);
  const brokerAction = (candidateActions || []).find((action) =>
    /broker|pickup|pod/i.test(`${action.type || ""} ${action.targetName || ""} ${action.label || ""}`) &&
      (hasUsableEmail(action.targetEmail) || action.targetName)
  );
  const name =
    usableName(broker.broker) ||
    usableName(broker.name) ||
    usableName(broker.carrierName) ||
    usableName(broker.pickupBroker) ||
    usableName(evidenceBroker) ||
    usableName(brokerAction?.targetName) ||
    "";
  const email = hasUsableEmail(broker.email)
    ? broker.email
    : hasUsableEmail(broker.contactEmail)
    ? broker.contactEmail
    : hasUsableEmail(brokerAction?.targetEmail)
    ? brokerAction.targetEmail
    : "";
  // Audience-correct thread selection. The old single-regex `.find()` could hand a POD chase
  // the CUSTOMS thread (any row mentioning "broker"/"pod" matched, in stored order). Rank rows:
  // dispatch-family event types and identity matches with the chosen pickup broker win;
  // customs/station-family rows are penalized so the wrong audience can never outrank a real
  // dispatch thread. No positive-scoring row -> start a new thread rather than hijack one.
  const dispatchTypeRe = /^(?:broker-(?:alerted|awarded|confirmed)|pickup-(?:scheduled|onsite|confirmed)|delivered-reported|pod-(?:received|pending)|shipment-group-linked|dispatch-owner)$/i;
  const customsFamilyRe = /\b(?:customs|release|clearance|abi|inbond|arrival[-\s]?notice|station|entry)\b/i;
  const scoredThreadRows = sourceRows
    .filter((row) => row?.threadId || row?.messageId || row?.replyMessageId)
    .map((row) => {
      const rowType = String(row.type || "");
      const text = `${rowType} ${row.label || ""} ${row.summary || ""} ${row.evidence || ""} ${row.subject || ""} ${row.broker || ""}`;
      const rowIdentity = `${row.broker || ""} ${row.contactEmail || ""} ${row.to || ""} ${row.from || ""}`.toLowerCase();
      let score = 0;
      if (dispatchTypeRe.test(rowType)) score += 4;
      else if (/broker[-_\s]?awarded|pickup[-_\s]?quote|pickup[-_\s]?scheduled|dispatch|pickup|pod|delivery|tql|btx|jd direct|meadow freight|rapid/i.test(text)) score += 1;
      if (email && rowIdentity.includes(String(email).toLowerCase())) score += 3;
      else if (name && rowIdentity.includes(String(name).toLowerCase())) score += 2;
      if (customsFamilyRe.test(text) && !dispatchTypeRe.test(rowType)) score -= 3;
      const at = Date.parse(row.at || row.date || "") || 0;
      return { row, score, at };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.at - a.at);
  const threadRow = scoredThreadRows[0]?.row || {};
  return {
    type: "pickup-broker",
    name,
    email,
    status: broker.status || broker.brokerStatus || "",
    threadId: threadRow.threadId || "",
    messageId: threadRow.messageId || threadRow.replyMessageId || "",
    relationStatus: name || email ? "known" : "missing-contact",
  };
}

// Truth prose often names the broker with its address inline ("Alison is the
// broker (drew@/contact-083@demo-freight.example)"). Extract only verbatim, complete
// addresses from broker-identifying sentences — never compose from fragments.
function customsBrokerFromEvidenceText(shipment = {}) {
  const rows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
  ];
  for (const row of rows) {
    const text = [row.summary, row.note, row.evidence, row.claim].filter(Boolean).join(" ");
    if (!/\b(?:is the (?:customs\s+)?broker|broker is|customs broker[:( ]|brokerage[:( ])/i.test(text)) continue;
    const address = parseAddressList(text).find((entry) => hasUsableEmail(entry.email));
    if (!address) continue;
    const nameMatch = text.match(/\b([A-Z][A-Za-z&.' -]{2,40}?)\s+is the (?:customs\s+)?broker\b/);
    return { email: address.email, name: usableName(nameMatch?.[1]) || address.name || "" };
  }
  return null;
}

function customsRelationForShipment(shipment = {}) {
  const customs = shipment.customsBroker || shipment.contacts?.customs || {};
  const fromText = customsBrokerFromEvidenceText(shipment);
  const name =
    usableName(customs.broker) ||
    usableName(customs.name) ||
    usableName(customs.contactName) ||
    usableName(fromText?.name) ||
    "";
  const email = hasUsableEmail(customs.contactEmail)
    ? customs.contactEmail
    : hasUsableEmail(customs.email)
    ? customs.email
    : hasUsableEmail(fromText?.email)
    ? fromText.email
    : "";
  return {
    type: "customs-broker",
    name,
    email,
    status: customs.status || customs.brokerStatus || "",
    relationStatus: email ? "known" : "missing-contact",
  };
}

// Audience-scoped thread selection for station and customs follow-ups, mirroring
// the pickup scorer above: family-typed rows win, wrong-family rows are penalized,
// and no positive score means start a new thread instead of hijacking one.
const AUDIENCE_THREAD_FAMILIES = {
  station: {
    typeRe: /^(?:arrival-notice-received|station-ask-sent|station-cargo-not-found|pickup-docs-(?:needed|sent)|awb-copy-needed|pickup-location-(?:requested|replied)|storage-risk|fees?-(?:due|paid|confirmed))$/i,
    textRe: /\b(?:station|arrival|on[-\s]?hand|availability|handler|terminal|warehouse|awb copy|ground fees?|storage|pieces?)\b/i,
    penaltyRe: /\b(?:inbond|customs entry|clearance|broker[-_\s]?award|pickup[-_\s]?quote|dispatch)\b/i,
  },
  customs: {
    typeRe: /^(?:customs-(?:hold|release-received|entry)|release-(?:received|needed)|inbond-(?:rejected|resubmitted)|exception|arrival-notice-received)$/i,
    textRe: /\b(?:customs|release|clearance|inbond|in[-\s]?bond|entry|d\/?o\b|delivery order|abi|cbp|duty|7501|3461)\b/i,
    penaltyRe: /\b(?:pickup[-_\s]?quote|broker[-_\s]?award|dispatch|pod\b|proof of delivery)\b/i,
  },
};

function threadForAudience(shipment = {}, family, identity = {}) {
  const config = AUDIENCE_THREAD_FAMILIES[family];
  if (!config) return { threadId: "", messageId: "", at: 0 };
  const sourceRows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
  ];
  const identityNeedles = [identity.email, identity.name]
    .map((value) => String(value || "").toLowerCase().trim())
    .filter((value) => value.length >= 4);
  const scored = sourceRows
    .filter((row) => row?.threadId || row?.messageId)
    .map((row) => {
      const rowType = String(row.type || "");
      const narrativeRow = /manual/i.test(rowType);
      const text = `${rowType} ${row.label || ""} ${row.summary || ""} ${narrativeRow ? "" : row.evidence || ""} ${row.subject || ""}`;
      const rowIdentity = `${row.broker || ""} ${row.contactEmail || ""} ${row.to || ""} ${row.cc || ""} ${row.from || ""}`.toLowerCase();
      let score = 0;
      if (config.typeRe.test(rowType)) score += 4;
      else if (config.textRe.test(text)) score += 1;
      for (const needle of identityNeedles) if (rowIdentity.includes(needle)) score += 2;
      if (config.penaltyRe.test(text) && !config.typeRe.test(rowType)) score -= 3;
      return { row, score, at: Date.parse(row.at || row.date || "") || 0 };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.at - a.at);
  const best = scored[0]?.row;
  if (!best) return { threadId: "", messageId: "", at: 0 };
  // Reply to the LIVE end of the chosen thread, not the row that happened to score
  // best (which may be days old) — INC-2026-07-02 class: stale reply targets.
  const participantsInfo = threadParticipants(shipment, best.threadId || "");
  return {
    threadId: best.threadId || "",
    messageId: participantsInfo.latestMessageId || best.messageId || best.replyMessageId || "",
    at: participantsInfo.latestAt || 0,
    participantsInfo,
  };
}

// Sibling AWBs that evidence says move with this shipment (group events carry
// groupAwbs/appliesToAwbs rosters). Used so a draft on a shared thread names
// every AWB it covers, or explicitly narrows to one.
function siblingAwbsFromEvidence(shipment = {}, threadId = "") {
  const self = normalizeAwb(shipment.awb);
  const rows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
  ];
  const collect = (scopeThreadId) => {
    const siblings = new Set();
    for (const row of rows) {
      if (scopeThreadId && String(row.threadId || "") !== String(scopeThreadId)) continue;
      for (const list of [row.groupAwbs, row.appliesToAwbs]) {
        if (!Array.isArray(list) || list.length < 2) continue;
        const normalized = list.map(normalizeAwb).filter(Boolean);
        if (!normalized.includes(self)) continue;
        for (const awb of normalized) if (awb !== self) siblings.add(awb);
      }
    }
    return [...siblings];
  };
  const scoped = collect(threadId);
  // Evidence-wide fallback: a sibling that rides the same physical pickup is
  // relevant even when the chosen thread's rows don't carry the group roster.
  const fromRows = scoped.length || !threadId ? scoped : collect("");
  // Truth prose also names siblings directly ("confirm the driver collected
  // 114-80000269 (and 353)") — full AWBs verbatim, plus the repo's established
  // suffix convention (see ingest regression suffix-only-sibling-grouping).
  const prose = `${shipment.opsState?.nextAction || ""} ${shipment.opsState?.summary || ""}`;
  const fromProse = new Set(fromRows);
  for (const match of prose.match(/\b\d{3}[- ]?\d{8}\b/g) || []) {
    const awb = normalizeAwb(match);
    if (awb && awb !== self) fromProse.add(awb);
  }
  const suffixMatch = prose.match(/\((?:and|\+)\s*(\d{3,4})\)/i);
  if (suffixMatch && self.length === 11) {
    const sibling = self.slice(0, self.length - suffixMatch[1].length) + suffixMatch[1];
    if (sibling !== self) fromProse.add(sibling);
  }
  return [...fromProse];
}

function recipientBlockForAction(shipment = {}, relation = {}, threadId = "", options = {}) {
  const thread = threadId ? threadParticipants(shipment, threadId) : null;
  const resolved = resolveRecipients(shipment, relation, thread, options);
  return { thread, resolved };
}

function joinAddresses(entries = []) {
  return entries.map((entry) => entry.email).filter(Boolean).join(", ");
}

function ccWithExtras(resolvedCc = [], extraCc = []) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...(resolvedCc || []), ...(extraCc || [])]) {
    const email = String(entry.email || "").toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    merged.push(entry);
  }
  return merged;
}

// If the newest message in the chosen thread is our own outbound ask and it is
// recent, the operator-grade move is to wait for the reply, not send a duplicate.
const RECENT_OUTREACH_HOURS = 18;
function recentOutboundAskInThread(threadInfo, now = new Date()) {
  const info = threadInfo?.participantsInfo || threadInfo;
  if (!info || info.latestOutbound !== true || !info.latestAt) return false;
  return now.getTime() - info.latestAt < RECENT_OUTREACH_HOURS * 3600 * 1000;
}

function waitingOnReplyAction(shipment, relation, threadInfo, options = {}) {
  const info = threadInfo?.participantsInfo || threadInfo || {};
  const askedAt = info.latestAt ? new Date(info.latestAt).toISOString() : "";
  const who = relation.name || relation.email || "the counterparty";
  return basePlatformAction(shipment, "waiting-on-reply", `Waiting on ${who}`, {
    priority: shipment.opsState?.priority || "normal",
    stage: options.stage || "waiting-on-reply",
    trigger: "recent-outbound-ask-in-thread",
    problem: `We already asked ${who}${askedAt ? ` at ${askedAt}` : ""} in the live thread; a duplicate chase would look careless.`,
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)}: our ask to ${who} is the newest message in the thread.`,
      `No chase needed yet. Re-chase after ${RECENT_OUTREACH_HOURS}h without a reply, or record the outcome if it arrived by phone.`,
    ]),
    nextAction: options.nextAction || `Wait for ${who} to reply; re-chase after ${RECENT_OUTREACH_HOURS}h of silence.`,
    operatorUpdateOptions: ["Reply received", "Chase now anyway", "Outcome recorded by phone"],
    postActionExpectedFact: options.postActionExpectedFact || `${who} replies in the thread or the operator records the outcome.`,
  });
}

// Call action: only when we can NAME the person/company. Registry autonomy level
// "Record only" — the operator dials, the platform records the result.
function callContactAction(shipment, relation, ask, options = {}) {
  const contact = resolvePhoneContact(shipment, relation);
  const awb = displayAwb(shipment.awb);
  if (!contact.available) {
    return basePlatformAction(shipment, "contact-phone-research", `Find phone for ${contact.name}`, {
      priority: options.priority || shipment.opsState?.priority || "high",
      stage: options.stage || "contact-phone-missing",
      trigger: "call-needed-without-phone-number",
      transport: options.transport || "station-memory",
      autonomyLabel: "Save contact phone",
      problem: `${contact.name} should be called (${ask}), but the phone number is missing.`,
      body: actionBody([
        `AWB ${awb}: ${ask}`,
        `Phone number missing for ${contact.name}.`,
        contact.nextStep,
      ]),
      nextAction: `Find and save ${contact.name}'s phone number, then call.`,
      postActionExpectedFact: "Contact phone number is saved and the call action becomes dialable.",
    });
  }
  return {
    id: `${normalizeAwb(shipment.awb)}-call-${slug(contact.name)}-${slug(options.stage || ask)}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: options.type || "call-contact",
    label: `Call ${contact.name}`,
    channel: "phone",
    execution: "operator-call",
    autonomy: autonomyForInternalAction("operator-note", `Call ${contact.name}`),
    safety: safetyForInternalAction(
      "operator-note",
      "Operator dials the number and records the result; the platform never places calls.",
    ),
    betaContract: operatorApprovedInternalContract("operator-note"),
    status: "suggested",
    priority: options.priority || shipment.opsState?.priority || "high",
    targetName: contact.name,
    targetEmail: "",
    targetPhone: contact.phone,
    phone: contact.phone,
    subject: `${awb} - call ${contact.name}`,
    problem: options.problem || ask,
    body: actionBody([
      `Call ${contact.name} (${contact.role}) at ${contact.phone}.`,
      `AWB ${awb}: ${ask}`,
      "Record the outcome so shipment truth updates.",
    ]),
    reason: options.reason || ask,
    nextAction: `Call ${contact.name} at ${contact.phone}: ${ask}`,
    timing: {
      stage: options.stage || "call-contact",
      trigger: options.trigger || "email-relation-missing-phone-known",
      phase: phaseForShipment(shipment),
    },
    operatorUpdateOptions: options.operatorUpdateOptions || ["Confirmed by phone", "No answer", "Wrong contact", "Blocker found"],
    operatorOutcomeOptions: options.operatorOutcomeOptions || [],
    postActionExpectedFact: options.postActionExpectedFact || `${contact.name} confirms by phone and the operator records the result as shipment truth.`,
  };
}

function sourceFactIdsForShipment(shipment = {}) {
  const gateIds = (shipment.truthPacket?.gates || [])
    .flatMap((gate) => Array.isArray(gate.sourceFactIds) ? gate.sourceFactIds : [])
    .filter(Boolean);
  const evidenceIds = (shipment.opsState?.evidence || [])
    .flatMap((item) => [item.sourceFactId, item.factId, item.id])
    .filter(Boolean);
  return unique([...gateIds, ...evidenceIds]).slice(0, 12);
}

function actionConditionKey(action = {}) {
  return [
    normalizeAwb(action.awb || action.shipmentAwb || action.shipmentId),
    action.type || "",
    action.targetEmail || action.targetName || "",
    action.timing?.stage || "",
    compact(action.label || action.reason || action.nextAction || action.id || "", 80),
  ].join(":").toLowerCase();
}

function dedupeActions(actions = []) {
  const seen = new Set();
  const rows = [];
  for (const action of actions || []) {
    if (!action) continue;
    const key = actionConditionKey(action);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(action);
  }
  return rows;
}

function failedOrClosedAction(action = {}) {
  return /\b(?:failed|blocked|cancelled|canceled|dismissed|completed|sent|drafted)\b/i.test(String(action.status || ""));
}

function gateStatusFor(shipment = {}, gate) {
  return String(shipment.opsState?.gates?.[gate]?.status || "").toLowerCase();
}

function gateProven(status) {
  return /^(?:done|received|confirmed|complete|completed|released|paid|true)$/.test(String(status || ""));
}

function actionContradictsCanonicalState(action = {}, shipment = {}) {
  const phase = phaseForShipment(shipment);
  const nextAction = nextActionForShipment(shipment);
  const text = actionText(action);
  const fullText = `${nextAction} ${shipmentText(shipment)}`;
  // Gate-proven truth beats text heuristics: never ask for what a gate already
  // proves (POD on file, pickup executed, release received, fees paid).
  if (gateProven(gateStatusFor(shipment, "pod")) && /\b(?:pod-followup|request pod|send pod|proof of delivery|delivery\/pod)\b/i.test(text)) {
    return true;
  }
  if (gateProven(gateStatusFor(shipment, "pickup")) && /\b(?:confirm pickup|pickup-execution|request pickup status|pickup status)\b/i.test(text) && !/\bpod|delivery\b/i.test(text)) {
    return true;
  }
  if (gateProven(gateStatusFor(shipment, "customs")) && /\b(?:customs[-\s]?followup|confirm (?:the )?(?:current )?customs|release status|request release|chase release)\b/i.test(text) &&
      !/\bd\/?o\b|delivery order|retransmit|resubmit|duty|storage/i.test(text)) {
    return true;
  }
  if (gateProven(gateStatusFor(shipment, "fees")) && /\b(?:confirm (?:ground )?fees|fee[-\s]?followup|pay (?:the )?(?:ground )?fees|storage (?:fees?|charges?) (?:due|owed)|cargosprint payment needed)\b/i.test(text)) {
    return true;
  }
  if (
    historicalResolvedExceptionText(fullText) &&
    ["pre-arrival", "in-transit", "arrival-unverified", "arrival-incomplete"].includes(phase) &&
    /\b(?:awb copy|air waybill copy|wfs|handoff|ua area|uc360|transfer)\b/i.test(text)
  ) {
    return true;
  }
  const transferOrAwbCopyOnly = /\b(?:awb copy|air waybill copy|wfs|handoff|transfer|ua area|uc360|deleted flight)\b/i.test(
    fullText,
  );
  if (transferOrAwbCopyOnly && /\b(?:delivery-order|delivery order|release-packet|generate do|send do)\b/i.test(text)) {
    return true;
  }
  if (["out-for-delivery", "pod-needed", "delivered-pod-pending", "picked-up"].includes(phase) &&
      /\b(?:quote-request|broker-award|station-confirmation|delivery-order-email|release-packet)\b/i.test(text)) {
    return true;
  }
  if (
    ["exception", "pre-arrival", "in-transit", "arrival-incomplete", "release-needed", "customs-hold", "fees-needed", "pickup-docs-needed", "awb-copy-needed"].includes(phase) &&
    /\b(?:pod-followup|request pod|proof of delivery|delivery\/pod|delivery status|collect pod)\b/i.test(text)
  ) {
    return true;
  }
  if (
    ["exception", "arrival-incomplete", "release-needed", "customs-hold", "fees-needed", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "delivery-blocked"].includes(phase) &&
    /\b(?:quote-request|quote-followup|prearrival-quote|prep pickup quote|broker-award|tms-broker-award)\b/i.test(text)
  ) {
    return true;
  }
  if (["ready-for-pickup", "dispatch-ready", "approval-needed"].includes(phase) &&
      /\b(?:quote-request|quote-followup|prearrival-quote|delivery-order-email|release-packet)\b/i.test(text) &&
      /\b(?:dispatch|awarded|approved|sent|ready)\b/i.test(`${shipment.freightBroker?.status || ""} ${shipment.freightBroker?.brokerStatus || ""} ${nextAction}`)) {
    return true;
  }
  return false;
}

function usableCandidateActions(shipment = {}, candidateActions = []) {
  return dedupeActions(candidateActions)
    .filter((action) => !failedOrClosedAction(action))
    .filter((action) => !actionContradictsCanonicalState(action, shipment));
}

function truthRepairAction(action = {}) {
  return ["source-backfill", "station-contact-research", "carrier-tracking-refresh"].includes(String(action.type || ""));
}

function executableAction(action = {}) {
  return ["gmail", "document", "couriercloud", "couriercloud-tms", "tms", "phone"].includes(String(action.channel || "").toLowerCase());
}

function platformDecisionAction(action = {}) {
  return String(action.channel || "").toLowerCase() === "platform" && !truthRepairAction(action);
}

function findCandidate(actions = [], predicate) {
  return actions.find((action) => predicate(action, actionText(action)));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function quoteAmountValue(value) {
  const match = String(value || "").match(/\$?\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return Infinity;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : Infinity;
}

function quoteAmountText(row = {}, text = "") {
  return row.amount || row.rate || row.price || row.quoteAmount || String(text || "").match(/\$\s*\d[\d,]*(?:\.\d+)?/)?.[0] || "";
}

function pickupQuoteText(value) {
  const text = String(value || "");
  return /\b(?:pickup[-\s]?quote|pickup\/delivery|can recover|recover(?:y)?(?:\s+rate)?|pickup rate|cartage|last[-\s]?mile|truck|driver|pickup)\b/i.test(text) ||
    /\b(?:quoted|quote|rate is|rate:)\b/i.test(text) && /\b(?:pickup|recover|delivery|driver|truck|cartage)\b/i.test(text);
}

function airBookingQuoteText(value) {
  return /\b(?:air booking|airline rate|customer sell rate|linehaul|flight quote|booking rate|\d+(?:\.\d+)?\s*\/\s*kg|per\s*kg)\b/i.test(String(value || ""));
}

function cleanQuoteBrokerName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .replace(/\b(?:quoted|quote|rate|is|at|for|pickup|delivery|recover|recovery)\b.*$/i, "")
    .trim();
}

function quoteBrokerFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+(?:quoted|quotes|can recover|can pick\s*up|rate is|rate:)\b/i,
    /\b(?:quote|rate)\s+(?:from|by)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)(?:\s|[.;,]|$)/i,
  ];
  for (const pattern of patterns) {
    const broker = cleanQuoteBrokerName(text.match(pattern)?.[1]);
    if (broker) return broker;
  }
  return "";
}

function quoteRowsForShipment(shipment = {}) {
  const rows = [
    ...list(shipment.freightBroker?.quotes),
    ...list(shipment.brokerDispatch?.quotes),
    ...list(shipment.quotes),
    ...list(shipment.facts),
    ...list(shipment.factLedger),
    ...list(shipment.events),
    ...list(shipment.opsState?.events),
    ...list(shipment.opsState?.evidence),
  ];
  const seen = new Set();
  return rows
    .map((row) => {
      const text = [
        row.type,
        row.label,
        row.summary,
        row.evidence,
        row.note,
        row.subject,
        row.body,
        row.broker,
        row.name,
        row.targetName,
        row.amount,
        row.rate,
        row.price,
      ].filter(Boolean).join(" ");
      const amount = quoteAmountText(row, text);
      const broker = row.broker || row.name || row.targetName || quoteBrokerFromText(text);
      const email = row.contactEmail || row.email || row.targetEmail || text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
      return {
        broker: usableName(broker),
        amount: String(amount || "").trim(),
        email,
        threadId: row.threadId || "",
        messageId: row.messageId || "",
        quotedAt: row.at || row.quotedAt || "",
        text,
      };
    })
    .filter((quote) => quote.broker && quote.amount && Number.isFinite(quoteAmountValue(quote.amount)))
    .filter((quote) => pickupQuoteText(quote.text) || /pickup[-_\s]?quote[-_\s]?received/i.test(quote.text))
    .filter((quote) => !airBookingQuoteText(quote.text) || pickupQuoteText(quote.text))
    .filter((quote) => {
      const key = `${quote.broker.toLowerCase()}|${quote.amount.replace(/\s+/g, "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => quoteAmountValue(a.amount) - quoteAmountValue(b.amount));
}

function brokerAwardActionFromQuote(shipment, quote) {
  if (!quote?.broker || !quote?.amount) return null;
  const awb = displayAwb(shipment.awb);
  const brokerName = quote.broker;
  const email = hasUsableEmail(quote.email) ? quote.email : "";
  if (!email) {
    return basePlatformAction(shipment, "operator-state-check", `Award ${brokerName} ${quote.amount}`.trim(), {
      priority: shipment.opsState?.priority || "high",
      stage: "quote-award-contact-missing",
      trigger: "pickup-quotes-ready-without-award-contact",
      problem: `${brokerName} is the lowest pickup quote, but the planner does not have a safe email/thread relation.`,
      nextAction: `Award ${brokerName} ${quote.amount} after saving the broker email/thread relation.`,
      operatorUpdateOptions: ["Broker email found", "Award sent", "Pick another broker", "Quote stale"],
      postActionExpectedFact: "Pickup broker award or broker-contact relation is recorded.",
    });
  }
  const { resolved } = recipientBlockForAction(shipment, { type: "pickup-broker", name: brokerName, email }, quote.threadId || "", {
    toReason: `${brokerName} holds the lowest pickup quote (${quote.amount}).`,
  });
  return {
    id: `${normalizeAwb(shipment.awb)}-broker-award-${slug(brokerName)}-${slug(quote.amount)}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: "broker-award",
    label: `Award ${brokerName} ${quote.amount}`.trim(),
    channel: "gmail",
    execution: "draft_gmail_email",
    autonomy: autonomyForChannel("gmail"),
    safety: safetyForChannel("gmail"),
    betaContract: betaDraftModeContract(),
    status: "suggested",
    priority: shipment.opsState?.priority || "high",
    targetName: brokerName,
    targetEmail: resolved.to.length ? joinAddresses(resolved.to) : email,
    cc: joinAddresses(resolved.cc),
    recipients: resolved,
    confidence: resolved.confidence,
    missingProof: "Broker acceptance and pickup appointment.",
    recipientNotes: resolved.notes,
    subject: `${awb} - pickup award`,
    body: actionBody([
      counterpartyGreeting(brokerName),
      "",
      `AWB ${awb}: you're awarded at ${quote.amount}. Please confirm pickup timing and send loaded proof, then POD after delivery.`,
      "",
      "Thanks,",
    ]),
    reason: `${brokerName} is the lowest pickup quote found in shipment truth.`,
    nextAction: `Award ${brokerName} ${quote.amount} and wait for pickup acceptance/loaded proof.`,
    threadPolicy: quote.threadId ? "reply_existing" : "start_new",
    threadId: quote.threadId || "",
    messageId: quote.messageId || "",
    timing: {
      stage: "broker-award",
      trigger: "pickup-quotes-ready-for-award",
      phase: phaseForShipment(shipment),
    },
    postActionExpectedFact: "Selected pickup broker confirms acceptance, pickup appointment, or cannot perform.",
  };
}

function pickupQuoteDecisionAction(shipment = {}) {
  const quote = quoteRowsForShipment(shipment)[0] || null;
  return quote ? brokerAwardActionFromQuote(shipment, quote) : null;
}

function basePlatformAction(shipment, type, label, options = {}) {
  const awbKey = normalizeAwb(shipment.awb) || slug(shipment.id || "shipment");
  const stage = options.stage || type;
  return {
    id: `${awbKey}-${type}-${slug(stage || label)}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type,
    label,
    channel: "platform",
    execution: "operator-approved-internal",
    autonomy: autonomyForInternalAction(options.transport || "operator-note", options.autonomyLabel || "Save state outcome"),
    safety: safetyForInternalAction(
      options.transport || "operator-note",
      options.safetyNote || "Operator-approved action. The dashboard records the result or queues a local repair task; no outbound Gmail or CourierCloud mutation is performed.",
    ),
    betaContract: operatorApprovedInternalContract(options.transport || "operator-note"),
    status: "suggested",
    priority: options.priority || shipment.opsState?.priority || "high",
    targetName: options.targetName || "Operator",
    targetEmail: "",
    subject: options.subject || `${shipment.awb} - ${label}`,
    problem: options.problem || options.reason || "",
    body: options.body || options.problem || options.nextAction || label,
    reason: options.reason || options.problem || "",
    nextAction: options.nextAction || label,
    timing: {
      stage,
      trigger: options.trigger || stage,
      phase: phaseForShipment(shipment),
      ...(options.timing || {}),
    },
    operatorUpdateOptions: options.operatorUpdateOptions || [],
    operatorOutcomeOptions: options.operatorOutcomeOptions || [],
    evidence: unique(options.evidence || [
      shipment.opsState?.summary,
      nextActionForShipment(shipment),
      ...(shipment.opsState?.evidence || []).map((item) => item.summary || item.evidence || item.note || item.label || ""),
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
    postActionExpectedFact: options.postActionExpectedFact || "",
  };
}

function contactLine(label, contact = {}) {
  const name = contact.name || "";
  const email = contact.email || "";
  const phone = contact.phone || "";
  if (!name && !email && !phone) return "";
  return `${label}: ${[name, email, phone].filter(Boolean).join(" - ")}.`;
}

function platformAlertAction(shipment, reason, nextAction, options = {}) {
  const awbKey = normalizeAwb(shipment.awb) || slug(shipment.id || "shipment");
  const station = options.station || {};
  const pickup = options.pickup || {};
  const customs = options.customs || {};
  const contacts = unique([
    contactLine("Station", station),
    contactLine("Pickup broker", pickup),
    contactLine("Customs broker", customs),
  ].filter(Boolean));
  const safeReason = reason || `Canonical state ${phaseForShipment(shipment) || "open"} needs operator attention.`;
  const primaryStep = nextAction || "Review the shipment and decide the next operator move.";
  const steps = unique([
    primaryStep,
    options.secondaryStep || "",
  ]);
  const stage = options.stage || "canonical-action-gap";
  return {
    id: `${awbKey}-operator-ping-${slug(stage || primaryStep)}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: "operator-ping",
    label: primaryStep,
    channel: "platform",
    execution: "platform-alert",
    autonomy: autonomyForChannel("platform"),
    safety: safetyForChannel("platform"),
    betaContract: betaDraftModeContract(),
    status: "suggested",
    priority: options.priority || shipment.opsState?.priority || "high",
    targetName: "Ops Brain",
    targetEmail: "",
    subject: options.subject || `${displayAwb(shipment.awb)} - operator attention needed`,
    reason: safeReason,
    problem: safeReason,
    nextAction: primaryStep,
    body: actionBody([
      `${displayAwb(shipment.awb)} needs attention.`,
      `Problem: ${safeReason}.`,
      `State: ${shipment.opsState?.label || shipment.currentState || phaseForShipment(shipment) || "open"}.`,
      contacts.length ? "Contacts:" : "",
      ...contacts.map((line) => `- ${line.replace(/\.$/, "")}`),
      "Recommended next steps:",
      ...steps.map((line) => `- ${line.replace(/\.$/, "")}`),
    ]),
    timing: {
      stage,
      trigger: options.trigger || "canonical-next-action-without-action-packet",
      phase: phaseForShipment(shipment),
      ...(options.timing || {}),
    },
    operatorUpdateOptions: options.operatorUpdateOptions || ["Blocker resolved", "Contacted station", "Contacted broker", "Contradiction found"],
    operatorOutcomeOptions: options.operatorOutcomeOptions || [],
    evidence: unique(options.evidence || [
      shipment.opsState?.summary,
      nextActionForShipment(shipment),
      ...(shipment.opsState?.evidence || []).map((item) => item.summary || item.evidence || item.note || item.label || ""),
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
    postActionExpectedFact: options.postActionExpectedFact || "The blocker outcome is recorded in shipment truth before the shipment advances.",
  };
}

// Canonical nextAction text is written FOR the operator ("Reply to the UPS ELP
// inbond group (+Concepcion Hammond, cc Riley Jordan/FA): AMS is corrected...").
// A draft body must carry only the counterparty-facing substance.
function counterpartyAsk(ask) {
  let text = String(ask || "").trim();
  const directive = /^\s*(?:reply(?:\s+all)?|respond|new draft|draft(?:\s+an?\s+email)?|email|send|escalate|follow up)\b[^:]{0,160}:\s*/i;
  if (directive.test(text)) text = text.replace(directive, "");
  // Strip workflow instructions that tell the operator what to do after (or
  // instead of) communicating. They are never counterparty copy.
  text = text
    .replace(/[,;]?\s*verify\b[^.;\n]{0,160}\binternally\b[^.;\n]*[.!]?\s*$/i, "")
    .replace(/[,;]?\s*(?:then\s+)?(?:reply|respond|follow up)\b[^.;\n]{0,160}\b(?:thread|internally)\b[^.;\n]*[.!]?\s*$/i, "")
    .trim();
  // A leading generate/monitor/record clause is operator work. If a later
  // clause follows a semicolon, retain only that later counterparty ask;
  // otherwise the cleaned result is empty and the branch default takes over.
  text = text.replace(
    /^\s*(?:generate\s*(?:\/|and)\s*send|generate|monitor|record)\b[^.;]*(?:[.;]\s*|$)/i,
    "",
  ).trim();
  return text
    .replace(/\(\+[^)]{0,120}\)/g, "")
    .replace(/[,;]?\s*\bcc\b\s+[A-Za-z][\w./@ -]{0,60}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// The packet's nextAction is OPERATOR guidance. An email body may carry it
// only when it matches the branch's intent family — otherwise internal
// next-step phrasing ("Confirm final delivery and collect POD") leaks to the
// wrong counterparty (production case 016-80000156: an AWB-copy station ask
// carried the POD plan).
const ASK_INTENT_FAMILIES = {
  awbcopy: /awb copy|air ?waybill|handoff|wfs|transfer/i,
  arrival: /arriv|on ?hand|availab|piece count/i,
  customs: /release|customs|inbond|clearance|d\/?o\b|delivery order/i,
  dispatch: /pickup|pick up|loaded|driver|delivery|pod|status|timing/i,
  fees: /fee|storage|last free day|lfd\b|invoice|cargosprint|charge/i,
};
// Operator self-instructions ("Monitor arrival; do not dispatch pickup yet",
// "On 07/06 re-confirm...", "Record checkpoint") can topic-match a family and
// still be nonsense in a counterparty email — they describe OUR plan, not a
// question for THEM (production case: three station availability emails opened
// with "Monitor arrival; do not dispatch pickup yet").
const OPERATOR_DIRECTIVE_ASK_RE = /^\s*(?:monitor|record|track|hold|wait|watch|check|decide|review|re-?run|generate(?:\s*\/\s*send)?|on\s+\d{1,2}\/\d{1,2})\b|do not dispatch|our side|re-?run truth|truth packet|\b(?:then\s+)?(?:reply|respond|follow up)\b[^.;\n]{0,120}\bthread\b|\bverify\b[^.;\n]{0,120}\binternally\b/i;
function askForIntent(intent, nextActionText, fallbackAsk) {
  const family = ASK_INTENT_FAMILIES[intent];
  const raw = String(nextActionText || "").trim();
  const text = counterpartyAsk(raw);
  if (!family || !text || !family.test(text)) return fallbackAsk;
  if (OPERATOR_DIRECTIVE_ASK_RE.test(raw) || OPERATOR_DIRECTIVE_ASK_RE.test(text)) return fallbackAsk;
  return text;
}

function askSentence(ask) {
  const text = compact(counterpartyAsk(ask), 220).replace(/\.+$/, "").replace(/\bon-hand\b/gi, "on hand");
  if (!text) return "";
  return /^[a-z]/.test(text) ? `Please ${text}.` : `${text}.`;
}

function awbListForBody(shipment, siblings = []) {
  const all = [displayAwb(shipment.awb), ...siblings.map(displayAwb)];
  return all.length > 1 ? `AWBs ${all.join(", ")}` : `AWB ${all[0]}`;
}

function stationAskWithPieceCount(cleanedAsk = "") {
  const text = String(cleanedAsk || "").trim();
  if (
    !text ||
    !/\b(?:arrival|on hand|availability|available|pickup)\b/i.test(text) ||
    /\b(?:piece count|pieces?)\b/i.test(text)
  ) {
    return text;
  }
  if (/\s+and pickup requirements\b/i.test(text)) {
    return text.replace(/\s+and pickup requirements\b/i, ", piece count, and pickup requirements");
  }
  if (/\s+and pickup availability\b/i.test(text)) {
    return text.replace(/\s+and pickup availability\b/i, ", piece count, and pickup availability");
  }
  if (/\bpickup can proceed\b/i.test(text)) {
    return text.replace(/\bpickup can proceed\b/i, "pickup can proceed and confirm piece count");
  }
  return `${text}, and piece count`;
}

function stationAskLineForBody(shipment, siblings = [], ask = "") {
  const awbList = awbListForBody(shipment, siblings);
  const cleanedAsk = stationAskWithPieceCount(compact(counterpartyAsk(ask), 220)
    .replace(/\.+$/, "")
    .replace(/\bon-hand\b/gi, "on hand")
    .trim());
  if (!cleanedAsk) return `Please confirm ${awbList} status.`;
  if (/^confirm\b/i.test(cleanedAsk)) {
    return `Please confirm ${awbList}: ${cleanedAsk.replace(/^confirm\s*/i, "")}.`;
  }
  const directAsk = cleanedAsk.replace(/^please\s+/i, "");
  if (/^(?:send|share|provide)\b/i.test(directAsk)) {
    return `Please ${directAsk} for ${awbList}.`;
  }
  return `Please confirm ${awbList}: ${directAsk}.`;
}

function stationConfirmationAction(shipment, station, options = {}) {
  const awb = displayAwb(shipment.awb);
  const ask = options.ask || nextActionForShipment(shipment) || "confirm current station status";
  const subject = `${awb} - ${options.subjectSuffix || "station status confirmation"}`;
  const eta = etaMetadataForShipment(shipment);
  // A "new draft" directive means a fresh conversation: recipients may still come
  // from thread rosters upstream, but the email must not anchor to an old thread.
  const threadInfo = options.forceNewConversation
    ? { threadId: "", messageId: "", participantsInfo: null }
    : options.threadInfo || threadForAudience(shipment, "station", { email: station.email, name: station.name });
  if (recentOutboundAskInThread(threadInfo, plannerNow(options.now))) {
    return waitingOnReplyAction(shipment, station, threadInfo, {
      stage: "waiting-on-station-reply",
      postActionExpectedFact: options.postActionExpectedFact,
    });
  }
  const siblings = siblingAwbsFromEvidence(shipment, threadInfo.threadId);
  const { resolved } = recipientBlockForAction(shipment, station, threadInfo.threadId, {
    toReason: `${station.airport || "Station"} import desk of record for this shipment.`,
  });
  const to = resolved.to.length ? joinAddresses(resolved.to) : station.email;
  if (!hasUsableEmail(to)) {
    if (hasUsablePhone(station.phone)) {
      return callContactAction(shipment, station, counterpartyAsk(ask) || "confirm current station status", {
        stage: "station-status-by-phone",
        trigger: "station-email-missing-phone-known",
      });
    }
    return stationContactResearchAction(shipment, station, "Station ask is clear, but no confident station address exists in stored evidence.");
  }
  const threadPolicy = threadInfo.threadId ? "reply_existing" : "start_new";
  const threadSubject = threadInfo.participantsInfo?.latestSubject || "";
  const stationAskLine = stationAskLineForBody(shipment, siblings, ask);
  const stationAskAlreadyCoversOnHand = /\b(?:on hand|availability|available)\b/i.test(stationAskLine) &&
    /\b(?:piece count|pieces?)\b/i.test(stationAskLine);
  return {
    id: `${normalizeAwb(shipment.awb)}-station-confirmation-${slug(options.stage || ask)}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: "station-confirmation",
    label: options.label || `Confirm with ${station.name || "station"}`,
    channel: "gmail",
    execution: "draft_gmail_email",
    autonomy: autonomyForChannel("gmail"),
    safety: safetyForChannel("gmail"),
    betaContract: betaDraftModeContract(),
    status: "suggested",
    priority: options.priority || shipment.opsState?.priority || "high",
    targetName: station.name || "Station",
    targetEmail: to,
    cc: joinAddresses(ccWithExtras(resolved.cc, options.extraCc)),
    recipients: resolved,
    subject: threadPolicy === "reply_existing" && threadSubject
      ? (/^re:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`)
      : subject,
    body: actionBody([
      counterpartyGreeting(resolved.to[0]?.name || station.name),
      "",
      stationAskLine,
      eta.etaDetail ? `ETA ${eta.etaText || eta.etaLabel} — arrival/availability proof still missing on our side.` : "",
      options.askOnHand === false || stationAskAlreadyCoversOnHand ? "" : "Please confirm the freight is on hand, the piece count, and whether pickup can proceed.",
      "",
      "Thanks,",
    ]),
    reason: options.alternative ? `${options.reason || ask} (alternative not sent: ${options.alternative})` : options.reason || ask,
    nextAction: options.nextAction || ask,
    threadPolicy,
    threadId: threadInfo.threadId || "",
    messageId: threadInfo.messageId || "",
    replyMessageId: threadPolicy === "reply_existing" ? threadInfo.messageId || "" : "",
    conversation: threadPolicy === "reply_existing" ? {
      threadId: threadInfo.threadId,
      replyMessageId: threadInfo.messageId || "",
      source: "station-thread-from-evidence",
      summary: "Live station/handler thread selected from shipment evidence.",
    } : null,
    confidence: resolved.confidence,
    missingProof: options.missingProof || "Station on-hand/availability confirmation.",
    recipientNotes: resolved.notes,
    coveredAwbs: siblings.length ? [normalizeAwb(shipment.awb), ...siblings] : undefined,
    timing: {
      stage: options.stage || "station-confirmation",
      trigger: options.trigger || "canonical-station-status-needed",
      phase: phaseForShipment(shipment),
    },
    etaStatus: eta.etaStatus,
    etaLabel: eta.etaLabel,
    etaDetail: eta.etaDetail,
    etaText: eta.etaText,
    postActionExpectedFact: options.postActionExpectedFact || "Station replies with current on-hand, availability, AWB-copy, handoff, or pickup-blocker status.",
  };
}

function stationContactResearchAction(shipment, station, reason) {
  return basePlatformAction(shipment, "station-contact-research", "Find station contact", {
    priority: "high",
    stage: "station-contact-research",
    trigger: "missing-station-contact",
    transport: "station-memory",
    autonomyLabel: "Save station contact",
    problem: reason || `${station.name || station.airport || "Station"} contact is missing or invalid.`,
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)} needs a station-side action, but the station relation is incomplete.`,
      `Station: ${[station.name, station.airport, station.airline].filter(Boolean).join(" / ") || "unknown"}.`,
      "Find the import desk email/phone, save it to station memory, then re-run action planning.",
    ]),
    nextAction: "Find and save the station import contact, then re-run the action planner.",
    postActionExpectedFact: "Station relation has a usable email or phone and can support a station action.",
  });
}

function stationContactResearchRetiredForShipment(shipment) {
  const phase = phaseForShipment(shipment);
  if (["picked-up", "out-for-delivery", "delivery-scheduled", "pod-needed", "delivered-pod-pending", "delivered", "completed"].includes(phase)) {
    return true;
  }
  const pickupStatus = String(shipment.pickupStatus || "").toLowerCase();
  if (/^(?:airport[-\s]?picked[-\s]?up|picked[-\s]?up|loaded|recovered|done|delivered)$/.test(pickupStatus)) return true;
  const pickupGate = gateStatusFor(shipment, "pickup");
  const deliveryGate = gateStatusFor(shipment, "delivery");
  const podGate = gateStatusFor(shipment, "pod");
  return gateProven(pickupGate) || gateProven(deliveryGate) || gateProven(podGate);
}

function pickupExecutionAction(shipment, pickup) {
  const brokerName = pickup.name || "pickup broker";
  return basePlatformAction(shipment, "operator-state-check", "Confirm pickup execution", {
    priority: shipment.opsState?.priority || "high",
    stage: "pickup-execution-check",
    trigger: "ready-for-pickup-without-pickup-proof",
    problem: `${brokerName} appears to own pickup, but pickup/loaded/POD proof is not complete.`,
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)} is ready for pickup/dispatch execution.`,
      `Pickup owner: ${brokerName}.`,
      "Confirm whether the pickup alert was accepted, whether the driver loaded/recovered the freight, and whether POD or delivery proof is already expected.",
    ]),
    nextAction: `Confirm pickup execution with ${brokerName}; collect loaded proof, out-for-delivery update, or POD.`,
    operatorUpdateOptions: ["Pickup broker accepted", "Driver loaded/recovered", "Out for delivery", "Delivered, POD pending", "No pickup yet"],
    operatorOutcomeOptions: [
      { value: "broker-accepted", label: "Pickup broker accepted", factTypes: ["broker-ack"] },
      { value: "picked-up", label: "Driver loaded/recovered", factTypes: ["pickup"] },
      { value: "out-for-delivery", label: "Out for delivery", factTypes: ["pickup", "delivery"] },
      { value: "delivered-pod-pending", label: "Delivered, POD pending", factTypes: ["delivery", "pod-pending"] },
      { value: "no-pickup-yet", label: "No pickup yet", factTypes: ["operator-state"] },
    ],
    postActionExpectedFact: "Pickup broker/driver confirms accepted, picked up, out for delivery, delivered, or no movement yet.",
  });
}

function pickupOwnerMissingAction(shipment) {
  const nextAction = "Select/alert a pickup broker and record the pickup owner, rate, and thread before execution.";
  return platformAlertAction(shipment, "Shipment is ready for pickup, but no freight broker/pickup owner is linked to the shipment truth.", nextAction, {
    priority: shipment.opsState?.priority || "high",
    stage: "pickup-owner-missing",
    trigger: "ready-for-pickup-without-pickup-owner",
    station: stationRelationForShipment(shipment),
    customs: customsRelationForShipment(shipment),
    secondaryStep: "After the broker accepts, record rate/thread and re-run action planning before execution follow-up.",
    operatorUpdateOptions: ["Pickup owner selected", "Pickup alert sent", "Quote needed", "No pickup yet"],
    operatorOutcomeOptions: [
      { value: "pickup-owner-selected", label: "Pickup owner selected", factTypes: ["broker-award", "dispatch"] },
      { value: "pickup-alert-sent", label: "Pickup alert sent", factTypes: ["dispatch"] },
      { value: "quote-needed", label: "Quote needed", factTypes: ["operator-state"] },
      { value: "no-pickup-yet", label: "No pickup yet", factTypes: ["operator-state"] },
    ],
    postActionExpectedFact: "Pickup broker/owner relation is recorded, or the operator explicitly marks that quotes/dispatch are still needed.",
  });
}

function notReadyRelationshipCheckAction(shipment) {
  const nextAction = nextActionForShipment(shipment) || "Confirm station fees/availability and pickup owner before pickup execution.";
  return platformAlertAction(shipment, "Shipment is released/arrived but station fees, availability, or pickup owner are not fully proven.", nextAction, {
    priority: shipment.opsState?.priority || "high",
    stage: "not-ready-relationship-check",
    trigger: "not-ready-without-complete-pickup-path",
    station: stationRelationForShipment(shipment),
    customs: customsRelationForShipment(shipment),
    pickup: pickupRelationForShipment(shipment),
    secondaryStep: "Record the station result and pickup-owner relation in shipment truth before promoting this shipment to ready-for-pickup.",
    operatorUpdateOptions: ["Fees/availability confirmed", "Pickup owner selected", "Quote needed", "Station blocker found"],
    operatorOutcomeOptions: [
      { value: "fees-availability-confirmed", label: "Fees/availability confirmed", factTypes: ["station", "fees"] },
      { value: "pickup-owner-selected", label: "Pickup owner selected", factTypes: ["broker-award", "dispatch"] },
      { value: "quote-needed", label: "Quote needed", factTypes: ["operator-state"] },
      { value: "station-blocker-found", label: "Station blocker found", factTypes: ["exception", "station"] },
    ],
    postActionExpectedFact: "Operator records whether station fees/availability and pickup owner are resolved or still blocking.",
  });
}

// A known future delivery appointment means POD cannot exist yet — chasing it
// reads as not having read the thread. Returns the scheduled date if in future.
function futureDeliverySchedule(shipment = {}, now = new Date()) {
  const rows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
  ];
  let best = null;
  for (const row of rows) {
    for (const value of [row.deliveryScheduledDate, row.scheduledDate]) {
      const parsed = Date.parse(value || "");
      if (!Number.isFinite(parsed)) continue;
      if (parsed > now.getTime() && (!best || parsed < best)) best = parsed;
    }
  }
  return best ? new Date(best) : null;
}

function podOrDeliveryProofAction(shipment, pickup, options = {}) {
  const brokerName = pickup.name || "pickup broker";
  const now = plannerNow(options.now);
  const scheduled = futureDeliverySchedule(shipment, now);
  if (scheduled) {
    return basePlatformAction(shipment, "waiting-on-reply", `Delivery scheduled ${scheduled.toISOString().slice(0, 10)}`, {
      priority: shipment.opsState?.priority || "normal",
      stage: "delivery-scheduled-wait",
      trigger: "delivery-scheduled-in-future",
      problem: `Delivery is scheduled for ${scheduled.toISOString().slice(0, 10)}; POD cannot exist yet.`,
      body: actionBody([
        `AWB ${displayAwb(shipment.awb)}: delivery is scheduled for ${scheduled.toISOString().slice(0, 10)} per the pickup thread.`,
        "No POD chase yet. Request POD after the scheduled delivery, or record the outcome if confirmed by phone.",
      ]),
      nextAction: `Wait for the ${scheduled.toISOString().slice(0, 10)} delivery; request POD after.`,
      operatorUpdateOptions: ["Delivered, POD received", "Delivered, POD pending", "Delivery slipped", "Confirmed by phone"],
      postActionExpectedFact: "Delivery completes on schedule and POD follows, or the slip is recorded.",
    });
  }
  if (hasUsableEmail(pickup.email)) {
    const threadId = pickup.threadId || "";
    const threadInfo = threadId
      ? { threadId, messageId: pickup.messageId || pickup.replyMessageId || "", participantsInfo: threadParticipants(shipment, threadId) }
      : { threadId: "", messageId: "", participantsInfo: null };
    const liveMessageId = threadInfo.participantsInfo?.latestMessageId || threadInfo.messageId || "";
    if (recentOutboundAskInThread(threadInfo, now)) {
      return waitingOnReplyAction(shipment, pickup, threadInfo, {
        stage: "waiting-on-pod-reply",
        postActionExpectedFact: "Broker replies with delivered/POD, delivery ETA, or current blocker.",
      });
    }
    const siblings = siblingAwbsFromEvidence(shipment, threadId);
    const { resolved } = recipientBlockForAction(shipment, pickup, threadId, {
      toReason: "Pickup/delivery owner of record for this shipment.",
    });
    const to = resolved.to.length ? joinAddresses(resolved.to) : pickup.email;
    const threadPolicy = threadId || liveMessageId ? "reply_existing" : "start_new";
    const contactName = resolved.to[0]?.name || brokerName;
    const pickupStatus = Boolean(options.pickupStatus);
    return {
      id: `${normalizeAwb(shipment.awb)}-${pickupStatus ? "dispatch-pickup-followup" : "pod-followup"}-${slug(brokerName)}`,
      shipmentId: shipment.id || shipment.awb,
      awb: shipment.awb,
      type: pickupStatus ? "dispatch-pickup-followup" : "pod-followup",
      label: pickupStatus ? `Request pickup status from ${brokerName}` : `Request delivery/POD from ${brokerName}`,
      channel: "gmail",
      execution: "draft_gmail_email",
      autonomy: autonomyForChannel("gmail"),
      safety: safetyForChannel("gmail"),
      betaContract: betaDraftModeContract(),
      status: "suggested",
      priority: pickupStatus ? "high" : shipment.opsState?.priority || "high",
      targetName: contactName,
      targetEmail: to,
      cc: joinAddresses(ccWithExtras(resolved.cc, options.extraCc)),
      recipients: resolved,
      subject: threadPolicy === "reply_existing" && threadInfo.participantsInfo?.latestSubject
        ? (/^re:/i.test(threadInfo.participantsInfo.latestSubject) ? threadInfo.participantsInfo.latestSubject : `Re: ${threadInfo.participantsInfo.latestSubject}`)
        : `${displayAwb(shipment.awb)} - ${pickupStatus ? "pickup status" : "delivery/POD status"}`,
      body: actionBody([
        counterpartyGreeting(contactName),
        "",
        options.ask
          ? `${awbListForBody(shipment, siblings)}: ${askSentence(options.ask)}`
          : pickupStatus
            ? `${awbListForBody(shipment, siblings)}: please confirm pickup timing and send loaded proof, then POD once delivered.`
            : `${awbListForBody(shipment, siblings)}: please confirm delivery status and send POD once delivered.`,
        options.ask && pickupStatus ? "Please also confirm pickup timing and send loaded proof, then POD once delivered." : "",
        "",
        "Thanks,",
      ]),
      reason: pickupStatus
        ? "Broker is awarded but pickup execution proof is still open."
        : "Pickup/out-for-delivery is known, but delivery/POD is still open.",
      nextAction: pickupStatus
        ? "Collect pickup acceptance, loaded proof, or the current blocker."
        : "Collect delivery completion and signed POD.",
      threadPolicy,
      threadId,
      messageId: liveMessageId,
      replyMessageId: liveMessageId,
      conversation: threadPolicy === "reply_existing" ? {
        threadId,
        replyMessageId: liveMessageId,
        source: "pickup-broker-relation",
        summary: "Pickup broker thread from canonical shipment evidence; reply targets the newest message.",
      } : null,
      confidence: resolved.confidence,
      missingProof: "Delivery confirmation or signed POD.",
      recipientNotes: resolved.notes,
      coveredAwbs: siblings.length ? [normalizeAwb(shipment.awb), ...siblings] : undefined,
      timing: {
        stage: "pod-followup",
        trigger: "pickup-or-out-for-delivery-without-pod",
        phase: phaseForShipment(shipment),
      },
      postActionExpectedFact: "Broker replies with delivered/POD, delivery ETA, or current blocker.",
    };
  }
  return basePlatformAction(shipment, "operator-state-check", "Track delivery / collect POD", {
    priority: shipment.opsState?.priority || "high",
    stage: "delivery-pod-check",
    trigger: "pickup-or-out-for-delivery-without-pod-contact",
    problem: `${brokerName} is the pickup/delivery owner, but the planner does not have a safe same-thread POD contact.`,
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)} is picked up/out for delivery.`,
      `Pickup/delivery owner: ${brokerName}.`,
      "Track final delivery and collect POD. If the proof is in Gmail/phone/TMS, record that fact and re-run truth.",
    ]),
    nextAction: `Track delivery completion with ${brokerName}; collect POD or record the delivered/POD-pending fact.`,
    operatorUpdateOptions: ["Delivered, POD received", "Delivered, POD pending", "Still out for delivery", "Delivery blocked"],
    operatorOutcomeOptions: [
      { value: "delivered-pod-received", label: "Delivered, POD received", factTypes: ["delivery", "pod"] },
      { value: "delivered-pod-pending", label: "Delivered, POD pending", factTypes: ["delivery", "pod-pending"] },
      { value: "still-out-for-delivery", label: "Still out for delivery", factTypes: ["delivery"] },
      { value: "delivery-blocked", label: "Delivery blocked", factTypes: ["exception", "delivery"] },
    ],
    postActionExpectedFact: "Delivery owner confirms delivered/POD, delivery still running, or delivery blocked.",
  });
}

function releaseRelationshipMissingAction(shipment) {
  return basePlatformAction(shipment, "operator-state-check", "Find release/DO owner", {
    priority: shipment.opsState?.priority || "high",
    stage: "release-relationship-missing",
    trigger: "release-needed-without-customs-contact",
    problem: "Release/DO is not safe to chase because the customs broker/thread relation is missing.",
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)} needs release/DO proof.`,
      "Find the customs broker or release thread, then draft the follow-up from the correct relationship.",
    ]),
    nextAction: "Find the customs broker/release thread and request release/DO proof.",
    operatorUpdateOptions: ["Customs broker found", "Release/DO received", "Still waiting on release", "Customs hold"],
    postActionExpectedFact: "Customs broker/thread relation is known or release/DO proof is attached.",
  });
}

function customsRelationshipMissingAction(shipment, customs = {}) {
  return basePlatformAction(shipment, "source-backfill", "Find customs broker source", {
    priority: shipment.opsState?.priority || "high",
    stage: "customs-source-backfill",
    trigger: "release-needed-without-customs-contact",
    transport: "source-backfill",
    autonomyLabel: "Save customs broker source",
    problem: "Release/customs work needs action, but the customs broker email/thread relation is missing.",
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)} needs customs/release source repair before a release chase is safe.`,
      customs.name ? `Known broker/name: ${customs.name}.` : "No reliable customs broker name is linked.",
      "Find the customs broker email or release thread, attach it to shipment truth, then re-run action planning.",
    ]),
    nextAction: "Find and save the customs broker email/release thread before chasing release/DO.",
    operatorUpdateOptions: ["Customs broker found", "Release thread found", "Release/DO received", "Customs hold only"],
    postActionExpectedFact: "Customs broker email/thread relation is known, or release/DO proof is attached.",
  });
}

function customsFollowupAction(shipment, customs = {}, options = {}) {
  const awb = displayAwb(shipment.awb);
  const brokerName = customs.name || "customs broker";
  const nextAction = options.ask || askForIntent("customs", nextActionForShipment(shipment),
    "confirm the current customs/release status and the next required step");
  const threadInfo = options.forceNewConversation
    ? { threadId: "", messageId: "", participantsInfo: null }
    : options.threadInfo || threadForAudience(shipment, "customs", { email: customs.email, name: customs.name });
  if (recentOutboundAskInThread(threadInfo, plannerNow(options.now))) {
    return waitingOnReplyAction(shipment, customs, threadInfo, {
      stage: "waiting-on-customs-reply",
      postActionExpectedFact: "Customs broker replies with release, hold, rejection, or the next required source document/action.",
    });
  }
  const siblings = siblingAwbsFromEvidence(shipment, threadInfo.threadId);
  const { resolved } = recipientBlockForAction(shipment, customs, threadInfo.threadId, {
    toReason: "Customs broker of record for this shipment's release.",
  });
  const to = resolved.to.length ? joinAddresses(resolved.to) : customs.email;
  if (!hasUsableEmail(to)) {
    return basePlatformAction(shipment, "operator-state-check", `Confirm recipient: ${brokerName}`, {
      priority: shipment.opsState?.priority || "high",
      stage: "confirm-customs-recipient",
      trigger: "customs-directive-without-confident-recipient",
      problem: `The customs/release ask is clear, but no confident address for ${brokerName} exists in stored evidence.`,
      body: actionBody([
        `AWB ${displayAwb(shipment.awb)}: ${askSentence(nextAction)}`,
        `Confirm the right ${brokerName} contact before this becomes a draft — do not send to a guessed address.`,
      ]),
      nextAction: `Confirm ${brokerName}'s address, then draft the release follow-up.`,
      operatorUpdateOptions: ["Recipient confirmed", "Different broker owns this", "Release already on file"],
      postActionExpectedFact: "Customs contact is confirmed and the follow-up draft becomes safe to send.",
    });
  }
  const threadPolicy = threadInfo.threadId ? "reply_existing" : "start_new";
  const contactName = resolved.to[0]?.name || brokerName;
  const threadSubject = threadInfo.participantsInfo?.latestSubject || "";
  return {
    id: `${normalizeAwb(shipment.awb)}-customs-followup-${slug(brokerName || customs.email || "customs")}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: "customs-followup",
    label: `Follow up with ${brokerName}`,
    channel: "gmail",
    execution: "draft_gmail_email",
    autonomy: autonomyForChannel("gmail"),
    safety: safetyForChannel("gmail"),
    betaContract: betaDraftModeContract(),
    status: "suggested",
    priority: shipment.opsState?.priority || "high",
    targetName: contactName,
    targetEmail: to,
    cc: joinAddresses(ccWithExtras(resolved.cc, options.extraCc)),
    recipients: resolved,
    subject: threadPolicy === "reply_existing" && threadSubject
      ? (/^re:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`)
      : `${awb} - customs / release status`,
    body: actionBody([
      counterpartyGreeting(contactName),
      "",
      `${awbListForBody(shipment, siblings)}: ${askSentence(nextAction)}`,
      "",
      "Thanks,",
    ]),
    reason: options.alternative ? `${nextAction} (alternative not sent: ${options.alternative})` : nextAction,
    nextAction,
    threadPolicy,
    threadId: threadInfo.threadId || "",
    messageId: threadInfo.messageId || "",
    replyMessageId: threadPolicy === "reply_existing" ? threadInfo.messageId || "" : "",
    conversation: threadPolicy === "reply_existing" ? {
      threadId: threadInfo.threadId,
      replyMessageId: threadInfo.messageId || "",
      source: "customs-thread-from-evidence",
      summary: "Live customs/release thread selected from shipment evidence.",
    } : null,
    confidence: resolved.confidence,
    missingProof: "Customs release/DO confirmation or the concrete blocking step.",
    recipientNotes: resolved.notes,
    coveredAwbs: siblings.length ? [normalizeAwb(shipment.awb), ...siblings] : undefined,
    timing: {
      stage: "customs-followup",
      trigger: "canonical-customs-action",
      phase: phaseForShipment(shipment),
    },
    postActionExpectedFact: "Customs broker replies with release, hold, rejection, or the next required source document/action.",
  };
}

function canonicalGapAction(shipment, reason, relations = {}) {
  const actionTextValue = reason || nextActionForShipment(shipment) || "Review shipment state and decide the next safe move.";
  const phase = phaseForShipment(shipment);
  if (["pickup-blocked", "loading-blocked", "delivery-blocked"].includes(phase)) {
    return platformAlertAction(shipment, actionTextValue, actionTextValue, {
      priority: "critical",
      stage: "canonical-blocker-alert",
      station: relations.station || stationRelationForShipment(shipment),
      pickup: relations.pickup || pickupRelationForShipment(shipment),
      customs: relations.customs || customsRelationForShipment(shipment),
      operatorUpdateOptions: ["Blocker resolved", "Station called", "Pickup broker called", "Delivery recovery started"],
      postActionExpectedFact: "The pickup/loading/delivery blocker is resolved or explicitly escalated in shipment truth.",
    });
  }
  return basePlatformAction(shipment, "operator-state-check", "Decide next action from truth packet", {
    priority: shipment.opsState?.priority === "normal" ? "high" : shipment.opsState?.priority || "high",
    stage: "canonical-action-gap",
    trigger: "canonical-next-action-without-action-packet",
    problem: actionTextValue || `Canonical state ${phaseForShipment(shipment) || "open"} has no safe executable action.`,
    body: actionBody([
      `AWB ${displayAwb(shipment.awb)}: ${actionTextValue}.`,
      "The planner could not prove the exact owner/thread needed for a one-click action.",
      "Record the real owner, thread, or outcome, then re-run the planner.",
    ]),
    nextAction: actionTextValue,
    operatorUpdateOptions: ["Owner/thread found", "Shipment moved", "Waiting only", "Contradiction found"],
    postActionExpectedFact: "Missing action owner/thread/outcome is recorded, or the shipment is marked as an explicit wait state.",
  });
}

function noActionPhase(phase) {
  return ["delivered", "completed", "pre-arrival", "in-transit"].includes(phase);
}

function nextActionLooksActionable(shipment) {
  const text = nextActionForShipment(shipment);
  // "No action; POD is in memory." contains actionable-looking words but IS the
  // no-action statement — completed rows must never regenerate chases from it.
  if (/^\s*no action\b/i.test(text)) return false;
  return /\b(?:find|search|ask|call|confirm|release|dispatch|blocked|missing|unknown|pickup|pod|station|broker|customs|send|draft|collect|follow up|follow-up)\b/i.test(
    text,
  );
}

function awbCopyOnlyRequestText(value = "") {
  const text = String(value || "");
  return /\b(?:copy of the awb|awb copy|air waybill copy|airway bill copy)\b/i.test(text) &&
    !/\b(?:delivery order|d\/?o|remaining pickup docs|remaining necessary docs|release package|release packet)\b/i.test(text);
}

function historicalResolvedExceptionText(value = "") {
  const text = String(value || "");
  return /\b(?:resolved history|old\b[^.;\n]{0,120}\b(?:exception|blocker)|superseded|retired|no longer (?:active|current|blocking))\b/i.test(text);
}

function directedOutreachFromNextAction(shipment = {}) {
  const nextAction = nextActionForShipment(shipment);
  if (!/\b(?:reply(?:[-\s]all)?|respond|new draft|draft reply|draft (?:an? )?email|email(?:\s+the)?|verify|chase|follow up(?:\s+with)?)\b/i.test(nextAction)) return null;
  if (/^\s*no action\b/i.test(nextAction)) return null;
  const addresses = parseAddressList(nextAction).filter((entry) => hasUsableEmail(entry.email));
  const personMatch = nextAction.match(/\b(?:reply(?:[-\s]all)?|respond|draft reply|chase|follow up with)\s+(?:to\s+|in\s+|on\s+|with\s+)?(?:the\s+)?([A-Z][A-Za-z]{2,})(?:['’]s)?\b/i);
  // Full person names named by the directive ("Draft reply to Avery Blake /
  // Michael Marcovecchio (WWL brokerage): ..."). Matched against thread rosters,
  // never used to compose addresses.
  const personsSegment = nextAction.match(/\b(?:reply(?:[-\s]all)?\s+to|respond\s+to|draft reply to|chase|follow up with)\s+([^:(]{3,90})/i);
  const persons = personsSegment
    ? personsSegment[1].split(/\s*(?:\/|,|\band\b)\s*/)
        .map((name) => name.trim().replace(/['’]s$/, ""))
        .filter((name) => /^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?$/.test(name))
    : [];
  // Secondary person mentions: "give Sam the requested ETA" names the live
  // counterparty even when the directive verb targets a thread, not a person.
  for (const match of nextAction.matchAll(/\b(?:give|copy|loop in|send)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b/g)) {
    if (!persons.includes(match[1])) persons.push(match[1]);
  }
  // Explicit cc instructions ("Reply to Taylor Morgan (UPS, cc Riley Jordan): ...")
  // name people who must see the request even if they are not on the reply thread.
  const ccPersons = [];
  for (const match of nextAction.matchAll(/\bcc:?\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)\b/g)) {
    if (!ccPersons.includes(match[1])) ccPersons.push(match[1]);
  }
  const colonIndex = nextAction.indexOf(":");
  // Directives sometimes carry a decision fork ("accept the storage day or
  // rebook off the holiday"). A strong operator sends one decision, not the
  // fork — keep the primary clause and note the alternative in the reason.
  let substance = colonIndex > -1 ? nextAction.slice(colonIndex + 1).trim() : nextAction;
  const orSplit = substance.split(/,?\s+or\s+(?=(?:re[a-z]+|cancel|switch|escalate|hold)\b)/i);
  const alternative = orSplit.length > 1 ? orSplit.slice(1).join(" or ").trim() : "";
  substance = orSplit[0].trim();
  return {
    addresses,
    person: personMatch ? personMatch[1] : "",
    persons,
    ccPersons,
    substance,
    alternative,
    raw: nextAction,
  };
}

// Family classification shared by the directive scorer and the directed builder.
const DIRECTIVE_CUSTOMS_RE = /\b(?:customs|release|clearance|inbond|in[-\s]?bond|entry|d\/?o\b|delivery order|abi|cbp|duty|storage)\b/i;
const DIRECTIVE_DISPATCH_RE = /\b(?:dispatch|pickup|pick up|pod\b|loaded|driver|rides?|delivery)\b/i;
const DIRECTIVE_STATION_RE = /\b(?:on[-\s]?hand|arrival notice|availability|piece count|station|import desk|handler)\b/i;
const ROW_DISPATCHY_RE = /\b(?:broker[-_\s]?(?:awarded|confirmed|alerted)|pickup[-_\s]?quote|dispatch)\b/i;
const ROW_STATIONY_RE = /\b(?:at origin|on[-\s]?hand|arrival|station|availability|forward air|handler|eta)\b/i;

// A directive's family comes from its ASK, not from every noun in it. "Confirm
// on-hand …; Release/DO already banked" is a station ask with customs context:
// the first clause carries the move, "already banked/paid/on file" clauses are
// supersession context, and "before clearance planning" marks a FUTURE stage.
// Family regexes must only see the ask text.
function directiveAskText(raw) {
  let text = String(raw || "").split(";")[0];
  text = text.replace(
    /\b(?:release|d\/?o|delivery order|customs|clearance|entry|fees?|duty|storage)\b[^;.,]{0,40}\b(?:already|banked|paid|done|cleared|on file|in hand)\b[^;.,]*/gi,
    " ",
  );
  text = text.replace(/\bbefore\b[^;.]*/gi, " ");
  return text;
}

// Score threads against the directive's named person/addresses and its substance
// keywords. The directive's own family penalizes wrong-family rows the same way
// the pickup scorer penalizes customs rows — a station ask must not land on the
// broker-award thread just because the same person is on both.
function threadForDirective(shipment = {}, directive = {}) {
  const sourceRows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    ...(shipment.gmailProofEvents || []),
    // Contact-block evidence arrays carry mailbox-verified thread pointers that
    // sometimes exist nowhere else (manual-truth referee corrections).
    ...(shipment.contacts?.customs?.evidence || []),
    ...(shipment.contacts?.station?.evidence || []),
    ...(shipment.customsBroker?.evidence || []),
  ];
  // "on the pre-alert thread" — the directive names WHICH thread it means.
  // All-digit descriptors ("the 353 thread") are AWB shorthand and match every
  // subject carrying that AWB — useless as a discriminator, so skip them.
  const descriptorMatch = String(directive.raw || "").match(/\b(?:on|in)\s+(?:the\s+)?([\w /-]{3,30}?)\s+thread\b/i);
  const descriptorRaw = descriptorMatch ? descriptorMatch[1].trim().toLowerCase() : "";
  const descriptor = /^\d+$/.test(descriptorRaw.replace(/\s/g, "")) ? "" : descriptorRaw;
  // "Drew's 10:47Z correction" — an explicit time anchor pins the exact message.
  const timeAnchor = String(directive.raw || "").match(/\b(\d{1,2}):(\d{2})Z\b/);
  const anchorNeedle = timeAnchor ? `T${timeAnchor[1].padStart(2, "0")}:${timeAnchor[2]}` : "";
  const rawStation = DIRECTIVE_STATION_RE.test(directive.raw || "");
  const rawCustoms = DIRECTIVE_CUSTOMS_RE.test(directive.raw || "") && !rawStation;
  const rawDispatch = DIRECTIVE_DISPATCH_RE.test(directive.raw || "") && !rawCustoms && !rawStation;
  const needles = [
    ...directive.addresses.map((entry) => entry.email),
    ...(directive.person ? [directive.person] : []),
    // Named people discriminate threads: "Avery Blake" finds the roster
    // entry <contact-021@demo-freight.example> via her last name in the to/cc string.
    ...(directive.persons || []).flatMap((name) => String(name).split(/\s+/).slice(-1)),
  ].map((value) => String(value).toLowerCase()).filter((value) => value.length >= 4);
  const keywords = String(directive.substance || "")
    .toLowerCase()
    .match(/[a-z][a-z0-9-]{4,}/g) || [];
  // Freight prose leans on 3-letter tokens (PHL, ETA, ACE, AMS) — keep the
  // acronyms the substance uses even though they fail the length filter.
  const acronyms = (String(directive.substance || "").match(/\b[A-Z]{3,4}\b/g) || []).map((token) => token.toLowerCase());
  const informative = [...new Set([...keywords, ...acronyms])].slice(0, 10);
  const scored = sourceRows
    .filter((row) => row?.threadId)
    .map((row) => {
      const identity = `${row.broker || ""} ${row.contactEmail || ""} ${row.to || ""} ${row.cc || ""} ${row.from || ""}`.toLowerCase();
      // Manual-truth rows carry operator NARRATIVE in `evidence` (the whole
      // shipment story) — it describes other threads and must not make this
      // row's thread look like the counterparty conversation. Their summary is
      // the actual message paraphrase; score only that.
      const narrativeRow = /manual/i.test(String(row.type || ""));
      const text = `${row.type || ""} ${row.label || ""} ${row.summary || ""} ${narrativeRow ? "" : row.evidence || ""} ${row.subject || ""}`.toLowerCase();
      let score = 0;
      for (const needle of needles) {
        if (identity.includes(needle)) score += 3;
        // Manual-truth/contact-evidence rows carry no from/to headers; the
        // counterparty often appears only in the note text.
        else if (text.includes(needle)) score += 2;
      }
      let keywordHits = 0;
      for (const keyword of informative) if (text.includes(keyword)) keywordHits++;
      score += Math.min(keywordHits, 3);
      // Sibling shipments share threads; a row anchored to THIS AWB (row.awb or
      // subject) beats a group thread, and a row whose subject names only a
      // different sibling must not win the directive.
      const selfAwb = normalizeAwb(shipment.awb);
      const subjectDigits = String(row.subject || "").replace(/\D/g, "");
      if (normalizeAwb(row.awb) === selfAwb || (selfAwb && subjectDigits.includes(selfAwb))) score += 2;
      else if (selfAwb && subjectDigits.length >= 11) score -= 2;
      // The directive names WHICH thread it means ("on the pre-alert thread") —
      // that outranks recency and generic keyword overlap.
      if (descriptor && `${row.subject || ""} ${text}`.toLowerCase().replace(/[^a-z0-9 ]/g, " ").includes(descriptor.replace(/[^a-z0-9 ]/g, " "))) {
        score += 4;
      }
      if (anchorNeedle && String(row.at || "").includes(anchorNeedle)) score += 4;
      // Wrong-family rows must not win the directive's thread.
      const rowTypeText = `${row.type || ""} ${text}`;
      if (rawStation) {
        if (ROW_DISPATCHY_RE.test(rowTypeText)) score -= 3;
        if (DIRECTIVE_CUSTOMS_RE.test(rowTypeText) && !ROW_STATIONY_RE.test(rowTypeText)) score -= 3;
      } else if (rawCustoms) {
        if (ROW_DISPATCHY_RE.test(rowTypeText)) score -= 3;
        if (ROW_STATIONY_RE.test(rowTypeText) && !DIRECTIVE_CUSTOMS_RE.test(rowTypeText)) score -= 3;
      } else if (rawDispatch) {
        if (DIRECTIVE_CUSTOMS_RE.test(rowTypeText) && !ROW_DISPATCHY_RE.test(rowTypeText) && !DIRECTIVE_DISPATCH_RE.test(rowTypeText)) score -= 3;
      }
      return { row, score, at: Date.parse(row.at || row.date || "") || 0 };
    })
    // Weak single-keyword matches must not hijack the directive onto a random
    // thread: demand an identity hit or a multi-keyword match.
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score || b.at - a.at);
  const best = scored[0]?.row;
  if (!best) return null;
  const participantsInfo = threadParticipants(shipment, best.threadId || "");
  return {
    threadId: best.threadId || "",
    messageId: participantsInfo.latestMessageId || best.messageId || "",
    at: participantsInfo.latestAt || 0,
    participantsInfo,
    familyRow: best,
    scoredRows: scored.slice(0, 6).map((item) => ({ threadId: item.row.threadId, score: item.score, at: item.row.at, type: item.row.type })),
  };
}

// A directive-named person whose address lives only in packet prose ("Taylor Morgan
// (UPS...); contact-050@demo-freight.example actively re-submitting", shipper contact blocks) —
// extract the verbatim address whose local-part matches the name conventions.
function personAddressFromShipmentText(shipment = {}, names = []) {
  if (!names.length) return null;
  const texts = [
    shipment.contacts?.customs?.brokerStatus,
    shipment.contacts?.customs?.status,
    shipment.contacts?.customs?.nextAction,
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.status,
    shipment.customsBroker?.nextAction,
    shipment.currentState,
    shipment.opsState?.summary,
    `${shipment.shipper?.contactName || ""} <${shipment.shipper?.email || ""}>`,
    ...[
      ...(shipment.emailValidation?.events || []),
      ...(shipment.factLedger || []),
      ...(shipment.facts || []),
      ...(shipment.gmailProofEvents || []),
      ...(shipment.contacts?.customs?.evidence || []),
      ...(shipment.customsBroker?.evidence || []),
    ].map((row) => [row.summary, row.note, row.evidence, row.claim].filter(Boolean).join(" ")),
  ].filter(Boolean);
  for (const name of names) {
    const nameRe = new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    for (const text of texts) {
      if (!nameRe.test(text)) continue;
      const address = parseAddressList(text).find((entry) =>
        hasUsableEmail(entry.email) && participantMatchesName({ email: entry.email, name: entry.name }, name));
      if (address) return { email: address.email, name: address.name || name };
    }
  }
  return null;
}

function directedReplyAction(shipment, directive, relations = {}) {
  // "New draft to United IAH imports (…): …" — truth explicitly orders a fresh
  // conversation. Anchoring it to an old thread reads as replying to a question
  // nobody asked there.
  const wantsNewConversation = /\bnew\s+(?:draft|email|thread|conversation)\b/i.test(String(directive.raw || ""));
  const threadInfo = threadForDirective(shipment, directive);
  if (!threadInfo && !directive.addresses.length) return null;
  const rowText = threadInfo
    ? `${threadInfo.familyRow.type || ""} ${threadInfo.familyRow.summary || ""} ${threadInfo.familyRow.subject || ""} ${threadInfo.familyRow.evidence || ""}`
    : directive.raw;
  // The directive's own words outrank the matched row: "Chase Rapid on the 353
  // thread: ... rides today's pickup" is dispatch work even when the best-scoring
  // row happens to be the customs 1C paste on that thread.
  const askText = directiveAskText(directive.raw);
  const customsFromRaw = DIRECTIVE_CUSTOMS_RE.test(askText);
  const dispatchFromRaw = DIRECTIVE_DISPATCH_RE.test(askText);
  const stationFromRaw = DIRECTIVE_STATION_RE.test(askText);
  const rowAskText = directiveAskText(rowText);
  const customsFamily = (dispatchFromRaw || stationFromRaw) && !customsFromRaw
    ? false
    : (customsFromRaw || DIRECTIVE_CUSTOMS_RE.test(rowAskText));
  const dispatchFamily = !customsFamily && !stationFromRaw && (dispatchFromRaw || DIRECTIVE_DISPATCH_RE.test(rowAskText));
  // Precedence for the directed recipient: explicit address in the directive >
  // the directive's named people found in the live thread roster > the stored
  // relation contact. Roster hits are real message evidence, never guesses.
  const roster = threadInfo?.participantsInfo?.participants || [];
  const namedParticipants = matchParticipantsToNames(roster, [
    ...(directive.persons || []),
    ...(directive.person && !(directive.persons || []).includes(directive.person) ? [directive.person] : []),
  ]);
  // Only explicit directive addresses and full-name roster matches may override
  // the stored relation. A loose single-token hit ("the UPS group" matching any
  // @ups.com address) is a greeting hint, not a recipient decision.
  // Directive-named cc people resolve against the reply-thread roster first, then
  // every mailbox-verified participant on the shipment (the arrival-notice issuer
  // often lives on a different thread). Unresolvable names stay off the cc line —
  // never compose an address.
  const ccResolved = (directive.ccPersons || []).length
    ? matchParticipantsToNames(
        [...roster, ...allShipmentParticipants(shipment)],
        directive.ccPersons,
      ).filter((entry) => !entry.operator)
    : [];
  const personNeedle = String(directive.person || "").toLowerCase();
  const personParticipant = namedParticipants[0] ||
    (personNeedle.length >= 3
      ? roster.find((p) => !p.operator && (p.name.toLowerCase().includes(personNeedle) || p.email.includes(personNeedle)))
      : null);
  const proseAddress = namedParticipants.length
    ? null
    : personAddressFromShipmentText(shipment, [
        ...(directive.persons || []),
        ...(directive.person ? [directive.person] : []),
      ]);
  const directTo = [
    ...directive.addresses.map((entry) => entry.email),
    ...namedParticipants.map((entry) => entry.email),
    ...(proseAddress ? [proseAddress.email] : []),
  ].filter(Boolean).join(", ");
  if (customsFamily) {
    const customs = relations.customs || customsRelationForShipment(shipment);
    return customsFollowupAction(shipment, {
      ...customs,
      email: directTo || customs.email,
      name: personParticipant?.name || directive.person || customs.name || "team",
    }, {
      threadInfo,
      ask: askForIntent(
        "customs",
        directive.substance,
        "confirm the current customs/release status and the next required step",
      ),
      alternative: directive.alternative,
      forceNewConversation: wantsNewConversation,
      extraCc: ccResolved,
    });
  }
  if (dispatchFamily && relations.pickup && hasUsableEmail(directTo || relations.pickup.email)) {
    // Packet invariant: a POD request requires pickup-execution proof; before
    // that, the honest ask is pickup timing + loaded proof (pickupStatus).
    const pickupProven = gateProven(gateStatusFor(shipment, "pickup")) ||
      ["out-for-delivery", "picked-up", "pod-needed", "delivered-pod-pending"].includes(phaseForShipment(shipment));
    return podOrDeliveryProofAction(shipment, {
      ...relations.pickup,
      email: directTo || relations.pickup.email,
      threadId: threadInfo?.threadId || relations.pickup.threadId,
      messageId: threadInfo?.messageId || relations.pickup.messageId,
    }, {
      pickupStatus: !pickupProven,
      // An empty fallback lets podOrDeliveryProofAction choose its own concise
      // pickup-vs-POD default without adding a duplicate second ask.
      ask: askForIntent("dispatch", directive.substance, ""),
      extraCc: ccResolved,
    });
  }
  const station = relations.station || stationRelationForShipment(shipment);
  if (!hasUsableEmail(directTo || station.email) && !threadInfo) return null;
  const stationIntent = /\b(?:awb copy|air ?waybill|handoff|wfs|transfer)\b/i.test(directive.substance)
    ? "awbcopy"
    : "arrival";
  return stationConfirmationAction(shipment, {
    ...station,
    email: directTo || station.email,
    name: personParticipant?.name || directive.person || station.name || "team",
  }, {
    threadInfo,
    ask: askForIntent(
      stationIntent,
      directive.substance,
      stationIntent === "awbcopy"
        ? "confirm the AWB copy / handoff status and whether pickup can proceed"
        : "confirm arrival, on-hand availability, and piece count",
    ),
    alternative: directive.alternative,
    stage: "directed-reply",
    trigger: "canonical-next-action-directive",
    askOnHand: false,
    forceNewConversation: wantsNewConversation,
    extraCc: ccResolved,
  });
}

function selectedPrimaryAction(shipment, usableActions, relations) {
  const phase = phaseForShipment(shipment);
  const nextAction = nextActionForShipment(shipment);
  const fullText = `${shipmentText(shipment)} ${nextAction}`;
  const station = relations.station;
  const pickup = relations.pickup;
  const customs = relations.customs;
  const customsContest = (shipment.truthPacket?.contradictions || [])
    .find((row) => row?.requiresAction === true &&
      String(row?.id || "").endsWith(":customs-contested-onsite"));
  const postPickupPhases = ["out-for-delivery", "picked-up", "pod-needed", "delivered-pod-pending"];
  const prePickupOrBlockedPhases = ["exception", "pre-arrival", "in-transit", "arrival-incomplete", "release-needed", "customs-hold", "fees-needed", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "delivery-blocked"];
  const historicalResolvedException = historicalResolvedExceptionText(fullText);
  // Recovery must be a LIVE signal: current phase, next action, summary, or an
  // open exception — not a June event summary about a long-resolved deleted
  // flight buried in the history (which hijacked healthy shipments into the
  // recovery branch before any directive could run).
  const liveExceptionText = (shipment.opsState?.exceptions || [])
    .map((item) => `${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.impact || ""} ${item.nextAction || ""}`)
    .join(" ");
  const terminalRecovery = /\b(?:wrong-consignee|wrong customer|delivery-blocked|pickup-blocked|loading-blocked|cargo not found|not locate|cannot locate|flight deleted|connection transfer|transfer exception)\b/i.test(
    `${phase} ${nextAction} ${shipment.currentState || ""} ${shipment.opsState?.summary || ""} ${liveExceptionText}`,
  ) && !historicalResolvedException;
  // The packet's open, source-backed contest outranks stale terminal/no-action
  // projections. A genuinely resolved contest no longer carries requiresAction,
  // so normal terminal rows still hit the no-chase guard below.
  if (customsContest) {
    return {
      ...platformAlertAction(
        shipment,
        customsContest.operatorMessage || customsContest.claim || "Customs release is contested while the driver is onsite.",
        CUSTOMS_CONTEST_ACTION_LABEL,
        {
          priority: "high",
          stage: "customs-contested-onsite",
          trigger: "customs-contested-onsite",
          operatorUpdateOptions: [
            "Release/DO confirmed with airline",
            "Airline says cargo is not released",
            "Driver left / pickup paused",
            "New release evidence attached",
          ],
          evidence: [customsContest.claim, customsContest.operatorMessage],
          postActionExpectedFact: "A Gmail or operator source fact records the airline's release/DO confirmation or confirms that the cargo is still not released.",
        },
      ),
      sourceFactIds: unique(customsContest.sourceFactIds || []),
    };
  }
  if (terminalRecovery) {
    const recoveryNextAction = terminalRecoveryActionForShipment(shipment);
    // Canonical truth often prescribes the exact recovery outreach ("New draft
    // to the United IAH imports contacts: confirm on hand..."). That directive
    // IS the recovery action — a generic operator ping would be weaker.
    const recoveryDirective = directedOutreachFromNextAction(shipment);
    const directedRecovery = recoveryDirective ? directedReplyAction(shipment, recoveryDirective, relations) : null;
    return findCandidate(usableActions, (action, text) =>
      /operator-ping|operator-state-check|station-confirmation|station-fee-confirmation/i.test(text) &&
        /\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|wrong recipient|misdelivered|delivered by mistake|return timing|normal delivered\/POD closeout|recovery|redelivery)\b/i.test(text)
    ) ||
      directedRecovery ||
      canonicalGapAction(shipment, compact(recoveryNextAction || nextAction || "Resolve the active operational exception.", 180), relations);
  }

  // Terminal shipments never regenerate chases. The queue prunes them today, but
  // the planner itself must refuse — stale completed-row text produced real POD
  // chases on delivered freight (INC-2026-07-02 class).
  if (["delivered", "completed", "closed"].includes(phase) || /^\s*no action\b/i.test(nextAction)) {
    return null;
  }

  // Canonical truth sometimes IS the action: "Reply to <person>'s <message> on
  // <thread>: <substance>". Honor the directive — resolve the thread it names and
  // draft there — instead of degrading to research/state-check actions.
  const directive = directedOutreachFromNextAction(shipment);
  if (directive) {
    const directed = directedReplyAction(shipment, directive, relations);
    if (directed) return directed;
  }

  if (["customs-hold", "release-needed"].includes(phase)) {
    const sourceBackfill = findCandidate(usableActions, (action) => action.type === "source-backfill");
    if (!hasUsableEmail(customs.email)) return sourceBackfill || customsRelationshipMissingAction(shipment, customs);
    return findCandidate(usableActions, (action, text) => /customs-followup|release \/ do|release\/do|customs broker/i.test(text)) ||
      sourceBackfill ||
      customsFollowupAction(shipment, customs);
  }

  if (awbCopyOnlyRequestText(fullText)) {
    return platformAlertAction(
      shipment,
      `${station.name || station.airport || "Station thread"} needs copy of the AWB.`,
      "Reply in the same thread with the AWB/air waybill copy; do not treat this as a customs hold or broader document request.",
      {
        priority: "high",
        stage: "awb-copy-reply-needed",
        station,
        pickup,
        customs,
        operatorUpdateOptions: ["AWB copy sent", "Station says no longer needed", "Thread/contact missing", "Different document requested"],
        postActionExpectedFact: "AWB-copy reply is sent or the station thread confirms the request is resolved.",
      },
    );
  }

  // Station on-hand / AWB-copy asks are PRE-pickup work: once pickup is
  // proven, asking a station whether freight is on hand is nonsense — the
  // honest next move is delivery/POD, handled by later branches.
  const pickupAlreadyProven = gateProven(gateStatusFor(shipment, "pickup")) ||
    ["picked-up", "out-for-delivery", "pod-needed", "delivered-pod-pending", "delivered"].includes(phase);
  if (
    !pickupAlreadyProven && (
      ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "station-confirmation-needed", "arrival-unverified", "arrival-incomplete"].includes(phase) ||
      (!historicalResolvedException && /\b(?:awb copy|air waybill copy|wfs|handoff|ua area|uc360|transfer)\b/i.test(`${nextAction} ${fullText}`))
    )
  ) {
    const stationCandidate = findCandidate(usableActions, (action, text) => /station-confirmation|station-fee-confirmation|pickup-location-reply/i.test(text));
    if (stationCandidate) return stationCandidate;
    if (hasUsableEmail(station.email)) {
      const awbCopyIntent = /\bawb copy|wfs|handoff|transfer/i.test(`${nextAction} ${fullText}`);
      return stationConfirmationAction(shipment, station, {
        label: awbCopyIntent
          ? `Confirm AWB copy / handoff with ${station.name || station.airport || "station"}`
          : `Confirm availability with ${station.name || station.airport || "station"}`,
        ask: askForIntent(awbCopyIntent ? "awbcopy" : "arrival", nextAction,
          awbCopyIntent
            ? "confirm the AWB copy / handoff status and whether pickup can proceed"
            : "confirm on-hand availability and pickup requirements"),
        subjectSuffix: /\bawb copy|wfs|handoff|transfer/i.test(`${nextAction} ${fullText}`)
          ? "AWB copy / handoff status"
          : "availability status",
        stage: "station-status-from-canonical-truth",
        trigger: "canonical-station-or-awb-copy-action",
      });
    }
    if (hasUsablePhone(station.phone)) {
      return callContactAction(shipment, station, nextAction || "confirm on-hand availability and pickup requirements", {
        stage: "station-status-by-phone",
        trigger: "station-email-missing-phone-known",
      });
    }
    return stationContactResearchAction(shipment, station, "Canonical truth needs station confirmation, but no usable station email/phone is known.");
  }

  if (
    ["pre-arrival", "in-transit"].includes(phase) &&
    /\b(?:arrival|availability|available|on[- ]?hand|station|piece count|pieces?|handoff)\b/i.test(`${nextAction} ${fullText}`)
  ) {
    // A record-only directive or a comfortably future ETA means hold, not email:
    // asking a station about freight that has not landed reads as not having read
    // the thread. Explicit draft directives from truth override the hold.
    const eta = parseEtaText(shipment.eta || shipment.liveTracking?.scheduledArrival || shipment.flightDetails?.etaHint || "");
    const etaComfortablyFuture = eta && eta.getTime() - plannerNow().getTime() > 24 * 3600 * 1000;
    // "On 07/06 re-confirm..." — truth itself schedules the ask for a future
    // date. Hold until then instead of chasing early.
    const dateDirective = nextAction.match(/^\s*on\s+(\d{1,2})\/(\d{1,2})\b/i);
    if (dateDirective) {
      const now = plannerNow();
      const due = new Date(now.getFullYear(), Number(dateDirective[1]) - 1, Number(dateDirective[2]));
      if (due.getTime() - now.getTime() > 12 * 3600 * 1000) {
        return basePlatformAction(shipment, "waiting-on-reply", `Hold until ${dateDirective[1]}/${dateDirective[2]}`, {
          priority: shipment.opsState?.priority || "normal",
          stage: "scheduled-ask-hold",
          trigger: "truth-schedules-future-ask",
          problem: `Truth schedules this ask for ${dateDirective[1]}/${dateDirective[2]}; chasing earlier duplicates an answered question.`,
          body: actionBody([
            `AWB ${displayAwb(shipment.awb)}: ${counterpartyAsk(nextAction)}`,
            `Scheduled for ${dateDirective[1]}/${dateDirective[2]} — no chase before then.`,
          ]),
          nextAction,
          operatorUpdateOptions: ["Ask now anyway", "Arrived early", "Checkpoint recorded"],
          postActionExpectedFact: "The scheduled ask fires on its date, or arrival evidence lands earlier.",
        });
      }
    }
    const recordOnly = /^\s*record\b/i.test(nextAction);
    const draftDirective = /\b(?:new draft|draft|email|send|ask|request|confirm with|follow up)\b/i.test(nextAction);
    if (recordOnly || (etaComfortablyFuture && !draftDirective)) {
      return basePlatformAction(shipment, "waiting-on-reply", recordOnly ? "Record checkpoint — no chase" : `Hold until ETA ${eta.toISOString().slice(0, 10)}`, {
        priority: shipment.opsState?.priority || "normal",
        stage: recordOnly ? "record-checkpoint-hold" : "pre-arrival-eta-hold",
        trigger: "pre-arrival-nothing-to-chase",
        problem: recordOnly
          ? "Truth directs recording a checkpoint; no outreach is needed."
          : `ETA ${eta.toISOString().slice(0, 10)} is still ahead; there is nothing to ask the station yet.`,
        body: actionBody([
          `AWB ${displayAwb(shipment.awb)}: ${counterpartyAsk(nextAction) || "no outreach needed before arrival."}`,
          recordOnly ? "Record the checkpoint so truth stays current." : "Re-check at the arrival window; ask for on-hand proof then.",
        ]),
        nextAction: nextAction || "Hold until the arrival window.",
        operatorUpdateOptions: ["Checkpoint recorded", "Arrived early", "Chase now anyway"],
        postActionExpectedFact: "Arrival evidence lands at the ETA window, or the operator records an early checkpoint.",
      });
    }
    const stationCandidate = findCandidate(usableActions, (action, text) => /station-confirmation|station-fee-confirmation/i.test(text));
    if (stationCandidate) return stationCandidate;
    if (hasUsableEmail(station.email)) {
      return stationConfirmationAction(shipment, station, {
        label: `Confirm arrival / availability with ${station.name || station.airport || "station"}`,
        ask: askForIntent("arrival", nextAction, "confirm arrival, on-hand availability, and piece count"),
        subjectSuffix: "arrival / availability status",
        stage: "station-status-from-canonical-truth",
        trigger: "canonical-prearrival-station-status-action",
      });
    }
    if (hasUsablePhone(station.phone)) {
      return callContactAction(shipment, station, askForIntent("arrival", nextAction, "confirm arrival, on-hand availability, and piece count"), {
        stage: "station-arrival-by-phone",
        trigger: "station-email-missing-phone-known",
      });
    }
    return stationContactResearchAction(shipment, station, "Canonical truth needs station arrival/availability confirmation, but no usable station email/phone is known.");
  }

  // POD/delivery follow-ups require pickup-execution PROOF. Broker/dispatch
  // acknowledgment is not pickup execution, and the word "POD" inside a
  // "confirm pickup ... collect POD after pickup" narrative is not either
  // (INC-2026-07-04-PACKET-SIBLING-VERDICT-CONTRADICTION).
  const pickupExecutionProven = postPickupPhases.includes(phase) ||
    /\b(?:done|true|confirmed|picked)\b/i.test(String(shipment.opsState?.gates?.pickup?.status || "")) ||
    (Array.isArray(shipment.evidencePacket?.sourceFacts) && shipment.evidencePacket.sourceFacts.some((fact) =>
      /\b(?:pickup[-_ ]?confirmed|picked[-_ ]?up|loaded|out[-_ ]?for[-_ ]?delivery|departed[-_ ]?with[-_ ]?cargo)\b/i.test(String(fact.type || "")) ||
      (String(fact.type || "") === "canonical-pickup" && /\bdone\b/i.test(String(fact.claim || "")))));
  // A scheduled pickup awaits execution proof: the right ask is "confirm the
  // pickup happened / collect loaded proof", never a delivery/POD request.
  const pickupGateSaysScheduled = /\bscheduled\b/i.test(
    `${shipment.opsState?.gates?.pickup?.status || ""} ${shipment.opsState?.gates?.pickup?.evidence || ""}`,
  );
  if (phase === "pickup-scheduled" && !pickupExecutionProven && pickupGateSaysScheduled) {
    return findCandidate(usableActions, (action, text) => /pickup-execution|operator-state-check/i.test(text)) ||
      pickupExecutionAction(shipment, pickup);
  }
  if (postPickupPhases.includes(phase) || (pickupExecutionProven && !prePickupOrBlockedPhases.includes(phase) && /\b(?:track delivery|collect pod|pod|proof of delivery)\b/i.test(nextAction))) {
    return findCandidate(usableActions, (action, text) => /pod-followup|delivery status|request pod|proof of delivery/i.test(text)) ||
      podOrDeliveryProofAction(shipment, pickup);
  }
  // POD-flavored narrative without pickup proof: the honest primary is to
  // confirm the pickup actually happened, not to request delivery proof.
  if (!prePickupOrBlockedPhases.includes(phase) && !pickupExecutionProven && /\b(?:track delivery|collect pod|pod|proof of delivery)\b/i.test(nextAction)) {
    return findCandidate(usableActions, (action, text) => /pickup-execution|operator-state-check/i.test(text)) ||
      pickupExecutionAction(shipment, pickup);
  }

  if (phase === "not-ready") {
    const existingOperatorCheck = findCandidate(usableActions, (action, text) => /operator-state-check|operator-ping|station-confirmation|station-fee-confirmation/i.test(text));
    return existingOperatorCheck || notReadyRelationshipCheckAction(shipment);
  }

  if (["ready-for-pickup", "dispatch-ready", "approval-needed", "broker-awarded", "pickup-scheduled"].includes(phase)) {
    const pickupOwnerAction = findCandidate(usableActions, (action, text) => /dispatch-pickup-followup|broker-status-followup|tms-broker-award|broker-award/i.test(text));
    if (pickupOwnerAction) return pickupOwnerAction;
    // Once a broker is awarded/confirmed the quote race is over — a lingering
    // quote row must not resurrect an award flow next to the live dispatch.
    // "confirmed" alone is too generic (arrival-confirmed would match) — only
    // award/dispatch-specific states end the quote race.
    const alreadyAwarded = /\b(?:awarded|freight-awarded|pickup-owner-confirmed|broker-confirmed|dispatched|alert-sent|pickup-alert-sent|broker-alerted)\b/i.test(
      `${shipment.freightBroker?.status || ""} ${shipment.freightBroker?.brokerStatus || ""} ${gateStatusFor(shipment, "dispatch")}`,
    );
    if (!alreadyAwarded) {
      const quoteDecision = pickupQuoteDecisionAction(shipment);
      if (quoteDecision) return quoteDecision;
    }
    if (pickup.relationStatus !== "known") return pickupOwnerMissingAction(shipment);
    // Awarded broker gone quiet: the operator-grade move is an email in the
    // dispatch thread asking for pickup timing + loaded proof (Registry: "Request
    // pickup status"), not an internal state-check.
    if (hasUsableEmail(pickup.email)) {
      const followup = podOrDeliveryProofAction(shipment, pickup, { pickupStatus: true });
      if (followup) return followup;
    }
    return pickupExecutionAction(shipment, pickup);
  }

  if (/\b(?:release|customs|d\/?o|delivery order)\b/i.test(nextAction)) {
    const sourceBackfill = findCandidate(usableActions, (action) => action.type === "source-backfill");
    if (!hasUsableEmail(customs.email)) return sourceBackfill || customsRelationshipMissingAction(shipment, customs);
    return findCandidate(usableActions, (action, text) => /customs-followup|release \/ do|release\/do|customs broker/i.test(text)) ||
      sourceBackfill ||
      customsFollowupAction(shipment, customs);
  }

  if (["fees-needed", "ground-fees-needed", "storage-risk"].includes(phase)) {
    const feeAction = findCandidate(usableActions, (action, text) => /station-fee-confirmation|storage-risk|ground fees|cargosprint|payment/i.test(text));
    if (feeAction) return feeAction;
    if (hasUsableEmail(station.email)) {
      return stationConfirmationAction(shipment, station, {
        label: `Confirm fees / availability with ${station.name || station.airport || "station"}`,
        ask: askForIntent("fees", nextAction, "confirm ground fees, last free day, and pickup availability"),
        subjectSuffix: "fees / availability status",
        stage: "station-fee-status-from-canonical-truth",
        trigger: "canonical-station-fee-action",
      });
    }
    if (hasUsablePhone(station.phone)) {
      return callContactAction(shipment, station, askForIntent("fees", nextAction, "confirm ground fees, last free day, and pickup availability"), {
        stage: "station-fees-by-phone",
        trigger: "station-email-missing-phone-known",
      });
    }
    return stationContactResearchAction(shipment, station, "Ground fee or storage action needs the station relation first.");
  }

  const external = findCandidate(usableActions, (action) => executableAction(action));
  if (external) return external;
  const platform = findCandidate(usableActions, (action) => platformDecisionAction(action));
  if (platform) return platform;
  if (!noActionPhase(phase) || nextActionLooksActionable(shipment)) return canonicalGapAction(shipment, "", relations);
  return null;
}

function secondaryActions(shipment, usableActions, primary) {
  const primaryKey = primary ? actionConditionKey(primary) : "";
  const phase = phaseForShipment(shipment);
  const allowedPrearrival = ["quote-request", "quote-followup", "prearrival-quote-decision", "carrier-tracking-refresh"];
  return usableActions
    .filter((action) => actionConditionKey(action) !== primaryKey)
    .filter((action) => !truthRepairAction(action))
    .filter((action) => {
      if (["delivery-blocked", "pickup-blocked", "loading-blocked", "exception"].includes(phase)) {
        return /operator-state-check|operator-ping|station-confirmation|station-fee-confirmation/i.test(action.type || "");
      }
      if (["out-for-delivery", "picked-up", "pod-needed", "delivered-pod-pending"].includes(phase)) {
        return /pod-followup|operator-state-check/i.test(action.type || "");
      }
      if (["not-ready", "ready-for-pickup", "dispatch-ready", "approval-needed"].includes(phase)) {
        return /dispatch-pickup-followup|broker-status-followup|tms-broker-award|broker-award|operator-state-check|operator-ping/i.test(action.type || "");
      }
      if (["pre-arrival", "in-transit"].includes(phase)) return allowedPrearrival.includes(action.type);
      return true;
    })
    .slice(0, 4);
}

function repairActions(usableActions, primary, relationships = {}, shipment = {}) {
  const primaryKey = primary ? actionConditionKey(primary) : "";
  return usableActions
    .filter((action) => actionConditionKey(action) !== primaryKey)
    .filter(truthRepairAction)
    .filter((action) => !(action.type === "station-contact-research" &&
      hasUsableEmail(relationships.station?.email) &&
      !action.stationContactMissing &&
      !(action.missing || []).length))
    .filter((action) => !(action.type === "station-contact-research" && stationContactResearchRetiredForShipment(shipment)))
    .slice(0, 3);
}

function generatedRepairActions(shipment, relationships, primary) {
  const repairs = [];
  const station = relationships.station || {};
  const phase = phaseForShipment(shipment);
  const primaryKey = primary ? actionConditionKey(primary) : "";
  if (
    !stationContactResearchRetiredForShipment(shipment) &&
    !hasUsableEmail(station.email)
  ) {
    const action = stationContactResearchAction(shipment, station, "Station import email is missing from the shipment relation tree.");
    if (actionConditionKey(action) !== primaryKey) repairs.push(action);
  }
  return repairs;
}

function actionWorkstream(action = {}, role = "") {
  if (action.type === "money-context-review") return "economics";
  if (role === "truth-repair" || action.actionPlanRole === "truth-repair") return "truth-repair";
  if (action.type === "operator-ping" && action.timing?.stage === "canonical-action-gap") return "truth-repair";
  if (truthRepairAction(action)) return "truth-repair";
  if (role === "primary" && action.channel === "platform") return "decision";
  if (["operator-state-check", "prearrival-quote-decision"].includes(action.type)) return "decision";
  return "execution";
}

function actionSortTier(action = {}, role = "") {
  const workstream = action.workstream || actionWorkstream(action, role);
  if (workstream === "execution") return 0;
  if (workstream === "decision") return 1;
  if (workstream === "truth-repair") return 2;
  if (workstream === "economics") return 3;
  return 4;
}

// ── Reply-contract finalizer ─────────────────────────────────────────────────
// A gmail draft that claims reply_existing is a CONTRACT: live thread, real
// subject, resolvable recipient — hydrated here from the thread roster for
// EVERY builder, current and future. If the contract cannot be satisfied the
// action says exactly why (readiness), instead of reaching the UI as a
// "(no subject)" draft that fails at send (2026-07-06, 016-80000165/141
// status replies shipped with empty subjects and null CC).
function finalizeReplyContract(action, shipment) {
  if (!action || action.channel !== "gmail" || String(action.execution || "") !== "draft_gmail_email") return action;
  const next = { ...action };
  const isReply = String(next.threadPolicy || "") === "reply_existing" || Boolean(next.threadId && next.replyMessageId);
  if (isReply && next.threadId) {
    const info = threadParticipants(shipment, next.threadId);
    if (!String(next.subject || "").trim() && info.latestSubject) {
      next.subject = /^re:/i.test(info.latestSubject) ? info.latestSubject : `Re: ${info.latestSubject}`;
    }
    if (!next.replyMessageId && info.latestMessageId) next.replyMessageId = info.latestMessageId;
    // CC: the thread's non-operator roster minus the To — reply lands where
    // the conversation lives.
    const toEmail = String(next.targetEmail || "").toLowerCase();
    if (!String(next.cc || "").trim()) {
      const roster = (info.participants || [])
        .filter((p) => p.email && !p.operator && p.email.toLowerCase() !== toEmail)
        .slice(0, 8)
        .map((p) => p.email);
      if (roster.length) next.cc = roster.join(", ");
    }
    if (!next.targetEmail && (info.participants || []).some((p) => !p.operator)) {
      const counterparty = (info.participants || []).find((p) => !p.operator);
      next.targetEmail = counterparty.email;
      next.targetName = next.targetName || counterparty.name || counterparty.email;
    }
  }
  if (!next.betaContract) next.betaContract = betaDraftModeContract();
  if (!next.autonomy) next.autonomy = autonomyForChannel("gmail");
  if (!next.safety) next.safety = safetyForChannel("gmail");
  // Readiness verdict — the UI and send preflight key off this, not vibes.
  const missing = [];
  if (!String(next.subject || "").trim()) missing.push("subject");
  if (!hasUsableEmail(String(next.targetEmail || "").split(",")[0])) missing.push("recipient");
  if (isReply && !next.threadId) missing.push("thread");
  next.readiness = missing.length
    ? { ready: false, reason: `Cannot draft safely yet: missing ${missing.join(" + ")} — the ${isReply ? "parent thread was not found in Gmail evidence; refresh email sync or open the thread directly" : "recipient/subject could not be resolved from evidence"}.` }
    : { ready: true, reason: "" };
  if (!next.readiness.ready) {
    next.blockedReason = next.blockedReason || next.readiness.reason;
    next.confidence = "low";
  }
  return next;
}

function stampAction(action, shipment, role, plan) {
  if (!action) return null;
  const awbKey = normalizeAwb(shipment.awb || action.awb || action.shipmentId);
  const sourceFactIds = sourceFactIdsForShipment(shipment);
  const workstream = actionWorkstream(action, role);
  const sortTier = actionSortTier({ ...action, workstream }, role);
  const expectedFact =
    action.postActionExpectedFact ||
    (role === "truth-repair"
      ? "Missing source or relationship is attached to shipment truth."
      : role === "primary"
      ? "The owner replies, confirms, or the operator records the resulting shipment fact."
      : "The secondary action creates or waits for its expected shipment fact.");
  action = finalizeReplyContract(action, shipment);
  return {
    ...action,
    shipmentId: action.shipmentId || shipment.id || shipment.awb,
    awb: action.awb || shipment.awb,
    canonicalPlannerVersion: PLANNER_VERSION,
    actionPlanId: plan.id,
    actionPlanRole: role,
    eligibility: action.eligibility || "eligible",
    actionEligibility: action.actionEligibility || "eligible",
    blockedReason: action.blockedReason || "",
    // Per-action confidence (Evidence_And_Confidence labels). Low confidence must
    // read as "confirm X", never as a confident send — the UI keys off this.
    confidence: action.confidence || (action.channel === "gmail" ? "medium" : "high"),
    missingProof: action.missingProof || "",
    recipients: action.recipients || null,
    recipientNotes: action.recipientNotes || [],
    sourceFactIds: unique([...(action.sourceFactIds || []), ...sourceFactIds]).slice(0, 12),
    idempotencyKey: action.idempotencyKey || `${PLANNER_VERSION}:${awbKey}:${action.type || "action"}:${action.timing?.stage || slug(action.label || "")}`,
    postActionExpectedFact: expectedFact,
    workstream,
    sortTier,
    relationshipsUsed: unique([
      ...(action.relationshipsUsed || []),
      plan.relationships.station?.relationStatus === "known" ? `station:${plan.relationships.station.airport || ""}` : "",
      plan.relationships.pickup?.relationStatus === "known" ? `pickup-broker:${plan.relationships.pickup.name || ""}` : "",
      plan.relationships.customs?.relationStatus === "known" ? `customs-broker:${plan.relationships.customs.name || ""}` : "",
    ]),
  };
}

// Message-level rosters live in the gmail proof snapshot, not the truth packet.
// Callers pass either shipment.gmailProofEvents directly or context.gmailProofByAwb
// (a Map or plain object keyed by normalized AWB, values are proof records or
// event arrays). Recipient/thread/cc decisions must come from these real message
// rosters — never from guessed addresses.
function gmailProofEventsForShipment(shipment = {}, context = {}) {
  if (Array.isArray(shipment.gmailProofEvents)) return shipment.gmailProofEvents;
  const byAwb = context.gmailProofByAwb;
  if (!byAwb) return [];
  const key = normalizeAwb(shipment.awb);
  const record = typeof byAwb.get === "function" ? byAwb.get(key) : byAwb[key];
  if (Array.isArray(record)) return record;
  return Array.isArray(record?.events) ? record.events : [];
}

// Newest status-update-requested event with no operator outbound after it in
// the same thread. Requests older than 5 days are history, not open debts.
function unansweredStatusRequest(shipment = {}) {
  const rows = [
    ...(shipment.gmailProofEvents || []),
    ...(shipment.emailValidation?.events || []),
    ...(shipment.facts || []),
  ].filter(Boolean);
  const requests = rows
    .filter((row) => String(row.type || "") === "status-update-requested")
    .map((row) => ({ ...row, atMs: Date.parse(row.at || "") || 0 }))
    .filter((row) => row.atMs > plannerNow().getTime() - 5 * 24 * 3600 * 1000)
    .sort((a, b) => b.atMs - a.atMs);
  const request = requests[0];
  if (!request) return null;
  const answered = rows.some((row) => {
    if (!row.threadId || row.threadId !== request.threadId) return false;
    const atMs = Date.parse(row.at || "") || 0;
    if (atMs <= request.atMs) return false;
    const fromEmail = String(row.from || "").toLowerCase();
    return /@demo-freight\.example|alex|jordan/.test(fromEmail);
  });
  return answered ? null : request;
}

// Safe external status reply: customer-safe truth only — never internal
// uncertainty, fees, or broker noise; never claims a state that is unproven.
// Display names arrive as "First Last", "Last, First", or bare emails —
// greetings and labels must read like a human wrote them ("Hi Jonathon,",
// never "Hi Bilancia,," — design audit 2026-07-06).
function personNameParts(rawDisplay, email = "") {
  const raw = String(rawDisplay || "").replace(/["']/g, "").trim();
  if (!raw || raw.includes("@")) {
    const local = String(email || raw).split("@")[0].replace(/[._-]+/g, " ").trim();
    return { full: local || "there", first: (local.split(" ")[0] || "there") };
  }
  const commaForm = raw.match(/^([^,]+),\s*(.+)$/);
  if (commaForm) {
    const first = commaForm[2].trim().split(/\s+/)[0];
    return { full: `${commaForm[2].trim()} ${commaForm[1].trim()}`.trim(), first };
  }
  return { full: raw, first: raw.split(/\s+/)[0] };
}

function statusReplyAction(shipment, request) {
  const fromRaw = String(request.from || "");
  const email = (fromRaw.match(/<([^>]+)>/) || [])[1] || fromRaw.trim();
  const displayRaw = (fromRaw.match(/^"?([^"<]+?)"?\s*</) || [])[1] || email;
  const person = personNameParts(displayRaw, email);
  const name = person.full;
  if (!hasUsableEmail(email)) return null;
  const awb = displayAwb(shipment.awb);
  const phase = phaseForShipment(shipment) || "";
  const packetGate = (name) => String(((shipment.truthPacket?.gates || []).find((g) => g.gate === name) || {}).status || "").toLowerCase();
  const gateOk = (name) => gateProven(gateStatusFor(shipment, name)) || gateProven(packetGate(name));
  const arrivalProven = gateOk("arrival");
  const pickedUp = gateOk("pickup");
  const released = gateOk("customs");
  const statusLine = pickedUp
    ? "the shipment was picked up and is moving to final delivery; we will confirm delivery and share proof as soon as it completes"
    : released && arrivalProven
      ? "the shipment has arrived and customs release is complete; we are arranging pickup and delivery now"
      : arrivalProven
        ? "the shipment has arrived at the destination station; release and delivery coordination are in process"
        : "we are confirming arrival/on-hand status with the destination station right now and will update you shortly";
  return {
    id: `${normalizeAwb(shipment.awb)}-status-reply-${slug(request.threadId || request.messageId || "req")}`,
    shipmentId: shipment.id || shipment.awb,
    awb: shipment.awb,
    type: "status-update-reply",
    label: `Reply with a status update to ${compact(name, 40)}`,
    channel: "gmail",
    execution: "draft_gmail_email",
    autonomy: autonomyForChannel("gmail"),
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: name,
    targetEmail: email,
    subject: "",
    threadPolicy: "reply_existing",
    threadId: request.threadId || "",
    messageId: request.messageId || "",
    replyMessageId: request.messageId || "",
    body: actionBody([
      `Hi ${person.first},`,
      "",
      `Quick update on AWB ${awb}: ${statusLine}.`,
      "",
      "Thanks,",
    ]),
    reason: `${name} asked for a status update and is waiting on a reply.`,
    nextAction: `Reply to ${name} with the current safe status, then verify the underlying state internally.`,
    timing: { stage: "status-reply-owed", trigger: "inbound-status-request" },
    operatorUpdateOptions: ["Replied", "No reply needed", "Asked internally first"],
    postActionExpectedFact: "The requester has a truthful status reply; internal verification continues separately.",
    conversation: request.threadId ? {
      threadId: request.threadId,
      replyMessageId: request.messageId || "",
      source: "status-request-thread",
      summary: "Reply in the thread where the update was requested.",
    } : null,
    confidence: "high",
  };
}

function buildCanonicalActionPlan(shipment = {}, candidateActions = [], context = {}) {
  CURRENT_PLAN_NOW = context.now ? (context.now instanceof Date ? context.now : new Date(context.now)) : null;
  const proofEvents = gmailProofEventsForShipment(shipment, context);
  if (proofEvents.length && !Array.isArray(shipment.gmailProofEvents)) {
    shipment = { ...shipment, gmailProofEvents: proofEvents };
  }
  const phase = phaseForShipment(shipment) || "open";
  const awbKey = normalizeAwb(shipment.awb) || slug(shipment.id || "shipment");
  const usableActions = usableCandidateActions(shipment, candidateActions);
  const relationships = {
    station: stationRelationForShipment(shipment, context),
    pickup: pickupRelationForShipment(shipment, usableActions),
    customs: customsRelationForShipment(shipment),
  };
  const plan = {
    id: `${awbKey}-${phase}-action-plan`,
    version: PLANNER_VERSION,
    phase,
    awb: shipment.awb,
    shipmentId: shipment.id || shipment.awb,
    nextAction: nextActionForShipment(shipment),
    relationships,
    sourceFactIds: sourceFactIdsForShipment(shipment),
  };
  let primary = selectedPrimaryAction(shipment, usableActions, relationships);
  let secondary = secondaryActions(shipment, usableActions, primary);
  // An UNANSWERED inbound status request outranks internal chases: the
  // counterparty is waiting on us. The safe external reply becomes primary
  // and the internal verification (whatever the planner chose) stays as a
  // separate secondary action — related, never merged (2026-07-06, Sam/
  // 016-80000165: "please update status of delivery" produced no reply offer).
  const statusRequest = unansweredStatusRequest(shipment);
  // A customs-contested onsite interrupt is not a normal internal chase: the
  // released gate is explicitly disputed, so statusReplyAction would tell the
  // counterparty that release is complete. Keep the airline-confirmation action
  // primary until the contradiction resolves.
  if (statusRequest &&
      primary?.type !== "waiting-on-reply" &&
      primary?.timing?.stage !== "customs-contested-onsite") {
    const reply = statusReplyAction(shipment, statusRequest);
    if (reply) {
      secondary = dedupeActions([primary, ...secondary].filter(Boolean)).slice(0, 4);
      primary = reply;
    }
  }
  const repairs = dedupeActions([...repairActions(usableActions, primary, relationships, shipment), ...generatedRepairActions(shipment, relationships, primary)]).slice(0, 4);
  const stampedPrimary = stampAction(primary, shipment, "primary", plan);
  const stampedSecondary = secondary.map((action) => stampAction(action, shipment, "secondary", plan));
  const stampedRepairs = repairs.map((action) => stampAction(action, shipment, "truth-repair", plan));
  const actions = dedupeActions([stampedPrimary, ...stampedSecondary, ...stampedRepairs].filter(Boolean));
  return {
    ...plan,
    primaryAction: stampedPrimary,
    secondaryActions: stampedSecondary,
    truthRepairActions: stampedRepairs,
    blockedActions: dedupeActions(candidateActions).filter((action) => actionContradictsCanonicalState(action, shipment)).map((action) => ({
      id: action.id || "",
      type: action.type || "",
      label: action.label || "",
      reason: "Candidate action contradicted the canonical shipment phase/next action.",
    })),
    actions,
    candidateActionCount: (candidateActions || []).length,
  };
}

function isCanonicalPlannerAction(action = {}) {
  return action?.canonicalPlannerVersion === PLANNER_VERSION || String(action?.actionPlanId || "").includes("-action-plan");
}

module.exports = {
  PLANNER_VERSION,
  buildCanonicalActionPlan,
  displayAwb,
  isCanonicalPlannerAction,
  normalizeAwb,
  stationRelationForShipment,
  _test: {
    customsRelationForShipment,
    directedOutreachFromNextAction,
    directedReplyAction,
    gmailProofEventsForShipment,
    personAddressFromShipmentText,
    pickupRelationForShipment,
    siblingAwbsFromEvidence,
    threadForAudience,
    threadForDirective,
  },
};

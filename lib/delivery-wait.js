"use strict";

// Post-pickup delivery-blocker class (anchor: the Hebrew multi-AWB email
// "2 המטענים נאספו אתמול / הלקוח סגור עד יום שני בגלל החג / נחוייב על השכבה של
// 3 ימים" — but the rules are structural, English + Hebrew, never per-AWB).
//
// One operational update email frequently carries SEVERAL facts about SEVERAL
// shipments: pickup done + delivery blocked (consignee closed / holiday) +
// waiting/storage/detention cost risk + a future delivery schedule. This
// module classifies each of those independently so reducers can apply all of
// them, fan them out across the referenced AWBs, and supersede them when a
// later delivery/POD proof arrives.

// Hebrew final letters normalize so patterns match both forms (ים/ימ …).
function normalizeHebrew(text = "") {
  return String(text || "").replace(/ם/g, "מ").replace(/ן/g, "נ").replace(/ץ/g, "צ").replace(/ף/g, "פ").replace(/ך/g, "כ");
}

const WEEKDAYS = [
  { index: 0, en: /\bsunday\b/i, he: /ראשונ/ , label: "Sunday" },
  { index: 1, en: /\bmonday\b/i, he: /(?:^|[^א-ת])שני(?:[^א-ת]|$)/, label: "Monday" },
  { index: 2, en: /\btuesday\b/i, he: /שלישי/, label: "Tuesday" },
  { index: 3, en: /\bwednesday\b/i, he: /רביעי/, label: "Wednesday" },
  { index: 4, en: /\bthursday\b/i, he: /חמישי/, label: "Thursday" },
  { index: 5, en: /\bfriday\b/i, he: /שישי/, label: "Friday" },
  { index: 6, en: /\bsaturday\b/i, he: /שבת/, label: "Saturday" },
];

function weekdayFromText(text = "") {
  const normalized = normalizeHebrew(text);
  for (const day of WEEKDAYS) {
    if (day.en.test(normalized) || day.he.test(normalized)) return day;
  }
  return null;
}

// Next occurrence of the weekday strictly after `fromIso`.
function nextWeekdayIso(weekdayIndex, fromIso) {
  const from = new Date(Date.parse(fromIso || "") || Date.now());
  const base = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 12));
  let delta = (weekdayIndex - base.getUTCDay() + 7) % 7;
  if (delta === 0) delta = 7;
  base.setUTCDate(base.getUTCDate() + delta);
  return base.toISOString();
}

// --- Individual classifiers (each may fire independently) -------------------

// "Receiver/customer/consignee/facility is closed (until X / for the holiday)".
function closedConsigneeMatch(text = "") {
  const value = normalizeHebrew(text);
  const en = /\b(?:customer|consignee|receiver|client|facility|warehouse|site|delivery location)\b[^.;\n]{0,60}\b(?:is |are )?closed\b|\bclosed\b[^.;\n]{0,40}\b(?:until|till|through|thru|for the holiday|for the weekend)\b/i.test(value);
  const he = /(?:הלקוח|לקוח|המקבל|הנמענ|הצרכנ|המחסנ|האתר)[^.;\n]{0,24}סגור|סגור(?:ה|ימ)?\s+עד/.test(value);
  // The ingestion pipeline's canned classification for this class — already
  // written into production facts — counts as closure evidence too.
  const canned = /delivery is blocked because the consignee\/facility cannot receive/i.test(value) ||
    /\b(?:consignee|receiver|facility)\b[^.;\n]{0,40}\bcannot receive\b/i.test(value);
  if (!en && !he && !canned) return null;
  const untilSegment = value.match(/\b(?:until|till|through|thru)\s+([^.;\n]{0,40})/i)?.[1] ||
    value.match(/עד\s+([^.;\n]{0,40})/)?.[1] || "";
  const weekday = weekdayFromText(untilSegment) || weekdayFromText(value.match(/\b(?:closed|סגור)[^.;\n]{0,60}/i)?.[0] || "");
  return {
    kind: "consignee-closed",
    untilWeekday: weekday?.label || null,
    untilWeekdayIndex: weekday ? weekday.index : null,
    holiday: /\bholiday\b|החג|חג\b/.test(value),
    weekend: /\bweekend\b|סופ\s?השבוע/.test(value),
  };
}

// Driver waiting AT DELIVERY (post-pickup) — detention risk, not pickup-stuck.
function driverWaitingAtDeliveryMatch(text = "") {
  const value = normalizeHebrew(text);
  const en = /\bdriver\b[^.;\n]{0,60}\bwaiting\b[^.;\n]{0,60}\b(?:deliver|unload|receiver|consignee|customer)\b|\bwaiting (?:at|for) (?:the )?(?:receiver|consignee|delivery|customer)\b/i.test(value);
  const he = /(?:הנהג|נהג)[^.;\n]{0,30}(?:ממתינ|מחכה)[^.;\n]{0,40}(?:למסירה|ללקוח|לפריקה|אצל הלקוח)/.test(value);
  return en || he ? { kind: "driver-waiting-delivery" } : null;
}

// Explicit future delivery schedule ("redelivery Monday", "ימסר ביום שני").
function scheduledDeliveryMatch(text = "") {
  const value = normalizeHebrew(text);
  const en = value.match(/\b(?:deliver(?:y|ing)?|redeliver(?:y)?|drop)\b[^.;\n]{0,50}?\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|after the holiday|next week)\b/i);
  const he = value.match(/(?:ימסר|יימסר|תימסר|מסירה|למסירה)[^.;\n]{0,40}(?:ביומ\s+)?(ראשונ|שני|שלישי|רביעי|חמישי|שישי|שבת|מחר|אחרי החג)/);
  const segment = en?.[1] || he?.[1] || "";
  if (!segment) return null;
  const weekday = weekdayFromText(segment);
  return {
    kind: "delivery-scheduled",
    untilWeekday: weekday?.label || (/(tomorrow|מחר)/i.test(segment) ? "tomorrow" : null),
    untilWeekdayIndex: weekday ? weekday.index : null,
  };
}

// Waiting/storage/detention COST after pickup — a cost risk, never an unpaid
// ground-handler release fee. Anchor: "נחוייב על השכבה של 3 ימים".
function waitingCostMatch(text = "") {
  const value = normalizeHebrew(text);
  // Careful: a station's "storage charges $88 due" is a real ground-handler
  // fee, NOT a waiting cost. Bare storage+charge stays with the fee ledger;
  // only billed/incurred storage, N-days storage, and detention/layover/
  // waiting-time phrasing classify here.
  const en = /\b(?:charged|billed|incur(?:red|ring)?|will (?:be )?charge[ds]?)\b[^.;\n]{0,60}\b(?:storage|waiting(?:\s+time)?|detention|layover|demurrage|dwell)\b|\b(?:waiting(?:\s+time)?|detention|layover|demurrage)\b[^.;\n]{0,40}\b(?:charge|cost|fee)s?\b|\b(\d+)\s*days?\b[^.;\n]{0,40}\b(?:storage|waiting|detention|layover)\b|\b(?:storage|waiting|detention|layover)\b[^.;\n]{0,40}\b(\d+)\s*days?\b/i;
  const heCharged = /(?:נחויב|נחוייב|יחויב|יחוייב|חיוב|נשלמ)[^.;\n]{0,40}(?:השהיה|השכבה|שהייה|המתנה|אחסנה|אחסונ|השהייה)/;
  const heDays = /(?:השהיה|השכבה|שהייה|המתנה|אחסנה|השהייה)[^.;\n]{0,24}(?:של\s*)?(\d+)\s*(?:ימימ|יומ|ימי)/;
  const enMatch = value.match(en);
  const heDaysMatch = value.match(heDays);
  if (!enMatch && !heCharged.test(value) && !heDaysMatch) return null;
  // Day count extraction is its own pass — the trigger may match an
  // alternation without a capture group ("incur … storage").
  const enDays = value.match(/(\d+)\s*days?\b[^.;\n]{0,40}\b(?:storage|waiting|detention|layover)\b/i) ||
    value.match(/\b(?:storage|waiting|detention|layover)\b[^.;\n]{0,40}?(\d+)\s*days?\b/i);
  const days = Number(enDays?.[1] || heDaysMatch?.[1] || "") || null;
  return { kind: "waiting-cost", days };
}

// Group-movement references: "both shipments", "all three", "the 2 loads",
// "2 המטענים", "כל המשלוחים" — the body's facts apply to every referenced AWB.
function groupMovementReference(text = "") {
  const value = normalizeHebrew(text);
  const en = value.match(/\b(?:both|all)\b\s*(?:of\s+(?:them|these))?\s*(two|three|four|five|\d+)?\s*(?:shipments|loads|cargos?|pallets|awbs?|pieces)?/i) ||
    value.match(/\bthese\s+(?:loads|shipments|cargos?|pallets|awbs?)\b/i);
  const enCount = value.match(/\b(?:the\s+)?(\d+)\s+(?:shipments|loads|cargos?|awbs?)\b/i);
  const he = value.match(/(?:(\d+)|שני|שתי|שלושת|ארבעת|כל)\s*ה?(?:מטענימ|משלוחימ|קרגו)/);
  if (!en && !enCount && !he) return { together: false, count: null };
  const wordCounts = { two: 2, three: 3, four: 4, five: 5, שני: 2, שתי: 2, שלושת: 3, ארבעת: 4 };
  const raw = enCount?.[1] || en?.[1] || he?.[1] || "";
  const word = (value.match(/שני|שתי|שלושת|ארבעת/) || [])[0] || (en?.[1] || "").toLowerCase();
  return { together: true, count: Number(raw) || wordCounts[word] || null };
}

// Delivery/POD resolution supersedes the wait (English + Hebrew).
function deliveryResolutionText(text = "") {
  const value = normalizeHebrew(text);
  return /\b(?:delivered|delivery (?:was )?(?:complete|completed|done)|pod (?:received|attached|signed|uploaded)|proof of delivery|re[- ]?delivered)\b/i.test(value) ||
    /(?:נמסר|נמסרה|נמסרו|בוצעה מסירה|מסירה בוצעה|פוד\s*(?:התקבל|צורפ)|יש פוד)/.test(value);
}

// One message, several facts: classify them ALL.
function classifyDeliveryWaitText(text = "", at = "") {
  const closed = closedConsigneeMatch(text);
  const driverWaiting = driverWaitingAtDeliveryMatch(text);
  const scheduled = scheduledDeliveryMatch(text);
  const waitingCost = waitingCostMatch(text);
  if (!closed && !driverWaiting && !scheduled && !waitingCost) return null;
  const primary = closed || driverWaiting || scheduled || waitingCost;
  const weekdayIndex = closed?.untilWeekdayIndex ?? scheduled?.untilWeekdayIndex ?? null;
  return {
    kind: primary.kind,
    closed: Boolean(closed),
    driverWaiting: Boolean(driverWaiting),
    scheduled: Boolean(scheduled),
    untilWeekday: closed?.untilWeekday || scheduled?.untilWeekday || null,
    untilDate: weekdayIndex != null && at ? nextWeekdayIso(weekdayIndex, at) : null,
    holiday: Boolean(closed?.holiday),
    weekend: Boolean(closed?.weekend),
    waitingCost: waitingCost || null,
    group: groupMovementReference(text),
  };
}

function factTimeMs(fact = {}) {
  const parsed = Date.parse(fact.observedAt || fact.capturedAt || fact.at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function factText(fact = {}) {
  return [fact.claim, fact.rawSnippet, fact.summary, fact.note].filter(Boolean).join(" ");
}

// Shipment-level: the latest unresolved delivery wait across all facts, or
// null when a later delivery/POD proof (or a delivered/closed packet state)
// superseded it. Waiting-cost evidence from ANY fact rides along.
// Facts-first API: the packet builder passes its OWN sourceFacts (at cron
// build time row.evidencePacket does not exist yet — reading it was why the
// first deploy of this class produced no change in production).
function deliveryWaitFromFacts(facts = [], packetState = "") {
  let wait = null;
  let waitAt = 0;
  let resolutionAt = 0;
  let waitingCost = null;
  for (const fact of facts) {
    const text = factText(fact);
    if (!text) continue;
    if (deliveryResolutionText(text)) {
      resolutionAt = Math.max(resolutionAt, factTimeMs(fact));
      continue;
    }
    const classified = classifyDeliveryWaitText(text, fact.observedAt || fact.at || "");
    if (!classified) continue;
    if (classified.waitingCost && !waitingCost) waitingCost = classified.waitingCost;
    if ((classified.closed || classified.driverWaiting || classified.scheduled) && factTimeMs(fact) >= waitAt) {
      wait = { ...classified, sourceFactId: fact.id || "", at: fact.observedAt || fact.at || "" };
      waitAt = factTimeMs(fact);
    }
  }
  const state = String(packetState || "").toLowerCase().replace(/-/g, "_");
  if (["delivered", "closed"].includes(state)) return null;
  if (!wait) return null;
  if (resolutionAt && resolutionAt >= waitAt) return null;
  if (waitingCost && !wait.waitingCost) wait.waitingCost = waitingCost;
  return wait;
}

function deliveryWaitForShipment(row = {}) {
  const facts = [
    ...(Array.isArray(row.evidencePacket?.sourceFacts) ? row.evidencePacket.sourceFacts : []),
    ...(Array.isArray(row.facts) ? row.facts : []),
  ];
  return deliveryWaitFromFacts(facts, row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || "");
}

// Operator-language message for the wait (used by the packet contradiction,
// work items, and nextAction).
function deliveryWaitMessage(wait = {}) {
  const when = wait.untilWeekday ? ` until ${wait.untilWeekday}` : "";
  const why = wait.holiday ? " (holiday)" : wait.weekend ? " (weekend)" : "";
  const head = wait.driverWaiting && !wait.closed
    ? "Driver is waiting at the delivery"
    : `Receiver is closed${when}${why}`;
  const plan = wait.untilWeekday
    ? `confirm ${wait.untilWeekday} delivery, collect the POD after`
    : "confirm the delivery window, collect the POD after";
  const cost = wait.waitingCost
    ? ` Confirm the ${wait.waitingCost.days ? `${wait.waitingCost.days}-day ` : ""}waiting/storage charge if billed.`
    : "";
  return `${head} — ${plan}.${cost}`;
}

module.exports = {
  normalizeHebrew,
  deliveryWaitFromFacts,
  classifyDeliveryWaitText,
  deliveryWaitForShipment,
  deliveryWaitMessage,
  groupMovementReference,
  deliveryResolutionText,
  waitingCostMatch,
};

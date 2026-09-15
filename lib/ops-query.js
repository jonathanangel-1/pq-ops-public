"use strict";

// Structured operational queries over canonical truth-packet rows.
//
// The companion must answer operational questions from STRUCTURE, not from
// freeform summaries: "what's in ELP", "what arrived today / over the
// weekend", "picked up but no POD", "arrived but not sent to brokers",
// "what should be handled together". Every result row carries AWB, station,
// consignee, state, reason, next move, and evidence freshness — and when the
// evidence simply is not there (no arrival timestamps), the layer says
// "I don't know" instead of guessing.

const MS_DAY = 24 * 3600 * 1000;

const OPS_STATE_PHRASES = Object.freeze({
  pre_alert: "pre-alert, not moving yet",
  pre_arrival: "not landed yet",
  arrival_unverified: "arrival isn't proven",
  in_transit: "in transit",
  arrived: "landed",
  arrived_not_available: "landed, broker hasn't released it",
  available: "on-hand",
  customs_hold: "customs hold",
  release_needed: "release/D/O still due",
  fees_due: "storage bill's blocking release",
  fees_needed: "storage bill still due",
  storage_risk: "storage risk",
  ready_for_pickup: "released, ready for recovery",
  pickup_scheduled: "recovery booked",
  pickup_onsite: "driver on-site",
  pickup_blocked: "recovery blocked",
  picked_up: "recovered",
  out_for_delivery: "out for delivery",
  delivery_blocked: "delivery blocked",
  loading_blocked: "loading blocked",
  dispatch_ready: "ready to dispatch",
  dispatch_needed: "dispatch still due",
  driver_onsite: "driver on-site",
  driver_waiting: "driver waiting",
  document_request: "documents still due",
  pod_needed: "POD still due",
  delivered: "delivered",
  delivered_pod_pending: "delivered, POD still due",
  closed: "closed",
  source_gap: "source trail incomplete",
  unknown: "current state isn't proven",
});

function statePhrase(value = "") {
  const raw = String(value || "").trim();
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (OPS_STATE_PHRASES[key]) return OPS_STATE_PHRASES[key];
  if (raw && !/[_-]/.test(raw)) return raw;
  return "current state needs review";
}

function normalizeAwb(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function rowState(row = {}) {
  return String(
    row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || "",
  ).toLowerCase().replace(/[\s-]+/g, "_");
}

function gateOf(row = {}, name = "") {
  return (row.truthPacket?.gates || []).find((gate) => gate.gate === name) || null;
}

function gateDone(row, name) {
  const status = String(gateOf(row, name)?.status || row.opsState?.gates?.[name]?.status || "").toLowerCase();
  return ["done", "true", "released", "cleared", "paid", "delivered", "picked-up", "recovered"].includes(status);
}

// Arrival moment: explicit gate timestamp first, else a dated phrase inside the
// gate's own text ("arrival notice Jun 30"), else null — never a guess.
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/;
// Rows arrive in two shapes: packet rows (truthPacket.gates) and brain rows
// (arrivalStatus + facts[]). Arrival truth must read BOTH.
function rowArrived(row = {}) {
  const gate = gateOf(row, "arrival");
  if (gate && ["done", "true"].includes(String(gate.status || "").toLowerCase())) return true;
  return String(row.arrivalStatus || "").toLowerCase() === "arrived";
}

function arrivalMomentMs(row = {}, now = new Date()) {
  if (!rowArrived(row)) return null;
  const gate = gateOf(row, "arrival");
  for (const candidate of [gate?.at, gate?.updatedAt]) {
    const parsed = Date.parse(candidate || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  // Arrival-class facts/events carry the observation time on brain rows.
  const factRows = [
    ...(Array.isArray(row.facts) ? row.facts : []),
    ...(Array.isArray(row.emailValidation?.events) ? row.emailValidation.events : []),
  ].filter((fact) => /arrival|noa|on[- ]hand/i.test(`${fact.type || ""} ${fact.label || ""}`));
  const factTimes = factRows.map((fact) => Date.parse(fact.at || "")).filter(Number.isFinite);
  if (factTimes.length) return Math.max(...factTimes);
  const text = `${gate?.reason || ""} ${gate?.evidence || ""}`;
  const match = text.match(MONTH_RE);
  if (match) {
    const year = match[3] || String(now.getFullYear());
    const parsed = Date.parse(`${match[1]} ${match[2]}, ${year}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function evidenceFreshness(row = {}, now = new Date()) {
  const at = Date.parse(
    row.truthPacket?.freshness?.gmailLatestReadMessageAt ||
    row.lastEmail?.at ||
    "",
  );
  if (!Number.isFinite(at)) return "evidence age unknown";
  const hours = Math.max(0, Math.round((now.getTime() - at) / 3600000));
  if (hours < 1) return "evidence <1h old";
  if (hours < 48) return `evidence ${hours}h old`;
  return `evidence ${Math.round(hours / 24)}d old`;
}

function resultRow(row, reason, now) {
  const stateCode = rowState(row);
  return {
    awb: row.awb || "",
    station: row.station || "",
    consignee: row.client || row.delivery?.consignee || row.consignee || "",
    state: statePhrase(stateCode),
    stateCode,
    reason,
    nextMove: String(row.truthPacket?.nextAction?.summary || row.nextAction || row.opsState?.nextAction || row.freightBroker?.nextAction || "").slice(0, 140),
    freshness: evidenceFreshness(row, now),
    source: "shipment-truth-packets",
  };
}

function activeRows(rows = []) {
  return (rows || []).filter((row) => !row.truthPacketRole || row.truthPacketRole === "active");
}

// ---- query primitives -------------------------------------------------

const BLOCKED_STATES = new Set(["customs_hold", "fees_due", "release_needed", "arrived_not_available"]);

function rowBlocked(row = {}) {
  if (BLOCKED_STATES.has(rowState(row))) return true;
  const blocker = row.truthPacket?.operationalBlocker || {};
  return ["customs_hold", "release_needed", "fees_due", "document_request"].includes(String(blocker.type || ""));
}

// Released = customs gate proven done. Pre-arrival rows are NOT "unreleased
// work" — release only becomes a meaningful gap once the freight has arrived.
function rowReleased(row = {}) {
  return gateDone(row, "customs") ||
    ["ready_for_pickup", "picked_up", "out_for_delivery", "delivered", "pod_needed", "closed"].includes(rowState(row));
}

// Empty station = fleet-wide: "which shipments arrived but are not released?"
// must list across stations, never anchor to the operator's selected shipment.
function stationInventory(rows, station, now = new Date(), filters = {}) {
  const code = String(station || "").trim().toUpperCase();
  let members = activeRows(rows).filter((row) => !code || String(row.station || "").toUpperCase() === code);
  if (filters.arrived) members = members.filter((row) => rowArrived(row));
  if (filters.blocked) members = members.filter((row) => rowBlocked(row));
  if (filters.unreleased) members = members.filter((row) => rowArrived(row) && !rowReleased(row));
  const label = [filters.arrived ? "arrived" : "", filters.blocked ? "blocked" : "", filters.unreleased ? "not released" : ""].filter(Boolean).join(" and ");
  const where = code ? `At ${code}` : "Across stations";
  return {
    kind: "station-inventory",
    station: code,
    filters,
    results: members.map((row) => resultRow(row, label ? `${where} — ${label}` : where, now)),
    shipments: members,
  };
}

function stuckInventory(rows, now = new Date(), station = "") {
  const code = String(station || "").trim().toUpperCase();
  const members = activeRows(rows).filter((row) => (!code || String(row.station || "").toUpperCase() === code) && rowBlocked(row));
  return {
    kind: "stuck",
    station: code,
    filters: { blocked: true },
    results: members.map((row) => {
      const blocker = row.truthPacket?.operationalBlocker || {};
      const reason = String(blocker.reason || blocker.summary || statePhrase(blocker.type || rowState(row)) || "blocked");
      return resultRow(row, reason, now);
    }),
    shipments: members,
  };
}

// windowKind: today | yesterday | weekend | week
function arrivedWithin(rows, windowKind, now = new Date()) {
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = startOfDay(now);
  let fromMs;
  let toMs = now.getTime();
  if (windowKind === "today") fromMs = today;
  else if (windowKind === "yesterday") { fromMs = today - MS_DAY; toMs = today; }
  else if (windowKind === "weekend") {
    // Most recent Sat 00:00 through Mon 00:00 (or now, mid-weekend).
    const day = new Date(today).getDay(); // 0 Sun .. 6 Sat
    const daysSinceSaturday = (day + 1) % 7;
    fromMs = today - daysSinceSaturday * MS_DAY;
    toMs = Math.min(now.getTime(), fromMs + 2 * MS_DAY);
  } else fromMs = today - 7 * MS_DAY;
  // "What arrived today" means PHYSICAL arrivals: a shipment already picked
  // up or delivered arrived before that, whatever a fresh arrival-class fact's
  // observation time says (production audit: a Thursday pickup surfaced as
  // "arrived today" because an arrival fact was observed today).
  const POST_ARRIVAL_STATES = new Set(["picked_up", "out_for_delivery", "delivered", "pod_needed", "closed"]);
  const arrivedRows = activeRows(rows).filter((row) => rowArrived(row) && !POST_ARRIVAL_STATES.has(rowState(row)));
  const dated = [];
  let undatedCount = 0;
  for (const row of arrivedRows) {
    const moment = arrivalMomentMs(row, now);
    if (moment == null) { undatedCount += 1; continue; }
    if (moment >= fromMs && moment < toMs) {
      const gate = gateOf(row, "arrival");
      const gateDated = Number.isFinite(Date.parse(gate?.at || "")) || Number.isFinite(Date.parse(gate?.updatedAt || ""));
      // Fact-time fallback is EVIDENCE time, not occurrence — label it honestly.
      dated.push({ row, reason: `${gateDated ? "Arrived" : "Arrival evidence"} ${new Date(moment).toDateString().slice(0, 10)}` });
    }
  }
  return {
    kind: "arrived-window",
    window: windowKind,
    results: dated.map(({ row, reason }) => resultRow(row, reason, now)),
    shipments: dated.map(({ row }) => row),
    undatedCount,
    unknown: dated.length === 0 && undatedCount > 0,
  };
}

function pickedUpNeedingPod(rows, now = new Date()) {
  const members = activeRows(rows).filter((row) => {
    const state = rowState(row);
    if (["delivered", "closed"].includes(state)) return false;
    const picked = gateDone(row, "pickup") || ["picked_up", "out_for_delivery", "pod_needed"].includes(state);
    const podDone = gateDone(row, "pod");
    return picked && !podDone;
  });
  return {
    kind: "pod-missing",
    results: members.map((row) => resultRow(row, "Picked up — POD not received yet", now)),
    shipments: members,
  };
}

function arrivedNotSentToBrokers(rows, now = new Date()) {
  const members = activeRows(rows).filter((row) => {
    if (!gateDone(row, "arrival")) return false;
    const state = rowState(row);
    if (["picked_up", "out_for_delivery", "delivered", "closed", "pod_needed"].includes(state)) return false;
    const dispatchStatus = String(gateOf(row, "dispatch")?.status || row.opsState?.gates?.dispatch?.status || "").toLowerCase();
    return !["done", "broker-awarded", "broker-alerted", "dispatched", "sent", "quote-received", "quotes-in"].includes(dispatchStatus);
  });
  return {
    kind: "arrived-no-broker",
    results: members.map((row) => resultRow(row, "Arrived — no pickup broker engaged yet", now)),
    shipments: members,
  };
}

function handleTogetherGroups(rows, now = new Date()) {
  const active = activeRows(rows);
  const byKey = new Map();
  for (const row of active) {
    const consignee = String(row.client || row.delivery?.consignee || row.consignee || "").trim().toLowerCase();
    const station = String(row.station || "").toUpperCase();
    if (!consignee && !station) continue;
    const key = `${consignee}::${station}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const groups = [...byKey.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => ({
      key,
      station: String(members[0].station || "").toUpperCase(),
      consignee: members[0].client || members[0].delivery?.consignee || members[0].consignee || "",
      awbs: members.map((row) => row.awb),
      results: members.map((row) => resultRow(row, "Same consignee and station — one operational move", now)),
      shipments: members,
    }))
    .sort((a, b) => b.awbs.length - a.awbs.length);
  return { kind: "handle-together", groups };
}

// Rows for a previously returned result set — follow-ups ("which ones?")
// re-read CURRENT truth for the stored AWBs, never a cached snapshot.
function listForAwbs(rows, awbs = [], now = new Date()) {
  const activeByAwb = new Map(
    activeRows(rows).map((row) => [normalizeAwb(row.awb || row.id), row]),
  );
  const members = (awbs || [])
    .map(normalizeAwb)
    .filter(Boolean)
    .map((awb) => activeByAwb.get(awb))
    .filter(Boolean);
  return {
    kind: "result-set",
    results: members.map((row) => resultRow(row, statePhrase(rowState(row)), now)),
    shipments: members,
  };
}

// Follow-up intents that operate on the conversation's last result set.
// which-ones | open-nth | next-moves | null
function parseFollowUp(question = "") {
  const text = String(question || "").toLowerCase().trim();
  if (!text) return null;
  if (/^(?:which (?:ones|shipments|are they)|list them|show (?:them|me them)|who are they)\??$/.test(text)) {
    return { kind: "which-ones" };
  }
  const nth = text.match(/^(?:open )?(?:the )?(first|second|third|fourth|fifth|last|\d+)(?:st|nd|rd|th)?(?: one)?\.?$/);
  if (nth) {
    const word = nth[1];
    const index = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4 }[word];
    return { kind: "open-nth", index: index != null ? index : (word === "last" ? -1 : Number(word) - 1) };
  }
  if (/^what should (?:i|we) do (?:for|about|with) (?:them|those|these)\??$|^next (?:moves?|steps?) for them\??$/.test(text)) {
    return { kind: "next-moves" };
  }
  return null;
}

// ---- question parsing --------------------------------------------------

const STATION_CODE_RE = /\b(ELP|IAH|BOS|SFO|PHL|DFW|ATL|JFK|ORD|LAX|MIA|EWR|SDF|CVG)\b/i;

function stationCodeFromQuestion(question = "") {
  const text = String(question || "");
  const direct = (text.match(STATION_CODE_RE) || [])[1];
  if (direct) return String(direct).toUpperCase();
  if (/\b(?:los\s+angeles|la)\b/i.test(text)) return "LAX";
  return "";
}

// Returns { kind, ... } or null when this layer has no structured answer.
function parseOperatorQuery(question = "") {
  const text = String(question || "").toLowerCase();
  if (!text.trim()) return null;
  // Open-analytical questions ("…most likely…why", "compare … explain which is
  // likeliest", "rank by risk") are Tier-2 reasoning over a set, not a canned
  // deterministic query — let them fall through to the semantic router so they
  // are not intercepted as a station-inventory/list. Per-shipment "why is X
  // blocked" is already handled earlier in the cascade (coworker layer).
  if (/\b(?:most likely|likeliest|more likely|compare\b|explain\b|predict|forecast|rank(?:ed)?\s+by|at\s+(?:the\s+)?(?:most|highest|biggest)\s+risk|riskiest|which\s+(?:is|are|one|ones)\b[^?]*\b(?:likeliest|most\s+likely|riskiest|worst))\b/i.test(text)) return null;
  const station = stationCodeFromQuestion(question);
  // PAST tense only: "what arrived today" is this layer; "what's arriving
  // this weekend" is the future-ETA planning intent and stays untouched.
  const asksArrived = /\barrived\b|הגיעו|הגיע\b/i.test(text) && !/arriving|supposed to arrive|will arrive|expected/i.test(text);
  if (asksArrived && /\btoday\b|היום/.test(text)) return { kind: "arrived-window", window: "today", station };
  if (asksArrived && /yesterday|אתמול/.test(text)) return { kind: "arrived-window", window: "yesterday", station };
  if (asksArrived && /weekend|סופ"?ש/.test(text)) return { kind: "arrived-window", window: "weekend", station };
  if (asksArrived && /this week|past week|last 7/.test(text)) return { kind: "arrived-window", window: "week", station };
  if (/picked ?up/.test(text) && /\bpod\b|proof of delivery/.test(text)) return { kind: "pod-missing", station };
  if (/not (?:been )?sent to (?:the )?broker|no broker engaged|without (?:a )?broker|not.*dispatch/.test(text) ||
      (asksArrived && /not (?:been )?sent|no broker/.test(text))) return { kind: "arrived-no-broker", station };
  if (/together|same (?:consignee|station|customer)|group|bundle/.test(text)) return { kind: "handle-together", station };
  const unreleased = /not (?:yet )?(?:been )?(?:released|cleared)|pending (?:release|clearance)|awaiting (?:release|clearance)|customs hold|without release|לא שוחרר/.test(text);
  const blocked = /\bblocked?\b|\bstuck\b|\bjammed(?: up)?\b|\bon hold\b/.test(text);
  if (station && /shipments?|freight|cargo|do i have|inventory|list|more/i.test(text) && !/need attention|urgent|risk/.test(text)) {
    return {
      kind: "station-inventory",
      station,
      filters: {
        arrived: /\barrived\b/.test(text),
        blocked,
        unreleased,
      },
    };
  }
  // Fleet-wide list questions ("which shipments arrived but are not released
  // yet?", "which shipments are blocked?") must answer as a fleet list — when
  // they fall through to the intent router they anchor to the currently
  // selected shipment (P0 class, production 2026-07-05).
  if (/(?:which|what|list|show)\b.*shipments?/.test(text) && (asksArrived || blocked || unreleased)) {
    if (blocked && !asksArrived && !unreleased) return { kind: "stuck" };
    return {
      kind: "station-inventory",
      station: "",
      filters: { arrived: asksArrived, blocked, unreleased },
    };
  }
  if (blocked && /^(?:what(?:'s| is)|anything|is anything|show me|list)?\s*(?:stuck|blocked|jammed(?: up)?|on hold)\b|\bwhat(?:'s| is)\s+(?:stuck|blocked)\b/.test(text.trim())) {
    return { kind: "stuck", station };
  }
  return null;
}

function runOperatorQuery(spec, rows, now = new Date()) {
  const station = String(spec?.station || "").toUpperCase();
  const scopedRows = station
    ? (rows || []).filter((row) => String(row.station || "").toUpperCase() === station)
    : rows;
  let result;
  switch (spec?.kind) {
    case "station-inventory": result = stationInventory(scopedRows, station, now, spec.filters || {}); break;
    case "stuck": result = stuckInventory(scopedRows, now, station); break;
    case "arrived-window": result = arrivedWithin(scopedRows, spec.window, now); break;
    case "pod-missing": result = pickedUpNeedingPod(scopedRows, now); break;
    case "arrived-no-broker": result = arrivedNotSentToBrokers(scopedRows, now); break;
    case "handle-together": result = handleTogetherGroups(scopedRows, now); break;
    default: return null;
  }
  return station && result ? { ...result, station } : result;
}

module.exports = {
  OPS_STATE_PHRASES,
  statePhrase,
  parseOperatorQuery,
  parseFollowUp,
  listForAwbs,
  runOperatorQuery,
  stationInventory,
  stuckInventory,
  rowBlocked,
  arrivedWithin,
  pickedUpNeedingPod,
  arrivedNotSentToBrokers,
  handleTogetherGroups,
  _test: { arrivalMomentMs, rowState, rowBlocked, evidenceFreshness },
};

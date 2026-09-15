"use strict";

// Planning ahead (tomorrow's arrivals). Proactive, calm, never urgent-count
// work unless the ETA window has actually tightened into action territory.
//
// A shipment is a planning candidate when:
//   - it is IN import control's near future: departure confirmed (or the
//     packet says in-transit with a real ETA) — never export-unconfirmed
//   - ETA inside the planning window (default 36h)
//   - no pickup broker/dispatch path awarded yet
//   - not terminal, not already actionable-blocked (that's Today's work)
//
// Same-station candidates group into ONE item ("3 arriving tomorrow at ELP ·
// quote request ready for 4 local brokers"). The blast is explicitly a
// QUOTE/pre-alert request, never an award. A low-confidence roster becomes a
// confirm-roster item instead of a blast.

const { normalizeStationMetadata } = require("./station-metadata");

const DEFAULT_WINDOW_HOURS = 36;
const URGENT_WINDOW_HOURS = 12;

// Production rows carry operator-style ETA text ("Jul 06, 2026 / 11:00 AM IAH"),
// not ISO strings — strip the trailing airport code and the slash separator
// before parsing, the same cleanup the action planner applies. Fixture-shaped
// `eta: <ISO>` rows still parse directly.
function parseEtaMs(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  const cleaned = text.replace(/\s+[A-Z]{3}\s*$/, "").replace(/\s*\/\s*/, " ").trim();
  const parsed = Date.parse(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function hoursUntil(iso, now) {
  const target = parseEtaMs(iso);
  const base = Date.parse(now || "") || Date.now();
  if (target == null) return null;
  return (target - base) / 3600000;
}

function shipmentEtaIso(row = {}) {
  return row.eta || row.liveTracking?.scheduledArrival || row.flightDetails?.eta || row.route?.eta || row.opsState?.eta || "";
}

// Planning is PRE-arrival prep. A shipment already on the ground (arrived /
// customs hold / release-fee territory) is action work, not planning work,
// however future its stale ETA text reads.
function alreadyOnGround(row = {}) {
  const state = String(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || "")
    .toLowerCase().replace(/-/g, "_");
  return /^arrived/.test(state) || ["customs_hold", "fees_due", "release_needed", "awaiting_release"].includes(state);
}

function stationOf(row = {}) {
  return String(row.station || row.destination || "").trim().toUpperCase();
}

const DEPARTURE_RE = /\b(?:departed|atd\b|flew|uplift(?:ed)?|on[- ]board|boarded|wheels[- ]up)\b/i;

function departureConfirmed(row = {}) {
  const facts = [
    ...(Array.isArray(row.evidencePacket?.sourceFacts) ? row.evidencePacket.sourceFacts : []),
    ...(Array.isArray(row.facts) ? row.facts : []),
  ];
  const factText = facts.map((fact) => `${fact.claim || ""} ${fact.rawSnippet || ""}`).join(" ");
  // Canonical truth statements ("DO already banked, freight departed LY843/29")
  // carry departure proof that never lands in sourceFacts on production rows.
  const stateText = [
    row.truthPacket?.nextAction?.summary,
    row.nextAction,
    row.opsState?.nextAction,
    row.opsState?.summary,
    row.currentState,
  ].filter(Boolean).join(" ");
  return DEPARTURE_RE.test(factText) || DEPARTURE_RE.test(stateText);
}

function brokerPathExists(row = {}) {
  const dispatch = row.opsState?.gates?.dispatch || {};
  const packetDispatchDone = (row.truthPacket?.gates || []).some((gate) => gate.gate === "dispatch" && gate.status === "true");
  const freight = row.freightBroker || {};
  return packetDispatchDone ||
    ["done", "broker-awarded", "dispatched", "broker-alerted"].includes(String(dispatch.status || "").toLowerCase()) ||
    /awarded|confirmed|pickup-owner/i.test(String(freight.brokerStatus || freight.status || ""));
}

function terminalState(row = {}) {
  const state = String(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || "").toLowerCase();
  return ["delivered", "closed", "picked_up", "out_for_delivery"].includes(state.replace(/-/g, "_"));
}

function activeRosterEntries(roster = []) {
  return (Array.isArray(roster) ? roster : []).filter((entry) => {
    if (!entry || !entry.email) return false;
    if (entry.active === false) return false;
    if (/inactive|superseded|disregard|do[- ]?not[- ]?use|revoked/i.test(String(entry.status || entry.note || ""))) return false;
    return true;
  }).sort((a, b) => (a.preferenceRank ?? 99) - (b.preferenceRank ?? 99));
}

function rosterConfidence(entries = []) {
  if (!entries.length) return "none";
  if (entries.every((entry) => String(entry.confidence || "").toLowerCase() === "high")) return "high";
  if (entries.some((entry) => !entry.confidence || String(entry.confidence).toLowerCase() === "low")) return "low";
  return "medium";
}

// rows: shipment rows; stationMetadataByCode: { ELP: {…contract…} }
function buildPlanningAhead(rows = [], { now = new Date().toISOString(), windowHours = DEFAULT_WINDOW_HOURS, stationMetadataByCode = {} } = {}) {
  const candidates = [];
  for (const row of rows) {
    if (terminalState(row)) continue;
    if (alreadyOnGround(row)) continue;
    if (brokerPathExists(row)) continue;
    const etaHours = hoursUntil(shipmentEtaIso(row), now);
    if (etaHours == null || etaHours < 0 || etaHours > windowHours) continue;
    // Never plan around export-side uncertainty: the pieces/timing are unknown.
    if (!departureConfirmed(row)) continue;
    const agency = row.operatorAgency || row.truthPacket?.operatorAgency || null;
    if (agency?.agency === "not_import_scope_yet") continue;
    candidates.push({ row, etaHours });
  }

  const byStation = new Map();
  for (const candidate of candidates) {
    const station = stationOf(candidate.row) || "UNKNOWN";
    if (!byStation.has(station)) byStation.set(station, []);
    byStation.get(station).push(candidate);
  }

  const items = [];
  for (const [station, members] of byStation) {
    const meta = normalizeStationMetadata(stationMetadataByCode[station] || {});
    const roster = activeRosterEntries(meta.brokerRoster);
    const confidence = rosterConfidence(roster);
    const soonest = Math.min(...members.map((member) => member.etaHours));
    const urgent = soonest <= URGENT_WINDOW_HOURS;
    const awbs = members.map((member) => member.row.awb || member.row.id);
    const arrivingLabel = `${awbs.length} arriving ${soonest <= 24 ? "tomorrow" : "soon"} at ${station}`;
    if (confidence === "low" || confidence === "none") {
      items.push({
        id: `plan:${station}:confirm-roster`,
        kind: "confirm-roster",
        station,
        awbs,
        etaHours: soonest,
        countsAsWork: urgent,
        roster,
        rosterConfidence: confidence,
        title: confidence === "none"
          ? `${arrivingLabel} · planning ahead needs the broker roster for ${station}`
          : `${arrivingLabel} · confirm the ${station} broker roster first`,
        detail: confidence === "none"
          ? `No active broker roster is known for ${station} — confirm who can quote pickups there before a broker quote request can go out.`
          : `The ${station} broker roster has low confidence — confirm it before sending a broker quote request.`,
      });
    } else {
      items.push({
        id: `plan:${station}:quote-blast`,
        kind: "quote-blast",
        station,
        awbs,
        etaHours: soonest,
        countsAsWork: urgent,
        roster,
        rosterConfidence: confidence,
        title: `${arrivingLabel} · broker quote request ready for ${roster.length} local broker${roster.length === 1 ? "" : "s"}`,
        detail: "A pickup-availability / broker quote request — explicitly NOT an awarded pickup. Review and edit before anything is sent.",
      });
    }
    // Station pre-check rides alongside when the handler/contacts are known.
    const stationContacts = Array.isArray(meta.stationContacts) ? meta.stationContacts.filter((contact) => contact?.email || contact?.phone) : [];
    if (stationContacts.length) {
      items.push({
        id: `plan:${station}:station-precheck`,
        kind: "station-precheck",
        station,
        awbs,
        etaHours: soonest,
        countsAsWork: false,
        roster: stationContacts,
        rosterConfidence: meta.confidence || "medium",
        title: `Station pre-check ready for ${station}`,
        detail: `Confirm arrival handling, fees, and release paperwork with ${meta.station || station} before the freight lands.`,
      });
    }
  }
  return items.sort((a, b) => a.etaHours - b.etaHours);
}

// Observability for the UI: WHY the section is empty (nothing to plan vs
// window empty), so absence is understandable and testable.
function planningStatus(rows = [], options = {}) {
  const items = buildPlanningAhead(rows, options);
  const windowHours = options.windowHours || DEFAULT_WINDOW_HOURS;
  return {
    windowHours,
    itemCount: items.length,
    reason: items.length
      ? `${items.length} planning item${items.length === 1 ? "" : "s"} in the next ${windowHours}h.`
      : `No arrivals need planning in the next ${windowHours}h.`,
  };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  planningStatus,
  URGENT_WINDOW_HOURS,
  buildPlanningAhead,
};

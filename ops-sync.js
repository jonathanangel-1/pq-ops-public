const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const {
  autonomyForChannel,
  autonomyForInternalAction,
  betaDraftModeContract,
  operatorApprovedInternalContract,
  safetyForChannel,
  safetyForInternalAction,
} = require("./lib/action-safety");
const {
  buildCanonicalShipments,
  canonicalShipmentAsCompanionShipment,
  carrierTrackingIndex,
} = require("./lib/canonical-shipment-pipeline");
const { attachOperatorPackets } = require("./lib/operator-truth-packet");
const { applyOperationalUnderstanding } = require("./lib/ops-fact-ledger");
const { moneyMemoryByAwb } = require("./lib/money-memory-store");
const { brokerContactCandidatesForAwb } = require("./lib/broker-contact-memory");
const { buildCanonicalActionPlan } = require("./lib/action-planner");
const { attachPrimaryPlatformActions } = require("./lib/platform-action");

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    const envPath = path.join(__dirname, file);
    if (!fsSync.existsSync(envPath)) continue;
    const lines = fsSync.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

loadLocalEnv();

const EMAIL_LOOKBACK_DAYS = 30;
const DEFAULT_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES = 180;
const KNOWN_ACTION_RECIPIENTS = new Map([
  ["contact-072@demo-freight.example", "JD Direct"],
  ["contact-014@demo-freight.example", "Freight Flex"],
  ["contact-102@demo-freight.example", "BTX Global"],
  ["contact-088@demo-freight.example", "Juniper Logistics"],
]);

const FREIGHT_DELIVERED_WITH_POD_STATUSES = new Set([
  "freight-delivered-pod-found",
  "delivered-pod-received",
  "pod-received",
  "pod-found",
  "delivery-completed",
  "delivered-complete",
  "delivered",
  "completed",
]);

const FREIGHT_DELIVERED_PENDING_POD_STATUSES = new Set([
  "freight-delivered-pod-needed",
  "delivery-completed-pod-needed",
  "delivered-pod-needed",
]);

const STEP_LABELS = {
  tms: "Loading saved TMS shipment snapshot",
  tracking: "Applying saved movement snapshot",
  gmail: "Applying saved Gmail proof snapshot",
  freight: "Resolving freight broker awards",
  customs: "Separating customs broker proof",
  actions: "Preparing human-approved action drafts",
  write: "Writing canonical truth packet",
};

function internalPlatformContract(transport, label, note = "") {
  return {
    execution: "operator-approved-internal",
    autonomy: autonomyForInternalAction(transport, label),
    safety: safetyForInternalAction(transport, note),
    betaContract: operatorApprovedInternalContract(transport),
  };
}

function reviewOnlyPlatformContract(label, note = "") {
  return {
    execution: "review-only",
    autonomy: {
      level: "L0",
      mode: "review-only",
      label,
      requiresHumanApproval: true,
      liveExecution: false,
      transport: "decision-ledger-unavailable",
    },
    safety: {
      mode: "review-only",
      originalChannel: "platform",
      redirectedTo: "",
      autonomyLevel: "L0",
      autonomyMode: "review-only",
      internalTransport: "",
      note: note || "Review context only. No durable decision authority is configured.",
    },
    betaContract: {
      mode: "review-only",
      autonomyLevel: "L0",
      requiresHumanApproval: true,
      liveExecution: false,
      internalTransport: "",
    },
  };
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseUsDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const [, month, day, year] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), 12, 0, 0);
}

function dateMinusDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  return next;
}

function datePlusDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

const WEEKDAY_INDEX = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

function parseRelativeWeekdayDate(dayName, hour, minute, now = new Date()) {
  const day = WEEKDAY_INDEX[String(dayName || "").slice(0, 3).toLowerCase()];
  if (!Number.isFinite(day)) return null;
  const next = new Date(now);
  const dayOffset = (day - now.getDay() + 7) % 7;
  next.setDate(now.getDate() + dayOffset);
  next.setHours(Number(hour), Number(minute), 0, 0);
  return next;
}

function parseTrackingDate(value, anchor = null) {
  const text = String(value || "").trim();
  if (!text || /null:null|undefined|invalid/i.test(text)) return null;

  const iso = text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?/);
  if (iso) {
    const [, date, hour, minute] = iso;
    return new Date(`${date}T${hour}:${minute}:00`);
  }

  const named = text.match(
    /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),\s*(\d{4})(?:\s*\/?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i,
  );
  if (named) {
    const [, monthName, day, year, hour = "12", minute = "00", meridiem = "PM"] = named;
    const month = new Date(`${monthName} 1, ${year}`).getMonth();
    let parsedHour = Number(hour);
    if (/pm/i.test(meridiem) && parsedHour < 12) parsedHour += 12;
    if (/am/i.test(meridiem) && parsedHour === 12) parsedHour = 0;
    return new Date(Number(year), month, Number(day), parsedHour, Number(minute));
  }

  const weekday = text.match(/\b(?:ARRIVE|ARRIVAL|RECOVER|ETA|DEPART)?\s*(SUN|MON|TUE|WED|THU|FRI|SAT)[A-Z]*\s+(\d{1,2}):(\d{2})\b/i);
  if (weekday) {
    // A weekday label only means something relative to the record that
    // observed it. Resolving against "now" made stale labels slide forward
    // forever (INC-2026-07-05-ETA-SELF-FEEDBACK); without an anchor the
    // label is unresolved and must never drive passed/arrived judgments.
    const anchorDate = anchor instanceof Date ? anchor : anchor ? new Date(anchor) : null;
    if (!anchorDate || !Number.isFinite(anchorDate.getTime())) return null;
    const [, dayName, hour, minute] = weekday;
    return parseRelativeWeekdayDate(dayName, hour, minute, anchorDate);
  }

  return null;
}

function isPastTrackingEta(value, now = new Date(), anchor = null) {
  const date = parseTrackingDate(value, anchor);
  return Boolean(date && date.getTime() <= now.getTime());
}

function stationEtaStatusCheck(shipment, now = new Date()) {
  if (hasStationArrivalProof(shipment)) return null;
  if (["arrived", "ready"].includes(shipment.arrivalStatus) || ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus)) {
    return null;
  }

  const eta = parseTrackingDate(shipment.eta || shipment.liveTracking?.scheduledArrival || "", shipment.etaObservedAt || null);
  if (!eta) return null;

  const leadHours = Number(process.env.PQ_STATION_STATUS_LEAD_HOURS || 6);
  const leadMs = Math.max(1, leadHours) * 60 * 60 * 1000;
  const diffMs = eta.getTime() - now.getTime();
  if (diffMs > leadMs) return null;

  return {
    status: diffMs <= 0 ? "passed" : "due-soon",
    eta,
    label: diffMs <= 0 ? "ETA passed" : "ETA due",
    detail: diffMs <= 0
      ? "ETA has passed, but station arrival/availability proof is still missing."
      : `ETA is due within ${Math.max(1, leadHours)} hours, and station proof is still missing.`,
  };
}

function isArrivalEtaText(value) {
  return !/\b(booking confirmed|received from other airline|departed|manifested|documents received)\b/i.test(
    String(value || ""),
  );
}

function normalizeAwb(awb) {
  return String(awb || "").replace(/\D/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function uniqueByKey(items, keyForItem) {
  const byKey = new Map();
  for (const item of items || []) {
    const key = keyForItem(item);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, item);
  }
  return [...byKey.values()];
}

function normalizedStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function tmsStatusCode(tmsShipment = {}) {
  const match = String(tmsShipment?.tmsStatus || tmsShipment?.status || "").match(/\b(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function hasTmsDeliveryActual(tmsShipment = {}) {
  return Boolean(
    String(tmsShipment?.deliveryActualArrivalDate || "").trim() ||
      String(tmsShipment?.deliveryActualArrivalTime || "").trim(),
  );
}

function hasTmsPodSignature(tmsShipment = {}) {
  return Boolean(String(tmsShipment?.podSignature || "").trim());
}

function hasTmsCompletionEvidence(tmsShipment = {}) {
  return tmsStatusCode(tmsShipment) >= 380 ||
    hasTmsDeliveryActual(tmsShipment) ||
    hasTmsPodSignature(tmsShipment);
}

function isFreightDeliveredWithPodStatus(status) {
  const normalized = normalizedStatus(status);
  if (FREIGHT_DELIVERED_WITH_POD_STATUSES.has(normalized)) return true;
  if (/no[-\s]?pod|pod[-\s]?requested|pod[-\s]?needed|missing[-\s]?pod/i.test(normalized)) return false;
  return /\b(delivered[-\s]?pod[-\s]?(found|received)|pod[-\s]?(found|received)|delivery[-\s]?completed)\b/i.test(
    normalized,
  );
}

function isFreightDeliveredPendingPodStatus(status) {
  const normalized = normalizedStatus(status);
  return (
    FREIGHT_DELIVERED_PENDING_POD_STATUSES.has(normalized) ||
    /(?:^|[-\s])(?:delivery[-\s]?completed|delivered|pod)(?:[-\s].*)?pod[-\s]?needed(?:[-\s]|$)/i.test(normalized)
  );
}

function isFreightPodFollowupStatus(status) {
  const normalized = normalizedStatus(status);
  return (
    normalized === "freight-ready-pickup-pod-needed" ||
    normalized === "pod-followup-needed" ||
    /(?:^|[-\s])(?:pod[-\s]?(?:needed|pending)|detention[-\s]?pending)(?:[-\s]|$)/i.test(normalized) ||
    isFreightDeliveredPendingPodStatus(normalized)
  );
}

function isFreightPickupDispatchedStatus(status) {
  const normalized = normalizedStatus(status);
  return /\b(broker[-\s]?dispatched|carrier[-\s]?dispatched|dispatched[-\s]?pickup|pickup[-\s]?window|straight[-\s]?through|pickup[-\s]?confirmed|awarded[-\s]?pickup[-\s]?confirmed|loaded[-\s]?on[-\s]?(?:an?\s+)?ltl[-\s]?truck)\b/i.test(
    normalized,
  );
}

function isFreightAirportPickedUpStatus(status) {
  const normalized = normalizedStatus(status);
  if (isFreightDeliveredStatus(normalized)) return false;
  return /(?:^|[-\s])(?:picked[-\s]?up|pickup[-\s]?confirmed|recovery[-\s]?(?:complete|completed)|recovered)(?:[-\s]|$)/i.test(
    normalized,
  );
}

const STATION_TIMEZONE_OFFSETS = new Map([
  ["BOS", "-04:00"],
  ["JFK", "-04:00"],
  ["EWR", "-04:00"],
  ["MIA", "-04:00"],
  ["PIT", "-04:00"],
  ["CLT", "-04:00"],
  ["CMH", "-04:00"],
  ["CLE", "-04:00"],
  ["DTW", "-04:00"],
  ["IAH", "-05:00"],
  ["ELP", "-06:00"],
  ["DEN", "-06:00"],
  ["LAX", "-07:00"],
]);

function stationOffset(station) {
  return STATION_TIMEZONE_OFFSETS.get(String(station || "").toUpperCase()) || "-04:00";
}

function dispatchEvidenceText(shipment) {
  const freight = shipment.freightBroker || {};
  return [
    freight.status,
    freight.summary,
    freight.pickupStatus,
    freight.pickupPlan,
    freight.deliveryPlan,
    freight.nextAction,
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(freight.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || item}`),
  ].filter(Boolean).join(" ");
}

function sameStationClock(anchor, station, hour, minute = 0, meridiem = "pm") {
  const date = new Date(anchor);
  if (!Number.isFinite(date.getTime())) return null;
  let clockHour = Number(hour);
  if (!Number.isFinite(clockHour)) return null;
  const clockMinute = Number(minute) || 0;
  const ampm = String(meridiem || "").toLowerCase();
  if (ampm === "pm" && clockHour < 12) clockHour += 12;
  if (ampm === "am" && clockHour === 12) clockHour = 0;
  const day = date.toISOString().slice(0, 10);
  const hh = String(clockHour).padStart(2, "0");
  const mm = String(clockMinute).padStart(2, "0");
  return new Date(`${day}T${hh}:${mm}:00${stationOffset(station)}`);
}

function hasPickupCompletionDisqualifier(text) {
  const value = String(text || "");
  return Boolean(
    /\bno\s+(?:final\s+)?(?:pickup\s+completion|pickup\s+confirmation|pickup\s+completion\s+or\s+pod)\b/i.test(value) ||
      /\bpickup\s+(?:is\s+)?(?:pending|requested|scheduled|not\s+(?:complete|completed|confirmed|done|found))\b/i.test(value) ||
      /\b(?:must|needs?\s+to|should|has\s+to)\s+be\s+(?:recovered|picked\s+up)\b/i.test(value) ||
      /\b(?:can|could|will|would|may|might|schedule|scheduled|asked|asking|request|requested|confirm|checking|waiting|awaiting)\b.{0,80}\bpicked\s+up\b/i.test(value) ||
      /\b(?:can|could|will|would|may|might|schedule|scheduled|asked|asking|request|requested|confirm|checking|waiting|awaiting)\b.{0,80}\brecovered\b/i.test(value) ||
    /\b(?:driver|broker|carrier)\b.{0,80}\b(?:checking|waiting|awaiting|confirming)\b.{0,80}\bpickup\b/i.test(value) ||
      /\b(?:driver\s+standby|standby\s+driver|not\s+loaded\s+yet|no\s+loaded|loading\s+pending)\b/i.test(value) ||
      /\b(?:will|should|can|please)\b.{0,80}\bfollow up\b.{0,80}\bonce\b.{0,40}\bdriver\b.{0,40}\bloaded\b/i.test(value) ||
      /\bonce\b.{0,40}\bdriver\b.{0,40}\bloaded\b/i.test(value) ||
      /\bnot\s+final\s+(?:delivery|pickup|pod)\b/i.test(value) ||
      /\bnot\s+pickup\s+proof\b/i.test(value),
  );
}

function hasFreightPickupCompletionProofText(text) {
  const value = String(text || "");
  if (hasPickupCompletionDisqualifier(value)) return false;
  return Boolean(
    /\b(?:pickup|recovery)\s+(?:completed|complete|confirmed)\b/i.test(value) ||
      /\b(?:was|has\s+been|is|got)\s+(?:picked\s+up|recovered)\b/i.test(value) ||
      /\b(?:picked\s+up|recovered|loaded\s+out)\s+(?:from|at|by)\b/i.test(value) ||
      /\b(?:driver|truck|carrier|broker)\b.{0,60}\b(?:is\s+)?(?:loaded|loaded\s+out|recovered|picked\s+up)\b/i.test(value),
  );
}

function hasFreightAirportPickupProofText(text) {
  const value = String(text || "");
  return Boolean(
    /\b(?:carrier|driver|truck|broker)\b.{0,80}\b(?:loaded\s+and\s+rolling|loaded\s+out|picked\s+up|recovered)\b/i.test(value) ||
      /\b(?:loaded\s+and\s+rolling|loaded\s+out)\b.{0,80}\b(?:delivery|receiver|route|en\s*route)\b/i.test(value) ||
      /\b(?:picked\s+up|recovered|loaded\s+out)\s+(?:from|at|by)\b/i.test(value),
  );
}

function dispatchPickupFollowupDueStatus(shipment, now = new Date()) {
  const freight = shipment.freightBroker || {};
  const text = dispatchEvidenceText(shipment);
  const pickedUpWithoutPod = shipment.pickupStatus === "airport-picked-up" ||
    hasFreightPickupCompletionProofText(text);
  if (!isFreightPickupDispatchedStatus(freight.status) && !pickedUpWithoutPod) return null;
  if (hasPodProof(shipment)) return null;

  const anchor = Date.parse(freight.latestEventAt || shipment.emailValidation?.latestEventAt || "");

  const dueDates = [];
  if (Number.isFinite(anchor)) {
    if (pickedUpWithoutPod) {
      const graceMinutes = Number(process.env.PQ_POST_PICKUP_FOLLOWUP_MINUTES || 60);
      dueDates.push({
        dueAt: new Date(anchor + Math.max(15, graceMinutes) * 60 * 1000),
        label: "Pickup reported",
        detail: "Pickup was reported; confirm delivery status and POD.",
      });
    }

    if (/\bwithin (?:the )?hour\b|\beta within (?:the )?hour\b/i.test(text)) {
      dueDates.push({
        dueAt: new Date(anchor + 90 * 60 * 1000),
        label: "Pickup ETA passed",
        detail: "Broker/carrier said pickup ETA was within the hour; confirm pickup/POD status.",
      });
    }

    const clockMatch = text.match(/\bbefore\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
    if (clockMatch) {
      const dueAt = sameStationClock(anchor, shipment.station, clockMatch[1], clockMatch[2] || "0", clockMatch[3]);
      if (dueAt && Number.isFinite(dueAt.getTime())) {
        const graceMinutes = Number(process.env.PQ_DISPATCH_FOLLOWUP_GRACE_MINUTES || 30);
        dueDates.push({
          dueAt: new Date(dueAt.getTime() + Math.max(0, graceMinutes) * 60 * 1000),
          label: "Delivery window passed",
          detail: `Broker/carrier promised delivery before ${clockMatch[1]}${clockMatch[2] ? `:${clockMatch[2]}` : ""} ${clockMatch[3].toUpperCase()}; confirm pickup/POD status.`,
        });
      }
    }
  }

  if (/\bloaded\s+on\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?ltl\s+truck\b/i.test(text)) {
    const eta = parseTrackingDate(shipment.eta || shipment.liveTracking?.scheduledArrival || "", shipment.etaObservedAt || null);
    if (eta && Number.isFinite(eta.getTime())) {
      const graceMinutes = Number(process.env.PQ_LINEHAUL_FOLLOWUP_GRACE_MINUTES || 0);
      dueDates.push({
        dueAt: new Date(eta.getTime() + Math.max(0, graceMinutes) * 60 * 1000),
        label: "Destination ETA passed",
        detail: "Linehaul contact confirmed the LTL truck was loaded; confirm destination arrival, availability, and POD path.",
      });
    }
  }

  const selected = dueDates.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0];
  if (!selected) return null;
  return {
    ...selected,
    status: now.getTime() >= selected.dueAt.getTime() ? "overdue" : "pending",
    due: now.getTime() >= selected.dueAt.getTime(),
  };
}

function isFreightDeliveredStatus(status) {
  return isFreightDeliveredWithPodStatus(status) || isFreightDeliveredPendingPodStatus(status);
}

function hasCompletionDisqualifier(text) {
  const value = String(text || "");
  return Boolean(
    /\bno\s+(?:final\s+)?(?:pickup\s+completion|pickup\s+completion\s+or\s+pod|delivery\s+completion|delivery\s+completion\s+or\s+pod|pod|delivery|closeout)\b/i.test(value) ||
      /\bno\b.{0,90}\b(?:arrival|release|d\/?o|customs|pickup|delivery|pod|proof of delivery)\b.{0,40}\b(?:found|received|confirmed|complete|completed|attached)\b/i.test(value) ||
      /\b(?:pod|delivery|closeout)\s+(?:is\s+)?(?:missing|needed|requested|pending|not\s+(?:found|received|provided|attached|complete|completed))\b/i.test(value) ||
      /\b(?:signed\s+)?pod\b.{0,80}\b(?:will follow|to follow|expected|pending|still pending|not yet|once the driver returns)\b/i.test(value) ||
      /\b(?:request|ask|follow(?:ed)? up|waiting|awaiting|obtain|capture|collect|send)\b.{0,80}\b(?:pod|delivery proof|proof of delivery|delivery confirmation|closeout)\b/i.test(value) ||
      /\b(?:payment|receipt|station charge|terminal fee|cargosprint|release|d\/?o|delivery order|documents?)\b.{0,80}\bdelivered\s+to\s+(?:united|airline|cargo|station|warehouse|wfs|swissport|choice|prosegur)\b/i.test(value) ||
      /\b(?:delivered|delivery)\s+(?:address|to:)\b/i.test(value) ||
      /\bnot\s+(?:pickup|delivery|pod)\s+proof\b/i.test(value),
  );
}

function hasFinalDeliveryOrPodProofText(text) {
  const value = String(text || "");
  if (hasCompletionDisqualifier(value)) return false;
  return Boolean(
      /\bpod\s+(?:attached|received|sent|provided|uploaded|found)\b/i.test(value) ||
      /\bproof of delivery\s+(?:attached|received|sent|provided|uploaded|found)\b/i.test(value) ||
      /\b(?:delivery completed|delivered successfully|successfully delivered|final delivery confirmed|closeout confirmed)\b/i.test(value) ||
      /\b(?:delivered|delivery completed)\s+(?:to\s+)?(?:consignee|receiver|recipient|customer|final destination)\b/i.test(value) ||
      /\b(?:piki status update|operations piki|status email|status update)\b.{0,120}\bdelivered\s+to\s+[A-Z][A-Za-z .'/-]{1,60}\b/i.test(value) ||
      /\bdelivered\s+to\s+[A-Z][A-Za-z .'/-]{1,60}\b.{0,80}\b(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}:\d{2}\s*(?:am|pm)?|20\d{2})\b/i.test(value) ||
      /\b(?:signed|received)\s+by\s+[A-Z][A-Za-z.'-]+/i.test(value) ||
      /\bstatus email (?:says|confirmed).{0,80}\bdelivered\b/i.test(value),
  );
}

function hasFinalDeliveryOrPodProofInRows(rows) {
  return (rows || []).some((row) => hasFinalDeliveryOrPodProofText(row));
}

function hasSignedPodPendingText(text) {
  return /\b(?:signed\s+)?pod\b.{0,100}\b(?:will follow|to follow|expected|pending|still pending|not yet|once the driver returns|will be sent)\b/i.test(
    text || "",
  );
}

function hasDetentionPendingText(text) {
  return /\bdetention\b.{0,100}\b(?:pending|will follow|expected|charge|cost|tomorrow|additional charge)\b/i.test(text || "");
}

function isKnownContact(value) {
  return Boolean(value && !/^(unknown|not found|not found yet|confirm|n\/a)\b/i.test(String(value).trim()));
}

function normalizeContactEmails(value) {
  return unique(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).join(", ");
}

function contactEmailList(value) {
  return normalizeContactEmails(value)
    .split(/\s*,\s*/)
    .map((email) => email.toLowerCase())
    .filter(Boolean);
}

function contactEmailsOverlap(left, right) {
  const rightEmails = new Set(contactEmailList(right));
  return contactEmailList(left).some((email) => rightEmails.has(email));
}

function stationContextHasVerifiedEmail(stationContext) {
  return (stationContext?.stations || []).some((station) => isKnownContact(station.stationEmail));
}

function stationContactRoute(shipment) {
  const email = isKnownContact(shipment.stationEmail) ? normalizeContactEmails(shipment.stationEmail) : "";
  if (!email) {
    return {
      email: "",
      missingReason: `Station email is not known for ${[shipment.airline, shipment.station].filter(Boolean).join(" ")}.`,
      originalEmail: "",
    };
  }

  if (
    contactEmailsOverlap(email, shipment.customsBroker?.contactEmail) &&
    !stationContextHasVerifiedEmail(shipment.stationContext)
  ) {
    return {
      email: "",
      missingReason: `The only station email candidate (${email}) matches the customs broker, and station memory does not have a verified station email.`,
      originalEmail: email,
    };
  }

  return { email, missingReason: "", originalEmail: email };
}

function validTrackingTime(value) {
  const text = String(value || "").trim();
  return Boolean(text && !/null:null|undefined|invalid/i.test(text));
}

function compactTime(value) {
  return String(value || "").trim().replace(/:00$/, "");
}

function formatTrackingDateTime(date, station, flight) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const suffix = unique([station, flight ? `· ${flight}` : ""]).join(" ");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}${suffix ? ` ${suffix}` : ""}`;
}

function parsedCarrierArrivalInfo(record, shipment) {
  const text = String(record?.text || "");
  const station = trackingStation(shipment, record);

  const elal = text.match(
    /\b(LY)\s*0*(\d{1,4})\s+(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+\d{1,2}:\d{2}E?\s+(\d{1,2}):(\d{2})E?/i,
  );
  if (elal) {
    const [, airlineCode, flightNumber, day, month, year, hour, minute] = elal;
    const fullYear = Number(year) < 100 ? 2000 + Number(year) : Number(year);
    const date = new Date(fullYear, Number(month) - 1, Number(day), Number(hour), Number(minute));
    return {
      kind: "scheduled-arrival",
      value: formatTrackingDateTime(date, station, `${airlineCode}${flightNumber}`),
    };
  }

  const challengeMatches = [...text.matchAll(/\b([A-Z]{3})\s+([A-Z]{3})\s+([A-Z0-9]{3,})\s+\d{1,2}\s+\w{3}\s+\d{2}\s+\d{1,2}:\d{2}\s+(\d{1,2})\s+(\w{3})\s+(\d{2})\s+(\d{1,2}):(\d{2})/gi)];
  const challenge = challengeMatches
    .map((match) => ({
      from: match[1],
      to: match[2],
      flight: match[3],
      day: match[4],
      month: match[5],
      year: match[6],
      hour: match[7],
      minute: match[8],
    }))
    .find((leg) => !station || leg.to.toUpperCase() === station.toUpperCase());
  if (challenge) {
    const fullYear = 2000 + Number(challenge.year);
    const monthIndex = new Date(`${challenge.month} 1, ${fullYear}`).getMonth();
    const date = new Date(fullYear, monthIndex, Number(challenge.day), Number(challenge.hour), Number(challenge.minute));
    return {
      kind: "actual-arrival",
      value: formatTrackingDateTime(date, challenge.to, challenge.flight),
    };
  }

  return null;
}

function flightLabel(record) {
  const latest = record.latestEvent || {};
  if (latest.airlineCode && latest.flightNumber) return `${latest.airlineCode}${latest.flightNumber}`;
  return (record.flights || []).find(Boolean) || "";
}

function trackingStation(shipment, record) {
  return shipment.station || record.latestEvent?.destination || record.latestEvent?.station || "";
}

function eventTimeLocal(event) {
  return (
    event?.timeLocal ||
    event?.sts_date_time_local ||
    event?.actualArrival?.date_time_local ||
    event?.actualArrival ||
    ""
  );
}

function normalizedEvent(event) {
  if (!event) return null;
  return {
    code: event.code || event.sts_code || "",
    description: event.description || event.sts_description || "",
    station: event.station || "",
    origin: event.origin || "",
    destination: event.destination || "",
    timeLocal: eventTimeLocal(event),
    timeZulu: event.timeZulu || event.sts_date_time_zulu || event.actualArrival?.date_time_zulu || "",
    pieces: event.pieces || "",
    weight: event.weight || "",
    airlineCode: event.airlineCode || "",
    flightNumber: event.flightNumber || "",
    scheduledDeparture: event.scheduledDeparture?.date_time_local || event.scheduledDeparture || "",
    scheduledArrival: event.scheduledArrival?.date_time_local || event.scheduledArrival || "",
    actualDeparture: event.actualDeparture?.date_time_local || event.actualDeparture || "",
    actualArrival: event.actualArrival?.date_time_local || event.actualArrival || "",
  };
}

function finalArrivalEvent(record, shipment) {
  const destination = normalizeKey(record?.finalDestination || shipment.station || record?.latestEvent?.destination);
  const direct = normalizedEvent(record?.finalArrivalEvent);
  if (direct) return direct;

  const statusText = [
    record?.status,
    record?.summaryStatus,
    record?.latestEvent?.description,
  ].join(" ");
  const explicitTextArrival = /\b(status|shipment)\s*[:\-]?\s*(arrived|available|ready for pick.?up)\b/i.test(
    String(record?.text || ""),
  );
  if (
    (/\b(arrived|available|ready for pick.?up)\b/i.test(statusText) || explicitTextArrival) &&
    !/\b(manifested|booking confirmed|in transit)\b/i.test(statusText)
  ) {
    return {
      code: /ready for pick.?up|available/i.test(statusText) ? "AWD" : "ARR",
      description: /ready for pick.?up|available/i.test(statusText) ? "Available by tracking" : "Arrived by tracking",
      station: shipment.station || record?.latestEvent?.station || record?.latestEvent?.destination || "",
      timeLocal: record?.scheduledArrival || record?.eta || record?.latestEvent?.timeLocal || "",
      timeZulu: "",
      pieces: "",
      weight: "",
      airlineCode: "",
      flightNumber: "",
      scheduledDeparture: "",
      scheduledArrival: record?.scheduledArrival || record?.latestEvent?.scheduledArrival || "",
      actualDeparture: "",
      actualArrival: record?.scheduledArrival || record?.eta || "",
    };
  }

  const movements = [
    ...(record?.movements || []),
    ...(record?.sortedMovementList || []).flatMap((station) => station.movements || []),
  ];

  return (
    movements
      .map(normalizedEvent)
      .filter(Boolean)
      .find((event) => {
        const code = String(event.code || "").toLowerCase();
        const station = normalizeKey(event.station || event.destination);
        return ["arr", "rcf", "awd", "awr"].includes(code) && (!destination || station === destination);
      }) || null
  );
}

function trackingEta(record, shipment) {
  const latest = record.latestEvent || {};
  const etaInfo = trackingEtaInfo(record, shipment);
  if (etaInfo.value) return etaInfo.value;
  if (latest.description && validTrackingTime(latest.timeLocal)) {
    return `${latest.description} ${latest.station || ""} ${compactTime(latest.timeLocal)}`.trim();
  }
  if (flightLabel(record)) return `Flight ${flightLabel(record)}`;
  return shipment.eta;
}

function trackingEtaInfo(record, shipment) {
  const latest = record.latestEvent || {};
  const station = trackingStation(shipment, record);
  const flight = flightLabel(record);
  const parsedArrival = parsedCarrierArrivalInfo(record, shipment);
  const finalArrival = finalArrivalEvent(record, shipment);

  if (validTrackingTime(latest.actualArrival)) {
    return {
      kind: "actual-arrival",
      value: `${compactTime(latest.actualArrival)} ${station}`.trim(),
    };
  }

  if (finalArrival && validTrackingTime(eventTimeLocal(finalArrival))) {
    return {
      kind: "actual-arrival",
      value: `${compactTime(eventTimeLocal(finalArrival))} ${finalArrival.station || station}`.trim(),
    };
  }

  if (["arr", "rcf", "awd", "dlv"].includes(String(latest.code || "").toLowerCase()) && validTrackingTime(latest.timeLocal)) {
    return {
      kind: "arrival-event",
      value: `${compactTime(latest.timeLocal)} ${latest.station || station}`.trim(),
    };
  }

  if (parsedArrival) return parsedArrival;

  if (validTrackingTime(record.scheduledArrival)) {
    const flightText = flight ? ` · ${flight}` : "";
    return {
      kind: "scheduled-arrival",
      value: `${compactTime(record.scheduledArrival)} ${station}${flightText}`.trim(),
    };
  }

  if (validTrackingTime(latest.scheduledArrival)) {
    const flightText = flight ? ` · ${flight}` : "";
    return {
      kind: "scheduled-arrival",
      value: `${compactTime(latest.scheduledArrival)} ${station}${flightText}`.trim(),
    };
  }

  if (validTrackingTime(record.eta)) {
    return {
      kind: "carrier-eta",
      value: record.eta,
    };
  }

  if (validTrackingTime(shipment.eta)) {
    return {
      kind: "shipment-eta",
      value: shipment.eta,
    };
  }

  return { kind: "none", value: "" };
}

function trackingMovementStatus(record, shipment) {
  const latest = record.latestEvent || {};
  const code = String(latest.code || record.status || "").toLowerCase();
  const station = String(latest.station || "").toUpperCase();
  const destination = String(latest.destination || shipment.station || "").toUpperCase();
  const shipmentStation = String(shipment.station || destination).toUpperCase();

  if (code === "dlv" || /delivered/i.test(record.status || latest.description || "")) {
    return { arrivalStatus: "arrived", pickupStatus: "airport-picked-up" };
  }

  if (/ready for pick.?up|available/i.test(record.status || latest.description || "")) {
    return { arrivalStatus: "arrived", pickupStatus: "ready" };
  }

  if (finalArrivalEvent(record, shipment)) {
    return { arrivalStatus: "arrived", pickupStatus: shipment.pickupStatus || "pending" };
  }

  if (
    ["arr", "rcf", "awd"].includes(code) &&
    (!shipmentStation || station === shipmentStation || destination === shipmentStation)
  ) {
    return { arrivalStatus: "arrived", pickupStatus: shipment.pickupStatus || "pending" };
  }

  const etaInfo = trackingEtaInfo(record, shipment);
  if (etaInfo.kind === "actual-arrival" && isPastTrackingEta(etaInfo.value, new Date(), shipment.etaObservedAt || null)) {
    return { arrivalStatus: "arrived", pickupStatus: shipment.pickupStatus || "pending" };
  }

  if (trackingEtaPassedLikelyArrived(record, shipment)) {
    return { arrivalStatus: "arrived", pickupStatus: shipment.pickupStatus || "pending" };
  }

  if (/pre[ -]?flight|booking confirmed|in transit/i.test(record.status || latest.description || "")) {
    return { arrivalStatus: "not-arrived", pickupStatus: "pending" };
  }

  return {
    arrivalStatus: shipment.arrivalStatus === "arrived" ? "arrived" : "not-arrived",
    pickupStatus: shipment.pickupStatus || "pending",
  };
}

function trackingEvidence(record, shipment) {
  const latest = record.latestEvent || {};
  const eta = trackingEta(record, shipment);
  const flight = flightLabel(record);
  const finalArrival = finalArrivalEvent(record, shipment);
  const parts = [
    record.status || record.summaryStatus,
    finalArrival ? `Arrived ${finalArrival.station || trackingStation(shipment, record)} ${compactTime(eventTimeLocal(finalArrival))}` : "",
    eta ? `ETA ${eta}` : "",
    latest.description && validTrackingTime(latest.timeLocal)
      ? `Latest ${latest.description} at ${latest.station || "station"} ${compactTime(latest.timeLocal)}`
      : "",
    flight ? `Flight ${flight}` : "",
  ];
  return unique(parts).join(" · ");
}

function trackingStillMoving(record) {
  const latest = record.latestEvent || {};
  const code = String(latest.code || record.status || record.summaryCode || "").toLowerCase();
  const text = [record.status, record.summaryStatus, latest.description].join(" ");
  return ["dep", "bkd", "rct"].includes(code) || /\b(in transit|departed|booking|pre[ -]?flight)\b/i.test(text);
}

function trackingEtaPassedLikelyArrived(record, shipment) {
  const etaInfo = trackingEtaInfo(record, shipment);
  return (
    !finalArrivalEvent(record, shipment) &&
    !trackingStillMoving(record) &&
    ["scheduled-arrival", "carrier-eta", "shipment-eta"].includes(etaInfo.kind) &&
    isPastTrackingEta(etaInfo.value, new Date(), shipment.etaObservedAt || null)
  );
}

function trackingNeedsAvailabilityConfirmation(record, shipment) {
  const latest = record.latestEvent || {};
  const code = String(latest.code || record.status || "").toLowerCase();
  const etaInfo = trackingEtaInfo(record, shipment);
  return (
    !hasStationArrivalProof(shipment) &&
    !finalArrivalEvent(record, shipment) &&
    !trackingEtaPassedLikelyArrived(record, shipment) &&
    !/ready for pick.?up|available/i.test(record.status || latest.description || "") &&
    !["arr", "rcf", "awd", "dlv"].includes(code) &&
    ["scheduled-arrival", "carrier-eta", "shipment-eta"].includes(etaInfo.kind) &&
    (etaInfo.kind !== "shipment-eta" || isArrivalEtaText(etaInfo.value)) &&
    isPastTrackingEta(etaInfo.value, new Date(), shipment.etaObservedAt || null)
  );
}

function trackingReadyNeedsEmail(record, shipment) {
  return (
    /ready for pick.?up|available/i.test(record.status || record.latestEvent?.description || "") &&
    !hasUsefulOperationalEmailProof(shipment)
  );
}

function timelineRowText(row) {
  if (Array.isArray(row)) return row.join(" ");
  if (typeof row === "string") return row;
  if (!row || typeof row !== "object") return "";
  return [
    row.at,
    row.label,
    row.detail,
    row.summary,
    row.note,
    row.status,
  ].filter(Boolean).join(" ");
}

function evidenceRowsText(evidence) {
  const rows = Array.isArray(evidence) ? evidence : evidence ? [evidence] : [];
  return rows.map((item) =>
    typeof item === "string" ? item : evidenceItemText(item),
  );
}

function evidenceItemText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (Array.isArray(item)) return item.map(evidenceItemText).filter(Boolean).join(" ");
  if (typeof item !== "object") return String(item);
  return [
    item.label,
    item.note,
    item.detail,
    item.summary,
    item.source,
    item.contactEmail,
    item.messageId,
    evidenceItemText(item.evidence),
  ].filter(Boolean).join(" ");
}

function factRowText(fact) {
  if (!fact || typeof fact !== "object") return "";
  return [
    fact.section,
    fact.category,
    fact.status,
    fact.summary,
    evidenceItemText(fact.evidence),
    fact.source,
    fact.threadId,
  ].filter(Boolean).join(" ");
}

function emailMovementText(shipment) {
  return [
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.timeline || []).map(timelineRowText),
  ].join(" ");
}

function emailHasPositiveArrivalHandoff(text) {
  return /\b(dropped at|dropped to|delivered to|transferred to|handed off to|handoff to)\s+(?:united|station|airline|carrier|forward air|wfs|swissport|air general|warehouse|cargo)\b/i.test(text);
}

function emailDisclaimsDestinationArrival(text) {
  if (emailHasPositiveArrivalHandoff(text)) return false;
  return Boolean(
      /\b(no|without|missing).{0,50}(arrival|arrived|on[- ]?hand|availability|available|station|noa).{0,80}(proof|confirmation|confirm|notice|reply|evidence)\b/i.test(text) ||
      /\b(no (?:arrival|station|on[- ]?hand|availability|available|noa) (?:proof|confirmation|confirm|notice|reply|evidence))\b/i.test(text) ||
      /\bno\s+(?:station\s+)?(?:arrival|availability|available|on[- ]?hand|noa)\b/i.test(text) ||
      /\b(booking\/pre[- ]?alert|pre[- ]?alert (?:pending|context|only)|wait for\/import pre[- ]?alert|track carrier eta before dispatching pickup|before dispatching pickup|track carrier eta)\b/i.test(text) ||
      /\b(final arrival proof is not expected|pre-arrival|in-transit stage|no station reply|no .*confirm)\b/i.test(text),
  );
}

function emailDisclaimsCargoAvailability(text) {
  return Boolean(
    emailDisclaimsDestinationArrival(text) ||
      /\b(no|without|missing).{0,50}(pickup|pod|delivery|handoff).{0,80}(proof|confirmation|confirm|evidence)\b/i.test(text) ||
      /\b(receipt is not (?:pickup|delivery|pod)|not (?:pickup|delivery|pod) proof)\b/i.test(text),
  );
}

function emailConfirmsCurrentArrival(shipment) {
  const text = emailMovementText(shipment);

  if (emailDisclaimsDestinationArrival(text)) {
    return false;
  }

  return /\b(arriv(?:ed|al).*(confirm|proof|station|available|on hand)|confirm(?:ed)? .*arriv|available for pick.?up|ready for pick.?up|cargo .*on hand|on hand|recovered)\b/i.test(text) ||
    emailHasPositiveArrivalHandoff(text);
}

function emailConfirmsCargoAvailable(shipment) {
  const text = emailMovementText(shipment);

  if (emailDisclaimsCargoAvailability(text)) {
    return false;
  }

  return Boolean(
    emailConfirmsCurrentArrival(shipment) ||
      (/\b(payment (?:has been )?delivered|payment delivered)\b/i.test(text) &&
        /\b(airlines?|wfs|worldwide flight services|swissport|station|cargo)\b/i.test(text) &&
        /\b(fully customs released|customs released|delivery order|d\/?o\b|ready|available|pickup)\b/i.test(text)) ||
      /\b(called .*confirm.*ready|confirm(?:ed)? .*cargo .*ready|cargo .*ready)\b/i.test(text),
  );
}

function emailHasStationArrivalNoticeProof(shipment) {
  const status = shipment.emailValidation?.status || "";
  const proofText = [
    status,
    shipment.emailValidation?.summary,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].join(" ");

  if (/\b(no|without|missing)\s+(?:station\s+)?(?:arrival|noa|a\/?n|notice)\b/i.test(proofText)) {
    return false;
  }
  if (["arrival-confirmation-requested-no-station-proof", "station-arrival-notice-needed"].includes(status)) {
    return false;
  }
  if (/\b(?:request(?:ed)?|need(?:ed)?)\s+(?:the\s+)?(?:station\s+)?(?:arrival notice|notice of arrival|NOA|A\/N)\b|\b(?:ask(?:ed)?|please)\b.{0,40}\b(?:send|provide|confirm on[- ]?hand)\b.{0,30}\b(?:arrival notice|notice of arrival|NOA|A\/N|on[- ]?hand)\b|\bsend\s+(?:the\s+)?(?:station\s+)?(?:arrival notice|notice of arrival|NOA|A\/N)\b/i.test(proofText)) {
    return false;
  }

  return (
    [
      "station-arrival-notice-received",
      "arrival-notice-received",
      "noa-received",
      "station-arrival-confirmed",
    ].includes(status) ||
    /\b(station\s+)?arrival notice\b|\bnotice of arrival\b|\bNOA\b|\bA\/N\b|attached for A\/N/i.test(
      proofText,
    )
  );
}

function emailRejectsCurrentArrival(shipment) {
  const text = emailMovementText(shipment);

  return emailDisclaimsDestinationArrival(text) || /\b(do not (?:mark|treat) as arrived|not arrived|not loaded|did not load|didn.?t load|due space|space hold|still at TLV|offloaded|once arrived|moved to [A-Z0-9/]+|departed on|track onward|track new flight|wait for movement)\b/i.test(
    text,
  );
}

function emailRejectsCarrierLoad(shipment) {
  return /\b(not loaded|did not load|didn.?t load|due space|space hold|offloaded|rolled flight|rolled to|load on (?:tonight|tomorrow|next))\b/i.test(
    emailMovementText(shipment),
  );
}

function hasHardArrivalEvidence(shipment) {
  const latest = shipment.liveTracking?.latestEvent || {};
  const finalArrival = shipment.liveTracking?.finalArrivalEvent || {};
  const trackingText = [
    shipment.liveTracking?.status,
    shipment.liveTracking?.code,
    latest.code,
    latest.description,
    finalArrival.code,
    finalArrival.description,
    shipment.tms?.tmsStatus,
  ].join(" ");

  return (
    shipment.arrivalStatus === "arrived" ||
    ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus) ||
    /\b(arr|rcf|awd|dlv)\b|ready for pick.?up|available|arr\s*@\s*dest|arrived?\s+at\s+dest/i.test(trackingText)
  );
}

function isCustomsControlledArrival(shipment) {
  const text = [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.customsBroker?.status,
    shipment.customsBroker?.nextAction,
    shipment.freightBroker?.status,
    shipment.freightBroker?.pickupPlan,
  ].join(" ");

  return /\b(inbond|in-bond|7512|exportation|customs|release|delivery order|d\/?o)\b/i.test(text);
}

function applyEmailMovementOverlay(shipment) {
  if (
    emailRejectsCurrentArrival(shipment) &&
    !hasStationArrivalProof(shipment) &&
    !["delivered", "airport-picked-up"].includes(shipment.pickupStatus)
  ) {
    if (hasHardArrivalEvidence(shipment) && !emailRejectsCarrierLoad(shipment)) {
      if (isCustomsControlledArrival(shipment)) {
        return {
          ...shipment,
          nextAction:
            shipment.customsBroker?.nextAction ||
            shipment.emailValidation?.nextAction ||
            shipment.nextAction,
          trackingException: null,
          statusAudit: {
            ...(shipment.statusAudit || {}),
            confidenceReasons: unique([
              ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
              "Carrier/TMS arrival was preserved while customs-controlled Gmail proof kept the next action on release/in-bond follow-up.",
            ]),
          },
        };
      }

      const conflictAction = `Carrier/TMS indicates arrival at ${shipment.station || "destination"}; confirm station handoff and NOA.`;
      return {
        ...shipment,
        nextAction: conflictAction,
        trackingException: {
          type: "email-conflicts-with-carrier-arrival",
          summary: "Gmail has pre-arrival/ETA context, but carrier or TMS has hard arrival evidence.",
          nextAction: conflictAction,
        },
        liveTracking: {
          ...(shipment.liveTracking || {}),
          status: "Carrier arrival conflicts with email ETA",
          code: "ARRIVAL-CONFLICT",
        },
        statusAudit: {
          ...(shipment.statusAudit || {}),
          missingInfo: unique([
            ...((shipment.statusAudit && shipment.statusAudit.missingInfo) || []),
            "Email ETA/pre-arrival context conflicts with carrier/TMS arrival evidence.",
          ]),
          confidenceReasons: unique([
            ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
            "Gmail created an arrival conflict, but hard carrier/TMS arrival evidence was preserved.",
          ]),
        },
      };
    }

    return {
      ...shipment,
      arrivalStatus: "not-arrived",
      pickupStatus: "pending",
      nextAction: shipment.emailValidation?.nextAction || shipment.nextAction,
      trackingException: {
        type: "email-overrides-carrier-arrival",
        summary: "Gmail has newer operational context that says this cargo is not ready at destination yet.",
        nextAction: shipment.emailValidation?.nextAction || shipment.nextAction,
      },
      liveTracking: {
        ...(shipment.liveTracking || {}),
        source: "Gmail",
        status: "Not arrived by email proof",
        code: "EMAIL-NOT-ARRIVED",
      },
      statusAudit: {
        ...(shipment.statusAudit || {}),
        confidenceReasons: unique([
          ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
          "Gmail operational proof overrode carrier/TMS arrival state.",
        ]),
      },
    };
  }

  if (shipment.arrivalStatus !== "arrived" && hasStationArrivalProof(shipment)) {
    const station = shipment.station || "destination";
    return {
      ...shipment,
      arrivalStatus: "arrived",
      pickupStatus: shipment.pickupStatus === "pending" ? "pending" : shipment.pickupStatus,
      nextAction:
        !isCustomsResolvedStatus(shipment.customsBroker?.status)
          ? shipment.customsBroker?.nextAction || "Find customs release, broker reply, ABI, or hold status in Gmail."
          : shipment.freightBroker?.nextAction || shipment.emailValidation?.nextAction || `Plan pickup at ${station}`,
      trackingException: null,
      liveTracking: {
        ...(shipment.liveTracking || {}),
        source: "Gmail",
        status: "Arrived by station arrival notice",
        code: "EMAIL-ARRIVAL-NOTICE",
        finalArrivalEvent: shipment.liveTracking?.finalArrivalEvent || {
          station,
          description: "Gmail station arrival notice is attached to this shipment.",
        },
      },
      statusAudit: {
        ...(shipment.statusAudit || {}),
        confidenceReasons: unique([
          ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
          "Gmail station arrival notice preserved arrival proof even without a carrier ARR/RCF event.",
        ]),
      },
    };
  }

  if (shipment.arrivalStatus === "arrived" || !emailConfirmsCargoAvailable(shipment)) return shipment;

  const station = shipment.station || "station";
  return {
    ...shipment,
    arrivalStatus: "arrived",
    pickupStatus: shipment.pickupStatus === "pending" ? "ready" : shipment.pickupStatus,
    nextAction: shipment.freightBroker?.nextAction || `Monitor pickup at ${station}`,
    trackingException: null,
    liveTracking: {
      ...(shipment.liveTracking || {}),
      source: "Gmail",
      status: "Available by email proof",
      code: "EMAIL-AVAILABLE",
      finalArrivalEvent: shipment.liveTracking?.finalArrivalEvent || {
        station,
        description: "Email proof indicates cargo is available at destination station.",
      },
    },
    statusAudit: {
      ...(shipment.statusAudit || {}),
      confidenceReasons: unique([
        ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
        "Gmail payment/release/ready proof overrode missing carrier arrival tracking.",
      ]),
    },
  };
}

function resetTrackingEmailValidation(shipment) {
  const summary = shipment.emailValidation?.summary || "";
  if (!/Tracking ETA has passed|Carrier tracking says ready for pickup/i.test(summary)) {
    return shipment.emailValidation;
  }

  const hasProof = Boolean(shipment.emailValidation?.proof?.length);
  return {
    ...(shipment.emailValidation || {}),
    status: hasProof ? "email-confirmed" : "email-missing",
    summary: hasProof
      ? "Email context found; current carrier data cleared the prior tracking exception."
      : "No matching Gmail thread has been tied to this open TMS shipment yet.",
    nextAction: hasProof
      ? shipment.emailValidation?.nextAction || "Review current shipment email context"
      : "Search by AWB, client, consignee, station, and document names",
  };
}

function applyScheduledTrackingOverlay(shipment, trackingRecord) {
  const eta = trackingEta(trackingRecord, shipment);
  if (!eta && !trackingRecord?.scheduledArrival) return shipment;

  const source = /united/i.test(shipment.airline || trackingRecord.carrier || "")
    ? "United Cargo"
    : trackingRecord.carrier || shipment.airline || "Carrier tracking";
  const flightDetails = movementFlightDetails(trackingRecord);
  const evidenceNote = trackingEvidence(trackingRecord, shipment);
  const existingEvidence = shipment.statusAudit?.evidence || [];
  const evidence = [
    ...existingEvidence.filter((item) => !/tracking|cargo|united|carrier/i.test(`${item.source || ""} ${item.label || ""}`)),
    {
      source,
      label: `${source} tracking`,
      note: evidenceNote || `Scheduled arrival ${eta || trackingRecord.scheduledArrival}.`,
    },
  ];

  return {
    ...shipment,
    eta: eta || shipment.eta,
    arrivalStatus: shipment.arrivalStatus || "not-arrived",
    pickupStatus: shipment.pickupStatus || "pending",
    nextAction:
      shipment.arrivalStatus === "arrived"
        ? shipment.nextAction
        : eta
        ? `Track arrival at ${trackingStation(shipment, trackingRecord) || shipment.station || "destination"}`
        : shipment.nextAction,
    liveTracking: {
      ...(shipment.liveTracking || {}),
      source,
      checkedAt: trackingRecord.snapshotTime || new Date().toISOString(),
      status: trackingRecord.summaryStatus || trackingRecord.status || "Scheduled",
      code: trackingRecord.summaryCode || "SCHEDULED",
      latestEvent: trackingRecord.latestEvent || null,
      finalArrivalEvent: null,
      customs: trackingRecord.customs || shipment.liveTracking?.customs || "",
      url: trackingRecord.url || shipment.liveTracking?.url,
      scheduledArrival: trackingRecord.scheduledArrival || eta || "",
      flights: flightDetails.flights.length ? flightDetails.flights : trackingRecord.flights || shipment.liveTracking?.flights || [],
      flightDetails,
      tmsFlight: flightDetails.tmsFlight || "",
      route: flightDetails.route || "",
    },
    statusAudit: {
      ...(shipment.statusAudit || {}),
      evidence,
      confidenceReasons: unique([
        ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
        `${source} scheduled-arrival tracking snapshot was applied before dashboard write.`,
      ]),
    },
  };
}

function carrierTrackingFailureSummary(trackingRecord = {}) {
  const source = trackingRecord.carrier || "Movement source";
  if (trackingRecord.requiresFlightIntelligence || trackingRecord.flightIntelligenceRequired || trackingRecord.code === "FLIGHT_INTELLIGENCE_NEEDED") {
    const flightDetails = movementFlightDetails(trackingRecord);
    const flightLine = flightDetails.flights.length
      ? ` Flight candidate${flightDetails.flights.length === 1 ? "" : "s"}: ${flightDetails.flights.join(", ")}.`
      : " No flight number is available in the saved movement fields.";
    return `${source} direct cargo tracking is not reliable for this AWB.${flightLine} Verify public flight status and station/on-hand proof before trusting movement state.`;
  }
  const error = String(trackingRecord.error || "").trim();
  if (trackingRecord.noResult) {
    return `${source} returned no usable movement for this AWB.`;
  }
  if (error) return error;
  return `${source} refresh did not return usable movement.`;
}

function directUnitedTrackingSupported(shipment = {}, trackingRecord = {}) {
  const awb = normalizeAwb(shipment.awb || trackingRecord.awb || "");
  const source = `${shipment.airline || ""} ${trackingRecord.carrier || ""} ${trackingRecord.source || ""}`;
  return awb.startsWith("016") || /\bunited\b/i.test(source);
}

function flightCodesFromText(value) {
  const text = String(value || "");
  const flights = [];
  for (const match of text.matchAll(/\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{2,4})([A-Z])?\b/gi)) {
    const segment = String(match[0] || "").toUpperCase().replace(/\s+/g, "");
    if (/TRUCK/i.test(segment)) continue;
    flights.push(`${match[1]}${match[2]}`.toUpperCase());
  }
  return flights;
}

function movementFlightDetails(source = {}) {
  const details = source.flightDetails || {};
  const rawFlights = [
    ...(Array.isArray(source.flights) ? source.flights : []),
    ...(Array.isArray(details.flights) ? details.flights.map((item) => typeof item === "string" ? item : item.flight) : []),
    source.flight,
    details.primaryFlight,
    ...flightCodesFromText(source.tmsFlight || details.tmsFlight || ""),
    ...flightCodesFromText(source.text || source.rawText || source.summary || details.text || ""),
  ].filter(Boolean);
  const flights = unique(rawFlights.map((value) => String(value || "").toUpperCase().replace(/\s+/g, "")).filter(Boolean));
  return {
    ...details,
    flights,
    primaryFlight: details.primaryFlight || flights[0] || "",
    tmsFlight: source.tmsFlight || details.tmsFlight || "",
    route: source.route || details.route || "",
    etaHint: source.eta || source.scheduledArrival || details.etaHint || details.recoveryHint || "",
  };
}

function movementVerificationNeedsFlightIntelligence(shipment = {}, trackingRecord = {}) {
  return Boolean(
    trackingRecord.requiresFlightIntelligence ||
      trackingRecord.flightIntelligenceRequired ||
      trackingRecord.code === "FLIGHT_INTELLIGENCE_NEEDED" ||
      shipment.liveTracking?.requiresFlightIntelligence ||
      shipment.trackingException?.type === "flight-intelligence-needed" ||
      !directUnitedTrackingSupported(shipment, trackingRecord),
  );
}

function applyFailedTrackingOverlay(shipment, trackingRecord) {
  const source = /united/i.test(shipment.airline || trackingRecord.carrier || "")
    ? "United Cargo"
    : trackingRecord.carrier || shipment.airline || "Movement source";
  const needsFlightIntelligence = movementVerificationNeedsFlightIntelligence(shipment, trackingRecord);
  const flightDetails = movementFlightDetails(trackingRecord);
  const failureSummary = carrierTrackingFailureSummary({
    ...trackingRecord,
    carrier: source,
    requiresFlightIntelligence: needsFlightIntelligence,
    flightIntelligenceRequired: needsFlightIntelligence,
  });
  const existingEvidence = shipment.statusAudit?.evidence || [];
  const evidence = [
    ...existingEvidence.filter((item) => !/tracking|cargo|united|carrier/i.test(`${item.source || ""} ${item.label || ""}`)),
    {
      source,
      label: needsFlightIntelligence ? `${source} flight intelligence` : `${source} movement`,
      note: failureSummary,
    },
  ];
  const existingException = shipment.trackingException || null;
  const shouldExposeException = !existingException && !hasUsefulOperationalEmailProof(shipment) && !hasStationArrivalProof(shipment);

  return {
    ...shipment,
    trackingException: existingException || (shouldExposeException
      ? {
          type: needsFlightIntelligence ? "flight-intelligence-needed" : "carrier-tracking-unavailable",
          summary: failureSummary,
          nextAction: needsFlightIntelligence
            ? "Find the flight in Gmail/pre-alert, check the flight online, then confirm station availability if the flight has landed."
            : "Verify United movement again; if it still fails, confirm the latest movement with the station.",
        }
      : null),
    liveTracking: {
      ...(shipment.liveTracking || {}),
      source,
      checkedAt: trackingRecord.snapshotTime || new Date().toISOString(),
      status: needsFlightIntelligence
        ? "Flight status check needed"
        : trackingRecord.noResult ? "No carrier result" : "Movement check failed",
      code: needsFlightIntelligence
        ? "FLIGHT_INTELLIGENCE_NEEDED"
        : trackingRecord.noResult ? "NO_RESULT" : "TRACKING_UNAVAILABLE",
      health: "unavailable",
      refreshable: true,
      requiresFlightIntelligence: needsFlightIntelligence,
      error: failureSummary,
      latestEvent: trackingRecord.latestEvent || null,
      finalArrivalEvent: shipment.liveTracking?.finalArrivalEvent || null,
      customs: trackingRecord.customs || shipment.liveTracking?.customs || "",
      url: trackingRecord.url || shipment.liveTracking?.url,
      scheduledArrival: trackingRecord.scheduledArrival || shipment.liveTracking?.scheduledArrival || shipment.eta || "",
      flights: trackingRecord.flights || shipment.liveTracking?.flights || [],
      flightDetails,
      tmsFlight: flightDetails.tmsFlight || "",
      route: flightDetails.route || "",
      publicFlightStatus: trackingRecord.publicFlightStatus || shipment.liveTracking?.publicFlightStatus || null,
    },
    statusAudit: {
      ...(shipment.statusAudit || {}),
      evidence,
      confidenceReasons: unique([
        ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
        needsFlightIntelligence
          ? `${source} requires flight-status research before dashboard trust: ${failureSummary}`
          : `${source} movement check failed before dashboard write: ${failureSummary}`,
      ]),
    },
  };
}

function applyTrackingOverlay(shipment, trackingRecord) {
  if (!trackingRecord) return shipment;
  if (trackingRecord.ok === false) {
    return applyFailedTrackingOverlay(shipment, trackingRecord);
  }
  if (trackingRecord.noResult) {
    return applyScheduledTrackingOverlay(shipment, trackingRecord);
  }

  const eta = trackingEta(trackingRecord, shipment);
  const movement = trackingMovementStatus(trackingRecord, shipment);
  const source = /united/i.test(shipment.airline || trackingRecord.carrier || "")
    ? "United Cargo"
    : trackingRecord.carrier || shipment.airline || "Movement source";
  const evidenceNote = trackingEvidence(trackingRecord, shipment);
  const trackingEvidenceItem = {
    source,
    label: `${source} movement`,
    note: evidenceNote || "Movement source returned data.",
  };
  const existingEvidence = shipment.statusAudit?.evidence || [];
  const evidence = [
    ...existingEvidence.filter((item) => !/tracking|cargo|united|carrier/i.test(`${item.source || ""} ${item.label || ""}`)),
    trackingEvidenceItem,
  ];
  const latest = trackingRecord.latestEvent || null;
  const hasStationProof = hasStationArrivalProof(shipment);
  const needsAvailabilityConfirmation = !hasStationProof && trackingNeedsAvailabilityConfirmation(
    trackingRecord,
    shipment,
  );
  const readyNeedsEmail = trackingReadyNeedsEmail(trackingRecord, shipment);
  const finalArrival = finalArrivalEvent(trackingRecord, shipment);
  const airportPickupNeedsEmail =
    movement.pickupStatus === "airport-picked-up" && !hasStationProof;
  const arrivedNeedsEmail =
    movement.arrivalStatus === "arrived" &&
    !["delivered", "airport-picked-up"].includes(movement.pickupStatus) &&
    !hasStationProof;
  const hasConfirmedEmail = hasUsefulOperationalEmailProof(shipment);
  const stationName = trackingStation(shipment, trackingRecord) || "station";

  return {
    ...shipment,
    eta: eta || shipment.eta,
    arrivalStatus: movement.arrivalStatus,
    pickupStatus: movement.pickupStatus,
    detail: evidenceNote
      ? `${source}: ${evidenceNote}. ${shipment.detail || ""}`.trim()
      : shipment.detail,
      nextAction:
      needsAvailabilityConfirmation
        ? `Verify movement signal and confirm ${stationName} arrival with station`
        : airportPickupNeedsEmail
        ? `Confirm ${stationName} airport pickup/handoff by email`
        : readyNeedsEmail
        ? `Confirm ${stationName} pickup availability by email`
        : arrivedNeedsEmail
        ? `Confirm ${stationName} arrival/availability by email`
        : movement.arrivalStatus === "arrived" && movement.pickupStatus === "ready"
        ? `Confirm ${stationName} availability and dispatch pickup`
        : movement.arrivalStatus === "arrived"
        ? shipment.nextAction
        : eta
        ? `Track arrival at ${stationName || "destination"}`
        : shipment.nextAction,
    trackingException: needsAvailabilityConfirmation
      ? {
          type: "eta-passed-no-arrival-proof",
          summary: "Movement ETA has passed, but no ARR/RCF/available event or station proof is confirmed.",
          nextAction: `Verify movement signal and confirm ${stationName} arrival with station`,
        }
      : readyNeedsEmail
      ? {
          type: "available-by-tracking-email-needed",
          summary: "Movement signal says available/ready for pickup; email or station confirmation is still needed.",
          nextAction: `Confirm ${stationName} pickup availability by email`,
        }
      : null,
    emailValidation: hasConfirmedEmail
      ? shipment.emailValidation
      : needsAvailabilityConfirmation || airportPickupNeedsEmail || readyNeedsEmail || arrivedNeedsEmail
      ? {
          ...(shipment.emailValidation || {}),
          status:
            shipment.emailValidation?.status === "email-conflict"
              ? "email-conflict"
              : "email-pending",
          summary:
            airportPickupNeedsEmail
              ? `Movement signal says airport pickup/handoff completed at ${stationName}; final email confirmation is still needed.`
              : readyNeedsEmail
              ? "Movement signal says ready for pickup; final email confirmation is still needed."
              : arrivedNeedsEmail
              ? `Movement signal shows arrived at ${stationName}; final email/station confirmation is still needed.`
              : "Movement ETA has passed, but no arrival/available event or station proof is confirmed.",
          nextAction:
            airportPickupNeedsEmail
              ? `Confirm ${stationName} airport pickup/handoff by email`
              : readyNeedsEmail
              ? `Confirm ${stationName} pickup availability by email`
            : arrivedNeedsEmail
              ? `Confirm ${stationName} arrival/availability by email`
              : `Verify movement signal and confirm ${stationName} arrival with station`,
        }
      : resetTrackingEmailValidation(shipment),
    liveTracking: {
      ...(shipment.liveTracking || {}),
      source,
      checkedAt: trackingRecord.snapshotTime || new Date().toISOString(),
      status: trackingRecord.summaryStatus || trackingRecord.status || shipment.liveTracking?.status,
      code: trackingRecord.summaryCode || trackingRecord.status || shipment.liveTracking?.code,
      latestEvent: latest,
      finalArrivalEvent: finalArrival || shipment.liveTracking?.finalArrivalEvent || null,
      customs: trackingRecord.customs || shipment.liveTracking?.customs || "",
      url: trackingRecord.url || shipment.liveTracking?.url,
      scheduledArrival: trackingRecord.scheduledArrival || latest?.scheduledArrival || "",
      flights: trackingRecord.flights || shipment.liveTracking?.flights || [],
    },
    statusAudit: {
      ...(shipment.statusAudit || {}),
      evidence,
      confidenceReasons: unique([
        ...((shipment.statusAudit && shipment.statusAudit.confidenceReasons) || []),
        `${source} tracking snapshot was applied before dashboard write.`,
      ]),
    },
  };
}

function trackingRecordsFromSnapshot(snapshot) {
  const records = snapshot.tracking || snapshot.results || [];
  return records.map((record) => ({ ...record, snapshotTime: snapshot.snapshotTime }));
}

function buildTrackingByAwb(...snapshots) {
  const map = new Map();
  for (const snapshot of snapshots) {
    for (const record of trackingRecordsFromSnapshot(snapshot)) {
      if (!record.awb) continue;
      map.set(record.awb, record);
      map.set(normalizeAwb(record.awb), record);
    }
  }
  return map;
}

function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stationContextForShipment(shipment, stationContextData) {
  const shipmentAirport = normalizeKey(shipment.station);
  const carrierHaystack = normalizeKey(
    [shipment.airline, shipment.handler, shipment.stationEmail].join(" "),
  );

  const matches = (stationContextData.stations || []).filter((station) => {
    const stationAirport = normalizeKey(station.airport);
    if (!stationAirport || stationAirport !== shipmentAirport) return false;

    const carrierTerms = [
      station.airline,
      station.stationName,
      ...(station.aliases || []),
    ].map(normalizeKey);

    return carrierTerms.some((term) => term && carrierHaystack.includes(term));
  });

  if (!matches.length) return null;

  return {
    matchedAt: new Date().toISOString(),
    stations: matches.map((station) => ({
      id: station.id,
      airport: station.airport,
      airline: station.airline,
      stationName: station.stationName,
      stationEmail: station.stationEmail || "",
      stationPhone: station.stationPhone || "",
      contactSource: station.contactSource || station.source || "",
      confidence: station.confidence || "",
      facts: station.facts || [],
    })),
  };
}

function stationContactFromContext(stationContext) {
  const stations = stationContext?.stations || [];
  return stations
    .map((station) => ({
      stationName: station.stationName || "",
      stationEmail: station.stationEmail || "",
      stationPhone: station.stationPhone || "",
      source: station.contactSource || station.id || "station-context",
      confidence: station.confidence || "medium",
    }))
    .find((station) => isKnownContact(station.stationEmail) || isKnownContact(station.stationPhone));
}

function applyStationContextContact(shipment, stationContext) {
  const contact = stationContactFromContext(stationContext);
  if (!contact) return { ...shipment, stationContext };

  const stationEmail = isKnownContact(shipment.stationEmail) ? shipment.stationEmail : contact.stationEmail;
  const stationPhone = isKnownContact(shipment.stationPhone) ? shipment.stationPhone : contact.stationPhone;
  return {
    ...shipment,
    stationEmail: stationEmail || shipment.stationEmail,
    stationPhone: stationPhone || shipment.stationPhone,
    stationContext: {
      ...(stationContext || {}),
      email: stationEmail || stationContext?.email || "",
      phone: stationPhone || stationContext?.phone || "",
      contactSource: contact.source,
      contactConfidence: contact.confidence,
    },
  };
}

function stationMemoryContactForShipment(shipment, stationMemoryData) {
  const shipmentAirport = normalizeKey(shipment.station);
  const carrierHaystack = normalizeKey(
    [shipment.airline, shipment.handler, shipment.stationEmail, shipment.stationPhone].join(" "),
  );

  if (!shipmentAirport) return null;

  const matches = (stationMemoryData.contacts || []).filter((contact) => {
    if (normalizeKey(contact.airport) !== shipmentAirport) return false;

    const carrierTerms = [
      contact.airline,
      contact.handlerName,
      ...(contact.aliases || []),
    ].map(normalizeKey);

    return carrierTerms.some((term) => term && carrierHaystack.includes(term));
  });

  if (!matches.length) return null;
  return matches.sort((a, b) => stationMemoryScore(b) - stationMemoryScore(a))[0];
}

function stationMemoryScore(contact) {
  return [
    isKnownContact(contact.stationEmail) ? 4 : 0,
    isKnownContact(contact.stationPhone) ? 3 : 0,
    contact.handlerName ? 2 : 0,
    contact.confidence === "high" ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function shouldApplyStationPickupBrokerMemory(shipment, contact) {
  if (!contact?.pickupBroker?.email && !contact?.pickupBroker?.name) return false;
  const statusText = [
    shipment.pickupStatus,
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.nextAction,
  ].filter(Boolean).join(" ");
  return !/\b(delivered|completed|closeout|pod[-\s]?(found|received))\b/i.test(statusText);
}

function applyStationMemory(shipment, stationMemoryData) {
  const contact = stationMemoryContactForShipment(shipment, stationMemoryData);
  if (!contact) return shipment;

  const stationEmail = isKnownContact(contact.stationEmail)
    ? contact.stationEmail
    : isKnownContact(shipment.stationEmail)
      ? shipment.stationEmail
      : "";
  const stationPhone = isKnownContact(contact.stationPhone)
    ? contact.stationPhone
    : isKnownContact(shipment.stationPhone)
      ? shipment.stationPhone
      : "";
  const handler =
    isGenericStationHandler(shipment.handler, shipment) && contact.handlerName
      ? contact.handlerName
      : shipment.handler;
  const pickupBrokerMemory = shouldApplyStationPickupBrokerMemory(shipment, contact) ? contact.pickupBroker : null;
  const freightBroker = shipment.freightBroker || {};
  const hasSpecificBroker = freightBroker.broker &&
    !/not found|pending|missing|unknown|harbor forwarding \/ dhl air booking/i.test(String(freightBroker.broker));
  const memoryBrokerName = pickupBrokerMemory?.name || freightBroker.broker || "";
  const memoryBrokerEmail = pickupBrokerMemory?.email || freightBroker.contactEmail || "";
  const memoryBrokerNote = pickupBrokerMemory?.phoneNote || pickupBrokerMemory?.role || "";

  return {
    ...shipment,
    handler,
    stationEmail,
    stationPhone,
    freightBroker: pickupBrokerMemory
      ? {
          ...freightBroker,
          broker: hasSpecificBroker ? freightBroker.broker : memoryBrokerName,
          contactEmail: freightBroker.contactEmail || memoryBrokerEmail,
          contactPhone: freightBroker.contactPhone || memoryBrokerNote,
          status: !freightBroker.status || isFreightMissingLikeStatus(freightBroker.status) ? "freight-awarded" : freightBroker.status,
          brokerStatus: freightBroker.brokerStatus || `${memoryBrokerName} is the standing pickup broker/driver for ${contact.airport}.`,
          pickupPlan: freightBroker.pickupPlan || `Send/confirm TMS alert to ${memoryBrokerName}; DO/status usually comes back by phone.`,
          nextAction: freightBroker.nextAction || `Confirm ${memoryBrokerName} pickup/recovery and collect POD.`,
          driverContact: freightBroker.driverContact || {
            name: memoryBrokerName,
            email: memoryBrokerEmail,
            note: memoryBrokerNote,
          },
        }
      : freightBroker,
    stationContext: {
      ...(shipment.stationContext || {}),
      airport: contact.airport,
      airline: contact.airline,
      handler: contact.handlerName,
      email: stationEmail || "",
      phone: stationPhone || "",
      source: contact.source || "station-memory",
      confidence: contact.confidence || "medium",
      storage: contact.storage || shipment.stationContext?.storage || null,
      rememberedAt: contact.updatedAt || contact.firstSeenAt || null,
    },
  };
}

function applyBrokerContactMemory(shipment, companionMemoryData) {
  const candidates = brokerContactCandidatesForAwb(companionMemoryData, shipment.awb)
    .filter((candidate) => candidate.email && !isInternalOperatorEmail(candidate.email));
  if (!candidates.length) return shipment;
  const freightBroker = shipment.freightBroker || {};
  if (isKnownContact(freightBroker.contactEmail) && contactEmailList(freightBroker.contactEmail).length) return shipment;

  const brokerName = releasePacketBrokerName(shipment) || freightBroker.broker || candidates[0].brokerName || "pickup broker";
  const candidate = candidates.find((item) =>
    !item.brokerName ||
      brokerNamesMatch(item.brokerName, brokerName) ||
      brokerNamesMatch(brokerName, item.brokerName)
  ) || candidates[0];
  const contactName = candidate.brokerName || brokerName;
  const evidence = [
    ...(Array.isArray(freightBroker.evidence) ? freightBroker.evidence : []),
    {
      label: "Operator saved pickup broker contact",
      note: candidate.summary || `${contactName} contact saved by operator`,
      contactEmail: candidate.email,
      source: candidate.source || "broker-contact-memory",
      at: candidate.at || "",
      operatorNoteId: candidate.noteId || "",
    },
  ];

  return {
    ...shipment,
    freightBroker: {
      ...freightBroker,
      broker: freightBroker.broker || contactName,
      contactEmail: candidate.email,
      email: candidate.email,
      brokerStatus: freightBroker.brokerStatus || `${contactName} contact saved by operator.`,
      nextAction: freightBroker.nextAction || `Send/confirm the release packet with ${contactName}, then get pickup time/status.`,
      evidence,
    },
  };
}

function mergeStationContexts(memoryContext, factsContext) {
  if (!memoryContext) return factsContext || null;
  if (!factsContext) return memoryContext;
  return {
    ...memoryContext,
    ...factsContext,
    stationMemory: memoryContext,
    stations: factsContext.stations || [],
  };
}

function hasReusableStationMemory(shipment) {
  const context = shipment.stationContext || {};
  return Boolean(
    context.rememberedAt ||
      context.stationMemory ||
      context.stations?.length ||
      context.source === "Known PQ station memory",
  );
}

function textEvidenceForOpsMemory(shipment) {
  return [
    shipment.detail,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
    shipment.customsBroker?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""}: ${item.note || ""}`),
    ...(shipment.freightBroker?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""}: ${item.note || ""}`
    ),
    ...(shipment.customsBroker?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""}: ${item.note || ""}`
    ),
    ...(shipment.eodFacts || []).map(factRowText),
    ...(shipment.timeline || []).map(timelineRowText),
  ].join("\n");
}

function stationStorageEvidenceRows(shipment) {
  return (shipment.stationContext?.stations || []).flatMap((station) =>
    (station.facts || [])
      .filter((fact) => isStorageMemoryFact(fact))
      .filter((fact) => storageFactAppliesToShipment(fact, shipment))
      .map((fact) =>
        [
          station.stationName,
          fact.type,
          fact.summary,
          fact.source?.note,
          fact.action,
        ].filter(Boolean).join(": ")
      )
  );
}

function storageFactAppliesToShipment(fact, shipment) {
  const currentAwb = normalizeAwb(shipment?.awb);
  const sourceAwb = normalizeAwb(fact?.source?.awb || fact?.awb || fact?.sourceAwb);
  const text = [
    fact?.summary,
    fact?.source?.note,
    fact?.action,
  ].filter(Boolean).join(" ");
  const mentionedAwbs = unique([...text.matchAll(/\b\d{3}[- ]?\d{8}\b/g)].map((match) => normalizeAwb(match[0])));
  if (sourceAwb && sourceAwb !== currentAwb) return false;
  if (mentionedAwbs.length && !mentionedAwbs.includes(currentAwb)) return false;
  if (!mentionedAwbs.length && storageFactHasAbsoluteCutoff(fact)) return false;
  return true;
}

function storageFactHasAbsoluteCutoff(fact) {
  const text = `${fact?.summary || ""} ${fact?.source?.note || ""} ${fact?.action || ""}`;
  return /\b(?:last free(?: day)?|storage starts?|storage start date|storage accruing since)\b[^.\n;]{0,80}\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})\b/i.test(text);
}

function isContaminatedStationStorageFact(fact) {
  if (!isStorageMemoryFact(fact)) return false;
  const sourceAwb = normalizeAwb(fact?.source?.awb || fact?.awb || fact?.sourceAwb);
  if (!sourceAwb) return false;
  const text = [fact?.summary, fact?.source?.note, fact?.action].filter(Boolean).join(" ");
  const mentionedAwbs = unique([...text.matchAll(/\b\d{3}[- ]?\d{8}\b/g)].map((match) => normalizeAwb(match[0])));
  return mentionedAwbs.length > 0 && !mentionedAwbs.includes(sourceAwb);
}

function evidenceSnippets(shipment, pattern, limit = 3) {
  const rows = [
    shipment.detail,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""}: ${item.note || ""}`),
    ...(shipment.eodFacts || []).map(factRowText),
    ...(shipment.timeline || []).map(timelineRowText),
  ];
  return unique(
    rows
      .filter((row) => pattern.test(String(row || "")))
      .map((row) => String(row).trim())
      .filter((row) => !isResolvedCustomsLayerArtifact(row)),
  ).slice(0, limit);
}

function normalizeMemoryDate(value, fallbackYear = new Date().getFullYear()) {
  const text = String(value || "").trim().replace(/\.$/, "");
  if (!text) return "";

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return text;

  const us = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const [, month, day, rawYear] = us;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  const named = text.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?$/i);
  if (named) {
    const [, monthName, day, year = String(fallbackYear)] = named;
    const month = new Date(`${monthName} 1, ${year}`).getMonth() + 1;
    if (Number.isFinite(month)) return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return text;
}

function extractStorageMemory(shipment) {
  const storageRows = stationStorageEvidenceRows(shipment);
  const text = [
    textEvidenceForOpsMemory(shipment),
    ...storageRows,
  ].join("\n");
  const datePattern = "(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?)";
  const lastFreeDay = text.match(new RegExp(`last\\s+free\\s+day\\s*(?:is|:)?\\s*${datePattern}`, "i"));
  const storageStarts = text.match(new RegExp(`storage\\s+(?:(?:starts?|starting|begins?|beginning)\\s*(?:on)?|start\\s+date\\s*:?)\\s*${datePattern}`, "i"));
  const accruing = text.match(new RegExp(`storage\\s+(?:is\\s+)?accru\\w*[^\\n$]*(?:\\$\\s*([\\d,.]+)\\s*(?:\\/|per)?\\s*day|daily\\s+rate\\s*\\$\\s*([\\d,.]+))?[^\\n]*(?:since|from|starting)\\s*${datePattern}`, "i"));
  const rate = text.match(/\$\s*([\d,.]+)\s*(?:\/|per)?\s*day/i);

  const memory = {
    status: "unknown",
    lastFreeDay: lastFreeDay ? normalizeMemoryDate(lastFreeDay[1]) : "",
    storageStartsAt: storageStarts ? normalizeMemoryDate(storageStarts[1]) : "",
    storageAccruingSince: accruing ? normalizeMemoryDate(accruing[3]) : "",
    dailyStorageRate: rate ? `$${rate[1]}/day` : "",
    evidence: unique([
      ...evidenceSnippets(shipment, /storage|last free/i),
      ...storageRows,
    ]).slice(0, 3),
  };

  if (memory.lastFreeDay || memory.storageStartsAt || memory.storageAccruingSince || memory.dailyStorageRate) {
    memory.status = "known";
    memory.sourceAwb = shipment.awb;
    memory.updatedAt = new Date().toISOString();
  }

  return memory;
}

function extractPodMemory(shipment) {
  const text = textEvidenceForOpsMemory(shipment);
  const deliveredTo = text.match(/\bdelivered\s+(?:to|and signed by)\s+([A-Z0-9 .,'-]{2,40})/i);
  const podFound = hasPodProof(shipment);
  const finalPodProof = hasFinalDeliveryOrPodProofText(text) ||
    /\b(?:delivered-pod-found|freight-delivered-pod-found|pod found; delivered status supported)\b/i.test(text);
  const signedPodPending = podFound && !finalPodProof && hasSignedPodPendingText(text);
  const receiver = podFound
    ? shipment.tms?.podSignature || (deliveredTo ? deliveredTo[1].replace(/[.;,]?\s*$/, "").trim() : "")
    : "";
  const delivered = shipment.pickupStatus === "delivered" || /\bdelivery completed\b|proof of delivery/i.test(text);

  return {
    status: signedPodPending ? "signed-pod-pending" : podFound ? "pod-found" : delivered ? "pod-needed" : "not-delivered",
    receiver,
    signedPodPending,
    detentionPending: hasDetentionPendingText(text),
    evidence: evidenceSnippets(shipment, /pod|proof of delivery|delivered|signed/i)
      .filter((item) => !/\b(?:station[-\s]?payment|cargosprint payment|payment (?:is )?not pickup|payment .*not .*pod|station evidence only)\b/i.test(item)),
    updatedAt: new Date().toISOString(),
  };
}

function extractMoneyContext(shipment) {
  const text = textEvidenceForOpsMemory(shipment);
  const paid = [...text.matchAll(/\b(?:paid|payment|receipt|total)\b[^$\n]{0,60}\$\s*([\d,.]+)/gi)]
    .map((match) => `$${match[1]}`);
  const rate = shipment.freightBroker?.rate && shipment.freightBroker.rate !== "Not found"
    ? shipment.freightBroker.rate
    : "";

  const stationPayments = unique(paid).slice(0, 4);
  const customerCharge = shipment.tms?.customerCharge || "";
  const vendorCost = shipment.tms?.vendorCost || "";
  const workingBudget = workingBudgetContext({
    customerCharge,
    vendorCost,
    freightQuoteOrAward: rate,
    stationPayments,
  });

  return {
    customerCharge,
    vendorCost,
    freightQuoteOrAward: rate,
    stationPayments,
    workingBudget,
    marginKnown: Boolean(workingBudget || moneyContextMarginKnown(customerCharge, vendorCost, rate)),
    evidence: evidenceSnippets(shipment, /paid|payment|receipt|total|rate|quote|\$/i),
    updatedAt: new Date().toISOString(),
  };
}

function buildOperationalMemory(shipment) {
  const storage = extractStorageMemory(shipment);
  return {
    storage,
    pod: extractPodMemory(shipment),
    money: extractMoneyContext(shipment),
  };
}

function applyOperationalMemory(shipment) {
  const operationalMemory = buildOperationalMemory(shipment);
  const stationContext =
    operationalMemory.storage.status === "known"
      ? {
          ...(shipment.stationContext || {}),
          storage: operationalMemory.storage,
        }
      : shipment.stationContext;

  return {
    ...shipment,
    stationContext,
    operationalMemory,
  };
}

function applyMoneyMemory(shipment, moneyMemoryRecord) {
  if (!moneyMemoryRecord) return shipment;
  const existing = shipment.operationalMemory?.money || {};
  const customerCharge = existing.customerCharge || moneyMemoryRecord.customerCharge || "";
  const vendorCost = existing.vendorCost || moneyMemoryRecord.vendorCost || "";
  const freightQuoteOrAward = existing.freightQuoteOrAward || moneyMemoryRecord.freightQuoteOrAward || "";
  const stationPayments = existing.stationPayments || [];
  const workingBudget = workingBudgetContext({
    customerCharge,
    vendorCost,
    freightQuoteOrAward,
    stationPayments,
  });
  const evidence = unique([
    ...(existing.evidence || []),
    moneyMemoryRecord.source ? `Operator money memory: ${moneyMemoryRecord.source}` : "Operator money memory",
    moneyMemoryRecord.note,
  ]).slice(0, 6);
  return {
    ...shipment,
    operationalMemory: {
      ...(shipment.operationalMemory || {}),
      money: {
        ...existing,
        customerCharge,
        vendorCost,
        freightQuoteOrAward,
        stationPayments,
        workingBudget,
        marginKnown: Boolean(workingBudget || moneyContextMarginKnown(customerCharge, vendorCost, freightQuoteOrAward)),
        evidence,
        source: "operator-money-memory",
        sourceRecord: {
          awb: moneyMemoryRecord.awb || shipment.awb || "",
          updatedAt: moneyMemoryRecord.updatedAt || "",
          confidence: moneyMemoryRecord.confidence || "medium",
          status: moneyMemoryRecord.status || "",
          order: moneyMemoryRecord.order || "",
          missingFields: moneyMemoryRecord.missingFields || [],
          checkedAt: moneyMemoryRecord.checkedAt || "",
          extractionError: moneyMemoryRecord.extractionError || "",
          extractionAudit: moneyMemoryRecord.extractionAudit || null,
          note: moneyMemoryRecord.note || "",
        },
        updatedAt: moneyMemoryRecord.updatedAt || existing.updatedAt || new Date().toISOString(),
      },
    },
  };
}

function stationContextRecordForOperationalMemory(shipment, snapshotTime) {
  const storage = shipment.operationalMemory?.storage;
  if (!storage || storage.status !== "known") return null;

  const airport = shipment.station || shipment.delivery?.airport || "";
  if (!airport) return null;
  const airline = shipment.airline || shipment.handler || "Station";
  const id = `${airport}|${airline}`;
  const details = unique([
    storage.lastFreeDay ? `last free day ${storage.lastFreeDay}` : "",
    storage.storageStartsAt ? `storage starts ${storage.storageStartsAt}` : "",
    storage.storageAccruingSince ? `storage accruing since ${storage.storageAccruingSince}` : "",
    storage.dailyStorageRate ? `rate ${storage.dailyStorageRate}` : "",
  ]).join("; ");

  return {
    id,
    airport,
    airline,
    stationName: shipment.handler || `${airline} ${airport}`.trim(),
    aliases: unique([
      shipment.airline,
      shipment.handler,
      shipment.stationEmail,
      `${airline} ${airport}`.trim(),
    ]),
    facts: [
      {
        type: "storage",
        summary: details,
        confidence: "high",
        firstSeenAt: snapshotTime,
        lastSeenAt: snapshotTime,
        source: {
          awb: shipment.awb,
          note: storage.evidence?.[0] || "Storage/free-day evidence extracted from shipment email context.",
        },
        action: "Plan pickup before the last free day or account for storage charges.",
      },
    ],
  };
}

function mergeStationFacts(existingFacts = [], incomingFacts = []) {
  const byKey = new Map();
  for (const fact of [...existingFacts, ...incomingFacts]) {
    if (isContaminatedStationStorageFact(fact)) continue;
    const key = `${fact.type || "fact"}|${fact.summary || ""}`;
    const previous = byKey.get(key);
    byKey.set(key, previous
      ? {
          ...previous,
          ...fact,
          firstSeenAt: previous.firstSeenAt || fact.firstSeenAt,
          lastSeenAt: fact.lastSeenAt || previous.lastSeenAt,
        }
      : fact);
  }
  return [...byKey.values()];
}

function mergeStationContextRecords(stationContextData, shipments, snapshotTime) {
  const records = new Map((stationContextData.stations || []).map((station) => [station.id, station]));
  for (const shipment of shipments) {
    const incoming = stationContextRecordForOperationalMemory(shipment, snapshotTime);
    if (!incoming) continue;
    const previous = records.get(incoming.id) || {};
    records.set(incoming.id, {
      ...previous,
      ...incoming,
      aliases: unique([...(previous.aliases || []), ...(incoming.aliases || [])]),
      facts: mergeStationFacts(previous.facts || [], incoming.facts || []),
    });
  }

  return {
    ...stationContextData,
    snapshotTime,
    source: stationContextData.source || "Reusable station operational memory",
    schema: stationContextData.schema || "station-context.v1",
    stations: [...records.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    lastAutomationUpdate: {
      ...(stationContextData.lastAutomationUpdate || {}),
      operationalMemoryMergedAt: snapshotTime,
    },
  };
}

function isGenericStationHandler(handler, shipment) {
  const normalized = normalizeKey(handler);
  if (!normalized || /unknown|confirm|not found/.test(normalized)) return true;
  return normalized === normalizeKey(`${shipment.airline || ""} ${shipment.station || ""}`.trim());
}

function buildGmailQueryTerms(tmsShipment, dashboardShipment) {
  const awb = dashboardShipment?.awb || tmsShipment?.trackingNumber || "";
  const normalizedAwb = normalizeAwb(awb);

  return unique([
    awb,
    normalizedAwb,
    tmsShipment?.reference,
    tmsShipment?.shipmentNumber,
    tmsShipment?.pickupFrom,
    tmsShipment?.pickupCompany,
    tmsShipment?.consigneeCompany,
    dashboardShipment?.client,
    dashboardShipment?.broker,
    dashboardShipment?.customsBroker?.broker,
    dashboardShipment?.handler,
    dashboardShipment?.station,
  ]);
}

function buildEmailSearchWindow(tmsShipment) {
  const departureDate =
    parseUsDate(tmsShipment?.pickupReadyDate) ||
    parseUsDate(tmsShipment?.readyDate) ||
    new Date();
  const startDate = dateMinusDays(departureDate, EMAIL_LOOKBACK_DAYS);

  return {
    lookbackDays: EMAIL_LOOKBACK_DAYS,
    startDate: toIsoDate(startDate),
    endDate: toIsoDate(datePlusDays(new Date(), 1)),
    basis: tmsShipment?.pickupReadyDate
      ? "30 days before TMS pickup/departure-ready date"
      : "30 days before refresh date because no departure date was available",
  };
}

function inferLayerStatus(shipment) {
  const emailStatus = shipment.emailValidation?.status || "email-missing";
  const hasEmailGap = !hasUsefulOperationalEmailProof(shipment);
  const trackingArrived =
    shipment.arrivalStatus === "arrived" || shipment.arrivalStatus === "delivered";
  const airportPickedUp = shipment.pickupStatus === "airport-picked-up";
  const trackingDelivered = shipment.pickupStatus === "delivered";

  return {
    tmsInventory: "open",
    trackingMovement: trackingDelivered
      ? "delivered"
      : airportPickedUp
      ? "airport-picked-up"
      : trackingArrived
      ? "arrived"
      : "not-arrived",
    gmailValidation: emailStatus,
    needsHumanReview: Boolean(shipment.attention || hasEmailGap),
  };
}

const FREIGHT_BROKER_ALIASES = [
  {
    name: "JD Direct",
    aliases: ["JD Direct", "JDDirect", "JD Direct LLC", "JDDIRECTLLC"],
    email: "contact-072@demo-freight.example",
  },
  {
    name: "Freight Flex",
    aliases: ["Freight Flex", "FreightFlex"],
    email: "contact-014@demo-freight.example",
  },
  {
    name: "BTX Global",
    aliases: ["BTX", "BTX Global", "BTX Global Logistics"],
    email: "contact-102@demo-freight.example",
  },
  {
    name: "Juniper Logistics",
    aliases: ["Rapid", "Juniper Logistics", "Rapid Logistic Solutions"],
    email: "contact-088@demo-freight.example",
  },
  {
    name: "TQL",
    aliases: ["TQL", "Total Quality Logistics"],
    email: "",
  },
  {
    name: "Forward Air",
    aliases: ["Forward Air"],
    email: "",
  },
  {
    name: "FlitePak",
    aliases: ["FlitePak", "Flite Pak"],
    email: "",
  },
];

function normalizeMoneyAmount(value) {
  const match = String(value || "").match(/\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function formatMoney(amount, currency = "USD") {
  if (!Number.isFinite(amount)) return "";
  const rounded = amount % 1 === 0 ? String(amount) : amount.toFixed(2);
  return currency === "USD" ? `$${rounded}` : `${rounded} ${currency}`;
}

function moneyAmountOrZero(value) {
  const amount = normalizeMoneyAmount(value);
  return amount === null ? 0 : amount;
}

function workingBudgetContext({ customerCharge, vendorCost, freightQuoteOrAward, stationPayments }) {
  const customer = normalizeMoneyAmount(customerCharge);
  const vendor = normalizeMoneyAmount(vendorCost);
  const freight = normalizeMoneyAmount(freightQuoteOrAward);
  const stationTotal = (stationPayments || []).reduce((sum, item) => sum + moneyAmountOrZero(item), 0);
  const costBasis = vendor ?? ((freight ?? 0) + stationTotal);
  if (customer === null || !costBasis) return null;
  const available = customer - costBasis;
  const basis = vendor !== null
    ? "customer charge minus TMS vendor cost"
    : "customer charge minus quote/payment costs";
  return {
    available,
    label: formatMoney(available),
    basis,
    customer: formatMoney(customer),
    costBasis: formatMoney(costBasis),
  };
}

function compactQuoteText(value, max = 90) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function quoteEvidenceText(value) {
  if (!value) return "";
  if (typeof value === "string") return compactQuoteText(value, 150);
  if (Array.isArray(value)) return value.map(quoteEvidenceText).filter(Boolean).join(" · ");
  if (typeof value === "object") {
    return compactQuoteText(value.note || value.summary || value.label || value.evidence || "", 150);
  }
  return compactQuoteText(value, 150);
}

function quoteBrokerProfile(value) {
  const text = String(value || "");
  return FREIGHT_BROKER_ALIASES.find((profile) =>
    profile.aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text))
  );
}

function brokerNamesMatch(left, right) {
  const leftText = String(left || "").trim();
  const rightText = String(right || "").trim();
  if (!leftText || !rightText) return false;
  const leftProfile = quoteBrokerProfile(leftText);
  const rightProfile = quoteBrokerProfile(rightText);
  if (leftProfile || rightProfile) {
    return (leftProfile?.name || leftText).toLowerCase() === (rightProfile?.name || rightText).toLowerCase();
  }
  return leftText.toLowerCase() === rightText.toLowerCase();
}

function normalizeQuoteRecord(record, fallback = {}) {
  if (!record || typeof record !== "object") return null;
  const brokerProfile = quoteBrokerProfile(record.broker || record.name || fallback.broker);
  const amount = normalizeMoneyAmount(record.amount ?? record.rate ?? record.quote ?? fallback.rate);
  if (!amount) return null;
  const broker = record.broker || record.name || brokerProfile?.name || fallback.broker || "Unknown broker";
  const hasContactEmail = Object.prototype.hasOwnProperty.call(record, "contactEmail") ||
    Object.prototype.hasOwnProperty.call(record, "email");
  const contactEmail = hasContactEmail
    ? record.contactEmail || record.email || ""
    : brokerProfile?.email || "";
  const normalized = {
    broker: brokerProfile?.name || normalizeBrokerName(broker),
    amount,
    currency: record.currency || "USD",
    rate: record.rate || record.quote || formatMoney(amount, record.currency || "USD"),
    service: record.service || record.mode || record.note || fallback.service || "",
    contactEmail,
    quotedAt: record.quotedAt || record.reviewedAt || fallback.reviewedAt || "",
    source: record.source || fallback.source || "Gmail",
    evidence: unique([
      ...(Array.isArray(record.evidence) ? record.evidence.map(quoteEvidenceText) : [quoteEvidenceText(record.evidence)]),
      quoteEvidenceText(fallback.evidence),
    ].filter(Boolean)).slice(0, 3),
  };
  const inferredCategory = quoteCategory(normalized);
  const providedCategory = record.category || record.type || "";
  return {
    ...normalized,
    category: inferredCategory === "pickup-delivery" ? inferredCategory : providedCategory || inferredCategory,
  };
}

function quoteCategory(quote) {
  const directText = [
    quote?.broker,
    quote?.service,
    quote?.rate,
  ].filter(Boolean).join(" ").toLowerCase();
  const text = [
    quote?.broker,
    quote?.service,
    quote?.rate,
    ...(Array.isArray(quote?.evidence) ? quote.evidence : [quote?.evidence]),
  ].filter(Boolean).join(" ").toLowerCase();

  if (/\b(cargosprint|payment|paid|receipt|amount paid|station fee|terminal fee|storage|last free|free day|demurrage)\b/.test(directText)) {
    return "station-cost";
  }
  if (/\b(not delivery|not pickup|customs bond|bond fee|7501|dut(?:y|ies)|clearance|customs|handling)\b/.test(directText)) {
    return "customs-cost";
  }
  if (/\b(air freight|air booking|air export|export operation|booking request|requested flight|awb number|destination|dap|ddp|per kg|\/kg|all in|via ath)\b/.test(directText)) {
    return "air-freight";
  }
  if (/\b(pickup|delivery|deliver|truck|trucker|straight|box truck|flatbed|hotshot|ltl|recover|recovery)\b/.test(directText)) {
    return "pickup-delivery";
  }
  if (/\b(cargosprint|payment|paid|receipt|amount paid|station fee|terminal fee|storage|last free|free day|demurrage)\b/.test(text)) {
    return "station-cost";
  }
  if (/\b(not delivery|not pickup|customs bond|bond fee|7501|dut(?:y|ies)|clearance|customs|handling)\b/.test(text)) {
    return "customs-cost";
  }
  if (/\b(air freight|air booking|air export|export operation|booking request|requested flight|awb number|destination|dap|ddp|per kg|\/kg|all in|via ath)\b/.test(text)) {
    return "air-freight";
  }
  if (/\b(pickup|delivery|deliver|truck|trucker|straight|box truck|flatbed|hotshot|ltl|recover|recovery)\b/.test(text)) {
    return "pickup-delivery";
  }
  return "unknown";
}

function quoteReviewBlockers(quote) {
  const text = [
    quote?.broker,
    quote?.service,
    quote?.rate,
    ...(Array.isArray(quote?.evidence) ? quote.evidence : [quote?.evidence]),
  ].filter(Boolean).join(" ").toLowerCase();
  const blockers = [];
  if (quote?.stale || quote?.actionable === false) blockers.push("quote superseded by newer operating facts");
  if (!contactEmailList(quote?.contactEmail).length) blockers.push("broker email missing");
  if (/\b(address ambiguous|ambiguous address|confirm(?:ing)? address|address (?:needs|must be) confirmed|address mismatch|wrong address)\b/.test(text)) {
    blockers.push("address needs confirmation");
  }
  return blockers;
}

function isActionablePickupQuote(quote) {
  return isPickupDeliveryQuote(quote) && quoteReviewBlockers(quote).length === 0;
}

function extractQuotesFromText(text, fallback = {}) {
  const source = String(text || "");
  if (!source.trim()) return [];
  const quotes = [];
  for (const profile of FREIGHT_BROKER_ALIASES) {
    for (const alias of profile.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b[^$\\n;,.]*(?:quote|rate|for|at|is|:)?[^$\\n;]*\\$\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, "ig");
      let match = pattern.exec(source);
      while (match) {
        const amount = normalizeMoneyAmount(match[1]);
        if (amount) {
          const evidence = unique([
            compactQuoteText(match[0], 140),
            compactQuoteText(fallback.evidence, 180),
          ].filter(Boolean));
          const quote = {
            broker: profile.name,
            amount,
            currency: "USD",
            rate: formatMoney(amount),
            service: compactQuoteText(match[0], 90),
            contactEmail: profile.email || "",
            quotedAt: fallback.reviewedAt || "",
            source: fallback.source || "Gmail",
            evidence,
          };
          quotes.push({
            ...quote,
            category: quoteCategory(quote),
          });
        }
        match = pattern.exec(source);
      }
    }
  }
  return quotes;
}

function dedupeQuotes(quotes) {
  const map = new Map();
  for (const quote of quotes.filter(Boolean)) {
    const key = `${quote.broker.toLowerCase()}:${quote.amount}`;
    if (!map.has(key)) {
      map.set(key, quote);
      continue;
    }
    const existing = map.get(key);
    const category = [existing.category, quote.category].includes("pickup-delivery")
      ? "pickup-delivery"
      : existing.category || quote.category;
    map.set(key, {
      ...existing,
      contactEmail: existing.contactEmail || quote.contactEmail,
      service: existing.service || quote.service,
      quotedAt: existing.quotedAt || quote.quotedAt,
      category,
      evidence: unique([...(existing.evidence || []), ...(quote.evidence || [])]).slice(0, 3),
    });
  }
  return [...map.values()].sort((a, b) => a.amount - b.amount || a.broker.localeCompare(b.broker));
}

function explicitRecommendedQuote(dispatchOverride, quotes) {
  const explicit = dispatchOverride?.recommendedAward || null;
  if (explicit?.broker) {
    const matchingQuote = quotes.find((quote) =>
      isPickupDeliveryQuote(quote) &&
      brokerNamesMatch(quote.broker, explicit.broker) &&
      (!Number.isFinite(Number(explicit.amount)) || Number(quote.amount) === Number(explicit.amount))
    );
    if (matchingQuote) return matchingQuote;

    const normalized = normalizeQuoteRecord(explicit, dispatchOverride);
    if (normalized && isPickupDeliveryQuote(normalized)) return normalized;
  }

  const recommendedBroker = dispatchOverride?.recommendedBroker;
  if (!recommendedBroker) return null;
  return quotes.find((quote) =>
    isPickupDeliveryQuote(quote) &&
    brokerNamesMatch(quote.broker, recommendedBroker)
  ) || null;
}

function isActionableBrokerSelection(value) {
  return Boolean(value) && !/\b(pending|quote confirmation|d\.?o\.?|delivery order|confirm(?:ation)?)\b/i.test(String(value));
}

function quoteAnalysisFromDispatch(dispatchOverride) {
  if (!dispatchOverride) return { quotes: [], recommended: null, override: null, status: "no-quotes" };
  const evidenceText = (dispatchOverride.evidence || [])
    .map((item) => item?.note || item)
    .filter(Boolean)
    .join(" ");
  const text = [
    dispatchOverride.rate,
    dispatchOverride.pickupPlan,
    dispatchOverride.deliveryPlan,
    dispatchOverride.nextAction,
    evidenceText,
  ].join(" ");
  const explicitQuotes = Array.isArray(dispatchOverride.quotes)
    ? dispatchOverride.quotes.map((quote) => normalizeQuoteRecord(quote, dispatchOverride))
    : [];
  const parsedQuotes = explicitQuotes.filter(Boolean).length
    ? []
    : extractQuotesFromText(text, {
        contactEmail: dispatchOverride.contactEmail,
        reviewedAt: dispatchOverride.reviewedAt || dispatchOverride.updatedAt,
        evidence: evidenceText,
      });
  const quotes = dedupeQuotes([...explicitQuotes, ...parsedQuotes]);
  const overrideBroker = [dispatchOverride.awardedBroker, dispatchOverride.selectedBroker]
    .find(isActionableBrokerSelection) ||
    (dispatchOverride.status === "freight-awarded" ? dispatchOverride.broker : "");
  const pickupQuotes = quotes.filter(isPickupDeliveryQuote);
  const actionablePickupQuotes = pickupQuotes.filter(isActionablePickupQuote);
  const overrideCandidate = overrideBroker
    ? quotes.find((quote) =>
      isActionablePickupQuote(quote) &&
      brokerNamesMatch(quote.broker, overrideBroker)
    ) ||
      normalizeQuoteRecord({
        broker: overrideBroker,
        rate: dispatchOverride.rate,
        contactEmail: dispatchOverride.contactEmail,
        evidence: dispatchOverride.evidence,
      }, dispatchOverride)
    : null;
  const override = overrideCandidate && isActionablePickupQuote(overrideCandidate) ? overrideCandidate : null;
  const explicitRecommended = explicitRecommendedQuote(dispatchOverride, quotes);
  const actionableExplicitRecommended = explicitRecommended && isActionablePickupQuote(explicitRecommended)
    ? explicitRecommended
    : null;
  const lowestCost = quotes[0] || null;
  const recommended = override || actionableExplicitRecommended || actionablePickupQuotes[0] || null;
  const skippedPickupQuotes = pickupQuotes.filter((quote) => !isActionablePickupQuote(quote));
  const status = override
    ? "override-selected"
    : actionableExplicitRecommended
      ? "recommended-pickup-quote"
      : actionablePickupQuotes.length
        ? skippedPickupQuotes.length
          ? "lowest-actionable-pickup-quote"
          : "lowest-pickup-quote"
        : pickupQuotes.length
          ? "pickup-quote-review-needed"
        : quotes.length
          ? "non-delivery-cost-only"
          : "no-quotes";
  return {
    quotes,
    recommended,
    override,
    lowestCost,
    status,
    summary: recommended
      ? `${override ? "Selected" : actionableExplicitRecommended ? "Recommended" : "Lowest actionable pickup"}: ${recommended.broker} ${recommended.rate || formatMoney(recommended.amount)}`
      : pickupQuotes.length
        ? `Review pickup quotes: ${pickupQuotes[0].broker} ${pickupQuotes[0].rate || formatMoney(pickupQuotes[0].amount)} needs ${quoteReviewBlockers(pickupQuotes[0]).join(" and ")}`
      : lowestCost
        ? `Lowest non-delivery cost: ${lowestCost.broker} ${lowestCost.rate || formatMoney(lowestCost.amount)}`
        : "",
  };
}

function factListText(items) {
  return (items || [])
    .map((item) =>
      typeof item === "string" ? item : `${item.label || ""} ${item.note || ""} ${item.summary || ""} ${item.detail || ""}`,
    )
    .filter(Boolean)
    .join(" ");
}

function sanitizeFreightOperatorText(value) {
  if (!value) return value;
  return String(value)
    .replace(/\bdo not mark delivered\b/gi, "keep delivery open until POD/completion proof arrives")
    .replace(/\bdo not mark\b/gi, "keep open");
}

function sanitizeFreightEvidence(items = []) {
  return items.map((item) => {
    if (typeof item === "string") return sanitizeFreightOperatorText(item);
    if (!item || typeof item !== "object") return item;
    return {
      ...item,
      note: sanitizeFreightOperatorText(item.note),
      summary: sanitizeFreightOperatorText(item.summary),
      detail: sanitizeFreightOperatorText(item.detail),
    };
  });
}

function driverDispatchOverride(dispatchOverride) {
  if (!dispatchOverride) return null;
  const text = [
    dispatchOverride.broker,
    dispatchOverride.rate,
    dispatchOverride.pickupPlan,
    dispatchOverride.deliveryPlan,
    dispatchOverride.brokerStatus,
    dispatchOverride.nextAction,
    dispatchOverride.contactEmail,
    factListText(dispatchOverride.evidence),
  ].join(" ");
  if (!/\bdriver@demo-freight\.example\b/i.test(text)) return null;
  if (!/\b(jeff(?:rey)?|chart22|alex\/casey|driver|tomorrow|pickup|delivery)\b/i.test(text)) return null;

  return {
    ...dispatchOverride,
    status: dispatchOverride.status || "driver-assigned-pod-needed",
    broker: "Casey Hart / driver",
    rate: /no new rate|not found|unknown/i.test(dispatchOverride.rate || "")
      ? "Agreed driver path; rate not found"
      : dispatchOverride.rate,
    pickupPlan: "Jordan sent the shipment to Casey Hart for pickup/delivery. Email Jeffrey; expect phone follow-up.",
    contactEmail: "contact-054@demo-freight.example",
    contactPhone: dispatchOverride.contactPhone && !/unknown|not found/i.test(dispatchOverride.contactPhone)
      ? dispatchOverride.contactPhone
      : "Responds by phone after email",
    brokerStatus: dispatchOverride.brokerStatus || "Casey Hart is the driver contact; Interdel remains customs only.",
    nextAction: "Email Jeffrey for pickup/delivery status and POD.",
    driverContact: {
      name: "Casey Hart",
      email: "contact-054@demo-freight.example",
      note: "Driver contact; usually responds by phone after email.",
    },
  };
}

function inferFreightBrokerLayer(shipment, dispatchOverride) {
  if (dispatchOverride) {
    const freightOverride = driverDispatchOverride(dispatchOverride) || dispatchOverride;
    if (hasCompletedGmailProof(shipment)) {
      const deliveryEvidence = [
        ...(shipment.emailValidation?.proof || []),
        ...(shipment.timeline || []).map((row) => ({
          label: row[1] || "Delivery proof",
          note: row[2] || row[1] || "",
        })),
      ].filter((item) => /deliver|pod|receiver|proof of delivery|status update/i.test(`${item.label || ""} ${item.note || ""}`));
      return {
        status: "freight-delivered-pod-found",
        broker: freightOverride.broker || "Delivery confirmed",
        rate: freightOverride.rate || "Unknown",
        pickupPlan: "Delivery confirmed by email status/POD proof.",
        contactEmail: freightOverride.contactEmail || "Unknown",
        contactPhone: freightOverride.contactPhone || "Unknown",
        evidence: deliveryEvidence.length ? deliveryEvidence : freightOverride.evidence || [],
        brokerStatus: "Delivered; no pickup or storage follow-up needed.",
        deliveryPlan: freightOverride.deliveryPlan || "",
        latestEventAt: shipment.emailValidation?.latestEventAt || freightOverride.latestEventAt || freightOverride.updatedAt || "",
        cargoAvailable: true,
        cargoReleased: true,
        nextAction: "No action; delivery/POD proof is complete.",
        confidence: "high",
        quotes: [],
        recommendedAward: null,
        driverContact: freightOverride.driverContact || null,
        quoteDecision: {
          status: "delivered",
          summary: "Delivery proof supersedes open pickup quotes or dispatch follow-up.",
        },
      };
    }
    const quoteAnalysis = quoteAnalysisFromDispatch(freightOverride);
    return {
      status: freightOverride.status || "freight-awarded",
      broker: freightOverride.broker,
      rate: freightOverride.rate || "Unknown",
      pickupPlan: sanitizeFreightOperatorText(freightOverride.pickupPlan) || "See broker thread",
      contactEmail: freightOverride.contactEmail || "Unknown",
      contactPhone: freightOverride.contactPhone || "Unknown",
      evidence: sanitizeFreightEvidence(freightOverride.evidence || []),
      brokerStatus: freightOverride.brokerStatus || "",
      deliveryPlan: sanitizeFreightOperatorText(freightOverride.deliveryPlan) || "",
      latestEventAt: freightOverride.latestEventAt || freightOverride.updatedAt || "",
      cargoAvailable: freightOverride.cargoAvailable,
      cargoReleased: freightOverride.cargoReleased,
      nextAction: sanitizeFreightOperatorText(freightOverride.nextAction) || "Monitor broker pickup and POD",
      confidence: "high",
      quotes: quoteAnalysis.quotes,
      recommendedAward: quoteAnalysis.recommended,
      driverContact: freightOverride.driverContact || null,
      quoteDecision: {
        status: quoteAnalysis.status,
        summary: quoteAnalysis.summary,
      },
    };
  }

  const evidenceText = [
    shipment.detail,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ]
    .join(" ")
    .trim();

  const inferredBroker =
    evidenceText.match(/FlitePak/i)?.[0] ||
    evidenceText.match(/Binational Logistics/i)?.[0] ||
    evidenceText.match(/SPARX/i)?.[0] ||
    null;

  if (/FlitePak/i.test(evidenceText)) {
    return {
      status: "freight-awarded",
      broker: "FlitePak",
      rate: "Not found",
      pickupPlan: "Pickup assigned in Gmail thread",
      contactEmail: "Not found",
      contactPhone: "Not found",
      evidence: [
        {
          label: "Dispatch found",
          note: "Gmail confirms Jordan assigned the pickup to FlitePak; rate was not found in the current snapshot.",
        },
      ],
      nextAction: "Confirm pickup/closeout and capture POD",
      confidence: "medium",
    };
  }

  if (inferredBroker) {
    return {
      status: /pickup|pick up|planned|forwarded inbound alert/i.test(evidenceText)
        ? "freight-requested"
        : "freight-unknown",
      broker: inferredBroker,
      rate: "Not found",
      pickupPlan: "See Gmail evidence",
      contactEmail: "Not found",
      contactPhone: "Not found",
      evidence: [
        {
          label: "Broker signal",
          note: "Gmail mentions the broker/carrier, but no awarded rate was found in the current snapshot.",
        },
      ],
      nextAction: "Confirm whether this broker was awarded and capture rate/POD",
      confidence: "medium",
    };
  }

  return {
    status: "freight-missing",
    broker: "Not found",
    rate: "Not found",
    pickupPlan: "Not found",
    contactEmail: "Not found",
    contactPhone: "Not found",
    evidence: [],
    nextAction: "Find broker quote/dispatch thread in Gmail",
    confidence: "low",
  };
}

function normalizeBrokerName(value) {
  return String(value || "").trim();
}

function isMissingBrokerName(value) {
  return /^(|unknown|not found|not found yet|n\/a)$/i.test(normalizeBrokerName(value));
}

function isThreadLabelOnly(value) {
  return /\/.*thread/i.test(normalizeBrokerName(value));
}

function knownCustomsBrokerName(value) {
  const broker = normalizeBrokerName(value);
  if (/Cedar Dispatch/i.test(broker)) return "Cedar Dispatch Customs Brokerage Inc";
  if (/Cornell/i.test(broker)) return "Cornell Group";
  if (/Worldwide Logistics|WWLL/i.test(broker)) return "Worldwide Logistics LTD";
  if (/CGI Logistics/i.test(broker)) return "CGI Logistics Inc.";
  if (/Sobel/i.test(broker)) return "Sobel Network Shipping Co.";
  if (/Atlantic Freight Brokers/i.test(broker)) return "Atlantic Freight Brokers";
  if (/Binational Logistics/i.test(broker)) return "Binational Logistics EP";
  if (/SPARX/i.test(broker)) return "SPARX Logistics Canada";
  if (/UPS.*Align|Align.*UPS|in-bond customs/i.test(broker)) return "UPS / Align in-bond customs";
  return null;
}

function customsEvidenceText(shipment) {
  return [
    shipment.tms?.tmsStatus,
    shipment.tms?.status,
    shipment.liveTracking?.customs,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.emailValidation?.events || []).map((item) => [
      item.from,
      item.to,
      item.subject,
      item.type,
      item.where,
      item.summary,
      item.evidence,
      item.nextAction,
    ].filter(Boolean).join(" ")),
    ...(shipment.eodFacts || []).map(factRowText),
  ].join(" ");
}

function customsContactEmailFromEvidence(text) {
  return contactEmailList(text).find((email) => !isInternalOperatorEmail(email)) || "";
}

function shipmentHasTmsCustomsRelease(shipment) {
  return /\b(?:customs\s*rel|customs\s*released|customs\s*cleared|295[-\s]*customs\s*rel)\b/i.test(
    [
      shipment.tms?.tmsStatus,
      shipment.tms?.status,
      shipment.tms?.nextTask,
      shipment.statusAudit?.evidence?.map((item) => `${item.status || ""} ${item.note || ""}`).join(" "),
      ...(shipment.timeline || []).map(timelineRowText),
      ...(shipment.eodFacts || []).map(factRowText),
    ].join(" "),
  );
}

function textLooksTmsOnlyCustomsRelease(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  const tmsSignal = /\b(?:tms|couriercloud|295[-\s]*(?:customs\s*)?rel|active\/?tms|customs\/tms|fresh tms|carrier tracking)\b/i.test(value);
  if (!tmsSignal) return false;
  return !/\b(?:gmail|email|thread|message|operator|broker|customs broker|cedar dispatch|cornell|interdel|worldwide|atlantic freight|abi|ace|98\s+released|attached|delivery order|d\/?o)\b/i.test(value);
}

function hasExplicitCustomsHoldText(text) {
  return /\b(customs[-\s]?hold|exam|examination|intensive|not released|not cleared|release denied|cannot pick|blocked by customs)\b|\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b.{0,160}\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b|\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b.{0,160}\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b|\barriv(?:e|ed)\s+i\.?t\.?\s+to\s+port\b/i.test(
    String(text || ""),
  );
}

function customsRecordHasExplicitHold(record) {
  const text = customsRecordEvidenceSegments(record).join(" ");
  return hasExplicitCustomsHoldText(text);
}

function explicitCustomsBlockerEvents(shipment) {
  const events = [
    ...(shipment?.emailValidation?.events || []),
    ...(shipment?.gmailEvents || []),
    ...(shipment?.events || []),
  ].filter(Boolean);
  return events.filter((event) => {
    if (String(event.status || "").toLowerCase() === "closed") return false;
    const text = [
      event.type,
      event.exceptionType,
      event.summary,
      event.evidence,
      event.nextAction,
      event.subject,
    ].filter(Boolean).join(" ");
    return event.exceptionType === "inbond-rejected" || hasExplicitCustomsHoldText(text);
  });
}

function explicitCustomsBlockerEvidence(shipment) {
  const eventEvidence = explicitCustomsBlockerEvents(shipment).map((event) =>
    [
      event.summary,
      event.evidence,
      event.messageId ? `Gmail message ${event.messageId}` : "",
    ].filter(Boolean).join(" ")
  );
  const brokerEvidence = (shipment?.customsBroker?.evidence || []).map(evidenceItemText);
  return unique([
    ...eventEvidence,
    shipment?.emailValidation?.summary,
    shipment?.emailValidation?.nextAction,
    shipment?.customsBroker?.nextAction,
    ...brokerEvidence,
  ]).slice(0, 6);
}

function customsBlockerSummary(shipment) {
  const event = explicitCustomsBlockerEvents(shipment)[0];
  const eventSummary = [event?.summary, event?.evidence].filter(Boolean).join(" ");
  return eventSummary ||
    shipment?.emailValidation?.summary ||
    explicitCustomsBlockerEvidence(shipment)[0] ||
    "Customs/inbond evidence is blocking pickup.";
}

function usableCustomsBlockerInstruction(value) {
  const text = String(value || "").trim();
  if (!text || /^no action\b/i.test(text)) return "";
  if (/\b(?:customs release\/?d\.?o\.? is confirmed|release\/?d\.?o\.? path clear|customs\/tms now shows release|continue (?:pickup|from station|pickup execution)|released and dispatch-ready)\b/i.test(text)) {
    return "";
  }
  return text;
}

function customsBlockerNextAction(shipment) {
  const event = explicitCustomsBlockerEvents(shipment)[0];
  return [
    event?.nextAction,
    shipment?.emailValidation?.nextAction,
    shipment?.customsBroker?.nextAction,
  ].map(usableCustomsBlockerInstruction).find(Boolean) ||
    "Resolve the customs/inbond blocker before sending a release packet or dispatching pickup.";
}

function shipmentHasExplicitCustomsBlocker(shipment) {
  if (!shipment) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus) || isCompletedShipment(shipment) || canonicalPodComplete(shipment)) {
    return false;
  }
  if (isCustomsHoldStatus(shipment.customsBroker?.status || "")) return true;
  const currentEmailConflict = shipment.emailValidation?.status === "email-conflict";
  if (customsLayerResolvesStaleGaps(shipment) && !currentEmailConflict) return false;
  if (customsRecordHasExplicitHold(shipment.customsBroker)) return true;
  if (explicitCustomsBlockerEvents(shipment).length) return true;
  if (currentEmailConflict) {
    return hasExplicitCustomsHoldText(
      [
        shipment.emailValidation?.summary,
        shipment.emailValidation?.nextAction,
        ...(shipment.emailValidation?.proof || []).map(evidenceItemText),
      ].join(" "),
    );
  }
  return false;
}

function customsRecordHasExplicitOpenRelease(record) {
  const text = customsRecordEvidenceSegments(record).join(" ");
  if (!text || customsRecordHasReleaseProof(record)) return false;
  return /\b(no|not|without|missing|pending|need(?:ed)?|requested|requesting|obtain|await(?:ing)?|waiting|find|confirm)\b.{0,80}\b(customs release|release\/?d\.?o\.?|release proof|customs proof|clearance|d\.?\/?o\.?|delivery order)\b|\b(customs release|release\/?d\.?o\.?|release proof|customs proof|clearance|d\.?\/?o\.?|delivery order)\b.{0,80}\b(no|not|without|missing|pending|need(?:ed)?|requested|requesting|obtain|await(?:ing)?|waiting|find|confirm)\b/i.test(
    text,
  );
}

function hasCustomsReleaseProofText(text) {
  const value = String(text || "");
  if (!value) return false;
  const negatedRelease = /\b(no|not|without|missing|pending|need(?:ed)?|requested|requesting|obtain|await(?:ing)?)\b.{0,50}\b(release|released|clearance|cleared|d\.?\/?o\.?|delivery order)\b|\b(release|released|clearance|cleared|d\.?\/?o\.?|delivery order)\b.{0,50}\b(no|not|without|missing|pending|need(?:ed)?|requested|requesting|obtain|await(?:ing)?)\b/i.test(value);
  const positiveRelease =
    /\b(customs (?:is )?(?:released|cleared)|customs\s*rel|cargo release results?\s*98\s*released|98\s+released|cbp release|release proof|released and attached|attached release|release pdf|release date update)\b/i.test(value) ||
    /\b(ace cargo release|ace[-\s_]*release|customs release attachment|customs-release-attachment-received)\b/i.test(value) ||
    /\b\d{3}-?\d{8}\s*ace\b|\bace\s*\d{2,}\s*\.pdf\b/i.test(value) ||
    /\b(see attached|attached|sent|received|scanned|provided)\b.{0,50}\b(d\.?\/?o\.?|delivery order)\b|\b(d\.?\/?o\.?|delivery order)\b.{0,50}\b(see attached|attached|sent|received|scanned|provided)\b/i.test(value);
  return positiveRelease && !negatedRelease;
}

function hasDirectCustomsReleaseProofText(text) {
  return !textLooksTmsOnlyCustomsRelease(text) && hasCustomsReleaseProofText(text);
}

function hasCustomsDeliveryOrderProofText(text) {
  const value = String(text || "");
  return /\b(see attached|attached|sent|received|scanned|provided)\b.{0,50}\b(d\.?\/?o\.?|delivery order)\b|\b(d\.?\/?o\.?|delivery order)\b.{0,50}\b(see attached|attached|sent|received|scanned|provided)\b/i.test(value);
}

function customsRecordEvidenceSegments(record) {
  if (!record) return [];
  return [
    record.status,
    record.summary,
    record.nextAction,
    record.releaseProof,
    ...(record.evidence || []).map((item) =>
      typeof item === "string"
        ? item
        : `${item.label || ""} ${item.note || ""} ${item.attachment || ""} ${item.filename || ""} ${item.mimeType || ""}`,
    ),
  ].filter(Boolean);
}

function customsRecordHasReleaseProof(record) {
  return customsRecordEvidenceSegments(record).some(hasDirectCustomsReleaseProofText);
}

function customsRecordHasDeliveryOrderProof(record) {
  return customsRecordEvidenceSegments(record)
    .filter((segment) => !textLooksTmsOnlyCustomsRelease(segment))
    .some(hasCustomsDeliveryOrderProofText);
}

function customsRecordHasBlockingDataIssue(record) {
  const text = customsRecordEvidenceSegments(record)
    .filter((segment) => !/^customs-release-attachment-received$/i.test(String(segment || "")))
    .join(" ");
  return /\b(?:ein|poa|cbp assigned number|importer number|shipper number)\b.{0,140}\b(?:mismatch|does not match|needed|required|requested|wrong|incorrect|belongs to|will check|no release proof)\b|\bno release proof found\b/i.test(text);
}

function statusFromClearance(clearanceStatus, evidenceText = "") {
  const status = String(clearanceStatus || "").toLowerCase();
  const text = `${clearanceStatus || ""} ${evidenceText || ""}`;
  if (/hold|exam|examination|cannot pick|could not happen/i.test(text)) return "customs-hold";
  const directReleaseProof = hasDirectCustomsReleaseProofText(text);
  if (status === "released" || status === "cleared") return directReleaseProof ? "customs-cleared" : "customs-unknown";
  if (status === "not-cleared" || status === "not cleared" || /not cleared|not-cleared|pending/i.test(text)) {
    return "customs-pending";
  }
  if (directReleaseProof || (!textLooksTmsOnlyCustomsRelease(text) && /\b(98\s+released|1c|1d)\b/i.test(text))) {
    return "customs-cleared";
  }
  return "customs-unknown";
}

function shipmentHasDirectCustomsReleaseProof(shipment) {
  return [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map(evidenceItemText),
    ...(shipment.emailValidation?.events || []).map(factRowText),
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.summary,
    shipment.customsBroker?.nextAction,
    ...(shipment.customsBroker?.evidence || []).map(evidenceItemText),
    ...(shipment.gmailEvents || []).map(factRowText),
    ...(shipment.events || []).map(factRowText),
    ...(shipment.eodFacts || []).map(factRowText),
    ...(shipment.statusAudit?.evidence || [])
      .map((item) => typeof item === "string" ? item : `${item.source || ""} ${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
  ]
    .filter(Boolean)
    .some(hasDirectCustomsReleaseProofText);
}

function isCustomsHoldStatus(status) {
  const normalized = String(status || "").toLowerCase();
  return normalized.startsWith("customs-hold") ||
    ["customs-pending-hold", "customs-hold-active-storage-accruing"].includes(normalized);
}

function isCustomsResolvedStatus(status) {
  return [
    "released",
    "cleared",
    "customs-cleared",
    "customs-cleared-do-received",
    "customs-cleared-do-received-payment-delivered",
    "customs-resolved-by-delivery-proof",
    "customs-release-attachment-received",
    "customs-released",
    "customs-released-do-received",
    "customs-release-package-payment-context",
    "payment-confirmed-casey-hart-awarded-ready-for-pickup",
    "release-do-received",
    "release-instructions-attached",
    "released-bill-arrived",
    "released-do-received",
    "released-do-pending-shipto-supplied",
    "release-do-payment-context",
    "release-retransmission-requested",
    "release-updated-waiting-station-release",
  ].includes(status);
}

function normalizedCustomsOverrideStatus(customsOverride) {
  const status = String(customsOverride?.status || "").toLowerCase();
  if (customsRecordHasExplicitHold(customsOverride)) return "customs-hold";
  if (customsRecordHasBlockingDataIssue(customsOverride)) return "customs-pending";
  if (isCustomsResolvedStatus(status)) return status;
  if (customsRecordHasReleaseProof(customsOverride)) {
    return customsRecordHasDeliveryOrderProof(customsOverride) ? "customs-cleared-do-received" : "customs-cleared";
  }
  if (/\b(customs[- ]?hold|exam|examination|intensive)\b/i.test(status)) return "customs-hold";
  if (/\b(customs[- ]?pending|not[- ]?cleared|release[- ]?pending|clearance[- ]?pending)\b/i.test(status)) {
    return "customs-pending";
  }
  return status || "customs-unknown";
}

function layeredStationArrivalNoticeProofText(shipment) {
  return [
    ...(shipment.freightBroker?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""} ${item.note || item.summary || ""}`,
    ),
    ...(shipment.customsBroker?.evidence || []),
    ...(shipment.eodFacts || []).map(factRowText),
    ...(shipment.statusAudit?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.source || ""} ${item.label || ""} ${item.note || ""}`,
    ),
    ...(shipment.timeline || []).map(timelineRowText),
  ].join(" ");
}

function hasLayeredStationArrivalNoticeProof(shipment) {
  const text = layeredStationArrivalNoticeProofText(shipment);
  if (/\b(no|without|missing)\s+(?:station\s+)?(?:arrival|noa|a\/?n|notice)\b/i.test(text)) return false;
  if (/\b(?:request(?:ed)?|need(?:ed)?)\s+(?:the\s+)?(?:station\s+)?(?:arrival notice|notice of arrival|NOA|A\/N)\b|\b(?:ask(?:ed)?|please)\b.{0,40}\b(?:send|provide|confirm on[- ]?hand)\b.{0,30}\b(?:arrival notice|notice of arrival|NOA|A\/N|on[- ]?hand)\b|\bsend\s+(?:the\s+)?(?:station\s+)?(?:arrival notice|notice of arrival|NOA|A\/N)\b/i.test(text)) return false;
  return /\b(station[-\s]?arrival|station arrival notice|arrival notice|notice of arrival|NOA|A\/N)\b.{0,160}\b(arriv|confirm|received|sent|attached|lists?|FIRMS|port code|last free|LFD|charges?)\b/i.test(
    text,
  );
}

function hasStationArrivalProof(shipment) {
  const emailStatus = shipment.emailValidation?.status || "";
  if (hasLayeredStationArrivalNoticeProof(shipment)) return true;
  if (emailHasStationArrivalNoticeProof(shipment)) return true;
  if (emailRejectsCurrentArrival(shipment)) return false;
  if (emailNeedsStationStatusCheck(shipment)) return false;
  return (
    emailConfirmsCurrentArrival(shipment) ||
    [
      "arrived-storage-payment-confirmed",
      "arrived-payment-do-received",
    ].includes(emailStatus)
  );
}

function hasUsefulOperationalEmailProof(shipment) {
  const emailStatus = shipment.emailValidation?.status || "";
  if (isFreightDeliveredWithPodStatus(emailStatus)) return true;
  if (emailStatus === "email-confirmed" || hasStationArrivalProof(shipment)) return true;
  if ([
    "prealert-no-arrival-no-release",
    "departed-onward-tracking",
    "departed-onward-tracking-prealert",
    "email-missing",
    "email-pending",
  ].includes(emailStatus)) return false;
  return Boolean(
    shipment.emailValidation?.proof?.length &&
      /\b(arriv|payment|release|d\/?o|delivery order|customs|quote|award|storage|inbond|hold|cost|pod|delivered|delivery)\b/i.test(
        emailStatus,
      )
  );
}

function emailNeedsStationStatusCheck(shipment) {
  const emailStatus = shipment.emailValidation?.status || "";
  const text = [
    emailStatus,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].join(" ");
  const explicitStationGap = [
    "prealert-no-arrival-no-release",
    "departed-onward-tracking",
    "departed-onward-tracking-prealert",
    "departed-tlv-ath-no-arrival-release",
    "prealert-firms-received-no-arrival-release",
    "prealert-dedicated-truck-requested-no-release",
    "arrival-confirmation-requested-no-station-proof",
    "station-arrival-notice-needed",
  ].includes(emailStatus) ||
    /\b(arrival confirmation requested|station arrival notice needed|no arrival|no[- ]?station|station proof|station confirmation|no on[- ]?hand|no availability|track carrier eta|track onward)\b/i.test(
      text,
    );

  return (
    explicitStationGap ||
    emailRejectsCurrentArrival(shipment) ||
    (!customsNeedsBrokerFollowup(shipment) && /\b(pre[- ]?alert|departed|departure)\b/i.test(text))
  );
}

function needsStationStatusDraft(shipment) {
  if (shipment.operationalException || operationalExceptionForShipment(shipment)) return false;
  if (hasStationArrivalProof(shipment)) return false;
  if (shipment.deliveryStatus === "out-for-delivery" || shipment.pickupStatus === "out-for-delivery" || shipment.opsState?.phase === "out-for-delivery") return false;
  if (shipment.trackingException?.type === "eta-passed-no-arrival-proof") return true;
  if (shipment.trackingException?.type === "available-by-tracking-email-needed") return true;
  if (stationEtaStatusCheck(shipment)) return true;
  if (shipment.pickupStatus === "airport-picked-up") return !hasUsefulOperationalEmailProof(shipment);
  if (shipment.arrivalStatus !== "arrived") return false;
  if (isCustomsControlledArrival(shipment) && !emailNeedsStationStatusCheck(shipment)) return false;

  return !hasUsefulOperationalEmailProof(shipment) || emailNeedsStationStatusCheck(shipment);
}

function layeredNextAction(shipment, freightBroker, customsBroker) {
  if (isFreightDeliveredStatus(freightBroker.status)) {
    return freightBroker.nextAction;
  }

  if (shipment.pickupStatus === "delivered" && hasPodProof(shipment)) {
    return "No action; delivery/POD proof is complete.";
  }

  if (
    (shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") &&
    !isCustomsResolvedStatus(customsBroker.status)
  ) {
    return customsBroker.nextAction || "Find customs release, broker reply, ABI, or hold status in Gmail.";
  }

  if (
    shipment.arrivalStatus === "arrived" &&
    isCustomsResolvedStatus(customsBroker.status) &&
    freightBroker?.nextAction
  ) {
    return freightBroker.nextAction;
  }

  if (shipment.arrivalStatus === "arrived" && isCustomsHoldStatus(customsBroker.status)) {
    return customsBroker.nextAction || shipment.nextAction;
  }

  return shipment.nextAction;
}

function activeCustomsBlockerText(shipment) {
  return [
    shipment.opsState?.phase,
    shipment.opsState?.label,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    shipment.customsBroker?.status,
    shipment.customsBroker?.nextAction,
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.customsBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean).join(" ");
}

function hasActiveCustomsBlocker(shipment) {
  return /\b(?:customs[-\s]?hold|customs\/government hold|government hold|customs exam|exam\/hold|1[-\s]?h\b|not released|no release yet|release pending|hold release|pickup is blocked by customs|cannot be picked up)\b/i.test(
    activeCustomsBlockerText(shipment),
  );
}

function customsNeedsBrokerFollowup(shipment) {
  if (shipment.pickupStatus === "delivered") return false;
  const activeCustomsBlocker = hasActiveCustomsBlocker(shipment);
  if (!activeCustomsBlocker && isFreightPodFollowupStatus(shipment.freightBroker?.status)) return false;
  if (
    !activeCustomsBlocker &&
    !(shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") &&
    !prearrivalCustomsFollowupCheck(shipment)
  ) return false;
  return !isCustomsResolvedStatus(shipment.customsBroker?.status || "customs-unknown");
}

function freightNeedsQuotePrep(shipment) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (shipment.arrivalStatus === "arrived") return false;
  const customsReady = isCustomsResolvedStatus(shipment.customsBroker?.status || "");
  const freightStatus = shipment.freightBroker?.status || "freight-missing";
  const quoteableFreight = isFreightMissingLikeStatus(freightStatus) || freightStatus === "freight-ready-for-pickup-quotes";
  return quoteableFreight && (customsReady || Boolean(prearrivalQuotePrepCheck(shipment)));
}

function prearrivalQuotePrepCheck(shipment, now = new Date()) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return null;
  if (shipment.arrivalStatus === "arrived") return null;
  if (!shipmentDeliveryAddress(shipment)) return null;
  if (shipment.emailValidation?.status === "email-conflict") return null;
  if (isCustomsHoldStatus(shipment.customsBroker?.status || "")) return null;
  const eta = parseTrackingDate(shipment.eta || shipment.liveTracking?.scheduledArrival || "", shipment.etaObservedAt || null);
  if (!eta) return null;
  const leadHours = Number(process.env.PQ_PREARRIVAL_QUOTE_LEAD_HOURS || 48);
  const leadMs = Math.max(1, leadHours) * 60 * 60 * 1000;
  const diffMs = eta.getTime() - now.getTime();
  if (diffMs < 0 || diffMs > leadMs) return null;
  return {
    eta,
    leadHours: Math.max(1, leadHours),
    detail: `ETA is within ${Math.max(1, leadHours)} hours; prepare broker quotes before station availability/release.`,
  };
}

function prearrivalCustomsFollowupCheck(shipment, now = new Date()) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return null;
  if (shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") return null;
  if (isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return null;
  const eta = parseTrackingDate(shipment.eta || shipment.liveTracking?.scheduledArrival || "", shipment.etaObservedAt || null);
  if (!eta) return null;
  const leadHours = Number(process.env.PQ_PREARRIVAL_CLEARANCE_LEAD_HOURS || 24);
  const leadMs = Math.max(1, leadHours) * 60 * 60 * 1000;
  const diffMs = eta.getTime() - now.getTime();
  if (diffMs < 0 || diffMs > leadMs) return null;
  return {
    eta,
    leadHours: Math.max(1, leadHours),
    detail: `ETA is within ${Math.max(1, leadHours)} hours; confirm customs release before arrival.`,
  };
}

function confidenceForCustoms(shipment, broker, status) {
  const evidenceText = customsEvidenceText(shipment);

  if (/customs? clearance|customs? broker|abi|customs? exam|customs? hold|please release|released and sent|release attached|\b1c\b|\b1d\b/i.test(evidenceText)) {
    return "high";
  }

  if (
    broker &&
    status !== "customs-unknown" &&
    hasUsefulOperationalEmailProof(shipment)
  ) {
    return "medium";
  }

  return "low";
}

function inferCustomsBrokerLayer(shipment, customsOverride) {
  if (customsOverride) {
    const overrideStatus = normalizedCustomsOverrideStatus(customsOverride);
    const hasExplicitOpenCustoms = customsRecordHasExplicitHold(customsOverride) ||
      customsRecordHasBlockingDataIssue(customsOverride);
    const status = overrideStatus;
    const releaseProven = isCustomsResolvedStatus(status);
    const evidence = customsOverride.evidence || [];
    return {
      status,
      broker: customsOverride.broker || customsOverride.brokerName || "Not found",
      confidence: releaseProven ? "high" : customsOverride.confidence || "medium",
      contactName: customsOverride.contactName || "Not found",
      contactEmail: customsOverride.contactEmail || customsOverride.email || "Not found",
      contactPhone: customsOverride.contactPhone || customsOverride.phone || "Not found",
      evidence,
      nextAction: releaseProven
        ? "Customs release/DO is confirmed; follow pickup execution and POD."
        : hasExplicitOpenCustoms
          ? customsOverride.nextAction || "Resolve the customs/inbond blocker before dispatching pickup."
          : customsOverride.nextAction || "Confirm customs status in the full Gmail thread",
    };
  }

  const legacyBroker = normalizeBrokerName(shipment.broker);
  const evidenceText = customsEvidenceText(shipment);
  const customsBroker = knownCustomsBrokerName(legacyBroker) || knownCustomsBrokerName(evidenceText);
  const customsContactEmail = customsContactEmailFromEvidence(evidenceText);

  if (!customsBroker || (isThreadLabelOnly(legacyBroker) && !knownCustomsBrokerName(evidenceText))) {
    if (shipment.pickupStatus === "delivered" && hasPodProof(shipment)) {
      return {
        status: "customs-resolved-by-delivery-proof",
        broker: "Not found",
        confidence: "medium",
        contactName: "Not found",
        contactEmail: "Not found",
        contactPhone: "Not found",
        evidence: [
          {
            label: "Delivery/POD proof",
            note: "Shipment has delivery/POD proof, so release is no longer an operator blocker.",
          },
        ],
        nextAction: "No action; delivery/POD proof is complete.",
      };
    }
    return {
      status: "customs-unknown",
      broker: "Not found",
      confidence: "low",
      contactName: "Not found",
      contactEmail: "Not found",
      contactPhone: "Not found",
      evidence: isThreadLabelOnly(legacyBroker)
        ? [
            {
              label: "Thread label only",
              note: `${legacyBroker} is useful email context, but it does not prove the customs broker.`,
            },
          ]
        : [],
      nextAction: "Find the customs release, entry, ABI, hold, or broker-reply thread",
    };
  }

  const status = statusFromClearance(shipment.clearanceStatus, customsEvidenceText(shipment));
  const confidence = confidenceForCustoms(shipment, customsBroker, status);

  return {
    status,
    broker: customsBroker,
    confidence,
    contactName: "Not found",
    contactEmail: customsContactEmail || "Not found",
    contactPhone: "Not found",
    evidence: [
      {
        label: confidence === "high" ? "Customs thread signal" : "Broker candidate",
        note:
          confidence === "high"
            ? "Gmail summary contains customs/release language tied to the shipment."
            : "Legacy enrichment names a known customs broker; exact full-thread customs proof should be confirmed.",
      },
    ],
    nextAction:
      isCustomsResolvedStatus(status)
        ? "Customs release/DO is confirmed; continue from station, pickup, and POD."
        : status === "customs-hold"
        ? "Follow broker on Customs hold/exam release"
        : confidence === "high"
        ? "Monitor broker clearance status and release"
        : "Confirm exact full-thread customs release before treating this as final",
  };
}

function normalizeCompletedCustomsLayer(shipment) {
  if (
    !isCompletedShipment(shipment) ||
    isCustomsHoldStatus(shipment.customsBroker?.status || "") ||
    isCustomsResolvedStatus(shipment.customsBroker?.status || "")
  ) {
    return shipment;
  }

  return {
    ...shipment,
    customsBroker: {
      ...(shipment.customsBroker || {}),
      status: "customs-resolved-by-delivery-proof",
      broker: shipment.customsBroker?.broker || "Not found",
      confidence: shipment.customsBroker?.confidence === "high" ? "high" : "medium",
      evidence: [
        ...(shipment.customsBroker?.evidence || []),
        {
          label: "Delivery/POD proof",
          note: "Shipment has delivery/POD proof, so release is no longer an operator blocker.",
        },
      ],
      nextAction: "No action; delivery/POD proof is complete.",
    },
  };
}

function emailCountKey(status) {
  if (status === "email-confirmed") return "emailConfirmed";
  if (status === "email-pending") return "emailPending";
  if (status === "email-conflict") return "emailConflict";
  return "emailMissing";
}

function isFreightMissingLikeStatus(status) {
  return [
    "freight-missing",
    "freight-requested",
    "freight-unknown",
  ].includes(status) || /\baudit-only\b|awb-mismatch|mismatch-paperwork/i.test(String(status || ""));
}

function isFreightAssigned(status) {
  return Boolean(status && !isFreightMissingLikeStatus(status));
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function gmailCoverageByAwb(coverageAudit = {}) {
  return new Map((coverageAudit.awbs || [])
    .map((row) => [normalizeAwb(row.awb), row])
    .filter(([awb]) => awb));
}

function gmailCoverageWarningText(row = {}) {
  if (!row.problem) return "";
  return `${row.awb}: ${row.reason || "Gmail coverage problem"}`;
}

function applyGmailCoverageFreshness(baseFreshness = {}, coverage = null) {
  if (!coverage) return baseFreshness || {};
  return {
    ...(baseFreshness || {}),
    gmailCoverageStatus: coverage.status || "",
    gmailCoverageProblem: Boolean(coverage.problem),
    gmailCoverageReason: coverage.problem ? coverage.reason || "" : "",
    gmailLatestReadMessageAt: coverage.latestReadMessageAt || "",
    gmailLatestProofMessageAt: coverage.latestProofMessageAt || "",
    staleSources: coverage.problem
      ? [...new Set([...(baseFreshness?.staleSources || []), "gmail"])]
      : (baseFreshness?.staleSources || []).filter((source) => source !== "gmail"),
  };
}

function attachGmailCoverageToTruthPacketShipment(shipment = {}, coverage = null) {
  if (!coverage) return shipment;
  const problemText = gmailCoverageWarningText(coverage);
  const coverageStamp = {
    awb: coverage.awb,
    status: coverage.status || "",
    problem: Boolean(coverage.problem),
    reason: coverage.reason || "",
    latestReadMessageAt: coverage.latestReadMessageAt || "",
    latestProofMessageAt: coverage.latestProofMessageAt || "",
    requiredEventTypes: coverage.requiredEventTypes || [],
    missingTopSearchThreadIds: (coverage.missingTopSearchThreadIds || []).slice(0, 3),
  };
  return {
    ...shipment,
    gmailCoverage: coverageStamp,
    sourceTruthWarnings: problemText
      ? [...new Set([...(shipment.sourceTruthWarnings || []), problemText])]
      : shipment.sourceTruthWarnings || [],
    truthPacket: shipment.truthPacket
      ? {
          ...shipment.truthPacket,
          freshness: applyGmailCoverageFreshness(shipment.truthPacket.freshness, coverageStamp),
        }
      : shipment.truthPacket,
    evidencePacket: shipment.evidencePacket
      ? {
          ...shipment.evidencePacket,
          freshness: applyGmailCoverageFreshness(shipment.evidencePacket.freshness, coverageStamp),
        }
      : shipment.evidencePacket,
  };
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writeJsonLines(filePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await fs.writeFile(filePath, body ? `${body}\n` : "");
}

function putAwb(map, awb, value) {
  if (!awb) return;
  map.set(awb, value);
  const normalized = normalizeAwb(awb);
  if (normalized) map.set(normalized, value);
}

function byAwb(records, key = "awb") {
  const map = new Map();
  for (const record of records || []) putAwb(map, record[key], record);
  return map;
}

function parseSnapshotMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function configuredGmailProofMaxLagMinutes() {
  const raw = Number(process.env.PQ_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES || "");
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES;
}

function sortedAwbKeys(rows = []) {
  return [...new Set(
    rows
      .map((row) => normalizeAwb(row?.trackingNumber || row?.awb || row?.id || row?.shipmentId || ""))
      .filter(Boolean),
  )].sort();
}

function canonicalSourceBundle({
  tmsData = {},
  sourceShipments = [],
  gmailProofData = {},
  previousTruthPacketsData = {},
  maxGmailProofLagMinutes = configuredGmailProofMaxLagMinutes(),
} = {}) {
  const tmsSnapshotTime = tmsData?.snapshotTime || "";
  const gmailProofSnapshotTime = gmailProofData?.snapshotTime || "";
  const previousTruthSnapshotTime = previousTruthPacketsData?.snapshotTime || "";
  const previousTruthWriter = String(previousTruthPacketsData?.writerVersion || "");
  const tmsSnapshotMs = parseSnapshotMs(tmsSnapshotTime);
  const gmailProofMs = parseSnapshotMs(gmailProofSnapshotTime);
  const previousTruthMs = parseSnapshotMs(previousTruthSnapshotTime);
  const tmsActiveAwbs = sortedAwbKeys(sourceShipments);
  const maxLagMs = Math.max(1, Number(maxGmailProofLagMinutes) || DEFAULT_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES) * 60 * 1000;
  const blockers = [];

  if (tmsActiveAwbs.length && !gmailProofMs) {
    blockers.push({
      type: "missing-gmail-proof-snapshot-time",
      message: "Fresh TMS inventory cannot publish active canonical truth without a timestamped Gmail proof snapshot.",
    });
  }
  if (tmsActiveAwbs.length && tmsSnapshotMs && gmailProofMs && tmsSnapshotMs - gmailProofMs > maxLagMs) {
    blockers.push({
      type: "gmail-proof-stale-for-tms-inventory",
      message: "Gmail proof snapshot is too old for the TMS inventory being reduced.",
      maxLagMinutes: Math.round(maxLagMs / 60000),
    });
  }
  if (
    gmailProofMs &&
    previousTruthMs > gmailProofMs &&
    /\+(?:manual-current-gmail-truth|gmail-direct)/.test(previousTruthWriter)
  ) {
    blockers.push({
      type: "gmail-proof-older-than-existing-canonical-truth",
      message: "Existing Gmail-direct/manual-current canonical truth is newer than the Gmail proof input.",
    });
  }

  return {
    status: blockers.length ? "blocked" : "current",
    blockers,
    sources: {
      tms: {
        snapshotTime: tmsSnapshotTime,
        activeAwbs: tmsActiveAwbs,
        activeAwbCount: tmsActiveAwbs.length,
      },
      gmailProof: {
        snapshotTime: gmailProofSnapshotTime,
        proofCount: Array.isArray(gmailProofData?.proofs) ? gmailProofData.proofs.length : 0,
        maxLagMinutes: Math.round(maxLagMs / 60000),
      },
      previousTruth: {
        snapshotTime: previousTruthSnapshotTime,
        writerVersion: previousTruthWriter,
      },
    },
  };
}

function canonicalSourceBundleBlockerMessage(bundle = {}) {
  const tms = bundle.sources?.tms || {};
  const gmail = bundle.sources?.gmailProof || {};
  const previous = bundle.sources?.previousTruth || {};
  const blockerTypes = (bundle.blockers || []).map((item) => item.type).filter(Boolean).join(",");
  return [
    "Canonical source bundle blocked.",
    `blockers=${blockerTypes || "unknown"}`,
    `tmsSnapshotTime=${tms.snapshotTime || "missing"}`,
    `tmsActiveAwbCount=${tms.activeAwbCount || 0}`,
    `gmailProofSnapshotTime=${gmail.snapshotTime || "missing"}`,
    `previousTruthSnapshotTime=${previous.snapshotTime || "missing"}`,
    `previousTruthWriter=${previous.writerVersion || "missing"}`,
    "Refresh hosted/current Gmail proof before rebuilding active canonical shipment truth.",
  ].join(" ");
}

function assertCanonicalSourceBundleCoherent(bundle = {}) {
  if (!bundle || bundle.status !== "blocked") return bundle;
  const error = new Error(canonicalSourceBundleBlockerMessage(bundle));
  error.code = "CANONICAL_SOURCE_BUNDLE_BLOCKED";
  error.bundle = bundle;
  throw error;
}

function mergeProofArrays(left = [], right = []) {
  const byKey = new Map();
  for (const item of [...(left || []), ...(right || [])].filter(Boolean)) {
    const key = [
      item.id,
      item.type,
      item.label,
      item.summary || item.note || item.evidence,
      item.threadId,
      item.messageId,
      item.at,
      item.filename,
    ].filter(Boolean).join("|") || JSON.stringify(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function mergeGmailProofRecord(left = {}, right = {}) {
  const leftEvents = [
    ...(left.historicalEvents || []),
    ...(left.events || []),
    ...(left.emailValidation?.events || []),
  ];
  const rightEvents = [
    ...(right.historicalEvents || []),
    ...(right.events || []),
    ...(right.emailValidation?.events || []),
  ];
  const leftProof = [
    ...(left.historicalProof || []),
    ...(left.proof || []),
    ...(left.emailValidation?.proof || []),
  ];
  const rightProof = [
    ...(right.historicalProof || []),
    ...(right.proof || []),
    ...(right.emailValidation?.proof || []),
  ];
  const events = mergeProofArrays(leftEvents, rightEvents);
  const proof = mergeProofArrays(leftProof, rightProof);
  const latestEventAt = [
    left.latestEventAt,
    right.latestEventAt,
    ...events.map((event) => event.at),
    ...proof.map((item) => item.at),
  ].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || "";
  const summary = [
    left.summary,
    right.summary,
    left.emailValidation?.summary,
    right.emailValidation?.summary,
  ].filter(Boolean).join(" ");
  return {
    ...left,
    ...right,
    awb: right.awb || left.awb,
    normalizedAwb: normalizeAwb(right.awb || left.awb || right.normalizedAwb || left.normalizedAwb),
    latestEventAt,
    summary,
    historicalEvents: events,
    events,
    historicalProof: proof,
    proof,
    emailValidation: {
      ...(left.emailValidation || {}),
      ...(right.emailValidation || {}),
      summary,
      latestEventAt,
      events,
      proof,
    },
  };
}

function gmailProofMapByAwb(records = []) {
  const map = new Map();
  for (const record of records || []) {
    const key = normalizeAwb(record.awb || record.normalizedAwb);
    if (!key) continue;
    const merged = map.has(key) ? mergeGmailProofRecord(map.get(key), record) : record;
    putAwb(map, record.awb || key, merged);
  }
  return map;
}

function canonicalRecordsByAwb(records = []) {
  const map = new Map();
  for (const record of records || []) putAwb(map, record.awb, record);
  return map;
}

function canonicalGateStatus(record, gateName) {
  return String(record?.gates?.[gateName]?.status || "").toLowerCase();
}

function canonicalGateDone(record, gateName, statuses) {
  return statuses.includes(canonicalGateStatus(record, gateName));
}

function canonicalRiskPriority(record) {
  const level = String(record?.operationalRisk?.level || "").toLowerCase();
  if (["critical", "high"].includes(level)) return "high";
  if (["medium", "elevated"].includes(level)) return "medium";
  return "normal";
}

function canonicalStatePayload(record) {
  if (!record) return null;
  return {
    source: "canonical-shipment-pipeline",
    phase: record.phase || "",
    label: record.currentState || record.phase || "",
    summary: record.currentState || record.phase || "",
    nextAction: record.nextAction || "",
    gates: record.gates || {},
    exceptions: record.exceptions || [],
    risk: record.operationalRisk || null,
    priority: canonicalRiskPriority(record),
    confidence: record.confidence || "",
    evidence: (record.evidence || []).slice(0, 8),
    updatedAt: record.updatedAt || "",
  };
}

function canonicalPodComplete(recordOrShipment) {
  const record = recordOrShipment?.canonicalState || recordOrShipment?.opsState || recordOrShipment?.canonicalRecord || recordOrShipment;
  const phase = String(record?.phase || "").toLowerCase();
  return (
    ["delivered", "completed"].includes(phase) ||
    canonicalGateDone(record, "pod", ["done", "received", "pod-found", "found"])
  );
}

function canonicalGateStatusFromState(state, gateName) {
  return String(state?.gates?.[gateName]?.status || "").toLowerCase();
}

function canonicalGateStatusIn(state, gateName, statuses) {
  return statuses.includes(canonicalGateStatusFromState(state, gateName));
}

function latestIsoTimestamp(...values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b || "") - Date.parse(a || ""))
    .at(0) || "";
}

function canonicalTerminalAt(state = {}) {
  const phase = String(state.phase || "").toLowerCase();
  if (
    !["delivered", "completed", "closeout"].includes(phase) &&
    !canonicalGateStatusIn(state, "pod", ["done", "received", "pod-found", "found"]) &&
    !canonicalGateStatusIn(state, "delivery", ["delivered", "done", "completed"])
  ) {
    return "";
  }
  return latestIsoTimestamp(
    state.gates?.pod?.at,
    state.gates?.delivery?.at,
    state.updatedAt,
  );
}

function canonicalPublicStatuses(shipment = {}, canonicalState = {}) {
  const phase = String(canonicalState.phase || "").toLowerCase();
  const arrivalDone = canonicalGateStatusIn(canonicalState, "arrival", ["done", "arrived", "available", "on-hand", "inferred"]);
  const arrivalBlocked = canonicalGateStatusIn(canonicalState, "arrival", ["blocked", "incomplete", "partial"]);
  const customsDone = canonicalGateStatusIn(canonicalState, "customs", ["done", "released", "cleared", "customs-cleared", "unknown-offline"]);
  const customsBlocked = canonicalGateStatusIn(canonicalState, "customs", ["blocked", "customs-hold", "hold", "exam-hold"]) ||
    ["customs-hold", "release-needed"].includes(phase);
  const pickupDone = canonicalGateStatusIn(canonicalState, "pickup", ["done", "picked-up", "loaded", "recovered", "inferred"]) ||
    ["pod-needed", "out-for-delivery", "delivered-pod-pending", "delivered", "completed"].includes(phase);
  const pickupBlocked = canonicalGateStatusIn(canonicalState, "pickup", ["blocked", "exception", "driver-onsite", "onsite"]) ||
    ["pickup-blocked", "driver-onsite", "pickup-onsite"].includes(phase);
  const deliveryDone = canonicalGateStatusIn(canonicalState, "delivery", ["done", "delivered", "completed"]) ||
    ["delivered-pod-pending", "delivered", "completed"].includes(phase);
  const outForDelivery = canonicalGateStatusIn(canonicalState, "delivery", ["out-for-delivery", "out for delivery", "ofd"]) ||
    phase === "out-for-delivery";
  const podDone = canonicalPodComplete(canonicalState);
  return {
    arrivalStatus: arrivalDone || pickupDone || deliveryDone || podDone
      ? "arrived"
      : arrivalBlocked
      ? "arrival-incomplete"
      : "not-arrived",
    clearanceStatus: customsDone || pickupDone || deliveryDone || podDone
      ? "released"
      : customsBlocked
      ? "not-cleared"
      : shipment.clearanceStatus || "pending",
    pickupStatus: podDone || deliveryDone
      ? "delivered"
      : outForDelivery
      ? "out-for-delivery"
      : pickupDone
      ? "airport-picked-up"
      : pickupBlocked
      ? canonicalGateStatusIn(canonicalState, "pickup", ["driver-onsite", "onsite"]) || ["driver-onsite", "pickup-onsite"].includes(phase)
        ? "driver-onsite"
        : "blocked"
      : canonicalGateStatusIn(canonicalState, "pickup", ["scheduled"])
      ? "scheduled"
      : shipment.pickupStatus || "pending",
    deliveryStatus: podDone || deliveryDone
      ? "delivered"
      : outForDelivery
      ? "out-for-delivery"
      : canonicalGateStatusIn(canonicalState, "delivery", ["scheduled"])
      ? "scheduled"
      : shipment.deliveryStatus || "pending",
    podStatus: podDone
      ? "pod-found"
      : deliveryDone
      ? "pod-pending"
      : shipment.pod?.status || "",
  };
}

function applyCanonicalControlState(shipment, record) {
  const canonicalState = canonicalStatePayload(record);
  if (!canonicalState) return shipment;
  const rawNextAction = canonicalState.nextAction || shipment.nextAction;
  const publicStatuses = canonicalPublicStatuses(shipment, canonicalState);
  const canonicalUpdatedAt = canonicalTerminalAt(canonicalState) || canonicalState.updatedAt || shipment.opsState?.updatedAt || "";
  const podDone = publicStatuses.podStatus === "pod-found";
  const resolvedExecutionNextAction = () => {
    const canonicalPhase = String(canonicalState.phase || "").toLowerCase();
    if (podDone) return "No action; POD is in memory.";
    if (["out-for-delivery", "delivered-pod-pending"].includes(canonicalPhase)) {
      return "Track delivery completion and collect POD.";
    }
    if (publicStatuses.deliveryStatus === "out-for-delivery" || publicStatuses.pickupStatus === "out-for-delivery") {
      return "Track delivery completion and collect POD.";
    }
    if (["airport-picked-up", "picked-up", "picked up"].includes(String(publicStatuses.pickupStatus || "").toLowerCase())) {
      return "Confirm final delivery and collect POD.";
    }
    if (publicStatuses.pickupStatus === "ready" || publicStatuses.arrivalStatus === "arrived") {
      return "Continue pickup execution and collect POD.";
    }
    return customsResolvedOperatorNote({
      ...shipment,
      clearanceStatus: "released",
      customsBroker: {
        ...(shipment.customsBroker || {}),
        status: "released",
      },
    });
  };
  const customsResolved = publicStatuses.clearanceStatus === "released";
  const nextAction = customsResolved && hasStaleCustomsGapText(rawNextAction)
    ? resolvedExecutionNextAction()
    : rawNextAction;
  const canonicalBlockers = [
    ...(canonicalState.exceptions || []).map((item) => item.summary || item.type || "").filter(Boolean),
  ];
  const opsState = {
    ...(shipment.opsState || {}),
    phase: canonicalState.phase || shipment.opsState?.phase || "",
    label: canonicalState.label || shipment.opsState?.label || "",
    summary: canonicalState.summary || shipment.opsState?.summary || "",
    nextAction,
    gates: canonicalState.gates,
    source: canonicalState.source,
    priority: canonicalState.priority || shipment.opsState?.priority || "normal",
    confidence: canonicalState.confidence || shipment.opsState?.confidence || shipment.statusAudit?.confidence || "",
    blockers: unique(canonicalBlockers),
    risk: canonicalState.risk || shipment.opsState?.risk || null,
    evidence: canonicalState.evidence?.length ? canonicalState.evidence : shipment.opsState?.evidence || [],
    updatedAt: canonicalUpdatedAt,
  };
  const emailValidation = {
    ...(shipment.emailValidation || {}),
    status: canonicalState.phase || shipment.emailValidation?.status || "",
    summary: canonicalState.summary || shipment.emailValidation?.summary || "",
    nextAction,
    proof: canonicalState.evidence?.length ? canonicalState.evidence : shipment.emailValidation?.proof || [],
    events: canonicalState.evidence?.length ? canonicalState.evidence : shipment.emailValidation?.events || [],
    latestEventAt: canonicalUpdatedAt || shipment.emailValidation?.latestEventAt || "",
    source: "canonical-shipment-pipeline",
  };
  const freightBroker = podDone
    ? {
        ...(shipment.freightBroker || {}),
        status: "freight-delivered-pod-found",
        brokerStatus: canonicalState.summary || "Delivered; POD is in memory.",
        nextAction: "No action; POD is in memory.",
      }
    : shipment.freightBroker;
  const customsBroker = publicStatuses.clearanceStatus === "not-cleared"
    ? {
        ...(shipment.customsBroker || {}),
        status: "customs-hold",
        nextAction,
      }
    : publicStatuses.clearanceStatus === "released"
    ? {
        ...(shipment.customsBroker || {}),
        status: "released",
        nextAction: podDone
          ? "No action; POD is in memory."
          : hasStaleCustomsGapText(shipment.customsBroker?.nextAction || "")
          ? resolvedExecutionNextAction()
          : shipment.customsBroker?.nextAction || nextAction || "",
      }
    : shipment.customsBroker;
  return {
    ...shipment,
    canonicalRecord: record,
    canonicalState,
    canonicalAuthority: true,
    currentState: canonicalState.summary || shipment.currentState || "",
    nextAction,
    emailValidation,
    freightBroker,
    customsBroker,
    arrivalStatus: publicStatuses.arrivalStatus,
    clearanceStatus: publicStatuses.clearanceStatus,
    pickupStatus: publicStatuses.pickupStatus,
    deliveryStatus: publicStatuses.deliveryStatus,
    completed: Boolean(shipment.completed || podDone || ["delivered", "completed"].includes(String(canonicalState.phase || "").toLowerCase())),
    pod: podDone
      ? {
          ...(shipment.pod || {}),
          status: "pod-found",
          deliveredAt: canonicalTerminalAt(canonicalState) || shipment.pod?.deliveredAt || "",
          evidence: canonicalState.gates?.pod?.evidence || canonicalState.summary || "",
        }
      : shipment.pod,
    opsState,
    statusAudit: {
      ...(shipment.statusAudit || {}),
      confidence: canonicalState.confidence || shipment.statusAudit?.confidence || "medium",
      canonicalSource: canonicalState.source,
    },
  };
}

function recordsByAwb(records, key = "awb") {
  const map = new Map();
  for (const record of records || []) {
    const awb = record?.[key];
    if (!awb) continue;
    const keys = unique([awb, normalizeAwb(awb)]);
    for (const lookupKey of keys) {
      if (!map.has(lookupKey)) map.set(lookupKey, []);
      map.get(lookupKey).push(record);
    }
  }
  return map;
}

function firstText(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function inferAirline(tmsShipment, metadata) {
  if (metadata?.airline) return metadata.airline;

  const awbPrefix = normalizeAwb(tmsShipment?.trackingNumber).slice(0, 3);
  if (awbPrefix === "016") return "United";
  if (awbPrefix === "114") return "EL AL";
  if (awbPrefix === "014") return "Air Canada";
  if (awbPrefix === "700") return "Challenge";
  if (awbPrefix === "932") return "Virgin";

  const flight = `${tmsShipment?.dep || ""} ${tmsShipment?.arr || ""}`;
  if (/\bUA/i.test(flight)) return "United";
  if (/\bLY/i.test(flight)) return "EL AL";
  if (/\bAC/i.test(flight)) return "Air Canada";
  if (/\b5C/i.test(flight)) return "Challenge";
  return "Carrier";
}

function buildDelivery(tmsShipment) {
  const lines = unique([
    tmsShipment?.deliveryAddress1,
    tmsShipment?.deliveryAddress2,
    tmsShipment?.deliveryCity,
    tmsShipment?.deliveryState,
    tmsShipment?.deliveryCountry,
  ]);

  return {
    consignee: tmsShipment?.consigneeCompany || "Unknown consignee",
    address1: tmsShipment?.deliveryAddress1 || "",
    address2: tmsShipment?.deliveryAddress2 || "",
    city: tmsShipment?.deliveryCity || "",
    state: tmsShipment?.deliveryState || "",
    country: tmsShipment?.deliveryCountry || "",
    airport: tmsShipment?.deliveryAirport || tmsShipment?.dest || "",
    courier: tmsShipment?.deliveryCourier || "",
    contactEmail: tmsShipment?.consigneeEmail || "",
    contactPhone: tmsShipment?.consigneePhone || "",
    fullAddress: lines.join(", "),
  };
}

function flightCandidatesFromTmsShipment(tmsShipment = {}) {
  const fields = [
    tmsShipment.dep,
    tmsShipment.arr,
    tmsShipment.flight,
    tmsShipment.flights,
    tmsShipment.route,
    tmsShipment.routing,
    tmsShipment.nextTask,
  ].filter(Boolean);
  const seen = new Set();
  const flights = [];
  for (const value of fields) {
    for (const match of String(value).matchAll(/\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{2,4})([A-Z])?\b/gi)) {
      const sourceSegment = String(match[0] || "").toUpperCase().replace(/\s+/g, "");
      if (/TRUCK/i.test(sourceSegment)) continue;
      const flight = `${match[1]}${match[2]}`.toUpperCase();
      if (!flight || seen.has(flight)) continue;
      seen.add(flight);
      flights.push({
        flight,
        sourceSegment,
        sourceField: String(value || ""),
        suffix: match[3] || "",
      });
    }
  }
  return flights;
}

function buildFlightDetails(tmsShipment = {}) {
  const flights = flightCandidatesFromTmsShipment(tmsShipment);
  const tmsFlight = firstText([tmsShipment.dep, tmsShipment.arr].filter(Boolean).join(" "));
  const route = firstText([tmsShipment.orig, tmsShipment.dest].filter(Boolean).join("-"));
  const etaHint = firstText(tmsShipment.nextTask, tmsShipment.delTime, tmsShipment.deliveryActualArrivalDate);
  const primaryFlight = flights[0]?.flight || firstText(tmsShipment.flight, tmsShipment.flightNumber, tmsFlight, route);
  return {
    flights,
    primaryFlight,
    tmsFlight,
    departureLeg: tmsShipment.dep || "",
    arrivalLeg: tmsShipment.arr || "",
    route,
    origin: tmsShipment.orig || tmsShipment.pickupAirport || "",
    destination: tmsShipment.dest || tmsShipment.deliveryAirport || "",
    etaHint,
    recoveryHint: etaHint,
    source: "tms-detail",
  };
}

function buildShipper(tmsShipment = {}) {
  const lines = unique([
    tmsShipment.pickupAddress1,
    tmsShipment.pickupAddress2,
    tmsShipment.pickupAddress3,
    tmsShipment.pickupCity,
    tmsShipment.pickupState,
    tmsShipment.pickupCountry,
  ]);
  return {
    name: firstText(tmsShipment.pickupCompany, tmsShipment.shipperName),
    contactName: tmsShipment.shipperName || "",
    phone: tmsShipment.shipperPhone || tmsShipment.pickupPhone || "",
    email: tmsShipment.shipperEmail || tmsShipment.pickupEmail || "",
    address1: tmsShipment.pickupAddress1 || "",
    address2: tmsShipment.pickupAddress2 || "",
    city: tmsShipment.pickupCity || "",
    state: tmsShipment.pickupState || "",
    country: tmsShipment.pickupCountry || "",
    airport: tmsShipment.pickupAirport || tmsShipment.orig || "",
    fullAddress: lines.join(", "),
  };
}

function buildBaseEvidence(tmsShipment, gmailProof) {
  const evidence = [
    {
      source: "TMS",
      label: "TMS open shipment",
      note: unique([
        tmsShipment?.tmsStatus || tmsShipment?.status,
        tmsShipment?.nextTask,
        `${tmsShipment?.orig || ""} to ${tmsShipment?.dest || ""}`.trim(),
      ]).join(" · "),
    },
  ];

  const emailValidation = gmailProof?.emailValidation;
  if (emailValidation?.summary || emailValidation?.proof?.length) {
    evidence.push({
      source: "Gmail",
      label: "Email proof snapshot",
      note: emailValidation.summary || "Gmail thread evidence is attached.",
    });
  }

  return evidence;
}

function tmsArrivalFact(tmsShipment = {}, tmsSnapshotTime = "") {
  const movement = tmsMovementStatus(tmsShipment);
  if (movement.arrivalStatus !== "arrived") return null;
  const tmsStatus = firstText(tmsShipment.tmsStatus, tmsShipment.status);
  const nextTask = firstText(tmsShipment.nextTask, tmsShipment.delTime);
  const station = firstText(tmsShipment.deliveryAirport, tmsShipment.dest);
  const route = firstText([tmsShipment.orig, tmsShipment.dest].filter(Boolean).join("-"));
  const evidence = unique([`TMS ${tmsStatus}`, nextTask, station ? `station ${station}` : "", route].filter(Boolean)).join(" · ");
  return {
    type: "carrier-arrival-confirmed",
    label: "TMS destination arrival",
    summary: `TMS destination arrival confirmed: ${[tmsStatus, nextTask].filter(Boolean).join("; ") || "destination arrival"}.`,
    evidence,
    at: tmsSnapshotTime,
    source: "tms-detail",
    confidence: "high",
  };
}

function tmsHasDirectCustomsReleaseProof(tmsShipment = {}) {
  return Boolean(firstText(
    tmsShipment.customsActualRelease,
    tmsShipment.customsReleaseActual,
    tmsShipment.customsReleaseDate,
    tmsShipment.actualCustomsReleaseDate,
    tmsShipment.tms?.customsActualRelease,
    tmsShipment.tms?.customsReleaseActual,
    tmsShipment.tms?.customsReleaseDate,
    tmsShipment.tms?.actualCustomsReleaseDate,
  ));
}

function tmsMovementStatus(tmsShipment) {
  const statusText = `${tmsShipment?.tmsStatus || ""} ${tmsShipment?.status || ""} ${tmsShipment?.nextTask || ""}`;
  if (hasTmsCompletionEvidence(tmsShipment) || /\bdelivered\b|\bpod\b/i.test(statusText)) {
    return { arrivalStatus: "arrived", pickupStatus: "delivered", deliveryStatus: "delivered" };
  }
  if (tmsStatusCode(tmsShipment) >= 320 || /\b(?:320-OUT FOR DEL|OUT FOR DEL|OUT FOR DELIVERY|OFD)\b/i.test(statusText)) {
    return { arrivalStatus: "arrived", pickupStatus: "out-for-delivery", deliveryStatus: "out-for-delivery" };
  }
  if (tmsStatusCode(tmsShipment) >= 295 || /\b(?:295-CUSTOMS REL|CUSTOMS REL|CUSTOMS RELEASED|RELEASED)\b/i.test(statusText)) {
    const releaseOrAvailabilityProof =
      tmsHasDirectCustomsReleaseProof(tmsShipment) ||
      /\b(?:ready\s*for\s*pickup|available|on[-\s]?hand)\b/i.test(statusText);
    return { arrivalStatus: "arrived", pickupStatus: releaseOrAvailabilityProof ? "ready" : "pending", deliveryStatus: "pending" };
  }
  if (tmsStatusCode(tmsShipment) >= 280 || /arr\s*@\s*dest|arrived?\s+at\s+dest/i.test(statusText)) {
    return { arrivalStatus: "arrived", pickupStatus: "pending", deliveryStatus: "pending" };
  }
  return { arrivalStatus: "not-arrived", pickupStatus: "pending", deliveryStatus: "pending" };
}

function buildBaseShipment(tmsShipment, metadata, gmailProof, tmsSnapshotTime = "") {
  const awb = tmsShipment?.trackingNumber || metadata?.awb || `Missing AWB - order ${tmsShipment?.order || tmsShipment?.shipmentNumber || "unknown"}`;
  const delivery = buildDelivery(tmsShipment);
  const flightDetails = buildFlightDetails(tmsShipment);
  const shipper = buildShipper(tmsShipment);
  const emailValidation = gmailProof?.emailValidation || {
    status: "email-missing",
    summary: "No matching Gmail proof snapshot has been attached to this open TMS shipment yet.",
    nextAction: "Search Gmail by AWB, client, consignee, station, and document names.",
    proof: [],
  };
  const tmsEta = firstText(tmsShipment?.nextTask, tmsShipment?.delTime);
  const station = firstText(metadata?.station, tmsShipment?.deliveryAirport, tmsShipment?.dest);
  const tmsMovement = tmsMovementStatus(tmsShipment);
  const tmsArrival = tmsArrivalFact(tmsShipment, tmsSnapshotTime);

  return {
    id: String(firstText(metadata?.id, tmsShipment?.order, tmsShipment?.shipmentNumber, awb)),
    awb,
    client: firstText(metadata?.client, tmsShipment?.pickupFrom, tmsShipment?.pickupCompany, tmsShipment?.customerName, "Unknown client"),
    station,
    airline: inferAirline(tmsShipment, metadata),
    eta: tmsEta || "No ETA from TMS",
    // Relative TMS task labels ("ARRIVE MON 10:15") only mean anything relative
    // to the snapshot that observed them; the reducer refuses to resolve a
    // weekday label without this anchor (INC-2026-07-05-ETA-SELF-FEEDBACK).
    etaObservedAt: tmsEta ? tmsSnapshotTime || "" : "",
    arrivalStatus: tmsMovement.arrivalStatus,
    deliveryStatus: tmsMovement.deliveryStatus,
    clearanceStatus: tmsHasDirectCustomsReleaseProof(tmsShipment)
      ? "released"
      : "unknown",
    pickupStatus: tmsMovement.pickupStatus,
    attention: true,
    nextAction: emailValidation.nextAction || (station ? `Track arrival at ${station}` : "Review shipment"),
    detail: emailValidation.summary || "Built from TMS; waiting for tracking and Gmail proof layers.",
    broker: metadata?.legacyBrokerLabel || "Not found",
    handler: metadata?.handler || `${inferAirline(tmsShipment, metadata)} ${station}`.trim(),
    stationEmail: metadata?.stationEmail || "Confirm station import desk",
    stationPhone: metadata?.stationPhone || "Confirm station line",
    origin: flightDetails.origin,
    destination: flightDetails.destination,
    route: flightDetails.route,
    flightDetails,
    shipper,
    commercial: {
      customerCharge: tmsShipment?.customerCharge || tmsShipment?.billingTotal || "",
      billingTotal: tmsShipment?.billingTotal || tmsShipment?.customerCharge || "",
      vendorCost: tmsShipment?.vendorCost || tmsShipment?.costTotal || "",
      costTotal: tmsShipment?.costTotal || tmsShipment?.vendorCost || "",
      source: "tms-detail",
    },
    sources: unique(["TMS", ...(metadata?.legacySources || []), emailValidation.summary ? "Gmail" : ""]),
    timeline: uniqueTimeline([
      [
        "TMS",
        tmsShipment?.tmsStatus || tmsShipment?.status || "Open",
        unique([tmsShipment?.nextTask, `${tmsShipment?.orig || ""} to ${tmsShipment?.dest || ""}`.trim()]).join(" · "),
      ],
      ...(gmailProof?.timeline || []),
    ]),
    delivery,
    tms: {
      shipmentGuid: tmsShipment?.shipmentGuid || null,
      orderLink: tmsShipment?.orderLink || null,
      status: tmsShipment?.status || tmsShipment?.tmsStatus || null,
      tmsStatus: tmsShipment?.tmsStatus || tmsShipment?.status || null,
      statusDescription: tmsShipment?.statusDescription || null,
      nextTask: tmsShipment?.nextTask || null,
      snapshotTime: tmsSnapshotTime || null,
      source: "tms-detail",
      order: tmsShipment?.order || tmsShipment?.shipmentNumber || null,
      customerName: tmsShipment?.customerName || null,
      pieces: tmsShipment?.pieces || null,
      weight: tmsShipment?.weight || null,
      weightUom: tmsShipment?.weightUom || null,
      reference: tmsShipment?.reference || null,
      serviceName: tmsShipment?.serviceName || tmsShipment?.service || null,
      dep: tmsShipment?.dep || null,
      arr: tmsShipment?.arr || null,
      origin: tmsShipment?.orig || tmsShipment?.pickupAirport || null,
      destination: tmsShipment?.dest || tmsShipment?.deliveryAirport || null,
      route: flightDetails.route || null,
      tmsFlight: flightDetails.tmsFlight || null,
      flight: flightDetails.primaryFlight || null,
      flightNumber: flightDetails.primaryFlight || null,
      contents: tmsShipment?.contents || null,
      commodity: tmsShipment?.commodity || tmsShipment?.contents || null,
      value: tmsShipment?.value || null,
      pickupCompany: tmsShipment?.pickupCompany || null,
      pickupAirport: tmsShipment?.pickupAirport || tmsShipment?.orig || null,
      consigneePhone: tmsShipment?.consigneePhone || null,
      deliveryCourier: tmsShipment?.deliveryCourier || null,
      deliveryActualArrivalDate: tmsShipment?.deliveryActualArrivalDate || null,
      deliveryActualArrivalTime: tmsShipment?.deliveryActualArrivalTime || null,
      podSignature: tmsShipment?.podSignature || null,
      customerCharge: tmsShipment?.customerCharge || tmsShipment?.billingTotal || null,
      vendorCost: tmsShipment?.vendorCost || tmsShipment?.costTotal || null,
    },
    facts: [tmsArrival].filter(Boolean),
    emailValidation,
    statusAudit: {
      confidence: emailValidation.status === "email-confirmed" ? "high" : "medium",
      missingInfo: [],
      evidence: buildBaseEvidence(tmsShipment, gmailProof),
      confidenceReasons: [
        "Dashboard row was rebuilt from saved source snapshots, not from the previous dashboard output.",
      ],
    },
  };
}

function gmailProofHasOperationalWork(proof = {}) {
  const eventRows = [
    ...(proof.events || []),
    ...(proof.emailValidation?.events || []),
  ];
  const proofRows = [
    ...(proof.proof || []),
    ...(proof.emailValidation?.proof || []),
  ];
  const rows = [
    proof.status,
    proof.summary,
    proof.nextAction,
    proof.emailValidation?.status,
    proof.emailValidation?.summary,
    proof.emailValidation?.nextAction,
    ...proofRows.map((item) => `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`),
    ...eventRows.map((item) => `${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`),
  ].filter(Boolean);
  const text = rows.join(" ");
  if (!text.trim() || hasCompletedGmailProof(proof)) return false;
  if (/\b(?:no action from direct gmail scan|monitor arrival; do not dispatch pickup yet)\b/i.test(text) && !/\b(?:exception|hold|storage|detention|broker-awarded|freight-awarded|pickup scheduled|pod pending|pod needed)\b/i.test(text)) {
    return false;
  }
  const eventText = eventRows.map((item) => `${item.type || ""} ${item.exceptionType || ""} ${item.severity || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`).join(" ");
  const explicitOpenEvent = /\b(?:storage[-_\s]?detention[-_\s]?risk|storage|detention|customs[-_\s]?hold|government hold|connection[-_\s]?transfer|awb[-_\s]?copy|pickup[-_\s]?docs|pickup[-_\s]?location|piece[-_\s]?count|station[-_\s]?cargo[-_\s]?not[-_\s]?found|pickup[-_\s]?scheduled|pod[-_\s]?pending|pod[-_\s]?needed|broker[-_\s]?awarded|freight[-_\s]?awarded|exception)\b/i.test(eventText);
  const readyPickupPath =
    /\barrival[-_\s]?notice[-_\s]?received\b/i.test(eventText) &&
    /\bcustoms[-_\s]?release[-_\s]?received\b/i.test(eventText) &&
    /\b(?:broker[-_\s]?awarded|freight[-_\s]?awarded|pickup)\b/i.test(eventText);
  return explicitOpenEvent || readyPickupPath;
}

function gmailOpenWorkTmsRows({ gmailProofData = {}, metadataByAwb = new Map(), excludedAwbs = new Set(), sourceKeys = new Set(), completedRecords = [] }) {
  const completedKeys = new Set(
    (completedRecords || [])
      .filter((record) => hasCompletedRecordProof(record))
      .map((record) => normalizeAwb(record.awb) || record.awb)
      .filter(Boolean),
  );
  const rows = [];
  const seen = new Set();
  for (const proof of gmailProofData.proofs || []) {
    const key = normalizeAwb(proof.awb);
    if (!key || sourceKeys.has(key) || excludedAwbs.has(key) || completedKeys.has(key) || seen.has(key)) continue;
    if (!gmailProofHasOperationalWork(proof)) continue;
    seen.add(key);
    const metadata = metadataByAwb.get(key) || metadataByAwb.get(proof.awb) || {};
    const previousPacket = metadata.previousTruthPacket || {};
    if (!previousPacket.awb && !previousPacket.id) continue;
    const previousTms = previousPacket.tms || {};
    const previousDelivery = previousPacket.delivery || {};
    const previousFlight = previousPacket.flightDetails || {};
    const previousCargo = previousPacket.cargo || {};
    const nextAction = proof.emailValidation?.nextAction || proof.nextAction || "Review unresolved Gmail shipment proof.";
    rows.push({
      trackingNumber: proof.awb || metadata.awb || key,
      order: metadata.id || previousPacket.id || previousTms.order || `gmail-${key}`,
      shipmentNumber: metadata.id || previousPacket.id || previousTms.order || `gmail-${key}`,
      customerName: metadata.client || previousPacket.client || proof.client || "Gmail-open shipment",
      pickupCompany: metadata.client || previousPacket.client || proof.client || "",
      pickupAddress1: previousPacket.shipper?.address1 || "",
      pickupCity: previousPacket.shipper?.city || "",
      pickupCountry: previousPacket.shipper?.country || "",
      deliveryAirport: metadata.station || previousPacket.station || previousDelivery.airport || proof.station || "",
      dest: metadata.destination || previousPacket.destination || previousTms.destination || metadata.station || previousPacket.station || proof.station || "",
      orig: metadata.origin || previousPacket.origin || previousTms.origin || "",
      dep: previousTms.dep || previousFlight.departureLeg || "",
      arr: previousTms.arr || previousFlight.arrivalLeg || "",
      consigneeCompany: previousDelivery.consignee || previousPacket.consignee || "",
      consigneePhone: previousDelivery.contactPhone || previousTms.consigneePhone || "",
      deliveryAddress1: previousDelivery.address1 || "",
      deliveryAddress2: previousDelivery.address2 || "",
      deliveryCity: previousDelivery.city || "",
      deliveryState: previousDelivery.state || "",
      deliveryCountry: previousDelivery.country || "",
      nextTask: nextAction,
      tmsStatus: "EMAIL-OPEN",
      status: "Unresolved Gmail proof; not present in current TMS snapshot",
      serviceName: "Gmail-open carry-forward",
      pieces: metadata.pieces || previousCargo.pieces || previousTms.pieces || "",
      weight: metadata.weight || previousCargo.weight || previousTms.weight || "",
      weightUom: metadata.weightUom || previousCargo.weightUom || previousTms.weightUom || "",
      customerCharge: previousTms.customerCharge || previousPacket.commercial?.customerCharge || "",
      billingTotal: previousTms.billingTotal || previousPacket.commercial?.billingTotal || "",
      vendorCost: previousTms.vendorCost || previousPacket.commercial?.vendorCost || "",
      costTotal: previousTms.costTotal || previousPacket.commercial?.costTotal || "",
    });
  }
  return rows;
}

function uniqueTimeline(rows) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function customsReleaseTimelineRow(shipment) {
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return null;
  const attachmentEvidence = (shipment.customsBroker?.evidence || []).find((item) =>
    /\b(ace|release|d\.?\/?o\.?|delivery order)\b/i.test(`${item?.label || ""} ${item?.note || ""} ${item?.filename || ""} ${item?.attachment || ""}`),
  );
  const detail = attachmentEvidence
    ? [
        attachmentEvidence.filename || attachmentEvidence.attachment || "Release file",
        attachmentEvidence.threadId ? "Gmail thread" : "",
      ].filter(Boolean).join(" · ")
    : shipment.customsBroker?.broker || "Release proof found";
  return ["Customs", "Released", detail];
}

function normalizeShipmentTimeline(shipment) {
  const releaseRow = customsReleaseTimelineRow(shipment);
  if (!releaseRow) return shipment;
  const timeline = uniqueTimeline([releaseRow, ...(shipment.timeline || [])]);
  return {
    ...shipment,
    timeline,
  };
}

function missingInfoForShipment(shipment) {
  const missing = [];
  const emailStatus = shipment.emailValidation?.status || "email-missing";
  const completed = isCompletedShipment(shipment);
  if (!hasUsefulOperationalEmailProof(shipment)) {
    missing.push("Email operational proof pending");
  }
  if (
    isFreightPodFollowupStatus(shipment.freightBroker?.status) ||
    shipment.freightBroker?.status === "delivery-quote-approved" ||
    shipment.freightBroker?.status === "delivery-quote-received-cost-review"
  ) {
    missing.push("POD/closeout proof pending");
  }
  if (emailStatus === "email-conflict") missing.push("Email conflicts with TMS/tracking");
  if (!completed && (!shipment.stationEmail || /confirm|unknown|not found/i.test(shipment.stationEmail))) {
    missing.push("Station email not confirmed");
  }
  if (!completed && (!shipment.stationPhone || /confirm|unknown|not found/i.test(shipment.stationPhone))) {
    missing.push("Station phone not confirmed");
  }
  if (!completed && (!shipment.customsBroker?.broker || shipment.customsBroker.broker === "Not found")) {
    missing.push("Customs broker not identified");
  }
  if (!completed && shipment.customsBroker?.status === "customs-unknown") missing.push("Clearance status unknown");
  if (shipment.pickupStatus === "delivered" && !hasPodProof(shipment)) {
    missing.push("Delivered, but POD/closeout proof is not attached");
  }
  if (shipment.pickupStatus === "airport-picked-up" && !hasUsefulOperationalEmailProof(shipment)) {
    missing.push("Airport pickup/handoff email confirmation pending");
  }
  if (
    shipment.arrivalStatus === "arrived" &&
    !["delivered", "airport-picked-up"].includes(shipment.pickupStatus) &&
    isFreightMissingLikeStatus(shipment.freightBroker?.status)
  ) {
    missing.push("Freight broker award not found");
  }
  if (shipment.trackingException?.summary) missing.push(shipment.trackingException.summary);
  return unique(missing);
}

function attentionForShipment(shipment) {
  return Boolean(
    !hasUsefulOperationalEmailProof(shipment) ||
      shipment.trackingException ||
      isCustomsHoldStatus(shipment.customsBroker?.status) ||
      shipment.customsBroker?.status === "customs-pending" ||
      (shipment.arrivalStatus === "arrived" &&
        !["delivered", "airport-picked-up"].includes(shipment.pickupStatus) &&
        isFreightMissingLikeStatus(shipment.freightBroker?.status)) ||
      missingInfoForShipment(shipment).length,
  );
}

function evidenceBrief(source, label, status, note) {
  return {
    source,
    label,
    status,
    note: String(note || "").trim(),
  };
}

function trackingEvidenceBrief(shipment) {
  const tracking = shipment.liveTracking || {};
  const latest = tracking.latestEvent || {};
  const finalArrival = tracking.finalArrivalEvent || {};
  const status = shipment.pickupStatus === "delivered"
    ? "delivered"
    : shipment.pickupStatus === "airport-picked-up"
    ? "airport-picked-up"
    : shipment.pickupStatus === "ready"
    ? "available"
    : shipment.arrivalStatus === "arrived"
    ? "arrived"
    : "not-arrived";
  const eventText = [
    latest.code || finalArrival.code,
    latest.description || finalArrival.description,
    latest.timeLocal || finalArrival.timeLocal || tracking.eta || shipment.eta,
  ].filter(Boolean).join(" · ");

  return evidenceBrief(
    "tracking",
    "Carrier tracking",
    status,
    eventText || shipment.trackingException?.summary || "No final carrier event found.",
  );
}

function tmsEvidenceBrief(shipment) {
  return evidenceBrief(
    "tms",
    "CourierCloud",
    shipment.tms?.tmsStatus || shipment.tms?.status || "open",
    shipment.statusAudit?.evidence?.[0]?.note || shipment.detail || "Open shipment in TMS.",
  );
}

function hasPositiveCustomsProofSignal(text) {
  const value = String(text || "");
  return (
    /\b(customs (?:is )?(?:released|cleared)|customs[-\s]?release[-\s]?reported|customs\s*rel|cargo release results?\s*98\s*released|98\s+released|cbp release|release proof|released and attached|attached release|release pdf|release date update)\b/i.test(value) ||
    /\b(d\.?\/?o\.?|delivery order)\b.{0,50}\b(received|attached|sent|provided|issued)\b|\b(received|attached|sent|provided|issued)\b.{0,50}\b(d\.?\/?o\.?|delivery order)\b/i.test(value)
  );
}

function hasStaleCustomsGapText(text) {
  const value = String(text || "");
  const nonCustomsOperationalRelease =
    /\b(?:freight|station|terminal|warehouse|isc|payment|pickup)\b.{0,50}\brelease\b|\brelease\b.{0,50}\b(?:freight|station|terminal|warehouse|isc|payment|pickup)\b/i.test(value) &&
    !/\b(customs|d\.?\/?o\.?|delivery order|clearance|release proof|customs proof)\b/i.test(value);
  if (nonCustomsOperationalRelease) return false;
  return /\b(no|not|missing|pending|awaiting|waiting|without|needed|need|find|not proven)\b.{0,80}\b(release|d\/?o|delivery order|clearance|customs proof|release proof)\b|\b(release|d\/?o|delivery order|clearance|customs proof|release proof)\b.{0,80}\b(no|not|missing|pending|awaiting|waiting|without|needed|need|find|not proven)\b/i.test(
    value,
  );
}

function isResolvedCustomsLayerArtifact(value) {
  return /Earlier email context is older than the resolved customs layer|Customs\/TMS now shows release/i.test(String(value || ""));
}

function operatorCustomsResolvedNote(note) {
  if (!hasStaleCustomsGapText(note)) return note;
  return "Earlier email context is older than the resolved customs layer. Direct Gmail/operator evidence proves release; continue from station, pickup, and POD.";
}

function customsStateMarkedResolved(shipment) {
  return isCustomsResolvedStatus(shipment.customsBroker?.status || "") ||
    /^(?:released|cleared)$/i.test(String(shipment.clearanceStatus || ""));
}

function customsResolvedOperatorNote(shipment) {
  if (shipmentHasDirectCustomsReleaseProof(shipment) || customsLayerResolvesStaleGaps(shipment)) {
    return "Earlier email context is older than the resolved customs layer. Direct Gmail/operator evidence proves release; continue from station, pickup, and POD.";
  }
  return "Current customs state is released; continue from station, pickup, and POD while source confidence stays visible.";
}

function neutralCustomsArtifactNote(note, shipment) {
  if (!isResolvedCustomsLayerArtifact(note) || customsLayerResolvesStaleGaps(shipment)) return note;
  if (customsStateMarkedResolved(shipment)) return customsResolvedOperatorNote(shipment);
  return "Prior customs audit note suppressed; verify the current customs source before treating release as complete.";
}

function customsLayerResolvesStaleGaps(shipment) {
  const status = shipment.customsBroker?.status || "";
  if (isCustomsHoldStatus(status)) return false;
  if (isCompletedShipment(shipment) || canonicalPodComplete(shipment)) return true;
  if (isCustomsResolvedStatus(status)) return shipmentHasDirectCustomsReleaseProof(shipment);
  if (customsRecordHasExplicitHold(shipment.customsBroker)) return false;
  return statusFromClearance(shipment.clearanceStatus, customsEvidenceText(shipment)) === "customs-cleared";
}

function sanitizeCustomsResolvedText(value, shipment) {
  if (value && isResolvedCustomsLayerArtifact(value) && !customsLayerResolvesStaleGaps(shipment)) {
    return neutralCustomsArtifactNote(value, shipment);
  }
  if (!value) return value;
  if (customsStateMarkedResolved(shipment) && hasStaleCustomsGapText(value)) {
    return customsResolvedOperatorNote(shipment);
  }
  if (!customsLayerResolvesStaleGaps(shipment)) return value;
  return operatorCustomsResolvedNote(value);
}

function sanitizeCustomsResolvedEvidenceItem(item, shipment) {
  if (!item || typeof item !== "object") return item;
  if (!customsLayerResolvesStaleGaps(shipment)) {
    const text = `${item.label || ""} ${item.note || ""} ${item.summary || ""}`;
    if (!isResolvedCustomsLayerArtifact(text) && !(customsStateMarkedResolved(shipment) && hasStaleCustomsGapText(text))) return item;
    const note = isResolvedCustomsLayerArtifact(text)
      ? neutralCustomsArtifactNote(item.note || item.summary || "", shipment)
      : customsResolvedOperatorNote(shipment);
    return {
      ...item,
      label: /resolved customs|earlier customs/i.test(item.label || "") ? "Prior customs audit note" : item.label,
      note,
      summary: item.summary ? note : item.summary,
    };
  }
  const text = `${item.label || ""} ${item.status || ""} ${item.note || ""} ${item.summary || ""}`;
  if (!hasStaleCustomsGapText(text)) return item;
  const resolvedNote = "Earlier email context is older than the resolved customs layer. Direct Gmail/operator evidence proves release; continue from station, pickup, and POD.";
  return {
    ...item,
    label: /no|missing|pending|awaiting|waiting|without|needed|need|find|not proven/i.test(item.label || "")
      ? "Earlier customs context"
      : item.label,
    status: item.status ? "resolved-customs-context" : item.status,
    note: resolvedNote,
    summary: item.summary ? resolvedNote : item.summary,
  };
}

function sanitizeCustomsResolvedEvidenceValue(item, shipment) {
  if (typeof item === "string") return sanitizeCustomsResolvedText(item, shipment);
  return sanitizeCustomsResolvedEvidenceItem(item, shipment);
}

function sanitizeResolvedCustomsContext(shipment) {
  const shouldSanitizeResolved = customsLayerResolvesStaleGaps(shipment);
  const hasResolvedArtifact = [
    shipment.detail,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
    ...(shipment.statusAudit?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
    ...(shipment.eodFacts || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
  ].some(isResolvedCustomsLayerArtifact);
  const hasResolvedCustomsStaleGap = customsStateMarkedResolved(shipment) && [
    shipment.detail,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.customsBroker?.nextAction,
    shipment.freightBroker?.nextAction,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
    ...(shipment.statusAudit?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
    ...(shipment.eodFacts || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.summary || ""}`),
  ].some(hasStaleCustomsGapText);
  if (!shouldSanitizeResolved && !hasResolvedArtifact && !hasResolvedCustomsStaleGap) return shipment;
  const emailValidation = shipment.emailValidation
    ? {
        ...shipment.emailValidation,
        summary: sanitizeCustomsResolvedText(shipment.emailValidation.summary, shipment),
        nextAction: sanitizeCustomsResolvedText(shipment.emailValidation.nextAction, shipment),
        proof: (shipment.emailValidation.proof || []).map((item) =>
          sanitizeCustomsResolvedEvidenceItem(item, shipment)
        ),
      }
    : shipment.emailValidation;
  const statusAudit = shipment.statusAudit
    ? {
        ...shipment.statusAudit,
        evidence: (shipment.statusAudit.evidence || []).map((item) =>
          sanitizeCustomsResolvedEvidenceItem(item, shipment)
        ),
      }
    : shipment.statusAudit;
  const eodFacts = (shipment.eodFacts || []).map((fact) =>
    sanitizeCustomsResolvedEvidenceItem(fact, shipment)
  );
  const customsBroker = shipment.customsBroker
    ? {
        ...shipment.customsBroker,
        brokerStatus: sanitizeCustomsResolvedText(shipment.customsBroker.brokerStatus, shipment),
        nextAction: sanitizeCustomsResolvedText(shipment.customsBroker.nextAction, shipment),
        evidence: (shipment.customsBroker.evidence || []).map((item) =>
          sanitizeCustomsResolvedEvidenceValue(item, shipment)
        ),
      }
    : shipment.customsBroker;
  const freightBroker = shipment.freightBroker
    ? {
        ...shipment.freightBroker,
        brokerStatus: sanitizeCustomsResolvedText(shipment.freightBroker.brokerStatus, shipment),
        pickupPlan: sanitizeCustomsResolvedText(shipment.freightBroker.pickupPlan, shipment),
        deliveryPlan: sanitizeCustomsResolvedText(shipment.freightBroker.deliveryPlan, shipment),
        nextAction: sanitizeCustomsResolvedText(shipment.freightBroker.nextAction, shipment),
        evidence: (shipment.freightBroker.evidence || []).map((item) =>
          sanitizeCustomsResolvedEvidenceValue(item, shipment)
        ),
      }
    : shipment.freightBroker;
  const operationalMemory = shipment.operationalMemory
    ? {
        ...shipment.operationalMemory,
        storage: shipment.operationalMemory.storage
          ? {
              ...shipment.operationalMemory.storage,
              evidence: (shipment.operationalMemory.storage.evidence || []).map((item) =>
                sanitizeCustomsResolvedText(item, shipment)
              ),
            }
          : shipment.operationalMemory.storage,
        pod: shipment.operationalMemory.pod
          ? {
              ...shipment.operationalMemory.pod,
              evidence: (shipment.operationalMemory.pod.evidence || []).map((item) =>
                sanitizeCustomsResolvedText(item, shipment)
              ),
            }
          : shipment.operationalMemory.pod,
        money: shipment.operationalMemory.money
          ? {
              ...shipment.operationalMemory.money,
              evidence: (shipment.operationalMemory.money.evidence || []).map((item) =>
                sanitizeCustomsResolvedText(item, shipment)
              ),
            }
          : shipment.operationalMemory.money,
      }
    : shipment.operationalMemory;
  const opsState = shipment.opsState
    ? {
        ...shipment.opsState,
        summary: sanitizeCustomsResolvedText(shipment.opsState.summary, shipment),
        nextAction: sanitizeCustomsResolvedText(shipment.opsState.nextAction, shipment),
        evidence: (shipment.opsState.evidence || []).map((item) =>
          sanitizeCustomsResolvedEvidenceValue(item, shipment)
        ),
        blockers: (shipment.opsState.blockers || []).map((item) =>
          sanitizeCustomsResolvedText(item, shipment)
        ),
      }
    : shipment.opsState;

  return {
    ...shipment,
    detail: sanitizeCustomsResolvedText(shipment.detail, shipment),
    emailValidation,
    statusAudit,
    eodFacts,
    customsBroker,
    freightBroker,
    operationalMemory,
    opsState,
  };
}

function sanitizeResolvedCustomsOperatorEvidence(shipment) {
  if (!customsStateMarkedResolved(shipment)) return shipment;
  const resolvedNote = customsResolvedOperatorNote(shipment);
  const rewriteValue = (value) => {
    if (!hasStaleCustomsGapText(value)) return value;
    return resolvedNote;
  };
  const rewriteItem = (item) => {
    if (typeof item === "string") return rewriteValue(item);
    if (!item || typeof item !== "object") return item;
    const text = `${item.source || ""} ${item.label || ""} ${item.status || ""} ${item.note || ""} ${item.summary || ""} ${item.evidence || ""}`;
    if (!hasStaleCustomsGapText(text)) return item;
    return {
      ...item,
      status: /\bcustoms\b/i.test(`${item.source || ""} ${item.label || ""} ${item.status || ""}`)
        ? "released"
        : item.status,
      note: resolvedNote,
      summary: item.summary ? resolvedNote : item.summary,
      evidence: typeof item.evidence === "string" ? resolvedNote : item.evidence,
    };
  };
  return {
    ...shipment,
    emailValidation: shipment.emailValidation
      ? {
          ...shipment.emailValidation,
          summary: rewriteValue(shipment.emailValidation.summary),
          nextAction: rewriteValue(shipment.emailValidation.nextAction),
          proof: (shipment.emailValidation.proof || []).map(rewriteItem),
          events: (shipment.emailValidation.events || []).map(rewriteItem),
        }
      : shipment.emailValidation,
    customsBroker: shipment.customsBroker
      ? {
          ...shipment.customsBroker,
          nextAction: rewriteValue(shipment.customsBroker.nextAction),
          evidence: (shipment.customsBroker.evidence || []).map(rewriteItem),
        }
      : shipment.customsBroker,
    opsState: shipment.opsState
      ? {
          ...shipment.opsState,
          summary: rewriteValue(shipment.opsState.summary),
          nextAction: rewriteValue(shipment.opsState.nextAction),
          evidence: (shipment.opsState.evidence || []).map(rewriteItem),
          blockers: (shipment.opsState.blockers || []).map(rewriteValue),
        }
      : shipment.opsState,
    statusAudit: shipment.statusAudit
      ? {
          ...shipment.statusAudit,
          evidence: (shipment.statusAudit.evidence || []).map(rewriteItem),
        }
      : shipment.statusAudit,
  };
}

function recoverCustomsBrokerIdentity(shipment) {
  const broker = shipment.customsBroker || {};
  const evidenceText = customsEvidenceText(shipment);
  const recoveredBroker = knownCustomsBrokerName(evidenceText);
  if (!recoveredBroker) return shipment;
  const existingBroker = isMissingBrokerName(broker.broker) ? "" : broker.broker;
  const contactEmail = isKnownContact(broker.contactEmail)
    ? broker.contactEmail
    : customsContactEmailFromEvidence(evidenceText);
  if (existingBroker && isKnownContact(broker.contactEmail)) return shipment;
  return {
    ...shipment,
    customsBroker: {
      ...broker,
      status: broker.status,
      broker: existingBroker || recoveredBroker,
      contactName: isKnownContact(broker.contactName) ? broker.contactName : recoveredBroker,
      contactEmail: contactEmail || broker.contactEmail || "Not found",
      contactPhone: isKnownContact(broker.contactPhone) ? broker.contactPhone : broker.contactPhone || "Not found",
      confidence: broker.confidence === "high" ? "high" : "medium",
      evidence: [
        ...(broker.evidence || []),
        {
          label: "Customs broker contact",
          note: "Customs broker identity recovered from Gmail customs evidence.",
        },
      ],
      nextAction: broker.nextAction,
    },
  };
}

function hasStalePodGapText(text) {
  const value = String(text || "");
  return /\bno\s+(?:final\s+)?(?:pickup\s+completion|pickup\s+completion\s+or\s+pod|delivery\s+completion|delivery\s+completion\s+or\s+pod|pod|delivery|closeout)\b/i.test(value) ||
    /\bno\b.{0,90}\b(?:pickup|delivery|pod|proof of delivery)\b.{0,40}\b(?:found|received|confirmed|complete|completed|attached)\b/i.test(value) ||
    /\b(?:pod|delivery|closeout)\s+(?:is\s+)?(?:missing|needed|requested|pending|not\s+(?:found|received|provided|attached|complete|completed))\b/i.test(value) ||
    /\b(?:request|ask|follow(?:ed)? up|waiting|awaiting|obtain|capture|collect|send)\b.{0,80}\b(?:pod|delivery proof|proof of delivery|delivery confirmation|closeout)\b/i.test(value);
}

function podLayerResolvesStaleGaps(shipment) {
  return hasPodProof(shipment) ||
    /\b(?:delivered-pod-found|freight-delivered-pod-found|pod found; delivered status supported|proof of delivery|signed received in good order)\b/i.test(
      [
        shipment.freightBroker?.status,
        shipment.emailValidation?.status,
        shipment.emailValidation?.summary,
        shipment.operationalMemory?.pod?.status,
        ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`),
      ].filter(Boolean).join(" "),
    );
}

function sanitizeCompletedPodText(value, shipment) {
  if (!value || !podLayerResolvesStaleGaps(shipment) || !hasStalePodGapText(value)) return value;
  return "Earlier dispatch context is older than the confirmed POD. Delivery/POD proof is now complete.";
}

function sanitizeCompletedPodEvidenceValue(item, shipment) {
  if (typeof item === "string") return sanitizeCompletedPodText(item, shipment);
  if (!item || typeof item !== "object") return item;
  const text = `${item.label || ""} ${item.note || ""} ${item.summary || ""} ${item.evidence || ""}`;
  if (!hasStalePodGapText(text) || !podLayerResolvesStaleGaps(shipment)) return item;
  return {
    ...item,
    note: sanitizeCompletedPodText(item.note || item.summary || item.evidence || "", shipment),
    summary: item.summary ? sanitizeCompletedPodText(item.summary, shipment) : item.summary,
    evidence: typeof item.evidence === "string" ? sanitizeCompletedPodText(item.evidence, shipment) : item.evidence,
  };
}

function sanitizeCompletedPodContext(shipment) {
  if (!podLayerResolvesStaleGaps(shipment)) return shipment;
  const freightBroker = shipment.freightBroker
    ? {
        ...shipment.freightBroker,
        brokerStatus: sanitizeCompletedPodText(shipment.freightBroker.brokerStatus, shipment),
        pickupPlan: sanitizeCompletedPodText(shipment.freightBroker.pickupPlan, shipment),
        deliveryPlan: sanitizeCompletedPodText(shipment.freightBroker.deliveryPlan, shipment),
        nextAction: sanitizeCompletedPodText(shipment.freightBroker.nextAction, shipment),
        evidence: (shipment.freightBroker.evidence || []).map((item) =>
          sanitizeCompletedPodEvidenceValue(item, shipment)
        ),
      }
    : shipment.freightBroker;
  const emailValidation = shipment.emailValidation
    ? {
        ...shipment.emailValidation,
        summary: sanitizeCompletedPodText(shipment.emailValidation.summary, shipment),
        nextAction: sanitizeCompletedPodText(shipment.emailValidation.nextAction, shipment),
        proof: (shipment.emailValidation.proof || []).map((item) =>
          sanitizeCompletedPodEvidenceValue(item, shipment)
        ),
      }
    : shipment.emailValidation;
  return {
    ...shipment,
    freightBroker,
    emailValidation,
    detail: sanitizeCompletedPodText(shipment.detail, shipment),
  };
}

function gmailEvidenceBrief(shipment) {
  const status = shipment.emailValidation?.status || "email-missing";
  const note = shipment.emailValidation?.summary || shipment.emailValidation?.nextAction || "No matching Gmail proof found.";
  return evidenceBrief(
    "gmail",
    "Gmail",
    status,
    sanitizeCustomsResolvedText(note, shipment),
  );
}

function customsEvidenceBriefLayer(shipment) {
  const customs = shipment.customsBroker || {};
  const evidence = customs.evidence || [];
  const strongestEvidence =
    evidence.find((item) =>
      /release|delivery order|attached.*\bDO\b|\bDO\b\s*(pdf|attached|sent)|cleared|1c|1d/i.test(
        `${item.label || ""} ${item.note || ""}`,
      )
    ) ||
    evidence[0];
  return evidenceBrief(
    "customs",
    customs.broker && customs.broker !== "Not found" ? customs.broker : "Customs",
    customs.status || "customs-unknown",
    isCustomsResolvedStatus(customs.status || "")
      ? operatorCustomsResolvedNote(strongestEvidence?.note || customs.nextAction || "Customs release/DO is confirmed.")
      : strongestEvidence?.note || customs.nextAction || "Customs broker/release proof is not confirmed.",
  );
}

function freightEvidenceBrief(shipment) {
  const freight = shipment.freightBroker || {};
  const note = freight.evidence?.[0]?.note || freight.pickupPlan || freight.nextAction || "Freight broker award is not confirmed.";
  if (
    shipment.arrivalStatus === "arrived" &&
    isCustomsResolvedStatus(shipment.customsBroker?.status || "") &&
    /\buntil\b.{0,80}\b(?:arrival|on[-\s]?hand)\b.{0,80}\bcustoms release\b.{0,80}\bconfirmed\b/i.test(note)
  ) {
    return null;
  }
  return evidenceBrief(
    "freight",
    freight.broker && freight.broker !== "Not found" ? freight.broker : "Freight",
    freight.status || "freight-missing",
    note,
  );
}

function operationalExceptionText(shipment) {
  return [
    shipment.detail,
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.customsBroker?.status,
    shipment.customsBroker?.broker,
    shipment.customsBroker?.nextAction,
    shipment.freightBroker?.status,
    shipment.freightBroker?.broker,
    shipment.freightBroker?.rate,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.deliveryPlan,
    shipment.freightBroker?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.customsBroker?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""} ${item.note || ""}`,
    ),
    ...(shipment.freightBroker?.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""} ${item.note || ""}`,
    ),
    ...(shipment.eodFacts || []).map(factRowText),
  ].filter(Boolean).join(" ");
}

function jfkTerminationOpenTruckException(shipment) {
  const text = operationalExceptionText(shipment);
  const terminatesAtJfk = /\b(?:terminat(?:e|ed|ing)|final destination|org[-\s]?dest|routing (?:was )?updated|RCT)\b.{0,120}\bJFK\b|\bJFK\b.{0,120}\b(?:terminat(?:e|ed|ing)|final destination|org[-\s]?dest|routing (?:was )?updated|RCT)\b/i.test(text);
  const openTruckNeeded = /\b(open truck|flatbed|hotshot|will not fit|won'?t fit|cannot fit|too wide|orientation labels?|closed trailer)\b/i.test(text);
  const releasePending = !isCustomsResolvedStatus(shipment.customsBroker?.status || "") &&
    /\b(customs release|release\/DO|release and DO|issued DO|pickup authority|clearance)\b.{0,120}\b(?:pending|unconfirmed|not proven|needed|missing|ASAP|still)\b|\b(?:pending|unconfirmed|not proven|needed|missing|ASAP|still)\b.{0,120}\b(customs release|release\/DO|release and DO|issued DO|pickup authority|clearance)\b/i.test(text);
  if (!terminatesAtJfk || !openTruckNeeded) return null;

  const blockers = [
    releasePending ? "Customs release/DO pending" : "",
    "Open truck/flatbed required",
    /insurance|60K|artwork|painting/i.test(text) ? "Artwork insurance/equipment review" : "",
    /storage|last free|free storage|charges/i.test(text) ? "JFK storage/charges risk" : "",
  ].filter(Boolean);

  return {
    type: "jfk-termination-open-truck",
    label: "JFK exception",
    effectiveStation: "JFK",
    priority: "critical",
    summary: "JFK termination confirmed; open truck required.",
    nextAction: "Push MW/Kuehne+Nagel for release/DO and pickup authority, confirm JFK charges, then award open-truck recovery.",
    blockers: unique(blockers),
  };
}

function operationalExceptionForShipment(shipment) {
  return jfkTerminationOpenTruckException(shipment);
}

function invalidatePickupQuotesForException(freightBroker, exception) {
  if (!exception) return freightBroker;
  const quotes = (freightBroker.quotes || []).map((quote) => ({
    ...quote,
    stale: true,
    actionable: false,
    staleReason: exception.summary,
  }));
  const recommendedAward = freightBroker.recommendedAward
    ? {
        ...freightBroker.recommendedAward,
        stale: true,
        actionable: false,
        staleReason: exception.summary,
      }
    : null;
  return {
    ...freightBroker,
    quotes,
    recommendedAward,
    quoteDecision: {
      status: "stale-operational-exception",
      summary: "Prior pickup quotes are stale after JFK termination/open-truck exception.",
    },
  };
}

function operatingPhase(shipment, missingInfo) {
  const emailStatus = shipment.emailValidation?.status || "email-missing";
  const customsStatus = shipment.customsBroker?.status || "customs-unknown";
  const freightStatus = shipment.freightBroker?.status || "freight-missing";
  const exception = shipment.operationalException || operationalExceptionForShipment(shipment);

  if (exception) {
    return {
      id: "exception",
      label: exception.label,
      priority: exception.priority || "critical",
      summary: exception.summary,
    };
  }

  if (emailStatus === "email-conflict" || isCustomsHoldStatus(customsStatus) || pickupBlockedByReleaseMismatch(shipment)) {
    return {
      id: "problem",
      label: emailStatus === "email-conflict"
        ? "Conflict"
        : pickupBlockedByReleaseMismatch(shipment)
        ? "Release mismatch"
        : "Customs hold",
      priority: "critical",
      summary: emailStatus === "email-conflict"
        ? "Email conflicts with tracking or TMS. Resolve before dispatch."
        : pickupBlockedByReleaseMismatch(shipment)
        ? "Pickup is blocked because the station system does not show the release."
        : "Customs hold or exam is blocking pickup.",
    };
  }

  if (isCompletedShipment(shipment)) {
    return {
      id: "completed",
      label: "Completed",
      priority: "low",
      summary: "Shipment has delivery/POD proof and can stay out of the live board.",
    };
  }

  if (shipment.pickupStatus === "delivered" || shipment.pickupStatus === "airport-picked-up") {
    const needsPodOrDetention = isFreightPodFollowupStatus(freightStatus);
    return {
      id: "closeout",
      label: shipment.pickupStatus === "delivered" ? "Delivered" : "Picked up",
      priority: hasPodProof(shipment) ? "normal" : "high",
      summary: hasPodProof(shipment)
        ? "Pickup/delivery proof is attached."
        : needsPodOrDetention
        ? "Airport pickup happened; detention details and POD/delivery proof are still needed."
        : "Airport handoff happened; POD or closeout proof is still needed.",
    };
  }

  if (isFreightPickupDispatchedStatus(freightStatus)) {
    return {
      id: "pickup-dispatched",
      label: "Dispatched",
      priority: "high",
      summary: "Broker/carrier is dispatched; monitor pickup, delivery window, and POD.",
    };
  }

  const prearrivalQuotePrep = prearrivalQuotePrepCheck(shipment);
  if (freightNeedsQuotePrep(shipment)) {
    return {
      id: "prearrival-quotes",
      label: "Prep quotes",
      priority: "normal",
      summary: prearrivalQuotePrep
        ? prearrivalQuotePrep.detail
        : "Customs appears ready before arrival; prepare pickup quotes so dispatch can move fast.",
    };
  }

  if (shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") {
    if (!isCustomsResolvedStatus(customsStatus)) {
      return {
        id: "customs",
        label: "Customs",
        priority: "high",
        summary: customsStatus === "customs-pending"
          ? "Arrived, but customs release is still pending."
          : "Arrived, but customs broker/release proof is missing.",
      };
    }

    if (isFreightMissingLikeStatus(freightStatus)) {
      return {
        id: "ready-for-quotes",
        label: "Ready for quotes",
        priority: "high",
        summary: "Cargo is arrived/cleared and needs a pickup broker decision.",
      };
    }

    return {
      id: "ready-for-pickup",
      label: "Ready",
      priority: emailStatus === "email-confirmed" ? "normal" : "high",
      summary: "Cargo is arrived/cleared; follow pickup and POD.",
    };
  }

  if (brokerActivityCanReplaceStationStatus(shipment)) {
    return {
      id: "pickup-dispatched",
      label: "Broker follow-up",
      priority: "high",
      summary: "Broker/payment context exists; confirm pickup timing and POD instead of repeating station status.",
    };
  }

  if (shipment.trackingException?.type === "eta-passed-no-arrival-proof") {
    return {
      id: "arrival-check",
      label: "ETA passed",
      priority: "high",
      summary: "ETA has passed, but final arrival or availability proof is missing.",
    };
  }

  const etaCheck = stationEtaStatusCheck(shipment);
  if (etaCheck) {
    return {
      id: "arrival-check",
      label: etaCheck.label,
      priority: etaCheck.status === "passed" ? "high" : "normal",
      summary: etaCheck.detail,
    };
  }

  if (missingInfo.includes("Email operational proof pending") && isCustomsResolvedStatus(shipment.customsBroker?.status)) {
    return {
      id: "prearrival-ready",
      label: "Pre-arrival ready",
      priority: "normal",
      summary: "Not at destination yet, but customs appears ready.",
    };
  }

  return {
    id: "in-transit",
    label: "In transit",
    priority: "normal",
    summary: shipment.eta ? `Not at destination yet. Expected ${shipment.eta}.` : "Not at destination yet.",
  };
}

function opsNextAction(shipment, phase) {
  if (phase.id === "exception") {
    return shipment.operationalException?.nextAction ||
      operationalExceptionForShipment(shipment)?.nextAction ||
      shipment.emailValidation?.nextAction ||
      "Resolve operational exception before dispatch.";
  }
  if (phase.id === "problem") {
    return shipment.emailValidation?.status === "email-conflict"
      ? shipment.emailValidation?.nextAction || "Resolve Gmail conflict before dispatch."
      : pickupBlockedByReleaseMismatch(shipment)
      ? shipment.freightBroker?.nextAction || shipment.emailValidation?.nextAction || "Resolve release mismatch before pickup can proceed."
      : shipment.customsBroker?.nextAction || "Follow customs broker for hold/exam release.";
  }
  if (phase.id === "closeout") {
    return shipment.freightBroker?.nextAction || shipment.emailValidation?.nextAction || "Get POD/closeout proof.";
  }
  if (phase.id === "pickup-dispatched") {
    return shipment.freightBroker?.nextAction || shipment.emailValidation?.nextAction || "Monitor broker pickup and POD.";
  }
  if (phase.id === "completed") {
    return "No action; delivery/POD proof is complete.";
  }
  if (phase.id === "customs") {
    return shipment.customsBroker?.nextAction || "Find customs release, broker reply, ABI, or hold status in Gmail.";
  }
  if (phase.id === "ready-for-quotes") {
    return "Request pickup quotes from approved brokers and award the best option.";
  }
  if (phase.id === "prearrival-quotes") {
    return "Draft pickup quote requests before arrival so rates are ready when cargo is available.";
  }
  if (phase.id === "ready-for-pickup") {
    if (needsBrokerStatusFollowup(shipment)) {
      return "Confirm broker pickup timing/rate and POD path.";
    }
    return shipment.freightBroker?.nextAction || "Follow assigned broker for pickup and POD.";
  }
  if (phase.id === "arrival-check") {
    return shipment.emailValidation?.nextAction || "Confirm station availability by email.";
  }
  return shipment.nextAction || shipment.emailValidation?.nextAction || "Track movement and keep customs/broker context ready.";
}

function deriveOpsState(shipment, missingInfo, confidence) {
  const phase = operatingPhase(shipment, missingInfo);
  const exceptionBlockers = shipment.operationalException?.blockers || [];
  const blockers = unique(
    [
      ...exceptionBlockers,
      ...missingInfo.filter((item) =>
        /conflict|hold|pending|missing|not identified|not confirmed|not attached|proof/i.test(item)
      ),
    ].filter(Boolean)
  );
  const nextAction = opsNextAction(shipment, phase);

  return {
    phase: phase.id,
    label: phase.label,
    priority: phase.priority,
    confidence,
    summary: phase.summary,
    nextAction,
    blockers,
    needsHuman: phase.priority === "critical" || phase.priority === "high" || blockers.length > 0,
    evidence: [
      tmsEvidenceBrief(shipment),
      trackingEvidenceBrief(shipment),
      gmailEvidenceBrief(shipment),
      customsEvidenceBriefLayer(shipment),
      freightEvidenceBrief(shipment),
    ].filter(Boolean),
    updatedAt: new Date().toISOString(),
  };
}

function clearanceStatusFromCustomsLayer(shipment) {
  const status = shipment.customsBroker?.status || "";
  if (isCustomsHoldStatus(status)) return "hold";
  if (status === "customs-pending") return "not-cleared";
  if (isCustomsResolvedStatus(status)) return "released";
  return shipment.clearanceStatus || "unknown";
}

function promotePickupStatusFromFreight(shipment) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return shipment;
  const freightStatus = shipment.freightBroker?.status || "";
  const normalizedFreightStatus = normalizedStatus(freightStatus);
  const freightText = dispatchEvidenceText(shipment);
  const freightShowsPickup =
    isFreightAirportPickedUpStatus(freightStatus) ||
    hasFreightPickupCompletionProofText(freightText) ||
    normalizedFreightStatus.includes("driver-loaded") ||
    normalizedFreightStatus.includes("loaded-delivery-pending") ||
    (normalizedFreightStatus.includes("release-authorized") &&
      normalizedFreightStatus.includes("pickup-pending") &&
      normalizedFreightStatus.includes("pod-pending"));
  if (!freightShowsPickup) return shipment;
  return {
    ...shipment,
    pickupStatus: "airport-picked-up",
  };
}

function finalizeShipment(shipment) {
  const statusAligned = promotePickupStatusFromFreight(shipment);
  const missingInfo = missingInfoForShipment(statusAligned);
  const attention = attentionForShipment({ ...statusAligned, statusAudit: { ...(statusAligned.statusAudit || {}), missingInfo } });
  const confidence = hasUsefulOperationalEmailProof(statusAligned) && missingInfo.length <= 1
    ? "high"
    : missingInfo.length <= 3
    ? "medium"
    : "low";

  const finalized = {
    ...statusAligned,
    clearanceStatus: clearanceStatusFromCustomsLayer(statusAligned),
    attention,
    statusAudit: {
      ...(statusAligned.statusAudit || {}),
      confidence,
      missingInfo,
    },
  };

  const opsState = deriveOpsState(finalized, missingInfo, confidence);
  return {
    ...finalized,
    nextAction: opsState.nextAction,
    layerStatus: inferLayerStatus(finalized),
    opsState,
  };
}

function hasPodProof(shipment) {
  if (shipment.tms?.podSignature || shipment.tms?.deliveryActualArrivalDate || shipment.tms?.deliveryActualArrivalTime) {
    return true;
  }
  const rows = [
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
    shipment.detail,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.freightBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(shipment.timeline || []).map(timelineRowText),
  ].filter(Boolean);
  const text = rows.join(" ");
  if (hasCompletionDisqualifier(text)) {
    return hasFinalDeliveryOrPodProofInRows(rows);
  }
  if (isFreightDeliveredWithPodStatus(shipment.freightBroker?.status)) return true;
  return hasFinalDeliveryOrPodProofText(text);
}

function isCompletedShipment(shipment) {
  return shipment.pickupStatus === "delivered" && hasPodProof(shipment);
}

function completionRecord(shipment, snapshotTime) {
  const text = [
    shipment.freightBroker?.status,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
    ...(shipment.freightBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    shipment.emailValidation?.summary,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean).join(" ");
  const signedPodPending = hasSignedPodPendingText(text);
  const detentionPending = hasDetentionPendingText(text);
  const finalProofAt = podEvidenceTimestamp(shipment);
  const tmsDeliveredAt = [
    shipment.tms?.deliveryActualArrivalDate,
    shipment.tms?.deliveryActualArrivalTime,
  ].filter(Boolean).join(" ");
  return {
    awb: shipment.awb,
    shipmentId: shipment.id,
    completedAt: snapshotTime,
    client: shipment.client,
    consignee: shipment.delivery?.consignee || "",
    deliveryAddress: shipment.delivery?.fullAddress || "",
    station: shipment.station,
    deliveredAt: finalProofAt || tmsDeliveredAt || shipment.eta,
    podStatus: signedPodPending ? "signed-pod-pending" : hasPodProof(shipment) ? "pod-found" : "pod-missing",
    closeoutStatus: detentionPending ? "detention-pending" : signedPodPending ? "signed-pod-pending" : "",
    customsBroker: shipment.customsBroker?.broker || "",
    freightBroker: shipment.freightBroker?.broker || "",
    freightStatus: shipment.freightBroker?.status || "",
    rate: shipment.freightBroker?.rate || "",
    plan: shipment.freightBroker?.pickupPlan || shipment.freightBroker?.nextAction || "",
    evidence: shipment.freightBroker?.evidence || [],
  };
}

function completedRecordGate(name, status, evidence, at = "") {
  return {
    name,
    status,
    label: name,
    evidence,
    confidence: "completed-gmail-truth",
    source: "completed-shipment-record",
    at,
  };
}

function completedRecordCargo(record = {}, text = "") {
  const value = String(text || "");
  const pieceMatch = value.match(/\b(\d+)\s*(?:pc|pcs|piece|pieces)\b/i);
  const weightMatch = value.match(/\b(\d+(?:\.\d+)?)\s*(kg|kgs|lb|lbs)\b/i);
  const rawUom = record.weightUom || record.cargo?.weightUom || weightMatch?.[2] || "";
  return {
    pieces: record.pieces || record.cargo?.pieces || pieceMatch?.[1] || "",
    weight: record.weight || record.cargo?.weight || weightMatch?.[1] || "",
    weightUom: /^k/i.test(rawUom) ? "KG" : /^l/i.test(rawUom) ? "LB" : "",
    source: pieceMatch || weightMatch || record.pieces || record.weight ? "completed-shipment-record" : "",
  };
}

function completedRecordFlightDetails(record = {}, text = "") {
  const value = String(text || "");
  const station = firstText(record.station, record.destination);
  const flight = firstText(record.flight, record.flightNumber, value.match(/\b[A-Z]{2}\d{2,4}\b/)?.[0], station ? `HIST-${station}` : "historical-completed");
  const route = firstText(record.route, record.lane, station ? `HIST-${station}` : "historical-completed");
  return {
    primaryFlight: flight,
    route,
    destination: station,
    source: flight || route ? "completed-shipment-record" : "",
  };
}

function completedRecordTruthPacketGate(key, gateRow = {}) {
  return {
    gate: gateRow.name,
    status: /^(?:done|delivered|received|found|cleared|paid)$/i.test(String(gateRow.status || "")) ? "true" : "unknown",
    rawStatus: gateRow.status || "",
    confidence: gateRow.confidence || "completed-gmail-truth",
    sourceFactIds: [`${key}:completed:${gateRow.name}`],
    reason: gateRow.evidence || "",
    updatedAt: gateRow.at || "",
  };
}

function completedRecordAsTruthPacket(record = {}, snapshotTime = "") {
  const awb = record.awb || "";
  const key = normalizeAwb(awb) || awb;
  const proofText = [
    record.freightStatus,
    record.podStatus,
    record.plan,
    ...(record.evidence || []).map((item) => `${item.label || ""} ${item.note || item.summary || item.evidence || ""}`),
  ].filter(Boolean).join(" ");
  const evidence = proofText || "Delivered/POD proof found in completed shipment truth.";
  const deliveredAt = record.deliveredAt || record.completedAt || snapshotTime;
  const noAction = "No action; POD is in memory.";
  const gates = {
    arrival: completedRecordGate("arrival", "done", evidence, deliveredAt),
    customs: completedRecordGate("customs", "done", evidence, deliveredAt),
    fees: completedRecordGate("fees", "done", evidence, deliveredAt),
    dispatch: completedRecordGate("dispatch", "done", evidence, deliveredAt),
    pickup: completedRecordGate("pickup", "done", evidence, deliveredAt),
    delivery: completedRecordGate("delivery", "delivered", evidence, deliveredAt),
    pod: completedRecordGate("pod", "received", evidence, deliveredAt),
  };
  const cargo = completedRecordCargo(record, [proofText, record.eta].filter(Boolean).join(" "));
  const flightDetails = completedRecordFlightDetails(record, [proofText, record.eta].filter(Boolean).join(" "));
  const fullAddress = record.deliveryAddress || record.destinationAddress || [record.consignee, record.station].filter(Boolean).join(", ");
  const completedSourceFactId = `${key}:completed:pod`;
  const completedSourceFacts = record.sourceEvents || record.facts || [];
  const completedProof = record.sourceProof || record.evidence || [];
  const completedFreshnessAt = record.sourceHistory?.latestEventAt || deliveredAt || snapshotTime;
  return {
    id: record.shipmentId || key || awb,
    awb,
    client: record.client || "",
    station: record.station || "",
    cargo,
    flightDetails,
    route: flightDetails.route,
    delivery: {
      consignee: record.consignee || "",
      fullAddress,
    },
    currentState: "delivered",
    nextAction: noAction,
    pickupStatus: "delivered",
    deliveryStatus: "delivered",
    completed: true,
    completedAt: record.completedAt || snapshotTime,
    deliveredAt,
    freightBroker: {
      broker: record.freightBroker || "",
      status: record.freightStatus || "delivered",
      pickupPlan: record.plan || "",
      evidence: record.evidence || [],
    },
    customsBroker: {
      broker: record.customsBroker || "",
      status: record.customsBroker ? "customs-cleared" : "unknown-offline",
    },
    opsState: {
      phase: "delivered",
      label: "Delivered / POD received",
      summary: evidence,
      nextAction: noAction,
      gates,
    },
    sourceEvents: record.sourceEvents || [],
    sourceProof: record.sourceProof || [],
    sourceCoverage: record.sourceCoverage || null,
    evidencePacket: {
      shipmentId: record.shipmentId || key || awb,
      awbs: [key].filter(Boolean),
      compiledAt: snapshotTime || new Date().toISOString(),
      freshness: {
        gmailSyncedAt: completedFreshnessAt,
        trackingSyncedAt: "",
        tmsSyncedAt: "",
        operatorEventsSyncedAt: "",
        shipmentStateSyncedAt: completedFreshnessAt,
        staleSources: [],
        hasGmailEvidence: true,
      },
      sourceFacts: completedSourceFacts,
      threads: [],
      attachments: completedProof,
      trackingEvents: [],
      tmsRecords: [],
      operatorEvents: [],
      contradictions: [],
      unknowns: [],
    },
    canonicalAuthority: true,
    _truthPacketSource: "shipment-truth-packets",
    _truthPacketSnapshotTime: snapshotTime,
    truthPacketRole: "completed",
    truthPacket: {
      shipmentId: record.shipmentId || key || awb,
      awbs: [key].filter(Boolean),
      compiledAt: snapshotTime || new Date().toISOString(),
      currentState: "delivered",
      resolvedCurrentState: "delivered",
      stateConfidence: "high",
      stateReason: evidence,
      physicalLifecycle: {
        status: "delivered",
        label: "Delivered",
        sourceFactIds: [completedSourceFactId],
        reason: evidence,
      },
      operationalBlocker: {
        type: "none",
        status: "clear",
        label: "No blocker",
        severity: "none",
        sourceFactIds: [],
        reason: "Delivered/POD proof is in completed shipment truth.",
      },
      feeLedger: {
        status: "settled",
        reason: evidence,
        sourceFactIds: [completedSourceFactId],
      },
      documentRequestBlocker: {
        type: "none",
        status: "clear",
        reason: "",
        sourceFactIds: [],
      },
      gates: Object.values(gates).map((gateRow) => completedRecordTruthPacketGate(key, gateRow)),
      contradictions: [],
      unknowns: [],
      exceptions: [],
      nextAction: {
        label: noAction,
        sourceFactIds: [completedSourceFactId],
      },
    },
    recommendedActions: [],
    actionHistory: [],
  };
}

function completedSourceEventKey(item = {}) {
  if (item.id) return `id:${item.id}`;
  return [
    item.id,
    item.type,
    item.at,
    item.threadId,
    item.messageId,
    item.summary,
    item.evidence,
  ].filter(Boolean).join("|");
}

function completedSourceProofKey(item = {}) {
  const hasAttachmentIdentity = Boolean(item.attachmentId || item.filename);
  const attachmentIdentity = [
    item.threadId,
    item.messageId,
    item.attachmentId,
    item.filename,
  ].filter(Boolean).join("|");
  if (hasAttachmentIdentity && attachmentIdentity) return `attachment:${attachmentIdentity}`;
  return [
    item.label,
    item.note,
    item.threadId,
    item.messageId,
  ].filter(Boolean).join("|");
}

function completedPublicMemoryText(value = "") {
  let text = String(value || "");
  if (!text) return "";
  text = text.replace(
    /\bPickup is scheduled\/deferred for ([0-9-]+); wait for actual pickup proof\.?/gi,
    "Pickup was scheduled/deferred for $1 before later delivery/POD completion.",
  );
  text = text.replace(
    /\bwait for actual pickup proof\b/gi,
    "later delivery/POD completion resolved pickup execution",
  );
  text = text.replace(
    /\bDelivery\/POD evidence implies pickup happened; direct pickup proof is missing\.?/gi,
    "Delivery/POD evidence implies airport pickup occurred; direct pickup source is not separately attached.",
  );
  text = text.replace(
    /\bdirect pickup proof is missing\b/gi,
    "direct pickup source is not separately attached",
  );
  text = text.replace(/^Payment delivered for\b/i, "Ground-fee payment receipt for");
  if (/^Payment delivered$/i.test(text.trim())) return "Ground-fee payment receipt";
  return text;
}

function completedCanonicalSourceEventType(event = {}) {
  const type = String(event.type || "").trim();
  if (/^(broker[-_\s]?disregarded|broker[-_\s]?cancel(?:ed|led)|wrong[-_\s]?destination)$/i.test(type)) {
    return "exception";
  }
  return type;
}

function compactCompletedSourceEvent(event = {}, fallbackAwb = "") {
  return {
    id: event.id || "",
    awb: event.awb || fallbackAwb || "",
    type: completedCanonicalSourceEventType(event),
    label: completedPublicMemoryText(event.label || event.type || ""),
    summary: brainShort(completedPublicMemoryText(event.summary || ""), "", 300),
    evidence: brainShort(completedPublicMemoryText(event.evidence || ""), "", 300),
    at: event.at || "",
    threadId: event.threadId || "",
    messageId: event.messageId || "",
    subject: brainShort(completedPublicMemoryText(event.subject || ""), "", 180),
    from: brainShort(event.from || "", "", 120),
    to: brainShort(event.to || "", "", 160),
    confidence: event.confidence || "",
    evidenceKind: event.evidenceKind || "",
  };
}

function compactCompletedSourceProof(item = {}) {
  return {
    label: completedPublicMemoryText(item.label || ""),
    note: brainShort(completedPublicMemoryText(item.note || item.evidence || ""), "", 300),
    at: item.at || "",
    filename: item.filename || "",
    mimeType: item.mimeType || "",
    threadId: item.threadId || "",
    messageId: item.messageId || "",
    attachmentId: item.attachmentId || "",
    pdfEvidence: item.pdfEvidence
      ? {
        kind: item.pdfEvidence.kind || "",
        label: completedPublicMemoryText(item.pdfEvidence.label || ""),
        status: item.pdfEvidence.status || "",
        note: brainShort(completedPublicMemoryText(item.pdfEvidence.note || ""), "", 240),
      }
      : null,
  };
}

function mergeCompletedSourceEvents(items = []) {
  const byKey = new Map();
  for (const item of (items || []).filter(Boolean).map((row) => compactCompletedSourceEvent(row, row.awb || ""))) {
    const key = completedSourceEventKey(item);
    if (key) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""))
    .slice(-80);
}

function mergeCompletedSourceProof(items = []) {
  const byKey = new Map();
  for (const item of (items || []).filter(Boolean).map(compactCompletedSourceProof)) {
    const key = completedSourceProofKey(item);
    if (key) byKey.set(key, item);
  }
  return [...byKey.values()].slice(-80);
}

function completedLifecycleText(item = {}) {
  return [
    item.type,
    item.label,
    item.note,
    item.summary,
    item.evidence,
    item.subject,
    item.filename,
    item.pdfEvidence?.label,
    item.pdfEvidence?.note,
  ].filter(Boolean).join(" ");
}

function completedLifecycleStages(item = {}) {
  const text = completedLifecycleText(item);
  const stages = [];
  if (/\b(?:arrival|arrived|on[-\s]?hand|available|availability|notice of arrival|noa|pre[-\s]?alert|eta)\b/i.test(text)) stages.push("arrival");
  if (/\b(?:release|customs|entry|firms|1c|d\/?o|delivery order|clearance|cleared)\b/i.test(text)) stages.push("customs");
  if (/\b(?:ground fees?|terminal charges?|handling charges?|storage charges?|payment|paid|receipt|collect charges?|airline fees?)\b/i.test(text)) stages.push("fees");
  if (/\b(?:quote|rate|\$\s*\d|price|pickup rates?)\b/i.test(text)) stages.push("quote");
  if (/\b(?:dispatch(?:ed)?|dispatch[-\s]?release|inbound alert|pickup award|pickup broker|award|approved|confirm to|selected|assigned|door move|handle pickup\/delivery|handle pickup and delivery|will handle pickup|scheduled? (?:pickup|recovery)|pickup (?:is )?scheduled|schedule (?:this|the)? ?(?:pickup|one)|last[-\s]?free[-\s]?day|\blfd\b)\b/i.test(text)) stages.push("dispatch");
  if (/\b(?:picked up|pickup complete|recovery complete|recovered|loaded|out for delivery|out for del|ofd|driver(?: is)? lining up|driver(?: is)? on[-\s]?site|driver onsite|driver(?: is| was)? (?:currently )?at pickup|at the pickup|on[-\s]?site now|line[-\s]?up update)\b/i.test(text)) stages.push("pickup");
  if (/\b(?:delivered|delivery completed|successfully delivered|receiver|deliver(?:y)? was completed|completed delivery|delivery proof)\b/i.test(text)) stages.push("delivery");
  if (/\b(?:pod|proof of delivery|delivery proof|signed pod|pod attached|pod found|pod received|signed[-\s]?by|signature)\b/i.test(text)) stages.push("pod");
  if (/\b(?:invoice|invoice attached|invoice found|closeout|closed in tms|tms close|billing complete)\b/i.test(text)) stages.push("closeout");
  if (/\b(?:duplicate|double[-\s]?paid|paid (?:twice|2x)|payment.*twice|no bill match|broker[-_\s]?disregarded|disregard(?:ed)?|cancel(?:ed|led)|wrong destination|still to ewr|terminate in ewr|revised awb|final-port|amended pa|corrected.*destination|correction|release not in (?:their )?system|not in (?:their )?system|do not see the clearance)\b/i.test(text)) stages.push("exception");
  if (!stages.length && /\b(?:operator-control-gap|hold|problem|exception|mismatch|error|duplicate|double[-\s]?paid|paid (?:twice|2x)|no bill match|wrong destination|still to ewr|terminate in ewr|revised awb|final-port|amended pa|correction|storage|detention|cannot|can't|blocked|pending|not released|release not in (?:their )?system|not in (?:their )?system|do not see the clearance)\b/i.test(text)) {
    stages.push("exception");
  }
  if (!stages.length && /\b(?:shipment[-_\s]?group[-_\s]?linked|group awbs?|shared broker execution|pickup thread links|pickup assignment|perform the delivery|pickup from [a-z]{3}|booking|booked|routing|flight route|paperwork|documentation|document(?:s)? attached|awb paperwork|cargo dimensions|gmail thread mentions this awb|no operational status change detected|got it|acknowledge|acknowledgement|received|confirm(?:ed|ation)?|noted|please see|deliver to)\b/i.test(text)) {
    stages.push("context");
  }
  return unique(stages);
}

function completedSourceExplanationText(sourceEvents = [], evidence = [], proofRows = []) {
  return [
    ...sourceEvents,
    ...evidence,
    ...proofRows,
  ].map(completedLifecycleText).filter(Boolean).join(" ");
}

function explainedCompletedSourceGaps(missingPreDeliveryStages = [], stages = [], sourceEvents = [], evidence = [], proofRows = [], record = {}) {
  const explanations = [];
  const text = completedSourceExplanationText(sourceEvents, evidence, proofRows);
  if (
    missingPreDeliveryStages.includes("pickup") &&
    (stages.includes("delivery") || stages.includes("pod") || hasCompletedRecordProof(record))
  ) {
    explanations.push({
      stage: "pickup",
      reason: /\bpickup\b/i.test(text)
        ? "Pickup completion is not separately sourced; the source trail contains pickup planning plus final delivery/POD proof."
        : "Pickup completion is not separately sourced; final delivery/POD proof implies the cargo moved after airport pickup.",
      confidence: "inferred-from-final-delivery",
    });
  }
  if (
    missingPreDeliveryStages.includes("dispatch") &&
    (stages.includes("pickup") || stages.includes("delivery") || stages.includes("pod")) &&
    (record.freightBroker || /\b(?:driver|pickup|pick up|broker|agent|carrier|will deliver|deliver directly)\b/i.test(text))
  ) {
    explanations.push({
      stage: "dispatch",
      reason: record.freightBroker
        ? `Dispatch award is not separately sourced; ${record.freightBroker} appears as the pickup/delivery agent and downstream pickup/POD proof is present.`
        : "Dispatch award is not separately sourced; downstream pickup/delivery/POD proof shows execution occurred.",
      confidence: "inferred-from-downstream-execution",
    });
  }
  return explanations;
}

function inferredCompletedSourceGaps(missingPreDeliveryStages = [], stages = [], sourceEvents = [], evidence = [], proofRows = [], record = {}) {
  const inferences = [];
  const text = completedSourceExplanationText(sourceEvents, evidence, proofRows);
  const finalProof = stages.includes("delivery") || stages.includes("pod") || hasCompletedRecordProof(record);
  if (missingPreDeliveryStages.includes("arrival") && finalProof) {
    inferences.push({
      stage: "arrival",
      reason: "Arrival proof is not separately sourced; final delivery/POD proves the shipment reached the execution path, but the arrival timestamp/source still needs historical backfill.",
      confidence: "inferred-from-final-delivery",
      directProofMissing: true,
    });
  }
  if (missingPreDeliveryStages.includes("customs") && finalProof) {
    const broker = record.customsBroker && !/^(not found|unknown|n\/a)$/i.test(String(record.customsBroker || "").trim())
      ? record.customsBroker
      : "";
    inferences.push({
      stage: "customs",
      reason: broker
        ? `Customs release/DO proof is not separately sourced; ${broker} appears as customs context and final delivery/POD implies release occurred, but direct release proof still needs historical backfill.`
        : "Customs release/DO proof is not separately sourced; final delivery/POD implies release occurred before delivery, but direct release proof still needs historical backfill.",
      confidence: /\b(release|customs|clearance|delivery order|d\/?o)\b/i.test(text)
        ? "inferred-from-customs-context-and-final-delivery"
        : "inferred-from-final-delivery",
      directProofMissing: true,
    });
  }
  return inferences;
}

function completedSourceCoverage(record = {}, sourceEvents = [], sourceProof = [], sourceHistory = null) {
  const evidence = record.evidence || [];
  const proofRows = (sourceProof || []).map((item) => ({
    type: "proof",
    label: item.label || item.pdfEvidence?.label || "Gmail proof",
    note: item.note || item.pdfEvidence?.note || "",
    evidence: item.pdfEvidence?.note || item.note || "",
    filename: item.filename || "",
  }));
  const stages = unique([
    ...(sourceEvents || []).flatMap(completedLifecycleStages),
    ...evidence.flatMap(completedLifecycleStages),
    ...proofRows.flatMap(completedLifecycleStages),
  ]);
  if (stages.includes("pod") && !stages.includes("delivery") && hasCompletedRecordProof(record)) {
    stages.splice(stages.indexOf("pod"), 0, "delivery");
  }
  const missingPreDeliveryStages = ["arrival", "customs", "dispatch", "pickup"].filter((stage) => !stages.includes(stage));
  const explainedMissingStages = explainedCompletedSourceGaps(
    missingPreDeliveryStages,
    stages,
    sourceEvents || [],
    evidence,
    proofRows,
    record,
  );
  const inferredMissingStages = inferredCompletedSourceGaps(
    missingPreDeliveryStages,
    stages,
    sourceEvents || [],
    evidence,
    proofRows,
    record,
  );
  const explainedStageNames = new Set(explainedMissingStages.map((item) => item.stage));
  const unresolvedMissingPreDeliveryStages = missingPreDeliveryStages.filter((stage) => !explainedStageNames.has(stage));
  const inferredStages = unique([
    ...explainedMissingStages.map((item) => item.stage),
    ...inferredMissingStages.map((item) => item.stage),
  ]);
  const hasAnyPreDeliveryHistory = ["arrival", "customs", "fees", "quote", "dispatch", "pickup"].some((stage) => stages.includes(stage));
  const completeness = missingPreDeliveryStages.length === 0
    ? "full-cycle"
    : unresolvedMissingPreDeliveryStages.length === 0
    ? "explained-cycle"
    : hasAnyPreDeliveryHistory
    ? "partial-cycle"
    : "final-proof-only";
  const source = sourceHistory?.source ||
    ((sourceEvents || []).length ? "completed-record-source-events" : evidence.length ? "legacy-completed-evidence" : "none");
  return {
    source,
    exactAwbMatched: Boolean(sourceHistory?.exactAwbMatched),
    sourceEventCount: sourceEvents.length,
    sourceProofCount: sourceProof.length,
    legacyEvidenceCount: evidence.length,
    stages,
    directStages: stages,
    inferredStages,
    inferredMissingStages,
    sourceMissingPreDeliveryStages: missingPreDeliveryStages,
    missingPreDeliveryStages,
    unresolvedMissingPreDeliveryStages,
    explainedMissingStages,
    completeness,
    needsHistoricalBackfill: unresolvedMissingPreDeliveryStages.length > 0,
    backfillReason: unresolvedMissingPreDeliveryStages.length
      ? `Missing historical ${unresolvedMissingPreDeliveryStages.join(", ")} proof before final POD.`
      : "",
    explanation: explainedMissingStages.length
      ? explainedMissingStages.map((item) => `${item.stage}: ${item.reason}`).join(" ")
      : "",
  };
}

function completedEvidenceSourceType(item = {}) {
  const text = completedLifecycleText(item);
  const label = String(item.label || "");
  if (/\bpod|proof of delivery|delivery completed|delivered\b/i.test(text)) return "delivery-pod";
  if (/\bdriver loaded|picked up|en route|on his way|loaded\b/i.test(text)) return "pickup-loaded";
  if (/\bpickup scheduled|driver at pickup|pickup\b/i.test(text)) return "pickup-status";
  if (/\bquote|rate|\$\s*\d/i.test(text)) return "quote";
  if (/\bpayment|paid|receipt|ground fee|terminal charge|storage charge\b/i.test(text)) return "station-fees-paid";
  if (/\brelease|customs|d\/?o|delivery order|ace\b/i.test(text)) return "customs-resolution";
  if (/\barrival|arrived|on[-\s]?hand|available\b/i.test(text)) return "arrival-status";
  if (/\binbound alert|dispatch|award|approved|packet\b/i.test(text)) return "dispatch-release";
  if (/\binvoice|closeout\b/i.test(text)) return "invoice";
  return "gmail-evidence";
}

function completedEvidenceSourceEvents(record = {}) {
  const awb = record.awb || "";
  return (record.evidence || [])
    .filter((item) => item?.threadId && item?.messageId)
    .map((item, index) => ({
      id: `${normalizeAwb(awb) || "completed"}:${completedEvidenceSourceType(item)}:${item.threadId}:${item.messageId}:${index}`,
      awb,
      type: completedEvidenceSourceType(item),
      label: item.label || "Gmail evidence",
      summary: item.summary || item.note || item.evidence || "",
      evidence: item.evidence || item.note || item.summary || "",
      at: item.at || "",
      threadId: item.threadId || "",
      messageId: item.messageId || "",
      confidence: item.confidence || "high",
      evidenceKind: "gmail-body",
    }));
}

function completedEvidenceSourceProof(record = {}) {
  return (record.evidence || [])
    .filter((item) => item?.threadId && item?.messageId)
    .map((item) => ({
      label: item.label || "Gmail evidence",
      note: item.note || item.summary || item.evidence || "",
      at: item.at || "",
      filename: item.filename || "",
      mimeType: item.mimeType || "",
      threadId: item.threadId || "",
      messageId: item.messageId || "",
      attachmentId: item.attachmentId || "",
      pdfEvidence: item.pdfEvidence || null,
    }));
}

function proofRecordMatchesCompletedAwb(proof, record) {
  const recordKey = normalizeAwb(record?.awb || "");
  const proofKey = normalizeAwb(proof?.awb || proof?.normalizedAwb || "");
  return Boolean(recordKey && proofKey && recordKey === proofKey);
}

function proofEventMatchesCompletedAwb(event, record) {
  const recordKey = normalizeAwb(record?.awb || "");
  const eventKey = normalizeAwb(event?.awb || event?.normalizedAwb || "");
  return Boolean(recordKey && (!eventKey || eventKey === recordKey));
}

function enrichCompletedRecordWithGmailProof(record, gmailProofByAwb) {
  if (!record) return record;
  const key = normalizeAwb(record.awb) || record.awb;
  const proof = gmailProofByAwb?.get?.(record.awb) || gmailProofByAwb?.get?.(key) || null;
  if (!proofRecordMatchesCompletedAwb(proof, record)) {
    const derivedSourceEvents = completedEvidenceSourceEvents(record);
    const derivedSourceProof = completedEvidenceSourceProof(record);
    const sourceEvents = mergeCompletedSourceEvents([
      ...(record.sourceEvents || []),
      ...(record.historicalEvents || []),
      ...derivedSourceEvents,
    ]);
    const sourceProof = mergeCompletedSourceProof([
      ...(record.sourceProof || []),
      ...(record.historicalProof || []),
      ...derivedSourceProof,
    ]);
    const derivedFromGmailEvidence = Boolean(derivedSourceEvents.length || derivedSourceProof.length);
    const fallbackSourceHistory = sourceEvents.length || sourceProof.length || (record.evidence || []).length
      ? {
        ...(record.sourceHistory || {}),
        source: record.sourceHistory?.source && record.sourceHistory.source !== "legacy-completed-evidence"
          ? record.sourceHistory.source
          : derivedFromGmailEvidence
          ? "gmail-proof-snapshot"
          : (sourceEvents.length || sourceProof.length ? "completed-record" : "legacy-completed-evidence"),
        eventCount: sourceEvents.length,
        proofCount: sourceProof.length,
        legacyEvidenceCount: (record.evidence || []).length,
        exactAwbMatched: derivedFromGmailEvidence ? true : false,
      }
      : null;
    const sourceCoverage = completedSourceCoverage(record, sourceEvents, sourceProof, fallbackSourceHistory);
    return {
      ...record,
      ...(sourceEvents.length ? { sourceEvents } : {}),
      ...(sourceProof.length ? { sourceProof } : {}),
      ...(fallbackSourceHistory ? { sourceHistory: fallbackSourceHistory } : {}),
      sourceCoverage,
    };
  }
  const exactEvents = [
    ...(proof.historicalEvents || []),
    ...(proof.events || []),
    ...(proof.emailValidation?.events || []),
  ].filter((event) => proofEventMatchesCompletedAwb(event, record));
  const sourceEvents = mergeCompletedSourceEvents([
    ...(record.sourceEvents || []),
    ...(record.historicalEvents || []),
    ...exactEvents,
  ]);
  const sourceProof = mergeCompletedSourceProof([
    ...(record.sourceProof || []),
    ...(record.historicalProof || []),
    ...(proof.historicalProof || []),
    ...(proof.proof || []),
    ...(proof.emailValidation?.proof || []),
  ]);
  const sourceHistory = {
    source: "gmail-proof-snapshot",
    latestEventAt: proof.latestEventAt || record.deliveredAt || "",
    eventCount: sourceEvents.length,
    proofCount: sourceProof.length,
    legacyEvidenceCount: (record.evidence || []).length,
    exactAwbMatched: true,
  };
  return {
    ...record,
    sourceEvents,
    sourceProof,
    sourceHistory,
    sourceCoverage: completedSourceCoverage(record, sourceEvents, sourceProof, sourceHistory),
  };
}

function manualReviewProofRows(data = {}, options = {}) {
  const completedOnly = Boolean(options.completedOnly);
  const sourceLabel = options.sourceLabel || "manual-gmail-truth";
  return (data.shipments || [])
    .filter((row) => {
      const historicalEvents = row.historicalEvents || row.sourceEvents || [];
      const historicalProof = row.historicalProof || row.sourceProof || [];
      const decisiveEvidence = row.decisiveEvidence || row.emails || [];
      const evidenceText = [
        row.manualTruth,
        row.expectedPhase,
        row.expectedPacketRole,
        ...(row.expectedSummaryTerms || []),
        ...(row.requiredTerms || []),
        ...decisiveEvidence.map((item) => item.summary),
      ].filter(Boolean).join(" ");
      if (completedOnly && !hasFinalDeliveryOrPodProofText(evidenceText)) return false;
      return historicalEvents.length || historicalProof.length || decisiveEvidence.length || row.manualTruth;
    })
    .map((row) => {
      const awb = row.awb || "";
      const historicalEvents = row.historicalEvents || row.sourceEvents || [];
      const historicalProof = row.historicalProof || row.sourceProof || [];
      const decisiveEvidence = row.decisiveEvidence || row.emails || [];
      const fallbackEvents = decisiveEvidence.map((item, index) => ({
        id: `${normalizeAwb(awb) || awb}:${sourceLabel}:${item.threadId || "thread"}:${item.messageId || index}:delivery-pod`,
        awb,
        type: hasFinalDeliveryOrPodProofText(`${row.manualTruth || ""} ${item.summary || ""}`) ? "delivery-pod" : "manual-gmail-truth",
        label: "Manual Gmail truth",
        summary: item.summary || row.manualTruth || "",
        evidence: row.manualTruth || item.summary || "",
        at: item.at || data.capturedAt || "",
        threadId: item.threadId || "",
        messageId: item.messageId || "",
        confidence: "high",
        evidenceKind: "actual",
      }));
      const fallbackProof = decisiveEvidence.map((item) => ({
        label: "Manual Gmail truth",
        note: [row.manualTruth, item.summary].filter(Boolean).join(" "),
        at: item.at || data.capturedAt || "",
        filename: "",
        mimeType: "",
        threadId: item.threadId || "",
        messageId: item.messageId || "",
      }));
      const sourceEvents = historicalEvents.length ? historicalEvents : fallbackEvents;
      const sourceProof = historicalProof.length ? historicalProof : fallbackProof;
      const latestEventAt = [
        ...sourceEvents.map((event) => event.at),
        ...sourceProof.map((proof) => proof.at),
        ...(row.decisiveEvidence || []).map((proof) => proof.at),
      ].filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) || "";
      return {
        awb,
        normalizedAwb: normalizeAwb(awb),
        latestEventAt,
        historicalEvents: sourceEvents,
        events: sourceEvents,
        historicalProof: sourceProof,
        proof: sourceProof,
        emailValidation: {
          status: "historical-gmail-proof",
          summary: sourceEvents.map((event) => `${event.label || event.type || ""}: ${event.summary || event.evidence || ""}`).filter(Boolean).join(" ") || row.manualTruth || "",
          events: sourceEvents,
          proof: sourceProof,
        },
      };
    });
}

function manualHistoricalProofRows(data = {}) {
  return manualReviewProofRows(data, { sourceLabel: "manual-historical-truth" });
}

function manualCurrentCompletionProofRows(data = {}) {
  return manualReviewProofRows(data, {
    completedOnly: true,
    sourceLabel: "manual-current-truth",
  });
}

function normalizeCompletedRecord(record) {
  const text = [
    record?.freightStatus,
    record?.podStatus,
    record?.plan,
    ...(record?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean).join(" ");
  const signedPodPending = hasSignedPodPendingText(text);
  const detentionPending = hasDetentionPendingText(text);
  if (!signedPodPending && !detentionPending) return record;
  return {
    ...record,
    podStatus: signedPodPending ? "signed-pod-pending" : record.podStatus,
    closeoutStatus: detentionPending ? "detention-pending" : signedPodPending ? "signed-pod-pending" : record.closeoutStatus || "",
  };
}

function mergeCompletedRecords(existing, shipments, snapshotTime, gmailProofByAwb = new Map()) {
  const currentKeys = new Set(shipments.map((shipment) => normalizeAwb(shipment.awb) || shipment.awb));
  const byKey = new Map(
    (existing || [])
      .filter((record) => !currentKeys.has(normalizeAwb(record.awb) || record.awb))
      .filter((record) => hasCompletedRecordProof(record))
      .map((record) => {
        const normalized = enrichCompletedRecordWithGmailProof(normalizeCompletedRecord(record), gmailProofByAwb);
        return [normalizeAwb(normalized.awb) || normalized.awb, normalized];
      }),
  );
  for (const shipment of shipments) {
    if (!isCompletedShipment(shipment)) continue;
    const key = normalizeAwb(shipment.awb) || shipment.awb;
    byKey.set(key, {
      ...(byKey.get(key) || {}),
      ...enrichCompletedRecordWithGmailProof(completionRecord(shipment, snapshotTime), gmailProofByAwb),
    });
  }
  return [...byKey.values()].sort((a, b) => String(a.awb).localeCompare(String(b.awb)));
}

function hasCompletedRecordProof(record) {
  const rows = [
    record?.freightStatus,
    record?.podStatus,
    record?.plan,
    ...(record?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean);
  if (hasFinalDeliveryOrPodProofInRows(rows)) return true;
  const text = rows.join(" ");
  return !hasCompletionDisqualifier(text) &&
    (isFreightDeliveredWithPodStatus(record?.freightStatus) || isFreightDeliveredWithPodStatus(record?.podStatus));
}

function hasCompletedDispatchProof(dispatch) {
  const rows = [
    dispatch?.status,
    dispatch?.pickupPlan,
    dispatch?.nextAction,
    ...evidenceRowsText(dispatch?.evidence),
  ].filter(Boolean);
  const text = rows.join(" ");
  if (hasCompletionDisqualifier(text) || /\bafter unloading\b/i.test(text)) {
    return hasFinalDeliveryOrPodProofInRows(rows);
  }
  return hasFinalDeliveryOrPodProofText(text) || /\bfreight-delivered-pod-found\b/i.test(text);
}

function hasCompletedGmailProof(proof) {
  const rows = [
    proof?.emailValidation?.summary,
    proof?.emailValidation?.nextAction,
    ...(proof?.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || ""}`),
    ...(proof?.timeline || []).map(timelineRowText),
  ].filter(Boolean);
  const text = rows.join(" ");
  if (hasCompletionDisqualifier(text) || /\bafter unloading\b/i.test(text)) {
    return hasFinalDeliveryOrPodProofInRows(rows);
  }
  return hasFinalDeliveryOrPodProofText(text);
}

function completedRecordFromDetachedProof(key, proof = {}, metadata = {}, customsBroker = {}, snapshotTime = "") {
  const proofRows = proof.emailValidation?.proof || proof.proof || [];
  const eventRows = proof.emailValidation?.events || proof.events || [];
  const evidenceText = [
    proof.emailValidation?.summary,
    proof.emailValidation?.nextAction,
    ...proofRows.map((item) => `${item.label || ""} ${item.note || item.evidence || ""}`),
    ...eventRows.map((item) => `${item.label || item.type || ""} ${item.summary || item.evidence || ""}`),
  ].filter(Boolean).join(" ");
  const deliveredAt = proof.latestEventAt ||
    [...proofRows, ...eventRows].map((item) => item.at).filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ||
    snapshotTime;
  return {
    awb: proof.awb || metadata.awb || key,
    shipmentId: metadata.id || "",
    completedAt: snapshotTime,
    client: metadata.client || proof.client || "",
    consignee: metadata.consignee || proof.consignee || "",
    deliveryAddress: metadata.deliveryAddress || proof.deliveryAddress || "",
    station: metadata.station || proof.station || "",
    deliveredAt,
    podStatus: "pod-found",
    closeoutStatus: "",
    customsBroker: customsBroker.broker || "",
    freightBroker: proof.freightBroker?.broker || "",
    freightStatus: "delivered",
    rate: "",
    plan: proof.emailValidation?.summary || evidenceText || "Delivered/POD proof found in Gmail truth.",
    evidence: proofRows.length ? proofRows : eventRows,
  };
}

function detachedCompletionRecords({
  existing,
  shipments,
  metadataByAwb,
  gmailProofByAwb,
  dispatchByAwb,
  customsBrokerByAwb,
  snapshotTime,
}) {
  const activeKeys = new Set(shipments.map((shipment) => normalizeAwb(shipment.awb) || shipment.awb));
  const existingKeys = new Set(
    (existing || [])
      .filter((record) => hasCompletedRecordProof(record))
      .map((record) => normalizeAwb(record.awb) || record.awb),
  );
  const records = [];

  for (const [key, dispatch] of dispatchByAwb) {
    if (!key || activeKeys.has(key) || existingKeys.has(key)) continue;
    const proof = gmailProofByAwb.get(key) || {};
    const dispatchHasCompletionProof = hasCompletedDispatchProof(dispatch);
    const gmailHasCompletionProof = hasCompletedGmailProof(proof);
    if (!dispatchHasCompletionProof && !gmailHasCompletionProof) continue;
    const metadata = metadataByAwb.get(key) || {};
    const customsBroker = customsBrokerByAwb.get(key) || {};
    if (!dispatchHasCompletionProof && gmailHasCompletionProof) {
      const record = completedRecordFromDetachedProof(key, proof, metadata, customsBroker, snapshotTime);
      records.push({
        ...record,
        freightBroker: dispatch.broker || record.freightBroker,
        rate: dispatch.rate || record.rate,
      });
      existingKeys.add(key);
      const normalizedAwb = normalizeAwb(record.awb || key);
      if (normalizedAwb) existingKeys.add(normalizedAwb);
      continue;
    }
    const deliveryPlan = dispatch.deliveryPlan || "";
    const deliveryConsignee = deliveryPlan.match(/^Delivered to\s+(.+?)(?:,\s*[A-Z][a-z]+\b|\.?$)/i)?.[1] || "";
    const deliveredAt = proof.latestEventAt || dispatch.latestEventAt || dispatch.reviewedAt || dispatch.updatedAt || snapshotTime;
    records.push({
      awb: dispatch.awb || proof.awb || metadata.awb || key,
      shipmentId: metadata.id || "",
      completedAt: snapshotTime,
      client: metadata.client || proof.client || dispatch.client || "",
      consignee: metadata.consignee || proof.consignee || deliveryConsignee,
      deliveryAddress: "",
      station: metadata.station || dispatch.station || proof.station || "",
      deliveredAt,
      podStatus: hasSignedPodPendingText(`${dispatch.status || ""} ${dispatch.pickupPlan || ""} ${dispatch.nextAction || ""} ${evidenceRowsText(dispatch.evidence).join(" ")}`)
        ? "signed-pod-pending"
        : "pod-found",
      closeoutStatus: hasDetentionPendingText(`${dispatch.status || ""} ${dispatch.pickupPlan || ""} ${dispatch.nextAction || ""} ${evidenceRowsText(dispatch.evidence).join(" ")}`)
        ? "detention-pending"
        : "",
      customsBroker: customsBroker.broker || "",
      freightBroker: dispatch.broker || "",
      freightStatus: dispatch.status || "delivered",
      rate: dispatch.rate || "",
      plan: dispatch.pickupPlan || dispatch.nextAction || proof.emailValidation?.summary || "",
      evidence: dispatch.evidence || proof.emailValidation?.proof || [],
    });
    existingKeys.add(key);
    const normalizedAwb = normalizeAwb(dispatch.awb || proof.awb || metadata.awb || key);
    if (normalizedAwb) existingKeys.add(normalizedAwb);
  }

  for (const [key, proof] of gmailProofByAwb) {
    if (!key || activeKeys.has(key) || existingKeys.has(key)) continue;
    if (!hasCompletedGmailProof(proof)) continue;
    const metadata = metadataByAwb.get(key) || {};
    const customsBroker = customsBrokerByAwb.get(key) || {};
    const record = completedRecordFromDetachedProof(key, proof, metadata, customsBroker, snapshotTime);
    records.push(record);
    existingKeys.add(key);
    const normalizedAwb = normalizeAwb(record.awb || key);
    if (normalizedAwb) existingKeys.add(normalizedAwb);
  }

  return records;
}

function numberValue(value) {
  const parsed = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeGroupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(ship to|c\/o|co)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Company-name normalization for cluster identity: strips legal suffixes and separators so
// "BERESHIT / ENERCO" and "Juniper International Logistics Ltd" cannot split one real consignee cluster.
function normalizeGroupPartyText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:ltd|llc|inc|corp|co|company|international|int'?l|intl|logistics|group|source)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function groupKeyForShipment(shipment) {
  const delivery = shipment.delivery || {};
  // Operational cluster identity = where the freight physically goes: station + normalized
  // consignee + delivery address. Client-name string variants and per-flight/eta/state
  // fragments used to shred real sibling sets (one Northstar Components cluster split into 5 groups)
  // while state equality merged divergent shipments. Flight/eta/state stay OUT of identity;
  // in-group divergence is expressed through counts/blockers from canonical packet truth.
  return [
    shipment.station,
    normalizeGroupPartyText(delivery.consignee),
    normalizeGroupPartyText(delivery.address1),
    normalizeGroupPartyText(delivery.city),
  ]
    .map(normalizeGroupText)
    .filter(Boolean)
    .join("|");
}

function groupEtaLabel(shipment) {
  return (
    shipment.eta ||
    shipment.liveTracking?.scheduledArrival ||
    shipment.liveTracking?.latestEvent?.scheduledArrival ||
    shipment.liveTracking?.latestEvent?.timeLocal ||
    "eta unknown"
  );
}

function groupFlightLabel(shipment) {
  const latest = shipment.liveTracking?.latestEvent || {};
  if (latest.airlineCode && latest.flightNumber) return `${latest.airlineCode}${latest.flightNumber}`;
  return (shipment.liveTracking?.flights || []).find(Boolean) || "flight unknown";
}

function groupOperationalState(shipment) {
  const customsStatus = shipment.customsBroker?.status || "customs-unknown";
  const freightStatus = shipment.freightBroker?.status || "freight-unknown";
  const proofStatus = hasUsefulOperationalEmailProof(shipment) ? "proof-confirmed" : "proof-needed";
  const exception = shipment.trackingException?.type || "no-tracking-exception";
  return [
    shipment.arrivalStatus || "arrival-unknown",
    shipment.pickupStatus || "pickup-unknown",
    customsStatus,
    freightStatus,
    proofStatus,
    exception,
  ].join("|");
}

function actionForGroup(group) {
  if (group.counts.customsHold) return "Resolve customs hold before dispatch";
  if (group.counts.ready && group.counts.freightMissing) return "Assign pickup for available AWBs";
  if (group.counts.delivered === group.counts.total) return "Collect POD and close out";
  if (group.counts.airportPickedUp) return "Confirm airport pickup handoff and downstream delivery";
  if (group.counts.arrived) return "Confirm availability, clearance, and pickup plan";
  return "Monitor arrivals";
}

// Group truth must come from the canonical packet authority, not the TMS-merged working rows.
// Without this overlay the group UI said "assign pickup" / "clearance unknown" against rows the
// packet layer had already reconciled (broker confirmed, released, fees paid) — the exact class
// of sibling incoherence in INC-2026-07-02-SIBLING-GROUP-COHERENCE.
function overlayCanonicalTruthForGrouping(shipments, rootDir) {
  let packets = null;
  try {
    packets = JSON.parse(fsSync.readFileSync(path.join(rootDir, "shipment-truth-packets.json"), "utf8"));
  } catch {
    return shipments;
  }
  const byAwb = new Map((packets?.shipments || [])
    .filter((row) => row && (row.canonicalAuthority || row._truthPacketSource === "shipment-truth-packets"))
    .map((row) => [normalizeAwb(row.awb), row])
    .filter(([awb]) => awb));
  if (!byAwb.size) return shipments;
  return shipments.map((shipment) => {
    const packet = byAwb.get(normalizeAwb(shipment.awb));
    if (!packet) return shipment;
    const merged = { ...shipment };
    if (packet.customsBroker && (packet.customsBroker.status || packet.customsBroker.broker)) {
      merged.customsBroker = { ...(shipment.customsBroker || {}), ...packet.customsBroker };
    }
    if (packet.freightBroker && (packet.freightBroker.status || packet.freightBroker.broker)) {
      merged.freightBroker = { ...(shipment.freightBroker || {}), ...packet.freightBroker };
    }
    if (packet.pickupStatus) merged.pickupStatus = packet.pickupStatus;
    if (packet.arrivalStatus) merged.arrivalStatus = packet.arrivalStatus;
    if (packet.nextAction) merged.nextAction = packet.nextAction;
    if (packet.currentState) merged.currentState = packet.currentState;
    if (packet.emailValidation) merged.emailValidation = packet.emailValidation;
    return merged;
  });
}

function buildShipmentGroups(shipments) {
  const groups = new Map();
  for (const shipment of shipments) {
    const key = groupKeyForShipment(shipment) || normalizeAwb(shipment.awb) || shipment.awb;
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: key,
        station: shipment.station,
        client: shipment.client,
        consignee: shipment.delivery?.consignee || "Unknown consignee",
        deliveryAddress: shipment.delivery?.fullAddress || "",
        eta: groupEtaLabel(shipment),
        flight: groupFlightLabel(shipment),
        operationalState: groupOperationalState(shipment),
        awbs: [],
        shipmentIds: [],
        totalPieces: 0,
        totalWeightKg: 0,
        counts: {
          total: 0,
          arrived: 0,
          ready: 0,
          airportPickedUp: 0,
          delivered: 0,
          customsCleared: 0,
          customsPending: 0,
          customsHold: 0,
          customsUnknown: 0,
          freightAwarded: 0,
          freightMissing: 0,
          emailGaps: 0,
        },
        blockers: [],
      });
    }

    const group = groups.get(key);
    group.awbs.push(shipment.awb);
    group.shipmentIds.push(shipment.id);
    group.totalPieces += numberValue(shipment.tms?.pieces);
    group.totalWeightKg += numberValue(shipment.tms?.weight);
    group.counts.total += 1;
    if (shipment.arrivalStatus === "arrived") group.counts.arrived += 1;
    if (shipment.pickupStatus === "ready") group.counts.ready += 1;
    if (shipment.pickupStatus === "airport-picked-up") group.counts.airportPickedUp += 1;
    if (shipment.pickupStatus === "delivered") group.counts.delivered += 1;
    if (isCustomsResolvedStatus(shipment.customsBroker?.status)) group.counts.customsCleared += 1;
    if (shipment.customsBroker?.status === "customs-pending") group.counts.customsPending += 1;
    if (isCustomsHoldStatus(shipment.customsBroker?.status)) group.counts.customsHold += 1;
    if (shipment.customsBroker?.status === "customs-unknown") group.counts.customsUnknown += 1;
    if (isFreightAssigned(shipment.freightBroker?.status)) group.counts.freightAwarded += 1;
    if (shipment.freightBroker?.status === "freight-missing") group.counts.freightMissing += 1;
    if (!hasUsefulOperationalEmailProof(shipment)) group.counts.emailGaps += 1;
    group.blockers.push(...missingInfoForShipment(shipment).map((item) => `${shipment.awb}: ${item}`));
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      awbs: unique(group.awbs),
      shipmentIds: unique(group.shipmentIds),
      totalWeightKg: Number(group.totalWeightKg.toFixed(1)),
      blockers: unique(group.blockers).slice(0, 8),
      canDispatch:
        group.counts.arrived > 0 &&
        group.counts.customsHold === 0 &&
        group.counts.customsPending === 0,
      partialDispatch: group.counts.arrived > 0 && group.counts.arrived < group.counts.total,
      action: actionForGroup(group),
    }))
    .sort((a, b) => b.counts.arrived - a.counts.arrived || b.counts.total - a.counts.total);
}

function actionEvidence(shipment) {
  const trackingUnavailable = carrierTrackingUnavailable(shipment);
  return unique([
    trackingUnavailable ? "" : shipment.liveTracking?.status,
    shipment.trackingException?.type === "carrier-tracking-unavailable" ? "" : shipment.trackingException?.summary,
    sanitizeCustomsResolvedText(shipment.emailValidation?.summary, shipment),
    sanitizeCustomsResolvedText(shipment.customsBroker?.nextAction, shipment),
    shipment.freightBroker?.nextAction,
  ]).slice(0, 3);
}

function actionBody(lines) {
  return lines.filter((line) => line !== null && line !== undefined && line !== false).join("\n");
}

const quoteBrokers = [
  { name: "JD Direct", email: "contact-072@demo-freight.example" },
  { name: "Freight Flex", email: "contact-014@demo-freight.example" },
  { name: "BTX Global", email: "contact-102@demo-freight.example" },
  { name: "Juniper Logistics", email: "contact-088@demo-freight.example" },
];

const quoteCc = "contact-084@demo-freight.example";
const opsEscalationEmail = process.env.PQ_OPS_ESCALATION_EMAIL || "contact-052@demo-freight.example";
const quoteFollowupAfterHours = Number(process.env.PQ_QUOTE_FOLLOWUP_AFTER_HOURS || 4);

function quoteActionId(shipment, broker) {
  const awb = String(shipment.awb || shipment.id || "shipment").replace(/\W+/g, "");
  const brokerKey = broker.email.toLowerCase().replace(/\W+/g, "");
  return `${awb}-quote-${brokerKey}`;
}

function shipmentDeliveryAddress(shipment) {
  const delivery = shipment.delivery || {};
  return shipment.address || delivery.fullAddress || [delivery.address1, delivery.address2, delivery.city, delivery.country]
    .filter(Boolean)
    .join(", ");
}

function firstShipmentValue(shipment, keys) {
  const sources = [shipment.tms || {}, shipment.freight || {}, shipment.cargo || {}, shipment];
  for (const source of sources) {
    for (const key of keys) {
      const value = source?.[key];
      if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
    }
  }
  return "";
}

function shipmentDimensionsLine(shipment) {
  const direct = firstShipmentValue(shipment, ["dimensions", "dims", "dimension", "cargoDimensions"]);
  if (direct) return direct;
  const length = firstShipmentValue(shipment, ["length", "dimLength"]);
  const width = firstShipmentValue(shipment, ["width", "dimWidth"]);
  const height = firstShipmentValue(shipment, ["height", "dimHeight"]);
  if (!length || !width || !height) return "";
  const uom = firstShipmentValue(shipment, ["dimUom", "dimensionUom", "dimsUom"]) || "in";
  return `${length} x ${width} x ${height} ${uom}`;
}

function shipmentWeightDisplay(weight, weightUom) {
  const value = String(weight || "").trim();
  if (!value) return "";
  if (/\b(?:kg|kgs|lb|lbs)\b/i.test(value)) return value;
  return `${value} ${weightUom || "KG"}`.trim();
}

function shipmentFreightDetailsLine(shipment) {
  const pieces = firstShipmentValue(shipment, ["pieces", "pieceCount", "pcs"]);
  const pallets = firstShipmentValue(shipment, ["pallets", "palletCount", "skids", "skidCount"]);
  const weight = firstShipmentValue(shipment, ["weight", "grossWeight"]);
  const weightUom = firstShipmentValue(shipment, ["weightUom", "weightUnit", "grossWeightUom"]) || "KG";
  const dimensions = shipmentDimensionsLine(shipment);
  const parts = [
    pallets ? `${pallets} ${Number(pallets) === 1 ? "pallet" : "pallets"}` : "",
    pieces ? `${pieces} ${Number(pieces) === 1 ? "pc" : "pcs"}` : "",
    dimensions,
    shipmentWeightDisplay(weight, weightUom),
  ].filter(Boolean);
  return parts.length ? `Freight: ${parts.join(" · ")}` : "";
}

function quoteCustomsContextLine(shipment) {
  const status = shipment.customsBroker?.status || "";
  if (!status) return "";
  if (isCustomsResolvedStatus(status)) return "Release/DO confirmed.";
  if (/hold|exam/i.test(status)) return "Customs hold/exam pending.";
  return "";
}

function quoteEmailBody(shipment) {
  const delivery = shipment.delivery || {};
  const consignee = shipment.consignee || delivery.consignee || "";
  const address = shipmentDeliveryAddress(shipment);
  const prearrival = freightNeedsQuotePrep(shipment);
  return actionBody([
    "Hi,",
    "",
    `Can you please quote pickup/delivery for AWB ${shipment.awb}?`,
    prearrival ? "Pre-arrival quote for pickup after availability/release." : "",
    "",
    `${[shipment.station, shipment.airline].filter(Boolean).join(" · ")}`,
    shipment.eta ? `ETA: ${shipment.eta}` : "",
    quoteCustomsContextLine(shipment),
    consignee || address ? `Deliver to: ${[consignee, address].filter(Boolean).join(" · ")}` : "",
    shipmentFreightDetailsLine(shipment),
    "",
    "Please confirm your rate and earliest pickup time.",
    "",
    "Thank you,",
    "Alex",
  ]);
}

function isPickupDeliveryQuote(quote) {
  const directText = [
    quote?.broker,
    quote?.service,
    quote?.rate,
  ].filter(Boolean).join(" ").toLowerCase();
  const text = [
    quote?.broker,
    quote?.service,
    quote?.rate,
    ...(Array.isArray(quote?.evidence) ? quote.evidence : [quote?.evidence]),
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\b(cargosprint|payment|paid|receipt|amount paid|station fee|terminal fee|storage|last free|free day|demurrage|not delivery|not pickup|customs bond|bond fee|7501|dut(?:y|ies)|clearance|customs|handling)\b/.test(directText)) {
    return false;
  }
  if (["station-cost", "customs-cost", "air-freight"].includes(quote?.category)) return false;
  if (/\b(air freight|air booking|air export|export operation|booking request|requested flight|awb number|destination|dap|ddp|per kg|\/kg|all in|via ath)\b/.test(directText)) {
    return false;
  }
  if (/\b(pickup|delivery|deliver|truck|trucker|straight|box truck|flatbed|hotshot|ltl|recover|recovery)\b/.test(directText)) {
    return true;
  }
  if (quote?.category === "pickup-delivery") return true;
  const pickupSignals = /\b(pickup|delivery|deliver|truck|trucker|straight|box truck|flatbed|hotshot|ltl|recover)\b/.test(directText) ||
    (
      !/\b(cargosprint|payment|paid|receipt|amount paid|station fee|terminal fee|storage|last free|free day|demurrage|not delivery|not pickup|customs bond|bond fee|7501|dut(?:y|ies)|clearance|customs|handling|air freight|air booking|air export|export operation|booking request|requested flight|awb number|destination|dap|ddp|per kg|\/kg|all in|via ath)\b/.test(text) &&
      /\b(pickup|delivery|deliver|truck|trucker|straight|box truck|flatbed|hotshot|ltl|recover)\b/.test(text)
    );
  if (pickupSignals) return true;
  return false;
}

function hasPickupBrokerQuotes(shipment) {
  return Array.isArray(shipment.freightBroker?.quotes) && shipment.freightBroker.quotes.some(isPickupDeliveryQuote);
}

function freightHasActivePickupOwner(shipment) {
  const freight = shipment.freightBroker || {};
  const broker = String(freight.broker || freight.name || "").trim();
  if (!broker || broker === "Not found") return false;
  const status = String(freight.status || "").toLowerCase();
  if ([
    "broker-acknowledged-payment-delivered",
    "freight-awarded",
    "freight-ready-pickup-pod-needed",
    "loaded-on-ltl-truck",
    "payment-confirmed-casey-hart-awarded-ready-for-pickup",
    "pod-followup-needed",
    "rapid-confirmed-payment-release-do-pod-needed",
    "rapid-release-paperwork-sent-payment-confirmed-pod-needed",
    "release-visible-pickup-cleared",
  ].includes(status)) return true;
  const executionText = [
    status,
    freight.brokerStatus,
    freight.pickupPlan,
    freight.nextAction,
  ].filter(Boolean).join(" ");
  if (/\b(awarded|docs-sent|dispatched|pickup-confirmed|payment-confirmed|do-received|release-paperwork|pickup-ready|pod-pending)\b/i.test(executionText)) {
    return true;
  }
  return freight.cargoAvailable === true &&
    freight.cargoReleased === true &&
    /\b(pickup|recover|pod|release paperwork|payment|dispatch|assigned|award)\b/i.test(executionText);
}

function pickupQuoteRecords(shipment) {
  const quotes = Array.isArray(shipment.freightBroker?.quotes) ? shipment.freightBroker.quotes : [];
  const recommended = shipment.freightBroker?.recommendedAward;
  const rows = [...quotes];
  if (
    recommended?.broker &&
    Number.isFinite(Number(recommended.amount)) &&
    !rows.some((quote) =>
      String(quote.broker || "").toLowerCase() === String(recommended.broker || "").toLowerCase() &&
      Number(quote.amount) === Number(recommended.amount)
    )
  ) {
    rows.push(recommended);
  }
  return rows
    .filter((quote) => quote?.broker && Number.isFinite(Number(quote.amount)) && isPickupDeliveryQuote(quote))
    .sort((a, b) => Number(a.amount) - Number(b.amount) || String(a.broker).localeCompare(String(b.broker)));
}

function actionablePickupQuoteRecords(shipment) {
  return pickupQuoteRecords(shipment).filter(isActionablePickupQuote);
}

function shouldRequestBrokerQuotes(shipment) {
  if (pickupOrDeliveryAlreadyAdvanced(shipment)) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (stationFeeBlocksShipment(shipment)) return false;
  if (freightHasActivePickupOwner(shipment)) return false;
  if (hasPickupBrokerQuotes(shipment)) return false;

  const freightStatus = shipment.freightBroker?.status || "freight-missing";
  const quoteableFreightStatus = isFreightMissingLikeStatus(freightStatus) || [
    "freight-missing",
    "freight-requested",
    "freight-unknown",
    "freight-ready-for-pickup-quotes",
    "freight-release-ready",
    "freight-planned-dedicated-truck-needed",
    "customs-released-pickup-needed",
    "quote-drafts-created-no-replies",
    "customs-released-pickup-quote-drafts-ready",
  ].includes(freightStatus);
  if (!quoteableFreightStatus) return false;

  if (freightNeedsQuotePrep(shipment)) return true;
  if (!(shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready")) return false;
  return isCustomsResolvedStatus(shipment.customsBroker?.status || "");
}

function quoteRequestActions(shipment) {
  if (!shouldRequestBrokerQuotes(shipment)) return [];

  const requestedEmails = new Set(
    (shipment.actionHistory || [])
      .filter((event) => event.type === "quote-request")
      .filter((event) => ["queued", "drafted", "sent"].includes(event.status))
      .map((event) => String(event.targetEmail || "").toLowerCase())
      .filter(Boolean)
  );
  const prearrivalCheck = prearrivalQuotePrepCheck(shipment);
  const prearrival = freightNeedsQuotePrep(shipment);
  return quoteBrokers
    .filter((broker) => !requestedEmails.has(broker.email.toLowerCase()))
    .map((broker) => {
      return {
        id: quoteActionId(shipment, broker),
        shipmentId: shipment.id,
        awb: shipment.awb,
        type: "quote-request",
        label: prearrival ? "Prep pickup quote" : "Quote request",
        channel: "gmail",
        execution: "quote-email-draft",
        safety: safetyForChannel("gmail"),
        status: "suggested",
        priority: prearrival ? "normal" : "high",
        targetName: broker.name,
        targetEmail: broker.email,
        cc: quoteCc,
        missing: [],
        subject: `Quote request - AWB ${shipment.awb} - ${shipment.station || "pickup"}`,
        replyMessageId: "",
        conversation: null,
        body: quoteEmailBody(shipment),
        reason: prearrival
          ? prearrivalCheck
            ? `${prearrivalCheck.detail} Draft ${broker.name} quote request.`
            : `Prepare ${broker.name} quote before arrival so pickup can move fast.`
          : `Ask ${broker.name} for rate and earliest pickup.`,
        timing: {
          stage: prearrival ? "prearrival-quote-prep" : "ready-for-pickup-quotes",
          trigger: prearrival ? "eta-within-quote-lead-window" : "arrived-or-ready-no-pickup-quotes",
          leadHours: prearrivalCheck?.leadHours || "",
          eta: prearrivalCheck?.eta?.toISOString?.() || "",
        },
        evidence: actionEvidence(shipment),
        orderLink: shipment.tms?.orderLink || "",
      };
    });
}

function quoteFollowupHistory(shipment, now = new Date()) {
  if (freightHasActivePickupOwner(shipment)) return [];
  if (hasPickupBrokerQuotes(shipment)) return [];
  const thresholdMs = Math.max(1, quoteFollowupAfterHours) * 60 * 60 * 1000;
  const quoteEvents = (shipment.actionHistory || [])
    .filter((event) => event.type === "quote-request")
    .filter((event) => ["drafted", "sent"].includes(event.status))
    .filter((event) => {
      const at = Date.parse(event.at || "");
      return Number.isFinite(at) && now.getTime() - at >= thresholdMs;
    });
  const followupAlreadyExists = new Set(
    (shipment.actionHistory || [])
      .filter((event) => event.type === "quote-followup")
      .map((event) => String(event.targetEmail || "").toLowerCase())
  );

  return quoteEvents.filter((event) => !followupAlreadyExists.has(String(event.targetEmail || "").toLowerCase()));
}

function quoteFollowupActionId(shipment, event) {
  const awb = String(shipment.awb || shipment.id || "shipment").replace(/\W+/g, "");
  const emailKey = String(event.targetEmail || event.targetName || "broker").toLowerCase().replace(/\W+/g, "");
  return `${awb}-quote-followup-${emailKey}`;
}

function replyMessageIdForEvent(event) {
  return event?.replyMessageId || event?.gmailMessageId || event?.messageId || "";
}

function eventReplyMessageId(event) {
  if (!event || typeof event !== "object") return "";
  const evidenceText = typeof event.evidence === "string" ? event.evidence : "";
  const evidenceMessage = evidenceText.match(/\bmessage\s+([a-f0-9]{12,})\b/i)?.[1] || "";
  return (
    event.replyMessageId ||
    event.gmailMessageId ||
    event.messageId ||
    event.evidence?.messageId ||
    evidenceMessage ||
    (Array.isArray(event.evidence) ? event.evidence.find((item) => item?.messageId)?.messageId : "") ||
    ""
  );
}

function eventSubject(event) {
  if (!event || typeof event !== "object") return "";
  return String(event.subject || event.emailSubject || event.threadSubject || "").trim();
}

function threadCandidateText(event) {
  if (!event || typeof event !== "object") return "";
  const evidence = Array.isArray(event.evidence) ? event.evidence : [event.evidence];
  return [
    event.type,
    event.label,
    event.summary,
    event.note,
    event.subject,
    event.targetName,
    event.targetEmail,
    event.contactEmail,
    event.from,
    event.to,
    event.cc,
    ...evidence.map((item) =>
      item && typeof item === "object"
        ? [item.label, item.summary, item.note, item.source, item.contactEmail, item.messageId].filter(Boolean).join(" ")
        : item
    ),
  ].filter(Boolean).join(" ");
}

function threadCandidatePool(shipment) {
  return [
    ...(shipment.actionHistory || []),
    ...(shipment.eodFacts || []),
    ...(shipment.freightBroker?.evidence || []),
    ...(shipment.customsBroker?.evidence || []),
    ...(shipment.emailValidation?.proof || []),
  ];
}

function byNewestThreadEvidence(a, b) {
  return (
    (Date.parse(operationalFactTime(b) || "") || actionEventTime(b)) -
    (Date.parse(operationalFactTime(a) || "") || actionEventTime(a))
  );
}

function latestThreadReplyMessageId(shipment, pattern) {
  return (
    threadCandidatePool(shipment)
      .filter((event) => pattern.test(threadCandidateText(event)))
      .sort(byNewestThreadEvidence)
      .map(eventReplyMessageId)
      .find(Boolean) || ""
  );
}

function targetThreadReplyMessageId(shipment, targetEmail, pattern) {
  const targetEmails = contactEmailList(targetEmail);
  if (!targetEmails.length) return "";
  return (
    threadCandidatePool(shipment)
      .filter((event) => {
        const text = threadCandidateText(event).toLowerCase();
        return targetEmails.some((email) => text.includes(email)) && pattern.test(text);
      })
      .sort(byNewestThreadEvidence)
      .map(eventReplyMessageId)
      .find(Boolean) || ""
  );
}

function targetThreadSubject(shipment, targetEmail, pattern, fallback) {
  const targetEmails = contactEmailList(targetEmail);
  if (!targetEmails.length) return fallback;
  const event = threadCandidatePool(shipment)
    .filter((candidate) => {
      const text = threadCandidateText(candidate).toLowerCase();
      return eventReplyMessageId(candidate) && targetEmails.some((email) => text.includes(email)) && pattern.test(text);
    })
    .sort(byNewestThreadEvidence)
    .find((candidate) => eventSubject(candidate));
  const subject = eventSubject(event);
  if (!subject) return fallback;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function conversationForReply(replyMessageId, kind, stage, extra = {}) {
  return replyMessageId ? { kind, replyMessageId, stage, ...extra } : null;
}

function latestThreadSubject(shipment, pattern, fallback) {
  const event = threadCandidatePool(shipment)
    .filter((candidate) => eventReplyMessageId(candidate) && pattern.test(threadCandidateText(candidate)))
    .sort(byNewestThreadEvidence)
    .find((candidate) => eventSubject(candidate));
  const subject = eventSubject(event);
  if (!subject) return fallback;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function followupSubject(prefix, shipment, event) {
  const existingSubject = String(event?.subject || "").trim();
  if (existingSubject && /\bAWB\b/i.test(existingSubject)) {
    return /^re:/i.test(existingSubject) ? existingSubject : `Re: ${existingSubject}`;
  }
  return `${prefix} - AWB ${shipment.awb} - ${shipment.station || "pickup"}`;
}

function quoteFollowupActions(shipment) {
  const history = quoteFollowupHistory(shipment);
  if (!history.length) return [];
  return history.map((event) => {
    const replyMessageId = replyMessageIdForEvent(event) ||
      targetThreadReplyMessageId(shipment, event.targetEmail, /quote|rate|pickup|delivery|broker/i);
    return {
      id: quoteFollowupActionId(shipment, event),
      shipmentId: shipment.id,
      awb: shipment.awb,
      type: "quote-followup",
      label: "Follow up quote",
      channel: "gmail",
      execution: "draft-only",
      safety: safetyForChannel("gmail"),
      status: "suggested",
      priority: "high",
      targetName: event.targetName || KNOWN_ACTION_RECIPIENTS.get(String(event.targetEmail || "").toLowerCase()) || "Broker",
      targetEmail: event.targetEmail || "",
      cc: quoteCc,
      missing: event.targetEmail ? [] : ["Broker email missing"],
      subject: followupSubject("Follow up quote request", shipment, event),
      replyMessageId,
      conversation: conversationForReply(replyMessageId, "broker-quote-thread", "waiting-for-broker-quote", {
        previousActionId: event.actionId || "",
        previousStatus: event.status || "",
        previousTargetEmail: event.targetEmail || "",
      }),
      body: actionBody([
        "Hi,",
        "",
        replyMessageId
          ? `Any update on AWB ${shipment.awb} quote?`
          : `Can you please send your rate and earliest pickup time for AWB ${shipment.awb}?`,
        "",
        "Thank you,",
        "Alex",
      ]),
      reason: `No pickup quote found after prior quote draft to ${event.targetName || event.targetEmail}.`,
      timing: {
        stage: "broker-quote-followup",
        trigger: "prior-quote-request-no-rate",
        thresholdHours: Math.max(1, quoteFollowupAfterHours),
      },
      evidence: unique([event.summary, event.subject, shipment.freightBroker?.nextAction]).slice(0, 3),
      orderLink: shipment.tms?.orderLink || "",
    };
  });
}

function recommendedPickupQuote(shipment) {
  const recommended = shipment.freightBroker?.recommendedAward;
  if (recommended?.broker && Number.isFinite(Number(recommended.amount)) && isActionablePickupQuote(recommended)) {
    return recommended;
  }
  return actionablePickupQuoteRecords(shipment)[0] || null;
}

function canAwardPickupBroker(shipment) {
  if (pickupOrDeliveryAlreadyAdvanced(shipment)) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (freightHasActivePickupOwner(shipment)) return false;
  if (!(shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready")) return false;
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return false;
  if (shipment.freightBroker?.cargoAvailable === false || shipment.freightBroker?.cargoReleased === false) {
    return false;
  }
  return true;
}

function memoryDateTime(value) {
  const date = Date.parse(`${String(value || "").slice(0, 10)}T12:00:00`);
  return Number.isFinite(date) ? date : 0;
}

function storageRiskForShipment(shipment, now = new Date()) {
  const storage = shipment.operationalMemory?.storage || shipment.stationContext?.storage;
  if (!storage || storage.status !== "known") return null;
  if (pickupOrDeliveryAlreadyAdvanced(shipment)) return null;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return null;
  if (!(shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready")) return null;

  const today = Date.parse(`${toIsoDate(now)}T12:00:00`);
  const startsAt = memoryDateTime(storage.storageStartsAt);
  const lastFree = memoryDateTime(storage.lastFreeDay);
  const accruingSince = memoryDateTime(storage.storageAccruingSince);
  const storageKnownWithoutDate = storage.dailyStorageRate && !startsAt && !lastFree && !accruingSince;

  if (accruingSince && accruingSince <= today) {
    return {
      level: "critical",
      label: "Storage accruing",
      detail: `Storage accruing since ${storage.storageAccruingSince}${storage.dailyStorageRate ? ` · ${storage.dailyStorageRate}` : ""}`,
    };
  }
  if (startsAt && startsAt <= today) {
    return {
      level: "critical",
      label: "Storage starts",
      detail: `Storage starts ${storage.storageStartsAt}${storage.dailyStorageRate ? ` · ${storage.dailyStorageRate}` : ""}`,
    };
  }
  if (lastFree && lastFree <= today) {
    const storageLikelyStarted = lastFree < today;
    return {
      level: storageLikelyStarted ? "critical" : "high",
      label: storageLikelyStarted ? "Storage likely started" : "Last free day",
      detail: `${storageLikelyStarted ? "LFD passed" : "Last free day"} ${storage.lastFreeDay}${storage.dailyStorageRate ? ` · ${storage.dailyStorageRate}` : ""}`,
    };
  }
  if (storageKnownWithoutDate) {
    return {
      level: "high",
      label: "Storage rate known",
      detail: `Storage rate ${storage.dailyStorageRate}`,
    };
  }
  return null;
}

function storageRiskAction(shipment) {
  const risk = storageRiskForShipment(shipment);
  if (!risk) return null;
  const stationRoute = stationContactRoute(shipment);
  const needsStationContact = !stationRoute.email;
  const targetEmail = needsStationContact ? opsEscalationEmail : stationRoute.email;
  const storage = shipment.operationalMemory?.storage || shipment.stationContext?.storage || {};
  const timingTrigger = risk.level === "critical"
    ? "storage-accruing-or-started"
    : risk.label === "Last free day"
      ? "last-free-day-reached"
      : "storage-rate-known-no-cutoff";
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-storage-risk`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "storage-risk",
    label: needsStationContact ? "Resolve storage contact" : risk.label,
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    timing: {
      stage: "storage-risk",
      trigger: needsStationContact ? "station-storage-contact-missing" : timingTrigger,
      lastFreeDay: storage.lastFreeDay || "",
      storageStartsAt: storage.storageStartsAt || "",
      storageAccruingSince: storage.storageAccruingSince || "",
      dailyStorageRate: storage.dailyStorageRate || "",
    },
    targetName: needsStationContact ? "PQ ops" : `${shipment.station || "Station"} storage desk`,
    targetEmail,
    stationContactMissing: needsStationContact,
    originalTargetName: `${shipment.station || "Station"} storage desk`,
    originalTargetEmail: stationRoute.originalEmail,
    missing: targetEmail ? [] : ["PQ ops email missing"],
    subject: `${shipment.awb} - storage / last free day check`,
    body: needsStationContact
      ? actionBody([
          "Team,",
          "",
          `${risk.detail}. ${stationRoute.missingReason}`,
          "",
          `AWB: ${shipment.awb}`,
          shipment.station ? `Airport: ${shipment.station}` : "",
          shipment.airline ? `Carrier: ${shipment.airline}` : "",
          shipment.client ? `Client: ${shipment.client}` : "",
          stationRoute.originalEmail ? `Rejected station email candidate: ${stationRoute.originalEmail}` : "",
          "",
          "Find the real station/storage desk, confirm storage or last free day, and save the contact to station memory.",
        ])
      : actionBody([
          "Hi,",
          "",
          `Can you please confirm current storage / last free day status for AWB ${shipment.awb}?`,
          risk.detail,
          "",
          "Please also confirm if any payment or release step is needed before pickup.",
          "",
          "Thank you,",
          "Alex",
        ]),
    reason: needsStationContact ? `${risk.detail}; ${stationRoute.missingReason}` : risk.detail,
    evidence: unique([
      needsStationContact ? stationRoute.missingReason : "",
      ...(storage.evidence || []),
      ...(shipment.freightBroker?.evidence || []).map((item) => item?.note || item),
      shipment.emailValidation?.summary,
    ]).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function stationFeeEvidenceText(shipment) {
  const money = shipment.money || {};
  const feesGate = shipment.opsState?.gates?.fees || {};
  return [
    shipment.opsState?.phase,
    shipment.opsState?.label,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    feesGate.status,
    feesGate.label,
    feesGate.evidence,
    feesGate.summary,
    ...(money.stationPayments || []).map(evidenceItemText),
    ...(money.evidence || []).map(evidenceItemText),
    ...(shipment.facts || []).map(factText),
    ...(shipment.eodFacts || []).map(factText),
  ].filter(Boolean).join(" ");
}

function stationFeeLine(shipment) {
  const explicit = [
    shipment.opsState?.summary,
    shipment.opsState?.gates?.fees?.evidence,
    shipment.opsState?.nextAction,
  ].find((value) => /\b(?:ground fees?|station fees?|terminal charges?|handling charges?|storage charges?|balance due|\$\s*\d|payment)\b/i.test(String(value || "")));
  if (explicit) return String(explicit).replace(/[.\s]+$/g, "").trim();

  const evidence = stationFeeEvidenceText(shipment);
  if (!/\b(cargosprint|sprintpay|paycargo|station fee|terminal fee|ground fees?|handling|payment|invoice|balance due|\$\s*\d)/i.test(evidence)) return "";
  const amount = evidence.match(/\$\s*[\d,.]+/)?.[0]?.replace(/[.\s]+$/g, "").replace(/\s+/g, "") || "";
  const handler = /sprintpay/i.test(evidence)
    ? "SprintPay"
    : /cargosprint/i.test(evidence)
      ? "CargoSprint"
      : /paycargo/i.test(evidence)
        ? "PayCargo"
        : "station";
  const due = /\b(?:due|unpaid|pending|not paid|need(?:s)? payment|balance|invoice)\b/i.test(evidence);
  const paid = !due && /\b(?:paid|payment confirmation|receipt|confirmed)\b/i.test(evidence);
  if (paid) return `Ground fees: ${amount ? `${amount} ` : ""}paid via ${handler}`;
  return `Ground fees: ${amount ? `${amount} ` : ""}due via ${handler}`;
}

function stationFeeBlocksShipment(shipment) {
  if (!shipment || canonicalPodComplete(shipment)) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  const phase = String(shipment.opsState?.phase || "").toLowerCase();
  const gateStatus = String(shipment.opsState?.gates?.fees?.status || "").toLowerCase();
  const text = stationFeeEvidenceText(shipment);
  const paid = /\b(?:paid|payment confirmation|receipt|confirmed|not blocking|did not block)\b/i.test(text);
  const due = /\b(?:due|unpaid|pending|not paid|needs? payment|balance due|invoice|pay or confirm ground handling fees)\b/i.test(text);
  if (paid && !due && phase !== "fees-needed") return false;
  return phase === "fees-needed" ||
    ["due", "pending", "unpaid"].includes(gateStatus) ||
    (/\b(?:ground fees?|station fees?|terminal charges?|handling charges?|balance due|pay or confirm ground handling fees)\b/i.test(text) && due);
}

function stationPhoneForShipment(shipment) {
  return [
    shipment.stationPhone,
    shipment.stationContext?.phone,
    shipment.stationContext?.stationPhone,
  ].find(isKnownContact) || "";
}

function stationFeeConfirmationAction(shipment) {
  if (!stationFeeBlocksShipment(shipment)) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const stationRoute = stationContactRoute(shipment);
  const stationEmail = stationRoute.email || "";
  const stationPhone = stationPhoneForShipment(shipment);
  const stationName = [shipment.station, shipment.handler || shipment.airline || "station"].filter(Boolean).join(" ").trim();
  const feeLine = stationFeeLine(shipment) || "Ground handling fees are not confirmed";
  const hasStationContact = Boolean(stationEmail || stationPhone);
  const problem = `${feeLine} is blocking pickup/release execution.`;
  const nextAction = hasStationContact
    ? `Call or email ${stationName || "the station"} to confirm/pay the fees, save the amount/receipt, then release files to the pickup broker.`
    : "Find the station fee desk contact, confirm/pay the fees, save the amount/receipt, then release files to the pickup broker.";
  return {
    id: `${awbKey}-station-fee-confirmation`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "station-fee-confirmation",
    label: "Confirm/pay ground fees",
    channel: "platform",
    ...internalPlatformContract(
      "operator-browser-truth",
      "Record fee truth",
      "Operator-approved structured phone fact. The dashboard appends exact fee evidence to the relational operator-event authority; canonical truth changes only after the truth worker reduces it.",
    ),
    status: "suggested",
    priority: "urgent",
    targetName: hasStationContact ? `${stationName || "Station"} fee desk` : "Operator",
    targetEmail: "",
    targetRole: "station",
    targetPhone: stationPhone,
    stationPhone,
    stationEmail: stationEmail || stationRoute.originalEmail || "",
    stationContactMissing: !hasStationContact,
    originalTargetName: `${stationName || "Station"} fee desk`,
    originalTargetEmail: stationEmail || stationRoute.originalEmail || "",
    missing: hasStationContact ? [] : ["station fee contact"],
    subject: `${shipment.awb} - ground fees confirmation`,
    problem,
    reason: `${problem} ${nextAction}`,
    nextAction,
    body: actionBody([
      `AWB ${shipment.awb}: ${problem}`,
      shipment.station ? `Airport: ${shipment.station}` : "",
      shipment.airline ? `Carrier: ${shipment.airline}` : "",
      shipment.client ? `Client: ${shipment.client}` : "",
      stationEmail ? `Station email: ${stationEmail}` : "",
      stationPhone ? `Station phone: ${stationPhone}` : "",
      `Next action: ${nextAction}`,
      "",
      "Update the shipment with the fee amount, payment/receipt proof, or the exact blocker from the station.",
    ]),
    timing: {
      stage: "fees-needed",
      trigger: "ground-fees-due",
      feeLine,
    },
    evidence: unique([feeLine, shipment.opsState?.nextAction, ...actionEvidence(shipment)]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function liveDriverReleaseOrDoProblemForShipment(shipment) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return null;
  const freight = shipment.freightBroker || {};
  const text = [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.operationalUnderstanding?.label,
    shipment.operationalUnderstanding?.nextAction,
    shipment.opsState?.label,
    shipment.opsState?.nextAction,
    freight.status,
    freight.brokerStatus,
    freight.pickupPlan,
    freight.nextAction,
    ...(freight.evidence || []).map((item) => `${item?.label || ""} ${item?.note || item}`),
    ...(shipment.eodFacts || []).map((item) => factText(item)),
  ].join(" ");
  const driverLive = /\b(?:driver|truck|carrier|broker)\b.{0,80}\b(?:on[-\s]?site|at (?:airport|station|warehouse|pickup)|checked[-\s]?in|waiting|standby|dispatched|sent|sitting|detention|cannot pickup|can'?t pickup|refused)\b|\b(?:on[-\s]?site|checked[-\s]?in|waiting|standby|detention)\b.{0,80}\b(?:driver|truck|carrier)\b/i.test(text);
  if (!driverLive) return null;
  const stationCannotSeeRelease = /\b(?:station|carrier|airline|warehouse|agent|terminal)\b[^.;\n]{0,100}\b(?:not|does not|doesn'?t|cannot|can'?t|won'?t|will not|refus(?:e|ed|ing))\b[^.;\n]{0,100}\b(?:see|show|have|find|release|clearance|clear|d\/?o|delivery order)\b/i.test(text);
  const releaseNotVisible = /\b(?:release|clearance|customs release|d\/?o|delivery order)[^.;\n]{0,100}\b(?:not|isn'?t|is not|does not|doesn'?t|cannot|can'?t|missing|pending)[^.;\n]{0,70}\b(?:system|visible|show|showing|seen|found|available|accepted|released|cleared)\b/i.test(text);
  const holdBlocking = /\b(?:customs hold|1[-\s]?h\b|hold not removed|not released|not cleared|release pending|clearance pending)\b/i.test(text);
  const doProblem = /\b(?:d\/?o|delivery order)[^.;\n]{0,100}\b(?:wrong|incorrect|bad|invalid|missing|does not state|doesn'?t state|no driver name|wrong driver|driver name missing|needs? (?:to be )?corrected|needs? correction|please correct|must correct|reissue|re-send|resend)\b|\b(?:wrong|incorrect|bad|invalid|missing|no driver name|wrong driver|driver name missing|needs? (?:to be )?corrected|needs? correction|please correct|must correct|reissue|re-send|resend)[^.;\n]{0,100}\b(?:d\/?o|delivery order)\b/i.test(text);
  if (!stationCannotSeeRelease && !releaseNotVisible && !holdBlocking && !doProblem) return null;
  const customsResolved = isCustomsResolvedStatus(shipment.customsBroker?.status || "");
  if (customsResolved && !doProblem) {
    if (shipment.opsState?.phase === "pickup-blocked") {
      return {
        label: shipment.opsState?.label || "Pickup blocked",
        reason: shipment.opsState?.summary || "Pickup is blocked after release; station and pickup broker need to confirm the cargo handoff.",
        nextAction: shipment.opsState?.nextAction || "Call the station and pickup broker before keeping the driver on standby.",
      };
    }
    return null;
  }
  const reason = doProblem
    ? "Driver is waiting because the delivery order is wrong or missing driver details."
    : "Driver is waiting because the station cannot release/clear the shipment.";
  const nextAction = doProblem
    ? "Call the station to confirm exactly what is wrong on the DO, correct/resend it, and update the pickup broker before detention grows."
    : "Call the station to confirm release visibility, then ask the customs broker to retransmit release/DO if needed before detention grows.";
  return {
    label: doProblem ? "Driver waiting on DO fix" : "Driver waiting on release",
    reason,
    nextAction,
  };
}

function severeExceptionForShipment(shipment) {
  const operationalException = shipment.operationalException || operationalExceptionForShipment(shipment);
  const customsText = `${shipment.customsBroker?.status || ""} ${shipment.customsBroker?.nextAction || ""} ${shipment.freightBroker?.status || ""} ${shipment.freightBroker?.pickupPlan || ""}`;
  const holdOrExam = /\bhold|exam|examination|1-h\b/i.test(customsText);
  const storageRisk = storageRiskForShipment(shipment);
  const conflict = shipment.emailValidation?.status === "email-conflict" ||
    shipment.trackingException?.type === "email-conflicts-with-carrier-arrival";
  const liveDriverProblem = liveDriverReleaseOrDoProblemForShipment(shipment);

  if (liveDriverProblem) return liveDriverProblem;
  if (operationalException) {
    return {
      label: operationalException.label,
      reason: operationalException.summary,
      nextAction: operationalException.nextAction,
    };
  }
  if (conflict) {
    return {
      label: "Resolve conflict",
      reason: shipment.trackingException?.summary || shipment.emailValidation?.summary || "Email conflicts with tracking/TMS.",
      nextAction: shipment.trackingException?.nextAction || shipment.emailValidation?.nextAction || shipment.opsState?.nextAction,
    };
  }
  if (pickupBlockedByReleaseMismatch(shipment)) {
    return {
      label: "Release mismatch",
      reason: shipment.emailValidation?.summary || shipment.freightBroker?.pickupPlan || "Carrier/broker says the station system does not show the release.",
      nextAction: shipment.freightBroker?.nextAction || shipment.emailValidation?.nextAction || "Resolve release mismatch before pickup can proceed.",
    };
  }
  if (holdOrExam && storageRisk) {
    return {
      label: "Hold + storage",
      reason: `${storageRisk.detail}; customs hold/exam is still blocking recovery.`,
      nextAction: shipment.customsBroker?.nextAction || shipment.opsState?.nextAction || "Resolve hold before dispatch.",
    };
  }
  return null;
}

function opsEscalationAction(shipment) {
  const exception = severeExceptionForShipment(shipment);
  if (!exception) return null;
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-ops-escalation`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "ops-escalation",
    label: exception.label,
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: "PQ ops",
    targetEmail: opsEscalationEmail,
    missing: opsEscalationEmail ? [] : ["Ops escalation email missing"],
    subject: `Ops exception - AWB ${shipment.awb} - ${exception.label}`,
    body: actionBody([
      "Team,",
      "",
      `Ops exception for AWB ${shipment.awb}: ${exception.reason}`,
      shipment.station ? `Airport: ${shipment.station}` : "",
      shipment.client ? `Client: ${shipment.client}` : "",
      exception.nextAction ? `Suggested next step: ${exception.nextAction}` : "",
      shipment.stationPhone ? `Station phone: ${shipment.stationPhone}` : "",
      shipment.stationEmail ? `Station email: ${shipment.stationEmail}` : "",
      shipment.customsBroker?.contactEmail ? `Customs email: ${shipment.customsBroker.contactEmail}` : "",
      shipment.freightBroker?.contactEmail ? `Pickup broker email: ${shipment.freightBroker.contactEmail}` : "",
      shipment.customsBroker?.broker ? `Customs: ${shipment.customsBroker.broker} / ${shipment.customsBroker.status || "unknown"}` : "",
      shipment.freightBroker?.broker ? `Freight: ${shipment.freightBroker.broker} / ${shipment.freightBroker.status || "unknown"}` : "",
      "",
      "This is a draft-only internal escalation from the PQ beta agent.",
    ]),
    reason: exception.reason,
    evidence: unique([
      shipment.trackingException?.type === "carrier-tracking-unavailable" ? "" : shipment.trackingException?.summary,
      shipment.emailValidation?.summary,
      ...(shipment.customsBroker?.evidence || []).map(evidenceItemText),
      ...(shipment.freightBroker?.evidence || []).map(evidenceItemText),
    ]).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function quoteAmountLabel(quote) {
  if (quote?.rate) return quote.rate;
  return formatMoney(Number(quote?.amount || 0), quote?.currency || "USD");
}

function compactMoneyValue(value) {
  const amount = normalizeMoneyAmount(value);
  if (amount) return formatMoney(amount);
  return String(value || "").replace(/[.;,\s]+$/, "").trim();
}

function costContextForAward(shipment) {
  const money = shipment.operationalMemory?.money || {};
  const stationPayments = unique((money.stationPayments || []).map(compactMoneyValue).filter(Boolean));
  const lines = [
    money.customerCharge ? `Customer charge: ${money.customerCharge}` : "",
    money.vendorCost ? `Vendor cost: ${money.vendorCost}` : "",
    money.workingBudget?.label ? `Working room: ${money.workingBudget.label} (${money.workingBudget.basis})` : "",
    stationPayments.length ? `Known station/payment costs: ${stationPayments.join(", ")}` : "",
    money.marginKnown ? "Margin context is available in TMS." : "Margin unknown until customer charge and vendor costs are confirmed.",
  ].filter(Boolean);
  return {
    summary: money.workingBudget?.label
      ? `Working room ${money.workingBudget.label}`
      : stationPayments.length
      ? `Known station/payment ${stationPayments.join(", ")}`
      : money.marginKnown
      ? "Margin context in TMS"
      : "Margin unknown",
    lines,
    stationPayments,
    marginKnown: Boolean(money.marginKnown),
    workingBudget: money.workingBudget || null,
  };
}

function moneyValueKnown(value) {
  return Boolean(String(value || "").trim());
}

function moneyValueNeedsReview(value) {
  if (!moneyValueKnown(value)) return true;
  const amount = normalizeMoneyAmount(value);
  return amount !== null && amount <= 0;
}

function moneyContextMarginKnown(customerCharge, vendorCost, freightQuoteOrAward) {
  if (!moneyValueKnown(customerCharge) || moneyValueNeedsReview(customerCharge)) return false;
  if (moneyValueKnown(vendorCost) && !moneyValueNeedsReview(vendorCost)) return true;
  return moneyValueKnown(freightQuoteOrAward) && !moneyValueNeedsReview(freightQuoteOrAward);
}

function moneyGapLabel(label, value) {
  if (!moneyValueKnown(value)) return label;
  if (moneyValueNeedsReview(value)) return `${label} is ${compactMoneyValue(value) || value}`;
  return "";
}

function stationMemoryGapForShipment(shipment) {
  const source = shipment.stationContext?.source || shipment.stationContext?.stationMemory?.source || "";
  const officialStationContactVerified = /United Cargo official station contact information/i.test(source);
  const hasStationEmail = isKnownContact(shipment.stationEmail);
  const hasStationPhone = isKnownContact(shipment.stationPhone);
  const missing = [];
  if (!hasStationEmail && (!officialStationContactVerified || !hasStationPhone)) missing.push("email");
  if (!hasStationPhone && (!officialStationContactVerified || !hasStationEmail)) missing.push("phone");
  if (!missing.length) return null;
  return {
    awb: shipment.awb,
    shipmentId: shipment.id,
    station: shipment.station || shipment.delivery?.airport || "",
    airline: shipment.airline || shipment.handler || "",
    client: shipment.client || shipment.tms?.customerName || "",
    missing,
    currentEmail: shipment.stationEmail || "",
    currentPhone: shipment.stationPhone || "",
    source,
    nextAction: officialStationContactVerified
      ? "Official station page has no direct station contact; save local desk only if operations confirms one."
      : "Find station import desk and save it to station memory.",
  };
}

function tmsMoneyGapForShipment(shipment) {
  const customerCharge = shipment.tms?.customerCharge || shipment.operationalMemory?.money?.customerCharge || "";
  const vendorCost = shipment.tms?.vendorCost || shipment.operationalMemory?.money?.vendorCost || "";
  const sourceRecord = shipment.operationalMemory?.money?.sourceRecord || {};
  const lastRefreshBlocked = ["blocked", "not-visible", "not-found"].includes(String(sourceRecord.status || sourceRecord.confidence || "").toLowerCase());
  const missing = [
    moneyGapLabel("customer charge", customerCharge),
    moneyGapLabel("vendor cost", vendorCost),
  ].filter(Boolean);
  if (!missing.length) return null;
  const zeroValueReview = missing.some((item) => /\bis\s+\$?0(?:\.00)?\b/i.test(item));
  return {
    awb: shipment.awb,
    shipmentId: shipment.id,
    order: shipment.tms?.order || "",
    client: shipment.client || shipment.tms?.customerName || "",
    station: shipment.station || "",
    service: shipment.tms?.serviceName || "",
    missing,
    reviewType: zeroValueReview ? "zero-value-economics" : "missing-economics",
    customerCharge,
    vendorCost,
    freightQuoteOrAward: shipment.operationalMemory?.money?.freightQuoteOrAward || shipment.freightBroker?.rate || "",
    orderLink: shipment.tms?.orderLink || "",
    lastRefresh: lastRefreshBlocked
      ? {
          status: sourceRecord.status || sourceRecord.confidence || "blocked",
          checkedAt: sourceRecord.checkedAt || sourceRecord.updatedAt || "",
          note: sourceRecord.note || sourceRecord.extractionError || "",
          missingFields: sourceRecord.missingFields || missing,
          extractionAudit: sourceRecord.extractionAudit || null,
        }
      : null,
    nextAction: lastRefreshBlocked
      ? "Last money refresh checked CourierCloud but values were not visible; manually confirm charges/costs or ask accounting."
      : zeroValueReview
      ? "CourierCloud shows zero-value economics; confirm whether $0 charge/cost is intentional or update billing/costs."
      : "Open CourierCloud costs/billing and confirm margin context.",
  };
}

function operatorBriefForActions(actions) {
  const counts = actions.reduce((acc, action) => {
    acc[action.type] = (acc[action.type] || 0) + 1;
    return acc;
  }, {});
  return {
    totalDrafts: actions.length,
    quoteRequests: counts["quote-request"] || 0,
    customsFollowups: counts["customs-followup"] || 0,
    brokerFollowups: (counts["broker-status-followup"] || 0) + (counts["dispatch-pickup-followup"] || 0),
    podFollowups: counts["pod-followup"] || 0,
    tmsAlerts: counts["tms-broker-award-experience"] || 0,
    next:
      actions.find((action) => action.priority === "high")?.label ||
      actions[0]?.label ||
      "No urgent drafts",
  };
}

function buildOperationalGaps(shipments, actionQueue) {
  const stationMemory = shipments.map(stationMemoryGapForShipment).filter(Boolean);
  const tmsMoney = shipments.map(tmsMoneyGapForShipment).filter(Boolean);
  return {
    stationMemory,
    tmsMoney,
    operatorBrief: operatorBriefForActions(actionQueue),
  };
}

const INTERNAL_OPERATOR_ACTION_TYPES = new Set([
  "ops-escalation",
  "prearrival-quote-decision",
  "quote-review",
  "station-contact-prep",
  "station-contact-research",
  "tms-broker-award-experience",
]);

function isInternalOperatorEmail(value) {
  return contactEmailList(value).some((email) =>
    email === "contact-053@demo-freight.example" ||
    email.endsWith("@partner-116.example")
  );
}

function isInternalOperatorAction(action) {
  if (!action) return true;
  if (INTERNAL_OPERATOR_ACTION_TYPES.has(action.type)) return true;
  if (action.stationContactMissing || action.podContactMissing) return true;
  if (/^(PQ ops|TMS review inbox|TMS experience inbox|Alex review inbox)$/i.test(action.targetName || "")) return true;
  return isInternalOperatorEmail(action.targetEmail);
}

function pushExternalAction(actions, action) {
  if (!action || isInternalOperatorAction(action)) return;
  if (!contactEmailList(action.targetEmail).length) return;
  actions.push(action);
}

function pushExternalActions(actions, nextActions = []) {
  for (const action of nextActions) pushExternalAction(actions, action);
}

function groupedGapReport(rows, groupKey, itemKey) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = row[groupKey] || "Unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([name, items]) => ({
      name,
      count: items.length,
      shipments: items
        .sort((a, b) => String(a[itemKey] || a.awb).localeCompare(String(b[itemKey] || b.awb)))
        .map((item) => ({
          awb: item.awb,
          shipmentId: item.shipmentId,
          order: item.order || "",
          station: item.station || "",
          airline: item.airline || "",
          missing: item.missing || [],
          reviewType: item.reviewType || "",
          customerCharge: item.customerCharge || "",
          vendorCost: item.vendorCost || "",
          freightQuoteOrAward: item.freightQuoteOrAward || "",
          nextAction: item.nextAction || "",
        })),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function buildOperationalGapReports(operationalGaps, snapshotTime) {
  return {
    stationMemory: {
      snapshotTime,
      sourceOfTruth: "Open shipments missing reusable station email or phone memory.",
      counts: {
        shipments: operationalGaps.stationMemory.length,
        stations: new Set((operationalGaps.stationMemory || []).map((gap) => gap.station || "Unknown")).size,
      },
      stations: groupedGapReport(operationalGaps.stationMemory, "station", "awb"),
    },
    tmsMoney: {
      snapshotTime,
      sourceOfTruth: "Open shipments where CourierCloud customer charge/vendor cost is missing or needs zero-value review.",
      counts: {
        shipments: operationalGaps.tmsMoney.length,
        clients: new Set((operationalGaps.tmsMoney || []).map((gap) => gap.client || "Unknown")).size,
      },
      clients: groupedGapReport(operationalGaps.tmsMoney, "client", "awb"),
    },
  };
}

function sameQuote(left, right) {
  return (
    brokerNamesMatch(left?.broker, right?.broker) &&
    Number(left?.amount) === Number(right?.amount)
  );
}

function compactQuoteDecisionQuote(quote) {
  if (!quote) return null;
  return {
    broker: quote.broker || "",
    amount: Number.isFinite(Number(quote.amount)) ? Number(quote.amount) : null,
    rate: quoteAmountLabel(quote),
    service: quote.service || "",
  };
}

function quoteDecisionForAction(shipment, quote, recommended, quotes) {
  const lowest = quotes.find(isActionablePickupQuote) || quotes[0] || null;
  const selectedByThread = shipment.freightBroker?.quoteDecision?.status === "override-selected";
  const recommendedMatch = sameQuote(quote, recommended);
  const lowestMatch = sameQuote(quote, lowest);
  const delta = lowest && Number.isFinite(Number(quote.amount)) && Number.isFinite(Number(lowest.amount))
    ? Number(quote.amount) - Number(lowest.amount)
    : 0;
  const basis = recommendedMatch
    ? selectedByThread
      ? "selected"
      : lowestMatch
      ? "lowest"
      : "recommended"
    : "override-option";
  const summary = basis === "selected"
    ? `Selected in email: ${quote.broker} ${quoteAmountLabel(quote)}`
    : basis === "lowest"
    ? `Lowest actionable: ${quote.broker} ${quoteAmountLabel(quote)}`
    : basis === "recommended"
    ? `Recommended: ${quote.broker} ${quoteAmountLabel(quote)}`
    : `Override option: ${quote.broker} ${quoteAmountLabel(quote)}${delta > 0 ? ` (+${formatMoney(delta, quote.currency || "USD")})` : ""}`;

  return {
    basis,
    summary,
    selectedByThread,
    isRecommended: recommendedMatch,
    isLowest: lowestMatch,
    deltaFromLowest: delta,
    totalQuotes: quotes.length,
    quote: compactQuoteDecisionQuote(quote),
    lowest: compactQuoteDecisionQuote(lowest),
    recommended: compactQuoteDecisionQuote(recommended),
  };
}

function quoteOptionLines(quotes, recommended = null) {
  return quotes.map((quote) => {
    const marker = recommended && sameQuote(quote, recommended) ? "Recommended: " : "";
    const context = quote.service ? ` · ${quote.service}` : "";
    return `- ${marker}${quote.broker} ${quoteAmountLabel(quote)}${context}`;
  });
}

function quoteComparisonContext(shipment, selectedQuote, actionQuotes) {
  const pickupQuotes = pickupQuoteRecords(shipment);
  const actionableQuotes = actionQuotes?.length ? actionQuotes : pickupQuotes.filter(isActionablePickupQuote);
  const lowestActionable = actionableQuotes.find(isActionablePickupQuote) || null;
  const selectedByThread = shipment.freightBroker?.quoteDecision?.status === "override-selected";
  const blockedLowerQuotes = pickupQuotes
    .map((quote) => ({ quote, blockers: quoteReviewBlockers(quote) }))
    .filter(({ quote, blockers }) =>
      blockers.length &&
      Number.isFinite(Number(quote.amount)) &&
      Number.isFinite(Number(selectedQuote?.amount)) &&
      Number(quote.amount) < Number(selectedQuote.amount)
    );
  const options = pickupQuotes.map((quote) => ({
    ...compactQuoteDecisionQuote(quote),
    contactEmail: quote.contactEmail || "",
    category: quote.category || quoteCategory(quote),
    blockers: quoteReviewBlockers(quote),
    selected: sameQuote(quote, selectedQuote),
    lowest: lowestActionable ? sameQuote(quote, lowestActionable) : false,
  }));

  return {
    selected: compactQuoteDecisionQuote(selectedQuote),
    lowestActionable: compactQuoteDecisionQuote(lowestActionable),
    selectedByThread,
    optionCount: pickupQuotes.length,
    options,
    blockedLowerQuotes: blockedLowerQuotes.map(({ quote, blockers }) => ({
      ...compactQuoteDecisionQuote(quote),
      blockers,
    })),
    summary: selectedByThread
      ? "Selected broker override from email thread"
      : lowestActionable && sameQuote(selectedQuote, lowestActionable)
      ? "Lowest actionable pickup quote"
      : "Operator-selected quote option",
  };
}

function quoteComparisonLines(context) {
  if (!context?.selected?.broker) return [];
  const otherOptions = (context.options || [])
    .filter((quote) => !quote.selected)
    .slice(0, 4)
    .map((quote) => {
      const status = quote.blockers?.length ? ` (${quote.blockers.join(", ")})` : "";
      return `${quote.broker} ${quote.rate}${status}`;
    });
  const blockedLower = (context.blockedLowerQuotes || [])
    .slice(0, 2)
    .map((quote) => `${quote.broker} ${quote.rate} blocked: ${quote.blockers.join(", ")}`);

  return [
    "Quote comparison:",
    `Selected: ${context.selected.broker} ${context.selected.rate} · ${context.summary}`,
    context.lowestActionable?.broker && !sameQuote(context.selected, context.lowestActionable)
      ? `Lowest actionable: ${context.lowestActionable.broker} ${context.lowestActionable.rate}`
      : "",
    otherOptions.length ? `Other options: ${otherOptions.join(" · ")}` : "",
    blockedLower.length ? `Blocked lower quote: ${blockedLower.join(" · ")}` : "",
    "Operator can override before drafting the TMS/CourierCloud alert.",
  ].filter(Boolean);
}

function awardActionId(shipment, quote) {
  const awb = String(shipment.awb || shipment.id || "shipment").replace(/\W+/g, "");
  const broker = String(quote.broker || "broker").replace(/\W+/g, "").toLowerCase();
  const amount = String(quote.amount || quote.rate || "rate").replace(/\W+/g, "");
  return `${awb}-award-${broker}-${amount}`;
}

function awardEmailBody(shipment, quote) {
  return actionBody([
    "Hi,",
    "",
    `Please proceed with pickup/delivery for AWB ${shipment.awb} at ${quoteAmountLabel(quote)}.`,
    "",
    "Please confirm pickup timing and send POD once completed.",
    "",
    "Thank you,",
    "Alex",
  ]);
}

function brokerAwardActions(shipment) {
  if (!canAwardPickupBroker(shipment)) return [];
  const quotes = actionablePickupQuoteRecords(shipment);
  const recommended = recommendedPickupQuote(shipment);
  if (!quotes.length || !recommended) return [];
  const preferredBroker = shipment.freightBroker?.quoteDecision?.status === "override-selected";

  return quotes.map((quote) => {
    const recommendedMatch = sameQuote(quote, recommended);
    const quoteDecision = quoteDecisionForAction(shipment, quote, recommended, quotes);
    const costContext = costContextForAward(shipment);
    const quoteContext = quoteComparisonContext(shipment, quote, quotes);
    const replyMessageId = targetThreadReplyMessageId(
      shipment,
      quote.contactEmail,
      /quote|rate|pickup|delivery|dispatch|award|broker/i,
    );
    return {
      id: awardActionId(shipment, quote),
      shipmentId: shipment.id,
      awb: shipment.awb,
      type: "broker-award",
      label: recommendedMatch
        ? preferredBroker
          ? "Award selected broker"
          : "Award lowest quote"
        : "Award broker",
      channel: "gmail",
      execution: "award-email-draft",
      safety: safetyForChannel("gmail"),
      status: "suggested",
      priority: recommendedMatch ? "high" : "normal",
      targetName: quote.broker,
      targetEmail: quote.contactEmail || "",
      missing: quote.contactEmail ? [] : ["Broker email missing"],
      subject: targetThreadSubject(
        shipment,
        quote.contactEmail,
        /quote|rate|pickup|delivery|dispatch|award|broker/i,
        `Approved pickup - AWB ${shipment.awb} - ${shipment.station || "pickup"}`,
      ),
      replyMessageId,
      conversation: conversationForReply(replyMessageId, "broker-award-thread", "awarding-pickup-broker"),
      body: awardEmailBody(shipment, quote),
      reason: quoteDecision.summary,
      timing: {
        stage: "broker-award",
        trigger: "arrived-cleared-quote-ready",
        quotedAt: quote.quotedAt || "",
      },
      quoteDecision,
      quoteContext,
      costContext,
      evidence: unique([
        ...(Array.isArray(quote.evidence) ? quote.evidence : [quote.evidence]),
        shipment.freightBroker?.quoteDecision?.summary,
      ]).slice(0, 3),
      orderLink: shipment.tms?.orderLink || "",
    };
  });
}

function quoteReviewActionId(shipment, quote) {
  const awb = String(shipment.awb || shipment.id || "shipment").replace(/\W+/g, "");
  const broker = String(quote.broker || "quote").replace(/\W+/g, "").toLowerCase();
  const amount = String(quote.amount || quote.rate || "rate").replace(/\W+/g, "");
  return `${awb}-quote-review-${broker}-${amount}`;
}

function quoteReviewDecision(quote, recommended, pickupQuotes, blockers) {
  const blocked = compactQuoteDecisionQuote(quote);
  const safeRecommendation = compactQuoteDecisionQuote(recommended);
  return {
    basis: "blocked-lower",
    summary: safeRecommendation
      ? `Blocked lower: ${quote.broker} ${quoteAmountLabel(quote)} · use ${recommended.broker} ${quoteAmountLabel(recommended)}`
      : `Blocked lower: ${quote.broker} ${quoteAmountLabel(quote)}`,
    blockers,
    blocked,
    quote: blocked,
    recommended: safeRecommendation,
    totalQuotes: pickupQuotes.length,
  };
}

function needsPrearrivalQuoteDecision(shipment) {
  if (pickupOrDeliveryAlreadyAdvanced(shipment)) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") return false;
  if (shipment.emailValidation?.status === "email-conflict") return false;
  if (isCustomsHoldStatus(shipment.customsBroker?.status || "")) return false;
  if (pickupBlockedByReleaseMismatch(shipment)) return false;
  const freightStatus = shipment.freightBroker?.status || "";
  if (/\b(awarded|dispatched|pickup-confirmed|pickup-window|confirmed|assigned|pickup-blocked|release-not-in-system)\b/i.test(freightStatus)) return false;
  if (shipment.freightBroker?.selectedBroker || shipment.freightBroker?.awardedBroker) return false;
  return actionablePickupQuoteRecords(shipment).length > 0;
}

function prearrivalQuoteDecisionAction(shipment) {
  if (!needsPrearrivalQuoteDecision(shipment)) return null;
  const quotes = actionablePickupQuoteRecords(shipment);
  const pickupQuotes = pickupQuoteRecords(shipment);
  const recommended = recommendedPickupQuote(shipment) || quotes[0];
  if (!recommended) return null;
  const blockedLowerQuotes = pickupQuotes
    .map((quote) => ({ quote, blockers: quoteReviewBlockers(quote) }))
    .filter(({ quote, blockers }) =>
      blockers.length &&
      Number.isFinite(Number(quote.amount)) &&
      Number.isFinite(Number(recommended.amount)) &&
      Number(quote.amount) < Number(recommended.amount)
    );
  const customsAlreadyReady = isCustomsResolvedStatus(shipment.customsBroker?.status || "");
  const unlockWhen = [
    "Station arrival/availability is confirmed",
    ...(customsAlreadyReady ? [] : ["Customs release/DO is confirmed"]),
  ];
  const awardHoldLine = customsAlreadyReady
    ? "Do not award from this packet until station arrival/availability is confirmed."
    : "Do not award from this packet until station arrival/availability and customs release are confirmed.";
  const quoteDecision = {
    ...quoteDecisionForAction(shipment, recommended, recommended, pickupQuotes),
    basis: "prearrival-plan",
    blockedLowerQuotes: blockedLowerQuotes.map(({ quote, blockers }) => ({
      ...quoteReviewDecision(quote, recommended, pickupQuotes, blockers),
      blockers,
    })),
    unlockWhen,
  };
  const costContext = costContextForAward(shipment);
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-prearrival-quote-decision`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "prearrival-quote-decision",
    label: "Review quote plan",
    channel: "platform",
    ...reviewOnlyPlatformContract(
      "Decision ledger required",
      "Quote-plan context is visible, but saving is disabled until a protected non-canonical decision ledger exists. It is never shipment truth.",
    ),
    status: "suggested",
    priority: "normal",
    targetName: "Operator",
    targetEmail: "",
    missing: [],
    subject: `Pre-arrival quote plan - AWB ${shipment.awb}`,
    problem: "Pickup quote exists before station arrival/availability is complete.",
    nextAction: customsAlreadyReady
      ? "Review the quote plan now; award only after station availability is safe."
      : "Review the quote plan now; award only after station availability and release are safe.",
    body: actionBody([
      "Team,",
      "",
      `The beta agent found pickup quote options for AWB ${shipment.awb}, but the shipment is not ready to award yet.`,
      "",
      `Current recommendation: ${recommended.broker} ${quoteAmountLabel(recommended)}`,
      "Quote options:",
      ...quoteOptionLines(quotes, recommended),
      blockedLowerQuotes.length ? "" : "",
      blockedLowerQuotes.length ? "Lower quote needs review:" : "",
      ...blockedLowerQuotes.map(({ quote, blockers }) =>
        `- ${quote.broker} ${quoteAmountLabel(quote)} · ${blockers.join(", ")}`
      ),
      "",
      shipment.station ? `Airport: ${shipment.station}` : "",
      shipment.eta ? `ETA / availability: ${shipment.eta}` : "",
      shipment.customsBroker?.status ? `Customs: ${shipment.customsBroker.status}` : "",
      shipment.freightBroker?.status ? `Freight: ${shipment.freightBroker.status}` : "",
      shipmentDeliveryAddress(shipment) ? `Delivery address: ${shipmentDeliveryAddress(shipment)}` : "",
      costContext.lines.length ? "" : "",
      costContext.lines.length ? "Operator cost context:" : "",
      ...costContext.lines,
      "",
      awardHoldLine,
    ]),
    reason: customsAlreadyReady
      ? `${recommended.broker} ${quoteAmountLabel(recommended)} is the current quote plan; wait for station arrival/availability before award.`
      : `${recommended.broker} ${quoteAmountLabel(recommended)} is the current quote plan; wait for arrival/release before award.`,
    quoteDecision,
    costContext,
    evidence: unique([
      shipment.freightBroker?.quoteDecision?.summary,
      ...(quotes.flatMap((quote) => Array.isArray(quote.evidence) ? quote.evidence : [quote.evidence])),
      ...(blockedLowerQuotes.flatMap(({ quote }) => Array.isArray(quote.evidence) ? quote.evidence : [quote.evidence])),
    ].filter(Boolean)).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function quoteReviewActions(shipment) {
  if (needsPrearrivalQuoteDecision(shipment)) return [];
  const pickupQuotes = pickupQuoteRecords(shipment);
  if (!pickupQuotes.length) return [];
  const recommended = recommendedPickupQuote(shipment);
  const reviewQuotes = pickupQuotes
    .map((quote) => ({ quote, blockers: quoteReviewBlockers(quote) }))
    .filter(({ quote, blockers }) => {
      if (!blockers.length) return false;
      if (!recommended) return true;
      return Number(quote.amount) < Number(recommended.amount);
    });
  if (!reviewQuotes.length) return [];

  return reviewQuotes.map(({ quote, blockers }) => {
    const quoteDecision = quoteReviewDecision(quote, recommended, pickupQuotes, blockers);
    return {
      id: quoteReviewActionId(shipment, quote),
      shipmentId: shipment.id,
      awb: shipment.awb,
      type: "quote-review",
      label: "Review quote",
      channel: "gmail",
      execution: "draft-only",
      safety: safetyForChannel("gmail"),
      status: "suggested",
      priority: "normal",
      targetName: "PQ ops",
      targetEmail: opsEscalationEmail,
      missing: opsEscalationEmail ? [] : ["PQ ops email missing"],
      subject: `Quote review - AWB ${shipment.awb} - ${quote.broker}`,
      body: actionBody([
        "Team,",
        "",
        `The beta agent found a lower pickup quote for AWB ${shipment.awb}, but it is not actionable yet.`,
        "",
        `Blocked quote: ${quote.broker} ${quoteAmountLabel(quote)}`,
        `Blocked because: ${blockers.join(", ")}`,
        recommended ? `Safe recommendation: ${recommended.broker} ${quoteAmountLabel(recommended)}` : "",
        shipment.station ? `Airport: ${shipment.station}` : "",
        shipment.client ? `Client: ${shipment.client}` : "",
        shipmentDeliveryAddress(shipment) ? `Delivery address in TMS: ${shipmentDeliveryAddress(shipment)}` : "",
        quote.service ? `Quote context: ${quote.service}` : "",
        "",
        "Before awarding, confirm the missing contact/address details or override to an actionable broker.",
      ]),
      reason: quoteDecision.summary,
      quoteDecision,
      evidence: unique([
        ...(Array.isArray(quote.evidence) ? quote.evidence : [quote.evidence]),
        shipment.freightBroker?.quoteDecision?.summary,
      ]).slice(0, 3),
      orderLink: shipment.tms?.orderLink || "",
    };
  });
}

function brokerContactRoute(shipment) {
  const freight = shipment.freightBroker || {};
  const quotes = Array.isArray(freight.quotes) ? freight.quotes : [];
  const tmsCourierName = tmsDeliveryCourierName(shipment);
  const suggestedRoute = currentSuggestedBrokerContactRoute(shipment);
  const explicitBroker = [
    freight.selectedBroker,
    freight.awardedBroker,
  ].find((value) => {
    const name = normalizeBrokerName(value);
    return name && !isMissingBrokerName(name);
  });
  const preferredBroker = explicitBroker ||
    suggestedRoute?.name ||
    freight.recommendedAward?.broker ||
    tmsCourierName ||
    "";
  const preferredQuote = preferredBroker
    ? quotes.find((quote) => brokerNamesMatch(quote?.broker, preferredBroker) && contactEmailList(quote?.contactEmail).length)
    : null;
  const recommended = recommendedPickupQuote(shipment);
  const quote = preferredQuote ||
    (recommended && contactEmailList(recommended.contactEmail).length ? recommended : null);
  const quoteEmail = contactEmailList(quote?.contactEmail)[0] || "";
  if (quoteEmail) {
    return {
      email: quoteEmail,
      name: quote?.broker || preferredBroker || freight.broker || "Broker",
      originalEmail: freight.contactEmail || "",
    };
  }

  if (
    suggestedRoute?.email &&
    (!explicitBroker || brokerNamesMatch(suggestedRoute.name, explicitBroker))
  ) {
    return suggestedRoute;
  }

  const driverEmail = contactEmailList(freight.driverContact?.email)[0] || "";
  if (driverEmail) {
    return {
      email: driverEmail,
      name: freight.driverContact?.name || preferredBroker || freight.broker || "Broker",
      originalEmail: freight.driverContact?.email || freight.contactEmail || "",
    };
  }

  const fallbackEmail = contactEmailList(freight.contactEmail)[0] || "";
  return {
    email: fallbackEmail,
    name: preferredBroker || freight.broker || tmsCourierName || "Broker",
    originalEmail: freight.contactEmail || "",
  };
}

function brokerContactEmail(shipment) {
  return brokerContactRoute(shipment).email;
}

function knownPickupBrokerRouteFromText(value) {
  const text = String(value || "");
  if (!text) return null;
  const routeForBroker = (broker) => ({
    email: broker.email,
    name: broker.name,
    originalEmail: broker.email,
    source: "suggested-communication",
  });
  const brokerInText = (broker, candidate) => {
    const profile = quoteBrokerProfile(broker.name);
    const aliases = profile?.aliases?.length ? profile.aliases : [broker.name];
    return aliases.some((alias) =>
      new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(candidate)
    );
  };

  const explicitTargets = [];
  const targetPattern = /\bvia\s+(?:gmail|email|platform|phone)\s+to\s+([^.;\n]+)/gi;
  let match;
  while ((match = targetPattern.exec(text))) {
    explicitTargets.push(match[1]);
  }

  for (const target of explicitTargets) {
    const broker = quoteBrokers.find((candidate) => brokerInText(candidate, target));
    if (broker) return routeForBroker(broker);
  }

  if (!/\b(confirm|award|send|email|dispatch|release|delivery order|d\/?o|reply)\b/i.test(text)) return null;
  const mentioned = quoteBrokers.filter((broker) => brokerInText(broker, text));
  return mentioned.length === 1 ? routeForBroker(mentioned[0]) : null;
}

function currentSuggestedBrokerContactRoute(shipment) {
  return knownPickupBrokerRouteFromText(
    [
      shipment.opsState?.suggestedCommunicationAction,
      shipment.canonicalState?.suggestedCommunicationAction,
    ].filter(Boolean).join(" ")
  );
}

function tmsDeliveryCourierName(shipment) {
  const raw = String(shipment.tms?.deliveryCourier || "").trim();
  if (!raw || /not found|unknown/i.test(raw)) return "";
  const withoutPhone = raw
    .replace(/\([^)]*\d{3,}[^)]*\)/g, "")
    .replace(/\(DEF\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalizeBrokerName(withoutPhone || raw);
}

function releasePacketBrokerName(shipment) {
  const freight = shipment.freightBroker || {};
  const route = brokerContactRoute(shipment);
  const broker = [
    freight.selectedBroker,
    freight.awardedBroker,
    freight.broker,
    route.name,
    tmsDeliveryCourierName(shipment),
  ].find((value) => {
    const name = normalizeBrokerName(value);
    return name && !isMissingBrokerName(name) && !/^broker$/i.test(name);
  });
  return broker ? normalizeBrokerName(broker) : "";
}

function releasePacketEvidenceText(shipment) {
  const freight = shipment.freightBroker || {};
  return [
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    shipment.opsState?.suggestedCommunicationAction,
    shipment.canonicalState?.suggestedCommunicationAction,
    shipment.nextAction,
    freight.status,
    freight.brokerStatus,
    freight.pickupPlan,
    freight.deliveryPlan,
    freight.nextAction,
    shipment.tms?.deliveryCourier,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.opsState?.evidence || []).map((item) => item.summary || item.evidence || item.note || item.label || ""),
    ...(freight.evidence || []).map((item) =>
      typeof item === "string" ? item : `${item.label || ""} ${item.note || item.summary || ""}`,
    ),
    ...(shipment.eodFacts || []).map(factRowText),
  ].filter(Boolean).join(" ");
}

function currentSuggestedActionIsPickupStatusOnly(shipment) {
  const text = [
    shipment.opsState?.suggestedCommunicationAction,
    shipment.canonicalState?.suggestedCommunicationAction,
  ].filter(Boolean).join(" ");
  if (!/\b(confirm|ask|follow up|get|collect)\b.{0,80}\bpickup\b/i.test(text)) return false;
  return !/\b(send|attach|transmit|provide|delivery order|d\.?\/?o\.?|release packet|release notice|release files?)\b/i.test(text);
}

function releasePacketIntentIsDue(shipment) {
  if (canonicalPodComplete(shipment) || isCompletedShipment(shipment)) return false;
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (hasActionHistoryType(shipment, "delivery-order-email")) return false;
  if (currentSuggestedActionIsPickupStatusOnly(shipment)) return false;
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return false;
  if (!releasePacketBrokerName(shipment)) return false;

  const phase = String(shipment.opsState?.phase || "").toLowerCase();
  if (phase === "fees-needed") return false;
  const text = releasePacketEvidenceText(shipment);
  const actionText = [
    shipment.opsState?.nextAction,
    shipment.opsState?.suggestedCommunicationAction,
    shipment.canonicalState?.suggestedCommunicationAction,
    shipment.nextAction,
  ].filter(Boolean).join(" ");
  const explicitReleaseInstruction =
    /\b(?:send|confirm|re-?confirm|reply|generate|provide|attach|transmit|release)\b.{0,100}\b(?:release packet|release files?|release\s*\/\s*notice|release notice|release notification|delivery order|d\.?\/?o\.?|pickup docs?|release proof)\b/i.test(actionText) ||
    /\b(?:release packet|release files?|release\s*\/\s*notice|release notice|release notification|delivery order|d\.?\/?o\.?|pickup docs?)\b.{0,100}\b(?:send|confirm|re-?confirm|reply|generate|provide|attach|transmit|needed|due|requested)\b/i.test(actionText);
  const readyPhase = ["dispatch-ready", "release-needed", "pickup-blocked"].includes(phase);
  const pickupOwnerReady = /\b(freight-awarded|awarded|assigned|dispatch|pickup)\b/i.test(`${shipment.freightBroker?.status || ""} ${text}`);
  return readyPhase && pickupOwnerReady && explicitReleaseInstruction;
}

function releasePacketAction(shipment) {
  if (!releasePacketIntentIsDue(shipment)) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const brokerName = releasePacketBrokerName(shipment);
  const route = brokerContactRoute(shipment);
  const targetEmail = contactEmailList(route.email)[0] || "";
  const evidence = unique([
    shipment.opsState?.nextAction,
    shipment.opsState?.suggestedCommunicationAction,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.emailValidation?.summary,
  ]).slice(0, 4);

  if (!targetEmail) {
    return {
      id: `${awbKey}-release-packet-contact-gap`,
      shipmentId: shipment.id,
      awb: shipment.awb,
      type: "release-packet-contact-gap",
      label: "Find release contact",
      channel: "platform",
      ...internalPlatformContract(
        "broker-contact",
        "Save broker contact",
        "Operator-approved release-contact repair. The dashboard saves the pickup broker email to shipment memory and refreshes shipment truth; no outbound email or CourierCloud mutation is performed.",
      ),
      status: "suggested",
      priority: "high",
      targetName: "Operator",
      targetEmail: "",
      originalTargetName: brokerName,
      originalTargetEmail: route.originalEmail || shipment.freightBroker?.contactEmail || "",
      problem: `Release packet is due for ${brokerName}, but no usable broker email is saved.`,
      nextAction: `Find and save the broker email for ${brokerName}, then draft the delivery-order/release-packet email from this shipment.`,
      subject: `${shipment.awb} - release packet contact missing`,
      body: actionBody([
        `AWB ${shipment.awb}: release packet / delivery order is due.`,
        `Pickup broker: ${brokerName}.`,
        "The system cannot safely draft the external email because the broker email is missing.",
        "Update the broker contact, then send the release packet / delivery order.",
      ]),
      reason: "Shipment is released and dispatch-ready, but the release-packet email cannot be addressed safely.",
      timing: {
        stage: "release-packet",
        trigger: "dispatch-ready-broker-contact-missing",
      },
      operatorUpdateOptions: [
        "Saved broker email",
        "Release packet already sent",
        "Wrong broker; choose different pickup owner",
      ],
      evidence,
      orderLink: shipment.tms?.orderLink || "",
    };
  }

  const replyMessageId = targetThreadReplyMessageId(
    shipment,
    targetEmail,
    /broker|dispatch|pickup|delivery|d\/?o|delivery order|release|quote|rate|truck/i,
  ) || latestThreadReplyMessageId(shipment, /broker|dispatch|pickup|delivery|d\/?o|delivery order|release|quote|rate|truck/i);
  return {
    id: `${awbKey}-delivery-order-email`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "delivery-order-email",
    label: "Send delivery order",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: route.name || brokerName,
    targetEmail,
    originalTargetName: brokerName,
    originalTargetEmail: route.originalEmail || "",
    subject: targetThreadSubject(
      shipment,
      targetEmail,
      /broker|dispatch|pickup|delivery|d\/?o|delivery order|release|quote|rate|truck/i,
      `${shipment.awb} - delivery order / release packet`,
    ),
    replyMessageId,
    conversation: conversationForReply(replyMessageId, "broker-pickup-thread", "release-packet-ready"),
    body: actionBody([
      "Hi,",
      "",
      `Attached is the delivery order for AWB ${shipment.awb}.`,
      "Please confirm pickup timing and send pickup proof once recovered.",
      "",
      "Thank you,",
      "Alex",
    ]),
    reason: "Shipment is released and dispatch-ready; draft the broker release-packet email with the delivery order attached.",
    timing: {
      stage: "release-packet",
      trigger: "dispatch-ready-delivery-order-needed",
    },
    documentIntent: { kind: "delivery-order", awb: shipment.awb, carrierName: brokerName },
    attachmentIntent: { kind: "delivery-order", awb: shipment.awb, carrierName: brokerName },
    carrierName: brokerName,
    evidence,
    orderLink: shipment.tms?.orderLink || "",
  };
}

function brokerOwnRateLine(broker) {
  const rate = String(broker?.rate || "").trim();
  if (!rate || /not found|not quoted/i.test(rate)) return "Please confirm the pickup/delivery rate.";
  if (/;|\b(other|lowest|recommended|selected|quote options?|blocked lower|comparison)\b/i.test(rate)) {
    return "Please confirm your pickup/delivery rate.";
  }
  return `Current rate on file: ${rate}`;
}

function hasStationCostOnlyQuote(shipment) {
  const quotes = Array.isArray(shipment.freightBroker?.quotes) ? shipment.freightBroker.quotes : [];
  return quotes.some((quote) => quote?.category === "station-cost") && !quotes.some(isPickupDeliveryQuote);
}

function pickupBlockedByReleaseMismatch(shipment) {
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return false;
  const freight = shipment.freightBroker || {};
  const text = [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    freight.status,
    freight.brokerStatus,
    freight.pickupPlan,
    freight.nextAction,
    ...(freight.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
  ].join(" ");

  return /\b(release|d\/?o|delivery order).{0,80}\b(not|isn'?t|is not|does not|doesn'?t)\b.{0,40}((?:in|on).{0,20}system|visible|show(?:ing)?.{0,20}(?:in|on).{0,20}system)|\b(station|carrier|driver|warehouse).{0,80}\b(not|did not|does not|doesn'?t)\b.{0,80}(see|show|have|find).{0,80}(release|clearance)|\b(re-?transmit|re-?confirm).{0,50}(release|d\/?o|delivery order)\b|release-(retransmission-requested|updated-waiting-station-release)|release visibility|station release/i.test(
    text,
  );
}

function needsBrokerStatusFollowup(shipment) {
  if (["delivered", "airport-picked-up"].includes(shipment.pickupStatus)) return false;
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return false;
  if (needsDispatchedPickupFollowup(shipment)) return false;
  if (needsPodFollowupDraft(shipment)) return false;
  const releaseMismatch = pickupBlockedByReleaseMismatch(shipment);
  if (!releaseMismatch && recommendedPickupQuote(shipment)) return false;
  if (!releaseMismatch && shouldRequestBrokerQuotes(shipment)) return false;

  const freightStatus = shipment.freightBroker?.status || "";
  const brokerName = shipment.freightBroker?.broker || "";
  if (!brokerName || isMissingBrokerName(brokerName)) return false;
  const statusNeedsFollowup = /acknowledged|requested|assigned|awarded|planned|station-payment|pickup-blocked|release-not-in-system/i.test(freightStatus) ||
    releaseMismatch;
  const shipmentIsReadyEnough =
    shipment.arrivalStatus === "arrived" ||
    shipment.pickupStatus === "ready" ||
    brokerActivityCanReplaceStationStatus(shipment);
  if (!shipmentIsReadyEnough) return false;
  return statusNeedsFollowup || hasStationCostOnlyQuote(shipment);
}

function brokerStatusFollowupAction(shipment) {
  const route = brokerContactRoute(shipment);
  const targetEmail = route.email || opsEscalationEmail;
  const missingBrokerContact = !route.email;
  const broker = shipment.freightBroker || {};
  const releaseMismatch = pickupBlockedByReleaseMismatch(shipment);
  const replyMessageId = missingBrokerContact
    ? ""
    : targetThreadReplyMessageId(shipment, targetEmail, /broker|dispatch|pickup|pod|delivery|quote|rate|detention|release/i);
  const brokerAsk = releaseMismatch
    ? `Driver/station does not see the release for AWB ${shipment.awb}. Can you please check?`
    : replyMessageId
    ? "Can you confirm pickup timing/rate and POD path?"
    : `Can you please confirm pickup status for AWB ${shipment.awb}?`;
  const brokerStatusSubject = missingBrokerContact
    ? `${shipment.awb} - pickup status / rate confirmation`
    : targetThreadSubject(
        shipment,
        targetEmail,
        /broker|dispatch|pickup|pod|delivery|quote|rate|detention|release/i,
        `${shipment.awb} - pickup status / rate confirmation`,
      );
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-broker-status-followup`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "broker-status-followup",
    label: missingBrokerContact ? "Find broker contact" : "Confirm pickup",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: missingBrokerContact ? "PQ ops" : route.name,
    targetEmail,
    originalTargetName: broker.broker || route.name || "Broker",
    originalTargetEmail: route.originalEmail || "",
    missing: targetEmail ? [] : ["Broker email missing"],
    subject: /pickup status|pickup\s*\/\s*pod status|rate confirmation/i.test(brokerStatusSubject)
      ? brokerStatusSubject
      : `${shipment.awb} - pickup status / rate confirmation`,
    replyMessageId,
    conversation: conversationForReply(replyMessageId, "broker-pickup-thread", "waiting-for-pickup-status"),
    body: missingBrokerContact
      ? actionBody([
          "Team,",
          "",
          `The beta agent found broker activity for AWB ${shipment.awb}, but no usable broker email was saved.`,
          broker.broker ? `Broker signal: ${broker.broker}` : "",
          shipment.station ? `Airport: ${shipment.station}` : "",
          shipment.client ? `Client: ${shipment.client}` : "",
          "",
          "Find the broker contact, confirm pickup timing/rate, and save the contact for future shipments.",
        ])
      : actionBody([
          "Hi,",
          "",
          brokerAsk,
          "",
          "Thank you,",
          "Alex",
        ]),
    reason: missingBrokerContact
      ? "Broker activity exists, but broker contact is missing."
      : releaseMismatch
        ? "Pickup is blocked because the station system does not show the release; confirm rate, pickup timing, and POD path."
        : hasStationCostOnlyQuote(shipment)
        ? "Station/payment cost found, but pickup rate and timing still need broker confirmation."
        : "Broker activity found; confirm pickup status, rate, and POD path.",
    timing: {
      stage: releaseMismatch ? "release-blocking-pickup" : "broker-pickup-status",
      trigger: releaseMismatch ? "driver-or-station-release-mismatch" : "broker-active-no-current-status",
    },
    evidence: unique([
      broker.pickupPlan,
      broker.nextAction,
      ...(broker.evidence || []).map((item) => item?.note || item),
      shipment.freightBroker?.quoteDecision?.summary,
      shipment.emailValidation?.summary,
    ]).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function hasActionHistoryType(shipment, type) {
  return (shipment.actionHistory || []).some((event) =>
    event.type === type && ["queued", "drafted", "sent"].includes(event.status)
  );
}

function knownOpsEmailSet(shipment) {
  return new Set(
    [
      opsEscalationEmail,
      quoteCc,
      ...quoteBrokers.map((broker) => broker.email),
      shipment.stationEmail,
      shipment.stationContext?.email,
      shipment.freightBroker?.contactEmail,
      shipment.customsBroker?.contactEmail,
    ]
      .flatMap((value) => contactEmailList(value))
      .map((email) => email.toLowerCase()),
  );
}

function likelyCustomerEmail(email, shipment) {
  const normalized = String(email || "").toLowerCase();
  if (!normalized) return false;
  if (/\b(demo-freight\.example|harbor-forwarding\.example|forwardair\.com|choice\.aero|elal\.co\.il|united\.com|swissport\.com|demo-global\.example|meadow-freight\.example|tql\.com|juniper-logistics\.example|demo-direct\.example|maple-brokerage\.example|hillcrestjfk\.com|portairexpress\.com|translinkshipping\.com|mwtransport\.net|cargosprint\.com)\b/i.test(normalized)) {
    return false;
  }
  return !knownOpsEmailSet(shipment).has(normalized);
}

function customerContactEmail(shipment) {
  const direct = [
    shipment.customerEmail,
    shipment.customerContactEmail,
    shipment.consigneeEmail,
    shipment.delivery?.email,
    shipment.delivery?.contactEmail,
    shipment.delivery?.consigneeEmail,
    shipment.tms?.customerEmail,
    shipment.tms?.contactEmail,
    shipment.tms?.consigneeEmail,
  ];
  const evidenceEmails = threadCandidatePool(shipment)
    .flatMap((event) => contactEmailList(threadCandidateText(event)));
  return unique([...direct, ...evidenceEmails])
    .map((email) => String(email || "").toLowerCase())
    .find((email) => likelyCustomerEmail(email, shipment)) || "";
}

function customerQuestionEvidence(shipment) {
  return threadCandidatePool(shipment)
    .filter((event) =>
      /\b(when can i expect delivery|delivery happen|delivery today|delivery tomorrow|expected delivery|eta|status update|any update|where is)\b/i.test(
        threadCandidateText(event),
      )
    )
    .sort(byNewestThreadEvidence)[0] || null;
}

function needsCustomerUpdateDraft(shipment) {
  if (hasActionHistoryType(shipment, "customer-update")) return false;
  if (!customerQuestionEvidence(shipment)) return false;
  return Boolean(customerContactEmail(shipment));
}

function customerSafeDeliveryPlan(shipment) {
  const text = [
    shipment.freightBroker?.deliveryPlan,
    shipment.freightBroker?.nextAction,
    shipment.emailValidation?.nextAction,
  ].filter(Boolean).join(" ");
  const tomorrow = text.match(/\btomorrow(?:\s+(?:morning|afternoon|evening))?\b/i)?.[0];
  if (tomorrow) return tomorrow.toLowerCase();
  const today = text.match(/\btoday(?:\s+(?:morning|afternoon|evening))?\b/i)?.[0];
  if (today) return today.toLowerCase();
  const dated = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:\s*,\s*\d{4})?(?:\s+(?:morning|afternoon|evening))?\b/i)?.[0];
  if (dated) return dated;
  return "";
}

function customerUpdateLine(shipment) {
  const customsStatus = shipment.customsBroker?.status || "";
  if (isCustomsHoldStatus(customsStatus)) return "Customs is still on hold, so delivery timing is not confirmed yet.";
  if (!isCustomsResolvedStatus(customsStatus)) return "Customs release is still pending, so delivery timing is not confirmed yet.";
  const deliveryPlan = customerSafeDeliveryPlan(shipment);
  if (deliveryPlan) return `Expected delivery is ${deliveryPlan}.`;
  return "We are checking delivery timing and will update you shortly.";
}

function customerUpdateAction(shipment) {
  const evidence = customerQuestionEvidence(shipment);
  const targetEmail = customerContactEmail(shipment);
  const replyMessageId = eventReplyMessageId(evidence) || latestThreadReplyMessageId(
    shipment,
    /when can i expect delivery|delivery happen|delivery today|delivery tomorrow|expected delivery|eta|status update|any update/i,
  );
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-customer-update`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "customer-update",
    label: "Reply customer",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "normal",
    targetName: shipment.delivery?.consignee || shipment.consignee || shipment.client || "Customer",
    targetEmail,
    missing: targetEmail ? [] : ["Customer email missing"],
    subject: latestThreadSubject(
      shipment,
      /when can i expect delivery|delivery happen|delivery today|delivery tomorrow|expected delivery|eta|status update|any update/i,
      `${shipment.awb} - delivery update`,
    ),
    replyMessageId,
    conversation: conversationForReply(replyMessageId, "customer-update-thread", "answering-delivery-status"),
    body: actionBody([
      "Hi,",
      "",
      customerUpdateLine(shipment),
      "",
      "Thank you,",
      "Alex",
    ]),
    reason: "Customer asked for delivery/status; reply with delivery timing or customs issue only.",
    timing: {
      stage: "customer-status-reply",
      trigger: "customer-asked-for-status",
    },
    evidence: unique([threadCandidateText(evidence), shipment.freightBroker?.deliveryPlan, shipment.customsBroker?.status]).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function needsDispatchedPickupFollowup(shipment) {
  if (shipment.pickupStatus === "delivered") return false;
  if (hasPodProof(shipment)) return false;
  if (hasActionHistoryType(shipment, "dispatch-pickup-followup")) return false;
  return Boolean(dispatchPickupFollowupDueStatus(shipment)?.due);
}

function linehaulFollowupCanReplaceStationStatus(shipment) {
  if (hasStationArrivalProof(shipment)) return false;
  if (!needsDispatchedPickupFollowup(shipment)) return false;
  if (!brokerContactEmail(shipment)) return false;
  const due = dispatchPickupFollowupDueStatus(shipment);
  const text = [due?.detail, dispatchEvidenceText(shipment)].join(" ");
  return /\b(linehaul|ltl|destination arrival|destination recovery|loaded\s+on\s+(?:the\s+)?(?:\d+(?:st|nd|rd|th)\s+)?ltl)\b/i.test(
    text,
  );
}

function brokerActivityCanReplaceStationStatus(shipment) {
  if (hasStationArrivalProof(shipment)) return false;
  if (!brokerContactEmail(shipment)) return false;
  if (!isCustomsResolvedStatus(shipment.customsBroker?.status || "")) return false;
  if (
    shipment.arrivalStatus !== "arrived" &&
    shipment.pickupStatus !== "ready" &&
    !shipment.freightBroker?.cargoAvailable
  ) {
    return false;
  }
  const freight = shipment.freightBroker || {};
  const text = [
    freight.status,
    freight.brokerStatus,
    freight.pickupPlan,
    freight.deliveryPlan,
    freight.nextAction,
    freight.cargoAvailable ? "cargo available" : "",
    ...(freight.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
  ].join(" ");

  return /\b(acknowledged|assigned|awarded|pickup alert|pickup plan|cargo available|cargo released|payment delivered)\b/i.test(
    text,
  );
}

function customsFollowupCanReplaceStationStatus(shipment) {
  if (shipment.trackingException?.type === "eta-passed-no-arrival-proof") return false;
  if (emailNeedsStationStatusCheck(shipment)) return false;
  if (!(shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready")) return false;
  if (!customsNeedsBrokerFollowup(shipment)) return false;
  const customsEmail = shipment.customsBroker?.contactEmail || "";
  return isKnownContact(customsEmail);
}

function podFollowupCanReplaceStationStatus(shipment) {
  return needsPodFollowupDraft(shipment);
}

function stationStatusNeedsDirectStationAsk(shipment) {
  return Boolean(
    shipment.trackingException?.type === "eta-passed-no-arrival-proof" ||
      shipment.trackingException?.type === "available-by-tracking-email-needed" ||
      stationEtaStatusCheck(shipment)
  );
}

function dispatchPickupFollowupAction(shipment) {
  const freight = shipment.freightBroker || {};
  const due = dispatchPickupFollowupDueStatus(shipment);
  const targetEmail = isKnownContact(freight.contactEmail) ? contactEmailList(freight.contactEmail)[0] || "" : "";
  const routeToOps = !targetEmail;
  const brokerName = freight.broker && !isMissingBrokerName(freight.broker) ? freight.broker : "Pickup broker";
  const isLinehaulFollowup = /\b(linehaul|ltl|destination arrival|destination recovery)\b/i.test(
    [due?.detail, freight.pickupPlan, freight.deliveryPlan, freight.brokerStatus, freight.nextAction].join(" "),
  );
  const pickedUpFollowup = shipment.pickupStatus === "airport-picked-up" || /Pickup was reported/i.test(due?.detail || "");
  const pickupContext = unique([
    due?.detail,
    freight.pickupPlan,
    freight.deliveryPlan,
    freight.nextAction,
    freight.summary,
  ]).join(" ");
  const replyMessageId = routeToOps
    ? ""
    : targetThreadReplyMessageId(shipment, targetEmail, /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i) ||
      latestThreadReplyMessageId(shipment, /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i);
  const externalAsk = isLinehaulFollowup
    ? `Can you please confirm destination status and POD path for AWB ${shipment.awb}?`
    : pickedUpFollowup
    ? `Can you please confirm delivery status and send POD if completed for AWB ${shipment.awb}?`
    : replyMessageId
    ? "Status?"
    : `Can you please confirm pickup status for AWB ${shipment.awb}?`;

  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-dispatch-pickup-followup`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "dispatch-pickup-followup",
    label: routeToOps ? "Find pickup broker" : isLinehaulFollowup ? "Confirm destination" : "Confirm pickup/POD",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: routeToOps ? "PQ ops" : brokerName,
    targetEmail: routeToOps ? opsEscalationEmail : targetEmail,
    originalTargetName: routeToOps ? brokerName : "",
    originalTargetEmail: routeToOps ? freight.contactEmail || "" : "",
    missing: routeToOps && !opsEscalationEmail ? ["Pickup broker email missing"] : [],
    subject: routeToOps
      ? isLinehaulFollowup ? `${shipment.awb} - destination arrival / POD status` : `${shipment.awb} - pickup / POD status`
      : targetThreadSubject(
          shipment,
          targetEmail,
          /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i,
          isLinehaulFollowup ? `${shipment.awb} - destination arrival / POD status` : `${shipment.awb} - pickup / POD status`,
        ),
    replyMessageId,
    conversation: conversationForReply(
      replyMessageId,
      "broker-pickup-thread",
      isLinehaulFollowup ? "waiting-for-destination-status" : "waiting-for-pickup-pod",
    ),
    body: actionBody([
      routeToOps ? "Team," : "Hi,",
      "",
      routeToOps
        ? `The beta agent found a dispatched pickup for AWB ${shipment.awb}, but no usable broker email is saved.`
        : externalAsk,
      routeToOps && pickupContext ? `Context: ${pickupContext}` : "",
      routeToOps && freight.contactEmail ? `Unparsed broker contact field: ${freight.contactEmail}` : "",
      "",
      routeToOps
        ? "Find the broker contact, confirm pickup/POD status, and save the contact for future shipments."
        : "",
      "",
      "Thank you,",
      "Alex",
    ]),
    reason: due?.detail || "Broker/carrier pickup window passed without pickup/POD proof.",
    timing: {
      stage: isLinehaulFollowup
        ? "linehaul-destination-followup"
        : pickedUpFollowup
        ? "post-pickup-delivery-followup"
        : "broker-pickup-followup",
      trigger: due?.trigger || "pickup-window-passed",
      dueAt: due?.dueAt?.toISOString?.() || "",
    },
    dueAt: due?.dueAt?.toISOString?.() || "",
    evidence: unique([
      due?.detail,
      freight.pickupPlan,
      freight.deliveryPlan,
      freight.nextAction,
      ...(freight.evidence || []).map((item) => item?.note || item),
      shipment.emailValidation?.summary,
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function tmsBrokerAwardExperienceAction(shipment) {
  if (!canAwardPickupBroker(shipment) || !shipment.tms?.orderLink) return null;
  const quote = recommendedPickupQuote(shipment);
  if (!quote) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const preferredBroker = shipment.freightBroker?.quoteDecision?.status === "override-selected";
  const brokerLabel = quote.broker || "Selected broker";
  const targetEmail = quote.contactEmail || "";
  const quoteDecision = quoteDecisionForAction(shipment, quote, quote, actionablePickupQuoteRecords(shipment));
  const costContext = costContextForAward(shipment);
  const quoteContext = quoteComparisonContext(shipment, quote, actionablePickupQuoteRecords(shipment));
  const contactedEmails = unique([targetEmail, opsEscalationEmail].filter(Boolean));

  return {
    id: `${awbKey}-tms-award-experience`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "tms-broker-award-experience",
    label: preferredBroker ? "Send selected broker alert" : "Send lowest broker alert",
    channel: "couriercloud",
    execution: "operator-approved-tms",
    safety: safetyForChannel("couriercloud"),
    status: "suggested",
    priority: "high",
    targetName: brokerLabel,
    targetEmail,
    originalTargetName: brokerLabel,
    originalTargetEmail: targetEmail,
    missing: targetEmail ? [] : ["Broker email missing"],
    subject: `${shipment.awb} - pickup alert`,
    body: actionBody([
      `Please recover AWB ${shipment.awb} from ${shipment.station || "the airport"} and coordinate pickup/delivery.`,
      shipmentDeliveryAddress(shipment) ? `Delivery: ${shipmentDeliveryAddress(shipment)}` : "",
      quoteAmountLabel(quote) ? `Rate: ${quoteAmountLabel(quote)}` : "",
      costContext.lines.length ? "" : "",
      costContext.lines.length ? "Operator cost context:" : "",
      ...costContext.lines,
      "Please confirm pickup timing and send POD after delivery.",
    ]),
    reason: `${quoteDecision.summary} · send CourierCloud broker alert`,
    timing: {
      stage: "broker-award",
      trigger: "arrived-cleared-quote-ready",
      quotedAt: quote.quotedAt || "",
    },
    quoteDecision,
    quoteContext,
    costContext,
    tmsIntent: {
      kind: "broker-agent-contacted-email",
      tab: "Agents",
      menu: "three dots",
      field: "Contacted",
      method: "Email",
      brokerName: brokerLabel,
      brokerEmail: targetEmail,
      copyEmail: opsEscalationEmail,
      contactedEmails,
    },
    evidence: unique([
      ...(Array.isArray(quote.evidence) ? quote.evidence : [quote.evidence]),
      shipment.freightBroker?.quoteDecision?.summary,
    ]).slice(0, 3),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function cleanPodReceiver(value) {
  const receiver = String(value || "").replace(/\s+/g, " ").replace(/[.;,]?\s*$/, "").trim();
  if (!receiver) return "Receiver";
  if (receiver.length > 28) return "Receiver";
  if (/\b(?:awb|mawb|cargo|airlines?|airways?|airport|united|el al|dhl|swissport|choice|c\/o|for)\b|\d{3}-\d{6,}/i.test(receiver)) {
    return "Receiver";
  }
  return receiver;
}

function formatPodTimestamp(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}

function podEvidenceTimestamp(shipment) {
  const podFact = (shipment.factLedger || []).find((item) => item.type === "pod" && item.at);
  return latestIsoTimestamp(
    podFact?.at,
    shipment.opsState?.gates?.pod?.at,
    shipment.opsState?.gates?.delivery?.at,
    shipment.canonicalState?.gates?.pod?.at,
    shipment.canonicalState?.gates?.delivery?.at,
    shipment.pod?.deliveredAt,
    shipment.emailValidation?.latestEventAt,
    shipment.freightBroker?.latestEventAt,
    shipment.updatedAt,
  );
}

function formatTmsDate(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "numeric",
    day: "numeric",
    year: "numeric",
  }).formatToParts(new Date(time));
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return [part("month"), part("day"), part("year")].filter(Boolean).join("/");
}

function normalizePodTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = match[2] || "00";
  const meridiem = String(match[3] || "").toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || Number(minute) > 59) return "";
  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function monthNumberFromName(value) {
  const key = String(value || "").slice(0, 3).toLowerCase();
  return {
    jan: "1",
    feb: "2",
    mar: "3",
    apr: "4",
    may: "5",
    jun: "6",
    jul: "7",
    aug: "8",
    sep: "9",
    oct: "10",
    nov: "11",
    dec: "12",
  }[key] || "";
}

function fullYear(value) {
  const year = String(value || "").trim();
  if (!year) return "";
  return year.length === 2 ? `20${year}` : year;
}

function formatUsDateParts(month, day, year) {
  const normalizedYear = fullYear(year);
  if (!month || !day || !normalizedYear) return "";
  return `${Number(month)}/${Number(day)}/${normalizedYear}`;
}

function extractPodActualTime(text) {
  const exact = String(text || "").match(
    /\b(?:delivered|delivery completed|signed|pod|verbal pod)\b[^\n]{0,100}\b(?:at|@)\s+(\d{1,2}(?::?\d{2})?\s*(?:am|pm|AM|PM)?)/i,
  );
  return normalizePodTime(exact?.[1] || "");
}

function extractPodActualDate(text) {
  const value = String(text || "");
  const named = value.match(
    /\b(?:delivered|delivery completed|signed|pod|verbal pod)\b[^\n]{0,180}\bon\s+(?:mon|tue|wed|thu|fri|sat|sun)?[,]?\s*(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2,4})/i,
  );
  if (named) return formatUsDateParts(monthNumberFromName(named[2]), named[1], named[3]);
  const numeric = value.match(
    /\b(?:delivered|delivery completed|signed|pod|verbal pod)\b[^\n]{0,180}\bon\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i,
  );
  if (numeric) return formatUsDateParts(numeric[1], numeric[2], numeric[3]);
  return "";
}

function extractPodReceiver(text) {
  const value = String(text || "");
  const patterns = [
    /\bverbal pod\s*[:\-]?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})\s*(?:@|at)\b/i,
    /\b(?:delivered|delivery completed)\s+(?:to\s+)?([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})\s+(?:on|at)\b/i,
    /\b(?:signed|received)\s+by\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3})\b/i,
  ];
  for (const pattern of patterns) {
    const receiver = cleanPodReceiver(value.match(pattern)?.[1] || "");
    if (receiver && receiver !== "Receiver") return receiver;
  }
  return "";
}

function hasPodNegativeContext(text) {
  const value = String(text || "");
  return /\b(?:no|not|without|missing|pending|awaiting|need|needs|needed)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|final delivery|delivery hit)\b|\b(?:pod|proof of delivery|delivery proof|final delivery|delivery hit)\b[^.;\n]{0,80}\b(?:not|missing|pending|needed|not found|no proof|no hit)\b/i.test(value);
}

function hasPodCloseoutEvidence(shipment, text) {
  if (hasPodNegativeContext(text)) return false;
  if (shipment.operationalMemory?.pod?.status === "pod-found") return true;
  if (!hasPodProof(shipment)) return false;
  return (
    /\b(?:delivery completed|delivered to|verbal pod|pod evidence|couriercloud\/piki status confirms delivery)\b/i.test(text || "") &&
    Boolean(extractPodActualTime(text))
  );
}

function podActualProposalForShipment(shipment) {
  const pod = shipment.operationalMemory?.pod || {};
  const text = textEvidenceForOpsMemory(shipment);
  const signedBy = cleanPodReceiver(pod.receiver || extractPodReceiver(text) || shipment.tms?.podSignature || "Receiver") || "Receiver";
  const eventTimestamp = podEvidenceTimestamp(shipment);
  const actualTime = extractPodActualTime(text);
  const actualDate = extractPodActualDate(text) || formatTmsDate(eventTimestamp);
  const actualAt = [actualDate, actualTime].filter(Boolean).join(" ");
  const eventTimestampLabel = formatPodTimestamp(eventTimestamp);
  return {
    signedBy,
    actualAt,
    actualDate,
    actualTime,
    actualAtLabel: actualAt || (eventTimestampLabel ? `confirm from POD; email evidence ${eventTimestampLabel}` : "confirm from POD"),
    needsActualTimeReview: !actualTime,
    evidence: unique([
      ...(pod.evidence || []),
      shipment.emailValidation?.summary,
      shipment.freightBroker?.nextAction,
    ]).filter(Boolean).slice(0, 3),
  };
}

function tmsPodCloseoutExperienceAction(shipment) {
  if (!shipment.tms?.orderLink) return null;
  const text = textEvidenceForOpsMemory(shipment);
  if (!hasPodCloseoutEvidence(shipment, text)) return null;
  if (shipment.tms?.podSignature) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const proposal = podActualProposalForShipment(shipment);
  const costContext = costContextForAward(shipment);
  const missing = [
    proposal.actualDate ? "" : "POD actual date",
    proposal.actualTime ? "" : "POD actual time",
  ].filter(Boolean);

  return {
    id: `${awbKey}-tms-pod-closeout`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "tms-pod-closeout-experience",
    label: "Close POD in TMS",
    channel: "couriercloud",
    execution: "operator-approved-tms",
    safety: safetyForChannel("couriercloud"),
    status: "suggested",
    priority: "high",
    targetName: "CourierCloud POD closeout",
    targetEmail: "",
    missing,
    subject: `${shipment.awb} - POD closeout`,
    body: actionBody([
      `Signed: ${proposal.signedBy}`,
      `Actual: ${proposal.actualDate || "missing date"} ${proposal.actualTime || "missing time"}`.trim(),
      "Approve to write Actual/Signed in CourierCloud and click Save Next.",
    ]),
    reason: `POD found · ${proposal.signedBy} · ${proposal.actualDate || "date?"} ${proposal.actualTime || "time?"}`.trim(),
    podProposal: proposal,
    costContext,
    tmsIntent: {
      kind: "pod-actual-signed-closeout",
      panel: "Actual",
      actualDate: proposal.actualDate,
      actualTime: proposal.actualTime,
      actualAtLabel: proposal.actualAtLabel,
      signedBy: proposal.signedBy,
      saveNextClientFacing: true,
    },
    evidence: proposal.evidence,
    orderLink: shipment.tms?.orderLink || "",
  };
}

function stationConfirmationAction(shipment) {
  const station = shipment.station || "the station";
  const stationRoute = stationContactRoute(shipment);
  const targetEmail = stationRoute.email;
  const needsStationContact = !targetEmail;
  const trackingLine = shipment.liveTracking?.status || shipment.eta || "tracking shows arrival/availability needs confirmation";
  const needsPod = shipment.pickupStatus === "delivered";
  const needsAirportPickupConfirmation = shipment.pickupStatus === "airport-picked-up";
  const needsEtaStatusCheck = shipment.trackingException?.type === "eta-passed-no-arrival-proof";
  const etaCheck = stationEtaStatusCheck(shipment);
  const needsEtaDueCheck = Boolean(etaCheck);
  const targetName = needsStationContact ? "PQ ops" : `${station} ${shipment.handler || shipment.airline || "station"}`.trim();
  const recipientEmail = needsStationContact ? opsEscalationEmail : targetEmail;
  const etaReason = etaCheck ? `${etaCheck.detail} ` : "";
  const contactReason = `${etaReason}${stationRoute.missingReason} Find the station import desk, save it to station memory, then send the station status request.`;
  const stationStatusAsk = needsEtaStatusCheck || needsEtaDueCheck
    ? `Please confirm if AWB ${shipment.awb} is on hand and share arrival notice.`
    : `Please confirm if AWB ${shipment.awb} is on hand and available for pickup.`;
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-station-confirmation`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "station-confirmation",
    label: needsStationContact
      ? "Find station contact"
      : needsPod
      ? "Get POD proof"
      : needsAirportPickupConfirmation
      ? "Confirm pickup handoff"
      : needsEtaStatusCheck || needsEtaDueCheck
      ? "Ask station status"
      : "Confirm station",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: shipment.trackingException || needsPod || needsAirportPickupConfirmation || etaCheck?.status === "passed" ? "high" : "normal",
    targetName,
    targetEmail: recipientEmail,
    station,
    etaStatus: etaCheck?.status || "",
    etaLabel: etaCheck?.label || "",
    etaDetail: etaCheck?.detail || "",
    etaText: shipment.eta || shipment.liveTracking?.scheduledArrival || "",
    stationContactMissing: needsStationContact,
    originalTargetName: `${station} ${shipment.handler || shipment.airline || "station"}`.trim(),
    originalTargetEmail: stationRoute.originalEmail,
    missing: recipientEmail ? [] : ["PQ ops email missing"],
    subject: needsStationContact
      ? `${shipment.awb} - confirm station contact / status`
      : needsPod
      ? `${shipment.awb} - POD / delivery confirmation`
      : needsAirportPickupConfirmation
      ? `${shipment.awb} - confirm airport pickup handoff`
      : needsEtaStatusCheck || needsEtaDueCheck
      ? `${shipment.awb} - status check`
      : `${shipment.awb} - confirm cargo on hand`,
    body: needsStationContact
      ? actionBody([
          "Team,",
          "",
          `Find and save the station email for ${[shipment.airline, station].filter(Boolean).join(" ")} in station memory, then confirm AWB ${shipment.awb} arrival/on-hand status.`,
          etaCheck ? `ETA: ${shipment.eta || shipment.liveTracking?.scheduledArrival || "passed/near due"}. Arrival proof is missing.` : "",
          "",
          "Thank you,",
          "Alex",
        ])
      : needsPod
      ? actionBody([
          "Hi,",
          "",
          `Tracking shows AWB ${shipment.awb} as delivered. Can you please send POD or delivery confirmation?`,
          "",
          "Thank you,",
          "Alex",
        ])
      : needsAirportPickupConfirmation
      ? actionBody([
          "Hi,",
          "",
          `Tracking shows AWB ${shipment.awb} as picked up from the airport at ${station}. Can you please confirm the handoff/pickup and who picked it up?`,
          "",
          "Thank you,",
          "Alex",
        ])
      : needsEtaStatusCheck || needsEtaDueCheck
      ? actionBody([
          "Hi,",
          "",
          stationStatusAsk,
          "",
          "Thank you,",
          "Alex",
        ])
      : actionBody([
          "Hi,",
          "",
          stationStatusAsk,
          "",
          "Thank you,",
          "Alex",
        ]),
    reason:
      needsStationContact
        ? contactReason
        : needsPod
        ? "Tracking says delivered, but Gmail does not contain final POD or closeout proof."
        : needsAirportPickupConfirmation
        ? "Carrier tracking says DLV/picked up from airport; final email confirmation of the handoff is still missing."
        : needsEtaStatusCheck
        ? "ETA has passed, but carrier/Gmail proof still does not confirm arrival or availability."
        : needsEtaDueCheck
        ? etaCheck.detail
        : shipment.trackingException?.type === "available-by-tracking-email-needed"
        ? "Carrier tracking says the shipment is available, but Gmail/station proof is still missing."
        : "Shipment needs station-side confirmation before the team treats it as available.",
    timing: {
      stage: needsPod
        ? "station-pod-proof"
        : needsAirportPickupConfirmation
        ? "airport-pickup-handoff"
        : needsEtaStatusCheck || needsEtaDueCheck
        ? "station-arrival-status"
        : "station-availability",
      trigger: needsEtaStatusCheck
        ? "eta-passed-no-arrival-proof"
        : needsEtaDueCheck
        ? "eta-within-station-lead-window"
        : needsAirportPickupConfirmation
        ? "carrier-picked-up-needs-email-proof"
        : needsPod
        ? "tracking-delivered-no-pod"
        : "arrived-or-available-needs-station-proof",
      leadHours: etaCheck?.status === "due-soon" ? Number(process.env.PQ_STATION_STATUS_LEAD_HOURS || 6) : "",
      eta: etaCheck?.eta?.toISOString?.() || "",
    },
    evidence: unique([contactReason, ...actionEvidence(shipment)]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function needsStationContactPrep(shipment) {
  return Boolean(stationMemoryGapForShipment(shipment));
}

function stationContactPrepAction(shipment) {
  const gap = stationMemoryGapForShipment(shipment);
  if (!gap) return null;
  const station = shipment.station || "destination";
  const carrier = shipment.airline || shipment.handler || "carrier";
  const phase = shipment.opsState?.phase;
  const workReason = phase === "prearrival-ready"
    ? "arrival confirmation will be needed"
    : phase
      ? `the shipment is ${phase}`
      : "station contact may be needed";
  const contactReason =
    `Station contact is not known for ${[carrier, station].filter(Boolean).join(" ")} while ${workReason}. Find the station import desk before the next station-side decision and save it to station memory.`;

  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-station-contact-research`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "station-contact-research",
    label: "Find station contact",
    channel: "platform",
    ...internalPlatformContract(
      "station-memory",
      "Save station contact",
      "Operator-approved station-contact repair. The dashboard saves the verified station email or phone to station memory and refreshes shipment truth; no outbound email or CourierCloud mutation is performed.",
    ),
    status: "suggested",
    priority: "normal",
    targetName: "Operator",
    targetEmail: "",
    stationContactMissing: true,
    originalTargetName: `${station} ${shipment.handler || carrier || "station"}`.trim(),
    missing: gap.missing || [],
    currentStationEmail: gap.currentEmail || "",
    currentStationPhone: gap.currentPhone || "",
    subject: `${shipment.awb} - find station contact`,
    problem: contactReason,
    nextAction: "Find the station import desk email/phone and save it to station memory so future station checks route directly.",
    body: actionBody([
      contactReason,
      "",
      `AWB: ${shipment.awb}`,
      station ? `Airport: ${station}` : "",
      carrier ? `Carrier: ${carrier}` : "",
      shipment.handler ? `Current handler label: ${shipment.handler}` : "",
      shipment.client ? `Client: ${shipment.client}` : "",
      shipment.eta ? `ETA / availability: ${shipment.eta}` : "",
      shipment.customsBroker?.status ? `Customs: ${shipment.customsBroker.status}` : "",
      shipment.freightBroker?.status ? `Pickup status: ${shipment.freightBroker.status}` : "",
      gap.currentEmail ? `Current email value: ${gap.currentEmail}` : "Current email value: missing",
      gap.currentPhone ? `Current phone value: ${gap.currentPhone}` : "Current phone value: missing",
      "",
      "Suggested search terms:",
      unique([
        shipment.awb,
        normalizeAwb(shipment.awb),
        shipment.station,
        shipment.airline,
        shipment.handler,
        shipment.client,
      ]).join(" / "),
      "",
      "After confirming the station email/phone, update station memory so future shipments route directly.",
    ]),
    reason: contactReason,
    timing: {
      stage: "station-contact-research",
      trigger: "station-memory-contact-missing",
      phase: phase || "",
    },
    evidence: unique([contactReason, ...actionEvidence(shipment)]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function tmsMoneyContextAction(shipment, currentActions = []) {
  const gap = tmsMoneyGapForShipment(shipment);
  if (!gap) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const phase = shipment.opsState?.phase || "active";
  const missing = gap.missing || [];
  const lastRefresh = gap.lastRefresh || null;
  const lastRefreshNote = lastRefresh?.note || "";
  const zeroValueReview = gap.reviewType === "zero-value-economics";
  const problem = zeroValueReview
    ? `CourierCloud money context has zero-value economics for active shipment ${shipment.awb}: ${missing.join(" and ") || "customer charge/vendor cost is $0"}.`
    : `CourierCloud money context is missing for active shipment ${shipment.awb}: ${missing.join(" and ") || "customer charge/vendor cost"}.`;
  const manualReviewNeeded = Boolean(lastRefresh);
  return {
    id: `${awbKey}-money-context-review`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "money-context-review",
    label: manualReviewNeeded ? "Confirm TMS charges manually" : "Confirm TMS charges",
    channel: "platform",
    ...internalPlatformContract(
      "money_refresh",
      "Check TMS charges",
      "Operator-approved internal money refresh. The dashboard queues CourierCloud economics extraction after the operator clicks; no outbound email is sent.",
    ),
    status: "suggested",
    priority: "normal",
    targetName: "Operator",
    targetEmail: "",
    subject: `${shipment.awb} - confirm shipment economics`,
    problem,
    reason: manualReviewNeeded
      ? `${problem} Last money refresh checked CourierCloud but did not extract values: ${lastRefreshNote || "values were not visible"}.`
      : zeroValueReview
      ? `${problem} Shipment margin cannot be trusted until the operator confirms the $0 charge/cost values are intentional.`
      : `${problem} Shipment margin cannot be trusted until customer charge and vendor costs are known.`,
    nextAction: manualReviewNeeded
      ? "Open CourierCloud Charges/Costs/Billing manually or ask accounting, then save the confirmed economics in the dashboard."
      : zeroValueReview
      ? "Confirm whether CourierCloud $0 charge/cost is intentional; if not, update billing/costs or ask accounting."
      : "Open CourierCloud costs/billing, confirm customer charge and vendor cost, then update the shipment money context.",
    body: actionBody([
      problem,
      `Current phase: ${phase}`,
      gap.client ? `Client: ${gap.client}` : "",
      gap.order ? `CourierCloud order: ${gap.order}` : "",
      gap.customerCharge ? `Customer charge: ${gap.customerCharge}` : "Customer charge: missing",
      gap.vendorCost ? `Vendor cost: ${gap.vendorCost}` : "Vendor cost: missing",
      gap.freightQuoteOrAward ? `Freight quote/award: ${gap.freightQuoteOrAward}` : "",
      lastRefresh ? `Last money refresh: ${lastRefreshNote || lastRefresh.status || "checked but blocked"}` : "",
      gap.orderLink ? `CourierCloud: ${gap.orderLink}` : "",
      manualReviewNeeded
        ? "After manual confirmation, save customer charge/vendor cost in the dashboard so quote, award, and margin decisions do not rely on unknown economics."
        : zeroValueReview
        ? "If the zero values are intentional, save a note confirming them; otherwise update billing/costs before trusting margin."
        : "After confirming billing/costs, update the shipment so quote, award, and margin decisions do not rely on unknown economics.",
    ]),
    missingMoneyFields: missing,
    costContext: {
      summary: zeroValueReview
        ? "Margin needs review because CourierCloud shows zero charge/cost values."
        : "Margin unknown until CourierCloud customer charge and vendor costs are confirmed.",
      missing,
      customerCharge: gap.customerCharge || "",
      vendorCost: gap.vendorCost || "",
      freightQuoteOrAward: gap.freightQuoteOrAward || "",
      lastRefresh,
      reviewType: gap.reviewType || "",
    },
    timing: {
      stage: "money-context-review",
      trigger: "active-shipment-money-context-missing",
      phase,
    },
    evidence: unique([
      "Money context is required before trusting shipment-level economics.",
      shipment.opsState?.summary,
      ...actionEvidence(shipment),
    ]).slice(0, 4),
    orderLink: gap.orderLink || shipment.tms?.orderLink || "",
  };
}

function customsFollowupAction(shipment) {
  const customs = shipment.customsBroker || {};
  const targetEmail = isKnownContact(customs.contactEmail) ? normalizeContactEmails(customs.contactEmail) : "";
  const prearrival = prearrivalCustomsFollowupCheck(shipment);
  const releaseMismatch = pickupBlockedByReleaseMismatch(shipment);
  const customsHold = isCustomsHoldStatus(customs.status) || hasActiveCustomsBlocker(shipment);
  const reason = customsHold
    ? "Customs hold/exam is blocking pickup."
    : releaseMismatch
      ? "Driver/station cannot see the release."
    : prearrival
      ? prearrival.detail
      : "Arrival is known, but clearance proof is not final.";
  const replyMessageId = targetThreadReplyMessageId(shipment, targetEmail, /customs|clearance|release|d\/?o|delivery order|broker/i);
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-customs-followup`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "customs-followup",
    label: "Draft customs follow-up",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: customsHold ? "high" : "normal",
    targetName: customs.broker && customs.broker !== "Not found" ? customs.broker : "Customs broker",
    targetEmail,
    missing: targetEmail ? [] : ["Customs broker email missing"],
    subject: targetThreadSubject(
      shipment,
      targetEmail,
      /customs|clearance|release|d\/?o|delivery order|broker/i,
      `${shipment.awb} - customs clearance status`,
    ),
    replyMessageId,
    conversation: conversationForReply(replyMessageId, "customs-release-thread", "waiting-for-customs-release"),
    body: actionBody([
      "Hi,",
      "",
      customsHold
        ? `Can you please confirm customs release/D.O. status for AWB ${shipment.awb}? Pickup is blocked by customs hold/exam.`
        : releaseMismatch
        ? `Driver/station does not see the release for AWB ${shipment.awb}. Can you please check?`
        : prearrival
        ? `Can you please confirm if AWB ${shipment.awb} is cleared/released for arrival?`
        : `Can you please confirm customs release/D.O. status for AWB ${shipment.awb}?`,
      customsHold ? storageContextLine(shipment) : "",
      "",
      "Thank you,",
      "Alex",
    ]),
    reason,
    timing: {
      stage: releaseMismatch
        ? "release-visible-to-station"
        : prearrival
        ? "prearrival-customs-clearance"
        : customsHold
        ? "customs-hold-release"
        : "arrival-customs-release",
      trigger: releaseMismatch
        ? "driver-or-station-release-mismatch"
        : prearrival
        ? "eta-within-clearance-lead-window"
        : customsHold
        ? "hold-or-exam-blocking-pickup"
        : "arrived-or-ready-no-clearance-proof",
      leadHours: prearrival?.leadHours || "",
      eta: prearrival?.eta?.toISOString?.() || "",
    },
    evidence: actionEvidence(shipment),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function needsPodFollowupDraft(shipment) {
  if (hasPodProof(shipment)) return false;
  const text = dispatchEvidenceText(shipment);
  const pickupOrDeliveryStarted =
    shipment.pickupStatus === "delivered" ||
    shipment.pickupStatus === "airport-picked-up" ||
    isFreightAirportPickedUpStatus(shipment.freightBroker?.status) ||
    isFreightDeliveredPendingPodStatus(shipment.freightBroker?.status) ||
    hasFreightPickupCompletionProofText(text);
  if (!pickupOrDeliveryStarted) return false;
  return isFreightPodFollowupStatus(shipment.freightBroker?.status) || shipment.pickupStatus === "delivered";
}

function storageContextLine(shipment) {
  const factSummary = [
    ...(shipment.stationContext?.stations || []).flatMap((station) => station.facts || []),
    ...(shipment.facts || []),
    ...(shipment.eodFacts || []),
  ]
    .map((fact) => `${fact.type || ""} ${fact.summary || fact.note || fact.label || ""}`)
    .find((text) => /\bstorage\b/i.test(text) && /\b(?:accruing since|starts?|last free|rate|\$\s*\d)/i.test(text));
  if (factSummary) {
    const summary = factSummary
      .replace(/^\s*storage\s+/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "");
    if (summary) return `Storage: ${summary}.`;
  }
  const storage = shipment.operationalMemory?.storage || shipment.stationContext?.storage;
  if (!storage || storage.status !== "known") return "";
  const parts = [
    storage.lastFreeDay ? `last free day ${storage.lastFreeDay}` : "",
    storage.storageStartsAt ? `storage starts ${storage.storageStartsAt}` : "",
    storage.storageAccruingSince ? `storage accruing since ${storage.storageAccruingSince}` : "",
    storage.dailyStorageRate ? `rate ${storage.dailyStorageRate}` : "",
  ].filter(Boolean);
  return parts.length ? `Storage: ${parts.join(" · ")}.` : "";
}

function podFollowupAction(shipment) {
  const freight = shipment.freightBroker || {};
  const targetEmail = isKnownContact(freight.contactEmail) ? contactEmailList(freight.contactEmail)[0] || "" : "";
  const routeToOps = !targetEmail;
  const replyMessageId = routeToOps
    ? ""
    : targetThreadReplyMessageId(shipment, targetEmail, /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i) ||
      latestThreadReplyMessageId(shipment, /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i);
  const detentionAsk = /\bdetention\b/i.test(
    `${freight.status || ""} ${freight.brokerStatus || ""} ${freight.pickupPlan || ""} ${shipment.emailValidation?.summary || ""}`,
  );
  return {
    id: `${normalizeAwb(shipment.awb) || shipment.id}-pod-followup`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "pod-followup",
    label: "Request POD",
    channel: "gmail",
    execution: "draft-only",
    safety: safetyForChannel("gmail"),
    status: "suggested",
    priority: "high",
    targetName: routeToOps ? "PQ ops" : freight.broker || "Pickup broker",
    targetEmail: routeToOps ? opsEscalationEmail : targetEmail,
    podContactMissing: routeToOps,
    originalTargetName: routeToOps ? freight.broker || "Pickup broker" : "",
    missing: routeToOps && !opsEscalationEmail ? ["Pickup broker email missing"] : [],
    subject: routeToOps
      ? `POD / pickup confirmation - AWB ${shipment.awb}`
      : targetThreadSubject(
          shipment,
          targetEmail,
          /broker|dispatch|pickup|pod|delivery|detention|quote|rate|truck/i,
          `POD / pickup confirmation - AWB ${shipment.awb}`,
        ),
    replyMessageId,
    conversation: replyMessageId
      ? {
          kind: "pickup-pod-thread",
          replyMessageId,
          stage: detentionAsk ? "waiting-for-detention-and-pod" : "waiting-for-pod",
        }
      : null,
    body: actionBody([
      routeToOps ? "Team," : "Hi,",
      "",
      routeToOps
        ? `Please find the pickup broker contact and request pickup/POD status for AWB ${shipment.awb}.`
        : detentionAsk
        ? `Can you please send POD and final detention time/cost for AWB ${shipment.awb}?`
        : `Can you please send POD/delivery confirmation for AWB ${shipment.awb}?`,
      routeToOps && freight.contactEmail ? `Unparsed contact field: ${freight.contactEmail}` : false,
      "",
      "Thank you,",
      "Alex",
    ]),
    reason: routeToOps
      ? "Pickup/POD proof is pending, but the pickup broker email is not known."
      : "Pickup/POD proof is pending.",
    timing: {
      stage: detentionAsk ? "post-delivery-detention-pod" : "post-delivery-pod",
      trigger: detentionAsk ? "delivered-or-picked-up-with-detention-open" : "delivered-or-picked-up-no-pod-proof",
    },
    evidence: actionEvidence(shipment),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function newestActionLayerTime(...values) {
  return values
    .flat()
    .map((value) => Date.parse(value || ""))
    .filter((time) => Number.isFinite(time))
    .sort((a, b) => b - a)[0] || 0;
}

function latestShipmentOperationalTime(shipment) {
  return newestActionLayerTime(
    shipment.emailValidation?.latestEventAt,
    shipment.freightBroker?.latestEventAt,
    shipment.customsBroker?.latestEventAt,
    shipment.lastEmail?.at,
    shipment.updatedAt,
    (shipment.factLedger || []).map((item) => item.at),
    (shipment.eodFacts || []).map((item) => item.at),
    (shipment.timeline || []).map((item) => item.at || item.timestamp || item.date),
  );
}

function hoursSinceActionLayerTime(time, now = new Date()) {
  if (!time) return Infinity;
  return Math.max(0, (now.getTime() - time) / (60 * 60 * 1000));
}

function currentActionsInclude(actions, types) {
  const set = new Set(types);
  return (actions || []).some((action) => set.has(action.type));
}

function activeCustomsContactSourceGap(shipment, phase, nextAction) {
  const customs = shipment.customsBroker || {};
  if (isCustomsResolvedStatus(customs.status || "")) return false;
  const releasePhase = ["release-needed", "customs-hold"].includes(phase) ||
    /\b(?:customs|release|d\/?o|delivery order|entry|broker)\b/i.test(nextAction);
  if (!releasePhase) return false;
  const hasCustomsEmail = isKnownContact(customs.contactEmail) && contactEmailList(customs.contactEmail).length;
  const gapText = [
    nextAction,
    shipment.opsState?.suggestedCommunicationAction,
    shipment.canonicalState?.suggestedCommunicationAction,
    customs.nextAction,
    customs.status,
    customs.broker,
    customs.contactEmail,
    shipment.emailValidation?.summary,
  ].filter(Boolean).join(" ");
  const asksForCustomsSource = /\b(?:customs broker|release thread|release\s*\/\s*d\.?o\.?|release\/DO|delivery order|entry|broker contact|find.*broker|missing.*broker)\b/i.test(gapText);
  return asksForCustomsSource && !hasCustomsEmail;
}

function activeSourceBackfillMissingStages(shipment) {
  if (isCompletedShipment(shipment) || canonicalPodComplete(shipment)) return [];
  const phase = String(shipment.opsState?.phase || "").toLowerCase();
  const nextAction = String(shipment.opsState?.nextAction || shipment.nextAction || "");
  const customsContactGap = activeCustomsContactSourceGap(shipment, phase, nextAction);
  if (shipment.emailValidation?.status !== "email-missing" && !customsContactGap) return [];
  if (!customsContactGap && ["pre-arrival", "in-transit"].includes(phase) && /\bmonitor arrival\b/i.test(nextAction)) return [];
  const phaseStages = {
    "customs-hold": ["arrival", "customs"],
    "dispatch-ready": ["arrival", "customs", "fees", "quote", "dispatch", "pickup"],
    "fees-needed": ["arrival", "fees"],
    "pickup-blocked": ["arrival", "customs", "dispatch", "pickup"],
    "release-needed": ["arrival", "customs", "release"],
    "station-confirmation-needed": ["arrival"],
  };
  const stages = [...(phaseStages[phase] || [])];
  if (/\barrival|station|available|on[- ]?hand|firm|lfd\b/i.test(nextAction)) stages.push("arrival");
  if (/\bcustoms|release|ace|abi|broker\b/i.test(nextAction)) stages.push("customs", "release");
  if (/\bfee|payment|storage|charge\b/i.test(nextAction)) stages.push("fees");
  if (/\bquote|rate\b/i.test(nextAction)) stages.push("quote");
  if (/\bdispatch|delivery order|d\/?o|award\b/i.test(nextAction)) stages.push("dispatch");
  if (/\bpickup|pod|deliver/i.test(nextAction)) stages.push("pickup");
  if (customsContactGap) stages.push("customs", "release", "customs-contact");
  return unique(stages.length ? stages : ["arrival", "customs", "dispatch"]);
}

function activeSourceBackfillAction(shipment) {
  const missingStages = activeSourceBackfillMissingStages(shipment);
  if (!missingStages.length) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const phase = shipment.opsState?.phase || "active";
  const nextAction = shipment.opsState?.nextAction || shipment.nextAction || "Review shipment state.";
  const customsContactGap = missingStages.includes("customs-contact");
  const urgentSourceGap = ["customs-hold", "dispatch-ready", "fees-needed", "pickup-blocked", "release-needed"].includes(String(phase).toLowerCase());
  const dispatchOwnerGap = String(phase).toLowerCase() === "dispatch-ready" && !freightHasActivePickupOwner(shipment);
  const problem = customsContactGap
    ? `Active shipment is ${phase}, and the customs broker email/release thread is not attached to the shipment state.`
    : dispatchOwnerGap
      ? `Active shipment is ${phase}, but dispatch/pickup owner proof is not attached to the shipment state.`
    : `Active shipment is ${phase}, but no durable Gmail proof is attached to the shipment state.`;
  return {
    id: `${awbKey}-active-source-backfill`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "source-backfill",
    label: customsContactGap ? "Find release source" : dispatchOwnerGap ? "Find dispatch source" : "Backfill source proof",
    channel: "platform",
    ...internalPlatformContract(
      "email_refresh",
      "Queue source backfill",
      "Operator-approved internal source repair. The dashboard queues Gmail/TMS proof research after the operator clicks; no outbound email or CourierCloud mutation is performed.",
    ),
    status: "suggested",
    priority: urgentSourceGap ? "urgent" : "high",
    targetName: "Ops Brain",
    targetEmail: "",
    subject: `${shipment.awb} - source proof backfill`,
    problem,
    reason: `${problem} Missing stages: ${missingStages.join(", ")}.`,
    nextAction: customsContactGap
      ? "Queue Gmail/TMS source research to find the customs broker/release thread before drafting a release follow-up."
      : dispatchOwnerGap
        ? "Queue Gmail/TMS source research to find the pickup broker, dispatch thread, or proof that quote requests are the real next step."
      : "Queue a Gmail/TMS source backfill before treating the current state as fully trusted.",
    body: actionBody([
      `AWB ${shipment.awb}: ${problem}`,
      `Current next action: ${nextAction}`,
      `Missing source stages: ${missingStages.join(", ")}`,
      customsContactGap
        ? "Search the exact AWB, undashed AWB, suffix-only AWB, customer, and release terms, then attach the broker contact/release thread to shipment truth."
        : "Search the exact AWB, undashed AWB, and suffix-only AWB, then merge the evidence into the shipment proof layer.",
    ]),
    missingPreDeliveryStages: missingStages,
    lookbackDays: 120,
    sourceCoverage: {
      completeness: "active-source-missing",
      missingPreDeliveryStages: missingStages,
      unresolvedMissingPreDeliveryStages: missingStages,
      needsHistoricalBackfill: true,
      lookbackDays: 120,
      backfillReason: "Active shipment has no durable Gmail proof.",
    },
    timing: {
      stage: "active-source-backfill",
      trigger: "active-actionable-email-proof-missing",
      phase,
    },
    evidence: unique([
      nextAction,
      shipment.opsState?.summary,
      ...actionEvidence(shipment),
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function carrierTrackingUnavailable(shipment) {
  const tracking = shipment.liveTracking || {};
  return Boolean(
    tracking.health === "unavailable" ||
      tracking.refreshable === true ||
      tracking.requiresFlightIntelligence === true ||
      ["TRACKING_UNAVAILABLE", "NO_RESULT", "FLIGHT_INTELLIGENCE_NEEDED"].includes(String(tracking.code || "").toUpperCase()) ||
      ["carrier-tracking-unavailable", "flight-intelligence-needed"].includes(shipment.trackingException?.type),
  );
}

function shipmentPastMovementResearch(shipment = {}) {
  const phase = String(shipment.opsState?.phase || shipment.stage || shipment.currentState || "").toLowerCase();
  const pickupStatus = String(shipment.pickupStatus || "").toLowerCase();
  const deliveryStatus = String(shipment.deliveryStatus || "").toLowerCase();
  return (
    ["out-for-delivery", "delivered-pod-pending", "delivered", "completed"].includes(phase) ||
    ["out-for-delivery", "delivered"].includes(deliveryStatus) ||
    ["out-for-delivery", "airport-picked-up", "picked-up", "picked up", "delivered"].includes(pickupStatus)
  );
}

function canonicalExceptionNextActionText(shipment = {}) {
  const phase = String(shipment.opsState?.phase || shipment.stage || shipment.currentState || "").toLowerCase();
  if (phase !== "exception") return "";
  return String(
    shipment.opsState?.nextAction ||
      shipment.nextAction ||
      shipment.operationalRisk?.action ||
      shipment.opsState?.suggestedCommunicationAction ||
      ""
  ).trim();
}

function canonicalExceptionNeedsNonTrackingAction(shipment = {}) {
  const text = canonicalExceptionNextActionText(shipment);
  if (!text) return false;
  const asksForOperationalExceptionHandling =
    /\b(?:wfs|cdg|uc360|ua area|awb copy|transfer|handoff|wrong consignee|wrong customer|another customer|another cnee|misdeliver|return shipment|station|broker|customs|release)\b/i.test(text);
  const asksForCarrierTrackingOnly =
    /\b(?:carrier tracking|united movement|verify movement|check flight status|tracking refresh)\b/i.test(text);
  return asksForOperationalExceptionHandling && !asksForCarrierTrackingOnly;
}

function actionTextForCanonicalCoverage(action = {}) {
  return [
    action.type,
    action.label,
    action.subject,
    action.problem,
    action.reason,
    action.nextAction,
    action.body,
    ...(Array.isArray(action.evidence) ? action.evidence : []),
  ].filter(Boolean).join(" ");
}

function actionCoversCanonicalExceptionNextAction(action = {}, shipment = {}) {
  if (action.timing?.stage === "canonical-action-gap") return true;
  if (!canonicalExceptionNeedsNonTrackingAction(shipment)) return false;
  if (action.type === "carrier-tracking-refresh") return false;
  const nextAction = canonicalExceptionNextActionText(shipment);
  const actionText = actionTextForCanonicalCoverage(action);
  if (!actionText) return false;
  const requiredTerms = [
    /\bwfs\b/i.test(nextAction) ? /\bwfs\b/i : null,
    /\bcdg\b/i.test(nextAction) ? /\bcdg\b/i : null,
    /\btransfer\b/i.test(nextAction) ? /\btransfer\b/i : null,
    /\bawb copy\b/i.test(nextAction) ? /\bawb copy\b/i : null,
    /\bua handoff\b|\bhandoff\b/i.test(nextAction) ? /\bhandoff\b/i : null,
    /\bwrong consignee|another customer|another cnee|misdeliver|return shipment\b/i.test(nextAction)
      ? /\bwrong consignee|another customer|another cnee|misdeliver|return shipment\b/i
      : null,
  ].filter(Boolean);
  if (!requiredTerms.length) return false;
  return requiredTerms.every((pattern) => pattern.test(actionText));
}

function canonicalExceptionActionGapUncovered(shipment = {}, currentActions = []) {
  if (!canonicalExceptionNeedsNonTrackingAction(shipment)) return false;
  return !(currentActions || []).some((action) => actionCoversCanonicalExceptionNextAction(action, shipment));
}

function carrierTrackingRefreshAction(shipment) {
  if (isCompletedShipment(shipment)) return null;
  if (shipmentPastMovementResearch(shipment)) return null;
  if (!carrierTrackingUnavailable(shipment)) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const tracking = shipment.liveTracking || {};
  const source = tracking.source || shipment.airline || "Movement source";
  const needsFlightIntelligence = movementVerificationNeedsFlightIntelligence(shipment, tracking);
  const flightDetails = movementFlightDetails(tracking);
  const flightLine = flightDetails.flights.length
    ? `Flight candidate${flightDetails.flights.length === 1 ? "" : "s"}: ${flightDetails.flights.join(", ")}`
    : flightDetails.tmsFlight
      ? `TMS flight fields: ${flightDetails.tmsFlight}`
      : "Flight details are not confirmed in the saved movement fields";
  const failureSummary = tracking.error || shipment.trackingException?.summary || (needsFlightIntelligence
    ? `${source} movement needs flight-status research.`
    : `${source} did not return usable movement.`);
  const stateProvenElsewhere = hasUsefulOperationalEmailProof(shipment) || hasStationArrivalProof(shipment);
  if (stateProvenElsewhere) return null;
  if (canonicalExceptionNeedsNonTrackingAction(shipment)) return null;
  const stationName = shipment.station || shipment.delivery?.airport || shipment.airport || "the station";
  const label = needsFlightIntelligence ? "Check flight status" : "Verify United movement";
  const problem = needsFlightIntelligence
    ? `${source} direct tracking is not reliable enough here, and no stronger email/station proof is available for the current movement state.`
    : `${source} movement is not currently reliable, and no stronger email/station proof is available for the current movement state.`;
  const nextAction = needsFlightIntelligence
    ? `Find the flight in Gmail/pre-alert, check the flight online, then confirm availability with ${stationName || "the station"} if the flight has landed.`
    : `Verify United movement again; if it still fails, call or email ${stationName || "the station"} and save the confirmed latest movement.`;
  return {
    id: `${awbKey}-carrier-tracking-refresh`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "carrier-tracking-refresh",
    label,
    channel: "platform",
    ...internalPlatformContract(
      "tracking_refresh",
      label,
      needsFlightIntelligence
        ? "Operator-approved movement verification. Non-United AWBs use Gmail/TMS flight details, public flight-status research, and station confirmation; no outbound email or CourierCloud mutation is performed."
        : "Operator-approved movement verification. United AWBs use the official United movement flow; no outbound email or CourierCloud mutation is performed.",
    ),
    status: "suggested",
    priority: "high",
    workstream: "truth-repair",
    targetName: stationName || source,
    targetEmail: "",
    subject: `${shipment.awb} - confirm latest movement`,
    problem,
    reason: `${failureSummary} Confirm the latest arrival/availability/ETA before relying on the movement state.`,
    nextAction,
    body: actionBody([
      `AWB ${shipment.awb}: ${needsFlightIntelligence ? "movement needs flight-status research" : `${source} movement is unavailable or unparsed`}.`,
      `Failure: ${failureSummary}`,
      needsFlightIntelligence ? flightLine : "",
      needsFlightIntelligence && flightDetails.route ? `Route: ${flightDetails.route}` : "",
      needsFlightIntelligence && flightDetails.etaHint ? `Timing hint: ${flightDetails.etaHint}` : "",
      `Current shipment state: ${shipment.opsState?.phase || shipment.arrivalStatus || "review"}.`,
      `Operator next step: ${nextAction}`,
      needsFlightIntelligence
        ? "The Check flight status button runs movement verification only; it does not send Gmail or mutate CourierCloud."
        : "The Verify movement button runs movement verification only; it does not send Gmail or mutate CourierCloud.",
    ]),
    carrier: source,
    station: shipment.station || "",
    trackingError: failureSummary,
    flightIntelligenceRequired: needsFlightIntelligence,
    flightDetails,
    flights: flightDetails.flights,
    tmsFlight: flightDetails.tmsFlight || "",
    route: flightDetails.route || "",
    publicFlightStatus: tracking.publicFlightStatus || null,
    liveTracking: {
      source,
      status: tracking.status || "",
      code: tracking.code || "",
      checkedAt: tracking.checkedAt || "",
      error: failureSummary,
      requiresFlightIntelligence: needsFlightIntelligence,
      flightDetails,
      flights: flightDetails.flights,
      tmsFlight: flightDetails.tmsFlight || "",
      route: flightDetails.route || "",
      publicFlightStatus: tracking.publicFlightStatus || null,
    },
    timing: {
      stage: needsFlightIntelligence ? "flight-status-verification" : "united-movement-verification",
      trigger: needsFlightIntelligence ? "flight-intelligence-needed" : "united-movement-unavailable",
      checkedAt: tracking.checkedAt || "",
    },
    evidence: unique([
      failureSummary,
      needsFlightIntelligence ? flightLine : "",
      tracking.scheduledArrival ? `Scheduled arrival: ${tracking.scheduledArrival}` : "",
      ...actionEvidence(shipment),
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function pickupOrDeliveryAlreadyAdvanced(shipment) {
  const text = dispatchEvidenceText(shipment);
  return shipment.pickupStatus === "delivered" ||
    shipment.pickupStatus === "airport-picked-up" ||
    shipment.pickupStatus === "out-for-delivery" ||
    shipment.deliveryStatus === "out-for-delivery" ||
    hasPodProof(shipment) ||
    hasFreightPickupCompletionProofText(text) ||
    isFreightDeliveredStatus(shipment.freightBroker?.status || "") ||
    isFreightAirportPickedUpStatus(shipment.freightBroker?.status || "");
}

function operatorStateCheckAction(shipment, currentActions = [], now = new Date()) {
  if (isCompletedShipment(shipment)) return null;
  if (canonicalPodComplete(shipment)) return null;
  if (currentActionsInclude(currentActions, [
    "ops-escalation",
    "operator-state-check",
    "customs-followup",
    "customer-update",
    "storage-risk",
    "station-confirmation",
    "quote-request",
    "quote-followup",
	    "broker-award",
	    "broker-status-followup",
	    "delivery-order-email",
	    "dispatch-pickup-followup",
	    "pod-followup",
		    "release-packet-contact-gap",
		    "source-backfill",
		    "station-fee-confirmation",
		    "station-contact-research",
		    "tms-broker-award-experience",
	    "tms-pod-closeout-experience",
	  ])) {
    return null;
  }

  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const latestTime = latestShipmentOperationalTime(shipment);
  const hoursStale = hoursSinceActionLayerTime(latestTime, now);
  const arrivedOrReady = shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready" || hasStationArrivalProof(shipment);
  const customsReady = isCustomsResolvedStatus(shipment.customsBroker?.status || "");
  const hasActiveOwner = freightHasActivePickupOwner(shipment);
  const pickupAdvanced = pickupOrDeliveryAlreadyAdvanced(shipment);
  const quotes = pickupQuoteRecords(shipment);
  const canAward = canAwardPickupBroker(shipment);
  const dispatchDue = dispatchPickupFollowupDueStatus(shipment, now);
  const evidence = actionEvidence(shipment);
  let trigger = "";
  let label = "Update shipment state";
  let reason = "";
  let body = "";
  let priority = "normal";
  let updateOptions = [];
  let outcomeOptions = [];

  if (canAward && quotes.length) {
    const quote = recommendedPickupQuote(shipment) || quotes[0];
    trigger = "quote-ready-no-award-action";
    label = "Choose pickup broker";
    priority = "high";
    reason = `Pickup quotes are available${quote?.broker ? `; recommended ${quote.broker} ${quoteAmountLabel(quote)}` : ""}, but no broker-award action is currently actionable.`;
    body = [
      `AWB ${shipment.awb}: quotes are in, but the system still needs the operator decision.`,
      quote ? `Recommended quote: ${quote.broker} ${quoteAmountLabel(quote)}.` : "",
      "Update with the broker you approved, or write why pickup should stay on hold.",
    ].filter(Boolean).join(" ");
    updateOptions = [
      "Approved the recommended pickup broker",
      "Approved a different pickup broker",
      "Hold pickup; do not award yet",
    ];
    outcomeOptions = [
      { value: "approved-recommended-broker", label: "Approved recommended broker", factTypes: ["broker-award"] },
      { value: "approved-different-broker", label: "Approved different broker", factTypes: ["broker-award"] },
      { value: "hold-pickup", label: "Hold pickup", factTypes: ["exception"] },
    ];
  } else if (dispatchDue?.due && !pickupAdvanced) {
    trigger = "pickup-or-delivery-status-stale";
    label = "Confirm pickup status";
    priority = "high";
    reason = dispatchDue.detail || "Pickup/delivery window passed, but no pickup, delivery, or POD proof is saved.";
    body = `AWB ${shipment.awb}: ${reason} If you spoke with the driver or broker, update what actually happened.`;
    updateOptions = [
      "Picked up",
      "Out for delivery",
      "Delivered, POD pending",
      "Delivered with POD",
      "Still waiting at station",
    ];
    outcomeOptions = [
      { value: "picked-up", label: "Picked up", factTypes: ["pickup"] },
      { value: "out-for-delivery", label: "Out for delivery", factTypes: ["delivery"] },
      { value: "delivered-pod-pending", label: "Delivered, POD pending", factTypes: ["delivery", "pod-pending"] },
      { value: "delivered-with-pod", label: "Delivered with POD", factTypes: ["delivery", "pod"] },
      { value: "still-waiting-station", label: "Still waiting at station", factTypes: ["exception"] },
    ];
  } else if (
    arrivedOrReady &&
    customsReady &&
    !hasActiveOwner &&
    !pickupAdvanced &&
    !shouldRequestBrokerQuotes(shipment) &&
    !hasPickupBrokerQuotes(shipment) &&
    hoursStale >= 24
  ) {
    trigger = "arrived-cleared-idle-24h";
    label = "State check";
    priority = "high";
    reason = "Arrived/released for more than a day with no quote, broker award, dispatch, pickup, delivery, or POD proof.";
    body = `AWB ${shipment.awb}: the system sees arrival/release, then no downstream movement for ${Math.floor(hoursStale)}h. Did quote requests, broker award, pickup, or delivery happen outside Gmail/TMS?`;
    updateOptions = [
      "Quote requests were sent",
      "Pickup broker was approved",
      "Picked up",
      "Delivered, POD pending",
      "No movement yet",
    ];
    outcomeOptions = [
      { value: "quote-requests-sent", label: "Quote requests were sent", factTypes: ["quote"] },
      { value: "broker-approved", label: "Pickup broker was approved", factTypes: ["broker-award"] },
      { value: "picked-up", label: "Picked up", factTypes: ["pickup"] },
      { value: "delivered-pod-pending", label: "Delivered, POD pending", factTypes: ["delivery", "pod-pending"] },
      { value: "no-movement-yet", label: "No movement yet", factTypes: ["operator-state"] },
    ];
  }

  if (!trigger) return null;
  return {
    id: `${awbKey}-operator-state-check-${trigger}`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "operator-state-check",
    label,
    channel: "platform",
    ...internalPlatformContract(
      "operator-browser-truth",
      "Record state truth",
      "Operator-approved structured phone fact. The dashboard appends exact state evidence to the relational operator-event authority; canonical truth changes only after the truth worker reduces it.",
    ),
    status: "suggested",
    priority,
    targetName: "Operator",
    targetEmail: "",
    subject: `${shipment.awb} - operator state check`,
    body,
    reason,
    nextAction: "Update the shipment with what happened outside the system, or dismiss if the state is still accurate.",
    timing: {
      stage: "operator-state-check",
      trigger,
      latestEventAt: latestTime ? new Date(latestTime).toISOString() : "",
      hoursStale: Number.isFinite(hoursStale) ? Math.floor(hoursStale) : "",
    },
    operatorUpdateOptions: updateOptions,
    operatorOutcomeOptions: outcomeOptions,
    evidence: unique([reason, ...evidence]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function canonicalActionGapNeedsOperator(shipment, currentActions = []) {
  if (canonicalPodComplete(shipment)) return false;
  const phase = String(shipment.opsState?.phase || "").toLowerCase();
  const nextAction = String(shipment.opsState?.nextAction || shipment.nextAction || "");
  const priority = String(shipment.opsState?.priority || "").toLowerCase();
  if (currentActions?.length) {
    if (canonicalExceptionActionGapUncovered(shipment, currentActions)) return true;
    const actionTypes = new Set(currentActions.map((action) => action.type));
    const onlyQuotePrep = [...actionTypes].every((type) => ["quote-request", "quote-followup", "quote-review", "prearrival-quote-decision"].includes(type));
    const blockingPhase = ["release-needed", "customs-hold", "station-confirmation-needed", "pickup-blocked"].includes(phase);
    return blockingPhase && onlyQuotePrep;
  }
  if (["pre-arrival", "in-transit"].includes(phase) && /\bmonitor arrival\b/i.test(nextAction)) return false;
  return (
    ["high", "critical", "urgent", "medium"].includes(priority) ||
    !["pre-arrival", "in-transit"].includes(phase) ||
    /\b(?:find|search|ask|call|confirm|release|dispatch|blocked|missing|unknown|do not dispatch|pickup|pod|station|broker|customs)\b/i.test(nextAction)
  );
}

function canonicalActionGapPing(shipment, currentActions = []) {
  if (!canonicalActionGapNeedsOperator(shipment, currentActions)) return null;
  const awbKey = normalizeAwb(shipment.awb) || shipment.id;
  const nextAction = shipment.opsState?.nextAction || shipment.nextAction || "Review shipment state and decide the next safe move.";
  const phase = shipment.opsState?.phase || "review";
  const suggested = shipment.opsState?.suggestedCommunicationAction || shipment.canonicalState?.suggestedCommunicationAction || "";
  const reason = suggested && !/^No action\b/i.test(suggested) ? suggested : nextAction;
  return {
    id: `${awbKey}-canonical-action-gap`,
    shipmentId: shipment.id,
    awb: shipment.awb,
    type: "operator-ping",
    label: "Resolve next step",
    channel: "platform",
    execution: "platform-alert",
    autonomy: {
      ...autonomyForChannel("platform"),
      requiresHumanApproval: true,
    },
    safety: safetyForChannel("platform"),
    status: "suggested",
    priority: shipment.opsState?.priority === "normal" ? "high" : shipment.opsState?.priority || "high",
    targetName: "Operator",
    targetEmail: "",
    problem: `Canonical state ${phase} has no executable action packet.`,
    nextAction,
    subject: `${shipment.awb} - resolve canonical action gap`,
    body: actionBody([
      `AWB ${shipment.awb}: ${nextAction}`,
      suggested && suggested !== nextAction ? `Suggested communication/action: ${suggested}` : "",
      "Update the shipment with the real outcome, contact, thread, or reason this should be monitored.",
    ]),
    reason,
    timing: {
      stage: "canonical-action-gap",
      trigger: "canonical-next-action-without-action-packet",
      phase,
    },
    evidence: unique([
      shipment.opsState?.summary,
      nextAction,
      ...(shipment.opsState?.evidence || []).map((item) => item.summary || item.evidence || item.note || item.label || ""),
    ]).slice(0, 4),
    orderLink: shipment.tms?.orderLink || "",
  };
}

function canonicalPlannedActionsForShipment(shipment, candidateActions = []) {
  const plan = buildCanonicalActionPlan(shipment, candidateActions);
  const seen = new Set();
  return [plan.primaryAction, ...(plan.truthRepairActions || [])]
    .filter(Boolean)
    .filter((action) => action.type !== "carrier-tracking-refresh")
    .filter((action) => {
      const key = action.id || `${normalizeAwb(action.awb)}:${action.type}:${action.targetEmail || action.targetName || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function recommendedActionsForShipment(shipment) {
  if (canonicalPodComplete(shipment)) return [];
  const actions = [];
  const opsEscalation = opsEscalationAction(shipment);
  if (opsEscalation) actions.push(opsEscalation);
  const sourceBackfill = activeSourceBackfillAction(shipment);
  if (sourceBackfill) actions.push(sourceBackfill);
  const sourceBackfillMustRunFirst = Boolean(sourceBackfill?.sourceCoverage?.needsHistoricalBackfill);
  const trackingRefresh = carrierTrackingRefreshAction(shipment);
  if (trackingRefresh) actions.push(trackingRefresh);
  if (liveDriverReleaseOrDoProblemForShipment(shipment)) {
    const moneyContext = tmsMoneyContextAction(shipment, actions);
    if (moneyContext && process.env.PIKIIO_EXPOSE_ECONOMICS_ACTIONS === "1") actions.push(moneyContext);
    return canonicalPlannedActionsForShipment(shipment, actions);
  }
  const linehaulFollowupReplacesStationStatus = linehaulFollowupCanReplaceStationStatus(shipment);
  const brokerFollowupReplacesStationStatus = brokerActivityCanReplaceStationStatus(shipment);
  const customsFollowupReplacesStationStatus = customsFollowupCanReplaceStationStatus(shipment);
  const podFollowupReplacesStationStatus = podFollowupCanReplaceStationStatus(shipment);
  const quoteRequests = quoteRequestActions(shipment);
  const stationFeeAction = stationFeeConfirmationAction(shipment);
  if (stationFeeAction) actions.push(stationFeeAction);
  const quoteRequestsReplaceStationStatus = quoteRequests.length &&
    !stationStatusNeedsDirectStationAsk(shipment) &&
    shipment.opsState?.phase !== "station-confirmation-needed";
  const storageAction = storageRiskAction(shipment);
  if (
    needsStationStatusDraft(shipment) &&
    !sourceBackfillMustRunFirst &&
    !linehaulFollowupReplacesStationStatus &&
    !brokerFollowupReplacesStationStatus &&
    !customsFollowupReplacesStationStatus &&
    !podFollowupReplacesStationStatus &&
    !storageAction &&
    !stationFeeAction &&
    !quoteRequestsReplaceStationStatus
  ) {
    pushExternalAction(actions, stationConfirmationAction(shipment));
  }

  if (customsNeedsBrokerFollowup(shipment)) {
    pushExternalAction(actions, customsFollowupAction(shipment));
  }

  if (needsCustomerUpdateDraft(shipment)) {
    pushExternalAction(actions, customerUpdateAction(shipment));
  }

  pushExternalAction(actions, storageAction);

  pushExternalActions(actions, quoteFollowupActions(shipment));
  pushExternalActions(actions, quoteRequests);
  const prearrivalQuote = prearrivalQuoteDecisionAction(shipment);
  if (prearrivalQuote) actions.push(prearrivalQuote);
  pushExternalActions(actions, brokerAwardActions(shipment));
  const tmsAward = tmsBrokerAwardExperienceAction(shipment);
  if (tmsAward) actions.push(tmsAward);
  const tmsPodCloseout = tmsPodCloseoutExperienceAction(shipment);
  if (tmsPodCloseout) actions.push(tmsPodCloseout);
  const releasePacket = releasePacketAction(shipment);
  if (releasePacket) {
    if (releasePacket.channel === "platform") actions.push(releasePacket);
    else pushExternalAction(actions, releasePacket);
  }
  const dispatchedPickupFollowupNeeded = needsDispatchedPickupFollowup(shipment);
  if (dispatchedPickupFollowupNeeded) pushExternalAction(actions, dispatchPickupFollowupAction(shipment));
  if (needsBrokerStatusFollowup(shipment)) pushExternalAction(actions, brokerStatusFollowupAction(shipment));
  if (!dispatchedPickupFollowupNeeded && needsPodFollowupDraft(shipment)) pushExternalAction(actions, podFollowupAction(shipment));
  const stationContactPrep = stationContactPrepAction(shipment);
  if (stationContactPrep) actions.push(stationContactPrep);
  const stateCheck = operatorStateCheckAction(shipment, actions);
  if (stateCheck) actions.push(stateCheck);
  const actionGap = canonicalActionGapPing(shipment, actions);
  if (actionGap) actions.push(actionGap);
  const moneyContext = tmsMoneyContextAction(shipment, actions);
  if (moneyContext && process.env.PIKIIO_EXPOSE_ECONOMICS_ACTIONS === "1") actions.push(moneyContext);
  return canonicalPlannedActionsForShipment(shipment, actions);
}

function actionWorkstream(action = {}) {
  if (action.type === "money-context-review") return "economics";
  if (action.actionPlanRole === "truth-repair") return "truth-repair";
  if (action.actionPlanRole === "primary" && action.channel === "platform") return "decision";
  if (action.type === "operator-ping" && action.timing?.stage === "canonical-action-gap") return "truth-repair";
  if (["source-backfill", "station-contact-research", "carrier-tracking-refresh"].includes(action.type)) return "truth-repair";
  if (["operator-state-check", "prearrival-quote-decision"].includes(action.type)) return "decision";
  return "execution";
}

function actionSortTier(action = {}) {
  const workstream = action.workstream || actionWorkstream(action);
  if (workstream === "execution") return 0;
  if (workstream === "decision") return 1;
  if (workstream === "truth-repair") return 2;
  if (workstream === "economics") return 3;
  return 4;
}

function actionPriorityRank(action = {}) {
  return {
    critical: 0,
    urgent: 0,
    high: 1,
    medium: 2,
    normal: 3,
    low: 4,
  }[String(action.priority || "normal").toLowerCase()] ?? 3;
}

function mergeActionQueue(existingActions, shipments, snapshotTime, outboxRequests = []) {
  const previousById = new Map((existingActions || []).map((action) => [action.id, action]));
  const outboxByActionId = new Map();
  for (const request of outboxRequests || []) {
    const actionId = request.actionId || request.id;
    if (!actionId) continue;
    const previous = outboxByActionId.get(actionId);
    if (!previous || actionEventTime(request) >= actionEventTime(previous)) {
      outboxByActionId.set(actionId, request);
    }
  }
  const actions = [];

  for (const shipment of shipments) {
    const shipmentWithHistory = {
      ...shipment,
      actionHistory: actionHistoryForShipment(shipment, existingActions || [], outboxRequests),
    };
    for (const action of recommendedActionsForShipment(shipmentWithHistory)) {
      const previous = previousById.get(action.id);
      const outboxRequest = outboxByActionId.get(action.id);
      const nextAction = {
        ...(previous || {}),
        ...action,
        autonomy: action.autonomy || autonomyForChannel(action.channel),
        betaContract: action.betaContract || previous?.betaContract || betaDraftModeContract(),
        status: outboxRequest ? actionEventStatus(outboxRequest, "outbox") : previous?.status || action.status,
        outboxRequestId: outboxRequest?.id || previous?.outboxRequestId || action.outboxRequestId,
        agentJobId: outboxRequest?.agentJobId || previous?.agentJobId || action.agentJobId,
        gmailDraftId: outboxRequest?.gmailDraftId || previous?.gmailDraftId || action.gmailDraftId,
        gmailMessageId: outboxRequest?.gmailMessageId || previous?.gmailMessageId || action.gmailMessageId,
        replyMessageId: action.replyMessageId || outboxRequest?.replyMessageId || previous?.replyMessageId,
        draftedAt: outboxRequest?.draftedAt || previous?.draftedAt || action.draftedAt,
        sentAt: outboxRequest?.sentAt || previous?.sentAt || action.sentAt,
        completedAt: outboxRequest?.completedAt || previous?.completedAt || action.completedAt,
        createdAt: previous?.createdAt || snapshotTime,
        updatedAt: snapshotTime,
      };
      const workstream = actionWorkstream(nextAction);
      actions.push({
        ...nextAction,
        workstream,
        sortTier: actionSortTier({ ...nextAction, workstream }),
      });
    }
  }

  return actions.sort((a, b) => {
    return (
      actionPriorityRank(a) - actionPriorityRank(b) ||
      actionSortTier(a) - actionSortTier(b) ||
      String(a.awb).localeCompare(String(b.awb)) ||
      String(a.type).localeCompare(String(b.type))
    );
  });
}

function actionAutonomyCounts(actions) {
  return {
    l2Actions: actions.filter((action) => action.autonomy?.level === "L2").length,
    draftOnlyActions: actions.filter((action) =>
      action.autonomy?.mode === "draft-only" || action.safety?.mode === "draft-only"
    ).length,
    tmsOperatorActions: actions.filter((action) =>
      action.autonomy?.mode === "operator-approved-tms" || action.safety?.mode === "operator-approved-tms"
    ).length,
    internalOperatorActions: actions.filter((action) =>
      action.autonomy?.mode === "operator-approved-internal" || action.safety?.mode === "operator-approved-internal"
    ).length,
    humanApprovalActions: actions.filter((action) => action.autonomy?.requiresHumanApproval === true).length,
    liveExecutionActions: actions.filter((action) => action.autonomy?.liveExecution === true).length,
  };
}

function actionEventTime(record) {
  const value = record.sentAt || record.draftedAt || record.completedAt || record.queuedAt || record.updatedAt || record.createdAt || record.requestedAt || record.at;
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function isStaleLocalOutbox(record, source, now = new Date()) {
  if (source !== "outbox") return false;
  if (
    record.agentJobId ||
    record.sentAt ||
    record.draftedAt ||
    record.gmailMessageId ||
    record.gmailDraftId ||
    ["sent", "drafted"].includes(record.status)
  ) return false;
  if (record.status !== "queued" && !record.queuedAt) return false;
  const queuedAt = Date.parse(record.queuedAt || record.createdAt || "");
  return Number.isFinite(queuedAt) && now.getTime() - queuedAt > 20 * 60 * 1000;
}

function actionEventStatus(record, source) {
  if (isStaleLocalOutbox(record, source)) return "failed";
  if (record.status === "drafted" || record.draftedAt || record.gmailDraftId) return "drafted";
  if (record.status === "sent" || record.sentAt || record.gmailMessageId) return "sent";
  if (record.status === "failed" || record.error || record.lastError) return "failed";
  if (record.status === "queued" || record.queuedAt || record.agentJobId) return "queued";
  return record.status || "suggested";
}

function actionEventSummary(record, source) {
  const status = actionEventStatus(record, source);
  const targetEmail = record.targetEmail || record.to || "";
  const target = record.targetName || KNOWN_ACTION_RECIPIENTS.get(String(targetEmail).toLowerCase()) || targetEmail || "recipient";
  const original = record.stationContactMissing
    ? [record.originalTargetName, record.originalTargetEmail].filter(Boolean).join(" / ")
    : "";
  const suffix = original ? `; not using ${original}` : "";
  if (status === "drafted") return `Drafted to ${target}${suffix}`;
  if (status === "sent" && record.safety?.mode === "draft-only") return `Drafted to ${target}${suffix}`;
  if (status === "sent") return `Sent to ${target}${suffix}`;
  if (status === "queued") return `Queued to ${target}${suffix}`;
  if (isStaleLocalOutbox(record, source)) return `Not drafted to ${target}; retry from the dashboard`;
  if (status === "failed") return `Failed sending to ${target}`;
  return record.reason || `${record.label || "Action"} suggested`;
}

function actionHistoryEvent(record, source) {
  const targetEmail = record.targetEmail || record.to || "";
  const targetName = record.targetName || KNOWN_ACTION_RECIPIENTS.get(String(targetEmail).toLowerCase()) || "";
  const event = {
    id: `${source}:${record.id || record.actionId || record.subject || targetEmail}`,
    actionId: record.actionId || record.id || "",
    type: record.type || record.execution || "action",
    label: record.label || record.subject || "Action",
    channel: record.channel || "unknown",
    status: actionEventStatus(record, source),
    targetName,
    targetEmail,
    cc: record.cc || "",
    subject: record.subject || "",
    gmailMessageId: record.gmailMessageId || record.messageId || "",
    gmailDraftId: record.gmailDraftId || record.draftId || "",
    replyMessageId: record.replyMessageId || record.gmailMessageId || record.messageId || "",
    originalTargetName: record.originalTargetName || "",
    originalTargetEmail: record.originalTargetEmail || "",
    stationContactMissing: Boolean(record.stationContactMissing),
    at: record.sentAt || record.draftedAt || record.completedAt || record.queuedAt || record.updatedAt || record.createdAt || record.requestedAt || "",
    summary: actionEventSummary(record, source),
    source,
  };
  return event;
}

function humanEmailActor(text) {
  if (/\bjordan\b|jordan\.demo/i.test(text)) return "Jordan";
  if (/\balex\b|alex@|alexdemo/i.test(text)) return "Alex";
  if (/\bpiki\b|@demo-freight\.example/i.test(text)) return "PQ";
  return "";
}

function shipmentEmailWorkRows(shipment) {
  const rows = [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map((item) => `${item.label || ""} ${item.note || item}`),
    ...(shipment.timeline || []).map((row) => Array.isArray(row) ? row.join(" ") : row),
    ...(shipment.freightBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
    ...(shipment.customsBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
  ];
  return unique(rows).filter((row) =>
    /\b(jordan|alex|piki|sent|emailed|forwarded|asked|requested|followed up|quote asked|quote request|rate request|cc'd|cced)\b/i.test(
      row,
    )
  );
}

function humanEmailBaseEvent(shipment, type, target, text, index) {
  const actor = humanEmailActor(text) || "Human";
  const awb = normalizeAwb(shipment.awb || shipment.id || "shipment");
  const targetEmail = target.email || "";
  const targetName = target.name || targetEmail || "recipient";
  return {
    id: `gmail-human:${awb}:${type}:${String(targetEmail || targetName).toLowerCase().replace(/\W+/g, "")}:${index}`,
    actionId: "",
    type,
    label: type === "quote-request"
      ? "Quote request"
      : type === "station-confirmation"
        ? "Station check"
        : type === "pod-followup"
          ? "POD follow-up"
          : "Customs follow-up",
    channel: "gmail",
    status: "sent",
    targetName,
    targetEmail,
    cc: "",
    subject: "",
    at: shipment.emailValidation?.latestEventAt || shipment.latestEventAt || shipment.updatedAt || "",
    summary: `${actor} already emailed ${targetName}`,
    reason: text,
    source: "gmail-human",
  };
}

function humanQuoteRequestEvents(shipment, text, index) {
  if (!/\b(quote|rate)\b/i.test(text) || !/\b(ask|asked|request|requested|sent|emailed|forwarded|quote asked)\b/i.test(text)) {
    return [];
  }
  const lower = text.toLowerCase();
  const allBrokers = /\b(all brokers|all agents|all carriers|blast|quote request sent)\b/i.test(text);
  return quoteBrokers
    .filter((broker) =>
      allBrokers ||
      lower.includes(broker.email.toLowerCase()) ||
      lower.includes(broker.name.toLowerCase()) ||
      broker.name.toLowerCase().split(/\s+/).every((part) => lower.includes(part))
    )
    .map((broker) => humanEmailBaseEvent(shipment, "quote-request", broker, text, index));
}

function humanStationEmailEvents(shipment, text, index) {
  if (!/\b(station|warehouse|import desk|arrival|arrived|available|availability|on hand|noa)\b/i.test(text)) return [];
  if (!/\b(ask|asked|request|requested|sent|emailed|forwarded|followed up|confirmation requested)\b/i.test(text)) return [];
  return [
    humanEmailBaseEvent(
      shipment,
      "station-confirmation",
      {
        name: shipment.handler || [shipment.station, shipment.airline].filter(Boolean).join(" · ") || "Station",
        email: contactEmailList(shipment.stationEmail)[0] || "",
      },
      text,
      index,
    ),
  ];
}

function humanCustomsEmailEvents(shipment, text, index) {
  if (!/\b(customs|release|clearance|broker|entry|do|delivery order|hold)\b/i.test(text)) return [];
  if (!/\b(ask|asked|request|requested|sent|emailed|forwarded|followed up)\b/i.test(text)) return [];
  const brokerName = shipment.customsBroker?.broker || shipment.customsBroker?.name || "Customs broker";
  const brokerEmail = contactEmailList(shipment.customsBroker?.contactEmail)[0] || "";
  if (!brokerEmail && !/\bcustoms\b/i.test(text)) return [];
  return [
    humanEmailBaseEvent(
      shipment,
      "customs-followup",
      { name: brokerName, email: brokerEmail },
      text,
      index,
    ),
  ];
}

function humanPodEmailEvents(shipment, text, index) {
  if (!/\bpod|proof of delivery|delivered|delivery proof\b/i.test(text)) return [];
  if (!/\b(ask|asked|request|requested|sent|emailed|forwarded|followed up)\b/i.test(text)) return [];
  const brokerName = shipment.freightBroker?.broker || shipment.freightBroker?.name || "Pickup broker";
  const brokerEmail = contactEmailList(shipment.freightBroker?.contactEmail)[0] || "";
  return [
    humanEmailBaseEvent(
      shipment,
      "pod-followup",
      { name: brokerName, email: brokerEmail },
      text,
      index,
    ),
  ];
}

function humanEmailEventsForShipment(shipment) {
  const events = [];
  shipmentEmailWorkRows(shipment).forEach((text, index) => {
    events.push(...humanQuoteRequestEvents(shipment, text, index));
    events.push(...humanStationEmailEvents(shipment, text, index));
    events.push(...humanCustomsEmailEvents(shipment, text, index));
    events.push(...humanPodEmailEvents(shipment, text, index));
  });
  return events;
}

function actionHistoryEventKey(event) {
  if (event.actionId) return event.actionId;
  if (event.source === "gmail-human") {
    return [
      event.source,
      event.type,
      String(event.targetEmail || event.targetName || "").toLowerCase(),
      event.status,
    ].filter(Boolean).join(":");
  }
  return event.id;
}

function actionHistoryForShipment(shipment, actions, outboxRequests) {
  const awbKey = normalizeAwb(shipment.awb);
  const byKey = new Map();
  const matchesShipment = (record) =>
    record.shipmentId === shipment.id ||
    (awbKey && normalizeAwb(record.awb) === awbKey);

  const putEvent = (event) => {
    const key = actionHistoryEventKey(event);
    const previous = byKey.get(key);
    byKey.set(key, previous ? { ...previous, ...event } : event);
  };

  for (const action of actions.filter(matchesShipment)) {
    putEvent(actionHistoryEvent(action, "action-queue"));
  }
  for (const request of (outboxRequests || []).filter(matchesShipment)) {
    putEvent(actionHistoryEvent(request, "outbox"));
  }
  for (const event of humanEmailEventsForShipment(shipment)) {
    putEvent(event);
  }

  return [...byKey.values()]
    .sort((a, b) => actionEventTime(b) - actionEventTime(a) || String(a.label).localeCompare(String(b.label)))
    .slice(0, 24);
}

function brainText(value, fallback = "") {
  return String(value || fallback || "").replace(/\s+/g, " ").trim();
}

function brainShort(value, fallback = "", maxLength = 180) {
  const text = brainText(value, fallback);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function brainFactTime(fact) {
  const parsed = Date.parse(fact?.at || fact?.date || fact?.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function brainThreadPurpose(facts) {
  const text = facts.map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`).join(" ");
  if (/\bpod|delivered|delivery\b/i.test(text)) return "POD / delivery";
  if (/\bpicked up|pickup|driver|loaded|detention\b/i.test(text)) return "Pickup";
  if (/\bquote|rate|award|broker\b/i.test(text)) return "Broker quotes";
  if (/\brelease|cleared|customs|d\/?o\b/i.test(text)) return "Customs";
  if (/\barrival|notice|on hand|station|storage|last free\b/i.test(text)) return "Station";
  return "Shipment context";
}

function brainShipmentStage(shipment) {
  const ops = shipment.opsState || {};
  return ops.label || ops.phase || shipment.nextAction || "Open";
}

function brainShipmentUrgency(shipment) {
  const ops = shipment.opsState || {};
  if (ops.priority === "critical") return "urgent";
  if (
    shipment.operationalMemory?.storage?.status === "known" &&
    /accruing|started|risk/i.test(JSON.stringify(shipment.operationalMemory.storage))
  ) return "urgent";
  if (shipment.attention || ops.needsHuman) return "watch";
  return "normal";
}

function brainLatestEmail(shipment) {
  const facts = (shipment.factLedger || [])
    .filter((fact) => fact.threadId || fact.messageId || /gmail|email/i.test(`${fact.type || ""} ${fact.source || ""}`))
    .sort((a, b) => brainFactTime(b) - brainFactTime(a));
  const first = facts[0];
  if (!first) return null;
  return {
    at: first.at || "",
    threadId: first.threadId || "",
    messageId: first.messageId || "",
    summary: brainShort(first.summary || first.source, "", 220),
    source: brainShort(first.source, "", 160),
  };
}

function brainDateTime(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(time));
}

function completedDeliveryRecipient(record) {
  const rows = [
    ...(record?.sourceEvents || []),
    ...(record?.sourceProof || []),
    ...(record?.evidence || []),
  ];
  const deliveryEvidence = rows.find((item) => {
    const text = `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`;
    return !/\b(station payment|cargosprint|payment evidence only|ground fee|handling fee)\b/i.test(text) &&
      /\b(delivered to|signature|receiver|pod images|proof of delivery)\b/i.test(text) &&
      !/\b(no .*pod|no .*delivery|payment evidence only|not pickup\/pod)\b/i.test(text);
  });
  const text = [
    deliveryEvidence?.note || deliveryEvidence?.evidence || "",
    record?.plan,
    ...rows.map((item) => `${item.label || ""} ${item.summary || ""} ${item.note || ""} ${item.evidence || ""}`),
  ].filter(Boolean).join(" ");
  return text.match(/\bdelivered to\s+([^.;,\n]+?)(?:\s+on\b|\s+at\b|[.;,\n]|$)/i)?.[1]?.trim() || "";
}

function completedDeliveryTimeText(record, fallbackDate) {
  const deliveryEvidence = (record?.evidence || []).find((item) => {
    const text = `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`;
    return !/\b(station payment|cargosprint|payment evidence only|ground fee|handling fee)\b/i.test(text) &&
      /\b(delivered to|signature|pod images|proof of delivery)\b/i.test(text);
  });
  const text = deliveryEvidence?.note || deliveryEvidence?.evidence || "";
  const explicit = text.match(/\bon\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\.?\s*[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i)?.[1];
  if (explicit) return explicit.replace(/,\s*2026\b/, "");
  return brainDateTime(fallbackDate);
}

function completedEvidencePriority(item) {
  const text = `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`;
  if (/\b(arrival|notice|release|customs|pickup|picked up|out for delivery|delivered|pod|proof of delivery)\b/i.test(text)) return 0;
  if (/\b(station payment|cargosprint|payment evidence only|ground fee|handling fee)\b/i.test(text)) return 2;
  if (/\b(delivered to|signature|pod images|proof of delivery)\b/i.test(text)) return 0;
  if (/\b(confirm|confirmed quote|awarded|selected)\b/i.test(text)) return 1;
  if (/\b(quote|rate)\b/i.test(text)) return 3;
  return 4;
}

function completedBrainEvidence(record) {
  return [
    ...(record?.sourceEvents || []).map((event) => ({
      type: event.type || "email",
      label: event.label || event.type || "Shipment event",
      note: event.summary || event.evidence || "",
      evidence: event.evidence || event.summary || "",
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      at: event.at || "",
      confidence: event.confidence || "",
    })),
    ...(record?.evidence || []),
  ]
    .filter((item) => {
      const text = `${item.label || ""} ${item.note || ""} ${item.evidence || ""}`;
      if (/\b(no .*pod|no .*pickup completion|no .*delivery|payment evidence only)\b/i.test(text) &&
        !/\b(delivered to|signature|pod images|proof of delivery)\b/i.test(text)) return false;
      return true;
    })
    .sort((a, b) => completedEvidencePriority(a) - completedEvidencePriority(b))
    .map((item) => ({
      type: /\b(station payment|cargosprint|payment evidence only|ground fee|handling fee)\b/i.test(`${item.label || ""} ${item.note || ""}`)
        ? "payment"
        : /\b(pod images|proof of delivery|delivered to|signature|receiver)\b/i.test(`${item.label || ""} ${item.note || ""}`)
        ? "pod"
        : "email",
      label: item.label || item.type || "POD",
      summary: brainShort(item.note || item.evidence || item.label || record.plan, "", 220),
      threadId: item.threadId || "",
      messageId: item.messageId || "",
      at: item.at || item.date || record.deliveredAt || record.completedAt || "",
      confidence: item.confidence || "high",
    }))
    .filter((item, index, rows) => {
      const key = [item.type, item.label, item.summary, item.threadId, item.messageId].join("|");
      return rows.findIndex((row) => [row.type, row.label, row.summary, row.threadId, row.messageId].join("|") === key) === index;
    })
    .filter((item) => item.summary || item.threadId || item.messageId);
}

function isCompletedSourceHoleCaveat(event = {}) {
  if (event.type !== "operator-control-gap") return false;
  const text = [
    event.label,
    event.summary,
    event.evidence,
  ].filter(Boolean).join(" ");
  return /\b(?:no standalone|no separate|not found|missing|source[-\s]?gap|not separately sourced|not separately attached|not available)\b/i.test(text);
}

function compactCompletedBrainSourceEvents(events = [], limit = 18) {
  const rows = (events || []).filter(Boolean);
  const keep = new Map();
  const remember = (event) => {
    const key = completedSourceEventKey(event);
    if (key) keep.set(key, event);
  };
  const criticalTypes = new Set([
    "pre-alert",
    "arrival-status",
    "arrival-notice",
    "arrival-notice-received",
    "arrival-context",
    "operator-control-gap",
    "documentation",
    "customs-request",
    "customs-docs",
    "customs-exception",
    "customs-broker-inferred",
    "broker-alerted",
    "broker-awarded",
    "station-fees-paid",
    "ground-fees-paid",
    "quote",
    "dispatch-release",
    "exception",
    "customs-resolution",
    "pickup-award",
    "pickup-docs-sent",
    "shipment-group-linked",
    "pickup-loaded",
    "pickup-dispatched",
    "pickup-scheduled",
    "pickup-status",
    "delivery-status",
    "delivery-pod",
    "delivered-reported",
    "pod-received",
    "manual-gmail-truth",
    "invoice",
    "invoice-pod",
    "closeout",
  ]);
  for (const type of criticalTypes) {
    const latestForType = rows
      .filter((event) => event.type === type)
      .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0];
    if (latestForType) remember(latestForType);
  }
  for (const event of rows.filter(isCompletedSourceHoleCaveat)) {
    remember(event);
  }
  for (const event of rows.slice().reverse()) {
    if (keep.size >= limit) break;
    remember(event);
  }
  return [...keep.values()]
    .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
}

function compactCompletedBrainSourceProof(proofRows = [], limit = 18) {
  return (proofRows || []).slice(-limit);
}

function brainCompletedShipment(record) {
  const publicRecord = {
    ...record,
    sourceEvents: mergeCompletedSourceEvents(record.sourceEvents || []),
    sourceProof: mergeCompletedSourceProof(record.sourceProof || []),
  };
  const evidence = completedBrainEvidence(publicRecord);
  const recipient = completedDeliveryRecipient(publicRecord) || publicRecord.consignee || "receiver";
  const deliveredAt = publicRecord.deliveredAt || publicRecord.completedAt || "";
  const deliveredLine = [
    `Delivered to ${recipient}`,
    completedDeliveryTimeText(record, deliveredAt),
  ].filter(Boolean).join(" · ");
  const brokerLine = [
    publicRecord.freightBroker,
    publicRecord.rate,
  ].filter(Boolean).join(" ");
  const podPending = publicRecord.podStatus === "signed-pod-pending";
  return {
    awb: publicRecord.awb,
    id: publicRecord.shipmentId || `completed-${normalizeAwb(publicRecord.awb) || publicRecord.awb}`,
    station: publicRecord.station || "",
    airline: "",
    client: publicRecord.client || "",
    consignee: publicRecord.consignee || "",
    eta: deliveredAt,
    stage: podPending ? "Delivered / POD review" : "Delivered",
    urgency: publicRecord.closeoutStatus ? "watch" : "normal",
    completed: true,
    pickupStatus: "delivered",
    currentState: deliveredLine || "Delivered; POD found.",
    nextAction: publicRecord.closeoutStatus
      ? brainShort(publicRecord.closeoutStatus.replace(/-/g, " "), "", 120)
      : "No action; POD found.",
    lastEmail: evidence[0]
      ? {
        at: evidence[0].at || deliveredAt,
        threadId: evidence[0].threadId || "",
        messageId: evidence[0].messageId || "",
        summary: evidence[0].summary,
        source: "Email thread",
      }
      : null,
    threads: [...new Set(evidence.map((item) => item.threadId).filter(Boolean))],
    contacts: {
      customs: { name: publicRecord.customsBroker || "", email: "", phone: "" },
      pickup: { name: publicRecord.freightBroker || "", email: "", phone: "" },
    },
    pod: {
      status: publicRecord.podStatus || "pod-found",
      deliveredAt,
      recipient,
    },
    freightBroker: {
      broker: publicRecord.freightBroker || "",
      status: publicRecord.freightStatus || "delivered",
      rate: publicRecord.rate || "",
      pickupPlan: publicRecord.plan || "",
      brokerStatus: publicRecord.plan || "",
    },
    customsBroker: {
      broker: publicRecord.customsBroker || "",
      status: publicRecord.customsBroker ? "released" : "",
    },
    facts: evidence.slice(0, 6),
    sourceHistory: publicRecord.sourceHistory || null,
    sourceCoverage: publicRecord.sourceCoverage || completedSourceCoverage(publicRecord, publicRecord.sourceEvents || [], publicRecord.sourceProof || [], publicRecord.sourceHistory || null),
    sourceEvents: compactCompletedBrainSourceEvents(publicRecord.sourceEvents || []),
    sourceProof: compactCompletedBrainSourceProof(publicRecord.sourceProof || []),
    completion: {
      podStatus: publicRecord.podStatus || "",
      closeoutStatus: publicRecord.closeoutStatus || "",
      deliveredAt,
      broker: brokerLine,
      sourceCompleteness: publicRecord.sourceCoverage?.completeness || "",
      sourceBackfillNeeded: Boolean(publicRecord.sourceCoverage?.needsHistoricalBackfill),
    },
  };
}

function buildOpsBrainMemory({ activeShipments, completedShipments = [], gmailProofData, actionQueue, snapshotTime }) {
  const shipments = (activeShipments || []).map((shipment) => {
    const latestEmail = brainLatestEmail(shipment);
    const action = (shipment.recommendedActions || actionQueue.filter((item) => item.shipmentId === shipment.id))[0] || null;
    return {
      awb: shipment.awb,
      id: shipment.id,
      station: shipment.station,
      airline: shipment.airline,
      client: shipment.client,
      consignee: shipment.delivery?.consignee || "",
      eta: shipment.eta || shipment.liveTracking?.scheduledArrival || "",
      stage: brainShipmentStage(shipment),
      urgency: brainShipmentUrgency(shipment),
      currentState: brainShort(shipment.opsState?.summary || shipment.detail || shipment.emailValidation?.summary || shipment.nextAction, "", 260),
      nextAction: brainShort(shipment.opsState?.nextAction || shipment.nextAction || action?.reason || "", "", 220),
      lastEmail: latestEmail,
      threads: [...new Set((shipment.factLedger || []).map((fact) => fact.threadId).filter(Boolean))],
      contacts: {
        station: {
          name: shipment.handler || shipment.stationContext?.handlerName || "",
          email: shipment.stationEmail || shipment.stationContext?.stationEmail || "",
          phone: shipment.stationPhone || shipment.stationContext?.stationPhone || "",
        },
        customs: {
          name: shipment.customsBroker?.broker || shipment.broker || "",
          email: shipment.customsBroker?.email || "",
          phone: shipment.customsBroker?.phone || "",
        },
        pickup: {
          name: shipment.freightBroker?.broker || "",
          email: shipment.freightBroker?.email || "",
          phone: shipment.freightBroker?.phone || "",
        },
      },
      storage: shipment.operationalMemory?.storage || null,
      pod: shipment.operationalMemory?.pod || null,
      money: shipment.operationalMemory?.money || null,
      blockers: shipment.opsState?.blockers || shipment.statusAudit?.missingInfo || [],
      facts: (shipment.factLedger || [])
        .slice()
        .sort((a, b) => brainFactTime(b) - brainFactTime(a))
        .slice(0, 8)
        .map((fact) => ({
          type: fact.type || "",
          label: fact.label || "",
          summary: brainShort(fact.summary || fact.source, "", 220),
          threadId: fact.threadId || "",
          messageId: fact.messageId || "",
          at: fact.at || "",
          confidence: fact.confidence || "",
      })),
    };
  });
  const completed = (completedShipments || [])
    .filter((record) => hasCompletedRecordProof(record))
    .map(brainCompletedShipment);

  const threadMap = new Map();
  function addThreadFact({ shipment, threadId, messageId = "", at = "", summary = "", type = "", label = "", source = "" }) {
    if (!threadId) return;
    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, { threadId, awbs: new Set(), participants: new Set(), latestAt: "", facts: [], unresolved: new Set() });
    }
    const thread = threadMap.get(threadId);
    if (shipment?.awb) thread.awbs.add(shipment.awb);
    const fromMatch = brainText(source).match(/\bfrom[:\s]+([^·|,]+)/i);
    if (fromMatch) thread.participants.add(fromMatch[1].trim());
    const fact = {
      awb: shipment?.awb || "",
      messageId,
      at,
      type,
      label,
      summary: brainShort(summary || source, "", 240),
    };
    thread.facts.push(fact);
    if (at && (!thread.latestAt || Date.parse(at) > Date.parse(thread.latestAt))) thread.latestAt = at;
    const actionText = `${summary} ${shipment?.nextAction || ""}`;
    if (/\bmissing|pending|needed|confirm|follow|request|ask|waiting|hold|storage\b/i.test(actionText)) {
      thread.unresolved.add(brainShort(shipment?.nextAction || summary, "", 160));
    }
  }

  for (const shipment of activeShipments || []) {
    for (const fact of shipment.factLedger || []) {
      addThreadFact({
        shipment,
        threadId: fact.threadId,
        messageId: fact.messageId,
        at: fact.at,
        summary: fact.summary,
        type: fact.type,
        label: fact.label,
        source: fact.source,
      });
    }
    for (const proof of shipment.emailValidation?.proof || []) {
      addThreadFact({
        shipment,
        threadId: proof.threadId,
        messageId: proof.messageId,
        at: proof.date || proof.at || "",
        summary: proof.evidence || proof.note || proof.label,
        type: proof.type || "email",
        label: proof.label || "",
        source: proof.from || "",
      });
    }
  }

  for (const proof of gmailProofData.proofs || []) {
    const shipment = { awb: proof.awb, nextAction: proof.emailValidation?.nextAction || "" };
    const proofItems = [
      ...(proof.emailValidation?.proof || []),
      ...(proof.proof || []),
    ];
    for (const item of proofItems) {
      addThreadFact({
        shipment,
        threadId: item.threadId,
        messageId: item.messageId,
        at: item.date || item.at || proof.latestEventAt || "",
        summary: item.evidence || item.note || item.label || proof.emailValidation?.summary,
        type: item.type || "email",
        label: item.label || proof.emailValidation?.status || "",
        source: item.from || "",
      });
    }
  }

  const threads = [...threadMap.values()].map((thread) => {
    const sortedFacts = thread.facts.slice().sort((a, b) => brainFactTime(b) - brainFactTime(a));
    return {
      threadId: thread.threadId,
      awbs: [...thread.awbs],
      participants: [...thread.participants].slice(0, 5),
      latestAt: thread.latestAt || sortedFacts[0]?.at || "",
      purpose: brainThreadPurpose(sortedFacts),
      summary: sortedFacts.slice(0, 3).map((fact) => fact.summary).filter(Boolean).join(" · "),
      facts: sortedFacts.slice(0, 6),
      unresolved: [...thread.unresolved].filter(Boolean).slice(0, 4),
    };
  }).sort((a, b) => Date.parse(b.latestAt || "") - Date.parse(a.latestAt || ""));

  const urgent = shipments
    .filter((shipment) => shipment.urgency !== "normal")
    .sort((a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"))
    .slice(0, 10);

  return {
    version: 1,
    snapshotTime,
    sourceOfTruth: "Thread and completed-shipment memory only. Active shipment truth lives exclusively in shipment-truth-packets.json.",
    summary: {
      activeShipments: activeShipments.length,
      completedShipments: completed.length,
      threadCount: threads.length,
      urgentCount: urgent.length,
      lastGmailAt: threads[0]?.latestAt || "",
    },
    suggestedQuestions: [
      "What's urgent now?",
      "What was the last email about this AWB?",
      "Which shipments have storage risk?",
      "Which shipments need broker follow-up?",
      "Which shipments are waiting on customs?",
    ],
    urgent,
    shipments,
    completed,
    threads,
  };
}

function evidenceSourceText(item) {
  if (!item) return "";
  if (typeof item !== "object") return String(item);
  return [
    item.source,
    item.threadId ? `thread ${item.threadId}` : "",
    item.messageId ? `message ${item.messageId}` : "",
    Array.isArray(item.evidence) ? item.evidence.map(evidenceSourceText).join(" · ") : item.evidence,
  ].filter(Boolean).join(" · ");
}

function factLedgerEvent(shipment, type, label, summary, options = {}) {
  const source = options.source || "";
  const sourceKey = `${source} ${options.threadId || ""} ${options.messageId || ""}`.trim();
  return {
    id: `${normalizeAwb(shipment.awb || shipment.id)}:${type}:${String(label).toLowerCase().replace(/\W+/g, "")}:${String(summary).slice(0, 64).replace(/\W+/g, "")}`,
    type,
    label,
    summary,
    source,
    sourceKey,
    confidence: options.confidence || shipment.statusAudit?.confidence || "medium",
    threadId: options.threadId || "",
    messageId: options.messageId || "",
    at: options.at || "",
    action: options.action || "",
    operatorSummary: options.operatorSummary || "",
  };
}

function pushFactEvent(events, shipment, type, label, summary, options = {}) {
  const text = String(summary || "").trim();
  if (!text) return;
  events.push(factLedgerEvent(shipment, type, label, text, options));
}

function isStorageMemoryFact(fact) {
  return /\b(last free|storage starts?|storage accruing|demurrage|\$\s*[\d,.]+\s*(?:\/|per )day)\b/i.test(
    `${fact?.type || ""} ${fact?.summary || ""} ${fact?.source?.note || ""}`,
  );
}

function operationalFactTime(fact) {
  return fact?.observedAt || fact?.occurredAt || fact?.createdAt || fact?.updatedAt || "";
}

function operationalFactType(fact) {
  const section = String(fact?.section || fact?.type || "").toLowerCase();
  const text = `${section} ${fact?.summary || ""} ${fact?.detail || ""} ${fact?.note || ""}`.toLowerCase();
  if (/\b(picked up|has been picked up|pickup completed|recovery complete|recovered)\b/i.test(text)) return "broker";
  if (/detention|driver wait|waiting charge/.test(text)) return "exception";
  if (/customs|release|clearance/.test(section)) return "customs";
  if (/broker|dispatch|pickup|quote/.test(section)) return /quote/.test(section) ? "quote" : "broker";
  if (/station|arrival/.test(section)) return "station";
  if (/storage|lfd|last[-\s]?free/.test(section)) return "storage";
  if (/payment/.test(section)) return "handler-payment-dispatch";
  if (/pod|delivery/.test(section)) return "pod";
  return "email";
}

function operationalFactLabel(fact, type) {
  const section = String(fact?.section || "").trim();
  const text = `${section} ${fact?.summary || ""} ${fact?.detail || ""} ${fact?.note || ""}`;
  if (type === "exception") return /detention/i.test(text) ? "Detention" : "Exception";
  if (type === "broker") return /picked[-\s]?up|pickup/i.test(fact?.summary || "") ? "Pickup" : "Dispatch";
  if (type === "quote") return "Quote";
  if (type === "customs") return "Customs";
  if (type === "station") return "Station";
  if (type === "storage") return "Storage";
  if (type === "pod") return "POD";
  if (type === "handler-payment-dispatch") return "Payment";
  return section || "Gmail";
}

function simpleBrokerName(value) {
  const text = String(value || "").trim();
  if (/btx/i.test(text)) return "BTX";
  if (/rapid/i.test(text)) return "Rapid";
  if (/jd\s*direct/i.test(text)) return "JD Direct";
  if (/freight\s*flex/i.test(text)) return "Freight Flex";
  if (/\btql\b/i.test(text)) return "TQL";
  if (/cartage\s*plus/i.test(text)) return "Cartage Plus";
  return text.split(/\s*[/·|]\s*/)[0]?.replace(/\b(Global|Logistics|Solutions|LLC|Inc\.?)\b/gi, "").replace(/\s+/g, " ").trim() || "Broker";
}

function detentionHoursFromText(value) {
  const text = String(value || "");
  const patterns = [
    /\b(?:detention|wait(?:ed|ing)?|driver wait(?:ed|ing)?)\D{0,40}(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i,
    /\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\D{0,50}(?:detention|wait(?:ed|ing)?|driver wait)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const hours = Number(match[1]);
    if (Number.isFinite(hours) && hours > 0) return hours;
  }
  return null;
}

function factText(fact) {
  if (!fact) return "";
  if (typeof fact === "string") return fact;
  return [fact.label, fact.note, fact.summary, fact.detail, evidenceItemText(fact.evidence)].filter(Boolean).join(" ");
}

function factsForDetentionContext(shipment) {
  return [
    ...(shipment.eodFacts || []),
    ...(shipment.freightBroker?.evidence || []),
  ].filter(Boolean);
}

function detentionContextForShipment(shipment) {
  const facts = factsForDetentionContext(shipment);
  let statedHours = null;
  let checkedInAt = "";
  let pickedUpAt = "";
  for (const fact of facts) {
    const text = factText(fact);
    const hours = detentionHoursFromText(text);
    if (hours !== null) statedHours = hours;
    const at = operationalFactTime(fact) || fact?.observedAt || "";
    if (!checkedInAt && /\b(checked[-\s]?in|waiting in line|driver is onsite|driver still onsite|still onsite)\b/i.test(text)) checkedInAt = at;
    if (!pickedUpAt && /\b(picked up|has been picked up|pickup completed|recovery complete|recovered)\b/i.test(text)) pickedUpAt = at;
  }

  const start = Date.parse(checkedInAt || "");
  const end = Date.parse(pickedUpAt || "");
  const estimatedHours = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 36e5 : null;
  return {
    statedHours,
    estimatedHours,
    hours: statedHours ?? estimatedHours,
    exact: statedHours !== null,
    costPending: facts.some((fact) => /\b(charge|cost|invoice|amount|rate).{0,60}\b(pending|expected|follow|tomorrow)|\badditional charge\b/i.test(factText(fact))),
    detentionPending: facts.some((fact) => /\bdetention\b.{0,80}\b(follow|pending|tomorrow|cost|charge)\b/i.test(factText(fact))),
  };
}

function compactHours(hours, exact) {
  if (!Number.isFinite(Number(hours))) return "";
  const rounded = Math.round(Number(hours) * 10) / 10;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(/\.0$/, "");
  return `${exact ? "" : "~"}${display}h`;
}

function compactAppointmentTime(text) {
  const match = String(text || "").match(/\b(?:for\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return "";
  return `${Number(match[1])}${match[2] ? `:${match[2]}` : ""} ${match[3].toUpperCase()}`;
}

function compactOperationalFactSummary(shipment, fact, summary, detentionContext) {
  const text = String(summary || "");
  const broker = simpleBrokerName([shipment.freightBroker?.broker, fact?.label, fact?.section].filter(Boolean).join(" "));
  const podPending = /\bpod\b.{0,80}\b(pending|needed|missing|still pending)|delivery evidence is still pending/i.test(text);
  const detentionText = detentionContext.hours
    ? `detention ${compactHours(detentionContext.hours, detentionContext.exact)}`
    : detentionContext.detentionPending || /\bdetention\b/i.test(text)
      ? "detention pending"
      : "";

  if (/\b(picked up|has been picked up|pickup completed|recovery complete|recovered)\b/i.test(text)) {
    return [broker ? `${broker} picked up` : "Picked up", detentionText, podPending ? "POD pending" : ""].filter(Boolean).join(" · ");
  }

  if (/\b(checked[-\s]?in|waiting in line)\b/i.test(text)) {
    return [`${broker} checked in`, shipment.station ? `waiting at ${shipment.station}` : "driver waiting"].filter(Boolean).join(" · ");
  }

  if (/\b(still onsite|driver is onsite)\b/i.test(text)) {
    return [`${broker} still onsite`, "recovery pending"].filter(Boolean).join(" · ");
  }

  if (/\bappointment\b/i.test(text)) {
    const time = compactAppointmentTime(text);
    return [`${broker} appointment${time ? ` ${time}` : ""}`, "pickup pending"].filter(Boolean).join(" · ");
  }

  if (/\bdetention|driver wait|additional charge\b/i.test(text)) {
    return [detentionText || "detention pending", detentionContext.costPending ? "cost pending" : "", podPending ? "POD pending" : ""].filter(Boolean).join(" · ");
  }

  return "";
}

function buildFactLedger(shipment) {
  const events = [];
  const detentionContext = detentionContextForShipment(shipment);
  const tmsEvidence = shipment.statusAudit?.evidence?.[0];
  pushFactEvent(events, shipment, "tms", "TMS", tmsEvidence?.note || shipment.tms?.tmsStatus || shipment.nextAction, {
    source: "CourierCloud",
    confidence: "high",
    action: "TMS anchors whether this shipment is open.",
  });

  if (shipment.liveTracking?.summary || shipment.liveTracking?.status || shipment.liveTracking?.code) {
    pushFactEvent(
      events,
      shipment,
      "tracking",
      "Tracking",
      unique([shipment.liveTracking?.code, shipment.liveTracking?.summary, shipment.liveTracking?.scheduledArrival].filter(Boolean)).join(" · "),
      {
        source: `${shipment.airline || "Carrier"} tracking`,
        confidence: "high",
        action: shipment.arrivalStatus === "arrived" ? "Treat physical arrival as carrier-backed." : "Keep tracking until arrival/availability is proven.",
      },
    );
  }

  for (const proof of shipment.emailValidation?.proof || []) {
    pushFactEvent(events, shipment, "email", proof.label || "Gmail", proof.note || proof.summary, {
      source: evidenceSourceText(proof) || "Gmail",
      confidence: shipment.emailValidation?.status === "email-conflict" ? "low" : "high",
      threadId: proof.threadId || "",
      messageId: proof.messageId || "",
      action: shipment.emailValidation?.nextAction || "",
    });
  }
  if (!shipment.emailValidation?.proof?.length && shipment.emailValidation?.summary) {
    pushFactEvent(events, shipment, "email", "Gmail", shipment.emailValidation.summary, {
      source: "Gmail proof snapshot",
      confidence: shipment.emailValidation?.status === "email-missing" ? "low" : "medium",
      action: shipment.emailValidation?.nextAction || "",
    });
  }

  const customs = shipment.customsBroker || {};
  for (const item of customs.evidence || []) {
    const note = typeof item === "string" ? item : item.note || item.summary;
    pushFactEvent(events, shipment, "customs", customs.broker || "Customs", note, {
      source: typeof item === "object" ? evidenceSourceText(item) || "Gmail customs thread" : "Gmail customs evidence",
      confidence: customs.confidence || "medium",
      threadId: item?.threadId || "",
      messageId: item?.messageId || "",
      action: customs.nextAction || "",
    });
  }

  const freight = shipment.freightBroker || {};
  for (const item of freight.evidence || []) {
    const note = typeof item === "string" ? item : item.note || item.summary;
    pushFactEvent(events, shipment, "broker", item.label || freight.broker || "Pickup", note, {
      source: typeof item === "object" ? evidenceSourceText(item) || "Gmail broker thread" : "Gmail broker evidence",
      confidence: freight.confidence || "medium",
      threadId: item?.threadId || "",
      messageId: item?.messageId || "",
      action: freight.nextAction || "",
    });
  }

  for (const quote of freight.quotes || []) {
    if (!Number.isFinite(Number(quote.amount))) continue;
    pushFactEvent(events, shipment, "quote", quote.broker || "Quote", `${quote.rate || quote.amount} · ${quote.service || "pickup/delivery quote"}`, {
      source: unique([quote.source, ...(Array.isArray(quote.evidence) ? quote.evidence.map(evidenceSourceText) : [])]).join(" · "),
      confidence: contactEmailList(quote.contactEmail).length ? "high" : "medium",
      at: quote.quotedAt || "",
      action: quote.category === "pickup-delivery" ? "Compare quote before awarding broker." : "Do not treat non-delivery cost as pickup quote.",
    });
  }

  for (const fact of shipment.eodFacts || []) {
    const type = operationalFactType(fact);
    const summary = fact.summary || fact.detail;
    pushFactEvent(events, shipment, type, operationalFactLabel(fact, type), summary, {
      source: evidenceSourceText(fact) || fact.source || "Gmail operational fact",
      confidence: "high",
      at: operationalFactTime(fact),
      threadId: fact.threadId || fact.evidence?.threadId || "",
      messageId: fact.messageId || fact.evidence?.messageId || "",
      action: fact.nextAction || fact.action || "",
      operatorSummary: compactOperationalFactSummary(shipment, fact, summary, detentionContext),
    });
  }

  const storage = shipment.operationalMemory?.storage || shipment.stationContext?.storage;
  const hasKnownStorage = storage?.status === "known";
  if (hasKnownStorage) {
    const storageSummary = unique([
      storage.lastFreeDay ? `last free day ${storage.lastFreeDay}` : "",
      storage.storageStartsAt ? `storage starts ${storage.storageStartsAt}` : "",
      storage.storageAccruingSince ? `storage accruing since ${storage.storageAccruingSince}` : "",
      storage.dailyStorageRate ? `rate ${storage.dailyStorageRate}` : "",
    ]).join("; ");
    pushFactEvent(events, shipment, "storage", "Storage", storageSummary, {
      source: (storage.evidence || [])[0] || "Gmail/station memory",
      confidence: "high",
      at: storage.updatedAt || "",
      action: "Plan pickup before storage starts or account for charges.",
    });
  }

  for (const station of shipment.stationContext?.stations || []) {
    for (const fact of station.facts || []) {
      if (isStorageMemoryFact(fact)) {
        if (hasKnownStorage || !storageFactAppliesToShipment(fact, shipment)) continue;
      }
      pushFactEvent(events, shipment, fact.type || "station", station.stationName || "Station memory", fact.summary, {
        source: fact.source?.note || station.contactSource || "Station memory",
        confidence: fact.confidence || station.confidence || "medium",
        at: fact.lastSeenAt || fact.firstSeenAt || "",
        action: fact.action || "",
      });
    }
  }

  const pod = shipment.operationalMemory?.pod;
  if (pod?.status === "pod-found") {
    pushFactEvent(events, shipment, "pod", "POD", unique([pod.receiver ? `signed by ${pod.receiver}` : "", ...(pod.evidence || [])]).join(" · "), {
      source: "Gmail/TMS POD evidence",
      confidence: "high",
      at: pod.updatedAt || "",
      action: "Ready for closeout review when the operator is ready to close the shipment.",
    });
  }

  const isInternalTmsReviewEvent = (event) =>
    event.type === "tms-closeout-experience" ||
    /TMS review inbox|TMS experience inbox/i.test(`${event.targetName || ""} ${event.summary || ""}`) ||
    /TMS (?:POD check|closeout review)|POD check/i.test(`${event.subject || ""} ${event.label || ""}`);

  for (const event of shipment.actionHistory || []) {
    if (!["gmail-human", "outbox"].includes(event.source)) continue;
    if (event.source === "outbox") continue;
    if (isInternalTmsReviewEvent(event)) continue;
    pushFactEvent(events, shipment, "action", event.label || event.type, event.summary || event.reason, {
      source: event.source === "gmail-human" ? "Human Gmail activity" : "Dashboard outbox",
      confidence: "high",
      at: event.at || "",
      action: event.type === "quote-request" ? "Do not duplicate; follow up if no broker replied." : "",
    });
  }

  const byKey = new Map();
  for (const event of events) {
    const key = `${event.type}:${event.label}:${event.summary}`;
    if (!byKey.has(key)) byKey.set(key, event);
  }
  return [...byKey.values()]
    .sort((a, b) => actionEventTime(b) - actionEventTime(a))
    .slice(0, 16);
}

async function runOpsSync({ rootDir, onProgress = () => {} }) {
  const startedAt = new Date();
  const shipmentGroupsPath = path.join(rootDir, "shipment-groups.json");
  const shipmentTruthPacketsPath = path.join(rootDir, "shipment-truth-packets.json");
  const actionQueuePath = path.join(rootDir, "action-queue.json");
  const outboxRequestsPath = path.join(rootDir, "outbox-requests.json");
  const opsBrainMemoryPath = path.join(rootDir, "ops-brain-memory.json");
  const completedShipmentsPath = path.join(rootDir, "completed-shipments.jsonl");
  const tmsPath = path.join(rootDir, "tms-detail-snapshot.json");
  const metadataPath = path.join(rootDir, "shipment-metadata-snapshot.json");
  const gmailProofPath = path.join(rootDir, "gmail-proof-snapshot.json");
  const brokerDispatchPath = path.join(rootDir, "broker-dispatch-snapshot.json");
  const customsBrokerPath = path.join(rootDir, "customs-broker-snapshot.json");
  const shipmentStatePath = path.join(rootDir, "shipment-state.json");
  const shipmentEventsPath = path.join(rootDir, "shipment-events.json");
  const operatorNotificationsPath = path.join(rootDir, "operator-notifications.json");
  const companionMemoryPath = path.join(rootDir, "companion-memory.json");
  const truthAuditPath = path.join(rootDir, "data", "shipment-truth-audit.json");
  const manualHistoricalReplayPath = path.join(rootDir, "data", "manual-gmail-truth", "historical-replay-awbs.json");
  const manualCurrentTruthPath = path.join(rootDir, "data", "manual-gmail-truth", "current-awbs.json");
  const eodFactsPath = path.join(rootDir, "eod-report-facts.json");
  const stationContextPath = path.join(rootDir, "station-context.json");
  const stationMemoryPath = path.join(rootDir, "station-memory.json");
  const moneyMemoryPath = path.join(rootDir, "money-memory.json");
  const stationMemoryGapsPath = path.join(rootDir, "station-memory-gaps.json");
  const tmsMoneyGapsPath = path.join(rootDir, "tms-money-gaps.json");
  const excludedShipmentsPath = path.join(rootDir, "excluded-shipments.json");
  const unitedTrackingPath = path.join(rootDir, "united-tracking-snapshot.json");
  const otherTrackingPath = path.join(rootDir, "other-tracking-snapshot.json");
  const elalTrackingPath = path.join(rootDir, "elal-tracking-snapshot.json");

  onProgress({ step: "tms", label: STEP_LABELS.tms, completed: 0, total: 7 });
  const [
    tmsData,
    metadataData,
    gmailProofData,
    previousTruthPacketsData,
    brokerDispatchData,
    customsBrokerData,
    shipmentStateData,
    shipmentEventsData,
    operatorNotificationsData,
    companionMemoryData,
    truthAuditData,
    manualHistoricalReplayData,
    manualCurrentTruthData,
    eodFactsData,
    stationContextData,
    stationMemoryData,
    moneyMemoryData,
    unitedTrackingData,
    otherTrackingData,
    elalTrackingData,
    completedRecords,
    previousActionQueue,
    outboxRequestsData,
    excludedShipmentsData,
  ] = await Promise.all([
    readJson(tmsPath, { shipments: [] }),
    readJson(metadataPath, { shipments: [] }),
    readJson(gmailProofPath, { proofs: [] }),
    readJson(shipmentTruthPacketsPath, { shipments: [] }),
    readJson(brokerDispatchPath, { dispatches: [] }),
    readJson(customsBrokerPath, { brokers: [] }),
    readJson(shipmentStatePath, { shipments: [] }),
    readJson(shipmentEventsPath, { events: [] }),
    readJson(operatorNotificationsPath, { notifications: [] }),
    readJson(companionMemoryPath, { operatorNotes: [] }),
    readJson(truthAuditPath, { shipments: [] }),
    readJson(manualHistoricalReplayPath, { shipments: [] }),
    readJson(manualCurrentTruthPath, { shipments: [] }),
    readJson(eodFactsPath, { facts: [] }),
    readJson(stationContextPath, { stations: [] }),
    readJson(stationMemoryPath, { contacts: [] }),
    readJson(moneyMemoryPath, { records: [] }),
    readJson(unitedTrackingPath, { tracking: [] }),
    readJson(otherTrackingPath, { tracking: [] }),
    readJson(elalTrackingPath, { tracking: [] }),
    readJsonLines(completedShipmentsPath),
    readJson(actionQueuePath, { actions: [] }),
    readJson(outboxRequestsPath, { requests: [] }),
    readJson(excludedShipmentsPath, { awbs: [] }),
  ]);
  const excludedAwbs = new Set(
    (excludedShipmentsData.awbs || [])
      .map((awb) => normalizeAwb(awb) || String(awb || "").trim())
      .filter(Boolean),
  );

  const metadataByAwb = byAwb(metadataData.shipments || []);
  for (const previous of previousTruthPacketsData.shipments || []) {
    const key = normalizeAwb(previous.awb || previous.id);
    if (!key) continue;
    const existing = metadataByAwb.get(key) || metadataByAwb.get(previous.awb) || {};
    metadataByAwb.set(key, {
      awb: previous.awb || key,
      id: existing.id || previous.id || previous.tms?.order || "",
      client: existing.client || previous.client || "",
      station: existing.station || previous.station || "",
      origin: existing.origin || previous.origin || previous.tms?.origin || "",
      destination: existing.destination || previous.destination || previous.tms?.destination || "",
      pieces: existing.pieces || previous.cargo?.pieces || previous.tms?.pieces || "",
      weight: existing.weight || previous.cargo?.weight || previous.tms?.weight || "",
      weightUom: existing.weightUom || previous.cargo?.weightUom || previous.tms?.weightUom || "",
      ...existing,
      previousTruthPacket: previous,
    });
  }
  const combinedGmailProofData = {
    ...gmailProofData,
    proofs: [
      ...(gmailProofData.proofs || []),
      ...manualHistoricalProofRows(manualHistoricalReplayData),
      ...manualCurrentCompletionProofRows(manualCurrentTruthData),
    ],
  };
  const gmailCoverageRowsByAwb = gmailCoverageByAwb(combinedGmailProofData.gmailCoverageAudit || combinedGmailProofData.coverage || {});
  const gmailProofByAwb = gmailProofMapByAwb(combinedGmailProofData.proofs || []);
  const dispatchByAwb = byAwb(brokerDispatchData.dispatches || []);
  const factsByAwb = recordsByAwb(eodFactsData.facts || []);
  const moneyMemoryByNormalizedAwb = moneyMemoryByAwb(moneyMemoryData);
  const customsBrokerByAwb = new Map();
  for (const broker of customsBrokerData.brokers || []) {
    putAwb(customsBrokerByAwb, broker.awb, broker);
  }
  const trackingByAwb = buildTrackingByAwb(
    unitedTrackingData,
    otherTrackingData,
    elalTrackingData,
  );

  onProgress({ step: "tracking", label: STEP_LABELS.tracking, completed: 1, total: 7 });
  const sourceShipments = (tmsData.shipments || []).filter((tmsShipment) => {
    const awb = tmsShipment.trackingNumber || `Missing AWB - order ${tmsShipment.order || tmsShipment.shipmentNumber || "unknown"}`;
    const key = normalizeAwb(awb) || awb;
    if (excludedAwbs.has(key)) return false;
    return true;
  });
  const sourceBundle = canonicalSourceBundle({
    tmsData,
    sourceShipments,
    gmailProofData,
    previousTruthPacketsData,
  });
  assertCanonicalSourceBundleCoherent(sourceBundle);
  const sourceAwbKeys = new Set(sourceShipments.map((shipment) => normalizeAwb(shipment.trackingNumber) || shipment.trackingNumber).filter(Boolean));
  const gmailOpenWorkRows = gmailOpenWorkTmsRows({
    gmailProofData: combinedGmailProofData,
    metadataByAwb,
    excludedAwbs,
    sourceKeys: sourceAwbKeys,
    completedRecords,
  });
  const sourceRows = [...sourceShipments, ...gmailOpenWorkRows];
  const snapshotTime = new Date().toISOString();
  const baseShipments = sourceRows.map((tmsShipment) => {
    const awb = tmsShipment.trackingNumber || `Missing AWB - order ${tmsShipment.order || tmsShipment.shipmentNumber || "unknown"}`;
    const metadata = metadataByAwb.get(awb) || metadataByAwb.get(normalizeAwb(awb)) || {};
    const gmailProof = gmailProofByAwb.get(awb) || gmailProofByAwb.get(normalizeAwb(awb)) || {};
    const eodFacts = factsByAwb.get(awb) || factsByAwb.get(normalizeAwb(awb)) || [];
    const baseShipment = buildBaseShipment(tmsShipment, metadata, gmailProof, tmsData.snapshotTime || snapshotTime);
    const trackingRecord = trackingByAwb.get(awb) || trackingByAwb.get(normalizeAwb(awb));
    const trackedShipment = applyTrackingOverlay(baseShipment, trackingRecord);
    let freightBroker = inferFreightBrokerLayer(
      trackedShipment,
      dispatchByAwb.get(awb) || dispatchByAwb.get(normalizeAwb(awb)),
    );
    const customsBroker = inferCustomsBrokerLayer(
      trackedShipment,
      customsBrokerByAwb.get(awb) || customsBrokerByAwb.get(normalizeAwb(awb)),
    );
    const operationalException = operationalExceptionForShipment({
      ...trackedShipment,
      eodFacts,
      freightBroker,
      customsBroker,
    });
    freightBroker = invalidatePickupQuotesForException(freightBroker, operationalException);
    const freightText = dispatchEvidenceText({ ...trackedShipment, freightBroker });
    const airportPickupConfirmed = isFreightAirportPickedUpStatus(freightBroker.status) ||
      hasFreightAirportPickupProofText(freightText);
    const layeredShipment = {
      ...trackedShipment,
      operationalException,
      eodFacts,
      pickupStatus: airportPickupConfirmed
        ? "airport-picked-up"
        : isFreightDeliveredStatus(freightBroker.status)
        ? "delivered"
        : trackedShipment.pickupStatus,
      freightBroker,
      customsBroker,
    };
    layeredShipment.nextAction = layeredNextAction(layeredShipment, freightBroker, customsBroker);
    const emailLayeredShipment = applyStationMemory(
      applyEmailMovementOverlay(layeredShipment),
      stationMemoryData,
    );
    const stationContext = mergeStationContexts(
      emailLayeredShipment.stationContext,
      stationContextForShipment(emailLayeredShipment, stationContextData),
    );
    const emailWindow = buildEmailSearchWindow(tmsShipment);
    const emailTerms = buildGmailQueryTerms(tmsShipment, emailLayeredShipment);

    const stationContactedShipment = recoverCustomsBrokerIdentity(normalizeCompletedCustomsLayer(
      applyStationContextContact(emailLayeredShipment, stationContext),
    ));
    const shipmentWithSyncPlan = sanitizeResolvedCustomsContext({
      ...stationContactedShipment,
      syncPlan: {
        tms: {
          source: tmsShipment.tmsStatus === "EMAIL-OPEN" ? "Gmail-open carry-forward" : "CourierCloud",
          role: tmsShipment.tmsStatus === "EMAIL-OPEN"
            ? "Unresolved Gmail proof retained because current TMS snapshot omitted the AWB"
            : "Open shipment inventory and base shipment details",
          shipmentGuid: tmsShipment.shipmentGuid || null,
          tmsStatus: tmsShipment.tmsStatus || tmsShipment.status || null,
        },
        tracking: {
          source: layeredShipment.airline || "Carrier site",
          role: "Physical movement, arrival, delivery, customs movement",
          awb,
        },
        gmail: {
          source: "Configured Gmail mailbox",
          role: "Final operational proof layer",
          window: emailWindow,
          queryTerms: emailTerms,
        },
      },
      stationContext: stationContactedShipment.stationContext,
    });

    const memoryShipment = sanitizeResolvedCustomsContext(applyMoneyMemory(
      applyOperationalMemory(applyBrokerContactMemory(shipmentWithSyncPlan, companionMemoryData)),
      moneyMemoryByNormalizedAwb.get(normalizeAwb(awb)),
    ));
    const finalizedShipment = sanitizeCompletedPodContext(sanitizeResolvedCustomsContext(finalizeShipment(memoryShipment)));
    const understoodShipment = sanitizeResolvedCustomsContext(applyOperationalUnderstanding(finalizedShipment));
    return normalizeShipmentTimeline(understoodShipment);
  });
  const canonicalMemory = {
    active: {
      snapshotTime,
      shipments: baseShipments,
    },
    gmailProof: combinedGmailProofData,
    shipmentState: shipmentStateData,
    shipmentEvents: shipmentEventsData,
    operatorNotifications: operatorNotificationsData,
    companionMemory: companionMemoryData,
    truthAudit: truthAuditData,
    stationMemory: stationMemoryData,
    carrierTracking: carrierTrackingIndex([unitedTrackingData, otherTrackingData, elalTrackingData]),
  };
  const canonicalRecords = buildCanonicalShipments(canonicalMemory);
  const canonicalByAwb = canonicalRecordsByAwb(canonicalRecords);
  const shipments = baseShipments.map((shipment) => {
    const canonicalRecord = canonicalByAwb.get(shipment.awb) || canonicalByAwb.get(normalizeAwb(shipment.awb));
    return sanitizeResolvedCustomsContext(applyCanonicalControlState(shipment, canonicalRecord));
  }).map((shipment) => sanitizeResolvedCustomsOperatorEvidence(sanitizeResolvedCustomsContext(shipment)));

  onProgress({ step: "gmail", label: STEP_LABELS.gmail, completed: 2, total: 7 });
  onProgress({ step: "freight", label: STEP_LABELS.freight, completed: 3, total: 7 });
  onProgress({ step: "customs", label: STEP_LABELS.customs, completed: 4, total: 7 });
  const nextStationContextData = mergeStationContextRecords(stationContextData, shipments, snapshotTime);
  const detachedCompletions = detachedCompletionRecords({
    existing: completedRecords,
    shipments,
    metadataByAwb,
    gmailProofByAwb,
    dispatchByAwb,
    customsBrokerByAwb,
    snapshotTime,
  });
  const nextCompletedRecords = mergeCompletedRecords(
    completedRecords.concat(detachedCompletions),
    shipments,
    snapshotTime,
    gmailProofByAwb,
  );
  const completedKeys = new Set(nextCompletedRecords.map((record) => normalizeAwb(record.awb) || record.awb));
  const activeShipmentsWithoutActions = shipments.filter((shipment) => {
    const key = normalizeAwb(shipment.awb) || shipment.awb;
    return !completedKeys.has(key) && !shipment.completed && !canonicalPodComplete(shipment);
  });
  const activeAwbKeys = new Set(activeShipmentsWithoutActions.map((shipment) => normalizeAwb(shipment.awb) || shipment.awb).filter(Boolean));
  const completedAwbKeys = new Set(nextCompletedRecords.map((record) => normalizeAwb(record.awb) || record.awb).filter(Boolean));
  const activeTruthPacketShipments = attachOperatorPackets(
    canonicalRecords
      .filter((record) => activeAwbKeys.has(normalizeAwb(record.awb) || record.awb))
      .map((record) => canonicalShipmentAsCompanionShipment(record)),
    canonicalMemory,
  ).map((shipment) => {
    const awbKey = normalizeAwb(shipment.awb) || shipment.awb;
    const withRole = {
      ...shipment,
      canonicalAuthority: true,
      _truthPacketSource: "shipment-truth-packets",
      _truthPacketSnapshotTime: snapshotTime,
      truthPacketRole: activeAwbKeys.has(awbKey)
        ? "active"
        : completedAwbKeys.has(awbKey) || shipment.completed
          ? "completed"
          : "evidence-only",
      recommendedActions: [],
      actionHistory: [],
    };
    return attachGmailCoverageToTruthPacketShipment(withRole, gmailCoverageRowsByAwb.get(awbKey));
  });
  const previousCompletedPacketByAwb = byAwb(
    (previousTruthPacketsData.shipments || [])
      .filter((shipment) => String(shipment.truthPacketRole || "").toLowerCase() === "completed"),
  );
  const completedTruthPacketShipments = nextCompletedRecords
    .filter((record) => {
      const awbKey = normalizeAwb(record.awb) || record.awb;
      return awbKey && completedAwbKeys.has(awbKey) && !activeAwbKeys.has(awbKey);
    })
    .map((record) => {
      const awbKey = normalizeAwb(record.awb) || record.awb;
      const previousPacket = previousCompletedPacketByAwb.get(record.awb) || previousCompletedPacketByAwb.get(awbKey) || {};
      const completedPacket = completedRecordAsTruthPacket(record, snapshotTime);
      return {
        ...completedPacket,
        evidencePacket: completedPacket.evidencePacket || previousPacket.evidencePacket || null,
      };
    });
  const truthPacketShipments = uniqueByKey(
    [...activeTruthPacketShipments, ...completedTruthPacketShipments],
    (shipment) => normalizeAwb(shipment.awb) || shipment.awb || shipment.id,
  ).sort((a, b) => String(a.awb || a.id || "").localeCompare(String(b.awb || b.id || "")));
  const truthPacketsOutput = {
    snapshotTime,
    sourceOfTruth:
      "Canonical shipment truth packets are the only operational state authority. TMS, tracking, Gmail, operator notes, phone truth, and action history are inputs or evidence; active-shipments and dashboard-data are retired failure artifacts, not live truth inputs. UI, companion, reports, and actions must not re-reduce shipment state from any non-packet source.",
    writerVersion: "shipment-truth-packets-v1",
    counts: {
      shipments: truthPacketShipments.length,
      activeShipments: truthPacketShipments.filter((shipment) => shipment.truthPacketRole === "active").length,
      completedShipments: truthPacketShipments.filter((shipment) => shipment.truthPacketRole === "completed").length,
      evidenceOnlyShipments: truthPacketShipments.filter((shipment) => shipment.truthPacketRole === "evidence-only").length,
      stationMemoryMatches: truthPacketShipments.filter((shipment) => hasReusableStationMemory(shipment)).length,
    },
    activeAwbs: [...activeAwbKeys].sort(),
    completedAwbs: [...completedAwbKeys].sort(),
    sourceAudit: {
      tmsSnapshotTime: sourceBundle.sources.tms.snapshotTime || "",
      tmsActiveAwbs: sourceBundle.sources.tms.activeAwbs || [...sourceAwbKeys].sort(),
      gmailProofSnapshotTime: sourceBundle.sources.gmailProof.snapshotTime || "",
      gmailProofCount: sourceBundle.sources.gmailProof.proofCount || 0,
      previousTruthSnapshotTime: sourceBundle.sources.previousTruth.snapshotTime || "",
      previousTruthWriter: sourceBundle.sources.previousTruth.writerVersion || "",
      sourceBundle,
    },
    shipments: truthPacketShipments,
  };
  const truthPacketByAwb = byAwb(truthPacketShipments);
  const attachTruthPacketReference = (shipment) => {
    const packet = truthPacketByAwb.get(shipment.awb) || truthPacketByAwb.get(normalizeAwb(shipment.awb));
    if (!packet) return shipment;
    return {
      ...shipment,
      canonicalAuthority: true,
      _truthPacketSource: packet._truthPacketSource,
      _truthPacketSnapshotTime: packet._truthPacketSnapshotTime,
      truthPacketRole: packet.truthPacketRole,
      truthPacket: packet.truthPacket,
      evidencePacket: packet.evidencePacket,
      freightBroker: packet.freightBroker || shipment.freightBroker,
      customsBroker: packet.customsBroker || shipment.customsBroker,
      contacts: packet.contacts || shipment.contacts,
      pickupStatus: packet.pickupStatus || shipment.pickupStatus,
      arrivalStatus: packet.arrivalStatus || shipment.arrivalStatus,
      clearanceStatus: packet.clearanceStatus || shipment.clearanceStatus,
      gmailCoverage: packet.gmailCoverage || shipment.gmailCoverage,
      sourceTruthWarnings: packet.sourceTruthWarnings || shipment.sourceTruthWarnings,
    };
  };
  const actionSourceShipments = uniqueByKey(
    activeShipmentsWithoutActions.map(attachTruthPacketReference),
    (shipment) => shipment.id || normalizeAwb(shipment.awb) || shipment.awb,
  );
  const actionQueue = mergeActionQueue(
    previousActionQueue.actions || [],
    actionSourceShipments,
    snapshotTime,
    outboxRequestsData.requests || [],
  );
  const actionsByShipmentId = actionQueue.reduce((acc, action) => {
    if (!acc.has(action.shipmentId)) acc.set(action.shipmentId, []);
    acc.get(action.shipmentId).push(action);
    return acc;
  }, new Map());
  const activeShipments = activeShipmentsWithoutActions.map(attachTruthPacketReference).map((shipment) => {
    const shipmentWithActions = {
      ...shipment,
      recommendedActions: actionsByShipmentId.get(shipment.id) || [],
      actionHistory: actionHistoryForShipment(
        shipment,
        actionQueue,
        outboxRequestsData.requests || [],
      ),
    };
    shipmentWithActions.primaryAction = attachPrimaryPlatformActions([shipmentWithActions], { gmailProofByAwb })[0]?.primaryAction || null;
    return {
      ...shipmentWithActions,
      factLedger: buildFactLedger(shipmentWithActions),
    };
  });
  const activeActionProjectionByAwb = byAwb(activeShipments);
  truthPacketsOutput.shipments = (truthPacketsOutput.shipments || []).map((shipment) => {
    if (String(shipment.truthPacketRole || "active").toLowerCase() !== "active") return shipment;
    const projected =
      activeActionProjectionByAwb.get(shipment.awb) ||
      activeActionProjectionByAwb.get(normalizeAwb(shipment.awb)) ||
      activeActionProjectionByAwb.get(shipment.id);
    if (!projected) return shipment;
    return {
      ...shipment,
      recommendedActions: [],
      actionHistory: projected.actionHistory || [],
      primaryAction: projected.primaryAction || null,
      factLedger: projected.factLedger || shipment.factLedger || null,
    };
  });
  const shipmentGroups = buildShipmentGroups(overlayCanonicalTruthForGrouping(activeShipments, rootDir));
  const operationalGaps = buildOperationalGaps(activeShipments, actionQueue);
  const operationalGapReports = buildOperationalGapReports(operationalGaps, snapshotTime);
  const opsBrainMemory = buildOpsBrainMemory({
    activeShipments: [],
    completedShipments: nextCompletedRecords,
    gmailProofData: combinedGmailProofData,
    actionQueue,
    snapshotTime,
  });
  const counts = shipments.reduce(
    (acc, shipment) => {
      const emailStatus = shipment.emailValidation?.status || "email-missing";
      const key = emailCountKey(emailStatus);
      acc[key] = (acc[key] || 0) + 1;
      if (!hasUsefulOperationalEmailProof(shipment)) acc.emailGaps += 1;
      if (shipment.layerStatus?.needsHumanReview) acc.needsHumanReview += 1;
    if (isFreightAssigned(shipment.freightBroker?.status)) acc.freightAwarded += 1;
    if (shipment.freightBroker?.status === "freight-requested") acc.freightRequested += 1;
    if (shipment.freightBroker?.status === "freight-missing") acc.freightMissing += 1;
      if (isCustomsResolvedStatus(shipment.customsBroker?.status)) acc.customsCleared += 1;
      if (isCustomsHoldStatus(shipment.customsBroker?.status)) acc.customsHold += 1;
      if (shipment.customsBroker?.status === "customs-pending") acc.customsPending += 1;
      if (shipment.customsBroker?.status === "customs-unknown") acc.customsUnknown += 1;
      if (shipment.customsBroker?.broker && shipment.customsBroker.broker !== "Not found") {
        acc.customsBrokerKnown += 1;
      } else {
        acc.customsBrokerMissing += 1;
      }
      if (hasReusableStationMemory(shipment)) {
        acc.stationMemoryMatches += 1;
      }
      return acc;
    },
    {
      emailConfirmed: 0,
      emailPending: 0,
      emailConflict: 0,
      emailMissing: 0,
      emailGaps: 0,
      needsHumanReview: 0,
      freightAwarded: 0,
      freightRequested: 0,
      freightMissing: 0,
      customsCleared: 0,
      customsHold: 0,
      customsPending: 0,
      customsUnknown: 0,
      customsBrokerKnown: 0,
      customsBrokerMissing: 0,
      stationMemoryMatches: 0,
    },
  );
  counts.activeShipments = activeShipments.length;
  counts.completedShipments = nextCompletedRecords.length;
  counts.deliveryGroups = shipmentGroups.length;
  counts.dispatchableGroups = shipmentGroups.filter((group) => group.canDispatch).length;
  counts.actionDrafts = actionQueue.length;
  counts.highPriorityActions = actionQueue.filter((action) => action.priority === "high").length;
  counts.missingActionRecipients = actionQueue.filter((action) =>
    action.missing?.length &&
      !["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase())
  ).length;
  Object.assign(counts, actionAutonomyCounts(actionQueue));
  counts.storageMemoryKnown = shipments.filter((shipment) => shipment.operationalMemory?.storage?.status === "known").length;
  counts.podProofFound = shipments.filter((shipment) => shipment.operationalMemory?.pod?.status === "pod-found").length;
  counts.moneyContextKnown = shipments.filter((shipment) =>
    shipment.operationalMemory?.money?.stationPayments?.length ||
      shipment.operationalMemory?.money?.customerCharge ||
      shipment.operationalMemory?.money?.vendorCost ||
      shipment.operationalMemory?.money?.freightQuoteOrAward
  ).length;

  onProgress({ step: "actions", label: STEP_LABELS.actions, completed: 5, total: 7 });
  onProgress({ step: "write", label: STEP_LABELS.write, completed: 6, total: 7 });
  const finishedAt = new Date().toISOString();
  const groupsOutput = {
    snapshotTime,
    sourceOfTruth:
      "Groups are built from active shipments by station plus consignee and delivery address.",
    groups: shipmentGroups,
  };
  const actionQueueOutput = {
    snapshotTime,
    sourceOfTruth:
      "Gmail actions create drafts. Operator-approved CourierCloud actions queue TMS jobs only after a dashboard click.",
    counts: {
      actions: actionQueue.length,
      highPriority: actionQueue.filter((action) => action.priority === "high").length,
      missingRecipients: actionQueue.filter((action) =>
        action.missing?.length &&
          !["platform", "companion", "ops-brain"].includes(String(action.channel || "").toLowerCase())
      ).length,
      ...actionAutonomyCounts(actionQueue),
      stationConfirmations: actionQueue.filter((action) => action.type === "station-confirmation").length,
      quoteRequests: actionQueue.filter((action) => action.type === "quote-request").length,
      brokerAwards: actionQueue.filter((action) => action.type === "broker-award").length,
      customsFollowups: actionQueue.filter((action) => action.type === "customs-followup").length,
    },
    actions: actionQueue,
  };

  // Source-of-truth collision guard: this should already be caught by the source-bundle
  // assertion before reduction. Keep the local invariant here too so a future call path
  // cannot silently skip the canonical packet write and continue as if truth refreshed.
  const previousTruthWriter = String(previousTruthPacketsData?.writerVersion || "");
  const previousTruthAt = Date.parse(previousTruthPacketsData?.snapshotTime || "") || 0;
  const proofInputAt = Date.parse(gmailProofData?.snapshotTime || "") || 0;
  const opsSyncTruthWriteBlocked =
    /\+(?:manual-current-gmail-truth|gmail-direct)/.test(previousTruthWriter) &&
    previousTruthAt > proofInputAt;
  if (opsSyncTruthWriteBlocked) {
    const error = new Error(canonicalSourceBundleBlockerMessage(sourceBundle));
    error.code = "CANONICAL_SOURCE_BUNDLE_BLOCKED";
    error.bundle = sourceBundle;
    throw error;
  }
  await Promise.all([
    writeJson(shipmentGroupsPath, groupsOutput),
    writeJson(shipmentTruthPacketsPath, truthPacketsOutput),
    writeJson(actionQueuePath, actionQueueOutput),
    writeJson(opsBrainMemoryPath, opsBrainMemory),
    writeJson(stationMemoryGapsPath, operationalGapReports.stationMemory),
    writeJson(tmsMoneyGapsPath, operationalGapReports.tmsMoney),
    writeJson(stationContextPath, nextStationContextData),
    writeJsonLines(completedShipmentsPath, nextCompletedRecords),
  ]);
  onProgress({ step: "done", label: "Refresh complete", completed: 7, total: 7 });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt,
    shipmentCount: shipments.length,
    activeShipmentCount: activeShipments.length,
    completedShipmentCount: nextCompletedRecords.length,
    deliveryGroupCount: shipmentGroups.length,
    actionCount: actionQueue.length,
    emailLookbackDays: EMAIL_LOOKBACK_DAYS,
    counts: {
      tmsOpenShipments: sourceShipments.length || shipments.length,
      gmailOpenCarryForward: gmailOpenWorkRows.length,
      movementLookups: trackingByAwb.size,
      carrierTrackingLookups: trackingByAwb.size,
      gmailEnriched: (gmailProofData.proofs || []).filter((proof) => proof.emailValidation?.status !== "email-missing").length,
      lowConfidence: shipments.filter((shipment) => shipment.statusAudit?.confidence === "low").length,
      mediumConfidence: shipments.filter((shipment) => shipment.statusAudit?.confidence === "medium").length,
      highConfidence: shipments.filter((shipment) => shipment.statusAudit?.confidence === "high").length,
      reviewGaps: shipments.filter((shipment) => shipment.attention).length,
      unitedLiveTracked: (unitedTrackingData.tracking || unitedTrackingData.results || []).length,
      ...counts,
      stationMemoryGaps: operationalGaps.stationMemory.length,
      tmsMoneyGaps: operationalGaps.tmsMoney.length,
    },
  };
}

module.exports = {
  EMAIL_LOOKBACK_DAYS,
  STEP_LABELS,
  runOpsSync,
  _test: {
    canonicalSourceBundle,
    assertCanonicalSourceBundleCoherent,
    gmailCoverageByAwb,
    attachGmailCoverageToTruthPacketShipment,
  },
};

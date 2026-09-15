"use strict";

const { hasExternalSourceCoordinates, sourceFactEligible } = require("./source-fact-contract");

const { normalizeAwb } = require("./awb");
const { operatorNoteShipment } = require("./companion-memory-store");

function compact(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "") || "";
}

function awbMentions(value = "") {
  return [...new Set(
    [...String(value || "").matchAll(/\b\d{3}[-/\s]?\d{8}\b/g)]
      .map((match) => normalizeAwb(match[0]))
      .filter(Boolean)
  )];
}

function cleanTmsValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function tmsRowAwb(row = {}) {
  return normalizeAwb(row.trackingNumber || row.awb || row.id || row.shipmentId || "");
}

function tmsStatusText(row = {}) {
  return [
    row.tmsStatus,
    row.status,
    row.statusDescription,
    row.nextTask,
  ].map(cleanTmsValue).filter(Boolean).join(" ");
}

function tmsStatusCode(row = {}) {
  const match = tmsStatusText(row).match(/\b(\d{3})(?=\s*[-/A-Z@])/i);
  const code = match ? Number(match[1]) : 0;
  return Number.isFinite(code) ? code : 0;
}

function tmsHasDirectCustomsReleaseProof(row = {}) {
  return Boolean(first(
    row.customsActualRelease,
    row.customsReleaseActual,
    row.customsReleaseDate,
    row.actualCustomsReleaseDate,
    row.tms?.customsActualRelease,
    row.tms?.customsReleaseActual,
    row.tms?.customsReleaseDate,
    row.tms?.actualCustomsReleaseDate,
  ));
}

function tmsMovementStatus(row = {}) {
  const text = tmsStatusText(row);
  const code = tmsStatusCode(row);
  if (/\b(?:delivered|pod|complete|closed)\b/i.test(text)) {
    return { arrivalStatus: "arrived", pickupStatus: "picked-up", deliveryStatus: "delivered" };
  }
  if (code >= 320 || /\bout\s*for\s*del|out[-\s]?for[-\s]?delivery|\bofd\b/i.test(text)) {
    return { arrivalStatus: "arrived", pickupStatus: "out-for-delivery", deliveryStatus: "out-for-delivery" };
  }
  if (code >= 295 || /\bcustoms\s*rel|released|ready\s*for\s*pickup\b/i.test(text)) {
    const releaseOrAvailabilityProof =
      tmsHasDirectCustomsReleaseProof(row) ||
      /\b(?:ready\s*for\s*pickup|available|on[-\s]?hand)\b/i.test(text);
    return { arrivalStatus: "arrived", pickupStatus: releaseOrAvailabilityProof ? "ready" : "pending", deliveryStatus: "pending" };
  }
  if (code >= 280 || /\b(?:arr\s*@\s*dest|arrived?\s+at\s+dest|available|on[-\s]?hand)\b/i.test(text)) {
    return { arrivalStatus: "arrived", pickupStatus: "pending", deliveryStatus: "pending" };
  }
  return { arrivalStatus: "not-arrived", pickupStatus: "pending", deliveryStatus: "pending" };
}

function tmsActiveShipmentFromRow(row = {}, snapshotTime = "", source = "tms-detail") {
  const awb = tmsRowAwb(row);
  if (!awb) return null;
  const movement = tmsMovementStatus(row);
  const eta = first(row.nextTask, row.delTime, row.deliveryEstimatedArrivalTime, row.estimatedArrival);
  const tmsStatus = first(row.tmsStatus, row.status);
  const destinationAirport = first(row.deliveryAirport, row.dest, row.destination);
  const originAirport = first(row.pickupAirport, row.orig, row.origin);
  const consignee = first(row.consigneeCompany, row.consigneeName, row.deliveryName);
  const deliveryAddress = [
    row.deliveryAddress1,
    row.deliveryAddress2,
    row.deliveryAddress3,
    row.deliveryCity,
    row.deliveryState,
    row.deliveryZip,
    row.deliveryCountry,
  ].map(cleanTmsValue).filter(Boolean).join(", ");
  const arrivalFact = movement.arrivalStatus === "arrived"
    ? {
        type: "carrier-arrival-confirmed",
        label: "TMS destination arrival confirmed",
        summary: `TMS destination arrival confirmed: ${[tmsStatus, eta].filter(Boolean).join("; ") || "destination arrival"}.`,
        evidence: tmsStatus || eta || "TMS destination arrival status.",
        at: snapshotTime,
        source: source,
        confidence: "medium",
      }
    : null;
  return {
    id: first(row.order, row.shipmentNumber, row.shipmentGuid, awb),
    awb,
    trackingNumber: first(row.trackingNumber, row.awb),
    client: first(row.customerName, row.pickupFrom, row.shipperName),
    consignee,
    destinationName: consignee,
    airport: destinationAirport,
    station: destinationAirport,
    eta,
    etaObservedAt: eta ? snapshotTime : "",
    arrivalStatus: movement.arrivalStatus,
    pickupStatus: movement.pickupStatus,
    deliveryStatus: movement.deliveryStatus,
    clearanceStatus: tmsHasDirectCustomsReleaseProof(row) ? "released" : "",
    currentState: movement.arrivalStatus === "arrived"
      ? "Arrived at destination; email and station details still need enrichment."
      : "Open TMS shipment; carrier movement needs tracking and email enrichment.",
    nextAction: movement.arrivalStatus === "arrived"
      ? "Confirm station availability, release, fees, dispatch, and recovery from email/source evidence."
      : "Track carrier movement, then enrich release, fees, broker, and handling details from email.",
    updatedAt: snapshotTime,
    source,
    tms: {
      ...row,
      order: first(row.order, row.shipmentNumber),
      status: tmsStatus,
      tmsStatus,
      eta,
      etaObservedAt: eta ? snapshotTime : "",
      nextTask: eta,
      source,
      snapshotTime,
    },
    flightDetails: {
      tmsFlight: [row.dep, row.arr].map(cleanTmsValue).filter(Boolean).join(" "),
      departureLeg: cleanTmsValue(row.dep),
      arrivalLeg: cleanTmsValue(row.arr),
      route: [originAirport, destinationAirport].filter(Boolean).join("-"),
      origin: originAirport,
      destination: destinationAirport,
      etaHint: eta,
      recoveryHint: eta,
      source,
    },
    delivery: {
      consignee,
      contactPhone: first(row.consigneePhone, row.deliveryPhone),
      contactEmail: first(row.consigneeEmail, row.deliveryEmail),
      address1: cleanTmsValue(row.deliveryAddress1),
      address2: cleanTmsValue(row.deliveryAddress2),
      city: cleanTmsValue(row.deliveryCity),
      state: cleanTmsValue(row.deliveryState),
      country: cleanTmsValue(row.deliveryCountry),
      airport: destinationAirport,
      courier: cleanTmsValue(row.deliveryCourier),
      fullAddress: deliveryAddress,
    },
    shipper: {
      name: first(row.shipperName, row.pickupCompany, row.pickupFrom),
      contactName: cleanTmsValue(row.shipperName),
      email: cleanTmsValue(row.shipperEmail),
      phone: cleanTmsValue(row.shipperPhone),
      airport: originAirport,
    },
    commercial: {
      customerCharge: cleanTmsValue(row.customerCharge),
      billingTotal: first(row.billingTotal, row.customerCharge),
      vendorCost: cleanTmsValue(row.vendorCost),
      costTotal: first(row.costTotal, row.vendorCost),
      source,
    },
    cargo: {
      pieces: cleanTmsValue(row.pieces),
      weight: cleanTmsValue(row.weight),
      weightUom: cleanTmsValue(row.weightUom),
      source,
    },
    facts: [arrivalFact].filter(Boolean),
  };
}

function eventTime(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function textIncludesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function evidenceClauses(text) {
  return String(text || "")
    .split(/[\n.;]+|\s+\|\s+|\s+•\s+/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function allShipmentRows(memory = {}) {
  const rows = [];
  const add = (source, shipment) => {
    const awb = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
    if (!awb) return;
    rows.push({ source, awb, shipment });
  };

  array(memory.brain?.shipments).forEach((shipment) => add("brain", shipment));
  array(memory.brain?.completed).forEach((shipment) => add("brain-completed", { ...shipment, completed: true }));
  array(memory.active?.shipments).forEach((shipment) => add("active", shipment));
  const tmsDetailRows = array(memory.tmsDetail?.shipments);
  const tmsGridRows = tmsDetailRows.length ? [] : array(memory.tmsGrid?.rows);
  tmsDetailRows.forEach((shipment) => add("tms-detail", tmsActiveShipmentFromRow(shipment, memory.tmsDetail?.snapshotTime || "", "tms-detail")));
  tmsGridRows.forEach((shipment) => add("tms-grid", tmsActiveShipmentFromRow(shipment, memory.tmsGrid?.snapshotTime || "", "tms-grid")));
  array(memory.gmailProof?.proofs).forEach((shipment) => add("gmail-proof", shipment));
  array(memory.shipmentState?.shipments).forEach((shipment) => add("shipment-state", shipment));
  array(memory.shipmentEvents?.shipments).forEach((shipment) => add("shipment-events", shipment));
  array(memory.shipmentEvents?.events).forEach((event) => add("shipment-events", {
    awb: event.awb,
    facts: [event],
    events: [event],
    updatedAt: event.at || event.updatedAt || "",
  }));
  array(memory.operationalFactLedger?.facts).forEach((fact) => {
    const factType = fact.sourceType === "operator-note"
      ? fact.payload?.originalFactType || fact.type || fact.factType || "operator-note"
      : fact.factType || fact.type || "operational_fact";
    add("operational-fact-ledger", {
      awb: fact.awb,
      facts: [{
        ...fact,
        type: factType,
        label: factType || "Operational fact",
        summary: fact.summary || fact.evidenceText || "",
        evidence: fact.evidenceText || fact.evidence || "",
        at: fact.occurredAt || fact.observedAt || "",
        source: fact.sourceType || "operational-fact-ledger",
        threadId: fact.threadId || "",
        messageId: fact.messageId || "",
        broker: fact.payload?.broker || fact.actorName || "",
        contactEmail: fact.payload?.contactEmail || "",
        amount: fact.payload?.amount || "",
        workgroupId: fact.workgroupId || "",
        confidence: fact.confidenceLabel === "operator-confirmed" ? "operator-confirmed" : fact.confidenceLabel || fact.confidence || "",
      }],
      updatedAt: fact.observedAt || fact.occurredAt || "",
    });
  });
  array(memory.companionMemory?.operatorNotes).forEach((note) => add("operator-note", operatorNoteShipment(note) || note));
  array(memory.truthAudit?.shipments).forEach((shipment) => add("truth-audit", shipment));
  return rows;
}

function groupShipmentRows(memory = {}) {
  const groups = new Map();
  for (const row of allShipmentRows(memory)) {
    const group = groups.get(row.awb) || { awb: row.awb, rows: [], bySource: new Map() };
    group.rows.push(row);
    const list = group.bySource.get(row.source) || [];
    list.push(row.shipment);
    group.bySource.set(row.source, list);
    groups.set(row.awb, group);
  }
  return groups;
}

function firstFrom(group, source) {
  return group.bySource.get(source)?.[0] || null;
}

function latestFrom(group, source) {
  return [...(group.bySource.get(source) || [])].sort((a, b) => eventTime(b.updatedAt || b.at || b.latestEventAt) - eventTime(a.updatedAt || a.at || a.latestEventAt))[0] || null;
}

function firstTmsFrom(group) {
  return firstFrom(group, "tms-detail") || firstFrom(group, "tms-grid") || null;
}

const SHIPMENT_GATE_NAMES = ["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"];
const PICKUP_BROKER_PATTERN =
  /\b(?:jd direct|j&d|meadow freight|btx|birch cartage|rapid|meadow logistics|binational|cedar brokerage|port air|sd direct|atlantic freight|maple|chart|casey|mw transport|kuehne|choice)\b/i;
const AIR_BOOKING_PATTERN = /\b(?:air booking|air export|export booking|air[-\s]?freight|harbor forwarding|global forwarding|agent dhl| dap | tlv | ath |\/kg|per kg|iata|fuel surcharge)\b/i;
const OPERATOR_TIME_ZONE = "America/New_York";

function dateKeyFromDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function operatorDateParts(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function operatorDateKey(date = new Date()) {
  const parts = operatorDateParts(date);
  if (!parts) return dateKeyFromDate(date);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDaysOperatorDateKey(base = new Date(), days = 0) {
  const parts = operatorDateParts(base);
  if (!parts) return dateKeyFromDate(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 12)));
  return dateKeyFromDate(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12)));
}

function stationConfirmationRequestText(text) {
  const value = String(text || "");
  return /\b(?:please\s+)?confirm\b[^.\n;]{0,120}\b(?:on[-\s]?hand|arrival notice|notice of arrival|\bnoa\b|availability|available|pieces?|storage|ground fees?)\b/i.test(value) ||
    /\bshare\b[^.\n;]{0,80}\b(?:arrival notice|notice of arrival|\bnoa\b)\b/i.test(value);
}

function airBookingOnlyText(text) {
  const value = String(text || "");
  return AIR_BOOKING_PATTERN.test(` ${value} `) && !PICKUP_BROKER_PATTERN.test(value);
}

function falsePositiveShipmentDispatchGate(input, row) {
  const status = String(input?.status || "").toLowerCase();
  if (!["broker-awarded", "awarded", "sent", "done", "dispatched"].includes(status)) return false;
  const text = [
    input?.status,
    input?.evidence,
    input?.summary,
    input?.broker,
    input?.contactEmail,
    ...(row?.events || []).flatMap((event) => [
      event?.type,
      event?.label,
      event?.summary,
      event?.evidence,
      event?.broker,
      event?.selectedBroker,
      event?.contactEmail,
    ]),
  ].filter(Boolean).join(" ");
  return stationConfirmationRequestText(text) || airBookingOnlyText(text);
}

function falsePositiveShipmentCustomsGate(input, row) {
  const status = String(input?.status || "").toLowerCase();
  if (["blocked", "customs-hold", "hold", "exam-hold"].includes(status)) {
    const embeddedHoldEvidence = String(input?.evidence || input?.summary || "").trim();
    const explicitEmbeddedHold = hardCustomsHoldLanguage(embeddedHoldEvidence);
    const currentSourceHold = array(row?.events).some((event) =>
      sourceFactEligible(event) &&
      hasExternalSourceCoordinates(event) &&
      releaseBlockerGateStatus(event) === "blocked"
    );
    return !currentSourceHold && !explicitEmbeddedHold;
  }
  if (!["done", "released", "cleared"].includes(status)) return false;
  const text = [
    input?.status,
    input?.evidence,
    input?.summary,
    ...(row?.events || []).flatMap((event) => [
      event?.type,
      event?.label,
      event?.summary,
      event?.evidence,
    ]),
  ].filter(Boolean).join(" ");
  if (!text.trim() || /\bunknown\b/i.test(text)) return true;
  if (/^\s*customs release\/?d\.?o evidence was received\.?\s*$/i.test(String(input?.evidence || input?.summary || "")) &&
    /\b(?:pre[-\s]?alert|full set of documents|shipment details?|3461|7501|contact consignee)\b/i.test(text)) return true;
  if (/\b(?:not[-\s]?cleared|customs[-\s]?pending|no (?:u\.s\. )?release|no release\/?d\/?o|release\/?d\/?o proof (?:yet|missing)|release pending|clearance pending|no release|no d\/?o)\b/i.test(text)) return true;
  if (/\b(?:customs\s+)?release\b\s*(?:and|&|\+|\/)\s*d\/?o\b/i.test(text)) return false;
  if (/\b(?:arrival[-\s]?release|customs[-\s]?release|release|d\/?o|delivery order)\b[^.;\n]{0,100}\b(?:docs?|documents?|packet|package|attachments?)\b[^.;\n]{0,100}\b(?:received|attached|acknowledged|notated|present)\b/i.test(text)) return false;
  if (/\b(?:docs?|documents?|packet|package|attachments?)\b[^.;\n]{0,100}\b(?:received|attached|acknowledged|notated|present)\b[^.;\n]{0,100}\b(?:arrival[-\s]?release|customs[-\s]?release|release|d\/?o|delivery order)\b/i.test(text)) return false;
  return !/\b(?:98\s+released|marked\s+released|customs released|customs cleared|release\s*\+\s*d\/?o|release\/d\.?o|release\/do|d\/?o and ace|do and ace|1c\s+(?:posted|confirmed|entered)|release attachments? (?:are )?present|released by|cleared by)\b/i.test(text);
}

function falsePositiveShipmentArrivalGate(input, row) {
  const status = String(input?.status || "").toLowerCase();
  // "true" is the direct-Gmail writer's positive status — it must face the
  // same provenance scrutiny (2026-07-06, 016-80000165: a question-minted
  // arrival persisted as status "true" with a proof-only summary even after
  // re-extraction stopped producing the event).
  if (!["done", "arrived", "available", "on-hand", "inferred", "true"].includes(status)) return false;
  const gateClaimText = [input?.evidence, input?.summary].filter(Boolean).join(" ");
  if (/\b(?:not|never)\s+(?:yet\s+)?arrived\b|\b(?:has|have|had|is|was)\s+not\s+arrived\b|\b(?:hasn't|haven't|hadn't|isn't|wasn't)\s+arrived\b|\b(?:no arrival|arrival pending|pending arrival|not at destination|still (?:in[-\s]?transit|at origin))\b/i.test(gateClaimText)) {
    return true;
  }
  const text = [
    input?.status,
    input?.evidence,
    input?.summary,
    ...(row?.events || []).flatMap((event) => [
      event?.type,
      event?.label,
      event?.summary,
      event?.evidence,
    ]),
  ].filter(Boolean).join(" ");
  const concreteArrival = /\b(?:your shipment has arrived|has arrived|arrived at|(?:shipment|cargo|freight|truck|load)\s+(?:(?:has|was|is|just)\s+)?arrived|arrival date|terminal address|storage begin date|available for pickup|cargo (?:is )?available|confirmed arrival|arrival confirmed|on[-\s]?hand at)\b/i.test(text);
  if (concreteArrival) return false;
  if (stationConfirmationRequestText(text)) return true;
  return factLooksProofOnlyArrivalSummary(text);
}

function gateEvidenceRank(name, gateValue) {
  const status = String(gateValue?.status || "").toLowerCase();
  if (name === "pod") {
    if (["done", "received", "pod-found", "found"].includes(status)) return 90;
    if (["pending", "needed", "missing"].includes(status)) return 35;
    return 0;
  }
  if (name === "delivery") {
    if (["delivered", "reported"].includes(status)) return 85;
    if (["blocked"].includes(status)) return 80;
    if (["scheduled"].includes(status)) return 65;
    return 0;
  }
  if (name === "pickup") {
    if (["done", "picked-up", "loaded", "recovered"].includes(status)) return 75;
    if (["blocked", "exception"].includes(status)) return 70;
    if (["driver-onsite", "onsite"].includes(status)) return 60;
    if (["scheduled", "planned", "deferred"].includes(status)) return 55;
    if (["pending"].includes(status)) return 20;
    return 0;
  }
  if (name === "arrival") {
    if (["incomplete", "blocked", "partial"].includes(status)) return 62;
    if (["done", "arrived", "available", "on-hand"].includes(status)) return 55;
    if (["not-arrived"].includes(status)) return 20;
    return 0;
  }
  if (name === "customs") {
    if (["done", "released", "cleared"].includes(status)) return 55;
    if (["blocked", "customs-hold", "hold", "exam-hold"].includes(status)) return 52;
    if (["pending", "waiting", "missing"].includes(status)) return 25;
    return 0;
  }
  if (name === "fees") {
    if (["done", "paid"].includes(status)) return 45;
    if (["due", "pending", "unpaid"].includes(status)) return 40;
    return 0;
  }
  if (name === "dispatch") {
    if (["done", "broker-awarded", "awarded", "sent", "dispatched"].includes(status)) return 45;
    if (["quotes-in"].includes(status)) return 35;
    if (["blocked"].includes(status)) return 40;
    return 0;
  }
  return status && !["unknown", "waiting"].includes(status) ? 10 : 0;
}

function shipmentStateRowTime(row) {
  return eventTime(row?.latestEventAt || row?.updatedAt || row?.at);
}

function bestShipmentGateCandidate(name, rows) {
  return rows
    .map((row) => {
      const input = row?.gates?.[name] || {};
      const fallbackAt = row?.latestEventAt || row?.updatedAt || "";
	      const falsePositive =
	        name === "dispatch"
	          ? falsePositiveShipmentDispatchGate(input, row)
	          : name === "customs"
	            ? falsePositiveShipmentCustomsGate(input, row)
	            : name === "arrival"
	              ? falsePositiveShipmentArrivalGate(input, row)
	              : name === "pod"
	                ? falsePositiveShipmentPodGate(input, row)
	                : name === "delivery"
	                  ? falsePositiveShipmentDeliveryGate(input, row)
	                  : false;
      const normalizedInput = falsePositive
        ? {
            ...input,
            status: "waiting",
	            evidence: name === "dispatch"
	              ? "Station/air-booking evidence is not a pickup broker award."
	              : name === "arrival"
	                ? "Arrival/on-hand was requested, not proven by shipment-state evidence."
	                : name === "pod"
	                  ? "POD was not proven by final POD evidence."
	                  : name === "delivery"
	                    ? "Delivery was not proven by final delivery evidence."
	                    : "Release/DO was not proven by shipment-state evidence.",
            broker: "",
            contactEmail: "",
          }
        : input;
      const mapped = gateFromShipmentState(name, normalizedInput, fallbackAt);
      return {
        row,
        input: normalizedInput,
        mapped,
        rank: falsePositive ? 0 : gateEvidenceRank(name, mapped),
        time: eventTime(input.at || fallbackAt),
      };
    })
    .sort((a, b) => b.rank - a.rank || b.time - a.time || shipmentStateRowTime(b.row) - shipmentStateRowTime(a.row))[0] || null;
}

function mergeShipmentStateRows(group, embeddedState = null) {
  const rows = [
    ...(group.bySource.get("shipment-state") || []),
    embeddedState,
  ].filter((row) => row?.gates && typeof row.gates === "object");
  if (!rows.length) return {};
  const latest = rows.slice().sort((a, b) => shipmentStateRowTime(b) - shipmentStateRowTime(a))[0] || rows[0];
  const gates = Object.fromEntries(SHIPMENT_GATE_NAMES.map((name) => {
    const best = bestShipmentGateCandidate(name, rows);
    const source = best?.input || {};
    const mapped = best?.mapped || {};
    return [name, {
      ...source,
      status: source.status || mapped.status || "unknown",
      evidence: source.evidence || mapped.evidence || "",
      at: source.at || mapped.at || best?.row?.latestEventAt || best?.row?.updatedAt || "",
      broker: source.broker || mapped.broker || "",
      contactEmail: source.contactEmail || mapped.contactEmail || "",
      deliveryScheduledDate: source.deliveryScheduledDate || mapped.deliveryScheduledDate || "",
      pickupScheduledDate: source.pickupScheduledDate || mapped.pickupScheduledDate || "",
      scheduledDate: source.scheduledDate || mapped.scheduledDate || "",
    }];
  }));
  return {
    ...latest,
    gates,
    latestEventAt: rows.slice().sort((a, b) => eventTime(b.latestEventAt || b.updatedAt || "") - eventTime(a.latestEventAt || a.updatedAt || ""))[0]?.latestEventAt || latest.latestEventAt || latest.updatedAt || "",
    _mergedShipmentStateRows: rows.length,
  };
}

function weakSyntheticReleaseGate(gateValue = {}) {
  const status = String(gateValue?.status || "").toLowerCase();
  if (!["pending", "waiting", "missing", "unknown"].includes(status)) return false;
  const text = [
    gateValue?.evidence,
    gateValue?.summary,
    gateValue?.reason,
    gateValue?.source,
  ].filter(Boolean).join(" ");
  return /\b(?:release\/?d\.?o was not proven|release\/?do was not proven|release proof in stale packet|no release proof in stale packet|no release proof|not proven by shipment-state|unknown)\b/i.test(text);
}

function finalCustomsReleaseCutoffAt(gateValue = {}) {
  return weakSyntheticReleaseGate(gateValue) ? "" : gateValue?.at || "";
}

function truthRow(group) {
  return firstFrom(group, "truth-audit");
}

function shipmentTimeCandidates(value) {
  if (!value || typeof value !== "object") return [];
  const candidates = [
    value.at,
    value.updatedAt,
    value.latestEventAt,
    value.emailValidation?.latestEventAt,
    value.opsState?.updatedAt,
    value.opsState?.latestEventAt,
  ];
  Object.values(value.gates || {}).forEach((gateValue) => {
    candidates.push(gateValue?.at, gateValue?.updatedAt);
  });
  [
    ...array(value.events),
    ...array(value.facts),
    ...array(value.factLedger),
    ...array(value.emailValidation?.events),
    ...array(value.emailValidation?.proof),
    ...array(value.opsState?.events),
    ...array(value.evidence),
  ].forEach((item) => candidates.push(item?.at, item?.updatedAt, item?.observedAt));
  return candidates.map(eventTime).filter(Boolean);
}

function truthAuditObservedAt(audit) {
  return eventTime(audit?.gmailAudit?.updatedAt || audit?.updatedAt || audit?.truth?.updatedAt);
}

function truthAuditConflictsWithShipmentState(audit, group) {
  const truth = audit?.truth || {};
  const auditText = [
    truth.shipmentPhase,
    truth.customs,
    truth.currentOperationalState,
    truth.operatorNextAction,
  ].filter(Boolean).join(" ");
  const auditNeedsRelease = (
    /\brelease-needed|broker release needed|no release|release pending|customs pending\b/i.test(auditText) ||
    /\b(?:not|no|pending|waiting|hasn'?t|has not|still)\b[^.;\n]{0,80}\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b/i.test(auditText) ||
    /\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b[^.;\n]{0,80}\b(?:not|pending|waiting|missing|needed|yet|unconfirmed|not confirmed)\b/i.test(auditText)
  );
  if (!auditNeedsRelease) return false;
  return (group.rows || []).some(({ source, shipment }) => {
    if (source !== "shipment-state") return false;
    const gates = shipment?.gates || {};
    const phase = String(shipment?.phase || "").toLowerCase();
    const arrived = statusIs(gates.arrival, ["arrived", "available", "on-hand", "done", "inferred"]) ||
      ["ready-for-pickup", "broker-awarded", "picked-up", "pod-needed", "out-for-delivery", "delivered", "completed"].includes(phase);
    const released = statusIs(gates.customs, ["released", "cleared", "done"]);
    return arrived && released;
  });
}

function latestNonAuditEvidenceAt(group) {
  let latest = 0;
  for (const row of group.rows || []) {
    if (row.source === "truth-audit") continue;
    shipmentTimeCandidates(row.shipment).forEach((time) => {
      latest = Math.max(latest, time);
    });
  }
  return latest;
}

function truthAuditIsStale(audit, group) {
  if (truthAuditConflictsWithShipmentState(audit, group)) return true;
  const auditAt = truthAuditObservedAt(audit);
  const latestEvidenceAt = latestNonAuditEvidenceAt(group);
  if (!auditAt && latestEvidenceAt) return true;
  return Boolean(auditAt && latestEvidenceAt && latestEvidenceAt > auditAt + 60000);
}

function collectFactRows(group) {
  const facts = [];
  const addFact = (fact, source) => {
    if (!fact) return;
    if (!sourceFactEligible(fact)) return;
    const sourceRef = fact.sourceRef || {};
    const summary = fact.summary || fact.note || fact.evidence || fact.evidenceText || fact.finding || fact.claim || fact.label || "";
    if (!summary) return;
    const row = {
      awb: normalizeAwb(fact.awb || group.awb || ""),
      type: fact.type || source,
      label: fact.label || fact.type || source,
      summary,
      evidence: fact.evidence || fact.evidenceText || fact.claim || fact.from || "",
      threadId: fact.threadId || sourceRef.threadId || "",
      messageId: fact.messageId || sourceRef.messageId || "",
      at: fact.at || fact.occurredAt || fact.observedAt || fact.updatedAt || "",
      source: fact.source || fact.sourceSystem || sourceRef.source || source,
      confidence: fact.confidence || "",
      rawSnippet: fact.rawSnippet || fact.extractedTextPreview || "",
      exceptionType: fact.exceptionType || "",
      severity: fact.severity || "",
      status: fact.status || "",
      nextAction: fact.nextAction || "",
      subject: fact.subject || "",
      evidenceKind: fact.evidenceKind || "",
      broker: fact.broker || "",
      contactEmail: fact.contactEmail || fact.email || fact.targetEmail || "",
      amount: fact.amount || "",
      rate: fact.rate || "",
      workgroupId: fact.workgroupId || "",
      gate: fact.gate || "",
      polarity: fact.polarity || "",
    };
    if (foreignScopedReleaseBlockerFact(row, group.awb)) return;
    facts.push(row);
  };

  for (const { source, shipment } of group.rows) {
    array(shipment.facts).forEach((fact) => addFact(fact, source));
    array(shipment.factLedger).forEach((fact) => addFact(fact, source));
    array(shipment.events).forEach((fact) => addFact(fact, source));
    array(shipment.opsState?.events).forEach((fact) => addFact(fact, source));
    // A proof entry is source evidence, not a projection timestamp. Falling an
    // undated entry forward to the shipment-wide latest event can make an old
    // thread summary outrank a newer event from a different thread.
    array(shipment.proof).forEach((fact) => addFact(fact, source));
    array(shipment.proofs).forEach((fact) => addFact(fact, source));
    array(shipment.emailValidation?.proof).forEach((fact) => addFact(fact, source));
    array(shipment.emailValidation?.events).forEach((fact) => addFact(fact, source));
    array(shipment.gmailAudit?.evidence).forEach((fact) => addFact(fact, "truth-audit"));
    array(shipment.evidence).forEach((fact) => addFact(fact, source));
    array(shipment.evidencePacket?.sourceFacts).forEach((fact) => addFact(fact, source));
  }

  return dedupeFacts(facts);
}

function dedupeFacts(facts) {
  const seen = new Set();
  return facts.filter((fact) => {
    const key = [fact.type, fact.label, fact.summary, fact.threadId, fact.messageId].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factText(fact) {
  return `${fact?.type || ""} ${fact?.label || ""} ${fact?.summary || ""} ${fact?.evidence || ""} ${fact?.claim || ""}`.trim();
}

function positiveExecutionProgressText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  const hardBlocker =
    /\b(?:not (?:loaded|picked up|recovered|delivered)|waiting to be loaded|driver waiting|driver on[-\s]?site|driver onsite|detention|cannot|can't|unable|blocked|stuck|not found|can't locate|cannot locate|wrong (?:consignee|cnee|customer|recipient|receiver)|delivered by mistake|receiver closed|consignee closed|facility closed|refused|storage|hold overnight|customs hold|government hold|exam hold)\b/i;
  const progress =
    /\b(?:truck|driver|carrier|cargo|freight|shipment|load)\b[^.;\n]{0,80}\b(?:is |was |now |has been |got )?(?:loaded|picked\s*up|recovered)\b/i;
  const movement =
    /\b(?:heading|headed|en route|rolling|on (?:the )?way)\b[^.;\n]{0,80}\b(?:drop[-\s]?off|delivery|receiver|consignee|cnee|destination)\b/i;
  const outForDelivery = /\b(?:out[-\s]?for[-\s]?delivery|\bofd\b|will deliver by|eta(?:\s+to)?\s+(?:cnee|receiver|consignee|delivery|drop[-\s]?off))\b/i;
  const clauses = unique([
    value,
    ...evidenceClauses(value),
  ]);
  return clauses.some((clause) =>
    (progress.test(clause) || movement.test(clause) || outForDelivery.test(clause)) &&
      !hardBlocker.test(clause)
  );
}

function benignExecutionScheduleText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  const hardBlocker =
    /\b(?:missed|failed|cancel(?:led|ed)?|reschedul(?:e|ed|ing)|not booked|no appointment|no appt|appointment (?:problem|issue|blocked)|cannot|can't|unable|blocked|stuck|not found|can't locate|cannot locate|wrong (?:consignee|cnee|customer|recipient|receiver)|delivered by mistake|receiver closed|consignee closed|facility closed|refused|storage|hold overnight|detention|customs hold|government hold|exam hold)\b/i;
  const scheduledPickup =
    /\b(?:driver|carrier|truck|trucker|we|they)\b[^.;\n]{0,100}\b(?:will|is going to|scheduled to|set to)\b[^.;\n]{0,80}\b(?:pick\s*up|pickup|recover|load)\b/i;
  const appointmentBooked =
    /\b(?:appointment|appt)\b[^.;\n]{0,120}\b(?:booked|scheduled|confirmed|set|for\s+\d{1,2}(?::?\d{2})?\s*(?:am|pm)?)\b/i ||
    /\b(?:booked|scheduled|confirmed|set)\b[^.;\n]{0,120}\b(?:appointment|appt)\b/i;
  const etaChase =
    /\b(?:please|pls)?\s*(?:urgently\s+)?(?:advise|confirm|share|send)\b[^.;\n]{0,80}\b(?:eta|delivery eta|arrival eta)\b/i;
  const clauses = unique([
    value,
    ...evidenceClauses(value),
  ]);
  return clauses.some((clause) =>
    (scheduledPickup.test(clause) || appointmentBooked.test(clause) || etaChase.test(clause)) &&
      !hardBlocker.test(clause)
  );
}

function nonExceptionExecutionUpdateText(text) {
  return positiveExecutionProgressText(text) || benignExecutionScheduleText(text);
}

function positiveExecutionProgressFact(fact = {}) {
  return nonExceptionExecutionUpdateText(factText(fact));
}

function factOccurredAt(fact = {}) {
  fact = fact || {};
  return fact.at || fact.occurredAt || fact.observedAt || fact.updatedAt || "";
}

function factSourceText(fact) {
  return `${fact?.source || ""} ${fact?.type || ""} ${fact?.label || ""}`.trim();
}

function generatedStateSource(fact) {
  return /\b(?:canonical-shipment-pipeline|shipment-state-sanity|shipment-state|active-shipment|truth-audit)\b/i.test(factSourceText(fact));
}

function sourceLooksTmsOrTracking(fact) {
  const source = `${factSourceText(fact)} ${fact?.summary || ""}`;
  return /\b(?:tms|couriercloud|carrier tracking|tracking)\b/i.test(source) &&
    !fact?.threadId &&
    !fact?.messageId &&
    !/\b(?:gmail|email|thread|operator|companion|broker|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight)\b/i.test(source);
}

function sourceLooksEmailOrOperator(fact) {
  if (generatedStateSource(fact) && !fact?.threadId && !fact?.messageId) return false;
  const source = `${factSourceText(fact)} ${fact?.summary || ""}`;
  return Boolean(fact?.threadId || fact?.messageId) ||
    /\b(?:gmail|email|thread|operator|companion|broker|customs|clearance|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight)\b/i.test(source);
}

function releaseBlockerRelevantText(text) {
  const value = String(text || "");
  if (unreadableAttachmentNoiseText(value)) return false;
  const hasReleaseContext =
    /\b(?:customs|clearance|release|released|delivery order|d[/.]\s*o|\b1[-\s]?h\b|exam|hold)\b/i.test(value) ||
    /\bDO\b/.test(value);
  if (!hasReleaseContext) return false;
  if (/\b(?:not picked up|pickup pending|not delivered|not applicable before delivery|do not dispatch pickup yet|monitor arrival|track final delivery|pod pending|pod missing)\b/i.test(value)) {
    return /\b(?:customs|clearance|release|d[/.]\s*o|delivery order|hold|exam)\b.{0,80}\b(?:blocked|pending|missing|not|no|without|awaiting|cannot|can't)\b/i.test(value) ||
      /\bDO\b.{0,80}\b(?:blocked|pending|missing|not|no|without|awaiting|cannot|can't)\b/.test(value);
  }
  return true;
}

function releaseBlockerLanguage(text) {
  const value = String(text || "");
  if (unreadableAttachmentNoiseText(value)) return false;
  return hardCustomsHoldLanguage(value) ||
    /\b(?:not released|cannot be released|not cleared|release pending|clearance pending|no release|release\/?d\.?o (?:is )?(?:not confirmed|missing|pending|needed)|release\/?do (?:is )?(?:not confirmed|missing|pending|needed)|missing (?:release|d\/?o|delivery order)|d\/?o (?:pending|missing|needed)|delivery order (?:pending|missing|needed)|cannot see release|can't see release|does not see release|release not visible|release is still blocked|inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|customs entry[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it)\b/i.test(value);
}

function hardCustomsHoldLanguage(text) {
  const clauses = String(text || "")
    .replace(/\b(?:but|however|subsequently)\b/gi, ".")
    .split(/[.;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let active = null;
  for (const clause of clauses) {
    const holdContext = /\b(?:customs|cbp|fda|government|exam|hold|\b1[-\s]?h\b)\b/i.test(clause);
    if (!holdContext) continue;
    const explicitlyNoHold = /\bno\s+(?:active\s+)?(?:customs|government|cbp|fda|exam)?\s*hold\b|\b(?:not|never)\s+(?:currently\s+)?(?:on|under)\s+(?:an?\s+)?(?:customs|government|cbp|fda|exam)\s+hold\b|\b(?:customs|government|cbp|fda|exam)\s+hold\b[^.;\n]{0,30}\bnot\s+active\b/i.test(clause);
    const explicitlyUnresolved = /\b(?:hold|exam)\b[^.;\n]{0,50}\b(?:not|never|hasn't|isn't|wasn't)\b[^.;\n]{0,40}\b(?:removed|released|lifted|cleared|resolved)\b/i.test(clause);
    const conditionallyUnresolved = /\b(?:until|unless)\b[^.;\n]{0,100}(?:\bhold\b[^.;\n]{0,50}\b(?:removed|released|lifted|cleared)|\b(?:remove|release|lift|clear)\b[^.;\n]{0,50}\bhold\b)/i.test(clause);
    const explicitlyResolved = /\b(?:hold|exam)\b[^.;\n]{0,60}\b(?:removed|released|lifted|cleared|resolved)\b|\b(?:removed|released|lifted|cleared|resolved)\b[^.;\n]{0,60}\b(?:hold|exam)\b/i.test(clause);
    if (explicitlyNoHold || explicitlyResolved && !explicitlyUnresolved && !conditionallyUnresolved) {
      active = false;
      continue;
    }
    if (
      explicitlyUnresolved ||
      conditionallyUnresolved ||
      /\b(?:customs hold|government hold|u\.?s\.? customs hold|cbp hold|fda hold|exam hold|intensive exam|hold remains active|\b1[-\s]?h\b)\b/i.test(clause) ||
      /\b(?:u\.?s\.?\s*)?(?:customs|cbp|fda|government)\b[^.;\n]{0,140}\b(?:hold|exam|examine|inspection)\b/i.test(clause) ||
      /\b(?:shipment|cargo|freight)\b[^.;\n]{0,100}\b(?:on|under)\s+(?:a\s+)?(?:customs|government|cbp|fda|exam)\s+hold\b/i.test(clause) ||
      /\bhold\b[^.;\n]{0,50}\bfor\s+(?:an?\s+)?(?:customs\s+)?exam\b/i.test(clause)
    ) {
      active = true;
    }
  }
  return active === true;
}

function awbMentionsFromText(text = "", targetAwb = "") {
  const target = normalizeAwb(targetAwb);
  return [...String(text || "").matchAll(/\b(?:\d{3}[-/\s]?)?\d{8}\b/g)]
    .map((match) => {
      const digits = normalizeAwb(match[0]);
      const awb = digits.length === 8 && target.endsWith(digits) ? target : digits;
      return { awb, index: match.index || 0, end: (match.index || 0) + match[0].length };
    })
    .filter((item) => item.awb);
}

function awbScopedClauseText(text = "", targetAwb = "") {
  const value = String(text || "");
  const target = normalizeAwb(targetAwb);
  if (!value || !target) return { text: value, scoped: false, foreignAwbs: [] };
  const mentions = awbMentionsFromText(value, target);
  const foreignAwbs = [...new Set(mentions.map((item) => item.awb).filter((awb) => awb !== target))];
  if (!foreignAwbs.length) return { text: value, scoped: false, foreignAwbs };
  const targetMentions = mentions.filter((item) => item.awb === target);
  if (!targetMentions.length) return { text: "", scoped: true, foreignAwbs };
  const boundaries = [0];
  const separatorPattern = /(?:\r?\n|[.;]|(?=\b\d{3}[-/\s]?\d{8}\b)|(?<![-/\d])(?=\b\d{8}\b))/g;
  for (const match of value.matchAll(separatorPattern)) boundaries.push(match.index || 0);
  boundaries.push(value.length);
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const chunks = targetMentions.map((mention) => {
    let start = 0;
    let end = value.length;
    for (const boundary of sorted) {
      if (boundary <= mention.index) start = boundary;
      if (boundary > mention.index) {
        end = boundary;
        break;
      }
    }
    return value.slice(start, end).replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  return { text: chunks.join(" "), scoped: true, foreignAwbs };
}

function genericReleasePendingCustomsHoldText(value) {
  const text = String(value || "");
  if (!/\b(?:customs hold pdf|customs\/release still blocking|release pending|release\/?d\.?o (?:is )?not confirmed|release\/?do (?:is )?not confirmed)\b/i.test(text)) {
    return false;
  }
  return !/\b(?:government hold|u\.?s\.? customs hold|u\.?s\.? customs wants? to examine|customs wants? to examine|exam hold|\b1[-\s]?h\b|hold remains active|hold not removed|cbp hold|fda hold|intensive exam)\b/i.test(text);
}

function unreadableAttachmentNoiseText(value) {
  const text = String(value || "");
  if (attachmentExtractionUnavailableText(text) || /\bpdf[-\s]?unreadable|unreadable\/binary|without OCR\/manual review|text extraction was unreadable\b/i.test(text)) return true;
  return /\b(?:customs hold pdf|customs\/release still blocking|appears to be on a true customs\/government hold)\b/i.test(text) &&
    /[ÿþ�Â]|[\u0000-\u0008\u000b-\u001f\u007f]/.test(text) &&
    !/\b(?:u\.?s\.? customs wants? to examine|customs wants? to examine|u\.?s\.? customs hold|cbp hold|fda hold|government hold|exam hold|hold remains active|hold not removed|intensive exam)\b/i.test(text);
}

function directEmailCustomsBlockerExists(facts = []) {
  return Boolean(authoritativeEmailReleaseBlockerFact(facts));
}

function externalFinalCustomsReleaseFact(fact = {}) {
  if (!sourceLooksEmailOrOperator(fact) || sourceLooksTmsOrTracking(fact) || generatedGateFact(fact)) return false;
  const text = factText(fact);
  if (!releaseBlockerRelevantText(text) && !releaseTextLooksFinal(text)) return false;
  return releaseTextLooksFinal(text);
}

function latestExternalFinalCustomsReleaseFact(facts = []) {
  return [...facts]
    .filter((fact) => externalFinalCustomsReleaseFact(fact))
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function releaseTextLooksFinal(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (releaseTextLooksTmsOnly(value)) return false;
  if (/\b(?:thread unresolved|unresolved)\b/i.test(value)) return false;
  if (releaseBlockerLanguage(value)) return false;
  return /\b(?:done|released|cleared|clearance released|98 released|customs[-\s]?release[-\s]?received|(?:shipment|cargo|freight) (?:is|was|has been) release(?:d)?|release\/?d\/?o evidence was received|release\/?d\/?o attachment (?:is )?present|release document (?:is )?attached|customs layer is resolved|delivery order (?:was )?(?:attached|issued|received|ready)|d\/?o (?:was )?(?:attached|issued|received|ready)|do & abi backup)\b/i.test(value);
}

function releaseTextLooksTmsOnly(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  const tmsSignal = /\b(?:tms|couriercloud|295[-\s]*(?:customs\s*)?rel|customs rel|active\/?tms)\b/i.test(value);
  if (!tmsSignal) return false;
  return !/\b(?:gmail|email|thread|message|operator|broker|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight|abi|ace|98\s+released|attached|delivery order|d\/?o)\b/i.test(value);
}

function releaseReadyArrivalInferenceFact(facts = []) {
  return facts
    .filter((fact) => sourceLooksEmailOrOperator(fact) && !generatedGateFact(fact))
    .find((fact) => /\b(?:arrival-inferred-release-ready|release-ready arrival inferred)\b/i.test(factText(fact))) || null;
}

function directGroundFeeDueEvidence(facts = []) {
  return facts.some((fact) => {
    if (!sourceLooksEmailOrOperator(fact) || sourceLooksTmsOrTracking(fact) || generatedGateFact(fact)) return false;
    const text = factText(fact);
    if (/\b(?:quote|rate is|quoted|pickup quote|delivery quote|linehaul|freight rate)\b/i.test(text)) return false;
    if (!/\b(?:ground fees?|handling fees?|station fees?|warehouse fees?|cargosprint|cargo sprint|\bisc\b)\b/i.test(text)) return false;
    return /\b(?:due|unpaid|pay|payment required|invoice|amount owed|balance)\b/i.test(text);
  });
}

function customsReleaseResolvableBlockerText(text) {
  const value = String(text || "");
  if (unreadableAttachmentNoiseText(value)) return false;
  return /\b(?:customs[-\s]?hold|government hold|u\.?s\.? customs hold|exam hold|hold not removed|hold remains active|not released|not cleared|release pending|clearance pending|no release|release\/?d\.?o (?:is )?(?:not confirmed|missing|pending|needed)|release\/?do (?:is )?(?:not confirmed|missing|pending|needed)|missing (?:release|d\/?o|delivery order)|d\/?o (?:pending|missing|needed)|delivery order (?:pending|missing|needed)|cannot see release|can't see release|does not see release|release not visible|release is still blocked|inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|customs entry[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it|pickup is blocked by customs hold|blocked by customs hold|customs hold\/exam)\b/i.test(value);
}

function customsBlockerResolvedByRelease(blocker = {}, releaseResolver = null) {
  if (!releaseResolver || !externalFinalCustomsReleaseFact(releaseResolver)) return false;
  if (!sourceLooksEmailOrOperator(blocker) || sourceLooksTmsOrTracking(blocker) || generatedGateFact(blocker)) return false;
  if (!customsReleaseResolvableBlockerText(factText(blocker))) return false;
  const blockerTime = eventTime(factOccurredAt(blocker));
  const releaseTime = eventTime(factOccurredAt(releaseResolver));
  return Boolean(blockerTime && releaseTime && releaseTime >= blockerTime);
}

function pickupGateResolvedByRelease(gateValue = {}, releaseResolver = null) {
  if (!releaseResolver || !externalFinalCustomsReleaseFact(releaseResolver)) return false;
  if (!customsReleaseResolvableBlockerText([
    gateValue.status,
    gateValue.rawStatus,
    gateValue.reason,
    gateValue.evidence,
    gateValue.summary,
  ].filter(Boolean).join(" "))) {
    return false;
  }
  const gateTime = eventTime(gateValue.at);
  const releaseTime = eventTime(factOccurredAt(releaseResolver));
  return Boolean(gateTime && releaseTime && releaseTime >= gateTime);
}

function retireCustomsBrokerHoldWithRelease(customsBroker = null, facts = []) {
  if (!customsBroker) return customsBroker;
  const releaseResolver = latestExternalFinalCustomsReleaseFact(facts);
  if (!releaseResolver || authoritativeEmailReleaseBlockerFact(facts)) return customsBroker;
  const brokerText = [
    customsBroker.status,
    customsBroker.brokerStatus,
    customsBroker.nextAction,
  ].filter(Boolean).join(" ");
  if (!customsReleaseResolvableBlockerText(brokerText)) return customsBroker;
  return compactMetadataObject({
    ...customsBroker,
    status: "released",
    brokerStatus: "released",
    nextAction: "",
    releaseResolvedAt: factOccurredAt(releaseResolver),
  });
}

function authoritativeEmailReleaseBlockerFact(facts, awb = "") {
  const emailFacts = facts
    .filter((fact) => sourceLooksEmailOrOperator(fact) && !sourceLooksTmsOrTracking(fact) && !generatedGateFact(fact) && !foreignScopedReleaseBlockerFact(fact, awb) && releaseBlockerRelevantText(factText(fact)));
  const blocker = emailFacts
    .filter((fact) => !releaseTextLooksFinal(factText(fact)) && releaseBlockerLanguage(factText(fact)))
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
  if (!blocker) return null;
  const laterFinal = emailFacts
    .filter((fact) => releaseTextLooksFinal(factText(fact)) && eventTime(factOccurredAt(fact)) >= eventTime(factOccurredAt(blocker)))
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
  return laterFinal ? null : blocker;
}

function releaseBlockerGateStatus(blocker) {
  if (genericReleasePendingCustomsHoldText(factText(blocker))) return "pending";
  return hardCustomsHoldLanguage(factText(blocker)) ||
    /\b(?:inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|customs entry[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it)\b/i.test(factText(blocker))
    ? "blocked"
    : "pending";
}

function stableMetadata(group, memory = {}) {
  const audit = truthRow(group);
  const tmsShipment = firstTmsFrom(group) || {};
  const active = firstFrom(group, "active") || tmsShipment || audit?.snapshots?.active || {};
  const brain = firstFrom(group, "brain") || firstFrom(group, "brain-completed") || audit?.snapshots?.brain || {};
  const tms = audit?.snapshots?.tms || tmsShipment.tms || active.tms || brain.tms || {};
  const tracking = audit?.snapshots?.tracking || active.tracking || brain.tracking || {};
  const proof = latestFrom(group, "gmail-proof") || {};
  const facts = factRowsForGroup(group, memory);

  const airport = first(audit?.airport, active.station, brain.station, active.airport, brain.airport, tms.destination, tracking.latestEvent?.station);
  const airline = first(audit?.airline, active.airline, brain.airline, tracking.carrier, tms.carrier);
  const client = first(audit?.client, active.client, brain.client, proof.client);
  const consignee = first(active.consignee, brain.consignee, proof.consignee, active.destinationName, brain.destinationName);
  const etaSelection = canonicalEtaSelection({ facts, audit, active, brain, tracking, tms, memory, awb: group.awb });
  const eta = etaSelection.eta;
  const pieces = first(tms.pieces, active.tms?.pieces, brain.tms?.pieces, active.pieces, brain.pieces, textMatch(facts, /\b(\d+)\s*(?:pcs?|pieces?)\b/i));
  const weight = first(
    tms.weight && tms.weightUom ? `${tms.weight} ${tms.weightUom}` : "",
    tms.weight,
    active.tms?.weight,
    brain.tms?.weight,
    active.weight,
    brain.weight,
    textMatch(facts, /\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:kg|kgs|lb|lbs)\b/i),
  );
  const dims = first(active.dims, brain.dims, active.dimensions, brain.dimensions, textMatch(facts, /\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?:\s*(?:in|cm))?\b/i));
  const pallets = first(active.pallets, active.tms?.pallets, brain.pallets, brain.tms?.pallets, textMatch(facts, /\b(\d+)\s*(?:pallets?|skids?)\b/i));
  const cargo = metadataCargo({ pieces, pallets, weight, dims, active, brain, tms, facts });
  const flightDetails = metadataFlightDetails({ active, brain, tms, tracking, facts });
  const activeDelivery = metadataDeliveryFromRecord(active);
  const brainDelivery = metadataDeliveryFromRecord(brain);
  const delivery = compactMetadataObject({
    ...brainDelivery,
    ...activeDelivery,
    consignee: first(activeDelivery.consignee, brainDelivery.consignee, consignee),
  });
  const activeShipper = metadataShipperFromRecord(active);
  const brainShipper = metadataShipperFromRecord(brain);
  const shipper = compactMetadataObject({
    ...brainShipper,
    ...activeShipper,
  });
  const commercial = metadataCommercialFromRecord(active, brain, tms);
  const stationContact = stationContactFor(memory, airport, airline, group) || stationContactFromRecord(active) || stationContactFromRecord(brain);
  const stationContext = stationContextProvenanceFromRecord(active, stationContact) ||
    stationContextProvenanceFromRecord(brain, stationContact);
  let customsBroker = customsBrokerFromRecord(active) ||
    customsBrokerFromRecord(brain) ||
    customsBrokerFromFacts(facts) ||
    customsBrokerFromRelatedMemory(memory, { awb: group.awb, airport, airline, client, consignee });
  customsBroker = retireCustomsBrokerHoldWithRelease(customsBroker, facts);

  return {
    awb: group.awb,
    displayAwb: formatAwb(group.awb),
    id: first(active.id, brain.id, tms.order, audit?.awb, group.awb),
    airport,
    station: airport,
    airline,
    client,
    consignee,
    eta,
    etaSource: etaSelection.etaSource,
    etaConflict: etaSelection.etaConflict,
    etaUnresolvedRelative: etaSelection.etaUnresolvedRelative,
    etaPastUnverified: Boolean(etaSelection.etaPastUnverified),
    pieces,
    pallets,
    weight: cargo.weight || weight,
    dims,
    cargo,
    flightDetails,
    route: flightDetails.route || "",
    origin: flightDetails.origin || "",
    destination: flightDetails.destination || "",
    delivery,
    shipper,
    commercial,
    tms: compactMetadataWithSource({
      status: first(tms.status, tms.tmsStatus, active.tms?.status, active.tms?.tmsStatus, brain.tms?.status, brain.tms?.tmsStatus),
      tmsStatus: first(tms.tmsStatus, tms.status, active.tms?.tmsStatus, active.tms?.status, brain.tms?.tmsStatus, brain.tms?.status),
      statusDescription: first(tms.statusDescription, active.tms?.statusDescription, brain.tms?.statusDescription),
      nextTask: first(tms.nextTask, active.tms?.nextTask, brain.tms?.nextTask),
      snapshotTime: first(tms.snapshotTime, active.tms?.snapshotTime, brain.tms?.snapshotTime),
      order: first(tms.order, active.tms?.order, brain.tms?.order, active.tmsOrderId, brain.tmsOrderId),
      source: first(tms.source, active.tms?.source, brain.tms?.source, "tms-detail"),
    }, "tms-detail"),
    tmsOrderId: first(tms.order, active.tmsOrderId, brain.tmsOrderId),
    stationContact,
    stationContext,
    customsBroker,
  };
}

function customsBrokerFromRecord(record = {}) {
  const customs = record.customsBroker || record.contacts?.customs || {};
  const broker = contactField(customs, "broker", "name", "contactName");
  const email = contactField(customs, "contactEmail", "email");
  const phone = contactField(customs, "contactPhone", "phone");
  const status = contactField(customs, "status", "brokerStatus");
  if (!broker && !email && !phone) return null;
  return { broker, contactEmail: email, phone, status, brokerStatus: status };
}

function customsBrokerFromFacts(facts = []) {
  const fact = facts
    .filter((fact) => /customs-broker-inferred|customs broker|clearance broker|broker received/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`))
    .filter((fact) => fact.broker || fact.contactEmail)
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0];
  if (!fact) return null;
  return {
    broker: fact.broker || "",
    contactEmail: fact.contactEmail || "",
    phone: "",
    status: "customs-contact-inferred",
    brokerStatus: fact.summary || "Customs broker contact inferred from document-routing evidence.",
  };
}

function normalizedIdentity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:inc|llc|ltd|co|company|corp|corporation|the|ship|to)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relatedShipmentBrokerRows(memory = {}) {
  return [
    ...array(memory.active?.shipments),
    ...array(memory.brain?.shipments),
    ...array(memory.brain?.completed),
  ];
}

function customsBrokerFromRelatedMemory(memory = {}, target = {}) {
  const targetStation = String(target.airport || target.station || "").toUpperCase();
  const targetAirline = normalizedIdentity(target.airline);
  const targetConsignee = normalizedIdentity(target.consignee);
  const targetClient = normalizedIdentity(target.client);
  const targetAwbPrefix = normalizeAwb(target.awb).slice(0, 6);
  const candidates = relatedShipmentBrokerRows(memory)
    .map((row) => {
      const broker = customsBrokerFromRecord(row);
      if (!broker?.broker && !broker?.contactEmail && !broker?.phone) return null;
      const station = String(row.station || row.airport || "").toUpperCase();
      const airline = normalizedIdentity(row.airline);
      const consignee = normalizedIdentity(row.consignee || row.destinationName);
      const client = normalizedIdentity(row.client);
      const awbPrefix = normalizeAwb(row.awb || row.id).slice(0, 6);
      let score = 0;
      if (targetStation && station && station === targetStation) score += 4;
      if (targetConsignee && consignee && (targetConsignee === consignee || targetConsignee.includes(consignee) || consignee.includes(targetConsignee))) score += 4;
      if (targetClient && client && (targetClient === client || targetClient.includes(client) || client.includes(targetClient))) score += 2;
      if (targetAirline && airline && (targetAirline === airline || targetAirline.includes(airline) || airline.includes(targetAirline))) score += 2;
      if (targetAwbPrefix && awbPrefix && awbPrefix === targetAwbPrefix) score += 1;
      return { broker, score };
    })
    .filter(Boolean)
    .filter((item) => item.score >= 6)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0]?.broker;
  if (!best) return null;
  return {
    ...best,
    status: "customs-contact-inferred",
    brokerStatus: "Customs broker contact inferred from related shipment context; release still needs AWB-specific proof.",
    inferredFromRelatedShipment: true,
  };
}

function textMatch(facts, pattern) {
  for (const fact of facts) {
    const match = String(fact.summary || fact.evidence || "").match(pattern);
    if (match) return match[1] || match[0];
  }
  return "";
}

function cleanMetadataValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeWeightMetadata(value, weightUom = "") {
  let text = cleanMetadataValue(value);
  const uom = cleanMetadataValue(weightUom).toUpperCase();
  if (!text || !uom) return text;
  const aliases = uom.startsWith("KG")
    ? ["KG", "KGS"]
    : uom.startsWith("LB")
      ? ["LB", "LBS"]
      : [uom];
  for (const alias of aliases) {
    text = text.replace(new RegExp(`\\s*${alias}\\.?$`, "i"), "").trim();
  }
  return text;
}

function hasMetadataValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value).some(hasMetadataValue);
  return true;
}

function compactMetadataObject(record = {}) {
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, value]) => {
        if (Array.isArray(value)) return [key, value.filter(hasMetadataValue)];
        if (value && typeof value === "object") return [key, compactMetadataObject(value)];
        return [key, value];
      })
      .filter(([, value]) => hasMetadataValue(value)),
  );
}

function hasMeaningfulMetadata(record = {}) {
  return Object.entries(record || {})
    .some(([key, value]) => key !== "source" && hasMetadataValue(value));
}

function compactMetadataWithSource(record = {}, source = "tms-detail") {
  const compact = compactMetadataObject(record);
  if (!hasMeaningfulMetadata(compact)) return {};
  return source ? { ...compact, source: compact.source || source } : compact;
}

function metadataAddressFromRecord(record = {}) {
  const delivery = record.delivery || {};
  return first(
    delivery.fullAddress,
    record.deliveryAddress,
    [
      delivery.address1,
      delivery.address2,
      delivery.address3,
      delivery.city,
      delivery.state,
      delivery.country,
    ].filter(Boolean).join(", "),
  );
}

function metadataDeliveryFromRecord(record = {}) {
  const delivery = record.delivery || {};
  return compactMetadataWithSource({
    consignee: first(delivery.consignee, record.consignee, record.destinationName),
    contactPhone: first(delivery.contactPhone, delivery.phone, record.consigneePhone),
    contactEmail: first(delivery.contactEmail, delivery.email, record.consigneeEmail),
    address1: delivery.address1 || "",
    address2: delivery.address2 || "",
    city: delivery.city || "",
    state: delivery.state || "",
    country: delivery.country || "",
    airport: first(delivery.airport, record.station, record.airport),
    courier: first(delivery.courier, record.tms?.deliveryCourier),
    fullAddress: metadataAddressFromRecord(record),
  });
}

function metadataShipperFromRecord(record = {}) {
  const shipper = record.shipper || {};
  const tms = record.tms || {};
  return compactMetadataWithSource({
    name: first(shipper.name, record.pickup?.company, tms.pickupCompany, tms.shipperName),
    contactName: first(shipper.contactName, tms.shipperName),
    phone: first(shipper.phone, tms.shipperPhone, tms.pickupPhone),
    email: first(shipper.email, tms.shipperEmail, tms.pickupEmail),
    address1: first(shipper.address1, tms.pickupAddress1),
    address2: first(shipper.address2, tms.pickupAddress2),
    city: first(shipper.city, tms.pickupCity),
    state: first(shipper.state, tms.pickupState),
    country: first(shipper.country, tms.pickupCountry),
    airport: first(shipper.airport, tms.pickupAirport, tms.origin),
    fullAddress: first(shipper.fullAddress, [
      tms.pickupAddress1,
      tms.pickupAddress2,
      tms.pickupCity,
      tms.pickupState,
      tms.pickupCountry,
    ].filter(Boolean).join(", ")),
  });
}

function flightCodeFromValue(value) {
  if (!value) return "";
  if (typeof value === "object") return cleanMetadataValue(value.flight || value.number || value.flightNumber);
  const text = cleanMetadataValue(value).toUpperCase();
  if (/TRUCK/.test(text)) return "";
  const match = text.match(/\b([A-Z][A-Z0-9]|[A-Z0-9][A-Z])\s?(\d{2,4})[A-Z]?\b/);
  return match ? `${match[1]}${match[2]}` : text;
}

function collectFlightRows(...sources) {
  const seen = new Set();
  const rows = [];
  for (const source of sources.flat()) {
    const flight = flightCodeFromValue(source);
    if (!flight || seen.has(flight)) continue;
    seen.add(flight);
    rows.push(typeof source === "object"
      ? { ...source, flight }
      : { flight, sourceSegment: cleanMetadataValue(source) });
  }
  return rows;
}

function metadataFlightDetails({ active = {}, brain = {}, tms = {}, tracking = {}, facts = [] } = {}) {
  const activeDetails = active.flightDetails || {};
  const brainDetails = brain.flightDetails || {};
  const activeTrackingDetails = active.liveTracking?.flightDetails || {};
  const brainTrackingDetails = brain.liveTracking?.flightDetails || {};
  const trackingDetails = tracking.flightDetails || activeTrackingDetails || brainTrackingDetails || {};
  const tmsFlight = first(
    activeDetails.tmsFlight,
    brainDetails.tmsFlight,
    activeTrackingDetails.tmsFlight,
    brainTrackingDetails.tmsFlight,
    trackingDetails.tmsFlight,
    tms.tmsFlight,
    [tms.dep, tms.arr].filter(Boolean).join(" "),
  );
  const route = first(
    activeDetails.route,
    brainDetails.route,
    active.liveTracking?.route,
    brain.liveTracking?.route,
    activeTrackingDetails.route,
    brainTrackingDetails.route,
    trackingDetails.route,
    active.route,
    brain.route,
    tms.route,
    [tms.origin, tms.destination].filter(Boolean).join("-"),
  );
  const origin = first(activeDetails.origin, brainDetails.origin, activeTrackingDetails.origin, brainTrackingDetails.origin, trackingDetails.origin, active.origin, brain.origin, tms.origin);
  const destination = first(activeDetails.destination, brainDetails.destination, activeTrackingDetails.destination, brainTrackingDetails.destination, trackingDetails.destination, active.destination, brain.destination, tms.destination);
  const flights = collectFlightRows(
    array(activeDetails.flights),
    array(brainDetails.flights),
    array(active.liveTracking?.flights),
    array(brain.liveTracking?.flights),
    array(activeTrackingDetails.flights),
    array(brainTrackingDetails.flights),
    array(trackingDetails.flights),
    activeDetails.primaryFlight,
    brainDetails.primaryFlight,
    activeTrackingDetails.primaryFlight,
    brainTrackingDetails.primaryFlight,
    trackingDetails.primaryFlight,
    tms.flight,
    tms.flightNumber,
    tmsFlight,
  );
  const etaHint = etaTextWithYear(first(
    activeDetails.etaHint,
    brainDetails.etaHint,
    active.liveTracking?.scheduledArrival,
    brain.liveTracking?.scheduledArrival,
    activeTrackingDetails.etaHint,
    brainTrackingDetails.etaHint,
    trackingDetails.etaHint,
    activeDetails.scheduledArrival,
    brainDetails.scheduledArrival,
    trackingDetails.scheduledArrival,
    active.eta,
    brain.eta,
    tms.eta,
    etaFromFacts(facts),
  ));
  return compactMetadataWithSource({
    flights,
    primaryFlight: first(activeDetails.primaryFlight, brainDetails.primaryFlight, activeTrackingDetails.primaryFlight, brainTrackingDetails.primaryFlight, trackingDetails.primaryFlight, flights[0]?.flight),
    tmsFlight,
    departureLeg: first(activeDetails.departureLeg, tms.dep),
    arrivalLeg: first(activeDetails.arrivalLeg, tms.arr),
    route,
    origin,
    destination,
    etaHint,
    recoveryHint: first(activeDetails.recoveryHint, brainDetails.recoveryHint, activeTrackingDetails.recoveryHint, brainTrackingDetails.recoveryHint, trackingDetails.recoveryHint, etaHint),
    source: first(activeDetails.source, brainDetails.source, activeTrackingDetails.source, brainTrackingDetails.source, trackingDetails.source, "tms-detail"),
  });
}

function metadataCommercialFromRecord(active = {}, brain = {}, tms = {}) {
  const activeCommercial = active.commercial || {};
  const brainCommercial = brain.commercial || {};
  return compactMetadataWithSource({
    customerCharge: first(activeCommercial.customerCharge, brainCommercial.customerCharge, tms.customerCharge),
    billingTotal: first(activeCommercial.billingTotal, brainCommercial.billingTotal, tms.billingTotal, tms.customerCharge),
    vendorCost: first(activeCommercial.vendorCost, brainCommercial.vendorCost, tms.vendorCost),
    costTotal: first(activeCommercial.costTotal, brainCommercial.costTotal, tms.costTotal, tms.vendorCost),
    source: first(activeCommercial.source, brainCommercial.source, "tms-detail"),
  });
}

function metadataCargo({ pieces, pallets, weight, dims, active = {}, brain = {}, tms = {}, facts = [] } = {}) {
  const weightUom = first(tms.weightUom, tms.weightUnit, active.tms?.weightUom, active.weightUom, brain.tms?.weightUom, brain.weightUom);
  const normalizedWeight = normalizeWeightMetadata(weight, weightUom);
  const commodity = first(
    tms.commodity,
    tms.contents,
    active.commodity,
    brain.commodity,
    textMatch(facts, /\b(?:commodity|goods description|description of goods)\b[:\s-]*([^.;\n]+)/i),
  );
  return compactMetadataWithSource({
    pieces,
    pallets,
    weight: normalizedWeight,
    weightUom,
    dimensions: dims,
    dims,
    commodity,
    contents: first(tms.contents, active.contents, brain.contents, commodity),
    source: "canonical-shipment-pipeline",
  });
}

function etaTextExplicitlyUnknown(text) {
  return /\b(?:eta|arrival(?:\s+date)?)\b[^.;\n]{0,40}\b(?:is\s+)?(?:unconfirmed|unknown|tbd|to be confirmed|not (?:yet )?confirmed)\b/i.test(String(text || ""));
}

function dateMatchLooksRoutingContext(text, match) {
  if (!match || typeof match.index !== "number") return false;
  const windowStart = Math.max(0, match.index - 60);
  const before = String(text).slice(windowStart, match.index + match[0].length - String(match[1] || "").length);
  return /\b(?:routed|routing|reroute[d]?|transfer(?:red|ring)?|truck(?:ed|ing)?|linehaul|t\d{3,5})\b/i.test(before);
}

function etaFactCandidates(facts = []) {
  const rows = [...facts].sort((a, b) => eventTime(b.at) - eventTime(a.at));
  const candidates = [];
  for (const fact of rows) {
    // Generated gate/canonical facts are the pipeline's OWN previous output.
    // Reading ETA back out of them created a self-perpetuating feedback loop
    // (INC-2026-07-05-ETA-SELF-FEEDBACK): the value could never be superseded.
    if (generatedGateFact(fact)) continue;
    const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
    if (!/\b(?:arrival|arrive|eta|planned|expected|departed|departure)\b/i.test(text)) continue;
    if (etaTextExplicitlyUnknown(text)) continue;
    const arrivalDated = text.match(/\b(?:arrival|arrive|eta)\b[^.;\n]{0,100}\b((?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?(?:\s+\d{1,2}:\d{2})?)\b/i) ||
      text.match(/\b(?:arrival|arrive|eta)\b[^.;\n]{0,100}\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[a-z]*\s*\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{4}(?:\s+\d{1,2}:\d{2})?)\b/i);
    if (arrivalDated && !dateMatchLooksRoutingContext(text, arrivalDated)) {
      candidates.push({ value: arrivalDated[1].replace(/\s+/g, " "), observedAt: eventTime(fact.at), source: fact.source || fact.type || "email-fact" });
      continue;
    }
    if (/\b(?:departed|departure)\b/i.test(text)) continue;
    const dashed = text.match(/\b(?:ETA\s*)?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?[a-z]*\s*(\d{1,2}[-\s](?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[-\s]\d{4}(?:\s+\d{1,2}:\d{2})?)\b/i);
    if (dashed && !dateMatchLooksRoutingContext(text, dashed)) {
      candidates.push({ value: dashed[1].replace(/\s+/g, " "), observedAt: eventTime(fact.at), source: fact.source || fact.type || "email-fact" });
      continue;
    }
    const named = text.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?(?:\s+\d{1,2}:\d{2})?)\b/i);
    if (named && !dateMatchLooksRoutingContext(text, named)) {
      candidates.push({ value: named[1].replace(/\s+/g, " "), observedAt: eventTime(fact.at), source: fact.source || fact.type || "email-fact" });
    }
  }
  return candidates;
}

function etaFromFacts(facts = []) {
  return etaFactCandidates(facts)[0]?.value || "";
}

const RELATIVE_WEEKDAY_ETA_PATTERN = /^(?:arrive|arrival|recover|eta|depart)?\s*(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\.?\s+(\d{1,2}):(\d{2})\s*([ap]m)?$/i;
const RELATIVE_WEEKDAY_ETA_SEARCH_PATTERN = /\b((?:arrive|arrival|recover|eta)\s+(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\.?\s+\d{1,2}:\d{2}\s*(?:[ap]m)?)\b/i;
const ETA_WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function relativeWeekdayEtaParts(value) {
  return String(value || "").trim().match(RELATIVE_WEEKDAY_ETA_PATTERN);
}

function relativeWeekdayEtaCandidate(value) {
  const text = String(value || "").trim();
  if (relativeWeekdayEtaParts(text)) return text;
  const match = text.match(RELATIVE_WEEKDAY_ETA_SEARCH_PATTERN);
  const candidate = match?.[1]?.trim() || "";
  return relativeWeekdayEtaParts(candidate) ? candidate : "";
}

function resolveRelativeWeekdayEta(value, anchorMs) {
  const parts = relativeWeekdayEtaParts(value);
  if (!parts || !Number.isFinite(anchorMs) || anchorMs <= 0) return null;
  const day = ETA_WEEKDAY_INDEX[parts[1].slice(0, 3).toLowerCase()];
  if (!Number.isFinite(day)) return null;
  const anchor = new Date(anchorMs);
  const resolved = new Date(anchor);
  // A relative weekday label is scoped to the record's own week, not "next
  // occurrence forever." Sat -> MON is upcoming; Tue still showing MON is a
  // missed/past label and must not silently roll into next week.
  const forwardDays = (day - anchor.getDay() + 7) % 7;
  const backwardDays = forwardDays === 0 ? 0 : forwardDays - 7;
  resolved.setDate(anchor.getDate() + (Math.abs(backwardDays) < Math.abs(forwardDays) ? backwardDays : forwardDays));
  let hour = Number(parts[2]);
  if (parts[4] && /pm/i.test(parts[4]) && hour < 12) hour += 12;
  if (parts[4] && /am/i.test(parts[4]) && hour === 12) hour = 0;
  resolved.setHours(hour, Number(parts[3]), 0, 0);
  return resolved;
}

function placeholderEtaText(value) {
  return /^no eta\b/i.test(String(value || "").trim());
}

function carrierTrackingRowFor(memory = {}, awb = "") {
  const key = normalizeAwb(awb);
  if (!key) return null;
  const byAwb = memory.carrierTracking?.byAwb;
  if (byAwb && typeof byAwb === "object") return byAwb[key] || null;
  return null;
}

function carrierEventDateText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/\s*\/\s*/g, " ").replace(/\s+/g, " ").trim();
}

function carrierEventTimestamp(row = {}) {
  const event = row.latestEvent || {};
  const finalArrival = row.finalArrivalEvent || {};
  const candidates = [
    event.actualArrival,
    finalArrival.actualArrival,
    event.timeLocal,
    event.time,
    event.scheduledArrival,
    row.actualArrival,
    row.scheduledArrival,
    row.eta,
    row.snapshotTime,
  ];
  for (const candidate of candidates) {
    const normalized = carrierEventDateText(candidate);
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return row.snapshotTime || "";
}

function carrierTrackingStatusText(row = {}) {
  const event = row.latestEvent || {};
  const finalArrival = row.finalArrivalEvent || {};
  return [
    row.status,
    row.summaryStatus,
    row.code,
    row.summaryCode,
    event.code,
    event.status,
    event.description,
    finalArrival.code,
    finalArrival.description,
  ].filter(Boolean).join(" ");
}

function carrierTrackingArrivalStatus(row = {}) {
  const text = carrierTrackingStatusText(row);
  if (/\b(?:AWD|RCF|ARR|NFD)\b/i.test(text)) return true;
  return /\b(?:ready for pickup|available for pickup|freight available|cargo available|received from flight|arrived|arrival|notified)\b/i.test(text) &&
    !/\b(?:not arrived|not available|no result|tracking failed|departed|departure only)\b/i.test(text);
}

function carrierTrackingAirportPickupStatus(row = {}) {
  const text = carrierTrackingStatusText(row);
  return /\b(?:DLV|delivered to consignee|delivered to agent|delivered\/released|released to consignee|picked up from airline|freight delivered)\b/i.test(text) &&
    !/\b(?:not delivered|delivery pending|scheduled)\b/i.test(text);
}

function carrierTrackingFactsFor(memory = {}, awb = "") {
  const row = carrierTrackingRowFor(memory, awb);
  if (!row || typeof row !== "object") return [];
  const facts = [];
  const at = carrierEventTimestamp(row);
  const event = row.latestEvent || {};
  const station = first(event.station, row.station, row.destination);
  const status = first(row.status, event.code, row.summaryStatus);
  const description = first(event.description, row.summaryStatus, row.status);
  const suffix = [station ? `at ${station}` : "", status ? `(${status})` : ""].filter(Boolean).join(" ");
  if (carrierTrackingArrivalStatus(row)) {
    facts.push({
      type: "carrier-arrival-confirmed",
      label: "Carrier arrival",
      summary: `Carrier tracking says cargo is ${description || "available at destination"}${suffix ? ` ${suffix}` : ""}.`,
      evidence: [description, status, station, first(event.timeLocal, event.actualArrival, row.eta, row.scheduledArrival)].filter(Boolean).join(" · "),
      at,
      source: row.source || "carrier-tracking",
      confidence: "high",
    });
  }
  if (carrierTrackingAirportPickupStatus(row)) {
    facts.push({
      type: "carrier-airport-pickup-confirmed",
      label: "Carrier airport release",
      summary: `Carrier tracking says the cargo left airline custody${suffix ? ` ${suffix}` : ""}; final delivery/POD still needs independent proof.`,
      evidence: [description, status, station, first(event.timeLocal, row.eta, row.scheduledArrival)].filter(Boolean).join(" · "),
      at,
      source: row.source || "carrier-tracking",
      confidence: "high",
    });
  }
  return facts;
}

function factRowsForGroup(group, memory = {}) {
  return dedupeFacts([
    ...collectFactRows(group),
    ...carrierTrackingFactsFor(memory, group?.awb),
  ]);
}

// Compact per-AWB index over carrier tracking snapshots (united/elal/other),
// so canonical truth can see the carrier's dated ETA in BOTH the local and the
// hosted cron rebuild (INC-2026-07-05: production was structurally blind to
// the only source that held the real ETA). Newest row per AWB wins.
function carrierTrackingIndex(snapshots = []) {
  const byAwb = {};
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot !== "object") continue;
    const snapshotTime = snapshot.snapshotTime || "";
    for (const row of array(snapshot.tracking)) {
      const key = normalizeAwb(row?.awb);
      if (!key) continue;
      const rowTime = row.snapshotTime || snapshotTime;
      const existing = byAwb[key];
      if (existing && eventTime(existing.snapshotTime) >= eventTime(rowTime)) continue;
      byAwb[key] = {
        awb: row.awb,
        eta: row.eta || "",
        scheduledArrival: row.scheduledArrival || "",
        status: row.status || "",
        summaryStatus: row.summaryStatus || "",
        code: row.code || "",
        summaryCode: row.summaryCode || "",
        carrier: row.carrier || snapshot.carrier || "",
        station: row.station || row.latestEvent?.station || row.finalArrivalEvent?.station || "",
        destination: row.destination || row.latestEvent?.station || row.finalArrivalEvent?.station || "",
        latestEvent: row.latestEvent || null,
        finalArrivalEvent: row.finalArrivalEvent || null,
        snapshotTime: rowTime,
        source: snapshot.source || "carrier-tracking",
      };
    }
  }
  return { byAwb };
}

function monthDayEtaCandidateValue(raw) {
  const parsed = parsedEtaCandidate(raw, { requireContext: false });
  return parsed ? parsed : null;
}

// Source-aware ETA selection (INC-2026-07-05-ETA-SELF-FEEDBACK): candidates
// carry {value, source, observedAt}. Dated carrier tracking outranks narrative
// extraction and TMS labels; the previous cycle's own published eta is a
// last-resort cache tier and is always superseded by any live dated source.
function canonicalEtaSelection({ facts = [], audit = {}, active = {}, brain = {}, tracking = {}, tms = {}, memory = {}, awb = "", now = null } = {}) {
  const nowMs = eventTime(now) || (now instanceof Date ? now.getTime() : 0) || Date.now();
  // Arrival EVIDENCE means positive arrival phrasing from a real source —
  // the mere word "arrival" ("waiting: not applicable before destination
  // arrival") or the pipeline's own canonical gate facts must not count
  // (production 016-80000165: a fees-gate waiting note suppressed the roll).
  const arrivalEvidence = facts.some((fact) => {
    const type = String(fact?.type || "");
    if (/^canonical-/.test(type)) return false;
    const text = `${type} ${fact?.claim || fact?.summary || fact?.evidence || ""}`;
    return /\b(?:arrived|arrival confirmed|destination arrival confirmed|arrival notice|notice of arrival|on[- ]hand|freight (?:is )?(?:available|on hand)|noa)\b/i.test(text) &&
      !/\b(?:not[- ]arriv|not-arrived|no on[- ]hand|not on[- ]hand|not (?:yet )?(?:available|on hand)|before (?:destination )?arrival)\b/i.test(text);
  });
  // The weekday label can live in tms.eta OR only in the flight-detail hint
  // (production 016-80000165: tms.eta empty, etaHint "ARRIVE MON 10:15").
  // Resolve it exactly the way the publisher does, so the selection sees the
  // same label the published row will carry.
  let relativeLabel = "";
  try {
    const detailHint = metadataFlightDetails({ active, brain, tms, tracking }).etaHint || "";
    relativeLabel = [tms.eta, tms.etaHint, detailHint]
      .map((value) => String(value || "").trim())
      .find((value) => value && relativeWeekdayEtaParts(value)) || "";
  } catch {
    relativeLabel = "";
  }
  const etaNeedsVerification = (date) => !arrivalEvidence && date.getTime() < nowMs;
  const etaPastSourceStale = (date) => !arrivalEvidence && date.getTime() < nowMs - 24 * 36e5;
  const monthDayText = (date) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[date.getMonth()]} ${String(date.getDate()).padStart(2, "0")}, ${date.getFullYear()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  const hostedCarrier = carrierTrackingRowFor(memory, awb);
  const carrierRaws = [
    { raw: tracking.eta, observedAt: eventTime(tracking.snapshotTime || tracking.observedAt), source: "carrier-tracking" },
    { raw: tracking.scheduledArrival, observedAt: eventTime(tracking.snapshotTime || tracking.observedAt), source: "carrier-tracking" },
    { raw: tracking.latestEvent?.scheduledArrival, observedAt: eventTime(tracking.snapshotTime || tracking.observedAt), source: "carrier-tracking" },
    { raw: active.liveTracking?.scheduledArrival, observedAt: eventTime(active.liveTracking?.snapshotTime), source: "carrier-tracking" },
    { raw: brain.liveTracking?.scheduledArrival, observedAt: eventTime(brain.liveTracking?.snapshotTime), source: "carrier-tracking" },
    { raw: hostedCarrier?.eta, observedAt: eventTime(hostedCarrier?.snapshotTime), source: "carrier-tracking" },
    { raw: hostedCarrier?.scheduledArrival, observedAt: eventTime(hostedCarrier?.snapshotTime), source: "carrier-tracking" },
  ];
  const carrier = [];
  for (const item of carrierRaws) {
    const raw = String(item.raw || "").trim();
    if (!raw || placeholderEtaText(raw)) continue;
    const parsed = monthDayEtaCandidateValue(raw);
    if (!parsed) continue;
    carrier.push({ value: raw, at: parsed.at, observedAt: item.observedAt || 0, source: item.source });
  }
  carrier.sort((a, b) => b.observedAt - a.observedAt || b.at - a.at);

  const emailFacts = etaFactCandidates(facts)
    .map((candidate) => {
      const parsed = monthDayEtaCandidateValue(candidate.value);
      return parsed ? { value: candidate.value, at: parsed.at, observedAt: candidate.observedAt || 0, source: "email-fact" } : null;
    })
    .filter(Boolean);

  const manualRaw = String(audit?.truth?.eta || "").trim();
  const manualParsed = manualRaw && !placeholderEtaText(manualRaw) ? monthDayEtaCandidateValue(manualRaw) : null;
  const manual = manualParsed ? [{ value: manualRaw, at: manualParsed.at, observedAt: 0, source: "manual-truth" }] : [];

  const tmsRaw = String(tms.eta || "").trim();
  const tmsAnchor = eventTime(tms.etaObservedAt || active.etaObservedAt || brain.etaObservedAt);
  let tmsCandidate = null;
  let unresolvedRelative = "";
  if (tmsRaw && !placeholderEtaText(tmsRaw)) {
    if (relativeWeekdayEtaParts(tmsRaw)) {
      const resolved = resolveRelativeWeekdayEta(tmsRaw, tmsAnchor);
      if (resolved) {
        // A weekday label is a dated observation from the record's own stamp.
        // Once it is past and no arrival proof exists, we keep the missed date
        // as an overdue verification signal. Rolling it forward invented a new
        // future ETA and hid arrived freight (016-80000168 / UA AWD).
        const overdue = etaNeedsVerification(resolved);
        const staleSource = etaPastSourceStale(resolved);
        tmsCandidate = { value: monthDayText(resolved), at: resolved.getTime(), observedAt: tmsAnchor, source: staleSource ? "tms-task-label-past" : "tms-task-label", etaPastUnverified: overdue };
      } else {
        unresolvedRelative = tmsRaw;
      }
    } else {
      const parsed = monthDayEtaCandidateValue(tmsRaw);
      if (parsed) tmsCandidate = { value: tmsRaw, at: parsed.at, observedAt: tmsAnchor || 0, source: "tms" };
    }
  }

  const cachedRaws = [
    { raw: active.eta, source: "cached-previous-truth" },
    { raw: brain.eta, source: "cached-previous-truth" },
  ];
  const cached = [];
  for (const item of cachedRaws) {
    const raw = String(item.raw || "").trim();
    if (!raw || placeholderEtaText(raw) || relativeWeekdayEtaParts(raw)) continue;
    const parsed = monthDayEtaCandidateValue(raw);
    // The cache tier is the previous cycle's own output. When that date is
    // >24h past, arrival is unproven, and the still-current TMS label is a
    // relative weekday MATCHING the cached date's weekday, the cached value
    // is a stale resolution of that same recurring run — roll it forward
    // instead of republishing a known-missed date forever (016-80000165:
    // "Jun 29" self-perpetuated via this tier while the label said MON).
    if (parsed && relativeLabel && !arrivalEvidence && parsed.at < nowMs - 24 * 36e5) {
      const labelResolved = resolveRelativeWeekdayEta(relativeLabel, parsed.at);
      if (labelResolved && new Date(parsed.at).getDay() === labelResolved.getDay()) {
        cached.push({ value: monthDayText(labelResolved), at: labelResolved.getTime(), observedAt: 0, source: "cached-previous-truth-past", etaPastUnverified: true });
        continue;
      }
    }
    const originalSource = first(active.etaSource, brain.etaSource);
    if (
      parsed &&
      parsed.at > nowMs &&
      relativeLabel &&
      !arrivalEvidence &&
      !/\bcarrier-tracking\b/i.test(originalSource) &&
      /\b(?:cached-previous-truth|rolled|tms-task-label)\b/i.test(originalSource || item.source)
    ) {
      continue;
    }
    cached.push({ value: raw, at: parsed ? parsed.at : NaN, observedAt: 0, source: item.source });
  }

  const tiers = [carrier, emailFacts, manual, tmsCandidate ? [tmsCandidate] : [], cached];
  let winner = null;
  for (const tier of tiers) {
    const dated = tier.filter((candidate) => Number.isFinite(candidate.at));
    if (dated.length) {
      winner = dated[0];
      break;
    }
  }
  if (!winner) {
    for (const tier of tiers) {
      if (tier.length) {
        winner = tier[0];
        break;
      }
    }
  }

  let conflict = "";
  if (winner && winner.source === "carrier-tracking" && Number.isFinite(winner.at)) {
    const disagreeing = emailFacts.find((candidate) =>
      Number.isFinite(candidate.at) && Math.abs(candidate.at - winner.at) > 24 * 36e5);
    if (disagreeing) {
      conflict = `Carrier tracking shows ${winner.value}; email evidence says ${disagreeing.value}.`;
    }
  }
  if (!winner && unresolvedRelative) {
    return {
      eta: unresolvedRelative,
      etaSource: "tms-task-label",
      etaConflict: "",
      etaUnresolvedRelative: true,
    };
  }
  return {
    eta: winner ? etaTextWithYear(winner.value) : "",
    etaSource: winner ? winner.source : "",
    etaConflict: conflict,
    etaUnresolvedRelative: false,
    etaPastUnverified: Boolean(winner && winner.etaPastUnverified),
    etaRolledFrom: winner && winner.rolledFrom ? winner.rolledFrom : "",
  };
}

function stationContactFor(memory, airport, airline, group) {
  const airportKey = String(airport || "").toUpperCase();
  const airlineKey = String(airline || "").toLowerCase();
  const contacts = array(memory.stationMemory?.contacts);
  const byAirport = contacts.find((contact) => {
    const text = `${contact.airport || ""} ${contact.station || ""} ${contact.name || ""} ${contact.label || ""}`.toUpperCase();
    const carrier = `${contact.airline || ""} ${contact.carrier || ""} ${contact.name || ""}`.toLowerCase();
    const explicitCarrier = `${contact.airline || ""} ${contact.carrier || ""}`.toLowerCase().trim();
    const carrierMatches = !airlineKey ||
      !explicitCarrier ||
      explicitCarrier === airlineKey ||
      explicitCarrier.includes(airlineKey) ||
      airlineKey.includes(explicitCarrier);
    return airportKey && text.includes(airportKey) && carrierMatches && (!contact.airline || carrier.includes(explicitCarrier));
  });
  // Station-memory entries store stationEmail/stationPhone; downstream reads
  // contact.email/contact.phone. Without this normalization a taught contact
  // matched but published NOTHING (INC-2026-07-05-STATION-MEMORY-SAVE).
  if (byAirport) {
    return {
      ...byAirport,
      email: contactField(byAirport, "email", "stationEmail", "contactEmail"),
      phone: contactField(byAirport, "phone", "stationPhone", "contactPhone"),
    };
  }

  const facts = collectFactRows(group).map((fact) => fact.summary).join(" ");
  const email = facts.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0] || "";
  const phone = validPhone(facts.match(/\+?\d[\d().\-\s]{8,}\d/)?.[0] || "", group.awb);
  if (!email && !phone) return null;
  return { airport, airline, email, phone };
}

function validPhone(value, awb = "") {
  const text = String(value || "").trim();
  const digits = text.replace(/\D/g, "");
  if (digits && digits === normalizeAwb(awb)) return "";
  if (digits.length < 10) return "";
  if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(text) || /^\d{8}$/.test(digits)) return "";
  return text;
}

function contactField(contact, ...keys) {
  for (const key of keys) {
    const value = String(contact?.[key] || "").trim();
    if (value && !/^(not found|n\/a|unknown)$/i.test(value)) return value;
  }
  return "";
}

function stationContactFromRecord(record) {
  const contacts = record?.contacts?.station || {};
  const rawStationContext = record?.stationContext?.stations?.[0] || record?.stationContext || {};
  const contextCarrier = String(rawStationContext.airline || rawStationContext.carrier || "").toLowerCase().trim();
  const recordCarrier = String(record?.airline || "").toLowerCase().trim();
  const stationContext = !contextCarrier || !recordCarrier || contextCarrier === recordCarrier || contextCarrier.includes(recordCarrier) || recordCarrier.includes(contextCarrier)
    ? rawStationContext
    : {};
  const customs = record?.customsBroker || {};
  const stationEmail = contactField(contacts, "email", "stationEmail", "contactEmail") ||
    contactField(stationContext, "stationEmail", "email", "contactEmail") ||
    (/station|cargo|airline|handoff/i.test(`${customs.broker || ""} ${customs.status || ""}`)
      ? contactField(customs, "contactEmail", "email")
      : "");
  const stationPhone = validPhone(
    contactField(contacts, "phone", "stationPhone", "contactPhone") ||
      contactField(stationContext, "stationPhone", "phone", "contactPhone") ||
      contactField(customs, "contactPhone", "phone"),
    record?.awb || record?.id,
  );
  const name = contactField(contacts, "handlerName", "stationName", "name", "label") ||
    contactField(stationContext, "handlerName", "stationName", "name", "label") ||
    (/station|cargo|airline|handoff/i.test(`${customs.broker || ""} ${customs.status || ""}`)
      ? contactField(customs, "broker", "contactName")
      : "");
  if (!stationEmail && !stationPhone && !name) return null;
  return {
    airport: record?.station || record?.airport || stationContext.airport || "",
    airline: record?.airline || stationContext.airline || "",
    name,
    email: stationEmail,
    phone: stationPhone,
  };
}

function stationContextProvenanceFromRecord(record = {}, stationContact = {}) {
  stationContact = stationContact || {};
  const context = record?.stationContext || {};
  const memory = context.stationMemory || {};
  const stations = Array.isArray(context.stations) ? context.stations : [];
  const source = context.source || memory.source || (stations.length ? "Known PQ station memory" : "");
  const rememberedAt = context.rememberedAt || memory.rememberedAt || memory.updatedAt || "";
  if (!source && !rememberedAt && !stations.length) return null;
  const compactStations = stations.slice(0, 3).map((station) => ({
    id: station.id || "",
    airport: station.airport || "",
    airline: station.airline || station.carrier || "",
    stationName: station.stationName || station.name || "",
    stationEmail: station.stationEmail || station.email || "",
    stationPhone: station.stationPhone || station.phone || "",
    contactSource: station.contactSource || station.source?.note || "",
  }));
  return {
    source,
    rememberedAt,
    stationEmail: context.stationEmail || context.email || stationContact.email || "",
    stationPhone: context.stationPhone || context.phone || stationContact.phone || "",
    handlerName: context.handlerName || context.stationName || stationContact.name || "",
    stationMemory: source || rememberedAt
      ? {
          source,
          rememberedAt,
          confidence: memory.confidence || context.confidence || "",
        }
      : undefined,
    stations: compactStations,
  };
}

function stationConfirmationAction(metadata = {}, { etaPassed = false } = {}) {
  if (etaPassed) return "ETA passed — confirm arrival / on-hand with the station.";
  const contact = metadata.stationContact || {};
  const airport = metadata.airport || metadata.station || "";
  const airline = metadata.airline || "";
  const stationName =
    contactField(contact, "handlerName", "stationName", "name", "label") ||
    [airline, airport].filter(Boolean).join(" ") ||
    "station";
  const phone = contactField(contact, "stationPhone", "phone", "contactPhone");
  const email = contactField(contact, "stationEmail", "email", "contactEmail");
  const question = "confirm station availability, on-hand status, storage, piece count, and pickup availability";

  if (phone) {
    return `Call ${stationName} at ${phone} to ${question}.${email ? ` If they do not answer, email ${email}.` : ""}`;
  }
  if (email) {
    return `Email ${stationName} at ${email} to ${question}; add the station phone when you get it.`;
  }
  return `Station contact is missing for ${[airport, airline].filter(Boolean).join(" / ") || "this shipment"}; add phone/email, then ${question}.`;
}

function formatAwb(awb) {
  const text = normalizeAwb(awb);
  if (text.length === 11) return `${text.slice(0, 3)}-${text.slice(3)}`;
  return text;
}

function auditPhaseToCanonical(row) {
  const truth = row?.truth || {};
  const phase = String(truth.shipmentPhase || "").toLowerCase();
  const text = [
    truth.arrival,
    truth.customs,
    truth.groundFees,
    truth.dispatch,
    truth.pickup,
    truth.delivery,
    truth.pod,
    truth.currentOperationalState,
    truth.operatorNextAction,
  ].filter(Boolean).join(" ");
  const gates = {
    arrival: gate("arrival", "waiting", truth.arrival),
    customs: gate("customs", "waiting", truth.customs),
    fees: gate("fees", "waiting", truth.groundFees),
    dispatch: gate("dispatch", "waiting", truth.dispatch),
    pickup: gate("pickup", "waiting", truth.pickup),
    delivery: gate("delivery", "waiting", truth.delivery),
    pod: gate("pod", "waiting", truth.pod),
  };

  if (/^(?:in-transit|prealert|booking|inbond|do-attached|released-pre-arrival)/.test(phase)) {
    gates.arrival = gate("arrival", "not-arrived", etaTextWithYear(truth.arrival || truth.eta));
    gates.pickup = gate("pickup", "waiting", truth.pickup || "not picked up");
    gates.delivery = gate("delivery", "waiting", truth.delivery || "not delivered");
    gates.pod = gate("pod", "waiting", truth.pod || "not applicable");
  }
  if (phase === "released-pre-arrival") gates.customs = gate("customs", "done", truth.customs);
  if (phase === "do-attached-pre-arrival-clearance-pending") gates.customs = gate("customs", "pending", truth.customs);
  if (phase === "released-arrival-pending") {
    gates.arrival = gate("arrival", "pending", truth.arrival);
    gates.customs = gate("customs", "done", truth.customs);
    gates.pickup = gate("pickup", "waiting", truth.pickup);
    gates.delivery = gate("delivery", "waiting", truth.delivery);
    gates.pod = gate("pod", "waiting", truth.pod);
  }
  if (phase === "arrival-due-release-sent-pickup-planned") {
    gates.arrival = gate("arrival", "pending", truth.arrival);
    gates.customs = gate("customs", /release|clear|1c/i.test(truth.customs || "") ? "done" : "pending", truth.customs);
    gates.dispatch = gate("dispatch", "planned", truth.dispatch);
    gates.pickup = gate("pickup", "waiting", truth.pickup);
    gates.delivery = gate("delivery", "waiting", truth.delivery);
    gates.pod = gate("pod", "waiting", truth.pod);
  }
  if (/^arrived/.test(phase)) {
    gates.arrival = gate("arrival", phase === "arrived-station-exception" ? "incomplete" : "done", truth.arrival);
    gates.customs = gate("customs", /customs-hold|hold|exam/.test(phase) || /hold|exam/i.test(truth.customs || "") ? "blocked" : /release|clear|1c|posted/i.test(truth.customs || "") ? "done" : "pending", truth.customs);
    gates.fees = gate("fees", feeStatus(truth.groundFees), truth.groundFees);
    gates.dispatch = gate("dispatch", dispatchStatus(truth.dispatch), truth.dispatch);
    gates.pickup = gate("pickup", pickupStatus(truth.pickup), truth.pickup);
    gates.delivery = gate("delivery", deliveredStatus(truth.delivery), truth.delivery);
    gates.pod = gate("pod", podStatus(truth.pod, truth.delivery), truth.pod);
  }
  if (phase === "arrived-customs-hold-storage-accruing") {
    gates.pickup = gate("pickup", "waiting", truth.pickup || "not picked up");
    gates.delivery = gate("delivery", "waiting", truth.delivery || "not delivered");
    gates.pod = gate("pod", "waiting", truth.pod || "not applicable");
  }
  if (phase === "delivered-pod-pending") {
    gates.arrival = gate("arrival", "done", truth.arrival);
    gates.customs = gate("customs", /hold|not released/i.test(truth.customs || "") ? "pending" : "done", truth.customs);
    gates.fees = gate("fees", feeStatus(truth.groundFees), truth.groundFees);
    gates.dispatch = gate("dispatch", "done", truth.dispatch);
    gates.pickup = gate("pickup", "done", truth.pickup);
    gates.delivery = gate("delivery", "delivered", truth.delivery);
    gates.pod = gate("pod", "pending", truth.pod);
  }

  const canonicalPhase = canonicalPhaseFromAuditPhase(phase);
  return {
    phase: canonicalPhase,
    label: truth.currentOperationalState || canonicalPhase,
    summary: truth.currentOperationalState || "",
    nextAction: truth.operatorNextAction || nextActionFromGates(gates),
    gates,
    storage: storageFromText(`${truth.groundFees || ""} ${truth.operatorNextAction || ""}`),
    exceptions: exceptionsFromText(text, phase),
    confidence: truth.confidence || "high",
    source: "shipment-truth-audit",
    updatedAt: row?.gmailAudit?.updatedAt || "",
  };
}

function canonicalPhaseFromAuditPhase(phase) {
  if (/^in-transit|^prealert|^booking|^inbond|^do-attached|^released-pre-arrival/.test(phase)) return "pre-arrival";
  if (phase === "released-arrival-pending" || phase === "arrival-due-release-sent-pickup-planned") return "pre-arrival";
  if (phase === "arrived-customs-hold-storage-accruing") return "customs-hold";
  if (phase === "arrived-station-exception") return "arrival-incomplete";
  if (phase === "arrived-released-pickup-ready") return "dispatch-ready";
  if (phase === "arrived-released-dispatch-sent-pickup-pending") return "dispatch-sent";
  if (phase === "arrived-released-pickup-pending") return "ready-for-pickup";
  if (phase === "delivered-pod-pending") return "delivered-pod-pending";
  return phase || "open";
}

// Gate summaries render as "status: evidence" and get re-ingested as next
// cycle's gate EVIDENCE — with an empty evidence the seed became
// "pending: pending" and every cron cycle prepended another "pending: ",
// growing the string (and rewriting the snapshot) forever. Strip any echoed
// status prefixes so the text is a fixed point.
function collapseStatusEcho(status, text) {
  const clean = String(text || "").trim();
  const label = String(status || "").trim();
  if (!clean || !label) return clean;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = clean.replace(new RegExp(`^(?:${escaped}:\\s*)+`, "i"), "").trim();
  return stripped.toLowerCase() === label.toLowerCase() ? "" : stripped;
}

function gate(name, status, evidence, extra = {}) {
  const cleanEvidence = collapseStatusEcho(status, evidence);
  return {
    name,
    status,
    label: name,
    evidence: cleanEvidence || status,
    confidence: extra.confidence || "high",
    source: extra.source || "canonical-pipeline",
    at: extra.at || "",
    ...extra,
  };
}

function feeStatus(text) {
  const value = String(text || "");
  const uncertainty = /not applicable|before .*arrival|unknown|not proven|not confirmed|no .*proof|status not proven|verify/i.test(value);
  const directDue = /\b(?:due|unpaid|past due|balance|invoice|charges?|storage begins|storage starts|storage accru|last free|lfd|import service charge)\b/i.test(value);
  if (uncertainty && !directDue) return "waiting";
  if (/paid|payment.*(?:proven|confirmed)|proof|receipt/i.test(value) && !/not proven|not confirmed|unknown|due|verify/i.test(value)) return "done";
  if (directDue || /\b(?:ground fees?|handling fees?|station fees?|warehouse fees?|\bisc\b)\b/i.test(value) && /\b(?:pay|confirm|verify|not confirmed|not proven)\b/i.test(value)) return "due";
  return "waiting";
}

function dispatchStatus(text) {
  const value = String(text || "");
  if (/no .*dispatch|not proven|no .*award|not awarded|pending|do not dispatch/i.test(value)) return "waiting";
  if (/sent|alert|handled|awarded|assigned|expected to pick up|told.*pick|on their way|release sent/i.test(value)) return "sent";
  return "waiting";
}

function pickupStatus(text) {
  const value = String(text || "");
  if (/not picked up|pickup pending|no pickup|not proven|no .*pickup|not driver onsite|not recovered|do not dispatch/i.test(value)) return "pending";
  if (/picked up|loaded|recovered|driver left/i.test(value)) return "done";
  return "pending";
}

function deliveredStatus(text) {
  const value = String(text || "");
  if (/not delivered|no delivery|delivery pending|not proven/i.test(value)) return "waiting";
  if (/delivered|delivery completed|completed delivery/i.test(value)) return "delivered";
  return "waiting";
}

function podStatus(podText, deliveryText) {
  const text = `${podText || ""} ${deliveryText || ""}`;
  if (/not applicable|not delivered|no delivery|before delivery/i.test(text)) return "waiting";
  if (/signed pod|pod received|pod found|proof.*received|accepted/i.test(text) && !/pending|missing|not/i.test(text)) return "done";
  if (/pod.*pending|signed pod.*pending|proof.*pending|not received|missing|collect/i.test(text)) return "pending";
  if (/delivered/i.test(deliveryText || "")) return "pending";
  return "waiting";
}

function storageFromText(text) {
  const value = String(text || "");
  const starts = value.match(/\bstorage (?:begins|starts)\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2})\b/i)?.[1] || "";
  const accruing = value.match(/\bstorage accru(?:ing|es)? since\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2})\b/i)?.[1] || "";
  const lfd = value.match(/\b(?:lfd|last free(?: day)?)\s*(?:is|:)?\s*(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2})\b/i)?.[1] || "";
  const rate = value.match(/(?:USD\s*)?\$?\d[\d,]*(?:\.\d+)?\s*\/\s*(?:day|d)\b/i)?.[0] || "";
  if (!starts && !accruing && !lfd && !rate) return null;
  return {
    status: accruing ? "accruing" : starts || lfd ? "known" : "rate-known",
    lastFreeDay: lfd,
    storageStartsAt: starts,
    storageAccruingSince: accruing,
    dailyStorageRate: rate.replace(/\s+/g, ""),
    evidence: [compact(value, 220)],
    source: "canonical-pipeline",
  };
}

// Date TEXT must be canonical: "Jul 1" and "Jul 1, 2026" are the same truth, but
// emitting both (raw TMS text vs normalized fact extraction) made consecutive
// cron cycles flip the rendering — and every flip rewrote the whole multi-MB
// truth snapshot. Bare month-day dates always carry the year.
function etaTextWithYear(value, now = new Date()) {
  const text = String(value || "").trim();
  if (/^(?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?$/i.test(text)) {
    return `${text}, ${now.getFullYear()}`;
  }
  return text;
}

function parsedOperationalDate(value, now = new Date()) {
  const raw = String(value || "").trim();
  if (!raw) return NaN;
  const withYear = /^[A-Z][a-z]{2,8}\s+\d{1,2}$/i.test(raw) ? `${raw}, ${now.getFullYear()}` : raw;
  const parsed = Date.parse(withYear);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function daysUntilOperationalDate(value, now = new Date()) {
  const parsed = parsedOperationalDate(value, now);
  if (!Number.isFinite(parsed)) return Infinity;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const date = new Date(parsed);
  const startOfValue = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.ceil((startOfValue - startOfToday) / 86400000);
}

function hoursSinceOperationalDate(value, now = new Date()) {
  const parsed = parsedOperationalDate(value, now);
  if (!Number.isFinite(parsed)) return Infinity;
  return Math.max(0, (now.getTime() - parsed) / 36e5);
}

function normalizeEtaDateText(value) {
  const normalized = String(value || "")
    .replace(/\b(\d{1,2}:\d{2})\s*([AP])\.?M\.?\b/gi, "$1 $2M")
    .replace(/\s*\/\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(?:Jan|Feb|Mar|Apr|May|Jun|June|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?$/i.test(normalized)) {
    return `${normalized}, ${new Date().getFullYear()}`;
  }
  return normalized;
}

const ETA_MONTH_NAME_PATTERN = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

function parsedEtaCandidate(value, { requireContext = false, anchorMs = NaN } = {}) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const context = /\b(?:eta|expected|recover(?:y)?|arr\/dept|arrival date|arrives?|scheduled arrival|flight)\b/i.test(text);
  if (requireContext && !context) return null;
  const relativeCandidate = relativeWeekdayEtaCandidate(text);
  if (relativeCandidate && Number.isFinite(anchorMs) && anchorMs > 0) {
    const resolved = resolveRelativeWeekdayEta(relativeCandidate, anchorMs);
    return resolved ? { raw: relativeCandidate, at: resolved.getTime() } : null;
  }
  const contextPrefix = "\\b(?:eta|expected|recover(?:y)?(?:\\s+from)?|arr\\/dept|arrival date|arrives?|scheduled arrival|flight)\\b[^.;\\n]{0,120}?";
  const datePatterns = [
    `(?:mon|tue|wed|thu|fri|sat|sun)?\\.?\\s*\\d{1,2}-${ETA_MONTH_NAME_PATTERN}-20\\d{2}(?:\\s+\\d{1,2}:\\d{2}(?:\\s*[ap]m)?)?`,
    `${ETA_MONTH_NAME_PATTERN}\\s+\\d{1,2},?\\s+20\\d{2}(?:\\s+\\d{1,2}:\\d{2}(?:\\s*[ap]m)?)?`,
    `${ETA_MONTH_NAME_PATTERN}\\s+\\d{1,2}(?:\\s+\\d{1,2}:\\d{2}(?:\\s*[ap]m)?)?`,
    "20\\d{2}-\\d{2}-\\d{2}(?:\\s+\\d{1,2}:\\d{2}(?:\\s*[ap]m)?)?",
    "\\d{1,2}\\/\\d{1,2}\\/(?:20)?\\d{2}(?:\\s+\\d{1,2}:\\d{2}(?:\\s*[ap]m)?)?",
  ];
  const patterns = [
    ...datePatterns.map((pattern) => new RegExp(`${contextPrefix}(${pattern})`, "i")),
    ...(!requireContext ? datePatterns.map((pattern) => new RegExp(`\\b(${pattern})\\b`, "i")) : []),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const raw = normalizeEtaDateText(match[1]);
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return { raw, at: parsed };
    }
  }
  return null;
}

function etaDateEvidence(metadata, evidence, now = new Date()) {
  const candidates = [];
  const nowMs = now instanceof Date ? now.getTime() : eventTime(now);
  const addCandidate = (raw, source, observedAt = "", requireContext = false) => {
    const observedAtMs = eventTime(observedAt);
    const parsed = parsedEtaCandidate(raw, {
      requireContext,
      anchorMs: observedAtMs || nowMs,
    });
    if (!parsed) return;
    candidates.push({
      ...parsed,
      source,
      observedAt: observedAtMs,
      evidence: compact(raw, 220),
    });
  };
  addCandidate(metadata?.eta || "", "metadata", "", false);
  array(evidence).forEach((fact) => {
    if (generatedGateFact(fact)) return;
    const text = [
      fact.type,
      fact.label,
      fact.summary,
      fact.evidence,
    ].filter(Boolean).join(" ");
    addCandidate(text, fact.source || fact.type || "evidence", fact.observedAt || fact.at, true);
  });
  return candidates
    .filter((candidate) => Number.isFinite(candidate.at))
    .sort((a, b) => b.observedAt - a.observedAt || b.at - a.at)[0] || null;
}

function statusIs(gateValue, statuses) {
  const wanted = new Set(statuses.map((status) => String(status || "").toLowerCase()));
  return wanted.has(String(gateValue?.status || "").toLowerCase()) ||
    wanted.has(String(gateValue?.rawStatus || "").toLowerCase());
}

function normalizedFactType(fact = {}) {
  fact = fact || {};
  return String(fact.type || fact.label || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .trim();
}

function canonicalSourceFactId(fact = {}) {
  const slug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return [
    normalizeAwb(fact.awb),
    slug(fact.type || fact.label || "fact"),
    slug(fact.threadId || fact.messageId || fact.at || "fact"),
  ].filter(Boolean).join(":");
}

function latestFactByTypes(facts = [], types = []) {
  const wanted = new Set(types.map((type) => String(type || "").toLowerCase()));
  return [...facts]
    .filter((fact) => {
      const type = normalizedFactType(fact);
      if (wanted.has(type)) return true;
      const text = `${fact.type || ""} ${fact.label || ""}`;
      return types.some((candidate) => new RegExp(`\\b${String(candidate).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[-_\\s]?")}\\b`, "i").test(text));
    })
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

const MONOTONIC_UPSTREAM_CLOSURE_TYPES = Object.freeze({
  award: new Set(["broker-awarded", "pickup-broker-awarded"]),
  documents: new Set(["pickup-docs-sent"]),
  fees: new Set(["ground-fees-paid"]),
  deliverySchedule: new Set(["delivery-scheduled"]),
});

function latestCurrentExternalFactByTypes(facts = [], acceptedTypes = new Set()) {
  return [...facts]
    .filter((fact) =>
      sourceFactEligible(fact) &&
      !generatedGateFact(fact) &&
      hasExternalSourceCoordinates(fact) &&
      acceptedTypes.has(normalizedFactType(fact))
    )
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function downstreamUpstreamClosureEvidence(facts = []) {
  const matched = Object.fromEntries(
    Object.entries(MONOTONIC_UPSTREAM_CLOSURE_TYPES)
      .map(([name, types]) => [name, latestCurrentExternalFactByTypes(facts, types)]),
  );
  if (Object.values(matched).some((fact) => !fact)) return null;
  const observedAt = Object.values(matched)
    .map((fact) => factOccurredAt(fact))
    .filter(Boolean)
    .sort((a, b) => eventTime(b) - eventTime(a))[0] || "";
  return {
    matched,
    observedAt,
    sourceFactIds: Object.values(matched).map(canonicalSourceFactId).filter(Boolean),
  };
}

function latestDeliveryScheduledFact(facts = []) {
  return array(facts)
    .filter((fact) => {
      if (generatedGateFact(fact) || sourceLooksTmsOrTracking(fact)) return false;
      const typeLabel = `${fact.type || ""} ${fact.label || ""}`;
      const text = factText(fact);
      return /\bdelivery[-_\s]?scheduled\b/i.test(typeLabel) ||
        /\b(?:delivery|deliver)\b[\s\S]{0,120}\b(?:tomorrow|scheduled)\b/i.test(text) &&
          /\b(?:confirmed|yes|scheduled|will|tomorrow morning|tomorrow afternoon)\b/i.test(text) &&
          !/\b(?:not delivered|delivery failed|delivery blocked|cannot deliver|can't deliver|unable to deliver|wrong consignee|wrong customer)\b/i.test(text);
    })
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function dispatchFactRank(fact = {}) {
  const type = normalizedFactType(fact);
  if (/broker-confirmed|broker-awarded/.test(type)) return 3;
  if (/\b(?:pickup-)?quote-received\b|quotes-in/.test(type)) return 2;
  if (/broker-alerted/.test(type)) return 1;
  return 0;
}

function dispatchLifecycleFact(facts = []) {
  const candidates = array(facts).filter((fact) => latestFactByTypes([fact], [
    "broker-awarded",
    "broker-confirmed",
    "broker-alerted",
    "pickup-quote-received",
    "quote-received",
    "quotes-in",
  ]));
  return candidates
    .sort((a, b) => dispatchFactRank(b) - dispatchFactRank(a) || eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function dispatchStatusFromLifecycleFact(fact = null) {
  const type = normalizedFactType(fact);
  if (!type) return "";
  if (/\b(?:pickup-)?quote-received\b|quotes-in/.test(type)) return "quote-received";
  if (/broker-alerted/.test(type)) return "broker-alerted";
  if (/broker-confirmed|broker-awarded/.test(type)) return "done";
  return "";
}

function dispatchGateFromLifecycleFact(fact = null) {
  const status = dispatchStatusFromLifecycleFact(fact);
  if (!status) return null;
  const broker = cleanDispatchBrokerName(fact.broker || fact.selectedBroker || dispatchBrokerFromText(`${fact.summary || ""} ${fact.evidence || ""}`));
  const amount = fact.amount || fact.rate || moneyAmountFromText(`${fact.summary || ""} ${fact.evidence || ""}`);
  const evidence = status === "quote-received"
    ? `${broker || "Pickup broker"} quoted${amount ? ` ${amount}` : ""}.`
    : status === "broker-alerted"
      ? `${broker || "Pickup broker"} received the pickup/inbound alert.`
      : `${broker || "Pickup broker"} is the active pickup dispatch path.`;
  return gate("dispatch", status, evidence, {
    broker,
    selectedBroker: broker,
    contactEmail: fact.contactEmail || fact.email || "",
    amount,
    at: factOccurredAt(fact),
    source: fact.source || "email-first-truth",
    confidence: fact.confidence || "high",
    lifecycleEvent: normalizedFactType(fact),
  });
}

function customsHoldEvidenceImpliesDestinationControl(gates, facts = []) {
  if (!statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])) return null;
  const blocker = authoritativeEmailReleaseBlockerFact(facts);
  const holdText = [
    gates.customs?.status,
    gates.customs?.evidence,
    blocker?.type,
    blocker?.label,
    blocker?.summary,
    blocker?.evidence,
  ].filter(Boolean).join(" ");
  const hardHold = hardCustomsHoldLanguage(holdText) ||
    /\b(?:inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|customs entry[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it)\b/i.test(holdText);
  if (!hardHold) return null;

  const holdTime = eventTime(blocker?.at || gates.customs?.at);
  const newerHardPreArrival = facts.some((fact) => {
    if (!sourceLooksEmailOrOperator(fact) || sourceLooksTmsOrTracking(fact) || generatedGateFact(fact)) return false;
    const factAt = eventTime(fact.at || fact.updatedAt || fact.createdAt);
    if (holdTime && factAt && factAt < holdTime) return false;
    const text = factText(fact);
    if (releaseBlockerLanguage(text)) return false;
    return /\b(?:not[-\s]?arrived|not at destination|in transit|flight (?:has )?not (?:arrived|landed)|awaiting noa|will await.*noa|cargo not on hand)\b/i.test(text);
  });
  if (newerHardPreArrival) return null;

  return {
    summary: "Customs/government hold evidence implies the shipment is under destination customs control.",
    at: blocker?.at || gates.customs?.at || "",
    source: blocker?.source || gates.customs?.source || "email-first-truth",
    confidence: blocker?.confidence || gates.customs?.confidence || "high",
  };
}

function riskNone() {
  return {
    level: "none",
    type: "",
    reason: "",
    action: "",
    evidence: "",
    source: "canonical-pipeline",
  };
}

function makeOperationalRisk(level, type, reason, action, evidence = "") {
  return {
    level,
    type,
    reason: compact(reason, 180),
    action: compact(action, 180),
    evidence: compact(evidence || reason, 220),
    source: "canonical-pipeline",
  };
}

function storageOperationalRisk(storage, gates, now) {
  if (!storage) return null;
  if (
    statusIs(gates.pickup, ["done", "picked-up", "loaded"]) ||
    statusIs(gates.delivery, ["delivered", "reported"]) ||
    statusIs(gates.pod, ["done", "received", "pod-found", "found"])
  ) {
    return null;
  }
  const startsDays = daysUntilOperationalDate(storage.storageStartsAt, now);
  const accruingDays = daysUntilOperationalDate(storage.storageAccruingSince, now);
  const lfdDays = daysUntilOperationalDate(storage.lastFreeDay, now);
  const active = storage.status === "accruing" || Number.isFinite(startsDays) && startsDays <= 0 || Number.isFinite(accruingDays) && accruingDays <= 0 || Number.isFinite(lfdDays) && lfdDays < 0;
  const dueSoon = !active && (Number.isFinite(startsDays) && startsDays <= 1 || Number.isFinite(lfdDays) && lfdDays <= 0);
  if (!active && !dueSoon) return null;
  const timing = storage.storageAccruingSince
    ? `Storage accruing since ${storage.storageAccruingSince}`
    : storage.storageStartsAt
      ? `Storage starts ${storage.storageStartsAt}`
      : storage.lastFreeDay
        ? `Last free day ${storage.lastFreeDay}`
        : "Storage timing is known";
  const rate = storage.dailyStorageRate ? ` at ${storage.dailyStorageRate}` : "";
  return makeOperationalRisk(
    active ? "critical" : "high",
    active ? "storage-accruing" : "storage-due",
    `${timing}${rate}.`,
    "Clear the release/fees/pickup blocker before storage grows.",
    storage.evidence?.[0] || `${timing}${rate}`,
  );
}

function existingArrivalReadyEvidence(active = {}, brain = {}, facts = []) {
  const structuredText = [
    active.status,
    brain.status,
    active.tmsStatus,
    brain.tmsStatus,
    active.tms?.status,
    brain.tms?.status,
    active.tms?.tmsStatus,
    brain.tms?.tmsStatus,
    active.deliveryStatus,
    brain.deliveryStatus,
    active.pickupStatus,
    brain.pickupStatus,
    active.liveTracking?.status,
    brain.liveTracking?.status,
    active.liveTracking?.code,
    brain.liveTracking?.code,
    active.liveTracking?.latestEvent?.code,
    brain.liveTracking?.latestEvent?.code,
    active.liveTracking?.latestEvent?.description,
    brain.liveTracking?.latestEvent?.description,
    active.liveTracking?.finalArrivalEvent?.code,
    brain.liveTracking?.finalArrivalEvent?.code,
    active.tracking?.status,
    brain.tracking?.status,
    active.tracking?.latestEvent?.code,
    brain.tracking?.latestEvent?.code,
    active.tracking?.latestEvent?.description,
    brain.tracking?.latestEvent?.description,
    active.freightBroker?.status,
    brain.freightBroker?.status,
    active.freightBroker?.brokerStatus,
    brain.freightBroker?.brokerStatus,
    active.freightBroker?.pickupPlan,
    brain.freightBroker?.pickupPlan,
    active.freightBroker?.nextAction,
    brain.freightBroker?.nextAction,
  ].filter(Boolean).join(" ");
  const positiveArrivalReadyPattern = /\b(?:280[-\s]?ARR@DEST|ARR@DEST|\bRCF\b|\bNFD\b|arrival[-\s]?confirmed|station[-\s]?arrived|destination[-\s]?arrival[-\s]?confirmed|ready[-\s]?for[-\s]?pickup|pickup[-\s]?ready|available[-\s]?for[-\s]?pickup|cargo (?:is )?available|on[-\s]?hand|\bAWD\b)\b/i;
  const negatedArrivalReadyPattern = /\b(?:not|no(?!\s*:)|without|missing|pending|awaiting|unavailable)\b[^.;\n]{0,80}\b(?:arrival|arrived|on[-\s]?hand|available|availability|ready[-\s]?for[-\s]?pickup)\b|\b(?:arrival|arrived|on[-\s]?hand|available|availability|ready[-\s]?for[-\s]?pickup)\b[^.;\n]{0,80}\b(?:not|no(?!\s*:)|missing|pending|unavailable|not available|proof)\b/i;
  const structuredReady = evidenceClauses(structuredText).some((clause) =>
    positiveArrivalReadyPattern.test(clause) &&
      !negatedArrivalReadyPattern.test(clause)
  );
  const factReady = facts.some((fact) => !generatedGateFact(fact) && positiveArrivalEvidenceFact(fact));
  return structuredReady || factReady;
}

function existingCustomsReleaseEvidence(active = {}, brain = {}) {
  const structuredCustomsText = [
    active.customsBroker?.brokerStatus,
    active.customsBroker?.nextAction,
    ...(active.customsBroker?.evidence || []).map(factText),
    active.emailValidation?.status,
    active.emailValidation?.summary,
    active.emailValidation?.nextAction,
    ...(active.emailValidation?.proof || []).map(factText),
    ...(active.emailValidation?.events || []).map(factText),
    ...(active.gmailEvents || []).map(factText),
    ...(active.events || []).map(factText),
    brain.customsBroker?.brokerStatus,
    brain.customsBroker?.nextAction,
    ...(brain.customsBroker?.evidence || []).map(factText),
    brain.emailValidation?.status,
    brain.emailValidation?.summary,
    brain.emailValidation?.nextAction,
    ...(brain.emailValidation?.proof || []).map(factText),
    ...(brain.emailValidation?.events || []).map(factText),
    ...(brain.gmailEvents || []).map(factText),
    ...(brain.events || []).map(factText),
  ].filter(Boolean).join(" ");
  if (/\b(?:customs[-\s]?hold|exam[-\s]?hold|government hold|u\.?s\.? customs exam)\b/i.test(structuredCustomsText)) return false;
  if (/\b(?:not|no|pending|waiting|hasn'?t|has not|still)\b[^.;\n]{0,80}\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b|\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b[^.;\n]{0,80}\b(?:not|pending|waiting|missing|needed|yet)\b/i.test(structuredCustomsText)) return false;
  return releaseTextLooksFinal(structuredCustomsText);
}

function unverifiedArrivalOperationalRisk(state, metadata, evidence, now) {
  const gates = state.gates || {};
  const phase = String(state.phase || "").toLowerCase();
  if ([
    "exception",
    "customs-hold",
    "arrival-incomplete",
    "pickup-blocked",
    "loading-blocked",
    "driver-onsite",
    "pickup-onsite",
    "pickup-scheduled",
    "out-for-delivery",
    "delivered-pod-pending",
  ].includes(phase)) {
    return null;
  }
  const blockingException = openExceptionItems(state).find((item) =>
    ["needs-action", "needs-decision", "critical", "urgent"].includes(String(item.severity || "").toLowerCase()) &&
    !quietCustomsHoldException(item)
  );
  if (blockingException) return null;
  if (
    statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) ||
    statusIs(gates.delivery, ["delivered", "reported"]) ||
    statusIs(gates.pod, ["done", "received", "pod-found", "found"]) ||
    statusIs(gates.arrival, ["done", "arrived", "available", "on-hand", "incomplete", "blocked", "partial"])
  ) {
    return null;
  }
  const eta = etaDateEvidence(metadata, evidence, now);
  if (!eta) return null;
  const hoursPastEta = (now.getTime() - eta.at) / 36e5;
  if (!Number.isFinite(hoursPastEta) || hoursPastEta < 24) return null;
  const level = hoursPastEta >= 48 ? "critical" : "high";
  const elapsed = hoursPastEta >= 24 ? `${Math.floor(hoursPastEta / 24)}d` : `${Math.floor(hoursPastEta)}h`;
  return makeOperationalRisk(
    level,
    "arrival-unverified",
    `ETA/recovery passed ${eta.raw} (${elapsed} ago), but no station/on-hand proof is in memory. Storage may already be accruing.`,
    stationConfirmationAction(metadata, { etaPassed: true }),
    eta.evidence,
  );
}

function operationalRiskFromState(state, metadata, evidence, now = new Date()) {
  const gates = state.gates || {};
  const phase = String(state.phase || "").toLowerCase();
  if (["delivered", "completed"].includes(phase) || statusIs(gates.pod, ["done", "received", "pod-found", "found"])) {
    return riskNone();
  }

  const storageRisk = storageOperationalRisk(state.storage, gates, now);
  if (storageRisk) return storageRisk;

  const currentException = openExceptionItems(state, state.awb || metadata.awb || "").find((item) =>
    ["needs-action", "needs-decision", "critical", "urgent"].includes(String(item.severity || "").toLowerCase()) &&
    !quietCustomsHoldException(item)
  );
  if (currentException) {
    const severity = String(currentException.severity || "").toLowerCase();
    return makeOperationalRisk(
      severity === "needs-decision" ? "high" : "critical",
      currentException.type || "exception",
      currentException.summary || "Open exception in shipment memory.",
      currentException.nextAction || "Resolve the exception before advancing the shipment.",
      currentException.evidence || currentException.summary || "",
    );
  }

  const unverifiedArrivalRisk = unverifiedArrivalOperationalRisk(state, metadata, evidence, now);
  if (unverifiedArrivalRisk) return unverifiedArrivalRisk;

  if (statusIs(gates.delivery, ["blocked", "exception", "problem"])) {
    return makeOperationalRisk(
      "critical",
      "delivery-blocked",
      gates.delivery.evidence || "Delivery/offload is blocked.",
      "Call the broker/driver now and coordinate receiver instructions.",
      gates.delivery.evidence || "",
    );
  }
  if (statusIs(gates.pickup, ["blocked", "exception"])) {
    return makeOperationalRisk(
      "critical",
      "pickup-blocked",
      gates.pickup.evidence || "Pickup is blocked at the station.",
      "Call the station/broker now and clear the pickup blocker.",
      gates.pickup.evidence || "",
    );
  }
  if (statusIs(gates.pickup, ["driver-onsite", "onsite"])) {
    return makeOperationalRisk(
      "high",
      "driver-onsite",
      gates.pickup.evidence || "Driver is onsite and pickup is not complete.",
      "Monitor loading and call the broker/station if the driver is waiting.",
      gates.pickup.evidence || "",
    );
  }
  if (statusIs(gates.arrival, ["incomplete", "blocked", "partial"])) {
    return makeOperationalRisk(
      "high",
      "arrival-incomplete",
      gates.arrival.evidence || "Arrival/on-hand proof is incomplete.",
      stationConfirmationAction(metadata),
      gates.arrival.evidence || "",
    );
  }
  if (
    statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) &&
    !statusIs(gates.customs, ["done", "released", "cleared"]) &&
    !statusIs(gates.customs, ["blocked", "hold", "customs-hold", "exam-hold"]) &&
    hoursSinceOperationalDate(gates.arrival?.at || state.updatedAt, now) >= 6
  ) {
    return makeOperationalRisk(
      "high",
      "release-delay",
      gates.customs?.evidence || "Shipment arrived but release/DO is still missing.",
      "Push the customs broker for release/DO; do not dispatch pickup yet.",
      gates.customs?.evidence || "",
    );
  }
  if (
    statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) &&
    statusIs(gates.customs, ["done", "released", "cleared"]) &&
    statusIs(gates.fees, ["due", "pending", "unpaid"])
  ) {
    return makeOperationalRisk(
      "medium",
      "fees-due",
      gates.fees.evidence || "Ground handling fees are due.",
      nextActionFromGates(gates, metadata),
      gates.fees.evidence || "",
    );
  }

  return riskNone();
}

function exceptionsFromText(text, phase) {
  const value = String(text || "");
  const exceptions = [];
  const push = (type, summary, severity = "watch") => exceptions.push({ type, summary, severity, status: "open", source: "canonical-pipeline" });
  if (/station-exception|not available|missing pieces|piece-count|offloaded|on-hand|availability/i.test(`${phase} ${value}`)) {
    push("station-availability", "Station/on-hand evidence is incomplete or conflicting.", /station-exception|not available|missing pieces|piece-count/i.test(value) ? "needs-action" : "watch");
  }
  if (/storage accru|storage begins|storage starts|last free|lfd/i.test(value)) push("storage", "Storage timing exists and must be monitored.", "watch");
  if (phase !== "pre-arrival" && /driver|loading|detention|cannot pickup|can't pickup|waiting/i.test(value) && !nonExceptionExecutionUpdateText(value)) push("pickup-exception", "Pickup/loading exception evidence exists.", "needs-action");
  if (/receiver|consignee|closed|refused|cannot deliver|can't deliver|delivery problem/i.test(value)) push("delivery-exception", "Delivery/consignee exception evidence exists.", "needs-action");
  return exceptions;
}

function openExceptionItems(state, awb = "") {
  return array(state.exceptions)
    .map((item) => normalizeExceptionItem(item))
    .filter((item) => !/^(?:closed|resolved|cleared|done)$/i.test(String(item.status || "").trim()))
    .filter((item) => !foreignScopedReleaseItemForAwb(item, awb || state.awb || ""))
    .filter((item) => !genericPreAlertExceptionItem(item))
    .filter((item) => !placeholderUnclassifiedExceptionItem(item))
    .sort((a, b) => exceptionPriority(b) - exceptionPriority(a) || eventTime(b.at) - eventTime(a.at));
}

function typedPickupDocsException(value = "") {
  return /(?:^|[-_\s])(?:pickup[-_\s]?docs[-_\s]?needed|awb[-_\s]?copy[-_\s]?needed|pickup[-_\s]?location[-_\s]?requested)(?:$|[-_\s])/i.test(String(value || ""));
}

function preAlertCustomsDocumentRequestText(value = "") {
  const text = String(value || "");
  if (!/\b(?:pre[-\s]?alert|3461|7501|full set of documents|clearance instructions)\b/i.test(text)) return false;
  return !/\b(?:driver|carrier|pickup|pick\s*up|recover|recovery|onsite|on[-\s]?site|loaded|loading|detention)\b/i.test(text);
}

function preAlertCustomsDocumentRequestItem(item = {}) {
  const sourceText = `${item.evidence || ""} ${item.subject || ""}`;
  return preAlertCustomsDocumentRequestText(sourceText || factText(item));
}

function movementSplitOffloadText(value = "") {
  return /\b(?:shipment split|split shipment|another split|pieces? offloaded|pcs? offloaded|offloaded from|rebooked on|rebooked to)\b[^.\n;]{0,180}\b(?:flight|ly\d+|due to|weight|space|next flight|rebooked|built)\b|\b(?:only\s+)?\d+\s*(?:pcs?|pieces?)\s+(?:were\s+)?built\s+(?:for|on)\s+[A-Z]{2}\d+(?:\/\d+)?\b|\b(?:weight and space problem|space problem)\b[^.\n;]{0,120}\b(?:offloaded|rebooked|split)\b/i.test(String(value || ""));
}

function genericPreAlertExceptionItem(item = {}) {
  const explicitType = `${item.type || ""} ${item.exceptionType || ""}`;
  const text = `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.subject || ""}`;
  if (preAlertCustomsDocumentRequestItem(item)) return true;
  if (typedPickupDocsException(explicitType)) {
    return false;
  }
  if (!/unknown-operational-exception|unclassified-operational-exception|pickup-docs-needed|pickup broker needs remaining pickup docs|remaining pickup docs?|pickup docs?.*delivery order|operational exception was reported, but it does not match a named exception yet/i.test(text)) return false;
  if (!/\b(?:pre[-\s]?alert|full set of documents|3461|7501|please contact consignee|pickup docs?|remaining pickup docs?|delivery order)\b/i.test(text)) return false;
  return !/\b(?:rejected|reject|not accepted|not locate|cannot locate|can't locate|cant locate|not found|not in (?:the )?ua area|flight deleted|deleted in uc360|driver|onsite|on[-\s]?site|storage|detention|customs hold|government hold|exam hold|cannot pick up|can't pick up)\b/i.test(text);
}

function placeholderUnclassifiedExceptionItem(item = {}) {
  const text = `${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  if (!/unclassified-operational-exception|unknown-operational-exception|operational exception was reported, but it does not match a named exception yet/i.test(text)) return false;
  const evidence = String(item.evidence || "").replace(/\s+/g, " ").trim();
  const summary = String(item.summary || "").replace(/\s+/g, " ").trim();
  return (!item.nextAction || /^review the thread/i.test(String(item.nextAction || ""))) &&
    (!evidence || evidence === summary || /^Operational exception was reported, but it does not match a named exception yet\.?$/i.test(evidence));
}

function quietCustomsHoldException(item = {}) {
  const text = `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  return /\b(?:customs[-\s]?hold|government[-\s]?hold|exam[-\s]?hold|u\.?s\.? customs hold)\b/i.test(text) &&
    !/\b(?:driver|pickup|delivery|storage|detention|not locate|cannot locate|can't locate|cant locate|not found|flight deleted|deleted in uc360|not in (?:the )?ua area|connection transfer|transfer)\b/i.test(text);
}

function connectionTransferExceptionText(value) {
  const text = String(value || "");
  if (/\b(?:connection[-_\s]?transfer|flight deleted|deleted in uc360|not in (?:the )?(?:ua|united) area|awb[-_\s]?copy)\b/i.test(text)) return true;
  // A handler/airport token (WFS, CDG) alone is not a transfer exception — a customs hold at a
  // WFS station must stay a customs hold. Require transfer/handoff context near the token.
  return /\b(?:wfs|cdg)\b[^.\n;]{0,120}\b(?:transfer(?:red|ring)?|hand[-\s]?off|handoff|connection|re[-\s]?tender(?:ed)?|recover(?:y|ed)?)\b/i.test(text) ||
    /\b(?:transfer(?:red|ring)?|hand[-\s]?off|handoff|connection|re[-\s]?tender(?:ed)?)\b[^.\n;]{0,120}\b(?:wfs|cdg)\b/i.test(text);
}

function emailDeliveryFailureText(value) {
  return /\b(?:delivery has failed to (?:these )?recipients?|recipient'?s mailbox is full|mailbox is full|undeliverable|diagnostic information for administrators|couldn'?t accept messages)\b/i.test(String(value || ""));
}

function stationCargoNotFoundText(value) {
  const text = String(value || "");
  return /\b(?:station|airport|terminal|airline|warehouse|driver|truck|trucker)\b[^.\n;]{0,180}\b(?:can'?t|cant|cannot|doesn'?t|does not|don'?t|do not|not|unable)\b[^.\n;]{0,120}\b(?:find|locate|see|recover)\b[^.\n;]{0,100}\b(?:cargo|freight|shipment|load|pieces?|pcs?|awb)?\b/i.test(text) ||
    /\b(?:cargo|freight|shipment|load|pieces?|pcs?)\b[^.\n;]{0,140}\b(?:missing|not found|cannot be found|can'?t be found|cant be found|not located|can'?t locate|cant locate|cannot locate|short)\b/i.test(text) ||
    /\bdriver\b[^.\n;]{0,100}\btold\b[^.\n;]{0,100}\b(?:they|station|airport|terminal|warehouse)?\b[^.\n;]{0,40}\b(?:can'?t|cant|cannot|couldn'?t|couldnt)\s+locate\b/i.test(text);
}

function stationAvailabilityBlockerText(value) {
  const text = String(value || "");
  return stationCargoNotFoundText(text) ||
    /\b(?:station|handler|carrier|airline|airport|terminal|warehouse|cargo|freight|shipment)\b[^.\n;]{0,180}\b(?:not|no|without|still|yet)\b[^.\n;]{0,120}\b(?:on[-\s]?hand|available|arrived|arrival|located|found|in (?:our|the|their) system)\b/i.test(text) ||
    /\b(?:not[-\s]?arrived|not on[-\s]?hand|not available|not yet in (?:our|the|their) system|not in (?:our|the|their) system|at origin|still at origin)\b/i.test(text);
}

function normalizeExceptionItem(item = {}) {
  const text = `${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  if (!stationCargoNotFoundText(text)) return item;
  return {
    ...item,
    type: "station-cargo-not-found",
    exceptionType: "station-cargo-not-found",
    where: item.where || "station",
    impact: "station-cargo-not-found",
    severity: /^(?:critical|immediate|urgent|needs-action)$/i.test(String(item.severity || "")) ? item.severity : "needs-action",
    summary: "Station/pickup side cannot locate the cargo.",
    nextAction: "Call the station and pickup broker now; confirm whether the cargo was actually located or picked up before advancing.",
  };
}

function positiveResolutionFact(fact = {}) {
  const text = factText(fact);
  if (/\bloaded\b/i.test(text) && !onwardHandlerTransferText(text)) return true;
  return /\b(?:connection[-_\s]?transfer[-_\s]?resolved|transfer (?:is )?(?:done|completed)|handoff (?:is )?(?:done|completed)|resolved history|old .{0,40}exception is resolved|continues? to [A-Z]{3}|continue to [A-Z]{3}|shipment (?:was )?received\b[\s\S]{0,180}\b(?:will be loaded|loaded for flight|ua\s*\d+|united\s*\d+)|pickup[-_\s]?docs[-_\s]?sent|pickup[-_\s]?confirmed|pickup[-_\s]?loaded|picked up|driver (?:is )?(?:now )?loaded|operational[-_\s]?clear|customs[-_\s]?release[-_\s]?received|customs release\/do evidence was received)\b/i.test(text);
}

function factResolvesException(fact = {}, exception = {}) {
  const exceptionText = `${exception.type || ""} ${exception.exceptionType || ""} ${exception.where || ""} ${exception.summary || ""} ${exception.evidence || ""}`;
  const resolverText = factText(fact);
  if (!positiveResolutionFact(fact)) return false;
  if (customsReleaseResolvableBlockerText(exceptionText)) {
    return /\b(?:customs[-_\s]?release[-_\s]?received|customs release\/do evidence was received|pickup[-_\s]?docs[-_\s]?sent|operational[-_\s]?clear)\b/i.test(resolverText);
  }
  if (connectionTransferExceptionText(exceptionText)) {
    return /\b(?:connection[-_\s]?transfer[-_\s]?resolved|transfer (?:is )?(?:done|completed)|handoff (?:is )?(?:done|completed)|continues? to [A-Z]{3}|continue to [A-Z]{3}|shipment (?:was )?received\b[\s\S]{0,180}\b(?:will be loaded|loaded for flight|ua\s*\d+|united\s*\d+)|pickup[-_\s]?docs[-_\s]?sent|operational[-_\s]?clear)\b/i.test(resolverText);
  }
  if (/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver[-_\s]?waiting|pickup[-_\s]?blocked|station|pickup|driver|not locate|cannot locate|can't locate|cant locate|not found|detention)\b/i.test(exceptionText)) {
    if (/\b(?:resolved history|old .{0,40}exception is resolved|continues? to [A-Z]{3}|continue to [A-Z]{3}|do not show this as .{0,60}(?:exception|pickup-ready|pickup blocked|not ready))\b/i.test(resolverText)) {
      return true;
    }
    return /\b(?:pickup[-_\s]?confirmed|pickup[-_\s]?loaded|picked up|driver (?:is )?(?:now )?loaded|recovered|operational[-_\s]?clear|loaded)\b/i.test(resolverText) &&
      !onwardHandlerTransferText(resolverText);
  }
  if (/\b(?:customs|release|broker[-_\s]?release|pickup[-_\s]?docs|delivery order|d\/?o|3461|7501|documents?)\b/i.test(exceptionText)) {
    return /\b(?:customs[-_\s]?release[-_\s]?received|customs release\/do evidence was received|pickup[-_\s]?docs[-_\s]?sent|operational[-_\s]?clear)\b/i.test(resolverText);
  }
  return /\boperational[-_\s]?clear\b/i.test(resolverText);
}

function exceptionSupersededByFacts(exception = {}, facts = []) {
  const exceptionAt = eventTime(exception.at);
  const exceptionText = `${exception.type || ""} ${exception.exceptionType || ""} ${exception.where || ""} ${exception.summary || ""} ${exception.evidence || ""} ${exception.nextAction || ""}`;
  const resolverAt = array(facts)
    .filter((fact) => factResolvesException(fact, exception))
    .map((fact) => eventTime(factOccurredAt(fact)))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  if (resolverAt && (!exceptionAt || resolverAt >= exceptionAt)) return true;
  if (!movementSplitOffloadText(exceptionText)) return false;
  const arrivalProofAt = array(facts)
    .filter(strongScopedArrivalEvidenceFact)
    .map((fact) => eventTime(factOccurredAt(fact)))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  return Boolean(arrivalProofAt && (!exceptionAt || arrivalProofAt >= exceptionAt));
}

function exceptionPriority(item = {}) {
  const text = `${item.type || ""} ${item.exceptionType || ""} ${item.severity || ""} ${item.summary || ""} ${item.evidence || ""}`;
  let score = 0;
  if (/\b(?:critical|urgent|immediate)\b/i.test(text)) score += 50;
  if (/\b(?:needs-action|needs-decision)\b/i.test(text)) score += 40;
  if (item.nextAction) score += 20;
  if (/^(?:active|gmail-proof|email|gmail)$/i.test(String(item.type || ""))) score -= 20;
  if (/\b(?:connection-transfer-exception|awb-copy-requested|station-cargo-not-found|pickup-blocked|delivery-blocked|customs-hold)\b/i.test(String(item.type || ""))) score += 20;
  if (/\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|misdelivered|delivered by mistake|another customer|another cnee)\b/i.test(text)) score += 60;
  if (/\b(?:pickup-blocked|station|not locate|cannot locate|can't locate|cant locate|not found|driver did not pick)\b/i.test(text)) score += 35;
  if (/\b(?:connection-transfer|flight deleted|deleted in uc360|not in (?:the )?ua area|awb copy|wfs|cdg)\b/i.test(text)) score += 30;
  if (/\b(?:station-contact-email-failed|mailbox is full|undeliverable|delivery has failed to (?:these )?recipients?)\b/i.test(text)) score += 25;
  if (/\b(?:customs hold|government hold|exam hold|inbond|rejected|arrive it)\b/i.test(text)) score += 30;
  if (/\b(?:storage|detention)\b/i.test(text)) score += 10;
  if (/unknown-operational-exception|unclassified-operational-exception/i.test(text)) score -= 15;
  return score;
}

function exceptionItemsFromFacts(facts = [], awb = "") {
  return facts
    .filter((fact) => sourceLooksEmailOrOperator(fact) && !sourceLooksTmsOrTracking(fact) && !generatedGateFact(fact))
    .filter((fact) => !foreignScopedReleaseBlockerFact(fact, awb || fact.awb || ""))
    .filter((fact) => !positiveResolutionFact(fact))
    .filter((fact) => !positiveExecutionProgressFact(fact))
    .filter((fact) => !preAlertCustomsDocumentRequestItem(fact))
    .filter((fact) => {
      const text = factText(fact);
      if (pickupDocsExceptionItem(fact)) return true;
      return /\bexception\b/i.test(fact.type || "") ||
        fact.exceptionType ||
        movementSplitOffloadText(text) ||
        emailDeliveryFailureText(text) ||
        /\b(?:pickup blocked|driver did not pick|not locate|cannot locate|can't locate|cant locate|not found|not in (?:the )?ua area|flight deleted|deleted in uc360|awb copy|connection transfer|customs hold|government hold|exam hold|inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it)\b/i.test(text);
    })
    .map((fact) => {
      const text = factText(fact);
      const movementSplit = movementSplitOffloadText(text);
      const emailDeliveryFailure = emailDeliveryFailureText(text);
      const stationCargoNotFound = stationCargoNotFoundText(text);
      return {
        type: movementSplit ? "movement-split-offload" : emailDeliveryFailure ? "station-contact-email-failed" : stationCargoNotFound ? "station-cargo-not-found" : fact.exceptionType || fact.type || "exception",
        severity: movementSplit || emailDeliveryFailure || stationCargoNotFound ? "needs-action" : fact.severity || (/pickup blocked|not locate|cannot locate|can't locate|cant locate|not found|flight deleted|deleted in uc360|not in (?:the )?ua area|awb copy|inbond|rejected/i.test(text) ? "needs-action" : "watch"),
        where: movementSplit ? "movement" : emailDeliveryFailure || stationCargoNotFound ? "station" : /station|pickup|driver|locate/i.test(text) ? "station" : "",
        impact: movementSplit ? "flight-split-rebooked" : emailDeliveryFailure ? "station-contact-unreachable" : stationCargoNotFound ? "station-cargo-not-found" : fact.exceptionType || fact.type || "exception",
        status: fact.status || "open",
        summary: movementSplit ? movementSplitSummaryFromFact(fact) : emailDeliveryFailure ? "Station/status email bounced or mailbox was full." : stationCargoNotFound ? "Station/pickup side cannot locate the cargo." : exceptionSummaryFromFact(fact),
        evidence: fact.evidence || fact.summary || "",
        nextAction: movementSplit ? "Confirm revised flight/arrival and affected pieces before planning pickup." : emailDeliveryFailure ? "Find a working station/status contact or call the station before relying on emailed status follow-up." : stationCargoNotFound ? "Call the station and pickup broker now; confirm whether the cargo was actually located or picked up before advancing." : fact.nextAction || exceptionNextActionFromFact(fact),
        at: fact.at || "",
        threadId: fact.threadId || "",
        messageId: fact.messageId || "",
        subject: fact.subject || "",
        source: fact.source || "email-first-truth",
        confidence: fact.confidence || "high",
      };
    })
    .filter((item) => !genericPreAlertExceptionItem(item))
    .filter((item) => !exceptionSupersededByFacts(item, facts));
}

function exceptionSummaryFromFact(fact = {}) {
  const text = factText(fact);
  const summary = fact.summary || fact.evidence || "Exception evidence found in Gmail.";
  if (/\b(?:customs\/inbond blocker|customs hold|government hold|exam hold|inbond|customs entry|arrive\s+it|rejected)\b/i.test(text)) {
    const decisiveEvidence = fact.evidence && !String(summary).includes(fact.evidence)
      ? ` ${compact(fact.evidence, 180)}`
      : "";
    return /\bcustoms hold\b/i.test(summary)
      ? `${summary}${decisiveEvidence}`
      : `Customs hold/inbond blocker is active: ${summary}.${decisiveEvidence}`.replace(/\.\s*\./g, ".");
  }
  return summary;
}

function movementSplitSummaryFromFact(fact = {}) {
  const detail = compact(fact.evidence || fact.summary || fact.claim || "", 180);
  if (detail && !/^shipment split\/offloaded\/rebooked; movement timing or piece availability changed\.?$/i.test(detail)) {
    return `Shipment split/offloaded/rebooked: ${detail}`;
  }
  return "Shipment split/offloaded/rebooked; movement timing or piece availability changed.";
}

function exceptionNextActionFromFact(fact = {}) {
  const explicitType = `${fact.type || ""} ${fact.exceptionType || ""}`;
  const text = factText(fact);
  if (preAlertCustomsDocumentRequestItem(fact)) return "";
  if (/(?:^|[-_\s])awb[-_\s]?copy[-_\s]?needed(?:$|[-_\s])/i.test(explicitType) ||
    /\b(?:need(?:s|ed)?|missing|remaining|request(?:ed)?|send|provide).{0,80}(?:copy of the awb|awb copy|air waybill copy|airway bill copy)\b/i.test(text)) {
    return "Send the AWB copy in the pickup thread, then confirm pickup can proceed.";
  }
  if (/(?:^|[-_\s])pickup[-_\s]?location[-_\s]?requested(?:$|[-_\s])/i.test(explicitType) ||
    /\b(?:need(?:s|ed)?|missing|remaining|request(?:ed)?|send|provide).{0,80}(?:exact pick[-_\s]?up location|pickup location)\b/i.test(text)) {
    return "Reply in the pickup thread with the station/pickup location, then confirm pickup can proceed.";
  }
  if (/(?:^|[-_\s])pickup[-_\s]?docs[-_\s]?needed(?:$|[-_\s])/i.test(explicitType) ||
    /\b(?:pickup broker needs remaining pickup docs|remaining pickup docs?|missing pickup docs?|(?:need(?:s|ed)?|missing|remaining|request(?:ed)?|send|generate|provide).{0,80}(?:delivery order|d\/?o|pickup docs?))\b/i.test(text)) {
    return "Generate/send the delivery order or missing docs, then reply in the pickup thread.";
  }
  return "";
}

function pickupDocsExceptionItem(item = {}) {
  if (preAlertCustomsDocumentRequestItem(item)) {
    return false;
  }
  const explicitType = `${item.type || ""} ${item.exceptionType || ""}`;
  if (typedPickupDocsException(explicitType)) {
    return true;
  }
  const sourceText = `${item.summary || ""} ${item.evidence || ""}`;
  return /\b(?:pickup broker needs remaining pickup docs|remaining pickup docs?|missing pickup docs?|(?:need(?:s|ed)?|missing|remaining|request(?:ed)?|send|generate|provide).{0,80}(?:copy of the awb|awb copy|air waybill copy|airway bill copy|exact pick[-_\s]?up location|pickup location|delivery order|d\/?o|pickup docs?))\b/i.test(sourceText);
}

function releaseGapExceptionItem(item = {}, awb = "") {
  const text = `${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  const structuredType = `${item.type || ""} ${item.exceptionType || ""} ${item.impact || ""} ${item.status || ""}`;
  const scoped = awbScopedClauseText(text, awb || item.awb || "");
  const releaseText = scoped.scoped ? scoped.text : text;
  if (scoped.scoped && !releaseBlockerLanguage(releaseText)) return false;
  if (/\b(?:broker[-_\s]?release[-_\s]?pending|release[-_\s]?pending|customs[-_\s]?release[-_\s]?needed)\b/i.test(structuredType)) {
    return true;
  }
  if (/\b(?:customs[-_\s]?hold|government[-_\s]?hold|exam[-_\s]?hold|inbond|rejected|wrong[-_\s]?consignee|delivery[-_\s]?blocked|station[-_\s]?cargo[-_\s]?not[-_\s]?found|cannot locate|can't locate|not found)\b/i.test(releaseText)) {
    return false;
  }
  return /\b(?:release|customs clearance|clearance|d\/?o|delivery order|pickup docs?|documents?)\b/i.test(releaseText) &&
    /\b(?:missing|needed|not confirmed|not proven|pending|unconfirmed|generate\/send|send|provide)\b/i.test(releaseText);
}

function foreignScopedReleaseBlockerFact(fact = {}, awb = "") {
  const text = factText(fact);
  if (!releaseBlockerLanguage(text)) return false;
  const target = normalizeAwb(awb || fact.awb || fact.normalizedAwb || String(fact.id || "").split(":")[0] || "");
  if (!target) return false;
  const scoped = awbScopedClauseText(text, target);
  return scoped.scoped && !releaseBlockerLanguage(scoped.text);
}

function foreignScopedReleaseTextForAwb(value = "", awb = "") {
  const target = normalizeAwb(awb);
  if (!target) return false;
  const text = String(value || "");
  if (!releaseBlockerLanguage(text)) return false;
  const mentions = awbMentions(text);
  return mentions.length > 0 && !mentions.includes(target);
}

function foreignScopedReleaseItemForAwb(item = {}, awb = "") {
  const target = normalizeAwb(awb || item.awb || item.normalizedAwb || "");
  if (!target) return false;
  const scopedFields = [
    item.type,
    item.exceptionType,
    item.impact,
    item.summary,
    item.reason,
    item.claim,
    item.nextAction,
  ].filter(Boolean).join(" ");
  if (foreignScopedReleaseTextForAwb(scopedFields, target)) return true;
  if (foreignScopedReleaseBlockerFact({ ...item, evidence: "" }, target)) return true;
  return foreignScopedReleaseBlockerFact(item, target);
}

function activeExceptionPhase(state, gates) {
  const phase = String(state.phase || "").toLowerCase().trim();
  const exceptions = openExceptionItems(state);
  const terminalRecoveryException = exceptions.find((item) => terminalRecoveryBlockerText(`${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`));
  if (terminalRecoveryException) return "delivery-blocked";
  const connectionTransferException = exceptions.find((item) => connectionTransferExceptionText(`${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`));
  if (connectionTransferException) return "exception";
  const pickupDocsException = exceptions.find((item) => pickupDocsExceptionItem(item));
  if (pickupDocsException) return "pickup-docs-needed";
  const releaseGapException = exceptions.find((item) => releaseGapExceptionItem(item, state.awb));
  if (
    releaseGapException &&
    statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) &&
    !statusIs(gates.customs, ["done", "released", "cleared"])
  ) {
    return "release-needed";
  }
  const customsGateAt = eventTime(gates.customs?.at);
  const latestMovementSplit = exceptions
    .filter((item) => movementSplitOffloadText(`${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`))
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0];
  if (latestMovementSplit && (!customsGateAt || eventTime(latestMovementSplit.at) >= customsGateAt)) {
    return "exception";
  }
  const urgentException = exceptions.find((item) =>
    /^(?:immediate|urgent|critical|needs-action|needs-decision)$/i.test(String(item.severity || "").trim()) ||
    /exception|blocked|hold|rejected|cannot|can't|not locate|not available|deleted|missing|rejected/i.test(`${item.type || ""} ${item.summary || ""}`)
  );
  if (!urgentException && !["exception", "pickup-blocked", "delivery-blocked", "arrival-incomplete", "customs-hold"].includes(phase)) {
    return "";
  }
  if (statusIs(gates.pod, ["done", "received", "pod-found", "found"])) return "";
  if (phase === "customs-hold" && !statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])) return "";
  if (phase === "pickup-blocked" && !statusIs(gates.pickup, ["blocked", "exception", "incomplete"])) return "";
  if (phase === "arrival-incomplete" && !statusIs(gates.arrival, ["incomplete", "blocked", "partial"])) return "";
  if (statusIs(gates.delivery, ["blocked", "exception", "problem"]) || phase === "delivery-blocked") return "delivery-blocked";
  if (statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"]) || phase === "customs-hold") return "customs-hold";
  if (statusIs(gates.pickup, ["blocked", "exception", "incomplete"]) || phase === "pickup-blocked") return "pickup-blocked";
  if (statusIs(gates.arrival, ["incomplete", "blocked", "partial"]) || phase === "arrival-incomplete") return "arrival-incomplete";
  if (phase === "exception" || urgentException) return "exception";
  return "";
}

function preferredExceptionForPhase(exceptions = [], phase = "", gates = {}, awb = "") {
  const items = array(exceptions);
  const textFor = (item) => `${item.type || ""} ${item.exceptionType || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  if (phase === "exception") {
    const movement = items.find((item) => movementSplitOffloadText(textFor(item)));
    if (movement) return movement;
  }
  if (phase === "release-needed" || !statusIs(gates.customs, ["done", "released", "cleared"])) {
    const releaseGap = items.find((item) => releaseGapExceptionItem(item, awb || item.awb || ""));
    if (releaseGap) return releaseGap;
  }
  if (phase === "customs-hold" || statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])) {
    const customs = items.find((item) => /\b(?:customs[-\s]?hold|government[-\s]?hold|exam[-\s]?hold|inbond|customs entry|arrive\s+it|rejected)\b/i.test(textFor(item)));
    if (customs) return customs;
  }
  if (phase === "delivery-blocked") {
    const delivery = items.find((item) =>
      terminalRecoveryBlockerText(textFor(item)) ||
      /\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|misdelivered|delivered by mistake|another customer|another cnee|delivery[-_\s]?blocked|station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver did not pick|did not pick up|not locate|cannot locate|can't locate|cant locate|not found)\b/i.test(textFor(item))
    );
    if (delivery) return delivery;
  }
  if (phase === "pickup-blocked") {
    const pickup = items.find((item) => /\b(?:pickup[-_\s]?blocked|station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver|not locate|cannot locate|can't locate|cant locate|not found)\b/i.test(textFor(item)));
    if (pickup) return pickup;
  }
  if (phase === "pickup-docs-needed") {
    const docs = items.find((item) => pickupDocsExceptionItem(item));
    if (docs) return docs;
  }
  return items[0] || null;
}

function legacyReducerFallback(group, metadata, memory = {}) {
  const embeddedState = group.rows
    .map((row) => row.shipment?.opsState ? { ...row.shipment.opsState, updatedAt: row.shipment.updatedAt || row.shipment.opsState.updatedAt || "", latestEventAt: row.shipment.opsState.latestEventAt || row.shipment.updatedAt || "" } : null)
    .filter((row) => row?.gates)
    .sort((a, b) => eventTime(b.latestEventAt || b.updatedAt) - eventTime(a.latestEventAt || a.updatedAt))[0] || null;
  const state = mergeShipmentStateRows(group, embeddedState);
  const tmsShipment = firstTmsFrom(group) || {};
  const active = firstFrom(group, "active") || tmsShipment || {};
  const brain = firstFrom(group, "brain") || firstFrom(group, "brain-completed") || {};
  const facts = factRowsForGroup(group, memory);
  const factExceptions = exceptionItemsFromFacts(facts, group.awb);
  if (state.gates && typeof state.gates === "object") {
    const gates = Object.fromEntries(
      ["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"].map((name) => [name, gateFromShipmentState(name, state.gates[name] || {}, state.latestEventAt || state.updatedAt || "")]),
    );
    const active = firstFrom(group, "active") || tmsShipment || {};
    const brain = firstFrom(group, "brain") || firstFrom(group, "brain-completed") || {};
    const decisiveGeneratedGate = Object.entries(gates).some(([name, gateValue]) =>
      name !== "arrival" && !["unknown", "waiting"].includes(String(gateValue.status || "").toLowerCase())
    );
    const activeArrivalDeclared = /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(String(active.arrivalStatus || brain.arrivalStatus || "").trim());
    const activeArrivalReady = existingArrivalReadyEvidence(active, brain, facts);
    const positiveArrivalFact = [
      latestPositiveArrivalEvidenceFact(facts),
      latestStrongArrivalEvidenceFact(facts),
    ].filter(Boolean)
      .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
    let arrivalDowngradedForMissingProof = false;
    if (
      statusIs(gates.arrival, ["done", "arrived"]) &&
      activeArrivalDeclared &&
      !activeArrivalReady &&
      !positiveArrivalFact &&
      /\bActive\/TMS status says arrived\b/i.test(gates.arrival?.evidence || gates.arrival?.summary || "")
    ) {
      gates.arrival = gate("arrival", "not-arrived", "Destination arrival is not proven by current TMS/Gmail evidence.", {
        at: gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
      arrivalDowngradedForMissingProof = true;
    }
    if (
      activeArrivalDeclared &&
      activeArrivalReady &&
      (
        ["unknown", "waiting"].includes(gates.arrival?.status) ||
        (["not-arrived", "pending", "missing"].includes(gates.arrival?.status) && activeArrivalReady)
      ) &&
      (!decisiveGeneratedGate || activeArrivalReady)
    ) {
      gates.arrival = gate("arrival", "done", "Active/TMS status says arrived.", {
        at: gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: "active-shipment",
        confidence: "high",
      });
    }
    const positiveArrivalAt = eventTime(positiveArrivalFact?.at);
    const arrivalGateAt = eventTime(gates.arrival?.at);
    const weakNotArrivedGate =
      /\b(?:requested, not proven|requested, not received|not proven by shipment-state|arrival\/on-hand was requested|not arrived yet|has not arrived)\b/i.test(gates.arrival?.evidence || "");
    if (
      positiveArrivalFact &&
      statusIs(gates.arrival, ["not-arrived", "pending", "waiting", "unknown", "missing"]) &&
      (weakNotArrivedGate || !arrivalGateAt || !positiveArrivalAt || positiveArrivalAt >= arrivalGateAt)
    ) {
      gates.arrival = gate("arrival", "done", positiveArrivalFact.summary || positiveArrivalFact.evidence || "Arrival/on-hand evidence was received.", {
        at: positiveArrivalFact.at || gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: positiveArrivalFact.source || "email-first-truth",
        confidence: positiveArrivalFact.confidence || "high",
      });
    }
    const activeCustomsReleaseEvidence = existingCustomsReleaseEvidence(active, brain);
    const emailReleaseBlocker = activeCustomsReleaseEvidence ? null : authoritativeEmailReleaseBlockerFact(facts, state.awb || group.awb);
    const nonFinalRelease = nonFinalCustomsReleaseEvidence(facts, gates.customs?.at);
    const tmsCustomsReleaseEvidence = tmsProvesCustomsRelease({
      ...tmsShipment,
      status: first(tmsShipment.status, tmsShipment.tmsStatus, active.tms?.status, active.tms?.tmsStatus, metadata.tms?.status, metadata.tms?.tmsStatus),
      tmsStatus: first(tmsShipment.tmsStatus, tmsShipment.status, active.tms?.tmsStatus, active.tms?.status, metadata.tms?.tmsStatus, metadata.tms?.status),
      nextTask: first(tmsShipment.nextTask, active.tms?.nextTask, metadata.tms?.nextTask),
      customsActualRelease: first(tmsShipment.customsActualRelease, active.tms?.customsActualRelease, metadata.tms?.customsActualRelease),
      customsReleaseActual: first(tmsShipment.customsReleaseActual, active.tms?.customsReleaseActual, metadata.tms?.customsReleaseActual),
      customsReleaseDate: first(tmsShipment.customsReleaseDate, active.tms?.customsReleaseDate, metadata.tms?.customsReleaseDate),
      actualCustomsReleaseDate: first(tmsShipment.actualCustomsReleaseDate, active.tms?.actualCustomsReleaseDate, metadata.tms?.actualCustomsReleaseDate),
    });
    if (emailReleaseBlocker && statusIs(gates.customs, ["done", "released", "cleared", "blocked", "customs-hold", "hold", "exam-hold", "pending", "waiting", "unknown"])) {
      gates.customs = gate("customs", releaseBlockerGateStatus(emailReleaseBlocker), emailReleaseBlocker.summary || "Email/thread evidence says release/DO is still unresolved.", {
        at: emailReleaseBlocker.at || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: emailReleaseBlocker.source || "email-first-truth",
        confidence: emailReleaseBlocker.confidence || "high",
        sourceFactIds: [canonicalSourceFactId(emailReleaseBlocker)].filter(Boolean),
      });
    } else if (nonFinalRelease && gates.customs?.status === "done") {
      gates.customs = gate("customs", "pending", "Delivery order is present, but final clearance/entry confirmation is still pending.", {
        at: gates.customs.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
    }
    if (
      !emailReleaseBlocker &&
      !nonFinalRelease &&
      activeCustomsReleaseEvidence &&
      ["blocked", "customs-hold", "hold", "exam-hold", "pending", "waiting", "unknown"].includes(gates.customs?.status)
    ) {
      gates.customs = gate("customs", "done", "Direct Gmail/operator evidence says customs released.", {
        at: gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: "email-operator-truth",
        confidence: "high",
      });
    }
    if (
      !emailReleaseBlocker &&
      !nonFinalRelease &&
      tmsCustomsReleaseEvidence &&
      ["blocked", "customs-hold", "hold", "exam-hold", "pending", "waiting", "unknown"].includes(gates.customs?.status)
    ) {
      gates.customs = gate("customs", "done", "TMS actual customs release is present.", {
        at: gates.customs?.at || tmsShipment.snapshotTime || state.latestEventAt || state.updatedAt || "",
        source: "tms-detail",
        confidence: "medium",
      });
    }
    const finalRelease = finalCustomsReleaseEvidence(facts, finalCustomsReleaseCutoffAt(gates.customs));
    const releaseResolver = finalRelease || latestExternalFinalCustomsReleaseFact(facts);
    if (!emailReleaseBlocker && !nonFinalRelease && releaseResolver && ["blocked", "pending", "waiting", "unknown"].includes(gates.customs?.status)) {
      gates.customs = gate("customs", "done", releaseResolver.summary, {
        at: factOccurredAt(releaseResolver) || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: releaseResolver.source || "shipment-state-sanity",
        confidence: releaseResolver.confidence || "high",
      });
    }
    if (!emailReleaseBlocker && statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])) {
      gates.customs = gate("customs", "unknown", "No current source fact in this evidence cut proves a customs/government hold.", {
        at: state.latestEventAt || state.updatedAt || gates.customs?.at || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
    }
    const upstreamClosure = downstreamUpstreamClosureEvidence(facts);
    if (upstreamClosure) {
      const closureAt = eventTime(upstreamClosure.observedAt);
      const releaseBlockerAt = eventTime(factOccurredAt(emailReleaseBlocker));
      const unresolvedHardHold = Boolean(
        emailReleaseBlocker && releaseBlockerGateStatus(emailReleaseBlocker) === "blocked"
      );
      const closureBlockedByReleaseEvidence = Boolean(
        unresolvedHardHold ||
        emailReleaseBlocker && (!closureAt || !releaseBlockerAt || releaseBlockerAt >= closureAt)
      );
      const laterArrivalContradiction = Boolean(
        !statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) &&
        eventTime(gates.arrival?.at) > closureAt &&
        /\b(?:not[-\s]?arrived|not at destination|in[-\s]?transit|still at origin|onward[-\s]?flight|handler transfer)\b/i.test(gates.arrival?.evidence || "")
      );
      if (!laterArrivalContradiction && !statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"])) {
        gates.arrival = gate("arrival", "done", "Broker award, pickup-document handoff, fee payment, and scheduled delivery prove destination arrival was operationally passed.", {
          at: upstreamClosure.observedAt || gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
          source: "email-first-truth",
          confidence: "high",
          sourceFactIds: upstreamClosure.sourceFactIds,
        });
      }
      if (!closureBlockedByReleaseEvidence && !statusIs(gates.customs, ["done", "released", "cleared"])) {
        gates.customs = gate("customs", "done", "Broker award, pickup-document handoff, fee payment, and scheduled delivery prove the customs/release path was operationally passed.", {
          at: upstreamClosure.observedAt || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
          source: "email-first-truth",
          confidence: "high",
          sourceFactIds: upstreamClosure.sourceFactIds,
        });
      }
    }
    const customsHoldArrivalInference = customsHoldEvidenceImpliesDestinationControl(gates, facts);
    if (
      customsHoldArrivalInference &&
      statusIs(gates.arrival, ["unknown", "waiting", "pending", "missing", "not-arrived"])
    ) {
      gates.arrival = gate("arrival", "done", customsHoldArrivalInference.summary, {
        at: customsHoldArrivalInference.at || gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: customsHoldArrivalInference.source,
        confidence: customsHoldArrivalInference.confidence,
      });
    }
    const finalPod = finalPodEvidence(facts, active, brain, state);
    const onwardHandlerTransfer = latestOnwardHandlerTransferFact(facts, state);
    const directPickupProofPresent = directPickupExecutionFact(facts, state);
    const tmsArrivalProvenByMetadata = tmsProvesDestinationArrival({
      ...tmsShipment,
      nextTask: first(tmsShipment.nextTask, metadata.flightDetails?.recoveryHint, metadata.flightDetails?.etaHint),
      status: first(tmsShipment.status, tmsShipment.tmsStatus, metadata.tms?.status, metadata.tms?.tmsStatus),
      tmsStatus: first(tmsShipment.tmsStatus, tmsShipment.status, metadata.tms?.tmsStatus, metadata.tms?.status),
    });
    const tmsArrivalProofAt = tmsArrivalProvenByMetadata
      ? eventTime(first(tmsShipment.snapshotTime, metadata.tms?.snapshotTime, state.latestEventAt, state.updatedAt))
      : 0;
    const currentArrivalProofAt = Math.max(
      eventTime(factOccurredAt(positiveArrivalFact)),
      tmsArrivalProofAt || 0,
    );
    if (
      tmsArrivalProvenByMetadata &&
      statusIs(gates.arrival, ["not-arrived", "pending", "waiting", "unknown", "missing"]) &&
      (weakNotArrivedGate || !arrivalGateAt || !tmsArrivalProofAt || tmsArrivalProofAt >= arrivalGateAt)
    ) {
      const tmsStatusText = first(tmsShipment.status, tmsShipment.tmsStatus, metadata.tms?.status, metadata.tms?.tmsStatus, "TMS arrival");
      const tmsTaskText = first(tmsShipment.nextTask, metadata.tms?.nextTask, metadata.flightDetails?.recoveryHint, metadata.flightDetails?.etaHint);
      gates.arrival = gate("arrival", "done", `TMS destination arrival confirmed: ${[tmsStatusText, tmsTaskText].filter(Boolean).join("; ")}.`, {
        at: first(tmsShipment.snapshotTime, metadata.tms?.snapshotTime, gates.arrival?.at, state.latestEventAt, state.updatedAt),
        source: first(tmsShipment.source, metadata.tms?.source, "tms-detail"),
        confidence: "high",
      });
    }
    const tmsBlocksUnprovenArrival = tmsContradictsDestinationArrival(active, brain, {
      ...tmsShipment,
      flightDetails: metadata.flightDetails,
      nextTask: first(tmsShipment.nextTask, metadata.flightDetails?.recoveryHint, metadata.flightDetails?.etaHint),
      status: first(tmsShipment.status, tmsShipment.tmsStatus, metadata.tms?.status, metadata.tms?.tmsStatus),
      tmsStatus: first(tmsShipment.tmsStatus, tmsShipment.status, metadata.tms?.tmsStatus, metadata.tms?.status),
    }) && !tmsArrivalProvenByMetadata && !facts.some(strongScopedArrivalEvidenceFact);
    const terminalCompletionNeedsCertification =
      statusIs(gates.delivery, ["delivered", "reported"]) ||
      statusIs(gates.pod, ["done", "received", "pod-found", "found"]);
      if (finalPod) {
        gates.arrival = gate("arrival", "done", gates.arrival?.evidence || "Delivery/POD proof implies destination arrival happened.", {
        at: gates.arrival?.at || finalPod.at || state.latestEventAt || state.updatedAt || "",
        source: gates.arrival?.source || finalPod.source || "shipment-state-sanity",
        confidence: "high",
      });
      gates.customs = gate("customs", "done", gates.customs?.evidence || "Shipment was delivered; release path was sufficient.", {
        at: gates.customs?.at || finalPod.at || state.latestEventAt || state.updatedAt || "",
        source: gates.customs?.source || finalPod.source || "shipment-state-sanity",
        confidence: "high",
      });
      gates.fees = gate("fees", "done", gates.fees?.evidence || "Shipment was delivered; fee blocker did not stop execution.", {
        at: gates.fees?.at || finalPod.at || state.latestEventAt || state.updatedAt || "",
        source: gates.fees?.source || finalPod.source || "shipment-state-sanity",
        confidence: "high",
      });
      gates.dispatch = gate("dispatch", "done", gates.dispatch?.evidence || "Shipment was delivered; dispatch path was completed.", {
        at: gates.dispatch?.at || finalPod.at || state.latestEventAt || state.updatedAt || "",
        source: gates.dispatch?.source || finalPod.source || "shipment-state-sanity",
        confidence: "high",
      });
      gates.pickup = gate("pickup", "done", gates.pickup?.evidence || "Delivery/POD proof implies pickup happened.", {
        at: gates.pickup?.at || finalPod.at || state.latestEventAt || state.updatedAt || "",
        source: gates.pickup?.source || finalPod.source || "shipment-state-sanity",
        confidence: "high",
      });
      gates.delivery = gate("delivery", "delivered", finalPod.summary, {
        at: finalPod.at || gates.delivery?.at || state.latestEventAt || state.updatedAt || "",
        source: finalPod.source || "shipment-state-sanity",
        confidence: finalPod.confidence || "high",
      });
      gates.pod = gate("pod", "done", finalPod.summary, {
        at: finalPod.at || gates.pod?.at || state.latestEventAt || state.updatedAt || "",
        source: finalPod.source || "shipment-state-sanity",
        confidence: finalPod.confidence || "high",
        });
      }
      if (onwardHandlerTransfer && !finalPod) {
        const transferAt = factOccurredAt(onwardHandlerTransfer) || state.latestEventAt || state.updatedAt || "";
        const transferSummary = "Connection/handler transfer is resolved for onward flight; destination delivery is not proven.";
        gates.arrival = gate("arrival", "not-arrived", transferSummary, {
          at: transferAt,
          source: onwardHandlerTransfer.source || "email-first-truth",
          confidence: "high",
        });
        if (!directPickupProofPresent) {
          gates.pickup = gate("pickup", "waiting", "Pickup is not proven; cargo is still in airline/handler transfer or onward-flight execution.", {
            at: transferAt,
            source: onwardHandlerTransfer.source || "email-first-truth",
            confidence: "high",
          });
        }
        if (statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"]) &&
          /\b(?:delivered|delivery\/pod proof|dispatch path was completed|shipment moved from station)\b/i.test(`${gates.dispatch.evidence || ""} ${state.summary || ""}`)) {
          gates.dispatch = gate("dispatch", "waiting", "Pickup dispatch is not proven by handler transfer/onward-flight evidence.", {
            at: transferAt,
            source: "shipment-state-sanity",
            confidence: "high",
          });
        }
        if (statusIs(gates.fees, ["done", "paid"]) &&
          /\b(?:delivered|fee blocker did not stop execution|shipment moved from station)\b/i.test(`${gates.fees.evidence || ""} ${state.summary || ""}`)) {
          gates.fees = gate("fees", "waiting", "Ground-fee resolution is not proven by handler transfer/onward-flight evidence.", {
            at: transferAt,
            source: "shipment-state-sanity",
            confidence: "high",
          });
        }
        gates.delivery = gate("delivery", "waiting", "WFS/handler receipt and onward-flight loading are not consignee delivery.", {
          at: transferAt,
          source: onwardHandlerTransfer.source || "email-first-truth",
          confidence: "high",
        });
        gates.pod = gate("pod", "waiting", "POD is not applicable before final delivery.", {
          at: transferAt,
          source: onwardHandlerTransfer.source || "email-first-truth",
          confidence: "high",
        });
      }
      if (tmsBlocksUnprovenArrival && !finalPod && !directPickupProofPresent && !terminalCompletionNeedsCertification) {
        const tmsAt = gates.arrival?.at || state.latestEventAt || state.updatedAt || "";
        gates.arrival = gate("arrival", "not-arrived", "Current TMS/source evidence does not prove destination arrival.", {
          at: tmsAt,
          source: "shipment-state-sanity",
          confidence: "high",
        });
        if (statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"])) {
          gates.pickup = gate("pickup", "waiting", "Pickup execution is not proven by current AWB-scoped source evidence.", {
            at: gates.pickup?.at || tmsAt,
            source: "shipment-state-sanity",
            confidence: "high",
          });
        }
        if (statusIs(gates.delivery, ["scheduled", "out-for-delivery", "delivered", "reported"])) {
          gates.delivery = gate("delivery", "waiting", "Delivery is not applicable until arrival and pickup execution are proven.", {
            at: gates.delivery?.at || tmsAt,
            source: "shipment-state-sanity",
            confidence: "high",
          });
        }
        gates.pod = gate("pod", "waiting", "POD is not applicable before final delivery.", {
          at: gates.pod?.at || tmsAt,
          source: "shipment-state-sanity",
          confidence: "high",
        });
      }
      const releaseReadyArrivalInference = releaseReadyArrivalInferenceFact(facts);
      if (
        releaseReadyArrivalInference &&
        statusIs(gates.fees, ["due", "pending", "unpaid"]) &&
        !directGroundFeeDueEvidence(facts)
      ) {
        gates.fees = gate("fees", "waiting", "No direct ground-fee due proof exists; pickup execution is the current layer.", {
          at: releaseReadyArrivalInference.at || gates.fees?.at || state.latestEventAt || state.updatedAt || "",
          source: releaseReadyArrivalInference.source || "email-first-truth",
          confidence: "medium",
        });
      }
      const downstreamExecutionStarted =
        (!tmsBlocksUnprovenArrival || terminalCompletionNeedsCertification) && !onwardHandlerTransfer && (
          statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) ||
          statusIs(gates.delivery, ["out-for-delivery", "delivered", "reported"]) ||
          statusIs(gates.pod, ["done", "received", "pod-found", "found"])
        );
      const downstreamExecutionAt = first(gates.pickup?.at, gates.delivery?.at, gates.pod?.at, state.latestEventAt, state.updatedAt);
      const releaseBlockerAfterDownstream =
        eventTime(factOccurredAt(emailReleaseBlocker)) &&
        eventTime(downstreamExecutionAt) &&
        eventTime(factOccurredAt(emailReleaseBlocker)) > eventTime(downstreamExecutionAt);
      if (downstreamExecutionStarted && !releaseBlockerAfterDownstream) {
        if (!statusIs(gates.arrival, ["done", "arrived", "available", "on-hand", "incomplete"])) {
          gates.arrival = gate("arrival", "done", "Pickup/delivery execution proves the cargo reached destination control.", {
            at: downstreamExecutionAt,
            source: gates.pickup?.source || gates.delivery?.source || "shipment-state-sanity",
            confidence: "high",
          });
        }
        if (!statusIs(gates.customs, ["done", "released", "cleared"])) {
          gates.customs = gate("customs", "unknown-offline", "Pickup/delivery happened after the release gap; direct release/DO proof is missing, but it is not the active blocker.", {
            at: downstreamExecutionAt,
            source: gates.pickup?.source || gates.delivery?.source || "shipment-state-sanity",
            confidence: "medium",
          });
        }
        if (!statusIs(gates.fees, ["done", "paid"]) && !directGroundFeeDueEvidence(facts)) {
          gates.fees = gate("fees", "unknown-offline", "Pickup/delivery happened; direct fee proof is missing, but fee payment is not the active blocker.", {
            at: downstreamExecutionAt,
            source: gates.pickup?.source || gates.delivery?.source || "shipment-state-sanity",
            confidence: "medium",
          });
        }
        if (!statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"])) {
          gates.dispatch = gate("dispatch", "done", "Pickup/delivery execution proves a dispatch path existed; direct broker award proof remains a source gap.", {
            at: downstreamExecutionAt,
            source: gates.pickup?.source || gates.delivery?.source || "shipment-state-sanity",
            confidence: "medium",
          });
        }
      }
      if (!finalPod && !downstreamExecutionStarted && !terminalCompletionNeedsCertification && !statusIs(gates.customs, ["done", "released", "cleared", "unknown-offline"])) {
      const livePickupException = statusIs(gates.pickup, ["driver-onsite", "onsite", "blocked", "exception", "incomplete"]);
      if (!livePickupException) {
        gates.pickup = gate("pickup", statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"]) ? "blocked" : "waiting", "Pickup cannot proceed until customs release/DO is confirmed.", {
          at: gates.pickup?.at || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
          source: "shipment-state-sanity",
          confidence: "high",
        });
      }
      gates.delivery = gate("delivery", "waiting", "Delivery is not applicable before customs release and pickup.", {
        at: gates.delivery?.at || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
      gates.pod = gate("pod", "waiting", "POD is not applicable before delivery.", {
        at: gates.pod?.at || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
    }
    const arrivalRequestOnly = requestOnlyArrivalEvidence(facts);
    if (arrivalRequestOnly && gates.arrival?.status === "done" && !activeArrivalReady) {
      gates.arrival = gate("arrival", "not-arrived", "Arrival notice was requested, not received.", {
        at: gates.arrival.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
    }
    const falsePickupArrangement = pickupArrangementOnlyEvidence(facts, gates);
    const pickupGateTime = eventTime(gates.pickup?.at);
    const falsePickupArrangementTime = eventTime(falsePickupArrangement?.at);
    const falsePickupArrangementIsFuture =
      falsePickupArrangementTime &&
      falsePickupArrangementTime > Date.now() + 5 * 60 * 1000;
    const falsePickupArrangementIsOlder =
      pickupGateTime &&
      falsePickupArrangementTime &&
      (falsePickupArrangementTime < pickupGateTime || falsePickupArrangementIsFuture);
    if (falsePickupArrangement && !falsePickupArrangementIsOlder && statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"])) {
      gates.pickup = gate("pickup", "pending", "Pickup arrangement/request was not physical pickup proof.", {
        at: falsePickupArrangement.at || gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
      if (statusIs(gates.customs, ["unknown-offline"])) {
        gates.customs = gate("customs", "pending", "Release/DO still needs direct proof; false pickup evidence cannot infer release.", {
          at: gates.customs?.at || falsePickupArrangement.at || state.latestEventAt || state.updatedAt || "",
          source: "shipment-state-sanity",
          confidence: "high",
        });
      }
    }
    const dispatchLifecycleGate = dispatchGateFromLifecycleFact(dispatchLifecycleFact(facts));
    if (
      dispatchLifecycleGate &&
      (
        !gates.dispatch?.at ||
        eventTime(dispatchLifecycleGate.at) >= eventTime(gates.dispatch?.at) ||
        statusIs(gates.dispatch, ["unknown", "waiting", "pending", "missing"])
      )
    ) {
      gates.dispatch = dispatchLifecycleGate;
    }
    const latestPickupExecution = latestDirectPickupExecutionFact(facts, state);
    const latestPickupExecutionAt = eventTime(factOccurredAt(latestPickupExecution));
    const pickupGateAt = eventTime(gates.pickup?.at);
    if (latestPickupExecution && !onwardHandlerTransfer && (!pickupGateAt || latestPickupExecutionAt >= pickupGateAt || statusIs(gates.pickup, ["blocked", "exception", "incomplete", "unknown", "waiting", "pending"]))) {
      gates.arrival = statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"])
        ? gates.arrival
        : gate("arrival", "done", "Pickup execution proves the cargo reached destination control.", {
          at: factOccurredAt(latestPickupExecution),
          source: latestPickupExecution.source || "email-first-truth",
          confidence: latestPickupExecution.confidence || "high",
        });
      if (!statusIs(gates.customs, ["done", "released", "cleared"]) && !directEmailCustomsBlockerExists(facts)) {
        gates.customs = gate("customs", "unknown-offline", "Pickup execution happened; direct release/DO proof may be missing, but it is not the active blocker.", {
          at: factOccurredAt(latestPickupExecution),
          source: latestPickupExecution.source || "email-first-truth",
          confidence: latestPickupExecution.confidence || "medium",
        });
      }
      if (!statusIs(gates.fees, ["done", "paid"]) && !directGroundFeeDueEvidence(facts)) {
        gates.fees = gate("fees", "unknown-offline", "Pickup execution happened; direct fee proof may be missing, but it is not the active blocker.", {
          at: factOccurredAt(latestPickupExecution),
          source: latestPickupExecution.source || "email-first-truth",
          confidence: latestPickupExecution.confidence || "medium",
        });
      }
      if (!statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded"])) {
        const broker = cleanDispatchBrokerName(gates.dispatch?.broker || gates.dispatch?.selectedBroker || latestPickupExecution.broker || latestPickupExecution.selectedBroker || "");
        gates.dispatch = gate("dispatch", "done", broker
          ? `${broker} is the active pickup dispatch path; pickup execution confirms it.`
          : "Pickup execution proves a dispatch path existed; direct broker award proof remains a source gap.", {
          at: factOccurredAt(latestPickupExecution),
          source: latestPickupExecution.source || "email-first-truth",
          confidence: latestPickupExecution.confidence || "medium",
          broker,
          selectedBroker: broker,
          contactEmail: gates.dispatch?.contactEmail || latestPickupExecution.contactEmail || latestPickupExecution.email || "",
          amount: gates.dispatch?.amount || gates.dispatch?.rate || latestPickupExecution.amount || latestPickupExecution.rate || "",
        });
      }
      gates.pickup = gate("pickup", "done", latestPickupExecution.summary || latestPickupExecution.evidence || "Pickup is confirmed; track delivery and POD.", {
        at: factOccurredAt(latestPickupExecution),
        source: latestPickupExecution.source || "email-first-truth",
        confidence: latestPickupExecution.confidence || "high",
      });
      const deliveryScheduledFact = latestDeliveryScheduledFact(facts);
      if (deliveryScheduledFact && eventTime(factOccurredAt(deliveryScheduledFact)) >= latestPickupExecutionAt) {
        gates.delivery = gate("delivery", "scheduled", deliveryScheduledFact.summary || deliveryScheduledFact.evidence || "Delivery is scheduled; collect POD after completion.", {
          at: factOccurredAt(deliveryScheduledFact),
          source: deliveryScheduledFact.source || "email-first-truth",
          confidence: deliveryScheduledFact.confidence || "high",
          deliveryScheduledDate: deliveryScheduledFact.deliveryScheduledDate || "",
        });
        if (!statusIs(gates.pod, ["done", "received", "pod-found", "found"])) {
          gates.pod = gate("pod", "pending", "POD is needed after scheduled delivery completes.", {
            at: factOccurredAt(deliveryScheduledFact),
            source: deliveryScheduledFact.source || "email-first-truth",
            confidence: deliveryScheduledFact.confidence || "high",
          });
        }
      } else if (!statusIs(gates.pod, ["done", "received", "pod-found", "found"])) {
        if (
          statusIs(gates.delivery, ["blocked", "exception", "problem", "scheduled"]) &&
          (!eventTime(gates.delivery?.at) || latestPickupExecutionAt >= eventTime(gates.delivery?.at))
        ) {
          gates.delivery = gate("delivery", "waiting", "Pickup execution supersedes the older station/delivery blocker; final delivery is not proven yet.", {
            at: factOccurredAt(latestPickupExecution),
            source: latestPickupExecution.source || "email-first-truth",
            confidence: latestPickupExecution.confidence || "high",
          });
        }
        gates.pod = gate("pod", "pending", "POD is needed after pickup.", {
          at: factOccurredAt(latestPickupExecution),
          source: latestPickupExecution.source || "email-first-truth",
          confidence: latestPickupExecution.confidence || "high",
        });
      }
    }
    if (
      releaseResolver &&
      statusIs(gates.customs, ["done", "released", "cleared"]) &&
      statusIs(gates.pickup, ["blocked", "exception", "incomplete"]) &&
      pickupGateResolvedByRelease(gates.pickup, releaseResolver)
    ) {
      gates.pickup = gate("pickup", "waiting", "Older customs/inbond pickup blocker was superseded by later release evidence.", {
        at: factOccurredAt(releaseResolver) || gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: releaseResolver.source || "email-first-truth",
        confidence: releaseResolver.confidence || "high",
      });
    }
    const pickupBlocker = pickupBlockedEvidence(facts, releaseResolver, group.awb);
    const arrivalIncomplete = arrivalIncompleteEvidence(facts);
    const arrivalIncompleteAt = eventTime(factOccurredAt(arrivalIncomplete));
    const currentArrivalProofRetiresIncomplete =
      currentArrivalProofAt && (!arrivalIncompleteAt || currentArrivalProofAt >= arrivalIncompleteAt);
    if (arrivalIncomplete && !currentArrivalProofRetiresIncomplete && gates.arrival?.status === "done" && gates.pickup?.status !== "done") {
      gates.arrival = gate("arrival", "incomplete", arrivalIncomplete.summary, {
        at: arrivalIncomplete.at || gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: arrivalIncomplete.source || "shipment-state-sanity",
        confidence: arrivalIncomplete.confidence || "high",
      });
    }
      if (pickupBlocker && gates.arrival?.status !== "not-arrived" && gates.pickup?.status !== "done") {
        const blockerSummary = /piece|3[-\s]?v|4[-\s]?piece|mismatch|discrepanc/i.test(pickupBlocker.summary || "")
          ? `Station piece-count mismatch: ${pickupBlocker.summary}`
          : pickupBlocker.summary;
        gates.pickup = gate("pickup", "blocked", blockerSummary, {
        at: pickupBlocker.at || gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: pickupBlocker.source || "shipment-state-sanity",
          confidence: pickupBlocker.confidence || "high",
        });
        if (
          !emailReleaseBlocker &&
          !statusIs(gates.customs, ["done", "released", "cleared", "blocked", "customs-hold", "hold", "exam-hold"])
        ) {
          gates.customs = gate("customs", "unknown-offline", "No customs hold is proven; the live blocker is station/pickup visibility.", {
            at: pickupBlocker.at || gates.customs?.at || state.latestEventAt || state.updatedAt || "",
            source: pickupBlocker.source || "email-first-truth",
            confidence: pickupBlocker.confidence || "medium",
          });
        }
      }
      const forcePreArrival = (tmsArrivalProvenByMetadata || positiveArrivalFact || facts.some(strongScopedArrivalEvidenceFact))
        ? ""
        : preArrivalOverride(group, facts) || preArrivalFlightUpdateEvidence(facts);
      const scheduledPickupGate = gates.pickup?.status === "scheduled" ? gates.pickup : null;
      const scopedAwb = state.awb || active.awb || brain.awb || group.awb;
      const exceptionItems = openExceptionItems({ ...state, exceptions: [...array(state.exceptions), ...factExceptions] }, group.awb)
        .filter((item) => !foreignScopedReleaseTextForAwb(`${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`, scopedAwb))
        .filter((item) => {
          const itemText = `${item.type || ""} ${item.exceptionType || ""} ${item.impact || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
          if (!/\b(?:broker[-_\s]?release[-_\s]?pending|release[-_\s]?pending|customs[-_\s]?release[-_\s]?needed)\b/i.test(itemText)) return true;
          return releaseGapExceptionItem(item, scopedAwb);
        })
        .filter((item) => !exceptionSupersededByFacts(item, facts));
      const validReleaseGapException = exceptionItems.some((item) => releaseGapExceptionItem(item, scopedAwb));
      const airportExecutionStarted =
        !onwardHandlerTransfer && (
        statusIs(gates.pickup, ["driver-onsite", "onsite", "done", "picked-up", "loaded", "recovered"]) ||
        statusIs(gates.delivery, ["scheduled", "delivered", "reported"]) ||
        statusIs(gates.pod, ["done", "received", "pod-found", "found"])
        );
      const explicitExceptionState = String(state.phase || "").toLowerCase() === "exception" && exceptionItems.length > 0 || exceptionItems.length > 0;
      if (forcePreArrival && !customsHoldArrivalInference && !airportExecutionStarted && !explicitExceptionState) {
      gates.arrival = gate("arrival", "not-arrived", forcePreArrival, {
        at: gates.arrival?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "high",
      });
      const customsText = [
        gates.customs?.status,
        gates.customs?.evidence,
        active.clearanceStatus,
        active.customsBroker?.status,
        active.customsBroker?.brokerStatus,
        active.customsBroker?.nextAction,
        brain.clearanceStatus,
        brain.customsBroker?.status,
        brain.customsBroker?.brokerStatus,
        brain.customsBroker?.nextAction,
        facts.map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`).join(" "),
      ].filter(Boolean).join(" ");
      if (
        statusIs(gates.customs, ["done", "released", "cleared"]) &&
        (
          !String(gates.customs?.evidence || "").trim() ||
          /\bunknown\b/i.test(gates.customs?.evidence || "") ||
          /\b(?:not[-\s]?cleared|customs[-\s]?pending|no (?:u\.s\. )?release|no release\/?d\/?o|release\/?d\/?o proof (?:yet|missing)|no release|release pending|clearance pending|follow .*for clearance|follow .*for release)\b/i.test(customsText)
        )
      ) {
        gates.customs = gate("customs", "pending", "Release/DO is not confirmed yet.", {
          at: gates.customs?.at || state.latestEventAt || state.updatedAt || "",
          source: "shipment-state-sanity",
          confidence: "high",
        });
      }
      if (statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"]) && !directEmailCustomsBlockerExists(facts)) {
        gates.customs = gate("customs", "pending", "Release/DO is not confirmed yet.", {
          at: gates.customs?.at || state.latestEventAt || state.updatedAt || "",
          source: "shipment-state-sanity",
          confidence: "high",
        });
      }
      gates.fees = gate("fees", "waiting", "not applicable before destination arrival", { source: "shipment-state-sanity" });
      gates.dispatch = gate("dispatch", "waiting", "not applicable before destination arrival", { source: "shipment-state-sanity" });
      gates.pickup = scheduledPickupGate || gate("pickup", "waiting", "not picked up", { source: "shipment-state-sanity" });
      gates.delivery = gate("delivery", "waiting", "not delivered", { source: "shipment-state-sanity" });
      gates.pod = gate("pod", "waiting", "not applicable before delivery", { source: "shipment-state-sanity" });
    }
    const arrivalDowngradedToNotArrived =
      gates.arrival?.status === "not-arrived" &&
      /requested, not proven|requested, not received|not proven by shipment-state/i.test(gates.arrival?.evidence || "");
    if (foreignScopedReleaseTextForAwb(`${gates.customs?.evidence || ""} ${gates.customs?.summary || ""}`, group.awb)) {
      gates.customs = gate("customs", "unknown", "Release/DO blocker belonged to another AWB; customs release remains unconfirmed for this row.", {
        at: gates.customs?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "medium",
      });
    }
    if (foreignScopedReleaseTextForAwb(`${gates.pickup?.evidence || ""} ${gates.pickup?.summary || ""}`, group.awb)) {
      gates.pickup = gate("pickup", "waiting", "Pickup is not proven; the inherited release blocker belonged to another AWB.", {
        at: gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "medium",
      });
    }
    if (
      statusIs(gates.pickup, ["blocked", "exception", "incomplete"]) &&
      !validReleaseGapException &&
      releaseBlockerRelevantText(`${gates.pickup?.evidence || ""} ${gates.pickup?.summary || ""}`)
    ) {
      gates.pickup = gate("pickup", "waiting", "Pickup is not proven; the inherited release blocker was not scoped to this AWB.", {
        at: gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: "shipment-state-sanity",
        confidence: "medium",
      });
    }
    const pickupGateBlockerText = `${gates.pickup?.status || ""} ${gates.pickup?.evidence || ""} ${gates.pickup?.summary || ""}`;
    const stalePickupGateAt = eventTime(gates.pickup?.at);
    if (
      statusIs(gates.pickup, ["blocked", "exception", "incomplete"]) &&
      currentArrivalProofAt &&
      stationAvailabilityBlockerText(pickupGateBlockerText) &&
      (!stalePickupGateAt || currentArrivalProofAt >= stalePickupGateAt)
    ) {
      gates.pickup = gate("pickup", "waiting", "Older station availability blocker was superseded by later arrival/on-hand evidence; pickup execution is not proven yet.", {
        at: new Date(currentArrivalProofAt).toISOString(),
        source: "shipment-state-sanity",
        confidence: "high",
      });
    }
    const arrivalGateIsNotArrived =
      gates.arrival?.status === "not-arrived" &&
      !airportExecutionStarted &&
      !explicitExceptionState;
    const currentMovementPromotion = activeArrivalReady || activeCustomsReleaseEvidence;
      const latestPickupExecutionForExceptionAt = Math.max(
        latestPickupExecutionAt || 0,
        statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"])
          ? eventTime(gates.pickup?.at)
          : 0,
      );
      const pickupExecutionSupersedesException = (item = {}) => {
        if (!latestPickupExecutionForExceptionAt) return false;
        const textValue = `${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
        if (!/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver[-_\s]?waiting|pickup[-_\s]?blocked|station|pickup|driver|not locate|cannot locate|can't locate|cant locate|not found|detention)\b/i.test(textValue)) {
          return false;
        }
        const exceptionAt = eventTime(item.at);
        return !exceptionAt || latestPickupExecutionForExceptionAt >= exceptionAt;
      };
      const arrivalProofSupersedesMovementException = (item = {}) => {
        if (!currentArrivalProofAt) return false;
        const textValue = `${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
        if (!movementSplitOffloadText(textValue)) return false;
        const exceptionAt = eventTime(item.at);
        return !exceptionAt || currentArrivalProofAt >= exceptionAt;
      };
      let effectiveExceptionItems = exceptionItems
        .filter((item) => !pickupExecutionSupersedesException(item))
        .filter((item) => !arrivalProofSupersedesMovementException(item));
      if (downstreamExecutionStarted && !releaseBlockerAfterDownstream) {
        effectiveExceptionItems = effectiveExceptionItems.filter((item) => !releaseGapExceptionItem(item, state.awb));
      }
      const sanitizedByEvidence = emailReleaseBlocker || nonFinalRelease || finalRelease || onwardHandlerTransfer || currentMovementPromotion || arrivalRequestOnly || arrivalDowngradedToNotArrived || falsePickupArrangement || pickupBlocker || arrivalIncomplete || state._mergedShipmentStateRows > 1 || effectiveExceptionItems.length !== exceptionItems.length;
      const gatePhase = nextPhaseFromGates(gates);
      const exceptionPhase = finalPod ? "" : activeExceptionPhase({ ...state, exceptions: effectiveExceptionItems }, gates);
    const statePhase = String(state.phase || "").trim();
    const phase = finalPod
      ? gatePhase
      : exceptionPhase ||
        ((forcePreArrival || arrivalDowngradedToNotArrived || arrivalGateIsNotArrived) && !airportExecutionStarted && !explicitExceptionState
          ? "pre-arrival"
          : sanitizedByEvidence
            ? gatePhase
            : statePhase || gatePhase);
    const phasePromotedByEvidence =
      sanitizedByEvidence &&
      phase &&
      phase !== statePhase &&
      !((forcePreArrival || arrivalDowngradedToNotArrived) && !airportExecutionStarted);
    const closeoutSummary = finalPod ? finalPod.summary || "Delivered; POD is in memory." : "";
    const exception = preferredExceptionForPhase(effectiveExceptionItems, exceptionPhase, gates, state.awb);
    const exceptionSummary = exceptionPhase ? first(exception?.summary, state.summary, state.currentState, canonicalPhaseSummary(exceptionPhase)) : "";
    const gateNextAction = nextActionFromGates(gates, metadata);
    const rawExceptionNextAction = exceptionPhase ? first(exception?.nextAction, state.nextAction, gateNextAction) : "";
    const clearanceScopeWithOnsitePickup =
      exceptionPhase &&
      statusIs(gates.pickup, ["driver-onsite", "onsite"]) &&
      /\bclearance[-_\s]?scope[-_\s]?ambiguous|release[-_\s]?scope[-_\s]?unknown|different mawb|exact awb\b/i.test(`${exception?.type || ""} ${exception?.impact || ""} ${exception?.summary || ""} ${exception?.evidence || ""} ${rawExceptionNextAction}`);
    let exceptionNextAction =
      clearanceScopeWithOnsitePickup
        ? driverOnsiteNextAction(gates)
        : /review (?:the )?(?:evidence )?thread|decide (?:the )?(?:next )?operator move/i.test(rawExceptionNextAction) &&
      (exceptionPhase === "customs-hold" || statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"]))
        ? ""
        : rawExceptionNextAction;
    if (
      statusIs(gates.pickup, ["driver-onsite", "onsite"]) &&
      /\b(?:clearance[-_\s]?scope|release[-_\s]?scope|different mawb|exact awb)\b/i.test(`${exceptionNextAction || ""} ${rawExceptionNextAction || ""} ${state.nextAction || ""} ${exceptionSummary || ""}`)
    ) {
      exceptionNextAction = driverOnsiteNextAction(gates);
    }
    const phaseLabel = canonicalPhaseSummary(phase);
      const stateSummary = forcePreArrival && !exceptionPhase
        ? first(forcePreArrival, phaseLabel, phase)
        : first(state.summary, state.currentState, phase);
    const releaseCompletePrefix =
      phase === "ready-for-pickup" &&
      statusIs(gates.customs, ["done", "released", "cleared"]) &&
      stateSummary &&
      !/\b(?:released|cleared)\b/i.test(stateSummary)
        ? "Customs released; "
        : "";
    const phaseAwareSummary =
      stateSummary && phaseLabel && !String(stateSummary).toLowerCase().includes(String(phaseLabel).toLowerCase())
        ? `${phaseLabel}: ${releaseCompletePrefix}${stateSummary}`
        : stateSummary;
    const stateNextActionStillMatchesPhase =
      state.nextAction &&
      statePhase &&
      phase === statePhase &&
      !phasePromotedByEvidence;
    const selectedNextAction = first(
      arrivalDowngradedForMissingProof ? gateNextAction || "Monitor arrival; do not dispatch pickup yet." : "",
      exceptionNextAction,
      finalPod ? gateNextAction : "",
      !arrivalDowngradedForMissingProof && stateNextActionStillMatchesPhase ? state.nextAction : "",
      sanitizedByEvidence || exceptionPhase ? gateNextAction : "",
      arrivalDowngradedForMissingProof ? gateNextAction || "Monitor arrival; do not dispatch pickup yet." : state.nextAction,
      gateNextAction,
    );
    const finalNextAction =
      statusIs(gates.pickup, ["driver-onsite", "onsite"]) &&
      /\b(?:clearance[-_\s]?scope|release[-_\s]?scope|different mawb|exact awb|release\/?d\.?o)\b/i.test(`${selectedNextAction || ""} ${state.nextAction || ""} ${exceptionSummary || ""} ${exceptionItems.map((item) => `${item.type || ""} ${item.summary || ""} ${item.nextAction || ""}`).join(" ")}`)
        ? "Carrier/driver is onsite; verify exact release/DO scope for this AWB, get loaded proof if station will release, and keep detention from growing."
        : selectedNextAction;
    return {
      phase,
      label: first(closeoutSummary, exceptionSummary, phasePromotedByEvidence ? phaseLabel : "", phaseAwareSummary, phase),
      summary: first(closeoutSummary, exceptionSummary, phasePromotedByEvidence ? phaseLabel : "", phaseAwareSummary, phase),
      nextAction: finalNextAction,
      gates,
      storage: storageFromText([state.summary, state.nextAction, facts.map((fact) => fact.summary).join(" ")].join(" ")),
      exceptions: effectiveExceptionItems.filter((item) => !(gates.customs?.status === "done" && /customs-hold|government hold|exam hold/i.test(`${item.type || ""} ${item.summary || ""}`))),
      confidence: state.confidence || "high",
      source: "canonical-shipment-state",
      updatedAt: first(state.latestEventAt, state.updatedAt),
      metadata,
    };
  }
  const text = [
    state.phase,
    state.currentState,
    state.nextAction,
    active.clearanceStatus,
    active.customsBroker?.status,
    active.customsBroker?.brokerStatus,
    active.stage,
    active.currentState,
    active.nextAction,
    active.pod?.recipient,
    active.freightBroker?.status,
    active.freightBroker?.brokerStatus,
    active.freightBroker?.pickupPlan,
    active.freightBroker?.deliveryPlan,
    brain.clearanceStatus,
    brain.customsBroker?.status,
    brain.customsBroker?.brokerStatus,
    brain.stage,
    brain.currentState,
    brain.nextAction,
    brain.pod?.recipient,
    brain.freightBroker?.status,
    brain.freightBroker?.brokerStatus,
    brain.freightBroker?.pickupPlan,
    brain.freightBroker?.deliveryPlan,
    facts.map((fact) => `${fact.label} ${fact.summary}`).join(" "),
  ].join(" ");

  const positiveArrivalProof = facts.some(positiveArrivalEvidenceFact);
  const tmsBlocksUnprovenArrival = tmsContradictsDestinationArrival(active, brain, {
    ...tmsShipment,
    flightDetails: metadata.flightDetails,
    nextTask: first(tmsShipment.nextTask, metadata.flightDetails?.recoveryHint, metadata.flightDetails?.etaHint),
    status: first(tmsShipment.status, tmsShipment.tmsStatus, metadata.tms?.status, metadata.tms?.tmsStatus),
    tmsStatus: first(tmsShipment.tmsStatus, tmsShipment.status, metadata.tms?.tmsStatus, metadata.tms?.status),
  }) && !facts.some(strongScopedArrivalEvidenceFact);
  const explicitArrived = /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(String(active.arrivalStatus || brain.arrivalStatus || "").trim());
  const explicitNotArrived = /^(?:not[-\s]?arrived|in[-\s]?transit|pending|waiting|missing|unknown)$/i.test(String(active.arrivalStatus || brain.arrivalStatus || "").trim());
  // The previous cycle's own published arrivalStatus must not overrule a
  // substantive non-positive verdict from THIS cycle's scrubbed arrival gate
  // (self-feedback: a healed false arrival kept resurrecting through the
  // inherited label — 2026-07-06, 016-80000165).
  const arrivalGateNonPositive = ["blocked", "incomplete", "not-arrived", "waiting", "pending"].includes(
    String(state.gates?.arrival?.status || "").toLowerCase(),
  );
  const arrived = !tmsBlocksUnprovenArrival && (
    (explicitArrived && !arrivalGateNonPositive) ||
    positiveArrivalProof ||
    !explicitNotArrived && !arrivalGateNonPositive && positive(text, ["arrived", "arrival notice", "on hand", "available for pickup"]) && !positive(text, ["not arrived", "no arrival", "arrival pending"])
  );
  const structuredPickupValues = [
    active.pickupStatus,
    brain.pickupStatus,
    active.deliveryStatus,
    brain.deliveryStatus,
    active.freightBroker?.status,
    brain.freightBroker?.status,
    active.emailValidation?.status,
    brain.emailValidation?.status,
  ];
  const structuredPodValues = [
    active.pod?.status,
    brain.pod?.status,
    active.freightBroker?.status,
    brain.freightBroker?.status,
    active.emailValidation?.status,
    brain.emailValidation?.status,
  ];
  const podAcceptedStatuses = [
    "pod-found",
    "pod-received",
    "pod-attached",
    "received",
    "found",
    "signed",
    "accepted",
    "done",
    "delivered-pod-received",
    "delivered-pod-found",
    "delivered-pod-found-invoice-received",
    "freight-delivered-pod-found",
    "freight-delivered-pod-found-invoice-received",
  ];
  const structuredDelivered = structuredPickupValues.some((value) => positiveStructuredStatus(value, ["delivered", "delivery-complete", "completed", "delivered-pod-received", "delivered-pod-found", "freight-delivered-pod-found"]));
  const structuredOutForDelivery = structuredPickupValues
    .concat(active.deliveryStatus, brain.deliveryStatus)
    .some((value) => positiveStructuredStatus(value, ["out-for-delivery", "out for delivery", "out-for-del", "ofd"]));
  const structuredPickedUp = structuredPickupValues.some((value) => positiveStructuredStatus(value, ["picked-up", "loaded", "recovered", "out-for-delivery", "out for delivery", "out-for-del", "ofd"]));
  const structuredPodFound = structuredPodValues.some((value) => positiveStructuredStatus(value, podAcceptedStatuses));
  const structuredGmailPodFound = facts.some((fact) => structuredGmailPodProofLooksFinal(fact));
  const podPositiveFact = facts.some((fact) => {
    const value = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
    return /\b(?:pod attached|pod found|pod received|attached pod|attached is (?:the )?pod|proof of delivery attached|proof of delivery received|pod proof|pod images|signature|signed pod|delivered to receiver|delivered-pod-received|delivered-pod-found|proof of delivery)\b/i.test(value) &&
      !podNegatedText(value);
  });
  const podFound = structuredPodFound || structuredGmailPodFound || podPositiveFact || (!podNegatedText(text) && positive(text, ["pod attached", "pod found", "pod received", "attached pod", "attached is the pod", "attached is pod", "proof of delivery attached", "proof of delivery received", "pod proof", "pod images", "signature", "signed pod", "delivered to receiver", "delivered-pod-received", "delivered-pod-found"]));
  const conditionalDelivery = /\b(?:once|when|after)\b[^.;\n]{0,80}\bdelivered\b|\bwill be delivered\b|\bwill deliver\b|\bscheduled (?:for )?delivery\b/i.test(text);
  const onwardHandlerTransfer = latestOnwardHandlerTransferFact(facts, state);
  const finalDeliveryProofPresent = Boolean(finalPodEvidence(facts, active, brain, state) || shipmentStateHasFinalDeliveryProof(state));
  const directPickupProofPresent = directPickupExecutionFact(facts, state);
  let delivered = structuredDelivered || (podFound || positive(text, ["delivered", "delivery completed", "pod accepted"])) &&
    !conditionalDelivery &&
    !positive(text, ["not delivered", "scheduled for delivery", "will deliver", "pod pending"]);
  if (tmsBlocksUnprovenArrival && !finalDeliveryProofPresent) delivered = false;
  if (onwardHandlerTransfer && !finalDeliveryProofPresent) delivered = false;
  const outForDelivery = !onwardHandlerTransfer && !delivered && (
    structuredOutForDelivery ||
    /\b(?:out for delivery|out for del|out[-\s]?for[-\s]?delivery|\bofd\b)\b/i.test(text)
  );
  let pickedUp = delivered || structuredPickedUp || (!pickupArrangementOnlyText(text) && positive(text, ["picked up", "driver loaded", "loaded and will deliver", "recovered"]) && !positive(text, ["not picked up", "pickup pending"]));
  if (tmsBlocksUnprovenArrival && !finalDeliveryProofPresent && !directPickupProofPresent) pickedUp = false;
  if (onwardHandlerTransfer && !finalDeliveryProofPresent && !directPickupProofPresent) pickedUp = false;
  const structuredCustomsText = [
    active.customsBroker?.brokerStatus,
    active.customsBroker?.nextAction,
    ...(active.customsBroker?.evidence || []).map(factText),
    active.emailValidation?.status,
    active.emailValidation?.summary,
    active.emailValidation?.nextAction,
    ...(active.emailValidation?.proof || []).map(factText),
    ...(active.emailValidation?.events || []).map(factText),
    ...(active.gmailEvents || []).map(factText),
    ...(active.events || []).map(factText),
    brain.customsBroker?.brokerStatus,
    brain.customsBroker?.nextAction,
    ...(brain.customsBroker?.evidence || []).map(factText),
    brain.emailValidation?.status,
    brain.emailValidation?.summary,
    brain.emailValidation?.nextAction,
    ...(brain.emailValidation?.proof || []).map(factText),
    ...(brain.emailValidation?.events || []).map(factText),
    ...(brain.gmailEvents || []).map(factText),
    ...(brain.events || []).map(factText),
  ].filter(Boolean).join(" ");
  const latestFinalReleaseFact = latestExternalFinalCustomsReleaseFact(facts);
  const activeCustomsReleaseEvidence = existingCustomsReleaseEvidence(active, brain);
  const emailReleaseBlocker = activeCustomsReleaseEvidence ? null : authoritativeEmailReleaseBlockerFact(facts, state.awb || active.awb || brain.awb);
  const releaseResolver = !emailReleaseBlocker ? latestFinalReleaseFact : null;
  const structuredCustomsHold =
    !releaseResolver &&
    !/\bpdf-customs-hold\b/i.test(structuredCustomsText) &&
    /\b(?:customs[-\s]?hold|exam[-\s]?hold|government hold|u\.?s\.? customs exam)\b/i.test(structuredCustomsText);
  const structuredReleaseNegated = /\b(?:not|no|pending|waiting|hasn'?t|has not|still)\b[^.;\n]{0,80}\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b|\b(?:released?|cleared|clearance|customs|d\/?o|delivery order)\b[^.;\n]{0,80}\b(?:not|pending|waiting|missing|needed|yet)\b/i.test(structuredCustomsText);
  const directFinalReleaseFact = Boolean(latestFinalReleaseFact);
  const releaseNegatedText = Boolean(emailReleaseBlocker) ||
    /\b(?:find|search|ask|push|confirm|need|needs|needed|missing|pending|waiting|not|no|without|still)\b[^.;\n]{0,120}\b(?:customs release|release|released|clearance|cleared|d\/?o|delivery order)\b|\b(?:customs release|release|released|clearance|cleared|d\/?o|delivery order)\b[^.;\n]{0,120}\b(?:not|pending|waiting|missing|needed|unconfirmed|not confirmed|still needed|still pending|yet)\b/i.test(text);
  const released = !emailReleaseBlocker && (activeCustomsReleaseEvidence || directFinalReleaseFact || !releaseNegatedText && !releaseTextLooksTmsOnly(text) && positive(text, ["98 released", "1c posted", "customs release"]) && !positive(text, ["not released", "no release", "customs hold", "exam"]));
  const genericCustomsHoldText = !releaseResolver &&
    /\bcustoms hold\b/i.test(text) &&
    !/\b(?:customs\/release still blocking|release still blocking|release pending|customs pending|not cleared|no release|release\/d\.?o pending|broker)\b/i.test(text);
  const customsHold = Boolean(emailReleaseBlocker && releaseBlockerGateStatus(emailReleaseBlocker) === "blocked") ||
    structuredCustomsHold ||
    genericCustomsHoldText ||
    positive(text, ["exam hold", "government hold"]);
  const inferredArrivedByCustomsHold = customsHold &&
    !pickedUp &&
    !delivered &&
    !facts.some((fact) => {
      if (!sourceLooksEmailOrOperator(fact) || sourceLooksTmsOrTracking(fact) || generatedGateFact(fact)) return false;
      const factTextValue = factText(fact);
      if (releaseBlockerLanguage(factTextValue)) return false;
      return /\b(?:not[-\s]?arrived|not at destination|in transit|flight (?:has )?not (?:arrived|landed)|awaiting noa|will await.*noa|cargo not on hand)\b/i.test(factTextValue);
    });
  const effectiveArrived = tmsBlocksUnprovenArrival && !finalDeliveryProofPresent && !directPickupProofPresent
    ? false
    : onwardHandlerTransfer && !finalDeliveryProofPresent && !directPickupProofPresent
    ? false
    : arrived || inferredArrivedByCustomsHold;
  const feesPaid = positive(text, ["ground fees paid", "cargosprint paid", "payment confirmed", "receipt"]);
  const feesDue = directGroundFeeDueEvidence(facts);
  const dispatchLifecycleGate = dispatchGateFromLifecycleFact(dispatchLifecycleFact(facts));
  const scheduledDeliveryDate = scheduledDeliveryDateFromFacts(facts);
  const sourceScheduledDelivery = Boolean(scheduledDeliveryDate || latestDeliveryScheduledFact(facts));
  const loadingBlocker = loadingBlockedText(text);
  const releaseVisibilityBlocker = pickupReleaseVisibilityBlockerText(text);
  const activeReleaseVisibilityBlocker = releaseResolver ? "" : releaseVisibilityBlocker;
  const deliveryBlocker = deliveryBlockedText(text);
  const rowAwb = state.awb || active.awb || brain.awb || group.awb;
  const pickupBlocker = pickupBlockedEvidence(facts, releaseResolver, rowAwb) || (loadingBlocker || activeReleaseVisibilityBlocker ? {
    summary: loadingBlocker || activeReleaseVisibilityBlocker,
    at: first(active.updatedAt, brain.updatedAt, state.updatedAt),
    source: "shipment-text-sanity",
    confidence: "high",
  } : null);
  const arrivalIncomplete = arrivalIncompleteEvidence(facts);
  const blockerResolvedByOperator = operatorResolvedBlocker(facts, [pickupBlocker, arrivalIncomplete]);
  const activePickupBlocker = blockerResolvedByOperator ? null : pickupBlocker;
  const activeArrivalIncomplete = blockerResolvedByOperator ? null : arrivalIncomplete;
  const customsUnknownOfflineByPickupBlocker = activePickupBlocker && effectiveArrived && !customsHold && !emailReleaseBlocker && !released;
  const gates = {
    arrival: gate("arrival", activeArrivalIncomplete && effectiveArrived && !pickedUp && !delivered ? "incomplete" : delivered || pickedUp || effectiveArrived ? "done" : "not-arrived", activeArrivalIncomplete ? activeArrivalIncomplete.summary : first(inferredArrivedByCustomsHold ? "Customs/government hold evidence implies the shipment is under destination customs control." : "", active.arrivalStatus, state.gates?.arrival?.evidence, delivered || pickedUp ? "Shipment moved from station; arrival happened." : positiveArrivalProof ? "Arrival evidence found in Gmail thread." : "not arrived")),
    customs: gate("customs", customsHold && !pickedUp && !delivered ? "blocked" : emailReleaseBlocker && !pickedUp && !delivered ? "pending" : (released || pickedUp || delivered) ? "done" : customsUnknownOfflineByPickupBlocker ? "unknown-offline" : effectiveArrived ? "pending" : "waiting", first(emailReleaseBlocker?.summary, state.gates?.customs?.evidence, customsUnknownOfflineByPickupBlocker ? "No customs hold is proven; the live blocker is station/pickup visibility." : "", pickedUp || delivered ? "Shipment moved from station; release path was sufficient for pickup." : "")),
    fees: gate("fees", feesPaid || pickedUp || delivered ? "done" : feesDue ? "due" : "waiting", feesDue ? first(state.gates?.fees?.evidence, "Direct ground-fee due evidence exists.") : pickedUp || delivered ? "Shipment moved from station; fee blocker did not stop pickup." : ""),
    dispatch: pickedUp || delivered
      ? gate("dispatch", "done", "Shipment moved from station; dispatch path was sufficient.")
      : dispatchLifecycleGate || gate("dispatch", /award|alert sent|dispatch|broker/i.test(text) ? "sent" : "waiting", ""),
    pickup: gate("pickup", activePickupBlocker && !pickedUp ? "blocked" : pickedUp ? "done" : effectiveArrived ? "pending" : "waiting", activePickupBlocker ? activePickupBlocker.summary : ""),
    delivery: gate("delivery", deliveryBlocker && !delivered && !outForDelivery ? "blocked" : delivered ? "delivered" : outForDelivery ? "out-for-delivery" : pickedUp && sourceScheduledDelivery ? "scheduled" : "waiting", deliveryBlocker || (outForDelivery ? "TMS/broker status says out for delivery." : scheduledDeliveryDate ? `scheduled delivery ${scheduledDeliveryDate}` : ""), { deliveryScheduledDate: scheduledDeliveryDate }),
    pod: gate("pod", podFound ? "done" : delivered ? "pending" : "waiting", podFound ? "POD/delivery proof accepted in email evidence." : ""),
  };
  const dispatchReadyForPickup = statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"]);
  const feeDueForPickup = statusIs(gates.fees, ["due", "pending", "unpaid"]);
  const feeKnownClearForPickup = statusIs(gates.fees, ["done", "paid", "unknown-offline"]);
  const phase = delivered && podFound
    ? "delivered"
    : delivered
      ? "delivered-pod-pending"
      : outForDelivery
        ? "out-for-delivery"
        : deliveryBlocker
          ? "delivery-blocked"
          : pickedUp
            ? "pod-needed"
            : !effectiveArrived
              ? "pre-arrival"
              : activeArrivalIncomplete
                ? "arrival-incomplete"
                : customsHold
                  ? "customs-hold"
                  : activePickupBlocker && released
                    ? "pickup-blocked"
                    : released && feeDueForPickup
                      ? "fees-needed"
                      : released && (!feeKnownClearForPickup || !dispatchReadyForPickup)
                        ? "not-ready"
                        : released
                          ? "ready-for-pickup"
                          : "release-needed";
  const finalPod = phase === "delivered" ? finalPodEvidence(facts, active, brain, state) : null;
  const closeoutSummary = phase === "delivered" ? first(finalPod?.summary, gates.pod?.evidence, "Delivered; POD is in memory.") : "";
  const exceptions = openExceptionItems({ awb: rowAwb, exceptions: [...exceptionsFromText(text, phase), ...factExceptions] }, rowAwb)
    .filter((item) => {
      const itemText = `${item.type || ""} ${item.exceptionType || ""} ${item.impact || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
      if (!/\b(?:broker[-_\s]?release[-_\s]?pending|release[-_\s]?pending|customs[-_\s]?release[-_\s]?needed)\b/i.test(itemText)) return true;
      return releaseGapExceptionItem(item, rowAwb);
    });
  if (
    arrived &&
    textIncludesAny(text, [/\b(?:on hand|available for pickup|cargo is available|confirmed cargo)\b/i]) &&
    textIncludesAny(text, [/\b(?:has not arrived|not arrived|not on hand|no arrival proof)\b/i])
  ) {
    exceptions.unshift({
      type: "arrival-conflict",
      summary: "Arrival conflict: one source says cargo is on hand, another says it has not arrived.",
      severity: "needs-decision",
      status: "open",
      source: "canonical-pipeline",
    });
  }
  const preferredException = preferredExceptionForPhase(exceptions, phase, gates, state.awb || active.awb || brain.awb);
  const preferredExceptionSummary = ["delivery-blocked", "pickup-blocked", "customs-hold", "arrival-incomplete"].includes(phase)
    ? preferredException?.summary || ""
    : "";
  if (preferredExceptionSummary && phase === "delivery-blocked") {
    gates.delivery = gate("delivery", "blocked", preferredExceptionSummary, {
      at: preferredException.at || gates.delivery?.at || state.latestEventAt || state.updatedAt || "",
      source: preferredException.source || gates.delivery?.source || "email-first-truth",
      confidence: preferredException.confidence || gates.delivery?.confidence || "high",
    });
    if (statusIs(gates.pickup, ["blocked", "exception", "incomplete"])) {
      gates.pickup = gate("pickup", "blocked", preferredExceptionSummary, {
        at: preferredException.at || gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
        source: preferredException.source || gates.pickup?.source || "email-first-truth",
        confidence: preferredException.confidence || gates.pickup?.confidence || "high",
      });
    }
  } else if (preferredExceptionSummary && phase === "pickup-blocked") {
    gates.pickup = gate("pickup", "blocked", preferredExceptionSummary, {
      at: preferredException.at || gates.pickup?.at || state.latestEventAt || state.updatedAt || "",
      source: preferredException.source || gates.pickup?.source || "email-first-truth",
      confidence: preferredException.confidence || gates.pickup?.confidence || "high",
    });
  }
  const gateNextAction = nextActionFromGates(gates, metadata);
  const inheritedNextAction = first(state.nextAction, active.nextAction, brain.nextAction);
  const inheritedPhase = String(state.phase || "").toLowerCase();
  const phaseSummary = canonicalPhaseSummary(phase);
  const inheritedPickupDocsAction =
    /\b(?:generate\/send|generate|send)\b[^.;\n]{0,100}\b(?:delivery order|d\/?o|missing docs?|pickup docs?)\b/i.test(inheritedNextAction) &&
    !exceptions.some((item) => pickupDocsExceptionItem(item));
  const inheritedActionStillMatchesPhase = inheritedPhase && inheritedPhase === phase;
  return {
    phase,
    label: first(closeoutSummary, preferredExceptionSummary, phaseSummary, state.currentState, active.currentState, brain.currentState, phase),
    summary: first(closeoutSummary, preferredExceptionSummary, phaseSummary, state.currentState, active.currentState, brain.currentState, ""),
    nextAction: first(
      phase === "delivered" ? gateNextAction : "",
      inheritedPickupDocsAction || !inheritedActionStillMatchesPhase ? "" : inheritedNextAction,
      gateNextAction,
    ),
    gates,
    storage: storageFromText(text),
    exceptions,
    confidence: state.confidence || "medium",
    source: "canonical-legacy-fallback",
    updatedAt: first(state.latestEventAt, state.updatedAt, active.updatedAt, brain.updatedAt),
    metadata,
  };
}

function nonFinalCustomsReleaseEvidence(facts, currentAt = "") {
  const currentTime = eventTime(currentAt);
  return facts.some((fact) => {
    const factTime = eventTime(fact.at || fact.updatedAt || fact.createdAt);
    if (currentTime && !factTime) return false;
    if (currentTime && factTime && factTime < currentTime) return false;
    if (externalFinalCustomsReleaseFact(fact)) return false;
    const sameMessageFinalRelease = facts.some((candidate) =>
      candidate !== fact &&
        fact.threadId &&
        fact.messageId &&
        candidate.threadId === fact.threadId &&
        candidate.messageId === fact.messageId &&
        externalFinalCustomsReleaseFact(candidate)
    );
    if (sameMessageFinalRelease) return false;
    return /customs|release|d\/?o|delivery order|clearance|entry/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`) &&
      /clearance .*will follow|entry .*will follow|will follow.*clearance|will follow.*entry|once .*ams|wheels up|do attached|attached d\.?o/i.test(`${fact.summary || ""} ${fact.evidence || ""}`);
  });
}

function genericPodEvidenceText(value) {
  return /^\s*(?:delivery\s*\/\s*pod|pod|delivery proof)\s+evidence\s+was\s+received\.?\s*$/i.test(String(value || ""));
}

function pqDeliveredStatusProofText(value) {
  const text = String(value || "");
  if (!text || podNegatedText(text)) return false;
  return (
    /\bstatus:\s*your shipment has been delivered to\b/i.test(text) ||
    (
      /\byour shipment has been delivered to\b/i.test(text) &&
      /\b(?:trackorder\.aspx|couriercloud|demo operations inc\.?\s*-\s*track#|status update)\b/i.test(text)
    )
  );
}

function handlerReceiptOnlyText(value) {
  const text = String(value || "");
  if (!text) return false;
  const handlerReceipt =
    /\b(?:shipment|cargo|freight)\s+(?:was\s+|has been\s+)?received\b/i.test(text) ||
    /\breceived by\s+(?:ground\s+handler|handler|station|warehouse|airline|carrier|terminal|cargo(?:\s+facility)?|destination\s+ground\s+handler)\b/i.test(text) ||
    /\breceived at\s+(?:the\s+)?(?:station|warehouse|terminal|ground\s+handler|cargo(?:\s+facility)?)\b/i.test(text);
  if (!handlerReceipt) return false;
  return !/\b(?:pod attached|pod found|pod received|proof of delivery|signed pod|signed delivery receipt|receiver signature|delivered to|delivery completed|successfully delivered)\b/i.test(text) &&
    !/\breceived by\s+(?!(?:ground\s+handler|handler|station|warehouse|airline|carrier|terminal|cargo(?:\s+facility)?|destination\s+ground\s+handler)\b)[A-Z][A-Za-z .'-]{1,40}\b/.test(text);
}

function onwardHandlerTransferText(value) {
  const text = String(value || "");
  if (!text) return false;
  // Bare handler/airport tokens (WFS, CDG) must not signal a transfer by themselves — a customs
  // hold handled at a WFS station is not an onward transfer. Transfer phrasing is required.
  const handlerReceiptOrTransfer = handlerReceiptOnlyText(text) ||
    /\b(?:connection[-_\s]?transfer[-_\s]?resolved|transfer (?:is )?(?:done|completed)|handoff (?:is )?(?:done|completed)|transferred (?:to|at) (?:ua|united)|continues? to [A-Z]{3}|continued to [A-Z]{3}|continue to [A-Z]{3}|will be loaded|loaded for flight|flight\s+ua\s*\d+|ua\s*cdg|(?:wfs|cdg)[-_\s\/]{0,3}(?:transfer|handoff|hand[-\s]?off)|(?:transfer|handoff)[-_\s]{0,20}\b(?:wfs|cdg)\b)\b/i.test(text);
  if (!handlerReceiptOrTransfer) return false;
  if (/\b(?:pod attached|pod found|pod received|proof of delivery|signed pod|signed delivery receipt|receiver signature|delivered to|delivery completed|successfully delivered|delivered successfully)\b/i.test(text)) {
    return false;
  }
  return /\b(?:connection[-_\s]?transfer|transfer (?:is )?(?:done|completed|in progress)|handoff|transferred (?:to|at) (?:ua|united)|continues? to [A-Z]{3}|continued to [A-Z]{3}|continue to [A-Z]{3}|will be loaded|loaded for flight|flight\s+ua\s*\d+|ua\s*cdg|(?:wfs|cdg)[-_\s\/]{0,3}(?:transfer|handoff|hand[-\s]?off)|deleted in uc360|not in (?:the )?(?:ua|united) area)\b/i.test(text);
}

function latestOnwardHandlerTransferFact(facts = [], state = {}) {
  const positiveArrival = latestPositiveArrivalEvidenceFact(facts);
  const positiveArrivalAt = eventTime(factOccurredAt(positiveArrival));
  return [
    ...array(facts),
    ...array(state.events),
    ...array(state.emailValidation?.events),
    ...array(state.proof),
    ...array(state.proofs),
    state.gates?.arrival,
    state.gates?.delivery,
    state.gates?.pod,
  ]
    .filter(Boolean)
    .map((item) => ({
      item,
      text: factText(item),
      at: eventTime(factOccurredAt(item)),
    }))
    .filter((row) => onwardHandlerTransferText(row.text))
    .filter((row) => {
      if (!positiveArrival || !positiveArrivalAt) return true;
      const generatedGateEcho = !row.item.type &&
        (row.item.name || row.item.status || row.item.rawStatus) &&
        !row.item.threadId &&
        !row.item.messageId &&
        !row.item.sourceRef?.threadId &&
        !row.item.sourceRef?.messageId;
      if (generatedGateEcho && (!row.at || row.at >= positiveArrivalAt)) return false;
      const proofSummaryEcho = /^gmail-proof$/i.test(String(row.item.type || "")) &&
        /\b(?:handler transfer|onward[-\s]?flight|will be loaded|loaded for flight)\b/i.test(row.text);
      if (proofSummaryEcho && (!row.at || row.at >= positiveArrivalAt)) return false;
      return row.at >= positiveArrivalAt;
    })
    .sort((a, b) => b.at - a.at)[0]?.item || null;
}

function directPickupExecutionFacts(facts = [], state = {}) {
  return [
    ...array(facts),
    ...array(state.events),
    ...array(state.emailValidation?.events),
  ].filter((item) => {
    const text = factText(item);
    return /\b(?:pickup[-_\s]?confirmed|pickup[-_\s]?loaded|picked up|driver (?:is )?(?:now )?loaded|(?:truck|carrier|driver)[^.;\n]{0,60}\bloaded|loaded proof|recovered from (?:airport|station|terminal)|both (?:are )?recovered)\b/i.test(text) &&
      !pickupArrangementOnlyText(text) &&
      !/\b(?:picking up tomorrow|pickup tomorrow|pick up tomorrow|aiming for p\s*\/?\s*u|aiming for pickup|will be delivered once available|once available for pick\s*up|eta\s+[A-Z]{3}\s+today)\b/i.test(text) &&
      !pickupExecutionNegatedText(text) &&
      !onwardHandlerTransferText(text);
  });
}

function pickupExecutionNegatedText(text = "") {
  const value = String(text || "");
  return /\b(?:not|no|without|pending|waiting|still|unconfirmed|not confirmed|not proven|not complete|not completed|not done|needed|need|needs|collect|get|verify|confirm)\b[^.;\n]{0,120}\b(?:picked up|pickup|pick[-\s]?up|loaded|loading proof|loaded proof|pickup proof|proof\/pod|pod)\b/i.test(value) ||
    /\b(?:picked up|pickup|pick[-\s]?up|loaded|loading proof|loaded proof|pickup proof|proof\/pod|pod)\b[^.;\n]{0,120}\b(?:not|no|pending|waiting|still|unconfirmed|not confirmed|not proven|not complete|not completed|not done|needed|need|needs|collect|get|verify|confirm)\b/i.test(value);
}

function latestDirectPickupExecutionFact(facts = [], state = {}) {
  return directPickupExecutionFacts(facts, state)
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function directPickupExecutionFact(facts = [], state = {}) {
  return Boolean(latestDirectPickupExecutionFact(facts, state));
}

function finalPodProofTextLooksFinal(value) {
  const text = String(value || "");
  if (!text || genericPodEvidenceText(text) || podNegatedText(text)) return false;
  if (handlerReceiptOnlyText(text)) return false;
  if (/\b(?:pre[-\s]?alert|full set of documents|shipment details?|contact consignee|clearance instructions|delivery order|d\/?o\b|deliver to|ship to|consignee|cnee)\b/i.test(text) &&
    !/\b(?:pod attached|pod found|pod received|attached pod|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|pod images|delivered-pod-received)\b/i.test(text)) {
    return false;
  }
  return /\b(?:pod attached|pod found|pod received|attached pod|attached is (?:the )?pod|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|pod images|delivered-pod-received|delivery completed|delivered successfully|successfully delivered)\b/i.test(text) ||
    pqDeliveredStatusProofText(text) ||
    (
      /\b(?:pod|proof of delivery|delivery proof|signed delivery|receiver signature|delivered)\b/i.test(text) &&
      /\b(?:signed by|received by)\s+[A-Za-z][A-Za-z .'-]{1,40}\b/i.test(text)
    );
}

function structuredGmailPodProofLooksFinal(row = {}) {
  const type = String(row.type || "").toLowerCase();
  const label = String(row.label || "").trim();
  const source = String(row.source || "").toLowerCase();
  const text = [
    row.type,
    row.label,
    row.summary,
    row.note,
    row.evidence,
    row.status,
  ].filter(Boolean).join(" ");
  if (!/\bgmail-proof\b/i.test(`${source} ${type}`)) return false;
  if (label.toLowerCase() !== "pod") return false;
  if (handlerReceiptOnlyText(text)) return false;
  if (!/\bpod\b/i.test(text) || podNegatedText(text)) return false;
  if (/\b(?:pod pending|pod missing|pod needed|collect pod|request pod|waiting for pod|will send|to follow|not received|not found|no pod)\b/i.test(text)) return false;
  return finalPodProofTextLooksFinal(text);
}

function shipmentStateEvidenceRows(state = {}, primaryRows = []) {
  return [
    ...primaryRows,
    ...(Array.isArray(state.events) ? state.events : []),
    ...(Array.isArray(state.facts) ? state.facts : []),
    ...(Array.isArray(state.factLedger) ? state.factLedger : []),
    ...(Array.isArray(state.proof) ? state.proof : []),
    ...(Array.isArray(state.proofs) ? state.proofs : []),
    ...(Array.isArray(state.evidence) ? state.evidence : []),
    ...(Array.isArray(state.emailValidation?.events) ? state.emailValidation.events : []),
    ...(Array.isArray(state.emailValidation?.proof) ? state.emailValidation.proof : []),
  ].filter(Boolean);
}

function shipmentStateHasFinalPodProof(state = {}) {
  const rows = shipmentStateEvidenceRows(state, [
    state.gates?.pod,
    state.gates?.delivery,
  ]);
  return rows.some((row) => {
    if (genericPodEvidenceText(row.evidence) || genericPodEvidenceText(row.summary)) return false;
    if (structuredGmailPodProofLooksFinal(row)) return true;
    const text = [
      row.type,
      row.label,
      row.summary,
      row.note,
      row.evidence,
      row.status,
      row.nextAction,
    ].filter(Boolean).join(" ");
    return finalPodProofTextLooksFinal(text);
  });
}

function shipmentStateHasFinalDeliveryProof(state = {}) {
  if (shipmentStateHasFinalPodProof(state)) return true;
  const rows = shipmentStateEvidenceRows(state, [
    state.gates?.delivery,
  ]);
  return rows.some((row) => {
    if (genericPodEvidenceText(row.evidence) || genericPodEvidenceText(row.summary)) return false;
    const text = [
      row.type,
      row.label,
      row.summary,
      row.note,
      row.evidence,
      row.status,
      row.nextAction,
    ].filter(Boolean).join(" ");
    if (!text || genericPodEvidenceText(text)) return false;
    if (handlerReceiptOnlyText(text)) return false;
    if (/\b(?:not|no|never|hasn'?t|has not|isn'?t|is not|wasn'?t|was not)\b[^.;\n]{0,80}\b(?:delivered|delivery completed|delivery complete)\b|\b(?:delivery|delivered)\b[^.;\n]{0,80}\b(?:not complete|not completed|pending|still pending)\b/i.test(text)) return false;
    if (/\b(?:pre[-\s]?alert|full set of documents|shipment details?|contact consignee|clearance instructions|delivery order|d\/?o\b|deliver to|ship to|consignee|cnee)\b/i.test(text) &&
      !/\b(?:delivered|delivery completed|delivered successfully|signed by|received by)\b/i.test(text)) {
      return false;
    }
    return /\b(?:delivered|delivery completed|delivered successfully)\b/i.test(text) ||
      /\b(?:signed by|received by)\s+[A-Za-z][A-Za-z .'-]{1,40}\b/i.test(text);
  });
}

function terminalRecoveryBlockerText(value) {
  const text = String(value || "");
  const explicitWrongDelivery = /\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|wrong recipient|wrong receiver|misdelivered|delivered by mistake|delivered to another customer|delivered to another cnee|another customer other than|another cnee|return to (?:el al|airline|station)|send back to (?:el al|airline|station))\b/i.test(text);
  const unknownCustodyAfterClaimedPickup =
    /\b(?:claim(?:s|ed)?|said|says|told)\b[^.;\n]{0,140}\b(?:driver|someone|they|carrier)\b[^.;\n]{0,100}\b(?:picked up|recovered|took|loaded)\b/i.test(text) &&
    /\b(?:driver did not pick|did not pick up|didn'?t pick up|not picked up|can'?t locate|cannot locate|cant locate|not locate|cannot find|not found)\b/i.test(text);
  return explicitWrongDelivery || unknownCustodyAfterClaimedPickup;
}

function terminalRecoveryResolutionText(value) {
  const text = String(value || "");
  if (/\b(?:please|pls|kindly)\b[^.;\n]{0,80}\b(?:confirm|advise|check)\b/i.test(text)) return false;
  return /\b(?:recovered from (?:the )?(?:wrong|other|another) (?:consignee|cnee|customer|recipient)|returned to (?:el al|airline|station|airport)[^.;\n]{0,120}\b(?:confirmed|received|back|recovered)|redelivered to (?:the )?(?:correct|intended) (?:consignee|cnee|customer|recipient)|delivered to (?:the )?(?:correct|intended) (?:consignee|cnee|customer|recipient)|delivered to northstar components|signed pod after (?:return|recovery|redelivery))\b/i.test(text);
}

function terminalRecoveryBlockerItems(facts = [], state = {}) {
  return [
    ...array(facts),
    ...array(state.exceptions),
    ...array(state.events),
    ...array(state.emailValidation?.events),
  ]
    .filter((item) => terminalRecoveryBlockerText(factText(item)));
}

function terminalRecoveryBlockerPriority(item = {}) {
  const text = factText(item);
  if (/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver did not pick|did not pick up|didn'?t pick up|not picked up|can'?t locate|cannot locate|cant locate|not locate|cannot find|not found)\b/i.test(text)) {
    return 4;
  }
  if (/\b(?:wrong[-_\s]?consignee|wrong customer|wrong cnee|wrong recipient|wrong receiver|misdelivered|delivered by mistake|another customer other than|another cnee)\b/i.test(text)) {
    return 3;
  }
  if (/\b(?:return to (?:el al|airline|station)|send back to (?:el al|airline|station)|delivery[-_\s]?blocked)\b/i.test(text)) {
    return 2;
  }
  return 1;
}

function latestTerminalRecoveryBlocker(facts = [], state = {}) {
  const blockers = terminalRecoveryBlockerItems(facts, state)
    .sort((a, b) =>
      terminalRecoveryBlockerPriority(b) - terminalRecoveryBlockerPriority(a) ||
      eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a))
    );
  const latestBlocker = blockers[0] || null;
  if (!latestBlocker) return null;
  const blockerAt = eventTime(factOccurredAt(latestBlocker));
  const resolved = [
    ...array(facts),
    ...array(state.events),
    ...array(state.emailValidation?.events),
  ].some((item) => {
    const itemAt = eventTime(factOccurredAt(item));
    if (blockerAt && itemAt && itemAt < blockerAt) return false;
    return terminalRecoveryResolutionText(factText(item));
  });
  return resolved ? null : latestBlocker;
}

function latestTerminalRecoveryBlockerAt(facts = [], state = {}) {
  const blocker = latestTerminalRecoveryBlocker(facts, state);
  return blocker ? eventTime(factOccurredAt(blocker)) : 0;
}

function terminalRecoveryExceptionFromFact(fact = {}) {
  return {
    type: fact.exceptionType || fact.type || "wrong-consignee-delivery",
    severity: fact.severity || "immediate",
    where: "delivery",
    impact: fact.exceptionType || "wrong-consignee-delivery",
    status: "open",
    summary: exceptionSummaryFromFact(fact) || "Shipment appears delivered to the wrong consignee/customer.",
    evidence: fact.evidence || fact.summary || "",
    nextAction: fact.nextAction || "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.",
    at: factOccurredAt(fact),
    threadId: fact.threadId || "",
    messageId: fact.messageId || "",
    subject: fact.subject || "",
    source: fact.source || "email-first-truth",
    confidence: fact.confidence || "high",
  };
}

function terminalRecoveryBlockerState(state = {}, blocker = {}) {
  const gates = state.gates || {};
  const exception = terminalRecoveryExceptionFromFact(blocker);
  const summary = exception.summary || "Shipment appears delivered to the wrong consignee/customer.";
  const nextAction = exception.nextAction;
  const at = exception.at || state.updatedAt || state.latestEventAt || "";
  return {
    ...state,
    phase: "delivery-blocked",
    label: summary,
    summary,
    nextAction,
    gates: {
      ...gates,
      delivery: gate("delivery", "blocked", summary, {
        at: first(gates.delivery?.at, at),
        source: exception.source || gates.delivery?.source || "email-first-truth",
        confidence: exception.confidence || "high",
      }),
      pod: gate("pod", "pending", "Normal POD closeout is blocked until wrong-consignee recovery/redelivery is confirmed.", {
        at: first(gates.pod?.at, at),
        source: exception.source || gates.pod?.source || "email-first-truth",
        confidence: exception.confidence || "high",
      }),
    },
    exceptions: openExceptionItems({ ...state, exceptions: [...array(state.exceptions), exception] }),
  };
}

function terminalProofAllowed(candidateAt, blockerAt) {
  if (!blockerAt) return true;
  return false;
}

function falsePositiveShipmentPodGate(input = {}, row = {}) {
  const status = String(input.status || "").toLowerCase();
  if (!["done", "received", "found", "pod-found", "pod-received"].includes(status)) return false;
  return !shipmentStateHasFinalPodProof(row);
}

function falsePositiveShipmentDeliveryGate(input = {}, row = {}) {
  const status = String(input.status || "").toLowerCase();
  if (!["completed", "delivered", "done"].includes(status)) return false;
  return !shipmentStateHasFinalDeliveryProof(row);
}

function finalPodEvidence(facts, active = {}, brain = {}, state = {}) {
  const terminalBlockerAt = latestTerminalRecoveryBlockerAt(facts, state);
  const structuredPodFact = facts
    .filter((fact) => structuredGmailPodProofLooksFinal(fact))
    .filter((fact) => terminalProofAllowed(factOccurredAt(fact), terminalBlockerAt))
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
  if (structuredPodFact) {
    return {
      summary: structuredPodFact.summary || structuredPodFact.note || "Structured Gmail POD proof accepted.",
      at: structuredPodFact.at || state.latestEventAt || state.updatedAt || "",
      source: structuredPodFact.source || "gmail-proof",
      confidence: structuredPodFact.confidence || "high",
    };
  }
  const newerStatePodPending =
    /\b(?:pending|missing|needed|not[-\s]?received|not[-\s]?found|no[-\s]?pod)\b/i.test(String(state.gates?.pod?.status || "")) &&
    eventTime(state.gates?.pod?.at || state.latestEventAt || state.updatedAt);
  const structuredValues = [
    { value: state.gates?.pod?.status, at: state.gates?.pod?.at || state.latestEventAt || state.updatedAt, source: "shipment-state" },
    { value: active.pod?.status, at: active.pod?.deliveredAt || active.pod?.at || active.updatedAt, source: "active-pod-status" },
    { value: brain.pod?.status, at: brain.pod?.deliveredAt || brain.pod?.at || brain.updatedAt, source: "brain-pod-status" },
    { value: active.freightBroker?.status, at: active.updatedAt, source: "active-freight-status" },
    { value: brain.freightBroker?.status, at: brain.updatedAt, source: "brain-freight-status" },
    { value: active.emailValidation?.status, at: active.emailValidation?.at || active.updatedAt, source: "active-email-validation" },
    { value: brain.emailValidation?.status, at: brain.emailValidation?.at || brain.updatedAt, source: "brain-email-validation" },
  ].filter((item) => item.value);
  const acceptedStructured = structuredValues.find((item) =>
    (item.source !== "shipment-state" || shipmentStateHasFinalPodProof(state)) &&
    positiveStructuredStatus(item.value, ["pod-found", "pod-received", "pod-attached", "delivered-pod-received", "delivered-pod-found", "delivered-pod-found-invoice-received", "freight-delivered-pod-found", "freight-delivered-pod-found-invoice-received", "received", "accepted", "done"]) &&
    !/\b(?:pending|missing|needed|not[-\s]?received|not[-\s]?found|no[-\s]?pod)\b/i.test(String(item.value)) &&
    terminalProofAllowed(item.at, terminalBlockerAt) &&
    (!newerStatePodPending || item.source === "shipment-state" || eventTime(item.at) >= newerStatePodPending)
  );
  if (acceptedStructured) {
    const structuredEvidence = acceptedStructured.source === "shipment-state"
      ? first(state.gates?.pod?.evidence, state.gates?.delivery?.evidence, state.summary, active.currentState, brain.currentState)
      : first(active.pod?.evidence, brain.pod?.evidence, state.gates?.pod?.evidence, state.gates?.delivery?.evidence);
    return {
      summary: structuredEvidence || "POD/delivery proof accepted in shipment memory.",
      at: first(acceptedStructured.at, active.pod?.deliveredAt, brain.pod?.deliveredAt, state.gates?.pod?.at),
      source: acceptedStructured.source || "structured-pod-status",
      confidence: "high",
    };
  }
  return facts
    .map((fact) => ({
      type: fact.type || "",
      label: fact.label || "",
      summary: `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`.trim(),
      note: fact.note || "",
      evidence: fact.evidence || "",
      status: fact.status || "",
      at: fact.at || "",
      source: fact.source || "",
      confidence: fact.confidence || "high",
    }))
    .filter((row) => row.summary)
    .filter((row) =>
      (finalPodProofTextLooksFinal(row.summary) || structuredGmailPodProofLooksFinal(row)) &&
      terminalProofAllowed(row.at, terminalBlockerAt) &&
    !/\b(?:payment|receipt|cargosprint|station fees?|ground handling)\b[^.;\n]{0,80}\bdelivered\b/i.test(row.summary) &&
      !/\b(?:will send|to follow|will follow|pending|missing|needed|not received|not found|collect|get|request|ask|follow[-\s]?up)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed proof)\b/i.test(row.summary)
    )
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function podNegatedText(value) {
  return /\b(?:no|not|without|missing|pending|need|needs|needed|awaiting|collect)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed proof)\b|\b(?:pod|proof of delivery|delivery proof|signed proof)\b[^.;\n]{0,80}\b(?:not|missing|pending|needed|not found|not received|no proof)\b/i.test(String(value || ""));
}

function attachmentExtractionUnavailableText(value) {
  return /\b(?:attachment metadata indicates operational evidence|pdf text (?:was )?not available|text was not available in this refresh|extracted text (?:was )?not available)\b/i.test(String(value || ""));
}

function positiveStructuredStatus(value, allowed) {
  const normalized = String(value || "").toLowerCase().replace(/[_\s]+/g, "-").trim();
  if (!normalized || /^(?:not-|no-|missing|pending|needed|unknown)/.test(normalized)) return false;
  const chunks = normalized
    .split(/[;,|/]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.some((status) =>
    normalized === status ||
    chunks.includes(status) ||
    normalized.startsWith(`${status}:`) ||
    normalized.startsWith(`${status}=`)
  );
}

function finalCustomsReleaseEvidence(facts, currentAt = "") {
  const currentTime = eventTime(currentAt);
  return facts
    .filter((fact) => {
      if (!externalFinalCustomsReleaseFact(fact)) return false;
      const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      if (!/customs|release|d\/?o|d\.?o|delivery order|clearance|entry/i.test(text)) return false;
      const factTime = eventTime(factOccurredAt(fact));
      return !currentTime || !factTime || factTime >= currentTime;
    })
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function pickupBlockedEvidence(facts, releaseResolver = null, awb = "") {
  const latestArrivalReadyAt = Math.max(0, ...facts
    .filter((fact) => {
      const text = factText(fact);
      if (/\b(?:not arrived|has not arrived|not on hand|not in (?:our|the) system|not available)\b/i.test(text)) return false;
      return /arrival[-_\s]?notice[-_\s]?received|carrier[-_\s]?arrival[-_\s]?confirmed|station[-_\s]?arrival[-_\s]?confirmed|on[-\s]?hand|ready for pick|available for pickup|arrived at|arrived\b/i.test(text);
    })
    .map((fact) => eventTime(factOccurredAt(fact))));
  return facts
    .filter((fact) => {
      if (customsBlockerResolvedByRelease(fact, releaseResolver)) return false;
      const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      if (attachmentExtractionUnavailableText(text)) return false;
      const factTime = eventTime(factOccurredAt(fact));
      if (
        latestArrivalReadyAt &&
        (!factTime || factTime < latestArrivalReadyAt) &&
        /\b(?:not arrived|has not arrived|not on hand|not in (?:our|the) system|not available)\b/i.test(text)
      ) {
        return false;
      }
      const scopedText = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.claim || ""}`;
      if (foreignScopedReleaseBlockerFact(fact, awb) || foreignScopedReleaseTextForAwb(scopedText, awb) || foreignScopedReleaseTextForAwb(text, awb)) return false;
      return /station|pickup|driver|pieces?|piece-count|availability|available|on hand/i.test(text) &&
        /mismatch|discrepanc|wrong pieces?|piece[-\s]?count|3[-\s]?v(?:s|ersus)[-\s]?4|3[-\s]?vs[-\s]?4|not available|not on hand|not locate|cannot locate|can'?t locate|cant locate|did not locate|not found|nothing found|cannot release|can'?t release|cannot see|can'?t see|doesn'?t see|not visible|not showing|blocked|hold pickup|fixing/i.test(text);
    })
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function pickupArrangementOnlyEvidence(facts, gates = {}) {
  const rows = [
    {
      type: "pickup-gate",
      summary: gates.pickup?.evidence || "",
      at: gates.pickup?.at || "",
      source: gates.pickup?.source || "shipment-state",
    },
    ...facts.filter((fact) => /pickup-confirmed|picked[-\s]?up|pickup/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`)),
  ];
  return rows
    .filter((fact) => pickupArrangementOnlyText(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`))
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function loadingBlockedText(text) {
  const value = String(text || "");
  if (
    /\b(?:driver|truck|trucker)\b[^.;\n]{0,120}\b(?:on[-\s]?site|at station|waiting|standby|checked[-\s]?in)\b/i.test(value) &&
    /\b(?:cannot load|can'?t load|loading blocked|pallets? do not fit|doesn'?t fit|won'?t fit|refused? load|too (?:big|wide|tall|heavy))\b/i.test(value)
  ) {
    return "Driver/loading blocked: driver is onsite and cargo cannot be loaded.";
  }
  if (/\b(?:pallets? do not fit|cannot load|can'?t load|loading blocked|refused? load)\b/i.test(value)) {
    return "Loading blocked: cargo cannot be loaded as planned.";
  }
  return "";
}

function pickupReleaseVisibilityBlockerText(text) {
  const value = String(text || "");
  const driverLive = /\b(?:driver|truck|trucker)\b[^.;\n]{0,120}\b(?:on[-\s]?site|at station|at airport|checked[-\s]?in|waiting|standby|cannot pickup|can'?t pickup|not loaded|loading blocked)\b/i.test(value);
  for (const clause of evidenceClauses(value)) {
    const stationCannotSeeRelease =
      /\b(?:station|airport|carrier|airline|warehouse|agent|terminal)\b[^.;\n]{0,120}\b(?:not|does not|doesn'?t|cannot|can'?t|won'?t|will not)\b[^.;\n]{0,120}\b(?:see|show|have|find)\b[^.;\n]{0,80}\b(?:release|clearance|clear|d\/?o|delivery order)\b/i.test(clause);
    const releaseNotVisible =
      /\b(?:release|clearance|customs release|d\/?o|delivery order)\b[^.;\n]{0,120}\b(?:not|isn'?t|is not|does not|doesn'?t|cannot|can'?t|missing|pending)\b[^.;\n]{0,80}\b(?:system|visible|show|showing|seen|found|available|accepted)\b/i.test(clause);
    const clauseHasPickupBlockerContext =
      /\b(?:station|airport|carrier|airline|warehouse|agent|terminal|pickup|driver|truck|trucker|onsite|on[-\s]?site|checked[-\s]?in|waiting|standby)\b/i.test(clause);
    if (stationCannotSeeRelease || releaseNotVisible && (clauseHasPickupBlockerContext || driverLive)) {
      return "Pickup blocked: station cannot see release/DO.";
    }
  }
  return "";
}

function deliveryBlockedText(text) {
  const value = String(text || "");
  if (/\b(?:consignee|receiver|delivery point|dock|facility)\b[^.;\n]{0,140}\b(?:not available|closed|refused|cannot offload|can'?t offload|unable to offload|no one|problem)\b/i.test(value)) {
    return "Delivery blocked: receiver/consignee issue prevents offload.";
  }
  if (/\b(?:cannot offload|can'?t offload|unable to offload|receiver refused|facility closed|delivery problem)\b/i.test(value)) {
    return "Delivery blocked: driver cannot complete offload.";
  }
  return "";
}

function arrivalIncompleteEvidence(facts) {
  return facts
    .filter((fact) => {
      const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      if (attachmentExtractionUnavailableText(text)) return false;
      return /arrival|station|on[-\s]?hand|available|offload|pieces?/i.test(text) &&
        /\b(?:only\s+\d+\s+of\s+\d+|partial|remaining|missing pieces?|not offloaded|not fully offloaded|not available|piece(?:s)? (?:short|missing)|all pieces? (?:not|aren'?t|are not))\b/i.test(text);
    })
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function preArrivalOverride(group, facts) {
  const active = firstFrom(group, "active") || firstTmsFrom(group) || {};
  const brain = firstFrom(group, "brain") || {};
  const tms = firstTmsFrom(group) || {};
  const tracking = truthRow(group)?.snapshots?.tracking || active.tracking || brain.tracking || {};
  if (tmsProvesDestinationArrival({
    ...tms,
    status: first(tms.status, tms.tmsStatus, active.tms?.status, active.tms?.tmsStatus, brain.tms?.status, brain.tms?.tmsStatus),
    tmsStatus: first(tms.tmsStatus, tms.status, active.tms?.tmsStatus, active.tms?.status, brain.tms?.tmsStatus, brain.tms?.status),
    statusDescription: first(tms.statusDescription, active.tms?.statusDescription, brain.tms?.statusDescription),
    nextTask: first(tms.nextTask, active.tms?.nextTask, brain.tms?.nextTask),
  })) {
    return "";
  }
  if (/^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(String(active.arrivalStatus || brain.arrivalStatus || "").trim())) {
    return "";
  }
  if (facts.some((fact) => !generatedGateFact(fact) && positiveArrivalEvidenceFact(fact))) return "";
  const text = [
    active.arrivalStatus,
    brain.arrivalStatus,
    active.stage,
    brain.stage,
    active.currentState,
    brain.currentState,
    active.nextAction,
    brain.nextAction,
    active.eta,
    brain.eta,
    tracking.status,
    tracking.summaryStatus,
    tracking.latestEvent?.code,
    tracking.latestEvent?.description,
    facts.map((fact) => fact.summary || fact.evidence || "").join(" "),
  ].join(" ");
  const positiveArrivalText =
    /\b(?:available for pickup|on hand|notice of arrival attached|arrival notice attached)\b/i.test(text) ||
    (/\barrived at\b/i.test(text) && !/\bnot[-\s]?arrived at\b/i.test(text));
  if (
    /\b(?:not[-\s]?arrived|not at destination|in transit|actual departure|\bdep\b|await (?:firms code or )?noa|awaiting noa|will await.*noa)\b/i.test(text) &&
    !positiveArrivalText
  ) {
    return etaTextWithYear(first(active.eta, brain.eta, tracking.eta, "Not arrived at destination yet."));
  }
  if (
    /\b(?:departed|departure|actual departure|\bdep\b)\b/i.test(text) &&
    /\b(?:arrival|arrive|eta)\b[^.;\n]{0,80}\b(?:expected|planned|on|for|jun|june|\d{1,2})\b|\b(?:expected|planned)\b[^.;\n]{0,80}\b(?:arrival|arrive|eta)\b/i.test(text) &&
    !positiveArrivalText
  ) {
    return etaTextWithYear(first(active.eta, brain.eta, tracking.eta, textMatch(facts, /\b(?:arrival|arrive|eta)\b[^.;\n]{0,80}\b(?:Jun|June)\s*\d{1,2}\b/i), "Shipment departed; destination arrival is still expected."));
  }
  return "";
}

function latestPositiveArrivalEvidenceFact(facts = []) {
  return [...facts]
    .filter((item) => sourceLooksEmailOrOperator(item) && !generatedGateFact(item) && positiveArrivalEvidenceFact(item))
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function latestStrongArrivalEvidenceFact(facts = []) {
  return [...facts]
    .filter(strongScopedArrivalEvidenceFact)
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
}

function preArrivalFlightUpdateEvidence(facts = []) {
  const fact = [...facts]
    .filter((item) => sourceLooksEmailOrOperator(item) && !generatedGateFact(item))
    .filter((item) => {
      const text = factText(item);
      return /\bpre-arrival-flight-update\b/i.test(text) ||
        (
          /\b(?:departed|departure|actual departure|\bdep\b)\b/i.test(text) &&
          /\b(?:arrival|arrive|eta)\b[^.;\n]{0,100}\b(?:expected|planned|on|for|Jun|June|\d{1,2})\b/i.test(text)
        );
    })
    .sort((a, b) => eventTime(factOccurredAt(b)) - eventTime(factOccurredAt(a)))[0] || null;
  if (!fact) return "";
  const positiveArrival = latestPositiveArrivalEvidenceFact(facts);
  const flightAt = eventTime(factOccurredAt(fact));
  const arrivalAt = eventTime(factOccurredAt(positiveArrival));
  if (positiveArrival && (!flightAt || !arrivalAt || arrivalAt >= flightAt)) return "";
  return first(fact.summary, fact.evidence, "Pre-arrival flight update is the latest movement truth.");
}

function positiveArrivalEvidenceFact(fact) {
  const structuredText = `${fact?.type || ""} ${fact?.label || ""} ${fact?.summary || ""}`;
  const evidenceText = `${fact?.claim || ""} ${fact?.evidence || ""} ${fact?.rawSnippet || ""}`;
  const fullText = `${structuredText} ${evidenceText}`;
  if (generatedGateFact(fact)) return false;
  if (attachmentExtractionUnavailableText(fullText)) return false;
  if (
    /\b(?:not|no(?!\s*:)|without|missing|pending|awaiting|unavailable)\b[^.;\n]{0,80}\b(?:arrival|arrived|on[-\s]?hand|available|availability)\b/i.test(fullText) ||
    /\b(?:arrival|arrived|on[-\s]?hand|available|availability)\b[^.;\n]{0,80}\b(?:not|no(?!\s*:)|missing|pending|unavailable|not available)\b/i.test(fullText)
  ) {
    return false;
  }
  const evidenceIsOnlyARequest =
    /please provide|pleas(?:e)? confirm on[-\s]?hand|confirm on[-\s]?hand|share arrival notice|request(?:ed|ing)?|need(?:ed)?|ask(?:ed)? for|send .*arrival notice|provide .*arrival notice/i.test(evidenceText) &&
    !/arrival notice attached|notice of arrival|your shipment has arrived|has arrived|arrived at|arrival date|terminal address|storage begin date|available for pickup/i.test(evidenceText);
  const conditionalOrUnverifiedArrival =
    /\b(?:eta\b|will be delivered once available|once available for pick\s*up|future arrival|scheduled arrival|attachment metadata indicates|pdf text was not available|pod-class attachment|content could not be verified|human review needed)\b/i.test(evidenceText);
  const authorityText = `${fact?.actor || ""} ${fact?.sourceSystem || ""} ${fact?.source || ""} ${fact?.type || ""} ${fact?.label || ""}`;
  const sourceCanCertifyBareArrival =
    sourceLooksTmsOrTracking(fact) ||
    operatorConfirmedFact(fact) ||
    /\b(?:station|handler|carrier|airline|cargo|forward\s+air|swissport|wfs|united\s+cargo|el\s*al|air\s*canada|airport|terminal|warehouse)\b/i.test(authorityText);
  const scopedDocumentArrivalProof =
    /\b(?:arrival date\s*:?\s*\d|disposition code:\s*1c|280[-\s]?ARR@DEST|\bRCF\b|\bNFD\b)\b/i.test(evidenceText);
  const scopedOnHandProof =
    /\b(?:freight|cargo|shipment)\s+(?:is\s+)?(?:on[-\s]?hand|available|ready\s+for\s+pickup)\b|\b(?:on[-\s]?hand|available|ready\s+for\s+pickup)\b[^.;\n]{0,80}\b(?:freight|cargo|shipment|mawb|awb)\b/i.test(evidenceText);
  const scopedBareArrivalProof =
    sourceCanCertifyBareArrival &&
    /\b(?:shipment (?:has )?arrived|has arrived|arrived at|at (?:the )?(?:terminal|station|warehouse))\b/i.test(evidenceText);
  const scopedArrivalProof = !conditionalOrUnverifiedArrival && (scopedDocumentArrivalProof || scopedOnHandProof || scopedBareArrivalProof);
  const structuredPositive =
    /\b(?:arrival-notice-received|arrival-inferred-release-ready|carrier-arrival-confirmed|state-arrival|canonical-arrival|gmail-proof)\b/i.test(structuredText) &&
    /\b(?:arrival\/on-hand evidence was received|arrival evidence found|arrival notice received|release-ready arrival inferred|eta passed|arrived|on[-\s]?hand|available|ready for pickup|carrier tracking says cargo)\b/i.test(structuredText) &&
    !evidenceIsOnlyARequest;
  if (structuredPositive) return !conditionalOrUnverifiedArrival;
  if (
    /\b(?:arrival-notice-received|station[_-\s]?arrival[_-\s]?confirmed|customs[_-\s]?released)\b/i.test(structuredText) &&
    /\b(?:arrival date\s*:?\s*\d|received:\s*\w{3},?\s*\d{1,2}\/\d{1,2}\/\d{2,4}|mawb:\s*\d|disposition code:\s*1c)\b/i.test(evidenceText) &&
    !evidenceIsOnlyARequest
  ) {
    return true;
  }
  return scopedArrivalProof &&
    /arrival/i.test(fullText) &&
    /arrival notice|arrived|on hand|available|ready for pickup|cargo is ready/i.test(fullText) &&
    !/no arrival|not arrived|arrival pending|proof required|proof exists|until station|please provide|request(?:ed|ing)?|need(?:ed)?|ask(?:ed)? for/i.test(fullText);
}

function strongScopedArrivalEvidenceFact(fact = {}) {
  if (generatedGateFact(fact) || attachmentExtractionUnavailableText(factText(fact))) return false;
  const text = factText(fact);
  if (
    /\b(?:not[-\s]?arrived|not at destination|no arrival|arrival pending|pending arrival|scheduled arrival|future arrival|eta only|eta\s+[A-Z]{3}\s+today|destination arrival is not proven|not in (?:our|the|their) system|not yet in (?:our|the|their) system|not on[-\s]?hand|not available|cargo not on[-\s]?hand|freight not on[-\s]?hand|at origin|still at origin|in[-\s]?transit|in transit to [A-Z]{3}|will be delivered once available|once available for pick\s*up|attachment metadata indicates|pdf text was not available|pod-class attachment|content could not be verified|human review needed)\b/i.test(text)
  ) {
    return false;
  }
  return /\b(?:280[-\s]?ARR@DEST|\bRCF\b|\bNFD\b|arrival date\s*:?\s*\d|disposition code:\s*1c)\b/i.test(text) ||
    /\b(?:freight|cargo|shipment)\s+(?:is\s+)?(?:on[-\s]?hand|available|ready\s+for\s+pickup)\b|\b(?:on[-\s]?hand|available|ready\s+for\s+pickup)\b[^.;\n]{0,80}\b(?:freight|cargo|shipment|mawb|awb)\b/i.test(text);
}

function tmsContradictsDestinationArrival(active = {}, brain = {}, tms = {}) {
  const text = [
    tms.status,
    tms.tmsStatus,
    tms.statusDescription,
    tms.nextTask,
    tms.flightDetails?.recoveryHint,
    tms.flightDetails?.etaHint,
    active.tms?.status,
    active.tms?.tmsStatus,
    active.tms?.statusDescription,
    active.tms?.nextTask,
    active.tmsStatus,
    active.status,
    active.statusDescription,
    active.nextTask,
    active.flightDetails?.recoveryHint,
    active.flightDetails?.etaHint,
    brain.tms?.status,
    brain.tms?.tmsStatus,
    brain.tms?.statusDescription,
    brain.tms?.nextTask,
    brain.tmsStatus,
    brain.status,
    brain.statusDescription,
    brain.nextTask,
    brain.flightDetails?.recoveryHint,
    brain.flightDetails?.etaHint,
  ].filter(Boolean).join(" ");
  if (!text) return false;
  const code = Number((String(text).match(/\b(\d{3})(?=\s*[-/A-Z@])/i) || [])[1] || 0);
  if (code >= 280 || /\b(?:arr\s*@\s*dest|arrived?\s+at\s+dest|available|on[-\s]?hand|ready\s*for\s*pickup)\b/i.test(text)) {
    return false;
  }
  return (code > 0 && code < 280) ||
    /\b(?:conf\s*onboar|conf(?:irmed)?\s+on\s+board|in[-\s]?transit|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d]))\b/i.test(text);
}

function factLooksProofOnlyArrivalSummary(text) {
  return /\b(?:arrival evidence found in gmail thread|arrival\/on[-\s]?hand evidence was received)\b/i.test(String(text || ""));
}

function requestOnlyArrivalEvidence(facts) {
  const arrivalFacts = facts.filter((fact) => /arrival|on-hand|notice/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`));
  if (!arrivalFacts.length) return false;
  const hasRequest = arrivalFacts.some((fact) => /please provide|request(?:ed|ing)?|need(?:ed)?|ask(?:ed)? for|send .*arrival notice|provide .*arrival notice|no arrival notice/i.test(`${fact.summary || ""} ${fact.evidence || ""}`));
  const hasPositive = arrivalFacts.some((fact) => {
    const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
    return !generatedGateFact(fact) && !factLooksProofOnlyArrivalSummary(text) && positiveArrivalEvidenceFact(fact);
  });
  return hasRequest && !hasPositive;
}

function tmsProvesDestinationArrival(row = {}) {
  const text = [
    row.status,
    row.tmsStatus,
    row.statusDescription,
    row.nextTask,
  ].filter(Boolean).join(" ");
  const code = Number((String(text).match(/\b(\d{3})(?=\s*[-/A-Z@])/i) || [])[1] || 0);
  return code >= 280 ||
    /\b(?:arr\s*@\s*dest|arrived?\s+at\s+dest|available|on[-\s]?hand|ready\s*for\s*pickup)\b/i.test(text);
}

function tmsProvesCustomsRelease(row = {}) {
  return tmsHasDirectCustomsReleaseProof(row);
}

function generatedGateFact(fact = {}) {
  return fact.source === "canonical-shipment-pipeline" || /^canonical-/i.test(String(fact.type || ""));
}

function gateFromShipmentState(name, input, fallbackAt = "") {
  const rawStatus = String(input.rawStatus || input.status || "").toLowerCase();
  const mapped = mapShipmentStateGateStatus(name, rawStatus);
  const pickupScheduledDate = name === "pickup"
    ? input.pickupScheduledDate || (["scheduled", "planned", "deferred"].includes(mapped) ? input.scheduledDate || input.appointmentDate || "" : "")
    : "";
  const deliveryScheduledDate = name === "delivery"
    ? input.deliveryScheduledDate || input.scheduledDate || input.deliveryDate || input.appointmentDate || ""
    : input.deliveryScheduledDate || input.deliveryDate || "";
  return gate(name, mapped, input.evidence || input.summary || rawStatus || mapped, {
    at: input.at || fallbackAt,
    source: "shipment-state",
    confidence: input.confidence || "high",
    broker: input.broker || "",
    contactEmail: input.contactEmail || "",
    deliveryScheduledDate,
    pickupScheduledDate,
    scheduledDate: name === "pickup" ? input.scheduledDate || pickupScheduledDate : input.scheduledDate || "",
  });
}

function mapShipmentStateGateStatus(name, status) {
  if (name === "arrival") {
    if (["arrived", "available", "on-hand", "done", "inferred"].includes(status)) return "done";
    if (["not-arrived", "waiting", "pending", "missing"].includes(status)) return "not-arrived";
    if (["blocked", "partial", "incomplete"].includes(status)) return "incomplete";
  }
  if (name === "customs") {
    if (["released", "cleared", "done"].includes(status)) return "done";
    if (["customs-hold", "hold", "exam-hold", "blocked"].includes(status)) return "blocked";
    if (["pending", "waiting", "missing"].includes(status)) return "pending";
  }
  if (name === "fees") {
    if (["paid", "done"].includes(status)) return "done";
    if (["due", "pending", "unpaid"].includes(status)) return "due";
    if (["waiting", "missing"].includes(status)) return "waiting";
    if (["unknown", "unknown-offline"].includes(status)) return status;
  }
  if (name === "dispatch") {
    if (["broker-awarded", "awarded", "sent", "done", "dispatched"].includes(status)) return "done";
    if (["blocked"].includes(status)) return "blocked";
  }
  if (name === "pickup") {
    if (["picked-up", "loaded", "done", "inferred"].includes(status)) return "done";
    if (["driver-onsite", "onsite"].includes(status)) return "driver-onsite";
    if (["blocked", "exception"].includes(status)) return "blocked";
    if (["scheduled", "planned", "deferred"].includes(status)) return "scheduled";
  }
  if (name === "delivery") {
    if (["delivered", "reported"].includes(status)) return "delivered";
    if (["out-for-delivery", "out for delivery", "out-for-del", "ofd"].includes(status)) return "out-for-delivery";
    if (["scheduled"].includes(status)) return "scheduled";
    if (["blocked", "exception", "problem"].includes(status)) return "blocked";
  }
  if (name === "pod") {
    if (["received", "pod-found", "found", "done"].includes(status)) return "done";
    if (["pending", "missing", "needed"].includes(status)) return "pending";
  }
  return status || "waiting";
}

function nextPhaseFromGates(gates) {
  const arrivalStatus = String(gates.arrival?.status || "").toLowerCase();
  if (statusIs(gates.pod, ["done", "received", "pod-found", "found"])) return "delivered";
  if (gates.delivery?.status === "delivered") return "delivered-pod-pending";
  if (gates.delivery?.status === "out-for-delivery") return "out-for-delivery";
  if (["blocked", "exception", "problem"].includes(gates.delivery?.status)) return "delivery-blocked";
  if (gates.pickup?.status === "done") return "pod-needed";
  if (["driver-onsite", "onsite"].includes(gates.pickup?.status)) return "driver-onsite";
  if (["not-arrived", "unknown", "waiting", "pending", "missing"].includes(arrivalStatus)) return "pre-arrival";
  if (["incomplete", "blocked", "partial"].includes(arrivalStatus)) return "arrival-incomplete";
  if (statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])) return "customs-hold";
  if (["blocked", "exception", "incomplete"].includes(gates.pickup?.status)) return "pickup-blocked";
  if (!statusIs(gates.customs, ["done", "released", "cleared", "unknown-offline"])) return "release-needed";
  if (statusIs(gates.fees, ["due", "pending", "unpaid"])) return "fees-needed";
  if (gates.pickup?.status === "scheduled") return "pickup-scheduled";
  if (
    !statusIs(gates.fees, ["done", "paid", "unknown-offline"]) ||
    !statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"])
  ) {
    return "not-ready";
  }
  return "ready-for-pickup";
}

function canonicalPhaseSummary(phase) {
  return {
    "pre-arrival": "Pre-arrival",
    "arrival-incomplete": "Arrival incomplete",
    "customs-hold": "Customs hold",
    "release-needed": "Release needed",
    "fees-needed": "Fees needed",
    "not-ready": "Not ready",
    "ready-for-pickup": "Ready for pickup",
    "dispatch-ready": "Dispatch ready",
    "dispatch-sent": "Dispatch sent",
    "pickup-scheduled": "Pickup scheduled",
    "driver-onsite": "Driver onsite",
    "pickup-blocked": "Pickup blocked",
    "pod-needed": "Picked up; POD needed",
    "out-for-delivery": "Out for delivery",
    "delivery-blocked": "Delivery blocked",
    "delivered-pod-pending": "Delivered; POD needed",
    "pickup-docs-needed": "Pickup documents needed",
    "awb-copy-needed": "AWB copy needed",
    "pickup-location-requested": "Pickup location needed",
    delivered: "Delivered / POD received",
    completed: "Delivered / POD received",
    closed: "Closed",
    exception: "Exception",
    "source-gap": "Source gap",
    open: "Open",
    unknown: "Unknown",
  }[String(phase || "").toLowerCase()] || "Unknown";
}

function scheduledDeliveryDateFromFacts(facts) {
  const deliveryFact = facts
    .filter((fact) => !generatedGateFact(fact) && !sourceLooksTmsOrTracking(fact))
    .filter((fact) => /deliver(?:y)? tomorrow|will deliver tomorrow|scheduled.*deliver/i.test(`${fact.summary || ""} ${fact.evidence || ""}`))
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0];
  if (!deliveryFact) return "";
  const explicit = `${deliveryFact.summary || ""} ${deliveryFact.evidence || ""}`.match(/\b(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2})\b/)?.[1];
  if (explicit) return explicit;
  const baseTime = eventTime(deliveryFact.at);
  if (!baseTime) return "";
  const date = new Date(baseTime + 86400000);
  return date.toISOString().slice(0, 10);
}

function positive(text, terms) {
  const value = String(text || "").toLowerCase();
  return terms.some((term) => value.includes(term));
}

function pickupArrangementOnlyText(text) {
  const value = String(text || "");
  if (/\b(?:driver (?:is )?(?:now )?loaded|driver loaded|(?:was|has been|got)\s+picked\s+(?:it\s+)?up|picked\s+(?:it\s+)?up\s+already|recovered from|recovery complete|pickup complete|loaded and will deliver|loaded and (?:is )?(?:en route|rolling)|loaded as of)\b/i.test(value)) {
    return false;
  }
  return /\b(?:can|could|will|would|should|able to|available to|going to|scheduled to|planning to|plan to|trying to|try to|need to|needs to|set up to|arrange to)\b[^.;\n]{0,90}\b(?:get\s+)?(?:pick(?:ed)?\s*up|pickup|recover(?:ed)?|recovery|load(?:ed)?)\b/i.test(value) ||
    /\b(?:do you have|can you send|please send|need|needs|needed|provide)\b[^.;\n]{0,100}\b(?:pickup location|pick[-\s]?up location|delivery order|d\/?o|remaining docs?|necessary docs?|release package)\b/i.test(value);
}

function operatorResolvedBlocker(facts, blockers = []) {
  const resolvedAt = facts
    .filter((fact) => fact.type === "exception-resolved")
    .map((fact) => eventTime(fact.at))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  if (!resolvedAt) return false;
  const blockerAt = blockers
    .filter(Boolean)
    .map((item) => eventTime(item.at))
    .filter(Boolean)
    .sort((a, b) => b - a)[0] || 0;
  return !blockerAt || resolvedAt >= blockerAt;
}

function operatorConfirmedFact(fact) {
  if (fact?.source === "operator-note") return true;
  return fact?.confidence === "operator-confirmed" &&
    sourceLooksEmailOrOperator(fact) &&
    !sourceLooksTmsOrTracking(fact) &&
    !generatedGateFact(fact);
}

function latestOperatorFact(facts, types) {
  const wanted = new Set(types);
  return array(facts)
    .filter((fact) => wanted.has(fact.type) && operatorConfirmedFact(fact))
    .slice()
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function latestPaymentEvidenceFact(facts) {
  return array(facts)
    .filter((fact) => {
      const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      if (/\b(?:not paid|payment pending|payment due|unpaid|need(?:s)? payment)\b/i.test(text)) return false;
      return /\bground-fees-paid\b/i.test(fact.type || "") ||
        (/\b(?:cargosprint|cargo sprint|ground fees?|station fees?|handling fees?|payment|receipt)\b/i.test(text) &&
          /\b(?:paid|confirmed|delivered|receipt|payment confirmation)\b/i.test(text));
    })
    .slice()
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function operatorGate(name, status, fact, fallbackEvidence = "") {
  return gate(name, status, fallbackEvidence || fact?.summary || fact?.label || status, {
    at: fact?.at || "",
    source: fact?.source || "operator-note",
    confidence: fact?.confidence || "operator-confirmed",
  });
}

function operatorDeliveryIsFuture(fact) {
  const value = `${fact?.label || ""} ${fact?.summary || ""} ${fact?.evidence || ""}`;
  return /\b(?:will deliver|will be delivered|deliver tomorrow|delivery tomorrow|delivering tomorrow|deliver today|delivery today|delivering today|scheduled)\b/i.test(value);
}

function operatorDeliveryIsComplete(fact) {
  const value = `${fact?.label || ""} ${fact?.summary || ""} ${fact?.evidence || ""}`;
  return /\b(?:operator delivered|delivered|delivery completed|completed delivery)\b/i.test(value) && !operatorDeliveryIsFuture(fact);
}

function operatorPickupScheduledDate(fact) {
  const value = `${fact?.label || ""} ${fact?.summary || ""} ${fact?.evidence || ""}`;
  if (!/\b(?:pickup|pick up|picks?\s*up|recover|recovery|driver|truck|appointment|appt|jeff|chart)\b/i.test(value)) return "";
  if (/\b(?:today|this morning|this afternoon|this evening)\b/i.test(value)) return operatorDateKey(new Date());
  if (/\btomorrow\b/i.test(value)) return addDaysOperatorDateKey(new Date(), 1);
  return "";
}

function arrivalNegativeFactAfter(facts = [], cutoffAt = "") {
  const cutoff = eventTime(cutoffAt);
  return array(facts).some((fact) => {
    if (!sourceLooksEmailOrOperator(fact) || generatedGateFact(fact)) return false;
    const at = eventTime(factOccurredAt(fact));
    if (cutoff && at && at < cutoff) return false;
    const text = factText(fact);
    return /\b(?:not[-\s]?arrived|has not arrived|not at destination|not on[-\s]?hand|not available|cargo not available|no arrival notice|no arrival record|not in (?:our|the) system)\b/i.test(text);
  });
}

function latestCarrierArrivalFact(facts = []) {
  return latestFactByTypes(facts, ["carrier-arrival-confirmed"]);
}

function latestCarrierAirportPickupFact(facts = []) {
  return latestFactByTypes(facts, ["carrier-airport-pickup-confirmed"]);
}

function applyCarrierTrackingOverlay(state = {}, evidence = []) {
  const carrierArrival = latestCarrierArrivalFact(evidence);
  const carrierPickup = latestCarrierAirportPickupFact(evidence);
  if (!carrierArrival && !carrierPickup) return state;
  const gates = {
    arrival: state.gates?.arrival || gate("arrival", "waiting", ""),
    customs: state.gates?.customs || gate("customs", "waiting", ""),
    fees: state.gates?.fees || gate("fees", "waiting", ""),
    dispatch: state.gates?.dispatch || gate("dispatch", "waiting", ""),
    pickup: state.gates?.pickup || gate("pickup", "waiting", ""),
    delivery: state.gates?.delivery || gate("delivery", "waiting", ""),
    pod: state.gates?.pod || gate("pod", "waiting", ""),
  };
  const carrierFact = carrierPickup || carrierArrival;
  const carrierAt = factOccurredAt(carrierFact);
  if (
    carrierArrival &&
    !arrivalNegativeFactAfter(evidence, factOccurredAt(carrierArrival)) &&
    !statusIs(gates.arrival, ["done", "arrived", "available", "on-hand", "incomplete", "blocked", "partial"])
  ) {
    gates.arrival = gate("arrival", "done", carrierArrival.summary || carrierArrival.evidence || "Carrier tracking confirms destination arrival/on-hand status.", {
      at: factOccurredAt(carrierArrival),
      source: carrierArrival.source || "carrier-tracking",
      confidence: carrierArrival.confidence || "high",
    });
  }
  if (
    carrierPickup &&
    !statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) &&
    !arrivalNegativeFactAfter(evidence, factOccurredAt(carrierPickup))
  ) {
    gates.arrival = statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"])
      ? gates.arrival
      : gate("arrival", "done", carrierPickup.summary || "Carrier tracking proves destination custody before airport release.", {
        at: carrierAt,
        source: carrierPickup.source || "carrier-tracking",
        confidence: carrierPickup.confidence || "high",
      });
    gates.pickup = gate("pickup", "done", carrierPickup.summary || carrierPickup.evidence || "Carrier tracking says cargo left airline custody; final delivery/POD still needs independent proof.", {
      at: carrierAt,
      source: carrierPickup.source || "carrier-tracking",
      confidence: carrierPickup.confidence || "high",
    });
  }
  const phase = nextPhaseFromGates(gates);
  return {
    ...state,
    gates,
    phase,
    label: canonicalPhaseSummary(phase),
    summary: canonicalPhaseSummary(phase),
    nextAction: nextActionFromGates(gates),
    updatedAt: first(state.updatedAt, carrierAt),
    latestEventAt: first(state.latestEventAt, carrierAt),
    source: state.source || "canonical-shipment-state",
  };
}

function applyOperatorStatusOverlay(state, evidence) {
  const pickup = latestOperatorFact(evidence, ["pickup"]);
  const delivery = latestOperatorFact(evidence, ["delivery"]);
  const dispatch = latestOperatorFact(evidence, ["dispatch"]);
  const arrival = latestOperatorFact(evidence, ["arrival"]);
  const customs = latestOperatorFact(evidence, ["customs"]);
  const payment = latestOperatorFact(evidence, ["payment"]) || latestPaymentEvidenceFact(evidence);
  const pod = latestOperatorFact(evidence, ["pod"]);
  if (!pickup && !delivery && !dispatch && !arrival && !customs && !payment && !pod) return state;

  const gates = {
    arrival: state.gates?.arrival || gate("arrival", "waiting", ""),
    customs: state.gates?.customs || gate("customs", "waiting", ""),
    fees: state.gates?.fees || gate("fees", "waiting", ""),
    dispatch: state.gates?.dispatch || gate("dispatch", "waiting", ""),
    pickup: state.gates?.pickup || gate("pickup", "waiting", ""),
    delivery: state.gates?.delivery || gate("delivery", "waiting", ""),
    pod: state.gates?.pod || gate("pod", "waiting", ""),
  };

  if (arrival && gates.arrival.status !== "done") gates.arrival = operatorGate("arrival", "done", arrival);
  if (customs && gates.customs.status !== "done") gates.customs = operatorGate("customs", "done", customs);
  if (payment && gates.fees.status !== "done") gates.fees = operatorGate("fees", "done", payment);
  if (dispatch) {
    if (!["done", "sent"].includes(gates.dispatch.status)) gates.dispatch = operatorGate("dispatch", "done", dispatch);
    const pickupScheduledDate = operatorPickupScheduledDate(dispatch);
    const existingPickupScheduled = ["scheduled", "planned", "deferred"].includes(gates.pickup.status) &&
      (gates.pickup.pickupScheduledDate || gates.pickup.scheduledDate || gates.pickup.appointmentDate);
    const existingPickupIsNewer = existingPickupScheduled &&
      eventTime(gates.pickup.at) >= eventTime(dispatch.at);
    if (pickupScheduledDate && !existingPickupIsNewer && !["done", "picked-up", "loaded", "recovered", "driver-onsite", "onsite"].includes(gates.pickup.status)) {
      gates.pickup = {
        ...operatorGate("pickup", "scheduled", dispatch, dispatch.summary || dispatch.evidence || "Operator scheduled pickup."),
        pickupScheduledDate,
        scheduledDate: pickupScheduledDate,
      };
    }
  }

  const pickupLike = pickup || (delivery && operatorDeliveryIsFuture(delivery));
  if (pickupLike) {
    gates.arrival = gates.arrival.status === "done"
      ? gates.arrival
      : operatorGate("arrival", "done", pickupLike, "Operator-confirmed pickup implies cargo was on hand.");
    gates.customs = gates.customs.status === "done"
      ? gates.customs
      : operatorGate("customs", "done", pickupLike, "Operator-confirmed pickup implies the release path was sufficient.");
    gates.fees = gates.fees.status === "done"
      ? gates.fees
      : operatorGate("fees", "done", pickupLike, "Operator-confirmed pickup means ground fees did not block recovery.");
    gates.dispatch = gates.dispatch.status === "done"
      ? gates.dispatch
      : operatorGate("dispatch", "done", pickupLike, "Operator-confirmed pickup implies dispatch was completed.");
    gates.pickup = operatorGate("pickup", "done", pickupLike);
  }

  if (delivery && operatorDeliveryIsFuture(delivery) && gates.delivery.status !== "delivered") {
    gates.delivery = operatorGate("delivery", "scheduled", delivery);
  }
  if (delivery && operatorDeliveryIsComplete(delivery)) {
    gates.arrival = gates.arrival.status === "done"
      ? gates.arrival
      : operatorGate("arrival", "done", delivery, "Operator-confirmed delivery implies cargo was on hand.");
    gates.customs = gates.customs.status === "done"
      ? gates.customs
      : operatorGate("customs", "done", delivery, "Operator-confirmed delivery implies the release path was sufficient.");
    gates.fees = gates.fees.status === "done"
      ? gates.fees
      : operatorGate("fees", "done", delivery, "Operator-confirmed delivery means ground fees did not block recovery.");
    gates.dispatch = gates.dispatch.status === "done"
      ? gates.dispatch
      : operatorGate("dispatch", "done", delivery, "Operator-confirmed delivery implies dispatch was completed.");
    gates.pickup = gates.pickup.status === "done"
      ? gates.pickup
      : operatorGate("pickup", "done", delivery, "Operator-confirmed delivery implies pickup happened.");
    gates.delivery = operatorGate("delivery", "delivered", delivery);
    if (!statusIs(gates.pod, ["done", "received", "pod-found", "found"])) gates.pod = operatorGate("pod", "pending", delivery, "Operator-confirmed delivery; POD still needs proof unless attached.");
  }
  if (pod) {
    gates.delivery = gates.delivery.status === "delivered" ? gates.delivery : operatorGate("delivery", "delivered", pod);
    gates.pod = operatorGate("pod", "done", pod);
  }

  const phase = nextPhaseFromGates(gates);
  const exceptions = array(state.exceptions).filter((item) => {
    if (gates.pickup.status === "done" && /pickup|driver|station|availability|piece|load/i.test(`${item.type || ""} ${item.summary || ""}`)) return false;
    if (gates.delivery.status === "delivered" && /delivery/i.test(`${item.type || ""} ${item.summary || ""}`)) return false;
    return true;
  });
  return {
    ...state,
    gates,
    phase,
    exceptions,
    nextAction: nextActionFromGates(gates),
    summary: phase === state.phase ? state.summary : phase,
  };
}

function driverOnsiteNextAction(gates = {}) {
  if (statusIs(gates.customs, ["done", "released", "cleared"])) {
    return "Carrier/driver is onsite; get loaded proof, confirm the current pickup blocker if any, and keep detention from growing.";
  }
  return "Carrier/driver is onsite; verify exact release/DO scope if needed, get loaded proof, and keep detention from growing.";
}

function nextActionFromGates(gates, metadata = null) {
  const arrivalStatus = String(gates.arrival?.status || "").toLowerCase();
  if (statusIs(gates.pod, ["done", "received", "pod-found", "found"])) return "No action; POD is in memory.";
  if (statusIs(gates.delivery, ["blocked", "exception", "problem"])) {
    return "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.";
  }
  if (gates.delivery?.status === "delivered" && !statusIs(gates.pod, ["done", "received", "pod-found", "found"])) return "Collect signed POD/proof of delivery.";
  if (gates.pickup?.status === "done") return "Track final delivery and collect POD.";
  if (["driver-onsite", "onsite"].includes(gates.pickup?.status)) {
    return driverOnsiteNextAction(gates);
  }
  if (["not-arrived", "unknown", "waiting", "pending", "missing"].includes(arrivalStatus)) {
    const broker = cleanMetadataValue(
      contactField(metadata?.customsBroker || {}, "broker", "name", "contactName") ||
      gates.customs?.broker ||
      gates.customs?.selectedBroker ||
      "",
    );
    if (broker && !statusIs(gates.customs, ["done", "released", "cleared", "unknown-offline"])) {
      return `Monitor arrival and ${broker} customs/release progress; do not dispatch pickup yet.`;
    }
    return "Monitor arrival; do not dispatch pickup yet.";
  }
  if (
    ["blocked", "exception", "incomplete"].includes(gates.pickup?.status) &&
    !statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])
  ) {
    return metadata ? stationConfirmationAction(metadata) : "Confirm station availability and piece count before release, fees, or dispatch.";
  }
  if (!statusIs(gates.customs, ["done", "released", "cleared", "unknown-offline"])) {
    const customsText = [
      gates.customs?.evidence,
      gates.customs?.reason,
      gates.customs?.summary,
      gates.customs?.broker,
      gates.customs?.selectedBroker,
      metadata?.customsBroker?.broker,
      metadata?.customsBroker?.brokerStatus,
      metadata?.customsBroker?.status,
    ].filter(Boolean).join(" ");
    const broker = cleanMetadataValue(
      contactField(metadata?.customsBroker || {}, "broker", "name", "contactName") ||
      gates.customs?.broker ||
      gates.customs?.selectedBroker ||
      "",
    );
    if (/\bother[-\s]?broker\b/i.test(customsText)) {
      return broker
        ? `Track the other-broker release dependency with ${broker}; do not dispatch pickup yet.`
        : "Track the other-broker release dependency; do not dispatch pickup yet.";
    }
    if (
      /\b(?:rejected|not accepted|arrive\s+it|port\s+2402|retransmit)\b/i.test(customsText) &&
      /\b(?:inbond|in[-\s]?bond|\bit\b|ups|port\s+2402)\b/i.test(customsText)
    ) {
      return "Escalate the inbond rejection with UPS/customs and get the IT/release corrected before dispatch.";
    }
    if (
      /\b(?:customs hold|government hold|exam hold|u\.?s\.? customs hold|cbp hold|fda hold|intensive exam)\b/i.test(customsText) &&
      /\b(?:already inform(?:ed)?|already notified|broker (?:is |was )?(?:already )?(?:informed|notified)|inform(?:ed)? their broker|keep you (?:on )?post|keep you posted|once released|customs[-_\s]?released[-_\s]?d[\/_\s]?o[-_\s]?received|release\/?d\.?o received|release\/?do received)\b/i.test(customsText)
    ) {
      return "Monitor broker/customs release; operator can follow up but may not control the hold.";
    }
    return broker
      ? `Push ${broker} for release/DO before dispatch.`
      : "Find the customs broker/release thread before chasing release/DO.";
  }
  if (gates.fees?.status === "due") {
    const feeText = [
      gates.fees?.evidence,
      gates.fees?.summary,
      gates.fees?.reason,
      metadata?.currentState,
    ].filter(Boolean).join(" ");
    if (/\bchoice\b/i.test(feeText)) {
      return "Resolve the Choice arrival/import/storage fees before pickup execution and POD.";
    }
    if (/\b(?:storage|import service|arrival notification|last free|lfd)\b/i.test(feeText)) {
      return "Resolve the station storage/ground fees before pickup execution and POD.";
    }
    const detail = String(feeText || "").replace(/\s+/g, " ").trim();
    return detail && !/^(?:fees due|due|pending|unpaid)$/i.test(detail)
      ? `Confirm or pay ground handling fees: ${compact(detail, 90)}.`
      : "Confirm or pay ground handling fees.";
  }
  if (!statusIs(gates.fees, ["done", "paid", "unknown-offline"])) {
    return "Confirm station fees/availability and pickup broker/dispatch path before pickup execution.";
  }
  if (["blocked", "exception", "incomplete"].includes(gates.pickup?.status)) {
    return metadata ? stationConfirmationAction(metadata) : "Confirm station availability and piece count before release, fees, or dispatch.";
  }
  if (gates.pickup?.status === "scheduled") return "Follow the scheduled pickup time and collect loaded proof/POD after pickup.";
  if (["quote-received", "quotes-in"].includes(String(gates.dispatch?.status || "").toLowerCase())) {
    const broker = cleanDispatchBrokerName(gates.dispatch?.broker || gates.dispatch?.selectedBroker || gates.dispatch?.pickupOwner || "");
    const amount = gates.dispatch?.amount || gates.dispatch?.rate || moneyAmountFromText(`${gates.dispatch?.evidence || ""} ${gates.dispatch?.summary || ""}`);
    return broker
      ? `Approve/award ${broker}${amount ? ` at ${amount}` : ""} or choose another pickup broker; then track pickup execution and POD.`
      : "Approve/award the pickup quote or choose another pickup broker; then track pickup execution and POD.";
  }
  if (String(gates.dispatch?.status || "").toLowerCase() === "broker-alerted") {
    const broker = cleanDispatchBrokerName(gates.dispatch?.broker || gates.dispatch?.selectedBroker || gates.dispatch?.pickupOwner || "");
    return broker
      ? `Wait for ${broker} acknowledgement/quote or confirm the dispatch path; do not rediscover the pickup broker.`
      : "Wait for broker acknowledgement/quote or confirm the dispatch path; do not rediscover the pickup broker.";
  }
  if (gates.dispatch?.status !== "done") return "Confirm pickup broker/dispatch path.";
  if (!statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"])) return "Confirm pickup execution and collect loaded proof/POD.";
  return "Monitor shipment until closeout proof is complete.";
}

function applyOperatorResolutionOverlay(state, evidence) {
  if (!operatorResolvedBlocker(evidence, [state.gates?.pickup, state.gates?.arrival])) return state;
  const gates = {
    ...state.gates,
    arrival: state.gates?.arrival && ["blocked", "incomplete", "partial"].includes(state.gates.arrival.status)
      ? { ...state.gates.arrival, status: "done", evidence: "Operator resolved the station/availability blocker." }
      : state.gates?.arrival,
    pickup: state.gates?.pickup && ["blocked", "exception", "incomplete"].includes(state.gates.pickup.status)
      ? { ...state.gates.pickup, status: "pending", evidence: "Operator resolved the previous pickup blocker." }
      : state.gates?.pickup,
  };
  const phase = state.phase === "pickup-blocked" || state.phase === "arrival-incomplete"
    ? nextPhaseFromGates(gates)
    : state.phase;
  const exceptions = array(state.exceptions).filter((item) => !/arrival|pickup|station|availability|block/i.test(`${item.type || ""} ${item.summary || ""}`));
  return {
    ...state,
    gates,
    phase,
    exceptions,
    nextAction: nextActionFromGates(gates),
    summary: phase === state.phase ? state.summary : phase,
  };
}

function canonicalNextActionForState(state = {}, metadata = {}) {
  const gates = state.gates || {};
  const exceptionItems = openExceptionItems(state, state.awb || metadata.awb || "");
  const statePhase = String(state.phase || "").toLowerCase();
  const stateAction = String(state.nextAction || "").trim();
  if (
    statePhase === "ready-for-pickup" &&
    !statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"])
  ) {
    return nextActionFromGates(gates, metadata);
  }
  const phase = activeExceptionPhase({ ...state, exceptions: exceptionItems }, gates) || String(state.phase || "");
  const phaseKey = String(phase || "").toLowerCase();
  const preferred = preferredExceptionForPhase(exceptionItems, phase, gates, state.awb || metadata.awb || "");
  const exceptionScopeText = exceptionItems.map((item) => `${item.type || ""} ${item.impact || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`).join(" ");
  if (
    statusIs(gates.pickup, ["driver-onsite", "onsite"]) &&
    /\b(?:clearance[-_\s]?scope|release[-_\s]?scope|different mawb|exact awb|release\/?d\.?o)\b/i.test(`${preferred?.type || ""} ${preferred?.impact || ""} ${preferred?.summary || ""} ${preferred?.nextAction || ""} ${state.nextAction || ""} ${exceptionScopeText}`)
  ) {
    return driverOnsiteNextAction(gates);
  }
  const usefulNextAction = (item) => {
    if (!item?.nextAction) return false;
    if (/review (?:the )?(?:evidence )?thread|decide (?:the )?(?:next )?operator move/i.test(item.nextAction)) return false;
    if (/\b(?:generate\/send|generate|send)\b[^.;\n]{0,100}\b(?:delivery order|d\/?o|missing docs?|pickup docs?)\b/i.test(item.nextAction) && !pickupDocsExceptionItem(item)) {
      return false;
    }
    return true;
  };
  if (usefulNextAction(preferred)) {
    return preferred.nextAction;
  }
  const stateActionIsGeneric =
    !stateAction ||
    /^review (?:manual gmail truth|the evidence thread)|decide (?:the )?(?:next )?operator move/i.test(stateAction);
  const stalePickupDocsAction =
    /\b(?:generate\/send|generate|send)\b[^.;\n]{0,100}\b(?:delivery order|d\/?o|missing docs?|pickup docs?)\b/i.test(stateAction) &&
    !exceptionItems.some((item) => pickupDocsExceptionItem(item));
  if (
    stateAction &&
    statePhase &&
    statePhase === phaseKey &&
    !stateActionIsGeneric &&
    !stalePickupDocsAction
  ) {
    return stateAction;
  }
  if (["customs-hold", "delivery-blocked", "pickup-blocked"].includes(phase)) {
    return nextActionFromGates(gates, metadata);
  }
  const exception = exceptionItems.find(usefulNextAction) || null;
  if (exception?.nextAction) {
    return exception.nextAction;
  }
  return nextActionFromGates(gates, metadata);
}

function applyTerminalPodClosure(state, evidence, active = {}, brain = {}) {
  const gates = state.gates || {};
  const terminalRecoveryBlocker = latestTerminalRecoveryBlocker(evidence, state);
  if (terminalRecoveryBlocker) return terminalRecoveryBlockerState(state, terminalRecoveryBlocker);
  const terminal = ["delivered", "completed"].includes(String(state.phase || "").toLowerCase()) ||
    statusIs(gates.pod, ["done", "received", "pod-found", "found"]);
  if (!terminal) return state;
  const finalPod = finalPodEvidence(evidence, active, brain, state);
  const terminalAt = first(finalPod?.at, gates.pod?.at, gates.delivery?.at, state.updatedAt, state.latestEventAt);
  const terminalSummary = first(
    finalPod?.summary,
    gates.pod?.evidence && !podNegatedText(gates.pod.evidence) ? gates.pod.evidence : "",
    gates.delivery?.evidence && !podNegatedText(gates.delivery.evidence) ? gates.delivery.evidence : "",
    !podNegatedText(state.summary) && !/\b(?:pending|needed|missing|to follow|not received|not found)\b/i.test(String(state.summary || "")) ? state.summary : "",
    "Delivered; POD is in memory.",
  );
  const terminalLabel = canonicalPhaseSummary("delivered");
  return {
    ...state,
    phase: "delivered",
    label: terminalLabel,
    summary: terminalLabel,
    stateReason: terminalSummary,
    nextAction: "No action; POD is in memory.",
    gates: {
      ...gates,
      arrival: gate("arrival", "done", "Final delivery/POD proof implies arrival happened.", {
        at: first(gates.arrival?.at, terminalAt),
        source: gates.arrival?.source || finalPod?.source || "canonical-terminal-closure",
        confidence: "high",
      }),
      customs: gate("customs", "done", "Shipment was delivered; release path was sufficient.", {
        at: first(gates.customs?.at, terminalAt),
        source: gates.customs?.source || finalPod?.source || "canonical-terminal-closure",
        confidence: "high",
      }),
      fees: gate("fees", "done", "Shipment was delivered; fee blocker did not stop execution.", {
        at: first(gates.fees?.at, terminalAt),
        source: gates.fees?.source || finalPod?.source || "canonical-terminal-closure",
        confidence: "high",
      }),
      dispatch: gate("dispatch", "done", "Shipment was delivered; dispatch path was completed.", {
        at: first(gates.dispatch?.at, terminalAt),
        source: gates.dispatch?.source || finalPod?.source || "canonical-terminal-closure",
        confidence: "high",
      }),
      pickup: gate("pickup", "done", "Final delivery/POD proof implies pickup happened.", {
        at: first(gates.pickup?.at, terminalAt),
        source: gates.pickup?.source || finalPod?.source || "canonical-terminal-closure",
        confidence: "high",
      }),
      delivery: gate("delivery", "delivered", terminalSummary, {
        at: first(gates.delivery?.at, terminalAt),
        source: finalPod?.source || gates.delivery?.source || "canonical-terminal-closure",
        confidence: finalPod?.confidence || "high",
      }),
      pod: gate("pod", "done", terminalSummary, {
        at: first(gates.pod?.at, terminalAt),
        source: finalPod?.source || gates.pod?.source || "canonical-terminal-closure",
        confidence: finalPod?.confidence || "high",
      }),
    },
    exceptions: [],
  };
}

function pickupGateHasNegatedCompletion(gateValue = {}) {
  return statusIs(gateValue, ["done", "picked-up", "loaded", "recovered"]) &&
    pickupExecutionNegatedText(`${gateValue.evidence || ""} ${gateValue.summary || ""} ${gateValue.reason || ""}`);
}

function gateWasOnlyInferredFromFalsePickup(gateValue = {}) {
  return /\b(?:pickup execution proves|pickup\/delivery happened|pickup\/delivery execution proves|shipment moved from station|fee blocker did not stop pickup|dispatch path existed|pod is needed after pickup)\b/i.test(
    `${gateValue.evidence || ""} ${gateValue.summary || ""} ${gateValue.reason || ""}`,
  );
}

function removeNegatedPickupCompletion(state = {}) {
  const gates = state.gates || {};
  if (!pickupGateHasNegatedCompletion(gates.pickup)) return state;
  const at = gates.pickup?.at || state.updatedAt || "";
  const source = gates.pickup?.source || "canonical-shipment-pipeline";
  const nextGates = {
    ...gates,
    pickup: gate(
      "pickup",
      statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) && !gateWasOnlyInferredFromFalsePickup(gates.arrival) ? "pending" : "waiting",
      "Pickup is not proven; source evidence explicitly says not picked up.",
      { at, source, confidence: "high" },
    ),
    pod: gate("pod", "waiting", "POD is not applicable before pickup/delivery proof.", {
      at: gates.pod?.at || at,
      source: gates.pod?.source || source,
      confidence: "high",
    }),
  };
  if (gateWasOnlyInferredFromFalsePickup(nextGates.arrival)) {
    nextGates.arrival = gate("arrival", "not-arrived", "Destination arrival cannot be inferred from negated pickup evidence.", {
      at: nextGates.arrival?.at || at,
      source: "canonical-pickup-sanity",
      confidence: "high",
    });
  }
  if (gateWasOnlyInferredFromFalsePickup(nextGates.customs) || statusIs(nextGates.customs, ["unknown-offline"])) {
    nextGates.customs = gate("customs", "waiting", "Customs/release cannot be inferred from negated pickup evidence.", {
      at: nextGates.customs?.at || at,
      source: "canonical-pickup-sanity",
      confidence: "high",
    });
  }
  if (gateWasOnlyInferredFromFalsePickup(nextGates.fees) || statusIs(nextGates.fees, ["unknown-offline"])) {
    nextGates.fees = gate("fees", "waiting", "Ground-fee clearance cannot be inferred from negated pickup evidence.", {
      at: nextGates.fees?.at || at,
      source: "canonical-pickup-sanity",
      confidence: "high",
    });
  }
  if (gateWasOnlyInferredFromFalsePickup(nextGates.dispatch)) {
    nextGates.dispatch = gate("dispatch", "waiting", "Dispatch cannot be inferred from negated pickup evidence.", {
      at: nextGates.dispatch?.at || at,
      source: "canonical-pickup-sanity",
      confidence: "high",
    });
  }
  if (statusIs(nextGates.delivery, ["delivered", "scheduled", "out-for-delivery"]) && gateWasOnlyInferredFromFalsePickup(nextGates.delivery)) {
    nextGates.delivery = gate("delivery", "waiting", "Delivery cannot be inferred from negated pickup evidence.", {
      at: nextGates.delivery?.at || at,
      source: "canonical-pickup-sanity",
      confidence: "high",
    });
  }
  const phase = nextPhaseFromGates(nextGates);
  return {
    ...state,
    gates: nextGates,
    phase,
    label: canonicalPhaseSummary(phase),
    summary: canonicalPhaseSummary(phase),
    nextAction: nextActionFromGates(nextGates),
  };
}

function canonicalShipment(group, memory = {}) {
  const metadata = stableMetadata(group, memory);
  const audit = truthRow(group);
  const state = audit && !truthAuditIsStale(audit, group) ? auditPhaseToCanonical(audit) : legacyReducerFallback(group, metadata, memory);
  const evidence = factRowsForGroup(group, memory);
  const active = firstFrom(group, "active") || firstTmsFrom(group) || {};
  const brain = firstFrom(group, "brain") || firstFrom(group, "brain-completed") || {};
  let resolvedState = applyTerminalPodClosure(
    applyOperatorStatusOverlay(applyOperatorResolutionOverlay(applyCarrierTrackingOverlay(state, evidence), evidence), evidence),
    evidence,
    active,
    brain,
  );
  resolvedState = removeNegatedPickupCompletion(resolvedState);
  const deliveryScheduleGateText = `${resolvedState.gates?.delivery?.evidence || ""} ${resolvedState.gates?.delivery?.summary || ""} ${resolvedState.gates?.delivery?.deliveryScheduledDate || ""} ${resolvedState.gates?.delivery?.scheduledDate || ""}`;
  const concreteDeliveryScheduleGate = Boolean(
    resolvedState.gates?.delivery?.deliveryScheduledDate ||
    resolvedState.gates?.delivery?.scheduledDate ||
    /\b(?:delivery is scheduled|scheduled delivery|delivery tomorrow|deliver tomorrow|delivering tomorrow|tomorrow morning|tomorrow afternoon|delivery eta|appointment)\b/i.test(deliveryScheduleGateText)
  );
  if (
    statusIs(resolvedState.gates?.pickup, ["done", "picked-up", "loaded", "recovered"]) &&
    statusIs(resolvedState.gates?.delivery, ["scheduled"]) &&
    !concreteDeliveryScheduleGate
  ) {
    const gates = {
      ...resolvedState.gates,
      delivery: gate("delivery", "waiting", "Pickup is confirmed; final delivery is not proven or scheduled by source evidence yet.", {
        at: resolvedState.gates.pickup?.at || resolvedState.gates.delivery?.at || resolvedState.updatedAt || "",
        source: resolvedState.gates.pickup?.source || "canonical-shipment-pipeline",
        confidence: resolvedState.gates.pickup?.confidence || "high",
      }),
      pod: statusIs(resolvedState.gates?.pod, ["done", "received", "pod-found", "found"])
        ? resolvedState.gates.pod
        : gate("pod", "pending", "POD is needed after pickup.", {
          at: resolvedState.gates.pickup?.at || resolvedState.updatedAt || "",
          source: resolvedState.gates.pickup?.source || "canonical-shipment-pipeline",
          confidence: resolvedState.gates.pickup?.confidence || "high",
        }),
    };
    resolvedState = {
      ...resolvedState,
      gates,
      phase: nextPhaseFromGates(gates),
      nextAction: nextActionFromGates(gates),
      summary: canonicalPhaseSummary(nextPhaseFromGates(gates)),
    };
  }
  const finalPodAtBoundary = finalPodEvidence(evidence, active, brain, resolvedState);
  const tmsArrivalProvenAtBoundary = tmsProvesDestinationArrival({
    ...(firstTmsFrom(group) || {}),
    nextTask: metadata.flightDetails?.recoveryHint || metadata.flightDetails?.etaHint || "",
    status: metadata.tms?.status || metadata.tms?.tmsStatus || "",
    tmsStatus: metadata.tms?.tmsStatus || metadata.tms?.status || "",
  });
  const strongArrivalAtBoundary = tmsArrivalProvenAtBoundary || evidence.some(strongScopedArrivalEvidenceFact);
  const boundarySourceText = evidence.map((fact) => factText(fact)).join(" ");
  const boundarySourceContradictsArrival =
    /\b(?:not[-\s]?arrived|not at destination|no arrival|arrival pending|destination arrival is not proven|not in (?:our|the|their) system|not yet in (?:our|the|their) system|not on[-\s]?hand|not available|cargo not on[-\s]?hand|freight not on[-\s]?hand|at origin|still at origin|in[-\s]?transit|in transit to [A-Z]{3}|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d])|picking up tomorrow|pickup tomorrow|delivery tomorrow|will be delivered once available|attachment metadata indicates|pdf text was not available)\b/i.test(boundarySourceText);
  const terminalCompletionNeedsCertification =
    statusIs(resolvedState.gates?.delivery, ["delivered", "reported"]) ||
    statusIs(resolvedState.gates?.pod, ["done", "received", "pod-found", "found"]);
  const metadataScheduleOnlyArrival = /\b(?:arrive|depart)\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d])/i.test(
    `${metadata.flightDetails?.recoveryHint || ""} ${metadata.flightDetails?.etaHint || ""}`,
  );
  const tmsBlocksArrivalAtBoundary = (metadataScheduleOnlyArrival || tmsContradictsDestinationArrival(active, brain, {
    ...(firstTmsFrom(group) || {}),
    flightDetails: metadata.flightDetails,
    nextTask: metadata.flightDetails?.recoveryHint || metadata.flightDetails?.etaHint || "",
    status: metadata.tms?.status || metadata.tms?.tmsStatus || "",
    tmsStatus: metadata.tms?.tmsStatus || metadata.tms?.status || "",
  })) && !strongArrivalAtBoundary;
  const boundaryContradictsArrivalWithoutStrongProof = boundarySourceContradictsArrival && !strongArrivalAtBoundary;
  if ((tmsBlocksArrivalAtBoundary || boundaryContradictsArrivalWithoutStrongProof) && !finalPodAtBoundary && !terminalCompletionNeedsCertification) {
    const guardAt = resolvedState.gates?.arrival?.at || resolvedState.updatedAt || state.updatedAt || "";
    const gates = {
      ...resolvedState.gates,
      arrival: gate("arrival", "not-arrived", "Current TMS/source evidence does not prove destination arrival.", {
        at: guardAt,
        source: "canonical-arrival-sanity",
        confidence: "high",
      }),
      pickup: statusIs(resolvedState.gates?.pickup, ["done", "picked-up", "loaded", "recovered", "blocked", "exception", "driver-onsite", "onsite", "scheduled"])
        ? gate("pickup", "waiting", "Pickup execution is not proven by current AWB-scoped source evidence.", {
          at: resolvedState.gates?.pickup?.at || guardAt,
          source: "canonical-arrival-sanity",
          confidence: "high",
        })
        : resolvedState.gates?.pickup,
      delivery: statusIs(resolvedState.gates?.delivery, ["scheduled", "out-for-delivery", "delivered", "reported"])
        ? gate("delivery", "waiting", "Delivery is not applicable until arrival and pickup execution are proven.", {
          at: resolvedState.gates?.delivery?.at || guardAt,
          source: "canonical-arrival-sanity",
          confidence: "high",
        })
        : resolvedState.gates?.delivery,
      pod: statusIs(resolvedState.gates?.pod, ["done", "received", "pod-found", "found", "pending"])
        ? gate("pod", "waiting", "POD is not applicable before final delivery.", {
          at: resolvedState.gates?.pod?.at || guardAt,
          source: "canonical-arrival-sanity",
          confidence: "high",
        })
        : resolvedState.gates?.pod,
    };
    resolvedState = {
      ...resolvedState,
      gates,
      phase: nextPhaseFromGates(gates),
      nextAction: nextActionFromGates(gates),
      summary: canonicalPhaseSummary(nextPhaseFromGates(gates)),
    };
  }
  const finalBoundaryOpenExceptions = openExceptionItems(resolvedState);
  const finalBoundaryExceptionState =
    String(resolvedState.phase || "").toLowerCase() === "exception" ||
    finalBoundaryOpenExceptions.some((item) => /\b(?:wrong[-_\s]?consignee|wrong[-_\s]?customer|misdelivered|delivered to (?:the )?wrong|immediate)\b/i.test(
      `${item.type || ""} ${item.exceptionType || ""} ${item.severity || ""} ${item.summary || ""} ${item.evidence || ""}`,
    )) ||
    evidence.some((fact) => {
      const text = `${fact.type || ""} ${fact.exceptionType || ""} ${fact.severity || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
      return /^exception/i.test(String(fact.type || "")) &&
        !/\b(?:resolved|closed|cleared)\b/i.test(String(fact.status || "")) &&
        /\b(?:wrong[-_\s]?consignee|wrong[-_\s]?customer|misdelivered|delivered to (?:the )?wrong|immediate)\b/i.test(text);
    });
  if (
    statusIs(resolvedState.gates?.arrival, ["not-arrived", "waiting", "pending", "missing", "unknown"]) &&
    !finalPodAtBoundary &&
    !terminalCompletionNeedsCertification &&
    !finalBoundaryExceptionState &&
    (
      statusIs(resolvedState.gates?.pickup, ["done", "picked-up", "loaded", "recovered", "blocked", "exception", "driver-onsite", "onsite", "scheduled"]) ||
      statusIs(resolvedState.gates?.delivery, ["scheduled", "out-for-delivery", "delivered", "reported"]) ||
      statusIs(resolvedState.gates?.pod, ["done", "received", "pod-found", "found", "pending"])
    )
  ) {
    const guardAt = resolvedState.gates?.arrival?.at || resolvedState.updatedAt || state.updatedAt || "";
    const gates = {
      ...resolvedState.gates,
      pickup: gate("pickup", "waiting", "Pickup is not applicable until destination arrival is proven.", {
        at: resolvedState.gates?.pickup?.at || guardAt,
        source: "canonical-arrival-sanity",
        confidence: "high",
      }),
      delivery: gate("delivery", "waiting", "Delivery is not applicable until destination arrival and pickup are proven.", {
        at: resolvedState.gates?.delivery?.at || guardAt,
        source: "canonical-arrival-sanity",
        confidence: "high",
      }),
      pod: gate("pod", "waiting", "POD is not applicable before final delivery.", {
        at: resolvedState.gates?.pod?.at || guardAt,
        source: "canonical-arrival-sanity",
        confidence: "high",
      }),
    };
    resolvedState = {
      ...resolvedState,
      gates,
      phase: nextPhaseFromGates(gates),
      nextAction: nextActionFromGates(gates),
      summary: canonicalPhaseSummary(nextPhaseFromGates(gates)),
    };
  }
  const latestEmail = latestShipmentEmail(group);
  const operatorNotes = array(group.bySource.get("operator-note")).flat().map((note) => ({
    type: "operator-note",
    label: "Operator note",
    summary: note.note || note.text || note.summary || "",
    at: note.createdAt || note.at || "",
    source: "operator-note",
  })).filter((note) => note.summary);
  resolvedState = {
    ...resolvedState,
    awb: group.awb,
  };
  const updatedAt = first(state.updatedAt, evidence.sort((a, b) => eventTime(b.at) - eventTime(a.at))[0]?.at);
  const operationalRisk = operationalRiskFromState({ ...resolvedState, updatedAt }, metadata, evidence);
  const canonicalNextAction = canonicalNextActionForState(resolvedState, metadata);
  // Evidence order must be TOTAL: the input order feeds back through the
  // previous cycle's own packet rows, so time-tied facts flapped positions
  // between cron cycles and rewrote the whole multi-MB snapshot with
  // identical content.
  const canonicalEvidence = dedupeFacts([...operatorNotes, ...evidence]
    .map((fact) => sanitizeCanonicalEvidenceFact(fact))
    .filter(Boolean))
    .sort((a, b) =>
      eventTime(a.at) - eventTime(b.at) ||
      String(a.type || "").localeCompare(String(b.type || "")) ||
      String(a.summary || "").localeCompare(String(b.summary || "")) ||
      String(a.evidence || "").localeCompare(String(b.evidence || "")));
  return {
    awb: group.awb,
    metadata,
    gates: resolvedState.gates,
    phase: resolvedState.phase,
    currentState: resolvedState.summary || resolvedState.label || resolvedState.phase,
    stateReason: first(resolvedState.stateReason, resolvedState.summary, resolvedState.label, resolvedState.phase),
    nextAction: canonicalNextAction,
    storage: resolvedState.storage,
    exceptions: resolvedState.exceptions || [],
    evidence: canonicalEvidence,
    operationalRisk,
    confidence: resolvedState.confidence || "medium",
    source: resolvedState.source,
    updatedAt,
    latestEmail,
  };
}

function latestShipmentEmail(group) {
  return group.rows
    .map((row) => row.shipment?.lastEmail || row.shipment?.email || null)
    .filter((email) => email && (email.threadId || email.messageId || email.summary || email.at))
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function buildCanonicalShipments(memory = {}) {
  return [...groupShipmentRows(memory).values()]
    .map((group) => canonicalShipment(group, memory))
    .sort((a, b) => a.awb.localeCompare(b.awb));
}

function terminalFactSupersededForPublicEvidence(record, fact) {
  const gates = record.gates || {};
  const terminal = ["delivered", "completed"].includes(String(record.phase || "").toLowerCase()) ||
    statusIs(gates.pod, ["done", "received", "pod-found", "found"]);
  if (!terminal) return false;
  const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
  if (/operator-control-gap/i.test(String(fact.type || ""))) return true;
  return /\b(?:pod[-\s]?pending|pod to follow|pod still missing|pod missing|pod needed|awaiting pod|collect pod|pickup eta\/pod still missing|pickup eta\/pod missing|final delivery\/pod remains pending|could not open (?:first )?pod attachment|can'?t open attached)\b/i.test(text);
}

function publicFactSupersededForPublicEvidence(record = {}, fact = {}) {
  if (terminalFactSupersededForPublicEvidence(record, fact)) return true;
  const sourceFacts = [
    ...array(record.evidence),
    ...array(record.facts),
    ...array(record.factLedger),
  ];
  const text = factText(fact);
  if (/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|not locate|cannot locate|can't locate|cant locate|cargo not found|not found|driver was told|after he is loaded|doctors? appointment)\b/i.test(text)) {
    const factAt = eventTime(factOccurredAt(fact));
    const laterLoadedOrPickedUp = sourceFacts.some((sourceFact) => {
      const sourceText = factText(sourceFact);
      const sourceAt = eventTime(factOccurredAt(sourceFact));
      if (factAt && sourceAt && sourceAt < factAt) return false;
      return /\b(?:pickup[-_\s]?confirmed|pickup[-_\s]?loaded|picked up|driver (?:is )?(?:now )?loaded|\bloaded\b|recovered)\b/i.test(sourceText) &&
        !onwardHandlerTransferText(sourceText);
    });
    if (laterLoadedOrPickedUp) return true;
  }
  return exceptionSupersededByFacts(fact, sourceFacts);
}

function publicNextActionForCanonicalRecord(record = {}, gates = {}, deliveryDone = false, podDone = false) {
  const phase = String(record.phase || "").toLowerCase();
  const pickupStatus = String(gates.pickup?.status || "").toLowerCase();
  const deliveryStatus = String(gates.delivery?.status || "").toLowerCase();
  const recoveryText = [
    phase,
    record.currentState,
    record.nextAction,
    gates.delivery?.evidence,
    gates.delivery?.summary,
    gates.pod?.evidence,
    gates.pod?.summary,
    ...(record.exceptions || []).map((item) => `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`),
  ].filter(Boolean).join(" ");
  const deliveryBlocked = phase === "delivery-blocked" ||
    statusIs(gates.delivery, ["blocked", "exception", "problem"]) ||
    statusIs(gates.pod, ["blocked", "exception", "problem"]);
  if (deliveryBlocked && terminalRecoveryBlockerText(recoveryText)) {
    const defaultAction = "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.";
    const staleCloseoutLanguage = /\b(?:do not treat this as normal delivered\/POD closeout|normal delivered\/POD closeout)\b/i.test(record.nextAction || "");
    return record.nextAction &&
      !staleCloseoutLanguage &&
      /\b(?:escalate|recover|recovery|return|returned|redeliver|who received|wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)|mis[-\s]?deliver|delivery blocker)\b/i.test(record.nextAction)
      ? record.nextAction
      : defaultAction;
  }
  if (deliveryBlocked) return record.nextAction || "Call the broker/driver now, confirm the delivery blocker, and coordinate receiver instructions.";
  if (podDone || ["delivered", "completed"].includes(phase)) return "No action; POD is in memory.";
  if (phase === "out-for-delivery" || deliveryStatus === "out-for-delivery") return "Track delivery completion and collect POD.";
  if (deliveryDone) return "Collect signed POD/proof of delivery.";
  if (["done", "picked-up", "airport-picked-up"].includes(pickupStatus)) return "Confirm final delivery and collect POD.";
  if (
    phase === "ready-for-pickup" ||
    (
      statusIs(gates.customs, ["done", "released", "cleared"]) &&
      statusIs(gates.fees, ["done", "paid", "unknown-offline"]) &&
      statusIs(gates.dispatch, ["done", "sent", "dispatched", "broker-awarded", "broker-alerted"]) &&
      !statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"])
    )
  ) {
    return nextActionFromGates(gates, record.metadata || {});
  }
  return record.nextAction || "";
}

function genericContextEvidenceFact(fact = {}) {
  const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
  return /\bGmail thread mentions this AWB; no operational status change detected\b/i.test(text) ||
    /\bAttachment metadata indicates operational evidence; PDF text was not available in this refresh\b/i.test(text);
}

function publicEvidencePriority(fact = {}) {
  const text = `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`;
  let score = eventTime(fact.at) / 1e13;
  if (/\b(?:exception|pickup blocked|customs hold|inbond|not locate|cannot locate|flight deleted|deleted in uc360|not in (?:the )?ua area|awb copy)\b/i.test(text)) score += 100;
  if (/\b(?:pre-arrival-flight-update|planned arrival|arrival is expected|arrival to .*planned|departed .*arrival)\b/i.test(text)) score += 90;
  if (/\b(?:customs-release-received|release\/?d\/?o|delivery order|customs released|98 released|d\/?o)\b/i.test(text)) score += 80;
  if (/\b(?:arrival-notice-received|arrival-inferred-release-ready|carrier-arrival-confirmed|arrival\/on-hand|on[-\s]?hand|available for pickup|ready for pickup)\b/i.test(text)) score += 70;
  if (/\b(?:pickup|driver|station|quote|broker|storage|detention)\b/i.test(text)) score += 40;
  if (genericContextEvidenceFact(fact)) score -= 100;
  return score;
}

function prioritizePublicEvidence(facts = []) {
  return [...facts].sort((a, b) => publicEvidencePriority(b) - publicEvidencePriority(a));
}

function cleanDispatchBrokerName(value) {
  const broker = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .replace(/^(?:so|then|now)\s+/i, "")
    .replace(/^(?:done|sent|broker[-\s]?awarded|awarded|dispatched|broker[-\s]?alerted|quote[-\s]?received|quotes[-\s]?in)\s+/i, "")
    .replace(/\b(?:broker|carrier|dispatch|pickup|quote|rate|status request)\b$/i, "")
    .trim();
  if (!broker || /^(?:broker|carrier|pickup broker|dispatch|unknown|not found|alex(?: angel)?|jordan(?: reed)?|operations piki|piki(?:io)?|piki operations)$/i.test(broker)) return "";
  return broker;
}

function internalPikiContact(value) {
  return /@(?:demo-freight\.example|harbor-forwarding\.example)$/i.test(String(value || "").trim());
}

function internalPikiOperatorName(value) {
  return /\b(?:alex(?:\s+angel)?|jordan(?:\s+reed)?|operations\s+piki|piki(?:io)?|piki\s+operations)\b/i.test(String(value || ""));
}

function redactInternalPikiOperatorText(value) {
  return String(value || "")
    .replace(/\bAlex\s+Morgan(?:\s*\(\d{3}\)\d{3}-\d{4})?(?:\s+Pikiio)?\b/gi, "internal/Piki recipient")
    .replace(/\bJordan(?:\s+Reed)?\b/gi, "internal/Piki operator")
    .replace(/\bOperations\s+Piki\b/gi, "internal/Piki operations");
}

function sanitizeCanonicalEvidenceFact(fact = {}) {
  if (!fact || typeof fact !== "object") return null;
  const contactEmail = fact.contactEmail || fact.email || fact.targetEmail || "";
  const brokerText = fact.broker || fact.selectedBroker || fact.pickupOwner || fact.owner || "";
  const hasInternalBroker = internalPikiContact(contactEmail) || internalPikiOperatorName(brokerText);
  const typeLabel = `${fact.type || ""} ${fact.label || ""}`;
  if (hasInternalBroker && /\bbroker[-_\s]?disregarded\b/i.test(typeLabel)) return null;

  const sanitized = {
    ...fact,
    summary: redactInternalPikiOperatorText(fact.summary || ""),
    evidence: redactInternalPikiOperatorText(fact.evidence || ""),
  };
  if (hasInternalBroker) {
    sanitized.broker = "";
    sanitized.selectedBroker = "";
    sanitized.pickupOwner = "";
    sanitized.owner = "";
    if (internalPikiContact(contactEmail)) sanitized.contactEmail = "";
    if (internalPikiContact(fact.email)) sanitized.email = "";
    if (internalPikiContact(fact.targetEmail)) sanitized.targetEmail = "";
  } else if (sanitized.broker) {
    sanitized.broker = cleanDispatchBrokerName(sanitized.broker) || "";
  }
  return sanitized;
}

function dispatchBrokerFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+is\s+the\s+active\s+pickup\s+broker\s+path\b/i,
    /\btold\s+[A-Z][A-Za-z.' -]{1,40}\/([A-Z][A-Za-z0-9&.' -]{1,70})\b[^.;\n]{0,140}\b(?:pick\s*up|pickup|recover|recovery)\b/i,
    /\basked\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+to\s+(?:pick\s*up|recover)\b/i,
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

function moneyAmountFromText(value) {
  return String(value || "").match(/\$\s?\d[\d,]*(?:\.\d{2})?/)?.[0]?.replace(/\s+/g, "") || "";
}

function dispatchOwnerFact(facts = [], dispatchGate = {}) {
  const dispatchText = `${dispatchGate.evidence || ""} ${dispatchGate.summary || ""}`;
  const gateBroker = cleanDispatchBrokerName(dispatchGate.broker || dispatchGate.selectedBroker || dispatchGate.pickupOwner || "");
  if (gateBroker || dispatchBrokerFromText(dispatchText)) {
    return {
      broker: gateBroker || dispatchBrokerFromText(dispatchText),
      contactEmail: dispatchGate.contactEmail || "",
      amount: dispatchGate.amount || dispatchGate.rate || moneyAmountFromText(dispatchText),
      summary: dispatchGate.evidence || "Pickup dispatch owner is confirmed by the canonical dispatch gate.",
      at: dispatchGate.at || "",
      source: dispatchGate.source || "canonical-shipment-pipeline",
    };
  }
  return [...facts]
    .filter((fact) => {
      const typeLabel = `${fact.type || ""} ${fact.label || ""}`;
      const text = `${fact.summary || ""} ${fact.evidence || ""}`;
      return /\b(?:broker[-_ ]?awarded|broker[-_ ]?confirmed|broker[-_ ]?alerted|pickup[-_ ]?quote[-_ ]?received|quote[-_ ]?received|quotes[-_ ]?in|pickup[-_ ]?broker[-_ ]?awarded|dispatch|broker award|pickup[-_ ]?onsite|shipment[-_ ]?group[-_ ]?linked)\b/i.test(typeLabel) ||
        Boolean(dispatchBrokerFromText(text));
    })
    .map((fact) => {
      const text = `${fact.summary || ""} ${fact.evidence || ""}`;
      const contactEmail = fact.contactEmail || "";
      if (/@(?:demo-freight\.example|harbor-forwarding\.example)$/i.test(String(contactEmail).trim())) return null;
      const broker = cleanDispatchBrokerName(fact.broker || fact.selectedBroker || dispatchBrokerFromText(text));
      return broker ? {
        broker,
        contactEmail,
        amount: fact.amount || fact.rate || moneyAmountFromText(text),
        summary: fact.summary || fact.evidence || "Pickup dispatch owner is confirmed by source evidence.",
        at: fact.at || "",
        source: fact.source || "email-first-truth",
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => eventTime(b.at) - eventTime(a.at))[0] || null;
}

function publicFreightBrokerFromCanonicalRecord(record = {}, gates = {}, facts = []) {
  const dispatchStatus = String(gates.dispatch?.status || "").toLowerCase();
  const owner = dispatchOwnerFact(facts, gates.dispatch);
  const pickupStatus = String(gates.pickup?.status || "").toLowerCase();
  if (
    !["done", "broker-awarded", "awarded", "sent", "dispatched", "broker-alerted", "quote-received", "quotes-in"].includes(dispatchStatus) &&
    !["driver-onsite", "onsite", "scheduled", "done"].includes(pickupStatus) &&
    !owner
  ) {
    return null;
  }
  if (!owner?.broker) return null;
  if (["quote-received", "quotes-in"].includes(dispatchStatus)) {
    return {
      broker: owner.broker,
      status: "quote-received",
      brokerStatus: "pickup-quote-received",
      pickupPlan: owner.summary,
      nextAction: `Approve/award ${owner.broker}${owner.amount ? ` at ${owner.amount}` : ""} or choose another pickup broker; then track pickup execution and POD.`,
      contactEmail: owner.contactEmail || "",
      rate: owner.amount || "",
      source: owner.source || "canonical-shipment-pipeline",
      evidence: [{
        type: "dispatch-quote",
        summary: owner.summary,
        at: owner.at || record.updatedAt || "",
        source: owner.source || "canonical-shipment-pipeline",
      }],
    };
  }
  if (dispatchStatus === "broker-alerted") {
    return {
      broker: owner.broker,
      status: "alert-sent",
      brokerStatus: "pickup-alert-sent",
      pickupPlan: owner.summary,
      nextAction: `Wait for ${owner.broker} acknowledgement/quote or confirm the dispatch path; do not rediscover the pickup broker.`,
      contactEmail: owner.contactEmail || "",
      rate: owner.amount || "",
      source: owner.source || "canonical-shipment-pipeline",
      evidence: [{
        type: "dispatch-alert",
        summary: owner.summary,
        at: owner.at || record.updatedAt || "",
        source: owner.source || "canonical-shipment-pipeline",
      }],
    };
  }
  return {
    broker: owner.broker,
    status: "freight-awarded",
    brokerStatus: "pickup-owner-confirmed",
    pickupPlan: owner.summary,
    nextAction: "Confirm pickup execution and collect loaded proof/POD.",
    contactEmail: owner.contactEmail || "",
    rate: owner.amount || "",
    source: owner.source || "canonical-shipment-pipeline",
    evidence: [{
      type: "dispatch-owner",
      summary: owner.summary,
      at: owner.at || record.updatedAt || "",
      source: owner.source || "canonical-shipment-pipeline",
    }],
  };
}

function sanitizePublicFactForShipmentTruth(fact = {}) {
  const row = normalizeExceptionItem({
    ...fact,
    label: fact.label || fact.type || "Evidence",
    summary: fact.summary || fact.evidence || "",
  });
  const text = `${row.type || ""} ${row.label || ""} ${row.summary || ""} ${row.evidence || ""} ${row.subject || ""}`;
  if (
    /\b(?:payment|ground fees?|handling fees?|cargosprint|cargo sprint|receipt|invoice)\b/i.test(text) &&
    /\bpayment (?:has been )?delivered(?:\s+to|\s+for)?\b/i.test(row.subject || "")
  ) {
    row.subject = "Ground-fee payment receipt";
  }
  return row;
}

function canonicalShipmentAsCompanionShipment(record) {
  const metadata = record.metadata || {};
  let gates = record.gates || {};
  const publicDeliveryScheduledFact = latestDeliveryScheduledFact(record.evidence || []);
  if (
    publicDeliveryScheduledFact &&
    statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) &&
    !statusIs(gates.delivery, ["delivered", "done", "completed"]) &&
    !statusIs(gates.pod, ["done", "received", "pod-found", "found"])
  ) {
    gates = {
      ...gates,
      delivery: gate("delivery", "scheduled", publicDeliveryScheduledFact.summary || publicDeliveryScheduledFact.evidence || "Delivery is scheduled; collect POD after completion.", {
        at: factOccurredAt(publicDeliveryScheduledFact),
        source: publicDeliveryScheduledFact.source || "email-first-truth",
        confidence: publicDeliveryScheduledFact.confidence || "high",
        deliveryScheduledDate: publicDeliveryScheduledFact.deliveryScheduledDate || "",
      }),
      pod: gate("pod", "pending", "POD is needed after scheduled delivery completes.", {
        at: factOccurredAt(publicDeliveryScheduledFact),
        source: publicDeliveryScheduledFact.source || "email-first-truth",
        confidence: publicDeliveryScheduledFact.confidence || "high",
      }),
    };
    record = {
      ...record,
      gates,
      phase: "pod-needed",
      currentState: canonicalPhaseSummary("pod-needed"),
      summary: canonicalPhaseSummary("pod-needed"),
      nextAction: nextActionFromGates(gates, metadata),
      exceptions: array(record.exceptions).filter((item) => {
        const text = `${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
        return !/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|not locate|cannot locate|can't locate|cant locate|cargo not found|not found|driver was told|after he is loaded|doctors? appointment)\b/i.test(text);
      }),
    };
  }
  const publicDeliveryScheduleGateText = `${gates.delivery?.evidence || ""} ${gates.delivery?.summary || ""} ${gates.delivery?.deliveryScheduledDate || ""} ${gates.delivery?.scheduledDate || ""}`;
  const publicConcreteDeliverySchedule = Boolean(
    gates.delivery?.deliveryScheduledDate ||
    gates.delivery?.scheduledDate ||
    /\b(?:delivery is scheduled|scheduled delivery|delivery tomorrow|deliver tomorrow|delivering tomorrow|tomorrow morning|tomorrow afternoon|delivery eta|appointment)\b/i.test(publicDeliveryScheduleGateText)
  );
  if (
    !publicDeliveryScheduledFact &&
    statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) &&
    statusIs(gates.delivery, ["scheduled"]) &&
    !publicConcreteDeliverySchedule
  ) {
    gates = {
      ...gates,
      delivery: gate("delivery", "waiting", "Pickup is confirmed; final delivery is not proven or scheduled by source evidence yet.", {
        at: gates.pickup?.at || gates.delivery?.at || record.updatedAt || "",
        source: gates.pickup?.source || "canonical-shipment-pipeline",
        confidence: gates.pickup?.confidence || "high",
      }),
      pod: statusIs(gates.pod, ["done", "received", "pod-found", "found"])
        ? gates.pod
        : gate("pod", "pending", "POD is needed after pickup.", {
          at: gates.pickup?.at || record.updatedAt || "",
          source: gates.pickup?.source || "canonical-shipment-pipeline",
          confidence: gates.pickup?.confidence || "high",
        }),
    };
    const nextPhase = nextPhaseFromGates(gates);
    record = {
      ...record,
      gates,
      phase: nextPhase,
      currentState: canonicalPhaseSummary(nextPhase),
      summary: canonicalPhaseSummary(nextPhase),
      nextAction: nextActionFromGates(gates, metadata),
    };
  }
  if (
    statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]) &&
    statusIs(gates.delivery, ["blocked", "exception", "problem"])
  ) {
    const pickupAt = eventTime(gates.pickup?.at);
    const staleStationExceptions = array(record.exceptions).filter((item) => {
      const text = `${item.type || ""} ${item.exceptionType || ""} ${item.where || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
      if (!/\b(?:station[-_\s]?cargo[-_\s]?not[-_\s]?found|driver[-_\s]?waiting|pickup[-_\s]?blocked|station|pickup|driver|not locate|cannot locate|can't locate|cant locate|not found|detention|after he is loaded)\b/i.test(text)) {
        return false;
      }
      const exceptionAt = eventTime(item.at);
      return pickupAt && (!exceptionAt || pickupAt >= exceptionAt);
    });
    if (staleStationExceptions.length) {
      gates = {
        ...gates,
        delivery: gate("delivery", "waiting", "Pickup execution supersedes the older station/pickup blocker; final delivery is not proven yet.", {
          at: gates.pickup?.at || gates.delivery?.at || record.updatedAt || "",
          source: gates.pickup?.source || "canonical-shipment-pipeline",
          confidence: gates.pickup?.confidence || "high",
        }),
        pod: statusIs(gates.pod, ["done", "received", "pod-found", "found"])
          ? gates.pod
          : gate("pod", "pending", "POD is needed after pickup.", {
            at: gates.pickup?.at || record.updatedAt || "",
            source: gates.pickup?.source || "canonical-shipment-pipeline",
            confidence: gates.pickup?.confidence || "high",
          }),
      };
      record = {
        ...record,
        phase: "pod-needed",
        currentState: canonicalPhaseSummary("pod-needed"),
        summary: canonicalPhaseSummary("pod-needed"),
        nextAction: nextActionFromGates(gates, metadata),
        exceptions: array(record.exceptions).filter((item) => !staleStationExceptions.includes(item)),
      };
    }
  }
  if (
    String(record.phase || "").toLowerCase() === "pickup-docs-needed" &&
    statusIs(gates.customs, ["done", "released", "cleared"])
  ) {
    const releaseAt = eventTime(gates.customs?.at);
    const staleDocsExceptions = array(record.exceptions).filter((item) => {
      if (!pickupDocsExceptionItem(item)) return false;
      const exceptionAt = eventTime(item.at);
      return releaseAt && (!exceptionAt || releaseAt >= exceptionAt);
    });
    if (staleDocsExceptions.length) {
      const nextExceptions = array(record.exceptions).filter((item) => !staleDocsExceptions.includes(item));
      const nextPhase = nextPhaseFromGates({
        ...gates,
        pickup: statusIs(gates.pickup, ["blocked", "exception", "incomplete"])
          ? gate("pickup", "waiting", "Older pickup-docs request was superseded by later release/DO evidence.", {
            at: gates.customs?.at || gates.pickup?.at || record.updatedAt || "",
            source: gates.customs?.source || "canonical-shipment-pipeline",
            confidence: gates.customs?.confidence || "high",
          })
          : gates.pickup,
      });
      gates = {
        ...gates,
        pickup: statusIs(gates.pickup, ["blocked", "exception", "incomplete"])
          ? gate("pickup", "waiting", "Older pickup-docs request was superseded by later release/DO evidence.", {
            at: gates.customs?.at || gates.pickup?.at || record.updatedAt || "",
            source: gates.customs?.source || "canonical-shipment-pipeline",
            confidence: gates.customs?.confidence || "high",
          })
          : gates.pickup,
      };
      record = {
        ...record,
        phase: nextPhase,
        currentState: canonicalPhaseSummary(nextPhase),
        summary: canonicalPhaseSummary(nextPhase),
        nextAction: nextActionFromGates(gates, metadata),
        exceptions: nextExceptions,
      };
    }
  }
  if (record.operationalRisk?.level && String(record.operationalRisk.level).toLowerCase() !== "none") {
    const riskAsException = {
      type: record.operationalRisk.type || "operational-risk",
      exceptionType: record.operationalRisk.type || "",
      summary: record.operationalRisk.reason || "",
      evidence: record.operationalRisk.evidence || "",
      at: record.operationalRisk.at || record.updatedAt || "",
    };
    if (exceptionSupersededByFacts(riskAsException, [
      ...array(record.evidence),
      ...array(record.facts),
      ...array(record.factLedger),
    ])) {
      record = {
        ...record,
        operationalRisk: {
          level: "none",
          type: "",
          reason: "",
          action: "",
          evidence: "",
          source: "canonical-pipeline",
        },
      };
    }
  }
  const arrivalOverdue = record.operationalRisk?.type === "arrival-unverified";
  const publicCurrentState = arrivalOverdue
    ? "Arrival overdue — confirm with station."
    : canonicalPhaseSummary(record.phase);
  const preferredPublicException = preferredExceptionForPhase(record.exceptions || [], record.phase || "", gates, record.awb);
  const preferredPublicSummary = ["delivery-blocked", "pickup-blocked", "customs-hold", "arrival-incomplete"].includes(String(record.phase || ""))
    ? preferredPublicException?.summary || ""
    : "";
  const publicStateReason = first(preferredPublicSummary, record.stateReason, record.currentState, publicCurrentState);
  if (preferredPublicSummary && record.phase === "delivery-blocked") {
    gates = {
      ...gates,
      pickup: statusIs(gates.pickup, ["blocked", "exception", "incomplete"])
        ? gate("pickup", "blocked", preferredPublicSummary, {
          at: preferredPublicException.at || gates.pickup?.at || record.updatedAt || "",
          source: preferredPublicException.source || gates.pickup?.source || "email-first-truth",
          confidence: preferredPublicException.confidence || gates.pickup?.confidence || "high",
        })
        : gates.pickup,
      delivery: gate("delivery", "blocked", preferredPublicSummary, {
        at: preferredPublicException.at || gates.delivery?.at || record.updatedAt || "",
        source: preferredPublicException.source || gates.delivery?.source || "email-first-truth",
        confidence: preferredPublicException.confidence || gates.delivery?.confidence || "high",
      }),
    };
  } else if (preferredPublicSummary && record.phase === "pickup-blocked") {
    gates = {
      ...gates,
      pickup: gate("pickup", "blocked", preferredPublicSummary, {
        at: preferredPublicException.at || gates.pickup?.at || record.updatedAt || "",
        source: preferredPublicException.source || gates.pickup?.source || "email-first-truth",
        confidence: preferredPublicException.confidence || gates.pickup?.confidence || "high",
      }),
    };
  }
  const rawPublicEvidence = array(record.evidence);
  const gateSourceFactIds = new Set(
    Object.values(gates)
      .flatMap((gateValue) => Array.isArray(gateValue?.sourceFactIds) ? gateValue.sourceFactIds : [])
      .filter(Boolean),
  );
  const citedFacts = rawPublicEvidence
    .filter((fact) => gateSourceFactIds.has(canonicalSourceFactId(fact)))
    .map((fact) => sanitizePublicFactForShipmentTruth(fact));
  const publicEvidence = rawPublicEvidence
    .filter((fact) => !publicFactSupersededForPublicEvidence(record, fact))
    .filter((fact) => !genericPreAlertExceptionItem(fact));
  const prioritizedEvidence = prioritizePublicEvidence(publicEvidence);
  const gateFacts = Object.entries(gates).map(([name, gateValue]) => {
    const cleanEvidence = collapseStatusEcho(gateValue.status, gateValue.evidence);
    return {
    type: `canonical-${name}`,
    label: `${name}: ${gateValue.status}`,
    summary: cleanEvidence ? `${gateValue.status}: ${cleanEvidence}` : String(gateValue.status || ""),
    evidence: cleanEvidence,
    at: gateValue.at || record.updatedAt || "",
    source: "canonical-shipment-pipeline",
    confidence: gateValue.confidence || record.confidence || "",
    };
  });
  const operatorFacts = publicEvidence
    .filter((fact) => fact.type === "operator-note")
    .map((fact) => ({
      ...fact,
      label: fact.label || "Operator note",
      summary: fact.summary || fact.evidence || "",
    }));
  const proofFacts = prioritizedEvidence
    .filter((fact) => fact.type !== "operator-note" && /gmail-proof|operator-note|truth-audit/i.test(fact.source || ""))
    .filter((fact) => !genericContextEvidenceFact(fact) || publicEvidencePriority(fact) > 0)
    .slice(0, 8)
    .map((fact) => sanitizePublicFactForShipmentTruth(fact));
  const operationalFacts = prioritizedEvidence
    .filter((fact) => /arrival notice|notice of arrival|\bnoa\b|carrier-arrival|station[-\s]?arrival|on[-\s]?hand|available for pickup|ready for pickup|piece count|pieces?|payment|ground|handling|cargosprint|receipt|station fees?|storage|last free|lfd|quote|broker|award|approved|selected|pickup|driver|onsite|blocker|cannot see|can'?t see|not visible|not showing/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""} ${fact.evidence || ""}`))
    .slice(0, 6)
    .map((fact) => sanitizePublicFactForShipmentTruth(fact));
  const riskFacts = record.operationalRisk?.level && record.operationalRisk.level !== "none"
    ? [{
      type: "canonical-risk",
      label: record.operationalRisk.type || "Operational risk",
      summary: record.operationalRisk.reason || "",
      evidence: record.operationalRisk.evidence || "",
      at: record.updatedAt || "",
      source: "canonical-shipment-pipeline",
      confidence: record.confidence || "",
    }]
    : [];
  const factRows = dedupeFacts([...operatorFacts, ...citedFacts, ...proofFacts, ...operationalFacts]);
  const derivedFacts = dedupeFacts([...riskFacts, ...gateFacts]);
  const riskLevel = String(record.operationalRisk?.level || "none").toLowerCase();
  const deliveryDone = ["done", "delivered", "completed"].includes(String(gates.delivery?.status || "").toLowerCase());
  const podDone = statusIs(gates.pod, ["done", "received", "pod-found", "found"]);
  const publicNextAction = arrivalOverdue
    ? record.operationalRisk.action
    : publicNextActionForCanonicalRecord(record, gates, deliveryDone, podDone);
  const publicFreightBroker = publicFreightBrokerFromCanonicalRecord(record, gates, prioritizedEvidence);
  const customsStatus = String(gates.customs?.status || "").toLowerCase();
  const publicClearanceStatus = statusIs(gates.customs, ["done", "released", "cleared"])
    ? "released"
    : statusIs(gates.customs, ["blocked", "customs-hold", "hold", "exam-hold"])
      ? "not-cleared"
      : ["pending", "waiting", "missing"].includes(customsStatus)
        ? "pending"
        : "";
  const etaPassedNoArrival = Boolean(
    metadata.etaPastUnverified &&
      !statusIs(gates.arrival, ["done", "arrived", "available", "on-hand"]) &&
      !["delivered", "out-for-delivery", "done"].includes(String(gates.delivery?.status || "").toLowerCase()) &&
      !statusIs(gates.pickup, ["done", "picked-up", "loaded", "recovered"]),
  );
  return {
    awb: metadata.displayAwb || formatAwb(record.awb),
    id: metadata.id || record.awb,
    station: metadata.station || metadata.airport || "",
    airline: metadata.airline || "",
    client: metadata.client || "",
    consignee: metadata.consignee || "",
    eta: metadata.eta || "",
    etaSource: metadata.etaSource || "",
    etaConflict: metadata.etaConflict || "",
    etaUnresolvedRelative: Boolean(metadata.etaUnresolvedRelative),
    etaPastUnverified: Boolean(metadata.etaPastUnverified),
    trackingException: etaPassedNoArrival
      ? {
          type: "eta-passed-no-arrival-proof",
          summary: "ETA passed, but no station/on-hand proof is in memory.",
          eta: metadata.eta || "",
          source: metadata.etaSource || "",
          observedAt: metadata.etaObservedAt || metadata.updatedAt || "",
        }
      : undefined,
    cargo: metadata.cargo || {},
    flightDetails: metadata.flightDetails || {},
    route: metadata.route || metadata.flightDetails?.route || "",
    origin: metadata.origin || metadata.flightDetails?.origin || "",
    destination: metadata.destination || metadata.flightDetails?.destination || metadata.station || metadata.airport || "",
    delivery: metadata.delivery || {},
    shipper: metadata.shipper || {},
    commercial: metadata.commercial || {},
    tms: {
      order: metadata.tmsOrderId || "",
      status: metadata.tms?.status || metadata.tms?.tmsStatus || "",
      tmsStatus: metadata.tms?.tmsStatus || metadata.tms?.status || "",
      statusDescription: metadata.tms?.statusDescription || "",
      nextTask: metadata.tms?.nextTask || metadata.flightDetails?.recoveryHint || metadata.flightDetails?.etaHint || "",
      snapshotTime: metadata.tms?.snapshotTime || "",
      source: metadata.tms?.source || "tms-detail",
      pieces: metadata.cargo?.pieces || metadata.pieces || "",
      pallets: metadata.cargo?.pallets || metadata.pallets || "",
      weight: metadata.cargo?.weight || metadata.weight || "",
      weightUom: metadata.cargo?.weightUom || "",
      dims: metadata.cargo?.dims || metadata.dims || "",
      dimensions: metadata.cargo?.dimensions || metadata.dims || "",
      commodity: metadata.cargo?.commodity || "",
      contents: metadata.cargo?.contents || "",
      flight: metadata.flightDetails?.primaryFlight || "",
      flightNumber: metadata.flightDetails?.primaryFlight || "",
      tmsFlight: metadata.flightDetails?.tmsFlight || "",
      dep: metadata.flightDetails?.departureLeg || "",
      arr: metadata.flightDetails?.arrivalLeg || "",
      route: metadata.flightDetails?.route || metadata.route || "",
      origin: metadata.flightDetails?.origin || metadata.origin || "",
      destination: metadata.flightDetails?.destination || metadata.destination || "",
      deliveryCourier: metadata.delivery?.courier || "",
      consigneePhone: metadata.delivery?.contactPhone || "",
      customerCharge: metadata.commercial?.customerCharge || "",
      billingTotal: metadata.commercial?.billingTotal || "",
      vendorCost: metadata.commercial?.vendorCost || "",
      costTotal: metadata.commercial?.costTotal || "",
    },
    contacts: {
      station: metadata.stationContact || undefined,
      customs: metadata.customsBroker || undefined,
      freight: publicFreightBroker || undefined,
    },
    stationEmail: metadata.stationContact?.email || metadata.stationContext?.stationEmail || "",
    stationPhone: metadata.stationContact?.phone || metadata.stationContext?.stationPhone || "",
    stationContext: metadata.stationContext || undefined,
    customsBroker: metadata.customsBroker || undefined,
    freightBroker: publicFreightBroker || undefined,
    // "incomplete" is inferred/partial arrival — labeling it "arrived" was
    // the banned class (arrived only when proven) and fed the label back into
    // next cycle's explicitArrived self-feedback.
    arrivalStatus: gates.arrival?.status === "done" ? "arrived" : gates.arrival?.status === "incomplete" ? "arrival-incomplete" : gates.arrival?.status === "not-arrived" ? "not-arrived" : "",
    clearanceStatus: publicClearanceStatus,
    arrivedAt: gates.arrival?.at || "",
    pickupStatus: gates.pickup?.status === "done" ? "picked up" : gates.pickup?.status || "",
    pickedUpAt: gates.pickup?.at || "",
    deliveredAt: deliveryDone || podDone ? gates.delivery?.at || gates.pod?.at || "" : "",
    stage: record.phase,
    currentState: publicCurrentState,
    stateReason: publicStateReason,
    nextAction: publicNextAction,
    storage: record.storage || null,
    operationalRisk: record.operationalRisk || riskNone(),
    completed: ["delivered", "completed"].includes(record.phase) || podDone,
    opsState: {
      phase: record.phase,
      label: publicCurrentState || record.phase,
      summary: publicCurrentState || "",
      nextAction: publicNextAction,
      urgency: arrivalOverdue ? "urgent" : ["critical", "high"].includes(riskLevel) ? "urgent" : record.exceptions?.some((item) => item.severity === "needs-action") ? "urgent" : "",
      ...(arrivalOverdue ? { needsHuman: true } : {}),
      gates,
      exceptions: record.exceptions || [],
      operationalRisk: record.operationalRisk || riskNone(),
      events: factRows,
      derivedFacts,
      source: "canonical-shipment-pipeline",
      updatedAt: record.updatedAt || "",
      latestEventAt: record.updatedAt || "",
      confidence: record.confidence || "",
    },
    emailValidation: {
      status: record.phase,
      summary: publicCurrentState || "",
      nextAction: publicNextAction,
      events: factRows,
      proof: factRows,
      latestEventAt: record.updatedAt || "",
    },
    lastEmail: record.latestEmail
      ? { ...record.latestEmail, source: record.latestEmail.source || "shipment-memory" }
      : {
        at: record.updatedAt || "",
        summary: factRows[0]?.summary || publicCurrentState || "",
        source: "canonical-shipment-pipeline",
      },
    facts: factRows,
    factLedger: factRows,
    derivedFacts,
    canonical: record,
  };
}

module.exports = {
  buildCanonicalShipments,
  canonicalPhaseSummary,
  canonicalShipmentAsCompanionShipment,
  carrierTrackingIndex,
  nextPhaseFromGates,
  normalizeAwb,
  _test: {
    collapseStatusEcho,
    canonicalEtaSelection,
    etaDateEvidence,
    etaFactCandidates,
    parsedEtaCandidate,
    resolveRelativeWeekdayEta,
    unverifiedArrivalOperationalRisk,
  },
};

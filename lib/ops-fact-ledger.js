"use strict";

const crypto = require("node:crypto");
const { normalizeAwb, normalizeAwbFrom } = require("./awb");
const { operatorFactsFromText } = require("./companion-memory-store");

const FINAL_MILE_BROKERS = [
  "BTX",
  "Birch Cartage",
  "Meadow Freight",
  "JD Direct",
  "Juniper Logistics",
  "TQL",
  "Total Quality Logistics",
  "Casey Hart",
  "FlitePak",
];

const CUSTOMS_BROKERS = [
  "Maple",
  "Cedar Dispatch",
  "Cedar Brokerage",
  "Maple Air Express",
  "Translink",
  "Meadow Logistics",
  "Binational",
  "CGI Logistics",
  "Sobel",
  "Atlantic Freight",
];

const GROUND_HANDLERS = [
  "Choice",
  "Choice Aviation",
  "GAT",
  "Swissport",
  "Prosegur",
  "WFS",
  "Worldwide Flight Services",
  "United Cargo",
  "United Airlines Cargo",
  "EL AL Cargo",
  "CargoSprint",
];

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function textHasWrongConsigneeDelivery(value) {
  const text = normalizeText(value);
  return /\b(?:shipment|freight|cargo|load|it)?\b.{0,80}\b(?:delivered|delivery(?:\s+made)?)\b.{0,180}\b(?:by mistake|mistakenly|wrong\s+(?:consignee|cnee|customer|receiver|recipient|party|address)|another\s+(?:consignee|cnee|customer|receiver|recipient|party)|different\s+(?:consignee|cnee|customer|receiver|recipient|party)|other than\s+(?:northstar components|the\s+(?:correct|intended)\s+(?:consignee|cnee|customer|receiver|recipient|party)|(?:the\s+)?(?:consignee|cnee|customer|receiver|recipient|party)))\b|\b(?:wrong|another|different)\s+(?:consignee|cnee|customer|receiver|recipient|party)\b.{0,160}\b(?:delivered|delivery|received|return(?:ed)?|send back)\b|\b(?:whoever|customer|consignee|cnee|receiver|recipient|party)\b.{0,120}\b(?:received|got|has)\b.{0,120}\b(?:return|send back|bring back)\b/i.test(text);
}

function includesAny(text, names) {
  return names.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) || "";
}

function evidenceText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  return normalizeText([
    item.label,
    item.section,
    item.status,
    item.summary,
    item.detail,
    item.note,
    item.evidence,
    item.threadId ? `thread ${item.threadId}` : "",
    item.messageId ? `message ${item.messageId}` : "",
    item.attachmentId ? `attachment ${item.attachmentId}` : "",
    item.filename ? `file ${item.filename}` : "",
    item.mimeType,
    item.page ? `page ${item.page}` : "",
    item.extractedText,
  ].filter(Boolean).join(" "));
}

function genericEvidenceLabel(value) {
  return /^(loaded on ltl|arrival notice reminder|second follow-up|routing\/rate|awb mismatch|dhl export team reply with awb pdf|gmail)$/i.test(
    normalizeText(value),
  );
}

function factSource(item, fallback = {}) {
  return {
    source: item?.source || fallback.source || "",
    threadId: item?.threadId || fallback.threadId || "",
    messageId: item?.messageId || fallback.messageId || "",
    evidence: item?.evidence || fallback.evidence || "",
  };
}

function actorRole(actor, text = "") {
  const haystack = normalizeText(`${actor || ""} ${text}`);
  if (includesAny(haystack, FINAL_MILE_BROKERS)) return "final_mile_broker";
  if (includesAny(haystack, CUSTOMS_BROKERS)) return "customs_broker";
  if (includesAny(haystack, GROUND_HANDLERS)) return "ground_handler";
  if (/\b(driver|driver@demo-freight\.example)\b/i.test(haystack)) return "driver";
  if (/\b(demo-freight\.example|harbor-forwarding\.example|jordan|alex|skyler)\b/i.test(haystack)) return "internal";
  return "unknown";
}

function compactSummary(text) {
  const value = normalizeText(text);
  if (!value) return "";
  if (/\bloaded on (?:the )?(?:\d+(?:st|nd|rd|th)?\s+)?ltl truck\b/i.test(value)) {
    return "Linehaul loaded; destination proof pending";
  }
  if (/\b(on[-\s]?hand|arrival notice|available|ready for pickup)\b/i.test(value) && /\bconfirm|reminder|asked|request/i.test(value)) {
    return "Station confirmation requested";
  }
  if (/\b(driver|truck|carrier)\b.{0,80}\b(onsite|on site|checking|waiting)\b/i.test(value)) {
    return "Driver onsite/checking; pickup not complete";
  }
  if (textHasWrongConsigneeDelivery(value)) {
    return "Wrong consignee delivery exception";
  }
  if (/\b(picked up|recovered|pickup complete|recovery complete)\b/i.test(value) && !/\bnot |no |pending|requested|scheduled/i.test(value)) {
    return "Airport pickup confirmed";
  }
  if (/\b(delivered successfully|delivery completed|pod attached|pod received|proof of delivery|signed by)\b/i.test(value)) {
    return "Delivery/POD confirmed";
  }
  if (!textLooksTmsOnlyCustomsRelease(value) && /\b(98 released|release attached|d\/?o received|delivery order received)\b/i.test(value)) {
    return "Customs release/DO confirmed";
  }
  return value.length > 96 ? `${value.slice(0, 93).trim()}...` : value;
}

function textLooksTmsOnlyCustomsRelease(text) {
  const value = normalizeText(text);
  if (!value) return false;
  const tmsSignal = /\b(?:tms|couriercloud|295[-\s]*(?:customs\s*)?rel|customs rel)\b/i.test(value);
  if (!tmsSignal) return false;
  return !/\b(?:gmail|email|thread|message|operator|broker|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight|abi|ace|98 released|attached|delivery order|d\/?o)\b/i.test(value);
}

function makeFact(shipment, type, actor, summary, options = {}) {
  const text = normalizeText(summary);
  if (!text) return null;
  const role = options.actorRole || actorRole(actor, text);
  return {
    id: [
      normalizeAwb(shipment.awb || shipment.id),
      type,
      normalizeText(actor).toLowerCase().replace(/\W+/g, ""),
      text.toLowerCase().replace(/\W+/g, "").slice(0, 72),
    ].filter(Boolean).join(":"),
    awb: shipment.awb || "",
    type,
    actor: normalizeText(actor) || role,
    actorRole: role,
    leg: normalizeText(options.leg || ""),
    stage: options.stage || "",
    summary: compactSummary(text),
    rawSummary: text,
    effect: options.effect || effectForFact(type, role),
    confidence: options.confidence || shipment.statusAudit?.confidence || "medium",
    occurredAt: options.occurredAt || options.observedAt || "",
    ...factSource(options.sourceItem || {}, options),
  };
}

function effectForFact(type, role) {
  if (type === "station_arrived") return "destination_arrival_confirmed";
  if (type === "customs_not_released") return "customs_release_blocking";
  if (type === "linehaul_loaded" || type === "linehaul_moving") return "linehaul_only";
  if (type === "station_confirmation_requested") return "await_station_reply";
  if (type === "station_payment") return "station_payment_only";
  if (type === "driver_onsite") return "pickup_in_progress";
  if (type === "airport_recovered") return "airport_pickup_complete_delivery_pending";
  if (type === "delivered" || type === "pod_received") return "delivery_complete";
  if (type === "exception_wrong_consignee_delivery") return "wrong_consignee_delivery_exception";
  if (type === "customs_released") return "customs_clearance_complete";
  if (role === "ground_handler") return "station_or_linehaul_context";
  return "";
}

function pickupCompletionIsNegated(text) {
  const value = normalizeText(text);
  return /\b(cannot|can't|can not|do not|don't|must not|should not|not|no|pending|requested|scheduled|will|checking|awaiting|waiting|blocked|blocks?|hold|until)\b.{0,100}\b(picked up|pickup completed|recovery complete|recovered|recover)\b|\b(picked up|pickup completed|recovery complete|recovered|recover)\b.{0,100}\b(cannot|can't|can not|do not|don't|must not|should not|not|no|pending|requested|scheduled|will|checking|awaiting|waiting|blocked|blocks?|hold|until)\b/i.test(value);
}

function arrivalProofIsNegated(text) {
  const value = normalizeText(text);
  return /\b(no|not|without|missing)\b.{0,80}\b(arrival notice|notice of arrival|\bnoa\b|arrival proof|on[-\s]?hand proof|available proof|destination proof)\b|\b(?:arrival(?:\/noa)?|\bnoa\b|destination arrival|arrival proof|on[-\s]?hand)\s+(?:is\s+)?(?:still\s+)?(?:pending|missing|not found|not received|not confirmed)\b|\b(not arrived|hasn'?t arrived|not at destination|arrival pending|destination pending|no destination arrival)\b/i.test(value);
}

function hasActiveCustomsHold(shipment) {
  const currentStatusText = normalizeText([
    shipment.clearanceStatus,
    shipment.customsBroker?.status,
    shipment.emailValidation?.status,
    shipment.tms?.tmsStatus,
    shipment.tms?.status,
  ].filter(Boolean).join(" "));
  const currentStatusHasHold = /\b(customs[-\s]?hold|hold[-\s]?active|hold\/exam|exam\/hold|1-h\s+u\.?s\.?\s+customs\s+hold|customs exam)\b/i.test(currentStatusText);
  if (!currentStatusHasHold && statusShowsCustomsRelease(shipment)) {
    return false;
  }
  const text = normalizeText([
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.customsBroker?.status,
    shipment.customsBroker?.summary,
    shipment.customsBroker?.nextAction,
    ...(shipment.emailValidation?.proof || []).map(evidenceText),
    ...(shipment.customsBroker?.evidence || []).map(evidenceText),
    ...(shipment.factLedger || []).map(evidenceText),
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
  ].filter(Boolean).join(" "));
  if (/\b(customs[-\s]?hold|hold[-\s]?active|hold\/exam|exam\/hold|1-h\s+u\.?s\.?\s+customs\s+hold|customs exam)\b/i.test(text)) {
    return true;
  }

  const atDestination =
    shipment.arrivalStatus === "arrived" ||
    ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus);
  if (!atDestination) return false;

  return /\b(blocked by customs|pickup remains blocked|do not dispatch|do not recover|cannot be picked up)\b/i.test(text);
}

function statusShowsCustomsRelease(shipment) {
  const text = [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.summary,
    shipment.customsBroker?.nextAction,
    ...(shipment.emailValidation?.proof || []).map(evidenceText),
    ...(shipment.customsBroker?.evidence || []).map(evidenceText),
    ...(shipment.emailValidation?.events || []).map(evidenceText),
    ...(shipment.factLedger || []).map(evidenceText),
  ].filter(Boolean).join(" ");
  return !textLooksTmsOnlyCustomsRelease(text) &&
    /\b(?:customs[-\s]?(?:released|cleared)|released[-\s]?do|release[-\s]?do|do[-\s]?received|98[-\s]?released|release[-\s]?instructions[-\s]?attached|customs-release-attachment-received|customs-released-do-received|customs-cleared-do-received|delivery order (?:attached|received|issued)|d\/?o (?:attached|received|issued))\b/i.test(text);
}

function customsBlockingNextAction(shipment, fallback) {
  const candidate = normalizeText(
    shipment.customsBroker?.nextAction ||
    shipment.emailValidation?.nextAction ||
    shipment.nextAction ||
    "",
  );
  if (/\b(customs|release|broker|ABI|hold|clearance|clear|d\/?o|delivery order)\b/i.test(candidate)) return candidate;
  if (/\b(invoice|documents?|FIRMS|entry|consignee|HTS)\b/i.test(candidate)) {
    return `${candidate.replace(/[.\s]+$/g, "")} to customs broker for clearance.`;
  }
  return fallback;
}

function factTypeFromText(text, role) {
  const value = normalizeText(text);
  const deliveryOrderOnly = /\b(delivery order|d\/?o|deliver to|delivery address|shipment details|awb pdf|booking request)\b/i.test(value);
  const stationPaymentOnly = /\b(cargosprint|station payment|terminal fee|station charge|payment receipt|payment delivered)\b/i.test(value);
  const negatedCloseout = /\b(no|not|without|pending|missing|requested|needed|awaiting|will follow|to follow|expected)\b.{0,80}\b(pod|proof of delivery|delivery confirmation|delivery completion|delivered)\b|\b(pod|proof of delivery|delivery confirmation|delivery completion)\b.{0,80}\b(no|not|pending|missing|requested|needed|awaiting|will follow|to follow|expected)\b/i.test(value);
  const negatedRelease = /\b(?:not released|not cleared|release pending|clearance pending|customs hold|\b1[-\s]?h\b|exam hold|hold not removed|cannot release|do not dispatch|pickup remains blocked)\b/i.test(value);
  if (textHasWrongConsigneeDelivery(value)) return "exception_wrong_consignee_delivery";
  if (stationPaymentOnly && /\b(payment|receipt|delivered)\b/i.test(value)) return "station_payment";
  if (!stationPaymentOnly && !negatedCloseout && !deliveryOrderOnly && /\b(delivered successfully|delivery completed|actual delivery|signed by|delivered to [A-Z][A-Z ]{2,})\b/i.test(value)) return "delivered";
  if (!negatedCloseout && /\b(?:pod|proof of delivery)\b.{0,32}\b(attached|received|provided|uploaded|found)\b|\b(attached|received|provided|uploaded|found)\b.{0,32}\b(?:pod|proof of delivery)\b/i.test(value)) return "pod_received";
  if (negatedRelease) return "customs_not_released";
  if (!textLooksTmsOnlyCustomsRelease(value) && /\b(98 released|release attached|release instructions attached|d\/?o received|delivery order received|ace ces01|status 98 - released|ace cargo release|customs clear yes)\b/i.test(value)) return "customs_released";
  if (
    /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available for pickup|available cargo|freight availability|arrived at destination|arrived)\b/i.test(value) &&
    !arrivalProofIsNegated(value) &&
    !/\b(?:request|requested|confirm|asked|any news|need|needed|missing|pending)\b.{0,50}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available)\b/i.test(value)
  ) {
    return "station_arrived";
  }
  if (/\brelease[-\s]?authorized\b.{0,80}\bpickup[-\s]?pending\b.{0,80}\bpod[-\s]?pending\b/i.test(value)) {
    return "airport_recovered";
  }
  if (/\bpickup[-\s]?confirmed\b.{0,80}\bdriver[-\s]?loaded\b|\bdriver[-\s]?loaded\b.{0,80}\bdelivery\b.{0,80}\bpod[-\s]?pending\b/i.test(value)) {
    return "airport_recovered";
  }
  if (/\b(picked up|has been picked up|pickup completed|recovery complete|recovered)\b/i.test(value) && !/\b(no|not|pending|requested|scheduled|will|can|checking)\b/i.test(value) && !pickupCompletionIsNegated(value)) {
    return role === "ground_handler" ? "linehaul_moving" : "airport_recovered";
  }
  if (/\bloaded on (?:the )?(?:\d+(?:st|nd|rd|th)?\s+)?ltl truck\b/i.test(value)) return "linehaul_loaded";
  if (/\b(driver|truck|carrier)\b.{0,90}\b(onsite|on site|checking|waiting|waiting to be loaded)\b/i.test(value)) return "driver_onsite";
  if (/\b(on[-\s]?hand|arrival notice|available|ready for pickup)\b/i.test(value) && /\b(confirm|reminder|asked|request|any news)\b/i.test(value)) {
    return "station_confirmation_requested";
  }
  if (/\b(storage|last free|lfd|demurrage)\b/i.test(value)) return "storage";
  if (/\bquote|rate|\$\s*\d/i.test(value)) return "quote";
  return "";
}

function collectEvidenceFacts(shipment, items, fallbackActor, fallbackSource) {
  const facts = [];
  for (const item of items || []) {
    const text = evidenceText(item);
    if (!text) continue;
    const label = normalizeText(item?.label);
    const actor = normalizeText(item?.actor || item?.broker || (genericEvidenceLabel(label) ? fallbackActor : label) || fallbackActor);
    let role = actorRole(actor, text);
    const type = factTypeFromText(text, role);
    if (!type) continue;
    if (type === "linehaul_loaded" || type === "linehaul_moving") {
      role = "ground_handler";
    }
    const fact = makeFact(shipment, type, actor, text, {
      actorRole: role,
      source: fallbackSource,
      sourceItem: item,
      occurredAt: item?.observedAt || item?.occurredAt || item?.createdAt || item?.updatedAt || "",
      confidence: item?.confidence || shipment.statusAudit?.confidence || "medium",
    });
    if (fact) facts.push(fact);
    if (
      type === "customs_not_released" &&
      /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available for pickup|available cargo|freight availability|arrived at destination|arrived)\b/i.test(text)
    ) {
      const arrivalFact = makeFact(shipment, "station_arrived", actor, text, {
        actorRole: role,
        source: fallbackSource,
        sourceItem: item,
        occurredAt: item?.observedAt || item?.occurredAt || item?.createdAt || item?.updatedAt || "",
        confidence: item?.confidence || shipment.statusAudit?.confidence || "medium",
      });
      if (arrivalFact) facts.push(arrivalFact);
    }
  }
  return facts;
}

function buildOperationalFactLedger(shipment) {
  const facts = [];
  if (shipment.arrivalStatus === "arrived" || shipment.pickupStatus === "ready") {
    facts.push(makeFact(shipment, "station_arrived", shipment.handler || shipment.airline || "Carrier tracking", shipment.liveTracking?.status || shipment.eta || "Carrier shows destination arrival/availability", {
      actorRole: "carrier_tracking",
      source: shipment.airline || "Carrier tracking",
      confidence: "high",
    }));
  }

  facts.push(...collectEvidenceFacts(shipment, shipment.emailValidation?.proof || [], "Gmail", "Gmail"));
  facts.push(...collectEvidenceFacts(shipment, [
    {
      label: shipment.freightBroker?.broker || "Freight status",
      status: shipment.freightBroker?.status || "",
      summary: shipment.freightBroker?.brokerStatus || "",
      note: shipment.freightBroker?.pickupPlan || shipment.freightBroker?.nextAction || "",
      confidence: shipment.freightBroker?.confidence || "",
    },
  ], shipment.freightBroker?.broker || "Freight", "Gmail"));
  facts.push(...collectEvidenceFacts(shipment, shipment.freightBroker?.evidence || [], shipment.freightBroker?.broker || "Freight", "Gmail"));
  facts.push(...collectEvidenceFacts(shipment, shipment.eodFacts || [], "Gmail", "Gmail"));

  return dedupeFacts(facts.filter(Boolean));
}

function dedupeFacts(facts) {
  const map = new Map();
  for (const fact of facts || []) {
    const key = fact.id || `${fact.awb}:${fact.type}:${fact.actor}:${fact.summary}`;
    if (!map.has(key)) map.set(key, fact);
  }
  return [...map.values()].sort((a, b) =>
    String(a.occurredAt || "").localeCompare(String(b.occurredAt || "")) ||
    String(a.type).localeCompare(String(b.type))
  );
}

function hasFact(facts, type, predicate = () => true) {
  return (facts || []).some((fact) => fact.type === type && predicate(fact));
}

function deriveShipmentUnderstanding(shipment) {
  const facts = buildOperationalFactLedger(shipment);
  const linehaul = facts.find((fact) => ["linehaul_loaded", "linehaul_moving"].includes(fact.type));
  const stationRequest = facts.find((fact) => fact.type === "station_confirmation_requested");
  const stationArrived = facts.find((fact) => fact.type === "station_arrived");
  const driverOnsite = facts.find((fact) => fact.type === "driver_onsite");
  const airportRecovered = facts.find((fact) => fact.type === "airport_recovered");
  const delivered = facts.find((fact) => fact.type === "delivered" || fact.type === "pod_received");
  const activeCustomsHold = hasActiveCustomsHold(shipment);
  const currentCustomsRelease = facts.find((fact) => fact.type === "customs_released") ||
    (statusShowsCustomsRelease(shipment) ? { type: "customs_released", summary: "Customs status is released." } : null);
  const customsNotReleased = currentCustomsRelease && !activeCustomsHold
    ? null
    : facts.find((fact) => fact.type === "customs_not_released");
  const customsReleased = !customsNotReleased && !activeCustomsHold ? currentCustomsRelease : null;
  const arrived =
    Boolean(stationArrived) ||
    shipment.arrivalStatus === "arrived" ||
    ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus);
  const currentNotArrived =
    !arrived &&
    shipment.arrivalStatus === "not-arrived" &&
    !["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus);

  let phase = currentNotArrived ? "" : shipment.opsState?.phase || "";
  let label = currentNotArrived ? "" : shipment.opsState?.label || "";
  let summary = currentNotArrived ? "" : shipment.opsState?.summary || "";
  let nextAction = currentNotArrived ? shipment.nextAction || "" : shipment.opsState?.nextAction || shipment.nextAction || "";
  let pickupStatus = shipment.pickupStatus || "pending";

  if (delivered) {
    phase = "completed";
    label = "Delivered";
    summary = "Delivery/POD proof exists.";
    nextAction = "Close out POD/TMS only if not already posted.";
    pickupStatus = "delivered";
  } else if (activeCustomsHold && driverOnsite) {
    phase = "pickup-exception";
    label = "Driver onsite, blocked";
    summary = "Driver/broker is at the station, but customs/release is still blocking pickup.";
    nextAction = customsBlockingNextAction(
      shipment,
      "Ping the operator now and follow customs/station before redispatching.",
    );
    pickupStatus = shipment.pickupStatus === "delivered" ? shipment.pickupStatus : "pending";
  } else if (activeCustomsHold) {
    phase = "customs";
    label = arrived ? "Arrived, customs hold" : "Customs hold";
    summary = arrived ? "Cargo is at destination, but customs hold/release is still blocking pickup." : "Customs hold/exam is still blocking pickup.";
    nextAction = customsBlockingNextAction(
      shipment,
      "Follow customs broker for hold removal/release before dispatch.",
    );
    pickupStatus = shipment.pickupStatus === "delivered" ? shipment.pickupStatus : "pending";
  } else if (airportRecovered) {
    phase = "closeout";
    label = "Picked up";
    summary = "Airport pickup is confirmed; delivery/POD is still pending.";
    nextAction = "Track delivery and collect POD after final delivery.";
    pickupStatus = "airport-picked-up";
  } else if (driverOnsite) {
    phase = "pickup-dispatched";
    label = "Driver onsite";
    summary = "Driver is onsite/checking; pickup is not complete yet.";
    nextAction = "Monitor loading/pickup completion, then track delivery/POD.";
  } else if (linehaul && linehaul.actorRole === "ground_handler") {
    phase = "linehaul";
    label = "Linehaul";
    summary = "Ground handler moved cargo between stations; destination availability is not confirmed.";
    nextAction = "Confirm destination station on-hand/arrival notice before final-mile pickup.";
  } else if (currentNotArrived) {
    phase = "in-transit";
    label = "In transit";
    summary = shipment.eta ? `Not at destination yet. Expected ${shipment.eta}.` : "Not at destination yet.";
    nextAction = shipment.emailValidation?.nextAction || shipment.nextAction || "Track movement and wait for arrival/NOA proof before dispatch.";
  } else if (stationRequest) {
    phase = "arrival-check";
    label = "Station pending";
    summary = "Station/on-hand confirmation was requested; reply is still missing.";
    nextAction = "Wait for or follow up on station on-hand/arrival notice.";
  } else if (arrived && !customsReleased) {
    phase = "customs";
    label = customsNotReleased ? "Arrived, not released" : "Arrived, release pending";
    summary = customsNotReleased ? "Destination arrival exists, but release/DO is explicitly not cleared." : "Destination arrival exists; release/DO is not confirmed yet.";
    nextAction = customsBlockingNextAction(
      shipment,
      "Follow customs broker for release/DO before dispatch.",
    );
  } else if (arrived && customsReleased) {
    phase = "ready-for-pickup";
    label = "Released, pickup pending";
    summary = "Arrival and customs are resolved; pickup/delivery proof is still open.";
    nextAction = shipment.freightBroker?.nextAction || "Release files to pickup broker and confirm recovery/POD.";
    pickupStatus = shipment.pickupStatus === "delivered" ? shipment.pickupStatus : "ready";
  }

  return {
    facts,
    state: {
      phase,
      label,
      summary,
      nextAction,
      pickupStatus,
      hasLinehaulOnly: Boolean(linehaul && linehaul.actorRole === "ground_handler" && !airportRecovered && !delivered),
      hasDestinationProof: Boolean(stationArrived || shipment.arrivalStatus === "arrived") && !stationRequest && !currentNotArrived,
      hasCustomsRelease: Boolean(customsReleased && !customsNotReleased && !activeCustomsHold),
      hasCustomsBlock: Boolean(customsNotReleased || activeCustomsHold),
      hasAirportPickup: Boolean(airportRecovered),
      hasFinalDelivery: Boolean(delivered),
    },
  };
}

function applyOperationalUnderstanding(shipment) {
  const understanding = deriveShipmentUnderstanding(shipment);
  const state = understanding.state;
  if (!state.phase) {
    return {
      ...shipment,
      operationalFacts: understanding.facts,
      operationalUnderstanding: state,
    };
  }

  const opsState = {
    ...(shipment.opsState || {}),
    phase: state.phase,
    label: state.label,
    summary: state.summary,
    nextAction: state.nextAction,
    evidence: shipment.opsState?.evidence || [],
  };

  return {
    ...shipment,
    pickupStatus: state.pickupStatus || shipment.pickupStatus,
    nextAction: state.nextAction || shipment.nextAction,
    opsState,
    operationalFacts: understanding.facts,
    operationalUnderstanding: state,
  };
}

const DURABLE_FACT_LEDGER_VERSION = "ops-fact-ledger-v1";

const SHIPMENT_EVENT_FACTS = {
  "arrival-notice-received": {
    factType: "station_arrival_confirmed",
    gate: "arrival",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "customs-release-received": {
    factType: "customs_released",
    gate: "customs",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "ground-fees-paid": {
    factType: "ground_fees_paid",
    gate: "fees",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "pickup-quote-received": {
    factType: "pickup_quote_received",
    gate: "quote",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "broker-awarded": {
    factType: "pickup_broker_awarded",
    gate: "dispatch",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "pickup-location-replied": {
    factType: "pickup_location_sent",
    gate: "dispatch",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "pickup-docs-sent": {
    factType: "pickup_docs_sent",
    gate: "dispatch",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "pickup-scheduled": {
    factType: "pickup_scheduled",
    gate: "pickup",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "pickup-onsite": {
    factType: "driver_onsite",
    gate: "pickup",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "pickup-blocker": {
    factType: "pickup_blocked",
    gate: "pickup",
    polarity: "negative",
    confidenceLabel: "high",
  },
  "pickup-loaded": {
    factType: "pickup_loaded",
    gate: "pickup",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "pickup-confirmed": {
    factType: "pickup_confirmed",
    gate: "pickup",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "delivery-scheduled": {
    factType: "delivery_scheduled",
    gate: "delivery",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "delivered-reported": {
    factType: "delivery_reported",
    gate: "delivery",
    polarity: "positive",
    confidenceLabel: "medium",
  },
  "pod-pending": {
    factType: "pod_missing_or_requested",
    gate: "pod",
    polarity: "requested",
    confidenceLabel: "medium",
  },
  "delivered-pod-missing": {
    factType: "delivered_pod_missing",
    gate: "pod",
    polarity: "requested",
    confidenceLabel: "high",
  },
  "pod-received": {
    factType: "pod_received",
    gate: "pod",
    polarity: "positive",
    confidenceLabel: "high",
  },
  "delivered-pod-received": {
    factType: "delivered_pod_received",
    gate: "pod",
    polarity: "positive",
    confidenceLabel: "high",
  },
};

const EXCEPTION_GATE_BY_TYPE = {
  "pickup-location-requested": "dispatch",
  "pickup-docs-needed": "dispatch",
  "awb-copy-needed": "dispatch",
  "broker-release-pending": "customs",
  "station-cargo-not-found": "arrival",
  "station-release-not-visible": "customs",
  "airline-transmission-blocker": "customs",
  "customs-hold": "customs",
  "driver-waiting": "pickup",
  "loading-problem": "pickup",
  "piece-count-mismatch": "arrival",
  "wrong-consignee-delivery": "delivery",
  "storage-or-detention-cost": "storage",
  "storage-needed-after-delivery-blocker": "storage",
  "delivery-facility-closed": "delivery",
};

const AI_EXTRACTION_JOB_VERSION = "ops-ai-extraction-contract-v1";
const AI_EXTRACTION_OUTPUT_SCHEMA = {
  facts: [
    {
      awb: "string",
      factType: "string",
      gate: "arrival|customs|fees|quote|dispatch|pickup|delivery|pod|storage|exception|context",
      polarity: "positive|negative|requested|neutral|unknown",
      confidence: "number 0..1",
      summary: "short operator-readable summary",
      evidenceQuote: "short source quote or paraphrase",
      appliesToAwbs: ["string"],
      occurredAt: "ISO timestamp when available",
    },
  ],
  workgroups: [
    {
      workgroupType: "pickup|delivery|release|pod|station|exception|context",
      awbs: ["string"],
      summary: "what this shared thread/action means",
      nextAction: "operator action if any",
      confidence: "number 0..1",
    },
  ],
  disputes: [
    {
      awb: "string",
      reason: "why the deterministic state may be wrong",
      expectedFactType: "string",
      actualFactType: "string",
    },
  ],
};

function compactLedgerText(value, max = 320) {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .filter((key) => typeof value[key] !== "undefined")
    .sort()
    .reduce((acc, key) => {
      acc[key] = stableJson(value[key]);
      return acc;
    }, {});
}

function stableHash(...parts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson(parts)))
    .digest("hex");
}

function slug(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function confidenceNumber(label) {
  const value = String(label || "").toLowerCase();
  if (value === "high") return 0.9;
  if (value === "low") return 0.35;
  if (value === "verified") return 0.98;
  return 0.65;
}

function confidenceLabel(value, fallback = "medium") {
  const label = String(value || fallback || "medium").toLowerCase();
  return ["verified", "high", "medium", "low"].includes(label) ? label : fallback;
}

function normalizedLedgerGate(value) {
  const gate = String(value || "").toLowerCase().trim();
  if (["arrival", "customs", "fees", "quote", "dispatch", "pickup", "delivery", "pod", "storage", "exception", "context", "workgroup"].includes(gate)) {
    return gate;
  }
  if (gate === "station" || gate === "ground-handler") return "arrival";
  if (gate === "loading") return "pickup";
  if (gate === "customs-broker" || gate === "release") return "customs";
  return "exception";
}

function normalizedPolarity(value) {
  const polarity = String(value || "").toLowerCase().trim();
  return ["positive", "negative", "requested", "neutral", "unknown"].includes(polarity) ? polarity : "unknown";
}

function eventSourceType(event = {}) {
  if (event.attachmentId || event.filename || event.mimeType) return "gmail-attachment";
  if (event.threadId || event.messageId || event.from || event.subject) return "gmail-message";
  return "system";
}

function eventSourceId(event = {}) {
  return event.messageId || event.threadId || event.id || "";
}

function eventEvidenceText(event = {}) {
  return compactLedgerText([event.evidence, event.summary, event.subject].filter(Boolean).join(" "), 500);
}

function eventObservedAt(event = {}, fallbackNow = new Date()) {
  return event.at || event.updatedAt || event.createdAt || fallbackNow.toISOString();
}

// The ops_evidence_documents.source_type check constraint
// (migration 20260623111000) only permits this coarse source-system vocabulary.
// Any evidence document whose sourceType falls outside it makes the entire
// upsert_ops_fact_ledger transaction fail, freezing ALL shipment truth — so the
// ledger builder must clamp every evidence document to an allowed value and keep
// the finer-grained kind in the payload. Detail belongs in fact_type/payload, not
// in the coarse source_type column.
const ALLOWED_EVIDENCE_SOURCE_TYPES = Object.freeze([
  "gmail-message",
  "gmail-attachment",
  "tms",
  "tracking",
  "operator-note",
  "system",
]);
const ALLOWED_EVIDENCE_SOURCE_TYPE_SET = new Set(ALLOWED_EVIDENCE_SOURCE_TYPES);

function coarseEvidenceSourceType(rawSourceType = "") {
  const value = String(rawSourceType || "").trim().toLowerCase();
  if (!value) return "system";
  if (ALLOWED_EVIDENCE_SOURCE_TYPE_SET.has(value)) return value;
  if (/tracking|override/.test(value)) return "tracking";
  if (/attachment|file|document|pdf/.test(value)) return "gmail-attachment";
  if (/gmail|email|mail|message|thread/.test(value)) return "gmail-message";
  if (/tms|cargowise|inventory/.test(value)) return "tms";
  if (/operator|note|manual|human/.test(value)) return "operator-note";
  return "system";
}

// Clamp an already-built evidence document to the allowed source_type vocabulary,
// preserving the original value in payload.sourceTypeRaw when it had to change.
function normalizeEvidenceDocumentSourceType(evidence = {}) {
  const raw = evidence.sourceType;
  const coarse = coarseEvidenceSourceType(raw);
  if (coarse === raw) return evidence;
  const payload = evidence.payload && typeof evidence.payload === "object" ? evidence.payload : {};
  return {
    ...evidence,
    sourceType: coarse,
    payload: raw && raw !== coarse ? { ...payload, sourceTypeRaw: raw } : payload,
  };
}

// The ops_* tables cast several columns to timestamptz with only an empty-string guard
// (nullif(x,'')::timestamptz). A non-empty UNparseable timestamp — e.g. an AI extractor
// returning occurredAt:"tomorrow" or "July 10" — raises Postgres 22007 and rolls back the
// ENTIRE upsert_ops_fact_ledger transaction, freezing ALL truth (same blast radius as the
// source_type freeze). Coerce every timestamp field to a valid ISO string or "" so the
// SQL cast can only ever see a parseable value or null.
const LEDGER_TIMESTAMP_FIELDS = [
  "occurredAt", "observedAt", "capturedAt", "firstSeenAt", "lastSeenAt", "updatedAt", "at",
];
function toIsoOrEmpty(value) {
  if (value == null || value === "") return "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}
function sanitizeLedgerTimestamps(row = {}) {
  if (!row || typeof row !== "object") return row;
  for (const field of LEDGER_TIMESTAMP_FIELDS) {
    if (field in row) row[field] = toIsoOrEmpty(row[field]);
  }
  return row;
}

function evidenceDocumentFromShipmentEvent(event = {}, fallbackNow = new Date()) {
  const sourceType = eventSourceType(event);
  const evidenceTextValue = eventEvidenceText(event);
  const evidenceId = [
    "evd",
    stableHash(
      sourceType,
      event.threadId || "",
      event.messageId || "",
      event.attachmentId || "",
      event.id || "",
      event.awb || "",
      evidenceTextValue,
    ).slice(0, 24),
  ].join(":");
  return {
    evidenceId,
    sourceType,
    sourceId: eventSourceId(event),
    awb: event.awb || "",
    threadId: event.threadId || "",
    messageId: event.messageId || "",
    attachmentId: event.attachmentId || "",
    filename: event.filename || "",
    mimeType: event.mimeType || "",
    bodyHash: stableHash(evidenceTextValue).slice(0, 40),
    textPreview: compactLedgerText(evidenceTextValue, 280),
    observedAt: eventObservedAt(event, fallbackNow),
    payload: {
      from: event.from || "",
      to: event.to || "",
      subject: event.subject || "",
      evidenceKind: event.evidenceKind || "",
      ...(normalizedNearMissAwbs(event).length
        ? { nearMissAwbs: normalizedNearMissAwbs(event) }
        : {}),
    },
  };
}

function descriptorForShipmentEvent(event = {}) {
  if (event.type === "exception") {
    const exceptionType = event.exceptionType || event.problem || "operational-exception";
    return {
      factType: `exception_${slug(exceptionType).replace(/-/g, "_") || "operational"}`,
      gate: normalizedLedgerGate(EXCEPTION_GATE_BY_TYPE[exceptionType] || event.where || "exception"),
      polarity: "negative",
      confidenceLabel: confidenceLabel(event.confidence, "high"),
    };
  }
  return SHIPMENT_EVENT_FACTS[event.type] || {
    factType: slug(event.type || "context").replace(/-/g, "_") || "context",
    gate: "context",
    polarity: "neutral",
    confidenceLabel: confidenceLabel(event.confidence, "medium"),
  };
}

function actorNameFromEvent(event = {}) {
  return normalizeText(
    event.broker ||
      event.selectedBroker ||
      event.carrierName ||
      event.from ||
      event.requestedStation ||
      event.source ||
      "",
  );
}

function factFromShipmentEvent(event = {}, options = {}) {
  const awb = event.awb || "";
  if (!normalizeAwb(awb)) return null;
  const descriptor = descriptorForShipmentEvent(event);
  const evidence = options.evidenceDocument || evidenceDocumentFromShipmentEvent(event, options.now || new Date());
  const actorName = actorNameFromEvent(event);
  const actorRoleValue = event.actorRole || actorRole(actorName, eventEvidenceText(event));
  const confidence = confidenceNumber(event.confidence || descriptor.confidenceLabel);
  const factId = [
    "fact",
    normalizeAwb(awb),
    descriptor.factType,
    stableHash(
      event.id || "",
      event.threadId || "",
      event.messageId || "",
      event.at || "",
      event.summary || "",
      event.evidence || "",
    ).slice(0, 18),
  ].join(":");
  return {
    factId,
    awb,
    factType: descriptor.factType,
    type: descriptor.factType,
    gate: descriptor.gate,
    polarity: descriptor.polarity,
    confidence,
    confidenceLabel: confidenceLabel(event.confidence, descriptor.confidenceLabel),
    actorName,
    actorRole: actorRoleValue,
    summary: compactLedgerText(event.summary || descriptor.factType.replace(/_/g, " "), 220),
    evidenceText: eventEvidenceText(event),
    evidence: eventEvidenceText(event),
    occurredAt: event.at || "",
    observedAt: eventObservedAt(event, options.now || new Date()),
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    threadId: event.threadId || "",
    messageId: event.messageId || "",
    attachmentId: event.attachmentId || "",
    evidenceId: evidence.evidenceId,
    workgroupId: "",
    extractionMethod: "deterministic",
    extractorVersion: DURABLE_FACT_LEDGER_VERSION,
    payload: {
      originalEventId: event.id || "",
      originalEventType: event.type || "",
      appliesToAwbs: uniqueBy([...(event.appliesToAwbs || []), ...(event.awbs || [])], (value) => normalizeAwb(value)),
      ...(normalizedNearMissAwbs(event).length
        ? { nearMissAwbs: normalizedNearMissAwbs(event) }
        : {}),
      exceptionType: event.exceptionType || "",
      severity: event.severity || "",
      status: event.status || "",
      where: event.where || "",
      impact: event.impact || "",
      nextAction: event.nextAction || "",
      broker: event.broker || event.selectedBroker || "",
      contactEmail: event.contactEmail || "",
      amount: event.amount || "",
      requestedStation: event.requestedStation || "",
      carrierName: event.carrierName || "",
      subject: event.subject || "",
      from: event.from || "",
    },
  };
}

function shipmentEventAwbs(event = {}) {
  return uniqueBy([
    event.awb,
    event.shipmentAwb,
    ...(Array.isArray(event.appliesToAwbs) ? event.appliesToAwbs : []),
    ...(Array.isArray(event.awbs) ? event.awbs : []),
  ], (value) => normalizeAwb(value)).filter((value) => normalizeAwb(value));
}

function factsFromShipmentEvent(event = {}, options = {}) {
  return shipmentEventAwbs(event)
    .map((awb) => factFromShipmentEvent({ ...event, awb }, options))
    .filter(Boolean);
}

function operatorNotesFromInput(input = {}) {
  return uniqueBy([
    ...(Array.isArray(input.operatorNotes) ? input.operatorNotes : []),
    ...(Array.isArray(input.companionMemory?.operatorNotes) ? input.companionMemory.operatorNotes : []),
  ], (note) => note?.id || [operatorNoteAwb(note), semanticFactText(note?.text || note?.summary)].join("|"));
}

function operatorNoteAwb(note = {}) {
  return normalizeAwbFrom(note.awb, note.shipmentAwb, note.id, note.text, note.summary);
}

function operatorNoteText(note = {}) {
  return compactLedgerText(note.text || note.summary || (note.facts || []).map((fact) => fact.summary || fact.label).join(" "), 800);
}

function operatorNoteObservedAt(note = {}, fallbackNow = new Date()) {
  return note.updatedAt || note.createdAt || note.at || fallbackNow.toISOString();
}

function evidenceDocumentFromOperatorNote(note = {}, fallbackNow = new Date()) {
  const awb = operatorNoteAwb(note);
  const evidenceTextValue = operatorNoteText(note);
  const sourceId = note.id || stableHash("operator-note", awb, evidenceTextValue).slice(0, 18);
  return {
    evidenceId: ["evd", stableHash("operator-note", sourceId, awb, evidenceTextValue).slice(0, 24)].join(":"),
    sourceType: "operator-note",
    sourceId,
    awb,
    threadId: "",
    messageId: "",
    attachmentId: "",
    filename: "",
    mimeType: "",
    bodyHash: stableHash(evidenceTextValue).slice(0, 40),
    textPreview: compactLedgerText(evidenceTextValue, 280),
    observedAt: operatorNoteObservedAt(note, fallbackNow),
    payload: {
      purpose: note.purpose || "",
      source: note.source || "operator-note",
      confidence: note.confidence || "operator-confirmed",
    },
  };
}

function operatorFactGate(type) {
  if (type === "arrival") return "arrival";
  if (type === "customs") return "customs";
  if (type === "payment") return "fees";
  if (type === "dispatch") return "dispatch";
  if (type === "pickup") return "pickup";
  if (type === "delivery") return "delivery";
  if (type === "pod" || type === "pod-pending") return "pod";
  if (type === "exception" || type === "exception-resolved") return "exception";
  return "context";
}

function operatorFactPolarity(type) {
  if (type === "pod-pending") return "requested";
  if (type === "exception") return "negative";
  if (type === "operator-note") return "neutral";
  return "positive";
}

function operatorFactsForNote(note = {}, fallbackNow = new Date()) {
  const awb = operatorNoteAwb(note);
  const text = operatorNoteText(note);
  if (!awb || !text) return [];
  const at = operatorNoteObservedAt(note, fallbackNow);
  const noteId = note.id || stableHash("operator-note", awb, text).slice(0, 18);
  return uniqueBy([
    ...(Array.isArray(note.facts) ? note.facts : []),
    ...operatorFactsFromText(text, awb, at, { noteId }),
  ], (fact) => [
    fact?.type || "operator-note",
    fact?.label || "",
    semanticFactText(fact?.summary || text),
  ].join("|"));
}

function semanticFactText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/(?:^|\D)\d{3}[-\s]?\d{8}(?!\d)/g, " awb ")
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, " date ")
    .replace(/\b\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?\b/g, " date ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/g, " time ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function durableFactDedupeKey(fact = {}) {
  const awb = normalizeAwb(fact.awb);
  const factType = fact.factType || fact.type || "";
  if (fact.sourceType === "operator-note") {
    return [
      awb,
      fact.sourceType,
      factType,
      fact.gate || "",
      fact.polarity || "",
      semanticFactText(fact.summary || fact.evidenceText || fact.evidence),
    ].join("|");
  }
  return fact.factId || [
    awb,
    fact.sourceType || "",
    fact.sourceId || "",
    factType,
    semanticFactText(fact.summary || fact.evidenceText || fact.evidence),
  ].join("|");
}

function factFromOperatorFact(note = {}, fact = {}, options = {}) {
  const awb = operatorNoteAwb(note);
  if (!awb) return null;
  const type = fact.type || "operator-note";
  const evidence = options.evidenceDocument || evidenceDocumentFromOperatorNote(note, options.now || new Date());
  const summary = compactLedgerText(fact.summary || note.text || note.summary || fact.label || "Operator update", 220);
  const noteId = note.id || evidence.sourceId || stableHash("operator-note", awb, summary).slice(0, 18);
  return {
    factId: [
      "fact",
      awb,
      "operator",
      slug(type) || "operator-note",
      stableHash(noteId, type, fact.label || "", summary, fact.at || "").slice(0, 18),
    ].join(":"),
    awb,
    factType: type,
    type,
    gate: operatorFactGate(type),
    polarity: operatorFactPolarity(type),
    confidence: 0.98,
    confidenceLabel: "operator-confirmed",
    actorName: "Operator",
    actorRole: "internal",
    summary,
    evidenceText: operatorNoteText(note),
    evidence: operatorNoteText(note),
    occurredAt: fact.at || operatorNoteObservedAt(note, options.now || new Date()),
    observedAt: operatorNoteObservedAt(note, options.now || new Date()),
    sourceType: "operator-note",
    sourceId: evidence.sourceId,
    threadId: "",
    messageId: "",
    attachmentId: "",
    evidenceId: evidence.evidenceId,
    workgroupId: "",
    extractionMethod: "deterministic",
    extractorVersion: DURABLE_FACT_LEDGER_VERSION,
    payload: {
      noteId,
      purpose: fact.purpose || note.purpose || "",
      originalFactType: type,
      status: fact.status || "",
      where: fact.where || "",
      severity: fact.severity || "",
      deliveryTiming: fact.deliveryTiming || "",
    },
  };
}

function trackingRowsFromInputs(input = {}) {
  return [
    ...(Array.isArray(input.tracking?.shipments) ? input.tracking.shipments : []),
    ...(Array.isArray(input.carrierTracking?.shipments) ? input.carrierTracking.shipments : []),
    ...shipmentRowsFromInputs(input),
  ].filter((shipment) =>
    shipment?.liveTracking ||
    shipment?.tracking ||
    shipment?.carrierTracking ||
    shipment?.trackingException ||
    shipment?.truth?.tracking
  );
}

function trackingPayloadFromRow(row = {}) {
  return row.liveTracking || row.tracking || row.carrierTracking || row.truth?.tracking || {};
}

function trackingEvidenceText(row = {}) {
  const tracking = trackingPayloadFromRow(row);
  const latestEvent = tracking.latestEvent || tracking.lastEvent || row.latestTrackingEvent || {};
  const exception = row.trackingException || tracking.exception || {};
  return compactLedgerText([
    tracking.status,
    tracking.summaryStatus,
    tracking.code,
    latestEvent.code,
    latestEvent.description,
    latestEvent.station,
    latestEvent.at || latestEvent.time,
    exception.type,
    exception.summary,
    exception.message,
    row.arrivalStatus,
    row.eta || tracking.eta,
  ].filter(Boolean).join(" "), 500);
}

function evidenceDocumentFromTrackingRow(row = {}, fallbackNow = new Date()) {
  const awb = normalizeAwb(row.awb || row.id || row.shipmentId);
  const tracking = trackingPayloadFromRow(row);
  const latestEvent = tracking.latestEvent || tracking.lastEvent || row.latestTrackingEvent || {};
  const evidenceTextValue = trackingEvidenceText(row);
  const sourceId = tracking.id || latestEvent.id || latestEvent.code || row.trackingId || stableHash("tracking", awb, evidenceTextValue).slice(0, 18);
  return {
    evidenceId: ["evd", stableHash("tracking", sourceId, awb, evidenceTextValue).slice(0, 24)].join(":"),
    // source_type must stay within the coarse ops_evidence_documents vocabulary;
    // the carrier-vs-email-override distinction is preserved in payload.trackingSourceKind.
    sourceType: "tracking",
    sourceId,
    awb,
    threadId: "",
    messageId: "",
    attachmentId: "",
    filename: "",
    mimeType: "",
    bodyHash: stableHash(evidenceTextValue).slice(0, 40),
    textPreview: compactLedgerText(evidenceTextValue, 280),
    observedAt: tracking.latestEventAt || latestEvent.at || latestEvent.time || row.latestEventAt || row.updatedAt || fallbackNow.toISOString(),
    payload: {
      carrier: row.airline || row.carrier || tracking.carrier || "",
      station: row.station || row.destination || tracking.station || latestEvent.station || "",
      eta: row.eta || tracking.eta || "",
      status: tracking.status || "",
      code: tracking.code || latestEvent.code || "",
      exceptionType: row.trackingException?.type || tracking.exception?.type || "",
      trackingSourceKind: trackingSourceType(row),
    },
  };
}

function trackingSourceType(row = {}) {
  const tracking = trackingPayloadFromRow(row);
  const text = [
    tracking.source,
    tracking.sourceType,
    tracking.evidenceKind,
    tracking.status,
    tracking.summaryStatus,
    row.source,
    row.sourceType,
    row.evidenceKind,
    row.emailValidation?.status,
    row.emailValidation?.summary,
  ].filter(Boolean).join(" ");
  return /\b(?:gmail|email|mail|message|thread|proof|override)\b/i.test(text) ? "email-tracking-override" : "carrier-tracking";
}

function trackingArrivalNegativeText(text = "", exceptionType = "") {
  const value = normalizeText(`${text} ${exceptionType}`).toLowerCase();
  return /\b(?:not[-\s]?arrived|hasn'?t[-\s]?arrived|has not[-\s]?arrived|not at destination|arrival[-\s]?pending|pending arrival|eta[-\s]?passed|no arrival|no station|no on[-\s]?hand|no noa|destination pending|scheduled|depart(?:ed|ure)?|actual depart(?:ed|ure)?|\bdep\b)\b/i.test(value);
}

function trackingFactDescriptors(row = {}) {
  const tracking = trackingPayloadFromRow(row);
  const latestEvent = tracking.latestEvent || tracking.lastEvent || row.latestTrackingEvent || {};
  const exception = row.trackingException || tracking.exception || {};
  const text = trackingEvidenceText(row);
  const descriptors = [];
  const arrivalNegative = trackingArrivalNegativeText(text, exception.type || "");
  const arrivalPositive =
    /\b(?:arrived|arrival notice|notice of arrival|on[-\s]?hand|available|available for pickup|ready for pickup|freight availability|\barr\b|\brcf\b|\bawd\b|\bnfd\b)\b/i.test(text) &&
    !arrivalNegative;
  if (arrivalPositive || /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(String(row.arrivalStatus || "").trim())) {
    descriptors.push({
      factType: "tracking_arrival_available",
      gate: "arrival",
      polarity: "positive",
      confidence: 0.82,
      confidenceLabel: "high",
      summary: "Carrier tracking shows destination arrival/availability.",
    });
  }
  if (
    arrivalNegative
  ) {
    descriptors.push({
      factType: "tracking_eta_passed_no_arrival",
      gate: "arrival",
      polarity: "negative",
      confidence: 0.86,
      confidenceLabel: "high",
      summary: "Tracking says ETA/arrival proof is still missing.",
    });
  } else if (/\b(?:departed|actual departure|in transit|\bdep\b)\b/i.test(text)) {
    descriptors.push({
      factType: "tracking_in_transit",
      gate: "arrival",
      polarity: "neutral",
      confidence: 0.72,
      confidenceLabel: "medium",
      summary: "Carrier tracking shows the shipment is still moving before destination availability.",
    });
  }
  if (row.eta || tracking.eta) {
    descriptors.push({
      factType: "tracking_eta",
      gate: "arrival",
      polarity: "neutral",
      confidence: 0.7,
      confidenceLabel: "medium",
      summary: `Tracking ETA ${row.eta || tracking.eta}.`,
    });
  }
  return uniqueBy(descriptors, (descriptor) => descriptor.factType);
}

function factsFromTrackingRow(row = {}, options = {}) {
  const awb = normalizeAwb(row.awb || row.id || row.shipmentId);
  if (!awb) return [];
  const evidence = options.evidenceDocument || evidenceDocumentFromTrackingRow(row, options.now || new Date());
  const text = trackingEvidenceText(row);
  return trackingFactDescriptors(row).map((descriptor) => ({
    factId: [
      "fact",
      awb,
      descriptor.factType,
      stableHash(evidence.sourceId, descriptor.factType, text).slice(0, 18),
    ].join(":"),
    awb,
    factType: descriptor.factType,
    type: descriptor.factType,
    gate: descriptor.gate,
    polarity: descriptor.polarity,
    confidence: descriptor.confidence,
    confidenceLabel: descriptor.confidenceLabel,
    actorName: evidence.payload?.carrier || "Carrier tracking",
    actorRole: "carrier_tracking",
    summary: compactLedgerText(descriptor.summary, 220),
    evidenceText: text,
    evidence: text,
    occurredAt: evidence.observedAt,
    observedAt: evidence.observedAt,
    sourceType: evidence.sourceType || trackingSourceType(row),
    sourceId: evidence.sourceId,
    threadId: "",
    messageId: "",
    attachmentId: "",
    evidenceId: evidence.evidenceId,
    workgroupId: "",
    extractionMethod: "deterministic",
    extractorVersion: DURABLE_FACT_LEDGER_VERSION,
    payload: {
      station: evidence.payload?.station || "",
      eta: evidence.payload?.eta || "",
      status: evidence.payload?.status || "",
      code: evidence.payload?.code || "",
      exceptionType: evidence.payload?.exceptionType || "",
    },
  }));
}

function uniqueBy(values, keyFn) {
  const seen = new Set();
  const output = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function normalizedNearMissAwbs(value = {}) {
  return uniqueBy([
    ...(Array.isArray(value.nearMissAwbs) ? value.nearMissAwbs : []),
    ...(Array.isArray(value.payload?.nearMissAwbs) ? value.payload.nearMissAwbs : []),
  ], (awb) => normalizeAwb(awb))
    .map((awb) => normalizeAwb(awb))
    .filter(Boolean)
    .sort();
}

function combinedNearMissAwbs(values = []) {
  return uniqueBy(
    (values || []).flatMap((value) => normalizedNearMissAwbs(value)),
    (awb) => normalizeAwb(awb),
  ).map((awb) => normalizeAwb(awb)).filter(Boolean).sort();
}

function buildShipmentIndex(shipments = []) {
  const index = new Map();
  for (const shipment of shipments || []) {
    const key = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
    if (!key || index.has(key)) continue;
    index.set(key, shipment);
  }
  return index;
}

function factWorkgroupType(fact = {}) {
  if (fact.gate === "pod") return "pod";
  if (fact.gate === "delivery") return "delivery";
  if (fact.gate === "pickup" || fact.gate === "dispatch" || fact.gate === "quote") return "pickup";
  if (fact.gate === "customs") return "release";
  if (fact.gate === "arrival") return "station";
  if (fact.gate === "storage") return "exception";
  return fact.gate || "context";
}

function workgroupKeyForFact(fact = {}, shipmentIndex = new Map()) {
  const shipment = shipmentIndex.get(normalizeAwb(fact.awb)) || {};
  const brokerEmail = normalizeText(fact.payload?.contactEmail || "");
  const brokerName = normalizeText(fact.payload?.broker || fact.actorName || "");
  const consignee = normalizeText(shipment.consignee || shipment.shipTo || shipment.customer || shipment.destinationName || "");
  const station = normalizeText(shipment.station || shipment.destination || shipment.dest || shipment.airport || "");
  const nearMissAwbs = normalizedNearMissAwbs(fact);
  const guardedKey = (parts) => [
    ...parts,
    ...(nearMissAwbs.length ? ["near-miss-excluding", ...nearMissAwbs] : []),
  ].map((part) => String(part).toLowerCase()).join(":");
  if (fact.threadId && (brokerEmail || brokerName)) {
    return guardedKey([factWorkgroupType(fact), fact.threadId, brokerEmail || brokerName]);
  }
  if (fact.threadId) return guardedKey([factWorkgroupType(fact), fact.threadId]);
  if (consignee && station && (brokerEmail || brokerName)) {
    return guardedKey([factWorkgroupType(fact), station, consignee, brokerEmail || brokerName]);
  }
  return "";
}

function chooseWorkgroupSummary(facts = []) {
  const blocking = facts.find((fact) => fact.polarity === "negative" || fact.polarity === "requested");
  const fact = blocking || facts[facts.length - 1] || {};
  return compactLedgerText(fact.summary || fact.evidenceText || "", 180);
}

function chooseWorkgroupNextAction(facts = []) {
  const explicit = facts.find((fact) => fact.payload?.nextAction)?.payload?.nextAction || "";
  if (explicit) return compactLedgerText(explicit, 180);
  const gate = facts.find((fact) => fact.gate)?.gate || "";
  if (gate === "customs") return "Resolve release/DO blocker before pickup.";
  if (gate === "pickup" || gate === "dispatch") return "Reply in the pickup thread with the next required pickup move.";
  if (gate === "pod" || gate === "delivery") return "Track final delivery and collect POD proof.";
  if (gate === "arrival") return "Confirm station on-hand and arrival notice.";
  return "Review the evidence thread and decide the next operator move.";
}

function factsForEvidence(facts = [], evidenceId = "") {
  return (facts || []).filter((fact) => fact.evidenceId && fact.evidenceId === evidenceId);
}

function factsForWorkgroup(facts = [], workgroupId = "") {
  return (facts || []).filter((fact) => fact.workgroupId && fact.workgroupId === workgroupId);
}

function evidenceNeedsAiExtraction(evidence = {}, facts = []) {
  const text = `${evidence.textPreview || ""} ${facts.map((fact) => `${fact.factType} ${fact.summary} ${fact.evidenceText}`).join(" ")}`;
  if (/[א-ת]/.test(text)) return true;
  if (facts.some((fact) => fact.polarity === "negative" || fact.polarity === "requested" || Number(fact.confidence || 0) < 0.75)) return true;
  return /\b(?:delivery order|d\/?o|pod|proof of delivery|attached|carrier|driver|loaded|picked up|pickup|delivered|release|clearance|storage|detention|pieces?|pcs|same shipment|all three|all shipments)\b/i.test(text);
}

function compactFactForJob(fact = {}) {
  const nearMissAwbs = normalizedNearMissAwbs(fact);
  return {
    factId: fact.factId || "",
    awb: fact.awb || "",
    factType: fact.factType || fact.type || "",
    gate: fact.gate || "",
    polarity: fact.polarity || "",
    confidence: fact.confidence || 0,
    summary: fact.summary || "",
    evidenceText: compactLedgerText(fact.evidenceText || fact.evidence || "", 220),
    actorName: fact.actorName || "",
    actorRole: fact.actorRole || "",
    occurredAt: fact.occurredAt || "",
    ...(nearMissAwbs.length ? { nearMissAwbs } : {}),
  };
}

function compactEvidenceForJob(evidence = {}) {
  const nearMissAwbs = normalizedNearMissAwbs(evidence);
  return {
    evidenceId: evidence.evidenceId || "",
    sourceType: evidence.sourceType || "",
    sourceId: evidence.sourceId || "",
    awb: evidence.awb || "",
    threadId: evidence.threadId || "",
    messageId: evidence.messageId || "",
    attachmentId: evidence.attachmentId || "",
    filename: evidence.filename || "",
    mimeType: evidence.mimeType || "",
    textPreview: evidence.textPreview || "",
    observedAt: evidence.observedAt || "",
    payload: {
      from: evidence.payload?.from || "",
      subject: evidence.payload?.subject || "",
      evidenceKind: evidence.payload?.evidenceKind || "",
    },
    ...(nearMissAwbs.length ? { nearMissAwbs } : {}),
  };
}

function extractionJobBase({ jobType, awbs, evidenceIds, workgroupIds, excludedAwbs = [], inputPayload, now, sourceHash, model = "" }) {
  const jobId = [
    "ai-job",
    jobType,
    stableHash(jobType, awbs, evidenceIds, workgroupIds, sourceHash, AI_EXTRACTION_JOB_VERSION).slice(0, 24),
  ].join(":");
  return {
    jobId,
    jobType,
    status: "queued",
    sourceHash,
    sourceSnapshotKey: "operational-fact-ledger",
    awbs: uniqueBy(awbs || [], (awb) => normalizeAwb(awb)),
    excludedAwbs: uniqueBy(excludedAwbs || [], (awb) => normalizeAwb(awb)),
    evidenceIds: uniqueBy(evidenceIds || [], (id) => id),
    workgroupIds: uniqueBy(workgroupIds || [], (id) => id),
    model,
    extractorVersion: AI_EXTRACTION_JOB_VERSION,
    promptVersion: AI_EXTRACTION_JOB_VERSION,
    inputPayload,
    outputPayload: {},
    error: "",
    attempts: 0,
    tokenUsage: {},
    createdAt: now.toISOString(),
  };
}

function buildEvidenceExtractionJob(evidence, relatedFacts, now, options = {}) {
  const evidencePayload = compactEvidenceForJob(evidence);
  const knownFacts = relatedFacts.map(compactFactForJob);
  const awbs = uniqueBy([evidence.awb, ...knownFacts.map((fact) => fact.awb)], (awb) => normalizeAwb(awb));
  const excludedAwbs = combinedNearMissAwbs([evidence, ...relatedFacts]);
  const guard = excludedAwbs.length ? { excludedAwbs } : {};
  const inputPayload = {
    task: "Extract logistics facts from this evidence. Preserve ambiguity; do not infer pickup/delivery completion from requests or schedules.",
    evidence: evidencePayload,
    knownFacts,
    outputSchema: AI_EXTRACTION_OUTPUT_SCHEMA,
    rules: [
      "POD please / send POD is a request unless the source says POD is attached, received, signed, uploaded, or found.",
      "Pickup scheduled, driver heading, driver onsite, or will pick up is not physical pickup proof.",
      "A reply on one thread may apply to multiple AWBs only when the thread, consignee, station, or broker context supports it.",
      "Return disputes instead of forcing a fact when source text conflicts with deterministic facts.",
      ...(excludedAwbs.length ? ["Never extract or apply a fact to an excluded AWB."] : []),
    ],
    ...guard,
  };
  const sourceHash = excludedAwbs.length
    ? stableHash("fact-extraction", evidencePayload, knownFacts, AI_EXTRACTION_OUTPUT_SCHEMA, excludedAwbs)
    : stableHash("fact-extraction", evidencePayload, knownFacts, AI_EXTRACTION_OUTPUT_SCHEMA);
  return extractionJobBase({
    jobType: "fact-extraction",
    awbs,
    evidenceIds: [evidence.evidenceId],
    workgroupIds: uniqueBy(relatedFacts.map((fact) => fact.workgroupId), (id) => id),
    excludedAwbs,
    sourceHash,
    model: options.model || "",
    now,
    inputPayload,
  });
}

function buildWorkgroupResolutionJob(workgroup, relatedFacts, now, options = {}) {
  const facts = relatedFacts.map(compactFactForJob);
  const excludedAwbs = combinedNearMissAwbs(relatedFacts);
  const inputPayload = {
    task: "Resolve whether this shared operational context applies to all listed AWBs and what the next operator action is.",
    workgroup: {
      workgroupId: workgroup.workgroupId || "",
      workgroupType: workgroup.workgroupType || "",
      awbs: workgroup.awbs || [],
      stationCode: workgroup.stationCode || "",
      consignee: workgroup.consignee || "",
      brokerName: workgroup.brokerName || "",
      brokerEmail: workgroup.brokerEmail || "",
      threadId: workgroup.threadId || "",
      summary: workgroup.summary || "",
      nextAction: workgroup.nextAction || "",
    },
    knownFacts: facts,
    outputSchema: AI_EXTRACTION_OUTPUT_SCHEMA,
    rules: [
      "Do not collapse separate shipments unless the evidence supports shared handling.",
      "Explain which AWBs are included and which are not supported.",
      "Prefer an operator ask/dispute when the shared context is ambiguous.",
      ...(excludedAwbs.length ? ["Never extract or apply a fact to an excluded AWB."] : []),
    ],
    ...(excludedAwbs.length ? { excludedAwbs } : {}),
  };
  return extractionJobBase({
    jobType: "workgroup-resolution",
    awbs: workgroup.awbs || [],
    evidenceIds: uniqueBy(relatedFacts.map((fact) => fact.evidenceId), (id) => id),
    workgroupIds: [workgroup.workgroupId],
    excludedAwbs,
    sourceHash: stableHash("workgroup-resolution", inputPayload),
    model: options.model || "",
    now,
    inputPayload,
  });
}

function buildAiExtractionJobs(ledger = {}, now = new Date(), options = {}) {
  const jobs = [];
  for (const evidence of ledger.evidenceDocuments || []) {
    const relatedFacts = factsForEvidence(ledger.facts || [], evidence.evidenceId);
    if (!evidenceNeedsAiExtraction(evidence, relatedFacts)) continue;
    jobs.push(buildEvidenceExtractionJob(evidence, relatedFacts, now, options));
  }
  for (const workgroup of ledger.workgroups || []) {
    const relatedFacts = factsForWorkgroup(ledger.facts || [], workgroup.workgroupId);
    const multiAwb = (workgroup.awbs || []).length > 1;
    const activeBlocker = workgroup.status === "active" || relatedFacts.some((fact) => fact.polarity === "negative" || fact.polarity === "requested");
    if (!multiAwb && !activeBlocker) continue;
    jobs.push(buildWorkgroupResolutionJob(workgroup, relatedFacts, now, options));
  }
  return uniqueBy(jobs, (job) => job.jobId);
}

function validAwbsForJob(job = {}) {
  const excludedAwbs = new Set((job.excludedAwbs || []).map((awb) => normalizeAwb(awb)).filter(Boolean));
  return new Set(
    (job.awbs || [])
      .map((awb) => normalizeAwb(awb))
      .filter((awb) => awb && !excludedAwbs.has(awb)),
  );
}

function validatedExtractedFact(job = {}, extracted = {}, index = 0, ledger = {}) {
  const awb = extracted.awb || (extracted.appliesToAwbs || [])[0] || job.awbs?.[0] || "";
  const awbKey = normalizeAwb(awb);
  const validAwbs = validAwbsForJob(job);
  if (!awbKey || ((job.awbs || []).length && !validAwbs.has(awbKey))) return null;
  const factType = slug(extracted.factType || "ai_context").replace(/-/g, "_") || "ai_context";
  const gate = normalizedLedgerGate(extracted.gate || "context");
  const polarity = normalizedPolarity(extracted.polarity || "unknown");
  const confidence = Math.max(0, Math.min(1, Number(extracted.confidence || 0)));
  if (confidence < 0.7) return null;
  const evidenceQuote = compactLedgerText(extracted.evidenceQuote || extracted.evidence || "", 260);
  if (!evidenceQuote) return null;
  const completionText = `${factType} ${gate} ${polarity} ${evidenceQuote} ${extracted.summary || ""}`;
  if (textHasWrongConsigneeDelivery(completionText) && (gate === "delivery" || gate === "pod") && polarity === "positive") {
    return null;
  }
  if (
    /\b(?:pod_received|delivered_pod_received|delivery_reported|delivered|pickup_confirmed|pickup_loaded|pickup_recovered|customs_released)\b/i.test(factType) &&
    /\b(?:please|request|requested|needed|pending|missing|scheduled|tomorrow|will|can you|could you|need|ask|waiting|heading|onsite|on site)\b/i.test(completionText)
  ) {
    return null;
  }
  if (/\bpod\b/i.test(factType) && polarity === "positive" && !/\b(?:attached|received|signed|uploaded|found|provided|sent)\b/i.test(evidenceQuote)) {
    return null;
  }
  if (/\bpickup|loaded|recovered\b/i.test(factType) && polarity === "positive" && !/\b(?:picked up|pickup completed|recovered|loaded|truck loaded|driver loaded)\b/i.test(evidenceQuote)) {
    return null;
  }
  if (gate === "delivery" && polarity === "positive" && !/\b(?:delivered|delivery completed|signed|pod)\b/i.test(evidenceQuote)) {
    return null;
  }
  if (gate === "customs" && polarity === "positive" && !/\b(?:released|cleared|98|delivery order|d\/?o|attached|ace)\b/i.test(evidenceQuote)) {
    return null;
  }

  const evidenceId = job.evidenceIds?.[0] || "";
  const evidence = (ledger.evidenceDocuments || []).find((item) => item.evidenceId === evidenceId) || {};
  const occurredAt = extracted.occurredAt || evidence.observedAt || "";
  const factId = [
    "ai-fact",
    awbKey,
    factType,
    stableHash(job.jobId || "", index, extracted, AI_EXTRACTION_JOB_VERSION).slice(0, 18),
  ].join(":");
  return {
    factId,
    awb,
    factType,
    type: factType,
    gate,
    polarity,
    confidence,
    confidenceLabel: confidence >= 0.9 ? "high" : "medium",
    actorName: "",
    actorRole: "unknown",
    summary: compactLedgerText(extracted.summary || evidenceQuote, 220),
    evidenceText: evidenceQuote,
    evidence: evidenceQuote,
    occurredAt,
    observedAt: new Date().toISOString(),
    sourceType: evidence.sourceType || "system",
    sourceId: evidence.sourceId || job.jobId || "",
    threadId: evidence.threadId || "",
    messageId: evidence.messageId || "",
    attachmentId: evidence.attachmentId || "",
    evidenceId,
    workgroupId: job.workgroupIds?.[0] || "",
    extractionMethod: "openai",
    extractorVersion: AI_EXTRACTION_JOB_VERSION,
    payload: {
      jobId: job.jobId || "",
      appliesToAwbs: extracted.appliesToAwbs || [],
      evidenceQuote,
      sourceHash: job.sourceHash || "",
    },
  };
}

function disputeFromExtraction(job = {}, dispute = {}, index = 0) {
  const awb = dispute.awb || job.awbs?.[0] || "";
  const awbKey = normalizeAwb(awb);
  const excludedAwbs = new Set((job.excludedAwbs || []).map((item) => normalizeAwb(item)).filter(Boolean));
  if (!awbKey || excludedAwbs.has(awbKey)) return null;
  return {
    disputeId: [
      "ai-dispute",
      normalizeAwb(awb),
      stableHash(job.jobId || "", index, dispute).slice(0, 18),
    ].join(":"),
    factId: "",
    awb,
    expectedFactType: dispute.expectedFactType || "",
    actualFactType: dispute.actualFactType || "",
    operatorNote: compactLedgerText(dispute.reason || dispute.operatorNote || "AI extractor flagged this shipment state for review.", 280),
    status: "open",
    payload: {
      jobId: job.jobId || "",
      sourceHash: job.sourceHash || "",
      raw: dispute,
    },
  };
}

function validatedExtractedFacts(job = {}, extracted = {}, index = 0, ledger = {}) {
  const candidateAwbs = uniqueBy([
    extracted.awb,
    ...(Array.isArray(extracted.appliesToAwbs) ? extracted.appliesToAwbs : []),
  ], (value) => normalizeAwb(value)).filter((value) => normalizeAwb(value));
  const awbs = candidateAwbs.length ? candidateAwbs : [job.awbs?.[0]].filter(Boolean);
  return awbs
    .map((awb, awbIndex) => validatedExtractedFact(job, { ...extracted, awb }, `${index}-${awbIndex}`, ledger))
    .filter(Boolean);
}

function applyExtractionOutputToLedger(ledger = {}, job = {}) {
  const output = job.outputPayload || {};
  const extractedFacts = (output.facts || [])
    .flatMap((fact, index) => validatedExtractedFacts(job, fact, index, ledger));
  const disputes = (output.disputes || [])
    .map((dispute, index) => disputeFromExtraction(job, dispute, index))
    .filter(Boolean);
  const facts = uniqueBy([...(ledger.facts || []), ...extractedFacts], (fact) => fact.factId);
  return {
    ...ledger,
    facts,
    disputes: uniqueBy([...(ledger.disputes || []), ...disputes], (dispute) => dispute.disputeId || stableHash(dispute)),
    counts: {
      ...(ledger.counts || {}),
      facts: facts.length,
      disputes: uniqueBy([...(ledger.disputes || []), ...disputes], (dispute) => dispute.disputeId || stableHash(dispute)).length,
    },
  };
}

function mergePreviousExtractionResults(ledger = {}, previous = {}) {
  if (!previous || typeof previous !== "object") return ledger;
  const currentJobsById = new Map((ledger.extractionJobs || []).map((job) => [job.jobId, job]));
  const currentJobIds = new Set(currentJobsById.keys());
  const normalizedJobSet = (values, normalize = (value) => String(value || "")) =>
    [...new Set((values || []).map(normalize).filter(Boolean))].sort().join("|");
  const replaySafetyMatches = (previousJob) => {
    const currentJob = currentJobsById.get(previousJob?.jobId);
    return Boolean(
      currentJob &&
      currentJob.sourceHash === previousJob.sourceHash &&
      normalizedJobSet(currentJob.awbs, (awb) => normalizeAwb(awb)) ===
        normalizedJobSet(previousJob.awbs, (awb) => normalizeAwb(awb)) &&
      normalizedJobSet(currentJob.excludedAwbs, (awb) => normalizeAwb(awb)) ===
        normalizedJobSet(previousJob.excludedAwbs, (awb) => normalizeAwb(awb)) &&
      normalizedJobSet(currentJob.evidenceIds) === normalizedJobSet(previousJob.evidenceIds) &&
      normalizedJobSet(currentJob.workgroupIds) === normalizedJobSet(previousJob.workgroupIds),
    );
  };
  const previousSucceededJobs = new Map(
    (previous.extractionJobs || [])
      .filter((job) => currentJobIds.has(job.jobId) && job.status === "succeeded" && replaySafetyMatches(job))
      .map((job) => [job.jobId, job]),
  );
  const extractionJobs = (ledger.extractionJobs || []).map((job) => previousSucceededJobs.get(job.jobId) || job);
  const currentEvidenceIds = new Set((ledger.evidenceDocuments || []).map((evidence) => evidence.evidenceId));
  const currentJobAllowsAwb = (jobId, awb) => {
    const currentJob = currentJobsById.get(jobId);
    return Boolean(
      currentJob &&
      previousSucceededJobs.has(jobId) &&
      validAwbsForJob(currentJob).has(normalizeAwb(awb)),
    );
  };
  const preservedFacts = (previous.facts || []).filter((fact) =>
    fact.extractionMethod === "openai" &&
    fact.evidenceId &&
    currentEvidenceIds.has(fact.evidenceId) &&
    currentJobAllowsAwb(fact.payload?.jobId || "", fact.awb)
  );
  const preservedDisputes = (previous.disputes || []).filter((dispute) =>
    normalizeAwb(dispute.awb) &&
    currentJobAllowsAwb(dispute.payload?.jobId || "", dispute.awb) &&
    (ledger.facts || []).some((fact) => normalizeAwb(fact.awb) === normalizeAwb(dispute.awb))
  );
  const facts = uniqueBy([...(ledger.facts || []), ...preservedFacts], (fact) => fact.factId);
  const disputes = uniqueBy([...(ledger.disputes || []), ...preservedDisputes], (dispute) => dispute.disputeId || stableHash(dispute));
  return {
    ...ledger,
    facts,
    extractionJobs,
    disputes,
    counts: {
      ...(ledger.counts || {}),
      facts: facts.length,
      extractionJobs: extractionJobs.length,
      disputes: disputes.length,
    },
  };
}

async function callOpenAiExtractionJob(job, env = process.env, fetchImpl = fetch) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");
  const model = env.PQ_AI_EXTRACTION_MODEL || env.OPENAI_MODEL || "gpt-4.1-mini";
  const response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You extract logistics facts for Pikiio. Return strict JSON only. Preserve ambiguity. Do not turn requests, schedules, plans, or driver-heading language into completed pickup/delivery/POD facts. Use the provided schema.",
        },
        {
          role: "user",
          content: JSON.stringify(job.inputPayload || {}),
        },
      ],
      temperature: 0,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI extraction failed: ${response.status} ${text.slice(0, 240)}`);
  const payload = text ? JSON.parse(text) : {};
  const content = payload.choices?.[0]?.message?.content || "{}";
  return {
    model,
    outputPayload: JSON.parse(content),
    tokenUsage: payload.usage || {},
  };
}

async function runAiExtractionForLedger(ledger = {}, options = {}) {
  const env = options.env || process.env;
  const now = options.now || new Date();
  if (!env.OPENAI_API_KEY) {
    return {
      ...ledger,
      aiExtraction: {
        enabled: false,
        reason: "missing-openai-api-key",
      },
    };
  }
  if (env.PQ_AI_EXTRACTION_ENABLED === "0") {
    return {
      ...ledger,
      aiExtraction: {
        enabled: false,
        reason: "disabled-by-env",
      },
    };
  }
  const maxJobs = Math.max(0, Number(options.maxJobs ?? env.PQ_AI_EXTRACTION_MAX_JOBS_PER_RUN ?? 2) || 0);
  if (!maxJobs) {
    return {
      ...ledger,
      aiExtraction: {
        enabled: false,
        reason: "max-jobs-zero",
      },
    };
  }
  const fetchImpl = options.fetchImpl || fetch;
  let nextLedger = { ...ledger };
  const jobs = [...(ledger.extractionJobs || [])];
  const runnable = jobs.filter((job) => job.status === "queued").slice(0, maxJobs);
  const updatedJobs = new Map(jobs.map((job) => [job.jobId, job]));
  for (const job of runnable) {
    const startedAt = now.toISOString();
    try {
      const result = await callOpenAiExtractionJob(job, env, fetchImpl);
      const completedJob = {
        ...job,
        status: "succeeded",
        model: result.model,
        outputPayload: result.outputPayload,
        tokenUsage: result.tokenUsage,
        attempts: Number(job.attempts || 0) + 1,
        startedAt,
        completedAt: new Date().toISOString(),
        error: "",
      };
      updatedJobs.set(job.jobId, completedJob);
      nextLedger = applyExtractionOutputToLedger(nextLedger, completedJob);
    } catch (error) {
      updatedJobs.set(job.jobId, {
        ...job,
        status: "failed",
        attempts: Number(job.attempts || 0) + 1,
        startedAt,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const extractionJobs = jobs.map((job) => updatedJobs.get(job.jobId) || job);
  return {
    ...nextLedger,
    extractionJobs,
    counts: {
      ...(nextLedger.counts || {}),
      facts: (nextLedger.facts || []).length,
      extractionJobs: extractionJobs.length,
      disputes: (nextLedger.disputes || []).length,
    },
    aiExtraction: {
      enabled: true,
      attempted: runnable.length,
      succeeded: extractionJobs.filter((job) => runnable.some((item) => item.jobId === job.jobId) && job.status === "succeeded").length,
      failed: extractionJobs.filter((job) => runnable.some((item) => item.jobId === job.jobId) && job.status === "failed").length,
      maxJobs,
    },
  };
}

function workgroupsFromFacts(facts = [], shipments = []) {
  const shipmentIndex = buildShipmentIndex(shipments);
  const byKey = new Map();
  for (const fact of facts || []) {
    const key = workgroupKeyForFact(fact, shipmentIndex);
    if (!key) continue;
    const list = byKey.get(key) || [];
    list.push(fact);
    byKey.set(key, list);
  }
  return [...byKey.entries()].map(([groupKey, groupFacts]) => {
    const sortedFacts = groupFacts.slice().sort((a, b) => Date.parse(a.occurredAt || a.observedAt || "") - Date.parse(b.occurredAt || b.observedAt || ""));
    const firstFact = sortedFacts[0] || {};
    const lastFact = sortedFacts[sortedFacts.length - 1] || firstFact;
    const awbs = uniqueBy(sortedFacts.map((fact) => fact.awb), (awb) => normalizeAwb(awb));
    const shipment = shipmentIndex.get(normalizeAwb(firstFact.awb)) || {};
    const workgroupType = factWorkgroupType(firstFact);
    const workgroupId = ["wg", workgroupType, stableHash(groupKey).slice(0, 22)].join(":");
    return {
      workgroupId,
      workgroupType,
      groupKey,
      awbs,
      stationCode: shipment.station || shipment.destination || shipment.dest || firstFact.payload?.requestedStation || "",
      consignee: shipment.consignee || shipment.shipTo || shipment.customer || shipment.destinationName || "",
      brokerName: firstFact.payload?.broker || firstFact.actorName || "",
      brokerEmail: firstFact.payload?.contactEmail || "",
      threadId: firstFact.threadId || "",
      status: sortedFacts.some((fact) => fact.polarity === "negative" || fact.polarity === "requested") ? "active" : "unknown",
      confidence: Number((sortedFacts.reduce((sum, fact) => sum + Number(fact.confidence || 0), 0) / Math.max(1, sortedFacts.length)).toFixed(2)),
      summary: chooseWorkgroupSummary(sortedFacts),
      nextAction: chooseWorkgroupNextAction(sortedFacts),
      evidenceIds: uniqueBy(sortedFacts.map((fact) => fact.evidenceId), (id) => id),
      firstSeenAt: firstFact.occurredAt || firstFact.observedAt || "",
      lastSeenAt: lastFact.occurredAt || lastFact.observedAt || "",
      payload: {
        factIds: sortedFacts.map((fact) => fact.factId),
        factTypes: uniqueBy(sortedFacts.map((fact) => fact.factType), (type) => type),
      },
    };
  });
}

function assignWorkgroupsToFacts(facts = [], workgroups = [], shipments = []) {
  const groupByKey = new Map(workgroups.map((workgroup) => [workgroup.groupKey, workgroup]));
  const shipmentIndex = buildShipmentIndex(shipments);
  return facts.map((fact) => {
    const groupKey = workgroupKeyForFact(fact, shipmentIndex);
    const workgroup = groupByKey.get(groupKey);
    return workgroup ? { ...fact, workgroupId: workgroup.workgroupId } : fact;
  });
}

function shipmentEventsFromSnapshot(input = {}) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.events)) return input.events;
  if (Array.isArray(input.shipmentEvents?.events)) return input.shipmentEvents.events;
  return [];
}

function shipmentRowsFromInputs(input = {}) {
  return [
    ...(input.shipments || []),
    ...(input.shipmentState?.shipments || []),
    ...(input.active?.shipments || []),
    ...(input.brain?.shipments || []),
    ...(input.brain?.completed || []),
    ...(input.tracking?.shipments || []),
    ...(input.carrierTracking?.shipments || []),
  ];
}

function buildDurableOperationalFactLedger(input = {}, now = new Date()) {
  const events = shipmentEventsFromSnapshot(input);
  const operatorNotes = operatorNotesFromInput(input);
  const trackingRows = trackingRowsFromInputs(input);
  const eventEvidenceDocuments = events.map((event) => evidenceDocumentFromShipmentEvent(event, now));
  const operatorEvidenceDocuments = operatorNotes.map((note) => evidenceDocumentFromOperatorNote(note, now));
  const trackingEvidenceDocuments = trackingRows.map((row) => evidenceDocumentFromTrackingRow(row, now));
  const evidenceDocuments = uniqueBy(
    [...eventEvidenceDocuments, ...operatorEvidenceDocuments, ...trackingEvidenceDocuments],
    (evidence) => evidence.evidenceId,
  ).map(normalizeEvidenceDocumentSourceType);
  const evidenceByEventKey = new Map();
  for (const event of events) {
    const evidence = evidenceDocumentFromShipmentEvent(event, now);
    evidenceByEventKey.set(event.id || [event.awb, event.type, event.threadId, event.messageId, event.summary].join("|"), evidence);
  }
  const evidenceByOperatorNoteId = new Map();
  for (const note of operatorNotes) {
    const evidence = evidenceDocumentFromOperatorNote(note, now);
    evidenceByOperatorNoteId.set(note.id || [operatorNoteAwb(note), operatorNoteText(note)].join("|"), evidence);
  }
  const evidenceByTrackingAwb = new Map();
  for (const row of trackingRows) {
    const evidence = evidenceDocumentFromTrackingRow(row, now);
    evidenceByTrackingAwb.set([normalizeAwb(row.awb || row.id || row.shipmentId), evidence.sourceId].join("|"), evidence);
  }
  const rawFacts = uniqueBy(
    [
      ...events
      .flatMap((event) =>
        factsFromShipmentEvent(event, {
          now,
          evidenceDocument: evidenceByEventKey.get(event.id || [event.awb, event.type, event.threadId, event.messageId, event.summary].join("|")),
        }),
      ),
      ...operatorNotes.flatMap((note) =>
        operatorFactsForNote(note, now).map((fact) =>
          factFromOperatorFact(note, fact, {
            now,
            evidenceDocument: evidenceByOperatorNoteId.get(note.id || [operatorNoteAwb(note), operatorNoteText(note)].join("|")),
          }),
        ),
      ),
      ...trackingRows.flatMap((row) => {
        const evidence = evidenceDocumentFromTrackingRow(row, now);
        return factsFromTrackingRow(row, {
          now,
          evidenceDocument: evidenceByTrackingAwb.get([normalizeAwb(row.awb || row.id || row.shipmentId), evidence.sourceId].join("|")),
        });
      }),
    ].filter(Boolean),
    (fact) => durableFactDedupeKey(fact),
  );
  const shipments = shipmentRowsFromInputs(input);
  const workgroups = workgroupsFromFacts(rawFacts, shipments);
  const facts = assignWorkgroupsToFacts(rawFacts, workgroups, shipments);
  const extractionJobs = buildAiExtractionJobs({
    evidenceDocuments,
    facts,
    workgroups,
  }, now, input.aiExtraction || {});
  return {
    snapshotTime: now.toISOString(),
    source: "ops-fact-ledger",
    writerVersion: DURABLE_FACT_LEDGER_VERSION,
    evidenceDocuments: evidenceDocuments.map(sanitizeLedgerTimestamps),
    facts: facts.map(sanitizeLedgerTimestamps),
    workgroups: workgroups.map(sanitizeLedgerTimestamps),
    extractionJobs: extractionJobs.map(sanitizeLedgerTimestamps),
    disputes: [],
    counts: {
      evidenceDocuments: evidenceDocuments.length,
      facts: facts.length,
      workgroups: workgroups.length,
      extractionJobs: extractionJobs.length,
      disputes: 0,
    },
  };
}

module.exports = {
  actorRole,
  applyOperationalUnderstanding,
  buildAiExtractionJobs,
  buildOperationalFactLedger,
  buildDurableOperationalFactLedger,
  deriveShipmentUnderstanding,
  evidenceDocumentFromShipmentEvent,
  factFromShipmentEvent,
  factTypeFromText,
  mergePreviousExtractionResults,
  runAiExtractionForLedger,
  workgroupsFromFacts,
  ALLOWED_EVIDENCE_SOURCE_TYPES,
  coarseEvidenceSourceType,
  normalizeEvidenceDocumentSourceType,
  sanitizeLedgerTimestamps,
  toIsoOrEmpty,
  _durableTest: {
    descriptorForShipmentEvent,
    stableHash,
    AI_EXTRACTION_OUTPUT_SCHEMA,
    workgroupKeyForFact,
    evidenceDocumentFromTrackingRow,
  },
};

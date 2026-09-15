"use strict";

const MOVEMENT_CODES = Object.freeze({
  departed: "DEP",
  arrived: "ARR",
  delivered: "DLV",
  "ready for pickup": "AWD",
  "received from other airline": "IN_TRANSIT",
  manifested: "PREFLIGHT",
  "booking confirmed": "PREFLIGHT",
});

const SHIPMENT_STATUS_CODES = Object.freeze({
  "pre flight": "PREFLIGHT",
  "pre-flight": "PREFLIGHT",
  "in transit": "IN_TRANSIT",
  arrived: "ARR",
  delivered: "DLV",
  "ready for pickup": "AWD",
});

function cleanLines(value) {
  return String(value || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function normalizedAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function explicitNoResult(text) {
  return /\b(?:no shipment(?:s)? (?:was |were )?found|shipment not found|no matching (?:air )?waybill|unable to find (?:the )?shipment)\b/i
    .test(String(text || ""));
}

function movementDetailEvents(lines, finalDestination) {
  const start = lines.findIndex((line) => /^movement details$/i.test(line));
  if (start < 0) return [];
  const events = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^(?:shipping tools and information|aircraft specifications)$/i.test(lines[index])) break;
    const description = lines[index].toLowerCase();
    let code = MOVEMENT_CODES[description] || "";
    if (!code) continue;
    const station = /^[A-Z]{3}$/.test(lines[index - 1] || "") ? lines[index - 1] : "";
    const timeLocal = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$/.test(lines[index + 1] || "")
      ? lines[index + 1]
      : "";
    if (code === "ARR" && finalDestination && station && station !== finalDestination) {
      code = "IN_TRANSIT";
    }
    events.push({ code, description: lines[index], station, timeLocal });
  }
  return events;
}

function shipmentDetailStatus(lines) {
  const start = lines.findIndex((line) => /^shipment details$/i.test(line));
  if (start < 0) return null;
  for (let index = start + 1; index < Math.min(lines.length, start + 7); index += 1) {
    const code = SHIPMENT_STATUS_CODES[lines[index].toLowerCase()];
    if (!code) continue;
    const station = /^[A-Z]{3}$/.test(lines[index + 1] || "") ? lines[index + 1] : "";
    return { code, description: lines[index], station, timeLocal: "" };
  }
  return null;
}

function statusLabel(code) {
  if (code === "AWD") return "ready for pickup";
  if (code === "ARR") return "arrived";
  if (code === "DEP" || code === "IN_TRANSIT") return "in transit";
  if (code === "PREFLIGHT") return "pre-flight";
  if (code === "DLV") return "delivered";
  return "unparsed";
}

function parseUnitedText(awb, url, title, rawText) {
  const text = String(rawText || "");
  const lines = cleanLines(text);
  const digits = normalizedAwb(awb);
  const awbLineIndex = lines.findIndex((line) => normalizedAwb(line) === digits);
  const finalDestination = awbLineIndex >= 1 ? lines[awbLineIndex - 1].toUpperCase() : "";
  const ready = text.match(/Ready for pickup:\s*\n?\s*([^\n]+)/i);
  const actualArrivalMatches = [...text.matchAll(/Actual Arrival \(([A-Z]{3})\):\s*([^\n]+)/gi)];
  const finalArrivalMatch = actualArrivalMatches.find(
    (match) => !finalDestination || match[1].toUpperCase() === finalDestination,
  );
  const actualDepartureMatches = [...text.matchAll(/Actual Departure \(([A-Z]{3})\):\s*([^\n]+)/gi)];
  const latestDeparture = actualDepartureMatches.at(-1);
  const estimatedArrivalMatches = [...text.matchAll(/Estimated Arrival \(([A-Z]{3})\):\s*([^\n]+)/gi)];
  const finalEstimated = estimatedArrivalMatches.find(
    (match) => !finalDestination || match[1].toUpperCase() === finalDestination,
  );
  const movements = movementDetailEvents(lines, finalDestination);
  const explicitMissing = explicitNoResult(text);
  let latestEvent = {};
  let finalArrivalEvent = null;

  if (ready && finalArrivalMatch) {
    latestEvent = {
      code: "AWD",
      description: "Ready for pickup",
      station: finalArrivalMatch[1],
      timeLocal: ready[1].trim(),
      actualArrival: finalArrivalMatch[2].trim(),
    };
    finalArrivalEvent = {
      code: "ARR",
      description: "Actual Arrival",
      station: finalArrivalMatch[1],
      timeLocal: finalArrivalMatch[2].trim(),
      actualArrival: finalArrivalMatch[2].trim(),
    };
  } else if (finalArrivalMatch) {
    latestEvent = {
      code: "ARR",
      description: "Actual Arrival",
      station: finalArrivalMatch[1],
      timeLocal: finalArrivalMatch[2].trim(),
      actualArrival: finalArrivalMatch[2].trim(),
    };
    finalArrivalEvent = { ...latestEvent };
  } else if (latestDeparture) {
    latestEvent = {
      code: "DEP",
      description: "Actual Departure",
      station: latestDeparture[1],
      timeLocal: latestDeparture[2].trim(),
    };
  } else {
    latestEvent = movements.find((event) => ["AWD", "ARR", "DEP", "IN_TRANSIT"].includes(event.code))
      || shipmentDetailStatus(lines)
      || movements[0]
      || {};
    if (latestEvent.code === "ARR" && (!finalDestination || latestEvent.station === finalDestination)) {
      finalArrivalEvent = { ...latestEvent };
    }
  }

  const hasProviderResult = !explicitMissing
    && awbLineIndex >= 0
    && Boolean(latestEvent.code);
  const status = explicitMissing ? "no-result" : (latestEvent.code || "parse-failed");
  return {
    awb,
    ok: hasProviderResult,
    noResult: explicitMissing,
    carrier: "United Cargo",
    url,
    title,
    status,
    summaryStatus: explicitMissing ? "not found" : statusLabel(latestEvent.code),
    summaryCode: latestEvent.code || "",
    latestEvent,
    finalArrivalEvent,
    scheduledArrival: finalEstimated ? finalEstimated[2].trim() : "",
    eta: ready ? ready[1].trim() : "",
    flights: [...new Set([...text.matchAll(/\bUA\s?\d{2,4}\b/gi)].map(
      (match) => match[0].replace(/\s+/, ""),
    ))],
    text,
  };
}

module.exports = Object.freeze({
  parseUnitedText,
  _test: Object.freeze({ explicitNoResult, movementDetailEvents, shipmentDetailStatus }),
});

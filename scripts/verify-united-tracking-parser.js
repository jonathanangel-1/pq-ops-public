#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { parseUnitedText } = require("../lib/united-tracking-parser");

const URL = "https://www.unitedcargo.com/en/us/track/awb/016-80000102";
const TITLE = "Track Shipments - United Cargo Tracking";

function page(body) {
  return `TLV\nELP\n016-14198380\nView air waybill\n${body}\nShipping tools and information`;
}

const movement = parseUnitedText("016-80000102", URL, TITLE, page(`
Estimated Arrival (ELP): Jul 23, 2026 / 02:00 PM
SHIPMENT DETAILS
In Transit
ELP
Movement details
In Transit
LAX
Departed
2026-07-21 18:08
UA1410T
`));
assert.equal(movement.ok, true);
assert.equal(movement.noResult, false);
assert.equal(movement.status, "DEP");
assert.deepEqual(movement.latestEvent, {
  code: "DEP",
  description: "Departed",
  station: "LAX",
  timeLocal: "2026-07-21 18:08",
});
assert.equal(movement.scheduledArrival, "Jul 23, 2026 / 02:00 PM");

const directStatus = parseUnitedText("016-80000102", URL, TITLE, page(`
SHIPMENT DETAILS
In Transit
ELP
Movement details
In Transit
Customs
1C
`));
assert.equal(directStatus.ok, true);
assert.equal(directStatus.summaryCode, "IN_TRANSIT");
assert.equal(directStatus.summaryStatus, "in transit");
assert.equal(directStatus.latestEvent.station, "ELP");

const preflight = parseUnitedText("016-80000102", URL, TITLE, page(`
SHIPMENT DETAILS
Pre Flight
ELP
Movement details
Pre Flight
LAX
Booking confirmed
2026-07-23 02:31
UA1410T
`));
assert.equal(preflight.ok, true);
assert.equal(preflight.summaryCode, "PREFLIGHT");
assert.equal(preflight.summaryStatus, "pre-flight");
assert.equal(preflight.finalArrivalEvent, null);

const arrivalWins = parseUnitedText("016-80000102", URL, TITLE, page(`
Actual Arrival (ELP): Jul 23, 2026 / 01:45 PM
Ready for pickup:
Jul 23, 2026 / 02:10 PM
SHIPMENT DETAILS
In Transit
ELP
Movement details
In Transit
LAX
Departed
2026-07-21 18:08
UA1410T
`));
assert.equal(arrivalWins.summaryCode, "AWD");
assert.equal(arrivalWins.latestEvent.station, "ELP");
assert.equal(arrivalWins.finalArrivalEvent.code, "ARR");

const missing = parseUnitedText(
  "016-80000102",
  URL,
  TITLE,
  "Track shipments\nNo shipment was found for the supplied air waybill.",
);
assert.equal(missing.ok, false);
assert.equal(missing.noResult, true);
assert.equal(missing.status, "no-result");
assert.equal(missing.summaryStatus, "not found");

const unparsed = parseUnitedText(
  "016-80000102",
  URL,
  TITLE,
  "Track shipments\n016-14198380\nProvider response pending.",
);
assert.equal(unparsed.ok, false);
assert.equal(unparsed.noResult, false);
assert.equal(unparsed.status, "parse-failed");
assert.equal(unparsed.summaryStatus, "unparsed");

process.stdout.write(`${JSON.stringify({
  ok: true,
  verifier: "united-tracking-parser",
  checks: [
    "movement-detail departure",
    "direct in-transit status",
    "pre-flight context only",
    "arrival and ready precedence",
    "explicit no-result only",
    "parse miss is not not-found",
  ],
}, null, 2)}\n`);

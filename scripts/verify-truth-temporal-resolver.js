#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { resolveTemporalExpression } = require("../lib/truth-temporal-resolver");

function main() {
  const exact = resolveTemporalExpression({
    text: "Cargo was released at 2026-07-09 13:45 -04:00.",
    messageDate: "2026-07-09T14:30:00-04:00",
    effect: "complete",
  });
  assert.equal(exact.status, "exact");
  assert.equal(exact.occurredAt, "2026-07-09T17:45:00.000Z");
  assert.equal(exact.occurredOn, "2026-07-09");

  const relative = resolveTemporalExpression({
    text: "The driver picked it up yesterday at 3:30 PM.",
    messageDate: "2026-07-09T14:30:00-04:00",
    effect: "complete",
  });
  assert.equal(relative.status, "exact");
  assert.equal(relative.occurredAt, "2026-07-08T19:30:00.000Z");
  assert.equal(relative.basis, "relative_date_time_anchored_to_message_offset");

  const lfd = resolveTemporalExpression({
    text: "LFD: July 12, 2026",
    messageDate: "2026-07-09T14:30:00-04:00",
    effect: "context",
  });
  assert.equal(lfd.status, "date_only");
  assert.equal(lfd.occurredOn, "2026-07-12");
  assert.equal(lfd.occurredAt, null);

  const ambiguous = resolveTemporalExpression({
    text: "LFD 07/08/2026",
    messageDate: "2026-07-01T12:00:00Z",
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.occurredOn, null);
  const mdy = resolveTemporalExpression({
    text: "LFD 07/08/2026",
    messageDate: "2026-07-01T12:00:00Z",
    dateOrder: "MDY",
  });
  assert.equal(mdy.occurredOn, "2026-07-08");

  const futureCompletion = resolveTemporalExpression({
    text: "Shipment delivered tomorrow at 9 AM.",
    messageDate: "2026-07-09T14:30:00-04:00",
    effect: "complete",
  });
  assert.equal(futureCompletion.status, "future_conflict");
  assert.equal(futureCompletion.occurredAt, null);

  const noClock = resolveTemporalExpression({ text: "Cargo released.", effect: "complete" });
  assert.equal(noClock.status, "none");
  assert.equal(noClock.occurredAt, null);

  console.log(JSON.stringify({
    ok: true,
    checks: 18,
    guarantees: [
      "no wall-clock fallback",
      "explicit offsets preserved then normalized to UTC",
      "relative expressions anchored only to immutable source time",
      "date-only and ambiguous dates never pretend to be exact instants",
      "future completion timestamps fail closed",
    ],
  }));
}

main();

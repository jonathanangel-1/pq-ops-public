"use strict";

// Retired 2026-07-09. This endpoint used free text to mutate companion-memory
// and returned a browser-only truth overlay before the canonical ledger saw
// the evidence. It must remain a hard tombstone so stale browser bundles fail
// loudly instead of reviving the dual-authority path.

function sendJson(response, statusCode, value) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      code: "LEGACY_OPERATOR_NOTE_METHOD_NOT_ALLOWED",
      error: "Method not allowed",
    });
    return;
  }
  sendJson(response, 410, {
    ok: false,
    code: "LEGACY_OPERATOR_NOTE_RETIRED",
    error: "Free-text operator notes cannot change shipment truth. Use the protected structured phone-truth control.",
    canonicalTruthRecorded: false,
    retryable: false,
  });
};

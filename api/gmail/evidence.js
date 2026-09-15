"use strict";

const { authorized, sendJson } = require("../../lib/supabase-agent");
const { normalizeAwb } = require("../../lib/awb");
const { loadGmailEvidencePacket } = require("../../lib/gmail-oauth-store");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const awb = normalizeAwb(requestUrl.searchParams.get("awb") || requestUrl.searchParams.get("waybill") || "");
    if (!awb) {
      sendJson(response, 400, { ok: false, error: "A valid awb query parameter is required" });
      return;
    }
    const packet = await loadGmailEvidencePacket(awb);
    sendJson(response, 200, {
      ok: true,
      packet,
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

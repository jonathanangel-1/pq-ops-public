"use strict";

const { listOperatorEvents } = require("../../lib/operator-events");
const { sendJson } = require("../../lib/supabase-agent");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const url = new URL(request.url || "/", "http://localhost");
    const limit = Number(url.searchParams.get("limit") || 40);
    const events = await listOperatorEvents(limit);
    sendJson(response, 200, {
      ok: true,
      events: Array.isArray(events) ? events : [],
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error), events: [] });
  }
};

"use strict";

const { readJsonBody } = require("../../../lib/api-utils");
const { recordOperatorEventAction } = require("../../../lib/operator-events");
const { sendJson } = require("../../../lib/supabase-agent");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const eventId = body.eventId || body.operatorEventId || "";
    const actionType = body.actionType || body.type || "action_taken";
    const payload = body.payload || {};
    const result = await recordOperatorEventAction(eventId, actionType, payload);
    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
};

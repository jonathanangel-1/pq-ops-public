"use strict";

const { readJsonBody } = require("../../../lib/api-utils");
const { upsertOperatorPushSubscription } = require("../../../lib/operator-events");
const { sendJson } = require("../../../lib/supabase-agent");

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const subscription = body.subscription || body;
    const result = await upsertOperatorPushSubscription(subscription, {
      deviceId: body.deviceId || subscription.deviceId || "",
      label: body.label || "Rowan PWA",
      userAgent: request.headers["user-agent"] || body.userAgent || "",
    });
    sendJson(response, 201, result);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
};

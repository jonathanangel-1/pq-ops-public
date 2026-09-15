"use strict";

const { isDryRunRequest, readJsonBody } = require("../../../lib/api-utils");
const { deliverPendingOperatorPushes, publicPushConfig } = require("../../../lib/operator-events");
const { authorized, sendJson } = require("../../../lib/supabase-agent");

module.exports = async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = request.method === "POST" ? await readJsonBody(request) : {};
    const dryRun = isDryRunRequest(request, body);
    if (!dryRun && !authorized(request)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }
    const readiness = publicPushConfig();
    if (!readiness.health?.ready) {
      sendJson(response, 503, {
        ok: false,
        configured: false,
        dryRun,
        health: readiness.health,
        missing: readiness.missing,
        error: "Operator push drain is not ready",
      });
      return;
    }
    const limit = Number(body.limit || new URL(request.url || "/", "http://localhost").searchParams.get("limit") || 20);
    const result = await deliverPendingOperatorPushes({ dryRun, limit });
    sendJson(response, 200, { ...result, dryRun });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

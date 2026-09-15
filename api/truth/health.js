"use strict";

const {
  diagnoseHostedPersistence,
  sendJson,
} = require("../../lib/supabase-agent");
const { buildTruthHealth } = require("../../lib/truth-health");
const { platformSendContract } = require("../../lib/platform-send");

function diagnosticRequested(request) {
  const url = new URL(request.url || "/", "http://localhost");
  const value = String(url.searchParams.get("diagnostic") || url.searchParams.get("deep") || "").toLowerCase();
  return ["1", "true", "yes", "deep"].includes(value);
}

function diagnosticTimeoutFromRequest(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("diagnosticTimeoutMs") || url.searchParams.get("timeoutMs") || undefined;
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const health = await buildTruthHealth();
    // The composer's send affordance must be honest: it reads this contract to
    // say exactly why "Send from Pikiio" is disabled.
    health.platformSend = platformSendContract();
    if (diagnosticRequested(request)) {
      health.hostedPersistence = health.hostedPersistence || {};
      health.hostedPersistence.diagnostic = await diagnoseHostedPersistence({
        timeoutMs: diagnosticTimeoutFromRequest(request),
      });
    }
    sendJson(response, 200, health);
  } catch (error) {
    const body = {
      ok: false,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      source: "truth-health-v1",
      warnings: ["Truth health could not be computed."],
      error: error instanceof Error ? error.message : String(error),
      operatorGuidance: "Treat shipment truth as source-gapped until health can be computed.",
    };
    if (diagnosticRequested(request)) {
      body.hostedPersistence = {
        ok: false,
        status: "degraded",
        diagnostic: await diagnoseHostedPersistence({
          timeoutMs: diagnosticTimeoutFromRequest(request),
        }),
      };
    }
    sendJson(response, 200, body);
  }
};

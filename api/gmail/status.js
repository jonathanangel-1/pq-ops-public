"use strict";

const { authorized, sendJson } = require("../../lib/supabase-agent");
const { gmailDirectEnv } = require("../../lib/gmail-direct-ingest");
const {
  loadGmailFreshness,
  loadGmailOAuthStatus,
  redactSecret,
} = require("../../lib/gmail-oauth-store");

function directConfigStatus() {
  const cfg = gmailDirectEnv();
  return {
    available: cfg.available,
    user: cfg.user,
    tokenSource: cfg.tokenSource || "",
    storedOAuthAvailable: Boolean(cfg.storedOAuthAvailable),
    sources: {
      clientId: cfg.clientIdSource || null,
      clientSecret: cfg.clientSecretSource || null,
      refreshToken: cfg.refreshTokenSource || null,
    },
    staticRefreshToken: cfg.refreshToken ? redactSecret(cfg.refreshToken) : "",
    missing: [
      cfg.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
      cfg.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
      cfg.refreshToken || cfg.storedOAuthAvailable ? "" : "GMAIL_REFRESH_TOKEN or stored Gmail OAuth connection",
    ].filter(Boolean),
  };
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  const now = new Date();
  const [oauth, freshness] = await Promise.all([
    loadGmailOAuthStatus().catch((error) => ({ configured: false, error: error instanceof Error ? error.message : String(error) })),
    loadGmailFreshness(process.env, now).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
  ]);
  sendJson(response, 200, {
    ok: true,
    checkedAt: now.toISOString(),
    direct: directConfigStatus(),
    oauth,
    freshness,
  });
};

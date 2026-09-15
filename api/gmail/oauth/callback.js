"use strict";

const { sendJson } = require("../../../lib/supabase-agent");
const {
  exchangeGmailOAuthCode,
  fetchGmailProfile,
  storeGmailOAuthConnection,
  verifyOAuthState,
} = require("../../../lib/gmail-oauth-store");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const requestUrl = new URL(request.url || "/", "http://localhost");
    const providerError = requestUrl.searchParams.get("error");
    if (providerError) {
      sendJson(response, 400, {
        ok: false,
        error: providerError,
        errorDescription: requestUrl.searchParams.get("error_description") || "",
      });
      return;
    }

    const code = requestUrl.searchParams.get("code") || "";
    const state = verifyOAuthState(requestUrl.searchParams.get("state") || "");
    if (!code) {
      sendJson(response, 400, { ok: false, error: "Missing OAuth code" });
      return;
    }

    const tokenPayload = await exchangeGmailOAuthCode({
      code,
      redirectUri: state.redirectUri,
    });
    if (!tokenPayload.refresh_token) {
      sendJson(response, 409, {
        ok: false,
        error: "Google did not return a refresh token; restart from /api/gmail/oauth/start with prompt=consent or revoke the old grant first.",
      });
      return;
    }

    const profile = await fetchGmailProfile(tokenPayload.access_token);
    const connection = await storeGmailOAuthConnection({
      tokenPayload,
      profile,
      connectionKey: state.connectionKey,
    });
    sendJson(response, 200, {
      ok: true,
      provider: "gmail",
      connection,
      token: "[encrypted:redacted]",
      next: "Run /api/gmail/status with the admin bearer token to confirm freshness.",
    });
  } catch (error) {
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

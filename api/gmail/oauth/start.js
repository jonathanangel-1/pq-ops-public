"use strict";

const { authorized, sendJson } = require("../../../lib/supabase-agent");
const {
  buildGmailOAuthUrl,
  missingOAuthConfig,
  oauthEnv,
  redirectUriForRequest,
} = require("../../../lib/gmail-oauth-store");

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
    const redirectUri = redirectUriForRequest(request);
    const missing = missingOAuthConfig(process.env, redirectUri);
    if (missing.length) {
      sendJson(response, 500, { ok: false, error: "Gmail OAuth is not configured", missing });
      return;
    }
    const cfg = oauthEnv();
    const result = buildGmailOAuthUrl({
      redirectUri,
      returnTo: requestUrl.searchParams.get("returnTo") || "",
      connectionKey: requestUrl.searchParams.get("connectionKey") || cfg.connectionKey,
    });
    if (requestUrl.searchParams.get("redirect") === "1") {
      response.statusCode = 302;
      response.setHeader("location", result.authorizationUrl);
      response.end();
      return;
    }
    sendJson(response, 200, {
      ok: true,
      ...result,
      config: {
        connectionKey: cfg.connectionKey,
        accountHint: cfg.userHint || "",
        tokenStorage: "supabase-encrypted-refresh-token",
      },
    });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

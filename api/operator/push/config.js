"use strict";

const { publicPushConfig } = require("../../../lib/operator-events");
const { sendJson } = require("../../../lib/supabase-agent");

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  sendJson(response, 200, publicPushConfig());
};

"use strict";

const { sendJson } = require("../lib/supabase-agent");
const { generateDeliveryOrderForAction } = require("../lib/delivery-order-action");

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function isDryRun(request, body) {
  const url = new URL(request.url || "/", "http://localhost");
  return body.dryRun === true || url.searchParams.get("dryRun") === "1";
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(request);
    const actionId = body.actionId || body.action?.id || "";
    const result = await generateDeliveryOrderForAction(actionId, body.action || null, {
      dryRun: isDryRun(request, body),
    });
    sendJson(response, result.statusCode, result.body);
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
};

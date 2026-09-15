"use strict";

const {
  loadAppSnapshot,
  sendJson,
  upsertAppSnapshot,
} = require("../lib/supabase-agent");
const { upsertMoneyMemory } = require("../lib/money-memory-store");

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

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(request);
    const now = new Date().toISOString();
    const current = await loadAppSnapshot("money-memory", {
      snapshotTime: now,
      source: "operator-money-memory",
      records: [],
    });
    const next = upsertMoneyMemory(current, body.entry || body, now);

    await upsertAppSnapshot("money-memory", {
      snapshotTime: next.snapshotTime,
      source: next.source,
      records: next.records,
    });

    sendJson(response, 200, {
      ok: true,
      record: next.savedRecord,
      memoryCount: next.savedCount,
      note: "Saved to money memory. The next refresh applies it to shipment truth.",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

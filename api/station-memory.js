"use strict";

const {
  loadAppSnapshot,
  sendJson,
  upsertAppSnapshot,
} = require("../lib/supabase-agent");
const { upsertStationMemory } = require("../lib/station-memory-store");

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
    const current = await loadAppSnapshot("station-memory", {
      snapshotTime: now,
      source: "operator-station-memory",
      contacts: [],
    });
    const next = upsertStationMemory(current, body.entry || body, now);

    await upsertAppSnapshot("station-memory", {
      snapshotTime: next.snapshotTime,
      source: next.source,
      contacts: next.contacts,
    });

    sendJson(response, 200, {
      ok: true,
      entry: next.savedEntry,
      memoryCount: next.savedCount,
      note: "Saved to station memory. The next truth refresh (about 5 minutes) applies it to this shipment's contacts and actions.",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

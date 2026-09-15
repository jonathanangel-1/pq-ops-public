"use strict";

const {
  loadAppSnapshot,
  sendJson,
  upsertAppSnapshot,
} = require("../lib/supabase-agent");
const { emptyCompanionMemory } = require("../lib/companion-memory-store");
const { upsertBrokerContactMemory } = require("../lib/broker-contact-memory");

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
    const current = await loadAppSnapshot("companion-memory", emptyCompanionMemory(now));
    const next = upsertBrokerContactMemory(current, body.entry || body, now);

    await upsertAppSnapshot("companion-memory", {
      snapshotTime: next.snapshotTime,
      source: next.source,
      operatorNotes: next.operatorNotes,
      resolvedConflicts: next.resolvedConflicts || [],
      alertStates: next.alertStates || [],
    });

    sendJson(response, 200, {
      ok: true,
      savedNote: next.savedNote,
      memoryCount: next.savedCount,
      note: "Saved broker contact to company memory. The next refresh applies it to shipment truth.",
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

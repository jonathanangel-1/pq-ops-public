"use strict";
// Snapshot the CURRENT legacy board (app_snapshots['shipment-truth-packets'])
// so the in-freeze parity gate compares against exactly what production
// serves at ceremony time, not a stale capture.
const fs = require("fs");
const path = require("path");
const { directClient, artifactDir } = require("./config");

(async () => {
  const client = await directClient();
  const { rows } = await client.query(
    "select payload, updated_at from public.app_snapshots where snapshot_key='shipment-truth-packets'",
  );
  await client.end();
  if (!rows.length) throw new Error("legacy board snapshot missing");
  const payload = rows[0].payload;
  const out = path.join(artifactDir(), "legacy-board-capture.json");
  fs.writeFileSync(out, JSON.stringify(payload));
  const counts = payload.counts || {};
  console.log(JSON.stringify({
    capturedAt: new Date().toISOString(),
    boardUpdatedAt: rows[0].updated_at,
    shipments: (payload.shipments || []).length,
    counts,
    out,
  }));
})().catch((e) => { console.error("CAPTURE ERR:", e.message); process.exit(1); });

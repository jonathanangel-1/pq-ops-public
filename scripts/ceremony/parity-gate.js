"use strict";
// In-freeze parity gate: latest relational build packet vs the legacy board
// captured at ceremony start (capture-legacy-board.js).
//
// PASS requires, against the fresh capture:
//   - zero status conflicts among overlapping shipments
//   - zero legacy-ACTIVE shipments missing from the relational packet
// legacy-only completed history is reported, never fatal — it is the
// documented parked-backfill class (historical replay is a post-flip task).
// Exit 0 = pass, 2 = fail.
const fs = require("fs");
const path = require("path");
const { directClient, artifactDir } = require("./config");

const DONE = new Set(["done", "delivered", "received", "cleared", "completed", "closed", "pod"]);
const norm = (s) => {
  const x = String(s || "").toLowerCase().trim();
  if (DONE.has(x)) return "done";
  if (/deliver|receiv|clear|complete|pod/.test(x)) return "done";
  if (/transit|depart|flown|uplift|manifest/.test(x)) return "moving";
  if (/arriv|landed|at destination|customs/.test(x)) return "arrived";
  if (/book|pending|created|planned/.test(x)) return "planned";
  if (/hold|exception|problem|issue|delay/.test(x)) return "attention";
  return x || "unknown";
};
const byAwb = (list) => {
  const m = new Map();
  for (const s of list || []) {
    const awb = String(s.awb || s.awbNumber || s.id || "").replace(/[^0-9]/g, "");
    if (awb) m.set(awb, s);
  }
  return m;
};
const statusOf = (s) => norm(s.status || s.currentStatus || (s.lifecycle && s.lifecycle.status));

(async () => {
  const packetHash = process.argv[2];
  if (!/^[0-9a-f]{64}$/.test(packetHash || "")) throw new Error("usage: parity-gate.js <packet-hash>");
  const legacyFile = path.join(artifactDir(), "legacy-board-capture.json");
  const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));

  const client = await directClient();
  const { rows } = await client.query(
    "select packet_canonical_text from public.truth_builds where workspace_key='primary' and packet_hash=$1 limit 1",
    [packetHash],
  );
  await client.end();
  if (!rows.length) throw new Error(`no build with packet hash ${packetHash}`);
  const fresh = JSON.parse(rows[0].packet_canonical_text);

  const fN = byAwb(fresh.shipments || fresh.packets || []);
  const fL = byAwb(legacy.shipments || []);
  const activeAwbs = new Set((legacy.activeAwbs || []).map((a) => String(a).replace(/[^0-9]/g, "")));

  const report = {
    packetHash,
    legacyBoardCounts: legacy.counts || null,
    agree: 0,
    statusConflicts: [],
    newOnly: [],
    oldOnly: [],
    activeMissing: [],
  };
  for (const [awb, n] of fN) {
    if (!fL.has(awb)) { report.newOnly.push(awb); continue; }
    const ns = statusOf(n);
    const ls = statusOf(fL.get(awb));
    if (ns === ls) report.agree += 1;
    else report.statusConflicts.push({ awb, fresh: ns, legacy: ls });
  }
  for (const [awb] of fL) if (!fN.has(awb)) report.oldOnly.push(awb);
  for (const awb of activeAwbs) if (!fN.has(awb)) report.activeMissing.push(awb);

  const pass = report.statusConflicts.length === 0 && report.activeMissing.length === 0;
  report.pass = pass;
  const out = path.join(artifactDir(), "parity-gate-report.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  console.log("PARITY:", JSON.stringify({
    pass,
    agree: report.agree,
    conflicts: report.statusConflicts.length,
    activeMissing: report.activeMissing.length,
    newOnly: report.newOnly.length,
    oldOnlyCompletedHistory: report.oldOnly.length,
    report: out,
  }));
  if (!pass) process.exitCode = 2;
})().catch((e) => { console.error("PARITY ERR:", e.message); process.exit(1); });

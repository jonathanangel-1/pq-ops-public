"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { demoSnapshot } = require("./scenarios");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 4173);
const staticFiles = new Set(["index.html", "app.min.js", "app.js", "styles.min.css", "styles.css", "config.js", "manifest.webmanifest", "icon.svg", "demo/mark.svg"]);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const drafts = [];
function send(res, status, body) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === "/shipment-truth-packets.json" || url.pathname === "/api/brain/shipments") return send(res, 200, demoSnapshot());
  if (url.pathname === "/api/brain/chat") {
    const rows = demoSnapshot().shipments;
    return send(res, 200, { ok: true, synthetic: true, answer: `Synthetic demonstration: ${rows.map(row => `${row.awb}: ${row.currentState} Next: ${row.nextAction}.`).join(" ")}`, sources: [] });
  }
  if (url.pathname === "/api/actions/send" && req.method === "POST") {
    const draft = { id: `demo-draft-${drafts.length + 1}`, status: "draft", synthetic: true, message: "Saved in demo memory only. No email was sent." };
    drafts.push(draft); return send(res, 200, { ok: true, request: draft, draft });
  }
  if (req.method !== "GET") return send(res, 409, { ok: false, error: "This public demo cannot send communications or change external systems." });
  if (url.pathname.startsWith("/api/")) return send(res, 200, { ok: true, synthetic: true, configured: false, enabled: false, events: [], jobs: [], requests: drafts, sources: [], notifications: [] });
  if (url.pathname.endsWith(".json")) return send(res, 200, { snapshotTime: new Date().toISOString(), synthetic: true, requests: drafts, shipments: [], proofs: [], contacts: [], events: [], groups: [] });
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!staticFiles.has(rel) || !fs.existsSync(path.join(root, rel))) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": types[path.extname(rel)] || "text/plain", "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" });
  fs.createReadStream(path.join(root, rel)).pipe(res);
}).listen(port, "127.0.0.1", () => console.log(`PQ Ops synthetic demo: http://127.0.0.1:${port}`));

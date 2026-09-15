#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { buildRowCertification } = require("../lib/truth-health");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://pq-ops-demo.example";
const SNAPSHOT_FILES = [
  "gmail-direct-state.json",
  "gmail-proof-snapshot.json",
  "shipment-events.json",
  "shipment-state.json",
  "operator-notifications.json",
  "operational-fact-ledger.json",
  "shipment-truth-packets.json",
  "active-awb-index.json",
  "action-queue.json",
];

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function tokenValue() {
  return process.env.PQ_VERIFY_CRON_SECRET || process.env.CRON_SECRET || argValue("--token");
}

function requestedAwbs() {
  return [...new Set(process.argv
    .filter((arg) => arg.startsWith("--awb=") || arg.startsWith("--awbs="))
    .flatMap((arg) => arg.slice(arg.indexOf("=") + 1).split(/[,\s]+/))
    .map((awb) => String(awb || "").replace(/\D/g, ""))
    .filter(Boolean))];
}

async function fetchJson(url, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Production overlay bundle request failed: ${response.status} ${body?.error || text.slice(0, 200)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function writeSnapshotFile(fileName, payload, dryRun) {
  if (!SNAPSHOT_FILES.includes(fileName)) throw new Error(`Refusing unexpected snapshot file ${fileName}`);
  if (!payload || typeof payload !== "object") throw new Error(`Snapshot file ${fileName} is missing payload`);
  if (dryRun) return;
  fs.writeFileSync(path.join(ROOT_DIR, fileName), `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const dryRun = hasFlag("--dry-run");
  const allowSourceGaps = hasFlag("--allow-source-gaps");
  const baseUrl = argValue("--base-url", process.env.PQ_PRODUCTION_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = Math.max(1000, Number(argValue("--timeout-ms", "180000")) || 180000);
  if (hasFlag("--public-fallback")) throw new Error("--public-fallback was removed; use the authorized live Gmail overlay bundle path.");

  const token = tokenValue();
  if (!token) throw new Error("Missing PQ_VERIFY_CRON_SECRET or CRON_SECRET for authorized production overlay bundle download.");
  const awbs = requestedAwbs();
  const url = new URL("/api/brain/shipments", baseUrl);
  url.searchParams.set("liveGmail", "1");
  url.searchParams.set("snapshotBundle", "1");
  url.searchParams.set("lookbackDays", argValue("--lookback-days", "14"));
  url.searchParams.set("maxThreads", argValue("--max-threads", "120"));
  url.searchParams.set("maxAttachmentPdfs", argValue("--max-attachment-pdfs", "2"));
  if (awbs.length) url.searchParams.set("awbs", awbs.join(","));
  url.searchParams.set("ts", String(Date.now()));

  const body = await fetchJson(url, token, timeoutMs);
  const bundle = body.snapshotBundle || {};
  const files = bundle.files || {};
  if (body.liveGmailOverlay !== true || body.persisted !== false || bundle.persisted !== false) {
    throw new Error("Production response was not a non-persisted live Gmail overlay bundle.");
  }
  const truthPackets = files["shipment-truth-packets.json"];
  if (!truthPackets?.shipments?.length) throw new Error("Production overlay bundle did not include shipment truth packets.");
  const rowCertification = buildRowCertification(truthPackets);
  if (rowCertification.problemCount && !allowSourceGaps) {
    throw new Error(`Refusing to write production overlay bundle: ${rowCertification.problemCount} active row(s) lack clean Gmail coverage (${rowCertification.problemAwbs.join(", ")}).`);
  }
  for (const fileName of SNAPSHOT_FILES) {
    if (files[fileName]) writeSnapshotFile(fileName, files[fileName], dryRun);
  }
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    source: "production-live-gmail-overlay-bundle",
    baseUrl,
    requestedAwbCount: awbs.length,
    shipmentCount: body.shipments?.length || 0,
    snapshotTime: body.snapshotTime || "",
    sourceHealthStatus: body.sourceHealth?.status || "",
    direct: body.direct || {},
    rowCertification: {
      activeRowsChecked: rowCertification.activeRowsChecked,
      problemCount: rowCertification.problemCount,
      problemAwbs: rowCertification.problemAwbs,
    },
    files: SNAPSHOT_FILES.filter((fileName) => files[fileName]),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

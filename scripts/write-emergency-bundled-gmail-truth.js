#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { gmailDirectEnv, runDirectGmailRefresh, _test } = require("../lib/gmail-direct-ingest");
const { buildRowCertification } = require("../lib/truth-health");

const ROOT_DIR = path.resolve(__dirname, "..");
const WRITER_SUFFIX = "emergency-bundled-gmail-truth";

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = "") {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function loadDotEnvFile(fileName) {
  const fullPath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(fullPath)) return;
  const lines = fs.readFileSync(fullPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function readJson(fileName, fallback) {
  const fullPath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(fullPath)) return fallback;
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function writeJson(fileName, value, dryRun) {
  if (dryRun) return;
  fs.writeFileSync(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function requestedAwbs() {
  return [...new Set(process.argv
    .filter((arg) => arg.startsWith("--awb=") || arg.startsWith("--awbs="))
    .flatMap((arg) => arg.slice(arg.indexOf("=") + 1).split(/[,\s]+/))
    .map(normalizeAwb)
    .filter(Boolean))];
}

function activeAwbsFromPackets(packets = {}) {
  return [...new Set((packets.shipments || [])
    .filter((shipment) => !shipment.truthPacketRole || String(shipment.truthPacketRole).toLowerCase() === "active")
    .map((shipment) => normalizeAwb(shipment.awb || shipment.id || shipment.trackingNumber))
    .filter(Boolean))].sort();
}

function appendWriterSuffix(writerVersion = "") {
  const parts = String(writerVersion || "shipment-truth-packets-v1").split("+").filter(Boolean);
  const base = parts.shift() || "shipment-truth-packets-v1";
  return [base, ...new Set([...parts, WRITER_SUFFIX])].join("+");
}

function withSignature(payload = {}) {
  return {
    ...payload,
    contentSignature: _test.contentSignature(payload),
  };
}

function emergencyTruthPacketSnapshot(snapshot = {}, generatedAt, reason) {
  return withSignature({
    ...snapshot,
    writerVersion: appendWriterSuffix(snapshot.writerVersion),
    emergencyBundledTruth: {
      source: "scripts/write-emergency-bundled-gmail-truth.js",
      mode: "gmail-oauth-read-only-to-bundled-json",
      generatedAt,
      reason,
      durablePath: "bundled-json-deployment",
      finalReadiness: "does-not-satisfy-production-readiness-without-hosted-persistence",
    },
  });
}

async function main() {
  loadDotEnvFile(".env.local");
  loadDotEnvFile(".env");

  const dryRun = hasFlag("--dry-run");
  const allowSourceGaps = hasFlag("--allow-source-gaps");
  const generatedAt = new Date().toISOString();
  const localTruthPackets = readJson("shipment-truth-packets.json", { shipments: [] });
  const awbs = requestedAwbs().length ? requestedAwbs() : activeAwbsFromPackets(localTruthPackets);
  const gmailConfig = gmailDirectEnv(process.env);

  if (!gmailConfig.available) {
    const missing = [
      gmailConfig.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
      gmailConfig.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
      gmailConfig.refreshToken || gmailConfig.storedOAuthAvailable ? "" : "GMAIL_REFRESH_TOKEN or stored Gmail OAuth connection",
    ].filter(Boolean);
    throw new Error(`Direct Gmail OAuth env is incomplete; cannot refresh emergency bundled truth. Missing: ${missing.join(", ")}`);
  }
  if (!awbs.length) {
    throw new Error("No AWBs available for emergency bundled Gmail truth refresh.");
  }

  const memorySnapshots = {
    active: localTruthPackets,
    brain: readJson("ops-brain-memory.json", { shipments: [], completed: [] }),
    companionMemory: readJson("companion-memory.json", { operatorNotes: [], resolvedConflicts: [], alertStates: [] }),
  };
  const result = await runDirectGmailRefresh({
    awbs,
    now: new Date(generatedAt),
    lookbackDays: Number(argValue("--lookback-days", process.env.PQ_GMAIL_DIRECT_LOOKBACK_DAYS || 14)),
    maxThreads: Number(argValue("--max-threads", process.env.PQ_GMAIL_DIRECT_MAX_THREADS || 80)),
    maxAttachmentPdfs: Number(argValue("--max-attachment-pdfs", process.env.PQ_GMAIL_DIRECT_MAX_PDF_ATTACHMENTS || 4)),
    includeProofs: true,
    includeTruthPackets: true,
    memorySnapshots,
    write: false,
    returnMergedSnapshots: true,
    skipHostedSnapshotReads: true,
  });

  if (!result.truthPackets || !(result.truthPackets.shipments || []).length) {
    throw new Error("Emergency bundled Gmail refresh did not produce shipment truth packets.");
  }

  const truthPackets = emergencyTruthPacketSnapshot(
    result.truthPackets,
    generatedAt,
    "Hosted Supabase read/write persistence is unavailable; this bundled deployment keeps operator truth current until hosted persistence recovers.",
  );
  const rowCertification = buildRowCertification(truthPackets);
  if (rowCertification.problemCount && !allowSourceGaps) {
    throw new Error(`Refusing to write emergency bundled truth: ${rowCertification.problemCount} active row(s) lack clean Gmail coverage (${rowCertification.problemAwbs.join(", ")}).`);
  }

  const snapshots = {
    "gmail-proof-snapshot.json": result.gmailProofSnapshot,
    "shipment-events.json": result.shipmentEvents,
    "shipment-state.json": result.shipmentState,
    "operator-notifications.json": result.operatorNotifications,
    "operational-fact-ledger.json": result.operationalFactLedger,
    "shipment-truth-packets.json": truthPackets,
    "active-awb-index.json": result.activeAwbIndex,
    "action-queue.json": result.actionQueue,
  };
  for (const [fileName, snapshot] of Object.entries(snapshots)) {
    if (!snapshot) continue;
    writeJson(fileName, snapshot, dryRun);
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    source: "emergency-bundled-gmail-truth",
    generatedAt,
    awbCount: awbs.length,
    updated: result.updated,
    threadCount: result.threadCount,
    queryCount: result.queryCount,
    gmailCoverageStatus: result.gmailCoverageStatus,
    gmailCoverageProblemCount: result.gmailCoverageProblemCount,
    truthPacketActiveShipmentCount: result.truthPacketActiveShipmentCount,
    truthPacketGmailPromotedActiveShipmentCount: result.truthPacketGmailPromotedActiveShipmentCount,
    rowCertification: {
      activeRowsChecked: rowCertification.activeRowsChecked,
      problemCount: rowCertification.problemCount,
      problemAwbs: rowCertification.problemAwbs,
    },
    snapshotLoadWarnings: result.snapshotLoadWarnings,
    files: Object.keys(snapshots).filter((fileName) => snapshots[fileName]),
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { loadAppSnapshotRows } = require("../lib/supabase-agent");

const ROOT_DIR = path.resolve(__dirname, "..");
const HOSTED_GMAIL_IMPORT_SNAPSHOTS = [
  ["gmail-proof-snapshot", "gmail-proof-snapshot.json"],
  ["shipment-events", "shipment-events.json"],
  ["shipment-state", "shipment-state.json"],
  ["operator-notifications", "operator-notifications.json"],
  ["broker-dispatch-snapshot", "broker-dispatch-snapshot.json"],
  ["customs-broker-snapshot", "customs-broker-snapshot.json"],
  ["eod-report-facts", "eod-report-facts.json"],
];
const REQUIRED_HOSTED_GMAIL_IMPORT_SNAPSHOTS = [
  "gmail-proof-snapshot",
  "shipment-events",
  "shipment-state",
  "operator-notifications",
];

function loadLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    const envPath = path.join(ROOT_DIR, file);
    if (!fsSync.existsSync(envPath)) continue;
    const content = fsSync.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

function usefulSnapshotPayload(payload) {
  return Boolean(payload && typeof payload === "object" && Object.keys(payload).length);
}

function snapshotTime(payload = {}) {
  return payload.snapshotTime || payload.updatedAt || "";
}

function snapshotTimeMs(payload = {}) {
  const parsed = Date.parse(snapshotTime(payload));
  return Number.isFinite(parsed) ? parsed : 0;
}

function payloadMapFromRows(rows = []) {
  const payloads = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.snapshot_key || row?.snapshotKey || "").trim();
    if (!key) continue;
    payloads.set(key, row.payload);
  }
  return payloads;
}

function validateHostedGmailBundle(payloads) {
  const missingRequired = REQUIRED_HOSTED_GMAIL_IMPORT_SNAPSHOTS
    .filter((snapshotKey) => !usefulSnapshotPayload(payloads.get(snapshotKey)));
  if (missingRequired.length) {
    throw new Error(
      `Hosted Gmail import missing required snapshot(s) ${missingRequired.join(", ")}; refusing to rebuild local canonical truth from stale local Gmail proof.`,
    );
  }

  const proof = payloads.get("gmail-proof-snapshot");
  if (!Array.isArray(proof.proofs)) {
    throw new Error("Hosted Gmail proof snapshot has no proofs array; refusing to rebuild local canonical truth from stale local Gmail proof.");
  }

  const missingTimes = REQUIRED_HOSTED_GMAIL_IMPORT_SNAPSHOTS
    .filter((snapshotKey) => !snapshotTimeMs(payloads.get(snapshotKey)));
  if (missingTimes.length) {
    throw new Error(
      `Hosted Gmail import has malformed snapshotTime for ${missingTimes.join(", ")}; refusing to rebuild local canonical truth from stale local Gmail proof.`,
    );
  }
}

async function writeJsonAtomic(fileName, payload) {
  const targetPath = path.join(ROOT_DIR, fileName);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  await fs.rename(tempPath, targetPath);
}

async function importHostedGmailSnapshots() {
  loadLocalEnv();
  const snapshotKeys = HOSTED_GMAIL_IMPORT_SNAPSHOTS.map(([snapshotKey]) => snapshotKey);
  const rows = await loadAppSnapshotRows(snapshotKeys, {
    timeoutMs: Number(process.env.PQ_HOSTED_GMAIL_IMPORT_TIMEOUT_MS || 30000),
  });
  const payloads = payloadMapFromRows(rows);
  validateHostedGmailBundle(payloads);

  const importedSnapshots = [];
  const missingSnapshots = [];
  const snapshotTimes = {};

  for (const [snapshotKey, fileName] of HOSTED_GMAIL_IMPORT_SNAPSHOTS) {
    const payload = payloads.get(snapshotKey);
    if (!usefulSnapshotPayload(payload)) {
      missingSnapshots.push(snapshotKey);
      continue;
    }
    await writeJsonAtomic(fileName, payload);
    importedSnapshots.push(snapshotKey);
    snapshotTimes[snapshotKey] = snapshotTime(payload);
  }

  return {
    ok: true,
    importedAt: new Date().toISOString(),
    requiredSnapshots: REQUIRED_HOSTED_GMAIL_IMPORT_SNAPSHOTS,
    importedSnapshots,
    missingSnapshots,
    snapshotTimes,
  };
}

if (require.main === module) {
  importHostedGmailSnapshots()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

module.exports = {
  HOSTED_GMAIL_IMPORT_SNAPSHOTS,
  REQUIRED_HOSTED_GMAIL_IMPORT_SNAPSHOTS,
  importHostedGmailSnapshots,
  validateHostedGmailBundle,
};

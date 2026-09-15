#!/usr/bin/env node
"use strict";

// Source-only local-to-hosted sync.
//
// Canonical shipment truth is published exclusively by
// lib/canonical-truth-publisher.js through the hosted Gmail/canonical refresh.
// This script deliberately cannot upload shipment-truth-packets, active indexes,
// action queues, companion projections, or truth-audit output.

const fs = require("node:fs/promises");
const path = require("node:path");
const { withContentSignature } = require("../lib/content-signature");
const { createTruthSourceIngestClient } = require("../lib/truth-source-ingest-client");

const ROOT_DIR = path.resolve(__dirname, "..");
const SOURCE_SNAPSHOTS = [
  ["tms-detail-snapshot", "tms-detail-snapshot.json"],
  ["tms-grid-snapshot", "tms-grid-snapshot.json"],
  ["station-context", "station-context.json"],
  ["station-memory", "station-memory.json"],
  ["money-memory", "money-memory.json"],
  ["united-tracking-snapshot", "united-tracking-snapshot.json"],
  ["elal-tracking-snapshot", "elal-tracking-snapshot.json"],
  ["other-tracking-snapshot", "other-tracking-snapshot.json"],
];
const FORBIDDEN_DERIVED_KEYS = new Set([
  "shipment-truth-packets",
  "active-awb-index",
  "shipment-truth-audit",
  "shipment-state",
  "shipment-events",
  "operational-fact-ledger",
  "action-queue",
  "ops-brain-memory",
  "outbox-requests",
]);

function hasFlag(name) {
  return process.argv.includes(name);
}

async function loadDotEnvLocal() {
  for (const fileName of [".env.local", ".env"]) {
    try {
      const content = await fs.readFile(path.join(ROOT_DIR, fileName), "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function readJson(fileName) {
  return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
}

function assertSourceOnlySnapshotKey(snapshotKey) {
  if (FORBIDDEN_DERIVED_KEYS.has(snapshotKey)) {
    const error = new Error(`Refusing to publish derived/canonical snapshot from source sync: ${snapshotKey}`);
    error.code = "SOURCE_SYNC_DERIVED_KEY_FORBIDDEN";
    throw error;
  }
  return snapshotKey;
}

function truthLedgerSourceIngestEnabled(env = process.env) {
  return String(env.PQ_TRUTH_LEDGER_SOURCE_INGEST_ENABLED || "") === "1";
}

async function upsertSourceSnapshot(key, payload, env = process.env) {
  assertSourceOnlySnapshotKey(key);
  const url = `${env.PQ_SUPABASE_URL}/rest/v1/rpc/upsert_app_snapshot`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.PQ_SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.PQ_SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_snapshot_key: key,
      p_payload: payload,
      p_sync_token: env.PQ_SUPABASE_SYNC_TOKEN,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase source snapshot sync failed for ${key}: ${response.status} ${detail}`);
  }
}

async function syncStationContextMemory(payload, env = process.env) {
  const url = `${env.PQ_SUPABASE_URL}/rest/v1/rpc/sync_station_context_memory`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: env.PQ_SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.PQ_SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_payload: payload,
      p_sync_token: env.PQ_SUPABASE_SYNC_TOKEN,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase station-context memory sync failed: ${response.status} ${detail}`);
  }
  return response.json();
}

async function syncSourceSnapshots({
  dryRun = false,
  env = process.env,
  createTruthClient = createTruthSourceIngestClient,
  upsertSource = upsertSourceSnapshot,
  syncStation = syncStationContextMemory,
} = {}) {
  const rawLoaded = new Map();
  const loaded = new Map();
  for (const [key, fileName] of SOURCE_SNAPSHOTS) {
    assertSourceOnlySnapshotKey(key);
    const raw = await readJson(fileName);
    rawLoaded.set(key, raw);
    loaded.set(key, withContentSignature(raw));
  }

  const synced = [];
  for (const [key] of SOURCE_SNAPSHOTS) {
    if (!dryRun) await upsertSource(key, loaded.get(key), env);
    synced.push(key);
  }

  const stationContextMemory = !dryRun
    ? await syncStation(loaded.get("station-context"), env)
    : null;

  const truthLedgerEnabled = truthLedgerSourceIngestEnabled(env);
  let truthLedger = {
    enabled: truthLedgerEnabled,
    status: truthLedgerEnabled ? "planned" : "disabled",
    publishesTruth: false,
    mutatesOperationalState: false,
  };
  if (truthLedgerEnabled && !dryRun) {
    const client = createTruthClient({ env });
    const receipt = await client.ingestMorningSources({
      tmsSnapshot: rawLoaded.get("tms-detail-snapshot"),
      trackingSnapshots: [
        rawLoaded.get("united-tracking-snapshot"),
        rawLoaded.get("elal-tracking-snapshot"),
        rawLoaded.get("other-tracking-snapshot"),
      ],
    });
    truthLedger = {
      enabled: true,
      status: "committed",
      ...receipt,
      publishesTruth: false,
      mutatesOperationalState: false,
    };
  }

  return {
    ok: true,
    mode: "sources-only",
    dryRun,
    synced,
    forbiddenDerivedKeys: [...FORBIDDEN_DERIVED_KEYS].sort(),
    stationContextMemory,
    truthLedger,
    syncedAt: new Date().toISOString(),
  };
}

async function main() {
  await loadDotEnvLocal();
  const dryRun = hasFlag("--dry-run");
  if (!dryRun && (!process.env.PQ_SUPABASE_URL || !process.env.PQ_SUPABASE_ANON_KEY || !process.env.PQ_SUPABASE_SYNC_TOKEN)) {
    throw new Error("Missing PQ_SUPABASE_URL, PQ_SUPABASE_ANON_KEY, or PQ_SUPABASE_SYNC_TOKEN");
  }
  const result = await syncSourceSnapshots({ dryRun });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  FORBIDDEN_DERIVED_KEYS,
  SOURCE_SNAPSHOTS,
  assertSourceOnlySnapshotKey,
  syncSourceSnapshots,
  truthLedgerSourceIngestEnabled,
  _test: {
    assertSourceOnlySnapshotKey,
  },
};

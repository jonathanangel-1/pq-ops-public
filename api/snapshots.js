"use strict";

const {
  loadAppSnapshotMetadataRows,
  loadAppSnapshotRows,
  sendJson,
} = require("../lib/supabase-agent");

const ALLOWED_SNAPSHOT_KEYS = new Set([
  "shipment-truth-packets",
  "outbox-requests",
  "email-sync-requests",
  "money-sync-requests",
  "gmail-proof-snapshot",
  "money-memory",
  "tms-detail-snapshot",
  "tms-grid-snapshot",
  "united-tracking-snapshot",
  "elal-tracking-snapshot",
  "other-tracking-snapshot",
]);

const DEFAULT_SNAPSHOT_KEYS = [
  "shipment-truth-packets",
  "outbox-requests",
  "email-sync-requests",
  "money-sync-requests",
];

function requestKeys(request) {
  const url = new URL(request.url || "/", "http://localhost");
  const raw = url.searchParams.get("keys") || "";
  const requested = raw
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const keys = requested.length ? requested : DEFAULT_SNAPSHOT_KEYS;
  return Array.from(new Set(keys.filter((key) => ALLOWED_SNAPSHOT_KEYS.has(key)))).slice(0, 12);
}

// slim=1: strip proof-row fields the dashboard never reads (historical merge state and
// search/attachment audits) — they dominate the payload but only matter to the pipeline.
function slimRequested(request) {
  const url = new URL(request.url, "http://localhost");
  return ["1", "true", "ui"].includes(String(url.searchParams.get("slim") || "").toLowerCase());
}

function slimSnapshotPayload(key, payload) {
  if (key !== "gmail-proof-snapshot" || !payload || !Array.isArray(payload.proofs)) return payload;
  return {
    ...payload,
    slimmed: true,
    proofs: payload.proofs.map((proof) => {
      const {
        historicalProof,
        historicalEvents,
        gmailSearchAudit,
        gmailAttachmentAudit,
        ...rest
      } = proof || {};
      return {
        ...rest,
        // Coverage stays: the UI reads per-AWB coverage state, not the audit internals.
        gmailSearchAudit: gmailSearchAudit?.coverage ? { coverage: gmailSearchAudit.coverage } : undefined,
      };
    }),
  };
}

function metadataOnlyRequested(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return ["1", "true", "yes", "metadata"].includes(String(url.searchParams.get("metadata") || "").toLowerCase());
}

function snapshotMetadataByKey(rows = []) {
  return (rows || []).reduce((acc, row) => {
    if (!row?.snapshot_key || !ALLOWED_SNAPSHOT_KEYS.has(row.snapshot_key)) return acc;
    acc[row.snapshot_key] = {
      snapshotKey: row.snapshot_key,
      snapshotTime: row.snapshot_time || null,
      updatedAt: row.updated_at || null,
      writerVersion: row.writer_version || "",
      contentSignature: row.content_signature || "",
    };
    return acc;
  }, {});
}

module.exports = async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const keys = requestKeys(request);
  const timeoutMs = Number(process.env.PQ_SNAPSHOT_API_TIMEOUT_MS || 900);
  if (!keys.length) {
    sendJson(response, 400, {
      ok: false,
      error: "No allowed snapshot keys requested",
      allowedSnapshotKeys: Array.from(ALLOWED_SNAPSHOT_KEYS),
    });
    return;
  }

  const metadataOnly = metadataOnlyRequested(request);
  try {
    if (metadataOnly) {
      const rows = await loadAppSnapshotMetadataRows(keys, {
        timeoutMs,
        retryDelaysMs: [],
      });
      const metadata = snapshotMetadataByKey(rows);
      const missingKeys = keys.filter((key) => !Object.prototype.hasOwnProperty.call(metadata, key));
      sendJson(response, 200, {
        ok: true,
        source: "app_snapshots_metadata",
        metadataOnly: true,
        timeoutMs,
        snapshotTime: new Date().toISOString(),
        updatedAt: Object.values(metadata)
          .map((row) => row.updatedAt)
          .filter(Boolean)
          .sort()
          .at(-1) || null,
        metadata,
        snapshots: {},
        warnings: missingKeys.map((key) => ({
          type: "snapshot-missing",
          snapshotKey: key,
        })),
      });
      return;
    }

    const rows = await loadAppSnapshotRows(keys, {
      timeoutMs,
      retryDelaysMs: [],
    });
    const snapshots = {};
    let updatedAt = "";
    const slim = slimRequested(request);
    rows.forEach((row) => {
      if (!row?.snapshot_key || !ALLOWED_SNAPSHOT_KEYS.has(row.snapshot_key)) return;
      snapshots[row.snapshot_key] = slim ? slimSnapshotPayload(row.snapshot_key, row.payload) : row.payload;
      if (row.updated_at && (!updatedAt || row.updated_at > updatedAt)) updatedAt = row.updated_at;
    });
    const missingKeys = keys.filter((key) => !Object.prototype.hasOwnProperty.call(snapshots, key));
    sendJson(response, 200, {
      ok: true,
      source: "app_snapshots",
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      updatedAt: updatedAt || null,
      snapshots,
      warnings: missingKeys.map((key) => ({
        type: "snapshot-missing",
        snapshotKey: key,
      })),
    });
  } catch (error) {
    sendJson(response, 200, {
      ok: false,
      source: metadataOnly ? "app_snapshots_metadata" : "app_snapshots",
      status: "degraded",
      metadataOnly,
      timeoutMs,
      snapshotTime: new Date().toISOString(),
      updatedAt: null,
      snapshots: {},
      warnings: keys.map((key) => ({
        type: "snapshot-load-failed",
        snapshotKey: key,
      })),
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

module.exports._test = Object.freeze({
  metadataOnlyRequested,
  requestKeys,
});

"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://pq-ops-demo.example";
const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;
const DEFAULT_HTTP_TIMEOUT_MS = 15 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    return fallback;
  }
  return candidate;
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sameTimestamp(left, right) {
  const leftTime = timestamp(left);
  const rightTime = timestamp(right);
  return leftTime !== null && leftTime === rightTime;
}

function normalizeAwb(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function sourceExpectations(tmsSnapshot = {}) {
  const tmsSnapshotTime = String(tmsSnapshot.snapshotTime || "");
  if (timestamp(tmsSnapshotTime) === null) {
    throw new Error("The local TMS detail snapshot has no valid snapshotTime.");
  }
  const shipments = Array.isArray(tmsSnapshot.shipments) ? tmsSnapshot.shipments : [];
  const activeAwbs = [...new Set(shipments.map((row) => (
    normalizeAwb(row?.trackingNumber || row?.awb || row?.masterAwb)
  )).filter(Boolean))].sort();
  if (!activeAwbs.length) {
    throw new Error("The local TMS detail snapshot has no valid active AWB roster.");
  }
  return Object.freeze({
    tmsSnapshotTime,
    tmsActiveAwbCount: activeAwbs.length,
    tmsActiveAwbs: activeAwbs,
  });
}

function sourceGapRows(rows = []) {
  return rows.filter((row) => {
    const certification = String(row?.sourceCertification?.status || "").toLowerCase();
    const phase = String(row?.opsState?.phase || row?.reasoning?.phase || "").toLowerCase();
    const className = String(row?.reasoning?.className || "").toLowerCase();
    return certification === "source-gap" || phase === "source-gap" || className === "source-gap";
  });
}

function relationalWriter(value) {
  return String(value || "").includes("relational-truth-delivery-adapter");
}

function assessRelationalPublication({ expected, health, brain } = {}) {
  const reasons = [];
  const truth = health?.truth || {};
  const gmail = health?.gmail || {};
  const inventory = health?.tmsInventory || {};
  const embedded = inventory.embedded || {};
  const detail = inventory.snapshots?.["tms-detail-snapshot"] || {};
  const grid = inventory.snapshots?.["tms-grid-snapshot"] || {};
  const healthCertification = truth.rowCertification || {};
  const sourceHealth = brain?.sourceHealth || {};
  const brainCertification = sourceHealth.rowCertification || {};
  const brainInventory = sourceHealth.tmsInventoryFreshness || {};
  const rows = Array.isArray(brain?.shipments) ? brain.shipments : [];
  const gaps = sourceGapRows(rows);
  const gmailRefreshFreshSuccess = gmail.refreshHealth?.stale === false
    && gmail.refreshHealth?.lastRunStatus === "success";
  const gmailStateCurrent = Boolean(
    gmail.state && (gmail.state.stale === false || gmailRefreshFreshSuccess),
  );
  const gmailProofCurrent = Boolean(
    gmail.proof && (gmail.proof.stale === false || gmailRefreshFreshSuccess),
  );

  if (health?.ok !== true || health?.status !== "live") reasons.push("truth-health-not-live");
  if (health?.hostedPersistence?.ok !== true) reasons.push("hosted-persistence-not-ok");
  if (truth.stale !== false) reasons.push("canonical-truth-stale");
  if (!relationalWriter(truth.writerVersion)) reasons.push("health-writer-not-relational");
  if (healthCertification.status !== "certified"
      || Number(healthCertification.problemCount || 0) !== 0) {
    reasons.push("health-row-certification-failed");
  }
  if (Number(healthCertification.tmsActiveInventoryAwbsChecked) !== expected?.tmsActiveAwbCount) {
    reasons.push("health-tms-roster-count-mismatch");
  }
  if (!gmailStateCurrent) reasons.push("gmail-state-stale");
  if (!gmailProofCurrent) reasons.push("gmail-proof-stale");
  if (!gmailRefreshFreshSuccess) {
    reasons.push("gmail-refresh-not-fresh-success");
  }
  if (inventory.ok !== true) reasons.push("tms-inventory-not-ok");
  if (!sameTimestamp(detail.snapshotTime, expected?.tmsSnapshotTime)) {
    reasons.push("hosted-tms-detail-cut-mismatch");
  }
  if (!sameTimestamp(grid.snapshotTime, expected?.tmsSnapshotTime)) {
    reasons.push("hosted-tms-grid-cut-mismatch");
  }
  if (!sameTimestamp(embedded.snapshotTime, expected?.tmsSnapshotTime)) {
    reasons.push("packet-embedded-tms-cut-mismatch");
  }
  if (Number(embedded.activeAwbCount) !== expected?.tmsActiveAwbCount) {
    reasons.push("packet-embedded-tms-roster-count-mismatch");
  }

  if (brain?.ok !== true) reasons.push("shipment-projection-not-ok");
  if (brain?.sourceOfTruth !== "relational-truth-ledger") {
    reasons.push("shipment-projection-not-relational-ledger");
  }
  if (!relationalWriter(brain?.writerVersion)) reasons.push("projection-writer-not-relational");
  if (sourceHealth.status !== "live" || sourceHealth.degraded === true
      || sourceHealth.sourceGapRequired === true) {
    reasons.push("shipment-source-health-not-live");
  }
  if (brainCertification.status !== "certified"
      || Number(brainCertification.problemCount || 0) !== 0) {
    reasons.push("projection-row-certification-failed");
  }
  if (!sameTimestamp(brainInventory.snapshotTime, expected?.tmsSnapshotTime)
      || Number(brainInventory.activeAwbCount) !== expected?.tmsActiveAwbCount) {
    reasons.push("projection-tms-cut-mismatch");
  }
  if (!sameTimestamp(brain?.snapshotTime, truth.snapshotTime)) {
    reasons.push("health-projection-packet-cut-mismatch");
  }
  if (!rows.length) reasons.push("shipment-projection-empty");
  if (gaps.length) reasons.push("shipment-source-gap-rows");
  if ((brain?.sourceTruthWarnings || []).length || (sourceHealth.warnings || []).length) {
    reasons.push("shipment-source-warnings");
  }

  return Object.freeze({
    ok: reasons.length === 0,
    status: reasons.length === 0 ? "ready" : "pending",
    reasons: [...new Set(reasons)],
    summary: {
      expectedTmsSnapshotTime: expected?.tmsSnapshotTime || "",
      expectedTmsActiveAwbCount: expected?.tmsActiveAwbCount ?? null,
      healthStatus: health?.status || "",
      healthCheckedAt: health?.checkedAt || "",
      truthSnapshotTime: truth.snapshotTime || "",
      truthWriterVersion: truth.writerVersion || "",
      truthAgeMinutes: truth.ageMinutes ?? null,
      gmailStateSnapshotTime: gmail.state?.snapshotTime || "",
      gmailProofSnapshotTime: gmail.proof?.snapshotTime || "",
      gmailRefreshSnapshotTime: gmail.refreshHealth?.snapshotTime || "",
      hostedTmsDetailSnapshotTime: detail.snapshotTime || "",
      packetEmbeddedTmsSnapshotTime: embedded.snapshotTime || "",
      packetEmbeddedTmsActiveAwbCount: embedded.activeAwbCount ?? null,
      projectionSnapshotTime: brain?.snapshotTime || "",
      projectionWriterVersion: brain?.writerVersion || "",
      projectionSourceHealth: sourceHealth.status || "",
      shipmentCount: rows.length,
      sourceGapCount: gaps.length,
    },
  });
}

async function readBoundedJson(response, label) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds 4 MiB.`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`${label} response exceeds 4 MiB.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return parsed;
}

async function fetchProductionSurface(fetchImpl, url, label, timeoutMs) {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return readBoundedJson(response, label);
}

async function waitForRelationalMorningPublication({
  expected,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
  onAttempt = () => {},
} = {}) {
  if (!expected || timestamp(expected.tmsSnapshotTime) === null
      || !Number.isSafeInteger(expected.tmsActiveAwbCount)
      || expected.tmsActiveAwbCount < 1) {
    throw new Error("Relational morning publication wait requires exact TMS expectations.");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetchImpl must be a function.");
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const boundedTimeoutMs = boundedInteger(
    timeoutMs,
    DEFAULT_WAIT_TIMEOUT_MS,
    30_000,
    45 * 60 * 1000,
  );
  const boundedPollMs = boundedInteger(
    pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    1_000,
    60_000,
  );
  const boundedHttpMs = boundedInteger(
    httpTimeoutMs,
    DEFAULT_HTTP_TIMEOUT_MS,
    1_000,
    60_000,
  );
  const startedAtMs = Number(now());
  const deadlineAtMs = startedAtMs + boundedTimeoutMs;
  let attempts = 0;
  let lastAssessment = null;
  let lastError = "";

  while (Number(now()) <= deadlineAtMs) {
    attempts += 1;
    const cacheBust = Number(now());
    try {
      const [health, brain] = await Promise.all([
        fetchProductionSurface(
          fetchImpl,
          `${root}/api/truth/health?diagnostic=1&ts=${cacheBust}`,
          "production truth health",
          boundedHttpMs,
        ),
        fetchProductionSurface(
          fetchImpl,
          `${root}/api/brain/shipments?ts=${cacheBust}`,
          "production shipment projection",
          boundedHttpMs,
        ),
      ]);
      lastAssessment = assessRelationalPublication({ expected, health, brain });
      lastError = "";
      onAttempt({ attempt: attempts, assessment: lastAssessment });
      if (lastAssessment.ok) {
        return {
          ok: true,
          status: "published",
          source: "morning-relational-publication-readback-v1",
          mutatesState: false,
          attempts,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date(Number(now())).toISOString(),
          assessment: lastAssessment,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      onAttempt({ attempt: attempts, error: lastError });
    }
    const remainingMs = deadlineAtMs - Number(now());
    if (remainingMs <= 0) break;
    await sleep(Math.min(boundedPollMs, remainingMs));
  }

  const error = new Error("Timed out waiting for the exact relational morning publication.");
  error.code = "MORNING_RELATIONAL_PUBLICATION_TIMEOUT";
  error.receipt = {
    ok: false,
    status: "timeout",
    source: "morning-relational-publication-readback-v1",
    mutatesState: false,
    attempts,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(Number(now())).toISOString(),
    lastError,
    assessment: lastAssessment,
  };
  throw error;
}

async function loadLocalTmsExpectations(rootDir = ROOT_DIR) {
  const payload = JSON.parse(
    await fs.readFile(path.join(rootDir, "tms-detail-snapshot.json"), "utf8"),
  );
  return sourceExpectations(payload);
}

module.exports = Object.freeze({
  DEFAULT_BASE_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  assessRelationalPublication,
  loadLocalTmsExpectations,
  sourceExpectations,
  waitForRelationalMorningPublication,
  _test: Object.freeze({
    boundedInteger,
    fetchProductionSurface,
    normalizeAwb,
    relationalWriter,
    sameTimestamp,
    sourceGapRows,
  }),
});

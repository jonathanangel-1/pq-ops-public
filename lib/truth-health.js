"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { gmailDirectEnv } = require("./gmail-direct-ingest");
const { deriveSyncRequestState } = require("./sync-observability");
const { terminalEvidenceCertification } = require("./terminal-evidence-certification");
const {
  loadAppSnapshotMetadataRows,
  loadAppSnapshotRows,
  supabaseReadCircuitHealth,
} = require("./supabase-agent");

const ROOT_DIR = path.resolve(__dirname, "..");
const HEALTH_SNAPSHOT_KEYS = [
  "shipment-truth-packets",
  "active-awb-index",
  "tms-detail-snapshot",
  "tms-grid-snapshot",
  "gmail-direct-state",
  "gmail-proof-snapshot",
  "gmail-refresh-health",
];
const REQUIRED_TMS_INVENTORY_KEYS = ["tms-detail-snapshot", "tms-grid-snapshot"];
const DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES = 24 * 60;

function numberFromEnv(env, key, fallback, min = 0) {
  const value = Number(env[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function ageMs(timestamp, now = new Date()) {
  const parsed = Date.parse(timestamp || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now.getTime() - parsed);
}

function ageMinutes(timestamp, now = new Date()) {
  const age = ageMs(timestamp, now);
  return age === null ? null : Math.round(age / 60000);
}

function stale(timestamp, maxAgeMinutes, now = new Date()) {
  const age = ageMinutes(timestamp, now);
  return age === null ? true : age > maxAgeMinutes;
}

async function readLocalTruthPackets(rootDir = ROOT_DIR) {
  try {
    return JSON.parse(await fs.readFile(path.join(rootDir, "shipment-truth-packets.json"), "utf8"));
  } catch {
    return null;
  }
}

// Latest email-sync request record: hosted snapshot first, local file second,
// null when neither exists. Absence is fine — deriveSyncRequestState then
// reports from the refresh-run health alone.
async function latestSyncRequestRecord(rootDir = ROOT_DIR, { timeoutMs } = {}) {
  let payload = null;
  try {
    const rows = await loadAppSnapshotRows(["email-sync-requests"], { timeoutMs, retryDelaysMs: [] });
    payload = Array.isArray(rows) ? rows[0]?.payload : null;
  } catch {
    payload = null;
  }
  if (!payload) {
    try {
      payload = JSON.parse(await fs.readFile(path.join(rootDir, "email-sync-requests.json"), "utf8"));
    } catch {
      payload = null;
    }
  }
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  const latest = requests
    .filter((request) => request?.type === "gmail-proof-refresh")
    .sort((a, b) =>
      Date.parse(b.queuedAt || b.requestedAt || b.createdAt || "") -
      Date.parse(a.queuedAt || a.requestedAt || a.createdAt || ""))[0] || null;
  if (!latest) return null;
  return {
    id: latest.id || "",
    status: latest.status || "",
    source: latest.source || "",
    queuedAt: latest.queuedAt || "",
    requestedAt: latest.requestedAt || "",
    claimedAt: latest.claimedAt || "",
    updatedAt: latest.updatedAt || "",
    completedAt: latest.completedAt || "",
    error: latest.error || "",
  };
}

function rowsByKey(rows = []) {
  const byKey = new Map();
  for (const row of rows || []) {
    if (row?.snapshot_key) byKey.set(row.snapshot_key, row);
  }
  return byKey;
}

function hostedPayloadDeadlineError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return error?.deadlineExceeded === true ||
    error?.code === "TRUTH_RUNTIME_DEADLINE_EXCEEDED" ||
    /\b(?:runtime deadline|timed out|timeout)\b/i.test(message);
}

async function loadHostedTruthPayloadRows({
  timeoutMs,
  recoveryTimeoutMs,
  loadRows = loadAppSnapshotRows,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
} = {}) {
  let lastError = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts += 1;
    try {
      const rows = await loadRows(["shipment-truth-packets"], {
        timeoutMs: attempt === 0 ? timeoutMs : recoveryTimeoutMs,
        retryDelaysMs: [],
        // A first deadline opens the shared read circuit. This one explicit,
        // bounded recovery attempt is allowed to probe past that circuit; a
        // second failure remains fail-closed and leaves the circuit open.
        useCircuitBreaker: attempt === 0,
      });
      return {
        rows,
        attempts,
        recoveryUsed: attempt > 0,
        completedTimeoutMs: attempt === 0 ? timeoutMs : recoveryTimeoutMs,
      };
    } catch (error) {
      lastError = error;
      if (attempt > 0 || !hostedPayloadDeadlineError(error)) break;
      await wait(50);
    }
  }
  const failure = lastError instanceof Error ? lastError : new Error(String(lastError || "Hosted truth payload read failed"));
  failure.payloadReadAttempts = attempts;
  failure.payloadRecoveryUsed = attempts > 1;
  throw failure;
}

function publicGmailConfig(env = process.env) {
  const cfg = gmailDirectEnv(env);
  return {
    available: Boolean(cfg.available),
    user: cfg.user || "",
    tokenSource: cfg.tokenSource || "",
    storedOAuthAvailable: Boolean(cfg.storedOAuthAvailable),
    sources: {
      clientId: cfg.clientIdSource || null,
      clientSecret: cfg.clientSecretSource || null,
      refreshToken: cfg.refreshTokenSource || null,
    },
    missing: [
      cfg.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
      cfg.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
      cfg.refreshToken || cfg.storedOAuthAvailable ? "" : "GMAIL_REFRESH_TOKEN or stored Gmail OAuth connection",
    ].filter(Boolean),
  };
}

function freshnessStatus(payload, updatedAt, maxAgeMinutes, now) {
  const snapshotTime = payload?.snapshotTime || updatedAt || null;
  return {
    snapshotTime,
    updatedAt: updatedAt || null,
    ageMinutes: ageMinutes(snapshotTime, now),
    stale: stale(snapshotTime, maxAgeMinutes, now),
    writerVersion: payload?.writerVersion || "",
  };
}

// Quiet cron cycles skip the unchanged truth-packet write, freezing snapshotTime and
// the sidecar's updated_at. Each successful run stamps the verified truth signature
// into refresh-health writer_version (+truthsig-<prefix>); when that marker matches
// the stored truth signature, the run time certifies freshness without a rewrite.
function verifiedTruthFreshness({ refreshHealthRow, storedTruthSignature, truthSnapshotTime }) {
  const writerVersion = String(refreshHealthRow?.writer_version || refreshHealthRow?.writerVersion || "");
  const marker = (writerVersion.match(/\+truthsig-([a-f0-9]{6,64})/) || [])[1] || "";
  const stored = String(storedTruthSignature || "");
  const verifiedAt = marker &&
    stored.startsWith(marker) &&
    writerVersion.includes("+status-success")
    ? refreshHealthRow?.snapshot_time || refreshHealthRow?.snapshotTime || refreshHealthRow?.updated_at || null
    : null;
  const freshAt = [truthSnapshotTime, verifiedAt].filter(Boolean).sort().pop() || truthSnapshotTime || null;
  return { verifiedAt, freshAt };
}

function metadataFreshnessStatus(row, maxAgeMinutes, now) {
  return freshnessStatus({
    snapshotTime: row?.snapshot_time || row?.snapshotTime || "",
    writerVersion: row?.writer_version || row?.writerVersion || "",
  }, row?.updated_at || row?.updatedAt || null, maxAgeMinutes, now);
}

function embeddedTmsInventoryHealth(snapshot = {}, maxAgeMinutes, now) {
  const awbs = tmsActiveInventoryAwbs(snapshot);
  const snapshotTime = snapshot.sourceAudit?.tmsSnapshotTime || snapshot.tmsSnapshotTime || "";
  if (!awbs.length || !snapshotTime) return null;
  return {
    snapshotTime,
    updatedAt: snapshot.snapshotTime || null,
    ageMinutes: ageMinutes(snapshotTime, now),
    stale: stale(snapshotTime, maxAgeMinutes, now),
    writerVersion: snapshot.writerVersion || "shipment-truth-packets-sourceAudit",
    activeAwbCount: awbs.length,
    source: "shipment-truth-packets.sourceAudit",
  };
}

function tmsInventoryHealth(metadataByKey, maxAgeMinutes, now, truthSnapshot = {}) {
  const snapshots = Object.fromEntries(REQUIRED_TMS_INVENTORY_KEYS.map((key) => {
    const row = metadataByKey.get(key);
    return [key, row ? metadataFreshnessStatus(row, maxAgeMinutes, now) : null];
  }));
  const missingKeys = REQUIRED_TMS_INVENTORY_KEYS.filter((key) => !metadataByKey.has(key));
  const staleKeys = REQUIRED_TMS_INVENTORY_KEYS.filter((key) => snapshots[key]?.stale);
  const embedded = embeddedTmsInventoryHealth(truthSnapshot, maxAgeMinutes, now);
  const embeddedOk = Boolean(embedded && !embedded.stale);
  const metadataOk = missingKeys.length === 0 && staleKeys.length === 0;
  return {
    ok: metadataOk || embeddedOk,
    requiredKeys: REQUIRED_TMS_INVENTORY_KEYS,
    missingKeys,
    staleKeys,
    snapshots,
    embedded,
    maxAgeMinutes,
    fallbackSource: !metadataOk && embeddedOk ? "shipment-truth-packets.sourceAudit" : "",
  };
}

function truthHealthOperatorGuidance({
  live = false,
  emergencyBundledFresh = false,
  hostedMetadataOk = false,
  tmsInventory = {},
  rowCertification = {},
} = {}) {
  if (live) return "Shipment truth is live from hosted Gmail/Supabase evidence.";
  if (emergencyBundledFresh) {
    return "Hosted persistence is degraded, but the bundled canonical packet is fresh and row-certified for emergency operator use. Refresh hosted Gmail/Supabase as soon as persistence recovers.";
  }
  if (hostedMetadataOk && !tmsInventory.ok) {
    return "Treat shipment truth as source-gapped until hosted TMS active inventory snapshots are published and fresh.";
  }
  if (rowCertification.problemCount) {
    return "Treat rows with Gmail coverage problems as source-gapped until the newest per-AWB Gmail messages are reduced into canonical truth.";
  }
  return "Treat email-owned shipment states as source-gapped until Gmail refresh and hosted snapshot persistence are healthy.";
}

function normalizeAwb(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function activeTruthRows(snapshot = {}) {
  const activeAwbs = new Set((snapshot.activeAwbs || []).map(normalizeAwb).filter(Boolean));
  return (snapshot.shipments || []).filter((row) => {
    const awb = normalizeAwb(row?.awb || row?.trackingNumber || row?.id || row?.shipmentId);
    if (!awb) return false;
    const role = String(row?.truthPacketRole || "active").toLowerCase();
    if (role === "completed" || row?.completed) return false;
    return activeAwbs.size ? activeAwbs.has(awb) : role === "active";
  });
}

function displayAwb(awb = "") {
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb;
}

function tmsActiveInventoryAwbs(snapshot = {}) {
  const auditAwbs = snapshot.sourceAudit?.tmsActiveAwbs || snapshot.tmsActiveAwbs || [];
  return [...new Set((Array.isArray(auditAwbs) ? auditAwbs : [])
    .map(normalizeAwb)
    .filter(Boolean))].sort();
}

function statusResolved(status = "") {
  return ["done", "true", "delivered", "received", "found", "pod-found", "picked-up", "picked up", "loaded", "recovered"].includes(String(status || "").toLowerCase().replace(/_/g, "-"));
}

function truthRowGate(row = {}, name = "") {
  return gateFromMap(row.gates, name) ||
    gateFromMap(row.opsState?.gates, name) ||
    gateFromMap(row.truthPacket?.gates, name) ||
    null;
}

function rowHasTerminalExternalEvidence(row = {}) {
  return terminalEvidenceCertification(row).certified === true;
}

function tmsActiveMembershipProblems(snapshot = {}, activeRows = []) {
  const activeAwbs = new Set([
    ...(snapshot.activeAwbs || []),
    ...activeRows.map((row) => row?.awb || row?.trackingNumber || row?.id || row?.shipmentId),
  ].map(normalizeAwb).filter(Boolean));
  const rowByAwb = new Map((snapshot.shipments || [])
    .map((row) => [normalizeAwb(row?.awb || row?.trackingNumber || row?.id || row?.shipmentId), row])
    .filter(([awb]) => awb));
  const terminalAwbs = new Set([...rowByAwb.entries()]
    .filter(([, row]) => rowHasTerminalExternalEvidence(row))
    .map(([awb]) => awb));
  return tmsActiveInventoryAwbs(snapshot)
    .filter((awb) => !activeAwbs.has(awb) && !terminalAwbs.has(awb))
    .map((awb) => {
      const terminalCertification = terminalEvidenceCertification(rowByAwb.get(awb) || {});
      const hasUncertifiedTerminalRow = terminalCertification.status === "uncertified";
      return {
        awb,
        displayAwb: displayAwb(awb),
        phase: hasUncertifiedTerminalRow ? "terminal-evidence-uncertified" : "missing-from-active-truth",
        code: hasUncertifiedTerminalRow ? "tms-active-terminal-evidence-uncertified" : "tms-active-missing-from-truth",
        reason: hasUncertifiedTerminalRow
          ? `CourierCloud/TMS active inventory still contains this AWB, and the completed packet lacks certified terminal proof: ${terminalCertification.reason}`
          : "CourierCloud/TMS active inventory contains this AWB, but shipment-truth-packets activeAwbs does not.",
        coverageStatus: "",
        latestReadMessageAt: "",
        latestProofMessageAt: "",
        terminalEvidence: terminalCertification,
      };
    });
}

function rowFreshness(row = {}) {
  return {
    ...(row.truthPacket?.freshness || {}),
    ...(row.evidencePacket?.freshness || {}),
  };
}

function rowGmailCoverage(row = {}) {
  const freshness = rowFreshness(row);
  const staleSources = [
    ...(Array.isArray(row.truthPacket?.freshness?.staleSources) ? row.truthPacket.freshness.staleSources : []),
    ...(Array.isArray(row.evidencePacket?.freshness?.staleSources) ? row.evidencePacket.freshness.staleSources : []),
  ].map((source) => String(source || "").toLowerCase());
  const coverage = row.gmailCoverage || {};
  const relationalAuthority = String(row.canonicalAuthority?.source || "") === "relational-truth-ledger";
  const relationalReceipt = row.sourceCoverage?.relationalCoverage || {};
  const relationalReceiptValid = relationalAuthority &&
    relationalReceipt.schemaVersion === "relational-row-source-coverage-v1" &&
    String(relationalReceipt.sourceCutId || "") !== "" &&
    String(relationalReceipt.sourceCutId || "") === String(row.canonicalAuthority?.sourceCutId || "") &&
    String(relationalReceipt.sourceCutId || "") === String(coverage.sourceCutId || "") &&
    relationalReceipt.processingWatermarkStatus === "watermarked" &&
    /^[0-9a-f]{64}$/.test(String(relationalReceipt.processingWatermarkHash || "")) &&
    Number(relationalReceipt.acceptedClaimCount) === Number(row.sourceCoverage?.acceptedClaimCount || 0);
  const status = coverage.status || freshness.gmailCoverageStatus || "";
  const latestReadMessageAt = coverage.latestReadMessageAt || freshness.gmailLatestReadMessageAt || "";
  const latestProofMessageAt = coverage.latestProofMessageAt || freshness.gmailLatestProofMessageAt || "";
  const readTime = Date.parse(latestReadMessageAt || "");
  const proofTime = Date.parse(latestProofMessageAt || "");
  const covered = ["covered", "manual-reviewed"].includes(String(status || "").toLowerCase());
  const proofCoversRead = covered &&
    (!Number.isFinite(readTime) || !Number.isFinite(proofTime) || proofTime >= readTime);
  const problem = Boolean(
    coverage.problem ||
      freshness.gmailCoverageProblem ||
      (relationalAuthority && !relationalReceiptValid) ||
      (staleSources.includes("gmail") && !proofCoversRead)
  );
  const manualTruthSyncedAt = freshness.manualTruthSyncedAt || "";
  const manualReviewSyncedAt = freshness.manualReviewSyncedAt || "";
  const hasCoverageStamp = relationalAuthority
    ? relationalReceiptValid && ["covered", "relational-cut-covered"].includes(String(status || "").toLowerCase())
    : Boolean(status || manualTruthSyncedAt || manualReviewSyncedAt);
  const hasGmailEvidence = Boolean(
    freshness.hasGmailEvidence ||
      (row.evidencePacket?.sourceFacts || []).some((fact) =>
        ["gmail", "gmail_attachment", "gmail_parsed_message", "direct_document_or_pod", "manual-gmail-truth"].includes(String(fact?.sourceSystem || fact?.sourceClass || fact?.sourceRef?.source || "").toLowerCase())
      )
  );
  return {
    status,
    problem,
    reason: coverage.reason || freshness.gmailCoverageReason || "",
    latestReadMessageAt,
    latestProofMessageAt,
    manualTruthSyncedAt,
    manualReviewSyncedAt,
    hasCoverageStamp,
    hasGmailEvidence,
  };
}

function phaseDependsOnEmailTruth(phase = "") {
  return [
    "approval-needed",
    "broker-awarded",
    "broker-alerted",
    "customs-hold",
    "delivery-blocked",
    "delivered-pod-pending",
    "dispatch-ready",
    "fees-needed",
    "pickup-blocked",
    "pickup-docs-needed",
    "pickup-location-requested",
    "pickup-scheduled",
    "pod-needed",
    "ready-for-pickup",
    "release-needed",
  ].includes(String(phase || "").toLowerCase().replace(/_/g, "-"));
}

function rowPhase(row = {}) {
  return String(
    row.opsState?.phase ||
      row.stage ||
      row.phase ||
      row.truthPacket?.currentState ||
      "",
  ).toLowerCase().replace(/_/g, "-");
}

function gateStatusFromMap(gates = {}, name = "") {
  if (!gates) return "";
  if (Array.isArray(gates)) {
    const gate = gates.find((item) => String(item?.gate || item?.name || "").toLowerCase() === name);
    return String(gate?.rawStatus || gate?.status || "").toLowerCase().replace(/_/g, "-");
  }
  return String(gates?.[name]?.status || gates?.[name]?.rawStatus || "").toLowerCase().replace(/_/g, "-");
}

function gateFromMap(gates = {}, name = "") {
  if (!gates) return null;
  if (Array.isArray(gates)) return gates.find((item) => String(item?.gate || item?.name || "").toLowerCase() === name) || null;
  return gates?.[name] || null;
}

function gateText(gate = {}) {
  return [
    gate?.status,
    gate?.rawStatus,
    gate?.reason,
    gate?.evidence,
    gate?.summary,
    gate?.label,
  ].filter(Boolean).join(" ");
}

function gateResolved(status = "") {
  return ["done", "true", "released", "cleared", "paid", "received", "found"].includes(String(status || "").toLowerCase());
}

function gateBlocked(status = "") {
  return ["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem"].includes(String(status || "").toLowerCase());
}

function customsHoldBlockerText(value = "") {
  return /\b(?:customs[-\s]?hold|government hold|exam[-\s]?hold|cbp hold|fda hold|u\.?s\.? customs hold|inbond[^.;\n]{0,80}(?:rejected|reject|not accepted)|customs entry[^.;\n]{0,80}(?:rejected|reject|not accepted)|(?:rejected|reject)[^.;\n]{0,80}arrive\s+it|pickup is blocked by customs hold|blocked by customs hold|customs hold\/exam)\b/i.test(String(value || ""));
}

function sourceFactsForCertification(row = {}) {
  const rows = [
    ...(row.facts || []),
    ...(row.factLedger || []),
    ...(row.emailValidation?.events || []),
    ...(row.emailValidation?.proof || []),
    ...(row.evidencePacket?.sourceFacts || []),
    ...(row.opsState?.events || []),
    ...(row.opsState?.exceptions || []),
    ...(row.statusAudit?.evidence || []),
  ].filter(Boolean);
  const seen = new Set();
  return rows.filter((fact) => {
    const key = JSON.stringify({
      type: fact?.type || "",
      claim: fact?.claim || fact?.summary || "",
      observedAt: fact?.observedAt || fact?.at || fact?.capturedAt || "",
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function certificationFactText(fact = {}) {
  return [
    fact?.type,
    fact?.source,
    fact?.sourceSystem,
    fact?.label,
    fact?.claim,
    fact?.summary,
    fact?.evidence,
    fact?.rawSnippet,
  ].filter(Boolean).join(" ");
}

function certificationFactTimeMs(fact = {}) {
  const parsed = Date.parse(fact?.observedAt || fact?.capturedAt || fact?.at || fact?.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function generatedArrivalFact(fact = {}) {
  return /\b(?:canonical[-_\s]?arrival|state[-_\s]?arrival|shipment-state|canonical-shipment-pipeline|active\/tms status says arrived)\b/i.test(certificationFactText(fact));
}

// Source-fact types that represent an arrival-or-later lifecycle milestone grounded in
// EXTERNAL evidence — each one physically requires the freight to have arrived at
// destination before it can occur (a carrier/tracking arrival, a carrier airport
// pickup, an external customs release, or a delivery), so they certify the arrival gate
// even when an older in-transit line still lingers earlier in the same email thread.
//
// Intentionally EXCLUDED and left to text analysis so they cannot falsely certify a
// still-in-transit shipment:
//   - `station-arrival-confirmed` / `arrival-notice-received`: these are the pipeline's
//     OWN arrival-classification echo (see operator-truth-packet.positiveArrivalSourceFact,
//     2026-07-06 / 016-80000165). Trusting them by type lets a healed false arrival
//     resurrect from the previous cycle's own facts forever, and in practice
//     `station_arrival_confirmed` is sometimes derived from a "waiting for confirmation
//     of arrival" email that is actually arrival-pending.
//   - `ground_fees_paid` / `broker-alerted`: an inbound/ISC notice can precede arrival.
const POST_ARRIVAL_LIFECYCLE_FACT_TYPES = new Set([
  "carrier-arrival-confirmed",
  "carrier-airport-pickup-confirmed",
  "customs-released",
  "delivered-pod-received",
  "delivered-pod-missing",
]);

function relationalFactCertifiesArrival(fact = {}) {
  const type = String(fact?.type || "").toLowerCase().replace(/_/g, "-");
  const status = String(fact?.claim || "").split(":").slice(1).join(":").trim().toLowerCase().replace(/_/g, "-");
  const allowed = {
    "arrival-confirmed": new Set(["arrived", "on-hand", "available"]),
    "pickup-completed": new Set(["picked-up", "recovered", "loaded"]),
    "delivery-completed": new Set(["delivered", "completed"]),
    "pod-received": new Set(["received", "attached", "provided"]),
  };
  return Boolean(allowed[type]?.has(status));
}

function factCertifiesArrival(fact = {}) {
  if (generatedArrivalFact(fact)) return false;
  if (relationalFactCertifiesArrival(fact)) return true;
  const text = certificationFactText(fact);
  const code = tmsCertificationCode(text);
  if (code > 0) return code >= 280;
  const type = String(fact?.type || "").toLowerCase().replace(/_/g, "-");
  if (POST_ARRIVAL_LIFECYCLE_FACT_TYPES.has(type)) return true;
  return positiveArrivalCertificationText(text);
}

function unparsedAttachmentAvailabilityText(text = "") {
  return /\b(?:attachment metadata|pdf text|file text|attachment text|document text)[^.;\n]{0,120}\bnot available\b/i.test(String(text || ""));
}

function factContradictsArrival(fact = {}) {
  if (factCertifiesArrival(fact)) return false;
  const text = certificationFactText(fact);
  if (unparsedAttachmentAvailabilityText(text)) return false;
  return negativeArrivalCertificationText(text);
}

function positiveArrivalCertificationText(text = "") {
  return /\b(?:280[-\s]?ARR@DEST|arrived?\s+at\s+dest|shipment (?:has )?arrived|has arrived|arrival date|notice of arrival attached|freight (?:is )?on[-\s]?hand|cargo (?:is )?on[-\s]?hand|available for pickup|ready for pickup|at (?:the )?(?:terminal|station|warehouse))\b/i.test(String(text || "")) &&
    !negativeArrivalCertificationText(text);
}

function negativeArrivalCertificationText(text = "") {
  return /\b(?:not[-\s]?arrived|not at destination|no arrival|arrival pending|pending arrival|scheduled arrival|future arrival|eta only|destination arrival is not proven|not in (?:our|the|their) system|not yet in (?:our|the|their) system|not on[-\s]?hand|not available|cargo not on[-\s]?hand|freight not on[-\s]?hand|at origin|still at origin|in[-\s]?transit|in transit to [A-Z]{3}|275[-\s]?CONF ONBOAR|conf(?:irmed)?\s+on\s+board|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d]))\b/i.test(String(text || ""));
}

function latestCertificationFact(facts = [], predicate = () => false) {
  return [...facts]
    .filter(predicate)
    .sort((a, b) => certificationFactTimeMs(b) - certificationFactTimeMs(a))[0] || null;
}

function tmsCertificationText(row = {}) {
  return [
    row.tms?.status,
    row.tms?.tmsStatus,
    row.tms?.statusDescription,
    row.tms?.nextTask,
    row.tmsStatus,
    row.status,
    row.statusDescription,
    row.nextTask,
    row.flightDetails?.recoveryHint,
    row.flightDetails?.etaHint,
  ].filter(Boolean).join(" ");
}

function tmsCertificationCode(text = "") {
  const match = String(text || "").match(/\b(\d{3})(?=\s*[-/A-Z@])/i);
  const code = match ? Number(match[1]) : 0;
  return Number.isFinite(code) ? code : 0;
}

function tmsCertifiesArrival(row = {}) {
  const text = tmsCertificationText(row);
  const code = tmsCertificationCode(text);
  return code >= 280 ||
    /\b(?:arr\s*@\s*dest|arrived?\s+at\s+dest|available|on[-\s]?hand|ready\s*for\s*pickup)\b/i.test(text);
}

function tmsContradictsCertifiedArrival(row = {}) {
  const text = tmsCertificationText(row);
  if (!text || tmsCertifiesArrival(row)) return false;
  const code = tmsCertificationCode(text);
  return (code > 0 && code < 280) ||
    /\b(?:conf\s*onboar|conf(?:irmed)?\s+on\s+board|in[-\s]?transit|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d]))\b/i.test(text);
}

function rowClaimsArrived(row = {}, opsArrival = "", truthArrival = "") {
  const physicalLifecycle = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase().replace(/_/g, "-");
  return gateResolved(opsArrival) ||
    gateResolved(truthArrival) ||
    /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(String(row.arrivalStatus || "")) ||
    physicalLifecycle === "arrived";
}

function arrivalCoherenceProblemForRow(row = {}, opsArrival = "", truthArrival = "") {
  if (!rowClaimsArrived(row, opsArrival, truthArrival)) return null;
  const facts = sourceFactsForCertification(row);
  const positive = latestCertificationFact(
    facts,
    factCertifiesArrival,
  );
  const negative = latestCertificationFact(
    facts,
    factContradictsArrival,
  );
  const positiveAt = certificationFactTimeMs(positive);
  const negativeAt = certificationFactTimeMs(negative);
  if (negative && (!positive || !positiveAt || !negativeAt || negativeAt >= positiveAt)) {
    return {
      code: "arrival-gate-conflict",
      reason: "Arrival is marked complete, but current source evidence says destination arrival is not proven or freight is still in transit.",
    };
  }
  if (tmsContradictsCertifiedArrival(row) && !positive) {
    return {
      code: "arrival-gate-conflict",
      reason: "Arrival is marked complete, but current TMS status is still pre-arrival/in-transit.",
    };
  }
  return null;
}

function structuralTruthProblemForRow(row = {}) {
  const phase = rowPhase(row);
  const coherenceContradictions = Array.isArray(row.truthPacket?.contradictions)
    ? row.truthPacket.contradictions.filter((item) => {
        const id = String(item?.id || "").toLowerCase();
        const dimension = String(item?.dimension || "").toLowerCase();
        const severity = String(item?.severity || "").toLowerCase();
        if (/:(?:pickup-with-delivery-unknown|delivery-wait-)/.test(id)) return false;
        if (["monitor_delivery", "ask_broker"].includes(String(item?.resolutionAction || "").toLowerCase())) return false;
        return severity === "critical" ||
          ["state", "fees", "customs"].includes(dimension) ||
          /:(?:arrival-source-conflict|customs-contested-onsite|state-family-split|fees-gate-vs-ledger)$/.test(id);
      })
    : [];
  const topCustoms = gateStatusFromMap(row.gates, "customs");
  const opsArrival = gateStatusFromMap(row.opsState?.gates, "arrival");
  const truthArrival = gateStatusFromMap(row.truthPacket?.gates, "arrival");
  const opsCustoms = gateStatusFromMap(row.opsState?.gates, "customs");
  const truthCustoms = gateStatusFromMap(row.truthPacket?.gates, "customs");
  const topPickup = gateStatusFromMap(row.gates, "pickup");
  const opsPickup = gateStatusFromMap(row.opsState?.gates, "pickup");
  const truthPickup = gateStatusFromMap(row.truthPacket?.gates, "pickup");
  const topPickupGate = gateFromMap(row.gates, "pickup");
  const opsPickupGate = gateFromMap(row.opsState?.gates, "pickup");
  const truthPickupGate = gateFromMap(row.truthPacket?.gates, "pickup");
  const truthState = String(row.truthPacket?.currentState || "").toLowerCase().replace(/_/g, "-");
  const physicalLifecycle = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase().replace(/_/g, "-");
  const blockerType = String(row.truthPacket?.operationalBlocker?.type || "").toLowerCase().replace(/_/g, "-");
  if (coherenceContradictions.length) {
    const contradictionIds = [...new Set(coherenceContradictions
      .map((item) => String(item?.id || "").trim())
      .filter(Boolean))];
    return {
      code: "internal-truth-conflict",
      reason: `Canonical truth packet contains ${coherenceContradictions.length} unresolved coherence conflict(s)${contradictionIds.length ? `: ${contradictionIds.join(", ")}` : "."}`,
      contradictionIds,
    };
  }
  const negativePickupEvidence = /\b(?:not|no|without|pending|waiting|still|unconfirmed|not confirmed|not proven|not complete|not completed|not done|needed|need|needs|collect|get|verify|confirm)\b[^.;\n]{0,120}\b(?:picked up|pickup|pick[-\s]?up|loaded|loading proof|loaded proof|pickup proof|proof\/pod|pod)\b/i;
  const pickupEvidenceText = `${opsPickupGate?.evidence || ""} ${opsPickupGate?.summary || ""} ${opsPickupGate?.reason || ""} ${truthPickupGate?.reason || ""}`;
  const arrivalProblem = arrivalCoherenceProblemForRow(row, opsArrival, truthArrival);
  if (arrivalProblem) return arrivalProblem;
  if (
    [opsPickup, truthPickup].some((status) => ["done", "true", "picked-up", "picked up", "loaded", "recovered"].includes(status)) &&
    negativePickupEvidence.test(pickupEvidenceText)
  ) {
    return {
      code: "internal-truth-conflict",
      reason: "Pickup gate is marked complete, but its own source evidence says pickup is not proven or not picked up.",
    };
  }
  if (
    ["picked-up", "picked up"].includes(truthState) &&
    !["done", "true", "picked-up", "picked up", "loaded", "recovered"].includes(opsPickup)
  ) {
    return {
      code: "internal-truth-conflict",
      reason: "truthPacket says picked up, but the canonical ops pickup gate is not complete.",
    };
  }
  if (
    ["not-arrived", "not arrived", "waiting", "pending"].includes(opsArrival) &&
    physicalLifecycle === "arrived"
  ) {
    return {
      code: "internal-truth-conflict",
      reason: "truthPacket physical lifecycle says arrived, but the canonical ops arrival gate says destination arrival is not proven.",
    };
  }
  if (
    gateResolved(opsCustoms) &&
    (
      gateBlocked(truthCustoms) ||
      truthState === "customs-hold" ||
      blockerType === "customs-hold"
    )
  ) {
    return {
      code: "internal-truth-conflict",
      reason: "Canonical opsState marks customs released/done, but truthPacket reopens a customs hold.",
    };
  }
  const customsResolved = [topCustoms, opsCustoms, truthCustoms].some((status) => gateResolved(status));
  const customsBlocked = [topCustoms, opsCustoms, truthCustoms].some((status) => gateBlocked(status));
  const brokerCustomsText = [
    row.customsBroker?.status,
    row.customsBroker?.brokerStatus,
    row.customsBroker?.nextAction,
    row.metadata?.customsBroker?.status,
    row.metadata?.customsBroker?.brokerStatus,
    row.metadata?.customsBroker?.nextAction,
  ].filter(Boolean).join(" ");
  if (customsResolved && !customsBlocked && customsHoldBlockerText(brokerCustomsText)) {
    return {
      code: "internal-truth-conflict",
      reason: "Customs is marked released/done, but broker projection still cites customs hold as the active blocker.",
    };
  }
  const pickupBlocked = [topPickup, opsPickup, truthPickup].some((status) => gateBlocked(status));
  const pickupBlockerText = [
    gateText(topPickupGate),
    gateText(opsPickupGate),
    gateText(truthPickupGate),
    row.truthPacket?.operationalBlocker?.type,
    row.truthPacket?.operationalBlocker?.label,
    row.truthPacket?.operationalBlocker?.reason,
    row.operationalBlocker?.type,
    row.operationalBlocker?.label,
    row.operationalBlocker?.reason,
  ].filter(Boolean).join(" ");
  if (customsResolved && !customsBlocked && pickupBlocked && customsHoldBlockerText(pickupBlockerText)) {
    return {
      code: "internal-truth-conflict",
      reason: "Customs is marked released/done, but pickup remains blocked by stale customs hold/exam wording.",
    };
  }
  if (/ready-for-pickup|broker-alerted|broker-awarded|pickup-scheduled|pickup-onsite|picked-up|pod-needed|delivered/.test(phase) && truthState === "customs-hold") {
    return {
      code: "internal-truth-conflict",
      reason: "Canonical phase has moved past release, but truthPacket currentState still says customs_hold.",
    };
  }
  return null;
}

function certificationProblemForRow(row = {}) {
  const coverage = rowGmailCoverage(row);
  const phase = rowPhase(row);
  const structuralProblem = structuralTruthProblemForRow(row);
  const terminalCertification = row.terminalEvidenceCertification || row._terminalEvidenceCertification || null;
  if (terminalCertification?.status === "uncertified") {
    return {
      code: "terminal-evidence-uncertified",
      reason: terminalCertification.reason || "Terminal delivery/POD evidence is not certified.",
      coverage,
      terminalEvidence: terminalCertification,
    };
  }
  if (structuralProblem) {
    return {
      ...structuralProblem,
      coverage,
    };
  }
  if (!coverage.hasCoverageStamp) {
    return {
      code: "missing-gmail-coverage",
      reason: "No per-AWB newest-Gmail coverage audit is attached to this active truth packet.",
      coverage,
    };
  }
  if (coverage.problem) {
    return {
      code: "gmail-coverage-problem",
      reason: coverage.reason || "Gmail evidence is stale or incomplete for this active truth packet.",
      coverage,
    };
  }
  if (phaseDependsOnEmailTruth(phase) && !coverage.hasGmailEvidence) {
    return {
      code: "missing-gmail-source-fact",
      reason: "The active phase depends on email truth, but no durable Gmail source fact is attached.",
      coverage,
    };
  }
  return null;
}

function buildRowCertification(snapshot = {}) {
  const activeRows = activeTruthRows(snapshot);
  const rowProblems = activeRows
    .map((row) => {
      const awb = normalizeAwb(row?.awb || row?.trackingNumber || row?.id || row?.shipmentId);
      const problem = certificationProblemForRow(row);
      if (!problem) return null;
      return {
        awb,
        displayAwb: displayAwb(awb),
        phase: rowPhase(row),
        code: problem.code,
        reason: problem.reason,
        coverageStatus: problem.coverage.status,
        latestReadMessageAt: problem.coverage.latestReadMessageAt,
        latestProofMessageAt: problem.coverage.latestProofMessageAt,
        terminalEvidence: problem.terminalEvidence || null,
        contradictionIds: problem.contradictionIds || [],
      };
    })
    .filter(Boolean);
  const membershipProblems = tmsActiveMembershipProblems(snapshot, activeRows);
  const problems = [...membershipProblems, ...rowProblems];
  const tmsActiveInventoryAwbsChecked = tmsActiveInventoryAwbs(snapshot).length;
  return {
    status: problems.length ? "degraded" : "certified",
    activeRowsChecked: activeRows.length,
    tmsActiveInventoryAwbsChecked,
    certifiedActiveRows: Math.max(0, activeRows.length - rowProblems.length),
    problemCount: problems.length,
    problems,
    problemAwbs: problems.map((problem) => problem.displayAwb || problem.awb),
  };
}

async function buildTruthHealth(options = {}) {
  const env = options.env || process.env;
  const now = options.now instanceof Date ? options.now : new Date();
  const rootDir = options.rootDir || ROOT_DIR;
  const timeoutMs = numberFromEnv(env, "PQ_TRUTH_HEALTH_SUPABASE_TIMEOUT_MS", 900, 100);
  const recoveryTimeoutMs = numberFromEnv(
    env,
    "PQ_TRUTH_HEALTH_SUPABASE_RECOVERY_TIMEOUT_MS",
    Math.max(1800, timeoutMs * 2),
    timeoutMs,
  );
  // The DEPLOYED vercel.json cron schedule is the single source of truth for cadence —
  // the env interval has demonstrably drifted (env said 1m while the cron runs */5).
  const cadenceMinutes = vercelCronCadenceMinutes() || numberFromEnv(env, "PQ_GMAIL_REFRESH_INTERVAL_MINUTES", 5, 1);
  const maxAgeMinutes = numberFromEnv(env, "PQ_TRUTH_HEALTH_STALE_MINUTES", Math.max(15, cadenceMinutes * 3), 1);
  const tmsInventoryMaxAgeMinutes = numberFromEnv(env, "PQ_TMS_INVENTORY_MAX_AGE_MINUTES", DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES, maxAgeMinutes);
  const warnings = [];
  const localTruth = await readLocalTruthPackets(rootDir);

  let metadataRows = [];
  let hostedMetadataError = "";
  let hostedPayloadError = "";
  let hostedPayloadReadAttempts = 0;
  let hostedPayloadRecoveryUsed = false;
  let hostedPayloadCompletedTimeoutMs = null;
  try {
    metadataRows = await loadAppSnapshotMetadataRows(HEALTH_SNAPSHOT_KEYS, {
      timeoutMs,
      retryDelaysMs: [],
    });
  } catch (error) {
    hostedMetadataError = error instanceof Error ? error.message : String(error);
  }

  const metadataByKey = rowsByKey(metadataRows);
  const hostedTruthMetadata = metadataByKey.get("shipment-truth-packets");
  // Metadata-first: when the sidecar metadata proves the hosted truth payload is byte-identical
  // to the deployed local bundle (content_signature match), certify from the bundle rows and
  // skip the multi-MB payload fetch entirely. Health must be able to classify hosted truth
  // without pulling large JSON; the payload read remains only for signature mismatch/absence.
  const hostedSignature = String(hostedTruthMetadata?.content_signature || hostedTruthMetadata?.contentSignature || "");
  const localSignature = String(localTruth?.contentSignature || "");
  const hostedMatchesLocalBundle = Boolean(hostedSignature && localSignature && hostedSignature === localSignature);
  let hostedTruthRow = null;
  if (metadataByKey.has("shipment-truth-packets") && hostedMatchesLocalBundle) {
    hostedTruthRow = {
      payload: localTruth,
      updated_at: hostedTruthMetadata?.updated_at || null,
      metadataVerified: true,
    };
  } else if (metadataByKey.has("shipment-truth-packets")) {
    try {
      const payloadRead = await loadHostedTruthPayloadRows({
        timeoutMs,
        recoveryTimeoutMs,
      });
      hostedPayloadReadAttempts = payloadRead.attempts;
      hostedPayloadRecoveryUsed = payloadRead.recoveryUsed;
      hostedPayloadCompletedTimeoutMs = payloadRead.completedTimeoutMs;
      const truthRows = payloadRead.rows;
      hostedTruthRow = Array.isArray(truthRows) ? truthRows[0] : null;
    } catch (error) {
      hostedPayloadReadAttempts = Number(error?.payloadReadAttempts || 1);
      hostedPayloadRecoveryUsed = error?.payloadRecoveryUsed === true;
      hostedPayloadError = error instanceof Error ? error.message : String(error);
    }
  }
  const activeAwbIndexRow = metadataByKey.get("active-awb-index");
  const directStateRow = metadataByKey.get("gmail-direct-state");
  const proofRow = metadataByKey.get("gmail-proof-snapshot");
  const refreshHealthRow = metadataByKey.get("gmail-refresh-health");
  const selectedTruth = hostedTruthRow?.payload || localTruth || {};
  const selectedTruthSource = hostedTruthRow?.payload
    ? "hosted-supabase"
    : localTruth
      ? "local-bundled"
      : "unavailable";
  const tmsInventory = tmsInventoryHealth(metadataByKey, tmsInventoryMaxAgeMinutes, now, selectedTruth);
  const truthSnapshotTime = selectedTruth?.snapshotTime ||
    hostedTruthMetadata?.snapshot_time ||
    hostedTruthRow?.updated_at ||
    hostedTruthMetadata?.updated_at ||
    localTruth?.snapshotTime ||
    null;
  const directConfig = publicGmailConfig(env);
  const hostedMetadataOk = !hostedMetadataError && Boolean(metadataRows.length);
  const hostedTruthPayloadOk = Boolean(hostedTruthRow?.payload);
  const hostedPersistenceOk = hostedMetadataOk && hostedTruthPayloadOk;
  const missingKeys = HEALTH_SNAPSHOT_KEYS.filter((key) => !metadataByKey.has(key));

  const { verifiedAt: truthVerifiedAt, freshAt: truthFreshAt } = verifiedTruthFreshness({
    refreshHealthRow,
    storedTruthSignature: selectedTruth?.contentSignature ||
      hostedTruthMetadata?.content_signature ||
      hostedTruthMetadata?.contentSignature ||
      "",
    truthSnapshotTime,
  });
  const truth = {
    source: selectedTruthSource,
    snapshotTime: truthSnapshotTime,
    verifiedAt: truthVerifiedAt,
    ageMinutes: ageMinutes(truthFreshAt, now),
    stale: stale(truthFreshAt, maxAgeMinutes, now),
    writerVersion: selectedTruth?.writerVersion || hostedTruthMetadata?.writer_version || "",
    activeAwbCount: Array.isArray(selectedTruth?.activeAwbs)
      ? selectedTruth.activeAwbs.length
      : Array.isArray(selectedTruth?.shipments)
        ? selectedTruth.shipments.filter((shipment) => !shipment?.truthPacketRole || shipment.truthPacketRole === "active").length
        : 0,
  };
  const rowCertification = buildRowCertification(selectedTruth);
  truth.rowCertification = rowCertification;
  const gmail = {
    config: directConfig,
    state: directStateRow
      ? {
          ...metadataFreshnessStatus(directStateRow, maxAgeMinutes, now),
          changed: null,
          updatedAwbCount: null,
          readThreadCount: null,
          queryCount: null,
          lastError: "",
        }
      : null,
    proof: proofRow
      ? {
          ...metadataFreshnessStatus(proofRow, maxAgeMinutes, now),
          proofCount: null,
        }
      : null,
    refreshHealth: refreshHealthRow ? metadataFreshnessStatus(refreshHealthRow, maxAgeMinutes, now) : null,
  };
  // The refresh cron encodes its run status into writer_version (metadata sidecar carries no
  // payload fields). A fresh-but-failed refresh must not report live truth for up to the
  // staleness window — surface the failure immediately.
  const refreshHealthWriter = String(refreshHealthRow?.writer_version || refreshHealthRow?.writerVersion || "");
  const refreshRunStatusMatch = refreshHealthWriter.match(/\+status-([a-z0-9-]+?)(?:\+phase-|\+truthsig-|$)/);
  const refreshRunStatus = refreshRunStatusMatch ? refreshRunStatusMatch[1] : "";
  const refreshRunFailedPhaseMatch = refreshHealthWriter.match(/\+phase-([a-z0-9-]+)/);
  const refreshRunFailedPhase = refreshRunFailedPhaseMatch ? refreshRunFailedPhaseMatch[1] : "";
  const refreshRunFailed = ["failed", "error", "persistence-paused"].includes(refreshRunStatus);
  if (gmail.refreshHealth) gmail.refreshHealth.lastRunStatus = refreshRunStatus || null;
  if (gmail.refreshHealth) gmail.refreshHealth.lastFailedPhase = refreshRunFailedPhase || null;

  // Sync-request observability: the operator's "Refresh email sync" is a
  // request record with a lifecycle (queued -> claimed -> done/failed). Health
  // reports the latest record and one derived operator-language state, so the
  // UI renders what the pipeline observably did, not what it infers.
  const syncRequest = await latestSyncRequestRecord(rootDir, { timeoutMs });
  const syncState = deriveSyncRequestState({
    request: syncRequest,
    refreshHealth: gmail.refreshHealth,
    proofSnapshotTime: gmail.proof?.snapshotTime || "",
    now: now.toISOString(),
  });
  const hostedPersistence = {
    ok: hostedPersistenceOk,
    status: hostedPersistenceOk ? "ok" : "degraded",
    timeoutMs,
    snapshotKeysRequested: HEALTH_SNAPSHOT_KEYS,
    snapshotKeysRead: Array.from(metadataByKey.keys()),
    missingKeys,
    activeAwbIndexUpdatedAt: activeAwbIndexRow?.updated_at || null,
    metadataOk: hostedMetadataOk,
    payloadOk: hostedTruthPayloadOk,
    payloadReadSkipped: hostedMatchesLocalBundle,
    payloadReadAttempts: hostedMatchesLocalBundle ? 0 : hostedPayloadReadAttempts,
    payloadRecoveryUsed: hostedPayloadRecoveryUsed,
    payloadRecoveryTimeoutMs: recoveryTimeoutMs,
    payloadCompletedTimeoutMs: hostedPayloadCompletedTimeoutMs,
    metadataError: hostedMetadataError,
    payloadError: hostedPayloadError,
    error: hostedMetadataError || hostedPayloadError,
    circuit: supabaseReadCircuitHealth(now.getTime()),
  };

  if (!hostedMetadataOk) {
    warnings.push(`Hosted Supabase snapshot metadata is unavailable (${hostedMetadataError || "no metadata rows returned"}).`);
  } else if (!hostedTruthPayloadOk) {
    warnings.push(`Hosted shipment-truth-packets payload is unavailable (${hostedPayloadError || "payload row missing"}).`);
  }
  if (hostedMetadataOk && !tmsInventory.ok) {
    const parts = [
      tmsInventory.missingKeys.length ? `missing ${tmsInventory.missingKeys.join(", ")}` : "",
      tmsInventory.staleKeys.length ? `stale ${tmsInventory.staleKeys.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    warnings.push(`Hosted TMS active inventory snapshots are not usable (${parts || "unknown TMS inventory state"}).`);
  }
  if (selectedTruthSource === "local-bundled") {
    warnings.push("Using bundled shipment truth because hosted shipment-truth-packets could not be read.");
  }
  if (truth.stale) {
    warnings.push(`Canonical shipment truth is stale (${truth.ageMinutes === null ? "unknown age" : `${truth.ageMinutes}m old`}).`);
  }
  if (rowCertification.problemCount) {
    warnings.push(
      `${rowCertification.problemCount} active shipment truth certification problem(s): ${rowCertification.problemAwbs.slice(0, 8).join(", ")}.`,
    );
  }
  if (!directConfig.available) {
    warnings.push("Direct Gmail OAuth ingestion is not configured.");
  }
  // Deduped writes age snapshot_time on purpose: an unchanged proof/state snapshot is NOT
  // stale truth when a fresh successful refresh run verified it — the refresh-health
  // heartbeat is the freshness carrier for unchanged snapshots.
  const refreshRunFresh = Boolean(gmail.refreshHealth && !gmail.refreshHealth.stale &&
    (!refreshRunStatus || refreshRunStatus === "success"));
  if (!gmail.state) {
    warnings.push("Gmail direct-state snapshot is unavailable.");
  } else if (gmail.state.stale && !refreshRunFresh) {
    warnings.push(`Gmail direct-state is stale (${gmail.state.ageMinutes === null ? "unknown age" : `${gmail.state.ageMinutes}m old`}).`);
  }
  if (!gmail.proof) {
    warnings.push("Gmail proof snapshot is unavailable.");
  } else if (gmail.proof.stale && !refreshRunFresh) {
    warnings.push(`No successful Gmail proof write in over ${maxAgeMinutes}m (proof snapshot ${gmail.proof.ageMinutes === null ? "of unknown age" : `${gmail.proof.ageMinutes}m old`})${refreshRunFailedPhase ? `; last refresh run failed at the ${refreshRunFailedPhase} phase` : ""}.`);
  }

  const emergencyBundledFresh = selectedTruthSource === "local-bundled" &&
    !truth.stale &&
    rowCertification.problemCount === 0 &&
    rowCertification.activeRowsChecked > 0;
  if (refreshRunFailed) {
    warnings.push(`Last Gmail refresh run reported status ${refreshRunStatus}${refreshRunFailedPhase ? ` (failed at the ${refreshRunFailedPhase} phase)` : ""}; truth must not be treated as live until a clean refresh completes.`);
  }
  const live = hostedPersistence.ok &&
    selectedTruthSource === "hosted-supabase" &&
    tmsInventory.ok &&
    directConfig.available &&
    !truth.stale &&
    rowCertification.problemCount === 0 &&
    gmail.state &&
    (!gmail.state.stale || refreshRunFresh) &&
    gmail.proof &&
    (!gmail.proof.stale || refreshRunFresh) &&
    !refreshRunFailed;

  return {
    ok: live,
    status: live ? "live" : "degraded",
    checkedAt: now.toISOString(),
    source: "truth-health-v1",
    cadenceMinutes,
    maxAgeMinutes,
    truth,
    gmail,
    syncRequest,
    syncState,
    hostedPersistence,
    tmsInventory,
    truthAgreement: bundledTruthAgreementSummary(),
    warnings,
    emergencyBundledFresh,
    operatorGuidance: truthHealthOperatorGuidance({
      live,
      emergencyBundledFresh,
      hostedMetadataOk,
      tmsInventory,
      rowCertification,
    }),
  };
}

// The referee score ships with the deployment (require traces the artifact into the
// bundle); it is the last LOCAL strict run, labeled as such — not a live recompute.
function bundledTruthAgreementSummary() {
  try {
    // eslint-disable-next-line global-require
    const artifact = require("../artifacts/truth-agreement/latest.json");
    return {
      overallAgreement: artifact.overallAgreement ?? null,
      agreed: artifact.agreed ?? null,
      activeReviewed: artifact.activeReviewed ?? null,
      checkedAt: artifact.checkedAt || null,
      source: "bundled-local-referee-run",
    };
  } catch (error) {
    return null;
  }
}

function vercelCronCadenceMinutes() {
  try {
    // eslint-disable-next-line global-require
    const vercelConfig = require("../vercel.json");
    const cron = (vercelConfig.crons || []).find((item) => String(item.path || "").includes("gmail-refresh"));
    const schedule = String(cron?.schedule || "").trim();
    const everyN = schedule.match(/^\*\/(\d+) \* \* \* \*$/);
    if (everyN) return Number(everyN[1]);
    if (/^\* \* \* \* \*$/.test(schedule)) return 1;
  } catch (error) { /* fall back to env below */ }
  return null;
}

module.exports = {
  buildTruthHealth,
  vercelCronCadenceMinutes,
  buildRowCertification,
  _test: {
    ageMinutes,
    stale,
    rowsByKey,
    activeTruthRows,
    buildRowCertification,
    certificationProblemForRow,
    tmsActiveMembershipProblems,
    tmsInventoryHealth,
    truthHealthOperatorGuidance,
    verifiedTruthFreshness,
    hostedPayloadDeadlineError,
    loadHostedTruthPayloadRows,
  },
};

"use strict";

const {
  authorized,
  loadAppSnapshot,
  loadAppSnapshotMetadataRows,
  loadAppSnapshotRows,
  loadActiveAwbs,
  sendJson,
  upsertAppSnapshot,
} = require("../../lib/supabase-agent");
const {
  checkDirectGmailAuth,
  gmailDirectAvailable,
  gmailDirectEnv,
  runDirectGmailRefresh,
} = require("../../lib/gmail-direct-ingest");

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_MAX_THREADS = 60;
const DEFAULT_MAX_ATTACHMENT_PDFS = 2;
const FRESHNESS_POLICY = "production-five-minute-refresh";
const SNAPSHOT_POLICY = "direct-gmail-refresh-never-runs-tms-or-carrier-tracking";
const TIME_ZONE = "America/New_York";
const ACTIVE_HOURS_START = 5;
const ACTIVE_HOURS_END_EXCLUSIVE = 18;
const HEALTH_SNAPSHOT_KEY = "gmail-refresh-health";
const PERSISTENCE_PREFLIGHT_KEYS = [
  "gmail-direct-state",
  "gmail-proof-snapshot",
  "shipment-truth-packets",
  "active-awb-index",
];
const PERSISTENCE_PREFLIGHT_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_PERSISTENCE_TIMEOUT_MS || 1200);
const HEALTH_WRITE_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_HEALTH_WRITE_TIMEOUT_MS || 1200);

function activeSnapshotAgeMs(snapshotTime, now) {
  const parsed = Date.parse(snapshotTime || "");
  if (!Number.isFinite(parsed)) return Infinity;
  return now.getTime() - parsed;
}

function snapshotIsStale(snapshotTime, cadenceMinutes, now) {
  return activeSnapshotAgeMs(snapshotTime, now) > Math.max(1, cadenceMinutes) * 60 * 1000;
}

function intervalMinutes(request) {
  const url = new URL(request.url || "/", "http://localhost");
  const value = Number(url.searchParams.get("interval") || process.env.PQ_GMAIL_REFRESH_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(DEFAULT_INTERVAL_MINUTES, value);
}

function isDryRun(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("dryRun") === "1";
}

function isTokenTest(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("tokenTest") === "1";
}

function isRefreshProbe(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("refreshProbe") === "1";
}

function isForcedRefresh(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return url.searchParams.get("force") === "1";
}

function requestedAwbs(request) {
  const url = new URL(request.url || "/", "http://localhost");
  return [...new Set(String(url.searchParams.get("awbs") || "")
    .split(/[,\s]+/)
    .map((awb) => awb.replace(/\D/g, ""))
    .filter(Boolean))];
}

function localHour(date = new Date()) {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hour);
}

function isActiveRefreshWindow(now = new Date()) {
  if (process.env.PQ_GMAIL_REFRESH_ACTIVE_HOURS !== "1") return true;
  const hour = localHour(now);
  return hour >= ACTIVE_HOURS_START && hour < ACTIVE_HOURS_END_EXCLUSIVE;
}

function refreshDisabled() {
  return process.env.PQ_GMAIL_REFRESH_DISABLED === "1" || process.env.PQ_CRON_SUPABASE_PAUSED === "1";
}

function gmailConfigStatus() {
  const cfg = gmailDirectEnv();
  return {
    available: cfg.available,
    user: cfg.user,
    sources: {
      clientId: cfg.clientIdSource || null,
      clientSecret: cfg.clientSecretSource || null,
      refreshToken: cfg.refreshTokenSource || null,
    },
    missing: [
      cfg.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
      cfg.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
      cfg.refreshToken ? "" : "GMAIL_REFRESH_TOKEN or GOOGLE_GMAIL_REFRESH_TOKEN",
    ].filter(Boolean),
  };
}

// Operator-facing failure phase vocabulary: search, evidence-refetch, reduce, proof-write,
// packet-write, action-write, direct-state-write.
function failedPhaseLabel(rawPhase) {
  const value = String(rawPhase || "").trim().toLowerCase();
  if (!value) return "";
  const map = [
    [/^upsert-gmail-proof/, "proof-write"],
    [/^upsert-truth-packets|^upsert-operational-fact-ledger/, "packet-write"],
    [/^verify-tms-source-watermark/, "packet-write"],
    [/^upsert-action-queue/, "action-write"],
    [/^upsert-gmail-direct-state/, "direct-state-write"],
    [/^gmail-read-threads/, "evidence-refetch"],
    [/^gmail-(?:search|token-refresh)|^normalize-awbs|^load-active-awbs/, "search"],
    [/^gmail-(?:summarize|attachment-enrichment)|^load-existing-gmail-proof/, "reduce"],
  ];
  for (const [pattern, label] of map) {
    if (pattern.test(value)) return label;
  }
  return value.replace(/[^a-z0-9-]+/g, "-").slice(0, 30);
}

async function writeRefreshHealth(dryRun, payload) {
  // Encode the run status into writerVersion so metadata-only health reads (the
  // snapshot metadata sidecar carries snapshot_time/updated_at/writer_version but no
  // payload fields) can see a failed/paused refresh without fetching payload JSON.
  const statusLabel = String(payload?.status || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const phaseLabel = failedPhaseLabel(payload?.phase);
  // The verified truth-packet signature rides in writer_version so metadata-only
  // health reads can prove "checked this cycle, content unchanged" without the
  // payload. Skipped-as-unchanged truth writes freeze the packet's snapshotTime;
  // this marker is what keeps verified-but-unchanged truth reading as fresh.
  const truthSigLabel = statusLabel === "success"
    ? String(payload?.truthPacketContentSignature || "").slice(0, 12)
    : "";
  // The payload spreads FIRST: the run's own clock and writer identity must
  // always win. The success payload carries the ACTIVE snapshot's
  // snapshotTime — when it spread last it overwrote the run stamp, and once
  // write-skipping froze quiet snapshots, the health clock froze with it and
  // verified-freshness expired fleet-wide ("cron gap" incidents 2026-07-05).
  const health = {
    ...payload,
    activeSnapshotTime: payload?.snapshotTime || "",
    snapshotTime: new Date().toISOString(),
    source: "api/cron/gmail-refresh",
    failedPhaseLabel: statusLabel === "failed" ? phaseLabel : "",
    writerVersion: statusLabel
      ? `gmail-refresh-health-v1+status-${statusLabel}${statusLabel === "failed" && phaseLabel ? `+phase-${phaseLabel}` : ""}${truthSigLabel ? `+truthsig-${truthSigLabel}` : ""}`
      : "gmail-refresh-health-v1",
    freshnessPolicy: FRESHNESS_POLICY,
    snapshotPolicy: SNAPSHOT_POLICY,
  };
  if (dryRun) return { ok: true, dryRun: true, health };
  try {
    await upsertAppSnapshot(HEALTH_SNAPSHOT_KEY, health, {
      timeoutMs: HEALTH_WRITE_TIMEOUT_MS,
      retryDelaysMs: [],
    });
    return { ok: true, health };
  } catch (error) {
    return {
      ok: false,
      health,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function preflightHostedPersistence() {
  try {
    const rows = await loadAppSnapshotMetadataRows(PERSISTENCE_PREFLIGHT_KEYS, {
      timeoutMs: PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
      retryDelaysMs: [],
    });
    return {
      ok: true,
      timeoutMs: PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
      snapshotKeysRequested: PERSISTENCE_PREFLIGHT_KEYS,
      snapshotKeysRead: (rows || []).map((row) => row.snapshot_key).filter(Boolean),
      metadataRows: rows || [],
    };
  } catch (error) {
    return {
      ok: false,
      timeoutMs: PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
      snapshotKeysRequested: PERSISTENCE_PREFLIGHT_KEYS,
      snapshotKeysRead: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function logCronEvent(event, payload = {}, level = "log") {
  const line = JSON.stringify({
    route: "gmail-refresh",
    event,
    at: new Date().toISOString(),
    ...payload,
  });
  if (level === "warn") {
    console.warn(line);
    return;
  }
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

function persistencePausedResponse({
  cadenceMinutes,
  packetAwbs,
  forcedRefresh,
  persistence,
  phase = "hosted-persistence-preflight",
  refreshHealth = null,
}) {
  logCronEvent("persistence-paused", {
    phase,
    cadenceMinutes,
    requestedAwbCount: packetAwbs.length,
    forcedRefresh,
    persistenceOk: Boolean(persistence?.ok),
    timeoutMs: persistence?.timeoutMs || PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
    snapshotKeysRequested: persistence?.snapshotKeysRequested || [],
    snapshotKeysRead: persistence?.snapshotKeysRead || [],
    error: persistence?.error || "",
    refreshHealthOk: refreshHealth ? Boolean(refreshHealth.ok) : null,
    refreshHealthStatus: refreshHealth?.health?.status || "",
    refreshHealthError: refreshHealth?.error || "",
    readFallbackAllowed: refreshHealth?.health?.readFallbackAllowed ?? null,
  }, "warn");
  return {
    ok: true,
    queued: false,
    direct: true,
    paused: true,
    persistencePaused: true,
    reason: "Hosted Supabase persistence is unavailable; skipping Gmail ingestion so the cron does not read Gmail and then fail to persist truth.",
    cadenceMinutes,
    requestedAwbCount: packetAwbs.length,
    forcedRefresh,
    phase,
    persistence,
    refreshHealth,
    snapshotPolicy: SNAPSHOT_POLICY,
    freshnessPolicy: FRESHNESS_POLICY,
  };
}

module.exports = async function handler(request, response) {
  let phase = "authorize";
  if (request.method !== "GET" && request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const dryRun = isDryRun(request);
  const startedAt = new Date().toISOString();
  if (!dryRun && !authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  try {
    const now = new Date();
    const cadenceMinutes = intervalMinutes(request);
    const packetAwbs = requestedAwbs(request);
    const forcedRefresh = isForcedRefresh(request);
    const refreshProbe = isRefreshProbe(request);
    phase = "active-window";
    if (refreshDisabled()) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        direct: true,
        paused: true,
        reason: "Direct Gmail refresh is disabled by PQ_GMAIL_REFRESH_DISABLED to protect Supabase availability.",
        cadenceMinutes,
        requestedAwbCount: packetAwbs.length,
        snapshotPolicy: SNAPSHOT_POLICY,
        freshnessPolicy: FRESHNESS_POLICY,
      });
      return;
    }

    // An explicit operator run (force=1) may refresh outside the scheduled
    // active hours — the window only rations the automatic cron cadence.
    if (!forcedRefresh && !isActiveRefreshWindow(now)) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        reason: "Outside concept-mode Gmail refresh window",
        timeZone: TIME_ZONE,
        activeHours: `${ACTIVE_HOURS_START}:00-${ACTIVE_HOURS_END_EXCLUSIVE}:00`,
      });
      return;
    }

    phase = "direct-gmail-config";
    const gmailConfig = gmailConfigStatus();
    if (dryRun && isTokenTest(request)) {
      const auth = await checkDirectGmailAuth();
      sendJson(response, auth.ok ? 200 : 500, {
        ok: auth.ok,
        queued: false,
        direct: true,
        dryRun: true,
        tokenTest: true,
        cadenceMinutes,
        requestedAwbCount: packetAwbs.length,
        snapshotPolicy: SNAPSHOT_POLICY,
        freshnessPolicy: FRESHNESS_POLICY,
        gmailConfig,
        auth,
      });
      return;
    }
    if (dryRun && refreshProbe && !authorized(request)) {
      sendJson(response, 401, { error: "Unauthorized" });
      return;
    }

    let persistence = null;
    let persistencePauseHealth = null;
    if (!dryRun) {
      phase = "hosted-persistence-preflight";
      persistence = await preflightHostedPersistence();
      if (!persistence.ok) {
        persistencePauseHealth = await writeRefreshHealth(dryRun, {
          ok: false,
          status: "persistence-paused",
          phase,
          startedAt,
          pausedAt: new Date().toISOString(),
          cadenceMinutes,
          requestedAwbCount: packetAwbs.length,
          forcedRefresh,
          persistence,
          readFallbackAllowed: false,
        });
        sendJson(response, 200, persistencePausedResponse({
          cadenceMinutes,
          packetAwbs,
          forcedRefresh,
          persistence,
          phase,
          refreshHealth: persistencePauseHealth,
        }));
        return;
      }
    }

    let gmailDirectState = null;
    let gmailDirectStateTime = null;
    let gmailDirectStateAgeMs = null;
    let gmailDirectStateStale = true;
    if (!dryRun && !packetAwbs.length && !forcedRefresh && !refreshProbe) {
      phase = "load-direct-gmail-state";
      try {
        gmailDirectState = await loadAppSnapshot("gmail-direct-state", {}, {
          timeoutMs: PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
          retryDelaysMs: [],
        });
      } catch (error) {
        sendJson(response, 200, persistencePausedResponse({
          cadenceMinutes,
          packetAwbs,
          forcedRefresh,
          persistence: {
            ok: false,
            timeoutMs: PERSISTENCE_PREFLIGHT_TIMEOUT_MS,
            snapshotKeysRequested: ["gmail-direct-state"],
            snapshotKeysRead: [],
            error: error instanceof Error ? error.message : String(error),
          },
          phase,
        }));
        return;
      }
      gmailDirectStateTime = gmailDirectState?.snapshotTime || null;
      gmailDirectStateAgeMs = activeSnapshotAgeMs(gmailDirectStateTime, now);
      gmailDirectStateStale = snapshotIsStale(gmailDirectStateTime, cadenceMinutes, now);
      const metadataRows = Array.isArray(persistence?.metadataRows) ? persistence.metadataRows : [];
      const proofMetadata = metadataRows.find((row) => row?.snapshot_key === "gmail-proof-snapshot") || null;
      const directStateProofSignature = String(gmailDirectState?.contentSignature || "");
      const proofSignature = String(proofMetadata?.content_signature || proofMetadata?.contentSignature || "");
      const proofMatchesDirectState = Boolean(directStateProofSignature && proofSignature && directStateProofSignature === proofSignature);
      if (!gmailDirectStateStale && proofMatchesDirectState) {
        sendJson(response, 200, {
          ok: true,
          queued: false,
          direct: true,
          skipped: true,
          reason: `Last direct Gmail refresh is newer than ${cadenceMinutes} minutes.`,
          cadenceMinutes,
          gmailDirectStateTime,
          gmailDirectStateAgeMs,
          proofSignatureMatchedDirectState: true,
          snapshotPolicy: SNAPSHOT_POLICY,
          freshnessPolicy: FRESHNESS_POLICY,
        });
        return;
      }
    }

    phase = "load-active-awbs";
    const active = await loadActiveAwbs();
    const awbs = packetAwbs.length ? packetAwbs : active.awbs;
    const { snapshotTime, snapshots, recommendedLookbackDays, activeAwbSource, sourceTruthWarnings } = active;
    const sourceCounts = {
      ...(active.sourceCounts || {}),
      packetAwbs: packetAwbs.length,
    };
    const snapshotAgeMs = activeSnapshotAgeMs(snapshotTime, now);
    const snapshotStale = snapshotIsStale(snapshotTime, cadenceMinutes, now);
    const lookbackDays = Math.max(
      Number(process.env.PQ_GMAIL_DIRECT_LOOKBACK_DAYS || DEFAULT_LOOKBACK_DAYS),
      Number(recommendedLookbackDays || 0),
    );

    if (!dryRun && !active.canPublish) {
      sendJson(response, 200, {
        ok: false,
        paused: true,
        queued: false,
        phase: "canonical-source-unavailable",
        reason: "Hosted canonical inventory is unavailable; refusing to read bundled/local truth or publish a competing packet.",
        activeAwbSource,
        sourceTruthWarnings,
      });
      return;
    }

    if (!awbs.length) {
      sendJson(response, 200, { ok: true, queued: false, reason: "No active AWBs found" });
      return;
    }

    if (!gmailDirectAvailable()) {
      sendJson(response, 500, {
        ok: false,
        queued: false,
        direct: true,
        error: "Direct Gmail is not configured; hosted Gmail refresh will not fall back to Codex jobs.",
        cadenceMinutes,
        awbCount: awbs.length,
        sourceCounts,
        activeAwbSource,
        sourceTruthWarnings,
        lookbackDays,
        snapshotTime,
        snapshotAgeMs,
        snapshotStale,
        gmailDirectStateTime,
        gmailDirectStateAgeMs,
        gmailDirectStateStale,
        snapshotPolicy: SNAPSHOT_POLICY,
        freshnessPolicy: FRESHNESS_POLICY,
        gmailConfig,
      });
      return;
    }

    if (dryRun && refreshProbe) {
      const directResult = await runDirectGmailRefresh({
        awbs,
        now,
        lookbackDays,
        maxThreads: Number(process.env.PQ_GMAIL_DIRECT_MAX_THREADS || DEFAULT_MAX_THREADS),
        maxAttachmentPdfs: Number(process.env.PQ_GMAIL_DIRECT_MAX_PDF_ATTACHMENTS || DEFAULT_MAX_ATTACHMENT_PDFS),
        memorySnapshots: snapshots,
        sourceTruthWarnings: sourceTruthWarnings || [],
        write: false,
      });
      sendJson(response, 200, {
        ok: true,
        queued: false,
        dryRun: true,
        direct: true,
        refreshProbe: true,
        cadenceMinutes,
        awbCount: awbs.length,
        sourceCounts,
        activeAwbSource,
        sourceTruthWarnings,
        lookbackDays,
        snapshotTime,
        snapshotAgeMs,
        snapshotStale,
        gmailDirectStateTime,
        gmailDirectStateAgeMs,
        gmailDirectStateStale,
        snapshotPolicy: SNAPSHOT_POLICY,
        freshnessPolicy: FRESHNESS_POLICY,
        gmailConfig,
        ...directResult,
      });
      return;
    }

    if (dryRun) {
      sendJson(response, 200, {
        ok: true,
        queued: false,
        dryRun: true,
        direct: true,
        reason: "Would run direct Gmail thread ingestion",
        cadenceMinutes,
        awbCount: awbs.length,
        sourceCounts,
        activeAwbSource,
        sourceTruthWarnings,
        lookbackDays,
        snapshotTime,
        snapshotAgeMs,
        snapshotStale,
        gmailDirectStateTime,
        gmailDirectStateAgeMs,
        gmailDirectStateStale,
        forcedRefresh,
        snapshotPolicy: SNAPSHOT_POLICY,
        freshnessPolicy: FRESHNESS_POLICY,
        gmailConfig,
      });
      return;
    }

    phase = "direct-gmail-refresh";
    // Older-thread context: decisive evidence threads referenced by active packet rows must
    // stay fetched even after they leave the lookback window — otherwise open demands and
    // hold sagas silently vanish from proofs as the window slides.
    const evidenceThreadIds = (() => {
      const rows = (active?.snapshots?.active?.shipments || [])
        .filter((row) => !row.truthPacketRole || String(row.truthPacketRole).toLowerCase() === "active");
      const validThread = (threadId) => /^[0-9a-f]{16}$/.test(String(threadId || ""));
      // Open exception threads first: an unresolved blocker's evidence thread must never be
      // squeezed out by the cap, or the blocker silently vanishes as the window slides.
      const exceptionIds = new Set();
      const contextIds = new Set();
      for (const row of rows) {
        for (const exception of row?.opsState?.exceptions || []) {
          if (exception && String(exception.status || "").toLowerCase() === "open" && validThread(exception.threadId)) {
            exceptionIds.add(exception.threadId);
          }
        }
        const contextCandidates = [
          row?.lastEmail?.threadId,
          ...((row?.evidencePacket?.threads || []).map((thread) => thread?.threadId)),
        ];
        for (const threadId of contextCandidates) {
          if (validThread(threadId)) contextIds.add(threadId);
        }
      }
      // Self-heal coverage gaps: the previous cycle's coverage audit names the
      // exact threads the search saw but never read (missingTopSearchThreadIds).
      // Those threads carry the newest unrepresented signals — force-read them
      // this cycle so a per-AWB cap can never starve the newest truth twice.
      const coverageGapIds = new Set();
      for (const row of rows) {
        for (const threadId of row?.gmailCoverage?.missingTopSearchThreadIds || []) {
          if (validThread(threadId)) coverageGapIds.add(threadId);
        }
      }
      const ids = [...exceptionIds].slice(0, 10);
      for (const threadId of coverageGapIds) {
        if (ids.length >= 18) break;
        if (!ids.includes(threadId)) ids.push(threadId);
      }
      for (const threadId of contextIds) {
        if (ids.length >= 22) break;
        if (!ids.includes(threadId)) ids.push(threadId);
      }
      return ids;
    })();
    const directResult = await runDirectGmailRefresh({
      awbs,
      requiredThreadIds: evidenceThreadIds,
      now,
      lookbackDays,
      maxThreads: Number(process.env.PQ_GMAIL_DIRECT_MAX_THREADS || DEFAULT_MAX_THREADS),
      maxAttachmentPdfs: Number(process.env.PQ_GMAIL_DIRECT_MAX_PDF_ATTACHMENTS || DEFAULT_MAX_ATTACHMENT_PDFS),
      memorySnapshots: snapshots,
        sourceTruthWarnings: sourceTruthWarnings || [],
      // Completed AWBs are "known" so discovery does not report them as unknown mentions.
      knownAwbs: active?.snapshots?.active?.completedAwbs || [],
      skipHostedSnapshotReads: false,
    });
    const refreshHealth = await writeRefreshHealth(dryRun, {
      ok: true,
      status: "success",
      phase: "complete",
      startedAt,
      completedAt: new Date().toISOString(),
      cadenceMinutes,
      awbCount: awbs.length,
      sourceCounts,
      activeAwbSource,
      sourceTruthWarnings: sourceTruthWarnings || [],
      snapshotTime,
      snapshotAgeMs,
      snapshotStale,
      gmailDirectStateTime,
      gmailDirectStateAgeMs,
      gmailDirectStateStale,
      hostedReadFallback: false,
      persistence,
      truthPacketContentSignature: directResult.truthPacketContentSignature || "",
      direct: {
        changed: directResult.changed,
        updated: directResult.updated,
        gmailCoverageStatus: directResult.gmailCoverageStatus,
        gmailCoverageProblemCount: directResult.gmailCoverageProblemCount,
        truthPacketsChanged: directResult.truthPacketsChanged,
        hostedSnapshotReadsSkipped: directResult.hostedSnapshotReadsSkipped,
        snapshotLoadWarnings: directResult.snapshotLoadWarnings || [],
      },
    });
    logCronEvent("success", {
      phase: "complete",
      cadenceMinutes,
      awbCount: awbs.length,
      activeAwbSource,
      changed: Boolean(directResult.changed),
      updated: directResult.updated || 0,
      truthPacketsChanged: Boolean(directResult.truthPacketsChanged),
      gmailCoverageStatus: directResult.gmailCoverageStatus || "",
      gmailCoverageProblemCount: directResult.gmailCoverageProblemCount || 0,
      refreshHealthOk: Boolean(refreshHealth?.ok),
      refreshHealthError: refreshHealth?.error || "",
      hostedReadFallback: false,
      hostedSnapshotReadsSkipped: Boolean(directResult.hostedSnapshotReadsSkipped),
    });
    sendJson(response, 200, {
      ok: true,
      queued: false,
      direct: true,
      cadenceMinutes,
      awbCount: awbs.length,
      sourceCounts,
      activeAwbSource,
      sourceTruthWarnings,
      lookbackDays,
      snapshotTime,
      snapshotAgeMs,
      snapshotStale,
      gmailDirectStateTime,
      gmailDirectStateAgeMs,
      gmailDirectStateStale,
      hostedReadFallback: false,
      persistence,
      persistencePauseHealth,
      forcedRefresh,
      snapshotPolicy: SNAPSHOT_POLICY,
      freshnessPolicy: FRESHNESS_POLICY,
      gmailConfig,
      refreshHealth,
      ...directResult,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // runDirectGmailRefresh throws "<inner-phase>: <message>" — the inner phase is the
    // truthful failure site, not this handler's coarse outer phase.
    const innerPhaseMatch = message.match(/^([a-z0-9-]{3,40}):\s/);
    const failedPhase = (innerPhaseMatch && failedPhaseLabel(innerPhaseMatch[1]) ? innerPhaseMatch[1] : "") || phase;
    logCronEvent("failed", {
      phase: failedPhase,
      error: message,
    }, "error");
    const refreshHealth = await writeRefreshHealth(dryRun, {
      ok: false,
      status: "failed",
      phase: failedPhase,
      startedAt,
      failedAt: new Date().toISOString(),
      error: message,
    });
    sendJson(response, 500, { error: message, phase, refreshHealth });
  }
};

module.exports._test = { failedPhaseLabel, writeRefreshHealth };

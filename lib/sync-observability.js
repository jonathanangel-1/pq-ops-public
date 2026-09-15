"use strict";

// Sync-request observability (operational-trust lane).
//
// One pure derivation answers "what is the email sync actually doing right
// now?" in operator language, from observable records only:
//   - the latest sync request record (queued/claimed/running/success/fail)
//   - the refresh-run health (last cron run, its status, its age)
//   - the proof snapshot time (when new mail evidence last landed)
//   - the hosted-read fallback flag (bundled repo snapshot served)
//
// States:
//   stale-fallback     hosted truth read failed; a bundled backup snapshot is
//                      being served. LOUD, and lockActions=true.
//   stuck-unclaimed    a request has been queued/waiting with no claim for
//                      longer than the claim window — the worker is not
//                      picking it up.
//   queued             a request is queued, still inside the claim window.
//   claimed            a request is claimed/running.
//   failed             the last refresh run failed (with its phase).
//   checked-new-mail   last run succeeded and new mail evidence landed.
//   checked-no-new-mail last run succeeded; nothing new since the proof time.
//   unknown            not enough observable data.

const CLAIM_WINDOW_MINUTES = 10;
const RUNNING_STALL_MINUTES = 25;

function minutesBetweenIso(fromIso, toIso) {
  const from = Date.parse(fromIso || "");
  const to = Date.parse(toIso || "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 60000);
}

function ageLabel(minutes) {
  if (minutes == null) return "recently";
  if (minutes <= 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 6) / 10}h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}

function requestActivityTime(request = {}) {
  return request.claimedAt || request.lockedAt || request.updatedAt || request.recordedAt || request.requestedAt || request.queuedAt || request.createdAt || "";
}

function deriveSyncRequestState(input = {}) {
  const {
    request = null,
    refreshHealth = null,
    proofSnapshotTime = "",
    hostedReadFallback = null,
    bundledSnapshotTime = "",
    now = new Date().toISOString(),
  } = input;

  // 1. A served bundled fallback outranks everything: the operator is looking
  //    at an old backup copy, whatever the sync pipeline says.
  if (hostedReadFallback) {
    const asOf = bundledSnapshotTime || hostedReadFallback.snapshotTime || "";
    const age = minutesBetweenIso(asOf, now);
    return {
      state: "stale-fallback",
      tone: "bad",
      lockActions: true,
      title: "Showing an old backup copy — not live data",
      sub: `Live shipment data could not be read${asOf ? `; this board is from ${ageLabel(age)}` : ""}. Sending and status changes are locked until live data is back.`,
      observedAt: hostedReadFallback.at || now,
    };
  }

  const status = String(request?.status || "").toLowerCase();
  const activityAge = request ? minutesBetweenIso(requestActivityTime(request), now) : null;

  // A request whose work a LATER successful refresh run already did is
  // superseded — the record just never got closed. Report the run, not a
  // forever-red stuck state for work that actually happened.
  const runTimeMs = Date.parse(refreshHealth?.snapshotTime || "");
  const requestTimeMs = Date.parse(requestActivityTime(request || {}) || "");
  const supersededByRun = String(refreshHealth?.lastRunStatus || "") === "success" &&
    Number.isFinite(runTimeMs) && Number.isFinite(requestTimeMs) && runTimeMs > requestTimeMs;

  // 2. An open request that nothing claimed: say it is stuck, plainly.
  if (!supersededByRun && ["queued", "waiting_external"].includes(status)) {
    if (activityAge != null && activityAge > CLAIM_WINDOW_MINUTES) {
      return {
        state: "stuck-unclaimed",
        tone: "bad",
        lockActions: false,
        title: "Sync request is stuck — the worker isn't picking it up",
        sub: `Requested ${ageLabel(activityAge)} and still unclaimed. Shipment data may be missing new replies.`,
        observedAt: requestActivityTime(request),
      };
    }
    return {
      state: "queued",
      tone: "warn",
      lockActions: false,
      title: "Email sync requested",
      sub: `Waiting for the sync worker to pick it up (requested ${ageLabel(activityAge)}).`,
      observedAt: requestActivityTime(request),
    };
  }

  if (!supersededByRun && ["claimed", "running"].includes(status)) {
    const stalled = activityAge != null && activityAge > RUNNING_STALL_MINUTES;
    return {
      state: stalled ? "stuck-unclaimed" : "claimed",
      tone: stalled ? "bad" : "warn",
      lockActions: false,
      title: stalled ? "Sync run looks stuck" : "Email sync is running",
      sub: stalled
        ? `Started ${ageLabel(activityAge)} and never finished. Shipment data may be missing new replies.`
        : `The worker picked it up ${ageLabel(activityAge)}.`,
      observedAt: requestActivityTime(request),
    };
  }

  // 3. No open request: report what the last refresh run observed.
  const runStatus = String(refreshHealth?.lastRunStatus || "");
  const runAge = refreshHealth && Number.isFinite(Number(refreshHealth.ageMinutes))
    ? Number(refreshHealth.ageMinutes)
    : minutesBetweenIso(refreshHealth?.snapshotTime, now);
  if (runStatus && runStatus !== "success") {
    return {
      state: "failed",
      tone: "bad",
      lockActions: false,
      title: "Email sync is failing",
      sub: `The last check failed${refreshHealth?.lastFailedPhase ? ` while ${String(refreshHealth.lastFailedPhase).replace(/[-_]/g, " ")}` : ""} (${ageLabel(runAge)}). Shipment data may be missing new replies.`,
      observedAt: refreshHealth?.snapshotTime || "",
    };
  }
  if (runStatus === "success" && runAge != null) {
    const proofAge = minutesBetweenIso(proofSnapshotTime, now);
    const newMailThisRun = proofAge != null && runAge != null && proofAge <= runAge + 1;
    if (newMailThisRun) {
      return {
        state: "checked-new-mail",
        tone: "ok",
        lockActions: false,
        title: "Email checked — new mail came in",
        sub: `Checked ${ageLabel(runAge)}; new email evidence landed.`,
        observedAt: refreshHealth?.snapshotTime || "",
      };
    }
    return {
      state: "checked-no-new-mail",
      tone: "ok",
      lockActions: false,
      title: "Email checked — no new mail",
      sub: `Checked ${ageLabel(runAge)} — no new mail since ${proofSnapshotTime ? ageLabel(proofAge) : "the last update"}.`,
      observedAt: refreshHealth?.snapshotTime || "",
    };
  }

  return {
    state: "unknown",
    tone: "warn",
    lockActions: false,
    title: "Email sync state unknown",
    sub: "No recent sync run has reported in.",
    observedAt: "",
  };
}

module.exports = {
  CLAIM_WINDOW_MINUTES,
  RUNNING_STALL_MINUTES,
  deriveSyncRequestState,
};

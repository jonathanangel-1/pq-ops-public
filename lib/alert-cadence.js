"use strict";

// Alert cadence / escalation timeline. Interrupts must interrupt ONCE, then
// follow a schedule — never a toast per refresh.
//
// Every alertable issue carries a schedule record:
//   { key, materialKey, firstSeenAt, lastAlertedAt, alertCount, nextAlertAt,
//     escalationLevel, acknowledgedAt, snoozedUntil, resolvedAt }
//
// Rules:
//   - first critical event alerts immediately
//   - unresolved -> remind after remindMinutes
//   - still unresolved after escalateMinutes -> escalationLevel 1 (wording
//     escalates), stays PINNED but stops repeating toasts
//   - a material change (new cause/message) may alert again
//   - acknowledge/open suppresses toasts until nextAlertAt
//   - resolve clears the schedule
//   - waiting-on-outside-party issues don't re-alert unless the SLA expires

const DEFAULT_CONFIG = {
  remindMinutes: 30,
  escalateMinutes: 60,
  waitingSlaMinutes: 120,
};

function ms(iso) {
  const parsed = Date.parse(iso || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutesBetween(fromIso, toIso) {
  const from = ms(fromIso);
  const to = ms(toIso);
  if (!from || !to) return null;
  return Math.round((to - from) / 60000);
}

function materialKeyFor(issue = {}) {
  return [issue.kind || "", issue.cause || "", String(issue.message || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120)].join("|");
}

// issue: { id, kind, cause, message, resolved (bool), waitingOnExternal (bool) }
// prior: the previous schedule record for this key (or null)
// Returns the next schedule record plus shouldToast / pinned flags.
function nextAlertState(issue = {}, prior = null, now = new Date().toISOString(), config = DEFAULT_CONFIG) {
  const remindMs = (config.remindMinutes ?? DEFAULT_CONFIG.remindMinutes) * 60000;
  const escalateMs = (config.escalateMinutes ?? DEFAULT_CONFIG.escalateMinutes) * 60000;
  const slaMs = (config.waitingSlaMinutes ?? DEFAULT_CONFIG.waitingSlaMinutes) * 60000;
  const nowMs = ms(now);
  const materialKey = materialKeyFor(issue);

  if (issue.resolved) {
    return {
      key: issue.id,
      materialKey,
      firstSeenAt: prior?.firstSeenAt || now,
      lastAlertedAt: prior?.lastAlertedAt || "",
      alertCount: prior?.alertCount || 0,
      nextAlertAt: "",
      escalationLevel: prior?.escalationLevel || 0,
      acknowledgedAt: prior?.acknowledgedAt || "",
      snoozedUntil: "",
      resolvedAt: prior?.resolvedAt || now,
      shouldToast: false,
      pinned: false,
    };
  }

  // Brand-new issue (or material change): alert immediately.
  const materiallyChanged = prior && prior.materialKey && prior.materialKey !== materialKey;
  if (!prior || materiallyChanged) {
    return {
      key: issue.id,
      materialKey,
      firstSeenAt: materiallyChanged ? prior.firstSeenAt : now,
      lastAlertedAt: now,
      alertCount: (prior?.alertCount || 0) + 1,
      nextAlertAt: new Date(nowMs + remindMs).toISOString(),
      escalationLevel: 0,
      acknowledgedAt: "",
      snoozedUntil: "",
      resolvedAt: "",
      shouldToast: true,
      pinned: true,
    };
  }

  const next = { ...prior, key: issue.id, materialKey, resolvedAt: "", pinned: true };
  const openForMs = nowMs - ms(prior.firstSeenAt);
  next.escalationLevel = openForMs >= escalateMs ? Math.max(1, prior.escalationLevel || 0) : (prior.escalationLevel || 0);

  const suppressedByAck = prior.acknowledgedAt && nowMs < ms(prior.nextAlertAt);
  const suppressedBySnooze = prior.snoozedUntil && nowMs < ms(prior.snoozedUntil);
  const reminderDue = prior.nextAlertAt && nowMs >= ms(prior.nextAlertAt);
  const waitingGate = issue.waitingOnExternal ? openForMs >= slaMs : true;
  const alreadyEscalated = (prior.escalationLevel || 0) >= 1;

  // After escalation the issue stays pinned but stops toasting; only a
  // material change (handled above) re-alerts it.
  if (reminderDue && !suppressedByAck && !suppressedBySnooze && waitingGate && !alreadyEscalated) {
    next.lastAlertedAt = now;
    next.alertCount = (prior.alertCount || 0) + 1;
    next.nextAlertAt = new Date(nowMs + remindMs).toISOString();
    next.shouldToast = true;
    return next;
  }
  next.shouldToast = false;
  return next;
}

function acknowledgeAlert(prior = null, now = new Date().toISOString(), config = DEFAULT_CONFIG) {
  if (!prior) return null;
  const remindMs = (config.remindMinutes ?? DEFAULT_CONFIG.remindMinutes) * 60000;
  return {
    ...prior,
    acknowledgedAt: now,
    nextAlertAt: new Date(ms(now) + remindMs).toISOString(),
    shouldToast: false,
  };
}

// Plain operator wording for age/cadence:
// "Open 2h · next reminder in 30m" / "Escalated · driver waiting 45m"
function cadenceLabel(record = null, now = new Date().toISOString()) {
  if (!record || !record.firstSeenAt) return "";
  const openMinutes = minutesBetween(record.firstSeenAt, now) ?? 0;
  const openLabel = openMinutes >= 60 ? `${Math.round(openMinutes / 6) / 10}h` : `${Math.max(1, openMinutes)}m`;
  if ((record.escalationLevel || 0) >= 1) {
    return `Escalated · waiting ${openLabel}`;
  }
  const untilNext = record.nextAlertAt ? minutesBetween(now, record.nextAlertAt) : null;
  const parts = [`Open ${openLabel}`];
  if (record.lastAlertedAt) {
    const since = minutesBetween(record.lastAlertedAt, now);
    if (since != null && since >= 0) parts.push(`last alerted ${since <= 1 ? "just now" : `${since}m ago`}`);
  }
  if (untilNext != null && untilNext > 0) parts.push(`next reminder in ${untilNext}m`);
  return parts.join(" · ");
}

module.exports = {
  DEFAULT_CONFIG,
  materialKeyFor,
  nextAlertState,
  acknowledgeAlert,
  cadenceLabel,
};

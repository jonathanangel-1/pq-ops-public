"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeAwb } = require("./awb");
const { callSupabaseRpc, loadAppSnapshot } = require("./supabase-agent");

let webPush = null;
try {
  webPush = require("web-push");
} catch {
  webPush = null;
}

const PUSHABLE_EVENT_TYPES = new Set([
  "morning-report",
  "pickup-location-requested",
  "pickup-docs-needed",
  "driver-waiting",
  "station-cargo-not-found",
  "station-release-not-visible",
  "airline-transmission-blocker",
  "piece-count-mismatch",
  "storage-or-detention-cost",
  "pickup-onsite",
  "pickup-loaded",
  "delivered-pod-received",
  "delivered-pod-missing",
  "caught-customs-contested",
  "caught-arrival-unverified",
  "caught-arrival-source-conflict",
  "caught-dispatch-customs-unknown",
]);

// These are conditions, not positive lifecycle transitions. When the current
// operational ledger no longer emits one, its durable operator event must leave
// active surfaces. Positive/history events such as pickup-loaded, release-received,
// and fees-paid deliberately stay outside this set.
const AUTO_RESOLVABLE_LEDGER_CONDITION_TYPES = new Set([
  "airline-transmission-blocker",
  "awb-copy-needed",
  "broker-release-pending",
  "customs-hold",
  "delivered-pod-missing",
  "delivery-facility-closed",
  "driver-waiting",
  "inbond-rejected",
  "loading-problem",
  "pickup-docs-needed",
  "pickup-location-requested",
  "piece-count-mismatch",
  "station-cargo-not-found",
  "station-release-not-visible",
  "storage-needed-after-delivery-blocker",
  "storage-or-detention-cost",
  "wrong-consignee-delivery",
]);

function syncToken() {
  const token = process.env.PQ_SUPABASE_SYNC_TOKEN || "";
  if (!token) throw new Error("Missing PQ_SUPABASE_SYNC_TOKEN");
  return token;
}

function stableString(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeIso(value, fallback = new Date()) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback.toISOString();
}

function eventTimeMs(event) {
  const parsed = Date.parse(event?.occurredAt || event?.createdAt || event?.occurred_at || event?.created_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function operatorEventConditionKey(event) {
  const explicit = stableString(event?.conditionKey || event?.source?.conditionKey);
  if (explicit) return explicit;
  const awb = normalizeAwb(event?.awb || event?.source?.awb || "");
  const type = stableString(event?.eventType || event?.type || "operator-event").toLowerCase();
  return awb && type ? `${awb}:${type}` : stableString(event?.eventId || event?.id || "");
}

function mergeOperatorEventCondition(previous, incoming) {
  if (!previous) return incoming;
  const previousTime = eventTimeMs(previous);
  const incomingTime = eventTimeMs(incoming);
  const first = previousTime && incomingTime && incomingTime < previousTime ? incoming : previous;
  const latest = incomingTime >= previousTime ? incoming : previous;
  return {
    ...first,
    ...latest,
    eventId: first.eventId || first.id || latest.eventId || latest.id,
    id: first.id || first.eventId || latest.id || latest.eventId,
    source: latest.source || first.source || {},
  };
}

function eventPushAllowed(event) {
  const type = String(event?.eventType || event?.type || "").toLowerCase();
  return PUSHABLE_EVENT_TYPES.has(type);
}

function operatorEventFromNotification(notification, now = new Date()) {
  if (!notification?.id || !notification?.awb) return null;
  const eventType = stableString(notification.type || notification.eventType || "operator-event");
  const notificationSeverity = stableString(notification.severity || "work").toLowerCase();
  const severity = notificationSeverity === "needs-action" ? "work" : notificationSeverity;
  const event = {
    eventId: stableString(notification.id),
    id: stableString(notification.id),
    awb: notification.awb,
    normalizedAwb: normalizeAwb(notification.awb),
    eventType,
    type: eventType,
    conditionKey: stableString(notification.conditionKey || notification.source?.conditionKey),
    severity,
    notificationSeverity,
    status: stableString(notification.status || "active").toLowerCase(),
    title: stableString(notification.title || "Shipment update"),
    subtitle: stableString(notification.subtitle || notification.awb),
    message: stableString(notification.message || notification.title || "Shipment needs attention."),
    nextAction: stableString(notification.nextAction || "Open Rowan and decide the next move."),
    occurredAt: safeIso(notification.occurredAt || notification.createdAt, now),
    createdAt: safeIso(notification.createdAt || notification.occurredAt, now),
    source: {
      ...(notification.source || {}),
      ...(notificationSeverity !== severity ? { notificationSeverity } : {}),
    },
    pushAllowed: eventPushAllowed(notification),
  };
  return event;
}

function operatorEventsFromNotificationsSnapshot(snapshot, now = new Date()) {
  const byCondition = new Map();
  for (const notification of snapshot?.notifications || []) {
    const event = operatorEventFromNotification(notification, now);
    if (!event?.eventId) continue;
    const key = operatorEventConditionKey(event);
    byCondition.set(key, mergeOperatorEventCondition(byCondition.get(key), event));
  }
  const byId = new Map();
  for (const event of byCondition.values()) {
    if (event?.eventId) byId.set(event.eventId, event);
  }
  return [...byId.values()];
}

function packetDerivedCaughtCondition(notification = {}) {
  const type = stableString(notification.type || notification.eventType).toLowerCase();
  const source = stableString(notification.source?.source).toLowerCase();
  return type.startsWith("caught-") &&
    source === "shipment-truth-packet" &&
    Boolean(operatorEventConditionKey(notification));
}

function ledgerDerivedCondition(notification = {}) {
  const type = stableString(notification.type || notification.eventType).toLowerCase();
  const source = stableString(notification.source?.source).toLowerCase();
  return source === "operational-fact-ledger" &&
    AUTO_RESOLVABLE_LEDGER_CONDITION_TYPES.has(type) &&
    Boolean(operatorEventConditionKey(notification));
}

function reconcilableDerivedCondition(notification = {}) {
  return packetDerivedCaughtCondition(notification) || ledgerDerivedCondition(notification);
}

function reconcileClearedCaughtNotifications(currentSnapshot = {}, previousSnapshot = {}, now = new Date()) {
  const currentNotifications = Array.isArray(currentSnapshot.notifications)
    ? currentSnapshot.notifications
    : [];
  const currentConditionKeys = new Set(
    currentNotifications
      .filter(reconcilableDerivedCondition)
      .map(operatorEventConditionKey)
      .filter(Boolean),
  );
  const clearedAt = now.toISOString();
  const previousByCondition = new Map();
  for (const notification of previousSnapshot.notifications || []) {
    if (!reconcilableDerivedCondition(notification)) continue;
    if (stableString(notification.status || "active").toLowerCase() !== "active") continue;
    const conditionKey = operatorEventConditionKey(notification);
    if (conditionKey) previousByCondition.set(conditionKey, notification);
  }
  const clearedNotifications = [...previousByCondition.values()]
    .filter((notification) => !currentConditionKeys.has(operatorEventConditionKey(notification)))
    .map((notification) => {
      const packetCondition = packetDerivedCaughtCondition(notification);
      return {
        ...notification,
        status: "dismissed",
        clearedAt,
        source: {
          ...(notification.source || {}),
          clearedAt,
          clearedReason: packetCondition
            ? "condition-absent-from-current-canonical-packet"
            : "condition-absent-from-current-operational-ledger",
          resolutionMode: packetCondition
            ? "canonical-condition-cleared"
            : "operational-ledger-condition-cleared",
        },
      };
    });
  return {
    ...currentSnapshot,
    notifications: [...currentNotifications, ...clearedNotifications],
    clearedCaughtNotificationCount: clearedNotifications.length,
  };
}

async function loadPersistedCaughtNotifications(env = process.env) {
  if (!env.PQ_SUPABASE_SYNC_TOKEN) return [];
  try {
    const events = await callSupabaseRpc("list_operator_events", {
      p_limit: 200,
      p_sync_token: env.PQ_SUPABASE_SYNC_TOKEN,
    }, {
      timeoutMs: Number(env.PQ_OPERATOR_EVENTS_RPC_TIMEOUT_MS || 2500),
      retryDelaysMs: [],
    });
    return (Array.isArray(events) ? events : []).map((event) => ({
      ...(event.payload && typeof event.payload === "object" ? event.payload : {}),
      ...event,
      id: event.eventId || event.event_id || event.id || "",
      eventId: event.eventId || event.event_id || event.id || "",
      conditionKey: event.conditionKey || event.condition_key || event.source?.conditionKey || "",
      eventType: event.eventType || event.event_type || event.type || "",
      type: event.eventType || event.event_type || event.type || "",
      source: event.source || event.payload?.source || {},
    })).filter(reconcilableDerivedCondition);
  } catch {
    return [];
  }
}

async function upsertOperatorEvents(events) {
  if (!events?.length) return { ok: true, eventCount: 0, queuedPushCount: 0 };
  return callSupabaseRpc("upsert_operator_events", {
    p_events: events,
    p_sync_token: syncToken(),
  });
}

async function upsertOperatorEventsFromNotificationsSnapshot(snapshot, now = new Date(), options = {}) {
  const persistedNotifications = Array.isArray(options.persistedNotifications)
    ? options.persistedNotifications
    : await loadPersistedCaughtNotifications(options.env || process.env);
  const reconciledSnapshot = reconcileClearedCaughtNotifications(
    snapshot,
    {
      notifications: [
        ...(options.previousSnapshot?.notifications || []),
        ...persistedNotifications,
      ],
    },
    now,
  );
  const events = operatorEventsFromNotificationsSnapshot(reconciledSnapshot, now);
  const result = await upsertOperatorEvents(events);
  return {
    ...result,
    inputEventCount: events.length,
    clearedCaughtEventCount: reconciledSnapshot.clearedCaughtNotificationCount || 0,
  };
}

function webPushConfig(env = process.env, transport = webPush) {
  const publicKey = env.PQ_WEB_PUSH_PUBLIC_KEY || env.VAPID_PUBLIC_KEY || "";
  const privateKey = env.PQ_WEB_PUSH_PRIVATE_KEY || env.VAPID_PRIVATE_KEY || "";
  const subject = env.PQ_WEB_PUSH_SUBJECT || env.VAPID_SUBJECT || "mailto:contact-052@demo-freight.example";
  return {
    available: Boolean(transport && publicKey && privateKey),
    hasLibrary: Boolean(transport),
    publicKey,
    privateKey,
    subject,
    missing: [
      transport ? "" : "web-push dependency",
      publicKey ? "" : "PQ_WEB_PUSH_PUBLIC_KEY",
      privateKey ? "" : "PQ_WEB_PUSH_PRIVATE_KEY",
    ].filter(Boolean),
  };
}

function operatorPushReadiness(env = process.env, transport = webPush) {
  const cfg = webPushConfig(env, transport);
  const missing = [
    ...cfg.missing,
    env.PQ_SUPABASE_URL ? "" : "PQ_SUPABASE_URL",
    (env.PQ_SUPABASE_SERVICE_ROLE_KEY || env.PQ_SUPABASE_ANON_KEY)
      ? ""
      : "PQ_SUPABASE_SERVICE_ROLE_KEY or PQ_SUPABASE_ANON_KEY",
    env.PQ_SUPABASE_SYNC_TOKEN ? "" : "PQ_SUPABASE_SYNC_TOKEN",
    env.CRON_SECRET ? "" : "CRON_SECRET",
  ].filter(Boolean);
  return {
    ...cfg,
    ready: missing.length === 0,
    status: missing.length === 0 ? "ready" : "not-ready",
    missing,
  };
}

function publicPushConfig(env = process.env) {
  const readiness = operatorPushReadiness(env);
  return {
    enabled: readiness.ready,
    publicKey: readiness.publicKey,
    missing: readiness.missing,
    health: {
      status: readiness.status,
      ready: readiness.ready,
      missing: readiness.missing,
    },
  };
}

function deviceIdForSubscription(subscription) {
  const endpoint = subscription?.endpoint || "";
  if (!endpoint) return "";
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

async function upsertOperatorPushSubscription(subscription, options = {}) {
  const payload = {
    ...subscription,
    deviceId: options.deviceId || subscription?.deviceId || deviceIdForSubscription(subscription),
    label: options.label || subscription?.label || "Rowan PWA",
    userAgent: options.userAgent || subscription?.userAgent || "",
  };
  return callSupabaseRpc("upsert_operator_push_subscription", {
    p_subscription: payload,
    p_sync_token: syncToken(),
  });
}

async function readLocalOperatorNotifications(rootDir = process.cwd()) {
  try {
    return JSON.parse(await fs.readFile(path.join(rootDir, "operator-notifications.json"), "utf8"));
  } catch {
    return { notifications: [] };
  }
}

async function activeAwbSetForOperatorEvents(rootDir = process.cwd(), env = process.env, options = {}) {
  let active = null;
  try {
    active = JSON.parse(await fs.readFile(path.join(rootDir, "shipment-truth-packets.json"), "utf8"));
  } catch {
    active = null;
  }
  if (!active && !options.skipRemoteSnapshot && env.PQ_SUPABASE_URL && (env.PQ_SUPABASE_SERVICE_ROLE_KEY || env.PQ_SUPABASE_ANON_KEY)) {
    active = await loadAppSnapshot("shipment-truth-packets", { shipments: [] }).catch(() => null);
  }
  if (!active) active = { shipments: [] };
  return new Set((active?.shipments || [])
    .filter((shipment) => !shipment.truthPacketRole || shipment.truthPacketRole === "active")
    .map((shipment) => normalizeAwb(shipment.awb || shipment.trackingNumber || shipment.id || shipment.shipmentId))
    .filter(Boolean));
}

async function localOperatorEvents(limit = 40, options = {}, activeAwbs = null) {
  const snapshot = await readLocalOperatorNotifications(options.rootDir || process.cwd());
  return operatorEventsFromNotificationsSnapshot(snapshot)
    .sort((a, b) => Date.parse(b.occurredAt || b.createdAt || "") - Date.parse(a.occurredAt || a.createdAt || ""))
    .map((event) => sanitizeOperatorEventForActiveInventory(event, activeAwbs))
    .filter(Boolean)
    .slice(0, limit);
}

function pruneInactiveShipmentPayload(value, activeAwbs) {
  if (!value || !activeAwbs?.size) return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => pruneInactiveShipmentPayload(item, activeAwbs))
      .filter((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return true;
        const awb = normalizeAwb(item.awb || item.normalizedAwb || "");
        return !awb || activeAwbs.has(awb);
      });
  }
  if (typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = pruneInactiveShipmentPayload(item, activeAwbs);
  }
  return next;
}

function sanitizeOperatorEventForActiveInventory(event, activeAwbs) {
  const type = String(event?.eventType || event?.type || "").toLowerCase();
  if (!activeAwbs?.size) return event;
  if (type === "morning-report") return pruneInactiveShipmentPayload(event, activeAwbs);
  const awb = normalizeAwb(event?.awb || event?.normalizedAwb || event?.source?.awb || "");
  if (awb && !activeAwbs.has(awb)) return null;
  return event;
}

async function listOperatorEvents(limit = 40, options = {}) {
  const env = options.env || process.env;
  const token = env.PQ_SUPABASE_SYNC_TOKEN || "";
  const activeAwbs = await activeAwbSetForOperatorEvents(options.rootDir || process.cwd(), env, {
    skipRemoteSnapshot: options.skipRemoteActiveAwbSnapshot !== false,
  });
  if (!token) {
    return localOperatorEvents(limit, options, activeAwbs);
  }
  let events = [];
  try {
    events = await callSupabaseRpc("list_operator_events", {
      p_limit: limit,
      p_sync_token: token,
    }, {
      timeoutMs: Number(env.PQ_OPERATOR_EVENTS_RPC_TIMEOUT_MS || 2500),
      retryDelaysMs: [],
    });
  } catch {
    return localOperatorEvents(limit, options, activeAwbs);
  }
  return (Array.isArray(events) ? events : [])
    .map((event) => sanitizeOperatorEventForActiveInventory(event, activeAwbs))
    .filter(Boolean);
}

async function recordOperatorEventAction(eventId, actionType, payload = {}) {
  if (!eventId) return { ok: true, skipped: true, reason: "No operator event id" };
  return callSupabaseRpc("record_operator_event_action", {
    p_event_id: eventId,
    p_action_type: actionType,
    p_payload: payload,
    p_sync_token: syncToken(),
  });
}

function pushPayloadForClaim(claim) {
  const event = claim.event || {};
  const awb = event.awb || "";
  const title = event.title || "Rowan";
  const body = event.message || event.nextAction || "Shipment needs attention.";
  const eventId = event.eventId || event.id || claim.eventId || "";
  const eventType = event.eventType || event.type || "";
  const params = new URLSearchParams();
  if (eventId) params.set("notification", eventId);
  if (awb) params.set("awb", awb);
  if (eventType) params.set("type", eventType);
  return {
    type: "operator-event",
    eventId,
    awb,
    title,
    body,
    url: `/${params.toString() ? `?${params.toString()}` : ""}`,
    tag: eventId || awb || "operator-event",
    data: event,
  };
}

function pushTopicForTag(tag) {
  const value = stableString(tag || "operator-event");
  return crypto.createHash("sha256").update(value).digest("base64url").slice(0, 32);
}

function pushUrgencyForEvent(event) {
  const severity = String(event?.severity || "").toLowerCase();
  if (severity === "immediate" || severity === "urgent") return "high";
  if (severity === "today") return "normal";
  return "low";
}

async function sendWebPushClaim(claim, options = {}) {
  const transport = options.webPush || webPush;
  const cfg = webPushConfig(options.env || process.env, transport);
  if (!cfg.available) {
    return {
      ok: false,
      skipped: true,
      error: `Web push is not configured: ${cfg.missing.join(", ")}`,
    };
  }
  transport.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
  const payload = pushPayloadForClaim(claim);
  const subscription = {
    endpoint: claim.endpoint,
    keys: claim.keys || {},
  };
  const response = await transport.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 60 * 60,
    urgency: pushUrgencyForEvent(claim.event),
    topic: pushTopicForTag(payload.tag),
  });
  const statusCode = Number(response?.statusCode || response?.status || 0) || null;
  return { ok: true, payload, statusCode };
}

function webPushStatusCode(error) {
  return Number(
    error?.statusCode ||
    error?.status ||
    error?.response?.statusCode ||
    error?.response?.status ||
    0,
  ) || null;
}

async function completeOperatorPushOutbox(outboxId, status, error = "") {
  return callSupabaseRpc("complete_operator_push_outbox", {
    p_outbox_id: outboxId,
    p_status: status,
    p_error: error,
    p_sync_token: syncToken(),
  });
}

async function revokeOperatorPushSubscription(subscriptionId, outboxId, reason = "") {
  return callSupabaseRpc("revoke_operator_push_subscription", {
    p_subscription_id: subscriptionId,
    p_outbox_id: outboxId,
    p_error: stableString(reason).slice(0, 2000),
    p_sync_token: syncToken(),
  });
}

async function claimOperatorPushOutbox(limit = 20) {
  return callSupabaseRpc("claim_operator_push_outbox", {
    p_limit: limit,
    p_sync_token: syncToken(),
  });
}

async function deliverPendingOperatorPushes(options = {}) {
  const readiness = operatorPushReadiness(
    options.env || process.env,
    options.webPush || webPush,
  );
  if (!readiness.ready && !options.claimWhenUnconfigured) {
    return {
      ok: true,
      configured: false,
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      missing: readiness.missing,
      health: {
        status: "not-ready",
        ready: false,
        missing: readiness.missing,
      },
      results: [],
    };
  }
  const claimPushes = options.claimOperatorPushOutbox || claimOperatorPushOutbox;
  const completePush = options.completeOperatorPushOutbox || completeOperatorPushOutbox;
  const revokeSubscription = options.revokeOperatorPushSubscription || revokeOperatorPushSubscription;
  const sendPush = options.sendWebPushClaim || sendWebPushClaim;
  const claims = await claimPushes(options.limit || 20);
  const activeAwbs = options.activeAwbs instanceof Set
    ? options.activeAwbs
    : await activeAwbSetForOperatorEvents(
        options.rootDir || process.cwd(),
        options.env || process.env,
      ).catch(() => new Set());
  const results = [];
  for (const claim of Array.isArray(claims) ? claims : []) {
    const event = sanitizeOperatorEventForActiveInventory(claim.event || {}, activeAwbs);
    if (!event) {
      await completePush(claim.outboxId, "skipped", "Shipment is no longer active");
      results.push({ outboxId: claim.outboxId, sent: false, skipped: true, error: "Shipment is no longer active" });
      continue;
    }
    const safeClaim = { ...claim, event };
    if (options.dryRun) {
      results.push({ outboxId: claim.outboxId, dryRun: true, payload: pushPayloadForClaim(safeClaim) });
      continue;
    }
    try {
      const result = await sendPush(safeClaim, options);
      if (result.ok) {
        await completePush(claim.outboxId, "sent", "");
        results.push({
          outboxId: claim.outboxId,
          sent: true,
          statusCode: result.statusCode,
          payload: result.payload,
        });
      } else {
        await completePush(claim.outboxId, result.skipped ? "skipped" : "failed", result.error || "Push failed");
        results.push({ outboxId: claim.outboxId, sent: false, skipped: Boolean(result.skipped), error: result.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = webPushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        let revokeError = "";
        try {
          await revokeSubscription(
            claim.subscriptionId,
            claim.outboxId,
            `Web Push endpoint returned HTTP ${statusCode}: ${message}`,
          );
        } catch (subscriptionError) {
          revokeError = subscriptionError instanceof Error
            ? subscriptionError.message
            : String(subscriptionError);
        }
        const finalError = revokeError
          ? `${message}; subscription revocation failed: ${revokeError}`
          : message;
        if (revokeError) {
          await completePush(claim.outboxId, "failed", finalError);
        }
        results.push({
          outboxId: claim.outboxId,
          subscriptionId: claim.subscriptionId,
          sent: false,
          skipped: !revokeError,
          revoked: !revokeError,
          statusCode,
          error: finalError,
        });
        continue;
      }
      await completePush(claim.outboxId, "failed", message);
      results.push({ outboxId: claim.outboxId, sent: false, statusCode, error: message });
    }
  }
  return {
    ok: true,
    configured: true,
    health: {
      status: "ready",
      ready: true,
      missing: [],
    },
    claimed: Array.isArray(claims) ? claims.length : 0,
    sent: results.filter((item) => item.sent).length,
    failed: results.filter((item) => item.error && !item.skipped).length,
    skipped: results.filter((item) => item.skipped).length,
    results,
  };
}

module.exports = {
  deliverPendingOperatorPushes,
  eventPushAllowed,
  listOperatorEvents,
  operatorEventFromNotification,
  operatorEventsFromNotificationsSnapshot,
  publicPushConfig,
  pushPayloadForClaim,
  pushTopicForTag,
  recordOperatorEventAction,
  revokeOperatorPushSubscription,
  sendWebPushClaim,
  upsertOperatorEvents,
  upsertOperatorEventsFromNotificationsSnapshot,
  upsertOperatorPushSubscription,
  webPushConfig,
  _test: {
    AUTO_RESOLVABLE_LEDGER_CONDITION_TYPES,
    PUSHABLE_EVENT_TYPES,
    deviceIdForSubscription,
    operatorPushReadiness,
    loadPersistedCaughtNotifications,
    ledgerDerivedCondition,
    packetDerivedCaughtCondition,
    pruneInactiveShipmentPayload,
    pushTopicForTag,
    reconcileClearedCaughtNotifications,
    reconcilableDerivedCondition,
    sanitizeOperatorEventForActiveInventory,
    webPushStatusCode,
  },
};

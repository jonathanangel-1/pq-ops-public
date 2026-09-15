"use strict";

const { isAbortSignal, throwIfAborted } = require("./runtime-deadline");

const crypto = require("crypto");

const DEFAULT_LEASE_TTL_SECONDS = 120;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_RESULTS = 500;
const HISTORY_TYPES = Object.freeze([
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
]);

const EVENT_SPECS = Object.freeze([
  Object.freeze({ field: "messagesAdded", eventType: "message_added", operation: "metadata_change" }),
  Object.freeze({ field: "messagesDeleted", eventType: "message_deleted", operation: "delete" }),
  Object.freeze({ field: "labelsAdded", eventType: "labels_added", operation: "metadata_change" }),
  Object.freeze({ field: "labelsRemoved", eventType: "labels_removed", operation: "metadata_change" }),
]);

class GmailIncrementalSyncError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailIncrementalSyncError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailIncrementalSyncError(`Invalid Gmail incremental sync argument ${field}: ${reason}`, {
    code: "GMAIL_INCREMENTAL_SYNC_INVALID_ARGUMENT",
    field,
  });
}

function protocolError(field, reason) {
  return new GmailIncrementalSyncError(`Invalid Gmail History response ${field}: ${reason}`, {
    code: "GMAIL_INCREMENTAL_SYNC_PROTOCOL_ERROR",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, { unorderedArrays = false } = {}) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument("hashInput", "must not contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalize(item, { unorderedArrays }));
    if (unorderedArrays) {
      items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    }
    return items;
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      result[key] = canonicalize(value[key], { unorderedArrays });
    }
    return result;
  }
  throw invalidArgument("hashInput", "must contain only JSON-compatible values");
}

function stableJson(value, options = {}) {
  return JSON.stringify(canonicalize(value, options));
}

function sha256(value, options = {}) {
  return crypto.createHash("sha256").update(stableJson(value, options), "utf8").digest("hex");
}

function stringId(value, field, { allowEmpty = false } = {}) {
  let result;
  if (typeof value === "string") {
    result = value;
  } else if (typeof value === "bigint") {
    result = value.toString(10);
  } else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    result = String(value);
  } else {
    throw protocolError(field, "must be a string ID (or a losslessly convertible integer)");
  }
  if (!allowEmpty && result.length === 0) throw protocolError(field, "must not be empty");
  if (result.trim() !== result) throw protocolError(field, "must not contain surrounding whitespace");
  return result;
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw protocolError(field, "must be a string");
  return value;
}

function sortedStringIds(values, field) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw protocolError(field, "must be an array");
  return [...new Set(values.map((value, index) => stringId(value, `${field}[${index}]`)))].sort();
}

function compareDecimalIds(left, right) {
  const leftDecimal = /^\d+$/.test(left);
  const rightDecimal = /^\d+$/.test(right);
  if (!leftDecimal || !rightDecimal) return left.localeCompare(right);
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length - normalizedRight.length;
  return normalizedLeft.localeCompare(normalizedRight);
}

function insertUnique(map, key, value, label) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, value);
    return;
  }
  if (stableJson(existing, { unorderedArrays: true }) !== stableJson(value, { unorderedArrays: true })) {
    throw new GmailIncrementalSyncError(`${label} identity collision`, {
      code: "GMAIL_INCREMENTAL_SYNC_IDENTITY_COLLISION",
      identity: key,
    });
  }
}

function normalizeHistoryPage(responseInput, scopeInput = {}) {
  if (!isPlainObject(responseInput)) throw protocolError("response", "must be an object");
  const scope = isPlainObject(scopeInput) ? scopeInput : {};
  const workspaceKey = typeof scope.workspaceKey === "string" && scope.workspaceKey
    ? scope.workspaceKey
    : "primary";
  const connectionKey = typeof scope.connectionKey === "string" && scope.connectionKey
    ? scope.connectionKey
    : "default";
  const responseMailboxHistoryId = stringId(responseInput.historyId, "response.historyId");
  const responseNextPageToken = optionalString(responseInput.nextPageToken, "response.nextPageToken");
  const history = responseInput.history === undefined || responseInput.history === null
    ? []
    : responseInput.history;
  if (!Array.isArray(history)) throw protocolError("response.history", "must be an array");

  const observationsById = new Map();
  const jobsByKey = new Map();
  const providerEventsById = new Map();
  const historyIds = [];

  history.forEach((entry, historyIndex) => {
    if (!isPlainObject(entry)) throw protocolError(`response.history[${historyIndex}]`, "must be an object");
    const historyId = stringId(entry.id, `response.history[${historyIndex}].id`);
    historyIds.push(historyId);

    for (const spec of EVENT_SPECS) {
      const rows = entry[spec.field] === undefined || entry[spec.field] === null ? [] : entry[spec.field];
      if (!Array.isArray(rows)) {
        throw protocolError(`response.history[${historyIndex}].${spec.field}`, "must be an array");
      }
      rows.forEach((row, rowIndex) => {
        if (!isPlainObject(row) || !isPlainObject(row.message)) {
          throw protocolError(
            `response.history[${historyIndex}].${spec.field}[${rowIndex}].message`,
            "must be an object",
          );
        }
        const messageId = stringId(
          row.message.id,
          `response.history[${historyIndex}].${spec.field}[${rowIndex}].message.id`,
        );
        const threadId = row.message.threadId === undefined || row.message.threadId === null
          ? ""
          : stringId(
            row.message.threadId,
            `response.history[${historyIndex}].${spec.field}[${rowIndex}].message.threadId`,
            { allowEmpty: true },
          );
        const messageLabelIds = sortedStringIds(
          row.message.labelIds,
          `response.history[${historyIndex}].${spec.field}[${rowIndex}].message.labelIds`,
        );
        const changedLabelIds = sortedStringIds(
          row.labelIds,
          `response.history[${historyIndex}].${spec.field}[${rowIndex}].labelIds`,
        );
        const providerEventPayload = {
          schemaVersion: "gmail-history-event-v1",
          eventType: spec.eventType,
          historyId,
          messageId,
          threadId,
          messageLabelIds,
          changedLabelIds,
        };
        const eventId = `gmail-event:v1:${sha256(providerEventPayload, { unorderedArrays: true })}`;
        const providerEvent = { eventId, ...providerEventPayload };
        insertUnique(providerEventsById, eventId, providerEvent, "Gmail provider event");
        const normalizedPayload = {
          ...providerEventPayload,
          eventId,
        };
        const contentHash = sha256(normalizedPayload, { unorderedArrays: true });
        const sourceRevision = `history:${historyId}:${spec.eventType}:${contentHash}`;
        const identity = {
          schemaVersion: "source-observation-identity-v1",
          workspaceKey,
          sourceSystem: "gmail",
          connectionKey,
          sourceObjectType: "gmail_message_history_event",
          sourceObjectId: messageId,
          sourceRevision,
          operation: spec.operation,
          contentHash,
        };
        const observationId = `obs:v1:${sha256(identity, { unorderedArrays: true })}`;
        const observation = {
          observationId,
          sourceObjectType: identity.sourceObjectType,
          sourceObjectId: messageId,
          sourceRevision,
          operation: spec.operation,
          contentHash,
          normalizedPayload,
          normalizedText: "",
          sourceFidelity: "normalized_source",
          schemaVersion: "gmail-history-event-v1",
        };
        insertUnique(observationsById, observationId, observation, "Gmail history observation");

      });
    }
  });

  const orderedHistoryIds = [...historyIds].sort(compareDecimalIds);
  const observations = [...observationsById.values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId));
  const jobs = [...jobsByKey.values()].sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  const providerEvents = [...providerEventsById.values()].sort((left, right) =>
    left.eventId.localeCompare(right.eventId));
  return {
    responseMailboxHistoryId,
    responseNextPageToken,
    firstHistoryId: orderedHistoryIds[0] || "",
    lastHistoryId: orderedHistoryIds[orderedHistoryIds.length - 1] || "",
    providerResponse: canonicalize(responseInput, { unorderedArrays: true }),
    providerEvents,
    observations,
    jobs,
  };
}

function pageDigest({ pageOrdinal, requestPageToken, normalizedPage }) {
  return sha256({
    schemaVersion: "gmail-history-page-v1",
    pageOrdinal,
    requestPageToken,
    responseNextPageToken: normalizedPage.responseNextPageToken,
    responseMailboxHistoryId: normalizedPage.responseMailboxHistoryId,
    firstHistoryId: normalizedPage.firstHistoryId,
    lastHistoryId: normalizedPage.lastHistoryId,
    isFinal: normalizedPage.responseNextPageToken.length === 0,
    providerResponse: normalizedPage.providerResponse,
    providerEvents: normalizedPage.providerEvents,
    observations: normalizedPage.observations,
    jobs: normalizedPage.jobs,
  }, { unorderedArrays: true });
}

function isHistoryExpiredError(error) {
  return error?.code === "GMAIL_HISTORY_CURSOR_EXPIRED" ||
    error?.kind === "history-gap" ||
    (Number(error?.status) === 404 && error?.operation === "history.list");
}

function isLeaseLostError(error) {
  const code = String(error?.code || "").toUpperCase();
  return code === "40001" || code === "LEASE_LOST" || code === "SOURCE_SYNC_LEASE_LOST" ||
    /source sync lease lost|lease lost|compare-and-swap failed/i.test(String(error?.message || ""));
}

function requireDependency(object, field, methods) {
  if (!object || typeof object !== "object") throw invalidArgument(field, "must be an object");
  for (const method of methods) {
    if (typeof object[method] !== "function") throw invalidArgument(`${field}.${method}`, "must be a function");
  }
}

function safeInteger(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function receiptFailure(receipt, stage) {
  if (receipt?.ok) return null;
  const code = String(receipt?.code || "GMAIL_INCREMENTAL_SYNC_LEDGER_REJECTED");
  return new GmailIncrementalSyncError(`Mailbox ledger rejected ${stage}`, {
    code,
    stage,
  });
}

function leaseLostResult({ stage, batchId = "", startCursorValue = "", pagesPersistedThisRun = 0, error }) {
  return {
    ok: false,
    status: "lease_lost",
    reason: "lease_lost",
    stage,
    errorCode: String(error?.code || "LEASE_LOST"),
    batchId,
    startCursorValue,
    pagesPersistedThisRun,
    cursorAdvanced: false,
  };
}

function committedResult(commit, context) {
  return {
    ok: true,
    status: "committed",
    cursorAdvanced: true,
    resumed: context.resumed,
    batchId: String(commit.batchId || context.batchId),
    batchHash: String(commit.batchHash || ""),
    startCursorValue: context.startCursorValue,
    committedCursorValue: stringId(commit.committedCursorValue, "commit.committedCursorValue"),
    committedCursorVersion: commit.committedCursorVersion,
    pageCount: commit.pageCount,
    observationCount: commit.observationCount,
    jobCount: commit.jobCount,
    materializationRoutes: commit.materializationRoutes,
    pagesPersistedThisRun: context.pagesPersistedThisRun,
  };
}

async function runGmailIncrementalSync(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  const gmailClient = input.gmailClient;
  const ledger = input.ledger;
  requireDependency(gmailClient, "gmailClient", ["listHistory", "getProfile"]);
  requireDependency(ledger, "ledger", [
    "acquireLease",
    "renewLease",
    "beginBatch",
    "appendPage",
    "commitBatch",
    "markHistoryExpired",
  ]);

  const ownerId = typeof input.ownerId === "string" && input.ownerId.trim()
    ? input.ownerId.trim()
    : (() => { throw invalidArgument("ownerId", "must be a non-empty string"); })();
  const triggerName = input.triggerName === undefined ? "gmail-incremental-history" : String(input.triggerName);
  const leaseTtlSeconds = input.leaseTtlSeconds === undefined
    ? DEFAULT_LEASE_TTL_SECONDS
    : safeInteger(input.leaseTtlSeconds, "leaseTtlSeconds", { minimum: 15, maximum: 900 });
  const maxPages = input.maxPages === undefined
    ? DEFAULT_MAX_PAGES
    : safeInteger(input.maxPages, "maxPages");
  const maxResults = input.maxResults === undefined
    ? DEFAULT_MAX_RESULTS
    : safeInteger(input.maxResults, "maxResults", { minimum: 1, maximum: 500 });
  const now = input.now === undefined ? Date.now : input.now;
  if (typeof now !== "function") throw invalidArgument("now", "must be a function");
  const startedAtMs = Number(now());
  if (!Number.isFinite(startedAtMs)) throw invalidArgument("now", "must return a finite millisecond timestamp");
  const signal = input.signal ?? null;
  if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("signal", "must be an AbortSignal or null");
  let deadlineAtMs = Number.POSITIVE_INFINITY;
  if (input.deadlineAtMs !== undefined) {
    deadlineAtMs = Number(input.deadlineAtMs);
    if (!Number.isFinite(deadlineAtMs)) throw invalidArgument("deadlineAtMs", "must be finite");
  } else if (input.maxDurationMs !== undefined) {
    const maxDurationMs = safeInteger(input.maxDurationMs, "maxDurationMs");
    deadlineAtMs = startedAtMs + maxDurationMs;
  }
  throwIfAborted(signal, {
    stage: "Gmail incremental sync start",
    deadlineAtMs,
    now: () => startedAtMs,
  });

  let stage = "acquire_lease";
  let batchId = "";
  let startCursorValue = "";
  let pagesPersistedThisRun = 0;
  let leaseFence = 0;

  try {
    throwIfAborted(signal, { stage: "Gmail incremental lease acquisition", deadlineAtMs, now });
    const lease = await ledger.acquireLease({ ownerId, ttlSeconds: leaseTtlSeconds });
    if (!lease?.ok) {
      if (String(lease?.code || "") === "LEASE_BUSY") {
        return {
          ok: false,
          status: "lease_busy",
          reason: "lease_busy",
          cursorAdvanced: false,
          cursorValue: typeof lease.cursorValue === "string" ? lease.cursorValue : "",
          cursorVersion: lease.cursorVersion,
          leaseOwner: typeof lease.leaseOwner === "string" ? lease.leaseOwner : "",
          leaseExpiresAt: lease.leaseExpiresAt || null,
        };
      }
      throw receiptFailure(lease, stage);
    }
    leaseFence = lease.leaseFence;
    startCursorValue = stringId(lease.cursorValue, "lease.cursorValue", { allowEmpty: true });

    if (!startCursorValue || lease.status === "backfill_required") {
      return {
        ok: false,
        status: "backfill_required",
        reason: "history_cursor_missing",
        cursorAdvanced: false,
        cursorValue: startCursorValue,
        cursorVersion: lease.cursorVersion,
      };
    }
    if (lease.status === "reconcile_required") {
      return {
        ok: false,
        status: "reconcile_required",
        reason: "open_history_gap",
        cursorAdvanced: false,
        cursorValue: startCursorValue,
        cursorVersion: lease.cursorVersion,
      };
    }
    if (lease.status !== "live") {
      return {
        ok: false,
        status: "source_not_ready",
        reason: String(lease.status || "unknown"),
        cursorAdvanced: false,
        cursorValue: startCursorValue,
        cursorVersion: lease.cursorVersion,
      };
    }

    stage = "begin_batch";
    throwIfAborted(signal, { stage: "Gmail incremental begin batch", deadlineAtMs, now });
    const batch = await ledger.beginBatch({
      ownerId,
      leaseFence,
      mode: "history",
      triggerName,
    });
    if (!batch?.ok) throw receiptFailure(batch, stage);
    batchId = String(batch.batchId || "");
    if (!batchId) throw protocolError("batch.batchId", "must not be empty");
    const batchCursor = stringId(batch.startCursorValue, "batch.startCursorValue");
    if (batchCursor !== startCursorValue) {
      throw new GmailIncrementalSyncError("Lease and running-batch cursor disagree", {
        code: "GMAIL_INCREMENTAL_SYNC_CURSOR_MISMATCH",
        leaseCursorValue: startCursorValue,
        batchCursorValue: batchCursor,
      });
    }
    let pageOrdinal = safeInteger(batch.pageCount, "batch.pageCount");
    let requestPageToken = optionalString(batch.resumePageToken, "batch.resumePageToken");
    const resumed = pageOrdinal > 0;
    if (batch.finalPagePersisted && pageOrdinal === 0) {
      throw protocolError("batch.finalPagePersisted", "cannot be true for an empty batch");
    }
    if (pageOrdinal > 0 && !batch.finalPagePersisted && !requestPageToken) {
      throw protocolError("batch.resumePageToken", "must be present for an incomplete persisted page chain");
    }
    if (pageOrdinal === 0 && requestPageToken) {
      throw protocolError("batch.resumePageToken", "must be empty before the first persisted page");
    }

    const renew = async (renewStage) => {
      stage = renewStage;
      throwIfAborted(signal, {
        stage: `Gmail incremental ${renewStage}`,
        deadlineAtMs,
        now,
        outcomeUnknown: false,
      });
      const receipt = await ledger.renewLease({ ownerId, leaseFence, ttlSeconds: leaseTtlSeconds });
      if (!receipt?.ok) throw receiptFailure(receipt, renewStage);
      if (receipt.leaseFence !== leaseFence) {
        throw new GmailIncrementalSyncError("Mailbox ledger changed the active lease fence", {
          code: "SOURCE_SYNC_LEASE_LOST",
          stage: renewStage,
        });
      }
    };

    const commit = async () => {
      await renew("renew_before_commit");
      stage = "commit_batch";
      throwIfAborted(signal, { stage: "Gmail incremental commit batch", deadlineAtMs, now });
      const receipt = await ledger.commitBatch({ batchId, ownerId, leaseFence });
      if (!receipt?.ok) throw receiptFailure(receipt, stage);
      return committedResult(receipt, {
        batchId,
        startCursorValue,
        pagesPersistedThisRun,
        resumed,
      });
    };

    if (batch.finalPagePersisted) return await commit();

    while (true) {
      const nowMs = Number(now());
      if (!Number.isFinite(nowMs)) throw invalidArgument("now", "must return a finite millisecond timestamp");
      const reason = pagesPersistedThisRun >= maxPages
        ? "page_budget"
        : nowMs >= deadlineAtMs ? "deadline" : "";
      if (reason) {
        return {
          ok: true,
          status: "partial",
          reason,
          cursorAdvanced: false,
          batchId,
          startCursorValue,
          pageCount: pageOrdinal,
          pagesPersistedThisRun,
          resumePageToken: requestPageToken,
          resumed,
        };
      }

      let response;
      stage = "list_history";
      try {
        throwIfAborted(signal, { stage: "Gmail incremental history read", deadlineAtMs, now });
        response = await gmailClient.listHistory({
          startHistoryId: startCursorValue,
          ...(requestPageToken ? { pageToken: requestPageToken } : {}),
          maxResults,
          historyTypes: HISTORY_TYPES,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (!isHistoryExpiredError(error)) throw error;
        stage = "history_gap_profile";
        const profile = await gmailClient.getProfile(signal ? { signal } : {});
        const recoveryAnchorValue = stringId(profile?.historyId, "profile.historyId");
        await renew("renew_before_history_gap");
        stage = "mark_history_expired";
        throwIfAborted(signal, { stage: "Gmail incremental history gap write", deadlineAtMs, now });
        const gap = await ledger.markHistoryExpired({
          ownerId,
          leaseFence,
          priorCursorValue: startCursorValue,
          recoveryAnchorValue,
          detail: {
            schemaVersion: "gmail-history-gap-v1",
            detectedBy: "gmail-incremental-sync-v1",
            errorCode: String(error?.code || "GMAIL_HISTORY_CURSOR_EXPIRED"),
            operation: String(error?.operation || "history.list"),
          },
        });
        if (!gap?.ok) throw receiptFailure(gap, stage);
        return {
          ok: false,
          status: "reconcile_required",
          reason: "history_expired",
          cursorAdvanced: false,
          batchId,
          startCursorValue,
          recoveryAnchorValue,
          gapId: String(gap.gapId || ""),
          cursorVersion: gap.cursorVersion,
          pagesPersistedThisRun,
        };
      }

      const normalizedPage = normalizeHistoryPage(response, ledger.scope || {});
      const isFinal = normalizedPage.responseNextPageToken.length === 0;
      const digest = pageDigest({ pageOrdinal, requestPageToken, normalizedPage });

      // A Gmail request may consume most of the lease TTL. Renew after the
      // response and before making that response durable under the fence.
      await renew("renew_before_append");
      stage = "append_page";
      throwIfAborted(signal, { stage: "Gmail incremental append page", deadlineAtMs, now });
      const append = await ledger.appendPage({
        batchId,
        ownerId,
        leaseFence,
        page: {
          pageOrdinal,
          requestPageToken,
          responseNextPageToken: normalizedPage.responseNextPageToken,
          responseMailboxHistoryId: normalizedPage.responseMailboxHistoryId,
          firstHistoryId: normalizedPage.firstHistoryId,
          lastHistoryId: normalizedPage.lastHistoryId,
          eventDigest: digest,
          providerResponse: normalizedPage.providerResponse,
          providerEvents: normalizedPage.providerEvents,
          isFinal,
        },
        observations: normalizedPage.observations,
        jobs: normalizedPage.jobs,
      });
      if (!append?.ok) throw receiptFailure(append, stage);

      pagesPersistedThisRun += 1;
      pageOrdinal += 1;
      requestPageToken = normalizedPage.responseNextPageToken;
      if (isFinal) return await commit();
      // The next iteration checks deadline/page budget before another Gmail
      // call. The committed cursor therefore never moves for a bounded yield.
    }
  } catch (error) {
    if (isLeaseLostError(error)) {
      return leaseLostResult({ stage, batchId, startCursorValue, pagesPersistedThisRun, error });
    }
    throw error;
  }
}

function createGmailIncrementalSync(defaults = {}) {
  if (!isPlainObject(defaults)) throw invalidArgument("defaults", "must be an object");
  return Object.freeze({
    run(overrides = {}) {
      if (!isPlainObject(overrides)) throw invalidArgument("overrides", "must be an object");
      return runGmailIncrementalSync({ ...defaults, ...overrides });
    },
  });
}

module.exports = {
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  EVENT_SPECS,
  HISTORY_TYPES,
  GmailIncrementalSyncError,
  createGmailIncrementalSync,
  normalizeHistoryPage,
  runGmailIncrementalSync,
  _test: {
    canonicalize,
    compareDecimalIds,
    isHistoryExpiredError,
    isLeaseLostError,
    pageDigest,
    sha256,
    stableJson,
  },
};

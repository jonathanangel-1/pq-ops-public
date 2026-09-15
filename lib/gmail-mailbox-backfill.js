"use strict";

const { isAbortSignal, throwIfAborted } = require("./runtime-deadline");

const crypto = require("node:crypto");

const DEFAULT_LEASE_TTL_SECONDS = 120;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_RESULTS = 500;
const MODES = new Set(["backfill", "reconciliation"]);

class GmailMailboxBackfillError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailMailboxBackfillError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailMailboxBackfillError(`Invalid Gmail mailbox backfill argument ${field}: ${reason}`, {
    code: "GMAIL_MAILBOX_BACKFILL_INVALID_ARGUMENT",
    field,
  });
}

function protocolError(field, reason) {
  return new GmailMailboxBackfillError(`Invalid Gmail mailbox scan response ${field}: ${reason}`, {
    code: "GMAIL_MAILBOX_BACKFILL_PROTOCOL_ERROR",
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

function decimalHistoryId(value, field, { allowEmpty = false, requireString = false } = {}) {
  if (requireString && typeof value !== "string") {
    throw protocolError(field, "must be an exact decimal string");
  }
  const result = stringId(value, field, { allowEmpty });
  if (result && !/^\d+$/.test(result)) throw protocolError(field, "must be a decimal history ID string");
  return result;
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw protocolError(field, "must be a string");
  return value;
}

function compareDecimalIds(left, right) {
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
    throw new GmailMailboxBackfillError(`${label} identity collision`, {
      code: "GMAIL_MAILBOX_BACKFILL_IDENTITY_COLLISION",
      identity: key,
    });
  }
}

function normalizeMessageDiscoveryPage(responseInput, contextInput = {}) {
  if (!isPlainObject(responseInput)) throw protocolError("response", "must be an object");
  if (!isPlainObject(contextInput)) throw invalidArgument("context", "must be an object");
  const mode = contextInput.mode;
  if (!MODES.has(mode)) throw invalidArgument("context.mode", "must be backfill or reconciliation");
  const anchorHistoryId = decimalHistoryId(
    contextInput.anchorHistoryId,
    "context.anchorHistoryId",
    { requireString: true },
  );
  const scope = isPlainObject(contextInput.scope) ? contextInput.scope : {};
  const workspaceKey = typeof scope.workspaceKey === "string" && scope.workspaceKey
    ? scope.workspaceKey
    : "primary";
  const connectionKey = typeof scope.connectionKey === "string" && scope.connectionKey
    ? scope.connectionKey
    : "default";
  const responseNextPageToken = optionalString(responseInput.nextPageToken, "response.nextPageToken");
  const messagesInput = responseInput.messages === undefined || responseInput.messages === null
    ? []
    : responseInput.messages;
  if (!Array.isArray(messagesInput)) throw protocolError("response.messages", "must be an array");

  const messagesById = new Map();
  messagesInput.forEach((message, index) => {
    if (!isPlainObject(message)) throw protocolError(`response.messages[${index}]`, "must be an object");
    const messageId = stringId(message.id, `response.messages[${index}].id`);
    const threadId = message.threadId === undefined || message.threadId === null
      ? ""
      : stringId(message.threadId, `response.messages[${index}].threadId`, { allowEmpty: true });
    const existing = messagesById.get(messageId);
    if (existing && existing.threadId !== threadId) {
      throw new GmailMailboxBackfillError("Gmail returned one message ID under different thread IDs", {
        code: "GMAIL_MAILBOX_BACKFILL_MESSAGE_COORDINATE_CONFLICT",
        messageId,
      });
    }
    messagesById.set(messageId, { id: messageId, threadId });
  });
  const messages = [...messagesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id) || left.threadId.localeCompare(right.threadId));

  const providerEventsById = new Map();
  const observationsById = new Map();
  const jobsByKey = new Map();
  for (const message of messages) {
    const providerEventPayload = {
      schemaVersion: "gmail-mailbox-discovery-event-v1",
      eventType: "message_discovered",
      historyId: anchorHistoryId,
      messageId: message.id,
      threadId: message.threadId,
      discoveryMode: mode,
    };
    const eventId = `gmail-event:v1:${sha256(providerEventPayload, { unorderedArrays: true })}`;
    const providerEvent = { eventId, ...providerEventPayload };
    insertUnique(providerEventsById, eventId, providerEvent, "Gmail discovery event");

    const normalizedPayload = { ...providerEventPayload, eventId };
    const contentHash = sha256(normalizedPayload, { unorderedArrays: true });
    const sourceRevision = `discovery:${mode}:${anchorHistoryId}:${contentHash}`;
    const identity = {
      schemaVersion: "source-observation-identity-v1",
      workspaceKey,
      sourceSystem: "gmail",
      connectionKey,
      sourceObjectType: "gmail_message_discovery_event",
      sourceObjectId: message.id,
      sourceRevision,
      operation: "metadata_change",
      contentHash,
    };
    const observationId = `obs:v1:${sha256(identity, { unorderedArrays: true })}`;
    const observation = {
      observationId,
      sourceObjectType: identity.sourceObjectType,
      sourceObjectId: message.id,
      sourceRevision,
      operation: identity.operation,
      contentHash,
      normalizedPayload,
      normalizedText: "",
      sourceFidelity: "normalized_source",
      schemaVersion: "gmail-mailbox-discovery-event-v1",
    };
    insertUnique(observationsById, observationId, observation, "Gmail discovery observation");

  }

  const providerResponse = canonicalize({
    ...responseInput,
    historyId: anchorHistoryId,
    history: [],
    messages,
    ...(responseNextPageToken ? { nextPageToken: responseNextPageToken } : { nextPageToken: undefined }),
  }, { unorderedArrays: true });
  const providerEvents = [...providerEventsById.values()].sort((left, right) =>
    left.eventId.localeCompare(right.eventId));
  const observations = [...observationsById.values()].sort((left, right) =>
    left.observationId.localeCompare(right.observationId));
  const jobs = [...jobsByKey.values()].sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  return {
    responseMailboxHistoryId: anchorHistoryId,
    responseNextPageToken,
    firstHistoryId: messages.length ? anchorHistoryId : "",
    lastHistoryId: messages.length ? anchorHistoryId : "",
    providerResponse,
    providerEvents,
    observations,
    jobs,
  };
}

function pageDigest({ pageOrdinal, requestPageToken, normalizedPage }) {
  return sha256({
    schemaVersion: "gmail-mailbox-scan-page-v1",
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
  return new GmailMailboxBackfillError(`Mailbox ledger rejected ${stage}`, {
    code: String(receipt?.code || "GMAIL_MAILBOX_BACKFILL_LEDGER_REJECTED"),
    stage,
  });
}

function isLeaseLostError(error) {
  const code = String(error?.code || "").toUpperCase();
  return code === "40001" || code === "LEASE_LOST" || code === "SOURCE_SYNC_LEASE_LOST" ||
    /source sync lease lost|lease lost|compare-and-swap failed/i.test(String(error?.message || ""));
}

function leaseLostResult({ stage, mode, batchId, startCursorValue, anchorHistoryId, pagesPersistedThisRun, error }) {
  return {
    ok: false,
    status: "lease_lost",
    reason: "lease_lost",
    stage,
    mode,
    errorCode: String(error?.code || "LEASE_LOST"),
    batchId,
    startCursorValue,
    anchorHistoryId,
    pagesPersistedThisRun,
    cursorAdvanced: false,
  };
}

async function runGmailMailboxBackfill(input = {}) {
  if (!isPlainObject(input)) throw invalidArgument("input", "must be an object");
  const mode = input.mode;
  if (!MODES.has(mode)) throw invalidArgument("mode", "must be backfill or reconciliation");
  const gmailClient = input.gmailClient;
  const ledger = input.ledger;
  requireDependency(gmailClient, "gmailClient", ["listMessages", "getProfile"]);
  requireDependency(ledger, "ledger", ["acquireLease", "renewLease", "beginBatch", "appendPage", "commitBatch"]);

  const ownerId = typeof input.ownerId === "string" && input.ownerId.trim()
    ? input.ownerId.trim()
    : (() => { throw invalidArgument("ownerId", "must be a non-empty string"); })();
  const triggerName = input.triggerName === undefined ? `gmail-mailbox-${mode}` : String(input.triggerName);
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
    deadlineAtMs = startedAtMs + safeInteger(input.maxDurationMs, "maxDurationMs");
  }
  throwIfAborted(signal, {
    stage: "Gmail mailbox backfill start",
    deadlineAtMs,
    now: () => startedAtMs,
  });

  let stage = "acquire_lease";
  let batchId = "";
  let startCursorValue = "";
  let anchorHistoryId = "";
  let pagesPersistedThisRun = 0;
  let leaseFence = 0;

  try {
    throwIfAborted(signal, { stage: "Gmail mailbox backfill lease acquisition", deadlineAtMs, now });
    const lease = await ledger.acquireLease({ ownerId, ttlSeconds: leaseTtlSeconds });
    if (!lease?.ok) {
      if (String(lease?.code || "") === "LEASE_BUSY") {
        return {
          ok: false,
          status: "lease_busy",
          reason: "lease_busy",
          mode,
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
    startCursorValue = decimalHistoryId(lease.cursorValue, "lease.cursorValue", { allowEmpty: true });
    const requiredStatus = mode === "backfill" ? "backfill_required" : "reconcile_required";
    if (lease.status !== requiredStatus) {
      return {
        ok: false,
        status: "source_not_ready",
        reason: `mode_${mode}_requires_${requiredStatus}`,
        mode,
        cursorAdvanced: false,
        cursorValue: startCursorValue,
        cursorVersion: lease.cursorVersion,
      };
    }
    const leaseRecoveryAnchor = mode === "reconciliation"
      ? decimalHistoryId(lease.recoveryAnchorValue, "lease.recoveryAnchorValue", { requireString: true })
      : "";

    stage = "begin_batch";
    throwIfAborted(signal, { stage: "Gmail mailbox backfill begin batch", deadlineAtMs, now });
    const batch = await ledger.beginBatch({ ownerId, leaseFence, mode, triggerName });
    if (!batch?.ok) throw receiptFailure(batch, stage);
    batchId = String(batch.batchId || "");
    if (!batchId) throw protocolError("batch.batchId", "must not be empty");
    const batchCursor = decimalHistoryId(batch.startCursorValue, "batch.startCursorValue", { allowEmpty: true });
    if (batchCursor !== startCursorValue) {
      throw new GmailMailboxBackfillError("Lease and running-batch cursor disagree", {
        code: "GMAIL_MAILBOX_BACKFILL_CURSOR_MISMATCH",
      });
    }
    let pageOrdinal = safeInteger(batch.pageCount, "batch.pageCount");
    let requestPageToken = optionalString(batch.resumePageToken, "batch.resumePageToken");
    const persistedAnchor = decimalHistoryId(
      batch.responseMailboxHistoryId,
      "batch.responseMailboxHistoryId",
      { allowEmpty: true, requireString: true },
    );
    const resumed = pageOrdinal > 0;
    if (batch.finalPagePersisted && pageOrdinal === 0) {
      throw protocolError("batch.finalPagePersisted", "cannot be true for an empty batch");
    }
    if (pageOrdinal > 0 && !persistedAnchor) {
      throw protocolError("batch.responseMailboxHistoryId", "must preserve the scan anchor for a resumed batch");
    }
    if (pageOrdinal > 0 && !batch.finalPagePersisted && !requestPageToken) {
      throw protocolError("batch.resumePageToken", "must preserve the next page token for an incomplete scan");
    }
    if (pageOrdinal === 0 && (requestPageToken || persistedAnchor)) {
      throw protocolError("batch", "an empty batch cannot have a persisted page token or scan anchor");
    }

    if (mode === "reconciliation") {
      const batchRecoveryAnchor = decimalHistoryId(
        batch.recoveryAnchorValue,
        "batch.recoveryAnchorValue",
        { requireString: true },
      );
      if (leaseRecoveryAnchor !== batchRecoveryAnchor) {
        throw new GmailMailboxBackfillError("Reconciliation receipts disagree on the immutable recovery anchor", {
          code: "GMAIL_MAILBOX_RECONCILIATION_ANCHOR_MISMATCH",
        });
      }
      if (persistedAnchor && persistedAnchor !== batchRecoveryAnchor) {
        throw new GmailMailboxBackfillError("Persisted reconciliation pages use a different recovery anchor", {
          code: "GMAIL_MAILBOX_RECONCILIATION_ANCHOR_MISMATCH",
        });
      }
      if (startCursorValue && compareDecimalIds(batchRecoveryAnchor, startCursorValue) < 0) {
        throw protocolError("batch.recoveryAnchorValue", "must not regress behind the expired cursor");
      }
      anchorHistoryId = batchRecoveryAnchor;
    } else if (persistedAnchor) {
      anchorHistoryId = persistedAnchor;
    }

    const renew = async (renewStage) => {
      stage = renewStage;
      throwIfAborted(signal, {
        stage: `Gmail mailbox backfill ${renewStage}`,
        deadlineAtMs,
        now,
        outcomeUnknown: false,
      });
      const receipt = await ledger.renewLease({ ownerId, leaseFence, ttlSeconds: leaseTtlSeconds });
      if (!receipt?.ok) throw receiptFailure(receipt, renewStage);
      if (receipt.leaseFence !== leaseFence) {
        throw new GmailMailboxBackfillError("Mailbox ledger changed the active lease fence", {
          code: "SOURCE_SYNC_LEASE_LOST",
          stage: renewStage,
        });
      }
    };

    const commit = async () => {
      if (!anchorHistoryId) throw protocolError("anchorHistoryId", "must exist before cursor commit");
      await renew("renew_before_commit");
      stage = "commit_batch";
      throwIfAborted(signal, { stage: "Gmail mailbox backfill commit batch", deadlineAtMs, now });
      const receipt = await ledger.commitBatch({ batchId, ownerId, leaseFence });
      if (!receipt?.ok) throw receiptFailure(receipt, stage);
      const committedCursorValue = decimalHistoryId(
        receipt.committedCursorValue,
        "commit.committedCursorValue",
        { requireString: true },
      );
      if (committedCursorValue !== anchorHistoryId) {
        throw new GmailMailboxBackfillError("Committed cursor differs from the immutable mailbox scan anchor", {
          code: "GMAIL_MAILBOX_BACKFILL_COMMIT_ANCHOR_MISMATCH",
        });
      }
      return {
        ok: true,
        status: "committed",
        mode,
        cursorAdvanced: true,
        resumed,
        batchId: String(receipt.batchId || batchId),
        batchHash: String(receipt.batchHash || ""),
        startCursorValue,
        anchorHistoryId,
        committedCursorValue,
        committedCursorVersion: receipt.committedCursorVersion,
        pageCount: receipt.pageCount,
        observationCount: receipt.observationCount,
        jobCount: receipt.jobCount,
        materializationRoutes: receipt.materializationRoutes,
        pagesPersistedThisRun,
      };
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
          mode,
          cursorAdvanced: false,
          batchId,
          startCursorValue,
          anchorHistoryId,
          pageCount: pageOrdinal,
          pagesPersistedThisRun,
          resumePageToken: requestPageToken,
          resumed,
        };
      }

      if (!anchorHistoryId) {
        if (mode !== "backfill" || pageOrdinal !== 0) {
          throw protocolError("anchorHistoryId", "is unavailable for the mailbox scan");
        }
        stage = "capture_profile_anchor";
        throwIfAborted(signal, { stage: "Gmail mailbox backfill profile read", deadlineAtMs, now });
        const profile = await gmailClient.getProfile(signal ? { signal } : {});
        anchorHistoryId = decimalHistoryId(profile?.historyId, "profile.historyId", { requireString: true });
        if (startCursorValue && compareDecimalIds(anchorHistoryId, startCursorValue) < 0) {
          throw protocolError("profile.historyId", "must not regress behind the current cursor");
        }
        await renew("renew_after_profile_anchor");
      }

      stage = "list_messages";
      throwIfAborted(signal, { stage: "Gmail mailbox backfill message read", deadlineAtMs, now });
      const response = await gmailClient.listMessages({
        ...(requestPageToken ? { pageToken: requestPageToken } : {}),
        maxResults,
        includeSpamTrash: true,
        ...(signal ? { signal } : {}),
      });
      const normalizedPage = normalizeMessageDiscoveryPage(response, {
        mode,
        anchorHistoryId,
        scope: ledger.scope || {},
      });
      const isFinal = normalizedPage.responseNextPageToken.length === 0;
      const digest = pageDigest({ pageOrdinal, requestPageToken, normalizedPage });

      await renew("renew_before_append");
      stage = "append_page";
      throwIfAborted(signal, { stage: "Gmail mailbox backfill append page", deadlineAtMs, now });
      const append = await ledger.appendPage({
        batchId,
        ownerId,
        leaseFence,
        page: {
          pageOrdinal,
          requestPageToken,
          responseNextPageToken: normalizedPage.responseNextPageToken,
          responseMailboxHistoryId: anchorHistoryId,
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
      // Bounds are checked before the next Gmail call. A fetched provider page
      // is always made durable even if the deadline passes during the request.
    }
  } catch (error) {
    if (isLeaseLostError(error)) {
      return leaseLostResult({
        stage,
        mode,
        batchId,
        startCursorValue,
        anchorHistoryId,
        pagesPersistedThisRun,
        error,
      });
    }
    throw error;
  }
}

function createGmailMailboxBackfill(defaults = {}) {
  if (!isPlainObject(defaults)) throw invalidArgument("defaults", "must be an object");
  return Object.freeze({
    run(overrides = {}) {
      if (!isPlainObject(overrides)) throw invalidArgument("overrides", "must be an object");
      return runGmailMailboxBackfill({ ...defaults, ...overrides });
    },
  });
}

module.exports = {
  DEFAULT_LEASE_TTL_SECONDS,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_RESULTS,
  GmailMailboxBackfillError,
  MODES,
  createGmailMailboxBackfill,
  normalizeMessageDiscoveryPage,
  runGmailMailboxBackfill,
  _test: {
    canonicalize,
    compareDecimalIds,
    isLeaseLostError,
    pageDigest,
    sha256,
    stableJson,
  },
};

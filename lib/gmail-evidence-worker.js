"use strict";

const crypto = require("node:crypto");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");
const {
  PARSER_VERSION,
  SCHEMA_VERSION: GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  parseGmailInternalDate,
  parseGmailRfc822: defaultParseGmailRfc822,
} = require("./gmail-rfc822-parser");
const { LINKER_VERSION } = require("./gmail-cross-thread-linker");
const {
  EXTRACTOR_VERSION: GMAIL_CLAIM_EXTRACTOR_VERSION,
  MODEL_PLAN_SCHEMA_VERSION: GMAIL_MODEL_PLAN_SCHEMA_VERSION,
} = require("./gmail-claim-extractor");
const {
  ATTACHMENT_SCHEMA_VERSION,
  MATERIALIZATION_JOB_KIND,
  MATERIALIZATION_RESULT_SCHEMA_VERSION,
  MATERIALIZER_VERSION,
  PARSE_JOB_SCHEMA_VERSION,
  PARSE_RESULT_SCHEMA_VERSION,
  RAW_MESSAGE_SCHEMA_VERSION,
  TRIGGER_KINDS,
  normalizeMaterializationAuthority,
  normalizeMaterializationJobPayload,
} = require("./gmail-message-revision-contract");

const RAW_WORKER_VERSION = `gmail-raw-evidence-worker-v2+${MATERIALIZER_VERSION}`;
const PARSE_WORKER_VERSION = `gmail-parse-evidence-worker-v2+${PARSER_VERSION}`;
const SUPPORTED_JOB_KINDS = Object.freeze([
  MATERIALIZATION_JOB_KIND,
  "gmail_parse_rfc822",
]);

class GmailEvidenceWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailEvidenceWorkerError";
    this.code = fields.code || "GMAIL_EVIDENCE_WORKER_FAILED";
    this.retryable = Boolean(fields.retryable);
    this.field = fields.field || "";
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailEvidenceWorkerError(`Invalid Gmail evidence worker argument ${field}: ${reason}`, {
    code: "GMAIL_EVIDENCE_WORKER_INVALID_ARGUMENT",
    field,
  });
}

function protocolError(field, reason) {
  return new GmailEvidenceWorkerError(`Invalid Gmail evidence payload ${field}: ${reason}`, {
    code: "GMAIL_EVIDENCE_WORKER_PROTOCOL_ERROR",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument("hashInput", "contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw invalidArgument("hashInput", "contains a non-JSON value");
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not contain surrounding whitespace");
  return value;
}

function decimalId(value, field) {
  const result = requireString(value, field);
  if (!/^\d+$/.test(result)) throw protocolError(field, "must be an exact decimal string");
  return result;
}

function normalizeDecimal(value) {
  return value.replace(/^0+(?=\d)/, "");
}

function decimalAtLeast(candidate, floor) {
  const left = normalizeDecimal(candidate);
  const right = normalizeDecimal(floor);
  return left.length > right.length || (left.length === right.length && left >= right);
}

function decimalCompare(leftValue, rightValue) {
  const left = normalizeDecimal(leftValue);
  const right = normalizeDecimal(rightValue);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function malformedProviderHistoryWitness(value) {
  let serialized;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(canonicalize(value));
  } catch {
    serialized = String(value);
  }
  const bytes = Buffer.from(String(serialized ?? ""), "utf8");
  return {
    schemaVersion: "gmail-malformed-history-value-witness-v1",
    valueHash: sha256Bytes(bytes),
    utf8Bytes: bytes.length,
    valueType: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
  };
}

function providerHistoryDecision(value, triggerKind, triggerHistoryId, sourceCursorValue) {
  if (value === undefined || value === null || value === "") {
    return { ok: false, reasonCode: "PROVIDER_HISTORY_ID_MISSING", providerHistoryValue: null };
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return {
      ok: false,
      reasonCode: "PROVIDER_HISTORY_ID_MALFORMED",
      providerHistoryValue: malformedProviderHistoryWitness(value),
    };
  }
  if (triggerKind === TRIGGER_KINDS.HISTORY_EVENT
    && decimalCompare(value, triggerHistoryId) < 0) {
    return {
      ok: false,
      reasonCode: "PROVIDER_HISTORY_ID_BEHIND_TRIGGER",
      providerHistoryValue: value,
    };
  }
  if (decimalCompare(value, sourceCursorValue) > 0) {
    return {
      ok: false,
      reasonCode: "PROVIDER_HISTORY_ID_AHEAD_OF_COMMITTED_CUT",
      providerHistoryValue: value,
    };
  }
  return { ok: true, providerHistoryId: value };
}

function requireDependency(value, field, methods) {
  if (!value || typeof value !== "object") throw invalidArgument(field, "must be an object");
  for (const method of methods) {
    if (typeof value[method] !== "function") throw invalidArgument(`${field}.${method}`, "must be a function");
  }
}

function requireExactKeys(value, keys, field) {
  if (!isPlainObject(value)) throw protocolError(field, "must be an object");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw protocolError(field, `must contain exactly: ${expected.join(", ")}`);
  }
}

function decodeBase64UrlStrict(value) {
  const encoded = requireString(value, "gmail.raw");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    throw protocolError("gmail.raw", "must be unpadded base64url data");
  }
  const unpadded = encoded.replace(/=+$/g, "");
  const padding = "=".repeat((4 - (unpadded.length % 4)) % 4);
  const bytes = Buffer.from(unpadded.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64");
  if (bytes.length === 0 || bytes.toString("base64url") !== unpadded) {
    throw protocolError("gmail.raw", "is not canonical base64url data");
  }
  return bytes;
}

function observationIdentity(scope, fields) {
  const identity = {
    schemaVersion: "source-observation-identity-v1",
    workspaceKey: scope.workspaceKey,
    sourceSystem: "gmail",
    connectionKey: scope.connectionKey,
    sourceObjectType: fields.sourceObjectType,
    sourceObjectId: fields.sourceObjectId,
    sourceRevision: fields.sourceRevision,
    operation: fields.operation || "content",
    contentHash: fields.contentHash,
  };
  return `obs:v1:${sha256Json(identity)}`;
}

function normalizeRawReference(value, field = "rawObject") {
  if (!isPlainObject(value)) throw protocolError(field, "must be an object");
  const hash = requireString(value.hash, `${field}.hash`);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw protocolError(`${field}.hash`, "must be SHA-256 hex");
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) {
    throw protocolError(`${field}.bytes`, "must be a non-negative safe integer");
  }
  return {
    bucket: requireString(value.bucket, `${field}.bucket`),
    key: requireString(value.key, `${field}.key`),
    version: requireString(value.version ?? "", `${field}.version`, { allowEmpty: true }),
    etag: requireString(value.etag ?? "", `${field}.etag`, { allowEmpty: true }),
    hash,
    bytes: value.bytes,
    contentType: requireString(value.contentType || "application/octet-stream", `${field}.contentType`),
  };
}

function safeFailure(error) {
  const code = String(error?.code || "GMAIL_EVIDENCE_JOB_FAILED")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 120) || "GMAIL_EVIDENCE_JOB_FAILED";
  const detail = String(error?.message || "Gmail evidence job failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return { code, detail };
}

function isProviderMessageUnavailable(error) {
  return error?.code === "GMAIL_NOT_FOUND"
    && error?.kind === "not-found"
    && error?.operation === "messages.get.raw"
    && Number(error?.status ?? error?.statusCode) === 404;
}

function createGmailEvidenceWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const gmailClient = options.gmailClient;
  const rawStore = options.rawStore;
  const jobLedger = options.jobLedger;
  requireDependency(gmailClient, "gmailClient", ["getMessageRaw"]);
  requireDependency(rawStore, "rawStore", ["putRawObject", "getRawObject"]);
  requireDependency(jobLedger, "jobLedger", [
    "claimJobs",
    "renewJob",
    "completeJob",
    "completeGmailMessageRevisionMaterialization",
    "completeGmailMessageRevisionObligation",
    "failJob",
  ]);
  const scope = jobLedger.scope;
  if (!scope || scope.sourceSystem !== "gmail") throw invalidArgument("jobLedger.scope", "must be a Gmail scope");
  const parseGmailRfc822 = options.parseGmailRfc822 || defaultParseGmailRfc822;
  if (typeof parseGmailRfc822 !== "function") throw invalidArgument("parseGmailRfc822", "must be a function");

  async function renew(job, workerContext) {
    throwIfAborted(workerContext.signal, {
      stage: `Gmail evidence lease renewal ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    return jobLedger.renewJob({
      jobId: job.jobId,
      workerId: workerContext.workerId,
      leaseFence: job.leaseFence,
      processorVersion: workerContext.processorVersion,
      leaseSeconds: workerContext.leaseSeconds || 900,
    });
  }

  async function processRawJob(job, workerContext) {
    let payload;
    let authority;
    try {
      payload = normalizeMaterializationJobPayload(job.payload);
      authority = normalizeMaterializationAuthority(job.materializationAuthority, {
        groupId: payload.groupId,
        rootBatchId: job.rootBatchId,
        connectionKey: scope.connectionKey,
        sourceCursorVersion: job.sourceCursorVersion,
        sourceCursorValue: job.sourceCursorValue,
        messageId: job.sourceObjectId,
      });
    } catch (cause) {
      throw protocolError("job.materializationAuthority", cause?.message || "is invalid");
    }
    if (job.observationId !== null && job.observationId !== undefined && job.observationId !== "") {
      throw protocolError("job.observationId", "must be null for a group-routed materialization job");
    }
    if (payload.messageId !== job.sourceObjectId || payload.messageId !== authority.messageId) {
      throw protocolError("job.sourceObjectId", "does not match the sealed group message");
    }
    const messageId = authority.messageId;
    const trigger = {
      triggerObservationId: authority.selectedTrigger.observationId,
      triggerObservationContentHash: authority.selectedTrigger.contentHash,
      triggerKind: authority.selectedTrigger.kind,
      triggerEventType: authority.selectedTrigger.eventType,
      triggerHistoryId: authority.selectedTrigger.historyId,
    };
    const sourceCursorValue = authority.sourceCursorValue;

    const completeObligation = async (reasonCode, providerHistoryValue) => {
      await renew(job, workerContext);
      throwIfAborted(workerContext.signal, {
        stage: `Gmail revision-obligation completion ${job.jobId}`,
        deadlineAtMs: workerContext.deadlineAtMs,
      });
      return jobLedger.completeGmailMessageRevisionObligation({
        jobId: job.jobId,
        workerId: workerContext.workerId,
        leaseFence: job.leaseFence,
        processorVersion: workerContext.processorVersion,
        rootBatchId: authority.rootBatchId,
        sourceCursorVersion: authority.sourceCursorVersion,
        sourceCursorValue: authority.sourceCursorValue,
        reasonCode,
        providerHistoryValue,
      });
    };

    throwIfAborted(workerContext.signal, {
      stage: "Gmail evidence message-revision read",
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    let gmailMessage;
    try {
      gmailMessage = await gmailClient.getMessageRaw(
        messageId,
        workerContext.signal ? { signal: workerContext.signal } : {},
      );
    } catch (error) {
      if (isProviderMessageUnavailable(error)) {
        return completeObligation("PROVIDER_MESSAGE_DELETED_UNAVAILABLE", null);
      }
      throw error;
    }
    if (!isPlainObject(gmailMessage)) throw protocolError("gmail.message", "must be an object");
    if (String(gmailMessage.id || "") !== messageId) {
      throw protocolError("gmail.message.id", "does not match the job");
    }
    const providerHistory = providerHistoryDecision(
      gmailMessage.historyId,
      trigger.triggerKind,
      trigger.triggerHistoryId,
      sourceCursorValue,
    );
    if (!providerHistory.ok) {
      return completeObligation(providerHistory.reasonCode, providerHistory.providerHistoryValue);
    }
    const providerHistoryId = providerHistory.providerHistoryId;
    let gmailSourceTime;
    try {
      gmailSourceTime = parseGmailInternalDate(gmailMessage.internalDate, "gmail.message.internalDate");
    } catch (cause) {
      throw protocolError("gmail.message.internalDate", cause?.message || "is invalid");
    }
    const providerThreadId = String(gmailMessage.threadId || "");
    if (authority.threadId && providerThreadId && authority.threadId !== providerThreadId) {
      throw protocolError("gmail.message.threadId", "does not match the trigger event");
    }
    const threadId = providerThreadId || authority.threadId;
    const labelIds = [...new Set((Array.isArray(gmailMessage.labelIds) ? gmailMessage.labelIds : [])
      .map(String))].sort();
    const rawBytes = decodeBase64UrlStrict(gmailMessage.raw);
    const rawHash = sha256Bytes(rawBytes);
    await renew(job, workerContext);
    throwIfAborted(workerContext.signal, {
      stage: `Gmail evidence raw object write ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    const stored = await rawStore.putRawObject({
      workspaceKey: scope.workspaceKey,
      sourceSystem: "gmail",
      connectionKey: scope.connectionKey,
      sourceObjectType: "gmail_message_raw",
      sourceObjectId: messageId,
      sourceRevision: providerHistoryId,
      bytes: rawBytes,
      contentType: "message/rfc822",
      expectedSha256: rawHash,
      attachmentMetadata: null,
    });
    const rawObject = normalizeRawReference(stored.rawObject);
    const normalizedPayload = {
      schemaVersion: RAW_MESSAGE_SCHEMA_VERSION,
      messageId,
      threadId,
      providerMessageHistoryId: providerHistoryId,
      internalDate: gmailSourceTime.raw,
      providerReceivedAt: gmailSourceTime.sourceRecordedAt,
      labelIds,
      sizeEstimate: Number.isSafeInteger(gmailMessage.sizeEstimate) ? gmailMessage.sizeEstimate : null,
      rawSha256: rawHash,
      rawBytes: rawBytes.length,
    };
    const observation = {
      sourceObjectType: "gmail_message_raw",
      sourceObjectId: messageId,
      sourceRevision: providerHistoryId,
      operation: "content",
      contentHash: rawHash,
      normalizedPayload,
      normalizedText: "",
      rawObject,
      sourceRecordedAt: gmailSourceTime.sourceRecordedAt,
      sourceFidelity: "raw",
      schemaVersion: RAW_MESSAGE_SCHEMA_VERSION,
    };
    observation.observationId = observationIdentity(scope, observation);
    const parsePayload = {
      schemaVersion: PARSE_JOB_SCHEMA_VERSION,
      messageId,
      threadId,
      providerMessageHistoryId: providerHistoryId,
      rawObservationId: observation.observationId,
      rawObservationContentHash: rawHash,
      internalDate: normalizedPayload.internalDate,
      sourceRecordedAt: gmailSourceTime.sourceRecordedAt,
      labelIds,
      rawObject,
      parserVersion: PARSER_VERSION,
    };
    const parseJobHash = sha256Json(parsePayload);
    const childJob = {
      dedupeKey: `gmail:parse-rfc822:v2:${parseJobHash}`,
      jobKind: "gmail_parse_rfc822",
      observationId: observation.observationId,
      sourceObjectId: messageId,
      maxAttempts: 5,
      payload: parsePayload,
    };
    await renew(job, workerContext);
    throwIfAborted(workerContext.signal, {
      stage: `Gmail evidence completion ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    return jobLedger.completeGmailMessageRevisionMaterialization({
      jobId: job.jobId,
      workerId: workerContext.workerId,
      leaseFence: job.leaseFence,
      processorVersion: workerContext.processorVersion,
      rootBatchId: authority.rootBatchId,
      sourceCursorVersion: authority.sourceCursorVersion,
      sourceCursorValue: authority.sourceCursorValue,
      result: {
        schemaVersion: MATERIALIZATION_RESULT_SCHEMA_VERSION,
        materializationGroupId: authority.groupId,
        messageId,
        providerMessageHistoryId: providerHistoryId,
        rawSha256: rawHash,
        rawBytes: rawBytes.length,
      },
      rawObservation: observation,
      parseChild: childJob,
    });
  }

  async function processParseJob(job, workerContext) {
    const payload = isPlainObject(job.payload) ? job.payload : {};
    requireExactKeys(payload, [
      "schemaVersion",
      "messageId",
      "threadId",
      "providerMessageHistoryId",
      "rawObservationId",
      "rawObservationContentHash",
      "internalDate",
      "sourceRecordedAt",
      "labelIds",
      "rawObject",
      "parserVersion",
    ], "job.payload");
    if (payload.schemaVersion !== PARSE_JOB_SCHEMA_VERSION) {
      throw protocolError("job.payload.schemaVersion", `must be ${PARSE_JOB_SCHEMA_VERSION}`);
    }
    if (payload.parserVersion !== PARSER_VERSION) {
      throw protocolError("job.payload.parserVersion", `must be ${PARSER_VERSION}`);
    }
    const messageId = requireString(payload.messageId || job.sourceObjectId, "job.payload.messageId");
    if (messageId !== job.sourceObjectId) throw protocolError("job.sourceObjectId", "does not match messageId");
    const providerHistoryId = decimalId(
      payload.providerMessageHistoryId,
      "job.payload.providerMessageHistoryId",
    );
    const rawObservationId = requireString(payload.rawObservationId, "job.payload.rawObservationId");
    if (rawObservationId !== job.observationId) {
      throw protocolError("job.observationId", "does not match payload.rawObservationId");
    }
    const labelIds = [...new Set((Array.isArray(payload.labelIds) ? payload.labelIds : [])
      .map(String))].sort();
    if (JSON.stringify(labelIds) !== JSON.stringify(payload.labelIds)) {
      throw protocolError("job.payload.labelIds", "must be canonical sorted unique strings");
    }
    const labelIdsHash = sha256Json(labelIds);
    const rawObject = normalizeRawReference(payload.rawObject, "job.payload.rawObject");
    const rawObservationContentHash = requireString(
      payload.rawObservationContentHash,
      "job.payload.rawObservationContentHash",
    );
    if (rawObservationContentHash !== rawObject.hash) {
      throw protocolError("job.payload.rawObservationContentHash", "does not match raw object hash");
    }
    const loaded = await rawStore.getRawObject({
      key: rawObject.key,
      expectedSha256: rawObject.hash,
      expectedBytes: rawObject.bytes,
    });
    await renew(job, workerContext);
    const parsed = await parseGmailRfc822({
      rawBytes: loaded.bytes,
      expectedRawSha256: rawObject.hash,
      gmail: {
        messageId,
        threadId: String(payload.threadId || ""),
        historyId: providerHistoryId,
        providerHistoryId,
        rawObservationId,
        rawObservationContentHash,
        internalDate: String(payload.internalDate || ""),
        labelIds,
        labelIdsHash,
      },
    });
    if (!isPlainObject(parsed)
        || parsed.schemaVersion !== GMAIL_PARSED_MESSAGE_SCHEMA_VERSION
        || parsed.parserVersion !== PARSER_VERSION
        || parsed.rawSha256 !== rawObject.hash
        || !isPlainObject(parsed.parsedMessage)
        || parsed.parsedMessage.schemaVersion !== GMAIL_PARSED_MESSAGE_SCHEMA_VERSION
        || parsed.parsedMessage.parserVersion !== PARSER_VERSION
        || parsed.parsedContentHash !== sha256Json(parsed.parsedMessage)
        || parsed.parsedMessage.gmail?.messageId !== messageId
        || parsed.parsedMessage.gmail?.threadId !== String(payload.threadId || "")
        || parsed.parsedMessage.gmail?.providerHistoryId !== providerHistoryId
        || parsed.parsedMessage.gmail?.historyId !== providerHistoryId
        || parsed.parsedMessage.gmail?.rawObservationId !== rawObservationId
        || parsed.parsedMessage.gmail?.rawObservationContentHash !== rawObservationContentHash
        || parsed.parsedMessage.gmail?.labelIdsHash !== labelIdsHash
        || JSON.stringify(parsed.parsedMessage.gmail?.labelIds) !== JSON.stringify(labelIds)) {
      throw protocolError("parsed", "does not preserve the intrinsic Gmail provider evidence contract");
    }
    const expectedSourceRecordedAt = parseGmailInternalDate(
      String(payload.internalDate || ""),
      "job.payload.internalDate",
    ).sourceRecordedAt;
    if (parsed.sourceRecordedAt !== expectedSourceRecordedAt
      || (payload.sourceRecordedAt && payload.sourceRecordedAt !== expectedSourceRecordedAt)) {
      throw protocolError("parsed.sourceRecordedAt", "does not match the immutable Gmail internalDate");
    }
    await renew(job, workerContext);
    const observations = [];
    const parsedObservation = {
      sourceObjectType: "gmail_message_parsed",
      sourceObjectId: messageId,
      sourceRevision: providerHistoryId,
      operation: "content",
      contentHash: parsed.parsedContentHash,
      normalizedPayload: parsed.parsedMessage,
      normalizedText: parsed.normalizedText,
      sourceRecordedAt: parsed.sourceRecordedAt,
      sourceFidelity: "normalized_source",
      schemaVersion: parsed.schemaVersion,
    };
    parsedObservation.observationId = observationIdentity(scope, parsedObservation);
    observations.push(parsedObservation);

    const storedAttachments = [];
    for (const attachment of parsed.attachments) {
      await renew(job, workerContext);
      throwIfAborted(workerContext.signal, {
        stage: `Gmail attachment raw object write ${job.jobId}`,
        deadlineAtMs: workerContext.deadlineAtMs,
      });
      const stored = await rawStore.putRawObject({
        workspaceKey: scope.workspaceKey,
        sourceSystem: "gmail",
        connectionKey: scope.connectionKey,
        sourceObjectType: "gmail_attachment",
        sourceObjectId: attachment.attachmentId,
        sourceRevision: providerHistoryId,
        bytes: attachment.bytes,
        contentType: attachment.metadata.mimeType,
        expectedSha256: attachment.metadata.contentHash,
        attachmentMetadata: {
          ...attachment.metadata,
          attachmentId: attachment.attachmentId,
          gmailMessageId: messageId,
          gmailThreadId: String(payload.threadId || ""),
        },
      });
      const storedRef = normalizeRawReference(stored.rawObject);
      const attachmentPayload = {
        schemaVersion: ATTACHMENT_SCHEMA_VERSION,
        gmailMessageId: messageId,
        gmailThreadId: String(payload.threadId || ""),
        providerHistoryId,
        rawObservationId,
        sourceRecordedAt: parsed.sourceRecordedAt,
        sourceChronology: parsed.sourceChronology,
        attachmentId: attachment.attachmentId,
        ...attachment.metadata,
      };
      const attachmentObservation = {
        sourceObjectType: "gmail_attachment",
        sourceObjectId: attachment.attachmentId,
        sourceRevision: providerHistoryId,
        operation: "content",
        contentHash: attachment.metadata.contentHash,
        normalizedPayload: attachmentPayload,
        normalizedText: "",
        rawObject: storedRef,
        sourceRecordedAt: parsed.sourceRecordedAt,
        sourceFidelity: "raw",
        schemaVersion: ATTACHMENT_SCHEMA_VERSION,
      };
      attachmentObservation.observationId = observationIdentity(scope, attachmentObservation);
      observations.push(attachmentObservation);
      storedAttachments.push({
        attachmentId: attachment.attachmentId,
        observationId: attachmentObservation.observationId,
        rawObject: storedRef,
        metadata: attachment.metadata,
      });
    }

    const childJobs = [{
      dedupeKey: `gmail:extract-message-claims:v1:${sha256Json({
        parsedObservationId: parsedObservation.observationId,
        extractorInputHash: parsed.parsedContentHash,
      })}`,
      jobKind: "gmail_extract_message_claims",
      observationId: parsedObservation.observationId,
      sourceObjectId: messageId,
      maxAttempts: 5,
      payload: {
        schemaVersion: "gmail-extract-message-claims-job-v1",
        messageId,
        threadId: String(payload.threadId || ""),
        historyId: providerHistoryId,
        providerHistoryId,
        parsedObservationId: parsedObservation.observationId,
        parsedContentHash: parsed.parsedContentHash,
      },
    }, {
      dedupeKey: `gmail:resolve-entity-links:v1:${sha256Json({
        parsedObservationId: parsedObservation.observationId,
        parsedContentHash: parsed.parsedContentHash,
        linkerVersion: LINKER_VERSION,
      })}`,
      jobKind: "gmail_resolve_entity_links",
      observationId: parsedObservation.observationId,
      sourceObjectId: messageId,
      maxAttempts: 5,
      payload: {
        schemaVersion: "gmail-resolve-entity-links-job-v1",
        messageId,
        threadId: String(payload.threadId || ""),
        historyId: providerHistoryId,
        providerHistoryId,
        parsedObservationId: parsedObservation.observationId,
        parsedContentHash: parsed.parsedContentHash,
        linkerVersion: LINKER_VERSION,
      },
    }];
    for (const attachment of storedAttachments) {
      childJobs.push({
        dedupeKey: `gmail:extract-attachment:v1:${sha256Json({
          attachmentObservationId: attachment.observationId,
          contentHash: attachment.rawObject.hash,
        })}`,
        jobKind: "gmail_extract_attachment",
        observationId: attachment.observationId,
        sourceObjectId: attachment.attachmentId,
        maxAttempts: 5,
        payload: {
          schemaVersion: "gmail-extract-attachment-job-v1",
          messageId,
          threadId: String(payload.threadId || ""),
          historyId: providerHistoryId,
          providerHistoryId,
          sourceRecordedAt: parsed.sourceRecordedAt,
          attachmentId: attachment.attachmentId,
          attachmentObservationId: attachment.observationId,
          rawObject: attachment.rawObject,
          metadata: attachment.metadata,
        },
      });
    }
    await renew(job, workerContext);
    throwIfAborted(workerContext.signal, {
      stage: `Gmail evidence completion ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    return jobLedger.completeJob({
      jobId: job.jobId,
      workerId: workerContext.workerId,
      leaseFence: job.leaseFence,
      processorVersion: workerContext.processorVersion,
      result: {
        schemaVersion: PARSE_RESULT_SCHEMA_VERSION,
        messageId,
        providerMessageHistoryId: providerHistoryId,
        rawObservationId,
        parserVersion: parsed.parserVersion,
        parsedContentHash: parsed.parsedContentHash,
        attachmentCount: storedAttachments.length,
      },
      observations,
      childJobs,
    });
  }

  async function processJob(job, workerContext) {
    if (!isPlainObject(job)) throw invalidArgument("job", "must be an object");
    if (job.jobKind === MATERIALIZATION_JOB_KIND) return processRawJob(job, workerContext);
    if (job.jobKind === "gmail_parse_rfc822") return processParseJob(job, workerContext);
    throw new GmailEvidenceWorkerError("Unsupported Gmail evidence job kind", {
      code: "GMAIL_EVIDENCE_JOB_UNSUPPORTED",
    });
  }

  async function run(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("run input", "must be an object");
    const workerId = requireString(input.workerId, "workerId");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("signal", "must be an AbortSignal or null");
    throwIfAborted(signal, { stage: "Gmail evidence worker claim", deadlineAtMs: input.deadlineAtMs });
    const limit = input.limit === undefined ? 10 : Number(input.limit);
    const leaseSeconds = input.leaseSeconds === undefined ? 900 : Number(input.leaseSeconds);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw invalidArgument("limit", "must be an integer from 1 through 50");
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw invalidArgument("leaseSeconds", "must be an integer from 30 through 900");
    }
    const processorVersion = requireString(input.processorVersion || RAW_WORKER_VERSION, "processorVersion");
    throwIfAborted(signal, { stage: "Gmail evidence worker claim", deadlineAtMs: input.deadlineAtMs });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: SUPPORTED_JOB_KINDS,
    });
    const outcomes = [];
    for (const job of claim.jobs || []) {
      try {
        throwIfAborted(signal, {
          stage: `Gmail evidence job ${job.jobId}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const completed = await processJob(job, {
          workerId,
          processorVersion,
          leaseSeconds,
          signal,
          deadlineAtMs: input.deadlineAtMs,
        });
        outcomes.push({ jobId: job.jobId, jobKind: job.jobKind, status: "succeeded", receipt: completed });
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `Gmail evidence job ${job.jobId}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `Gmail evidence job ${job.jobId}`,
            deadlineAtMs: input.deadlineAtMs,
            outcomeUnknown: error?.outcomeUnknown === true,
          });
        }
        throwIfAborted(signal, {
          stage: `Gmail evidence failure acknowledgement ${job.jobId}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const failure = safeFailure(error);
        let receipt = null;
        try {
          throwIfAborted(signal, {
            stage: `Gmail evidence failure acknowledgement ${job.jobId}`,
            deadlineAtMs: input.deadlineAtMs,
          });
          receipt = await jobLedger.failJob({
            jobId: job.jobId,
            workerId,
            leaseFence: job.leaseFence,
            processorVersion,
            errorCode: failure.code,
            safeErrorDetail: failure.detail,
            retryAfterSeconds: error?.retryable ? 60 : null,
          });
        } catch (ackError) {
          if (ackError?.outcomeUnknown === true || isAbortError(ackError, signal)) {
            throw asOutcomeUnknownError(ackError, {
              signal,
              stage: `Gmail evidence failure acknowledgement ${job.jobId}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
          outcomes.push({
            jobId: job.jobId,
            jobKind: job.jobKind,
            status: "ack_failed",
            errorCode: failure.code,
            ackErrorCode: String(ackError?.code || "SOURCE_PROCESSING_JOB_ACK_FAILED"),
          });
          continue;
        }
        outcomes.push({
          jobId: job.jobId,
          jobKind: job.jobKind,
          status: receipt?.state === "dead_letter" ? "dead_letter" : "retry_wait",
          errorCode: failure.code,
          receipt,
        });
      }
    }
    return {
      ok: true,
      workerId,
      processorVersion,
      claimedCount: claim.claimedCount || 0,
      succeededCount: outcomes.filter((item) => item.status === "succeeded").length,
      failedCount: outcomes.filter((item) => item.status !== "succeeded").length,
      outcomes,
    };
  }

  return Object.freeze({ processJob, run });
}

module.exports = {
  GmailEvidenceWorkerError,
  PARSE_WORKER_VERSION,
  RAW_WORKER_VERSION,
  SUPPORTED_JOB_KINDS,
  createGmailEvidenceWorker,
  _test: {
    canonicalize,
    decodeBase64UrlStrict,
    decimalAtLeast,
    normalizeRawReference,
    observationIdentity,
    safeFailure,
    sha256Bytes,
    sha256Json,
  },
};

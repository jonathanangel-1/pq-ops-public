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
  classifyPdfOperationalEvidence,
  extractPdfTextFromBuffer,
  normalizeText,
} = require("./pdf-evidence");

const JOB_KIND = "gmail_extract_attachment";
const CLAIM_JOB_KIND = "gmail_extract_attachment_claims";
const REVIEW_JOB_KIND = "gmail_review_attachment_extraction";
const WORKER_VERSION = "gmail-attachment-evidence-worker-v1";
const SCHEMA_VERSION = "gmail-attachment-extracted-v1";
const MAX_EXTRACTED_TEXT_BYTES = 16 * 1024 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;

const TEXT_MIME_TYPES = new Set([
  "application/csv",
  "application/json",
  "application/ld+json",
  "application/xml",
  "application/xhtml+xml",
  "application/x-ndjson",
  "text/calendar",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/xml",
]);

const OCR_MIME_PREFIXES = Object.freeze(["image/"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

class GmailAttachmentWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailAttachmentWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailAttachmentWorkerError(`Invalid Gmail attachment worker argument ${field}: ${reason}`, {
    code: "GMAIL_ATTACHMENT_WORKER_INVALID_ARGUMENT",
    field,
  });
}

function protocolError(field, reason) {
  return new GmailAttachmentWorkerError(`Invalid Gmail attachment job ${field}: ${reason}`, {
    code: "GMAIL_ATTACHMENT_JOB_PROTOCOL_ERROR",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireString(value, field, { allowEmpty = false, maxBytes = 8192 } = {}) {
  if (typeof value !== "string") throw invalidArgument(field, "must be a string");
  if (!allowEmpty && value.length === 0) throw invalidArgument(field, "must not be empty");
  if (value.trim() !== value) throw invalidArgument(field, "must not contain surrounding whitespace");
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalidArgument(field, "is too long");
  return value;
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

function normalizeMimeType(value) {
  return String(value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase()
    || "application/octet-stream";
}

function normalizeRawReference(value, field = "rawObject") {
  if (!isPlainObject(value)) throw protocolError(field, "must be an object");
  const hash = requireString(value.hash, `${field}.hash`);
  if (!HASH_RE.test(hash)) throw protocolError(`${field}.hash`, "must be lowercase SHA-256 hex");
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
    contentType: normalizeMimeType(value.contentType),
  };
}

function decodeUtf8(bytes) {
  const text = Buffer.from(bytes).toString("utf8").replace(/\0/g, "");
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  return {
    text,
    replacementRatio: replacementCount / Math.max(text.length, 1),
  };
}

function decodeHtmlEntities(value) {
  const named = Object.freeze({ amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' });
  return String(value || "")
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Math.min(Number(digits), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits) => String.fromCodePoint(Math.min(parseInt(digits, 16), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function htmlToText(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function boundedText(value, field = "extractedText") {
  if (typeof value !== "string") throw protocolError(field, "must be a string");
  if (Buffer.byteLength(value, "utf8") > MAX_EXTRACTED_TEXT_BYTES) {
    throw new GmailAttachmentWorkerError("Extracted attachment text exceeds the durable observation limit", {
      code: "GMAIL_ATTACHMENT_TEXT_LIMIT_EXCEEDED",
      field,
    });
  }
  return value;
}

function extractionResult(input = {}) {
  const status = requireString(input.status, "extraction.status");
  if (!["extracted", "empty", "needs_ocr", "needs_document_parser", "unsupported"].includes(status)) {
    throw protocolError("extraction.status", "is unsupported");
  }
  const text = boundedText(input.text ?? "");
  const reviewRequired = Boolean(input.reviewRequired);
  if (status === "extracted" && !text.trim()) {
    throw protocolError("extraction.text", "must not be empty when status is extracted");
  }
  if (status !== "extracted" && text.trim()) {
    throw protocolError("extraction.text", "must be empty unless status is extracted");
  }
  if (status !== "extracted" && !reviewRequired) {
    throw protocolError("extraction.reviewRequired", "must be true when extraction is incomplete");
  }
  return Object.freeze({
    status,
    method: requireString(input.method, "extraction.method"),
    text,
    reviewRequired,
    reason: requireString(input.reason, "extraction.reason", { maxBytes: 2000 }),
    confidence: Number.isFinite(input.confidence)
      ? Math.max(0, Math.min(1, Number(input.confidence.toFixed(6))))
      : status === "extracted" ? 1 : 0,
  });
}

async function deterministicAttachmentExtraction({ bytes, filename = "", mimeType = "application/octet-stream" } = {}) {
  if (!Buffer.isBuffer(bytes)) throw invalidArgument("bytes", "must be a Buffer");
  const normalizedMime = normalizeMimeType(mimeType);
  if (normalizedMime === "application/pdf" || /\.pdf$/i.test(filename)) {
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      return extractionResult({
        status: "needs_document_parser",
        method: "pdf-signature-check-v1",
        text: "",
        reviewRequired: true,
        reason: "Attachment is labelled PDF but the immutable bytes do not have a PDF signature.",
      });
    }
    const text = boundedText(await extractPdfTextFromBuffer(bytes));
    const classification = classifyPdfOperationalEvidence({ filename, text });
    if (!text.trim() || classification.status === "pdf-unreadable") {
      return extractionResult({
        status: "needs_ocr",
        method: "pdf-text+quality-v1",
        text: "",
        reviewRequired: true,
        reason: text.trim()
          ? "PDF text extraction was unreadable; OCR or human review is required."
          : "PDF contains no readable text; OCR or human review is required.",
      });
    }
    return extractionResult({
      status: "extracted",
      method: "pdf-text+quality-v1",
      text,
      reviewRequired: false,
      reason: "Readable PDF text was extracted from the immutable attachment bytes.",
      confidence: 1,
    });
  }

  if (TEXT_MIME_TYPES.has(normalizedMime) || normalizedMime.startsWith("text/")) {
    const decoded = decodeUtf8(bytes);
    if (decoded.replacementRatio > 0.02) {
      return extractionResult({
        status: "needs_document_parser",
        method: "utf8-quality-v1",
        text: "",
        reviewRequired: true,
        reason: "Text attachment is not valid enough UTF-8 for evidence-safe extraction.",
      });
    }
    const text = boundedText(normalizedMime === "text/html" || normalizedMime === "application/xhtml+xml"
      ? htmlToText(decoded.text)
      : decoded.text.replace(/\r\n?/g, "\n").trim());
    if (!text.trim()) {
      return extractionResult({
        status: "empty",
        method: "utf8-text-v1",
        text: "",
        reviewRequired: true,
        reason: "Text attachment decoded successfully but contained no readable text.",
      });
    }
    return extractionResult({
      status: "extracted",
      method: normalizedMime.includes("html") ? "html-to-text-v1" : "utf8-text-v1",
      text,
      reviewRequired: false,
      reason: "Text was deterministically decoded from the immutable attachment bytes.",
      confidence: 1,
    });
  }

  if (OCR_MIME_PREFIXES.some((prefix) => normalizedMime.startsWith(prefix))) {
    return extractionResult({
      status: "needs_ocr",
      method: "mime-routing-v1",
      text: "",
      reviewRequired: true,
      reason: "Image attachment requires OCR or vision extraction before it can support shipment claims.",
    });
  }
  if (DOCUMENT_MIME_TYPES.has(normalizedMime) || /\.(?:docx?|xlsx?|pptx?|rtf|odt|ods)$/i.test(filename)) {
    return extractionResult({
      status: "needs_document_parser",
      method: "mime-routing-v1",
      text: "",
      reviewRequired: true,
      reason: "Office-document attachment requires a format-specific parser before it can support shipment claims.",
    });
  }
  return extractionResult({
    status: "unsupported",
    method: "mime-routing-v1",
    text: "",
    reviewRequired: true,
    reason: "No evidence-safe extractor is configured for this attachment type.",
  });
}

function validateInjectedExtraction(value) {
  if (!isPlainObject(value)) throw protocolError("documentExtractor.result", "must be an object");
  return extractionResult(value);
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

function safeFailure(error) {
  const code = String(error?.code || "GMAIL_ATTACHMENT_JOB_FAILED")
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 120) || "GMAIL_ATTACHMENT_JOB_FAILED";
  const detail = String(error?.message || "Gmail attachment job failed")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return { code, detail };
}

function createGmailAttachmentWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const rawStore = options.rawStore;
  const jobLedger = options.jobLedger;
  if (!rawStore || typeof rawStore.getRawObject !== "function") {
    throw invalidArgument("rawStore", "must expose getRawObject()");
  }
  for (const method of ["claimJobs", "renewJob", "completeJob", "failJob"]) {
    if (!jobLedger || typeof jobLedger[method] !== "function") {
      throw invalidArgument("jobLedger", `must expose ${method}()`);
    }
  }
  const scope = jobLedger.scope;
  if (!scope || scope.sourceSystem !== "gmail") {
    throw invalidArgument("jobLedger.scope", "must be a Gmail source scope");
  }
  const documentExtractor = options.documentExtractor ?? null;
  if (documentExtractor !== null && typeof documentExtractor !== "function") {
    throw invalidArgument("documentExtractor", "must be a function or null");
  }

  function fenced(job, workerContext) {
    return {
      jobId: job.jobId,
      workerId: workerContext.workerId,
      leaseFence: job.leaseFence,
      processorVersion: workerContext.processorVersion,
    };
  }

  async function processJob(job, workerContext) {
    if (!isPlainObject(job)) throw invalidArgument("job", "must be an object");
    if (job.jobKind !== JOB_KIND) {
      throw new GmailAttachmentWorkerError(`Unsupported Gmail attachment job kind ${job.jobKind || ""}`, {
        code: "GMAIL_ATTACHMENT_JOB_UNSUPPORTED",
      });
    }
    const payload = isPlainObject(job.payload) ? job.payload : {};
    const attachmentId = requireString(payload.attachmentId || job.sourceObjectId, "job.payload.attachmentId");
    if (attachmentId !== job.sourceObjectId) {
      throw protocolError("sourceObjectId", "does not match payload.attachmentId");
    }
    const attachmentObservationId = requireString(
      payload.attachmentObservationId || job.observationId,
      "job.payload.attachmentObservationId",
    );
    if (!OBSERVATION_ID_RE.test(attachmentObservationId) || attachmentObservationId !== job.observationId) {
      throw protocolError("attachmentObservationId", "must match the immutable job observation");
    }
    const messageId = requireString(payload.messageId, "job.payload.messageId");
    const threadId = requireString(payload.threadId, "job.payload.threadId", { allowEmpty: true });
    const historyId = requireString(payload.historyId, "job.payload.historyId");
    if (!/^\d+$/.test(historyId)) throw protocolError("historyId", "must be an exact decimal string");
    const rawObject = normalizeRawReference(payload.rawObject, "job.payload.rawObject");
    const metadata = isPlainObject(payload.metadata) ? canonicalize(payload.metadata) : {};
    const filename = String(metadata.filename || "");
    const mimeType = normalizeMimeType(metadata.mimeType || rawObject.contentType);
    if (metadata.contentHash && metadata.contentHash !== rawObject.hash) {
      throw protocolError("metadata.contentHash", "does not match the immutable raw-object hash");
    }
    if (Number.isSafeInteger(metadata.bytes) && metadata.bytes !== rawObject.bytes) {
      throw protocolError("metadata.bytes", "does not match the immutable raw-object size");
    }

    const loaded = await rawStore.getRawObject({
      key: rawObject.key,
      expectedSha256: rawObject.hash,
      expectedBytes: rawObject.bytes,
    });
    if (!loaded || !Buffer.isBuffer(loaded.bytes)) {
      throw protocolError("rawStore.result", "must contain Buffer bytes");
    }
    if (sha256Bytes(loaded.bytes) !== rawObject.hash || loaded.bytes.length !== rawObject.bytes) {
      throw new GmailAttachmentWorkerError("Immutable attachment bytes failed local integrity verification", {
        code: "GMAIL_ATTACHMENT_RAW_INTEGRITY_MISMATCH",
      });
    }
    throwIfAborted(workerContext.signal, {
      stage: `Gmail attachment lease renewal ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    await jobLedger.renewJob({ ...fenced(job, workerContext), leaseSeconds: workerContext.leaseSeconds });

    const deterministicExtraction = await deterministicAttachmentExtraction({
      bytes: loaded.bytes,
      filename,
      mimeType,
    });
    let extraction = deterministicExtraction;
    let extractionProvenance = "deterministic";
    if (documentExtractor && deterministicExtraction.reviewRequired) {
      throwIfAborted(workerContext.signal, {
        stage: "Gmail attachment document extraction",
        deadlineAtMs: workerContext.deadlineAtMs,
      });
      const injected = await documentExtractor(Object.freeze({
        bytes: Buffer.from(loaded.bytes),
        filename,
        mimeType,
        rawSha256: rawObject.hash,
        deterministicResult: deterministicExtraction,
      }), {
        signal: workerContext.signal || null,
        deadlineAtMs: workerContext.deadlineAtMs || null,
      });
      const injectedExtraction = validateInjectedExtraction(injected);
      extractionProvenance = "injected_document_extractor";
      // A pluggable OCR/document/model adapter may recover useful text, but it
      // cannot silently certify attachment completeness. Its text can fan out
      // into review-gated claim candidates while the exact attachment remains
      // on the durable review queue.
      extraction = extractionResult({
        ...injectedExtraction,
        reviewRequired: true,
        reason: injectedExtraction.reason,
      });
    }
    throwIfAborted(workerContext.signal, {
      stage: `Gmail attachment lease renewal ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    await jobLedger.renewJob({ ...fenced(job, workerContext), leaseSeconds: workerContext.leaseSeconds });

    const pdfClassification = mimeType === "application/pdf" || /\.pdf$/i.test(filename)
      ? classifyPdfOperationalEvidence({ filename, text: extraction.text })
      : null;
    const normalizedPayload = {
      schemaVersion: SCHEMA_VERSION,
      workerVersion: WORKER_VERSION,
      gmail: { messageId, threadId, historyId },
      attachmentId,
      parentObservationId: attachmentObservationId,
      filename,
      mimeType,
      metadata,
      rawSha256: rawObject.hash,
      rawBytes: rawObject.bytes,
      extraction: {
        status: extraction.status,
        method: extraction.method,
        provenance: extractionProvenance,
        reviewRequired: extraction.reviewRequired,
        reason: extraction.reason,
        confidence: extraction.confidence,
        textBytes: Buffer.byteLength(extraction.text, "utf8"),
      },
      classification: pdfClassification ? {
        kind: pdfClassification.kind,
        status: pdfClassification.status,
        awb: String(pdfClassification.awb || ""),
        signals: canonicalize(pdfClassification.signals || {}),
        fields: canonicalize(pdfClassification.fields || {}),
      } : null,
      text: extraction.text,
    };
    const contentHash = sha256Json(normalizedPayload);
    const observation = {
      sourceObjectType: "gmail_attachment_extracted",
      sourceObjectId: attachmentId,
      sourceRevision: historyId,
      operation: "content",
      contentHash,
      normalizedPayload,
      normalizedText: extraction.text,
      rawObject,
      sourceFidelity: "normalized_source",
      schemaVersion: SCHEMA_VERSION,
    };
    observation.observationId = observationIdentity(scope, observation);

    const childJobs = [];
    if (extraction.status === "extracted") {
      childJobs.push({
        dedupeKey: `gmail:extract-attachment-claims:v1:${sha256Json({
          observationId: observation.observationId,
          contentHash,
        })}`,
        jobKind: CLAIM_JOB_KIND,
        observationId: observation.observationId,
        sourceObjectId: attachmentId,
        maxAttempts: 5,
        payload: {
          schemaVersion: "gmail-extract-attachment-claims-job-v1",
          attachmentObservationId: observation.observationId,
          attachmentId,
          messageId,
          threadId,
          historyId,
          parentObservationId: attachmentObservationId,
          contentHash,
        },
      });
    }
    if (extraction.reviewRequired) {
      childJobs.push({
        dedupeKey: `gmail:review-attachment-extraction:v1:${sha256Json({
          observationId: observation.observationId,
          contentHash,
        })}`,
        jobKind: REVIEW_JOB_KIND,
        observationId: observation.observationId,
        sourceObjectId: attachmentId,
        maxAttempts: 5,
        payload: {
          schemaVersion: "gmail-review-attachment-extraction-job-v1",
          attachmentObservationId: observation.observationId,
          attachmentObservationContentHash: contentHash,
          attachmentId,
          messageId,
          threadId,
          historyId,
          parentObservationId: attachmentObservationId,
          rawSha256: rawObject.hash,
          extractionStatus: extraction.status,
          extractionMethod: extraction.method,
          extractionProvenance,
          filename,
          mimeType,
        },
      });
    }
    const claimJobQueued = childJobs.some((child) => child.jobKind === CLAIM_JOB_KIND);
    const reviewJobQueued = childJobs.some((child) => child.jobKind === REVIEW_JOB_KIND);
    throwIfAborted(workerContext.signal, {
      stage: `Gmail attachment completion ${job.jobId}`,
      deadlineAtMs: workerContext.deadlineAtMs,
    });
    return jobLedger.completeJob({
      ...fenced(job, workerContext),
      result: {
        schemaVersion: "gmail-attachment-evidence-result-v1",
        attachmentId,
        attachmentObservationId: observation.observationId,
        extractionStatus: extraction.status,
        reviewRequired: extraction.reviewRequired,
        claimJobQueued,
        reviewJobQueued,
      },
      observations: [observation],
      childJobs,
    });
  }

  async function run(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("run input", "must be an object");
    const workerId = requireString(input.workerId, "workerId");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("signal", "must be an AbortSignal or null");
    throwIfAborted(signal, { stage: "Gmail attachment worker claim", deadlineAtMs: input.deadlineAtMs });
    const processorVersion = requireString(input.processorVersion || WORKER_VERSION, "processorVersion");
    const limit = input.limit === undefined ? 10 : Number(input.limit);
    const leaseSeconds = input.leaseSeconds === undefined ? 900 : Number(input.leaseSeconds);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw invalidArgument("limit", "must be an integer from 1 through 50");
    }
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
      throw invalidArgument("leaseSeconds", "must be an integer from 30 through 900");
    }
    throwIfAborted(signal, { stage: "Gmail attachment worker claim", deadlineAtMs: input.deadlineAtMs });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: [JOB_KIND],
    });
    const outcomes = [];
    for (const job of claim.jobs || []) {
      try {
        throwIfAborted(signal, {
          stage: `Gmail attachment job ${job.jobId}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const receipt = await processJob(job, {
          workerId,
          processorVersion,
          leaseSeconds,
          signal,
          deadlineAtMs: input.deadlineAtMs,
        });
        outcomes.push({ jobId: job.jobId, status: "succeeded", receipt });
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `Gmail attachment job ${job.jobId}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `Gmail attachment job ${job.jobId}`,
            deadlineAtMs: input.deadlineAtMs,
            outcomeUnknown: error?.outcomeUnknown === true,
          });
        }
        throwIfAborted(signal, {
          stage: `Gmail attachment failure acknowledgement ${job.jobId}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const failure = safeFailure(error);
        let receipt = null;
        try {
          throwIfAborted(signal, {
            stage: `Gmail attachment failure acknowledgement ${job.jobId}`,
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
              stage: `Gmail attachment failure acknowledgement ${job.jobId}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
          outcomes.push({
            jobId: String(job.jobId || ""),
            status: "ack_failed",
            errorCode: failure.code,
            ackErrorCode: String(ackError?.code || "SOURCE_PROCESSING_JOB_ACK_FAILED"),
          });
          continue;
        }
        outcomes.push({
          jobId: String(job.jobId || ""),
          status: receipt?.state === "dead_letter" ? "dead_letter" : "retry_wait",
          errorCode: failure.code,
          receipt,
        });
      }
    }
    return Object.freeze({
      ok: true,
      workerId,
      processorVersion,
      claimedCount: Number(claim.claimedCount || 0),
      succeededCount: outcomes.filter((item) => item.status === "succeeded").length,
      failedCount: outcomes.filter((item) => item.status !== "succeeded").length,
      outcomes,
    });
  }

  return Object.freeze({ processJob, run });
}

module.exports = {
  CLAIM_JOB_KIND,
  GmailAttachmentWorkerError,
  JOB_KIND,
  REVIEW_JOB_KIND,
  SCHEMA_VERSION,
  WORKER_VERSION,
  createGmailAttachmentWorker,
  deterministicAttachmentExtraction,
  _test: {
    canonicalize,
    decodeUtf8,
    htmlToText,
    normalizeMimeType,
    normalizeRawReference,
    observationIdentity,
    safeFailure,
    sha256Bytes,
    sha256Json,
    validateInjectedExtraction,
  },
};

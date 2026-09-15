"use strict";

const crypto = require("node:crypto");
const {
  CLASSIFICATIONS,
  MAX_ATTEMPTS,
} = require("./openai-gmail-attachment-model-extractor");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");

const JOB_KIND = "gmail_review_attachment_extraction";
const RESULT_SCHEMA_VERSION = "truth-gmail-attachment-model-worker-result-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const RETRYABLE_CLASSIFICATIONS = new Set([
  CLASSIFICATIONS.RATE_LIMIT_EXCEEDED,
  CLASSIFICATIONS.SERVER_ERROR,
]);

class TruthGmailAttachmentModelWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthGmailAttachmentModelWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthGmailAttachmentModelWorkerError(
    `Invalid Gmail attachment model worker ${field}: ${reason}`,
    { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_WORKER_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, maximumBytes = 4096) {
  if (typeof value !== "string" || !value || value.trim() !== value ||
      Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalid(field, "must be a non-empty bounded trimmed string");
  }
  return value;
}

function integer(value, field, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireMethod(value, method, field) {
  if (!value || typeof value[method] !== "function") {
    throw invalid(field, `must expose ${method}()`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneJson(value, field = "value") {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) {
      throw new Error("unbounded");
    }
    return JSON.parse(serialized);
  } catch {
    throw invalid(field, "must be bounded JSON");
  }
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeJob(value) {
  if (!isPlainObject(value) || value.jobKind !== JOB_KIND ||
      !UUID_RE.test(String(value.jobId || "")) ||
      !Number.isSafeInteger(value.leaseFence) || value.leaseFence < 1) {
    throw new TruthGmailAttachmentModelWorkerError(
      "Claimed Gmail attachment-review job has an invalid fenced identity",
      { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_JOB_INVALID" },
    );
  }
  return value;
}

function safeErrorCode(error, fallback = "TRUTH_GMAIL_ATTACHMENT_MODEL_JOB_FAILED") {
  const candidate = String(error?.code || fallback).toUpperCase();
  return /^[A-Z][A-Z0-9_]{2,99}$/.test(candidate) ? candidate : fallback;
}

function createTruthGmailAttachmentModelWorker(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const jobLedger = requireMethod(options.jobLedger, "claimJobs", "options.jobLedger");
  requireMethod(jobLedger, "renewJob", "options.jobLedger");
  requireMethod(jobLedger, "failJob", "options.jobLedger");
  const modelLedger = requireMethod(options.modelLedger, "loadContext", "options.modelLedger");
  for (const method of [
    "adoptPrior", "createRequest", "reserveRequest", "beginAttempt", "reconcileAttempt", "completeExtraction",
  ]) requireMethod(modelLedger, method, "options.modelLedger");
  const rawStore = requireMethod(options.rawStore, "getRawObject", "options.rawStore");
  const providerAdapter = requireMethod(
    options.providerAdapter,
    "prepareRequest",
    "options.providerAdapter",
  );
  requireMethod(providerAdapter, "executeAuthorizedAttempt", "options.providerAdapter");
  const workerId = text(options.workerId, "options.workerId", 500);
  const processorVersion = text(options.processorVersion, "options.processorVersion", 500);
  const leaseSeconds = integer(options.leaseSeconds ?? 900, "options.leaseSeconds", 30, 900);
  const retryAfterSeconds = integer(
    options.retryAfterSeconds ?? 5,
    "options.retryAfterSeconds",
    1,
    3600,
  );

  const fenced = (job) => ({
    jobId: job.jobId,
    workerId,
    leaseFence: job.leaseFence,
    processorVersion,
  });

  async function renew(job, runtime, stage) {
    throwIfAborted(runtime.signal, { stage, deadlineAtMs: runtime.deadlineAtMs });
    return jobLedger.renewJob({ ...fenced(job), leaseSeconds });
  }

  async function acknowledge(job, fields, runtime) {
    throwIfAborted(runtime.signal, {
      stage: `Gmail attachment model acknowledgement ${job.jobId}`,
      deadlineAtMs: runtime.deadlineAtMs,
    });
    const errorCode = text(fields.errorCode, "errorCode", 100);
    const failureInput = {
      ...fenced(job),
      errorCode,
      safeErrorDetail: JSON.stringify({
        schemaVersion: "truth-gmail-attachment-model-acknowledgement-v1",
        requestId: String(fields.requestId || ""),
        requestState: String(fields.requestState || ""),
        classification: String(fields.classification || ""),
        reasonCode: errorCode,
        productionPublicationAttempted: false,
      }),
    };
    if (fields.retry === true) failureInput.retryAfterSeconds = retryAfterSeconds;
    const failureReceipt = await jobLedger.failJob(failureInput);
    const retryScheduled = fields.retry === true || failureReceipt?.state === "retry_wait";
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      outcome: fields.retry === true ? "retry_scheduled" : "review_required",
      retryScheduled,
      reviewRequired: fields.retry !== true,
      requestId: String(fields.requestId || ""),
      requestState: String(fields.requestState || ""),
      classification: String(fields.classification || ""),
      failureReceipt,
      productionPublicationAttempted: false,
    });
  }

  async function finishSucceeded(job, request, runtime) {
    await renew(job, runtime, `Gmail attachment model completion renewal ${job.jobId}`);
    const completion = await modelLedger.completeExtraction({
      ...fenced(job),
      requestId: request.requestId,
      decidedBy: workerId,
      reason: "Pinned model read every reported page from immutable attachment bytes; exact model evidence was appended for operator-reviewed claims.",
    });
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      outcome: "succeeded",
      requestId: request.requestId,
      reservedMicroUsd: request.reservedMicroUsd,
      actualMicroUsd: request.actualMicroUsd,
      completion,
      productionPublicationAttempted: false,
    });
  }

  async function routeRequest(job, request, runtime, classification = "") {
    if (!isPlainObject(request) || typeof request.state !== "string" ||
        !/^gmail-attachment-model-request:v1:[0-9a-f]{64}$/.test(String(request.requestId || ""))) {
      throw new TruthGmailAttachmentModelWorkerError("Model ledger returned an invalid request state", {
        code: "TRUTH_GMAIL_ATTACHMENT_MODEL_REQUEST_STATE_INVALID",
      });
    }
    if (request.state === "succeeded") return finishSucceeded(job, request, runtime);
    if (["review_required", "outcome_unknown"].includes(request.state)) {
      return acknowledge(job, {
        errorCode: request.state === "outcome_unknown"
          ? "ATTACHMENT_MODEL_OUTCOME_UNKNOWN"
          : "ATTACHMENT_MODEL_REVIEW_REQUIRED",
        requestId: request.requestId,
        requestState: request.state,
        classification,
      }, runtime);
    }
    return null;
  }

  async function processJob(rawJob, runtime = {}) {
    const job = normalizeJob(rawJob);
    throwIfAborted(runtime.signal, {
      stage: `Gmail attachment model context ${job.jobId}`,
      deadlineAtMs: runtime.deadlineAtMs,
    });
    const context = await modelLedger.loadContext(fenced(job));
    const adoption = await modelLedger.adoptPrior(fenced(job));
    if (adoption.adopted === true) {
      return deepFreeze({
        ok: true,
        jobId: job.jobId,
        outcome: "succeeded",
        adopted: true,
        adoption,
        reservedMicroUsd: 0,
        actualMicroUsd: 0,
        reviewRequired: adoption.disposition === "prior_operator_review_remains_open",
        productionPublicationAttempted: false,
      });
    }
    const raw = await rawStore.getRawObject({
      key: context.rawObject.key,
      expectedSha256: context.rawObject.hash,
      expectedBytes: context.rawObject.bytes,
    });
    if (!isPlainObject(raw) || !Buffer.isBuffer(raw.bytes) ||
        raw.bytes.length !== context.rawBytes || sha256Bytes(raw.bytes) !== context.rawSha256) {
      throw new TruthGmailAttachmentModelWorkerError(
        "Immutable attachment bytes failed the second local integrity check",
        { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_RAW_INTEGRITY_MISMATCH" },
      );
    }
    const prepared = providerAdapter.prepareRequest({
      bytes: raw.bytes,
      rawSha256: context.rawSha256,
      filename: context.filename,
      mimeType: context.mimeType,
      sourceObservationId: context.observationId,
      sourceObservationContentHash: context.observationContentHash,
    });
    await renew(job, runtime, `Gmail attachment model request renewal ${job.jobId}`);
    let request = await modelLedger.createRequest({
      ...fenced(job),
      requestBodyHash: prepared.requestBodyHash,
      requestBodyBytes: prepared.requestBodyBytes,
    });
    let terminal = await routeRequest(job, request, runtime);
    if (terminal) return terminal;
    if (request.state === "planned") {
      request = await modelLedger.reserveRequest({ ...fenced(job), requestId: request.requestId });
      terminal = await routeRequest(job, request, runtime);
      if (terminal) return terminal;
    }
    if (request.state === "in_flight") {
      return acknowledge(job, {
        errorCode: "ATTACHMENT_MODEL_OUTCOME_UNKNOWN",
        requestId: request.requestId,
        requestState: request.state,
      }, runtime);
    }
    if (request.state !== "reserved") {
      throw new TruthGmailAttachmentModelWorkerError(
        `Attachment model request cannot dispatch from ${request.state}`,
        { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_REQUEST_STATE_INVALID" },
      );
    }

    await renew(job, runtime, `Gmail attachment model dispatch renewal ${job.jobId}`);
    const authorization = await modelLedger.beginAttempt({
      ...fenced(job),
      requestId: request.requestId,
      requestBodyHash: prepared.requestBodyHash,
      requestBodyBytes: prepared.requestBodyBytes,
    });
    if (authorization?.sendAuthorized !== true) {
      terminal = await routeRequest(job, authorization, runtime);
      if (terminal) return terminal;
      return acknowledge(job, {
        errorCode: "ATTACHMENT_MODEL_OUTCOME_UNKNOWN",
        requestId: request.requestId,
        requestState: String(authorization?.state || "in_flight"),
      }, runtime);
    }

    // The provider consumes this exact dispatch before its first await. After
    // that point, no catch path may authorize or send a second request.
    const providerResult = await providerAdapter.executeAuthorizedAttempt(
      authorization,
      prepared,
      { signal: runtime.signal || null },
    );
    request = await modelLedger.reconcileAttempt({
      ...fenced(job),
      requestId: request.requestId,
      providerResult,
    });
    terminal = await routeRequest(job, request, runtime, providerResult.classification);
    if (terminal) return terminal;
    if (request.state === "reserved" && providerResult.retryable === true &&
        RETRYABLE_CLASSIFICATIONS.has(providerResult.classification) &&
        authorization.attemptNumber < MAX_ATTEMPTS) {
      return acknowledge(job, {
        errorCode: "ATTACHMENT_MODEL_PROVIDER_RETRY_RESERVED",
        requestId: request.requestId,
        requestState: request.state,
        classification: providerResult.classification,
        retry: true,
      }, runtime);
    }
    throw new TruthGmailAttachmentModelWorkerError(
      "Attachment model reconciliation did not reach a permitted durable state",
      { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_RECONCILIATION_INVALID" },
    );
  }

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalid("runOnce", "must be an object");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalid("signal", "must be an AbortSignal or null");
    const limit = integer(input.limit ?? 2, "limit", 1, 10);
    throwIfAborted(signal, {
      stage: "Gmail attachment model claim",
      deadlineAtMs: input.deadlineAtMs,
    });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: [JOB_KIND],
    });
    if (!Array.isArray(claim?.jobs)) {
      throw new TruthGmailAttachmentModelWorkerError(
        "Source-processing ledger returned an invalid attachment-model claim receipt",
        { code: "TRUTH_GMAIL_ATTACHMENT_MODEL_CLAIM_INVALID" },
      );
    }
    const jobs = [];
    for (const rawJob of claim.jobs) {
      try {
        jobs.push(await processJob(rawJob, { signal, deadlineAtMs: input.deadlineAtMs }));
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `Gmail attachment model job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `Gmail attachment model job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        const job = isPlainObject(rawJob) ? rawJob : {};
        let failureReceipt = null;
        try {
          failureReceipt = await jobLedger.failJob({
            ...fenced(job),
            errorCode: safeErrorCode(error),
            safeErrorDetail: JSON.stringify({
              schemaVersion: "truth-gmail-attachment-model-worker-failure-v1",
              errorCode: safeErrorCode(error),
              productionPublicationAttempted: false,
            }),
            retryAfterSeconds,
          });
        } catch (acknowledgementError) {
          if (acknowledgementError?.outcomeUnknown === true || isAbortError(acknowledgementError, signal)) {
            throw asOutcomeUnknownError(acknowledgementError, {
              signal,
              stage: `Gmail attachment model failure acknowledgement ${job.jobId || "unknown"}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
        }
        jobs.push(deepFreeze({
          ok: false,
          jobId: String(job.jobId || ""),
          errorCode: safeErrorCode(error),
          failureReceipt,
          productionPublicationAttempted: false,
        }));
      }
    }
    const succeeded = jobs.filter((job) => job.outcome === "succeeded");
    const reviews = jobs.filter((job) => job.reviewRequired === true);
    const retries = jobs.filter((job) => job.retryScheduled === true);
    const failures = jobs.filter((job) => job.ok !== true);
    return deepFreeze({
      ok: failures.length === 0,
      schemaVersion: RESULT_SCHEMA_VERSION,
      claimedCount: claim.jobs.length,
      succeededCount: succeeded.length,
      failedCount: failures.length,
      reviewCount: reviews.length,
      requeuedCount: retries.length,
      reservedMicroUsd: succeeded.reduce((sum, job) => sum + job.reservedMicroUsd, 0),
      actualMicroUsd: succeeded.reduce((sum, job) => sum + job.actualMicroUsd, 0),
      jobs,
      productionPublicationAttempted: false,
    });
  }

  return Object.freeze({
    jobKind: JOB_KIND,
    workerId,
    processorVersion,
    processJob,
    runOnce,
  });
}

module.exports = Object.freeze({
  JOB_KIND,
  RESULT_SCHEMA_VERSION,
  TruthGmailAttachmentModelWorkerError,
  createTruthGmailAttachmentModelWorker,
  _test: Object.freeze({ cloneJson, normalizeJob, safeErrorCode, sha256Bytes }),
});

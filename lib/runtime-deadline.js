"use strict";

const DEFAULT_RESPONSE_RESERVE_MS = 15_000;

class RuntimeDeadlineError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RuntimeDeadlineError";
    this.code = fields.code || "TRUTH_RUNTIME_DEADLINE_EXCEEDED";
    this.stage = fields.stage || "runtime";
    this.retryable = true;
    this.deadlineExceeded = fields.deadlineExceeded !== false;
    this.outcomeUnknown = fields.outcomeUnknown === true;
    const hasDeadline = fields.deadlineAtMs !== undefined
      && fields.deadlineAtMs !== null
      && fields.deadlineAtMs !== "";
    this.deadlineAtMs = hasDeadline && Number.isFinite(Number(fields.deadlineAtMs))
      ? Number(fields.deadlineAtMs)
      : null;
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

class RuntimeOutcomeUnknownError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RuntimeOutcomeUnknownError";
    this.code = fields.code || "TRUTH_RUNTIME_OUTCOME_UNKNOWN";
    this.stage = fields.stage || "runtime";
    this.retryable = true;
    this.outcomeUnknown = true;
    this.deadlineExceeded = fields.deadlineExceeded === true;
    const hasDeadline = fields.deadlineAtMs !== undefined
      && fields.deadlineAtMs !== null
      && fields.deadlineAtMs !== "";
    this.deadlineAtMs = hasDeadline && Number.isFinite(Number(fields.deadlineAtMs))
      ? Number(fields.deadlineAtMs)
      : null;
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function isAbortSignal(value) {
  return Boolean(value)
    && typeof value === "object"
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
}

function requireSignal(value, field = "signal") {
  if (value === undefined || value === null) return null;
  if (!isAbortSignal(value)) throw new TypeError(`${field} must be an AbortSignal`);
  return value;
}

function deadlineError({
  stage = "runtime",
  deadlineAtMs = null,
  outcomeUnknown = false,
  cause = null,
  code = "TRUTH_RUNTIME_DEADLINE_EXCEEDED",
} = {}) {
  return new RuntimeDeadlineError(
    outcomeUnknown
      ? `Runtime deadline expired during ${stage}; the durable outcome is unknown and must be reconciled idempotently.`
      : `Runtime deadline expired before ${stage} could complete.`,
    { stage, deadlineAtMs, outcomeUnknown, cause, code },
  );
}

function isAbortError(error, signal = null) {
  return Boolean(signal?.aborted)
    || error instanceof RuntimeDeadlineError
    || error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || error?.code === "ABORT_ERR"
    || error?.code === "TRUTH_RUNTIME_DEADLINE_EXCEEDED"
    || error?.deadlineExceeded === true;
}

function asDeadlineError(error, {
  signal = null,
  stage = "runtime",
  deadlineAtMs = null,
  outcomeUnknown = false,
} = {}) {
  if (!isAbortError(error, signal)) return error;
  const reason = signal?.aborted ? signal.reason : null;
  const source = reason instanceof Error ? reason : error instanceof Error ? error : null;
  return deadlineError({
    stage,
    deadlineAtMs: deadlineAtMs ?? source?.deadlineAtMs ?? null,
    outcomeUnknown: outcomeUnknown || source?.outcomeUnknown === true,
    cause: source,
    code: source?.code === "TRUTH_RUNTIME_ABORTED"
      ? "TRUTH_RUNTIME_ABORTED"
      : "TRUTH_RUNTIME_DEADLINE_EXCEEDED",
  });
}

function asOutcomeUnknownError(error, {
  signal = null,
  stage = "runtime",
  deadlineAtMs = null,
  code = "TRUTH_RUNTIME_OUTCOME_UNKNOWN",
} = {}) {
  if (isAbortError(error, signal)) {
    return asDeadlineError(error, {
      signal,
      stage,
      deadlineAtMs,
      outcomeUnknown: true,
    });
  }
  if (error instanceof RuntimeOutcomeUnknownError && error.stage === stage) return error;
  return new RuntimeOutcomeUnknownError(
    `The durable outcome of ${stage} is unknown and must be reconciled idempotently.`,
    {
      stage,
      deadlineAtMs: deadlineAtMs ?? error?.deadlineAtMs ?? null,
      deadlineExceeded: error?.deadlineExceeded === true,
      cause: error instanceof Error ? error : null,
      code,
    },
  );
}

function throwIfAborted(signal, options = {}) {
  const normalized = requireSignal(signal);
  const hasDeadline = options.deadlineAtMs !== undefined
    && options.deadlineAtMs !== null
    && options.deadlineAtMs !== "";
  const deadlineAtMs = hasDeadline ? Number(options.deadlineAtMs) : null;
  if (Number.isFinite(deadlineAtMs)) {
    const now = options.now || Date.now;
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs)) throw new TypeError("now must return finite epoch milliseconds");
    if (nowMs >= deadlineAtMs) {
      throw deadlineError({
        stage: options.stage || "runtime",
        deadlineAtMs,
        outcomeUnknown: options.outcomeUnknown === true,
      });
    }
  }
  if (normalized?.aborted) {
    throw asDeadlineError(normalized.reason, { ...options, signal: normalized });
  }
}

function composeAbortSignals(signals = []) {
  const normalized = [...new Set(signals.filter((signal) => signal !== undefined && signal !== null)
    .map((signal, index) => requireSignal(signal, `signals[${index}]`)))];
  if (!normalized.length) return { signal: null, cleanup() {} };
  if (normalized.length === 1) return { signal: normalized[0], cleanup() {} };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any(normalized), cleanup() {} };
  }

  const controller = new AbortController();
  const listeners = [];
  const forward = (source) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  for (const source of normalized) {
    if (source.aborted) {
      forward(source);
      break;
    }
    const listener = () => forward(source);
    source.addEventListener("abort", listener, { once: true });
    listeners.push([source, listener]);
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
      listeners.length = 0;
    },
  };
}

function createAbortScope(options = {}) {
  const now = options.now || Date.now;
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  const parentSignal = requireSignal(options.signal);
  const stage = String(options.stage || "request");
  const outcomeUnknown = options.outcomeUnknown === true;
  const startedAtMs = Number(now());
  if (!Number.isFinite(startedAtMs)) throw new TypeError("now must return finite epoch milliseconds");

  let deadlineAtMs = null;
  if (options.deadlineAtMs !== undefined && options.deadlineAtMs !== null) {
    deadlineAtMs = Number(options.deadlineAtMs);
  } else if (options.timeoutMs !== undefined && options.timeoutMs !== null) {
    const timeoutMs = Number(options.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
    deadlineAtMs = startedAtMs + timeoutMs;
  }
  if (!Number.isFinite(deadlineAtMs)) throw new TypeError("deadlineAtMs or timeoutMs is required");

  const controller = new AbortController();
  const remainingMs = Math.max(0, deadlineAtMs - startedAtMs);
  let timer = null;
  if (remainingMs === 0) {
    controller.abort(deadlineError({ stage, deadlineAtMs, outcomeUnknown }));
  } else {
    timer = setTimer(() => {
      controller.abort(deadlineError({ stage, deadlineAtMs, outcomeUnknown }));
    }, remainingMs);
  }
  const composed = composeAbortSignals([parentSignal, controller.signal]);
  return {
    signal: composed.signal,
    deadlineAtMs,
    cleanup() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      composed.cleanup();
    },
  };
}

function createRuntimeDeadline(options = {}) {
  const now = options.now || Date.now;
  const startedAtMs = Number(now());
  const deadlineAtMs = Number(options.deadlineAtMs);
  const responseReserveMs = Number(options.responseReserveMs ?? DEFAULT_RESPONSE_RESERVE_MS);
  if (!Number.isFinite(startedAtMs)) throw new TypeError("now must return finite epoch milliseconds");
  if (!Number.isFinite(deadlineAtMs) || deadlineAtMs <= startedAtMs) {
    throw new TypeError("deadlineAtMs must be a future finite epoch-millisecond value");
  }
  if (!Number.isSafeInteger(responseReserveMs) || responseReserveMs < 1_000) {
    throw new TypeError("responseReserveMs must be an integer of at least 1000");
  }
  const workDeadlineAtMs = deadlineAtMs - responseReserveMs;
  if (workDeadlineAtMs <= startedAtMs) {
    throw new TypeError("deadlineAtMs must leave time for the configured response reserve");
  }
  const scope = createAbortScope({
    signal: options.signal,
    deadlineAtMs: workDeadlineAtMs,
    now,
    setTimeoutImpl: options.setTimeoutImpl,
    clearTimeoutImpl: options.clearTimeoutImpl,
    stage: options.stage || "hosted runtime work",
  });
  return Object.freeze({
    signal: scope.signal,
    deadlineAtMs,
    workDeadlineAtMs,
    responseReserveMs,
    remainingMs() {
      return Math.max(0, workDeadlineAtMs - Number(now()));
    },
    throwIfExpired(stage = "hosted runtime work", outcomeUnknown = false) {
      throwIfAborted(scope.signal, { stage, deadlineAtMs: workDeadlineAtMs, outcomeUnknown });
    },
    close: scope.cleanup,
  });
}

function abortableSleep(milliseconds, signal, options = {}) {
  const duration = Number(milliseconds);
  if (!Number.isFinite(duration) || duration < 0) throw new TypeError("milliseconds must be non-negative");
  const normalized = requireSignal(signal);
  throwIfAborted(normalized, options);
  if (duration === 0) return Promise.resolve();
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer !== null) clearTimer(timer);
      normalized?.removeEventListener("abort", onAbort);
      reject(asDeadlineError(normalized?.reason, { ...options, signal: normalized }));
    };
    timer = setTimer(() => {
      normalized?.removeEventListener("abort", onAbort);
      resolve();
    }, duration);
    normalized?.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = Object.freeze({
  DEFAULT_RESPONSE_RESERVE_MS,
  RuntimeDeadlineError,
  RuntimeOutcomeUnknownError,
  abortableSleep,
  asDeadlineError,
  asOutcomeUnknownError,
  composeAbortSignals,
  createAbortScope,
  createRuntimeDeadline,
  deadlineError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
});

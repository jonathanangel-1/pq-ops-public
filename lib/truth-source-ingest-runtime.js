"use strict";

const { buildTmsSourceSnapshot } = require("./tms-source-snapshot");
const { buildTrackingSourceSnapshot } = require("./tracking-source-snapshot");
const { createSourceSnapshotLedger } = require("./source-snapshot-ledger");
const { commitBuiltSourceSnapshot } = require("./source-snapshot-committer");
const { createTruthTrackingScopeLedger } = require("./truth-tracking-scope-ledger");

const RUNTIME_VERSION = "truth-source-ingest-runtime-v1";
const SOURCE_CONFIG = Object.freeze({
  tms: Object.freeze({
    connectionKey: "couriercloud-ops-tlv-us",
    build: buildTmsSourceSnapshot,
  }),
  tracking: Object.freeze({
    connectionKey: "carrier-tracking-primary",
    build: buildTrackingSourceSnapshot,
  }),
});

class TruthSourceIngestRuntimeError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthSourceIngestRuntimeError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthSourceIngestRuntimeError(`Invalid truth-source ingest ${field}: ${reason}`, {
    code: "TRUTH_SOURCE_INGEST_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { maxBytes = 8192 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function safeCode(error) {
  return String(error?.code || "SOURCE_SNAPSHOT_PREFLIGHT_FAILED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 100) || "SOURCE_SNAPSHOT_PREFLIGHT_FAILED";
}

function safeDetail(error) {
  return String(error?.message || "Source snapshot failed structural preflight")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(access_token|refresh_token|client_secret|authorization|apikey)=([^\s&;,]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\0]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function sourcePayload(sourceSystem, payload) {
  if (!isPlainObject(payload)) throw invalid("payload", "must be an object");
  if (sourceSystem === "tms") return payload.snapshot ?? payload;
  if (sourceSystem === "tracking") return payload.snapshot ?? payload.trackingSnapshot ?? payload;
  throw invalid("sourceSystem", "is unsupported");
}

function requireLedger(ledger, sourceSystem, workspaceKey, connectionKey) {
  if (!ledger || typeof ledger !== "object") throw invalid("ledger", "must be an object");
  for (const method of [
    "recordPreflightFailure",
    "recoverCommittedSnapshot",
    "acquireLease",
    "beginSnapshotBatch",
    "commitSnapshotBatch",
    "failSnapshotBatch",
  ]) {
    if (typeof ledger[method] !== "function") throw invalid(`ledger.${method}`, "must be a function");
  }
  if (ledger.scope?.sourceSystem !== sourceSystem
      || ledger.scope?.workspaceKey !== workspaceKey
      || ledger.scope?.connectionKey !== connectionKey) {
    throw new TruthSourceIngestRuntimeError("Source ledger scope does not match the runtime source", {
      code: "TRUTH_SOURCE_INGEST_SCOPE_MISMATCH",
      sourceSystem,
    });
  }
  return ledger;
}

function createTruthSourceIngestRuntime(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey || "primary", "workspaceKey", { maxBytes: 128 });
  const syncToken = text(options.syncToken ?? process.env.PQ_SUPABASE_SYNC_TOKEN ?? "", "syncToken", {
    maxBytes: 4096,
  });
  const sourceConfig = options.sourceConfig || SOURCE_CONFIG;
  if (!isPlainObject(sourceConfig)) throw invalid("sourceConfig", "must be an object");
  // The snapshot ledger deliberately has no live RPC fallback; hosted callers
  // (api/truth/source-ingest.js) inject the live caller explicitly here.
  const callRpc = options.callRpc;
  if (callRpc !== undefined && typeof callRpc !== "function") {
    throw invalid("callRpc", "must be a function when provided");
  }
  const buildLedger = options.createLedger || ((input) => createSourceSnapshotLedger(
    callRpc ? { ...input, callRpc } : input,
  ));
  const commit = options.commit || commitBuiltSourceSnapshot;
  const trackingScopeLedger = options.trackingScopeLedger || createTruthTrackingScopeLedger({
    workspaceKey,
    syncToken,
  });
  if (typeof buildLedger !== "function" || typeof commit !== "function") {
    throw invalid("dependencies", "createLedger and commit must be functions");
  }
  if (!trackingScopeLedger || typeof trackingScopeLedger.read !== "function") {
    throw invalid("trackingScopeLedger", "must expose read()");
  }

  async function ingest(input = {}) {
    if (!isPlainObject(input)) throw invalid("ingest", "must be an object");
    const sourceSystem = text(input.sourceSystem, "sourceSystem");
    if (sourceSystem === "operator") {
      throw new TruthSourceIngestRuntimeError(
        "Operator truth requires the server-authoritative operator-event runtime",
        {
          code: "TRUTH_OPERATOR_EVENT_AUTHORITY_REQUIRED",
          sourceSystem,
          stage: "authority",
          retryable: false,
        },
      );
    }
    const config = sourceConfig[sourceSystem];
    if (!config || typeof config.build !== "function") throw invalid("sourceSystem", "is unsupported");
    const connectionKey = text(config.connectionKey, `sourceConfig.${sourceSystem}.connectionKey`);
    const ownerId = text(input.ownerId, "ownerId", { maxBytes: 500 });
    const ledger = requireLedger(buildLedger({
      workspaceKey,
      sourceSystem,
      connectionKey,
      syncToken,
    }), sourceSystem, workspaceKey, connectionKey);

    let built;
    try {
      const buildOptions = { workspaceKey, connectionKey };
      if (sourceSystem === "tracking") {
        const scopeToken = text(input.scopeToken || input.payload?.scopeToken, "scopeToken");
        const scope = await trackingScopeLedger.read({ scopeToken });
        if (scope.workspaceKey !== workspaceKey || scope.trackingConnectionKey !== connectionKey) {
          throw new TruthSourceIngestRuntimeError("Tracking scope does not match the ingest ledger", {
            code: "TRUTH_SOURCE_INGEST_TRACKING_SCOPE_MISMATCH",
          });
        }
        buildOptions.expectedAwbs = scope.expectedAwbs;
        buildOptions.scopeToken = scope.scopeToken;
      }
      built = config.build(sourcePayload(sourceSystem, input.payload), buildOptions);
    } catch (error) {
      let failureReceipt = null;
      let failureEvidenceError = null;
      try {
        failureReceipt = await ledger.recordPreflightFailure({
          ownerId,
          errorCode: safeCode(error),
          safeErrorDetail: safeDetail(error),
          diagnostics: isPlainObject(error?.diagnostics) ? error.diagnostics : {
            sourceSystem,
            runtimeVersion: RUNTIME_VERSION,
            structuralPreflightPassed: false,
          },
        });
      } catch (failureError) {
        failureEvidenceError = failureError;
      }
      throw new TruthSourceIngestRuntimeError(
        `Source ${sourceSystem} failed before cursor commit: ${error?.message || String(error)}`,
        {
          code: safeCode(error),
          sourceSystem,
          stage: "preflight",
          retryable: error?.retryable === true,
          failureReceipt,
          failureEvidenceError,
          cause: error instanceof Error ? error : new Error(String(error)),
        },
      );
    }

    try {
      const result = await commit({
        builtSnapshot: built,
        ledger,
        ownerId,
        triggerName: `${RUNTIME_VERSION}:${sourceSystem}`,
        recoveryTriggerName: `${RUNTIME_VERSION}:${sourceSystem}:recovery`,
        ttlSeconds: input.ttlSeconds,
      });
      return deepFreeze({
        ok: true,
        sourceSystem,
        workspaceKey,
        connectionKey,
        runtimeVersion: RUNTIME_VERSION,
        payloadIdentity: result.payloadIdentity,
        recovered: result.recovered === true,
        committedCursorValue: result.commit?.committedCursorValue || built.nextCursorValue,
        committedCursorVersion: result.commit?.committedCursorVersion ?? null,
        observationCount: built.observations.length,
        jobCount: built.jobs.length,
        mutatesOperationalState: false,
        reducesTruth: false,
        publishesTruth: false,
        result,
      });
    } catch (error) {
      if (error instanceof TruthSourceIngestRuntimeError) throw error;
      throw new TruthSourceIngestRuntimeError(
        `Source ${sourceSystem} commit failed: ${error?.message || String(error)}`,
        {
          code: safeCode(error),
          sourceSystem,
          stage: "commit",
          retryable: error?.retryable === true,
          outcomeUnknown: error?.outcomeUnknown === true,
          cause: error instanceof Error ? error : new Error(String(error)),
        },
      );
    }
  }

  return Object.freeze({ runtimeVersion: RUNTIME_VERSION, workspaceKey, ingest });
}

module.exports = Object.freeze({
  RUNTIME_VERSION,
  SOURCE_CONFIG,
  TruthSourceIngestRuntimeError,
  createTruthSourceIngestRuntime,
  _test: Object.freeze({ safeCode, safeDetail, sourcePayload }),
});

"use strict";

const SUPPORTED_SOURCES = new Set(["tms", "tracking", "operator"]);

class SourceSnapshotCommitterError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "SourceSnapshotCommitterError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new SourceSnapshotCommitterError(`Invalid source-snapshot commit ${field}: ${reason}`, {
    code: "SOURCE_SNAPSHOT_COMMIT_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  return value;
}

function cloneJson(value, field = "value", depth = 0) {
  if (depth > 24) throw invalid(field, "exceeds maximum JSON depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${field}[${index}]`, depth + 1));
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw invalid(`${field}.${key}`, "is forbidden");
      }
      if (value[key] !== undefined) result[key] = cloneJson(value[key], `${field}.${key}`, depth + 1);
    }
    return result;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requireLedger(value) {
  if (!value || typeof value !== "object") throw invalid("ledger", "must be an object");
  for (const method of [
    "recoverCommittedSnapshot",
    "acquireLease",
    "beginSnapshotBatch",
    "commitSnapshotBatch",
    "failSnapshotBatch",
  ]) {
    if (typeof value[method] !== "function") throw invalid(`ledger.${method}`, "must be a function");
  }
  return value;
}

function normalizeBuilt(value) {
  if (!isPlainObject(value)) throw invalid("builtSnapshot", "must be an object");
  const sourceSystem = text(value.sourceSystem, "builtSnapshot.sourceSystem");
  if (!SUPPORTED_SOURCES.has(sourceSystem)) throw invalid("builtSnapshot.sourceSystem", "is unsupported");
  const workspaceKey = text(value.workspaceKey, "builtSnapshot.workspaceKey");
  const connectionKey = text(value.connectionKey, "builtSnapshot.connectionKey");
  const nextCursorValue = text(value.nextCursorValue, "builtSnapshot.nextCursorValue");
  const payloadIdentity = text(value.payloadIdentity, "builtSnapshot.payloadIdentity");
  if (!payloadIdentity.startsWith(`${sourceSystem}-source-`)) {
    throw invalid("builtSnapshot.payloadIdentity", "does not bind the declared source system");
  }
  if (!isPlainObject(value.providerManifest) || value.providerManifest.complete !== true) {
    throw invalid("builtSnapshot.providerManifest", "must be a complete object");
  }
  if (String(value.providerManifest.upstreamWatermark || "") !== nextCursorValue) {
    throw invalid("builtSnapshot.providerManifest.upstreamWatermark", "must equal nextCursorValue");
  }
  if (!Array.isArray(value.observations) || !Array.isArray(value.jobs)) {
    throw invalid("builtSnapshot", "must include observations and jobs arrays");
  }
  if (value.providerManifest.recordCount !== value.observations.length || value.jobs.length !== value.observations.length) {
    throw invalid("builtSnapshot", "provider, observation, and job counts must be exact");
  }
  return deepFreeze({
    sourceSystem,
    workspaceKey,
    connectionKey,
    nextCursorValue,
    payloadIdentity,
    providerManifest: cloneJson(value.providerManifest, "builtSnapshot.providerManifest"),
    observations: cloneJson(value.observations, "builtSnapshot.observations"),
    jobs: cloneJson(value.jobs, "builtSnapshot.jobs"),
    diagnostics: cloneJson(value.diagnostics || {}, "builtSnapshot.diagnostics"),
  });
}

function safeCode(error) {
  return String(error?.code || "SOURCE_SNAPSHOT_COMMIT_REJECTED")
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 100) || "SOURCE_SNAPSHOT_COMMIT_REJECTED";
}

function ambiguous(error) {
  return error?.ambiguousOutcome === true
    || error?.outcomeUnknown === true
    || error?.code === "SOURCE_SNAPSHOT_LEDGER_INVALID_RECEIPT";
}

function rejected(stage, receipt) {
  return new SourceSnapshotCommitterError(`Source-snapshot ${stage} did not succeed`, {
    code: String(receipt?.code || "SOURCE_SNAPSHOT_COMMIT_LEDGER_REJECTED"),
    stage,
    retryable: String(receipt?.code || "") === "LEASE_BUSY",
    receipt,
  });
}

async function commitBuiltSourceSnapshot(input = {}) {
  if (!isPlainObject(input)) throw invalid("input", "must be an object");
  const built = normalizeBuilt(input.builtSnapshot);
  const ledger = requireLedger(input.ledger);
  const ownerId = text(input.ownerId, "ownerId");
  const scope = ledger.scope || {};
  if (scope.sourceSystem !== built.sourceSystem
      || scope.workspaceKey !== built.workspaceKey
      || scope.connectionKey !== built.connectionKey) {
    throw new SourceSnapshotCommitterError("Built source snapshot scope does not match its ledger scope", {
      code: "SOURCE_SNAPSHOT_COMMIT_SCOPE_MISMATCH",
      builtScope: {
        workspaceKey: built.workspaceKey,
        sourceSystem: built.sourceSystem,
        connectionKey: built.connectionKey,
      },
      ledgerScope: cloneJson(scope, "ledger.scope"),
    });
  }
  const snapshotPayload = {
    nextCursorValue: built.nextCursorValue,
    providerManifest: built.providerManifest,
    observations: built.observations,
    jobs: built.jobs,
  };
  const recovery = await ledger.recoverCommittedSnapshot(snapshotPayload);
  if (!recovery?.ok) throw rejected("recovery preflight", recovery);
  if (recovery.found) {
    return deepFreeze({
      ok: true,
      sourceSystem: built.sourceSystem,
      recovered: true,
      recoveryStage: "preflight",
      payloadIdentity: built.payloadIdentity,
      lease: null,
      batch: null,
      commit: cloneJson(recovery, "recovery"),
      diagnostics: built.diagnostics,
      mutatesOperationalState: false,
      reducesTruth: false,
      publishesTruth: false,
    });
  }

  const leaseInput = { ownerId };
  if (input.ttlSeconds !== undefined) leaseInput.ttlSeconds = input.ttlSeconds;
  const lease = await ledger.acquireLease(leaseInput);
  if (!lease?.ok) throw rejected("lease", lease);
  if (lease.status === "paused") {
    throw new SourceSnapshotCommitterError("Source snapshot cursor is paused", {
      code: "SOURCE_SNAPSHOT_COMMIT_CURSOR_PAUSED",
      stage: "lease",
      lease,
    });
  }
  const recoveryMode = ["error", "reconcile_required"].includes(lease.status);
  const triggerName = text(
    recoveryMode
      ? input.recoveryTriggerName || "source-snapshot-recovery"
      : input.triggerName || "source-snapshot-ingest",
    recoveryMode ? "recoveryTriggerName" : "triggerName",
  );
  const batch = await ledger.beginSnapshotBatch({
    ownerId,
    leaseFence: lease.leaseFence,
    recoveryMode,
    triggerName,
  });
  if (!batch?.ok) throw rejected("begin", batch);
  try {
    const commit = await ledger.commitSnapshotBatch({
      batchId: batch.batchId,
      ownerId,
      leaseFence: lease.leaseFence,
      ...snapshotPayload,
    });
    if (!commit?.ok) throw rejected("commit", commit);
    return deepFreeze({
      ok: true,
      sourceSystem: built.sourceSystem,
      recovered: Boolean(commit.recovered),
      payloadIdentity: built.payloadIdentity,
      lease: cloneJson(lease, "lease"),
      batch: cloneJson(batch, "batch"),
      commit: cloneJson(commit, "commit"),
      diagnostics: built.diagnostics,
      mutatesOperationalState: false,
      reducesTruth: false,
      publishesTruth: false,
    });
  } catch (error) {
    if (ambiguous(error)) {
      try {
        const recovered = await ledger.recoverCommittedSnapshot(snapshotPayload);
        if (recovered?.ok && recovered.found) {
          return deepFreeze({
            ok: true,
            sourceSystem: built.sourceSystem,
            recovered: true,
            recoveryStage: "ambiguous-commit",
            payloadIdentity: built.payloadIdentity,
            lease: cloneJson(lease, "lease"),
            batch: cloneJson(batch, "batch"),
            commit: cloneJson(recovered, "recovered"),
            diagnostics: built.diagnostics,
            mutatesOperationalState: false,
            reducesTruth: false,
            publishesTruth: false,
          });
        }
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
      }
      error.outcomeUnknown = true;
      throw error;
    }

    const errorCode = safeCode(error);
    try {
      const failure = await ledger.failSnapshotBatch({
        batchId: batch.batchId,
        ownerId,
        leaseFence: lease.leaseFence,
        errorCode,
        safeErrorDetail: `Snapshot commit was definitively rejected before cursor advance (${errorCode}).`,
      });
      if (!failure?.ok) throw rejected("failure witness", failure);
      error.failureReceipt = failure;
    } catch (failureEvidenceError) {
      error.failureEvidenceError = failureEvidenceError;
    }
    throw error;
  }
}

module.exports = Object.freeze({
  SUPPORTED_SOURCES,
  SourceSnapshotCommitterError,
  commitBuiltSourceSnapshot,
  _test: Object.freeze({ ambiguous, normalizeBuilt, safeCode }),
});

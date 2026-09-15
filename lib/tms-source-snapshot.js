"use strict";

// Deterministic source-boundary adapter for tms-detail-snapshot.json. It
// records one immutable observation and one extraction job per shipment. It
// does not interpret lifecycle state, reduce claims, build packets, or publish
// truth. Incomplete pulls are rejected before a ledger method can be called.

const crypto = require("node:crypto");

const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_EXTRACTOR_VERSION = "tms-extract-claims-v1";
const SNAPSHOT_SCHEMA_VERSION = "tms-detail-source-snapshot-v1";
const OBSERVATION_SCHEMA_VERSION = "tms-shipment-source-observation-v1";
const JOB_SCHEMA_VERSION = "tms-extract-claims-job-v1";
const ROW_MANIFEST_HASH_ALGORITHM = "length-prefixed-utf8-v1";

class TmsSourceSnapshotError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TmsSourceSnapshotError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function canonicalize(value, path = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (isPlainObject(value)) {
    return Object.keys(value).sort().reduce((output, key) => {
      if (value[key] === undefined) return output;
      output[key] = canonicalize(value[key], `${path}.${key}`);
      return output;
    }, {});
  }
  throw new TmsSourceSnapshotError(`${path} must contain only JSON-compatible values`, {
    code: "TMS_SOURCE_SNAPSHOT_INVALID_JSON",
    path,
  });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function lengthPrefixedUtf8(value) {
  const string = String(value ?? "");
  return `${Buffer.byteLength(string, "utf8")}:${string}`;
}

function hashRowManifest(rows) {
  return sha256(rows.map((row) => [
    row.sourceObjectId,
    row.order,
    row.trackingNumber,
    row.observationId,
    row.contentHash,
  ].map(lengthPrefixedUtf8).join("")).join(""));
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function issue(code, path, message, evidenceIds = []) {
  return {
    code,
    path,
    message,
    evidenceIds: [...new Set(evidenceIds.map(text).filter(Boolean))].sort(),
  };
}

function inspectTmsSnapshotCompleteness(snapshot) {
  const issues = [];
  if (!isPlainObject(snapshot)) {
    issues.push(issue("snapshot_not_object", "snapshot", "TMS detail snapshot must be an object."));
    return deepFreeze({
      complete: false,
      code: "TMS_SOURCE_SNAPSHOT_INCOMPLETE",
      snapshotTime: "",
      counts: { visibleTaskCount: null, orderLinkCount: null, shipmentCount: null, successfulDetailCount: 0 },
      issues,
      mutatesOperationalState: false,
    });
  }

  const snapshotTime = text(snapshot.snapshotTime);
  if (!snapshotTime || !Number.isFinite(Date.parse(snapshotTime)) || new Date(snapshotTime).toISOString() !== snapshotTime) {
    issues.push(issue(
      "snapshot_time_invalid",
      "snapshot.snapshotTime",
      "snapshotTime must be a canonical UTC ISO timestamp and is the source cursor.",
      [snapshotTime],
    ));
  }
  const visibleTaskCount = safeInteger(snapshot.visibleTaskCount);
  const orderLinkCount = safeInteger(snapshot.orderLinkCount);
  const shipments = Array.isArray(snapshot.shipments) ? snapshot.shipments : null;
  const shipmentCount = shipments ? shipments.length : null;
  if (visibleTaskCount === null) {
    issues.push(issue("visible_task_count_invalid", "snapshot.visibleTaskCount", "visibleTaskCount must be a non-negative safe integer."));
  }
  if (orderLinkCount === null) {
    issues.push(issue("order_link_count_invalid", "snapshot.orderLinkCount", "orderLinkCount must be a non-negative safe integer."));
  }
  if (!shipments) {
    issues.push(issue("shipments_missing", "snapshot.shipments", "shipments must be an array."));
  }
  if (shipments && visibleTaskCount !== null && shipmentCount !== visibleTaskCount) {
    issues.push(issue(
      "visible_task_row_count_mismatch",
      "snapshot.shipments",
      "Every visible TMS task must have one detail row.",
      [`visible:${visibleTaskCount}`, `details:${shipmentCount}`],
    ));
  }
  if (shipments && orderLinkCount !== null && shipmentCount !== orderLinkCount) {
    issues.push(issue(
      "order_link_row_count_mismatch",
      "snapshot.shipments",
      "Every discovered TMS order link must have one detail row.",
      [`links:${orderLinkCount}`, `details:${shipmentCount}`],
    ));
  }

  const scopeAudit = isPlainObject(snapshot.scopeAudit) ? snapshot.scopeAudit : null;
  if (!scopeAudit) {
    issues.push(issue("scope_audit_missing", "snapshot.scopeAudit", "A structural TMS scope audit is required."));
  } else {
    const requiredText = [
      ["source", "source description"],
      ["url", "source URL"],
      ["title", "page title"],
      ["activeTab", "active tab"],
    ];
    for (const [field, label] of requiredText) {
      if (!text(scopeAudit[field])) {
        issues.push(issue("scope_audit_field_missing", `snapshot.scopeAudit.${field}`, `Scope audit ${label} is required.`));
      }
    }
    if (text(scopeAudit.title) && text(scopeAudit.title) !== "Operations Log") {
      issues.push(issue("scope_title_mismatch", "snapshot.scopeAudit.title", "TMS snapshot must come from the Operations Log.", [scopeAudit.title]));
    }
    if (text(scopeAudit.url) && !/CurrentTab=0(?:&|$)/i.test(scopeAudit.url)) {
      issues.push(issue("scope_url_mismatch", "snapshot.scopeAudit.url", "TMS snapshot must prove CurrentTab=0.", [scopeAudit.url]));
    }
    if (text(scopeAudit.activeTab) && !/OPS\s+TLV-US/i.test(scopeAudit.activeTab)) {
      issues.push(issue("scope_active_tab_mismatch", "snapshot.scopeAudit.activeTab", "TMS snapshot must prove the OPS TLV-US scope.", [scopeAudit.activeTab]));
    }
    if (!isPlainObject(scopeAudit.filters)) {
      issues.push(issue("scope_filters_missing", "snapshot.scopeAudit.filters", "The applied grid filters must be captured."));
    }
    const scopeCounts = [
      ["visibleTaskCount", visibleTaskCount],
      ["orderLinkCount", orderLinkCount],
      ["gridRows", shipmentCount],
      ["detailRows", shipmentCount],
    ];
    for (const [field, expected] of scopeCounts) {
      if (expected !== null && safeInteger(scopeAudit[field]) !== expected) {
        issues.push(issue(
          "scope_count_mismatch",
          `snapshot.scopeAudit.${field}`,
          `${field} must agree with the top-level structurally complete pull.`,
          [`expected:${expected}`, `actual:${scopeAudit[field]}`],
        ));
      }
    }
  }

  const successfulRows = [];
  const guidOwners = new Map();
  const orderOwners = new Map();
  for (const [index, row] of (shipments || []).entries()) {
    const path = `snapshot.shipments[${index}]`;
    if (!isPlainObject(row)) {
      issues.push(issue("shipment_row_invalid", path, "Every shipment detail row must be an object."));
      continue;
    }
    const order = text(row.order || row.shipmentNumber);
    const shipmentGuid = text(row.shipmentGuid).toLowerCase();
    const trackingNumber = text(row.trackingNumber);
    if (text(row.detailPullStatus) !== "success") {
      issues.push(issue(
        "detail_pull_failed",
        `${path}.detailPullStatus`,
        "Every visible shipment must have a successful detail pull.",
        [order, shipmentGuid, text(row.detailError)],
      ));
    } else {
      successfulRows.push(row);
    }
    if (!order) issues.push(issue("shipment_order_missing", `${path}.order`, "Shipment order identity is required."));
    if (!shipmentGuid) issues.push(issue("shipment_guid_missing", `${path}.shipmentGuid`, "Shipment GUID identity is required.", [order]));
    if (!trackingNumber) issues.push(issue("shipment_tracking_missing", `${path}.trackingNumber`, "A successful detail row must include its tracking number.", [order, shipmentGuid]));
    if (!text(row.detailUrl) || !text(row.detailTitle)) {
      issues.push(issue("detail_pull_provenance_missing", path, "Successful detail rows require detailUrl and detailTitle provenance.", [order, shipmentGuid]));
    }
    if (shipmentGuid) {
      if (guidOwners.has(shipmentGuid)) {
        issues.push(issue("shipment_guid_duplicate", `${path}.shipmentGuid`, "Shipment GUIDs must be unique within a snapshot.", [shipmentGuid, guidOwners.get(shipmentGuid), order]));
      } else {
        guidOwners.set(shipmentGuid, order || String(index));
      }
    }
    if (order) {
      if (orderOwners.has(order)) {
        issues.push(issue("shipment_order_duplicate", `${path}.order`, "Shipment orders must be unique within a snapshot.", [order, orderOwners.get(order), shipmentGuid]));
      } else {
        orderOwners.set(order, shipmentGuid || String(index));
      }
    }
  }

  issues.sort((left, right) =>
    left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
  return deepFreeze({
    complete: issues.length === 0,
    code: issues.length ? "TMS_SOURCE_SNAPSHOT_INCOMPLETE" : "TMS_SOURCE_SNAPSHOT_COMPLETE",
    snapshotTime,
    counts: {
      visibleTaskCount,
      orderLinkCount,
      shipmentCount,
      successfulDetailCount: successfulRows.length,
    },
    issues,
    mutatesOperationalState: false,
  });
}

function requireBuildOptions(input) {
  const options = input === undefined ? {} : input;
  if (!isPlainObject(options)) {
    throw new TmsSourceSnapshotError("TMS source snapshot options must be an object", {
      code: "TMS_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  const workspaceKey = text(options.workspaceKey || DEFAULT_WORKSPACE_KEY);
  const connectionKey = text(options.connectionKey);
  const extractorVersion = text(options.extractorVersion || DEFAULT_EXTRACTOR_VERSION);
  if (!workspaceKey || !connectionKey || !extractorVersion) {
    throw new TmsSourceSnapshotError("workspaceKey, connectionKey, and extractorVersion are required", {
      code: "TMS_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  return { workspaceKey, connectionKey, extractorVersion };
}

function buildTmsSourceSnapshot(snapshot, inputOptions = {}) {
  const diagnostics = inspectTmsSnapshotCompleteness(snapshot);
  if (!diagnostics.complete) {
    throw new TmsSourceSnapshotError("TMS detail snapshot is structurally incomplete; cursor commit is forbidden", {
      code: diagnostics.code,
      diagnostics,
    });
  }
  const options = requireBuildOptions(inputOptions);

  const snapshotTime = diagnostics.snapshotTime;
  const sortedRows = snapshot.shipments
    .map((row) => canonicalize(row, "shipment"))
    .sort((left, right) =>
      text(left.shipmentGuid).toLowerCase().localeCompare(text(right.shipmentGuid).toLowerCase()) ||
      text(left.order || left.shipmentNumber).localeCompare(text(right.order || right.shipmentNumber)));
  const observations = [];
  const jobs = [];
  const rowManifests = [];

  for (const row of sortedRows) {
    const sourceObjectId = text(row.shipmentGuid).toLowerCase();
    const order = text(row.order || row.shipmentNumber);
    const trackingNumber = text(row.trackingNumber);
    const normalizedPayload = canonicalize({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      snapshotTime,
      shipment: row,
    });
    const contentHash = sha256(normalizedPayload);
    const sourceRevision = `snapshot:${snapshotTime}`;
    const observationIdentity = {
      schemaVersion: "source-observation-identity-v1",
      workspaceKey: options.workspaceKey,
      sourceSystem: "tms",
      connectionKey: options.connectionKey,
      sourceObjectType: "tms_shipment_snapshot",
      sourceObjectId,
      sourceRevision,
      operation: "content",
      contentHash,
    };
    const observationId = `obs:v1:${sha256(observationIdentity)}`;
    const observation = {
      observationId,
      sourceObjectType: observationIdentity.sourceObjectType,
      sourceObjectId,
      sourceRevision,
      operation: "content",
      contentHash,
      sourceRecordedAt: snapshotTime,
      normalizedPayload,
      normalizedText: "",
      sourceFidelity: "normalized_source",
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      retentionClass: "shipment-operations",
    };
    const jobKind = "tms_extract_claims";
    const dedupeKey = `tms:extract-claims:v1:${sha256({
      jobKind,
      observationId,
      extractorVersion: options.extractorVersion,
    })}`;
    const job = {
      dedupeKey,
      jobKind,
      observationId,
      sourceObjectId,
      maxAttempts: 5,
      payload: canonicalize({
        schemaVersion: JOB_SCHEMA_VERSION,
        sourceSnapshotTime: snapshotTime,
        sourceObservationId: observationId,
        shipmentGuid: sourceObjectId,
        order,
        trackingNumber,
        extractorVersion: options.extractorVersion,
      }),
    };
    observations.push(observation);
    jobs.push(job);
    rowManifests.push({ sourceObjectId, order, trackingNumber, observationId, contentHash });
  }

  observations.sort((left, right) => left.observationId.localeCompare(right.observationId));
  jobs.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  rowManifests.sort((left, right) => left.sourceObjectId.localeCompare(right.sourceObjectId));
  const scopeAudit = canonicalize(snapshot.scopeAudit, "scopeAudit");
  const providerManifest = canonicalize({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    complete: true,
    upstreamWatermark: snapshotTime,
    sourceSnapshotAt: snapshotTime,
    recordCount: observations.length,
    sourceSnapshotKey: "tms-detail-snapshot",
    visibleTaskCount: snapshot.visibleTaskCount,
    orderLinkCount: snapshot.orderLinkCount,
    scopeAudit,
    detailPull: {
      attempted: snapshot.shipments.length,
      succeeded: snapshot.shipments.length,
      failed: 0,
    },
    rowManifestHashAlgorithm: ROW_MANIFEST_HASH_ALGORITHM,
    rowManifestHash: hashRowManifest(rowManifests),
    rows: rowManifests,
  });
  const payloadIdentity = sha256({
    nextCursorValue: snapshotTime,
    providerManifest,
    observations,
    jobs,
  });
  return deepFreeze({
    sourceSystem: "tms",
    workspaceKey: options.workspaceKey,
    connectionKey: options.connectionKey,
    nextCursorValue: snapshotTime,
    providerManifest,
    observations,
    jobs,
    payloadIdentity: `tms-source-snapshot:v1:${payloadIdentity}`,
    diagnostics,
    mutatesOperationalState: false,
    reducesTruth: false,
    publishesTruth: false,
  });
}

function requireLedger(ledger) {
  if (!ledger || typeof ledger !== "object") {
    throw new TmsSourceSnapshotError("A source snapshot ledger is required", {
      code: "TMS_SOURCE_SNAPSHOT_LEDGER_REQUIRED",
    });
  }
  for (const method of [
    "recordPreflightFailure",
    "recoverCommittedSnapshot",
    "acquireLease",
    "beginSnapshotBatch",
    "commitSnapshotBatch",
    "failSnapshotBatch",
  ]) {
    if (typeof ledger[method] !== "function") {
      throw new TmsSourceSnapshotError(`Source snapshot ledger.${method} is required`, {
        code: "TMS_SOURCE_SNAPSHOT_LEDGER_REQUIRED",
      });
    }
  }
  return ledger;
}

function unsuccessfulReceipt(stage, receipt) {
  return new TmsSourceSnapshotError(`TMS source snapshot ${stage} did not succeed`, {
    code: text(receipt?.code) || "TMS_SOURCE_SNAPSHOT_LEDGER_REJECTED",
    stage,
    receipt,
  });
}

async function commitTmsSourceSnapshot(input = {}) {
  if (!isPlainObject(input)) {
    throw new TmsSourceSnapshotError("commitTmsSourceSnapshot input must be an object", {
      code: "TMS_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  const ledger = requireLedger(input.ledger);
  const ownerId = text(input.ownerId);
  if (!ownerId) {
    throw new TmsSourceSnapshotError("ownerId is required", {
      code: "TMS_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  // Structural failures are still rejected before a lease/batch/cursor advance,
  // but are durably witnessed so a missed morning pull cannot disappear.
  let built;
  try {
    built = buildTmsSourceSnapshot(input.snapshot, input.buildOptions);
  } catch (error) {
    if (error instanceof TmsSourceSnapshotError && error.code === "TMS_SOURCE_SNAPSHOT_INCOMPLETE") {
      try {
        const failureReceipt = await ledger.recordPreflightFailure({
          ownerId,
          errorCode: error.code,
          safeErrorDetail: "The TMS pull failed structural completeness checks before source ingestion.",
          diagnostics: error.diagnostics,
        });
        if (!failureReceipt?.ok) throw unsuccessfulReceipt("preflight failure witness", failureReceipt);
        error.failureReceipt = failureReceipt;
      } catch (failureEvidenceError) {
        error.failureEvidenceError = failureEvidenceError;
      }
    }
    throw error;
  }
  if (ledger.scope?.sourceSystem !== "tms" ||
      ledger.scope?.workspaceKey !== built.workspaceKey ||
      ledger.scope?.connectionKey !== built.connectionKey) {
    throw new TmsSourceSnapshotError("TMS source snapshot build scope does not match its ledger scope", {
      code: "TMS_SOURCE_SNAPSHOT_SCOPE_MISMATCH",
      builtScope: {
        workspaceKey: built.workspaceKey,
        sourceSystem: built.sourceSystem,
        connectionKey: built.connectionKey,
      },
      ledgerScope: ledger.scope,
    });
  }
  const snapshotPayload = {
    nextCursorValue: built.nextCursorValue,
    providerManifest: built.providerManifest,
    observations: built.observations,
    jobs: built.jobs,
  };
  const preflightRecovery = await ledger.recoverCommittedSnapshot(snapshotPayload);
  if (!preflightRecovery?.ok) throw unsuccessfulReceipt("recovery preflight", preflightRecovery);
  if (preflightRecovery.found) {
    return deepFreeze({
      ok: true,
      recovered: true,
      recoveryStage: "preflight",
      payloadIdentity: built.payloadIdentity,
      lease: null,
      batch: null,
      commit: preflightRecovery,
      diagnostics: built.diagnostics,
      mutatesOperationalState: false,
      reducesTruth: false,
      publishesTruth: false,
    });
  }

  const leaseInput = { ownerId };
  if (input.ttlSeconds !== undefined) leaseInput.ttlSeconds = input.ttlSeconds;
  const lease = await ledger.acquireLease(leaseInput);
  if (!lease?.ok) throw unsuccessfulReceipt("lease", lease);
  if (lease.status === "paused") {
    throw new TmsSourceSnapshotError("TMS source snapshot cursor is paused", {
      code: "TMS_SOURCE_SNAPSHOT_CURSOR_PAUSED",
      lease,
    });
  }
  const recoveryMode = lease.status === "error" || lease.status === "reconcile_required";
  const batch = await ledger.beginSnapshotBatch({
    ownerId,
    leaseFence: lease.leaseFence,
    recoveryMode,
    triggerName: recoveryMode
      ? text(input.recoveryTriggerName || "source-snapshot-recovery")
      : text(input.triggerName),
  });
  if (!batch?.ok) throw unsuccessfulReceipt("begin", batch);
  let commit;
  try {
    commit = await ledger.commitSnapshotBatch({
      batchId: batch.batchId,
      ownerId,
      leaseFence: lease.leaseFence,
      ...snapshotPayload,
    });
    if (!commit?.ok) throw unsuccessfulReceipt("commit", commit);
  } catch (error) {
    const ambiguous = error?.ambiguousOutcome === true ||
      error?.code === "SOURCE_SNAPSHOT_LEDGER_INVALID_RECEIPT";
    if (ambiguous) {
      try {
        const recovered = await ledger.recoverCommittedSnapshot(snapshotPayload);
        if (recovered?.ok && recovered.found) {
          return deepFreeze({
            ok: true,
            recovered: true,
            recoveryStage: "ambiguous-commit",
            payloadIdentity: built.payloadIdentity,
            lease,
            batch,
            commit: recovered,
            diagnostics: built.diagnostics,
            mutatesOperationalState: false,
            reducesTruth: false,
            publishesTruth: false,
          });
        }
      } catch (recoveryError) {
        error.recoveryError = recoveryError;
      }
      error.outcome = "ambiguous-unconfirmed";
      throw error;
    }

    const errorCode = text(error?.code || "SOURCE_SNAPSHOT_COMMIT_REJECTED").slice(0, 100);
    try {
      const failureReceipt = await ledger.failSnapshotBatch({
        batchId: batch.batchId,
        ownerId,
        leaseFence: lease.leaseFence,
        errorCode,
        safeErrorDetail: `Snapshot commit was definitively rejected before cursor advance (${errorCode}).`,
      });
      if (!failureReceipt?.ok) throw unsuccessfulReceipt("failure witness", failureReceipt);
      error.failureReceipt = failureReceipt;
    } catch (failureEvidenceError) {
      error.failureEvidenceError = failureEvidenceError;
    }
    throw error;
  }
  return deepFreeze({
    ok: true,
    recovered: Boolean(commit.recovered),
    payloadIdentity: built.payloadIdentity,
    lease,
    batch,
    commit,
    diagnostics: built.diagnostics,
    mutatesOperationalState: false,
    reducesTruth: false,
    publishesTruth: false,
  });
}

module.exports = Object.freeze({
  DEFAULT_EXTRACTOR_VERSION,
  JOB_SCHEMA_VERSION,
  OBSERVATION_SCHEMA_VERSION,
  ROW_MANIFEST_HASH_ALGORITHM,
  SNAPSHOT_SCHEMA_VERSION,
  TmsSourceSnapshotError,
  buildTmsSourceSnapshot,
  commitTmsSourceSnapshot,
  inspectTmsSnapshotCompleteness,
});

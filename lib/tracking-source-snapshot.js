"use strict";

// Deterministic boundary adapter for carrier/flight tracking snapshots. It
// persists every structurally complete result -- including no-result and
// provider/research failures -- as source evidence. It never reduces or
// publishes shipment truth and performs no network or database calls.

const crypto = require("node:crypto");
const { REGISTRY: PREDICATE_REGISTRY } = require("./truth-predicate-registry");

const DEFAULT_WORKSPACE_KEY = "primary";
const DEFAULT_EXTRACTOR_VERSION =
  `tracking-claim-extractor-v1+predicates:${PREDICATE_REGISTRY.registryHash}`;
const SNAPSHOT_SCHEMA_VERSION = "tracking-source-snapshot-v1";
const OBSERVATION_SCHEMA_VERSION = "tracking-source-observation-v1";
const JOB_SCHEMA_VERSION = "tracking-extract-claims-job-v1";
const ROW_MANIFEST_HASH_ALGORITHM = "length-prefixed-utf8-v1";
const CANONICAL_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class TrackingSourceSnapshotError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TrackingSourceSnapshotError";
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
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new TrackingSourceSnapshotError(`${path}.${key} is forbidden`, {
          code: "TRACKING_SOURCE_SNAPSHOT_INVALID_JSON",
          path: `${path}.${key}`,
        });
      }
      if (value[key] !== undefined) output[key] = canonicalize(value[key], `${path}.${key}`);
      return output;
    }, {});
  }
  throw new TrackingSourceSnapshotError(`${path} must contain only JSON-compatible values`, {
    code: "TRACKING_SOURCE_SNAPSHOT_INVALID_JSON",
    path,
  });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value), "utf8")
    .digest("hex");
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function canonicalTimestamp(value) {
  const result = text(value);
  return CANONICAL_TIMESTAMP_RE.test(result)
    && Number.isFinite(Date.parse(result))
    && new Date(result).toISOString() === result
    ? result
    : "";
}

function normalizeAwb(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function issue(code, path, message, evidenceIds = []) {
  return {
    code,
    path,
    message,
    evidenceIds: [...new Set(evidenceIds.map(text).filter(Boolean))].sort(),
  };
}

function normalizeSnapshotCollection(input) {
  if (Array.isArray(input)) return input;
  if (isPlainObject(input) && Array.isArray(input.snapshots)) return input.snapshots;
  return [input];
}

function classifyRow(row) {
  const direct = row.ok === true && row.noResult !== true;
  const noResult = row.ok === false && row.noResult === true;
  const research = row.ok === false && text(row.source) === "flight-intelligence";
  if (direct) return "healthy";
  if (noResult) return "no_result";
  if (research && row.publicFlightStatus?.checked === true) return "research_only";
  if (research) return "insufficient_research_input";
  return "provider_failure";
}

function rowProvenance(snapshot, row) {
  const researched = isPlainObject(row.publicFlightStatus?.best)
    ? row.publicFlightStatus.best
    : null;
  const url = text(row.url || researched?.url);
  const title = text(row.title || researched?.title);
  const status = text(row.status || row.summaryCode || researched?.status || row.code);
  return {
    sourceDescription: text(snapshot.source),
    sourceKind: text(row.source) === "flight-intelligence"
      ? "flight_status_research"
      : "official_carrier_tracking",
    url,
    title,
    status,
  };
}

function inspectTrackingSourceSnapshot(input, options = {}) {
  const snapshots = normalizeSnapshotCollection(input);
  const issues = [];
  const rows = [];
  const timestamps = new Set();
  const sourceDescriptions = new Set();
  const awbOwners = new Map();
  if (!snapshots.length) {
    issues.push(issue("snapshot_collection_empty", "snapshots", "At least one tracking snapshot is required."));
  }
  for (const [snapshotIndex, snapshot] of snapshots.entries()) {
    const path = `snapshots[${snapshotIndex}]`;
    if (!isPlainObject(snapshot)) {
      issues.push(issue("snapshot_not_object", path, "Each tracking snapshot must be an object."));
      continue;
    }
    const snapshotTime = canonicalTimestamp(snapshot.snapshotTime);
    if (!snapshotTime) {
      issues.push(issue(
        "snapshot_time_invalid",
        `${path}.snapshotTime`,
        "snapshotTime must be a canonical UTC timestamp with millisecond precision.",
        [snapshot.snapshotTime],
      ));
    } else {
      timestamps.add(snapshotTime);
    }
    if (!text(snapshot.source)) {
      issues.push(issue("snapshot_source_missing", `${path}.source`, "A source description is required."));
    } else {
      sourceDescriptions.add(text(snapshot.source));
    }
    if (!Array.isArray(snapshot.tracking)) {
      issues.push(issue("tracking_rows_missing", `${path}.tracking`, "tracking must be an array."));
      continue;
    }
    const declaredCount = snapshot.recordCount ?? snapshot.expectedCount;
    if (declaredCount !== undefined
      && (!Number.isSafeInteger(declaredCount) || declaredCount < 0 || declaredCount !== snapshot.tracking.length)) {
      issues.push(issue(
        "tracking_row_count_mismatch",
        `${path}.tracking`,
        "The declared snapshot count must equal the captured row count.",
        [`declared:${declaredCount}`, `captured:${snapshot.tracking.length}`],
      ));
    }
    for (const [rowIndex, rawRow] of snapshot.tracking.entries()) {
      const rowPath = `${path}.tracking[${rowIndex}]`;
      if (!isPlainObject(rawRow)) {
        issues.push(issue("tracking_row_invalid", rowPath, "Each tracking result must be an object."));
        continue;
      }
      const awb = normalizeAwb(rawRow.awb);
      if (!awb) {
        issues.push(issue("tracking_awb_invalid", `${rowPath}.awb`, "AWB must contain exactly eleven digits.", [rawRow.awb]));
      } else if (awbOwners.has(awb)) {
        issues.push(issue(
          "tracking_awb_duplicate",
          `${rowPath}.awb`,
          "Every AWB must appear exactly once across the committed tracking snapshot.",
          [awb, awbOwners.get(awb)],
        ));
      } else {
        awbOwners.set(awb, rowPath);
      }
      if (typeof rawRow.ok !== "boolean") {
        issues.push(issue("tracking_result_outcome_missing", `${rowPath}.ok`, "ok must explicitly identify provider success or failure.", [awb]));
      }
      if (!text(rawRow.carrier)) {
        issues.push(issue("tracking_carrier_missing", `${rowPath}.carrier`, "Carrier identity is required.", [awb]));
      }
      if (!text(rawRow.status)) {
        issues.push(issue("tracking_status_missing", `${rowPath}.status`, "Provider/research status is required.", [awb]));
      }
      const rowSnapshotTime = canonicalTimestamp(rawRow.snapshotTime);
      if (!rowSnapshotTime || (snapshotTime && rowSnapshotTime !== snapshotTime)) {
        issues.push(issue(
          "tracking_row_snapshot_time_mismatch",
          `${rowPath}.snapshotTime`,
          "Every result must carry the exact enclosing snapshot timestamp.",
          [awb, rawRow.snapshotTime, snapshot.snapshotTime],
        ));
      }

      const classification = classifyRow(rawRow);
      const provenance = rowProvenance(snapshot, rawRow);
      if (classification === "healthy") {
        if (!provenance.url || !provenance.title) {
          issues.push(issue(
            "direct_tracking_provenance_missing",
            rowPath,
            "A successful direct carrier result requires its exact URL and page title.",
            [awb],
          ));
        }
        if (!isPlainObject(rawRow.latestEvent) || !text(rawRow.latestEvent.code || rawRow.summaryCode || rawRow.status)) {
          issues.push(issue(
            "direct_tracking_event_missing",
            `${rowPath}.latestEvent`,
            "A successful carrier result requires an explicit provider event code.",
            [awb],
          ));
        }
      } else if (classification === "no_result") {
        if (!provenance.url || !provenance.title || !text(rawRow.error)) {
          issues.push(issue(
            "tracking_no_result_provenance_missing",
            rowPath,
            "A no-result row requires the queried URL, page title, status, and error witness.",
            [awb],
          ));
        }
      } else if (["research_only", "insufficient_research_input"].includes(classification)) {
        if (!text(rawRow.code) || !text(rawRow.error)) {
          issues.push(issue(
            "tracking_research_witness_missing",
            rowPath,
            "Flight research rows require an explicit result code and limitation/error witness.",
            [awb],
          ));
        }
        if (classification === "research_only" && (!provenance.url || !provenance.title)) {
          issues.push(issue(
            "tracking_research_provenance_missing",
            `${rowPath}.publicFlightStatus.best`,
            "A completed flight-status search requires its URL and title.",
            [awb],
          ));
        }
      } else if (!text(rawRow.error)) {
        issues.push(issue(
          "tracking_failure_witness_missing",
          `${rowPath}.error`,
          "Provider failures require a durable error witness.",
          [awb],
        ));
      }
      rows.push({
        snapshot: { source: text(snapshot.source) },
        row: canonicalize(rawRow, rowPath),
        awb,
        snapshotTime,
        classification,
        provenance: canonicalize(provenance),
      });
    }
  }
  if (timestamps.size > 1) {
    issues.push(issue(
      "snapshot_time_disagreement",
      "snapshots",
      "All provider files in one atomic tracking pull must share one snapshotTime.",
      [...timestamps],
    ));
  }
  const hasExpectedAwbs = Object.prototype.hasOwnProperty.call(options, "expectedAwbs");
  const expectedAwbs = Array.isArray(options.expectedAwbs)
    ? options.expectedAwbs.map(normalizeAwb)
    : null;
  if (!hasExpectedAwbs || !Array.isArray(options.expectedAwbs)) {
    issues.push(issue(
      "expected_awbs_missing",
      "options.expectedAwbs",
      "The exact requested AWB scope must be supplied explicitly, including an explicit empty array.",
    ));
  } else if (expectedAwbs) {
    if (expectedAwbs.some((awb) => !awb) || new Set(expectedAwbs).size !== expectedAwbs.length) {
      issues.push(issue("expected_awbs_invalid", "options.expectedAwbs", "Expected AWBs must be unique eleven-digit identities."));
    } else {
      const expected = [...new Set(expectedAwbs)].sort();
      const actual = [...awbOwners.keys()].sort();
      const missing = expected.filter((awb) => !awbOwners.has(awb));
      const unexpected = actual.filter((awb) => !expected.includes(awb));
      if (missing.length || unexpected.length) {
        issues.push(issue(
          "tracking_scope_incomplete",
          "snapshots",
          "The atomic pull must exactly cover the requested AWB scope.",
          [...missing.map((awb) => `missing:${awb}`), ...unexpected.map((awb) => `unexpected:${awb}`)],
        ));
      }
    }
  }
  issues.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path));
  rows.sort((left, right) => left.awb.localeCompare(right.awb));
  const healthCounts = rows.reduce((counts, row) => {
    counts[row.classification] = (counts[row.classification] || 0) + 1;
    return counts;
  }, {});
  return deepFreeze({
    complete: issues.length === 0,
    code: issues.length ? "TRACKING_SOURCE_SNAPSHOT_INCOMPLETE" : "TRACKING_SOURCE_SNAPSHOT_COMPLETE",
    snapshotTime: timestamps.size === 1 ? [...timestamps][0] : "",
    recordCount: rows.length,
    sourceDescriptions: [...sourceDescriptions].sort(),
    healthCounts: canonicalize(healthCounts),
    rows,
    issues,
    mutatesOperationalState: false,
  });
}

function requireBuildOptions(input = {}) {
  if (!isPlainObject(input)) {
    throw new TrackingSourceSnapshotError("Tracking source snapshot options must be an object", {
      code: "TRACKING_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  const workspaceKey = text(input.workspaceKey || DEFAULT_WORKSPACE_KEY);
  const connectionKey = text(input.connectionKey);
  const extractorVersion = text(input.extractorVersion || DEFAULT_EXTRACTOR_VERSION);
  const scopeToken = text(input.scopeToken);
  const expectedAwbs = Array.isArray(input.expectedAwbs)
    ? input.expectedAwbs.map(normalizeAwb).sort()
    : null;
  if (!workspaceKey || !connectionKey || !extractorVersion || !expectedAwbs
    || expectedAwbs.some((awb) => !awb)
    || new Set(expectedAwbs).size !== expectedAwbs.length) {
    throw new TrackingSourceSnapshotError("workspaceKey, connectionKey, extractorVersion, and an explicit unique expectedAwbs array are required", {
      code: "TRACKING_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  if (scopeToken && !/^tracking-scope:v1:[0-9a-f]{64}$/.test(scopeToken)) {
    throw new TrackingSourceSnapshotError("scopeToken must be a server-issued tracking-scope:v1 identity", {
      code: "TRACKING_SOURCE_SNAPSHOT_INVALID_OPTIONS",
    });
  }
  return { workspaceKey, connectionKey, extractorVersion, expectedAwbs, scopeToken };
}

function lengthPrefixedUtf8(value) {
  const result = String(value ?? "");
  return `${Buffer.byteLength(result, "utf8")}:${result}`;
}

function hashRowManifest(rows) {
  return sha256(rows.map((row) => [
    row.awb,
    row.observationId,
    row.contentHash,
    row.healthStatus,
    row.provenanceStatus,
  ].map(lengthPrefixedUtf8).join("")).join(""));
}

function buildTrackingSourceSnapshot(input, inputOptions = {}) {
  const diagnostics = inspectTrackingSourceSnapshot(input, inputOptions);
  if (!diagnostics.complete) {
    throw new TrackingSourceSnapshotError(
      "Tracking snapshot is structurally incomplete; cursor commit is forbidden",
      { code: diagnostics.code, diagnostics },
    );
  }
  const options = requireBuildOptions(inputOptions);
  const observations = [];
  const jobs = [];
  const manifestRows = [];
  for (const sourceRow of [...diagnostics.rows].sort((left, right) => left.awb.localeCompare(right.awb))) {
    const canonicalTracking = canonicalize(sourceRow.row, "tracking");
    const normalizedPayload = canonicalize({
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      snapshotTime: diagnostics.snapshotTime,
      awb: sourceRow.awb,
      awbDisplay: text(sourceRow.row.awb),
      carrier: text(sourceRow.row.carrier),
      provenance: sourceRow.provenance,
      sourceHealth: {
        status: sourceRow.classification,
        code: text(sourceRow.row.code),
        error: text(sourceRow.row.error),
        positiveEvidenceEligible: sourceRow.classification === "healthy"
          && sourceRow.provenance.sourceKind === "official_carrier_tracking",
      },
      tracking: canonicalTracking,
    });
    const contentHash = sha256(normalizedPayload);
    const sourceObjectId = sourceRow.awb;
    const sourceRevision = `snapshot:${diagnostics.snapshotTime}`;
    const observationIdentity = {
      schemaVersion: "source-observation-identity-v1",
      workspaceKey: options.workspaceKey,
      sourceSystem: "tracking",
      connectionKey: options.connectionKey,
      sourceObjectType: "tracking_shipment_snapshot",
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
      sourceRecordedAt: diagnostics.snapshotTime,
      capturedAt: diagnostics.snapshotTime,
      normalizedPayload,
      normalizedText: text(sourceRow.row.text),
      sourceFidelity: "normalized_source",
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      retentionClass: "shipment-operations",
    };
    const jobKind = "tracking_extract_claims";
    const dedupeKey = `tracking:extract-claims:v1:${sha256({
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
        sourceSnapshotTime: diagnostics.snapshotTime,
        sourceObservationId: observationId,
        awb: sourceObjectId,
        contentHash,
        healthStatus: sourceRow.classification,
        extractorVersion: options.extractorVersion,
      }),
    };
    observations.push(observation);
    jobs.push(job);
    manifestRows.push({
      awb: sourceObjectId,
      observationId,
      contentHash,
      healthStatus: sourceRow.classification,
      provenanceStatus: sourceRow.provenance.status,
    });
  }
  observations.sort((left, right) => left.observationId.localeCompare(right.observationId));
  jobs.sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
  manifestRows.sort((left, right) => left.awb.localeCompare(right.awb));
  const providerManifest = canonicalize({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    complete: true,
    upstreamWatermark: diagnostics.snapshotTime,
    sourceSnapshotAt: diagnostics.snapshotTime,
    recordCount: observations.length,
    sourceSnapshotKey: "carrier-tracking-snapshot",
    expectedAwbs: options.expectedAwbs,
    ...(options.scopeToken ? { scopeToken: options.scopeToken } : {}),
    sourceDescriptions: diagnostics.sourceDescriptions,
    healthCounts: diagnostics.healthCounts,
    rowManifestHashAlgorithm: ROW_MANIFEST_HASH_ALGORITHM,
    rowManifestHash: hashRowManifest(manifestRows),
    rows: manifestRows,
  });
  const payloadIdentity = sha256({
    nextCursorValue: diagnostics.snapshotTime,
    providerManifest,
    observations,
    jobs,
  });
  return deepFreeze({
    sourceSystem: "tracking",
    workspaceKey: options.workspaceKey,
    connectionKey: options.connectionKey,
    nextCursorValue: diagnostics.snapshotTime,
    providerManifest,
    observations,
    jobs,
    payloadIdentity: `tracking-source-snapshot:v1:${payloadIdentity}`,
    diagnostics,
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
  TrackingSourceSnapshotError,
  buildTrackingSourceSnapshot,
  inspectTrackingSourceSnapshot,
  _test: Object.freeze({ canonicalize, classifyRow, normalizeAwb, sha256, stableJson }),
});

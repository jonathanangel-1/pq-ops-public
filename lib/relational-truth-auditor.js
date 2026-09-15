"use strict";

// Read-only differential witness for the relational truth pipeline.
//
// The caller supplies one JSON-shaped snapshot containing relational rows and
// the production API witness. This module imports no source-system, database,
// HTTP, filesystem, Gmail, TMS, or action client. Its returned object exposes
// only `audit(snapshot)` and every finding is diagnostic-only.

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");
const { semanticInventory: sharedSemanticInventory } = require("./truth-production-semantics");

const OBSERVER_VERSION = "relational-truth-auditor-v1";
const HASH_RE = /^[0-9a-f]{64}$/;
const OPEN_GAP_STATUSES = new Set(["open"]);
const BACKLOG_STATES = new Set(["queued", "retry_wait", "leased"]);
const TERMINAL_JOB_STATES = new Set(["succeeded", "superseded"]);
const CLAIM_EXTRACTION_JOB_KINDS = new Set([
  "gmail_extract_message_claims",
  "gmail_extract_attachment_claims",
  "tms_extract_claims",
  "tracking_extract_claims",
  "operator_extract_claims",
]);
const RAW_REQUIRED_EVENT_TYPES = new Set(["message_added", "message_discovered"]);
const GATE_ORDER = Object.freeze(["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"]);
const MAX_PRODUCTION_SHIPMENT_ROWS = 50000;
const STAGE_ORDER = Object.freeze([
  "source_cursor",
  "gmail_ingest",
  "processing",
  "source_cut",
  "build_inputs",
  "build_parity",
  "publication",
  "production",
]);
const SEVERITY_ORDER = Object.freeze({ blocking: 0, attention: 1, informational: 2 });

function defaultDigest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonSnapshot(value, path = "snapshot", seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "function") {
    throw new TypeError(`${path} must contain data only; callable clients are forbidden`);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} must be JSON-compatible`);
  }
  if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSnapshot(item, `${path}[${index}]`, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError(`${path} must be a plain data object`);
    for (const [key, item] of Object.entries(value)) {
      if (/(?:gmail|tms|action)(?:Clients?|Apis?|Writers?)$/i.test(key)) {
        throw new TypeError(`${path}.${key} is forbidden; inject read results, not operational clients`);
      }
      assertJsonSnapshot(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function field(row, ...names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function rows(container, ...names) {
  for (const name of names) {
    const value = field(container, name);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function sortedUnique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function canonicalUnordered(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalUnordered)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalUnordered(value[key]);
    return output;
  }, {});
}

function cursorKey(row) {
  return [
    text(field(row, "sourceSystem", "source_system")),
    text(field(row, "connectionKey", "connection_key")),
  ].join(":");
}

function batchId(row) {
  return text(field(row, "batchId", "batch_id"));
}

function pageId(row) {
  return `${batchId(row)}:${integer(field(row, "pageOrdinal", "page_ordinal"), -1)}`;
}

function observationId(row) {
  return text(field(row, "observationId", "observation_id"));
}

function jobId(row) {
  return text(field(row, "jobId", "job_id", "dedupeKey", "dedupe_key"));
}

function parentJobId(row) {
  return text(field(row, "parentJobId", "parent_job_id"));
}

function childJobId(row) {
  return text(field(row, "childJobId", "child_job_id"));
}

function buildId(row) {
  return text(field(row, "buildId", "build_id"));
}

function publicationId(row) {
  return text(field(row, "publicationId", "publication_id"));
}

function sourceCutId(row) {
  return text(field(row, "sourceCutId", "source_cut_id"));
}

function collectObservationReferences(value, output = new Map()) {
  if (Array.isArray(value)) {
    if (value.length === 2
      && /^obs:v1:[0-9a-f]{64}$/.test(text(value[0]))
      && HASH_RE.test(text(value[1]))) {
      output.set(text(value[0]), text(value[1]));
      return output;
    }
    for (const item of value) collectObservationReferences(item, output);
    return output;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /^obs:v1:[0-9a-f]{64}$/.test(value) && !output.has(value)) {
      output.set(value, "");
    }
    return output;
  }
  const pairs = [
    [field(value, "observationId", "observation_id"), field(value, "observationContentHash", "observation_content_hash", "contentHash", "content_hash")],
    [field(value, "primaryObservationId", "primary_observation_id"), field(value, "primaryObservationContentHash", "primary_observation_content_hash")],
    [field(value, "sourceObservationId", "source_observation_id"), field(value, "sourceObservationContentHash", "source_observation_content_hash")],
  ];
  for (const [rawId, rawHash] of pairs) {
    const id = text(rawId);
    const hash = text(rawHash);
    if (/^obs:v1:[0-9a-f]{64}$/.test(id) && (!output.get(id) || hash)) output.set(id, hash);
  }
  for (const item of Object.values(value)) collectObservationReferences(item, output);
  return output;
}

function eventIdentity(event) {
  return [
    text(field(event, "historyId", "history_id")),
    text(field(event, "eventType", "event_type")),
    text(field(event, "messageId", "message_id")),
  ].join(":");
}

function eventId(event) {
  return text(field(event, "eventId", "event_id"));
}

function providerResponseEvents(response = {}) {
  const output = [];
  const specs = [
    ["messagesAdded", "message_added"],
    ["messagesDeleted", "message_deleted"],
    ["labelsAdded", "labels_added"],
    ["labelsRemoved", "labels_removed"],
  ];
  for (const history of Array.isArray(response.history) ? response.history : []) {
    const historyId = text(history.id);
    for (const [providerField, type] of specs) {
      for (const item of Array.isArray(history[providerField]) ? history[providerField] : []) {
        output.push({ historyId, eventType: type, messageId: text(item?.message?.id) });
      }
    }
  }
  for (const message of Array.isArray(response.messages) ? response.messages : []) {
    output.push({
      historyId: text(response.historyId),
      eventType: "message_discovered",
      messageId: text(message?.id),
    });
  }
  return output.filter((item) => item.historyId && item.messageId);
}

function createFindingFactory({ workspaceKey, digest }) {
  const findings = [];
  return {
    add({
      stage,
      severity = "blocking",
      classification,
      subjectType = "",
      subjectKey = "",
      evidenceIds = [],
      evidenceObservationIds = [],
      detail = {},
    }) {
      if (!STAGE_ORDER.includes(stage)) throw new Error(`Unknown audit stage ${stage}`);
      if (!Object.prototype.hasOwnProperty.call(SEVERITY_ORDER, severity)) {
        throw new Error(`Unknown audit severity ${severity}`);
      }
      const normalizedEvidenceIds = sortedUnique(evidenceIds);
      const normalizedObservationIds = sortedUnique(evidenceObservationIds);
      const identity = {
        schemaVersion: "truth-audit-finding-identity-v1",
        workspaceKey,
        stage,
        classification,
        subjectType: text(subjectType),
        subjectKey: text(subjectKey),
        evidenceIds: normalizedEvidenceIds,
      };
      findings.push({
        findingId: `truth-audit:v1:${digest(postgresJsonbText(identity))}`,
        stage,
        severity,
        classification,
        subjectType: text(subjectType),
        subjectKey: text(subjectKey),
        evidenceIds: normalizedEvidenceIds,
        evidenceObservationIds: normalizedObservationIds,
        detail: canonicalUnordered(detail),
        mutatesOperationalState: false,
      });
    },
    finish() {
      return findings.sort((left, right) => {
        const stage = STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage);
        if (stage) return stage;
        const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
        if (severity) return severity;
        return left.findingId.localeCompare(right.findingId);
      });
    },
  };
}

function auditSource({ source, add }) {
  const cursors = rows(source, "cursors", "sourceCursors");
  const batches = rows(source, "ingestBatches", "batches", "sourceIngestBatches");
  const gaps = rows(source, "gaps", "gmailCompletenessGaps");
  const snapshotFailures = rows(source, "snapshotFailures", "sourceSnapshotFailures");
  const requiredSources = rows(source, "requiredSources");
  const cursorMap = new Map(cursors.map((row) => [cursorKey(row), row]));
  const batchMap = new Map(batches.map((row) => [batchId(row), row]));

  for (const required of requiredSources) {
    const key = cursorKey(required);
    if (!cursorMap.has(key)) {
      add({
        stage: "source_cursor",
        classification: "source_cursor_missing",
        subjectType: "source_cursor",
        subjectKey: key,
        evidenceIds: [`cursor:${key}`],
        detail: { requiredSource: key },
      });
    }
  }

  for (const cursor of cursors) {
    const key = cursorKey(cursor);
    const status = text(field(cursor, "status"));
    const cursorEvidence = `cursor:${key}:${integer(field(cursor, "cursorVersion", "cursor_version"))}`;
    if (status !== "live") {
      add({
        stage: "source_cursor",
        classification: "source_cursor_not_live",
        subjectType: "source_cursor",
        subjectKey: key,
        evidenceIds: [cursorEvidence],
        detail: { status },
      });
    }
    const lastBatchId = text(field(cursor, "lastBatchId", "last_batch_id"));
    if (status === "live" && lastBatchId) {
      const batch = batchMap.get(lastBatchId);
      const expectedVersion = integer(field(cursor, "cursorVersion", "cursor_version"));
      const expectedValue = text(field(cursor, "cursorValue", "cursor_value"));
      if (!batch || text(field(batch, "status")) !== "committed" ||
          integer(field(batch, "committedCursorVersion", "committed_cursor_version"), -1) !== expectedVersion ||
          text(field(batch, "committedCursorValue", "committed_cursor_value")) !== expectedValue) {
        add({
          stage: "source_cursor",
          classification: "source_cursor_batch_mismatch",
          subjectType: "source_cursor",
          subjectKey: key,
          evidenceIds: [cursorEvidence, `batch:${lastBatchId}`],
          detail: { cursorVersion: expectedVersion, cursorValue: expectedValue, lastBatchId },
        });
      }
    }
  }

  for (const gap of gaps.filter((row) => OPEN_GAP_STATUSES.has(text(field(row, "status"))))) {
    const id = text(field(gap, "gapId", "gap_id")) || `${text(field(gap, "connectionKey", "connection_key"))}:${text(field(gap, "gapType", "gap_type"))}`;
    add({
      stage: "source_cursor",
      classification: "source_completeness_gap_open",
      subjectType: "completeness_gap",
      subjectKey: id,
      evidenceIds: [`gap:${id}`],
      detail: {
        connectionKey: text(field(gap, "connectionKey", "connection_key")),
        gapType: text(field(gap, "gapType", "gap_type")),
      },
    });
  }

  for (const failure of snapshotFailures) {
    const id = text(field(failure, "failureId", "failure_id"));
    const sourceSystem = text(field(failure, "sourceSystem", "source_system"));
    const connectionKey = text(field(failure, "connectionKey", "connection_key"));
    add({
      stage: "source_cursor",
      classification: "source_snapshot_failure_open",
      subjectType: "source_snapshot_failure",
      subjectKey: id || `${sourceSystem}:${connectionKey}`,
      evidenceIds: [id, text(field(failure, "failureHash", "failure_hash"))],
      detail: {
        sourceSystem,
        connectionKey,
        cursorVersion: integer(field(failure, "cursorVersion", "cursor_version")),
        cursorValue: text(field(failure, "cursorValue", "cursor_value")),
        failureStage: text(field(failure, "failureStage", "failure_stage")),
        errorCode: text(field(failure, "errorCode", "error_code")),
        safeErrorDetail: text(field(failure, "safeErrorDetail", "safe_error_detail")),
      },
    });
  }

  return { cursors, batches, gaps, snapshotFailures, cursorMap, batchMap };
}

function auditGmailIngest({ source, sourceIndex, add, digest }) {
  const pages = rows(source, "gmailPages", "ingestPages", "gmailIngestPages");
  const observations = rows(source, "observations", "sourceObservations");
  const jobs = rows(source, "jobs", "processingJobs", "sourceProcessingJobs");
  const pageObservations = rows(source, "pageObservations", "gmailIngestPageObservations");
  const pageJobs = rows(source, "pageJobs", "gmailIngestPageJobs");
  const observationMap = new Map(observations.map((row) => [observationId(row), row]));
  const jobMap = new Map(jobs.map((row) => [jobId(row), row]));
  const pagesByBatch = new Map();

  for (const page of pages) {
    const id = batchId(page);
    if (!pagesByBatch.has(id)) pagesByBatch.set(id, []);
    pagesByBatch.get(id).push(page);
  }

  for (const batch of sourceIndex.batches.filter((row) =>
    text(field(row, "sourceSystem", "source_system")) === "gmail" && text(field(row, "status")) === "committed")) {
    const id = batchId(batch);
    const batchPages = (pagesByBatch.get(id) || []).slice().sort((left, right) =>
      integer(field(left, "pageOrdinal", "page_ordinal"), -1) - integer(field(right, "pageOrdinal", "page_ordinal"), -1));
    const ordinals = batchPages.map((page) => integer(field(page, "pageOrdinal", "page_ordinal"), -1));
    const expectedOrdinals = batchPages.map((_, index) => index);
    const finalPages = batchPages.filter((page) => Boolean(field(page, "isFinal", "is_final")));
    const tokenChainValid = batchPages.every((page, index) => {
      const request = text(field(page, "requestPageToken", "request_page_token"));
      const next = text(field(page, "responseNextPageToken", "response_next_page_token"));
      if (index === 0 && request) return false;
      if (index > 0 && request !== text(field(batchPages[index - 1], "responseNextPageToken", "response_next_page_token"))) return false;
      return Boolean(field(page, "isFinal", "is_final")) ? next === "" : next !== "";
    });
    if (!batchPages.length || JSON.stringify(ordinals) !== JSON.stringify(expectedOrdinals) || finalPages.length !== 1 || !tokenChainValid) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_page_chain_incomplete",
        subjectType: "ingest_batch",
        subjectKey: id,
        evidenceIds: [`batch:${id}`, ...batchPages.map((page) => `page:${pageId(page)}`)],
        detail: { ordinals, finalPageCount: finalPages.length, tokenChainValid },
      });
    }
    const batchObservationIds = sortedUnique(pageObservations
      .filter((row) => batchId(row) === id)
      .map(observationId));
    const batchJobIds = sortedUnique(pageJobs
      .filter((row) => batchId(row) === id)
      .map(jobId));
    const persistedPageCount = field(batch, "pageCount", "page_count");
    const persistedObservationCount = field(batch, "observationCount", "observation_count");
    const persistedJobCount = field(batch, "jobCount", "job_count");
    const countersMismatch =
      (persistedPageCount !== undefined && integer(persistedPageCount, -1) !== batchPages.length) ||
      (persistedObservationCount !== undefined && integer(persistedObservationCount, -1) !== batchObservationIds.length) ||
      (persistedJobCount !== undefined && integer(persistedJobCount, -1) !== batchJobIds.length);
    const finalCursor = finalPages.length === 1
      ? text(field(finalPages[0], "responseMailboxHistoryId", "response_mailbox_history_id"))
      : "";
    const committedCursor = text(field(batch, "committedCursorValue", "committed_cursor_value"));
    if (countersMismatch || (finalCursor && committedCursor && finalCursor !== committedCursor)) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_batch_persistence_mismatch",
        subjectType: "ingest_batch",
        subjectKey: id,
        evidenceIds: [`batch:${id}`, ...batchObservationIds, ...batchJobIds],
        evidenceObservationIds: batchObservationIds,
        detail: {
          persistedPageCount: persistedPageCount === undefined ? null : integer(persistedPageCount, -1),
          actualPageCount: batchPages.length,
          persistedObservationCount: persistedObservationCount === undefined ? null : integer(persistedObservationCount, -1),
          actualObservationCount: batchObservationIds.length,
          persistedJobCount: persistedJobCount === undefined ? null : integer(persistedJobCount, -1),
          actualJobCount: batchJobIds.length,
          finalCursor,
          committedCursor,
        },
      });
    }
  }

  for (const page of pages) {
    const id = pageId(page);
    const providerResponse = field(page, "providerResponse", "provider_response") || {};
    const manifest = Array.isArray(field(page, "providerEventManifest", "provider_event_manifest"))
      ? field(page, "providerEventManifest", "provider_event_manifest")
      : [];
    const pageObservationLinks = pageObservations.filter((row) =>
      batchId(row) === batchId(page) && integer(field(row, "pageOrdinal", "page_ordinal"), -1) === integer(field(page, "pageOrdinal", "page_ordinal"), -1));
    const pageJobLinks = pageJobs.filter((row) =>
      batchId(row) === batchId(page) && integer(field(row, "pageOrdinal", "page_ordinal"), -1) === integer(field(page, "pageOrdinal", "page_ordinal"), -1));
    const pageObservationIds = sortedUnique(pageObservationLinks.map(observationId));
    const pageJobIds = sortedUnique(pageJobLinks.map(jobId));
    const evidenceIds = [`page:${id}`, ...manifest.map(eventId), ...pageObservationIds, ...pageJobIds];
    const expectedProviderHash = text(field(page, "providerResponseHash", "provider_response_hash"));
    const computedProviderHash = digest(postgresJsonbText(providerResponse));

    if (text(field(providerResponse, "historyId", "history_id")) !==
        text(field(page, "responseMailboxHistoryId", "response_mailbox_history_id")) ||
        text(field(providerResponse, "nextPageToken", "next_page_token")) !==
        text(field(page, "responseNextPageToken", "response_next_page_token"))) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_provider_response_cursor_mismatch",
        subjectType: "gmail_page",
        subjectKey: id,
        evidenceIds,
        detail: {
          providerHistoryId: text(field(providerResponse, "historyId", "history_id")),
          pageHistoryId: text(field(page, "responseMailboxHistoryId", "response_mailbox_history_id")),
          providerNextPageToken: text(field(providerResponse, "nextPageToken", "next_page_token")),
          pageNextPageToken: text(field(page, "responseNextPageToken", "response_next_page_token")),
        },
      });
    }

    if (!HASH_RE.test(expectedProviderHash) || expectedProviderHash !== computedProviderHash) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_provider_response_hash_mismatch",
        subjectType: "gmail_page",
        subjectKey: id,
        evidenceIds,
        detail: { expectedProviderHash, computedProviderHash },
      });
    }

    const persistedEventCount = integer(field(page, "eventCount", "event_count"), -1);
    const persistedJobCount = integer(field(page, "jobCount", "job_count"), -1);
    if (persistedEventCount !== manifest.length || persistedEventCount !== pageObservationIds.length ||
        persistedJobCount !== pageJobIds.length) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_page_membership_incomplete",
        subjectType: "gmail_page",
        subjectKey: id,
        evidenceIds,
        evidenceObservationIds: pageObservationIds,
        detail: {
          eventCount: persistedEventCount,
          manifestCount: manifest.length,
          observationMembershipCount: pageObservationIds.length,
          jobCount: persistedJobCount,
          jobMembershipCount: pageJobIds.length,
        },
      });
    }

    const providerSet = new Set(providerResponseEvents(providerResponse).map(eventIdentity));
    const manifestSet = new Set(manifest.map(eventIdentity));
    const missingManifestEvents = [...providerSet].filter((key) => !manifestSet.has(key)).sort();
    const inventedManifestEvents = [...manifestSet].filter((key) => !providerSet.has(key)).sort();
    if (missingManifestEvents.length || inventedManifestEvents.length) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_provider_event_unmapped",
        subjectType: "gmail_page",
        subjectKey: id,
        evidenceIds,
        detail: { missingManifestEvents, inventedManifestEvents },
      });
    }

    const manifestEventIds = manifest.map(eventId);
    if (manifestEventIds.some((value) => !/^gmail-event:v1:[0-9a-f]{64}$/.test(value)) ||
        new Set(manifestEventIds).size !== manifestEventIds.length) {
      add({
        stage: "gmail_ingest",
        classification: "gmail_provider_event_identity_invalid",
        subjectType: "gmail_page",
        subjectKey: id,
        evidenceIds,
        detail: { eventIds: manifestEventIds },
      });
    }

    for (const event of manifest) {
      const matchingObservations = pageObservationIds
        .map((observationKey) => observationMap.get(observationKey))
        .filter(Boolean)
        .filter((observation) => {
          const payload = field(observation, "normalizedPayload", "normalized_payload") || {};
          return text(field(payload, "eventId", "event_id")) === eventId(event) &&
            eventIdentity(payload) === eventIdentity(event);
        });
      if (matchingObservations.length !== 1) {
        add({
          stage: "gmail_ingest",
          classification: "gmail_event_observation_mapping_invalid",
          subjectType: "gmail_event",
          subjectKey: eventId(event) || eventIdentity(event),
          evidenceIds: [`page:${id}`, eventId(event), ...pageObservationIds],
          evidenceObservationIds: pageObservationIds,
          detail: { matchingObservationCount: matchingObservations.length },
        });
        continue;
      }
      if (RAW_REQUIRED_EVENT_TYPES.has(text(field(event, "eventType", "event_type")))) {
        const eventObservationId = observationId(matchingObservations[0]);
        const rawJobs = pageJobIds
          .map((key) => jobMap.get(key))
          .filter(Boolean)
          .filter((job) => text(field(job, "jobKind", "job_kind")) === "gmail_fetch_raw_message" &&
            text(field(job, "observationId", "observation_id")) === eventObservationId &&
            text(field(job, "sourceObjectId", "source_object_id")) === text(field(event, "messageId", "message_id")));
        if (rawJobs.length !== 1) {
          add({
            stage: "gmail_ingest",
            classification: "gmail_raw_fetch_job_missing",
            subjectType: "gmail_event",
            subjectKey: eventId(event),
            evidenceIds: [`page:${id}`, eventId(event), eventObservationId, ...pageJobIds],
            evidenceObservationIds: [eventObservationId],
            detail: { matchingRawJobCount: rawJobs.length },
          });
        }
      }
    }

    for (const linkedId of pageObservationIds) {
      if (!observationMap.has(linkedId)) {
        add({
          stage: "gmail_ingest",
          classification: "gmail_page_observation_missing",
          subjectType: "source_observation",
          subjectKey: linkedId,
          evidenceIds: [`page:${id}`, linkedId],
          evidenceObservationIds: [linkedId],
          detail: {},
        });
      }
    }
    for (const linkedId of pageJobIds) {
      if (!jobMap.has(linkedId)) {
        add({
          stage: "gmail_ingest",
          classification: "gmail_page_job_missing",
          subjectType: "processing_job",
          subjectKey: linkedId,
          evidenceIds: [`page:${id}`, linkedId],
          detail: {},
        });
      }
    }
  }

  return { pages, observations, jobs, pageObservations, pageJobs, observationMap, jobMap };
}

function auditProcessing({ source, gmailIndex, add }) {
  const lineageContractPresent = ["jobLineage", "jobChildren", "jobObservations"]
    .every((key) => Object.prototype.hasOwnProperty.call(source, key));
  const lineage = rows(source, "jobLineage", "sourceProcessingJobLineage");
  const childLinks = rows(source, "jobChildren", "sourceProcessingJobChildren");
  const outputLinks = rows(source, "jobObservations", "sourceProcessingJobObservations");
  const jobsById = new Map(gmailIndex.jobs.map((job) => [jobId(job), job]));
  const observationsById = gmailIndex.observationMap;
  const lineageByJob = new Map(lineage.map((row) => [jobId(row), row]));
  const childrenByParent = new Map();
  const outputsByJob = new Map();
  for (const link of childLinks) {
    const parent = parentJobId(link);
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(link);
  }
  for (const link of outputLinks) {
    const id = jobId(link);
    if (!outputsByJob.has(id)) outputsByJob.set(id, []);
    outputsByJob.get(id).push(link);
  }

  for (const row of lineageContractPresent ? lineage : []) {
    const id = jobId(row);
    const parent = parentJobId(row);
    const job = jobsById.get(id);
    if (!job || (parent && !jobsById.has(parent))) {
      add({
        stage: "processing",
        classification: "processing_job_lineage_orphaned",
        subjectType: "processing_job",
        subjectKey: id,
        evidenceIds: [id, parent],
        detail: { jobPresent: Boolean(job), parentJobId: parent, parentPresent: !parent || jobsById.has(parent) },
      });
    }
  }
  for (const link of lineageContractPresent ? childLinks : []) {
    const parent = parentJobId(link);
    const child = childJobId(link);
    const childLineage = lineageByJob.get(child);
    if (!jobsById.has(parent) || !jobsById.has(child) || parentJobId(childLineage) !== parent) {
      add({
        stage: "processing",
        classification: "processing_child_lineage_mismatch",
        subjectType: "processing_job",
        subjectKey: child,
        evidenceIds: [parent, child],
        detail: {
          parentPresent: jobsById.has(parent),
          childPresent: jobsById.has(child),
          recordedLineageParent: parentJobId(childLineage),
        },
      });
    }
  }

  const groupedBacklog = new Map();
  const groupedDeadLetter = new Map();
  for (const job of gmailIndex.jobs) {
    const state = text(field(job, "state"));
    const key = [
      text(field(job, "sourceSystem", "source_system")),
      text(field(job, "connectionKey", "connection_key")),
    ].join(":");
    if (BACKLOG_STATES.has(state)) {
      if (!groupedBacklog.has(key)) groupedBacklog.set(key, []);
      groupedBacklog.get(key).push(job);
    } else if (state === "dead_letter") {
      if (!groupedDeadLetter.has(key)) groupedDeadLetter.set(key, []);
      groupedDeadLetter.get(key).push(job);
    } else if (!TERMINAL_JOB_STATES.has(state)) {
      add({
        stage: "processing",
        classification: "processing_job_state_invalid",
        subjectType: "processing_job",
        subjectKey: jobId(job),
        evidenceIds: [jobId(job)],
        evidenceObservationIds: [observationId(job)],
        detail: { state },
      });
    }
  }
  for (const [key, jobs] of [...groupedBacklog.entries()].sort()) {
    add({
      stage: "processing",
      severity: "attention",
      classification: "processing_backlog_present",
      subjectType: "processing_queue",
      subjectKey: key,
      evidenceIds: jobs.map(jobId),
      evidenceObservationIds: jobs.map(observationId),
      detail: {
        count: jobs.length,
        states: jobs.reduce((output, job) => {
          const state = text(field(job, "state"));
          output[state] = (output[state] || 0) + 1;
          return output;
        }, {}),
      },
    });
  }
  for (const [key, jobs] of [...groupedDeadLetter.entries()].sort()) {
    add({
      stage: "processing",
      classification: "processing_dead_letter_present",
      subjectType: "processing_queue",
      subjectKey: key,
      evidenceIds: jobs.map(jobId),
      evidenceObservationIds: jobs.map(observationId),
      detail: { count: jobs.length },
    });
  }

  // Worker results are immutable historical receipts. Legacy v1 records retain
  // their historical inline-policy meaning. Current v2 records are extraction
  // frontiers and remain blocking until a later acceptance epoch covers their
  // exact candidate manifest, including an empty manifest.

  const outputObservations = (id) => (outputsByJob.get(id) || [])
    .map((link) => observationsById.get(observationId(link)))
    .filter(Boolean);
  const childJobs = (id) => (childrenByParent.get(id) || [])
    .map((link) => jobsById.get(childJobId(link)))
    .filter(Boolean);
  const kinds = (items) => items.map((item) => text(field(item, "jobKind", "job_kind"))).sort();

  for (const job of lineageContractPresent
    ? gmailIndex.jobs.filter((row) => text(field(row, "state")) === "succeeded")
    : []) {
    const id = jobId(job);
    const kind = text(field(job, "jobKind", "job_kind"));
    const outputs = outputObservations(id);
    const children = childJobs(id);
    const outputTypes = outputs.map((row) => text(field(row, "sourceObjectType", "source_object_type"))).sort();
    const childKinds = kinds(children);
    let valid = true;
    let expected = {};
    if (kind === "gmail_fetch_raw_message") {
      valid = outputTypes.filter((item) => item === "gmail_message_raw").length === 1
        && childKinds.filter((item) => item === "gmail_parse_rfc822").length === 1;
      expected = { gmailMessageRaw: 1, gmailParseRfc822: 1 };
    } else if (kind === "gmail_parse_rfc822") {
      const parsed = outputs.filter((row) => text(field(row, "sourceObjectType", "source_object_type")) === "gmail_message_parsed");
      const attachments = outputs.filter((row) => text(field(row, "sourceObjectType", "source_object_type")) === "gmail_attachment");
      const messageClaimChildren = children.filter((row) => text(field(row, "jobKind", "job_kind")) === "gmail_extract_message_claims");
      const linkChildren = children.filter((row) => text(field(row, "jobKind", "job_kind")) === "gmail_resolve_entity_links");
      const attachmentChildren = children.filter((row) => text(field(row, "jobKind", "job_kind")) === "gmail_extract_attachment");
      const attachmentIds = new Set(attachments.map(observationId));
      valid = parsed.length === 1
        && messageClaimChildren.length === 1
        && observationId(messageClaimChildren[0]) === observationId(parsed[0])
        && linkChildren.length === 1
        && observationId(linkChildren[0]) === observationId(parsed[0])
        && attachmentChildren.length === attachments.length
        && attachmentChildren.every((child) => attachmentIds.has(observationId(child)));
      expected = {
        gmailMessageParsed: 1,
        gmailMessageClaimJobs: 1,
        gmailEntityLinkJobs: 1,
        gmailAttachments: attachments.length,
        gmailAttachmentJobs: attachments.length,
      };
    } else if (kind === "gmail_extract_attachment") {
      const extracted = outputs.filter((row) => text(field(row, "sourceObjectType", "source_object_type")) === "gmail_attachment_extracted");
      const claimChildren = children.filter((row) => text(field(row, "jobKind", "job_kind")) === "gmail_extract_attachment_claims");
      const reviewChildren = children.filter((row) => text(field(row, "jobKind", "job_kind")) === "gmail_review_attachment_extraction");
      const extraction = field(field(extracted[0], "normalizedPayload", "normalized_payload"), "extraction") || {};
      const status = text(field(extraction, "status"));
      const reviewRequired = field(extraction, "reviewRequired", "review_required") === true;
      valid = extracted.length === 1
        && (status === "extracted"
          ? claimChildren.length === 1 && observationId(claimChildren[0]) === observationId(extracted[0])
          : claimChildren.length === 0)
        && (reviewRequired
          ? reviewChildren.length === 1 && observationId(reviewChildren[0]) === observationId(extracted[0])
          : reviewChildren.length === 0);
      expected = {
        gmailAttachmentExtracted: 1,
        claimJobs: status === "extracted" ? 1 : 0,
        reviewJobs: reviewRequired ? 1 : 0,
      };
    } else if (CLAIM_EXTRACTION_JOB_KINDS.has(kind)) {
      const result = field(job, "result") || {};
      const resultSchemaVersion = text(field(result, "schemaVersion", "schema_version"));
      const candidateCount = integer(field(result, "candidateCount", "candidate_count"), -1);
      const acceptedCount = integer(field(result, "acceptedCount", "accepted_count"), -1);
      const rejectedCount = integer(field(result, "rejectedCount", "rejected_count"), 0);
      const reviewCount = integer(field(result, "reviewCount", "review_count"), 0);
      const pendingCount = integer(field(result, "pendingCount", "pending_count"), -1);
      const resultCandidates = field(result, "candidates") || [];
      const forbiddenCoordinatorFields = [
        "decisionVersionId", "decisionItemHash", "acceptedClaimVersionId",
        "acceptedClaimItemHash", "bindingId", "bindingItemHash",
      ];
      const validLegacy = resultSchemaVersion === "truth-claim-worker-result-v1"
        && candidateCount >= 0 && acceptedCount >= 0 && rejectedCount >= 0
        && pendingCount >= 0 && reviewCount >= 0 && reviewCount <= pendingCount
        && acceptedCount + rejectedCount + pendingCount === candidateCount;
      const validCoordinatorPending = resultSchemaVersion === "truth-claim-worker-result-v2"
        && candidateCount >= 0
        && acceptedCount === 0
        && rejectedCount === 0
        && reviewCount === 0
        && pendingCount === candidateCount
        && text(field(result, "acceptanceDisposition", "acceptance_disposition"))
          === "pending_acceptance_coordinator"
        && integer(field(result, "canonicalMutationCount", "canonical_mutation_count"), -1) === 0
        && Array.isArray(resultCandidates)
        && resultCandidates.length === candidateCount
        && resultCandidates.every((candidate) => (
          text(field(candidate, "disposition")) === "pending_acceptance_coordinator"
          && forbiddenCoordinatorFields.every((key) => !Object.prototype.hasOwnProperty.call(candidate, key))
        ));
      valid = validLegacy || validCoordinatorPending;
      expected = {
        resultSchemaVersions: ["truth-claim-worker-result-v1", "truth-claim-worker-result-v2"],
        balancedCandidateCounts: true,
        reviewCountIsPendingSubset: true,
        v2AcceptanceDisposition: "pending_acceptance_coordinator",
        v2CanonicalMutationCount: 0,
      };
      if (validCoordinatorPending) {
        add({
          stage: "processing",
          classification: "candidate_acceptance_epoch_missing",
          subjectType: "processing_job",
          subjectKey: id,
          evidenceIds: [
            id,
            text(field(field(result, "truthPlan", "truth_plan"),
              "deterministicManifestHash", "deterministic_manifest_hash")),
          ],
          evidenceObservationIds: [observationId(job)],
          detail: {
            jobKind: kind,
            resultSchemaVersion,
            candidateCount,
            acceptanceDisposition: "pending_acceptance_coordinator",
            canonicalMutationCount: 0,
            acceptanceEpochReceiptRequired: true,
          },
        });
      }
    }
    if (!valid) {
      add({
        stage: "processing",
        classification: "processing_stage_lineage_incomplete",
        subjectType: "processing_job",
        subjectKey: id,
        evidenceIds: [id, ...outputs.map(observationId), ...children.map(jobId)],
        evidenceObservationIds: outputs.map(observationId),
        detail: { jobKind: kind, outputTypes, childKinds, expected },
      });
    }
  }

  const attachmentCompleteness = field(
    source,
    "attachmentExtractionCompleteness",
    "attachment_extraction_completeness",
  );
  const durableAttachmentState = isPlainObject(attachmentCompleteness)
    && text(field(attachmentCompleteness, "schemaVersion", "schema_version"))
      === "gmail-attachment-extraction-completeness-v1";
  if (durableAttachmentState) {
    const gaps = rows(source, "attachmentExtractionGaps", "attachment_extraction_gaps");
    const unresolvedCount = integer(
      field(attachmentCompleteness, "unresolvedCount", "unresolved_count"),
      -1,
    );
    for (const gap of gaps) {
      const targetObservationId = observationId(gap)
        || text(field(gap, "attachmentObservationId", "attachment_observation_id"));
      add({
        stage: "processing",
        classification: "attachment_evidence_extraction_incomplete",
        subjectType: "gmail_attachment",
        subjectKey: text(field(gap, "attachmentId", "attachment_id")) || targetObservationId,
        evidenceIds: [targetObservationId, text(field(gap, "reviewJobId", "review_job_id"))],
        evidenceObservationIds: [targetObservationId],
        detail: {
          status: text(field(gap, "extractionStatus", "extraction_status")),
          reviewRequired: true,
          method: text(field(gap, "extractionMethod", "extraction_method")),
          provenance: text(field(gap, "extractionProvenance", "extraction_provenance")),
          filename: text(field(gap, "filename")),
          mimeType: text(field(gap, "mimeType", "mime_type")),
          reviewJobState: text(field(gap, "reviewJobState", "review_job_state")),
        },
      });
    }
    if (unresolvedCount > gaps.length || unresolvedCount < 0) {
      add({
        stage: "processing",
        classification: "attachment_evidence_extraction_incomplete",
        subjectType: "gmail_attachment_queue",
        subjectKey: "durable-attachment-review-inventory",
        evidenceIds: gaps.map((gap) => observationId(gap)
          || text(field(gap, "attachmentObservationId", "attachment_observation_id"))),
        detail: { unresolvedCount, returnedGapCount: gaps.length },
      });
    }
  } else {
    // Legacy snapshots do not carry the durable cross-batch inventory. Fail
    // closed on every incomplete extracted observation still visible instead
    // of treating it as an attention-only diagnostic.
    for (const observation of gmailIndex.observations) {
      if (text(field(observation, "sourceObjectType", "source_object_type")) !== "gmail_attachment_extracted") continue;
      const payload = field(observation, "normalizedPayload", "normalized_payload") || {};
      const extraction = field(payload, "extraction") || {};
      const status = text(field(extraction, "status"));
      const reviewRequired = field(extraction, "reviewRequired", "review_required") === true;
      if (status !== "extracted" || reviewRequired) {
        add({
          stage: "processing",
          classification: "attachment_evidence_extraction_incomplete",
          subjectType: "gmail_attachment",
          subjectKey: text(field(observation, "sourceObjectId", "source_object_id")),
          evidenceIds: [observationId(observation)],
          evidenceObservationIds: [observationId(observation)],
          detail: {
            status,
            reviewRequired,
            method: text(field(extraction, "method")),
            reason: text(field(extraction, "reason")),
            filename: text(field(payload, "filename")),
            mimeType: text(field(payload, "mimeType", "mime_type")),
          },
        });
      }
    }
  }

  const modelCompleteness = field(
    source,
    "modelExtractionCompleteness",
    "model_extraction_completeness",
  );
  const durableModelState = isPlainObject(modelCompleteness)
    && text(field(modelCompleteness, "schemaVersion", "schema_version"))
      === "gmail-model-extraction-completeness-v1";
  if (!durableModelState) {
    add({
      stage: "processing",
      classification: "model_extraction_authority_missing",
      subjectType: "gmail_model_authority",
      subjectKey: "durable-model-extraction-authority",
      evidenceIds: ["model-extraction-completeness:gmail"],
      detail: {
        expectedSchemaVersion: "gmail-model-extraction-completeness-v1",
        observedSchemaVersion: text(field(
          modelCompleteness,
          "schemaVersion",
          "schema_version",
        )),
        witnessPresent: isPlainObject(modelCompleteness),
      },
    });
  } else {
    const jobGaps = rows(source, "modelExtractionJobGaps", "model_extraction_job_gaps");
    const reviewGaps = rows(source, "modelExtractionReviewGaps", "model_extraction_review_gaps");
    const pendingJobCount = integer(
      field(modelCompleteness, "pendingJobCount", "pending_job_count"),
      -1,
    );
    const pendingReviewCount = integer(
      field(modelCompleteness, "pendingReviewCount", "pending_review_count"),
      -1,
    );
    const complete = field(modelCompleteness, "complete") === true;
    for (const gap of jobGaps) {
      const extractionPlanId = text(field(gap, "extractionPlanId", "extraction_plan_id"));
      const modelPlanId = text(field(gap, "modelPlanId", "model_plan_id"));
      const parentId = text(field(gap, "parentJobId", "parent_job_id"));
      const childId = text(field(gap, "modelChildJobId", "model_child_job_id"));
      const targetObservationId = observationId(gap)
        || text(field(gap, "sourceObservationId", "source_observation_id"));
      add({
        stage: "processing",
        classification: "model_extraction_job_pending",
        subjectType: "gmail_model_plan",
        subjectKey: modelPlanId || extractionPlanId || parentId,
        evidenceIds: [extractionPlanId, modelPlanId, parentId, childId, targetObservationId],
        evidenceObservationIds: [targetObservationId],
        detail: {
          modelChildJobState: text(field(gap, "modelChildJobState", "model_child_job_state")),
          executionMode: text(field(gap, "executionMode", "execution_mode")),
          contextSealId: text(field(gap, "contextSealId", "context_seal_id")),
        },
      });
    }
    for (const gap of reviewGaps) {
      const obligationId = text(field(gap, "obligationId", "obligation_id"));
      const extractionPlanId = text(field(gap, "extractionPlanId", "extraction_plan_id"));
      const reviewJobId = text(field(gap, "reviewJobId", "review_job_id"));
      add({
        stage: "processing",
        classification: "model_extraction_review_pending",
        subjectType: "gmail_model_review",
        subjectKey: obligationId || extractionPlanId || reviewJobId,
        evidenceIds: [obligationId, extractionPlanId, text(field(gap, "modelPlanId", "model_plan_id")), reviewJobId],
        detail: {
          reviewJobState: text(field(gap, "reviewJobState", "review_job_state")),
          reasonCode: text(field(gap, "reasonCode", "reason_code")),
          safeDetailHash: text(field(gap, "safeDetailHash", "safe_detail_hash")),
        },
      });
    }
    if (pendingJobCount < 0 || pendingReviewCount < 0
      || pendingJobCount < jobGaps.length || pendingReviewCount < reviewGaps.length
      || complete !== (pendingJobCount === 0 && pendingReviewCount === 0)
      || pendingJobCount > jobGaps.length || pendingReviewCount > reviewGaps.length) {
      add({
        stage: "processing",
        classification: "model_extraction_inventory_incomplete",
        subjectType: "gmail_model_queue",
        subjectKey: "durable-model-extraction-inventory",
        evidenceIds: [
          ...jobGaps.map((gap) => text(field(gap, "extractionPlanId", "extraction_plan_id"))),
          ...reviewGaps.map((gap) => text(field(gap, "obligationId", "obligation_id"))),
        ],
        detail: {
          pendingJobCount,
          returnedJobGapCount: jobGaps.length,
          pendingReviewCount,
          returnedReviewGapCount: reviewGaps.length,
          complete,
        },
      });
    }

    for (const job of gmailIndex.jobs) {
      if (text(field(job, "state")) !== "succeeded") continue;
      const kind = text(field(job, "jobKind", "job_kind"));
      const result = field(job, "result") || {};
      if (kind === "gmail_extract_message_claims") {
        const truthPlan = field(result, "truthPlan", "truth_plan");
        const planningStatus = text(field(truthPlan, "planningStatus", "planning_status"));
        const modelPlanId = text(field(truthPlan, "modelPlanId", "model_plan_id"));
        const planningFailureCode = text(field(
          truthPlan,
          "planningFailureCode",
          "planning_failure_code",
        ));
        const deterministicCandidateCount = integer(field(
          truthPlan,
          "deterministicCandidateCount",
          "deterministic_candidate_count",
        ), -1);
        const materializedDeterministicCandidateCount = integer(field(
          truthPlan,
          "materializedDeterministicCandidateCount",
          "materialized_deterministic_candidate_count",
        ), -1);
        const plannedDeterministicCandidateSetHash = text(field(
          truthPlan,
          "plannedDeterministicCandidateSetHash",
          "planned_deterministic_candidate_set_hash",
        ));
        const resultCandidateCount = integer(field(result, "candidateCount", "candidate_count"), -1);
        const valid = isPlainObject(truthPlan)
          && text(field(truthPlan, "schemaVersion", "schema_version"))
            === "gmail-extraction-plan-completion-witness-v2"
          && /^gmail-extraction-plan:v1:[0-9a-f]{64}$/.test(text(
            field(truthPlan, "extractionPlanId", "extraction_plan_id"),
          ))
          && HASH_RE.test(text(field(truthPlan, "planSealHash", "plan_seal_hash")))
          && HASH_RE.test(text(
            field(truthPlan, "deterministicManifestHash", "deterministic_manifest_hash"),
          ))
          && HASH_RE.test(plannedDeterministicCandidateSetHash)
          && deterministicCandidateCount >= 0 && deterministicCandidateCount <= 2000
          && materializedDeterministicCandidateCount >= 0
          && materializedDeterministicCandidateCount <= 50
          && materializedDeterministicCandidateCount <= deterministicCandidateCount
          && materializedDeterministicCandidateCount === resultCandidateCount
          && ["complete", "review_required"].includes(planningStatus)
          && (modelPlanId === "" || /^gmail-model-plan:v1:[0-9a-f]{64}$/.test(modelPlanId))
          && (planningStatus !== "complete" || (
            planningFailureCode === ""
            && deterministicCandidateCount === materializedDeterministicCandidateCount
          ))
          && (planningStatus !== "review_required"
            || (modelPlanId === ""
              && materializedDeterministicCandidateCount === 0
              && /^[A-Z][A-Z0-9_]{2,99}$/.test(planningFailureCode)));
        if (!valid) {
          add({
            stage: "processing",
            classification: "model_extraction_lineage_incomplete",
            subjectType: "processing_job",
            subjectKey: jobId(job),
            evidenceIds: [jobId(job), observationId(job), modelPlanId],
            evidenceObservationIds: [observationId(job)],
            detail: { jobKind: kind, missingWitness: "truthPlan" },
          });
        }
      } else if (kind === "gmail_extract_message_model_claims") {
        const terminal = field(result, "modelTerminal", "model_terminal");
        const terminalKind = text(field(terminal, "terminalKind", "terminal_kind"));
        const modelPlanId = text(field(terminal, "modelPlanId", "model_plan_id"));
        const lineageParent = parentJobId(lineageByJob.get(jobId(job)));
        const parent = jobsById.get(lineageParent);
        const parentPlan = field(field(parent, "result") || {}, "truthPlan", "truth_plan");
        const resultId = text(field(terminal, "resultId", "result_id"));
        const resultHash = text(field(terminal, "resultHash", "result_hash"));
        const terminalCandidateCount = integer(field(
          terminal,
          "candidateCount",
          "candidate_count",
        ), -1);
        const resultCandidateCount = integer(field(result, "candidateCount", "candidate_count"), -1);
        const reviewIntentId = text(field(terminal, "reviewIntentId", "review_intent_id"));
        const reviewIntentHash = text(field(terminal, "reviewIntentHash", "review_intent_hash"));
        const reasonCode = text(field(terminal, "reasonCode", "reason_code"));
        const safeDetailHash = text(field(terminal, "safeDetailHash", "safe_detail_hash"));
        const valid = isPlainObject(terminal)
          && text(field(terminal, "schemaVersion", "schema_version"))
            === "gmail-model-terminal-witness-v1"
          && ["successful_result", "review_intent"].includes(terminalKind)
          && /^gmail-model-plan:v1:[0-9a-f]{64}$/.test(modelPlanId)
          && modelPlanId === text(field(field(job, "payload") || {}, "modelPlanId", "model_plan_id"))
          && modelPlanId === text(field(parentPlan, "modelPlanId", "model_plan_id"))
          && (terminalKind !== "successful_result"
            || (/^gmail-model-result:v1:[0-9a-f]{64}$/.test(resultId)
              && HASH_RE.test(resultHash)
              && resultId === `gmail-model-result:v1:${resultHash}`
              && /^model-request:v1:[0-9a-f]{64}$/.test(text(
                field(terminal, "modelRequestId", "model_request_id"),
              ))
              && /^model-outcome:v1:[0-9a-f]{64}$/.test(text(
                field(terminal, "modelAttemptOutcomeId", "model_attempt_outcome_id"),
              ))
              && text(field(terminal, "providerResponseId", "provider_response_id")) !== ""
              && HASH_RE.test(text(field(terminal, "providerResultHash", "provider_result_hash")))
              && HASH_RE.test(text(field(terminal, "normalizedResultHash", "normalized_result_hash")))
              && text(field(terminal, "actualModel", "actual_model")) !== ""
              && HASH_RE.test(text(
                field(terminal, "candidateManifestHash", "candidate_manifest_hash"),
              ))
              && terminalCandidateCount >= 1 && terminalCandidateCount <= 50
              && resultCandidateCount === terminalCandidateCount))
          && (terminalKind !== "review_intent"
            || (/^gmail-model-review-intent:v1:[0-9a-f]{64}$/.test(reviewIntentId)
              && HASH_RE.test(reviewIntentHash)
              && reviewIntentId === `gmail-model-review-intent:v1:${reviewIntentHash}`
              && /^[A-Z][A-Z0-9_]{2,99}$/.test(reasonCode)
              && HASH_RE.test(safeDetailHash)
              && resultCandidateCount === 0));
        if (!valid) {
          add({
            stage: "processing",
            classification: "model_extraction_lineage_incomplete",
            subjectType: "processing_job",
            subjectKey: jobId(job),
            evidenceIds: [jobId(job), lineageParent, observationId(job), modelPlanId],
            evidenceObservationIds: [observationId(job)],
            detail: { jobKind: kind, missingWitness: "modelTerminal", terminalKind },
          });
        }
      }
    }
  }
}

function auditSourceCut({ sourceIndex, canonical, production, add, digest }) {
  const cuts = rows(canonical, "sourceCuts");
  const cutCursors = rows(canonical, "sourceCutCursors");
  const cutObservations = rows(canonical, "sourceCutObservations");
  const partitionWitnesses = rows(canonical, "sourceCutPartitionWitnesses");
  const evidenceObservations = rows(canonical, "sourceCutEvidenceObservations");
  const productionHead = rows(canonical, "publicationHeads", "truthPublicationHeads")
    .find((row) => text(field(row, "channel")) === "production");
  const targetId = text(field(canonical, "currentSourceCutId", "current_source_cut_id")) ||
    sourceCutId(productionHead) || text(field(production, "sourceCutId", "source_cut_id"));
  const cut = cuts.find((row) => sourceCutId(row) === targetId);
  if (!targetId || !cut) {
    add({
      stage: "source_cut",
      classification: "current_source_cut_missing",
      subjectType: "source_cut",
      subjectKey: targetId || "unresolved",
      evidenceIds: targetId ? [targetId] : [],
      detail: {},
    });
    return { cuts, cutCursors, cutObservations, targetId, cut: null };
  }

  const manifest = field(cut, "manifest");
  const storedManifestHash = text(field(cut, "manifestHash", "manifest_hash"));
  if (!isPlainObject(manifest) || digest(postgresJsonbText(manifest)) !== storedManifestHash) {
    add({
      stage: "source_cut",
      classification: "source_cut_manifest_hash_mismatch",
      subjectType: "source_cut",
      subjectKey: targetId,
      evidenceIds: [targetId, storedManifestHash],
      detail: { storedManifestHash },
    });
  }
  const manifestCursors = Array.isArray(field(manifest, "cursors")) ? field(manifest, "cursors") : [];
  const manifestRequiredSources = Array.isArray(field(manifest, "requiredSources"))
    ? field(manifest, "requiredSources")
    : [];
  const manifestCursorKeys = sortedUnique(manifestCursors.map(cursorKey));
  const manifestRequiredKeys = sortedUnique(manifestRequiredSources.map(cursorKey));
  if (!isPlainObject(manifest) || text(field(manifest, "schemaVersion")) !== "source-cut-manifest-v2" ||
      text(field(manifest, "partitionWitnessVersion")) !== "source-cut-partition-witness-v1" ||
      Object.prototype.hasOwnProperty.call(manifest || {}, "observations") ||
      !Array.isArray(field(manifest, "cursors")) ||
      JSON.stringify(manifestCursorKeys) !== JSON.stringify(manifestRequiredKeys) ||
      manifestCursors.some((cursor) => field(cursor, "emptyScope") !==
        (integer(field(cursor, "observationCount", "observation_count"), -1) === 0))) {
    add({
      stage: "source_cut",
      classification: "source_cut_compact_manifest_invalid",
      subjectType: "source_cut",
      subjectKey: targetId,
      evidenceIds: [targetId, storedManifestHash],
      detail: {
        schemaVersion: text(field(manifest, "schemaVersion")),
        partitionWitnessVersion: text(field(manifest, "partitionWitnessVersion")),
        enumeratesObservations: Object.prototype.hasOwnProperty.call(manifest || {}, "observations"),
        requiredSourceCount: manifestRequiredKeys.length,
        cursorPartitionCount: manifestCursorKeys.length,
      },
    });
  }
  const gaps = Array.isArray(field(cut, "gaps")) ? field(cut, "gaps") : [];
  if (text(field(cut, "completeness")) !== "complete" || gaps.length) {
    add({
      stage: "source_cut",
      classification: "source_cut_incomplete",
      subjectType: "source_cut",
      subjectKey: targetId,
      evidenceIds: [targetId, ...gaps.map((gap) => field(gap, "gapId", "gap_id"))],
      detail: { completeness: text(field(cut, "completeness")), gapCount: gaps.length },
    });
  }
  for (const gap of gaps) {
    const gapType = text(field(gap, "gapType", "gap_type"));
    if (!["CANDIDATE_CLAIM_REVIEW_PENDING", "LINK_WORKGROUP_REVIEW_PENDING"].includes(gapType)) continue;
    add({
      stage: "source_cut",
      classification: gapType === "CANDIDATE_CLAIM_REVIEW_PENDING"
        ? "candidate_claim_review_pending"
        : "link_workgroup_review_pending",
      subjectType: gapType === "CANDIDATE_CLAIM_REVIEW_PENDING"
        ? "candidate_claim_queue"
        : "link_workgroup_review_queue",
      subjectKey: targetId,
      evidenceIds: [targetId, text(field(gap, "witnessHash", "witness_hash"))],
      detail: {
        gapType,
        count: integer(field(gap, "count"), -1),
        witnessHash: text(field(gap, "witnessHash", "witness_hash")),
      },
    });
  }

  const selectedCutCursors = cutCursors.filter((row) => sourceCutId(row) === targetId);
  const cutCursorMap = new Map(selectedCutCursors.map((row) => [cursorKey(row), row]));
  const manifestCursorMap = new Map(manifestCursors.map((row) => [cursorKey(row), row]));
  const selectedPartitionWitnesses = partitionWitnesses.filter((row) => sourceCutId(row) === targetId);
  const partitionWitnessMap = new Map(selectedPartitionWitnesses.map((row) => [cursorKey(row), row]));
  const liveCursorMap = sourceIndex.cursorMap;
  const vectorKeys = sortedUnique([...liveCursorMap.keys(), ...cutCursorMap.keys()]);
  for (const key of vectorKeys) {
    const live = liveCursorMap.get(key);
    const sealed = cutCursorMap.get(key);
    const liveVersion = integer(field(live, "cursorVersion", "cursor_version"), -1);
    const liveValue = text(field(live, "cursorValue", "cursor_value"));
    const sealedVersion = integer(field(sealed, "throughCursorVersion", "through_cursor_version"), -1);
    const sealedValue = text(field(sealed, "throughCursorValue", "through_cursor_value"));
    if (!live || !sealed || liveVersion !== sealedVersion || liveValue !== sealedValue) {
      add({
        stage: "source_cut",
        classification: "source_cut_cursor_mismatch",
        subjectType: "source_cursor",
        subjectKey: key,
        evidenceIds: [targetId, `cursor:${key}:${liveVersion}`, `cut-cursor:${key}:${sealedVersion}`],
        detail: { liveVersion, liveValue, sealedVersion, sealedValue },
      });
    }
  }

  for (const key of sortedUnique([
    ...cutCursorMap.keys(),
    ...partitionWitnessMap.keys(),
    ...manifestCursorMap.keys(),
  ])) {
    const sealed = cutCursorMap.get(key);
    const recomputed = partitionWitnessMap.get(key);
    const committed = manifestCursorMap.get(key);
    const sealedCount = integer(field(sealed, "observationCount", "observation_count"), -1);
    const recomputedCount = integer(field(recomputed, "observationCount", "observation_count"), -1);
    const sealedHash = text(field(sealed, "partitionHash", "partition_hash"));
    const recomputedHash = text(field(recomputed, "partitionHash", "partition_hash"));
    const sealedVersion = integer(field(sealed, "throughCursorVersion", "through_cursor_version"), -1);
    const recomputedVersion = integer(field(recomputed, "throughCursorVersion", "through_cursor_version"), -1);
    const committedCount = integer(field(committed, "observationCount", "observation_count"), -1);
    const committedHash = text(field(committed, "partitionHash", "partition_hash"));
    const committedVersion = integer(field(committed, "throughCursorVersion", "through_cursor_version"), -1);
    const committedValue = text(field(committed, "throughCursorValue", "through_cursor_value"));
    const sealedValue = text(field(sealed, "throughCursorValue", "through_cursor_value"));
    if (!sealed || !recomputed || !committed || sealedCount !== recomputedCount ||
        sealedCount !== committedCount || sealedHash !== recomputedHash || sealedHash !== committedHash ||
        sealedVersion !== recomputedVersion || sealedVersion !== committedVersion ||
        sealedValue !== committedValue || !HASH_RE.test(sealedHash)) {
      add({
        stage: "source_cut",
        classification: "source_cut_partition_witness_mismatch",
        subjectType: "source_cursor_partition",
        subjectKey: key,
        evidenceIds: [targetId, sealedHash, recomputedHash],
        detail: {
          sealedCount,
          recomputedCount,
          committedCount,
          sealedHash,
          recomputedHash,
          committedHash,
          sealedVersion,
          recomputedVersion,
          committedVersion,
          sealedValue,
          committedValue,
        },
      });
    }
  }

  const members = cutObservations.filter((row) => sourceCutId(row) === targetId);
  const expectedCount = integer(field(cut, "observationCount", "observation_count"), -1);
  const memberIds = members.map(observationId);
  const partitionCount = selectedCutCursors.reduce((sum, row) =>
    sum + integer(field(row, "observationCount", "observation_count"), -1), 0);
  if (members.length || expectedCount !== partitionCount || new Set(memberIds).size !== members.length) {
    add({
      stage: "source_cut",
      classification: "source_cut_compact_membership_mismatch",
      subjectType: "source_cut",
      subjectKey: targetId,
      evidenceIds: [targetId, ...memberIds],
      evidenceObservationIds: memberIds,
      detail: {
        expectedCount,
        partitionCount,
        deprecatedMemberCount: members.length,
        distinctDeprecatedMemberCount: new Set(memberIds).size,
      },
    });
  }

  const targetBuildIds = new Set(rows(canonical, "builds", "truthBuilds")
    .filter((build) => sourceCutId(build) === targetId)
    .map(buildId));
  const inputs = rows(canonical, "buildInputs", "truthBuildInputs")
    .filter((input) => targetBuildIds.has(buildId(input)));
  const envelopes = envelopeMap(canonical);
  const citedEvidence = new Map();
  for (const input of inputs) {
    const kind = text(field(input, "itemKind", "item_kind"));
    const itemId = text(field(input, "itemId", "item_id"));
    const envelope = envelopes.get(`${kind}:${itemId}`);
    collectObservationReferences(field(envelope, "canonicalEnvelope", "canonical_envelope"), citedEvidence);
  }
  const targetMembershipIds = new Set(inputs
    .filter((input) => text(field(input, "itemKind", "item_kind")) === "workgroup_membership")
    .map((input) => text(field(input, "itemId", "item_id"))));
  const targetWorkgroupIds = new Set(rows(canonical, "workgroupMembershipEnvelopes")
    .filter((envelope) => targetMembershipIds.has(text(field(envelope, "membershipVersionId", "membership_version_id"))))
    .map((envelope) => text(field(envelope, "workgroupId", "workgroup_id"))));
  for (const workgroup of rows(canonical, "workgroupDefinitionEnvelopes")
    .filter((envelope) => targetWorkgroupIds.has(text(field(envelope, "workgroupId", "workgroup_id"))))) {
    collectObservationReferences(
      field(workgroup, "canonicalDefinition", "canonical_definition"),
      citedEvidence,
    );
  }
  const closureRows = evidenceObservations.filter((row) => sourceCutId(row) === targetId || !sourceCutId(row));
  const closureMap = new Map(closureRows.map((row) => [observationId(row), row]));
  const closureIds = sortedUnique(closureRows.map(observationId));
  const citedIds = sortedUnique([...citedEvidence.keys()]);
  const missing = citedIds.filter((id) => !closureMap.has(id));
  const unrelated = closureIds.filter((id) => !citedEvidence.has(id));
  const invalid = [];
  for (const id of citedIds) {
    const row = closureMap.get(id);
    const expectedHash = citedEvidence.get(id);
    const actualHash = text(field(row, "contentHash", "content_hash"));
    const sealed = cutCursorMap.get(cursorKey(row));
    const cursorWithin = Boolean(sealed) &&
      integer(field(row, "sourceCursorVersion", "source_cursor_version"), -1) <=
        integer(field(sealed, "throughCursorVersion", "through_cursor_version"), -1);
    const dimensionsMatch = text(field(row, "workspaceKey", "workspace_key")) === text(field(cut, "workspaceKey", "workspace_key")) &&
      text(field(row, "workspaceKey", "workspace_key")) === text(field(row, "batchWorkspaceKey", "batch_workspace_key")) &&
      text(field(row, "sourceSystem", "source_system")) === text(field(row, "batchSourceSystem", "batch_source_system")) &&
      text(field(row, "connectionKey", "connection_key")) === text(field(row, "batchConnectionKey", "batch_connection_key"));
    const committed = text(field(row, "batchStatus", "batch_status")) === "committed" &&
      integer(field(row, "committedCursorVersion", "committed_cursor_version"), -1) >=
        integer(field(row, "sourceCursorVersion", "source_cursor_version"), -1);
    if (!row || !HASH_RE.test(expectedHash) || actualHash !== expectedHash ||
        field(row, "withinCut", "within_cut") !== true || !cursorWithin || !dimensionsMatch || !committed) {
      invalid.push(id);
    }
  }
  if (missing.length || unrelated.length || invalid.length || new Set(closureIds).size !== closureRows.length) {
    add({
      stage: "source_cut",
      classification: "source_cut_evidence_closure_mismatch",
      subjectType: "source_cut",
      subjectKey: targetId,
      evidenceIds: [targetId, ...citedIds, ...closureIds],
      evidenceObservationIds: sortedUnique([...citedIds, ...closureIds]),
      detail: { citedCount: citedIds.length, closureCount: closureRows.length, missing, unrelated, invalid },
    });
  }
  return {
    cuts,
    cutCursors,
    cutObservations,
    partitionWitnesses,
    evidenceObservations,
    targetId,
    cut,
  };
}

function envelopeMap(canonical) {
  const output = new Map();
  for (const envelope of rows(canonical, "inputEnvelopes")) {
    output.set(`${text(field(envelope, "itemKind", "item_kind"))}:${text(field(envelope, "itemId", "item_id"))}`, envelope);
  }
  const specs = [
    ["acceptedClaimEnvelopes", "accepted_claim", ["claimVersionId", "claim_version_id"]],
    ["entityLinkEnvelopes", "entity_link", ["linkVersionId", "link_version_id"]],
    ["workgroupMembershipEnvelopes", "workgroup_membership", ["membershipVersionId", "membership_version_id"]],
    ["shipmentMetadataEnvelopes", "shipment_metadata", ["metadataVersionId", "metadata_version_id"]],
  ];
  for (const [collection, kind, idNames] of specs) {
    for (const envelope of rows(canonical, collection)) {
      output.set(`${kind}:${text(field(envelope, ...idNames))}`, envelope);
    }
  }
  return output;
}

function buildVersionVector(build) {
  return {
    extractorSetVersion: text(field(build, "extractorSetVersion", "extractor_set_version")),
    linkerVersion: text(field(build, "linkerVersion", "linker_version")),
    reducerVersion: text(field(build, "reducerVersion", "reducer_version")),
    packetBuilderVersion: text(field(build, "packetBuilderVersion", "packet_builder_version")),
    packetSchemaVersion: text(field(build, "packetSchemaVersion", "packet_schema_version")),
    precedencePolicyVersion: text(field(build, "precedencePolicyVersion", "precedence_policy_version")),
    precedencePolicyHash: text(field(build, "precedencePolicyHash", "precedence_policy_hash")),
  };
}

function buildInputVersionVector(build) {
  return {
    reducerVersion: text(field(build, "reducerVersion", "reducer_version")),
    packetBuilderVersion: text(field(build, "packetBuilderVersion", "packet_builder_version")),
    packetSchemaVersion: text(field(build, "packetSchemaVersion", "packet_schema_version")),
    precedencePolicyVersion: text(field(build, "precedencePolicyVersion", "precedence_policy_version")),
    precedencePolicyHash: text(field(build, "precedencePolicyHash", "precedence_policy_hash")),
  };
}

function orderedBuildInputManifest(buildInputs, kind) {
  return buildInputs
    .filter((input) => text(field(input, "itemKind", "item_kind")) === kind)
    .sort((left, right) => {
      const ordinalDifference = integer(field(left, "ordinal"), -1) - integer(field(right, "ordinal"), -1);
      if (ordinalDifference !== 0) return ordinalDifference;
      return text(field(left, "itemId", "item_id"))
        .localeCompare(text(field(right, "itemId", "item_id")));
    })
    .map((input) => ({
      itemId: text(field(input, "itemId", "item_id")),
      itemHash: text(field(input, "itemHash", "item_hash")),
    }));
}

function buildWorkgroupDefinitionManifest(canonical, membershipManifest, envelopes) {
  const workgroupIds = sortedUnique(membershipManifest.map((item) =>
    text(field(envelopes.get(`workgroup_membership:${item.itemId}`), "workgroupId", "workgroup_id"))));
  const definitions = new Map(rows(canonical, "workgroupDefinitionEnvelopes")
    .map((envelope) => [text(field(envelope, "workgroupId", "workgroup_id")), envelope]));
  return workgroupIds.filter(Boolean).map((workgroupId) => ({
    workgroupId,
    definitionHash: text(field(definitions.get(workgroupId), "definitionHash", "definition_hash")),
  }));
}

function auditBuilds({ canonical, cutIndex, add, digest }) {
  const builds = rows(canonical, "builds", "truthBuilds");
  const inputs = rows(canonical, "buildInputs", "truthBuildInputs");
  const envelopes = envelopeMap(canonical);
  const targetBuilds = builds.filter((build) => sourceCutId(build) === cutIndex.targetId);
  if (!targetBuilds.length) {
    add({
      stage: "build_inputs",
      classification: "source_cut_build_missing",
      subjectType: "source_cut",
      subjectKey: cutIndex.targetId,
      evidenceIds: [cutIndex.targetId],
      detail: {},
    });
    return { builds, inputs, targetBuilds };
  }

  for (const build of targetBuilds) {
    const id = buildId(build);
    const status = text(field(build, "status"));
    if (status !== "succeeded") {
      add({
        stage: "build_inputs",
        severity: status === "failed" ? "blocking" : "attention",
        classification: "truth_build_not_succeeded",
        subjectType: "truth_build",
        subjectKey: id,
        evidenceIds: [id, cutIndex.targetId],
        detail: { status, errorCode: text(field(build, "errorCode", "error_code")) },
      });
      continue;
    }
    const buildInputs = inputs.filter((input) => buildId(input) === id);
    for (const input of buildInputs) {
      const kind = text(field(input, "itemKind", "item_kind"));
      const itemId = text(field(input, "itemId", "item_id"));
      const itemHash = text(field(input, "itemHash", "item_hash"));
      const envelope = envelopes.get(`${kind}:${itemId}`);
      const envelopeHash = text(field(envelope, "envelopeHash", "envelope_hash"));
      const computedEnvelopeHash = kind === "shipment_metadata" && envelope
        ? digest(postgresJsonbText(field(envelope, "canonicalEnvelope", "canonical_envelope") || {}))
        : envelopeHash;
      if (!envelope || itemHash !== envelopeHash || computedEnvelopeHash !== envelopeHash) {
        add({
          stage: "build_inputs",
          classification: "build_input_envelope_hash_mismatch",
          subjectType: kind || "build_input",
          subjectKey: itemId,
          evidenceIds: [id, itemId, itemHash, envelopeHash, computedEnvelopeHash],
          detail: { buildId: id, itemKind: kind, itemHash, envelopeHash, computedEnvelopeHash },
        });
      }
    }

    const kinds = [
      ["accepted_claim", "claimManifestHash", "claim_manifest_hash"],
      ["entity_link", "linkManifestHash", "link_manifest_hash"],
      ["workgroup_membership", "workgroupManifestHash", "workgroup_manifest_hash"],
      ["shipment_metadata", "shipmentMetadataManifestHash", "shipment_metadata_manifest_hash"],
    ];
    const computed = {};
    const manifests = {};
    for (const [kind, camel, snake] of kinds) {
      const manifest = orderedBuildInputManifest(buildInputs, kind);
      manifests[kind] = manifest;
      const computedHash = digest(postgresJsonbText(manifest));
      const storedHash = text(field(build, camel, snake));
      computed[camel] = computedHash;
      if (computedHash !== storedHash) {
        add({
          stage: "build_inputs",
          classification: "build_manifest_hash_mismatch",
          subjectType: "truth_build",
          subjectKey: id,
          evidenceIds: [id, storedHash, ...manifest.map((item) => item.itemId)],
          detail: { manifestKind: kind, storedHash, computedHash },
        });
      }
    }
    const cut = cutIndex.cut;
    if (cut) {
      const workgroupDefinitions = buildWorkgroupDefinitionManifest(
        canonical,
        manifests.workgroup_membership,
        envelopes,
      );
      const inputManifestV2 = {
        schemaVersion: "truth-build-input-manifest-v2",
        workspaceKey: text(field(build, "workspaceKey", "workspace_key")),
        sourceCutId: cutIndex.targetId,
        sourceManifestHash: text(field(cut, "manifestHash", "manifest_hash")),
        claims: manifests.accepted_claim,
        entityLinks: manifests.entity_link,
        workgroupMemberships: manifests.workgroup_membership,
        workgroupDefinitions,
        extractorSetVersion: text(field(build, "extractorSetVersion", "extractor_set_version")),
        linkerSetVersion: text(field(build, "linkerVersion", "linker_version")),
        versions: buildInputVersionVector(build),
      };
      const inputManifestV3 = {
        ...inputManifestV2,
        schemaVersion: "truth-build-input-manifest-v3",
        shipmentMetadata: manifests.shipment_metadata,
        shipmentMetadataManifestHash: computed.shipmentMetadataManifestHash,
      };
      const computedInputManifestHash = digest(postgresJsonbText(inputManifestV3));
      const compatibleV2Hash = digest(postgresJsonbText(inputManifestV2));
      const storedInputManifestHash = text(field(build, "inputManifestHash", "input_manifest_hash"));
      const legacyV2Compatible = manifests.shipment_metadata.length === 0 &&
        compatibleV2Hash === storedInputManifestHash;
      if (computedInputManifestHash !== storedInputManifestHash && !legacyV2Compatible) {
        add({
          stage: "build_inputs",
          classification: "build_input_manifest_hash_mismatch",
          subjectType: "truth_build",
          subjectKey: id,
          evidenceIds: [id, storedInputManifestHash, cutIndex.targetId],
          detail: {
            storedInputManifestHash,
            computedInputManifestHash,
            compatibleV2Hash,
            legacyV2Compatible,
          },
        });
      }
    }
  }

  const succeeded = targetBuilds.filter((build) => text(field(build, "status")) === "succeeded");
  const parityGroups = new Map();
  for (const build of succeeded) {
    const versions = buildVersionVector(build);
    const key = [sourceCutId(build), text(field(build, "channel")), ...Object.values(versions)].join(":");
    if (!parityGroups.has(key)) parityGroups.set(key, []);
    parityGroups.get(key).push(build);
  }
  for (const [key, group] of [...parityGroups.entries()].sort()) {
    const full = group.filter((build) => text(field(build, "buildMode", "build_mode")) === "full");
    const incremental = group.filter((build) => text(field(build, "buildMode", "build_mode")) === "incremental");
    if (!full.length || !incremental.length) {
      add({
        stage: "build_parity",
        severity: "attention",
        classification: "build_parity_witness_missing",
        subjectType: "build_parity_group",
        subjectKey: key,
        evidenceIds: group.map(buildId),
        detail: { fullBuildCount: full.length, incrementalBuildCount: incremental.length },
      });
      continue;
    }
    for (const fullBuild of full) {
      for (const incrementalBuild of incremental) {
        const fullPacketHash = text(field(fullBuild, "packetHash", "packet_hash"));
        const incrementalPacketHash = text(field(incrementalBuild, "packetHash", "packet_hash"));
        const fullSemanticHash = text(field(fullBuild, "semanticHash", "semantic_hash"));
        const incrementalSemanticHash = text(field(incrementalBuild, "semanticHash", "semantic_hash"));
        if (fullPacketHash !== incrementalPacketHash || fullSemanticHash !== incrementalSemanticHash) {
          add({
            stage: "build_parity",
            classification: "build_parity_mismatch",
            subjectType: "build_pair",
            subjectKey: `${buildId(fullBuild)}:${buildId(incrementalBuild)}`,
            evidenceIds: [buildId(fullBuild), buildId(incrementalBuild), fullPacketHash, incrementalPacketHash],
            detail: { fullPacketHash, incrementalPacketHash, fullSemanticHash, incrementalSemanticHash },
          });
        }
      }
    }
  }
  return { builds, inputs, targetBuilds };
}

function auditProcessingWatermarkContinuity({ canonical, production, add }) {
  const continuity = field(canonical, "processingWatermarkContinuity", "processing_watermark_continuity");
  if (!isPlainObject(continuity) ||
      text(field(continuity, "schemaVersion", "schema_version")) !==
        "truth-processing-watermark-continuity-v1") {
    add({
      stage: "build_inputs",
      classification: "processing_watermark_continuity_missing",
      subjectType: "processing_watermark",
      subjectKey: "current-source-cut",
      evidenceIds: [],
      detail: {},
    });
    return;
  }
  const validWatermarkedIdentity = (row, statusName = "processingWatermarkStatus", hashName = "processingWatermarkHash") => (
    text(field(row, statusName)) === "watermarked" && HASH_RE.test(text(field(row, hashName)))
  );
  for (const pair of rows(continuity, "buildPairs", "build_pairs")) {
    const pairId = text(field(pair, "buildPairId", "build_pair_id"));
    const pairHash = text(field(pair, "processingWatermarkHash", "processing_watermark_hash"));
    const full = field(pair, "fullBuild", "full_build") || {};
    const incremental = field(pair, "incrementalBuild", "incremental_build") || {};
    const parity = field(pair, "parity") || {};
    const consistent = text(field(pair, "continuityStatus", "continuity_status")) === "consistent" &&
      validWatermarkedIdentity(pair) && validWatermarkedIdentity(full) &&
      validWatermarkedIdentity(incremental) && field(parity, "present") === true &&
      validWatermarkedIdentity(parity) &&
      [full, incremental, parity].every((row) => (
        text(field(row, "processingWatermarkHash")) === pairHash
      ));
    if (!consistent) {
      add({
        stage: "build_parity",
        classification: "build_processing_watermark_uncertified",
        subjectType: "build_pair",
        subjectKey: pairId,
        evidenceIds: [pairId, pairHash],
        detail: {
          continuityStatus: text(field(pair, "continuityStatus", "continuity_status")),
          processingWatermarkStatus: text(field(pair, "processingWatermarkStatus")),
        },
      });
    }
  }
  let headPublication = null;
  for (const publication of rows(continuity, "publications")) {
    const publicationIdValue = text(field(publication, "publicationId", "publication_id"));
    const publicationHash = text(field(publication, "processingWatermarkHash"));
    const consistent = text(field(publication, "continuityStatus", "continuity_status")) === "consistent" &&
      validWatermarkedIdentity(publication) &&
      text(field(publication, "buildProcessingWatermarkStatus")) === "watermarked" &&
      text(field(publication, "payloadProcessingWatermarkStatus")) === "watermarked" &&
      text(field(publication, "buildProcessingWatermarkHash")) === publicationHash &&
      text(field(publication, "payloadProcessingWatermarkHash")) === publicationHash &&
      (field(publication, "isHead") !== true || (
        text(field(publication, "headProcessingWatermarkStatus")) === "watermarked" &&
        text(field(publication, "headProcessingWatermarkHash")) === publicationHash
      ));
    if (!consistent) {
      add({
        stage: "publication",
        classification: "publication_processing_watermark_uncertified",
        subjectType: "truth_publication",
        subjectKey: publicationIdValue,
        evidenceIds: [publicationIdValue, publicationHash],
        detail: {
          continuityStatus: text(field(publication, "continuityStatus", "continuity_status")),
          processingWatermarkStatus: text(field(publication, "processingWatermarkStatus")),
        },
      });
    }
    if (field(publication, "isHead") === true &&
        text(field(publication, "channel")) === "production") {
      headPublication = publication;
    }
  }
  if (field(continuity, "complete") !== true) {
    add({
      stage: "publication",
      classification: "processing_watermark_continuity_incomplete",
      subjectType: "processing_watermark",
      subjectKey: text(field(continuity, "sourceCutId", "source_cut_id")),
      evidenceIds: [],
      detail: {
        mismatchCount: integer(field(continuity, "mismatchCount", "mismatch_count"), 0),
        legacyUnwatermarkedPairCount: integer(
          field(continuity, "legacyUnwatermarkedPairCount", "legacy_unwatermarked_pair_count"),
          0,
        ),
      },
    });
  }
  const productionSnapshot = field(production, "snapshot", "apiSnapshot", "api_snapshot", "payload");
  const witnessMode = text(field(production, "witnessMode", "witness_mode"));
  if (witnessMode === "legacy-shadow") {
    if (text(field(productionSnapshot, "processingWatermarkStatus")) !== "legacy_unwatermarked") {
      add({
        stage: "production",
        classification: "legacy_production_processing_watermark_status_missing",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [],
        detail: {},
      });
    } else {
      add({
        stage: "production",
        severity: "attention",
        classification: "legacy_production_unwatermarked",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [],
        detail: { certifiedAgreement: false },
      });
    }
  } else if (witnessMode === "relational-legacy") {
    if (text(field(productionSnapshot, "processingWatermarkStatus")) !== "legacy_unwatermarked" ||
        field(productionSnapshot, "processingWatermarkHash") !== null) {
      add({
        stage: "production",
        classification: "relational_legacy_processing_watermark_status_invalid",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [],
        detail: {},
      });
    } else {
      add({
        stage: "production",
        severity: "attention",
        classification: "relational_production_legacy_unwatermarked",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [],
        detail: { certifiedAgreement: false },
      });
    }
  } else if (witnessMode === "relational" && headPublication) {
    const expectedHash = text(field(headPublication, "processingWatermarkHash"));
    if (text(field(productionSnapshot, "processingWatermarkStatus")) !== "watermarked" ||
        text(field(productionSnapshot, "processingWatermarkHash")) !== expectedHash) {
      add({
        stage: "production",
        classification: "production_processing_watermark_mismatch",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [expectedHash, text(field(productionSnapshot, "processingWatermarkHash"))],
        detail: {},
      });
    }
  }
}

function snapshotPayload(row) {
  return field(row, "payload", "snapshot", "apiSnapshot", "api_snapshot") || null;
}

function publicationPayloadId(row) {
  return text(field(row, "publicationId", "publication_id"));
}

function semanticToken(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeLifecycle(value) {
  const token = semanticToken(value) || "unknown";
  const aliases = {
    prearrival: "pre_arrival",
    intransit: "in_transit",
    airport_picked_up: "picked_up",
    pickup_complete: "picked_up",
    pickup_completed: "picked_up",
    delivery_complete: "delivered",
    delivery_completed: "delivered",
    proof_of_delivery_received: "pod_received",
    closed: "pod_received",
  };
  return aliases[token] || token;
}

function normalizeGateStatus(value) {
  if (value === true) return "done";
  if (value === false || value === null || value === undefined) return "unknown";
  const token = semanticToken(value);
  if ([
    "true", "done", "complete", "completed", "released", "cleared", "paid",
    "received", "found", "picked_up", "loaded", "recovered", "delivered",
    "settled", "confirmed", "passed",
  ].includes(token)) return "done";
  if ([
    "blocked", "hold", "customs_hold", "exam_hold", "exception", "problem",
    "incomplete", "partial", "due", "unpaid",
  ].includes(token)) return "blocked";
  if (["contradicted", "conflict", "conflicted", "disputed"].includes(token)) {
    return "contradicted";
  }
  return "unknown";
}

function exactAwb(value) {
  const raw = text(value);
  if (!raw || !/^[0-9\s-]+$/.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function rowAwbIdentity(row) {
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const groups = [
    [field(row, "awb")],
    field(row, "awbs"),
    field(packet, "awbs"),
    [field(row, "shipmentId", "shipment_id", "normalizedAwb", "normalized_awb")],
    [field(packet, "shipmentId", "shipment_id")],
    [field(row, "id")],
  ];
  let rawValues = [];
  for (const group of groups) {
    const values = (Array.isArray(group) ? group : [])
      .map((value) => text(value))
      .filter(Boolean);
    if (values.length) {
      rawValues = sortedUnique(values);
      break;
    }
  }
  const normalized = rawValues.map(exactAwb);
  const unique = sortedUnique(normalized);
  if (!rawValues.length) return { awb: "", rawValues, reason: "missing" };
  if (normalized.some((value) => !value)) return { awb: "", rawValues, reason: "malformed" };
  if (unique.length !== 1) return { awb: "", rawValues, reason: "ambiguous" };
  return { awb: unique[0], rawValues, reason: "" };
}

function gateForShipment(row, gateName) {
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const packetGates = field(packet, "gates");
  if (Array.isArray(packetGates)) {
    const match = packetGates.find((gate) =>
      semanticToken(field(gate, "gate", "name")) === gateName);
    if (match) return match;
  } else if (isPlainObject(packetGates) && isPlainObject(packetGates[gateName])) {
    return packetGates[gateName];
  }
  const opsGates = field(field(row, "opsState", "ops_state") || {}, "gates");
  if (isPlainObject(opsGates) && isPlainObject(opsGates[gateName])) return opsGates[gateName];
  const canonicalGates = field(field(row, "canonicalState", "canonical_state") || {}, "gates");
  if (isPlainObject(canonicalGates) && isPlainObject(canonicalGates[gateName])) {
    return canonicalGates[gateName];
  }
  return {};
}

function structuredActiveKinds(items, fields) {
  const kinds = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const status = semanticToken(field(item, "status", "state"));
    if (["resolved", "inactive", "closed", "clear", "cleared", "dismissed"].includes(status)) continue;
    const kind = fields.map((name) => semanticToken(field(item, name))).find(Boolean) || "unspecified";
    kinds.push(kind);
  }
  return sortedUnique(kinds);
}

function shipmentSemantics(row, snapshot, awb) {
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const gates = Object.fromEntries(GATE_ORDER.map((gateName) => {
    const gate = gateForShipment(row, gateName);
    const raw = field(gate, "rawStatus", "raw_status") || field(gate, "status", "value");
    return [gateName, normalizeGateStatus(raw)];
  }));
  const completedIndex = new Set((Array.isArray(field(snapshot, "completedAwbs", "completed_awbs"))
    ? field(snapshot, "completedAwbs", "completed_awbs") : []).map(exactAwb).filter(Boolean));
  const activeIndex = new Set((Array.isArray(field(snapshot, "activeAwbs", "active_awbs"))
    ? field(snapshot, "activeAwbs", "active_awbs") : []).map(exactAwb).filter(Boolean));
  const role = semanticToken(field(row, "truthPacketRole", "truth_packet_role", "role"));
  const completed = field(row, "completed") === true || role === "completed" || completedIndex.has(awb);
  const lifecycle = normalizeLifecycle(
    field(field(packet, "physicalLifecycle", "physical_lifecycle") || {}, "status") ||
    field(packet, "resolvedCurrentState", "resolved_current_state", "currentState", "current_state") ||
    field(row, "currentState", "current_state") ||
    field(field(row, "opsState", "ops_state") || {}, "phase") ||
    field(row, "stage", "phase", "status"),
  );
  const deliveryStatus = semanticToken(field(row, "deliveryStatus", "delivery_status"));
  const deliveredFlag = field(row, "delivered") === true || field(packet, "delivered") === true;
  const delivered = completed || deliveredFlag || gates.delivery === "done" ||
    ["delivered", "complete", "completed", "done"].includes(deliveryStatus) ||
    ["delivered", "pod_received"].includes(lifecycle);
  const podStatus = semanticToken(
    field(row, "podStatus", "pod_status") || field(packet, "podStatus", "pod_status"),
  );
  const podFlag = field(row, "podReceived", "pod_received") === true ||
    field(packet, "podReceived", "pod_received") === true;
  const pod = completed || podFlag || gates.pod === "done" || lifecycle === "pod_received" ||
    ["received", "done", "complete", "completed"].includes(podStatus);
  const contradictions = Array.isArray(field(packet, "contradictions"))
    ? field(packet, "contradictions")
    : field(row, "contradictions");
  const contradictionKinds = structuredActiveKinds(contradictions, ["gate", "type", "category", "code"]);
  const blockerKinds = [];
  const blocker = field(packet, "operationalBlocker", "operational_blocker") ||
    field(row, "operationalBlocker", "operational_blocker") || {};
  const blockerType = semanticToken(field(blocker, "type", "kind", "code"));
  const blockerStatus = semanticToken(field(blocker, "status", "state"));
  if (blockerType && blockerType !== "none" && !["clear", "cleared", "resolved", "inactive"].includes(blockerStatus)) {
    blockerKinds.push(blockerType);
  }
  const exceptions = Array.isArray(field(packet, "exceptions"))
    ? field(packet, "exceptions")
    : field(row, "exceptions");
  blockerKinds.push(...structuredActiveKinds(exceptions, ["type", "predicate", "gate", "code"]));
  const documentBlocker = field(packet, "documentRequestBlocker", "document_request_blocker") || {};
  const documentStatus = semanticToken(field(documentBlocker, "status", "state"));
  const documentType = semanticToken(field(documentBlocker, "type", "kind"));
  if (documentType && documentType !== "none" && !["clear", "cleared", "resolved", "inactive"].includes(documentStatus)) {
    blockerKinds.push(documentType);
  }
  return canonicalUnordered({
    lifecycle,
    gates,
    active: activeIndex.has(awb) || (!completed && role !== "completed"),
    completed,
    delivered,
    pod,
    contradictionKinds,
    blockerKinds: sortedUnique(blockerKinds),
  });
}

function semanticInventory(snapshot) {
  return sharedSemanticInventory(snapshot);
}

function currentTmsInventory(source, cutIndex) {
  const targetId = text(cutIndex?.targetId);
  const cutCursors = (cutIndex?.cutCursors || []).filter((cursor) => (
    sourceCutId(cursor) === targetId
      && semanticToken(field(cursor, "sourceSystem", "source_system")) === "tms"
  ));
  const cursorMap = new Map(cutCursors.map((cursor) => [cursorKey(cursor), cursor]));
  const observations = rows(source, "observations", "sourceObservations")
    .filter((observation) => {
      if (semanticToken(field(observation, "sourceSystem", "source_system")) !== "tms"
        || text(field(observation, "sourceObjectType", "source_object_type")) !== "tms_shipment_snapshot"
        || text(field(observation, "operation")) !== "content") return false;
      const cursor = cursorMap.get(cursorKey(observation));
      if (!cursor) return false;
      const observationVersion = integer(field(
        observation,
        "sourceCursorVersion",
        "source_cursor_version",
      ), -1);
      const throughVersion = integer(field(
        cursor,
        "throughCursorVersion",
        "through_cursor_version",
      ), -1);
      const throughValue = text(field(cursor, "throughCursorValue", "through_cursor_value"));
      const payload = field(observation, "normalizedPayload", "normalized_payload") || {};
      return observationVersion >= 0
        && observationVersion <= throughVersion
        && text(field(payload, "snapshotTime", "snapshot_time")) === throughValue;
    });
  const map = new Map();
  const malformed = [];
  const duplicates = [];
  for (const observation of observations) {
    const id = observationId(observation);
    const payload = field(observation, "normalizedPayload", "normalized_payload") || {};
    const shipment = field(payload, "shipment") || {};
    const rawAwb = text(field(shipment, "trackingNumber", "tracking_number"));
    const awb = exactAwb(rawAwb);
    const shipmentGuid = text(field(shipment, "shipmentGuid", "shipment_guid")).toLowerCase();
    const sourceObjectId = text(field(observation, "sourceObjectId", "source_object_id")).toLowerCase();
    if (!awb
      || text(field(payload, "schemaVersion", "schema_version")) !== "tms-shipment-source-observation-v1"
      || !shipmentGuid
      || shipmentGuid !== sourceObjectId) {
      malformed.push({
        observationId: id,
        rawAwb,
        reason: !awb ? "malformed_awb" : "invalid_tms_observation_identity",
      });
      continue;
    }
    if (map.has(awb)) {
      const prior = map.get(awb);
      duplicates.push({
        awb,
        observationIds: sortedUnique([prior.observationId, id]),
      });
      continue;
    }
    map.set(awb, {
      awb,
      observationId: id,
      sourceObjectId,
      snapshotTime: text(field(payload, "snapshotTime", "snapshot_time")),
    });
  }
  return { map, malformed, duplicates, observationCount: observations.length };
}

function auditTmsInventoryAgainstCanonical({ source, cutIndex, deliveryPayload, payloadIntegrity, add, headEvidence }) {
  const inventory = currentTmsInventory(source, cutIndex);
  for (const item of inventory.malformed) {
    add({
      stage: "source_cut",
      classification: "tms_inventory_awb_malformed",
      subjectType: "tms_shipment_observation",
      subjectKey: item.observationId || "unresolved",
      evidenceIds: [cutIndex.targetId, item.observationId, item.rawAwb],
      evidenceObservationIds: [item.observationId],
      detail: item,
    });
  }
  for (const item of inventory.duplicates) {
    add({
      stage: "source_cut",
      classification: "tms_inventory_awb_duplicate",
      subjectType: "shipment",
      subjectKey: item.awb,
      evidenceIds: [cutIndex.targetId, `shipment:${item.awb}`, ...item.observationIds],
      evidenceObservationIds: item.observationIds,
      detail: item,
    });
  }
  let missingFromCanonical = 0;
  if (payloadIntegrity && isPlainObject(deliveryPayload)) {
    const canonicalInventory = semanticInventory(deliveryPayload);
    for (const [awb, item] of inventory.map) {
      if (canonicalInventory.map.has(awb)) continue;
      missingFromCanonical += 1;
      add({
        stage: "publication",
        classification: "tms_inventory_shipment_missing_from_canonical",
        subjectType: "shipment",
        subjectKey: awb,
        evidenceIds: [
          ...headEvidence,
          cutIndex.targetId,
          `shipment:${awb}`,
          item.observationId,
        ],
        evidenceObservationIds: [item.observationId],
        detail: {
          awb,
          sourceSnapshotTime: item.snapshotTime,
          sourceObservationId: item.observationId,
        },
      });
    }
  }
  return {
    shipmentCount: inventory.map.size,
    missingFromCanonical,
    malformedAwbs: inventory.malformed.length,
    duplicateAwbs: inventory.duplicates.length,
  };
}

function compareShipmentSemantics(expected, actual) {
  const mismatches = [];
  for (const key of [
    "lifecycle",
    "active",
    "completed",
    "delivered",
    "pod",
    "contradictionKinds",
    "blockerKinds",
    "controlRoomMetadata",
  ]) {
    if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) mismatches.push(key);
  }
  for (const gateName of GATE_ORDER) {
    if (expected.gates[gateName] !== actual.gates[gateName]) mismatches.push(`gates.${gateName}`);
  }
  return mismatches;
}

function sourceVerifiedCompactCache(payload) {
  return isPlainObject(payload)
    && text(field(payload, "cacheWitnessMode", "cache_witness_mode"))
      === "source-verified-compact-v1"
    && field(
      payload,
      "payloadHashVerifiedAtSource",
      "payload_hash_verified_at_source",
    ) === true;
}

function auditPublication({ source, canonical, buildIndex, cutIndex, production, add, digest }) {
  const publications = rows(canonical, "publications", "truthPublications");
  const heads = rows(canonical, "publicationHeads", "truthPublicationHeads");
  const payloads = rows(canonical, "publicationPayloads", "truthPublicationPayloads");
  const snapshots = rows(canonical, "cacheSnapshots", "snapshots", "appSnapshots");
  const metadata = rows(canonical, "cacheMetadata", "snapshotMetadata", "appSnapshotMetadata");
  const publicationMap = new Map(publications.map((row) => [publicationId(row), row]));
  const buildMap = new Map(buildIndex.builds.map((row) => [buildId(row), row]));
  const productionSnapshot = field(production, "snapshot", "apiSnapshot", "api_snapshot", "payload");
  const suppliedWitnessMode = text(field(production, "witnessMode", "witness_mode"));
  const relationalIdentityPresent = isPlainObject(productionSnapshot) && Boolean(
    publicationId(productionSnapshot) || integer(field(productionSnapshot, "publicationVersion", "publication_version"), 0) > 0,
  );
  const witnessMode = suppliedWitnessMode || (relationalIdentityPresent ? "relational" : "legacy-shadow");
  const selectedChannel = witnessMode === "legacy-shadow" ? "shadow" : "production";
  const selectedHeads = heads.filter((row) => text(field(row, "channel")) === selectedChannel);
  const emptySummary = {
    mode: witnessMode,
    channel: selectedChannel,
    expectedShipments: 0,
    productionShipments: 0,
    matchedShipments: 0,
    missingShipments: 0,
    unexpectedShipments: 0,
    semanticMismatches: 0,
    malformedAwbs: 0,
    duplicateAwbs: 0,
    tmsInventoryShipments: 0,
    tmsInventoryMissingFromCanonical: 0,
    tmsInventoryMalformedAwbs: 0,
    tmsInventoryDuplicateAwbs: 0,
  };
  if (!isPlainObject(productionSnapshot)) {
    add({
      stage: "production",
      classification: "production_witness_missing",
      subjectType: "production_api",
      subjectKey: "shipment-truth-packets",
      evidenceIds: [],
      detail: { witnessMode },
    });
  }
  if (!["legacy-shadow", "relational", "relational-legacy"].includes(witnessMode)) {
    add({
      stage: "production",
      classification: "production_witness_mode_invalid",
      subjectType: "production_api",
      subjectKey: "shipment-truth-packets",
      evidenceIds: [],
      detail: { witnessMode },
    });
  }
  if (selectedHeads.length !== 1) {
    add({
      stage: "publication",
      classification: "current_publication_head_missing_or_ambiguous",
      subjectType: "publication_head",
      subjectKey: selectedChannel,
      evidenceIds: selectedHeads.map(publicationId),
      detail: { channel: selectedChannel, count: selectedHeads.length, witnessMode },
    });
    return {
      publications,
      heads,
      payloads,
      snapshots,
      metadata,
      head: selectedHeads[0] || null,
      publication: null,
      productionComparison: emptySummary,
    };
  }
  const head = selectedHeads[0];
  const headPublication = publicationMap.get(publicationId(head));
  const headEvidence = [
    publicationId(head),
    sourceCutId(head),
    text(field(head, "packetHash", "packet_hash")),
    text(field(head, "deliveryPayloadHash", "delivery_payload_hash")),
  ];
  if (!headPublication ||
      text(field(headPublication, "channel")) !== selectedChannel ||
      integer(field(headPublication, "publicationVersion", "publication_version"), -1) !== integer(field(head, "publicationVersion", "publication_version"), -2) ||
      text(field(headPublication, "packetHash", "packet_hash")) !== text(field(head, "packetHash", "packet_hash")) ||
      text(field(headPublication, "deliveryPayloadHash", "delivery_payload_hash")) !== text(field(head, "deliveryPayloadHash", "delivery_payload_hash")) ||
      sourceCutId(headPublication) !== sourceCutId(head)) {
    add({
      stage: "publication",
      classification: "publication_head_row_mismatch",
      subjectType: "publication_head",
      subjectKey: publicationId(head),
      evidenceIds: headEvidence,
      detail: {},
    });
  }

  if (headPublication) {
    const build = buildMap.get(buildId(headPublication));
    if (!build || text(field(build, "status")) !== "succeeded" ||
        text(field(build, "packetHash", "packet_hash")) !== text(field(headPublication, "packetHash", "packet_hash")) ||
        sourceCutId(build) !== sourceCutId(headPublication)) {
      add({
        stage: "publication",
        classification: "publication_build_mismatch",
        subjectType: "truth_publication",
        subjectKey: publicationId(headPublication),
        evidenceIds: [publicationId(headPublication), buildId(headPublication), ...headEvidence],
        detail: {},
      });
    }
  }
  if (sourceCutId(head) !== cutIndex.targetId) {
    add({
      stage: "publication",
      classification: "publication_head_source_cut_mismatch",
      subjectType: "publication_head",
      subjectKey: publicationId(head),
      evidenceIds: [publicationId(head), sourceCutId(head), cutIndex.targetId],
      detail: { headSourceCutId: sourceCutId(head), currentSourceCutId: cutIndex.targetId },
    });
  }

  const selectedPayloads = payloads.filter((row) =>
    text(field(row, "channel")) === selectedChannel && publicationPayloadId(row) === publicationId(head));
  let deliveryPayload = null;
  let payloadIntegrity = false;
  if (selectedPayloads.length !== 1) {
    add({
      stage: "publication",
      classification: "publication_head_payload_missing_or_ambiguous",
      subjectType: "truth_publication_payload",
      subjectKey: publicationId(head),
      evidenceIds: [...headEvidence, ...selectedPayloads.map(publicationPayloadId)],
      detail: { channel: selectedChannel, count: selectedPayloads.length },
    });
  } else {
    const payloadRow = selectedPayloads[0];
    deliveryPayload = field(payloadRow, "deliveryPayload", "delivery_payload");
    const activePayload = field(payloadRow, "activeIndexPayload", "active_index_payload");
    const deliveryHash = text(field(head, "deliveryPayloadHash", "delivery_payload_hash"));
    const activeHash = text(field(payloadRow, "activeIndexHash", "active_index_hash"));
    const deliveryPreimage = isPlainObject(deliveryPayload) ? { ...deliveryPayload } : {};
    delete deliveryPreimage.deliveryPayloadHash;
    delete deliveryPreimage.contentSignature;
    const activePreimage = isPlainObject(activePayload) ? { ...activePayload } : {};
    delete activePreimage.contentSignature;
    const recomputedDeliveryHash = isPlainObject(deliveryPayload)
      ? digest(postgresJsonbText(deliveryPreimage)) : "";
    const recomputedActiveHash = isPlainObject(activePayload)
      ? digest(postgresJsonbText(activePreimage)) : "";
    payloadIntegrity = isPlainObject(deliveryPayload) && isPlainObject(activePayload) &&
      text(field(payloadRow, "workspaceKey", "workspace_key")) === text(field(head, "workspaceKey", "workspace_key")) &&
      integer(field(payloadRow, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      sourceCutId(payloadRow) === sourceCutId(head) &&
      text(field(payloadRow, "packetHash", "packet_hash")) === text(field(head, "packetHash", "packet_hash")) &&
      text(field(payloadRow, "deliveryPayloadHash", "delivery_payload_hash")) === deliveryHash &&
      text(field(payloadRow, "deliveryCanonicalText", "delivery_canonical_text")) === postgresJsonbText(deliveryPayload) &&
      recomputedDeliveryHash === deliveryHash &&
      text(field(deliveryPayload, "deliveryPayloadHash", "delivery_payload_hash")) === deliveryHash &&
      text(field(deliveryPayload, "contentSignature", "content_signature")) === deliveryHash &&
      publicationId(deliveryPayload) === publicationId(head) &&
      integer(field(deliveryPayload, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      text(field(deliveryPayload, "publicationChannel", "publication_channel")) === selectedChannel &&
      sourceCutId(deliveryPayload) === sourceCutId(head) &&
      text(field(deliveryPayload, "packetHash", "packet_hash")) === text(field(head, "packetHash", "packet_hash")) &&
      recomputedActiveHash === activeHash &&
      text(field(activePayload, "contentSignature", "content_signature")) === activeHash &&
      publicationId(activePayload) === publicationId(head) &&
      integer(field(activePayload, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      sourceCutId(activePayload) === sourceCutId(head) &&
      text(field(activePayload, "truthPacketContentSignature", "truth_packet_content_signature")) === deliveryHash;
    if (!payloadIntegrity) {
      add({
        stage: "publication",
        classification: "publication_payload_integrity_mismatch",
        subjectType: "truth_publication_payload",
        subjectKey: publicationId(head),
        evidenceIds: [...headEvidence, activeHash],
        detail: {
          channel: selectedChannel,
          recomputedDeliveryHash,
          storedDeliveryHash: deliveryHash,
          recomputedActiveHash,
          storedActiveHash: activeHash,
        },
      });
    }
  }

  const truthSnapshot = snapshots.find((row) => text(field(row, "snapshotKey", "snapshot_key")) === "shipment-truth-packets");
  const truthPayload = snapshotPayload(truthSnapshot);
  const truthMetadata = metadata.find((row) => text(field(row, "snapshotKey", "snapshot_key")) === "shipment-truth-packets");
  const deliveryHash = text(field(head, "deliveryPayloadHash", "delivery_payload_hash"));
  const activeSnapshot = snapshots.find((row) => text(field(row, "snapshotKey", "snapshot_key")) === "active-awb-index");
  const activePayload = snapshotPayload(activeSnapshot);
  const activeMetadata = metadata.find((row) => text(field(row, "snapshotKey", "snapshot_key")) === "active-awb-index");

  if (selectedChannel === "shadow") {
    const shadowLeakedToCache = [truthPayload, activePayload].some((payload) =>
      isPlainObject(payload) && (
        publicationId(payload) === publicationId(head) ||
        text(field(payload, "publicationChannel", "publication_channel")) === "shadow"
      ));
    if (shadowLeakedToCache) {
      add({
        stage: "publication",
        classification: "shadow_publication_wrote_legacy_cache",
        subjectType: "app_snapshot",
        subjectKey: publicationId(head),
        evidenceIds: [...headEvidence, "shipment-truth-packets", "active-awb-index"],
        detail: { channel: selectedChannel },
      });
    }
  } else {
    const truthMatches = truthPayload &&
      publicationId(truthPayload) === publicationId(head) &&
      integer(field(truthPayload, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      sourceCutId(truthPayload) === sourceCutId(head) &&
      text(field(truthPayload, "packetHash", "packet_hash")) === text(field(head, "packetHash", "packet_hash")) &&
      text(field(truthPayload, "deliveryPayloadHash", "delivery_payload_hash")) === deliveryHash &&
      text(field(truthPayload, "contentSignature", "content_signature")) === deliveryHash &&
      text(field(truthMetadata, "contentSignature", "content_signature")) === deliveryHash &&
      text(field(truthMetadata, "writerVersion", "writer_version")) ===
        text(field(truthPayload, "writerVersion", "writer_version"));
    if (!truthMatches) {
      add({
        stage: "publication",
        classification: "publication_cache_hash_mismatch",
        subjectType: "app_snapshot",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [publicationId(head), deliveryHash, "shipment-truth-packets"],
        detail: {
          snapshotDeliveryHash: text(field(truthPayload, "deliveryPayloadHash", "delivery_payload_hash")),
          metadataContentSignature: text(field(truthMetadata, "contentSignature", "content_signature")),
          snapshotWriterVersion: text(field(truthPayload, "writerVersion", "writer_version")),
          metadataWriterVersion: text(field(truthMetadata, "writerVersion", "writer_version")),
        },
      });
    } else {
      const sourceVerified = sourceVerifiedCompactCache(truthPayload);
      const preimage = sourceVerified ? null : { ...truthPayload };
      if (preimage) {
        delete preimage.deliveryPayloadHash;
        delete preimage.contentSignature;
      }
      const recomputedDeliveryHash = sourceVerified
        ? deliveryHash : digest(postgresJsonbText(preimage));
      if (!sourceVerified && recomputedDeliveryHash !== deliveryHash) {
        add({
          stage: "publication",
          classification: "publication_delivery_hash_invalid",
          subjectType: "app_snapshot",
          subjectKey: "shipment-truth-packets",
          evidenceIds: [publicationId(head), deliveryHash],
          detail: { recomputedDeliveryHash, deliveryHash },
        });
      }
    }

    const activeSignature = text(field(activePayload, "contentSignature", "content_signature"));
    const activeMatches = activePayload &&
      publicationId(activePayload) === publicationId(head) &&
      integer(field(activePayload, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      sourceCutId(activePayload) === sourceCutId(head) &&
      text(field(activePayload, "truthPacketContentSignature", "truth_packet_content_signature")) === deliveryHash &&
      text(field(activeMetadata, "contentSignature", "content_signature")) === activeSignature &&
      text(field(activeMetadata, "writerVersion", "writer_version")) ===
        text(field(activePayload, "writerVersion", "writer_version"));
    let activeHashValid = false;
    if (activeMatches) {
      if (sourceVerifiedCompactCache(activePayload)) {
        activeHashValid = true;
      } else {
        const preimage = { ...activePayload };
        delete preimage.contentSignature;
        activeHashValid = digest(postgresJsonbText(preimage)) === activeSignature;
      }
    }
    if (!activeMatches || !activeHashValid) {
      add({
        stage: "publication",
        classification: "active_index_publication_mismatch",
        subjectType: "app_snapshot",
        subjectKey: "active-awb-index",
        evidenceIds: [publicationId(head), deliveryHash, activeSignature, "active-awb-index"],
        detail: { activeMatches: Boolean(activeMatches), activeHashValid },
      });
    }
  }

  const summary = { ...emptySummary };
  const tmsComparison = auditTmsInventoryAgainstCanonical({
    source,
    cutIndex,
    deliveryPayload,
    payloadIntegrity,
    add,
    headEvidence,
  });
  summary.tmsInventoryShipments = tmsComparison.shipmentCount;
  summary.tmsInventoryMissingFromCanonical = tmsComparison.missingFromCanonical;
  summary.tmsInventoryMalformedAwbs = tmsComparison.malformedAwbs;
  summary.tmsInventoryDuplicateAwbs = tmsComparison.duplicateAwbs;
  if (!isPlainObject(productionSnapshot)) {
    return { publications, heads, payloads, snapshots, metadata, head, publication: headPublication, productionComparison: summary };
  }
  if (witnessMode === "relational" || witnessMode === "relational-legacy") {
    const observedHash = text(field(production, "observedDeliveryPayloadHash", "observed_delivery_payload_hash", "deliveryPayloadHash", "delivery_payload_hash"));
    const fullPayloadHashVerifiedAtSource = field(
      production,
      "fullPayloadHashVerifiedAtSource",
      "full_payload_hash_verified_at_source",
    ) === true;
    const productionMatches = observedHash === deliveryHash &&
      fullPayloadHashVerifiedAtSource &&
      text(field(productionSnapshot, "deliveryPayloadHash", "delivery_payload_hash")) === deliveryHash &&
      text(field(productionSnapshot, "contentSignature", "content_signature")) === deliveryHash &&
      publicationId(productionSnapshot) === publicationId(head) &&
      integer(field(productionSnapshot, "publicationVersion", "publication_version"), -1) === integer(field(head, "publicationVersion", "publication_version"), -2) &&
      text(field(productionSnapshot, "publicationChannel", "publication_channel")) === "production" &&
      sourceCutId(productionSnapshot) === sourceCutId(head) &&
      text(field(productionSnapshot, "packetHash", "packet_hash")) === text(field(head, "packetHash", "packet_hash"));
    if (!productionMatches) {
      add({
        stage: "production",
        classification: "production_hash_mismatch",
        subjectType: "production_api",
        subjectKey: "shipment-truth-packets",
        evidenceIds: [...headEvidence, observedHash],
        detail: {
          productionMatches,
          fullPayloadHashVerifiedAtSource,
          semanticWitnessHash: text(field(production, "semanticWitnessHash", "semantic_witness_hash")),
          observedHash,
          expectedHash: deliveryHash,
        },
      });
    }
  }

  if (!payloadIntegrity || !isPlainObject(deliveryPayload)) {
    add({
      stage: "production",
      classification: "production_comparison_expected_payload_untrusted",
      subjectType: "truth_publication_payload",
      subjectKey: "shipment-truth-packets",
      evidenceIds: headEvidence,
      detail: { channel: selectedChannel, publicationId: publicationId(head) },
    });
    return { publications, heads, payloads, snapshots, metadata, head, publication: headPublication, productionComparison: summary };
  }

  const expectedInventory = semanticInventory(deliveryPayload);
  const productionInventory = semanticInventory(productionSnapshot);
  summary.expectedShipments = expectedInventory.shipmentCount;
  summary.productionShipments = productionInventory.shipmentCount;
  summary.malformedAwbs = productionInventory.malformed.length;
  summary.duplicateAwbs = productionInventory.duplicates.length;
  if (productionInventory.shipmentCount > MAX_PRODUCTION_SHIPMENT_ROWS) {
    add({
      stage: "production",
      classification: "production_witness_row_bound_exceeded",
      subjectType: "production_api",
      subjectKey: "shipment-truth-packets",
      evidenceIds: [...headEvidence, text(field(production, "exactSnapshotHash", "exact_snapshot_hash"))],
      detail: { shipmentCount: productionInventory.shipmentCount, rowLimit: MAX_PRODUCTION_SHIPMENT_ROWS },
    });
    return { publications, heads, payloads, snapshots, metadata, head, publication: headPublication, productionComparison: summary };
  }
  expectedInventory.malformed.forEach((item) => {
    add({
      stage: "publication",
      classification: "publication_payload_awb_malformed",
      subjectType: item.indexName ? "publication_awb_index" : "truth_shipment",
      subjectKey: `${item.indexName || "shipments"}:${item.index}`,
      evidenceIds: [...headEvidence, ...item.rawValues],
      detail: item,
    });
  });
  expectedInventory.duplicates.forEach((item) => {
    add({
      stage: "publication",
      classification: "publication_payload_awb_duplicate",
      subjectType: item.indexName ? "publication_awb_index" : "truth_shipment",
      subjectKey: `${item.indexName || "shipments"}:${item.awb}`,
      evidenceIds: [...headEvidence, `shipment:${item.awb}`],
      detail: item,
    });
  });
  productionInventory.malformed.forEach((item) => {
    add({
      stage: "production",
      classification: "production_awb_malformed",
      subjectType: item.indexName ? "production_awb_index" : "production_shipment",
      subjectKey: `${item.indexName || "shipments"}:${item.index}`,
      evidenceIds: [text(field(production, "exactSnapshotHash", "exact_snapshot_hash")), ...item.rawValues],
      detail: item,
    });
  });
  productionInventory.duplicates.forEach((item) => {
    add({
      stage: "production",
      classification: "production_awb_duplicate",
      subjectType: item.indexName ? "production_awb_index" : "production_shipment",
      subjectKey: `${item.indexName || "shipments"}:${item.awb}`,
      evidenceIds: [text(field(production, "exactSnapshotHash", "exact_snapshot_hash")), `shipment:${item.awb}`],
      detail: item,
    });
  });

  const allAwbs = sortedUnique([...expectedInventory.map.keys(), ...productionInventory.map.keys()]);
  for (const awb of allAwbs) {
    const expected = expectedInventory.map.get(awb);
    const actual = productionInventory.map.get(awb);
    const shipmentEvidence = [...headEvidence, `shipment:${awb}`, text(field(production, "exactSnapshotHash", "exact_snapshot_hash"))];
    if (!actual) {
      add({
        stage: "production",
        classification: "production_shipment_missing",
        subjectType: "shipment",
        subjectKey: awb,
        evidenceIds: shipmentEvidence,
        detail: { awb, expected: expected.semantics, actual: null },
      });
      summary.missingShipments += 1;
      continue;
    }
    if (!expected) {
      add({
        stage: "production",
        classification: "production_shipment_unexpected",
        subjectType: "shipment",
        subjectKey: awb,
        evidenceIds: shipmentEvidence,
        detail: { awb, expected: null, actual: actual.semantics },
      });
      summary.unexpectedShipments += 1;
      continue;
    }
    const mismatchFields = compareShipmentSemantics(expected.semantics, actual.semantics);
    if (mismatchFields.length) {
      add({
        stage: "production",
        classification: "production_shipment_semantic_mismatch",
        subjectType: "shipment",
        subjectKey: awb,
        evidenceIds: shipmentEvidence,
        detail: { awb, mismatchFields, expected: expected.semantics, actual: actual.semantics },
      });
      summary.semanticMismatches += 1;
    } else {
      summary.matchedShipments += 1;
    }
  }
  return { publications, heads, payloads, snapshots, metadata, head, publication: headPublication, productionComparison: summary };
}

function createRelationalTruthAuditor(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("auditor options must be a plain object");
  const allowedOptions = new Set(["digest", "observerVersion"]);
  for (const key of Object.keys(options)) {
    if (!allowedOptions.has(key)) {
      throw new TypeError(`Unsupported auditor dependency ${key}; operational clients are forbidden`);
    }
  }
  const digest = options.digest || defaultDigest;
  if (typeof digest !== "function") throw new TypeError("auditor digest must be a function");
  const observerVersion = text(options.observerVersion) || OBSERVER_VERSION;

  return Object.freeze({
    audit(snapshot) {
      assertJsonSnapshot(snapshot);
      if (!isPlainObject(snapshot)) throw new TypeError("audit snapshot must be a plain object");
      const workspaceKey = text(field(snapshot, "workspaceKey", "workspace_key"));
      if (!workspaceKey) throw new TypeError("audit snapshot requires workspaceKey");
      const source = field(snapshot, "source") || {};
      const canonical = field(snapshot, "canonical") || {};
      const production = field(snapshot, "production") || {};
      const factory = createFindingFactory({ workspaceKey, digest });
      const context = { add: factory.add, digest };
      const sourceIndex = auditSource({ source, ...context });
      const gmailIndex = auditGmailIngest({ source, sourceIndex, ...context });
      auditProcessing({ source, gmailIndex, ...context });
      const cutIndex = auditSourceCut({ sourceIndex, canonical, production, ...context });
      const buildIndex = auditBuilds({ canonical, cutIndex, ...context });
      auditProcessingWatermarkContinuity({ canonical, production, ...context });
      const publicationIndex = auditPublication({ source, canonical, buildIndex, cutIndex, production, ...context });
      const findings = factory.finish();
      const counts = findings.reduce((output, finding) => {
        output[finding.severity] += 1;
        output.byStage[finding.stage] = (output.byStage[finding.stage] || 0) + 1;
        return output;
      }, { blocking: 0, attention: 0, informational: 0, byStage: {} });
      counts.productionComparison = publicationIndex.productionComparison;
      return Object.freeze({
        ok: counts.blocking === 0,
        workspaceKey,
        observerVersion,
        inputDigest: digest(JSON.stringify(canonicalUnordered(snapshot))),
        counts,
        findings,
        mutatesOperationalState: false,
      });
    },
  });
}

function auditRelationalTruth(snapshot) {
  return createRelationalTruthAuditor().audit(snapshot);
}

module.exports = Object.freeze({
  OBSERVER_VERSION,
  STAGE_ORDER,
  auditRelationalTruth,
  createRelationalTruthAuditor,
  _test: Object.freeze({
    collectObservationReferences,
    currentTmsInventory,
    sourceVerifiedCompactCache,
  }),
  postgresJsonbText,
});

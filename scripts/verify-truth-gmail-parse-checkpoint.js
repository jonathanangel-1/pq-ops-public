#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_NAMES = Object.freeze([
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709224000_truth_audit_runtime.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709226000_truth_link_workgroup_runtime.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709232000_truth_private_evidence_bucket.sql",
  "20260709233000_truth_worker_context_runtime.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
  "20260709235000_truth_tracking_scope_authority.sql",
  "20260709236000_truth_operator_event_authority.sql",
  "20260709237000_truth_audit_status_read.sql",
  "20260709238000_truth_tms_inventory_presence_policy.sql",
  "20260709239000_truth_source_chronology.sql",
  "20260709239500_truth_claim_context_chronology.sql",
  "20260709240000_truth_review_resolution.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240600_truth_audit_shipment_metadata.sql",
  "20260709240700_truth_attachment_extraction_completeness.sql",
  "20260709240800_truth_audit_expired_running_status.sql",
  "20260709240900_truth_production_authority_isolation.sql",
  "20260709241000_truth_processing_watermark.sql",
  "20260709241100_truth_model_extraction_runtime.sql",
  "20260709241200_truth_model_extraction_worker.sql",
  "20260709241300_truth_model_dispatch_recovery.sql",
  "20260709241400_truth_gmail_parse_checkpoint.sql",
  "20260709241500_truth_audit_lane_status.sql",
  "20260710165917_harden_truth_table_service_role_acl.sql",
  "20260710183512_allow_codex_local_snapshot_writer_truth_journal.sql",
  "20260710193253_truth_gmail_link_epoch_runtime.sql",
  "20260710194524_fix_gmail_model_clause_ranges.sql",
  "20260710195708_canonicalize_truth_worker_capture_microseconds.sql",
  "20260710211600_fix_deterministic_gmail_plan_seal.sql",
  "20260716170000_fix_claim_result_coordinator_envelope.sql",
  "20260716184500_fix_truth_claim_lease_concurrency.sql",
  "20260716213000_truth_shadow_claim_acceptance_epoch_runtime.sql",
]);
const MIGRATIONS = MIGRATION_NAMES.map((name) => (
  path.join(ROOT, "supabase/migrations", name)
));
const WORKSPACE = "primary";
const CONNECTION = "gmail-parse-checkpoint-verifier";
const TOKEN = "gmail-parse-checkpoint-sync-token-v1";
const MESSAGE_ID = "gmail-checkpoint-message-1";
const THREAD_ID = "gmail-checkpoint-thread-1";
const HISTORY_ID = "100";
const PROVIDER_TIME = "2026-07-09T18:30:00.000Z";

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Json(value) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function observationId(connectionKey, fields) {
  return `obs:v1:${sha256Json({
    schemaVersion: "source-observation-identity-v1",
    workspaceKey: WORKSPACE,
    sourceSystem: "gmail",
    connectionKey,
    sourceObjectType: fields.sourceObjectType,
    sourceObjectId: fields.sourceObjectId,
    sourceRevision: fields.sourceRevision,
    operation: fields.operation,
    contentHash: fields.contentHash,
  })}`;
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function asService(db, work) {
  await db.exec("set role service_role");
  try {
    return await work();
  } finally {
    await db.exec("reset role");
  }
}

async function expectSqlState(promise, expectedCode, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, expectedCode, `${label}: ${error?.message || error}`);
    return true;
  }, label);
}

async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.sync_tokens (
      token_name text primary key,
      token_hash text not null
    );
    create table public.app_snapshots (
      snapshot_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table public.app_snapshot_metadata (
      snapshot_key text primary key,
      snapshot_time text,
      updated_at timestamptz not null default now(),
      writer_version text,
      content_signature text,
      payload_bytes integer
    );
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null
    );
    alter table storage.objects enable row level security;
  `);
  for (const migration of MIGRATIONS) {
    await db.exec(fs.readFileSync(migration, "utf8"));
  }
  await db.query(`
    insert into public.sync_tokens(token_name,token_hash)
    values ('local_snapshot_writer',encode(
      extensions.digest(convert_to($1::text,'UTF8'),'sha256'),'hex'
    ))
  `, [TOKEN]);
  return db;
}

function discoveryEvidence({
  messageId = MESSAGE_ID,
  threadId = THREAD_ID,
  mode = "backfill",
} = {}) {
  const eventPayload = {
    schemaVersion: "gmail-mailbox-discovery-event-v1",
    eventType: "message_discovered",
    historyId: HISTORY_ID,
    messageId,
    threadId,
    discoveryMode: mode,
  };
  const eventId = `gmail-event:v1:${sha256Json(eventPayload)}`;
  const normalizedPayload = { ...eventPayload, eventId };
  const contentHash = sha256Json(normalizedPayload);
  const sourceRevision = `discovery:${mode}:${HISTORY_ID}:${contentHash}`;
  const observation = {
    sourceObjectType: "gmail_message_discovery_event",
    sourceObjectId: messageId,
    sourceRevision,
    operation: "metadata_change",
    contentHash,
    normalizedPayload,
    normalizedText: "",
    sourceFidelity: "normalized_source",
    schemaVersion: "gmail-mailbox-discovery-event-v1",
  };
  observation.observationId = observationId(CONNECTION, observation);
  return {
    event: { eventId, ...eventPayload },
    observation,
  };
}

function buildHistoryEvent({
  eventType,
  historyId,
  messageLabelIds = ["INBOX"],
  changedLabelIds = [],
}) {
  const eventPayload = {
    schemaVersion: "gmail-history-event-v1",
    eventType,
    historyId,
    messageId: MESSAGE_ID,
    threadId: THREAD_ID,
    messageLabelIds,
    changedLabelIds,
  };
  const eventId = `gmail-event:v1:${sha256Json(eventPayload)}`;
  const normalizedPayload = { ...eventPayload, eventId };
  const contentHash = sha256Json(normalizedPayload);
  const sourceRevision = `history:${historyId}:${eventType}:${contentHash}`;
  const observation = {
    sourceObjectType: "gmail_message_history_event",
    sourceObjectId: MESSAGE_ID,
    sourceRevision,
    operation: eventType === "message_deleted" ? "delete" : "metadata_change",
    contentHash,
    normalizedPayload,
    normalizedText: "",
    sourceFidelity: "normalized_source",
    schemaVersion: "gmail-history-event-v1",
  };
  observation.observationId = observationId(CONNECTION, observation);
  return { event: { eventId, ...eventPayload }, observation };
}

function historyEvidence() {
  return buildHistoryEvent({ eventType: "message_added", historyId: HISTORY_ID });
}

function labelEvidence() {
  return ["labels_added", "labels_removed"].map((eventType) => buildHistoryEvent({
    eventType,
    historyId: HISTORY_ID,
    changedLabelIds: ["STARRED"],
  }));
}

function deletionEvidence() {
  return buildHistoryEvent({
    eventType: "message_deleted",
    historyId: "103",
    messageLabelIds: [],
  });
}

async function beginBatch(db, { mode = "backfill", ownerId }) {
  const lease = (await one(db, `
    select public.acquire_source_sync_lease(
      $1::text,'gmail'::text,$2::text,$3::text,120::integer,
      'gmail_history_id'::text,$4::text
    ) as receipt
  `, [WORKSPACE, CONNECTION, ownerId, TOKEN])).receipt;
  const batch = (await one(db, `
    select public.begin_source_ingest_batch(
      $1::text,'gmail'::text,$2::text,$3::text,$4::bigint,
      $5::text,'gmail-parse-checkpoint-verifier'::text,$6::text
    ) as receipt
  `, [WORKSPACE, CONNECTION, ownerId, lease.leaseFence, mode, TOKEN])).receipt;
  return { lease, batch };
}

async function appendDiscoveryPage(db, {
  ownerId,
  lease,
  batch,
  jobs = [],
  mode = "backfill",
}) {
  const evidence = discoveryEvidence({ mode });
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: HISTORY_ID,
    firstHistoryId: HISTORY_ID,
    lastHistoryId: HISTORY_ID,
    providerResponse: {
      historyId: HISTORY_ID,
      history: [],
      messages: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
    },
    providerEvents: [evidence.event],
    isFinal: true,
  };
  const receipt = (await one(db, `
    select public.append_gmail_ingest_page(
      $1::uuid,$2::text,$3::bigint,$4::jsonb,$5::jsonb,$6::jsonb,$7::text
    ) as receipt
  `, [
    batch.batchId,
    ownerId,
    lease.leaseFence,
    page,
    [evidence.observation],
    jobs,
    TOKEN,
  ])).receipt;
  return { evidence, page, receipt };
}

async function appendHistoryPage(db, { ownerId, lease, batch }) {
  const evidence = historyEvidence();
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: "101",
    firstHistoryId: HISTORY_ID,
    lastHistoryId: HISTORY_ID,
    providerResponse: {
      historyId: "101",
      history: [{
        id: HISTORY_ID,
        messagesAdded: [{
          message: { id: MESSAGE_ID, threadId: THREAD_ID, labelIds: ["INBOX"] },
        }],
      }],
    },
    providerEvents: [evidence.event],
    isFinal: true,
  };
  const receipt = (await one(db, `
    select public.append_gmail_ingest_page(
      $1::uuid,$2::text,$3::bigint,$4::jsonb,$5::jsonb,'[]'::jsonb,$6::text
    ) as receipt
  `, [
    batch.batchId,
    ownerId,
    lease.leaseFence,
    page,
    [evidence.observation],
    TOKEN,
  ])).receipt;
  return { evidence, page, receipt };
}

async function appendLabelPage(db, { ownerId, lease, batch }) {
  const evidence = labelEvidence();
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: "102",
    firstHistoryId: HISTORY_ID,
    lastHistoryId: HISTORY_ID,
    providerResponse: {
      historyId: "102",
      history: [{
        id: HISTORY_ID,
        labelsAdded: [{
          message: { id: MESSAGE_ID, threadId: THREAD_ID, labelIds: ["INBOX"] },
          labelIds: ["STARRED"],
        }],
        labelsRemoved: [{
          message: { id: MESSAGE_ID, threadId: THREAD_ID, labelIds: ["INBOX"] },
          labelIds: ["STARRED"],
        }],
      }],
    },
    providerEvents: evidence.map((item) => item.event)
      .sort((left, right) => left.eventId.localeCompare(right.eventId)),
    isFinal: true,
  };
  const receipt = (await one(db, `
    select public.append_gmail_ingest_page(
      $1::uuid,$2::text,$3::bigint,$4::jsonb,$5::jsonb,'[]'::jsonb,$6::text
    ) as receipt
  `, [
    batch.batchId,
    ownerId,
    lease.leaseFence,
    page,
    evidence.map((item) => item.observation)
      .sort((left, right) => left.observationId.localeCompare(right.observationId)),
    TOKEN,
  ])).receipt;
  return { evidence, page, receipt };
}

async function appendDeletionPage(db, { ownerId, lease, batch }) {
  const evidence = deletionEvidence();
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: "103",
    firstHistoryId: "103",
    lastHistoryId: "103",
    providerResponse: {
      historyId: "103",
      history: [{
        id: "103",
        messagesDeleted: [{
          message: { id: MESSAGE_ID, threadId: THREAD_ID, labelIds: [] },
        }],
      }],
    },
    providerEvents: [evidence.event],
    isFinal: true,
  };
  const receipt = (await one(db, `
    select public.append_gmail_ingest_page(
      $1::uuid,$2::text,$3::bigint,$4::jsonb,$5::jsonb,'[]'::jsonb,$6::text
    ) as receipt
  `, [
    batch.batchId,
    ownerId,
    lease.leaseFence,
    page,
    [evidence.observation],
    TOKEN,
  ])).receipt;
  return { evidence, page, receipt };
}

async function claim(db, { workerId, processorVersion, jobKinds }) {
  return (await one(db, `
    select public.claim_source_processing_jobs(
      $1::text,'gmail'::text,$2::text,$3::text,$4::text,
      10::integer,120::integer,$5::text[],$6::text
    ) as receipt
  `, [WORKSPACE, CONNECTION, workerId, processorVersion, jobKinds, TOKEN])).receipt;
}

async function verifyFlow(db) {
  await asService(db, async () => {
    await db.exec("begin");
    const rejected = await beginBatch(db, {
      mode: "backfill",
      ownerId: "gmail-page-job-negative",
    });
    await expectSqlState(appendDiscoveryPage(db, {
      ...rejected,
      ownerId: "gmail-page-job-negative",
      jobs: [{
        dedupeKey: "legacy-job-must-not-persist",
        jobKind: "gmail_fetch_raw_message",
        observationId: discoveryEvidence().observation.observationId,
        sourceObjectId: MESSAGE_ID,
        maxAttempts: 5,
        payload: { messageId: MESSAGE_ID },
      }],
    }), "23514", "Gmail v2 page jobs must be rejected");
    await db.exec("rollback");

    await db.exec("begin");
    const projectionOwner = "gmail-provider-projection-negative";
    const projectionBatch = await beginBatch(db, {
      mode: "backfill",
      ownerId: projectionOwner,
    });
    const tampered = discoveryEvidence({ threadId: "tampered-thread", mode: "backfill" });
    await expectSqlState(one(db, `
      select public.append_gmail_ingest_page(
        $1::uuid,$2::text,$3::bigint,$4::jsonb,$5::jsonb,'[]'::jsonb,$6::text
      ) as receipt
    `, [
      projectionBatch.batch.batchId,
      projectionOwner,
      projectionBatch.lease.leaseFence,
      {
        pageOrdinal: 0,
        requestPageToken: "",
        responseNextPageToken: "",
        responseMailboxHistoryId: HISTORY_ID,
        firstHistoryId: HISTORY_ID,
        lastHistoryId: HISTORY_ID,
        providerResponse: {
          historyId: HISTORY_ID,
          history: [],
          messages: [{ id: MESSAGE_ID, threadId: THREAD_ID }],
        },
        providerEvents: [tampered.event],
        isFinal: true,
      },
      [tampered.observation],
      TOKEN,
    ]), "23514", "provider event projection must be server exact");
    await db.exec("rollback");

    const ownerId = "gmail-reconciliation-owner";
    const started = await beginBatch(db, { ownerId });
    const appended = await appendDiscoveryPage(db, { ...started, ownerId });
    assert.equal(appended.receipt.jobCount, 0);
    const committed = (await one(db, `
      select public.commit_source_ingest_batch(
        $1::uuid,$2::text,$3::bigint,$4::text
      ) as receipt
    `, [started.batch.batchId, ownerId, started.lease.leaseFence, TOKEN])).receipt;
    assert.equal(committed.jobCount, 0);
    assert.deepEqual(committed.materializationRoutes, {
      ok: true,
      idempotent: false,
      sealId: committed.materializationRoutes.sealId,
      sealHash: committed.materializationRoutes.sealHash,
      routeManifestHash: committed.materializationRoutes.routeManifestHash,
      routeCount: 1,
      materializationCount: 1,
      deletedCount: 0,
    });

    const rawWorker = "gmail-materializer-worker";
    const rawVersion = "gmail-materializer-worker-v2";
    const rawClaim = await claim(db, {
      workerId: rawWorker,
      processorVersion: rawVersion,
      jobKinds: ["gmail_materialize_message_revision"],
    });
    assert.equal(rawClaim.claimedCount, 1);
    const job = rawClaim.jobs[0];
    const authorityKeys = [
      "schemaVersion", "groupId", "groupHash", "routeSealId", "routeSealHash",
      "rootBatchId", "rootBatchHash", "connectionKey", "sourceCursorVersion",
      "sourceCursorValue", "messageId", "threadId", "selectedTrigger",
      "coverageManifestId", "coverageManifestHash", "coverageCount",
      "materializerVersion",
    ].sort();
    assert.deepEqual(Object.keys(job.materializationAuthority).sort(), authorityKeys);
    assert.equal(job.materializationAuthority.connectionKey, CONNECTION);
    assert.equal(job.materializationAuthority.threadId, THREAD_ID);
    assert.equal(job.materializationAuthority.coverageCount, 1);

    const rawHash = crypto.createHash("sha256").update("raw-rfc822-bytes").digest("hex");
    const rawObject = {
      bucket: "pikiio-truth-evidence-v1",
      key: `truth-raw/v1/${rawHash}`,
      version: "fixture-version-1",
      etag: "fixture-etag-1",
      hash: rawHash,
      bytes: 17,
      contentType: "message/rfc822",
    };
    const rawPayload = {
      schemaVersion: "gmail-raw-message-v2",
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
      providerMessageHistoryId: HISTORY_ID,
      internalDate: String(Date.parse(PROVIDER_TIME)),
      providerReceivedAt: PROVIDER_TIME,
      labelIds: ["INBOX"],
      sizeEstimate: 17,
      rawSha256: rawHash,
      rawBytes: 17,
    };
    const rawObservation = {
      sourceObjectType: "gmail_message_raw",
      sourceObjectId: MESSAGE_ID,
      sourceRevision: HISTORY_ID,
      operation: "content",
      contentHash: rawHash,
      sourceRecordedAt: PROVIDER_TIME,
      normalizedPayload: rawPayload,
      normalizedText: "",
      rawObject,
      sourceFidelity: "raw",
      schemaVersion: "gmail-raw-message-v2",
      retentionClass: "shipment-operations",
    };
    rawObservation.observationId = observationId(CONNECTION, rawObservation);
    const parsePayload = {
      schemaVersion: "gmail-parse-rfc822-job-v2",
      messageId: MESSAGE_ID,
      threadId: THREAD_ID,
      providerMessageHistoryId: HISTORY_ID,
      rawObservationId: rawObservation.observationId,
      rawObservationContentHash: rawHash,
      internalDate: rawPayload.internalDate,
      sourceRecordedAt: PROVIDER_TIME,
      labelIds: ["INBOX"],
      rawObject,
      parserVersion: "gmail-rfc822-parser-v2",
    };
    const parseChild = {
      dedupeKey: `gmail:parse-rfc822:v2:${sha256Json(parsePayload)}`,
      jobKind: "gmail_parse_rfc822",
      observationId: rawObservation.observationId,
      sourceObjectId: MESSAGE_ID,
      maxAttempts: 5,
      payload: parsePayload,
    };
    const materialized = (await one(db, `
      select public.complete_gmail_message_revision_materialization(
        $1::text,$2::uuid,$3::text,$4::bigint,$5::text,
        $6::jsonb,$7::jsonb,$8::jsonb,$9::text
      ) as receipt
    `, [
      WORKSPACE,
      job.jobId,
      rawWorker,
      job.leaseFence,
      rawVersion,
      {
        schemaVersion: "gmail-message-revision-materialization-result-v1",
        materializationGroupId: job.payload.groupId,
        messageId: MESSAGE_ID,
        providerMessageHistoryId: HISTORY_ID,
        rawSha256: rawHash,
        rawBytes: 17,
      },
      rawObservation,
      parseChild,
      TOKEN,
    ])).receipt;
    assert.equal(materialized.materializationDisposition, "first_materialized");
    assert.equal(materialized.childJobs.length, 1);
    const materializedReplay = (await one(db, `
      select public.complete_gmail_message_revision_materialization(
        $1::text,$2::uuid,$3::text,$4::bigint,$5::text,
        $6::jsonb,$7::jsonb,$8::jsonb,$9::text
      ) as receipt
    `, [
      WORKSPACE,
      job.jobId,
      rawWorker,
      job.leaseFence,
      rawVersion,
      {
        schemaVersion: "gmail-message-revision-materialization-result-v1",
        materializationGroupId: job.payload.groupId,
        messageId: MESSAGE_ID,
        providerMessageHistoryId: HISTORY_ID,
        rawSha256: rawHash,
        rawBytes: 17,
      },
      rawObservation,
      parseChild,
      TOKEN,
    ])).receipt;
    assert.equal(materializedReplay.idempotent, true);
    assert.equal(materializedReplay.materializationDisposition, "first_materialized");
    assert.equal(materializedReplay.materializationReceiptId, materialized.materializationReceiptId);
    assert.equal(materializedReplay.completionHash, materialized.completionHash);

    const parseWorker = "gmail-parser-worker";
    const parseVersion = "gmail-parser-worker-v2";
    const parseClaim = await claim(db, {
      workerId: parseWorker,
      processorVersion: parseVersion,
      jobKinds: ["gmail_parse_rfc822"],
    });
    assert.equal(parseClaim.claimedCount, 1);
    const parseJob = parseClaim.jobs[0];
    const labelIdsHash = sha256Json(["INBOX"]);
    const parsedPayload = {
      schemaVersion: "gmail-parsed-message-v2",
      parserVersion: parsePayload.parserVersion,
      gmail: {
        messageId: MESSAGE_ID,
        threadId: THREAD_ID,
        historyId: HISTORY_ID,
        providerHistoryId: HISTORY_ID,
        internalDate: rawPayload.internalDate,
        providerReceivedAt: PROVIDER_TIME,
        labelIds: ["INBOX"],
        labelIdsHash,
        rawObservationId: rawObservation.observationId,
        rawObservationContentHash: rawHash,
      },
      from: { name: "Station", address: "station@example.com" },
      to: [{ name: "Piki", address: "contact-073@demo-freight.example" }],
      cc: [],
      bcc: [],
      subject: "Shipment update",
      text: "Shipment remains on schedule.",
      html: "",
      attachments: [],
    };
    const parsedHash = sha256Json(parsedPayload);
    const parsedObservation = {
      sourceObjectType: "gmail_message_parsed",
      sourceObjectId: MESSAGE_ID,
      sourceRevision: HISTORY_ID,
      operation: "content",
      contentHash: parsedHash,
      sourceRecordedAt: PROVIDER_TIME,
      normalizedPayload: parsedPayload,
      normalizedText: "Shipment update\nShipment remains on schedule.",
      sourceFidelity: "normalized_source",
      schemaVersion: "gmail-parsed-message-v2",
      retentionClass: "shipment-operations",
    };
    parsedObservation.observationId = observationId(CONNECTION, parsedObservation);
    const parseCompleted = (await one(db, `
      select public.complete_source_processing_job(
        $1::uuid,$2::text,$3::bigint,$4::text,
        $5::jsonb,$6::jsonb,$7::jsonb,$8::text
      ) as receipt
    `, [
      parseJob.jobId,
      parseWorker,
      parseJob.leaseFence,
      parseVersion,
      {
        schemaVersion: "gmail-parse-result-v2",
        messageId: MESSAGE_ID,
        providerMessageHistoryId: HISTORY_ID,
        rawObservationId: rawObservation.observationId,
        parserVersion: parsePayload.parserVersion,
        parsedContentHash: parsedHash,
        attachmentCount: 0,
      },
      [parsedObservation],
      [],
      TOKEN,
    ])).receipt;
    assert.equal(parseCompleted.state, "succeeded");

    const checkpoint = (await one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,50::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, started.batch.batchId, TOKEN])).receipt;
    assert.equal(checkpoint.status, "ready");
    assert.equal(checkpoint.checkpoint.memberCount, 1);
    assert.equal(checkpoint.checkpoint.terminalGapCount, 0);
    assert.equal(
      checkpoint.checkpoint.sourceDelta.materializationRouteSeal.routeCount,
      1,
    );
    await db.exec("reset role");
    const member = await one(db, `
      select terminal_disposition,provider_history_id,group_id,
        materialization_receipt_id
      from public.gmail_parse_checkpoint_members
      where workspace_key=$1::text and root_batch_id=$2::uuid
    `, [WORKSPACE, started.batch.batchId]);
    assert.equal(member.terminal_disposition, "parsed_exact_revision");
    assert.equal(member.provider_history_id, HISTORY_ID);
    assert.equal(member.group_id, job.payload.groupId);
    assert.equal(member.materialization_receipt_id, materialized.materializationReceiptId);
    await db.exec("set role service_role");

    const secondOwner = "gmail-history-reobservation-owner";
    const second = await beginBatch(db, { mode: "history", ownerId: secondOwner });
    const secondPage = await appendHistoryPage(db, { ...second, ownerId: secondOwner });
    assert.equal(secondPage.receipt.jobCount, 0);
    const secondCommit = (await one(db, `
      select public.commit_source_ingest_batch(
        $1::uuid,$2::text,$3::bigint,$4::text
      ) as receipt
    `, [second.batch.batchId, secondOwner, second.lease.leaseFence, TOKEN])).receipt;
    assert.equal(secondCommit.committedCursorValue, "101");
    assert.equal(secondCommit.materializationRoutes.routeCount, 1);
    const secondClaim = await claim(db, {
      workerId: "gmail-history-reobservation-worker",
      processorVersion: rawVersion,
      jobKinds: ["gmail_materialize_message_revision"],
    });
    assert.equal(secondClaim.claimedCount, 1);
    const secondJob = secondClaim.jobs[0];
    const reobserved = (await one(db, `
      select public.complete_gmail_message_revision_materialization(
        $1::text,$2::uuid,$3::text,$4::bigint,$5::text,
        $6::jsonb,$7::jsonb,$8::jsonb,$9::text
      ) as receipt
    `, [
      WORKSPACE,
      secondJob.jobId,
      "gmail-history-reobservation-worker",
      secondJob.leaseFence,
      rawVersion,
      {
        schemaVersion: "gmail-message-revision-materialization-result-v1",
        materializationGroupId: secondJob.payload.groupId,
        messageId: MESSAGE_ID,
        providerMessageHistoryId: HISTORY_ID,
        rawSha256: rawHash,
        rawBytes: 17,
      },
      rawObservation,
      parseChild,
      TOKEN,
    ])).receipt;
    assert.equal(reobserved.materializationDisposition, "prior_exact_revision_reobserved");
    assert.deepEqual(reobserved.childJobs, []);
    assert.equal(reobserved.evidenceOwnerGroupId, materialized.materializationGroupId);
    assert.equal(reobserved.evidenceOwnerSourceCursorVersion, 1);
    assert.equal(reobserved.parseJobId, materialized.parseJobId);
    const secondCheckpoint = (await one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,50::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, second.batch.batchId, TOKEN])).receipt;
    assert.equal(secondCheckpoint.status, "ready");
    assert.equal(secondCheckpoint.checkpoint.memberCount, 1);
    assert.equal(secondCheckpoint.checkpoint.cumulativeMemberCount, 2);
    assert.equal(secondCheckpoint.checkpoint.terminalGapCount, 0);
    await db.exec("reset role");
    const intrinsicCounts = await one(db, `
      select
        (select count(*)::integer from public.source_observations
          where workspace_key=$1::text and source_system='gmail'
            and connection_key=$2::text
            and source_object_type='gmail_message_raw'
            and source_object_id=$3::text and source_revision=$4::text) as raw_count,
        (select count(*)::integer from public.source_processing_jobs
          where workspace_key=$1::text and source_system='gmail'
            and connection_key=$2::text and job_kind='gmail_parse_rfc822'
            and source_object_id=$3::text) as parse_count,
        (select count(*)::integer
          from public.gmail_message_materialization_receipts
          where workspace_key=$1::text and message_id=$3::text) as receipt_count
    `, [WORKSPACE, CONNECTION, MESSAGE_ID, HISTORY_ID]);
    assert.deepEqual(intrinsicCounts, { raw_count: 1, parse_count: 1, receipt_count: 2 });
    await db.exec("set role service_role");

    const labelOwner = "gmail-label-gap-owner";
    const labelBatch = await beginBatch(db, { mode: "history", ownerId: labelOwner });
    const labelPage = await appendLabelPage(db, { ...labelBatch, ownerId: labelOwner });
    assert.equal(labelPage.receipt.observationCount, 2);
    const labelCommit = (await one(db, `
      select public.commit_source_ingest_batch(
        $1::uuid,$2::text,$3::bigint,$4::text
      ) as receipt
    `, [labelBatch.batch.batchId, labelOwner, labelBatch.lease.leaseFence, TOKEN])).receipt;
    assert.equal(labelCommit.committedCursorValue, "102");
    assert.equal(labelCommit.materializationRoutes.routeCount, 1);
    const labelClaim = await claim(db, {
      workerId: "gmail-label-gap-worker",
      processorVersion: rawVersion,
      jobKinds: ["gmail_materialize_message_revision"],
    });
    assert.equal(labelClaim.claimedCount, 1);
    assert.equal(
      labelClaim.jobs[0].materializationAuthority.selectedTrigger.eventType,
      "labels_removed",
    );
    assert.equal(labelClaim.jobs[0].materializationAuthority.coverageCount, 2);
    const obligation = (await one(db, `
      select public.complete_gmail_message_revision_obligation(
        $1::text,$2::uuid,$3::text,$4::bigint,$5::text,
        'PROVIDER_MESSAGE_DELETED_UNAVAILABLE'::text,null::jsonb,$6::text
      ) as receipt
    `, [
      WORKSPACE,
      labelClaim.jobs[0].jobId,
      "gmail-label-gap-worker",
      labelClaim.jobs[0].leaseFence,
      rawVersion,
      TOKEN,
    ])).receipt;
    assert.equal(obligation.reasonCode, "PROVIDER_MESSAGE_DELETED_UNAVAILABLE");
    const labelCheckpoint = (await one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,50::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, labelBatch.batch.batchId, TOKEN])).receipt;
    assert.equal(labelCheckpoint.status, "ready");
    assert.equal(labelCheckpoint.checkpoint.memberCount, 1);
    assert.equal(labelCheckpoint.checkpoint.terminalGapCount, 1);
    assert.equal(labelCheckpoint.checkpoint.cumulativeOpenTerminalGapCount, 1);

    const deleteOwner = "gmail-delete-resolution-owner";
    const deleteBatch = await beginBatch(db, { mode: "history", ownerId: deleteOwner });
    const deletePage = await appendDeletionPage(db, { ...deleteBatch, ownerId: deleteOwner });
    assert.equal(deletePage.receipt.observationCount, 1);
    const deleteCommit = (await one(db, `
      select public.commit_source_ingest_batch(
        $1::uuid,$2::text,$3::bigint,$4::text
      ) as receipt
    `, [deleteBatch.batch.batchId, deleteOwner, deleteBatch.lease.leaseFence, TOKEN])).receipt;
    assert.equal(deleteCommit.committedCursorValue, "103");
    assert.equal(deleteCommit.materializationRoutes.routeCount, 1);
    assert.equal(deleteCommit.materializationRoutes.materializationCount, 0);
    assert.equal(deleteCommit.materializationRoutes.deletedCount, 1);
    const noDeleteJob = await claim(db, {
      workerId: "gmail-delete-should-not-fetch",
      processorVersion: rawVersion,
      jobKinds: ["gmail_materialize_message_revision"],
    });
    assert.equal(noDeleteJob.claimedCount, 0);
    const deleteCheckpoint = (await one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,50::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, deleteBatch.batch.batchId, TOKEN])).receipt;
    assert.equal(deleteCheckpoint.status, "ready");
    assert.equal(deleteCheckpoint.checkpoint.memberCount, 1);
    assert.equal(deleteCheckpoint.checkpoint.terminalGapCount, 0);
    assert.equal(deleteCheckpoint.checkpoint.cumulativeMemberCount, 4);
    assert.equal(deleteCheckpoint.checkpoint.cumulativeTerminalGapCount, 1);
    assert.equal(deleteCheckpoint.checkpoint.cumulativeResolvedTerminalGapCount, 1);
    assert.equal(deleteCheckpoint.checkpoint.cumulativeOpenTerminalGapCount, 0);
    const priorGapCheckpointReplay = (await one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,50::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, labelBatch.batch.batchId, TOKEN])).receipt;
    assert.equal(priorGapCheckpointReplay.checkpointHash, labelCheckpoint.checkpointHash);
    assert.equal(priorGapCheckpointReplay.checkpoint.cumulativeOpenTerminalGapCount, 1);
    const resolutionReplay = (await one(db, `
      select public.resolve_gmail_message_revision_obligation(
        $1::text,$2::text,'later_provider_deletion'::text,
        null::uuid,$3::text,$4::text
      ) as receipt
    `, [
      WORKSPACE,
      obligation.obligationId,
      deletePage.evidence.observation.observationId,
      TOKEN,
    ])).receipt;
    assert.equal(resolutionReplay.idempotent, true);
    await db.exec("reset role");
    const resolutionAudit = await one(db, `
      select count(*)::integer as resolution_count,
        min(resolution_kind) as resolution_kind,
        min(resolving_group_id) as resolving_group_id,
        min(resolution_observation_id) as resolution_observation_id
      from public.gmail_message_revision_resolutions
      where workspace_key=$1::text and obligation_id=$2::text
    `, [WORKSPACE, obligation.obligationId]);
    assert.equal(resolutionAudit.resolution_count, 1);
    assert.equal(resolutionAudit.resolution_kind, "later_provider_deletion");
    assert.equal(
      resolutionAudit.resolution_observation_id,
      deletePage.evidence.observation.observationId,
    );
    await db.exec("set role service_role");
    await expectSqlState(one(db, `
      select public.ensure_gmail_parse_checkpoint(
        $1::text,$2::text,$3::uuid,501::integer,$4::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, deleteBatch.batch.batchId, TOKEN]), "22023",
    "parse checkpoint batch page must remain bounded");
  });
}

async function main() {
  const db = await createDatabase();
  try {
    await verifyFlow(db);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      migrationCount: MIGRATIONS.length,
      routePolicy: "observations-only-commit-sealed-v1",
      checkpointPolicy: "gmail-parse-delta-checkpoint-policy-v1",
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

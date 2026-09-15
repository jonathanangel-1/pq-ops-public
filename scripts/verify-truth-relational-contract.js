#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { buildTmsSourceSnapshot } = require("../lib/tms-source-snapshot");

const ROOT = path.resolve(__dirname, "..");
const SOURCE_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709200000_truth_source_observation_journal.sql",
);
const TRUTH_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709210000_truth_claims_builds_publications_audits.sql",
);
const SNAPSHOT_GUARD_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709221000_protect_truth_snapshot_keys.sql",
);
const JOB_EXECUTION_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709220000_truth_processing_job_execution.sql",
);
const JOB_LEASE_RENEWAL_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709220500_truth_processing_job_lease_renewal.sql",
);
const EVIDENCE_ENVELOPE_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709222000_truth_evidence_envelopes.sql",
);
const GENERIC_SOURCE_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709223000_truth_generic_source_ingestion.sql",
);

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const HASH_G = "1".repeat(64);
const HASH_H = "2".repeat(64);
const HASH_I = "3".repeat(64);
const HASH_J = "4".repeat(64);
const OBS_A = `obs:v1:${HASH_A}`;
const OBS_C = `obs:v1:${HASH_C}`;
const OBS_F = `obs:v1:${HASH_F}`;
const OBS_G = `obs:v1:${HASH_G}`;
const OBS_H = `obs:v1:${HASH_H}`;
const OBS_I = `obs:v1:${HASH_I}`;
const OBS_J = `obs:v1:${HASH_J}`;
const EVENT_A = `gmail-event:v1:${HASH_A}`;
const EVENT_D = `gmail-event:v1:${HASH_D}`;
const EVENT_E = `gmail-event:v1:${HASH_E}`;
const WORKSPACE = "primary";
const CONNECTION = "primary";
const TOKEN = "test-sync-token";

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function expectSqlState(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${message}: ${error?.message || error}`);
    return true;
  }, message);
}

async function installContract(db) {
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.sync_tokens (
      token_name text primary key,
      token_hash text not null
    );
    create or replace function public.valid_sync_token(p_sync_token text)
    returns boolean language sql as $function$ select true $function$;
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
  `);
  await db.exec(fs.readFileSync(SOURCE_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(TRUTH_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(JOB_EXECUTION_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(JOB_LEASE_RENEWAL_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(SNAPSHOT_GUARD_MIGRATION, "utf8"));
  await db.exec(fs.readFileSync(EVIDENCE_ENVELOPE_MIGRATION, "utf8"));
  const genericSourceMigration = fs.readFileSync(GENERIC_SOURCE_MIGRATION, "utf8");
  await db.exec(genericSourceMigration);
  await db.exec(genericSourceMigration);
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values (
      'local_snapshot_writer',
      encode(extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex')
    )
  `, [TOKEN]);
}

async function verifyLegacySnapshotGuard(db) {
  await db.query(`
    select public.upsert_app_snapshot(
      'ordinary-legacy-key'::text,
      '{"snapshotTime":"2026-07-09T20:00:00.000Z","writerVersion":"legacy-test","value":1}'::jsonb,
      $1::text
    )
  `, [TOKEN]);
  const ordinary = await one(db, `
    select payload from public.app_snapshots where snapshot_key = 'ordinary-legacy-key'
  `);
  assert.equal(ordinary.payload.value, 1);

  for (const protectedKey of ["shipment-truth-packets", "active-awb-index"]) {
    await expectSqlState(
      db.query(`select public.upsert_app_snapshot($1::text, '{}'::jsonb, $2::text)`, [protectedKey, TOKEN]),
      "42501",
      `legacy snapshot RPC must reject protected key ${protectedKey}`,
    );
  }
}

async function verifyLegacySnapshotCompatibilityBeforeCutover(db) {
  for (const snapshotKey of ["shipment-truth-packets", "active-awb-index"]) {
    await db.query(`
      select public.upsert_app_snapshot(
        $1::text,
        jsonb_build_object(
          'snapshotTime', '2026-07-09T19:59:00.000Z',
          'writerVersion', 'legacy-shadow-transition-test',
          'contentSignature', $2::text
        ),
        $3::text
      )
    `, [snapshotKey, `${snapshotKey}-before-cutover`, TOKEN]);
  }
  const rows = await db.query(`
    select snapshot_key, payload->>'writerVersion' as writer_version
    from public.app_snapshots
    where snapshot_key in ('shipment-truth-packets', 'active-awb-index')
    order by snapshot_key
  `);
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows.every((row) => row.writer_version === "legacy-shadow-transition-test"),
    "legacy production projections must remain writable until a relational production head exists");
}

async function verifyGenericSourcePermissions(db) {
  await db.exec("set role anon");
  try {
    await expectSqlState(
      db.query(`select * from public.source_ingest_manifests`),
      "42501",
      "anonymous callers cannot read source-ingest manifests",
    );
    await expectSqlState(
      db.query(`
        select public.recover_committed_source_snapshot(
          'primary', 'tms', 'permission-test', '2026-07-09T00:00:00.000Z',
          '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $1::text
        )
      `, [TOKEN]),
      "42501",
      "anonymous callers cannot execute generic-source RPCs",
    );
  } finally {
    await db.exec("reset role");
  }

  await db.exec("set role service_role");
  try {
    const receipt = (await one(db, `
      select public.recover_committed_source_snapshot(
        'primary', 'tms', 'permission-test', '2026-07-09T00:00:00.000Z',
        '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $1::text
      ) as receipt
    `, [TOKEN])).receipt;
    assert.equal(receipt.found, false);
    await expectSqlState(
      db.query(`
        select private.recover_committed_source_snapshot(
          'primary', 'tms', 'permission-test', '2026-07-09T00:00:00.000Z',
          '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $1::text
        )
      `, [TOKEN]),
      "42501",
      "service role cannot bypass the public RPC boundary",
    );
    await expectSqlState(
      db.query(`
        insert into public.source_snapshot_failures (
          failure_hash, workspace_key, source_system, connection_key,
          cursor_version, failure_stage, error_code, safe_error_detail, recorded_by
        ) values ($1::text, 'primary', 'tms', 'permission-test', 0,
          'preflight', 'FORBIDDEN', 'forbidden direct insert', 'service-role-test')
      `, [HASH_A]),
      "42501",
      "service role cannot directly write source failure evidence",
    );
  } finally {
    await db.exec("reset role");
  }
}

async function acquire(db, ownerId, connectionKey = CONNECTION) {
  return (await one(db, `
    select public.acquire_source_sync_lease(
      $1::text, 'gmail'::text, $2::text, $3::text,
      90::integer, 'gmail_history_id'::text, $4::text
    ) as receipt
  `, [WORKSPACE, connectionKey, ownerId, TOKEN])).receipt;
}

async function beginBatch(db, ownerId, leaseFence, mode = "history", connectionKey = CONNECTION) {
  return (await one(db, `
    select public.begin_source_ingest_batch(
      $1::text, 'gmail'::text, $2::text, $3::text,
      $4::bigint, $5::text, 'relational-contract-test'::text, $6::text
    ) as receipt
  `, [WORKSPACE, connectionKey, ownerId, leaseFence, mode, TOKEN])).receipt;
}

async function acquireSource(db, {
  sourceSystem,
  connectionKey,
  ownerId,
  cursorKind,
}) {
  return (await one(db, `
    select public.acquire_source_sync_lease(
      $1::text, $2::text, $3::text, $4::text,
      90::integer, $5::text, $6::text
    ) as receipt
  `, [WORKSPACE, sourceSystem, connectionKey, ownerId, cursorKind, TOKEN])).receipt;
}

async function beginSourceBatch(db, {
  sourceSystem,
  connectionKey,
  ownerId,
  leaseFence,
  mode = "snapshot",
}) {
  return (await one(db, `
    select public.begin_source_ingest_batch(
      $1::text, $2::text, $3::text, $4::text,
      $5::bigint, $6::text, 'relational-contract-test'::text, $7::text
    ) as receipt
  `, [WORKSPACE, sourceSystem, connectionKey, ownerId, leaseFence, mode, TOKEN])).receipt;
}

async function commitSourceSnapshot(db, {
  batchId,
  ownerId,
  leaseFence,
  nextCursorValue,
  providerManifest,
  observations,
  jobs = [],
}) {
  return (await one(db, `
    select public.commit_source_snapshot_batch(
      $1::uuid, $2::text, $3::bigint, $4::text,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::text
    ) as receipt
  `, [
    batchId,
    ownerId,
    leaseFence,
    nextCursorValue,
    providerManifest,
    observations,
    jobs,
    TOKEN,
  ])).receipt;
}

async function recoverSourceSnapshot(db, {
  sourceSystem,
  connectionKey,
  nextCursorValue,
  providerManifest,
  observations,
  jobs,
}) {
  return (await one(db, `
    select public.recover_committed_source_snapshot(
      $1::text, $2::text, $3::text, $4::text,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::text
    ) as receipt
  `, [
    WORKSPACE,
    sourceSystem,
    connectionKey,
    nextCursorValue,
    providerManifest,
    observations,
    jobs,
    TOKEN,
  ])).receipt;
}

async function recordSourcePreflightFailure(db, {
  sourceSystem,
  connectionKey,
  cursorKind,
  ownerId,
  errorCode,
  safeErrorDetail,
  diagnostics,
}) {
  return (await one(db, `
    select public.record_source_snapshot_preflight_failure(
      $1::text, $2::text, $3::text, $4::text, $5::text,
      $6::text, $7::text, $8::jsonb, $9::text
    ) as receipt
  `, [
    WORKSPACE, sourceSystem, connectionKey, cursorKind, ownerId,
    errorCode, safeErrorDetail, diagnostics, TOKEN,
  ])).receipt;
}

async function failSourceSnapshot(db, {
  batchId,
  ownerId,
  leaseFence,
  errorCode,
  safeErrorDetail,
}) {
  return (await one(db, `
    select public.fail_source_snapshot_batch(
      $1::uuid, $2::text, $3::bigint, $4::text, $5::text, $6::text
    ) as receipt
  `, [batchId, ownerId, leaseFence, errorCode, safeErrorDetail, TOKEN])).receipt;
}

async function appendPage(db, { batchId, ownerId, leaseFence, page, observations, jobs }) {
  return (await one(db, `
    select public.append_gmail_ingest_page(
      $1::uuid, $2::text, $3::bigint, $4::jsonb, $5::jsonb, $6::jsonb, $7::text
    ) as receipt
  `, [batchId, ownerId, leaseFence, page, observations, jobs, TOKEN])).receipt;
}

async function commitBatch(db, { batchId, ownerId, leaseFence }) {
  return (await one(db, `
    select public.commit_source_ingest_batch(
      $1::uuid, $2::text, $3::bigint, $4::text
    ) as receipt
  `, [batchId, ownerId, leaseFence, TOKEN])).receipt;
}

async function claimProcessingJobs(db, {
  workerId,
  processorVersion,
  sourceSystem = "gmail",
  connectionKey = CONNECTION,
  jobKinds = [],
  limit = 10,
}) {
  return (await one(db, `
    select public.claim_source_processing_jobs(
      $1::text, $2::text, $3::text, $4::text, $5::text,
      $6::integer, 120::integer, $7::text[], $8::text
    ) as receipt
  `, [WORKSPACE, sourceSystem, connectionKey, workerId, processorVersion, limit, jobKinds, TOKEN])).receipt;
}

async function completeProcessingJob(db, {
  jobId,
  workerId,
  leaseFence,
  processorVersion,
  result,
  observations,
  childJobs,
}) {
  return (await one(db, `
    select public.complete_source_processing_job(
      $1::uuid, $2::text, $3::bigint, $4::text,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::text
    ) as receipt
  `, [
    jobId,
    workerId,
    leaseFence,
    processorVersion,
    result,
    observations,
    childJobs,
    TOKEN,
  ])).receipt;
}

async function renewProcessingJob(db, {
  jobId,
  workerId,
  leaseFence,
  processorVersion,
  leaseSeconds = 600,
}) {
  return (await one(db, `
    select public.renew_source_processing_job_lease(
      $1::uuid, $2::text, $3::bigint, $4::text, $5::integer, $6::text
    ) as receipt
  `, [jobId, workerId, leaseFence, processorVersion, leaseSeconds, TOKEN])).receipt;
}

async function failProcessingJob(db, {
  jobId,
  workerId,
  leaseFence,
  processorVersion,
  errorCode,
  safeErrorDetail,
  retryAfterSeconds = null,
}) {
  return (await one(db, `
    select public.fail_source_processing_job(
      $1::uuid, $2::text, $3::bigint, $4::text,
      $5::text, $6::text, $7::integer, $8::text
    ) as receipt
  `, [
    jobId,
    workerId,
    leaseFence,
    processorVersion,
    errorCode,
    safeErrorDetail,
    retryAfterSeconds,
    TOKEN,
  ])).receipt;
}

async function verifyJournal(db) {
  const owner = "journal-worker-1";
  const lease = await acquire(db, owner);
  assert.equal(lease.ok, true);
  assert.equal(lease.cursorValue, "");
  assert.equal(lease.cursorVersion, 0);

  const sameLease = await acquire(db, owner);
  assert.equal(sameLease.idempotent, true);
  assert.equal(sameLease.leaseFence, lease.leaseFence);

  const busy = await acquire(db, "journal-worker-competing");
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "LEASE_BUSY");

  const batch = await beginBatch(db, owner, lease.leaseFence, "backfill");
  assert.equal(batch.pageCount, 0);
  assert.equal(batch.resumePageToken, "");
  assert.equal(batch.finalPagePersisted, false);

  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: "200",
    firstHistoryId: "",
    lastHistoryId: "",
    providerResponse: {
      historyId: "200",
      messages: [{ id: "message-1", threadId: "thread-1" }],
    },
    providerEvents: [{
      eventId: EVENT_A,
      schemaVersion: "gmail-history-event-v1",
      eventType: "message_discovered",
      historyId: "200",
      messageId: "message-1",
      threadId: "thread-1",
      messageLabelIds: [],
      changedLabelIds: [],
    }],
    isFinal: true,
  };
  const observations = [{
    observationId: OBS_A,
    sourceObjectType: "gmail_message_discovered",
    sourceObjectId: "message-1",
    sourceRevision: "backfill:200",
    operation: "content",
    contentHash: HASH_B,
    sourceRecordedAt: null,
    normalizedPayload: {
      eventId: EVENT_A,
      eventType: "message_discovered",
      historyId: "200",
      messageId: "message-1",
      threadId: "thread-1",
    },
    normalizedText: "",
    sourceFidelity: "normalized_source",
    schemaVersion: "source-observation-v1",
  }];
  const jobs = [{
    dedupeKey: "gmail-fetch-raw:v1:message-1",
    jobKind: "gmail_fetch_raw_message",
    observationId: OBS_A,
    sourceObjectId: "message-1",
    maxAttempts: 10,
    payload: { messageId: "message-1" },
  }];

  const appended = await appendPage(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
    page,
    observations,
    jobs,
  });
  assert.match(appended.eventDigest, /^[0-9a-f]{64}$/);
  assert.equal(appended.observationCount, 1);
  assert.equal(appended.jobCount, 1);

  const replayed = await appendPage(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
    page,
    observations,
    jobs,
  });
  assert.equal(replayed.eventDigest, appended.eventDigest);

  const resumed = await beginBatch(db, owner, lease.leaseFence, "backfill");
  assert.equal(resumed.pageCount, 1);
  assert.equal(resumed.finalPagePersisted, true);
  assert.equal(resumed.responseMailboxHistoryId, "200");

  const committed = await commitBatch(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
  });
  assert.equal(committed.committedCursorValue, "200");
  assert.equal(committed.committedCursorVersion, 1);
  assert.equal(committed.observationCount, 1);
  assert.equal(committed.jobCount, 1);

  const committedRetry = await commitBatch(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
  });
  assert.equal(committedRetry.idempotent, true);
  assert.equal(committedRetry.batchHash, committed.batchHash);

  await expectSqlState(
    db.exec(`update public.source_observations set normalized_text = 'mutated' where observation_id = '${OBS_A}'`),
    "55000",
    "source observations must be immutable",
  );

  return { observationId: OBS_A, contentHash: HASH_B, cursorValue: "200", cursorVersion: 1 };
}

async function verifyProcessingJobs(db, journal) {
  const rawWorker = "raw-worker-1";
  const rawVersion = "gmail-raw-worker-v1";
  const claimed = await claimProcessingJobs(db, {
    workerId: rawWorker,
    processorVersion: rawVersion,
    jobKinds: ["gmail_fetch_raw_message"],
  });
  assert.equal(claimed.claimedCount, 1);
  const rawJob = claimed.jobs[0];
  assert.equal(rawJob.sourceCursorValue, journal.cursorValue);
  assert.equal(rawJob.sourceCursorVersion, journal.cursorVersion);
  assert.equal(rawJob.observationId, journal.observationId);
  const renewed = await renewProcessingJob(db, {
    jobId: rawJob.jobId,
    workerId: rawWorker,
    leaseFence: rawJob.leaseFence,
    processorVersion: rawVersion,
  });
  assert.equal(renewed.leaseFence, rawJob.leaseFence);
  assert.equal(renewed.state, "leased");

  const rawObservation = {
    observationId: OBS_F,
    sourceObjectType: "gmail_message_raw",
    sourceObjectId: "message-1",
    sourceRevision: "200",
    operation: "content",
    contentHash: HASH_F,
    normalizedPayload: {
      schemaVersion: "gmail-raw-message-v1",
      messageId: "message-1",
      threadId: "thread-1",
      historyId: "200",
    },
    normalizedText: "",
    rawObject: {
      bucket: "private-truth-evidence",
      key: `truth-raw/v1/${HASH_F}`,
      version: "storage-version-1",
      etag: "storage-etag-1",
      hash: HASH_F,
      bytes: 128,
      contentType: "message/rfc822",
    },
    sourceFidelity: "raw",
    schemaVersion: "gmail-raw-message-v1",
  };
  const parseChild = {
    dedupeKey: `gmail:parse-rfc822:v1:${HASH_F}`,
    jobKind: "gmail_parse_rfc822",
    observationId: OBS_F,
    sourceObjectId: "message-1",
    maxAttempts: 5,
    payload: {
      schemaVersion: "gmail-parse-rfc822-job-v1",
      rawObservationId: OBS_F,
    },
  };
  const rawCompletionArgs = {
    jobId: rawJob.jobId,
    workerId: rawWorker,
    leaseFence: rawJob.leaseFence,
    processorVersion: rawVersion,
    result: { rawSha256: HASH_F },
    observations: [rawObservation],
    childJobs: [parseChild],
  };
  const rawCompleted = await completeProcessingJob(db, rawCompletionArgs);
  assert.equal(rawCompleted.idempotent, false);
  assert.deepEqual(rawCompleted.resultObservationIds, [OBS_F]);
  assert.equal(rawCompleted.childJobs.length, 1);
  assert.equal(rawCompleted.sourceCursorValue, journal.cursorValue);
  const rawReplay = await completeProcessingJob(db, rawCompletionArgs);
  assert.equal(rawReplay.idempotent, true);
  assert.equal(rawReplay.completionHash, rawCompleted.completionHash);

  const parseWorker = "parse-worker-1";
  const parseVersion = "gmail-rfc822-parser-v1";
  const parseClaim = await claimProcessingJobs(db, {
    workerId: parseWorker,
    processorVersion: parseVersion,
    jobKinds: ["gmail_parse_rfc822"],
  });
  assert.equal(parseClaim.claimedCount, 1);
  const parseJob = parseClaim.jobs[0];
  assert.equal(parseJob.parentJobId, rawJob.jobId);
  assert.equal(parseJob.rootJobId, rawJob.jobId);
  const parsedObservation = {
    observationId: OBS_G,
    sourceObjectType: "gmail_message_parsed",
    sourceObjectId: "message-1",
    sourceRevision: "200",
    operation: "content",
    contentHash: HASH_G,
    normalizedPayload: {
      schemaVersion: "gmail-parsed-message-v1",
      parserVersion: parseVersion,
      gmail: { messageId: "message-1", threadId: "thread-1", historyId: "200" },
      subject: "Customs released",
      text: "Customs released. Delivery order attached.",
      attachments: [],
    },
    normalizedText: "Subject: Customs released\nCustoms released. Delivery order attached.",
    sourceFidelity: "normalized_source",
    schemaVersion: "gmail-parsed-message-v1",
  };
  const parseCompleted = await completeProcessingJob(db, {
    jobId: parseJob.jobId,
    workerId: parseWorker,
    leaseFence: parseJob.leaseFence,
    processorVersion: parseVersion,
    result: { parserVersion: parseVersion, parsedContentHash: HASH_G },
    observations: [parsedObservation],
    childJobs: [],
  });
  assert.equal(parseCompleted.state, "succeeded");

  await expectSqlState(
    db.query(`update public.source_processing_job_observations set ordinal = 9 where job_id = $1::uuid`, [rawJob.jobId]),
    "55000",
    "source-processing result membership must be immutable",
  );

  return {
    observations: [
      { observationId: journal.observationId, contentHash: journal.contentHash },
      { observationId: OBS_F, contentHash: HASH_F },
      { observationId: OBS_G, contentHash: HASH_G },
    ],
  };
}

function relationalTmsSnapshot() {
  const shipments = [
    {
      order: "1001",
      shipmentNumber: "1001",
      shipmentGuid: "12735e33-f515-4e53-98ae-239e26ee8bbc",
      trackingNumber: "01680000083",
      status: "ARRIVED",
      detailPullStatus: "success",
      detailTitle: "CourierSpace Transportation Management System",
      detailUrl: "https://tms.example/Order_Edit.aspx?ShipmentGUID=12735e33-f515-4e53-98ae-239e26ee8bbc",
    },
    {
      order: "1002",
      shipmentNumber: "1002",
      shipmentGuid: "22735e33-f515-4e53-98ae-239e26ee8bbc",
      trackingNumber: "11480000250",
      status: "IN_TRANSIT",
      detailPullStatus: "success",
      detailTitle: "CourierSpace Transportation Management System",
      detailUrl: "https://tms.example/Order_Edit.aspx?ShipmentGUID=22735e33-f515-4e53-98ae-239e26ee8bbc",
    },
  ];
  return {
    snapshotTime: "2026-07-09T20:00:00.000Z",
    visibleTaskCount: shipments.length,
    orderLinkCount: shipments.length,
    scopeAudit: {
      source: "relational contract TMS fixture",
      url: "https://tms.example/OpsLog.aspx?CurrentTab=0",
      title: "Operations Log",
      activeTab: "OPS TLV-US / CurrentTab=0",
      visibleTaskCount: shipments.length,
      orderLinkCount: shipments.length,
      gridRows: shipments.length,
      detailRows: shipments.length,
      filters: { task: "all" },
    },
    shipments,
  };
}

async function verifyGenericSourceSnapshot(db) {
  const sourceSystem = "tms";
  const connectionKey = "primary";
  const ownerId = "tms-snapshot-worker";
  const cursorKind = "tms_snapshot_timestamp";
  const built = buildTmsSourceSnapshot(relationalTmsSnapshot(), {
    workspaceKey: WORKSPACE,
    connectionKey,
    extractorVersion: "tms-extract-claims-v1",
  });
  const nextCursorValue = built.nextCursorValue;
  const recoveryInput = {
    sourceSystem,
    connectionKey,
    nextCursorValue,
    providerManifest: built.providerManifest,
    observations: built.observations,
    jobs: built.jobs,
  };
  const beforeCommit = await recoverSourceSnapshot(db, recoveryInput);
  assert.equal(beforeCommit.found, false);
  assert.match(beforeCommit.payloadIdentityHash, /^[0-9a-f]{64}$/);

  const lease = await acquireSource(db, {
    sourceSystem,
    connectionKey,
    ownerId,
    cursorKind,
  });
  assert.equal(lease.cursorValue, "");
  const batch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey,
    ownerId,
    leaseFence: lease.leaseFence,
  });
  const commitArgs = {
    batchId: batch.batchId,
    ownerId,
    leaseFence: lease.leaseFence,
    ...recoveryInput,
  };
  const committed = await commitSourceSnapshot(db, commitArgs);
  assert.equal(committed.idempotent, false);
  assert.equal(committed.committedCursorValue, nextCursorValue);
  assert.equal(committed.observationCount, built.observations.length);
  assert.equal(committed.jobCount, built.jobs.length);

  const recovered = await recoverSourceSnapshot(db, recoveryInput);
  assert.equal(recovered.found, true);
  assert.equal(recovered.batchId, batch.batchId);
  assert.equal(recovered.batchHash, committed.batchHash);
  const replay = await commitSourceSnapshot(db, commitArgs);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.batchHash, committed.batchHash);
  await expectSqlState(
    commitSourceSnapshot(db, {
      ...commitArgs,
      providerManifest: { ...built.providerManifest, sourceRunId: "conflicting-replay" },
    }),
    "23505",
    "a committed source snapshot cannot replay under a different provider manifest",
  );

  // Simulate a process that lost the successful commit response, restarted,
  // skipped preflight, and created a new batch at the already advanced cursor.
  const restartLease = await acquireSource(db, {
    sourceSystem,
    connectionKey,
    ownerId: "tms-restarted-worker",
    cursorKind,
  });
  const restartBatch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey,
    ownerId: "tms-restarted-worker",
    leaseFence: restartLease.leaseFence,
  });
  const recoveredAtCommit = await commitSourceSnapshot(db, {
    ...commitArgs,
    batchId: restartBatch.batchId,
    ownerId: "tms-restarted-worker",
    leaseFence: restartLease.leaseFence,
  });
  assert.equal(recoveredAtCommit.recovered, true);
  assert.equal(recoveredAtCommit.batchId, batch.batchId);
  assert.equal(recoveredAtCommit.supersededBatchId, restartBatch.batchId);
  const superseded = await one(db, `
    select status from public.source_ingest_batches where batch_id = $1::uuid
  `, [restartBatch.batchId]);
  assert.equal(superseded.status, "superseded");
  const unchangedCursor = await one(db, `
    select cursor_value, cursor_version from public.source_cursors
    where workspace_key = $1::text and source_system = 'tms' and connection_key = $2::text
  `, [WORKSPACE, connectionKey]);
  assert.equal(unchangedCursor.cursor_value, nextCursorValue);
  assert.equal(Number(unchangedCursor.cursor_version), 1);

  // Missing extraction coverage is definitive, leaves the cursor untouched,
  // and can be durably classified by the explicit failure RPC.
  const zeroConnection = "tms-zero-jobs";
  const zeroLease = await acquireSource(db, {
    sourceSystem,
    connectionKey: zeroConnection,
    ownerId,
    cursorKind,
  });
  const zeroBatch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey: zeroConnection,
    ownerId,
    leaseFence: zeroLease.leaseFence,
  });
  await expectSqlState(
    commitSourceSnapshot(db, {
      ...commitArgs,
      batchId: zeroBatch.batchId,
      leaseFence: zeroLease.leaseFence,
      jobs: [],
    }),
    "23514",
    "TMS observations require one extraction job each",
  );
  const failed = await failSourceSnapshot(db, {
    batchId: zeroBatch.batchId,
    ownerId,
    leaseFence: zeroLease.leaseFence,
    errorCode: "TMS_JOB_COVERAGE_INVALID",
    safeErrorDetail: "The source snapshot lacked one-to-one extraction-job coverage.",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.cursorValue, "");
  assert.equal(failed.cursorVersion, 0);
  const failedEvidence = await one(db, `
    select batch.status, batch.error_code, cursor.cursor_value, cursor.cursor_version
    from public.source_ingest_batches batch
    join public.source_cursors cursor using (workspace_key, source_system, connection_key)
    where batch.batch_id = $1::uuid
  `, [zeroBatch.batchId]);
  assert.equal(failedEvidence.status, "failed");
  assert.equal(failedEvidence.error_code, "TMS_JOB_COVERAGE_INVALID");
  assert.equal(failedEvidence.cursor_value, "");
  assert.equal(Number(failedEvidence.cursor_version), 0);
  const failedCursor = await one(db, `
    select status from public.source_cursors
    where workspace_key = $1::text and source_system = 'tms' and connection_key = $2::text
  `, [WORKSPACE, zeroConnection]);
  assert.equal(failedCursor.status, "error");

  const recoverySnapshot = relationalTmsSnapshot();
  recoverySnapshot.snapshotTime = "2026-07-09T20:05:00.000Z";
  const recoveryBuilt = buildTmsSourceSnapshot(recoverySnapshot, {
    workspaceKey: WORKSPACE,
    connectionKey: zeroConnection,
    extractorVersion: "tms-extract-claims-v1",
  });
  const recoveryLease = await acquireSource(db, {
    sourceSystem,
    connectionKey: zeroConnection,
    ownerId: "tms-recovery-worker",
    cursorKind,
  });
  assert.equal(recoveryLease.status, "error");
  await expectSqlState(
    beginSourceBatch(db, {
      sourceSystem,
      connectionKey: zeroConnection,
      ownerId: "tms-recovery-worker",
      leaseFence: recoveryLease.leaseFence,
      mode: "snapshot",
    }),
    "23514",
    "an error cursor cannot silently resume through normal snapshot mode",
  );
  const recoveryBatch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey: zeroConnection,
    ownerId: "tms-recovery-worker",
    leaseFence: recoveryLease.leaseFence,
    mode: "snapshot_recovery",
  });
  const recoveryCommit = await commitSourceSnapshot(db, {
    batchId: recoveryBatch.batchId,
    ownerId: "tms-recovery-worker",
    leaseFence: recoveryLease.leaseFence,
    nextCursorValue: recoveryBuilt.nextCursorValue,
    providerManifest: recoveryBuilt.providerManifest,
    observations: recoveryBuilt.observations,
    jobs: recoveryBuilt.jobs,
  });
  assert.equal(recoveryCommit.idempotent, false);
  const resolvedFailure = await one(db, `
    select cursor.status, count(resolution.failure_id)::integer as resolution_count
    from public.source_cursors cursor
    join public.source_snapshot_failures failure
      on failure.workspace_key = cursor.workspace_key
     and failure.source_system = cursor.source_system
     and failure.connection_key = cursor.connection_key
    left join public.source_snapshot_failure_resolutions resolution
      on resolution.failure_id = failure.failure_id
    where cursor.workspace_key = $1::text
      and cursor.source_system = 'tms' and cursor.connection_key = $2::text
    group by cursor.status
  `, [WORKSPACE, zeroConnection]);
  assert.equal(resolvedFailure.status, "live");
  assert.equal(resolvedFailure.resolution_count, 1);
  const retainedFailure = await one(db, `
    select failure_stage, error_code from public.source_snapshot_failures
    where failure_id = $1::uuid
  `, [failed.failureId]);
  assert.equal(retainedFailure.failure_stage, "commit");
  assert.equal(retainedFailure.error_code, "TMS_JOB_COVERAGE_INVALID");
  await expectSqlState(
    db.query(`update public.source_snapshot_failures set error_code = 'ERASED' where failure_id = $1::uuid`, [failed.failureId]),
    "55000",
    "source recovery resolves but cannot erase immutable failure evidence",
  );

  const badLineageConnection = "tms-bad-lineage";
  const badLineageLease = await acquireSource(db, {
    sourceSystem,
    connectionKey: badLineageConnection,
    ownerId,
    cursorKind,
  });
  const badLineageBatch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey: badLineageConnection,
    ownerId,
    leaseFence: badLineageLease.leaseFence,
  });
  const badJobs = structuredClone(built.jobs);
  badJobs[0].sourceObjectId = "different-shipment";
  await expectSqlState(
    commitSourceSnapshot(db, {
      ...commitArgs,
      batchId: badLineageBatch.batchId,
      leaseFence: badLineageLease.leaseFence,
      jobs: badJobs,
    }),
    "23514",
    "job source identity must match its observation",
  );
  const badManifest = structuredClone(built.providerManifest);
  badManifest.rows[0].trackingNumber = "tampered-tracking";
  await expectSqlState(
    commitSourceSnapshot(db, {
      ...commitArgs,
      batchId: badLineageBatch.batchId,
      leaseFence: badLineageLease.leaseFence,
      providerManifest: badManifest,
    }),
    "23514",
    "TMS row-manifest hash and observation mapping must be SQL-verified",
  );
  await failSourceSnapshot(db, {
    batchId: badLineageBatch.batchId,
    ownerId,
    leaseFence: badLineageLease.leaseFence,
    errorCode: "TMS_LINEAGE_INVALID",
    safeErrorDetail: "The TMS snapshot failed source-lineage validation.",
  });

  const preflightConnection = "tms-preflight-incomplete";
  const preflightFailure = await recordSourcePreflightFailure(db, {
    sourceSystem,
    connectionKey: preflightConnection,
    cursorKind,
    ownerId,
    errorCode: "TMS_SOURCE_SNAPSHOT_INCOMPLETE",
    safeErrorDetail: "The TMS pull failed structural completeness checks before ingestion.",
    diagnostics: { issueCount: 1, issueCodes: ["detail_pull_failed"] },
  });
  assert.equal(preflightFailure.status, "error");
  assert.equal(preflightFailure.cursorAdvanced, false);
  assert.equal(preflightFailure.cursorValue, "");
  assert.equal(preflightFailure.cursorVersion, 0);
  const preflightWitness = await one(db, `
    select failure.failure_stage, cursor.status, cursor.last_error_code
    from public.source_snapshot_failures failure
    join public.source_cursors cursor using (workspace_key, source_system, connection_key)
    where failure.failure_id = $1::uuid
  `, [preflightFailure.failureId]);
  assert.equal(preflightWitness.failure_stage, "preflight");
  assert.equal(preflightWitness.status, "error");
  assert.equal(preflightWitness.last_error_code, "TMS_SOURCE_SNAPSHOT_INCOMPLETE");

  for (const status of ["paused", "reconcile_required", "error"]) {
    const statusConnection = `tms-${status}`;
    const statusLease = await acquireSource(db, {
      sourceSystem,
      connectionKey: statusConnection,
      ownerId,
      cursorKind,
    });
    await db.query(`
      update public.source_cursors set status = $1::text
      where workspace_key = $2::text and source_system = 'tms' and connection_key = $3::text
    `, [status, WORKSPACE, statusConnection]);
    await expectSqlState(
      beginSourceBatch(db, {
        sourceSystem,
        connectionKey: statusConnection,
        ownerId,
        leaseFence: statusLease.leaseFence,
      }),
      "23514",
      `${status} TMS cursor cannot be activated by snapshot begin`,
    );
  }

  const wrongKindConnection = "tms-wrong-cursor-kind";
  const wrongKindLease = await acquireSource(db, {
    sourceSystem,
    connectionKey: wrongKindConnection,
    ownerId,
    cursorKind: "opaque",
  });
  await expectSqlState(
    beginSourceBatch(db, {
      sourceSystem,
      connectionKey: wrongKindConnection,
      ownerId,
      leaseFence: wrongKindLease.leaseFence,
    }),
    "23514",
    "TMS cursor kinds are source-specific",
  );

  const tmsClaim = await claimProcessingJobs(db, {
    sourceSystem,
    connectionKey,
    workerId: "tms-claim-worker",
    processorVersion: "tms-extract-claims-v1",
    jobKinds: ["tms_extract_claims"],
  });
  assert.equal(tmsClaim.claimedCount, built.jobs.length);
  for (const job of tmsClaim.jobs) {
    const completed = await completeProcessingJob(db, {
      jobId: job.jobId,
      workerId: "tms-claim-worker",
      leaseFence: job.leaseFence,
      processorVersion: "tms-extract-claims-v1",
      result: { candidateClaimCount: 0 },
      observations: [],
      childJobs: [],
    });
    assert.equal(completed.state, "succeeded");
  }

  const gapConnection = "tms-preflight-gap-witness";
  const gapBuilt = buildTmsSourceSnapshot(relationalTmsSnapshot(), {
    workspaceKey: WORKSPACE,
    connectionKey: gapConnection,
    extractorVersion: "tms-extract-claims-v1",
  });
  const gapLease = await acquireSource(db, {
    sourceSystem,
    connectionKey: gapConnection,
    ownerId,
    cursorKind,
  });
  const gapBatch = await beginSourceBatch(db, {
    sourceSystem,
    connectionKey: gapConnection,
    ownerId,
    leaseFence: gapLease.leaseFence,
  });
  await commitSourceSnapshot(db, {
    batchId: gapBatch.batchId,
    ownerId,
    leaseFence: gapLease.leaseFence,
    nextCursorValue: gapBuilt.nextCursorValue,
    providerManifest: gapBuilt.providerManifest,
    observations: gapBuilt.observations,
    jobs: gapBuilt.jobs,
  });
  const gapJobs = await claimProcessingJobs(db, {
    sourceSystem,
    connectionKey: gapConnection,
    workerId: "tms-gap-worker",
    processorVersion: "tms-extract-claims-v1",
    jobKinds: ["tms_extract_claims"],
  });
  for (const job of gapJobs.jobs) {
    await completeProcessingJob(db, {
      jobId: job.jobId,
      workerId: "tms-gap-worker",
      leaseFence: job.leaseFence,
      processorVersion: "tms-extract-claims-v1",
      result: { candidateClaimCount: 0 },
      observations: [],
      childJobs: [],
    });
  }
  await recordSourcePreflightFailure(db, {
    sourceSystem,
    connectionKey: gapConnection,
    cursorKind,
    ownerId,
    errorCode: "TMS_SOURCE_SNAPSHOT_INCOMPLETE",
    safeErrorDetail: "The subsequent TMS pull was structurally incomplete.",
    diagnostics: { issueCount: 1 },
  });
  const staleRecovery = await recoverSourceSnapshot(db, {
    sourceSystem,
    connectionKey: gapConnection,
    nextCursorValue: gapBuilt.nextCursorValue,
    providerManifest: gapBuilt.providerManifest,
    observations: gapBuilt.observations,
    jobs: gapBuilt.jobs,
  });
  assert.equal(staleRecovery.found, false);
  assert.equal(staleRecovery.requiresRecovery, true, "an old committed payload cannot clear a newer source error");
  const degradedCut = (await one(db, `
    select public.seal_source_cut(
      $1::text, 'source-cut-manifest-v2'::text, $2::jsonb, '[]'::jsonb,
      $3::jsonb, $4::jsonb, 'relational-contract-test'::text, $5::text
    ) as receipt
  `, [
    WORKSPACE,
    [{ sourceSystem, connectionKey: gapConnection }],
    [{
      sourceSystem,
      connectionKey: gapConnection,
      cursorKind,
      throughCursorVersion: "1",
      throughCursorValue: gapBuilt.nextCursorValue,
      upstreamWatermark: gapBuilt.providerManifest.upstreamWatermark,
      sourceSnapshotAt: gapBuilt.providerManifest.sourceSnapshotAt,
    }],
    [],
    TOKEN,
  ])).receipt;
  assert.equal(degradedCut.completeness, "degraded");
  assert.ok(degradedCut.gaps.some((gap) =>
    gap.gapType === "SOURCE_CURSOR_NOT_LIVE" && gap.status === "error"));

  await expectSqlState(
    db.query(`update public.source_ingest_manifests set next_cursor_value = 'mutated' where batch_id = $1::uuid`, [batch.batchId]),
    "55000",
    "source provider manifests must be immutable",
  );
  return {
    sourceSystem,
    connectionKey,
    cursorKind,
    cursorValue: nextCursorValue,
    cursorVersion: 1,
    sourceSnapshotAt: built.providerManifest.sourceSnapshotAt,
    upstreamWatermark: built.providerManifest.upstreamWatermark,
    observations: built.observations.map((item) => ({
      observationId: item.observationId,
      contentHash: item.contentHash,
    })),
  };
}

async function verifySourceCut(db, journal, processing, tms) {
  const parameters = [
    WORKSPACE,
    "source-cut-manifest-v2",
    [
      { sourceSystem: "gmail", connectionKey: CONNECTION },
      { sourceSystem: tms.sourceSystem, connectionKey: tms.connectionKey },
    ],
    [],
    [
      {
        sourceSystem: "gmail",
        connectionKey: CONNECTION,
        cursorKind: "gmail_history_id",
        throughCursorVersion: String(journal.cursorVersion),
        throughCursorValue: journal.cursorValue,
        upstreamWatermark: journal.cursorValue,
        sourceSnapshotAt: "2026-07-09T20:00:00.000Z",
      },
      {
        sourceSystem: tms.sourceSystem,
        connectionKey: tms.connectionKey,
        cursorKind: tms.cursorKind,
        throughCursorVersion: String(tms.cursorVersion),
        throughCursorValue: tms.cursorValue,
        upstreamWatermark: tms.cursorValue,
        sourceSnapshotAt: tms.sourceSnapshotAt,
      },
    ],
    [],
    "relational-contract-test",
    TOKEN,
  ];
  const forgedCursors = structuredClone(parameters[4]);
  const forgedTms = forgedCursors.find((item) => item.sourceSystem === "tms");
  forgedTms.upstreamWatermark = "INVENTED-WATERMARK";
  forgedTms.sourceSnapshotAt = "2099-01-01T00:00:00.000Z";
  await expectSqlState(
    one(db, `
      select public.seal_source_cut(
        $1::text, $2::text, $3::jsonb, $4::jsonb,
        $5::jsonb, $6::jsonb, $7::text, $8::text
      ) as receipt
    `, [
      parameters[0], parameters[1], [parameters[2][0]], parameters[3],
      parameters[4], parameters[5], parameters[6], parameters[7],
    ]),
    "23514",
    "required sources and cursor partitions must be the same exact vector",
  );
  await expectSqlState(
    one(db, `
      select public.seal_source_cut(
        $1::text, $2::text, $3::jsonb, $4::jsonb,
        $5::jsonb, $6::jsonb, $7::text, $8::text
      ) as receipt
    `, [
      parameters[0], parameters[1], parameters[2], parameters[3],
      forgedCursors, parameters[5], parameters[6], parameters[7],
    ]),
    "23514",
    "source-cut freshness must be derived from the committed provider manifest",
  );
  const receipt = (await one(db, `
    select public.seal_source_cut(
      $1::text, $2::text, $3::jsonb, $4::jsonb,
      $5::jsonb, $6::jsonb, $7::text, $8::text
    ) as receipt
  `, parameters)).receipt;
  assert.equal(receipt.completeness, "complete");
  assert.match(receipt.sourceCutId, /^cut:v1:[0-9a-f]{64}$/);
  assert.equal(receipt.observationCount, processing.observations.length + tms.observations.length);
  assert.deepEqual(receipt.gaps, []);
  assert.equal(Object.hasOwn(receipt.manifest, "observations"), false);
  assert.equal(receipt.manifest.partitionWitnessVersion, "source-cut-partition-witness-v1");
  assert.equal(receipt.manifest.cursors.reduce((sum, item) => sum + item.observationCount, 0), receipt.observationCount);
  assert.equal(receipt.manifest.cursors.every((item) => item.emptyScope === (item.observationCount === 0)), true);
  const deprecatedMembership = await one(db, `
    select count(*)::integer as count from public.source_cut_observations
    where source_cut_id = $1::text
  `, [receipt.sourceCutId]);
  assert.equal(deprecatedMembership.count, 0);

  const replay = (await one(db, `
    select public.seal_source_cut(
      $1::text, $2::text, $3::jsonb, $4::jsonb,
      $5::jsonb, $6::jsonb, $7::text, $8::text
    ) as receipt
  `, parameters)).receipt;
  assert.equal(replay.sourceCutId, receipt.sourceCutId);
  assert.equal(replay.manifestHash, receipt.manifestHash);

  const partialBatch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      lease_owner, lease_fence, status
    ) values (
      $1::text, 'gmail', $2::text, 'history', 'partial-cut-adversary',
      $3::bigint, $4::text, 'partial-cut-adversary', 1, 'running'
    ) returning batch_id
  `, [WORKSPACE, CONNECTION, journal.cursorVersion, journal.cursorValue]);
  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, normalized_payload,
      normalized_text, source_fidelity, schema_version
    ) values (
      $1::text, $2::text, 'gmail', $3::text,
      'gmail_message', 'partial-uncommitted-message', 'partial', 'content',
      $4::bigint, $5::uuid, $6::text, '{}'::jsonb,
      'uncommitted partial evidence', 'normalized_source', 'source-observation-v1'
    )
  `, [`obs:v1:${"5".repeat(64)}`, WORKSPACE, CONNECTION, journal.cursorVersion, partialBatch.batch_id, "6".repeat(64)]);
  const partialCut = (await one(db, `
    select public.seal_source_cut(
      $1::text, $2::text, $3::jsonb, $4::jsonb,
      $5::jsonb, $6::jsonb, $7::text, $8::text
    ) as receipt
  `, parameters)).receipt;
  assert.equal(partialCut.completeness, "degraded");
  assert.ok(partialCut.gaps.some((gap) =>
    gap.gapType === "SOURCE_INGEST_BATCH_UNCOMMITTED" &&
    gap.batchId === partialBatch.batch_id));
  assert.ok(partialCut.gaps.some((gap) =>
    gap.gapType === "SOURCE_JOURNAL_FENCE_MISMATCH" &&
    gap.sourceSystem === "gmail"));
  await db.query(`
    update public.source_ingest_batches
    set status = 'superseded', finished_at = clock_timestamp()
    where batch_id = $1::uuid
  `, [partialBatch.batch_id]);

  await expectSqlState(
    one(db, `
      select public.seal_source_cut(
        $1::text, $2::text, $3::jsonb, $4::jsonb,
        $5::jsonb, $6::jsonb, $7::text, $8::text
      ) as receipt
    `, [
      ...parameters.slice(0, 5),
      [{ observationId: processing.observations[0].observationId, contentHash: processing.observations[0].contentHash }],
      ...parameters.slice(6),
    ]),
    "23514",
    "source-cut v2 rejects caller-supplied observation enumeration",
  );

  const emptyConnection = "verified-empty-mailbox";
  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence
    ) values ($1::text, 'gmail', $2::text, 'gmail_history_id', '0', 0, 'backfill_required', 0)
  `, [WORKSPACE, emptyConnection]);
  const emptyBatch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      $1::text, 'gmail', $2::text, 'backfill', 'verified-empty-scope',
      0, '0', 1, '1', 'verified-empty-scope', 1, 'committed', $3::text,
      1, 0, 0, clock_timestamp(), clock_timestamp()
    ) returning batch_id
  `, [WORKSPACE, emptyConnection, "7".repeat(64)]);
  await db.query(`
    update public.source_cursors
    set cursor_value = '1', cursor_version = 1, status = 'live',
        last_batch_id = $3::uuid, last_committed_at = clock_timestamp()
    where workspace_key = $1::text and source_system = 'gmail' and connection_key = $2::text
  `, [WORKSPACE, emptyConnection, emptyBatch.batch_id]);
  const emptyCut = (await one(db, `
    select public.seal_source_cut(
      $1::text, 'source-cut-manifest-v2'::text,
      $2::jsonb, '[]'::jsonb, $3::jsonb, '[]'::jsonb,
      'verified-empty-scope'::text, $4::text
    ) as receipt
  `, [
    WORKSPACE,
    [{ sourceSystem: "gmail", connectionKey: emptyConnection }],
    [{
      sourceSystem: "gmail",
      connectionKey: emptyConnection,
      cursorKind: "gmail_history_id",
      throughCursorVersion: "1",
      throughCursorValue: "1",
      upstreamWatermark: "1",
      sourceSnapshotAt: "2026-07-09T20:00:00.000Z",
    }],
    TOKEN,
  ])).receipt;
  assert.equal(emptyCut.completeness, "complete");
  assert.equal(emptyCut.observationCount, 0);
  assert.equal(emptyCut.manifest.cursors[0].emptyScope, true);
  assert.equal(emptyCut.manifest.cursors[0].partitionHash,
    "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945");

  return receipt;
}

async function verifyBuildAndPublication(db, sourceCut) {
  const claimArgs = [
    WORKSPACE,
    {
      claimKey: "shipment:123:customs_release",
      versionNo: 1,
      primaryObservationId: OBS_G,
      subjectType: "shipment",
      subjectKey: "123",
      predicate: "customs_release",
      gate: "release",
      polarity: "positive",
      normalizedValue: { released: true },
      occurredAt: "2026-07-09T19:00:00Z",
      confidence: 0.99,
      confidenceLabel: "high",
      extractionMethod: "deterministic",
      extractorVersion: "extractor-v1",
      promptVersion: "",
      model: "",
      acceptanceMethod: "policy",
      acceptancePolicyVersion: "acceptance-v1",
      acceptedBy: "relational-contract-test",
      decision: "accepted",
      evidenceSpan: { start: 27, end: 44 },
      recordedAt: "2026-07-09T20:01:00Z",
      schemaVersion: "accepted-claim-v1",
    },
    [{ observationId: OBS_G, evidenceRole: "primary", evidenceSpan: { start: 27, end: 44 } }],
    TOKEN,
  ];
  const appendClaimSql = `
    select public.append_accepted_claim(
      $1::text, $2::jsonb, $3::jsonb, '[]'::jsonb, $4::text
    ) as receipt
  `;
  const claimReceipt = (await one(db, appendClaimSql, claimArgs)).receipt;
  assert.match(claimReceipt.claimVersionId, /^claim:v1:[0-9a-f]{64}$/);
  assert.match(claimReceipt.itemHash, /^[0-9a-f]{64}$/);
  const claimVersionId = claimReceipt.claimVersionId;
  const claimReplay = (await one(db, appendClaimSql, claimArgs)).receipt;
  assert.equal(claimReplay.idempotent, true);
  assert.equal(claimReplay.itemHash, claimReceipt.itemHash);

  const versions = {
    extractorSetVersion: "extractor-set-v1",
    linkerVersion: "linker-v1",
    reducerVersion: "canonical-reducer-v1",
    packetBuilderVersion: "packet-builder-v1",
    packetSchemaVersion: "truth-packet-v2",
  };
  await expectSqlState(
    one(db, `
      select public.begin_truth_build(
        $1::text, $2::text, 'full'::text, 'candidate'::text,
        'invalid-envelope-hash-test'::text, null::uuid, $3::jsonb, $4::jsonb, $5::text
      ) as receipt
    `, [
      WORKSPACE,
      sourceCut.sourceCutId,
      [{ itemKind: "accepted_claim", itemId: claimVersionId, itemHash: HASH_A }],
      versions,
      TOKEN,
    ]),
    "23514",
    "truth builds must reject caller hashes that do not match the sealed evidence envelope",
  );
  const build = (await one(db, `
    select public.begin_truth_build(
      $1::text, $2::text, 'full'::text, 'candidate'::text,
      'relational-contract-test'::text, null::uuid, $3::jsonb, $4::jsonb, $5::text
    ) as receipt
  `, [
    WORKSPACE,
    sourceCut.sourceCutId,
    [{ itemKind: "accepted_claim", itemId: claimVersionId, itemHash: claimReceipt.itemHash }],
    versions,
    TOKEN,
  ])).receipt;
  assert.equal(build.status, "running");
  assert.equal(build.sourceCutId, sourceCut.sourceCutId);

  const packet = {
    schemaVersion: versions.packetSchemaVersion,
    sourceCutId: sourceCut.sourceCutId,
    sourceWatermark: build.sourceWatermark,
    snapshotTime: "2026-07-09T20:00:00.000Z",
    writerVersion: versions.packetBuilderVersion,
    activeAwbs: ["123"],
    completedAwbs: [],
    shipments: [{
      awb: "123",
      evidencePacket: {
        sourceFacts: [{
          id: claimVersionId,
          sourceType: "gmail",
          gate: "release",
          summary: "Customs released",
        }],
      },
      truthPacket: {
        summary: "Released",
        gates: [{ gate: "release", sourceFactIds: [claimVersionId] }],
      },
    }],
  };
  const completed = (await one(db, `
    select public.complete_truth_build(
      $1::uuid, $2::text, $3::text, $4::jsonb, $5::text
    ) as receipt
  `, [
    build.buildId,
    JSON.stringify(packet),
    HASH_D,
    { schemaValid: true, citationIntegrityOk: true },
    TOKEN,
  ])).receipt;
  assert.match(completed.packetHash, /^[0-9a-f]{64}$/);

  await expectSqlState(
    db.query(`
      insert into public.truth_build_inputs (build_id, item_kind, item_id, item_hash, ordinal)
      values ($1::uuid, 'accepted_claim', 'late-input', $2::text, 1)
    `, [build.buildId, HASH_A]),
    "55000",
    "a successful build cannot accept late inputs",
  );

  const published = (await one(db, `
    select public.publish_truth_build_cas(
      $1::uuid, 'production'::text, 0::bigint, ''::text,
      'normal'::text, 'relational-publisher-v1'::text,
      'relational-contract-test'::text, $2::text
    ) as receipt
  `, [build.buildId, TOKEN])).receipt;
  assert.equal(published.idempotent, false);
  assert.equal(published.packetHash, completed.packetHash);
  assert.match(published.deliveryPayloadHash, /^[0-9a-f]{64}$/);

  const snapshot = await one(db, `
    select payload from public.app_snapshots where snapshot_key = 'shipment-truth-packets'
  `);
  assert.equal(snapshot.payload.packetHash, published.packetHash);
  assert.equal(snapshot.payload.deliveryPayloadHash, published.deliveryPayloadHash);
  assert.equal(snapshot.payload.contentSignature, published.deliveryPayloadHash);
  assert.equal(snapshot.payload.publicationId, published.publicationId);

  const deliveryHashProof = await one(db, `
    select encode(extensions.digest(
      convert_to((payload - 'deliveryPayloadHash' - 'contentSignature')::text, 'UTF8'),
      'sha256'
    ), 'hex') as recomputed_hash
    from public.app_snapshots
    where snapshot_key = 'shipment-truth-packets'
  `);
  assert.equal(
    deliveryHashProof.recomputed_hash,
    published.deliveryPayloadHash,
    "delivery payload hash must cover the stored payload excluding only its signature fields",
  );

  const activeIndex = await one(db, `
    select payload from public.app_snapshots where snapshot_key = 'active-awb-index'
  `);
  assert.equal(activeIndex.payload.truthPacketContentSignature, published.deliveryPayloadHash);
  assert.equal(activeIndex.payload.publicationId, published.publicationId);

  const metadata = await db.query(`
    select snapshot_key, content_signature
    from public.app_snapshot_metadata
    where snapshot_key in ('shipment-truth-packets', 'active-awb-index')
    order by snapshot_key
  `);
  assert.equal(metadata.rows.length, 2);
  assert.equal(
    metadata.rows.find((row) => row.snapshot_key === "shipment-truth-packets").content_signature,
    published.deliveryPayloadHash,
  );

  const retry = (await one(db, `
    select public.publish_truth_build_cas(
      $1::uuid, 'production'::text, 0::bigint, ''::text,
      'normal'::text, 'relational-publisher-v1'::text,
      'relational-contract-test'::text, $2::text
    ) as receipt
  `, [build.buildId, TOKEN])).receipt;
  assert.equal(retry.idempotent, true);
  assert.equal(retry.publicationId, published.publicationId);

  await expectSqlState(
    db.query(`update public.truth_builds set trigger_name = 'mutated' where build_id = $1::uuid`, [build.buildId]),
    "55000",
    "successful build manifests are immutable",
  );

  return { build, published };
}

async function verifyProviderEventCompleteness(db) {
  const connection = "event-contract";
  const owner = "event-contract-worker";
  const lease = await acquire(db, owner, connection);
  const batch = await beginBatch(db, owner, lease.leaseFence, "backfill", connection);
  const providerResponse = {
    historyId: "50",
    messages: [{ id: "event-contract-message", threadId: "event-contract-thread" }],
  };

  await expectSqlState(
    appendPage(db, {
      batchId: batch.batchId,
      ownerId: owner,
      leaseFence: lease.leaseFence,
      page: {
        pageOrdinal: 0,
        requestPageToken: "",
        responseNextPageToken: "",
        responseMailboxHistoryId: "50",
        firstHistoryId: "",
        lastHistoryId: "",
        providerResponse,
        providerEvents: [],
        isFinal: true,
      },
      observations: [],
      jobs: [],
    }),
    "23514",
    "a provider response event cannot be omitted from the immutable event manifest",
  );

  const observation = {
    observationId: `obs:v1:${HASH_E}`,
    sourceObjectType: "gmail_message_discovered",
    sourceObjectId: "event-contract-message",
    sourceRevision: "backfill:50",
    operation: "content",
    contentHash: HASH_E,
    normalizedPayload: {
      eventId: EVENT_E,
      eventType: "message_discovered",
      historyId: "50",
      messageId: "event-contract-message",
    },
    normalizedText: "",
    sourceFidelity: "normalized_source",
    schemaVersion: "source-observation-v1",
  };
  const providerEvent = {
    eventId: EVENT_E,
    eventType: "message_discovered",
    historyId: "50",
    messageId: "event-contract-message",
  };
  await expectSqlState(
    appendPage(db, {
      batchId: batch.batchId,
      ownerId: owner,
      leaseFence: lease.leaseFence,
      page: {
        pageOrdinal: 0,
        requestPageToken: "",
        responseNextPageToken: "",
        responseMailboxHistoryId: "50",
        firstHistoryId: "",
        lastHistoryId: "",
        providerResponse,
        providerEvents: [providerEvent],
        isFinal: true,
      },
      observations: [observation],
      jobs: [],
    }),
    "23514",
    "a discovered message cannot be committed without a durable raw-fetch job",
  );

  const empty = await appendPage(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
    page: {
      pageOrdinal: 0,
      requestPageToken: "",
      responseNextPageToken: "",
      responseMailboxHistoryId: "50",
      firstHistoryId: "",
      lastHistoryId: "",
      providerResponse: { historyId: "50", messages: [] },
      providerEvents: [],
      isFinal: true,
    },
    observations: [],
    jobs: [],
  });
  assert.equal(empty.observationCount, 0);
  assert.equal(empty.jobCount, 0);
  const committed = await commitBatch(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
  });
  assert.equal(committed.committedCursorValue, "50");
}

async function verifyDeadLetterLifecycle(db) {
  const connection = "dead-letter-contract";
  const owner = "dead-letter-ingest-worker";
  const lease = await acquire(db, owner, connection);
  const batch = await beginBatch(db, owner, lease.leaseFence, "backfill", connection);
  const eventId = `gmail-event:v1:${HASH_H}`;
  await appendPage(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
    page: {
      pageOrdinal: 0,
      requestPageToken: "",
      responseNextPageToken: "",
      responseMailboxHistoryId: "77",
      firstHistoryId: "77",
      lastHistoryId: "77",
      providerResponse: {
        historyId: "77",
        messages: [{ id: "dead-letter-message", threadId: "dead-letter-thread" }],
      },
      providerEvents: [{
        eventId,
        eventType: "message_discovered",
        historyId: "77",
        messageId: "dead-letter-message",
      }],
      isFinal: true,
    },
    observations: [{
      observationId: OBS_H,
      sourceObjectType: "gmail_message_discovered",
      sourceObjectId: "dead-letter-message",
      sourceRevision: "backfill:77",
      operation: "content",
      contentHash: HASH_H,
      normalizedPayload: {
        eventId,
        eventType: "message_discovered",
        historyId: "77",
        messageId: "dead-letter-message",
      },
      normalizedText: "",
      sourceFidelity: "normalized_source",
      schemaVersion: "source-observation-v1",
    }],
    jobs: [{
      dedupeKey: "gmail:raw-message:v1:dead-letter-contract",
      jobKind: "gmail_fetch_raw_message",
      observationId: OBS_H,
      sourceObjectId: "dead-letter-message",
      maxAttempts: 1,
      payload: { messageId: "dead-letter-message", historyId: "77" },
    }],
  });
  await commitBatch(db, { batchId: batch.batchId, ownerId: owner, leaseFence: lease.leaseFence });

  const workerId = "dead-letter-processing-worker";
  const processorVersion = "dead-letter-test-v1";
  const claimed = await claimProcessingJobs(db, {
    workerId,
    processorVersion,
    connectionKey: connection,
    jobKinds: ["gmail_fetch_raw_message"],
  });
  assert.equal(claimed.claimedCount, 1);
  const job = claimed.jobs[0];
  const failed = await failProcessingJob(db, {
    jobId: job.jobId,
    workerId,
    leaseFence: job.leaseFence,
    processorVersion,
    errorCode: "MALFORMED_RFC822",
    safeErrorDetail: "RFC822 parser rejected the message.",
  });
  assert.equal(failed.state, "dead_letter");
  assert.equal(failed.attemptCount, 1);
  const replay = await failProcessingJob(db, {
    jobId: job.jobId,
    workerId,
    leaseFence: job.leaseFence,
    processorVersion,
    errorCode: "MALFORMED_RFC822",
    safeErrorDetail: "RFC822 parser rejected the message.",
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.state, "dead_letter");
}

async function verifyNoPartialCursorAdvanceAndGap(db) {
  const owner = "journal-worker-2";
  const lease = await acquire(db, owner);
  assert.equal(lease.cursorValue, "200");
  const batch = await beginBatch(db, owner, lease.leaseFence);

  const partialObservation = `obs:v1:${HASH_D}`;
  await appendPage(db, {
    batchId: batch.batchId,
    ownerId: owner,
    leaseFence: lease.leaseFence,
    page: {
      pageOrdinal: 0,
      requestPageToken: "",
      responseNextPageToken: "next-page-token",
      responseMailboxHistoryId: "250",
      firstHistoryId: "201",
      lastHistoryId: "220",
      providerResponse: {
        historyId: "250",
        nextPageToken: "next-page-token",
        history: [{
          id: "201",
          labelsAdded: [{ message: { id: "message-2" }, labelIds: ["INBOX"] }],
        }],
      },
      providerEvents: [{
        eventId: EVENT_D,
        eventType: "labels_added",
        historyId: "201",
        messageId: "message-2",
      }],
      isFinal: false,
    },
    observations: [{
      observationId: partialObservation,
      sourceObjectType: "gmail_labels_added",
      sourceObjectId: "message-2",
      sourceRevision: "201",
      operation: "metadata_change",
      contentHash: HASH_D,
      normalizedPayload: {
        eventId: EVENT_D,
        eventType: "labels_added",
        historyId: "201",
        messageId: "message-2",
        labelIds: ["INBOX"],
      },
      normalizedText: "",
      sourceFidelity: "normalized_source",
      schemaVersion: "source-observation-v1",
    }],
    jobs: [],
  });

  await expectSqlState(
    appendPage(db, {
      batchId: batch.batchId,
      ownerId: owner,
      leaseFence: lease.leaseFence,
      page: {
        pageOrdinal: 1,
        requestPageToken: "next-page-token",
        responseNextPageToken: "next-page-token-2",
        responseMailboxHistoryId: "251",
        firstHistoryId: "201",
        lastHistoryId: "201",
        providerResponse: {
          historyId: "251",
          nextPageToken: "next-page-token-2",
          history: [{
            id: "201",
            labelsAdded: [{ message: { id: "message-2" }, labelIds: ["INBOX"] }],
          }],
        },
        providerEvents: [{
          eventId: EVENT_D,
          eventType: "labels_added",
          historyId: "201",
          messageId: "message-2",
        }],
        isFinal: false,
      },
      observations: [{
        observationId: OBS_C,
        sourceObjectType: "gmail_labels_added",
        sourceObjectId: "message-2",
        sourceRevision: "201",
        operation: "metadata_change",
        contentHash: HASH_C,
        normalizedPayload: {
          eventId: EVENT_D,
          eventType: "labels_added",
          historyId: "201",
          messageId: "message-2",
          labelIds: ["INBOX"],
        },
        normalizedText: "",
        sourceFidelity: "normalized_source",
        schemaVersion: "source-observation-v1",
      }],
      jobs: [],
    }),
    "23505",
    "same source coordinate with a different hash must fail",
  );

  await expectSqlState(
    commitBatch(db, { batchId: batch.batchId, ownerId: owner, leaseFence: lease.leaseFence }),
    "23514",
    "a non-final page cannot advance the Gmail cursor",
  );
  const cursorBeforeGap = await one(db, `
    select cursor_value, cursor_version from public.source_cursors
    where workspace_key = $1::text and source_system = 'gmail' and connection_key = $2::text
  `, [WORKSPACE, CONNECTION]);
  assert.equal(cursorBeforeGap.cursor_value, "200");
  assert.equal(cursorBeforeGap.cursor_version, 1);

  const gap = (await one(db, `
    select public.mark_gmail_history_expired(
      $1::text, $2::text, $3::text, $4::bigint,
      '200'::text, '300'::text, '{"reason":"history too old"}'::jsonb, $5::text
    ) as receipt
  `, [WORKSPACE, CONNECTION, owner, lease.leaseFence, TOKEN])).receipt;
  assert.equal(gap.code, "HISTORY_EXPIRED");
  assert.equal(gap.cursorValue, "200");
  assert.equal(gap.status, "reconcile_required");

  const cursorAfterGap = await one(db, `
    select cursor_value, cursor_version, status from public.source_cursors
    where workspace_key = $1::text and source_system = 'gmail' and connection_key = $2::text
  `, [WORKSPACE, CONNECTION]);
  assert.equal(cursorAfterGap.cursor_value, "200");
  assert.equal(cursorAfterGap.cursor_version, 1);
  assert.equal(cursorAfterGap.status, "reconcile_required");

  const recoveryOwner = "journal-recovery-worker";
  const recoveryLease = await acquire(db, recoveryOwner);
  assert.equal(recoveryLease.cursorValue, "200");
  assert.equal(recoveryLease.status, "reconcile_required");
  assert.equal(recoveryLease.recoveryAnchorValue, "300");
  const recoveryBatch = await beginBatch(
    db,
    recoveryOwner,
    recoveryLease.leaseFence,
    "reconciliation",
  );
  assert.equal(recoveryBatch.recoveryAnchorValue, "300");
  await appendPage(db, {
    batchId: recoveryBatch.batchId,
    ownerId: recoveryOwner,
    leaseFence: recoveryLease.leaseFence,
    page: {
      pageOrdinal: 0,
      requestPageToken: "",
      responseNextPageToken: "",
      responseMailboxHistoryId: "300",
      firstHistoryId: "",
      lastHistoryId: "",
      providerResponse: { historyId: "300", messages: [] },
      providerEvents: [],
      isFinal: true,
    },
    observations: [],
    jobs: [],
  });
  const recovered = await commitBatch(db, {
    batchId: recoveryBatch.batchId,
    ownerId: recoveryOwner,
    leaseFence: recoveryLease.leaseFence,
  });
  assert.equal(recovered.committedCursorValue, "300");
  const recoveredState = await one(db, `
    select cursor_value, cursor_version, status from public.source_cursors
    where workspace_key = $1::text and source_system = 'gmail' and connection_key = $2::text
  `, [WORKSPACE, CONNECTION]);
  assert.equal(recoveredState.cursor_value, "300");
  assert.equal(recoveredState.cursor_version, 2);
  assert.equal(recoveredState.status, "live");
  const closedGap = await one(db, `
    select status from public.gmail_completeness_gaps where gap_id = $1::uuid
  `, [gap.gapId]);
  assert.equal(closedGap.status, "reconciled_current_mailbox");
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await installContract(db);
    await verifyLegacySnapshotCompatibilityBeforeCutover(db);
    await verifyGenericSourcePermissions(db);
    const journal = await verifyJournal(db);
    const processing = await verifyProcessingJobs(db, journal);
    const tms = await verifyGenericSourceSnapshot(db);
    const sourceCut = await verifySourceCut(db, journal, processing, tms);
    const publication = await verifyBuildAndPublication(db, sourceCut);
    await verifyLegacySnapshotGuard(db);
    await verifyProviderEventCompleteness(db);
    await verifyDeadLetterLifecycle(db);
    await verifyNoPartialCursorAdvanceAndGap(db);
    const genericRowsBeforeReplay = await one(db, `
      select
        (select count(*)::integer from public.source_ingest_manifests) as manifests,
        (select count(*)::integer from public.source_snapshot_failures) as failures
    `);
    await db.exec(fs.readFileSync(GENERIC_SOURCE_MIGRATION, "utf8"));
    const genericRowsAfterReplay = await one(db, `
      select
        (select count(*)::integer from public.source_ingest_manifests) as manifests,
        (select count(*)::integer from public.source_snapshot_failures) as failures
    `);
    assert.deepEqual(genericRowsAfterReplay, genericRowsBeforeReplay, "migration replay must preserve live journal rows");
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-relational-contract",
      sourceCutId: sourceCut.sourceCutId,
      publicationId: publication.published.publicationId,
      checks: [
        "migrations execute in PostgreSQL and the generic-source migration is reentrant",
        "generic-source tables and private implementations are inaccessible outside the public service-role RPC boundary",
        "fenced and idempotent source lease",
        "exact page membership and replay",
        "cursor commits only after final page",
        "immutable observations and collision rejection",
        "committed-root jobs claim with fences and inherit immutable cursor lineage",
        "long processing jobs renew only their exact active fence",
        "raw and parsed observations plus child jobs commit atomically and replay idempotently",
        "TMS snapshots commit provider manifests and observations under the same cursor CAS",
        "TMS provider scope, row manifests, and one-to-one extraction-job coverage are SQL-validated",
        "non-Gmail source replay is exact across same-batch and lost-response process restarts",
        "definitive and preflight source failures are durable without cursor advance",
        "only an explicit validated recovery batch can move an errored source back to live",
        "old committed payloads cannot erase later source errors and resolved failure evidence remains immutable",
        "paused/error/reconcile states and source-specific cursor kinds fail closed",
        "provider manifests are immutable and source-cut freshness cannot be forged",
        "database-sealed compact source-cut v2 with server-derived partition counts and hashes",
        "required sources and cursor partitions form one exact freshness vector",
        "caller observation arrays are rejected and deprecated per-cut memberships remain empty",
        "a verified zero-observation source is explicitly committed as emptyScope with the hash of an empty partition",
        "running partial ingest batches degrade the cut at the prior cursor",
        "observations attached to an uncommitted or dimension-mismatched batch degrade the cut",
        "accepted claims seal complete evidence into a server-derived immutable envelope",
        "build inputs reject any hash that does not match the authoritative envelope",
        "database-derived build manifests",
        "final build/input immutability",
        "atomic CAS publication plus both metadata sidecars",
        "legacy snapshot RPC remains available during shadow and cannot overwrite either projection after relational production cutover",
        "delivery signature recomputes from its defined payload preimage",
        "idempotent publication retry before CAS",
        "provider events cannot be omitted and new messages require raw-fetch jobs",
        "terminal processing failures dead-letter exactly once and replay idempotently",
        "empty provider pages remain valid and advance only after commit",
        "history expiration records a gap without cursor advance",
        "reconciliation exposes the exact recovery anchor and atomically closes its gap",
      ],
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

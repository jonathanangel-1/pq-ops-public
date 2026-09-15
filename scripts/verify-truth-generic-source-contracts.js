#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { buildTrackingSourceSnapshot } = require("../lib/tracking-source-snapshot");
const {
  buildOperatorSourceDelta,
  deriveOperatorEventId,
} = require("../lib/operator-source-delta");
const { PREDICATES, REGISTRY } = require("../lib/truth-predicate-registry");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = [
  "supabase/migrations/20260709200000_truth_source_observation_journal.sql",
  "supabase/migrations/20260709210000_truth_claims_builds_publications_audits.sql",
  "supabase/migrations/20260709223000_truth_generic_source_ingestion.sql",
].map((file) => path.join(ROOT, file));
const GENERIC_MIGRATION = MIGRATIONS.at(-1);
const TOKEN = "generic-source-contract-verifier";
const WORKSPACE = "primary";
const TRACKING_FIXTURE_PATH = path.join(__dirname, "fixtures", "verify-tracking-source-snapshot.json");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

async function install(db) {
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
  `);
  for (const migration of MIGRATIONS) {
    await db.exec(fs.readFileSync(migration, "utf8"));
  }
  await db.exec(fs.readFileSync(GENERIC_MIGRATION, "utf8"));
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values (
      'local_snapshot_writer',
      encode(extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex')
    )
  `, [TOKEN]);
}

function trackingBuild(connectionKey = "tracking-contract-positive") {
  const snapshots = JSON.parse(fs.readFileSync(TRACKING_FIXTURE_PATH, "utf8"));
  const expectedAwbs = snapshots.flatMap((snapshot) => snapshot.tracking.map((row) => row.awb));
  return buildTrackingSourceSnapshot(snapshots, {
    workspaceKey: WORKSPACE,
    connectionKey,
    expectedAwbs,
  });
}

function operatorEvent(sequence, suffix = "") {
  const predicate = "arrival_confirmed";
  const polarity = "positive";
  const occurredAt = `2026-07-09T1${sequence % 10}:00:00.000Z`;
  const recordedAt = `2026-07-09T1${sequence % 10}:01:00.000Z`;
  const event = {
    schemaVersion: "operator-recorded-event-v1",
    sequence: String(sequence),
    eventType: "assertion",
    subject: { type: "shipment", awbs: ["016-80000160"] },
    contact: { name: "Maya Cohen", organization: "United Cargo JFK" },
    recordedBy: { operatorId: "operator:alex", name: "Alex Morgan" },
    occurredAt,
    recordedAt,
    recordedSummary: `I confirmed the arrival by phone${suffix ? ` (${suffix})` : ""}.`,
    assertion: {
      contractVersion: REGISTRY.registryVersion,
      predicate,
      polarity,
      value: {
        status: PREDICATES[predicate].statuses[polarity],
        effect: PREDICATES[predicate].effects[polarity],
      },
    },
  };
  event.eventId = deriveOperatorEventId(event);
  return event;
}

function operatorBuild({
  connectionKey = "operator-contract-positive",
  previousSequence = 0,
  eventCount = 2,
  suffix = "positive",
} = {}) {
  const events = Array.from({ length: eventCount }, (_, index) =>
    operatorEvent(previousSequence + index + 1, `${suffix}-${index + 1}`));
  const capturedAt = `2026-07-09T2${Math.min(previousSequence + eventCount, 3)}:00:00.000Z`;
  return buildOperatorSourceDelta({
    schemaVersion: "operator-source-delta-v1",
    capturedAt,
    previousSequence: String(previousSequence),
    events,
  }, {
    workspaceKey: WORKSPACE,
    connectionKey,
    expectedFirstSequence: String(previousSequence + 1),
  });
}

async function acquire(db, sourceSystem, connectionKey, ownerId) {
  const cursorKind = sourceSystem === "tracking"
    ? "tracking_snapshot_timestamp"
    : "operator_sequence";
  return (await one(db, `
    select public.acquire_source_sync_lease(
      $1::text, $2::text, $3::text, $4::text, 120::integer,
      $5::text, $6::text
    ) as receipt
  `, [WORKSPACE, sourceSystem, connectionKey, ownerId, cursorKind, TOKEN])).receipt;
}

async function begin(db, sourceSystem, connectionKey, ownerId, leaseFence) {
  return (await one(db, `
    select public.begin_source_ingest_batch(
      $1::text, $2::text, $3::text, $4::text, $5::bigint,
      'snapshot'::text, 'generic-source-contract-verifier'::text, $6::text
    ) as receipt
  `, [WORKSPACE, sourceSystem, connectionKey, ownerId, leaseFence, TOKEN])).receipt;
}

async function start(db, sourceSystem, connectionKey, ownerId) {
  const lease = await acquire(db, sourceSystem, connectionKey, ownerId);
  assert.equal(lease.ok, true);
  const batch = await begin(db, sourceSystem, connectionKey, ownerId, lease.leaseFence);
  return { lease, batch };
}

async function commit(db, { built, batchId, ownerId, leaseFence }) {
  return (await one(db, `
    select public.commit_source_snapshot_batch(
      $1::uuid, $2::text, $3::bigint, $4::text,
      $5::jsonb, $6::jsonb, $7::jsonb, $8::text
    ) as receipt
  `, [
    batchId,
    ownerId,
    leaseFence,
    built.nextCursorValue,
    built.providerManifest,
    built.observations,
    built.jobs,
    TOKEN,
  ])).receipt;
}

async function commitFresh(db, built, label) {
  const ownerId = `${label}-worker`;
  const started = await start(db, built.sourceSystem, built.connectionKey, ownerId);
  return {
    ...started,
    ownerId,
    receipt: await commit(db, {
      built,
      batchId: started.batch.batchId,
      ownerId,
      leaseFence: started.lease.leaseFence,
    }),
  };
}

async function expectRejectedBuild(db, built, label, message) {
  const ownerId = `${label}-worker`;
  const started = await start(db, built.sourceSystem, built.connectionKey, ownerId);
  await expectSqlState(commit(db, {
    built,
    batchId: started.batch.batchId,
    ownerId,
    leaseFence: started.lease.leaseFence,
  }), "23514", message);
  const cursor = await one(db, `
    select cursor_value, cursor_version
    from public.source_cursors
    where workspace_key = $1::text and source_system = $2::text and connection_key = $3::text
  `, [WORKSPACE, built.sourceSystem, built.connectionKey]);
  assert.equal(cursor.cursor_value, "", `${message}: rejected batch moved cursor`);
  assert.equal(Number(cursor.cursor_version), 0, `${message}: rejected batch moved version`);
}

async function verifyTracking(db) {
  const built = trackingBuild();
  assert.equal(built.providerManifest.expectedAwbs.length, built.observations.length);
  const positive = await commitFresh(db, built, "tracking-positive");
  assert.equal(positive.receipt.observationCount, 25);
  assert.equal(positive.receipt.jobCount, 25);

  const replay = await commit(db, {
    built,
    batchId: positive.batch.batchId,
    ownerId: positive.ownerId,
    leaseFence: positive.lease.leaseFence,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.batchHash, positive.receipt.batchHash);

  const recovery = (await one(db, `
    select public.recover_committed_source_snapshot(
      $1::text, 'tracking'::text, $2::text, $3::text,
      $4::jsonb, $5::jsonb, $6::jsonb, $7::text
    ) as receipt
  `, [
    WORKSPACE,
    built.connectionKey,
    built.nextCursorValue,
    built.providerManifest,
    built.observations,
    built.jobs,
    TOKEN,
  ])).receipt;
  assert.equal(recovery.found, true);
  assert.equal(recovery.batchHash, positive.receipt.batchHash);

  const emptyBuilt = buildTrackingSourceSnapshot([{
    snapshotTime: "2026-07-09T18:00:00.000Z",
    source: "explicit empty database-contract scope",
    recordCount: 0,
    tracking: [],
  }], {
    workspaceKey: WORKSPACE,
    connectionKey: "tracking-explicit-empty-scope",
    expectedAwbs: [],
  });
  const emptyCommit = await commitFresh(db, emptyBuilt, "tracking-explicit-empty");
  assert.equal(emptyCommit.receipt.observationCount, 0);
  assert.equal(emptyCommit.receipt.jobCount, 0);

  const implicitEmpty = clone(buildTrackingSourceSnapshot([{
    snapshotTime: "2026-07-09T18:01:00.000Z",
    source: "implicit empty database-contract scope",
    recordCount: 0,
    tracking: [],
  }], {
    workspaceKey: WORKSPACE,
    connectionKey: "tracking-implicit-empty-scope",
    expectedAwbs: [],
  }));
  delete implicitEmpty.providerManifest.expectedAwbs;
  await expectRejectedBuild(
    db,
    implicitEmpty,
    "tracking-implicit-empty",
    "an empty tracking result is incomplete unless expectedAwbs is explicitly empty",
  );

  const missingExpected = clone(trackingBuild("tracking-missing-expected-awb"));
  missingExpected.providerManifest.expectedAwbs.shift();
  await expectRejectedBuild(
    db,
    missingExpected,
    "tracking-missing-expected",
    "tracking scope cannot shrink independently of captured rows",
  );

  const rowTamper = clone(trackingBuild("tracking-row-tamper"));
  rowTamper.providerManifest.rows[0].provenanceStatus = "tampered-status";
  await expectRejectedBuild(
    db,
    rowTamper,
    "tracking-row-tamper",
    "tracking row-manifest tampering must fail its deterministic hash",
  );

  const healthTamper = clone(trackingBuild("tracking-health-tamper"));
  const firstObservationId = healthTamper.providerManifest.rows[0].observationId;
  const firstObservation = healthTamper.observations.find((row) => row.observationId === firstObservationId);
  firstObservation.normalizedPayload.sourceHealth.status = "provider_failure";
  await expectRejectedBuild(
    db,
    healthTamper,
    "tracking-health-tamper",
    "tracking observation health must match its provider row and extraction job",
  );

  const missingJob = clone(trackingBuild("tracking-missing-job"));
  missingJob.jobs.pop();
  await expectRejectedBuild(
    db,
    missingJob,
    "tracking-missing-job",
    "every expected tracking AWB requires one observation and one extraction job",
  );

  return { rows: built.observations.length };
}

async function verifyOperator(db) {
  const built = operatorBuild();
  const positive = await commitFresh(db, built, "operator-positive");
  assert.equal(positive.receipt.committedCursorValue, "2");
  assert.equal(positive.receipt.committedCursorVersion, 1);

  const replay = await commit(db, {
    built,
    batchId: positive.batch.batchId,
    ownerId: positive.ownerId,
    leaseFence: positive.lease.leaseFence,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.batchHash, positive.receipt.batchHash);

  const lostResponseOwner = "operator-lost-response-worker";
  const lostResponseStarted = await start(db, "operator", built.connectionKey, lostResponseOwner);
  const lostResponseRecovery = await commit(db, {
    built,
    batchId: lostResponseStarted.batch.batchId,
    ownerId: lostResponseOwner,
    leaseFence: lostResponseStarted.lease.leaseFence,
  });
  assert.equal(lostResponseRecovery.idempotent, true);
  assert.equal(lostResponseRecovery.recovered, true);
  assert.equal(lostResponseRecovery.batchId, positive.batch.batchId);
  assert.equal(lostResponseRecovery.supersededBatchId, lostResponseStarted.batch.batchId);

  const skipBuilt = operatorBuild({
    connectionKey: built.connectionKey,
    previousSequence: 3,
    eventCount: 1,
    suffix: "cursor-skip",
  });
  const skipOwner = "operator-cursor-skip-worker";
  const skipStarted = await start(db, "operator", built.connectionKey, skipOwner);
  await expectSqlState(commit(db, {
    built: skipBuilt,
    batchId: skipStarted.batch.batchId,
    ownerId: skipOwner,
    leaseFence: skipStarted.lease.leaseFence,
  }), "23514", "operator previousSequence must equal the locked cursor exactly");
  const afterSkip = await one(db, `
    select cursor_value, cursor_version
    from public.source_cursors
    where workspace_key = $1::text and source_system = 'operator' and connection_key = $2::text
  `, [WORKSPACE, built.connectionKey]);
  assert.equal(afterSkip.cursor_value, "2");
  assert.equal(Number(afterSkip.cursor_version), 1);

  const initialSkip = operatorBuild({
    connectionKey: "operator-invalid-initial-sequence",
    previousSequence: 2,
    eventCount: 1,
    suffix: "invalid-initial",
  });
  await expectRejectedBuild(
    db,
    initialSkip,
    "operator-invalid-initial",
    "an uninitialized operator cursor means previousSequence zero, not an arbitrary anchor",
  );

  const nextMismatch = clone(operatorBuild({
    connectionKey: "operator-next-mismatch",
    previousSequence: 0,
    eventCount: 1,
    suffix: "next-mismatch",
  }));
  nextMismatch.nextCursorValue = "2";
  nextMismatch.providerManifest.nextSequence = "2";
  nextMismatch.providerManifest.upstreamWatermark = "2";
  await expectRejectedBuild(
    db,
    nextMismatch,
    "operator-next-mismatch",
    "operator nextSequence must equal previousSequence plus exact event count",
  );

  const sequenceTamper = clone(operatorBuild({
    connectionKey: "operator-payload-sequence-tamper",
    previousSequence: 0,
    eventCount: 1,
    suffix: "payload-sequence-tamper",
  }));
  sequenceTamper.observations[0].normalizedPayload.event.sequence = "9";
  await expectRejectedBuild(
    db,
    sequenceTamper,
    "operator-payload-sequence-tamper",
    "operator manifest sequence must bind the exact observation payload sequence",
  );

  const hashTamper = clone(operatorBuild({
    connectionKey: "operator-event-hash-tamper",
    previousSequence: 0,
    eventCount: 1,
    suffix: "event-hash-tamper",
  }));
  hashTamper.providerManifest.events[0].contentHash = "f".repeat(64);
  await expectRejectedBuild(
    db,
    hashTamper,
    "operator-event-hash-tamper",
    "operator event manifest tampering must fail its deterministic hash",
  );

  return { events: built.observations.length, nextSequence: built.nextCursorValue };
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await install(db);
    const tracking = await verifyTracking(db);
    const operator = await verifyOperator(db);
    const countsBeforeReplay = await one(db, `
      select
        (select count(*)::integer from public.source_ingest_manifests) as manifests,
        (select count(*)::integer from public.source_observations) as observations,
        (select count(*)::integer from public.source_processing_jobs) as jobs
    `);
    await db.exec(fs.readFileSync(GENERIC_MIGRATION, "utf8"));
    const counts = await one(db, `
      select
        (select count(*)::integer from public.source_ingest_manifests) as manifests,
        (select count(*)::integer from public.source_observations) as observations,
        (select count(*)::integer from public.source_processing_jobs) as jobs
    `);
    assert.deepEqual(counts, countsBeforeReplay, "migration replay changed committed source evidence");
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-generic-source-contracts",
      tracking,
      operator,
      persisted: counts,
      guarantees: [
        "tracking commits require an explicit canonical expected-AWB scope witness",
        "expected AWBs, manifest rows, observations, and extraction jobs are exact one-to-one sets",
        "tracking row hashes, health counts, provenance, payload health, and job fields are cross-bound",
        "operator initial sequence is zero and every later previousSequence equals the locked cursor",
        "operator nextSequence is exactly previousSequence plus a unique gap-free event manifest",
        "operator event IDs, revisions, content hashes, payload sequences, and jobs map one-to-one",
        "tracking and operator commits replay idempotently without moving cursors twice",
        "lost operator commit responses recover the prior receipt before cursor-continuity checks",
        "migration replay preserves already committed tracking and operator evidence",
        "all rejected mismatch, omission, skip, and tamper cases leave source cursors unchanged",
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

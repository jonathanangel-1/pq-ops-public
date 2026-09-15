#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const { PREDICATES, REGISTRY } = require("../lib/truth-predicate-registry");
const { createOperatorClaimExtractor } = require("../lib/operator-claim-extractor");

const ROOT = path.resolve(__dirname, "..");
const AUTHORITY = path.join(
  ROOT,
  "supabase/migrations/20260709236000_truth_operator_event_authority.sql",
);
const COORDINATOR = path.join(
  ROOT,
  "supabase/migrations/20260709234000_truth_source_cut_coordinator.sql",
);
const MIGRATIONS = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
  "20260709236000_truth_operator_event_authority.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));

const TOKEN = "operator-event-authority-sync-token";
const WORKSPACE = "primary";
const CONNECTION = "operator-phone-primary";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventRequest({
  eventType = "assertion",
  predicate = "pickup_completed",
  polarity = "positive",
  awb = "01680000156",
  relatedEventId,
  summary = "I confirmed by phone that the driver picked up the cargo.",
} = {}) {
  return {
    schemaVersion: "operator-truth-event-request-v1",
    eventType,
    subject: { type: "shipment", awbs: [awb] },
    contact: { name: "Riley Stone", organization: "Juniper Logistics", channel: "phone" },
    recordedBy: { operatorId: "operator:alex", name: "Alex Morgan" },
    occurredAt: "2026-07-09T12:00:00.000Z",
    recordedSummary: summary,
    assertion: {
      contractVersion: REGISTRY.registryVersion,
      predicate,
      polarity,
      value: {
        status: PREDICATES[predicate].statuses[polarity],
        effect: PREDICATES[predicate].effects[polarity],
      },
    },
    ...(eventType === "assertion" ? {} : { relatedEventId }),
  };
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function expectSqlState(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${label}: ${error?.message || error}`);
    return true;
  }, label);
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
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values (
      'local_snapshot_writer',
      encode(extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex')
    )
  `, [TOKEN]);
}

async function record(db, {
  workspace = WORKSPACE,
  connection = CONNECTION,
  key,
  request,
  token = TOKEN,
}) {
  return (await one(db, `
    select public.record_operator_truth_event(
      $1::text, $2::text, $3::text, $4::jsonb, $5::text
    ) as receipt
  `, [workspace, connection, key, request, token])).receipt;
}

async function counts(db, workspace = WORKSPACE, connection = CONNECTION) {
  return one(db, `
    select
      (select count(*)::integer from public.operator_truth_event_requests
       where workspace_key = $1::text and connection_key = $2::text) as requests,
      (select count(*)::integer from public.source_observations
       where workspace_key = $1::text and source_system = 'operator'
         and connection_key = $2::text) as observations,
      (select count(*)::integer from public.source_processing_jobs
       where workspace_key = $1::text and source_system = 'operator'
         and connection_key = $2::text) as jobs,
      (select count(*)::integer from public.source_ingest_batches
       where workspace_key = $1::text and source_system = 'operator'
         and connection_key = $2::text and trigger_name = 'truth-operator-event-authority-v1') as batches,
      (select cursor_value from public.source_cursors
       where workspace_key = $1::text and source_system = 'operator'
         and connection_key = $2::text) as cursor_value,
      (select cursor_version::integer from public.source_cursors
       where workspace_key = $1::text and source_system = 'operator'
         and connection_key = $2::text) as cursor_version
  `, [workspace, connection]);
}

async function verifyFirstEvent(db) {
  const key = "A".repeat(32);
  const request = eventRequest();
  const receipt = await record(db, { key, request });
  assert.equal(receipt.eventSequence, "1");
  assert.equal(receipt.sourceCursorVersion, 1);
  assert.equal(receipt.workspaceKey, WORKSPACE);
  assert.equal(receipt.connectionKey, CONNECTION);
  assert.equal(receipt.mutatesOperationalState, false);
  assert.equal(receipt.reducesTruth, false);
  assert.equal(receipt.publishesTruth, false);

  const persisted = await one(db, `
    select
      request.request_hash,
      request.idempotency_key_hash,
      request.canonical_request,
      request.prior_observation_id,
      observation.source_cursor_version,
      observation.source_revision,
      observation.source_recorded_at,
      observation.captured_at,
      observation.normalized_payload,
      observation.content_hash,
      job.state as job_state,
      job.payload as job_payload,
      batch.status as batch_status,
      batch.observation_count,
      batch.job_count,
      manifest.provider_manifest
    from public.operator_truth_event_requests request
    join public.source_observations observation
      on observation.observation_id = request.observation_id
     and observation.workspace_key = request.workspace_key
     and observation.source_system = request.source_system
     and observation.connection_key = request.connection_key
    join public.source_processing_jobs job
      on job.job_id = request.job_id
     and job.workspace_key = request.workspace_key
     and job.source_system = request.source_system
     and job.connection_key = request.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id = request.batch_id
     and batch.workspace_key = request.workspace_key
     and batch.source_system = request.source_system
     and batch.connection_key = request.connection_key
    join public.source_ingest_manifests manifest on manifest.batch_id = batch.batch_id
    where request.request_id = $1::text
  `, [receipt.requestId]);
  assert.deepEqual(persisted.canonical_request, request);
  assert.notEqual(persisted.idempotency_key_hash, key);
  assert.equal(persisted.prior_observation_id, null);
  assert.equal(Number(persisted.source_cursor_version), 1);
  assert.equal(persisted.source_revision, "sequence:1");
  assert.equal(persisted.source_recorded_at.toISOString(), receipt.capturedAt);
  assert.equal(persisted.captured_at.toISOString(), receipt.capturedAt);
  assert.equal(persisted.normalized_payload.capturedAt, receipt.capturedAt);
  assert.equal(persisted.normalized_payload.event.recordedAt, receipt.capturedAt);
  assert.equal(persisted.normalized_payload.event.eventId, receipt.eventId);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "eventId"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "sequence"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "recordedAt"), false);
  assert.equal(persisted.job_state, "queued");
  assert.equal(persisted.job_payload.sourceObservationId, receipt.observationId);
  assert.equal(persisted.job_payload.eventId, receipt.eventId);
  assert.equal(persisted.job_payload.eventSequence, "1");
  assert.equal(persisted.job_payload.batchId, receipt.batchId);
  assert.equal(persisted.batch_status, "committed");
  assert.equal(persisted.observation_count, 1);
  assert.equal(persisted.job_count, 1);
  assert.equal(persisted.provider_manifest.previousSequence, "0");
  assert.equal(persisted.provider_manifest.nextSequence, "1");
  assert.equal(persisted.provider_manifest.recordCount, 1);

  const observation = {
    observationId: receipt.observationId,
    sourceSystem: "operator",
    sourceObjectType: "operator_event",
    sourceObjectId: receipt.eventId,
    operation: "content",
    contentHash: persisted.content_hash,
    capturedAt: receipt.capturedAt,
    normalizedPayload: persisted.normalized_payload,
  };
  const candidates = await createOperatorClaimExtractor().extract({ observation });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].acceptanceRecommendation.decision, "accept");
  assert.equal(candidates[0].predicate, "pickup_completed");
  return { key, request, receipt };
}

async function verifyIdempotency(db, first) {
  const before = await counts(db);
  const exact = await record(db, first);
  assert.deepEqual(exact, first.receipt, "exact retry must return the same durable receipt");
  assert.deepEqual(await counts(db), before, "exact retry must not append or advance again");

  const changed = clone(first.request);
  changed.recordedSummary = "I confirmed a changed payload under the same key.";
  await expectSqlState(
    record(db, { key: first.key, request: changed }),
    "23505",
    "changed payload under the same idempotency key must conflict",
  );
  assert.deepEqual(await counts(db), before, "conflicting replay must leave all durable state unchanged");

  const concurrentKey = "B".repeat(32);
  const concurrentRequest = eventRequest({
    predicate: "delivery_completed",
    summary: "I confirmed by phone that delivery was completed.",
  });
  const concurrent = await Promise.all([
    record(db, { key: concurrentKey, request: concurrentRequest }),
    record(db, { key: concurrentKey, request: concurrentRequest }),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(concurrent[0].eventSequence, "2");
  const after = await counts(db);
  assert.equal(after.requests, before.requests + 1);
  assert.equal(after.observations, before.observations + 1);
  assert.equal(after.jobs, before.jobs + 1);
  assert.equal(after.cursor_value, "2");
}

async function verifyRevisions(db, first) {
  const correctionRequest = eventRequest({
    eventType: "correction",
    polarity: "negative",
    relatedEventId: first.receipt.eventId,
    summary: "I corrected the phone record: the cargo was not picked up.",
  });
  const correction = await record(db, {
    key: "C".repeat(32),
    request: correctionRequest,
  });
  assert.equal(correction.eventSequence, "3");
  const correctionRow = await one(db, `
    select request.prior_observation_id, observation.normalized_payload
    from public.operator_truth_event_requests request
    join public.source_observations observation
      on observation.observation_id = request.observation_id
    where request.request_id = $1::text
  `, [correction.requestId]);
  assert.equal(correctionRow.prior_observation_id, first.receipt.observationId);
  assert.deepEqual(correctionRow.normalized_payload.event.relatedEvent, {
    relation: "corrects",
    eventId: first.receipt.eventId,
    sequence: "1",
  });

  const revocationRequest = eventRequest({
    eventType: "revocation",
    polarity: "unknown",
    relatedEventId: correction.eventId,
    summary: "I revoked the corrected phone record because the caller withdrew it.",
  });
  const revocation = await record(db, {
    key: "D".repeat(32),
    request: revocationRequest,
  });
  assert.equal(revocation.eventSequence, "4");
  const revocationRow = await one(db, `
    select request.prior_observation_id, observation.normalized_payload
    from public.operator_truth_event_requests request
    join public.source_observations observation
      on observation.observation_id = request.observation_id
    where request.request_id = $1::text
  `, [revocation.requestId]);
  assert.equal(revocationRow.prior_observation_id, correction.observationId);
  assert.deepEqual(revocationRow.normalized_payload.event.relatedEvent, {
    relation: "revokes",
    eventId: correction.eventId,
    sequence: "3",
  });
  assert.deepEqual(revocationRow.normalized_payload.event.assertion.value, {
    status: "unknown",
    effect: "context",
  });

  const before = await counts(db);
  const wrongSubject = eventRequest({
    eventType: "correction",
    polarity: "negative",
    awb: "01643985282",
    relatedEventId: first.receipt.eventId,
  });
  await expectSqlState(
    record(db, { key: "E".repeat(32), request: wrongSubject }),
    "23514",
    "correction cannot cross subject scope",
  );
  const wrongPredicate = eventRequest({
    eventType: "correction",
    predicate: "delivery_completed",
    polarity: "negative",
    relatedEventId: first.receipt.eventId,
  });
  await expectSqlState(
    record(db, { key: "F".repeat(32), request: wrongPredicate }),
    "23514",
    "correction cannot cross predicate chain",
  );
  const invalidRevocation = eventRequest({
    eventType: "revocation",
    polarity: "positive",
    relatedEventId: first.receipt.eventId,
  });
  await expectSqlState(
    record(db, { key: "G".repeat(32), request: invalidRevocation }),
    "23514",
    "revocation cannot silently preserve positive truth",
  );
  assert.deepEqual(await counts(db), before, "rejected revisions must be transactionally invisible");
}

async function verifyScopeIsolation(db, first) {
  await db.exec(`
    insert into public.truth_workspaces (workspace_key, status, registry_version)
    values ('tenant-b', 'active', 'truth-workspace-registry-v1');
  `);
  const tenantEvent = await record(db, {
    workspace: "tenant-b",
    key: "H".repeat(32),
    request: eventRequest({
      predicate: "customs_release",
      summary: "I confirmed by phone that customs released the cargo.",
    }),
  });
  await expectSqlState(
    record(db, {
      key: "I".repeat(32),
      request: eventRequest({
        eventType: "correction",
        polarity: "negative",
        predicate: "customs_release",
        relatedEventId: tenantEvent.eventId,
      }),
    }),
    "23503",
    "a prior event in another workspace must be invisible",
  );

  const secondary = await record(db, {
    connection: "operator-phone-secondary",
    key: "J".repeat(32),
    request: eventRequest({
      predicate: "arrival_confirmed",
      summary: "I confirmed by phone that the cargo arrived.",
    }),
  });
  await expectSqlState(
    record(db, {
      key: "K".repeat(32),
      request: eventRequest({
        eventType: "correction",
        predicate: "arrival_confirmed",
        polarity: "negative",
        relatedEventId: secondary.eventId,
      }),
    }),
    "23503",
    "a prior event in another connection must be invisible",
  );

  const primary = await one(db, `
    select count(*)::integer as count
    from public.operator_truth_event_requests
    where workspace_key = $1::text and connection_key = $2::text
      and event_id = any($3::text[])
  `, [WORKSPACE, CONNECTION, [tenantEvent.eventId, secondary.eventId]]);
  assert.equal(primary.count, 0);
  assert.ok(first.receipt.eventId !== tenantEvent.eventId);
}

async function verifyMalformedAndAuthorization(db) {
  const before = await counts(db);
  const cases = [
    ["caller event identity", (value) => { value.eventId = `operator-event:v1:${"0".repeat(64)}`; }],
    ["caller sequence", (value) => { value.sequence = "999"; }],
    ["caller recorded clock", (value) => { value.recordedAt = "2026-07-09T12:01:00.000Z"; }],
    ["caller capture clock", (value) => { value.capturedAt = "2026-07-09T12:01:00.000Z"; }],
    ["wrong assertion status", (value) => { value.assertion.value.status = "delivered"; }],
    ["noncanonical AWB", (value) => { value.subject.awbs = ["016-80000156"]; }],
  ];
  for (const [index, [label, mutate]] of cases.entries()) {
    const candidate = eventRequest();
    mutate(candidate);
    await expectSqlState(
      record(db, { key: `${String(index).padStart(2, "0")}${"L".repeat(30)}`, request: candidate }),
      index === 4 ? "23514" : "22023",
      label,
    );
  }
  await expectSqlState(
    record(db, { key: "M".repeat(32), request: eventRequest(), token: "wrong-token" }),
    "28000",
    "invalid database sync token",
  );
  await expectSqlState(
    record(db, { key: "weak", request: eventRequest() }),
    "22023",
    "weak idempotency key",
  );
  assert.deepEqual(await counts(db), before, "malformed or unauthorized requests must not move the cursor");
}

async function verifyStorageControls(db) {
  const controls = await one(db, `
    select
      cls.relrowsecurity as rls_enabled,
      cls.relforcerowsecurity as rls_forced,
      has_table_privilege('service_role', 'public.operator_truth_event_requests', 'SELECT') as service_select,
      has_table_privilege('service_role', 'public.operator_truth_event_requests', 'INSERT') as service_insert,
      has_table_privilege('service_role', 'public.operator_truth_event_requests', 'UPDATE') as service_update,
      has_table_privilege('service_role', 'public.operator_truth_event_requests', 'DELETE') as service_delete,
      has_function_privilege(
        'service_role',
        'public.record_operator_truth_event(text,text,text,jsonb,text)',
        'EXECUTE'
      ) as service_execute,
      has_function_privilege(
        'authenticated',
        'public.record_operator_truth_event(text,text,text,jsonb,text)',
        'EXECUTE'
      ) as authenticated_execute
    from pg_catalog.pg_class cls
    join pg_catalog.pg_namespace ns on ns.oid = cls.relnamespace
    where ns.nspname = 'public' and cls.relname = 'operator_truth_event_requests'
  `);
  assert.deepEqual(controls, {
    rls_enabled: true,
    rls_forced: true,
    service_select: true,
    service_insert: false,
    service_update: false,
    service_delete: false,
    service_execute: true,
    authenticated_execute: false,
  });

  const foreignKeys = await db.query(`
    select pg_catalog.pg_get_constraintdef(constraint_row.oid, true) as definition
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_catalog.pg_namespace ns on ns.oid = table_row.relnamespace
    where ns.nspname = 'public'
      and table_row.relname = 'operator_truth_event_requests'
      and constraint_row.contype = 'f'
    order by constraint_row.conname
  `);
  const definitions = foreignKeys.rows.map((row) => row.definition);
  assert.ok(definitions.some((value) => value.includes("truth_workspaces")));
  for (const parent of ["source_observations", "source_processing_jobs", "source_ingest_batches"]) {
    assert.ok(definitions.some((value) => value.includes(parent)
      && value.includes("workspace_key")
      && value.includes("source_system")
      && value.includes("connection_key")), `${parent} FK must be tenant/source scoped`);
  }

  await expectSqlState(
    db.exec(`update public.operator_truth_event_requests set connection_key = 'tampered'`),
    "55000",
    "request bindings are append-only",
  );
  await db.exec("set role service_role");
  await expectSqlState(
    db.exec(`delete from public.operator_truth_event_requests`),
    "42501",
    "service role cannot bypass the RPC with direct DML",
  );
  await db.exec("reset role");
}

async function verifySingleIngress(db) {
  await expectSqlState(
    one(db, `
      select public.acquire_source_sync_lease(
        $1::text, 'operator'::text, $2::text,
        'legacy-caller-built-operator-delta'::text, 120::integer,
        'operator_sequence'::text, $3::text
      ) as receipt
    `, [WORKSPACE, CONNECTION, TOKEN]),
    "42501",
    "the old generic source RPC cannot lease or advance the operator cursor",
  );
  const tms = (await one(db, `
    select public.acquire_source_sync_lease(
      $1::text, 'tms'::text, 'generic-tms-remains-enabled'::text,
      'tms-verifier'::text, 120::integer,
      'tms_snapshot_timestamp'::text, $2::text
    ) as receipt
  `, [WORKSPACE, TOKEN])).receipt;
  assert.equal(tms.ok, true, "the operator guard must not disable the generic TMS source path");
}

async function verifyReapplication(db) {
  const before = await one(db, `
    select
      (select count(*)::integer from public.operator_truth_event_requests) as requests,
      (select count(*)::integer from public.source_observations where source_system = 'operator') as observations,
      (select count(*)::integer from public.source_processing_jobs where source_system = 'operator') as jobs,
      (select count(*)::integer from public.source_ingest_manifests where source_system = 'operator') as manifests,
      (select sum(cursor_version)::integer from public.source_cursors where source_system = 'operator') as cursor_versions
  `);
  await db.exec(fs.readFileSync(COORDINATOR, "utf8"));
  await db.exec(fs.readFileSync(AUTHORITY, "utf8"));
  const after = await one(db, `
    select
      (select count(*)::integer from public.operator_truth_event_requests) as requests,
      (select count(*)::integer from public.source_observations where source_system = 'operator') as observations,
      (select count(*)::integer from public.source_processing_jobs where source_system = 'operator') as jobs,
      (select count(*)::integer from public.source_ingest_manifests where source_system = 'operator') as manifests,
      (select sum(cursor_version)::integer from public.source_cursors where source_system = 'operator') as cursor_versions
  `);
  assert.deepEqual(after, before, "migration reapplication must preserve all committed evidence and cursors");
}

async function verifyGenesisReapplication() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await install(db);
    const before = await one(db, `
      select cursor_value, cursor_version, last_batch_id, last_committed_at
      from public.source_cursors
      where workspace_key = 'primary' and source_system = 'operator'
        and connection_key = 'operator-phone-primary'
    `);
    assert.equal(before.cursor_value, "0");
    assert.equal(Number(before.cursor_version), 0);
    await db.exec(fs.readFileSync(COORDINATOR, "utf8"));
    const after = await one(db, `
      select cursor_value, cursor_version, last_batch_id, last_committed_at
      from public.source_cursors
      where workspace_key = 'primary' and source_system = 'operator'
        and connection_key = 'operator-phone-primary'
    `);
    assert.deepEqual(after, before, "the guarded empty operator genesis must remain reentrant");
  } finally {
    await db.close();
  }
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  let persisted;
  try {
    await install(db);
    const first = await verifyFirstEvent(db);
    await verifyIdempotency(db, first);
    await verifyRevisions(db, first);
    await verifyScopeIsolation(db, first);
    await verifyMalformedAndAuthorization(db);
    await verifyStorageControls(db);
    await verifySingleIngress(db);
    await verifyReapplication(db);
    persisted = await counts(db);
  } finally {
    await db.close();
  }
  await verifyGenesisReapplication();
  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-event-authority",
    migrationCount: MIGRATIONS.length,
    primary: persisted,
    guarantees: [
      "the server transaction mints sequence, event ID, observation ID, job ID, batch ID, and recorded/captured time",
      "source observation, extraction job, manifest, batch, and idempotency binding commit before one cursor CAS",
      "exact and concurrent same-key retries return one identical receipt without duplicate evidence",
      "changed payloads under one key conflict and malformed/unauthorized requests leave no partial rows",
      "corrections/revocations retain the exact prior observation and cannot cross subject, predicate, workspace, or connection",
      "the legacy generic operator writer is blocked while generic TMS ingestion remains available",
      "tenant-scoped composite foreign keys, RLS, immutable triggers, and revoked direct DML protect the ledger",
      "downstream operator claim extraction accepts the server-minted structured assertion",
      "authority and guarded source-genesis migration replay preserve committed evidence and cursor positions",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

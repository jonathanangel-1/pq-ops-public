#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const {
  ACCOUNT_BINDING_AUTHORITY,
} = require("./run-truth-gmail-primary-ingest-forward-unblock");
const { normalizeHistoryPage } = require("../lib/gmail-incremental-sync");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const FULL_STACK_VERIFIER = path.join(ROOT, "scripts/verify-truth-full-migration-stack.js");
const RUNNER_PATH = path.join(
  ROOT,
  "scripts/run-truth-gmail-parked-backfill-historical-drain.js",
);
const TARGET_MIGRATION = "20260717190000_truth_gmail_parked_backfill_historical_drain.sql";
const TARGET_PATH = path.join(MIGRATION_DIR, TARGET_MIGRATION);
const BATCH_ID = "118506f6-7c7b-4bb9-8f62-9a743513a8ca";
const COORDINATOR_JOB_ID = "5ae52e8d-dd30-582b-aef3-1ebdc65f0970";
const WORKSPACE = "primary";
const CONNECTION = "primary";
const ANCHOR = "19563092";
const CUTOVER_HISTORY_ID = "19640268";
const LIVE_DELTA_HISTORY_ID = "19640300";
const TOKEN = "truth-gmail-parked-backfill-historical-drain-token-v1";
const PROVIDER_ACCOUNT = "operator@example.invalid";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

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
  return sha256(JSON.stringify(canonicalize(value)));
}

function migrationNames() {
  const source = fs.readFileSync(FULL_STACK_VERIFIER, "utf8");
  const declaration = source.match(
    /const MIGRATION_NAMES = Object\.freeze\(\[([\s\S]*?)\n\]\);/,
  );
  assert.ok(declaration, "full migration-stack declaration must remain readable");
  const declared = [...declaration[1].matchAll(/"([^"]+\.sql)"/g)]
    .map((match) => match[1]);
  return [...new Set([...declared, TARGET_MIGRATION])].sort();
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
  return db;
}

async function applyMigration(db, name, label) {
  const migrationPath = path.join(MIGRATION_DIR, name);
  assert.ok(fs.existsSync(migrationPath), `${label}: missing ${name}`);
  try {
    await db.exec(fs.readFileSync(migrationPath, "utf8"));
  } catch (cause) {
    const error = new Error(`${label}: ${name}: ${cause?.message || cause}`, { cause });
    error.code = cause?.code;
    throw error;
  }
}

function providerAccountIdentity() {
  const body = {
    schemaVersion: "truth-gmail-env-profile-account-binding-v1",
    authority: ACCOUNT_BINDING_AUTHORITY,
    environmentVariable: "GMAIL_USER_EMAIL",
    expectedAccountEmail: PROVIDER_ACCOUNT,
    profileAccountEmail: PROVIDER_ACCOUNT,
  };
  return { ...body, bindingHash: sha256Json(body) };
}

function providerProbe() {
  const profileEvidence = {
    emailAddress: PROVIDER_ACCOUNT,
    messagesTotal: 218989,
    threadsTotal: 87001,
    historyId: CUTOVER_HISTORY_ID,
  };
  const checkpointResponse = {
    historyId: CUTOVER_HISTORY_ID,
    history: [{
      id: CUTOVER_HISTORY_ID,
      messagesAdded: [{
        message: {
          id: "historical-drain-checkpoint-message",
          threadId: "historical-drain-checkpoint-thread",
          labelIds: ["INBOX"],
        },
      }],
    }],
  };
  const checkpointPage = normalizeHistoryPage(checkpointResponse, {
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
  });
  const checkpointEvidence = {
    checkpointKind: "recent-message-to-terminal-history-list-v1",
    startMessageId: "historical-drain-checkpoint-message",
    startHistoryId: CUTOVER_HISTORY_ID,
    terminalHistoryId: CUTOVER_HISTORY_ID,
    historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
    pageCount: 1,
    eventCount: 1,
    distinctMessageCount: 1,
    pageManifest: [{
      pageOrdinal: 0,
      requestPageTokenHash: sha256(""),
      responseNextPageTokenHash: sha256(""),
      providerResponseHash: sha256Json(checkpointPage.providerResponse),
      responseHistoryId: CUTOVER_HISTORY_ID,
      eventManifest: checkpointPage.providerEvents,
      nextPageTokenPresent: false,
    }],
  };
  const body = {
    schemaVersion: "truth-gmail-current-profile-checkpoint-probe-v1",
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
    batchId: BATCH_ID,
    persistedAnchorHistoryId: ANCHOR,
    cutoverHistoryId: CUTOVER_HISTORY_ID,
    accountIdentity: providerAccountIdentity(),
    profileEvidence,
    profileResponseHash: sha256Json(profileEvidence),
    checkpointEvidence,
    observedAt: new Date().toISOString(),
    productionPublicationAttempted: false,
  };
  return { ...body, probeHash: sha256Json(body) };
}

async function seedMegaBatch(db) {
  await db.query(`
    insert into public.sync_tokens(token_name, token_hash)
    values ('local_snapshot_writer', $1)
  `, [sha256(TOKEN)]);
  await db.exec("set session_replication_role = replica");
  try {
    await db.exec(`
      insert into public.source_cursors(
        workspace_key, source_system, connection_key, cursor_kind,
        cursor_value, cursor_version, status, last_batch_id,
        last_committed_at, last_error_code, last_error_detail,
        lease_owner, lease_fence, lease_expires_at,
        created_at, updated_at
      ) values (
        '${WORKSPACE}', 'gmail', '${CONNECTION}', 'gmail_history_id',
        '', 0, 'backfill_required', null,
        null, '', '',
        'hosted-truth-shadow-cron:preempted-fixture', 41,
        clock_timestamp() + interval '2 minutes',
        '2026-07-12T15:37:00.000Z', '2026-07-18T12:00:00.000Z'
      );

      insert into public.source_ingest_batches(
        batch_id, workspace_key, source_system, connection_key,
        mode, trigger_name, expected_cursor_version, expected_cursor_value,
        committed_cursor_version, committed_cursor_value,
        lease_owner, lease_fence, status, batch_hash,
        page_count, observation_count, job_count,
        error_code, error_detail, started_at, committed_at, finished_at
      ) values (
        '${BATCH_ID}', '${WORKSPACE}', 'gmail', '${CONNECTION}',
        'backfill', 'hosted-truth-shadow-cron', 0, '',
        null, null,
        'hosted-truth-shadow-cron:original', 1, 'running', null,
        2190, 218989, 0,
        '', '', '2026-07-12T15:37:00.000Z', null, null
      );

      with page_shape as (
        select ordinal as page_ordinal,
          case when ordinal = 2189 then 89 else 100 end as event_count,
          case when ordinal = 0 then '' else 'page-token-' || ordinal::text end
            as request_page_token,
          case when ordinal = 2189 then '' else 'page-token-' || (ordinal + 1)::text end
            as response_next_page_token,
          ordinal = 2189 as is_final
        from generate_series(0, 2189) ordinal
      )
      insert into public.gmail_ingest_pages(
        batch_id, page_ordinal, request_page_token,
        response_next_page_token, response_mailbox_history_id,
        first_history_id, last_history_id,
        provider_response, provider_response_hash,
        provider_event_manifest, event_count, job_count,
        event_digest, is_final, persisted_at
      )
      select '${BATCH_ID}', shape.page_ordinal,
        shape.request_page_token, shape.response_next_page_token, '${ANCHOR}',
        '', '',
        jsonb_build_object(
          'historyId', '${ANCHOR}',
          'nextPageToken', shape.response_next_page_token
        ),
        encode(extensions.digest(convert_to(
          'provider-page-' || shape.page_ordinal::text, 'UTF8'
        ), 'sha256'), 'hex'),
        (
          select jsonb_agg(jsonb_build_object(
            'eventId', 'gmail-event:v1:' || lpad(to_hex(
              (shape.page_ordinal::bigint * 100) + item::bigint
            ), 64, '0')
          ) order by item)
          from generate_series(1, shape.event_count) item
        ),
        shape.event_count, 0,
        encode(extensions.digest(convert_to(
          'event-digest-' || shape.page_ordinal::text, 'UTF8'
        ), 'sha256'), 'hex'),
        shape.is_final,
        '2026-07-13T00:42:00.000Z'
      from page_shape shape;

      insert into public.source_observations(
        observation_id, workspace_key, source_system, connection_key,
        source_object_type, source_object_id, source_revision, operation,
        source_cursor_version, batch_id, content_hash,
        source_recorded_at, captured_at, normalized_payload,
        normalized_text, source_fidelity, schema_version,
        retention_class, created_at
      )
      select
        'obs:v1:' || lpad(to_hex(item::bigint), 64, '0'),
        '${WORKSPACE}', 'gmail', '${CONNECTION}',
        'gmail_message_discovery_event', 'message-' || item::text,
        'discovery:backfill:${ANCHOR}:' || item::text,
        'metadata_change', 1, '${BATCH_ID}',
        encode(extensions.digest(convert_to(
          'content-' || item::text, 'UTF8'
        ), 'sha256'), 'hex'),
        '2026-07-12T15:37:00.000Z', '2026-07-13T00:42:00.000Z',
        jsonb_build_object(
          'eventType', 'message_discovered',
          'historyId', '${ANCHOR}',
          'messageId', 'message-' || item::text
        ),
        '', 'normalized_source', 'gmail-mailbox-discovery-event-v1',
        'shipment-operations', '2026-07-13T00:42:00.000Z'
      from generate_series(1, 218989) item;

      insert into public.gmail_ingest_page_observations(
        batch_id, page_ordinal, observation_id, created_at
      )
      select '${BATCH_ID}', ((item - 1) / 100)::integer,
        'obs:v1:' || lpad(to_hex(item::bigint), 64, '0'),
        '2026-07-13T00:42:00.000Z'
      from generate_series(1, 218989) item;
    `);
  } finally {
    await db.exec("set session_replication_role = origin");
  }
  await db.exec(`
    alter function public.commit_source_ingest_batch(uuid,text,bigint,text)
      set statement_timeout = '5s';
    alter function private.commit_source_ingest_batch(uuid,text,bigint,text)
      set statement_timeout = '5s';
  `);
}

async function parkMegaBatch(db) {
  const receipt = await asService(db, async () => (
    await one(db, `select public.run_truth_gmail_backfill_forward_unblock(
      $1::uuid, $2::jsonb, $3::text
    ) as receipt`, [BATCH_ID, providerProbe(), TOKEN])
  ).receipt);
  assert.equal(receipt.status, "parked");
  assert.equal(receipt.coordinatorJobId, COORDINATOR_JOB_ID);
  assert.equal(receipt.cursorValue, CUTOVER_HISTORY_ID);
  assert.equal(receipt.productionPublicationAttempted, false);
  return receipt;
}

async function commitEmptyHostedTick(db, ordinal) {
  const owner = `hosted-truth-shadow-cron:historical-drain-fixture:${ordinal}`;
  const lease = await asService(db, async () => (
    await one(db, `select public.acquire_source_sync_lease(
      $1::text, 'gmail', $2::text, $3::text, 90,
      'gmail_history_id', $4::text
    ) as receipt`, [WORKSPACE, CONNECTION, owner, TOKEN])
  ).receipt);
  assert.equal(lease.ok, true);
  assert.equal(lease.cursorValue, CUTOVER_HISTORY_ID);
  const batch = await asService(db, async () => (
    await one(db, `select public.begin_source_ingest_batch(
      $1::text, 'gmail', $2::text, $3::text,
      $4::bigint, 'history', 'hosted-truth-shadow-cron', $5::text
    ) as receipt`, [WORKSPACE, CONNECTION, owner, lease.leaseFence, TOKEN])
  ).receipt);
  const normalized = normalizeHistoryPage({ historyId: CUTOVER_HISTORY_ID, history: [] }, {
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
  });
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: normalized.responseMailboxHistoryId,
    firstHistoryId: normalized.firstHistoryId,
    lastHistoryId: normalized.lastHistoryId,
    providerResponse: normalized.providerResponse,
    providerEvents: normalized.providerEvents,
    isFinal: true,
  };
  const append = await asService(db, async () => (
    await one(db, `select public.append_gmail_ingest_page(
      $1::uuid, $2::text, $3::bigint,
      $4::jsonb, $5::jsonb, $6::jsonb, $7::text
    ) as receipt`, [
      batch.batchId,
      owner,
      lease.leaseFence,
      page,
      normalized.observations,
      normalized.jobs,
      TOKEN,
    ])
  ).receipt);
  assert.equal(append.observationCount, 0);
  assert.equal(append.jobCount, 0);
  const started = performance.now();
  const committed = await asService(db, async () => (
    await one(db, `select public.commit_source_ingest_batch(
      $1::uuid, $2::text, $3::bigint, $4::text
    ) as receipt`, [batch.batchId, owner, lease.leaseFence, TOKEN])
  ).receipt);
  const elapsedMs = performance.now() - started;
  assert.equal(committed.ok, true);
  assert.equal(committed.committedCursorValue, CUTOVER_HISTORY_ID);
  assert.ok(elapsedMs < 5000, `hosted empty commit ${ordinal} took ${elapsedMs.toFixed(1)}ms`);
  return { batchId: batch.batchId, elapsedMs };
}

async function commitNonemptyHostedTick(db, ordinal) {
  const owner = `hosted-truth-shadow-cron:historical-drain-live-fixture:${ordinal}`;
  const lease = await asService(db, async () => (
    await one(db, `select public.acquire_source_sync_lease(
      $1::text, 'gmail', $2::text, $3::text, 90,
      'gmail_history_id', $4::text
    ) as receipt`, [WORKSPACE, CONNECTION, owner, TOKEN])
  ).receipt);
  const batch = await asService(db, async () => (
    await one(db, `select public.begin_source_ingest_batch(
      $1::text, 'gmail', $2::text, $3::text,
      $4::bigint, 'history', 'hosted-truth-shadow-cron', $5::text
    ) as receipt`, [WORKSPACE, CONNECTION, owner, lease.leaseFence, TOKEN])
  ).receipt);
  const normalized = normalizeHistoryPage({
    historyId: LIVE_DELTA_HISTORY_ID,
    history: [{
      id: String(BigInt(LIVE_DELTA_HISTORY_ID) - 10n),
      messagesAdded: [{
        message: {
          id: `historical-drain-live-message-${ordinal}`,
          threadId: `historical-drain-live-thread-${ordinal}`,
          labelIds: ["INBOX"],
        },
      }],
    }],
  }, { workspaceKey: WORKSPACE, connectionKey: CONNECTION });
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: normalized.responseMailboxHistoryId,
    firstHistoryId: normalized.firstHistoryId,
    lastHistoryId: normalized.lastHistoryId,
    providerResponse: normalized.providerResponse,
    providerEvents: normalized.providerEvents,
    isFinal: true,
  };
  const append = await asService(db, async () => (
    await one(db, `select public.append_gmail_ingest_page(
      $1::uuid, $2::text, $3::bigint,
      $4::jsonb, $5::jsonb, $6::jsonb, $7::text
    ) as receipt`, [
      batch.batchId,
      owner,
      lease.leaseFence,
      page,
      normalized.observations,
      normalized.jobs,
      TOKEN,
    ])
  ).receipt);
  assert.equal(append.observationCount, 1);
  assert.equal(append.jobCount, 0);
  const started = performance.now();
  const committed = await asService(db, async () => (
    await one(db, `select public.commit_source_ingest_batch(
      $1::uuid, $2::text, $3::bigint, $4::text
    ) as receipt`, [batch.batchId, owner, lease.leaseFence, TOKEN])
  ).receipt);
  const elapsedMs = performance.now() - started;
  assert.equal(committed.ok, true);
  assert.equal(committed.committedCursorValue, LIVE_DELTA_HISTORY_ID);
  assert.equal(committed.materializationRoutes.routeCount, 1);
  assert.equal(committed.materializationRoutes.materializationCount, 1);
  assert.ok(elapsedMs < 5000,
    `hosted non-empty commit ${ordinal} took ${elapsedMs.toFixed(1)}ms`);
  return {
    batchId: batch.batchId,
    committedCursorVersion: committed.committedCursorVersion,
    observationId: normalized.observations[0].observationId,
    elapsedMs,
  };
}

async function commitFunctionConfigs(db) {
  const result = await db.query(`
    select n.nspname as schema_name, p.proconfig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.oid = any(array[
      'public.commit_source_ingest_batch(uuid,text,bigint,text)'::regprocedure,
      'private.commit_source_ingest_batch(uuid,text,bigint,text)'::regprocedure
    ]::oid[])
    order by n.nspname
  `);
  assert.equal(result.rows.length, 2);
  for (const row of result.rows) {
    assert.ok(row.proconfig.includes("statement_timeout=5s"));
    assert.equal(
      row.proconfig.some((setting) => /^(enable_|plan_cache_mode|cpu_|random_page_cost|seq_page_cost)/.test(setting)),
      false,
      `${row.schema_name} commit authority must not carry planner/cost settings`,
    );
  }
  return result.rows;
}

async function originalObservationFingerprint(db) {
  return one(db, `
    select count(*)::integer as observation_count,
      count(*) filter (where batch_id = $1::uuid)::integer as original_batch_count,
      min(journal_seq)::bigint as minimum_journal_seq,
      max(journal_seq)::bigint as maximum_journal_seq,
      encode(extensions.digest(convert_to(jsonb_agg(jsonb_build_object(
        'observationId', observation_id,
        'contentHash', content_hash,
        'batchId', batch_id
      ) order by observation_id)::text, 'UTF8'), 'sha256'), 'hex') as fingerprint
    from public.source_observations
    where workspace_key = $2::text
      and source_system = 'gmail'
      and connection_key = $3::text
      and batch_id = $1::uuid
  `, [BATCH_ID, WORKSPACE, CONNECTION]);
}

async function verifyRunnerBehavior() {
  const source = fs.readFileSync(RUNNER_PATH, "utf8");
  for (const forbidden of [
    "shipment-truth-packets",
    "truth_publications",
    "publish_truth",
    "productionPublicationAttempted: true",
    "enable_nestloop",
    "plan_cache_mode",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `historical-drain runner must not contain ${forbidden}`,
    );
  }
  assert.match(source, /The default is read-only\./);
  assert.match(source, /--execute adopts at most one immutable provider page\./);
  assert.match(source, /if \(execute && finalize\)/,
    "execute and finalize must remain mutually exclusive");
  assert.match(source, /productionPublicationAttempted:\s*false/);

  const supabasePath = require.resolve("../lib/supabase-agent");
  const runnerModulePath = require.resolve("./run-truth-gmail-parked-backfill-historical-drain");
  const priorSupabaseModule = require.cache[supabasePath];
  const priorRunnerModule = require.cache[runnerModulePath];
  const calls = [];
  let scenario = "read_only";
  const mockCallRpc = async (name, args, options) => {
    calls.push({ name, args, options });
    if (name === "read_truth_gmail_parked_backfill_historical_drain") {
      const readOrdinal = calls.filter((call) => call.name === name).length;
      if (scenario === "finalize") {
        return readOrdinal === 1
          ? { status: "ready_to_finalize", nextPageOrdinal: 2190 }
          : { status: "complete", nextPageOrdinal: 2190 };
      }
      if (scenario === "execute") {
        return readOrdinal === 1
          ? { status: "in_progress", nextPageOrdinal: 7 }
          : { status: "in_progress", nextPageOrdinal: 8 };
      }
      return { status: "candidate", nextPageOrdinal: 0 };
    }
    if (name === "run_truth_gmail_parked_backfill_historical_drain_chunk") {
      return {
        status: "page_committed",
        sourcePageOrdinal: args.p_expected_page_ordinal,
        productionPublicationAttempted: false,
      };
    }
    if (name === "finalize_truth_gmail_parked_backfill_historical_drain") {
      return { status: "finalized", productionPublicationAttempted: false };
    }
    throw new Error(`unexpected mocked RPC ${name}`);
  };
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: { callSupabaseRpc: mockCallRpc },
  };
  delete require.cache[runnerModulePath];

  const envNames = [
    "PQ_SUPABASE_URL",
    "PQ_SUPABASE_SERVICE_ROLE_KEY",
    "PQ_SUPABASE_SYNC_TOKEN",
    "PQ_TRUTH_GMAIL_HISTORICAL_DRAIN_WORKER_ID",
  ];
  const priorEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  process.env.PQ_SUPABASE_URL = "https://fixture.invalid";
  process.env.PQ_SUPABASE_SERVICE_ROLE_KEY = "fixture-service-role";
  process.env.PQ_SUPABASE_SYNC_TOKEN = TOKEN;
  delete process.env.PQ_TRUTH_GMAIL_HISTORICAL_DRAIN_WORKER_ID;
  const priorWrite = process.stdout.write;
  const outputs = [];
  process.stdout.write = (value) => {
    outputs.push(String(value));
    return true;
  };
  try {
    const runner = require(runnerModulePath);
    assert.equal(runner.integerOption([], "limit", 5, { minimum: 1, maximum: 5 }), 5);
    assert.throws(
      () => runner.integerOption(["--limit=0"], "limit", 5, { minimum: 1, maximum: 5 }),
      /must be an integer from 1 through 5/,
    );
    assert.throws(
      () => runner.integerOption(["--limit=6"], "limit", 5, { minimum: 1, maximum: 5 }),
      /must be an integer from 1 through 5/,
    );

    scenario = "read_only";
    calls.length = 0;
    outputs.length = 0;
    await runner.main([]);
    assert.deepEqual(calls.map((call) => call.name), [
      "read_truth_gmail_parked_backfill_historical_drain",
    ], "default runner invocation must be read-only");
    assert.equal(JSON.parse(outputs.join("")).mode, "read_only");

    scenario = "execute";
    calls.length = 0;
    outputs.length = 0;
    await runner.main([
      "--execute",
      "--expected-page=7",
      "--max-nonterminal=251",
      "--worker-id=historical-drain-fixture",
    ]);
    assert.deepEqual(calls.map((call) => call.name), [
      "read_truth_gmail_parked_backfill_historical_drain",
      "run_truth_gmail_parked_backfill_historical_drain_chunk",
      "read_truth_gmail_parked_backfill_historical_drain",
    ], "execute must invoke exactly one page authority between two reads");
    assert.deepEqual(calls[1].args, {
      p_batch_id: BATCH_ID,
      p_expected_page_ordinal: 7,
      p_worker_id: "historical-drain-fixture",
      p_max_nonterminal_jobs: 251,
      p_sync_token: TOKEN,
    });
    assert.equal(calls[1].options.outcomeUnknownOnTransportFailure, true);
    const executeOutput = JSON.parse(outputs.join(""));
    assert.equal(executeOutput.mode, "execute_one_page");
    assert.equal(executeOutput.productionPublicationAttempted, false);

    scenario = "finalize";
    calls.length = 0;
    outputs.length = 0;
    await runner.main(["--finalize", "--worker-id=historical-drain-fixture"]);
    assert.deepEqual(calls.map((call) => call.name), [
      "read_truth_gmail_parked_backfill_historical_drain",
      "finalize_truth_gmail_parked_backfill_historical_drain",
      "read_truth_gmail_parked_backfill_historical_drain",
    ], "finalize must be a distinct authority and must not execute a page");
    assert.equal(JSON.parse(outputs.join("")).productionPublicationAttempted, false);

    await assert.rejects(
      runner.main(["--execute", "--finalize"]),
      /Choose either --execute or --finalize/,
    );
    scenario = "execute";
    calls.length = 0;
    await assert.rejects(
      runner.main(["--execute", "--expected-page=2190"]),
      /must be an integer from 0 through 2189/,
    );
    assert.deepEqual(calls.map((call) => call.name), [
      "read_truth_gmail_parked_backfill_historical_drain",
    ], "invalid page ordinal must fail before any mutation RPC");
  } finally {
    process.stdout.write = priorWrite;
    for (const name of envNames) {
      if (priorEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[name];
    }
    delete require.cache[runnerModulePath];
    if (priorRunnerModule) require.cache[runnerModulePath] = priorRunnerModule;
    if (priorSupabaseModule) require.cache[supabasePath] = priorSupabaseModule;
    else delete require.cache[supabasePath];
  }
}

async function main() {
  assert.ok(fs.existsSync(TARGET_PATH), `missing ${TARGET_MIGRATION}`);
  await verifyRunnerBehavior();
  const names = migrationNames();
  assert.equal(names.at(-1), TARGET_MIGRATION, "historical drain must be final authority");
  const db = await createDatabase();
  try {
    for (const name of names.slice(0, -1)) {
      await applyMigration(db, name, "predecessor apply");
    }
    await seedMegaBatch(db);
    const parking = await parkMegaBatch(db);
    const hostedTicks = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      hostedTicks.push(await commitEmptyHostedTick(db, ordinal));
    }
    const configBefore = await commitFunctionConfigs(db);
    const observationsBefore = await originalObservationFingerprint(db);

    await applyMigration(db, TARGET_MIGRATION, "initial historical-drain apply");

    const configAfter = await commitFunctionConfigs(db);
    assert.deepEqual(configAfter, configBefore,
      "historical drain must not change either hosted commit function setting");

    // Contract-specific chunk, backpressure, resumability, and final-boundary
    // checks are appended once the 190000 authority names are installed.
    assert.fail("historical-drain authority contract checks are not yet wired");

    const observationsAfter = await originalObservationFingerprint(db);
    assert.deepEqual(observationsAfter, observationsBefore,
      "historical adoption must not rewrite immutable observations or batch ownership");
    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "truth-gmail-parked-backfill-historical-drain",
      migration: TARGET_MIGRATION,
      parkingReceiptId: parking.receiptId,
      hostedTickCount: hostedTicks.length,
      hostedCommitMaximumMs: Math.max(...hostedTicks.map((tick) => tick.elapsedMs)),
      pageCount: 2190,
      observationCount: 218989,
      productionPublicationAttempted: false,
      liveCalls: 0,
      productionPublications: 0,
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

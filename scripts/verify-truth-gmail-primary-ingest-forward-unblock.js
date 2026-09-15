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
  buildProviderProbe,
} = require("./run-truth-gmail-primary-ingest-forward-unblock");
const { normalizeHistoryPage } = require("../lib/gmail-incremental-sync");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const FULL_STACK_VERIFIER = path.join(ROOT, "scripts/verify-truth-full-migration-stack.js");
const TARGET_MIGRATION = "20260717170000_truth_gmail_primary_ingest_forward_unblock.sql";
const TARGET_PATH = path.join(MIGRATION_DIR, TARGET_MIGRATION);
const BATCH_ID = "118506f6-7c7b-4bb9-8f62-9a743513a8ca";
const WORKSPACE = "primary";
const CONNECTION = "primary";
const ANCHOR = "19563092";
const CUTOVER_HISTORY_ID = "19563100";
const NEXT_HISTORY_ID = "19563120";
const TOKEN = "truth-gmail-primary-forward-unblock-token-v1";
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

function providerAccountIdentity({
  expectedAccountEmail = PROVIDER_ACCOUNT,
  profileAccountEmail = PROVIDER_ACCOUNT,
} = {}) {
  const body = {
    schemaVersion: "truth-gmail-env-profile-account-binding-v1",
    authority: ACCOUNT_BINDING_AUTHORITY,
    environmentVariable: "GMAIL_USER_EMAIL",
    expectedAccountEmail: expectedAccountEmail.toLowerCase(),
    profileAccountEmail: profileAccountEmail.toLowerCase(),
  };
  return { ...body, bindingHash: sha256Json(body) };
}

function migrationNames() {
  const source = fs.readFileSync(FULL_STACK_VERIFIER, "utf8");
  const declaration = source.match(
    /const MIGRATION_NAMES = Object\.freeze\(\[([\s\S]*?)\n\]\);/,
  );
  assert.ok(declaration, "full migration-stack declaration must remain readable");
  return [...declaration[1].matchAll(/"([^"]+\.sql)"/g)].map((match) => match[1]);
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

function verifyStaticContract() {
  const source = fs.readFileSync(TARGET_PATH, "utf8");
  const normalized = source.replace(/\s+/g, " ").toLowerCase();
  const runnerSource = fs.readFileSync(
    path.join(ROOT, "scripts/run-truth-gmail-primary-ingest-forward-unblock.js"),
    "utf8",
  );
  for (const required of [
    "truth_gmail_backfill_parking_receipts",
    "parked_backfill_historical_drain",
    "gmail_cutover_delta_reconciliation",
    "truth-gmail-current-profile-checkpoint-probe-v1",
    "historical_drain_coordinator_required",
    "gmail_incremental_commit_witness_pending",
    "pg_try_advisory_xact_lock",
    "truth-source-cut-serialization-v1:",
    "productionpublicationattempted', false",
    "public.run_truth_gmail_backfill_forward_unblock",
    "execution-env-plus-live-gmail-profile-v1",
    "gmail_user_email",
  ]) {
    assert.ok(normalized.includes(required), `migration must preserve ${required}`);
  }
  for (const field of [
    "schemaversion",
    "workspacekey",
    "connectionkey",
    "batchid",
    "persistedanchorhistoryid",
  ]) {
    assert.ok(
      normalized.includes(`p_provider_probe->>'${field}' is distinct from`),
      `provider probe ${field} must fail closed when absent`,
    );
  }
  for (const forbidden of [
    "shipment-truth-packets",
    "publish_truth",
    "truth_publications",
    "delete from public.source_observations",
    "update public.source_observations",
    "set enable_nestloop",
    "set plan_cache_mode",
    "set statement_timeout",
    "alter function public.commit_source_ingest_batch",
    "alter function private.commit_source_ingest_batch",
    "gmail_oauth_connections",
    "oauth_token_fingerprint",
  ]) {
    assert.equal(normalized.includes(forbidden), false, `migration must not contain ${forbidden}`);
  }
  assert.match(
    runnerSource,
    /requiredEnv\("GMAIL_USER_EMAIL"\)/,
    "runner must require the execution-environment mailbox identity",
  );
  assert.match(
    runnerSource,
    /user:\s*"me"/,
    "runner must ask Gmail for the credential-owned profile",
  );
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

function providerProbe() {
  const profileEvidence = {
    emailAddress: PROVIDER_ACCOUNT,
    messagesTotal: 219012,
    threadsTotal: 87001,
    historyId: CUTOVER_HISTORY_ID,
  };
  const checkpointResponse = {
    historyId: CUTOVER_HISTORY_ID,
    history: [{
      id: CUTOVER_HISTORY_ID,
      messagesAdded: [{
        message: {
          id: "checkpoint-captured-message",
          threadId: "checkpoint-captured-thread",
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
    startMessageId: "checkpoint-message-1",
    startHistoryId: "19563099",
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

async function verifyProviderProbeBuilder() {
  const calls = [];
  let historyCallCount = 0;
  const candidate = {
    persistedAnchorHistoryId: ANCHOR,
    requiredAccountEmailEnvironmentVariable: "GMAIL_USER_EMAIL",
    requiredAccountBindingAuthority: ACCOUNT_BINDING_AUTHORITY,
  };
  const gmailClient = {
    async getProfile() {
      calls.push({ operation: "profile.get" });
      return {
        emailAddress: PROVIDER_ACCOUNT.toUpperCase(),
        messagesTotal: 219012,
        threadsTotal: 87001,
        historyId: CUTOVER_HISTORY_ID,
      };
    },
    async listMessages(input) {
      calls.push({ operation: "messages.list", input });
      return { messages: [{ id: "checkpoint-message-1" }] };
    },
    async getMessageMetadata(messageId, input) {
      calls.push({ operation: "messages.get.metadata", messageId, input });
      return { id: messageId, historyId: "19563099" };
    },
    async listHistory(input) {
      calls.push({ operation: "history.list", input });
      historyCallCount += 1;
      if (historyCallCount === 1) {
        return {
          historyId: "19563099",
          nextPageToken: "checkpoint-page-2",
          history: [{
            id: "19563099",
            messagesAdded: [{
              message: {
                id: "checkpoint-new-message",
                threadId: "checkpoint-new-thread",
                labelIds: ["INBOX"],
              },
            }],
          }],
        };
      }
      return { historyId: CUTOVER_HISTORY_ID, history: [] };
    },
  };
  const probe = await buildProviderProbe({
    gmailClient,
    candidate,
    expectedAccountEmail: PROVIDER_ACCOUNT,
  });
  assert.equal(probe.persistedAnchorHistoryId, ANCHOR);
  assert.equal(probe.cutoverHistoryId, CUTOVER_HISTORY_ID);
  assert.equal(probe.profileEvidence.emailAddress, PROVIDER_ACCOUNT.toUpperCase());
  assert.deepEqual(probe.accountIdentity, providerAccountIdentity());
  assert.equal(probe.checkpointEvidence.terminalHistoryId, CUTOVER_HISTORY_ID);
  assert.equal(probe.checkpointEvidence.pageCount, 2);
  assert.equal(probe.checkpointEvidence.eventCount, 1);
  assert.equal(probe.checkpointEvidence.pageManifest[0].nextPageTokenPresent, true);
  assert.equal(probe.checkpointEvidence.pageManifest[1].nextPageTokenPresent, false);
  assert.match(probe.profileResponseHash, /^[0-9a-f]{64}$/);
  const { probeHash, ...probeBody } = probe;
  assert.equal(probeHash, sha256Json(probeBody));
  assert.deepEqual(calls.map((call) => call.operation), [
    "profile.get",
    "messages.list",
    "messages.get.metadata",
    "history.list",
    "history.list",
  ]);
  assert.equal(calls.at(-1).input.pageToken, "checkpoint-page-2");
  let missingAccountProviderCalled = false;
  await assert.rejects(
    buildProviderProbe({
      gmailClient: {
        async getProfile() {
          missingAccountProviderCalled = true;
          return {};
        },
      },
      candidate,
      expectedAccountEmail: "",
    }),
    /GMAIL_USER_EMAIL is required/,
  );
  assert.equal(missingAccountProviderCalled, false);
  await assert.rejects(
    buildProviderProbe({
      gmailClient,
      candidate: {
        ...candidate,
        requiredAccountBindingAuthority: "unexpected-authority",
      },
      expectedAccountEmail: PROVIDER_ACCOUNT,
    }),
    /account-binding contract differs/,
  );
  await assert.rejects(
    buildProviderProbe({
      gmailClient: {
        async getProfile() {
          return {
            emailAddress: "wrong-mailbox@example.invalid",
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: CUTOVER_HISTORY_ID,
          };
        },
      },
      candidate,
      expectedAccountEmail: PROVIDER_ACCOUNT,
    }),
    /does not match configured GMAIL_USER_EMAIL/,
  );
}

async function dataFingerprint(db) {
  return one(db, `
    select encode(extensions.digest(convert_to(jsonb_build_object(
      'batch', (select to_jsonb(batch) from public.source_ingest_batches batch
        where batch.batch_id = '${BATCH_ID}'),
      'cursor', (select to_jsonb(cursor_row) from public.source_cursors cursor_row
        where cursor_row.workspace_key = '${WORKSPACE}'
          and cursor_row.source_system = 'gmail'
          and cursor_row.connection_key = '${CONNECTION}'),
      'receipt', (select to_jsonb(receipt)
        from public.truth_gmail_backfill_parking_receipts receipt
        where receipt.parked_batch_id = '${BATCH_ID}'),
      'gaps', (select jsonb_agg(to_jsonb(gap) order by gap.gap_type)
        from public.gmail_completeness_gaps gap
        where gap.gap_type in (
          'PARKED_BACKFILL_HISTORICAL_DRAIN',
          'GMAIL_CUTOVER_DELTA_RECONCILIATION'
        )),
      'job', (select to_jsonb(job) from public.source_processing_jobs job
        where job.job_kind = 'truth_drain_parked_gmail_backfill'),
      'lineage', (select to_jsonb(lineage)
        from public.source_processing_job_lineage lineage
        where lineage.root_batch_id = '${BATCH_ID}')
    )::text, 'UTF8'), 'sha256'), 'hex') as fingerprint
  `);
}

async function assertCommitCaps(db) {
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
    assert.ok(
      row.proconfig.includes("statement_timeout=5s"),
      `${row.schema_name} Gmail commit must retain the five-second cap`,
    );
    assert.equal(
      row.proconfig.some((setting) => /^(enable_|plan_cache_mode|cpu_|random_page_cost|seq_page_cost)/.test(setting)),
      false,
      `${row.schema_name} Gmail commit must not carry a planner/cost override`,
    );
  }
}

async function assertNoDatabaseOAuthTable(db) {
  const state = await one(db, `
    select to_regclass('public.gmail_oauth_connections') is null as absent
  `);
  assert.equal(
    state.absent,
    true,
    "forward-unblock must work without a database Gmail OAuth store",
  );
}

async function verifyParking(db) {
  const candidate = await asService(db, async () => (
    await one(db, `select public.read_truth_gmail_backfill_forward_unblock(
      $1::uuid, $2::text
    ) as receipt`, [BATCH_ID, TOKEN])
  ).receipt);
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.pageCount, 2190);
  assert.equal(candidate.observationCount, 218989);
  assert.equal(candidate.jobCount, 0);
  assert.equal(candidate.persistedAnchorHistoryId, ANCHOR);
  assert.equal(candidate.requiredAccountEmailEnvironmentVariable, "GMAIL_USER_EMAIL");
  assert.equal(
    candidate.requiredAccountBindingAuthority,
    ACCOUNT_BINDING_AUTHORITY,
  );
  assert.equal(Object.hasOwn(candidate, "oauthAccountEmail"), false);
  assert.equal(Object.hasOwn(candidate, "oauthTokenFingerprint"), false);

  for (const malformed of [
    (() => {
      const probe = providerProbe();
      delete probe.cutoverHistoryId;
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
    (() => {
      const probe = providerProbe();
      probe.productionPublicationAttempted = null;
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
    (() => {
      const probe = providerProbe();
      probe.profileEvidence.emailAddress = "wrong-mailbox@example.invalid";
      probe.profileResponseHash = sha256Json(probe.profileEvidence);
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
    (() => {
      const probe = providerProbe();
      delete probe.accountIdentity.expectedAccountEmail;
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
    (() => {
      const probe = providerProbe();
      probe.accountIdentity.profileAccountEmail = "wrong-mailbox@example.invalid";
      const bindingBody = { ...probe.accountIdentity };
      delete bindingBody.bindingHash;
      probe.accountIdentity.bindingHash = sha256Json(bindingBody);
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
    (() => {
      const probe = providerProbe();
      probe.checkpointEvidence.historyTypes = ["messageAdded"];
      const { probeHash: _ignored, ...body } = probe;
      return { ...body, probeHash: sha256Json(body) };
    })(),
  ]) {
    await assert.rejects(
      asService(db, async () => one(db, `select public.run_truth_gmail_backfill_forward_unblock(
        $1::uuid, $2::jsonb, $3::text
      ) as receipt`, [BATCH_ID, malformed, TOKEN])),
      /current-profile checkpoint probe envelope is invalid/,
    );
  }

  {
    const badBinding = providerProbe();
    badBinding.accountIdentity.bindingHash = "b".repeat(64);
    const { probeHash: _ignored, ...body } = badBinding;
    badBinding.probeHash = sha256Json(body);
    await assert.rejects(
      asService(db, async () => one(db, `select public.run_truth_gmail_backfill_forward_unblock(
        $1::uuid, $2::jsonb, $3::text
      ) as receipt`, [BATCH_ID, badBinding, TOKEN])),
      /environment\/profile account binding hash is invalid/,
    );
  }

  const receipt = await asService(db, async () => (
    await one(db, `select public.run_truth_gmail_backfill_forward_unblock(
      $1::uuid, $2::jsonb, $3::text
    ) as receipt`, [BATCH_ID, providerProbe(), TOKEN])
  ).receipt);
  assert.equal(receipt.status, "parked");
  assert.equal(receipt.cursorVersion, 1);
  assert.equal(receipt.cursorValue, CUTOVER_HISTORY_ID);
  assert.equal(receipt.cutoverHistoryId, CUTOVER_HISTORY_ID);
  assert.equal(receipt.commitWitnessPending, true);
  assert.equal(receipt.productionPublicationAttempted, false);

  const state = await one(db, `
    select batch.status as batch_status, batch.page_count,
      batch.observation_count, batch.job_count,
      batch.committed_cursor_version, batch.batch_hash,
      cursor_row.status as cursor_status, cursor_row.cursor_value,
      cursor_row.cursor_version, cursor_row.last_batch_id,
      cursor_row.last_committed_at, cursor_row.lease_owner,
      cursor_row.lease_fence, cursor_row.lease_expires_at,
      receipt.page_manifest_hash, receipt.provider_probe_hash,
      receipt.provider_account_email, receipt.provider_account_binding_hash,
      receipt.canonical_receipt #>>
        '{providerAccountIdentity,expectedAccountEmail}'
        as receipt_expected_account_email,
      receipt.canonical_receipt #>>
        '{providerAccountIdentity,profileAccountEmail}'
        as receipt_profile_account_email,
      receipt.canonical_receipt->>'productionPublicationAttempted'
        as publication_attempted,
      backfill_gap.status as backfill_gap_status,
      cutover_gap.status as cutover_gap_status,
      backfill_gap.prior_cursor_value as backfill_gap_start,
      backfill_gap.recovery_anchor_value as backfill_gap_end,
      cutover_gap.prior_cursor_value as cutover_gap_start,
      cutover_gap.recovery_anchor_value as cutover_gap_end,
      job.state as coordinator_state,
      job.last_error_code as coordinator_error
    from public.source_ingest_batches batch
    join public.source_cursors cursor_row
      on cursor_row.workspace_key = batch.workspace_key
     and cursor_row.source_system = batch.source_system
     and cursor_row.connection_key = batch.connection_key
    join public.truth_gmail_backfill_parking_receipts receipt
      on receipt.parked_batch_id = batch.batch_id
    join public.gmail_completeness_gaps backfill_gap
      on backfill_gap.gap_id = receipt.backfill_gap_id
    join public.gmail_completeness_gaps cutover_gap
      on cutover_gap.gap_id = receipt.cutover_delta_gap_id
    join public.source_processing_jobs job
      on job.job_id = receipt.coordinator_job_id
    where batch.batch_id = $1::uuid
  `, [BATCH_ID]);
  assert.deepEqual({
    batch_status: state.batch_status,
    page_count: state.page_count,
    observation_count: state.observation_count,
    job_count: state.job_count,
    committed_cursor_version: state.committed_cursor_version,
    batch_hash: state.batch_hash,
    cursor_status: state.cursor_status,
    cursor_value: state.cursor_value,
    cursor_version: state.cursor_version,
    last_batch_id: state.last_batch_id,
    last_committed_at: state.last_committed_at,
    lease_owner: state.lease_owner,
    lease_fence: state.lease_fence,
    lease_expires_at: state.lease_expires_at,
    publication_attempted: state.publication_attempted,
    provider_account_email: state.provider_account_email,
    provider_account_binding_hash: state.provider_account_binding_hash,
    receipt_expected_account_email: state.receipt_expected_account_email,
    receipt_profile_account_email: state.receipt_profile_account_email,
    backfill_gap_status: state.backfill_gap_status,
    cutover_gap_status: state.cutover_gap_status,
    backfill_gap_start: state.backfill_gap_start,
    backfill_gap_end: state.backfill_gap_end,
    cutover_gap_start: state.cutover_gap_start,
    cutover_gap_end: state.cutover_gap_end,
    coordinator_state: state.coordinator_state,
    coordinator_error: state.coordinator_error,
  }, {
    batch_status: "superseded",
    page_count: 2190,
    observation_count: 218989,
    job_count: 0,
    committed_cursor_version: null,
    batch_hash: null,
    cursor_status: "live",
    cursor_value: CUTOVER_HISTORY_ID,
    cursor_version: 1,
    last_batch_id: null,
    last_committed_at: null,
    lease_owner: null,
    lease_fence: 42,
    lease_expires_at: null,
    publication_attempted: "false",
    provider_account_email: PROVIDER_ACCOUNT,
    provider_account_binding_hash: providerAccountIdentity().bindingHash,
    receipt_expected_account_email: PROVIDER_ACCOUNT,
    receipt_profile_account_email: PROVIDER_ACCOUNT,
    backfill_gap_status: "open",
    cutover_gap_status: "open",
    backfill_gap_start: "",
    backfill_gap_end: ANCHOR,
    cutover_gap_start: ANCHOR,
    cutover_gap_end: CUTOVER_HISTORY_ID,
    coordinator_state: "waiting_runtime",
    coordinator_error: "HISTORICAL_DRAIN_COORDINATOR_REQUIRED",
  });
  assert.match(state.page_manifest_hash, /^[0-9a-f]{64}$/);
  assert.match(state.provider_probe_hash, /^[0-9a-f]{64}$/);

  const preserved = await one(db, `
    select
      (select count(*)::integer from public.gmail_ingest_pages
        where batch_id = $1::uuid) as page_count,
      (select count(*)::integer from public.gmail_ingest_page_observations
        where batch_id = $1::uuid) as membership_count,
      (select count(*)::integer from public.source_observations
        where batch_id = $1::uuid) as observation_count,
      (select count(*)::integer from public.gmail_ingest_page_jobs
        where batch_id = $1::uuid) as page_job_count,
      (select count(*)::integer from public.truth_builds) as build_count,
      (select count(*)::integer from public.truth_publications) as publication_count
  `, [BATCH_ID]);
  assert.deepEqual(preserved, {
    page_count: 2190,
    membership_count: 218989,
    observation_count: 218989,
    page_job_count: 0,
    build_count: 0,
    publication_count: 0,
  });
}

async function simulateNextHostedTick(db) {
  const owner = "hosted-truth-shadow-cron:forward-unblock-fixture";
  const lease = await asService(db, async () => (
    await one(db, `select public.acquire_source_sync_lease(
      '${WORKSPACE}', 'gmail', '${CONNECTION}', $1::text,
      90, 'gmail_history_id', $2::text
    ) as receipt`, [owner, TOKEN])
  ).receipt);
  assert.equal(lease.ok, true);
  assert.equal(lease.cursorValue, CUTOVER_HISTORY_ID);
  assert.equal(lease.cursorVersion, 1);
  assert.equal(lease.status, "live");

  const batch = await asService(db, async () => (
    await one(db, `select public.begin_source_ingest_batch(
      '${WORKSPACE}', 'gmail', '${CONNECTION}', $1::text,
      $2::bigint, 'history', 'hosted-truth-shadow-cron', $3::text
    ) as receipt`, [owner, lease.leaseFence, TOKEN])
  ).receipt);
  assert.equal(batch.mode, "history");
  assert.equal(batch.startCursorVersion, 1);
  assert.equal(batch.startCursorValue, CUTOVER_HISTORY_ID);
  assert.notEqual(batch.batchId, BATCH_ID);

  const response = {
    historyId: NEXT_HISTORY_ID,
    history: Array.from({ length: 20 }, (_, index) => ({
      id: String(Number(CUTOVER_HISTORY_ID) + index + 1),
      messagesAdded: [{
        message: {
          id: `cutover-message-${String(index + 1).padStart(3, "0")}`,
          threadId: `cutover-thread-${String(index + 1).padStart(3, "0")}`,
          labelIds: ["INBOX"],
        },
      }],
    })),
  };
  const normalizedPage = normalizeHistoryPage(response, {
    workspaceKey: WORKSPACE,
    connectionKey: CONNECTION,
  });
  const page = {
    pageOrdinal: 0,
    requestPageToken: "",
    responseNextPageToken: "",
    responseMailboxHistoryId: normalizedPage.responseMailboxHistoryId,
    firstHistoryId: normalizedPage.firstHistoryId,
    lastHistoryId: normalizedPage.lastHistoryId,
    providerResponse: normalizedPage.providerResponse,
    providerEvents: normalizedPage.providerEvents,
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
      normalizedPage.observations,
      normalizedPage.jobs,
      TOKEN,
    ])
  ).receipt);
  assert.equal(append.observationCount, 20);
  assert.equal(append.jobCount, 0);

  const started = performance.now();
  const committed = await asService(db, async () => (
    await one(db, `select public.commit_source_ingest_batch(
      $1::uuid, $2::text, $3::bigint, $4::text
    ) as receipt`, [batch.batchId, owner, lease.leaseFence, TOKEN])
  ).receipt);
  const elapsedMs = performance.now() - started;
  assert.equal(committed.ok, true);
  assert.equal(committed.committedCursorVersion, 2);
  assert.equal(committed.committedCursorValue, NEXT_HISTORY_ID);
  assert.ok(elapsedMs < 5000, `bounded next-tick commit took ${elapsedMs.toFixed(1)}ms`);

  const post = await one(db, `
    select cursor_row.cursor_value, cursor_row.cursor_version,
      cursor_row.status, cursor_row.last_batch_id,
      cursor_row.last_committed_at,
      cursor_row.last_error_code,
      batch.status as last_batch_status,
      batch.page_count, batch.observation_count, batch.job_count,
      gap.status as parking_gap_status,
      (select cutover_gap.status
       from public.gmail_completeness_gaps cutover_gap
       where cutover_gap.workspace_key = cursor_row.workspace_key
         and cutover_gap.connection_key = cursor_row.connection_key
         and cutover_gap.gap_type = 'GMAIL_CUTOVER_DELTA_RECONCILIATION')
        as cutover_gap_status,
      (select count(*)::integer
       from public.gmail_message_materialization_groups route
       where route.root_batch_id = batch.batch_id) as materialization_count,
      (select count(*)::integer
       from public.source_processing_job_lineage lineage
       where lineage.root_batch_id = batch.batch_id) as routed_job_count
    from public.source_cursors cursor_row
    join public.source_ingest_batches batch
      on batch.batch_id = cursor_row.last_batch_id
    join public.gmail_completeness_gaps gap
      on gap.gap_type = 'PARKED_BACKFILL_HISTORICAL_DRAIN'
     and gap.workspace_key = cursor_row.workspace_key
     and gap.connection_key = cursor_row.connection_key
    where cursor_row.workspace_key = '${WORKSPACE}'
      and cursor_row.source_system = 'gmail'
      and cursor_row.connection_key = '${CONNECTION}'
  `);
  assert.equal(post.cursor_value, NEXT_HISTORY_ID);
  assert.equal(post.cursor_version, 2);
  assert.equal(post.status, "live");
  assert.equal(post.last_batch_id, batch.batchId);
  assert.ok(post.last_committed_at);
  assert.equal(post.last_error_code, "");
  assert.equal(post.last_batch_status, "committed");
  assert.equal(post.page_count, 1);
  assert.equal(post.observation_count, 20);
  assert.equal(post.job_count, 0);
  assert.equal(post.materialization_count, 20);
  assert.equal(post.routed_job_count, 20);
  assert.equal(post.parking_gap_status, "open");
  assert.equal(post.cutover_gap_status, "open");
  return elapsedMs;
}

async function main() {
  verifyStaticContract();
  await verifyProviderProbeBuilder();
  const names = migrationNames();
  const targetIndex = names.indexOf(TARGET_MIGRATION);
  assert.ok(targetIndex >= 0, "full migration stack must include the forward-unblock authority");
  const db = await createDatabase();
  try {
    for (const name of names.slice(0, targetIndex)) {
      await applyMigration(db, name, "predecessor apply");
    }
    await assertNoDatabaseOAuthTable(db);
    await seedMegaBatch(db);
    await assertCommitCaps(db);
    await applyMigration(db, TARGET_MIGRATION, "initial target apply");
    await assertNoDatabaseOAuthTable(db);
    await assertCommitCaps(db);
    await verifyParking(db);
    const beforeReapply = await dataFingerprint(db);
    await applyMigration(db, TARGET_MIGRATION, "target reapply");
    await assertNoDatabaseOAuthTable(db);
    const afterReapply = await dataFingerprint(db);
    assert.equal(afterReapply.fingerprint, beforeReapply.fingerprint,
      "target migration reapply must preserve every parking artifact byte-for-byte");
    await assertCommitCaps(db);
    const commitElapsedMs = await simulateNextHostedTick(db);
    process.stdout.write(
      `truth Gmail primary ingest forward-unblock verifier passed ` +
      `(2190 pages / 218989 observations; 20-message next commit ` +
      `${commitElapsedMs.toFixed(1)}ms)\n`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

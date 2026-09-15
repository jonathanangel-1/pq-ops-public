#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const FULL_STACK_VERIFIER = path.join(ROOT, "scripts/verify-truth-full-migration-stack.js");
const INDEX_MIGRATION = "20260717010000_fix_truth_claim_query_plan.sql";
const TARGET_MIGRATION = "20260717180000_fix_truth_claim_gate_selection.sql";
const TARGET_PATH = path.join(MIGRATION_DIR, TARGET_MIGRATION);
const WORKSPACE_KEY = "primary";
const SOURCE_SYSTEM = "gmail";
const CONNECTION_KEY = "shadow-truth-claim-query-plan-fixture";
const UNRELATED_CONNECTION_KEY = "truth-claim-query-plan-unrelated";
const ROOT_BATCH_ID = "c3ae1fb8-b16d-4c3e-bcff-517768211d69";
const UNRELATED_BATCH_ID = "5f68c322-e8a2-4df3-af36-5e7ee7104725";
const SYNC_TOKEN = "truth-claim-query-plan-sync-token-v1";

function fullStackMigrationNames() {
  const source = fs.readFileSync(FULL_STACK_VERIFIER, "utf8");
  const declaration = source.match(
    /const MIGRATION_NAMES = Object\.freeze\(\[([\s\S]*?)\n\]\);/,
  );
  assert.ok(declaration, "full migration-stack declaration must remain readable");
  const declared = [...declaration[1].matchAll(/"([^"]+\.sql)"/g)]
    .map((match) => match[1]);
  return [...new Set([...declared, TARGET_MIGRATION])].sort();
}

function normalizeSql(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function planText(row) {
  const plan = row?.["QUERY PLAN"];
  return typeof plan === "string" ? plan : JSON.stringify(plan);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
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

async function applyMigrations(db, names, label) {
  for (const name of names) {
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
}

function verifyStaticMigration() {
  assert.ok(fs.existsSync(TARGET_PATH), `missing ${TARGET_MIGRATION}`);
  const source = normalizeSql(fs.readFileSync(TARGET_PATH, "utf8"));
  const replacementStart = source.indexOf("v_block text := $replacement$");
  const replacementEnd = source.indexOf("$replacement$;", replacementStart + 1);
  const replacement = source.slice(replacementStart, replacementEnd);
  const indexSource = normalizeSql(fs.readFileSync(
    path.join(MIGRATION_DIR, INDEX_MIGRATION),
    "utf8",
  ));
  for (const required of [
    "source_processing_jobs_lineage_bootstrap_scope_idx",
    "source_processing_job_lineage_claim_scope_idx",
    "include ( root_batch_id, source_cursor_version, source_cursor_value )",
    "analyze public.source_processing_jobs",
    "analyze public.source_processing_job_lineage",
  ]) {
    assert.ok(indexSource.includes(required), `index migration must preserve ${required}`);
  }
  for (const required of [
    "cheap_ordinary_claim_jobs as materialized",
    "cheap_message_model_claim_jobs as materialized",
    "admitted_message_model_claim_jobs as materialized",
    "cheap_attachment_model_claim_jobs as materialized",
    "admitted_attachment_model_claim_jobs as materialized",
    "truth_shadow_gmail_model_job_allowed_v3",
    "truth_shadow_model_commissioning_job_allowed",
    "for update of job skip locked",
    "reset all",
    "set search_path = ''",
  ]) {
    assert.ok(source.includes(required), `gate-selection migration must preserve ${required}`);
  }
  assert.ok(
    replacement.indexOf("limit p_limit")
      < replacement.indexOf("truth_shadow_gmail_model_job_allowed_v3"),
    "message-model LIMIT must appear before its admission gate",
  );
  assert.ok(
    replacement.indexOf("limit p_limit", replacement.indexOf("cheap_attachment_model_claim_jobs"))
      < replacement.indexOf(
        "truth_shadow_model_commissioning_job_allowed",
        replacement.indexOf("cheap_attachment_model_claim_jobs"),
      ),
    "attachment-model LIMIT must appear before its admission gate",
  );
  for (const forbidden of [
    "shipment-truth-packets",
    "publish_truth",
    "truth_publications",
    "delete from public.source_processing_jobs",
    "drop table public.source_processing_jobs",
    "set enable_nestloop",
    "set plan_cache_mode",
    "set statement_timeout",
    "set lock_timeout",
  ]) {
    assert.equal(source.includes(forbidden), false, `migration must not contain ${forbidden}`);
  }
}

async function verifyInstalledContract(db) {
  const indexes = await db.query(`
    select indexname, indexdef
    from pg_indexes
    where schemaname = 'public'
      and indexname = any(array[
        'source_processing_jobs_lineage_bootstrap_scope_idx',
        'source_processing_job_lineage_claim_scope_idx'
      ])
    order by indexname
  `);
  assert.equal(indexes.rows.length, 2, "both claim-query indexes must exist");
  const definitions = Object.fromEntries(
    indexes.rows.map((row) => [row.indexname, normalizeSql(row.indexdef)]),
  );
  assert.match(
    definitions.source_processing_jobs_lineage_bootstrap_scope_idx,
    /\(workspace_key, source_system, connection_key, job_id\)$/,
    "lineage-bootstrap index key order must remain exact",
  );
  assert.match(
    definitions.source_processing_job_lineage_claim_scope_idx,
    /\(workspace_key, source_system, connection_key, job_id\) include \(root_batch_id, source_cursor_version, source_cursor_value\)$/,
    "claim-lineage index keys and included witness columns must remain exact",
  );

  const functions = await db.query(`
    select n.nspname as schema_name, p.proconfig, p.procost,
      lower(pg_get_functiondef(p.oid)) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.oid = any(array[
      'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure,
      'public.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
    ]::oid[])
    order by n.nspname
  `);
  assert.equal(functions.rows.length, 2, "both claim authorities must exist");
  for (const row of functions.rows) {
    assert.deepEqual(
      row.proconfig,
      ['search_path=""'],
      `${row.schema_name} claim authority must use stock planner/timeouts`,
    );
    assert.equal(
      row.procost,
      100,
      `${row.schema_name} claim authority must retain the stock function cost`,
    );
  }
  const gateCosts = await db.query(`
    select p.proname, p.procost
    from pg_proc p
    where p.oid = any(array[
      'private.truth_shadow_gmail_model_job_allowed_v2(text,uuid)'::regprocedure,
      'private.truth_shadow_gmail_model_job_allowed_v3(text,uuid)'::regprocedure,
      'private.truth_shadow_model_commissioning_job_allowed(text,uuid)'::regprocedure
    ]::oid[])
    order by p.proname
  `);
  assert.equal(gateCosts.rows.length, 3);
  assert.ok(
    gateCosts.rows.every((row) => row.procost === 100),
    "all claim admission gates must retain the stock function cost",
  );
  const privateDefinition = functions.rows.find((row) => row.schema_name === "private").definition;
  assert.ok(
    privateDefinition.includes("truth_source_cut_mutation_lock(p_workspace_key)"),
    "private claim authority must preserve the source-cut mutation barrier",
  );
  assert.ok(
    (privateDefinition.match(/for update of job skip locked/g) || []).length >= 5,
    "expired lease, lineage bootstrap, and three bounded candidate classes must use SKIP LOCKED",
  );
  assert.ok(privateDefinition.includes("cheap_message_model_claim_jobs as materialized"));
  assert.ok(privateDefinition.includes("admitted_message_model_claim_jobs as materialized"));
  assert.ok(privateDefinition.includes("cheap_attachment_model_claim_jobs as materialized"));
  assert.ok(privateDefinition.includes("admitted_attachment_model_claim_jobs as materialized"));
  assert.equal(privateDefinition.includes("scoped_claim_jobs as materialized"), false);
  assert.equal(privateDefinition.includes("admitted_claim_jobs as materialized"), false);
  for (const readinessFence of [
    "batch.status = 'committed'",
    "batch.committed_cursor_version = lineage.source_cursor_version",
    "batch.committed_cursor_value = lineage.source_cursor_value",
    "lineage.source_cursor_value ~ '^[0-9]+$'",
    "gmail_fetch_raw_message",
    "gmail_review_model_extraction",
    "truth_gmail_link_epoch_members",
    "truth_gmail_link_epoch_seals",
    "gmail_message_materialization_groups",
    "prior_job.state not in ('succeeded', 'dead_letter', 'superseded')",
  ]) {
    assert.ok(
      privateDefinition.includes(readinessFence),
      `claim authority must preserve ${readinessFence}`,
    );
  }
}

async function seedFixture(db) {
  await db.exec("set session_replication_role = replica");
  try {
    await db.query(`
      insert into public.sync_tokens(token_name, token_hash)
      values ('local_snapshot_writer', $1)
      on conflict (token_name) do update set token_hash = excluded.token_hash
    `, [sha256(SYNC_TOKEN)]);
    await db.exec(`
      insert into public.source_ingest_batches(
        batch_id, workspace_key, source_system, connection_key, mode,
        trigger_name, expected_cursor_version, expected_cursor_value,
        committed_cursor_version, committed_cursor_value, lease_owner,
        lease_fence, status, batch_hash
      ) values
        (
          '${ROOT_BATCH_ID}', '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
          '${CONNECTION_KEY}', 'backfill', 'claim-query-plan-verifier',
          0, '', 1, '1', 'claim-query-plan-verifier', 1, 'committed',
          repeat('a', 64)
        ),
        (
          '${UNRELATED_BATCH_ID}', '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
          '${UNRELATED_CONNECTION_KEY}', 'backfill', 'claim-query-plan-verifier',
          0, '', 2, '2', 'claim-query-plan-verifier', 1, 'committed',
          repeat('b', 64)
        );

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-message-' || ordinal, '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
        '${CONNECTION_KEY}', 'gmail_extract_message_claims',
        'message-' || ordinal, 'queued', 0, 5,
        clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '2 hours', '{}'::jsonb
      from generate_series(1, 20) ordinal;

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-attachment-' || ordinal, '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
        '${CONNECTION_KEY}', 'gmail_extract_attachment_claims',
        'attachment-' || ordinal, 'queued', 0, 5,
        clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '2 hours', '{}'::jsonb
      from generate_series(1, 10) ordinal;

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload, last_error_code
      )
      select
        'claim-plan-review-' || ordinal, '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
        '${CONNECTION_KEY}', 'gmail_review_attachment_extraction',
        'review-' || ordinal, 'waiting_runtime', 0, 5,
        clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '2 hours', '{}'::jsonb,
        'ATTACHMENT_EXTRACTION_REVIEW_REQUIRED'
      from generate_series(1, 175) ordinal;

      -- Production pathology: hundreds of same-coordinate lineage rows but
      -- only a few model-gated jobs requested by the worker.
      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-lineage-distractor-' || ordinal,
        '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}', '${CONNECTION_KEY}',
        'gmail_extract_message_claims', 'lineage-distractor-' || ordinal,
        'queued', 0, 5,
        clock_timestamp() - interval '30 minutes',
        clock_timestamp() - interval '90 minutes', '{}'::jsonb
      from generate_series(1, 725) ordinal;

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-message-model-' || ordinal,
        '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}', '${CONNECTION_KEY}',
        'gmail_extract_message_model_claims', 'message-model-' || ordinal,
        'queued', 0, 5,
        clock_timestamp() - interval '3 hours' + ordinal * interval '1 second',
        clock_timestamp() - interval '4 hours' + ordinal * interval '1 second',
        jsonb_build_object('gateAllowed', true)
      from generate_series(1, 7) ordinal;

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-attachment-model-' || ordinal,
        '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}', '${CONNECTION_KEY}',
        'gmail_review_attachment_extraction', 'attachment-model-' || ordinal,
        'queued', 0, 5,
        clock_timestamp() - interval '2 hours' + ordinal * interval '1 second',
        clock_timestamp() - interval '3 hours' + ordinal * interval '1 second',
        jsonb_build_object('gateAllowed', true)
      from generate_series(1, 7) ordinal;

      insert into public.source_processing_jobs(
        dedupe_key, workspace_key, source_system, connection_key, job_kind,
        source_object_id, state, attempt_count, max_attempts, available_at,
        created_at, payload
      )
      select
        'claim-plan-unrelated-' || ordinal, '${WORKSPACE_KEY}', '${SOURCE_SYSTEM}',
        '${UNRELATED_CONNECTION_KEY}', 'gmail_extract_message_claims',
        'unrelated-' || ordinal, 'queued', 0, 5,
        clock_timestamp() - interval '1 hour',
        clock_timestamp() - interval '2 hours', '{}'::jsonb
      from generate_series(1, 50000) ordinal;

      insert into public.source_processing_job_lineage(
        job_id, workspace_key, source_system, connection_key, root_batch_id,
        parent_job_id, root_job_id, source_cursor_version, source_cursor_value
      )
      select
        job.job_id, job.workspace_key, job.source_system, job.connection_key,
        case when job.connection_key = '${UNRELATED_CONNECTION_KEY}'
          then '${UNRELATED_BATCH_ID}'::uuid else '${ROOT_BATCH_ID}'::uuid end,
        null, job.job_id,
        case when job.connection_key = '${UNRELATED_CONNECTION_KEY}' then 2 else 1 end,
        case when job.connection_key = '${UNRELATED_CONNECTION_KEY}' then '2' else '1' end
      from public.source_processing_jobs job
      where job.connection_key in ('${CONNECTION_KEY}', '${UNRELATED_CONNECTION_KEY}');

      with canonical as (
        select '{}'::jsonb as value
      ), identity as (
        select value, encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(value), 'UTF8'
        ), 'sha256'), 'hex') as hash
        from canonical
      )
      insert into public.truth_gmail_link_epochs(
        workspace_key, root_batch_id, connection_key, parse_checkpoint_id,
        parse_checkpoint_hash, epoch_id, canonical_epoch, epoch_hash,
        schema_version
      )
      select
        '${WORKSPACE_KEY}', '${ROOT_BATCH_ID}', '${CONNECTION_KEY}',
        'gmail-parse-checkpoint:v1:' || repeat('c', 64), repeat('d', 64),
        'gmail-link-epoch:v1:' || hash, value, hash, 'gmail-link-epoch-v1'
      from identity;

      with canonical as (
        select '{}'::jsonb as value
      ), identity as (
        select value, encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(value), 'UTF8'
        ), 'sha256'), 'hex') as hash
        from canonical
      )
      insert into public.truth_gmail_link_epoch_seals(
        workspace_key, epoch_id, link_manifest_hash, link_member_count,
        seal_id, canonical_seal, seal_hash, schema_version
      )
      select
        '${WORKSPACE_KEY}', epoch.epoch_id, repeat('e', 64), 0,
        'gmail-link-epoch-seal:v1:' || identity.hash,
        identity.value, identity.hash, 'gmail-link-epoch-seal-v1'
      from identity
      cross join public.truth_gmail_link_epochs epoch
      where epoch.workspace_key = '${WORKSPACE_KEY}'
        and epoch.root_batch_id = '${ROOT_BATCH_ID}';
    `);
  } finally {
    await db.exec("set session_replication_role = origin");
  }
  await db.exec(`
    analyze public.source_processing_jobs;
    analyze public.source_processing_job_lineage;
    analyze public.source_ingest_batches;
    analyze public.truth_gmail_link_epochs;
    analyze public.truth_gmail_link_epoch_seals;
  `);
}

async function installGateEvaluationProbe(db) {
  await db.exec(`
    create table public.claim_gate_evaluation_probe (
      gate_name text not null,
      job_id uuid not null,
      call_count integer not null default 1,
      primary key (gate_name, job_id)
    );

    create or replace function private.truth_shadow_gmail_model_job_allowed_v3(
      p_workspace_key text,
      p_job_id uuid
    ) returns boolean
    language plpgsql
    volatile
    security definer
    set search_path = ''
    as $probe$
    declare
      v_allowed boolean;
    begin
      insert into public.claim_gate_evaluation_probe(gate_name, job_id)
      values ('message_model', p_job_id)
      on conflict (gate_name, job_id) do update
      set call_count = public.claim_gate_evaluation_probe.call_count + 1;
      select coalesce((job.payload->>'gateAllowed')::boolean, false)
      into v_allowed
      from public.source_processing_jobs job
      where job.workspace_key = p_workspace_key
        and job.job_id = p_job_id;
      return coalesce(v_allowed, false);
    end;
    $probe$;

    create or replace function private.truth_shadow_model_commissioning_job_allowed(
      p_workspace_key text,
      p_job_id uuid
    ) returns boolean
    language plpgsql
    volatile
    security definer
    set search_path = ''
    as $probe$
    declare
      v_allowed boolean;
    begin
      insert into public.claim_gate_evaluation_probe(gate_name, job_id)
      values ('attachment_model', p_job_id)
      on conflict (gate_name, job_id) do update
      set call_count = public.claim_gate_evaluation_probe.call_count + 1;
      select coalesce((job.payload->>'gateAllowed')::boolean, false)
      into v_allowed
      from public.source_processing_jobs job
      where job.workspace_key = p_workspace_key
        and job.job_id = p_job_id;
      return coalesce(v_allowed, false);
    end;
    $probe$;
  `);
}

function normalizeClaimReceipt(receipt) {
  return {
    ...receipt,
    jobs: receipt.jobs.map(({ leaseExpiresAt: _ignored, ...job }) => job),
  };
}

async function runInstrumentedClaim(db, schemaName) {
  await db.exec("begin");
  try {
    await db.exec("delete from public.claim_gate_evaluation_probe");
    const result = await db.query(`
      select ${schemaName}.claim_source_processing_jobs(
        $1::text, $2::text, $3::text, $4::text, $5::text,
        3, 900,
        array[
          'gmail_extract_message_model_claims',
          'gmail_review_attachment_extraction'
        ]::text[],
        $6::text
      ) as receipt
    `, [
      WORKSPACE_KEY,
      SOURCE_SYSTEM,
      CONNECTION_KEY,
      "truth-claim-gate-verifier",
      "truth-claim-gate-plan-v1",
      SYNC_TOKEN,
    ]);
    const counts = await db.query(`
      select gate_name,
        sum(call_count)::integer as call_count,
        count(*)::integer as distinct_job_count,
        max(call_count)::integer as maximum_calls_per_job
      from public.claim_gate_evaluation_probe
      group by gate_name
      order by gate_name
    `);
    return { receipt: result.rows[0].receipt, counts: counts.rows };
  } finally {
    await db.exec("rollback");
  }
}

async function verifyBoundedGateEvaluations(db) {
  const publicRun = await runInstrumentedClaim(db, "public");
  const privateRun = await runInstrumentedClaim(db, "private");
  const expectedCounts = [
    {
      gate_name: "attachment_model",
      call_count: 3,
      distinct_job_count: 3,
      maximum_calls_per_job: 1,
    },
    {
      gate_name: "message_model",
      call_count: 3,
      distinct_job_count: 3,
      maximum_calls_per_job: 1,
    },
  ];
  assert.deepEqual(publicRun.counts, expectedCounts);
  assert.deepEqual(privateRun.counts, expectedCounts);
  assert.equal(publicRun.receipt.claimedCount, 3);
  assert.equal(privateRun.receipt.claimedCount, 3);
  assert.deepEqual(
    normalizeClaimReceipt(publicRun.receipt),
    normalizeClaimReceipt(privateRun.receipt),
    "public and private claim variants must return the same receipt contract",
  );
  assert.deepEqual(
    [...new Set(publicRun.receipt.jobs.map((job) => job.jobKind))],
    ["gmail_extract_message_model_claims"],
    "global ordering must retain the earliest admitted gated jobs",
  );
  return {
    metrics: {
      lineageRowsInPathologyScope: 944,
      requestedLimit: 3,
      messageGateEvaluations: 3,
      attachmentGateEvaluations: 3,
      maximumTotalGateEvaluations: 6,
    },
    receipt: normalizeClaimReceipt(publicRun.receipt),
  };
}

async function verifyLegacyUnboundedGateEvaluations(db) {
  const publicRun = await runInstrumentedClaim(db, "public");
  const privateRun = await runInstrumentedClaim(db, "private");
  const expectedCounts = [
    {
      gate_name: "attachment_model",
      call_count: 7,
      distinct_job_count: 7,
      maximum_calls_per_job: 1,
    },
    {
      gate_name: "message_model",
      call_count: 7,
      distinct_job_count: 7,
      maximum_calls_per_job: 1,
    },
  ];
  assert.deepEqual(publicRun.counts, expectedCounts);
  assert.deepEqual(privateRun.counts, expectedCounts);
  assert.deepEqual(
    normalizeClaimReceipt(publicRun.receipt),
    normalizeClaimReceipt(privateRun.receipt),
    "legacy public and private claim variants must share one receipt contract",
  );
  return {
    metrics: {
      messageGateEvaluations: 7,
      attachmentGateEvaluations: 7,
    },
    receipt: normalizeClaimReceipt(publicRun.receipt),
  };
}

async function explainPlans(db) {
  const bootstrap = await db.query(`
    explain (format json)
    with lineage_job_candidates as materialized (
      select job.job_id
      from public.source_processing_jobs job
      where job.workspace_key = '${WORKSPACE_KEY}'
        and job.source_system = '${SOURCE_SYSTEM}'
        and job.connection_key = '${CONNECTION_KEY}'
        and not exists (
          select 1 from public.source_processing_job_lineage lineage
          where lineage.job_id = job.job_id
        )
      order by job.job_id
      for update of job skip locked
      limit 100
    )
    select count(*) from lineage_job_candidates
  `);
  const bootstrapPlan = planText(bootstrap.rows[0]);
  assert.equal(
    /"Node Type":"Seq Scan"[^}]*"Relation Name":"source_processing_jobs"/.test(bootstrapPlan),
    false,
    "lineage bootstrap must not sequentially scan the complete job table",
  );
  assert.ok(
    bootstrapPlan.includes("source_processing_jobs_lineage_bootstrap_scope_idx"),
    "lineage bootstrap must use its all-state coordinate index",
  );

  const candidates = await db.query(`
    explain (format json)
    select job.job_id
    from public.source_processing_jobs job
    join public.source_processing_job_lineage lineage
      on lineage.job_id = job.job_id
     and lineage.workspace_key = job.workspace_key
     and lineage.source_system = job.source_system
     and lineage.connection_key = job.connection_key
    join public.source_ingest_batches batch
      on batch.batch_id = lineage.root_batch_id
     and batch.workspace_key = lineage.workspace_key
     and batch.source_system = lineage.source_system
     and batch.connection_key = lineage.connection_key
     and batch.status = 'committed'
     and batch.committed_cursor_version = lineage.source_cursor_version
     and batch.committed_cursor_value = lineage.source_cursor_value
    where job.workspace_key = '${WORKSPACE_KEY}'
      and job.source_system = '${SOURCE_SYSTEM}'
      and job.connection_key = '${CONNECTION_KEY}'
      and job.state in ('queued', 'retry_wait')
      and job.available_at <= clock_timestamp()
      and job.attempt_count < job.max_attempts
      and job.job_kind = 'gmail_extract_message_claims'
      and lineage.source_cursor_value ~ '^[0-9]+$'
      and exists (
        select 1
        from public.truth_gmail_link_epochs epoch
        join public.truth_gmail_link_epoch_seals seal
          on seal.workspace_key = epoch.workspace_key
         and seal.epoch_id = epoch.epoch_id
        where epoch.workspace_key = job.workspace_key
          and epoch.root_batch_id = lineage.root_batch_id
      )
    order by job.available_at, job.created_at, job.job_id
    for update of job skip locked
    limit 10
  `);
  const candidatePlan = planText(candidates.rows[0]);
  for (const relation of ["source_processing_jobs", "source_processing_job_lineage"]) {
    assert.equal(
      new RegExp(`"Node Type":"Seq Scan"[^}]*"Relation Name":"${relation}"`).test(candidatePlan),
      false,
      `candidate claim must not sequentially scan ${relation}`,
    );
  }
  const candidateIndex = [
    "source_processing_jobs_claim_scope_kind_idx",
    "source_processing_job_lineage_claim_scope_idx",
    "source_processing_jobs_scope_claim_idx",
    "source_processing_job_lineage_shadow_root_idx",
    "source_processing_job_lineage_shadow_cursor_root_idx",
    "source_processing_jobs_lineage_bootstrap_scope_idx",
  ].find((indexName) => candidatePlan.includes(indexName));
  const observedIndexes = [...candidatePlan.matchAll(/"Index Name":"([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(
    candidateIndex,
    `candidate claim must start from a bounded coordinate access path; observed ${[
      ...new Set(observedIndexes),
    ].join(", ")}`,
  );
  return {
    bootstrapUsesScopeIndex: true,
    candidateUsesBoundedIndex: true,
    candidateIndex,
  };
}

async function verifyWaitingReviewsAreNotClaimed(db) {
  await db.exec("begin");
  try {
    const result = await db.query(`
      select public.claim_source_processing_jobs(
        $1::text, $2::text, $3::text, $4::text, $5::text,
        50, 900, array[
          'gmail_extract_message_claims',
          'gmail_extract_attachment_claims'
        ]::text[], $6::text
      ) as receipt
    `, [
      WORKSPACE_KEY,
      SOURCE_SYSTEM,
      CONNECTION_KEY,
      "truth-claim-query-plan-verifier",
      "truth-claim-query-plan-verifier-v1",
      SYNC_TOKEN,
    ]);
    const receipt = result.rows[0].receipt;
    assert.equal(receipt.ok, true);
    assert.equal(receipt.claimedCount, 50, "ordinary claims must fill the requested bounded lease");
    assert.deepEqual(
      [...new Set(receipt.jobs.map((job) => job.jobKind))].sort(),
      ["gmail_extract_attachment_claims", "gmail_extract_message_claims"],
      "waiting attachment reviews must not appear in an ordinary claim receipt",
    );
    const states = await db.query(`
      select state, count(*)::integer as count
      from public.source_processing_jobs
      where workspace_key = $1
        and source_system = $2
        and connection_key = $3
        and job_kind = 'gmail_review_attachment_extraction'
        and dedupe_key like 'claim-plan-review-%'
      group by state
    `, [WORKSPACE_KEY, SOURCE_SYSTEM, CONNECTION_KEY]);
    assert.deepEqual(
      states.rows,
      [{ state: "waiting_runtime", count: 175 }],
      "all 175 attachment reviews must remain explicit and unleased",
    );
  } finally {
    await db.exec("rollback");
  }
}

async function main() {
  verifyStaticMigration();
  const migrationNames = fullStackMigrationNames();
  const targetIndex = migrationNames.indexOf(TARGET_MIGRATION);
  assert.ok(targetIndex >= 0, "query-plan repair must remain in the full migration stack");
  for (const laterMigration of migrationNames.slice(targetIndex + 1)) {
    const laterSource = fs.readFileSync(path.join(MIGRATION_DIR, laterMigration), "utf8");
    assert.doesNotMatch(
      laterSource,
      /create\s+or\s+replace\s+function\s+(?:public|private)\.claim_source_processing_jobs\s*\(/i,
      `${laterMigration} must not replace the durable claim-query authority`,
    );
  }
  const db = await createDatabase();
  try {
    const predecessors = migrationNames.slice(0, targetIndex);
    await applyMigrations(db, predecessors, "initial predecessor application");
    await applyMigrations(db, predecessors, "predecessor reapplication");
    await seedFixture(db);
    await installGateEvaluationProbe(db);
    const legacyGateProof = await verifyLegacyUnboundedGateEvaluations(db);
    await applyMigrations(db, [TARGET_MIGRATION], "initial target application");
    await applyMigrations(db, [TARGET_MIGRATION], "target reapplication");
    await verifyInstalledContract(db);
    const explain = await explainPlans(db);
    const gateProof = await verifyBoundedGateEvaluations(db);
    assert.deepEqual(
      gateProof.receipt,
      legacyGateProof.receipt,
      "post-limit gate selection must preserve the predecessor receipt byte shape and ordering",
    );
    await verifyWaitingReviewsAreNotClaimed(db);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "truth-claim-query-plan",
      migration: TARGET_MIGRATION,
      migrationCount: migrationNames.length,
      reapplications: 2,
      fixture: {
        scopedOrdinaryQueuedClaims: 755,
        scopedGatedQueuedClaims: 14,
        scopedWaitingAttachmentReviews: 175,
        sameScopeLineageRows: 944,
        unrelatedJobs: 50000,
      },
      explain,
      legacyGateEvaluation: legacyGateProof.metrics,
      gateEvaluation: gateProof.metrics,
      guarantees: [
        "the full truth migration stack and query-plan repair reapply safely",
        "claim planning uses stock PostgreSQL planner and timeout settings in both entry points",
        "legacy lineage bootstrap and candidate selection use bounded coordinate indexes",
        "the workspace source-cut mutation barrier and all five SKIP LOCKED acquisition sites remain intact",
        "message and attachment admission gates evaluate once per row only after a p_limit-bounded cheap candidate window",
        "the exact predecessor evaluates all seven gated rows per class, proving the fixture catches the incident regression",
        "waiting attachment reviews remain visible and cannot be leased as ordinary work",
        "no live call or production publication occurs",
      ],
      liveCalls: 0,
      productionPublications: 0,
    }, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});

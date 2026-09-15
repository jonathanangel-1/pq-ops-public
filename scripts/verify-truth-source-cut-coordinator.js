#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
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
  "20260709231000_truth_workspace_registry.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));

const TOKEN = "truth-source-cut-coordinator-test-token";
const WORKSPACE = "primary";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
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

async function installBase(db, { includeCoordinator = true } = {}) {
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
  const selected = includeCoordinator ? MIGRATIONS : MIGRATIONS.slice(0, -1);
  for (const migration of selected) await db.exec(fs.readFileSync(migration, "utf8"));
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values ('local_snapshot_writer', encode(
      extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'),
      'hex'
    ))
  `, [TOKEN]);
}

async function sealCurrent(db, token = TOKEN, createdBy = "source-cut-coordinator-verifier") {
  return (await one(db, `
    select public.seal_current_source_cut(
      $1::text, $2::text, $3::text
    ) as receipt
  `, [WORKSPACE, createdBy, token])).receipt;
}

function sourceContract(sourceSystem) {
  if (sourceSystem === "gmail") {
    return { cursorKind: "gmail_history_id", objectType: "gmail_message" };
  }
  if (sourceSystem === "tms") {
    return { cursorKind: "tms_snapshot_timestamp", objectType: "tms_shipment_snapshot" };
  }
  if (sourceSystem === "tracking") {
    return { cursorKind: "tracking_snapshot_timestamp", objectType: "tracking_shipment_snapshot" };
  }
  throw new Error(`Unsupported test source ${sourceSystem}`);
}

async function seedCommittedSource(db, {
  sourceSystem,
  connectionKey,
  version,
  cursorValue,
  sourceSnapshotAt,
  withObservation = true,
}) {
  const contract = sourceContract(sourceSystem);
  const batchHash = sha256(`batch:${sourceSystem}:${connectionKey}:${version}:${cursorValue}`);
  const observationHash = sha256(`content:${sourceSystem}:${connectionKey}:${version}`);
  const observationId = `obs:v1:${sha256(`observation:${sourceSystem}:${connectionKey}:${version}`)}`;
  const committedAt = new Date().toISOString();

  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence,
      last_error_code, last_error_detail
    ) values ($1, $2, $3, $4, $5, $6, 'live', 1, '', '')
    on conflict (workspace_key, source_system, connection_key) do update
    set cursor_kind = excluded.cursor_kind,
        cursor_value = excluded.cursor_value,
        cursor_version = excluded.cursor_version,
        status = 'live',
        last_error_code = '',
        last_error_detail = ''
  `, [WORKSPACE, sourceSystem, connectionKey, contract.cursorKind, cursorValue, version]);

  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count,
      committed_at, finished_at
    ) values (
      $1, $2, $3, $4, 'source-cut-coordinator-verifier',
      $5, $6, $7, $8,
      'source-cut-coordinator-verifier', 1, 'committed', $9,
      0, $10, 0, $11::timestamptz, $11::timestamptz
    ) returning batch_id
  `, [
    WORKSPACE,
    sourceSystem,
    connectionKey,
    sourceSystem === "gmail" ? "history" : "snapshot",
    Math.max(0, version - 1),
    version > 1 ? String(version - 1) : "",
    version,
    cursorValue,
    batchHash,
    withObservation ? 1 : 0,
    committedAt,
  ]);

  if (withObservation) {
    await db.query(`
      insert into public.source_observations (
        observation_id, workspace_key, source_system, connection_key,
        source_object_type, source_object_id, source_revision, operation,
        source_cursor_version, batch_id, content_hash, source_recorded_at,
        captured_at, normalized_payload, normalized_text, source_fidelity,
        schema_version
      ) values (
        $1, $2, $3, $4, $5, $6, $7, 'content',
        $8, $9::uuid, $10, $11::timestamptz,
        $12::timestamptz, '{}'::jsonb, 'coordinator evidence',
        'normalized_source', 'source-observation-v1'
      )
    `, [
      observationId,
      WORKSPACE,
      sourceSystem,
      connectionKey,
      contract.objectType,
      `${sourceSystem}-object-${version}`,
      String(version),
      version,
      batch.batch_id,
      observationHash,
      sourceSnapshotAt,
      committedAt,
    ]);
  }

  if (sourceSystem !== "gmail") {
    const providerManifest = {
      schemaVersion: sourceSystem === "tms"
        ? "tms-detail-source-snapshot-v1"
        : "tracking-source-snapshot-v1",
      sourceSystem,
      connectionKey,
      upstreamWatermark: cursorValue,
      sourceSnapshotAt,
    };
    const observationManifest = withObservation
      ? [{ observationId, contentHash: observationHash }]
      : [];
    await db.query(`
      insert into public.source_ingest_manifests (
        batch_id, workspace_key, source_system, connection_key,
        next_cursor_value, source_snapshot_at, provider_manifest,
        provider_manifest_hash, observation_manifest,
        observation_manifest_hash, job_manifest, job_manifest_hash,
        payload_identity_hash
      ) values (
        $1::uuid, $2, $3, $4, $5, $6::timestamptz, $7::jsonb,
        encode(extensions.digest(convert_to($7::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        $8::jsonb,
        encode(extensions.digest(convert_to($8::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        '[]'::jsonb,
        encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        encode(extensions.digest(convert_to(jsonb_build_object(
          'batchId', $1::text,
          'provider', $7::jsonb,
          'observations', $8::jsonb
        )::text, 'UTF8'), 'sha256'), 'hex')
      )
    `, [
      batch.batch_id,
      WORKSPACE,
      sourceSystem,
      connectionKey,
      cursorValue,
      sourceSnapshotAt,
      JSON.stringify(providerManifest),
      JSON.stringify(observationManifest),
    ]);
  }

  await db.query(`
    update public.source_cursors
    set last_batch_id = $1::uuid,
        last_committed_at = $2::timestamptz,
        updated_at = clock_timestamp()
    where workspace_key = $3
      and source_system = $4
      and connection_key = $5
  `, [batch.batch_id, committedAt, WORKSPACE, sourceSystem, connectionKey]);

  return { batchId: batch.batch_id, observationId, contentHash: observationHash };
}

async function insertUncommittedBatch(db, { status }) {
  return one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      lease_owner, lease_fence, status, error_code, error_detail,
      started_at, finished_at
    )
    select
      cursor.workspace_key, cursor.source_system, cursor.connection_key,
      'history', 'source-cut-${status}-adversary',
      cursor.cursor_version, cursor.cursor_value,
      'source-cut-adversary', 1, $1,
      case when $1 = 'failed' then 'VERIFY_FAILED_BATCH' else '' end,
      case when $1 = 'failed' then 'current failed source batch' else '' end,
      clock_timestamp(),
      case when $1 = 'failed' then clock_timestamp() else null end
    from public.source_cursors cursor
    where cursor.workspace_key = $2
      and cursor.source_system = 'gmail'
      and cursor.connection_key = 'primary'
    returning batch_id
  `, [status, WORKSPACE]);
}

function gapTypes(receipt) {
  return new Set((receipt.gaps || []).map((gap) => gap.gapType));
}

async function verifyCoordinator() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await installBase(db);

    await expectSqlState(
      sealCurrent(db, "invalid-source-cut-token"),
      "28000",
      "source-cut coordinator requires the writer token",
    );

    const registry = await db.query(`
      select source_system, connection_key, cursor_kind,
             freshness_seconds, allow_empty_scope
      from public.truth_required_sources
      where workspace_key = 'primary'
      order by source_system, connection_key
    `);
    assert.deepEqual(registry.rows.map((row) => row.source_system), [
      "gmail", "operator", "tms", "tracking",
    ]);
    assert.equal(registry.rows.find((row) => row.source_system === "tms").cursor_kind,
      "tms_snapshot_timestamp");
    assert.equal(registry.rows.find((row) => row.source_system === "tracking").cursor_kind,
      "tracking_snapshot_timestamp");

    const genesis = await one(db, `
      select cursor.cursor_value, cursor.cursor_version, cursor.status,
             cursor.last_batch_id, batch.status as batch_status,
             batch.observation_count,
             manifest.provider_manifest->>'upstreamWatermark' as upstream_watermark
      from public.source_cursors cursor
      join public.source_ingest_batches batch on batch.batch_id = cursor.last_batch_id
      join public.source_ingest_manifests manifest on manifest.batch_id = batch.batch_id
      where cursor.workspace_key = 'primary'
        and cursor.source_system = 'operator'
        and cursor.connection_key = 'operator-phone-primary'
    `);
    assert.equal(genesis.cursor_value, "0");
    assert.equal(genesis.cursor_version, 0);
    assert.equal(genesis.status, "live");
    assert.equal(genesis.batch_status, "committed");
    assert.equal(genesis.observation_count, 0);
    assert.equal(genesis.upstream_watermark, "0");

    const missing = await sealCurrent(db);
    assert.equal(missing.status, "not_ready");
    assert.equal(missing.sourceCutId, null);
    assert.ok(gapTypes(missing).has("REQUIRED_SOURCE_CURSOR_MISSING"));
    assert.equal((await one(db, "select count(*)::integer as count from public.source_cuts")).count, 0);

    await db.query(`
      insert into public.source_cursors (
        workspace_key, source_system, connection_key, cursor_kind,
        cursor_value, cursor_version, status
      ) values ('primary', 'gmail', 'primary', 'gmail_history_id', '', 0, 'backfill_required')
    `);
    const uninitialized = await sealCurrent(db);
    assert.equal(uninitialized.status, "not_ready");
    assert.ok(gapTypes(uninitialized).has("REQUIRED_SOURCE_CURSOR_UNINITIALIZED"));
    assert.equal((await one(db, "select count(*)::integer as count from public.source_cuts")).count, 0);

    const freshNow = new Date().toISOString();
    await seedCommittedSource(db, {
      sourceSystem: "gmail",
      connectionKey: "primary",
      version: 1,
      cursorValue: "100",
      sourceSnapshotAt: freshNow,
      withObservation: false,
    });
    await seedCommittedSource(db, {
      sourceSystem: "tms",
      connectionKey: "couriercloud-ops-tlv-us",
      version: 1,
      cursorValue: "2000-01-01T00:00:00.000Z",
      sourceSnapshotAt: "2000-01-01T00:00:00.000Z",
      withObservation: true,
    });
    await seedCommittedSource(db, {
      sourceSystem: "tracking",
      connectionKey: "carrier-tracking-primary",
      version: 1,
      cursorValue: freshNow,
      sourceSnapshotAt: freshNow,
      withObservation: true,
    });

    const emptyAndStale = await sealCurrent(db);
    assert.equal(emptyAndStale.status, "sealed");
    assert.equal(emptyAndStale.completeness, "degraded");
    assert.ok(gapTypes(emptyAndStale).has("REQUIRED_SOURCE_EMPTY"));
    assert.ok(gapTypes(emptyAndStale).has("REQUIRED_SOURCE_STALE"));
    assert.ok(emptyAndStale.sourceCutId);
    assert.equal(Object.hasOwn(emptyAndStale.manifest, "observations"), false);

    await seedCommittedSource(db, {
      sourceSystem: "gmail",
      connectionKey: "primary",
      version: 2,
      cursorValue: "200",
      sourceSnapshotAt: new Date().toISOString(),
      withObservation: true,
    });
    const staleOnly = await sealCurrent(db);
    assert.equal(staleOnly.completeness, "degraded");
    assert.equal(gapTypes(staleOnly).has("REQUIRED_SOURCE_EMPTY"), false);
    assert.ok(gapTypes(staleOnly).has("REQUIRED_SOURCE_STALE"));

    const tmsFresh = new Date().toISOString();
    await seedCommittedSource(db, {
      sourceSystem: "tms",
      connectionKey: "couriercloud-ops-tlv-us",
      version: 2,
      cursorValue: tmsFresh,
      sourceSnapshotAt: tmsFresh,
      withObservation: true,
    });
    const complete = await sealCurrent(db);
    assert.equal(complete.status, "sealed");
    assert.equal(complete.completeness, "complete");
    assert.equal(complete.manifest.schemaVersion, "source-cut-manifest-v2");
    assert.equal(complete.manifest.partitionWitnessVersion, "source-cut-partition-witness-v1");
    assert.equal(complete.manifest.requiredSources.length, 4);
    assert.equal(complete.manifest.cursors.length, 4);
    assert.deepEqual(
      complete.manifest.requiredSources.map((row) => `${row.sourceSystem}:${row.connectionKey}`).sort(),
      complete.manifest.cursors.map((row) => `${row.sourceSystem}:${row.connectionKey}`).sort(),
    );
    const operatorPartition = complete.manifest.cursors.find((row) => row.sourceSystem === "operator");
    assert.equal(operatorPartition.observationCount, 0);
    assert.equal(operatorPartition.emptyScope, true);
    assert.ok(complete.manifest.cursors.filter((row) => row.sourceSystem !== "operator")
      .every((row) => row.observationCount > 0 && row.emptyScope === false));
    assert.equal((await one(db, `
      select count(*)::integer as count from public.source_cut_observations
      where source_cut_id = $1
    `, [complete.sourceCutId])).count, 0);
    assert.equal((await one(db, `
      select count(*)::integer as count from public.source_cut_cursors
      where source_cut_id = $1
    `, [complete.sourceCutId])).count, 4);

    const running = await insertUncommittedBatch(db, { status: "running" });
    const openCut = await sealCurrent(db);
    assert.equal(openCut.completeness, "degraded");
    assert.ok(gapTypes(openCut).has("SOURCE_INGEST_BATCH_OPEN"));
    assert.ok(openCut.gaps.some((gap) => gap.batchId === running.batch_id && gap.batchStatus === "running"));
    await db.query(`
      update public.source_ingest_batches
      set status = 'superseded', finished_at = clock_timestamp()
      where batch_id = $1::uuid
    `, [running.batch_id]);

    const failed = await insertUncommittedBatch(db, { status: "failed" });
    const failedCut = await sealCurrent(db);
    assert.equal(failedCut.completeness, "degraded");
    assert.ok(failedCut.gaps.some((gap) => gap.batchId === failed.batch_id && gap.batchStatus === "failed"));
    await db.query(`
      update public.source_ingest_batches
      set status = 'superseded', finished_at = clock_timestamp()
      where batch_id = $1::uuid
    `, [failed.batch_id]);

    const replayComplete = await sealCurrent(db);
    assert.equal(replayComplete.completeness, "complete");
    assert.equal(replayComplete.sourceCutId, complete.sourceCutId);
    assert.equal(replayComplete.manifestHash, complete.manifestHash);

    const trackingFresh = new Date(Date.now() + 1000).toISOString();
    await seedCommittedSource(db, {
      sourceSystem: "tracking",
      connectionKey: "carrier-tracking-primary",
      version: 2,
      cursorValue: trackingFresh,
      sourceSnapshotAt: trackingFresh,
      withObservation: true,
    });
    const changed = await sealCurrent(db);
    assert.equal(changed.completeness, "complete");
    assert.notEqual(changed.sourceCutId, complete.sourceCutId);
    assert.notEqual(changed.manifestHash, complete.manifestHash);

    await expectSqlState(
      db.query(`
        insert into public.truth_required_sources (
          workspace_key, source_system, connection_key, cursor_kind,
          freshness_seconds, allow_empty_scope
        ) values ('ghost', 'gmail', 'ghost', 'gmail_history_id', 3600, false)
      `),
      "23503",
      "required-source registry enforces workspace foreign keys",
    );
    await db.query(`
      insert into public.truth_workspaces (workspace_key, status)
      values ('disabled-workspace', 'disabled')
    `);
    await expectSqlState(
      db.query(`
        select public.seal_current_source_cut(
          'disabled-workspace', 'verifier', $1
        )
      `, [TOKEN]),
      "23503",
      "disabled workspaces cannot seal cuts",
    );

    await db.exec("set role anon");
    try {
      await expectSqlState(
        db.query("select public.seal_current_source_cut('primary', 'anon', $1)", [TOKEN]),
        "42501",
        "anonymous callers cannot execute the source-cut coordinator",
      );
    } finally {
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    try {
      const serviceReceipt = (await one(db, `
        select public.seal_current_source_cut('primary', 'service-role-verifier', $1) as receipt
      `, [TOKEN])).receipt;
      assert.equal(serviceReceipt.sourceCutId, changed.sourceCutId);
      await expectSqlState(
        db.query(`
          insert into public.truth_required_sources (
            workspace_key, source_system, connection_key, cursor_kind
          ) values ('primary', 'gmail', 'forbidden', 'gmail_history_id')
        `),
        "42501",
        "service role cannot directly mutate required-source configuration",
      );
      await expectSqlState(
        db.query("delete from public.source_cuts where false"),
        "42501",
        "service role cannot directly mutate source cuts",
      );
      await expectSqlState(
        db.query("select private.seal_current_source_cut('primary', 'forbidden', $1)", [TOKEN]),
        "42501",
        "service role cannot execute the private coordinator implementation",
      );
    } finally {
      await db.exec("reset role");
    }

    const beforeReplay = await one(db, `
      select
        (select count(*)::integer from public.truth_required_sources where workspace_key = 'primary') as registry_count,
        (select count(*)::integer from public.source_ingest_batches where batch_id = '00000000-0000-4000-8000-000000000340') as genesis_batches,
        (select count(*)::integer from public.source_ingest_manifests where batch_id = '00000000-0000-4000-8000-000000000340') as genesis_manifests,
        (select count(*)::integer from public.source_cuts) as cut_count
    `);
    await db.exec(fs.readFileSync(COORDINATOR, "utf8"));
    const afterReplay = await one(db, `
      select
        (select count(*)::integer from public.truth_required_sources where workspace_key = 'primary') as registry_count,
        (select count(*)::integer from public.source_ingest_batches where batch_id = '00000000-0000-4000-8000-000000000340') as genesis_batches,
        (select count(*)::integer from public.source_ingest_manifests where batch_id = '00000000-0000-4000-8000-000000000340') as genesis_manifests,
        (select count(*)::integer from public.source_cuts) as cut_count
    `);
    assert.deepEqual(afterReplay, beforeReplay);
    const afterReplayReceipt = await sealCurrent(db);
    assert.equal(afterReplayReceipt.sourceCutId, changed.sourceCutId);

    const functionContract = await one(db, `
      select pronargs, proargnames, prosecdef
      from pg_proc
      where oid = 'public.seal_current_source_cut(text,text,text)'::regprocedure
    `);
    assert.equal(functionContract.pronargs, 3);
    assert.deepEqual(functionContract.proargnames, [
      "p_workspace_key", "p_created_by", "p_sync_token",
    ]);
    assert.equal(functionContract.prosecdef, true);

    await db.query(`
      update public.truth_required_sources
      set freshness_seconds = 999
      where workspace_key = 'primary' and source_system = 'gmail' and connection_key = 'primary'
    `);
    await expectSqlState(
      db.exec(fs.readFileSync(COORDINATOR, "utf8")),
      "23514",
      "migration replay rejects required-source configuration conflicts",
    );

    const source = fs.readFileSync(COORDINATOR, "utf8");
    assert.match(source, /for share of required_source/);
    assert.match(source, /for share of cursor_row/);
    assert.match(source, /'\[\]'::jsonb,\s*p_created_by/);
    assert.doesNotMatch(source, /p_(?:cursors|observations|gaps|required_sources)/);

    return {
      sourceCutId: changed.sourceCutId,
      initialNotReadyGapCount: missing.gaps.length,
      completeObservationCount: complete.observationCount,
      registryCount: beforeReplay.registry_count,
    };
  } finally {
    await db.close();
  }
}

async function verifyOperatorConflict() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await installBase(db, { includeCoordinator: false });
    await db.query(`
      insert into public.source_cursors (
        workspace_key, source_system, connection_key, cursor_kind,
        cursor_value, cursor_version, status
      ) values ('primary', 'operator', 'operator-phone-primary',
        'wrong_operator_kind', '0', 0, 'live')
    `);
    await expectSqlState(
      db.exec(fs.readFileSync(COORDINATOR, "utf8")),
      "23514",
      "migration rejects an incompatible pre-existing operator genesis cursor",
    );
  } finally {
    await db.close();
  }
}

async function main() {
  const coordinator = await verifyCoordinator();
  await verifyOperatorConflict();
  console.log(JSON.stringify({
    ok: true,
    verifier: "verify-truth-source-cut-coordinator",
    ...coordinator,
    checks: [
      "exact required-source registry vector is server-derived and locked",
      "missing and uninitialized required sources return not_ready without a cut",
      "operator genesis has a real committed empty-scope witness",
      "non-operator empty, stale, running, and current failed sources degrade",
      "Gmail, TMS, tracking, and operator genesis seal a complete compact cut",
      "cursor changes alter source-cut identity",
      "the coordinator accepts no caller cursor, gap, or observation vector",
      "workspace foreign keys and disabled workspace checks fail closed",
      "migration replay and sealing are idempotent",
      "registry and operator genesis conflicts are rejected",
      "service role can call only the public token-gated RPC and has no direct DML",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

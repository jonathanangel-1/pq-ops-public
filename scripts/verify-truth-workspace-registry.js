#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const FIRST_TRUTH_MIGRATION = 20260709200000;
const LAST_DEPENDENCY_MIGRATION = 20260709230000;
const REGISTRY_MIGRATION = path.join(
  MIGRATION_DIR,
  "20260709231000_truth_workspace_registry.sql",
);
const TRUTH_TABLE_PATTERN =
  "^(source_|gmail_|accepted_|observation_|operational_|truth_|candidate_)";

function migrationTimestamp(fileName) {
  const match = /^(\d{14})_.*\.sql$/.exec(fileName);
  return match ? Number(match[1]) : null;
}

function dependencyMigrations() {
  return fs
    .readdirSync(MIGRATION_DIR)
    .filter((fileName) => {
      const timestamp = migrationTimestamp(fileName);
      return (
        timestamp !== null &&
        timestamp >= FIRST_TRUTH_MIGRATION &&
        timestamp <= LAST_DEPENDENCY_MIGRATION
      );
    })
    .sort()
    .map((fileName) => path.join(MIGRATION_DIR, fileName));
}

async function expectSqlState(promise, expectedCode, message) {
  await assert.rejects(
    promise,
    (error) => {
      assert.equal(
        error?.code,
        expectedCode,
        `${message}: ${error?.message || error}`,
      );
      return true;
    },
    message,
  );
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
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
    create or replace function public.valid_sync_token(p_sync_token text)
    returns boolean
    language sql
    as $function$ select true $function$;
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
  return db;
}

async function applyDependencies(db) {
  const migrations = dependencyMigrations();
  assert.ok(migrations.length > 0, "truth dependency migrations must exist");
  for (const migration of migrations) {
    await db.exec(fs.readFileSync(migration, "utf8"));
  }
  return migrations;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  if (!value.startsWith("{") || !value.endsWith("}")) return [value];
  const body = value.slice(1, -1);
  return body ? body.split(",").map((item) => item.replace(/^"|"$/g, "")) : [];
}

async function tableColumns(db) {
  const result = await db.query(`
    select table_name, column_name, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name ~ $1
    order by table_name, ordinal_position
  `, [TRUTH_TABLE_PATTERN]);
  const columns = new Map();
  for (const row of result.rows) {
    if (!columns.has(row.table_name)) columns.set(row.table_name, new Map());
    columns.get(row.table_name).set(row.column_name, row.is_nullable);
  }
  return columns;
}

async function workspaceRelationships(db) {
  const result = await db.query(`
    select
      con.conname as constraint_name,
      child.relname as child_table,
      parent.relname as parent_table,
      con.condeferrable,
      con.condeferred,
      con.convalidated,
      con.confupdtype,
      con.confdeltype,
      array(
        select child_attribute.attname::text
        from unnest(con.conkey) with ordinality as key_position(attnum, ordinality)
        join pg_catalog.pg_attribute child_attribute
          on child_attribute.attrelid = con.conrelid
         and child_attribute.attnum = key_position.attnum
        order by key_position.ordinality
      ) as child_columns,
      array(
        select parent_attribute.attname::text
        from unnest(con.confkey) with ordinality as key_position(attnum, ordinality)
        join pg_catalog.pg_attribute parent_attribute
          on parent_attribute.attrelid = con.confrelid
         and parent_attribute.attnum = key_position.attnum
        order by key_position.ordinality
      ) as parent_columns
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class child on child.oid = con.conrelid
    join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_catalog.pg_class parent on parent.oid = con.confrelid
    join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    where con.contype = 'f'
      and child_ns.nspname = 'public'
      and parent_ns.nspname = 'public'
      and child.relname ~ $1
      and parent.relname ~ $1
      and exists (
        select 1 from pg_catalog.pg_attribute attribute
        where attribute.attrelid = child.oid
          and attribute.attname = 'workspace_key'
          and attribute.attnum > 0
          and not attribute.attisdropped
      )
      and exists (
        select 1 from pg_catalog.pg_attribute attribute
        where attribute.attrelid = parent.oid
          and attribute.attname = 'workspace_key'
          and attribute.attnum > 0
          and not attribute.attisdropped
      )
    order by child.relname, parent.relname, con.conname
  `, [TRUTH_TABLE_PATTERN]);
  return result.rows.map((row) => ({
    ...row,
    child_columns: normalizeArray(row.child_columns),
    parent_columns: normalizeArray(row.parent_columns),
  }));
}

async function discoverWorkspaceTables(db) {
  const result = await db.query(`
    select cls.relname as table_name, columns.is_nullable
    from pg_catalog.pg_class cls
    join pg_catalog.pg_namespace namespace on namespace.oid = cls.relnamespace
    join information_schema.columns columns
      on columns.table_schema = namespace.nspname
     and columns.table_name = cls.relname
     and columns.column_name = 'workspace_key'
    where namespace.nspname = 'public'
      and cls.relkind in ('r', 'p')
      and cls.relname <> 'truth_workspaces'
      and cls.relname ~ $1
    order by cls.relname
  `, [TRUTH_TABLE_PATTERN]);
  return result.rows;
}

async function verifyRegistryForeignKeys(db, workspaceTables) {
  const result = await db.query(`
    select
      child.relname as table_name,
      con.conname as constraint_name,
      con.condeferrable,
      con.condeferred,
      con.convalidated,
      con.confupdtype,
      con.confdeltype,
      array(
        select child_attribute.attname::text
        from unnest(con.conkey) with ordinality as key_position(attnum, ordinality)
        join pg_catalog.pg_attribute child_attribute
          on child_attribute.attrelid = con.conrelid
         and child_attribute.attnum = key_position.attnum
        order by key_position.ordinality
      ) as child_columns,
      array(
        select parent_attribute.attname::text
        from unnest(con.confkey) with ordinality as key_position(attnum, ordinality)
        join pg_catalog.pg_attribute parent_attribute
          on parent_attribute.attrelid = con.confrelid
         and parent_attribute.attnum = key_position.attnum
        order by key_position.ordinality
      ) as parent_columns
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class child on child.oid = con.conrelid
    join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_catalog.pg_class parent on parent.oid = con.confrelid
    join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    where con.contype = 'f'
      and child_ns.nspname = 'public'
      and parent_ns.nspname = 'public'
      and parent.relname = 'truth_workspaces'
    order by child.relname, con.conname
  `);

  const registryFks = result.rows.map((row) => ({
    ...row,
    child_columns: normalizeArray(row.child_columns),
    parent_columns: normalizeArray(row.parent_columns),
  }));
  assert.equal(
    registryFks.length,
    workspaceTables.length,
    "every workspace-bearing truth table must have exactly one registry FK",
  );

  for (const table of workspaceTables) {
    assert.equal(
      table.is_nullable,
      "NO",
      `${table.table_name}.workspace_key must be NOT NULL`,
    );
    const matches = registryFks.filter((fk) => fk.table_name === table.table_name);
    assert.equal(matches.length, 1, `${table.table_name} must have one registry FK`);
    const [fk] = matches;
    assert.deepEqual(fk.child_columns, ["workspace_key"]);
    assert.deepEqual(fk.parent_columns, ["workspace_key"]);
    assert.equal(fk.condeferrable, false, `${table.table_name} registry FK is immediate`);
    assert.equal(fk.condeferred, false, `${table.table_name} registry FK is not deferred`);
    assert.equal(fk.convalidated, true, `${table.table_name} registry FK is validated`);
    assert.equal(fk.confupdtype, "r", `${table.table_name} registry update is RESTRICT`);
    assert.equal(fk.confdeltype, "r", `${table.table_name} registry delete is RESTRICT`);
  }
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function verifyScopedRelationships(db, baselineRelationships, baselineColumns) {
  const after = await workspaceRelationships(db);
  let strengthened = 0;

  for (const baseline of baselineRelationships) {
    const childColumns = [...baseline.child_columns];
    const parentColumns = [...baseline.parent_columns];
    for (const scopeColumn of ["workspace_key", "source_system", "connection_key"]) {
      const shared =
        baselineColumns.get(baseline.child_table)?.has(scopeColumn) &&
        baselineColumns.get(baseline.parent_table)?.has(scopeColumn);
      if (shared && !childColumns.includes(scopeColumn)) {
        childColumns.push(scopeColumn);
        parentColumns.push(scopeColumn);
      }
    }

    const match = after.find(
      (candidate) =>
        candidate.child_table === baseline.child_table &&
        candidate.parent_table === baseline.parent_table &&
        arraysEqual(candidate.child_columns, childColumns) &&
        arraysEqual(candidate.parent_columns, parentColumns),
    );
    assert.ok(
      match,
      `${baseline.child_table}.${baseline.constraint_name} must be scoped by ${childColumns.join(",")}`,
    );
    assert.equal(match.convalidated, true, `${match.constraint_name} must be validated`);
    if (!arraysEqual(childColumns, baseline.child_columns)) {
      strengthened += 1;
      assert.equal(match.confupdtype, "r", `${match.constraint_name} update must RESTRICT`);
      assert.equal(match.confdeltype, "r", `${match.constraint_name} delete must RESTRICT`);
      assert.equal(
        match.condeferrable,
        baseline.condeferrable,
        `${match.constraint_name} must preserve deferrability`,
      );
      assert.equal(
        match.condeferred,
        baseline.condeferred,
        `${match.constraint_name} must preserve initial deferral`,
      );
    }
  }

  return strengthened;
}

async function verifySeedAndReapplication(db, registrySql) {
  const primary = await one(db, `
    select workspace_key, status, registry_version
    from public.truth_workspaces
    where workspace_key = 'primary'
  `);
  assert.deepEqual(primary, {
    workspace_key: "primary",
    status: "active",
    registry_version: "truth-workspace-registry-v1",
  });
  const count = await one(db, `select count(*)::integer as count from public.truth_workspaces`);
  assert.equal(count.count, 1, "migration must seed only the established primary workspace");

  await db.exec(registrySql);
  const reapplied = await one(db, `
    select count(*)::integer as count,
      min(status) as status,
      min(registry_version) as registry_version
    from public.truth_workspaces
    where workspace_key = 'primary'
  `);
  assert.deepEqual(reapplied, {
    count: 1,
    status: "active",
    registry_version: "truth-workspace-registry-v1",
  });
}

async function verifyOrphanAndScopeRejection(db) {
  await expectSqlState(
    db.query(`
      insert into public.source_cursors (
        workspace_key, source_system, connection_key, cursor_kind
      ) values ('unregistered-workspace', 'tms', 'orphan-test', 'snapshot_id')
    `),
    "23503",
    "unregistered workspace insert must fail",
  );

  await db.query(`
    insert into public.truth_workspaces (workspace_key, status, registry_version)
    values ('registry-verifier-secondary', 'active', 'truth-workspace-registry-v1')
  `);
  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status
    ) values
      ('primary', 'tms', 'scope-a', 'tms_snapshot_timestamp', '1', 1, 'live'),
      ('registry-verifier-secondary', 'tms', 'scope-a', 'tms_snapshot_timestamp', '1', 1, 'live')
  `);
  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      'primary', 'tms', 'scope-a', 'snapshot', 'workspace-registry-verifier',
      0, '', 1, '1', 'verifier', 1, 'committed', $1,
      0, 1, 0, now(), now()
    ) returning batch_id
  `, ["1".repeat(64)]);

  async function insertObservation({ observationId, workspaceKey, connectionKey }) {
    return db.query(`
      insert into public.source_observations (
        observation_id, workspace_key, source_system, connection_key,
        source_object_type, source_object_id, source_revision, operation,
        source_cursor_version, batch_id, content_hash, normalized_payload,
        normalized_text, source_fidelity, schema_version
      ) values (
        $1, $2, 'tms', $3, 'tms_shipment_snapshot', $4, '', 'content',
        1, $5, $6, '{}'::jsonb, '', 'normalized_source', 'registry-verifier-v1'
      )
    `, [
      observationId,
      workspaceKey,
      connectionKey,
      `fixture-${observationId.slice(-8)}`,
      batch.batch_id,
      observationId.slice(-64),
    ]);
  }

  await expectSqlState(
    insertObservation({
      observationId: `obs:v1:${"2".repeat(64)}`,
      workspaceKey: "registry-verifier-secondary",
      connectionKey: "scope-a",
    }),
    "23503",
    "registered workspace cannot reference another workspace's ingest batch",
  );
  await expectSqlState(
    insertObservation({
      observationId: `obs:v1:${"3".repeat(64)}`,
      workspaceKey: "primary",
      connectionKey: "scope-b",
    }),
    "23503",
    "source observation cannot cross its ingest batch connection",
  );
  await insertObservation({
    observationId: `obs:v1:${"4".repeat(64)}`,
    workspaceKey: "primary",
    connectionKey: "scope-a",
  });

  await expectSqlState(
    db.query(`update public.truth_workspaces set workspace_key = 'primary-renamed' where workspace_key = 'primary'`),
    "23001",
    "referenced workspace key update must be restricted",
  );
  await expectSqlState(
    db.query(`delete from public.truth_workspaces where workspace_key = 'primary'`),
    "23001",
    "referenced workspace deletion must be restricted",
  );
}

async function verifyDmlRevocation(db, workspaceTables) {
  const protectedTables = ["truth_workspaces", ...workspaceTables.map((row) => row.table_name)];
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const table of protectedTables) {
      const privileges = await one(db, `
        select
          has_table_privilege($1::name, format('public.%I', $2::text), 'INSERT') as can_insert,
          has_table_privilege($1::name, format('public.%I', $2::text), 'UPDATE') as can_update,
          has_table_privilege($1::name, format('public.%I', $2::text), 'DELETE') as can_delete,
          has_table_privilege($1::name, format('public.%I', $2::text), 'TRUNCATE') as can_truncate
      `, [role, table]);
      assert.deepEqual(
        privileges,
        { can_insert: false, can_update: false, can_delete: false, can_truncate: false },
        `${role} must not have direct DML on public.${table}`,
      );
    }
  }

  await db.exec("set role service_role");
  try {
    await expectSqlState(
      db.query(`
        insert into public.truth_workspaces (workspace_key)
        values ('service-role-bypass')
      `),
      "42501",
      "service role cannot self-register a workspace",
    );
    await expectSqlState(
      db.query(`
        insert into public.source_cursors (
          workspace_key, source_system, connection_key, cursor_kind
        ) values ('primary', 'tms', 'service-role-bypass', 'snapshot_id')
      `),
      "42501",
      "service role cannot bypass workspace isolation with direct truth DML",
    );
  } finally {
    await db.exec("reset role");
  }
}

async function verifyFailClosedMigration(registrySql) {
  const db = await createDatabase();
  try {
    await applyDependencies(db);
    await db.query(`
      insert into public.source_cursors (
        workspace_key, source_system, connection_key, cursor_kind
      ) values ('preexisting-orphan', 'tms', 'fail-closed', 'snapshot_id')
    `);
    await expectSqlState(
      db.exec(registrySql),
      "23503",
      "registry migration must fail rather than auto-register an orphan workspace",
    );
    const registryExists = await one(db, `
      select to_regclass('public.truth_workspaces') is not null as exists
    `);
    if (registryExists.exists) {
      const invented = await one(db, `
        select count(*)::integer as count
        from public.truth_workspaces
        where workspace_key = 'preexisting-orphan'
      `);
      assert.equal(invented.count, 0, "migration must never invent an orphan tenant");
    }
  } finally {
    await db.close();
  }
}

async function main() {
  const registrySql = fs.readFileSync(REGISTRY_MIGRATION, "utf8");
  const db = await createDatabase();
  try {
    const migrations = await applyDependencies(db);
    const baselineColumns = await tableColumns(db);
    const baselineRelationships = await workspaceRelationships(db);

    await db.exec(registrySql);
    const workspaceTables = await discoverWorkspaceTables(db);
    assert.ok(workspaceTables.length > 0, "workspace-bearing truth tables must be discovered");

    await verifyRegistryForeignKeys(db, workspaceTables);
    const strengthenedRelationships = await verifyScopedRelationships(
      db,
      baselineRelationships,
      baselineColumns,
    );
    await verifySeedAndReapplication(db, registrySql);
    await verifyDmlRevocation(db, workspaceTables);
    await verifyOrphanAndScopeRejection(db);
    await verifyFailClosedMigration(registrySql);

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        migrationCount: migrations.length + 1,
        workspaceTableCount: workspaceTables.length,
        workspaceTables: workspaceTables.map((row) => row.table_name),
        strengthenedRelationshipCount: strengthenedRelationships,
        seededWorkspaces: ["primary"],
        migrationReapplication: "passed",
        orphanBehavior: "fail_closed",
        serviceRoleDirectDml: "revoked",
      }, null, 2)}\n`,
    );
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});

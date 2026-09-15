#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATION_RELATIVE_PATH = "supabase/migrations/20260702074026_snapshot_metadata_sidecar.sql";
const MIGRATION_PATH = path.join(ROOT_DIR, MIGRATION_RELATIVE_PATH);
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "supabase-sidecar-application");
const ARTIFACT_PATH = path.join(ARTIFACT_DIR, "latest.json");

const CATALOG_CTES_SQL = `catalog as (
  select
    to_regprocedure('public.read_app_snapshots(text[], text)') is not null as has_read_app_snapshots_rpc,
    to_regprocedure('public.read_app_snapshot_metadata(text[], text)') is not null as has_read_app_snapshot_metadata_rpc,
    to_regprocedure('public.list_agent_job_summaries(integer, text)') is not null as has_list_agent_job_summaries_rpc,
    to_regprocedure('public.recent_agent_jobs(text, integer, text)') is not null as has_recent_agent_jobs_rpc,
    to_regclass('public.app_snapshot_metadata') is not null as has_app_snapshot_metadata_sidecar,
    has_table_privilege('anon', 'public.app_snapshots', 'select') as anon_can_select_app_snapshots,
    has_table_privilege('anon', 'public.agent_jobs', 'select') as anon_can_select_agent_jobs,
    has_table_privilege('anon', 'public.agent_jobs', 'insert') as anon_can_insert_agent_jobs,
    has_table_privilege('authenticated', 'public.app_snapshots', 'select') as authenticated_can_select_app_snapshots,
    has_table_privilege('authenticated', 'public.agent_jobs', 'select') as authenticated_can_select_agent_jobs,
    has_table_privilege('authenticated', 'public.agent_jobs', 'insert') as authenticated_can_insert_agent_jobs
),
sidecar_privileges as (
  select
    case
      when to_regclass('public.app_snapshot_metadata') is null then false
      else has_table_privilege('anon', 'public.app_snapshot_metadata', 'select')
    end as anon_can_select_app_snapshot_metadata,
    case
      when to_regclass('public.app_snapshot_metadata') is null then false
      else has_table_privilege('authenticated', 'public.app_snapshot_metadata', 'select')
    end as authenticated_can_select_app_snapshot_metadata
)`;

const CATALOG_SQL = `with ${CATALOG_CTES_SQL}
select
  now() as checked_at,
  catalog.*,
  sidecar_privileges.*
from catalog, sidecar_privileges;`;

const POST_APPLY_SQL = `with ${CATALOG_CTES_SQL},
function_defs as (
  select
    pg_get_functiondef('public.read_app_snapshot_metadata(text[], text)'::regprocedure) as metadata_function_def,
    pg_get_functiondef('public.upsert_app_snapshot(text, jsonb, text)'::regprocedure) as upsert_function_def
)
select
  now() as checked_at,
  catalog.*,
  sidecar_privileges.*,
  position('public.app_snapshot_metadata' in function_defs.metadata_function_def) > 0 as metadata_rpc_reads_sidecar,
  position('public.app_snapshots' in function_defs.metadata_function_def) = 0 as metadata_rpc_avoids_snapshot_payload_table,
  position('with upserted as' in lower(function_defs.upsert_function_def)) > 0 as upsert_uses_changed_rows_cte,
  (
    catalog.has_read_app_snapshots_rpc
    and catalog.has_read_app_snapshot_metadata_rpc
    and catalog.has_list_agent_job_summaries_rpc
    and catalog.has_recent_agent_jobs_rpc
    and catalog.has_app_snapshot_metadata_sidecar
    and not catalog.anon_can_select_app_snapshots
    and not sidecar_privileges.anon_can_select_app_snapshot_metadata
    and not catalog.anon_can_select_agent_jobs
    and not catalog.anon_can_insert_agent_jobs
    and not catalog.authenticated_can_select_app_snapshots
    and not sidecar_privileges.authenticated_can_select_app_snapshot_metadata
    and not catalog.authenticated_can_select_agent_jobs
    and not catalog.authenticated_can_insert_agent_jobs
  ) as hosted_sidecar_boundary_ready
from catalog, sidecar_privileges, function_defs;`;

const RPC_SMOKE_SQL = `select *
from public.read_app_snapshot_metadata(
  array['shipment-truth-packets', 'active-awb-index', 'gmail-direct-state', 'gmail-refresh-health'],
  '<PQ_SUPABASE_SYNC_TOKEN>'
)
order by snapshot_key;`;

async function main() {
  const migrationSql = await fs.readFile(MIGRATION_PATH, "utf8");
  const artifact = {
    ok: true,
    mutatesState: false,
    generatedAt: new Date().toISOString(),
    source: "supabase-sidecar-application-plan-v1",
    projectRef: "hchfhyogwdihgcebvmhv",
    migration: {
      path: MIGRATION_RELATIVE_PATH,
      sha256: crypto.createHash("sha256").update(migrationSql).digest("hex"),
      bytes: Buffer.byteLength(migrationSql),
      lines: migrationSql.split(/\r?\n/).length,
    },
    liveMutationApprovalRequired: true,
    sequence: [
      "Run preApplyCatalogSql read-only and save the result.",
      "Apply the migration SQL only after explicit approval for hosted Supabase mutation.",
      "Run postApplyCatalogSql read-only; hosted_sidecar_boundary_ready must be true.",
      "Run rpcSmokeSql with the real sync token; it must return metadata rows without payload JSON.",
      "Run npm run verify:supabase-lockdown -- --strict --base-url=https://pq-ops-demo.example --timeout-ms=15000.",
      "Run the hosted Gmail refresh path, then npm run verify:production-truth-readiness.",
    ],
    preApplyCatalogSql: CATALOG_SQL,
    postApplyCatalogSql: POST_APPLY_SQL,
    rpcSmokeSql: RPC_SMOKE_SQL,
  };
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  await fs.writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify(artifact, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

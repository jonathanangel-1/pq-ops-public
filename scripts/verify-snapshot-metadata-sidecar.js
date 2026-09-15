#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT_DIR, "supabase", "migrations", "20260702074026_snapshot_metadata_sidecar.sql");
const PLAN_HELPER_PATH = path.join(ROOT_DIR, "scripts", "prepare-supabase-sidecar-application.js");

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail("Required migration file is missing", {
      file: filePath,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `Missing migration marker: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert(end > start, `Missing migration marker: ${endMarker}`);
  return source.slice(start, end);
}

function main() {
  const source = readFile(MIGRATION_PATH);
  const planHelperSource = readFile(PLAN_HELPER_PATH);
  const upsertFunction = between(
    source,
    "create or replace function public.upsert_app_snapshot",
    "create or replace function public.read_app_snapshot_metadata",
  );
  const metadataFunction = between(
    source,
    "create or replace function public.read_app_snapshot_metadata",
    "alter table public.app_snapshot_metadata enable row level security",
  );

  assert(
    source.includes("create table if not exists public.app_snapshot_metadata"),
    "Migration must create the sidecar metadata table",
  );
  assert(source.includes("snapshot_key text primary key"), "Sidecar table must be keyed by snapshot_key");
  assert(source.includes("payload_bytes integer"), "Sidecar table must record payload size for IO diagnosis");
  assert(
    source.includes("insert into public.app_snapshot_metadata") &&
      source.includes("from public.app_snapshots as s"),
    "Migration must backfill sidecar metadata from the existing snapshot table once",
  );

  assert(
    upsertFunction.includes("with upserted as (") &&
      upsertFunction.includes("returning snapshot_key, updated_at") &&
      upsertFunction.includes("from upserted"),
    "upsert_app_snapshot must update sidecar metadata only from rows actually inserted or updated",
  );
  assert(
    upsertFunction.includes("public.app_snapshot_metadata.updated_at is distinct from excluded.updated_at"),
    "upsert_app_snapshot sidecar metadata must refresh updated_at whenever the underlying snapshot row changes",
  );
  assert(
    /insert\s+into\s+public\.app_snapshot_metadata[\s\S]+select[\s\S]+from\s+upserted/i.test(upsertFunction),
    "upsert_app_snapshot sidecar write must be SELECT ... FROM upserted, not an unconditional VALUES write",
  );
  assert(
    !/insert\s+into\s+public\.app_snapshot_metadata[\s\S]+values\s*\(/i.test(upsertFunction),
    "upsert_app_snapshot must not refresh metadata on no-op snapshot writes",
  );

  assert(
    metadataFunction.includes("from public.app_snapshot_metadata as m"),
    "read_app_snapshot_metadata must read from the sidecar table",
  );
  assert(
    !metadataFunction.includes("public.app_snapshots") && !/\bpayload\b/i.test(metadataFunction),
    "read_app_snapshot_metadata must not touch app_snapshots payload JSON",
  );
  assert(
    metadataFunction.includes("p_sync_token") &&
      metadataFunction.includes("public.valid_sync_token(p_sync_token)") &&
      metadataFunction.includes("allowed_snapshot_keys"),
    "read_app_snapshot_metadata must stay sync-token gated and allowlisted",
  );

  assert(
    source.includes("alter table public.app_snapshot_metadata enable row level security") &&
      source.includes("revoke all on table public.app_snapshot_metadata from anon, authenticated") &&
      source.includes("revoke all on table public.app_snapshot_metadata from public") &&
      source.includes("revoke all on function public.read_app_snapshot_metadata(text[], text) from public") &&
      source.includes("revoke all on function public.upsert_app_snapshot(text, jsonb, text) from public") &&
      source.includes("grant execute on function public.read_app_snapshot_metadata(text[], text) to anon, authenticated") &&
      source.includes("grant execute on function public.upsert_app_snapshot(text, jsonb, text) to anon, authenticated"),
    "Sidecar table must be RLS-locked and available only through sync-token RPC functions",
  );

  assert(
    planHelperSource.includes("mutatesState: false") &&
      planHelperSource.includes("liveMutationApprovalRequired: true") &&
      planHelperSource.includes("preApplyCatalogSql") &&
      planHelperSource.includes("postApplyCatalogSql") &&
      planHelperSource.includes("rpcSmokeSql"),
    "Sidecar application plan must stay read-only and explicitly approval-gated",
  );

  console.log(JSON.stringify({
    ok: true,
    migration: path.relative(ROOT_DIR, MIGRATION_PATH),
    planHelper: path.relative(ROOT_DIR, PLAN_HELPER_PATH),
    checks: [
      "sidecar-table",
      "one-time-backfill",
      "no-op-write-preservation",
      "metadata-rpc-uses-sidecar",
      "metadata-rpc-avoids-payload-json",
      "browser-table-lockdown",
      "approval-gated-application-plan",
    ],
  }, null, 2));
}

main();

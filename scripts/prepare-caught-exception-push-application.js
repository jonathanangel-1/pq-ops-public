#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const PROJECT_REF = "hchfhyogwdihgcebvmhv";
const MIGRATION_NAME = "caught_exception_push_delivery";
const MIGRATION_RELATIVE_PATH = "supabase/migrations/20260715162452_caught_exception_push_delivery.sql";
const MIGRATION_PATH = path.join(ROOT_DIR, MIGRATION_RELATIVE_PATH);
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "caught-exception-push-application");
const ARTIFACT_PATH = path.join(ARTIFACT_DIR, "latest.json");

const APPLY_COMMAND = `jq -n --rawfile query ${MIGRATION_RELATIVE_PATH} \
  '{name:"${MIGRATION_NAME}",query:$query}' | \
  curl --fail-with-body --request POST \
    --header "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    --header "Content-Type: application/json" \
    --data-binary @- \
    "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/migrations"`;

const PRE_APPLY_SQL = `select
  now() as checked_at,
  public.operator_event_is_pushable('caught-customs-contested', 'immediate') as caught_customs_contested_pushable,
  to_regprocedure('public.revoke_operator_push_subscription(uuid,uuid,text,text)') is not null as revoke_rpc_already_present;`;

const POST_APPLY_SQL = `select
  now() as checked_at,
  public.operator_event_is_pushable('caught-customs-contested', 'immediate') as caught_customs_contested_pushable,
  public.operator_event_is_pushable('caught-arrival-unverified', 'immediate') as caught_arrival_unverified_pushable,
  public.operator_event_is_pushable('caught-arrival-source-conflict', 'immediate') as caught_arrival_source_conflict_pushable,
  public.operator_event_is_pushable('caught-dispatch-customs-unknown', 'immediate') as caught_dispatch_customs_unknown_pushable,
  to_regprocedure('public.revoke_operator_push_subscription(uuid,uuid,text,text)') is not null as revoke_rpc_present,
  not has_function_privilege('public', 'public.revoke_operator_push_subscription(uuid,uuid,text,text)', 'execute') as revoke_rpc_not_public;`;

async function main() {
  const migrationSql = await fs.readFile(MIGRATION_PATH, "utf8");
  const artifact = {
    ok: true,
    mutatesState: false,
    generatedAt: new Date().toISOString(),
    source: "caught-exception-push-application-plan-v1",
    projectRef: PROJECT_REF,
    migration: {
      name: MIGRATION_NAME,
      path: MIGRATION_RELATIVE_PATH,
      sha256: crypto.createHash("sha256").update(migrationSql).digest("hex"),
      bytes: Buffer.byteLength(migrationSql),
      lines: migrationSql.split(/\r?\n/).length,
    },
    liveMutationApprovalRequired: true,
    applyCommand: APPLY_COMMAND,
    sequence: [
      "Run preApplySql read-only and retain the result.",
      "Review the migration path and SHA-256 receipt.",
      "Only after explicit hosted-mutation approval, run applyCommand exactly once with a fine-grained SUPABASE_ACCESS_TOKEN that has database_migrations_write.",
      "Retain the migration API receipt and stop on any non-2xx response.",
      "Run postApplySql read-only; all six booleans must be true.",
      "Run npm run verify:operator-events, then verify one real active caught condition end to end.",
    ],
    preApplySql: PRE_APPLY_SQL,
    postApplySql: POST_APPLY_SQL,
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

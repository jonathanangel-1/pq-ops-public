#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const STACK_SOURCE = fs.readFileSync(
  path.join(__dirname, "verify-truth-full-migration-stack.js"),
  "utf8",
);
const ALL_MIGRATIONS = [...STACK_SOURCE.matchAll(/^\s*"(\d+_[^"]+\.sql)",$/gm)]
  .map((match) => match[1]);
const MIGRATION = "20260717130000_truth_gmail_resumed_model_child_admission.sql";
const MIGRATION_INDEX = ALL_MIGRATIONS.indexOf(MIGRATION);
const WORKSPACE = "primary";
const CONNECTION = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";
const SYNC = "truth-resumed-child-admission-sync-token-v1";
const WORKER = "truth-resumed-child-admission-worker";
const PROCESSOR = "truth-resumed-child-admission-processor-v1";

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `expected one row, received ${result.rows.length}`);
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
  assert.ok(MIGRATION_INDEX > 0);
  for (const name of ALL_MIGRATIONS.slice(0, MIGRATION_INDEX)) {
    await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.query(`insert into public.sync_tokens(token_name,token_hash) values
    ('local_snapshot_writer',encode(extensions.digest(convert_to(
      $1::text,'UTF8'
    ),'sha256'),'hex'))`, [SYNC]);
  return db;
}

async function seedExactChildren(db) {
  await db.query(`insert into public.source_cursors(
    workspace_key,source_system,connection_key,cursor_kind,cursor_value,
    cursor_version,status,last_committed_at
  ) values($1,'gmail',$2,'gmail_history_id','19563092',1,'live',clock_timestamp())`,
  [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_ingest_batches(
    batch_id,workspace_key,source_system,connection_key,mode,trigger_name,
    expected_cursor_version,expected_cursor_value,committed_cursor_version,
    committed_cursor_value,lease_owner,lease_fence,status,batch_hash,
    observation_count,job_count,committed_at,finished_at
  ) values($1::uuid,$2,'gmail',$3,'backfill','resumed-child-fixture',
    0,'',1,'19563092','resumed-child-fixture',1,'committed',
    encode(extensions.digest(convert_to('resumed-child-batch','UTF8'),'sha256'),'hex'),
    11,22,clock_timestamp(),clock_timestamp())`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
  await db.query(`with rows as (
    select i,
      'obs:v1:'||encode(extensions.digest(convert_to(
        'resumed-child-observation-'||i,'UTF8'
      ),'sha256'),'hex') observation_id,
      jsonb_build_object(
        'schemaVersion','gmail-parsed-message-v2',
        'gmail',jsonb_build_object(
          'messageId','resumed-child-message-'||i,
          'threadId','resumed-child-thread-'||i
        ),
        'subject','Ambiguous model evidence '||i,
        'text','Customs and delivery evidence requiring exact model extraction.',
        'sourceChronology',jsonb_build_object(
          'sourceRecordedAt','2026-07-10T15:00:00.000Z'
        )
      ) payload
    from generate_series(1,11) i
  ) insert into public.source_observations(
    observation_id,workspace_key,source_system,connection_key,
    source_object_type,source_object_id,source_revision,operation,
    source_cursor_version,batch_id,content_hash,source_recorded_at,captured_at,
    normalized_payload,normalized_text,source_fidelity,schema_version
  ) select observation_id,$2,'gmail',$3,'gmail_message_parsed',
    'resumed-child-message-'||i,'19563092','content',1,$1::uuid,
    encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(payload),'UTF8'
    ),'sha256'),'hex'),'2026-07-10T15:00:00Z','2026-07-10T15:00:00Z',
    payload,payload->>'text','normalized_source','gmail-parsed-message-v2'
  from rows`, [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with rows as (
    select i,
      ('60000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid parent_job_id,
      'obs:v1:'||encode(extensions.digest(convert_to(
        'resumed-child-observation-'||i,'UTF8'
      ),'sha256'),'hex') observation_id
    from generate_series(1,11) i
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,attempt_count,max_attempts,
    available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
    safe_error_detail,processor_version,payload,result,completed_at
  ) select parent_job_id,'resumed-parent:'||i,$1,'gmail',$2,
    'gmail_extract_message_claims',observation_id,
    'resumed-child-message-'||i,'succeeded',6,8,clock_timestamp(),
    null,6,null,'','','truth-gmail-parent-planning-worker-v1',
    '{}'::jsonb,'{}'::jsonb,clock_timestamp()
  from rows`, [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select job.job_id,job.workspace_key,'gmail',job.connection_key,
    $1::uuid,null,job.job_id,1,'19563092'
  from public.source_processing_jobs job
  where job.workspace_key=$2 and job.connection_key=$3
    and job.job_kind='gmail_extract_message_claims'`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with parent_rows as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.job_id parent_job_id,parent.observation_id,
      observation.content_hash,observation.journal_seq,
      jsonb_build_object(
        'schemaVersion','gmail-model-extraction-context-seal-v1',
        'workspaceKey',parent.workspace_key,
        'parentJobId',parent.job_id,
        'sourceObservationId',parent.observation_id,
        'sourceObservationContentHash',observation.content_hash,
        'journalSequenceInclusive',observation.journal_seq
      ) canonical
    from public.source_processing_jobs parent
    join public.source_observations observation
      on observation.workspace_key=parent.workspace_key
     and observation.observation_id=parent.observation_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ), hashed as (
    select parent_rows.*,encode(extensions.digest(convert_to(
      canonical::text,'UTF8'
    ),'sha256'),'hex') seal_hash from parent_rows
  ) insert into public.gmail_model_extraction_context_seals(
    context_seal_id,workspace_key,parent_job_id,source_observation_id,
    source_observation_content_hash,journal_sequence_inclusive,
    claim_context_hash,accepted_claims_context_hash,workgroup_context_hash,
    accepted_claim_membership_hash,workgroup_membership_hash,
    context_observation_membership_hash,accepted_claim_count,
    workgroup_membership_count,context_observation_count,workgroup_context,
    canonical_seal,seal_hash,schema_version
  ) select 'gmail-model-context:v1:'||seal_hash,$1,parent_job_id,
    observation_id,content_hash,journal_seq,repeat('1',64),repeat('2',64),
    repeat('3',64),repeat('4',64),repeat('5',64),repeat('6',64),
    0,0,1,'null'::jsonb,canonical,seal_hash,
    'gmail-model-extraction-context-seal-v1' from hashed`,
  [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.gmail_model_context_observations(
    workspace_key,context_seal_id,ordinal,observation_id,
    observation_content_hash
  ) select seal.workspace_key,seal.context_seal_id,0,
    seal.source_observation_id,seal.source_observation_content_hash
  from public.gmail_model_extraction_context_seals seal
  where seal.workspace_key=$1`, [WORKSPACE]);

  await db.query(`with parent_rows as (
    select parent.job_id,parent.observation_id,
      jsonb_build_object(
        'manifestSchemaVersion','candidate-claim-job-manifest-v1',
        'workspaceKey',parent.workspace_key,'jobId',parent.job_id,
        'sourceObservationId',parent.observation_id,
        'candidateCount',0,'candidates',jsonb_build_array()
      ) canonical
    from public.source_processing_jobs parent
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ), hashed as (
    select parent_rows.*,encode(extensions.digest(convert_to(
      canonical::text,'UTF8'
    ),'sha256'),'hex') manifest_hash from parent_rows
  ) insert into public.candidate_claim_job_manifests(
    job_id,workspace_key,source_observation_id,candidate_count,
    manifest_hash,manifest_schema_version,canonical_manifest
  ) select job_id,$1,observation_id,0,manifest_hash,
    'candidate-claim-job-manifest-v1',canonical from hashed`,
  [WORKSPACE, CONNECTION]);

  await db.query(`with base as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.job_id,parent.observation_id,observation.content_hash,
      context.context_seal_id,manifest.manifest_hash,
      jsonb_build_object(
        'schemaVersion','gmail-model-plan-v1',
        'sourceObservationId',parent.observation_id,
        'sourceObservationContentHash',observation.content_hash,
        'sourceRecordedAt','2026-07-10T15:00:00.000000Z',
        'modelInput',jsonb_build_object('text','Ambiguous model evidence '||
          row_number() over(order by parent.job_id)),
        'config',jsonb_build_object(
          'dateOrder','MDY','maxModelConfidence',0.9
        )
      ) model_core
    from public.source_processing_jobs parent
    join public.source_observations observation
      on observation.workspace_key=parent.workspace_key
     and observation.observation_id=parent.observation_id
    join public.gmail_model_extraction_context_seals context
      on context.workspace_key=parent.workspace_key
     and context.parent_job_id=parent.job_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=parent.workspace_key
     and manifest.job_id=parent.job_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ), model_hashed as (
    select base.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(model_core),'UTF8'
    ),'sha256'),'hex') model_hash from base
  ), model_bound as (
    select model_hashed.*,
      model_core || jsonb_build_object(
        'modelPlanId','gmail-model-plan:v1:'||model_hash,
        'modelPlanHash',model_hash
      ) model_plan,
      jsonb_build_object('input','fixture-model-input-'||i) request_payload
    from model_hashed
  ), sealed as (
    select model_bound.*,
      encode(extensions.digest(convert_to(
        'resumed-extraction-plan-'||i,'UTF8'
      ),'sha256'),'hex') extraction_hash,
      jsonb_build_object(
        'schemaVersion','gmail-model-extraction-plan-seal-v1',
        'workspaceKey',$1::text,'parentJobId',job_id,
        'sourceObservationId',observation_id,
        'sourceObservationContentHash',content_hash,
        'deterministicManifestHash',manifest_hash,
        'deterministicCandidateCount',0,
        'contextSealId',context_seal_id,
        'modelPlanId','gmail-model-plan:v1:'||model_hash,
        'modelPlanHash',model_hash,'executionMode','sync',
        'planningStatus','complete','planningFailureCode',''
      ) plan_seal
    from model_bound
  ), plan_hashed as (
    select sealed.*,encode(extensions.digest(convert_to(
      plan_seal::text,'UTF8'
    ),'sha256'),'hex') plan_seal_hash,
      private.truth_canonical_json_text(request_payload) request_text
    from sealed
  ) insert into public.gmail_model_extraction_plans(
    extraction_plan_id,extraction_plan_hash,workspace_key,parent_job_id,
    source_observation_id,source_observation_content_hash,
    deterministic_manifest_hash,deterministic_candidate_count,
    planned_deterministic_candidate_count,
    planned_deterministic_candidate_set_hash,context_seal_id,
    model_plan_id,model_plan_hash,model_plan,expected_request_payload,
    expected_request_payload_text,expected_request_payload_hash,
    expected_request_payload_bytes,expected_model_snapshot,
    expected_max_output_tokens,expected_response_schema_hash,
    wire_contract_version,extractor_version,prompt_version,
    response_schema_version,planning_status,planning_failure_code,
    planning_failure_detail_hash,execution_mode,root_ingest_mode,
    canonical_plan_seal,plan_seal_hash,schema_version
  ) select 'gmail-extraction-plan:v1:'||extraction_hash,extraction_hash,$1,
    job_id,observation_id,content_hash,manifest_hash,0,0,
    encode(extensions.digest(convert_to('[]','UTF8'),'sha256'),'hex'),
    context_seal_id,'gmail-model-plan:v1:'||model_hash,model_hash,
    model_plan,request_payload,request_text,
    encode(extensions.digest(convert_to(request_text,'UTF8'),'sha256'),'hex'),
    octet_length(convert_to(request_text,'UTF8')),'gpt-5-nano-2025-08-07',
    256,repeat('7',64),'truth-model-wire-v1','gmail-claim-extractor-v4',
    'gmail-model-prompt-v1','gmail-model-response-v1','complete','','',
    'sync','backfill',plan_seal,plan_seal_hash,
    'gmail-model-extraction-plan-seal-v1' from plan_hashed`,
  [WORKSPACE, CONNECTION]);

  await db.query(`update public.source_processing_jobs parent
  set result=jsonb_build_object(
    'truthPlan',jsonb_build_object(
      'extractionPlanId',plan.extraction_plan_id,
      'planSealHash',plan.plan_seal_hash,
      'deterministicManifestHash',plan.deterministic_manifest_hash,
      'modelPlanId',plan.model_plan_id,
      'planningStatus','complete','planningFailureCode',''
    )
  )
  from public.gmail_model_extraction_plans plan
  where parent.workspace_key=plan.workspace_key
    and parent.job_id=plan.parent_job_id
    and parent.workspace_key=$1`, [WORKSPACE]);

  await db.query(`with candidates as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.*,lineage.parent_job_id lineage_parent_job_id,
      lineage.root_job_id,lineage.source_cursor_version,
      lineage.source_cursor_value,observation.content_hash,
      '2026-07-10T14:00:00Z'::timestamptz prior_completed_at,
      jsonb_build_object(
        'schemaVersion','truth-shadow-gmail-model-residual-retry-authorization-v2',
        'workspaceKey',parent.workspace_key,
        'connectionKey',parent.connection_key,
        'rootBatchId',lineage.root_batch_id,
        'claimJobId',parent.job_id,
        'claimJobDedupeKey',parent.dedupe_key,
        'sourceObservationId',parent.observation_id,
        'sourceObjectId',parent.source_object_id,
        'sourceObservationContentHash',observation.content_hash,
        'priorPayloadHash',encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(parent.payload),'UTF8'
        ),'sha256'),'hex'),
        'lineageParentJobId',coalesce(lineage.parent_job_id::text,''),
        'lineageRootJobId',lineage.root_job_id,
        'sourceCursorVersion',lineage.source_cursor_version,
        'sourceCursorValueHash',encode(extensions.digest(convert_to(
          lineage.source_cursor_value,'UTF8'
        ),'sha256'),'hex'),
        'priorState','dead_letter','priorAttemptCount',5,
        'priorMaxAttempts',5,'priorLeaseFence',5,
        'priorCompletedAt',to_char(
          '2026-07-10T14:00:00Z'::timestamptz at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'priorResultHash',encode(extensions.digest(convert_to(
          private.truth_canonical_json_text('{}'::jsonb),'UTF8'
        ),'sha256'),'hex'),
        'priorErrorCode','TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
        'priorErrorDetailHash',encode(extensions.digest(convert_to(
          'fixture-prior-error-'||row_number() over(order by parent.job_id),
          'UTF8'
        ),'sha256'),'hex'),
        'failureClass','immutable_source_binding',
        'artifactMode','sealed_resume_or_reconcile',
        'authorizedMaxAttempts',8,
        'reasonCode','RESIDUAL_IMMUTABLE_PLAN_BINDING_RETRY',
        'shadowOnly',true,'mutatesOperationalState',false,
        'productionEligible',false,'productionPublicationAttempted',false
      ) canonical
    from public.source_processing_jobs parent
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent.workspace_key
     and lineage.job_id=parent.job_id
    join public.source_observations observation
      on observation.workspace_key=parent.workspace_key
     and observation.observation_id=parent.observation_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
    order by parent.job_id
    limit 10
  ), hashed as (
    select candidates.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical),'UTF8'
    ),'sha256'),'hex') auth_hash from candidates
  ) insert into public.truth_shadow_gmail_model_residual_retry_authorizations(
    authorization_id,authorization_hash,workspace_key,connection_key,
    root_batch_id,claim_job_id,claim_job_dedupe_key,source_observation_id,
    source_object_id,source_observation_content_hash,prior_payload_hash,
    lineage_parent_job_id,lineage_root_job_id,source_cursor_version,
    source_cursor_value_hash,prior_state,prior_attempt_count,
    prior_max_attempts,prior_lease_fence,prior_completed_at,
    prior_result_hash,prior_error_code,prior_error_detail_hash,
    failure_class,artifact_mode,authorized_max_attempts,
    canonical_authorization,schema_version
  ) select 'truth-shadow-gmail-model-residual-retry:v2:'||auth_hash,
    auth_hash,workspace_key,connection_key,$3::uuid,job_id,dedupe_key,
    observation_id,source_object_id,content_hash,
    canonical->>'priorPayloadHash',lineage_parent_job_id,root_job_id,
    source_cursor_version,canonical->>'sourceCursorValueHash','dead_letter',
    5,5,5,prior_completed_at,canonical->>'priorResultHash',
    'TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',canonical->>'priorErrorDetailHash',
    'immutable_source_binding','sealed_resume_or_reconcile',8,canonical,
    'truth-shadow-gmail-model-residual-retry-authorization-v2' from hashed`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);

  await db.query(`with parent_rows as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.job_id parent_job_id,parent.observation_id,
      parent.source_object_id,plan.model_plan_id,plan.model_plan_hash,
      plan.context_seal_id,lineage.root_job_id,
      ('70000000-0000-4000-8000-'||lpad(
        row_number() over(order by parent.job_id)::text,12,'0'
      ))::uuid child_job_id
    from public.source_processing_jobs parent
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent.workspace_key
     and lineage.job_id=parent.job_id
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=parent.workspace_key
     and plan.parent_job_id=parent.job_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,attempt_count,max_attempts,
    available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
    safe_error_detail,processor_version,payload,result,completed_at
  ) select child_job_id,'gmail:model-claims:v1:'||model_plan_hash,$1,
    'gmail',$2,'gmail_extract_message_model_claims',observation_id,
    source_object_id,'waiting_runtime',0,5,clock_timestamp(),null,0,null,
    'GMAIL_MODEL_RUNTIME_DISABLED','MODEL_RUNTIME_DISABLED',
    'truth-gmail-model-worker-v1',jsonb_build_object(
      'schemaVersion','gmail-model-claims-job-v1',
      'modelPlanId',model_plan_id,'contextSealId',context_seal_id,
      'batchId',$3::text,'rootBatchId',$3::text,
      'rootJobId',root_job_id,'parentJobId',parent_job_id
    ),'{}'::jsonb,null from parent_rows`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);
  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select child.job_id,child.workspace_key,'gmail',child.connection_key,
    $1::uuid,parent.job_id,parent_lineage.root_job_id,1,'19563092'
  from public.source_processing_jobs child
  join public.source_processing_jobs parent
    on parent.workspace_key=child.workspace_key
   and parent.job_id=(child.payload->>'parentJobId')::uuid
  join public.source_processing_job_lineage parent_lineage
    on parent_lineage.workspace_key=parent.workspace_key
   and parent_lineage.job_id=parent.job_id
  where child.workspace_key=$2 and child.connection_key=$3
    and child.job_kind='gmail_extract_message_model_claims'`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_processing_job_children(
    parent_job_id,child_job_id,ordinal
  ) select (child.payload->>'parentJobId')::uuid,child.job_id,0
  from public.source_processing_jobs child
  where child.workspace_key=$1 and child.connection_key=$2
    and child.job_kind='gmail_extract_message_model_claims'`,
  [WORKSPACE, CONNECTION]);
}

async function main() {
  const db = await createDatabase();
  try {
    await seedExactChildren(db);
    const before = (await db.query(`select child.job_id::text,state,
      attempt_count,max_attempts,lease_fence,payload,result,
      lineage.parent_job_id::text,lineage.root_job_id::text,
      lineage.source_cursor_version,lineage.source_cursor_value
      from public.source_processing_jobs child
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=child.workspace_key
       and lineage.job_id=child.job_id
      where child.workspace_key=$1 and child.connection_key=$2
        and child.job_kind='gmail_extract_message_model_claims'
      order by child.job_id`, [WORKSPACE, CONNECTION])).rows;
    assert.equal(before.length, 11);
    assert.equal(before.filter((row) => row.state === "waiting_runtime").length, 11);

    const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, MIGRATION), "utf8");
    await db.exec(migrationSql);
    const after = (await db.query(`select child.job_id::text,state,
      attempt_count,max_attempts,lease_fence,payload,result,
      lineage.parent_job_id::text,lineage.root_job_id::text,
      lineage.source_cursor_version,lineage.source_cursor_value,
      child.last_error_code
      from public.source_processing_jobs child
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=child.workspace_key
       and lineage.job_id=child.job_id
      where child.workspace_key=$1 and child.connection_key=$2
        and child.job_kind='gmail_extract_message_model_claims'
      order by child.job_id`, [WORKSPACE, CONNECTION])).rows;
    const admissionProbe = (await db.query(`select child.job_id::text,
      child.state,child.last_error_code,
      private.truth_shadow_gmail_model_job_allowed_v2(
        child.workspace_key,child.job_id
      ) job_allowed,
      private.truth_shadow_gmail_residual_model_parent_allowed_v1(
        parent.workspace_key,parent.job_id,true
      ) parent_allowed
      from public.source_processing_jobs child
      join public.source_processing_jobs parent
        on parent.workspace_key=child.workspace_key
       and parent.job_id=(child.payload->>'parentJobId')::uuid
      where child.workspace_key=$1 and child.connection_key=$2
        and child.job_kind='gmail_extract_message_model_claims'
      order by child.job_id`, [WORKSPACE, CONNECTION])).rows;
    const parentDebug = await one(db, `select
      auth.authorization_id is not null auth_exists,
      plan.extraction_plan_id is not null plan_exists,
      context_seal.context_seal_id is not null context_exists,
      manifest.job_id is not null manifest_exists,
      auth.prior_payload_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(parent.payload),'UTF8'
      ),'sha256'),'hex') payload_ok,
      auth.authorized_max_attempts=parent.max_attempts max_ok,
      parent.attempt_count>auth.prior_attempt_count attempt_ok,
      parent.state='succeeded' state_ok,
      parent.completed_at is not null completed_ok,
      parent.result #>> '{truthPlan,extractionPlanId}'=plan.extraction_plan_id result_plan_ok,
      parent.result #>> '{truthPlan,planSealHash}'=plan.plan_seal_hash result_seal_ok,
      parent.result #>> '{truthPlan,deterministicManifestHash}'=plan.deterministic_manifest_hash result_manifest_ok,
      parent.result #>> '{truthPlan,modelPlanId}'=plan.model_plan_id result_model_ok,
      plan.model_plan_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(plan.model_plan-'modelPlanId'-'modelPlanHash'),
        'UTF8'
      ),'sha256'),'hex') model_hash_ok,
      manifest.manifest_hash=encode(extensions.digest(convert_to(
        manifest.canonical_manifest::text,'UTF8'
      ),'sha256'),'hex') manifest_hash_ok,
      context_seal.seal_hash=encode(extensions.digest(convert_to(
        context_seal.canonical_seal::text,'UTF8'
      ),'sha256'),'hex') context_hash_ok,
      plan.plan_seal_hash=encode(extensions.digest(convert_to(
        plan.canonical_plan_seal::text,'UTF8'
      ),'sha256'),'hex') plan_hash_ok,
      plan.canonical_plan_seal->>'planSealHash' is null no_embedded_hash
      from public.source_processing_jobs parent
      join public.source_processing_job_lineage lineage
        on lineage.workspace_key=parent.workspace_key and lineage.job_id=parent.job_id
      left join public.truth_shadow_gmail_model_residual_retry_authorizations auth
        on auth.workspace_key=parent.workspace_key and auth.claim_job_id=parent.job_id
      left join public.gmail_model_extraction_plans plan
        on plan.workspace_key=parent.workspace_key and plan.parent_job_id=parent.job_id
      left join public.gmail_model_extraction_context_seals context_seal
        on context_seal.workspace_key=plan.workspace_key
       and context_seal.context_seal_id=plan.context_seal_id
      left join public.candidate_claim_job_manifests manifest
        on manifest.workspace_key=parent.workspace_key and manifest.job_id=parent.job_id
      where parent.workspace_key=$1 and parent.connection_key=$2
        and parent.job_kind='gmail_extract_message_claims'
      order by parent.job_id limit 1`, [WORKSPACE, CONNECTION]);
    assert.equal(after.filter((row) => row.state === "queued").length, 10,
      JSON.stringify({ admissionProbe, parentDebug }));
    assert.equal(after.filter((row) => row.state === "waiting_runtime").length, 1);
    const authorizedIds = new Set((await db.query(`select claim_job_id::text id
      from public.truth_shadow_gmail_model_residual_retry_authorizations`)).rows
      .map((row) => row.id));
    for (let index = 0; index < before.length; index += 1) {
      const prior = before[index];
      const current = after[index];
      assert.equal(current.job_id, prior.job_id);
      assert.equal(current.attempt_count, prior.attempt_count);
      assert.equal(current.max_attempts, prior.max_attempts);
      assert.equal(current.lease_fence, prior.lease_fence);
      assert.deepEqual(current.payload, prior.payload);
      assert.deepEqual(current.result, prior.result);
      assert.equal(current.parent_job_id, prior.parent_job_id);
      assert.equal(current.root_job_id, prior.root_job_id);
      assert.equal(current.source_cursor_version, prior.source_cursor_version);
      assert.equal(current.source_cursor_value, prior.source_cursor_value);
      if (authorizedIds.has(current.parent_job_id)) {
        assert.equal(current.state, "queued");
        assert.equal(current.last_error_code, "");
      } else {
        assert.equal(current.state, "waiting_runtime");
        assert.equal(current.last_error_code, "GMAIL_MODEL_RUNTIME_DISABLED");
      }
    }

    const storedInputProof = await one(db, `select
      private.truth_shadow_gmail_model_child_input_allowed_v2(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key,child.observation_id,child.payload
      ) exact_stored_input_allowed,
      private.truth_shadow_gmail_model_child_input_allowed_v2(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key||':tampered',child.observation_id,child.payload
      ) tampered_dedupe_allowed,
      private.truth_shadow_gmail_model_child_input_allowed_v2(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key,child.observation_id,
        jsonb_set(child.payload,'{modelPlanId}',to_jsonb(
          ('gmail-model-plan:v1:'||repeat('f',64))::text
        ))
      ) tampered_payload_allowed,
      private.truth_shadow_gmail_model_child_input_allowed_v2(
        child.workspace_key,gen_random_uuid()::text,child.job_id,
        child.dedupe_key,child.observation_id,child.payload
      ) tampered_parent_allowed
      from public.source_processing_jobs child
      where child.workspace_key=$1 and child.connection_key=$2
        and child.job_kind='gmail_extract_message_model_claims'
        and child.state='queued'
      order by child.job_id limit 1`, [WORKSPACE, CONNECTION]);
    assert.deepEqual(storedInputProof, {
      exact_stored_input_allowed: true,
      tampered_dedupe_allowed: false,
      tampered_payload_allowed: false,
      tampered_parent_allowed: false,
    });

    const claimed = await asService(db, async () => (await one(db, `select
      public.claim_source_processing_jobs(
        $1,'gmail',$2,$3,$4,20,300,
        array['gmail_extract_message_model_claims'],$5
      ) as receipt`, [WORKSPACE, CONNECTION, WORKER, PROCESSOR, SYNC])).receipt);
    assert.equal(claimed.claimedCount, 10);
    assert.ok(claimed.jobs.every((job) => authorizedIds.has(job.payload.parentJobId)));
    await db.exec(migrationSql);
    const terminal = await one(db, `select
      (select count(*)::integer from public.source_processing_jobs
       where workspace_key=$1 and connection_key=$2
         and job_kind='gmail_extract_message_model_claims'
         and state='leased') leased,
      (select count(*)::integer from public.source_processing_jobs
       where workspace_key=$1 and connection_key=$2
         and job_kind='gmail_extract_message_model_claims'
         and state='waiting_runtime') unauthorized_parked,
      (select count(*)::integer from public.truth_model_requests) model_requests,
      (select count(*)::integer from public.truth_builds) builds,
      (select count(*)::integer from public.truth_publications) publications`,
    [WORKSPACE, CONNECTION]);
    assert.deepEqual(terminal, {
      leased: 10,
      unauthorized_parked: 1,
      model_requests: 0,
      builds: 0,
      publications: 0,
    });
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-gmail-resumed-model-child-admission",
      exactAuthorizedChildCount: 10,
      adoptedQueuedCount: 10,
      claimableCount: 10,
      unauthorizedParkedCount: 1,
      preservedFields: [
        "attempt_count", "max_attempts", "lease_fence", "payload", "result",
        "parent_job_id", "root_job_id", "source_cursor_version",
        "source_cursor_value",
      ],
      storedSucceededParentUpdateProof: true,
      storedInputIdentityFenceProof: true,
      productionPublicationAttempted: false,
      reapplyStable: true,
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

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
const MIGRATION = "20260717150000_truth_gmail_resumed_model_terminal_authority.sql";
const CLAIM_MIGRATION = "20260717180000_fix_truth_claim_gate_selection.sql";
const PREVIOUS_MIGRATION = "20260717140000_truth_shadow_link_sample_acceptance_runtime.sql";
const WORKSPACE = "primary";
const CONNECTION = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";
const SYNC = "truth-resumed-model-terminal-authority-sync-token-v1";
const WORKER = "truth-resumed-model-terminal-authority-worker";
const PROCESSOR = "truth-resumed-model-terminal-authority-processor-v1";

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
  const previousIndex = ALL_MIGRATIONS.indexOf(PREVIOUS_MIGRATION);
  assert.ok(previousIndex >= 0, "full-stack verifier omits migration 140000");
  for (const name of ALL_MIGRATIONS.slice(0, previousIndex + 1)) {
    await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.query(`insert into public.sync_tokens(token_name,token_hash) values
    ('local_snapshot_writer',encode(extensions.digest(convert_to(
      $1::text,'UTF8'
    ),'sha256'),'hex'))`, [SYNC]);
  return db;
}

async function seedScope(db) {
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
  ) values($1::uuid,$2,'gmail',$3,'backfill','resumed-terminal-fixture',
    0,'',1,'19563092','resumed-terminal-fixture',1,'committed',
    encode(extensions.digest(convert_to('resumed-terminal-batch','UTF8'),
      'sha256'),'hex'),10,746,clock_timestamp(),clock_timestamp())`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with fixture as (
    select i,
      'obs:v1:'||encode(extensions.digest(convert_to(
        'resumed-terminal-observation-'||i,'UTF8'
      ),'sha256'),'hex') observation_id,
      jsonb_build_object(
        'schemaVersion','gmail-parsed-message-v2',
        'gmail',jsonb_build_object(
          'messageId','resumed-terminal-message-'||i,
          'threadId','resumed-terminal-thread-'||i
        ),
        'subject','Late model evidence '||i,
        'text','Operational evidence requiring exact model extraction.',
        'sourceChronology',jsonb_build_object(
          'sourceRecordedAt','2026-07-10T18:47:20.123456Z'
        )
      ) payload
    from generate_series(1,10) i
  ) insert into public.source_observations(
    observation_id,workspace_key,source_system,connection_key,
    source_object_type,source_object_id,source_revision,operation,
    source_cursor_version,batch_id,content_hash,source_recorded_at,captured_at,
    normalized_payload,normalized_text,source_fidelity,schema_version
  ) select observation_id,$2,'gmail',$3,'gmail_message_parsed',
    'resumed-terminal-message-'||i,'19563092','content',1,$1::uuid,
    encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(payload),'UTF8'
    ),'sha256'),'hex'),'2026-07-10T18:47:20.123456Z',
    '2026-07-10T18:47:22.755473Z',payload,payload->>'text',
    'normalized_source','gmail-parsed-message-v2'
  from fixture`, [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with fixture as (
    select i,
      ('61000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid job_id,
      'obs:v1:'||encode(extensions.digest(convert_to(
        'resumed-terminal-observation-'||i,'UTF8'
      ),'sha256'),'hex') observation_id
    from generate_series(1,10) i
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,attempt_count,max_attempts,
    available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
    safe_error_detail,processor_version,payload,result,completed_at
  ) select job_id,'resumed-terminal-parent:'||i,$1,'gmail',$2,
    'gmail_extract_message_claims',observation_id,
    'resumed-terminal-message-'||i,'succeeded',6,8,clock_timestamp(),
    null,6,null,'','','truth-gmail-parent-planning-worker-v1',
    '{}'::jsonb,'{}'::jsonb,clock_timestamp()
  from fixture`, [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select job.job_id,job.workspace_key,'gmail',job.connection_key,$1::uuid,
    null,job.job_id,1,'19563092'
  from public.source_processing_jobs job
  where job.workspace_key=$2 and job.connection_key=$3
    and job.job_kind='gmail_extract_message_claims'`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
}

async function seedPlansAndParentManifests(db) {
  await db.query(`with parent_rows as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.job_id,parent.observation_id,observation.content_hash,
      observation.journal_seq,jsonb_build_object(
        'schemaVersion','gmail-model-extraction-context-seal-v1',
        'workspaceKey',parent.workspace_key,'parentJobId',parent.job_id,
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
  ) select 'gmail-model-context:v1:'||seal_hash,$1,job_id,observation_id,
    content_hash,journal_seq,repeat('1',64),repeat('2',64),repeat('3',64),
    repeat('4',64),repeat('5',64),repeat('6',64),0,0,1,'null'::jsonb,
    canonical,seal_hash,'gmail-model-extraction-context-seal-v1'
  from hashed`, [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.gmail_model_context_observations(
    workspace_key,context_seal_id,ordinal,observation_id,
    observation_content_hash
  ) select seal.workspace_key,seal.context_seal_id,0,
    seal.source_observation_id,seal.source_observation_content_hash
  from public.gmail_model_extraction_context_seals seal
  where seal.workspace_key=$1`, [WORKSPACE]);

  await db.query(`with parent_rows as (
    select parent.job_id,parent.observation_id,jsonb_build_object(
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
        'sourceCapturedAt',case when row_number() over(order by parent.job_id)<=7
          then '2026-07-10T18:47:22.755Z'
          else '2026-07-10T18:47:22.755473Z' end,
        'sourceRecordedAt',case when row_number() over(order by parent.job_id)<=7
          then '2026-07-10T18:47:20.123Z'
          else '2026-07-10T18:47:20.123456Z' end,
        'modelInput',jsonb_build_object(
          'text','Late model evidence '||row_number() over(order by parent.job_id)
        ),
        'config',jsonb_build_object('dateOrder','MDY','maxModelConfidence',0.9)
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
    select model_hashed.*,model_core||jsonb_build_object(
      'modelPlanId','gmail-model-plan:v1:'||model_hash,
      'modelPlanHash',model_hash
    ) model_plan,jsonb_build_object('input','fixture-model-input-'||i) request_payload
    from model_hashed
  ), sealed as (
    select model_bound.*,
      encode(extensions.digest(convert_to(
        'resumed-terminal-extraction-plan-'||i,'UTF8'
      ),'sha256'),'hex') extraction_hash,
      jsonb_build_object(
        'schemaVersion','gmail-model-extraction-plan-seal-v1',
        'workspaceKey',$1::text,'parentJobId',job_id,
        'sourceObservationId',observation_id,
        'sourceObservationContentHash',content_hash,
        'deterministicManifestHash',manifest_hash,
        'deterministicCandidateCount',0,'contextSealId',context_seal_id,
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
  set result=jsonb_build_object('truthPlan',jsonb_build_object(
    'extractionPlanId',plan.extraction_plan_id,
    'planSealHash',plan.plan_seal_hash,
    'deterministicManifestHash',plan.deterministic_manifest_hash,
    'modelPlanId',plan.model_plan_id,
    'planningStatus','complete','planningFailureCode',''
  ))
  from public.gmail_model_extraction_plans plan
  where parent.workspace_key=plan.workspace_key
    and parent.job_id=plan.parent_job_id
    and parent.workspace_key=$1`, [WORKSPACE]);
}

async function seedRetryAuthoritiesAndChildren(db) {
  await db.query(`with candidates as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.*,lineage.parent_job_id lineage_parent_job_id,
      lineage.root_job_id,lineage.source_cursor_version,
      lineage.source_cursor_value,observation.content_hash,
      '2026-07-10T14:00:00Z'::timestamptz prior_completed_at,
      case when row_number() over(order by parent.job_id)<=7
        then 'sealed_resume_or_reconcile' else 'unstarted' end artifact_mode,
      case when row_number() over(order by parent.job_id)<=7
        then 'immutable_source_binding' else 'statement_timeout' end failure_class
    from public.source_processing_jobs parent
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent.workspace_key and lineage.job_id=parent.job_id
    join public.source_observations observation
      on observation.workspace_key=parent.workspace_key
     and observation.observation_id=parent.observation_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ), bodies as (
    select candidates.*,jsonb_build_object(
      'schemaVersion','truth-shadow-gmail-model-residual-retry-authorization-v2',
      'workspaceKey',workspace_key,'connectionKey',connection_key,
      'rootBatchId',$3::uuid,'claimJobId',job_id,
      'claimJobDedupeKey',dedupe_key,'sourceObservationId',observation_id,
      'sourceObjectId',source_object_id,
      'sourceObservationContentHash',content_hash,
      'priorPayloadHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(payload),'UTF8'
      ),'sha256'),'hex'),
      'lineageParentJobId',coalesce(lineage_parent_job_id::text,''),
      'lineageRootJobId',root_job_id,'sourceCursorVersion',source_cursor_version,
      'sourceCursorValueHash',encode(extensions.digest(convert_to(
        source_cursor_value,'UTF8'
      ),'sha256'),'hex'),
      'priorState','dead_letter','priorAttemptCount',5,'priorMaxAttempts',5,
      'priorLeaseFence',5,'priorCompletedAt',to_char(
        prior_completed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'priorResultHash',encode(extensions.digest(convert_to(
        private.truth_canonical_json_text('{}'::jsonb),'UTF8'
      ),'sha256'),'hex'),
      'priorErrorCode','TRUTH_GMAIL_MODEL_PLAN_RPC_FAILED',
      'priorErrorDetailHash',encode(extensions.digest(convert_to(
        'resumed-terminal-prior-error-'||i,'UTF8'
      ),'sha256'),'hex'),'failureClass',failure_class,
      'artifactMode',artifact_mode,'authorizedMaxAttempts',8,
      'reasonCode',case failure_class
        when 'immutable_source_binding' then 'RESIDUAL_IMMUTABLE_PLAN_BINDING_RETRY'
        else 'RESIDUAL_MODEL_PLAN_STATEMENT_TIMEOUT_RETRY' end,
      'shadowOnly',true,'mutatesOperationalState',false,
      'productionEligible',false,'productionPublicationAttempted',false
    ) canonical
    from candidates
  ), hashed as (
    select bodies.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical),'UTF8'
    ),'sha256'),'hex') auth_hash from bodies
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
    failure_class,artifact_mode,8,canonical,
    'truth-shadow-gmail-model-residual-retry-authorization-v2'
  from hashed`, [WORKSPACE, CONNECTION, ROOT_BATCH]);

  // Reproduce the installed rows byte-for-byte. The pre-150 route is the bug
  // under test and would otherwise park these legacy retry_wait snapshots
  // while the fixture is being assembled.
  await db.exec(`alter table public.source_processing_jobs
    disable trigger source_processing_job_gmail_link_claim_wait`);
  await db.query(`with parent_rows as (
    select row_number() over(order by parent.job_id)::integer i,
      parent.job_id,parent.observation_id,parent.source_object_id,
      plan.model_plan_id,plan.model_plan_hash,plan.context_seal_id,
      lineage.root_job_id,
      ('71000000-0000-4000-8000-'||lpad(
        row_number() over(order by parent.job_id)::text,12,'0'
      ))::uuid child_job_id
    from public.source_processing_jobs parent
    join public.source_processing_job_lineage lineage
      on lineage.workspace_key=parent.workspace_key and lineage.job_id=parent.job_id
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=parent.workspace_key and plan.parent_job_id=parent.job_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,attempt_count,max_attempts,
    available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
    safe_error_detail,processor_version,payload,result,completed_at
  ) select child_job_id,'gmail:model-claims:v1:'||model_plan_hash,$1,
    'gmail',$2,'gmail_extract_message_model_claims',observation_id,
    source_object_id,case when i<=7 then 'retry_wait' else 'waiting_runtime' end,
    case when i<=7 then 3 else 0 end,5,clock_timestamp(),null,
    case when i<=7 then 3 else 0 end,null,
    case when i<=7 then 'MODEL_REQUEST_CONFIGURATION_ERROR'
      else 'GMAIL_MODEL_RUNTIME_DISABLED' end,
    case when i<=7 then 'source identity does not match its immutable observation'
      else 'MODEL_RUNTIME_DISABLED' end,
    'truth-gmail-model-worker-v1',jsonb_build_object(
      'schemaVersion','gmail-model-claims-job-v1',
      'modelPlanId',model_plan_id,'contextSealId',context_seal_id,
      'batchId',$3::text,'rootBatchId',$3::text,'rootJobId',root_job_id,
      'parentJobId',job_id
    ),'{}'::jsonb,null
  from parent_rows`, [WORKSPACE, CONNECTION, ROOT_BATCH]);
  await db.exec(`alter table public.source_processing_jobs
    enable trigger source_processing_job_gmail_link_claim_wait`);
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

async function seedCertifiedEpoch(db) {
  const pendingJob = "72000000-0000-4000-8000-000000000001";
  await db.query(`insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    source_object_id,state,attempt_count,max_attempts,available_at,
    lease_owner,lease_fence,lease_expires_at,last_error_code,safe_error_detail,
    processor_version,payload,result,completed_at
  ) values($1::uuid,'resumed-terminal-acceptance-epoch',$2,'gmail',$3,
    'truth_sequence_claim_acceptance_epoch','resumed-terminal-epoch',
    'succeeded',1,5,clock_timestamp(),null,1,null,'','',
    'truth-shadow-acceptance-epoch-v1','{}'::jsonb,'{}'::jsonb,
    clock_timestamp())`, [pendingJob, WORKSPACE, CONNECTION]);
  const obligation = await one(db, `with body as (
    select jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-obligation-v1',
      'workspaceKey',$2::text,'sourceSystem','gmail','connectionKey',$3::text,
      'rootBatchId',$1::uuid,'sourceCursorVersion',1,
      'sourceCursorValue','19563092','pendingJobId',$4::uuid
    ) canonical
  ), hashed as (
    select canonical,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical),'UTF8'
    ),'sha256'),'hex') obligation_hash from body
  ) insert into public.truth_pending_acceptance_epochs(
    workspace_key,source_system,connection_key,root_batch_id,
    source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
    canonical_obligation,obligation_hash,schema_version
  ) select $2,'gmail',$3,$1::uuid,1,'19563092',$4::uuid,
    'pending-acceptance-epoch:v1:'||obligation_hash,canonical,
    obligation_hash,'pending-acceptance-epoch-obligation-v1'
  from hashed returning obligation_id`,
  [ROOT_BATCH, WORKSPACE, CONNECTION, pendingJob]);

  await db.query(`with members as (
    select parent.job_id,parent.observation_id,observation.content_hash,
      manifest.manifest_hash,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(parent.result),'UTF8'
      ),'sha256'),'hex') worker_result_hash
    from public.source_processing_jobs parent
    join public.source_observations observation
      on observation.workspace_key=parent.workspace_key
     and observation.observation_id=parent.observation_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=parent.workspace_key and manifest.job_id=parent.job_id
    where parent.workspace_key=$1 and parent.connection_key=$2
      and parent.job_kind='gmail_extract_message_claims'
  ), bodies as (
    select members.*,jsonb_build_object(
      'schemaVersion','pending-acceptance-epoch-manifest-v1',
      'workspaceKey',$1::text,'obligationId',$3::text,
      'sourceJobId',job_id,'sourceObservationId',observation_id,
      'sourceObservationContentHash',content_hash,'candidateCount',0,
      'candidateManifestHash',manifest_hash,'workerResultHash',worker_result_hash
    ) canonical from members
  ), hashed as (
    select bodies.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical),'UTF8'
    ),'sha256'),'hex') membership_hash from bodies
  ) insert into public.truth_pending_acceptance_epoch_manifests(
    workspace_key,obligation_id,source_job_id,source_observation_id,
    source_observation_content_hash,candidate_count,candidate_manifest_hash,
    worker_result_hash,canonical_membership,membership_hash,schema_version
  ) select $1,$3,job_id,observation_id,content_hash,0,manifest_hash,
    worker_result_hash,canonical,membership_hash,
    'pending-acceptance-epoch-manifest-v1' from hashed`,
  [WORKSPACE, CONNECTION, obligation.obligation_id]);

  await db.query(`with frontier as (
    select jsonb_build_object(
      'schemaVersion','truth-shadow-claim-frontier-v1',
      'sourceManifests',jsonb_agg(jsonb_build_object(
        'sourceJobId',membership.source_job_id,
        'sourceObservationId',membership.source_observation_id,
        'sourceObservationContentHash',membership.source_observation_content_hash,
        'candidateManifestHash',membership.candidate_manifest_hash,
        'workerResultHash',membership.worker_result_hash,
        'membershipHash',membership.membership_hash
      ) order by membership.source_job_id)
    ) manifest
    from public.truth_pending_acceptance_epoch_manifests membership
    where membership.workspace_key=$1 and membership.obligation_id=$4
  ), receipt_body as (
    select frontier.manifest,jsonb_build_object(
      'schemaVersion','truth-shadow-claim-acceptance-epoch-v1',
      'workspaceKey',$1::text,'sourceSystem','gmail','connectionKey',$2::text,
      'rootBatchId',$3::uuid,'obligationId',$4::text,
      'candidateCount',0,'acceptedCount',0,'rejectedCount',0,'reviewCount',0
    ) receipt from frontier
  ), hashes as (
    select manifest,receipt,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(manifest),'UTF8'
      ),'sha256'),'hex') frontier_hash,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(receipt),'UTF8'
      ),'sha256'),'hex') receipt_hash,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text('[]'::jsonb),'UTF8'
      ),'sha256'),'hex') empty_hash
    from receipt_body
  ) insert into public.truth_shadow_claim_acceptance_epochs(
    epoch_id,workspace_key,source_system,connection_key,root_batch_id,
    source_cursor_version,source_cursor_value,pending_job_id,obligation_id,
    obligation_hash,predecessor_epoch_id,predecessor_epoch_hash,
    frontier_manifest,frontier_manifest_hash,decision_manifest,
    decision_manifest_hash,head_manifest,head_manifest_hash,candidate_count,
    accepted_count,rejected_count,review_count,canonical_receipt,receipt_hash,
    schema_version
  ) select 'truth-shadow-acceptance-epoch:v1:'||receipt_hash,$1,'gmail',$2,
    $3::uuid,1,'19563092',$5::uuid,$4,
    substring($4 from '([0-9a-f]{64})$'),null,'',manifest,frontier_hash,
    '[]'::jsonb,empty_hash,'[]'::jsonb,empty_hash,0,0,0,0,receipt,
    receipt_hash,'truth-shadow-claim-acceptance-epoch-v1'
  from hashes`,
  [WORKSPACE, CONNECTION, ROOT_BATCH, obligation.obligation_id, pendingJob]);
}

async function seedLineageDistractors(db) {
  await db.query(`with fixture as (
    select i,gen_random_uuid() job_id from generate_series(1,725) i
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    source_object_id,state,attempt_count,max_attempts,available_at,
    lease_owner,lease_fence,lease_expires_at,last_error_code,safe_error_detail,
    processor_version,payload,result,completed_at
  ) select job_id,'resumed-terminal-distractor:'||i,$1,'gmail',$2,
    'gmail_fetch_raw_message','distractor-'||i,'succeeded',1,5,
    clock_timestamp(),null,1,null,'','','fixture-distractor','{}'::jsonb,
    '{}'::jsonb,clock_timestamp() from fixture`, [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select job.job_id,job.workspace_key,job.source_system,job.connection_key,
    $1::uuid,null,job.job_id,1,'19563092'
  from public.source_processing_jobs job
  where job.workspace_key=$2 and job.connection_key=$3
    and job.dedupe_key like 'resumed-terminal-distractor:%'`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
}

async function main() {
  const db = await createDatabase();
  try {
    await seedScope(db);
    await seedPlansAndParentManifests(db);
    await seedRetryAuthoritiesAndChildren(db);
    await seedCertifiedEpoch(db);
    await seedLineageDistractors(db);

    const before = await one(db, `select
      count(*) filter (where child.state='retry_wait')::integer stale_jobs,
      count(*) filter (where child.state='waiting_runtime')::integer current_jobs,
      count(*) filter (where child.attempt_count=3 and child.max_attempts=5)::integer stale_attempt_shape,
      count(*) filter (where child.attempt_count=0 and child.max_attempts=5)::integer current_attempt_shape,
      (select count(*)::integer from public.source_processing_job_lineage
       where workspace_key=$1 and connection_key=$2
         and job_id in (select job_id from public.source_processing_jobs
           where dedupe_key like 'resumed-terminal-distractor:%')) distractors
    from public.source_processing_jobs child
    where child.workspace_key=$1 and child.connection_key=$2
      and child.job_kind='gmail_extract_message_model_claims'`,
    [WORKSPACE, CONNECTION]);
    assert.deepEqual(before, {
      stale_jobs: 7,
      current_jobs: 3,
      stale_attempt_shape: 7,
      current_attempt_shape: 3,
      distractors: 725,
    });

    const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, MIGRATION), "utf8");
    const claimMigrationSql = fs.readFileSync(
      path.join(MIGRATION_DIR, CLAIM_MIGRATION),
      "utf8",
    );
    await db.exec(migrationSql);
    await db.exec(migrationSql);
    await db.exec(claimMigrationSql);
    const authority = await one(db, `select
      count(*)::integer total,
      count(*) filter (where disposition='stale_time_binding_review')::integer stale,
      count(*) filter (where disposition='model_execution')::integer execution,
      count(*) filter (where disposition='model_execution'
        and canonical_authorization->>'disposition'='model_execution'
        and exists (
          select 1 from public.gmail_model_extraction_plans plan
          where plan.workspace_key=authority.workspace_key
            and plan.model_plan_id=authority.model_plan_id
            and plan.execution_mode='sync'
        ))::integer execution_sync,
      count(*) filter (where shadow_only and not mutates_operational_state
        and not production_eligible and not production_publication_attempted)::integer shadow_only,
      count(distinct predecessor_epoch_id)::integer predecessor_epochs
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.root_batch_id=$3::uuid`,
    [WORKSPACE, CONNECTION, ROOT_BATCH]);
    assert.deepEqual(authority, {
      total: 10,
      stale: 7,
      execution: 3,
      execution_sync: 3,
      shadow_only: 10,
      predecessor_epochs: 1,
    });

    const adoption = await one(db, `select
      count(*) filter (where authority.disposition='stale_time_binding_review'
        and child.state='retry_wait' and child.attempt_count=3
        and child.max_attempts=6)::integer stale_reauthorized,
      count(*) filter (where authority.disposition='model_execution'
        and child.state='queued' and child.attempt_count=0
        and child.max_attempts=5 and child.last_error_code='')::integer current_adopted,
      count(*) filter (where private.truth_shadow_gmail_model_job_allowed_v3(
        child.workspace_key,child.job_id))::integer allowed
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_processing_jobs child
      on child.workspace_key=authority.workspace_key
     and child.job_id=authority.model_child_job_id
    where authority.workspace_key=$1 and authority.connection_key=$2`,
    [WORKSPACE, CONNECTION]);
    assert.deepEqual(adoption, {
      stale_reauthorized: 7,
      current_adopted: 3,
      allowed: 10,
    });

    const functionContract = await one(db, `select
      position('cheap_message_model_claim_jobs as materialized' in lower(pg_get_functiondef(
        'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
      )))>0 cheap_model_materialized,
      position('admitted_message_model_claim_jobs as materialized' in lower(pg_get_functiondef(
        'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
      )))>0 admitted_model_materialized,
      position('truth_shadow_gmail_model_job_allowed_v3' in pg_get_functiondef(
        'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
      ))>0 v3_claim_gate,
      position('for update of job skip locked' in lower(pg_get_functiondef(
        'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure
      )))>0 skip_locked,
      coalesce((select proconfig=array['search_path=""']
        from pg_proc where oid=
          'private.claim_source_processing_jobs(text,text,text,text,text,integer,integer,text[],text)'::regprocedure),false)
        stock_function_settings`, []);
    assert.deepEqual(functionContract, {
      cheap_model_materialized: true,
      admitted_model_materialized: true,
      v3_claim_gate: true,
      skip_locked: true,
      stock_function_settings: true,
    });

    const claimed = await asService(db, async () => (await one(db, `select
      public.claim_source_processing_jobs(
        $1,'gmail',$2,$3,$4,20,300,
        array['gmail_extract_message_model_claims'],$5
      ) receipt`, [WORKSPACE, CONNECTION, WORKER, PROCESSOR, SYNC])).receipt);
    assert.equal(claimed.claimedCount, 10);
    const leased = await one(db, `select child.job_id,child.lease_fence,
      authority.model_plan_id,authority.disposition
    from public.source_processing_jobs child
    join public.truth_shadow_gmail_resumed_model_child_authorizations authority
      on authority.workspace_key=child.workspace_key
     and authority.model_child_job_id=child.job_id
    where child.workspace_key=$1 and child.connection_key=$2
      and child.state='leased' and child.lease_owner=$3
      and authority.disposition='stale_time_binding_review'
    order by child.job_id limit 1`, [WORKSPACE, CONNECTION, WORKER]);
    const review = await asService(db, async () => (await one(db, `select
      public.create_truth_shadow_stale_gmail_model_review(
        $1,$2::uuid,$3,$4::bigint,$5,$6,$7
      ) receipt`, [WORKSPACE, leased.job_id, WORKER, leased.lease_fence,
      PROCESSOR, leased.model_plan_id, SYNC])).receipt);
    assert.equal(review.ok, true);
    assert.equal(review.reasonCode, "STALE_IMMUTABLE_SOURCE_TIME_BINDING");
    assert.equal(review.mutatesOperationalState, false);
    assert.equal(review.publishesTruth, false);

    const reviewProof = await one(db, `select
      count(*)::integer intents,
      count(*) filter (where authority_kind=
        'shadow_stale_source_time_binding_authority')::integer exact_authority,
      count(*) filter (where reason_code=
        'STALE_IMMUTABLE_SOURCE_TIME_BINDING')::integer exact_reason,
      (select count(*)::integer from public.truth_model_requests) provider_requests,
      (select count(*)::integer from public.gmail_model_extraction_results) model_results,
      (select count(*)::integer from public.truth_builds) builds,
      (select count(*)::integer from public.truth_publications) publications
    from public.gmail_model_extraction_review_intents
    where workspace_key=$1 and model_child_job_id=$2::uuid`,
    [WORKSPACE, leased.job_id]);
    assert.deepEqual(reviewProof, {
      intents: 1,
      exact_authority: 1,
      exact_reason: 1,
      provider_requests: 0,
      model_results: 0,
      builds: 0,
      publications: 0,
    });

    let staleRequestRejected = false;
    try {
      await db.query(`insert into public.truth_model_requests(
        workspace_key,source_job_id
      ) values($1,$2::uuid)`, [WORKSPACE, leased.job_id]);
    } catch (error) {
      staleRequestRejected = String(error?.message || error).includes(
        "stale-bound shadow Gmail model child is review-only",
      );
    }
    assert.equal(staleRequestRejected, true,
      "the database must reject any model request for a stale-bound review child");

    const tamper = await one(db, `select
      private.truth_shadow_gmail_model_child_input_allowed_v3(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key,child.observation_id,child.payload
      ) exact_allowed,
      private.truth_shadow_gmail_model_child_input_allowed_v3(
        child.workspace_key,child.payload->>'parentJobId',child.job_id,
        child.dedupe_key||':tampered',child.observation_id,child.payload
      ) tampered_allowed
    from public.source_processing_jobs child
    where child.workspace_key=$1 and child.job_id=$2::uuid`,
    [WORKSPACE, leased.job_id]);
    assert.deepEqual(tamper, { exact_allowed: true, tampered_allowed: false });

    await db.exec(claimMigrationSql);
    const reapply = await one(db, `select
      count(*)::integer authorities,
      count(*) filter (where disposition='stale_time_binding_review')::integer stale,
      count(*) filter (where disposition='model_execution')::integer execution,
      (select count(*)::integer from public.gmail_model_extraction_review_intents
       where workspace_key=$1) intents
    from public.truth_shadow_gmail_resumed_model_child_authorizations
    where workspace_key=$1 and connection_key=$2`, [WORKSPACE, CONNECTION]);
    assert.deepEqual(reapply, {
      authorities: 10,
      stale: 7,
      execution: 3,
      intents: 1,
    });

    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-gmail-resumed-model-terminal-authority",
      predecessorEpochCertifiedParentCount: 10,
      staleMillisecondBindingReviewCount: 7,
      currentMicrosecondBindingExecutionCount: 3,
      lineageDistractorCount: 725,
      claimedCount: claimed.claimedCount,
      staleReviewIntentCount: 1,
      providerRequestCount: 0,
      staleProviderRequestRejectedByDatabase: true,
      boundedPostLimitClaimGateProof: true,
      enableNestloopEmergencyOverrideRemoved: true,
      tamperedStoredChildRejected: true,
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

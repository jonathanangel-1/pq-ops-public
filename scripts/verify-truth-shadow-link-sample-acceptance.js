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
const MIGRATION_NAMES = [...STACK_SOURCE.matchAll(/^\s*"(\d+_[^"]+\.sql)",$/gm)]
  .map((match) => match[1]);
const MIGRATION = "20260717140000_truth_shadow_link_sample_acceptance_runtime.sql";
const WORKSPACE = "primary";
const CONNECTION = "shadow-link-sample-fixture";
const ROOT_BATCH = "40000000-0000-4000-8000-000000000001";
const SYNC = "truth-shadow-link-sample-sync-token-v1";
const REVIEW = "truth-shadow-link-sample-review-token-v1";

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

async function expectCode(work, code, label) {
  let caught;
  try {
    await work;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `${label} must fail`);
  assert.equal(caught.code, code, `${label}: ${caught.message}`);
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
  for (const name of MIGRATION_NAMES) {
    await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.query(`insert into public.sync_tokens(token_name,token_hash) values
    ('local_snapshot_writer',encode(extensions.digest(convert_to($1::text,'UTF8'),'sha256'),'hex')),
    ('truth_review_decider',encode(extensions.digest(convert_to($2::text,'UTF8'),'sha256'),'hex'))`,
  [SYNC, REVIEW]);
  return db;
}

async function seedExactPopulation(db) {
  await db.query(`insert into public.source_cursors(
    workspace_key,source_system,connection_key,cursor_kind,cursor_value,
    cursor_version,status,last_committed_at
  ) values ($1,'gmail',$2,'gmail_history_id','947',947,'live',clock_timestamp())`,
  [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_ingest_batches(
    batch_id,workspace_key,source_system,connection_key,mode,trigger_name,
    expected_cursor_version,expected_cursor_value,committed_cursor_version,
    committed_cursor_value,lease_owner,lease_fence,status,batch_hash,
    page_count,observation_count,job_count,committed_at,finished_at
  ) values ($1::uuid,$2,'gmail',$3,'backfill','sample-fixture',
    0,'0',947,'947','sample-fixture',1,'committed',
    encode(extensions.digest(convert_to('sample-batch','UTF8'),'sha256'),'hex'),
    1,569,569,clock_timestamp(),clock_timestamp())`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with generated as (
    select i,
      'obs:v1:'||encode(extensions.digest(convert_to('sample-observation-'||i,'UTF8'),'sha256'),'hex') as observation_id,
      jsonb_build_object(
        'schemaVersion','gmail-parsed-message-v2',
        'gmail',jsonb_build_object('messageId','sample-message-'||i,'threadId','sample-thread-'||i),
        'subject','Deterministic link sample evidence '||i,
        'text','Shipment and counterparty evidence for deterministic proposal '||i
      ) as payload
    from generate_series(1,569) i
  ) insert into public.source_observations(
    observation_id,workspace_key,source_system,connection_key,
    source_object_type,source_object_id,source_revision,operation,
    source_cursor_version,batch_id,content_hash,source_recorded_at,
    captured_at,normalized_payload,normalized_text,source_fidelity,
    schema_version
  ) select observation_id,$2,'gmail',$3,'gmail_message_parsed',
    'sample-message-'||i,'1','content',i,$1::uuid,
    encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(payload),'UTF8'
    ),'sha256'),'hex'),
    '2026-07-10T12:00:00Z'::timestamptz + i * interval '1 second',
    '2026-07-10T12:00:00Z'::timestamptz + i * interval '1 second',
    payload,payload->>'text','normalized_source','gmail-parsed-message-v2'
  from generated`, [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with generated as (
    select i,
      ('50000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid as job_id,
      'obs:v1:'||encode(extensions.digest(convert_to('sample-observation-'||i,'UTF8'),'sha256'),'hex') as observation_id
    from generate_series(1,569) i
  ) insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,attempt_count,max_attempts,
    available_at,lease_fence,last_error_code,safe_error_detail,
    processor_version,payload,result,completed_at
  ) select job_id,'sample-link-job:'||i,$1,'gmail',$2,
    'gmail_resolve_entity_links',observation_id,'sample-message-'||i,
    'succeeded',1,5,clock_timestamp(),1,'','',
    'truth-link-worker-v1',jsonb_build_object('schemaVersion','fixture-link-job-v1'),
    jsonb_build_object('schemaVersion','truth-link-worker-result-v1','proposalCount',
      case when i<=378 then 2 else 1 end),clock_timestamp()
  from generated`, [WORKSPACE, CONNECTION]);
  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select job.job_id,job.workspace_key,job.source_system,job.connection_key,
    $1::uuid,null,job.job_id,947,'947'
  from public.source_processing_jobs job
  where job.workspace_key=$2 and job.connection_key=$3
    and job.job_kind='gmail_resolve_entity_links'`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with canonical as (
    select jsonb_build_object(
      'schemaVersion','gmail-parse-processing-epoch-v1',
      'workspaceKey',$2::text,'connectionKey',$3::text,
      'genesisRootBatchId',$1::uuid
    ) value
  ), hashed as (
    select value,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from canonical
  ) insert into public.gmail_parse_processing_epochs(
    workspace_key,connection_key,epoch_id,genesis_root_batch_id,
    genesis_source_cursor_version,genesis_source_cursor_value,
    legacy_batch_count,legacy_batch_manifest_hash,genesis_route_seal_id,
    genesis_route_seal_hash,canonical_epoch,epoch_hash,schema_version
  ) select $2,$3,'gmail-parse-processing-epoch:v1:'||hash,$1::uuid,
    947,'947',0,repeat('0',64),'fixture-route-seal',repeat('1',64),
    value,hash,'gmail-parse-processing-epoch-v1' from hashed`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
  await db.query(`with epoch as (
    select * from public.gmail_parse_processing_epochs
    where workspace_key=$2 and connection_key=$3
  ), canonical as (
    select epoch.epoch_id,epoch.epoch_hash,jsonb_build_object(
      'schemaVersion','gmail-parse-checkpoint-v1',
      'workspaceKey',$2::text,'connectionKey',$3::text,
      'rootBatchId',$1::uuid,'memberCount',569
    ) value from epoch
  ), hashed as (
    select epoch_id,epoch_hash,value,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from canonical
  ) insert into public.gmail_parse_checkpoints(
    workspace_key,root_batch_id,checkpoint_id,connection_key,
    processing_epoch_id,processing_epoch_hash,source_cursor_version,
    source_cursor_value,source_delta_hash,member_manifest_hash,
    member_count,terminal_gap_count,cumulative_member_count,
    cumulative_terminal_gap_count,cumulative_resolved_terminal_gap_count,
    cumulative_open_terminal_gap_count,cumulative_batch_count,
    cumulative_gap_count,cumulative_reconciled_gap_count,
    cumulative_open_gap_count,accumulator_hash,canonical_checkpoint,
    checkpoint_hash,schema_version
  ) select $2,$1::uuid,'gmail-parse-checkpoint:v1:'||hash,$3,
    epoch_id,epoch_hash,947,'947',repeat('2',64),repeat('3',64),
    569,0,569,0,0,0,1,0,0,0,repeat('4',64),value,hash,
    'gmail-parse-checkpoint-v1' from hashed`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with checkpoint as (
    select * from public.gmail_parse_checkpoints
    where workspace_key=$2 and root_batch_id=$1::uuid
  ), canonical as (
    select checkpoint.checkpoint_id,checkpoint.checkpoint_hash,jsonb_build_object(
      'schemaVersion','gmail-link-epoch-v1','workspaceKey',$2::text,
      'connectionKey',$3::text,'rootBatchId',$1::uuid,
      'parseCheckpointId',checkpoint.checkpoint_id,
      'parseCheckpointHash',checkpoint.checkpoint_hash,
      'predecessor',null,'policyVersion','gmail-link-epoch-policy-v1'
    ) value from checkpoint
  ), hashed as (
    select checkpoint_id,checkpoint_hash,value,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from canonical
  ) insert into public.truth_gmail_link_epochs(
    workspace_key,root_batch_id,connection_key,parse_checkpoint_id,
    parse_checkpoint_hash,epoch_id,canonical_epoch,epoch_hash,schema_version
  ) select $2,$1::uuid,$3,checkpoint_id,
    checkpoint_hash,'gmail-link-epoch:v1:'||hash,value,hash,
    'gmail-link-epoch-v1' from hashed`, [ROOT_BATCH, WORKSPACE, CONNECTION]);
  await db.query(`with epoch as (
    select * from public.truth_gmail_link_epochs
    where workspace_key=$2 and root_batch_id=$1::uuid
  ), rows as (
    select epoch.epoch_id,job.job_id,job.observation_id,observation.content_hash,
      jsonb_build_object(
        'schemaVersion','gmail-link-epoch-member-v1','workspaceKey',$2::text,
        'epochId',epoch.epoch_id,'linkJobId',job.job_id,
        'observationId',job.observation_id,
        'observationContentHash',observation.content_hash
      ) canonical
    from epoch
    join public.source_processing_jobs job
      on job.workspace_key=$2 and job.connection_key=$3
     and job.job_kind='gmail_resolve_entity_links'
    join public.source_observations observation
      on observation.workspace_key=job.workspace_key
     and observation.observation_id=job.observation_id
  ), hashed as (
    select rows.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(canonical),'UTF8'
    ),'sha256'),'hex') hash from rows
  ) insert into public.truth_gmail_link_epoch_members(
    workspace_key,epoch_id,link_job_id,observation_id,
    observation_content_hash,member_id,canonical_member,member_hash,
    schema_version
  ) select $2,epoch_id,job_id,observation_id,content_hash,
    'gmail-link-epoch-member:v1:'||hash,canonical,hash,
    'gmail-link-epoch-member-v1' from hashed`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);

  await db.query(`with jobs as (
    select job.*,row_number() over(order by job.job_id)::integer i
    from public.source_processing_jobs job
    where job.workspace_key=$2 and job.connection_key=$3
      and job.job_kind='gmail_resolve_entity_links'
  ), canonical as (
    select jobs.*,jsonb_build_object(
      'schemaVersion','truth-link-resolution-v1','workspaceKey',$2::text,
      'jobId',job_id,'anchorObservationId',observation_id,
      'rootBatchId',$1::uuid,'proposalCount',case when i<=378 then 2 else 1 end
    ) value from jobs
  ), hashed as (
    select canonical.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from canonical
  ) insert into public.truth_link_resolution_runs(
    resolution_run_id,workspace_key,job_id,anchor_observation_id,
    root_batch_id,source_cursor_version,source_cursor_value,linker_version,
    input_manifest_hash,linker_output_hash,context_observation_count,
    proposal_count,resolution_hash,resolution_schema_version,
    canonical_resolution
  ) select 'link-resolution:v1:'||hash,$2,job_id,observation_id,
    $1::uuid,947,'947','gmail-cross-thread-linker-v1',repeat('5',64),
    repeat('6',64),1,case when i<=378 then 2 else 1 end,hash,
    'truth-link-resolution-v1',value from hashed`,
  [ROOT_BATCH, WORKSPACE, CONNECTION]);
  await db.query(`insert into public.truth_link_resolution_context(
    resolution_run_id,observation_id,observation_content_hash,ordinal
  ) select run.resolution_run_id,run.anchor_observation_id,observation.content_hash,0
  from public.truth_link_resolution_runs run
  join public.source_observations observation
    on observation.workspace_key=run.workspace_key
   and observation.observation_id=run.anchor_observation_id
  where run.workspace_key=$1 and run.root_batch_id=$2::uuid`,
  [WORKSPACE, ROOT_BATCH]);

  await db.query(`with generated as (
    select p,
      case when p<=756 then ((p+1)/2)::integer else 378+(p-756) end job_i,
      case (p%3)
        when 0 then jsonb_build_object('entityType','shipment','relationship','mentions','reasonCode','sample_shipment_mention')
        when 1 then jsonb_build_object('entityType','broker','relationship','applies_to','reasonCode','sample_broker_application')
        else jsonb_build_object('entityType','gmail_thread','relationship','context_for','reasonCode','sample_thread_context')
      end stratum
    from generate_series(1,947) p
  ), joined as (
    select generated.*,run.resolution_run_id,run.resolution_hash,
      run.anchor_observation_id,observation.content_hash,
      'candidate-link:v1:'||encode(extensions.digest(convert_to(
        'sample-candidate-'||p,'UTF8'
      ),'sha256'),'hex') candidate_key
    from generated
    join public.source_processing_jobs job
      on job.job_id=('50000000-0000-4000-8000-'||lpad(job_i::text,12,'0'))::uuid
    join public.truth_link_resolution_runs run on run.job_id=job.job_id
    join public.source_observations observation
      on observation.observation_id=run.anchor_observation_id
  ), candidate as (
    select joined.*,jsonb_build_object(
      'candidateKind','entity_link','candidateKey',candidate_key,
      'parentCandidateKey','','method','deterministic',
      'autoAcceptEligible',true,'requiresReview',true,
      'evidenceObservationIds',jsonb_build_array(anchor_observation_id),
      'proposal',jsonb_build_object(
        'candidateLinkId',candidate_key,
        'linkKey','entity-link:v1:'||encode(extensions.digest(convert_to(
          'sample-link-'||p,'UTF8'
        ),'sha256'),'hex'),
        'versionNo',1,'previousLinkVersionId',null,
        'observationId',anchor_observation_id,
        'entityType',stratum->>'entityType',
        'entityKey','sample-entity-'||p,
        'relationship',stratum->>'relationship','decision','linked',
        'confidence',0.99,'linkMethod','deterministic',
        'linkerVersion','gmail-cross-thread-linker-v1',
        'evidenceSpan',jsonb_build_object('field','body','start',0,'end',10),
        'recordedAt','2026-07-10T12:00:00Z',
        'schemaVersion','observation-entity-link-v1',
        'reasonCode',stratum->>'reasonCode','candidateStatus','proposed',
        'autoAcceptEligible',true
      ),
      'assessment',jsonb_build_object(
        'policyDisposition','review','policyClass','operator_review_required',
        'conflict',false,'membershipChange',false,
        'reasons',jsonb_build_array('outside the original narrow auto-link policy')
      )
    ) item
    from joined
  ), envelope as (
    select candidate.*,jsonb_build_object(
      'proposalSchemaVersion','truth-link-candidate-proposal-v1',
      'workspaceKey',$1::text,'resolutionRunId',resolution_run_id,
      'resolutionItemHash',resolution_hash,'candidate',item
    ) canonical
    from candidate
  ), hashed as (
    select envelope.*,encode(extensions.digest(convert_to(
      canonical::text,'UTF8'
    ),'sha256'),'hex') proposal_hash
    from envelope
  ), inserted as (
    insert into public.truth_link_candidate_proposals(
      proposal_id,resolution_run_id,workspace_key,candidate_kind,candidate_key,
      parent_candidate_key,proposal_method,auto_accept_eligible,
      requires_review,policy_disposition,policy_class,has_conflict,
      membership_change,proposal_hash,proposal_schema_version,
      canonical_proposal
    ) select 'link-proposal:v1:'||proposal_hash,resolution_run_id,$1,
      'entity_link',candidate_key,'','deterministic',true,true,'review',
      'operator_review_required',false,false,proposal_hash,
      'truth-link-candidate-proposal-v1',canonical from hashed
    returning proposal_id,proposal_hash,resolution_run_id,canonical_proposal
  ), decision_canonical as (
    select inserted.*,jsonb_build_object(
      'decisionSchemaVersion','truth-link-candidate-decision-v1',
      'workspaceKey',$1::text,'proposalId',proposal_id,
      'proposalItemHash',proposal_hash,
      'decision',jsonb_build_object(
        'decisionNo',1,'previousDecisionVersionId','','decision','review',
        'method','policy','policyVersion','truth-link-policy-v1',
        'decidedBy','truth-link-worker-v1',
        'reasons',jsonb_build_array('outside the original narrow auto-link policy'),
        'acceptedItemRequest',null
      )
    ) value from inserted
  ), decision_hashed as (
    select decision_canonical.*,encode(extensions.digest(convert_to(
      value::text,'UTF8'
    ),'sha256'),'hex') decision_hash from decision_canonical
  ), decisions as (
    insert into public.truth_link_candidate_decisions(
      decision_version_id,proposal_id,decision_no,
      previous_decision_version_id,decision,decision_method,policy_version,
      decided_by,reasons,accepted_item_request,decision_hash,
      decision_schema_version,canonical_decision
    ) select 'link-decision:v1:'||decision_hash,proposal_id,1,null,'review',
      'policy','truth-link-policy-v1','truth-link-worker-v1',
      jsonb_build_array('outside the original narrow auto-link policy'),null,
      decision_hash,'truth-link-candidate-decision-v1',value
    from decision_hashed returning proposal_id
  ) insert into public.truth_link_candidate_evidence(
    proposal_id,observation_id,ordinal
  ) select inserted.proposal_id,run.anchor_observation_id,0
  from inserted join decisions using(proposal_id)
  join public.truth_link_resolution_runs run
    on run.resolution_run_id=inserted.resolution_run_id`, [WORKSPACE]);

  await db.query(`with epoch as (
    select * from public.truth_gmail_link_epochs
    where workspace_key=$2 and root_batch_id=$1::uuid
  ), canonical as (
    select epoch.epoch_id,jsonb_build_object(
      'schemaVersion','gmail-link-epoch-seal-v1','workspaceKey',$2::text,
      'epochId',epoch.epoch_id,'epochHash',epoch.epoch_hash,
      'linkManifestHash',repeat('7',64),'linkMemberCount',569
    ) value from epoch
  ), hashed as (
    select epoch_id,value,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from canonical
  ) insert into public.truth_gmail_link_epoch_seals(
    workspace_key,epoch_id,link_manifest_hash,link_member_count,
    seal_id,canonical_seal,seal_hash,schema_version
  ) select $2,epoch_id,repeat('7',64),569,
    'gmail-link-epoch-seal:v1:'||hash,value,hash,
    'gmail-link-epoch-seal-v1' from hashed`, [ROOT_BATCH, WORKSPACE]);

  const gap = (await one(db, `select private.truth_review_gaps_for_source_cut(
    $1,jsonb_build_array(jsonb_build_object(
      'sourceSystem','gmail','connectionKey',$2::text,'throughCursorVersion',947
    ))
  ) as gaps`, [WORKSPACE, CONNECTION])).gaps;
  assert.equal(gap.length, 1);
  assert.equal(gap[0].gapType, "LINK_WORKGROUP_REVIEW_PENDING");
  assert.equal(gap[0].count, 947);
  const gapWitness = gap[0].witnessHash;
  await db.query(`with cut_manifest as (
    select jsonb_build_object(
      'schemaVersion','source-cut-v2','workspaceKey',$2::text,
      'sourceSystem','gmail','connectionKey',$3::text,
      'rootBatchId',$1::uuid,'completeness','degraded'
    ) value
  ), cut_hashed as (
    select value,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(value),'UTF8'
    ),'sha256'),'hex') hash from cut_manifest
  ), cut_insert as (
    insert into public.source_cuts(
      source_cut_id,workspace_key,manifest_hash,manifest,completeness,
      required_sources,gaps,observation_count,manifest_schema_version,
      created_by
    ) select 'cut:v1:'||hash,$2,hash,value,'degraded',
      jsonb_build_array(jsonb_build_object(
        'sourceSystem','gmail','connectionKey',$3
      )),jsonb_build_array(jsonb_build_object(
        'gapType','LINK_WORKGROUP_REVIEW_PENDING','count',947,
        'witnessHash',$4::text
      )),569,'source-cut-v2','sample-fixture' from cut_hashed
    returning *
  ), acceptance_manifest as (
    select cut_insert.*,jsonb_build_array(jsonb_build_object(
      'epochId','fixture-accepted-epoch','receiptHash',repeat('8',64)
    )) value from cut_insert
  ), scoped as (
    select acceptance_manifest.*,
      encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(value),'UTF8'
      ),'sha256'),'hex') acceptance_hash,
      jsonb_build_object(
        'schemaVersion','truth-shadow-root-source-cut-v1',
        'workspaceKey',$2::text,'sourceSystem','gmail',
        'connectionKey',$3::text,'rootBatchId',$1::uuid,
        'sourceCutId',source_cut_id,'shadowOnly',true,
        'productionEligible',false,'productionPublicationAttempted',false
      ) scope
    from acceptance_manifest
  ), scope_hashed as (
    select scoped.*,encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(scope),'UTF8'
    ),'sha256'),'hex') scope_hash from scoped
  ) insert into public.truth_shadow_root_source_cuts(
    source_cut_id,scope_receipt_id,workspace_key,source_system,
    connection_key,root_batch_id,through_cursor_version,
    through_cursor_value,source_cut_manifest_hash,
    acceptance_epoch_manifest,acceptance_epoch_manifest_hash,
    canonical_scope_receipt,scope_receipt_hash,schema_version,
    shadow_only,production_eligible,production_publication_attempted
  ) select source_cut_id,'truth-shadow-root-source-cut:v1:'||scope_hash,
    $2,'gmail',$3,$1::uuid,947,'947',manifest_hash,value,acceptance_hash,
    scope,scope_hash,'truth-shadow-root-source-cut-v1',true,false,false
  from scope_hashed`, [ROOT_BATCH, WORKSPACE, CONNECTION, gapWitness]);
  return gap;
}

async function main() {
  assert.ok(MIGRATION_NAMES.includes(MIGRATION));
  assert.ok(MIGRATION_NAMES.indexOf(MIGRATION)
    < MIGRATION_NAMES.indexOf("20260717150000_truth_gmail_resumed_model_terminal_authority.sql"));
  const db = await createDatabase();
  try {
    const initialGap = await seedExactPopulation(db);
    const opened = await asService(db, async () => (await one(db, `select
      public.open_truth_shadow_link_sample_acceptance(
        $1,$2,$3::uuid,$4,$5
      ) as receipt`, [WORKSPACE, CONNECTION, ROOT_BATCH, REVIEW, SYNC])).receipt);
    assert.equal(opened.status, "opened");
    assert.equal(opened.populationCount, 947);
    assert.equal(opened.sampleCount, 64);
    assert.equal(opened.stratumCount, 3);
    assert.equal(opened.productionPublicationAttempted, false);
    const replayOpen = await asService(db, async () => (await one(db, `select
      public.open_truth_shadow_link_sample_acceptance(
        $1,$2,$3::uuid,$4,$5
      ) as receipt`, [WORKSPACE, CONNECTION, ROOT_BATCH, REVIEW, SYNC])).receipt);
    assert.equal(replayOpen.idempotent, true);
    assert.equal(replayOpen.planId, opened.planId);

    const sample = (await asService(db, async () => (await one(db, `select
      public.read_truth_shadow_link_sample_acceptance(
        $1,$2,0,10,$3,$4
      ) as receipt`, [WORKSPACE, opened.planId, REVIEW, SYNC])).receipt)).items;
    assert.equal(sample.length, 10);
    assert.equal(sample[0].evidence[0].observationContentHash.length, 64);
    await expectCode(asService(db, async () => one(db, `select
      public.resolve_truth_shadow_link_sample_review(
        $1,$2,$3,repeat('0',64),$4,'accept','fixture-operator',
        'Read immutable evidence in full and verified the proposed link.',
        'wrong_hash_sample_review_00000000000000000000000000000001',$5,$6
      ) as receipt`, [WORKSPACE, opened.planId, sample[0].proposalId,
        sample[0].expectedPreviousDecisionVersionId, REVIEW, SYNC])),
    "40001", "stale sample hash");

    const beforeAuthorization = await asService(db, async () => (await one(db, `select
      public.run_truth_shadow_link_sample_acceptance($1,$2,50,$3) as receipt`,
    [WORKSPACE, opened.planId, SYNC])).receipt);
    assert.equal(beforeAuthorization.reason, "SAMPLE_AUTHORIZATION_REQUIRED");
    assert.equal((await one(db, `select count(*)::integer count from
      public.truth_shadow_link_sample_acceptance_items where plan_id=$1`,
    [opened.planId])).count, 0);

    await db.exec("begin");
    try {
      const rejected = await asService(db, async () => (await one(db, `select
        public.resolve_truth_shadow_link_sample_review(
          $1,$2,$3,$4,$5,'reject','fixture-operator',
          'Read immutable evidence in full and found this sample link invalid.',
          'rejected_sample_review_0000000000000000000000000000001',$6,$7
        ) as receipt`, [WORKSPACE, opened.planId, sample[0].proposalId,
          sample[0].proposalHash, sample[0].expectedPreviousDecisionVersionId,
          REVIEW, SYNC])).receipt);
      assert.equal(rejected.decision, "reject");
      const refused = await asService(db, async () => (await one(db, `select
        public.authorize_truth_shadow_link_sample_acceptance(
          $1,$2,'fixture-operator',
          'Reviewed the committed sample and attest to the recorded decisions.',
          $3,$4
        ) as receipt`, [WORKSPACE, opened.planId, REVIEW, SYNC])).receipt);
      assert.equal(refused.reason, "SAMPLE_REJECTED");
      assert.equal((await one(db, `select count(*)::integer count from
        public.truth_shadow_link_sample_authorizations where plan_id=$1`,
      [opened.planId])).count, 0);
    } finally {
      await db.exec("rollback");
    }

    const sampleMembers = (await db.query(`select proposal_id,proposal_hash,
      initial_decision_version_id
      from public.truth_shadow_link_sample_acceptance_members
      where workspace_key=$1 and plan_id=$2 and is_sample
      order by sample_ordinal`, [WORKSPACE, opened.planId])).rows;
    assert.equal(sampleMembers.length, 64);
    const resolved = [];
    for (const member of sampleMembers) {
      const receipt = await asService(db, async () => (await one(db, `select
        public.resolve_truth_shadow_link_sample_review(
          $1,$2,$3,$4,$5,'accept','fixture-operator',
          'Read immutable evidence in full and verified the proposed deterministic link.',
          'accepted_sample_'||substr($4,1,64),$6,$7
        ) as receipt`, [WORKSPACE, opened.planId, member.proposal_id,
          member.proposal_hash, member.initial_decision_version_id,
          REVIEW, SYNC])).receipt);
      resolved.push(receipt);
    }
    assert.equal(resolved.length, 64);
    assert.ok(resolved.every((receipt) => receipt.decision === "accept"));
    const authorized = await asService(db, async () => (await one(db, `select
      public.authorize_truth_shadow_link_sample_acceptance(
        $1,$2,'fixture-operator',
        'Personally reviewed every item in the committed stratified sample against immutable source evidence.',
        $3,$4
      ) as receipt`, [WORKSPACE, opened.planId, REVIEW, SYNC])).receipt);
    assert.equal(authorized.status, "authorized");

    let terminal;
    for (let round = 0; round < 20; round += 1) {
      terminal = await asService(db, async () => (await one(db, `select
        public.run_truth_shadow_link_sample_acceptance($1,$2,50,$3) as receipt`,
      [WORKSPACE, opened.planId, SYNC])).receipt);
      if (terminal.status === "succeeded") break;
    }
    assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
    assert.equal(terminal.operatorSampleAcceptanceCount, 64);
    assert.equal(terminal.sampledPolicyAcceptanceCount, 883);
    const finalCounts = await one(db, `select
      (select count(*)::integer from public.truth_link_candidate_decisions
       where decision_no=2) decision_twos,
      (select count(*)::integer from public.truth_link_candidate_decisions
       where decision_no=2 and decision_method='operator') operator_decisions,
      (select count(*)::integer from public.truth_link_candidate_decisions
       where decision_no=2 and decision_method='policy'
         and policy_version='truth-shadow-deterministic-link-sampled-acceptance-v1') policy_decisions,
      (select count(*)::integer from public.observation_entity_links) links,
      (select count(*)::integer from public.truth_link_acceptance_bindings) bindings,
      (select count(*)::integer from public.truth_shadow_link_sample_acceptance_items) authority_items,
      (select count(*)::integer from public.truth_review_resolutions) review_resolutions,
      (select count(*)::integer from public.truth_shadow_link_sample_acceptance_seals) seals,
      (select count(*)::integer from public.truth_builds) builds,
      (select count(*)::integer from public.truth_publications) publications`);
    assert.deepEqual(finalCounts, {
      decision_twos: 947,
      operator_decisions: 64,
      policy_decisions: 883,
      links: 947,
      bindings: 947,
      authority_items: 947,
      review_resolutions: 64,
      seals: 1,
      builds: 0,
      publications: 0,
    });
    const finalGap = (await one(db, `select private.truth_review_gaps_for_source_cut(
      $1,jsonb_build_array(jsonb_build_object(
        'sourceSystem','gmail','connectionKey',$2::text,'throughCursorVersion',947
      ))
    ) as gaps`, [WORKSPACE, CONNECTION])).gaps;
    assert.deepEqual(finalGap, []);
    const fingerprint = await one(db, `select
      (select plan_hash from public.truth_shadow_link_sample_acceptance_plans) plan_hash,
      (select authorization_hash from public.truth_shadow_link_sample_authorizations) authorization_hash,
      (select seal_hash from public.truth_shadow_link_sample_acceptance_seals) seal_hash,
      encode(extensions.digest(convert_to(string_agg(item_id,',' order by ordinal),'UTF8'),'sha256'),'hex') item_fingerprint
      from public.truth_shadow_link_sample_acceptance_items`);
    const replay = await asService(db, async () => (await one(db, `select
      public.run_truth_shadow_link_sample_acceptance($1,$2,50,$3) as receipt`,
    [WORKSPACE, opened.planId, SYNC])).receipt);
    assert.equal(replay.idempotent, true);
    await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, MIGRATION), "utf8"));
    const replayFingerprint = await one(db, `select
      (select plan_hash from public.truth_shadow_link_sample_acceptance_plans) plan_hash,
      (select authorization_hash from public.truth_shadow_link_sample_authorizations) authorization_hash,
      (select seal_hash from public.truth_shadow_link_sample_acceptance_seals) seal_hash,
      encode(extensions.digest(convert_to(string_agg(item_id,',' order by ordinal),'UTF8'),'sha256'),'hex') item_fingerprint
      from public.truth_shadow_link_sample_acceptance_items`);
    assert.deepEqual(replayFingerprint, fingerprint);
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-shadow-link-sample-acceptance",
      initialGap: initialGap[0],
      planId: opened.planId,
      populationCount: 947,
      sampleCount: 64,
      stratumCount: 3,
      operatorDecisionCount: 64,
      sampledPolicyDecisionCount: 883,
      finalGapCount: finalGap.length,
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

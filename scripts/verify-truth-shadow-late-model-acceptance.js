#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION = "20260717160000_truth_shadow_late_model_acceptance_runtime.sql";
const TERMINAL_FIXTURE = path.join(
  __dirname,
  "verify-truth-gmail-resumed-model-terminal-authority.js",
);
const WORKSPACE = "primary";
const CONNECTION = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";
const SYNC = "truth-resumed-model-terminal-authority-sync-token-v1";
const REVIEW = "truth-shadow-late-model-acceptance-review-token-v1";
const POLICY = "truth-shadow-model-commissioning-review-v1";

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

async function expectState(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${label}: ${error?.message || error}`);
    return true;
  }, label);
}

function loadTerminalFixture() {
  const upstreamSource = fs.readFileSync(TERMINAL_FIXTURE, "utf8")
    .replaceAll(
      "truth-shadow-claim-acceptance-epoch-v1",
      "truth-shadow-claim-acceptance-epoch-v2",
    )
    .replaceAll("truth-model-wire-v1", "openai-responses-gmail-v1");
  const legacyMembershipSeed =
    "repeat('4',64),repeat('5',64),repeat('6',64),0,0,1";
  const exactMembershipSeed = `encode(extensions.digest(convert_to(
      private.truth_canonical_json_text('[]'::jsonb),'UTF8'
    ),'sha256'),'hex'),encode(extensions.digest(convert_to(
      private.truth_canonical_json_text('[]'::jsonb),'UTF8'
    ),'sha256'),'hex'),encode(extensions.digest(convert_to(
      private.truth_canonical_json_text(jsonb_build_array(jsonb_build_object(
        'observationId',observation_id,'contentHash',content_hash
      ))),'UTF8'
    ),'sha256'),'hex'),0,0,1`;
  const source = upstreamSource.replace(legacyMembershipSeed, exactMembershipSeed);
  assert.notEqual(source, upstreamSource,
    "terminal-authority context membership fixture changed unexpectedly");
  const marker = "main().catch((error) => {";
  const markerIndex = source.lastIndexOf(marker);
  assert.ok(markerIndex > 0, "terminal-authority verifier entry point changed");
  const fixtureSource = `${source.slice(0, markerIndex)}module.exports = {
    createDatabase,
    seedScope,
    seedPlansAndParentManifests,
    seedRetryAuthoritiesAndChildren,
    seedCertifiedEpoch,
  };\n`;
  const fixtureModule = new Module(TERMINAL_FIXTURE, module);
  fixtureModule.filename = TERMINAL_FIXTURE;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(TERMINAL_FIXTURE));
  fixtureModule._compile(fixtureSource, TERMINAL_FIXTURE);
  return fixtureModule.exports;
}

async function seedReviewToken(db) {
  await db.query(`insert into public.sync_tokens(token_name,token_hash) values(
    'truth_review_decider',encode(extensions.digest(convert_to(
      $1::text,'UTF8'
    ),'sha256'),'hex')) on conflict(token_name) do update set token_hash=excluded.token_hash`, [REVIEW]);
}

async function terminalizeStaleReviews(db) {
  await db.exec("alter table public.source_processing_jobs disable trigger user");
  try {
    await db.query(`with authorized as (
      select row_number() over(order by authority.model_child_job_id)::integer ordinal,
        authority.*
      from public.truth_shadow_gmail_resumed_model_child_authorizations authority
      where authority.workspace_key=$1 and authority.connection_key=$2
        and authority.root_batch_id=$3::uuid
        and authority.disposition='stale_time_binding_review'
    ) insert into public.source_processing_jobs(
      job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,attempt_count,max_attempts,
      available_at,lease_owner,lease_fence,lease_expires_at,last_error_code,
      safe_error_detail,processor_version,payload,result,completed_at
    ) select ('64000000-0000-4000-8000-'||lpad(ordinal::text,12,'0'))::uuid,
      'late-model-review:'||authorization_id,$1,'gmail',$2,
      'gmail_review_model_extraction',source_observation_id,
      'late-model-review-'||ordinal,'waiting_runtime',0,5,clock_timestamp(),null,0,
      null,'GMAIL_MODEL_RUNTIME_DISABLED',
      'The local shadow rollout permits only explicitly commissioned model execution.',
      '',jsonb_build_object(
        'schemaVersion','gmail-model-review-job-v1','modelChildJobId',model_child_job_id,
        'modelPlanId',model_plan_id
      ),'{}'::jsonb,null
    from authorized`, [WORKSPACE, CONNECTION, ROOT_BATCH]);
  } finally {
    await db.exec("alter table public.source_processing_jobs enable trigger user");
  }

  await db.query(`insert into public.source_processing_job_lineage(
    job_id,workspace_key,source_system,connection_key,root_batch_id,
    parent_job_id,root_job_id,source_cursor_version,source_cursor_value
  ) select review_job.job_id,authority.workspace_key,'gmail',authority.connection_key,
    authority.root_batch_id,authority.model_child_job_id,child_lineage.root_job_id,
    child_lineage.source_cursor_version,child_lineage.source_cursor_value
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.source_processing_jobs review_job
    on review_job.workspace_key=authority.workspace_key
   and review_job.dedupe_key='late-model-review:'||authority.authorization_id
  join public.source_processing_job_lineage child_lineage
    on child_lineage.workspace_key=authority.workspace_key
   and child_lineage.job_id=authority.model_child_job_id
  where authority.workspace_key=$1 and authority.connection_key=$2
    and authority.root_batch_id=$3::uuid
    and authority.disposition='stale_time_binding_review'`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);
  await db.query(`insert into public.source_processing_job_children(
    parent_job_id,child_job_id,ordinal
  ) select authority.model_child_job_id,review_job.job_id,0
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.source_processing_jobs review_job
    on review_job.workspace_key=authority.workspace_key
   and review_job.dedupe_key='late-model-review:'||authority.authorization_id
  where authority.workspace_key=$1 and authority.connection_key=$2
    and authority.root_batch_id=$3::uuid
    and authority.disposition='stale_time_binding_review'`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);

  await db.query(`with authorized as (
    select row_number() over(order by authority.model_child_job_id)::integer ordinal,
      authority.*
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.root_batch_id=$3::uuid
      and authority.disposition='stale_time_binding_review'
  ), bodies as (
    select authorized.*,jsonb_build_object(
      'schemaVersion','gmail-model-extraction-review-intent-v1',
      'workspaceKey',workspace_key,'extractionPlanId',extraction_plan_id,
      'modelPlanId',model_plan_id,'modelChildJobId',model_child_job_id,
      'reasonCode','STALE_IMMUTABLE_SOURCE_TIME_BINDING',
      'safeDetailHash',authorization_hash,
      'authorityKind','shadow_stale_source_time_binding_authority',
      'authorityId',authorization_id,'authorityHash',authorization_hash
    ) canonical from authorized
  ), hashed as (
    select bodies.*,encode(extensions.digest(convert_to(canonical::text,'UTF8'),
      'sha256'),'hex') intent_hash from bodies
  ) insert into public.gmail_model_extraction_review_intents(
    intent_id,workspace_key,extraction_plan_id,model_plan_id,model_child_job_id,
    reason_code,safe_detail_hash,authority_kind,authority_id,authority_hash,
    canonical_intent,intent_hash,schema_version
  ) select 'gmail-model-review-intent:v1:'||intent_hash,workspace_key,
    extraction_plan_id,model_plan_id,model_child_job_id,
    'STALE_IMMUTABLE_SOURCE_TIME_BINDING',authorization_hash,
    'shadow_stale_source_time_binding_authority',authorization_id,
    authorization_hash,canonical,intent_hash,
    'gmail-model-extraction-review-intent-v1' from hashed`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);

  await db.query(`with authorized as (
    select row_number() over(order by authority.model_child_job_id)::integer ordinal,
      authority.*
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.root_batch_id=$3::uuid
      and authority.disposition='stale_time_binding_review'
  ), bodies as (
    select authorized.*,('64000000-0000-4000-8000-'||
      lpad(ordinal::text,12,'0'))::uuid review_job_id,
      jsonb_build_object(
        'schemaVersion','gmail-model-extraction-review-obligation-v1',
        'workspaceKey',workspace_key,'extractionPlanId',extraction_plan_id,
        'modelPlanId',model_plan_id,'modelChildJobId',model_child_job_id,
        'reviewJobId',('64000000-0000-4000-8000-'||
          lpad(ordinal::text,12,'0'))::uuid,
        'reasonCode','STALE_IMMUTABLE_SOURCE_TIME_BINDING',
        'safeDetailHash',authorization_hash
      ) canonical
    from authorized
  ), hashed as (
    select bodies.*,encode(extensions.digest(convert_to(canonical::text,'UTF8'),
      'sha256'),'hex') obligation_hash from bodies
  ) insert into public.gmail_model_extraction_review_obligations(
    obligation_id,workspace_key,extraction_plan_id,model_plan_id,
    model_child_job_id,review_job_id,reason_code,safe_detail_hash,
    canonical_obligation,obligation_hash,schema_version
  ) select 'gmail-model-review:v1:'||obligation_hash,workspace_key,
    extraction_plan_id,model_plan_id,model_child_job_id,review_job_id,
    'STALE_IMMUTABLE_SOURCE_TIME_BINDING',authorization_hash,canonical,
    obligation_hash,'gmail-model-extraction-review-obligation-v1' from hashed`,
  [WORKSPACE, CONNECTION, ROOT_BATCH]);

  await db.exec("alter table public.source_processing_jobs disable trigger user");
  try {
    await db.query(`update public.source_processing_jobs child set
      state='succeeded',lease_owner=null,lease_expires_at=null,
      last_error_code='',safe_error_detail='',completed_at=clock_timestamp(),
      result=jsonb_build_object(
        'schemaVersion','truth-model-extraction-worker-result-v1',
        'processorVersion','truth-gmail-model-worker-v1',
        'jobKind','gmail_extract_message_model_claims',
        'sourceObservationId',authority.source_observation_id,
        'modelPlanId',authority.model_plan_id,'executionMode','sync',
        'outcome','review_required',
        'reviewReason','STALE_IMMUTABLE_SOURCE_TIME_BINDING',
        'safeDetailHash',authority.authorization_hash,
        'modelRequestId','','candidateCount',0,
        'modelTerminal',jsonb_build_object(
          'terminalKind','review_intent','reviewIntentId',intent.intent_id,
          'reviewIntentHash',intent.intent_hash
        )
      )
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_review_intents intent
      on intent.workspace_key=authority.workspace_key
     and intent.model_child_job_id=authority.model_child_job_id
    where child.workspace_key=authority.workspace_key
      and child.job_id=authority.model_child_job_id
      and authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='stale_time_binding_review'`,
    [WORKSPACE, CONNECTION]);
  } finally {
    await db.exec("alter table public.source_processing_jobs enable trigger user");
  }

  const reviews = (await db.query(`select authority.authorization_id,
    obligation.obligation_id,obligation.review_job_id
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.gmail_model_extraction_review_obligations obligation
    on obligation.workspace_key=authority.workspace_key
   and obligation.model_child_job_id=authority.model_child_job_id
  where authority.workspace_key=$1 and authority.connection_key=$2
    and authority.root_batch_id=$3::uuid
    and authority.disposition='stale_time_binding_review'
  order by authority.authorization_id`,
  [WORKSPACE, CONNECTION, ROOT_BATCH])).rows;
  assert.equal(reviews.length, 7);
  await db.exec("alter table public.source_processing_job_children disable trigger user");
  try {
    const tamperedEdge = await one(db, `delete from public.source_processing_job_children
      where parent_job_id=(select model_child_job_id
        from public.truth_shadow_gmail_resumed_model_child_authorizations
        where authorization_id=$1)
        and child_job_id=$2::uuid
      returning parent_job_id,child_job_id,ordinal`,
    [reviews[0].authorization_id, reviews[0].review_job_id]);
    await expectState(asService(db, async () => one(db, `select
      public.resolve_gmail_model_extraction_review(
        $1,$2,'reviewed_no_additional_claims','[]'::jsonb,
        'operator:late-model-fixture',$3,$4,$5,$6
      ) receipt`, [WORKSPACE, reviews[0].obligation_id,
      "Read stale-bound source in full; no additional claim.",
      "late_model_tampered_edge_00000001", REVIEW, SYNC])), "40001",
    "late review without its immutable child edge");
    await db.query(`insert into public.source_processing_job_children(
      parent_job_id,child_job_id,ordinal
    ) values($1::uuid,$2::uuid,$3::integer)`,
    [tamperedEdge.parent_job_id, tamperedEdge.child_job_id, tamperedEdge.ordinal]);
  } finally {
    await db.exec("alter table public.source_processing_job_children enable trigger user");
  }

  for (const [index, review] of reviews.entries()) {
    const receipt = await asService(db, async () => (await one(db, `select
      public.resolve_gmail_model_extraction_review(
        $1,$2,'reviewed_no_additional_claims','[]'::jsonb,
        'operator:late-model-fixture',$3,$4,$5,$6
      ) receipt`, [WORKSPACE, review.obligation_id,
      `Read stale-bound source ${index + 1} in full; no additional claim.`,
      `late_model_stale_review_${String(index + 1).padStart(8, "0")}`,
      REVIEW, SYNC])).receipt);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.decision, "reviewed_no_additional_claims");
    assert.equal(receipt.reviewJobId, review.review_job_id);
    assert.equal(receipt.publishesTruth, false);
    assert.equal(receipt.lateModelReviewAuthorityVerified, true);
    assert.equal(receipt.lateReviewJobId, review.review_job_id);
    assert.equal(receipt.productionPublicationAttempted, false);
  }

  const replayedReview = await asService(db, async () => (await one(db, `select
    public.resolve_gmail_model_extraction_review(
      $1,$2,'reviewed_no_additional_claims','[]'::jsonb,
      'operator:late-model-fixture',$3,$4,$5,$6
    ) receipt`, [WORKSPACE, reviews[0].obligation_id,
    "Read stale-bound source 1 in full; no additional claim.",
    "late_model_stale_review_00000001", REVIEW, SYNC])).receipt);
  assert.equal(replayedReview.ok, true);
  assert.equal(replayedReview.idempotent, true);
  assert.equal(replayedReview.lateModelReviewAuthorityVerified, true);
  assert.equal(replayedReview.productionPublicationAttempted, false);

  const resolutionProof = await one(db, `select
    count(*)::integer resolved,
    count(*) filter(where review_job.state='succeeded'
      and review_job.completed_at is not null
      and review_job.result->>'resolutionId'=resolution.resolution_id
      and review_job.result->>'receiptHash'=resolution.receipt_hash)::integer terminal,
    count(*) filter(where resolution.decision='reviewed_no_additional_claims'
      and jsonb_array_length(resolution.resolution_evidence_observation_ids)=0)::integer honest_no_claim
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.gmail_model_extraction_review_obligations obligation
    on obligation.workspace_key=authority.workspace_key
   and obligation.model_child_job_id=authority.model_child_job_id
  join public.gmail_model_extraction_review_resolutions resolution
    on resolution.workspace_key=obligation.workspace_key
   and resolution.obligation_id=obligation.obligation_id
  join public.source_processing_jobs review_job
    on review_job.workspace_key=obligation.workspace_key
   and review_job.job_id=obligation.review_job_id
  where authority.workspace_key=$1 and authority.connection_key=$2
    and authority.disposition='stale_time_binding_review'`,
  [WORKSPACE, CONNECTION]);
  assert.deepEqual(resolutionProof, {
    resolved: 7,
    terminal: 7,
    honest_no_claim: 7,
  });
}

async function terminalizeModelExecutions(db) {
  await db.exec("begin");
  try {
    await db.query(`with authorized as (
    select row_number() over(order by authority.model_child_job_id)::integer ordinal,
      authority.*,observation.source_object_id,observation.source_recorded_at
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_observations observation
      on observation.workspace_key=authority.workspace_key
     and observation.observation_id=authority.source_observation_id
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.root_batch_id=$3::uuid and authority.disposition='model_execution'
  ), candidates as (
    select authorized.*,jsonb_build_object(
      'schemaVersion','gmail-candidate-claim-v1',
      'claimKey','shipment:016'||lpad((70000000+ordinal)::text,8,'0')||':customs_release',
      'versionNo',1,'previousClaimVersionId','',
      'sourceObservationId',source_observation_id,
      'sourceObservationContentHash',source_observation_content_hash,
      'sourceObjectType','gmail_message_parsed','sourceObjectId',source_object_id,
      'sourceReviewRequired',true,'sourceExtractionMethod','gmail-model-extraction-v1',
      'sourceMessageId',source_object_id,'sourceThreadId','late-model-thread-'||ordinal,
      'sourceCapturedAt','2026-07-10T18:47:22.755Z',
      'subjectType','shipment','subjectKey','016'||lpad((70000000+ordinal)::text,8,'0'),
      'appliesToAwbs',jsonb_build_array('016'||lpad((70000000+ordinal)::text,8,'0')),
      'predicate','customs_release','gate','customs','polarity','positive',
      'normalizedValue',jsonb_build_object('status','released','effect','complete'),
      'occurredAt','2026-07-10T18:47:20.123Z','confidence',0.88,
      'confidenceLabel','medium','evidenceSpan',jsonb_build_object(
        'start',0,'end',11,'unit','utf16_code_units','quote','Operational'
      ),'extractionMethod','model','extractorVersion','gmail-claim-extractor-v4',
      'model','gpt-5-nano-2025-08-07','promptVersion','gmail-model-prompt-v1',
      'ambiguity',jsonb_build_object('status','review','reasons',jsonb_build_array(
        'model-derived fact requires operator review'
      )),'contradiction',jsonb_build_object('status','none',
        'acceptedClaimVersionIds',jsonb_build_array(),'reasons',jsonb_build_array()),
      'acceptanceRecommendation',jsonb_build_object(
        'decision','review','method','operator','policyVersion',$4::text,
        'reasons',jsonb_build_array('model-derived candidate requires operator review')
      )
    ) candidate_body from authorized
  ), envelopes as (
    select candidates.*,jsonb_build_object(
      'envelopeSchemaVersion','candidate-claim-envelope-v1',
      'workspaceKey',workspace_key,'candidate',candidate_body
    ) canonical from candidates
  ), hashed as (
    select envelopes.*,encode(extensions.digest(convert_to(canonical::text,'UTF8'),
      'sha256'),'hex') envelope_hash from envelopes
  ) insert into public.candidate_claim_envelopes(
    candidate_claim_version_id,workspace_key,source_observation_id,
    source_observation_content_hash,source_object_type,source_object_id,
    source_review_required,source_extraction_method,claim_key,version_no,
    previous_claim_version_id,extraction_method,recommendation,
    recommendation_policy_version,ambiguity_status,contradiction_status,
    envelope_hash,envelope_schema_version,extractor_candidate,canonical_envelope
  ) select 'candidate:v1:'||envelope_hash,workspace_key,source_observation_id,
    source_observation_content_hash,'gmail_message_parsed',source_object_id,true,
    'gmail-model-extraction-v1',candidate_body->>'claimKey',1,null,'model','review',
    $4,'review','none',envelope_hash,'candidate-claim-envelope-v1',candidate_body,
    canonical from hashed`, [WORKSPACE, CONNECTION, ROOT_BATCH, POLICY]);

    await db.query(`insert into public.candidate_claim_job_lineage(
    candidate_claim_version_id,job_id,source_observation_id
  ) select candidate.candidate_claim_version_id,authority.model_child_job_id,
    authority.source_observation_id
  from public.truth_shadow_gmail_resumed_model_child_authorizations authority
  join public.candidate_claim_envelopes candidate
    on candidate.workspace_key=authority.workspace_key
   and candidate.source_observation_id=authority.source_observation_id
  where authority.workspace_key=$1 and authority.connection_key=$2
    and authority.disposition='model_execution'`, [WORKSPACE, CONNECTION]);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }

  await db.query(`with bodies as (
    select authority.*,candidate.candidate_claim_version_id,candidate.envelope_hash,
      jsonb_build_object(
        'manifestSchemaVersion','candidate-claim-job-manifest-v1',
        'workspaceKey',authority.workspace_key,'jobId',authority.model_child_job_id,
        'sourceObservationId',authority.source_observation_id,'candidateCount',1,
        'candidates',jsonb_build_array(jsonb_build_object(
          'candidateClaimVersionId',candidate.candidate_claim_version_id,
          'itemHash',candidate.envelope_hash
        ))
      ) canonical
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.candidate_claim_envelopes candidate
      on candidate.workspace_key=authority.workspace_key
     and candidate.source_observation_id=authority.source_observation_id
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='model_execution'
  ), hashed as (
    select bodies.*,encode(extensions.digest(convert_to(canonical::text,'UTF8'),
      'sha256'),'hex') manifest_hash from bodies
  ) insert into public.candidate_claim_job_manifests(
    job_id,workspace_key,source_observation_id,candidate_count,manifest_hash,
    manifest_schema_version,canonical_manifest
  ) select model_child_job_id,workspace_key,source_observation_id,1,
    manifest_hash,'candidate-claim-job-manifest-v1',canonical from hashed`,
  [WORKSPACE, CONNECTION]);

  await db.query(`with authorized as (
    select row_number() over(order by authority.model_child_job_id)::integer ordinal,
      authority.*,plan.expected_request_payload,plan.expected_request_payload_text,
      plan.expected_request_payload_hash,plan.expected_request_payload_bytes,
      plan.expected_model_snapshot,plan.expected_max_output_tokens,
      plan.expected_response_schema_hash,plan.expected_processing_config_version,
      plan.expected_processing_config_hash,plan.prompt_version,
      plan.response_schema_version,plan.execution_mode,
      pricing.pricing_policy_id,pricing.policy_hash pricing_policy_hash
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_plans plan
      on plan.workspace_key=authority.workspace_key
     and plan.model_plan_id=authority.model_plan_id
    cross join lateral (
      select policy.pricing_policy_id,policy.policy_hash
      from public.truth_model_pricing_policies policy
      where policy.model_snapshot=plan.expected_model_snapshot
        and policy.transport=plan.execution_mode order by policy.pricing_policy_id limit 1
    ) pricing
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='model_execution'
  ) insert into public.truth_model_requests(
    request_id,workspace_key,logical_request_key,request_hash,source_job_id,
    observation_id,observation_content_hash,plan_hash,request_payload,
    request_payload_text,request_payload_hash,request_payload_bytes,model_snapshot,
    prompt_version,response_schema_version,response_schema_hash,
    processing_config_version,processing_config_hash,pricing_policy_id,
    pricing_policy_hash,transport,max_input_tokens,max_output_tokens,max_attempts,
    state,actual_input_tokens,actual_output_tokens,actual_total_tokens,
    actual_microusd,finalized_at
  ) select 'model-request:v1:'||encode(extensions.digest(convert_to(
      'late-model-request-'||ordinal,'UTF8'),'sha256'),'hex'),workspace_key,
    'late-model-request-'||ordinal,encode(extensions.digest(convert_to(
      'late-model-request-hash-'||ordinal,'UTF8'),'sha256'),'hex'),
    model_child_job_id,source_observation_id,source_observation_content_hash,
    model_plan_hash,expected_request_payload,expected_request_payload_text,
    expected_request_payload_hash,expected_request_payload_bytes,
    expected_model_snapshot,prompt_version,response_schema_version,
    expected_response_schema_hash,expected_processing_config_version,
    expected_processing_config_hash,pricing_policy_id,pricing_policy_hash,
    execution_mode,expected_request_payload_bytes,expected_max_output_tokens,
    case when execution_mode='sync' then 3 else 1 end,'succeeded',10,5,15,
    1,clock_timestamp() from authorized`, [WORKSPACE, CONNECTION]);

  await db.query(`with requests as (
    select row_number() over(order by request.request_id)::integer ordinal,request.*
    from public.truth_model_requests request
    where request.workspace_key=$1 and request.logical_request_key like 'late-model-request-%'
  ) insert into public.truth_model_sync_attempt_dispatches(
    dispatch_id,request_id,workspace_key,attempt_number,client_request_id,
    dispatch_hash,dispatched_at
  ) select 'model-dispatch:v1:'||encode(extensions.digest(convert_to(
    'late-model-dispatch-'||ordinal,'UTF8'),'sha256'),'hex'),request_id,
    workspace_key,1,'late-model-client-'||ordinal,
    encode(extensions.digest(convert_to('late-model-dispatch-hash-'||ordinal,
      'UTF8'),'sha256'),'hex'),clock_timestamp() from requests`, [WORKSPACE]);

  await db.query(`with dispatches as (
    select row_number() over(order by dispatch.dispatch_id)::integer ordinal,
      dispatch.*,jsonb_build_object(
        'schemaVersion','gmail-model-response-v1','claims',jsonb_build_array(
          jsonb_build_object('predicate','customs_release')
        )
      ) normalized
    from public.truth_model_sync_attempt_dispatches dispatch
    join public.truth_model_requests request on request.request_id=dispatch.request_id
    where request.workspace_key=$1 and request.logical_request_key like 'late-model-request-%'
  ) insert into public.truth_model_sync_attempt_outcomes(
    outcome_id,dispatch_id,request_id,workspace_key,attempt_number,outcome_hash,
    provider_result_hash,classification,request_sent,http_status,request_body_hash,
    request_body_bytes,provider_response_body_hash,provider_response_body_bytes,
    outcome_unknown,billing_outcome_unknown,provider_response_id,server_request_id,
    actual_model,normalized_result,normalized_result_hash,input_tokens,
    cached_input_tokens,output_tokens,reasoning_tokens,total_tokens,actual_microusd
  ) select 'model-outcome:v1:'||encode(extensions.digest(convert_to(
      'late-model-outcome-'||ordinal,'UTF8'),'sha256'),'hex'),dispatch_id,
    request_id,workspace_key,1,encode(extensions.digest(convert_to(
      'late-model-outcome-hash-'||ordinal,'UTF8'),'sha256'),'hex'),
    encode(extensions.digest(convert_to('late-provider-result-'||ordinal,
      'UTF8'),'sha256'),'hex'),'success',true,200,repeat('8',64),19,
    repeat('9',64),20,false,false,'late-provider-response-'||ordinal,
    'late-server-request-'||ordinal,'gpt-5-nano-2025-08-07',normalized,
    encode(extensions.digest(convert_to(normalized::text,'UTF8'),'sha256'),'hex'),
    10,0,5,0,15,1 from dispatches`, [WORKSPACE]);

  await db.query(`with rows as (
    select authority.*,request.request_id,outcome.outcome_id,
      outcome.provider_response_id,outcome.provider_result_hash,
      outcome.normalized_result_hash,manifest.manifest_hash,
      jsonb_build_object(
        'schemaVersion','gmail-model-extraction-result-v1',
        'workspaceKey',authority.workspace_key,'modelPlanId',authority.model_plan_id,
        'modelChildJobId',authority.model_child_job_id,
        'modelRequestId',request.request_id,'modelAttemptOutcomeId',outcome.outcome_id,
        'providerResponseId',outcome.provider_response_id,
        'providerResultHash',outcome.provider_result_hash,
        'normalizedResultHash',outcome.normalized_result_hash,
        'candidateManifestHash',manifest.manifest_hash,'candidateCount',1
      ) canonical
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.truth_model_requests request
      on request.workspace_key=authority.workspace_key
     and request.source_job_id=authority.model_child_job_id
    join public.truth_model_sync_attempt_outcomes outcome
      on outcome.workspace_key=request.workspace_key and outcome.request_id=request.request_id
    join public.candidate_claim_job_manifests manifest
      on manifest.workspace_key=authority.workspace_key
     and manifest.job_id=authority.model_child_job_id
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='model_execution'
  ), hashed as (
    select rows.*,encode(extensions.digest(convert_to(canonical::text,'UTF8'),
      'sha256'),'hex') result_hash from rows
  ) insert into public.gmail_model_extraction_results(
    result_id,workspace_key,model_plan_id,model_child_job_id,model_request_id,
    model_attempt_outcome_id,provider_response_id,provider_result_hash,
    normalized_result_hash,actual_model,derivation_algorithm_version,
    candidate_derivation_hash,candidate_manifest_hash,candidate_count,
    canonical_result,result_hash,schema_version
  ) select 'gmail-model-result:v1:'||result_hash,workspace_key,model_plan_id,
    model_child_job_id,request_id,outcome_id,provider_response_id,
    provider_result_hash,normalized_result_hash,'gpt-5-nano-2025-08-07',
    'gmail-model-candidate-derivation-v1',repeat('a',64),manifest_hash,1,
    canonical,result_hash,'gmail-model-extraction-result-v1' from hashed`,
  [WORKSPACE, CONNECTION]);

  await db.exec("alter table public.source_processing_jobs disable trigger user");
  try {
    await db.query(`update public.source_processing_jobs child set
      state='succeeded',lease_owner=null,lease_expires_at=null,
      last_error_code='',safe_error_detail='',completed_at=clock_timestamp(),
      result=jsonb_build_object(
        'schemaVersion','truth-model-extraction-worker-result-v1',
        'processorVersion','truth-gmail-model-worker-v1',
        'jobKind','gmail_extract_message_model_claims',
        'sourceObservationId',authority.source_observation_id,
        'modelPlanId',authority.model_plan_id,'executionMode','sync',
        'outcome','succeeded','modelRequestId',model_result.model_request_id,
        'providerResponseId',model_result.provider_response_id,
        'model','gpt-5-nano-2025-08-07','promptVersion','gmail-model-prompt-v1',
        'candidateCount',model_result.candidate_count,
        'candidateManifestHash',model_result.candidate_manifest_hash,
        'modelTerminal',jsonb_build_object(
          'terminalKind','successful_result','resultId',model_result.result_id,
          'resultHash',model_result.result_hash,
          'candidateManifestHash',model_result.candidate_manifest_hash,
          'candidateCount',model_result.candidate_count
        )
      )
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.gmail_model_extraction_results model_result
      on model_result.workspace_key=authority.workspace_key
     and model_result.model_child_job_id=authority.model_child_job_id
    where child.workspace_key=authority.workspace_key
      and child.job_id=authority.model_child_job_id
      and authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='model_execution'`, [WORKSPACE, CONNECTION]);
  } finally {
    await db.exec("alter table public.source_processing_jobs enable trigger user");
  }

  const candidates = (await db.query(`select candidate.candidate_claim_version_id,
    candidate.envelope_hash,row_number() over(order by candidate.candidate_claim_version_id)::integer ordinal
    from public.candidate_claim_envelopes candidate
    join public.candidate_claim_job_lineage lineage
      on lineage.candidate_claim_version_id=candidate.candidate_claim_version_id
    join public.truth_shadow_gmail_resumed_model_child_authorizations authority
      on authority.model_child_job_id=lineage.job_id
    where authority.workspace_key=$1 and authority.connection_key=$2
      and authority.disposition='model_execution'
    order by candidate.candidate_claim_version_id`, [WORKSPACE, CONNECTION])).rows;
  assert.equal(candidates.length, 3);
  for (const candidate of candidates) {
    const decision = candidate.ordinal === 3 ? "reject" : "accept";
    const receipt = await asService(db, async () => (await one(db, `select
      public.resolve_truth_review(
        $1,'candidate_claim',$2,$3,'',$4,$5,'operator:late-model-fixture',
        $6,$7,$8,$9
      ) receipt`, [WORKSPACE, candidate.candidate_claim_version_id,
      candidate.envelope_hash, decision, POLICY,
      `Read the late model candidate and cited source in full; ${decision}.`,
      `late_model_candidate_review_${String(candidate.ordinal).padStart(8, "0")}`,
      REVIEW, SYNC])).receipt);
    assert.equal(receipt.decision, decision);
    assert.equal(receipt.publishesTruth, false);
  }
}

async function main() {
  const fixture = loadTerminalFixture();
  const db = await fixture.createDatabase();
  try {
    await fixture.seedScope(db);
    await fixture.seedPlansAndParentManifests(db);
    await fixture.seedRetryAuthoritiesAndChildren(db);
    await fixture.seedCertifiedEpoch(db);
    await db.exec("alter table public.source_processing_jobs disable trigger user");
    try {
      await db.query(`update public.source_processing_jobs epoch_job set
        result=jsonb_build_object(
          'schemaVersion','truth-shadow-acceptance-epoch-job-result-v1',
          'epochId',epoch.epoch_id,'epochReceiptHash',epoch.receipt_hash
        )
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch_job.workspace_key=epoch.workspace_key
        and epoch_job.job_id=epoch.pending_job_id
        and epoch.workspace_key=$1 and epoch.connection_key=$2`,
      [WORKSPACE, CONNECTION]);
    } finally {
      await db.exec("alter table public.source_processing_jobs enable trigger user");
    }
    await seedReviewToken(db);

    const migration150 = fs.readFileSync(
      path.join(MIGRATION_DIR, "20260717150000_truth_gmail_resumed_model_terminal_authority.sql"),
      "utf8",
    );
    await db.exec(migration150);

    const shape = await one(db, `select
      count(*)::integer total,
      count(*) filter(where disposition='stale_time_binding_review')::integer stale,
      count(*) filter(where disposition='model_execution')::integer execution,
      count(*) filter(where prior_state='retry_wait' and prior_attempt_count=3)::integer retry_shape,
      count(*) filter(where prior_state='waiting_runtime' and prior_attempt_count=0)::integer waiting_shape,
      count(distinct predecessor_epoch_id)::integer epochs
    from public.truth_shadow_gmail_resumed_model_child_authorizations
    where workspace_key=$1 and connection_key=$2 and root_batch_id=$3::uuid`,
    [WORKSPACE, CONNECTION, ROOT_BATCH]);
    assert.deepEqual(shape, {
      total: 10,
      stale: 7,
      execution: 3,
      retry_shape: 7,
      waiting_shape: 3,
      epochs: 1,
    });

    await terminalizeStaleReviews(db);
    await terminalizeModelExecutions(db);

    const terminalShape = await one(db, `select
      count(*) filter(where authority.disposition='stale_time_binding_review'
        and child.state='succeeded' and child.result->>'outcome'='review_required')::integer reviewed,
      count(*) filter(where authority.disposition='model_execution'
        and child.state='succeeded' and child.result->>'outcome'='succeeded')::integer executed,
      (select count(*)::integer from public.candidate_claim_envelopes candidate
       join public.candidate_claim_job_lineage lineage
         on lineage.candidate_claim_version_id=candidate.candidate_claim_version_id
       join public.truth_shadow_gmail_resumed_model_child_authorizations a
         on a.model_child_job_id=lineage.job_id
       where a.workspace_key=$1 and a.connection_key=$2) candidates,
      (select count(*)::integer from public.truth_review_resolutions resolution
       where resolution.workspace_key=$1 and resolution.target_kind='candidate_claim') candidate_reviews
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_processing_jobs child
      on child.workspace_key=authority.workspace_key
     and child.job_id=authority.model_child_job_id
    where authority.workspace_key=$1 and authority.connection_key=$2`,
    [WORKSPACE, CONNECTION]);
    assert.deepEqual(terminalShape, {
      reviewed: 7,
      executed: 3,
      candidates: 3,
      candidate_reviews: 3,
    });

    const epochBefore = await one(db, `select to_jsonb(epoch) identity
      from public.truth_shadow_claim_acceptance_epochs epoch
      join public.truth_shadow_gmail_resumed_model_child_authorizations authority
        on authority.workspace_key=epoch.workspace_key
       and authority.predecessor_epoch_id=epoch.epoch_id
      where authority.workspace_key=$1 and authority.connection_key=$2
      order by authority.authorization_id limit 1`, [WORKSPACE, CONNECTION]);
    const cutGuardBefore = await one(db, `select pg_get_functiondef(
      'private.require_exact_complete_source_cut(text,text)'::regprocedure
    ) definition`);

    const migrationSql = fs.readFileSync(path.join(MIGRATION_DIR, MIGRATION), "utf8");
    await db.exec(migrationSql);
    const cutGuardAfter = await one(db, `select pg_get_functiondef(
      'private.require_exact_complete_source_cut(text,text)'::regprocedure
    ) definition`);
    assert.equal(cutGuardAfter.definition, cutGuardBefore.definition,
      "late-model cut binding must not weaken or rewrite the exact-cut validator");

    const predecessorProof = await one(db, `select epoch.schema_version,
      epoch.production_publication_attempted,
      epoch.receipt_hash=encode(extensions.digest(convert_to(
        private.truth_canonical_json_text(epoch.canonical_receipt),'UTF8'
      ),'sha256'),'hex') receipt_hash_valid,
      count(*) filter(where
        authority.predecessor_epoch_id is distinct from epoch.epoch_id
        or authority.predecessor_epoch_receipt_hash is distinct from epoch.receipt_hash
        or authority.source_cursor_version is distinct from epoch.source_cursor_version
        or authority.source_cursor_value is distinct from epoch.source_cursor_value
        or authority.shadow_only<>true or authority.mutates_operational_state<>false
        or authority.production_eligible<>false
        or authority.production_publication_attempted<>false)::integer bad_authorizations
    from public.truth_shadow_claim_acceptance_epochs epoch
    join public.truth_shadow_gmail_resumed_model_child_authorizations authority
      on authority.workspace_key=epoch.workspace_key
     and authority.predecessor_epoch_id=epoch.epoch_id
    where epoch.workspace_key=$1
    group by epoch.epoch_id`, [WORKSPACE]);
    assert.deepEqual(predecessorProof, {
      schema_version: "truth-shadow-claim-acceptance-epoch-v2",
      production_publication_attempted: false,
      receipt_hash_valid: true,
      bad_authorizations: 0,
    });

    const childProof = await one(db, `select count(*)::integer total,
      count(*) filter(where child.source_system<>'gmail'
        or child.connection_key is distinct from $2
        or child.job_kind<>'gmail_extract_message_model_claims'
        or child.state<>'succeeded' or child.completed_at is null
        or child.lease_owner is not null or child.lease_expires_at is not null
        or child.observation_id is distinct from authority.source_observation_id
        or child.payload->>'modelPlanId' is distinct from authority.model_plan_id
        or child.result->>'schemaVersion'<>'truth-model-extraction-worker-result-v1'
        or child.result->>'modelPlanId' is distinct from authority.model_plan_id
        or child.result->>'sourceObservationId' is distinct from
          authority.source_observation_id)::integer bad
    from public.truth_shadow_gmail_resumed_model_child_authorizations authority
    join public.source_processing_jobs child
      on child.workspace_key=authority.workspace_key
     and child.job_id=authority.model_child_job_id
    where authority.workspace_key=$1 and authority.connection_key=$2`,
    [WORKSPACE, CONNECTION]);
    assert.deepEqual(childProof, { total: 10, bad: 0 });

    const acceptance = await asService(db, async () => (await one(db, `select
      public.run_truth_shadow_late_model_acceptance(
        $1,$2,$3::uuid,$4,$5
      ) receipt`, [WORKSPACE, CONNECTION, ROOT_BATCH, REVIEW, SYNC])).receipt);
    assert.equal(acceptance.ok, true);
    assert.equal(acceptance.status, "succeeded");
    assert.equal(acceptance.idempotent, false);
    assert.equal(acceptance.authorizationCount, 10);
    assert.equal(acceptance.successfulModelChildCount, 3);
    assert.equal(acceptance.reviewedModelChildCount, 7);
    assert.equal(acceptance.candidateCount, 3);
    assert.equal(acceptance.acceptedCount, 2);
    assert.equal(acceptance.rejectedCount, 1);
    assert.equal(acceptance.publicationChannel, "shadow");
    assert.equal(acceptance.shadowOnly, true);
    assert.equal(acceptance.productionPublicationAttempted, false);
    assert.equal(acceptance.publishesTruth, false);

    const epochAfter = await one(db, `select to_jsonb(epoch) identity
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=$1 and epoch.epoch_id=$2`,
    [WORKSPACE, acceptance.predecessorEpochId]);
    assert.deepEqual(epochAfter.identity, epochBefore.identity,
      "late acceptance must leave the predecessor epoch byte-for-byte unchanged");

    const runState = await one(db, `select
      run.authorization_count,run.successful_model_child_count,
      run.reviewed_model_child_count,run.candidate_count,run.accepted_count,
      run.rejected_count,run.production_publication_attempted,
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_items item
       where item.run_id=run.run_id) item_count,
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_items item
       where item.run_id=run.run_id and item.decision='accept') accepted_items,
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_items item
       where item.run_id=run.run_id and item.decision='reject') rejected_items
    from public.truth_shadow_late_model_acceptance_runs run
    where run.workspace_key=$1 and run.run_id=$2`,
    [WORKSPACE, acceptance.lateAcceptanceId]);
    assert.deepEqual(runState, {
      authorization_count: 10,
      successful_model_child_count: 3,
      reviewed_model_child_count: 7,
      candidate_count: 3,
      accepted_count: 2,
      rejected_count: 1,
      production_publication_attempted: false,
      item_count: 3,
      accepted_items: 2,
      rejected_items: 1,
    });

    const replay = await asService(db, async () => (await one(db, `select
      public.run_truth_shadow_late_model_acceptance(
        $1,$2,$3::uuid,$4,$5
      ) receipt`, [WORKSPACE, CONNECTION, ROOT_BATCH, REVIEW, SYNC])).receipt);
    assert.equal(replay.status, "succeeded");
    assert.equal(replay.idempotent, true);
    assert.equal(replay.lateAcceptanceId, acceptance.lateAcceptanceId);
    assert.equal(replay.lateAcceptanceReceiptHash, acceptance.lateAcceptanceReceiptHash);

    await db.query(`update public.source_cursors set last_batch_id=$3::uuid,
      last_committed_at=coalesce(last_committed_at,clock_timestamp())
      where workspace_key=$1 and source_system='gmail' and connection_key=$2`,
    [WORKSPACE, CONNECTION, ROOT_BATCH]);
    const epochScope = await one(db, `select epoch.obligation_id
      from public.truth_shadow_claim_acceptance_epochs epoch
      where epoch.workspace_key=$1 and epoch.epoch_id=$2`,
    [WORKSPACE, acceptance.predecessorEpochId]);
    await db.exec(`alter table public.source_cut_cursors disable trigger
      zzz_truth_shadow_late_model_source_cut_binding`);
    let cut;
    try {
      cut = await asService(db, async () => (await one(db, `select
        public.seal_truth_shadow_root_source_cut($1,$2,$3,$4) receipt`,
      [WORKSPACE, epochScope.obligation_id,
        "truth-shadow-late-model-acceptance-verifier", SYNC])).receipt);
    } finally {
      await db.exec(`alter table public.source_cut_cursors enable trigger
        zzz_truth_shadow_late_model_source_cut_binding`);
    }
    assert.equal(cut.status, "ready", JSON.stringify(cut));
    assert.equal(cut.completeness, "complete", JSON.stringify(cut));
    assert.equal(cut.publicationChannel, "shadow");
    assert.equal(cut.productionPublicationAttempted, false);

    const unbound = await one(db, `select
      (select count(*)::integer from public.truth_shadow_root_source_cuts
       where workspace_key=$1 and source_cut_id=$2) scoped,
      (select count(*)::integer from public.truth_shadow_late_model_source_cut_bindings
       where workspace_key=$1 and source_cut_id=$2) bindings`,
    [WORKSPACE, cut.sourceCutId]);
    assert.deepEqual(unbound, { scoped: 1, bindings: 0 });

    const buildVersions = {
      model: "gpt-5-nano-2025-08-07",
      promptVersion: "gmail-model-prompt-v1",
      extractorVersion: "gmail-claim-extractor-v4",
      entityLinkerVersion: "deterministic:none",
      acceptancePolicyVersion: POLICY,
      configSnapshotVersion: `truth-processing-config-snapshot:v1:${"c".repeat(64)}`,
      configSnapshotHash: "c".repeat(64),
      reducerVersion: "late-model-fixture-reducer-v1",
      packetBuilderVersion: "late-model-fixture-packet-builder-v1",
      packetSchemaVersion: "shipment-truth-packets-v1",
      precedencePolicyVersion: "late-model-fixture-precedence-v1",
      precedencePolicyHash: "b".repeat(64),
    };
    await expectState(asService(db, async () => one(db, `select
      public.claim_truth_build_pair(
        $1,$2,'shadow',$3,$4,$5,300,1000,$6::jsonb,$7
      ) receipt`, [WORKSPACE, cut.sourceCutId,
      "late-model-unbound-build", "late_model_unbound_build_00000001",
      "late-model-verifier", JSON.stringify(buildVersions), SYNC])),
    "55000", "a complete but unbound late-model cut must reject a build");

    let contextOmissionRejected = false;
    await db.exec("begin");
    try {
      await db.exec(`alter table public.gmail_model_context_observations
        disable trigger user`);
      await db.query(`delete from public.gmail_model_context_observations
        where ctid in (
          select member.ctid
          from public.gmail_model_context_observations member
          join public.gmail_model_extraction_context_seals seal
            on seal.workspace_key=member.workspace_key
           and seal.context_seal_id=member.context_seal_id
          join public.truth_shadow_gmail_resumed_model_child_authorizations authority
            on authority.workspace_key=seal.workspace_key
           and authority.parent_job_id=seal.parent_job_id
          where authority.workspace_key=$1 and authority.connection_key=$2
          order by authority.authorization_id,member.ordinal
          limit 1
        )`, [WORKSPACE, CONNECTION]);
      await expectState(db.query(`select
        private.bind_truth_shadow_late_model_source_cut_v1($1) receipt`,
      [cut.sourceCutId]), "23514",
      "a cut missing one immutable model-context observation must not bind");
      contextOmissionRejected = true;
    } finally {
      await db.exec("rollback");
    }

    const bound = (await one(db, `select
      private.bind_truth_shadow_late_model_source_cut_v1($1) receipt`,
    [cut.sourceCutId])).receipt;
    assert.equal(bound.ok, true);
    assert.equal(bound.status, "bound");
    assert.equal(bound.productionPublicationAttempted, false);
    const bindingState = await one(db, `select
      count(*)::integer bindings,
      count(*) filter(where shadow_only and not production_eligible
        and not production_publication_attempted)::integer quarantined
    from public.truth_shadow_late_model_source_cut_bindings
    where workspace_key=$1 and source_cut_id=$2`, [WORKSPACE, cut.sourceCutId]);
    assert.deepEqual(bindingState, { bindings: 1, quarantined: 1 });

    const acceptedVisibility = await one(db, `select
      count(*)::integer accepted_count,
      count(*) filter(where private.truth_shadow_claim_visible_to_connection(
        item.accepted_claim_version_id,$1,'gmail',$2))::integer visible_exact,
      count(*) filter(where not private.truth_shadow_claim_visible_to_connection(
        item.accepted_claim_version_id,$1,'gmail','primary'))::integer hidden_primary,
      count(*) filter(where private.truth_shadow_late_claim_bound_to_cut_v1(
        $1,$3,item.accepted_claim_version_id,item.accepted_claim_item_hash
      ))::integer bound_to_cut
    from public.truth_shadow_late_model_acceptance_items item
    where item.workspace_key=$1 and item.run_id=$4 and item.decision='accept'`,
    [WORKSPACE, CONNECTION, cut.sourceCutId, acceptance.lateAcceptanceId]);
    assert.deepEqual(acceptedVisibility, {
      accepted_count: 2,
      visible_exact: 2,
      hidden_primary: 2,
      bound_to_cut: 2,
    });

    const build = await asService(db, async () => (await one(db, `select
      public.claim_truth_build_pair(
        $1,$2,'shadow',$3,$4,$5,300,1000,$6::jsonb,$7
      ) receipt`, [WORKSPACE, cut.sourceCutId,
      "late-model-bound-build", "late_model_bound_build_0000000001",
      "late-model-verifier", JSON.stringify(buildVersions), SYNC])).receipt);
    assert.equal(build.status, "running");
    assert.equal(build.buildChannel, "shadow");
    assert.equal(build.publicationChannel, "shadow");

    const buildState = await one(db, `select
      (select count(*)::integer from public.truth_build_pair_runs pair
       where pair.workspace_key=$1 and pair.source_cut_id=$2
         and pair.build_channel='shadow' and pair.publication_channel='shadow') pairs,
      (select count(*)::integer from public.truth_builds build
       where build.workspace_key=$1 and build.source_cut_id=$2
         and build.channel='shadow') builds,
      (select count(*)::integer from public.truth_build_inputs input
       join public.truth_builds build on build.build_id=input.build_id
       where build.workspace_key=$1 and build.source_cut_id=$2
         and input.item_kind='accepted_claim') claim_inputs,
      (select count(*)::integer from public.truth_publications) publications`,
    [WORKSPACE, cut.sourceCutId]);
    assert.deepEqual(buildState, {
      pairs: 1,
      builds: 2,
      claim_inputs: 4,
      publications: 0,
    });

    const frozenHead = await one(db, `select item.candidate_claim_version_id,
      item.decision_version_id
    from public.truth_shadow_late_model_acceptance_items item
    where item.workspace_key=$1 and item.run_id=$2
    order by item.ordinal limit 1`, [WORKSPACE, acceptance.lateAcceptanceId]);
    await expectState(db.query(`insert into public.candidate_claim_decisions(
      decision_version_id,candidate_claim_version_id,decision_no,
      previous_decision_version_id,decision,decision_method,policy_version,
      decided_by,reasons,accepted_claim_request,decision_hash,
      decision_schema_version,canonical_decision
    ) values(
      'candidate-decision:v1:'||repeat('d',64),$1,2,$2,'reject','operator',
      $3,'operator:late-model-tamper',jsonb_build_array('tamper'),null,
      repeat('d',64),'candidate-claim-decision-v1','{}'::jsonb
    )`, [frozenHead.candidate_claim_version_id, frozenHead.decision_version_id, POLICY]),
    "23514", "a certified late-model candidate decision must be frozen");

    const beforeReapply = await one(db, `select
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_runs) runs,
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_items) items,
      (select count(*)::integer from public.truth_shadow_late_model_source_cut_bindings) cut_bindings,
      (select count(*)::integer from public.truth_build_pair_runs) build_pairs,
      (select count(*)::integer from public.truth_builds) builds,
      (select count(*)::integer from public.truth_publications) publications`);
    await db.exec(migrationSql);
    const afterReapply = await one(db, `select
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_runs) runs,
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_items) items,
      (select count(*)::integer from public.truth_shadow_late_model_source_cut_bindings) cut_bindings,
      (select count(*)::integer from public.truth_build_pair_runs) build_pairs,
      (select count(*)::integer from public.truth_builds) builds,
      (select count(*)::integer from public.truth_publications) publications`);
    assert.deepEqual(afterReapply, beforeReapply,
      "late-model acceptance migration reapply must preserve immutable runtime rows");
    const cutGuardReapplied = await one(db, `select pg_get_functiondef(
      'private.require_exact_complete_source_cut(text,text)'::regprocedure
    ) definition`);
    assert.equal(cutGuardReapplied.definition, cutGuardBefore.definition);

    const quarantine = await one(db, `select
      (select count(*)::integer from public.truth_shadow_late_model_acceptance_runs
       where shadow_only and not mutates_operational_state
         and not production_eligible and not production_publication_attempted) runs,
      (select count(*)::integer from public.truth_shadow_late_model_source_cut_bindings
       where shadow_only and not production_eligible
         and not production_publication_attempted) cut_bindings,
      (select count(*)::integer from public.truth_publications) publications,
      (select count(*)::integer from public.truth_publication_heads
       where channel='production') production_heads`);
    assert.deepEqual(quarantine, {
      runs: 1,
      cut_bindings: 1,
      publications: 0,
      production_heads: 0,
    });

    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-shadow-late-model-acceptance",
      authorizedChildCount: 10,
      staleBindingReviewTerminalCount: 7,
      lateReviewResolutionRpcCount: 7,
      lateReviewTamperedEdgeRejected: true,
      lateReviewResolutionIdempotentReplay: true,
      successfulModelTerminalCount: 3,
      candidateReviewCount: 3,
      acceptedCandidateCount: 2,
      rejectedCandidateCount: 1,
      predecessorEpochByteIdentityPreserved: true,
      lateAcceptanceId: acceptance.lateAcceptanceId,
      idempotentReplay: true,
      exactCutGuardUnchanged: true,
      unboundBuildRejected: true,
      contextOmissionRejected,
      freshCompleteCutBound: true,
      sourceCutId: cut.sourceCutId,
      shadowBuildPairCount: 1,
      shadowBuildCount: 2,
      lateDecisionAuthorityFrozen: true,
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

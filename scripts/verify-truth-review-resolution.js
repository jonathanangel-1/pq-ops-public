#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709226000_truth_link_workgroup_runtime.sql",
  "20260709238000_truth_tms_inventory_presence_policy.sql",
  "20260709240000_truth_review_resolution.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));
const SYNC = "truth-review-resolution-sync-token";
const REVIEW = "truth-review-resolution-review-token";
const WORKER = "truth-review-verifier";
const PROCESSOR = "truth-review-verifier-v1";
const POLICY = "gmail-candidate-acceptance-v3-source-chronology+pikiio-shipment-predicates-2026-07-09-v2";
const AWB = "01680000083";

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function expectState(promise, code, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${label}: ${error?.message || error}`);
    return true;
  }, label);
}

async function setup() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.sync_tokens(token_name text primary key, token_hash text not null);
    create table public.truth_workspaces(
      workspace_key text primary key,
      status text not null default 'active',
      registry_version text not null default 'truth-workspace-registry-v1',
      registered_at timestamptz not null default now()
    );
    insert into public.truth_workspaces(workspace_key) values ('primary'), ('other');
  `);
  for (const migration of MIGRATIONS) await db.exec(fs.readFileSync(migration, "utf8"));
  await db.exec(`
    create or replace function private.is_canonical_utc_millis(p_value text)
    returns boolean language sql immutable security invoker set search_path = '' as $function$
      select p_value ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'
        and to_char(p_value::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = p_value;
    $function$;
  `);
  await db.query(`
    insert into public.sync_tokens(token_name, token_hash) values
      ('local_snapshot_writer', encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex')),
      ('truth_review_decider', encode(extensions.digest(convert_to($2, 'UTF8'), 'sha256'), 'hex'))
  `, [SYNC, REVIEW]);
  await db.exec(`
    insert into public.source_cursors(
      workspace_key, source_system, connection_key, cursor_kind, cursor_value, cursor_version, status
    ) values
      ('primary','gmail','primary','gmail_history_id','2',2,'live'),
      ('other','gmail','primary','gmail_history_id','1',1,'live');
    insert into public.source_ingest_batches(
      batch_id, workspace_key, source_system, connection_key, mode,
      expected_cursor_version, expected_cursor_value, committed_cursor_version,
      committed_cursor_value, lease_owner, lease_fence, status, batch_hash
    ) values
      ('10000000-0000-4000-8000-000000000001','primary','gmail','primary','history',0,'',2,'2','fixture',1,'committed','${"1".repeat(64)}'),
      ('10000000-0000-4000-8000-000000000002','other','gmail','primary','history',0,'',1,'1','fixture',1,'committed','${"2".repeat(64)}');
  `);
  return db;
}

async function seedObservation(db, char, workspace, sourceRecordedAt, objectId) {
  const id = `obs:v1:${char.repeat(64)}`;
  const batch = workspace === "primary"
    ? "10000000-0000-4000-8000-000000000001"
    : "10000000-0000-4000-8000-000000000002";
  await db.query(`
    insert into public.source_observations(
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text, source_fidelity, schema_version
    ) values ($1,$2,'gmail','primary','gmail_message_parsed',$3,'1','content',1,$4,$5,$6,$6,
      '{}'::jsonb,'', 'normalized_source','gmail-parsed-message-v1')
  `, [id, workspace, objectId, batch, char.repeat(64), sourceRecordedAt]);
  return id;
}

async function appendPriorClaim(db, workspace, observationId, occurredAt, polarity = "positive", awb = AWB) {
  const receipt = await one(db, `select public.append_accepted_claim(
    $1::text,
    jsonb_build_object(
      'claimKey',$2::text,'versionNo',1,'previousClaimVersionId',null,
      'primaryObservationId',$3::text,'subjectType','shipment','subjectKey',$4::text,
      'predicate','customs_release','gate','customs','polarity',$5::text,
      'normalizedValue',jsonb_build_object('status',case when $5::text='positive' then 'released' else 'not_released' end,
        'effect',case when $5::text='positive' then 'complete' else 'block' end),
      'occurredAt',$6::text,'confidence',1,'confidenceLabel','high',
      'extractionMethod','deterministic','extractorVersion','fixture-v1',
      'promptVersion','','model','','acceptanceMethod','policy',
      'acceptancePolicyVersion','fixture-policy-v1','acceptedBy','fixture',
      'decision','accepted','evidenceSpan','{}'::jsonb,'recordedAt',$6::text,
      'schemaVersion','candidate-accepted-claim-v1'
    ),
    jsonb_build_array(jsonb_build_object('observationId',$3::text,'evidenceRole','primary','evidenceSpan','{}'::jsonb)),
    '[]'::jsonb,$7::text
  ) as receipt`, [workspace, `shipment:${awb}:customs_release`, observationId, awb, polarity, occurredAt, SYNC]);
  return receipt.receipt;
}

async function seedCandidate(db, options) {
  const hash = options.char.repeat(64);
  const id = `candidate:v1:${hash}`;
  const body = {
    schemaVersion: "gmail-candidate-claim-v1",
    claimKey: `shipment:${AWB}:customs_release`,
    versionNo: options.versionNo,
    previousClaimVersionId: options.previousClaimVersionId || "",
    sourceObservationId: options.observationId,
    sourceObservationContentHash: options.observationHash,
    sourceObjectType: "gmail_message_parsed",
    sourceObjectId: options.objectId,
    sourceReviewRequired: false,
    sourceExtractionMethod: "gmail-rfc822-parser-v1",
    sourceMessageId: options.objectId,
    sourceThreadId: `thread-${options.objectId}`,
    sourceCapturedAt: options.occurredAt,
    subjectType: "shipment",
    subjectKey: AWB,
    appliesToAwbs: [AWB],
    predicate: "customs_release",
    gate: "customs",
    polarity: options.polarity,
    normalizedValue: options.polarity === "positive"
      ? { status: "released", effect: "complete" }
      : { status: "not_released", effect: "block" },
    occurredAt: options.occurredAt,
    confidence: 0.99,
    confidenceLabel: "high",
    evidenceSpan: { start: 0, end: 4, unit: "utf16_code_units", quote: "test" },
    extractionMethod: "deterministic",
    extractorVersion: "gmail-claim-extractor-v4-source-chronology+predicates:9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e",
    model: "",
    promptVersion: "",
    ambiguity: { status: "none", reasons: [] },
    contradiction: {
      status: options.contradictionIds?.length ? "known" : "none",
      acceptedClaimVersionIds: options.contradictionIds || [],
      reasons: options.contradictionIds?.length ? ["accepted evidence asserts the opposite polarity"] : [],
    },
    acceptanceRecommendation: {
      decision: options.recommendation,
      method: options.recommendation === "accept" ? "policy" : "operator",
      policyVersion: POLICY,
      reasons: [options.recommendation === "reject" ? "equivalent accepted claim already exists" : "reviewed evidence"],
    },
  };
  await db.query(`
    insert into public.candidate_claim_envelopes(
      candidate_claim_version_id, workspace_key, source_observation_id,
      source_observation_content_hash, source_object_type, source_object_id,
      source_review_required, source_extraction_method, claim_key, version_no,
      previous_claim_version_id, extraction_method, recommendation,
      recommendation_policy_version, ambiguity_status, contradiction_status,
      envelope_hash, envelope_schema_version, extractor_candidate, canonical_envelope
    ) values ($1,$2,$3,$4,'gmail_message_parsed',$5,false,'gmail-rfc822-parser-v1',$6,$7,$8,
      'deterministic',$9,$10,'none',$11,$12,'candidate-claim-envelope-v1',$13,$14)
  `, [
    id, options.workspace || "primary", options.observationId, options.observationHash,
    options.objectId, body.claimKey, body.versionNo, options.previousClaimVersionId || null,
    options.recommendation, POLICY, body.contradiction.status, hash, body,
    { envelopeSchemaVersion: "candidate-claim-envelope-v1", workspaceKey: options.workspace || "primary", candidate: body },
  ]);
  return { id, hash, body };
}

async function seedPolicyJob(db, observationId, candidates) {
  const jobId = "00000000-0000-4000-8000-000000000666";
  await db.query(`
    insert into public.source_processing_jobs(
      job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,attempt_count,lease_owner,lease_fence,
      lease_expires_at,processor_version,payload
    ) values ($1,'review-policy-job','primary','gmail','primary','gmail_extract_message_claims',
      $2,'message-new','leased',1,$3,1,clock_timestamp()+interval '10 minutes',$4,'{}'::jsonb)
  `, [jobId, observationId, WORKER, PROCESSOR]);
  for (const candidate of candidates) {
    await db.query(`insert into public.candidate_claim_job_lineage(
      candidate_claim_version_id,job_id,source_observation_id
    ) values ($1,$2,$3)`, [candidate.id, jobId, observationId]);
  }
  const manifest = candidates.map((candidate) => ({ candidateClaimVersionId: candidate.id, itemHash: candidate.hash }));
  await db.query(`insert into public.candidate_claim_job_manifests(
    job_id,workspace_key,source_observation_id,candidate_count,manifest_hash,
    manifest_schema_version,canonical_manifest
  ) values ($1,'primary',$2,$3,$4,'candidate-claim-job-manifest-v1',$5)`, [
    jobId, observationId, candidates.length, "9".repeat(64), { candidates: manifest },
  ]);
  return jobId;
}

async function seedLinkProposal(db, char, observationId, jobId, decisionChar) {
  const runHash = char.repeat(64);
  const proposalHash = String.fromCharCode(char.charCodeAt(0) + 1).repeat(64);
  const decisionHash = decisionChar.repeat(64);
  const runId = `link-resolution:v1:${runHash}`;
  const proposalId = `link-proposal:v1:${proposalHash}`;
  await db.query(`insert into public.source_processing_jobs(
    job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
    observation_id,source_object_id,state,result
  ) values ($1,$2,'primary','gmail','primary','gmail_resolve_entity_links',$3,$2,'succeeded','{}'::jsonb)`,
  [jobId, `link-job-${char}`, observationId]);
  await db.query(`insert into public.truth_link_resolution_runs(
    resolution_run_id,workspace_key,job_id,anchor_observation_id,root_batch_id,
    source_cursor_version,source_cursor_value,linker_version,input_manifest_hash,
    linker_output_hash,context_observation_count,proposal_count,resolution_hash,
    resolution_schema_version,canonical_resolution
  ) values ($1,'primary',$2,$3,'10000000-0000-4000-8000-000000000001',1,'2','linker-v1',$4,$5,1,1,$6,'truth-link-resolution-v1','{}')`,
  [runId, jobId, observationId, "7".repeat(64), "8".repeat(64), runHash]);
  const raw = {
    linkKey: `fixture-link-${char}`,
    versionNo: 1,
    previousLinkVersionId: null,
    observationId,
    entityType: "shipment",
    entityKey: AWB,
    relationship: "mentions",
    decision: "linked",
    confidence: 0.8,
    linkMethod: "model",
    linkerVersion: "linker-v1",
    evidenceSpan: {},
    recordedAt: "2026-07-09T12:00:00.000Z",
    schemaVersion: "observation-entity-link-v1",
  };
  await db.query(`insert into public.truth_link_candidate_proposals(
    proposal_id,resolution_run_id,workspace_key,candidate_kind,candidate_key,
    parent_candidate_key,proposal_method,auto_accept_eligible,requires_review,
    policy_disposition,policy_class,has_conflict,membership_change,proposal_hash,
    proposal_schema_version,canonical_proposal
  ) values ($1,$2,'primary','entity_link',$3,'','model',false,true,'review',
    'operator_review_required',false,false,$4,'truth-link-candidate-proposal-v1',$5)`,
  [proposalId, runId, `candidate-${char}`, proposalHash, { candidate: { proposal: raw, assessment: {} } }]);
  await db.query(`insert into public.truth_link_candidate_evidence(proposal_id,observation_id,ordinal)
    values ($1,$2,0)`, [proposalId, observationId]);
  await db.query(`insert into public.truth_link_candidate_decisions(
    decision_version_id,proposal_id,decision_no,previous_decision_version_id,
    decision,decision_method,policy_version,decided_by,reasons,accepted_item_request,
    decision_hash,decision_schema_version,canonical_decision
  ) values ($1,$2,1,null,'review','policy','link-policy-v1','linker',
    '["operator review required"]'::jsonb,null,$3,'truth-link-candidate-decision-v1','{}')`,
  [`link-decision:v1:${decisionHash}`, proposalId, decisionHash]);
  return { proposalId, proposalHash, decisionId: `link-decision:v1:${decisionHash}` };
}

async function resolve(db, input) {
  return (await one(db, `select public.resolve_truth_review(
    'primary',$1,$2,$3,$4,$5,'truth-review-resolution-v1','operator:test',$6,$7,$8,$9
  ) as receipt`, [
    input.kind, input.id, input.hash, input.previous || "", input.decision,
    input.reason || "Reviewed immutable evidence.", input.key, REVIEW, SYNC,
  ])).receipt;
}

async function main() {
  const db = await setup();
  try {
    const oldObs = await seedObservation(db, "a", "primary", "2026-07-08T10:00:00.000Z", "message-old");
    const newObs = await seedObservation(db, "b", "primary", "2026-07-09T10:00:00.000Z", "message-new");
    const linkObs = await seedObservation(db, "c", "primary", "2026-07-09T11:00:00.000Z", "message-link");
    const otherObs = await seedObservation(db, "d", "other", "2026-07-08T09:00:00.000Z", "message-other");
    const prior = await appendPriorClaim(db, "primary", oldObs, "2026-07-08T10:00:00.000Z");
    const foreign = await appendPriorClaim(
      db, "other", otherObs, "2026-07-08T09:00:00.000Z", "positive", "99980000324",
    );
    const correction = await seedCandidate(db, {
      char: "e", observationId: newObs, observationHash: "b".repeat(64), objectId: "message-new",
      occurredAt: "2026-07-09T10:00:00.000Z", versionNo: 2,
      previousClaimVersionId: prior.claimVersionId, polarity: "negative",
      contradictionIds: [prior.claimVersionId], recommendation: "accept",
    });
    const rejected = await seedCandidate(db, {
      char: "f", observationId: newObs, observationHash: "b".repeat(64), objectId: "message-new",
      occurredAt: "2026-07-09T10:00:00.000Z", versionNo: 2,
      previousClaimVersionId: prior.claimVersionId, polarity: "positive",
      contradictionIds: [], recommendation: "reject",
    });
    const reviewCandidate = await seedCandidate(db, {
      char: "1", observationId: newObs, observationHash: "b".repeat(64), objectId: "message-review",
      occurredAt: "2026-07-09T10:00:00.000Z", versionNo: 2,
      previousClaimVersionId: prior.claimVersionId, polarity: "negative",
      contradictionIds: [prior.claimVersionId], recommendation: "review",
    });
    const crossCandidate = await seedCandidate(db, {
      char: "2", observationId: newObs, observationHash: "b".repeat(64), objectId: "message-cross",
      occurredAt: "2026-07-09T10:00:00.000Z", versionNo: 2,
      previousClaimVersionId: prior.claimVersionId, polarity: "negative",
      contradictionIds: [foreign.claimVersionId], recommendation: "review",
    });
    const jobId = await seedPolicyJob(db, newObs, [correction, rejected]);
    await expectState(resolve(db, {
      kind: "candidate_claim", id: crossCandidate.id, hash: crossCandidate.hash,
      decision: "accept", key: "candidate_cross_scope_accept_000001",
    }), "23514", "cross-workspace correction must fail");
    await resolve(db, {
      kind: "candidate_claim", id: crossCandidate.id, hash: crossCandidate.hash,
      decision: "reject", key: "candidate_cross_scope_reject_000001",
    });
    const correctionAuth = (await one(db, `select public.authorize_candidate_claim_policy_correction(
      'primary',$1,$2,1,$3,$4,$5
    ) as receipt`, [jobId, WORKER, PROCESSOR, correction.id, SYNC])).receipt;
    assert.equal(correctionAuth.decision, "accept");
    assert.equal(correctionAuth.acceptedClaimRequest.claim.acceptanceMethod, "policy");
    assert.deepEqual(correctionAuth.acceptedClaimRequest.supersessions.map((row) => row.supersededClaimVersionId),
      [prior.claimVersionId]);
    const accepted = (await one(db, `select public.append_accepted_claim(
      'primary',$1,$2,$3,$4
    ) as receipt`, [
      correctionAuth.acceptedClaimRequest.claim,
      correctionAuth.acceptedClaimRequest.evidence,
      correctionAuth.acceptedClaimRequest.supersessions,
      SYNC,
    ])).receipt;
    await one(db, `select public.bind_candidate_claim_acceptance(
      'primary',$1,$2,1,$3,$4,$5,$6,$7
    ) as receipt`, [jobId, WORKER, PROCESSOR, correction.id,
      correctionAuth.decisionVersionId, accepted.claimVersionId, SYNC]);
    const provenance = await one(db, `select claim.acceptance_method,
      (select count(*)::integer from public.claim_supersessions supersession
       where supersession.resolving_claim_version_id=claim.claim_version_id) as supersessions
      from public.accepted_claims claim where claim.claim_version_id=$1`, [accepted.claimVersionId]);
    assert.equal(provenance.acceptance_method, "policy");
    assert.equal(provenance.supersessions, 1);

    const rejectReceipt = (await one(db, `select public.record_candidate_claim_policy_recommendation(
      'primary',$1,$2,1,$3,$4,$5
    ) as receipt`, [jobId, WORKER, PROCESSOR, rejected.id, SYNC])).receipt;
    assert.equal(rejectReceipt.decision, "reject");
    const rejectReplay = (await one(db, `select public.record_candidate_claim_policy_recommendation(
      'primary',$1,$2,1,$3,$4,$5
    ) as receipt`, [jobId, WORKER, PROCESSOR, rejected.id, SYNC])).receipt;
    assert.equal(rejectReplay.idempotent, true);

    const queueBefore = (await one(db, `select public.read_truth_review_queue(
      'primary','candidate_claim',100,$1
    ) as queue`, [REVIEW])).queue;
    assert(queueBefore.items.some((item) => item.targetId === reviewCandidate.id));
    const reviewReject = await resolve(db, {
      kind: "candidate_claim", id: reviewCandidate.id, hash: reviewCandidate.hash,
      decision: "reject", key: "candidate_review_reject_key_000001",
    });
    assert.equal(reviewReject.decision, "reject");
    const replay = await resolve(db, {
      kind: "candidate_claim", id: reviewCandidate.id, hash: reviewCandidate.hash,
      decision: "reject", key: "candidate_review_reject_key_000001",
    });
    assert.equal(replay.idempotent, true);
    const acceptedLink = await seedLinkProposal(db, "3", linkObs,
      "30000000-0000-4000-8000-000000000001", "5");
    const rejectedLink = await seedLinkProposal(db, "6", linkObs,
      "30000000-0000-4000-8000-000000000002", "8");
    const linkAccept = await resolve(db, {
      kind: "link_proposal", id: acceptedLink.proposalId, hash: acceptedLink.proposalHash,
      previous: acceptedLink.decisionId, decision: "accept", key: "link_review_accept_key_000000001",
    });
    assert.equal(linkAccept.acceptedKind, "entity_link");
    const linkReject = await resolve(db, {
      kind: "link_proposal", id: rejectedLink.proposalId, hash: rejectedLink.proposalHash,
      previous: rejectedLink.decisionId, decision: "reject", key: "link_review_reject_key_000000001",
    });
    assert.equal(linkReject.decision, "reject");
    assert.equal((await one(db, `select count(*)::integer as count from public.truth_link_acceptance_bindings
      where proposal_id=$1`, [acceptedLink.proposalId])).count, 1);

    const finalQueue = (await one(db, `select public.read_truth_review_queue(
      'primary','',100,$1
    ) as queue`, [REVIEW])).queue;
    assert.equal(finalQueue.totalCount, 0);
    const gaps = (await one(db, `select private.truth_review_gaps_for_source_cut(
      'primary',jsonb_build_array(jsonb_build_object(
        'sourceSystem','gmail','connectionKey','primary','throughCursorVersion',2
      ))
    ) as gaps`)).gaps;
    assert.deepEqual(gaps, []);
    assert.equal((await one(db, `select count(*)::integer as count from public.truth_review_resolutions`)).count, 4);
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-review-resolution",
      policyCorrectionClaim: accepted.claimVersionId,
      terminalPolicyReject: rejectReceipt.decisionVersionId,
      explicitCandidateReject: reviewReject.reviewResolutionId,
      explicitLinkAccept: linkAccept.reviewResolutionId,
      explicitLinkReject: linkReject.reviewResolutionId,
      proves: [
        "safe newer policy correction supersedes the exact older same-subject claim with policy provenance",
        "extractor rejection is durable, terminal, and idempotent",
        "candidate and link review accept/reject paths are atomic and idempotent",
        "cross-workspace correction targets are rejected",
        "resolved review queues no longer degrade a source cut",
      ],
    }, null, 2));
  } finally {
    await db.close();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

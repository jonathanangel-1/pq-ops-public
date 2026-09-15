#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const {
  AUDIT_RPC,
  PRODUCER_CONTEXT_SCHEMA_VERSION,
  PRODUCER_LANES,
  createTruthAuditLedger,
  normalizeAuditProducerContext,
  standaloneAuditProducerContext,
  _test: ledgerTest,
} = require("../lib/truth-audit-ledger");
const {
  PRODUCTION_SNAPSHOT_PATH,
  createRelationalTruthAuditRunner,
  _test: runnerTest,
} = require("../lib/relational-truth-audit-runner");
const { _test: cronTest } = require("../api/cron/truth-audit");
const { _test: witnessTest } = require("../api/truth/production-witness");
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
} = require("../lib/relational-truth-delivery-adapter");
const { REDUCER_VERSION } = require("../lib/relational-truth-reducer");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const { processingWatermarkFixture } = require("./truth-processing-watermark-fixture");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709224000_truth_audit_runtime.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));
const AUDIT_METADATA_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709240600_truth_audit_shipment_metadata.sql",
);
const AUDIT_STATUS_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709237000_truth_audit_status_read.sql",
);
const AUDIT_EXPIRED_STATUS_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709240800_truth_audit_expired_running_status.sql",
);
const AUDIT_LANE_STATUS_MIGRATION = path.join(
  ROOT,
  "supabase/migrations/20260709241500_truth_audit_lane_status.sql",
);

const TOKEN = "truth-audit-token-for-tests";
const WITNESS_TOKEN = "production_witness_token_for_audit_tests_123456";
const PROTECTION_BYPASS = "vercel_protection_bypass_for_audit_tests_123456";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const FINDING_ID = `truth-audit:v1:${"c".repeat(64)}`;
const RUN_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
];

function shadowProducerContext(overrides = {}) {
  return normalizeAuditProducerContext({
    schemaVersion: PRODUCER_CONTEXT_SCHEMA_VERSION,
    producerLane: PRODUCER_LANES.shadow,
    producerStatus: "succeeded",
    gmailSyncDisposition: "ready",
    workerRounds: 2,
    workersDrained: true,
    workerFailureCount: 0,
    sourceCutStatus: "sealed",
    sourceCutId: `cut:v1:${"f".repeat(64)}`,
    sourceCutCompleteness: "complete",
    sourceGapCount: 0,
    sourceGapsHash: crypto.createHash("sha256").update("[]", "utf8").digest("hex"),
    shadowBuildStatus: "succeeded",
    failureStage: "",
    failureCode: "",
    ...overrides,
  }, { expectedLane: PRODUCER_LANES.shadow });
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

async function installSqlContract(db) {
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
    returns boolean language sql as $function$ select false $function$;
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
    create table public.truth_workspaces (
      workspace_key text primary key,
      status text not null default 'active',
      registry_version text not null default 'truth-workspace-registry-v1',
      registered_at timestamptz not null default now()
    );
    insert into public.truth_workspaces (workspace_key) values ('primary');
  `);
  for (const migration of MIGRATIONS) {
    await db.exec(fs.readFileSync(migration, "utf8"));
  }
  // This ledger is installed by the later build/publication runtime migration.
  // The audit migration must remain timestamp-order installable before it, so
  // this focused verifier installs the exact row shape after the audit RPC and
  // proves the RPC resolves it dynamically at execution time.
  await db.exec(`
    create table public.truth_publication_payloads (
      publication_id uuid primary key,
      workspace_key text not null,
      channel text not null,
      publication_version bigint not null,
      source_cut_id text not null,
      packet_hash text not null,
      reducer_packet_hash text not null,
      semantic_hash text not null,
      delivery_payload jsonb not null,
      delivery_canonical_text text not null,
      delivery_payload_hash text not null,
      active_index_payload jsonb not null,
      active_index_hash text not null,
      created_at timestamptz not null default now()
    );
    alter table public.truth_build_inputs
      drop constraint truth_build_inputs_item_kind_check;
    alter table public.truth_build_inputs
      add constraint truth_build_inputs_item_kind_check
      check (item_kind = any (array[
        'accepted_claim', 'entity_link', 'workgroup_membership', 'shipment_metadata'
      ]));
    create table public.truth_shipment_metadata_envelopes (
      metadata_version_id text primary key,
      workspace_key text not null,
      shipment_key text not null,
      source_observation_id text not null,
      source_observation_content_hash text not null,
      snapshot_time timestamptz not null,
      envelope_hash text not null,
      canonical_envelope jsonb not null
    );
  `);
  await db.exec(fs.readFileSync(AUDIT_STATUS_MIGRATION, "utf8"));
  const auditMetadataSql = fs.readFileSync(AUDIT_METADATA_MIGRATION, "utf8");
  await db.exec(auditMetadataSql);
  await db.exec(auditMetadataSql);
  await db.exec(fs.readFileSync(AUDIT_EXPIRED_STATUS_MIGRATION, "utf8"));
  const auditLaneStatusSql = fs.readFileSync(AUDIT_LANE_STATUS_MIGRATION, "utf8");
  await db.exec(auditLaneStatusSql);
  await db.exec(auditLaneStatusSql);
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values (
      'truth_audit_runtime',
      encode(extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex')
    )
  `, [TOKEN]);
}

async function beginAudit(db, workspace = "primary", token = TOKEN, options = {}) {
  const auditMode = options.auditMode ?? "hourly";
  const expectedIntervalSeconds = options.expectedIntervalSeconds
    ?? (auditMode === "delta" ? 300 : 900);
  const producerContext = options.producerContext
    ?? (auditMode === "delta" ? shadowProducerContext() : standaloneAuditProducerContext());
  return (await one(db, `
    select public.begin_truth_audit_run(
      $1::text,
      $2::text,
      'relational-truth-auditor-v1'::text,
      ''::text,
      300::integer,
      $3::integer,
      $4::jsonb,
      $5::text
    ) as receipt
  `, [workspace, auditMode, expectedIntervalSeconds, producerContext, token])).receipt;
}

async function completeAudit(db, auditRunId, finding = null, metrics = null, sourceCutId = "") {
  return (await one(db, `
    select public.complete_truth_audit_run(
      $1::uuid,
      $8::text,
      $2::text,
      $3::text,
      $4::text,
      $5::jsonb,
      $6::jsonb,
      $7::text
    ) as receipt
  `, [
    auditRunId,
    HASH_A,
    HASH_B,
    HASH_A,
    metrics ?? { agreement: !finding, mutatesOperationalState: false },
    finding ? [finding] : [],
    TOKEN,
    sourceCutId,
  ])).receipt;
}

async function failAudit(db, auditRunId, code = "VERIFY_FAILURE") {
  return (await one(db, `
    select public.fail_truth_audit_run(
      $1::uuid, $2::text, 'bounded verifier failure'::text, $3::text
    ) as receipt
  `, [auditRunId, code, TOKEN])).receipt;
}

function stableFinding() {
  return {
    findingId: FINDING_ID,
    stage: "production",
    severity: "blocking",
    classification: "production_hash_mismatch",
    subjectType: "production_api",
    subjectKey: "shipment-truth-packets",
    evidenceIds: [HASH_A],
    evidenceObservationIds: [],
    detail: { expected: HASH_A, actual: HASH_B },
    mutatesOperationalState: false,
  };
}

function emptyAuditStatusV2() {
  const lane = (producerLane, auditMode, expectedIntervalSeconds, staleAfterSeconds) => ({
    schemaVersion: "truth-audit-lane-status-v1",
    producerLane,
    auditMode,
    health: "never_run",
    stale: true,
    expectedIntervalSeconds,
    staleAfterSeconds,
    latestRun: null,
    latestCompleted: null,
    latestSuccess: null,
    lastSuccessfulFinishedAt: null,
    secondsSinceLastSuccess: null,
    secondsSinceLatestRun: null,
    producerStatus: "never_run",
    producerContextValid: false,
    findingCount: 0,
    findingsTruncated: false,
    counts: { blocking: 0, attention: 0, informational: 0 },
    findings: [],
    mutatesOperationalState: false,
  });
  return {
    schemaVersion: "truth-audit-status-v2",
    ok: true,
    workspaceKey: "primary",
    health: "never_run",
    stale: true,
    policy: {
      schemaVersion: "truth-audit-lane-status-policy-v1",
      lanes: {
        [PRODUCER_LANES.shadow]: {
          auditMode: "delta",
          expectedIntervalSeconds: 300,
          staleAfterSeconds: 600,
        },
        [PRODUCER_LANES.standalone]: {
          auditMode: "hourly",
          expectedIntervalSeconds: 900,
          staleAfterSeconds: 1800,
        },
      },
    },
    lanes: {
      [PRODUCER_LANES.shadow]: lane(PRODUCER_LANES.shadow, "delta", 300, 600),
      [PRODUCER_LANES.standalone]: lane(PRODUCER_LANES.standalone, "hourly", 900, 1800),
    },
    findingCount: 0,
    findingsTruncated: false,
    counts: { blocking: 0, attention: 0, informational: 0 },
    findings: [],
    mutatesOperationalState: false,
  };
}

function fixtureHash(label) {
  return crypto.createHash("sha256").update(String(label), "utf8").digest("hex");
}

async function registerAuditWorkspace(db, workspace) {
  await db.query(`
    insert into public.truth_workspaces (workspace_key)
    values ($1::text)
    on conflict (workspace_key) do nothing
  `, [workspace]);
}

async function createAuditSourceCut(db, workspace, label, options = {}) {
  const hash = fixtureHash(`cut:${workspace}:${label}`);
  const sourceCutId = `cut:v1:${hash}`;
  const completeness = options.completeness ?? "complete";
  const gaps = options.gaps ?? [];
  await db.query(`
    insert into public.source_cuts (
      source_cut_id, workspace_key, manifest_hash, manifest, completeness,
      required_sources, gaps, observation_count, manifest_schema_version, created_by
    ) values (
      $1::text, $2::text, $3::text, '{}'::jsonb, $4::text,
      '[]'::jsonb, $5::jsonb, 0, 'source-cut-manifest-v2', 'audit-verifier'
    )
  `, [sourceCutId, workspace, fixtureHash(`manifest:${workspace}:${label}`), completeness, gaps]);
  return sourceCutId;
}

async function rawBeginAudit(db, {
  workspace = "primary",
  auditMode = "hourly",
  expectedIntervalSeconds = auditMode === "delta" ? 300 : 900,
  producerContext = standaloneAuditProducerContext(),
  token = TOKEN,
} = {}) {
  return (await one(db, `
    select public.begin_truth_audit_run(
      $1::text, $2::text, 'relational-truth-auditor-v1'::text, ''::text,
      300::integer, $3::integer, $4::jsonb, $5::text
    ) as receipt
  `, [workspace, auditMode, expectedIntervalSeconds, producerContext, token])).receipt;
}

async function insertAuditRun(db, {
  workspace,
  auditMode,
  status = "succeeded",
  producerContext = auditMode === "delta" ? shadowProducerContext() : standaloneAuditProducerContext(),
  startedAgoSeconds = 20,
  finishedAgoSeconds = 10,
  leaseOffsetSeconds = 300,
  sourceCutId = auditMode === "delta" && producerContext?.sourceCutStatus === "sealed"
    ? producerContext.sourceCutId
    : "",
  metrics,
} = {}) {
  const auditRunId = crypto.randomUUID();
  const final = status !== "running";
  const finalMetrics = metrics ?? (final && producerContext
    ? { producerContext, mutatesOperationalState: false }
    : { mutatesOperationalState: false });
  await db.query(`
    insert into public.truth_audit_runs (
      audit_run_id, workspace_key, source_cut_id, audit_mode, status,
      observer_version, model_version, mutates_operational_state, metrics,
      error_code, error_detail, input_digest, started_at, finished_at,
      lease_expires_at, expected_interval_seconds, producer_context
    ) values (
      $1::uuid, $2::text, nullif($3::text,''), $4::text, $5::text,
      'relational-truth-auditor-v1', '', false, $6::jsonb,
      $7::text, $8::text, case when $5::text='succeeded' then $9::text else null end,
      statement_timestamp()-make_interval(secs=>$10::integer),
      case when $5::text='running' then null
        else statement_timestamp()-make_interval(secs=>$11::integer) end,
      case when $5::text='running' then statement_timestamp()+make_interval(secs=>$12::integer)
        else null end,
      case when $4::text='delta' then 300 else 900 end,
      $13::jsonb
    )
  `, [
    auditRunId,
    workspace,
    sourceCutId,
    auditMode,
    status,
    finalMetrics,
    status === "failed" ? "VERIFY_FAILED" : "",
    status === "failed" ? "bounded verifier failure" : "",
    HASH_A,
    startedAgoSeconds,
    finishedAgoSeconds,
    leaseOffsetSeconds,
    producerContext,
  ]);
  return auditRunId;
}

async function insertAuditFinding(db, { workspace, auditRunId, severity = "blocking", label }) {
  const findingId = `truth-audit:v1:${fixtureHash(`finding:${workspace}:${label}`)}`;
  await db.query(`
    insert into public.truth_audit_findings (
      audit_run_id, finding_id, workspace_key, stage, severity, classification,
      subject_type, subject_key, evidence_ids, evidence_observation_ids, detail,
      mutates_operational_state
    ) values (
      $1::uuid, $2::text, $3::text, 'production', $4::text,
      'production_hash_mismatch', 'production_api', $5::text,
      array[$6::text], '{}'::text[], '{}'::jsonb, false
    )
  `, [auditRunId, findingId, workspace, severity, label, HASH_A]);
  return findingId;
}

async function readAuditStatus(db, workspace, findingLimit = 50) {
  await db.exec("set role anon");
  try {
    const status = (await one(db, `
      select public.read_truth_audit_status($1::text,$2::integer,$3::text) as status
    `, [workspace, findingLimit, TOKEN])).status;
    ledgerTest.validateStatus(status, { findingLimit });
    return status;
  } finally {
    await db.exec("reset role");
  }
}

async function seedHealthyAuditLanes(db, workspace, {
  shadowStartedAgoSeconds = 20,
  shadowFinishedAgoSeconds = 10,
  standaloneStartedAgoSeconds = 15,
  standaloneFinishedAgoSeconds = 5,
} = {}) {
  await registerAuditWorkspace(db, workspace);
  const sourceCutId = await createAuditSourceCut(db, workspace, "healthy");
  const shadowContext = shadowProducerContext({ sourceCutId });
  const shadowRunId = await insertAuditRun(db, {
    workspace,
    auditMode: "delta",
    producerContext: shadowContext,
    sourceCutId,
    startedAgoSeconds: shadowStartedAgoSeconds,
    finishedAgoSeconds: shadowFinishedAgoSeconds,
  });
  const standaloneRunId = await insertAuditRun(db, {
    workspace,
    auditMode: "hourly",
    startedAgoSeconds: standaloneStartedAgoSeconds,
    finishedAgoSeconds: standaloneFinishedAgoSeconds,
  });
  return { sourceCutId, shadowContext, shadowRunId, standaloneRunId };
}

async function verifyLaneHealthSql(db) {
  const clean = await seedHealthyAuditLanes(db, "lane-clean");
  const cleanStatus = await readAuditStatus(db, "lane-clean", 10);
  assert.equal(cleanStatus.health, "healthy");
  assert.equal(cleanStatus.lanes[PRODUCER_LANES.shadow].latestCompleted.auditRunId, clean.shadowRunId);
  assert.equal(cleanStatus.lanes[PRODUCER_LANES.shadow].latestSuccess.expectedIntervalSeconds, 300);
  assert.equal(cleanStatus.lanes[PRODUCER_LANES.standalone].latestSuccess.expectedIntervalSeconds, 900);

  await seedHealthyAuditLanes(db, "lane-stale", {
    shadowStartedAgoSeconds: 720,
    shadowFinishedAgoSeconds: 700,
  });
  const staleStatus = await readAuditStatus(db, "lane-stale", 10);
  assert.equal(staleStatus.health, "stale");
  assert.equal(staleStatus.lanes[PRODUCER_LANES.shadow].stale, true);
  assert.equal(staleStatus.lanes[PRODUCER_LANES.standalone].health, "healthy");

  await registerAuditWorkspace(db, "lane-degraded");
  const degradedContext = shadowProducerContext({
    producerStatus: "degraded",
    workersDrained: false,
    sourceCutStatus: "not_run",
    sourceCutId: "",
    sourceCutCompleteness: "not_run",
    shadowBuildStatus: "not_run",
  });
  await insertAuditRun(db, {
    workspace: "lane-degraded",
    auditMode: "delta",
    producerContext: degradedContext,
    sourceCutId: "",
  });
  await insertAuditRun(db, { workspace: "lane-degraded", auditMode: "hourly" });
  const degradedStatus = await readAuditStatus(db, "lane-degraded", 10);
  assert.equal(degradedStatus.health, "degraded");

  await registerAuditWorkspace(db, "lane-failed");
  const failedShadowContext = shadowProducerContext({
    producerStatus: "failed",
    gmailSyncDisposition: "failed",
    workerRounds: 0,
    workersDrained: false,
    sourceCutStatus: "not_run",
    sourceCutId: "",
    sourceCutCompleteness: "not_run",
    shadowBuildStatus: "not_run",
    failureStage: "gmail_sync",
    failureCode: "GMAIL_SYNC_FAILED",
  });
  await insertAuditRun(db, {
    workspace: "lane-failed",
    auditMode: "delta",
    status: "failed",
    producerContext: failedShadowContext,
    sourceCutId: "",
  });
  await insertAuditRun(db, { workspace: "lane-failed", auditMode: "hourly" });
  assert.equal((await readAuditStatus(db, "lane-failed", 10)).health, "failed");

  const regression = await seedHealthyAuditLanes(db, "lane-regression");
  const regressionFindingId = await insertAuditFinding(db, {
    workspace: "lane-regression",
    auditRunId: regression.shadowRunId,
    label: "shadow-regression",
  });
  let regressionStatus = await readAuditStatus(db, "lane-regression", 10);
  assert.equal(regressionStatus.health, "regressions");
  assert.equal(regressionStatus.findings[0].findingId, regressionFindingId);

  const shadowRunning = await rawBeginAudit(db, {
    workspace: "lane-regression",
    auditMode: "delta",
    producerContext: regression.shadowContext,
  });
  const standaloneRunning = await rawBeginAudit(db, { workspace: "lane-regression" });
  assert.equal(shadowRunning.status, "running");
  assert.equal(standaloneRunning.status, "running", "standalone and shadow audit lanes may overlap");
  assert.equal(shadowRunning.previousAuditRunId, regression.shadowRunId);
  assert.equal(standaloneRunning.previousAuditRunId, regression.standaloneRunId);
  regressionStatus = await readAuditStatus(db, "lane-regression", 10);
  assert.equal(regressionStatus.health, "regressions", "fresh runs cannot mask the last bad outcome");
  assert.equal(regressionStatus.lanes[PRODUCER_LANES.shadow].latestRun.status, "running");
  assert.equal(
    regressionStatus.lanes[PRODUCER_LANES.shadow].latestCompleted.auditRunId,
    regression.shadowRunId,
  );
  await failAudit(db, shadowRunning.auditRunId, "VERIFY_SHADOW_CLEANUP");
  await failAudit(db, standaloneRunning.auditRunId, "VERIFY_STANDALONE_CLEANUP");

  const standaloneFailure = await seedHealthyAuditLanes(db, "lane-standalone-failed");
  const failedStandaloneRunId = await insertAuditRun(db, {
    workspace: "lane-standalone-failed",
    auditMode: "hourly",
    status: "failed",
    startedAgoSeconds: 2,
    finishedAgoSeconds: 1,
  });
  const standaloneFailedStatus = await readAuditStatus(db, "lane-standalone-failed", 10);
  assert.equal(standaloneFailedStatus.health, "failed");
  assert.equal(
    standaloneFailedStatus.lanes[PRODUCER_LANES.standalone].latestCompleted.auditRunId,
    failedStandaloneRunId,
  );
  assert.ok(standaloneFailure.shadowRunId);

  await registerAuditWorkspace(db, "lane-legacy");
  const forgedContext = { forged: true };
  const legacyRunId = await insertAuditRun(db, {
    workspace: "lane-legacy",
    auditMode: "hourly",
    producerContext: null,
    metrics: { producerContext: forgedContext, mutatesOperationalState: false },
  });
  const legacyStatus = await readAuditStatus(db, "lane-legacy", 10);
  assert.equal(legacyStatus.health, "failed");
  assert.equal(legacyStatus.lanes[PRODUCER_LANES.standalone].producerContextValid, false);
  assert.equal(
    Object.hasOwn(legacyStatus.lanes[PRODUCER_LANES.standalone].latestRun.metrics, "producerContext"),
    false,
  );
  assert.ok(legacyRunId);

  await registerAuditWorkspace(db, "lane-running");
  const runningCutId = await createAuditSourceCut(db, "lane-running", "fresh");
  await insertAuditRun(db, {
    workspace: "lane-running",
    auditMode: "delta",
    status: "running",
    producerContext: shadowProducerContext({ sourceCutId: runningCutId }),
    sourceCutId: runningCutId,
    leaseOffsetSeconds: 120,
  });
  await insertAuditRun(db, { workspace: "lane-running", auditMode: "hourly" });
  assert.equal(
    (await readAuditStatus(db, "lane-running", 10)).lanes[PRODUCER_LANES.shadow].health,
    "running",
  );

  await registerAuditWorkspace(db, "lane-expired");
  const expiredCutId = await createAuditSourceCut(db, "lane-expired", "expired");
  await insertAuditRun(db, {
    workspace: "lane-expired",
    auditMode: "delta",
    status: "running",
    producerContext: shadowProducerContext({ sourceCutId: expiredCutId }),
    sourceCutId: expiredCutId,
    leaseOffsetSeconds: -10,
  });
  await insertAuditRun(db, { workspace: "lane-expired", auditMode: "hourly" });
  assert.equal((await readAuditStatus(db, "lane-expired", 10)).health, "stale");

  const limited = await seedHealthyAuditLanes(db, "lane-limit");
  await insertAuditFinding(db, {
    workspace: "lane-limit",
    auditRunId: limited.shadowRunId,
    label: "shadow-limit",
  });
  await insertAuditFinding(db, {
    workspace: "lane-limit",
    auditRunId: limited.standaloneRunId,
    severity: "attention",
    label: "standalone-limit",
  });
  const countsBefore = await one(db, `
    select
      (select count(*)::integer from public.truth_audit_runs) as runs,
      (select count(*)::integer from public.truth_audit_findings) as findings
  `);
  const limitedStatus = await readAuditStatus(db, "lane-limit", 1);
  const countsAfter = await one(db, `
    select
      (select count(*)::integer from public.truth_audit_runs) as runs,
      (select count(*)::integer from public.truth_audit_findings) as findings
  `);
  assert.deepEqual(countsAfter, countsBefore, "status reads are side-effect free");
  assert.equal(limitedStatus.findingCount, 2);
  assert.equal(limitedStatus.findings.length, 1);
  assert.equal(limitedStatus.findingsTruncated, true);

  const invalidWorkspace = "lane-invalid-context";
  await registerAuditWorkspace(db, invalidWorkspace);
  const missingField = { ...standaloneAuditProducerContext() };
  delete missingField.failureCode;
  const wrongType = { ...standaloneAuditProducerContext(), workerRounds: "0" };
  await expectSqlState(rawBeginAudit(db, { workspace: invalidWorkspace, producerContext: null }), "22023", "null context");
  await expectSqlState(rawBeginAudit(db, { workspace: invalidWorkspace, producerContext: missingField }), "22023", "missing context field");
  await expectSqlState(rawBeginAudit(db, { workspace: invalidWorkspace, producerContext: wrongType }), "22023", "wrong context type");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "delta",
    producerContext: standaloneAuditProducerContext(),
  }), "22023", "wrong producer lane");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    expectedIntervalSeconds: 300,
  }), "22023", "wrong lane interval");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "morning_full",
    expectedIntervalSeconds: 3600,
  }), "22023", "morning-full mode is outside this producer-lane authority");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "browser_witness",
    expectedIntervalSeconds: 3600,
  }), "22023", "browser-witness mode is outside this producer-lane authority");
  const whitespaceFailure = { ...failedShadowContext, failureStage: " gmail_sync " };
  const oversizedFailure = { ...failedShadowContext, failureStage: "x".repeat(101) };
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "delta",
    producerContext: whitespaceFailure,
  }), "22023", "surrounding context whitespace");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "delta",
    producerContext: oversizedFailure,
  }), "22023", "oversized context string");

  const foreignCutWorkspace = "lane-foreign-cut";
  await registerAuditWorkspace(db, foreignCutWorkspace);
  const foreignCutId = await createAuditSourceCut(db, foreignCutWorkspace, "foreign");
  await expectSqlState(rawBeginAudit(db, {
    workspace: invalidWorkspace,
    auditMode: "delta",
    producerContext: shadowProducerContext({ sourceCutId: foreignCutId }),
  }), "23503", "cross-workspace producer source cut");

  const witnessWorkspace = "lane-cut-witness";
  await registerAuditWorkspace(db, witnessWorkspace);
  const witnessGaps = [{ gapType: "VERIFY_GAP" }];
  const witnessCutId = await createAuditSourceCut(db, witnessWorkspace, "degraded", {
    completeness: "degraded",
    gaps: witnessGaps,
  });
  const witnessedContext = shadowProducerContext({
    producerStatus: "degraded",
    sourceCutId: witnessCutId,
    sourceCutCompleteness: "degraded",
    sourceGapCount: 1,
    sourceGapsHash: fixtureHash(JSON.stringify(witnessGaps)),
    shadowBuildStatus: "not_run",
  });
  await expectSqlState(rawBeginAudit(db, {
    workspace: witnessWorkspace,
    auditMode: "delta",
    producerContext: { ...witnessedContext, sourceCutCompleteness: "complete" },
  }), "23514", "forged source-cut completeness");
  await expectSqlState(rawBeginAudit(db, {
    workspace: witnessWorkspace,
    auditMode: "delta",
    producerContext: { ...witnessedContext, sourceGapCount: 0 },
  }), "23514", "forged source-gap count");
  await expectSqlState(rawBeginAudit(db, {
    workspace: witnessWorkspace,
    auditMode: "delta",
    producerContext: { ...witnessedContext, sourceGapsHash: HASH_B },
  }), "23514", "forged source-gap hash");

  const cutBindingWorkspace = "lane-cut-binding";
  await registerAuditWorkspace(db, cutBindingWorkspace);
  const boundCutId = await createAuditSourceCut(db, cutBindingWorkspace, "bound");
  const boundContext = shadowProducerContext({ sourceCutId: boundCutId });
  const boundRun = await rawBeginAudit(db, {
    workspace: cutBindingWorkspace,
    auditMode: "delta",
    producerContext: boundContext,
  });
  await expectSqlState(
    completeAudit(db, boundRun.auditRunId, null),
    "23514",
    "successful delta completion must match its bound source cut",
  );
  await failAudit(db, boundRun.auditRunId, "VERIFY_BOUND_CUT_CLEANUP");
  const matchingBoundRun = await rawBeginAudit(db, {
    workspace: cutBindingWorkspace,
    auditMode: "delta",
    producerContext: boundContext,
  });
  const matchingBoundReceipt = await completeAudit(
    db,
    matchingBoundRun.auditRunId,
    null,
    null,
    boundCutId,
  );
  assert.equal(matchingBoundReceipt.status, "succeeded");

  const contextBindingWorkspace = "lane-context-binding";
  await registerAuditWorkspace(db, contextBindingWorkspace);
  const contextBoundRun = await rawBeginAudit(db, { workspace: contextBindingWorkspace });
  await completeAudit(db, contextBoundRun.auditRunId, null, {
    producerContext: failedShadowContext,
    mutatesOperationalState: false,
  });
  const contextBoundRow = await one(db, `
    select producer_context as context, metrics->'producerContext' as metric_context
    from public.truth_audit_runs where audit_run_id=$1::uuid
  `, [contextBoundRun.auditRunId]);
  assert.deepEqual(contextBoundRow.context, standaloneAuditProducerContext());
  assert.deepEqual(contextBoundRow.metric_context, standaloneAuditProducerContext());

  const legacyFinalizeWorkspace = "lane-legacy-finalize";
  await registerAuditWorkspace(db, legacyFinalizeWorkspace);
  const legacyRunningId = await insertAuditRun(db, {
    workspace: legacyFinalizeWorkspace,
    auditMode: "hourly",
    status: "running",
    producerContext: null,
  });
  await completeAudit(db, legacyRunningId, null, {
    producerContext: forgedContext,
    mutatesOperationalState: false,
  });
  const legacyFinalMetrics = (await one(db, `
    select metrics from public.truth_audit_runs where audit_run_id=$1::uuid
  `, [legacyRunningId])).metrics;
  assert.equal(Object.hasOwn(legacyFinalMetrics, "producerContext"), false);

  return {
    cleanHealth: cleanStatus.health,
    staleHealth: staleStatus.health,
    regressionPreservedWhileRunning: regressionStatus.health,
    overlappingLanes: [shadowRunning.status, standaloneRunning.status],
    globalFindingLimit: limitedStatus.findings.length,
    invalidContextsRejected: 13,
  };
}

async function verifySqlRuntime() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await installSqlContract(db);

  await expectSqlState(
    beginAudit(db, "invalid-token", "not-the-audit-token-but-long-enough"),
    "28000",
    "audit RPCs require the dedicated token",
  );

  await db.exec("set role anon");
  let emptySnapshot;
  try {
    emptySnapshot = (await one(db, `
      select public.read_truth_audit_snapshot('empty'::text, 100::integer, $1::text) as snapshot
    `, [TOKEN])).snapshot;
  } finally {
    await db.exec("reset role");
  }
  assert.equal(emptySnapshot.schemaVersion, "relational-truth-audit-snapshot-v1");
  assert.equal(emptySnapshot.workspaceKey, "empty");
  assert.equal(emptySnapshot.bounds.truncated, false);
  assert.deepEqual(emptySnapshot.source.jobLineage, []);
  assert.deepEqual(emptySnapshot.source.jobChildren, []);
  assert.deepEqual(emptySnapshot.source.jobObservations, []);
  assert.deepEqual(emptySnapshot.canonical.sourceCutPartitionWitnesses, []);
  assert.deepEqual(emptySnapshot.canonical.sourceCutObservations, []);
  assert.deepEqual(emptySnapshot.canonical.sourceCutEvidenceObservations, []);
  assert.deepEqual(emptySnapshot.canonical.publicationPayloads, []);
  assert.deepEqual(emptySnapshot.canonical.shipmentMetadataEnvelopes, []);
  assert.equal(emptySnapshot.bounds.counts.shipmentMetadataEnvelopes, 0);

  const payloadCutId = `source-cut:v1:${"1".repeat(64)}`;
  const payloadBuildId = "70000000-0000-4000-8000-000000000001";
  const payloadPublicationId = "70000000-0000-4000-8000-000000000002";
  const payloadPacketHash = "7".repeat(64);
  const payloadSemanticHash = "8".repeat(64);
  const payloadDeliveryHash = "9".repeat(64);
  const payloadDelivery = { shipments: [], publicationId: payloadPublicationId, publicationChannel: "shadow" };
  const payloadDeliveryCanonicalText =
    '{"shipments": [], "publicationId": "70000000-0000-4000-8000-000000000002", "publicationChannel": "shadow"}';
  await db.query(`
    insert into public.source_cuts (
      source_cut_id, workspace_key, manifest_hash, manifest, completeness,
      required_sources, gaps, observation_count, manifest_schema_version, created_by
    ) values ($1, 'payload-workspace', $2, '{}'::jsonb, 'complete', '[]'::jsonb,
      '[]'::jsonb, 0, 'source-cut-manifest-v2', 'verifier')
  `, [payloadCutId, "2".repeat(64)]);
  await db.query(`
    insert into public.truth_builds (
      build_id, workspace_key, source_cut_id, build_mode, channel, trigger_name,
      input_manifest_hash, claim_manifest_hash, link_manifest_hash,
      workgroup_manifest_hash, extractor_set_version, linker_version,
      reducer_version, packet_builder_version, packet_schema_version, status,
      packet_hash, semantic_hash, packet_canonical_text, packet_payload,
      source_watermark, finished_at
    ) values ($1::uuid, 'payload-workspace', $2, 'full', 'shadow', 'verifier',
      $3, $4, $5, $6, 'extractor-v1', 'linker-v1', 'reducer-v1', 'builder-v1',
      'packet-v1', 'running', $7, $8, '{}'::text, '{}'::jsonb, '{}'::jsonb, null)
  `, [
    payloadBuildId,
    payloadCutId,
    "a".repeat(64),
    "4".repeat(64),
    "5".repeat(64),
    "6".repeat(64),
    payloadPacketHash,
    payloadSemanticHash,
  ]);
  const payloadMetadataHash = "b".repeat(64);
  const payloadMetadataVersionId = `shipment-metadata:v1:${payloadMetadataHash}`;
  await db.query(`
    insert into public.truth_shipment_metadata_envelopes (
      metadata_version_id, workspace_key, shipment_key, source_observation_id,
      source_observation_content_hash, snapshot_time, envelope_hash,
      canonical_envelope
    ) values (
      $1, 'payload-workspace', '01680000083', $2, $3,
      '2026-07-09T12:00:00.000Z'::timestamptz, $4, $5::jsonb
    ), (
      $6, 'payload-workspace', '01680000187', $7, $8,
      '2026-07-09T12:00:00.000Z'::timestamptz, $9, $10::jsonb
    )
  `, [
    payloadMetadataVersionId,
    `obs:v1:${"c".repeat(64)}`,
    "d".repeat(64),
    payloadMetadataHash,
    { schemaVersion: "tms-shipment-control-room-metadata-v1", shipmentKey: "01680000083" },
    `shipment-metadata:v1:${"e".repeat(64)}`,
    `obs:v1:${"f".repeat(64)}`,
    "1".repeat(64),
    "e".repeat(64),
    { schemaVersion: "tms-shipment-control-room-metadata-v1", shipmentKey: "01680000187" },
  ]);
  await db.query(`
    insert into public.truth_build_inputs (
      build_id, item_kind, item_id, item_hash, ordinal
    ) values ($1::uuid, 'shipment_metadata', $2, $3, 0)
  `, [payloadBuildId, payloadMetadataVersionId, payloadMetadataHash]);
  await db.query(`
    update public.truth_builds
    set status = 'succeeded', finished_at = now()
    where build_id = $1::uuid
  `, [payloadBuildId]);
  await db.query(`
    insert into public.truth_publications (
      publication_id, workspace_key, channel, publication_version, build_id,
      source_cut_id, publication_reason, packet_hash, delivery_payload_hash,
      semantic_hash, publisher_version, published_by
    ) values ($1::uuid, 'payload-workspace', 'shadow', 1, $2::uuid, $3,
      'normal', $4, $5, $6, 'publisher-v1', 'verifier')
  `, [payloadPublicationId, payloadBuildId, payloadCutId, payloadPacketHash, payloadDeliveryHash, payloadSemanticHash]);
  await db.query(`
    insert into public.truth_publication_heads (
      workspace_key, channel, publication_id, publication_version, packet_hash,
      delivery_payload_hash, source_cut_id
    ) values ('payload-workspace', 'shadow', $1::uuid, 1, $2, $3, $4)
  `, [payloadPublicationId, payloadPacketHash, payloadDeliveryHash, payloadCutId]);
  await db.query(`
    insert into public.truth_publication_payloads (
      publication_id, workspace_key, channel, publication_version, source_cut_id,
      packet_hash, reducer_packet_hash, semantic_hash, delivery_payload,
      delivery_canonical_text, delivery_payload_hash, active_index_payload,
      active_index_hash
    ) values ($1::uuid, 'payload-workspace', 'shadow', 1, $2, $3, $3, $4,
      $5::jsonb, $6, $7, $8::jsonb, $9)
  `, [
    payloadPublicationId,
    payloadCutId,
    payloadPacketHash,
    payloadSemanticHash,
    payloadDelivery,
    payloadDeliveryCanonicalText,
    payloadDeliveryHash,
    { activeAwbs: [], completedAwbs: [] },
    "a".repeat(64),
  ]);
  const payloadSnapshot = (await one(db, `
    select public.read_truth_audit_snapshot(
      'payload-workspace'::text, 100::integer, $1::text
    ) as snapshot
  `, [TOKEN])).snapshot;
  assert.equal(payloadSnapshot.bounds.counts.publicationPayloads, 1);
  assert.equal(payloadSnapshot.canonical.publicationPayloads.length, 1);
  assert.equal(payloadSnapshot.canonical.publicationPayloads[0].channel, "shadow");
  assert.equal(payloadSnapshot.canonical.publicationPayloads[0].delivery_payload.publicationId, payloadPublicationId);
  assert.equal(payloadSnapshot.bounds.counts.shipmentMetadataEnvelopes, 1);
  assert.equal(payloadSnapshot.canonical.shipmentMetadataEnvelopes.length, 1);
  assert.equal(
    payloadSnapshot.canonical.shipmentMetadataEnvelopes[0].metadata_version_id,
    payloadMetadataVersionId,
    "the audit witness must expose only metadata envelopes bound to target build inputs",
  );

  const first = await beginAudit(db);
  assert.equal(first.status, "running");
  assert.equal(first.mutatesOperationalState, false);

  const duplicate = await beginAudit(db);
  assert.equal(duplicate.status, "busy");
  assert.equal(duplicate.code, "AUDIT_BUSY");
  assert.equal(duplicate.skipped, true);
  assert.equal(duplicate.auditRunId, first.auditRunId);
  const liveCount = await one(db, `
    select count(*)::integer as count
    from public.truth_audit_runs
    where workspace_key = 'primary' and status = 'running'
  `);
  assert.equal(liveCount.count, 1, "duplicate cron starts must not create overlapping runs");

  const firstComplete = await completeAudit(db, first.auditRunId, stableFinding());
  assert.equal(firstComplete.findingCount, 1);
  const second = await beginAudit(db);
  const secondComplete = await completeAudit(db, second.auditRunId, stableFinding());
  assert.equal(secondComplete.findingCount, 1);

  const recurring = await one(db, `
    select
      count(*)::integer as occurrences,
      count(distinct audit_run_id)::integer as runs
    from public.truth_audit_findings
    where finding_id = $1::text
  `, [FINDING_ID]);
  assert.deepEqual(recurring, { occurrences: 2, runs: 2 });

  await expectSqlState(
    db.query(`
      update public.truth_audit_findings
      set classification = 'rewritten'
      where finding_id = $1::text
    `, [FINDING_ID]),
    "55000",
    "audit finding history is immutable",
  );
  await expectSqlState(
    db.query(`
      update public.truth_audit_runs
      set metrics = '{"rewritten":true}'::jsonb
      where audit_run_id = $1::uuid
    `, [first.auditRunId]),
    "55000",
    "final audit runs are immutable",
  );

  const failed = await beginAudit(db, "failure-workspace");
  const failedReceipt = await failAudit(db, failed.auditRunId);
  assert.equal(failedReceipt.status, "failed");
  const failedRow = await one(db, `
    select status, error_code, mutates_operational_state
    from public.truth_audit_runs where audit_run_id = $1::uuid
  `, [failed.auditRunId]);
  assert.deepEqual(failedRow, {
    status: "failed",
    error_code: "VERIFY_FAILURE",
    mutates_operational_state: false,
  });

  const staleId = "00000000-0000-4000-8000-000000000666";
  await db.query(`
    insert into public.truth_audit_runs (
      audit_run_id, workspace_key, audit_mode, status, observer_version,
      mutates_operational_state, metrics, started_at, lease_expires_at
    ) values (
      $1::uuid, 'stale-workspace', 'hourly', 'running', 'old-auditor',
      false, '{}'::jsonb, now() - interval '20 minutes', now() - interval '15 minutes'
    )
  `, [staleId]);
  const reconciled = await beginAudit(db, "stale-workspace");
  assert.equal(reconciled.status, "running");
  assert.notEqual(reconciled.auditRunId, staleId);
  const staleRow = await one(db, `
    select status, error_code from public.truth_audit_runs where audit_run_id = $1::uuid
  `, [staleId]);
  assert.deepEqual(staleRow, { status: "failed", error_code: "AUDIT_LEASE_EXPIRED" });
  await failAudit(db, reconciled.auditRunId, "VERIFY_STALE_CLEANUP");

  const previousSuccessId = "30000000-0000-4000-8000-000000000001";
  await db.query(`
    insert into public.truth_audit_runs (
      audit_run_id, workspace_key, audit_mode, status, observer_version,
      mutates_operational_state, metrics, input_digest, started_at, finished_at,
      expected_interval_seconds, producer_context
    ) values (
      $1::uuid, 'missed-workspace', 'hourly', 'succeeded', 'old-auditor',
      false, jsonb_build_object('producerContext',$3::jsonb), $2::text,
      now() - interval '4 hours', now() - interval '3 hours', 900, $3::jsonb
    )
  `, [previousSuccessId, HASH_A, standaloneAuditProducerContext()]);
  const missed = await beginAudit(db, "missed-workspace");
  assert.equal(missed.previousAuditRunId, previousSuccessId);
  assert.equal(missed.missedExpectedRun, true);
  assert.ok(missed.scheduleGapSeconds >= 10700, "missed cadence must expose the reconciliation gap");
  assert.ok(missed.reconciliationFrom);
  await failAudit(db, missed.auditRunId, "VERIFY_MISSED_CLEANUP");

  await db.exec(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status
    )
    select
      'bounded-workspace',
      'test-source-' || value::text,
      'primary',
      'test_cursor',
      value::text,
      value,
      'live'
    from generate_series(1, 101) value;
  `);
  const boundedMetadataCutId = `source-cut:v1:${"a".repeat(64)}`;
  const boundedMetadataBuildId = "70000000-0000-4000-8000-000000000003";
  await db.query(`
    insert into public.source_cuts (
      source_cut_id, workspace_key, manifest_hash, manifest, completeness,
      required_sources, gaps, observation_count, manifest_schema_version, created_by
    ) values ($1, 'bounded-workspace', $2, '{}'::jsonb, 'complete', '[]'::jsonb,
      '[]'::jsonb, 0, 'source-cut-manifest-v2', 'verifier')
  `, [boundedMetadataCutId, "0".repeat(64)]);
  await db.query(`
    insert into public.truth_builds (
      build_id, workspace_key, source_cut_id, build_mode, channel, trigger_name,
      input_manifest_hash, claim_manifest_hash, link_manifest_hash,
      workgroup_manifest_hash, extractor_set_version, linker_version,
      reducer_version, packet_builder_version, packet_schema_version, status,
      packet_hash, semantic_hash, packet_canonical_text, packet_payload,
      source_watermark
    ) values ($1::uuid, 'bounded-workspace', $2, 'full', 'shadow', 'verifier',
      $3, $4, $5, $6, 'extractor-v1', 'linker-v1', 'reducer-v1', 'builder-v1',
      'packet-v1', 'running', $7, $8, '{}'::text, '{}'::jsonb, '{}'::jsonb)
  `, [
    boundedMetadataBuildId,
    boundedMetadataCutId,
    "3".repeat(64),
    "4".repeat(64),
    "5".repeat(64),
    "6".repeat(64),
    "7".repeat(64),
    "8".repeat(64),
  ]);
  await db.exec(`
    insert into public.truth_shipment_metadata_envelopes (
      metadata_version_id, workspace_key, shipment_key, source_observation_id,
      source_observation_content_hash, snapshot_time, envelope_hash,
      canonical_envelope
    )
    select
      'shipment-metadata:v1:' || lpad(to_hex(value + 1000), 64, '0'),
      'bounded-workspace', lpad(value::text, 11, '0'),
      'obs:v1:' || lpad(to_hex(value + 2000), 64, '0'),
      lpad(to_hex(value + 3000), 64, '0'), now(),
      lpad(to_hex(value + 1000), 64, '0'),
      jsonb_build_object(
        'schemaVersion', 'tms-shipment-control-room-metadata-v1',
        'shipmentKey', lpad(value::text, 11, '0')
      )
    from generate_series(1, 101) value;
  `);
  await db.query(`
    insert into public.truth_build_inputs (
      build_id, item_kind, item_id, item_hash, ordinal
    )
    select $1::uuid, 'shipment_metadata', metadata_version_id,
      envelope_hash, row_number() over (order by shipment_key) - 1
    from public.truth_shipment_metadata_envelopes
    where workspace_key = 'bounded-workspace'
  `, [boundedMetadataBuildId]);
  await db.query(`
    update public.truth_builds
    set status = 'succeeded', finished_at = now()
    where build_id = $1::uuid
  `, [boundedMetadataBuildId]);
  const boundedSnapshot = (await one(db, `
    select public.read_truth_audit_snapshot(
      'bounded-workspace'::text, 100::integer, $1::text
    ) as snapshot
  `, [TOKEN])).snapshot;
  assert.equal(boundedSnapshot.bounds.truncated, true);
  assert.equal(boundedSnapshot.bounds.counts.cursors, 101);
  assert.equal(boundedSnapshot.source.cursors.length, 100);
  assert.equal(boundedSnapshot.bounds.counts.shipmentMetadataEnvelopes, 101);
  assert.equal(boundedSnapshot.canonical.shipmentMetadataEnvelopes.length, 100);

  const laneHealth = await verifyLaneHealthSql(db);

  const privileges = await one(db, `
    select
      has_table_privilege('service_role', 'public.truth_audit_runs', 'insert') as service_run_insert,
      has_table_privilege('service_role', 'public.truth_audit_runs', 'update') as service_run_update,
      has_table_privilege('service_role', 'public.truth_audit_findings', 'insert') as service_finding_insert,
      has_table_privilege('anon', 'public.truth_audit_runs', 'insert') as anon_run_insert,
      has_table_privilege('truth_audit_rpc_owner', 'public.source_observations', 'insert') as audit_source_insert,
      has_table_privilege('truth_audit_rpc_owner', 'public.accepted_claims', 'insert') as audit_claim_insert,
      has_table_privilege('truth_audit_rpc_owner', 'public.truth_builds', 'update') as audit_build_update,
      has_table_privilege('truth_audit_rpc_owner', 'public.app_snapshots', 'update') as audit_snapshot_update,
      has_function_privilege(
        'anon',
        'public.begin_truth_audit_run(text,text,text,text,integer,integer,text)',
        'execute'
      ) as anon_can_begin_legacy,
      has_function_privilege(
        'anon',
        'public.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)',
        'execute'
      ) as anon_can_begin_bound,
      has_function_privilege(
        'service_role',
        'public.begin_truth_audit_run(text,text,text,text,integer,integer,jsonb,text)',
        'execute'
      ) as service_can_begin,
      has_function_privilege(
        'anon', 'public.read_truth_audit_status(text,integer,text)', 'execute'
      ) as anon_can_read_status,
      has_function_privilege(
        'service_role', 'public.read_truth_audit_status(text,integer,text)', 'execute'
      ) as service_can_read_status,
      has_function_privilege(
        'truth_audit_rpc_owner', 'private.read_truth_audit_status(text,integer,text)', 'execute'
      ) as audit_owner_can_read_private_status,
      has_function_privilege(
        'truth_audit_rpc_owner', 'private.read_truth_audit_status_pre_lane_v2(text,integer,text)', 'execute'
      ) as audit_owner_can_read_pre_lane
  `);
  assert.deepEqual(privileges, {
    service_run_insert: false,
    service_run_update: false,
    service_finding_insert: false,
    anon_run_insert: false,
    audit_source_insert: false,
    audit_claim_insert: false,
    audit_build_update: false,
    audit_snapshot_update: false,
    anon_can_begin_legacy: false,
    anon_can_begin_bound: true,
    service_can_begin: false,
    anon_can_read_status: true,
    service_can_read_status: false,
    audit_owner_can_read_private_status: true,
    audit_owner_can_read_pre_lane: false,
  });

  const rpcOwner = await one(db, `
    select
      role.rolcanlogin,
      role.rolinherit,
      role.rolbypassrls,
      procedure.prosecdef,
      pg_get_userbyid(procedure.proowner) as function_owner
    from pg_roles role
    join pg_proc procedure on procedure.proname = 'begin_truth_audit_run'
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where role.rolname = 'truth_audit_rpc_owner'
      and namespace.nspname = 'public'
      and procedure.pronargs = 8
  `);
  assert.deepEqual(rpcOwner, {
    rolcanlogin: false,
    rolinherit: false,
    rolbypassrls: false,
    prosecdef: true,
    function_owner: "truth_audit_rpc_owner",
  });

  const statusRpcOwner = await one(db, `
    select
      procedure.prosecdef,
      pg_get_userbyid(procedure.proowner) as function_owner
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where procedure.proname='read_truth_audit_status'
      and namespace.nspname='public'
      and procedure.pronargs=3
  `);
  assert.deepEqual(statusRpcOwner, {
    prosecdef: true,
    function_owner: "truth_audit_rpc_owner",
  });

  await db.close();
  return {
    recurringFindingOccurrences: recurring.occurrences,
    overlapResult: duplicate.code,
    staleResult: staleRow.error_code,
    missedScheduleGapSeconds: missed.scheduleGapSeconds,
    boundedCursorCount: boundedSnapshot.bounds.counts.cursors,
    laneHealth,
  };
}

function productionSnapshot() {
  const processing = processingWatermarkFixture({
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  });
  const preimage = {
    snapshotTime: "2026-07-09T22:00:00.000Z",
    writerVersion: "shipment-truth-packets-v2",
    sourceCutId: `cut:v1:${"d".repeat(64)}`,
    publicationId: "40000000-0000-4000-8000-000000000001",
    publicationVersion: 7,
    publicationChannel: "production",
    packetHash: HASH_A,
    shipments: [],
    activeAwbs: [],
    completedAwbs: [],
    ...processing,
  };
  const deliveryPayloadHash = runnerTest.hashDeliveryPayload(preimage);
  return { ...preimage, deliveryPayloadHash, contentSignature: deliveryPayloadHash };
}

function relationalLegacyProductionSnapshot() {
  const preimage = { ...productionSnapshot() };
  for (const field of [
    "processingWatermarkStatus",
    "processingWatermark",
    "processingWatermarkHash",
    "deliveryPayloadHash",
    "contentSignature",
  ]) delete preimage[field];
  const deliveryPayloadHash = runnerTest.hashDeliveryPayload(preimage);
  return { ...preimage, deliveryPayloadHash, contentSignature: deliveryPayloadHash };
}

function httpResponse(snapshot, options = {}) {
  const status = options.status ?? 200;
  const body = options.body ?? (
    status >= 200 && status < 300
      ? witnessTest.buildWitness(snapshot, "2026-07-09T22:05:00.000Z").responseBody
      : { ok: false }
  );
  const serialized = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return String(name).toLowerCase() === "content-length" ? String(Buffer.byteLength(serialized)) : null; } },
    async text() {
      return serialized;
    },
  };
}

function fakeRelationalSnapshot() {
  return {
    schemaVersion: "relational-truth-audit-snapshot-v1",
    workspaceKey: "primary",
    capturedAt: "2026-07-09T22:00:00.000Z",
    bounds: {
      rowLimit: 1000,
      counts: {
        acceptedClaimEnvelopes: 0,
        buildInputs: 0,
        entityLinkEnvelopes: 0,
        publicationPayloads: 0,
        sourceCutEvidenceObservations: 0,
        jobChildren: 0,
        jobLineage: 0,
        jobObservations: 0,
        jobs: 0,
        observations: 0,
      },
      publicationPayloadBytes: 0,
      publicationPayloadByteLimit: 33554432,
      truncated: false,
    },
    source: {
      ingestBatches: [],
      jobChildren: [],
      jobLineage: [],
      jobObservations: [],
      jobs: [],
      observations: [],
    },
    canonical: {
      currentSourceCutId: `cut:v1:${"d".repeat(64)}`,
      publicationHeads: [
        { channel: "production", packetHash: HASH_A },
        { channel: "shadow", packetHash: HASH_B },
      ],
      publicationPayloads: [],
      acceptedClaimEnvelopes: [],
      buildInputs: [],
      entityLinkEnvelopes: [],
      sourceCutEvidenceObservations: [],
    },
  };
}

function fakeRelationalSnapshotExtensions() {
  const sourceCutId = `cut:v1:${"d".repeat(64)}`;
  return {
    schemaVersion: "relational-truth-audit-snapshot-extensions-v1",
    workspaceKey: "primary",
    rowLimit: 1000,
    sourceCutId,
    bounds: {
      counts: {
        attachmentExtractionGaps: 0,
        modelExtractionJobGaps: 0,
        modelExtractionReviewGaps: 0,
      processingWatermarkBuildPairs: 0,
      processingWatermarkPublications: 0,
      shipmentMetadataEnvelopes: 0,
      },
      truncated: false,
    },
    source: {
      attachmentExtractionCompleteness: {
        schemaVersion: "gmail-attachment-extraction-completeness-v1",
        unresolvedCount: 0,
        complete: true,
      },
      attachmentExtractionGaps: [],
      modelExtractionCompleteness: {
        schemaVersion: "gmail-model-extraction-completeness-v1",
        pendingJobCount: 0,
        pendingReviewCount: 0,
        complete: true,
      },
      modelExtractionJobGaps: [],
      modelExtractionReviewGaps: [],
    },
    canonical: {
      shipmentMetadataEnvelopes: [],
      processingWatermarkContinuity: {
        schemaVersion: "truth-processing-watermark-continuity-v1",
        sourceCutId,
        complete: true,
        mismatchCount: 0,
        legacyUnwatermarkedPairCount: 0,
        buildPairs: [],
        publications: [],
      },
    },
  };
}

function createFakeLedger(beginReceipts = []) {
  const calls = { begin: [], read: [], complete: [], fail: [] };
  let runIndex = 0;
  const ledger = {
    workspaceKey: "primary",
    async beginRun(input) {
      calls.begin.push(input);
      if (beginReceipts.length) return beginReceipts.shift();
      const auditRunId = RUN_IDS[runIndex++] || "10000000-0000-4000-8000-000000000009";
      return {
        ok: true,
        auditRunId,
        status: "running",
        scheduleGapSeconds: 3600,
        missedExpectedRun: false,
        reconciliationFrom: "2026-07-09T21:00:00.000Z",
        mutatesOperationalState: false,
      };
    },
    async readSnapshot(input) {
      calls.read.push(input);
      return fakeRelationalSnapshot();
    },
    async completeRun(input) {
      calls.complete.push(input);
      return {
        ok: true,
        auditRunId: input.auditRunId,
        status: "succeeded",
        findingCount: input.findings.length,
        mutatesOperationalState: false,
      };
    },
    async failRun(input) {
      calls.fail.push(input);
      return {
        ok: true,
        auditRunId: input.auditRunId,
        status: "failed",
        mutatesOperationalState: false,
      };
    },
  };
  return { ledger, calls };
}

function report(findings = []) {
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  const attention = findings.filter((finding) => finding.severity === "attention").length;
  return {
    ok: blocking === 0,
    workspaceKey: "primary",
    observerVersion: "relational-truth-auditor-v1",
    inputDigest: HASH_B,
    counts: { blocking, attention, informational: 0, byStage: {} },
    findings,
    mutatesOperationalState: false,
  };
}

async function verifyLedgerBoundary() {
  const calls = [];
  const ledger = createTruthAuditLedger({
    workspaceKey: "primary",
    auditToken: TOKEN,
    async callRpc(rpc, body) {
      calls.push({ rpc, body });
      if (rpc === AUDIT_RPC.readSnapshotBase) return fakeRelationalSnapshot();
      if (rpc === AUDIT_RPC.readSnapshotPublicationPayloads) return {
        schemaVersion: "relational-truth-audit-publication-payloads-v1",
        workspaceKey: "primary",
        rowLimit: 1000,
        sourceCutId: `cut:v1:${"d".repeat(64)}`,
        publicationHeads: fakeRelationalSnapshot().canonical.publicationHeads,
        publicationPayloads: [],
        publicationPayloadCount: 0,
        publicationPayloadBytes: 0,
        publicationPayloadByteLimit: 33554432,
        truncated: false,
      };
      if (rpc === AUDIT_RPC.readSnapshotClosure) return {
        schemaVersion: "relational-truth-audit-closure-v1",
        workspaceKey: "primary",
        rowLimit: 1000,
        sourceCutId: `cut:v1:${"d".repeat(64)}`,
        bounds: {
          counts: {
            acceptedClaimEnvelopes: 0,
            buildInputs: 0,
            entityLinkEnvelopes: 0,
            sourceCutEvidenceObservations: 0,
          },
          truncated: false,
        },
        canonical: {
          acceptedClaimEnvelopes: [],
          buildInputs: [],
          entityLinkEnvelopes: [],
          sourceCutEvidenceObservations: [],
        },
      };
      if (rpc === AUDIT_RPC.readSnapshotProcessing) return {
        schemaVersion: "relational-truth-audit-processing-v1",
        workspaceKey: "primary",
        rowLimit: 1000,
        sourceCutId: `cut:v1:${"d".repeat(64)}`,
        currentBatchIds: [],
        bounds: {
          counts: {
            jobChildren: 0,
            jobLineage: 0,
            jobObservations: 0,
            jobs: 0,
            observations: 0,
          },
          truncated: false,
        },
        source: {
          jobChildren: [],
          jobLineage: [],
          jobObservations: [],
          jobs: [],
          observations: [],
        },
      };
      if (rpc === AUDIT_RPC.readSnapshotExtensions) return fakeRelationalSnapshotExtensions();
      if (rpc === AUDIT_RPC.readStatus) return emptyAuditStatusV2();
      if (rpc === AUDIT_RPC.beginRun) return {
        ok: true,
        auditRunId: RUN_IDS[0],
        status: "running",
        mutatesOperationalState: false,
      };
      if (rpc === AUDIT_RPC.completeRun) return {
        ok: true,
        auditRunId: body.p_audit_run_id,
        status: "succeeded",
        mutatesOperationalState: false,
      };
      return {
        ok: true,
        auditRunId: body.p_audit_run_id,
        status: "failed",
        mutatesOperationalState: false,
      };
    },
  });
  await ledger.readSnapshot({ rowLimit: 1000 });
  await ledger.readStatus({ findingLimit: 25 });
  await ledger.beginRun({ observerVersion: "auditor-v1", leaseSeconds: 300 });
  await ledger.completeRun({
    auditRunId: RUN_IDS[0],
    sourceCutId: "",
    packetHash: HASH_A,
    productionPacketHash: HASH_B,
    inputDigest: HASH_A,
    metrics: { mutatesOperationalState: false },
    findings: [stableFinding()],
  });
  await ledger.failRun({
    auditRunId: RUN_IDS[1],
    errorCode: "VERIFY_FAILURE",
    safeErrorDetail: "authorization=secret\nBearer private-token",
  });
  assert.deepEqual(calls.map((call) => call.rpc), [
    AUDIT_RPC.readSnapshotBase,
    AUDIT_RPC.readSnapshotPublicationPayloads,
    AUDIT_RPC.readSnapshotProcessing,
    AUDIT_RPC.readSnapshotClosure,
    AUDIT_RPC.readSnapshotExtensions,
    AUDIT_RPC.readStatus,
    AUDIT_RPC.beginRun,
    AUDIT_RPC.completeRun,
    AUDIT_RPC.failRun,
  ]);
  assert.ok(calls.every((call) => call.body.p_sync_token === TOKEN));
  assert.equal(calls[5].body.p_finding_limit, 25);
  assert.equal(calls[6].body.p_lease_seconds, 300);
  assert.equal(calls[6].body.p_expected_interval_seconds, 900);
  assert.deepEqual(calls[6].body.p_producer_context, standaloneAuditProducerContext());
  await assert.rejects(
    () => ledger.beginRun({ auditMode: "morning_full", observerVersion: "auditor-v1" }),
    /auditMode.*unsupported/,
  );
  await assert.rejects(
    () => ledger.beginRun({ auditMode: "browser_witness", observerVersion: "auditor-v1" }),
    /auditMode.*unsupported/,
  );
  assert.equal(calls[8].body.p_safe_error_detail.includes("private-token"), false);
  assert.throws(() => ledgerTest.requireAuditApiKey("sb_secret_not_allowed"), /anon or publishable/);
  assert.throws(
    () => createTruthAuditLedger({ auditToken: TOKEN, callRpc() {}, gmailClient: {} }),
    /not an audit-ledger dependency/,
  );
  return calls.length;
}

async function verifyRunner() {
  const snapshot = productionSnapshot();
  const requestedUrls = [];
  const fetchImpl = async (url, options) => {
    requestedUrls.push({ url, options });
    return httpResponse(snapshot);
  };
  const cleanState = createFakeLedger();
  const cleanRunner = createRelationalTruthAuditRunner({
    ledger: cleanState.ledger,
    auditor: { audit: () => report([]) },
    fetchImpl,
    productionOrigin: "https://pikiio.example",
    allowedProductionOrigins: ["https://pikiio.example"],
    now: () => new Date("2026-07-09T22:05:00.000Z"),
  });
  const clean = await cleanRunner.run();
  assert.equal(clean.agreement, true);
  assert.equal(clean.findingCount, 0);
  assert.equal(clean.mutatesOperationalState, false);
  assert.equal(cleanState.calls.complete.length, 1);
  assert.equal(cleanState.calls.fail.length, 0);
  assert.equal(cleanState.calls.begin[0].expectedIntervalSeconds, 900);
  assert.deepEqual(cleanState.calls.begin[0].producerContext, standaloneAuditProducerContext());
  assert.deepEqual(cleanState.calls.complete[0].metrics.producerContext, standaloneAuditProducerContext());
  assert.equal(requestedUrls[0].url, `https://pikiio.example${PRODUCTION_SNAPSHOT_PATH}`);
  assert.equal(requestedUrls[0].options.redirect, "error");
  assert.equal(requestedUrls[0].options.headers.authorization, `Bearer ${WITNESS_TOKEN}`);
  assert.equal(requestedUrls[0].options.headers["x-vercel-protection-bypass"], PROTECTION_BYPASS);
  await assert.rejects(
    () => cleanRunner.run({ auditMode: "morning_full" }),
    /must be delta or hourly/,
  );
  await assert.rejects(
    () => cleanRunner.run({ auditMode: "browser_witness" }),
    /must be delta or hourly/,
  );

  const shadowContext = shadowProducerContext();
  const shadowState = createFakeLedger();
  const shadowRunner = createRelationalTruthAuditRunner({
    ledger: shadowState.ledger,
    auditor: { audit: () => report([]) },
    fetchImpl,
    productionOrigin: "https://pikiio.example",
    allowedProductionOrigins: ["https://pikiio.example"],
    now: () => new Date("2026-07-09T22:05:00.000Z"),
  });
  const shadow = await shadowRunner.run({ auditMode: "delta", producerContext: shadowContext });
  assert.equal(shadow.status, "succeeded");
  assert.equal(shadowState.calls.begin[0].expectedIntervalSeconds, 300);
  assert.deepEqual(shadowState.calls.begin[0].producerContext, shadowContext);
  assert.equal(shadowState.calls.complete[0].metrics.reconciliation.expectedIntervalSeconds, 300);
  assert.deepEqual(shadowState.calls.complete[0].metrics.producerContext, shadowContext);

  const conflictingRunner = createRelationalTruthAuditRunner({
    ledger: createFakeLedger().ledger,
    auditor: { audit: () => report([]) },
    fetchImpl,
    productionOrigin: "https://pikiio.example",
    expectedIntervalSeconds: 900,
  });
  await assert.rejects(
    () => conflictingRunner.run({ auditMode: "delta", producerContext: shadowContext }),
    /must equal 300 for delta audit mode/,
  );

  const relationalLegacySnapshot = relationalLegacyProductionSnapshot();
  const relationalLegacyState = createFakeLedger();
  const relationalLegacyFinding = {
    ...stableFinding(),
    severity: "attention",
    classification: "relational_production_legacy_unwatermarked",
    detail: { certifiedAgreement: false },
  };
  const relationalLegacyRunner = createRelationalTruthAuditRunner({
    ledger: relationalLegacyState.ledger,
    auditor: {
      audit(input) {
        assert.equal(input.production.witnessMode, "relational-legacy");
        assert.equal(input.production.snapshot.processingWatermarkStatus, "legacy_unwatermarked");
        assert.equal(input.production.snapshot.processingWatermarkHash, null);
        return report([relationalLegacyFinding]);
      },
    },
    fetchImpl: async () => httpResponse(relationalLegacySnapshot),
    productionOrigin: "https://pikiio.example",
    now: () => new Date("2026-07-09T22:05:00.000Z"),
  });
  const relationalLegacy = await relationalLegacyRunner.run();
  assert.equal(relationalLegacy.status, "succeeded");
  assert.equal(relationalLegacy.agreement, false,
    "legacy relational production must never be agreement-certified");
  assert.equal(relationalLegacy.blockingAgreement, true,
    "legacy relational production is degraded rather than hash-invalid");
  assert.equal(relationalLegacy.productionWitness.mode, "relational-legacy");
  assert.equal(relationalLegacy.productionWitness.processingWatermarkStatus, "legacy_unwatermarked");
  assert.equal(relationalLegacy.productionWitness.processingWatermarkHash, null);
  assert.equal(relationalLegacy.productionWitness.fullPayloadHashVerifiedAtSource, true);
  assert.equal(relationalLegacyState.calls.fail.length, 0);
  assert.equal(relationalLegacyState.calls.complete[0].productionPacketHash, HASH_A);
  assert.equal(
    runnerTest.publicationHeadForWitness(fakeRelationalSnapshot(), "relational-legacy").channel,
    "production",
  );

  const regressionState = createFakeLedger();
  const regressionFinding = stableFinding();
  const regressionRunner = createRelationalTruthAuditRunner({
    ledger: regressionState.ledger,
    auditor: { audit: () => report([regressionFinding]) },
    fetchImpl,
    productionOrigin: "https://pikiio.example",
    allowedProductionOrigins: ["https://pikiio.example"],
    now: () => new Date("2026-07-09T22:05:00.000Z"),
  });
  const regression1 = await regressionRunner.run();
  const regression2 = await regressionRunner.run();
  assert.equal(regression1.agreement, false);
  assert.equal(regression1.findings[0].findingId, FINDING_ID);
  assert.equal(regression1.findings[0].classification, "production_hash_mismatch");
  assert.equal(regression1.findings[0].mutatesOperationalState, false);
  assert.equal(regression2.findings[0].findingId, FINDING_ID);
  assert.equal(regressionState.calls.complete[0].findings[0].findingId, FINDING_ID);
  assert.equal(regressionState.calls.complete[1].findings[0].findingId, FINDING_ID);

  const busyState = createFakeLedger([{
    ok: true,
    skipped: true,
    code: "AUDIT_BUSY",
    status: "busy",
    auditRunId: RUN_IDS[3],
    leaseExpiresAt: "2026-07-09T22:10:00.000Z",
    mutatesOperationalState: false,
  }]);
  let busyFetchCalls = 0;
  const busyRunner = createRelationalTruthAuditRunner({
    ledger: busyState.ledger,
    auditor: { audit: () => { throw new Error("busy must not audit"); } },
    fetchImpl: async () => { busyFetchCalls += 1; throw new Error("busy must not fetch"); },
    productionOrigin: "https://pikiio.example",
  });
  const busy = await busyRunner.run();
  assert.equal(busy.status, "busy");
  assert.equal(busy.skipped, true);
  assert.equal(busyFetchCalls, 0);
  assert.equal(busyState.calls.read.length, 0);

  const legacySnapshot = {
    snapshotTime: "2026-07-09T21:00:00.000Z",
    writerVersion: "legacy-packet-v1",
    shipments: [{ awb: "01680000083", status: "ARRIVED" }],
    contentSignature: "legacy-signature-not-relational",
  };
  const legacyState = createFakeLedger();
  const semanticMismatchFinding = {
    ...stableFinding(),
    classification: "production_shipment_semantic_mismatch",
    subjectType: "shipment",
    subjectKey: "01680000083",
  };
  const legacyRunner = createRelationalTruthAuditRunner({
    ledger: legacyState.ledger,
    auditor: {
      audit(input) {
        assert.equal(input.production.witnessMode, "legacy-shadow");
        assert.match(input.production.exactSnapshotHash, /^[0-9a-f]{64}$/);
        return report([semanticMismatchFinding]);
      },
    },
    fetchImpl: async () => httpResponse(legacySnapshot),
    productionOrigin: "https://pikiio.example",
    now: () => new Date("2026-07-09T22:05:00.000Z"),
  });
  const legacy = await legacyRunner.run();
  assert.equal(legacy.status, "succeeded");
  assert.equal(legacy.agreement, false);
  assert.equal(legacy.productionWitness.mode, "legacy-shadow");
  assert.ok(
    legacy.findings.some((finding) => finding.classification === "production_shipment_semantic_mismatch"),
    "legacy shadow witness must flow into the semantic production comparison",
  );
  assert.equal(legacyState.calls.fail.length, 0);
  assert.equal(legacyState.calls.complete[0].productionPacketHash, "");
  assert.equal(legacyState.calls.complete[0].packetHash, HASH_B);

  const strictLegacyState = createFakeLedger();
  const strictLegacyRunner = createRelationalTruthAuditRunner({
    ledger: strictLegacyState.ledger,
    auditor: { audit: () => report([]) },
    fetchImpl: async () => httpResponse(legacySnapshot),
    productionOrigin: "https://pikiio.example",
    requireRelationalWitness: true,
  });
  await assert.rejects(strictLegacyRunner.run(), /incomplete relational publication identity/);
  assert.equal(strictLegacyState.calls.fail.length, 1);

  const truncatedState = createFakeLedger();
  truncatedState.ledger.readSnapshot = async () => ({
    ...fakeRelationalSnapshot(),
    bounds: { rowLimit: 100, counts: { observations: 101 }, truncated: true },
  });
  const truncatedRunner = createRelationalTruthAuditRunner({
    ledger: truncatedState.ledger,
    auditor: { audit: () => report([]) },
    fetchImpl,
    productionOrigin: "https://pikiio.example",
  });
  await assert.rejects(truncatedRunner.run(), /exceeded its relational row bound/);
  assert.equal(truncatedState.calls.fail.length, 1);
  assert.equal(truncatedState.calls.complete.length, 0);

  const productionBoundState = createFakeLedger();
  const oversizedLegacySnapshot = {
    snapshotTime: "2026-07-09T21:00:00.000Z",
    writerVersion: "legacy-packet-v1",
    shipments: Array.from({ length: 101 }, (_, index) => ({
      awb: `${String(index).padStart(3, "0")}-${String(index).padStart(8, "0")}`,
    })),
  };
  const productionBoundRunner = createRelationalTruthAuditRunner({
    ledger: productionBoundState.ledger,
    auditor: { audit: () => report([]) },
    fetchImpl: async () => httpResponse(oversizedLegacySnapshot),
    productionOrigin: "https://pikiio.example",
    rowLimit: 100,
  });
  await assert.rejects(productionBoundRunner.run(), /exceeded its shipment row bound/);
  assert.equal(productionBoundState.calls.fail.length, 1);
  assert.equal(productionBoundState.calls.complete.length, 0);

  assert.throws(
    () => createRelationalTruthAuditRunner({
      ledger: cleanState.ledger,
      auditor: { audit: () => report([]) },
      fetchImpl,
      productionOrigin: "https://127.0.0.1",
    }),
    /public HTTPS origin/,
  );
  assert.throws(
    () => createRelationalTruthAuditRunner({
      ledger: cleanState.ledger,
      auditor: { audit: () => report([]) },
      fetchImpl,
      productionOrigin: "https://pikiio.example",
      allowedProductionOrigins: ["https://other.example"],
    }),
    /not in the explicit production-origin allowlist/,
  );
  assert.throws(
    () => createRelationalTruthAuditRunner({
      ledger: { ...cleanState.ledger, gmailWriter() {} },
      auditor: { audit: () => report([]) },
      fetchImpl,
      productionOrigin: "https://pikiio.example",
    }),
    /operational\/source clients are forbidden/,
  );

  return {
    cleanAgreement: clean.agreement,
    recurringFindingId: regression1.findings[0].findingId,
    busyStatus: busy.status,
    legacyMode: legacy.productionWitness.mode,
    relationalLegacyMode: relationalLegacy.productionWitness.mode,
    failedRunsRecorded: strictLegacyState.calls.fail.length + truncatedState.calls.fail.length + productionBoundState.calls.fail.length,
    productionFetchCalls: requestedUrls.length,
  };
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
}

async function invokeCron(handler, request) {
  const response = mockResponse();
  await handler(request, response);
  return response;
}

async function verifyCronBoundary() {
  let factoryCalls = 0;
  const noSecret = cronTest.createTruthAuditCronHandler({
    env: {},
    createLedger() { factoryCalls += 1; },
  });
  let response = await invokeCron(noSecret, { method: "GET", headers: {} });
  assert.equal(response.statusCode, 503);
  assert.equal(factoryCalls, 0);

  const pausedEnv = {
    CRON_SECRET: "cron-secret",
    PQ_TRUTH_AUDIT_DISABLED: "1",
  };
  const paused = cronTest.createTruthAuditCronHandler({
    env: pausedEnv,
    createLedger() { factoryCalls += 1; },
  });
  response = await invokeCron(paused, { method: "GET", headers: {} });
  assert.equal(response.statusCode, 401, "authorization must precede pause disclosure");
  response = await invokeCron(paused, {
    method: "GET",
    headers: { authorization: "Bearer cron-secret" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, "disabled");
  assert.equal(factoryCalls, 0);

  const missingWitness = cronTest.createTruthAuditCronHandler({
    env: { CRON_SECRET: "cron-secret" },
    createLedger() { factoryCalls += 1; },
  });
  response = await invokeCron(missingWitness, {
    method: "GET",
    headers: { authorization: "Bearer cron-secret" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "not-configured");
  assert.equal(factoryCalls, 0);

  const missingProtectionBypass = cronTest.createTruthAuditCronHandler({
    env: {
      CRON_SECRET: "cron-secret",
      PQ_TRUTH_PRODUCTION_WITNESS_TOKEN: WITNESS_TOKEN,
    },
    createLedger() { factoryCalls += 1; },
  });
  response = await invokeCron(missingProtectionBypass, {
    method: "GET",
    headers: { authorization: "Bearer cron-secret" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.status, "not-configured");
  assert.equal(factoryCalls, 0);

  let runCalls = 0;
  const logs = [];
  const live = cronTest.createTruthAuditCronHandler({
    env: {
      CRON_SECRET: "cron-secret",
      PQ_TRUTH_AUDIT_TOKEN: TOKEN,
      PQ_TRUTH_PRODUCTION_WITNESS_TOKEN: WITNESS_TOKEN,
      PQ_TRUTH_PROTECTION_BYPASS_SECRET: PROTECTION_BYPASS,
      PQ_SUPABASE_URL: "https://project.supabase.co",
      PQ_SUPABASE_ANON_KEY: "anon-key",
      PQ_TRUTH_AUDIT_PRODUCTION_ORIGIN: "https://pikiio.example",
    },
    createLedger() { return { auditOnly: true }; },
    createRunner(options) {
      assert.equal(options.productionWitnessToken, WITNESS_TOKEN);
      assert.equal(options.productionProtectionBypassSecret, PROTECTION_BYPASS);
      return {
        async run(input) {
          assert.equal(input.auditMode, "hourly");
          assert.deepEqual(input.producerContext, standaloneAuditProducerContext());
          runCalls += 1;
          return {
            ok: true,
            auditRunId: RUN_IDS[0],
            status: "succeeded",
            agreement: false,
            blockingAgreement: false,
            counts: { blocking: 1 },
            findingCount: 1,
            findings: [{ findingId: FINDING_ID }],
            mutatesOperationalState: false,
          };
        },
      };
    },
  });
  const originalLog = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    response = await invokeCron(live, {
      method: "POST",
      headers: { authorization: "Bearer cron-secret" },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.findings[0].findingId, FINDING_ID);
  assert.equal(runCalls, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    event: "truth-audit-run",
    auditRunId: RUN_IDS[0],
    status: "succeeded",
    skipped: false,
    agreement: false,
    blockingAgreement: false,
    counts: { blocking: 1 },
    findingCount: 1,
    mutatesOperationalState: false,
  });

  return { missingSecretStatus: 503, unauthorizedStatus: 401, pausedStatus: "disabled", runCalls };
}

function verifyStaticBoundary() {
  const paths = [
    "lib/truth-audit-ledger.js",
    "lib/relational-truth-audit-runner.js",
    "api/cron/truth-audit.js",
  ];
  const source = paths.map((relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8")).join("\n");
  for (const forbidden of [
    "PQ_SUPABASE_SERVICE_ROLE_KEY",
    "PQ_SUPABASE_SYNC_TOKEN",
    "supabase-agent",
  ]) {
    assert.equal(source.includes(forbidden), false, `audit runtime must not reference ${forbidden}`);
  }
  for (const rpc of Object.values(AUDIT_RPC)) assert.ok(source.includes(rpc));
  assert.ok(source.includes("PQ_SUPABASE_ANON_KEY"));
  assert.ok(source.includes("PQ_TRUTH_AUDIT_TOKEN"));
  assert.ok(source.includes("PQ_TRUTH_AUDIT_DISABLED"));
  assert.ok(source.includes("PQ_CRON_SUPABASE_PAUSED"));
  assert.ok(source.includes(PRODUCTION_SNAPSHOT_PATH));
  assert.equal(/(?:gmail|tms|tracking|action)-(?:client|writer)/i.test(source), false);

  const migration = fs.readFileSync(MIGRATIONS.at(-1), "utf8");
  assert.ok(migration.includes("truth_audit_runtime"));
  assert.ok(migration.includes("truth_audit_runs_one_running_workspace_idx"));
  assert.ok(migration.includes("pg_advisory_xact_lock"));
  assert.ok(migration.includes("AUDIT_LEASE_EXPIRED"));
  assert.ok(migration.includes("source_processing_job_lineage"));
  assert.ok(migration.includes("source_processing_job_observations"));
  assert.ok(migration.includes("sourceCutPartitionWitnesses"));
  assert.ok(migration.includes("sourceCutEvidenceObservations"));
  assert.ok(migration.includes("truth_publication_payloads"));
  assert.ok(migration.includes("publicationPayloadByteLimit"));
  assert.ok(migration.includes("source_cut_partition_witness"));
  assert.ok(migration.includes("source_observation_within_cut"));
  assert.ok(migration.includes("revoke insert, update, delete on public.truth_audit_runs from service_role"));
  const laneMigration = fs.readFileSync(AUDIT_LANE_STATUS_MIGRATION, "utf8");
  for (const required of [
    "producer_context jsonb",
    "truth_audit_runs_one_running_lane_idx",
    "truth_audit_canonical_json_text",
    "latestCompleted",
    "limit p_finding_limit",
    "p_producer_context jsonb",
    "alter function public.read_truth_audit_status",
    "grant execute on function private.read_truth_audit_status",
  ]) {
    assert.ok(laneMigration.includes(required), `lane-status migration must include ${required}`);
  }
  return {
    runtimeFiles: paths.length,
    allowedAuditRpcs: Object.values(AUDIT_RPC).length,
    laneMigrationReapplies: 2,
  };
}

function verifyPureAuditorStillGreen() {
  const output = execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts/verify-relational-truth-auditor.js")],
    { cwd: ROOT, encoding: "utf8", timeout: 30000 },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cleanFindings, 0);
  assert.ok(parsed.regressionStages.includes("production"));
  return {
    cleanFindings: parsed.cleanFindings,
    regressionStageCount: parsed.regressionStages.length,
  };
}

async function main() {
  const previousWitnessToken = process.env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN;
  const previousProtectionBypass = process.env.PQ_TRUTH_PROTECTION_BYPASS_SECRET;
  process.env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN = WITNESS_TOKEN;
  process.env.PQ_TRUTH_PROTECTION_BYPASS_SECRET = PROTECTION_BYPASS;
  try {
    const staticBoundary = verifyStaticBoundary();
    const pureAuditor = verifyPureAuditorStillGreen();
    const ledgerCalls = await verifyLedgerBoundary();
    const runner = await verifyRunner();
    const cron = await verifyCronBoundary();
    const sql = await verifySqlRuntime();
    console.log(JSON.stringify({
      ok: true,
      staticBoundary,
      pureAuditor,
      ledgerCalls,
      runner,
      cron,
      sql,
      liveCalls: 0,
      operationalMutations: 0,
      mutatesOperationalState: false,
    }, null, 2));
  } finally {
    if (previousWitnessToken === undefined) delete process.env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN;
    else process.env.PQ_TRUTH_PRODUCTION_WITNESS_TOKEN = previousWitnessToken;
    if (previousProtectionBypass === undefined) delete process.env.PQ_TRUTH_PROTECTION_BYPASS_SECRET;
    else process.env.PQ_TRUTH_PROTECTION_BYPASS_SECRET = previousProtectionBypass;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

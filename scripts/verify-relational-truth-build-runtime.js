#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const { createTruthBuildLedger, RPC } = require("../lib/truth-build-ledger");
const {
  runRelationalTruthBuild,
  _test: runnerTest,
} = require("../lib/relational-truth-build-runner");
const { REDUCER_VERSION, reduceRelationalTruth } = require("../lib/relational-truth-reducer");
const { PROMPT_VERSION: GMAIL_PROMPT_VERSION } = require("../lib/gmail-claim-extractor");
const { PINNED_MODEL: GMAIL_MODEL_SNAPSHOT } = require("../lib/openai-gmail-model-extractor");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const {
  createConfiguredProcessingWatermark,
} = require("../lib/truth-processing-watermark");

const ROOT = path.resolve(__dirname, "..");
const MIGRATIONS = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240900_truth_production_authority_isolation.sql",
  "20260709241000_truth_processing_watermark.sql",
  "20260717220000_truth_production_cutover_readiness.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));

const WORKSPACE = "primary";
const OTHER_WORKSPACE = "secondary";
const TOKEN = "truth-build-runtime-test-token";
const APPROVAL_ISSUER_TOKEN = "truth-production-approval-issuer-test-token-v1";
const DELIVERY_SCHEMA_VERSION = "shipment-truth-packet-v2";
const DELIVERY_BUILDER_VERSION = "fixture-relational-delivery-adapter-v1";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const OBS_A = `obs:v1:${HASH_A}`;
const OBS_B = `obs:v1:${HASH_B}`;

const RPC_SIGNATURES = Object.freeze({
  [RPC.claimPair]: [
    ["p_workspace_key", "text"],
    ["p_source_cut_id", "text"],
    ["p_build_channel", "text"],
    ["p_trigger_name", "text"],
    ["p_idempotency_key", "text"],
    ["p_worker_id", "text"],
    ["p_lease_seconds", "integer"],
    ["p_bundle_row_limit", "integer"],
    ["p_versions", "jsonb"],
    ["p_sync_token", "text"],
  ],
  [RPC.issueProductionApproval]: [
    ["p_workspace_key", "text"],
    ["p_operation", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_target_publication_id", "uuid"],
    ["p_approval_request_key", "text"],
    ["p_publication_request_key", "text"],
    ["p_expected_head_version", "bigint"],
    ["p_expected_head_packet_hash", "text"],
    ["p_publication_reason", "text"],
    ["p_publisher_version", "text"],
    ["p_published_by", "text"],
    ["p_approved_by", "text"],
    ["p_approval_reason", "text"],
    ["p_expires_at", "timestamp with time zone"],
    ["p_approval_credential", "text"],
    ["p_issuer_token", "text"],
  ],
  [RPC.renewLease]: [
    ["p_workspace_key", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"],
    ["p_lease_seconds", "integer"],
    ["p_sync_token", "text"],
  ],
  [RPC.readBundle]: [
    ["p_workspace_key", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"],
    ["p_sync_token", "text"],
  ],
  [RPC.completePair]: [
    ["p_workspace_key", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"],
    ["p_full_packet", "jsonb"],
    ["p_incremental_packet", "jsonb"],
    ["p_full_semantic_hash", "text"],
    ["p_incremental_semantic_hash", "text"],
    ["p_full_validation_report", "jsonb"],
    ["p_incremental_validation_report", "jsonb"],
    ["p_sync_token", "text"],
  ],
  [RPC.failPair]: [
    ["p_workspace_key", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"],
    ["p_error_code", "text"],
    ["p_safe_error_detail", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.publishPair]: [
    ["p_workspace_key", "text"],
    ["p_build_pair_id", "uuid"],
    ["p_publication_request_key", "text"],
    ["p_expected_head_version", "bigint"],
    ["p_expected_head_packet_hash", "text"],
    ["p_publication_reason", "text"],
    ["p_publisher_version", "text"],
    ["p_published_by", "text"],
    ["p_production_approval_id", "uuid"],
    ["p_production_approval_credential", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.rollbackForward]: [
    ["p_workspace_key", "text"],
    ["p_channel", "text"],
    ["p_target_publication_id", "uuid"],
    ["p_publication_request_key", "text"],
    ["p_expected_head_version", "bigint"],
    ["p_expected_head_packet_hash", "text"],
    ["p_publisher_version", "text"],
    ["p_published_by", "text"],
    ["p_production_approval_id", "uuid"],
    ["p_production_approval_credential", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.readHead]: [
    ["p_workspace_key", "text"],
    ["p_channel", "text"],
    ["p_max_payload_bytes", "integer"],
    ["p_sync_token", "text"],
  ],
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function expectSqlState(promise, code, message) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code, `${message}: ${error?.message || error}`);
    return true;
  }, message);
}

async function asRole(db, role, operation) {
  await db.exec(`set role ${role}`);
  try {
    return await operation();
  } finally {
    await db.exec("reset role");
  }
}

async function install(db) {
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
  `);
  for (const migration of MIGRATIONS) {
    if (path.basename(migration) === "20260717220000_truth_production_cutover_readiness.sql") {
      await db.exec(`
        create table public.truth_gmail_backfill_parking_receipts (
          receipt_id text primary key, receipt_hash text not null unique,
          workspace_key text not null, source_system text not null,
          connection_key text not null, provider_account_email text not null,
          provider_account_binding_hash text not null, parked_batch_id uuid not null unique,
          backfill_gap_id uuid not null unique, cutover_delta_gap_id uuid not null unique,
          coordinator_job_id uuid not null unique, persisted_anchor_history_id text not null,
          cutover_history_id text not null, prior_cursor_version bigint not null,
          resumed_cursor_version bigint not null, page_count integer not null,
          observation_count integer not null, job_count integer not null,
          page_manifest_hash text not null, provider_probe_hash text not null,
          canonical_receipt jsonb not null, schema_version text not null,
          parked_at timestamptz not null, created_at timestamptz not null default now()
        )
      `);
      await db.exec(`
        create or replace function private.truth_canonical_json_text(p_value jsonb)
        returns text language sql immutable set search_path = ''
        as 'select p_value::text'
      `);
      const spine = fs.readFileSync(path.join(
        ROOT, "supabase/migrations/20260717200000_truth_gmail_claims_readiness_spine.sql",
      ), "utf8");
      const validatorStart = spine.indexOf(
        "create or replace function private.truth_gmail_claims_readiness_parking_receipt_valid_v1(",
      );
      const validatorEnd = spine.indexOf("$function$;", validatorStart) + "$function$;".length;
      assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
      await db.exec(spine.slice(validatorStart, validatorEnd));
    }
    await db.exec(fs.readFileSync(migration, "utf8"));
  }
  await db.exec(fs.readFileSync(MIGRATIONS.at(-1), "utf8"));
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values
      ('local_snapshot_writer', encode(
        extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'),
        'hex'
      )),
      ('truth_production_approval_issuer', encode(
        extensions.digest(convert_to($2::text, 'UTF8'), 'sha256'),
        'hex'
      ))
  `, [TOKEN, APPROVAL_ISSUER_TOKEN]);
  await db.query(`
    insert into public.truth_workspaces (workspace_key, status, registry_version)
    values ($1, 'active', 'truth-workspace-registry-v1')
  `, [OTHER_WORKSPACE]);
}

function createDbRpcCaller(db, hooks = {}) {
  return async (rpc, body) => {
    const signature = RPC_SIGNATURES[rpc];
    if (!signature) throw new Error(`Unexpected RPC ${rpc}`);
    const values = signature.map(([key, type]) => {
      const value = body[key];
      return type === "jsonb" ? JSON.stringify(value) : value;
    });
    const casts = signature.map(([, type], index) => `$${index + 1}::${type}`);
    const row = await one(db, `select public.${rpc}(${casts.join(", ")}) as receipt`, values);
    if (typeof hooks.afterCall === "function") await hooks.afterCall(rpc, body, row.receipt);
    return row.receipt;
  };
}

async function issueProductionApproval(db, {
  operation = "build_pair_publish",
  buildPairId = null,
  targetPublicationId = null,
  approvalRequestKey,
  publicationRequestKey,
  expectedHeadVersion,
  expectedHeadPacketHash,
  publicationReason,
  publisherVersion = "truth-build-runtime-v1",
  publishedBy = "verifier",
  credential,
  expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  workspaceKey = WORKSPACE,
  issuerToken = APPROVAL_ISSUER_TOKEN,
} = {}) {
  return (await one(db, `
    select public.issue_truth_production_publication_approval(
      $1::text,
      $2::text,
      $3::uuid,
      $4::uuid,
      $5::text,
      $6::text,
      $7::bigint,
      $8::text,
      $9::text,
      $10::text,
      $11::text,
      'fixture-operator'::text,
      'Focused local production-authority regression'::text,
      $13::timestamptz,
      $12::text,
      $14::text
    ) as receipt
  `, [
    workspaceKey,
    operation,
    buildPairId,
    targetPublicationId,
    approvalRequestKey,
    publicationRequestKey,
    expectedHeadVersion,
    expectedHeadPacketHash,
    publicationReason,
    publisherVersion,
    publishedBy,
    credential,
    expiresAt,
    issuerToken,
  ])).receipt;
}

function nativePostgresBinDir() {
  const candidates = [
    process.env.PQ_TEST_POSTGRES_BIN_DIR,
    "/opt/homebrew/opt/postgresql@15/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@15/bin",
    "/usr/local/opt/postgresql@16/bin",
    ...String(process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);
  for (const directory of candidates) {
    if (["initdb", "pg_ctl", "psql"].every((name) => (
      fs.existsSync(path.join(directory, name))
    ))) return directory;
  }
  throw new Error(
    "Native PostgreSQL initdb/pg_ctl/psql are required for the two-session workspace-disable lock proof.",
  );
}

function runNative(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

async function verifyWorkspaceDisableConcurrency() {
  const binDir = nativePostgresBinDir();
  const initdb = path.join(binDir, "initdb");
  const pgCtl = path.join(binDir, "pg_ctl");
  const psql = path.join(binDir, "psql");
  const tempBase = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const tempRoot = fs.mkdtempSync(path.join(tempBase, "pq-truth-lock-"));
  const dataDir = path.join(tempRoot, "data");
  const socketDir = path.join(tempRoot, "socket");
  const serverLog = path.join(tempRoot, "postgres.log");
  const port = 42000 + crypto.randomInt(10000);
  fs.mkdirSync(socketDir, { recursive: true });
  let started = false;
  try {
    runNative(initdb, [
      "-D", dataDir,
      "--no-locale",
      "--encoding=UTF8",
      "--auth=trust",
    ]);
    runNative(pgCtl, [
      "-D", dataDir,
      "-o", `-F -p ${port} -k ${socketDir} -c listen_addresses=''`,
      "-l", serverLog,
      "-w",
      "start",
    ]);
    started = true;
    const psqlArgs = [
      "-X", "-q", "-A", "-t",
      "-v", "ON_ERROR_STOP=1",
      "-h", socketDir,
      "-p", String(port),
      "-d", "postgres",
    ];
    const workspaceIsolationMigration = MIGRATIONS.find((migration) => (
      path.basename(migration) === "20260709240900_truth_production_authority_isolation.sql"
    ));
    const migrationSource = fs.readFileSync(workspaceIsolationMigration, "utf8");
    const functionStart = migrationSource.indexOf(
      "create or replace function private.require_active_truth_workspace(",
    );
    const functionEnd = migrationSource.indexOf("$function$;", functionStart);
    assert.ok(functionStart >= 0 && functionEnd > functionStart);
    const activeWorkspaceFunction = migrationSource.slice(
      functionStart,
      functionEnd + "$function$;".length,
    );
    runNative(psql, psqlArgs, {
      input: `
        create schema private;
        create table public.truth_workspaces (
          workspace_key text primary key,
          status text not null
        );
        insert into public.truth_workspaces values ('primary', 'active');
        ${activeWorkspaceFunction}
      `,
    });

    const holder = spawn(psql, psqlArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let holderStdout = "";
    let holderStderr = "";
    holder.stdout.setEncoding("utf8");
    holder.stderr.setEncoding("utf8");
    holder.stdout.on("data", (chunk) => { holderStdout += chunk; });
    holder.stderr.on("data", (chunk) => { holderStderr += chunk; });
    const holderExitPromise = new Promise((resolve) => holder.once("exit", resolve));
    holder.stdin.end(`
      begin;
      select private.require_active_truth_workspace('primary');
      \\echo WORKSPACE_LOCK_READY
      select pg_sleep(2);
      commit;
    `);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(
        `Timed out waiting for workspace lock holder: ${holderStdout} ${holderStderr}`,
      )), 5000);
      const inspect = () => {
        if (!holderStdout.includes("WORKSPACE_LOCK_READY")) return;
        clearTimeout(timeout);
        resolve();
      };
      holder.stdout.on("data", inspect);
      holder.once("exit", (code) => {
        if (!holderStdout.includes("WORKSPACE_LOCK_READY")) {
          clearTimeout(timeout);
          reject(new Error(`Workspace lock holder exited ${code}: ${holderStderr}`));
        }
      });
      inspect();
    });

    const disableStartedAt = Date.now();
    runNative(psql, psqlArgs, {
      input: `
        set lock_timeout = '5s';
        update public.truth_workspaces
        set status = 'disabled'
        where workspace_key = 'primary';
      `,
    });
    const disableWaitMs = Date.now() - disableStartedAt;
    const holderExit = await holderExitPromise;
    assert.equal(holderExit, 0, holderStderr);
    assert.ok(
      disableWaitMs >= 1000,
      `workspace disable did not wait for the authorization transaction (${disableWaitMs}ms)`,
    );
    const disabledProbe = spawnSync(psql, psqlArgs, {
      input: "select private.require_active_truth_workspace('primary');",
      encoding: "utf8",
    });
    assert.notEqual(disabledProbe.status, 0);
    assert.match(disabledProbe.stderr, /truth workspace is disabled/);
    return { disableWaitMs, holderExit, disabledProbeRejected: true };
  } finally {
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function seedObservation(db, {
  observationId,
  contentHash,
  cursorVersion,
  cursorValue,
  sourceObjectId,
  batchHash,
}) {
  const prior = await db.query(`
    select 1 from public.source_cursors
    where workspace_key = $1 and source_system = 'gmail' and connection_key = 'primary'
  `, [WORKSPACE]);
  if (!prior.rows.length) {
    await db.query(`
      insert into public.source_cursors (
        workspace_key, source_system, connection_key, cursor_kind,
        cursor_value, cursor_version, status, lease_fence
      ) values ($1, 'gmail', 'primary', 'gmail_history_id', $2, $3, 'live', 1)
    `, [WORKSPACE, cursorValue, cursorVersion]);
  }
  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      $1, 'gmail', 'primary', 'snapshot', 'truth-build-fixture',
      $2, $3, $4, $5, 'fixture', 1, 'committed', $6,
      0, 1, 0, now(), now()
    ) returning batch_id
  `, [WORKSPACE, cursorVersion - 1, cursorVersion > 1 ? String(cursorVersion - 1) : "", cursorVersion, cursorValue, batchHash]);
  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text, source_fidelity,
      schema_version
    ) values (
      $1, $2, 'gmail', 'primary', 'gmail_message', $3, $4, 'content',
      $5, $6, $7, '2026-07-09T12:00:00.000Z',
      '2026-07-09T12:00:01.000Z', '{}'::jsonb,
      'Shipment evidence fixture', 'normalized_source', 'source-observation-v1'
    )
  `, [observationId, WORKSPACE, sourceObjectId, String(cursorVersion), cursorVersion, batch.batch_id, contentHash]);
  await db.query(`
    update public.source_cursors
    set cursor_value = $1,
        cursor_version = $2,
        status = 'live',
        last_batch_id = $3,
        last_committed_at = now()
    where workspace_key = $4 and source_system = 'gmail' and connection_key = 'primary'
  `, [cursorValue, cursorVersion, batch.batch_id, WORKSPACE]);
}

async function sealCut(db, { gaps = [], observations = [] } = {}) {
  const cursor = (await one(db, `
    select cursor_value, cursor_version
    from public.source_cursors
    where workspace_key = $1 and source_system = 'gmail' and connection_key = 'primary'
  `, [WORKSPACE]));
  return (await one(db, `
    select public.seal_source_cut(
      $1::text,
      'source-cut-manifest-v2'::text,
      $2::jsonb,
      $3::jsonb,
      $4::jsonb,
      $5::jsonb,
      'truth-build-fixture'::text,
      $6::text
    ) as receipt
  `, [
    WORKSPACE,
    JSON.stringify([{ sourceSystem: "gmail", connectionKey: "primary" }]),
    JSON.stringify(gaps),
    JSON.stringify([{
      sourceSystem: "gmail",
      connectionKey: "primary",
      cursorKind: "gmail_history_id",
      throughCursorVersion: String(cursor.cursor_version),
      throughCursorValue: cursor.cursor_value,
      upstreamWatermark: cursor.cursor_value,
      sourceSnapshotAt: "2026-07-09T12:00:01.000Z",
    }]),
    JSON.stringify(observations),
    TOKEN,
  ])).receipt;
}

async function appendClaim(db) {
  const claim = {
    claimKey: "shipment:01680000083:arrival",
    versionNo: 1,
    previousClaimVersionId: null,
    primaryObservationId: OBS_A,
    subjectType: "shipment",
    subjectKey: "01680000083",
    predicate: "arrival_confirmed",
    gate: "arrival",
    polarity: "positive",
    normalizedValue: { sourceClass: "gmail_parsed_message", completed: true },
    occurredAt: "2026-07-09T12:00:00.000Z",
    confidence: 0.98,
    confidenceLabel: "high",
    extractionMethod: "deterministic",
    extractorVersion: "fixture-extractor-v1",
    promptVersion: "",
    model: "",
    acceptanceMethod: "policy",
    acceptancePolicyVersion: "fixture-policy-v1",
    acceptedBy: "fixture",
    decision: "accepted",
    evidenceSpan: { field: "body", text: "shipment arrived" },
    recordedAt: "2026-07-09T12:00:02.000Z",
    schemaVersion: "accepted-claim-v1",
  };
  const evidence = [{
    observationId: OBS_A,
    evidenceRole: "primary",
    evidenceSpan: { field: "body", text: "shipment arrived" },
  }];
  return (await one(db, `
    select public.append_accepted_claim(
      $1::text, $2::jsonb, $3::jsonb, '[]'::jsonb, $4::text
    ) as receipt
  `, [WORKSPACE, JSON.stringify(claim), JSON.stringify(evidence), TOKEN])).receipt;
}

function fixtureDeliveryBuilder({
  reducedPacket,
  claimEnvelopes,
  compiledAt,
  processingWatermarkStatus,
  processingWatermark,
  processingWatermarkHash,
}) {
  const acceptedClaimManifestHash = runnerTest.sha256Json(claimEnvelopes.map((item) => ({
    claimVersionId: item.claimVersionId,
    envelopeHash: item.envelopeHash,
  })).sort((left, right) => left.claimVersionId.localeCompare(right.claimVersionId)));
  const shipments = reducedPacket.shipments.map((row) => ({
    awb: row.shipmentKey,
    truthPacketRole: "active",
    evidencePacket: {
      sourceFacts: row.acceptedClaimIds.map((claimVersionId) => ({
        id: claimVersionId,
        sourceSystem: "gmail",
        sourceRef: { observationIds: reducedPacket.acceptedClaimCitations
          .find((citation) => citation.claimVersionId === claimVersionId)?.evidenceObservationIds || [] },
        claim: "Accepted relational claim",
      })),
      unknowns: [],
      contradictions: row.contradictions,
    },
    truthPacket: {
      currentState: row.currentState.value,
      stateReason: `${row.currentState.reason} ${"x".repeat(1400)}`,
      gates: row.gates.map((gate) => ({
        gate: gate.gate,
        status: gate.status,
        sourceFactIds: gate.claimVersionIds,
        reason: gate.reason,
      })),
      sourceFactIds: row.acceptedClaimIds,
      contradictions: row.contradictions,
      unknowns: row.gates.filter((gate) => gate.status === "unknown").map((gate) => gate.gate),
    },
  }));
  const activeAwbs = shipments.map((shipment) => shipment.awb).sort();
  return {
    schemaVersion: DELIVERY_SCHEMA_VERSION,
    writerVersion: DELIVERY_SCHEMA_VERSION,
    snapshotTime: compiledAt,
    sourceOfTruth: "relational accepted claims",
    counts: { shipments: shipments.length, active: activeAwbs.length, completed: 0 },
    activeAwbs,
    completedAwbs: [],
    shipments,
    packetHash: reducedPacket.packetHash,
    processingWatermarkStatus,
    processingWatermark,
    processingWatermarkHash,
    truthProvenance: {
      schemaVersion: "relational-truth-delivery-provenance-v1",
      sourceCutId: reducedPacket.sourceCut.sourceCutId,
      reducerPacketHash: reducedPacket.packetHash,
      inputManifestHash: reducedPacket.inputManifestHash,
      reducerVersion: reducedPacket.reducerVersion,
      precedencePolicyVersion: reducedPacket.precedencePolicy.policyVersion,
      precedencePolicyHash: reducedPacket.precedencePolicy.policyHash,
      acceptedClaimManifestHash,
      shipmentMetadataManifestHash: reducedPacket.shipmentMetadataManifestHash,
      processingWatermarkStatus,
      processingWatermark,
      processingWatermarkHash,
    },
  };
}

function runnerOptions(ledger, sourceCutId, idempotencyKey, extra = {}) {
  return {
    ledger,
    sourceCutId,
    idempotencyKey,
    workerId: extra.workerId || `worker:${idempotencyKey}`,
    buildChannel: extra.buildChannel || "shadow",
    triggerName: "verify-relational-truth-build-runtime",
    bundleRowLimit: 1000,
    deliveryBuilder: extra.deliveryBuilder || fixtureDeliveryBuilder,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicy: DEFAULT_POLICY,
    model: extra.model,
    modelProvider: extra.modelProvider,
    promptVersion: extra.promptVersion,
    processingConfig: extra.processingConfig,
    processingWatermarkConfigured: extra.processingWatermarkConfigured,
    publication: extra.publication,
  };
}

async function buildCompletionFixture(ledger, sourceCutId, idempotencyKey, workerId) {
  const versions = claimVersions();
  const pair = await ledger.claimPair({
    sourceCutId,
    buildChannel: "shadow",
    triggerName: "manual-adversarial-fixture",
    idempotencyKey,
    workerId,
    leaseSeconds: 300,
    bundleRowLimit: 1000,
    versions,
  });
  const lease = { buildPairId: pair.buildPairId, workerId, leaseFence: pair.leaseFence };
  const bundle = await ledger.readBundle(lease);
  const internal = reduceRelationalTruth(bundle, { mode: "full" });
  const delivery = fixtureDeliveryBuilder({
    reducedPacket: internal,
    claimEnvelopes: bundle.acceptedClaimEnvelopes,
    compiledAt: bundle.sourceCut.sealedAt,
    processingWatermarkStatus: bundle.processingWatermarkStatus,
    processingWatermark: bundle.processingWatermark,
    processingWatermarkHash: bundle.processingWatermarkHash,
  });
  const acceptedClaimManifestHash = delivery.truthProvenance.acceptedClaimManifestHash;
  const report = {
    schemaValid: true,
    deliveryIdentityValid: true,
    acceptedClaimManifestHash,
    shipmentMetadataManifestHash: delivery.truthProvenance.shipmentMetadataManifestHash,
    shipmentMetadataCount: bundle.shipmentMetadataEnvelopes.length,
    deliveryPacketHash: runnerTest.sha256Json(delivery),
    internalReducerOutput: internal,
  };
  return { pair, lease, bundle, internal, delivery, report };
}

function claimVersions() {
  return createConfiguredProcessingWatermark({
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  });
}

async function verifyPermissions(db) {
  await db.exec("set role anon");
  try {
    await expectSqlState(
      db.query("select * from public.truth_build_pair_runs"),
      "42501",
      "anonymous callers cannot read build coordination state",
    );
    await expectSqlState(
      db.query(`
        select public.read_truth_publication_head_runtime(
          'primary', 'shadow', 33554432, $1
        )
      `, [TOKEN]),
      "42501",
      "anonymous callers cannot execute publisher RPCs",
    );
  } finally {
    await db.exec("reset role");
  }

  await db.exec("set role service_role");
  try {
    const head = (await one(db, `
      select public.read_truth_publication_head_runtime(
        'primary', 'shadow', 33554432, $1
      ) as receipt
    `, [TOKEN])).receipt;
    assert.equal(head.ok, true);
    await expectSqlState(
      db.query(`
        update public.truth_build_pair_runs
        set updated_at = clock_timestamp()
        where false
      `),
      "42501",
      "publisher role cannot directly update build coordination state",
    );
    await expectSqlState(
      db.query(`
        update public.truth_publications
        set published_by = published_by
        where false
      `),
      "42501",
      "publisher role cannot directly mutate publication history",
    );
    await expectSqlState(
      db.query("select * from public.truth_production_publication_approvals"),
      "42501",
      "publisher and shadow service roles cannot read production approval records",
    );
    await expectSqlState(
      db.query(`
        select private.read_truth_publication_head_runtime(
          'primary', 'shadow', 33554432, $1
        )
      `, [TOKEN]),
      "42501",
      "publisher role cannot execute private publication implementations",
    );
    await expectSqlState(
      db.query(`
        select public.publish_truth_build_cas(
          '00000000-0000-4000-8000-000000000000'::uuid,
          'shadow', 0, '', 'normal', 'legacy', 'legacy', $1
        )
      `, [TOKEN]),
      "42501",
      "retired caller-supplied publication RPC remains inaccessible",
    );
  } finally {
    await db.exec("reset role");
  }
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await install(db);
    await seedObservation(db, {
      observationId: OBS_A,
      contentHash: HASH_A,
      cursorVersion: 1,
      cursorValue: "100",
      sourceObjectId: "message-a",
      batchHash: sha256("batch-a"),
    });
    const syntheticUnclaimedCount = 1200;
    await db.query(`
      insert into public.source_observations (
        observation_id, workspace_key, source_system, connection_key,
        source_object_type, source_object_id, source_revision, operation,
        source_cursor_version, batch_id, content_hash, source_recorded_at,
        captured_at, normalized_payload, normalized_text, source_fidelity,
        schema_version
      )
      select
        'obs:v1:' || encode(extensions.digest(convert_to('bulk-observation:' || series.ordinal, 'UTF8'), 'sha256'), 'hex'),
        $1, 'gmail', 'primary', 'gmail_message',
        'unclaimed-message-' || series.ordinal,
        '1', 'content', 1, cursor.last_batch_id,
        encode(extensions.digest(convert_to('bulk-content:' || series.ordinal, 'UTF8'), 'sha256'), 'hex'),
        '2026-07-09T11:00:00.000Z', '2026-07-09T11:00:01.000Z',
        jsonb_build_object('unclaimed', true, 'ordinal', series.ordinal),
        'Unclaimed mailbox evidence', 'normalized_source', 'source-observation-v1'
      from generate_series(1, $2::integer) series(ordinal)
      cross join public.source_cursors cursor
      where cursor.workspace_key = $1
        and cursor.source_system = 'gmail'
        and cursor.connection_key = 'primary'
    `, [WORKSPACE, syntheticUnclaimedCount]);
    await db.query(`
      update public.source_ingest_batches batch
      set observation_count = (
        select count(*)::integer from public.source_observations observation
        where observation.batch_id = batch.batch_id
      )
      where batch_id = (
        select last_batch_id from public.source_cursors
        where workspace_key = $1 and source_system = 'gmail' and connection_key = 'primary'
      )
    `, [WORKSPACE]);
    const claim = await appendClaim(db);
    assert.match(claim.claimVersionId, /^claim:v1:[0-9a-f]{64}$/);
    await expectSqlState(
      sealCut(db, { observations: [{ observationId: OBS_A, contentHash: HASH_A }] }),
      "23514",
      "source-cut v2 must reject caller-supplied full observation arrays",
    );
    const completeCut = await sealCut(db);
    const degradedCut = await sealCut(db, {
      gaps: [{ gapType: "FIXTURE_EXPLICIT_GAP", detail: "source not complete" }],
    });
    assert.equal(completeCut.completeness, "complete");
    assert.equal(degradedCut.completeness, "degraded");
    assert.equal(completeCut.observationCount, syntheticUnclaimedCount + 1);
    assert.equal(Object.hasOwn(completeCut.manifest, "observations"), false);
    const firstCutManifestBytes = Buffer.byteLength(JSON.stringify(completeCut.manifest));
    const firstCutPartitionHash = completeCut.manifest.cursors[0].partitionHash;
    assert.equal((await one(db, `
      select count(*)::integer as count from public.source_cut_observations
      where source_cut_id = $1
    `, [completeCut.sourceCutId])).count, 0);

    await seedObservation(db, {
      observationId: OBS_B,
      contentHash: HASH_B,
      cursorVersion: 2,
      cursorValue: "200",
      sourceObjectId: "unclaimed-message-new",
      batchHash: sha256("batch-b"),
    });
    const secondCut = await sealCut(db);
    assert.equal(secondCut.observationCount, syntheticUnclaimedCount + 2);
    assert.notEqual(secondCut.sourceCutId, completeCut.sourceCutId);
    assert.notEqual(secondCut.manifest.cursors[0].partitionHash, firstCutPartitionHash);
    assert.ok(
      Buffer.byteLength(JSON.stringify(secondCut.manifest)) <= firstCutManifestBytes + 128,
      "compact cut metadata must not grow with the historical mailbox",
    );
    assert.equal((await one(db, `
      select count(*)::integer as count from public.source_cut_observations
      where source_cut_id in ($1, $2)
    `, [completeCut.sourceCutId, secondCut.sourceCutId])).count, 0);
    const omittedUnclaimedHash = (await one(db, `
      select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
        'observationId', observation.observation_id,
        'contentHash', observation.content_hash
      ) order by observation.observation_id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex') as hash
      from public.source_observations observation
      join public.source_ingest_batches batch
        on batch.batch_id = observation.batch_id and batch.status = 'committed'
      where observation.workspace_key = $1
        and observation.source_system = 'gmail'
        and observation.connection_key = 'primary'
        and observation.source_cursor_version <= 2
        and observation.observation_id <> $2
    `, [WORKSPACE, OBS_B])).hash;
    assert.notEqual(secondCut.manifest.cursors[0].partitionHash, omittedUnclaimedHash);
    const changedUnclaimedHash = (await one(db, `
      select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
        'observationId', observation.observation_id,
        'contentHash', case when observation.observation_id = $2 then $3 else observation.content_hash end
      ) order by observation.observation_id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex') as hash
      from public.source_observations observation
      join public.source_ingest_batches batch
        on batch.batch_id = observation.batch_id and batch.status = 'committed'
      where observation.workspace_key = $1
        and observation.source_system = 'gmail'
        and observation.connection_key = 'primary'
        and observation.source_cursor_version <= 2
    `, [WORKSPACE, OBS_B, HASH_A])).hash;
    assert.notEqual(secondCut.manifest.cursors[0].partitionHash, changedUnclaimedHash);

    const callRpc = createDbRpcCaller(db);
    const ledger = createTruthBuildLedger({
      workspaceKey: WORKSPACE,
      syncToken: TOKEN,
      callRpc,
    });
    const firstCutPair = await ledger.claimPair({
      sourceCutId: completeCut.sourceCutId,
      buildChannel: "shadow",
      triggerName: "compact-source-cut-baseline-proof",
      idempotencyKey: "compact-source-cut-baseline-proof",
      workerId: "worker:compact-source-cut-baseline-proof",
      leaseSeconds: 300,
      bundleRowLimit: 100,
      versions: claimVersions(),
    });
    const firstCutBundle = await ledger.readBundle({
      buildPairId: firstCutPair.buildPairId,
      workerId: "worker:compact-source-cut-baseline-proof",
      leaseFence: firstCutPair.leaseFence,
    });
    const secondCutPair = await ledger.claimPair({
      sourceCutId: secondCut.sourceCutId,
      buildChannel: "shadow",
      triggerName: "compact-source-cut-scale-proof",
      idempotencyKey: "compact-source-cut-scale-proof",
      workerId: "worker:compact-source-cut-scale-proof",
      leaseSeconds: 300,
      bundleRowLimit: 100,
      versions: claimVersions(),
    });
    const secondCutBundle = await ledger.readBundle({
      buildPairId: secondCutPair.buildPairId,
      workerId: "worker:compact-source-cut-scale-proof",
      leaseFence: secondCutPair.leaseFence,
    });
    assert.equal(secondCutBundle.sourceCut.journalObservationCount, syntheticUnclaimedCount + 2);
    assert.deepEqual(secondCutBundle.sourceCut.observations, [{ observationId: OBS_A, contentHash: HASH_A }]);
    assert.equal(secondCutBundle.bounds.rowCount, 2);
    assert.deepEqual(firstCutBundle.sourceCut.observations, secondCutBundle.sourceCut.observations);
    assert.equal(firstCutBundle.bounds.rowCount, secondCutBundle.bounds.rowCount);
    assert.ok(
      Buffer.byteLength(JSON.stringify(secondCutBundle)) <=
        Buffer.byteLength(JSON.stringify(firstCutBundle)) + 128,
      "build bundle bytes must grow with cited evidence closure, not historical mailbox rows",
    );

    await assert.rejects(
      ledger.claimPair({
        sourceCutId: degradedCut.sourceCutId,
        buildChannel: "shadow",
        triggerName: "incomplete-cut-test",
        idempotencyKey: "incomplete-cut",
        workerId: "worker:incomplete",
        leaseSeconds: 300,
        bundleRowLimit: 100,
        versions: claimVersions(),
      }),
      (error) => error?.code === "23514",
      "degraded source cuts must never begin canonical builds",
    );
    await assert.rejects(
      ledger.claimPair({
        sourceCutId: completeCut.sourceCutId,
        buildChannel: "shadow",
        triggerName: "truncation-test",
        idempotencyKey: "truncation-test",
        workerId: "worker:truncation",
        leaseSeconds: 300,
        bundleRowLimit: 1,
        versions: claimVersions(),
      }),
      (error) => error?.code === "54000",
      "bounded bundle reads must fail closed instead of truncating",
    );

    const overlapInput = {
      sourceCutId: completeCut.sourceCutId,
      buildChannel: "shadow",
      triggerName: "overlap-test",
      idempotencyKey: "overlap-test",
      workerId: "worker:one",
      leaseSeconds: 300,
      bundleRowLimit: 100,
      versions: claimVersions(),
    };
    const firstLease = await ledger.claimPair(overlapInput);
    const sameLease = await ledger.claimPair(overlapInput);
    assert.equal(sameLease.idempotent, true);
    assert.equal(sameLease.leaseFence, firstLease.leaseFence);
    const busy = await ledger.claimPair({ ...overlapInput, workerId: "worker:two" });
    assert.equal(busy.status, "busy");
    assert.equal(busy.code, "TRUTH_BUILD_BUSY");
    await db.query(`
      update public.truth_build_pair_runs
      set lease_expires_at = clock_timestamp() - interval '1 second',
          updated_at = clock_timestamp()
      where build_pair_id = $1
    `, [firstLease.buildPairId]);
    const reclaimed = await ledger.claimPair({ ...overlapInput, workerId: "worker:two" });
    assert.equal(reclaimed.status, "running");
    assert.equal(reclaimed.leaseFence, firstLease.leaseFence + 1);
    await assert.rejects(
      ledger.readBundle({
        buildPairId: firstLease.buildPairId,
        workerId: "worker:one",
        leaseFence: firstLease.leaseFence,
      }),
      (error) => error?.code === "40001",
      "stale build fences cannot read or finish a reclaimed bundle",
    );

    const good = await runRelationalTruthBuild(runnerOptions(
      ledger,
      completeCut.sourceCutId,
      "runner-good",
    ));
    assert.equal(good.status, "succeeded");
    assert.equal(good.pair.reducerPacketHash, good.hashes.reducerPacketHash);
    assert.match(good.pair.packetHash, /^[0-9a-f]{64}$/);
    const storedBuild = await one(db, `
      select packet_payload, validation_report
      from public.truth_builds
      where build_id = $1
    `, [good.pair.fullBuildId]);
    assert.equal(storedBuild.packet_payload.schemaVersion, DELIVERY_SCHEMA_VERSION);
    assert.equal(storedBuild.packet_payload.truthProvenance.reducerPacketHash, good.pair.reducerPacketHash);
    assert.equal(storedBuild.validation_report.internalReducerParity, true);
    assert.equal(storedBuild.validation_report.finalDeliveryParity, true);
    assert.ok(Array.isArray(storedBuild.validation_report.reducerProvenance.acceptedClaimCitations));

    const modelProcessingWatermarkConfigured = createConfiguredProcessingWatermark({
      model: GMAIL_MODEL_SNAPSHOT,
      modelProvider: "openai-responses",
      promptVersion: GMAIL_PROMPT_VERSION,
      reducerVersion: REDUCER_VERSION,
      packetBuilderVersion: DELIVERY_BUILDER_VERSION,
      packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
      precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
      precedencePolicyHash: DEFAULT_POLICY.policyHash,
    });
    const modelConfiguredBuild = await runRelationalTruthBuild(runnerOptions(
      ledger,
      completeCut.sourceCutId,
      "runner-model-configured",
      {
        model: GMAIL_MODEL_SNAPSHOT,
        modelProvider: "openai-responses",
        promptVersion: GMAIL_PROMPT_VERSION,
        processingWatermarkConfigured: modelProcessingWatermarkConfigured,
      },
    ));
    assert.equal(modelConfiguredBuild.status, "succeeded");
    assert.deepEqual(
      modelConfiguredBuild.pair.processingWatermark.configured,
      modelProcessingWatermarkConfigured,
      "the real build runner must preserve the hosted model configuration vector",
    );

    const otherWorkspaceLedger = createTruthBuildLedger({
      workspaceKey: OTHER_WORKSPACE,
      syncToken: TOKEN,
      callRpc,
    });
    const crossWorkspaceLease = {
      buildPairId: firstCutPair.buildPairId,
      workerId: "worker:compact-source-cut-baseline-proof",
      leaseFence: firstCutPair.leaseFence,
    };
    for (const [operation, attempt] of [
      ["renew", () => otherWorkspaceLedger.renewLease({ ...crossWorkspaceLease, leaseSeconds: 300 })],
      ["read", () => otherWorkspaceLedger.readBundle(crossWorkspaceLease)],
      ["complete", () => otherWorkspaceLedger.completePair({
        ...crossWorkspaceLease,
        fullPacket: {},
        incrementalPacket: {},
        fullSemanticHash: HASH_A,
        incrementalSemanticHash: HASH_A,
        fullValidationReport: {},
        incrementalValidationReport: {},
      })],
      ["fail", () => otherWorkspaceLedger.failPair({
        ...crossWorkspaceLease,
        errorCode: "CROSS_WORKSPACE_ATTEMPT",
        safeErrorDetail: "must not cross workspaces",
      })],
      ["publish", () => otherWorkspaceLedger.publishPair({
        buildPairId: good.pair.buildPairId,
        publicationRequestKey: "cross-workspace-publication",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
      })],
    ]) {
      await assert.rejects(
        attempt(),
        (error) => error?.code === "23503",
        `${operation} must reject a pair UUID from another registered workspace`,
      );
    }

    const defaultAdapterBuild = await runRelationalTruthBuild({
      ledger,
      sourceCutId: completeCut.sourceCutId,
      idempotencyKey: "runner-default-production-adapter",
      workerId: "worker:default-production-adapter",
      buildChannel: "shadow",
      triggerName: "verify-default-relational-delivery-adapter",
      bundleRowLimit: 1000,
    });
    assert.equal(defaultAdapterBuild.status, "succeeded");
    const defaultAdapterPacket = (await one(db, `
      select packet_payload
      from public.truth_builds
      where build_id = $1
    `, [defaultAdapterBuild.pair.fullBuildId])).packet_payload;
    assert.equal(
      defaultAdapterPacket.schemaVersion,
      require("../lib/relational-truth-delivery-adapter").DELIVERY_SCHEMA_VERSION,
    );
    assert.equal(defaultAdapterPacket.truthProvenance.sourceCutId, completeCut.sourceCutId);

    const baseLostResponseCaller = createDbRpcCaller(db);
    let lostCompleteResponse = true;
    const lostResponseLedger = createTruthBuildLedger({
      workspaceKey: WORKSPACE,
      syncToken: TOKEN,
      callRpc: async (rpc, body, options) => {
        const receipt = await baseLostResponseCaller(rpc, body, options);
        if (rpc === RPC.completePair && lostCompleteResponse) {
          lostCompleteResponse = false;
          const error = new Error("simulated response loss after commit");
          error.status = 503;
          throw error;
        }
        return receipt;
      },
    });
    const recovered = await runRelationalTruthBuild(runnerOptions(
      lostResponseLedger,
      completeCut.sourceCutId,
      "lost-response",
    ));
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.recovered, true);
    assert.equal(lostCompleteResponse, false);

    const parityFixture = await buildCompletionFixture(
      ledger,
      completeCut.sourceCutId,
      "sql-parity-mismatch",
      "worker:parity",
    );
    const divergentDelivery = JSON.parse(JSON.stringify(parityFixture.delivery));
    divergentDelivery.counts.active += 1;
    const parityFailure = await ledger.completePair({
      ...parityFixture.lease,
      fullPacket: parityFixture.delivery,
      incrementalPacket: divergentDelivery,
      fullSemanticHash: parityFixture.internal.packetHash,
      incrementalSemanticHash: parityFixture.internal.packetHash,
      fullValidationReport: parityFixture.report,
      incrementalValidationReport: parityFixture.report,
    });
    assert.equal(parityFailure.status, "failed");
    assert.equal(parityFailure.errorCode, "BUILD_PARITY_MISMATCH");
    const parityBuildStates = await db.query(`
      select status, error_code
      from public.truth_builds
      where build_pair_id = $1
      order by build_mode
    `, [parityFixture.pair.buildPairId]);
    assert.deepEqual(parityBuildStates.rows.map((row) => row.status), ["failed", "failed"]);
    assert.ok(parityBuildStates.rows.every((row) => row.error_code === "BUILD_PARITY_MISMATCH"));

    const citationFixture = await buildCompletionFixture(
      ledger,
      completeCut.sourceCutId,
      "sql-citation-escape",
      "worker:citation",
    );
    const escapedInternal = JSON.parse(JSON.stringify(citationFixture.internal));
    escapedInternal.shipments[0].gates[0].claimVersionIds.push(`claim:v1:${"9".repeat(64)}`);
    const escapedReport = {
      ...citationFixture.report,
      internalReducerOutput: escapedInternal,
    };
    const citationFailure = await ledger.completePair({
      ...citationFixture.lease,
      fullPacket: citationFixture.delivery,
      incrementalPacket: citationFixture.delivery,
      fullSemanticHash: citationFixture.internal.packetHash,
      incrementalSemanticHash: citationFixture.internal.packetHash,
      fullValidationReport: escapedReport,
      incrementalValidationReport: escapedReport,
    });
    assert.equal(citationFailure.status, "failed");
    assert.equal(citationFailure.errorCode, "BUILD_CITATION_ESCAPE");

    const evidenceEscapeFixture = await buildCompletionFixture(
      ledger,
      completeCut.sourceCutId,
      "sql-out-of-cut-evidence-escape",
      "worker:evidence-escape",
    );
    const escapedEvidenceInternal = JSON.parse(JSON.stringify(evidenceEscapeFixture.internal));
    escapedEvidenceInternal.acceptedClaimCitations[0].evidenceObservationIds.push(OBS_B);
    const escapedEvidenceReport = {
      ...evidenceEscapeFixture.report,
      internalReducerOutput: escapedEvidenceInternal,
    };
    const evidenceEscapeFailure = await ledger.completePair({
      ...evidenceEscapeFixture.lease,
      fullPacket: evidenceEscapeFixture.delivery,
      incrementalPacket: evidenceEscapeFixture.delivery,
      fullSemanticHash: evidenceEscapeFixture.internal.packetHash,
      incrementalSemanticHash: evidenceEscapeFixture.internal.packetHash,
      fullValidationReport: escapedEvidenceReport,
      incrementalValidationReport: escapedEvidenceReport,
    });
    assert.equal(evidenceEscapeFailure.status, "failed");
    assert.equal(evidenceEscapeFailure.errorCode, "BUILD_EVIDENCE_ESCAPE");

    const firstPublication = await ledger.publishPair({
      buildPairId: good.pair.buildPairId,
      publicationRequestKey: "shadow-publication-one",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
    });
    assert.equal(firstPublication.publicationVersion, 1);
    const idempotentPublication = await ledger.publishPair({
      buildPairId: good.pair.buildPairId,
      publicationRequestKey: "shadow-publication-one",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
    });
    assert.equal(idempotentPublication.idempotent, true);
    assert.equal(idempotentPublication.publicationId, firstPublication.publicationId);

    const secondBuild = await runRelationalTruthBuild(runnerOptions(
      ledger,
      completeCut.sourceCutId,
      "runner-second",
    ));
    await assert.rejects(
      ledger.publishPair({
        buildPairId: secondBuild.pair.buildPairId,
        publicationRequestKey: "shadow-publication-two",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
      }),
      (error) => error?.code === "40001",
      "stale CAS expectations cannot advance a publication head",
    );
    const secondPublication = await ledger.publishPair({
      buildPairId: secondBuild.pair.buildPairId,
      publicationRequestKey: "shadow-publication-two",
      expectedHeadVersion: firstPublication.publicationVersion,
      expectedHeadPacketHash: firstPublication.packetHash,
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
    });
    assert.equal(secondPublication.publicationVersion, 2);

    const rollback = await ledger.rollbackForward({
      channel: "shadow",
      targetPublicationId: firstPublication.publicationId,
      publicationRequestKey: "shadow-rollback-forward",
      expectedHeadVersion: secondPublication.publicationVersion,
      expectedHeadPacketHash: secondPublication.packetHash,
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
    });
    assert.equal(rollback.publicationVersion, 3);
    assert.equal(rollback.publicationReason, "rollback");
    assert.equal(rollback.previousPublicationId, secondPublication.publicationId);
    assert.notEqual(rollback.publicationId, firstPublication.publicationId);
    const publicationHistory = await db.query(`
      select publication_id, publication_version, previous_publication_id,
             publication_reason, build_id
      from public.truth_publications
      where workspace_key = $1 and channel = 'shadow'
      order by publication_version
    `, [WORKSPACE]);
    assert.equal(publicationHistory.rows.length, 3);
    assert.equal(publicationHistory.rows[2].build_id, publicationHistory.rows[0].build_id);
    assert.equal(publicationHistory.rows[2].previous_publication_id, publicationHistory.rows[1].publication_id);

    const shadowHead = await ledger.readHead({ channel: "shadow" });
    assert.equal(shadowHead.publicationVersion, 3);
    assert.equal(shadowHead.deliveryPayloadHash, rollback.deliveryPayloadHash);
    const adapter = require("../lib/relational-truth-delivery-adapter");
    const targetBasePacket = (await one(db, `
      select build.packet_payload
      from public.truth_publications publication
      join public.truth_builds build on build.build_id = publication.build_id
      where publication.publication_id = $1
    `, [rollback.publicationId])).packet_payload;
    const independentlyFinalized = adapter.finalizePublishedTruthDelivery({
      deliveryPacket: targetBasePacket,
      publication: rollback.publicationAdapter,
    });
    assert.equal(independentlyFinalized.deliveryPayloadHash, rollback.deliveryPayloadHash);
    assert.equal(runnerTest.stableJson(independentlyFinalized), runnerTest.stableJson(shadowHead.deliveryPayload));
    await assert.rejects(
      ledger.readHead({ channel: "shadow", maxPayloadBytes: 1024 }),
      (error) => error?.code === "54000",
      "oversized publication reads fail closed rather than returning truncated truth",
    );

    const productionBuild = await runRelationalTruthBuild(runnerOptions(
      ledger,
      secondCut.sourceCutId,
      "candidate-production",
      { buildChannel: "candidate" },
    ));
    await assert.rejects(
      ledger.publishPair({
        buildPairId: productionBuild.pair.buildPairId,
        publicationRequestKey: "production-publication",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
      }),
      (error) => error?.code === "42501",
      "normal sync authority cannot publish production without an independent approval",
    );
    await assert.rejects(
      ledger.publishPair({
        buildPairId: productionBuild.pair.buildPairId,
        publicationRequestKey: "production-publication",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
        allowProduction: true,
      }),
      (error) => error?.code === "TRUTH_BUILD_INVALID_ARGUMENT",
      "a caller boolean cannot manufacture production authority",
    );
    const parkedGapId = "5dee7586-14c5-5ab3-a84b-622467ad6bb0";
    const deltaGapId = "6dee7586-14c5-5ab3-a84b-622467ad6bb0";
    await db.exec("set session_replication_role = replica");
    await db.query(`
      insert into public.gmail_completeness_gaps(
        gap_id, workspace_key, connection_key, gap_type,
        prior_cursor_value, recovery_anchor_value, status, detail
      ) values
        ($1, $3, 'primary', 'PARKED_BACKFILL_HISTORICAL_DRAIN',
         '19571223', '19640268', 'open', '{}'::jsonb),
        ($2, $3, 'primary', 'GMAIL_CUTOVER_DELTA_RECONCILIATION',
         '19571223', '19640268', 'open', '{}'::jsonb)
    `, [parkedGapId, deltaGapId, WORKSPACE]);
    await db.query(`
      with body as (
        select jsonb_build_object(
          'schemaVersion', 'truth-gmail-backfill-parking-receipt-v1',
          'authorityVersion', 'truth-gmail-primary-ingest-forward-unblock-v1',
          'workspaceKey', $1::text,
          'sourceSystem', 'gmail',
          'connectionKey', 'primary',
          'parkedBatchId', '118506f6-7c7b-4bb9-8f62-9a743513a8ca',
          'pageCount', 2190,
          'observationCount', 218989,
          'jobCount', 0,
          'persistedAnchor', jsonb_build_object('historyId', '19571223'),
          'resumedCursor', jsonb_build_object('version', 1, 'value', '19640268'),
          'coordinatorJobId', '5ae52e8d-dd30-582b-aef3-1ebdc65f0970',
          'coverageDisposition',
            'immutable_backfill_parked_pending_bounded_historical_adoption',
          'productionPublicationAttempted', false
        ) as value
      ), hashed as (
        select value, encode(extensions.digest(convert_to(
          private.truth_canonical_json_text(value), 'UTF8'
        ), 'sha256'), 'hex') as hash
        from body
      )
      insert into public.truth_gmail_backfill_parking_receipts(
        receipt_id, receipt_hash, workspace_key, source_system, connection_key,
        provider_account_email, provider_account_binding_hash,
        parked_batch_id, backfill_gap_id, cutover_delta_gap_id,
        coordinator_job_id, persisted_anchor_history_id, cutover_history_id,
        prior_cursor_version, resumed_cursor_version, page_count,
        observation_count, job_count, page_manifest_hash, provider_probe_hash,
        canonical_receipt, schema_version, parked_at
      )
      select 'truth-gmail-backfill-parking:v1:' || hash, hash,
        $1, 'gmail', 'primary', 'fixture@example.com', repeat('a', 64),
        '118506f6-7c7b-4bb9-8f62-9a743513a8ca', $2, $3,
        '5ae52e8d-dd30-582b-aef3-1ebdc65f0970', '19571223', '19640268',
        0, 1, 2190, 218989, 0, repeat('b', 64), repeat('c', 64),
        value, 'truth-gmail-backfill-parking-receipt-v1', now()
      from hashed
    `, [WORKSPACE, parkedGapId, deltaGapId]);
    await db.exec("set session_replication_role = origin");
    const firstProductionCredential = "production-approval-capability-one-000000000001";
    const firstProductionApprovalExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await expectSqlState(
      asRole(db, "service_role", () => issueProductionApproval(db, {
        buildPairId: productionBuild.pair.buildPairId,
        approvalRequestKey: "approve-production-publication-one-invalid-issuer",
        publicationRequestKey: "production-publication",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        credential: firstProductionCredential,
        expiresAt: firstProductionApprovalExpiry,
        issuerToken: TOKEN,
      })),
      "28000",
      "the normal sync credential cannot issue production authority",
    );
    const firstProductionApproval = await ledger.issueProductionApproval({
      buildPairId: productionBuild.pair.buildPairId,
      approvalRequestKey: "approve-production-publication-one",
      publicationRequestKey: "production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      approvedBy: "fixture-operator",
      approvalReason: "Focused local production-authority regression",
      credential: firstProductionCredential,
      expiresAt: firstProductionApprovalExpiry,
      issuerToken: APPROVAL_ISSUER_TOKEN,
    });
    assert.equal(firstProductionApproval.status, "issued");
    const idempotentFirstApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
      buildPairId: productionBuild.pair.buildPairId,
      approvalRequestKey: "approve-production-publication-one",
      publicationRequestKey: "production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      credential: firstProductionCredential,
      expiresAt: firstProductionApprovalExpiry,
      }),
    );
    assert.equal(idempotentFirstApproval.idempotent, true);
    assert.equal(idempotentFirstApproval.approvalId, firstProductionApproval.approvalId);
    const publishWithFirstApproval = () => ledger.publishPair({
      buildPairId: productionBuild.pair.buildPairId,
      publicationRequestKey: "production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: firstProductionApproval.approvalId,
        credential: firstProductionCredential,
      },
    });
    await assert.rejects(
      publishWithFirstApproval,
      (error) => error?.code === "23514",
      "an open cutover-delta gap remains production-blocking beside a valid parked boundary",
    );
    await db.query(`
      update public.gmail_completeness_gaps set status = 'closed'
      where gap_id = $1
    `, [deltaGapId]);
    const canonicalParkingReceipt = (await one(db, `
      select canonical_receipt from public.truth_gmail_backfill_parking_receipts
      where backfill_gap_id = $1
    `, [parkedGapId])).canonical_receipt;
    await db.exec("set session_replication_role = replica");
    await db.query(`
      update public.truth_gmail_backfill_parking_receipts
      set canonical_receipt = canonical_receipt || '{"pageCount":1}'::jsonb
      where backfill_gap_id = $1
    `, [parkedGapId]);
    await db.exec("set session_replication_role = origin");
    await assert.rejects(
      publishWithFirstApproval,
      (error) => error?.code === "23514",
      "a parked gap with a tampered parking receipt remains production-blocking",
    );
    await db.exec("set session_replication_role = replica");
    await db.query(`
      update public.truth_gmail_backfill_parking_receipts
      set canonical_receipt = $2::jsonb
      where backfill_gap_id = $1
    `, [parkedGapId, canonicalParkingReceipt]);
    await db.exec("set session_replication_role = origin");
    await assert.rejects(
      ledger.publishPair({
        buildPairId: productionBuild.pair.buildPairId,
        publicationRequestKey: "production-publication",
        expectedHeadVersion: 0,
        expectedHeadPacketHash: "",
        publicationReason: "normal",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
        productionApproval: {
          approvalId: firstProductionApproval.approvalId,
          credential: "wrong-production-approval-capability-000000000000",
        },
      }),
      (error) => error?.code === "42501",
      "a production approval ID without its independent credential is insufficient",
    );
    const productionPublication = await ledger.publishPair({
      buildPairId: productionBuild.pair.buildPairId,
      publicationRequestKey: "production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: firstProductionApproval.approvalId,
        credential: firstProductionCredential,
      },
    });
    assert.equal(productionPublication.channel, "production");
    const cutoverReceipt = (await one(db, `
      select public.read_truth_production_cutover_receipt($1, $2, $3) as receipt
    `, [WORKSPACE, productionPublication.publicationId, TOKEN])).receipt;
    assert.equal(cutoverReceipt.ok, true);
    assert.equal(cutoverReceipt.publicationChannel, "production");
    assert.equal(cutoverReceipt.approvalConsumed, true);
    assert.equal(cutoverReceipt.shipmentTruthPacketsMirrored, true);
    assert.equal(cutoverReceipt.activeAwbIndexMirrored, true);
    const issuerCheck = (await one(db, `
      select public.check_truth_production_publication_issuer($1, $2) as receipt
    `, [WORKSPACE, APPROVAL_ISSUER_TOKEN])).receipt;
    assert.equal(issuerCheck.issuerTokenReady, true);
    assert.equal(issuerCheck.productionPublicationAttempted, false);
    const recoveredProductionPublication = await ledger.publishPair({
      buildPairId: productionBuild.pair.buildPairId,
      publicationRequestKey: "production-publication",
      expectedHeadVersion: 0,
      expectedHeadPacketHash: "",
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: firstProductionApproval.approvalId,
        credential: firstProductionCredential,
      },
    });
    assert.equal(recoveredProductionPublication.idempotent, true);
    assert.equal(recoveredProductionPublication.publicationId, productionPublication.publicationId);
    await assert.rejects(
      ledger.publishPair({
        buildPairId: productionBuild.pair.buildPairId,
        publicationRequestKey: "production-publication-replayed",
        expectedHeadVersion: productionPublication.publicationVersion,
        expectedHeadPacketHash: productionPublication.packetHash,
        publicationReason: "repair",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
        productionApproval: {
          approvalId: firstProductionApproval.approvalId,
          credential: firstProductionCredential,
        },
      }),
      (error) => error?.code === "42501",
      "a consumed approval cannot authorize a different publication transition",
    );
    const cached = await one(db, `
      select packet.payload as packet_payload, active.payload as active_payload
      from public.app_snapshots packet
      cross join public.app_snapshots active
      where packet.snapshot_key = 'shipment-truth-packets'
        and active.snapshot_key = 'active-awb-index'
    `);
    assert.equal(cached.packet_payload.publicationId, productionPublication.publicationId);
    assert.equal(cached.packet_payload.deliveryPayloadHash, productionPublication.deliveryPayloadHash);
    assert.equal(cached.active_payload.publicationId, productionPublication.publicationId);

    const secondProductionBuild = await runRelationalTruthBuild(runnerOptions(
      ledger,
      secondCut.sourceCutId,
      "candidate-production-second",
      { buildChannel: "candidate" },
    ));
    const secondProductionCredential = "production-approval-capability-two-000000000002";
    const secondProductionApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
      buildPairId: secondProductionBuild.pair.buildPairId,
      approvalRequestKey: "approve-production-publication-two",
      publicationRequestKey: "production-publication-two",
      expectedHeadVersion: productionPublication.publicationVersion,
      expectedHeadPacketHash: productionPublication.packetHash,
      publicationReason: "normal",
      credential: secondProductionCredential,
      }),
    );
    const secondProductionPublication = await ledger.publishPair({
      buildPairId: secondProductionBuild.pair.buildPairId,
      publicationRequestKey: "production-publication-two",
      expectedHeadVersion: productionPublication.publicationVersion,
      expectedHeadPacketHash: productionPublication.packetHash,
      publicationReason: "normal",
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: secondProductionApproval.approvalId,
        credential: secondProductionCredential,
      },
    });
    assert.equal(secondProductionPublication.publicationVersion, 2);

    const stalePairCredential = "stale-production-pair-capability-00000000000004";
    const stalePairApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
        buildPairId: productionBuild.pair.buildPairId,
        approvalRequestKey: "approve-stale-production-pair-repair",
        publicationRequestKey: "stale-production-pair-repair",
        expectedHeadVersion: secondProductionPublication.publicationVersion,
        expectedHeadPacketHash: secondProductionPublication.packetHash,
        publicationReason: "repair",
        credential: stalePairCredential,
      }),
    );
    await assert.rejects(
      ledger.publishPair({
        buildPairId: productionBuild.pair.buildPairId,
        publicationRequestKey: "stale-production-pair-repair",
        expectedHeadVersion: secondProductionPublication.publicationVersion,
        expectedHeadPacketHash: secondProductionPublication.packetHash,
        publicationReason: "repair",
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
        productionApproval: {
          approvalId: stalePairApproval.approvalId,
          credential: stalePairCredential,
        },
      }),
      (error) => error?.code === "40001",
      "a fresh approval cannot use the legacy build-id idempotency path to consume stale production output",
    );
    assert.deepEqual(await one(db, `
      select status, consumed_at, consumed_publication_id
      from public.truth_production_publication_approvals
      where approval_id = $1::uuid
    `, [stalePairApproval.approvalId]), {
      status: "issued",
      consumed_at: null,
      consumed_publication_id: null,
    });
    const headAfterStalePairAttempt = await ledger.readHead({ channel: "production" });
    assert.equal(headAfterStalePairAttempt.publicationId, secondProductionPublication.publicationId);
    assert.equal(headAfterStalePairAttempt.publicationVersion, 2);

    await db.exec("begin");
    try {
      const inconsistentApprovalId = "90000000-0000-4000-8000-000000000001";
      await db.query(`
        insert into public.truth_production_publication_approvals (
          approval_id, workspace_key, operation, build_pair_id,
          target_publication_id, source_cut_id, build_id,
          approval_request_key, approval_request_hash,
          publication_request_key, expected_head_version,
          expected_head_packet_hash, publication_reason, publisher_version,
          published_by, approved_by, approval_reason,
          approval_credential_hash, status, expires_at, issued_at,
          consumed_at, consumed_publication_id
        ) values (
          $1::uuid, $2::text, 'build_pair_publish', $3::uuid,
          null, $4::text, $5::uuid,
          'fabricated-inconsistent-consumed-approval', $6::text,
          'production-publication', $7::bigint,
          $8::text, 'repair', 'truth-build-runtime-v1',
          'verifier', 'fixture-operator', 'adversarial consumed receipt',
          $9::text, 'consumed', clock_timestamp() + interval '10 minutes',
          clock_timestamp(), clock_timestamp(), $10::uuid
        )
      `, [
        inconsistentApprovalId,
        WORKSPACE,
        productionBuild.pair.buildPairId,
        secondCut.sourceCutId,
        productionBuild.pair.fullBuildId,
        HASH_A,
        secondProductionPublication.publicationVersion,
        secondProductionPublication.packetHash,
        HASH_B,
        productionPublication.publicationId,
      ]);
      await expectSqlState(
        db.query(`
          select private.consumed_truth_production_publication_receipt(
            approval
          )
          from public.truth_production_publication_approvals approval
          where approval.approval_id = $1::uuid
        `, [inconsistentApprovalId]),
        "23514",
        "consumed receipt recovery must verify approved reason, head, publisher, and resulting version",
      );
    } finally {
      await db.exec("rollback");
    }

    const disabledProductionBuild = await runRelationalTruthBuild(runnerOptions(
      ledger,
      secondCut.sourceCutId,
      "candidate-production-disabled-workspace",
      { buildChannel: "candidate" },
    ));
    const disabledPublishCredential = "disabled-workspace-publish-capability-0000000005";
    const disabledPublishApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
        buildPairId: disabledProductionBuild.pair.buildPairId,
        approvalRequestKey: "approve-disabled-workspace-publish",
        publicationRequestKey: "disabled-workspace-publish",
        expectedHeadVersion: secondProductionPublication.publicationVersion,
        expectedHeadPacketHash: secondProductionPublication.packetHash,
        publicationReason: "normal",
        credential: disabledPublishCredential,
      }),
    );
    const disabledRollbackCredential = "disabled-workspace-rollback-capability-000000006";
    const disabledRollbackApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
        operation: "rollback_forward",
        targetPublicationId: productionPublication.publicationId,
        approvalRequestKey: "approve-disabled-workspace-rollback",
        publicationRequestKey: "disabled-workspace-rollback",
        expectedHeadVersion: secondProductionPublication.publicationVersion,
        expectedHeadPacketHash: secondProductionPublication.packetHash,
        publicationReason: "rollback",
        credential: disabledRollbackCredential,
      }),
    );
    const disabledPair = await ledger.claimPair({
      sourceCutId: secondCut.sourceCutId,
      buildChannel: "shadow",
      triggerName: "disabled-workspace-post-claim-regression",
      idempotencyKey: "disabled-workspace-post-claim-regression",
      workerId: "worker:disabled-workspace",
      leaseSeconds: 300,
      bundleRowLimit: 100,
      versions: claimVersions(),
    });
    const disabledLease = {
      buildPairId: disabledPair.buildPairId,
      workerId: "worker:disabled-workspace",
      leaseFence: disabledPair.leaseFence,
    };
    const publicationCountBeforeDisable = (await one(db, `
      select count(*)::integer as count
      from public.truth_publications
      where workspace_key = $1 and channel = 'production'
    `, [WORKSPACE])).count;
    await db.query(`
      update public.truth_workspaces
      set status = 'disabled'
      where workspace_key = $1
    `, [WORKSPACE]);
    try {
      for (const [operation, attempt] of [
        ["claim", () => ledger.claimPair({
          sourceCutId: secondCut.sourceCutId,
          buildChannel: "shadow",
          triggerName: "disabled-workspace-claim-regression",
          idempotencyKey: "disabled-workspace-claim-regression",
          workerId: "worker:disabled-workspace-claim",
          leaseSeconds: 300,
          bundleRowLimit: 100,
          versions: claimVersions(),
        })],
        ["renew", () => ledger.renewLease({ ...disabledLease, leaseSeconds: 300 })],
        ["read", () => ledger.readBundle(disabledLease)],
        ["complete", () => ledger.completePair({
          ...disabledLease,
          fullPacket: {}, incrementalPacket: {},
          fullSemanticHash: HASH_A, incrementalSemanticHash: HASH_A,
          fullValidationReport: {}, incrementalValidationReport: {},
        })],
        ["fail", () => ledger.failPair({
          ...disabledLease,
          errorCode: "DISABLED_WORKSPACE_ATTEMPT",
          safeErrorDetail: "disabled workspace must be a kill boundary",
        })],
        ["shadow publish", () => ledger.publishPair({
          buildPairId: disabledPair.buildPairId,
          publicationRequestKey: "disabled-workspace-shadow-publish",
          expectedHeadVersion: 3,
          expectedHeadPacketHash: rollback.packetHash,
          publicationReason: "normal",
          publisherVersion: "truth-build-runtime-v1",
          publishedBy: "verifier",
        })],
        ["production publish", () => ledger.publishPair({
          buildPairId: disabledProductionBuild.pair.buildPairId,
          publicationRequestKey: "disabled-workspace-publish",
          expectedHeadVersion: secondProductionPublication.publicationVersion,
          expectedHeadPacketHash: secondProductionPublication.packetHash,
          publicationReason: "normal",
          publisherVersion: "truth-build-runtime-v1",
          publishedBy: "verifier",
          productionApproval: {
            approvalId: disabledPublishApproval.approvalId,
            credential: disabledPublishCredential,
          },
        })],
        ["production rollback", () => ledger.rollbackForward({
          channel: "production",
          targetPublicationId: productionPublication.publicationId,
          publicationRequestKey: "disabled-workspace-rollback",
          expectedHeadVersion: secondProductionPublication.publicationVersion,
          expectedHeadPacketHash: secondProductionPublication.packetHash,
          publisherVersion: "truth-build-runtime-v1",
          publishedBy: "verifier",
          productionApproval: {
            approvalId: disabledRollbackApproval.approvalId,
            credential: disabledRollbackCredential,
          },
        })],
        ["consumed retry", () => ledger.publishPair({
          buildPairId: productionBuild.pair.buildPairId,
          publicationRequestKey: "production-publication",
          expectedHeadVersion: 0,
          expectedHeadPacketHash: "",
          publicationReason: "normal",
          publisherVersion: "truth-build-runtime-v1",
          publishedBy: "verifier",
          productionApproval: {
            approvalId: firstProductionApproval.approvalId,
            credential: firstProductionCredential,
          },
        })],
      ]) {
        await assert.rejects(
          attempt(),
          (error) => error?.code === "42501",
          `${operation} must reject a disabled workspace before state changes`,
        );
      }
      const disabledApprovals = await db.query(`
        select approval_id, status, consumed_at, consumed_publication_id
        from public.truth_production_publication_approvals
        where approval_id = any ($1::uuid[])
        order by approval_id
      `, [[disabledPublishApproval.approvalId, disabledRollbackApproval.approvalId]]);
      assert.equal(disabledApprovals.rows.length, 2);
      assert.ok(disabledApprovals.rows.every((row) => (
        row.status === "issued" && row.consumed_at === null && row.consumed_publication_id === null
      )));
      assert.equal((await one(db, `
        select count(*)::integer as count
        from public.truth_publications
        where workspace_key = $1 and channel = 'production'
      `, [WORKSPACE])).count, publicationCountBeforeDisable);
    } finally {
      await db.query(`
        update public.truth_workspaces
        set status = 'active'
        where workspace_key = $1
      `, [WORKSPACE]);
    }

    await assert.rejects(
      ledger.rollbackForward({
        channel: "production",
        targetPublicationId: productionPublication.publicationId,
        publicationRequestKey: "production-rollback-without-approval",
        expectedHeadVersion: secondProductionPublication.publicationVersion,
        expectedHeadPacketHash: secondProductionPublication.packetHash,
        publisherVersion: "truth-build-runtime-v1",
        publishedBy: "verifier",
      }),
      (error) => error?.code === "42501",
      "normal sync authority cannot perform a production rollback-forward",
    );
    const rollbackCredential = "production-rollback-capability-000000000000000003";
    const productionRollbackApproval = await asRole(
      db,
      "service_role",
      () => issueProductionApproval(db, {
      operation: "rollback_forward",
      targetPublicationId: productionPublication.publicationId,
      approvalRequestKey: "approve-production-rollback",
      publicationRequestKey: "production-rollback-forward",
      expectedHeadVersion: secondProductionPublication.publicationVersion,
      expectedHeadPacketHash: secondProductionPublication.packetHash,
      publicationReason: "rollback",
      credential: rollbackCredential,
      }),
    );
    const productionRollback = await ledger.rollbackForward({
      channel: "production",
      targetPublicationId: productionPublication.publicationId,
      publicationRequestKey: "production-rollback-forward",
      expectedHeadVersion: secondProductionPublication.publicationVersion,
      expectedHeadPacketHash: secondProductionPublication.packetHash,
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: productionRollbackApproval.approvalId,
        credential: rollbackCredential,
      },
    });
    assert.equal(productionRollback.publicationVersion, 3);
    assert.equal(productionRollback.publicationReason, "rollback");
    const recoveredProductionRollback = await ledger.rollbackForward({
      channel: "production",
      targetPublicationId: productionPublication.publicationId,
      publicationRequestKey: "production-rollback-forward",
      expectedHeadVersion: secondProductionPublication.publicationVersion,
      expectedHeadPacketHash: secondProductionPublication.packetHash,
      publisherVersion: "truth-build-runtime-v1",
      publishedBy: "verifier",
      productionApproval: {
        approvalId: productionRollbackApproval.approvalId,
        credential: rollbackCredential,
      },
    });
    assert.equal(recoveredProductionRollback.idempotent, true);
    assert.equal(recoveredProductionRollback.publicationId, productionRollback.publicationId);
    assert.equal((await one(db, `
      select count(*)::integer as count
      from public.truth_production_publication_approvals
      where workspace_key = $1 and status = 'consumed'
    `, [WORKSPACE])).count, 3);

    const workspaceDisableConcurrency = await verifyWorkspaceDisableConcurrency();

    await verifyPermissions(db);

    const authoritySurface = await one(db, `
      select
        to_regprocedure('public.renew_truth_build_pair_lease(uuid,text,bigint,integer,text)') is null
          as old_renew_removed,
        to_regprocedure('public.read_truth_build_bundle(uuid,text,bigint,text)') is null
          as old_read_removed,
        to_regprocedure('public.complete_truth_build_pair(uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)') is null
          as old_complete_removed,
        to_regprocedure('public.fail_truth_build_pair(uuid,text,bigint,text,text,text)') is null
          as old_fail_removed,
        to_regprocedure('public.publish_truth_build_pair_runtime_cas(uuid,text,bigint,text,text,text,text,text,text)') is null
          as old_publish_removed,
        to_regprocedure('public.publish_truth_rollback_forward(text,text,uuid,text,bigint,text,text,text,text,text)') is null
          as old_rollback_removed,
        to_regprocedure('public.renew_truth_build_pair_lease(text,uuid,text,bigint,integer,text)') is not null
          as scoped_renew_exists,
        to_regprocedure('public.read_truth_build_bundle(text,uuid,text,bigint,text)') is not null
          as scoped_read_exists,
        to_regprocedure('public.complete_truth_build_pair(text,uuid,text,bigint,jsonb,jsonb,text,text,jsonb,jsonb,text)') is not null
          as scoped_complete_exists,
        to_regprocedure('public.fail_truth_build_pair(text,uuid,text,bigint,text,text,text)') is not null
          as scoped_fail_exists,
        to_regprocedure('public.publish_truth_build_pair_runtime_cas(text,uuid,text,bigint,text,text,text,text,uuid,text,text)') is not null
          as scoped_publish_exists,
        to_regprocedure('public.publish_truth_rollback_forward(text,text,uuid,text,bigint,text,text,text,uuid,text,text)') is not null
          as authorized_rollback_exists
    `);
    assert.ok(
      Object.values(authoritySurface).every(Boolean),
      `effective RPC authority surface is not fully isolated: ${JSON.stringify(authoritySurface)}`,
    );

    const publicationMigration = MIGRATIONS.find((migration) => (
      path.basename(migration) === "20260709230000_truth_build_publication_runtime.sql"
    ));
    const migrationSource = fs.readFileSync(publicationMigration, "utf8");
    assert.equal(
      (migrationSource.match(/insert into public\.truth_publications\s*\(/g) || []).length,
      1,
      "The migration must contain exactly one SQL publication insertion authority",
    );
    assert.match(migrationSource, /legacy truth publication authority is retired/);
    assert.doesNotMatch(
      migrationSource,
      /grant execute on function private\.(?:claim_truth_build_pair|complete_truth_build_pair|commit_truth_publication_runtime)[\s\S]{0,200}to service_role/,
      "Service role must not execute private build/publication implementations",
    );
    const authorityMigration = MIGRATIONS.find((migration) => (
      path.basename(migration) === "20260709240900_truth_production_authority_isolation.sql"
    ));
    const authorityMigrationSource = fs.readFileSync(authorityMigration, "utf8");
    const ledgerSource = fs.readFileSync(path.join(ROOT, "lib/truth-build-ledger.js"), "utf8");
    assert.doesNotMatch(
      authorityMigrationSource,
      /I_EXPLICITLY_AUTHORIZE_PRODUCTION_TRUTH_PUBLICATION/,
      "the effective authority migration must not carry a reusable confirmation phrase",
    );
    assert.doesNotMatch(
      ledgerSource,
      /PRODUCTION_CONFIRMATION/,
      "the runtime must not embed a production publication credential",
    );
    assert.match(authorityMigrationSource, /truth_production_approval_issuer/);
    assert.match(authorityMigrationSource, /expires_at <= issued_at \+ interval '15 minutes'/);
    assert.match(
      authorityMigrationSource,
      /require_active_truth_workspace[\s\S]*for share;/,
      "workspace authority must hold a lock that conflicts with status disable updates",
    );
    assert.doesNotMatch(authorityMigrationSource, /for key share;/);
    assert.match(
      authorityMigrationSource,
      /create or replace function public\.claim_truth_build_pair[\s\S]*require_active_truth_workspace/,
      "workspace disable must gate new claims as well as post-claim operations",
    );

    console.log(JSON.stringify({
      ok: true,
      verifier: "verify-relational-truth-build-runtime",
      sourceCutId: completeCut.sourceCutId,
      acceptedClaimVersionId: claim.claimVersionId,
      firstPublicationId: firstPublication.publicationId,
      rollbackPublicationId: rollback.publicationId,
      productionPublicationId: productionPublication.publicationId,
      productionRollbackPublicationId: productionRollback.publicationId,
      workspaceDisableConcurrency,
      checks: [
        "exact complete source cut required",
        "source-cut v2 rejects caller observation arrays and stores zero per-cut memberships",
        "large mailbox cuts stay constant-size while unclaimed mail changes the partition hash and cut identity",
        "build bundles contain only distinct recursively cited evidence and stay constant-size across unclaimed mail",
        "server-derived closed claim/link/workgroup bundle",
        "bounded reads fail closed without truncation",
        "duplicate claims are idempotent and overlaps are lease-fenced",
        "stale lease fences cannot read or complete",
        "full/incremental internal and delivery parity required",
        "lost completion responses recover by the same idempotency key",
        "failed parity and citation-escape builds remain durable",
        "recursive output claim/evidence citations close over the delivered evidence closure and exact cut",
        "out-of-cut and in-cut-but-unrelated observation citations fail closed",
        "CAS conflicts cannot advance publication heads",
        "rollback is a new forward publication with immutable history",
        "production publication and rollback require independent expiring one-time approval capabilities",
        "only an exact valid parked-backfill receipt exempts its own gap; tampered and delta gaps block production",
        "every post-claim pair UUID RPC is workspace-bound and old unscoped overloads are absent",
        "normal sync authority and caller booleans cannot manufacture production authority",
        "consumed approvals permit exact response-loss retry but reject altered replay",
        "fresh approval cannot republish an already-published stale pair or be falsely consumed",
        "disabled workspace rejects claim and every post-claim/publication operation without consuming approvals",
        "native two-session proof shows workspace disable waits for the authorization transaction to commit",
        "authority migration applies and reapplies cleanly",
        "SQL delivery hash matches the pure production finalizer",
        "publication, active index, and production cache commit atomically",
        "service role has public RPC access but no direct DML or private execution",
        "legacy caller-supplied publication authority is retired",
      ],
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

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

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const MIGRATION_NAMES = Object.freeze([
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709224000_truth_audit_runtime.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709226000_truth_link_workgroup_runtime.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709232000_truth_private_evidence_bucket.sql",
  "20260709233000_truth_worker_context_runtime.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
  "20260709236000_truth_operator_event_authority.sql",
  "20260709237000_truth_audit_status_read.sql",
  "20260709238000_truth_tms_inventory_presence_policy.sql",
  "20260709239000_truth_source_chronology.sql",
  "20260709239500_truth_claim_context_chronology.sql",
  "20260709240000_truth_review_resolution.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240600_truth_audit_shipment_metadata.sql",
  "20260709240700_truth_attachment_extraction_completeness.sql",
  "20260709240800_truth_audit_expired_running_status.sql",
  "20260709240900_truth_production_authority_isolation.sql",
]);

const WORKSPACE = "primary";
const SYNC_TOKEN = "attachment-completeness-sync-token-v1";
const REVIEW_TOKEN = "attachment-completeness-review-token-v1";
const AUDIT_TOKEN = "attachment-completeness-audit-token-v1";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function observationId(label) {
  return `obs:v1:${sha256(label)}`;
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

async function asRole(db, role, work) {
  await db.exec(`set role ${role}`);
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
  return db;
}

function nativePostgresBinDir() {
  const candidates = [
    process.env.PQ_TEST_POSTGRES_BIN_DIR,
    "/opt/homebrew/opt/postgresql@15/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@15/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    ...String(process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);
  for (const directory of candidates) {
    if (["initdb", "pg_ctl", "psql"].every((name) => (
      fs.existsSync(path.join(directory, name))
    ))) return directory;
  }
  throw new Error(
    "Native PostgreSQL initdb/pg_ctl/psql are required for the two-session source-cut proof.",
  );
}

function runNative(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function spawnPsql(psql, args, input) {
  const child = spawn(psql, args, { stdio: ["pipe", "pipe", "pipe"] });
  const session = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { session.stdout += chunk; });
  child.stderr.on("data", (chunk) => { session.stderr += chunk; });
  session.done = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  child.stdin.end(input);
  return session;
}

async function waitForSessionText(session, marker, timeoutMs = 10000) {
  if ((session.stdout + session.stderr).includes(marker)) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Timed out waiting for ${marker}: ${session.stdout} ${session.stderr}`,
    )), timeoutMs);
    const inspect = () => {
      if (!(session.stdout + session.stderr).includes(marker)) return;
      clearTimeout(timeout);
      resolve();
    };
    session.child.stdout.on("data", inspect);
    session.child.stderr.on("data", inspect);
    session.child.once("exit", (code) => {
      if (!(session.stdout + session.stderr).includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`Session exited ${code} before ${marker}: ${session.stderr}`));
      }
    });
    inspect();
  });
}

function parsePsqlJson(output, label) {
  const values = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (!values[index].startsWith("{")) continue;
    return JSON.parse(values[index]);
  }
  throw new Error(`${label} did not return JSON: ${output}`);
}

async function verifyNativeCutCompletionSerialization() {
  const binDir = nativePostgresBinDir();
  const initdb = path.join(binDir, "initdb");
  const pgCtl = path.join(binDir, "pg_ctl");
  const psql = path.join(binDir, "psql");
  const tempBase = process.platform === "darwin" ? "/tmp" : os.tmpdir();
  const tempRoot = fs.mkdtempSync(path.join(tempBase, "pq-cut-completion-lock-"));
  const dataDir = path.join(tempRoot, "data");
  const socketDir = path.join(tempRoot, "socket");
  const serverLog = path.join(tempRoot, "postgres.log");
  const port = 42000 + crypto.randomInt(10000);
  const workerId = "native-cut-worker";
  const processorVersion = "native-cut-processor-v1";
  const jobId = crypto.randomUUID();
  const derivedObservationId = observationId(`native-derived:${jobId}`);
  const derivedContentHash = sha256(`native-derived-content:${jobId}`);
  const derivedObservation = {
    observationId: derivedObservationId,
    sourceObjectType: "gmail_message_parsed",
    sourceObjectId: `native-derived-${jobId}`,
    operation: "content",
    contentHash: derivedContentHash,
    normalizedPayload: { schemaVersion: "gmail-message-parsed-v1" },
    normalizedText: "native derived shipment evidence",
    sourceFidelity: "normalized_source",
    schemaVersion: "gmail-message-parsed-v1",
  };
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
    const migrations = MIGRATION_NAMES.map((name) => (
      fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8")
    )).join("\n");
    runNative(psql, psqlArgs, {
      input: `
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
        ${migrations}
        insert into public.sync_tokens (token_name, token_hash)
        values ('local_snapshot_writer', encode(
          extensions.digest(convert_to('${SYNC_TOKEN}'::text, 'UTF8'), 'sha256'), 'hex'
        ));
      `,
    });

    runNative(psql, psqlArgs, {
      input: `
        do $seed$
        declare
          v_source record;
          v_now timestamptz := date_trunc('milliseconds', clock_timestamp());
          v_now_text text;
          v_cursor_value text;
          v_batch_id uuid;
          v_gmail_batch_id uuid;
          v_gmail_observation_id text;
          v_observation_id text;
          v_content_hash text;
          v_batch_hash text;
          v_provider_manifest jsonb;
          v_observation_manifest jsonb;
        begin
          v_now_text := to_char(
            v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          );
          for v_source in
            select * from (values
              ('gmail', 'primary', 'gmail_history_id', 'gmail_message'),
              ('tms', 'couriercloud-ops-tlv-us', 'tms_snapshot_timestamp', 'tms_source_witness'),
              ('tracking', 'carrier-tracking-primary', 'tracking_snapshot_timestamp', 'tracking_source_witness')
            ) source(source_system, connection_key, cursor_kind, object_type)
          loop
            v_cursor_value := case
              when v_source.source_system = 'gmail' then '100'
              else v_now_text
            end;
            v_content_hash := encode(extensions.digest(convert_to(
              'native-content:' || v_source.source_system, 'UTF8'
            ), 'sha256'), 'hex');
            v_observation_id := 'obs:v1:' || encode(extensions.digest(convert_to(
              'native-observation:' || v_source.source_system, 'UTF8'
            ), 'sha256'), 'hex');
            v_batch_hash := encode(extensions.digest(convert_to(
              'native-batch:' || v_source.source_system || ':' || v_cursor_value,
              'UTF8'
            ), 'sha256'), 'hex');

            insert into public.source_cursors (
              workspace_key, source_system, connection_key, cursor_kind,
              cursor_value, cursor_version, status, lease_fence,
              last_error_code, last_error_detail
            ) values (
              'primary', v_source.source_system, v_source.connection_key,
              v_source.cursor_kind, v_cursor_value, 1, 'live', 1, '', ''
            );
            insert into public.source_ingest_batches (
              workspace_key, source_system, connection_key, mode, trigger_name,
              expected_cursor_version, expected_cursor_value,
              committed_cursor_version, committed_cursor_value,
              lease_owner, lease_fence, status, batch_hash,
              page_count, observation_count, job_count,
              committed_at, finished_at
            ) values (
              'primary', v_source.source_system, v_source.connection_key,
              case when v_source.source_system = 'gmail' then 'history' else 'snapshot' end,
              'native-cut-completion-verifier', 0, '', 1, v_cursor_value,
              'native-cut-completion-verifier', 1, 'committed', v_batch_hash,
              0, 1, 0, v_now, v_now
            ) returning batch_id into v_batch_id;
            insert into public.source_observations (
              observation_id, workspace_key, source_system, connection_key,
              source_object_type, source_object_id, source_revision, operation,
              source_cursor_version, batch_id, content_hash, source_recorded_at,
              captured_at, normalized_payload, normalized_text,
              source_fidelity, schema_version
            ) values (
              v_observation_id, 'primary', v_source.source_system,
              v_source.connection_key, v_source.object_type,
              v_source.source_system || '-object-1', v_cursor_value, 'content',
              1, v_batch_id, v_content_hash, v_now, v_now,
              case when v_source.source_system = 'gmail'
                then jsonb_build_object('historyId', '100')
                else '{}'::jsonb
              end,
              'native source witness', 'normalized_source', 'source-observation-v1'
            );

            if v_source.source_system <> 'gmail' then
              v_provider_manifest := jsonb_build_object(
                'schemaVersion', v_source.source_system || '-source-witness-v1',
                'sourceSystem', v_source.source_system,
                'connectionKey', v_source.connection_key,
                'upstreamWatermark', v_cursor_value,
                'sourceSnapshotAt', v_now_text
              );
              v_observation_manifest := jsonb_build_array(jsonb_build_object(
                'observationId', v_observation_id,
                'contentHash', v_content_hash
              ));
              insert into public.source_ingest_manifests (
                batch_id, workspace_key, source_system, connection_key,
                next_cursor_value, source_snapshot_at, provider_manifest,
                provider_manifest_hash, observation_manifest,
                observation_manifest_hash, job_manifest, job_manifest_hash,
                payload_identity_hash
              ) values (
                v_batch_id, 'primary', v_source.source_system,
                v_source.connection_key, v_cursor_value, v_now,
                v_provider_manifest,
                encode(extensions.digest(convert_to(v_provider_manifest::text, 'UTF8'), 'sha256'), 'hex'),
                v_observation_manifest,
                encode(extensions.digest(convert_to(v_observation_manifest::text, 'UTF8'), 'sha256'), 'hex'),
                '[]'::jsonb,
                encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
                encode(extensions.digest(convert_to(jsonb_build_object(
                  'batchId', v_batch_id::text,
                  'provider', v_provider_manifest,
                  'observations', v_observation_manifest
                )::text, 'UTF8'), 'sha256'), 'hex')
              );
            else
              v_gmail_batch_id := v_batch_id;
              v_gmail_observation_id := v_observation_id;
            end if;

            update public.source_cursors
            set last_batch_id = v_batch_id,
                last_committed_at = v_now,
                updated_at = clock_timestamp()
            where workspace_key = 'primary'
              and source_system = v_source.source_system
              and connection_key = v_source.connection_key;
          end loop;

          insert into public.source_processing_jobs (
            job_id, dedupe_key, workspace_key, source_system, connection_key,
            job_kind, observation_id, source_object_id, state, attempt_count,
            max_attempts, lease_owner, lease_fence, lease_expires_at,
            processor_version, payload
          ) values (
            '${jobId}'::uuid, 'native-cut-completion:${jobId}',
            'primary', 'gmail', 'primary', 'gmail_parse_message',
            v_gmail_observation_id, 'gmail-object-1', 'leased', 1, 5,
            '${workerId}', 1, clock_timestamp() + interval '1 hour',
            '${processorVersion}', '{}'::jsonb
          );
          insert into public.source_processing_job_lineage (
            job_id, workspace_key, source_system, connection_key,
            root_batch_id, parent_job_id, root_job_id,
            source_cursor_version, source_cursor_value
          ) values (
            '${jobId}'::uuid, 'primary', 'gmail', 'primary',
            v_gmail_batch_id, null, '${jobId}'::uuid, 1, '100'
          );
        end;
        $seed$;
      `,
    });

    runNative(psql, psqlArgs, {
      input: `
        create or replace function private.source_cut_partition_witness(
          p_workspace_key text,
          p_source_system text,
          p_connection_key text,
          p_through_cursor_version bigint
        )
        returns jsonb
        language plpgsql
        volatile
        security definer
        set search_path = ''
        as $function$
        declare
          v_witness jsonb;
        begin
          select jsonb_build_object(
            'observationCount', count(*)::integer,
            'partitionHash', encode(extensions.digest(
              convert_to(coalesce(jsonb_agg(jsonb_build_object(
                'observationId', observation.observation_id,
                'contentHash', observation.content_hash
              ) order by observation.observation_id), '[]'::jsonb)::text, 'UTF8'),
              'sha256'
            ), 'hex')
          ) into v_witness
          from public.source_observations observation
          join public.source_ingest_batches batch
            on batch.batch_id = observation.batch_id
           and batch.workspace_key = observation.workspace_key
           and batch.source_system = observation.source_system
           and batch.connection_key = observation.connection_key
           and batch.status = 'committed'
           and batch.committed_cursor_version is not null
           and batch.committed_cursor_version >= observation.source_cursor_version
          where observation.workspace_key = p_workspace_key
            and observation.source_system = p_source_system
            and observation.connection_key = p_connection_key
            and observation.source_cursor_version <= p_through_cursor_version;
          if p_source_system = 'gmail' and p_connection_key = 'primary' then
            raise notice 'NATIVE_PARTITION_CAPTURED';
            perform pg_sleep(2);
          end if;
          return v_witness;
        end;
        $function$;
      `,
    });

    const sealSession = spawnPsql(psql, psqlArgs, `
      set role service_role;
      set client_min_messages = notice;
      set lock_timeout = '8s';
      select public.seal_current_source_cut(
        'primary', 'native-cut-completion-verifier', '${SYNC_TOKEN}'
      );
    `);
    await waitForSessionText(sealSession, "NATIVE_PARTITION_CAPTURED");
    const completionStartedAt = Date.now();
    const completionSession = spawnPsql(psql, psqlArgs, `
      set role service_role;
      set lock_timeout = '8s';
      select public.complete_source_processing_job(
        '${jobId}'::uuid,
        '${workerId}',
        1,
        '${processorVersion}',
        '{"schemaVersion":"native-cut-completion-result-v1"}'::jsonb,
        '${JSON.stringify([derivedObservation]).replace(/'/g, "''")}'::jsonb,
        '[]'::jsonb,
        '${SYNC_TOKEN}'
      );
    `);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(
      completionSession.child.exitCode,
      null,
      `worker completion escaped the cut lock: ${completionSession.stderr}`,
    );
    const [sealExit, completionExit] = await Promise.all([
      sealSession.done,
      completionSession.done,
    ]);
    const completionWaitMs = Date.now() - completionStartedAt;
    assert.equal(sealExit, 0, sealSession.stderr);
    assert.equal(completionExit, 0, completionSession.stderr);
    assert.ok(
      completionWaitMs >= 1000,
      `worker completion did not wait for the source-cut transaction (${completionWaitMs}ms)`,
    );
    const firstCut = parsePsqlJson(sealSession.stdout, "serialized first cut");
    const completion = parsePsqlJson(completionSession.stdout, "serialized worker completion");
    assert.equal(firstCut.status, "sealed");
    assert.equal(firstCut.completeness, "degraded");
    assert.ok(firstCut.gaps.some((gap) => gap.gapType === "SOURCE_PROCESSING_BACKLOG"));
    assert.equal(completion.state, "succeeded");
    assert.deepEqual(completion.resultObservationIds, [derivedObservationId]);

    const baseMigration = fs.readFileSync(
      path.join(MIGRATION_DIR, "20260709210000_truth_claims_builds_publications_audits.sql"),
      "utf8",
    );
    const witnessStart = baseMigration.indexOf(
      "create or replace function private.source_cut_partition_witness(",
    );
    const witnessEnd = baseMigration.indexOf("$function$;", witnessStart);
    assert.ok(witnessStart >= 0 && witnessEnd > witnessStart);
    runNative(psql, psqlArgs, {
      input: baseMigration.slice(witnessStart, witnessEnd + "$function$;".length),
    });

    const secondCut = parsePsqlJson(runNative(psql, psqlArgs, {
      input: `
        set role service_role;
        select public.seal_current_source_cut(
          'primary', 'native-cut-completion-verifier-after-worker', '${SYNC_TOKEN}'
        );
      `,
    }).stdout, "post-completion cut");
    assert.equal(secondCut.status, "sealed");
    assert.equal(secondCut.completeness, "complete");
    const witness = parsePsqlJson(runNative(psql, psqlArgs, {
      input: `
        select jsonb_build_object(
          'stored', jsonb_build_object(
            'observationCount', cursor_row.observation_count,
            'partitionHash', cursor_row.partition_hash
          ),
          'recomputed', private.source_cut_partition_witness(
            'primary', 'gmail', 'primary', cursor_row.through_cursor_version
          )
        )
        from public.source_cut_cursors cursor_row
        where cursor_row.source_cut_id = '${secondCut.sourceCutId}'
          and cursor_row.source_system = 'gmail'
          and cursor_row.connection_key = 'primary';
      `,
    }).stdout, "post-completion partition witness");
    assert.deepEqual(witness.stored, witness.recomputed);
    assert.equal(witness.stored.observationCount, 2);
    return {
      completionWaitMs,
      firstCutCompleteness: firstCut.completeness,
      secondCutCompleteness: secondCut.completeness,
      gmailObservationCount: witness.stored.observationCount,
    };
  } finally {
    if (started) {
      spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function applyMigration(db, name) {
  await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
}

async function installSchema(db) {
  for (const name of MIGRATION_NAMES) await applyMigration(db, name);
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values
      ('local_snapshot_writer', encode(
        extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_review_decider', encode(
        extensions.digest(convert_to($2::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_audit_runtime', encode(
        extensions.digest(convert_to($3::text, 'UTF8'), 'sha256'), 'hex'
      ))
  `, [SYNC_TOKEN, REVIEW_TOKEN, AUDIT_TOKEN]);
}

function sourceContract(sourceSystem) {
  if (sourceSystem === "gmail") {
    return { cursorKind: "gmail_history_id", objectType: "gmail_message" };
  }
  if (sourceSystem === "tms") {
    return { cursorKind: "tms_snapshot_timestamp", objectType: "tms_source_witness" };
  }
  if (sourceSystem === "tracking") {
    return { cursorKind: "tracking_snapshot_timestamp", objectType: "tracking_source_witness" };
  }
  throw new Error(`Unsupported source ${sourceSystem}`);
}

async function seedCommittedSource(db, {
  sourceSystem,
  connectionKey,
  version,
  cursorValue,
  sourceSnapshotAt,
}) {
  const contract = sourceContract(sourceSystem);
  const committedAt = new Date().toISOString();
  const contentHash = sha256(`content:${sourceSystem}:${connectionKey}:${version}`);
  const sourceObservationId = observationId(`source:${sourceSystem}:${connectionKey}:${version}`);
  const batchHash = sha256(`batch:${sourceSystem}:${connectionKey}:${version}:${cursorValue}`);

  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence,
      last_error_code, last_error_detail
    ) values ($1, $2, $3, $4, $5, $6, 'live', 1, '', '')
    on conflict (workspace_key, source_system, connection_key) do update
    set cursor_kind = excluded.cursor_kind,
        cursor_value = excluded.cursor_value,
        cursor_version = excluded.cursor_version,
        status = 'live',
        last_error_code = '',
        last_error_detail = ''
  `, [WORKSPACE, sourceSystem, connectionKey, contract.cursorKind, cursorValue, version]);

  const batch = await one(db, `
    insert into public.source_ingest_batches (
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count,
      committed_at, finished_at
    ) values (
      $1, $2, $3, $4, 'attachment-completeness-verifier',
      $5, $6, $7, $8,
      'attachment-completeness-verifier', 1, 'committed', $9,
      0, 1, 0, $10::timestamptz, $10::timestamptz
    ) returning batch_id
  `, [
    WORKSPACE,
    sourceSystem,
    connectionKey,
    sourceSystem === "gmail" ? "history" : "snapshot",
    Math.max(0, version - 1),
    version > 1 ? String(version - 1) : "",
    version,
    cursorValue,
    batchHash,
    committedAt,
  ]);

  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text, source_fidelity,
      schema_version
    ) values (
      $1, $2, $3, $4, $5, $6, $7, 'content',
      $8, $9::uuid, $10, $11::timestamptz,
      $12::timestamptz, '{}'::jsonb, 'source witness',
      'normalized_source', 'source-observation-v1'
    )
  `, [
    sourceObservationId,
    WORKSPACE,
    sourceSystem,
    connectionKey,
    contract.objectType,
    `${sourceSystem}-object-${version}`,
    String(version),
    version,
    batch.batch_id,
    contentHash,
    sourceSnapshotAt,
    committedAt,
  ]);

  if (sourceSystem !== "gmail") {
    const providerManifest = {
      schemaVersion: `${sourceSystem}-source-witness-v1`,
      sourceSystem,
      connectionKey,
      upstreamWatermark: cursorValue,
      sourceSnapshotAt,
    };
    const observationManifest = [{ observationId: sourceObservationId, contentHash }];
    await db.query(`
      insert into public.source_ingest_manifests (
        batch_id, workspace_key, source_system, connection_key,
        next_cursor_value, source_snapshot_at, provider_manifest,
        provider_manifest_hash, observation_manifest,
        observation_manifest_hash, job_manifest, job_manifest_hash,
        payload_identity_hash
      ) values (
        $1::uuid, $2, $3, $4, $5, $6::timestamptz, $7::jsonb,
        encode(extensions.digest(convert_to($7::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        $8::jsonb,
        encode(extensions.digest(convert_to($8::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        '[]'::jsonb,
        encode(extensions.digest(convert_to('[]'::jsonb::text, 'UTF8'), 'sha256'), 'hex'),
        encode(extensions.digest(convert_to(jsonb_build_object(
          'batchId', $1::text,
          'provider', $7::jsonb,
          'observations', $8::jsonb
        )::text, 'UTF8'), 'sha256'), 'hex')
      )
    `, [
      batch.batch_id,
      WORKSPACE,
      sourceSystem,
      connectionKey,
      cursorValue,
      sourceSnapshotAt,
      JSON.stringify(providerManifest),
      JSON.stringify(observationManifest),
    ]);
  }

  await db.query(`
    update public.source_cursors
    set last_batch_id = $1::uuid,
        last_committed_at = $2::timestamptz,
        updated_at = clock_timestamp()
    where workspace_key = $3
      and source_system = $4
      and connection_key = $5
  `, [batch.batch_id, committedAt, WORKSPACE, sourceSystem, connectionKey]);

  return { batchId: batch.batch_id, observationId: sourceObservationId };
}

async function seedIncompleteAttachment(db, {
  batchId,
  cursorVersion,
  label,
  status = "needs_document_parser",
  mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}) {
  const attachmentId = `gmail-attachment:${label}`;
  const rawObservationId = observationId(`raw:${label}`);
  const extractedObservationId = observationId(`extracted:${label}`);
  const rawHash = sha256(`raw-bytes:${label}`);
  const payload = {
    schemaVersion: "gmail-attachment-extracted-v1",
    workerVersion: "gmail-attachment-evidence-worker-v1",
    gmail: { messageId: `message-${label}`, threadId: `thread-${label}`, historyId: "100" },
    attachmentId,
    parentObservationId: rawObservationId,
    filename: `${label}.xlsx`,
    mimeType,
    rawSha256: rawHash,
    rawBytes: 42,
    extraction: {
      status,
      method: "mime-routing-v1",
      provenance: "deterministic",
      reviewRequired: true,
      reason: "Office document parser is unavailable.",
      confidence: 0,
      textBytes: 0,
    },
    classification: null,
    text: "",
  };
  const contentHash = sha256(JSON.stringify(payload));
  const capturedAt = new Date().toISOString();

  await db.query(`
    insert into public.source_observations (
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, source_recorded_at,
      captured_at, normalized_payload, normalized_text,
      raw_object_bucket, raw_object_key, raw_object_hash, raw_object_bytes,
      raw_content_type, source_fidelity, schema_version
    ) values
      ($1::text, 'primary', 'gmail', 'primary', 'gmail_attachment', $2::text, '100', 'content',
       $3::bigint, $4::uuid, $5::text, $6::timestamptz, $6::timestamptz,
       jsonb_build_object('attachmentId', $2::text), '',
       'truth-raw-private', $7::text, $5::text, 42, $8::text,
       'raw', 'gmail-attachment-bytes-v1'),
      ($9::text, 'primary', 'gmail', 'primary', 'gmail_attachment_extracted', $2::text, '100-extracted', 'content',
       $3::bigint, $4::uuid, $10::text, $6::timestamptz, $6::timestamptz,
       $11::jsonb, '',
       'truth-raw-private', $7::text, $5::text, 42, $8::text,
       'normalized_source', 'gmail-attachment-extracted-v1')
  `, [
    rawObservationId,
    attachmentId,
    cursorVersion,
    batchId,
    rawHash,
    capturedAt,
    `primary/gmail/${label}/${rawHash}`,
    mimeType,
    extractedObservationId,
    contentHash,
    JSON.stringify(payload),
  ]);

  const parent = await one(db, `
    insert into public.source_processing_jobs (
      dedupe_key, workspace_key, source_system, connection_key,
      job_kind, observation_id, source_object_id, state,
      attempt_count, max_attempts, processor_version, result,
      completed_at
    ) values (
      $1::text, 'primary', 'gmail', 'primary',
      'gmail_extract_attachment', $2::text, $3::text, 'succeeded',
      1, 5, 'gmail-attachment-evidence-worker-v1',
      jsonb_build_object(
        'schemaVersion', 'gmail-attachment-evidence-result-v1',
        'extractionStatus', $4::text,
        'reviewRequired', true,
        'claimJobQueued', false,
        'reviewJobQueued', false
      ),
      clock_timestamp()
    ) returning job_id
  `, [`parent:${label}`, rawObservationId, attachmentId, status]);
  await db.query(`
    insert into public.source_processing_job_lineage (
      job_id, workspace_key, source_system, connection_key, root_batch_id,
      parent_job_id, root_job_id, source_cursor_version, source_cursor_value
    ) values (
      $1::uuid, 'primary', 'gmail', 'primary', $2::uuid,
      null, $1::uuid, $3::bigint, '100'
    )
  `, [parent.job_id, batchId, cursorVersion]);
  await db.query(`
    insert into public.source_processing_job_observations (
      job_id, observation_id, ordinal
    ) values ($1::uuid, $2::text, 0)
  `, [parent.job_id, extractedObservationId]);
  return {
    attachmentId,
    rawObservationId,
    extractedObservationId,
    contentHash,
    parentJobId: parent.job_id,
  };
}

async function sealCurrent(db) {
  return asRole(db, "service_role", async () => (await one(db, `
    select public.seal_current_source_cut(
      'primary', 'attachment-completeness-verifier', $1
    ) as receipt
  `, [SYNC_TOKEN])).receipt);
}

async function readAuditSnapshot(db) {
  return asRole(db, "anon", async () => (await one(db, `
    select public.read_truth_audit_snapshot('primary', 1000, $1) as snapshot
  `, [AUDIT_TOKEN])).snapshot);
}

async function main() {
  const db = await createDatabase();
  try {
    await installSchema(db);
    const now = new Date().toISOString();
    const gmail = await seedCommittedSource(db, {
      sourceSystem: "gmail",
      connectionKey: "primary",
      version: 1,
      cursorValue: "100",
      sourceSnapshotAt: now,
    });
    await seedCommittedSource(db, {
      sourceSystem: "tms",
      connectionKey: "couriercloud-ops-tlv-us",
      version: 1,
      cursorValue: now,
      sourceSnapshotAt: now,
    });
    await seedCommittedSource(db, {
      sourceSystem: "tracking",
      connectionKey: "carrier-tracking-primary",
      version: 1,
      cursorValue: now,
      sourceSnapshotAt: now,
    });
    const attachment = await seedIncompleteAttachment(db, {
      batchId: gmail.batchId,
      cursorVersion: 1,
      label: "unreadable-office-release",
    });

    // Reapplication performs the forward-only backfill for pre-fix succeeded
    // jobs. A second reapplication must not duplicate the child or resolution
    // surfaces.
    await applyMigration(db, "20260709240700_truth_attachment_extraction_completeness.sql");
    await applyMigration(db, "20260709240700_truth_attachment_extraction_completeness.sql");
    const reviewChild = await one(db, `
      select count(*)::integer as count,
             min(child.job_id::text) as job_id,
             min(child.state) as state
      from public.source_processing_job_children link
      join public.source_processing_jobs child on child.job_id = link.child_job_id
      where link.parent_job_id = $1::uuid
        and child.job_kind = 'gmail_review_attachment_extraction'
    `, [attachment.parentJobId]);
    assert.equal(reviewChild.count, 1);
    assert.equal(reviewChild.state, "queued");

    const blocked = await sealCurrent(db);
    assert.equal(blocked.status, "not_ready");
    assert.equal(blocked.sourceCutId, null);
    assert.equal(blocked.gaps[0].gapType, "ATTACHMENT_EXTRACTION_REVIEW_PENDING");
    assert.equal(blocked.gaps[0].count, 1);
    assert.equal((await one(db, "select count(*)::integer as count from public.source_cuts")).count, 0);

    const firstAudit = await readAuditSnapshot(db);
    assert.equal(firstAudit.source.attachmentExtractionCompleteness.unresolvedCount, 1);
    assert.equal(firstAudit.source.attachmentExtractionGaps[0].attachment_observation_id,
      attachment.extractedObservationId);

    // Advance Gmail to a later committed batch. The old attachment gap must
    // remain in both the cut witness and audit snapshot despite no longer being
    // part of the current batch lineage.
    await seedCommittedSource(db, {
      sourceSystem: "gmail",
      connectionKey: "primary",
      version: 2,
      cursorValue: "200",
      sourceSnapshotAt: new Date().toISOString(),
    });
    const laterAudit = await readAuditSnapshot(db);
    assert.equal(laterAudit.source.attachmentExtractionCompleteness.unresolvedCount, 1);
    assert.equal(laterAudit.source.attachmentExtractionGaps[0].attachment_observation_id,
      attachment.extractedObservationId);
    assert.equal((await sealCurrent(db)).status, "not_ready");

    await asRole(db, "service_role", async () => {
      await expectSqlState(
        db.query(`
          select public.resolve_gmail_attachment_extraction(
            'primary', $1, $2, 'reviewed_non_operational', '[]'::jsonb,
            'attachment-reviewer', 'Reviewed immutable bytes; no shipment evidence.',
            'attachment-review-1', 'wrong-review-token', $3
          )
        `, [attachment.extractedObservationId, attachment.contentHash, SYNC_TOKEN]),
        "28000",
        "attachment review requires its independent review token",
      );
      const receipt = (await one(db, `
        select public.resolve_gmail_attachment_extraction(
          'primary', $1, $2, 'reviewed_non_operational', '[]'::jsonb,
          'attachment-reviewer', 'Reviewed immutable bytes; no shipment evidence.',
          'attachment-review-1', $3, $4
        ) as receipt
      `, [attachment.extractedObservationId, attachment.contentHash, REVIEW_TOKEN, SYNC_TOKEN])).receipt;
      assert.equal(receipt.ok, true);
      assert.equal(receipt.idempotent, false);
      assert.equal(receipt.mutatesOperationalState, false);

      const repeat = (await one(db, `
        select public.resolve_gmail_attachment_extraction(
          'primary', $1, $2, 'reviewed_non_operational', '[]'::jsonb,
          'attachment-reviewer', 'Reviewed immutable bytes; no shipment evidence.',
          'attachment-review-1', $3, $4
        ) as receipt
      `, [attachment.extractedObservationId, attachment.contentHash, REVIEW_TOKEN, SYNC_TOKEN])).receipt;
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.resolutionId, receipt.resolutionId);

      await expectSqlState(
        db.query(`
          select public.resolve_gmail_attachment_extraction(
            'primary', $1, $2, 'reviewed_non_operational', '[]'::jsonb,
            'attachment-reviewer', 'Different request under reused key.',
            'attachment-review-1', $3, $4
          )
        `, [attachment.extractedObservationId, attachment.contentHash, REVIEW_TOKEN, SYNC_TOKEN]),
        "23505",
        "attachment review idempotency cannot be retargeted",
      );
    });

    const resolvedJob = await one(db, `
      select state, processor_version, result->>'resolutionId' as resolution_id
      from public.source_processing_jobs
      where job_id = $1::uuid
    `, [reviewChild.job_id]);
    assert.equal(resolvedJob.state, "succeeded");
    assert.equal(resolvedJob.processor_version, "gmail-attachment-review-resolution-v1");
    assert.match(resolvedJob.resolution_id, /^attachment-resolution:v1:[0-9a-f]{64}$/);

    const resolvedAudit = await readAuditSnapshot(db);
    assert.equal(resolvedAudit.source.attachmentExtractionCompleteness.unresolvedCount, 0);
    assert.deepEqual(resolvedAudit.source.attachmentExtractionGaps, []);

    const sealed = await sealCurrent(db);
    assert.equal(sealed.status, "sealed");
    assert.equal(sealed.completeness, "complete");
    assert.ok(sealed.sourceCutId);

    await asRole(db, "anon", async () => {
      await expectSqlState(
        db.query("select * from public.gmail_attachment_extraction_resolutions"),
        "42501",
        "browser roles cannot read attachment review decisions",
      );
      await expectSqlState(
        db.query(`
          select public.resolve_gmail_attachment_extraction(
            'primary', $1, $2, 'reviewed_non_operational', '[]'::jsonb,
            'browser', 'forbidden', 'browser-key', $3, $4
          )
        `, [attachment.extractedObservationId, attachment.contentHash, REVIEW_TOKEN, SYNC_TOKEN]),
        "42501",
        "browser roles cannot execute attachment review resolution",
      );
    });

    const nativeCutCompletionSerialization =
      await verifyNativeCutCompletionSerialization();

    console.log(JSON.stringify({
      ok: true,
      checks: 39,
      guarantees: [
        "legacy incomplete attachment successes backfill one replayable review child",
        "unresolved attachment evidence blocks source cuts across later Gmail batches",
        "the bounded audit snapshot carries the durable cross-batch gap inventory",
        "exact-target review resolution is authenticated, immutable, and idempotent",
        "resolved attachment review permits an otherwise complete source cut",
        "source-cut partition, backlog, review, and worker completion share one serialized boundary",
      ],
      nativeCutCompletionSerialization,
      mutatesLiveState: false,
    }));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");
const {
  compareClaimPriority,
  explainPriority,
} = require("../lib/truth-precedence-policy");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_NAMES = Object.freeze([
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709239000_truth_source_chronology.sql",
]);
const WORKSPACE = "primary";
const CONNECTION = "gmail-source-chronology-verifier";
const TOKEN = "truth-source-chronology-sync-token";
const BATCH_ID = "99999999-9999-4999-8999-999999999999";

function hash(char) {
  return char.repeat(64);
}

function observationId(char) {
  return `obs:v1:${hash(char)}`;
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

async function asServiceRole(db, work) {
  await db.exec("set role service_role");
  try {
    return await work();
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
  for (const name of MIGRATION_NAMES) {
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", name), "utf8"));
  }
  // The forward migration is intentionally safe under local stack reapply.
  await db.exec(fs.readFileSync(
    path.join(ROOT, "supabase/migrations/20260709239000_truth_source_chronology.sql"),
    "utf8",
  ));
  await db.query(`
    insert into public.sync_tokens (token_name, token_hash)
    values (
      'local_snapshot_writer',
      encode(extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex')
    )
  `, [TOKEN]);
  await db.query(`
    insert into public.source_cursors (
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status
    ) values ($1, 'gmail', $2, 'gmail_history_id', '100', 1, 'live')
  `, [WORKSPACE, CONNECTION]);
  await db.query(`
    insert into public.source_ingest_batches (
      batch_id, workspace_key, source_system, connection_key, mode,
      trigger_name, expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value, lease_owner,
      lease_fence, status, page_count, observation_count, job_count,
      committed_at, finished_at
    ) values (
      $1::uuid, $2, 'gmail', $3, 'backfill', 'source-chronology-verifier',
      0, '', 1, '100', 'source-chronology-verifier', 1, 'committed',
      1, 11, 0, '2026-07-09T12:00:00.000Z', '2026-07-09T12:00:00.000Z'
    )
  `, [BATCH_ID, WORKSPACE, CONNECTION]);
}

const OBSERVATIONS = Object.freeze([
  // Scenario A was processed newest first, then the older contradiction.
  { id: observationId("1"), object: "a-new", source: "2026-07-09T09:00:00.000Z", captured: "2026-07-09T10:00:00.000Z" },
  { id: observationId("2"), object: "a-old", source: "2026-07-09T08:00:00.000Z", captured: "2026-07-09T10:01:00.000Z" },
  // Scenario B was processed oldest first, then the newer resolution.
  { id: observationId("3"), object: "b-old", source: "2026-07-09T08:00:00.000Z", captured: "2026-07-09T11:00:00.000Z" },
  { id: observationId("4"), object: "b-new", source: "2026-07-09T09:00:00.000Z", captured: "2026-07-09T11:01:00.000Z" },
  // Fallback, explicit-event, and impossible-future boundaries.
  { id: observationId("5"), object: "no-source-time", source: null, captured: "2026-07-09T12:00:00.000Z" },
  { id: observationId("6"), object: "explicit-event", source: "2026-07-09T09:00:00.000Z", captured: "2026-07-09T12:01:00.000Z" },
  { id: observationId("7"), object: "impossible-future", source: "2026-07-11T13:00:00.000Z", captured: "2026-07-09T12:02:00.000Z" },
  { id: observationId("8"), object: "attachment-1", type: "gmail_attachment", source: "2026-07-09T09:30:00.000Z", captured: "2026-07-09T12:03:00.000Z" },
  { id: observationId("9"), object: "attachment-1", type: "gmail_attachment_extracted", source: null, captured: "2026-07-09T12:04:00.000Z", parent: observationId("8") },
  // The extractor ran days later, but its raw parent proves the Gmail clock
  // was already impossibly future at source capture time.
  { id: observationId("a"), object: "attachment-future", type: "gmail_attachment", source: "2026-07-11T13:00:00.000Z", captured: "2026-07-09T12:05:00.000Z" },
  { id: observationId("b"), object: "attachment-future", type: "gmail_attachment_extracted", source: null, captured: "2026-07-12T14:00:00.000Z", parent: observationId("a") },
]);

async function seedObservations(db) {
  for (let index = 0; index < OBSERVATIONS.length; index += 1) {
    const item = OBSERVATIONS[index];
    await db.query(`
      insert into public.source_observations (
        observation_id, workspace_key, source_system, connection_key,
        source_object_type, source_object_id, source_revision, operation,
        source_cursor_version, batch_id, content_hash, source_recorded_at,
        captured_at, normalized_payload, normalized_text, source_fidelity,
        schema_version
      ) values (
        $1, $2, 'gmail', $3, $4, $5, $6, 'content',
        1, $7::uuid, $8, $9::timestamptz, $10::timestamptz,
        $11::jsonb, $12, 'normalized_source', $13
      )
    `, [
      item.id,
      WORKSPACE,
      CONNECTION,
      item.type || "gmail_message_parsed",
      item.object,
      String(index + 1),
      BATCH_ID,
      hash("abcdef01234"[index]),
      item.source,
      item.captured,
      item.type === "gmail_attachment_extracted" ? {
        schemaVersion: "gmail-attachment-extracted-v1",
        parentObservationId: item.parent,
        attachmentId: item.object,
        gmail: { messageId: "attachment-parent-message", threadId: "attachment-parent-thread" },
        text: "Customs released in attached document.",
      } : item.type === "gmail_attachment" ? {
        schemaVersion: "gmail-attachment-v1",
        attachmentId: item.object,
        gmailMessageId: "attachment-parent-message",
        gmailThreadId: "attachment-parent-thread",
      } : {
        schemaVersion: "gmail-parsed-message-v1",
        gmail: { messageId: item.object, threadId: `thread-${item.object}`, internalDate: "" },
        subject: "Shipment customs state",
        date: item.source || item.captured,
        text: item.object.includes("new") ? "Customs released." : "Customs not released.",
      },
      item.object.includes("new") ? "Customs released." : "Customs not released.",
      item.type === "gmail_attachment_extracted"
        ? "gmail-attachment-extracted-v1"
        : item.type === "gmail_attachment"
          ? "gmail-attachment-v1"
          : "gmail-parsed-message-v1",
    ]);
  }
}

function claim({
  claimKey,
  versionNo,
  previousClaimVersionId = null,
  observation,
  subjectKey,
  polarity,
  occurredAt = null,
}) {
  return {
    claimKey,
    versionNo,
    previousClaimVersionId,
    primaryObservationId: observation.id,
    subjectType: "shipment",
    subjectKey,
    predicate: "customs_release",
    gate: "customs",
    polarity,
    normalizedValue: {
      status: polarity === "positive" ? "complete" : "blocked",
      effect: polarity === "positive" ? "complete" : "block",
      responsibleActor: "customs_broker",
      evidenceDirectness: "direct_actor_statement",
      sourceClass: "gmail_parsed_message",
    },
    occurredAt,
    confidence: 0.98,
    confidenceLabel: "high",
    extractionMethod: "deterministic",
    extractorVersion: "source-chronology-verifier-v1",
    promptVersion: "",
    model: "",
    acceptanceMethod: "policy",
    acceptancePolicyVersion: "source-chronology-policy-v1",
    acceptedBy: "source-chronology-verifier",
    decision: "accepted",
    evidenceSpan: { start: 0, end: 17, unit: "utf16_code_units" },
    recordedAt: "2026-07-09T12:10:00.000Z",
    schemaVersion: "accepted-claim-v1",
  };
}

async function appendClaim(db, input) {
  const receipt = await asServiceRole(db, async () => (await one(db, `
    select public.append_accepted_claim(
      $1::text, $2::jsonb, $3::jsonb, '[]'::jsonb, $4::text
    ) as receipt
  `, [
    WORKSPACE,
    input,
    [{ observationId: input.primaryObservationId, evidenceRole: "primary", evidenceSpan: input.evidenceSpan }],
    TOKEN,
  ])).receipt);
  assert.match(receipt.claimVersionId, /^claim:v1:[0-9a-f]{64}$/);
  return receipt;
}

async function persistedClaim(db, claimVersionId) {
  const row = await one(db, `
    select
      claim.claim_version_id,
      claim.claim_key,
      claim.version_no,
      claim.subject_type,
      claim.subject_key,
      claim.predicate,
      claim.gate,
      claim.polarity,
      claim.normalized_value,
      claim.occurred_at,
      claim.captured_at,
      claim.recorded_at,
      claim.confidence,
      envelope.canonical_envelope
    from public.accepted_claims claim
    join public.accepted_claim_envelopes envelope
      on envelope.claim_version_id = claim.claim_version_id
    where claim.claim_version_id = $1
  `, [claimVersionId]);
  assert.equal(
    new Date(row.canonical_envelope.claim.occurredAt).toISOString(),
    row.occurred_at.toISOString(),
    "the effective source chronology must be committed inside the hashed envelope and table",
  );
  return {
    claimVersionId: row.claim_version_id,
    claimKey: row.claim_key,
    versionNo: Number(row.version_no),
    subjectType: row.subject_type,
    subjectKey: row.subject_key,
    predicate: row.predicate,
    gate: row.gate,
    polarity: row.polarity,
    normalizedValue: row.normalized_value,
    occurredAt: row.occurred_at.toISOString(),
    capturedAt: row.captured_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    confidence: Number(row.confidence),
    sourceClass: "gmail_parsed_message",
  };
}

async function verifyOutOfOrderEquivalence(db) {
  const aKey = "shipment:01680000056:customs_release";
  const aNewReceipt = await appendClaim(db, claim({
    claimKey: aKey,
    versionNo: 1,
    observation: OBSERVATIONS[0],
    subjectKey: "01680000056",
    polarity: "positive",
  }));
  const aOldReceipt = await appendClaim(db, claim({
    claimKey: aKey,
    versionNo: 2,
    previousClaimVersionId: aNewReceipt.claimVersionId,
    observation: OBSERVATIONS[1],
    subjectKey: "01680000056",
    polarity: "negative",
  }));

  const bKey = "shipment:01680000057:customs_release";
  const bOldReceipt = await appendClaim(db, claim({
    claimKey: bKey,
    versionNo: 1,
    observation: OBSERVATIONS[2],
    subjectKey: "01680000057",
    polarity: "negative",
  }));
  const bNewReceipt = await appendClaim(db, claim({
    claimKey: bKey,
    versionNo: 2,
    previousClaimVersionId: bOldReceipt.claimVersionId,
    observation: OBSERVATIONS[3],
    subjectKey: "01680000057",
    polarity: "positive",
  }));

  const aNew = await persistedClaim(db, aNewReceipt.claimVersionId);
  const aOld = await persistedClaim(db, aOldReceipt.claimVersionId);
  const bOld = await persistedClaim(db, bOldReceipt.claimVersionId);
  const bNew = await persistedClaim(db, bNewReceipt.claimVersionId);
  assert.equal(aNew.occurredAt, "2026-07-09T09:00:00.000Z");
  assert.equal(aOld.occurredAt, "2026-07-09T08:00:00.000Z");
  assert.equal(bNew.occurredAt, "2026-07-09T09:00:00.000Z");
  assert.equal(bOld.occurredAt, "2026-07-09T08:00:00.000Z");
  assert.equal(aOld.capturedAt > aNew.capturedAt, true, "newest-first capture order is intentionally inverted");
  assert.equal(bNew.capturedAt > bOld.capturedAt, true, "oldest-first capture order is intentionally normal");
  assert(compareClaimPriority(aNew, aOld) > 0);
  assert(compareClaimPriority(bNew, bOld) > 0);
  assert.equal(explainPriority(aNew, aOld).decisiveCriterion, "event_time");
  assert.equal(explainPriority(bNew, bOld).decisiveCriterion, "event_time");
  assert.deepEqual(
    { polarity: aNew.polarity, status: aNew.normalizedValue.status, occurredAt: aNew.occurredAt },
    { polarity: bNew.polarity, status: bNew.normalizedValue.status, occurredAt: bNew.occurredAt },
    "newest-first and oldest-first replay must resolve to the same semantic truth",
  );
}

async function verifyBoundaries(db) {
  const fallbackReceipt = await appendClaim(db, claim({
    claimKey: "shipment:01680000058:customs_release",
    versionNo: 1,
    observation: OBSERVATIONS[4],
    subjectKey: "01680000058",
    polarity: "positive",
  }));
  assert.equal(
    (await persistedClaim(db, fallbackReceipt.claimVersionId)).occurredAt,
    OBSERVATIONS[4].captured,
    "capture time is the fallback only when the primary observation has no source time",
  );

  const explicitReceipt = await appendClaim(db, claim({
    claimKey: "shipment:01680000059:customs_release",
    versionNo: 1,
    observation: OBSERVATIONS[5],
    subjectKey: "01680000059",
    polarity: "positive",
    occurredAt: "2026-07-09T07:30:00.000Z",
  }));
  assert.equal(
    (await persistedClaim(db, explicitReceipt.claimVersionId)).occurredAt,
    "2026-07-09T07:30:00.000Z",
    "an explicit event timestamp must never be replaced by message chronology",
  );

  const attachmentReceipt = await appendClaim(db, claim({
    claimKey: "shipment:01680000061:customs_release",
    versionNo: 1,
    observation: OBSERVATIONS[8],
    subjectKey: "01680000061",
    polarity: "positive",
  }));
  assert.equal(
    (await persistedClaim(db, attachmentReceipt.claimVersionId)).occurredAt,
    OBSERVATIONS[7].source,
    "extracted attachment claims inherit the immutable raw attachment Gmail source time",
  );

  await expectSqlState(
    appendClaim(db, claim({
      claimKey: "shipment:01680000060:customs_release",
      versionNo: 1,
      observation: OBSERVATIONS[6],
      subjectKey: "01680000060",
      polarity: "positive",
    })),
    "22008",
    "impossible future Gmail chronology must fail closed",
  );

  await expectSqlState(
    appendClaim(db, claim({
      claimKey: "shipment:01680000062:customs_release",
      versionNo: 1,
      observation: OBSERVATIONS[10],
      subjectKey: "01680000062",
      polarity: "positive",
    })),
    "22008",
    "derived Gmail evidence must validate source time against its raw parent's capture clock",
  );
}

async function verifyAuthorityAndImmutability(db) {
  const privileges = await one(db, `
    select
      has_function_privilege(
        'service_role',
        'private.append_accepted_claim(text,jsonb,jsonb,jsonb,text)',
        'EXECUTE'
      ) as legacy_core,
      has_function_privilege(
        'service_role',
        'private.append_accepted_claim_source_chronology(text,jsonb,jsonb,jsonb,text)',
        'EXECUTE'
      ) as chronology_wrapper,
      has_function_privilege(
        'service_role',
        'public.append_accepted_claim(text,jsonb,jsonb,jsonb,text)',
        'EXECUTE'
      ) as public_rpc
  `);
  assert.equal(privileges.legacy_core, false, "service code must not bypass source chronology");
  assert.equal(privileges.chronology_wrapper, true);
  assert.equal(privileges.public_rpc, true);
  await expectSqlState(
    db.exec("update public.source_observations set source_recorded_at = captured_at"),
    "55000",
    "source chronology remains append-only",
  );
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await install(db);
    await seedObservations(db);
    await verifyAuthorityAndImmutability(db);
    await verifyOutOfOrderEquivalence(db);
    await expectSqlState(
      db.exec("update public.accepted_claims set occurred_at = captured_at"),
      "55000",
      "accepted chronology remains append-only",
    );
    await verifyBoundaries(db);
    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-source-chronology",
      checks: [
        "the forward migration is reapply-safe and the service role cannot bypass its source-chronology wrapper",
        "accepted claims without explicit event time bind primary sourceRecordedAt into both the immutable SQL row and hashed envelope",
        "newest-first and oldest-first contradictory Gmail backfills resolve to the same later-message truth",
        "capturedAt is only the fallback when source time is absent and explicit occurredAt remains authoritative",
        "extracted attachment claims inherit source time from their immutable raw attachment parent",
        "impossibly future Gmail source time, including delayed derived evidence, and chronology mutations fail closed",
      ],
      liveCalls: 0,
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

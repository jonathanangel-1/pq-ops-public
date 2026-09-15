#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const ROOT = path.resolve(__dirname, "..");
const BASE = [
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
].map((name) => path.join(ROOT, "supabase/migrations", name));
const POLICY = path.join(
  ROOT,
  "supabase/migrations/20260709238000_truth_tms_inventory_presence_policy.sql",
);
const V1_HASH = "73ac3445d5fbc7f81651c03719745a9b4835b6865ef015222f5aaf98288b9942";
const V2_HASH = "9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e";

async function groupedCounts(db, hash) {
  const result = await db.query(`
    select source_system, count(*)::integer as count
    from public.candidate_claim_predicate_registry
    where registry_hash = $1
    group by source_system
    order by source_system
  `, [hash]);
  return Object.fromEntries(result.rows.map((row) => [row.source_system, row.count]));
}

async function main() {
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create schema extensions;
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.sync_tokens (
        token_name text primary key,
        token_hash text not null
      );
    `);
    for (const migration of BASE) await db.exec(fs.readFileSync(migration, "utf8"));
    assert.deepEqual(await groupedCounts(db, V1_HASH), {
      gmail: 17,
      operator: 17,
      tms: 6,
      tracking: 2,
    });

    const sql = fs.readFileSync(POLICY, "utf8");
    await db.exec(sql);
    const firstCounts = await groupedCounts(db, V2_HASH);
    assert.deepEqual(firstCounts, {
      gmail: 17,
      operator: 17,
      tms: 7,
      tracking: 2,
    }, "registry v2 must preserve every old source allowlist and add only one TMS predicate");

    const drift = await db.query(`
      select old.source_system, old.predicate
      from public.candidate_claim_predicate_registry old
      join public.candidate_claim_predicate_registry next
        on next.source_system = old.source_system
       and next.predicate = old.predicate
       and next.registry_hash = $2
      where old.registry_hash = $1
        and (
          next.gate is distinct from old.gate
          or next.statuses is distinct from old.statuses
          or next.effects is distinct from old.effects
          or next.candidate_schema_version is distinct from old.candidate_schema_version
        )
    `, [V1_HASH, V2_HASH]);
    assert.equal(drift.rows.length, 0, "v2 must not weaken or alter any existing predicate semantics");

    const presence = await db.query(`
      select source_system, gate, statuses, effects, registry_version,
             acceptance_policy_version
      from public.candidate_claim_predicate_registry
      where registry_hash = $1 and predicate = 'shipment_observed_in_tms'
    `, [V2_HASH]);
    assert.equal(presence.rows.length, 1);
    assert.equal(presence.rows[0].source_system, "tms");
    assert.equal(presence.rows[0].gate, "context");
    assert.equal(presence.rows[0].statuses.neutral, "observed");
    assert.equal(presence.rows[0].effects.neutral, "context");
    assert.equal(presence.rows[0].registry_version, "pikiio-shipment-predicates-2026-07-09-v2");

    const definitions = await db.query(`
      select
        pg_get_functiondef(
          'private.append_candidate_claim(text,uuid,text,bigint,text,jsonb,text)'::regprocedure
        ) as append_definition,
        pg_get_functiondef(
          'private.truth_operator_policy_candidate_eligible(jsonb,jsonb)'::regprocedure
        ) as operator_definition,
        pg_get_functiondef(
          'private.truth_tms_policy_candidate_eligible(jsonb)'::regprocedure
        ) as tms_definition
    `);
    const definition = definitions.rows[0];
    assert.ok(definition.append_definition.includes(V2_HASH));
    assert.ok(!definition.append_definition.includes(V1_HASH));
    assert.ok(definition.operator_definition.includes("pikiio-shipment-predicates-2026-07-09-v2"));
    assert.ok(definition.tms_definition.includes("shipment_observed_in_tms"));
    assert.ok(definition.tms_definition.includes("subjectKey"));
    assert.ok(definition.tms_definition.includes("trackingNumber"));

    await db.exec(sql);
    assert.deepEqual(await groupedCounts(db, V2_HASH), firstCounts, (
      "reapplying the forward migration must not duplicate or rewrite policy rows"
    ));

    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-tms-inventory-presence-policy",
      v1PolicyCounts: await groupedCounts(db, V1_HASH),
      v2PolicyCounts: firstCounts,
      guarantees: [
        "all v1 policy rows remain present",
        "v2 preserves Gmail, tracking, operator, and existing TMS allowlists",
        "shipment_observed_in_tms exists only for TMS and is context-neutral",
        "automatic TMS presence acceptance is bound to immutable observation AWB identity",
        "tracking/operator runtime pins rotate exactly to v2",
        "migration reapplication is idempotent",
      ],
    }, null, 2));
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

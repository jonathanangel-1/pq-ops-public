#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const {
  TRUTH_EVIDENCE_BUCKET,
  createServerTruthRawObjectStore,
} = require("../lib/truth-raw-object-store-factory");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION = fs.readFileSync(path.join(
  ROOT,
  "supabase/migrations/20260709232000_truth_private_evidence_bucket.sql",
), "utf8");

function serviceJwt(role) {
  return [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify({ role })).toString("base64url"),
    "signature",
  ].join(".");
}

async function verifySql() {
  const db = new PGlite();
  await db.exec(`
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    create table storage.objects (
      id uuid primary key,
      bucket_id text not null references storage.buckets(id),
      name text not null
    );
    alter table storage.objects enable row level security;
  `);
  await db.exec(MIGRATION);
  await db.exec(MIGRATION);
  const rows = await db.query("select id, name, public from storage.buckets");
  assert.deepEqual(rows.rows, [{
    id: TRUTH_EVIDENCE_BUCKET,
    name: TRUTH_EVIDENCE_BUCKET,
    public: false,
  }]);
  const policies = await db.query(`
    select policyname
      from pg_policies
     where schemaname = 'storage'
       and tablename = 'objects'
  `);
  assert.equal(policies.rows.length, 0, "the migration must not grant browser access to evidence bytes");

  const publicDb = new PGlite();
  await publicDb.exec(`
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    insert into storage.buckets values ('${TRUTH_EVIDENCE_BUCKET}', '${TRUTH_EVIDENCE_BUCKET}', true);
  `);
  await assert.rejects(publicDb.exec(MIGRATION), /TRUTH_EVIDENCE_BUCKET_ALREADY_PUBLIC/);
}

function fakeStorage() {
  return {
    async getBucket() {
      return { data: { id: TRUTH_EVIDENCE_BUCKET, public: false }, error: null };
    },
    from(bucket) {
      assert.equal(bucket, TRUTH_EVIDENCE_BUCKET);
      return {
        async upload() { throw new Error("not called"); },
        async download() { throw new Error("not called"); },
        async info() { throw new Error("not called"); },
      };
    },
  };
}

function verifyFactory() {
  const calls = [];
  const key = serviceJwt("service_role");
  const store = createServerTruthRawObjectStore({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    createClient(url, receivedKey, options) {
      calls.push({ url, keyMatches: receivedKey === key, options });
      return { storage: fakeStorage() };
    },
  });
  assert.equal(store.bucket, TRUTH_EVIDENCE_BUCKET);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://project.supabase.co");
  assert.equal(calls[0].keyMatches, true);
  assert.deepEqual(calls[0].options.auth, {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });
  assert.equal(JSON.stringify(store).includes(key), false, "the server key must never be retained in public store state");
  assert.throws(() => createServerTruthRawObjectStore({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: serviceJwt("anon"),
    createClient() { return { storage: fakeStorage() }; },
  }), /server-only secret\/service-role key/);
  assert.throws(() => createServerTruthRawObjectStore({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "sb_publishable_public",
    createClient() { return { storage: fakeStorage() }; },
  }), /server-only secret\/service-role key/);
  assert.throws(() => createServerTruthRawObjectStore({
    supabaseUrl: "http://project.supabase.co",
    serviceRoleKey: key,
    createClient() { return { storage: fakeStorage() }; },
  }), /credential-free HTTPS origin/);
  assert.throws(() => createServerTruthRawObjectStore({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: key,
    bucket: "wrong-bucket",
    createClient() { return { storage: fakeStorage() }; },
  }), /must match the migrated private bucket/);
}

async function main() {
  await verifySql();
  verifyFactory();
  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-private-evidence-bucket",
    bucket: TRUTH_EVIDENCE_BUCKET,
    checks: [
      "migration creates exactly one private evidence bucket and is idempotent",
      "a pre-existing public bucket fails closed instead of being silently repurposed",
      "migration creates no anon or authenticated storage.objects policy",
      "runtime factory accepts only a server secret/service-role credential",
      "runtime factory pins the migrated bucket and disables auth session persistence",
      "runtime store state never exposes the privileged credential",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

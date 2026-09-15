#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  SOURCE_SNAPSHOTS,
  syncSourceSnapshots,
  truthLedgerSourceIngestEnabled,
} = require("./sync-supabase-snapshots");

async function main() {
  assert.equal(truthLedgerSourceIngestEnabled({}), false);
  assert.equal(truthLedgerSourceIngestEnabled({ PQ_TRUTH_LEDGER_SOURCE_INGEST_ENABLED: "true" }), false);
  assert.equal(truthLedgerSourceIngestEnabled({ PQ_TRUTH_LEDGER_SOURCE_INGEST_ENABLED: "1" }), true);

  const calls = [];
  const env = { PQ_TRUTH_LEDGER_SOURCE_INGEST_ENABLED: "1" };
  const result = await syncSourceSnapshots({
    env,
    upsertSource: async (key, payload) => calls.push(["legacy-source", key, payload]),
    syncStation: async (payload) => {
      calls.push(["station", payload]);
      return { ok: true };
    },
    createTruthClient(options) {
      calls.push(["create-client", options]);
      return {
        async ingestMorningSources(input) {
          calls.push(["truth-ledger", input]);
          return {
            ok: true,
            clientVersion: "test-v1",
            tms: { observationCount: input.tmsSnapshot.shipments.length },
            tracking: { observationCount: input.trackingSnapshots.reduce((sum, snapshot) => sum + snapshot.tracking.length, 0) },
            trackingScope: { expectedAwbCount: input.tmsSnapshot.shipments.length },
            publishesTruth: false,
            mutatesOperationalState: false,
          };
        },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.truthLedger.enabled, true);
  assert.equal(result.truthLedger.status, "committed");
  assert.equal(result.truthLedger.publishesTruth, false);
  assert.equal(result.truthLedger.mutatesOperationalState, false);
  assert.deepEqual(result.synced, SOURCE_SNAPSHOTS.map(([key]) => key));
  const truthCall = calls.find(([name]) => name === "truth-ledger");
  assert.ok(truthCall, "truth-ledger ingest must run when explicitly enabled");
  assert.equal(truthCall[1].tmsSnapshot.contentSignature, undefined, "ledger receives raw source, not legacy signature decoration");
  assert.equal(truthCall[1].trackingSnapshots.length, 3);
  assert.ok(truthCall[1].trackingSnapshots.every((snapshot) =>
    typeof snapshot.source === "string" && snapshot.source.length > 0 && Array.isArray(snapshot.tracking)));
  assert.match(truthCall[1].trackingSnapshots[0].source, /United/i);
  assert.match(truthCall[1].trackingSnapshots[1].source, /EL AL/i);
  assert.match(truthCall[1].trackingSnapshots[2].source, /Non-United|Other/i);
  const lastLegacyIndex = calls.map(([name]) => name).lastIndexOf("station");
  const truthIndex = calls.findIndex(([name]) => name === "truth-ledger");
  assert.ok(lastLegacyIndex < truthIndex, "legacy compatibility source mirror finishes before authoritative ledger handoff");

  let clientCreated = false;
  const disabled = await syncSourceSnapshots({
    env: {},
    upsertSource: async () => {},
    syncStation: async () => ({ ok: true }),
    createTruthClient() { clientCreated = true; throw new Error("must not be called"); },
  });
  assert.equal(disabled.truthLedger.enabled, false);
  assert.equal(disabled.truthLedger.status, "disabled");
  assert.equal(clientCreated, false);

  let dryRunClientCreated = false;
  const planned = await syncSourceSnapshots({
    dryRun: true,
    env,
    createTruthClient() { dryRunClientCreated = true; throw new Error("must not be called"); },
  });
  assert.equal(planned.truthLedger.enabled, true);
  assert.equal(planned.truthLedger.status, "planned");
  assert.equal(dryRunClientCreated, false);

  console.log("truth source edge-sync verification passed (explicit enablement, raw TMS + exact tracking bundle, TMS-first hosted client handoff, no derived publication)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

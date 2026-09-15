#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assessRelationalPublication,
  sourceExpectations,
  waitForRelationalMorningPublication,
} = require("../lib/morning-relational-publication");
const {
  parseLastJsonObject,
  validateTruthLedgerReceipt,
} = require("./run-morning-refresh");

const ROOT_DIR = path.resolve(__dirname, "..");
const TMS_TIME = "2026-07-23T10:20:00.000Z";
const PACKET_TIME = "2026-07-23T10:22:00.000Z";
const WRITER = "relational-truth-delivery-adapter-v5-public-certification";

function fixtures() {
  const expected = {
    tmsSnapshotTime: TMS_TIME,
    tmsActiveAwbCount: 2,
    tmsActiveAwbs: ["02080000213", "70080000314"],
  };
  const certification = {
    status: "certified",
    activeRowsChecked: 59,
    tmsActiveInventoryAwbsChecked: 2,
    certifiedActiveRows: 59,
    problemCount: 0,
    problems: [],
    problemAwbs: [],
  };
  const health = {
    ok: true,
    status: "live",
    checkedAt: "2026-07-23T10:22:30.000Z",
    truth: {
      snapshotTime: PACKET_TIME,
      stale: false,
      writerVersion: WRITER,
      rowCertification: certification,
    },
    gmail: {
      state: { snapshotTime: PACKET_TIME, stale: false },
      proof: { snapshotTime: PACKET_TIME, stale: false },
      refreshHealth: {
        snapshotTime: PACKET_TIME,
        stale: false,
        lastRunStatus: "success",
      },
    },
    hostedPersistence: { ok: true },
    tmsInventory: {
      ok: true,
      snapshots: {
        "tms-detail-snapshot": { snapshotTime: TMS_TIME },
        "tms-grid-snapshot": { snapshotTime: TMS_TIME },
      },
      embedded: {
        snapshotTime: TMS_TIME,
        activeAwbCount: 2,
      },
    },
  };
  const brain = {
    ok: true,
    snapshotTime: PACKET_TIME,
    sourceOfTruth: "relational-truth-ledger",
    writerVersion: WRITER,
    sourceTruthWarnings: [],
    sourceHealth: {
      status: "live",
      degraded: false,
      sourceGapRequired: false,
      warnings: [],
      rowCertification: certification,
      tmsInventoryFreshness: {
        snapshotTime: TMS_TIME,
        activeAwbCount: 2,
      },
    },
    shipments: [{
      awb: "700-80000314",
      sourceCertification: { status: "source-backed" },
      opsState: { phase: "moving" },
    }],
  };
  return { expected, health, brain };
}

async function main() {
const source = sourceExpectations({
  snapshotTime: TMS_TIME,
  shipments: [
    { trackingNumber: "700-80000314" },
    { trackingNumber: "02080000213" },
    { trackingNumber: "70080000314" },
  ],
});
assert.equal(source.tmsActiveAwbCount, 2);
assert.deepEqual(source.tmsActiveAwbs, ["02080000213", "70080000314"]);

const parsed = parseLastJsonObject("npm output\n{\"progress\":true}\n{\n  \"ok\": true,\n  \"truthLedger\": {\"status\":\"committed\"}\n}\n");
assert.equal(parsed.truthLedger.status, "committed");

const committedReceipt = {
  ok: true,
  truthLedger: {
    enabled: true,
    status: "committed",
    tms: {
      payloadIdentity: "tms-payload",
      committedCursorValue: TMS_TIME,
      observationCount: 2,
      jobCount: 2,
    },
    trackingScope: {
      tmsCursorValue: TMS_TIME,
      expectedAwbCount: 2,
    },
    tracking: {
      payloadIdentity: "tracking-payload",
      committedCursorValue: TMS_TIME,
      observationCount: 2,
      jobCount: 2,
    },
  },
};
assert.equal(validateTruthLedgerReceipt(committedReceipt).ok, true);
for (const mutate of [
  (value) => { value.truthLedger.enabled = false; },
  (value) => { value.truthLedger.status = "disabled"; },
  (value) => { value.truthLedger.tms.payloadIdentity = null; },
  (value) => { value.truthLedger.trackingScope.tmsCursorValue = null; },
  (value) => { value.truthLedger.tracking.payloadIdentity = null; },
]) {
  const invalid = structuredClone(committedReceipt);
  mutate(invalid);
  assert.equal(validateTruthLedgerReceipt(invalid).ok, false);
}

const healthy = fixtures();
assert.equal(assessRelationalPublication(healthy).ok, true);

const quietGmail = structuredClone(healthy);
quietGmail.health.gmail.state.stale = true;
quietGmail.health.gmail.proof.stale = true;
assert.equal(
  assessRelationalPublication(quietGmail).ok,
  true,
  "fresh successful refresh health must certify unchanged Gmail state/proof",
);

for (const [reason, mutate] of [
  ["truth-health-not-live", (value) => { value.health.status = "degraded"; value.health.ok = false; }],
  ["health-writer-not-relational", (value) => { value.health.truth.writerVersion = "canonical-publisher-v1"; }],
  ["packet-embedded-tms-cut-mismatch", (value) => { value.health.tmsInventory.embedded.snapshotTime = "2026-07-22T00:00:00.000Z"; }],
  ["gmail-proof-stale", (value) => {
    value.health.gmail.proof.stale = true;
    value.health.gmail.refreshHealth.stale = true;
  }],
  ["gmail-refresh-not-fresh-success", (value) => {
    value.health.gmail.refreshHealth.lastRunStatus = "failed";
  }],
  ["health-projection-packet-cut-mismatch", (value) => { value.brain.snapshotTime = "2026-07-23T10:21:00.000Z"; }],
  ["shipment-source-gap-rows", (value) => { value.brain.shipments[0].sourceCertification.status = "source-gap"; }],
]) {
  const value = structuredClone(healthy);
  mutate(value);
  const assessment = assessRelationalPublication(value);
  assert.equal(assessment.ok, false);
  assert.ok(assessment.reasons.includes(reason), reason);
}

const requests = [];
const responses = new Map([
  ["/api/truth/health", healthy.health],
  ["/api/brain/shipments", healthy.brain],
]);
const fetchImpl = async (url, options = {}) => {
  const parsedUrl = new URL(url);
  requests.push({ pathname: parsedUrl.pathname, method: options.method || "GET" });
  return new Response(JSON.stringify(responses.get(parsedUrl.pathname)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
const waited = await waitForRelationalMorningPublication({
  expected: healthy.expected,
  fetchImpl,
  timeoutMs: 30_000,
  pollIntervalMs: 1_000,
  httpTimeoutMs: 1_000,
  now: () => Date.parse("2026-07-23T10:22:30.000Z"),
  sleep: async () => {
    throw new Error("healthy fixture must not poll twice");
  },
});
assert.equal(waited.ok, true);
assert.equal(waited.mutatesState, false);
assert.deepEqual(requests, [
  { pathname: "/api/truth/health", method: "GET" },
  { pathname: "/api/brain/shipments", method: "GET" },
]);

const runner = fs.readFileSync(path.join(ROOT_DIR, "scripts", "run-morning-refresh.js"), "utf8");
const sourceIndex = runner.indexOf('runNpmScript("supabase:sync:sources"');
const waitIndex = runner.indexOf('runNpmScript("truth:wait:relational-morning"');
const safetyIndex = runner.indexOf('runNpmScript("verify:draft-safety"');
assert.ok(sourceIndex !== -1 && waitIndex > sourceIndex && safetyIndex > waitIndex);
for (const forbidden of [
  'runNpmScript("truth:refresh:local"',
  'runNpmScript("hosted:canonical-refresh"',
  'runNpmScript("supabase:sync:truth"',
]) {
  assert.equal(runner.includes(forbidden), false, forbidden);
}

console.log(JSON.stringify({
  ok: true,
  verifier: "morning-relational-refresh",
  checks: [
    "committed truth-ledger receipt required",
    "exact relational TMS cut and roster required",
    "Gmail health and row certification required",
    "mixed, stale, legacy, warning, and source-gap surfaces refused",
    "GET-only public read-back",
    "legacy publisher absent from morning runner",
  ],
  mutatesState: false,
}, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

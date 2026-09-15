"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  clone,
  definitionsForProfile,
  evaluateTruthLivenessEvidence,
  evaluateTruthSoakEvidence,
  executeProfile,
  parseFeature,
  parseProfileArg,
  truthLivenessFixture,
  truthSoakFixture,
} = require("../../scripts/verify-pikiio-truth-phase-gherkin");
const {
  ProductChildProtocolError,
  runHostileProductFixture,
  runProductChild,
} = require("../pikiio-truth-phase-mutant-probe");

const ROOT = path.resolve(__dirname, "../..");

function product(relativePath, operation, input = {}) {
  return runProductChild({
    sourcePath: path.join(ROOT, relativePath),
    originalRelativePath: relativePath,
    operation,
    input,
  });
}

function expectProtocolCode(operation, code) {
  assert.throws(
    operation,
    (error) => error instanceof ProductChildProtocolError && error.code === code,
  );
}

function cut(fill) {
  return `cut:v1:${fill.repeat(64)}`;
}

function codeSet(result) {
  return new Set(result.findings.map((finding) => finding.code));
}

function expectFinding(operation, code) {
  const fixture = truthSoakFixture();
  operation(fixture);
  const result = evaluateTruthSoakEvidence(fixture);
  assert.equal(result.ok, false);
  assert.ok(codeSet(result).has(code), `${code}: ${JSON.stringify(result.findings)}`);
}

const evidenceCases = [
  {
    name: "01 clean twenty-five-hour truth soak passes and returns immutable evidence",
    run() {
      const result = evaluateTruthSoakEvidence(truthSoakFixture());
      assert.equal(result.ok, true);
      assert.equal(result.cycleCount, 3);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.findings));
      const gherkin = executeProfile("truth-soak-gherkin-v1");
      assert.equal(gherkin.population, 15);
      assert.equal(gherkin.passed, 15);
      const livenessGherkin = executeProfile("truth-liveness-gherkin-v1");
      assert.equal(livenessGherkin.population, 15);
      assert.equal(livenessGherkin.passed, 15);
      assert.equal(evaluateTruthLivenessEvidence(null).ok, false);
      const livenessFixture = clone(truthLivenessFixture());
      assert.equal(evaluateTruthLivenessEvidence(livenessFixture).ok, true);
      const cycle = livenessFixture.cycles[0];
      cycle.acceptances[0].frontierId = "frontier:other";
      cycle.acceptances[0].productionPublicationAttempted = true;
      cycle.truthLedger.productionPublicationAttempted = true;
      cycle.publication.publisher = "packet-cache";
      cycle.publication.packetHash = "invalid";
      cycle.queues.liveBacklogStart = -1;
      cycle.audit.finishedAt = cycle.startedAt;
      const livenessCodes = codeSet(
        evaluateTruthLivenessEvidence(livenessFixture),
      );
      for (const code of [
        "SOURCE_ACCEPTANCE_IDENTITY_MISMATCH",
        "ACCEPTANCE_PUBLICATION_ATTEMPTED",
        "TRUTH_LEDGER_PUBLICATION_ATTEMPTED",
        "RELATIONAL_PUBLISHER_REQUIRED",
        "PUBLICATION_PACKET_HASH_INVALID",
        "LIVE_QUEUE_RECEIPT_INVALID",
        "AUDIT_ORDER_INVALID",
      ]) {
        assert.ok(livenessCodes.has(code), code);
      }
      const nonArraySources = truthLivenessFixture();
      nonArraySources.cycles[0].frontiers = {};
      nonArraySources.cycles[0].acceptances = {};
      assert.equal(evaluateTruthLivenessEvidence(nonArraySources).ok, false);
      assert.equal(
        parseProfileArg(["--profile=truth-soak-gherkin-v1"]),
        "truth-soak-gherkin-v1",
      );
      assert.throws(() => parseProfileArg([]), /Exactly one immutable/);
      assert.throws(() => parseProfileArg(["--profile=unknown"]), /Unknown immutable/);
      assert.throws(() => definitionsForProfile("unknown"), /Unknown immutable/);
      assert.throws(() => executeProfile("unknown"), /Unknown immutable/);
      assert.throws(() => parseFeature("Given a step"), /Step appears before/);
      assert.throws(() => parseFeature("Feature: x\nunsupported"), /Unsupported Gherkin/);
    },
  },
  { name: "02 wrong soak schema is rejected", code: "SOAK_EVIDENCE_INVALID", mutate: (f) => { f.schema = "wrong"; } },
  { name: "03 wrong soak phase is rejected", code: "SOAK_EVIDENCE_INVALID", mutate: (f) => { f.phaseId = "TRUTH-01"; } },
  { name: "04 non-array soak cycles are rejected", code: "SOAK_EVIDENCE_INVALID", mutate: (f) => { f.cycles = {}; } },
  { name: "05 a twenty-three-hour soak is rejected", code: "SOAK_DURATION_TOO_SHORT", mutate: (f) => { f.endedAt = new Date(Date.parse(f.startedAt) + 23 * 60 * 60_000).toISOString(); } },
  { name: "06 invalid soak start time is rejected", code: "SOAK_DURATION_TOO_SHORT", mutate: (f) => { f.startedAt = "invalid"; } },
  { name: "07 invalid soak end time is rejected", code: "SOAK_DURATION_TOO_SHORT", mutate: (f) => { f.endedAt = "invalid"; } },
  { name: "08 absent morning refresh is rejected", code: "NATURAL_MORNING_REFRESH_MISSING", mutate: (f) => { f.cycles[1].morningRefresh = null; } },
  { name: "09 failed morning refresh is rejected", code: "NATURAL_MORNING_REFRESH_MISSING", mutate: (f) => { f.cycles[1].morningRefresh.status = "failed"; } },
  { name: "10 manufactured morning refresh is rejected", code: "NATURAL_MORNING_REFRESH_MISSING", mutate: (f) => { f.cycles[1].morningRefresh.natural = false; } },
  { name: "11 morning refresh before soak start is rejected", code: "MORNING_REFRESH_OUTSIDE_SOAK", mutate: (f) => { f.cycles[1].morningRefresh.startedAt = "2026-01-01T00:00:00.000Z"; } },
  { name: "12 morning refresh after soak end is rejected", code: "MORNING_REFRESH_OUTSIDE_SOAK", mutate: (f) => { f.cycles[1].morningRefresh.completedAt = new Date(Date.parse(f.endedAt) + 1).toISOString(); } },
  { name: "13 morning completion before morning start is rejected", code: "MORNING_REFRESH_OUTSIDE_SOAK", mutate: (f) => { f.cycles[1].morningRefresh.completedAt = "2026-01-01T00:00:00.000Z"; } },
  {
    name: "14 repeated canonical source cut through the soak is rejected",
    code: "NATURAL_CYCLES_NOT_DISTINCT",
    mutate: (f) => {
      const id = f.cycles[0].sourceCut.id;
      for (const cycle of f.cycles) {
        cycle.sourceCut.id = id;
        for (const surface of ["publication", "audit", "apiHealth", "brain", "browser"]) {
          cycle[surface].sourceCutId = id;
        }
      }
    },
  },
  { name: "15 non-natural soak cycle is rejected", code: "SOURCE_CYCLE_NOT_NATURAL", mutate: (f) => { f.cycles[1].natural = false; } },
  { name: "16 manufactured soak cycle is rejected", code: "SOURCE_CYCLE_NOT_NATURAL", mutate: (f) => { f.cycles[1].manufactured = true; } },
  { name: "17 missing tracking frontier during soak is rejected", code: "SOURCE_FRONTIER_MISSING", mutate: (f) => { f.cycles[1].frontiers = f.cycles[1].frontiers.filter((x) => x.sourceSystem !== "tracking"); } },
  { name: "18 missing Gmail acceptance during soak is rejected", code: "SOURCE_ACCEPTANCE_MISSING", mutate: (f) => { f.cycles[1].acceptances = f.cycles[1].acceptances.filter((x) => x.sourceSystem !== "gmail"); } },
  { name: "19 acceptance predating frontier during soak is rejected", code: "SOURCE_ACCEPTANCE_ORDER_INVALID", mutate: (f) => { f.cycles[1].acceptances[0].acceptedAt = "2026-01-01T00:00:00.000Z"; } },
  { name: "20 uncommitted truth ledger during soak is rejected", code: "TRUTH_LEDGER_NOT_COMMITTED", mutate: (f) => { f.cycles[1].truthLedger.status = "failed"; } },
  { name: "21 mismatched TMS ledger cut during soak is rejected", code: "TRUTH_LEDGER_SOURCE_MISMATCH", mutate: (f) => { f.cycles[1].truthLedger.sourceCutIds.tms = cut("0"); } },
  { name: "22 mismatched tracking ledger cut during soak is rejected", code: "TRUTH_LEDGER_SOURCE_MISMATCH", mutate: (f) => { f.cycles[1].truthLedger.sourceCutIds.tracking = cut("0"); } },
  { name: "23 degraded source cut during soak is rejected", code: "SOURCE_CUT_INCOMPLETE", mutate: (f) => { f.cycles[1].sourceCut.completeness = "degraded"; } },
  { name: "24 source cut gap during soak is rejected", code: "SOURCE_CUT_INCOMPLETE", mutate: (f) => { f.cycles[1].sourceCut.gapCount = 1; } },
  { name: "25 source cut before ledger commit during soak is rejected", code: "SOURCE_CUT_ORDER_INVALID", mutate: (f) => { f.cycles[1].sourceCut.sealedAt = f.cycles[1].startedAt; } },
  { name: "26 publication source-cut mismatch during soak is rejected", code: "PUBLICATION_SOURCE_CUT_MISMATCH", mutate: (f) => { f.cycles[1].publication.sourceCutId = cut("0"); } },
  { name: "27 publication before seal during soak is rejected", code: "PUBLICATION_ORDER_INVALID", mutate: (f) => { f.cycles[1].publication.publishedAt = f.cycles[1].startedAt; } },
  { name: "28 legacy writer invocation during soak is rejected", code: "LEGACY_WRITER_REVIVED", mutate: (f) => { f.cycles[1].legacy.writerInvocations = 1; } },
  { name: "29 legacy canonical fallback during soak is rejected", code: "LEGACY_WRITER_REVIVED", mutate: (f) => { f.cycles[1].legacy.canonicalFallbackUsed = true; } },
  { name: "30 growing live backlog during soak is rejected", code: "LIVE_BACKLOG_GREW", mutate: (f) => { f.cycles[1].queues.liveBacklogEnd = 5; } },
  { name: "31 dead letter during soak is rejected", code: "DEAD_LETTER_PRESENT", mutate: (f) => { f.cycles[1].queues.deadLetterCount = 1; } },
  {
    name: "32 historical replay collision during soak is rejected",
    code: "REPLAY_LIVE_RECOVERY_COLLISION",
    mutate: (f) => {
      f.cycles[1].queues.historicalReplayActive = true;
      f.cycles[1].queues.liveRecoveryActive = true;
    },
  },
  { name: "33 failed audit during soak is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[1].audit.status = "failed"; } },
  { name: "34 manufactured audit during soak is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[1].audit.natural = false; } },
  { name: "35 blocking audit finding during soak is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[1].audit.blockingFindingCount = 1; } },
  { name: "36 audit source-cut mismatch during soak is rejected", code: "AUDIT_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].audit.sourceCutId = cut("0"); } },
  { name: "37 audit packet mismatch during soak is rejected", code: "AUDIT_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].audit.packetHash = "0".repeat(64); } },
  { name: "38 degraded truth health during soak is rejected", code: "TRUTH_HEALTH_NOT_LIVE", mutate: (f) => { f.cycles[1].apiHealth.status = "degraded"; } },
  { name: "39 health source-cut mismatch during soak is rejected", code: "HEALTH_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].apiHealth.sourceCutId = cut("0"); } },
  { name: "40 health packet mismatch during soak is rejected", code: "HEALTH_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].apiHealth.packetHash = "0".repeat(64); } },
  { name: "41 degraded Brain API during soak is rejected", code: "BRAIN_NOT_LIVE", mutate: (f) => { f.cycles[1].brain.status = "degraded"; } },
  { name: "42 Brain active source gap during soak is rejected", code: "BRAIN_SOURCE_GAP", mutate: (f) => { f.cycles[1].brain.activeSourceGapCount = 1; } },
  { name: "43 Brain contradiction during soak is rejected", code: "BRAIN_CONTRADICTION", mutate: (f) => { f.cycles[1].brain.activeContradictionCount = 1; } },
  { name: "44 Brain source-cut mismatch during soak is rejected", code: "BRAIN_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].brain.sourceCutId = cut("0"); } },
  { name: "45 Brain packet mismatch during soak is rejected", code: "BRAIN_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].brain.packetHash = "0".repeat(64); } },
  { name: "46 degraded browser during soak is rejected", code: "BROWSER_NOT_RELATIONAL_LIVE", mutate: (f) => { f.cycles[1].browser.status = "degraded"; } },
  { name: "47 browser legacy truth mode during soak is rejected", code: "BROWSER_NOT_RELATIONAL_LIVE", mutate: (f) => { f.cycles[1].browser.truthMode = "legacy"; } },
  { name: "48 browser active source gap during soak is rejected", code: "BROWSER_SOURCE_GAP", mutate: (f) => { f.cycles[1].browser.activeSourceGapCount = 1; } },
  { name: "49 browser source-cut mismatch during soak is rejected", code: "BROWSER_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].browser.sourceCutId = cut("0"); } },
  { name: "50 browser packet mismatch during soak is rejected", code: "BROWSER_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[1].browser.packetHash = "0".repeat(64); } },
];

assert.equal(evidenceCases.length, 50);
for (const item of evidenceCases) {
  test(item.name, () => {
    if (item.run) return item.run();
    return expectFinding(item.mutate, item.code);
  });
}

function coveredRow(overrides = {}) {
  return {
    awb: "014-80000010",
    truthPacketRole: "active",
    stage: "pre-arrival",
    gmailCoverage: {
      status: "covered",
      problem: false,
      latestReadMessageAt: "2026-07-24T09:00:00.000Z",
      latestProofMessageAt: "2026-07-24T09:00:00.000Z",
    },
    evidencePacket: {
      freshness: {},
      sourceFacts: [],
    },
    truthPacket: {
      currentState: "pre-arrival",
      contradictions: [],
      gates: {},
    },
    ...overrides,
  };
}

test("51 hostile candidate monkeypatches remain confined to the disposable product child", () => {
  const parentRead = fs.readFileSync;
  const parentHash = crypto.createHash;
  const response = runHostileProductFixture("monkeypatch");
  assert.equal(response.ok, true);
  assert.equal(response.result.attempted.length, 5);
  assert.strictEqual(fs.readFileSync, parentRead);
  assert.strictEqual(crypto.createHash, parentHash);
  assert.equal(
    crypto.createHash("sha256").update("immutable-parent").digest("hex"),
    "06270d2aa072ed532d899f73b97caed39cfc96bac157dd5858cfd3c73baaed8b",
  );
});

test("52 product child extra output is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("extra-output"),
    "TRUTH_PRODUCT_CHILD_EXTRA_OUTPUT",
  );
});

test("53 product child malformed output is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("malformed-output"),
    "TRUTH_PRODUCT_CHILD_MALFORMED_OUTPUT",
  );
});

test("54 product child oversized output is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("oversized-output"),
    "TRUTH_PRODUCT_CHILD_OVERSIZED_OUTPUT",
  );
});

test("55 product child crash is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("crash"),
    "TRUTH_PRODUCT_CHILD_EXIT_NONZERO",
  );
});

test("56 product child signal is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("signal"),
    "TRUTH_PRODUCT_CHILD_SIGNAL",
  );
});

test("57 product child timeout is refused by immutable parent authority", () => {
  expectProtocolCode(
    () => runHostileProductFixture("timeout", { timeoutMs: 100 }),
    "TRUTH_PRODUCT_CHILD_TIMEOUT",
  );
});

test("58 invalid and old timestamps are stale while an in-bound timestamp is fresh", () => {
  const run = (timestamp) => product(
    "lib/truth-health.js",
    "health-stale",
    {
      timestamp,
      maxAgeMinutes: 15,
      now: "2026-07-24T10:00:00.000Z",
    },
  );
  const invalid = run("invalid");
  const old = run("2026-07-24T09:00:00.000Z");
  const fresh = run("2026-07-24T09:50:00.000Z");
  assert.equal(invalid.ok, true);
  assert.equal(old.ok, true);
  assert.equal(fresh.ok, true);
  assert.equal(invalid.result, true);
  assert.equal(old.result, true);
  assert.equal(fresh.result, false);
});

test("59 active truth excludes completed rows and obeys the canonical active index", () => {
  const roleProjection = product(
    "lib/truth-health.js",
    "health-active-rows",
    {
      snapshot: {
        shipments: [
          coveredRow(),
          coveredRow({ awb: "014-80000011", truthPacketRole: "completed" }),
        ],
      },
    },
  );
  const indexedProjection = product(
    "lib/truth-health.js",
    "health-active-rows",
    {
      snapshot: {
        activeAwbs: ["014-80000011"],
        shipments: [
          coveredRow(),
          coveredRow({ awb: "014-80000011" }),
        ],
      },
    },
  );
  assert.equal(roleProjection.ok, true);
  assert.equal(indexedProjection.ok, true);
  assert.deepEqual(roleProjection.result.map((row) => row.awb), ["014-80000010"]);
  assert.deepEqual(indexedProjection.result.map((row) => row.awb), ["014-80000011"]);
});

test("60 row certification exposes every Gmail and coherence gap while clean rows certify", () => {
  const certify = (snapshot) => product(
    "lib/truth-health.js",
    "health-row-certification",
    { snapshot },
  );
  const missingCoverage = coveredRow({ gmailCoverage: {} });
  const explicitProblem = coveredRow({
    gmailCoverage: {
      status: "covered",
      problem: true,
      reason: "newest message not reduced",
    },
  });
  const missingFact = coveredRow({ stage: "release-needed" });
  const contradiction = coveredRow({
    truthPacket: {
      currentState: "pre-arrival",
      gates: {},
      contradictions: [{
        id: "truth:state-family-split",
        dimension: "state",
        severity: "critical",
      }],
    },
  });
  const cases = [
    [missingCoverage, "missing-gmail-coverage"],
    [explicitProblem, "gmail-coverage-problem"],
    [missingFact, "missing-gmail-source-fact"],
    [contradiction, "internal-truth-conflict"],
  ];
  for (const [row, code] of cases) {
    const response = certify({ activeAwbs: [row.awb], shipments: [row] });
    assert.equal(response.ok, true);
    assert.equal(response.result.status, "degraded");
    assert.ok(response.result.problems.some((problem) => problem.code === code));
  }
  const clean = coveredRow();
  const cleanResponse = certify({ activeAwbs: [clean.awb], shipments: [clean] });
  assert.equal(cleanResponse.ok, true);
  assert.equal(cleanResponse.result.status, "certified");
  assert.equal(cleanResponse.result.problemCount, 0);
});

test("61 missing active TMS rows and stale embedded inventory both fail certification", () => {
  const missing = product(
    "lib/truth-health.js",
    "health-row-certification",
    {
      snapshot: {
        activeAwbs: [],
        sourceAudit: { tmsActiveAwbs: ["014-80000010"] },
        shipments: [],
      },
    },
  );
  const stale = product(
    "lib/truth-health.js",
    "health-tms-inventory",
    {
      metadataRows: [],
      maxAgeMinutes: 60,
      now: "2026-07-24T10:00:00.000Z",
      truthSnapshot: {
        snapshotTime: "2026-07-24T08:00:00.000Z",
        sourceAudit: {
          tmsActiveAwbs: ["014-80000010"],
          tmsSnapshotTime: "2026-07-24T08:00:00.000Z",
        },
      },
    },
  );
  assert.equal(missing.ok, true);
  assert.equal(
    missing.result.problems[0].code,
    "tms-active-missing-from-truth",
  );
  assert.equal(stale.ok, true);
  assert.equal(stale.result.ok, false);
  assert.equal(stale.result.embedded.stale, true);
});

test("62 failed refresh markers cannot certify an unchanged truth packet as fresh", () => {
  const response = product(
    "lib/truth-health.js",
    "health-verified-freshness",
    {
      refreshHealthRow: {
        writer_version: "gmail-refresh+status-failed+truthsig-abcdef",
        snapshot_time: "2026-07-24T10:00:00.000Z",
      },
      storedTruthSignature: `abcdef${"0".repeat(58)}`,
      truthSnapshotTime: "2026-07-24T09:00:00.000Z",
    },
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.verifiedAt, null);
  assert.equal(response.result.freshAt, "2026-07-24T09:00:00.000Z");
});

test("63 API and browser semantic witnesses agree independent of shipment ordering", () => {
  const first = {
    activeAwbs: ["01480000010", "01480000011"],
    completedAwbs: [],
    shipments: [
      { awb: "014-80000010", truthPacketRole: "active", stage: "in-transit" },
      { awb: "014-80000011", truthPacketRole: "active", stage: "pre-arrival" },
    ],
  };
  const second = {
    activeAwbs: ["01480000011", "01480000010"],
    completedAwbs: [],
    shipments: [...first.shipments].reverse(),
  };
  const firstResponse = product(
    "lib/truth-production-semantics.js",
    "compact-semantics",
    { snapshot: first },
  );
  const secondResponse = product(
    "lib/truth-production-semantics.js",
    "compact-semantics",
    { snapshot: second },
  );
  assert.equal(firstResponse.ok, true);
  assert.equal(secondResponse.ok, true);
  assert.deepEqual(firstResponse.result, secondResponse.result);
});

test("64 false gate evidence remains unknown rather than being promoted to done", () => {
  const response = product(
    "lib/truth-production-semantics.js",
    "compact-semantics",
    {
      snapshot: {
        activeAwbs: ["01480000010"],
        completedAwbs: [],
        shipments: [{
          awb: "014-80000010",
          truthPacketRole: "active",
          truthPacket: { gates: { delivery: { status: false } } },
        }],
      },
    },
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.shipments[0].gates.delivery, "unknown");
});

test("65 API and browser semantic witnesses expose a gate disagreement", () => {
  const api = {
    activeAwbs: ["01480000010"],
    completedAwbs: [],
    shipments: [{
      awb: "014-80000010",
      truthPacketRole: "active",
      truthPacket: { gates: { delivery: { status: "done" } } },
    }],
  };
  const browser = JSON.parse(JSON.stringify(api));
  browser.shipments[0].truthPacket.gates.delivery.status = "blocked";
  const apiResponse = product(
    "lib/truth-production-semantics.js",
    "compact-semantics",
    { snapshot: api },
  );
  const browserResponse = product(
    "lib/truth-production-semantics.js",
    "compact-semantics",
    { snapshot: browser },
  );
  assert.equal(apiResponse.ok, true);
  assert.equal(browserResponse.ok, true);
  assert.notDeepEqual(apiResponse.result, browserResponse.result);
});

// This file deliberately defines exactly 65 TRUTH-02 product-domain tests.

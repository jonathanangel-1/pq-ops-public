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

const OBLIGATION = `pending-acceptance-epoch:v1:${"a".repeat(64)}`;
const BATCH = "11111111-1111-4111-8111-111111111111";
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
  const fixture = truthLivenessFixture();
  operation(fixture);
  const result = evaluateTruthLivenessEvidence(fixture);
  assert.equal(result.ok, false);
  assert.ok(codeSet(result).has(code), `${code}: ${JSON.stringify(result.findings)}`);
}

const evidenceCases = [
  {
    name: "01 complete liveness evidence passes and returns an immutable assessment",
    run() {
      const result = evaluateTruthLivenessEvidence(truthLivenessFixture());
      assert.equal(result.ok, true);
      assert.equal(result.cycleCount, 2);
      assert.ok(Object.isFrozen(result));
      assert.ok(Object.isFrozen(result.findings));
      const gherkin = executeProfile("truth-liveness-gherkin-v1");
      assert.equal(gherkin.population, 15);
      assert.equal(gherkin.passed, 15);
      const soakGherkin = executeProfile("truth-soak-gherkin-v1");
      assert.equal(soakGherkin.population, 15);
      assert.equal(soakGherkin.passed, 15);
      assert.equal(evaluateTruthSoakEvidence(null).ok, false);
      const soakMutation = (operation) => {
        const fixture = truthSoakFixture();
        operation(fixture);
        const assessment = evaluateTruthSoakEvidence(fixture);
        assert.equal(assessment.ok, false);
        return codeSet(assessment);
      };
      assert.ok(soakMutation((f) => { f.startedAt = "invalid"; }).has("SOAK_DURATION_TOO_SHORT"));
      assert.ok(soakMutation((f) => { f.endedAt = "invalid"; }).has("SOAK_DURATION_TOO_SHORT"));
      assert.ok(soakMutation((f) => { f.cycles[1].morningRefresh = null; }).has("NATURAL_MORNING_REFRESH_MISSING"));
      assert.ok(soakMutation((f) => { f.cycles[1].morningRefresh.natural = false; }).has("NATURAL_MORNING_REFRESH_MISSING"));
      assert.ok(soakMutation((f) => {
        f.cycles[1].morningRefresh.startedAt = "2026-01-01T00:00:00.000Z";
      }).has("MORNING_REFRESH_OUTSIDE_SOAK"));
      assert.ok(soakMutation((f) => {
        f.cycles[1].morningRefresh.completedAt =
          new Date(Date.parse(f.endedAt) + 1).toISOString();
      }).has("MORNING_REFRESH_OUTSIDE_SOAK"));
      assert.ok(soakMutation((f) => {
        f.cycles[1].morningRefresh.completedAt = "2026-01-01T00:00:00.000Z";
      }).has("MORNING_REFRESH_OUTSIDE_SOAK"));
      const healthCodes = soakMutation((f) => {
        const cycle = f.cycles[1];
        cycle.apiHealth.status = "degraded";
        cycle.apiHealth.sourceCutId = cut("0");
        cycle.brain.status = "degraded";
        cycle.brain.activeSourceGapCount = 1;
        cycle.brain.activeContradictionCount = 1;
        cycle.brain.sourceCutId = cut("0");
        cycle.browser.status = "degraded";
        cycle.browser.activeSourceGapCount = 1;
        cycle.browser.sourceCutId = cut("0");
      });
      for (const code of [
        "TRUTH_HEALTH_NOT_LIVE",
        "HEALTH_PUBLICATION_MISMATCH",
        "BRAIN_NOT_LIVE",
        "BRAIN_SOURCE_GAP",
        "BRAIN_CONTRADICTION",
        "BRAIN_PUBLICATION_MISMATCH",
        "BROWSER_NOT_RELATIONAL_LIVE",
        "BROWSER_SOURCE_GAP",
        "BROWSER_PUBLICATION_MISMATCH",
      ]) {
        assert.ok(healthCodes.has(code), code);
      }
      const copied = clone(truthLivenessFixture());
      copied.cycles[0].cycleId = "changed";
      assert.notEqual(copied.cycles[0].cycleId, truthLivenessFixture().cycles[0].cycleId);
      assert.equal(
        parseProfileArg(["--profile=truth-liveness-gherkin-v1"]),
        "truth-liveness-gherkin-v1",
      );
      assert.throws(() => parseProfileArg([]), /Exactly one immutable/);
      assert.throws(() => parseProfileArg(["--profile=unknown"]), /Unknown immutable/);
      assert.throws(() => definitionsForProfile("unknown"), /Unknown immutable/);
      assert.throws(() => executeProfile("unknown"), /Unknown immutable/);
      assert.throws(() => parseFeature("Given a step"), /Step appears before/);
      assert.throws(() => parseFeature("Feature: x\nunsupported"), /Unsupported Gherkin/);
    },
  },
  { name: "02 wrong liveness schema is rejected", code: "LIVENESS_EVIDENCE_INVALID", mutate: (f) => { f.schema = "wrong"; } },
  { name: "03 wrong liveness phase is rejected", code: "LIVENESS_EVIDENCE_INVALID", mutate: (f) => { f.phaseId = "TRUTH-02"; } },
  { name: "04 non-array cycle evidence is rejected", code: "LIVENESS_EVIDENCE_INVALID", mutate: (f) => { f.cycles = {}; } },
  { name: "05 one natural cycle is insufficient", code: "NATURAL_CYCLES_NOT_DISTINCT", mutate: (f) => { f.cycles.pop(); } },
  { name: "06 duplicate cycle identity is rejected", code: "NATURAL_CYCLES_NOT_DISTINCT", mutate: (f) => { f.cycles[1].cycleId = f.cycles[0].cycleId; } },
  {
    name: "07 duplicate canonical cut identity is rejected",
    code: "NATURAL_CYCLES_NOT_DISTINCT",
    mutate: (f) => {
      const id = f.cycles[0].sourceCut.id;
      f.cycles[1].sourceCut.id = id;
      for (const surface of ["publication", "audit", "apiHealth", "brain", "browser"]) {
        f.cycles[1][surface].sourceCutId = id;
      }
    },
  },
  { name: "08 manufactured source cycle is rejected", code: "SOURCE_CYCLE_NOT_NATURAL", mutate: (f) => { f.cycles[0].manufactured = true; } },
  { name: "09 non-natural source cycle is rejected", code: "SOURCE_CYCLE_NOT_NATURAL", mutate: (f) => { f.cycles[0].natural = false; } },
  { name: "10 missing Gmail frontier is rejected", code: "SOURCE_FRONTIER_MISSING", mutate: (f) => { f.cycles[0].frontiers = f.cycles[0].frontiers.filter((x) => x.sourceSystem !== "gmail"); } },
  { name: "11 synthetic source frontier is rejected", code: "SOURCE_FRONTIER_MISSING", mutate: (f) => { f.cycles[0].frontiers[0].natural = false; } },
  { name: "12 empty source frontier cut is rejected", code: "SOURCE_FRONTIER_MISSING", mutate: (f) => { f.cycles[0].frontiers[0].sourceCutId = ""; } },
  { name: "13 missing TMS acceptance is rejected", code: "SOURCE_ACCEPTANCE_MISSING", mutate: (f) => { f.cycles[0].acceptances = f.cycles[0].acceptances.filter((x) => x.sourceSystem !== "tms"); } },
  { name: "14 review-state acceptance is rejected", code: "SOURCE_ACCEPTANCE_MISSING", mutate: (f) => { f.cycles[0].acceptances[0].status = "review"; } },
  { name: "15 acceptance frontier identity mismatch is rejected", code: "SOURCE_ACCEPTANCE_IDENTITY_MISMATCH", mutate: (f) => { f.cycles[0].acceptances[0].frontierId = "frontier:other"; } },
  { name: "16 acceptance source cut mismatch is rejected", code: "SOURCE_ACCEPTANCE_IDENTITY_MISMATCH", mutate: (f) => { f.cycles[0].acceptances[0].sourceCutId = cut("0"); } },
  { name: "17 acceptance before frontier is rejected", code: "SOURCE_ACCEPTANCE_ORDER_INVALID", mutate: (f) => { f.cycles[0].acceptances[0].acceptedAt = "2026-01-01T00:00:00.000Z"; } },
  { name: "18 invalid acceptance time is rejected", code: "SOURCE_ACCEPTANCE_ORDER_INVALID", mutate: (f) => { f.cycles[0].acceptances[0].acceptedAt = "invalid"; } },
  { name: "19 acceptance publication attempt is rejected", code: "ACCEPTANCE_PUBLICATION_ATTEMPTED", mutate: (f) => { f.cycles[0].acceptances[0].productionPublicationAttempted = true; } },
  { name: "20 wrong truth-ledger receipt schema is rejected", code: "TRUTH_LEDGER_NOT_COMMITTED", mutate: (f) => { f.cycles[0].truthLedger.schema = "wrong"; } },
  { name: "21 disabled truth-ledger receipt is rejected", code: "TRUTH_LEDGER_NOT_COMMITTED", mutate: (f) => { f.cycles[0].truthLedger.status = "disabled"; } },
  { name: "22 truth-ledger TMS cut mismatch is rejected", code: "TRUTH_LEDGER_SOURCE_MISMATCH", mutate: (f) => { f.cycles[0].truthLedger.sourceCutIds.tms = cut("0"); } },
  { name: "23 truth-ledger tracking cut mismatch is rejected", code: "TRUTH_LEDGER_SOURCE_MISMATCH", mutate: (f) => { f.cycles[0].truthLedger.sourceCutIds.tracking = cut("0"); } },
  { name: "24 truth-ledger publication attempt is rejected", code: "TRUTH_LEDGER_PUBLICATION_ATTEMPTED", mutate: (f) => { f.cycles[0].truthLedger.productionPublicationAttempted = true; } },
  { name: "25 source cut Gmail acceptance mismatch is rejected", code: "SOURCE_CUT_ACCEPTANCE_MISMATCH", mutate: (f) => { f.cycles[0].sourceCut.sourceCutIds.gmail = cut("0"); } },
  { name: "26 source cut TMS acceptance mismatch is rejected", code: "SOURCE_CUT_ACCEPTANCE_MISMATCH", mutate: (f) => { f.cycles[0].sourceCut.sourceCutIds.tms = cut("0"); } },
  { name: "27 source cut tracking acceptance mismatch is rejected", code: "SOURCE_CUT_ACCEPTANCE_MISMATCH", mutate: (f) => { f.cycles[0].sourceCut.sourceCutIds.tracking = cut("0"); } },
  { name: "28 degraded canonical cut is rejected", code: "SOURCE_CUT_INCOMPLETE", mutate: (f) => { f.cycles[0].sourceCut.completeness = "degraded"; } },
  { name: "29 nonzero canonical cut gap count is rejected", code: "SOURCE_CUT_INCOMPLETE", mutate: (f) => { f.cycles[0].sourceCut.gapCount = 1; } },
  { name: "30 empty canonical source cut identity is rejected", code: "SOURCE_CUT_INCOMPLETE", mutate: (f) => { f.cycles[0].sourceCut.id = ""; } },
  { name: "31 source cut sealed before ledger commit is rejected", code: "SOURCE_CUT_ORDER_INVALID", mutate: (f) => { f.cycles[0].sourceCut.sealedAt = f.cycles[0].startedAt; } },
  { name: "32 invalid ledger commit time is rejected", code: "SOURCE_CUT_ORDER_INVALID", mutate: (f) => { f.cycles[0].truthLedger.committedAt = "invalid"; } },
  { name: "33 non-relational publisher is rejected", code: "RELATIONAL_PUBLISHER_REQUIRED", mutate: (f) => { f.cycles[0].publication.publisher = "packet-cache"; } },
  { name: "34 legacy writer version is rejected", code: "RELATIONAL_PUBLISHER_REQUIRED", mutate: (f) => { f.cycles[0].publication.writerVersion = "legacy-writer-v1"; } },
  { name: "35 publication source cut mismatch is rejected", code: "PUBLICATION_SOURCE_CUT_MISMATCH", mutate: (f) => { f.cycles[0].publication.sourceCutId = cut("0"); } },
  { name: "36 publication before source-cut sealing is rejected", code: "PUBLICATION_ORDER_INVALID", mutate: (f) => { f.cycles[0].publication.publishedAt = f.cycles[0].startedAt; } },
  { name: "37 malformed publication packet hash is rejected", code: "PUBLICATION_PACKET_HASH_INVALID", mutate: (f) => { f.cycles[0].publication.packetHash = "no"; } },
  { name: "38 legacy writer invocation is rejected", code: "LEGACY_WRITER_REVIVED", mutate: (f) => { f.cycles[0].legacy.writerInvocations = 1; } },
  { name: "39 canonical fallback to legacy is rejected", code: "LEGACY_WRITER_REVIVED", mutate: (f) => { f.cycles[0].legacy.canonicalFallbackUsed = true; } },
  { name: "40 enabled legacy packet writer is rejected", code: "LEGACY_WRITER_REVIVED", mutate: (f) => { f.cycles[0].legacy.packetWriterEnabled = true; } },
  { name: "41 invalid live backlog receipt is rejected", code: "LIVE_QUEUE_RECEIPT_INVALID", mutate: (f) => { f.cycles[0].queues.liveBacklogStart = -1; } },
  { name: "42 growing live backlog is rejected", code: "LIVE_BACKLOG_GREW", mutate: (f) => { f.cycles[0].queues.liveBacklogEnd = 5; } },
  { name: "43 dead-letter presence is rejected", code: "DEAD_LETTER_PRESENT", mutate: (f) => { f.cycles[0].queues.deadLetterCount = 1; } },
  {
    name: "44 replay overlapping live recovery is rejected",
    code: "REPLAY_LIVE_RECOVERY_COLLISION",
    mutate: (f) => {
      f.cycles[0].queues.historicalReplayActive = true;
      f.cycles[0].queues.liveRecoveryActive = true;
    },
  },
  { name: "45 failed relational audit is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[0].audit.status = "failed"; } },
  { name: "46 manufactured relational audit is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[0].audit.natural = false; } },
  { name: "47 blocking audit finding is rejected", code: "AUDIT_NOT_SUCCESSFUL", mutate: (f) => { f.cycles[0].audit.blockingFindingCount = 1; } },
  { name: "48 audit source cut mismatch is rejected", code: "AUDIT_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[0].audit.sourceCutId = cut("0"); } },
  { name: "49 audit packet mismatch is rejected", code: "AUDIT_PUBLICATION_MISMATCH", mutate: (f) => { f.cycles[0].audit.packetHash = "0".repeat(64); } },
  { name: "50 audit before publication is rejected", code: "AUDIT_ORDER_INVALID", mutate: (f) => { f.cycles[0].audit.finishedAt = f.cycles[0].startedAt; } },
];

assert.equal(evidenceCases.length, 50);
for (const item of evidenceCases) {
  test(item.name, () => {
    if (item.run) return item.run();
    return expectFinding(item.mutate, item.code);
  });
}

function frontierBatch(overrides = {}) {
  return {
    rootBatchId: BATCH,
    sourceSystem: "tms",
    connectionKey: "couriercloud-ops-tlv-us",
    sourceCursorVersion: 1,
    sourceCursorValue: "cursor-1",
    obligationId: OBLIGATION,
    acceptanceComplete: false,
    readyToRun: true,
    ...overrides,
  };
}

function acceptedCutReceipt(overrides = {}) {
  const manifestHash = "a".repeat(64);
  return {
    ok: true,
    status: "sealed",
    sourceCutId: `cut:v1:${manifestHash}`,
    manifestHash,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "complete",
    observationCount: 3,
    gaps: [],
    scopeReceiptId: `truth-shadow-root-source-cut:v1:${"b".repeat(64)}`,
    scopeReceiptHash: "c".repeat(64),
    acceptanceEpochManifestHash: "d".repeat(64),
    publicationChannel: "shadow",
    shadowOnly: true,
    productionEligible: false,
    productionPublicationAttempted: false,
    publishesTruth: false,
    performsActions: false,
    ...overrides,
  };
}

function bridgeReceipt(shadowSourceCutId, overrides = {}) {
  const manifestHash = "e".repeat(64);
  return {
    ok: true,
    status: "bridged",
    productionSourceCutId: `cut:v1:${manifestHash}`,
    sourceCutId: `cut:v1:${manifestHash}`,
    shadowSourceCutId,
    bridgeId: `truth-production-cut-acceptance-bridge:v1:${"f".repeat(64)}`,
    bridgeHash: "1".repeat(64),
    manifestHash,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "complete",
    gaps: [],
    observationCount: 3,
    productionEligible: true,
    productionPublicationAttempted: false,
    publishesTruth: false,
    performsActions: false,
    ...overrides,
  };
}

test("51 hostile candidate monkeypatches remain confined to the disposable product child", () => {
  const parentRead = fs.readFileSync;
  const parentHash = crypto.createHash;
  const response = runHostileProductFixture("monkeypatch");
  assert.equal(response.ok, true);
  assert.deepEqual(response.result.attempted, [
    "node:assert",
    "node:fs",
    "node:crypto",
    "process.stdout",
    "Module._load",
  ]);
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

test("58 generic acceptance preserves frontier-to-acceptance order without publication", () => {
  const response = product(
    "lib/truth-generic-acceptance-readiness.js",
    "generic-run",
    {
      frontierReceipt: {
        ok: true,
        batches: [frontierBatch()],
        productionPublicationAttempted: false,
      },
      acceptanceReceipt: {
        status: "succeeded",
        acceptedCount: 1,
        rejectedCount: 0,
        reviewCount: 0,
        productionPublicationAttempted: false,
      },
    },
  );
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.result.calls.map((call) => call.rpc),
    [
      "read_truth_generic_acceptance_readiness_frontier",
      "run_truth_shadow_claim_acceptance_epoch",
    ],
  );
  assert.equal(response.result.result.succeededCount, 1);
  assert.equal(response.result.result.productionPublicationAttempted, false);
  assert.equal(response.result.result.publishesTruth, false);
});

test("59 generic frontier refuses publication attempts and foreign source connections", () => {
  const publishing = product(
    "lib/truth-generic-acceptance-readiness.js",
    "normalize-frontier",
    {
      receipt: {
        ok: true,
        batches: [],
        productionPublicationAttempted: true,
      },
    },
  );
  const foreign = product(
    "lib/truth-generic-acceptance-readiness.js",
    "normalize-frontier",
    {
      receipt: {
        ok: true,
        batches: [frontierBatch({ connectionKey: "other" })],
        productionPublicationAttempted: false,
      },
    },
  );
  assert.equal(publishing.ok, false);
  assert.equal(
    publishing.error.code,
    "TRUTH_GENERIC_ACCEPTANCE_READINESS_FRONTIER_INVALID",
  );
  assert.equal(foreign.ok, false);
  assert.equal(
    foreign.error.code,
    "TRUTH_GENERIC_ACCEPTANCE_READINESS_INVALID_ARGUMENT",
  );
});

test("60 accepted, not-ready, and publication-attempted frontiers cannot manufacture actions", () => {
  const run = (batch, acceptanceReceipt = {}) => product(
    "lib/truth-generic-acceptance-readiness.js",
    "generic-run",
    {
      frontierReceipt: {
        ok: true,
        batches: [batch],
        productionPublicationAttempted: false,
      },
      acceptanceReceipt,
    },
  );
  const accepted = run(frontierBatch({ acceptanceComplete: true }));
  const notReady = run(frontierBatch({ readyToRun: false }));
  const publishing = run(frontierBatch(), {
    status: "succeeded",
    productionPublicationAttempted: true,
  });
  assert.equal(accepted.ok, true);
  assert.equal(notReady.ok, true);
  assert.equal(publishing.ok, true);
  assert.equal(accepted.result.result.actions.length, 0);
  assert.equal(notReady.result.result.actions.length, 0);
  assert.equal(publishing.result.result.actions.length, 0);
  assert.equal(accepted.result.result.skips[0].reasonCode, "ALREADY_ACCEPTED");
  assert.equal(notReady.result.result.skips[0].reasonCode, "NOT_READY");
});

test("61 source-cut validation accepts strict identity and fails closed on identity or gaps", () => {
  const manifestHash = "a".repeat(64);
  const validReceipt = {
    ok: true,
    status: "sealed",
    sourceCutId: `cut:v1:${manifestHash}`,
    manifestHash,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "complete",
    gaps: [],
    observationCount: 2,
  };
  const valid = product(
    "lib/truth-source-cut-ledger.js",
    "validate-source-cut",
    { receipt: validReceipt },
  );
  const notReadyWithIdentity = product(
    "lib/truth-source-cut-ledger.js",
    "validate-source-cut",
    {
      receipt: {
        ok: true,
        status: "not_ready",
        sourceCutId: cut("a"),
        manifestHash: null,
        manifest: null,
        completeness: "degraded",
        gaps: [{ gapType: "pending" }],
        observationCount: 0,
      },
    },
  );
  const completeWithGap = product(
    "lib/truth-source-cut-ledger.js",
    "validate-source-cut",
    { receipt: { ...validReceipt, gaps: [{ gapType: "pending" }] } },
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.result.sourceCutId, `cut:v1:${manifestHash}`);
  assert.equal(notReadyWithIdentity.ok, false);
  assert.equal(completeWithGap.ok, false);
});

test("62 accepted Gmail and production bridge receipts enforce channel and identity boundaries", () => {
  const shadow = acceptedCutReceipt().sourceCutId;
  const accepted = product(
    "lib/truth-production-source-cut-coordinator.js",
    "validate-accepted-cut",
    { receipt: acceptedCutReceipt({ shadowOnly: false }) },
  );
  const ineligible = product(
    "lib/truth-production-source-cut-coordinator.js",
    "validate-production-bridge",
    {
      receipt: bridgeReceipt(shadow, { productionEligible: false }),
      shadowSourceCutId: shadow,
    },
  );
  const sameCut = product(
    "lib/truth-production-source-cut-coordinator.js",
    "validate-production-bridge",
    {
      receipt: bridgeReceipt(shadow, {
        productionSourceCutId: shadow,
        sourceCutId: shadow,
        manifestHash: shadow.slice("cut:v1:".length),
      }),
      shadowSourceCutId: shadow,
    },
  );
  assert.equal(accepted.ok, false);
  assert.equal(ineligible.ok, false);
  assert.equal(sameCut.ok, false);
});

test("63 production source-cut coordinator reads head, seals accepted Gmail, then bridges", () => {
  const shadow = acceptedCutReceipt();
  const response = product(
    "lib/truth-production-source-cut-coordinator.js",
    "production-source-cut-run",
    {
      head: { ok: true, accepted: true, obligationId: OBLIGATION },
      shadowCut: shadow,
      bridge: bridgeReceipt(shadow.sourceCutId),
    },
  );
  assert.equal(response.ok, true);
  assert.deepEqual(
    response.result.calls.map((call) => call.rpc),
    [
      "read_truth_ceremony_gmail_head",
      "seal_truth_shadow_root_source_cut",
      "seal_truth_production_cut_from_accepted_gmail_v1",
    ],
  );
  assert.equal(response.result.result.status, "sealed");
});

test("64 canonical publication refuses incomplete source truth before any write", () => {
  const response = product(
    "lib/canonical-truth-publisher.js",
    "canonical-publish",
    { snapshot: { shipments: [] } },
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.outcome, "rejected");
  assert.equal(response.result.writes, 0);
  assert.equal(response.result.error.code, "CANONICAL_SOURCE_WATERMARK_INCOMPLETE");
});

test("65 canonical change detection binds the evidence-committing publication identity", () => {
  const response = product(
    "lib/canonical-truth-publisher.js",
    "canonical-prepare",
    {
      snapshot: {
        shipments: [],
        sourceAudit: {
          gmailProofSnapshotTime: "2026-07-24T09:00:00.000Z",
          gmailHistoryId: "1",
          tmsSnapshotTime: "2026-07-24T09:00:00.000Z",
          trackingSnapshotTime: "2026-07-24T09:00:00.000Z",
          operatorEventSequence: "1",
          factLedgerSnapshotTime: "2026-07-24T09:00:00.000Z",
          extractorVersion: "v1",
          reducerVersion: "v1",
        },
      },
    },
  );
  assert.equal(response.ok, true);
  assert.equal(
    response.result.contentSignature,
    response.result.publicationSignature,
  );
  assert.equal(
    response.result.packetId,
    `truth-${response.result.publicationSignature}`,
  );
  assert.notEqual(response.result.semanticSignature, "");
});

// This file deliberately defines exactly 65 TRUTH-01 product-domain tests.

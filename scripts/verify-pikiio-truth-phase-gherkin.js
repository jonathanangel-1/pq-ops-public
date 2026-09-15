#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_SOURCES = Object.freeze(["gmail", "tms", "tracking"]);
const GHERKIN_PROFILES = Object.freeze({
  "truth-liveness-gherkin-v1": Object.freeze({
    featurePath: path.join(ROOT, "tests", "features", "pikiio-truth-liveness.feature"),
    phaseId: "TRUTH-01",
  }),
  "truth-soak-gherkin-v1": Object.freeze({
    featurePath: path.join(ROOT, "tests", "features", "pikiio-truth-soak.feature"),
    phaseId: "TRUTH-02",
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function cut(fill) {
  return `cut:v1:${fill.repeat(64)}`;
}

function cycleFixture({
  ordinal,
  startedAtMs,
  morning = false,
} = {}) {
  const sourceFills = {
    gmail: ordinal === 1 ? "a" : ordinal === 2 ? "b" : "c",
    tms: ordinal === 1 ? "d" : ordinal === 2 ? "e" : "f",
    tracking: ordinal === 1 ? "1" : ordinal === 2 ? "2" : "3",
  };
  const canonicalFill = ordinal === 1 ? "4" : ordinal === 2 ? "5" : "6";
  const packetFill = ordinal === 1 ? "7" : ordinal === 2 ? "8" : "9";
  const frontiers = REQUIRED_SOURCES.map((sourceSystem, index) => ({
    sourceSystem,
    sourceCutId: cut(sourceFills[sourceSystem]),
    frontierId: `frontier:${sourceSystem}:${ordinal}`,
    observedAt: iso(startedAtMs + index * 1_000),
    natural: true,
  }));
  const acceptances = frontiers.map((frontier, index) => ({
    sourceSystem: frontier.sourceSystem,
    sourceCutId: frontier.sourceCutId,
    frontierId: frontier.frontierId,
    status: "accepted",
    acceptedAt: iso(startedAtMs + 60_000 + index * 1_000),
    productionPublicationAttempted: false,
  }));
  const sourceCutIds = Object.fromEntries(
    frontiers.map((frontier) => [frontier.sourceSystem, frontier.sourceCutId]),
  );
  const canonicalSourceCutId = cut(canonicalFill);
  const packetHash = packetFill.repeat(64);
  return {
    schema: "pikiio-natural-truth-cycle-evidence-v1",
    cycleId: `natural-cycle-${String(ordinal).padStart(2, "0")}`,
    natural: true,
    manufactured: false,
    startedAt: iso(startedAtMs),
    completedAt: iso(startedAtMs + 8 * 60_000),
    frontiers,
    acceptances,
    truthLedger: {
      schema: "pikiio-truth-ledger-commit-receipt-v1",
      status: "committed",
      sourceCutIds,
      committedAt: iso(startedAtMs + 2 * 60_000),
      productionPublicationAttempted: false,
    },
    sourceCut: {
      id: canonicalSourceCutId,
      completeness: "complete",
      sourceCutIds,
      sealedAt: iso(startedAtMs + 3 * 60_000),
      gapCount: 0,
    },
    publication: {
      publisher: "relational-truth-ledger",
      writerVersion: "relational-truth-v1",
      sourceCutId: canonicalSourceCutId,
      packetHash,
      publishedAt: iso(startedAtMs + 4 * 60_000),
    },
    audit: {
      status: "succeeded",
      natural: true,
      sourceCutId: canonicalSourceCutId,
      packetHash,
      blockingFindingCount: 0,
      finishedAt: iso(startedAtMs + 5 * 60_000),
    },
    apiHealth: {
      status: "live",
      sourceCutId: canonicalSourceCutId,
      packetHash,
      checkedAt: iso(startedAtMs + 6 * 60_000),
    },
    brain: {
      status: "live",
      sourceCutId: canonicalSourceCutId,
      packetHash,
      activeSourceGapCount: 0,
      activeContradictionCount: 0,
      checkedAt: iso(startedAtMs + 6 * 60_000),
    },
    browser: {
      status: "live",
      truthMode: "relational",
      sourceCutId: canonicalSourceCutId,
      packetHash,
      activeSourceGapCount: 0,
      checkedAt: iso(startedAtMs + 7 * 60_000),
    },
    queues: {
      liveBacklogStart: 4,
      liveBacklogEnd: 0,
      deadLetterCount: 0,
      oldestLiveAgeMinutes: 0,
      historicalReplayActive: false,
      liveRecoveryActive: false,
    },
    legacy: {
      writerInvocations: 0,
      canonicalFallbackUsed: false,
      packetWriterEnabled: false,
    },
    morningRefresh: morning
      ? {
          status: "succeeded",
          natural: true,
          startedAt: iso(startedAtMs),
          completedAt: iso(startedAtMs + 8 * 60_000),
        }
      : null,
  };
}

function truthLivenessFixture() {
  const start = Date.parse("2026-07-24T09:00:00.000Z");
  return {
    schema: "pikiio-truth-liveness-evidence-v1",
    phaseId: "TRUTH-01",
    cycles: [
      cycleFixture({ ordinal: 1, startedAtMs: start }),
      cycleFixture({ ordinal: 2, startedAtMs: start + 20 * 60_000 }),
    ],
  };
}

function truthSoakFixture() {
  const start = Date.parse("2026-07-24T09:00:00.000Z");
  const end = start + 25 * 60 * 60_000;
  return {
    schema: "pikiio-truth-soak-evidence-v1",
    phaseId: "TRUTH-02",
    startedAt: iso(start),
    endedAt: iso(end),
    cycles: [
      cycleFixture({ ordinal: 1, startedAtMs: start }),
      cycleFixture({
        ordinal: 2,
        startedAtMs: start + 12 * 60 * 60_000,
        morning: true,
      }),
      cycleFixture({ ordinal: 3, startedAtMs: end - 8 * 60_000 }),
    ],
  };
}

function time(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function add(findings, code, cycleId, detail) {
  findings.push({ code, cycleId: cycleId || null, detail });
}

function assessCycle(cycle, findings) {
  const id = String(cycle?.cycleId || "");
  if (cycle?.natural !== true || cycle?.manufactured !== false) {
    add(findings, "SOURCE_CYCLE_NOT_NATURAL", id, "cycle must be natural and unmanufactured");
  }
  const frontierBySource = new Map(
    (Array.isArray(cycle?.frontiers) ? cycle.frontiers : [])
      .map((item) => [String(item?.sourceSystem || ""), item]),
  );
  const acceptanceBySource = new Map(
    (Array.isArray(cycle?.acceptances) ? cycle.acceptances : [])
      .map((item) => [String(item?.sourceSystem || ""), item]),
  );
  for (const source of REQUIRED_SOURCES) {
    const frontier = frontierBySource.get(source);
    const acceptance = acceptanceBySource.get(source);
    if (!frontier || frontier.natural !== true || !String(frontier.sourceCutId || "")) {
      add(findings, "SOURCE_FRONTIER_MISSING", id, source);
      continue;
    }
    if (!acceptance || acceptance.status !== "accepted") {
      add(findings, "SOURCE_ACCEPTANCE_MISSING", id, source);
      continue;
    }
    if (
      acceptance.frontierId !== frontier.frontierId ||
      acceptance.sourceCutId !== frontier.sourceCutId
    ) {
      add(findings, "SOURCE_ACCEPTANCE_IDENTITY_MISMATCH", id, source);
    }
    if (
      !Number.isFinite(time(frontier.observedAt)) ||
      !Number.isFinite(time(acceptance.acceptedAt)) ||
      time(acceptance.acceptedAt) < time(frontier.observedAt)
    ) {
      add(findings, "SOURCE_ACCEPTANCE_ORDER_INVALID", id, source);
    }
    if (acceptance.productionPublicationAttempted !== false) {
      add(findings, "ACCEPTANCE_PUBLICATION_ATTEMPTED", id, source);
    }
  }

  const ledger = cycle?.truthLedger || {};
  if (
    ledger.schema !== "pikiio-truth-ledger-commit-receipt-v1" ||
    ledger.status !== "committed"
  ) {
    add(findings, "TRUTH_LEDGER_NOT_COMMITTED", id, String(ledger.status || ""));
  }
  for (const source of ["tms", "tracking"]) {
    const frontier = frontierBySource.get(source);
    if (
      !frontier ||
      ledger?.sourceCutIds?.[source] !== frontier.sourceCutId
    ) {
      add(findings, "TRUTH_LEDGER_SOURCE_MISMATCH", id, source);
    }
  }
  if (ledger.productionPublicationAttempted !== false) {
    add(findings, "TRUTH_LEDGER_PUBLICATION_ATTEMPTED", id, "truth ledger is ingest only");
  }

  const sourceCut = cycle?.sourceCut || {};
  for (const source of REQUIRED_SOURCES) {
    const acceptance = acceptanceBySource.get(source);
    if (
      !acceptance ||
      sourceCut?.sourceCutIds?.[source] !== acceptance.sourceCutId
    ) {
      add(findings, "SOURCE_CUT_ACCEPTANCE_MISMATCH", id, source);
    }
  }
  if (
    sourceCut.completeness !== "complete" ||
    sourceCut.gapCount !== 0 ||
    !String(sourceCut.id || "")
  ) {
    add(findings, "SOURCE_CUT_INCOMPLETE", id, String(sourceCut.completeness || ""));
  }
  if (
    !Number.isFinite(time(ledger.committedAt)) ||
    !Number.isFinite(time(sourceCut.sealedAt)) ||
    time(sourceCut.sealedAt) < time(ledger.committedAt)
  ) {
    add(findings, "SOURCE_CUT_ORDER_INVALID", id, "source cut must follow ledger commit");
  }

  const publication = cycle?.publication || {};
  if (
    publication.publisher !== "relational-truth-ledger" ||
    /legacy/i.test(String(publication.writerVersion || ""))
  ) {
    add(findings, "RELATIONAL_PUBLISHER_REQUIRED", id, String(publication.publisher || ""));
  }
  if (publication.sourceCutId !== sourceCut.id) {
    add(findings, "PUBLICATION_SOURCE_CUT_MISMATCH", id, "publication/source cut");
  }
  if (
    !Number.isFinite(time(publication.publishedAt)) ||
    time(publication.publishedAt) < time(sourceCut.sealedAt)
  ) {
    add(findings, "PUBLICATION_ORDER_INVALID", id, "publication before seal");
  }
  if (!/^[0-9a-f]{64}$/.test(String(publication.packetHash || ""))) {
    add(findings, "PUBLICATION_PACKET_HASH_INVALID", id, "packet hash");
  }

  if (
    cycle?.legacy?.writerInvocations !== 0 ||
    cycle?.legacy?.canonicalFallbackUsed !== false ||
    cycle?.legacy?.packetWriterEnabled !== false
  ) {
    add(findings, "LEGACY_WRITER_REVIVED", id, "legacy writer/fallback");
  }
  const queues = cycle?.queues || {};
  if (
    !Number.isSafeInteger(queues.liveBacklogStart) ||
    !Number.isSafeInteger(queues.liveBacklogEnd) ||
    queues.liveBacklogStart < 0 ||
    queues.liveBacklogEnd < 0
  ) {
    add(findings, "LIVE_QUEUE_RECEIPT_INVALID", id, "backlog counts");
  } else if (queues.liveBacklogEnd > queues.liveBacklogStart) {
    add(findings, "LIVE_BACKLOG_GREW", id, "end exceeds start");
  }
  if (queues.deadLetterCount !== 0) {
    add(findings, "DEAD_LETTER_PRESENT", id, String(queues.deadLetterCount));
  }
  if (queues.liveBacklogEnd > queues.liveBacklogStart || queues.deadLetterCount !== 0) {
    add(findings, "LIVE_QUEUE_UNSAFE", id, "backlog/dead-letter");
  }
  if (queues.historicalReplayActive === true && queues.liveRecoveryActive === true) {
    add(findings, "REPLAY_LIVE_RECOVERY_COLLISION", id, "concurrent replay/recovery");
  }

  const audit = cycle?.audit || {};
  if (
    audit.status !== "succeeded" ||
    audit.natural !== true ||
    audit.blockingFindingCount !== 0
  ) {
    add(findings, "AUDIT_NOT_SUCCESSFUL", id, String(audit.status || ""));
  }
  if (
    audit.sourceCutId !== publication.sourceCutId ||
    audit.packetHash !== publication.packetHash
  ) {
    add(findings, "AUDIT_PUBLICATION_MISMATCH", id, "audit identity");
  }
  if (time(audit.finishedAt) < time(publication.publishedAt)) {
    add(findings, "AUDIT_ORDER_INVALID", id, "audit before publication");
  }

  const health = cycle?.apiHealth || {};
  if (health.status !== "live") {
    add(findings, "TRUTH_HEALTH_NOT_LIVE", id, String(health.status || ""));
  }
  if (
    health.sourceCutId !== publication.sourceCutId ||
    health.packetHash !== publication.packetHash
  ) {
    add(findings, "HEALTH_PUBLICATION_MISMATCH", id, "health identity");
  }
  const brain = cycle?.brain || {};
  if (brain.status !== "live") {
    add(findings, "BRAIN_NOT_LIVE", id, String(brain.status || ""));
  }
  if (brain.activeSourceGapCount !== 0) {
    add(findings, "BRAIN_SOURCE_GAP", id, String(brain.activeSourceGapCount));
  }
  if (brain.activeContradictionCount !== 0) {
    add(findings, "BRAIN_CONTRADICTION", id, String(brain.activeContradictionCount));
  }
  if (
    brain.sourceCutId !== publication.sourceCutId ||
    brain.packetHash !== publication.packetHash
  ) {
    add(findings, "BRAIN_PUBLICATION_MISMATCH", id, "Brain identity");
  }
  const browser = cycle?.browser || {};
  if (browser.status !== "live" || browser.truthMode !== "relational") {
    add(findings, "BROWSER_NOT_RELATIONAL_LIVE", id, String(browser.status || ""));
  }
  if (browser.activeSourceGapCount !== 0) {
    add(findings, "BROWSER_SOURCE_GAP", id, String(browser.activeSourceGapCount));
  }
  if (
    browser.sourceCutId !== publication.sourceCutId ||
    browser.packetHash !== publication.packetHash
  ) {
    add(findings, "BROWSER_PUBLICATION_MISMATCH", id, "browser identity");
  }
}

function evaluateTruthLivenessEvidence(evidence) {
  const findings = [];
  if (
    !evidence ||
    evidence.schema !== "pikiio-truth-liveness-evidence-v1" ||
    evidence.phaseId !== "TRUTH-01" ||
    !Array.isArray(evidence.cycles)
  ) {
    add(findings, "LIVENESS_EVIDENCE_INVALID", null, "schema/phase/cycles");
  } else {
    evidence.cycles.forEach((cycle) => assessCycle(cycle, findings));
    const cycleIds = new Set(evidence.cycles.map((cycle) => cycle?.cycleId));
    const cutIds = new Set(evidence.cycles.map((cycle) => cycle?.sourceCut?.id));
    if (
      evidence.cycles.length < 2 ||
      cycleIds.size !== evidence.cycles.length ||
      cutIds.size !== evidence.cycles.length
    ) {
      add(findings, "NATURAL_CYCLES_NOT_DISTINCT", null, "two unique cycles/cuts required");
    }
  }
  return deepFreeze({
    schema: "pikiio-truth-phase-assessment-v1",
    profile: "truth-liveness",
    ok: findings.length === 0,
    cycleCount: Array.isArray(evidence?.cycles) ? evidence.cycles.length : 0,
    findings,
  });
}

function evaluateTruthSoakEvidence(evidence) {
  const findings = [];
  if (
    !evidence ||
    evidence.schema !== "pikiio-truth-soak-evidence-v1" ||
    evidence.phaseId !== "TRUTH-02" ||
    !Array.isArray(evidence.cycles)
  ) {
    add(findings, "SOAK_EVIDENCE_INVALID", null, "schema/phase/cycles");
  } else {
    const liveness = evaluateTruthLivenessEvidence({
      schema: "pikiio-truth-liveness-evidence-v1",
      phaseId: "TRUTH-01",
      cycles: evidence.cycles,
    });
    findings.push(...liveness.findings);
    const start = time(evidence.startedAt);
    const end = time(evidence.endedAt);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end - start < 24 * 60 * 60_000
    ) {
      add(findings, "SOAK_DURATION_TOO_SHORT", null, "minimum 24h");
    }
    const morning = evidence.cycles
      .map((cycle) => ({ cycle, receipt: cycle?.morningRefresh }))
      .filter(({ receipt }) => receipt);
    const successfulNatural = morning.filter(({ receipt }) =>
      receipt.status === "succeeded" && receipt.natural === true);
    if (!successfulNatural.length) {
      add(findings, "NATURAL_MORNING_REFRESH_MISSING", null, "no natural success");
    }
    for (const { cycle, receipt } of successfulNatural) {
      if (
        time(receipt.startedAt) < start ||
        time(receipt.completedAt) > end ||
        time(receipt.completedAt) < time(receipt.startedAt)
      ) {
        add(findings, "MORNING_REFRESH_OUTSIDE_SOAK", cycle.cycleId, "outside soak");
      }
    }
  }
  return deepFreeze({
    schema: "pikiio-truth-phase-assessment-v1",
    profile: "truth-soak",
    ok: findings.length === 0,
    cycleCount: Array.isArray(evidence?.cycles) ? evidence.cycles.length : 0,
    findings,
  });
}

function parseFeature(source) {
  const scenarios = [];
  let current = null;
  for (const rawLine of String(source).split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("Feature:")) continue;
    if (line.startsWith("Scenario:")) {
      current = { name: line.slice("Scenario:".length).trim(), steps: [] };
      scenarios.push(current);
      continue;
    }
    if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      assert.ok(current, `Step appears before a Scenario: ${line}`);
      current.steps.push(line);
      continue;
    }
    throw new Error(`Unsupported Gherkin syntax: ${line}`);
  }
  return scenarios;
}

function exactScenarioContracts(scenarios, definitions) {
  const names = scenarios.map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length, "Scenario names must be unique");
  assert.deepEqual(
    [...names].sort(),
    Object.keys(definitions).sort(),
    "Every scenario must have exactly one executable contract",
  );
  for (const scenario of scenarios) {
    assert.deepEqual(
      scenario.steps,
      definitions[scenario.name].steps,
      `${scenario.name}: undefined, reordered, or ambiguous step contract`,
    );
  }
}

function expectCode(result, code) {
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === code), code);
}

function livenessDefinitions() {
  const mutate = (operation, code) => {
    const fixture = truthLivenessFixture();
    operation(fixture);
    expectCode(evaluateTruthLivenessEvidence(fixture), code);
  };
  return {
    "Natural source evidence is mandatory": {
      steps: [
        "Given two complete natural relational cycles",
        "When either cycle is manufactured",
        "Then liveness is refused as SOURCE_CYCLE_NOT_NATURAL",
      ],
      execute: () => mutate((f) => { f.cycles[0].manufactured = true; }, "SOURCE_CYCLE_NOT_NATURAL"),
    },
    "Gmail TMS and tracking frontiers are all present": {
      steps: [
        "Given two complete natural relational cycles",
        "When a required source frontier is absent",
        "Then liveness is refused as SOURCE_FRONTIER_MISSING",
      ],
      execute: () => mutate((f) => { f.cycles[0].frontiers.pop(); }, "SOURCE_FRONTIER_MISSING"),
    },
    "Every frontier receives an accepted receipt": {
      steps: [
        "Given two complete natural relational cycles",
        "When a required source acceptance is absent",
        "Then liveness is refused as SOURCE_ACCEPTANCE_MISSING",
      ],
      execute: () => mutate((f) => { f.cycles[0].acceptances.shift(); }, "SOURCE_ACCEPTANCE_MISSING"),
    },
    "Acceptance follows the observed frontier": {
      steps: [
        "Given two complete natural relational cycles",
        "When an acceptance predates its frontier",
        "Then liveness is refused as SOURCE_ACCEPTANCE_ORDER_INVALID",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].acceptances[0].acceptedAt = "2026-01-01T00:00:00.000Z";
      }, "SOURCE_ACCEPTANCE_ORDER_INVALID"),
    },
    "The truth ledger receipt is committed": {
      steps: [
        "Given two complete natural relational cycles",
        "When the truth ledger receipt is disabled",
        "Then liveness is refused as TRUTH_LEDGER_NOT_COMMITTED",
      ],
      execute: () => mutate((f) => { f.cycles[0].truthLedger.status = "disabled"; }, "TRUTH_LEDGER_NOT_COMMITTED"),
    },
    "The truth ledger binds TMS and tracking cuts": {
      steps: [
        "Given two complete natural relational cycles",
        "When the committed tracking cut differs",
        "Then liveness is refused as TRUTH_LEDGER_SOURCE_MISMATCH",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].truthLedger.sourceCutIds.tracking = cut("f");
      }, "TRUTH_LEDGER_SOURCE_MISMATCH"),
    },
    "A source cut seals only after the ledger commits": {
      steps: [
        "Given two complete natural relational cycles",
        "When the source cut predates the ledger commit",
        "Then liveness is refused as SOURCE_CUT_ORDER_INVALID",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].sourceCut.sealedAt = f.cycles[0].startedAt;
      }, "SOURCE_CUT_ORDER_INVALID"),
    },
    "The canonical source cut is complete": {
      steps: [
        "Given two complete natural relational cycles",
        "When a canonical source cut is degraded",
        "Then liveness is refused as SOURCE_CUT_INCOMPLETE",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].sourceCut.completeness = "degraded";
      }, "SOURCE_CUT_INCOMPLETE"),
    },
    "Publication follows the exact source cut": {
      steps: [
        "Given two complete natural relational cycles",
        "When publication cites another source cut",
        "Then liveness is refused as PUBLICATION_SOURCE_CUT_MISMATCH",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].publication.sourceCutId = cut("0");
      }, "PUBLICATION_SOURCE_CUT_MISMATCH"),
    },
    "Publication follows acceptance and sealing": {
      steps: [
        "Given two complete natural relational cycles",
        "When publication predates source-cut sealing",
        "Then liveness is refused as PUBLICATION_ORDER_INVALID",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].publication.publishedAt = f.cycles[0].startedAt;
      }, "PUBLICATION_ORDER_INVALID"),
    },
    "The legacy packet writer stays retired": {
      steps: [
        "Given two complete natural relational cycles",
        "When a legacy writer invocation appears",
        "Then liveness is refused as LEGACY_WRITER_REVIVED",
      ],
      execute: () => mutate((f) => { f.cycles[0].legacy.writerInvocations = 1; }, "LEGACY_WRITER_REVIVED"),
    },
    "Live queues drain without dead letters": {
      steps: [
        "Given two complete natural relational cycles",
        "When live backlog grows or a dead letter appears",
        "Then liveness is refused as LIVE_QUEUE_UNSAFE",
      ],
      execute: () => mutate((f) => { f.cycles[0].queues.deadLetterCount = 1; }, "LIVE_QUEUE_UNSAFE"),
    },
    "Historical replay cannot collide with live recovery": {
      steps: [
        "Given two complete natural relational cycles",
        "When historical replay and live recovery overlap",
        "Then liveness is refused as REPLAY_LIVE_RECOVERY_COLLISION",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].queues.historicalReplayActive = true;
        f.cycles[0].queues.liveRecoveryActive = true;
      }, "REPLAY_LIVE_RECOVERY_COLLISION"),
    },
    "Two distinct natural cycles are required": {
      steps: [
        "Given two complete natural relational cycles",
        "When both cycles reuse one source-cut identity",
        "Then liveness is refused as NATURAL_CYCLES_NOT_DISTINCT",
      ],
      execute: () => mutate((f) => {
        f.cycles[1].sourceCut.id = f.cycles[0].sourceCut.id;
        f.cycles[1].publication.sourceCutId = f.cycles[0].sourceCut.id;
        f.cycles[1].audit.sourceCutId = f.cycles[0].sourceCut.id;
        f.cycles[1].apiHealth.sourceCutId = f.cycles[0].sourceCut.id;
        f.cycles[1].brain.sourceCutId = f.cycles[0].sourceCut.id;
        f.cycles[1].browser.sourceCutId = f.cycles[0].sourceCut.id;
      }, "NATURAL_CYCLES_NOT_DISTINCT"),
    },
    "Audit APIs and browser agree with publication": {
      steps: [
        "Given two complete natural relational cycles",
        "When the browser packet hash differs from publication",
        "Then liveness is refused as BROWSER_PUBLICATION_MISMATCH",
      ],
      execute: () => mutate((f) => {
        f.cycles[0].browser.packetHash = "0".repeat(64);
      }, "BROWSER_PUBLICATION_MISMATCH"),
    },
  };
}

function soakDefinitions() {
  const mutate = (operation, code) => {
    const fixture = truthSoakFixture();
    operation(fixture);
    expectCode(evaluateTruthSoakEvidence(fixture), code);
  };
  return {
    "The soak lasts at least twenty four hours": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When the soak ends before twenty four hours",
        "Then soak acceptance is refused as SOAK_DURATION_TOO_SHORT",
      ],
      execute: () => mutate((f) => {
        f.endedAt = iso(time(f.startedAt) + 23 * 60 * 60_000);
      }, "SOAK_DURATION_TOO_SHORT"),
    },
    "Soak cycles are natural": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When one soak cycle is manufactured",
        "Then soak acceptance is refused as SOURCE_CYCLE_NOT_NATURAL",
      ],
      execute: () => mutate((f) => { f.cycles[1].manufactured = true; }, "SOURCE_CYCLE_NOT_NATURAL"),
    },
    "Two distinct source cuts span the soak": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When every cycle reuses one source cut",
        "Then soak acceptance is refused as NATURAL_CYCLES_NOT_DISTINCT",
      ],
      execute: () => mutate((f) => {
        const id = f.cycles[0].sourceCut.id;
        for (const cycle of f.cycles) {
          cycle.sourceCut.id = id;
          for (const surface of ["publication", "audit", "apiHealth", "brain", "browser"]) {
            cycle[surface].sourceCutId = id;
          }
        }
      }, "NATURAL_CYCLES_NOT_DISTINCT"),
    },
    "A natural morning refresh succeeds": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When no natural morning refresh succeeds",
        "Then soak acceptance is refused as NATURAL_MORNING_REFRESH_MISSING",
      ],
      execute: () => mutate((f) => { f.cycles[1].morningRefresh.status = "failed"; }, "NATURAL_MORNING_REFRESH_MISSING"),
    },
    "The morning refresh lies inside the soak": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When the morning refresh falls outside the soak",
        "Then soak acceptance is refused as MORNING_REFRESH_OUTSIDE_SOAK",
      ],
      execute: () => mutate((f) => {
        f.cycles[1].morningRefresh.completedAt = iso(time(f.endedAt) + 1);
      }, "MORNING_REFRESH_OUTSIDE_SOAK"),
    },
    "Every cycle keeps truth health live": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When one health response is degraded",
        "Then soak acceptance is refused as TRUTH_HEALTH_NOT_LIVE",
      ],
      execute: () => mutate((f) => { f.cycles[1].apiHealth.status = "degraded"; }, "TRUTH_HEALTH_NOT_LIVE"),
    },
    "Every active Brain row remains source backed": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When Brain reports an active source gap",
        "Then soak acceptance is refused as BRAIN_SOURCE_GAP",
      ],
      execute: () => mutate((f) => { f.cycles[1].brain.activeSourceGapCount = 1; }, "BRAIN_SOURCE_GAP"),
    },
    "Canonical contradictions remain zero": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When Brain reports an active contradiction",
        "Then soak acceptance is refused as BRAIN_CONTRADICTION",
      ],
      execute: () => mutate((f) => { f.cycles[1].brain.activeContradictionCount = 1; }, "BRAIN_CONTRADICTION"),
    },
    "Live backlog never grows": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When a cycle ends with more live backlog",
        "Then soak acceptance is refused as LIVE_BACKLOG_GREW",
      ],
      execute: () => mutate((f) => { f.cycles[1].queues.liveBacklogEnd = 5; }, "LIVE_BACKLOG_GREW"),
    },
    "Dead letters remain zero": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When a dead letter appears",
        "Then soak acceptance is refused as DEAD_LETTER_PRESENT",
      ],
      execute: () => mutate((f) => { f.cycles[1].queues.deadLetterCount = 1; }, "DEAD_LETTER_PRESENT"),
    },
    "Every relational audit succeeds": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When an audit fails",
        "Then soak acceptance is refused as AUDIT_NOT_SUCCESSFUL",
      ],
      execute: () => mutate((f) => { f.cycles[1].audit.status = "failed"; }, "AUDIT_NOT_SUCCESSFUL"),
    },
    "Audit and publication use one source cut": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When an audit cites another source cut",
        "Then soak acceptance is refused as AUDIT_PUBLICATION_MISMATCH",
      ],
      execute: () => mutate((f) => { f.cycles[1].audit.sourceCutId = cut("0"); }, "AUDIT_PUBLICATION_MISMATCH"),
    },
    "Browser and API packet identities agree": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When the browser packet hash differs",
        "Then soak acceptance is refused as BROWSER_PUBLICATION_MISMATCH",
      ],
      execute: () => mutate((f) => { f.cycles[1].browser.packetHash = "0".repeat(64); }, "BROWSER_PUBLICATION_MISMATCH"),
    },
    "The legacy writer remains absent for the full soak": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When a legacy writer invocation appears",
        "Then soak acceptance is refused as LEGACY_WRITER_REVIVED",
      ],
      execute: () => mutate((f) => { f.cycles[2].legacy.writerInvocations = 1; }, "LEGACY_WRITER_REVIVED"),
    },
    "Historical replay never overlaps live recovery": {
      steps: [
        "Given a clean twenty five hour relational soak",
        "When replay overlaps live recovery",
        "Then soak acceptance is refused as REPLAY_LIVE_RECOVERY_COLLISION",
      ],
      execute: () => mutate((f) => {
        f.cycles[2].queues.historicalReplayActive = true;
        f.cycles[2].queues.liveRecoveryActive = true;
      }, "REPLAY_LIVE_RECOVERY_COLLISION"),
    },
  };
}

function definitionsForProfile(profile) {
  if (profile === "truth-liveness-gherkin-v1") return livenessDefinitions();
  if (profile === "truth-soak-gherkin-v1") return soakDefinitions();
  throw Object.assign(new Error(`Unknown immutable Gherkin profile: ${profile}`), {
    code: "TRUTH_GHERKIN_PROFILE_UNKNOWN",
  });
}

function executeProfile(profile) {
  const contract = GHERKIN_PROFILES[profile];
  if (!contract) {
    throw Object.assign(new Error(`Unknown immutable Gherkin profile: ${profile}`), {
      code: "TRUTH_GHERKIN_PROFILE_UNKNOWN",
    });
  }
  const scenarios = parseFeature(fs.readFileSync(contract.featurePath, "utf8"));
  const definitions = definitionsForProfile(profile);
  exactScenarioContracts(scenarios, definitions);
  const results = [];
  for (const scenario of scenarios) {
    try {
      definitions[scenario.name].execute();
      results.push({ name: scenario.name, status: "passed" });
    } catch (error) {
      results.push({
        name: scenario.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const passed = results.filter((result) => result.status === "passed").length;
  return deepFreeze({
    ok: passed === scenarios.length,
    schema: "pikiio-truth-gherkin-result-v1",
    profile,
    phaseId: contract.phaseId,
    population: scenarios.length,
    passed,
    failed: scenarios.length - passed,
    skipped: 0,
    undefined: 0,
    ambiguous: 0,
    pending: 0,
    scenarios: results,
  });
}

function parseProfileArg(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) {
    throw Object.assign(
      new Error("Exactly one immutable --profile=<truth-profile> argument is required"),
      { code: "TRUTH_GHERKIN_PROFILE_REQUIRED" },
    );
  }
  const match = /^--profile=([a-z0-9-]+)$/.exec(argv[0]);
  if (!match || !Object.hasOwn(GHERKIN_PROFILES, match[1])) {
    throw Object.assign(new Error("Unknown immutable truth Gherkin profile"), {
      code: "TRUTH_GHERKIN_PROFILE_UNKNOWN",
    });
  }
  return match[1];
}

function main() {
  try {
    const profile = parseProfileArg(process.argv.slice(2));
    const result = executeProfile(profile);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "pikiio-truth-gherkin-result-v1",
      code: String(error?.code || "TRUTH_GHERKIN_FAILED"),
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 64;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  GHERKIN_PROFILES,
  REQUIRED_SOURCES,
  clone,
  definitionsForProfile,
  evaluateTruthLivenessEvidence,
  evaluateTruthSoakEvidence,
  exactScenarioContracts,
  executeProfile,
  parseFeature,
  parseProfileArg,
  truthLivenessFixture,
  truthSoakFixture,
});

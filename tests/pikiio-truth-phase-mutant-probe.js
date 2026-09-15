#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CHILD_PATH = path.join(__dirname, "pikiio-truth-phase-product-child.js");
const REQUEST_PROTOCOL = "pikiio-truth-product-child-request-v1";
const RESPONSE_PROTOCOL = "pikiio-truth-product-child-response-v1";
const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const OBLIGATION = `pending-acceptance-epoch:v1:${"a".repeat(64)}`;
const BATCH = "11111111-1111-4111-8111-111111111111";
let requestSequence = 0;

class ProductChildProtocolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProductChildProtocolError";
    this.code = code;
    this.details = details;
  }
}

class ProbeAssertion extends Error {
  constructor(fingerprint, details = {}) {
    super(fingerprint);
    this.name = "ProbeAssertion";
    this.fingerprint = fingerprint;
    this.details = details;
  }
}

function expect(value, fingerprint, details = {}) {
  if (!value) throw new ProbeAssertion(fingerprint, details);
}

function exactKeys(value, keys) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function validateJsonValue(value, field = "response", depth = 0) {
  if (depth > 32) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
      `${field} exceeds maximum depth`,
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_RESPONSE_BYTES)
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) {
      throw new ProductChildProtocolError(
        "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
        `${field} contains too many entries`,
      );
    }
    value.forEach((item, index) => validateJsonValue(item, `${field}[${index}]`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new ProductChildProtocolError(
          "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
          `${field}.${key} is forbidden`,
        );
      }
      validateJsonValue(item, `${field}.${key}`, depth + 1);
    }
    return;
  }
  throw new ProductChildProtocolError(
    "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
    `${field} is not bounded JSON`,
  );
}

function nextRequestId() {
  requestSequence += 1;
  return crypto.createHash("sha256")
    .update(`pikiio-truth-child:${process.pid}:${requestSequence}`)
    .digest("hex");
}

function parseChildResponse(result, requestId) {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const bytes = Buffer.byteLength(stdout, "utf8");
  if (result.error?.code === "ETIMEDOUT") {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_TIMEOUT",
      "product child exceeded its bounded deadline",
    );
  }
  if (result.error?.code === "ENOBUFS" || bytes > MAX_RESPONSE_BYTES) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_OVERSIZED_OUTPUT",
      "product child exceeded its output bound",
      { bytes },
    );
  }
  if (result.signal) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_SIGNAL",
      `product child terminated by ${result.signal}`,
      { signal: result.signal },
    );
  }
  if (result.error) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_TRANSPORT_ERROR",
      String(result.error.message || result.error),
    );
  }
  if (result.status !== 0) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_EXIT_NONZERO",
      `product child exited ${result.status}`,
      { status: result.status },
    );
  }
  if (stderr) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_STDERR",
      "product child wrote stderr",
    );
  }
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_EXTRA_OUTPUT",
      "product child must emit exactly one newline-terminated JSON record",
      { lineCount: lines.length - 1 },
    );
  }
  let response;
  try {
    response = JSON.parse(lines[0]);
  } catch {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_MALFORMED_OUTPUT",
      "product child response is not JSON",
    );
  }
  validateJsonValue(response);
  if (
    response?.protocol !== RESPONSE_PROTOCOL ||
    response?.requestId !== requestId ||
    typeof response?.ok !== "boolean"
  ) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_RESPONSE_IDENTITY_INVALID",
      "product child response identity is invalid",
    );
  }
  if (
    response.ok === true &&
    !exactKeys(response, ["ok", "protocol", "requestId", "result"])
  ) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
      "successful product child response has unexpected fields",
    );
  }
  if (
    response.ok === false &&
    (
      !exactKeys(response, ["error", "ok", "protocol", "requestId"]) ||
      !exactKeys(response.error, ["code", "message", "name"])
    )
  ) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_RESPONSE_SHAPE_INVALID",
      "failed product child response has unexpected fields",
    );
  }
  return response;
}

function runProductChild({
  sourcePath = "",
  originalRelativePath = "",
  operation,
  input = {},
  fixture = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  childPath = CHILD_PATH,
} = {}) {
  const requestId = nextRequestId();
  const request = {
    protocol: REQUEST_PROTOCOL,
    requestId,
    target: {
      kind: fixture ? "fixture" : "module",
      sourcePath,
      originalRelativePath,
    },
    operation: { name: operation, input },
  };
  const encoded = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > MAX_REQUEST_BYTES) {
    throw new ProductChildProtocolError(
      "TRUTH_PRODUCT_CHILD_REQUEST_OVERSIZED",
      "product child request exceeds its bound",
    );
  }
  const result = spawnSync(process.execPath, [childPath], {
    cwd: ROOT,
    input: encoded,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_RESPONSE_BYTES + 1024,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      TZ: "UTC",
    },
  });
  return parseChildResponse(result, requestId);
}

function runHostileProductFixture(operation, options = {}) {
  return runProductChild({
    fixture: true,
    operation,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
}

function cut(fill) {
  return `cut:v1:${fill.repeat(64)}`;
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function truthCycleEvidenceFixture({
  ordinal,
  startedAtMs,
  morning = false,
}) {
  const sourceFills = {
    gmail: ordinal === 1 ? "a" : ordinal === 2 ? "b" : "c",
    tms: ordinal === 1 ? "d" : ordinal === 2 ? "e" : "f",
    tracking: ordinal === 1 ? "1" : ordinal === 2 ? "2" : "3",
  };
  const canonicalFill = ordinal === 1 ? "4" : ordinal === 2 ? "5" : "6";
  const packetFill = ordinal === 1 ? "7" : ordinal === 2 ? "8" : "9";
  const frontiers = ["gmail", "tms", "tracking"].map(
    (sourceSystem, index) => ({
      sourceSystem,
      sourceCutId: cut(sourceFills[sourceSystem]),
      frontierId: `frontier:${sourceSystem}:${ordinal}`,
      observedAt: iso(startedAtMs + index * 1_000),
      natural: true,
    }),
  );
  const acceptances = frontiers.map((frontier, index) => ({
    sourceSystem: frontier.sourceSystem,
    sourceCutId: frontier.sourceCutId,
    frontierId: frontier.frontierId,
    status: "accepted",
    acceptedAt: iso(startedAtMs + 60_000 + index * 1_000),
    productionPublicationAttempted: false,
  }));
  const sourceCutIds = Object.fromEntries(
    frontiers.map((frontier) => [
      frontier.sourceSystem,
      frontier.sourceCutId,
    ]),
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

function truthSoakEvidenceForCheck(checkId) {
  const start = Date.parse("2026-07-24T09:00:00.000Z");
  const end = start + 25 * 60 * 60_000;
  const evidence = {
    schema: "pikiio-truth-soak-evidence-v1",
    phaseId: "TRUTH-02",
    startedAt: iso(start),
    endedAt: iso(end),
    cycles: [
      truthCycleEvidenceFixture({ ordinal: 1, startedAtMs: start }),
      truthCycleEvidenceFixture({
        ordinal: 2,
        startedAtMs: start + 12 * 60 * 60_000,
        morning: true,
      }),
      truthCycleEvidenceFixture({
        ordinal: 3,
        startedAtMs: end - 8 * 60_000,
      }),
    ],
  };
  switch (checkId) {
    case "soak-minimum-duration":
      evidence.endedAt = iso(start + 23 * 60 * 60_000);
      break;
    case "soak-natural-morning":
      evidence.cycles[1].morningRefresh.natural = false;
      break;
    case "soak-morning-required":
      evidence.cycles[1].morningRefresh = null;
      break;
    case "soak-morning-start-bound":
      evidence.cycles[1].morningRefresh.startedAt =
        "2026-01-01T00:00:00.000Z";
      break;
    case "soak-morning-end-bound":
      evidence.cycles[1].morningRefresh.completedAt = iso(end + 1);
      break;
    case "soak-morning-chronology":
      evidence.cycles[1].morningRefresh.completedAt =
        "2026-01-01T00:00:00.000Z";
      break;
    case "soak-live-backlog-monotonic":
      evidence.cycles[1].queues.liveBacklogEnd = 5;
      break;
    case "soak-dead-letter-zero":
      evidence.cycles[1].queues.deadLetterCount = 1;
      break;
    case "soak-replay-live-recovery-exclusion":
      evidence.cycles[1].queues.historicalReplayActive = true;
      evidence.cycles[1].queues.liveRecoveryActive = true;
      break;
    case "soak-health-live":
      evidence.cycles[1].apiHealth.status = "degraded";
      break;
    default:
      throw Object.assign(new Error(`Unknown soak evidence ${checkId}`), {
        code: "TRUTH_MUTANT_PROBE_UNKNOWN",
      });
  }
  return evidence;
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

function frontierReceipt(batch) {
  return {
    ok: true,
    batches: batch ? [batch] : [],
    productionPublicationAttempted: false,
  };
}

function acceptanceReceipt(overrides = {}) {
  return {
    status: "succeeded",
    acceptedCount: 1,
    rejectedCount: 0,
    reviewCount: 0,
    productionPublicationAttempted: false,
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

function sealedReceipt(overrides = {}) {
  const manifestHash = "a".repeat(64);
  return {
    ok: true,
    status: "sealed",
    sourceCutId: `cut:v1:${manifestHash}`,
    manifestHash,
    manifest: { schemaVersion: "source-cut-manifest-v2" },
    completeness: "complete",
    gaps: [],
    observationCount: 2,
    ...overrides,
  };
}

function productOperation(sourcePath, originalRelativePath, operation, input) {
  return runProductChild({
    sourcePath,
    originalRelativePath,
    operation,
    input,
  });
}

function expectProductFailure(response, fingerprint) {
  expect(response.ok === false, fingerprint, response);
}

function findingCodes(result) {
  return new Set(result.findings.map((finding) => finding.code));
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
    evidencePacket: { freshness: {}, sourceFacts: [] },
    truthPacket: {
      currentState: "pre-arrival",
      contradictions: [],
      gates: {},
    },
    ...overrides,
  };
}

function runLivenessCheck(sourcePath, originalRelativePath, checkId) {
  const call = (operation, input) =>
    productOperation(sourcePath, originalRelativePath, operation, input);
  switch (checkId) {
    case "liveness-frontier-publication-boundary":
      expectProductFailure(call("normalize-frontier", {
        receipt: { ok: true, batches: [], productionPublicationAttempted: true },
      }), "frontier-publication-attempt-accepted");
      return;
    case "liveness-frontier-connection-registry":
      expectProductFailure(call("normalize-frontier", {
        receipt: frontierReceipt(frontierBatch({ connectionKey: "other" })),
      }), "foreign-source-connection-accepted");
      return;
    case "liveness-already-accepted-skip": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(frontierBatch({ acceptanceComplete: true })),
        acceptanceReceipt: acceptanceReceipt(),
      });
      expect(response.ok && response.result.result.actions.length === 0, "already-accepted-frontier-reran");
      return;
    }
    case "liveness-not-ready-skip": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(frontierBatch({ readyToRun: false })),
        acceptanceReceipt: acceptanceReceipt(),
      });
      expect(response.ok && response.result.result.actions.length === 0, "not-ready-frontier-ran");
      return;
    }
    case "liveness-acceptance-receipt-no-publication": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(frontierBatch()),
        acceptanceReceipt: acceptanceReceipt({ productionPublicationAttempted: true }),
      });
      expect(response.ok && response.result.result.actions.length === 0, "publishing-acceptance-counted-success");
      return;
    }
    case "liveness-coordinator-no-operational-state": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(null),
        acceptanceReceipt: acceptanceReceipt(),
      });
      expect(response.ok && response.result.result.mutatesOperationalState === false, "coordinator-operational-mutation-enabled");
      return;
    }
    case "liveness-coordinator-no-truth-publication": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(null),
        acceptanceReceipt: acceptanceReceipt(),
      });
      expect(response.ok && response.result.result.publishesTruth === false, "coordinator-publication-enabled");
      return;
    }
    case "liveness-coordinator-no-publication-attempt": {
      const response = call("generic-run", {
        frontierReceipt: frontierReceipt(null),
        acceptanceReceipt: acceptanceReceipt(),
      });
      expect(response.ok && response.result.result.productionPublicationAttempted === false, "coordinator-publication-attempt-hidden");
      return;
    }
    case "liveness-not-ready-null-identity":
      expectProductFailure(call("validate-source-cut", {
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
      }), "not-ready-source-cut-carried-identity");
      return;
    case "liveness-not-ready-gap-required":
      expectProductFailure(call("validate-source-cut", {
        receipt: {
          ok: true,
          status: "not_ready",
          sourceCutId: null,
          manifestHash: null,
          manifest: null,
          completeness: "degraded",
          gaps: [],
          observationCount: 0,
        },
      }), "not-ready-source-cut-without-gap-accepted");
      return;
    case "liveness-sealed-content-address-binding":
      expectProductFailure(call("validate-source-cut", {
        receipt: sealedReceipt({ sourceCutId: cut("b") }),
      }), "non-content-addressed-source-cut-accepted");
      return;
    case "liveness-sealed-manifest-no-observations":
      expectProductFailure(call("validate-source-cut", {
        receipt: sealedReceipt({
          manifest: { schemaVersion: "source-cut-manifest-v2", observations: [] },
        }),
      }), "source-cut-inline-observations-accepted");
      return;
    case "liveness-source-cut-completeness-gap-parity":
      expectProductFailure(call("validate-source-cut", {
        receipt: sealedReceipt({ gaps: [{ gapType: "pending" }] }),
      }), "complete-source-cut-with-gap-accepted");
      return;
    case "liveness-accepted-cut-shadow-channel":
      expectProductFailure(call("validate-accepted-cut", {
        receipt: acceptedCutReceipt({ publicationChannel: "production" }),
      }), "accepted-gmail-cut-production-channel-accepted");
      return;
    case "liveness-accepted-cut-shadow-only":
      expectProductFailure(call("validate-accepted-cut", {
        receipt: acceptedCutReceipt({ shadowOnly: false }),
      }), "accepted-gmail-cut-nonshadow-accepted");
      return;
    case "liveness-accepted-cut-not-production-eligible":
      expectProductFailure(call("validate-accepted-cut", {
        receipt: acceptedCutReceipt({ productionEligible: true }),
      }), "accepted-gmail-cut-production-eligible");
      return;
    case "liveness-production-bridge-distinct-cut": {
      const shadow = acceptedCutReceipt().sourceCutId;
      expectProductFailure(call("validate-production-bridge", {
        receipt: bridgeReceipt(shadow, {
          productionSourceCutId: shadow,
          sourceCutId: shadow,
          manifestHash: shadow.slice("cut:v1:".length),
        }),
        shadowSourceCutId: shadow,
      }), "production-bridge-reused-shadow-cut");
      return;
    }
    case "liveness-production-bridge-eligibility": {
      const shadow = acceptedCutReceipt().sourceCutId;
      expectProductFailure(call("validate-production-bridge", {
        receipt: bridgeReceipt(shadow, { productionEligible: false }),
        shadowSourceCutId: shadow,
      }), "ineligible-production-bridge-accepted");
      return;
    }
    case "liveness-accepted-cut-validation-before-bridge": {
      const shadow = acceptedCutReceipt({ shadowOnly: false });
      const response = call("production-source-cut-run", {
        head: { ok: true, accepted: true, obligationId: OBLIGATION },
        shadowCut: shadow,
        bridge: bridgeReceipt(shadow.sourceCutId),
      });
      expectProductFailure(response, "invalid-accepted-cut-reached-production-bridge");
      return;
    }
    case "liveness-canonical-watermark-before-write": {
      const response = call("canonical-publish", { snapshot: { shipments: [] } });
      expect(
        response.ok &&
        response.result.outcome === "rejected" &&
        response.result.writes === 0,
        "incomplete-canonical-watermark-was-written",
      );
      return;
    }
    default:
      throw Object.assign(new Error(`Unknown liveness probe ${checkId}`), {
        code: "TRUTH_MUTANT_PROBE_UNKNOWN",
      });
  }
}

function runSoakCheck(sourcePath, originalRelativePath, checkId) {
  const call = (operation, input) =>
    productOperation(sourcePath, originalRelativePath, operation, input);
  switch (checkId) {
    case "soak-minimum-duration":
    case "soak-natural-morning":
    case "soak-morning-required":
    case "soak-morning-start-bound":
    case "soak-morning-end-bound":
    case "soak-morning-chronology":
    case "soak-live-backlog-monotonic":
    case "soak-dead-letter-zero":
    case "soak-replay-live-recovery-exclusion":
    case "soak-health-live": {
      const response = runProductChild({
        sourcePath,
        originalRelativePath,
        operation: "truth-soak-evaluate",
        input: { evidence: truthSoakEvidenceForCheck(checkId) },
      });
      const expected = {
        "soak-minimum-duration": ["SOAK_DURATION_TOO_SHORT", "short-soak-accepted"],
        "soak-natural-morning": ["NATURAL_MORNING_REFRESH_MISSING", "manufactured-morning-accepted"],
        "soak-morning-required": ["NATURAL_MORNING_REFRESH_MISSING", "missing-morning-accepted"],
        "soak-morning-start-bound": ["MORNING_REFRESH_OUTSIDE_SOAK", "pre-soak-morning-accepted"],
        "soak-morning-end-bound": ["MORNING_REFRESH_OUTSIDE_SOAK", "post-soak-morning-accepted"],
        "soak-morning-chronology": ["MORNING_REFRESH_OUTSIDE_SOAK", "backward-morning-time-accepted"],
        "soak-live-backlog-monotonic": ["LIVE_BACKLOG_GREW", "growing-live-backlog-accepted"],
        "soak-dead-letter-zero": ["DEAD_LETTER_PRESENT", "dead-letter-accepted"],
        "soak-replay-live-recovery-exclusion": ["REPLAY_LIVE_RECOVERY_COLLISION", "replay-recovery-collision-accepted"],
        "soak-health-live": ["TRUTH_HEALTH_NOT_LIVE", "degraded-health-accepted"],
      }[checkId];
      expect(response.ok && findingCodes(response.result).has(expected[0]), expected[1]);
      return;
    }
    case "soak-invalid-time-stale": {
      const response = call("health-stale", {
        timestamp: "invalid",
        maxAgeMinutes: 15,
        now: "2026-07-24T10:00:00.000Z",
      });
      expect(response.ok && response.result === true, "invalid-time-treated-fresh");
      return;
    }
    case "soak-completed-row-excluded": {
      const response = call("health-active-rows", {
        snapshot: {
          activeAwbs: ["01480000010"],
          shipments: [coveredRow({ truthPacketRole: "completed" })],
        },
      });
      expect(response.ok && response.result.length === 0, "completed-row-treated-active");
      return;
    }
    case "soak-active-index-binding": {
      const response = call("health-active-rows", {
        snapshot: {
          activeAwbs: ["01480000011"],
          shipments: [coveredRow(), coveredRow({ awb: "014-80000011" })],
        },
      });
      expect(
        response.ok &&
        response.result.length === 1 &&
        response.result[0].awb === "014-80000011",
        "active-index-ignored",
      );
      return;
    }
    case "soak-coverage-stamp-required": {
      const row = coveredRow({ gmailCoverage: {} });
      const response = call("health-row-certification", {
        snapshot: { activeAwbs: [row.awb], shipments: [row] },
      });
      expect(response.ok && response.result.problems.some((item) =>
        item.code === "missing-gmail-coverage"), "missing-coverage-certified");
      return;
    }
    case "soak-coverage-problem-blocks": {
      const row = coveredRow({
        gmailCoverage: { status: "covered", problem: true, reason: "gap" },
      });
      const response = call("health-row-certification", {
        snapshot: { activeAwbs: [row.awb], shipments: [row] },
      });
      expect(response.ok && response.result.problems.some((item) =>
        item.code === "gmail-coverage-problem"), "coverage-problem-certified");
      return;
    }
    case "soak-email-phase-requires-source-fact": {
      const row = coveredRow({ stage: "release-needed" });
      const response = call("health-row-certification", {
        snapshot: { activeAwbs: [row.awb], shipments: [row] },
      });
      expect(response.ok && response.result.problems.some((item) =>
        item.code === "missing-gmail-source-fact"), "email-phase-without-email-certified");
      return;
    }
    case "soak-coherence-contradiction-blocks": {
      const row = coveredRow({
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
      const response = call("health-row-certification", {
        snapshot: { activeAwbs: [row.awb], shipments: [row] },
      });
      expect(response.ok && response.result.problems.some((item) =>
        item.code === "internal-truth-conflict"), "contradiction-certified");
      return;
    }
    case "soak-stale-embedded-tms-blocks": {
      const response = call("health-tms-inventory", {
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
      });
      expect(response.ok && response.result.ok === false, "stale-embedded-tms-certified");
      return;
    }
    case "soak-refresh-success-marker-required": {
      const response = call("health-verified-freshness", {
        refreshHealthRow: {
          writer_version: "gmail-refresh+status-failed+truthsig-abcdef",
          snapshot_time: "2026-07-24T10:00:00.000Z",
        },
        storedTruthSignature: `abcdef${"0".repeat(58)}`,
        truthSnapshotTime: "2026-07-24T09:00:00.000Z",
      });
      expect(response.ok && response.result.verifiedAt === null, "failed-refresh-certified-fresh");
      return;
    }
    case "soak-false-gate-remains-unknown": {
      const response = call("compact-semantics", {
        snapshot: {
          activeAwbs: ["01480000010"],
          completedAwbs: [],
          shipments: [{
            awb: "014-80000010",
            truthPacketRole: "active",
            truthPacket: { gates: { delivery: { status: false } } },
          }],
        },
      });
      expect(
        response.ok &&
        response.result.shipments[0].gates.delivery === "unknown",
        "false-gate-promoted",
      );
      return;
    }
    default:
      throw Object.assign(new Error(`Unknown soak probe ${checkId}`), {
        code: "TRUTH_MUTANT_PROBE_UNKNOWN",
      });
  }
}

function main() {
  const sourcePath = process.argv[2];
  const originalRelativePath = process.argv[3];
  const repoRoot = process.argv[4];
  const checkId = process.argv[5];
  if (!sourcePath || !originalRelativePath || !repoRoot || !checkId) {
    process.exitCode = 64;
    return;
  }
  const metaMode = process.env.PIKIIO_TRUTH_MUTANT_META_MODE || "";
  if (metaMode === "crash") {
    process.exitCode = 7;
    return;
  }
  if (metaMode === "timeout") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    process.exitCode = 8;
    return;
  }
  if (metaMode === "wrong-fingerprint") {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: "assertion_failed",
      checkId,
      fingerprint: "deliberately-wrong-fingerprint",
    })}\n`);
    process.exitCode = 1;
    return;
  }
  try {
    if (checkId.startsWith("liveness-")) {
      runLivenessCheck(sourcePath, originalRelativePath, checkId);
    } else if (checkId.startsWith("soak-")) {
      runSoakCheck(sourcePath, originalRelativePath, checkId);
    } else {
      throw Object.assign(new Error(`Unknown truth mutant check ${checkId}`), {
        code: "TRUTH_MUTANT_PROBE_UNKNOWN",
      });
    }
    process.stdout.write(`${JSON.stringify({ ok: true, checkId })}\n`);
  } catch (error) {
    if (error instanceof ProbeAssertion) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        reason: "assertion_failed",
        checkId,
        fingerprint: error.fingerprint,
        details: error.details,
      })}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: "probe_error",
      checkId,
      code: String(error?.code || "TRUTH_MUTANT_PROBE_ERROR"),
      error: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = error?.code === "TRUTH_MUTANT_PROBE_UNKNOWN" ? 64 : 2;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({
  CHILD_PATH,
  DEFAULT_TIMEOUT_MS,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  ProductChildProtocolError,
  parseChildResponse,
  runHostileProductFixture,
  runProductChild,
  validateJsonValue,
});

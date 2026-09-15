#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_RELATIVE_PATH = path.join(
  "YLYI",
  "07_Backtest_Cases",
  "pikiio-action-proof-fixture-manifest.json",
);
const PROFILE_SPECS = Object.freeze({
  "ACTION-01": Object.freeze({
    featurePath: "tests/features/pikiio-claim-native-planner.feature",
    featureSha256:
      "81b349a054a0e808fc90853db0c2d6947a62085d74e77cca10d63160a4d2e204",
    modulePath: "lib/action-planner.js",
    exportName: "buildClaimNativeActionPlan",
  }),
  "ACTION-02": Object.freeze({
    featurePath: "tests/features/pikiio-action-shadow.feature",
    featureSha256:
      "34c539ac7ef6aa0a692e836a454bfafa9e92823c7220a9d6f4f48c3d63c2ddca",
    modulePath: "lib/action-shadow.js",
    exportName: "evaluateActionShadowBatch",
  }),
  "ACTION-03": Object.freeze({
    featurePath: "tests/features/pikiio-pod-proposal.feature",
    featureSha256:
      "983fd7f759e5feac29671e0aca1507be8fb72acb4a2cb88578742b15a3f3e0c0",
    modulePath: "lib/action-pod-proposal.js",
    exportName: "buildPodProposalProjection",
  }),
});
const PROFILE_IDS = Object.freeze(Object.keys(PROFILE_SPECS));
const DOMAIN_ACCEPTANCE_POPULATION = 65;
const GHERKIN_SCENARIO_POPULATION = 15;
const PRODUCT_CHILD_INPUT_LIMIT_BYTES = 256 * 1024;
const PRODUCT_CHILD_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const PRODUCT_CHILD_TIMEOUT_MS = 10_000;
const ZERO_EFFECTS = Object.freeze({
  actionQueueWrites: 0,
  draftQueueWrites: 0,
  sendQueueWrites: 0,
  gmailApiCalls: 0,
  tmsWrites: 0,
  truthWrites: 0,
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertProfileId(profile) {
  if (!PROFILE_SPECS[profile]) {
    const error = new Error(
      `Unknown action proof profile ${JSON.stringify(profile)}; expected one of ${PROFILE_IDS.join(", ")}`,
    );
    error.code = "PIKIIO_ACTION_PROOF_PROFILE_UNKNOWN";
    throw error;
  }
  return profile;
}

function assertFrozenFixtureManifest(root = ROOT) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, MANIFEST_RELATIVE_PATH), "utf8"),
  );
  assert.equal(
    manifest.schema,
    "pikiio-action-proof-fixture-manifest-v1",
    "fixture manifest schema drifted",
  );
  const entries = [manifest.corpus, ...(manifest.fixtures || [])];
  for (const entry of entries) {
    const bytes = fs.readFileSync(path.join(root, entry.path));
    assert.equal(bytes.length, entry.byteLength, `${entry.path}: byte length drift`);
    assert.equal(sha256(bytes), entry.sha256, `${entry.path}: sha256 drift`);
  }
  const corpus = JSON.parse(
    fs.readFileSync(path.join(root, manifest.corpus.path), "utf8"),
  );
  const ids = (corpus.cases || []).map((row) => row.caseId);
  assert.equal(ids.length, manifest.corpus.caseCount, "action corpus count drift");
  assert.deepEqual(
    ids,
    manifest.corpus.orderedCaseIds,
    "action corpus order or identity drift",
  );
  assert.equal(new Set(ids).size, ids.length, "action corpus contains duplicate IDs");
  for (const fixture of manifest.fixtures) {
    const row = corpus.cases.find((candidate) => candidate.caseId === fixture.caseId);
    assert.ok(row, `${fixture.caseId}: case missing from corpus`);
    assert.equal(
      path.basename(fixture.path),
      row.fixtureFile,
      `${fixture.caseId}: fixture binding drift`,
    );
    assert.equal(
      Date.parse(row.frozenAt),
      Date.parse(fixture.frozenAt),
      `${fixture.caseId}: frozen clock drift`,
    );
    const packet = JSON.parse(
      fs.readFileSync(path.join(root, fixture.path), "utf8"),
    );
    assert.match(
      String(packet.__fixture?.evidencePoint || ""),
      new RegExp(
        fixture.requiredEvidencePoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      ),
      `${fixture.caseId}: evidence point drift`,
    );
    if (fixture.forbiddenInterpretation === "pod_received") {
      const podGate = (packet.truthPacket?.gates || packet.gates || []).find(
        (gate) => gate.gate === "pod",
      );
      assert.ok(podGate, `${fixture.caseId}: POD gate missing`);
      assert.notEqual(
        String(podGate.status || podGate.rawStatus || "").toLowerCase(),
        "received",
        `${fixture.caseId}: POD promise became a received gate`,
      );
      assert.match(
        String(packet.currentState || packet.opsState?.summary || ""),
        /POD pending/i,
        `${fixture.caseId}: coherent fixture no longer renders POD pending`,
      );
      assert.match(
        String(packet.__fixture?.evidencePoint || ""),
        /POD NOT received/i,
        `${fixture.caseId}: fixture lost explicit not-received evidence point`,
      );
    }
  }
  return { manifest, corpus };
}

function parseFeature(source) {
  const scenarios = [];
  let featureCount = 0;
  let current = null;
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("Feature:")) {
      featureCount += 1;
      continue;
    }
    if (line.startsWith("Scenario:")) {
      current = {
        name: line.slice("Scenario:".length).trim(),
        steps: [],
      };
      assert.ok(current.name, "Gherkin scenario name must be non-empty");
      scenarios.push(current);
      continue;
    }
    if (/^(Given|When|Then|And|But)\s+/.test(line)) {
      assert.ok(current, `Gherkin step appears before Scenario: ${line}`);
      current.steps.push(line);
      continue;
    }
    assert.fail(`Unknown or unsupported Gherkin syntax: ${line}`);
  }
  assert.equal(featureCount, 1, "feature file must contain exactly one Feature");
  return scenarios;
}

function assertFeatureContract(profile, sourceOverride) {
  assertProfileId(profile);
  const spec = PROFILE_SPECS[profile];
  const source =
    sourceOverride === undefined
      ? fs.readFileSync(path.join(ROOT, spec.featurePath), "utf8")
      : String(sourceOverride);
  assert.equal(
    sha256(source),
    spec.featureSha256,
    `${profile}: feature bytes changed; unknown, reordered, weakened, or added steps are forbidden`,
  );
  const scenarios = parseFeature(source);
  assert.equal(
    scenarios.length,
    GHERKIN_SCENARIO_POPULATION,
    `${profile}: exact Gherkin population changed`,
  );
  assert.equal(
    new Set(scenarios.map((row) => row.name)).size,
    scenarios.length,
    `${profile}: duplicate Gherkin scenario`,
  );
  for (const scenario of scenarios) {
    assert.equal(
      scenario.steps.length,
      3,
      `${profile}/${scenario.name}: scenario must have exact Given/When/Then steps`,
    );
    assert.match(scenario.steps[0], /^Given /);
    assert.match(scenario.steps[1], /^When /);
    assert.match(scenario.steps[2], /^Then /);
  }
  return scenarios;
}

function acceptedClaim(id, type, fields = {}) {
  return {
    claimVersionId: id,
    type,
    status: "accepted",
    ...fields,
  };
}

function action01Input(id, options = {}) {
  const safeId = String(id).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const deliveryStatus = options.deliveryStatus || "confirmed";
  const podStatus = options.podStatus || "pending";
  const claims = [];
  if (options.originComplete) {
    claims.push(
      acceptedClaim(`${safeId}:origin-pickup`, "pickup_completed", {
        leg: "origin",
        polarity: "completed",
      }),
    );
  }
  if (deliveryStatus === "scheduled") {
    claims.push(
      acceptedClaim(`${safeId}:delivery-scheduled`, "delivery_scheduled", {
        leg: "destination",
        polarity: "scheduled",
      }),
    );
  } else if (deliveryStatus === "confirmed") {
    claims.push(
      acceptedClaim(`${safeId}:delivery-confirmed`, "delivery_confirmed", {
        leg: "destination",
        polarity: "completed",
      }),
    );
  } else if (deliveryStatus === "unknown-polarity") {
    claims.push(
      acceptedClaim(`${safeId}:delivery-unknown`, "delivery_event", {
        leg: "destination",
        polarity: "unknown",
      }),
    );
  }
  if (podStatus === "received") {
    claims.push(
      acceptedClaim(`${safeId}:pod-received`, "pod_received", {
        leg: "destination",
        polarity: "completed",
      }),
    );
  } else {
    claims.push(
      acceptedClaim(`${safeId}:pod-pending`, "pod_pending", {
        leg: "destination",
        polarity: "open",
      }),
    );
  }
  if (options.owner !== false) {
    claims.push(
      acceptedClaim(`${safeId}:delivery-owner`, "leg_owner", {
        leg: "destination",
        role: "delivery-agent",
        email: options.ownerEmail || `${safeId}@delivery.example`,
        threadId: options.ownerThread || `${safeId}:thread`,
      }),
    );
  }
  if (options.promise) {
    claims.push(
      acceptedClaim(`${safeId}:pod-promise`, "commitment_made", {
        leg: "destination",
        subject: "pod",
        polarity: "future",
        promisedAt: "2026-07-21T20:59:49.000Z",
        courtesyUntil: options.promiseFresh
          ? "2026-07-22T13:00:00.000Z"
          : "2026-07-21T21:00:00.000Z",
      }),
    );
  }
  return {
    schema: "relational-shipment-truth-packet-v3-commercial-conversation",
    shipmentId: `shipment:${safeId}`,
    awb: options.awb || `000-${String(id).replace(/\D/g, "").padStart(8, "0").slice(-8)}`,
    currentState:
      deliveryStatus === "confirmed" ? "delivered" : "destination_delivery_open",
    truthPacketRole:
      deliveryStatus === "confirmed" && podStatus === "received"
        ? "completed"
        : "active",
    gates: {
      delivery: {
        status: deliveryStatus,
        claimVersionIds: claims
          .filter((row) => row.type.startsWith("delivery_"))
          .map((row) => row.claimVersionId),
      },
      pod: {
        status: podStatus,
        claimVersionIds: claims
          .filter((row) => row.type.startsWith("pod_") || row.subject === "pod")
          .map((row) => row.claimVersionId),
      },
    },
    acceptedClaims: claims,
    acceptedClaimIds: claims.map((row) => row.claimVersionId),
    rawSummary: options.rawSummary || "",
    rawThreadRecipientList: options.rawRecipients || [],
    evaluationClock: options.now || "2026-07-22T12:00:00.000Z",
    plannerMode: "default-off",
    expectedDecisionOverride: options.expectedDecision,
    expectedFamily: options.expectedFamily || "pod-followup",
  };
}

function oracleAction01(input) {
  const delivery = input.gates.delivery.status;
  const pod = input.gates.pod.status;
  const owner = input.acceptedClaims.find(
    (claim) => claim.type === "leg_owner" && claim.leg === "destination",
  );
  const promise = input.acceptedClaims.find(
    (claim) => claim.type === "commitment_made" && claim.subject === "pod",
  );
  const unsupported = delivery === "unknown-polarity";
  const promiseFresh =
    promise &&
    Date.parse(input.evaluationClock) <= Date.parse(promise.courtesyUntil);
  let decision;
  let reason;
  if (input.expectedDecisionOverride) {
    decision = input.expectedDecisionOverride;
    reason =
      decision === "wait" && promiseFresh
        ? "Frozen corpus expectation waits for the fresh POD promise after unloading."
        : `Frozen corpus expectation requires ${decision}.`;
  } else if (unsupported) {
    decision = "blocked";
    reason = "Unsupported delivery claim polarity; accepted completion claim required.";
  } else if (pod === "received") {
    decision = "completed";
    reason = "Accepted POD receipt closes the POD obligation.";
  } else if (delivery !== "confirmed") {
    decision = "wait";
    reason = "Destination delivery is scheduled, not completed.";
  } else if (!owner) {
    decision = "blocked";
    reason = "Missing accepted destination leg-owner claim.";
  } else if (promiseFresh) {
    decision = "wait";
    reason = "Wait for the fresh POD promise after unloading.";
  } else {
    decision = "act";
    reason = "Delivery is confirmed, POD remains open, and the courtesy window expired.";
  }
  const basedOn = input.acceptedClaimIds.filter((claimId) => {
    if (decision === "act") return /delivery-confirmed|pod-pending|delivery-owner/.test(claimId);
    if (promiseFresh) return /delivery-confirmed|pod-pending|pod-promise/.test(claimId);
    if (decision === "blocked") return /delivery|pod-pending/.test(claimId);
    if (decision === "completed") return /pod-received/.test(claimId);
    return /delivery|pod-pending/.test(claimId);
  });
  const actionId = `pikiio:${sha256(
    stableJson({
      shipmentId: input.shipmentId,
      decision,
      family: input.expectedFamily,
      basedOn,
      clock: input.evaluationClock,
    }),
  ).slice(0, 32)}`;
  return {
    schema: "pikiio-claim-native-action-plan-v1",
    plannerVersion: "relational-action-planner-v1",
    decision,
    actionFamily: decision === "act" ? input.expectedFamily : "none",
    actionId,
    actionable: input.gates.pod.status !== "received",
    podStatus: input.gates.pod.status,
    basedOnClaimVersionIds: basedOn,
    counterpartyResolution:
      decision === "act" && owner
        ? {
            claimVersionId: owner.claimVersionId,
            role: owner.role,
            email: owner.email,
            threadId: owner.threadId,
          }
        : null,
    waitCondition: decision === "wait" || decision === "blocked" ? reason : "",
    reason,
    execution: "proposal_only",
    productionEnabled: false,
    effects: clone(ZERO_EFFECTS),
  };
}

function validateAction01(input, output, repeated, expected = {}) {
  assert.equal(output?.schema, "pikiio-claim-native-action-plan-v1");
  assert.equal(output?.plannerVersion, "relational-action-planner-v1");
  assert.ok(
    ["wait", "act", "blocked", "completed"].includes(output?.decision),
    "decision must be an exact claim-native cohort",
  );
  if (expected.decision) assert.equal(output.decision, expected.decision);
  assert.equal(output.productionEnabled, false, "claim-native mode must remain default-off");
  assert.equal(output.execution, "proposal_only", "ACTION-01 may only propose");
  assert.deepEqual(output.effects, ZERO_EFFECTS, "ACTION-01 changed an external queue");
  assert.ok(
    Array.isArray(output.basedOnClaimVersionIds) &&
      output.basedOnClaimVersionIds.length > 0,
    "decision must cite accepted claim versions",
  );
  for (const claimId of output.basedOnClaimVersionIds) {
    assert.ok(
      input.acceptedClaimIds.includes(claimId),
      `planner cited unaccepted claim ${claimId}`,
    );
  }
  if (input.gates.delivery.status === "scheduled") {
    assert.notEqual(output.decision, "act", "scheduled delivery armed POD action");
  }
  if (
    input.acceptedClaims.some((claim) => claim.type === "pickup_completed" && claim.leg === "origin") &&
    !input.acceptedClaims.some((claim) => claim.type === "delivery_confirmed")
  ) {
    assert.notEqual(output.decision, "act", "origin pickup satisfied destination delivery");
  }
  const promise = input.acceptedClaims.find(
    (claim) => claim.type === "commitment_made" && claim.subject === "pod",
  );
  if (promise) {
    assert.notEqual(output.podStatus, "received", "POD promise became POD receipt");
    if (Date.parse(input.evaluationClock) <= Date.parse(promise.courtesyUntil)) {
      assert.equal(output.decision, "wait", "fresh POD promise did not suppress chase");
      assert.match(`${output.waitCondition} ${output.reason}`, /POD/i);
      assert.ok(
        output.basedOnClaimVersionIds.includes(promise.claimVersionId),
        "fresh promise wait omitted its commitment claim",
      );
    }
  }
  if (input.gates.pod.status !== "received") {
    assert.equal(output.actionable, true, "open POD obligation hidden by terminal lifecycle");
  }
  if (output.decision === "act") {
    const owner = input.acceptedClaims.find(
      (claim) => claim.type === "leg_owner" && claim.leg === "destination",
    );
    assert.ok(owner, "planner acted without accepted destination leg owner");
    assert.equal(output.counterpartyResolution?.claimVersionId, owner.claimVersionId);
    assert.equal(output.counterpartyResolution?.email, owner.email);
    assert.equal(output.counterpartyResolution?.threadId, owner.threadId);
    assert.ok(
      !input.rawThreadRecipientList.includes(output.counterpartyResolution?.email) ||
        output.counterpartyResolution.claimVersionId === owner.claimVersionId,
      "recipient-list fallback replaced owner provenance",
    );
  }
  if (
    !input.acceptedClaims.some(
      (claim) => claim.type === "leg_owner" && claim.leg === "destination",
    ) &&
    input.gates.delivery.status === "confirmed" &&
    input.gates.pod.status !== "received"
  ) {
    assert.equal(output.decision, "blocked");
    assert.match(`${output.waitCondition} ${output.reason}`, /missing.*owner.*claim/i);
    assert.equal(output.counterpartyResolution, null);
  }
  assert.deepEqual(repeated, output, "identical planner inputs are nondeterministic");
  assert.match(String(output.actionId || ""), /^pikiio:[a-f0-9]{32}$/);
  return true;
}

function corpusAction01Cases() {
  const { corpus } = assertFrozenFixtureManifest();
  return corpus.cases.map((row) => {
    const expected = row.humanExpected || {};
    const decision =
      expected.decision === "confirm" ? "blocked" : expected.decision || "wait";
    const recipient =
      expected.to?.[0] || expected.acceptableTo?.[0] || `${row.caseId.toLowerCase()}@delivery.example`;
    const threadId = expected.thread?.threadId || `${row.caseId.toLowerCase()}:thread`;
    const input = action01Input(`corpus-${row.caseId}`, {
      deliveryStatus: decision === "act" ? "confirmed" : "scheduled",
      promise: row.caseId === "AB-027",
      promiseFresh: row.caseId === "AB-027",
      owner: decision !== "blocked",
      ownerEmail: recipient,
      ownerThread: threadId,
      expectedDecision: decision,
      expectedFamily: expected.actionType === "none" ? "pod-followup" : expected.actionType,
      rawRecipients: expected.mustNotSendTo || [],
      now: row.frozenAt || "2026-07-04T17:00:00.000Z",
    });
    return {
      id: `corpus-${row.caseId}`,
      domain: "frozen-action-corpus",
      input,
      expected: { decision },
    };
  });
}

const ACTION01_INVARIANTS = Object.freeze([
  ["scheduled-never-delivered", { deliveryStatus: "scheduled" }, "wait"],
  ["origin-pickup-separated", { deliveryStatus: "scheduled", originComplete: true }, "wait"],
  ["promise-not-receipt", { promise: true, promiseFresh: true }, "wait"],
  ["fresh-promise-wait", { promise: true, promiseFresh: true }, "wait"],
  ["expired-promise-act", { promise: true, promiseFresh: false }, "act"],
  ["terminal-open-pod-actionable", {}, "act"],
  ["owner-resolves-recipient", {}, "act"],
  ["missing-owner-blocked", { owner: false }, "blocked"],
  ["roster-no-fallback", { owner: false, rawRecipients: ["client@example.com"] }, "blocked"],
  ["client-never-owner", { ownerEmail: "delivery@example.com", rawRecipients: ["client@example.com"] }, "act"],
  ["accepted-claim-citations", {}, "act"],
  ["deterministic-identifiers", {}, "act"],
  ["default-off-zero-writes", {}, "act"],
  ["raw-summary-ignored", { deliveryStatus: "scheduled", rawSummary: "POD RECEIVED" }, "wait"],
  ["unknown-polarity-blocked", { deliveryStatus: "unknown-polarity" }, "blocked"],
  ["pod-received-completed", { podStatus: "received" }, "completed"],
  ["scheduled-with-owner-wait", { deliveryStatus: "scheduled", owner: true }, "wait"],
  ["scheduled-with-client-roster-wait", { deliveryStatus: "scheduled", rawRecipients: ["itay@example.com"] }, "wait"],
  ["origin-complete-no-destination-owner", { deliveryStatus: "scheduled", originComplete: true, owner: false }, "wait"],
  ["promise-with-client-roster-wait", { promise: true, promiseFresh: true, rawRecipients: ["client@example.com"] }, "wait"],
  ["expired-promise-needs-owner", { promise: true, promiseFresh: false, owner: false }, "blocked"],
  ["received-without-owner-completed", { podStatus: "received", owner: false }, "completed"],
  ["delivered-open-role-active", {}, "act"],
  ["promise-cites-exact-claim", { promise: true, promiseFresh: true }, "wait"],
  ["owner-thread-provenance", { ownerThread: "accepted-owner-thread" }, "act"],
  ["owner-email-provenance", { ownerEmail: "owner@delivery.example" }, "act"],
  ["no-gmail-draft-effect", {}, "act"],
  ["no-send-effect", {}, "act"],
  ["no-tms-effect", {}, "act"],
  ["no-truth-write-effect", {}, "act"],
  ["unsupported-polarity-named", { deliveryStatus: "unknown-polarity" }, "blocked"],
  ["fresh-promise-reason-named", { promise: true, promiseFresh: true }, "wait"],
  ["completed-not-actionable", { podStatus: "received" }, "completed"],
  ["action-family-pod-only", { expectedFamily: "pod-followup" }, "act"],
  ["accepted-claim-subset", {}, "act"],
  ["repeat-full-output-parity", {}, "act"],
  ["promise-after-unloading", { promise: true, promiseFresh: true }, "wait"],
  ["expired-window-proposal-only", { promise: true, promiseFresh: false }, "act"],
]);

function action01AcceptanceCases() {
  const invariantCases = ACTION01_INVARIANTS.map(([id, options, decision], index) => ({
    id: `invariant-${String(index + 1).padStart(2, "0")}-${id}`,
    domain: "claim-native-invariant",
    input: action01Input(`invariant-${index + 1}-${id}`, options),
    expected: { decision },
  }));
  const cases = [...corpusAction01Cases(), ...invariantCases];
  assert.equal(cases.length, DOMAIN_ACCEPTANCE_POPULATION);
  return cases;
}

function shadowInput(id, options = {}) {
  const { corpus } = assertFrozenFixtureManifest();
  const comparisons = corpus.cases.map((row, index) => ({
    caseId: row.caseId,
    decision: ["wait", "act", "blocked", "completed"][index % 4],
    actionId: `shadow:${sha256(row.caseId).slice(0, 24)}`,
    basedOnClaimVersionIds: [`${row.caseId.toLowerCase()}:accepted`],
    recipient: `${row.caseId.toLowerCase()}@delivery.example`,
    threadId: `${row.caseId.toLowerCase()}:thread`,
  }));
  const snapshots = {
    actionQueue: sha256("frozen-action-queue"),
    draftQueue: sha256("frozen-draft-queue"),
    sendQueue: sha256("frozen-send-queue"),
  };
  return {
    schema: "pikiio-action-shadow-input-v1",
    id,
    sourceCutId: "source-cut:fixture",
    plannerVersion: "relational-action-planner-v1",
    comparisons,
    beforeHashes: snapshots,
    injectedFinding: options.injectedFinding || null,
    duplicateCaseId: options.duplicateCaseId || null,
  };
}

function oracleAction02(input) {
  const comparisons = clone(input.comparisons);
  if (input.duplicateCaseId) {
    comparisons.push(
      clone(comparisons.find((row) => row.caseId === input.duplicateCaseId)),
    );
  }
  const findings = input.injectedFinding
    ? [{ code: input.injectedFinding, severity: "hard" }]
    : [];
  const cohorts = Object.fromEntries(
    ["wait", "act", "blocked", "completed"].map((decision) => [
      decision,
      comparisons
        .filter((row) => row.decision === decision)
        .map((row) => row.caseId),
    ]),
  );
  const body = {
    schema: "pikiio-action-shadow-receipt-v1",
    status: findings.length ? "failed" : "passed",
    sourceCutId: input.sourceCutId,
    plannerVersion: input.plannerVersion,
    beforeHashes: clone(input.beforeHashes),
    afterHashes: clone(input.beforeHashes),
    effects: clone(ZERO_EFFECTS),
    comparisons,
    cohorts,
    findings,
    writeSurface: "dedicated-action-shadow-audit",
  };
  return { ...body, receiptHash: sha256(stableJson(body)) };
}

function validateAction02(input, output, repeated, expected = {}) {
  assert.equal(output?.schema, "pikiio-action-shadow-receipt-v1");
  assert.equal(output.writeSurface, "dedicated-action-shadow-audit");
  assert.deepEqual(output.beforeHashes, input.beforeHashes);
  assert.deepEqual(output.afterHashes, input.beforeHashes);
  assert.deepEqual(output.effects, ZERO_EFFECTS);
  const ids = output.comparisons.map((row) => row.caseId);
  if (!input.duplicateCaseId) {
    assert.equal(ids.length, 27, "shadow receipt population must equal frozen corpus");
    assert.equal(new Set(ids).size, 27, "shadow receipt duplicated a corpus case");
  }
  if (expected.caseId) {
    assert.equal(
      ids.filter((id) => id === expected.caseId).length,
      1,
      `${expected.caseId}: must have exactly one shadow receipt`,
    );
  }
  for (const row of output.comparisons) {
    assert.ok(row.actionId, `${row.caseId}: missing deterministic action id`);
    assert.ok(
      Array.isArray(row.basedOnClaimVersionIds) &&
        row.basedOnClaimVersionIds.length > 0,
      `${row.caseId}: accepted claim provenance missing`,
    );
  }
  for (const decision of ["wait", "act", "blocked", "completed"]) {
    const expectedMembers = output.comparisons
      .filter((row) => row.decision === decision)
      .map((row) => row.caseId);
    assert.deepEqual(output.cohorts[decision], expectedMembers);
  }
  assert.deepEqual(
    Object.keys(output.cohorts).sort(),
    ["act", "blocked", "completed", "wait"],
    "shadow receipt admitted an unknown or omitted decision cohort",
  );
  if (input.injectedFinding) {
    assert.equal(output.status, "failed");
    assert.ok(
      output.findings.some((row) => row.code === input.injectedFinding),
      `shadow grader omitted ${input.injectedFinding}`,
    );
  } else if (!input.duplicateCaseId) {
    assert.equal(output.status, "passed");
    assert.deepEqual(output.findings, []);
  }
  const unsigned = clone(output);
  delete unsigned.receiptHash;
  assert.equal(output.receiptHash, sha256(stableJson(unsigned)));
  assert.deepEqual(repeated, output, "shadow receipt is nondeterministic");
  return true;
}

const ACTION02_INVARIANTS = Object.freeze([
  ["action-queue-byte-parity", {}],
  ["draft-queue-byte-parity", {}],
  ["send-queue-byte-parity", {}],
  ["exact-corpus-receipts", {}],
  ["claim-provenance-preserved", {}],
  ["wait-cohort-exact", {}],
  ["act-cohort-exact", {}],
  ["blocked-cohort-exact", {}],
  ["completed-cohort-exact", {}],
  ["unsafe-recipient-fails", { injectedFinding: "UNSAFE_RECIPIENT" }],
  ["unsafe-thread-fails", { injectedFinding: "UNSAFE_THREAD" }],
  ["unsafe-timing-fails", { injectedFinding: "UNSAFE_TIMING" }],
  ["unsafe-wording-fails", { injectedFinding: "UNSAFE_WORDING" }],
  ["duplicate-action-fails", { injectedFinding: "DUPLICATE_ACTION" }],
  ["receipt-deterministic", {}],
  ["zero-gmail-api-calls", {}],
  ["zero-tms-writes", {}],
  ["zero-truth-writes", {}],
  ["audit-surface-only", {}],
  ["source-cut-bound", {}],
  ["planner-version-bound", {}],
  ["action-id-present", {}],
  ["comparison-order-stable", {}],
  ["no-skipped-case", {}],
  ["no-unknown-cohort", {}],
  ["recipient-owner-finding", { injectedFinding: "OWNER_PROVENANCE_MISSING" }],
  ["thread-owner-finding", { injectedFinding: "THREAD_PROVENANCE_MISSING" }],
  ["promise-window-finding", { injectedFinding: "PROMISE_WINDOW_VIOLATION" }],
  ["pod-promise-wording-finding", { injectedFinding: "POD_PROMISE_AS_RECEIVED" }],
  ["duplicate-case-finding", { injectedFinding: "DUPLICATE_CASE_RECEIPT" }],
  ["missing-claim-finding", { injectedFinding: "MISSING_ACCEPTED_CLAIMS" }],
  ["fabricated-claim-finding", { injectedFinding: "UNACCEPTED_CLAIM_REFERENCE" }],
  ["non-audit-write-finding", { injectedFinding: "NON_AUDIT_WRITE" }],
  ["queue-drift-finding", { injectedFinding: "QUEUE_HASH_DRIFT" }],
  ["external-effect-finding", { injectedFinding: "EXTERNAL_EFFECT" }],
  ["case-population-finding", { injectedFinding: "CORPUS_POPULATION_MISMATCH" }],
  ["cohort-population-finding", { injectedFinding: "COHORT_POPULATION_MISMATCH" }],
  ["comparison-hash-bound", {}],
]);

function action02AcceptanceCases() {
  const { corpus } = assertFrozenFixtureManifest();
  const corpusCases = corpus.cases.map((row) => ({
    id: `corpus-${row.caseId}`,
    domain: "shadow-corpus-receipt",
    input: shadowInput(`corpus-${row.caseId}`),
    expected: { caseId: row.caseId },
  }));
  const invariantCases = ACTION02_INVARIANTS.map(([id, options], index) => ({
    id: `invariant-${String(index + 1).padStart(2, "0")}-${id}`,
    domain: "action-shadow-invariant",
    input: shadowInput(`invariant-${index + 1}-${id}`, options),
    expected: {},
  }));
  const cases = [...corpusCases, ...invariantCases];
  assert.equal(cases.length, DOMAIN_ACCEPTANCE_POPULATION);
  return cases;
}

function proposalInput(id, options = {}) {
  const plan = oracleAction01(
    action01Input(`proposal-${id}`, {
      promise: options.promise !== false,
      promiseFresh: options.promiseFresh === true,
      owner: options.owner !== false,
      ownerEmail: options.ownerEmail || `${id}@delivery.example`,
      ownerThread: options.ownerThread || `${id}:thread`,
      podStatus: options.podStatus || "pending",
      now: options.promiseFresh
        ? "2026-07-22T12:00:00.000Z"
        : "2026-07-22T15:00:00.000Z",
    }),
  );
  if (options.forceFamily) plan.actionFamily = options.forceFamily;
  return {
    schema: "pikiio-pod-proposal-input-v1",
    id,
    flagEnabled: options.flagEnabled !== false,
    baselineSurface: {
      schema: "pikiio-operator-shipment-v1",
      shipmentId: `shipment:${id}`,
      proposals: [],
    },
    plan,
    acceptedClaimIds: [...plan.basedOnClaimVersionIds],
    dismissRequested: options.dismissRequested === true,
    truthPacketHash: sha256(`truth:${id}`),
  };
}

function oracleAction03(input) {
  const eligible =
    input.flagEnabled &&
    input.plan.decision === "act" &&
    input.plan.actionFamily === "pod-followup";
  const proposal = eligible
    ? {
        id: input.plan.actionId,
        family: "pod-followup",
        status: "POD pending",
        recipient: input.plan.counterpartyResolution?.email || "",
        threadId: input.plan.counterpartyResolution?.threadId || "",
        reason: input.plan.reason,
        courtesyWindow: "expired",
        waitCondition: "Wait for signed POD evidence after the proposal is reviewed.",
        basedOnClaimVersionIds: [...input.plan.basedOnClaimVersionIds],
        execution: "inspect_only",
      }
    : null;
  const api = { proposal: clone(proposal) };
  const viewModel = { proposal: clone(proposal) };
  return {
    schema: "pikiio-pod-proposal-projection-v1",
    flagEnabled: input.flagEnabled,
    api,
    viewModel,
    operatorSurface: proposal
      ? { ...clone(input.baselineSurface), proposals: [clone(proposal)] }
      : clone(input.baselineSurface),
    baselineSurfaceHash: sha256(stableJson(input.baselineSurface)),
    flagOffSurfaceHash: sha256(stableJson(input.baselineSurface)),
    truthPacketHashBefore: input.truthPacketHash,
    truthPacketHashAfter: input.truthPacketHash,
    effects: clone(ZERO_EFFECTS),
    interactions: {
      rendered: Boolean(proposal),
      inspected: Boolean(proposal),
      clickedExecutionControl: false,
      dismissedLocally: input.dismissRequested,
    },
  };
}

function validateAction03(input, output, repeated, expected = {}) {
  assert.equal(output?.schema, "pikiio-pod-proposal-projection-v1");
  assert.deepEqual(output.effects, ZERO_EFFECTS);
  assert.equal(output.interactions?.clickedExecutionControl, false);
  assert.equal(output.truthPacketHashAfter, output.truthPacketHashBefore);
  assert.equal(output.truthPacketHashBefore, input.truthPacketHash);
  const baselineHash = sha256(stableJson(input.baselineSurface));
  assert.equal(output.baselineSurfaceHash, baselineHash);
  assert.equal(output.flagOffSurfaceHash, baselineHash);
  if (!input.flagEnabled) {
    assert.deepEqual(
      output.operatorSurface,
      input.baselineSurface,
      "flag-off surface changed",
    );
    assert.equal(output.api?.proposal, null);
    assert.equal(output.viewModel?.proposal, null);
  } else if (
    input.plan.decision === "act" &&
    input.plan.actionFamily === "pod-followup"
  ) {
    const api = output.api?.proposal;
    const view = output.viewModel?.proposal;
    assert.ok(api && view, "eligible POD proposal is missing");
    assert.deepEqual(view, api, "API/view-model proposal parity failed");
    assert.equal(api.family, "pod-followup");
    assert.equal(api.id, input.plan.actionId);
    assert.equal(api.status, "POD pending");
    assert.doesNotMatch(stableJson(api), /POD received/i);
    assert.deepEqual(api.basedOnClaimVersionIds, input.acceptedClaimIds);
    assert.equal(
      api.recipient,
      input.plan.counterpartyResolution?.email || "",
    );
    assert.equal(
      api.threadId,
      input.plan.counterpartyResolution?.threadId || "",
    );
    assert.equal(api.execution, "inspect_only");
    assert.equal(output.operatorSurface.proposals.length, 1);
  } else {
    assert.equal(output.api?.proposal, null);
    assert.equal(output.viewModel?.proposal, null);
  }
  if (input.dismissRequested) {
    assert.equal(output.interactions.dismissedLocally, true);
    assert.equal(output.truthPacketHashAfter, input.truthPacketHash);
  }
  if (expected.caseId) {
    assert.ok(expected.caseId.startsWith("AB-"));
  }
  assert.deepEqual(repeated, output, "POD proposal projection is nondeterministic");
  return true;
}

const ACTION03_INVARIANTS = Object.freeze([
  ["flag-off-parity", { flagEnabled: false }],
  ["pod-family-only", {}],
  ["api-view-id-parity", {}],
  ["api-view-evidence-parity", {}],
  ["api-view-recipient-parity", {}],
  ["api-view-thread-parity", {}],
  ["api-view-reason-parity", {}],
  ["api-view-courtesy-parity", {}],
  ["api-view-wait-parity", {}],
  ["no-gmail-draft", {}],
  ["no-gmail-send", {}],
  ["no-tms-freight-mutation", {}],
  ["dismiss-does-not-rewrite-truth", { dismissRequested: true }],
  ["promise-renders-pending", {}],
  ["terminal-open-pod-visible", {}],
  ["flag-default-off-boundary", { flagEnabled: false }],
  ["non-pod-family-hidden", { forceFamily: "customs-followup" }],
  ["completed-pod-hidden", { podStatus: "received" }],
  ["missing-owner-hidden", { owner: false }],
  ["fresh-promise-hidden", { promiseFresh: true }],
  ["accepted-evidence-exact", {}],
  ["owner-recipient-exact", { ownerEmail: "owner@delivery.example" }],
  ["owner-thread-exact", { ownerThread: "accepted-thread" }],
  ["inspect-only-execution", {}],
  ["no-click-control", {}],
  ["zero-action-queue-write", {}],
  ["zero-draft-queue-write", {}],
  ["zero-send-queue-write", {}],
  ["zero-truth-write", {}],
  ["truth-hash-parity", {}],
  ["single-visible-proposal", {}],
  ["deterministic-projection", {}],
  ["proposal-id-from-plan", {}],
  ["proposal-reason-from-plan", {}],
  ["proposal-wait-condition-visible", {}],
  ["courtesy-window-visible", {}],
  ["flag-off-api-null", { flagEnabled: false }],
  ["flag-off-view-null", { flagEnabled: false }],
]);

function action03AcceptanceCases() {
  const { corpus } = assertFrozenFixtureManifest();
  const corpusCases = corpus.cases.map((row) => ({
    id: `corpus-${row.caseId}`,
    domain: "pod-proposal-corpus-projection",
    input: proposalInput(`corpus-${row.caseId}`, {
      flagEnabled: true,
      promise: row.caseId === "AB-027",
      promiseFresh: false,
    }),
    expected: { caseId: row.caseId },
  }));
  const invariantCases = ACTION03_INVARIANTS.map(([id, options], index) => ({
    id: `invariant-${String(index + 1).padStart(2, "0")}-${id}`,
    domain: "pod-proposal-invariant",
    input: proposalInput(`invariant-${index + 1}-${id}`, options),
    expected: {},
  }));
  const cases = [...corpusCases, ...invariantCases];
  assert.equal(cases.length, DOMAIN_ACCEPTANCE_POPULATION);
  return cases;
}

function acceptanceCases(profile) {
  assertProfileId(profile);
  if (profile === "ACTION-01") return action01AcceptanceCases();
  if (profile === "ACTION-02") return action02AcceptanceCases();
  return action03AcceptanceCases();
}

function createOracleAdapter(profile) {
  assertProfileId(profile);
  if (profile === "ACTION-01") {
    return {
      evaluate(input) {
        return oracleAction01(input);
      },
    };
  }
  if (profile === "ACTION-02") {
    return {
      evaluate(input) {
        return oracleAction02(input);
      },
    };
  }
  return {
    evaluate(input) {
      return oracleAction03(input);
    },
  };
}

function loadProductAdapter(profile, root = ROOT, options = {}) {
  assertProfileId(profile);
  const spec = PROFILE_SPECS[profile];
  const absolutePath = path.join(root, spec.modulePath);
  if (!fs.existsSync(absolutePath)) {
    const error = new Error(
      `${profile} acceptance gap: ${spec.modulePath} does not exist`,
    );
    error.code = "PIKIIO_ACTION_PRODUCT_INTERFACE_MISSING";
    throw error;
  }
  if (profile === "ACTION-03") {
    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
    if (
      !appSource.includes("PIKIIO_POD_PROPOSAL_ENABLED") ||
      !appSource.includes("buildPodProposalProjection")
    ) {
      const error = new Error(
        "ACTION-03 acceptance gap: app.js has no server-flagged POD proposal projection binding; extraction is required before acceptance",
      );
      error.code = "PIKIIO_ACTION_UI_BINDING_MISSING";
      throw error;
    }
  }
  return {
    evaluate(input) {
      const request = {
        schema: "pikiio-product-adapter-child-request-v1",
        profile,
        input: clone(input),
      };
      const requestJson = JSON.stringify(request);
      if (Buffer.byteLength(requestJson) > PRODUCT_CHILD_INPUT_LIMIT_BYTES) {
        const error = new Error(
          `${profile}: product adapter input exceeds ${PRODUCT_CHILD_INPUT_LIMIT_BYTES} bytes`,
        );
        error.code = "PIKIIO_ACTION_PRODUCT_CHILD_INPUT_OVERSIZE";
        throw error;
      }
      const spawn = options.spawnSyncFn || spawnSync;
      const child = spawn(
        process.execPath,
        [
          __filename,
          "--product-adapter-child",
          "--profile",
          profile,
          "--root",
          root,
        ],
        {
          cwd: root,
          encoding: "utf8",
          input: requestJson,
          timeout: PRODUCT_CHILD_TIMEOUT_MS,
          maxBuffer: PRODUCT_CHILD_OUTPUT_LIMIT_BYTES,
          env: {
            PATH: process.env.PATH || "",
            NODE_PATH: process.env.NODE_PATH || "",
          },
        },
      );
      return parseProductAdapterChildResult(profile, child);
    },
  };
}

function parseProductAdapterChildResult(profile, child) {
  if (child?.error?.code === "ETIMEDOUT") {
    const error = new Error(`${profile}: product adapter child timed out`);
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_TIMEOUT";
    throw error;
  }
  if (child?.error || child?.signal) {
    const error = new Error(
      `${profile}: product adapter child crashed${
        child.signal ? ` with ${child.signal}` : ""
      }`,
    );
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_CRASHED";
    throw error;
  }
  const stdout = String(child?.stdout || "");
  const stderr = String(child?.stderr || "");
  if (
    Buffer.byteLength(stdout) > PRODUCT_CHILD_OUTPUT_LIMIT_BYTES ||
    Buffer.byteLength(stderr) > PRODUCT_CHILD_OUTPUT_LIMIT_BYTES
  ) {
    const error = new Error(`${profile}: product adapter child output oversized`);
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_OUTPUT_OVERSIZE";
    throw error;
  }
  if (child?.status !== 0 || stderr.trim()) {
    const error = new Error(
      `${profile}: product adapter child failed: ${
        stderr.trim() || `exit ${child?.status}`
      }`,
    );
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_FAILED";
    throw error;
  }
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    const error = new Error(
      `${profile}: product adapter child emitted malformed JSON`,
    );
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_MALFORMED";
    throw error;
  }
  assert.deepEqual(
    Object.keys(envelope || {}).sort(),
    ["ok", "output", "profile", "schema"],
    `${profile}: product adapter child envelope fields drifted`,
  );
  assert.equal(envelope.schema, "pikiio-product-adapter-child-result-v1");
  assert.equal(envelope.profile, profile);
  assert.equal(envelope.ok, true);
  return envelope.output;
}

async function runProductAdapterChild(
  profile,
  root,
  requestJson,
  options = {},
) {
  assertProfileId(profile);
  if (
    !requestJson ||
    Buffer.byteLength(String(requestJson)) > PRODUCT_CHILD_INPUT_LIMIT_BYTES
  ) {
    const error = new Error("product adapter child request is empty or oversized");
    error.code = "PIKIIO_ACTION_PRODUCT_CHILD_REQUEST_INVALID";
    throw error;
  }
  const request = JSON.parse(String(requestJson));
  assert.deepEqual(Object.keys(request).sort(), ["input", "profile", "schema"]);
  assert.equal(request.schema, "pikiio-product-adapter-child-request-v1");
  assert.equal(request.profile, profile);
  const spec = PROFILE_SPECS[profile];
  const absolutePath = path.join(root, spec.modulePath);
  delete require.cache[require.resolve(absolutePath)];
  const moduleValue = (options.requireFn || require)(absolutePath);
  if (typeof moduleValue?.[spec.exportName] !== "function") {
    const error = new Error(
      `${profile} acceptance gap: ${spec.modulePath} must export ${spec.exportName}`,
    );
    error.code = "PIKIIO_ACTION_PRODUCT_INTERFACE_MISSING";
    throw error;
  }
  const output = await moduleValue[spec.exportName](clone(request.input));
  return {
    schema: "pikiio-product-adapter-child-result-v1",
    profile,
    ok: true,
    output,
  };
}

async function runProductAdapterChildCli(
  argv = process.argv.slice(2),
  io = {},
) {
  const safeJsonStringify = JSON.stringify.bind(JSON);
  const safeByteLength = Buffer.byteLength.bind(Buffer);
  const safeStdoutWrite = process.stdout.write.bind(process.stdout);
  const safeStderrWrite = process.stderr.write.bind(process.stderr);
  const profileIndex = argv.indexOf("--profile");
  const rootIndex = argv.indexOf("--root");
  const writeStdout =
    io.writeStdout || ((value) => safeStdoutWrite(String(value)));
  const writeStderr =
    io.writeStderr || ((value) => safeStderrWrite(String(value)));
  const setExitCode =
    io.setExitCode || ((value) => {
      process.exitCode = value;
    });
  try {
    if (profileIndex < 0 || rootIndex < 0) {
      const error = new Error("product child requires --profile and --root");
      error.code = "PIKIIO_ACTION_PRODUCT_CHILD_ARGUMENT_INVALID";
      throw error;
    }
    const readStdin =
      io.readStdin || (() => fs.readFileSync(0, "utf8"));
    const envelope = await runProductAdapterChild(
      argv[profileIndex + 1],
      argv[rootIndex + 1],
      readStdin(),
      io,
    );
    const serialized = safeJsonStringify(envelope);
    if (safeByteLength(serialized) > PRODUCT_CHILD_OUTPUT_LIMIT_BYTES) {
      const error = new Error("product adapter child result oversized");
      error.code = "PIKIIO_ACTION_PRODUCT_CHILD_OUTPUT_OVERSIZE";
      throw error;
    }
    writeStdout(serialized);
    setExitCode(0);
    return { exitCode: 0, envelope };
  } catch (error) {
    const receipt = {
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    };
    writeStderr(safeJsonStringify(receipt));
    setExitCode(2);
    return { exitCode: 2, receipt };
  }
}

async function executeAcceptanceCase(profile, caseRow, adapter) {
  const first = await adapter.evaluate(clone(caseRow.input));
  const repeated = await adapter.evaluate(clone(caseRow.input));
  if (profile === "ACTION-01") {
    return validateAction01(caseRow.input, first, repeated, caseRow.expected);
  }
  if (profile === "ACTION-02") {
    return validateAction02(caseRow.input, first, repeated, caseRow.expected);
  }
  return validateAction03(caseRow.input, first, repeated, caseRow.expected);
}

async function runGherkinProfile(profile, options = {}) {
  assertProfileId(profile);
  assertFrozenFixtureManifest(options.root || ROOT);
  const scenarios = assertFeatureContract(profile);
  const cases = acceptanceCases(profile).slice(27, 27 + scenarios.length);
  assert.equal(cases.length, scenarios.length);
  let adapter = options.adapter || null;
  let adapterGap = null;
  if (!adapter) {
    if (options.product) {
      try {
        adapter = loadProductAdapter(profile, options.root || ROOT);
      } catch (error) {
        adapterGap = error;
        adapter = {
          evaluate() {
            throw adapterGap;
          },
        };
      }
    } else {
      adapter = createOracleAdapter(profile);
    }
  }
  const results = [];
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    const caseRow = cases[index];
    try {
      await executeAcceptanceCase(profile, caseRow, adapter);
      results.push({ scenario: scenario.name, caseId: caseRow.id, status: "passed" });
    } catch (error) {
      results.push({
        scenario: scenario.name,
        caseId: caseRow.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const summary = {
    schema: "pikiio-action-gherkin-result-v1",
    profile,
    mode: options.product ? "product-acceptance" : "harness-self-test",
    scenarios: results.length,
    passed: results.filter((row) => row.status === "passed").length,
    failed: results.filter((row) => row.status === "failed").length,
    skipped: 0,
    undefined: 0,
    ambiguous: 0,
    results,
  };
  if (summary.failed) {
    const error = new Error(
      `${profile}: ${summary.failed}/${summary.scenarios} Gherkin scenarios failed`,
    );
    error.code = "PIKIIO_ACTION_GHERKIN_FAILED";
    error.summary = summary;
    throw error;
  }
  return summary;
}

async function main(argv = process.argv.slice(2)) {
  const selfTest = argv.includes("--self-test");
  const profileIndex = argv.indexOf("--profile");
  if (selfTest && profileIndex >= 0) {
    throw new Error("--self-test and --profile are mutually exclusive");
  }
  if (!selfTest && profileIndex < 0) {
    throw new Error("Use --self-test or --profile ACTION-01|ACTION-02|ACTION-03");
  }
  if (selfTest) {
    const summaries = [];
    for (const profile of PROFILE_IDS) {
      summaries.push(await runGherkinProfile(profile, { product: false }));
    }
    assert.throws(
      () => assertProfileId("ACTION-99"),
      { code: "PIKIIO_ACTION_PROOF_PROFILE_UNKNOWN" },
    );
    const source = fs.readFileSync(
      path.join(ROOT, PROFILE_SPECS["ACTION-01"].featurePath),
      "utf8",
    );
    assert.throws(
      () =>
        assertFeatureContract(
          "ACTION-01",
          source.replace(
            "Given an accepted destination-delivery claim with scheduled polarity",
            "Given an unknown unregistered step",
          ),
        ),
      /feature bytes changed/,
    );
    return {
      schema: "pikiio-action-gherkin-self-test-v1",
      profiles: summaries,
      populationPerProfile: GHERKIN_SCENARIO_POPULATION,
      unknownProfileRejected: true,
      unknownStepRejected: true,
    };
  }
  const profile = argv[profileIndex + 1];
  return runGherkinProfile(assertProfileId(profile), { product: true });
}

async function runCli(argv = process.argv.slice(2), io = {}) {
  const writeStdout =
    io.writeStdout || ((value) => process.stdout.write(String(value)));
  const writeStderr =
    io.writeStderr || ((value) => process.stderr.write(String(value)));
  const setExitCode =
    io.setExitCode || ((value) => {
      process.exitCode = value;
    });
  const mainFn = io.mainFn || main;
  try {
    const summary = await mainFn(argv);
    writeStdout(`${JSON.stringify(summary)}\n`);
    setExitCode(0);
    return { exitCode: 0, summary };
  } catch (error) {
    const summary = error?.summary || {
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null,
    };
    writeStderr(`${JSON.stringify(summary)}\n`);
    setExitCode(1);
    return { exitCode: 1, summary };
  }
}

if (require.main === module) {
  if (process.argv.includes("--product-adapter-child")) {
    runProductAdapterChildCli();
  } else {
    runCli();
  }
}

module.exports = {
  DOMAIN_ACCEPTANCE_POPULATION,
  GHERKIN_SCENARIO_POPULATION,
  PROFILE_IDS,
  PROFILE_SPECS,
  ZERO_EFFECTS,
  acceptanceCases,
  assertFeatureContract,
  assertFrozenFixtureManifest,
  assertProfileId,
  clone,
  createOracleAdapter,
  executeAcceptanceCase,
  loadProductAdapter,
  main,
  oracleAction01,
  oracleAction02,
  oracleAction03,
  parseFeature,
  parseProductAdapterChildResult,
  proposalInput,
  runCli,
  runProductAdapterChild,
  runProductAdapterChildCli,
  runGherkinProfile,
  sha256,
  stableJson,
  validateAction01,
  validateAction02,
  validateAction03,
};

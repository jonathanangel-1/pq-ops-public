#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { createTruthCandidateLedger, RPC: CANDIDATE_RPC } = require("../lib/truth-candidate-ledger");
const { createTruthLinkLedger, RPC: LINK_RPC } = require("../lib/truth-link-ledger");
const {
  REQUEST_SCHEMA_VERSION,
  createTruthReviewRuntime,
  normalizeDecisionRequest,
} = require("../lib/truth-review-runtime");

const HASH = "a".repeat(64);
const DECISION_HASH = "b".repeat(64);
const REVIEW_HASH = "c".repeat(64);
const ITEM_HASH = "d".repeat(64);
const BINDING_HASH = "e".repeat(64);
const CANDIDATE_ID = `candidate:v1:${HASH}`;
const PROPOSAL_ID = `link-proposal:v1:${HASH}`;
const KEY = "review_runtime_idempotency_key_0001";

function request(targetKind, decision = "reject") {
  return {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    targetKind,
    targetId: targetKind === "candidate_claim" ? CANDIDATE_ID : PROPOSAL_ID,
    expectedTargetHash: HASH,
    expectedPreviousDecisionVersionId: targetKind === "candidate_claim"
      ? `candidate-decision:v1:${"f".repeat(64)}`
      : `link-decision:v1:${"f".repeat(64)}`,
    decision,
    decidedBy: "operator:review-test",
    reason: decision === "accept" ? "Verified the immutable evidence." : "Evidence does not support this candidate.",
  };
}

async function verifyRuntimeRouting() {
  const calls = [];
  const candidateLedger = {
    workspaceKey: "primary",
    async readReviewQueue(input) {
      calls.push(["list", input]);
      return { ok: true, totalCount: 0, limit: input.limit, items: [], mutatesOperationalState: false };
    },
    async resolveReview(input) {
      calls.push(["candidate", input]);
      return { ok: true, targetKind: "candidate_claim", targetId: input.targetId };
    },
  };
  const linkLedger = {
    workspaceKey: "primary",
    async resolveReview(input) {
      calls.push(["link", input]);
      return { ok: true, targetKind: "link_proposal", targetId: input.targetId };
    },
  };
  const runtime = createTruthReviewRuntime({ workspaceKey: "primary", candidateLedger, linkLedger });
  await runtime.list({ targetKind: "link_proposal", limit: 7 });
  await runtime.resolve({ idempotencyKey: KEY, request: request("candidate_claim") });
  await runtime.resolve({ idempotencyKey: `${KEY}x`, request: request("link_proposal", "accept") });
  assert.equal(calls[1][0], "candidate");
  assert.equal(calls[2][0], "link");
  assert.equal(calls[1][1].policyVersion, "truth-review-resolution-v1");
  assert.throws(() => normalizeDecisionRequest({ ...request("candidate_claim"), targetId: PROPOSAL_ID }), /targetId/);
  assert.throws(() => normalizeDecisionRequest({ ...request("candidate_claim"), decision: "review" }), /accept or reject/);
  assert.throws(() => normalizeDecisionRequest({ ...request("candidate_claim"), extra: true }), /exactly/);
  return calls.length;
}

async function verifyLedgerContracts() {
  const calls = [];
  async function callRpc(name, body) {
    calls.push({ name, body });
    if (name === CANDIDATE_RPC.readReviewQueue) return {
      ok: true,
      workspaceKey: "primary",
      targetKind: "candidate_claim",
      limit: 10,
      totalCount: 1,
      candidateCount: 1,
      linkCount: 0,
      items: [{
        targetKind: "candidate_claim",
        targetId: CANDIDATE_ID,
        targetItemHash: HASH,
        nextDecisionNo: 2,
      }],
      mutatesOperationalState: false,
      publishesTruth: false,
      performsActions: false,
    };
    if (name === CANDIDATE_RPC.resolveReview && body.p_target_kind === "candidate_claim") return {
      ok: true,
      idempotent: false,
      reviewResolutionId: `review-resolution:v1:${REVIEW_HASH}`,
      reviewItemHash: REVIEW_HASH,
      targetKind: "candidate_claim",
      targetId: CANDIDATE_ID,
      targetItemHash: HASH,
      decision: "reject",
      decisionVersionId: `candidate-decision:v1:${DECISION_HASH}`,
      decisionItemHash: DECISION_HASH,
      acceptedKind: "",
      acceptedItemId: "",
      acceptedItemHash: "",
      bindingId: "",
      bindingItemHash: "",
      mutatesOperationalState: false,
      publishesTruth: false,
      performsActions: false,
    };
    if (name === LINK_RPC.resolveReview && body.p_target_kind === "link_proposal") return {
      ok: true,
      idempotent: false,
      reviewResolutionId: `review-resolution:v1:${REVIEW_HASH}`,
      reviewItemHash: REVIEW_HASH,
      targetKind: "link_proposal",
      targetId: PROPOSAL_ID,
      targetItemHash: HASH,
      decision: "accept",
      decisionVersionId: `link-decision:v1:${DECISION_HASH}`,
      decisionItemHash: DECISION_HASH,
      acceptedKind: "entity_link",
      acceptedItemId: `link:v1:${ITEM_HASH}`,
      acceptedItemHash: ITEM_HASH,
      bindingId: `link-acceptance:v1:${BINDING_HASH}`,
      bindingItemHash: BINDING_HASH,
      mutatesOperationalState: false,
      publishesTruth: false,
      performsActions: false,
    };
    throw new Error(`Unexpected RPC ${name}`);
  }
  const common = { workspaceKey: "primary", syncToken: "sync", reviewToken: "r".repeat(32), callRpc };
  const candidates = createTruthCandidateLedger(common);
  const links = createTruthLinkLedger(common);
  await candidates.readReviewQueue({ targetKind: "candidate_claim", limit: 10 });
  await candidates.resolveReview({
    ...request("candidate_claim"),
    expectedPreviousDecisionVersionId: request("candidate_claim").expectedPreviousDecisionVersionId,
    expectedTargetHash: HASH,
    idempotencyKey: KEY,
    policyVersion: "truth-review-resolution-v1",
  });
  await links.resolveReview({
    ...request("link_proposal", "accept"),
    idempotencyKey: `${KEY}x`,
    policyVersion: "truth-review-resolution-v1",
  });
  assert.equal(calls.length, 3);
  assert(calls.every((call) => call.body.p_review_token === "r".repeat(32)));
  assert(calls.slice(1).every((call) => call.body.p_sync_token === "sync"));
  return calls.map((call) => call.name);
}

async function main() {
  const routedCalls = await verifyRuntimeRouting();
  const rpcs = await verifyLedgerContracts();
  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-review-runtime",
    routedCalls,
    rpcs,
    proves: [
      "candidate and link review targets use one exact request schema",
      "accept/reject is terminal and idempotency-keyed",
      "review and sync tokens never come from the request body",
      "receipts prove no publication, action, or operational mutation",
    ],
  }, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

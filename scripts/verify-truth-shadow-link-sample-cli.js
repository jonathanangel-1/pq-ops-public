#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  _test: {
    applyLinkSampleReviews,
    authorizeLinkSample,
    exportLinkSample,
    loadLinkSampleDecisionArtifact,
    openLinkSample,
    runLinkSampleAcceptance,
  },
} = require("./run-local-truth-gmail-slice");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE = "primary";
const CONNECTION = "shadow-current-awbs-20260710-c475a8ca";
const ROOT_BATCH = "cd12fa59-d02b-462b-a9c8-ed11f93e41f4";

function hash(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function main() {
  const planHash = hash("link-sample-cli-plan");
  const planId = `truth-shadow-link-sample-plan:v1:${planHash}`;
  const authorizationHash = hash("link-sample-cli-authorization");
  const sealHash = hash("link-sample-cli-seal");
  const sample = Array.from({ length: 64 }, (_, offset) => {
    const ordinal = offset + 1;
    const proposalHash = hash(`link-sample-cli-proposal-${ordinal}`);
    return {
      sampleOrdinal: ordinal,
      proposalId: `link-proposal:v1:${proposalHash}`,
      proposalHash,
      expectedPreviousDecisionVersionId:
        `link-decision:v1:${hash(`link-sample-cli-decision-${ordinal}`)}`,
      expectedPreviousDecisionHash: hash(`link-sample-cli-decision-hash-${ordinal}`),
      stratum: {
        entityType: ordinal % 2 === 0 ? "shipment" : "workgroup",
        relationship: "evidence_for",
        reasonCode: "EXACT_IDENTIFIER_MATCH",
      },
      sampleRankHash: hash(`link-sample-cli-rank-${ordinal}`),
      candidate: {
        candidateKind: "entity_link",
        candidateMethod: "deterministic",
        autoAcceptEligible: true,
        hasConflict: false,
      },
      evidenceManifestHash: hash(`link-sample-cli-evidence-${ordinal}`),
      evidence: [{
        ordinal: "1",
        observationId: `obs:v1:${hash(`link-sample-cli-observation-${ordinal}`)}`,
        observationContentHash: hash(`link-sample-cli-content-${ordinal}`),
        sourceObjectId: `message-${ordinal}`,
        sourceObjectType: "gmail_message_parsed",
        sourceRecordedAt: "2026-07-10T12:00:00+00:00",
        capturedAt: "2026-07-10T12:00:01+00:00",
        normalizedPayload: { subject: `Sample ${ordinal}`, text: "Exact identifier evidence." },
      }],
      resolution: null,
    };
  });
  const calls = [];
  let authorizationReady = false;
  let runRound = 0;
  const ctx = {
    reviewToken: "review-token",
    syncToken: "sync-token",
    async callRpc(rpc, body, options) {
      calls.push({ rpc, body, options });
      assert.equal(options.timeoutMs, 300000);
      if (rpc === "open_truth_shadow_link_sample_acceptance") {
        assert.deepEqual(body, {
          p_workspace_key: WORKSPACE,
          p_connection_key: CONNECTION,
          p_root_batch_id: ROOT_BATCH,
          p_review_token: "review-token",
          p_sync_token: "sync-token",
        });
        return {
          ok: true,
          status: "opened",
          planId,
          planHash,
          populationCount: 947,
          sampleCount: 64,
          stratumCount: 3,
          authorized: false,
          sealed: false,
          productionPublicationAttempted: false,
        };
      }
      if (rpc === "read_truth_shadow_link_sample_acceptance") {
        assert.equal(body.p_workspace_key, WORKSPACE);
        assert.equal(body.p_plan_id, planId);
        assert.ok(body.p_limit <= 10);
        return {
          ok: true,
          status: "read",
          planId,
          planHash,
          populationCount: 947,
          sampleCount: 64,
          stratumCount: 3,
          afterSampleOrdinal: body.p_after_sample_ordinal,
          items: sample.slice(
            body.p_after_sample_ordinal,
            body.p_after_sample_ordinal + body.p_limit,
          ),
          productionPublicationAttempted: false,
        };
      }
      if (rpc === "resolve_truth_shadow_link_sample_review") {
        const target = sample.find((item) => item.proposalId === body.p_proposal_id);
        assert.ok(target);
        assert.equal(body.p_workspace_key, WORKSPACE);
        assert.equal(body.p_plan_id, planId);
        assert.equal(body.p_expected_proposal_hash, target.proposalHash);
        assert.equal(
          body.p_expected_previous_decision_version_id,
          target.expectedPreviousDecisionVersionId,
        );
        assert.equal(body.p_decision, "accept");
        assert.equal(body.p_decided_by, "operator:truth-shadow-link-sample");
        assert.match(body.p_idempotency_key, /^truth_shadow_link_sample_[0-9a-f]{64}$/);
        return {
          ok: true,
          planId,
          targetId: target.proposalId,
          targetItemHash: target.proposalHash,
          decision: "accept",
          productionPublicationAttempted: false,
        };
      }
      if (rpc === "authorize_truth_shadow_link_sample_acceptance") {
        assert.equal(body.p_workspace_key, WORKSPACE);
        assert.equal(body.p_plan_id, planId);
        assert.equal(body.p_authorized_by, "operator:truth-shadow-link-sample");
        if (!authorizationReady) {
          return {
            ok: false,
            status: "not_ready",
            reason: "SAMPLE_REVIEW_INCOMPLETE",
            planId,
            productionPublicationAttempted: false,
          };
        }
        return {
          ok: true,
          status: "authorized",
          planId,
          authorizationId: `truth-shadow-link-sample-authorization:v1:${authorizationHash}`,
          authorizationHash,
          sampleCount: 64,
          productionPublicationAttempted: false,
        };
      }
      if (rpc === "run_truth_shadow_link_sample_acceptance") {
        assert.equal(body.p_workspace_key, WORKSPACE);
        assert.equal(body.p_plan_id, planId);
        assert.equal(body.p_limit, 50);
        runRound += 1;
        if (runRound === 1) {
          return {
            ok: true,
            status: "progress",
            planId,
            processedCount: 50,
            completedCount: 114,
            populationCount: 947,
            remainingCount: 833,
            productionPublicationAttempted: false,
          };
        }
        return {
          ok: true,
          status: "succeeded",
          planId,
          processedCount: 33,
          sealId: `truth-shadow-link-sample-seal:v1:${sealHash}`,
          sealHash,
          populationCount: 947,
          operatorSampleAcceptanceCount: 64,
          sampledPolicyAcceptanceCount: 883,
          productionPublicationAttempted: false,
        };
      }
      throw new Error(`unexpected RPC ${rpc}`);
    },
  };

  const tempName = `.truth-shadow-link-sample-cli-${process.pid}.json`;
  const tempPath = path.join(ROOT, tempName);
  try {
    const opened = await openLinkSample(ctx);
    assert.equal(opened.planId, planId);

    const exported = await exportLinkSample(ctx, planId, "");
    assert.equal(exported.sampleCount, 64);
    assert.equal(exported.pageCount, 7);
    const artifact = exported.decisionArtifact;
    artifact.decisions = artifact.decisions.map((decision) => ({
      ...decision,
      decision: "accept",
      reason: `Verified observation and deterministic identifier binding for sample ${decision.sampleOrdinal}.`,
    }));
    fs.writeFileSync(tempPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    const loaded = loadLinkSampleDecisionArtifact(tempName);
    assert.equal(loaded.decisions.length, 64);

    const reviewed = await applyLinkSampleReviews(ctx, tempName);
    assert.equal(reviewed.reviewedCount, 64);
    assert.equal(reviewed.acceptedCount, 64);
    assert.equal(reviewed.rejectedCount, 0);

    await assert.rejects(
      () => authorizeLinkSample(
        ctx,
        planId,
        "I personally read the complete immutable sample and verified every proposed link.",
      ),
      (error) => error.code === "TRUTH_SHADOW_LINK_SAMPLE_NOT_READY"
        && error.receipt.reason === "SAMPLE_REVIEW_INCOMPLETE",
    );
    authorizationReady = true;
    const authorization = await authorizeLinkSample(
      ctx,
      planId,
      "I personally read the complete immutable sample and verified every proposed link.",
    );
    assert.equal(authorization.authorizationHash, authorizationHash);

    const seal = await runLinkSampleAcceptance(ctx, planId, 50, 3);
    assert.equal(seal.status, "succeeded");
    assert.equal(seal.operatorSampleAcceptanceCount, 64);
    assert.equal(seal.sampledPolicyAcceptanceCount, 883);
    assert.equal(seal.attempts.length, 2);

    const runnerSource = fs.readFileSync(
      path.join(ROOT, "scripts/run-local-truth-gmail-slice.js"),
      "utf8",
    );
    for (const phase of [
      "link-sample-open", "link-sample-export", "link-sample-apply",
      "link-sample-authorize", "link-sample-run",
    ]) {
      assert.ok(runnerSource.includes(`"${phase}"`), `${phase} is not wired`);
    }
    assert.ok(runnerSource.includes(
      "reviewRequired: modelOn || modelFreeAuthorityPhase",
    ));
    assert.ok(runnerSource.includes(
      "the requested shadow authority is model-free",
    ));

    console.log(JSON.stringify({
      ok: true,
      verifier: "truth-shadow-link-sample-cli",
      populationCount: 947,
      exportedSampleCount: 64,
      readPageCount: 7,
      operatorDecisionCount: 64,
      sampledPolicyDecisionCount: 883,
      authorizationFailClosedBeforeAttestation: true,
      modelFreePhaseFence: true,
      productionPublicationAttempted: false,
    }, null, 2));
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

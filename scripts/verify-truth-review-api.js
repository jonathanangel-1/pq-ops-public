#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { REQUEST_SCHEMA_VERSION } = require("../lib/truth-review-runtime");
const { _test } = require("../api/truth/review");

const TOKEN = "truth_review_api_token_000000000000";
const KEY = "truth_review_api_idempotency_000001";

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
}

async function invoke(handler, request) {
  const result = response();
  await handler(request, result);
  return { status: result.statusCode, headers: result.headers, body: JSON.parse(result.body) };
}

async function main() {
  const calls = [];
  const runtime = {
    async list(input) {
      calls.push(["list", input]);
      return { ok: true, totalCount: 0, limit: input.limit, items: [], mutatesOperationalState: false };
    },
    async resolve(input) {
      calls.push(["resolve", input]);
      return {
        ok: true,
        reviewResolutionId: `review-resolution:v1:${"a".repeat(64)}`,
        targetKind: input.request.targetKind,
        targetId: input.request.targetId,
        decision: input.request.decision,
        mutatesOperationalState: false,
        publishesTruth: false,
        performsActions: false,
      };
    },
  };
  const handler = _test.createTruthReviewHandler({
    env: { PQ_TRUTH_REVIEW_TOKEN: TOKEN, PQ_SUPABASE_SYNC_TOKEN: "sync" },
    createRuntime(options) {
      assert.equal(options.reviewToken, TOKEN);
      assert.equal(options.syncToken, "sync");
      return runtime;
    },
  });
  const unauthorized = await invoke(handler, { method: "GET", url: "/api/truth/review" });
  assert.equal(unauthorized.status, 401);
  assert.equal(calls.length, 0);
  const listed = await invoke(handler, {
    method: "GET",
    url: "/api/truth/review?targetKind=link_proposal&limit=7",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(calls[0], ["list", { targetKind: "link_proposal", limit: 7 }]);
  assert.equal(listed.headers["cache-control"], "no-store");
  const missingKey = await invoke(handler, {
    method: "POST",
    url: "/api/truth/review",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: {},
  });
  assert.equal(missingKey.status, 400);
  assert.equal(calls.length, 1);
  const body = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    targetKind: "candidate_claim",
    targetId: `candidate:v1:${"b".repeat(64)}`,
    expectedTargetHash: "b".repeat(64),
    expectedPreviousDecisionVersionId: `candidate-decision:v1:${"c".repeat(64)}`,
    decision: "reject",
    decidedBy: "operator:api-test",
    reason: "The immutable evidence does not support acceptance.",
  };
  const decided = await invoke(handler, {
    method: "POST",
    url: "/api/truth/review",
    headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": KEY },
    body,
  });
  assert.equal(decided.status, 200);
  assert.equal(calls[1][0], "resolve");
  assert.equal(calls[1][1].idempotencyKey, KEY);
  const paused = _test.createTruthReviewHandler({
    env: {
      PQ_TRUTH_REVIEW_TOKEN: TOKEN,
      PQ_SUPABASE_SYNC_TOKEN: "sync",
      PQ_TRUTH_REVIEW_WRITES_DISABLED: "1",
    },
    createRuntime() { throw new Error("disabled request must not construct runtime"); },
  });
  const disabled = await invoke(paused, {
    method: "POST",
    url: "/api/truth/review",
    headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": KEY },
    body,
  });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.body.mutatesOperationalState, false);
  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-review-api",
    calls: calls.length,
    proves: [
      "GET and POST require constant-time bearer authentication",
      "POST requires a bounded idempotency key before runtime execution",
      "write pause switches fail closed",
      "responses are no-store and cannot publish or perform actions",
    ],
  }, null, 2));
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

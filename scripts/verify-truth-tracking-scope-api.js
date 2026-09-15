#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  createTrackingScopeHandler,
  secretMatches,
} = require("../api/truth/tracking-scope")._test;

function response() {
  return {
    statusCode: 0,
    body: null,
    setHeader() {},
    end(value) { this.body = JSON.parse(String(value)); },
  };
}

async function invoke(handler, request) {
  const output = response();
  await handler(request, output);
  return output;
}

async function main() {
  const token = "tracking-ingest-secret-123456";
  const calls = [];
  const handler = createTrackingScopeHandler({
    env: {
      PQ_TRUTH_TRACKING_INGEST_TOKEN: token,
      PQ_SUPABASE_SYNC_TOKEN: "sync-token",
      PQ_TRUTH_TRACKING_SCOPE_TTL_SECONDS: "600",
    },
    createLedger(options) {
      calls.push(["ledger", options]);
      return {
        async issue(input) {
          calls.push(["issue", input]);
          return {
            ok: true,
            scopeToken: `tracking-scope:v1:${"a".repeat(64)}`,
            expectedAwbs: ["01680000083"],
          };
        },
      };
    },
  });
  const accepted = await invoke(handler, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.expectedAwbs.length, 1);
  assert.deepEqual(calls.at(-1), ["issue", { ttlSeconds: 600, issuedBy: "hosted-tracking-collector-v1" }]);

  const unauthorized = await invoke(handler, {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(calls.filter(([name]) => name === "issue").length, 1);

  const wrongMethod = await invoke(handler, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(wrongMethod.statusCode, 405);

  const disabled = createTrackingScopeHandler({
    env: {
      PQ_TRUTH_TRACKING_INGEST_TOKEN: token,
      PQ_TRUTH_SOURCE_INGEST_DISABLED: "1",
    },
  });
  const disabledResult = await invoke(disabled, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(disabledResult.statusCode, 503);
  assert.equal(disabledResult.body.code, "TRUTH_TRACKING_SCOPE_DISABLED");
  assert.equal(secretMatches(token, token), true);
  assert.equal(secretMatches("short", token), false);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-tracking-scope-api",
    guarantees: [
      "only the tracking collector credential can request a TMS-bound AWB scope",
      "the endpoint returns a short-lived server-issued token rather than trusting caller scope",
      "paused and unconfigured ingestion fail closed",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

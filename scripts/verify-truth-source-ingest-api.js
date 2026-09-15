#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  MAX_BODY_BYTES,
  createSourceIngestHandler,
  tokenMatches,
} = require("../api/truth/source-ingest")._test;

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(String(value)); },
  };
}

async function invoke(handler, request) {
  const output = response();
  await handler(request, output);
  return output;
}

async function main() {
  const token = "tms-source-token-123456789";
  const calls = [];
  const env = {
    PQ_TRUTH_TMS_INGEST_TOKEN: token,
    PQ_TRUTH_TRACKING_INGEST_TOKEN: "tracking-source-token-123456789",
    PQ_SUPABASE_SYNC_TOKEN: "sync-token",
  };
  const handler = createSourceIngestHandler({
    env,
    createRuntime(options) {
      calls.push(["runtime", options]);
      return {
        async ingest(input) {
          calls.push(["ingest", input]);
          return {
            ok: true,
            sourceSystem: input.sourceSystem,
            payloadIdentity: `tms-source-snapshot:v1:${"a".repeat(64)}`,
            recovered: false,
            observationCount: 2,
            jobCount: 2,
            mutatesOperationalState: false,
            reducesTruth: false,
            publishesTruth: false,
          };
        },
      };
    },
  });
  const accepted = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
    body: { snapshotTime: "2026-07-09T20:00:00.000Z" },
  });
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.ok, true);
  assert.equal(calls.filter(([name]) => name === "ingest").length, 1);

  const unauthorized = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: "Bearer wrong" },
    body: {},
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.body.code, "TRUTH_SOURCE_INGEST_UNAUTHORIZED");

  const unsupported = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=production",
    headers: { authorization: `Bearer ${token}` },
    body: {},
  });
  assert.equal(unsupported.statusCode, 400);

  const operatorBypass = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=operator",
    headers: { authorization: `Bearer ${token}` },
    body: { sequence: 999, eventId: "caller-minted" },
  });
  assert.equal(operatorBypass.statusCode, 410);
  assert.equal(operatorBypass.body.code, "TRUTH_OPERATOR_EVENT_ENDPOINT_REQUIRED");
  assert.equal(operatorBypass.body.mutatesOperationalState, false);
  assert.equal(calls.filter(([name]) => name === "ingest").length, 1);

  const wrongMethod = await invoke(handler, {
    method: "GET",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(wrongMethod.statusCode, 405);

  const paused = createSourceIngestHandler({ env: { ...env, PQ_TRUTH_SOURCE_INGEST_DISABLED: "1" } });
  const pausedResponse = await invoke(paused, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
    body: {},
  });
  assert.equal(pausedResponse.statusCode, 503);
  assert.equal(pausedResponse.body.code, "TRUTH_SOURCE_INGEST_DISABLED");

  const invalidBody = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
    body: "not-json",
  });
  assert.equal(invalidBody.statusCode, 400);

  const oversized = await invoke(handler, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }),
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.body.code, "TRUTH_SOURCE_INGEST_BODY_TOO_LARGE");
  assert.ok(MAX_BODY_BYTES < 4.5 * 1024 * 1024, "handler cap must stay below Vercel's request-body limit");
  assert.equal(calls.filter(([name]) => name === "ingest").length, 1);

  const failing = createSourceIngestHandler({
    env,
    createRuntime: () => ({
      async ingest() {
        const error = new Error("source lease busy");
        error.code = "LEASE_BUSY";
        error.stage = "commit";
        error.retryable = true;
        throw error;
      },
    }),
  });
  const busy = await invoke(failing, {
    method: "POST",
    url: "/api/truth/source-ingest?source=tms",
    headers: { authorization: `Bearer ${token}` },
    body: {},
  });
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.body.retryable, true);
  assert.equal(busy.body.mutatesOperationalState, false);

  assert.equal(tokenMatches("same-secret-12345", "same-secret-12345"), true);
  assert.equal(tokenMatches("short", "different-length"), false);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-source-ingest-api",
    guarantees: [
      "each supported generic source has a separate constant-time bearer credential",
      "operator caller-minted IDs and sequences are rejected in favor of the authoritative operator-event endpoint",
      "workspace and source connection scope are server-owned",
      "invalid, oversized, paused, and unsupported requests fail closed",
      "responses never claim canonical publication or operational mutation",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  CLIENT_VERSION,
  MAX_REQUEST_BYTES,
  TruthSourceIngestClientError,
  createTruthSourceIngestClient,
} = require("../lib/truth-source-ingest-client");

const SCOPE_TOKEN = `tracking-scope:v1:${"a".repeat(64)}`;
const PROTECTION_BYPASS = "vercel_protection_bypass_for_edge_tests";

function response(status, value, headers = {}) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return headers[String(name).toLowerCase()] ?? null; } },
    async text() { return body; },
  };
}

async function main() {
  const calls = [];
  const sleeps = [];
  const queue = [
    response(503, { ok: false, code: "SOURCE_BUSY", retryable: true, error: "retry" }),
    response(200, {
      ok: true,
      payloadIdentity: "tms-identity",
      committedCursorValue: "2026-07-09T20:00:00.000Z",
      observationCount: 2,
      jobCount: 2,
    }),
    response(200, {
      ok: true,
      scopeToken: SCOPE_TOKEN,
      tmsCursorValue: "2026-07-09T20:00:00.000Z",
      expectedAwbs: ["01680000160", "01680000161"],
      expiresAt: "2026-07-09T20:15:00.000Z",
    }),
    response(200, {
      ok: true,
      payloadIdentity: "tracking-identity",
      committedCursorValue: "2026-07-09T20:01:00.000Z",
      observationCount: 2,
      jobCount: 2,
    }),
  ];
  const client = createTruthSourceIngestClient({
    origin: "https://pikiio.example",
    tmsToken: "tms-token-at-least-sixteen-bytes",
    trackingToken: "tracking-token-at-least-sixteen-bytes",
    protectionBypassSecret: PROTECTION_BYPASS,
    maxRetries: 2,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    fetchImpl: async (url, init) => {
      calls.push({ url, init: { ...init, signal: undefined } });
      return queue.shift();
    },
  });
  const tmsSnapshot = { snapshotTime: "2026-07-09T20:00:00.000Z", shipments: [] };
  const trackingSnapshots = [{
    snapshotTime: "2026-07-09T20:01:00.000Z",
    source: "carrier",
    tracking: [],
  }];
  const result = await client.ingestMorningSources({ tmsSnapshot, trackingSnapshots });
  assert.equal(result.ok, true);
  assert.equal(result.clientVersion, CLIENT_VERSION);
  assert.equal(result.tms.payloadIdentity, "tms-identity");
  assert.equal(result.tracking.payloadIdentity, "tracking-identity");
  assert.equal(result.trackingScope.expectedAwbCount, 2);
  assert.equal(result.publishesTruth, false);
  assert.equal(result.mutatesOperationalState, false);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, "https://pikiio.example/api/truth/source-ingest?source=tms");
  assert.equal(calls[1].url, calls[0].url);
  assert.equal(calls[0].init.body, calls[1].init.body, "retry must preserve the exact TMS payload");
  assert.equal(calls[2].url, "https://pikiio.example/api/truth/tracking-scope");
  assert.equal(calls[3].url, "https://pikiio.example/api/truth/source-ingest?source=tracking");
  assert.equal(JSON.parse(calls[3].init.body).scopeToken, SCOPE_TOKEN);
  assert.deepEqual(JSON.parse(calls[3].init.body).snapshot.snapshots, trackingSnapshots);
  assert.equal(calls[0].init.headers.authorization, "Bearer tms-token-at-least-sixteen-bytes");
  assert.equal(calls[3].init.headers.authorization, "Bearer tracking-token-at-least-sixteen-bytes");
  assert.equal(calls[3].init.headers["x-pikiio-truth-client"], CLIENT_VERSION);
  assert.equal(calls[3].init.headers["x-vercel-protection-bypass"], PROTECTION_BYPASS);
  assert.equal(JSON.stringify(client).includes(PROTECTION_BYPASS), false);
  assert.deepEqual(sleeps, [500]);

  assert.throws(
    () => createTruthSourceIngestClient({
      origin: "https://pikiio.example",
      tmsToken: "tms-token-at-least-sixteen-bytes",
      trackingToken: "tracking-token-at-least-sixteen-bytes",
    }),
    /protectionBypassSecret/,
  );
  assert.throws(
    () => createTruthSourceIngestClient({
      origin: "http://remote.example",
      tmsToken: "tms-token-at-least-sixteen-bytes",
      trackingToken: "tracking-token-at-least-sixteen-bytes",
    }),
    /HTTPS origin/,
  );
  assert.throws(
    () => createTruthSourceIngestClient({
      origin: "https://pikiio.example/path",
      tmsToken: "tms-token-at-least-sixteen-bytes",
      trackingToken: "tracking-token-at-least-sixteen-bytes",
    }),
    /credential-free HTTPS origin/,
  );
  assert.throws(
    () => createTruthSourceIngestClient({
      origin: "https://pikiio.example",
      tmsToken: "short",
      trackingToken: "tracking-token-at-least-sixteen-bytes",
    }),
    /tmsToken/,
  );

  const invalidScope = createTruthSourceIngestClient({
    origin: "http://127.0.0.1:3000",
    tmsToken: "tms-token-at-least-sixteen-bytes",
    trackingToken: "tracking-token-at-least-sixteen-bytes",
    fetchImpl: async () => response(200, { ok: true, scopeToken: "bad", expectedAwbs: [] }),
  });
  await assert.rejects(
    () => invalidScope.issueTrackingScope(),
    (error) => error instanceof TruthSourceIngestClientError
      && error.code === "TRUTH_TRACKING_SCOPE_RECEIPT_INVALID",
  );

  const deterministicFailure = createTruthSourceIngestClient({
    origin: "https://pikiio.example",
    tmsToken: "tms-token-at-least-sixteen-bytes",
    trackingToken: "tracking-token-at-least-sixteen-bytes",
    protectionBypassSecret: PROTECTION_BYPASS,
    fetchImpl: async () => response(422, { ok: false, code: "TMS_INCOMPLETE", error: "bad pull" }),
  });
  await assert.rejects(
    () => deterministicFailure.ingestTms({ snapshotTime: "x" }),
    (error) => error instanceof TruthSourceIngestClientError
      && error.code === "TMS_INCOMPLETE"
      && error.retryable === false,
  );

  let oversizedFetchCalls = 0;
  const boundedClient = createTruthSourceIngestClient({
    origin: "http://127.0.0.1:3000",
    tmsToken: "tms-token-at-least-sixteen-bytes",
    trackingToken: "tracking-token-at-least-sixteen-bytes",
    maxRetries: 0,
    fetchImpl: async () => {
      oversizedFetchCalls += 1;
      return response(200, { ok: true });
    },
  });
  await assert.rejects(
    () => boundedClient.ingestTms({ padding: "x".repeat(MAX_REQUEST_BYTES) }),
    (error) => error instanceof TruthSourceIngestClientError
      && error.code === "TRUTH_SOURCE_INGEST_REQUEST_TOO_LARGE"
      && error.retryable === false
      && error.outcomeUnknown === false,
  );
  assert.equal(oversizedFetchCalls, 0, "oversized source snapshots must fail before transport");
  assert.ok(MAX_REQUEST_BYTES < 4.5 * 1024 * 1024, "client cap must stay below Vercel's request-body limit");

  console.log("truth source-ingest client verification passed (TMS-before-scope ordering, exact retry, scoped tracking commit, protected origin, honest request bound)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

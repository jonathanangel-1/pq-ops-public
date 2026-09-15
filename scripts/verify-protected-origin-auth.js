#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ProtectedOriginClientError,
  createServerProtectedOriginClient,
} = require("../lib/server-protected-origin-client");
const { runHostedCanonicalRefresh } = require("./run-hosted-canonical-refresh");
const { createRunNowHandler } = require("../api/email-refresh/run-now")._test;
const snapshotApiTest = require("../api/snapshots")._test;
const { createTruthAuditCronHandler } = require("../api/cron/truth-audit")._test;
const { createTruthAuditStatusHandler } = require("../api/truth/audit-status")._test;
const {
  AUDIT_RPC,
  TruthAuditLedgerError,
  createTruthAuditLedger,
} = require("../lib/truth-audit-ledger");
const { MAX_BODY_BYTES, bodyObject } = require("../api/truth/source-ingest")._test;
const {
  MAX_REQUEST_BYTES,
  TruthSourceIngestClientError,
  createTruthSourceIngestClient,
} = require("../lib/truth-source-ingest-client");

const ROOT = path.resolve(__dirname, "..");
const ROUTE_TOKEN = "email-refresh-route-token-32-bytes-minimum";
const BYPASS_TOKEN = "vercel-protection-bypass-token";
const CRON_TOKEN = "cron-secret-for-internal-handler";

function fetchResponse(status, value, headers = {}) {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) { return headers[String(name).toLowerCase()] ?? null; },
    },
    async text() { return raw; },
  };
}

function responseHarness() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); },
    json() { return this.body ? JSON.parse(this.body) : {}; },
  };
}

async function invoke(handler, request) {
  const response = responseHarness();
  await handler(request, response);
  return response;
}

async function verifyProtectedOriginClient() {
  assert.throws(
    () => createServerProtectedOriginClient({
      origin: "https://pikiio.example",
      fetchImpl: async () => fetchResponse(200, {}),
    }),
    /protectionBypassSecret/,
  );
  assert.throws(
    () => createServerProtectedOriginClient({
      origin: "http://pikiio.example",
      protectionBypassSecret: BYPASS_TOKEN,
      fetchImpl: async () => fetchResponse(200, {}),
    }),
    /HTTPS origin/,
  );

  const calls = [];
  const client = createServerProtectedOriginClient({
    origin: "https://pikiio.example",
    protectionBypassSecret: BYPASS_TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url, init: { ...init, signal: undefined } });
      return fetchResponse(200, { ok: true });
    },
  });
  const result = await client.requestJson({
    pathname: "/api/example?bounded=1",
    method: "POST",
    authorizationToken: ROUTE_TOKEN,
    body: { hello: "world" },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "https://pikiio.example/api/example?bounded=1");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${ROUTE_TOKEN}`);
  assert.equal(calls[0].init.headers["x-vercel-protection-bypass"], BYPASS_TOKEN);
  assert.equal(JSON.stringify(client).includes(ROUTE_TOKEN), false);
  assert.equal(JSON.stringify(client).includes(BYPASS_TOKEN), false);

  const tooLargeClient = createServerProtectedOriginClient({
    origin: "https://pikiio.example",
    protectionBypassSecret: BYPASS_TOKEN,
    maxResponseBytes: 1024,
    fetchImpl: async () => fetchResponse(200, {}, { "content-length": "1025" }),
  });
  await assert.rejects(
    () => tooLargeClient.requestJson({ pathname: "/api/example", authorizationToken: ROUTE_TOKEN }),
    (error) => error instanceof ProtectedOriginClientError
      && error.code === "PROTECTED_ORIGIN_RESPONSE_TOO_LARGE",
  );
}

async function verifyHostedCanonicalRefresh() {
  const calls = [];
  const queue = [
    fetchResponse(200, { ok: true, outcome: "updated", reason: "updated" }),
    fetchResponse(200, {
      metadata: {
        "shipment-truth-packets": {
          writerVersion: "canonical-publisher-v1",
          snapshotTime: "2026-07-09T20:00:01.000Z",
        },
      },
    }),
  ];
  const result = await runHostedCanonicalRefresh({
    env: {
      PQ_EMAIL_REFRESH_RUN_NOW_TOKEN: ROUTE_TOKEN,
      PQ_TRUTH_PROTECTION_BYPASS_SECRET: BYPASS_TOKEN,
    },
    baseUrl: "https://pikiio.example",
    trigger: "morning-source-sync",
    now: () => new Date("2026-07-09T20:00:00.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init: { ...init, signal: undefined } });
      return queue.shift();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/email-refresh\/run-now\?force=1/);
  assert.match(calls[1].url, /\/api\/snapshots\?keys=shipment-truth-packets/);
  for (const call of calls) {
    assert.equal(call.init.headers.authorization, `Bearer ${ROUTE_TOKEN}`);
    assert.equal(call.init.headers["x-vercel-protection-bypass"], BYPASS_TOKEN);
  }

  let fetchCalls = 0;
  await assert.rejects(
    () => runHostedCanonicalRefresh({
      env: { PQ_TRUTH_PROTECTION_BYPASS_SECRET: BYPASS_TOKEN },
      baseUrl: "https://pikiio.example",
      fetchImpl: async () => { fetchCalls += 1; },
    }),
    /authorizationToken/,
  );
  assert.equal(fetchCalls, 0, "missing route authorization must fail before transport");

  const protectedReadbackRequest = {
    method: "GET",
    url: "/api/snapshots?keys=shipment-truth-packets&metadata=1",
    headers: {
      authorization: `Bearer ${ROUTE_TOKEN}`,
      "x-vercel-protection-bypass": BYPASS_TOKEN,
    },
  };
  assert.deepEqual(snapshotApiTest.requestKeys(protectedReadbackRequest), ["shipment-truth-packets"]);
  assert.equal(snapshotApiTest.metadataOnlyRequested(protectedReadbackRequest), true);
  const snapshotApiSource = fs.readFileSync(path.join(ROOT, "api", "snapshots.js"), "utf8");
  assert.equal(/headers\?\.(?:authorization|Authorization)|headers\[(?:"|')authorization/i.test(snapshotApiSource), false,
    "snapshot read-back must tolerate the protected caller's extra route Bearer header");
}

async function verifyRunNowRouteAuthority() {
  let cronCalls = 0;
  let lastSyntheticRequest = null;
  const handler = createRunNowHandler({
    env: {
      PQ_EMAIL_REFRESH_RUN_NOW_TOKEN: ROUTE_TOKEN,
      CRON_SECRET: CRON_TOKEN,
    },
    cronHandler: async (request, response) => {
      cronCalls += 1;
      lastSyntheticRequest = request;
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, changed: false, truthPacketsChanged: false }));
    },
  });

  let response = await invoke(handler, {
    method: "POST",
    url: "/api/email-refresh/run-now?force=1",
    headers: {},
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().code, "EMAIL_REFRESH_RUN_NOW_UNAUTHORIZED");
  assert.equal(cronCalls, 0);

  response = await invoke(handler, {
    method: "POST",
    url: "/api/email-refresh/run-now?force=1&trigger=morning%20source%20sync",
    headers: { authorization: `Bearer ${ROUTE_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().outcome, "no-new-mail");
  assert.equal(response.json().trigger, "morning-source-sync");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(cronCalls, 1);
  assert.equal(lastSyntheticRequest.headers.authorization, `Bearer ${CRON_TOKEN}`);
  assert.equal(response.body.includes(ROUTE_TOKEN), false);
  assert.equal(response.body.includes(CRON_TOKEN), false);

  const unconfigured = createRunNowHandler({
    env: { CRON_SECRET: CRON_TOKEN },
    cronHandler: async () => { cronCalls += 1; },
  });
  response = await invoke(unconfigured, { method: "POST", url: "/", headers: {} });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "EMAIL_REFRESH_RUN_NOW_NOT_CONFIGURED");

  const missingInternalAuthority = createRunNowHandler({
    env: { PQ_EMAIL_REFRESH_RUN_NOW_TOKEN: ROUTE_TOKEN },
    cronHandler: async () => { cronCalls += 1; },
  });
  response = await invoke(missingInternalAuthority, {
    method: "POST",
    url: "/",
    headers: { authorization: `Bearer ${ROUTE_TOKEN}` },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "EMAIL_REFRESH_CRON_NOT_CONFIGURED");
  assert.equal(cronCalls, 1);
}

async function verifyBrowserMutationRetired() {
  const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.equal(appSource.includes('fetch("/api/email-refresh/run-now"'), false);
  assert.equal(appSource.includes("data-retry-gmail-refresh"), false);
  assert.equal(appSource.includes("PQ_EMAIL_REFRESH_RUN_NOW_TOKEN"), false);
  assert.match(appSource, /data-refresh-authority="server-only"/);
  assert.match(appSource, /Automatic email sync only/);
  assert.match(appSource, /manual refresh requires a signed-in operator session/);
  assert.match(appSource, /refreshButton\.disabled = state\.refresh\.running \|\| !manualRefreshAuthorized/);
  assert.match(appSource, /refreshButton\.dataset\.refreshAuthority = manualRefreshAuthorized \? "local-operator" : "server-only"/);
  assert.equal(appSource.includes("manual-full-refresh"), false);
}

async function verifyAuditWritePause() {
  const calls = [];
  const ledger = createTruthAuditLedger({
    auditToken: "audit-token-at-least-sixteen-bytes",
    writesDisabled: true,
    callRpc: async (rpc) => {
      calls.push(rpc);
      if (rpc === AUDIT_RPC.readSnapshotBase) {
        return {
          schemaVersion: "relational-truth-audit-snapshot-v1",
          workspaceKey: "primary",
          bounds: {
            rowLimit: 100,
            counts: {
              acceptedClaimEnvelopes: 0,
              buildInputs: 0,
              entityLinkEnvelopes: 0,
              publicationPayloads: 0,
              sourceCutEvidenceObservations: 0,
              jobChildren: 0,
              jobLineage: 0,
              jobObservations: 0,
              jobs: 0,
              observations: 0,
            },
            publicationPayloadBytes: 0,
            publicationPayloadByteLimit: 33554432,
            truncated: false,
          },
          source: {
            ingestBatches: [],
            jobChildren: [],
            jobLineage: [],
            jobObservations: [],
            jobs: [],
            observations: [],
          },
          canonical: {
            currentSourceCutId: `cut:v1:${"a".repeat(64)}`,
            publicationHeads: [],
            publicationPayloads: [],
            acceptedClaimEnvelopes: [],
            buildInputs: [],
            entityLinkEnvelopes: [],
            sourceCutEvidenceObservations: [],
          },
        };
      }
      if (rpc === AUDIT_RPC.readSnapshotPublicationPayloads) return {
        schemaVersion: "relational-truth-audit-publication-payloads-v1",
        workspaceKey: "primary",
        rowLimit: 100,
        sourceCutId: `cut:v1:${"a".repeat(64)}`,
        publicationHeads: [],
        publicationPayloads: [],
        publicationPayloadCount: 0,
        publicationPayloadBytes: 0,
        publicationPayloadByteLimit: 33554432,
        truncated: false,
      };
      if (rpc === AUDIT_RPC.readSnapshotClosure) return {
        schemaVersion: "relational-truth-audit-closure-v1",
        workspaceKey: "primary",
        rowLimit: 100,
        sourceCutId: `cut:v1:${"a".repeat(64)}`,
        bounds: {
          counts: {
            acceptedClaimEnvelopes: 0,
            buildInputs: 0,
            entityLinkEnvelopes: 0,
            sourceCutEvidenceObservations: 0,
          },
          truncated: false,
        },
        canonical: {
          acceptedClaimEnvelopes: [],
          buildInputs: [],
          entityLinkEnvelopes: [],
          sourceCutEvidenceObservations: [],
        },
      };
      if (rpc === AUDIT_RPC.readSnapshotProcessing) return {
        schemaVersion: "relational-truth-audit-processing-v1",
        workspaceKey: "primary",
        rowLimit: 100,
        sourceCutId: `cut:v1:${"a".repeat(64)}`,
        currentBatchIds: [],
        bounds: {
          counts: {
            jobChildren: 0,
            jobLineage: 0,
            jobObservations: 0,
            jobs: 0,
            observations: 0,
          },
          truncated: false,
        },
        source: {
          jobChildren: [],
          jobLineage: [],
          jobObservations: [],
          jobs: [],
          observations: [],
        },
      };
      if (rpc === AUDIT_RPC.readSnapshotExtensions) return {
        schemaVersion: "relational-truth-audit-snapshot-extensions-v1",
        workspaceKey: "primary",
        rowLimit: 100,
        sourceCutId: `cut:v1:${"a".repeat(64)}`,
        bounds: {
          counts: {
            attachmentExtractionGaps: 0,
            modelExtractionJobGaps: 0,
            modelExtractionReviewGaps: 0,
            processingWatermarkBuildPairs: 0,
            processingWatermarkPublications: 0,
            shipmentMetadataEnvelopes: 0,
          },
          truncated: false,
        },
        source: {
          attachmentExtractionCompleteness: {
            schemaVersion: "gmail-attachment-extraction-completeness-v1",
            unresolvedCount: 0,
            complete: true,
          },
          attachmentExtractionGaps: [],
          modelExtractionCompleteness: {
            schemaVersion: "gmail-model-extraction-completeness-v1",
            pendingJobCount: 0,
            pendingReviewCount: 0,
            complete: true,
          },
          modelExtractionJobGaps: [],
          modelExtractionReviewGaps: [],
        },
        canonical: {
          shipmentMetadataEnvelopes: [],
          processingWatermarkContinuity: {
            schemaVersion: "truth-processing-watermark-continuity-v1",
            sourceCutId: `cut:v1:${"a".repeat(64)}`,
            complete: true,
            mismatchCount: 0,
            legacyUnwatermarkedPairCount: 0,
            buildPairs: [],
            publications: [],
          },
        },
      };
      throw new Error(`unexpected RPC ${rpc}`);
    },
  });
  const snapshot = await ledger.readSnapshot({ rowLimit: 100 });
  assert.equal(snapshot.bounds.truncated, false, "read-only audit snapshot remains available while writes are paused");
  for (const mutation of [
    () => ledger.beginRun({}),
    () => ledger.completeRun({}),
    () => ledger.failRun({}),
  ]) {
    await assert.rejects(
      mutation,
      (error) => error instanceof TruthAuditLedgerError
        && error.code === "TRUTH_AUDIT_WRITES_DISABLED"
        && error.retryable === false,
    );
  }
  assert.deepEqual(calls, [
    AUDIT_RPC.readSnapshotBase,
    AUDIT_RPC.readSnapshotPublicationPayloads,
    AUDIT_RPC.readSnapshotProcessing,
    AUDIT_RPC.readSnapshotClosure,
    AUDIT_RPC.readSnapshotExtensions,
  ]);

  const previousWritePause = process.env.PQ_SUPABASE_WRITES_DISABLED;
  process.env.PQ_SUPABASE_WRITES_DISABLED = "1";
  try {
    const cannotOverrideGlobalPause = createTruthAuditLedger({
      auditToken: "audit-token-at-least-sixteen-bytes",
      writesDisabled: false,
      callRpc: async () => { throw new Error("must not reach RPC"); },
    });
    await assert.rejects(
      () => cannotOverrideGlobalPause.beginRun({}),
      (error) => error?.code === "TRUTH_AUDIT_WRITES_DISABLED",
    );
  } finally {
    if (previousWritePause === undefined) delete process.env.PQ_SUPABASE_WRITES_DISABLED;
    else process.env.PQ_SUPABASE_WRITES_DISABLED = previousWritePause;
  }

  let factoryCalls = 0;
  const cron = createTruthAuditCronHandler({
    env: {
      CRON_SECRET: CRON_TOKEN,
      PQ_SUPABASE_WRITES_DISABLED: "1",
    },
    createLedger() { factoryCalls += 1; },
  });
  let response = await invoke(cron, {
    method: "GET",
    url: "/api/cron/truth-audit",
    headers: {},
  });
  assert.equal(response.statusCode, 401, "authorization precedes pause-state disclosure");
  response = await invoke(cron, {
    method: "GET",
    url: "/api/cron/truth-audit",
    headers: { authorization: `Bearer ${CRON_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "disabled");
  assert.match(response.json().reason, /PQ_SUPABASE_WRITES_DISABLED/);
  assert.equal(factoryCalls, 0);

  const statusToken = "status-token-at-least-sixteen-bytes";
  const status = createTruthAuditStatusHandler({
    env: {
      PQ_SUPABASE_WRITES_DISABLED: "1",
      PQ_TRUTH_AUDIT_STATUS_TOKEN: statusToken,
      PQ_TRUTH_AUDIT_TOKEN: "audit-token-at-least-sixteen-bytes",
      PQ_SUPABASE_URL: "https://example.supabase.co",
      PQ_SUPABASE_ANON_KEY: "anon-key-at-least-sixteen-bytes",
    },
    createLedger() {
      return {
        async readStatus() {
          return { ok: true, health: "healthy", mutatesOperationalState: false };
        },
      };
    },
  });
  response = await invoke(status, {
    method: "GET",
    url: "/api/truth/audit-status",
    headers: { authorization: `Bearer ${statusToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().health, "healthy");
}

async function verifyHonestSourceIngestBound() {
  assert.equal(MAX_BODY_BYTES, MAX_REQUEST_BYTES);
  assert.equal(MAX_BODY_BYTES, 4 * 1024 * 1024);
  assert.ok(MAX_BODY_BYTES < 4.5 * 1024 * 1024);
  assert.throws(
    () => bodyObject({ body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES) }) }),
    (error) => error?.code === "TRUTH_SOURCE_INGEST_BODY_TOO_LARGE",
  );

  let fetchCalls = 0;
  const client = createTruthSourceIngestClient({
    origin: "http://127.0.0.1:3000",
    tmsToken: "tms-token-at-least-sixteen-bytes",
    trackingToken: "tracking-token-at-least-sixteen-bytes",
    maxRetries: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      return fetchResponse(200, { ok: true });
    },
  });
  await assert.rejects(
    () => client.ingestTms({ padding: "x".repeat(MAX_REQUEST_BYTES) }),
    (error) => error instanceof TruthSourceIngestClientError
      && error.code === "TRUTH_SOURCE_INGEST_REQUEST_TOO_LARGE"
      && error.outcomeUnknown === false,
  );
  assert.equal(fetchCalls, 0, "oversized source snapshots fail before network transport");
}

async function main() {
  await verifyProtectedOriginClient();
  await verifyHostedCanonicalRefresh();
  await verifyRunNowRouteAuthority();
  await verifyBrowserMutationRetired();
  await verifyAuditWritePause();
  await verifyHonestSourceIngestBound();
  console.log(JSON.stringify({
    ok: true,
    verifier: "protected-origin-auth",
    guarantees: [
      "server automation sends Vercel protection bypass and independent route Bearer authorization",
      "run-now rejects unauthenticated browser callers before invoking Gmail refresh",
      "browser mutation is retired until operator sessions exist",
      "global Supabase write pause blocks audit-run journaling while bounded status reads remain available",
      "source-ingest client and API share an honest 4 MiB pre-edge request limit",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

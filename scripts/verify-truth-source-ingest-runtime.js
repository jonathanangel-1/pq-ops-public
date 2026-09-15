#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  RUNTIME_VERSION,
  createTruthSourceIngestRuntime,
} = require("../lib/truth-source-ingest-runtime");

function built(sourceSystem, connectionKey, options = {}) {
  const cursor = sourceSystem === "operator" ? "1" : "2026-07-09T20:00:00.000Z";
  return {
    sourceSystem,
    workspaceKey: "primary",
    connectionKey,
    nextCursorValue: cursor,
    payloadIdentity: `${sourceSystem}-source-${sourceSystem === "operator" ? "delta" : "snapshot"}:v1:${"a".repeat(64)}`,
    providerManifest: {
      schemaVersion: `${sourceSystem}-fixture-v1`,
      complete: true,
      upstreamWatermark: cursor,
      sourceSnapshotAt: "2026-07-09T20:00:00.000Z",
      recordCount: 1,
      ...(options.scopeToken ? { scopeToken: options.scopeToken, expectedAwbs: options.expectedAwbs } : {}),
    },
    observations: [{ observationId: `obs:v1:${"b".repeat(64)}` }],
    jobs: [{ dedupeKey: "fixture" }],
    diagnostics: { complete: true },
  };
}

function fakeLedger(sourceSystem, connectionKey, calls, options = {}) {
  return {
    scope: { workspaceKey: "primary", sourceSystem, connectionKey },
    async recordPreflightFailure(input) {
      calls.push(["preflightFailure", sourceSystem, structuredClone(input)]);
      if (options.failureEvidenceError) throw options.failureEvidenceError;
      return { ok: true, failureId: "failure-1" };
    },
    async recoverCommittedSnapshot() {},
    async acquireLease() {},
    async beginSnapshotBatch() {},
    async commitSnapshotBatch() {},
    async failSnapshotBatch() {},
  };
}

async function main() {
  const calls = [];
  const scopeToken = `tracking-scope:v1:${"c".repeat(64)}`;
  const scope = {
    workspaceKey: "primary",
    trackingConnectionKey: "carrier-tracking-primary",
    scopeToken,
    expectedAwbs: ["01680000083"],
  };
  const configs = {
    tms: {
      connectionKey: "couriercloud-ops-tlv-us",
      build(payload, options) {
        calls.push(["build", "tms", structuredClone(payload), structuredClone(options)]);
        return built("tms", this.connectionKey);
      },
    },
    tracking: {
      connectionKey: "carrier-tracking-primary",
      build(payload, options) {
        calls.push(["build", "tracking", structuredClone(payload), structuredClone(options)]);
        assert.deepEqual(options.expectedAwbs, scope.expectedAwbs);
        assert.equal(options.scopeToken, scopeToken);
        return built("tracking", this.connectionKey, options);
      },
    },
    operator: {
      connectionKey: "operator-phone-primary",
      build(payload, options) {
        calls.push(["build", "operator", structuredClone(payload), structuredClone(options)]);
        return built("operator", this.connectionKey);
      },
    },
  };
  const runtime = createTruthSourceIngestRuntime({
    workspaceKey: "primary",
    syncToken: "sync-token",
    sourceConfig: configs,
    createLedger: ({ sourceSystem, connectionKey }) => fakeLedger(sourceSystem, connectionKey, calls),
    trackingScopeLedger: {
      async read(input) {
        calls.push(["scope.read", structuredClone(input)]);
        return scope;
      },
    },
    async commit(input) {
      calls.push(["commit", input.builtSnapshot.sourceSystem, input.ownerId, input.triggerName]);
      return {
        ok: true,
        payloadIdentity: input.builtSnapshot.payloadIdentity,
        recovered: false,
        commit: {
          committedCursorValue: input.builtSnapshot.nextCursorValue,
          committedCursorVersion: 4,
        },
      };
    },
  });

  for (const sourceSystem of ["tms", "tracking"]) {
    const result = await runtime.ingest({
      sourceSystem,
      payload: sourceSystem === "tracking"
        ? { snapshot: { fixture: true }, scopeToken }
        : { fixture: true },
      scopeToken: sourceSystem === "tracking" ? scopeToken : undefined,
      ownerId: `worker:${sourceSystem}`,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sourceSystem, sourceSystem);
    assert.equal(result.committedCursorVersion, 4);
    assert.equal(result.mutatesOperationalState, false);
    assert.equal(result.reducesTruth, false);
    assert.equal(result.publishesTruth, false);
  }
  assert.equal(calls.filter(([name]) => name === "scope.read").length, 1);
  await assert.rejects(
    () => runtime.ingest({
      sourceSystem: "operator",
      payload: { fixture: true },
      ownerId: "worker:operator",
    }),
    (error) => error?.code === "TRUTH_OPERATOR_EVENT_AUTHORITY_REQUIRED"
      && error.stage === "authority"
      && error.retryable === false,
  );
  assert.equal(calls.some(([name, source]) => name === "build" && source === "operator"), false);

  const preflightCalls = [];
  const structuralError = Object.assign(new Error("scope incomplete"), {
    code: "TRACKING_SOURCE_SNAPSHOT_INCOMPLETE",
    diagnostics: { complete: false, issues: [{ code: "tracking_scope_incomplete" }] },
  });
  const failing = createTruthSourceIngestRuntime({
    workspaceKey: "primary",
    syncToken: "sync-token",
    sourceConfig: {
      tracking: {
        connectionKey: "carrier-tracking-primary",
        build() { throw structuralError; },
      },
    },
    createLedger: ({ sourceSystem, connectionKey }) => fakeLedger(sourceSystem, connectionKey, preflightCalls),
    trackingScopeLedger: { async read() { return scope; } },
    async commit() { throw new Error("must not commit"); },
  });
  await assert.rejects(
    () => failing.ingest({
      sourceSystem: "tracking",
      payload: { snapshot: {}, scopeToken },
      scopeToken,
      ownerId: "worker:tracking",
    }),
    (error) => error?.code === "TRACKING_SOURCE_SNAPSHOT_INCOMPLETE"
      && error.stage === "preflight"
      && error.failureReceipt?.ok === true,
  );
  assert.equal(preflightCalls.filter(([name]) => name === "preflightFailure").length, 1);

  const mismatch = createTruthSourceIngestRuntime({
    workspaceKey: "primary",
    syncToken: "sync-token",
    sourceConfig: { tracking: configs.tracking },
    createLedger: ({ sourceSystem, connectionKey }) => fakeLedger(sourceSystem, connectionKey, []),
    trackingScopeLedger: {
      async read() { return { ...scope, trackingConnectionKey: "wrong" }; },
    },
    async commit() { throw new Error("must not commit"); },
  });
  await assert.rejects(
    () => mismatch.ingest({
      sourceSystem: "tracking",
      payload: { snapshot: {}, scopeToken },
      scopeToken,
      ownerId: "worker:tracking",
    }),
    (error) => error?.code === "TRUTH_SOURCE_INGEST_TRACKING_SCOPE_MISMATCH"
      && error.stage === "preflight",
  );

  const commitFailure = createTruthSourceIngestRuntime({
    workspaceKey: "primary",
    syncToken: "sync-token",
    sourceConfig: { tms: configs.tms },
    createLedger: ({ sourceSystem, connectionKey }) => fakeLedger(sourceSystem, connectionKey, []),
    trackingScopeLedger: { async read() { throw new Error("unused"); } },
    async commit() {
      const error = new Error("lease busy");
      error.code = "LEASE_BUSY";
      error.retryable = true;
      throw error;
    },
  });
  await assert.rejects(
    () => commitFailure.ingest({ sourceSystem: "tms", payload: {}, ownerId: "worker:tms" }),
    (error) => error?.code === "LEASE_BUSY" && error.stage === "commit" && error.retryable === true,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-source-ingest-runtime",
    runtimeVersion: RUNTIME_VERSION,
    guarantees: [
      "TMS and tracking inputs enter only the generic fenced source ledger",
      "operator input is rejected even if a caller injects a source config; only the server-authoritative operator-event runtime may mint it",
      "tracking expected AWBs are loaded from the server-issued TMS scope",
      "structural failures are durably witnessed before any cursor movement",
      "the ingest runtime never reduces, publishes, or performs operational effects",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

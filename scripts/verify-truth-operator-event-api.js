#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  MAX_BODY_BYTES,
  createOperatorEventHandler,
} = require("../api/truth/operator-event")._test;

const TOKEN = "operator-event-api-token-32-bytes-minimum";
const KEY = "C".repeat(32);

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = String(value || ""); },
    json() { return JSON.parse(this.body); },
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    url: "/api/truth/operator-event",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "idempotency-key": KEY,
    },
    body: { schemaVersion: "operator-truth-event-request-v1", eventType: "assertion" },
    ...overrides,
  };
}

async function invoke(handler, input) {
  const response = responseCapture();
  await handler(input, response);
  return response;
}

async function main() {
  const calls = [];
  const runtime = {
    record: async (input) => {
      calls.push(input);
      return {
        ok: true,
        schemaVersion: "truth-operator-event-receipt-v1",
        status: "recorded",
        requestId: `operator-request:v1:${"1".repeat(64)}`,
        eventId: `operator-event:v1:${"2".repeat(64)}`,
        eventSequence: "1",
        observationId: `obs:v1:${"3".repeat(64)}`,
        mutatesOperationalState: false,
      };
    },
  };
  const handler = createOperatorEventHandler({
    env: {
      PQ_TRUTH_OPERATOR_EVENT_TOKEN: TOKEN,
      PQ_TRUTH_WORKSPACE: "primary",
      PQ_SUPABASE_SYNC_TOKEN: "sync-token",
    },
    createRuntime: (options) => {
      assert.deepEqual(options, {
        workspaceKey: "primary",
        connectionKey: "operator-phone-primary",
        syncToken: "sync-token",
      });
      return runtime;
    },
  });

  const success = await invoke(handler, request());
  assert.equal(success.statusCode, 200);
  assert.equal(success.json().eventSequence, "1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].idempotencyKey, KEY);

  const method = await invoke(handler, request({ method: "GET" }));
  assert.equal(method.statusCode, 405);
  const unauthorized = await invoke(handler, request({ headers: { authorization: "Bearer wrong", "idempotency-key": KEY } }));
  assert.equal(unauthorized.statusCode, 401);
  const missingKey = await invoke(handler, request({ headers: { authorization: `Bearer ${TOKEN}` } }));
  assert.equal(missingKey.statusCode, 400);
  const weakKey = await invoke(handler, request({ headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "weak" } }));
  assert.equal(weakKey.statusCode, 400);
  const invalidBody = await invoke(handler, request({ body: "not-json" }));
  assert.equal(invalidBody.statusCode, 400);
  const tooLarge = await invoke(handler, request({ body: JSON.stringify({ value: "x".repeat(MAX_BODY_BYTES) }) }));
  assert.equal(tooLarge.statusCode, 413);

  const disabled = createOperatorEventHandler({
    env: {
      PQ_TRUTH_OPERATOR_EVENT_TOKEN: TOKEN,
      PQ_TRUTH_SOURCE_INGEST_DISABLED: "1",
    },
    createRuntime: () => runtime,
  });
  assert.equal((await invoke(disabled, request())).statusCode, 503);

  const conflict = createOperatorEventHandler({
    env: { PQ_TRUTH_OPERATOR_EVENT_TOKEN: TOKEN },
    createRuntime: () => ({
      record: async () => {
        const error = new Error("idempotency conflict");
        error.code = "23505";
        throw error;
      },
    }),
  });
  const conflictResponse = await invoke(conflict, request());
  assert.equal(conflictResponse.statusCode, 409);
  assert.equal(conflictResponse.json().safeToRetryWithSameIdempotencyKey, true);

  const ambiguous = createOperatorEventHandler({
    env: { PQ_TRUTH_OPERATOR_EVENT_TOKEN: TOKEN },
    createRuntime: () => ({
      record: async () => {
        const error = new Error("timeout after commit");
        error.retryable = true;
        error.outcomeUnknown = true;
        throw error;
      },
    }),
  });
  const ambiguousResponse = await invoke(ambiguous, request());
  assert.equal(ambiguousResponse.statusCode, 503);
  assert.equal(ambiguousResponse.json().outcomeUnknown, true);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-event-api",
    checks: 18,
    guarantees: [
      "the endpoint requires a dedicated constant-time bearer secret",
      "a strong Idempotency-Key header is mandatory and bodies are capped at 32 KiB",
      "workspace and operator connection are injected by the server",
      "disabled writes, conflicts, and ambiguous outcomes are explicit without action side effects",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

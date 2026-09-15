#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { COMMAND_SCHEMA_VERSION } = require("../lib/truth-operator-browser-runtime");
const {
  AUTHORITY_ENV,
  AUTHORITY_VALUE,
  CSRF_HEADER,
  CSRF_VALUE,
  ENABLED_ENV,
  OPERATOR_ID_ENV,
  OPERATOR_NAME_ENV,
  ORIGIN_ENV,
  createOperatorBrowserEventHandler,
} = require("../api/truth/operator-browser-event")._test;

const ORIGIN = "https://ops.pikiio.test";
const KEY = "browser-api-idempotency-key-000001";

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); },
    json() { return JSON.parse(this.body); },
  };
}

function env(overrides = {}) {
  return {
    [ENABLED_ENV]: "1",
    [AUTHORITY_ENV]: AUTHORITY_VALUE,
    [ORIGIN_ENV]: ORIGIN,
    [OPERATOR_ID_ENV]: "operator:alex",
    [OPERATOR_NAME_ENV]: "Alex Morgan",
    PQ_TRUTH_WORKSPACE: "primary",
    PQ_SUPABASE_SYNC_TOKEN: "server-only-sync-token",
    ...overrides,
  };
}

function command(overrides = {}) {
  return {
    schemaVersion: COMMAND_SCHEMA_VERSION,
    command: "pickup_completed",
    subject: { awb: "01680000156" },
    occurredAt: "2026-07-09T15:00:00.000Z",
    contact: { name: "Jeff", organization: "Juniper Logistics" },
    reference: { proof: "Call", note: "" },
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    headers: {
      origin: ORIGIN,
      host: "ops.pikiio.test",
      "x-forwarded-proto": "https",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      [CSRF_HEADER]: CSRF_VALUE,
      "idempotency-key": KEY,
    },
    body: command(),
    ...overrides,
  };
}

async function invoke(handler, input) {
  const response = responseCapture();
  await handler(input, response);
  return response;
}

async function main() {
  const runtimeOptions = [];
  const browserOptions = [];
  const commands = [];
  const handler = createOperatorBrowserEventHandler({
    env: env(),
    createOperatorRuntime: (options) => {
      runtimeOptions.push(options);
      return { record: async () => ({ ok: true }) };
    },
    createBrowserRuntime: (options) => {
      browserOptions.push(options);
      return {
        recordCommand: async (input) => {
          commands.push(input);
          return {
            ok: true,
            schemaVersion: "operator-browser-truth-receipt-v1",
            status: "recorded",
            receipts: [{ eventId: `operator-event:v1:${"a".repeat(64)}` }],
            mutatesOperationalState: false,
          };
        },
      };
    },
  });
  const success = await invoke(handler, request());
  assert.equal(success.statusCode, 200);
  assert.equal(success.json().status, "recorded");
  assert.deepEqual(runtimeOptions, [{
    workspaceKey: "primary",
    connectionKey: "operator-phone-primary",
    syncToken: "server-only-sync-token",
  }]);
  assert.deepEqual(browserOptions[0].recordedBy, {
    operatorId: "operator:alex",
    name: "Alex Morgan",
  });
  assert.equal(commands[0].idempotencyKey, KEY);
  assert.deepEqual(commands[0].command, command());
  assert.equal(JSON.stringify(success.json()).includes("sync-token"), false);

  const notConfigured = createOperatorBrowserEventHandler({ env: {} });
  assert.equal((await invoke(notConfigured, request())).statusCode, 503);

  const wrongAuthority = createOperatorBrowserEventHandler({
    env: env({ [AUTHORITY_ENV]: "custom-domain-only" }),
  });
  assert.equal((await invoke(wrongAuthority, request())).statusCode, 503);

  for (const changedHeaders of [
    { ...request().headers, origin: "https://attacker.test" },
    { ...request().headers, host: "attacker.test" },
    { ...request().headers, "sec-fetch-site": "cross-site" },
    Object.fromEntries(Object.entries(request().headers).filter(([key]) => key !== CSRF_HEADER)),
    { ...request().headers, "content-type": "text/plain" },
  ]) {
    const response = await invoke(handler, request({ headers: changedHeaders }));
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().code, "TRUTH_OPERATOR_BROWSER_FORBIDDEN");
  }

  const missingKeyHeaders = { ...request().headers };
  delete missingKeyHeaders["idempotency-key"];
  assert.equal((await invoke(handler, request({ headers: missingKeyHeaders }))).statusCode, 400);
  assert.equal((await invoke(handler, request({ method: "GET" }))).statusCode, 405);

  const disabled = createOperatorBrowserEventHandler({ env: env({ PQ_SUPABASE_WRITES_DISABLED: "1" }) });
  assert.equal((await invoke(disabled, request())).statusCode, 503);

  const invalid = createOperatorBrowserEventHandler({
    env: env(),
    createOperatorRuntime: () => ({ record: async () => ({}) }),
    createBrowserRuntime: () => ({
      recordCommand: async () => {
        const error = new Error("unsupported command");
        error.code = "TRUTH_OPERATOR_BROWSER_INVALID_ARGUMENT";
        throw error;
      },
    }),
  });
  assert.equal((await invoke(invalid, request())).statusCode, 400);

  const partial = createOperatorBrowserEventHandler({
    env: env(),
    createOperatorRuntime: () => ({ record: async () => ({}) }),
    createBrowserRuntime: () => ({
      recordCommand: async () => {
        const error = new Error("second assertion timed out");
        error.code = "TRUTH_OPERATOR_BROWSER_PARTIAL_OR_FAILED";
        error.failedAssertionIndex = 1;
        error.completedReceipts = [{ eventId: "first" }];
        error.outcomeUnknown = true;
        throw error;
      },
    }),
  });
  const partialResponse = await invoke(partial, request());
  assert.equal(partialResponse.statusCode, 503);
  assert.equal(partialResponse.json().failedAssertionIndex, 1);
  assert.deepEqual(partialResponse.json().completedReceipts, [{ eventId: "first" }]);
  assert.equal(partialResponse.json().safeToRetryWithSameIdempotencyKey, true);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-browser-api",
    checks: 27,
    guarantees: [
      "browser ingress is disabled unless the rollout explicitly attests Vercel Authentication=all",
      "exact HTTPS origin, forwarded host, same-origin Fetch Metadata, JSON, and a custom CSRF header are mandatory",
      "the server injects workspace, source connection, sync credentials, and operator identity",
      "disabled writes, invalid commands, and partial/ambiguous outcomes fail closed with same-key retry guidance",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

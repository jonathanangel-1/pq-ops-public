#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");

const {
  API_ORIGIN,
  BATCH_INPUT_SCHEMA_VERSION,
  BATCH_RECONCILIATION_SCHEMA_VERSION,
  BATCH_RESULT_SCHEMA_VERSION,
  COMPLETION_WINDOW,
  MAX_ITEM_CONTEXT_TOKENS,
  RESPONSES_ENDPOINT,
  OpenAITruthModelBatchError,
  buildBatchClientRequestId,
  buildBatchInput,
  createOpenAITruthModelBatchClient,
  reconcileBatchResults,
  validateBatchInput,
} = require("../lib/openai-truth-model-batch");

const PINNED_MODEL = "gpt-5-nano-2025-08-07";
const OTHER_PINNED_MODEL = "gpt-5-mini-2025-08-07";
const FAKE_API_KEY = "sk-test-batch-never-live-000000000000";
const checks = [];
let globalNetworkCalls = 0;

globalThis.fetch = async function networkBomb() {
  globalNetworkCalls += 1;
  throw new Error("The verifier must never use global fetch");
};

function record(name, run) {
  run();
  checks.push(name);
}

async function recordAsync(name, run) {
  await run();
  checks.push(name);
}

function expectCode(run, code) {
  assert.throws(run, (error) => {
    assert(error instanceof OpenAITruthModelBatchError);
    assert.equal(error.code, code);
    return true;
  });
}

async function expectCodeAsync(run, code, assertions = () => {}) {
  await assert.rejects(run, (error) => {
    assert(error instanceof OpenAITruthModelBatchError);
    assert.equal(error.code, code);
    assertions(error);
    return true;
  });
}

function responseSchema() {
  return {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            value: { type: "string" },
            confidence: { type: "number" },
          },
          required: ["field", "value", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["claims"],
    additionalProperties: false,
  };
}

function preparedBody(seed, model = PINNED_MODEL) {
  return {
    model,
    input: [
      {
        role: "developer",
        content: [{ type: "input_text", text: "Extract only evidence-grounded shipment claims." }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: `Ambiguous residual span ${seed}` }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "gmail_model_candidate_claims",
        strict: true,
        schema: responseSchema(),
      },
    },
    max_output_tokens: 500,
    prompt_cache_key: "truth-gmail-claim-v2",
    store: false,
    temperature: 0,
  };
}

function parseJsonl(contents) {
  return contents.trimEnd().split("\n").map((line) => JSON.parse(line));
}

function makeInput(count = 3) {
  const requests = Array.from({ length: count }, (_, index) => ({
    requestKey: `message-${index + 1}:revision-1:span-${index + 1}`,
    body: preparedBody(index + 1),
  }));
  return buildBatchInput(requests);
}

function rawBatch(status, requestCount, overrides = {}) {
  const completed = overrides.completed ?? (status === "completed" ? requestCount : 0);
  const failed = overrides.failed ?? (status === "completed" ? 0 : requestCount - completed);
  return {
    id: overrides.id || "batch_test_truth_001",
    object: "batch",
    endpoint: RESPONSES_ENDPOINT,
    input_file_id: overrides.inputFileId || "file-input-truth-001",
    completion_window: COMPLETION_WINDOW,
    status,
    model: overrides.model ?? PINNED_MODEL,
    output_file_id: overrides.outputFileId ?? null,
    error_file_id: overrides.errorFileId ?? null,
    request_counts: { total: overrides.total ?? requestCount, completed, failed },
    usage: overrides.usage ?? null,
    created_at: 1_788_800_000,
    completed_at: status === "completed" ? 1_788_800_100 : null,
    expired_at: status === "expired" ? 1_788_886_400 : null,
    cancelled_at: status === "cancelled" ? 1_788_800_100 : null,
    failed_at: status === "failed" ? 1_788_800_100 : null,
    errors: overrides.errors ?? null,
    metadata: overrides.metadata ?? { input_hash: "fixture" },
  };
}

function responseLine(item, suffix, overrides = {}) {
  const inputTokens = overrides.inputTokens ?? 13;
  const outputTokens = overrides.outputTokens ?? 7;
  const body = {
    id: `resp_${suffix}`,
    object: "response",
    created_at: 1_788_800_050,
    status: "completed",
    model: overrides.actualModel || PINNED_MODEL,
    output: [{
      type: "message",
      id: `msg_${suffix}`,
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        annotations: [],
        text: JSON.stringify({ claims: [] }),
      }],
    }],
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: overrides.cachedTokens ?? 5 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: overrides.reasoningTokens ?? 2 },
      total_tokens: inputTokens + outputTokens,
    },
  };
  return {
    id: `batch_req_${suffix}`,
    custom_id: item.customId,
    response: {
      status_code: overrides.statusCode ?? 200,
      request_id: `req_${suffix}`,
      body: overrides.body || body,
    },
    error: null,
  };
}

function errorLine(item, suffix, code = "invalid_request_error") {
  return {
    id: `batch_req_${suffix}`,
    custom_id: item.customId,
    response: null,
    error: {
      code,
      message: `Fixture error ${code}`,
      param: null,
      type: "batch_item_error",
    },
  };
}

function toJsonl(lines) {
  return lines.length ? `${lines.map((line) => JSON.stringify(line)).join("\n")}\n` : "";
}

function fakeHeaders(requestId) {
  return {
    get(name) {
      return String(name).toLowerCase() === "x-request-id" ? requestId : null;
    },
  };
}

function fakeJsonResponse(payload, requestId, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders(requestId),
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function fakeTextResponse(contents, requestId, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: fakeHeaders(requestId),
    async text() {
      return contents;
    },
  };
}

class FakeFormData {
  constructor() {
    this.entries = [];
  }

  append(name, value, filename) {
    this.entries.push({ name, value, filename });
  }
}

async function main() {
  const batchInput = makeInput();

  record("canonical content-addressed input is order-invariant", () => {
    const requests = [
      { requestKey: "message-c", body: preparedBody("c") },
      { requestKey: "message-a", body: preparedBody("a") },
      { requestKey: "message-b", body: preparedBody("b") },
    ];
    const forward = buildBatchInput(requests);
    const reverse = buildBatchInput([...requests].reverse());
    assert.equal(forward.schemaVersion, BATCH_INPUT_SCHEMA_VERSION);
    assert.equal(forward.inputHash, reverse.inputHash);
    assert.equal(forward.jsonl, reverse.jsonl);
    assert.equal(forward.filename, `truth-model-batch-${forward.inputHash}.jsonl`);
    assert.equal(forward.bytes, Buffer.byteLength(forward.jsonl, "utf8"));
    assert.equal(forward.model, PINNED_MODEL);
    assert(Object.isFrozen(forward));
    assert(Object.isFrozen(forward.items[0].body));
    for (const item of forward.items) {
      const canonicalBodyBytes = Buffer.byteLength(JSON.stringify(item.body), "utf8");
      assert.equal(item.bodyBytes, canonicalBodyBytes);
      assert.equal(item.maxInputTokensUpperBound, canonicalBodyBytes);
      assert(item.maxInputTokensUpperBound + item.body.max_output_tokens <=
        MAX_ITEM_CONTEXT_TOKENS);
    }

    const customIds = new Set();
    const lines = parseJsonl(forward.jsonl);
    assert.equal(lines.length, requests.length);
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).sort(), ["body", "custom_id", "method", "url"]);
      assert.equal(line.method, "POST");
      assert.equal(line.url, RESPONSES_ENDPOINT);
      assert.equal(line.body.model, PINNED_MODEL);
      assert.equal(line.body.store, false);
      assert.equal(line.body.text.format.type, "json_schema");
      assert.equal(line.body.text.format.strict, true);
      assert.match(line.custom_id, /^truth-model-batch-v1-[0-9a-f]{64}$/);
      customIds.add(line.custom_id);
    }
    assert.equal(customIds.size, requests.length);
    assert.deepEqual(validateBatchInput(forward), forward);

    const tampered = JSON.parse(JSON.stringify(forward));
    tampered.items[0].bodyBytes += 1;
    expectCode(
      () => validateBatchInput(tampered),
      "OPENAI_TRUTH_MODEL_BATCH_MANIFEST_MISMATCH",
    );
  });

  record("prepared Responses bodies remain exact and schema-strict", () => {
    const body = preparedBody("exact");
    body.metadata = { immutable_source: "fixture" };
    const built = buildBatchInput([{ requestKey: "exact", body }]);
    assert.deepEqual(parseJsonl(built.jsonl)[0].body, body);
  });

  record("model and request bounds fail closed", () => {
    expectCode(
      () => buildBatchInput([{ requestKey: "alias", body: preparedBody("alias", "gpt-5-nano") }]),
      "OPENAI_TRUTH_MODEL_BATCH_MODEL_NOT_PINNED",
    );
    expectCode(
      () => buildBatchInput([
        { requestKey: "one", body: preparedBody("one") },
        { requestKey: "two", body: preparedBody("two", OTHER_PINNED_MODEL) },
      ]),
      "OPENAI_TRUTH_MODEL_BATCH_MIXED_MODELS",
    );
    expectCode(
      () => buildBatchInput([
        { requestKey: "duplicate", body: preparedBody("one") },
        { requestKey: "duplicate", body: preparedBody("two") },
      ]),
      "OPENAI_TRUTH_MODEL_BATCH_DUPLICATE_REQUEST_KEY",
    );
    expectCode(
      () => buildBatchInput([{ requestKey: "too-large", body: preparedBody("large") }], {
        maxInputBytes: 1,
      }),
      "OPENAI_TRUTH_MODEL_BATCH_INPUT_TOO_LARGE",
    );
    const overContext = preparedBody("over-context");
    overContext.input[1].content[0].text = "x".repeat(MAX_ITEM_CONTEXT_TOKENS);
    expectCode(
      () => buildBatchInput([{ requestKey: "over-context", body: overContext }]),
      "OPENAI_TRUTH_MODEL_BATCH_ITEM_CONTEXT_BOUND",
    );
  });

  record("storage and strict-schema invariants fail closed", () => {
    const stored = preparedBody("stored");
    stored.store = true;
    assert.throws(() => buildBatchInput([{ requestKey: "stored", body: stored }]), /store must be false/);
    const loose = preparedBody("loose");
    loose.text.format.strict = false;
    assert.throws(() => buildBatchInput([{ requestKey: "loose", body: loose }]), /strict json_schema/);
    const noCacheKey = preparedBody("cache");
    delete noCacheKey.prompt_cache_key;
    assert.throws(
      () => buildBatchInput([{ requestKey: "cache", body: noCacheKey }]),
      /prompt_cache_key/,
    );
  });

  record("unordered output and error lines reconcile exactly once", () => {
    const [first, second, third] = batchInput.items;
    const reconciled = reconcileBatchResults({
      batchInput,
      batch: rawBatch("completed", 3, { completed: 2, failed: 1 }),
      outputJsonl: toJsonl([responseLine(third, "three"), responseLine(first, "one")]),
      errorJsonl: toJsonl([errorLine(second, "two")]),
    });
    assert.equal(reconciled.schemaVersion, BATCH_RECONCILIATION_SCHEMA_VERSION);
    assert.equal(reconciled.expectedCount, 3);
    assert.equal(reconciled.terminalResultCount, 3);
    assert.equal(reconciled.exactCoverage, true);
    assert.deepEqual(reconciled.providerRequestCounts, { total: 3, completed: 2, failed: 1 });
    assert.deepEqual(reconciled.results.map((result) => result.customId),
      batchInput.items.map((item) => item.customId));
    assert.deepEqual(reconciled.counts, { response: 2, item_error: 1 });
    const success = reconciled.results.find((result) => result.customId === first.customId);
    assert.equal(success.schemaVersion, BATCH_RESULT_SCHEMA_VERSION);
    assert.equal(success.batchRequestId, "batch_req_one");
    assert.equal(success.serverRequestId, "req_one");
    assert.equal(success.responseId, "resp_one");
    assert.equal(success.requestedModel, PINNED_MODEL);
    assert.equal(success.actualModel, PINNED_MODEL);
    assert.equal(success.usage.cachedInputTokens, 5);
    assert.equal(success.usage.reasoningTokens, 2);
    assert.equal(success.usage.totalTokens, 20);
    assert.deepEqual(success.usage.raw, success.responseBody.usage);
    assert.equal(success.responseBody.output[0].id, "msg_one");
  });

  record("expired and cancelled batches preserve mixed per-item outcomes", () => {
    const [first, second, third] = batchInput.items;
    const expired = reconcileBatchResults({
      batchInput,
      batch: rawBatch("expired", 3, { completed: 1, failed: 2 }),
      outputJsonl: toJsonl([responseLine(first, "expired-success")]),
      errorJsonl: toJsonl([
        errorLine(third, "expired-unfinished", "batch_expired"),
        errorLine(second, "expired-item", "invalid_request_error"),
      ]),
    });
    assert.deepEqual(expired.counts, { response: 1, item_error: 1, expired: 1 });
    assert(expired.results.every((result) => result.batchStatus === "expired"));

    const cancelled = reconcileBatchResults({
      batchInput,
      batch: rawBatch("cancelled", 3, { completed: 1, failed: 2 }),
      outputJsonl: toJsonl([responseLine(second, "cancel-success")]),
      errorJsonl: toJsonl([
        errorLine(first, "cancel-one", "batch_cancelled"),
        errorLine(third, "cancel-three", "request_cancelled"),
      ]),
    });
    assert.deepEqual(cancelled.counts, { cancelled: 2, response: 1 });
  });

  record("provider request counts must match manifest and normalized outcomes", () => {
    const [first, second, third] = batchInput.items;
    const outputJsonl = toJsonl([responseLine(first, "count-one"), responseLine(second, "count-two")]);
    const errorJsonl = toJsonl([errorLine(third, "count-three")]);

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: rawBatch("completed", 3, { total: 4, completed: 2, failed: 1 }),
      outputJsonl,
      errorJsonl,
    }), "OPENAI_TRUTH_MODEL_BATCH_REQUEST_COUNT_MISMATCH");

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: rawBatch("completed", 3, { completed: 1, failed: 1 }),
      outputJsonl,
      errorJsonl,
    }), "OPENAI_TRUTH_MODEL_BATCH_REQUEST_COUNT_MISMATCH");

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: rawBatch("completed", 3, { completed: 2, failed: 0 }),
      outputJsonl,
      errorJsonl,
    }), "OPENAI_TRUTH_MODEL_BATCH_REQUEST_COUNT_MISMATCH");
  });

  record("item usage cannot exceed sealed input or prepared output bounds", () => {
    const singleInput = makeInput(1);
    const [item] = singleInput.items;
    const terminal = rawBatch("completed", 1);

    expectCode(() => reconcileBatchResults({
      batchInput: singleInput,
      batch: terminal,
      outputJsonl: toJsonl([responseLine(item, "usage-input", {
        inputTokens: item.maxInputTokensUpperBound + 1,
        cachedTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      })]),
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_USAGE_EXCEEDS_ITEM_BOUND");

    expectCode(() => reconcileBatchResults({
      batchInput: singleInput,
      batch: terminal,
      outputJsonl: toJsonl([responseLine(item, "usage-output", {
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: item.body.max_output_tokens + 1,
        reasoningTokens: 0,
      })]),
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_USAGE_EXCEEDS_ITEM_BOUND");
  });

  record("duplicate unknown missing and premature results fail closed", () => {
    const [first, second, third] = batchInput.items;
    const terminal = rawBatch("completed", 3);
    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: terminal,
      outputJsonl: toJsonl([
        responseLine(first, "duplicate-one"),
        responseLine(first, "duplicate-two"),
        responseLine(second, "second"),
        responseLine(third, "third"),
      ]),
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_DUPLICATE_RESULT");

    const unknown = responseLine(first, "unknown");
    unknown.custom_id = `truth-model-batch-v1-${"f".repeat(64)}`;
    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: terminal,
      outputJsonl: toJsonl([unknown]),
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_UNKNOWN_CUSTOM_ID");

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: terminal,
      outputJsonl: toJsonl([responseLine(first, "only-one")]),
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_MISSING_RESULTS");

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: rawBatch("in_progress", 3, { failed: 0 }),
      outputJsonl: "",
      errorJsonl: "",
    }), "OPENAI_TRUTH_MODEL_BATCH_NOT_TERMINAL");

    expectCode(() => reconcileBatchResults({
      batchInput,
      batch: terminal,
      outputJsonl: toJsonl([responseLine(first, "bounded")]),
      errorJsonl: "",
      maxResultBytes: 1,
    }), "OPENAI_TRUTH_MODEL_BATCH_RESULT_TOO_LARGE");
  });

  record("client construction requires explicit injected fetch", () => {
    assert.throws(
      () => createOpenAITruthModelBatchClient({ apiKey: FAKE_API_KEY }),
      /options.fetch must be an injected function/,
    );
  });

  await recordAsync("upload and create are separate crash-safe mutations", async () => {
    const calls = [];
    const forms = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        assert.equal(url, `${API_ORIGIN}/v1/files`);
        assert.equal(init.method, "POST");
        assert.deepEqual(init.headers, {
          Authorization: `Bearer ${FAKE_API_KEY}`,
          "X-Client-Request-Id": buildBatchClientRequestId(batchInput.inputHash, "upload"),
        });
        assert(init.body instanceof FakeFormData);
        assert.equal(init.body.entries.length, 2);
        assert.deepEqual(init.body.entries[0], {
          name: "purpose",
          value: "batch",
          filename: undefined,
        });
        assert.equal(init.body.entries[1].name, "file");
        assert.equal(init.body.entries[1].filename, batchInput.filename);
        assert.equal(init.body.entries[1].value.contents, batchInput.jsonl);
        forms.push(init.body);
        return fakeJsonResponse({ id: "file-uploaded-truth-001", purpose: "batch" }, "req_upload");
      }
      assert.equal(calls.length, 2);
      assert.equal(url, `${API_ORIGIN}/v1/batches`);
      assert.equal(init.method, "POST");
      assert.deepEqual(init.headers, {
        Authorization: `Bearer ${FAKE_API_KEY}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": buildBatchClientRequestId(batchInput.inputHash, "create"),
      });
      assert.deepEqual(JSON.parse(init.body), {
        input_file_id: "file-uploaded-truth-001",
        endpoint: RESPONSES_ENDPOINT,
        completion_window: COMPLETION_WINDOW,
      });
      return fakeJsonResponse(rawBatch("validating", 3, {
        inputFileId: "file-uploaded-truth-001",
        failed: 0,
      }), "req_create");
    };
    const client = createOpenAITruthModelBatchClient({
      apiKey: FAKE_API_KEY,
      fetch,
      formDataFactory: () => new FakeFormData(),
      filePartFactory: ({ contents, filename, contentType }) => ({
        contents,
        filename,
        contentType,
      }),
    });
    assert.equal(client.submitBatch, undefined);
    assert.deepEqual(Object.keys(client).sort(), [
      "createBatch",
      "retrieveBatch",
      "retrieveFileContent",
      "retrieveOnce",
      "uploadBatchInput",
    ]);
    const upload = await client.uploadBatchInput(batchInput);
    assert.equal(calls.length, 1);
    assert.equal(forms.length, 1);
    assert.equal(upload.serverRequestId, "req_upload");
    assert.equal(upload.clientRequestId, buildBatchClientRequestId(batchInput.inputHash, "upload"));

    const created = await client.createBatch(upload.fileId, batchInput.inputHash);
    assert.equal(calls.length, 2);
    assert.equal(created.batch.status, "validating");
    assert.equal(created.serverRequestId, "req_create");
    assert.equal(created.clientRequestId, buildBatchClientRequestId(batchInput.inputHash, "create"));
    assert.notEqual(upload.clientRequestId, created.clientRequestId);
  });

  await recordAsync("nonterminal retrieval is one bounded GET", async () => {
    const calls = [];
    const client = createOpenAITruthModelBatchClient({
      apiKey: FAKE_API_KEY,
      fetch: async (url, init) => {
        calls.push({ url, init });
        assert.equal(url, `${API_ORIGIN}/v1/batches/batch_test_truth_001`);
        assert.equal(init.method, "GET");
        return fakeJsonResponse(rawBatch("in_progress", 3, { failed: 0 }), "req_retrieve_once");
      },
    });
    const result = await client.retrieveOnce({ batchId: "batch_test_truth_001", batchInput });
    assert.equal(calls.length, 1);
    assert.equal(result.ready, false);
    assert.equal(result.reconciliation, null);
    assert.deepEqual(result.requestIds, {
      retrieve: "req_retrieve_once",
      outputFile: "",
      errorFile: "",
    });
  });

  await recordAsync("terminal retrieval reads each result file once and never resubmits", async () => {
    const [first, second, third] = batchInput.items;
    const outputJsonl = toJsonl([responseLine(third, "terminal-three")]);
    const errorJsonl = toJsonl([
      errorLine(first, "terminal-expired", "batch_expired"),
      errorLine(second, "terminal-item", "invalid_request_error"),
    ]);
    const calls = [];
    const client = createOpenAITruthModelBatchClient({
      apiKey: FAKE_API_KEY,
      fetch: async (url, init) => {
        calls.push({ url, init });
        assert.equal(init.method, "GET");
        if (url.endsWith("/v1/batches/batch_test_truth_001")) {
          return fakeJsonResponse(rawBatch("expired", 3, {
            completed: 1,
            failed: 2,
            outputFileId: "file-output-truth-001",
            errorFileId: "file-error-truth-001",
            usage: {
              input_tokens: 39,
              input_tokens_details: { cached_tokens: 15 },
              output_tokens: 21,
              output_tokens_details: { reasoning_tokens: 6 },
              total_tokens: 60,
            },
          }), "req_terminal_retrieve");
        }
        if (url.endsWith("/v1/files/file-output-truth-001/content")) {
          return fakeTextResponse(outputJsonl, "req_output_file");
        }
        if (url.endsWith("/v1/files/file-error-truth-001/content")) {
          return fakeTextResponse(errorJsonl, "req_error_file");
        }
        throw new Error(`Unexpected fake URL: ${url}`);
      },
    });
    const result = await client.retrieveOnce({ batchId: "batch_test_truth_001", batchInput });
    assert.equal(result.ready, true);
    assert.equal(result.batch.model, PINNED_MODEL);
    assert.equal(result.batch.usage.inputTokens, 39);
    assert.equal(result.batch.usage.cachedInputTokens, 15);
    assert.equal(result.batch.usage.raw.total_tokens, 60);
    assert.equal(calls.length, 3);
    assert(calls.every((call) => call.init.method === "GET"));
    assert.equal(calls.filter((call) => call.url.includes("/v1/batches")).length, 1);
    assert.equal(calls.filter((call) => call.url.includes("/content")).length, 2);
    assert.deepEqual(result.reconciliation.counts, {
      expired: 1,
      item_error: 1,
      response: 1,
    });
    assert.deepEqual(result.requestIds, {
      retrieve: "req_terminal_retrieve",
      outputFile: "req_output_file",
      errorFile: "req_error_file",
    });
  });

  await recordAsync("unknown POST transport outcome is explicit and not retried", async () => {
    let calls = 0;
    const client = createOpenAITruthModelBatchClient({
      apiKey: FAKE_API_KEY,
      fetch: async () => {
        calls += 1;
        throw new Error("synthetic disconnect");
      },
      formDataFactory: () => new FakeFormData(),
      filePartFactory: (input) => input,
    });
    await expectCodeAsync(
      () => client.uploadBatchInput(batchInput),
      "OPENAI_TRUTH_MODEL_BATCH_TRANSPORT_OUTCOME_UNKNOWN",
      (error) => {
        assert.equal(error.outcomeUnknown, true);
        assert.equal(error.retryable, false);
        assert.equal(
          error.clientRequestId,
          buildBatchClientRequestId(batchInput.inputHash, "upload"),
        );
      },
    );
    assert.equal(calls, 1);
  });

  assert.equal(globalNetworkCalls, 0);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    verifier: "openai-truth-model-batch",
    checks,
    liveCalls: 0,
    globalNetworkCalls,
    modelCalls: 0,
    autoResubmits: 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

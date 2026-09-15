"use strict";

// Official protocol references:
// https://developers.openai.com/api/docs/guides/batch
// https://developers.openai.com/api/reference/resources/batches/methods/create
// https://developers.openai.com/api/reference/resources/responses/methods/create

const crypto = require("node:crypto");

const API_ORIGIN = "https://api.openai.com";
const RESPONSES_ENDPOINT = "/v1/responses";
const COMPLETION_WINDOW = "24h";
const BATCH_INPUT_SCHEMA_VERSION = "openai-truth-model-batch-input-v1";
const BATCH_RESULT_SCHEMA_VERSION = "openai-truth-model-batch-result-v1";
const BATCH_RECONCILIATION_SCHEMA_VERSION = "openai-truth-model-batch-reconciliation-v1";
const CUSTOM_ID_PREFIX = "truth-model-batch-v1-";
const CLIENT_REQUEST_ID_PREFIX = "pikiio-truth-model-batch-v1";
const CUSTOM_ID_RE = /^truth-model-batch-v1-[0-9a-f]{64}$/;
const PINNED_MODEL_RE = /^[A-Za-z0-9._:-]+-\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const BATCH_ID_RE = /^batch_[A-Za-z0-9_-]+$/;
const FILE_ID_RE = /^file-[A-Za-z0-9_-]+$/;
const DEFAULT_MAX_REQUESTS = 1_000;
const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 50 * 1024 * 1024;
const MAX_REQUESTS = 50_000;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_RESULT_LINE_BYTES = 4 * 1024 * 1024;
// GPT-5 nano's documented context window is 400,000 tokens. Using canonical
// UTF-8 body bytes as the input-token upper bound is intentionally conservative.
const MAX_ITEM_CONTEXT_TOKENS = 400_000;
const BATCH_STATUSES = Object.freeze([
  "validating",
  "failed",
  "in_progress",
  "finalizing",
  "completed",
  "expired",
  "cancelling",
  "cancelled",
]);
const TERMINAL_BATCH_STATUSES = Object.freeze(["failed", "completed", "expired", "cancelled"]);
const TERMINAL_BATCH_STATUS_SET = new Set(TERMINAL_BATCH_STATUSES);
const BATCH_STATUS_SET = new Set(BATCH_STATUSES);

class OpenAITruthModelBatchError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "OpenAITruthModelBatchError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function batchError(message, fields = {}) {
  return new OpenAITruthModelBatchError(message, {
    code: fields.code || "OPENAI_TRUTH_MODEL_BATCH_INVALID",
    ...fields,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value, keys, field) {
  if (!isPlainObject(value)) {
    throw batchError(`${field} must be an object`, { field });
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw batchError(`${field}.${key} is unsupported`, { field: `${field}.${key}` });
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw batchError(`${field}.${key} is required`, { field: `${field}.${key}` });
    }
  }
}

function exactKeysWithOptional(value, requiredKeys, optionalKeys, field) {
  if (!isPlainObject(value)) {
    throw batchError(`${field} must be an object`, { field });
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw batchError(`${field}.${key} is unsupported`, { field: `${field}.${key}` });
    }
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw batchError(`${field}.${key} is required`, { field: `${field}.${key}` });
    }
  }
}

function string(value, field, options = {}) {
  const minimumBytes = options.minimumBytes ?? 1;
  const maximumBytes = options.maximumBytes ?? 4096;
  if (typeof value !== "string" || value.trim() !== value) {
    throw batchError(`${field} must be a trimmed string`, { field });
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw batchError(`${field} must contain ${minimumBytes} through ${maximumBytes} UTF-8 bytes`, {
      field,
    });
  }
  return value;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === "") return "";
  return string(value, field, options);
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw batchError(`${field} must be an integer from ${minimum} through ${maximum}`, { field });
  }
  return value;
}

function canonicalize(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw batchError(`${field} contains a non-finite number`, { field });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  }
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw batchError(`${field}.${key} is forbidden`, { field: `${field}.${key}` });
      }
      if (value[key] === undefined) {
        throw batchError(`${field}.${key} must not be undefined`, { field: `${field}.${key}` });
      }
      result[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return result;
  }
  throw batchError(`${field} must contain only JSON-compatible values`, { field });
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildBatchClientRequestId(inputHash, operation) {
  const hash = string(inputHash, "inputHash", { minimumBytes: 64, maximumBytes: 64 });
  if (!HASH_RE.test(hash)) {
    throw batchError("inputHash must be a lowercase SHA-256 digest", { field: "inputHash" });
  }
  if (!new Set(["upload", "create"]).has(operation)) {
    throw batchError("operation must be upload or create", { field: "operation" });
  }
  // Correlation evidence only. This value never grants retry or idempotency authority.
  return `${CLIENT_REQUEST_ID_PREFIX}-${operation}-${hash}`;
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizePreparedResponsesBody(value, field = "body") {
  const body = canonicalize(value, field);
  if (!isPlainObject(body)) {
    throw batchError(`${field} must be an object`, { field });
  }
  const model = string(body.model, `${field}.model`, { maximumBytes: 200 });
  if (!PINNED_MODEL_RE.test(model)) {
    throw batchError(`${field}.model must be a pinned YYYY-MM-DD model snapshot`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_MODEL_NOT_PINNED",
      field: `${field}.model`,
    });
  }
  if (body.store !== false) {
    throw batchError(`${field}.store must be false`, { field: `${field}.store` });
  }
  if (!(typeof body.input === "string" || Array.isArray(body.input))) {
    throw batchError(`${field}.input must be a string or array`, { field: `${field}.input` });
  }
  if (body.stream === true) {
    throw batchError(`${field}.stream must not be true for Batch`, { field: `${field}.stream` });
  }
  integer(body.max_output_tokens, `${field}.max_output_tokens`, 1, 100_000);
  string(body.prompt_cache_key, `${field}.prompt_cache_key`, { maximumBytes: 500 });
  if (!isPlainObject(body.text) || !isPlainObject(body.text.format)) {
    throw batchError(`${field}.text.format must be a strict JSON Schema format`, {
      field: `${field}.text.format`,
    });
  }
  const format = body.text.format;
  if (format.type !== "json_schema" || format.strict !== true || !isPlainObject(format.schema)) {
    throw batchError(`${field}.text.format must use strict json_schema`, {
      field: `${field}.text.format`,
    });
  }
  string(format.name, `${field}.text.format.name`, { maximumBytes: 64 });
  return deepFreeze(body);
}

function normalizeBuildOptions(options = {}) {
  if (!isPlainObject(options)) {
    throw batchError("options must be an object", { field: "options" });
  }
  for (const key of Object.keys(options)) {
    if (!["pinnedModel", "maxRequests", "maxInputBytes"].includes(key)) {
      throw batchError(`options.${key} is unsupported`, { field: `options.${key}` });
    }
  }
  const pinnedModel = options.pinnedModel === undefined
    ? ""
    : string(options.pinnedModel, "options.pinnedModel", { maximumBytes: 200 });
  if (pinnedModel && !PINNED_MODEL_RE.test(pinnedModel)) {
    throw batchError("options.pinnedModel must be a pinned YYYY-MM-DD model snapshot", {
      code: "OPENAI_TRUTH_MODEL_BATCH_MODEL_NOT_PINNED",
      field: "options.pinnedModel",
    });
  }
  const maxRequests = integer(
    options.maxRequests ?? DEFAULT_MAX_REQUESTS,
    "options.maxRequests",
    1,
    MAX_REQUESTS,
  );
  const maxInputBytes = integer(
    options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    "options.maxInputBytes",
    1,
    MAX_INPUT_BYTES,
  );
  return Object.freeze({ pinnedModel, maxRequests, maxInputBytes });
}

function buildBatchInput(requests, options = {}) {
  const limits = normalizeBuildOptions(options);
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > limits.maxRequests) {
    throw batchError(`requests must contain one through ${limits.maxRequests} items`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_REQUEST_BOUND",
      field: "requests",
    });
  }
  const requestKeys = new Set();
  const customIds = new Set();
  let model = limits.pinnedModel;
  const items = requests.map((request, index) => {
    exactKeys(request, ["requestKey", "body"], `requests[${index}]`);
    const requestKey = string(request.requestKey, `requests[${index}].requestKey`, {
      maximumBytes: 500,
    });
    if (requestKeys.has(requestKey)) {
      throw batchError(`requests[${index}].requestKey is duplicated`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_DUPLICATE_REQUEST_KEY",
        field: `requests[${index}].requestKey`,
      });
    }
    requestKeys.add(requestKey);
    const body = normalizePreparedResponsesBody(request.body, `requests[${index}].body`);
    if (!model) model = body.model;
    if (body.model !== model) {
      throw batchError("A Batch input file must contain exactly one pinned model", {
        code: "OPENAI_TRUTH_MODEL_BATCH_MIXED_MODELS",
        field: `requests[${index}].body.model`,
      });
    }
    const bodyJson = stableJson(body);
    const bodyBytes = Buffer.byteLength(bodyJson, "utf8");
    const maxInputTokensUpperBound = bodyBytes;
    if (maxInputTokensUpperBound + body.max_output_tokens > MAX_ITEM_CONTEXT_TOKENS) {
      throw batchError(
        `requests[${index}] exceeds the conservative ${MAX_ITEM_CONTEXT_TOKENS}-token context bound`,
        {
          code: "OPENAI_TRUTH_MODEL_BATCH_ITEM_CONTEXT_BOUND",
          field: `requests[${index}].body`,
          bodyBytes,
          maxInputTokensUpperBound,
          maxOutputTokens: body.max_output_tokens,
          maxItemContextTokens: MAX_ITEM_CONTEXT_TOKENS,
        },
      );
    }
    const itemHash = sha256(stableJson({
      schemaVersion: "openai-truth-model-batch-item-v1",
      requestKey,
      bodyBytes,
      maxInputTokensUpperBound,
      body,
    }));
    const customId = `${CUSTOM_ID_PREFIX}${itemHash}`;
    if (customIds.has(customId)) {
      throw batchError(`requests[${index}] produced a duplicate custom_id`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_DUPLICATE_CUSTOM_ID",
        field: `requests[${index}]`,
      });
    }
    customIds.add(customId);
    return {
      requestKey,
      customId,
      itemHash,
      bodyHash: sha256(bodyJson),
      bodyBytes,
      maxInputTokensUpperBound,
      body,
    };
  }).sort((left, right) => left.customId.localeCompare(right.customId));
  const lines = items.map((item) => stableJson({
    custom_id: item.customId,
    method: "POST",
    url: RESPONSES_ENDPOINT,
    body: item.body,
  }));
  const jsonl = `${lines.join("\n")}\n`;
  const bytes = Buffer.byteLength(jsonl, "utf8");
  if (bytes > limits.maxInputBytes) {
    throw batchError(`Batch JSONL exceeds the ${limits.maxInputBytes}-byte bound`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_INPUT_TOO_LARGE",
      field: "requests",
      bytes,
      maxInputBytes: limits.maxInputBytes,
    });
  }
  const inputHash = sha256(jsonl);
  return deepFreeze({
    schemaVersion: BATCH_INPUT_SCHEMA_VERSION,
    model,
    requestCount: items.length,
    inputHash,
    jsonl,
    bytes,
    filename: `truth-model-batch-${inputHash}.jsonl`,
    items,
  });
}

function validateBatchInput(value) {
  exactKeys(value, [
    "schemaVersion",
    "model",
    "requestCount",
    "inputHash",
    "jsonl",
    "bytes",
    "filename",
    "items",
  ], "batchInput");
  if (value.schemaVersion !== BATCH_INPUT_SCHEMA_VERSION) {
    throw batchError(`batchInput.schemaVersion must be ${BATCH_INPUT_SCHEMA_VERSION}`, {
      field: "batchInput.schemaVersion",
    });
  }
  if (!Array.isArray(value.items)) {
    throw batchError("batchInput.items must be an array", { field: "batchInput.items" });
  }
  const rebuilt = buildBatchInput(value.items.map((item, index) => {
    if (!isPlainObject(item)) {
      throw batchError(`batchInput.items[${index}] must be an object`, {
        field: `batchInput.items[${index}]`,
      });
    }
    return { requestKey: item.requestKey, body: item.body };
  }), {
    pinnedModel: value.model,
    maxRequests: MAX_REQUESTS,
    maxInputBytes: MAX_INPUT_BYTES,
  });
  if (!sameJson(rebuilt, value)) {
    throw batchError("batchInput does not match its canonical content-addressed JSONL", {
      code: "OPENAI_TRUTH_MODEL_BATCH_MANIFEST_MISMATCH",
      field: "batchInput",
    });
  }
  return rebuilt;
}

function normalizeCount(value, field) {
  if (value === undefined || value === null) return 0;
  return integer(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeBatch(value, options = {}) {
  if (!isPlainObject(value)) {
    throw batchError("batch must be an object", { field: "batch" });
  }
  const id = string(value.id, "batch.id", { maximumBytes: 200 });
  if (!BATCH_ID_RE.test(id)) {
    throw batchError("batch.id is invalid", { field: "batch.id" });
  }
  if (value.object !== undefined && value.object !== "batch") {
    throw batchError("batch.object must be batch", { field: "batch.object" });
  }
  if (value.endpoint !== RESPONSES_ENDPOINT) {
    throw batchError(`batch.endpoint must be ${RESPONSES_ENDPOINT}`, { field: "batch.endpoint" });
  }
  if (value.completion_window !== COMPLETION_WINDOW) {
    throw batchError(`batch.completion_window must be ${COMPLETION_WINDOW}`, {
      field: "batch.completion_window",
    });
  }
  const inputFileId = string(value.input_file_id, "batch.input_file_id", { maximumBytes: 200 });
  if (!FILE_ID_RE.test(inputFileId)) {
    throw batchError("batch.input_file_id is invalid", { field: "batch.input_file_id" });
  }
  if (options.expectedInputFileId && inputFileId !== options.expectedInputFileId) {
    throw batchError("batch.input_file_id does not match the uploaded input file", {
      code: "OPENAI_TRUTH_MODEL_BATCH_INPUT_FILE_MISMATCH",
      field: "batch.input_file_id",
    });
  }
  const status = string(value.status, "batch.status", { maximumBytes: 30 });
  if (!BATCH_STATUS_SET.has(status)) {
    throw batchError("batch.status is unsupported", { field: "batch.status" });
  }
  const model = optionalString(value.model, "batch.model", { maximumBytes: 200 });
  const usage = value.usage === undefined || value.usage === null
    ? null
    : normalizeUsage(value.usage, "batch.usage");
  const outputFileId = optionalString(value.output_file_id, "batch.output_file_id", {
    maximumBytes: 200,
  });
  const errorFileId = optionalString(value.error_file_id, "batch.error_file_id", {
    maximumBytes: 200,
  });
  for (const [field, fileId] of [["output_file_id", outputFileId], ["error_file_id", errorFileId]]) {
    if (fileId && !FILE_ID_RE.test(fileId)) {
      throw batchError(`batch.${field} is invalid`, { field: `batch.${field}` });
    }
  }
  const counts = isPlainObject(value.request_counts) ? value.request_counts : {};
  const requestCounts = Object.freeze({
    total: normalizeCount(counts.total, "batch.request_counts.total"),
    completed: normalizeCount(counts.completed, "batch.request_counts.completed"),
    failed: normalizeCount(counts.failed, "batch.request_counts.failed"),
  });
  if (requestCounts.completed + requestCounts.failed > requestCounts.total) {
    throw batchError("batch.request_counts exceed their total", { field: "batch.request_counts" });
  }
  const timestamps = {};
  for (const field of [
    "created_at",
    "in_progress_at",
    "expires_at",
    "finalizing_at",
    "completed_at",
    "failed_at",
    "expired_at",
    "cancelling_at",
    "cancelled_at",
  ]) {
    const timestamp = value[field];
    if (timestamp !== undefined && timestamp !== null) {
      timestamps[field] = integer(timestamp, `batch.${field}`, 0, Number.MAX_SAFE_INTEGER);
    }
  }
  return deepFreeze({
    id,
    status,
    model,
    endpoint: RESPONSES_ENDPOINT,
    completionWindow: COMPLETION_WINDOW,
    inputFileId,
    outputFileId,
    errorFileId,
    requestCounts,
    usage,
    timestamps,
    errors: value.errors === undefined ? null : canonicalize(value.errors, "batch.errors"),
    metadata: value.metadata === undefined ? null : canonicalize(value.metadata, "batch.metadata"),
    terminal: TERMINAL_BATCH_STATUS_SET.has(status),
  });
}

function parseJsonl(contents, source, maxBytes) {
  if (typeof contents !== "string") {
    throw batchError(`${source} JSONL must be a string`, { field: source });
  }
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > maxBytes) {
    throw batchError(`${source} JSONL exceeds its read bound`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_TOO_LARGE",
      field: source,
      bytes,
      maxBytes,
    });
  }
  if (!contents) return [];
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    if (!line.trim()) {
      throw batchError(`${source} JSONL line ${index + 1} is blank`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_JSONL_INVALID",
        field: `${source}[${index}]`,
      });
    }
    if (Buffer.byteLength(line, "utf8") > MAX_RESULT_LINE_BYTES) {
      throw batchError(`${source} JSONL line ${index + 1} exceeds its bound`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_JSONL_INVALID",
        field: `${source}[${index}]`,
      });
    }
    try {
      return canonicalize(JSON.parse(line), `${source}[${index}]`);
    } catch (cause) {
      if (cause instanceof OpenAITruthModelBatchError) throw cause;
      throw batchError(`${source} JSONL line ${index + 1} is malformed`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_JSONL_INVALID",
        field: `${source}[${index}]`,
        cause,
      });
    }
  });
}

function usageInteger(value, field) {
  return integer(value, field, 0, Number.MAX_SAFE_INTEGER);
}

function normalizeUsage(value, field) {
  if (!isPlainObject(value) || !isPlainObject(value.input_tokens_details) ||
      !isPlainObject(value.output_tokens_details)) {
    throw batchError(`${field} must include input and output token details`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_USAGE_INVALID",
      field,
    });
  }
  const usage = {
    inputTokens: usageInteger(value.input_tokens, `${field}.input_tokens`),
    cachedInputTokens: usageInteger(
      value.input_tokens_details.cached_tokens,
      `${field}.input_tokens_details.cached_tokens`,
    ),
    outputTokens: usageInteger(value.output_tokens, `${field}.output_tokens`),
    reasoningTokens: usageInteger(
      value.output_tokens_details.reasoning_tokens,
      `${field}.output_tokens_details.reasoning_tokens`,
    ),
    totalTokens: usageInteger(value.total_tokens, `${field}.total_tokens`),
    raw: canonicalize(value, field),
  };
  if (usage.cachedInputTokens > usage.inputTokens ||
      usage.reasoningTokens > usage.outputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw batchError(`${field} token totals are inconsistent`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_USAGE_INVALID",
      field,
    });
  }
  return Object.freeze(usage);
}

function validateItemUsage(usage, expectedItem, field) {
  if (usage.inputTokens > expectedItem.maxInputTokensUpperBound) {
    throw batchError(`${field}.input_tokens exceeds the sealed input-token upper bound`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_USAGE_EXCEEDS_ITEM_BOUND",
      field: `${field}.input_tokens`,
      actualInputTokens: usage.inputTokens,
      maxInputTokensUpperBound: expectedItem.maxInputTokensUpperBound,
      customId: expectedItem.customId,
    });
  }
  if (usage.outputTokens > expectedItem.body.max_output_tokens) {
    throw batchError(`${field}.output_tokens exceeds the prepared request maximum`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_USAGE_EXCEEDS_ITEM_BOUND",
      field: `${field}.output_tokens`,
      actualOutputTokens: usage.outputTokens,
      maxOutputTokens: expectedItem.body.max_output_tokens,
      customId: expectedItem.customId,
    });
  }
  return usage;
}

function normalizedErrorOutcome(error) {
  const code = String(error?.code || "").toLowerCase();
  if (code === "batch_expired") return "expired";
  if (code.includes("cancel")) return "cancelled";
  if (code === "batch_failed" || code === "batch_validation_failed") return "batch_failed";
  return "item_error";
}

function normalizeResultLine(line, source, expectedItem, batch) {
  exactKeys(line, ["id", "custom_id", "response", "error"], source.field);
  const batchRequestId = string(line.id, `${source.field}.id`, { maximumBytes: 200 });
  const customId = string(line.custom_id, `${source.field}.custom_id`, { maximumBytes: 200 });
  if (!CUSTOM_ID_RE.test(customId)) {
    throw batchError(`${source.field}.custom_id is invalid`, { field: `${source.field}.custom_id` });
  }
  if (source.kind === "output") {
    if (!isPlainObject(line.response) || line.error !== null) {
      throw batchError(`${source.field} must contain one response and null error`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_SHAPE_INVALID",
        field: source.field,
      });
    }
  } else if (line.response !== null || !isPlainObject(line.error)) {
    throw batchError(`${source.field} must contain null response and one error`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_SHAPE_INVALID",
      field: source.field,
    });
  }

  if (line.response !== null) {
    exactKeys(line.response, ["status_code", "request_id", "body"], `${source.field}.response`);
    const statusCode = integer(
      line.response.status_code,
      `${source.field}.response.status_code`,
      100,
      599,
    );
    const serverRequestId = string(
      line.response.request_id,
      `${source.field}.response.request_id`,
      { maximumBytes: 200 },
    );
    const responseBody = canonicalize(line.response.body, `${source.field}.response.body`);
    if (!isPlainObject(responseBody)) {
      throw batchError(`${source.field}.response.body must be an object`, {
        field: `${source.field}.response.body`,
      });
    }
    if (statusCode >= 200 && statusCode < 300) {
      const responseId = string(responseBody.id, `${source.field}.response.body.id`, {
        maximumBytes: 200,
      });
      const actualModel = string(responseBody.model, `${source.field}.response.body.model`, {
        maximumBytes: 200,
      });
      const usageField = `${source.field}.response.body.usage`;
      const usage = validateItemUsage(
        normalizeUsage(responseBody.usage, usageField),
        expectedItem,
        usageField,
      );
      return deepFreeze({
        schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
        requestKey: expectedItem.requestKey,
        customId,
        batchRequestId,
        batchId: batch.id,
        batchStatus: batch.status,
        outcome: "response",
        requestedModel: expectedItem.body.model,
        statusCode,
        serverRequestId,
        responseId,
        actualModel,
        responseStatus: optionalString(
          responseBody.status,
          `${source.field}.response.body.status`,
          { maximumBytes: 50 },
        ),
        usage,
        responseBody,
        error: null,
      });
    }
    const providerError = isPlainObject(responseBody.error)
      ? canonicalize(responseBody.error, `${source.field}.response.body.error`)
      : { code: `http_${statusCode}`, message: "Batch item returned a non-success status" };
    return deepFreeze({
      schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
      requestKey: expectedItem.requestKey,
      customId,
      batchRequestId,
      batchId: batch.id,
      batchStatus: batch.status,
      outcome: normalizedErrorOutcome(providerError),
      requestedModel: expectedItem.body.model,
      statusCode,
      serverRequestId,
      responseId: optionalString(responseBody.id, `${source.field}.response.body.id`, {
        maximumBytes: 200,
      }),
      actualModel: optionalString(responseBody.model, `${source.field}.response.body.model`, {
        maximumBytes: 200,
      }),
      responseStatus: optionalString(responseBody.status, `${source.field}.response.body.status`, {
        maximumBytes: 50,
      }),
      usage: null,
      responseBody,
      error: providerError,
    });
  }

  const providerError = canonicalize(line.error, `${source.field}.error`);
  const code = string(providerError.code, `${source.field}.error.code`, { maximumBytes: 200 });
  const message = string(providerError.message, `${source.field}.error.message`, {
    maximumBytes: 4000,
  });
  return deepFreeze({
    schemaVersion: BATCH_RESULT_SCHEMA_VERSION,
    requestKey: expectedItem.requestKey,
    customId,
    batchRequestId,
    batchId: batch.id,
    batchStatus: batch.status,
    outcome: normalizedErrorOutcome({ code }),
    requestedModel: expectedItem.body.model,
    statusCode: null,
    serverRequestId: "",
    responseId: "",
    actualModel: "",
    responseStatus: "",
    usage: null,
    responseBody: null,
    error: { ...providerError, code, message },
  });
}

function reconcileBatchResults(input = {}) {
  exactKeysWithOptional(
    input,
    ["batchInput", "batch", "outputJsonl", "errorJsonl"],
    ["maxResultBytes"],
    "input",
  );
  const batchInput = validateBatchInput(input.batchInput);
  const batch = normalizeBatch(input.batch);
  if (!batch.terminal) {
    throw batchError("Batch results cannot be reconciled before the batch is terminal", {
      code: "OPENAI_TRUTH_MODEL_BATCH_NOT_TERMINAL",
      field: "input.batch.status",
    });
  }
  if (batch.requestCounts.total !== batchInput.requestCount) {
    throw batchError("Batch request_counts.total does not match the sealed manifest count", {
      code: "OPENAI_TRUTH_MODEL_BATCH_REQUEST_COUNT_MISMATCH",
      field: "input.batch.request_counts.total",
      expected: batchInput.requestCount,
      actual: batch.requestCounts.total,
    });
  }
  const maxResultBytes = integer(
    input.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    "input.maxResultBytes",
    1,
    MAX_INPUT_BYTES,
  );
  const expected = new Map(batchInput.items.map((item) => [item.customId, item]));
  const seen = new Map();
  const sources = [
    ["output", parseJsonl(input.outputJsonl, "outputJsonl", maxResultBytes)],
    ["error", parseJsonl(input.errorJsonl, "errorJsonl", maxResultBytes)],
  ];
  for (const [kind, lines] of sources) {
    lines.forEach((line, index) => {
      const field = `${kind}Jsonl[${index}]`;
      if (!isPlainObject(line)) {
        throw batchError(`${field} must be an object`, { field });
      }
      const customId = string(line.custom_id, `${field}.custom_id`, { maximumBytes: 200 });
      if (!expected.has(customId)) {
        throw batchError(`${field}.custom_id is unknown`, {
          code: "OPENAI_TRUTH_MODEL_BATCH_UNKNOWN_CUSTOM_ID",
          field: `${field}.custom_id`,
          customId,
        });
      }
      if (seen.has(customId)) {
        throw batchError(`${field}.custom_id is duplicated`, {
          code: "OPENAI_TRUTH_MODEL_BATCH_DUPLICATE_RESULT",
          field: `${field}.custom_id`,
          customId,
        });
      }
      seen.set(customId, normalizeResultLine(
        line,
        { kind, field },
        expected.get(customId),
        batch,
      ));
    });
  }
  const missing = batchInput.items
    .map((item) => item.customId)
    .filter((customId) => !seen.has(customId));
  if (missing.length) {
    throw batchError(`Batch result files are missing ${missing.length} expected custom_id value(s)`, {
      code: "OPENAI_TRUTH_MODEL_BATCH_MISSING_RESULTS",
      field: "input",
      missingCustomIds: missing,
    });
  }
  const results = batchInput.items.map((item) => seen.get(item.customId));
  const counts = results.reduce((output, result) => {
    output[result.outcome] = (output[result.outcome] || 0) + 1;
    return output;
  }, {});
  const normalizedCompleted = counts.response || 0;
  const normalizedFailed = results.length - normalizedCompleted;
  if (batch.requestCounts.completed !== normalizedCompleted ||
      batch.requestCounts.failed !== normalizedFailed) {
    throw batchError("Batch request_counts completed/failed do not match normalized outcomes", {
      code: "OPENAI_TRUTH_MODEL_BATCH_REQUEST_COUNT_MISMATCH",
      field: "input.batch.request_counts",
      expectedCompleted: normalizedCompleted,
      actualCompleted: batch.requestCounts.completed,
      expectedFailed: normalizedFailed,
      actualFailed: batch.requestCounts.failed,
    });
  }
  return deepFreeze({
    schemaVersion: BATCH_RECONCILIATION_SCHEMA_VERSION,
    batchId: batch.id,
    batchStatus: batch.status,
    inputHash: batchInput.inputHash,
    model: batchInput.model,
    expectedCount: batchInput.requestCount,
    terminalResultCount: results.length,
    exactCoverage: true,
    providerRequestCounts: batch.requestCounts,
    counts,
    results,
  });
}

function responseRequestId(response) {
  if (!response?.headers || typeof response.headers.get !== "function") return "";
  const value = response.headers.get("x-request-id");
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

function safeProviderMessage(payload, status) {
  const message = payload?.error?.message || payload?.message || `OpenAI Batch HTTP ${status}`;
  return String(message).replace(/[\r\n]+/g, " ").slice(0, 500);
}

function createOpenAITruthModelBatchClient(options = {}) {
  if (!isPlainObject(options)) {
    throw batchError("options must be an object", { field: "options" });
  }
  const allowed = new Set([
    "apiKey",
    "fetch",
    "formDataFactory",
    "filePartFactory",
    "maxResponseBytes",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw batchError(`options.${key} is unsupported`, { field: `options.${key}` });
    }
  }
  const apiKey = string(options.apiKey, "options.apiKey", { minimumBytes: 16, maximumBytes: 4096 });
  if (typeof options.fetch !== "function") {
    throw batchError("options.fetch must be an injected function", { field: "options.fetch" });
  }
  const fetchImpl = options.fetch;
  const maxResponseBytes = integer(
    options.maxResponseBytes ?? DEFAULT_MAX_RESULT_BYTES,
    "options.maxResponseBytes",
    1,
    MAX_INPUT_BYTES,
  );
  const formDataFactory = options.formDataFactory || (() => {
    if (typeof globalThis.FormData !== "function") {
      throw batchError("FormData is unavailable; inject options.formDataFactory", {
        field: "options.formDataFactory",
      });
    }
    return new globalThis.FormData();
  });
  const filePartFactory = options.filePartFactory || ((input) => {
    if (typeof globalThis.Blob !== "function") {
      throw batchError("Blob is unavailable; inject options.filePartFactory", {
        field: "options.filePartFactory",
      });
    }
    return new globalThis.Blob([input.contents], { type: input.contentType });
  });

  async function readResponseText(response, operation) {
    if (!response || typeof response.text !== "function") {
      throw batchError(`${operation} returned an invalid HTTP response`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_INVALID",
        operation,
      });
    }
    const contents = await response.text();
    if (typeof contents !== "string") {
      throw batchError(`${operation} returned non-text content`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_INVALID",
        operation,
      });
    }
    if (Buffer.byteLength(contents, "utf8") > maxResponseBytes) {
      throw batchError(`${operation} response exceeds its byte bound`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_RESULT_TOO_LARGE",
        operation,
      });
    }
    return contents;
  }

  async function request(url, init, operation, mode = "json") {
    const clientRequestId = optionalString(
      init?.headers?.["X-Client-Request-Id"],
      `${operation}.clientRequestId`,
      { maximumBytes: 512 },
    );
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (cause) {
      throw batchError(`${operation} transport outcome is unknown`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_TRANSPORT_OUTCOME_UNKNOWN",
        operation,
        outcomeUnknown: init.method !== "GET",
        retryable: false,
        clientRequestId,
        cause,
      });
    }
    const serverRequestId = responseRequestId(response);
    let contents;
    try {
      contents = await readResponseText(response, operation);
    } catch (cause) {
      if (cause instanceof OpenAITruthModelBatchError) {
        cause.serverRequestId = cause.serverRequestId || serverRequestId;
        cause.clientRequestId = cause.clientRequestId || clientRequestId;
        cause.retryable = false;
        cause.outcomeUnknown = init.method !== "GET";
        throw cause;
      }
      throw batchError(`${operation} response read failed`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_INVALID",
        operation,
        serverRequestId,
        clientRequestId,
        retryable: false,
        outcomeUnknown: init.method !== "GET",
        cause,
      });
    }
    if (!response.ok) {
      let payload = null;
      try {
        payload = contents ? JSON.parse(contents) : null;
      } catch {
        payload = null;
      }
      throw batchError(`${operation} failed: ${safeProviderMessage(payload, response.status)}`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_FAILED",
        operation,
        status: Number(response.status) || 0,
        serverRequestId,
        retryable: false,
        clientRequestId,
      });
    }
    if (mode === "text") return Object.freeze({ contents, serverRequestId, clientRequestId });
    let payload;
    try {
      payload = JSON.parse(contents);
    } catch (cause) {
      throw batchError(`${operation} returned malformed JSON`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_INVALID",
        operation,
        serverRequestId,
        clientRequestId,
        retryable: false,
        outcomeUnknown: init.method !== "GET",
        cause,
      });
    }
    if (!isPlainObject(payload)) {
      throw batchError(`${operation} returned a non-object JSON response`, {
        code: "OPENAI_TRUTH_MODEL_BATCH_HTTP_INVALID",
        operation,
        serverRequestId,
        clientRequestId,
        retryable: false,
        outcomeUnknown: init.method !== "GET",
      });
    }
    return Object.freeze({ payload, serverRequestId, clientRequestId });
  }

  async function uploadBatchInput(batchInput, requestOptions = {}) {
    const normalized = validateBatchInput(batchInput);
    const clientRequestId = buildBatchClientRequestId(normalized.inputHash, "upload");
    const form = formDataFactory();
    if (!form || typeof form.append !== "function") {
      throw batchError("options.formDataFactory must return append-capable FormData", {
        field: "options.formDataFactory",
      });
    }
    const filePart = filePartFactory({
      contents: normalized.jsonl,
      filename: normalized.filename,
      contentType: "application/jsonl",
    });
    form.append("purpose", "batch");
    form.append("file", filePart, normalized.filename);
    const receipt = await request(`${API_ORIGIN}/v1/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Client-Request-Id": clientRequestId,
      },
      body: form,
      signal: requestOptions.signal,
    }, "upload Batch input");
    const fileId = string(receipt.payload.id, "file.id", { maximumBytes: 200 });
    if (!FILE_ID_RE.test(fileId)) {
      throw batchError("Uploaded Batch file id is invalid", { field: "file.id" });
    }
    if (receipt.payload.purpose !== undefined && receipt.payload.purpose !== "batch") {
      throw batchError("Uploaded file purpose is not batch", { field: "file.purpose" });
    }
    return deepFreeze({
      fileId,
      purpose: "batch",
      filename: normalized.filename,
      inputHash: normalized.inputHash,
      bytes: normalized.bytes,
      serverRequestId: receipt.serverRequestId,
      clientRequestId: receipt.clientRequestId,
    });
  }

  async function createBatch(inputFileId, inputHash, requestOptions = {}) {
    const fileId = string(inputFileId, "inputFileId", { maximumBytes: 200 });
    if (!FILE_ID_RE.test(fileId)) {
      throw batchError("inputFileId is invalid", { field: "inputFileId" });
    }
    const clientRequestId = buildBatchClientRequestId(inputHash, "create");
    const requestBody = {
      input_file_id: fileId,
      endpoint: RESPONSES_ENDPOINT,
      completion_window: COMPLETION_WINDOW,
    };
    const receipt = await request(`${API_ORIGIN}/v1/batches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": clientRequestId,
      },
      body: stableJson(requestBody),
      signal: requestOptions.signal,
    }, "create Batch");
    return deepFreeze({
      batch: normalizeBatch(receipt.payload, { expectedInputFileId: fileId }),
      serverRequestId: receipt.serverRequestId,
      clientRequestId: receipt.clientRequestId,
    });
  }

  async function retrieveBatch(batchId, requestOptions = {}) {
    const id = string(batchId, "batchId", { maximumBytes: 200 });
    if (!BATCH_ID_RE.test(id)) {
      throw batchError("batchId is invalid", { field: "batchId" });
    }
    const receipt = await request(`${API_ORIGIN}/v1/batches/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: requestOptions.signal,
    }, "retrieve Batch");
    const batch = normalizeBatch(receipt.payload);
    if (batch.id !== id) {
      throw batchError("Retrieved Batch id does not match the request", {
        code: "OPENAI_TRUTH_MODEL_BATCH_ID_MISMATCH",
        field: "batch.id",
      });
    }
    return deepFreeze({ batch, serverRequestId: receipt.serverRequestId });
  }

  async function retrieveFileContent(fileId, requestOptions = {}) {
    const id = string(fileId, "fileId", { maximumBytes: 200 });
    if (!FILE_ID_RE.test(id)) {
      throw batchError("fileId is invalid", { field: "fileId" });
    }
    const receipt = await request(`${API_ORIGIN}/v1/files/${encodeURIComponent(id)}/content`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: requestOptions.signal,
    }, "retrieve Batch result file", "text");
    return deepFreeze({
      fileId: id,
      contents: receipt.contents,
      serverRequestId: receipt.serverRequestId,
    });
  }

  async function retrieveOnce(input = {}) {
    if (!isPlainObject(input)) {
      throw batchError("input must be an object", { field: "input" });
    }
    for (const key of Object.keys(input)) {
      if (!["batchId", "batchInput", "signal", "maxResultBytes"].includes(key)) {
        throw batchError(`input.${key} is unsupported`, { field: `input.${key}` });
      }
    }
    const batchInput = validateBatchInput(input.batchInput);
    const retrieved = await retrieveBatch(input.batchId, { signal: input.signal });
    if (!retrieved.batch.terminal) {
      return deepFreeze({
        ready: false,
        batch: retrieved.batch,
        reconciliation: null,
        requestIds: { retrieve: retrieved.serverRequestId, outputFile: "", errorFile: "" },
      });
    }
    const output = retrieved.batch.outputFileId
      ? await retrieveFileContent(retrieved.batch.outputFileId, { signal: input.signal })
      : { contents: "", serverRequestId: "" };
    const error = retrieved.batch.errorFileId
      ? await retrieveFileContent(retrieved.batch.errorFileId, { signal: input.signal })
      : { contents: "", serverRequestId: "" };
    const reconciliation = reconcileBatchResults({
      batchInput,
      batch: {
        id: retrieved.batch.id,
        object: "batch",
        endpoint: retrieved.batch.endpoint,
        completion_window: retrieved.batch.completionWindow,
        input_file_id: retrieved.batch.inputFileId,
        output_file_id: retrieved.batch.outputFileId || null,
        error_file_id: retrieved.batch.errorFileId || null,
        status: retrieved.batch.status,
        model: retrieved.batch.model || null,
        usage: retrieved.batch.usage ? retrieved.batch.usage.raw : null,
        request_counts: retrieved.batch.requestCounts,
        errors: retrieved.batch.errors,
        metadata: retrieved.batch.metadata,
        ...retrieved.batch.timestamps,
      },
      outputJsonl: output.contents,
      errorJsonl: error.contents,
      maxResultBytes: input.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    });
    return deepFreeze({
      ready: true,
      batch: retrieved.batch,
      reconciliation,
      requestIds: {
        retrieve: retrieved.serverRequestId,
        outputFile: output.serverRequestId,
        errorFile: error.serverRequestId,
      },
    });
  }

  return Object.freeze({
    createBatch,
    retrieveBatch,
    retrieveFileContent,
    retrieveOnce,
    uploadBatchInput,
  });
}

module.exports = Object.freeze({
  API_ORIGIN,
  BATCH_INPUT_SCHEMA_VERSION,
  BATCH_RECONCILIATION_SCHEMA_VERSION,
  BATCH_RESULT_SCHEMA_VERSION,
  BATCH_STATUSES,
  CLIENT_REQUEST_ID_PREFIX,
  COMPLETION_WINDOW,
  CUSTOM_ID_PREFIX,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_MAX_RESULT_BYTES,
  MAX_INPUT_BYTES,
  MAX_ITEM_CONTEXT_TOKENS,
  MAX_REQUESTS,
  OpenAITruthModelBatchError,
  RESPONSES_ENDPOINT,
  TERMINAL_BATCH_STATUSES,
  buildBatchInput,
  buildBatchClientRequestId,
  createOpenAITruthModelBatchClient,
  normalizeBatch,
  reconcileBatchResults,
  validateBatchInput,
  _test: Object.freeze({
    CUSTOM_ID_RE,
    PINNED_MODEL_RE,
    canonicalize,
    normalizePreparedResponsesBody,
    normalizeUsage,
    parseJsonl,
    sha256,
    stableJson,
  }),
});

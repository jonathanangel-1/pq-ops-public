#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto");

const {
  MODEL_RESPONSE_JSON_SCHEMA,
  MODEL_RESPONSE_SCHEMA,
  PROMPT_VERSION: GMAIL_PROMPT_VERSION,
  materializeGmailModelInput,
  planGmailClaimExtraction,
  _test: claimTest,
} = require("../lib/gmail-claim-extractor");
const {
  CLASSIFICATIONS: PROVIDER_CLASSIFICATIONS,
  MAX_OUTPUT_TOKENS: PROVIDER_MAX_OUTPUT_TOKENS,
  PINNED_MODEL: PROVIDER_PINNED_MODEL,
  PROMPT_CACHE_KEY: PROVIDER_PROMPT_CACHE_KEY,
  RESULT_SCHEMA_VERSION: PROVIDER_RESULT_SCHEMA_VERSION,
  createOpenAIGmailModelExtractor,
  _test: providerTest,
} = require("../lib/openai-gmail-model-extractor");
const { buildParsedGmailPayload } = require("./helpers/gmail-v2-fixture");

const {
  DISPATCH_RECOVERY_REASON,
  DISPATCH_RECOVERY_REVIEW_REASON,
  RPC,
  _test,
  createTruthModelAccountIssuer,
  createTruthModelRequestLedger,
  pricingPolicy,
} = require("../lib/truth-model-request-ledger");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(ROOT, "supabase/migrations");
const MODEL_MIGRATION = "20260709241100_truth_model_extraction_runtime.sql";
const PLAN_RUNTIME_MIGRATION = "20260709241200_truth_model_extraction_worker.sql";
const RECOVERY_MIGRATION = "20260709241300_truth_model_dispatch_recovery.sql";
const MIGRATION_NAMES = Object.freeze([
  "20260709200000_truth_source_observation_journal.sql",
  "20260709210000_truth_claims_builds_publications_audits.sql",
  "20260709220000_truth_processing_job_execution.sql",
  "20260709220500_truth_processing_job_lease_renewal.sql",
  "20260709221000_protect_truth_snapshot_keys.sql",
  "20260709222000_truth_evidence_envelopes.sql",
  "20260709223000_truth_generic_source_ingestion.sql",
  "20260709224000_truth_audit_runtime.sql",
  "20260709225000_truth_candidate_claim_runtime.sql",
  "20260709226000_truth_link_workgroup_runtime.sql",
  "20260709230000_truth_build_publication_runtime.sql",
  "20260709231000_truth_workspace_registry.sql",
  "20260709232000_truth_private_evidence_bucket.sql",
  "20260709233000_truth_worker_context_runtime.sql",
  "20260709234000_truth_source_cut_coordinator.sql",
  "20260709235000_truth_tracking_scope_authority.sql",
  "20260709236000_truth_operator_event_authority.sql",
  "20260709237000_truth_audit_status_read.sql",
  "20260709238000_truth_tms_inventory_presence_policy.sql",
  "20260709239000_truth_source_chronology.sql",
  "20260709239500_truth_claim_context_chronology.sql",
  "20260709240000_truth_review_resolution.sql",
  "20260709240500_truth_build_shipment_metadata.sql",
  "20260709240600_truth_audit_shipment_metadata.sql",
  "20260709240700_truth_attachment_extraction_completeness.sql",
  "20260709240800_truth_audit_expired_running_status.sql",
  "20260709240900_truth_production_authority_isolation.sql",
  "20260709241000_truth_processing_watermark.sql",
  MODEL_MIGRATION,
  RECOVERY_MIGRATION,
]);

const WORKSPACE = "primary";
const SYNC_TOKEN = "truth-model-ledger-sync-token-v1";
const ISSUER_TOKEN = "truth-model-ledger-account-issuer-token-v1";
const REVIEW_TOKEN = "truth-model-ledger-review-token-v1";
const WORKER = "truth-model-ledger-worker-v1";
const PROCESSOR = "truth-model-ledger-processor-v1";
const MODEL = "gpt-5-nano-2025-08-07";
const PROMPT_VERSION = GMAIL_PROMPT_VERSION;
const RESPONSE_SCHEMA_VERSION = MODEL_RESPONSE_SCHEMA;
const PROCESSING_CONFIG_VERSION = "truth-model-processing-config-v1";
const PROCESSING_CONFIG_HASH = "6f7405ff0735b445dc43240927df7c0b193a7639892b4660c82f2ee087b625e4";
const MAX_OUTPUT_TOKENS = PROVIDER_MAX_OUTPUT_TOKENS;

const RPC_SIGNATURES = Object.freeze({
  [RPC.configureAccount]: [
    ["p_workspace_key", "text"], ["p_configuration_request_key", "text"],
    ["p_status", "text"], ["p_lifetime_allocation_microusd", "bigint"],
    ["p_daily_ceiling_microusd", "bigint"], ["p_configured_by", "text"],
    ["p_configuration_reason", "text"], ["p_issuer_token", "text"],
  ],
  [RPC.createRequest]: [
    ["p_workspace_key", "text"], ["p_logical_request_key", "text"],
    ["p_source_job_id", "uuid"], ["p_observation_id", "text"],
    ["p_observation_content_hash", "text"], ["p_plan_hash", "text"],
    ["p_request_payload", "jsonb"], ["p_request_payload_text", "text"],
    ["p_model_snapshot", "text"], ["p_prompt_version", "text"],
    ["p_response_schema_version", "text"], ["p_response_schema_hash", "text"],
    ["p_processing_config_version", "text"], ["p_processing_config_hash", "text"],
    ["p_pricing_policy_id", "text"], ["p_transport", "text"],
    ["p_max_output_tokens", "integer"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_processor_version", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.reserveRequest]: [
    ["p_workspace_key", "text"], ["p_request_id", "text"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_processor_version", "text"], ["p_sync_token", "text"],
  ],
  [RPC.beginSyncAttempt]: [
    ["p_workspace_key", "text"], ["p_request_id", "text"],
    ["p_worker_id", "text"], ["p_lease_fence", "bigint"],
    ["p_processor_version", "text"], ["p_sync_token", "text"],
  ],
  [RPC.reconcileSyncAttempt]: [
    ["p_workspace_key", "text"], ["p_request_id", "text"],
    ["p_attempt_number", "integer"], ["p_dispatch_id", "text"],
    ["p_client_request_id", "text"], ["p_provider_result_hash", "text"],
    ["p_classification", "text"],
    ["p_request_sent", "boolean"], ["p_http_status", "integer"],
    ["p_request_body_hash", "text"], ["p_request_body_bytes", "integer"],
    ["p_provider_response_body_hash", "text"],
    ["p_provider_response_body_bytes", "integer"],
    ["p_provider_error_code", "text"], ["p_incomplete_reason", "text"],
    ["p_provider_response_id", "text"], ["p_server_request_id", "text"],
    ["p_actual_model", "text"], ["p_normalized_result", "jsonb"],
    ["p_normalized_result_hash", "text"], ["p_input_tokens", "bigint"],
    ["p_cached_input_tokens", "bigint"], ["p_output_tokens", "bigint"],
    ["p_reasoning_tokens", "bigint"], ["p_total_tokens", "bigint"],
    ["p_sync_token", "text"],
  ],
  [RPC.recoverUnknownAttempt]: [
    ["p_workspace_key", "text"], ["p_request_id", "text"],
    ["p_dispatch_id", "text"], ["p_recovery_key", "text"],
    ["p_recovery_reason", "text"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_processor_version", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.findRequestForSourceJob]: [
    ["p_workspace_key", "text"], ["p_source_job_id", "uuid"],
    ["p_observation_id", "text"], ["p_observation_content_hash", "text"],
    ["p_plan_hash", "text"], ["p_worker_id", "text"],
    ["p_lease_fence", "bigint"], ["p_processor_version", "text"],
    ["p_sync_token", "text"],
  ],
  [RPC.readRecoveryStatus]: [
    ["p_workspace_key", "text"], ["p_source_job_id", "uuid"],
    ["p_sync_token", "text"],
  ],
  [RPC.readRequest]: [
    ["p_workspace_key", "text"], ["p_request_id", "text"],
    ["p_sync_token", "text"],
  ],
});

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function bodyEvidence(value) {
  const body = String(value);
  return Object.freeze({
    providerResponseBodyHash: body.length === 0 ? "" : sha256(body),
    providerResponseBodyBytes: Buffer.byteLength(body, "utf8"),
  });
}

function requestEvidence(request) {
  return Object.freeze({
    requestBodyHash: request.requestPayloadHash,
    requestBodyBytes: request.requestPayloadBytes,
  });
}

function resealRecoveryReceipt(receipt) {
  receipt.recoveryHash = _test.sha256Jsonb(_test.recoveryIdentityPayload(receipt));
  receipt.recoveryId = `model-dispatch-recovery:v1:${receipt.recoveryHash}`;
  return receipt;
}

function validModelResponse() {
  return {
    schemaVersion: MODEL_RESPONSE_SCHEMA,
    claims: [{
      subjectType: "shipment",
      subjectKey: "01680000083",
      appliesToAwbs: ["01680000083"],
      predicate: "pickup_completed",
      gate: "pickup",
      polarity: "positive",
      normalizedValue: { status: "picked_up" },
      occurredAt: null,
      confidence: 0.86,
      evidenceSpan: { start: 0, end: 1, quote: "x" },
      ambiguityReasons: ["semantic extraction required"],
    }],
  };
}

function providerAttemptResult(attempt, options = {}) {
  const classification = options.classification;
  assert.ok(Object.values(PROVIDER_CLASSIFICATIONS).includes(classification));
  const responseEvidence = bodyEvidence(options.providerResponseBody || "");
  const usage = options.usage ?? null;
  const requestSent = options.requestSent !== false;
  const outcomeUnknown = options.outcomeUnknown === true;
  const billingOutcomeUnknown = options.billingOutcomeUnknown === true;
  const httpStatus = options.httpStatus ?? null;
  const receipt = {
    dispatchId: attempt.dispatchId,
    requestId: attempt.requestId,
    attemptNo: attempt.attemptNumber,
    clientRequestId: attempt.clientRequestId,
    ...requestEvidence(attempt.request),
    maxInputTokensUpperBound: attempt.request.requestPayloadBytes,
    maxOutputTokens: attempt.request.maxOutputTokens,
    requestSent,
    httpStatus,
    serverRequestId: options.serverRequestId || "",
    providerResponseId: options.providerResponseId || "",
    ...responseEvidence,
    classification,
    actualModel: options.actualModel || "",
    usage,
    providerErrorCode: options.providerErrorCode || "",
    incompleteReason: options.incompleteReason || "",
    outcomeUnknown,
    billingOutcomeUnknown,
  };
  const retryCapable = classification === PROVIDER_CLASSIFICATIONS.RATE_LIMIT_EXCEEDED ||
    (classification === PROVIDER_CLASSIFICATIONS.SERVER_ERROR &&
      new Set([500, 502, 503, 504]).has(httpStatus));
  const base = {
    schemaVersion: PROVIDER_RESULT_SCHEMA_VERSION,
    ok: classification === PROVIDER_CLASSIFICATIONS.SUCCEEDED,
    classification,
    retryable: retryCapable && !billingOutcomeUnknown && attempt.attemptNumber < 3,
    retryExhausted: retryCapable && !billingOutcomeUnknown && attempt.attemptNumber >= 3,
    outcomeUnknown,
    billingOutcomeUnknown,
    requestSent,
    requestedModel: PROVIDER_PINNED_MODEL,
    dispatchId: attempt.dispatchId,
    requestId: attempt.requestId,
    actualModel: options.actualModel || "",
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: MODEL_RESPONSE_SCHEMA,
    promptCacheKey: PROVIDER_PROMPT_CACHE_KEY,
    requestBodyBytes: attempt.request.requestPayloadBytes,
    requestBodyHash: attempt.request.requestPayloadHash,
    maxInputTokensUpperBound: attempt.request.requestPayloadBytes,
    maxOutputTokens: attempt.request.maxOutputTokens,
    maxAttempts: 3,
    maxTotalInputTokensUpperBound: attempt.request.requestPayloadBytes * 3,
    maxTotalOutputTokensUpperBound: attempt.request.maxOutputTokens * 3,
    providerResponseId: options.providerResponseId || "",
    ...responseEvidence,
    serverRequestId: options.serverRequestId || "",
    providerErrorCode: options.providerErrorCode || "",
    incompleteReason: options.incompleteReason || "",
    usage,
    finalUsage: usage,
    attemptCount: 1,
    attempts: [Object.freeze(receipt)],
    modelResponse: options.modelResponse ?? null,
  };
  return Object.freeze({ ...base, normalizedResultHash: providerTest.hashJson(base) });
}

function reconcileProvider(ledger, attempt, providerResult, overrides = {}) {
  return ledger.reconcileProviderAttempt({
    requestId: attempt.requestId,
    attemptNumber: attempt.attemptNumber,
    dispatchId: attempt.dispatchId,
    clientRequestId: attempt.clientRequestId,
    providerResult,
    ...overrides,
  });
}

function parsedGmailPayload(label, text) {
  const sourceRecordedAt = "2026-07-09T14:30:00.000Z";
  return buildParsedGmailPayload({
    text,
    messageId: `message-${label}`,
    threadId: "broker-thread-model-ledger",
    sourceRecordedAt,
  });
}

function extractorFixture(label) {
  const text = "AWB 016-80000083 המטען נאסף.";
  const payload = parsedGmailPayload(label, text);
  const source = {
    observationId: `obs:v1:${claimTest.sha256Json({ label, payload })}`,
    sourceSystem: "gmail",
    sourceObjectType: "gmail_message_parsed",
    operation: "content",
    sourceRevision: payload.gmail.providerHistoryId,
    contentHash: claimTest.sha256Json(payload),
    sourceRecordedAt: "2026-07-09T14:30:00.000Z",
    capturedAt: "2026-07-09T14:31:00.000Z",
    normalizedPayload: payload,
    normalizedText: claimTest.buildNormalizedText(payload),
  };
  const extractionPlan = planGmailClaimExtraction({ observation: source });
  assert.ok(extractionPlan.modelPlan);
  const modelInput = materializeGmailModelInput({
    modelPlan: extractionPlan.modelPlan,
    observation: source,
  });
  return { source, modelPlan: extractionPlan.modelPlan, modelInput };
}

function rawProviderUsage() {
  return {
    input_tokens: 120,
    input_tokens_details: { cached_tokens: 80 },
    output_tokens: 30,
    output_tokens_details: { reasoning_tokens: 7 },
    total_tokens: 150,
  };
}

function actualModelClaim(modelInput) {
  const range = modelInput.allowedEvidenceRanges[0];
  return {
    subjectType: "shipment",
    subjectKey: "01680000083",
    appliesToAwbs: ["01680000083"],
    predicate: "pickup_completed",
    gate: "pickup",
    polarity: "positive",
    normalizedValue: { status: "picked_up" },
    occurredAt: null,
    confidence: 0.86,
    evidenceSpan: { start: range.start, end: range.end, quote: range.quote },
    ambiguityReasons: ["Hebrew pickup wording requires semantic extraction"],
  };
}

function completedProviderBody(modelInput, overrides = {}) {
  const envelope = {
    schemaVersion: MODEL_RESPONSE_SCHEMA,
    claims: [actualModelClaim(modelInput)],
  };
  return {
    id: "resp_actual_success",
    status: "completed",
    model: PROVIDER_PINNED_MODEL,
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(envelope) }],
    }],
    usage: rawProviderUsage(),
    ...overrides,
  };
}

function fakeProviderResponse(status, body, requestId, { readError = false } = {}) {
  const serialized = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name) => {
      if (String(name).toLowerCase() === "x-request-id") return requestId;
      if (String(name).toLowerCase() === "content-length") return String(Buffer.byteLength(serialized));
      return null;
    } },
    async text() {
      if (readError) throw new Error("fake response read failure");
      return serialized;
    },
  };
}

function syntheticAttemptAuthorization(label, prepared) {
  const requestId = `model-request:v1:${sha256(`synthetic-request:${label}`)}`;
  const dispatchId = `model-dispatch:v1:${sha256(`synthetic-dispatch:${label}`)}`;
  const clientRequestId = `model-client:v1:${sha256(`synthetic-client:${label}`)}`;
  return {
    ok: true,
    idempotent: false,
    sendAuthorized: true,
    workspaceKey: "primary",
    dispatchId,
    requestId,
    attemptNumber: 1,
    clientRequestId,
    request: {
      ok: true,
      idempotent: false,
      requestId,
      workspaceKey: "primary",
      state: "in_flight",
      transport: "sync",
      modelSnapshot: prepared.requestedModel,
      promptVersion: prepared.promptVersion,
      responseSchemaVersion: prepared.responseSchemaVersion,
      planHash: prepared.modelPlanHash,
      observationId: prepared.sourceObservationId,
      observationContentHash: prepared.sourceObservationContentHash,
      maxInputTokens: prepared.requestBodyBytes,
      maxOutputTokens: prepared.maxOutputTokens,
      maxAttempts: 3,
      attemptCount: 1,
      requestPayload: prepared.requestBody,
      requestPayloadText: prepared.requestBodyText,
      requestPayloadHash: prepared.requestBodyHash,
      requestPayloadBytes: prepared.requestBodyBytes,
    },
  };
}

async function verifyActualExtractorMappings() {
  const cases = [
    ["success", "success", ({ modelInput }) => fakeProviderResponse(200, completedProviderBody(modelInput), "req_actual_success")],
    ["rate", "rate_limited", () => fakeProviderResponse(429, { error: { code: "rate_limit_exceeded" } }, "req_actual_rate")],
    ["rate-usage", "rate_limited_usage_known", () => fakeProviderResponse(429, {
      id: "resp_actual_rate_usage", model: PROVIDER_PINNED_MODEL,
      error: { code: "rate_limit_exceeded" }, usage: rawProviderUsage(),
    }, "req_actual_rate_usage")],
    ["server-usage", "server_error_usage_known", () => fakeProviderResponse(500, {
      id: "resp_server_usage", model: PROVIDER_PINNED_MODEL,
      error: { code: "server_error" }, usage: rawProviderUsage(),
    }, "req_server_usage")],
    ["server-no-usage", "billing_unknown", () => fakeProviderResponse(500, {
      error: { code: "server_error" },
    }, "req_server_no_usage")],
    ["transport", "outcome_unknown", () => new Error("fake transport failure")],
    ["read", "billing_unknown", () => fakeProviderResponse(500, {}, "req_read_unknown", { readError: true })],
    ["config-400", "configuration_error", () => fakeProviderResponse(400, {
      error: { code: "invalid_request_error" },
    }, "req_config_400")],
    ["model-mismatch", "model_mismatch", ({ modelInput }) => fakeProviderResponse(200,
      completedProviderBody(modelInput, { model: "gpt-5-nano-unexpected-snapshot" }),
      "req_model_mismatch")],
    ["quota", "insufficient_quota", () => fakeProviderResponse(429, {
      error: { code: "billing_hard_limit" },
    }, "req_quota")],
    ["filter-400", "content_filter", () => fakeProviderResponse(400, {
      error: { code: "content_filter" },
    }, "req_filter_400")],
    ["filter-usage", "content_filter", () => fakeProviderResponse(403, {
      id: "resp_filter_usage", model: PROVIDER_PINNED_MODEL,
      error: { code: "content_filter" }, usage: rawProviderUsage(),
    }, "req_filter_usage")],
    ["refusal-no-usage", "billing_unknown", () => fakeProviderResponse(200, {
      id: "resp_refusal_no", status: "completed", model: PROVIDER_PINNED_MODEL,
      output: [{ content: [{ type: "refusal", refusal: "cannot comply" }] }],
    }, "req_refusal_no")],
    ["refusal-usage", "refusal", () => fakeProviderResponse(200, {
      id: "resp_refusal_usage", status: "completed", model: PROVIDER_PINNED_MODEL,
      output: [{ content: [{ type: "refusal", refusal: "cannot comply" }] }],
      usage: rawProviderUsage(),
    }, "req_refusal_usage")],
    ["incomplete-no-usage", "billing_unknown", () => fakeProviderResponse(200, {
      id: "resp_incomplete_no", status: "incomplete", model: PROVIDER_PINNED_MODEL,
      incomplete_details: { reason: "max_output_tokens" },
    }, "req_incomplete_no")],
    ["incomplete-usage", "incomplete", () => fakeProviderResponse(200, {
      id: "resp_incomplete_usage", status: "incomplete", model: PROVIDER_PINNED_MODEL,
      incomplete_details: { reason: "max_output_tokens" }, usage: rawProviderUsage(),
    }, "req_incomplete_usage")],
    ["malformed-no-usage", "billing_unknown", () => fakeProviderResponse(200, {
      id: "resp_malformed_no", status: "completed", model: PROVIDER_PINNED_MODEL, output: [],
    }, "req_malformed_no")],
    ["malformed-usage", "malformed_output", () => fakeProviderResponse(200, {
      id: "resp_malformed_usage", status: "completed", model: PROVIDER_PINNED_MODEL,
      output: [], usage: rawProviderUsage(),
    }, "req_malformed_usage")],
  ];
  const mapped = [];
  for (const [label, expected, responseFactory] of cases) {
    const { source, modelPlan, modelInput } = extractorFixture(`actual-${label}`);
    let prepared;
    const adapter = createOpenAIGmailModelExtractor({
      apiKey: "sk-fake-ledger-verifier-never-live-123456789",
      fetchImpl: async (_url, options) => {
        assert.equal(options.body, prepared.requestBodyText);
        const response = responseFactory({ modelInput });
        if (response instanceof Error) throw response;
        return response;
      },
      sleep: async () => { throw new Error("executePreparedAttempt never retries"); },
      jitter: () => 0,
    });
    prepared = adapter.prepareRequest(modelInput, { modelPlan, observation: source });
    const authorization = syntheticAttemptAuthorization(label, prepared);
    const result = await adapter.executeAuthorizedAttempt(authorization, modelInput, {
      modelPlan,
      observation: source,
    });
    const normalized = _test.mapProviderResultToReconciliation(result, 1);
    assert.equal(normalized.classification, expected, label);
    mapped.push(`${label}:${expected}`);
  }
  return mapped;
}

async function verifyAuthorizedProviderLedgerE2e(db, callRpc) {
  const workspaceKey = "model-authorized-e2e";
  const { ledger } = await provisionWorkspace(db, callRpc, workspaceKey, 1000000, 1000000);
  const { source, modelPlan, modelInput } = extractorFixture("authorized-db-e2e");
  const seeded = await seedSource(db, "authorized-db-e2e", {
    workspaceKey,
    observationId: source.observationId,
    contentHash: source.contentHash,
    normalizedPayload: source.normalizedPayload,
    normalizedText: source.normalizedText,
    planHash: modelPlan.modelPlanHash,
  });
  const responses = [
    fakeProviderResponse(429, {
      id: "resp_e2e_rate_usage",
      model: PROVIDER_PINNED_MODEL,
      error: { code: "rate_limit_exceeded" },
      usage: rawProviderUsage(),
    }, "req_e2e_rate_usage"),
    fakeProviderResponse(200, completedProviderBody(modelInput, {
      id: "resp_e2e_success",
    }), "req_e2e_success"),
  ];
  let prepared;
  let fetchCalls = 0;
  const adapter = createOpenAIGmailModelExtractor({
    apiKey: "sk-fake-authorized-ledger-e2e-never-live-123456789",
    fetchImpl: async (_url, options) => {
      fetchCalls += 1;
      assert.equal(options.body, prepared.requestBodyText);
      const response = responses.shift();
      assert.ok(response, "authorized e2e must not issue an extra POST");
      return response;
    },
    sleep: async () => { throw new Error("authorized single attempts never sleep"); },
    jitter: () => 0,
  });
  prepared = adapter.prepareRequest(modelInput, { modelPlan, observation: source });
  assert.equal(prepared.modelPlanHash, seeded.planHash);
  const created = await ledger.createRequest({
    logicalRequestKey: `authorized-e2e:${seeded.modelPlanId}`,
    sourceJobId: seeded.jobId,
    observationId: seeded.observationId,
    observationContentHash: seeded.contentHash,
    planHash: seeded.planHash,
    requestBody: prepared.requestBody,
    requestBodyText: prepared.requestBodyText,
    requestBodyHash: prepared.requestBodyHash,
    requestBodyBytes: prepared.requestBodyBytes,
    modelSnapshot: prepared.requestedModel,
    promptVersion: prepared.promptVersion,
    responseSchemaVersion: prepared.responseSchemaVersion,
    responseSchemaHash: _test.sha256Jsonb(MODEL_RESPONSE_JSON_SCHEMA),
    processingConfigVersion: PROCESSING_CONFIG_VERSION,
    processingConfigHash: sha256("authorized-e2e-processing-config"),
    transport: "sync",
    maxOutputTokens: prepared.maxOutputTokens,
    leaseFence: 1,
  });
  const reserved = await ledger.reserveRequest({ requestId: created.requestId, leaseFence: 1 });
  const first = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
  const replay = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
  assert.equal(replay.sendAuthorized, false);
  await assert.rejects(
    adapter.executeAuthorizedAttempt(replay, modelInput, { modelPlan, observation: source }),
    (error) => error?.code === "OPENAI_GMAIL_MODEL_INVALID_ARGUMENT",
  );
  assert.equal(fetchCalls, 0);
  const rateResult = await adapter.executeAuthorizedAttempt(first, modelInput, {
    modelPlan,
    observation: source,
  });
  assert.equal(fetchCalls, 1);
  assert.equal(rateResult.classification, PROVIDER_CLASSIFICATIONS.RATE_LIMIT_EXCEEDED);
  await assert.rejects(
    reconcileProvider(ledger, first, {
      ...rateResult,
      normalizedResultHash: "0".repeat(64),
    }),
    (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT",
  );
  const rateReceipt = await reconcileProvider(ledger, first, rateResult);
  assert.equal(rateReceipt.classification, "rate_limited_usage_known");
  assert.equal(rateReceipt.providerResultHash, rateResult.normalizedResultHash);
  assert.equal(rateReceipt.request.state, "reserved");
  const knownRateCost = Math.ceil((40 * 50000) / 1000000)
    + Math.ceil((80 * 5000) / 1000000)
    + Math.ceil((30 * 400000) / 1000000);
  assert.equal(knownRateCost, 15);
  assert.equal(rateReceipt.actualMicroUsd, knownRateCost);
  assert.equal(
    rateReceipt.request.remainingReservedMicroUsd,
    reserved.initialReservedMicroUsd - knownRateCost,
  );
  await assert.rejects(
    adapter.executeAuthorizedAttempt(first, modelInput, { modelPlan, observation: source }),
    (error) => error?.code === "OPENAI_GMAIL_MODEL_INVALID_ARGUMENT",
  );
  assert.equal(fetchCalls, 1);

  const second = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
  const successResult = await adapter.executeAuthorizedAttempt(second, modelInput, {
    modelPlan,
    observation: source,
  });
  assert.equal(fetchCalls, 2);
  const successReceipt = await reconcileProvider(ledger, second, successResult);
  assert.equal(successReceipt.classification, "success");
  assert.equal(successReceipt.providerResultHash, successResult.normalizedResultHash);
  assert.equal(successReceipt.request.state, "succeeded");
  assert.equal(successReceipt.request.actualMicroUsd, knownRateCost * 2);
  assert.equal(successReceipt.request.remainingReservedMicroUsd, 0);
  return {
    requestId: created.requestId,
    fetchCalls,
    rateProviderResultHash: rateResult.normalizedResultHash,
    successProviderResultHash: successResult.normalizedResultHash,
  };
}

async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result.rows.length, 1, `Expected one row from ${sql}`);
  return result.rows[0];
}

async function expectCode(promise, expectedCode, label) {
  await assert.rejects(promise, (error) => {
    assert.equal(String(error?.code), expectedCode, `${label}: ${error?.message || error}`);
    return true;
  }, label);
}

async function createDatabase() {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create schema extensions;
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.sync_tokens (
      token_name text primary key,
      token_hash text not null
    );
    create table public.app_snapshots (
      snapshot_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    );
    create table public.app_snapshot_metadata (
      snapshot_key text primary key,
      snapshot_time text,
      updated_at timestamptz not null default now(),
      writer_version text,
      content_signature text,
      payload_bytes integer
    );
    create schema storage;
    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null
    );
    alter table storage.objects enable row level security;
  `);
  return db;
}

function nativePostgresBinDir() {
  const candidates = [
    process.env.PQ_TEST_POSTGRES_BIN_DIR,
    "/opt/homebrew/opt/postgresql@15/bin",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql@17/bin",
    "/usr/local/opt/postgresql@15/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql@17/bin",
    ...String(process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);
  for (const directory of candidates) {
    if (["initdb", "pg_ctl", "psql"].every((name) => fs.existsSync(path.join(directory, name)))) {
      return directory;
    }
  }
  throw new Error("Native PostgreSQL initdb/pg_ctl/psql are required for model cap serialization proof");
}

function runNative(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result;
}

function spawnPsql(psql, args, input) {
  const child = spawn(psql, args, { stdio: ["pipe", "pipe", "pipe"] });
  const session = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { session.stdout += chunk; });
  child.stderr.on("data", (chunk) => { session.stderr += chunk; });
  session.done = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(input);
  return session;
}

async function waitForSessionText(session, marker, timeoutMs = 10000) {
  if ((session.stdout + session.stderr).includes(marker)) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(
      `Timed out waiting for ${marker}: ${session.stdout} ${session.stderr}`,
    )), timeoutMs);
    const inspect = () => {
      if (!(session.stdout + session.stderr).includes(marker)) return;
      clearTimeout(timeout);
      resolve();
    };
    session.child.stdout.on("data", inspect);
    session.child.stderr.on("data", inspect);
    session.child.once("exit", (code) => {
      if (!(session.stdout + session.stderr).includes(marker)) {
        clearTimeout(timeout);
        reject(new Error(`Session exited ${code} before ${marker}: ${session.stderr}`));
      }
    });
    inspect();
  });
}

function parsePsqlJson(output, label) {
  const lines = String(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("{")) return JSON.parse(lines[index]);
  }
  throw new Error(`${label} did not return JSON: ${output}`);
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function nativeCapSeedSql(workspaceKey, expectedReason) {
  const reservationMicroUsd = 270;
  const lifetime = expectedReason === "MODEL_LIFETIME_BUDGET_EXHAUSTED"
    ? reservationMicroUsd : reservationMicroUsd * 10;
  const requests = [1, 2].map((ordinal) => {
    const connection = `${workspaceKey}-gmail-${ordinal}`;
    const batchId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const parentJobId = crypto.randomUUID();
    const observationId = `obs:v1:${sha256(`${workspaceKey}:obs:${ordinal}`)}`;
    const contentHash = sha256(`${workspaceKey}:content:${ordinal}`);
    const planHash = sha256(`${workspaceKey}:plan:${ordinal}`);
    const jobPayload = {
      schemaVersion: "gmail-model-claims-job-v1",
      modelPlanId: `gmail-model-plan:v1:${planHash}`,
      contextSealId: `gmail-model-context:v1:${sha256(`${workspaceKey}:context:${ordinal}`)}`,
      batchId,
      rootBatchId: batchId,
      rootJobId: parentJobId,
      parentJobId,
    };
    const requestId = `model-request:v1:${sha256(`${workspaceKey}:request:${ordinal}`)}`;
    return {
      requestId,
      sql: `
        insert into public.source_cursors(
          workspace_key, source_system, connection_key, cursor_kind,
          cursor_value, cursor_version, status, lease_fence
        ) values (${sqlLiteral(workspaceKey)}, 'gmail', ${sqlLiteral(connection)},
          'gmail_history_id', '1', 1, 'live', 1);
        insert into public.source_ingest_batches(
          batch_id, workspace_key, source_system, connection_key, mode, trigger_name,
          expected_cursor_version, expected_cursor_value,
          committed_cursor_version, committed_cursor_value,
          lease_owner, lease_fence, status, batch_hash,
          page_count, observation_count, job_count, committed_at, finished_at
        ) values (${sqlLiteral(batchId)}::uuid, ${sqlLiteral(workspaceKey)}, 'gmail',
          ${sqlLiteral(connection)}, 'snapshot', 'native-model-cap', 0, '', 1, '1',
          'fixture', 1, 'committed', ${sqlLiteral(sha256(`${workspaceKey}:batch:${ordinal}`))},
          0, 1, 1, now(), now());
        insert into public.source_observations(
          observation_id, workspace_key, source_system, connection_key,
          source_object_type, source_object_id, source_revision, operation,
          source_cursor_version, batch_id, content_hash, normalized_payload,
          normalized_text, source_fidelity, schema_version
        ) values (${sqlLiteral(observationId)}, ${sqlLiteral(workspaceKey)}, 'gmail',
          ${sqlLiteral(connection)}, 'gmail_message', ${sqlLiteral(`message-${ordinal}`)},
          '1', 'content', 1, ${sqlLiteral(batchId)}::uuid, ${sqlLiteral(contentHash)},
          '{}'::jsonb, 'native cap fixture', 'normalized_source', 'source-observation-v1');
        insert into public.source_processing_jobs(
          job_id, dedupe_key, workspace_key, source_system, connection_key,
          job_kind, observation_id, source_object_id, state, attempt_count,
          max_attempts, processor_version, payload
        ) values (${sqlLiteral(parentJobId)}::uuid,
          ${sqlLiteral(`${workspaceKey}:parent-job:${ordinal}`)},
          ${sqlLiteral(workspaceKey)}, 'gmail', ${sqlLiteral(connection)},
          'gmail_extract_message_claims', ${sqlLiteral(observationId)},
          ${sqlLiteral(`message-${ordinal}`)}, 'queued', 0, 5, '', '{}'::jsonb);
        insert into public.source_processing_jobs(
          job_id, dedupe_key, workspace_key, source_system, connection_key,
          job_kind, observation_id, source_object_id, state, attempt_count,
          max_attempts, lease_owner, lease_fence, lease_expires_at,
          processor_version, payload
        ) values (${sqlLiteral(jobId)}::uuid, ${sqlLiteral(`${workspaceKey}:job:${ordinal}`)},
          ${sqlLiteral(workspaceKey)}, 'gmail', ${sqlLiteral(connection)},
          'gmail_extract_message_model_claims', ${sqlLiteral(observationId)},
          ${sqlLiteral(`message-${ordinal}`)}, 'leased', 1, 5, ${sqlLiteral(WORKER)},
          1, now() + interval '1 hour', ${sqlLiteral(PROCESSOR)},
          ${sqlLiteral(JSON.stringify(jobPayload))}::jsonb);
        insert into public.source_processing_job_lineage(
          job_id, workspace_key, source_system, connection_key, root_batch_id,
          parent_job_id, root_job_id, source_cursor_version, source_cursor_value
        ) values
          (${sqlLiteral(parentJobId)}::uuid, ${sqlLiteral(workspaceKey)}, 'gmail',
            ${sqlLiteral(connection)}, ${sqlLiteral(batchId)}::uuid, null,
            ${sqlLiteral(parentJobId)}::uuid, 1, '1'),
          (${sqlLiteral(jobId)}::uuid, ${sqlLiteral(workspaceKey)}, 'gmail',
            ${sqlLiteral(connection)}, ${sqlLiteral(batchId)}::uuid,
            ${sqlLiteral(parentJobId)}::uuid, ${sqlLiteral(parentJobId)}::uuid, 1, '1');
        insert into public.truth_model_requests(
          request_id, workspace_key, logical_request_key, request_hash,
          source_job_id, observation_id, observation_content_hash, plan_hash,
          request_payload, request_payload_text, request_payload_hash, request_payload_bytes,
          model_snapshot, prompt_version, response_schema_version, response_schema_hash,
          processing_config_version, processing_config_hash, pricing_policy_id,
          pricing_policy_hash, transport, max_input_tokens, max_output_tokens, max_attempts
        ) select ${sqlLiteral(requestId)}, ${sqlLiteral(workspaceKey)},
          ${sqlLiteral(`logical-${ordinal}`)}, ${sqlLiteral(sha256(`${workspaceKey}:hash:${ordinal}`))},
          ${sqlLiteral(jobId)}::uuid, ${sqlLiteral(observationId)}, ${sqlLiteral(contentHash)},
          ${sqlLiteral(planHash)}, '{}'::jsonb, '{}',
          ${sqlLiteral(sha256("{}"))}, 2, ${sqlLiteral(MODEL)}, 'native-prompt-v1',
          ${sqlLiteral(MODEL_RESPONSE_SCHEMA)}, ${sqlLiteral(_test.sha256Jsonb(RESPONSE_SCHEMA))},
          'native-config-v1', ${sqlLiteral(sha256("native-config"))},
          policy.pricing_policy_id, policy.policy_hash, 'sync', 1000, 100, 3
        from public.truth_model_pricing_policies policy
        where policy.model_snapshot = ${sqlLiteral(MODEL)} and policy.transport = 'sync';
      `,
    };
  });
  return {
    reservationMicroUsd,
    requestIds: requests.map((item) => item.requestId),
    sql: `
      insert into public.truth_workspaces(workspace_key, status, registry_version)
      values (${sqlLiteral(workspaceKey)}, 'active', 'truth-workspace-registry-v1');
      select public.configure_truth_model_account(
        ${sqlLiteral(workspaceKey)}, ${sqlLiteral(`enable:${workspaceKey}`)}, 'enabled',
        ${lifetime}::bigint, ${reservationMicroUsd}::bigint, 'native-verifier',
        ${sqlLiteral(expectedReason)}, ${sqlLiteral(ISSUER_TOKEN)}
      );
      ${requests.map((item) => item.sql).join("\n")}
    `,
  };
}

async function verifyNativeCapSerialization() {
  const binDir = nativePostgresBinDir();
  const initdb = path.join(binDir, "initdb");
  const pgCtl = path.join(binDir, "pg_ctl");
  const psql = path.join(binDir, "psql");
  const tempRoot = fs.mkdtempSync(path.join(process.platform === "darwin" ? "/tmp" : os.tmpdir(), "pq-model-cap-"));
  const dataDir = path.join(tempRoot, "data");
  const socketDir = path.join(tempRoot, "socket");
  const logPath = path.join(tempRoot, "postgres.log");
  const port = 42000 + crypto.randomInt(10000);
  fs.mkdirSync(socketDir);
  let started = false;
  try {
    runNative(initdb, ["-D", dataDir, "-A", "trust", "-U", "postgres", "--no-locale"]);
    runNative(pgCtl, ["-D", dataDir, "-l", logPath, "-o", `-F -k ${socketDir} -p ${port}`, "-w", "start"]);
    started = true;
    const args = ["-X", "-v", "ON_ERROR_STOP=1", "-h", socketDir, "-p", String(port), "-U", "postgres", "-d", "postgres", "-At"];
    runNative(psql, [...args, "-f", "-"], { input: `
      create schema extensions;
      create role anon;
      create role authenticated;
      create role service_role;
      create table public.sync_tokens(token_name text primary key, token_hash text not null);
      create table public.app_snapshots(snapshot_key text primary key, payload jsonb not null,
        updated_at timestamptz not null default now());
      create table public.app_snapshot_metadata(snapshot_key text primary key, snapshot_time text,
        updated_at timestamptz not null default now(), writer_version text,
        content_signature text, payload_bytes integer);
      create schema storage;
      create table storage.buckets(id text primary key, name text not null, public boolean not null default false);
      create table storage.objects(id uuid primary key default gen_random_uuid(),
        bucket_id text not null references storage.buckets(id), name text not null);
      alter table storage.objects enable row level security;
    ` });
    for (const name of MIGRATION_NAMES) {
      runNative(psql, [...args, "-f", path.join(MIGRATION_DIR, name)]);
    }
    runNative(psql, [...args, "-f", "-"], { input: `
      insert into public.sync_tokens(token_name, token_hash) values
        ('local_snapshot_writer', encode(extensions.digest(convert_to(${sqlLiteral(SYNC_TOKEN)}, 'UTF8'), 'sha256'), 'hex')),
        ('truth_model_account_issuer', encode(extensions.digest(convert_to(${sqlLiteral(ISSUER_TOKEN)}, 'UTF8'), 'sha256'), 'hex'));
    ` });
    const results = [];
    for (const item of [
      ["native-model-daily", "MODEL_DAILY_BUDGET_EXHAUSTED"],
      ["native-model-lifetime", "MODEL_LIFETIME_BUDGET_EXHAUSTED"],
    ]) {
      const [workspaceKey, expectedReason] = item;
      const seeded = nativeCapSeedSql(workspaceKey, expectedReason);
      runNative(psql, [...args, "-f", "-"], { input: seeded.sql });
      const reserveSql = (requestId) => `select public.reserve_truth_model_request(
        ${sqlLiteral(workspaceKey)}, ${sqlLiteral(requestId)}, ${sqlLiteral(WORKER)},
        1::bigint, ${sqlLiteral(PROCESSOR)}, ${sqlLiteral(SYNC_TOKEN)}
      )::text;`;
      const first = spawnPsql(psql, args, `
        set statement_timeout = '8s'; set role service_role; begin;
        ${reserveSql(seeded.requestIds[0])}
        \\echo FIRST_RESERVATION_HELD
        select pg_sleep(1.25); commit;
      `);
      await waitForSessionText(first, "FIRST_RESERVATION_HELD");
      const second = spawnPsql(psql, args, `
        set statement_timeout = '8s'; set role service_role;
        \\echo SECOND_BEFORE_RESERVE
        ${reserveSql(seeded.requestIds[1])}
      `);
      await waitForSessionText(second, "SECOND_BEFORE_RESERVE");
      assert.equal(first.child.exitCode, null, "first reservation transaction must still hold its lock");
      const [firstCode, secondCode] = await Promise.all([first.done, second.done]);
      assert.equal(firstCode, 0, first.stderr);
      assert.equal(secondCode, 0, second.stderr);
      const final = runNative(psql, [...args, "-c", `
        select json_build_object(
          'reservedCount', count(*) filter (where state = 'reserved'),
          'reviewCount', count(*) filter (where state = 'review_required'),
          'reviewReasons', json_agg(review_reason order by request_id)
            filter (where state = 'review_required'),
          'accountReserved', (select reserved_microusd from public.truth_model_workspace_accounts where workspace_key = ${sqlLiteral(workspaceKey)}),
          'dailyReserved', (select reserved_microusd from public.truth_model_workspace_daily_usage where workspace_key = ${sqlLiteral(workspaceKey)}),
          'dailyInput', (select reserved_input_tokens from public.truth_model_workspace_daily_usage where workspace_key = ${sqlLiteral(workspaceKey)}),
          'dailyOutput', (select reserved_output_tokens from public.truth_model_workspace_daily_usage where workspace_key = ${sqlLiteral(workspaceKey)})
        )::text from public.truth_model_requests where workspace_key = ${sqlLiteral(workspaceKey)};
      `]).stdout;
      const proof = parsePsqlJson(final, workspaceKey);
      assert.equal(Number(proof.reservedCount), 1);
      assert.equal(Number(proof.reviewCount), 1);
      assert.deepEqual(proof.reviewReasons, [expectedReason]);
      assert.equal(Number(proof.accountReserved), seeded.reservationMicroUsd);
      assert.equal(Number(proof.dailyReserved), seeded.reservationMicroUsd);
      assert.equal(Number(proof.dailyInput), 3000);
      assert.equal(Number(proof.dailyOutput), 300);
      results.push({ workspaceKey, expectedReason, reservationMicroUsd: seeded.reservationMicroUsd });
    }
    const recoverySeed = parsePsqlJson(runNative(psql, [...args, "-c", `
      select json_build_object(
        'requestId', request.request_id,
        'sourceJobId', request.source_job_id,
        'connectionKey', job.connection_key,
        'leaseFence', job.lease_fence,
        'reservedMicroUsd', request.remaining_reserved_microusd,
        'reservedInputTokens', request.remaining_reserved_input_tokens,
        'reservedOutputTokens', request.remaining_reserved_output_tokens
      )::text
      from public.truth_model_requests request
      join public.source_processing_jobs job on job.job_id=request.source_job_id
      where request.workspace_key='native-model-daily' and request.state='reserved';
    `]).stdout, "native dispatch recovery seed");
    assert.equal(Number(recoverySeed.leaseFence), 1);
    const nativeAttempt = parsePsqlJson(runNative(psql, [...args, "-c", `
      set role service_role;
      select public.begin_truth_model_sync_attempt(
        'native-model-daily', ${sqlLiteral(recoverySeed.requestId)}, ${sqlLiteral(WORKER)},
        1::bigint, ${sqlLiteral(PROCESSOR)}, ${sqlLiteral(SYNC_TOKEN)}
      )::text;
    `]).stdout, "native dispatch authorization");
    assert.equal(nativeAttempt.sendAuthorized, true);
    assert.equal(Number(nativeAttempt.authorizationLeaseFence), 1);
    runNative(psql, [...args, "-c", `
      update public.source_processing_jobs
      set lease_expires_at=clock_timestamp()-interval '1 second'
      where job_id=${sqlLiteral(recoverySeed.sourceJobId)}::uuid;
    `]);
    const replacement = parsePsqlJson(runNative(psql, [...args, "-c", `
      set role service_role;
      select public.claim_source_processing_jobs(
        'native-model-daily', 'gmail', ${sqlLiteral(recoverySeed.connectionKey)},
        ${sqlLiteral(WORKER)}, ${sqlLiteral(PROCESSOR)}, 1, 300,
        array['gmail_extract_message_model_claims']::text[], ${sqlLiteral(SYNC_TOKEN)}
      )::text;
    `]).stdout, "native replacement lease");
    assert.equal(Number(replacement.claimedCount), 1);
    assert.ok(Number(replacement.jobs[0].leaseFence) > 1);
    const recoveryKey = `native-dispatch-recovery:${nativeAttempt.dispatchId}`;
    const recoveryCallSql = `select public.quarantine_truth_model_sync_dispatch(
      'native-model-daily', ${sqlLiteral(recoverySeed.requestId)},
      ${sqlLiteral(nativeAttempt.dispatchId)}, ${sqlLiteral(recoveryKey)},
      ${sqlLiteral(DISPATCH_RECOVERY_REASON)}, ${sqlLiteral(WORKER)},
      ${Number(replacement.jobs[0].leaseFence)}::bigint, ${sqlLiteral(PROCESSOR)},
      ${sqlLiteral(SYNC_TOKEN)}
    )::text;`;
    const nativeRecovery = parsePsqlJson(runNative(psql, [...args, "-c", `
      set role service_role; ${recoveryCallSql}
    `]).stdout, "native dispatch recovery");
    assert.equal(nativeRecovery.idempotent, false);
    assert.equal(nativeRecovery.sendAuthorized, false);
    assert.equal(nativeRecovery.externalEffectState, "unknown_possible_post");
    assert.equal(Object.prototype.hasOwnProperty.call(nativeRecovery, "requestSent"), false);
    const nativeRecoveryReplay = parsePsqlJson(runNative(psql, [...args, "-c", `
      set role service_role; ${recoveryCallSql}
    `]).stdout, "native dispatch recovery replay");
    assert.equal(nativeRecoveryReplay.idempotent, true);
    assert.equal(nativeRecoveryReplay.recoveryId, nativeRecovery.recoveryId);
    runNative(psql, [...args, "-f", "-"], { input: `
      do $proof$
      begin
        begin
          update public.truth_model_sync_dispatch_recoveries
          set recovery_reason=recovery_reason
          where recovery_id=${sqlLiteral(nativeRecovery.recoveryId)};
          raise exception 'native recovery mutation unexpectedly succeeded';
        exception when sqlstate '55000' then null;
        end;
        begin
          update public.truth_model_requests
          set state='review_required',review_reason='HUMAN_REVIEW_RESOLVED'
          where request_id=${sqlLiteral(recoverySeed.requestId)};
          raise exception 'native uncertainty resolution unexpectedly succeeded';
        exception when sqlstate '55000' then null;
        end;
      end;
      $proof$;
    ` });
    const nativeRecoveryProof = parsePsqlJson(runNative(psql, [...args, "-c", `
      select json_build_object(
        'requestState', request.state,
        'reviewReason', request.review_reason,
        'remainingReservedMicroUsd', request.remaining_reserved_microusd,
        'remainingReservedInputTokens', request.remaining_reserved_input_tokens,
        'remainingReservedOutputTokens', request.remaining_reserved_output_tokens,
        'recoveryCount', (select count(*) from public.truth_model_sync_dispatch_recoveries
          where dispatch_id=${sqlLiteral(nativeAttempt.dispatchId)}),
        'outcomeCount', (select count(*) from public.truth_model_sync_attempt_outcomes
          where dispatch_id=${sqlLiteral(nativeAttempt.dispatchId)}),
        'attemptHasRequestSent', private.truth_model_attempt_receipt(
          ${sqlLiteral(nativeAttempt.dispatchId)},true,false
        ) ? 'requestSent',
        'recoveryTableHasRequestSentColumn', exists(
          select 1 from information_schema.columns
          where table_schema='public'
            and table_name='truth_model_sync_dispatch_recoveries'
            and column_name='request_sent'
        ),
        'serviceCanExecuteRecovery', has_function_privilege(
          'service_role',
          'public.quarantine_truth_model_sync_dispatch(text,text,text,text,text,text,bigint,text,text)',
          'EXECUTE'
        ),
        'anonCanExecuteRecovery', has_function_privilege(
          'anon',
          'public.quarantine_truth_model_sync_dispatch(text,text,text,text,text,text,bigint,text,text)',
          'EXECUTE'
        )
      )::text
      from public.truth_model_requests request
      where request.request_id=${sqlLiteral(recoverySeed.requestId)};
    `]).stdout, "native dispatch recovery proof");
    assert.equal(nativeRecoveryProof.requestState, "outcome_unknown");
    assert.equal(nativeRecoveryProof.reviewReason, DISPATCH_RECOVERY_REVIEW_REASON);
    assert.equal(Number(nativeRecoveryProof.remainingReservedMicroUsd), Number(recoverySeed.reservedMicroUsd));
    assert.equal(Number(nativeRecoveryProof.remainingReservedInputTokens), Number(recoverySeed.reservedInputTokens));
    assert.equal(Number(nativeRecoveryProof.remainingReservedOutputTokens), Number(recoverySeed.reservedOutputTokens));
    assert.equal(Number(nativeRecoveryProof.recoveryCount), 1);
    assert.equal(Number(nativeRecoveryProof.outcomeCount), 0);
    assert.equal(nativeRecoveryProof.attemptHasRequestSent, false);
    assert.equal(nativeRecoveryProof.recoveryTableHasRequestSentColumn, false);
    assert.equal(nativeRecoveryProof.serviceCanExecuteRecovery, true);
    assert.equal(nativeRecoveryProof.anonCanExecuteRecovery, false);
    return { caps: results, recovery: nativeRecoveryProof };
  } finally {
    if (started) runNative(pgCtl, ["-D", dataDir, "-m", "fast", "-w", "stop"]);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function applyMigration(db, name) {
  try {
    await db.exec(fs.readFileSync(path.join(MIGRATION_DIR, name), "utf8"));
  } catch (error) {
    error.message = `${error.message} while applying ${name}`;
    throw error;
  }
}

function createDbRpcCaller(db) {
  return async (rpc, body) => {
    const signature = RPC_SIGNATURES[rpc];
    if (!signature) throw new Error(`Unexpected truth-model RPC ${rpc}`);
    const values = signature.map(([key, type]) => (
      type === "jsonb" && body[key] !== null ? JSON.stringify(body[key]) : body[key]
    ));
    const casts = signature.map(([, type], index) => `$${index + 1}::${type}`);
    return (await one(
      db,
      `select public.${rpc}(${casts.join(", ")}) as receipt`,
      values,
    )).receipt;
  };
}

function ledgerFor(callRpc, workspaceKey) {
  return createTruthModelRequestLedger({
    workspaceKey,
    syncToken: SYNC_TOKEN,
    workerId: WORKER,
    processorVersion: PROCESSOR,
    callRpc,
  });
}

function issuerFor(callRpc, workspaceKey, issuerToken = ISSUER_TOKEN) {
  return createTruthModelAccountIssuer({ workspaceKey, issuerToken, callRpc });
}

async function expectTamperedReadRejected(callRpc, workspaceKey, requestId, label, mutate) {
  const tamperedCallRpc = async (rpc, body, options) => {
    const receipt = await callRpc(rpc, body, options);
    if (rpc !== RPC.readRequest) return receipt;
    const copy = JSON.parse(JSON.stringify(receipt));
    mutate(copy);
    return copy;
  };
  const ledger = ledgerFor(tamperedCallRpc, workspaceKey);
  await assert.rejects(
    ledger.readRequest({ requestId }),
    (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
    label,
  );
}

async function expectTamperedRecoveryRejected(
  callRpc, workspaceKey, recoveryInput, label, mutate,
) {
  const tamperedCallRpc = async (rpc, body, options) => {
    const receipt = await callRpc(rpc, body, options);
    if (rpc !== RPC.recoverUnknownAttempt) return receipt;
    const copy = JSON.parse(JSON.stringify(receipt));
    mutate(copy);
    return copy;
  };
  const ledger = ledgerFor(tamperedCallRpc, workspaceKey);
  await assert.rejects(
    ledger.recoverUnknownAttempt(recoveryInput),
    (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
    label,
  );
}

async function provisionWorkspace(db, callRpc, workspaceKey, lifetime, daily) {
  await db.query(`
    insert into public.truth_workspaces(workspace_key, status, registry_version)
    values ($1, 'active', 'truth-workspace-registry-v1')
  `, [workspaceKey]);
  const issuer = issuerFor(callRpc, workspaceKey);
  await issuer.configure({
    configurationRequestKey: `enable:${workspaceKey}:v1`,
    enabled: true,
    lifetimeAllocationMicroUsd: lifetime,
    dailyCeilingMicroUsd: daily,
    configuredBy: "verifier",
    configurationReason: `bounded verifier workspace ${workspaceKey}`,
  });
  return Object.freeze({ issuer, ledger: ledgerFor(callRpc, workspaceKey) });
}

async function seedTokens(db) {
  await db.query(`
    insert into public.sync_tokens(token_name, token_hash) values
      ('local_snapshot_writer', encode(
        extensions.digest(convert_to($1::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_model_account_issuer', encode(
        extensions.digest(convert_to($2::text, 'UTF8'), 'sha256'), 'hex'
      )),
      ('truth_review_decider', encode(
        extensions.digest(convert_to($3::text, 'UTF8'), 'sha256'), 'hex'
      ))
    on conflict (token_name) do update set token_hash = excluded.token_hash
  `, [SYNC_TOKEN, ISSUER_TOKEN, REVIEW_TOKEN]);
}

async function seedSource(db, label, options = {}) {
  const workspaceKey = options.workspaceKey || WORKSPACE;
  const connectionKey = `model-ledger-${label}`;
  const observationId = options.observationId ||
    `obs:v1:${sha256(`observation:${workspaceKey}:${label}`)}`;
  const contentHash = options.contentHash || sha256(`content:${workspaceKey}:${label}`);
  const planHash = options.planHash || sha256(`plan:${observationId}`);
  const modelPlanId = `gmail-model-plan:v1:${planHash}`;
  const contextSealId = options.contextSealId ||
    `gmail-model-context:v1:${sha256(`context:${workspaceKey}:${label}`)}`;
  const jobId = crypto.randomUUID();
  const parentJobId = crypto.randomUUID();
  await db.query(`
    insert into public.source_cursors(
      workspace_key, source_system, connection_key, cursor_kind,
      cursor_value, cursor_version, status, lease_fence
    ) values ($1, 'gmail', $2, 'gmail_history_id', '1', 1, 'live', 1)
  `, [workspaceKey, connectionKey]);
  const batch = await one(db, `
    insert into public.source_ingest_batches(
      workspace_key, source_system, connection_key, mode, trigger_name,
      expected_cursor_version, expected_cursor_value,
      committed_cursor_version, committed_cursor_value,
      lease_owner, lease_fence, status, batch_hash,
      page_count, observation_count, job_count, committed_at, finished_at
    ) values (
      $1, 'gmail', $2, 'snapshot', 'model-ledger-verifier',
      0, '', 1, '1', 'fixture', 1, 'committed', $3,
      0, 1, 1, now(), now()
    ) returning batch_id
  `, [workspaceKey, connectionKey, sha256(`batch:${workspaceKey}:${label}`)]);
  await db.query(`
    insert into public.source_observations(
      observation_id, workspace_key, source_system, connection_key,
      source_object_type, source_object_id, source_revision, operation,
      source_cursor_version, batch_id, content_hash, normalized_payload,
      normalized_text, source_fidelity, schema_version
    ) values (
      $1, $2, 'gmail', $3, 'gmail_message', $4, '1', 'content',
      1, $5, $6, $7::jsonb, $8,
      'normalized_source', 'source-observation-v1'
    )
  `, [
    observationId,
    workspaceKey,
    connectionKey,
    `message-${label}`,
    batch.batch_id,
    contentHash,
    JSON.stringify(options.normalizedPayload || {}),
    options.normalizedText || "ambiguous shipment evidence",
  ]);
  await db.query(`
    insert into public.source_processing_jobs(
      job_id, dedupe_key, workspace_key, source_system, connection_key,
      job_kind, observation_id, source_object_id, state, attempt_count,
      max_attempts, processor_version, payload
    ) values (
      $1, $2, $3, 'gmail', $4, 'gmail_extract_message_claims', $5, $6,
      'queued', 0, 5, '', '{}'::jsonb
    )
  `, [
    parentJobId,
    `model-ledger-parent:${workspaceKey}:${label}`,
    workspaceKey,
    connectionKey,
    observationId,
    `message-${label}`,
  ]);
  await db.query(`
    insert into public.source_processing_jobs(
      job_id, dedupe_key, workspace_key, source_system, connection_key,
      job_kind, observation_id, source_object_id, state, attempt_count,
      max_attempts, lease_owner, lease_fence, lease_expires_at,
      processor_version, payload
    ) values (
      $1, $2, $3, 'gmail', $4, $5, $6, $7, 'leased', 1,
      5, $8, 1, ${options.expired ? "now() - interval '1 second'" : "now() + interval '1 hour'"},
      $9, $10::jsonb
    )
  `, [
    jobId,
    `model-ledger:${workspaceKey}:${label}`,
    workspaceKey,
    connectionKey,
    options.jobKind || "gmail_extract_message_model_claims",
    observationId,
    `message-${label}`,
    WORKER,
    PROCESSOR,
    JSON.stringify({
      schemaVersion: "gmail-model-claims-job-v1",
      modelPlanId,
      contextSealId,
      batchId: batch.batch_id,
      rootBatchId: batch.batch_id,
      rootJobId: parentJobId,
      parentJobId,
    }),
  ]);
  await db.query(`
    insert into public.source_processing_job_lineage(
      job_id, workspace_key, source_system, connection_key, root_batch_id,
      parent_job_id, root_job_id, source_cursor_version, source_cursor_value
    ) values
      ($1, $2, 'gmail', $3, $4, null, $1, 1, '1'),
      ($5, $2, 'gmail', $3, $4, $1, $1, 1, '1')
  `, [parentJobId, workspaceKey, connectionKey, batch.batch_id, jobId]);
  return Object.freeze({
    workspaceKey, jobId, parentJobId, connectionKey, observationId, contentHash, planHash,
    modelPlanId, contextSealId,
  });
}

async function replaceSourceJobLease(db, source) {
  await db.query(`
    update public.source_processing_jobs
    set lease_expires_at = clock_timestamp() - interval '1 second'
    where job_id = $1
  `, [source.jobId]);
  const claimed = await one(db, `
    select public.claim_source_processing_jobs(
      $1, 'gmail', $2, $3, $4, 1, 300,
      array['gmail_extract_message_model_claims']::text[], $5
    ) as receipt
  `, [source.workspaceKey, source.connectionKey, WORKER, PROCESSOR, SYNC_TOKEN]);
  assert.equal(claimed.receipt.ok, true);
  assert.equal(claimed.receipt.claimedCount, 1);
  assert.equal(claimed.receipt.jobs[0].jobId, source.jobId);
  assert.ok(claimed.receipt.jobs[0].leaseFence > 1);
  return claimed.receipt.jobs[0];
}

const RESPONSE_SCHEMA = MODEL_RESPONSE_JSON_SCHEMA;

function requestFixture(source, options = {}) {
  const planHash = options.planHash || source.planHash;
  const maxOutputTokens = options.maxOutputTokens || MAX_OUTPUT_TOKENS;
  const body = {
    model: MODEL,
    instructions: "Extract only unresolved shipment claims.",
    input: [{ role: "user", content: [{ type: "input_text", text: "ambiguous evidence" }] }],
    temperature: 0,
    max_output_tokens: maxOutputTokens,
    store: false,
    prompt_cache_key: PROVIDER_PROMPT_CACHE_KEY,
    metadata: {
      model_plan_hash: planHash,
      source_observation_id: source.observationId,
      source_content_hash: source.contentHash,
      prompt_version: PROMPT_VERSION,
    },
    text: {
      format: {
        type: "json_schema",
        name: "gmail_claim_extraction",
        strict: true,
        schema: RESPONSE_SCHEMA,
      },
    },
  };
  if (options.mutateBody) options.mutateBody(body);
  return {
    logicalRequestKey: options.logicalRequestKey || `logical:${source.jobId}`,
    sourceJobId: source.jobId,
    observationId: source.observationId,
    observationContentHash: source.contentHash,
    planHash,
    requestPayload: body,
    modelSnapshot: MODEL,
    promptVersion: PROMPT_VERSION,
    responseSchemaVersion: RESPONSE_SCHEMA_VERSION,
    responseSchemaHash: _test.sha256Jsonb(RESPONSE_SCHEMA),
    processingConfigVersion: PROCESSING_CONFIG_VERSION,
    processingConfigHash: PROCESSING_CONFIG_HASH,
    transport: options.transport || "sync",
    maxOutputTokens,
    leaseFence: 1,
  };
}

function conservativeReservation(fixture) {
  const maxInput = Buffer.byteLength(JSON.stringify(fixture.requestPayload), "utf8");
  const perAttempt = Math.ceil((maxInput * 50000) / 1000000)
    + Math.ceil((fixture.maxOutputTokens * 400000) / 1000000);
  return Object.freeze({ maxInput, perAttempt, total: perAttempt * 3 });
}

function preparedRequest(fixture) {
  const requestBodyText = JSON.stringify(fixture.requestPayload);
  const { requestPayload, ...identity } = fixture;
  return Object.freeze({
    ...identity,
    requestBody: requestPayload,
    requestBodyText,
    requestBodyHash: sha256(requestBodyText),
    requestBodyBytes: Buffer.byteLength(requestBodyText, "utf8"),
  });
}

async function installSealedModelPlan(db, source, fixture, label, options = {}) {
  const prepared = preparedRequest(fixture);
  const contextSealHash = source.contextSealId.slice("gmail-model-context:v1:".length);
  assert.match(contextSealHash, /^[0-9a-f]{64}$/);
  const extractionPlanHash = sha256(`sealed-extraction-plan:${source.workspaceKey}:${label}`);
  const extractionPlanId = `gmail-extraction-plan:v1:${extractionPlanHash}`;
  const planSealHash = sha256(`sealed-plan-receipt:${source.workspaceKey}:${label}`);
  await db.query(`
    insert into public.gmail_model_extraction_context_seals(
      context_seal_id,workspace_key,parent_job_id,source_observation_id,
      source_observation_content_hash,journal_sequence_inclusive,
      claim_context_hash,accepted_claims_context_hash,workgroup_context_hash,
      accepted_claim_membership_hash,workgroup_membership_hash,
      context_observation_membership_hash,accepted_claim_count,
      workgroup_membership_count,context_observation_count,workgroup_context,
      canonical_seal,seal_hash
    )
    select $1,$2,$3,$4,$5,observation.journal_seq,$6,$7,$8,$9,$10,$11,
      0,0,1,'null'::jsonb,'{}'::jsonb,$12
    from public.source_observations observation
    where observation.workspace_key=$2 and observation.observation_id=$4
  `, [
    source.contextSealId, source.workspaceKey, source.parentJobId,
    source.observationId, source.contentHash,
    sha256(`claim-context:${label}`), sha256(`accepted-context:${label}`),
    sha256(`workgroup-context:${label}`), sha256(`accepted-membership:${label}`),
    sha256(`workgroup-membership:${label}`), sha256(`observation-membership:${label}`),
    contextSealHash,
  ]);
  await db.query(`
    insert into public.gmail_model_context_observations(
      workspace_key,context_seal_id,ordinal,observation_id,observation_content_hash
    ) values($1,$2,0,$3,$4)
  `, [source.workspaceKey, source.contextSealId, source.observationId, source.contentHash]);
  await db.query(`
    insert into public.gmail_model_extraction_plans(
      extraction_plan_id,extraction_plan_hash,workspace_key,parent_job_id,
      source_observation_id,source_observation_content_hash,
      deterministic_manifest_hash,deterministic_candidate_count,context_seal_id,
      model_plan_id,model_plan_hash,model_plan,extractor_version,prompt_version,
      expected_request_payload,expected_request_payload_text,expected_request_payload_hash,
      expected_request_payload_bytes,expected_model_snapshot,expected_max_output_tokens,
      expected_response_schema_hash,wire_contract_version,response_schema_version,
      planning_status,execution_mode,root_ingest_mode,canonical_plan_seal,plan_seal_hash
    ) values(
      $1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11::jsonb,
      'gmail-claim-extractor-v1',$12,$13::jsonb,$14,$15,$16,$17,$18,$19,
      'openai-responses-gmail-v1',$20,'complete',$21,'snapshot','{}'::jsonb,$22
    )
  `, [
    extractionPlanId, extractionPlanHash, source.workspaceKey, source.parentJobId,
    source.observationId, source.contentHash, sha256(`deterministic-manifest:${label}`),
    source.contextSealId, source.modelPlanId, source.planHash,
    JSON.stringify({
      modelPlanId: source.modelPlanId,
      modelPlanHash: source.planHash,
      promptVersion: fixture.promptVersion,
      responseSchemaVersion: fixture.responseSchemaVersion,
    }),
    fixture.promptVersion, JSON.stringify(fixture.requestPayload),
    prepared.requestBodyText, prepared.requestBodyHash, prepared.requestBodyBytes,
    fixture.modelSnapshot, fixture.maxOutputTokens, fixture.responseSchemaHash,
    fixture.responseSchemaVersion, options.executionMode || fixture.transport, planSealHash,
  ]);
  return Object.freeze({ extractionPlanId, extractionPlanHash, planSealHash });
}

async function verifyPrivileges(db) {
  const tables = [
    "truth_model_pricing_policies",
    "truth_model_workspace_accounts",
    "truth_model_account_configuration_requests",
    "truth_model_workspace_daily_usage",
    "truth_model_requests",
    "truth_model_sync_attempt_dispatches",
    "truth_model_sync_attempt_outcomes",
    "truth_model_sync_dispatch_recoveries",
  ];
  const rls = await db.query(`
    select relname, relrowsecurity, relforcerowsecurity
    from pg_class
    where relnamespace = 'public'::regnamespace and relname = any($1::text[])
    order by relname
  `, [tables]);
  assert.equal(rls.rows.length, tables.length);
  assert.ok(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity));
  for (const table of tables) {
    const privilege = await one(db, `
      select has_table_privilege('service_role', $1, 'SELECT') as service_select,
        has_table_privilege('anon', $1, 'SELECT') as anon_select
    `, [`public.${table}`]);
    assert.equal(privilege.service_select, false);
    assert.equal(privilege.anon_select, false);
  }
  for (const [name, signature] of Object.entries(RPC_SIGNATURES)) {
    const types = signature.map(([, type]) => type).join(",");
    const privilege = await one(db, `
      select has_function_privilege('service_role', $1, 'EXECUTE') as service_execute,
        has_function_privilege('anon', $1, 'EXECUTE') as anon_execute,
        has_function_privilege('service_role', $2, 'EXECUTE') as private_execute
    `, [`public.${name}(${types})`, `private.${name}(${types})`]);
    assert.equal(privilege.service_execute, true, `${name} service execute`);
    assert.equal(privilege.anon_execute, false, `${name} anon execute`);
    assert.equal(privilege.private_execute, false, `${name} private execute`);
    const overloads = await one(db, `
      select count(*)::integer as count from pg_proc procedure
      where procedure.proname = $1
        and procedure.pronamespace = any(array['public'::regnamespace, 'private'::regnamespace])
    `, [name]);
    assert.equal(overloads.count, 2, `${name} has exactly one public and one private definition`);
  }
}

async function verifyAtomicCap(db, callRpc, { workspaceKey, expectedReason }) {
  await db.query(`
    insert into public.truth_workspaces(workspace_key, status, registry_version)
    values ($1, 'active', 'truth-workspace-registry-v1')
  `, [workspaceKey]);
  const sourceA = await seedSource(db, "cap-a", { workspaceKey });
  const sourceB = await seedSource(db, "cap-b", { workspaceKey });
  const fixtureA = requestFixture(sourceA);
  const fixtureB = requestFixture(sourceB);
  const reservationA = conservativeReservation(fixtureA);
  const reservationB = conservativeReservation(fixtureB);
  assert.equal(reservationA.total, reservationB.total);
  const lifetime = expectedReason === "MODEL_LIFETIME_BUDGET_EXHAUSTED"
    ? reservationA.total : reservationA.total * 10;
  const daily = reservationA.total;
  const issuer = issuerFor(callRpc, workspaceKey);
  await issuer.configure({
    configurationRequestKey: `enable:${workspaceKey}:cap-v1`,
    enabled: true,
    lifetimeAllocationMicroUsd: lifetime,
    dailyCeilingMicroUsd: daily,
    configuredBy: "verifier",
    configurationReason: `atomic ${expectedReason} proof`,
  });
  const ledger = ledgerFor(callRpc, workspaceKey);
  const [createdA, createdB] = await Promise.all([
    ledger.createRequest(fixtureA),
    ledger.createRequest(fixtureB),
  ]);
  const reservations = await Promise.all([
    ledger.reserveRequest({ requestId: createdA.requestId, leaseFence: 1 }),
    ledger.reserveRequest({ requestId: createdB.requestId, leaseFence: 1 }),
  ]);
  const accepted = reservations.filter((receipt) => receipt.state === "reserved");
  const rejected = reservations.filter((receipt) => receipt.state === "review_required");
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reviewReason, expectedReason);
  assert.equal(accepted[0].initialReservedMicroUsd, reservationA.total);
  const counters = await one(db, `
    select account.lifetime_allocation_microusd, account.daily_ceiling_microusd,
      account.reserved_microusd as account_reserved,
      usage.reserved_microusd as daily_reserved,
      usage.usage_date::text as usage_date,
      (clock_timestamp() at time zone 'UTC')::date::text as utc_date
    from public.truth_model_workspace_accounts account
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key = account.workspace_key
    where account.workspace_key = $1
  `, [workspaceKey]);
  assert.equal(Number(counters.account_reserved), reservationA.total);
  assert.equal(Number(counters.daily_reserved), reservationA.total);
  assert.ok(Number(counters.account_reserved) <= Number(counters.lifetime_allocation_microusd));
  assert.ok(Number(counters.daily_reserved) <= Number(counters.daily_ceiling_microusd));
  assert.equal(counters.usage_date, counters.utc_date);
  assert.equal(accepted[0].reservationDate, counters.utc_date);
  return Object.freeze({ reservationMicroUsd: reservationA.total, accepted, rejected });
}

async function verifyAttemptCap(db, callRpc) {
  const workspaceKey = "model-attempt-cap";
  const { ledger } = await provisionWorkspace(db, callRpc, workspaceKey, 1000000, 1000000);
  const source = await seedSource(db, "attempt-cap", { workspaceKey });
  const created = await ledger.createRequest(requestFixture(source));
  const reserved = await ledger.reserveRequest({ requestId: created.requestId, leaseFence: 1 });
  let final;
  for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
    const attempt = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
    assert.equal(attempt.attemptNumber, attemptNumber);
    assert.equal(attempt.sendAuthorized, true);
    final = await reconcileProvider(ledger, attempt, providerAttemptResult(attempt, {
      classification: PROVIDER_CLASSIFICATIONS.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      providerResponseBody: `{"error":{"code":"rate_limit_exceeded","attempt":${attemptNumber}}}`,
      providerErrorCode: "rate_limit_exceeded",
      usage: null,
    }));
    assert.equal(final.request.state, attemptNumber < 3 ? "reserved" : "review_required");
  }
  assert.equal(final.request.reviewReason, "MODEL_ATTEMPT_CAP_EXHAUSTED");
  assert.equal(final.request.remainingReservedMicroUsd, 0);
  assert.equal(final.request.attemptCount, 3);
  await expectCode(
    ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 }),
    "55000",
    "fourth attempt is forbidden",
  );
  const counters = await one(db, `
    select account.reserved_microusd as account_reserved,
      usage.reserved_microusd as daily_reserved,
      usage.reserved_input_tokens, usage.reserved_output_tokens
    from public.truth_model_workspace_accounts account
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key = account.workspace_key
    where account.workspace_key = $1
  `, [workspaceKey]);
  assert.deepEqual([
    Number(counters.account_reserved),
    Number(counters.daily_reserved),
    Number(counters.reserved_input_tokens),
    Number(counters.reserved_output_tokens),
  ], [0, 0, 0, 0]);
  return reserved.initialReservedMicroUsd;
}

async function verifyDispatchRecovery(db, callRpc) {
  const workspaceKey = "model-dispatch-recovery";
  const { ledger } = await provisionWorkspace(db, callRpc, workspaceKey, 1000000, 1000000);
  const source = await seedSource(db, "dispatch-recovery", { workspaceKey });
  const created = await ledger.createRequest(requestFixture(source));
  const reserved = await ledger.reserveRequest({ requestId: created.requestId, leaseFence: 1 });
  const attempt = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
  assert.equal(attempt.sendAuthorized, true);
  assert.equal(attempt.authorizationWorkerId, WORKER);
  assert.equal(attempt.authorizationLeaseFence, 1);
  assert.equal(attempt.authorizationProcessorVersion, PROCESSOR);
  const recoveryKey = `dispatch-recovery:${attempt.dispatchId}`;
  const heldBefore = await one(db, `
    select account.reserved_microusd as account_reserved,
      usage.reserved_microusd as daily_reserved,
      usage.reserved_input_tokens, usage.reserved_output_tokens
    from public.truth_model_workspace_accounts account
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key = account.workspace_key
     and usage.usage_date = $2::date
    where account.workspace_key = $1
  `, [workspaceKey, reserved.reservationDate]);

  await expectCode(ledger.recoverUnknownAttempt({
    requestId: created.requestId,
    dispatchId: attempt.dispatchId,
    recoveryKey,
    leaseFence: 1,
  }), "55000", "current dispatch lease cannot quarantine itself");

  const replacementLease = await replaceSourceJobLease(db, source);
  const recoveryInput = {
    requestId: created.requestId,
    dispatchId: attempt.dispatchId,
    recoveryKey,
    leaseFence: replacementLease.leaseFence,
  };
  const recovered = await ledger.recoverUnknownAttempt(recoveryInput);
  assert.equal(recovered.idempotent, false);
  assert.equal(recovered.sendAuthorized, false);
  assert.equal(recovered.quarantined, true);
  assert.equal(recovered.recoveryReason, DISPATCH_RECOVERY_REASON);
  assert.equal(recovered.reviewReason, DISPATCH_RECOVERY_REVIEW_REASON);
  assert.equal(recovered.externalEffectState, "unknown_possible_post");
  assert.equal(recovered.reservationDisposition, "held_conservatively");
  assert.equal(recovered.reviewDisposition, "non_resolvable_external_effect_uncertainty");
  assert.equal(recovered.authorizationWorkerId, attempt.authorizationWorkerId);
  assert.equal(recovered.authorizationLeaseFence, attempt.authorizationLeaseFence);
  assert.equal(recovered.authorizationProcessorVersion, attempt.authorizationProcessorVersion);
  assert.equal(recovered.authorizationLeaseExpiresAt, attempt.authorizationLeaseExpiresAt);
  assert.equal(recovered.recoveringWorkerId, WORKER);
  assert.equal(recovered.recoveringLeaseFence, replacementLease.leaseFence);
  assert.equal(recovered.recoveringProcessorVersion, PROCESSOR);
  assert.equal(recovered.request.state, "outcome_unknown");
  assert.equal(recovered.request.ok, false);
  assert.equal(recovered.heldReservedMicroUsd, reserved.initialReservedMicroUsd);
  assert.equal(recovered.heldReservedInputTokens, reserved.initialReservedInputTokens);
  assert.equal(recovered.heldReservedOutputTokens, reserved.initialReservedOutputTokens);
  for (const forbidden of [
    "requestSent", "classification", "providerResultHash", "httpStatus",
    "providerResponseId", "serverRequestId", "actualModel", "normalizedResult", "usage",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(recovered, forbidden), false, forbidden);
  }

  const recoveredReplay = await ledger.recoverUnknownAttempt(recoveryInput);
  assert.equal(recoveredReplay.idempotent, true);
  assert.equal(recoveredReplay.recoveryId, recovered.recoveryId);
  assert.equal(recoveredReplay.sendAuthorized, false);
  for (const [label, mutate] of [
    ["self-consistent forged recovery key and identity", (receipt) => {
      receipt.recoveryKey = `${receipt.recoveryKey}:forged`;
      resealRecoveryReceipt(receipt);
    }],
    ["omitted authorization provenance", (receipt) => {
      delete receipt.authorizationWorkerId;
    }],
    ["cross-bound source job", (receipt) => {
      receipt.sourceJobId = crypto.randomUUID();
      resealRecoveryReceipt(receipt);
    }],
    ["cross-bound recovering lease", (receipt) => {
      receipt.recoveringLeaseFence += 1;
      resealRecoveryReceipt(receipt);
    }],
  ]) {
    await expectTamperedRecoveryRejected(
      callRpc, workspaceKey, recoveryInput, `tampered direct recovery ${label}`, mutate,
    );
  }
  await expectCode(ledger.recoverUnknownAttempt({
    requestId: created.requestId,
    dispatchId: attempt.dispatchId,
    recoveryKey: `${recoveryKey}:conflict`,
    leaseFence: replacementLease.leaseFence,
  }), "23505", "changed dispatch recovery conflicts");

  let recoveryFetchCalls = 0;
  const { source: modelSource, modelPlan, modelInput } = extractorFixture("recovery-zero-send");
  const adapter = createOpenAIGmailModelExtractor({
    apiKey: "sk-fake-recovery-verifier-never-live-123456789",
    fetchImpl: async () => {
      recoveryFetchCalls += 1;
      throw new Error("quarantined recovery must never reach transport");
    },
    sleep: async () => { throw new Error("quarantined recovery must never sleep"); },
    jitter: () => 0,
  });
  await assert.rejects(
    adapter.executeAuthorizedAttempt(recoveredReplay, modelInput, {
      modelPlan,
      observation: modelSource,
    }),
    (error) => error?.code === "OPENAI_GMAIL_MODEL_INVALID_ARGUMENT",
  );
  assert.equal(recoveryFetchCalls, 0);

  await expectCode(
    ledger.beginSyncAttempt({
      requestId: created.requestId,
      leaseFence: replacementLease.leaseFence,
    }),
    "55000",
    "quarantined dispatch cannot authorize another attempt",
  );
  await expectCode(reconcileProvider(ledger, attempt, providerAttemptResult(attempt, {
    classification: PROVIDER_CLASSIFICATIONS.OUTCOME_UNKNOWN,
    requestSent: true,
    providerErrorCode: "transport_outcome_unknown",
    outcomeUnknown: true,
    billingOutcomeUnknown: true,
    usage: null,
  })), "55000", "provider result cannot overwrite quarantine uncertainty");

  const read = await ledger.readRequest({ requestId: created.requestId });
  assert.equal(read.state, "outcome_unknown");
  assert.equal(read.attempts.length, 1);
  assert.equal(read.attempts[0].quarantined, true);
  assert.equal(read.attempts[0].sendAuthorized, false);
  assert.equal(Object.prototype.hasOwnProperty.call(read.attempts[0], "requestSent"), false);
  for (const [label, mutate] of [
    ["fabricated requestSent", (receipt) => { receipt.attempts[0].requestSent = false; }],
    ["recovery hash", (receipt) => { receipt.attempts[0].recoveryHash = "0".repeat(64); }],
    ["self-consistent forged recovery identity", (receipt) => {
      const forgedHash = "0".repeat(64);
      receipt.attempts[0].recoveryHash = forgedHash;
      receipt.attempts[0].recoveryId = `model-dispatch-recovery:v1:${forgedHash}`;
      receipt.attempts[0].recovery.recoveryHash = forgedHash;
      receipt.attempts[0].recovery.recoveryId = `model-dispatch-recovery:v1:${forgedHash}`;
    }],
    ["cross-bound recovery source job", (receipt) => {
      receipt.attempts[0].recovery.sourceJobId = crypto.randomUUID();
      resealRecoveryReceipt(receipt.attempts[0].recovery);
    }],
    ["invalid recovery timestamp", (receipt) => {
      receipt.attempts[0].recoveredAt = "not-a-timestamp";
      receipt.attempts[0].recovery.recoveredAt = "not-a-timestamp";
    }],
    ["recovery before dispatch", (receipt) => {
      receipt.attempts[0].recoveredAt = "2026-07-09T14:31:00.000Z";
      receipt.attempts[0].recovery.recoveredAt = "2026-07-09T14:31:00.000Z";
    }],
    ["held reservation", (receipt) => { receipt.attempts[0].heldReservedMicroUsd -= 1; }],
    ["resolved request state", (receipt) => { receipt.state = "review_required"; }],
  ]) {
    await expectTamperedReadRejected(
      callRpc, workspaceKey, created.requestId, `tampered recovery read ${label}`, mutate,
    );
  }
  const heldAfter = await one(db, `
    select account.reserved_microusd as account_reserved,
      usage.reserved_microusd as daily_reserved,
      usage.reserved_input_tokens, usage.reserved_output_tokens,
      (select count(*)::integer from public.truth_model_sync_dispatch_recoveries
        where dispatch_id = $3) as recoveries,
      (select count(*)::integer from public.truth_model_sync_attempt_outcomes
        where dispatch_id = $3) as outcomes
    from public.truth_model_workspace_accounts account
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key = account.workspace_key
     and usage.usage_date = $2::date
    where account.workspace_key = $1
  `, [workspaceKey, reserved.reservationDate, attempt.dispatchId]);
  assert.deepEqual([
    Number(heldAfter.account_reserved),
    Number(heldAfter.daily_reserved),
    Number(heldAfter.reserved_input_tokens),
    Number(heldAfter.reserved_output_tokens),
  ], [
    Number(heldBefore.account_reserved),
    Number(heldBefore.daily_reserved),
    Number(heldBefore.reserved_input_tokens),
    Number(heldBefore.reserved_output_tokens),
  ]);
  assert.equal(heldAfter.recoveries, 1);
  assert.equal(heldAfter.outcomes, 0);
  await expectCode(db.query(`
    update public.truth_model_sync_dispatch_recoveries
    set recovery_reason = recovery_reason where recovery_id = $1
  `, [recovered.recoveryId]), "55000", "dispatch recovery is immutable");
  await expectCode(db.query(`
    update public.truth_model_requests
    set state = 'review_required', review_reason = 'HUMAN_REVIEW_RESOLVED'
    where request_id = $1
  `, [created.requestId]), "55000", "review cannot erase external-effect uncertainty");
  return Object.freeze({
    source,
    requestId: created.requestId,
    dispatchId: attempt.dispatchId,
    recoveryId: recovered.recoveryId,
    replacementLeaseFence: replacementLease.leaseFence,
    reservationDate: reserved.reservationDate,
    heldReservedInputTokens: recovered.heldReservedInputTokens,
    heldReservedOutputTokens: recovered.heldReservedOutputTokens,
    heldReservedMicroUsd: recovered.heldReservedMicroUsd,
    fetchCalls: recoveryFetchCalls,
  });
}

async function verifySourceJobRequestDiscovery(db, callRpc) {
  const workspaceKey = "model-source-job-request-lookup";
  const { ledger } = await provisionWorkspace(db, callRpc, workspaceKey, 1000000, 1000000);
  const absentSource = await seedSource(db, "lookup-absent", { workspaceKey });
  const absentFixture = requestFixture(absentSource);
  await installSealedModelPlan(db, absentSource, absentFixture, "lookup-absent");
  const absentBinding = {
    sourceJobId: absentSource.jobId,
    observationId: absentSource.observationId,
    observationContentHash: absentSource.contentHash,
    planHash: absentSource.planHash,
    leaseFence: 1,
  };
  const absent = await ledger.findRequestForSourceJob(absentBinding);
  assert.deepEqual(absent, { ok: true, found: false, request: null });
  const noRecovery = await ledger.readRecoveryStatus({ sourceJobId: absentSource.jobId });
  assert.equal(noRecovery.found, false);
  assert.equal(noRecovery.externalEffectResolutionStatus, "not_recorded");
  assert.equal(noRecovery.recovery, null);
  await assert.rejects(
    ledger.findRequestForSourceJob({ ...absentBinding, requestId: `model-request:v1:${"0".repeat(64)}` }),
    (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT" && error?.field === "requestId",
  );
  for (const [label, changed, code] of [
    ["observation", { observationId: `obs:v1:${sha256("wrong-lookup-observation")}` }, "23514"],
    ["content", { observationContentHash: sha256("wrong-lookup-content") }, "23514"],
    ["plan", { planHash: sha256("wrong-lookup-plan") }, "23514"],
    ["lease", { leaseFence: 2 }, "40001"],
    ["wrong-kind parent", { sourceJobId: absentSource.parentJobId }, "40001"],
  ]) {
    await expectCode(
      ledger.findRequestForSourceJob({ ...absentBinding, ...changed }),
      code,
      `source-job lookup ${label} mismatch fails closed`,
    );
  }

  const parkedSource = await seedSource(db, "lookup-parked", { workspaceKey });
  const parkedFixture = requestFixture(parkedSource);
  await installSealedModelPlan(
    db, parkedSource, parkedFixture, "lookup-parked", { executionMode: "parked" },
  );
  const parkedBinding = {
    sourceJobId: parkedSource.jobId,
    observationId: parkedSource.observationId,
    observationContentHash: parkedSource.contentHash,
    planHash: parkedSource.planHash,
    leaseFence: 1,
  };
  const honestParked = await ledger.findRequestForSourceJob(parkedBinding);
  assert.deepEqual(honestParked, { ok: true, found: false, request: null });
  await expectCode(
    ledger.createRequest(parkedFixture),
    "23514",
    "sealed parked plan cannot create a model request through authority",
  );
  await db.query(`
    alter table public.truth_model_requests
    disable trigger truth_model_request_gmail_plan_guard
  `);
  let illicitParked;
  try {
    illicitParked = await ledger.createRequest(parkedFixture);
  } finally {
    await db.query(`
      alter table public.truth_model_requests
      enable trigger truth_model_request_gmail_plan_guard
    `);
  }
  assert.equal(illicitParked.state, "planned");
  await expectCode(
    ledger.findRequestForSourceJob(parkedBinding),
    "23514",
    "legacy or illicit request under parked execution fails lookup closed",
  );
  const parkedGuard = await one(db, `
    select trigger.tgenabled as enabled
    from pg_trigger trigger
    where trigger.tgrelid='public.truth_model_requests'::regclass
      and trigger.tgname='truth_model_request_gmail_plan_guard'
      and not trigger.tgisinternal
  `);
  assert.equal(parkedGuard.enabled, "O");

  const paidSource = await seedSource(db, "lookup-paid-terminal", { workspaceKey });
  const paidFixture = requestFixture(paidSource);
  await installSealedModelPlan(db, paidSource, paidFixture, "lookup-paid-terminal");
  const created = await ledger.createRequest(paidFixture);
  await ledger.reserveRequest({ requestId: created.requestId, leaseFence: 1 });
  const attempt = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
  const paid = await reconcileProvider(ledger, attempt, providerAttemptResult(attempt, {
    classification: PROVIDER_CLASSIFICATIONS.SUCCEEDED,
    httpStatus: 200,
    providerResponseBody: '{"id":"resp_source_job_lookup","status":"completed"}',
    providerResponseId: "resp_source_job_lookup",
    serverRequestId: "req_source_job_lookup",
    actualModel: MODEL,
    modelResponse: validModelResponse(),
    usage: {
      inputTokens: 50,
      cachedInputTokens: 5,
      outputTokens: 20,
      reasoningTokens: 3,
      totalTokens: 70,
    },
  }));
  assert.equal(paid.request.state, "succeeded");
  assert.ok(paid.request.actualMicroUsd > 0);
  const paidBinding = {
    sourceJobId: paidSource.jobId,
    observationId: paidSource.observationId,
    observationContentHash: paidSource.contentHash,
    planHash: paidSource.planHash,
    leaseFence: 1,
  };
  const discovered = await ledger.findRequestForSourceJob(paidBinding);
  assert.equal(discovered.found, true);
  assert.equal(discovered.request.requestId, created.requestId);
  assert.equal(discovered.request.state, "succeeded");
  assert.equal(discovered.request.actualMicroUsd, paid.request.actualMicroUsd);
  assert.equal(discovered.request.attempts.length, 1);
  assert.equal(discovered.request.attempts[0].classification, "success");

  const tamperedLedger = ledgerFor(async (rpc, body, options) => {
    const receipt = await callRpc(rpc, body, options);
    if (rpc !== RPC.findRequestForSourceJob) return receipt;
    const copy = JSON.parse(JSON.stringify(receipt));
    copy.request.attempts[0].outcomeHash = "0".repeat(64);
    return copy;
  }, workspaceKey);
  await assert.rejects(
    tamperedLedger.findRequestForSourceJob(paidBinding),
    (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
    "source-job lookup must validate the full persisted terminal receipt",
  );
  return Object.freeze({ requestId: created.requestId, actualMicroUsd: paid.request.actualMicroUsd });
}

async function verifyOperationalReviewIndependent(db, callRpc, recoveryProof) {
  const source = recoveryProof.source;
  const ledger = ledgerFor(callRpc, source.workspaceKey);
  const fixture = requestFixture(source);
  const plan = await installSealedModelPlan(
    db, source, fixture, `dispatch-recovery:${recoveryProof.requestId}`,
  );
  const binding = {
    sourceJobId: source.jobId,
    observationId: source.observationId,
    observationContentHash: source.contentHash,
    planHash: source.planHash,
    leaseFence: recoveryProof.replacementLeaseFence,
  };
  const discovered = await ledger.findRequestForSourceJob(binding);
  assert.equal(discovered.found, true);
  assert.equal(discovered.request.requestId, recoveryProof.requestId);
  assert.equal(discovered.request.state, "outcome_unknown");
  assert.equal(discovered.request.attempts.length, 1);
  assert.equal(discovered.request.attempts[0].quarantined, true);

  await db.query(`
    update public.source_processing_jobs
    set state='succeeded',lease_owner=null,lease_expires_at=null,
      last_error_code='',safe_error_detail='',
      result=jsonb_build_object(
        'schemaVersion','gmail-model-extraction-job-result-v1',
        'status','review_required','reasonCode',$4::text
      ),updated_at=clock_timestamp(),completed_at=clock_timestamp()
    where workspace_key=$1 and job_id=$2 and state='leased' and lease_fence=$3
  `, [
    source.workspaceKey, source.jobId, recoveryProof.replacementLeaseFence,
    DISPATCH_RECOVERY_REVIEW_REASON,
  ]);
  const reviewJobId = crypto.randomUUID();
  await db.query(`
    insert into public.source_processing_jobs(
      job_id,dedupe_key,workspace_key,source_system,connection_key,job_kind,
      observation_id,source_object_id,state,attempt_count,max_attempts,payload
    ) values($1,$2,$3,'gmail',$4,'gmail_review_model_extraction',$5,$6,
      'queued',0,5,'{}'::jsonb)
  `, [
    reviewJobId, `review-quarantine:${recoveryProof.requestId}`,
    source.workspaceKey, source.connectionKey, source.observationId,
    `review-message-${source.jobId}`,
  ]);
  const obligationHash = sha256(`review-obligation:${recoveryProof.requestId}`);
  const obligationId = `gmail-model-review:v1:${obligationHash}`;
  await db.query(`
    insert into public.gmail_model_extraction_review_obligations(
      obligation_id,workspace_key,extraction_plan_id,model_plan_id,
      model_child_job_id,review_job_id,reason_code,safe_detail_hash,
      canonical_obligation,obligation_hash
    ) values($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb,$9)
  `, [
    obligationId, source.workspaceKey, plan.extractionPlanId,
    source.modelPlanId, source.jobId,
    reviewJobId, DISPATCH_RECOVERY_REVIEW_REASON,
    sha256(`review-detail:${recoveryProof.requestId}`), obligationHash,
  ]);
  const beforeStatus = await ledger.readRecoveryStatus({ sourceJobId: source.jobId });
  assert.equal(beforeStatus.found, true);
  assert.equal(beforeStatus.externalEffectResolutionStatus, "unresolved");
  assert.equal(beforeStatus.operationalReviewResolved, false);
  assert.equal(beforeStatus.operationalReviewObligationId, obligationId);
  assert.equal(beforeStatus.recovery.request.state, "outcome_unknown");

  const beforeHold = await one(db, `
    select
      request.state as request_state,request.review_reason,
      request.remaining_reserved_input_tokens,request.remaining_reserved_output_tokens,
      request.remaining_reserved_microusd,account.reserved_microusd as account_reserved,
      usage.reserved_input_tokens as daily_reserved_input,
      usage.reserved_output_tokens as daily_reserved_output,
      usage.reserved_microusd as daily_reserved_microusd,recovery.recovery_hash,
      (select count(*)::integer from public.truth_model_sync_attempt_outcomes outcome
        where outcome.dispatch_id=recovery.dispatch_id) as outcome_count
    from public.truth_model_requests request
    join public.truth_model_sync_dispatch_recoveries recovery
      on recovery.request_id=request.request_id and recovery.workspace_key=request.workspace_key
    join public.truth_model_workspace_accounts account
      on account.workspace_key=request.workspace_key
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key=request.workspace_key and usage.usage_date=request.reservation_date
    where request.request_id=$1
  `, [recoveryProof.requestId]);
  const beforeCut = await one(db, `
    select
      (select count(*)::integer from private.unresolved_gmail_model_extraction_reviews($1)
        where obligation_id=$2) as unresolved_reviews,
      (select count(*)::integer from private.unresolved_gmail_model_extraction_jobs($1)
        where model_child_job_id=$3) as unresolved_model_jobs
  `, [source.workspaceKey, obligationId, source.jobId]);
  assert.equal(beforeCut.unresolved_reviews, 1);
  assert.equal(beforeCut.unresolved_model_jobs, 0);

  const resolved = await one(db, `
    select public.resolve_gmail_model_extraction_review(
      $1,$2,'reviewed_no_additional_claims','[]'::jsonb,
      'verifier','operational evidence reviewed independently',$3,$4,$5
    ) as receipt
  `, [
    source.workspaceKey, obligationId,
    `review-resolution:${recoveryProof.requestId}`, REVIEW_TOKEN, SYNC_TOKEN,
  ]);
  assert.equal(resolved.receipt.ok, true);
  assert.equal(resolved.receipt.obligationId, obligationId);

  const afterStatus = await ledger.readRecoveryStatus({ sourceJobId: source.jobId });
  assert.equal(afterStatus.found, true);
  assert.equal(afterStatus.externalEffectResolutionStatus, "unresolved");
  assert.equal(afterStatus.operationalReviewResolved, true);
  assert.equal(afterStatus.operationalReviewObligationId, obligationId);
  assert.equal(afterStatus.operationalReviewResolutionId, resolved.receipt.resolutionId);
  assert.equal(afterStatus.recovery.recoveryId, beforeStatus.recovery.recoveryId);
  assert.equal(afterStatus.recovery.request.state, "outcome_unknown");
  for (const [label, mutate] of [
    ["laundered status", (receipt) => {
      receipt.externalEffectResolutionStatus = "resolved";
    }],
    ["omitted authorization tuple field", (receipt) => {
      delete receipt.recovery.authorizationLeaseExpiresAt;
    }],
    ["tampered authorization tuple", (receipt) => {
      receipt.recovery.authorizationWorkerId = "forged-authorizer";
    }],
    ["self-consistent cross-bound source", (receipt) => {
      receipt.recovery.sourceJobId = crypto.randomUUID();
      resealRecoveryReceipt(receipt.recovery);
    }],
  ]) {
    const tamperedStatusLedger = ledgerFor(async (rpc, body, options) => {
      const receipt = await callRpc(rpc, body, options);
      if (rpc !== RPC.readRecoveryStatus) return receipt;
      const copy = JSON.parse(JSON.stringify(receipt));
      mutate(copy);
      return copy;
    }, source.workspaceKey);
    await assert.rejects(
      tamperedStatusLedger.readRecoveryStatus({ sourceJobId: source.jobId }),
      (error) => error?.code === "TRUTH_MODEL_LEDGER_INVALID_RECEIPT",
      `tampered recovery status ${label}`,
    );
  }

  const afterHold = await one(db, `
    select
      request.state as request_state,request.review_reason,
      request.remaining_reserved_input_tokens,request.remaining_reserved_output_tokens,
      request.remaining_reserved_microusd,account.reserved_microusd as account_reserved,
      usage.reserved_input_tokens as daily_reserved_input,
      usage.reserved_output_tokens as daily_reserved_output,
      usage.reserved_microusd as daily_reserved_microusd,recovery.recovery_hash,
      (select count(*)::integer from public.truth_model_sync_attempt_outcomes outcome
        where outcome.dispatch_id=recovery.dispatch_id) as outcome_count
    from public.truth_model_requests request
    join public.truth_model_sync_dispatch_recoveries recovery
      on recovery.request_id=request.request_id and recovery.workspace_key=request.workspace_key
    join public.truth_model_workspace_accounts account
      on account.workspace_key=request.workspace_key
    join public.truth_model_workspace_daily_usage usage
      on usage.workspace_key=request.workspace_key and usage.usage_date=request.reservation_date
    where request.request_id=$1
  `, [recoveryProof.requestId]);
  assert.deepEqual(afterHold, beforeHold);
  assert.equal(afterHold.request_state, "outcome_unknown");
  assert.equal(Number(afterHold.remaining_reserved_input_tokens), recoveryProof.heldReservedInputTokens);
  assert.equal(Number(afterHold.remaining_reserved_output_tokens), recoveryProof.heldReservedOutputTokens);
  assert.equal(Number(afterHold.remaining_reserved_microusd), recoveryProof.heldReservedMicroUsd);
  assert.equal(afterHold.outcome_count, 0);

  const afterCut = await one(db, `
    select
      (select count(*)::integer from private.unresolved_gmail_model_extraction_reviews($1)
        where obligation_id=$2) as unresolved_reviews,
      (select count(*)::integer from public.gmail_model_extraction_review_resolutions
        where obligation_id=$2) as resolution_count,
      (select state from public.source_processing_jobs where job_id=$3) as review_job_state,
      exists(
        select 1 from pg_trigger trigger
        where trigger.tgrelid='public.gmail_model_extraction_review_resolutions'::regclass
          and trigger.tgname='gmail_model_review_external_uncertainty_guard'
          and not trigger.tgisinternal
      ) as obsolete_guard_installed
  `, [source.workspaceKey, obligationId, reviewJobId]);
  assert.equal(afterCut.unresolved_reviews, 0);
  assert.equal(afterCut.resolution_count, 1);
  assert.equal(afterCut.review_job_state, "succeeded");
  assert.equal(afterCut.obsolete_guard_installed, false);
  return Object.freeze({
    obligationId,
    resolutionId: resolved.receipt.resolutionId,
    recoveryStatus: afterStatus.externalEffectResolutionStatus,
  });
}

async function main() {
  let networkCalls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error("network access is forbidden in truth model ledger verification");
  };
  const db = await createDatabase();
  const checks = [];
  try {
    for (const name of MIGRATION_NAMES) await applyMigration(db, name);
    await seedTokens(db);
    checks.push("full migration stack applies");

    const actualMappings = await verifyActualExtractorMappings();
    assert.equal(actualMappings.length, 18);
    checks.push("actual fake extractor outputs map exhaustively and fail closed on missing usage");

    const callRpc = createDbRpcCaller(db);
    const authorizedE2e = await verifyAuthorizedProviderLedgerE2e(db, callRpc);
    assert.equal(authorizedE2e.fetchCalls, 2);
    checks.push("real database authorization drives exact provider execution and reconciliation");

    const ledger = ledgerFor(callRpc, WORKSPACE);
    const issuer = issuerFor(callRpc, WORKSPACE);

    const pricing = await db.query(`
      select model_snapshot, transport, input_microusd_per_million,
        cached_input_microusd_per_million, output_microusd_per_million,
        pricing_policy_id
      from public.truth_model_pricing_policies order by model_snapshot, transport
    `);
    assert.equal(pricing.rows.length, 4);
    for (const row of pricing.rows) {
      const policy = pricingPolicy(row.model_snapshot, row.transport);
      assert.equal(row.pricing_policy_id, policy.pricingPolicyId);
      assert.deepEqual([
        Number(row.input_microusd_per_million),
        Number(row.cached_input_microusd_per_million),
        Number(row.output_microusd_per_million),
      ], [
        policy.inputMicroUsdPerMillion,
        policy.cachedInputMicroUsdPerMillion,
        policy.outputMicroUsdPerMillion,
      ]);
    }
    const defaultAccount = await one(db, `
      select status, reserved_microusd, actual_microusd
      from public.truth_model_workspace_accounts where workspace_key = $1
    `, [WORKSPACE]);
    assert.deepEqual([
      defaultAccount.status,
      Number(defaultAccount.reserved_microusd),
      Number(defaultAccount.actual_microusd),
    ], ["disabled", 0, 0]);
    checks.push("pinned pricing and disabled-by-default account");

    const unauthorizedIssuer = issuerFor(callRpc, WORKSPACE, SYNC_TOKEN);
    await expectCode(unauthorizedIssuer.configure({
      configurationRequestKey: "unauthorized-enable",
      enabled: true,
      lifetimeAllocationMicroUsd: 13000000,
      dailyCeilingMicroUsd: 2000000,
      configuredBy: "verifier",
      configurationReason: "must fail",
    }), "28000", "sync token cannot activate model account");
    const enabled = await issuer.configure({
      configurationRequestKey: "enable-primary-v1",
      enabled: true,
      lifetimeAllocationMicroUsd: 13000000,
      dailyCeilingMicroUsd: 2000000,
      configuredBy: "verifier",
      configurationReason: "bounded model ledger verification",
    });
    assert.equal(enabled.status, "enabled");
    const enabledReplay = await issuer.configure({
      configurationRequestKey: "enable-primary-v1",
      enabled: true,
      lifetimeAllocationMicroUsd: 13000000,
      dailyCeilingMicroUsd: 2000000,
      configuredBy: "verifier",
      configurationReason: "bounded model ledger verification",
    });
    assert.equal(enabledReplay.idempotent, true);
    checks.push("issuer-only account activation and idempotent configuration");

    const wrongKind = await seedSource(db, "wrong-kind", { jobKind: "gmail_extract_message_claims" });
    await expectCode(ledger.createRequest(requestFixture(wrongKind)), "40001", "wrong-kind lease");
    const expired = await seedSource(db, "expired", { expired: true });
    await expectCode(ledger.createRequest(requestFixture(expired)), "40001", "expired lease");
    const wrongPlan = await seedSource(db, "wrong-plan-binding");
    await expectCode(ledger.createRequest(requestFixture(wrongPlan, {
      planHash: sha256("different-model-plan"),
    })), "23514", "request plan differs from leased job payload");
    checks.push("exact live source-job lease and content-addressed Gmail model-plan authority");

    const source = await seedSource(db, "success");
    const fixture = requestFixture(source);
    const prepared = preparedRequest(fixture);
    const created = await ledger.createRequest(prepared);
    assert.equal(created.state, "planned");
    assert.equal(created.requestPayload.metadata.model_plan_hash, fixture.planHash);
    assert.equal(created.requestPayload.metadata.source_observation_id, fixture.observationId);
    assert.equal(created.requestPayload.metadata.source_content_hash, fixture.observationContentHash);
    assert.equal(created.requestPayload.metadata.prompt_version, fixture.promptVersion);
    assert.equal(created.requestPayloadHash, sha256(created.requestPayloadText));
    assert.equal(created.maxInputTokens, Buffer.byteLength(created.requestPayloadText, "utf8"));
    const createdReplay = await ledger.createRequest(prepared);
    assert.equal(createdReplay.idempotent, true);
    await expectCode(ledger.createRequest({
      ...fixture,
      logicalRequestKey: `${fixture.logicalRequestKey}:second-request`,
    }), "23505", "one logical request per leased source job");
    await expectCode(ledger.createRequest(requestFixture(source, {
      logicalRequestKey: fixture.logicalRequestKey,
      maxOutputTokens: MAX_OUTPUT_TOKENS + 1,
    })), "23505", "logical request conflict");
    const tampered = await seedSource(db, "tampered");
    await expectCode(ledger.createRequest(requestFixture(tampered, {
      mutateBody: (body) => { body.metadata.model_plan_hash = sha256("wrong-plan"); },
    })), "23514", "wire metadata mismatch");
    checks.push("exact wire payload, structural authority, and request idempotency");

    const reserved = await ledger.reserveRequest({ requestId: created.requestId, leaseFence: 1 });
    const perAttemptCost = Math.ceil((reserved.maxInputTokens * 50000) / 1000000)
      + Math.ceil((reserved.maxOutputTokens * 400000) / 1000000);
    assert.equal(reserved.initialReservedMicroUsd, perAttemptCost * 3);
    assert.equal(reserved.initialReservedInputTokens, reserved.maxInputTokens * 3);
    assert.equal(reserved.initialReservedOutputTokens, reserved.maxOutputTokens * 3);
    const first = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
    assert.equal(first.sendAuthorized, true);
    assert.equal(first.attemptNumber, 1);
    const crashReplay = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
    assert.equal(crashReplay.sendAuthorized, false);
    assert.equal(crashReplay.dispatchId, first.dispatchId);
    const dispatchCount = await one(db, `
      select count(*)::integer as count from public.truth_model_sync_attempt_dispatches
      where request_id = $1
    `, [created.requestId]);
    assert.equal(dispatchCount.count, 1);
    checks.push("three-attempt conservative reservation and crash-safe begin");

    const rateProviderResult = providerAttemptResult(first, {
      classification: PROVIDER_CLASSIFICATIONS.RATE_LIMIT_EXCEEDED,
      httpStatus: 429,
      providerResponseBody: '{"error":{"code":"rate_limit_exceeded"}}',
      providerErrorCode: "rate_limit_exceeded",
      usage: null,
    });
    const rateLimited = await reconcileProvider(ledger, first, rateProviderResult);
    assert.equal(rateLimited.request.state, "reserved");
    assert.equal(rateLimited.request.remainingReservedMicroUsd, reserved.initialReservedMicroUsd);
    const second = await ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 });
    assert.equal(second.sendAuthorized, true);
    assert.equal(second.attemptNumber, 2);
    await expectCode(ledger.reconcileProviderAttempt({
      requestId: created.requestId,
      attemptNumber: second.attemptNumber,
      dispatchId: second.dispatchId,
      clientRequestId: second.clientRequestId,
      providerResult: rateProviderResult,
    }), "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT", "attempt-1 receipt cannot reconcile attempt 2");
    const normalizedResult = validModelResponse();
    for (const [label, modelResponse] of [
      ["empty", {}],
      ["wrong-schema", { ...normalizedResult, schemaVersion: "wrong-schema" }],
    ]) {
      const invalidSuccess = providerAttemptResult(second, {
        classification: PROVIDER_CLASSIFICATIONS.SUCCEEDED,
        httpStatus: 200,
        providerResponseBody: `{"id":"invalid_${label}"}`,
        providerResponseId: `invalid_${label}`,
        serverRequestId: `invalid_req_${label}`,
        actualModel: MODEL,
        modelResponse,
        usage: { inputTokens: 50, cachedInputTokens: 5, outputTokens: 20, reasoningTokens: 3, totalTokens: 70 },
      });
      await expectCode(
        reconcileProvider(ledger, second, invalidSuccess),
        "TRUTH_MODEL_LEDGER_INVALID_ARGUMENT",
        `${label} success result is rejected`,
      );
    }
    const successProviderResult = providerAttemptResult(second, {
      classification: PROVIDER_CLASSIFICATIONS.SUCCEEDED,
      httpStatus: 200,
      providerResponseBody: '{"id":"resp_ledger_success","status":"completed"}',
      providerResponseId: "resp_ledger_success",
      serverRequestId: "req_ledger_success",
      actualModel: MODEL,
      modelResponse: normalizedResult,
      usage: { inputTokens: 50, cachedInputTokens: 5, outputTokens: 20, reasoningTokens: 3, totalTokens: 70 },
    });
    const succeeded = await reconcileProvider(ledger, second, successProviderResult);
    assert.equal(succeeded.request.state, "succeeded");
    const exactUsageCost = Math.ceil((45 * 50000) / 1000000)
      + Math.ceil((5 * 5000) / 1000000)
      + Math.ceil((20 * 400000) / 1000000);
    assert.equal(exactUsageCost, 12);
    assert.equal(succeeded.actualMicroUsd, exactUsageCost);
    assert.equal(succeeded.request.actualMicroUsd, exactUsageCost);
    assert.deepEqual(succeeded.normalizedResult, normalizedResult);
    assert.equal(succeeded.normalizedResultHash, _test.sha256Jsonb(normalizedResult));
    const exactReplay = await reconcileProvider(ledger, second, successProviderResult);
    assert.equal(exactReplay.idempotent, true);
    const changedSuccess = providerAttemptResult(second, {
      classification: PROVIDER_CLASSIFICATIONS.SUCCEEDED,
      httpStatus: 200,
      providerResponseBody: '{"id":"resp_ledger_success","status":"completed"}',
      providerResponseId: "resp_ledger_success",
      serverRequestId: "req_ledger_success",
      actualModel: MODEL,
      modelResponse: normalizedResult,
      usage: { inputTokens: 50, cachedInputTokens: 4, outputTokens: 20, reasoningTokens: 3, totalTokens: 70 },
    });
    await expectCode(
      reconcileProvider(ledger, second, changedSuccess),
      "23505",
      "changed reconciliation replay",
    );
    const read = await ledger.readRequest({ requestId: created.requestId });
    assert.equal(read.attempts.length, 2);
    assert.deepEqual(read.attempts[1].normalizedResult, normalizedResult);
    assert.equal(read.remainingReservedMicroUsd, 0);
    assert.equal(Object.isFrozen(read), true);
    assert.equal(Object.isFrozen(read.attempts), true);
    assert.equal(Object.isFrozen(read.attempts[1].normalizedResult), true);
    for (const [label, mutate] of [
      ["reordered attempts", (receipt) => receipt.attempts.reverse()],
      ["duplicate attempt identity", (receipt) => { receipt.attempts[1] = receipt.attempts[0]; }],
      ["request body hash", (receipt) => { receipt.attempts[1].requestBodyHash = "0".repeat(64); }],
      ["normalized result", (receipt) => {
        receipt.attempts[1].normalizedResult.claims[0].confidence = 0.85;
      }],
      ["normalized and full outcome hash", (receipt) => {
        receipt.attempts[1].normalizedResult.claims[0].confidence = 0.85;
        receipt.attempts[1].normalizedResultHash = _test.sha256Jsonb(
          receipt.attempts[1].normalizedResult,
        );
      }],
      ["full outcome hash", (receipt) => { receipt.attempts[1].outcomeHash = "0".repeat(64); }],
      ["success provider identity", (receipt) => { receipt.attempts[1].providerResponseId = ""; }],
      ["success actual model", (receipt) => { receipt.attempts[1].actualModel = "wrong-model"; }],
      ["usage shape", (receipt) => { receipt.attempts[1].totalTokens += 1; }],
      ["request attempt count", (receipt) => { receipt.attemptCount = 1; }],
      ["request terminal state", (receipt) => { receipt.state = "reserved"; }],
    ]) {
      await expectTamperedReadRejected(
        callRpc, WORKSPACE, created.requestId, `tampered read ${label}`, mutate,
      );
    }
    await expectCode(ledger.beginSyncAttempt({ requestId: created.requestId, leaseFence: 1 }), "55000", "terminal request");
    checks.push("persisted success replay validates ordered attempts, exact wire/result/full hashes, provider identity, and usage");
    checks.push("exact cached/uncached/output cost, reasoning non-duplication, retry hold, and terminal release");

    const uniqueWorkspace = "model-provider-id-unique";
    const { ledger: uniqueLedger } = await provisionWorkspace(
      db, callRpc, uniqueWorkspace, 1000000, 1000000,
    );
    for (const [label, providerResponseId, serverRequestId] of [
      ["provider", "resp_ledger_success", "req_unique_provider"],
      ["server", "resp_unique_server", "req_ledger_success"],
    ]) {
      const duplicateSource = await seedSource(db, `duplicate-${label}`, {
        workspaceKey: uniqueWorkspace,
      });
      const duplicateCreated = await uniqueLedger.createRequest(requestFixture(duplicateSource));
      await uniqueLedger.reserveRequest({ requestId: duplicateCreated.requestId, leaseFence: 1 });
      const duplicateAttempt = await uniqueLedger.beginSyncAttempt({
        requestId: duplicateCreated.requestId,
        leaseFence: 1,
      });
      const duplicateResult = providerAttemptResult(duplicateAttempt, {
        classification: PROVIDER_CLASSIFICATIONS.SUCCEEDED,
        httpStatus: 200,
        providerResponseBody: `{"id":"${providerResponseId}"}`,
        providerResponseId,
        serverRequestId,
        actualModel: MODEL,
        modelResponse: validModelResponse(),
        usage: { inputTokens: 50, cachedInputTokens: 5, outputTokens: 20, reasoningTokens: 3, totalTokens: 70 },
      });
      await expectCode(
        reconcileProvider(uniqueLedger, duplicateAttempt, duplicateResult),
        "23505",
        `duplicate ${label} request identity`,
      );
    }
    checks.push("DB attempt identity and globally unique provider/server receipts prevent double charge");

    const dispatchRecovery = await verifyDispatchRecovery(db, callRpc);
    assert.equal(dispatchRecovery.fetchCalls, 0);
    assert.ok(dispatchRecovery.heldReservedMicroUsd > 0);
    checks.push("stale dispatch quarantine is zero-send, reservation-held, fully content-addressed, input-bound, and forgery-checked");

    const unknownSource = await seedSource(db, "unknown");
    const unknownCreated = await ledger.createRequest(requestFixture(unknownSource));
    const unknownReserved = await ledger.reserveRequest({ requestId: unknownCreated.requestId, leaseFence: 1 });
    const unknownAttempt = await ledger.beginSyncAttempt({ requestId: unknownCreated.requestId, leaseFence: 1 });
    const oversizedInputTokens = unknownAttempt.request.maxInputTokens + 1;
    const oversizedProviderResult = providerAttemptResult(unknownAttempt, {
      classification: PROVIDER_CLASSIFICATIONS.SERVER_ERROR,
      httpStatus: 500,
      providerResponseBody: '{"error":{"code":"internal_error","usage":"oversized"}}',
      actualModel: MODEL,
      usage: {
        inputTokens: oversizedInputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: oversizedInputTokens,
      },
    });
    await expectCode(
      reconcileProvider(ledger, unknownAttempt, oversizedProviderResult),
      "23514",
      "per-attempt input usage exceeds sealed maximum",
    );
    const transportUnknownResult = providerAttemptResult(unknownAttempt, {
      classification: PROVIDER_CLASSIFICATIONS.OUTCOME_UNKNOWN,
      httpStatus: null,
      providerResponseBody: "",
      providerErrorCode: "transport_outcome_unknown",
      outcomeUnknown: true,
      billingOutcomeUnknown: true,
      usage: null,
    });
    const unknown = await reconcileProvider(ledger, unknownAttempt, transportUnknownResult);
    assert.equal(unknown.request.state, "outcome_unknown");
    assert.equal(unknown.request.remainingReservedMicroUsd, unknownReserved.initialReservedMicroUsd);
    await expectCode(ledger.beginSyncAttempt({ requestId: unknownCreated.requestId, leaseFence: 1 }), "55000", "unknown blocks retry");
    assert.equal(unknown.ok, true);
    assert.equal(unknown.request.ok, false);

    const billingSource = await seedSource(db, "billing-unknown");
    const billingCreated = await ledger.createRequest(requestFixture(billingSource));
    const billingReserved = await ledger.reserveRequest({ requestId: billingCreated.requestId, leaseFence: 1 });
    const billingAttempt = await ledger.beginSyncAttempt({ requestId: billingCreated.requestId, leaseFence: 1 });
    const billingUnknownResult = providerAttemptResult(billingAttempt, {
      classification: PROVIDER_CLASSIFICATIONS.SERVER_ERROR,
      httpStatus: 500,
      providerResponseBody: "not-json-5xx-response",
      providerErrorCode: "malformed_5xx_without_usage",
      billingOutcomeUnknown: true,
      usage: null,
    });
    const billingUnknown = await reconcileProvider(ledger, billingAttempt, billingUnknownResult);
    assert.equal(billingUnknown.billingOutcomeUnknown, true);
    assert.equal(billingUnknown.request.state, "outcome_unknown");
    assert.equal(billingUnknown.request.ok, false);
    assert.equal(
      billingUnknown.request.remainingReservedMicroUsd,
      billingReserved.initialReservedMicroUsd,
    );
    await expectCode(
      ledger.beginSyncAttempt({ requestId: billingCreated.requestId, leaseFence: 1 }),
      "55000",
      "billing unknown blocks retry",
    );
    checks.push("transport and malformed-5xx billing ambiguity hold reservations and block retries");

    const batchSource = await seedSource(db, "batch");
    const batchCreated = await ledger.createRequest(requestFixture(batchSource, { transport: "batch" }));
    assert.equal(batchCreated.maxAttempts, 1);
    const batchReserved = await ledger.reserveRequest({ requestId: batchCreated.requestId, leaseFence: 1 });
    assert.equal(batchReserved.state, "review_required");
    assert.equal(batchReserved.reviewReason, "BATCH_RUNTIME_NOT_ENABLED");
    assert.equal(batchReserved.initialReservedMicroUsd, 0);
    checks.push("batch submission fails closed until reconciliation exists");

    const killSource = await seedSource(db, "kill-switch");
    const killCreated = await ledger.createRequest(requestFixture(killSource));
    const killReserved = await ledger.reserveRequest({ requestId: killCreated.requestId, leaseFence: 1 });
    await issuer.configure({
      configurationRequestKey: "disable-before-send-v1",
      enabled: false,
      lifetimeAllocationMicroUsd: 13000000,
      dailyCeilingMicroUsd: 2000000,
      configuredBy: "verifier",
      configurationReason: "verify issuer kill switch",
    });
    const killed = await ledger.beginSyncAttempt({ requestId: killCreated.requestId, leaseFence: 1 });
    assert.equal(killed.sendAuthorized, false);
    assert.equal(killed.state, "review_required");
    assert.equal(killed.reviewReason, "MODEL_ACCOUNT_DISABLED_BEFORE_SEND");
    assert.equal(killed.remainingReservedMicroUsd, 0);
    const accountAfterKill = await one(db, `
      select reserved_microusd from public.truth_model_workspace_accounts where workspace_key = $1
    `, [WORKSPACE]);
    assert.equal(
      Number(accountAfterKill.reserved_microusd),
      unknownReserved.initialReservedMicroUsd + billingReserved.initialReservedMicroUsd,
    );
    assert.ok(killReserved.initialReservedMicroUsd > 0);
    checks.push("issuer kill switch rechecks before send and releases only unused hold");

    const dailyCap = await verifyAtomicCap(db, callRpc, {
      workspaceKey: "model-daily-cap",
      expectedReason: "MODEL_DAILY_BUDGET_EXHAUSTED",
    });
    const lifetimeCap = await verifyAtomicCap(db, callRpc, {
      workspaceKey: "model-lifetime-cap",
      expectedReason: "MODEL_LIFETIME_BUDGET_EXHAUSTED",
    });
    assert.equal(dailyCap.reservationMicroUsd, lifetimeCap.reservationMicroUsd);
    checks.push("UTC daily and lifetime cap arithmetic admits exactly one reservation");

    const nativeProof = await verifyNativeCapSerialization();
    assert.equal(nativeProof.caps.length, 2);
    assert.equal(nativeProof.recovery.requestState, "outcome_unknown");
    checks.push("two native PostgreSQL sessions serialize caps and prove crash dispatch quarantine without a fabricated send fact");

    const attemptCapReservation = await verifyAttemptCap(db, callRpc);
    assert.ok(attemptCapReservation > 0);
    checks.push("exact three-attempt cap releases all unused reservation once");

    await applyMigration(db, PLAN_RUNTIME_MIGRATION);
    await applyMigration(db, RECOVERY_MIGRATION);
    const sourceJobLookup = await verifySourceJobRequestDiscovery(db, callRpc);
    assert.ok(sourceJobLookup.actualMicroUsd > 0);
    checks.push("fenced source-job lookup validates paid terminal replay, honest parked absence, and illicit parked request rejection");
    const independentReview = await verifyOperationalReviewIndependent(
      db, callRpc, dispatchRecovery,
    );
    assert.ok(independentReview.obligationId.startsWith("gmail-model-review:v1:"));
    assert.equal(independentReview.recoveryStatus, "unresolved");
    checks.push("operational review closes source-cut review while immutable spend quarantine remains independently unresolved");

    await verifyPrivileges(db);
    await expectCode(db.query(`
      update public.truth_model_requests set request_payload_text = request_payload_text || ' '
      where request_id = $1
    `, [created.requestId]), "55000", "immutable request identity");
    const beforeReplay = await one(db, `
      select
        (select count(*)::integer from public.truth_model_requests) as requests,
        (select count(*)::integer from public.truth_model_sync_attempt_dispatches) as dispatches,
        (select count(*)::integer from public.truth_model_sync_attempt_outcomes) as outcomes,
        (select count(*)::integer from public.truth_model_sync_dispatch_recoveries) as recoveries
    `);
    await applyMigration(db, MODEL_MIGRATION);
    await applyMigration(db, PLAN_RUNTIME_MIGRATION);
    await applyMigration(db, RECOVERY_MIGRATION);
    const afterReplay = await one(db, `
      select
        (select count(*)::integer from public.truth_model_requests) as requests,
        (select count(*)::integer from public.truth_model_sync_attempt_dispatches) as dispatches,
        (select count(*)::integer from public.truth_model_sync_attempt_outcomes) as outcomes,
        (select count(*)::integer from public.truth_model_sync_dispatch_recoveries) as recoveries,
        current_setting('check_function_bodies') as function_bodies
    `);
    assert.deepEqual(
      [afterReplay.requests, afterReplay.dispatches, afterReplay.outcomes, afterReplay.recoveries],
      [beforeReplay.requests, beforeReplay.dispatches, beforeReplay.outcomes, beforeReplay.recoveries],
    );
    assert.equal(afterReplay.function_bodies, "on");
    checks.push("force-RLS privileges, immutable rows, exact RPC signatures, and safe reapplication");

    assert.equal(networkCalls, 0);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      verifier: "truth-model-usage-ledger",
      checks,
      pricingPolicies: pricing.rows.length,
      attemptsPersisted: afterReplay.dispatches,
      outcomesPersisted: afterReplay.outcomes,
      dispatchRecoveriesPersisted: afterReplay.recoveries,
      unknownReservationMicroUsd: unknownReserved.initialReservedMicroUsd,
      liveCalls: networkCalls,
    }, null, 2)}\n`);
  } finally {
    global.fetch = originalFetch;
    await db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});

"use strict";

// Bounded model boundary for the companion's deterministic residual.
// The router may select an intent but may not emit facts. Analytical output is
// structured as citation-bound claims; the caller validates every ID before
// anything reaches the operator.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = [120];

const INTENTS = Object.freeze([
  "status", "next-action", "blocker-why", "contacts", "eta", "pod", "cargo",
  "urgent", "out-for-delivery", "stuck", "arrived-window", "pod-missing",
  "arrived-no-broker", "handle-together", "waiting-on", "unanswered-requests",
  "needs-customer-update", "last-outbound", "what-changed", "storage-risk",
  "quotes", "open-analytical", "out-of-scope",
]);
const INTENT_SET = new Set(INTENTS);
const SCOPES = Object.freeze(["shipment", "fleet", "station", "group"]);
const SCOPE_SET = new Set(SCOPES);

function positiveOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function compact(value, max = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 11);
}

function looksLikeRealKey(key) {
  return typeof key === "string" &&
    /^sk-[A-Za-z0-9_-]{20,}$/.test(key.trim()) &&
    !/fake|test|dummy|placeholder|example|bogus|xxxx/i.test(key);
}

function parseJsonObject(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRoute(content) {
  const value = typeof content === "string" ? parseJsonObject(content) : content;
  if (!value) return null;
  const scope = SCOPE_SET.has(value.scope) ? value.scope : "fleet";
  const rawIntent = compact(value.intent, 60);
  const intent = INTENT_SET.has(rawIntent) ? rawIntent : "open-analytical";
  const confidenceValue = Number(value.confidence);
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : 0;
  const filters = value.filters && typeof value.filters === "object" && !Array.isArray(value.filters)
    ? Object.fromEntries(Object.entries(value.filters).slice(0, 8).map(([key, item]) => [compact(key, 40), typeof item === "string" ? compact(item, 100) : item]))
    : {};
  return {
    scope,
    intent,
    awb: normalizeAwb(value.awb),
    station: compact(value.station, 8).toUpperCase(),
    filters,
    confidence,
  };
}

function parseSynthesis(content) {
  const value = typeof content === "string" ? parseJsonObject(content) : content;
  if (!value) return null;
  return {
    claims: (Array.isArray(value.claims) ? value.claims : []).slice(0, 8).map((claim) => ({
      text: compact(claim?.text, 280),
      citationIds: (Array.isArray(claim?.citationIds) ? claim.citationIds : []).map((id) => compact(id, 80)).filter(Boolean).slice(0, 6),
    })).filter((claim) => claim.text),
    unknowns: (Array.isArray(value.unknowns) ? value.unknowns : []).map((item) => compact(item, 220)).filter(Boolean).slice(0, 5),
    actionIds: (Array.isArray(value.actionIds) ? value.actionIds : []).map((id) => compact(id, 120)).filter(Boolean).slice(0, 5),
  };
}

function parseNarrative(content) {
  const value = typeof content === "string" ? parseJsonObject(content) : content;
  if (!value || !Array.isArray(value.sentences)) return null;
  return {
    sentences: value.sentences.slice(0, 3).map((item) => ({
      text: compact(item?.text, 280),
      citationIds: (Array.isArray(item?.citationIds) ? item.citationIds : [])
        .map((id) => compact(id, 80))
        .filter(Boolean)
        .slice(0, 6),
    })).filter((item) => item.text),
  };
}

function routerPrompt(question, history = []) {
  return {
    question: compact(question, 500),
    recentHistory: (history || []).slice(-4).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: compact(message.content || message.title || "", 140),
    })),
    availableScopes: SCOPES,
    availableIntents: INTENTS,
    rules: [
      "Classify only; emit no shipment fact, answer prose, action, or recommendation.",
      "Use unanswered-requests for literal queued/issued request records; waiting-on for unreplied email threads.",
      "Use open-analytical only for a novel comparison, ranking, causal, or multi-row question not covered by another intent.",
      "Extract an AWB or station only when stated or unambiguously supplied by history.",
    ],
  };
}

const ROUTER_SCHEMA = {
  name: "ops_intent_route",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "intent", "awb", "station", "filters", "confidence"],
    properties: {
      scope: { type: "string", enum: SCOPES },
      intent: { type: "string", enum: INTENTS },
      awb: { type: "string" },
      station: { type: "string" },
      filters: {
        type: "object",
        additionalProperties: false,
        required: ["window", "state", "risk", "client", "consignee"],
        properties: {
          window: { type: "string" },
          state: { type: "string" },
          risk: { type: "string" },
          client: { type: "string" },
          consignee: { type: "string" },
        },
      },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
};

const SYNTHESIS_SCHEMA = {
  name: "ops_grounded_synthesis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["claims", "unknowns", "actionIds"],
    properties: {
      claims: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "citationIds"],
          properties: {
            text: { type: "string" },
            citationIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
          },
        },
      },
      unknowns: { type: "array", maxItems: 5, items: { type: "string" } },
      actionIds: { type: "array", maxItems: 5, items: { type: "string" } },
    },
  },
};

const NARRATIVE_SCHEMA = {
  name: "ops_companion_narrative",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["sentences"],
    properties: {
      sentences: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "citationIds"],
          properties: {
            text: { type: "string" },
            citationIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6 },
          },
        },
      },
    },
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withinDeadline(promise, deadline, controller = null) {
  const remainingMs = Math.max(1, deadline - Date.now());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      const error = new Error("provider deadline exceeded");
      error.code = "OPS_BRAIN_DEADLINE";
      reject(error);
    }, remainingMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function createOpsBrainModelRuntime(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || env.OPENAI_API_KEY || "";
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const spendStore = options.spendStore || null;
  const sleepImpl = options.sleepImpl || sleep;
  const injectedMock = Boolean(options.allowMockProvider && options.fetchImpl);
  const dailyTokenBudget = positiveOr(env.PIKIIO_OPS_BRAIN_DAILY_TOKEN_BUDGET || env.PQ_OPS_BRAIN_DAILY_TOKEN_BUDGET, 250_000);
  const perQuestionTokenBudget = positiveOr(env.PIKIIO_OPS_BRAIN_QUESTION_TOKEN_BUDGET || env.PQ_OPS_BRAIN_QUESTION_TOKEN_BUDGET, 8_000);
  const maxCalls = Math.min(2, positiveOr(env.PIKIIO_OPS_BRAIN_MAX_CALLS_PER_QUESTION || env.PQ_OPS_BRAIN_MAX_CALLS_PER_QUESTION, 2));
  const timeoutMs = positiveOr(env.PIKIIO_OPS_BRAIN_OPENAI_TIMEOUT_MS || env.OPS_BRAIN_OPENAI_TIMEOUT_MS, 1_800);
  const spendHealth = options.spendHealth || { healthy: true };

  function disabled() {
    return env.PIKIIO_OPS_BRAIN_AI_DISABLED === "1" || env.PQ_OPS_BRAIN_AI_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1";
  }

  function keyAllowed() {
    return looksLikeRealKey(apiKey) || injectedMock;
  }

  function createQuestionBudget() {
    return { calls: 0, tokens: 0, tokenLimit: perQuestionTokenBudget, maxCalls };
  }

  async function callJson({ prompt, schema, model, maxTokens, budget }) {
    if (disabled()) return { skipped: "kill-switch" };
    if (!keyAllowed()) return { skipped: "no-key" };
    if (!fetchImpl) return { skipped: "no-fetch" };
    if (!budget || budget.calls >= budget.maxCalls) return { skipped: "question-call-cap" };
    const messages = [
      { role: "system", content: "Return only the strict JSON requested. Never add facts outside the supplied input." },
      { role: "user", content: JSON.stringify(prompt) },
    ];
    const inputShape = {
      model,
      response_format: { type: "json_schema", json_schema: schema },
      messages,
      temperature: 0,
    };
    const estimatedInput = Math.ceil(JSON.stringify(inputShape).length / 3);
    const remainingCompletionBudget = Math.floor(budget.tokenLimit - budget.tokens - estimatedInput);
    const boundedMaxTokens = Math.min(maxTokens, remainingCompletionBudget);
    if (boundedMaxTokens < 1) return { skipped: "question-token-budget" };
    const estimatedTotal = estimatedInput + boundedMaxTokens;
    let dailySpentTokens = 0;
    if (spendStore && !spendHealth.healthy) return { skipped: "spend-meter-unavailable" };
    if (spendStore) {
      let spent;
      try {
        spent = await withinDeadline(spendStore.get(), Date.now() + Math.min(timeoutMs, 900));
      } catch {
        spendHealth.healthy = false;
        return { skipped: "spend-meter-unavailable" };
      }
      dailySpentTokens = Number(spent?.tokens);
      if (!Number.isFinite(dailySpentTokens) || dailySpentTokens < 0) {
        spendHealth.healthy = false;
        return { skipped: "spend-meter-unavailable" };
      }
      if (dailySpentTokens + estimatedTotal > dailyTokenBudget) return { skipped: "daily-token-budget" };
    }
    budget.calls += 1;
    budget.tokens += estimatedTotal;
    const body = JSON.stringify({ ...inputShape, max_tokens: boundedMaxTokens });
    let lastError = "";
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      let response;
      try {
        response = await withinDeadline(fetchImpl(OPENAI_URL, {
          method: "POST",
          signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey || "mock-provider"}`, "content-type": "application/json" },
          body,
        }), deadline, controller);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (error?.code === "OPS_BRAIN_DEADLINE") return { skipped: "provider-timeout", error: lastError };
        if (attempt < MAX_ATTEMPTS - 1 && Date.now() + BACKOFF_MS[attempt] < deadline) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "network-error", error: lastError };
      }
      const status = Number(response.status || (response.ok ? 200 : 500));
      if (status === 429 || status >= 500) {
        lastError = `provider ${status}`;
        if (attempt < MAX_ATTEMPTS - 1 && Date.now() + BACKOFF_MS[attempt] < deadline) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "provider-unavailable", error: lastError };
      }
      let payload;
      try {
        payload = await withinDeadline(
          typeof response.json === "function" ? response.json() : Promise.resolve(response.text()).then((text) => JSON.parse(text)),
          deadline,
          controller,
        );
      } catch (error) {
        if (error?.code === "OPS_BRAIN_DEADLINE") return { skipped: "provider-timeout", error: error.message };
        payload = null;
      }
      if (status >= 400) return { skipped: "provider-rejected", error: `provider ${status}` };
      const rawUsage = payload?.usage?.total_tokens;
      const reportedUsage = rawUsage == null ? estimatedTotal : Number(rawUsage);
      const usageValid = Number.isFinite(reportedUsage) && reportedUsage >= 0;
      const usage = usageValid ? reportedUsage : estimatedTotal;
      budget.tokens += usage - estimatedTotal;
      if (spendStore && usage) {
        try {
          await withinDeadline(spendStore.add(usage), Date.now() + Math.min(timeoutMs, 900));
        } catch {
          spendHealth.healthy = false;
          return { skipped: "spend-meter-write-failed", usage };
        }
      }
      if (!usageValid) return { skipped: "invalid-usage", usage };
      if (budget.tokens > budget.tokenLimit) return { skipped: "question-token-budget", usage };
      if (spendStore && dailySpentTokens + usage > dailyTokenBudget) return { skipped: "daily-token-budget", usage };
      const parsed = parseJsonObject(payload?.choices?.[0]?.message?.content || "");
      if (!parsed) return { skipped: "unparseable", usage };
      return { skipped: null, value: parsed, usage, model };
    }
    return { skipped: "exhausted-retries", error: lastError };
  }

  async function routeQuestion(question, history, budget) {
    const result = await callJson({
      prompt: routerPrompt(question, history),
      schema: ROUTER_SCHEMA,
      model: env.PIKIIO_OPS_BRAIN_ROUTER_MODEL || env.PQ_OPS_BRAIN_ROUTER_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL,
      maxTokens: positiveOr(env.PIKIIO_OPS_BRAIN_ROUTER_MAX_TOKENS, 180),
      budget,
    });
    if (result.skipped) return result;
    const route = parseRoute(result.value);
    return route ? { ...result, route } : { skipped: "invalid-route", usage: result.usage };
  }

  async function synthesizeGrounded(prompt, budget) {
    const result = await callJson({
      prompt,
      schema: SYNTHESIS_SCHEMA,
      model: env.PIKIIO_OPS_BRAIN_SYNTHESIS_MODEL || env.PQ_OPS_BRAIN_SYNTHESIS_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL,
      maxTokens: positiveOr(env.PIKIIO_OPS_BRAIN_SYNTHESIS_MAX_TOKENS, 520),
      budget,
    });
    if (result.skipped) return result;
    const synthesis = parseSynthesis(result.value);
    return synthesis ? { ...result, synthesis } : { skipped: "invalid-synthesis", usage: result.usage };
  }

  async function composeNarrative(prompt, budget) {
    const result = await callJson({
      prompt,
      schema: NARRATIVE_SCHEMA,
      model: env.PIKIIO_OPS_BRAIN_NARRATIVE_MODEL || env.PQ_OPS_BRAIN_NARRATIVE_MODEL || env.PIKIIO_OPS_BRAIN_SYNTHESIS_MODEL || env.PQ_OPS_BRAIN_SYNTHESIS_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL,
      maxTokens: positiveOr(env.PIKIIO_OPS_BRAIN_NARRATIVE_MAX_TOKENS || env.PQ_OPS_BRAIN_NARRATIVE_MAX_TOKENS, 240),
      budget,
    });
    if (result.skipped) return result;
    const narrative = parseNarrative(result.value);
    return narrative ? { ...result, narrative } : { skipped: "invalid-narrative", usage: result.usage };
  }

  return { createQuestionBudget, routeQuestion, synthesizeGrounded, composeNarrative, disabled, keyAllowed };
}

module.exports = {
  DEFAULT_MODEL,
  INTENTS,
  SCOPES,
  createOpsBrainModelRuntime,
  looksLikeRealKey,
  parseNarrative,
  parseRoute,
  parseSynthesis,
  routerPrompt,
};

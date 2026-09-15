"use strict";

// Model-based classifier for the deterministic RESIDUAL: freight email messages that the
// regex/keyword classifier (extractOperationalEvents) could not turn into an operational
// signal, because real brokers don't write "out for delivery" — they write "carrier
// relayed a delivery ETA of 1000AM in Fresno" (016-80000142). A small model reads the
// message WITH ITS THREAD CONTEXT and returns one progress signal, the way a person would.
//
// Deterministic-first: the caller only invokes this for messages the deterministic layer
// left unclassified — a tiny residual. Same hard guards as pod-vision-ocr (INC-2026-07-12b):
//   - kill-switch (PQ_MESSAGE_MODEL_DISABLED, inherits PQ_SUPABASE_WRITES_DISABLED),
//   - persistent daily token budget + per-run call cap (degrade to "none", never loop),
//   - bounded retries (<= 3, backoff on 429/5xx only; 4xx terminal),
//   - temperature 0, strict JSON, thread context capped,
//   - never runs with a fake/test key (verifiers inject a mock provider).
// The model is conservative by construction: when unsure it returns "none" (no false truth).

const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200, 3000];
const DEFAULT_DAILY_TOKEN_BUDGET = 3_000_000; // ~$0.45/day ceiling at 4o-mini; a read is ~300 tokens.
const DEFAULT_MAX_CALLS_PER_RUN = 12;

// The ONLY signals the model may emit. Each maps to a deterministic event type downstream.
const SIGNALS = Object.freeze([
  "customs_released", "picked_up", "out_for_delivery", "delivered", "arrival", "exception", "none",
]);
const SIGNAL_SET = new Set(SIGNALS);

function looksLikeRealKey(key) {
  return typeof key === "string" &&
    /^sk-[A-Za-z0-9_\-]{20,}$/.test(String(key).trim()) &&
    !/fake|test|dummy|placeholder|example|xxbogus/i.test(key);
}

function compact(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function buildPrompt({ awb, destination, subject, priorMessages = [], target = {}, knownStage = "" }) {
  const ctx = (priorMessages || [])
    .slice(-6)
    .map((m) => `  - ${compact(m.at || "")} · ${compact(m.from || "party", 40)}: ${compact(m.text, 220)}`)
    .join("\n");
  return [
    "You are reading ONE freight-import email thread and classifying what the LATEST message",
    "establishes about the shipment's physical/customs progress. Use earlier messages only as context.",
    `Shipment: ${awb || "(unknown)"}${destination ? `, destination ${destination}` : ""}.`,
    subject ? `Thread subject: ${compact(subject, 160)}` : "",
    knownStage ? `System's current known stage (may be stale): ${compact(knownStage, 60)}` : "",
    ctx ? `Earlier messages (oldest first):\n${ctx}` : "",
    `LATEST message to classify — from ${compact(target.from || "party", 60)}: "${compact(target.text, 500)}"`,
    "",
    "Pick ONE signal for what the LATEST message establishes about progress:",
    "- customs_released: customs cleared / entry released / delivery order (DO) issued",
    "- picked_up: carrier loaded or collected the cargo from the station",
    "- out_for_delivery: carrier is en route to the consignee, or relayed a delivery ETA",
    "- delivered: delivered to the consignee / proof of delivery provided",
    "- arrival: cargo landed / arrived / on-hand at the destination station",
    "- exception: a problem, hold, or blocker",
    "- none: no clear progress signal (a question, chit-chat, quote, acknowledgement)",
    "",
    "Only choose a progress signal if the LATEST message clearly establishes it; otherwise use \"none\".",
    'Respond with STRICT JSON only: {"signal":"<one of the above>","confidence":0.0-1.0,"reason":"<=12 words"}.',
  ].filter(Boolean).join("\n");
}

function parseClassification(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const v = JSON.parse(raw);
    const signal = SIGNAL_SET.has(v.signal) ? v.signal : "none";
    const confidence = Math.max(0, Math.min(1, Number(v.confidence)));
    return { signal, confidence: Number.isFinite(confidence) ? confidence : 0, reason: compact(v.reason, 120) };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMessageModelClassifier(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || env.OPENAI_API_KEY || "";
  const model = options.model || env.PQ_MESSAGE_MODEL || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const spendStore = options.spendStore || null;
  const sleepImpl = options.sleepImpl || sleep;
  const positiveOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const dailyTokenBudget = positiveOr(env.PQ_MESSAGE_MODEL_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET);
  const maxCallsPerRun = positiveOr(env.PQ_MESSAGE_MODEL_MAX_CALLS_PER_RUN, DEFAULT_MAX_CALLS_PER_RUN);
  let callsThisRun = 0;

  function disabled() {
    return env.PQ_MESSAGE_MODEL_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1";
  }
  function canAttempt() {
    return !disabled() && looksLikeRealKey(apiKey) && callsThisRun < maxCallsPerRun;
  }

  async function classifyMessage(context = {}) {
    if (disabled()) return { skipped: "kill-switch", signal: "none" };
    if (!looksLikeRealKey(apiKey)) return { skipped: "no-key", signal: "none" };
    if (!fetchImpl) return { skipped: "no-fetch", signal: "none" };
    if (!compact(context.target && context.target.text)) return { skipped: "empty", signal: "none" };
    if (callsThisRun >= maxCallsPerRun) return { skipped: "run-cap", signal: "none" };
    if (spendStore) {
      try {
        const spent = await spendStore.get();
        if (Number(spent && spent.tokens || 0) >= dailyTokenBudget) return { skipped: "daily-budget", signal: "none" };
      } catch { /* ledger read failure must not open the floodgates nor block ingest */ }
    }
    callsThisRun += 1;

    const body = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 120,
      messages: [{ role: "user", content: buildPrompt(context) }],
    });

    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(OPENAI_URL, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS - 1) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "network-error", error: lastError, signal: "none" };
      }
      const status = response.status;
      if (status === 429 || status >= 500) {
        lastError = `provider ${status}`;
        if (attempt < MAX_ATTEMPTS - 1) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "provider-unavailable", error: lastError, signal: "none" };
      }
      let payload;
      try { payload = await response.json(); } catch { payload = null; }
      if (status >= 400) return { skipped: "provider-rejected", error: `provider ${status}`, signal: "none" };
      const usage = payload && payload.usage && payload.usage.total_tokens || 0;
      if (spendStore && usage) { try { await spendStore.add(usage); } catch { /* best-effort */ } }
      const parsed = parseClassification(payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content);
      if (!parsed) return { skipped: "unparseable", usage, signal: "none" };
      return { skipped: null, signal: parsed.signal, confidence: parsed.confidence, reason: parsed.reason, usage, model };
    }
    return { skipped: "exhausted-retries", error: lastError, signal: "none" };
  }

  return { classifyMessage, canAttempt, _looksLikeRealKey: looksLikeRealKey };
}

module.exports = {
  createMessageModelClassifier,
  looksLikeRealKey,
  parseClassification,
  buildPrompt,
  SIGNALS,
  DEFAULT_MODEL,
  MAX_ATTEMPTS,
};

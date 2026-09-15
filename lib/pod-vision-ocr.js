"use strict";

// Guarded vision OCR for POD-class image attachments (INC-2026-07-12b).
//
// A proof-of-delivery photographed/scanned as an image (e.g. 016-80000091's Image.png)
// carries no extractable text, so the deterministic ingest can only mark it
// "pod-attachment-unverified". This module reads such an image with a vision model and
// returns concrete POD/delivery text, which then flows through the normal POD/delivery
// classifiers and the terminal-evidence certification.
//
// Hard guards (per the model-rollout checkpoint — $30 budget, no refills):
//   - Deterministic-first: the caller invokes this ONLY for POD-class image attachments
//     that no deterministic path resolved (a tiny residual, usually 0–2 per refresh).
//   - Kill-switch env: PQ_POD_VISION_DISABLED=1 (and it inherits PQ_SUPABASE_WRITES_DISABLED).
//   - Persistent daily token budget (spendStore) + per-run call cap — degrade to
//     "unverified" when exhausted, never error, never loop.
//   - Bounded retries (<= MAX_ATTEMPTS) with backoff on 429/5xx only. This repo once
//     logged 383,238 retries from an unguarded loop; that must never recur.
//   - temperature 0, strict JSON, image detail:"low" to cap tokens (~1–2k vs ~48k full-res).
//   - Never runs with a fake/test key; verifiers inject a mock provider via fetchImpl.

const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200, 3000];
// gpt-4o-mini: ~$0.15 / 1M input tokens. 2M/day ≈ $0.30/day ceiling; a detail:low POD
// read is ~1–2k tokens, so this is hundreds of PODs/day before the cap ever trips.
const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;
const DEFAULT_MAX_CALLS_PER_RUN = 5;

function looksLikeRealKey(key) {
  return typeof key === "string" &&
    /^sk-[A-Za-z0-9_\-]{20,}$/.test(key.trim()) &&
    !/fake|test|dummy|placeholder|example|xxbogus/i.test(key);
}

const POD_VISION_PROMPT =
  "This image was attached to a freight/logistics email. Decide ONLY from what is visibly " +
  "in the image whether it is a proof of delivery (POD): a signed delivery receipt, " +
  "delivery order with a signature, bill of lading marked received/delivered, or a photo " +
  "of delivered cargo at the consignee. Respond with STRICT JSON and nothing else: " +
  '{"is_pod": boolean, "delivered": boolean, "has_signature": boolean, ' +
  '"summary": string (<=160 chars describing what is shown)}. ' +
  "Set delivered=true only if the image itself evidences completed delivery/receipt. " +
  "If it is a label, logo, email signature graphic, or unrelated photo, set is_pod=false.";

function parseModelJson(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    return {
      isPod: value.is_pod === true,
      delivered: value.delivered === true,
      hasSignature: value.has_signature === true,
      summary: typeof value.summary === "string" ? value.summary.slice(0, 200) : "",
    };
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// spendStore (optional, injected by the ingest): { get(): Promise<{tokens:number}>,
// add(tokens:number): Promise<void> } — a persistent per-UTC-day token ledger. When
// absent the per-run cap and kill-switch still bound spend.
function createPodVisionOcr(options = {}) {
  const env = options.env || process.env;
  const apiKey = options.apiKey || env.OPENAI_API_KEY || "";
  const model = options.model || env.PQ_POD_VISION_MODEL || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const spendStore = options.spendStore || null;
  const sleepImpl = options.sleepImpl || sleep;
  // A non-numeric env value must not silently disable a cap (NaN comparisons are always
  // false). Fall back to the default unless the override parses to a finite positive number.
  const positiveOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const dailyTokenBudget = positiveOr(env.PQ_POD_VISION_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKEN_BUDGET);
  const maxCallsPerRun = positiveOr(env.PQ_POD_VISION_MAX_CALLS_PER_RUN, DEFAULT_MAX_CALLS_PER_RUN);
  let callsThisRun = 0;

  function disabled() {
    return env.PQ_POD_VISION_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1";
  }
  // Cheap pre-check so the caller can skip expensive attachment downloads when no attempt
  // could possibly run (disabled, no key, or the per-run cap already reached).
  function canAttempt() {
    return !disabled() && looksLikeRealKey(apiKey) && callsThisRun < maxCallsPerRun;
  }

  async function extractPodEvidence({ base64, mimeType = "image/png", filename = "", contextText = "" } = {}) {
    if (disabled()) return { skipped: "kill-switch" };
    if (!looksLikeRealKey(apiKey)) return { skipped: "no-key" };
    if (!fetchImpl) return { skipped: "no-fetch" };
    if (!base64) return { skipped: "no-image" };
    if (callsThisRun >= maxCallsPerRun) return { skipped: "run-cap" };
    if (spendStore) {
      try {
        const spent = await spendStore.get();
        if (Number(spent?.tokens || 0) >= dailyTokenBudget) return { skipped: "daily-budget" };
      } catch {
        // A ledger read failure must not open the floodgates: treat as budget-unknown and
        // still honor the per-run cap below, but do not hard-fail the ingest.
      }
    }
    callsThisRun += 1;

    const requestBody = JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 200,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `${POD_VISION_PROMPT}${contextText ? `\nEmail context: ${contextText.slice(0, 240)}` : ""}` },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "low" } },
        ],
      }],
    });

    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(OPENAI_URL, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: requestBody,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS - 1) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "network-error", error: lastError };
      }
      const status = response.status;
      if (status === 429 || status >= 500) {
        lastError = `provider ${status}`;
        if (attempt < MAX_ATTEMPTS - 1) { await sleepImpl(BACKOFF_MS[attempt]); continue; }
        return { skipped: "provider-unavailable", error: lastError };
      }
      let body;
      try { body = await response.json(); } catch { body = null; }
      if (status >= 400) {
        // 4xx (bad key, quota exhausted, unsupported) is terminal — never retry-loop.
        return { skipped: "provider-rejected", error: `provider ${status}` };
      }
      const usage = body?.usage?.total_tokens || 0;
      if (spendStore && usage) { try { await spendStore.add(usage); } catch { /* best-effort */ } }
      const parsed = parseModelJson(body?.choices?.[0]?.message?.content);
      if (!parsed) return { skipped: "unparseable", usage };
      return {
        skipped: null,
        isPod: parsed.isPod,
        delivered: parsed.delivered,
        hasSignature: parsed.hasSignature,
        summary: parsed.summary,
        usage,
        model,
      };
    }
    return { skipped: "exhausted-retries", error: lastError };
  }

  return { extractPodEvidence, canAttempt, _looksLikeRealKey: looksLikeRealKey };
}

module.exports = {
  createPodVisionOcr,
  looksLikeRealKey,
  parseModelJson,
  POD_VISION_PROMPT,
  DEFAULT_MODEL,
  MAX_ATTEMPTS,
};

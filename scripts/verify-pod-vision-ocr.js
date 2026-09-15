#!/usr/bin/env node
"use strict";

// Guard + behavior backtest for lib/pod-vision-ocr.js (INC-2026-07-12b).
// Uses a MOCK provider and a FAKE key — never the live OpenAI key.

const { createPodVisionOcr, looksLikeRealKey } = require("../lib/pod-vision-ocr.js");

let failures = 0;
const results = [];
function check(label, cond, detail) {
  if (!cond) failures += 1;
  results.push({ label, ok: !!cond, ...(cond ? {} : { detail }) });
}

const REAL_KEY = "sk-proj-" + "a".repeat(40);
const IMG = Buffer.from("fakeimagebytes").toString("base64");
const noSleep = async () => {};

function mockResponse(status, body) {
  return { status, json: async () => body };
}
function okBody(json, tokens = 1500) {
  return { choices: [{ message: { content: JSON.stringify(json) } }], usage: { total_tokens: tokens } };
}

(async () => {
  // 1. fake key -> never calls provider
  {
    let called = 0;
    const ocr = createPodVisionOcr({ apiKey: "sk-fake-test-key-placeholder", fetchImpl: async () => { called++; return mockResponse(200, okBody({ is_pod: true })); }, env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("fake key is refused (no provider call)", r.skipped === "no-key" && called === 0, r);
  }
  check("looksLikeRealKey rejects fakes", !looksLikeRealKey("sk-fake-test") && !looksLikeRealKey("sk-proj-dummy") && looksLikeRealKey(REAL_KEY));

  // 2. kill-switch
  {
    let called = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { called++; return mockResponse(200, okBody({})); }, env: { PQ_POD_VISION_DISABLED: "1" }, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("kill-switch skips (no provider call)", r.skipped === "kill-switch" && called === 0, r);
  }
  {
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => mockResponse(200, okBody({})), env: { PQ_SUPABASE_WRITES_DISABLED: "1" }, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("inherits PQ_SUPABASE_WRITES_DISABLED kill-switch", r.skipped === "kill-switch", r);
  }

  // 3. successful POD read
  {
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => mockResponse(200, okBody({ is_pod: true, delivered: true, has_signature: true, summary: "signed delivery receipt" })), env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG, mimeType: "image/png" });
    check("reads a POD image -> isPod+delivered", r.skipped === null && r.isPod === true && r.delivered === true && r.hasSignature === true, r);
  }
  // non-POD image
  {
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => mockResponse(200, okBody({ is_pod: false, delivered: false })), env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("non-POD image -> isPod false (no false delivery)", r.skipped === null && r.isPod === false && r.delivered === false, r);
  }

  // 4. bounded retries on 429/5xx then give up (no infinite loop)
  {
    let calls = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { calls++; return mockResponse(429, {}); }, env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("429 retries are bounded (<= MAX_ATTEMPTS) then degrade", r.skipped === "provider-unavailable" && calls === 3, { calls, r });
  }
  {
    let calls = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { calls++; return mockResponse(503, {}); }, env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("5xx retries are bounded then degrade", r.skipped === "provider-unavailable" && calls === 3, { calls, r });
  }
  // recovers if a retry succeeds
  {
    let calls = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { calls++; return calls < 2 ? mockResponse(500, {}) : mockResponse(200, okBody({ is_pod: true, delivered: true })); }, env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("transient 5xx then success recovers", r.skipped === null && r.delivered === true && calls === 2, { calls, r });
  }

  // 5. 4xx is terminal — never retry-loop
  {
    let calls = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { calls++; return mockResponse(400, { error: "bad" }); }, env: {}, sleepImpl: noSleep });
    const r = await ocr.extractPodEvidence({ base64: IMG });
    check("4xx is terminal (exactly one call, no loop)", r.skipped === "provider-rejected" && calls === 1, { calls, r });
  }

  // 6. per-run call cap
  {
    let calls = 0;
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => { calls++; return mockResponse(200, okBody({ is_pod: false })); }, env: { PQ_POD_VISION_MAX_CALLS_PER_RUN: "2" }, sleepImpl: noSleep });
    await ocr.extractPodEvidence({ base64: IMG });
    await ocr.extractPodEvidence({ base64: IMG });
    const r3 = await ocr.extractPodEvidence({ base64: IMG });
    check("per-run call cap stops further calls", r3.skipped === "run-cap" && calls === 2, { calls, r3 });
  }

  // 7. persistent daily token budget cap
  {
    let tokens = 0;
    const spendStore = { get: async () => ({ tokens }), add: async (t) => { tokens += t; } };
    const ocr = createPodVisionOcr({ apiKey: REAL_KEY, fetchImpl: async () => mockResponse(200, okBody({ is_pod: true }, 1500)), env: { PQ_POD_VISION_DAILY_TOKEN_BUDGET: "2000", PQ_POD_VISION_MAX_CALLS_PER_RUN: "50" }, spendStore, sleepImpl: noSleep });
    const a = await ocr.extractPodEvidence({ base64: IMG }); // spends 1500
    const b = await ocr.extractPodEvidence({ base64: IMG }); // now 1500 >= 2000? no; spends -> 3000
    const c = await ocr.extractPodEvidence({ base64: IMG }); // 3000 >= 2000 -> budget
    check("daily token budget halts spend", a.skipped === null && b.skipped === null && c.skipped === "daily-budget", { tokens, a, b, c });
  }

  const ok = failures === 0;
  console.log(JSON.stringify({ ok, failures, checks: results }, null, 2));
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error("verify-pod-vision-ocr crashed:", e); process.exit(1); });

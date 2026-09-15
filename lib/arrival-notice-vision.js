"use strict";

// Guarded vision reader for unresolved air-freight arrival-notice PDF/image attachments
// (INC-2026-07-13e). This result can mint carrier-arrival-confirmed, which closes the
// arrival gate and can expose pickup/dispatch work. Every malformed, ambiguous, unreadable,
// low-confidence, disabled, or over-budget outcome therefore fails closed to arrived:false.

const { looksLikeRealKey } = require("./pod-vision-ocr");

const DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200, 3000];
const DEFAULT_DAILY_TOKEN_BUDGET = 2_000_000;
const DEFAULT_MAX_CALLS_PER_RUN = 5;

const ARRIVAL_NOTICE_VISION_PROMPT =
  "Read ONLY the attached document as an air-freight ARRIVAL NOTICE. Decide whether the " +
  "document itself unambiguously confirms that this cargo has physically ARRIVED at the " +
  "destination station, is ON HAND there, or is AVAILABLE FOR PICKUP there. The title or " +
  "filename 'Arrival Notice' is not proof by itself. Set arrived=true ONLY for a concrete, " +
  "completed destination arrival stated by the document. An advance notice, pre-alert, ETA, " +
  "estimated/expected/scheduled arrival, flight schedule, booking, notice preparation, origin " +
  "movement, or future availability is NOT arrival and MUST return arrived=false. Any ambiguity, " +
  "contradiction, out-of-vocabulary document, or unreadable content MUST return arrived=false. " +
  "Set onHand=true only when the document explicitly says on hand/available for pickup at the " +
  "destination. Put an actual-arrival date in arrivalDate only when the document identifies it as " +
  "completed, never copy an ETA; otherwise use an empty string. Return one strict JSON object with " +
  "exactly these keys: " +
  '{"arrived": boolean, "onHand": boolean, "station": string, "arrivalDate": string, ' +
  '"confidence": number, "reason": string}. Keep reason under 240 characters.';

const ARRIVAL_NOTICE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    arrived: { type: "boolean" },
    onHand: { type: "boolean" },
    station: { type: "string" },
    arrivalDate: { type: "string" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["arrived", "onHand", "station", "arrivalDate", "confidence", "reason"],
};

const ARRIVAL_REASON_CONTRADICTION_PATTERN = /\b(?:advance\s+notice|pre[-\s]?alert|eta|estimated|expected|scheduled|booking|future\s+arrival|due\s+to\s+arrive|will\s+arrive|not\s+(?:yet\s+)?arrived|has\s+not\s+arrived|not\s+on[-\s]?hand|pending\s+arrival|in\s+transit|at\s+origin|unreadable|illegible|unclear|ambiguous|cannot\s+(?:read|confirm)|can'?t\s+(?:read|confirm))\b/i;

function reasonContradictsArrival(reason) {
  return ARRIVAL_REASON_CONTRADICTION_PATTERN.test(String(reason || ""));
}

function failClosedResult(skipped = null, extra = {}) {
  return {
    skipped,
    arrived: false,
    onHand: false,
    station: "",
    arrivalDate: "",
    confidence: 0,
    reason: "",
    ...extra,
  };
}

function parseModelJson(content) {
  const raw = String(content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const required = ARRIVAL_NOTICE_SCHEMA.required;
  const allowed = new Set(required);
  const keys = Object.keys(value);
  const schemaValid =
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key)) &&
    typeof value.arrived === "boolean" &&
    typeof value.onHand === "boolean" &&
    typeof value.station === "string" &&
    typeof value.arrivalDate === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 && value.confidence <= 1 &&
    typeof value.reason === "string" && value.reason.trim().length > 0;

  if (!schemaValid) {
    return failClosedResult(null, { reason: "Model output was outside the arrival-notice schema." });
  }
  const contradicted = value.arrived === true && reasonContradictsArrival(value.reason);
  const arrived = value.arrived === true && !contradicted;
  return {
    skipped: null,
    arrived,
    onHand: arrived && value.onHand === true,
    station: value.station.trim().slice(0, 80),
    arrivalDate: value.arrivalDate.trim().slice(0, 40),
    confidence: contradicted ? 0 : value.confidence,
    reason: value.reason.trim().slice(0, 240),
  };
}

function responseOutputText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  for (const item of body?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function documentInput({ base64, mimeType, filename }) {
  const type = String(mimeType || "").toLowerCase();
  const name = String(filename || "");
  const pdf = type === "application/pdf" || /\.pdf$/i.test(name);
  if (pdf) {
    const safeFilename = name.replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 120) || "arrival-notice.pdf";
    return {
      type: "input_file",
      filename: /\.pdf$/i.test(safeFilename) ? safeFilename : `${safeFilename}.pdf`,
      file_data: `data:application/pdf;base64,${base64}`,
    };
  }
  return {
    type: "input_image",
    image_url: `data:${type || "image/png"};base64,${base64}`,
    detail: "low",
  };
}

// spendStore is the same shape as POD vision: { get(): Promise<{tokens:number}>,
// add(tokens:number): Promise<void> }. The caller supplies a persistent per-UTC-day ledger.
function createArrivalNoticeVisionOcr(options = {}) {
  const env = options.env || process.env;
  // Deliberately reuse the repo-wide OPENAI_API_KEY, matching POD vision and the message
  // classifier. Spend is bounded independently by this reader's kill switches and caps.
  const apiKey = options.apiKey || env.OPENAI_API_KEY || "";
  const model = options.model || env.PQ_ARRIVAL_VISION_MODEL || DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl || (typeof fetch === "function" ? fetch : null);
  const spendStore = options.spendStore || null;
  const sleepImpl = options.sleepImpl || sleep;
  const dailyTokenBudget = positiveOr(
    env.PQ_ARRIVAL_VISION_DAILY_TOKEN_BUDGET,
    DEFAULT_DAILY_TOKEN_BUDGET,
  );
  const maxCallsPerRun = positiveOr(
    env.PQ_ARRIVAL_VISION_MAX_CALLS_PER_RUN,
    DEFAULT_MAX_CALLS_PER_RUN,
  );
  let callsThisRun = 0;

  function disabled() {
    return env.PQ_ARRIVAL_VISION_DISABLED === "1" || env.PQ_SUPABASE_WRITES_DISABLED === "1";
  }

  // Cheap pre-check lets Gmail ingestion avoid downloading attachment bytes when this
  // reader cannot possibly issue a bounded provider call.
  function canAttempt() {
    return !disabled() && looksLikeRealKey(apiKey) && callsThisRun < maxCallsPerRun;
  }

  async function extractArrivalNoticeEvidence({ base64, mimeType = "application/pdf", filename = "" } = {}) {
    if (disabled()) return failClosedResult("kill-switch");
    if (!looksLikeRealKey(apiKey)) return failClosedResult("no-key");
    if (!fetchImpl) return failClosedResult("no-fetch");
    if (!base64) return failClosedResult("no-document");
    if (callsThisRun >= maxCallsPerRun) return failClosedResult("run-cap");
    if (spendStore) {
      try {
        const spent = await spendStore.get();
        if (Number(spent?.tokens || 0) >= dailyTokenBudget) return failClosedResult("daily-budget");
      } catch {
        // The per-run cap still bounds calls if the persistent ledger is temporarily unreadable.
      }
    }
    callsThisRun += 1;

    const requestBody = JSON.stringify({
      model,
      temperature: 0,
      max_output_tokens: 200,
      store: false,
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: ARRIVAL_NOTICE_VISION_PROMPT },
          documentInput({ base64, mimeType, filename }),
        ],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "arrival_notice_result",
          strict: true,
          schema: ARRIVAL_NOTICE_SCHEMA,
        },
      },
    });

    let lastError = "";
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(OPENAI_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: requestBody,
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleepImpl(BACKOFF_MS[attempt]);
          continue;
        }
        return failClosedResult("network-error", { error: lastError });
      }

      const status = Number(response?.status || 0);
      if (status === 429 || status >= 500) {
        lastError = `provider ${status}`;
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleepImpl(BACKOFF_MS[attempt]);
          continue;
        }
        return failClosedResult("provider-unavailable", { error: lastError });
      }

      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (status >= 400) {
        return failClosedResult("provider-rejected", { error: `provider ${status}` });
      }

      const usage = Number(body?.usage?.total_tokens || 0);
      if (spendStore && usage) {
        try {
          await spendStore.add(usage);
        } catch {
          // Best-effort accounting; the logical-call cap remains authoritative this run.
        }
      }
      const parsed = parseModelJson(responseOutputText(body));
      if (!parsed) return failClosedResult("unparseable", { usage });
      return { ...parsed, usage, model };
    }
    return failClosedResult("exhausted-retries", { error: lastError });
  }

  return {
    extractArrivalNoticeEvidence,
    canAttempt,
    _looksLikeRealKey: looksLikeRealKey,
  };
}

module.exports = {
  createArrivalNoticeVisionOcr,
  looksLikeRealKey,
  parseModelJson,
  reasonContradictsArrival,
  responseOutputText,
  ARRIVAL_NOTICE_VISION_PROMPT,
  ARRIVAL_NOTICE_SCHEMA,
  DEFAULT_MODEL,
  MAX_ATTEMPTS,
};

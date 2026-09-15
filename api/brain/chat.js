"use strict";

const path = require("node:path");
const { answerOpsBrainQuestion, publicBrainAnswer } = require("../../lib/ops-brain-companion");
const { classifyOperatorUpdate } = require("../../lib/companion-memory-store");
const { sendJson } = require("../../lib/supabase-agent");

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => ({
      role: message?.role || "",
      content: message?.content || message?.text || message?.title || "",
      createdAt: message?.createdAt || message?.timestamp || "",
      context: message?.context || {},
      awb: message?.awb || message?.shipmentAwb || "",
      shipmentIds: Array.isArray(message?.shipmentIds) ? message.shipmentIds : [],
    }))
    .filter((message) => message.role && message.content);
}

function questionFromBody(body) {
  if (body.question || body.message) return body.question || body.message || "";
  const messages = normalizeMessages(body.messages);
  const lastUser = messages.slice().reverse().find((message) => message.role === "user");
  return lastUser?.content || "";
}

function historyFromBody(body) {
  const explicit = normalizeMessages(body.history);
  if (explicit.length) return explicit;
  return normalizeMessages(body.messages).slice(0, -1);
}

function latestContext(body, history) {
  const candidates = [
    body.context,
    body.shipment,
    body.awb ? { awb: body.awb } : null,
    ...history.slice().reverse().map((message) => ({
      ...(message.context || {}),
      awb: message.awb || message.context?.awb || message.shipmentIds?.[0] || "",
    })),
  ];
  return candidates.find((candidate) => candidate && (candidate.awb || candidate.station || candidate.topic)) || {};
}

function detectOperatorUpdate(question, context) {
  const update = classifyOperatorUpdate(question, context);
  return update.kind === "operator-update"
    ? { ...update, persisted: false, canonicalTruthRecorded: false }
    : update;
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const startedAt = Date.now();
  try {
    const body = await readBody(request);
    const history = historyFromBody(body);
    const question = questionFromBody(body);
    const context = latestContext(body, history);
    const operatorUpdate = detectOperatorUpdate(question, context);
    const result = await answerOpsBrainQuestion({
      rootDir: path.join(__dirname, "../.."),
      question,
      history,
      context,
      sessionState: body.sessionState,
      clarificationOptionId: body.clarificationOptionId,
    });
    const answer = publicBrainAnswer(result.answer);
    if (operatorUpdate.kind === "operator-update") {
      answer.operatorTruthCapture = {
        status: "not-recorded",
        awb: operatorUpdate.awb,
        reason: "Free text is conversation context only. Record shipment facts with a protected structured phone-truth control.",
      };
    }
    const durationMs = Date.now() - startedAt;
    if (durationMs > 2000) {
      console.warn("[brain-chat] slow answer", {
        durationMs,
        topic: answer?.context?.topic || "",
        hasAwb: Boolean(answer?.context?.awb),
        questionLength: String(question || "").length,
      });
    }
    sendJson(response, 200, { ok: result.ok, answer });
  } catch (error) {
    console.error("[brain-chat] failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

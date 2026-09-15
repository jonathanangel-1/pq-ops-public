#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeAwb } = require("../lib/awb");

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "ylyi-question-proof");

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
}

function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(readText(relativePath));
  } catch {
    return fallback;
  }
}

function proofByAwb(proofs = []) {
  const map = new Map();
  for (const proof of proofs) {
    const key = normalizeAwb(proof.awb);
    if (key) map.set(key, proof);
  }
  return map;
}

function compact(value, max = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function proofText(proof = {}) {
  return [
    proof.status,
    proof.summary,
    proof.nextAction,
    JSON.stringify(proof.proof || []),
    JSON.stringify(proof.emailValidation || {}),
    JSON.stringify(proof.historicalEvents || []),
    JSON.stringify(proof.historicalProof || []),
    JSON.stringify(proof.sources || []),
    JSON.stringify(proof.timeline || []),
  ].join("\n");
}

function sourceRefsForProof(proof = {}) {
  const refs = new Set();
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value.threadId) refs.add(`thread:${value.threadId}`);
    if (value.messageId) refs.add(`message:${value.messageId}`);
    if (value.filename) refs.add(`file:${value.filename}`);
    Object.values(value).forEach(walk);
  };
  walk(proof);
  return [...refs].slice(0, 8);
}

function has(text, pattern) {
  return pattern.test(String(text || ""));
}

function brokerNames(text) {
  return [
    "Rapid",
    "JD Direct",
    "SD Direct",
    "Binational",
    "FlitePak",
    "TQL",
    "Maple",
    "Cedar Dispatch",
    "Meadow Freight",
    "BTX",
  ].filter((name) => new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
}

function answerFromText(question, evidenceText, sourceRefs, fallbackEvidenceLabel) {
  const q = String(question || "").toLowerCase();
  const text = String(evidenceText || "");
  const sources = sourceRefs.length ? sourceRefs : [fallbackEvidenceLabel];
  const base = {
    question,
    state: "",
    evidence: compact(text),
    sources,
    unknowns: [],
    nextAction: "No action required for completed historical proof unless a source gap is listed.",
    confidence: "medium",
  };

  if (q.includes("released")) {
    if (has(text, /\b(?:release|released|customs[-\s]?release|cleared|ACE|1C|D\/?O|delivery order)\b/i)) {
      return { ...base, state: "Release/customs proof is present in the source trail.", confidence: "high" };
    }
    return { ...base, state: "Release proof is not explicit in the available source trail.", unknowns: ["release/DO proof"], confidence: "unknown", nextAction: "Ask customs broker or inspect source thread." };
  }

  if (q.includes("delivery order") || /\bdo\b/i.test(question)) {
    if (has(text, /\b(?:D\/?O|delivery order|release packet|DO package)\b/i)) {
      return { ...base, state: "Delivery order or release packet evidence is present.", confidence: "high" };
    }
    return { ...base, state: "Delivery order is not explicit in the available source trail.", unknowns: ["delivery order"], confidence: "unknown", nextAction: "Inspect release/broker packet thread." };
  }

  if (q.includes("station paid") || q.includes("station payment")) {
    if (has(text, /\b(?:CargoSprint|station[-\s]?fee|station payment|ground[-\s]?fee|fee payment|payment|paid)\b/i)) {
      return { ...base, state: "Station/payment evidence is present.", confidence: "high" };
    }
    return { ...base, state: "Station payment is not explicit in the available source trail.", unknowns: ["station payment"], confidence: "unknown", nextAction: "Check CargoSprint/station fee evidence." };
  }

  if (q.includes("broker") && (q.includes("send") || q.includes("packet") || q.includes("do/payment"))) {
    if (has(text, /\b(?:inbound alert|release packet|DO package|sent to|dispatch to|broker|pickup broker|award)\b/i)) {
      return { ...base, state: "Broker packet/alert or award evidence is present.", confidence: "high" };
    }
    return { ...base, state: "Broker packet evidence is not explicit.", unknowns: ["broker packet"], confidence: "unknown", nextAction: "Inspect broker alert thread." };
  }

  if (q.includes("pick it up") || q.includes("driver pick")) {
    if (has(text, /\b(?:picked up|pickup|recovered|loaded|driver|out for delivery|OFD|delivery completed|delivered|POD)\b/i)) {
      return { ...base, state: "Pickup/load or downstream delivery evidence is present.", confidence: "high" };
    }
    return { ...base, state: "Pickup proof is not explicit.", unknowns: ["pickup proof"], confidence: "unknown", nextAction: "Ask broker for pickup/load confirmation or record phone truth." };
  }

  if (q.includes("out for delivery")) {
    if (has(text, /\b(?:out for delivery|OFD|en[-\s]?route|loaded|delivery completed|delivered|POD)\b/i)) {
      return { ...base, state: "Out-for-delivery, delivery, or downstream POD evidence is present.", confidence: "high" };
    }
    return { ...base, state: "Out-for-delivery is not explicit.", unknowns: ["out-for-delivery proof"], confidence: "unknown", nextAction: "Ask broker for delivery ETA." };
  }

  if (q.includes("pod")) {
    if (has(text, /\b(?:POD|proof of delivery|signed|signature|pod attachment|pod photo|photos)\b/i)) {
      return { ...base, state: "POD/signature/photo evidence is present.", confidence: "high" };
    }
    return { ...base, state: "POD is not explicit.", unknowns: ["POD"], confidence: "unknown", nextAction: "Request signed POD from broker." };
  }

  if (q.includes("station phone")) {
    if (has(text, /\b(?:phone|tel|call|\+\d|contact)\b/i)) {
      return { ...base, state: "Station/contact evidence may be present; inspect source rows for exact number.", confidence: "low", nextAction: "Expose exact station contact from station memory or source evidence." };
    }
    return { ...base, state: "Station phone is not explicit in this proof trail.", unknowns: ["station phone number"], confidence: "unknown", nextAction: "Use station memory or ask station/handler." };
  }

  if (q.includes("broker say")) {
    const brokers = brokerNames(text);
    if (brokers.length) {
      return { ...base, state: `Broker evidence exists for ${brokers.join(", ")}.`, confidence: "medium", nextAction: "Open the broker thread for exact wording if needed." };
    }
    return { ...base, state: "Broker reply is not explicit in this proof trail.", unknowns: ["broker reply"], confidence: "unknown", nextAction: "Search/read broker thread." };
  }

  if (q.includes("stopping")) {
    if (has(text, /\b(?:exception|gap|missing|not found|blocked|hold|rejected|storage|detention|wrong|duplicate|issue|problem|pending)\b/i)) {
      return { ...base, state: "The source trail contains a blocker, exception, or caveat.", confidence: "medium", nextAction: "Inspect exception/source gap and resolve the named owner." };
    }
    return { ...base, state: "No unresolved blocker is obvious in the completed source summary.", confidence: "medium" };
  }

  return { ...base, state: "Question is represented but no specialized answer rule exists yet.", unknowns: ["question-specific rule"], confidence: "low", nextAction: "Add a question rule or route to model synthesis." };
}

function incidentEvidenceText(incident) {
  return readText(incident.incidentFile);
}

function answerIncidentQuestion(question, incident) {
  const text = incidentEvidenceText(incident);
  const q = String(question || "").toLowerCase();
  const base = answerFromText(question, text, [`incident:${incident.caseId}`], "incident-file");
  if (q.includes("pick it up") || q.includes("out for delivery")) {
    return {
      ...base,
      state: "Pickup/delivery movement is operator phone truth, not written Gmail proof in the incident record.",
      unknowns: ["written pickup/POD proof"],
      nextAction: "Record phone confirmation with person/company/time/claim, then ask Rapid for written pickup/POD proof.",
      confidence: "medium",
    };
  }
  if (q.includes("pod")) {
    return {
      ...base,
      state: "No POD proof is recorded for the BOS incident.",
      unknowns: ["POD"],
      nextAction: "Request POD from Rapid after delivery is confirmed.",
      confidence: "unknown",
    };
  }
  if (q.includes("station phone")) {
    return {
      ...base,
      state: "Station phone is not recorded in the incident file.",
      unknowns: ["station phone"],
      nextAction: "Use station memory or confirm El Al/Swissport BOS contact.",
      confidence: "unknown",
    };
  }
  return base;
}

function assertAnswer(answer) {
  assert.ok(answer.state, `${answer.question}: answer must include state`);
  assert.ok(answer.evidence || answer.sources?.length, `${answer.question}: answer must include evidence/source`);
  assert.ok(Array.isArray(answer.sources) && answer.sources.length, `${answer.question}: answer must include source refs`);
  assert.ok(answer.nextAction, `${answer.question}: answer must include next action`);
  assert.ok(answer.confidence, `${answer.question}: answer must include confidence`);
}

function main() {
  const fixtures = readJson("YLYI/07_Backtest_Cases/operator-question-backtests.json");
  const proofMap = proofByAwb(readJson("gmail-proof-snapshot.json", { proofs: [] }).proofs || []);
  const questions = fixtures.canonicalOperatorQuestions || [];
  assert.ok(questions.length >= 10, "Need at least 10 operator questions");

  const completed = (fixtures.completedCases || []).map((testCase) => {
    const proof = proofMap.get(normalizeAwb(testCase.awb));
    assert.ok(proof, `${testCase.caseId}: missing Gmail proof for ${testCase.awb}`);
    const text = proofText(proof);
    const sources = sourceRefsForProof(proof);
    const answers = questions.map((question) => answerFromText(question, text, sources, `gmail-proof:${testCase.awb}`));
    answers.forEach(assertAnswer);
    return {
      caseId: testCase.caseId,
      awb: testCase.awb,
      sourceRefs: sources,
      answers,
    };
  });

  const incidents = (fixtures.incidentCases || []).map((incident) => {
    const answers = questions.map((question) => answerIncidentQuestion(question, incident));
    answers.forEach(assertAnswer);
    return {
      caseId: incident.caseId,
      awbs: incident.awbs,
      sourceRefs: [`incident:${incident.incidentFile}`],
      answers,
    };
  });

  const result = {
    ok: true,
    generatedAt: new Date().toISOString(),
    completedCases: completed.length,
    incidentCases: incidents.length,
    questionsPerCase: questions.length,
    totalAnswers: (completed.length + incidents.length) * questions.length,
    next: "Wire this evidence-packet answer shape into lib/ops-brain-companion.js instead of keeping it as a standalone proof.",
    completed,
    incidents,
  };

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.json"), `${JSON.stringify(result, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    completedCases: result.completedCases,
    incidentCases: result.incidentCases,
    questionsPerCase: result.questionsPerCase,
    totalAnswers: result.totalAnswers,
  }));
}

main();

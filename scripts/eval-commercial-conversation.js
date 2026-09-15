"use strict";

// Commercial-conversation understanding eval (task #50, eval-first doctrine).
//
// Scores an extractor's reconstruction of operator-labeled exchange graphs
// (data/evals/commercial-conversation/cases.json). The extractor under test
// never sees the labels — it receives the raw thread messages and must
// produce, per case: message labels, typed edges, and derived state.
//
// Prediction contract (JSON file passed as --predictions):
//   { "schemaVersion": "commercial-conversation-eval-predictions-v1",
//     "cases": [ { "caseId": "...",
//                  "messages": [ { "messageId": "...", "labels": [{"type": "quote", ...}] } ],
//                  "edges":    [ { "type": "responds_to", "from": "<msgId>", "to": "<msgId|awb:...>" } ],
//                  "derivedState": { ... } } ] }
//
// Scoring:
//   - message labels: per-type precision/recall/F1 (a predicted label matches
//     iff same messageId + type; quote amounts must match exactly when present).
//   - edges: per-type precision/recall/F1 on (type, from, to) triples.
//   - derived state: exact-match checks on quotesReceived, bestQuoteUsd,
//     deadlines (kind+date), and openQuestions count.
//   - the gate is F1-based; thresholds are declared here and versioned.
//
// Modes:
//   node scripts/eval-commercial-conversation.js --self-test
//     Runs the harness against the labels themselves (must score 1.0) and
//     against an empty predictor (must score 0.0). Proves the harness.
//   node scripts/eval-commercial-conversation.js --predictions <file>
//     Scores a real extractor output and prints the verdict.

const fs = require("node:fs");
const path = require("node:path");

const CASES_PATH = path.join(__dirname, "..", "data", "evals", "commercial-conversation", "cases.json");
const THRESHOLDS = Object.freeze({
  schemaVersion: "commercial-conversation-eval-thresholds-v1",
  // Auto-accept for a claim class is only discussable above these; below,
  // everything stays operator-reviewed. Deliberately strict at v1.
  edgeF1: 0.95,
  labelF1: 0.95,
  derivedStateExact: 1.0,
});

function fail(msg) {
  console.error("EVAL HARNESS ERROR: " + msg);
  process.exit(2);
}

function loadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    fail(`cannot read ${p}: ${e.message}`);
  }
}

function labelKey(messageId, label) {
  const parts = [messageId, label.type];
  if (label.type === "quote" && Array.isArray(label.offers)) {
    const amounts = label.offers.map((o) => Number(o.amountUsd)).sort((a, b) => a - b);
    parts.push("amounts:" + amounts.join(","));
  }
  if (label.type === "answer" && label.asserts && label.asserts.kind === "lfd") {
    parts.push("lfd:" + label.asserts.date);
  }
  return parts.join("|");
}

function edgeKey(e) {
  return [e.type, e.from, e.to].join("|");
}

function prf(truthSet, predSet) {
  let tp = 0;
  for (const k of predSet) if (truthSet.has(k)) tp += 1;
  const precision = predSet.size === 0 ? 0 : tp / predSet.size;
  const recall = truthSet.size === 0 ? 1 : tp / truthSet.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, precision, recall, f1, truth: truthSet.size, predicted: predSet.size };
}

function scoreDerived(truth, pred) {
  const checks = [];
  const t = truth || {};
  const p = pred || {};
  checks.push(["quotesReceived", t.quotesReceived === p.quotesReceived]);
  checks.push(["bestQuoteUsd", t.bestQuoteUsd === p.bestQuoteUsd]);
  const tDead = JSON.stringify((t.deadlines || []).map((d) => d.kind + ":" + d.date).sort());
  const pDead = JSON.stringify((p.deadlines || []).map((d) => d.kind + ":" + d.date).sort());
  checks.push(["deadlines", tDead === pDead]);
  checks.push(["openQuestions", (t.openQuestions || []).length === (p.openQuestions || []).length]);
  const passed = checks.filter(([, ok]) => ok).length;
  return { checks, passed, total: checks.length, exact: passed === checks.length };
}

function scoreCases(truthCases, predCases) {
  const byId = new Map((predCases || []).map((c) => [c.caseId, c]));
  const labelTruth = new Set();
  const labelPred = new Set();
  const edgeTruth = new Set();
  const edgePred = new Set();
  const perCase = [];
  let derivedExact = 0;

  for (const tc of truthCases) {
    const pc = byId.get(tc.caseId) || { messages: [], edges: [], derivedState: {} };
    for (const m of tc.messages) for (const l of m.labels) labelTruth.add(tc.caseId + "|" + labelKey(m.messageId, l));
    for (const m of pc.messages || []) for (const l of m.labels || []) labelPred.add(tc.caseId + "|" + labelKey(m.messageId, l));
    for (const e of tc.edges) edgeTruth.add(tc.caseId + "|" + edgeKey(e));
    for (const e of pc.edges || []) edgePred.add(tc.caseId + "|" + edgeKey(e));
    const derived = scoreDerived(tc.expectedDerivedState, pc.derivedState);
    if (derived.exact) derivedExact += 1;
    perCase.push({ caseId: tc.caseId, derived });
  }

  const labels = prf(labelTruth, labelPred);
  const edges = prf(edgeTruth, edgePred);
  const derivedRate = truthCases.length === 0 ? 0 : derivedExact / truthCases.length;
  const verdict =
    labels.f1 >= THRESHOLDS.labelF1 &&
    edges.f1 >= THRESHOLDS.edgeF1 &&
    derivedRate >= THRESHOLDS.derivedStateExact
      ? "PASS"
      : "FAIL";
  return { labels, edges, derivedExactRate: derivedRate, perCase, thresholds: THRESHOLDS, verdict };
}

function main() {
  const args = process.argv.slice(2);
  const data = loadJson(CASES_PATH);
  if (data.schemaVersion !== "commercial-conversation-eval-cases-v1") fail("unexpected cases schemaVersion");
  if (!Array.isArray(data.cases) || data.cases.length < 3) fail("expected at least 3 labeled cases");

  if (args.includes("--self-test")) {
    const oracle = scoreCases(
      data.cases,
      data.cases.map((c) => ({ caseId: c.caseId, messages: c.messages, edges: c.edges, derivedState: c.expectedDerivedState })),
    );
    const empty = scoreCases(data.cases, []);
    const oracleOk = oracle.verdict === "PASS" && oracle.labels.f1 === 1 && oracle.edges.f1 === 1;
    const emptyOk = empty.verdict === "FAIL" && empty.labels.f1 === 0 && empty.edges.f1 === 0;
    console.log(JSON.stringify({
      selfTest: true,
      oracle: { verdict: oracle.verdict, labelF1: oracle.labels.f1, edgeF1: oracle.edges.f1, derived: oracle.derivedExactRate },
      empty: { verdict: empty.verdict, labelF1: empty.labels.f1, edgeF1: empty.edges.f1 },
      labeledCases: data.cases.length,
      labeledMessages: data.cases.reduce((n, c) => n + c.messages.length, 0),
      labeledEdges: data.cases.reduce((n, c) => n + c.edges.length, 0),
      ok: oracleOk && emptyOk,
    }, null, 2));
    process.exit(oracleOk && emptyOk ? 0 : 1);
  }

  const pi = args.indexOf("--predictions");
  if (pi === -1 || !args[pi + 1]) fail("pass --self-test or --predictions <file>");
  const preds = loadJson(args[pi + 1]);
  if (preds.schemaVersion !== "commercial-conversation-eval-predictions-v1") fail("unexpected predictions schemaVersion");
  const report = scoreCases(data.cases, preds.cases || []);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "PASS" ? 0 : 1);
}

main();

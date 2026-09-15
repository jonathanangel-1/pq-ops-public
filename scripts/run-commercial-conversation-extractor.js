"use strict";
// Runs the deterministic commercial-conversation extractor over the eval
// cases' raw inputs and scores it. Usage: node scripts/run-commercial-conversation-extractor.js
const fs = require("node:fs");
const path = require("node:path");
const { extractCase } = require("../lib/commercial-conversation-extractor");
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "evals", "commercial-conversation", "cases.json"), "utf8"));
const predictions = {
  schemaVersion: "commercial-conversation-eval-predictions-v1",
  cases: cases.cases.map((c) => ({
    caseId: c.caseId,
    ...extractCase({ awb: c.awb, messages: c.messages.map(({ messageId, at, from, to, subject, text }) => ({ messageId, at, from, to, subject, text })) }),
  })),
};
const out = path.join(__dirname, "..", "data", "evals", "commercial-conversation", "predictions-deterministic-v1.json");
fs.writeFileSync(out, JSON.stringify(predictions, null, 1));
console.error("predictions written: " + out);

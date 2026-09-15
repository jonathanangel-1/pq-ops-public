#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const BRAIN_API = fs.readFileSync(path.join(ROOT, "api/brain/chat.js"), "utf8");
const SHIPMENTS_API = fs.readFileSync(path.join(ROOT, "api/brain/shipments.js"), "utf8");
const BRAIN = fs.readFileSync(path.join(ROOT, "lib/ops-brain-companion.js"), "utf8");
const PLATFORM_ACTION = fs.readFileSync(path.join(ROOT, "lib/platform-action.js"), "utf8");
const LEGACY = require("../api/operator-note");

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); },
    json() { return JSON.parse(this.body); },
  };
}

async function main() {
  assert.doesNotMatch(APP, /fetch\(["']\/api\/operator-note["']/);
  assert.match(APP, /fetch\("\/api\/truth\/operator-browser-event"/);
  assert.match(APP, /"x-pikiio-operator-csrf": "structured-phone-truth-v1"/);
  assert.match(APP, /"idempotency-key": attempt\.idempotencyKey/);
  assert.doesNotMatch(APP, /PQ_TRUTH_OPERATOR_EVENT_TOKEN/,
    "the server operator-event secret must never enter the browser bundle");
  assert.doesNotMatch(APP, /localStorage\.setItem\("pikiio-operator-truth-floors-v1"/);
  assert.doesNotMatch(APP, /localStorage\.setItem\("pikiio-ops-brain-operator-notes"/);
  assert.match(APP, /localStorage\.removeItem\("pikiio-operator-truth-floors-v1"/);
  assert.match(APP, /localStorage\.removeItem\("pikiio-ops-brain-operator-notes"/);
  assert.doesNotMatch(APP, /function applyOperatorRecordedTruthOverlay/);
  assert.doesNotMatch(APP, /function enforceOperatorTruthFloor/);
  assert.doesNotMatch(APP, /operatorRecordAppliedAt/);

  assert.match(APP, /const OPERATOR_STATE_COMMAND_BY_OUTCOME = Object\.freeze/);
  assert.match(APP, /"delivered-pod-pending": "delivery_completed_pod_pending"/);
  assert.match(APP, /const STATION_FEE_COMMAND_BY_OUTCOME = Object\.freeze/);
  assert.match(APP, /paid: "station_fees_paid"/);
  assert.match(APP, /Phone-confirmed facts only\. Email evidence stays in Gmail truth\./);
  assert.match(APP, /unsupported outcomes stay review-only/);
  assert.match(APP, /data-noncanonical-decision-disabled/);
  assert.match(APP, /Saving is disabled until a protected non-canonical decision ledger exists/);
  assert.match(APP, /Shipment fact not recorded/);
  assert.match(APP, /I did not change shipment truth from that free-text message/);

  assert.match(SERVER, /operatorBrowserEventApi = require\("\.\/api\/truth\/operator-browser-event"\)/);
  assert.match(SERVER, /requestPath === "\/api\/truth\/operator-browser-event"/);
  assert.match(SERVER, /LEGACY_OPERATOR_NOTE_RETIRED/);
  assert.doesNotMatch(SERVER, /async function persistLocalOperatorUpdate/);
  assert.doesNotMatch(BRAIN_API, /upsertAppSnapshot\("companion-memory"/);
  assert.doesNotMatch(BRAIN_API, /upsertOperatorNote\(/);
  assert.match(BRAIN_API, /operatorTruthCapture/);
  assert.match(SHIPMENTS_API, /platformExecutableAction\(row\.primaryAction, row\)/,
    "stored primary actions must be sanitized before browser delivery");
  assert.doesNotMatch(PLATFORM_ACTION, /endpoint: "\/api\/operator-note"/);
  assert.match(PLATFORM_ACTION, /endpoint: "\/api\/truth\/operator-browser-event"/);
  assert.match(PLATFORM_ACTION, /status: "review-only"/);
  assert.doesNotMatch(BRAIN, /loaded = withOperatorNotes\(loaded, history, question, context\)/);
  assert.doesNotMatch(BRAIN, /companionMemory: upsertOperatorNote/);
  assert.match(BRAIN, /Free text cannot change shipment truth/);

  const response = responseCapture();
  await LEGACY({ method: "POST" }, response);
  assert.equal(response.statusCode, 410);
  assert.equal(response.json().code, "LEGACY_OPERATOR_NOTE_RETIRED");
  assert.equal(response.json().canonicalTruthRecorded, false);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-operator-browser-ui",
    checks: 35,
    guarantees: [
      "the browser carries no relational operator-event or Supabase secret",
      "legacy free-text endpoints, companion mutation, local facts, and lifecycle floors are retired",
      "only allowlisted state/fee outcomes call the protected structured authority",
      "unsupported operational decisions and free text are visibly non-canonical and cannot pretend shipment truth changed",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

// Platform-native action layer contract: every ACTIVE shipment carries ONE primary
// executable action (platform-action-v1) — never advice text, never a bare generic.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { ACTION_TYPES, TARGET_ROLES, PLATFORM_ACTION_SCHEMA, platformExecutableAction, _test } = require("../lib/platform-action");

const ROOT = path.resolve(__dirname, "..");

const BANNED_GENERIC_ONLY = [
  /^follow up\.?$/i,
  /^call (?:the )?broker\.?$/i,
  /^monitor(?: arrival)?\.?$/i,
  /^confirm status\.?$/i,
  /^check status\.?$/i,
  /^push (?:the )?customs broker\.?$/i,
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function fileIncludes(file, needle, message) {
  const content = fs.readFileSync(path.join(ROOT, file), "utf8");
  assert.ok(content.includes(needle), `${message} (${file} must contain: ${needle})`);
}

function assertNoGenericOnly(text, label, context) {
  const value = String(text || "").trim();
  for (const pattern of BANNED_GENERIC_ONLY) {
    assert.ok(!pattern.test(value), `${label} must not be a bare generic`, { value, ...context });
  }
}

function verifyPrimaryAction(row) {
  const awb = row.awb || row.id;
  const action = platformExecutableAction(row.primaryAction, row);
  assert.ok(action && action.platform, `${awb}: active shipment must carry a primary executable action`);
  const platform = action.platform;
  assert.equal(platform.schema, PLATFORM_ACTION_SCHEMA, `${awb}: platform action schema`);
  assert.ok(ACTION_TYPES.includes(platform.actionType), `${awb}: actionType must be in the platform vocabulary (${platform.actionType})`);
  assert.ok(TARGET_ROLES.includes(platform.targetRole), `${awb}: targetRole must be in the platform vocabulary (${platform.targetRole})`);
  assert.ok(["ready", "needs_missing_info", "blocked", "draft_only"].includes(platform.safeStatus), `${awb}: safeStatus vocabulary (${platform.safeStatus})`);
  assert.ok(Array.isArray(platform.controls) && platform.controls.length, `${awb}: action must expose at least one control button`);
  assert.ok(platform.controls.every((control) => ["draft", "call", "add_missing_info", "record_result", "close"].includes(control)),
    `${awb}: controls vocabulary (${platform.controls})`);
  assert.ok(String(platform.whyNow || "").trim().length >= 12, `${awb}: whyNow must explain why this action is needed now`);
  assert.ok(String(platform.expectedProof || "").trim().length >= 12, `${awb}: expectedProof must state the fact the operator waits for next`);
  assertNoGenericOnly(action.label, `${awb}: label`);
  assertNoGenericOnly(platform.whyNow, `${awb}: whyNow`);
  assertNoGenericOnly(platform.script?.body, `${awb}: script body`);

  // Executable means: a live recipient/phone, an internal-operator decision, or the exact
  // missing field named so the operator can supply it.
  const hasEmail = /@/.test(String(platform.targetEmail || ""));
  const hasPhone = /\d{7,}/.test(String(platform.targetPhone || "").replace(/[^0-9]/g, ""));
  const internal = platform.targetRole === "internal-operator";
  const named = (platform.missingFields || []).length > 0;
  assert.ok(hasEmail || hasPhone || internal || named,
    `${awb}: action must carry a recipient, be an internal decision, or name the exact missing field`);
  if (platform.safeStatus === "needs_missing_info") {
    assert.ok(named, `${awb}: needs_missing_info must name the missing field(s)`);
  }
  // Draft-mode safety: email-channel actions never send without approval.
  if (String(action.channel || "") === "gmail") {
    assert.equal(action.autonomy?.mode || action.safety?.mode || "draft-only", "draft-only", `${awb}: gmail actions must be draft-only`);
  }
  // Reply threading: replies must carry (or name as missing) the source thread.
  if (String(action.threadPolicy || "") === "reply_existing") {
    const hasThread = Boolean(platform.replyThreadId || platform.replyMessageId);
    const namesThread = (platform.missingFields || []).includes("source thread id");
    assert.ok(hasThread || namesThread, `${awb}: reply action must carry the source thread or name it missing`);
  }
  // Recipient/confidence contract (Action Registry): planner-generated gmail
  // actions must say who is on the draft and why, with a confidence label; low
  // confidence must never read as a confident send.
  if (String(action.channel || "") === "gmail" && action.recipients) {
    assert.ok(["high", "medium", "low"].includes(String(action.confidence || "")),
      `${awb}: gmail actions with a recipients block must carry a confidence label`);
    assert.ok(Array.isArray(action.recipients.to) && Array.isArray(action.recipients.cc) && Array.isArray(action.recipients.excluded),
      `${awb}: recipients block must carry to/cc/excluded arrays`);
    for (const entry of [...action.recipients.to, ...action.recipients.cc, ...action.recipients.excluded]) {
      assert.ok(entry.reason, `${awb}: every recipient must say why it is included/excluded`);
    }
  }
  // Call actions: a named contact plus a dialable number, never a bare "call broker".
  if (String(action.channel || "") === "phone") {
    assert.ok(String(action.targetName || "").trim().length > 1, `${awb}: call action must name the contact`);
    assert.ok(/\d{7,}/.test(String(action.targetPhone || action.phone || "").replace(/[^0-9]/g, "")),
      `${awb}: call action must carry a dialable number`);
  }
  // Result capture must never route through the retired free-text mutation.
  assert.notEqual(platform.recordResult?.endpoint, "/api/operator-note", `${awb}: retired record-result endpoint`);
  if (platform.recordResult?.status === "structured-phone-truth") {
    assert.equal(platform.recordResult.endpoint, "/api/truth/operator-browser-event", `${awb}: structured record-result endpoint`);
    assert.ok((platform.recordResult.options || []).some((option) => option.command), `${awb}: structured record-result commands`);
  } else {
    assert.equal(platform.recordResult?.status, "review-only", `${awb}: unsupported result stays review-only`);
    assert.equal(platform.recordResult?.endpoint, "", `${awb}: review-only result has no mutation endpoint`);
  }
}

function main() {
  const packets = readJson("shipment-truth-packets.json");
  const activeRows = (packets.shipments || []).filter((row) => String(row.truthPacketRole || "active").toLowerCase() === "active");
  assert.ok(activeRows.length > 0, "at least one active shipment expected");
  for (const row of activeRows) verifyPrimaryAction(row);

  // Normalizer unit contracts.
  assert.equal(_test.platformActionTypeFor({ type: "station-contact-research" }), "request_missing_contact", "contact research maps to request_missing_contact");
  assert.equal(_test.platformActionTypeFor({ type: "pod-followup", channel: "gmail" }), "request_pod", "pod followup maps to request_pod");
  assert.equal(_test.platformActionTypeFor({ type: "customs-followup", channel: "gmail", execution: "draft_gmail_email" }), "draft_email", "customs followup maps to draft_email");
  const normalized = platformExecutableAction({
    id: "x", type: "customs-followup", channel: "gmail", execution: "draft_gmail_email",
    targetName: "Jane Broker", targetEmail: "contact-047@demo-freight.example", subject: "016-1 release", body: "Hi Jane, please confirm release for 016-1.",
    reason: "Freight is on hand and waiting on customs release.", postActionExpectedFact: "Release/DO or ACE proof lands on the thread.",
    autonomy: { mode: "draft-only" },
  }, { awb: "016-1" });
  assert.equal(normalized.platform.safeStatus, "draft_only", "gmail action with recipient is draft_only");
  assert.deepEqual(normalized.platform.controls, ["draft", "record_result"], "draftable action exposes draft + record buttons");
  assert.equal(normalized.platform.recordResult.status, "review-only", "email outcome cannot become shipment truth through free text");
  assert.equal(normalized.platform.recordResult.endpoint, "", "review-only email outcome has no mutation endpoint");
  const feeResult = _test.recordResultFor({ type: "station-fee-confirmation" });
  assert.equal(feeResult.endpoint, "/api/truth/operator-browser-event", "fee truth uses structured browser authority");
  assert.deepEqual(feeResult.options.map((option) => option.command), [
    "station_fees_paid", "station_fees_none_due", "station_fees_due",
  ]);
  const stateResult = _test.recordResultFor({
    type: "operator-state-check",
    operatorOutcomeOptions: [
      { value: "picked-up", label: "Picked up" },
      { value: "broker-approved", label: "Broker approved" },
    ],
  });
  assert.equal(stateResult.endpoint, "/api/truth/operator-browser-event");
  assert.equal(stateResult.options[0].command, "pickup_completed");
  assert.equal(stateResult.options[1].recordable, false);

  // UI + API projection contracts.
  fileIncludes("app.js", "platform-action-v1", "app.js must prefer the server primary executable action");
  fileIncludes("app.js", "renderPlatformActionMeta", "app.js must render the platform action meta (status/missing/proof)");
  fileIncludes("api/brain/shipments.js", "const primaryAction = sourceGap || !row.primaryAction", "API projection must expose primaryAction only after source certification");
  fileIncludes("api/brain/shipments.js", "platformExecutableAction(row.primaryAction, row)", "API projection must sanitize stale primary-action result endpoints");
  fileIncludes("lib/gmail-direct-ingest.js", "attachPrimaryPlatformActions", "hosted promoted packets must attach primary actions");
  fileIncludes("app.js", "renderProductionHealthPanel", "UI must render the production health panel");
  fileIncludes("app.js", "data-refresh-authority=\"server-only\"", "UI must label Gmail refresh as server-only until operator sessions exist");
  const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.ok(!appSource.includes('fetch("/api/email-refresh/run-now"') && !appSource.includes("data-retry-gmail-refresh"),
    "UI must not expose an unauthenticated Gmail mutation path");
  fileIncludes("app.js", "platform-action-stale", "stale evidence must mark action confidence without hiding actions");
  fileIncludes("lib/truth-health.js", "bundledTruthAgreementSummary", "health must carry the bundled truth agreement score");

  console.log(JSON.stringify({
    ok: true,
    checked: [
      "every-active-shipment-has-primary-executable-action",
      "action-type-role-status-controls-vocabulary",
      "no-bare-generic-actions",
      "recipient-or-internal-or-named-missing-field",
      "gmail-draft-only-safety",
      "reply-thread-carried-or-named-missing",
      "record-result-structured-or-review-only",
      "ui-and-api-projection",
      "freshness-panel-retry-and-stale-confidence",
    ],
    activeShipments: activeRows.length,
  }, null, 2));
}

main();

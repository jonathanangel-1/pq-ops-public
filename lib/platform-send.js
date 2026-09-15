"use strict";

// Platform-native approve/send lane (L3 of the production-stack plan).
//
// Contract: a reviewed Gmail draft may be sent from inside the platform ONLY
// when every layer agrees, at send time, that it is still the email the
// operator approved and the world has not moved underneath it:
//
//   1. The lane flag PIKIIO_PLATFORM_SEND_ENABLED is explicitly "true"
//      (fail closed — absent/other values refuse everything, including
//      perfectly-formed requests).
//   2. An explicit human approval: operator identity, confirm phrase, and a
//      recent approvedAt timestamp.
//   3. Hash-verified reviewed draft: the operator approved a specific body;
//      the server recomputes sha256 over the body it is about to send and
//      refuses on any mismatch, and to/cc must equal the reviewed to/cc.
//   4. Server rechecks at send time: truth snapshot freshness, source gaps,
//      unresolved contradictions / mustAskHuman, recipient confidence.
//   5. Thread correctness: a reply goes to the conversation's thread; a new
//      email is only allowed when no thread is expected, and needs a subject.
//   6. Every decision (send OR refusal) produces an audit record carrying
//      actionId, awb, gmailDraftId, threadId, messageId, bodyHash, to/cc,
//      approval identity and the refusal codes.
//
// This module is pure decision logic with an injectable transport so the
// dry-run verifier can prove the full pipeline without any live send.

const crypto = require("crypto");

const PLATFORM_SEND_FLAG = "PIKIIO_PLATFORM_SEND_ENABLED";
const APPROVAL_CONFIRM_PHRASE = "SEND";
// The first (and only) send class: classified reply actions whose
// preconditions the truth pipeline proves. Everything else drafts to Gmail.
const SENDABLE_ACTION_TYPES = new Set([
  "customs-followup",
  "station-confirmation",
  "station-fee-confirmation",
  "quote-followup",
  "pod-followup",
  "broker-followup",
  "ops-escalation",
]);
const APPROVAL_MAX_AGE_MINUTES = 15;
const TRUTH_MAX_AGE_MINUTES = 30;

function platformSendEnabled(env = process.env) {
  return String(env[PLATFORM_SEND_FLAG] || "").trim().toLowerCase() === "true";
}

function platformSendContract(env = process.env) {
  return {
    lane: "platform-send",
    enabled: platformSendEnabled(env),
    flag: PLATFORM_SEND_FLAG,
    mode: platformSendEnabled(env) ? "operator-approved-live-send" : "disabled",
    autonomyLevel: "L2",
    requiresHumanApproval: true,
    approvalConfirmPhrase: APPROVAL_CONFIRM_PHRASE,
    approvalMaxAgeMinutes: APPROVAL_MAX_AGE_MINUTES,
    truthMaxAgeMinutes: TRUTH_MAX_AGE_MINUTES,
    transport: "gmail-drafts-send",
    reviewedDraftHash: "sha256",
  };
}

function draftBodyHash(body = "") {
  return crypto.createHash("sha256").update(String(body || ""), "utf8").digest("hex");
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmailList(list = []) {
  return (Array.isArray(list) ? list : [list])
    .map((item) => normalizeEmail(typeof item === "object" ? item?.email : item))
    .filter(Boolean)
    .sort();
}

function emailListsEqual(a = [], b = []) {
  const left = normalizeEmailList(a);
  const right = normalizeEmailList(b);
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function wellFormedEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function minutesBetween(fromIso, toIso) {
  const from = Date.parse(fromIso || "");
  const to = Date.parse(toIso || "");
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return (to - from) / 60000;
}

// Every check returns refusal rows; ok === no refusals. Checks never throw on
// malformed input — malformed input is a refusal, not an exception.
function evaluatePlatformSend(input = {}, env = process.env) {
  const {
    action = {},
    draft = {},
    approval = {},
    truth = {},
    sync = {},
    now = new Date().toISOString(),
  } = input;
  const refusals = [];
  const refuse = (code, reason) => refusals.push({ code, reason });

  // 1. Lane flag — always evaluated first, fail closed.
  if (!platformSendEnabled(env)) {
    refuse("flag_disabled", `${PLATFORM_SEND_FLAG} is not "true"; platform send is disabled.`);
  }

  // 1b. Explicit action-type allowlist: only classified, precondition-proven
  //     reply actions may send. Anything unclassified stays draft-only.
  const actionType = String(action.type || "").trim();
  if (!SENDABLE_ACTION_TYPES.has(actionType)) {
    refuse("unsupported_action", `Action type "${actionType || "(none)"}" is not in the platform-send allowlist.`);
  }

  // 2. Explicit human approval.
  if (!String(approval.approvedBy || "").trim()) {
    refuse("approval_missing_operator", "No operator identity on the approval.");
  }
  if (String(approval.confirm || "").trim().toUpperCase() !== APPROVAL_CONFIRM_PHRASE) {
    refuse("approval_missing_confirm", `Approval must carry the explicit confirm phrase "${APPROVAL_CONFIRM_PHRASE}".`);
  }
  const approvalAge = minutesBetween(approval.approvedAt, now);
  if (approvalAge == null || approvalAge < 0 || approvalAge > APPROVAL_MAX_AGE_MINUTES) {
    refuse("approval_stale", `Approval timestamp missing or older than ${APPROVAL_MAX_AGE_MINUTES} minutes.`);
  }

  // 3. Hash-verified reviewed draft.
  if (!String(draft.gmailDraftId || "").trim()) {
    refuse("draft_missing_id", "No Gmail draftId; only an existing reviewed draft can be sent.");
  }
  const serverBodyHash = draftBodyHash(draft.body || "");
  if (!String(draft.body || "").trim()) {
    refuse("draft_empty_body", "Draft body is empty.");
  }
  if (String(approval.reviewedBodyHash || "") !== serverBodyHash) {
    refuse("draft_hash_mismatch", "The reviewed body hash does not match the body the server would send.");
  }
  if (!emailListsEqual(approval.reviewedTo, draft.to)) {
    refuse("recipients_changed_to", "Draft To: differs from the reviewed To:.");
  }
  if (!emailListsEqual(approval.reviewedCc, draft.cc)) {
    refuse("recipients_changed_cc", "Draft Cc: differs from the reviewed Cc:.");
  }

  // 4. Recipients well-formed, roster-backed, and HIGH confidence. The first
  //    allowed send class never guesses: every To: address must come from the
  //    action's resolved (Gmail-proof-backed) roster with high confidence.
  const toList = normalizeEmailList(draft.to);
  if (!toList.length) {
    refuse("recipients_empty", "Draft has no To: recipients.");
  }
  const badRecipient = [...normalizeEmailList(draft.to), ...normalizeEmailList(draft.cc)]
    .find((email) => !wellFormedEmail(email));
  if (badRecipient) {
    refuse("recipients_malformed", `Recipient "${badRecipient}" is not a valid address.`);
  }
  const plannedRecipients = Array.isArray(action.recipients?.to) ? action.recipients.to : [];
  if (!plannedRecipients.length) {
    refuse("recipients_unrostered", "No resolved recipient roster on this action — a guessed recipient can never be sent to.");
  } else {
    const notHigh = plannedRecipients.find((item) => String(item.confidence || "").toLowerCase() !== "high");
    if (notHigh) {
      refuse("recipient_confidence", `Recipient ${notHigh.email || notHigh.name || "?"} is not high-confidence.`);
    }
    const plannedSet = normalizeEmailList(plannedRecipients);
    const unplanned = toList.find((email) => !plannedSet.includes(email));
    if (unplanned) {
      refuse("recipient_unplanned", `To: ${unplanned} is not among the action's resolved recipients.`);
    }
  }

  // 5. Thread correctness — the first allowed send class is EXISTING-THREAD
  //    replies only. A new email (no proven Gmail thread) is not sendable.
  const expectedThreadId = String(
    action.conversation?.threadId || action.threadId || draft.expectedThreadId || "",
  ).trim();
  if (expectedThreadId) {
    if (String(draft.threadId || "").trim() !== expectedThreadId) {
      refuse("thread_mismatch", `Draft thread ${draft.threadId || "(none)"} is not the conversation thread ${expectedThreadId}.`);
    }
  } else {
    refuse("new_thread_not_allowed", "Only replies in an existing Gmail thread can be sent; new emails stay draft-only.");
  }

  // 6. Server rechecks: the world must not have moved since review.
  if (truth.mustAskHuman === true) {
    refuse("truth_must_ask_human", "The shipment's truth packet is flagged mustAskHuman.");
  }
  const contradictions = Array.isArray(truth.contradictions) ? truth.contradictions : [];
  if (contradictions.length) {
    refuse("truth_contradictions", `Unresolved contradictions on the shipment: ${contradictions.map((row) => row.id || row.dimension || "?").join(", ")}.`);
  }
  const sourceGaps = Number(sync.sourceGapCount ?? truth.sourceGapCount ?? 0) || 0;
  if (sourceGaps > 0) {
    refuse("source_gaps", `${sourceGaps} source gap(s) reported; truth may be incomplete.`);
  }
  if (sync.sourceHealthStatus && String(sync.sourceHealthStatus).toLowerCase() !== "live") {
    refuse("sync_not_live", `Source health is "${sync.sourceHealthStatus}", not live.`);
  }
  const truthAge = minutesBetween(sync.snapshotTime || truth.snapshotTime, now);
  if (truthAge == null || truthAge < 0 || truthAge > TRUTH_MAX_AGE_MINUTES) {
    refuse("truth_stale", `Truth snapshot missing or older than ${TRUTH_MAX_AGE_MINUTES} minutes.`);
  }

  return {
    ok: refusals.length === 0,
    refusals,
    bodyHash: serverBodyHash,
    expectedThreadId,
    contract: platformSendContract(env),
  };
}

function platformSendAuditRecord(input = {}, evaluation = {}, outcome = {}) {
  const { action = {}, draft = {}, approval = {}, now = new Date().toISOString() } = input;
  return {
    lane: "platform-send",
    decidedAt: now,
    status: outcome.status || (evaluation.ok ? "approved" : "refused"),
    actionId: action.id || action.actionId || "",
    awb: action.awb || "",
    actionType: action.type || "",
    gmailDraftId: draft.gmailDraftId || "",
    threadId: outcome.threadId || draft.threadId || evaluation.expectedThreadId || "",
    messageId: outcome.messageId || "",
    bodyHash: evaluation.bodyHash || "",
    to: normalizeEmailList(draft.to),
    cc: normalizeEmailList(draft.cc),
    subject: draft.subject || "",
    approvedBy: approval.approvedBy || "",
    approvedAt: approval.approvedAt || "",
    refusals: evaluation.refusals || [],
    dryRun: Boolean(outcome.dryRun),
  };
}

// Executes the full pipeline. deps.sendDraft is the ONLY path to a live send
// and is never called unless the evaluation is clean, dryRun is false, AND the
// flag is (re)checked as enabled.
async function executePlatformSend(input = {}, deps = {}, env = process.env) {
  const evaluation = evaluatePlatformSend(input, env);
  const dryRun = input.dryRun !== false; // default dry-run: sending must be asked for explicitly
  if (!evaluation.ok) {
    return {
      status: "refused",
      sent: false,
      dryRun,
      evaluation,
      audit: platformSendAuditRecord(input, evaluation, { status: "refused", dryRun }),
    };
  }
  if (dryRun) {
    return {
      status: "dry-run",
      sent: false,
      wouldSend: true,
      dryRun: true,
      evaluation,
      audit: platformSendAuditRecord(input, evaluation, { status: "dry-run-approved", dryRun: true }),
    };
  }
  // Belt-and-suspenders: re-check the flag immediately before transport.
  if (!platformSendEnabled(env)) {
    const refusedEvaluation = {
      ...evaluation,
      ok: false,
      refusals: [{ code: "flag_disabled", reason: `${PLATFORM_SEND_FLAG} is not "true"; platform send is disabled.` }],
    };
    return {
      status: "refused",
      sent: false,
      dryRun: false,
      evaluation: refusedEvaluation,
      audit: platformSendAuditRecord(input, refusedEvaluation, { status: "refused", dryRun: false }),
    };
  }
  if (typeof deps.sendDraft !== "function") {
    throw new Error("platform-send: no sendDraft transport provided");
  }
  const sendResult = await deps.sendDraft(input.draft.gmailDraftId);
  return {
    status: "sent",
    sent: true,
    dryRun: false,
    evaluation,
    messageId: sendResult.messageId || "",
    threadId: sendResult.threadId || "",
    audit: platformSendAuditRecord(input, evaluation, {
      status: "sent",
      messageId: sendResult.messageId || "",
      threadId: sendResult.threadId || "",
      dryRun: false,
    }),
  };
}

module.exports = {
  PLATFORM_SEND_FLAG,
  SENDABLE_ACTION_TYPES,
  APPROVAL_CONFIRM_PHRASE,
  platformSendEnabled,
  platformSendContract,
  draftBodyHash,
  evaluatePlatformSend,
  platformSendAuditRecord,
  executePlatformSend,
};

"use strict";

// Platform-native approve/send endpoint (flag-off by default).
//
// POST /api/actions/approve-send
// { actionId, awb, dryRun,
//   draft: { gmailDraftId, body, subject, to[], cc[], threadId },
//   approval: { approvedBy, approvedAt, confirm: "SEND",
//               reviewedBodyHash, reviewedTo[], reviewedCc[] } }
//
// The decision pipeline lives in lib/platform-send.js and fail-closes unless
// PIKIIO_PLATFORM_SEND_ENABLED === "true". Every decision — refusal, dry-run,
// or send — is appended to the platform-send-audit snapshot.

const path = require("node:path");

const { loadAppSnapshot, sendJson, upsertAppSnapshot } = require("../../lib/supabase-agent");
const { readOpsBrainMemory } = require("../../lib/ops-brain-companion");
const { _test: { truthSourceHealth } } = require("../brain/shipments.js");
const { recordOperatorEventAction } = require("../../lib/operator-events");
const { sendGmailDraftById } = require("../../lib/gmail-direct-ingest");
const {
  executePlatformSend,
  platformSendContract,
} = require("../../lib/platform-send");

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

function normalizedAwbKey(value = "") {
  return String(value || "").replace(/\D/g, "");
}

async function resolveAction(actionId) {
  if (!actionId) return null;
  try {
    const queue = await loadAppSnapshot("action-queue", { actions: [] });
    return (queue.actions || []).find((item) => item.id === actionId) || null;
  } catch {
    return null;
  }
}

async function resolveTruthContext(awb, injectedMemory = null) {
  try {
    const memory = injectedMemory || await readOpsBrainMemory(path.join(__dirname, "../.."), process.env, { includeGmailProof: false });
    const packets = memory.truthPackets || {};
    const row = (packets.shipments || []).find(
      (item) => normalizedAwbKey(item.awb || item.id) === normalizedAwbKey(awb),
    );
    // The send gate must see the SAME health the board shows the operator:
    // verified-but-unchanged truth is fresh (write-skip freezes snapshotTime),
    // and a row-scoped source gap on ANOTHER shipment never blocks this one.
    const health = truthSourceHealth(memory);
    const rowKey = normalizedAwbKey(awb);
    const rowScopedLive = health.status === "live" ||
      (String(health.sourceGapScope || "fleet") === "rows" &&
        !(health.sourceGapAwbKeys || []).includes(rowKey));
    const effectiveSnapshotTime = [packets.snapshotTime || "", health.verifiedAt || ""]
      .filter(Boolean)
      .sort()
      .pop() || "";
    return {
      truth: row?.truthPacket || {},
      sync: {
        snapshotTime: effectiveSnapshotTime,
        sourceHealthStatus: !packets.shipments?.length
          ? "missing"
          : rowScopedLive
            ? "live"
            : health.status || "degraded",
        sourceGapCount: (row?.sourceTruthWarnings || []).length,
      },
      shipmentFound: Boolean(row),
    };
  } catch {
    return { truth: {}, sync: {}, shipmentFound: false };
  }
}

async function appendAuditRecord(audit) {
  try {
    const snapshot = await loadAppSnapshot("platform-send-audit", {
      sourceOfTruth:
        "Every platform approve/send decision (refusal, dry-run, send) is recorded here with actionId/draftId/threadId/messageId/bodyHash provenance.",
      records: [],
    });
    await upsertAppSnapshot("platform-send-audit", {
      ...snapshot,
      snapshotTime: audit.decidedAt,
      records: [audit, ...(snapshot.records || [])].slice(0, 200),
    });
  } catch {
    // Audit persistence failure must not turn into a silent send; callers only
    // send after executePlatformSend returned "sent", which happens before this.
  }
}

async function recordSentEmailFact(action = {}, draft = {}, result = {}, now = new Date().toISOString()) {
  const { emptyCompanionMemory, operatorNoteFromEntry, upsertOperatorNote } = require("../../lib/companion-memory-store");
  const current = await loadAppSnapshot("companion-memory", emptyCompanionMemory(now));
  const note = operatorNoteFromEntry({
    awb: action.awb || "",
    text: `Sent from Pikiio by Alex: reply to ${(draft.to || []).join(", ")} — "${draft.subject || ""}". We asked the counterparty; awaiting reply. (messageId ${result.messageId || ""}, thread ${result.threadId || ""})`,
    purpose: "platform-sent-email",
    origin: "platform-send",
    actionId: action.id || "",
  }, now);
  const next = upsertOperatorNote(current, note, now);
  await upsertAppSnapshot("companion-memory", {
    snapshotTime: next.snapshotTime,
    source: next.source,
    operatorNotes: next.operatorNotes,
    resolvedConflicts: next.resolvedConflicts || [],
    alertStates: next.alertStates || [],
  });
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  try {
    const body = await readBody(request);
    const actionId = body.actionId || body.action?.id || "";
    const awb = body.awb || body.action?.awb || "";
    const queuedAction = await resolveAction(actionId);
    const action = queuedAction || body.action || {};
    const { truth, sync, shipmentFound } = await resolveTruthContext(awb || action.awb || "");

    const input = {
      action: { ...action, id: actionId || action.id || "", awb: awb || action.awb || "" },
      draft: body.draft || {},
      approval: body.approval || {},
      truth,
      // An AWB the truth snapshot does not know is never safe to send about.
      sync: shipmentFound ? sync : { ...sync, sourceHealthStatus: "shipment-not-found" },
      dryRun: body.dryRun !== false,
      now: new Date().toISOString(),
    };

    const result = await executePlatformSend(input, { sendDraft: sendGmailDraftById });
    // The audit carries what we now EXPECT the world to produce.
    result.audit.expectedPostActionFact = result.status === "sent"
      ? `A reply from ${(body.draft?.to || []).join(", ")} lands in Gmail thread ${result.threadId || body.draft?.threadId || ""}.`
      : "";
    await appendAuditRecord(result.audit);
    if (result.status === "sent") {
      // First-class truth: the send itself becomes an operator-visible fact
      // ("we asked; awaiting reply"), so agency/work items move to waiting on
      // the next refresh without any extra bookkeeping.
      await recordSentEmailFact(input.action, body.draft || {}, result, input.now).catch(() => {});
    }
    if (result.status === "sent" && action.operatorEventId) {
      await recordOperatorEventAction(action.operatorEventId, "email_sent", {
        actionId: input.action.id,
        awb: input.action.awb,
        gmailDraftId: input.draft?.gmailDraftId || body.draft?.gmailDraftId || "",
        messageId: result.messageId,
        threadId: result.threadId,
        bodyHash: result.evaluation.bodyHash,
      }).catch(() => {});
    }

    const flagRefused = (result.evaluation.refusals || []).some((row) => row.code === "flag_disabled");
    const statusCode = result.status === "sent" ? 201 : result.status === "dry-run" ? 200 : flagRefused ? 423 : 409;
    sendJson(response, statusCode, {
      status: result.status,
      sent: result.sent,
      dryRun: result.dryRun,
      wouldSend: result.wouldSend || false,
      refusals: result.evaluation.refusals,
      bodyHash: result.evaluation.bodyHash,
      messageId: result.messageId || "",
      threadId: result.threadId || "",
      contract: platformSendContract(),
      audit: result.audit,
    });
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

module.exports._test = { resolveTruthContext };

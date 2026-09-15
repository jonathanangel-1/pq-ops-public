"use strict";

const fs = require("fs/promises");
const path = require("path");

const {
  loadAppSnapshot,
  queueAgentJob,
  sendJson,
  upsertAppSnapshot,
} = require("../../lib/supabase-agent");
const {
  actionIntentKey,
  actionWithOperatorDraftOverrides,
  draftIntentKey,
  draftPayloadForAction,
  providedActionCanQueue,
  publicOutboxRequest,
  validateDraftableAction,
} = require("../../lib/action-safety");
const {
  createGmailDraft,
  gmailDirectAvailable,
} = require("../../lib/gmail-direct-ingest");
const { materializeDraftAttachmentsForAction } = require("../../lib/delivery-order-action");
const { recordOperatorEventAction } = require("../../lib/operator-events");
const {
  handleSourceBackfillAction,
  isSourceBackfillAction,
} = require("../../lib/source-backfill");
const {
  handleMoneyContextAction,
  isMoneyContextAction,
} = require("../../lib/money-refresh");
const {
  handleCarrierTrackingRefreshAction,
  isCarrierTrackingRefreshAction,
} = require("../../lib/carrier-tracking-refresh");

function json(response, statusCode, body) {
  sendJson(response, statusCode, body);
}

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

function publicAttachment(attachment) {
  return {
    fileName: attachment.fileName || attachment.filename || "",
    contentType: attachment.contentType || attachment.mimeType || "",
    kind: attachment.kind || "",
    awb: attachment.awb || "",
    carrierName: attachment.carrierName || "",
    size: Number(attachment.size || 0) || 0,
  };
}

async function attachGeneratedDocuments(action, draftPlan) {
  if (draftPlan.jobType !== "draft_gmail_email") return [];
  const result = await materializeDraftAttachmentsForAction(action);
  if (!result.attachments.length) return [];
  draftPlan.payload.attachmentFiles = [
    ...(draftPlan.payload.attachmentFiles || []),
    ...result.attachments,
  ];
  draftPlan.payload.attachments = [
    ...(draftPlan.payload.attachments || []),
    ...result.attachments.map(publicAttachment),
  ];
  return result.generated || [];
}

function isDryRun(request, body) {
  const url = new URL(request.url || "/", "http://localhost");
  return body.dryRun === true || url.searchParams.get("dryRun") === "1";
}

async function readBundledActionQueue() {
  try {
    return JSON.parse(await fs.readFile(path.join(__dirname, "../../action-queue.json"), "utf8"));
  } catch {
    return { actions: [] };
  }
}

async function loadActionQueueSnapshot({ allowBundledFallback = false } = {}) {
  try {
    return await loadAppSnapshot("action-queue", { actions: [] });
  } catch (error) {
    if (allowBundledFallback) return readBundledActionQueue();
    throw error;
  }
}

async function resolveHostedAction(actionId, providedAction, dryRun) {
  if (dryRun && providedAction) {
    return { action: providedAction, actionQueue: { actions: [providedAction] } };
  }
  if (providedAction && !providedActionCanQueue(actionId, providedAction)) {
    const actionQueue = await loadActionQueueSnapshot({ allowBundledFallback: true });
    const action = (actionQueue.actions || []).find((item) => item.id === actionId);
    if (action) return { action: actionWithOperatorDraftOverrides(action, providedAction), actionQueue };
    if (dryRun) return { action: providedAction, actionQueue };
    return { action: null, actionQueue };
  }
  const actionQueue = await loadActionQueueSnapshot({ allowBundledFallback: Boolean(providedAction) });
  const action = (actionQueue.actions || []).find((item) => item.id === actionId);
  if (action) return { action: actionWithOperatorDraftOverrides(action, providedAction), actionQueue };
  if (dryRun && providedAction) return { action: providedAction, actionQueue };
  if (providedActionCanQueue(actionId, providedAction)) return { action: providedAction, actionQueue };
  return {
    action: null,
    actionQueue,
  };
}

async function persistHostedDraftRequest(action, request, now) {
  const [actionQueue, outbox] = await Promise.all([
    loadAppSnapshot("action-queue", { actions: [] }),
    loadAppSnapshot("outbox-requests", {
      sourceOfTruth:
        "Dashboard-created outbox requests are draft intents. The agent/Gmail transport must create drafts and mark them ready for human approval.",
      requests: [],
    }),
  ]);

  const existingActions = actionQueue.actions || [];
  const hasExistingAction = existingActions.some((item) => item.id === action.id);
  const queuedAction = {
    ...action,
    status: request.status || "queued",
    queuedAt: request.queuedAt || now,
    draftedAt: request.draftedAt || action.draftedAt || "",
    gmailDraftId: request.gmailDraftId || action.gmailDraftId || "",
    outboxRequestId: request.id,
    agentJobId: request.agentJobId || null,
  };
  const actions = hasExistingAction
    ? existingActions.map((item) => (item.id === action.id ? { ...item, ...queuedAction } : item))
    : [queuedAction, ...existingActions];

  const requests = [
    request,
    ...(outbox.requests || []).filter((item) => item.id !== request.id),
  ].slice(0, 200);

  await Promise.all([
    upsertAppSnapshot("action-queue", {
      ...actionQueue,
      snapshotTime: now,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actions.filter((item) => item.status === "queued").length,
        drafted: actions.filter((item) => item.status === "drafted").length,
        sent: actions.filter((item) => item.status === "sent").length,
      },
      actions,
    }),
    upsertAppSnapshot("outbox-requests", {
      ...outbox,
      snapshotTime: now,
      requests,
    }),
  ]);
}

module.exports = async function handler(request, response) {
  if (request.method !== "POST") {
    json(response, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readBody(request);
    const actionId = body.actionId || body.action?.id || "";
    const dryRun = isDryRun(request, body);
    if (isSourceBackfillAction(body.action)) {
      const result = await handleSourceBackfillAction(actionId, body.action, { dryRun });
      json(response, result.statusCode, result.body);
      return;
    }
    if (isMoneyContextAction(body.action)) {
      const result = await handleMoneyContextAction(actionId, body.action, { dryRun });
      json(response, result.statusCode, result.body);
      return;
    }
    if (isCarrierTrackingRefreshAction(body.action)) {
      const result = await handleCarrierTrackingRefreshAction(actionId, body.action, { dryRun });
      json(response, result.statusCode, result.body);
      return;
    }
    const { action } = await resolveHostedAction(actionId, body.action || null, dryRun);
    const validationError = validateDraftableAction(actionId, action);
    if (validationError) {
      json(response, validationError === "Action not found" ? 404 : 409, { error: validationError });
      return;
    }

    const now = new Date().toISOString();
    const outboxRequestId = `${action.id}-${Date.parse(now)}`;
    const draftPlan = draftPayloadForAction(action, outboxRequestId, now);

    if (dryRun) {
      json(response, 200, {
        ok: true,
        dryRun: true,
        queued: false,
        wouldQueue: true,
        jobType: draftPlan.jobType,
        safety: draftPlan.safety,
        request: {
          ...publicOutboxRequest(action, now, draftPlan, null),
          status: "validated",
          queuedAt: null,
        },
      });
      return;
    }

    const generatedAttachments = await attachGeneratedDocuments(action, draftPlan);

    if (draftPlan.jobType === "draft_gmail_email" && gmailDirectAvailable()) {
      const gmailDraft = await createGmailDraft(draftPlan.payload);
      const publicRequest = {
        ...publicOutboxRequest(action, now, draftPlan, null),
        status: "drafted",
        queuedAt: null,
        draftedAt: now,
        agentJobId: null,
        gmailDraftId: gmailDraft.draftId || "",
        gmailMessageId: gmailDraft.messageId || "",
        gmailThreadId: gmailDraft.threadId || draftPlan.payload.conversation?.threadId || "",
        generatedAttachments,
      };

      await persistHostedDraftRequest(action, publicRequest, now);
      if (action.operatorEventId) {
        await recordOperatorEventAction(action.operatorEventId, "draft_created", {
          actionId,
          awb: action.awb || "",
          outboxRequestId: publicRequest.id,
          gmailDraftId: publicRequest.gmailDraftId || "",
        }).catch(() => {});
      }

      json(response, 201, {
        queued: false,
        drafted: true,
        dryRun: false,
        direct: true,
        jobType: draftPlan.jobType,
        request: publicRequest,
        gmailDraft,
        generatedAttachments,
        safety: draftPlan.safety,
      });
      return;
    }

    const queueResult = await queueAgentJob(draftPlan.jobType, draftPlan.payload, {
      dedupeKey: actionIntentKey(action) || draftIntentKey(actionId),
      priority: action.priority === "high" ? 15 : 55,
      maxAttempts: 2,
    });

    const publicRequest = {
      ...publicOutboxRequest(action, now, draftPlan, queueResult.job),
      agentJobId: queueResult.job?.id || null,
      duplicate: queueResult.duplicate || false,
      generatedAttachments,
    };

    await persistHostedDraftRequest(action, publicRequest, now);
    if (action.operatorEventId) {
      await recordOperatorEventAction(action.operatorEventId, "draft_requested", {
        actionId,
        awb: action.awb || "",
        outboxRequestId: publicRequest.id,
        agentJobId: publicRequest.agentJobId || null,
      }).catch(() => {});
    }

    json(response, 202, {
      queued: true,
      dryRun: false,
      jobType: draftPlan.jobType,
      request: publicRequest,
      duplicate: queueResult.duplicate || false,
      generatedAttachments,
      safety: draftPlan.safety,
    });
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
};

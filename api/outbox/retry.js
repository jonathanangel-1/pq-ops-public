"use strict";

const {
  loadAppSnapshot,
  queueAgentJob,
  sendJson,
  upsertAppSnapshot,
} = require("../../lib/supabase-agent");
const { materializeDraftAttachmentsForAction } = require("../../lib/delivery-order-action");
const {
  actionIntentKey,
  actionFromOutboxRequest,
  draftIntentKey,
  draftPayloadForAction,
  publicOutboxRequest,
  validateDraftableAction,
} = require("../../lib/action-safety");

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

function isDryRun(request, body) {
  const url = new URL(request.url || "/", "http://localhost");
  return body.dryRun === true || url.searchParams.get("dryRun") === "1";
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

async function persistHostedRetry(action, request, now) {
  const [actionQueue, outbox] = await Promise.all([
    loadAppSnapshot("action-queue", { actions: [] }),
    loadAppSnapshot("outbox-requests", { requests: [] }),
  ]);
  const existingActions = actionQueue.actions || [];
  const queuedAction = {
    ...action,
    status: "queued",
    queuedAt: now,
    outboxRequestId: request.id,
    agentJobId: request.agentJobId || null,
  };
  const actions = existingActions.some((item) => item.id === action.id)
    ? existingActions.map((item) => (item.id === action.id ? { ...item, ...queuedAction } : item))
    : [queuedAction, ...existingActions];

  await Promise.all([
    upsertAppSnapshot("action-queue", {
      ...actionQueue,
      snapshotTime: now,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actions.filter((item) => item.status === "queued").length,
        drafted: actions.filter((item) => item.status === "drafted").length,
        sent: actions.filter((item) => item.status === "sent").length,
        failed: actions.filter((item) => item.status === "failed").length,
      },
      actions,
    }),
    upsertAppSnapshot("outbox-requests", {
      ...outbox,
      snapshotTime: now,
      requests: [
        request,
        ...(outbox.requests || []).filter((item) => item.id !== request.id),
      ].slice(0, 200),
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
    const requestId = body.requestId || body.outboxRequestId || "";
    const dryRun = isDryRun(request, body);
    const suppliedDryRunRequest = dryRun && body.request?.id === requestId ? body.request : null;
    const outbox = suppliedDryRunRequest ? null : await loadAppSnapshot("outbox-requests", { requests: [] });
    const failedRequest = suppliedDryRunRequest || (outbox.requests || []).find((item) => item.id === requestId);
    if (!failedRequest) {
      json(response, 404, { error: "Outbox request not found" });
      return;
    }
    if (failedRequest.status !== "failed") {
      json(response, 409, { error: "Only failed draft requests can be retried" });
      return;
    }

    const action = actionFromOutboxRequest(failedRequest);
    const actionId = action?.id || "";
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

    const queueResult = await queueAgentJob(draftPlan.jobType, draftPlan.payload, {
      dedupeKey: actionIntentKey(action, "retry") || draftIntentKey(requestId, "retry"),
      priority: action.priority === "high" ? 15 : 55,
      maxAttempts: 2,
    });
    const publicRequest = {
      ...publicOutboxRequest(action, now, draftPlan, queueResult.job),
      agentJobId: queueResult.job?.id || null,
      duplicate: queueResult.duplicate || false,
      generatedAttachments,
    };
    await persistHostedRetry(action, publicRequest, now);
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

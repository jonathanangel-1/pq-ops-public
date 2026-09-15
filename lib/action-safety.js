"use strict";

const DEFAULT_TMS_REVIEW_EMAIL = "contact-053@demo-freight.example";

function normalizeChannel(channel) {
  return String(channel || "gmail").toLowerCase();
}

function isTmsChannel(channel) {
  return ["couriercloud", "tms", "couriercloud-tms"].includes(normalizeChannel(channel));
}

function isPlatformChannel(channel) {
  return ["platform", "companion", "ops-brain"].includes(normalizeChannel(channel));
}

function conversationForReply(conversation, replyMessageId = "") {
  if (!conversation && !replyMessageId) return null;
  return {
    ...(conversation || {}),
    replyMessageId: replyMessageId || conversation?.replyMessageId || "",
  };
}

function tmsExperienceEmail() {
  return DEFAULT_TMS_REVIEW_EMAIL;
}

function betaDraftModeContract() {
  return {
    mode: "draft-only",
    autonomyLevel: "L2",
    requiresHumanApproval: true,
    liveExecution: false,
    gmailTransport: "draft_gmail_email",
    tmsTransport: "operator-approved-tms",
    tmsTransports: ["send_tms_agt_alert", "complete_tms_pod_closeout"],
    tmsReviewEmail: tmsExperienceEmail(),
  };
}

function tmsOperatorApprovalContract() {
  return {
    mode: "operator-approved-live-tms",
    autonomyLevel: "L2",
    requiresHumanApproval: true,
    liveExecution: true,
    tmsTransport: "operator-approved-tms",
    tmsTransports: ["send_tms_agt_alert", "complete_tms_pod_closeout"],
  };
}

function operatorApprovedInternalContract(transport = "internal-agent") {
  return {
    mode: "operator-approved-internal",
    autonomyLevel: "L2",
    requiresHumanApproval: true,
    liveExecution: true,
    internalTransport: transport,
    internalTransports: ["gmail-direct-oauth-cron", "email_refresh", "money_refresh", "tracking_refresh", "operator-browser-truth", "station-memory", "broker-contact"],
  };
}

function draftIntentKey(actionId, suffix = "action") {
  const key = String(actionId || "").trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  return key ? `draft_gmail_email:${suffix}:${key}` : "";
}

function actionIntentKey(action, suffix = "action") {
  const key = String(action?.id || "").trim().replace(/[^A-Za-z0-9_.:-]+/g, "-");
  if (!key) return "";
  if (isPlatformChannel(action?.channel)) return `platform_alert:${suffix}:${key}`;
  return isTmsChannel(action?.channel)
    ? `${tmsJobTypeForAction(action)}:${suffix}:${key}`
    : `draft_gmail_email:${suffix}:${key}`;
}

const BROKER_FACING_ACTION_TYPES = new Set([
  "broker-award",
  "broker-status-followup",
  "delivery-order-email",
  "dispatch-pickup-followup",
  "pickup-location-reply",
  "pod-followup",
  "quote-followup",
  "quote-request",
]);

const CUSTOMER_FACING_ACTION_TYPES = new Set([
  "customer-update",
]);

function brokerFacingDraft(action, channel) {
  return channel === "gmail" && BROKER_FACING_ACTION_TYPES.has(action.type);
}

function customerFacingDraft(action, channel) {
  return channel === "gmail" && CUSTOMER_FACING_ACTION_TYPES.has(action.type);
}

function brokerSafeBody(action, body) {
  if (!brokerFacingDraft(action, normalizeChannel(action.channel))) return body;
  const lines = String(body || "").split(/\r?\n/);
  const blocked =
    /^(Quote comparison|Quote options|Other options|Blocked lower quote|Lower quote needs review|Operator cost context|Customer charge|Vendor cost|Margin unknown|Airport|Carrier|Client|Consignee|Pickup context|Current next action|Storage context)\b/i;
  return lines.filter((line) => !blocked.test(line.trim())).join("\n");
}

function autonomyForChannel(channel) {
  const tmsExperience = isTmsChannel(channel);
  const platformAlert = isPlatformChannel(channel);
  return {
    level: "L2",
    mode: platformAlert ? "platform-alert" : tmsExperience ? "operator-approved-tms" : "draft-only",
    label: platformAlert ? "Platform alert" : tmsExperience ? "Send from TMS" : "Draft only",
    requiresHumanApproval: true,
    liveExecution: tmsExperience,
    transport: platformAlert ? "in-platform-alert" : tmsExperience ? "couriercloud-live-action" : "gmail-draft",
  };
}

function normalizedAutonomyForChannel(channel, autonomy = {}) {
  const base = autonomyForChannel(channel);
  return {
    ...base,
    label: autonomy.label || base.label,
  };
}

function safetyForChannel(channel) {
  const normalized = normalizeChannel(channel);
  const tmsExperience = isTmsChannel(normalized);
  const platformAlert = isPlatformChannel(normalized);
  const autonomy = autonomyForChannel(normalized);
  return {
    mode: platformAlert ? "platform-alert" : tmsExperience ? "operator-approved-tms" : "draft-only",
    originalChannel: normalized,
    redirectedTo: "",
    autonomyLevel: autonomy.level,
    autonomyMode: autonomy.mode,
    note: platformAlert
      ? "Shown inside Ops Brain. No Gmail draft or TMS job is queued."
      : tmsExperience
      ? "CourierCloud/TMS actions execute only after the operator clicks the dashboard button."
      : "Dashboard operator actions create Gmail drafts only.",
  };
}

function autonomyForInternalAction(transport = "internal-agent", label = "Run internal task") {
  return {
    level: "L2",
    mode: "operator-approved-internal",
    label,
    requiresHumanApproval: true,
    liveExecution: true,
    transport,
  };
}

function safetyForInternalAction(transport = "internal-agent", note = "") {
  return {
    mode: "operator-approved-internal",
    originalChannel: "platform",
    redirectedTo: "",
    autonomyLevel: "L2",
    autonomyMode: "operator-approved-internal",
    internalTransport: transport,
    note: note || "Operator-approved internal action. The dashboard records or queues the shipment repair task after the operator clicks; no outbound Gmail send or CourierCloud mutation is performed.",
  };
}

function tmsJobTypeForAction(action) {
  const intentKind = String(action?.tmsIntent?.kind || "");
  if (action?.type === "tms-pod-closeout-experience" || intentKind === "pod-actual-signed-closeout") {
    return "complete_tms_pod_closeout";
  }
  return "send_tms_agt_alert";
}

function attachmentIntentsForAction(action) {
  return [
    ...(Array.isArray(action?.attachmentIntents) ? action.attachmentIntents : []),
    action?.attachmentIntent,
  ].filter(Boolean);
}

function publicAttachmentMetadata(attachment) {
  if (!attachment || typeof attachment !== "object") return null;
  return {
    fileName: attachment.fileName || attachment.filename || "",
    contentType: attachment.contentType || attachment.mimeType || "",
    kind: attachment.kind || "",
    awb: attachment.awb || "",
    carrierName: attachment.carrierName || "",
    size: Number(attachment.size || 0) || 0,
  };
}

function normalizedSafetyForChannel(channel, safety = {}) {
  const base = safetyForChannel(channel);
  return {
    ...base,
    note: safety.note || base.note,
  };
}

function actionThreadPolicy(action) {
  const policy = String(action?.threadPolicy || "").toLowerCase();
  if (["reply_existing", "start_new", "unavailable"].includes(policy)) return policy;
  return action?.replyMessageId || action?.conversation?.replyMessageId || action?.conversation?.threadId
    ? "reply_existing"
    : "start_new";
}

function isUsableEmailTarget(value) {
  const text = String(value || "").trim();
  return Boolean(
    text &&
      !/\b(?:unknown|not found|missing|n\/a|none)\b/i.test(text) &&
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)
  );
}

function isInternalPikiEmailTarget(value) {
  const text = String(value || "").trim().toLowerCase();
  return Boolean(text && (text === "contact-053@demo-freight.example" || /@demo-freight\.example\b/.test(text)));
}

function actionPreflight(actionId, action) {
  const missing = [];
  const errors = [];
  if (!actionId) errors.push("Missing actionId");
  if (!action) {
    errors.push("Action not found");
    return {
      status: "blocked",
      ready: false,
      missing,
      errors,
      threadPolicy: "unavailable",
      reason: errors[0],
    };
  }

  if (action.missing?.length) missing.push(...action.missing);
  const channel = normalizeChannel(action.channel);
  if (!channel) errors.push("Action channel is missing");
  if (isPlatformChannel(channel)) errors.push("Platform alerts are shown in Ops Brain and are not queued as email drafts");
  const tmsAction = isTmsChannel(channel);
  if (!tmsAction && action.autonomy?.liveExecution === true) errors.push("Live execution is disabled in beta draft mode");
  if (action.autonomy?.requiresHumanApproval === false) errors.push("Human approval is required in beta draft mode");
  if (!tmsAction && ["live", "send"].includes(String(action.autonomy?.mode || "").toLowerCase())) {
    errors.push("Live execution is disabled in beta draft mode");
  }
  if (!tmsAction && ["live", "send"].includes(String(action.safety?.autonomyMode || "").toLowerCase())) {
    errors.push("Live execution is disabled in beta draft mode");
  }
  if (!tmsAction && String(action.safety?.mode || "").toLowerCase() === "live") {
    errors.push("Live execution is disabled in beta draft mode");
  }
  if (!tmsAction && ["live", "send"].includes(String(action.execution || "").toLowerCase())) {
    errors.push("Live execution is disabled in beta draft mode");
  }
  if (!["gmail", "couriercloud", "tms", "couriercloud-tms"].includes(channel)) {
    errors.push("Unsupported dashboard action channel");
  }

  if (!tmsAction) {
    if (!isUsableEmailTarget(action.targetEmail)) missing.push("recipient email");
    if (actionThreadPolicy(action) === "reply_existing") {
      const hasThread = action.replyMessageId || action.conversation?.replyMessageId || action.conversation?.threadId;
      if (!hasThread) missing.push("Gmail thread");
    }
  }
  if (tmsAction && !action.orderLink) missing.push("CourierCloud order link");
  if (tmsAction && action.type === "tms-broker-award-experience" && !isUsableEmailTarget(action.targetEmail)) missing.push("broker email");
  if (tmsAction && action.type === "tms-pod-closeout-experience") {
    const signedBy = action.tmsIntent?.signedBy || action.podProposal?.signedBy || "";
    const actualDate = action.tmsIntent?.actualDate || action.podProposal?.actualDate || "";
    const actualTime = action.tmsIntent?.actualTime || action.podProposal?.actualTime || action.podProposal?.actualAt || "";
    if (!signedBy) missing.push("POD signed name");
    if (!actualDate) missing.push("POD actual date");
    if (!actualTime) missing.push("POD actual time");
  }
  if (!String(action.subject || "").trim()) missing.push("subject");
  if (!String(action.body || "").trim()) missing.push("body");
  if (brokerFacingDraft(action, channel)) {
    if (isInternalPikiEmailTarget(action.targetEmail)) {
      errors.push("Broker-facing drafts cannot target an internal Piki inbox");
    }
    const brokerBody = brokerSafeBody(action, action.body || "");
    if (/^(Quote comparison|Quote options|Other options|Blocked lower quote|Lower quote needs review|Operator cost context|Customer charge|Vendor cost|Margin unknown)\b/im.test(brokerBody)) {
      errors.push("Broker-facing drafts cannot include internal quote comparison or margin context");
    }
  }
  if (customerFacingDraft(action, channel)) {
    const body = String(action.body || "");
    if (/\b(TMS|broker|quote|rate|cost|charge|margin|station|warehouse|CargoSprint|payment|POD|D\/?O|delivery order|internal|release docs?|paperwork)\b/i.test(body)) {
      errors.push("Customer-facing drafts can only mention delivery timing or customs issues");
    }
  }

  const uniqueMissing = [...new Set(missing.filter(Boolean))];
  const uniqueErrors = [...new Set(errors.filter(Boolean))];
  return {
    status: uniqueMissing.length || uniqueErrors.length ? "blocked" : "ready",
    ready: !uniqueMissing.length && !uniqueErrors.length,
    missing: uniqueMissing,
    errors: uniqueErrors,
    threadPolicy: actionThreadPolicy(action),
    reason: uniqueErrors[0] || (uniqueMissing.length ? `Action is missing: ${uniqueMissing.join(", ")}` : ""),
  };
}

function tmsPayloadForAction(action, outboxRequestId, now) {
  const channel = normalizeChannel(action.channel);
  const autonomy = normalizedAutonomyForChannel(channel, action.autonomy);
  const intent = action.tmsIntent || {};
  const jobType = tmsJobTypeForAction(action);
  const brokerEmail = intent.brokerEmail || action.targetEmail || "";
  const copyEmail = intent.copyEmail || action.cc || "";
  return {
    jobType,
    payload: {
      actionId: action.id,
      shipmentId: action.shipmentId,
      awb: action.awb,
      orderLink: action.orderLink || "",
      type: action.type || "",
      label: action.label || "",
      targetName: action.targetName || "",
      brokerName: intent.brokerName || action.targetName || "",
      brokerEmail,
      copyEmail,
      contactedEmails: intent.contactedEmails || [brokerEmail, copyEmail].filter(Boolean),
      cc: copyEmail,
      bcc: "",
      subject: action.subject || "",
      body: action.body || action.reason || "",
      podProposal: action.podProposal || null,
      actualDate: intent.actualDate || action.podProposal?.actualDate || "",
      actualTime: intent.actualTime || action.podProposal?.actualTime || action.podProposal?.actualAt || "",
      signedBy: intent.signedBy || action.podProposal?.signedBy || "",
      tmsIntent: intent,
      timing: action.timing || null,
      source: "dashboard-tms-live",
      mode: "operator-approved-live-tms",
      transport: jobType,
      originalChannel: channel,
      originalExecution: action.execution || "",
      betaContract: tmsOperatorApprovalContract(),
      autonomy,
      originalTargetEmail: action.targetEmail || "",
      originalTargetName: action.targetName || "",
      stationContactMissing: false,
      outboxRequestId,
      requestedAt: now,
    },
    publicChannel: channel,
    publicExecution: "operator-approved-tms",
    publicTargetEmail: action.targetEmail || "",
    publicTargetName: action.targetName || "",
    safety: safetyForChannel(channel),
  };
}

function draftPayloadForAction(action, outboxRequestId, now) {
  const channel = normalizeChannel(action.channel);
  if (isPlatformChannel(channel)) {
    throw new Error("Platform alerts are shown inside Ops Brain and cannot be queued as Gmail drafts.");
  }
  if (isTmsChannel(channel)) return tmsPayloadForAction(action, outboxRequestId, now);
  const autonomy = normalizedAutonomyForChannel(channel, action.autonomy);
  const targetEmail = action.targetEmail;
  const originalTargetEmail = action.stationContactMissing || action.originalTargetEmail !== action.targetEmail
    ? action.originalTargetEmail || ""
    : "";
  const originalTargetName = action.stationContactMissing || action.originalTargetName !== action.targetName
    ? action.originalTargetName || ""
    : "";
  const actionBody = String(action.body || "");
  const normalizedSubject = String(action.subject || "");
  const payloadBody = brokerSafeBody(action, actionBody);
  const replyMessageId = action.replyMessageId || "";
  const attachmentFiles = Array.isArray(action.attachmentFiles) ? action.attachmentFiles : [];
  const attachmentIntents = attachmentIntentsForAction(action);
  const attachments = (Array.isArray(action.attachments) ? action.attachments : attachmentFiles)
    .map(publicAttachmentMetadata)
    .filter(Boolean);

  return {
    jobType: "draft_gmail_email",
    payload: {
      actionId: action.id,
      shipmentId: action.shipmentId,
      awb: action.awb,
      to: targetEmail,
      cc: action.cc || "",
      bcc: action.bcc || "",
      targetName: action.targetName || "",
      type: action.type || "",
      label: action.label || "",
      subject: normalizedSubject,
      body: payloadBody,
      replyMessageId,
      conversation: conversationForReply(action.conversation, replyMessageId),
      documentIntent: action.documentIntent || null,
      attachmentIntent: action.attachmentIntent || null,
      attachmentIntents,
      attachmentFiles,
      attachments,
      timing: action.timing || null,
      source: "dashboard",
      mode: "draft",
      transport: "gmail-draft",
      originalChannel: channel,
      originalExecution: action.execution || "",
      betaContract: betaDraftModeContract(),
      autonomy,
      originalTargetEmail,
      originalTargetName,
      stationContactMissing: Boolean(action.stationContactMissing),
      outboxRequestId,
      requestedAt: now,
    },
    publicChannel: "gmail",
    publicExecution: "draft-only",
    publicTargetEmail: targetEmail,
    publicTargetName: action.targetName || "",
    safety: safetyForChannel(channel),
  };
}

function stripReplyPrefix(subject) {
  return String(subject || "").replace(/^(?:\s*re\s*:\s*)+/i, "").trim();
}

function actionWithOperatorDraftOverrides(action, providedAction) {
  if (!action || !providedAction || action.id !== providedAction.id) return action;
  if (isPlatformChannel(action.channel) || isTmsChannel(action.channel)) return action;
  const next = { ...action };
  if (typeof providedAction.targetEmail === "string") next.targetEmail = providedAction.targetEmail.trim();
  if (typeof providedAction.cc === "string") next.cc = providedAction.cc.trim();
  if (typeof providedAction.bcc === "string") next.bcc = providedAction.bcc.trim();
  const requestedThreadPolicy = String(providedAction.threadPolicy || "").toLowerCase();
  if (requestedThreadPolicy === "start_new") {
    next.threadPolicy = "start_new";
    next.replyMessageId = "";
    next.conversation = null;
    next.subject = stripReplyPrefix(next.subject);
  } else if (requestedThreadPolicy === "reply_existing") {
    next.threadPolicy = "reply_existing";
    next.replyMessageId = providedAction.replyMessageId || action.replyMessageId || action.conversation?.replyMessageId || "";
    next.conversation = providedAction.conversation || action.conversation || null;
  }
  return next;
}

function actionFromOutboxRequest(request) {
  if (!request || typeof request !== "object") return null;
  const originalChannel = request.originalChannel || request.channel || "gmail";
  const autonomy = normalizedAutonomyForChannel(originalChannel, request.autonomy);
  const safety = normalizedSafetyForChannel(originalChannel, request.safety);
  const tmsExperience = isTmsChannel(originalChannel);
  const reportDraft = /^eod-report-/i.test(request.actionId || request.id || "");
  return {
    id: request.actionId || request.id,
    shipmentId: request.shipmentId || "",
    awb: request.awb || "",
    type: request.type && request.type !== "draft-retry" ? request.type : reportDraft ? "eod-report" : "draft-retry",
    label: request.label && request.label !== "Retry draft" ? request.label : reportDraft ? "Draft EOD report" : "Retry draft",
    channel: originalChannel,
    execution: request.originalExecution || request.execution || "draft-only",
    status: "suggested",
    priority: request.priority || "high",
    autonomy,
    targetName: tmsExperience ? request.originalTargetName || "" : request.targetName || "",
    targetEmail: tmsExperience ? request.originalTargetEmail || "" : request.to || request.targetEmail || "",
    cc: tmsExperience ? "" : request.cc || "",
    bcc: tmsExperience ? "" : request.bcc || "",
    subject: request.subject || "",
    body: request.body || "",
    replyMessageId: request.replyMessageId || "",
    conversation: conversationForReply(request.conversation, request.replyMessageId || ""),
    timing: request.timing || null,
    tmsIntent: request.tmsIntent || null,
    documentIntent: request.documentIntent || null,
    attachmentIntent: request.attachmentIntent || null,
    attachmentIntents: request.attachmentIntents || [],
    attachmentFiles: request.attachmentFiles || [],
    attachments: request.attachments || [],
    orderLink: request.orderLink || "",
    reason: request.reason || (reportDraft ? "Daily end-of-day tomorrow plan report." : "Retry failed draft request."),
    missing: [],
    stationContactMissing: Boolean(request.stationContactMissing),
    originalTargetName: request.originalTargetName || "",
    originalTargetEmail: request.originalTargetEmail || "",
    safety,
  };
}

function validateDraftableAction(actionId, action) {
  const preflight = actionPreflight(actionId, action);
  if (preflight.errors[0] === "Action not found") return "Action not found";
  if (preflight.errors[0]) return preflight.errors[0];
  if (preflight.missing.length) {
    if (preflight.missing.includes("recipient email")) return "Recipient email is missing";
    if (preflight.missing.includes("CourierCloud order link")) return "CourierCloud order link is missing";
    if (preflight.missing.includes("broker email")) return "Broker email is missing";
    if (preflight.missing.includes("subject")) return "Subject is missing";
    if (preflight.missing.includes("body")) return "Body is missing";
    return `Action is missing: ${preflight.missing.join(", ")}`;
  }
  return "";
}

function providedActionCanQueue(actionId, action) {
  if (!actionId || !action || action.id !== actionId) return false;
  if (!/^(?:brain-[a-z0-9]+-|airport-dwell-[a-z0-9]+-)/i.test(actionId)) return false;
  if (action.status && !["suggested", "validated"].includes(String(action.status).toLowerCase())) return false;
  if (!/(?:Brain-proposed action|Operator must preview and approve)/i.test(String(action.safety?.note || ""))) return false;
  const validationError = validateDraftableAction(actionId, action);
  return !validationError;
}

function publicOutboxRequest(action, now, draftPlan, agentJob = null) {
  const tmsAction = isTmsChannel(action.channel);
  return {
    id: draftPlan.payload.outboxRequestId,
    actionId: action.id,
    shipmentId: action.shipmentId,
    awb: action.awb,
    type: action.type || "",
    label: action.label || "",
    channel: draftPlan.publicChannel,
    originalChannel: draftPlan.payload.originalChannel,
    originalExecution: draftPlan.payload.originalExecution,
    execution: draftPlan.publicExecution,
    priority: action.priority || "normal",
    status: "queued",
    queuedAt: agentJob?.created_at || now,
    agentJobId: agentJob?.id || null,
    targetName: draftPlan.publicTargetName,
    to: draftPlan.publicTargetEmail,
    cc: draftPlan.payload.cc || "",
    bcc: draftPlan.payload.bcc || "",
    originalTargetName: draftPlan.payload.originalTargetName || "",
    originalTargetEmail: draftPlan.payload.originalTargetEmail || "",
    stationContactMissing: Boolean(draftPlan.payload.stationContactMissing),
    subject: draftPlan.payload.subject,
    body: draftPlan.payload.body,
    replyMessageId: draftPlan.payload.replyMessageId || "",
    conversation: draftPlan.payload.conversation || null,
    documentIntent: draftPlan.payload.documentIntent || null,
    attachmentIntent: draftPlan.payload.attachmentIntent || null,
    attachmentIntents: draftPlan.payload.attachmentIntents || [],
    attachments: draftPlan.payload.attachments || [],
    timing: draftPlan.payload.timing || null,
    orderLink: action.orderLink || "",
    reason: action.reason || "",
    autonomy: draftPlan.payload.autonomy || autonomyForChannel(draftPlan.payload.originalChannel),
    safety: draftPlan.safety,
    betaContract: draftPlan.payload.betaContract || (tmsAction ? tmsOperatorApprovalContract() : betaDraftModeContract()),
    tmsIntent: draftPlan.payload.tmsIntent || null,
  };
}

module.exports = {
  actionFromOutboxRequest,
  actionWithOperatorDraftOverrides,
  actionPreflight,
  actionIntentKey,
  actionThreadPolicy,
  autonomyForChannel,
  autonomyForInternalAction,
  betaDraftModeContract,
  DEFAULT_TMS_REVIEW_EMAIL,
  draftIntentKey,
  draftPayloadForAction,
  isPlatformChannel,
  isTmsChannel,
  normalizedAutonomyForChannel,
  normalizedSafetyForChannel,
  operatorApprovedInternalContract,
  providedActionCanQueue,
  publicOutboxRequest,
  safetyForChannel,
  safetyForInternalAction,
  tmsExperienceEmail,
  tmsOperatorApprovalContract,
  validateDraftableAction,
};

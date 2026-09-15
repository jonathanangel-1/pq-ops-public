"use strict";

// Platform-native executable action layer: every ACTIVE shipment carries ONE primary
// action object the operator can execute from the platform — never advice text.
// The object wraps the canonical planner's stamped action (which already carries the
// draft-only outbox contract: id/type/channel/targetEmail/subject/body/autonomy/safety)
// and adds the platform schema: actionType, targetRole, script, whyNow, expectedProof,
// missingFields, safeStatus, controls, recordResult.

const { buildCanonicalActionPlan } = require("./action-planner");
const { normalizeAwb } = require("./awb");

const PLATFORM_ACTION_SCHEMA = "platform-action-v1";

const ACTION_TYPES = [
  "draft_email",
  "call_contact",
  "request_missing_contact",
  "upload_send_doc",
  "pay_reconcile_fee",
  "confirm_pickup",
  "request_pod",
  "wait_until_checkpoint",
  "closeout",
];

const TARGET_ROLES = ["customs-broker", "pickup-broker", "station", "customer", "internal-operator"];

// Actions whose whole point is capturing a missing relationship/contact.
const MISSING_CONTACT_TYPE_RE = /contact-research|relationship-missing|relationship-check|release-contact-gap|pickup-owner-missing|contact-gap|source-backfill/i;
const DOC_TYPE_RE = /awb-copy|docs?-reply|delivery-order|release-package|document|pickup-docs/i;
const FEE_TYPE_RE = /fee|storage-cost|cargosprint|payment/i;
const PICKUP_TYPE_RE = /pickup-execution|broker-award|quote-decision|dispatch|inbound-alert/i;
const POD_TYPE_RE = /pod-followup|pod-request|proof-of-delivery|delivery-status/i;
const WAIT_TYPE_RE = /scheduled-followup|wait|deferred/i;
const CLOSEOUT_TYPE_RE = /closeout|complete|archive/i;

function platformActionTypeFor(action = {}) {
  const type = String(action.type || "");
  const label = `${type} ${action.label || ""} ${action.timing?.stage || ""}`;
  if (MISSING_CONTACT_TYPE_RE.test(label)) return "request_missing_contact";
  if (CLOSEOUT_TYPE_RE.test(label)) return "closeout";
  if (POD_TYPE_RE.test(label)) return "request_pod";
  if (FEE_TYPE_RE.test(label)) return "pay_reconcile_fee";
  if (PICKUP_TYPE_RE.test(label)) return "confirm_pickup";
  if (DOC_TYPE_RE.test(label)) return "upload_send_doc";
  if (WAIT_TYPE_RE.test(label)) return "wait_until_checkpoint";
  if (/operator-state-check|operator-ping|state-check/i.test(label)) return "wait_until_checkpoint";
  if (String(action.channel || "") === "phone") return "call_contact";
  if (String(action.execution || "").includes("draft") || String(action.channel || "") === "gmail") return "draft_email";
  return "draft_email";
}

function targetRoleFor(action = {}, platformActionType = "") {
  const text = `${action.type || ""} ${action.label || ""} ${action.workstream || ""} ${action.timing?.stage || ""}`.toLowerCase();
  if (platformActionType === "closeout" || platformActionType === "wait_until_checkpoint" || /operator-state-check|operator-ping|internal|quote-decision|approval-needed/.test(text)) return "internal-operator";
  if (/customs|release|clearance|inbond|entry/.test(text)) return "customs-broker";
  if (["confirm_pickup", "request_pod"].includes(platformActionType)) return "pickup-broker";
  if (/pickup|award|quote|dispatch|cartage|trucker|pod|delivery/.test(text)) return "pickup-broker";
  if (/station|arrival|on[-\s]?hand|airport|terminal|fee|storage/.test(text)) return "station";
  if (/customer|consignee|client|duty approval/.test(text)) return "customer";
  if (["pay_reconcile_fee"].includes(platformActionType)) return "station";
  // A draft with a live recipient goes to an external counterparty, not ourselves.
  if (platformActionType === "draft_email" && /@/.test(String(action.targetEmail || ""))) return "station";
  return "internal-operator";
}

function missingFieldsFor(action = {}, platformActionType = "") {
  const missing = [];
  const email = String(action.targetEmail || "").trim();
  const phone = String(action.targetPhone || action.phone || "").trim();
  if (platformActionType === "request_missing_contact") {
    const roleWord = targetRoleFor(action, platformActionType).replace(/-/g, " ");
    missing.push(`${roleWord} email`);
    return missing;
  }
  if (platformActionType === "call_contact" && !phone) missing.push("contact phone number");
  const targetRole = targetRoleFor(action, platformActionType);
  // Internal decisions execute in-platform (record the result) — no recipient needed.
  const emailNeeded = targetRole !== "internal-operator" &&
    ["draft_email", "upload_send_doc", "request_pod", "confirm_pickup", "pay_reconcile_fee"].includes(platformActionType);
  if (emailNeeded && !/@/.test(email)) missing.push(`${targetRole.replace(/-/g, " ")} email`);
  if (String(action.threadPolicy || "") === "reply_existing" &&
    !(action.replyMessageId || action.conversation?.threadId || action.threadId)) {
    missing.push("source thread id");
  }
  return missing;
}

function safeStatusFor(action = {}, platformActionType = "", missingFields = [], targetRole = "") {
  if (action.blockedReason) return "blocked";
  if (missingFields.length) return "needs_missing_info";
  if (targetRole !== "internal-operator" &&
    ["draft_email", "upload_send_doc", "request_pod", "confirm_pickup", "pay_reconcile_fee"].includes(platformActionType)) {
    // Email-channel actions are always draft-only in beta: never sent without approval.
    return "draft_only";
  }
  return "ready";
}

function controlsFor(platformActionType = "", safeStatus = "") {
  if (safeStatus === "needs_missing_info") return ["add_missing_info", "record_result"];
  if (platformActionType === "call_contact") return ["call", "record_result"];
  if (platformActionType === "closeout") return ["close", "record_result"];
  if (platformActionType === "wait_until_checkpoint") return ["record_result"];
  if (platformActionType === "request_missing_contact") return ["add_missing_info", "record_result"];
  return ["draft", "record_result"];
}

function scriptFor(action = {}, platformActionType = "") {
  if (platformActionType === "call_contact") {
    return {
      phonePrompt: action.body || action.reason || action.nextAction ||
        `Call ${action.targetName || "the contact"} about AWB ${action.awb}: ${action.label || ""}`.trim(),
    };
  }
  if (["request_missing_contact"].includes(platformActionType)) {
    return {
      formPrompt: action.reason || action.label ||
        "Enter the missing contact (name + email) so this action can be drafted.",
    };
  }
  return {
    subject: action.subject || "",
    body: action.body || "",
  };
}

function recordResultFor(action = {}) {
  const common = {
    schemaVersion: "operator-browser-truth-command-v1",
    factContract: "structured command -> operator event -> source observation -> candidate accept/review -> canonical publication",
    requires: ["phone contact", "contact organization", "occurredAt", "stable idempotency key"],
  };
  if (action.type === "station-fee-confirmation") {
    return {
      ...common,
      status: "structured-phone-truth",
      endpoint: "/api/truth/operator-browser-event",
      options: [
        { value: "paid", label: "Paid / confirmed", command: "station_fees_paid" },
        { value: "not-blocking", label: "Not blocking pickup", command: "station_fees_none_due" },
        { value: "due", label: "Still due", command: "station_fees_due" },
      ],
    };
  }
  if (action.type === "operator-state-check") {
    const commandByOutcome = {
      "picked-up": "pickup_completed",
      "out-for-delivery": "out_for_delivery",
      "delivered-pod-pending": "delivery_completed_pod_pending",
      "delivered-with-pod": "delivery_completed_with_pod",
      "still-waiting-station": "pickup_not_completed",
    };
    const options = (Array.isArray(action.operatorOutcomeOptions) ? action.operatorOutcomeOptions : [])
      .map((option) => ({
        value: String(option?.value || ""),
        label: String(option?.label || option?.value || ""),
        command: commandByOutcome[option?.value] || "",
        recordable: Boolean(commandByOutcome[option?.value]),
      }));
    const recordable = options.some((option) => option.recordable);
    return {
      ...common,
      status: recordable ? "structured-phone-truth" : "review-only",
      endpoint: recordable ? "/api/truth/operator-browser-event" : "",
      options,
      reason: recordable
        ? "Only options carrying a command may be recorded as canonical evidence."
        : "No current outcome maps to a supported shipment predicate.",
    };
  }
  return {
    ...common,
    status: "review-only",
    endpoint: "",
    options: [],
    reason: "This action result is not a supported shipment fact; use a protected non-canonical decision/review ledger when available.",
  };
}

function platformExecutableAction(action, shipment = {}) {
  if (!action) return null;
  const platformActionType = platformActionTypeFor(action);
  const targetRole = targetRoleFor(action, platformActionType);
  const missingFields = missingFieldsFor(action, platformActionType);
  const safeStatus = safeStatusFor(action, platformActionType, missingFields, targetRole);
  return {
    // The stamped planner action rides along untouched: the existing Preview/Draft
    // pipeline (POST /api/actions/send) consumes it verbatim.
    ...action,
    platform: {
      schema: PLATFORM_ACTION_SCHEMA,
      actionType: platformActionType,
      targetRole,
      targetName: action.targetName || "",
      targetCompany: action.targetCompany || action.broker || "",
      targetEmail: action.targetEmail || "",
      targetPhone: action.targetPhone || action.phone || "",
      replyThreadId: action.conversation?.threadId || action.threadId || "",
      replyMessageId: action.replyMessageId || action.messageId || "",
      script: scriptFor(action, platformActionType),
      whyNow: action.reason || action.nextAction || "",
      expectedProof: action.postActionExpectedFact || "",
      missingFields,
      safeStatus,
      controls: controlsFor(platformActionType, safeStatus),
      recordResult: recordResultFor(action),
      awb: action.awb || shipment.awb || "",
    },
  };
}

// Attach ONE primary executable action to every ACTIVE shipment row. Rows that already
// carry a canonical plan (candidateActions) reuse it; otherwise the plan derives here.
function attachPrimaryPlatformActions(shipments = [], context = {}) {
  return (shipments || []).map((shipment) => {
    const role = String(shipment?.truthPacketRole || "active").toLowerCase();
    if (role !== "active") return shipment;
    try {
      const candidates = Array.isArray(shipment.recommendedActions) ? shipment.recommendedActions : [];
      const plan = buildCanonicalActionPlan(shipment, candidates, context);
      const primary = platformExecutableAction(plan.primaryAction, shipment);
      if (!primary) return shipment;
      return { ...shipment, primaryAction: primary };
    } catch (error) {
      return {
        ...shipment,
        primaryAction: {
          platform: {
            schema: PLATFORM_ACTION_SCHEMA,
            actionType: "request_missing_contact",
            targetRole: "internal-operator",
            script: { formPrompt: `Action derivation failed (${error?.message || error}); review the shipment and record the operator move.` },
            whyNow: "The planner could not derive an executable action from current truth.",
            expectedProof: "An operator-recorded fact resolving the derivation gap.",
            missingFields: ["operator review"],
            safeStatus: "needs_missing_info",
            controls: ["record_result"],
            recordResult: recordResultFor({}),
            awb: shipment.awb || "",
          },
        },
      };
    }
  });
}

module.exports = {
  PLATFORM_ACTION_SCHEMA,
  ACTION_TYPES,
  TARGET_ROLES,
  platformExecutableAction,
  attachPrimaryPlatformActions,
  _test: { platformActionTypeFor, targetRoleFor, missingFieldsFor, safeStatusFor, controlsFor, recordResultFor },
};

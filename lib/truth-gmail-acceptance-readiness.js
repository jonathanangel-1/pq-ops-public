"use strict";

// Hosted acceptance coordinator (layer-1, the last spine organ).
//
// Live batches seal their candidate frontiers, then wait: acceptance epochs
// only ever ran through the operator slice. This coordinator hosts that step.
// Per orchestrator round it reads the acceptance-readiness frontier and, for
// each ready batch, runs the canonical acceptance epoch through the existing
// designed RPC. Busy (cut-serialization advisory-lock collisions with cron
// writers) and not-ready receipts are recorded skips — the next round simply
// retries. Review-gated candidates queue reviews; nothing is auto-accepted
// beyond what the acceptance policy already allows. Mirrors
// truth-gmail-claims-readiness.js; scored by its own fixture verifier.

const RECONCILE_RPC = "reconcile_truth_gmail_claim_defects";
const FRONTIER_RPC = "read_gmail_acceptance_readiness_frontier";
const ACCEPTANCE_RPC = "run_truth_shadow_claim_acceptance_epoch";
const COORDINATOR_VERSION = "truth-gmail-acceptance-readiness-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBLIGATION_RE = /^pending-acceptance-epoch:v1:[0-9a-f]{64}$/;

class TruthGmailAcceptanceReadinessError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthGmailAcceptanceReadinessError";
    Object.assign(this, fields);
  }
}

function invalid(field, reason) {
  return new TruthGmailAcceptanceReadinessError(
    `Invalid acceptance-readiness argument ${field}: ${reason}`,
    { code: "TRUTH_GMAIL_ACCEPTANCE_READINESS_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, field, { maxBytes = 4096 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function integer(value, field, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function normalizeFrontier(value) {
  if (!isPlainObject(value) || value.ok !== true || !Array.isArray(value.batches)
      || value.productionPublicationAttempted !== false) {
    throw new TruthGmailAcceptanceReadinessError(
      "acceptance-readiness frontier returned an invalid receipt",
      { code: "TRUTH_GMAIL_ACCEPTANCE_READINESS_FRONTIER_INVALID" },
    );
  }
  return value.batches.map((batch, index) => {
    if (!isPlainObject(batch) || !UUID_RE.test(String(batch.rootBatchId || ""))) {
      throw invalid(`frontier.batches[${index}]`, "must carry a UUID rootBatchId");
    }
    if (batch.obligationId !== null && batch.obligationId !== undefined
        && !OBLIGATION_RE.test(String(batch.obligationId))) {
      throw invalid(`frontier.batches[${index}].obligationId`, "must be a pending-acceptance-epoch identity or null");
    }
    return {
      rootBatchId: String(batch.rootBatchId),
      obligationId: typeof batch.obligationId === "string" ? batch.obligationId : null,
      acceptanceComplete: batch.acceptanceComplete === true,
      readyToRun: batch.readyToRun === true,
    };
  });
}

function normalizeReconciliation(value) {
  if (!isPlainObject(value) || value.ok !== true
      || !Number.isSafeInteger(value.reconciledCount) || value.reconciledCount < 0
      || !Array.isArray(value.items)
      || value.items.length !== value.reconciledCount
      || value.productionPublicationAttempted !== false) {
    throw new TruthGmailAcceptanceReadinessError(
      "claim-defect reconciliation returned an invalid receipt",
      { code: "TRUTH_GMAIL_CLAIM_DEFECT_RECONCILIATION_INVALID" },
    );
  }
  return value.items.map((item, index) => {
    if (!isPlainObject(item) || !UUID_RE.test(String(item.rootBatchId || ""))
        || !["pending_epoch_zero_candidate", "late_absence_membership"].includes(
          String(item.disposition || ""),
        )) {
      throw invalid(`reconciliation.items[${index}]`, "must carry an exact batch and disposition");
    }
    return Object.freeze({
      rootBatchId: String(item.rootBatchId),
      disposition: String(item.disposition),
    });
  });
}

function createGmailAcceptanceReadinessCoordinator(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey, "workspaceKey", { maxBytes: 128 });
  const connectionKey = text(options.connectionKey, "connectionKey", { maxBytes: 256 });
  const syncToken = text(options.syncToken, "syncToken");
  const callRpc = options.callRpc;
  if (typeof callRpc !== "function") {
    throw invalid("callRpc", "must be an explicitly injected function; no live fallback exists");
  }
  const batchLimit = integer(options.batchLimit, "batchLimit", 3, 1, 10);

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalid("runOnce", "must be an object");
    const rpcOptions = {};
    if (input.signal) rpcOptions.signal = input.signal;
    if (input.deadlineAtMs !== undefined) rpcOptions.deadlineAtMs = input.deadlineAtMs;

    const reconciliation = normalizeReconciliation(await callRpc(RECONCILE_RPC, {
      p_workspace_key: workspaceKey,
      p_connection_key: connectionKey,
      p_limit: batchLimit,
      p_sync_token: syncToken,
    }, rpcOptions));

    const frontier = normalizeFrontier(await callRpc(FRONTIER_RPC, {
      p_workspace_key: workspaceKey,
      p_connection_key: connectionKey,
      p_limit: batchLimit,
      p_sync_token: syncToken,
    }, rpcOptions));

    const actions = reconciliation.map((item) => ({
      rootBatchId: item.rootBatchId,
      step: "claim_defect_reconcile",
      disposition: item.disposition,
    }));
    const skips = [];
    const failures = [];

    for (const batch of frontier) {
      try {
        if (batch.acceptanceComplete) {
          skips.push({ rootBatchId: batch.rootBatchId, reasonCode: "ALREADY_ACCEPTED" });
          continue;
        }
        if (!batch.readyToRun || !batch.obligationId) {
          skips.push({ rootBatchId: batch.rootBatchId, reasonCode: "NOT_READY" });
          continue;
        }
        const receipt = await callRpc(ACCEPTANCE_RPC, {
          p_workspace_key: workspaceKey,
          p_obligation_id: batch.obligationId,
          p_sync_token: syncToken,
        }, rpcOptions);
        if (isPlainObject(receipt) && receipt.status === "succeeded") {
          if (receipt.productionPublicationAttempted !== false) {
            throw new TruthGmailAcceptanceReadinessError(
              "acceptance epoch violated the publication contract",
              { code: "TRUTH_GMAIL_ACCEPTANCE_PUBLICATION_CONTRACT_VIOLATED" },
            );
          }
          actions.push({
            rootBatchId: batch.rootBatchId,
            obligationId: batch.obligationId,
            acceptedCount: Number(receipt.acceptedCount ?? 0),
            rejectedCount: Number(receipt.rejectedCount ?? 0),
            reviewCount: Number(receipt.reviewCount ?? 0),
          });
        } else if (isPlainObject(receipt) && receipt.status === "busy") {
          skips.push({ rootBatchId: batch.rootBatchId, reasonCode: "SERIALIZATION_BUSY" });
        } else {
          skips.push({
            rootBatchId: batch.rootBatchId,
            reasonCode: String(receipt?.reasonCode || receipt?.reason || receipt?.status || "NOT_READY").slice(0, 100),
          });
        }
      } catch (error) {
        failures.push({
          rootBatchId: batch.rootBatchId,
          errorCode: String(error?.code || "TRUTH_GMAIL_ACCEPTANCE_STEP_FAILED"),
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }

    return Object.freeze({
      coordinatorVersion: COORDINATOR_VERSION,
      workspaceKey,
      connectionKey,
      frontierCount: frontier.length,
      claimedCount: actions.length,
      succeededCount: actions.length,
      failedCount: failures.length,
      hardFailedCount: 0,
      actions: Object.freeze(actions),
      skips: Object.freeze(skips),
      failures: Object.freeze(failures),
      drained: actions.length === 0,
      mutatesOperationalState: false,
      publishesTruth: false,
      productionPublicationAttempted: false,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = {
  createGmailAcceptanceReadinessCoordinator,
  RECONCILE_RPC,
  FRONTIER_RPC,
  ACCEPTANCE_RPC,
};

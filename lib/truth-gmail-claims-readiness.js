"use strict";

// Hosted claims-readiness coordinator (layer-1 spine, task: cutover).
//
// Live Gmail batches commit every tick, but downstream claim work is gated:
// gmail_resolve_entity_links jobs need a link-epoch membership row, and
// gmail_extract_message_claims jobs need a SEALED link epoch for their root
// batch. During commissioning those steps ran only in the operator slice; this
// coordinator hosts them. Per tick it walks the readiness frontier and, per
// batch, advances exactly one designed step through existing public RPCs:
//
//   parse checkpoint (ensure_gmail_parse_checkpoint)
//     -> link epoch open (open_truth_gmail_link_epoch)
//       -> [link workers drain in the same orchestrator rounds]
//         -> link epoch seal (seal_truth_gmail_link_epoch)
//
// The frontier itself comes from read_gmail_claims_readiness_frontier — a
// read-only RPC whose contract is declared here and installed by the spine
// migration. Every mutation is a designed authority with its own guards; this
// module sequences, it never asserts. Refusals (not_ready checkpoints, seal
// preconditions unmet) are recorded skips, not failures: the next tick simply
// tries again. Shaped as a worker so the orchestrator's drain loop runs it
// each round — an epoch opened in round N unlocks link jobs that round N+1
// workers drain, and the seal follows in the round after.

const FRONTIER_RPC = "read_gmail_claims_readiness_frontier";
const RECONCILE_RPC = "reconcile_truth_gmail_dead_link_members";
const CHECKPOINT_RPC = "ensure_gmail_parse_checkpoint";
const EPOCH_OPEN_RPC = "open_truth_gmail_link_epoch";
const EPOCH_SEAL_RPC = "seal_truth_gmail_link_epoch";
const COORDINATOR_VERSION = "truth-gmail-claims-readiness-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKPOINT_RE = /^gmail-parse-checkpoint:v1:([0-9a-f]{64})$/;

class TruthGmailClaimsReadinessError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthGmailClaimsReadinessError";
    Object.assign(this, fields);
  }
}

function invalid(field, reason) {
  return new TruthGmailClaimsReadinessError(
    `Invalid claims-readiness argument ${field}: ${reason}`,
    { code: "TRUTH_GMAIL_CLAIMS_READINESS_INVALID_ARGUMENT", field },
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
    throw new TruthGmailClaimsReadinessError(
      "claims-readiness frontier returned an invalid receipt",
      { code: "TRUTH_GMAIL_CLAIMS_READINESS_FRONTIER_INVALID" },
    );
  }
  return value.batches.map((batch, index) => {
    if (!isPlainObject(batch) || !UUID_RE.test(String(batch.rootBatchId || ""))
        || typeof batch.checkpointPresent !== "boolean"
        || (batch.checkpointReady === true && batch.checkpointPresent !== true)) {
      throw invalid(
        `frontier.batches[${index}]`,
        "must carry a UUID rootBatchId and coherent checkpoint-presence booleans",
      );
    }
    return {
      rootBatchId: String(batch.rootBatchId),
      checkpointPresent: batch.checkpointPresent === true,
      checkpointReady: batch.checkpointReady === true,
      epochId: typeof batch.epochId === "string" && batch.epochId ? batch.epochId : null,
      epochSealed: batch.epochSealed === true,
      readyToSeal: batch.readyToSeal === true,
    };
  });
}

function normalizeCheckpoint(value) {
  if (!isPlainObject(value) || !["ready", "not_ready"].includes(String(value.status || ""))) {
    throw new TruthGmailClaimsReadinessError(
      "parse-checkpoint authority returned an invalid receipt",
      { code: "TRUTH_GMAIL_CLAIMS_READINESS_CHECKPOINT_INVALID" },
    );
  }
  if (value.status === "ready") {
    const match = String(value.checkpointId || "").match(CHECKPOINT_RE);
    if (!match || match[1] !== String(value.checkpointHash || "")) {
      throw new TruthGmailClaimsReadinessError(
        "parse-checkpoint authority returned a mismatched checkpoint identity",
        { code: "TRUTH_GMAIL_CLAIMS_READINESS_CHECKPOINT_INVALID" },
      );
    }
  }
  return value;
}

function normalizeReconciliation(value) {
  if (!isPlainObject(value) || value.ok !== true
      || !Number.isSafeInteger(value.reconciledCount) || value.reconciledCount < 0
      || !Array.isArray(value.items)
      || value.items.length !== value.reconciledCount
      || value.productionPublicationAttempted !== false) {
    throw new TruthGmailClaimsReadinessError(
      "dead-link reconciliation returned an invalid receipt",
      { code: "TRUTH_GMAIL_DEAD_LINK_RECONCILIATION_INVALID" },
    );
  }
  return value.items.map((item, index) => {
    if (!isPlainObject(item) || !UUID_RE.test(String(item.rootBatchId || ""))
        || !["durable_resolution_acknowledged", "missing_anchor_excluded"].includes(
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

function createGmailClaimsReadinessCoordinator(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey, "workspaceKey", { maxBytes: 128 });
  const connectionKey = text(options.connectionKey, "connectionKey", { maxBytes: 256 });
  const syncToken = text(options.syncToken, "syncToken");
  const callRpc = options.callRpc;
  if (typeof callRpc !== "function") {
    throw invalid("callRpc", "must be an explicitly injected function; no live fallback exists");
  }
  const batchLimit = integer(options.batchLimit, "batchLimit", 5, 1, 25);
  const checkpointMaxBatches = integer(options.checkpointMaxBatches, "checkpointMaxBatches", 10, 1, 100);

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalid("runOnce", "must be an object");
    const rpcOptions = {};
    if (input.signal) rpcOptions.signal = input.signal;
    if (input.deadlineAtMs !== undefined) rpcOptions.deadlineAtMs = input.deadlineAtMs;

    // Known terminal link-worker defects are reconciled only after normal
    // retry exhaustion and only through immutable, proof-bound receipts. Run
    // that authority before the frontier read so the same coordinator round
    // can observe a newly sealable epoch.
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
      step: "dead_link_reconcile",
      disposition: item.disposition,
    }));
    const skips = [];
    const failures = [];

    for (const batch of frontier) {
      try {
        if (!batch.checkpointReady) {
          if (batch.checkpointPresent) {
            skips.push({
              rootBatchId: batch.rootBatchId,
              step: "checkpoint",
              reasonCode: "CHECKPOINT_TERMINAL_GAPS",
            });
            continue;
          }
          const receipt = normalizeCheckpoint(await callRpc(CHECKPOINT_RPC, {
            p_workspace_key: workspaceKey,
            p_connection_key: connectionKey,
            p_target_batch_id: batch.rootBatchId,
            p_max_batches: checkpointMaxBatches,
            p_sync_token: syncToken,
          }, rpcOptions));
          if (receipt.status === "not_ready") {
            skips.push({ rootBatchId: batch.rootBatchId, step: "checkpoint", reasonCode: String(receipt.reasonCode || "NOT_READY") });
          } else {
            actions.push({ rootBatchId: batch.rootBatchId, step: "checkpoint" });
          }
          continue;
        }
        if (!batch.epochId) {
          await callRpc(EPOCH_OPEN_RPC, {
            p_workspace_key: workspaceKey,
            p_root_batch_id: batch.rootBatchId,
            p_sync_token: syncToken,
          }, rpcOptions);
          actions.push({ rootBatchId: batch.rootBatchId, step: "epoch_open" });
          continue;
        }
        if (!batch.epochSealed) {
          if (!batch.readyToSeal) {
            skips.push({ rootBatchId: batch.rootBatchId, step: "epoch_seal", reasonCode: "LINK_JOBS_NOT_TERMINAL" });
            continue;
          }
          await callRpc(EPOCH_SEAL_RPC, {
            p_workspace_key: workspaceKey,
            p_epoch_id: batch.epochId,
            p_sync_token: syncToken,
          }, rpcOptions);
          actions.push({ rootBatchId: batch.rootBatchId, step: "epoch_seal" });
          continue;
        }
        skips.push({ rootBatchId: batch.rootBatchId, step: "none", reasonCode: "ALREADY_SEALED" });
      } catch (error) {
        failures.push({
          rootBatchId: batch.rootBatchId,
          errorCode: String(error?.code || "TRUTH_GMAIL_CLAIMS_READINESS_STEP_FAILED"),
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }

    // Worker-shaped receipt: claimedCount>0 keeps the orchestrator's drain
    // loop running another round so newly unlocked jobs get processed and the
    // seal step can follow within the same tick.
    return Object.freeze({
      coordinatorVersion: COORDINATOR_VERSION,
      workspaceKey,
      connectionKey,
      frontierCount: frontier.length,
      claimedCount: actions.length + failures.length,
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
  createGmailClaimsReadinessCoordinator,
  RECONCILE_RPC,
  FRONTIER_RPC,
  CHECKPOINT_RPC,
  EPOCH_OPEN_RPC,
  EPOCH_SEAL_RPC,
};

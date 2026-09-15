"use strict";

const FRONTIER_RPC = "read_truth_generic_acceptance_readiness_frontier";
const ACCEPTANCE_RPC = "run_truth_shadow_claim_acceptance_epoch";
const COORDINATOR_VERSION = "truth-generic-acceptance-readiness-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBLIGATION_RE = /^pending-acceptance-epoch:v1:[0-9a-f]{64}$/;
const CONNECTIONS = Object.freeze({
  tms: "couriercloud-ops-tlv-us",
  tracking: "carrier-tracking-primary",
  operator: "operator-phone-primary",
});

class TruthGenericAcceptanceReadinessError extends Error {
  constructor(message, fields = {}) {
    super(message);
    this.name = "TruthGenericAcceptanceReadinessError";
    Object.assign(this, fields);
  }
}

function invalid(field, reason) {
  return new TruthGenericAcceptanceReadinessError(
    `Invalid generic acceptance-readiness argument ${field}: ${reason}`,
    { code: "TRUTH_GENERIC_ACCEPTANCE_READINESS_INVALID_ARGUMENT", field },
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
    throw new TruthGenericAcceptanceReadinessError(
      "generic acceptance-readiness frontier returned an invalid receipt",
      { code: "TRUTH_GENERIC_ACCEPTANCE_READINESS_FRONTIER_INVALID" },
    );
  }
  return value.batches.map((batch, index) => {
    const sourceSystem = String(batch?.sourceSystem || "");
    if (!isPlainObject(batch)
        || !UUID_RE.test(String(batch.rootBatchId || ""))
        || !Object.hasOwn(CONNECTIONS, sourceSystem)
        || batch.connectionKey !== CONNECTIONS[sourceSystem]
        || !Number.isSafeInteger(batch.sourceCursorVersion)
        || batch.sourceCursorVersion < 1
        || !String(batch.sourceCursorValue || "")
        || !OBLIGATION_RE.test(String(batch.obligationId || ""))) {
      throw invalid(`frontier.batches[${index}]`, "must carry an exact registered generic obligation");
    }
    return Object.freeze({
      rootBatchId: String(batch.rootBatchId),
      sourceSystem,
      connectionKey: String(batch.connectionKey),
      sourceCursorVersion: batch.sourceCursorVersion,
      sourceCursorValue: String(batch.sourceCursorValue),
      obligationId: String(batch.obligationId),
      acceptanceComplete: batch.acceptanceComplete === true,
      readyToRun: batch.readyToRun === true,
    });
  });
}

function createGenericAcceptanceReadinessCoordinator(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const workspaceKey = text(options.workspaceKey, "workspaceKey", { maxBytes: 128 });
  const syncToken = text(options.syncToken, "syncToken");
  const callRpc = options.callRpc;
  if (typeof callRpc !== "function") {
    throw invalid("callRpc", "must be an explicitly injected function; no live fallback exists");
  }
  const batchLimit = integer(options.batchLimit, "batchLimit", 6, 1, 25);

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalid("runOnce", "must be an object");
    const rpcOptions = {};
    if (input.signal) rpcOptions.signal = input.signal;
    if (input.deadlineAtMs !== undefined) rpcOptions.deadlineAtMs = input.deadlineAtMs;

    const frontier = normalizeFrontier(await callRpc(FRONTIER_RPC, {
      p_workspace_key: workspaceKey,
      p_limit: batchLimit,
      p_sync_token: syncToken,
    }, rpcOptions));
    const actions = [];
    const skips = [];
    const failures = [];

    for (const batch of frontier) {
      try {
        if (batch.acceptanceComplete) {
          skips.push({ rootBatchId: batch.rootBatchId, reasonCode: "ALREADY_ACCEPTED" });
          continue;
        }
        if (!batch.readyToRun) {
          skips.push({ rootBatchId: batch.rootBatchId, reasonCode: "NOT_READY" });
          continue;
        }
        const receipt = await callRpc(ACCEPTANCE_RPC, {
          p_workspace_key: workspaceKey,
          p_obligation_id: batch.obligationId,
          p_sync_token: syncToken,
        }, rpcOptions);
        if (isPlainObject(receipt) && receipt.status === "succeeded"
            && receipt.productionPublicationAttempted === false) {
          actions.push({
            rootBatchId: batch.rootBatchId,
            sourceSystem: batch.sourceSystem,
            sourceCursorVersion: batch.sourceCursorVersion,
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
            reasonCode: String(
              receipt?.reasonCode || receipt?.reason || receipt?.status || "NOT_READY",
            ).slice(0, 100),
          });
        }
      } catch (error) {
        failures.push({
          rootBatchId: batch.rootBatchId,
          errorCode: String(error?.code || "TRUTH_GENERIC_ACCEPTANCE_STEP_FAILED"),
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }

    return Object.freeze({
      coordinatorVersion: COORDINATOR_VERSION,
      workspaceKey,
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

module.exports = Object.freeze({
  ACCEPTANCE_RPC,
  CONNECTIONS,
  COORDINATOR_VERSION,
  FRONTIER_RPC,
  TruthGenericAcceptanceReadinessError,
  createGenericAcceptanceReadinessCoordinator,
  _test: Object.freeze({
    normalizeFrontier,
  }),
});

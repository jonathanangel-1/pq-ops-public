"use strict";

const crypto = require("node:crypto");
const { createGmailMailboxBackfill } = require("./gmail-mailbox-backfill");

const CONNECTION_PREFIX = "shadow-current-awbs-";
const DEFAULT_METADATA_CONCURRENCY = 8;

class GmailScopedShadowBackfillError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailScopedShadowBackfillError";
    this.code = fields.code || "GMAIL_SCOPED_SHADOW_BACKFILL_FAILED";
    this.field = fields.field || "";
  }
}

function invalid(field, reason) {
  return new GmailScopedShadowBackfillError(
    `Invalid Gmail scoped shadow backfill ${field}: ${reason}`,
    { code: "GMAIL_SCOPED_SHADOW_BACKFILL_INVALID_ARGUMENT", field },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("hashInput", "must not contain non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalize(value[key])]));
  }
  throw invalid("hashInput", "must contain only JSON-compatible values");
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function text(value, field, { maximumBytes = 256 } = {}) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalid(field, "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw invalid(field, `must contain at most ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function normalizeAwb(value, field) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(digits)) throw invalid(field, "must contain exactly 11 AWB digits");
  return digits;
}

function fixtureScope(fixture) {
  if (!isPlainObject(fixture) || !Array.isArray(fixture.shipments) || !fixture.shipments.length) {
    throw invalid("fixture.shipments", "must be a non-empty array");
  }
  const awbs = [];
  const decisiveReferences = [];
  fixture.shipments.forEach((shipment, shipmentIndex) => {
    if (!isPlainObject(shipment)) throw invalid(`fixture.shipments[${shipmentIndex}]`, "must be an object");
    const awb = normalizeAwb(shipment.awb, `fixture.shipments[${shipmentIndex}].awb`);
    const evidence = shipment.decisiveEvidence;
    if (!Array.isArray(evidence) || !evidence.length) {
      throw invalid(`fixture.shipments[${shipmentIndex}].decisiveEvidence`, "must be a non-empty array");
    }
    awbs.push(awb);
    evidence.forEach((reference, referenceIndex) => {
      if (!isPlainObject(reference)) {
        throw invalid(
          `fixture.shipments[${shipmentIndex}].decisiveEvidence[${referenceIndex}]`,
          "must be an object",
        );
      }
      const messageId = text(
        reference.messageId,
        `fixture.shipments[${shipmentIndex}].decisiveEvidence[${referenceIndex}].messageId`,
        { maximumBytes: 128 },
      );
      decisiveReferences.push({ awb, messageId });
    });
  });
  if (new Set(awbs).size !== awbs.length) throw invalid("fixture.shipments", "must not repeat an AWB");
  const messageIds = [...new Set(decisiveReferences.map((item) => item.messageId))].sort();
  const sortedAwbs = [...awbs].sort();
  const sortedReferences = [...decisiveReferences].sort((left, right) => (
    left.awb.localeCompare(right.awb) || left.messageId.localeCompare(right.messageId)
  ));
  return Object.freeze({
    shipmentCount: sortedAwbs.length,
    decisiveReferenceCount: sortedReferences.length,
    messageCount: messageIds.length,
    awbs: Object.freeze(sortedAwbs),
    decisiveReferences: Object.freeze(sortedReferences),
    messageIds: Object.freeze(messageIds),
    fixtureManifestHash: sha256Json(fixture),
    awbManifestHash: sha256Json(sortedAwbs),
    decisiveReferenceManifestHash: sha256Json(sortedReferences),
    messageIdManifestHash: sha256Json(messageIds),
  });
}

function requireDependency(object, field, methods) {
  if (!object || typeof object !== "object") throw invalid(field, "must be an object");
  for (const method of methods) {
    if (typeof object[method] !== "function") throw invalid(`${field}.${method}`, "must be a function");
  }
}

async function resolveMessageCoordinates({ gmailClient, messageIds, concurrency }) {
  const coordinates = new Array(messageIds.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= messageIds.length) return;
      const expectedId = messageIds[index];
      let metadata;
      try {
        metadata = await gmailClient.getMessageMetadata(expectedId, { metadataHeaders: [] });
      } catch (cause) {
        throw new GmailScopedShadowBackfillError("A decisive Gmail message could not be resolved", {
          code: "GMAIL_SCOPED_SHADOW_MESSAGE_UNAVAILABLE",
          field: `messageIds[${index}]`,
          cause,
        });
      }
      if (!isPlainObject(metadata) || String(metadata.id || "") !== expectedId) {
        throw new GmailScopedShadowBackfillError("Gmail returned the wrong decisive message coordinate", {
          code: "GMAIL_SCOPED_SHADOW_MESSAGE_COORDINATE_MISMATCH",
          field: `messageIds[${index}]`,
        });
      }
      const threadId = text(metadata.threadId, `metadata[${index}].threadId`, { maximumBytes: 128 });
      const sizeEstimate = Number(metadata.sizeEstimate || 0);
      if (!Number.isSafeInteger(sizeEstimate) || sizeEstimate < 0) {
        throw invalid(`metadata[${index}].sizeEstimate`, "must be a non-negative safe integer");
      }
      coordinates[index] = Object.freeze({ id: expectedId, threadId, sizeEstimate });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, messageIds.length) }, worker));
  return Object.freeze(coordinates);
}

function scopedDiscoveryClient(gmailClient, profile, coordinates) {
  let listed = false;
  return Object.freeze({
    async getProfile() {
      return profile;
    },
    async listMessages(input = {}) {
      if (listed) {
        throw new GmailScopedShadowBackfillError("Exact-message discovery attempted a second page", {
          code: "GMAIL_SCOPED_SHADOW_MULTIPAGE_FORBIDDEN",
        });
      }
      if (input.pageToken || input.q || input.labelIds) {
        throw new GmailScopedShadowBackfillError("Exact-message discovery attempted an unapproved mailbox scope", {
          code: "GMAIL_SCOPED_SHADOW_SCOPE_ESCAPE",
        });
      }
      if (Number(input.maxResults || 0) < coordinates.length) {
        throw invalid("backfill.maxResults", "must fit the complete exact-message manifest in one final page");
      }
      listed = true;
      return {
        messages: coordinates.map(({ id, threadId }) => ({ id, threadId })),
        nextPageToken: "",
        resultSizeEstimate: coordinates.length,
      };
    },
  });
}

async function runGmailScopedShadowBackfill(input = {}) {
  if (!isPlainObject(input)) throw invalid("input", "must be an object");
  if (input.modelRuntimeEnabled !== false) {
    throw invalid("modelRuntimeEnabled", "must be exactly false");
  }
  const fixture = input.fixture;
  const gmailClient = input.gmailClient;
  const ledger = input.ledger;
  requireDependency(gmailClient, "gmailClient", ["getMessageMetadata", "getProfile"]);
  requireDependency(ledger, "ledger", ["acquireLease", "renewLease", "beginBatch", "appendPage", "commitBatch"]);
  const scope = fixtureScope(fixture);
  const expectedShipmentCount = integer(
    input.expectedShipmentCount ?? scope.shipmentCount,
    "expectedShipmentCount",
    1,
    500,
  );
  if (scope.shipmentCount !== expectedShipmentCount) {
    throw invalid("fixture.shipments", `must contain exactly ${expectedShipmentCount} shipments`);
  }
  const connectionKey = text(input.connectionKey, "connectionKey", { maximumBytes: 128 });
  if (!connectionKey.startsWith(CONNECTION_PREFIX) || connectionKey === "primary") {
    throw invalid("connectionKey", `must begin with ${CONNECTION_PREFIX} and must not be canonical`);
  }
  if (!ledger.scope || ledger.scope.workspaceKey !== "primary" || ledger.scope.sourceSystem !== "gmail"
      || ledger.scope.connectionKey !== connectionKey) {
    throw invalid("ledger.scope", "must be the exact primary-workspace noncanonical Gmail slice connection");
  }
  const concurrency = integer(
    input.metadataConcurrency ?? DEFAULT_METADATA_CONCURRENCY,
    "metadataConcurrency",
    1,
    16,
  );
  const ownerId = text(input.ownerId, "ownerId", { maximumBytes: 200 });

  // All live Gmail reads happen before the first ledger lease. A missing or
  // mismatched decisive message cannot leave a partial relational batch.
  const [profile, coordinates] = await Promise.all([
    gmailClient.getProfile(),
    resolveMessageCoordinates({ gmailClient, messageIds: scope.messageIds, concurrency }),
  ]);
  if (!isPlainObject(profile) || !/^\d+$/.test(String(profile.historyId || ""))) {
    throw invalid("gmailProfile.historyId", "must be an exact decimal string");
  }
  const estimatedRawMessageBytes = coordinates.reduce((sum, item) => sum + item.sizeEstimate, 0);
  const providerCoordinates = coordinates.map(({ id, threadId }) => ({ id, threadId }));
  const providerCoordinateManifestHash = sha256Json(providerCoordinates);
  const client = scopedDiscoveryClient(gmailClient, profile, coordinates);
  const backfill = createGmailMailboxBackfill({
    gmailClient: client,
    ledger,
    maxResults: 500,
  });
  const triggerName = `local-exact-message-shadow:${scope.messageIdManifestHash}`;
  const receipt = await backfill.run({
    mode: "backfill",
    ownerId,
    triggerName,
  });
  if (!receipt?.ok || receipt.status !== "committed" || receipt.cursorAdvanced !== true
      || Number(receipt.pageCount) !== 1 || Number(receipt.observationCount) !== scope.messageCount
      || Number(receipt.materializationRoutes?.routeCount) !== scope.messageCount) {
    throw new GmailScopedShadowBackfillError("Exact-message shadow batch did not commit completely", {
      code: "GMAIL_SCOPED_SHADOW_COMMIT_INCOMPLETE",
    });
  }
  return Object.freeze({
    ok: true,
    status: "committed-quarantined-exact-message-slice",
    connectionKey,
    shipmentCount: scope.shipmentCount,
    decisiveReferenceCount: scope.decisiveReferenceCount,
    messageCount: scope.messageCount,
    fixtureManifestHash: scope.fixtureManifestHash,
    awbManifestHash: scope.awbManifestHash,
    decisiveReferenceManifestHash: scope.decisiveReferenceManifestHash,
    messageIdManifestHash: scope.messageIdManifestHash,
    providerCoordinateManifestHash,
    estimatedRawMessageBytes,
    conservativeTripleStorageBytes: estimatedRawMessageBytes * 3,
    backfill: receipt,
    modelRuntimeEnabled: false,
    productionPublicationAttempted: false,
  });
}

module.exports = Object.freeze({
  CONNECTION_PREFIX,
  DEFAULT_METADATA_CONCURRENCY,
  GmailScopedShadowBackfillError,
  fixtureScope,
  runGmailScopedShadowBackfill,
  _test: Object.freeze({ canonicalize, resolveMessageCoordinates, scopedDiscoveryClient, sha256Json }),
});

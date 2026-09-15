"use strict";

const crypto = require("node:crypto");
const { loadAppSnapshot, sendJson } = require("../../lib/supabase-agent");
const { postgresJsonbText } = require("../../lib/postgres-jsonb");
const {
  compactSemanticSnapshot,
  isPlainObject,
} = require("../../lib/truth-production-semantics");
const {
  LEGACY_UNWATERMARKED_STATUS,
  validateProcessingWatermarkFields,
} = require("../../lib/truth-processing-watermark");

const TOKEN_ENV = "PQ_TRUTH_PRODUCTION_WITNESS_TOKEN";
const SNAPSHOT_KEY = "shipment-truth-packets";
const MAX_SHIPMENT_ROWS = 50_000;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
// Stay materially below Vercel's 4.5 MB function body limit. This endpoint is
// an audit protocol, not a second bulk snapshot API.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function bearer(request) {
  const header = String(request?.headers?.authorization || request?.headers?.Authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function secretMatches(actual, expected) {
  if (!TOKEN_RE.test(actual) || !TOKEN_RE.test(expected)) return false;
  const supplied = Buffer.from(actual, "utf8");
  const configured = Buffer.from(expected, "utf8");
  return supplied.length === configured.length && crypto.timingSafeEqual(supplied, configured);
}

function hashJsonb(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(value), "utf8").digest("hex");
}

function deliveryPayloadHash(snapshot) {
  const preimage = { ...snapshot };
  delete preimage.deliveryPayloadHash;
  delete preimage.contentSignature;
  return hashJsonb(preimage);
}

function validateSnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    const error = new Error("Canonical production truth is unavailable");
    error.code = "TRUTH_PRODUCTION_WITNESS_SNAPSHOT_MISSING";
    throw error;
  }
  if (!Array.isArray(snapshot.shipments)) {
    const error = new Error("Canonical production truth has no shipment collection");
    error.code = "TRUTH_PRODUCTION_WITNESS_SHIPMENTS_INVALID";
    throw error;
  }
  if (snapshot.shipments.length > MAX_SHIPMENT_ROWS) {
    const error = new Error("Canonical production truth exceeds the witness row bound");
    error.code = "TRUTH_PRODUCTION_WITNESS_ROW_BOUND_EXCEEDED";
    throw error;
  }
  const sourcePayloadBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  if (sourcePayloadBytes > MAX_SOURCE_BYTES) {
    const error = new Error("Canonical production truth exceeds the internal source-read bound");
    error.code = "TRUTH_PRODUCTION_WITNESS_SOURCE_BOUND_EXCEEDED";
    throw error;
  }
  return { snapshot, sourcePayloadBytes };
}

function productionIdentity(snapshot) {
  const publicationVersion = Number(snapshot.publicationVersion);
  return {
    publicationId: String(snapshot.publicationId || "").trim(),
    publicationVersion: Number.isSafeInteger(publicationVersion) && publicationVersion > 0
      ? publicationVersion
      : null,
    publicationChannel: String(snapshot.publicationChannel || "").trim(),
    sourceCutId: String(snapshot.sourceCutId || "").trim(),
    packetHash: String(snapshot.packetHash || "").trim(),
    deliveryPayloadHash: String(snapshot.deliveryPayloadHash || "").trim(),
    contentSignature: String(snapshot.contentSignature || "").trim(),
    processingWatermarkStatus: snapshot.processingWatermarkStatus ?? null,
    processingWatermark: snapshot.processingWatermark ?? null,
    processingWatermarkHash: snapshot.processingWatermarkHash ?? null,
  };
}

function buildWitness(snapshot, observedAt = new Date().toISOString()) {
  const { sourcePayloadBytes } = validateSnapshot(snapshot);
  const rawIdentity = productionIdentity(snapshot);
  const relationalIdentityPresent = Boolean(rawIdentity.publicationId || rawIdentity.publicationVersion);
  const watermarkFieldNames = [
    "processingWatermarkStatus",
    "processingWatermark",
    "processingWatermarkHash",
  ];
  const suppliedWatermarkFieldCount = watermarkFieldNames.filter((key) => (
    Object.prototype.hasOwnProperty.call(snapshot, key)
  )).length;
  let processingWatermark;
  try {
    if (suppliedWatermarkFieldCount === 0) {
      processingWatermark = Object.freeze({
        status: LEGACY_UNWATERMARKED_STATUS,
        watermark: null,
        watermarkHash: null,
      });
    } else {
      if (suppliedWatermarkFieldCount !== watermarkFieldNames.length) {
        throw new Error("Processing watermark fields must be supplied together");
      }
      processingWatermark = validateProcessingWatermarkFields(rawIdentity, {
        field: "productionSnapshot",
        allowLegacy: true,
      });
      if (!relationalIdentityPresent && processingWatermark.status !== LEGACY_UNWATERMARKED_STATUS) {
        throw new Error("A legacy snapshot cannot claim a certified processing watermark");
      }
    }
  } catch (cause) {
    const error = new Error("Canonical production truth failed processing-watermark validation", { cause });
    error.code = "TRUTH_PRODUCTION_WITNESS_PROCESSING_WATERMARK_INVALID";
    throw error;
  }
  const identity = {
    ...rawIdentity,
    processingWatermarkStatus: processingWatermark.status,
    processingWatermark: processingWatermark.watermark,
    processingWatermarkHash: processingWatermark.watermarkHash,
  };
  const recomputedDeliveryPayloadHash = deliveryPayloadHash(snapshot);
  if (relationalIdentityPresent) {
    const valid = identity.publicationId && identity.publicationVersion &&
      identity.publicationChannel === "production" && identity.sourceCutId &&
      HASH_RE.test(identity.packetHash) && HASH_RE.test(identity.deliveryPayloadHash) &&
      identity.contentSignature === identity.deliveryPayloadHash &&
      recomputedDeliveryPayloadHash === identity.deliveryPayloadHash;
    if (!valid) {
      const error = new Error("Canonical production truth failed relational identity or hash validation");
      error.code = "TRUTH_PRODUCTION_WITNESS_RELATIONAL_HASH_INVALID";
      throw error;
    }
  }

  const semanticSnapshot = compactSemanticSnapshot(snapshot, identity);
  if (semanticSnapshot.malformed.length || semanticSnapshot.duplicates.length) {
    const error = new Error("Canonical production truth contains malformed or duplicate shipment identities");
    error.code = "TRUTH_PRODUCTION_WITNESS_SEMANTIC_IDENTITY_INVALID";
    throw error;
  }
  const semanticWitnessHash = hashJsonb(semanticSnapshot);
  const mode = relationalIdentityPresent
    ? processingWatermark.status === LEGACY_UNWATERMARKED_STATUS
      ? "relational-legacy"
      : "relational"
    : "legacy-shadow";
  const responseBody = {
    ok: true,
    schemaVersion: "production-truth-witness-response-v2",
    snapshotKey: SNAPSHOT_KEY,
    observedAt,
    mode,
    sourceReceipt: {
      schemaVersion: "production-truth-source-receipt-v1",
      sourcePayloadBytes,
      exactSourceSnapshotHash: hashJsonb(snapshot),
      recomputedDeliveryPayloadHash,
      reportedDeliveryPayloadHash: identity.deliveryPayloadHash,
      reportedContentSignature: identity.contentSignature,
      relationalIdentityPresent,
      fullPayloadHashVerifiedAtSource: relationalIdentityPresent,
      ...identity,
    },
    semanticWitnessHash,
    semanticSnapshot,
    counts: {
      shipments: semanticSnapshot.shipments.length,
      activeAwbs: semanticSnapshot.activeAwbs.length,
      completedAwbs: semanticSnapshot.completedAwbs.length,
    },
    mutatesOperationalState: false,
  };
  const responseBytes = Buffer.byteLength(JSON.stringify(responseBody), "utf8");
  if (responseBytes > MAX_RESPONSE_BYTES) {
    const error = new Error("Compact production truth witness exceeds the response bound");
    error.code = "TRUTH_PRODUCTION_WITNESS_RESPONSE_BOUND_EXCEEDED";
    throw error;
  }
  return { responseBody, responseBytes, sourcePayloadBytes };
}

function createProductionWitnessHandler(options = {}) {
  const env = options.env || process.env;
  const loadSnapshot = options.loadSnapshot || loadAppSnapshot;
  const respond = options.sendJson || sendJson;

  return async function productionWitnessHandler(request, response) {
    response.setHeader("cache-control", "private, no-store");
    if (request.method !== "GET") {
      respond(response, 405, {
        ok: false,
        code: "TRUTH_PRODUCTION_WITNESS_METHOD_NOT_ALLOWED",
        error: "Method not allowed",
      });
      return;
    }

    const expectedToken = String(env[TOKEN_ENV] || "");
    if (!TOKEN_RE.test(expectedToken) || !secretMatches(bearer(request), expectedToken)) {
      respond(response, TOKEN_RE.test(expectedToken) ? 401 : 503, {
        ok: false,
        code: TOKEN_RE.test(expectedToken)
          ? "TRUTH_PRODUCTION_WITNESS_UNAUTHORIZED"
          : "TRUTH_PRODUCTION_WITNESS_NOT_CONFIGURED",
        error: TOKEN_RE.test(expectedToken) ? "Unauthorized" : "Production witness access is not configured",
      });
      return;
    }

    try {
      const loaded = await loadSnapshot(SNAPSHOT_KEY, null, {
        timeoutMs: Number(env.PQ_TRUTH_PRODUCTION_WITNESS_LOAD_TIMEOUT_MS || 5000),
        retryDelaysMs: [],
      });
      const { responseBody } = buildWitness(loaded);
      respond(response, 200, responseBody);
    } catch (error) {
      respond(response, 503, {
        ok: false,
        code: String(error?.code || "TRUTH_PRODUCTION_WITNESS_UNAVAILABLE")
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, "_")
          .slice(0, 100),
        error: "Canonical production truth witness is unavailable",
        mutatesOperationalState: false,
      });
    }
  };
}

const handler = createProductionWitnessHandler();

module.exports = handler;
module.exports._test = Object.freeze({
  MAX_SOURCE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SHIPMENT_ROWS,
  SNAPSHOT_KEY,
  TOKEN_ENV,
  TOKEN_RE,
  bearer,
  buildWitness,
  createProductionWitnessHandler,
  deliveryPayloadHash,
  hashJsonb,
  productionIdentity,
  secretMatches,
  validateSnapshot,
});

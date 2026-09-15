#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  MAX_SOURCE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_SHIPMENT_ROWS,
  SNAPSHOT_KEY,
  buildWitness,
  createProductionWitnessHandler,
  deliveryPayloadHash,
} = require("../api/truth/production-witness")._test;
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
} = require("../lib/relational-truth-delivery-adapter");
const { REDUCER_VERSION } = require("../lib/relational-truth-reducer");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const { processingWatermarkFixture } = require("./truth-processing-watermark-fixture");

const TOKEN = "production_witness_token_for_verifier_1234567890";

function responseHarness() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
    end(value) { this.body = String(value || ""); },
    json() { return JSON.parse(this.body); },
  };
}

async function invoke(handler, { method = "GET", token = TOKEN } = {}) {
  const response = responseHarness();
  await handler({ method, headers: { authorization: `Bearer ${token}` } }, response);
  return response;
}

async function main() {
  let loads = 0;
  const legacySnapshot = {
    schemaVersion: "relational-shipment-truth-delivery-v1",
    snapshotTime: "2026-07-09T23:30:00.000Z",
    shipments: [{
      awb: "01680000083",
      order: "ORD-123",
      client: "Example Importer",
      station: "JFK",
      cargo: { pieces: 4, weight: "125 kg" },
      sourceCoverage: {
        shipmentMetadataVersionId: "shipment-metadata:v1:fixture",
        shipmentMetadataObservationId: "observation:v1:fixture",
        shipmentMetadataSnapshotTime: "2026-07-09T23:29:00.000Z",
      },
      currentState: "arrived",
      truthPacket: {
        gates: { arrival: { status: "done" }, customs: { status: "blocked" } },
        contradictions: [{ type: "customs", status: "open" }],
        operationalBlocker: { type: "customs_hold", status: "open" },
      },
    }],
    activeAwbs: ["01680000083"],
    completedAwbs: [],
  };
  const handler = createProductionWitnessHandler({
    env: { PQ_TRUTH_PRODUCTION_WITNESS_TOKEN: TOKEN },
    async loadSnapshot(key, fallback, options) {
      loads += 1;
      assert.equal(key, SNAPSHOT_KEY);
      assert.equal(fallback, null);
      assert.deepEqual(options.retryDelaysMs, []);
      return legacySnapshot;
    },
  });

  let response = await invoke(handler);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  const legacyBody = response.json();
  assert.equal(legacyBody.schemaVersion, "production-truth-witness-response-v2");
  assert.equal(legacyBody.mode, "legacy-shadow");
  assert.equal(legacyBody.sourceReceipt.processingWatermarkStatus, "legacy_unwatermarked");
  assert.equal(legacyBody.semanticSnapshot.processingWatermarkStatus, "legacy_unwatermarked");
  assert.equal(legacyBody.semanticSnapshot.processingWatermarkHash, null);
  assert.equal(legacyBody.semanticSnapshot.shipments[0].awb, "01680000083");
  assert.equal(legacyBody.semanticSnapshot.shipments[0].lifecycle, "arrived");
  assert.equal(legacyBody.semanticSnapshot.shipments[0].gates.customs, "blocked");
  assert.deepEqual(legacyBody.semanticSnapshot.shipments[0].contradictionKinds, ["customs"]);
  assert.deepEqual(legacyBody.semanticSnapshot.shipments[0].blockerKinds, ["customs_hold"]);
  assert.deepEqual(legacyBody.semanticSnapshot.shipments[0].controlRoomMetadata, {
    airline: "",
    cargo: { pieces: 4, weight: "125 kg" },
    client: "Example Importer",
    contacts: {},
    customsBroker: {},
    delivery: {},
    destination: "",
    flightDetails: {},
    freightBroker: {},
    metadataReceipt: {
      observationId: "observation:v1:fixture",
      snapshotTime: "2026-07-09T23:29:00.000Z",
      versionId: "shipment-metadata:v1:fixture",
    },
    order: "ORD-123",
    origin: "",
    route: "",
    shipmentNumber: "",
    station: "JFK",
  }, "compact witnesses must preserve cut-bound operator metadata exactly");
  assert.equal(legacyBody.mutatesOperationalState, false);
  assert.equal(response.body.includes("gmail-proof-snapshot"), false);
  assert.equal(response.body.includes("relational-shipment-truth-delivery-v1"), false,
    "the endpoint must not echo the bulk source packet");
  assert.equal(loads, 1);

  const processing = processingWatermarkFixture({
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
  });
  const relationalLegacyPreimage = {
    ...legacySnapshot,
    publicationId: "40000000-0000-4000-8000-000000000009",
    publicationVersion: 8,
    publicationChannel: "production",
    sourceCutId: `cut:v1:${"c".repeat(64)}`,
    packetHash: "9".repeat(64),
  };
  const relationalLegacyHash = deliveryPayloadHash(relationalLegacyPreimage);
  const relationalLegacy = buildWitness({
    ...relationalLegacyPreimage,
    deliveryPayloadHash: relationalLegacyHash,
    contentSignature: relationalLegacyHash,
  });
  assert.equal(relationalLegacy.responseBody.mode, "relational-legacy");
  assert.equal(relationalLegacy.responseBody.sourceReceipt.relationalIdentityPresent, true);
  assert.equal(relationalLegacy.responseBody.sourceReceipt.fullPayloadHashVerifiedAtSource, true);
  assert.equal(
    relationalLegacy.responseBody.sourceReceipt.processingWatermarkStatus,
    "legacy_unwatermarked",
  );
  assert.equal(relationalLegacy.responseBody.semanticSnapshot.processingWatermarkHash, null);
  assert.throws(() => buildWitness({
    ...relationalLegacyPreimage,
    processingWatermarkStatus: "legacy_unwatermarked",
    deliveryPayloadHash: relationalLegacyHash,
    contentSignature: relationalLegacyHash,
  }), (error) => (
    error?.code === "TRUTH_PRODUCTION_WITNESS_PROCESSING_WATERMARK_INVALID" &&
    /fields must be supplied together/.test(String(error?.cause?.message))
  ));
  const relationalPreimage = {
    ...legacySnapshot,
    publicationId: "40000000-0000-4000-8000-000000000001",
    publicationVersion: 9,
    publicationChannel: "production",
    sourceCutId: `cut:v1:${"d".repeat(64)}`,
    packetHash: "a".repeat(64),
    ...processing,
  };
  const relationalHash = deliveryPayloadHash(relationalPreimage);
  const relationalSnapshot = {
    ...relationalPreimage,
    deliveryPayloadHash: relationalHash,
    contentSignature: relationalHash,
  };
  const relational = buildWitness(relationalSnapshot, "2026-07-09T23:31:00.000Z");
  assert.equal(relational.responseBody.mode, "relational");
  assert.equal(relational.responseBody.sourceReceipt.fullPayloadHashVerifiedAtSource, true);
  assert.equal(relational.responseBody.sourceReceipt.recomputedDeliveryPayloadHash, relationalHash);
  assert.equal(relational.responseBody.semanticSnapshot.deliveryPayloadHash, relationalHash);
  assert.equal(
    relational.responseBody.semanticSnapshot.processingWatermarkHash,
    processing.processingWatermarkHash,
  );
  assert.equal(relational.responseBody.sourceReceipt.processingWatermarkStatus, "watermarked");
  assert.ok(relational.responseBytes < MAX_RESPONSE_BYTES);

  const productionSized = {
    ...legacySnapshot,
    sourceOnlyPadding: "x".repeat(6 * 1024 * 1024),
  };
  const compactedProductionSized = buildWitness(productionSized);
  assert.ok(compactedProductionSized.sourcePayloadBytes > 4.5 * 1024 * 1024,
    "fixture must exceed the Vercel function response limit before compaction");
  assert.ok(compactedProductionSized.responseBytes < MAX_RESPONSE_BYTES,
    "semantic witness must remain bounded below the platform limit");
  assert.equal(JSON.stringify(compactedProductionSized.responseBody).includes("sourceOnlyPadding"), false);

  assert.throws(
    () => buildWitness({ ...relationalSnapshot, contentSignature: "b".repeat(64) }),
    /hash validation/,
  );
  assert.throws(
    () => buildWitness({
      ...relationalSnapshot,
      processingWatermarkHash: "b".repeat(64),
    }),
    /processing-watermark validation/,
  );

  response = await invoke(handler, { token: "wrong_but_long_enough_token_1234567890" });
  assert.equal(response.statusCode, 401);
  assert.equal(loads, 1, "unauthorized requests must not touch persistence");

  response = await invoke(createProductionWitnessHandler({ env: {} }));
  assert.equal(response.statusCode, 503);
  response = await invoke(handler, { method: "POST" });
  assert.equal(response.statusCode, 405);

  const missing = createProductionWitnessHandler({
    env: { PQ_TRUTH_PRODUCTION_WITNESS_TOKEN: TOKEN },
    async loadSnapshot() { return null; },
  });
  response = await invoke(missing);
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().snapshot, undefined);
  assert.equal(response.json().error, "Canonical production truth witness is unavailable");

  assert.throws(
    () => require("../api/truth/production-witness")._test.validateSnapshot({
      shipments: Array.from({ length: MAX_SHIPMENT_ROWS + 1 }, () => ({})),
    }),
    /row bound/,
  );
  assert.throws(
    () => require("../api/truth/production-witness")._test.validateSnapshot({
      shipments: [],
      padding: "x".repeat(MAX_SOURCE_BYTES),
    }),
    /source-read bound/,
  );

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-production-witness",
    guarantees: [
      "the production comparator reads one dedicated token-gated compact semantic witness",
      "unauthorized requests cannot read persistence and responses are private/no-store",
      "the endpoint exposes no Gmail, TMS, tracking, money, or request snapshot fan-out",
      "missing, malformed, corrupt, oversized, and over-row-bound snapshots fail closed",
      "a source packet larger than the platform response limit compacts below a strict 2 MiB bound",
      "relational source hashes are verified before compaction and compact semantics carry an independent hash",
      "cut-bound control-room metadata and its immutable source receipt survive semantic compaction",
      "relational watermark status and hash survive compact witness identity while legacy stays explicit",
      "pre-watermark relational caches remain hash-verified but explicitly uncertified",
      "the witness is read-only and reports no operational mutation",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

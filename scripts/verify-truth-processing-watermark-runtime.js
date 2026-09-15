#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DELIVERY_BUILDER_VERSION,
  DELIVERY_SCHEMA_VERSION,
} = require("../lib/relational-truth-delivery-adapter");
const { REDUCER_VERSION } = require("../lib/relational-truth-reducer");
const { _test: runnerTest } = require("../lib/relational-truth-build-runner");
const { DEFAULT_POLICY } = require("../lib/truth-precedence-policy");
const { _test: ledgerTest } = require("../lib/truth-build-ledger");
const {
  CONFIGURED_KEYS,
  CONFIGURED_DETERMINISTIC_IDENTITY,
  DEFAULT_PROCESSING_CONFIG,
  PROCESSING_CONFIG_KEYS,
  createConfiguredProcessingWatermark,
  normalizeConfiguredProcessingWatermark,
  normalizeProcessingConfig,
  normalizeProcessingWatermark,
  processingWatermarkHash,
  validateProcessingWatermarkFields,
} = require("../lib/truth-processing-watermark");
const { processingWatermarkFixture } = require("./truth-processing-watermark-fixture");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function configuredOptions(processingConfig = DEFAULT_PROCESSING_CONFIG) {
  return {
    reducerVersion: REDUCER_VERSION,
    packetBuilderVersion: DELIVERY_BUILDER_VERSION,
    packetSchemaVersion: DELIVERY_SCHEMA_VERSION,
    precedencePolicyVersion: DEFAULT_POLICY.policyVersion,
    precedencePolicyHash: DEFAULT_POLICY.policyHash,
    processingConfig,
  };
}

function modelConfiguredOptions(processingConfig = DEFAULT_PROCESSING_CONFIG) {
  return {
    ...configuredOptions(processingConfig),
    model: "gpt-5-nano-2025-08-07",
    modelProvider: "openai-responses",
    promptVersion: "pikiio-gmail-action-prompt-v4-test",
  };
}

function main() {
  const configured = createConfiguredProcessingWatermark(configuredOptions());
  assert.deepEqual(Object.keys(configured), CONFIGURED_KEYS);
  assert.equal(configured.model, CONFIGURED_DETERMINISTIC_IDENTITY);
  assert.equal(configured.promptVersion, CONFIGURED_DETERMINISTIC_IDENTITY);
  assert.equal(
    configured.configSnapshotVersion,
    `truth-processing-config-snapshot:v1:${configured.configSnapshotHash}`,
  );
  assert.deepEqual(ledgerTest.normalizeVersions(configured), configured);
  assert.deepEqual(Object.keys(DEFAULT_PROCESSING_CONFIG), PROCESSING_CONFIG_KEYS);

  for (const [field, processingConfig] of Object.entries({
    dateOrder: { ...DEFAULT_PROCESSING_CONFIG, dateOrder: "DMY" },
    requireModelForAmbiguity: { ...DEFAULT_PROCESSING_CONFIG, requireModelForAmbiguity: false },
    maxModelConfidence: { ...DEFAULT_PROCESSING_CONFIG, maxModelConfidence: 0.85 },
    internalDomains: {
      ...DEFAULT_PROCESSING_CONFIG,
      internalDomains: ["partner-116.example", "internal.partner-116.example"],
    },
  })) {
    const rotated = createConfiguredProcessingWatermark(configuredOptions(processingConfig));
    assert.notEqual(rotated.configSnapshotHash, configured.configSnapshotHash, field);
    assert.notEqual(rotated.configSnapshotVersion, configured.configSnapshotVersion, field);
    assert.equal(rotated.model, CONFIGURED_DETERMINISTIC_IDENTITY, field);
    assert.equal(rotated.promptVersion, CONFIGURED_DETERMINISTIC_IDENTITY, field);
  }
  const canonicalDomains = normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    internalDomains: ["PIKI.IO", "internal.partner-116.example", "partner-116.example"],
  });
  assert.deepEqual(canonicalDomains.internalDomains, ["internal.partner-116.example", "partner-116.example"]);
  assert.equal(
    createConfiguredProcessingWatermark(configuredOptions(canonicalDomains)).configSnapshotHash,
    createConfiguredProcessingWatermark(configuredOptions({
      ...canonicalDomains,
      internalDomains: ["partner-116.example", "internal.partner-116.example"],
    })).configSnapshotHash,
  );

  const nonDefaultProcessingConfig = normalizeProcessingConfig({
    dateOrder: "DMY",
    requireModelForAmbiguity: false,
    maxModelConfidence: 0.85,
    internalDomains: ["internal.partner-116.example", "partner-116.example"],
  });
  const nonDefaultConfigured = createConfiguredProcessingWatermark(
    configuredOptions(nonDefaultProcessingConfig),
  );
  assert.deepEqual(runnerTest.resolveConfiguredProcessingWatermark({
    ...configuredOptions(nonDefaultProcessingConfig),
    processingWatermarkConfigured: nonDefaultConfigured,
  }).configured, nonDefaultConfigured);
  assert.throws(() => runnerTest.resolveConfiguredProcessingWatermark({
    ...configuredOptions(DEFAULT_PROCESSING_CONFIG),
    processingWatermarkConfigured: nonDefaultConfigured,
  }), /explicit trusted model identity/);
  const modelConfigured = createConfiguredProcessingWatermark(
    modelConfiguredOptions(nonDefaultProcessingConfig),
  );
  assert.deepEqual(runnerTest.resolveConfiguredProcessingWatermark({
    ...modelConfiguredOptions(nonDefaultProcessingConfig),
    processingWatermarkConfigured: modelConfigured,
  }).configured, modelConfigured);
  assert.throws(() => runnerTest.resolveConfiguredProcessingWatermark({
    ...configuredOptions(nonDefaultProcessingConfig),
    processingWatermarkConfigured: modelConfigured,
  }), /explicit trusted model identity/);
  assert.throws(() => runnerTest.resolveConfiguredProcessingWatermark({
    ...modelConfiguredOptions(nonDefaultProcessingConfig),
    model: "gpt-5-nano-tampered",
    processingWatermarkConfigured: modelConfigured,
  }), /explicit trusted model identity/);

  const missingProcessingConfig = clone(DEFAULT_PROCESSING_CONFIG);
  delete missingProcessingConfig.dateOrder;
  assert.throws(() => normalizeProcessingConfig(missingProcessingConfig), /dateOrder.*required/);
  assert.throws(() => normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    extra: true,
  }), /extra.*unsupported/);
  assert.throws(() => normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    dateOrder: "YMD",
  }), /MDY or DMY/);
  assert.throws(() => normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    requireModelForAmbiguity: "false",
  }), /must be a boolean/);
  assert.throws(() => normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    maxModelConfidence: 0.951,
  }), /at most 0.95/);
  assert.throws(() => normalizeProcessingConfig({
    ...DEFAULT_PROCESSING_CONFIG,
    internalDomains: ["partner-116.example", "bad domain"],
  }), /normalized domain/);

  const receipt = processingWatermarkFixture({ configured });
  const validated = validateProcessingWatermarkFields(receipt, { expectedConfigured: configured });
  assert.equal(validated.watermarkHash, receipt.processingWatermarkHash);

  const reordered = {
    observed: Object.fromEntries(Object.entries(receipt.processingWatermark.observed).reverse()),
    configured: Object.fromEntries(Object.entries(receipt.processingWatermark.configured).reverse()),
    schemaVersion: receipt.processingWatermark.schemaVersion,
  };
  assert.equal(processingWatermarkHash(reordered), receipt.processingWatermarkHash);

  for (const key of CONFIGURED_KEYS.filter((item) => item !== "configSnapshotVersion")) {
    const changed = clone(configured);
    if (key === "configSnapshotHash") {
      changed.configSnapshotHash = "0".repeat(64);
      changed.configSnapshotVersion = `truth-processing-config-snapshot:v1:${changed.configSnapshotHash}`;
    } else if (key.endsWith("Hash")) {
      changed[key] = "0".repeat(64);
    } else {
      changed[key] = `${changed[key]}:rotated`;
    }
    const changedWatermark = normalizeProcessingWatermark({
      ...receipt.processingWatermark,
      configured: changed,
    });
    assert.notEqual(processingWatermarkHash(changedWatermark), receipt.processingWatermarkHash, key);
  }

  const missing = clone(configured);
  delete missing.model;
  assert.throws(() => normalizeConfiguredProcessingWatermark(missing), /model.*required/);
  assert.throws(() => normalizeConfiguredProcessingWatermark({ ...configured, extra: "forbidden" }), /unsupported/);
  assert.throws(() => normalizeConfiguredProcessingWatermark({ ...configured, model: "" }), /non-empty/);
  assert.throws(() => normalizeConfiguredProcessingWatermark({
    ...configured,
    precedencePolicyHash: "not-a-hash",
  }), /SHA-256/);
  assert.throws(() => normalizeConfiguredProcessingWatermark({
    ...configured,
    configSnapshotVersion: `truth-processing-config-snapshot:v1:${"0".repeat(64)}`,
  }), /content-addressed/);

  const badObservedMethod = clone(receipt.processingWatermark);
  badObservedMethod.observed.claimProcessors[0].extractionMethod = "unknown";
  assert.throws(() => normalizeProcessingWatermark(badObservedMethod), /extractionMethod.*unsupported/);
  const badObservedHash = clone(receipt.processingWatermark);
  badObservedHash.observed.extractorSetVersion = `extractor-set:v2:${"0".repeat(64)}`;
  assert.throws(() => normalizeProcessingWatermark(badObservedHash), /canonical extractor tuples/);
  assert.throws(() => validateProcessingWatermarkFields({
    ...receipt,
    processingWatermarkHash: "0".repeat(64),
  }), /full canonical watermark/);
  assert.deepEqual(validateProcessingWatermarkFields({
    processingWatermarkStatus: "legacy_unwatermarked",
    processingWatermark: null,
    processingWatermarkHash: null,
  }, { allowLegacy: true }), {
    status: "legacy_unwatermarked",
    watermark: null,
    watermarkHash: null,
  });
  assert.throws(() => validateProcessingWatermarkFields({
    processingWatermarkStatus: "legacy_unwatermarked",
    processingWatermark: null,
    processingWatermarkHash: null,
  }), /not valid for a new build/);

  console.log(JSON.stringify({
    ok: true,
    verifier: "truth-processing-watermark-runtime",
    configuredFieldCount: CONFIGURED_KEYS.length,
    processingWatermarkHash: receipt.processingWatermarkHash,
    liveCalls: 0,
    modelCalls: 0,
  }, null, 2));
}

main();

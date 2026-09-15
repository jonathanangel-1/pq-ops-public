"use strict";

// Deterministic verifier-only fixture. This module performs no I/O and never
// reads environment credentials or invokes a model.

const {
  OBSERVED_DETERMINISTIC_SENTINEL,
  createConfiguredProcessingWatermark,
  normalizeProcessingWatermark,
  processingWatermarkHash,
  _test: { postgresJsonbHash },
} = require("../lib/truth-processing-watermark");

function processingWatermarkFixture(options = {}) {
  const configured = options.configured || createConfiguredProcessingWatermark(options);
  const claimProcessors = [{
    extractionMethod: "deterministic",
    extractorVersion: "fixture-claim-extractor-v1",
    model: OBSERVED_DETERMINISTIC_SENTINEL,
    promptVersion: OBSERVED_DETERMINISTIC_SENTINEL,
    acceptanceMethod: "policy",
    acceptancePolicyVersion: "fixture-acceptance-policy-v1",
  }];
  const entityLinkers = [{ linkMethod: "deterministic", linkerVersion: "fixture-linker-v1" }];
  const workgroupCreators = [{ createdMethod: "deterministic", linkerVersion: "fixture-linker-v1" }];
  const workgroupMembershipLinkers = [{
    membershipMethod: "deterministic",
    linkerVersion: "fixture-linker-v1",
  }];
  const observed = {
    claimProcessors,
    entityLinkers,
    workgroupCreators,
    workgroupMembershipLinkers,
    extractorSetVersion: `extractor-set:v2:${postgresJsonbHash(claimProcessors)}`,
    linkerSetVersion: `linker-set:v2:${postgresJsonbHash({
      entityLinkers,
      workgroupCreators,
      workgroupMembershipLinkers,
    })}`,
  };
  const processingWatermark = normalizeProcessingWatermark({
    schemaVersion: "truth-processing-watermark-v1",
    configured,
    observed,
  });
  return Object.freeze({
    processingWatermarkStatus: "watermarked",
    processingWatermark,
    processingWatermarkHash: processingWatermarkHash(processingWatermark),
  });
}

module.exports = Object.freeze({ processingWatermarkFixture });

"use strict";

const crypto = require("node:crypto");
const {
  PACKET_SCHEMA_VERSION: INTERNAL_PACKET_SCHEMA_VERSION,
  REDUCER_VERSION,
  reduceRelationalTruth,
} = require("./relational-truth-reducer");
const { DEFAULT_POLICY } = require("./truth-precedence-policy");
const { createTruthBuildLedger } = require("./truth-build-ledger");
const {
  createConfiguredProcessingWatermark,
  normalizeConfiguredProcessingWatermark,
  normalizeProcessingConfig,
  validateProcessingWatermarkFields,
} = require("./truth-processing-watermark");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  deadlineError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");

const RUNNER_VERSION = "relational-truth-build-runner-v1";
const HASH_RE = /^[0-9a-f]{64}$/;

class RelationalTruthBuildRunnerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "RelationalTruthBuildRunnerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical truth output contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  throw new TypeError("Canonical truth output contains a non-JSON value");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function requireString(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new RelationalTruthBuildRunnerError(`${field} must be a non-empty trimmed string`, {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field,
    });
  }
  return value;
}

function requireRuntimeProcessingWatermark(value, field, options = {}) {
  try {
    return validateProcessingWatermarkFields(value, { field, ...options });
  } catch (cause) {
    throw new RelationalTruthBuildRunnerError(`${field} has an invalid processing watermark: ${cause?.message || cause}`, {
      code: "TRUTH_BUILD_PROCESSING_WATERMARK_INVALID",
      field: cause?.field || field,
      cause,
    });
  }
}

function requireSameProcessingWatermark(left, right, field) {
  if (left.status !== right.status || left.watermarkHash !== right.watermarkHash ||
      stableJson(left.watermark) !== stableJson(right.watermark)) {
    throw new RelationalTruthBuildRunnerError(`${field} changed the server-derived processing watermark.`, {
      code: "TRUTH_BUILD_PROCESSING_WATERMARK_MISMATCH",
      field,
    });
  }
}

function textProcessingWatermarkHash(value) {
  return String(value?.processingWatermarkHash ?? value?.processing_watermark_hash ?? "").trim();
}

function resolveConfiguredProcessingWatermark(options = {}) {
  const processingConfig = normalizeProcessingConfig(
    options.processingConfig,
    "processingConfig",
  );
  const expected = createConfiguredProcessingWatermark({
    model: options.model,
    modelProvider: options.modelProvider,
    promptVersion: options.promptVersion,
    reducerVersion: options.reducerVersion,
    packetBuilderVersion: options.packetBuilderVersion,
    packetSchemaVersion: options.packetSchemaVersion,
    precedencePolicyVersion: options.precedencePolicyVersion,
    precedencePolicyHash: options.precedencePolicyHash,
    processingConfig,
  });
  const supplied = options.processingWatermarkConfigured
    ? normalizeConfiguredProcessingWatermark(options.processingWatermarkConfigured)
    : expected;
  if (stableJson(supplied) !== stableJson(expected)) {
    throw new RelationalTruthBuildRunnerError(
      "The runtime accepts only its explicit trusted model identity, code identity, and processing configuration.",
      {
        code: "TRUTH_BUILD_CONFIGURED_WATERMARK_RUNTIME_MISMATCH",
        field: "processingWatermarkConfigured",
      },
    );
  }
  return Object.freeze({ processingConfig, configured: supplied });
}

function defaultDeliveryModule() {
  try {
    return require("./relational-truth-delivery-adapter");
  } catch (cause) {
    throw new RelationalTruthBuildRunnerError(
      "The relational truth delivery adapter is unavailable; refusing to publish an internal reducer packet as UI truth.",
      {
        code: "TRUTH_BUILD_DELIVERY_ADAPTER_UNAVAILABLE",
        cause,
      },
    );
  }
}

function resolveDeliveryBuilder(options) {
  if (typeof options.deliveryBuilder === "function") {
    return {
      build: options.deliveryBuilder,
      finalize: typeof options.deliveryFinalizer === "function" ? options.deliveryFinalizer : null,
      version: requireString(options.packetBuilderVersion, "packetBuilderVersion"),
      schemaVersion: requireString(options.packetSchemaVersion, "packetSchemaVersion"),
    };
  }
  const adapter = defaultDeliveryModule();
  const build = adapter.buildRelationalTruthDelivery;
  if (typeof build !== "function") {
    throw new RelationalTruthBuildRunnerError(
      "The relational truth delivery adapter does not export buildRelationalTruthDelivery.",
      { code: "TRUTH_BUILD_DELIVERY_ADAPTER_INVALID" },
    );
  }
  const version = adapter.DELIVERY_BUILDER_VERSION || adapter.DELIVERY_ADAPTER_VERSION || adapter.ADAPTER_VERSION;
  const schemaVersion = adapter.DELIVERY_SCHEMA_VERSION || adapter.DELIVERY_PACKET_SCHEMA_VERSION || adapter.PACKET_SCHEMA_VERSION;
  return {
    build,
    finalize: typeof adapter.finalizePublishedTruthDelivery === "function"
      ? adapter.finalizePublishedTruthDelivery
      : null,
    version: requireString(options.packetBuilderVersion || version, "packetBuilderVersion"),
    schemaVersion: requireString(options.packetSchemaVersion || schemaVersion, "packetSchemaVersion"),
  };
}

function validateInternalOutput(value, bundle, mode) {
  if (!isPlainObject(value) || value.schemaVersion !== INTERNAL_PACKET_SCHEMA_VERSION ||
      value.reducerVersion !== REDUCER_VERSION || !Array.isArray(value.shipments) ||
      !Array.isArray(value.acceptedClaimCitations) ||
      !Array.isArray(value.shipmentMetadataCitations) ||
      !HASH_RE.test(String(value.shipmentMetadataManifestHash || "")) ||
      !HASH_RE.test(String(value.inputManifestHash || "")) ||
      !HASH_RE.test(String(value.reducerInputManifestHash || "")) ||
      value.processingWatermarkStatus !== "watermarked" ||
      !isPlainObject(value.processingWatermark) ||
      !HASH_RE.test(String(value.processingWatermarkHash || "")) ||
      !HASH_RE.test(String(value.packetHash || ""))) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} reducer output failed its internal schema contract.`, {
      code: "TRUTH_BUILD_INTERNAL_SCHEMA_INVALID",
      mode,
    });
  }
  if (value.sourceCut?.sourceCutId !== bundle.sourceCut.sourceCutId ||
      value.sourceCut?.manifestHash !== bundle.sourceCut.manifestHash ||
      value.sourceCut?.completeness !== bundle.sourceCut.completeness ||
      value.inputManifestHash !== bundle.inputManifestHash ||
      value.processingWatermarkStatus !== bundle.processingWatermarkStatus ||
      value.processingWatermarkHash !== bundle.processingWatermarkHash ||
      stableJson(value.processingWatermark) !== stableJson(bundle.processingWatermark) ||
      textProcessingWatermarkHash(bundle.sourceWatermark) !== bundle.processingWatermarkHash ||
      value.shipmentMetadataManifestHash !== bundle.shipmentMetadataManifestHash ||
      stableJson(value.sourceWatermark) !== stableJson(bundle.sourceWatermark)) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} reducer output escaped its frozen source cut.`, {
      code: "TRUTH_BUILD_INTERNAL_SOURCE_CUT_MISMATCH",
      mode,
    });
  }
  const { packetHash, ...hashPayload } = value;
  if (sha256Json(hashPayload) !== packetHash) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} reducer packet hash is inconsistent.`, {
      code: "TRUTH_BUILD_INTERNAL_HASH_INVALID",
      mode,
    });
  }
  return value;
}

function validateDeliveryPacket(value, reducedPacket, bundle, mode, schemaVersion) {
  if (!isPlainObject(value) || !Array.isArray(value.shipments) ||
      !Array.isArray(value.activeAwbs) || !Array.isArray(value.completedAwbs)) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} delivery adapter output is not a shipment packet.`, {
      code: "TRUTH_BUILD_DELIVERY_SCHEMA_INVALID",
      mode,
    });
  }
  const declaredSchema = value.schemaVersion || value.writerVersion;
  if (declaredSchema !== schemaVersion) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} delivery packet schema identity is inconsistent.`, {
      code: "TRUTH_BUILD_DELIVERY_SCHEMA_INVALID",
      mode,
      expected: schemaVersion,
      actual: declaredSchema,
    });
  }
  const provenance = value.truthProvenance;
  const bundleProcessingWatermark = requireRuntimeProcessingWatermark(bundle, `${mode}.bundle`);
  const deliveryProcessingWatermark = requireRuntimeProcessingWatermark(value, `${mode}.delivery`);
  requireSameProcessingWatermark(bundleProcessingWatermark, deliveryProcessingWatermark, `${mode}.delivery`);
  if (!isPlainObject(provenance) ||
      provenance.schemaVersion !== "relational-truth-delivery-provenance-v1" ||
      provenance.sourceCutId !== bundle.sourceCut.sourceCutId ||
      provenance.reducerPacketHash !== reducedPacket.packetHash ||
      provenance.inputManifestHash !== reducedPacket.inputManifestHash ||
      provenance.reducerVersion !== reducedPacket.reducerVersion ||
      provenance.precedencePolicyVersion !== reducedPacket.precedencePolicy?.policyVersion ||
      provenance.precedencePolicyHash !== reducedPacket.precedencePolicy?.policyHash ||
      stableJson(provenance.processingWatermark) !== stableJson(bundleProcessingWatermark.watermark) ||
      provenance.processingWatermarkHash !== bundleProcessingWatermark.watermarkHash ||
      !HASH_RE.test(String(provenance.acceptedClaimManifestHash || "")) ||
      provenance.shipmentMetadataManifestHash !== reducedPacket.shipmentMetadataManifestHash ||
      value.packetHash !== reducedPacket.packetHash) {
    throw new RelationalTruthBuildRunnerError(`The ${mode} UI packet is not bound to its reducer provenance.`, {
      code: "TRUTH_BUILD_DELIVERY_PROVENANCE_INVALID",
      mode,
    });
  }
  for (const publicationOwnedField of [
    "publicationId",
    "publicationVersion",
    "publicationChannel",
    "publishedAt",
    "deliveryPayloadHash",
    "contentSignature",
  ]) {
    if (Object.hasOwn(value, publicationOwnedField)) {
      throw new RelationalTruthBuildRunnerError(
        `The ${mode} base delivery packet contains publication-owned field ${publicationOwnedField}.`,
        { code: "TRUTH_BUILD_DELIVERY_PREPUBLISHED", mode, field: publicationOwnedField },
      );
    }
  }
  return value;
}

function pairLease(receipt, workerId) {
  return {
    buildPairId: receipt.buildPairId,
    workerId,
    leaseFence: receipt.leaseFence,
  };
}

async function failDeterministically(ledger, lease, error, { signal = null, deadlineAtMs = null } = {}) {
  throwIfAborted(signal, { stage: "truth build failure acknowledgement", deadlineAtMs });
  try {
    return await ledger.failPair({
      ...lease,
      errorCode: String(error?.code || "TRUTH_BUILD_RUNNER_FAILED").slice(0, 200),
      safeErrorDetail: String(error?.message || error || "Truth build runner failed"),
    });
  } catch (failureError) {
    if (failureError?.outcomeUnknown === true || isAbortError(failureError, signal)) {
      throw asOutcomeUnknownError(failureError, {
        signal,
        stage: "truth build failure acknowledgement",
        deadlineAtMs,
      });
    }
    error.failurePersistenceError = failureError;
    return null;
  }
}

async function recoverCompletion({
  ledger,
  claimInput,
  completeInput,
  originalError,
  signal = null,
  deadlineAtMs = null,
}) {
  if (originalError?.outcomeUnknown || isAbortError(originalError, signal)) {
    throw asDeadlineError(originalError, {
      signal,
      stage: "truth build completion",
      deadlineAtMs,
      outcomeUnknown: true,
    });
  }
  throwIfAborted(signal, { stage: "truth build completion recovery", deadlineAtMs });
  try {
    return await ledger.completePair(completeInput);
  } catch (retryError) {
    if (retryError?.outcomeUnknown || isAbortError(retryError, signal)) {
      throw asDeadlineError(retryError, {
        signal,
        stage: "truth build completion recovery",
        deadlineAtMs,
        outcomeUnknown: true,
      });
    }
    if (!retryError?.retryable) throw retryError;
    throwIfAborted(signal, { stage: "truth build completion reconciliation", deadlineAtMs });
    const recovery = await ledger.claimPair(claimInput);
    if (["succeeded", "failed"].includes(recovery.status)) return recovery;
    const error = new RelationalTruthBuildRunnerError(
      "Truth build completion outcome is unknown after two transport failures; the idempotency key must be retried, never replaced.",
      {
        code: "TRUTH_BUILD_COMPLETION_OUTCOME_UNKNOWN",
        retryable: true,
        outcomeUnknown: true,
        buildPairId: recovery.buildPairId,
        cause: retryError,
        originalError,
      },
    );
    throw error;
  }
}

async function publishCompletedPair({
  ledger,
  pair,
  publication,
  deliveryPacket = null,
  deliveryFinalizer = null,
  signal = null,
  deadlineAtMs = null,
}) {
  if (!publication) return null;
  if (!isPlainObject(publication)) {
    throw new RelationalTruthBuildRunnerError("publication must be an object", {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field: "publication",
    });
  }
  if (publication.allowProduction === true) {
    throw new RelationalTruthBuildRunnerError(
      "publication.allowProduction is retired; production requires a separately issued one-time approval capability.",
      {
        code: "TRUTH_BUILD_PRODUCTION_APPROVAL_REQUIRED",
        field: "publication.allowProduction",
      },
    );
  }
  throwIfAborted(signal, { stage: "truth publication preflight", deadlineAtMs });
  const pairProcessingWatermark = requireRuntimeProcessingWatermark(pair, "publication.pair");
  const channel = pair.publicationChannel;
  const head = publication.expectedHeadVersion === undefined
    ? await ledger.readHead({ channel, maxPayloadBytes: publication.maxPayloadBytes })
    : null;
  const expectedHeadVersion = publication.expectedHeadVersion ?? (head?.found ? head.publicationVersion : 0);
  const expectedHeadPacketHash = publication.expectedHeadPacketHash ?? (head?.found ? head.packetHash : "");
  let productionApproval = publication.productionApproval;
  if (channel === "production" && typeof publication.issueProductionApproval === "function") {
    if (productionApproval !== undefined && productionApproval !== null) {
      throw new RelationalTruthBuildRunnerError(
        "Production publication must use exactly one approval authority.",
        { code: "TRUTH_BUILD_PRODUCTION_APPROVAL_AUTHORITY_CONFLICT" },
      );
    }
    productionApproval = await publication.issueProductionApproval({
      pair,
      expectedHeadVersion,
      expectedHeadPacketHash,
      publicationRequestKey: requireString(publication.publicationRequestKey, "publication.publicationRequestKey"),
      publicationReason: publication.publicationReason || "normal",
      publisherVersion: publication.publisherVersion || RUNNER_VERSION,
      publishedBy: requireString(publication.publishedBy, "publication.publishedBy"),
    });
  } else if (typeof publication.issueProductionApproval === "function") {
    throw new RelationalTruthBuildRunnerError(
      "Production approval issuance is forbidden outside the production channel.",
      { code: "TRUTH_BUILD_PRODUCTION_APPROVAL_CHANNEL_MISMATCH" },
    );
  }
  let receipt;
  try {
    throwIfAborted(signal, { stage: "truth publication", deadlineAtMs });
    receipt = await ledger.publishPair({
      buildPairId: pair.buildPairId,
      publicationRequestKey: requireString(publication.publicationRequestKey, "publication.publicationRequestKey"),
      expectedHeadVersion,
      expectedHeadPacketHash,
      publicationReason: publication.publicationReason || "normal",
      publisherVersion: publication.publisherVersion || RUNNER_VERSION,
      publishedBy: requireString(publication.publishedBy, "publication.publishedBy"),
      productionApproval,
    });
    const publicationProcessingWatermark = requireRuntimeProcessingWatermark(receipt, "publication.receipt");
    requireSameProcessingWatermark(
      pairProcessingWatermark,
      publicationProcessingWatermark,
      "publication.receipt",
    );
  } catch (error) {
    if (error?.outcomeUnknown || isAbortError(error, signal)) {
      throw asDeadlineError(error, {
        signal,
        stage: "truth publication",
        deadlineAtMs,
        outcomeUnknown: true,
      });
    }
    throw error;
  }
  if (deliveryPacket && typeof deliveryFinalizer === "function") {
    try {
      const finalized = deliveryFinalizer({
        deliveryPacket,
        publication: {
          ...receipt.publicationAdapter,
          processingWatermarkStatus: receipt.processingWatermarkStatus,
          processingWatermark: receipt.processingWatermark,
          processingWatermarkHash: receipt.processingWatermarkHash,
        },
      });
      if (finalized.deliveryPayloadHash !== receipt.deliveryPayloadHash ||
          finalized.contentSignature !== receipt.deliveryPayloadHash) {
        throw new RelationalTruthBuildRunnerError(
          "SQL publication delivery identity diverged from the pure delivery finalizer.",
          { code: "TRUTH_BUILD_PUBLICATION_DELIVERY_HASH_MISMATCH" },
        );
      }
      throwIfAborted(signal, {
        stage: "truth publication readback",
        deadlineAtMs,
        outcomeUnknown: false,
      });
      const persisted = await ledger.readHead({
        channel,
        maxPayloadBytes: publication.maxPayloadBytes,
      });
      const persistedProcessingWatermark = requireRuntimeProcessingWatermark(
        persisted,
        "publication.readback",
      );
      requireSameProcessingWatermark(
        pairProcessingWatermark,
        persistedProcessingWatermark,
        "publication.readback",
      );
      if (!persisted.found || persisted.deliveryPayloadHash !== finalized.deliveryPayloadHash ||
          stableJson(persisted.deliveryPayload) !== stableJson(finalized)) {
        throw new RelationalTruthBuildRunnerError(
          "Published truth did not read back byte-equivalent through the production adapter boundary.",
          { code: "TRUTH_BUILD_PUBLICATION_READBACK_MISMATCH" },
        );
      }
    } catch (error) {
      let verificationError = error;
      if (isAbortError(error, signal)) {
        verificationError = deadlineError({
          stage: "truth publication verification",
          deadlineAtMs,
          outcomeUnknown: false,
          cause: error instanceof Error ? error : null,
          code: error?.code === "TRUTH_RUNTIME_ABORTED"
            ? "TRUTH_RUNTIME_ABORTED"
            : "TRUTH_RUNTIME_DEADLINE_EXCEEDED",
        });
      }
      verificationError.publicationConfirmed = true;
      verificationError.publicationReceipt = receipt;
      throw verificationError;
    }
  }
  if (channel === "production" && productionApproval?.approvalId) {
    return Object.freeze({
      ...receipt,
      publicationChannel: "production",
      productionApproval: Object.freeze({
        approvalId: productionApproval.approvalId,
        status: "consumed",
        consumed: true,
        consumedPublicationId: receipt.publicationId,
      }),
    });
  }
  return receipt;
}

async function runRelationalTruthBuild(options = {}) {
  if (!isPlainObject(options)) {
    throw new RelationalTruthBuildRunnerError("options must be an object", {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field: "options",
    });
  }
  if (Object.hasOwn(options, "sourceDetailsByShipment")) {
    throw new RelationalTruthBuildRunnerError(
      "Caller-supplied shipment metadata is forbidden; canonical builds derive it from the sealed TMS cut.",
      {
        code: "TRUTH_BUILD_CALLER_METADATA_FORBIDDEN",
        field: "sourceDetailsByShipment",
      },
    );
  }
  for (const forbiddenField of ["processingWatermark", "processingWatermarkObserved", "observedProcessingWatermark"]) {
    if (Object.hasOwn(options, forbiddenField)) {
      throw new RelationalTruthBuildRunnerError(
        "Caller-supplied observed processing state is forbidden; only the database derives observed watermark sets.",
        {
          code: "TRUTH_BUILD_CALLER_OBSERVED_WATERMARK_FORBIDDEN",
          field: forbiddenField,
        },
      );
    }
  }
  const delivery = resolveDeliveryBuilder(options);
  const signal = options.signal ?? null;
  if (signal !== null && !isAbortSignal(signal)) {
    throw new RelationalTruthBuildRunnerError("signal must be an AbortSignal or null", {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field: "signal",
    });
  }
  const hasDeadline = options.deadlineAtMs !== undefined
    && options.deadlineAtMs !== null
    && options.deadlineAtMs !== "";
  const deadlineAtMs = hasDeadline && Number.isFinite(Number(options.deadlineAtMs))
    ? Number(options.deadlineAtMs)
    : null;
  throwIfAborted(signal, { stage: "truth build claim", deadlineAtMs });
  const reducer = options.reducer || reduceRelationalTruth;
  if (typeof reducer !== "function") {
    throw new RelationalTruthBuildRunnerError("reducer must be a function", {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field: "reducer",
    });
  }
  const ledger = options.ledger || createTruthBuildLedger(options.ledgerOptions || {});
  const workerId = requireString(options.workerId, "workerId");
  const precedencePolicy = options.precedencePolicy || DEFAULT_POLICY;
  const reducerPrecedencePolicy = options.precedencePolicy
    ? Object.fromEntries(Object.entries(precedencePolicy).filter(([key]) => key !== "policyHash"))
    : null;
  const precedencePolicyVersion = requireString(precedencePolicy.policyVersion, "precedencePolicy.policyVersion");
  const precedencePolicyHash = requireString(precedencePolicy.policyHash, "precedencePolicy.policyHash");
  if (!HASH_RE.test(precedencePolicyHash)) {
    throw new RelationalTruthBuildRunnerError("precedence policy hash is invalid", {
      code: "TRUTH_BUILD_RUNNER_INVALID_ARGUMENT",
      field: "precedencePolicy.policyHash",
    });
  }
  let versions;
  try {
    const resolvedProcessingWatermark = resolveConfiguredProcessingWatermark({
      model: options.model,
      modelProvider: options.modelProvider,
      promptVersion: options.promptVersion,
      reducerVersion: REDUCER_VERSION,
      packetBuilderVersion: delivery.version,
      packetSchemaVersion: delivery.schemaVersion,
      precedencePolicyVersion,
      precedencePolicyHash,
      processingConfig: options.processingConfig,
      processingWatermarkConfigured: options.processingWatermarkConfigured,
    });
    versions = resolvedProcessingWatermark.configured;
  } catch (cause) {
    if (cause instanceof RelationalTruthBuildRunnerError) throw cause;
    throw new RelationalTruthBuildRunnerError(
      `Processing watermark configuration is invalid: ${cause?.message || cause}`,
      {
        code: "TRUTH_BUILD_CONFIGURED_WATERMARK_INVALID",
        field: cause?.field || "processingConfig",
        cause,
      },
    );
  }
  const claimInput = {
    sourceCutId: requireString(options.sourceCutId, "sourceCutId"),
    buildChannel: options.buildChannel || "shadow",
    triggerName: options.triggerName || RUNNER_VERSION,
    idempotencyKey: requireString(options.idempotencyKey, "idempotencyKey"),
    workerId,
    leaseSeconds: options.leaseSeconds,
    bundleRowLimit: options.bundleRowLimit,
    versions,
  };
  const claimed = await ledger.claimPair(claimInput);
  const claimedProcessingWatermark = requireRuntimeProcessingWatermark(claimed, "claim.receipt", {
    expectedConfigured: versions,
  });
  if (claimed.status === "busy") return Object.freeze({ status: "busy", pair: claimed });
  if (claimed.status === "failed") return Object.freeze({ status: "failed", pair: claimed });
  if (claimed.status === "succeeded") {
    const publication = await publishCompletedPair({
      ledger,
      pair: claimed,
      publication: options.publication,
      deliveryFinalizer: delivery.finalize,
      signal,
      deadlineAtMs,
    });
    return Object.freeze({ status: "succeeded", recovered: true, pair: claimed, publication });
  }

  const lease = pairLease(claimed, workerId);
  let completionStarted = false;
  try {
    throwIfAborted(signal, { stage: "truth build bundle read", deadlineAtMs });
    const bundle = await ledger.readBundle(lease);
    const bundleProcessingWatermark = requireRuntimeProcessingWatermark(bundle, "bundle.receipt", {
      expectedConfigured: versions,
    });
    requireSameProcessingWatermark(claimedProcessingWatermark, bundleProcessingWatermark, "bundle.receipt");
    const compiledAt = bundle.sourceCut.sealedAt;
    throwIfAborted(signal, { stage: "truth full reduction", deadlineAtMs });
    const fullInternal = validateInternalOutput(
      reducer(bundle, {
        mode: "full",
        ...(reducerPrecedencePolicy ? { precedencePolicy: reducerPrecedencePolicy } : {}),
      }),
      bundle,
      "full",
    );
    const incrementalInternal = validateInternalOutput(
      reducer({
        ...bundle,
        basePublication: claimed.basePublicationId
          ? { publicationId: claimed.basePublicationId, materializedOutputForbidden: true }
          : null,
      }, {
        mode: "incremental",
        ...(reducerPrecedencePolicy ? { precedencePolicy: reducerPrecedencePolicy } : {}),
      }),
      bundle,
      "incremental",
    );
    if (stableJson(fullInternal) !== stableJson(incrementalInternal) ||
        fullInternal.packetHash !== incrementalInternal.packetHash) {
      throw new RelationalTruthBuildRunnerError(
        "Full and incremental internal reducer outputs diverged at the same exact cut.",
        { code: "TRUTH_BUILD_INTERNAL_PARITY_MISMATCH" },
      );
    }

    const deliveryInput = {
      claimEnvelopes: bundle.acceptedClaimEnvelopes,
      compiledAt,
      shipmentMetadataEnvelopes: bundle.shipmentMetadataEnvelopes,
      processingWatermarkStatus: bundleProcessingWatermark.status,
      processingWatermark: bundleProcessingWatermark.watermark,
      processingWatermarkHash: bundleProcessingWatermark.watermarkHash,
    };
    throwIfAborted(signal, { stage: "truth delivery packet build", deadlineAtMs });
    const fullDelivery = validateDeliveryPacket(
      await delivery.build({ ...deliveryInput, reducedPacket: fullInternal }),
      fullInternal,
      bundle,
      "full",
      delivery.schemaVersion,
    );
    const incrementalDelivery = validateDeliveryPacket(
      await delivery.build({ ...deliveryInput, reducedPacket: incrementalInternal }),
      incrementalInternal,
      bundle,
      "incremental",
      delivery.schemaVersion,
    );
    const fullDeliveryHash = sha256Json(fullDelivery);
    const incrementalDeliveryHash = sha256Json(incrementalDelivery);
    if (stableJson(fullDelivery) !== stableJson(incrementalDelivery) ||
        fullDeliveryHash !== incrementalDeliveryHash) {
      throw new RelationalTruthBuildRunnerError(
        "Full and incremental final UI delivery packets diverged at the same exact cut.",
        { code: "TRUTH_BUILD_DELIVERY_PARITY_MISMATCH" },
      );
    }

    const reportBase = {
      schemaValid: true,
      deliveryIdentityValid: true,
      runnerVersion: RUNNER_VERSION,
      packetBuilderVersion: delivery.version,
      packetSchemaVersion: delivery.schemaVersion,
      compiledAt,
      acceptedClaimManifestHash: fullDelivery.truthProvenance.acceptedClaimManifestHash,
      shipmentMetadataManifestHash: fullDelivery.truthProvenance.shipmentMetadataManifestHash,
      shipmentMetadataCount: bundle.shipmentMetadataEnvelopes.length,
      deliveryPacketHash: fullDeliveryHash,
      internalReducerPacketHash: fullInternal.packetHash,
      internalReducerOutputHash: sha256Json(fullInternal),
      basePublicationUsedAsEvidence: false,
      processingWatermarkStatus: bundleProcessingWatermark.status,
      processingWatermarkHash: bundleProcessingWatermark.watermarkHash,
    };
    const completeInput = {
      ...lease,
      fullPacket: fullDelivery,
      incrementalPacket: incrementalDelivery,
      fullSemanticHash: fullInternal.packetHash,
      incrementalSemanticHash: incrementalInternal.packetHash,
      fullValidationReport: {
        ...reportBase,
        mode: "full",
        internalReducerOutput: fullInternal,
      },
      incrementalValidationReport: {
        ...reportBase,
        mode: "incremental",
        internalReducerOutput: incrementalInternal,
      },
    };
    throwIfAborted(signal, { stage: "truth build completion", deadlineAtMs });
    completionStarted = true;
    let completed;
    try {
      completed = await ledger.completePair(completeInput);
    } catch (error) {
      if (!error?.retryable) throw error;
      completed = await recoverCompletion({
        ledger,
        claimInput,
        completeInput,
        originalError: error,
        signal,
        deadlineAtMs,
      });
    }
    if (completed.status !== "succeeded") {
      return Object.freeze({ status: completed.status, pair: completed });
    }
    const completedProcessingWatermark = requireRuntimeProcessingWatermark(completed, "completion.receipt", {
      expectedConfigured: versions,
    });
    requireSameProcessingWatermark(
      bundleProcessingWatermark,
      completedProcessingWatermark,
      "completion.receipt",
    );
    const publication = await publishCompletedPair({
      ledger,
      pair: completed,
      publication: options.publication,
      deliveryPacket: fullDelivery,
      deliveryFinalizer: delivery.finalize,
      signal,
      deadlineAtMs,
    });
    return Object.freeze({
      status: "succeeded",
      recovered: completed.idempotent === true,
      pair: completed,
      publication,
      hashes: Object.freeze({
        reducerPacketHash: fullInternal.packetHash,
        reducerOutputHash: sha256Json(fullInternal),
        deliveryPacketHash: fullDeliveryHash,
        processingWatermarkHash: bundleProcessingWatermark.watermarkHash,
      }),
    });
  } catch (error) {
    const runtimeExpired = signal?.aborted === true || (
      deadlineAtMs !== null && Number.isFinite(deadlineAtMs) && Date.now() >= deadlineAtMs
    );
    const publicationConfirmed = error?.publicationConfirmed === true;
    const ambiguous = error?.outcomeUnknown === true
      || (completionStarted && !publicationConfirmed && isAbortError(error, signal));
    const normalizedError = (runtimeExpired || ambiguous)
      ? asDeadlineError(error, {
          signal,
          stage: completionStarted ? "truth build completion or publication" : "truth build",
          deadlineAtMs,
          outcomeUnknown: ambiguous,
        })
      : error;
    if (publicationConfirmed) {
      normalizedError.publicationConfirmed = true;
      normalizedError.publicationReceipt = error.publicationReceipt;
    }
    if (!completionStarted && !normalizedError?.outcomeUnknown && !runtimeExpired) {
      await failDeterministically(ledger, lease, normalizedError, { signal, deadlineAtMs });
    }
    if (normalizedError instanceof RelationalTruthBuildRunnerError) throw normalizedError;
    throw new RelationalTruthBuildRunnerError(
      `Relational truth build failed: ${normalizedError?.message || normalizedError}`,
      {
        code: normalizedError?.code || "TRUTH_BUILD_RUNNER_FAILED",
        retryable: normalizedError?.retryable === true,
        outcomeUnknown: normalizedError?.outcomeUnknown === true,
        deadlineExceeded: normalizedError?.deadlineExceeded === true,
        publicationConfirmed: normalizedError?.publicationConfirmed === true,
        publicationReceipt: normalizedError?.publicationReceipt || null,
        cause: normalizedError,
      },
    );
  }
}

module.exports = {
  RUNNER_VERSION,
  RelationalTruthBuildRunnerError,
  runRelationalTruthBuild,
  _test: {
    canonicalize,
    publishCompletedPair,
    resolveDeliveryBuilder,
    resolveConfiguredProcessingWatermark,
    sha256Json,
    stableJson,
    validateDeliveryPacket,
    validateInternalOutput,
  },
};

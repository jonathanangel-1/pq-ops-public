"use strict";

const crypto = require("node:crypto");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");
const {
  PREDICATES,
  REGISTRY: PREDICATE_REGISTRY,
  TMS_PREDICATES,
} = require("./truth-predicate-registry");
const {
  EXTRACTOR_VERSION: GMAIL_EXTRACTOR_VERSION,
} = require("./gmail-claim-extractor");
const {
  PINNED_MODEL: GMAIL_ATTACHMENT_MODEL,
  PROMPT_VERSION: GMAIL_ATTACHMENT_MODEL_PROMPT_VERSION,
  RESPONSE_SCHEMA_VERSION: GMAIL_ATTACHMENT_MODEL_RESPONSE_SCHEMA_VERSION,
} = require("./openai-gmail-attachment-model-extractor");
const {
  ACCEPTANCE_POLICY_VERSION: TMS_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: TMS_EXTRACTOR_VERSION,
  createTmsClaimExtractor,
} = require("./tms-claim-extractor");
const {
  ACCEPTANCE_POLICY_VERSION: TRACKING_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: TRACKING_EXTRACTOR_VERSION,
  assessTrackingObservation,
  createTrackingClaimExtractor,
} = require("./tracking-claim-extractor");
const {
  ACCEPTANCE_POLICY_VERSION: OPERATOR_ACCEPTANCE_POLICY_VERSION,
  EXTRACTOR_VERSION: OPERATOR_EXTRACTOR_VERSION,
  assessOperatorObservation,
  createOperatorClaimExtractor,
} = require("./operator-claim-extractor");

const JOB_KIND = "gmail_extract_message_claims";
const ATTACHMENT_JOB_KIND = "gmail_extract_attachment_claims";
const TMS_JOB_KIND = "tms_extract_claims";
const TRACKING_JOB_KIND = "tracking_extract_claims";
const OPERATOR_JOB_KIND = "operator_extract_claims";
const DETERMINISTIC_ATTACHMENT_METHODS = new Set([
  "pdf-text+quality-v1",
  "utf8-text-v1",
  "html-to-text-v1",
]);
const MODEL_ATTACHMENT_METHOD = "openai-responses-file-v1";
const MODEL_ATTACHMENT_PROVENANCE = "truth_attachment_model_runtime";
const SUPPORTED_JOB_KINDS = Object.freeze({
  [JOB_KIND]: Object.freeze({
    sourceSystem: "gmail",
    sourceObjectType: "gmail_message_parsed",
    payloadSchemaVersion: "gmail-parsed-message-v2",
  }),
  [ATTACHMENT_JOB_KIND]: Object.freeze({
    sourceSystem: "gmail",
    sourceObjectType: "gmail_attachment_extracted",
    payloadSchemaVersion: "gmail-attachment-extracted-v1",
  }),
  [TMS_JOB_KIND]: Object.freeze({
    sourceSystem: "tms",
    sourceObjectType: "tms_shipment_snapshot",
    payloadSchemaVersion: "tms-shipment-source-observation-v1",
  }),
  [TRACKING_JOB_KIND]: Object.freeze({
    sourceSystem: "tracking",
    sourceObjectType: "tracking_shipment_snapshot",
    payloadSchemaVersion: "tracking-source-observation-v1",
  }),
  [OPERATOR_JOB_KIND]: Object.freeze({
    sourceSystem: "operator",
    sourceObjectType: "operator_event",
    payloadSchemaVersion: "operator-event-source-observation-v1",
  }),
});
const LEGACY_RESULT_SCHEMA_VERSION = "truth-claim-worker-result-v1";
const RESULT_SCHEMA_VERSION = "truth-claim-worker-result-v2";
const PENDING_ACCEPTANCE_COORDINATOR = "pending_acceptance_coordinator";
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

class TruthClaimWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthClaimWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthClaimWorkerError(`Invalid truth-claim worker argument ${field}: ${reason}`, {
    code: "TRUTH_CLAIM_WORKER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw invalidArgument(field, "must be a non-empty trimmed string");
  }
  return value;
}

function integer(value, field, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireMethod(value, method, field) {
  if (!value || typeof value[method] !== "function") {
    throw invalidArgument(field, `must expose ${method}()`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function canonicalTimestamp(value) {
  const result = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    && Number.isFinite(Date.parse(result))
    && new Date(result).toISOString() === result
    ? result
    : "";
}

function safeTrackingAssessment(observation) {
  try {
    return assessTrackingObservation(observation);
  } catch {
    return null;
  }
}

function safeOperatorAssessment(observation) {
  try {
    return assessOperatorObservation(observation);
  } catch {
    return null;
  }
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function createAttachmentClaimExtractorAdapter(messageExtractor) {
  requireMethod(messageExtractor, "extract", "messageExtractor");
  return Object.freeze({
    async extract(input = {}) {
      const observation = input.observation;
      if (!isPlainObject(observation)
        || observation.sourceObjectType !== "gmail_attachment_extracted"
        || observation.normalizedPayload?.schemaVersion !== "gmail-attachment-extracted-v1") {
        throw new TruthClaimWorkerError("Attachment extractor adapter requires an extracted Gmail attachment", {
          code: "TRUTH_CLAIM_ATTACHMENT_PROVENANCE_INVALID",
        });
      }
      const gmail = observation.normalizedPayload.gmail;
      if (!isPlainObject(gmail) || typeof gmail.messageId !== "string" || !gmail.messageId) {
        throw new TruthClaimWorkerError("Attachment observation lacks its parent Gmail message identity", {
          code: "TRUTH_CLAIM_ATTACHMENT_PROVENANCE_INVALID",
        });
      }
      const threadId = typeof gmail.threadId === "string" && gmail.threadId
        ? gmail.threadId
        : `message:${gmail.messageId}`;
      const extraction = observation.normalizedPayload.extraction;
      const modelDerived = extraction?.provenance === MODEL_ATTACHMENT_PROVENANCE;
      if (modelDerived && (
        extraction.status !== "extracted"
        || extraction.method !== MODEL_ATTACHMENT_METHOD
        || extraction.reviewRequired !== true
        || extraction.modelSnapshot !== GMAIL_ATTACHMENT_MODEL
        || extraction.promptVersion !== GMAIL_ATTACHMENT_MODEL_PROMPT_VERSION
        || extraction.responseSchemaVersion !== GMAIL_ATTACHMENT_MODEL_RESPONSE_SCHEMA_VERSION
        || !/^gmail-attachment-model-request:v1:[0-9a-f]{64}$/.test(String(extraction.requestId || ""))
        || typeof extraction.providerResponseId !== "string" || !extraction.providerResponseId
        || extraction.assessedAllPages !== true
        || !Number.isSafeInteger(extraction.pageCount) || extraction.pageCount < 1
        || extraction.pagesAssessed !== extraction.pageCount
      )) {
        throw new TruthClaimWorkerError("Attachment model evidence lacks its exact provider provenance", {
          code: "TRUTH_CLAIM_ATTACHMENT_MODEL_PROVENANCE_INVALID",
        });
      }
      const normalizedPayload = {
        schemaVersion: "gmail-attachment-claim-projection-v1",
        gmail: { messageId: gmail.messageId, threadId },
        subject: String(observation.normalizedPayload.filename || "Gmail attachment"),
        text: observation.normalizedText,
      };
      const normalizedText = [
        normalizedPayload.subject ? `Subject: ${normalizedPayload.subject}` : "",
        normalizedPayload.text || "",
      ].filter(Boolean).join("\n");
      const bodyStart = normalizedText.length - observation.normalizedText.length;
      const projected = {
        ...observation,
        sourceObjectType: "gmail_attachment_claim_projection",
        // The projection is not a parsed Gmail message and therefore has no
        // Gmail internal-date chronology envelope. Attachment chronology stays
        // bound to the original observation used by the candidate ledger.
        sourceRecordedAt: null,
        contentHash: sha256Json(normalizedPayload),
        normalizedPayload,
        normalizedText,
      };
      const extractionMethod = typeof messageExtractor.extractDeterministic === "function"
        ? messageExtractor.extractDeterministic
        : messageExtractor.extract;
      const candidates = await extractionMethod.call(messageExtractor, {
        ...input,
        observation: projected,
      });
      if (!Array.isArray(candidates)) {
        throw new TruthClaimWorkerError("Attachment claim extractor must return an array", {
          code: "TRUTH_CLAIM_EXTRACTOR_INVALID",
        });
      }
      return candidates.map((candidate) => {
        const span = candidate?.evidenceSpan;
        if (!isPlainObject(span)
          || span.start < bodyStart
          || span.end > normalizedText.length
          || observation.normalizedText.slice(span.start - bodyStart, span.end - bodyStart) !== span.quote) {
          throw new TruthClaimWorkerError("Attachment candidate citation escaped the immutable attachment text", {
            code: "TRUTH_CLAIM_ATTACHMENT_CITATION_INVALID",
          });
        }
        const base = {
          ...candidate,
          sourceObservationId: observation.observationId,
          sourceObservationContentHash: observation.contentHash,
          sourceMessageId: gmail.messageId,
          sourceThreadId: String(gmail.threadId || ""),
          sourceCapturedAt: observation.capturedAt ?? null,
          evidenceSpan: {
            ...span,
            start: span.start - bodyStart,
            end: span.end - bodyStart,
          },
        };
        if (modelDerived) {
          base.extractionMethod = "model";
          base.model = extraction.modelSnapshot;
          base.promptVersion = extraction.promptVersion;
          base.ambiguity = {
            status: "review",
            reasons: [...new Set([
              "attachment text was transcribed by a pinned document model",
              ...(Array.isArray(candidate.ambiguity?.reasons) ? candidate.ambiguity.reasons : []),
            ])],
          };
          base.acceptanceRecommendation = {
            decision: "review",
            method: "operator",
            policyVersion: candidate.acceptanceRecommendation.policyVersion,
            reasons: [
              "model-derived attachment evidence requires operator review against the exact citation",
            ],
          };
        }
        delete base.candidateClaimVersionId;
        delete base.candidateHash;
        const candidateHash = sha256Json(base);
        return deepFreeze({
          candidateClaimVersionId: `candidate:v1:${candidateHash}`,
          candidateHash,
          ...base,
        });
      });
    },
  });
}

function isPinnedModelAttachmentObservation(observation) {
  const extraction = observation?.normalizedPayload?.extraction;
  return observation?.sourceObjectType === "gmail_attachment_extracted"
    && observation?.normalizedPayload?.schemaVersion === "gmail-attachment-extracted-v1"
    && extraction?.status === "extracted"
    && extraction?.method === MODEL_ATTACHMENT_METHOD
    && extraction?.provenance === MODEL_ATTACHMENT_PROVENANCE
    && extraction?.reviewRequired === true
    && extraction?.modelSnapshot === GMAIL_ATTACHMENT_MODEL
    && extraction?.promptVersion === GMAIL_ATTACHMENT_MODEL_PROMPT_VERSION
    && extraction?.responseSchemaVersion === GMAIL_ATTACHMENT_MODEL_RESPONSE_SCHEMA_VERSION
    && /^gmail-attachment-model-request:v1:[0-9a-f]{64}$/.test(String(extraction?.requestId || ""))
    && typeof extraction?.providerResponseId === "string"
    && extraction.providerResponseId.length > 0
    && extraction?.assessedAllPages === true
    && Number.isSafeInteger(extraction?.pageCount)
    && extraction.pageCount >= 1
    && extraction.pagesAssessed === extraction.pageCount;
}

function normalizeJob(job) {
  if (!isPlainObject(job)) throw new TruthClaimWorkerError("Claimed truth job must be an object", {
    code: "TRUTH_CLAIM_JOB_INVALID",
  });
  if (!SUPPORTED_JOB_KINDS[job.jobKind]) throw new TruthClaimWorkerError(`Unsupported truth job kind ${job.jobKind}`, {
    code: "TRUTH_CLAIM_JOB_KIND_UNSUPPORTED",
  });
  string(job.jobId, "job.jobId");
  integer(job.leaseFence, "job.leaseFence", { minimum: 1 });
  if (!OBSERVATION_ID_RE.test(String(job.observationId || ""))) {
    throw new TruthClaimWorkerError("Claimed truth job lacks an immutable observation identity", {
      code: "TRUTH_CLAIM_JOB_INVALID",
    });
  }
  return job;
}

function validateObservation(job, observation) {
  const contract = SUPPORTED_JOB_KINDS[job.jobKind];
  if (!isPlainObject(observation)
    || observation.observationId !== job.observationId
    || observation.sourceSystem !== contract.sourceSystem
    || observation.sourceObjectType !== contract.sourceObjectType
    || observation.sourceObjectId !== job.sourceObjectId
    || observation.operation !== "content"
    || !HASH_RE.test(String(observation.contentHash || ""))
    || typeof observation.normalizedText !== "string"
    || !isPlainObject(observation.normalizedPayload)
    || observation.normalizedPayload.schemaVersion !== contract.payloadSchemaVersion
    || sha256Json(observation.normalizedPayload) !== observation.contentHash) {
    throw new TruthClaimWorkerError("Claim observation loader returned mismatched or incomplete evidence", {
      code: "TRUTH_CLAIM_OBSERVATION_INVALID",
    });
  }
  if (job.jobKind === ATTACHMENT_JOB_KIND) {
    const extraction = observation.normalizedPayload.extraction;
    if (!isPlainObject(extraction)
      || extraction.status !== "extracted"
      || typeof extraction.reviewRequired !== "boolean"
      || typeof extraction.method !== "string"
      || !extraction.method
      || observation.normalizedPayload.attachmentId !== job.sourceObjectId
      || (job.payload?.contentHash && job.payload.contentHash !== observation.contentHash)) {
      throw new TruthClaimWorkerError("Attachment claim job lacks exact extracted-attachment provenance", {
        code: "TRUTH_CLAIM_ATTACHMENT_PROVENANCE_INVALID",
      });
    }
  } else if (job.jobKind === TMS_JOB_KIND) {
    const shipment = observation.normalizedPayload.shipment;
    const payload = job.payload;
    if (!isPlainObject(shipment)
      || !isPlainObject(payload)
      || payload.schemaVersion !== "tms-extract-claims-job-v1"
      || payload.sourceObservationId !== observation.observationId
      || String(payload.shipmentGuid || "").toLowerCase() !== observation.sourceObjectId
      || String(shipment.shipmentGuid || "").toLowerCase() !== observation.sourceObjectId
      || payload.sourceSnapshotTime !== observation.normalizedPayload.snapshotTime
      || payload.trackingNumber !== shipment.trackingNumber) {
      throw new TruthClaimWorkerError("TMS claim job lacks exact shipment-snapshot provenance", {
        code: "TRUTH_CLAIM_TMS_PROVENANCE_INVALID",
      });
    }
  } else if (job.jobKind === TRACKING_JOB_KIND) {
    const payload = job.payload;
    const normalizedPayload = observation.normalizedPayload;
    if (!isPlainObject(payload)
      || payload.schemaVersion !== "tracking-extract-claims-job-v1"
      || payload.sourceObservationId !== observation.observationId
      || payload.awb !== observation.sourceObjectId
      || normalizedPayload.awb !== observation.sourceObjectId
      || payload.sourceSnapshotTime !== normalizedPayload.snapshotTime
      || payload.contentHash !== observation.contentHash
      || payload.healthStatus !== normalizedPayload.sourceHealth?.status
      || payload.extractorVersion !== TRACKING_EXTRACTOR_VERSION) {
      throw new TruthClaimWorkerError("Tracking claim job lacks exact source-snapshot provenance", {
        code: "TRUTH_CLAIM_TRACKING_PROVENANCE_INVALID",
      });
    }
  } else if (job.jobKind === OPERATOR_JOB_KIND) {
    const payload = job.payload;
    const event = observation.normalizedPayload.event;
    if (!isPlainObject(payload)
      || !isPlainObject(event)
      || payload.schemaVersion !== "operator-extract-claims-job-v1"
      || payload.sourceObservationId !== observation.observationId
      || payload.eventId !== observation.sourceObjectId
      || event.eventId !== observation.sourceObjectId
      || payload.eventSequence !== String(event.sequence || "")
      || payload.contentHash !== observation.contentHash
      || payload.extractorVersion !== OPERATOR_EXTRACTOR_VERSION) {
      throw new TruthClaimWorkerError("Operator claim job lacks exact append-only event provenance", {
        code: "TRUTH_CLAIM_OPERATOR_PROVENANCE_INVALID",
      });
    }
  }
  return contract;
}

function exactTextCitation(candidate, observation) {
  const span = candidate?.evidenceSpan;
  return isPlainObject(span)
    && Number.isSafeInteger(span.start)
    && Number.isSafeInteger(span.end)
    && span.start >= 0
    && span.end > span.start
    && span.unit === "utf16_code_units"
    && typeof span.quote === "string"
    && typeof observation?.normalizedText === "string"
    && observation.normalizedText.slice(span.start, span.end) === span.quote;
}

function exactStructuredCitation(candidate, observation) {
  const span = candidate?.evidenceSpan;
  if (!isPlainObject(span)
    || Object.keys(span).sort().join(",") !== "kind,path,valueHash,valuePreview"
    || span.kind !== "structured_field"
    || !Array.isArray(span.path)
    || span.path.length === 0
    || span.path.some((key) => typeof key !== "string" || !key)
    || !HASH_RE.test(String(span.valueHash || ""))
    || typeof span.valuePreview !== "string") return false;
  let value = observation?.normalizedPayload;
  for (const key of span.path) {
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, key)) return false;
    value = value[key];
  }
  const preview = String(typeof value === "string" ? value : JSON.stringify(canonicalize(value))).trim().slice(0, 500);
  return sha256Json(value) === span.valueHash && preview === span.valuePreview;
}

function exactCitation(candidate, observation) {
  if ([
    "tms_shipment_snapshot",
    "tracking_shipment_snapshot",
    "operator_event",
  ].includes(observation?.sourceObjectType)) {
    return exactStructuredCitation(candidate, observation);
  }
  return exactTextCitation(candidate, observation);
}

function sourceAutoAcceptEligible(observation) {
  if (observation?.sourceObjectType === "gmail_message_parsed") return true;
  if (observation?.sourceObjectType === "tms_shipment_snapshot") return true;
  if (observation?.sourceObjectType === "tracking_shipment_snapshot") {
    return safeTrackingAssessment(observation)?.eligible === true;
  }
  if (observation?.sourceObjectType === "operator_event") {
    const assessment = safeOperatorAssessment(observation);
    return assessment?.candidateSafe === true
      && assessment.reviewRequired === false
      && assessment.observation?.event?.eventType === "assertion";
  }
  if (observation?.sourceObjectType !== "gmail_attachment_extracted") return false;
  const extraction = observation.normalizedPayload?.extraction;
  return extraction?.status === "extracted"
    && extraction.reviewRequired === false
    && DETERMINISTIC_ATTACHMENT_METHODS.has(extraction.method);
}

function trackingPredicatePolicyEligible(candidate, observation, policy) {
  const assessment = safeTrackingAssessment(observation);
  if (!assessment?.eligible || !assessment.event) return false;
  const value = candidate.normalizedValue;
  const allowedKeys = new Set([
    "status", "effect", "sourceClass", "responsibleActor", "evidenceDirectness",
    "carrier", "eventCode", "eventDescription", "station", "eventTimeLocal",
  ]);
  const arrival = new Set(["ARR", "RCF", "AWD"]).has(assessment.eventCode);
  const expectedPredicate = arrival ? "arrival_confirmed" : "transport_in_transit";
  const latest = assessment.event.event;
  return candidate.schemaVersion === "tracking-candidate-claim-v1"
    && candidate.extractorVersion === TRACKING_EXTRACTOR_VERSION
    && candidate.sourceObjectType === "tracking_shipment_snapshot"
    && candidate.sourceObjectId === observation.sourceObjectId
    && candidate.sourceCapturedAt === observation.capturedAt
    && candidate.subjectType === "shipment"
    && candidate.subjectKey === assessment.awb
    && sameJson(candidate.appliesToAwbs, [assessment.awb])
    && candidate.predicate === expectedPredicate
    && candidate.gate === policy.gate
    && candidate.polarity === "positive"
    && Object.keys(value).length === allowedKeys.size
    && Object.keys(value).every((key) => allowedKeys.has(key))
    && value.sourceClass === "tracking"
    && value.responsibleActor === "carrier_tracking"
    && value.evidenceDirectness === "direct_provider_event"
    && value.carrier === text(observation.normalizedPayload.carrier)
    && value.eventCode === assessment.eventCode
    && value.eventDescription === text(latest.description)
    && value.station === text(latest.station)
    && value.eventTimeLocal === text(latest.timeLocal)
    && candidate.occurredAt === null
    && candidate.confidence === (arrival ? 0.96 : 0.95)
    && candidate.confidenceLabel === "high"
    && sameJson(candidate.evidenceSpan?.path, assessment.event.path);
}

function operatorPredicatePolicyEligible(candidate, observation, policy) {
  const assessment = safeOperatorAssessment(observation);
  if (!assessment?.candidateSafe
    || assessment.reviewRequired
    || assessment.observation?.event?.eventType !== "assertion") return false;
  const event = assessment.observation.event;
  const value = candidate.normalizedValue;
  const valueKeys = Object.keys(value).sort();
  return candidate.schemaVersion === "operator-candidate-claim-v1"
    && candidate.extractorVersion === OPERATOR_EXTRACTOR_VERSION
    && candidate.sourceObjectType === "operator_event"
    && candidate.sourceObjectId === observation.sourceObjectId
    && candidate.sourceCapturedAt === observation.capturedAt
    && candidate.subjectType === assessment.subject.type
    && candidate.subjectKey === (
      assessment.subject.type === "shipment"
        ? assessment.awbs[0]
        : text(assessment.subject.workgroupKey)
    )
    && sameJson(candidate.appliesToAwbs, assessment.awbs)
    && candidate.predicate === assessment.predicate
    && candidate.gate === policy.gate
    && candidate.polarity === assessment.polarity
    && sameJson(value, assessment.assertion.value)
    && sameJson(valueKeys, ["effect", "status"])
    && candidate.occurredAt === event.occurredAt
    && canonicalTimestamp(candidate.occurredAt) !== ""
    && candidate.confidence === 1
    && candidate.confidenceLabel === "high"
    && sameJson(candidate.evidenceSpan?.path, ["event", "assertion"]);
}

function predicatePolicyEligible(candidate, observation) {
  const sourceObjectType = observation?.sourceObjectType;
  const policy = (sourceObjectType === "tms_shipment_snapshot" ? TMS_PREDICATES : PREDICATES)[candidate?.predicate];
  if (!policy
    || candidate.gate !== policy.gate
    || !isPlainObject(candidate.normalizedValue)) return false;
  const value = candidate.normalizedValue;
  if (value.status !== policy.statuses[candidate.polarity]
    || value.effect !== policy.effects[candidate.polarity]) return false;
  const isTms = sourceObjectType === "tms_shipment_snapshot";
  if (sourceObjectType === "tracking_shipment_snapshot") {
    return trackingPredicatePolicyEligible(candidate, observation, policy);
  }
  if (sourceObjectType === "operator_event") {
    return operatorPredicatePolicyEligible(candidate, observation, policy);
  }
  if (isTms) {
    if (candidate.predicate === "shipment_observed_in_tms") {
      const shipment = observation.normalizedPayload?.shipment;
      const trackingNumber = text(shipment?.trackingNumber).replace(/\D/g, "");
      const statusField = shipment?.tmsStatus ? "tmsStatus" : "status";
      const tmsStatus = text(shipment?.[statusField]);
      const statusCode = Number(tmsStatus.toUpperCase().match(/^(\d{3})/)?.[1] || 0) || null;
      const expectedValue = {
        status: "observed",
        effect: "context",
        sourceClass: "tms",
        responsibleActor: "automated_system",
        evidenceDirectness: "operational_summary",
        tmsStatus,
        statusCode,
      };
      return candidate.schemaVersion === "tms-candidate-claim-v1"
        && candidate.extractorVersion === TMS_EXTRACTOR_VERSION
        && candidate.sourceObjectType === "tms_shipment_snapshot"
        && candidate.sourceObjectId === text(shipment?.shipmentGuid).toLowerCase()
        && candidate.sourceObjectId === observation.sourceObjectId
        && candidate.subjectType === "shipment"
        && candidate.subjectKey === trackingNumber
        && trackingNumber.length === 11
        && tmsStatus.length > 0
        && sameJson(candidate.appliesToAwbs, [trackingNumber])
        && candidate.gate === "context"
        && candidate.polarity === "neutral"
        && sameJson(value, expectedValue)
        && candidate.occurredAt === null
        && candidate.confidence === 1
        && candidate.confidenceLabel === "high"
        && sameJson(candidate.evidenceSpan?.path, ["shipment", statusField]);
    }
    const allowedKeys = new Set([
      "status", "effect", "sourceClass", "responsibleActor", "evidenceDirectness",
      "tmsStatus", "statusCode", "tmsField", "tmsFieldValue",
      "deliveryActualArrivalTime", "temporal",
    ]);
    if (candidate.schemaVersion !== "tms-candidate-claim-v1"
      || candidate.extractorVersion !== TMS_EXTRACTOR_VERSION
      || candidate.sourceObjectType !== "tms_shipment_snapshot"
      || candidate.sourceObjectId !== observation.sourceObjectId
      || Object.keys(value).some((key) => !allowedKeys.has(key))
      || value.sourceClass !== "tms"
      || value.responsibleActor !== "automated_system"
      || value.evidenceDirectness !== "operational_summary"
      || typeof value.tmsStatus !== "string"
      || !value.tmsStatus
      || !Number.isSafeInteger(value.statusCode)) return false;
    const exactStatusRules = {
      arrival_confirmed: [
        [280, /^280-ARR@DEST(?:$|[^A-Z0-9])/i],
        [295, /^295-CUSTOMS REL(?:$|[^A-Z0-9])/i],
        [320, /^320-OUT FOR DEL(?:$|[^A-Z0-9])/i],
      ],
      transport_in_transit: [
        [240, /^240-DROPPED@A\/L(?:$|[^A-Z0-9])/i],
        [270, /^270-INTRANSIT(?:$|[^A-Z0-9])/i],
        [275, /^275-CONF ONBOAR(?:$|[^A-Z0-9])/i],
      ],
      out_for_delivery: [[320, /^320-OUT FOR DEL(?:$|[^A-Z0-9])/i]],
    };
    if (!exactStatusRules[candidate.predicate]?.some(
      ([statusCode, pattern]) => value.statusCode === statusCode && pattern.test(value.tmsStatus),
    )) return false;
  } else {
    const allowedKeys = new Set(["status", "effect", "temporal", "lastFreeDay"]);
    if (candidate.schemaVersion !== "gmail-candidate-claim-v1"
      || candidate.extractorVersion !== GMAIL_EXTRACTOR_VERSION
      || !["gmail_message_parsed", "gmail_attachment_extracted"].includes(observation?.sourceObjectType)
      || Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  }
  const temporal = value.temporal;
  if (temporal === undefined) {
    if (candidate.occurredAt !== null && (
      candidate.extractorVersion !== GMAIL_EXTRACTOR_VERSION
      || canonicalTimestamp(candidate.occurredAt) === ""
      || canonicalTimestamp(observation?.sourceRecordedAt) === ""
      || candidate.occurredAt !== observation.sourceRecordedAt
      || candidate.extractionMethod !== "deterministic"
    )) return false;
  } else {
    if (!isPlainObject(temporal)
      || Object.keys(temporal).sort().join(",") !== "basis,confidence,expression,occurredOn,resolverVersion,status"
      || temporal.resolverVersion !== "truth-temporal-resolver-v1"
      || !["exact", "date_only", "ambiguous", "future_conflict"].includes(temporal.status)
      || (temporal.occurredOn !== null && !isIsoDate(temporal.occurredOn))
      || typeof temporal.basis !== "string" || !temporal.basis
      || typeof temporal.expression !== "string" || !temporal.expression
      || !(isTms ? candidate.evidenceSpan?.valuePreview : candidate.evidenceSpan?.quote)
        ?.includes(temporal.expression)
      || typeof temporal.confidence !== "number" || !Number.isFinite(temporal.confidence)
      || temporal.confidence < 0 || temporal.confidence > 1
      || Math.round(temporal.confidence * 1_000_000) / 1_000_000 !== temporal.confidence
      || ["ambiguous", "future_conflict"].includes(temporal.status)) return false;
    const sourceTimestamp = Date.parse(
      observation?.normalizedPayload?.date
      || observation?.normalizedPayload?.snapshotTime
      || observation?.capturedAt
      || "",
    );
    const sourceDate = Number.isFinite(sourceTimestamp)
      ? new Date(sourceTimestamp).toISOString().slice(0, 10)
      : null;
    if (temporal.status === "date_only"
      && ["complete", "block"].includes(value.effect)
      && sourceDate
      && temporal.occurredOn > sourceDate) return false;
    if (temporal.status === "exact") {
      const occurred = Date.parse(candidate.occurredAt);
      if (!Number.isFinite(occurred) || !temporal.occurredOn) return false;
      const source = Date.parse(observation?.normalizedPayload?.date || observation?.capturedAt || "");
      if (["complete", "block"].includes(value.effect)
        && Number.isFinite(source)
        && occurred > source + 60 * 60 * 1000) return false;
    } else if (candidate.occurredAt !== null
      || (temporal.status === "date_only" && !temporal.occurredOn)
      || (temporal.status === "ambiguous" && temporal.occurredOn !== null)
      || (temporal.status === "future_conflict" && !temporal.occurredOn)) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "lastFreeDay")) {
    if (candidate.predicate !== "last_free_day"
      || !isIsoDate(value.lastFreeDay)
      || value.lastFreeDay !== temporal?.occurredOn) return false;
  }
  return Boolean(policy)
    && candidate.gate === policy.gate
    && value.status === policy.statuses[candidate.polarity]
    && value.effect === policy.effects[candidate.polarity];
}

function policyAcceptanceEligible(candidate, observation, policyVersion) {
  return isPlainObject(candidate)
    && candidate.extractionMethod === "deterministic"
    && candidate.model === ""
    && candidate.promptVersion === ""
    && candidate.sourceObservationId === observation?.observationId
    && candidate.sourceObservationContentHash === observation?.contentHash
    && HASH_RE.test(String(candidate.sourceObservationContentHash || ""))
    && isPlainObject(candidate.ambiguity)
    && candidate.ambiguity.status === "none"
    && Array.isArray(candidate.ambiguity.reasons)
    && candidate.ambiguity.reasons.length === 0
    && isPlainObject(candidate.contradiction)
    && candidate.contradiction.status === "none"
    && Array.isArray(candidate.contradiction.acceptedClaimVersionIds)
    && candidate.contradiction.acceptedClaimVersionIds.length === 0
    && Array.isArray(candidate.contradiction.reasons)
    && candidate.contradiction.reasons.length === 0
    && isPlainObject(candidate.acceptanceRecommendation)
    && candidate.acceptanceRecommendation.decision === "accept"
    && candidate.acceptanceRecommendation.method === "policy"
    && candidate.acceptanceRecommendation.policyVersion === policyVersion
    && predicatePolicyEligible(candidate, observation)
    && sourceAutoAcceptEligible(observation)
    && exactCitation(candidate, observation);
}

function policyCorrectionEligible(candidate, observation, policyVersion) {
  const contradictionIds = candidate?.contradiction?.acceptedClaimVersionIds;
  return isPlainObject(candidate)
    && ["gmail_message_parsed", "gmail_attachment_extracted", "tms_shipment_snapshot", "tracking_shipment_snapshot"]
      .includes(observation?.sourceObjectType)
    && candidate.extractionMethod === "deterministic"
    && candidate.model === ""
    && candidate.promptVersion === ""
    && candidate.sourceObservationId === observation?.observationId
    && candidate.sourceObservationContentHash === observation?.contentHash
    && HASH_RE.test(String(candidate.sourceObservationContentHash || ""))
    && canonicalTimestamp(candidate.occurredAt) !== ""
    && isPlainObject(candidate.ambiguity)
    && candidate.ambiguity.status === "none"
    && Array.isArray(candidate.ambiguity.reasons)
    && candidate.ambiguity.reasons.length === 0
    && isPlainObject(candidate.contradiction)
    && candidate.contradiction.status === "known"
    && Array.isArray(contradictionIds)
    && contradictionIds.length > 0
    && new Set(contradictionIds).size === contradictionIds.length
    && contradictionIds.every((id) => /^claim:v1:[0-9a-f]{64}$/.test(String(id)))
    && Array.isArray(candidate.contradiction.reasons)
    && candidate.contradiction.reasons.length > 0
    && isPlainObject(candidate.acceptanceRecommendation)
    && candidate.acceptanceRecommendation.decision === "accept"
    && candidate.acceptanceRecommendation.method === "policy"
    && candidate.acceptanceRecommendation.policyVersion === policyVersion
    && predicatePolicyEligible(candidate, observation)
    && sourceAutoAcceptEligible(observation)
    && exactCitation(candidate, observation);
}

function safeErrorCode(error) {
  const candidate = String(error?.code || "TRUTH_CLAIM_JOB_FAILED").toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : "TRUTH_CLAIM_JOB_FAILED";
}

function stableCandidateResult(candidateReceipt, candidate, resolution = null, pendingDisposition = "pending") {
  const result = {
    candidateClaimVersionId: candidateReceipt.candidateClaimVersionId,
    candidateItemHash: candidateReceipt.itemHash,
    extractionMethod: candidate.extractionMethod,
    recommendation: candidate.acceptanceRecommendation.decision,
    disposition: resolution?.disposition || pendingDisposition,
  };
  if (resolution) {
    result.decisionVersionId = resolution.decisionVersionId;
    result.decisionItemHash = resolution.decisionItemHash;
  }
  if (resolution?.disposition === "accepted") {
    result.acceptedClaimVersionId = resolution.acceptedClaimVersionId;
    result.acceptedClaimItemHash = resolution.acceptedClaimItemHash;
    result.bindingId = resolution.bindingId;
    result.bindingItemHash = resolution.bindingItemHash;
  }
  return result;
}

function createTruthClaimWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const jobLedger = requireMethod(options.jobLedger, "claimJobs", "jobLedger");
  requireMethod(jobLedger, "renewJob", "jobLedger");
  requireMethod(jobLedger, "completeJob", "jobLedger");
  requireMethod(jobLedger, "failJob", "jobLedger");
  const candidateLedger = requireMethod(
    options.candidateLedger,
    "appendAndSealJobCandidates",
    "candidateLedger",
  );
  requireMethod(candidateLedger, "getJobState", "candidateLedger");
  const defaultExtractor = options.extractor || null;
  const suppliedExtractors = options.extractors ?? null;
  if (suppliedExtractors !== null && !isPlainObject(suppliedExtractors)) {
    throw invalidArgument("extractors", "must be an object keyed by supported job kind");
  }
  const extractors = new Map();
  const messageExtractor = suppliedExtractors?.[JOB_KIND] || defaultExtractor;
  extractors.set(JOB_KIND, requireMethod(messageExtractor, "extract", `extractors.${JOB_KIND}`));
  const attachmentExtractor = suppliedExtractors?.[ATTACHMENT_JOB_KIND]
    || createAttachmentClaimExtractorAdapter(messageExtractor);
  extractors.set(
    ATTACHMENT_JOB_KIND,
    requireMethod(attachmentExtractor, "extract", `extractors.${ATTACHMENT_JOB_KIND}`),
  );
  const tmsExtractor = suppliedExtractors?.[TMS_JOB_KIND] || createTmsClaimExtractor();
  extractors.set(TMS_JOB_KIND, requireMethod(tmsExtractor, "extract", `extractors.${TMS_JOB_KIND}`));
  const trackingExtractor = suppliedExtractors?.[TRACKING_JOB_KIND] || createTrackingClaimExtractor();
  extractors.set(
    TRACKING_JOB_KIND,
    requireMethod(trackingExtractor, "extract", `extractors.${TRACKING_JOB_KIND}`),
  );
  const operatorExtractor = suppliedExtractors?.[OPERATOR_JOB_KIND] || createOperatorClaimExtractor();
  extractors.set(
    OPERATOR_JOB_KIND,
    requireMethod(operatorExtractor, "extract", `extractors.${OPERATOR_JOB_KIND}`),
  );
  const loadObservation = options.loadObservation;
  const loadWorkgroupContext = options.loadWorkgroupContext || (async () => null);
  const loadAcceptedClaims = options.loadAcceptedClaims || (async () => []);
  if (typeof loadObservation !== "function") throw invalidArgument("loadObservation", "must be a function");
  if (typeof loadWorkgroupContext !== "function") throw invalidArgument("loadWorkgroupContext", "must be a function");
  if (typeof loadAcceptedClaims !== "function") throw invalidArgument("loadAcceptedClaims", "must be a function");
  const workerId = string(options.workerId, "workerId");
  const processorVersion = string(options.processorVersion, "processorVersion");
  const policyVersion = string(options.policyVersion, "policyVersion");
  const suppliedPolicyVersions = options.policyVersions ?? {};
  if (!isPlainObject(suppliedPolicyVersions)) {
    throw invalidArgument("policyVersions", "must be an object keyed by supported job kind");
  }
  const policyVersions = Object.freeze({
    [JOB_KIND]: string(suppliedPolicyVersions[JOB_KIND] || policyVersion, `policyVersions.${JOB_KIND}`),
    [ATTACHMENT_JOB_KIND]: string(
      suppliedPolicyVersions[ATTACHMENT_JOB_KIND] || policyVersion,
      `policyVersions.${ATTACHMENT_JOB_KIND}`,
    ),
    [TMS_JOB_KIND]: string(
      suppliedPolicyVersions[TMS_JOB_KIND] || TMS_ACCEPTANCE_POLICY_VERSION,
      `policyVersions.${TMS_JOB_KIND}`,
    ),
    [TRACKING_JOB_KIND]: string(
      suppliedPolicyVersions[TRACKING_JOB_KIND] || TRACKING_ACCEPTANCE_POLICY_VERSION,
      `policyVersions.${TRACKING_JOB_KIND}`,
    ),
    [OPERATOR_JOB_KIND]: string(
      suppliedPolicyVersions[OPERATOR_JOB_KIND] || OPERATOR_ACCEPTANCE_POLICY_VERSION,
      `policyVersions.${OPERATOR_JOB_KIND}`,
    ),
  });
  const leaseSeconds = integer(options.leaseSeconds ?? 300, "leaseSeconds", { minimum: 30, maximum: 900 });
  // SQL accepts either NULL (use the server-owned exponential backoff) or an
  // explicit delay from 1 through 86,400 seconds.  Passing 0 used to turn the
  // original extraction failure into a second 22023 acknowledgement failure,
  // leaving the job leased until expiry and hiding the real error.
  const retryAfterSeconds = options.retryAfterSeconds === undefined
      || options.retryAfterSeconds === null
    ? null
    : integer(options.retryAfterSeconds, "retryAfterSeconds", {
      minimum: 1,
      maximum: 86_400,
    });

  function fenced(job) {
    return {
      jobId: job.jobId,
      workerId,
      leaseFence: job.leaseFence,
      processorVersion,
    };
  }

  function assertRuntime(runtime, stage, outcomeUnknown = false) {
    throwIfAborted(runtime.signal, {
      stage,
      deadlineAtMs: runtime.deadlineAtMs,
      outcomeUnknown,
    });
  }

  async function processJob(rawJob, runtime = {}) {
    const job = normalizeJob(rawJob);
    throwIfAborted(runtime.signal, {
      stage: `truth claim job ${job.jobId}`,
      deadlineAtMs: runtime.deadlineAtMs,
    });
    const jobPolicyVersion = policyVersions[job.jobKind];
    const observation = await loadObservation(job);
    const sourceContract = validateObservation(job, observation);
    assertRuntime(runtime, `truth claim persisted state read ${job.jobId}`);
    const persisted = await candidateLedger.getJobState(fenced(job));
    let candidatePairs;
    if (persisted.sealed) {
      candidatePairs = persisted.candidates.map((item) => ({
        candidate: item.candidate,
        receipt: {
          candidateClaimVersionId: item.candidateClaimVersionId,
          itemHash: item.itemHash,
        },
      }));
    } else {
      // A finalized attachment-model observation is already forced through
      // operator review candidate-by-candidate. Its candidate identity must be
      // bound to the exact immutable OCR text, but it must not wait on the
      // workspace-wide claim-context reader: the serialized acceptance epoch
      // orders it against canonical claims later. This keeps each OCR claim
      // producer bounded by one observation and one manifest while preserving
      // the mandatory review boundary.
      const deferModelAttachmentContext = job.jobKind === ATTACHMENT_JOB_KIND
        && isPinnedModelAttachmentObservation(observation);
      const [workgroupContext, acceptedClaims] = deferModelAttachmentContext
        ? [null, []]
        : await Promise.all([
          loadWorkgroupContext(job, observation),
          loadAcceptedClaims(job, observation),
        ]);
      if (workgroupContext !== null && !isPlainObject(workgroupContext)) {
        throw new TruthClaimWorkerError("Workgroup context loader returned an invalid value", {
          code: "TRUTH_CLAIM_CONTEXT_INVALID",
        });
      }
      if (!Array.isArray(acceptedClaims)) {
        throw new TruthClaimWorkerError("Accepted-claim context loader must return an array", {
          code: "TRUTH_CLAIM_CONTEXT_INVALID",
        });
      }
      const candidates = await extractors.get(job.jobKind).extract({
        observation,
        workgroupContext,
        acceptedClaims,
        sourceContract,
        signal: runtime.signal || null,
        deadlineAtMs: runtime.deadlineAtMs || null,
      });
      if (!Array.isArray(candidates)) {
        throw new TruthClaimWorkerError("Claim extractor must return an array", {
          code: "TRUTH_CLAIM_EXTRACTOR_INVALID",
        });
      }
      // The extraction/context phase can be expensive. Renew the same fence
      // before the first durable candidate write rather than relying on the
      // original claim window.
      assertRuntime(runtime, `truth claim lease renewal ${job.jobId}`);
      await jobLedger.renewJob({ ...fenced(job), leaseSeconds });
      assertRuntime(runtime, `truth candidate seal ${job.jobId}`);
      const sealed = await candidateLedger.appendAndSealJobCandidates({
        ...fenced(job),
        candidates,
      });
      candidatePairs = candidates.map((candidate, index) => ({
        candidate,
        receipt: sealed.candidateReceipts[index],
      }));
    }

    // Every source remains extraction-only until a source-cut acceptance
    // coordinator can order competing assertions across Gmail, attachments,
    // TMS, tracking, and operator evidence. A retry resumes this exact sealed
    // set and never re-extracts against its own prior writes.
    assertRuntime(runtime, `truth claim lease renewal ${job.jobId}`);
    await jobLedger.renewJob({ ...fenced(job), leaseSeconds });
    const resultCandidates = [];
    for (const { candidate, receipt: candidateReceipt } of candidatePairs) {
      resultCandidates.push(stableCandidateResult(
        candidateReceipt,
        candidate,
        null,
        PENDING_ACCEPTANCE_COORDINATOR,
      ));
    }
    resultCandidates.sort((left, right) =>
      left.candidateClaimVersionId.localeCompare(right.candidateClaimVersionId));
    const acceptedCount = resultCandidates.filter((item) => item.disposition === "accepted").length;
    const rejectedCount = resultCandidates.filter((item) => item.disposition === "rejected").length;
    const reviewCount = resultCandidates.filter((item) => item.disposition === "review").length;
    const pendingCount = resultCandidates.filter((item) => (
      item.disposition === "pending"
      || item.disposition === "review"
      || item.disposition === PENDING_ACCEPTANCE_COORDINATOR
    )).length;
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      processorVersion,
      acceptancePolicyVersion: jobPolicyVersion,
      jobKind: job.jobKind,
      sourceObservationId: observation.observationId,
      candidateCount: resultCandidates.length,
      acceptedCount,
      rejectedCount,
      reviewCount,
      pendingCount,
      acceptanceDisposition: PENDING_ACCEPTANCE_COORDINATOR,
      canonicalMutationCount: 0,
      candidates: resultCandidates,
    };
    assertRuntime(runtime, `truth claim completion ${job.jobId}`);
    const completion = await jobLedger.completeJob({
      ...fenced(job),
      result,
      observations: [],
      childJobs: [],
    });
    return deepFreeze({
      ok: true,
      jobId: job.jobId,
      completion,
      result,
    });
  }

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("runOnce", "must be an object");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("signal", "must be an AbortSignal or null");
    throwIfAborted(signal, { stage: "truth claim worker claim", deadlineAtMs: input.deadlineAtMs });
    const limit = integer(input.limit ?? 10, "limit", { minimum: 1, maximum: 50 });
    throwIfAborted(signal, { stage: "truth claim worker claim", deadlineAtMs: input.deadlineAtMs });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: Object.keys(SUPPORTED_JOB_KINDS).sort(),
    });
    if (!Array.isArray(claim?.jobs)) {
      throw new TruthClaimWorkerError("Source-processing ledger returned an invalid claim receipt", {
        code: "TRUTH_CLAIM_JOB_CLAIM_INVALID",
      });
    }
    const jobs = [];
    for (const rawJob of claim.jobs) {
      try {
        throwIfAborted(signal, {
          stage: `truth claim job ${rawJob?.jobId || "unknown"}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        jobs.push(await processJob(rawJob, { signal, deadlineAtMs: input.deadlineAtMs }));
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `truth claim job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `truth claim job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
            outcomeUnknown: error?.outcomeUnknown === true,
          });
        }
        throwIfAborted(signal, {
          stage: `truth claim failure acknowledgement ${rawJob?.jobId || "unknown"}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const job = isPlainObject(rawJob) ? rawJob : {};
        let failureReceipt = null;
        let failureAcknowledgementError = null;
        try {
          throwIfAborted(signal, {
            stage: `truth claim failure acknowledgement ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
          failureReceipt = await jobLedger.failJob({
            ...fenced(job),
            errorCode: safeErrorCode(error),
            safeErrorDetail: error?.message || String(error),
            retryAfterSeconds,
          });
        } catch (acknowledgementError) {
          if (acknowledgementError?.outcomeUnknown === true || isAbortError(acknowledgementError, signal)) {
            throw asOutcomeUnknownError(acknowledgementError, {
              signal,
              stage: `truth claim failure acknowledgement ${rawJob?.jobId || "unknown"}`,
              deadlineAtMs: input.deadlineAtMs,
            });
          }
          failureAcknowledgementError = {
            code: safeErrorCode(acknowledgementError),
            message: acknowledgementError?.message || String(acknowledgementError),
          };
        }
        jobs.push(deepFreeze({
          ok: false,
          jobId: String(job.jobId || ""),
          errorCode: safeErrorCode(error),
          errorMessage: error?.message || String(error),
          failureReceipt,
          failureAcknowledgementError,
        }));
      }
    }
    const succeeded = jobs.filter((job) => job.ok).length;
    const acceptedCount = jobs.filter((job) => job.ok)
      .reduce((sum, job) => sum + job.result.acceptedCount, 0);
    const pendingCount = jobs.filter((job) => job.ok)
      .reduce((sum, job) => sum + job.result.pendingCount, 0);
    const rejectedCount = jobs.filter((job) => job.ok)
      .reduce((sum, job) => sum + job.result.rejectedCount, 0);
    const reviewCount = jobs.filter((job) => job.ok)
      .reduce((sum, job) => sum + job.result.reviewCount, 0);
    return deepFreeze({
      ok: jobs.every((job) => job.ok),
      claimedCount: claim.jobs.length,
      succeededCount: succeeded,
      failedCount: jobs.length - succeeded,
      acceptedCount,
      rejectedCount,
      reviewCount,
      pendingCount,
      jobs,
    });
  }

  return Object.freeze({
    jobKind: JOB_KIND,
    jobKinds: Object.freeze(Object.keys(SUPPORTED_JOB_KINDS).sort()),
    workerId,
    processorVersion,
    policyVersion,
    policyVersions,
    processJob,
    runOnce,
  });
}

module.exports = {
  ATTACHMENT_JOB_KIND,
  DETERMINISTIC_ATTACHMENT_METHODS,
  JOB_KIND,
  OPERATOR_JOB_KIND,
  TMS_JOB_KIND,
  TRACKING_JOB_KIND,
  LEGACY_RESULT_SCHEMA_VERSION,
  RESULT_SCHEMA_VERSION,
  PENDING_ACCEPTANCE_COORDINATOR,
  SUPPORTED_JOB_KINDS,
  TruthClaimWorkerError,
  createAttachmentClaimExtractorAdapter,
  createTruthClaimWorker,
  _test: {
    exactCitation,
    exactStructuredCitation,
    isPinnedModelAttachmentObservation,
    exactTextCitation,
    isIsoDate,
    operatorPredicatePolicyEligible,
    policyAcceptanceEligible,
    policyCorrectionEligible,
    predicatePolicyEligible,
    safeErrorCode,
    sourceAutoAcceptEligible,
    stableCandidateResult,
    trackingPredicatePolicyEligible,
    validateObservation,
  },
};

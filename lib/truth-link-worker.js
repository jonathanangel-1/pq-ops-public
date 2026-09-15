"use strict";

const crypto = require("node:crypto");
const { linkGmailObservations } = require("./gmail-cross-thread-linker");
const {
  asDeadlineError,
  asOutcomeUnknownError,
  isAbortError,
  isAbortSignal,
  throwIfAborted,
} = require("./runtime-deadline");

const JOB_KIND = "gmail_resolve_entity_links";
const RESULT_SCHEMA_VERSION = "truth-link-worker-result-v1";
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const AWB_RE = /^[0-9]{11}$/;

class TruthLinkWorkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthLinkWorkerError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalidArgument(field, reason) {
  return new TruthLinkWorkerError(`Invalid truth-link worker argument ${field}: ${reason}`, {
    code: "TRUTH_LINK_WORKER_INVALID_ARGUMENT",
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

function sortedUnique(values) {
  return [...new Set((values || []).filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
}

function sameStringSet(left, right) {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

function intersects(left, right) {
  const rightSet = new Set(right || []);
  return (left || []).some((item) => rightSet.has(item));
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

function normalizeAwb(value, field) {
  const normalized = String(value || "").replace(/\D/g, "");
  if (!AWB_RE.test(normalized)) throw invalidArgument(field, "must be a normalized 11-digit AWB");
  return normalized;
}

function normalizeJob(value) {
  if (!isPlainObject(value)) throw invalidArgument("job", "must be an object");
  const job = {
    jobId: string(value.jobId, "job.jobId"),
    jobKind: string(value.jobKind, "job.jobKind"),
    observationId: string(value.observationId, "job.observationId"),
    sourceObjectId: string(value.sourceObjectId, "job.sourceObjectId"),
    leaseFence: integer(value.leaseFence, "job.leaseFence", { minimum: 1 }),
    payload: isPlainObject(value.payload) ? value.payload : {},
  };
  if (job.jobKind !== JOB_KIND) throw invalidArgument("job.jobKind", `must be ${JOB_KIND}`);
  if (!OBSERVATION_ID_RE.test(job.observationId)) {
    throw invalidArgument("job.observationId", "must be an immutable observation identity");
  }
  return job;
}

function normalizeObservation(value, index) {
  const field = `context.observations[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  const observationId = string(value.observationId, `${field}.observationId`);
  const contentHash = string(value.contentHash, `${field}.contentHash`);
  if (!OBSERVATION_ID_RE.test(observationId)) throw invalidArgument(`${field}.observationId`, "is invalid");
  if (!HASH_RE.test(contentHash)) throw invalidArgument(`${field}.contentHash`, "is invalid");
  if (value.sourceSystem !== undefined && value.sourceSystem !== "gmail") {
    throw invalidArgument(`${field}.sourceSystem`, "must be gmail");
  }
  if (value.sourceObjectType !== undefined && value.sourceObjectType !== "gmail_message_parsed") {
    throw invalidArgument(`${field}.sourceObjectType`, "must be gmail_message_parsed");
  }
  if (!isPlainObject(value.parsedMessage)
    || value.parsedMessage.schemaVersion !== "gmail-parsed-message-v2"
    || !isPlainObject(value.parsedMessage.gmail)
    || !String(value.parsedMessage.gmail.messageId || "")) {
    throw invalidArgument(`${field}.parsedMessage`, "must be a parsed Gmail message with provider identity");
  }
  if (sha256Json(value.parsedMessage) !== contentHash) {
    throw new TruthLinkWorkerError("Parsed Gmail context does not match its immutable observation content hash", {
      code: "TRUTH_LINK_CONTEXT_CONTENT_MISMATCH",
      field,
      observationId,
    });
  }
  return value;
}

function normalizeCurrentWorkgroup(value, index) {
  const field = `context.currentWorkgroups[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  return {
    identityKey: string(value.identityKey, `${field}.identityKey`),
    shipmentKeys: sortedUnique((value.shipmentKeys || []).map((item, itemIndex) => (
      normalizeAwb(item, `${field}.shipmentKeys[${itemIndex}]`)
    ))),
    brokerKeys: sortedUnique((value.brokerKeys || []).map((item, itemIndex) => (
      string(item, `${field}.brokerKeys[${itemIndex}]`)
    ))),
    purposes: sortedUnique((value.purposes || []).map((item, itemIndex) => (
      string(item, `${field}.purposes[${itemIndex}]`)
    ))),
  };
}

function normalizeContradiction(value, index) {
  const field = `context.contradictions[${index}]`;
  if (!isPlainObject(value)) throw invalidArgument(field, "must be an object");
  const result = {
    candidateKey: value.candidateKey ? string(value.candidateKey, `${field}.candidateKey`) : "",
    observationId: value.observationId ? string(value.observationId, `${field}.observationId`) : "",
    entityKey: value.entityKey ? string(value.entityKey, `${field}.entityKey`) : "",
    workgroupIdentityKey: value.workgroupIdentityKey
      ? string(value.workgroupIdentityKey, `${field}.workgroupIdentityKey`)
      : "",
    reason: string(value.reason, `${field}.reason`),
  };
  if (!result.candidateKey && !result.observationId && !result.entityKey && !result.workgroupIdentityKey) {
    throw invalidArgument(field, "must identify a candidate, observation, entity, or workgroup");
  }
  return result;
}

function normalizeContext(value, job, maximum) {
  if (!isPlainObject(value)) throw invalidArgument("context", "must be an object");
  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    throw invalidArgument("context.observations", "must be a non-empty array");
  }
  if (value.observations.length > maximum) {
    throw new TruthLinkWorkerError("Cross-thread context exceeds its bounded observation limit", {
      code: "TRUTH_LINK_CONTEXT_LIMIT_EXCEEDED",
      maximum,
    });
  }
  const observations = value.observations.map(normalizeObservation)
    .sort((left, right) => left.observationId.localeCompare(right.observationId));
  if (new Set(observations.map((item) => item.observationId)).size !== observations.length) {
    throw invalidArgument("context.observations", "must contain unique immutable observation identities");
  }
  if (!observations.some((item) => item.observationId === job.observationId)) {
    throw new TruthLinkWorkerError("Cross-thread context omitted the job anchor observation", {
      code: "TRUTH_LINK_CONTEXT_ANCHOR_MISSING",
    });
  }
  const knownShipments = sortedUnique((value.knownShipments || []).map((item, index) => (
    normalizeAwb(isPlainObject(item) ? item.awb : item, `context.knownShipments[${index}]`)
  )));
  const knownBrokers = sortedUnique((value.knownBrokers || []).map((item, index) => (
    string(isPlainObject(item) ? item.brokerKey : item, `context.knownBrokers[${index}]`)
  )));
  const currentWorkgroups = (value.currentWorkgroups || []).map(normalizeCurrentWorkgroup);
  const contradictions = (value.contradictions || []).map(normalizeContradiction);
  if (knownShipments.length > 10_000 || knownBrokers.length > 2_000 || currentWorkgroups.length > 2_000) {
    throw new TruthLinkWorkerError("Cross-thread entity context exceeds its bounded entity limit", {
      code: "TRUTH_LINK_CONTEXT_LIMIT_EXCEEDED",
    });
  }
  return { observations, knownShipments, knownBrokers, currentWorkgroups, contradictions };
}

function contradictionReasons(context, fields) {
  return context.contradictions.filter((item) => (
    (item.candidateKey && item.candidateKey === fields.candidateKey)
    || (item.observationId && item.observationId === fields.observationId)
    || (item.entityKey && item.entityKey === fields.entityKey)
    || (item.workgroupIdentityKey && item.workgroupIdentityKey === fields.workgroupIdentityKey)
  )).map((item) => item.reason);
}

function groupHasMembershipChange(workgroup, context) {
  const basis = workgroup?.definition?.identityBasis || {};
  return context.currentWorkgroups.some((current) => {
    if (!sameStringSet(current.brokerKeys, basis.brokerKeys || [])) return false;
    if (!sameStringSet(current.purposes, basis.purposes || [])) return false;
    if (!intersects(current.shipmentKeys, basis.shipmentKeys || [])) return false;
    return !sameStringSet(current.shipmentKeys, basis.shipmentKeys || []);
  });
}

function exactCountMatchedGroup(workgroup) {
  return Boolean(
    workgroup?.autoAcceptEligible === true
    && workgroup?.requiresReview === false
    && workgroup?.definition?.createdMethod === "deterministic"
    && Array.isArray(workgroup?.reasons)
    && workgroup.reasons.some((reason) => (
      reason?.reasonCode === "broker_plural_reply_confirms_batch_scope"
      && reason?.exactCountConfirmed === true
    )),
  );
}

function evidenceIdsForLink(link) {
  return sortedUnique([
    link.observationId,
    ...(Array.isArray(link.evidenceSpan?.basisObservationIds) ? link.evidenceSpan.basisObservationIds : []),
  ]);
}

function evidenceIdsForWorkgroup(workgroup) {
  return sortedUnique([
    ...(workgroup.observationIds || []),
    ...(workgroup.evidence || []).map((item) => item?.observationId),
  ]);
}

function evidenceIdsForMembership(membership) {
  return sortedUnique((membership.evidence || []).map((item) => item?.observationId));
}

function assessment({ disposition, policyClass, reasons, conflict = false, membershipChange = false }) {
  const normalizedReasons = sortedUnique(reasons);
  return {
    policyDisposition: disposition,
    policyClass,
    conflict: Boolean(conflict),
    membershipChange: Boolean(membershipChange),
    reasons: normalizedReasons.length ? normalizedReasons : ["candidate requires operator review"],
  };
}

function buildProposals(resolution, context) {
  if (!isPlainObject(resolution)
    || resolution.schemaVersion !== "gmail-cross-thread-link-candidates-v1"
    || !Array.isArray(resolution.candidateLinks)
    || !Array.isArray(resolution.candidateWorkgroups)) {
    throw new TruthLinkWorkerError("Cross-thread linker returned an invalid candidate artifact", {
      code: "TRUTH_LINK_LINKER_OUTPUT_INVALID",
    });
  }
  const observationIds = new Set(context.observations.map((item) => item.observationId));
  const knownShipments = new Set(context.knownShipments);
  const knownBrokers = new Set(context.knownBrokers);
  const workgroups = new Map(resolution.candidateWorkgroups.map((item) => [item.candidateWorkgroupId, item]));
  const groupPolicy = new Map();
  const proposals = [];

  for (const workgroup of resolution.candidateWorkgroups) {
    const candidateKey = string(workgroup.candidateWorkgroupId, "candidateWorkgroupId");
    const basis = workgroup?.definition?.identityBasis || {};
    const contradiction = contradictionReasons(context, {
      candidateKey,
      workgroupIdentityKey: workgroup?.definition?.identityKey || "",
    });
    const membershipChange = groupHasMembershipChange(workgroup, context);
    const missingShipments = (basis.shipmentKeys || []).filter((item) => !knownShipments.has(item));
    const missingBrokers = (basis.brokerKeys || []).filter((item) => !knownBrokers.has(item));
    const eligible = exactCountMatchedGroup(workgroup)
      && contradiction.length === 0
      && !membershipChange
      && missingShipments.length === 0
      && missingBrokers.length === 0;
    const reasons = eligible
      ? ["exact count-matched broker reply confirms every evidence-bound workgroup member"]
      : [
        ...(workgroup.requiresReview ? ["linker marked the workgroup for review"] : []),
        ...contradiction,
        ...(membershipChange ? ["the proposed shipment membership changes an existing operational group"] : []),
        ...(missingShipments.length ? [`unknown shipment members: ${missingShipments.join(",")}`] : []),
        ...(missingBrokers.length ? [`unknown broker members: ${missingBrokers.join(",")}`] : []),
        ...(!exactCountMatchedGroup(workgroup) ? ["group scope lacks an exact count-matched broker confirmation"] : []),
      ];
    const policy = assessment({
      disposition: eligible ? "accept" : "review",
      policyClass: eligible ? "explicit_count_matched_group" : "operator_review_required",
      reasons,
      conflict: contradiction.length > 0,
      membershipChange,
    });
    groupPolicy.set(candidateKey, policy);
    proposals.push({
      candidateKind: "workgroup",
      candidateKey,
      parentCandidateKey: "",
      method: workgroup?.definition?.createdMethod || "deterministic",
      autoAcceptEligible: workgroup.autoAcceptEligible === true,
      requiresReview: workgroup.requiresReview === true || !eligible,
      evidenceObservationIds: evidenceIdsForWorkgroup(workgroup),
      proposal: workgroup,
      assessment: policy,
    });

    for (const membership of workgroup.memberships || []) {
      const membershipKey = string(membership.candidateMembershipId, "candidateMembershipId");
      let membershipEvidenceIds = evidenceIdsForMembership(membership);
      if (!membershipEvidenceIds.length && membership.memberType === "gmail_message") {
        membershipEvidenceIds = sortedUnique(context.observations
          .filter((item) => item.parsedMessage.gmail.messageId === membership.memberKey)
          .map((item) => item.observationId));
      }
      if (!membershipEvidenceIds.length) membershipEvidenceIds = evidenceIdsForWorkgroup(workgroup);
      const memberContradictions = contradictionReasons(context, {
        candidateKey: membershipKey,
        entityKey: membership.memberKey || "",
        workgroupIdentityKey: workgroup?.definition?.identityKey || "",
      });
      const memberEligible = eligible
        && membership.autoAcceptEligible === true
        && membership.membershipMethod === "deterministic"
        && memberContradictions.length === 0;
      const memberPolicy = assessment({
        disposition: memberEligible ? "accept" : "review",
        policyClass: memberEligible ? "explicit_count_matched_group" : "operator_review_required",
        reasons: memberEligible
          ? ["membership belongs to an exact count-matched evidence-bound workgroup"]
          : [...reasons, ...memberContradictions],
        conflict: contradiction.length > 0 || memberContradictions.length > 0,
        membershipChange,
      });
      proposals.push({
        candidateKind: "workgroup_membership",
        candidateKey: membershipKey,
        parentCandidateKey: candidateKey,
        method: membership.membershipMethod || "deterministic",
        autoAcceptEligible: membership.autoAcceptEligible === true,
        requiresReview: !memberEligible,
        evidenceObservationIds: membershipEvidenceIds,
        proposal: membership,
        assessment: memberPolicy,
      });
    }
  }

  for (const link of resolution.candidateLinks) {
    const candidateKey = string(link.candidateLinkId, "candidateLinkId");
    const parentCandidateKey = String(link.evidenceSpan?.candidateWorkgroupId || "");
    const parent = parentCandidateKey ? workgroups.get(parentCandidateKey) : null;
    const parentPolicy = parentCandidateKey ? groupPolicy.get(parentCandidateKey) : null;
    const contradictions = contradictionReasons(context, {
      candidateKey,
      observationId: link.observationId || "",
      entityKey: link.entityKey || "",
      workgroupIdentityKey: parent?.definition?.identityKey || "",
    });
    const exactMention = link.linkMethod === "deterministic"
      && link.entityType === "shipment"
      && link.relationship === "mentions"
      && link.reasonCode === "explicit_full_awb_mention"
      && link.autoAcceptEligible === true
      && knownShipments.has(link.entityKey);
    const exactGroupLink = link.linkMethod === "deterministic"
      && link.entityType === "shipment"
      && link.relationship === "shared_execution"
      && link.reasonCode === "alert_batch_workgroup_propagation"
      && link.autoAcceptEligible === true
      && parentPolicy?.policyDisposition === "accept";
    const eligible = (exactMention || exactGroupLink) && contradictions.length === 0;
    const policy = assessment({
      disposition: eligible ? "accept" : "review",
      policyClass: exactMention
        ? "explicit_awb_mention"
        : exactGroupLink
          ? "explicit_count_matched_group"
          : "operator_review_required",
      reasons: eligible
        ? [exactMention
          ? "explicit full AWB mention matches a known shipment"
          : "shared link belongs to an exact count-matched evidence-bound workgroup"]
        : [
          ...contradictions,
          ...(link.linkMethod !== "deterministic" ? ["model-derived links cannot autoaccept"] : []),
          ...(link.reasonCode === "explicit_full_awb_mention" && !knownShipments.has(link.entityKey)
            ? ["explicit AWB is not present in current known shipment context"]
            : []),
          ...(!exactMention && !exactGroupLink ? ["link type is outside the narrow auto-link policy"] : []),
        ],
      conflict: contradictions.length > 0,
      membershipChange: parentPolicy?.membershipChange === true,
    });
    proposals.push({
      candidateKind: "entity_link",
      candidateKey,
      parentCandidateKey,
      method: link.linkMethod || "deterministic",
      autoAcceptEligible: link.autoAcceptEligible === true,
      requiresReview: !eligible,
      evidenceObservationIds: evidenceIdsForLink(link),
      proposal: link,
      assessment: policy,
    });
  }

  proposals.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey));
  const keys = proposals.map((item) => item.candidateKey);
  if (new Set(keys).size !== keys.length) {
    throw new TruthLinkWorkerError("Cross-thread linker returned duplicate candidate identities", {
      code: "TRUTH_LINK_LINKER_OUTPUT_INVALID",
    });
  }
  for (const proposal of proposals) {
    if (!proposal.evidenceObservationIds.length
      || proposal.evidenceObservationIds.some((item) => !observationIds.has(item))) {
      throw new TruthLinkWorkerError(`Candidate ${proposal.candidateKey} cites context outside the immutable load`, {
        code: "TRUTH_LINK_EVIDENCE_OUTSIDE_CONTEXT",
      });
    }
  }
  return proposals;
}

function safeErrorCode(error) {
  const candidate = String(error?.code || "TRUTH_LINK_JOB_FAILED").toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate) ? candidate : "TRUTH_LINK_JOB_FAILED";
}

function createTruthLinkWorker(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be an object");
  const jobLedger = requireMethod(options.jobLedger, "claimJobs", "jobLedger");
  requireMethod(jobLedger, "renewJob", "jobLedger");
  requireMethod(jobLedger, "completeJob", "jobLedger");
  requireMethod(jobLedger, "failJob", "jobLedger");
  const linkLedger = requireMethod(options.linkLedger, "appendResolution", "linkLedger");
  requireMethod(linkLedger, "appendDecision", "linkLedger");
  requireMethod(linkLedger, "bindAcceptance", "linkLedger");
  const evidenceLedger = requireMethod(options.evidenceLedger, "appendEntityLink", "evidenceLedger");
  requireMethod(evidenceLedger, "appendWorkgroupMembership", "evidenceLedger");
  const loadContext = options.loadContext;
  if (typeof loadContext !== "function") throw invalidArgument("loadContext", "must be a function");
  const linker = options.linker || linkGmailObservations;
  if (typeof linker !== "function") throw invalidArgument("linker", "must be a function");
  const linkerOptions = isPlainObject(options.linkerOptions) ? options.linkerOptions : {};
  const workerId = string(options.workerId, "workerId");
  const processorVersion = string(options.processorVersion, "processorVersion");
  const policyVersion = string(options.policyVersion, "policyVersion");
  const leaseSeconds = integer(options.leaseSeconds ?? 300, "leaseSeconds", { minimum: 30, maximum: 900 });
  const retryAfterSeconds = options.retryAfterSeconds === undefined
      || options.retryAfterSeconds === null
    ? null
    : integer(options.retryAfterSeconds, "retryAfterSeconds", {
      minimum: 1,
      maximum: 86_400,
    });
  const maxContextObservations = integer(
    options.maxContextObservations ?? 250,
    "maxContextObservations",
    { minimum: 1, maximum: 2_000 },
  );

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
      stage: `truth link job ${job.jobId}`,
      deadlineAtMs: runtime.deadlineAtMs,
    });
    const context = normalizeContext(await loadContext(job), job, maxContextObservations);
    const resolution = await linker(context.observations, linkerOptions);
    const proposals = buildProposals(resolution, context);
    const contextManifest = context.observations.map((item) => ({
      observationId: item.observationId,
      contentHash: item.contentHash,
    }));

    assertRuntime(runtime, `truth link lease renewal ${job.jobId}`);
    await jobLedger.renewJob({ ...fenced(job), leaseSeconds });
    assertRuntime(runtime, `truth link resolution write ${job.jobId}`);
    const resolutionReceipt = await linkLedger.appendResolution({
      ...fenced(job),
      contextManifest,
      resolution,
      proposals,
    });
    const proposalReceiptByKey = new Map(resolutionReceipt.proposals.map((item) => [item.candidateKey, item]));
    if (proposalReceiptByKey.size !== proposals.length) {
      throw new TruthLinkWorkerError("Resolution receipt omitted a durable candidate proposal", {
        code: "TRUTH_LINK_RESOLUTION_RECEIPT_INCOMPLETE",
      });
    }

    // Every proposal is durable before any policy decision is appended.
    const decisions = [];
    for (const proposal of proposals) {
      const receipt = proposalReceiptByKey.get(proposal.candidateKey);
      if (!receipt) {
        throw new TruthLinkWorkerError(`Resolution receipt omitted ${proposal.candidateKey}`, {
          code: "TRUTH_LINK_RESOLUTION_RECEIPT_INCOMPLETE",
        });
      }
      const shouldAccept = proposal.assessment.policyDisposition === "accept";
      assertRuntime(runtime, `truth link decision write ${job.jobId}`);
      const decision = await linkLedger.appendDecision({
        ...fenced(job),
        proposalId: receipt.proposalId,
        decision: {
          decisionNo: 1,
          previousDecisionVersionId: null,
          decision: shouldAccept ? "accept" : "review",
          method: "policy",
          policyVersion,
          decidedBy: processorVersion,
          reasons: proposal.assessment.reasons,
        },
      });
      decisions.push({ proposal, receipt, decision });
    }

    const accepted = [];
    const workgroupIds = new Map();
    const acceptedOrder = ["workgroup_membership", "entity_link", "workgroup"];
    for (const candidateKind of acceptedOrder) {
      for (const item of decisions.filter((entry) => (
        entry.proposal.candidateKind === candidateKind && entry.decision.decision === "accept"
      ))) {
        const request = item.decision.acceptedItemRequest;
        let acceptedItemId;
        let acceptedItemHash = "";
        if (candidateKind === "workgroup_membership") {
          assertRuntime(runtime, `truth link membership write ${job.jobId}`);
          const evidenceReceipt = await evidenceLedger.appendWorkgroupMembership({
            workgroup: request.workgroup,
            membership: request.membership,
            evidence: request.evidence,
          });
          acceptedItemId = evidenceReceipt.membershipVersionId;
          acceptedItemHash = evidenceReceipt.itemHash;
          workgroupIds.set(item.proposal.parentCandidateKey, evidenceReceipt.workgroupId);
        } else if (candidateKind === "entity_link") {
          assertRuntime(runtime, `truth link entity write ${job.jobId}`);
          const evidenceReceipt = await evidenceLedger.appendEntityLink({ link: request.link });
          acceptedItemId = evidenceReceipt.linkVersionId;
          acceptedItemHash = evidenceReceipt.itemHash;
        } else {
          acceptedItemId = workgroupIds.get(item.proposal.candidateKey);
          if (!acceptedItemId) {
            throw new TruthLinkWorkerError("Accepted workgroup has no accepted evidence-bound membership", {
              code: "TRUTH_LINK_WORKGROUP_BINDING_INCOMPLETE",
            });
          }
        }
        assertRuntime(runtime, `truth link acceptance binding ${job.jobId}`);
        const binding = await linkLedger.bindAcceptance({
          ...fenced(job),
          proposalId: item.receipt.proposalId,
          decisionVersionId: item.decision.decisionVersionId,
          acceptedItemId,
        });
        accepted.push({
          candidateKey: item.proposal.candidateKey,
          proposalId: item.receipt.proposalId,
          decisionVersionId: item.decision.decisionVersionId,
          acceptedKind: request.acceptedKind,
          acceptedItemId,
          acceptedItemHash,
          bindingId: binding.bindingId,
          bindingItemHash: binding.itemHash,
        });
      }
    }
    accepted.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey));

    const acceptedByCandidate = new Map(accepted.map((item) => [item.candidateKey, item]));
    const resultProposals = decisions.map((item) => {
      const acceptedItem = acceptedByCandidate.get(item.proposal.candidateKey);
      return {
        candidateKey: item.proposal.candidateKey,
        candidateKind: item.proposal.candidateKind,
        proposalId: item.receipt.proposalId,
        proposalItemHash: item.receipt.itemHash,
        decisionVersionId: item.decision.decisionVersionId,
        decisionItemHash: item.decision.itemHash,
        disposition: acceptedItem ? "accepted" : "review",
        ...(acceptedItem || {}),
      };
    }).sort((left, right) => left.candidateKey.localeCompare(right.candidateKey));
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      processorVersion,
      policyVersion,
      resolutionRunId: resolutionReceipt.resolutionRunId,
      resolutionItemHash: resolutionReceipt.itemHash,
      sourceObservationId: job.observationId,
      contextObservationCount: context.observations.length,
      contextThreadCount: new Set(context.observations.map((item) => item.parsedMessage.gmail.threadId)).size,
      proposalCount: resultProposals.length,
      acceptedCount: resultProposals.filter((item) => item.disposition === "accepted").length,
      reviewCount: resultProposals.filter((item) => item.disposition === "review").length,
      proposals: resultProposals,
    };
    assertRuntime(runtime, `truth link completion ${job.jobId}`);
    const completion = await jobLedger.completeJob({
      ...fenced(job),
      result,
      observations: [],
      childJobs: [],
    });
    return deepFreeze({ ok: true, jobId: job.jobId, completion, result });
  }

  async function runOnce(input = {}) {
    if (!isPlainObject(input)) throw invalidArgument("runOnce", "must be an object");
    const signal = input.signal ?? null;
    if (signal !== null && !isAbortSignal(signal)) throw invalidArgument("signal", "must be an AbortSignal or null");
    throwIfAborted(signal, { stage: "truth link worker claim", deadlineAtMs: input.deadlineAtMs });
    const limit = integer(input.limit ?? 10, "limit", { minimum: 1, maximum: 50 });
    throwIfAborted(signal, { stage: "truth link worker claim", deadlineAtMs: input.deadlineAtMs });
    const claim = await jobLedger.claimJobs({
      workerId,
      processorVersion,
      limit,
      leaseSeconds,
      jobKinds: [JOB_KIND],
    });
    if (!Array.isArray(claim?.jobs)) {
      throw new TruthLinkWorkerError("Source-processing ledger returned an invalid claim receipt", {
        code: "TRUTH_LINK_JOB_CLAIM_INVALID",
      });
    }
    const jobs = [];
    for (const rawJob of claim.jobs) {
      try {
        throwIfAborted(signal, {
          stage: `truth link job ${rawJob?.jobId || "unknown"}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        jobs.push(await processJob(rawJob, { signal, deadlineAtMs: input.deadlineAtMs }));
      } catch (error) {
        if (error?.outcomeUnknown === true) {
          throw asOutcomeUnknownError(error, {
            signal,
            stage: `truth link job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
          });
        }
        if (isAbortError(error, signal)) {
          throw asDeadlineError(error, {
            signal,
            stage: `truth link job ${rawJob?.jobId || "unknown"}`,
            deadlineAtMs: input.deadlineAtMs,
            outcomeUnknown: error?.outcomeUnknown === true,
          });
        }
        throwIfAborted(signal, {
          stage: `truth link failure acknowledgement ${rawJob?.jobId || "unknown"}`,
          deadlineAtMs: input.deadlineAtMs,
        });
        const job = isPlainObject(rawJob) ? rawJob : {};
        let failureReceipt = null;
        let failureAcknowledgementError = null;
        try {
          throwIfAborted(signal, {
            stage: `truth link failure acknowledgement ${rawJob?.jobId || "unknown"}`,
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
              stage: `truth link failure acknowledgement ${rawJob?.jobId || "unknown"}`,
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
    const succeededCount = jobs.filter((item) => item.ok).length;
    return deepFreeze({
      ok: jobs.every((item) => item.ok),
      claimedCount: claim.jobs.length,
      succeededCount,
      failedCount: jobs.length - succeededCount,
      acceptedCount: jobs.filter((item) => item.ok).reduce((sum, item) => sum + item.result.acceptedCount, 0),
      reviewCount: jobs.filter((item) => item.ok).reduce((sum, item) => sum + item.result.reviewCount, 0),
      jobs,
    });
  }

  return Object.freeze({
    jobKind: JOB_KIND,
    workerId,
    processorVersion,
    policyVersion,
    processJob,
    runOnce,
  });
}

module.exports = {
  JOB_KIND,
  RESULT_SCHEMA_VERSION,
  TruthLinkWorkerError,
  createTruthLinkWorker,
  _test: {
    buildProposals,
    canonicalize,
    exactCountMatchedGroup,
    groupHasMembershipChange,
    normalizeContext,
    normalizeJob,
    safeErrorCode,
    sha256Json,
  },
};

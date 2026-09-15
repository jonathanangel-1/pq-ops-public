"use strict";

const crypto = require("node:crypto");
const { PREDICATES, REGISTRY } = require("./truth-predicate-registry");
const ALL_PREDICATES = REGISTRY.predicates;

const CANDIDATE_ASSERTION_SCHEMA_VERSION = "truth-candidate-assertion-v2";
const POLICY_ELIGIBILITY_SCHEMA_VERSION = "truth-candidate-policy-eligibility-v1";
const EVIDENCE_CITATION_SCHEMA_VERSION = "truth-evidence-citation-v2";
const GMAIL_CONTEXT_AUTHORITY_SCHEMA_VERSION = "gmail-candidate-context-authority-v1";
const EMAIL_ACTOR_AUTHORITY_SCHEMA_VERSION = "gmail-email-actor-authority-v1";
const GMAIL_AUTH_WITNESS_SCHEMA_VERSION = "gmail-trusted-receiver-auth-witness-v1";
const GMAIL_PARSED_MESSAGE_SCHEMA_VERSION = "gmail-parsed-message-v2";
const GMAIL_PARSER_VERSION = "postal-mime-2.7.5+pikiio-rfc822-v3-source-chronology-trusted-auth-witness";
const GMAIL_PARSED_ENVELOPE_KEYS = Object.freeze([
  "messageId", "threadId", "historyId", "providerHistoryId", "internalDate",
  "providerReceivedAt", "labelIds", "labelIdsHash", "rawObservationId",
  "rawObservationContentHash",
]);

const GMAIL_EXTRACTION_PLAN_SCHEMA_VERSION = "gmail-claim-extraction-plan-v4";
const GMAIL_MODEL_PLAN_SCHEMA_VERSION = "gmail-model-extraction-plan-v4";
const GMAIL_MODEL_INPUT_SCHEMA_VERSION = "gmail-claim-extraction-model-input-v3";
const GMAIL_MODEL_RESPONSE_SCHEMA_VERSION = "gmail-model-candidate-claims-v4";
const GMAIL_PROMPT_VERSION = "gmail-claim-extraction-prompt-v4";

const EXTRACTOR_VERSIONS = Object.freeze({
  gmailDeterministicExtractor: `gmail-claim-extractor-v8-email-actor-authority-versionless-assertion+predicates:${REGISTRY.registryHash}`,
  gmailModelExtractor: `gmail-claim-extractor-v9-email-actor-authority-versionless-cross-thread-citation+predicates:${REGISTRY.registryHash}`,
  tmsExtractor: `tms-claim-extractor-v2-versionless-assertion+predicates:${REGISTRY.registryHash}`,
  trackingExtractor: `tracking-claim-extractor-v2-versionless-context-only+predicates:${REGISTRY.registryHash}`,
  operatorExtractor: `operator-claim-extractor-v2-versionless-assertion+predicates:${REGISTRY.registryHash}`,
});

const POLICY_ELIGIBILITY_VERSIONS = Object.freeze({
  gmail: `gmail-candidate-policy-eligibility-v2-email-actor-authority+${REGISTRY.registryVersion}`,
  tms: `tms-candidate-policy-eligibility-v2+${REGISTRY.registryVersion}`,
  tracking: `tracking-candidate-policy-eligibility-v2-context-only+${REGISTRY.registryVersion}`,
  operator: `operator-candidate-policy-eligibility-v2+${REGISTRY.registryVersion}`,
});

const CANDIDATE_KEYS = Object.freeze([
  "candidateClaimVersionId", "candidateHash", "schemaVersion", "claimKey",
  "sourceSystem", "sourceObjectType", "sourceObjectId", "sourceObservationId",
  "sourceObservationContentHash", "sourceRecordedAt", "sourceRevision", "sourceOperation",
  "sourceMessageId", "sourceThreadId", "sourceCapturedAt", "subjectType", "subjectKey",
  "appliesToAwbs", "predicate", "gate", "polarity", "normalizedValue", "occurredAt",
  "confidence", "confidenceLabel", "evidenceSpan", "evidenceCitations", "extractionMethod",
  "extractorVersion", "model", "promptVersion", "ambiguity", "contextAuthority",
  "emailActorAuthority", "policyEligibility",
]);
const CANDIDATE_IDENTITY_KEYS = Object.freeze(CANDIDATE_KEYS.slice(2));
const EVIDENCE_CITATION_KEYS = Object.freeze([
  "kind", "sourceOrdinal", "sourceRole", "evidenceRole", "observationId", "contentHash",
  "sourceObjectType", "sourceObjectId", "messageId", "threadId", "sourceRecordedAt",
  "sourceRegion", "start", "end", "unit", "quoteHash", "quote", "path", "valueHash",
  "valuePreview",
]);
const GMAIL_CONTEXT_AUTHORITY_KEYS = Object.freeze([
  "schemaVersion", "contextPolicyVersion", "contextPolicyHash", "linkEpochId", "linkEpochHash",
  "workgroupId", "workgroupHeadManifestId", "workgroupHeadManifestHash",
  "observationMembershipHash", "routingDisposition",
]);
const EMAIL_ACTOR_AUTHORITY_KEYS = Object.freeze([
  "schemaVersion", "authorityId", "authorityHash", "authoritySource", "policyVersion",
  "policyHash", "claimObservationId", "claimObservationContentHash",
  "sourceMessageObservationId", "sourceMessageObservationContentHash", "sourceMessageRelation",
  "actorPolicySnapshotId", "actorPolicySnapshotHash", "actorMemberId", "actorMemberHash",
  "actor", "authentication", "relationship", "relationshipEvidence", "capabilities", "scope",
  "reasonCodes",
]);
const GMAIL_AUTH_WITNESS_KEYS = Object.freeze([
  "schemaVersion", "witnessId", "witnessHash", "status", "authservId",
  "selectorPolicyVersion", "selectorPolicyHash",
  "authenticationResultsHeaderCount", "trustedHeaderCount", "allHeadersManifestHash",
  "selectedHeaderOrdinal", "selectedHeaderHash", "dmarc", "dkim", "spf", "headerFromDomain",
  "reasonCode",
]);

const POLICY_ELIGIBILITY_POLICY = Object.freeze({
  schemaVersion: "truth-candidate-policy-eligibility-policy-v1",
  eligibilitySchemaVersion: POLICY_ELIGIBILITY_SCHEMA_VERSION,
  statuses: Object.freeze(["eligible", "ineligible", "review_required"]),
  capabilities: Object.freeze(["context_only", "explicit_operator_action", "gate_assertion", "none"]),
  reasonCodePattern: "^[a-z][a-z0-9_]{0,79}$",
  nonAuthoritative: true,
  modelStatus: "review_required",
  modelCapability: "derived_from_authorized_evidence",
  trackingStatus: "eligible",
  trackingCapability: "context_only",
  trackingNormalizedEffect: "context",
  gmailDraftStatus: "ineligible",
  gmailDraftCapability: "none",
  gmailSentStatus: "review_required",
  gmailSentCapability: "context_only",
  gmailForwardedInlineStatus: "review_required",
  gmailForwardedInlineCapability: "context_only",
  gmailSpamTrashDisposition: "normal_actor_review",
});

const GMAIL_AUTH_WITNESS_POLICY = Object.freeze({
  schemaVersion: "gmail-trusted-receiver-auth-witness-policy-v1",
  witnessSchemaVersion: GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
  trustedReceiverAuthservIds: Object.freeze(["mx.google.com"]),
  headerSelection: "exactly_one_trusted_authserv_id_header",
  headerNormalization: "unfold_trim_single_space",
  allHeadersManifest: "ordered_normalized_authentication_results_headers",
  mechanisms: Object.freeze(["dkim", "dmarc", "spf"]),
  resultValues: Object.freeze(["fail", "pass", "unknown"]),
  statusValues: Object.freeze(["fail", "pass", "unknown"]),
  missingTrustedHeaderDisposition: "unknown",
  multipleTrustedHeaderDisposition: "unknown",
  untrustedHeadersDisposition: "bound_but_not_selected",
  trustBoundaryAssumption: "gmail_received_message_headers_preserve_receiver_authentication_results_order",
  alignedDomainRequirement: "dmarc_pass_requires_valid_normalized_header_from_domain",
  domainNormalization: "lowercase_idna_ascii_no_trailing_dot",
});

const GMAIL_PARSED_ENVELOPE_POLICY = Object.freeze({
  schemaVersion: "gmail-parsed-message-envelope-policy-v1",
  parsedMessageSchemaVersion: GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  gmailKeys: GMAIL_PARSED_ENVELOPE_KEYS,
  historyCompatibilityAlias: "historyId_equals_providerHistoryId",
  labelIdentity: "sha256_canonical_sorted_unique_label_ids",
  lineageRequirements: Object.freeze([
    "immutable_raw_observation", "provider_message_history_revision",
  ]),
  rootSpecificMaterializationRule: "cut_trigger_and_group_membership_are_external_receipts_not_intrinsic_content",
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) throw new TypeError("candidate contract accepts JSON values only");
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Json(value) {
  return sha256Text(JSON.stringify(canonicalize(value)));
}

const GMAIL_AUTH_WITNESS_POLICY_HASH = sha256Json(GMAIL_AUTH_WITNESS_POLICY);
const GMAIL_PARSED_ENVELOPE_POLICY_HASH = sha256Json(GMAIL_PARSED_ENVELOPE_POLICY);

const EMAIL_ACTOR_AUTHORITY_POLICY = Object.freeze({
  schemaVersion: "gmail-email-actor-authority-policy-v1",
  authoritySchemaVersion: EMAIL_ACTOR_AUTHORITY_SCHEMA_VERSION,
  authWitnessSchemaVersion: GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
  authWitnessPolicyHash: GMAIL_AUTH_WITNESS_POLICY_HASH,
  authoritySources: Object.freeze(["default_unknown", "sealed_actor_policy_snapshot"]),
  identitySources: Object.freeze(["ambiguous", "from", "none", "sender"]),
  identityStatuses: Object.freeze(["ambiguous", "known", "unknown"]),
  memberMatchBases: Object.freeze(["domain", "exact_address", "none"]),
  authenticationStatuses: Object.freeze(["fail", "pass", "spoofed", "unknown"]),
  mechanismStatuses: Object.freeze(["fail", "pass", "unknown"]),
  relationshipStatuses: Object.freeze(["authorized", "revoked", "unknown", "unscoped"]),
  roles: Object.freeze([
    "broker", "carrier_station", "consignee", "customs_broker", "freight_forwarder",
    "ground_handler", "internal_operator", "shipper", "trucker", "unknown",
  ]),
  sourceMessageRelations: Object.freeze(["attachment_parent", "self", "unknown"]),
  scopeTypes: Object.freeze(["none", "shipment_awbs"]),
  freeMailDomains: Object.freeze([
    "aol.com", "gmail.com", "googlemail.com", "hotmail.com", "icloud.com", "live.com",
    "outlook.com", "proton.me", "protonmail.com", "yahoo.com",
  ]),
  labelDispositionBinding: "reason_codes_derived_from_bound_parsed_observation_label_ids_and_provenance",
  authorizationRequirements: Object.freeze([
    "actor_member_bound", "actor_policy_snapshot_bound", "all_candidate_awbs_in_scope",
    "actor_from_domain_matches_dmarc_aligned_domain",
    "authentication_pass", "current_or_bound_attachment_evidence", "dmarc_pass",
    "empty_authority_reason_codes", "exact_predicate_gate_capability",
    "free_mail_exact_address_match", "known_role", "known_single_actor",
    "relationship_authorized", "relationship_evidence_bound", "sealed_link_epoch_bound",
    "trusted_receiver_authentication_results_bound",
  ]),
});

const GMAIL_CONTEXT_AUTHORITY_POLICY = Object.freeze({
  schemaVersion: "gmail-candidate-context-authority-policy-v1",
  contextAuthoritySchemaVersion: GMAIL_CONTEXT_AUTHORITY_SCHEMA_VERSION,
  linkEpochIdPrefix: "gmail-link-epoch:v1:",
  workgroupHeadManifestIdPrefix: "gmail-workgroup-head-manifest:v1:",
  routingDispositions: Object.freeze([
    "deleted_gap", "matched", "non_operational", "unmatched_operational_review",
  ]),
  requirements: Object.freeze([
    "exact_context_policy_hash", "exact_link_epoch_hash", "exact_observation_membership_hash",
    "exact_predecessor_graph_selection", "exact_workgroup_head_manifest_hash",
    "explicit_routing_disposition", "no_live_window_fallback",
  ]),
});

const POLICY_ELIGIBILITY_POLICY_HASH = sha256Json(POLICY_ELIGIBILITY_POLICY);
const EMAIL_ACTOR_AUTHORITY_POLICY_HASH = sha256Json(EMAIL_ACTOR_AUTHORITY_POLICY);
const GMAIL_CONTEXT_AUTHORITY_POLICY_HASH = sha256Json(GMAIL_CONTEXT_AUTHORITY_POLICY);

const SOURCE_POLICY_ELIGIBILITY_POLICIES = deepFreeze({
  gmail: {
    schemaVersion: "gmail-candidate-policy-eligibility-policy-v2",
    policyVersion: POLICY_ELIGIBILITY_VERSIONS.gmail,
    sharedPolicyHash: POLICY_ELIGIBILITY_POLICY_HASH,
    contextAuthorityPolicyHash: GMAIL_CONTEXT_AUTHORITY_POLICY_HASH,
    emailActorAuthorityPolicyHash: EMAIL_ACTOR_AUTHORITY_POLICY_HASH,
    deterministicStatus: "eligible_only_when_context_and_actor_authorize_exact_predicate_gate_scope",
    modelStatus: "review_required",
    modelCapability: "derived_from_underlying_authorized_evidence",
    shipmentMentionSemantics: "awb_mention_does_not_establish_canonical_entity_existence",
    groupFanoutRequirements: Object.freeze([
      "sealed_matched_link_epoch", "complete_bound_workgroup_membership",
      "authorized_actor_exact_predicate_gate_scope", "valid_awb_check_digits",
    ]),
    labelDispositionRules: Object.freeze({
      DRAFT: Object.freeze({ status: "ineligible", capability: "none", reasonCode: "gmail_label_draft" }),
      SENT: Object.freeze({ status: "review_required", capability: "context_only", reasonCode: "gmail_label_sent" }),
      forwarded_inline: Object.freeze({
        status: "review_required", capability: "context_only", reasonCode: "gmail_forwarded_inline",
      }),
      SPAM: "normal_actor_review",
      TRASH: "normal_actor_review",
      received: "normal_actor_review",
    }),
    labelBinding: "parsed_observation_content_hash_binds_sorted_gmail_label_ids_and_provenance",
    originalMessageRule: "forwarded_inline_is_context_until_original_or_provenance_bound_eml_exists",
    attachmentProjectionRules: Object.freeze([
      "bind_exact_attachment_observation", "bind_exact_parent_parsed_message_observation",
      "translate_current_primary_citation_to_attachment_text_coordinates",
    ]),
    attachmentReviewDisposition: Object.freeze({
      status: "review_required", capability: "context_only",
      reasonCode: "gmail_attachment_extraction_requires_review",
    }),
    trustedReceiverAuthenticationRequired: true,
  },
  tms: {
    schemaVersion: "tms-candidate-policy-eligibility-policy-v2",
    policyVersion: POLICY_ELIGIBILITY_VERSIONS.tms,
    sharedPolicyHash: POLICY_ELIGIBILITY_POLICY_HASH,
    shipmentMentionSemantics: "tms_row_and_awb_mention_do_not_establish_canonical_entity_existence",
    invalidAwb: Object.freeze({ status: "review_required", capability: "context_only" }),
    inventoryPresence: Object.freeze({
      predicate: "shipment_observed_in_tms", status: "eligible", capability: "context_only",
    }),
    sensitiveFields: Object.freeze({
      customsActualRelease: "review_required", deliveryActualArrivalDate: "review_required",
      podSignature: "review_required",
    }),
    directStatusAssertion: Object.freeze({ status: "eligible", capability: "gate_assertion" }),
  },
  tracking: {
    schemaVersion: "tracking-candidate-policy-eligibility-policy-v2",
    policyVersion: POLICY_ELIGIBILITY_VERSIONS.tracking,
    sharedPolicyHash: POLICY_ELIGIBILITY_POLICY_HASH,
    eligibleProviderSourceKind: "official_carrier_tracking",
    allowedEventCodes: Object.freeze(["ARR", "AWD", "DEP", "IN TRANSIT", "IN-TRANSIT", "IN_TRANSIT", "RCF"]),
    status: "eligible",
    capability: "context_only",
    normalizedEffect: "context",
    shipmentMentionSemantics: "tracking_awb_mention_does_not_establish_canonical_entity_existence",
    invalidAwbStatus: "review_required",
    gateClosure: "forbidden",
  },
  operator: {
    schemaVersion: "operator-candidate-policy-eligibility-policy-v2",
    policyVersion: POLICY_ELIGIBILITY_VERSIONS.operator,
    sharedPolicyHash: POLICY_ELIGIBILITY_POLICY_HASH,
    authoritySource: "immutable_structured_operator_event",
    assertion: Object.freeze({ status: "eligible", capability: "explicit_operator_action" }),
    correction: Object.freeze({ status: "review_required", capability: "context_only" }),
    revocation: Object.freeze({ status: "review_required", capability: "context_only" }),
    invalidAwb: Object.freeze({ status: "review_required", capability: "context_only" }),
    freeTextAssertion: "forbidden",
  },
});

const SOURCE_POLICY_ELIGIBILITY_HASHES = deepFreeze(Object.fromEntries(
  Object.entries(SOURCE_POLICY_ELIGIBILITY_POLICIES)
    .map(([source, policy]) => [source, sha256Json(policy)]),
));
const SOURCE_POLICY_BY_VERSION = new Map(Object.entries(SOURCE_POLICY_ELIGIBILITY_POLICIES)
  .map(([source, policy]) => [policy.policyVersion, {
    source,
    policy,
    policyHash: SOURCE_POLICY_ELIGIBILITY_HASHES[source],
  }]));

const CANDIDATE_CONTRACT_SET = Object.freeze({
  schemaVersion: "truth-candidate-contract-set-v1",
  candidateSchemaVersion: CANDIDATE_ASSERTION_SCHEMA_VERSION,
  candidateIdPrefix: "candidate:v2:",
  candidateKeys: CANDIDATE_KEYS,
  candidateIdentityKeys: CANDIDATE_IDENTITY_KEYS,
  policyEligibilitySchemaVersion: POLICY_ELIGIBILITY_SCHEMA_VERSION,
  policyEligibilityPolicyHash: POLICY_ELIGIBILITY_POLICY_HASH,
  sourcePolicyEligibilityPolicies: SOURCE_POLICY_ELIGIBILITY_POLICIES,
  sourcePolicyEligibilityHashes: SOURCE_POLICY_ELIGIBILITY_HASHES,
  evidenceCitationSchemaVersion: EVIDENCE_CITATION_SCHEMA_VERSION,
  evidenceCitationKeys: EVIDENCE_CITATION_KEYS,
  gmailParsedMessageSchemaVersion: GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  gmailParserVersion: GMAIL_PARSER_VERSION,
  gmailParsedEnvelopeKeys: GMAIL_PARSED_ENVELOPE_KEYS,
  gmailParsedEnvelopePolicy: GMAIL_PARSED_ENVELOPE_POLICY,
  gmailParsedEnvelopePolicyHash: GMAIL_PARSED_ENVELOPE_POLICY_HASH,
  gmailContextAuthoritySchemaVersion: GMAIL_CONTEXT_AUTHORITY_SCHEMA_VERSION,
  gmailContextAuthorityKeys: GMAIL_CONTEXT_AUTHORITY_KEYS,
  gmailContextAuthorityPolicyHash: GMAIL_CONTEXT_AUTHORITY_POLICY_HASH,
  emailActorAuthoritySchemaVersion: EMAIL_ACTOR_AUTHORITY_SCHEMA_VERSION,
  emailActorAuthorityKeys: EMAIL_ACTOR_AUTHORITY_KEYS,
  emailActorAuthorityPolicyHash: EMAIL_ACTOR_AUTHORITY_POLICY_HASH,
  gmailAuthWitnessSchemaVersion: GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
  gmailAuthWitnessKeys: GMAIL_AUTH_WITNESS_KEYS,
  gmailAuthWitnessPolicyHash: GMAIL_AUTH_WITNESS_POLICY_HASH,
  extractorVersions: EXTRACTOR_VERSIONS,
  policyEligibilityVersions: POLICY_ELIGIBILITY_VERSIONS,
  gmailPlanVersions: Object.freeze({
    extractionPlanSchemaVersion: GMAIL_EXTRACTION_PLAN_SCHEMA_VERSION,
    modelPlanSchemaVersion: GMAIL_MODEL_PLAN_SCHEMA_VERSION,
    modelInputSchemaVersion: GMAIL_MODEL_INPUT_SCHEMA_VERSION,
    modelResponseSchemaVersion: GMAIL_MODEL_RESPONSE_SCHEMA_VERSION,
    promptVersion: GMAIL_PROMPT_VERSION,
  }),
});
const CANDIDATE_CONTRACT_SET_HASH = sha256Json(CANDIDATE_CONTRACT_SET);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sortedUniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item)))].sort();
}

function createPolicyEligibility({ status, capability, policyVersion, reasonCodes = [] }) {
  if (!POLICY_ELIGIBILITY_POLICY.statuses.includes(status)) throw new TypeError("invalid policy eligibility status");
  if (!POLICY_ELIGIBILITY_POLICY.capabilities.includes(capability)) throw new TypeError("invalid policy capability");
  if (typeof policyVersion !== "string" || !policyVersion) throw new TypeError("policyVersion is required");
  const sourcePolicy = SOURCE_POLICY_BY_VERSION.get(policyVersion);
  if (!sourcePolicy) throw new TypeError("policyVersion is not a frozen source eligibility policy");
  const reasons = sortedUniqueStrings(reasonCodes);
  if (reasons.some((reason) => !/^[a-z][a-z0-9_]{0,79}$/.test(reason))) {
    throw new TypeError("policy eligibility reason code is invalid");
  }
  return deepFreeze({
    schemaVersion: POLICY_ELIGIBILITY_SCHEMA_VERSION,
    status,
    capability,
    policyVersion,
    policyHash: sourcePolicy.policyHash,
    reasonCodes: reasons,
  });
}

function createStructuredEvidenceCitation({ observation, evidenceSpan, sourceRecordedAt = null }) {
  return deepFreeze({
    kind: "structured_field",
    sourceOrdinal: 0,
    sourceRole: "current",
    evidenceRole: "primary",
    observationId: observation.observationId,
    contentHash: observation.contentHash,
    sourceObjectType: observation.sourceObjectType,
    sourceObjectId: String(observation.sourceObjectId || ""),
    messageId: "",
    threadId: "",
    sourceRecordedAt,
    sourceRegion: "structured",
    start: null,
    end: null,
    unit: "structured_field",
    quoteHash: "",
    quote: "",
    path: [...(evidenceSpan.path || [])],
    valueHash: String(evidenceSpan.valueHash || ""),
    valuePreview: String(evidenceSpan.valuePreview || ""),
  });
}

function createTextEvidenceCitation({
  observation,
  evidenceSpan,
  sourceOrdinal = 0,
  sourceRole = "current",
  evidenceRole = "primary",
  sourceRecordedAt = null,
}) {
  return deepFreeze({
    kind: "text_span",
    sourceOrdinal,
    sourceRole,
    evidenceRole,
    observationId: observation.observationId,
    contentHash: observation.contentHash,
    sourceObjectType: observation.sourceObjectType || "gmail_message_parsed",
    sourceObjectId: String(observation.sourceObjectId || observation.messageId || ""),
    messageId: String(observation.messageId || observation.normalizedPayload?.gmail?.messageId || ""),
    threadId: String(observation.threadId || observation.normalizedPayload?.gmail?.threadId || ""),
    sourceRecordedAt,
    sourceRegion: String(evidenceSpan.sourceRegion || "body"),
    start: evidenceSpan.start,
    end: evidenceSpan.end,
    unit: "utf16_code_units",
    quoteHash: sha256Text(evidenceSpan.quote),
    quote: evidenceSpan.quote,
    path: [],
    valueHash: "",
    valuePreview: "",
  });
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${field} must contain the exact contract keys`);
  }
}

function assertString(value, field, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${field} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
}

function assertNullableTimestamp(value, field) {
  if (value === null) return;
  assertString(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be a timestamp or null`);
}

function assertSortedUniqueStrings(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)
      || values.some((item) => typeof item !== "string" || !item)) {
    throw new TypeError(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array of strings`);
  }
  const normalized = sortedUniqueStrings(values);
  if (JSON.stringify(values) !== JSON.stringify(normalized)) {
    throw new TypeError(`${field} must be sorted and unique`);
  }
}

function validatePolicyEligibility(value, sourceSystem) {
  exactKeys(value, [
    "schemaVersion", "status", "capability", "policyVersion", "policyHash", "reasonCodes",
  ], "policyEligibility");
  if (value.schemaVersion !== POLICY_ELIGIBILITY_SCHEMA_VERSION
      || !POLICY_ELIGIBILITY_POLICY.statuses.includes(value.status)
      || !POLICY_ELIGIBILITY_POLICY.capabilities.includes(value.capability)) {
    throw new TypeError("policyEligibility has unsupported contract values");
  }
  const sourcePolicy = SOURCE_POLICY_BY_VERSION.get(value.policyVersion);
  if (!sourcePolicy || sourcePolicy.source !== sourceSystem || value.policyHash !== sourcePolicy.policyHash) {
    throw new TypeError("policyEligibility does not bind the exact source policy");
  }
  assertSortedUniqueStrings(value.reasonCodes, "policyEligibility.reasonCodes");
  if (value.reasonCodes.some((reason) => !/^[a-z][a-z0-9_]{0,79}$/.test(reason))) {
    throw new TypeError("policyEligibility reason code is invalid");
  }
}

function validateContextAuthority(value) {
  exactKeys(value, GMAIL_CONTEXT_AUTHORITY_KEYS, "contextAuthority");
  if (value.schemaVersion !== GMAIL_CONTEXT_AUTHORITY_SCHEMA_VERSION
      || value.contextPolicyVersion !== GMAIL_CONTEXT_AUTHORITY_POLICY.schemaVersion
      || value.contextPolicyHash !== GMAIL_CONTEXT_AUTHORITY_POLICY_HASH
      || !/^[0-9a-f]{64}$/.test(value.linkEpochHash)
      || value.linkEpochId !== `gmail-link-epoch:v1:${value.linkEpochHash}`
      || !/^[0-9a-f]{64}$/.test(value.workgroupHeadManifestHash)
      || value.workgroupHeadManifestId
        !== `gmail-workgroup-head-manifest:v1:${value.workgroupHeadManifestHash}`
      || !/^(?:|workgroup:v1:[0-9a-f]{64})$/.test(value.workgroupId)
      || !/^[0-9a-f]{64}$/.test(value.observationMembershipHash)
      || !GMAIL_CONTEXT_AUTHORITY_POLICY.routingDispositions.includes(value.routingDisposition)) {
    throw new TypeError("contextAuthority is invalid");
  }
}

function validateEmailActorAuthority(value) {
  exactKeys(value, EMAIL_ACTOR_AUTHORITY_KEYS, "emailActorAuthority");
  const { authorityId, authorityHash, ...body } = value;
  if (value.schemaVersion !== EMAIL_ACTOR_AUTHORITY_SCHEMA_VERSION
      || !/^[0-9a-f]{64}$/.test(authorityHash)
      || authorityId !== `gmail-email-actor-authority:v1:${authorityHash}`
      || sha256Json(body) !== authorityHash
      || value.policyVersion !== EMAIL_ACTOR_AUTHORITY_POLICY.schemaVersion
      || value.policyHash !== EMAIL_ACTOR_AUTHORITY_POLICY_HASH
      || !EMAIL_ACTOR_AUTHORITY_POLICY.authoritySources.includes(value.authoritySource)) {
    throw new TypeError("emailActorAuthority identity is invalid");
  }
  for (const [field, item] of [
    ["claimObservationId", value.claimObservationId],
    ["sourceMessageObservationId", value.sourceMessageObservationId],
  ]) {
    if (item !== "" && !/^obs:v1:[0-9a-f]{64}$/.test(item)) throw new TypeError(`emailActorAuthority.${field} is invalid`);
  }
  for (const [field, item] of [
    ["claimObservationContentHash", value.claimObservationContentHash],
    ["sourceMessageObservationContentHash", value.sourceMessageObservationContentHash],
  ]) {
    if (item !== "" && !/^[0-9a-f]{64}$/.test(item)) throw new TypeError(`emailActorAuthority.${field} is invalid`);
  }
  if (!EMAIL_ACTOR_AUTHORITY_POLICY.sourceMessageRelations.includes(value.sourceMessageRelation)) {
    throw new TypeError("emailActorAuthority sourceMessageRelation is invalid");
  }
  exactKeys(value.actor, [
    "address", "addressHash", "domain", "identitySource", "identityStatus", "memberMatchBasis",
  ], "emailActorAuthority.actor");
  exactKeys(value.authentication, [
    "status", "dmarc", "dkim", "spf", "alignedDomain",
    "trustedReceiverAuthenticationResultsWitnessId",
    "trustedReceiverAuthenticationResultsWitnessHash",
  ], "emailActorAuthority.authentication");
  exactKeys(value.relationship, ["status", "role"], "emailActorAuthority.relationship");
  exactKeys(value.scope, ["type", "awbs"], "emailActorAuthority.scope");
  if (!EMAIL_ACTOR_AUTHORITY_POLICY.identitySources.includes(value.actor.identitySource)
      || !EMAIL_ACTOR_AUTHORITY_POLICY.identityStatuses.includes(value.actor.identityStatus)
      || !EMAIL_ACTOR_AUTHORITY_POLICY.memberMatchBases.includes(value.actor.memberMatchBasis)
      || !EMAIL_ACTOR_AUTHORITY_POLICY.authenticationStatuses.includes(value.authentication.status)
      || ![value.authentication.dmarc, value.authentication.dkim, value.authentication.spf]
        .every((status) => EMAIL_ACTOR_AUTHORITY_POLICY.mechanismStatuses.includes(status))
      || !EMAIL_ACTOR_AUTHORITY_POLICY.relationshipStatuses.includes(value.relationship.status)
      || !EMAIL_ACTOR_AUTHORITY_POLICY.roles.includes(value.relationship.role)
      || !EMAIL_ACTOR_AUTHORITY_POLICY.scopeTypes.includes(value.scope.type)) {
    throw new TypeError("emailActorAuthority has unsupported policy values");
  }
  const normalizedActorAddress = String(value.actor.address || "").toLowerCase();
  const actorDomain = normalizedActorAddress.includes("@")
    ? normalizedActorAddress.slice(normalizedActorAddress.lastIndexOf("@") + 1)
    : "";
  const validDomain = (domain) => typeof domain === "string"
    && domain === domain.toLowerCase()
    && domain.includes(".")
    && domain.length <= 253
    && domain.split(".").every((label) => (
      label.length > 0 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
  if (value.actor.identityStatus === "known") {
    if (value.actor.address !== normalizedActorAddress
        || !/^[^\s@]+@[^\s@]+$/.test(value.actor.address)
        || value.actor.addressHash !== sha256Text(value.actor.address)
        || value.actor.domain !== actorDomain
        || !validDomain(value.actor.domain)) {
      throw new TypeError("emailActorAuthority known actor identity is inconsistent");
    }
  } else if (value.actor.address || value.actor.addressHash || value.actor.domain) {
    throw new TypeError("emailActorAuthority unknown actor cannot carry a bound address");
  }
  const witnessId = value.authentication.trustedReceiverAuthenticationResultsWitnessId;
  const witnessHash = value.authentication.trustedReceiverAuthenticationResultsWitnessHash;
  if ((witnessId || witnessHash)
      && (!/^[0-9a-f]{64}$/.test(witnessHash)
        || witnessId !== `gmail-auth-witness:v1:${witnessHash}`)) {
    throw new TypeError("emailActorAuthority authentication witness identity is inconsistent");
  }
  if (value.authentication.status === "pass"
      && (value.authentication.dmarc !== "pass" || !witnessId
        || !validDomain(value.authentication.alignedDomain))) {
    throw new TypeError("emailActorAuthority pass requires trusted DMARC and an aligned domain");
  }
  if (value.authentication.status === "pass" && value.actor.identityStatus === "known"
      && value.actor.domain !== value.authentication.alignedDomain) {
    throw new TypeError("emailActorAuthority actor domain is not DMARC-aligned");
  }
  if (value.authentication.alignedDomain && !validDomain(value.authentication.alignedDomain)) {
    throw new TypeError("emailActorAuthority alignedDomain is invalid");
  }
  if (!Array.isArray(value.relationshipEvidence) || !Array.isArray(value.capabilities)) {
    throw new TypeError("emailActorAuthority authority sets must be arrays");
  }
  value.relationshipEvidence.forEach((item, index) => {
    exactKeys(item, ["evidenceId", "evidenceHash"], `emailActorAuthority.relationshipEvidence[${index}]`);
    assertString(item.evidenceId, `emailActorAuthority.relationshipEvidence[${index}].evidenceId`);
    if (!/^[0-9a-f]{64}$/.test(item.evidenceHash)) throw new TypeError("relationship evidence hash is invalid");
  });
  value.capabilities.forEach((item, index) => {
    exactKeys(item, ["predicate", "gate"], `emailActorAuthority.capabilities[${index}]`);
    if (!PREDICATES[item.predicate] || PREDICATES[item.predicate].gate !== item.gate) {
      throw new TypeError("emailActorAuthority capability is outside the predicate registry");
    }
  });
  const evidenceOrder = [...value.relationshipEvidence]
    .sort((left, right) => `${left.evidenceId}|${left.evidenceHash}`.localeCompare(`${right.evidenceId}|${right.evidenceHash}`));
  const capabilityOrder = [...value.capabilities]
    .sort((left, right) => `${left.predicate}|${left.gate}`.localeCompare(`${right.predicate}|${right.gate}`));
  if (JSON.stringify(evidenceOrder) !== JSON.stringify(value.relationshipEvidence)
      || new Set(evidenceOrder.map((item) => `${item.evidenceId}|${item.evidenceHash}`)).size !== evidenceOrder.length
      || JSON.stringify(capabilityOrder) !== JSON.stringify(value.capabilities)
      || new Set(capabilityOrder.map((item) => `${item.predicate}|${item.gate}`)).size !== capabilityOrder.length) {
    throw new TypeError("emailActorAuthority authority sets must be sorted and unique");
  }
  assertSortedUniqueStrings(value.scope.awbs, "emailActorAuthority.scope.awbs");
  assertSortedUniqueStrings(value.reasonCodes, "emailActorAuthority.reasonCodes");
  if (value.scope.awbs.some((awb) => !/^\d{11}$/.test(awb))
      || (value.scope.type === "none" && value.scope.awbs.length)
      || (value.scope.type === "shipment_awbs" && !value.scope.awbs.length)
      || value.reasonCodes.some((reason) => !/^[a-z][a-z0-9_]{0,79}$/.test(reason))) {
    throw new TypeError("emailActorAuthority scope or reason codes are invalid");
  }
  const snapshotBound = /^[0-9a-f]{64}$/.test(value.actorPolicySnapshotHash)
    && value.actorPolicySnapshotId
      === `gmail-actor-policy-snapshot:v1:${value.actorPolicySnapshotHash}`;
  const memberBound = /^[0-9a-f]{64}$/.test(value.actorMemberHash)
    && value.actorMemberId === `gmail-actor-member:v1:${value.actorMemberHash}`;
  if (value.authoritySource === "default_unknown") {
    if (value.actorPolicySnapshotId || value.actorPolicySnapshotHash
        || value.actorMemberId || value.actorMemberHash
        || value.relationshipEvidence.length || value.capabilities.length
        || value.scope.type !== "none" || value.relationship.status !== "unknown"
        || value.relationship.role !== "unknown") {
      throw new TypeError("default_unknown email authority cannot contain sealed policy grants");
    }
  } else if (!snapshotBound || !memberBound) {
    throw new TypeError("sealed email authority must bind actor policy snapshot and member identities");
  }
}

function gmailAuthorityEligible(body) {
  const authority = body.emailActorAuthority;
  return body.contextAuthority.routingDisposition === "matched"
    && authority.authoritySource === "sealed_actor_policy_snapshot"
    && authority.actor.identityStatus === "known"
    && authority.authentication.status === "pass"
    && authority.authentication.dmarc === "pass"
    && authority.actor.domain === authority.authentication.alignedDomain
    && authority.relationship.status === "authorized"
    && authority.relationship.role !== "unknown"
    && authority.relationshipEvidence.length > 0
    && authority.capabilities.some((item) => (
      item.predicate === body.predicate && item.gate === body.gate
    ))
    && authority.scope.type === "shipment_awbs"
    && body.appliesToAwbs.every((awb) => authority.scope.awbs.includes(awb))
    && !(EMAIL_ACTOR_AUTHORITY_POLICY.freeMailDomains.includes(authority.actor.domain)
      && authority.actor.memberMatchBasis !== "exact_address")
    && authority.reasonCodes.length === 0;
}

function validateSourcePolicySemantics(body) {
  const eligibility = body.policyEligibility;
  const reasons = new Set(eligibility.reasonCodes);
  const invalidAwb = body.appliesToAwbs.some((awb) => !isValidAwbCheckDigit(awb));
  if (body.sourceSystem === "tracking") {
    if (eligibility.capability !== "context_only" || body.normalizedValue.effect !== "context"
        || !reasons.has("tracking_baseline_context_only")
        || !reasons.has("tracking_observation_is_shipment_mention_only")
        || (invalidAwb && (eligibility.status !== "review_required"
          || !reasons.has("awb_check_digit_invalid")))
        || (!invalidAwb && eligibility.status !== "eligible")) {
      throw new TypeError("tracking policy eligibility contradicts the frozen context-only policy");
    }
    return;
  }
  if (body.sourceSystem === "tms") {
    const inventory = body.predicate === "shipment_observed_in_tms";
    const sensitive = ["customs_release", "delivery_completed", "pod_received"].includes(body.predicate)
      && Object.prototype.hasOwnProperty.call(body.normalizedValue, "tmsField");
    const review = invalidAwb || sensitive;
    const expectedCapability = review || inventory ? "context_only" : "gate_assertion";
    if (eligibility.status !== (review ? "review_required" : "eligible")
        || eligibility.capability !== expectedCapability
        || (inventory && !reasons.has("tms_observation_is_shipment_mention_only"))
        || (sensitive && !reasons.has("tms_sensitive_field_requires_review"))
        || (invalidAwb && !reasons.has("awb_check_digit_invalid"))) {
      throw new TypeError("TMS policy eligibility contradicts the frozen field policy");
    }
    return;
  }
  if (body.sourceSystem === "operator") {
    const chainMutation = ["correction", "revocation"].includes(body.sourceOperation);
    const review = chainMutation || invalidAwb
      || reasons.has("operator_source_contract_review_required");
    if (eligibility.status !== (review ? "review_required" : "eligible")
        || eligibility.capability !== (review ? "context_only" : "explicit_operator_action")
        || (body.sourceOperation === "correction"
          && !reasons.has("operator_correction_requires_acceptance_epoch"))
        || (body.sourceOperation === "revocation"
          && !reasons.has("operator_revocation_requires_acceptance_epoch"))
        || (invalidAwb && !reasons.has("awb_check_digit_invalid"))) {
      throw new TypeError("operator policy eligibility contradicts the frozen event policy");
    }
    return;
  }
  const labelDraft = reasons.has("gmail_label_draft");
  const contextualLabel = reasons.has("gmail_label_sent") || reasons.has("gmail_forwarded_inline");
  const temporalReview = reasons.has("temporal_semantics_requires_review");
  const attachmentReview = reasons.has("gmail_attachment_extraction_requires_review");
  const actorEligible = gmailAuthorityEligible(body);
  let expectedStatus = "eligible";
  let expectedCapability = "gate_assertion";
  if (labelDraft) {
    expectedStatus = "ineligible";
    expectedCapability = "none";
  } else if (contextualLabel || invalidAwb || temporalReview || attachmentReview || !actorEligible
      || body.extractionMethod === "model") {
    expectedStatus = "review_required";
    expectedCapability = contextualLabel || invalidAwb || temporalReview || attachmentReview || !actorEligible
      ? "context_only" : "gate_assertion";
  }
  if (eligibility.status !== expectedStatus || eligibility.capability !== expectedCapability
      || (body.extractionMethod === "model" && !reasons.has("model_requires_acceptance_epoch"))
      || (invalidAwb && !reasons.has("awb_check_digit_invalid"))) {
    throw new TypeError("Gmail policy eligibility contradicts sealed actor, context, label, or model authority");
  }
}

function validateEvidenceSpan(value) {
  if (value?.kind === "structured_field") {
    exactKeys(value, ["kind", "path", "valueHash", "valuePreview"], "evidenceSpan");
    if (!Array.isArray(value.path) || !value.path.length
        || value.path.some((item) => typeof item !== "string" || !item)
        || !/^[0-9a-f]{64}$/.test(value.valueHash)
        || typeof value.valuePreview !== "string") {
      throw new TypeError("structured evidenceSpan is invalid");
    }
    return;
  }
  exactKeys(value, ["kind", "sourceRegion", "start", "end", "unit", "quoteHash", "quote"], "evidenceSpan");
  if (value.kind !== "text_span" || !["subject", "body", "attachment_text"].includes(value.sourceRegion)
      || !Number.isSafeInteger(value.start) || value.start < 0
      || !Number.isSafeInteger(value.end) || value.end <= value.start
      || value.unit !== "utf16_code_units" || typeof value.quote !== "string" || !value.quote
      || value.end - value.start !== value.quote.length || value.quoteHash !== sha256Text(value.quote)) {
    throw new TypeError("text evidenceSpan is invalid");
  }
}

function validateEvidenceCitation(value, index) {
  exactKeys(value, EVIDENCE_CITATION_KEYS, `evidenceCitations[${index}]`);
  if (!Number.isSafeInteger(value.sourceOrdinal) || value.sourceOrdinal < 0
      || !["current", "linked"].includes(value.sourceRole)
      || !["primary", "supporting"].includes(value.evidenceRole)
      || !/^obs:v1:[0-9a-f]{64}$/.test(value.observationId)
      || !/^[0-9a-f]{64}$/.test(value.contentHash)) {
    throw new TypeError(`evidenceCitations[${index}] source identity is invalid`);
  }
  ["sourceObjectType", "sourceObjectId", "messageId", "threadId", "sourceRegion", "unit",
    "quoteHash", "quote", "valueHash", "valuePreview"].forEach((field) => {
    assertString(value[field], `evidenceCitations[${index}].${field}`, { allowEmpty: true });
  });
  assertNullableTimestamp(value.sourceRecordedAt, `evidenceCitations[${index}].sourceRecordedAt`);
  if (value.kind === "text_span") {
    if (!["subject", "body", "attachment_text"].includes(value.sourceRegion)
        || !Number.isSafeInteger(value.start) || value.start < 0
        || !Number.isSafeInteger(value.end) || value.end <= value.start
        || value.unit !== "utf16_code_units" || !value.quote
        || value.end - value.start !== value.quote.length || value.quoteHash !== sha256Text(value.quote)
        || !Array.isArray(value.path) || value.path.length || value.valueHash || value.valuePreview) {
      throw new TypeError(`evidenceCitations[${index}] text span is invalid`);
    }
    return;
  }
  if (value.kind !== "structured_field" || value.sourceRegion !== "structured"
      || value.start !== null || value.end !== null || value.unit !== "structured_field"
      || value.quoteHash || value.quote || !Array.isArray(value.path) || !value.path.length
      || value.path.some((item) => typeof item !== "string" || !item)
      || !/^[0-9a-f]{64}$/.test(value.valueHash)) {
    throw new TypeError(`evidenceCitations[${index}] structured field is invalid`);
  }
}

function validateCandidateBody(body) {
  exactKeys(body, CANDIDATE_IDENTITY_KEYS, "candidate assertion body");
  if (body.schemaVersion !== CANDIDATE_ASSERTION_SCHEMA_VERSION
      || !["gmail", "operator", "tms", "tracking"].includes(body.sourceSystem)) {
    throw new TypeError("candidate assertion schema or source is invalid");
  }
  const sourceObjectTypes = {
    gmail: new Set([
      "gmail_message_parsed", "gmail_attachment_extracted", "gmail_attachment_claim_projection",
    ]),
    operator: new Set(["operator_event"]),
    tms: new Set(["tms_shipment_snapshot"]),
    tracking: new Set(["tracking_shipment_snapshot"]),
  };
  if (!sourceObjectTypes[body.sourceSystem].has(body.sourceObjectType)) {
    throw new TypeError("candidate source object type is invalid for its source system");
  }
  ["claimKey", "sourceObjectType", "sourceObjectId", "sourceRevision", "sourceOperation",
    "subjectType", "subjectKey", "predicate", "gate", "polarity", "confidenceLabel",
    "extractionMethod", "extractorVersion", "model", "promptVersion"].forEach((field) => {
    assertString(body[field], field, { allowEmpty: ["model", "promptVersion"].includes(field) });
  });
  if (!/^obs:v1:[0-9a-f]{64}$/.test(body.sourceObservationId)
      || !/^[0-9a-f]{64}$/.test(body.sourceObservationContentHash)) {
    throw new TypeError("candidate source observation identity is invalid");
  }
  if (!["content", "assertion", "correction", "revocation"].includes(body.sourceOperation)
      || (body.sourceSystem === "operator" && !["assertion", "correction", "revocation"].includes(body.sourceOperation))
      || (body.sourceSystem !== "operator" && body.sourceOperation !== "content")) {
    throw new TypeError("candidate sourceOperation is invalid for its source system");
  }
  assertString(body.sourceMessageId, "sourceMessageId", { allowEmpty: true });
  assertString(body.sourceThreadId, "sourceThreadId", { allowEmpty: true });
  if ((body.sourceSystem === "gmail" && (!body.sourceMessageId || !body.sourceThreadId))
      || (body.sourceSystem !== "gmail" && (body.sourceMessageId || body.sourceThreadId))) {
    throw new TypeError("candidate source message identity is inconsistent with sourceSystem");
  }
  assertNullableTimestamp(body.sourceRecordedAt, "sourceRecordedAt");
  assertNullableTimestamp(body.sourceCapturedAt, "sourceCapturedAt");
  assertNullableTimestamp(body.occurredAt, "occurredAt");
  if (!["shipment", "workgroup"].includes(body.subjectType)
      || (body.subjectType === "shipment" && !/^\d{11}$/.test(body.subjectKey))
      || (body.subjectType === "workgroup" && !/^workgroup:v1:[0-9a-f]{64}$/.test(body.subjectKey))
      || body.claimKey !== `${body.subjectType}:${body.subjectKey}:${body.predicate}`) {
    throw new TypeError("candidate subject or claimKey is invalid");
  }
  assertSortedUniqueStrings(body.appliesToAwbs, "appliesToAwbs", { allowEmpty: false });
  if (body.appliesToAwbs.some((awb) => !/^\d{11}$/.test(awb))
      || (body.subjectType === "shipment"
        && (body.appliesToAwbs.length !== 1 || body.appliesToAwbs[0] !== body.subjectKey))) {
    throw new TypeError("candidate AWB scope is invalid");
  }
  const predicate = ALL_PREDICATES[body.predicate];
  if (!predicate || predicate.gate !== body.gate
      || !Object.prototype.hasOwnProperty.call(predicate.statuses, body.polarity)
      || !isPlainObject(body.normalizedValue)
      || body.normalizedValue.status !== predicate.statuses[body.polarity]
      || !["block", "complete", "context", "request"].includes(body.normalizedValue.effect)
      || (body.sourceSystem !== "tracking"
        && body.normalizedValue.effect !== predicate.effects[body.polarity])) {
    throw new TypeError("candidate predicate/polarity/value contract is invalid");
  }
  if (typeof body.confidence !== "number" || !Number.isFinite(body.confidence)
      || body.confidence < 0 || body.confidence > 1
      || !["high", "medium", "low"].includes(body.confidenceLabel)
      || body.confidenceLabel !== (body.confidence >= 0.9 ? "high" : body.confidence >= 0.7 ? "medium" : "low")) {
    throw new TypeError("candidate confidence contract is invalid");
  }
  validateEvidenceSpan(body.evidenceSpan);
  if (!Array.isArray(body.evidenceCitations) || body.evidenceCitations.length === 0) {
    throw new TypeError("candidate evidenceCitations must be non-empty");
  }
  body.evidenceCitations.forEach(validateEvidenceCitation);
  if (!body.evidenceCitations.some((citation) => citation.sourceRole === "current"
      && citation.evidenceRole === "primary"
      && citation.observationId === body.sourceObservationId
      && citation.contentHash === body.sourceObservationContentHash)) {
    throw new TypeError("candidate must cite its exact source observation as current primary evidence");
  }
  if (!["deterministic", "model"].includes(body.extractionMethod)
      || (body.extractionMethod === "deterministic" && (body.model || body.promptVersion))
      || (body.extractionMethod === "model" && (!body.model || !body.promptVersion))) {
    throw new TypeError("candidate extraction identity is invalid");
  }
  exactKeys(body.ambiguity, ["status", "reasons"], "ambiguity");
  if (!["none", "review"].includes(body.ambiguity.status)) throw new TypeError("candidate ambiguity status is invalid");
  assertSortedUniqueStrings(body.ambiguity.reasons, "ambiguity.reasons");
  validatePolicyEligibility(body.policyEligibility, body.sourceSystem);
  if (body.extractionMethod === "model" && body.policyEligibility.status !== "review_required") {
    throw new TypeError("model candidates must remain review_required");
  }
  if (body.sourceSystem === "gmail") {
    validateContextAuthority(body.contextAuthority);
    validateEmailActorAuthority(body.emailActorAuthority);
    if (body.emailActorAuthority.claimObservationId !== body.sourceObservationId
        || body.emailActorAuthority.claimObservationContentHash !== body.sourceObservationContentHash) {
      throw new TypeError("emailActorAuthority does not bind the candidate observation");
    }
  } else if (body.contextAuthority !== null || body.emailActorAuthority !== null) {
    throw new TypeError("non-Gmail candidates cannot carry Gmail authority envelopes");
  }
  validateSourcePolicySemantics(body);
}

function createCandidateAssertion(fields) {
  if (!isPlainObject(fields)) throw new TypeError("candidate fields must be an object");
  exactKeys(fields, CANDIDATE_IDENTITY_KEYS.filter((key) => key !== "schemaVersion"), "candidate fields");
  const body = {
    schemaVersion: CANDIDATE_ASSERTION_SCHEMA_VERSION,
    claimKey: fields.claimKey,
    sourceSystem: fields.sourceSystem,
    sourceObjectType: fields.sourceObjectType,
    sourceObjectId: String(fields.sourceObjectId || ""),
    sourceObservationId: fields.sourceObservationId,
    sourceObservationContentHash: fields.sourceObservationContentHash,
    sourceRecordedAt: fields.sourceRecordedAt ?? null,
    sourceRevision: String(fields.sourceRevision || ""),
    sourceOperation: String(fields.sourceOperation || "content"),
    sourceMessageId: String(fields.sourceMessageId || ""),
    sourceThreadId: String(fields.sourceThreadId || ""),
    sourceCapturedAt: fields.sourceCapturedAt ?? null,
    subjectType: fields.subjectType,
    subjectKey: fields.subjectKey,
    appliesToAwbs: sortedUniqueStrings(fields.appliesToAwbs),
    predicate: fields.predicate,
    gate: fields.gate,
    polarity: fields.polarity,
    normalizedValue: canonicalize(fields.normalizedValue),
    occurredAt: fields.occurredAt ?? null,
    confidence: fields.confidence,
    confidenceLabel: fields.confidenceLabel,
    evidenceSpan: canonicalize(fields.evidenceSpan),
    evidenceCitations: canonicalize(fields.evidenceCitations),
    extractionMethod: fields.extractionMethod,
    extractorVersion: fields.extractorVersion,
    model: String(fields.model || ""),
    promptVersion: String(fields.promptVersion || ""),
    ambiguity: {
      status: fields.ambiguity?.status || "none",
      reasons: sortedUniqueStrings(fields.ambiguity?.reasons),
    },
    contextAuthority: fields.contextAuthority === undefined ? null : canonicalize(fields.contextAuthority),
    emailActorAuthority: fields.emailActorAuthority === undefined ? null : canonicalize(fields.emailActorAuthority),
    policyEligibility: canonicalize(fields.policyEligibility),
  };
  validateCandidateBody(body);
  const candidateHash = sha256Json(body);
  return deepFreeze({
    candidateClaimVersionId: `candidate:v2:${candidateHash}`,
    candidateHash,
    ...body,
  });
}

function isValidAwbCheckDigit(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 && Number(digits.slice(3, 10)) % 7 === Number(digits.slice(10));
}

module.exports = Object.freeze({
  CANDIDATE_ASSERTION_SCHEMA_VERSION,
  CANDIDATE_CONTRACT_SET,
  CANDIDATE_CONTRACT_SET_HASH,
  CANDIDATE_IDENTITY_KEYS,
  CANDIDATE_KEYS,
  EMAIL_ACTOR_AUTHORITY_KEYS,
  EMAIL_ACTOR_AUTHORITY_POLICY,
  EMAIL_ACTOR_AUTHORITY_POLICY_HASH,
  EMAIL_ACTOR_AUTHORITY_SCHEMA_VERSION,
  EVIDENCE_CITATION_KEYS,
  EVIDENCE_CITATION_SCHEMA_VERSION,
  EXTRACTOR_VERSIONS,
  GMAIL_AUTH_WITNESS_KEYS,
  GMAIL_AUTH_WITNESS_POLICY,
  GMAIL_AUTH_WITNESS_POLICY_HASH,
  GMAIL_AUTH_WITNESS_SCHEMA_VERSION,
  GMAIL_CONTEXT_AUTHORITY_KEYS,
  GMAIL_CONTEXT_AUTHORITY_POLICY,
  GMAIL_CONTEXT_AUTHORITY_POLICY_HASH,
  GMAIL_CONTEXT_AUTHORITY_SCHEMA_VERSION,
  GMAIL_EXTRACTION_PLAN_SCHEMA_VERSION,
  GMAIL_MODEL_INPUT_SCHEMA_VERSION,
  GMAIL_MODEL_PLAN_SCHEMA_VERSION,
  GMAIL_MODEL_RESPONSE_SCHEMA_VERSION,
  GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  GMAIL_PARSED_ENVELOPE_KEYS,
  GMAIL_PARSED_ENVELOPE_POLICY,
  GMAIL_PARSED_ENVELOPE_POLICY_HASH,
  GMAIL_PARSER_VERSION,
  GMAIL_PROMPT_VERSION,
  POLICY_ELIGIBILITY_POLICY,
  POLICY_ELIGIBILITY_POLICY_HASH,
  POLICY_ELIGIBILITY_SCHEMA_VERSION,
  POLICY_ELIGIBILITY_VERSIONS,
  SOURCE_POLICY_ELIGIBILITY_HASHES,
  SOURCE_POLICY_ELIGIBILITY_POLICIES,
  createCandidateAssertion,
  createPolicyEligibility,
  createStructuredEvidenceCitation,
  createTextEvidenceCitation,
  isValidAwbCheckDigit,
  _test: Object.freeze({
    canonicalize,
    isPlainObject,
    sha256Json,
    sha256Text,
    validateCandidateBody,
    validateContextAuthority,
    validateEmailActorAuthority,
    validateEvidenceCitation,
    validateEvidenceSpan,
    validatePolicyEligibility,
  }),
});

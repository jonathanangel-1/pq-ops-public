"use strict";

const crypto = require("node:crypto");

const LINKER_VERSION = "gmail-cross-thread-linker-v1";
const OUTPUT_SCHEMA_VERSION = "gmail-cross-thread-link-candidates-v1";
const LINK_SCHEMA_VERSION = "observation-entity-link-candidate-v1";
const WORKGROUP_SCHEMA_VERSION = "operational-workgroup-candidate-v1";
const DEFAULT_ALERT_BATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_ACCEPT_THRESHOLD = 0.9;
const HEURISTIC_WORKGROUP_MAX_CONFIDENCE = 0.89;
const EXPLICIT_GROUP_CONFIRMATION_CONFIDENCE = 0.97;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const FREE_MAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
]);

class GmailCrossThreadLinkerError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "GmailCrossThreadLinkerError";
    this.code = fields.code || "GMAIL_CROSS_THREAD_LINKER_FAILED";
    this.field = fields.field || "";
    this.cause = fields.cause || this.cause;
  }
}

function invalidArgument(field, reason) {
  return new GmailCrossThreadLinkerError(`Invalid cross-thread linker argument ${field}: ${reason}`, {
    code: "GMAIL_CROSS_THREAD_LINKER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidArgument("canonicalValue", "contains a non-finite number");
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
  throw invalidArgument("canonicalValue", "contains a non-JSON value");
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sortedUnique(values) {
  return [...new Set((values || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function clampConfidence(value) {
  return Number(Math.max(0, Math.min(1, Number(value) || 0)).toFixed(6));
}

function normalizeDomain(value) {
  return clean(value).toLowerCase().replace(/^@/, "").replace(/\.$/, "");
}

function normalizeAddress(value) {
  if (typeof value === "string") {
    const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/);
    const raw = angle ? angle[1] : value;
    const match = clean(raw).toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/i);
    return match ? match[0].replace(/[>,;]+$/, "") : "";
  }
  if (!value || typeof value !== "object") return "";
  return normalizeAddress(value.address || "");
}

function flattenMailboxes(value, field, result = []) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  for (const item of items) {
    if (item && typeof item === "object" && Array.isArray(item.group)) {
      flattenMailboxes(item.group, field, result);
      continue;
    }
    const address = normalizeAddress(item);
    if (address) result.push({ address, field });
  }
  return result;
}

function addressDomain(address) {
  const normalized = normalizeAddress(address);
  return normalized.includes("@") ? normalized.split("@").pop() : "";
}

function normalizeAliasMap(value, field) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw invalidArgument(field, "must be a plain object");
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = clean(rawKey).toLowerCase();
    const alias = clean(rawValue).toLowerCase();
    if (!key || !alias) throw invalidArgument(field, "must contain non-empty string keys and values");
    result[key] = alias;
  }
  return result;
}

function normalizeOptions(options = {}) {
  if (!isPlainObject(options)) throw invalidArgument("options", "must be a plain object");
  const internalDomains = sortedUnique((options.internalDomains || []).map(normalizeDomain));
  const internalAddresses = sortedUnique((options.internalAddresses || []).map(normalizeAddress));
  const maxAlertBatchWindowMs = options.maxAlertBatchWindowMs === undefined
    ? DEFAULT_ALERT_BATCH_WINDOW_MS
    : Number(options.maxAlertBatchWindowMs);
  const autoAcceptThreshold = options.autoAcceptThreshold === undefined
    ? DEFAULT_AUTO_ACCEPT_THRESHOLD
    : Number(options.autoAcceptThreshold);
  if (!Number.isSafeInteger(maxAlertBatchWindowMs) || maxAlertBatchWindowMs <= 0) {
    throw invalidArgument("options.maxAlertBatchWindowMs", "must be a positive safe integer");
  }
  if (!Number.isFinite(autoAcceptThreshold) || autoAcceptThreshold <= 0 || autoAcceptThreshold > 1) {
    throw invalidArgument("options.autoAcceptThreshold", "must be greater than zero and at most one");
  }
  return {
    internalDomains,
    internalAddresses,
    maxAlertBatchWindowMs,
    autoAcceptThreshold: clampConfidence(autoAcceptThreshold),
    brokerAliases: normalizeAliasMap(options.brokerAliases, "options.brokerAliases"),
  };
}

function isInternalAddress(address, options) {
  const normalized = normalizeAddress(address);
  if (!normalized) return false;
  if (options.internalAddresses.includes(normalized)) return true;
  return options.internalDomains.includes(addressDomain(normalized));
}

function brokerKeyForAddress(address, options) {
  const normalized = normalizeAddress(address);
  const domain = addressDomain(normalized);
  if (!normalized || !domain || isInternalAddress(normalized, options)) return "";
  const alias = options.brokerAliases[normalized]
    || options.brokerAliases[`@${domain}`]
    || options.brokerAliases[domain];
  if (alias) return `broker:${alias}`;
  if (FREE_MAIL_DOMAINS.has(domain)) return `broker-email:${normalized}`;
  return `broker-domain:${domain}`;
}

function normalizeRfcMessageId(value) {
  return clean(value).replace(/^<|>$/g, "").toLowerCase();
}

function extractRfcMessageIds(value) {
  const text = String(value || "");
  const bracketed = [...text.matchAll(/<([^<>\s]+)>/g)].map((match) => normalizeRfcMessageId(match[1]));
  if (bracketed.length) return sortedUnique(bracketed);
  return sortedUnique(text.split(/\s+/).map(normalizeRfcMessageId).filter((item) => item.includes("@")));
}

function parseSourceTime(observation, parsedMessage) {
  const gmailInternalDate = parsedMessage?.gmail?.internalDate;
  if (gmailInternalDate !== undefined && gmailInternalDate !== null && /^\d+$/.test(String(gmailInternalDate))) {
    const milliseconds = Number(gmailInternalDate);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
      const date = new Date(milliseconds);
      if (Number.isFinite(date.getTime())) return { timeMs: milliseconds, recordedAt: date.toISOString() };
    }
  }
  for (const value of [parsedMessage?.date, observation?.sourceRecordedAt, observation?.capturedAt]) {
    if (!value) continue;
    const timeMs = Date.parse(String(value));
    if (Number.isFinite(timeMs)) return { timeMs, recordedAt: new Date(timeMs).toISOString() };
  }
  return { timeMs: null, recordedAt: null };
}

function splitCurrentAndQuotedText(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const current = [];
  const quoted = [];
  let quotedMode = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const possibleHeaderBlock = lines.slice(index, index + 7).map((item) => item.trim()).join("\n");
    if (
      /^On\s.+wrote:\s*$/i.test(trimmed)
      || /^-{2,}\s*Original Message\s*-{2,}$/i.test(trimmed)
      || /^_{2,}\s*$/.test(trimmed)
      || (
        /^From:\s*\S/i.test(trimmed)
        && /\n(?:Sent|Date):\s*\S/i.test(possibleHeaderBlock)
        && /\n(?:To|Subject):\s*\S/i.test(possibleHeaderBlock)
      )
    ) {
      quotedMode = true;
    }
    if (quotedMode || /^\s*>/.test(line)) quoted.push(line);
    else current.push(line);
  }
  return {
    currentText: current.join("\n").trim(),
    quotedText: quoted.join("\n").trim(),
  };
}

function extractAwbMentionsFromField(value, field, metadata = {}) {
  const text = String(value || "");
  const mentions = [];
  const occupied = [];
  const pattern = /(^|\D)(\d{3})([-\s]?)(\d{8})(?!\d)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const leadingLength = match[1].length;
    const start = match.index + leadingLength;
    const end = start + match[2].length + match[3].length + match[4].length;
    const normalizedAwb = `${match[2]}${match[4]}`;
    mentions.push({
      normalizedAwb,
      evidenceSpan: {
        field,
        start,
        end,
        text: text.slice(start, end),
        normalizedAwb,
        ...metadata,
      },
    });
    occupied.push([start, end]);
  }
  return { mentions, occupied };
}

function suffixAmbiguitiesFromField(value, field, occupied = [], metadata = {}) {
  const text = String(value || "");
  const ambiguities = [];
  for (const match of text.matchAll(/(^|\D)(\d{8})(?!\d)/g)) {
    const start = match.index + match[1].length;
    const end = start + 8;
    if (occupied.some(([from, to]) => start >= from && end <= to)) continue;
    const prefixContext = text.slice(Math.max(0, start - 28), start);
    if (!/(?:\b(?:awb|mawb|waybill|with|together|along with|ref)\b|#)\D{0,12}$/i.test(prefixContext)) continue;
    ambiguities.push({
      reasonCode: "awb_suffix_without_prefix",
      suffix: match[2],
      evidenceSpan: {
        field,
        start,
        end,
        text: text.slice(start, end),
        ...metadata,
      },
    });
  }
  return ambiguities;
}

function mentionKey(mention) {
  return [
    mention.normalizedAwb,
    mention.evidenceSpan.field,
    mention.evidenceSpan.attachmentOrdinal ?? "",
    mention.evidenceSpan.start,
    mention.evidenceSpan.end,
  ].join("|");
}

function normalizeObservation(raw, index) {
  if (!isPlainObject(raw)) throw invalidArgument(`observations[${index}]`, "must be a plain object");
  const observationId = clean(raw.observationId);
  const contentHash = clean(raw.contentHash).toLowerCase();
  if (!OBSERVATION_ID_RE.test(observationId)) {
    throw invalidArgument(`observations[${index}].observationId`, "must be obs:v1:<lowercase sha256>");
  }
  if (!SHA256_RE.test(contentHash)) {
    throw invalidArgument(`observations[${index}].contentHash`, "must be lowercase SHA-256 hex");
  }
  if (!isPlainObject(raw.parsedMessage)) {
    throw invalidArgument(`observations[${index}].parsedMessage`, "must be a plain object");
  }
  const parsed = raw.parsedMessage;
  if (!isPlainObject(parsed.gmail)) {
    throw invalidArgument(`observations[${index}].parsedMessage.gmail`, "must be a plain object");
  }
  const gmailMessageId = clean(parsed.gmail.messageId);
  if (!gmailMessageId) {
    throw invalidArgument(`observations[${index}].parsedMessage.gmail.messageId`, "must not be empty");
  }
  const gmailThreadId = clean(parsed.gmail.threadId);
  const subject = String(parsed.subject || "");
  const { currentText, quotedText } = splitCurrentAndQuotedText(parsed.text);
  const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
  const mentions = [];
  const suffixAmbiguities = [];
  const subjectResult = extractAwbMentionsFromField(subject, "subject");
  mentions.push(...subjectResult.mentions);
  suffixAmbiguities.push(...suffixAmbiguitiesFromField(subject, "subject", subjectResult.occupied));
  const bodyResult = extractAwbMentionsFromField(currentText, "text");
  mentions.push(...bodyResult.mentions);
  suffixAmbiguities.push(...suffixAmbiguitiesFromField(currentText, "text", bodyResult.occupied));
  attachments.forEach((attachment, attachmentOrdinal) => {
    const filename = String(attachment?.filename || "");
    const attachmentResult = extractAwbMentionsFromField(filename, "attachment_filename", {
      attachmentOrdinal,
      attachmentId: clean(attachment?.attachmentId),
    });
    mentions.push(...attachmentResult.mentions);
    suffixAmbiguities.push(...suffixAmbiguitiesFromField(
      filename,
      "attachment_filename",
      attachmentResult.occupied,
      { attachmentOrdinal, attachmentId: clean(attachment?.attachmentId) },
    ));
  });
  const quotedResult = extractAwbMentionsFromField(quotedText, "quoted_text");
  const directMentions = [...new Map(mentions.map((mention) => [mentionKey(mention), mention])).values()]
    .sort((left, right) => mentionKey(left).localeCompare(mentionKey(right)));
  const addresses = [
    ...flattenMailboxes(parsed.from, "from"),
    ...flattenMailboxes(parsed.to, "to"),
    ...flattenMailboxes(parsed.cc, "cc"),
  ];
  const fromAddresses = sortedUnique(flattenMailboxes(parsed.from, "from").map((item) => item.address));
  const recipientAddresses = sortedUnique([
    ...flattenMailboxes(parsed.to, "to"),
    ...flattenMailboxes(parsed.cc, "cc"),
  ].map((item) => item.address));
  const rfcMessageId = normalizeRfcMessageId(parsed.rfcMessageId);
  const referencedRfcMessageIds = sortedUnique([
    ...extractRfcMessageIds(parsed.inReplyTo),
    ...extractRfcMessageIds(parsed.references),
  ]);
  const { timeMs, recordedAt } = parseSourceTime(raw, parsed);
  const normalizedParsedFingerprint = sha256Json({
    gmailMessageId,
    gmailThreadId,
    internalDate: parsed.gmail.internalDate === undefined ? "" : String(parsed.gmail.internalDate),
    rfcMessageId,
    referencedRfcMessageIds,
    fromAddresses,
    recipientAddresses,
    subject,
    currentText,
    quotedText,
    attachments: attachments.map((attachment) => ({
      attachmentId: clean(attachment?.attachmentId),
      filename: String(attachment?.filename || ""),
      contentHash: clean(attachment?.contentHash),
    })),
  });
  return {
    observationId,
    contentHash,
    parsedFingerprint: normalizedParsedFingerprint,
    gmailMessageId,
    gmailThreadId,
    rfcMessageId,
    referencedRfcMessageIds,
    subject,
    currentText,
    quotedText,
    attachments,
    directMentions,
    directAwbs: sortedUnique(directMentions.map((mention) => mention.normalizedAwb)),
    quotedAwbs: sortedUnique(quotedResult.mentions.map((mention) => mention.normalizedAwb)),
    suffixAmbiguities,
    addresses,
    fromAddresses,
    recipientAddresses,
    timeMs,
    recordedAt,
  };
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) throw invalidArgument("observations", "must be an array");
  const byId = new Map();
  observations.forEach((raw, index) => {
    const observation = normalizeObservation(raw, index);
    const existing = byId.get(observation.observationId);
    if (!existing) {
      byId.set(observation.observationId, observation);
      return;
    }
    if (
      existing.contentHash !== observation.contentHash
      || existing.parsedFingerprint !== observation.parsedFingerprint
    ) {
      throw new GmailCrossThreadLinkerError(
        `Observation ${observation.observationId} was repeated with conflicting immutable content`,
        { code: "GMAIL_CROSS_THREAD_LINKER_INTEGRITY_CONFLICT", field: "observations" },
      );
    }
  });
  return [...byId.values()].sort((left, right) => left.observationId.localeCompare(right.observationId));
}

class UnionFind {
  constructor(keys) {
    this.parent = new Map();
    for (const key of keys) this.parent.set(key, key);
  }

  find(key) {
    const parent = this.parent.get(key);
    if (parent === undefined) return "";
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (!leftRoot || !rightRoot || leftRoot === rightRoot) return;
    const [root, child] = [leftRoot, rightRoot].sort();
    this.parent.set(child, root);
  }

  groups() {
    const result = new Map();
    for (const key of [...this.parent.keys()].sort()) {
      const root = this.find(key);
      if (!result.has(root)) result.set(root, []);
      result.get(root).push(key);
    }
    return result;
  }
}

function graphEdgeId(edge) {
  return `gmail-graph-edge:v1:${sha256Json(edge)}`;
}

function buildMessageGraph(observations) {
  const byId = new Map(observations.map((observation) => [observation.observationId, observation]));
  const union = new UnionFind(observations.map((observation) => observation.observationId));
  const edgeMap = new Map();
  const addEdge = (left, right, edgeType, basis) => {
    if (!left || !right || left === right) return;
    const [fromObservationId, toObservationId] = [left, right].sort();
    const edge = { fromObservationId, toObservationId, edgeType, basis };
    const key = stableJson(edge);
    if (!edgeMap.has(key)) edgeMap.set(key, { edgeId: graphEdgeId(edge), ...edge });
    union.union(fromObservationId, toObservationId);
  };

  const byThread = new Map();
  for (const observation of observations) {
    if (!observation.gmailThreadId) continue;
    if (!byThread.has(observation.gmailThreadId)) byThread.set(observation.gmailThreadId, []);
    byThread.get(observation.gmailThreadId).push(observation.observationId);
  }
  for (const [threadId, ids] of [...byThread.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const sortedIds = sortedUnique(ids);
    for (let index = 1; index < sortedIds.length; index += 1) {
      addEdge(sortedIds[0], sortedIds[index], "gmail_thread", { gmailThreadId: threadId });
    }
  }

  const rfcOwners = new Map();
  for (const observation of observations) {
    if (!observation.rfcMessageId) continue;
    if (!rfcOwners.has(observation.rfcMessageId)) rfcOwners.set(observation.rfcMessageId, []);
    rfcOwners.get(observation.rfcMessageId).push(observation.observationId);
  }
  for (const [rfcMessageId, ids] of rfcOwners.entries()) {
    const sortedIds = sortedUnique(ids);
    for (let index = 1; index < sortedIds.length; index += 1) {
      addEdge(sortedIds[0], sortedIds[index], "rfc_message_id_duplicate", { rfcMessageId });
    }
  }
  for (const observation of observations) {
    for (const referencedId of observation.referencedRfcMessageIds) {
      for (const ownerId of rfcOwners.get(referencedId) || []) {
        addEdge(observation.observationId, ownerId, "rfc_reference", { rfcMessageId: referencedId });
      }
    }
  }

  const edges = [...edgeMap.values()].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const edgeIdsByObservation = new Map();
  for (const edge of edges) {
    for (const observationId of [edge.fromObservationId, edge.toObservationId]) {
      if (!edgeIdsByObservation.has(observationId)) edgeIdsByObservation.set(observationId, []);
      edgeIdsByObservation.get(observationId).push(edge.edgeId);
    }
  }
  const components = [];
  const observationToComponent = new Map();
  for (const ids of union.groups().values()) {
    const observationIds = sortedUnique(ids);
    const rows = observationIds.map((id) => byId.get(id));
    const componentEdgeIds = sortedUnique(observationIds.flatMap((observationId) => (
      edgeIdsByObservation.get(observationId) || []
    )));
    const identity = {
      observationCoordinates: rows.map((row) => ({
        observationId: row.observationId,
        contentHash: row.contentHash,
      })),
    };
    const componentId = `gmail-component:v1:${sha256Json(identity)}`;
    const component = {
      componentId,
      observationIds,
      gmailMessageIds: sortedUnique(rows.map((row) => row.gmailMessageId)),
      gmailThreadIds: sortedUnique(rows.map((row) => row.gmailThreadId)),
      rfcMessageIds: sortedUnique(rows.map((row) => row.rfcMessageId)),
      explicitShipmentKeys: sortedUnique(rows.flatMap((row) => row.directAwbs)),
      edgeIds: componentEdgeIds,
    };
    components.push(component);
    for (const observationId of observationIds) observationToComponent.set(observationId, componentId);
  }
  components.sort((left, right) => left.componentId.localeCompare(right.componentId));
  return { edges, components, observationToComponent };
}

function normalizeSubjectTemplate(subject) {
  let normalized = String(subject || "").normalize("NFKC").toLowerCase();
  normalized = normalized.replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/i, "");
  normalized = normalized.replace(/(^|\D)\d{3}[-\s]?\d{8}(?!\d)/g, "$1 <awb> ");
  normalized = normalized.replace(/[\[\]{}()#_:;,.|/\\-]+/g, " ");
  return clean(normalized);
}

function operationalPurpose(subject, currentText) {
  const text = `${subject}\n${currentText}`.toLowerCase();
  if (/\b(?:pod|proof of delivery)\b/.test(text)) return "pod_closeout";
  if (/\b(?:inbound alert|pick\s*up|pickup|recover(?:y|ed)?|dispatch|driver)\b/.test(text)) {
    return "pickup_execution";
  }
  if (/\b(?:delivery|deliver)\b/.test(text)) return "delivery_execution";
  if (/\b(?:customs|release|delivery order|\bdo\b)\b/.test(text)) return "customs_release";
  if (/\b(?:quote|rate|pricing)\b/.test(text)) return "transport_quote";
  if (/\balert\b/.test(text)) return "operational_alert";
  return "";
}

function groupScopeSignal(text, expectedCount) {
  const normalized = clean(text).toLowerCase();
  if (!normalized) return null;
  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  let explicitCount = null;
  const countMatch = normalized.match(/\b(?:all\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:shipments?|awbs?|loads?|jobs?|alerts?)\b/i);
  if (countMatch) explicitCount = /^\d+$/.test(countMatch[1]) ? Number(countMatch[1]) : numberWords[countMatch[1]];
  if (/\bboth\b/i.test(normalized) && explicitCount === null) explicitCount = 2;
  const allScope = /\b(?:all(?:\s+of)?\s+(?:them|these|those)|them\s+all|all\s+(?:shipments?|awbs?|loads?|jobs?|alerts?))\b/i.test(normalized)
    || Boolean(countMatch && /\ball\b/i.test(countMatch[0]));
  const pluralScope = allScope
    || explicitCount !== null
    || /\b(?:these|those)\s+(?:shipments?|awbs?|loads?|jobs?|alerts?)\b/i.test(normalized);
  if (!pluralScope) return null;
  return {
    allScope,
    explicitCount,
    countMatchesExpected: explicitCount === null || explicitCount === expectedCount,
    evidenceText: countMatch?.[0]
      || normalized.match(/\b(?:all(?:\s+of)?\s+(?:them|these|those)|them\s+all|all\s+(?:shipments?|awbs?|loads?|jobs?|alerts?)|(?:these|those)\s+(?:shipments?|awbs?|loads?|jobs?|alerts?))\b/i)?.[0]
      || "plural group wording",
  };
}

function observationBrokerContext(observation, options) {
  const allAddresses = sortedUnique(observation.addresses.map((item) => item.address));
  const brokerKeys = sortedUnique(allAddresses.map((address) => brokerKeyForAddress(address, options)));
  const fromInternal = observation.fromAddresses.some((address) => isInternalAddress(address, options));
  const toInternal = observation.recipientAddresses.some((address) => isInternalAddress(address, options));
  const externalRecipientKeys = sortedUnique(observation.recipientAddresses.map((address) => (
    brokerKeyForAddress(address, options)
  )));
  const externalSenderKeys = sortedUnique(observation.fromAddresses.map((address) => (
    brokerKeyForAddress(address, options)
  )));
  return {
    brokerKeys,
    fromInternal,
    toInternal,
    externalRecipientKeys,
    externalSenderKeys,
    outbound: fromInternal && externalRecipientKeys.length > 0,
    inbound: !fromInternal && toInternal && externalSenderKeys.length > 0,
  };
}

function makeDiagnostic(kind, payload) {
  const body = canonicalize(payload);
  return {
    [`${kind}Id`]: `${kind}:v1:${sha256Json(body)}`,
    ...body,
  };
}

function makeCandidateLink(fields, autoAcceptThreshold) {
  const confidence = clampConfidence(fields.confidence);
  const core = {
    linkKey: `entity-link:v1:${sha256Json({
      observationId: fields.observationId,
      entityType: fields.entityType,
      entityKey: fields.entityKey,
      relationship: fields.relationship,
    })}`,
    versionNo: 1,
    previousLinkVersionId: null,
    observationId: fields.observationId,
    entityType: fields.entityType,
    entityKey: fields.entityKey,
    relationship: fields.relationship,
    decision: "linked",
    confidence,
    linkMethod: "deterministic",
    linkerVersion: LINKER_VERSION,
    evidenceSpan: canonicalize(fields.evidenceSpan || {}),
    recordedAt: fields.recordedAt,
    schemaVersion: LINK_SCHEMA_VERSION,
    reasonCode: fields.reasonCode,
    candidateStatus: "proposed",
    autoAcceptEligible: Boolean(fields.autoAcceptEligible !== false && confidence >= autoAcceptThreshold),
  };
  return {
    candidateLinkId: `candidate-link:v1:${sha256Json(core)}`,
    ...core,
  };
}

function directMentionConfidence(mention) {
  if (mention.evidenceSpan.field === "attachment_filename") return 0.95;
  if (mention.evidenceSpan.field === "subject") return 0.995;
  return 0.99;
}

function addCandidateLink(linkMap, link) {
  const key = [link.observationId, link.entityType, link.entityKey, link.relationship].join("|");
  const existing = linkMap.get(key);
  if (!existing || link.confidence > existing.confidence) linkMap.set(key, link);
}

function alertCandidateForObservation(observation, context, options, ambiguities) {
  if (!context.outbound) return null;
  const purpose = operationalPurpose(observation.subject, observation.currentText);
  const subjectTemplate = normalizeSubjectTemplate(observation.subject);
  const looksLikeAlert = /\b(?:alert|pick\s*up|pickup|dispatch|recover|delivery|quote|rate)\b/i.test(
    `${observation.subject}\n${observation.currentText}`,
  );
  if (!looksLikeAlert) return null;
  if (!observation.directAwbs.length) {
    ambiguities.push(makeDiagnostic("ambiguity", {
      observationId: observation.observationId,
      reasonCode: "outbound_operational_message_without_full_awb",
      detail: "The message resembles an operational alert but has no explicit full 11-digit AWB.",
    }));
    return null;
  }
  if (context.externalRecipientKeys.length !== 1) {
    ambiguities.push(makeDiagnostic("ambiguity", {
      observationId: observation.observationId,
      reasonCode: "outbound_alert_has_ambiguous_broker_set",
      brokerKeys: context.externalRecipientKeys,
    }));
    return null;
  }
  if (!purpose || !subjectTemplate) {
    ambiguities.push(makeDiagnostic("ambiguity", {
      observationId: observation.observationId,
      reasonCode: "outbound_alert_missing_purpose_or_template",
      purpose,
      subjectTemplate,
    }));
    return null;
  }
  if (observation.timeMs === null) {
    ambiguities.push(makeDiagnostic("ambiguity", {
      observationId: observation.observationId,
      reasonCode: "outbound_alert_missing_source_time",
    }));
    return null;
  }
  const core = {
    observationId: observation.observationId,
    componentId: "",
    shipmentKeys: observation.directAwbs,
    brokerKeys: context.externalRecipientKeys,
    purpose,
    subjectTemplate,
    sourceTimeMs: observation.timeMs,
    sourceRecordedAt: observation.recordedAt,
  };
  return {
    alertCandidateId: `alert-candidate:v1:${sha256Json(core)}`,
    ...core,
  };
}

function batchSessions(alerts, options, alertUnion) {
  const grouped = new Map();
  for (const alert of alerts) {
    const key = stableJson({
      brokerKeys: alert.brokerKeys,
      purpose: alert.purpose,
      subjectTemplate: alert.subjectTemplate,
    });
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(alert);
  }
  const sessions = [];
  for (const [templateKey, group] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const ordered = [...group].sort((left, right) => (
      left.sourceTimeMs - right.sourceTimeMs || left.observationId.localeCompare(right.observationId)
    ));
    let current = [];
    for (const alert of ordered) {
      if (!current.length || alert.sourceTimeMs - current[0].sourceTimeMs <= options.maxAlertBatchWindowMs) {
        current.push(alert);
      } else {
        sessions.push({ templateKey, alerts: current });
        current = [alert];
      }
    }
    if (current.length) sessions.push({ templateKey, alerts: current });
  }
  return sessions.map((session) => {
    const alertIds = session.alerts.map((alert) => alert.alertCandidateId).sort();
    if (alertIds.length >= 2) {
      for (let index = 1; index < alertIds.length; index += 1) alertUnion.union(alertIds[0], alertIds[index]);
    }
    const body = {
      brokerKeys: session.alerts[0].brokerKeys,
      purpose: session.alerts[0].purpose,
      subjectTemplate: session.alerts[0].subjectTemplate,
      alertObservationIds: session.alerts.map((alert) => alert.observationId).sort(),
      shipmentKeys: sortedUnique(session.alerts.flatMap((alert) => alert.shipmentKeys)),
      windowStart: session.alerts[0].sourceRecordedAt,
      windowEnd: session.alerts[session.alerts.length - 1].sourceRecordedAt,
      withinBoundedWindow: true,
    };
    return {
      alertBatchCandidateId: `alert-batch:v1:${sha256Json(body)}`,
      ...body,
    };
  }).sort((left, right) => left.alertBatchCandidateId.localeCompare(right.alertBatchCandidateId));
}

function bridgeAlertBatches({ alerts, observations, graph, contexts, options, alertUnion }) {
  const alertById = new Map(alerts.map((alert) => [alert.alertCandidateId, alert]));
  const alertByShipment = new Map();
  for (const alert of alerts) {
    for (const awb of alert.shipmentKeys) {
      if (!alertByShipment.has(awb)) alertByShipment.set(awb, []);
      alertByShipment.get(awb).push(alert);
    }
  }
  const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const bridges = [];
  for (const component of graph.components) {
    if (component.explicitShipmentKeys.length < 2) continue;
    const componentRows = component.observationIds.map((id) => observationById.get(id));
    const componentTimes = componentRows.map((row) => row.timeMs).filter(Number.isFinite);
    if (!componentTimes.length) continue;
    const componentBrokerKeys = sortedUnique(componentRows.flatMap((row) => contexts.get(row.observationId).brokerKeys));
    const potentialAlerts = sortedUnique(component.explicitShipmentKeys.flatMap((awb) => (
      (alertByShipment.get(awb) || []).map((alert) => alert.alertCandidateId)
    ))).map((id) => alertById.get(id));
    const byBrokerPurpose = new Map();
    for (const alert of potentialAlerts) {
      if (!alert || !alert.brokerKeys.some((brokerKey) => componentBrokerKeys.includes(brokerKey))) continue;
      const minComponentDistance = Math.min(...componentTimes.map((time) => Math.abs(time - alert.sourceTimeMs)));
      if (minComponentDistance > options.maxAlertBatchWindowMs) continue;
      const key = stableJson({ brokerKeys: alert.brokerKeys, purpose: alert.purpose });
      if (!byBrokerPurpose.has(key)) byBrokerPurpose.set(key, []);
      byBrokerPurpose.get(key).push(alert);
    }
    for (const group of byBrokerPurpose.values()) {
      const distinct = [...new Map(group.map((alert) => [alert.alertCandidateId, alert])).values()]
        .sort((left, right) => left.alertCandidateId.localeCompare(right.alertCandidateId));
      if (distinct.length < 2) continue;
      const allTimes = distinct.map((alert) => alert.sourceTimeMs);
      if (Math.max(...allTimes) - Math.min(...allTimes) > options.maxAlertBatchWindowMs) continue;
      for (let index = 1; index < distinct.length; index += 1) {
        alertUnion.union(distinct[0].alertCandidateId, distinct[index].alertCandidateId);
      }
      const body = {
        componentId: component.componentId,
        observationIds: component.observationIds,
        explicitShipmentKeys: component.explicitShipmentKeys,
        alertCandidateIds: distinct.map((alert) => alert.alertCandidateId),
        brokerKeys: distinct[0].brokerKeys,
        purpose: distinct[0].purpose,
        reasonCode: "multi_awb_component_bridges_alert_batches",
      };
      bridges.push({ bridgeId: `alert-bridge:v1:${sha256Json(body)}`, ...body });
    }
  }
  return bridges.sort((left, right) => left.bridgeId.localeCompare(right.bridgeId));
}

function workgroupTypeForPurposes(purposes) {
  if (purposes.includes("pickup_execution")) return "pickup";
  if (purposes.includes("delivery_execution")) return "delivery";
  if (purposes.includes("pod_closeout")) return "pod";
  if (purposes.includes("customs_release")) return "release";
  if (purposes.includes("transport_quote")) return "quote";
  return "context";
}

function evidenceForObservation(observation, role, reasonCode, evidenceSpan = {}) {
  return {
    observationId: observation.observationId,
    evidenceRole: role,
    reasonCode,
    evidenceSpan: canonicalize(evidenceSpan),
  };
}

function makeMembership(
  workgroupIdentityKey,
  memberType,
  memberKey,
  role,
  confidence,
  evidence,
  autoAcceptEligible = false,
) {
  const core = {
    workgroupIdentityKey,
    memberType,
    memberKey,
    role,
    decision: "added",
    confidence: clampConfidence(confidence),
    membershipMethod: "deterministic",
    linkerVersion: LINKER_VERSION,
    candidateStatus: "proposed",
    autoAcceptEligible: Boolean(autoAcceptEligible),
    evidence,
  };
  return {
    candidateMembershipId: `candidate-membership:v1:${sha256Json(core)}`,
    ...core,
  };
}

function buildCandidateWorkgroups({
  alerts,
  alertUnion,
  observations,
  graph,
  contexts,
  bridges,
  options,
  linkMap,
  ambiguities,
}) {
  const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const componentById = new Map(graph.components.map((component) => [component.componentId, component]));
  const alertById = new Map(alerts.map((alert) => [alert.alertCandidateId, alert]));
  const workgroups = [];
  const emittedAlertIds = new Set();
  for (const alertIds of alertUnion.groups().values()) {
    const groupAlerts = alertIds.map((id) => alertById.get(id)).filter(Boolean);
    const shipmentKeys = sortedUnique(groupAlerts.flatMap((alert) => alert.shipmentKeys));
    if (groupAlerts.length < 2 || shipmentKeys.length < 2) continue;
    const brokerKeys = sortedUnique(groupAlerts.flatMap((alert) => alert.brokerKeys));
    const purposes = sortedUnique(groupAlerts.map((alert) => alert.purpose));
    if (brokerKeys.length !== 1) continue;
    groupAlerts.forEach((alert) => emittedAlertIds.add(alert.alertCandidateId));

    const componentIds = sortedUnique(groupAlerts.map((alert) => alert.componentId));
    const memberObservationIds = sortedUnique(componentIds.flatMap((componentId) => (
      componentById.get(componentId)?.observationIds || []
    )));
    const memberRows = memberObservationIds.map((id) => observationById.get(id));
    const reasons = [{
      reasonCode: "same_broker_template_purpose_bounded_alert_batch",
      confidenceContribution: 0.72,
      alertObservationIds: groupAlerts.map((alert) => alert.observationId).sort(),
    }];
    let confidence = 0.72;
    const relevantBridges = bridges.filter((bridge) => (
      bridge.alertCandidateIds.some((id) => alertIds.includes(id))
    ));
    if (relevantBridges.length) {
      confidence = Math.max(confidence, 0.82);
      reasons.push({
        reasonCode: "multi_awb_component_bridges_alert_batches",
        confidenceContribution: 0.1,
        bridgeIds: relevantBridges.map((bridge) => bridge.bridgeId).sort(),
      });
    }

    const replyEvidence = [];
    for (const row of memberRows) {
      const context = contexts.get(row.observationId);
      if (!context.inbound || !context.externalSenderKeys.some((key) => brokerKeys.includes(key))) continue;
      const signal = groupScopeSignal(`${row.subject}\n${row.currentText}`, shipmentKeys.length);
      if (!signal) continue;
      if (!signal.countMatchesExpected) {
        ambiguities.push(makeDiagnostic("ambiguity", {
          observationId: row.observationId,
          reasonCode: "group_reply_count_conflicts_with_alert_batch",
          expectedShipmentCount: shipmentKeys.length,
          statedShipmentCount: signal.explicitCount,
          evidenceText: signal.evidenceText,
        }));
        continue;
      }
      const evidenceSpan = {
        field: "text",
        text: signal.evidenceText,
        scope: signal.allScope ? "all" : "plural",
        statedCount: signal.explicitCount,
      };
      replyEvidence.push(evidenceForObservation(
        row,
        "supporting",
        "broker_plural_reply_confirms_batch_scope",
        evidenceSpan,
      ));
    }
    const exactCountReplyEvidence = replyEvidence.filter((item) => (
      Number.isSafeInteger(item.evidenceSpan?.statedCount)
      && item.evidenceSpan.statedCount === shipmentKeys.length
    ));
    const explicitGroupConfirmed = exactCountReplyEvidence.length > 0;
    if (replyEvidence.length) {
      confidence = Math.max(
        confidence,
        explicitGroupConfirmed ? EXPLICIT_GROUP_CONFIRMATION_CONFIDENCE : 0.8,
      );
      reasons.push({
        reasonCode: "broker_plural_reply_confirms_batch_scope",
        confidenceContribution: explicitGroupConfirmed ? 0.25 : 0.08,
        observationIds: replyEvidence.map((item) => item.observationId).sort(),
        exactCountConfirmed: explicitGroupConfirmed,
      });
    }
    if (!explicitGroupConfirmed) {
      confidence = Math.min(HEURISTIC_WORKGROUP_MAX_CONFIDENCE, confidence);
    }

    const identityBasis = { shipmentKeys, brokerKeys, purposes };
    const identityKey = `operational-workgroup:v1:${sha256Json(identityBasis)}`;
    const createdAt = groupAlerts
      .map((alert) => alert.sourceRecordedAt)
      .filter(Boolean)
      .sort()[0] || null;
    const primaryAlert = [...groupAlerts].sort((left, right) => (
      left.sourceTimeMs - right.sourceTimeMs || left.observationId.localeCompare(right.observationId)
    ))[0];
    const batchEvidence = groupAlerts.map((alert) => evidenceForObservation(
      observationById.get(alert.observationId),
      alert.observationId === primaryAlert.observationId ? "primary" : "supporting",
      "outbound_alert_batch_member",
      {
        field: "subject",
        subjectTemplate: alert.subjectTemplate,
        shipmentKeys: alert.shipmentKeys,
        brokerKeys: alert.brokerKeys,
      },
    ));
    const evidence = [...batchEvidence, ...replyEvidence]
      .sort((left, right) => (
        left.observationId.localeCompare(right.observationId)
        || left.reasonCode.localeCompare(right.reasonCode)
      ));
    const definition = {
      workgroupType: workgroupTypeForPurposes(purposes),
      identityKey,
      identityBasis,
      createdMethod: "deterministic",
      linkerVersion: LINKER_VERSION,
      initialConfidence: clampConfidence(confidence),
      createdAt,
      schemaVersion: WORKGROUP_SCHEMA_VERSION,
    };
    const memberships = [
      ...shipmentKeys.map((awb) => makeMembership(
        identityKey,
        "shipment",
        awb,
        "shared_execution_shipment",
        confidence,
        evidence.filter((item) => {
          const alert = groupAlerts.find((candidate) => candidate.observationId === item.observationId);
          return item.reasonCode === "broker_plural_reply_confirms_batch_scope"
            || alert?.shipmentKeys.includes(awb);
        }),
        explicitGroupConfirmed,
      )),
      ...brokerKeys.map((brokerKey) => makeMembership(
        identityKey,
        "broker",
        brokerKey,
        "execution_counterparty",
        confidence,
        batchEvidence,
        explicitGroupConfirmed,
      )),
      ...memberObservationIds.map((observationId) => makeMembership(
        identityKey,
        "gmail_message",
        observationById.get(observationId).gmailMessageId,
        "workgroup_evidence_message",
        confidence,
        evidence.filter((item) => item.observationId === observationId),
        explicitGroupConfirmed,
      )),
    ].sort((left, right) => left.candidateMembershipId.localeCompare(right.candidateMembershipId));
    const threadIds = sortedUnique(memberRows.map((row) => row.gmailThreadId));
    const workgroupCore = {
      definition,
      acceptanceStatus: "candidate",
      requiresReview: !explicitGroupConfirmed,
      autoAcceptEligible: explicitGroupConfirmed,
      heuristicGrouping: !explicitGroupConfirmed,
      componentIds,
      threadIds,
      observationIds: memberObservationIds,
      evidence,
      reasons: reasons.sort((left, right) => left.reasonCode.localeCompare(right.reasonCode)),
      memberships,
    };
    const workgroup = {
      candidateWorkgroupId: `candidate-workgroup:v1:${sha256Json(workgroupCore)}`,
      ...workgroupCore,
    };
    workgroups.push(workgroup);

    for (const row of memberRows) {
      for (const awb of shipmentKeys) {
        addCandidateLink(linkMap, makeCandidateLink({
          observationId: row.observationId,
          entityType: "shipment",
          entityKey: awb,
          relationship: "shared_execution",
          confidence,
          evidenceSpan: {
            kind: "operational_workgroup_candidate",
            candidateWorkgroupId: workgroup.candidateWorkgroupId,
            identityKey,
            basisObservationIds: evidence.map((item) => item.observationId),
          },
          recordedAt: row.recordedAt,
          reasonCode: "alert_batch_workgroup_propagation",
          autoAcceptEligible: explicitGroupConfirmed,
        }, options.autoAcceptThreshold));
      }
    }
  }
  return {
    workgroups: workgroups.sort((left, right) => left.candidateWorkgroupId.localeCompare(right.candidateWorkgroupId)),
    emittedAlertIds,
  };
}

function exclusionReasonForAlert(alert, alerts, options) {
  const peers = alerts.filter((candidate) => (
    candidate.alertCandidateId !== alert.alertCandidateId
    && stableJson(candidate.brokerKeys) === stableJson(alert.brokerKeys)
  ));
  if (peers.some((candidate) => (
    candidate.purpose === alert.purpose
    && candidate.subjectTemplate === alert.subjectTemplate
    && Math.abs(candidate.sourceTimeMs - alert.sourceTimeMs) > options.maxAlertBatchWindowMs
  ))) return "outside_bounded_alert_window";
  if (peers.length) return "template_or_purpose_mismatch";
  return "singleton_alert_no_batch_evidence";
}

function linkGmailObservations(observationRecords, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const observations = normalizeObservations(observationRecords);
  const inputManifest = observations.map((observation) => ({
    observationId: observation.observationId,
    contentHash: observation.contentHash,
    parsedFingerprint: observation.parsedFingerprint,
  }));
  const inputManifestHash = sha256Json(inputManifest);
  const graph = buildMessageGraph(observations);
  const observationById = new Map(observations.map((observation) => [observation.observationId, observation]));
  const componentById = new Map(graph.components.map((component) => [component.componentId, component]));
  const contexts = new Map(observations.map((observation) => [
    observation.observationId,
    observationBrokerContext(observation, options),
  ]));
  const linkMap = new Map();
  const ambiguities = [];
  const exclusions = [];

  for (const observation of observations) {
    for (const mention of observation.directMentions) {
      addCandidateLink(linkMap, makeCandidateLink({
        observationId: observation.observationId,
        entityType: "shipment",
        entityKey: mention.normalizedAwb,
        relationship: "mentions",
        confidence: directMentionConfidence(mention),
        evidenceSpan: mention.evidenceSpan,
        recordedAt: observation.recordedAt,
        reasonCode: "explicit_full_awb_mention",
      }, options.autoAcceptThreshold));
    }
    if (observation.gmailThreadId) {
      addCandidateLink(linkMap, makeCandidateLink({
        observationId: observation.observationId,
        entityType: "gmail_thread",
        entityKey: observation.gmailThreadId,
        relationship: "applies_to",
        confidence: 1,
        evidenceSpan: { field: "gmail.threadId", text: observation.gmailThreadId },
        recordedAt: observation.recordedAt,
        reasonCode: "gmail_provider_thread_identity",
      }, options.autoAcceptThreshold));
    }
    for (const suffix of observation.suffixAmbiguities) {
      ambiguities.push(makeDiagnostic("ambiguity", {
        observationId: observation.observationId,
        ...suffix,
        detail: "An 8-digit suffix is not enough to create a shipment key; no airline prefix was inferred.",
      }));
    }
    for (const awb of observation.quotedAwbs.filter((item) => !observation.directAwbs.includes(item))) {
      ambiguities.push(makeDiagnostic("ambiguity", {
        observationId: observation.observationId,
        reasonCode: "quoted_awb_not_used_as_component_seed",
        shipmentKey: awb,
        detail: "Quoted history alone did not create or extend the current message shipment scope.",
      }));
    }
  }

  for (const component of graph.components) {
    if (!component.explicitShipmentKeys.length) continue;
    const basisObservationIds = component.observationIds.filter((observationId) => (
      observationById.get(observationId).directAwbs.length > 0
    ));
    for (const observationId of component.observationIds) {
      const observation = observationById.get(observationId);
      for (const awb of component.explicitShipmentKeys) {
        if (observation.directAwbs.includes(awb)) continue;
        addCandidateLink(linkMap, makeCandidateLink({
          observationId,
          entityType: "shipment",
          entityKey: awb,
          relationship: "applies_to",
          confidence: 0.965,
          evidenceSpan: {
            kind: "message_graph_component",
            componentId: component.componentId,
            edgeIds: component.edgeIds,
            basisObservationIds,
          },
          recordedAt: observation.recordedAt,
          reasonCode: "gmail_thread_or_rfc_component_propagation",
        }, options.autoAcceptThreshold));
      }
    }
  }

  const alerts = [];
  for (const observation of observations) {
    const context = contexts.get(observation.observationId);
    const alert = alertCandidateForObservation(observation, context, options, ambiguities);
    if (alert) {
      alert.componentId = graph.observationToComponent.get(observation.observationId);
      alerts.push(alert);
    }
  }
  alerts.sort((left, right) => left.alertCandidateId.localeCompare(right.alertCandidateId));
  // An external participant is not automatically a pickup broker. Broker links
  // are proposed only when an outbound operational alert establishes that role,
  // or when that same counterparty replies inside the alert's message graph.
  for (const alert of alerts) {
    const alertObservation = observationById.get(alert.observationId);
    const component = componentById.get(alert.componentId);
    for (const brokerKey of alert.brokerKeys) {
      addCandidateLink(linkMap, makeCandidateLink({
        observationId: alertObservation.observationId,
        entityType: "broker",
        entityKey: brokerKey,
        relationship: "applies_to",
        confidence: 0.86,
        evidenceSpan: {
          field: "email_participants",
          roleBasis: "outbound_operational_alert_recipient",
          addresses: sortedUnique(alertObservation.addresses
            .map((item) => item.address)
            .filter((address) => brokerKeyForAddress(address, options) === brokerKey)),
        },
        recordedAt: alertObservation.recordedAt,
        reasonCode: "outbound_operational_alert_broker_candidate",
        autoAcceptEligible: false,
      }, options.autoAcceptThreshold));
      for (const observationId of component?.observationIds || []) {
        const row = observationById.get(observationId);
        const context = contexts.get(observationId);
        if (!context.inbound || !context.externalSenderKeys.includes(brokerKey)) continue;
        addCandidateLink(linkMap, makeCandidateLink({
          observationId,
          entityType: "broker",
          entityKey: brokerKey,
          relationship: "applies_to",
          confidence: 0.9,
          evidenceSpan: {
            field: "from",
            roleBasis: "reply_from_outbound_alert_counterparty",
            addresses: row.fromAddresses,
            basisAlertObservationId: alert.observationId,
          },
          recordedAt: row.recordedAt,
          reasonCode: "reply_from_alert_broker_candidate",
          autoAcceptEligible: false,
        }, options.autoAcceptThreshold));
      }
    }
  }
  const alertUnion = new UnionFind(alerts.map((alert) => alert.alertCandidateId));
  const alertBatchCandidates = batchSessions(alerts, options, alertUnion);
  const bridges = bridgeAlertBatches({
    alerts,
    observations,
    graph,
    contexts,
    options,
    alertUnion,
  });
  const { workgroups, emittedAlertIds } = buildCandidateWorkgroups({
    alerts,
    alertUnion,
    observations,
    graph,
    contexts,
    bridges,
    options,
    linkMap,
    ambiguities,
  });

  for (const alert of alerts) {
    if (emittedAlertIds.has(alert.alertCandidateId)) continue;
    exclusions.push(makeDiagnostic("exclusion", {
      observationId: alert.observationId,
      reasonCode: exclusionReasonForAlert(alert, alerts, options),
      brokerKeys: alert.brokerKeys,
      purpose: alert.purpose,
      subjectTemplate: alert.subjectTemplate,
      shipmentKeys: alert.shipmentKeys,
      detail: "The outbound alert remains linked to its explicit shipment, but no cross-thread workgroup was proposed.",
    }));
  }
  const linkedObservationIds = new Set([...linkMap.values()].map((link) => link.observationId));
  for (const observation of observations) {
    if (linkedObservationIds.has(observation.observationId)) continue;
    exclusions.push(makeDiagnostic("exclusion", {
      observationId: observation.observationId,
      reasonCode: "no_supported_entity_evidence",
      detail: "No explicit full AWB, provider thread, RFC-linked scope, or supported broker workgroup evidence was found.",
    }));
  }

  const candidateLinks = [...linkMap.values()].sort((left, right) => (
    left.candidateLinkId.localeCompare(right.candidateLinkId)
  ));
  const result = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    linkerVersion: LINKER_VERSION,
    inputManifestHash,
    inputObservationCount: observations.length,
    graph: {
      components: graph.components,
      edges: graph.edges,
    },
    candidateLinks,
    alertBatchCandidates,
    alertBatchBridges: bridges,
    candidateWorkgroups: workgroups,
    ambiguities: [...new Map(ambiguities.map((item) => [item.ambiguityId, item])).values()]
      .sort((left, right) => left.ambiguityId.localeCompare(right.ambiguityId)),
    exclusions: [...new Map(exclusions.map((item) => [item.exclusionId, item])).values()]
      .sort((left, right) => left.exclusionId.localeCompare(right.exclusionId)),
  };
  return Object.freeze({
    ...result,
    outputHash: sha256Json(result),
  });
}

module.exports = {
  DEFAULT_ALERT_BATCH_WINDOW_MS,
  DEFAULT_AUTO_ACCEPT_THRESHOLD,
  EXPLICIT_GROUP_CONFIRMATION_CONFIDENCE,
  GmailCrossThreadLinkerError,
  HEURISTIC_WORKGROUP_MAX_CONFIDENCE,
  LINKER_VERSION,
  OUTPUT_SCHEMA_VERSION,
  linkGmailObservations,
  _test: {
    brokerKeyForAddress,
    buildMessageGraph,
    canonicalize,
    extractAwbMentionsFromField,
    groupScopeSignal,
    normalizeObservation,
    normalizeOptions,
    normalizeRfcMessageId,
    normalizeSubjectTemplate,
    operationalPurpose,
    sha256Json,
    splitCurrentAndQuotedText,
    stableJson,
    suffixAmbiguitiesFromField,
  },
};

"use strict";

const crypto = require("node:crypto");

const SIGNATURE_VOLATILE_KEYS = new Set([
  "changed",
  "compiledAt",
  "contentSignature",
  "tmsSyncedAt",
  "_truthPacketSnapshotTime",
  "attachmentId",
  "extractedTextLength",
  "extractedTextPreview",
  "gmailAttachmentAudit",
  "gmailAttachmentAuditCount",
  "gmailAttachmentAuditPersistedCount",
  "gmailSearchAudit",
  "heavySnapshotWrites",
  "historicalEvents",
  "historicalProof",
  "id",
  "lastCheckedAt",
  "messageId",
  "previousContentSignature",
  "packetId",
  "publisherTrigger",
  "skippedHeavySnapshotWrites",
  "snapshotTime",
  "threadId",
  "updatedAt",
  "writes",
]);

// Publication identity is intentionally stricter than the semantic snapshot
// signature above. It commits to exact evidence IDs and source pointers so a
// packet backed by a different Gmail message/attachment cannot reuse the same
// packet identity merely because the summaries happen to match.
const STRICT_SIGNATURE_VOLATILE_KEYS = new Set([
  "compiledAt",
  "contentSignature",
  "semanticSignature",
  "publicationSignature",
  "packetId",
  "publisherTrigger",
  "snapshotTime",
  "_truthPacketSnapshotTime",
]);

function postgresSafeJson(value) {
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (Array.isArray(value)) return value.map(postgresSafeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, postgresSafeJson(item)]));
}

function canonicalWithIgnoredKeys(value, ignoredKeys) {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalWithIgnoredKeys(item, ignoredKeys))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .filter((key) => !ignoredKeys.has(key) && typeof value[key] !== "undefined")
    .sort()
    .reduce((acc, key) => {
      acc[key] = canonicalWithIgnoredKeys(value[key], ignoredKeys);
      return acc;
    }, {});
}

function canonicalForSignature(value) {
  return canonicalWithIgnoredKeys(value, SIGNATURE_VOLATILE_KEYS);
}

function strictCanonicalForSignature(value) {
  return canonicalWithIgnoredKeys(value, STRICT_SIGNATURE_VOLATILE_KEYS);
}

function contentSignature(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalForSignature(postgresSafeJson(payload))))
    .digest("hex");
}

function strictContentSignature(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(strictCanonicalForSignature(postgresSafeJson(payload))))
    .digest("hex");
}

function withContentSignature(payload) {
  return {
    ...payload,
    contentSignature: contentSignature(payload),
  };
}

module.exports = {
  SIGNATURE_VOLATILE_KEYS,
  STRICT_SIGNATURE_VOLATILE_KEYS,
  canonicalForSignature,
  contentSignature,
  postgresSafeJson,
  strictCanonicalForSignature,
  strictContentSignature,
  withContentSignature,
};

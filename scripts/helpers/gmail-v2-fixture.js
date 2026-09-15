"use strict";

const {
  GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  GMAIL_PARSER_VERSION,
  _test: contractTest,
} = require("../../lib/truth-candidate-contract");
const { _test: parserTest } = require("../../lib/gmail-rfc822-parser");
const { _test: claimTest } = require("../../lib/gmail-claim-extractor");

function buildParsedGmailPayload({
  text,
  messageId,
  threadId = "broker-thread-fixture",
  sourceRecordedAt = "2026-07-09T14:30:00.000Z",
  subject = "Shipment status AWB 016-80000083",
  fromAddress = "broker@example.com",
  labels = ["INBOX"],
  historyId = "900719925474099312345",
  inReplyTo = "",
  references = "",
  rfcMessageId = `<${messageId}@example.com>`,
}) {
  const internalDate = String(Date.parse(sourceRecordedAt));
  const labelIds = [...new Set(labels)].sort();
  const rawObservationContentHash = contractTest.sha256Json({ messageId, raw: true });
  const domain = fromAddress.split("@")[1] || "example.com";
  return {
    schemaVersion: GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
    parserVersion: GMAIL_PARSER_VERSION,
    rawSha256: contractTest.sha256Text(`${messageId}:raw:${text}`),
    rawBytes: Buffer.byteLength(text, "utf8"),
    gmail: {
      messageId,
      threadId,
      historyId,
      providerHistoryId: historyId,
      internalDate,
      providerReceivedAt: sourceRecordedAt,
      labelIds,
      labelIdsHash: contractTest.sha256Json(labelIds),
      rawObservationId: `obs:v1:${rawObservationContentHash}`,
      rawObservationContentHash,
    },
    sourceChronology: {
      schemaVersion: "gmail-source-chronology-v1",
      sourceRecordedAt,
      sourceRecordedAtBasis: "gmail_internal_date",
      providerReceivedAt: sourceRecordedAt,
      providerInternalDateMillis: internalDate,
      rfc5322Date: {
        raw: "",
        status: "missing",
        authoredAt: null,
        chronologyEligible: false,
        fallbackSource: "gmail_internal_date",
      },
    },
    authenticationWitness: parserTest.trustedReceiverAuthenticationWitness([{
      key: "authentication-results",
      originalKey: "Authentication-Results",
      value: `mx.google.com; dmarc=pass header.from=${domain}; dkim=pass; spf=pass`,
    }]),
    headers: [],
    headerLines: [],
    from: { name: "Broker", address: fromAddress },
    sender: null,
    replyTo: [],
    deliveredTo: "contact-073@demo-freight.example",
    returnPath: fromAddress,
    to: [{ name: "Piki Ops", address: "contact-073@demo-freight.example" }],
    cc: [],
    bcc: [],
    subject,
    rfcMessageId,
    inReplyTo,
    references,
    date: sourceRecordedAt,
    text,
    html: "",
    attachments: [],
  };
}

function buildGmailObservation(options) {
  const payload = buildParsedGmailPayload(options);
  const contentHash = contractTest.sha256Json(payload);
  const sourceRecordedAt = payload.sourceChronology.sourceRecordedAt;
  return {
    observationId: `obs:v1:${contentHash}`,
    sourceSystem: "gmail",
    sourceObjectType: "gmail_message_parsed",
    sourceObjectId: payload.gmail.messageId,
    operation: "content",
    sourceRevision: payload.gmail.providerHistoryId,
    contentHash,
    sourceRecordedAt,
    capturedAt: options.capturedAt
      || new Date(Date.parse(sourceRecordedAt) + 60_000).toISOString(),
    normalizedPayload: payload,
    normalizedText: claimTest.buildNormalizedText(payload),
    schemaVersion: GMAIL_PARSED_MESSAGE_SCHEMA_VERSION,
  };
}

module.exports = {
  buildGmailObservation,
  buildParsedGmailPayload,
};

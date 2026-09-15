"use strict";

const crypto = require("node:crypto");
const { PREDICATES, REGISTRY } = require("./truth-predicate-registry");
const { IDEMPOTENCY_KEY_RE } = require("./truth-operator-event-ledger");

const COMMAND_SCHEMA_VERSION = "operator-browser-truth-command-v1";
const RECEIPT_SCHEMA_VERSION = "operator-browser-truth-receipt-v1";
const RUNTIME_VERSION = "truth-operator-browser-runtime-v1";
const AWB_RE = /^[0-9]{11}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// These are intentionally product commands, not caller-selected predicates.
// A browser cannot widen this map or provide its own assertion value.
const COMMANDS = Object.freeze({
  station_fees_paid: Object.freeze({
    summary: "I confirmed by phone that station fees were paid and no longer remain due.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "station_fees_due", polarity: "negative" }),
      Object.freeze({ predicate: "station_fees_paid", polarity: "positive" }),
    ]),
  }),
  station_fees_none_due: Object.freeze({
    summary: "I confirmed by phone that no station fees remain due.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "station_fees_due", polarity: "negative" }),
    ]),
  }),
  station_fees_due: Object.freeze({
    summary: "I confirmed by phone that station fees remain due and unpaid.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "station_fees_due", polarity: "positive" }),
      Object.freeze({ predicate: "station_fees_paid", polarity: "negative" }),
    ]),
  }),
  pickup_completed: Object.freeze({
    summary: "I confirmed by phone that the cargo was physically picked up.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "pickup_completed", polarity: "positive" }),
    ]),
  }),
  pickup_not_completed: Object.freeze({
    summary: "I confirmed by phone that the cargo has not been picked up.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "pickup_completed", polarity: "negative" }),
    ]),
  }),
  out_for_delivery: Object.freeze({
    summary: "I confirmed by phone that the cargo is out for delivery.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "out_for_delivery", polarity: "positive" }),
    ]),
  }),
  delivery_completed_pod_pending: Object.freeze({
    summary: "I confirmed by phone that delivery was completed and signed proof of delivery is still missing.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "delivery_completed", polarity: "positive" }),
      Object.freeze({ predicate: "pod_received", polarity: "negative" }),
    ]),
  }),
  delivery_completed_with_pod: Object.freeze({
    summary: "I confirmed by phone that delivery was completed and signed proof of delivery was received.",
    assertions: Object.freeze([
      Object.freeze({ predicate: "delivery_completed", polarity: "positive" }),
      Object.freeze({ predicate: "pod_received", polarity: "positive" }),
    ]),
  }),
});

class TruthOperatorBrowserRuntimeError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthOperatorBrowserRuntimeError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason) {
  return new TruthOperatorBrowserRuntimeError(`Invalid browser operator truth ${field}: ${reason}`, {
    code: "TRUTH_OPERATOR_BROWSER_INVALID_ARGUMENT",
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, field) {
  if (!isPlainObject(value)) throw invalid(field, "must be an object");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw invalid(field, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function boundedText(value, field, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.trim() !== value || (!allowEmpty && !value)) {
    throw invalid(field, allowEmpty ? "must be a trimmed string" : "must be a non-empty trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw invalid(field, "is too long");
  return value;
}

function canonicalTimestamp(value, field) {
  const timestamp = boundedText(value, field, 64);
  if (!TIMESTAMP_RE.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp))
      || new Date(timestamp).toISOString() !== timestamp) {
    throw invalid(field, "must be canonical UTC with millisecond precision");
  }
  return timestamp;
}

function normalizeCommand(value) {
  exactKeys(value, ["schemaVersion", "command", "subject", "occurredAt", "contact", "reference"], "command");
  if (value.schemaVersion !== COMMAND_SCHEMA_VERSION) {
    throw invalid("command.schemaVersion", `must equal ${COMMAND_SCHEMA_VERSION}`);
  }
  const command = boundedText(value.command, "command.command", 100);
  const policy = COMMANDS[command];
  if (!policy) throw invalid("command.command", "is not a supported structured phone-truth command");
  exactKeys(value.subject, ["awb"], "command.subject");
  const awb = boundedText(value.subject.awb, "command.subject.awb", 11);
  if (!AWB_RE.test(awb)) throw invalid("command.subject.awb", "must be eleven digits");
  const occurredAt = canonicalTimestamp(value.occurredAt, "command.occurredAt");
  exactKeys(value.contact, ["name", "organization"], "command.contact");
  const contact = {
    name: boundedText(value.contact.name, "command.contact.name", 200),
    organization: boundedText(value.contact.organization, "command.contact.organization", 300),
  };
  exactKeys(value.reference, ["proof", "note"], "command.reference");
  const reference = {
    proof: boundedText(value.reference.proof, "command.reference.proof", 500, { allowEmpty: true }),
    note: boundedText(value.reference.note, "command.reference.note", 500, { allowEmpty: true }),
  };
  return Object.freeze({
    schemaVersion: COMMAND_SCHEMA_VERSION,
    command,
    subject: Object.freeze({ awb }),
    occurredAt,
    contact: Object.freeze(contact),
    reference: Object.freeze(reference),
    policy,
  });
}

function childIdempotencyKey(parentKey, assertion, index) {
  if (!IDEMPOTENCY_KEY_RE.test(String(parentKey || ""))) {
    throw invalid("idempotencyKey", "must be 32-128 base64url characters");
  }
  return crypto.createHash("sha256")
    .update([
      "operator-browser-child-v1",
      parentKey,
      String(index),
      assertion.predicate,
      assertion.polarity,
    ].join("\n"), "utf8")
    .digest("hex");
}

function summaryFor(command) {
  return [
    command.policy.summary,
    `Phone contact: ${command.contact.name} (${command.contact.organization}).`,
    command.reference.proof ? `Reference: ${command.reference.proof}.` : "",
    command.reference.note ? `Additional context: ${command.reference.note}.` : "",
  ].filter(Boolean).join(" ").slice(0, 2000);
}

function requestFor(command, assertion, recordedBy) {
  const predicate = PREDICATES[assertion.predicate];
  if (!predicate) throw invalid("command.command", "references an unregistered predicate");
  return {
    schemaVersion: "operator-truth-event-request-v1",
    eventType: "assertion",
    subject: { type: "shipment", awbs: [command.subject.awb] },
    contact: {
      name: command.contact.name,
      organization: command.contact.organization,
      channel: "phone",
    },
    recordedBy,
    occurredAt: command.occurredAt,
    recordedSummary: summaryFor(command),
    assertion: {
      contractVersion: REGISTRY.registryVersion,
      predicate: assertion.predicate,
      polarity: assertion.polarity,
      value: {
        status: predicate.statuses[assertion.polarity],
        effect: predicate.effects[assertion.polarity],
      },
    },
  };
}

function createTruthOperatorBrowserRuntime(options = {}) {
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const runtime = options.runtime;
  if (!runtime || typeof runtime.record !== "function") throw invalid("runtime", "must expose record");
  const recordedBy = {
    operatorId: boundedText(options.recordedBy?.operatorId, "recordedBy.operatorId", 200),
    name: boundedText(options.recordedBy?.name, "recordedBy.name", 200),
  };

  async function recordCommand(input = {}) {
    if (!isPlainObject(input)) throw invalid("recordCommand", "must be an object");
    exactKeys(input, ["idempotencyKey", "command"], "recordCommand");
    const parentKey = boundedText(input.idempotencyKey, "idempotencyKey", 128);
    if (!IDEMPOTENCY_KEY_RE.test(parentKey)) {
      throw invalid("idempotencyKey", "must be 32-128 base64url characters");
    }
    const command = normalizeCommand(input.command);
    const receipts = [];
    for (let index = 0; index < command.policy.assertions.length; index += 1) {
      const assertion = command.policy.assertions[index];
      const idempotencyKey = childIdempotencyKey(parentKey, assertion, index);
      const request = requestFor(command, assertion, recordedBy);
      try {
        receipts.push(await runtime.record({ idempotencyKey, request }));
      } catch (error) {
        throw new TruthOperatorBrowserRuntimeError(
          `Structured operator truth command stopped at assertion ${index + 1} of ${command.policy.assertions.length}: ${error?.message || String(error)}`,
          {
            code: "TRUTH_OPERATOR_BROWSER_PARTIAL_OR_FAILED",
            failedAssertionIndex: index,
            completedReceipts: receipts,
            retryable: error?.retryable === true,
            outcomeUnknown: error?.outcomeUnknown === true,
            safeToRetryWithSameIdempotencyKey: true,
            cause: error instanceof Error ? error : new Error(String(error)),
          },
        );
      }
    }
    return Object.freeze({
      ok: true,
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      status: "recorded",
      command: command.command,
      awb: command.subject.awb,
      assertionCount: command.policy.assertions.length,
      receipts: Object.freeze(receipts),
      mutatesOperationalState: false,
      reducesTruth: false,
      publishesTruth: false,
    });
  }

  return Object.freeze({ runtimeVersion: RUNTIME_VERSION, recordCommand });
}

module.exports = Object.freeze({
  COMMANDS,
  COMMAND_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  RUNTIME_VERSION,
  TruthOperatorBrowserRuntimeError,
  createTruthOperatorBrowserRuntime,
  normalizeCommand,
  _test: Object.freeze({ childIdempotencyKey, exactKeys, requestFor, summaryFor }),
});

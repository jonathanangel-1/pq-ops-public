"use strict";

// Source observations and accepted claims may enter canonical reduction.
// Materialized truth, diagnostics, UI/action projections, and prior reducer
// conclusions may not. Keep this predicate centralized: the July 9
// single-authority incident showed that partial call-site filters merely move
// packet self-feedback to the next unguarded reader.

const DERIVED_TYPE_PATTERN = /^(?:canonical-|terminal-evidence-certification|source-gap|truth-audit|state-sanity)/i;
const DERIVED_SOURCE_PATTERN = /\b(?:canonical-shipment-pipeline|shipment-state-sanity|shipment-state|active-shipment|truth-audit|truth-packet|shipment-truth-packets|ops-brain|ui-projection|action-planner)\b/i;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sourceCoordinates(row = {}) {
  return {
    threadId: clean(row.threadId || row.sourceRef?.threadId),
    messageId: clean(row.messageId || row.sourceRef?.messageId),
    attachmentId: clean(row.attachmentId || row.sourceRef?.attachmentId),
    observationId: clean(row.observationId || row.sourceRef?.observationId),
  };
}

function hasExternalSourceCoordinates(row = {}) {
  return Object.values(sourceCoordinates(row)).some(Boolean);
}

function derivedTruthFact(row = {}) {
  if (!row || typeof row !== "object") return false;
  const type = clean(row.type || row.factType || row.label);
  if (DERIVED_TYPE_PATTERN.test(type)) return true;

  const source = clean([
    row.source,
    row.sourceSystem,
    row.sourceType,
    row.sourceRef?.source,
    row.payload?.source,
  ].filter(Boolean).join(" "));

  // An external message/attachment pointer does not rescue a row explicitly
  // emitted by the canonical reducer: the pointer belongs to the underlying
  // source claim, which must be retained separately.
  if (/\bcanonical-shipment-pipeline\b/i.test(source)) return true;
  // A copied Gmail pointer does not turn a materialized shipment-state,
  // truth-audit, UI, action, or previous-packet projection back into source
  // evidence. The underlying Gmail claim must exist as its own source fact.
  if (DERIVED_SOURCE_PATTERN.test(source)) return true;

  return Boolean(
    row.canonicalAuthority ||
    row._truthPacketSource ||
    row.truthPacket ||
    row.packetId ||
    row.packetHash
  );
}

function sourceFactEligible(row = {}) {
  return Boolean(row && typeof row === "object" && !derivedTruthFact(row));
}

module.exports = {
  derivedTruthFact,
  hasExternalSourceCoordinates,
  sourceCoordinates,
  sourceFactEligible,
};

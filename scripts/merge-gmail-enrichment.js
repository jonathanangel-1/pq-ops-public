#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  assertLegacyGmailIngestionAllowed,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");
const UPDATE_PATH = path.join(ROOT_DIR, process.argv[2] || "gmail-enrichment-update.json");

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function keyFor(record) {
  return normalizeAwb(record.awb) || String(record.awb || "");
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, value) {
  await fs.writeFile(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function mergeByAwb(existing, incoming) {
  const map = new Map();
  for (const record of existing || []) {
    const key = keyFor(record);
    if (key) map.set(key, record);
  }
  for (const record of incoming || []) {
    const key = keyFor(record);
    if (key) map.set(key, mergeProofRecord(map.get(key), record));
  }
  return [...map.values()].sort((a, b) => String(a.awb).localeCompare(String(b.awb)));
}

function stableEvidenceKey(value) {
  if (!value || typeof value !== "object") return String(value || "");
  const attachmentIdentity = [
    value.attachmentId || "",
    value.filename || "",
    value.threadId || "",
    value.messageId || "",
    value.page || "",
  ].join(":");
  if (attachmentIdentity.replace(/:/g, "")) return `attachment:${attachmentIdentity}`;
  return [
    value.label || "",
    value.note || "",
    value.evidence || "",
    value.summary || "",
    value.threadId || "",
    value.messageId || "",
    value.attachmentId || "",
    value.filename || "",
    value.page || "",
  ].join(":");
}

function mergeEvidence(existing, incoming) {
  const map = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const key = stableEvidenceKey(item);
    if (key) map.set(key, item);
  }
  return [...map.values()];
}

function stableEventKey(value) {
  if (!value || typeof value !== "object") return String(value || "");
  if (value.id) return `id:${value.id}`;
  return [
    value.id || "",
    value.type || "",
    value.label || "",
    value.summary || "",
    value.evidence || "",
    value.threadId || "",
    value.messageId || "",
    value.at || "",
  ].join(":");
}

function mergeEvents(existing, incoming) {
  const map = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const key = stableEventKey(item);
    if (key.replace(/:/g, "")) map.set(key, item);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
}

function latestTimestamp(...values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b || "") - Date.parse(a || ""))
    .at(0) || "";
}

function mergeProofRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingEmailValidation = existing.emailValidation || {};
  const incomingEmailValidation = incoming.emailValidation || {};
  return {
    ...existing,
    ...incoming,
    sources: [...new Set([...(existing.sources || []), ...(incoming.sources || [])])],
    timeline: mergeEvidence(existing.timeline, incoming.timeline),
    proof: mergeEvidence(existing.proof, incoming.proof),
    events: mergeEvents(existing.events, incoming.events),
    historicalProof: mergeEvidence(existing.historicalProof, incoming.historicalProof),
    historicalEvents: mergeEvents(existing.historicalEvents, incoming.historicalEvents),
    latestEventAt: latestTimestamp(incoming.latestEventAt, existing.latestEventAt),
    emailValidation: {
      ...existingEmailValidation,
      ...incomingEmailValidation,
      summary: incomingEmailValidation.summary || existingEmailValidation.summary || "",
      nextAction: incomingEmailValidation.nextAction || existingEmailValidation.nextAction || "",
      proof: mergeEvidence(existingEmailValidation.proof, incomingEmailValidation.proof),
      events: mergeEvents(existingEmailValidation.events, incomingEmailValidation.events),
    },
  };
}

function quoteKey(quote) {
  return [
    String(quote?.broker || "").toLowerCase(),
    String(quote?.contactEmail || "").toLowerCase(),
    quote?.amount ?? "",
    String(quote?.currency || "").toUpperCase(),
    String(quote?.rate || "").toLowerCase(),
    String(quote?.service || "").toLowerCase(),
  ].join("|");
}

function mergeQuotes(existing, incoming) {
  const map = new Map();
  for (const quote of [...(existing || []), ...(incoming || [])]) {
    const key = quoteKey(quote);
    if (key.replace(/\|/g, "")) map.set(key, quote);
  }
  return [...map.values()];
}

function mergeDispatchRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return {
    ...existing,
    ...incoming,
    evidence: mergeEvidence(existing.evidence, incoming.evidence),
    quotes: mergeQuotes(existing.quotes, incoming.quotes),
  };
}

function customsStatusRank(status) {
  const value = String(status || "").toLowerCase();
  if (
    [
      "released",
      "cleared",
      "customs-cleared",
      "customs-cleared-do-received",
      "customs-release-attachment-received",
      "customs-released",
      "customs-released-do-received",
      "release-do-received",
      "released-do-received",
    ].includes(value)
  ) return 3;
  if (/hold|exam|intensive/.test(value)) return 2;
  if (/pending|not[- ]?cleared|unknown/.test(value)) return 1;
  return 0;
}

function firstUseful(...values) {
  return values.find((value) => value && value !== "Not found") || "";
}

function mergeCustomsBrokerRecord(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const incomingRank = customsStatusRank(incoming.status);
  const existingRank = customsStatusRank(existing.status);
  const preferIncomingStatus = incomingRank >= existingRank && incomingRank > 0;
  return {
    ...existing,
    ...incoming,
    status: preferIncomingStatus ? incoming.status : existing.status,
    broker: firstUseful(incoming.broker, incoming.brokerName, existing.broker, existing.brokerName) || "Not found",
    contactName: firstUseful(incoming.contactName, existing.contactName) || "Not found",
    contactEmail: firstUseful(incoming.contactEmail, incoming.email, existing.contactEmail, existing.email) || "Not found",
    contactPhone: firstUseful(incoming.contactPhone, incoming.phone, existing.contactPhone, existing.phone) || "Not found",
    confidence: incomingRank > existingRank ? incoming.confidence || existing.confidence : existing.confidence || incoming.confidence,
    evidence: mergeEvidence(existing.evidence, incoming.evidence),
    releaseProof: firstUseful(incoming.releaseProof, existing.releaseProof) || "Not found",
    nextAction: preferIncomingStatus ? incoming.nextAction || existing.nextAction : existing.nextAction || incoming.nextAction,
  };
}

function mergeCustomsBrokersByAwb(existing, incoming) {
  const map = new Map();
  for (const record of existing || []) {
    const key = keyFor(record);
    if (key) map.set(key, record);
  }
  for (const record of incoming || []) {
    const key = keyFor(record);
    if (key) map.set(key, mergeCustomsBrokerRecord(map.get(key), record));
  }
  return [...map.values()].sort((a, b) => String(a.awb).localeCompare(String(b.awb)));
}

function mergeDispatchesByAwb(existing, incoming) {
  const map = new Map();
  for (const record of existing || []) {
    const key = keyFor(record);
    if (key) map.set(key, record);
  }
  for (const record of incoming || []) {
    const key = keyFor(record);
    if (key) map.set(key, mergeDispatchRecord(map.get(key), record));
  }
  return [...map.values()].sort((a, b) => String(a.awb).localeCompare(String(b.awb)));
}

function isCustomsReleaseAttachment(record) {
  const filename = String(record?.filename || record?.attachment || "").toLowerCase();
  if (!filename) return false;
  return /\b(?:ace|release|released|delivery\s*order)\b|\d{3}-?\d{8}\s*ace|(?:^|[\s_-])d[\/.\s-]?o(?:[\s_.-]|$)/i.test(filename);
}

function attachmentAuditToCustomsBroker(record) {
  return {
    awb: record.awb,
    status: "customs-release-attachment-received",
    broker: "Not found",
    confidence: "medium",
    contactName: "Not found",
    contactEmail: "Not found",
    contactPhone: "Not found",
    releaseProof: `${record.filename} was attached in the Gmail thread.`,
    evidence: [
      {
        label: "Customs attachment",
        note: `${record.filename} was attached but not parsed by Gmail; treat it as customs release/DO evidence and keep arrival/pickup separate.`,
        threadId: record.threadId || "",
        messageId: record.messageId || "",
        filename: record.filename || "",
        mimeType: record.mimeType || "",
      },
    ],
    nextAction: "Customs release document is attached; confirm station availability, then follow pickup and POD.",
  };
}

function attachmentAuditToFact(record) {
  return {
    awb: record.awb,
    section: "customs-release",
    summary: `${record.filename} attached; Gmail could not parse the file text in this refresh.`,
    threadId: record.threadId || "",
    messageId: record.messageId || "",
    evidence: [
      {
        label: "Attachment",
        filename: record.filename || "",
        mimeType: record.mimeType || "",
        note: record.reason || "",
      },
    ],
  };
}

function normalizeProof(record) {
  if (!record || typeof record !== "object") return record;
  if (!record.status && !record.summary && !record.nextAction && !record.proof && !record.threads) return record;

  const proof = Array.isArray(record.proof)
    ? record.proof
    : Array.isArray(record.threads)
      ? record.threads.map((thread) => ({
          label: thread.subject || thread.threadId || "Gmail thread",
          note: thread.evidence || thread.summary || "",
          threadId: thread.threadId || "",
          messageId: thread.messageId || "",
          attachmentId: thread.attachmentId || "",
          filename: thread.filename || "",
          mimeType: thread.mimeType || "",
          page: thread.page || "",
        }))
      : [];
  const attachmentEvidence = Array.isArray(record.attachmentEvidence)
    ? record.attachmentEvidence
    : [];
  const existingEmailProof = Array.isArray(record.emailValidation?.proof)
    ? record.emailValidation.proof
    : [];
  const normalizedEvents = mergeEvents(record.events, record.emailValidation?.events);

  const normalized = {
    ...record,
    awb: record.awb,
    sources: record.sources || ["Gmail"],
    timeline: record.timeline || [],
    events: normalizedEvents,
    emailValidation: {
      ...(record.emailValidation || {}),
      status: record.emailValidation?.status || record.status || "email-confirmed",
      summary: record.emailValidation?.summary || record.summary || "",
      nextAction: record.emailValidation?.nextAction || record.nextAction || "",
      proof: mergeEvidence(mergeEvidence(existingEmailProof, proof), attachmentEvidence),
      events: normalizedEvents,
    },
  };

  if (record.gmailSearchAudit) normalized.gmailSearchAudit = record.gmailSearchAudit;
  if (record.gmailAttachmentAudit) normalized.gmailAttachmentAudit = record.gmailAttachmentAudit;
  if (record.confidence) normalized.confidence = record.confidence;
  if (record.latestEventAt) normalized.latestEventAt = record.latestEventAt;
  return normalized;
}

function mergeFacts(existing, incoming) {
  const map = new Map();
  for (const record of existing || []) {
    map.set(`${keyFor(record)}:${record.section || ""}:${record.summary || ""}`, record);
  }
  for (const record of incoming || []) {
    map.set(`${keyFor(record)}:${record.section || ""}:${record.summary || ""}`, record);
  }
  return [...map.values()].sort((a, b) => String(a.awb).localeCompare(String(b.awb)));
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/merge-gmail-enrichment.js");
  const update = JSON.parse(await fs.readFile(UPDATE_PATH, "utf8"));
  const now = new Date().toISOString();
  const customsAttachmentAudit = (update.audit?.attachmentAudit || []).filter(isCustomsReleaseAttachment);
  const attachmentCustomsBrokers = customsAttachmentAudit.map(attachmentAuditToCustomsBroker);
  const attachmentFacts = customsAttachmentAudit.map(attachmentAuditToFact);

  const gmailProof = await readJson("gmail-proof-snapshot.json", { proofs: [] });
  const brokerDispatch = await readJson("broker-dispatch-snapshot.json", { dispatches: [] });
  const customsBroker = await readJson("customs-broker-snapshot.json", { brokers: [] });
  const eodFacts = await readJson("eod-report-facts.json", { facts: [] });

  const nextGmailProof = {
    ...gmailProof,
    snapshotTime: now,
    source: update.source || "PQ Gmail agent processor",
    proofs: mergeByAwb(gmailProof.proofs || [], (update.proofs || []).map(normalizeProof)),
  };
  const nextBrokerDispatch = {
    ...brokerDispatch,
    snapshotTime: now,
    source: update.source || "PQ Gmail agent processor",
    dispatches: mergeDispatchesByAwb(brokerDispatch.dispatches || [], update.dispatches || []),
  };
  const nextCustomsBroker = {
    ...customsBroker,
    snapshotTime: now,
    source: update.source || "PQ Gmail agent processor",
    brokers: mergeCustomsBrokersByAwb(customsBroker.brokers || [], [
      ...(update.brokers || []),
      ...attachmentCustomsBrokers,
    ]),
  };
  const nextEodFacts = {
    ...eodFacts,
    snapshotTime: now,
    source: update.source || "PQ Gmail agent processor",
    facts: mergeFacts(eodFacts.facts || [], [
      ...(update.facts || []),
      ...attachmentFacts,
    ]),
  };

  await Promise.all([
    writeJson("gmail-proof-snapshot.json", nextGmailProof),
    writeJson("broker-dispatch-snapshot.json", nextBrokerDispatch),
    writeJson("customs-broker-snapshot.json", nextCustomsBroker),
    writeJson("eod-report-facts.json", nextEodFacts),
  ]);

  console.log(JSON.stringify({
    ok: true,
    jobId: update.jobId || null,
    proofs: update.proofs?.length || 0,
    dispatches: update.dispatches?.length || 0,
    brokers: update.brokers?.length || 0,
    facts: update.facts?.length || 0,
    customsAttachmentEvidence: attachmentCustomsBrokers.length,
    mergedAt: now,
  }, null, 2));
}

module.exports = {
  mergeDispatchRecord,
  mergeDispatchesByAwb,
  mergeEvidence,
  mergeEvents,
  mergeProofRecord,
  mergeQuotes,
  mergeCustomsBrokerRecord,
  mergeCustomsBrokersByAwb,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

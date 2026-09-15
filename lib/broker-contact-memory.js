"use strict";

const {
  emptyCompanionMemory,
  makeOperatorNote,
  normalizeAwb,
  upsertOperatorNote,
} = require("./companion-memory-store");

function contactEmailList(value) {
  return [...new Set(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])]
    .map((email) => email.toLowerCase());
}

function compact(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function cleanBrokerName(value) {
  return String(value || "")
    .replace(/[<>"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function brokerContactNoteText(entry) {
  const awb = entry.awb || entry.shipmentAwb || "";
  const brokerName = cleanBrokerName(entry.brokerName || entry.targetName || "pickup broker");
  const email = contactEmailList(entry.brokerEmail || entry.contactEmail || entry.email)[0] || "";
  const source = compact(entry.source || "Operator saved from release-contact form", 180);
  const note = compact(entry.note || "", 240);
  return [
    `Saved pickup broker release contact for AWB ${awb}: ${brokerName} <${email}>.`,
    `Source: ${source}.`,
    note,
  ].filter(Boolean).join(" ");
}

function brokerContactEntryToNote(entry, now = new Date().toISOString()) {
  const awb = normalizeAwb(entry.awb || entry.shipmentAwb || "");
  if (!awb) {
    const error = new Error("Broker contact memory requires AWB");
    error.statusCode = 400;
    throw error;
  }
  const email = contactEmailList(entry.brokerEmail || entry.contactEmail || entry.email)[0] || "";
  if (!email) {
    const error = new Error("Broker contact memory requires a broker email");
    error.statusCode = 400;
    throw error;
  }
  const brokerName = cleanBrokerName(entry.brokerName || entry.targetName || "pickup broker");
  const text = brokerContactNoteText({ ...entry, awb: entry.awb || awb, brokerName, brokerEmail: email });
  const note = makeOperatorNote({ text, awb, at: now, purpose: "operator-update" });
  const contactFact = {
    type: "contact",
    label: "Pickup broker contact",
    summary: text,
    at: now,
    source: "operator-note",
    confidence: "operator-confirmed",
    operatorNoteId: note.id,
    purpose: "operator-update",
    role: "pickup-broker",
    contactName: brokerName,
    contactEmail: email,
  };
  const facts = [
    contactFact,
    ...(note.facts || []).filter((fact) =>
      !(
        fact?.type === contactFact.type &&
        fact?.contactEmail === contactFact.contactEmail &&
        fact?.role === contactFact.role
      )
    ),
  ];
  return {
    ...note,
    source: "broker-contact-memory",
    contactRole: "pickup-broker",
    brokerName,
    contactEmail: email,
    facts,
  };
}

function upsertBrokerContactMemory(snapshot, entry, now = new Date().toISOString()) {
  const note = brokerContactEntryToNote(entry, now);
  const next = upsertOperatorNote(snapshot || emptyCompanionMemory(now), note, now);
  return {
    ...next,
    savedNote: note,
    savedCount: (next.operatorNotes || []).length,
  };
}

function brokerContactCandidateFromNote(note) {
  if (!note) return null;
  const text = [
    note.text,
    note.summary,
    note.brokerName,
    note.contactEmail,
    ...(note.facts || []).map((fact) => [
      fact.label,
      fact.summary,
      fact.role,
      fact.contactName,
      fact.contactEmail,
    ].filter(Boolean).join(" ")),
  ].filter(Boolean).join(" ");
  const email = contactEmailList([
    note.contactEmail,
    ...((note.facts || []).map((fact) => fact.contactEmail || fact.email || "")),
    text,
  ].join(" "))[0] || "";
  if (!email) return null;
  const roleText = String(text || "").toLowerCase();
  const pickupContext = /\b(?:pickup|release packet|release contact|freight|delivery order|d\/?o|broker release|broker contact)\b/i.test(roleText);
  const customsOnly = /\bcustoms broker\b/i.test(roleText) && !/\b(?:pickup|freight|release packet|delivery order|d\/?o)\b/i.test(roleText);
  if (!pickupContext || customsOnly) return null;
  const contactFact = (note.facts || []).find((fact) => fact?.contactEmail || fact?.contactName) || {};
  return {
    awb: normalizeAwb(note.awb || ""),
    brokerName: cleanBrokerName(note.brokerName || contactFact.contactName || "pickup broker"),
    email,
    source: note.source || contactFact.source || "operator-note",
    summary: compact(text, 260),
    at: note.updatedAt || note.createdAt || contactFact.at || "",
    noteId: note.id || contactFact.operatorNoteId || "",
  };
}

function brokerContactCandidatesForAwb(companionMemory, awb) {
  const key = normalizeAwb(awb);
  if (!key) return [];
  return (companionMemory?.operatorNotes || [])
    .filter((note) => normalizeAwb(note?.awb || "") === key)
    .map(brokerContactCandidateFromNote)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.at || "") - Date.parse(left.at || ""));
}

module.exports = {
  brokerContactCandidateFromNote,
  brokerContactCandidatesForAwb,
  brokerContactEntryToNote,
  brokerContactNoteText,
  contactEmailList,
  upsertBrokerContactMemory,
};

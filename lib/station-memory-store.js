"use strict";

function clean(value) {
  return String(value || "").trim();
}

function normalizedEmail(value) {
  return clean(value).toLowerCase();
}

function stationMemoryId(entry) {
  return [
    clean(entry.airport).toUpperCase(),
    clean(entry.airline),
    clean(entry.handlerName || "Station"),
  ]
    .filter(Boolean)
    .join("|");
}

function aliasList(entry) {
  return [
    ...(Array.isArray(entry.aliases) ? entry.aliases : []),
    entry.airport,
    entry.airline,
    entry.handlerName,
    entry.stationEmail,
    [entry.airport, entry.airline].filter(Boolean).join(" "),
  ]
    .map(clean)
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function normalizeStationMemoryEntry(input, now = new Date().toISOString()) {
  const storage = input?.storage || {};
  const entry = {
    id: clean(input?.id),
    airport: clean(input?.airport).toUpperCase(),
    airline: clean(input?.airline),
    handlerName: clean(input?.handlerName || input?.handler || input?.stationName || "Station"),
    stationEmail: clean(input?.stationEmail || input?.email),
    stationPhone: clean(input?.stationPhone || input?.phone),
    aliases: [],
    confidence: clean(input?.confidence || "medium"),
    source: clean(input?.source || "Operator saved from PQ dashboard"),
    sourceUrl: clean(input?.sourceUrl),
    supportUrl: clean(input?.supportUrl),
    firstSeenAt: clean(input?.firstSeenAt || now),
    updatedAt: now,
  };

  const storageFields = {
    status: clean(storage.status),
    freeStorage: clean(storage.freeStorage),
    freeStorageHours: clean(storage.freeStorageHours),
    lastFreeDayRule: clean(storage.lastFreeDayRule),
    dailyStorageRate: clean(storage.dailyStorageRate),
    source: clean(storage.source || entry.source),
  };
  if (Object.values(storageFields).some(Boolean)) {
    entry.storage = {
      ...storageFields,
      status: storageFields.status || "known",
    };
  }

  entry.id = entry.id || stationMemoryId(entry);
  entry.aliases = aliasList(entry);
  return entry;
}

function validateStationMemoryEntry(entry) {
  if (!entry.airport) return "Airport is required";
  if (!entry.airline && !entry.handlerName) return "Airline or station handler is required";
  if (!entry.stationEmail && !entry.stationPhone) return "Station email or phone is required";
  return "";
}

function sameStation(left, right) {
  if (left.id && right.id && left.id === right.id) return true;
  const airportMatch = clean(left.airport).toUpperCase() === clean(right.airport).toUpperCase();
  if (!airportMatch) return false;
  const airlineMatch = clean(left.airline).toLowerCase() === clean(right.airline).toLowerCase();
  const handlerMatch = clean(left.handlerName).toLowerCase() === clean(right.handlerName).toLowerCase();
  const emailMatch = normalizedEmail(left.stationEmail) && normalizedEmail(left.stationEmail) === normalizedEmail(right.stationEmail);
  return airlineMatch && (handlerMatch || emailMatch);
}

function upsertStationMemory(memory, rawEntry, now = new Date().toISOString()) {
  const entry = normalizeStationMemoryEntry(rawEntry, now);
  const validationError = validateStationMemoryEntry(entry);
  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 422;
    throw error;
  }

  const contacts = Array.isArray(memory?.contacts) ? memory.contacts : [];
  let replaced = false;
  const nextContacts = contacts.map((contact) => {
    if (!sameStation(contact, entry)) return contact;
    replaced = true;
    return {
      ...contact,
      ...entry,
      firstSeenAt: contact.firstSeenAt || entry.firstSeenAt,
      aliases: aliasList({ ...contact, ...entry }),
      storage: entry.storage || contact.storage,
    };
  });
  if (!replaced) nextContacts.push(entry);

  return {
    ...(memory || {}),
    snapshotTime: now,
    source: memory?.source || "operator-station-memory",
    contacts: nextContacts.sort((a, b) =>
      String(a.airport).localeCompare(String(b.airport)) ||
      String(a.airline).localeCompare(String(b.airline)) ||
      String(a.handlerName).localeCompare(String(b.handlerName))
    ),
    savedEntry: entry,
    savedCount: nextContacts.length,
  };
}

module.exports = {
  normalizeStationMemoryEntry,
  stationMemoryId,
  upsertStationMemory,
  validateStationMemoryEntry,
};

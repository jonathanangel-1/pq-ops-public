"use strict";

// Station/airport metadata CONTRACT (Part E placeholder — not the database).
//
// Severity and planning rules consume this shape today (passing null/partial
// is fine); the real per-station database fills it in later. Every field is
// optional; consumers must treat absence as "unknown", never as "safe".

function stationMetadataContract() {
  return {
    airportCode: null,        // "ELP"
    station: null,            // handler name, e.g. "Forward Air ELP"
    airline: null,            // "LY", "UA"
    importFacility: null,     // physical facility identifier/address
    freeStorageHours: null,   // e.g. 48
    freeStorageEndsAt: null,  // ISO — when free storage ends for a shipment
    lfdRule: null,            // "storage begins 2 calendar days after arrival"
    storageRatePerDay: null,  // e.g. 40 (USD)
    brokerRoster: [],         // [{ name, email, phone, active, preferenceRank, confidence }]
    stationContacts: [],      // [{ name, email, phone, role }]
    source: null,             // where this metadata came from
    confidence: null,         // high | medium | low
    lastVerifiedAt: null,     // ISO
  };
}

// Normalize whatever partial metadata a caller has into the contract shape.
function normalizeStationMetadata(partial = {}) {
  return { ...stationMetadataContract(), ...(partial && typeof partial === "object" ? partial : {}) };
}

module.exports = {
  stationMetadataContract,
  normalizeStationMetadata,
};

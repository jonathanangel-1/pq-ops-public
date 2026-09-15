"use strict";

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function moneyValue(value) {
  const text = clean(value);
  if (!text) return "";
  const numeric = text.match(/-?\$?\s*[\d,]+(?:\.\d{1,2})?/);
  return numeric ? numeric[0].replace(/\s+/g, "") : text;
}

function compactAuditValue(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return null;
  if (Array.isArray(value)) {
    return value
      .slice(0, 40)
      .map((item) => compactAuditValue(item, depth + 1))
      .filter((item) => item !== null && item !== "");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).slice(0, 30);
    const result = {};
    for (const [key, item] of entries) {
      const compact = compactAuditValue(item, depth + 1);
      if (compact !== null && compact !== "") result[clean(key).slice(0, 80)] = compact;
    }
    return Object.keys(result).length ? result : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = clean(value);
  return text.length > 300 ? `${text.slice(0, 297).trim()}...` : text;
}

function moneyMemoryRecord(input = {}, now = new Date().toISOString()) {
  const awb = clean(input.awb || input.shipmentAwb || "");
  const normalizedAwb = normalizeAwb(awb);
  if (!normalizedAwb) {
    const error = new Error("Money memory requires AWB");
    error.statusCode = 400;
    throw error;
  }

  const record = {
    awb,
    normalizedAwb,
    customerCharge: moneyValue(input.customerCharge),
    vendorCost: moneyValue(input.vendorCost),
    freightQuoteOrAward: moneyValue(input.freightQuoteOrAward),
    source: clean(input.source) || "Operator saved from PQ dashboard",
    confidence: clean(input.confidence) || "medium",
    status: clean(input.status),
    order: clean(input.order),
    missingFields: Array.isArray(input.missingFields) ? input.missingFields.map(clean).filter(Boolean) : [],
    checkedAt: clean(input.checkedAt),
    extractionError: clean(input.extractionError),
    extractionAudit: compactAuditValue(input.extractionAudit),
    note: clean(input.note),
    updatedAt: now,
  };

  if (!record.customerCharge && !record.vendorCost && !record.freightQuoteOrAward && !record.note) {
    const error = new Error("Money memory requires at least one value or note");
    error.statusCode = 400;
    throw error;
  }

  return record;
}

function upsertMoneyMemory(memory = {}, input = {}, now = new Date().toISOString()) {
  const record = moneyMemoryRecord(input, now);
  const currentRecords = Array.isArray(memory.records) ? memory.records : [];
  const nextRecords = [
    record,
    ...currentRecords.filter((item) => normalizeAwb(item.normalizedAwb || item.awb) !== record.normalizedAwb),
  ].slice(0, 500);

  return {
    snapshotTime: now,
    source: memory.source || "operator-money-memory",
    records: nextRecords,
    savedRecord: record,
    savedCount: nextRecords.length,
  };
}

function moneyMemoryByAwb(memory = {}) {
  const byAwb = new Map();
  for (const record of memory.records || []) {
    const key = normalizeAwb(record.normalizedAwb || record.awb);
    if (key) byAwb.set(key, record);
  }
  return byAwb;
}

module.exports = {
  moneyMemoryByAwb,
  moneyMemoryRecord,
  upsertMoneyMemory,
};

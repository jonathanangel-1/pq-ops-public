"use strict";

function normalizeAwb(value) {
  const text = String(value || "");
  const formatted = text.match(/(?:^|\D)(\d{3})[-\s]?(\d{8})(?!\d)/);
  if (formatted) return `${formatted[1]}${formatted[2]}`;
  const digits = text.replace(/\D/g, "");
  if (digits.length === 11) return digits;
  const embedded = text.match(/(?:^|\D)((?:014|016|114|238|700|932)\d{8})(?!\d)/);
  return embedded ? embedded[1] : "";
}

function normalizeAwbFrom(...values) {
  for (const value of values) {
    const awb = normalizeAwb(value);
    if (awb) return awb;
  }
  return "";
}

function formatAwb(value) {
  const awb = normalizeAwb(value);
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb;
}

module.exports = {
  formatAwb,
  normalizeAwb,
  normalizeAwbFrom,
};

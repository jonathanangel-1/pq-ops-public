"use strict";

const crypto = require("node:crypto");

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedOutput(value, normalizationRoots = []) {
  let normalized = String(value || "");
  for (const [index, root] of [...new Set(normalizationRoots)]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .entries()) {
    normalized = normalized.replaceAll(root, `<QUALITY_ROOT_${index}>`);
  }
  return normalized
    .replace(
      /\b(?:duration_ms|durationMs|elapsedMs)["':=\s]+[\d.]+/g,
      "duration=<N>",
    )
    .replace(/\b\d+(?:\.\d+)?\s*ms\b/g, "<MS>")
    .trim();
}

function semanticReceipt(receipt) {
  return {
    name: receipt.name,
    checkId: receipt.checkId,
    command: receipt.command,
    definitionSha256: receipt.definitionSha256,
    isolation: receipt.isolation,
    status: receipt.status,
    signal: receipt.signal,
    parsed: receipt.parsed,
    stdout: normalizedOutput(receipt.stdout, receipt.normalizationRoots),
    stderr: normalizedOutput(receipt.stderr, receipt.normalizationRoots),
  };
}

function semanticReceiptSha256(receipt) {
  return sha256(stableJson(semanticReceipt(receipt)));
}

module.exports = {
  normalizedOutput,
  semanticReceipt,
  semanticReceiptSha256,
  sha256,
  stableJson,
};

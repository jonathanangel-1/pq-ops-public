"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function normalizeText(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeBase64UrlBuffer(value) {
  if (!value) return Buffer.alloc(0);
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function decodePdfLiteralString(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\(\d{1,3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

function extractSimplePdfText(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString("latin1") : String(buffer || "");
  const strings = [];
  const pattern = /\((?:\\.|[^\\)])*\)\s*(?:Tj|'|"|TJ)?/g;
  for (const match of raw.matchAll(pattern)) {
    const value = match[0].match(/^\(([\s\S]*?)\)/)?.[1] || "";
    const decoded = decodePdfLiteralString(value);
    if (/[A-Za-z0-9]/.test(decoded)) strings.push(decoded);
  }
  return normalizeText(strings.join(" "));
}

async function extractWithPdftotext(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pq-pdf-"));
  const input = path.join(dir, "attachment.pdf");
  try {
    await fs.writeFile(input, buffer);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", input, "-"], {
      timeout: 10000,
      maxBuffer: 1024 * 1024 * 4,
    });
    return normalizeText(stdout);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractPdfTextFromBuffer(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!bytes.length) return "";
  try {
    const pdftotext = await extractWithPdftotext(bytes);
    if (pdftotext) return pdftotext;
  } catch {
    // Local/serverless environments may not have Poppler. Keep a no-dependency
    // fallback for simple text PDFs and tests.
  }
  return extractSimplePdfText(bytes);
}

function findAwb(text) {
  const value = String(text || "");
  const dashed = value.match(/\b\d{3}[-\s]?\d{7,8}\b/);
  if (!dashed) return "";
  const digits = dashed[0].replace(/\D/g, "");
  return digits.length >= 10 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : dashed[0];
}

function findDateAfter(text, labelPattern) {
  const value = String(text || "");
  const pattern = new RegExp(`${labelPattern.source}\\s*(?:is|:|#)?\\s*([A-Z][a-z]{2,8}\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`, "i");
  return value.match(pattern)?.[1] || "";
}

function hasOperationalPdfSignal(text) {
  const value = String(text || "");
  return Boolean(findAwb(value)) ||
    /\b(?:awb|mawb|house\s+bill|hwb|arrival notice|notice of arrival|\bnoa\b|proof of delivery|\bpod\b|cargo release|customs release|delivery order|d\/?o\b|last free|lfd|storage|demurrage|on[-\s]?hand|available for pickup|picked up|recovered|driver loaded|ground handling|station fee|cargosprint|total due|payment receipt)\b/i.test(value);
}

function isLikelySignaturePdf({ filename = "", text = "" } = {}) {
  const file = String(filename || "");
  const value = normalizeText(text);
  const combined = normalizeText(`${file} ${value}`);
  if (!combined) return false;
  if (hasOperationalPdfSignal(combined)) return false;

  const signatureName = /\b(?:signature|sig|image\d*|logo|footer|disclaimer|privacy|terms|confidentiality|unsubscribe|linkedin|facebook|instagram|twitter|x-logo)\b/i.test(file);
  const boilerplate = /\b(?:confidentiality notice|confidential communication|intended recipient|privileged information|please consider the environment|unsubscribe|privacy policy|terms of use|sent from my|this email and any attachments|virus-free|linkedin|facebook|instagram)\b/i.test(value);
  const contactOnly = /\b(?:tel|phone|mobile|fax|email|www\.|https?:\/\/|linkedin)\b/i.test(value) &&
    !/\b(?:arrived|released|cleared|delivered|picked up|pickup|storage|customs|cargo|station)\b/i.test(value);
  return signatureName || boilerplate || contactOnly;
}

function isUnreadableExtractionText(text = "") {
  const value = normalizeText(text);
  if (value.length < 80) return false;
  if (/[\u0590-\u05ff]/.test(value)) return false;
  const controlCount = (value.match(/[\u0000-\u0008\u000b-\u001f\u007f]/g) || []).length;
  const binaryLatin1Count = (value.match(/[ÿþ�Â]/g) || []).length;
  const extendedLatin1Count = (value.match(/[\u0080-\u00ff]/g) || []).length;
  const asciiOperationalWords = (value.match(/\b[A-Za-z]{3,}\b/g) || []).length;
  const printableAsciiCount = (value.match(/[A-Za-z0-9 .,;:()[\]/+&@#%$'"_-]/g) || []).length;
  const noisyRatio = (controlCount + binaryLatin1Count) / Math.max(value.length, 1);
  const extendedLatin1Ratio = extendedLatin1Count / Math.max(value.length, 1);
  const printableRatio = printableAsciiCount / Math.max(value.length, 1);
  return (noisyRatio > 0.08 && asciiOperationalWords < 12) ||
    (value.length >= 160 && printableRatio < 0.65 && asciiOperationalWords < 12) ||
    // Failed PDF decoding often yields dense C1/Latin-1 bytes plus enough random
    // ASCII fragments to look like words. Those fragments can include `1H`,
    // `1C`, release, hold, or POD tokens and must never mint shipment truth.
    (value.length >= 160 && extendedLatin1Ratio > 0.08 && printableRatio < 0.84) ||
    (value.length >= 160 && extendedLatin1Ratio > 0.18);
}

function filenameHasExplicitOperationalMeaning(filename = "") {
  return /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery|arrival notice|notice of arrival|\bnoa\b|release|delivery order|d\/?o\b|cargosprint|payment receipt|customs hold|exam hold)\b/i.test(String(filename || ""));
}

function classifyPdfOperationalEvidence({ filename = "", text = "" } = {}) {
  const fileText = normalizeText(filename);
  const bodyText = normalizeText(text);
  const value = normalizeText(`${fileText} ${bodyText}`);
  if (!value) {
    return {
      kind: "context",
      label: "PDF attachment",
      status: "pdf-unread",
      note: "PDF attachment could not be read.",
      signals: {},
    };
  }

  if (isUnreadableExtractionText(bodyText) && !filenameHasExplicitOperationalMeaning(fileText)) {
    return {
      kind: "context",
      label: "Unreadable PDF attachment",
      status: "pdf-unreadable",
      note: "PDF text extraction was unreadable/binary; do not infer customs, release, arrival, pickup, delivery, or POD state from this attachment without OCR/manual review.",
      awb: findAwb(value),
      signals: {},
      fields: {},
      textPreview: bodyText.slice(0, 1000),
    };
  }

  if (isLikelySignaturePdf({ filename, text })) {
    return {
      kind: "trash",
      label: "Ignored signature PDF",
      status: "pdf-trash",
      note: "Ignored signature/legal/contact boilerplate PDF; no operational shipment signal found.",
      awb: "",
      signals: {},
      fields: {},
      textPreview: normalizeText(text).slice(0, 1000),
    };
  }

  const preAlertOrClearancePacket = /\b(?:pre[-\s]?alert|shipment details?|commercial invoice|packing list|full set of documents|clearance instructions|contact consignee|delivery order|d\/?o\b|deliver to|ship to|consignee|cnee)\b/i.test(value);
  const hasReadableBody = bodyText.length >= 40;
  const negatedRelease = /\b(?:not released|not cleared|release pending|clearance pending|customs hold|\b1[-\s]?h\b|exam hold|hold not removed|cannot release|do not dispatch)\b/i.test(value);
  const release = !negatedRelease && /\b(?:98\s*released|cargo release|customs release|released by customs|delivery order|d\/?o\b|entry released|1c entered)\b/i.test(value);
  const explicitPodFile = /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery[-\s]?receipt)\b/i.test(fileText);
  const explicitPodBody = /\b(?:pod|proof of delivery|signed delivery receipt|receiver signature)\b/i.test(bodyText) ||
    /\b(?:delivery completed|delivered successfully)\b/i.test(bodyText) ||
    /\b(?:signed by|received by)\s+[A-Za-z][A-Za-z .'-]{1,40}\b/i.test(bodyText);
  const instructionOnlyPacket = preAlertOrClearancePacket && !explicitPodFile && !explicitPodBody;
  const pod = (explicitPodFile || explicitPodBody) &&
    !instructionOnlyPacket &&
    (hasReadableBody || explicitPodFile || /\b(?:signed|receiver|received by|signed by|proof of delivery|pod)\b/i.test(bodyText));
  const arrival = /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available for pickup|available cargo|arrived|freight availability)\b/i.test(value);
  const pickup = /\b(?:picked up|recovered|pickup completed|driver loaded|loaded out)\b/i.test(value);
  const payment = /\b(?:cargosprint|ground handling|terminal fee|station fee|total due|payment receipt|paid)\b/i.test(value);
  const storage = /\b(?:storage|last free|lfd|demurrage|go begins)\b/i.test(value);

  const awb = findAwb(value);
  const lfd = findDateAfter(value, /(?:last free day|last free|lfd)/i);
  const arrivedAt = findDateAfter(value, /(?:arrival date|arrived|available|on[-\s]?hand)/i);
  const signedBy = value.match(/\b(?:signed by|received by)\s+([A-Za-z][A-Za-z .'-]{1,40})/i)?.[1] || "";

  let kind = "context";
  if (pod) kind = "pod";
  else if (negatedRelease) kind = "customs-hold";
  else if (release) kind = "release";
  else if (arrival) kind = "arrival";
  else if (payment) kind = "payment";
  else if (storage) kind = "storage";
  else if (pickup) kind = "pickup";

  let label = "PDF attachment";
  if (kind === "pod") label = "POD PDF";
  if (kind === "arrival") label = "Arrival notice PDF";
  if (kind === "release") label = "Release/DO PDF";
  if (kind === "customs-hold") label = "Customs hold PDF";
  if (kind === "payment") label = "Station payment PDF";
  if (kind === "storage") label = "Storage PDF";
  if (kind === "pickup") label = "Pickup PDF";

  const noteParts = [];
  if (awb) noteParts.push(`AWB ${awb}`);
  if (kind === "pod") noteParts.push(`delivery/POD proof${signedBy ? ` signed by ${signedBy}` : ""}`);
  if (kind === "arrival") noteParts.push(`arrival/on-hand proof${arrivedAt ? ` ${arrivedAt}` : ""}`);
  if (kind === "release") noteParts.push("customs release/DO proof");
  if (kind === "customs-hold") noteParts.push("customs/release still blocking");
  if (payment) noteParts.push("station fee/payment context");
  if (storage || lfd) noteParts.push(`storage${lfd ? ` LFD ${lfd}` : ""}`);
  if (pickup) noteParts.push("pickup/recovery proof");
  if (!noteParts.length) noteParts.push(normalizeText(text).slice(0, 180));

  return {
    kind,
    label,
    status: `pdf-${kind}`,
    note: `${label}: ${noteParts.join("; ")}.`,
    awb,
    signals: {
      arrival,
      release,
      negatedRelease,
      pod,
      pickup,
      payment,
      storage,
    },
    fields: {
      arrivedAt,
      lastFreeDay: lfd,
      signedBy,
    },
    textPreview: normalizeText(text).slice(0, 1000),
  };
}

module.exports = {
  classifyPdfOperationalEvidence,
  decodeBase64UrlBuffer,
  extractPdfTextFromBuffer,
  extractSimplePdfText,
  hasOperationalPdfSignal,
  normalizeText,
};

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_DIR = path.join(ROOT_DIR, "output", "pdf");
const DEFAULT_CARRIER_NAME = "PIKI";

const FIELD_MAP = {
  location: { rect: [228, 628, 70, 11], xy: [233.25, 631], size: 9 },
  origin_airport: { rect: [476, 620, 24, 9], xy: [482.25, 621.5], size: 6.5 },
  origin_country: { rect: [476, 610, 16, 9], xy: [482.25, 611.75], size: 6.5 },
  arrival_date: { rect: [169, 587, 58, 11], xy: [175.87, 589.2], size: 9 },
  awb_top: { rect: [53, 579, 66, 11], xy: [58.5, 582], size: 9 },
  carrier: { rect: [53, 548, 70, 12], xy: [58.5, 552], size: 9 },
  delivery_to: { rect: [53, 456, 318, 55], xy: [58.5, 503], size: 9 },
  pieces: { rect: [37, 402, 12, 11], xy: [42.75, 405], size: 9 },
  description: { rect: [104, 402, 66, 11], xy: [109.5, 405], size: 9 },
  weight: { rect: [481, 402, 38, 11], xy: [486.75, 405], size: 9 },
};

const TEMPLATE_VALUE_CLEAR_RECTS = [
  // The template carries example HAWB / Entry / Cust.Ref values; never let those leak into a generated DO.
  [442, 549, 31, 11],
  [441, 538, 33, 12],
  [452, 529, 10, 10],
];

const REPAIR_LINES = [
  [52, 579.5, 587, 579.5],
  [37.5, 94, 37.5, 416],
  [103.5, 94, 103.5, 416],
  [481.5, 94, 481.5, 416],
  [548.5, 94, 548.5, 416],
  [588.5, 94, 588.5, 416],
];

const SNAPSHOT_FILES = [
  ["canonical", "shipment-truth-packets", "shipment-truth-packets.json", "shipments"],
  ["tmsDetail", "", "tms-detail-snapshot.json", "shipments"],
  ["tmsGrid", "", "tms-grid-snapshot.json", "rows"],
  ["metadata", "", "shipment-metadata-snapshot.json", "shipments"],
];

function templatePathFromEnv() {
  const configured = String(process.env.ARKIA_DO_TEMPLATE || "").trim();
  if (!configured) return "";
  if (process.env.VERCEL && configured.startsWith("/Users/")) return "";
  return configured;
}

function usage() {
  console.error(
    [
      "Usage: node scripts/generate-delivery-order.js <AWB> [--template path] [--output path]",
      "       node scripts/generate-delivery-order.js <AWB> [--carrier-name name]",
      "",
      "Example:",
      "  npm run delivery-order -- 016-80000122",
      "  npm run delivery-order -- 016-80000122 --carrier-name \"Fast Forward\"",
      "",
      "By default this renders a generated blank DO. Use --template only for an explicitly verified shipment template.",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    awb: "",
    carrierName: process.env.DELIVERY_ORDER_CARRIER_NAME || DEFAULT_CARRIER_NAME,
    template: templatePathFromEnv(),
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--template") args.template = argv[++index] || "";
    else if (value === "--output") args.output = argv[++index] || "";
    else if (["--carrier-name", "--carrier", "--name", "--pickup-name"].includes(value)) args.carrierName = argv[++index] || "";
    else if (value === "--fields-json") args.fieldsJson = argv[++index] || "";
    else if (value === "--help" || value === "-h") args.help = true;
    else if (!args.awb) args.awb = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  return args;
}

function readJsonOptional(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function loadDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function loadLocalEnv() {
  loadDotEnvFile(path.join(ROOT_DIR, ".env"));
  loadDotEnvFile(path.join(ROOT_DIR, ".env.local"));
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatAwb(value) {
  const raw = String(value || "").trim();
  if (/\d{3}-\d{8}/.test(raw)) return raw.match(/\d{3}-\d{8}/)[0];
  const digits = normalizeAwb(raw);
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return raw;
}

function shipmentKeys(record) {
  const values = [
    record?.awb,
    record?.trackingNumber,
    record?.tms?.trackingNumber,
    record?.tms?.awb,
    record?.metadata?.awb,
  ];
  return values.map(normalizeAwb).filter(Boolean);
}

function findRecordInSnapshot(snapshot, listKey, awb) {
  const target = normalizeAwb(awb);
  const rows = Array.isArray(snapshot) ? snapshot : snapshot?.[listKey] || [];
  return rows.find((row) => shipmentKeys(row).includes(target)) || null;
}

function localSourceRecordsForAwb(awb) {
  const found = {};

  for (const [label, , fileName, listKey] of SNAPSHOT_FILES) {
    const snapshot = readJsonOptional(path.join(ROOT_DIR, fileName), {});
    const match = findRecordInSnapshot(snapshot, listKey, awb);
    if (match) found[label] = match;
  }

  return found;
}

async function loadHostedSnapshot(snapshotKey) {
  try {
    const url = process.env.PQ_SUPABASE_URL;
    const key = process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || process.env.PQ_SUPABASE_ANON_KEY;
    if (!url || !key || !snapshotKey) return null;

    const table = process.env.PQ_SNAPSHOT_TABLE || "app_snapshots";
    const requestUrl = new URL(`${url}/rest/v1/${table}`);
    requestUrl.searchParams.set("select", "payload");
    requestUrl.searchParams.set("snapshot_key", `eq.${snapshotKey}`);
    requestUrl.searchParams.set("limit", "1");

    const response = await fetch(requestUrl, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
      },
    });
    if (!response.ok) return null;

    const rows = await response.json();
    return Array.isArray(rows) ? rows[0]?.payload || null : rows?.payload || null;
  } catch {
    return null;
  }
}

async function sourceRecordsForAwb(awb) {
  const found = localSourceRecordsForAwb(awb);

  await Promise.all(
    SNAPSHOT_FILES.map(async ([label, snapshotKey, , listKey]) => {
      if (!snapshotKey) return;
      const hosted = await loadHostedSnapshot(snapshotKey);
      const match = findRecordInSnapshot(hosted, listKey, awb);
      if (match) found[label] = match;
    }),
  );

  return found;
}

function firstValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (/^(not found|confirm station|carrier)$/i.test(text)) continue;
    return text;
  }
  return "";
}

function cleanText(value) {
  return String(value || "").replace(/\r/g, " ").split(/\s+/).filter(Boolean).join(" ");
}

function maybeUsefulLocation(value) {
  const text = firstValue(value);
  if (!text || /^carrier\s+[A-Z]{3}$/i.test(text)) return "";
  return text;
}

function parseDate(value) {
  const text = String(value || "").trim();
  if (!text) return "";

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (numeric) {
    const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
    return `${numeric[1].padStart(2, "0")}/${numeric[2].padStart(2, "0")}/${year}`;
  }

  const monthDate = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i);
  if (monthDate) {
    const date = new Date(monthDate[0].replace(/(\d{1,2})\s+(\d{4})$/, "$1, $2"));
    if (!Number.isNaN(date.getTime())) {
      return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
    }
  }

  return "";
}

function generatedDateString(now = new Date(), timeZone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.month}/${parts.day}/${parts.year}`;
}

function formatWeight(value, uom) {
  const amount = firstValue(value);
  if (!amount) return "";
  const unit = firstValue(uom).toLowerCase() || "kg";
  const normalized = amount.replace(/\.0$/, "");
  return `${normalized} ${unit}`;
}

function deliveryLines(active, detail) {
  const consignee = firstValue(active?.delivery?.consignee, detail?.consigneeCompany);
  const address1 = firstValue(active?.delivery?.address1, detail?.deliveryAddress1);
  const address2 = firstValue(active?.delivery?.address2, detail?.deliveryAddress2, detail?.deliveryAddress3);
  const cityLine = firstValue(
    [active?.delivery?.city, active?.delivery?.state, active?.delivery?.country].filter(Boolean).join(" "),
    [detail?.deliveryCity, detail?.deliveryState, detail?.deliveryCountry].filter(Boolean).join(" "),
  );
  return [consignee, address1, address2, cityLine].filter(Boolean);
}

function buildFields(awb, sources, options = {}) {
  const active = sources.active || sources.dashboard || {};
  const detail = sources.tmsDetail || {};
  const grid = sources.tmsGrid || {};
  const metadata = sources.metadata || {};
  const displayAwb = formatAwb(firstValue(active.awb, detail.trackingNumber, grid.trackingNumber, metadata.awb, awb));

  const fields = {
    awb_top: displayAwb,
    arrival_date: generatedDateString(),
    description: displayAwb,
  };

  const location = maybeUsefulLocation(firstValue(active.handler, metadata.handler));
  if (location) fields.location = location;

  const originAirport = firstValue(detail.pickupAirport, grid.orig);
  if (originAirport) fields.origin_airport = originAirport.toUpperCase();

  const originCountry = firstValue(detail.pickupCountry);
  if (originCountry) fields.origin_country = originCountry.toUpperCase();

  const carrier = firstValue(options.carrierName, active?.delivery?.courier, active?.tms?.deliveryCourier, detail.deliveryCourier, active.broker);
  if (carrier) fields.carrier = carrier;

  const lines = deliveryLines(active, detail);
  if (lines.length) fields.delivery_to = lines;

  const pieces = firstValue(active?.tms?.pieces, detail.pieces);
  if (pieces) fields.pieces = pieces;

  const weight = formatWeight(firstValue(active?.tms?.weight, detail.weight), firstValue(active?.tms?.weightUom, detail.weightUom));
  if (weight) fields.weight = weight;

  return fields;
}

function fieldOverridesFromArgs(args) {
  const raw = firstValue(args.fieldsJson, process.env.DELIVERY_ORDER_FIELDS_JSON);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Invalid delivery order fields JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function outputPathForAwb(awb) {
  const safeAwb = formatAwb(awb).replace(/[^A-Za-z0-9-]+/g, "-") || "shipment";
  return path.join(DEFAULT_OUTPUT_DIR, `delivery-order-${safeAwb}.pdf`);
}

async function createFallbackPdf(fields) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 42;
  let y = 740;

  page.drawText("DELIVERY ORDER", {
    x: left,
    y,
    size: 18,
    font: bold,
    color: rgb(0, 0, 0),
  });
  y -= 32;

  const rows = [
    ["AWB", fields.awb_top],
    ["Carrier / broker", fields.carrier],
    ["Location", fields.location],
    ["Arrival date", fields.arrival_date],
    ["Origin", [fields.origin_airport, fields.origin_country].filter(Boolean).join(" / ")],
    ["Pieces", fields.pieces],
    ["Weight", fields.weight],
    ["Description", fields.description],
  ].filter(([, value]) => cleanText(value));

  for (const [label, value] of rows) {
    page.drawText(label, { x: left, y, size: 9, font: bold, color: rgb(0.18, 0.18, 0.18) });
    page.drawText(cleanText(value), { x: 150, y, size: 10, font: regular, color: rgb(0, 0, 0) });
    y -= 24;
  }

  const deliveryLinesValue = Array.isArray(fields.delivery_to) ? fields.delivery_to : [fields.delivery_to].filter(Boolean);
  if (deliveryLinesValue.length) {
    y -= 8;
    page.drawText("Deliver to", { x: left, y, size: 9, font: bold, color: rgb(0.18, 0.18, 0.18) });
    y -= 18;
    for (const line of deliveryLinesValue.map(cleanText).filter(Boolean).slice(0, 5)) {
      page.drawText(line, { x: left, y, size: 10, font: regular, color: rgb(0, 0, 0) });
      y -= 16;
    }
  }

  y -= 32;
  page.drawLine({ start: { x: left, y }, end: { x: 280, y }, thickness: 0.7, color: rgb(0, 0, 0) });
  page.drawText("Authorized signature", { x: left, y: y - 16, size: 8, font: regular, color: rgb(0.25, 0.25, 0.25) });
  page.drawLine({ start: { x: 330, y }, end: { x: 555, y }, thickness: 0.7, color: rgb(0, 0, 0) });
  page.drawText("Date", { x: 330, y: y - 16, size: 8, font: regular, color: rgb(0.25, 0.25, 0.25) });

  return pdf;
}

async function renderPdf({ template, output, fields }) {
  const pdf = template ? await PDFDocument.load(fs.readFileSync(template)) : await createFallbackPdf(fields);
  const pages = pdf.getPages();
  if (!pages.length) throw new Error("Template PDF has no pages");

  const page = pages[0];
  const courier = await pdf.embedFont(StandardFonts.Courier);

  for (const [x, y, width, height] of TEMPLATE_VALUE_CLEAR_RECTS) {
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderWidth: 0 });
  }

  for (const [key, spec] of Object.entries(FIELD_MAP)) {
    const rawValue = fields[key];
    const lines = Array.isArray(rawValue)
      ? rawValue.map(cleanText).filter(Boolean)
      : [cleanText(rawValue)].filter(Boolean);
    if (!lines.length) continue;

    const [x, y, width, height] = spec.rect;
    page.drawRectangle({ x, y, width, height, color: rgb(1, 1, 1), borderWidth: 0 });
    for (const [index, line] of lines.slice(0, 4).entries()) {
      page.drawText(line, {
        x: spec.xy[0],
        y: spec.xy[1] - index * (spec.size + 5),
        size: spec.size,
        font: courier,
        color: rgb(0, 0, 0),
      });
    }
  }

  for (const [x0, y0, x1, y1] of REPAIR_LINES) {
    page.drawLine({
      start: { x: x0, y: y0 },
      end: { x: x1, y: y1 },
      thickness: 0.6,
      color: rgb(0, 0, 0),
    });
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, await pdf.save());
}

async function main() {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.awb) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.template && !fs.existsSync(args.template) && !process.env.VERCEL) {
    throw new Error(`Template PDF not found: ${args.template}`);
  }
  if (args.template && !fs.existsSync(args.template)) args.template = "";

  const sources = await sourceRecordsForAwb(args.awb);
  const fields = buildFields(args.awb, sources, { carrierName: args.carrierName });
  Object.assign(fields, fieldOverridesFromArgs(args));
  const output = args.output ? path.resolve(args.output) : outputPathForAwb(args.awb);

  await renderPdf({ template: args.template, output, fields });

  console.log(
    JSON.stringify(
      {
        ok: true,
        awb: formatAwb(args.awb),
        output,
        template: args.template || "generated-fallback",
        populatedFields: Object.keys(fields),
        foundSources: Object.keys(sources),
        preservedUnknownTemplateFields: Boolean(args.template),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

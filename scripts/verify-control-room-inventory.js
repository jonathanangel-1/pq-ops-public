#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const { normalizeAwb } = require("../lib/ops-brain-companion");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PATH = path.join(ROOT_DIR, "shipment-truth-packets.json");

function parseArgs(argv) {
  const options = {
    file: DEFAULT_PATH,
    allowStale: false,
  };
  for (const arg of argv) {
    if (arg === "--allow-stale") options.allowStale = true;
    else if (arg.startsWith("--file=")) options.file = path.resolve(ROOT_DIR, arg.slice("--file=".length));
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return true;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function readJson(relativePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8"));
  } catch {
    return fallback;
  }
}

function liveTmsAccess() {
  try {
    const output = execFileSync(process.execPath, [path.join(ROOT_DIR, "scripts", "tms-access.js"), "--json"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90000,
      env: process.env,
    });
    return JSON.parse(output);
  } catch (error) {
    return {
      ok: false,
      reason: error.stderr?.toString?.() || error.message,
    };
  }
}

function shipmentOrder(item, activeByAwb) {
  const key = normalizeAwb(item.awb || item.normalizedAwb);
  return String(
    item.tmsOrder ||
      item.shipmentId ||
      item.order ||
      activeByAwb.get(key)?.id ||
      activeByAwb.get(key)?.order ||
      activeByAwb.get(key)?.tms?.order ||
      "",
  ).trim();
}

function verifyLiveTmsMembership(shipments) {
  const tms = liveTmsAccess();
  if (!tms.ok) {
    throw new Error(`Control-room inventory live source unavailable: npm run tms:access:json failed: ${tms.reason || tms.error || "unknown error"}`);
  }
  const liveOrders = (Array.isArray(tms.orders) ? tms.orders : [])
    .map((order) => String(order || "").trim())
    .filter(Boolean);
  if (Number.isFinite(Number(tms.numberOfTasks))) {
    assert.equal(
      shipments.length,
      Number(tms.numberOfTasks),
      `Control-room inventory count ${shipments.length} does not match live TMS task count ${tms.numberOfTasks}`,
    );
  }
  if (!liveOrders.length) return { tms, liveOrders, missingLiveOrders: [], extraNonLiveOrders: [] };

  const active = readJson("shipment-truth-packets.json", { shipments: [] });
  const activeByAwb = new Map((active.shipments || []).map((shipment) => [normalizeAwb(shipment.awb || shipment.trackingNumber), shipment]));
  const inventoryOrders = shipments.map((item) => shipmentOrder(item, activeByAwb)).filter(Boolean);
  const inventoryOrderSet = new Set(inventoryOrders);
  const liveOrderSet = new Set(liveOrders);
  const missingLiveOrders = liveOrders.filter((order) => !inventoryOrderSet.has(order));
  const extraNonLiveOrders = inventoryOrders.filter((order) => !liveOrderSet.has(order));
  assert.deepEqual(missingLiveOrders, [], `Control-room inventory is missing live TMS order(s): ${missingLiveOrders.join(", ")}`);
  assert.deepEqual(extraNonLiveOrders, [], `Control-room inventory contains non-live TMS order(s): ${extraNonLiveOrders.join(", ")}`);
  return { tms, liveOrders, missingLiveOrders, extraNonLiveOrders };
}

function verifyPacketShipment(item) {
  const awb = item.awb || item.normalizedAwb || "(missing AWB)";
  assert.equal(normalizeAwb(item.awb || item.normalizedAwb).length, 11, `${awb}: malformed AWB`);
  assert.ok(hasValue(item.station), `${awb}: missing station`);
  assert.ok(hasValue(item.airline), `${awb}: missing airline`);
  assert.ok(hasValue(item.client) || hasValue(item.consignee), `${awb}: missing client/consignee`);
  assert.ok(hasValue(item.currentState) || hasValue(item.opsState?.summary), `${awb}: missing current state`);
  assert.ok(hasValue(item.nextAction) || hasValue(item.opsState?.nextAction), `${awb}: missing next action`);
  assert.ok(hasValue(item.opsState?.phase), `${awb}: missing canonical phase`);
  assert.ok(hasValue(item.opsState?.gates), `${awb}: missing canonical gates`);
  assert.ok(hasValue(item.operationalRisk?.level) || hasValue(item.opsState?.urgency), `${awb}: missing risk/urgency`);
  assert.ok(hasValue(item.cargo?.pieces) || hasValue(item.tms?.pieces), `${awb}: missing canonical cargo pieces`);
  assert.ok(hasValue(item.cargo?.weight) || hasValue(item.tms?.weight), `${awb}: missing canonical cargo weight`);
  assert.ok(hasValue(item.flightDetails?.tmsFlight) || hasValue(item.flightDetails?.primaryFlight) || hasValue(item.tms?.tmsFlight) || hasValue(item.tms?.flight), `${awb}: missing canonical flight details`);
  assert.ok(hasValue(item.flightDetails?.route) || hasValue(item.route) || hasValue(item.tms?.route), `${awb}: missing canonical route`);
  assert.ok(hasValue(item.delivery?.fullAddress), `${awb}: missing canonical delivery address`);
  assert.ok(
    hasValue(item.truthPacket) || hasValue(item.evidencePacket) || hasValue(item.factLedger) || hasValue(item.facts),
    `${awb}: missing canonical evidence packet/facts`,
  );
}

function verifyInventoryShipment(item) {
  const awb = item.awb || item.normalizedAwb || "(missing AWB)";
  assert.equal(normalizeAwb(item.awb || item.normalizedAwb).length, 11, `${awb}: malformed AWB`);
  for (const field of [
    "station",
    "carrier",
    "consignee",
    "canonicalState",
    "risk",
    "nextAction",
    "suggestedCommunicationAction",
    "evidenceSource",
    "uncertainty",
    "relatedWorkgroupHints",
  ]) {
    assert.ok(hasValue(item[field]), `${awb}: missing ${field}`);
  }
  assert.ok(hasValue(item.canonicalState.phase), `${awb}: missing canonical state phase`);
  assert.ok(hasValue(item.risk.level), `${awb}: missing risk level`);
  assert.ok(hasValue(item.evidenceSource.source), `${awb}: missing evidence source`);
  assert.ok(Array.isArray(item.relatedWorkgroupHints.relatedAwbs), `${awb}: related-workgroup hints must expose relatedAwbs array`);
  assert.equal(typeof item.uncertainty.flag, "boolean", `${awb}: uncertainty flag must be boolean`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.file)) {
    throw new Error(`Control-room inventory artifact is missing. Run: node scripts/shipment-truth-audit-loop.js --cycles=1 --passes=1 --require-fresh-inventory`);
  }
  const payload = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const sourceKind = String(payload.writerVersion || "").startsWith("shipment-truth-packets-v1") ||
    String(options.file).endsWith("shipment-truth-packets.json")
    ? "shipment-truth-packets"
    : "control-room-inventory";
  const freshnessStatus = sourceKind === "shipment-truth-packets"
    ? "canonical-packets"
    : payload.sourceFreshness?.status || "unknown";
  if (sourceKind !== "shipment-truth-packets") {
    if (freshnessStatus === "live-source-unavailable") {
      const blockers = payload.sourceFreshness?.blockers || [];
      throw new Error(`Control-room inventory live source unavailable: ${JSON.stringify(blockers)}`);
    }
    if (!options.allowStale) {
      assert.equal(
        freshnessStatus,
        "fresh-audit-passed",
        `Control-room inventory is not fresh (${freshnessStatus}). Stale audit is secondary only; regenerate from live sources or report the live-source blocker.`,
      );
    }
  } else {
    assert.match(payload.writerVersion || "", /^shipment-truth-packets-v1/, "Canonical inventory must be a shipment-truth-packets-v1 writer family");
  }
  const allShipments = Array.isArray(payload.shipments) ? payload.shipments : [];
  let shipments = allShipments;
  let packetRowCount = null;
  let packetActiveAwbCount = null;
  let packetCompletedRowCount = null;
  let packetCompletedAwbCount = null;
  if (sourceKind === "shipment-truth-packets") {
    const activeAwbSet = new Set((Array.isArray(payload.activeAwbs) ? payload.activeAwbs : [])
      .map((awb) => normalizeAwb(awb))
      .filter(Boolean));
    const completedAwbSet = new Set((Array.isArray(payload.completedAwbs) ? payload.completedAwbs : [])
      .map((awb) => normalizeAwb(awb))
      .filter(Boolean));
    const activeRoleAwbSet = new Set(allShipments
      .filter((item) => String(item?.truthPacketRole || "active").toLowerCase() === "active")
      .map((item) => normalizeAwb(item?.awb || item?.normalizedAwb))
      .filter(Boolean));
    const completedRoleAwbSet = new Set(allShipments
      .filter((item) => String(item?.truthPacketRole || "").toLowerCase() === "completed")
      .map((item) => normalizeAwb(item?.awb || item?.normalizedAwb))
      .filter(Boolean));
    packetRowCount = allShipments.length;
    packetActiveAwbCount = activeAwbSet.size;
    packetCompletedAwbCount = completedAwbSet.size;
    packetCompletedRowCount = allShipments.filter((item) =>
      item?.completed || String(item?.truthPacketRole || "").toLowerCase() === "completed"
    ).length;
    assert.ok(activeAwbSet.size > 0, "Canonical shipment-truth-packets must expose activeAwbs for control-room inventory verification");
    const lifecycleIndexOverlap = [...activeAwbSet].filter((awb) => completedAwbSet.has(awb)).sort();
    assert.deepEqual(lifecycleIndexOverlap, [], `Canonical activeAwbs and completedAwbs must be disjoint: ${lifecycleIndexOverlap.join(", ")}`);
    assert.deepEqual(
      [...activeAwbSet].sort(),
      [...activeRoleAwbSet].sort(),
      "Canonical activeAwbs must exactly project final active row roles",
    );
    assert.deepEqual(
      [...completedAwbSet].sort(),
      [...completedRoleAwbSet].sort(),
      "Canonical completedAwbs must exactly project final completed row roles",
    );
    assert.equal(payload.counts?.shipments, allShipments.length, "Canonical shipment count must match final packet rows");
    assert.equal(payload.counts?.activeShipments, activeRoleAwbSet.size, "Canonical active count must match final active row roles");
    assert.equal(payload.counts?.completedShipments, completedRoleAwbSet.size, "Canonical completed count must match final completed row roles");
    assert.equal(
      payload.counts?.evidenceOnlyShipments,
      allShipments.filter((item) => String(item?.truthPacketRole || "").toLowerCase() === "evidence-only").length,
      "Canonical evidence-only count must match final evidence-only row roles",
    );
    shipments = allShipments.filter((item) => {
      const key = normalizeAwb(item?.awb || item?.normalizedAwb);
      return key && activeAwbSet.has(key);
    });
    assert.equal(
      shipments.length,
      activeAwbSet.size,
      `Canonical packet active row count ${shipments.length} does not match activeAwbs count ${activeAwbSet.size}`,
    );
  }
  assert.ok(shipments.length > 0, "Control-room inventory contains no active shipments");
  const seen = new Set();
  for (const item of shipments) {
    const key = normalizeAwb(item.awb || item.normalizedAwb);
    if (seen.has(key)) throw new Error(`${item.awb || key}: duplicate inventory AWB`);
    seen.add(key);
    if (sourceKind === "shipment-truth-packets") verifyPacketShipment(item);
    else verifyInventoryShipment(item);
  }
  const artifactStatus = payload.inventoryStatus || {};
  if (sourceKind !== "shipment-truth-packets") {
    assert.notEqual(artifactStatus.ok, false, `Inventory shape failed in artifact: ${JSON.stringify(artifactStatus)}`);
  }
  const liveTms = options.allowStale ? null : verifyLiveTmsMembership(shipments);
  console.log(JSON.stringify({
    ok: true,
    file: options.file,
    sourceKind,
    status: freshnessStatus,
    checked: shipments.length,
    packetRows: packetRowCount,
    packetActiveAwbs: packetActiveAwbCount,
    packetCompletedRows: packetCompletedRowCount,
    packetCompletedAwbs: packetCompletedAwbCount,
    liveTmsCount: liveTms?.tms?.numberOfTasks ?? null,
    liveTmsOrderCount: liveTms?.liveOrders?.length ?? null,
    allowStale: options.allowStale,
  }));
}

main();

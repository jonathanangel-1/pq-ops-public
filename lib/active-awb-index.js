"use strict";

const { normalizeAwb } = require("./awb");

function truthPacketRowAwb(row = {}) {
  return normalizeAwb(row.awb || row.id || row.shipmentId);
}

function truthPacketRole(row = {}) {
  return String(row.truthPacketRole || "active").toLowerCase();
}

function activeTruthPacketRows(snapshot = {}) {
  return (snapshot.shipments || []).filter((row) => {
    const awb = truthPacketRowAwb(row);
    if (!awb) return false;
    const role = truthPacketRole(row);
    return !role || role === "active";
  });
}

function completedTruthPacketRows(snapshot = {}) {
  return (snapshot.shipments || []).filter((row) => {
    const awb = truthPacketRowAwb(row);
    if (!awb) return false;
    return truthPacketRole(row) === "completed";
  });
}

function buildActiveAwbIndexSnapshot(snapshot = {}, now = new Date()) {
  const activeRows = activeTruthPacketRows(snapshot);
  const activeAwbs = [...new Set(activeRows.map(truthPacketRowAwb).filter(Boolean))].sort();
  const completedAwbs = [...new Set(completedTruthPacketRows(snapshot).map(truthPacketRowAwb).filter(Boolean))].sort();
  return {
    snapshotTime: snapshot.snapshotTime || now.toISOString(),
    source: "shipment-truth-packets",
    writerVersion: "active-awb-index-v1",
    truthPacketContentSignature: snapshot.contentSignature || "",
    counts: {
      activeShipments: activeRows.length,
      completedAwbs: completedAwbs.length,
      sourceShipments: (snapshot.shipments || []).length,
    },
    activeAwbs,
    completedAwbs,
  };
}

module.exports = {
  activeTruthPacketRows,
  buildActiveAwbIndexSnapshot,
};

"use strict";

// The production witness deliberately transports shipment semantics, not the
// multi-megabyte source packet. Keep this module data-only: both the protected
// endpoint and the independent relational auditor use the same normalization
// contract, so compaction cannot silently change what "agreement" means.

const GATE_ORDER = Object.freeze([
  "arrival",
  "customs",
  "fees",
  "dispatch",
  "pickup",
  "delivery",
  "pod",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function field(row, ...names) {
  if (!row || typeof row !== "object") return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function rows(container, ...names) {
  for (const name of names) {
    const value = field(container, name);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function sortedUnique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function canonicalUnordered(value) {
  if (Array.isArray(value)) {
    return value
      .map(canonicalUnordered)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.keys(value).sort().reduce((output, key) => {
    output[key] = canonicalUnordered(value[key]);
    return output;
  }, {});
}

function canonicalOrdered(value) {
  if (Array.isArray(value)) return value.map(canonicalOrdered);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isPlainObject(value)) return {};
  return Object.keys(value).sort().reduce((output, key) => {
    if (value[key] !== undefined) output[key] = canonicalOrdered(value[key]);
    return output;
  }, {});
}

function controlRoomMetadata(row) {
  const sourceCoverage = field(row, "sourceCoverage", "source_coverage") || {};
  return canonicalOrdered({
    order: text(field(row, "order")),
    shipmentNumber: text(field(row, "shipmentNumber", "shipment_number")),
    client: text(field(row, "client")),
    station: text(field(row, "station")),
    origin: text(field(row, "origin")),
    destination: text(field(row, "destination")),
    airline: text(field(row, "airline")),
    route: text(field(row, "route")),
    cargo: isPlainObject(field(row, "cargo")) ? field(row, "cargo") : {},
    flightDetails: isPlainObject(field(row, "flightDetails", "flight_details"))
      ? field(row, "flightDetails", "flight_details")
      : {},
    delivery: isPlainObject(field(row, "delivery")) ? field(row, "delivery") : {},
    freightBroker: isPlainObject(field(row, "freightBroker", "freight_broker"))
      ? field(row, "freightBroker", "freight_broker")
      : {},
    customsBroker: isPlainObject(field(row, "customsBroker", "customs_broker"))
      ? field(row, "customsBroker", "customs_broker")
      : {},
    contacts: isPlainObject(field(row, "contacts")) ? field(row, "contacts") : {},
    metadataReceipt: {
      versionId: text(field(
        sourceCoverage,
        "shipmentMetadataVersionId",
        "shipment_metadata_version_id",
      )),
      observationId: text(field(
        sourceCoverage,
        "shipmentMetadataObservationId",
        "shipment_metadata_observation_id",
      )),
      snapshotTime: text(field(
        sourceCoverage,
        "shipmentMetadataSnapshotTime",
        "shipment_metadata_snapshot_time",
      )),
    },
  });
}

function semanticToken(value) {
  return text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeLifecycle(value) {
  const token = semanticToken(value) || "unknown";
  const aliases = {
    prearrival: "pre_arrival",
    intransit: "in_transit",
    airport_picked_up: "picked_up",
    pickup_complete: "picked_up",
    pickup_completed: "picked_up",
    delivery_complete: "delivered",
    delivery_completed: "delivered",
    proof_of_delivery_received: "pod_received",
    closed: "pod_received",
  };
  return aliases[token] || token;
}

function normalizeGateStatus(value) {
  if (value === true) return "done";
  if (value === false || value === null || value === undefined) return "unknown";
  const token = semanticToken(value);
  if ([
    "true", "done", "complete", "completed", "released", "cleared", "paid",
    "received", "found", "picked_up", "loaded", "recovered", "delivered",
    "settled", "confirmed", "passed",
  ].includes(token)) return "done";
  if ([
    "blocked", "hold", "customs_hold", "exam_hold", "exception", "problem",
    "incomplete", "partial", "due", "unpaid",
  ].includes(token)) return "blocked";
  if (["contradicted", "conflict", "conflicted", "disputed"].includes(token)) {
    return "contradicted";
  }
  return "unknown";
}

function exactAwb(value) {
  const raw = text(value);
  if (!raw || !/^[0-9\s-]+$/.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length === 11 ? digits : "";
}

function rowAwbIdentity(row) {
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const groups = [
    [field(row, "awb")],
    field(row, "awbs"),
    field(packet, "awbs"),
    [field(row, "shipmentId", "shipment_id", "normalizedAwb", "normalized_awb")],
    [field(packet, "shipmentId", "shipment_id")],
    [field(row, "id")],
  ];
  let rawValues = [];
  for (const group of groups) {
    const values = (Array.isArray(group) ? group : [])
      .map((value) => text(value))
      .filter(Boolean);
    if (values.length) {
      rawValues = sortedUnique(values);
      break;
    }
  }
  const normalized = rawValues.map(exactAwb);
  const unique = sortedUnique(normalized);
  if (!rawValues.length) return { awb: "", rawValues, reason: "missing" };
  if (normalized.some((value) => !value)) return { awb: "", rawValues, reason: "malformed" };
  if (unique.length !== 1) return { awb: "", rawValues, reason: "ambiguous" };
  return { awb: unique[0], rawValues, reason: "" };
}

function gateForShipment(row, gateName) {
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const packetGates = field(packet, "gates");
  if (Array.isArray(packetGates)) {
    const match = packetGates.find((gate) =>
      semanticToken(field(gate, "gate", "name")) === gateName);
    if (match) return match;
  } else if (isPlainObject(packetGates) && isPlainObject(packetGates[gateName])) {
    return packetGates[gateName];
  }
  const opsGates = field(field(row, "opsState", "ops_state") || {}, "gates");
  if (isPlainObject(opsGates) && isPlainObject(opsGates[gateName])) return opsGates[gateName];
  const canonicalGates = field(field(row, "canonicalState", "canonical_state") || {}, "gates");
  if (isPlainObject(canonicalGates) && isPlainObject(canonicalGates[gateName])) {
    return canonicalGates[gateName];
  }
  return {};
}

function structuredActiveKinds(items, fields) {
  const kinds = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isPlainObject(item)) continue;
    const status = semanticToken(field(item, "status", "state"));
    if (["resolved", "inactive", "closed", "clear", "cleared", "dismissed"].includes(status)) continue;
    const kind = fields.map((name) => semanticToken(field(item, name))).find(Boolean) || "unspecified";
    kinds.push(kind);
  }
  return sortedUnique(kinds);
}

function shipmentSemantics(row, snapshot, awb) {
  if (text(field(snapshot, "schemaVersion", "schema_version")) ===
      "production-truth-semantic-witness-v1") {
    const suppliedGates = field(row, "gates");
    const gates = Object.fromEntries(GATE_ORDER.map((gateName) => [
      gateName,
      ["done", "blocked", "contradicted", "unknown"].includes(text(suppliedGates?.[gateName]))
        ? text(suppliedGates[gateName])
        : "unknown",
    ]));
    return canonicalUnordered({
      lifecycle: normalizeLifecycle(field(row, "lifecycle")),
      gates,
      active: field(row, "active") === true,
      completed: field(row, "completed") === true,
      delivered: field(row, "delivered") === true,
      pod: field(row, "pod") === true,
      contradictionKinds: sortedUnique(Array.isArray(field(row, "contradictionKinds"))
        ? field(row, "contradictionKinds").map(semanticToken)
        : []),
      blockerKinds: sortedUnique(Array.isArray(field(row, "blockerKinds"))
        ? field(row, "blockerKinds").map(semanticToken)
        : []),
      controlRoomMetadata: canonicalOrdered(field(row, "controlRoomMetadata") || {}),
    });
  }
  const packet = field(row, "truthPacket", "truth_packet") || {};
  const gates = Object.fromEntries(GATE_ORDER.map((gateName) => {
    const gate = gateForShipment(row, gateName);
    const raw = field(gate, "rawStatus", "raw_status") || field(gate, "status", "value");
    return [gateName, normalizeGateStatus(raw)];
  }));
  const completedIndex = new Set((Array.isArray(field(snapshot, "completedAwbs", "completed_awbs"))
    ? field(snapshot, "completedAwbs", "completed_awbs") : []).map(exactAwb).filter(Boolean));
  const activeIndex = new Set((Array.isArray(field(snapshot, "activeAwbs", "active_awbs"))
    ? field(snapshot, "activeAwbs", "active_awbs") : []).map(exactAwb).filter(Boolean));
  const role = semanticToken(field(row, "truthPacketRole", "truth_packet_role", "role"));
  const completed = field(row, "completed") === true || role === "completed" || completedIndex.has(awb);
  const lifecycle = normalizeLifecycle(
    field(field(packet, "physicalLifecycle", "physical_lifecycle") || {}, "status") ||
    field(packet, "resolvedCurrentState", "resolved_current_state", "currentState", "current_state") ||
    field(row, "currentState", "current_state") ||
    field(field(row, "opsState", "ops_state") || {}, "phase") ||
    field(row, "stage", "phase", "status"),
  );
  const deliveryStatus = semanticToken(field(row, "deliveryStatus", "delivery_status"));
  const deliveredFlag = field(row, "delivered") === true || field(packet, "delivered") === true;
  const delivered = completed || deliveredFlag || gates.delivery === "done" ||
    ["delivered", "complete", "completed", "done"].includes(deliveryStatus) ||
    ["delivered", "pod_received"].includes(lifecycle);
  const podStatus = semanticToken(
    field(row, "podStatus", "pod_status") || field(packet, "podStatus", "pod_status"),
  );
  const podFlag = field(row, "podReceived", "pod_received") === true ||
    field(packet, "podReceived", "pod_received") === true;
  const pod = completed || podFlag || gates.pod === "done" || lifecycle === "pod_received" ||
    ["received", "done", "complete", "completed"].includes(podStatus);
  const contradictions = Array.isArray(field(packet, "contradictions"))
    ? field(packet, "contradictions")
    : field(row, "contradictions");
  const contradictionKinds = structuredActiveKinds(contradictions, ["gate", "type", "category", "code"]);
  const blockerKinds = [];
  const blocker = field(packet, "operationalBlocker", "operational_blocker") ||
    field(row, "operationalBlocker", "operational_blocker") || {};
  const blockerType = semanticToken(field(blocker, "type", "kind", "code"));
  const blockerStatus = semanticToken(field(blocker, "status", "state"));
  if (blockerType && blockerType !== "none" && !["clear", "cleared", "resolved", "inactive"].includes(blockerStatus)) {
    blockerKinds.push(blockerType);
  }
  const exceptions = Array.isArray(field(packet, "exceptions"))
    ? field(packet, "exceptions")
    : field(row, "exceptions");
  blockerKinds.push(...structuredActiveKinds(exceptions, ["type", "predicate", "gate", "code"]));
  const documentBlocker = field(packet, "documentRequestBlocker", "document_request_blocker") || {};
  const documentStatus = semanticToken(field(documentBlocker, "status", "state"));
  const documentType = semanticToken(field(documentBlocker, "type", "kind"));
  if (documentType && documentType !== "none" && !["clear", "cleared", "resolved", "inactive"].includes(documentStatus)) {
    blockerKinds.push(documentType);
  }
  return canonicalUnordered({
    lifecycle,
    gates,
    active: activeIndex.has(awb) || (!completed && role !== "completed"),
    completed,
    delivered,
    pod,
    contradictionKinds,
    blockerKinds: sortedUnique(blockerKinds),
    controlRoomMetadata: controlRoomMetadata(row),
  });
}

function semanticInventory(snapshot) {
  const shipments = rows(snapshot || {}, "shipments");
  const map = new Map();
  const malformed = [];
  const duplicates = [];
  shipments.forEach((row, index) => {
    const identity = rowAwbIdentity(row);
    if (!identity.awb) {
      malformed.push({ index, rawValues: identity.rawValues, reason: identity.reason });
      return;
    }
    if (map.has(identity.awb)) {
      duplicates.push({ awb: identity.awb, firstIndex: map.get(identity.awb).index, duplicateIndex: index });
      return;
    }
    map.set(identity.awb, {
      index,
      rawValues: identity.rawValues,
      semantics: shipmentSemantics(row, snapshot, identity.awb),
    });
  });
  const indexes = {};
  for (const key of ["activeAwbs", "completedAwbs"]) {
    const values = Array.isArray(field(snapshot || {}, key)) ? field(snapshot || {}, key) : [];
    const seen = new Map();
    indexes[key] = [];
    values.forEach((value, index) => {
      const awb = exactAwb(value);
      if (!awb) malformed.push({ index, indexName: key, rawValues: [text(value)], reason: "malformed" });
      else if (seen.has(awb)) duplicates.push({ awb, indexName: key, firstIndex: seen.get(awb), duplicateIndex: index });
      else {
        seen.set(awb, index);
        indexes[key].push(awb);
      }
    });
    indexes[key].sort();
  }
  return { map, malformed, duplicates, indexes, shipmentCount: shipments.length };
}

function compactSemanticSnapshot(snapshot, identity = {}) {
  if (!isPlainObject(snapshot)) throw new TypeError("snapshot must be a plain object");
  const inventory = semanticInventory(snapshot);
  const shipments = [...inventory.map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([awb, item]) => ({ awb, ...item.semantics }));
  return {
    schemaVersion: "production-truth-semantic-witness-v1",
    publicationId: text(identity.publicationId),
    publicationVersion: Number.isSafeInteger(Number(identity.publicationVersion))
      ? Number(identity.publicationVersion)
      : null,
    publicationChannel: text(identity.publicationChannel),
    sourceCutId: text(identity.sourceCutId),
    packetHash: text(identity.packetHash),
    deliveryPayloadHash: text(identity.deliveryPayloadHash),
    contentSignature: text(identity.contentSignature),
    processingWatermarkStatus: text(identity.processingWatermarkStatus),
    processingWatermarkHash: text(identity.processingWatermarkHash) || null,
    shipments,
    activeAwbs: [...inventory.indexes.activeAwbs],
    completedAwbs: [...inventory.indexes.completedAwbs],
    malformed: inventory.malformed,
    duplicates: inventory.duplicates,
  };
}

module.exports = Object.freeze({
  GATE_ORDER,
  compactSemanticSnapshot,
  controlRoomMetadata,
  exactAwb,
  isPlainObject,
  semanticInventory,
  shipmentSemantics,
});

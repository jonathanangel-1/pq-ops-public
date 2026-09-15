"use strict";

// Cut-bound shipment metadata is a rebuildable projection of one immutable
// current TMS shipment observation. The database derives these envelopes from
// the sealed source cut; callers are never allowed to supply an alternate
// client/station/cargo map to the canonical build runner.

const crypto = require("node:crypto");
const { postgresJsonbText } = require("./postgres-jsonb");

const METADATA_SCHEMA_VERSION = "tms-shipment-control-room-metadata-v1";
const METADATA_VERSION_ID_RE = /^shipment-metadata:v1:[0-9a-f]{64}$/;
const OBSERVATION_ID_RE = /^obs:v1:[0-9a-f]{64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

class TruthShipmentMetadataError extends Error {
  constructor(message, fields = {}) {
    super(message, fields.cause ? { cause: fields.cause } : undefined);
    this.name = "TruthShipmentMetadataError";
    Object.assign(this, fields);
    if (fields.cause && !this.cause) this.cause = fields.cause;
  }
}

function invalid(field, reason, code = "TRUTH_SHIPMENT_METADATA_INVALID") {
  return new TruthShipmentMetadataError(`Invalid cut-bound shipment metadata ${field}: ${reason}`, {
    code,
    field,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value, field = "value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${field}[${index}]`));
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw invalid(`${field}.${key}`, "is forbidden");
      if (value[key] !== undefined) output[key] = canonicalize(value[key], `${field}.${key}`);
    }
    return output;
  }
  throw invalid(field, "must contain only JSON-compatible values");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeShipmentKey(value, field = "shipmentKey") {
  const raw = text(value);
  if (!raw || !/^[0-9\s-]+$/.test(raw)) throw invalid(field, "must contain only AWB digits, spaces, or a dash");
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 11) throw invalid(field, "must contain exactly eleven digits");
  return digits;
}

function sha256PostgresJsonb(value) {
  return crypto.createHash("sha256").update(postgresJsonbText(canonicalize(value)), "utf8").digest("hex");
}

function isoTimestamp(value, field) {
  const raw = text(value);
  const parsed = Date.parse(raw);
  if (!raw || !Number.isFinite(parsed)) throw invalid(field, "must be a timestamp");
  return new Date(parsed).toISOString();
}

function compactAddress(values) {
  return values.map(text).filter(Boolean).join(", ");
}

function tmsControlRoomDetails(shipment) {
  if (!isPlainObject(shipment)) throw invalid("shipment", "must be an object");
  const orderId = text(shipment.order || shipment.shipmentNumber);
  const client = text(shipment.customerName);
  const station = text(shipment.deliveryAirport || shipment.dest);
  const origin = text(shipment.orig);
  const destination = text(shipment.dest || shipment.deliveryAirport);
  const route = origin && destination ? `${origin}-${destination}` : "";
  const departureLeg = text(shipment.dep);
  const arrivalLeg = text(shipment.arr);
  const recoveryHint = text(shipment.nextTask);
  return canonicalize({
    schemaVersion: "tms-control-room-details-v1",
    orderId,
    client,
    station,
    origin,
    destination,
    airline: "",
    route,
    cargo: {
      pieces: text(shipment.pieces),
      weight: text(shipment.weight),
      weightUom: text(shipment.weightUom),
      contents: text(shipment.contents),
      declaredValue: text(shipment.value),
      source: "sealed-tms-observation",
    },
    flightDetails: {
      flights: departureLeg ? [{
        flight: departureLeg,
        sourceSegment: departureLeg,
        sourceField: "dep",
        suffix: "",
      }] : [],
      primaryFlight: departureLeg,
      tmsFlight: [departureLeg, arrivalLeg].filter(Boolean).join(" "),
      departureLeg,
      arrivalLeg,
      route,
      origin,
      destination,
      etaHint: recoveryHint,
      recoveryHint,
      source: "sealed-tms-observation",
    },
    delivery: {
      consignee: text(shipment.consigneeCompany),
      contactEmail: text(shipment.consigneeEmail),
      contactPhone: text(shipment.consigneePhone),
      address1: text(shipment.deliveryAddress1),
      address2: text(shipment.deliveryAddress2),
      address3: text(shipment.deliveryAddress3),
      city: text(shipment.deliveryCity),
      state: text(shipment.deliveryState),
      country: text(shipment.deliveryCountry),
      countryName: text(shipment.deliveryCountryName),
      airport: text(shipment.deliveryAirport),
      courier: text(shipment.deliveryCourier),
      actualArrivalDate: text(shipment.deliveryActualArrivalDate),
      actualArrivalTime: text(shipment.deliveryActualArrivalTime),
      fullAddress: compactAddress([
        shipment.deliveryAddress1,
        shipment.deliveryAddress2,
        shipment.deliveryAddress3,
        shipment.deliveryCity,
        shipment.deliveryState,
        shipment.deliveryCountry,
      ]),
      source: "sealed-tms-observation",
    },
    freightBroker: {
      broker: text(shipment.deliveryCourier),
      rawTmsCourier: text(shipment.deliveryCourier),
      sourceField: "deliveryCourier",
    },
    customsBroker: {
      broker: text(shipment.customsBrokerName),
      portOfEntry: text(shipment.customsPortOfEntry),
      sourceField: "customsBrokerName",
    },
    contacts: {
      shipper: {
        name: text(shipment.shipperName),
        email: text(shipment.shipperEmail),
        phone: text(shipment.shipperPhone),
      },
      pickup: {
        company: text(shipment.pickupCompany),
        email: text(shipment.pickupEmail),
        phone: text(shipment.pickupPhone),
        airport: text(shipment.pickupAirport),
        address1: text(shipment.pickupAddress1),
        address2: text(shipment.pickupAddress2),
        address3: text(shipment.pickupAddress3),
        city: text(shipment.pickupCity),
        state: text(shipment.pickupState),
        country: text(shipment.pickupCountry),
      },
      consignee: {
        company: text(shipment.consigneeCompany),
        email: text(shipment.consigneeEmail),
        phone: text(shipment.consigneePhone),
      },
      internalOwner: {
        code: text(shipment.owner),
        office: text(shipment.office),
        officeName: text(shipment.officeName),
      },
    },
  });
}

function buildTmsShipmentMetadataEnvelope(observation, options = {}) {
  if (!isPlainObject(observation)) throw invalid("observation", "must be an object");
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const payload = observation.normalizedPayload || observation.normalized_payload;
  const shipment = payload?.shipment;
  if (text(observation.sourceSystem || observation.source_system) !== "tms" ||
      text(observation.sourceObjectType || observation.source_object_type) !== "tms_shipment_snapshot" ||
      !isPlainObject(payload) || text(payload.schemaVersion) !== "tms-shipment-source-observation-v1" ||
      !isPlainObject(shipment)) {
    throw invalid("observation", "must be a normalized TMS shipment source observation");
  }
  const shipmentKey = normalizeShipmentKey(shipment.trackingNumber);
  const status = text(shipment.tmsStatus || shipment.status);
  if (!status) throw invalid("observation.normalizedPayload.shipment.status", "must not be empty");
  const sourceObservationId = text(observation.observationId || observation.observation_id);
  const sourceObservationContentHash = text(observation.contentHash || observation.content_hash);
  if (!OBSERVATION_ID_RE.test(sourceObservationId) || !HASH_RE.test(sourceObservationContentHash)) {
    throw invalid("observation", "must contain an immutable observation identity");
  }
  const snapshotTime = isoTimestamp(payload.snapshotTime, "observation.normalizedPayload.snapshotTime");
  const sourceRecordedAt = isoTimestamp(
    observation.sourceRecordedAt || observation.source_recorded_at || snapshotTime,
    "observation.sourceRecordedAt",
  );
  if (snapshotTime !== sourceRecordedAt) throw invalid("observation", "must be bound to the exact TMS source time");
  const canonicalEnvelope = canonicalize({
    schemaVersion: METADATA_SCHEMA_VERSION,
    workspaceKey: text(options.workspaceKey || observation.workspaceKey || observation.workspace_key || "primary"),
    sourceSystem: "tms",
    shipmentKey,
    sourceObservationId,
    sourceObservationContentHash,
    sourceRecordedAt,
    snapshotTime,
    details: tmsControlRoomDetails(shipment),
  });
  const envelopeHash = sha256PostgresJsonb(canonicalEnvelope);
  return deepFreeze({
    metadataVersionId: `shipment-metadata:v1:${envelopeHash}`,
    envelopeHash,
    canonicalEnvelope,
  });
}

function observationClosure(sourceCut) {
  if (!sourceCut) return null;
  const observations = Array.isArray(sourceCut.observations) ? sourceCut.observations : [];
  const closure = new Map();
  for (const [index, row] of observations.entries()) {
    if (!isPlainObject(row)) throw invalid(`sourceCut.observations[${index}]`, "must be an object");
    const observationId = text(row.observationId || row.observation_id);
    const contentHash = text(row.contentHash || row.content_hash);
    if (!OBSERVATION_ID_RE.test(observationId) || !HASH_RE.test(contentHash)) {
      throw invalid(`sourceCut.observations[${index}]`, "must contain an observation ID and content hash");
    }
    closure.set(observationId, contentHash);
  }
  return closure;
}

function normalizeShipmentMetadataEnvelopes(value, options = {}) {
  if (!Array.isArray(value)) throw invalid("shipmentMetadataEnvelopes", "must be an array");
  if (!isPlainObject(options)) throw invalid("options", "must be an object");
  const closure = observationClosure(options.sourceCut || null);
  const byShipment = new Map();
  const byObservation = new Set();
  const rows = value.map((row, index) => {
    const field = `shipmentMetadataEnvelopes[${index}]`;
    if (!isPlainObject(row)) throw invalid(field, "must be an object");
    const metadataVersionId = text(row.metadataVersionId || row.metadata_version_id || row.itemId || row.item_id);
    const envelopeHash = text(row.envelopeHash || row.envelope_hash || row.itemHash || row.item_hash);
    const envelope = canonicalize(row.canonicalEnvelope || row.canonical_envelope || row.envelope, `${field}.canonicalEnvelope`);
    if (!METADATA_VERSION_ID_RE.test(metadataVersionId)) throw invalid(`${field}.metadataVersionId`, "is invalid");
    if (!HASH_RE.test(envelopeHash)) throw invalid(`${field}.envelopeHash`, "must be lowercase SHA-256 hex");
    if (!isPlainObject(envelope)) throw invalid(`${field}.canonicalEnvelope`, "must be an object");
    const recomputedHash = sha256PostgresJsonb(envelope);
    if (recomputedHash !== envelopeHash || metadataVersionId !== `shipment-metadata:v1:${envelopeHash}`) {
      throw invalid(field, "identity does not match the canonical envelope hash", "TRUTH_SHIPMENT_METADATA_HASH_MISMATCH");
    }
    if (text(envelope.schemaVersion) !== METADATA_SCHEMA_VERSION || text(envelope.sourceSystem) !== "tms") {
      throw invalid(`${field}.canonicalEnvelope`, "must be a versioned TMS metadata envelope");
    }
    const shipmentKey = normalizeShipmentKey(envelope.shipmentKey, `${field}.canonicalEnvelope.shipmentKey`);
    const observationId = text(envelope.sourceObservationId);
    const observationContentHash = text(envelope.sourceObservationContentHash);
    if (!OBSERVATION_ID_RE.test(observationId) || !HASH_RE.test(observationContentHash)) {
      throw invalid(`${field}.canonicalEnvelope`, "must cite one immutable source observation and content hash");
    }
    if (closure && closure.get(observationId) !== observationContentHash) {
      throw invalid(`${field}.canonicalEnvelope.sourceObservationId`, "escaped the sealed build evidence closure", "TRUTH_SHIPMENT_METADATA_EVIDENCE_ESCAPE");
    }
    if (byShipment.has(shipmentKey)) {
      throw invalid(field, `duplicates shipment ${shipmentKey}`, "TRUTH_SHIPMENT_METADATA_DUPLICATE_SHIPMENT");
    }
    if (byObservation.has(observationId)) {
      throw invalid(field, `reuses source observation ${observationId}`, "TRUTH_SHIPMENT_METADATA_DUPLICATE_OBSERVATION");
    }
    const snapshotTime = isoTimestamp(envelope.snapshotTime, `${field}.canonicalEnvelope.snapshotTime`);
    const sourceRecordedAt = isoTimestamp(envelope.sourceRecordedAt, `${field}.canonicalEnvelope.sourceRecordedAt`);
    if (snapshotTime !== sourceRecordedAt) {
      throw invalid(`${field}.canonicalEnvelope`, "snapshotTime and sourceRecordedAt must identify the same current TMS cut");
    }
    if (!isPlainObject(envelope.details)) throw invalid(`${field}.canonicalEnvelope.details`, "must be an object");
    const normalized = {
      metadataVersionId,
      envelopeHash,
      shipmentKey,
      sourceObservationId: observationId,
      sourceObservationContentHash: observationContentHash,
      snapshotTime,
      sourceRecordedAt,
      details: canonicalize(envelope.details, `${field}.canonicalEnvelope.details`),
      canonicalEnvelope: envelope,
    };
    byShipment.set(shipmentKey, normalized);
    byObservation.add(observationId);
    return normalized;
  }).sort((left, right) => left.shipmentKey.localeCompare(right.shipmentKey));

  const manifest = rows.map((row) => ({ itemId: row.metadataVersionId, itemHash: row.envelopeHash }));
  const manifestHash = sha256PostgresJsonb(manifest);
  if (options.expectedManifestHash !== undefined && text(options.expectedManifestHash) !== manifestHash) {
    throw invalid("shipmentMetadataManifestHash", "does not match the exact ordered metadata envelope manifest", "TRUTH_SHIPMENT_METADATA_MANIFEST_MISMATCH");
  }
  return deepFreeze({ rows, byShipment, manifest, manifestHash });
}

module.exports = Object.freeze({
  HASH_RE,
  METADATA_SCHEMA_VERSION,
  METADATA_VERSION_ID_RE,
  TruthShipmentMetadataError,
  buildTmsShipmentMetadataEnvelope,
  normalizeShipmentKey,
  normalizeShipmentMetadataEnvelopes,
  sha256PostgresJsonb,
  tmsControlRoomDetails,
  _test: Object.freeze({ canonicalize, compactAddress, isPlainObject, observationClosure }),
});

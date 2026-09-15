#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const raw = require("../config/truth-predicate-registry-v1.json");
const {
  PREDICATES,
  REGISTRY,
  TMS_PREDICATES,
  modelPredicateCatalog,
  validateRegistry,
} = require("../lib/truth-predicate-registry");

function main() {
  assert.match(REGISTRY.registryHash, /^[0-9a-f]{64}$/);
  assert.equal(REGISTRY.registryVersion, "pikiio-shipment-predicates-2026-07-09-v2");
  assert.equal(REGISTRY.registryHash, "9a3b38320c2fc112a02fb956ceca6a4a18585f2db2a5a4ee4cd6b06601e66e1e");
  assert.ok(REGISTRY.predicates.shipment_observed_in_tms, (
    "the shared v2 registry identity must commit to the TMS source predicate"
  ));
  assert.ok(!PREDICATES.shipment_observed_in_tms, (
    "the general Gmail/model/operator predicate view must exclude TMS inventory presence"
  ));
  assert.ok(TMS_PREDICATES.shipment_observed_in_tms);
  assert.ok(Object.isFrozen(REGISTRY));
  assert.ok(Object.isFrozen(PREDICATES));
  assert.ok(Object.keys(PREDICATES).length >= 14);
  for (const required of [
    "arrival_confirmed", "transport_in_transit", "cargo_not_found", "customs_release", "customs_hold",
    "delivery_order_received", "station_fees_due", "station_fees_paid",
    "dispatch_confirmed", "pickup_scheduled", "pickup_completed", "out_for_delivery",
    "delivery_scheduled", "delivery_completed", "pod_received", "last_free_day", "quote_received",
  ]) assert.ok(PREDICATES[required], `missing ${required}`);

  assert.ok(PREDICATES.arrival_confirmed.positive.test("The cargo is on hand and available for pickup."));
  assert.ok(PREDICATES.transport_in_transit.positive.test("Cargo is confirmed on board."));
  assert.ok(PREDICATES.cargo_not_found.positive.test("The station cannot locate the cargo."));
  assert.ok(PREDICATES.customs_hold.positive.test("The shipment is on customs hold."));
  assert.ok(PREDICATES.customs_hold.negative.test("The CBP hold has been removed."));
  assert.ok(PREDICATES.delivery_order_received.positive.test("Delivery order attached."));
  assert.ok(PREDICATES.station_fees_due.positive.test("Terminal fees are still due."));
  assert.ok(PREDICATES.station_fees_paid.positive.test("The invoice has been paid."));
  assert.ok(PREDICATES.dispatch_confirmed.positive.test("Driver has been assigned."));
  assert.ok(PREDICATES.pickup_scheduled.positive.test("Pickup appointment is confirmed."));
  assert.ok(PREDICATES.pickup_completed.positive.test("The driver loaded the cargo onto the truck."));
  assert.ok(PREDICATES.out_for_delivery.positive.test("Cargo is out for delivery."));
  assert.ok(PREDICATES.delivery_completed.positive.test("Shipment was delivered to the consignee."));
  assert.ok(PREDICATES.pod_received.positive.test("Signed POD is attached."));
  assert.ok(PREDICATES.last_free_day.positive.test("LFD: 2026-07-12"));
  assert.ok(PREDICATES.quote_received.positive.test("Quote is attached."));
  assert.ok(!TMS_PREDICATES.shipment_observed_in_tms.topic.test("Shipment observed in TMS"), (
    "source-only inventory presence must never be extracted from message prose"
  ));

  const catalog = modelPredicateCatalog();
  assert.equal(catalog.length, Object.keys(PREDICATES).length);
  assert.ok(catalog.every((entry) => !Object.values(entry).some((value) => value instanceof RegExp)));
  assert.throws(() => validateRegistry({ ...raw, unexpected: true }), /unsupported keys/);
  assert.throws(() => validateRegistry({
    ...raw,
    predicates: {
      ...raw.predicates,
      customs_release: { ...raw.predicates.customs_release, gate: "invented" },
    },
  }), /gate.*unsupported/);

  console.log(JSON.stringify({
    ok: true,
    registryVersion: REGISTRY.registryVersion,
    registryHash: REGISTRY.registryHash,
    tmsRegistryVersion: REGISTRY.registryVersion,
    tmsRegistryHash: REGISTRY.registryHash,
    predicateCount: Object.keys(PREDICATES).length,
  }));
}

main();

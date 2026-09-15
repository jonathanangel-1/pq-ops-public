"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  controlRoomPlan,
  gateState,
  mergeShipments,
  normalizeAwb,
  readLocalMemory,
} = require("../lib/ops-brain-companion");
const { loadAppSnapshotRows } = require("../lib/supabase-agent");

const audit = require("../data/shipment-truth-audit.json");

const ROOT_DIR = path.join(__dirname, "..");
const SNAPSHOT_KEYS = [
  "shipment-truth-packets",
  "gmail-proof-snapshot",
  "shipment-state",
  "shipment-events",
  "shipment-truth-audit",
  "action-queue",
  "outbox-requests",
];

const SYNC_SOURCE = fs.readFileSync(path.join(ROOT_DIR, "scripts", "sync-supabase-snapshots.js"), "utf8");
assert.ok(
  SYNC_SOURCE.includes('["shipment-truth-audit", "data/shipment-truth-audit.json"]'),
  "Hosted snapshot sync must publish shipment-truth-audit so production answers use the same source of truth as local verification",
);

function loadDotEnvLocal() {
  const envPath = path.join(ROOT_DIR, ".env.local");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function assertHostedReadContractEnv() {
  loadDotEnvLocal();
  const hasKey = Boolean(process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || process.env.PQ_SUPABASE_ANON_KEY);
  if (!process.env.PQ_SUPABASE_URL || !hasKey || !process.env.PQ_SUPABASE_SYNC_TOKEN) {
    throw new Error(
      "Hosted truth-ledger verification requires PQ_SUPABASE_URL, PQ_SUPABASE_SYNC_TOKEN, and a Supabase key so it exercises the same sync-token read contract as production.",
    );
  }
}

async function readHostedMemory() {
  assertHostedReadContractEnv();
  const rows = await loadAppSnapshotRows(SNAPSHOT_KEYS, {
    allowLegacyTableReadFallback: false,
    timeoutMs: Number(process.env.PQ_VERIFY_HOSTED_TRUTH_TIMEOUT_MS || 8000),
  });
  const hosted = Object.fromEntries(rows.map((row) => [row.snapshot_key, row.payload]));
  return {
    active: hosted["shipment-truth-packets"] || { shipments: [] },
    gmailProof: hosted["gmail-proof-snapshot"],
    shipmentState: hosted["shipment-state"],
    shipmentEvents: hosted["shipment-events"],
    truthAudit: hosted["shipment-truth-audit"],
    opsBrain: { shipments: [], completed: [] },
    actions: hosted["action-queue"] || { actions: [] },
    outboxRequests: hosted["outbox-requests"] || { requests: [] },
  };
}

function truthPhase(row) {
  return String(row?.truth?.shipmentPhase || "");
}

function assertNoPhysicalProgress(awb, plan, gates) {
  assert.equal(gates.pickedUp, false, `${awb}: should not be picked up`);
  assert.equal(gates.driverOnsite, false, `${awb}: should not have a driver onsite`);
  assert.equal(gates.deliveryReported, false, `${awb}: should not be delivered/reported delivered`);
  assert.equal(gates.podReceived, false, `${awb}: should not have POD received`);
  assert.equal(gates.podPending, false, `${awb}: should not need POD before pickup/delivery`);
  assert.notEqual(plan.phase, "conflict", `${awb}: clean planning/pre-arrival evidence must not become an operator conflict`);
  assert.notEqual(plan.phase, "driver-onsite", `${awb}: planning/pre-arrival evidence must not become driver-onsite`);
}

function assertPreArrival(awb, plan, gates) {
  assert.equal(gates.arrived, false, `${awb}: should remain pre-arrival`);
  assert.equal(plan.phase, "pre-arrival", `${awb}: should resolve to pre-arrival`);
  assertNoPhysicalProgress(awb, plan, gates);
}

function rowAuditTime(row) {
  const candidates = [
    row?.updatedAt,
    row?.latestEventAt,
    row?.gmailAudit?.updatedAt,
    row?.truth?.updatedAt,
  ];
  return candidates
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
}

function shipmentEvidenceTime(shipment) {
  const candidates = [
    shipment?.updatedAt,
    shipment?.latestEventAt,
    shipment?.lastEmail?.at,
    shipment?.opsState?.updatedAt,
    shipment?.opsState?.latestEventAt,
    shipment?.emailValidation?.latestEventAt,
  ];
  Object.values(shipment?.opsState?.gates || {}).forEach((gate) => {
    candidates.push(gate?.at, gate?.updatedAt);
  });
  [
    ...(shipment?.operatorNotes || []),
    ...(shipment?.factLedger || []),
    ...(shipment?.opsState?.events || []),
    ...(shipment?.facts || []),
  ].forEach((fact) => {
    candidates.push(fact?.at, fact?.updatedAt, fact?.createdAt, fact?.occurredAt, fact?.observedAt);
  });
  return candidates
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
}

function auditExpectationIsStale(row, shipment) {
  const auditTime = rowAuditTime(row);
  const latestShipmentTime = shipmentEvidenceTime(shipment);
  return Boolean(auditTime && latestShipmentTime && latestShipmentTime > auditTime + 60_000);
}

function assertNewerCanonicalState(awb, shipment, actions) {
  const plan = controlRoomPlan(shipment, actions);
  const gates = gateState(shipment);
  assert.notEqual(plan.phase, "conflict", `${awb}: newer canonical state must not collapse into conflict`);
  if (!gates.pickedUp && !gates.deliveryReported) {
    assert.equal(gates.podPending, false, `${awb}: POD cannot be pending before pickup/delivery`);
    assert.equal(gates.podReceived, false, `${awb}: POD cannot be received before pickup/delivery`);
  }
  if (gates.podReceived) {
    assert.equal(gates.podPending, false, `${awb}: POD received must clear POD pending`);
    assert.equal(gates.deliveryReported, true, `${awb}: POD received must imply delivered/reported delivered`);
  }
  if (gates.deliveryReported) {
    assert.equal(gates.pickedUp, true, `${awb}: delivery reported must imply pickup path completed`);
    assert.equal(gates.driverOnsite, false, `${awb}: delivered shipment must not remain driver-onsite`);
  }
  if (gates.pickedUp) {
    assert.equal(gates.arrived, true, `${awb}: picked-up shipment must imply cargo was on hand`);
  }
}

function verifyPositiveArrivalBeatsRequestOnlyNoise() {
  const memory = {
    brain: {
      shipments: [
        {
          awb: "238-80000306",
          stage: "In transit",
          currentState: "Not at destination yet.",
          nextAction: "Prep pickup quotes only if ETA is within two days.",
          emailValidation: {
            latestEventAt: "2026-06-19T19:19:36.000Z",
            events: [
              {
                type: "arrival-notice-received",
                summary: "Arrival/on-hand evidence was received.",
                evidence:
                  "Your shipment has arrived (MAWB: 238-80000306). Arrival Date: 6/19/2026. Terminal: JFK - 260. Terminal address: Bldg 260 JFK AP Jamaica NY 11430. Storage begin date: 6/21/2026.",
                threadId: "arrival-thread",
                messageId: "arrival-message",
                at: "2026-06-19T19:19:36.000Z",
              },
              {
                type: "arrival-request",
                summary: "Earlier email asked for arrival notice.",
                evidence: "Please provide arrival notice when available.",
                threadId: "request-thread",
                messageId: "request-message",
                at: "2026-06-19T12:00:00.000Z",
              },
            ],
          },
        },
      ],
    },
  };
  const shipment = mergeShipments(memory).find((row) => normalizeAwb(row.awb) === "23880000306");
  assert.ok(shipment, "Positive-arrival fixture must merge into a shipment");
  const gates = gateState(shipment);
  assert.equal(gates.arrived, true, "Positive arrival notice must beat older request-only arrival text");
  assert.notEqual(controlRoomPlan(shipment, {}).phase, "pre-arrival", "Positive arrival notice must not resolve as pre-arrival");
}

function verifyLedgerRow(row, shipment, actions) {
  const awb = row.awb;
  assert.ok(shipment, `${awb}: missing from merged shipment memory`);
  const phase = truthPhase(row);
  const plan = controlRoomPlan(shipment, actions);
  const gates = gateState(shipment);

  if (
    [
      "in-transit-pre-arrival",
      "in-transit-export-exception",
      "in-transit-contaminated-thread",
      "in-transit-pre-arrival-with-release-context",
      "in-transit-pre-arrival-customs-prep",
      "prealert-booked-pre-arrival",
      "prealert-docs-requested-pre-arrival",
      "inbond-prealert-pre-arrival",
      "booking-paperwork-closed-pre-arrival",
    ].includes(phase)
  ) {
    assertPreArrival(awb, plan, gates);
    return;
  }

  if (phase === "do-attached-pre-arrival-clearance-pending") {
    assertPreArrival(awb, plan, gates);
    assert.equal(gates.customsBrokerRelease, false, `${awb}: DO attached with future clearance confirmation is not final release`);
    return;
  }

  if (phase === "released-pre-arrival") {
    assertPreArrival(awb, plan, gates);
    assert.equal(gates.customsHold, false, `${awb}: released pre-arrival shipment must not look like customs hold`);
    return;
  }

  if (phase === "released-arrival-pending") {
    assert.equal(gates.deliveryReported, false, `${awb}: release/entry shipment must not be delivered`);
    assert.equal(gates.podPending, false, `${awb}: release/entry shipment must not need POD`);
    assert.notEqual(plan.phase, "conflict", `${awb}: release/entry planning should not be a conflict`);
    return;
  }

  if (phase === "arrival-due-release-sent-pickup-planned") {
    assert.equal(gates.deliveryReported, false, `${awb}: arrival-due shipment must not be delivered`);
    assert.equal(gates.pickedUp, false, `${awb}: arrival-due shipment must not be picked up`);
    assert.equal(gates.driverOnsite, false, `${awb}: arrival-due shipment must not be driver onsite`);
    assert.notEqual(plan.phase, "conflict", `${awb}: release-sent pickup plan must not be a conflict`);
    return;
  }

  if (phase === "arrived-customs-hold-storage-accruing") {
    assert.equal(gates.arrived, true, `${awb}: storage/customs hold shipment should be arrived`);
    assert.equal(gates.customsHold, true, `${awb}: should preserve true customs hold`);
    assert.equal(gates.deliveryReported, false, `${awb}: customs-hold shipment must not be delivered`);
    assert.equal(gates.pickedUp, false, `${awb}: customs-hold shipment must not be picked up`);
    return;
  }

  if (phase === "arrived-station-exception") {
    assert.equal(gates.arrived, true, `${awb}: station exception shipment should be arrived`);
    assert.equal(gates.deliveryReported, false, `${awb}: station exception shipment must not be delivered`);
    assert.equal(gates.pickedUp, false, `${awb}: station exception shipment must not be picked up`);
    assert.ok(["arrival-incomplete", "storage-risk"].includes(plan.phase), `${awb}: should be station availability/storage blocker, got ${plan.phase}`);
    return;
  }

  if (phase === "arrived-released-pickup-pending") {
    assert.equal(gates.arrived, true, `${awb}: should be arrived`);
    assert.equal(gates.customsBrokerRelease, true, `${awb}: should be released`);
    assert.equal(gates.pickedUp, false, `${awb}: pickup remains pending`);
    assert.equal(gates.deliveryReported, false, `${awb}: should not be delivered`);
    assert.notEqual(plan.phase, "conflict", `${awb}: arrived/released/pickup-pending should not be a conflict`);
    return;
  }

  if (phase === "arrived-released-dispatch-sent-pickup-pending") {
    assert.equal(gates.arrived, true, `${awb}: should be arrived`);
    assert.equal(gates.customsBrokerRelease, true, `${awb}: should be released`);
    assert.equal(gates.pickedUp, false, `${awb}: dispatch sent does not prove pickup`);
    assert.equal(gates.deliveryReported, false, `${awb}: dispatch sent does not prove delivery`);
    assert.equal(gates.podPending, false, `${awb}: dispatch sent should not create POD follow-up yet`);
    return;
  }

  if (phase === "arrived-released-pickup-ready") {
    assert.equal(gates.arrived, true, `${awb}: should be arrived`);
    assert.equal(gates.customsBrokerRelease, true, `${awb}: should be released`);
    assert.equal(gates.driverOnsite, false, `${awb}: ready for pickup is not driver onsite`);
    assert.equal(gates.pickedUp, false, `${awb}: ready for pickup is not picked up`);
    assert.equal(gates.deliveryReported, false, `${awb}: ready for pickup is not delivered`);
    assert.notEqual(plan.phase, "conflict", `${awb}: ready/released should not be a conflict`);
    return;
  }

  if (phase === "delivered-pod-pending") {
    assert.equal(gates.deliveryReported, true, `${awb}: delivered report should be canonical`);
    assert.equal(gates.podReceived, false, `${awb}: signed POD is still pending`);
    assert.equal(gates.podPending, true, `${awb}: POD pending should be explicit after delivery`);
    assert.equal(plan.phase, "delivered-pod-pending", `${awb}: should resolve as delivered/POD pending`);
    return;
  }

  throw new Error(`${awb}: no verifier rule for truth phase ${phase}`);
}

(async () => {
  const hostedMode = process.argv.includes("--hosted");
  const requireFreshAudit = process.argv.includes("--require-fresh-audit");
  const memory = hostedMode ? await readHostedMemory() : await readLocalMemory(ROOT_DIR);
  const shipments = mergeShipments(memory);
  const byAwb = new Map(shipments.map((shipment) => [normalizeAwb(shipment.awb), shipment]));
  const actions = memory.actions || { actions: [], outboxRequests: [] };

  const failures = [];
  let staleAuditRows = 0;
  for (const row of audit.shipments || []) {
    try {
      const shipment = byAwb.get(normalizeAwb(row.awb));
      if (!shipment) {
        staleAuditRows += 1;
        if (requireFreshAudit) failures.push(`${row.awb}: missing from merged shipment memory`);
      } else if (auditExpectationIsStale(row, shipment)) {
        staleAuditRows += 1;
        assertNewerCanonicalState(row.awb, shipment, actions);
      } else {
        verifyLedgerRow(row, shipment, actions);
      }
    } catch (error) {
      failures.push(error.message || String(error));
    }
  }
  if (failures.length) {
    throw new Error(`Shipment truth ledger mismatches:\n- ${failures.join("\n- ")}`);
  }
  verifyPositiveArrivalBeatsRequestOnlyNoise();

  const status = staleAuditRows
    ? "stale-audit-secondary"
    : "fresh-audit-passed";
  if (requireFreshAudit && staleAuditRows) {
    throw new Error(
      `Shipment truth audit is stale (${staleAuditRows}/${audit.shipments.length} rows). ` +
      "Regenerate a fresh control-room inventory with npm run audit:control-room; this static file is secondary only.",
    );
  }

  console.log(JSON.stringify({
    ok: true,
    mode: hostedMode ? "hosted" : "local",
    status,
    checked: audit.shipments.length,
    staleAuditRows,
    requireFreshAudit,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

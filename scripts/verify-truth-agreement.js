#!/usr/bin/env node
"use strict";

// Pipeline-vs-reviewed-truth referee — full operator-truth scoring.
//
// The manual Gmail review fixture (data/manual-gmail-truth/current-awbs.json) is the referee,
// not the writer: this script reduces the PIPELINE's own evidence (gmail-proof-snapshot proofs)
// through the same reducers the product uses, then scores agreement across the dimensions an
// operator actually relies on — not phase alone. Advisory gate failures are never hidden under
// an "agreed" phase row.
//
// Scores: phaseAgreement, lifecycleAgreement, blockerAgreement, gateAgreement,
// relationAgreement, actionAgreement, terminalDurability, coverageAgreement, overallAgreement.
//
// Modes:
//   node scripts/verify-truth-agreement.js [--proof=PATH]        → report-only (exit 0)
//   node scripts/verify-truth-agreement.js --strict              → exit 1 when overall < threshold
//     (threshold: --min-agreement=0.9 or PQ_TRUTH_AGREEMENT_MIN, default 0.9)

const fs = require("node:fs");
const path = require("node:path");
const { _test } = require("../lib/gmail-direct-ingest");
const { buildOperatorTruthPacket } = require("../lib/operator-truth-packet");

const ROOT_DIR = path.resolve(__dirname, "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, "artifacts", "truth-agreement");
const KEY_GATES = ["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"];

function readJson(relativePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

function normalizeAwb(value) {
  return String(value || "").replace(/[^0-9]/g, "");
}

function phaseAliases(phase) {
  const value = String(phase || "").toLowerCase().trim();
  const aliases = {
    "pre-arrival": ["pre-arrival", "in-transit"],
    "driver-onsite": ["driver-onsite", "pickup-scheduled", "dispatch-ready"],
    "ready-for-pickup": ["ready-for-pickup", "dispatch-ready", "approval-needed", "broker-awarded", "broker-alerted"],
    "not-ready": ["not-ready", "release-needed", "fees-needed", "arrival-incomplete"],
    delivered: ["delivered", "delivered-pod-pending"],
  };
  return aliases[value] || [value];
}

function lifecycleFromDerived(state = {}) {
  const gates = state.gates || {};
  const status = (gate) => String(gates[gate]?.status || "").toLowerCase();
  // Exact status matching: \barrived\b substring-matched inside "not-arrived" (hyphen is a
  // word boundary), misreading in-transit rows as arrived — statuses are enums, not prose.
  const is = (gate, values) => values.includes(status(gate));
  if (is("delivery", ["delivered", "done", "completed"]) || is("pod", ["done", "received", "pod-found", "found"])) return "delivered";
  if (is("delivery", ["out-for-delivery"])) return "out_for_delivery";
  if (is("pickup", ["done", "picked-up", "loaded", "recovered"])) return "picked_up";
  if (is("pickup", ["scheduled", "onsite", "driver-onsite"])) return "pickup_scheduled";
  if (is("arrival", ["not-arrived"])) return "in_transit";
  if (is("arrival", ["done", "arrived", "true", "inferred"])) return "arrived";
  if (is("arrival", ["waiting", "pending", "unknown", "missing"])) return "in_transit";
  return "unknown";
}

function lifecycleCompatible(expected, derived) {
  if (!expected) return null;
  const value = String(expected).toLowerCase();
  const families = {
    in_transit: ["in_transit"],
    arrived: ["arrived", "pickup_scheduled"],
    pickup_scheduled: ["pickup_scheduled", "arrived"],
    picked_up: ["picked_up", "out_for_delivery"],
    out_for_delivery: ["out_for_delivery", "picked_up"],
    delivered: ["delivered"],
    unknown: ["unknown", "in_transit"],
  };
  return (families[value] || [value]).includes(derived);
}

function relationMatch(expectedNameOrEmail, derivedHaystack) {
  if (!expectedNameOrEmail) return null;
  const needle = String(expectedNameOrEmail).toLowerCase();
  const first = needle.split(/[\s,/]+/).filter((part) => part.length > 3)[0] || needle;
  return derivedHaystack.includes(first);
}

function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const minArg = args.find((arg) => arg.startsWith("--min-agreement="));
  const minAgreement = Number((minArg && minArg.split("=")[1]) || process.env.PQ_TRUTH_AGREEMENT_MIN || 0.9);
  const now = new Date();

  const fixture = readJson("data/manual-gmail-truth/current-awbs.json");
  const proofArg = args.find((arg) => arg.startsWith("--proof="));
  const proofPath = (proofArg && proofArg.split("=")[1]) || process.env.PQ_TRUTH_AGREEMENT_PROOF || "gmail-proof-snapshot.json";
  const proofSnapshot = proofPath.startsWith("/")
    ? JSON.parse(fs.readFileSync(proofPath, "utf8"))
    : readJson(proofPath, { proofs: [] });
  const proofsByAwb = new Map((proofSnapshot.proofs || []).map((proof) => [normalizeAwb(proof.awb), proof]).filter(([awb]) => awb));

  const activeFixtures = (fixture.shipments || []).filter((item) => String(item.expectedPhase || "").toLowerCase() !== "delivered");
  const terminalFixtures = (fixture.shipments || []).filter((item) => String(item.expectedPhase || "").toLowerCase() === "delivered");

  const rows = [];
  const tally = {
    phase: { ok: 0, total: 0 },
    lifecycle: { ok: 0, total: 0 },
    blocker: { ok: 0, total: 0 },
    gates: { ok: 0, total: 0 },
    relations: { ok: 0, total: 0 },
    actions: { ok: 0, total: 0 },
    coverage: { ok: 0, total: 0 },
    terminal: { ok: 0, total: 0 },
  };

  for (const expected of activeFixtures) {
    const awb = normalizeAwb(expected.awb);
    tally.coverage.total += 1;
    const proof = proofsByAwb.get(awb) || null;
    if (!proof) {
      rows.push({
        awb: expected.awb,
        verdict: "missing-proof",
        expectedPhase: expected.expectedPhase,
        derivedPhase: null,
        detail: "The pipeline produced no Gmail proof record for this reviewed active AWB (email-discovered active workstream not covered).",
      });
      continue;
    }
    tally.coverage.ok += 1;
    let derived = null;
    let derivedPhase = "";
    try {
      derived = _test.shipmentStateFromProof(proof, now);
      derivedPhase = String(derived?.phase || "").toLowerCase();
    } catch (error) {
      rows.push({ awb: expected.awb, verdict: "reduce-error", expectedPhase: expected.expectedPhase, derivedPhase: null, detail: `Reduce threw: ${error && error.message}` });
      continue;
    }

    const dims = {};
    tally.phase.total += 1;
    const phaseOk = phaseAliases(expected.expectedPhase).includes(derivedPhase);
    if (phaseOk) tally.phase.ok += 1;
    dims.phase = { ok: phaseOk, expected: expected.expectedPhase, derived: derivedPhase };

    if (expected.expectedPhysicalLifecycle) {
      tally.lifecycle.total += 1;
      const derivedLifecycle = lifecycleFromDerived(derived);
      const ok = lifecycleCompatible(expected.expectedPhysicalLifecycle, derivedLifecycle) === true;
      if (ok) tally.lifecycle.ok += 1;
      dims.lifecycle = { ok, expected: expected.expectedPhysicalLifecycle, derived: derivedLifecycle };
    }

    if (expected.expectedOperationalBlocker) {
      tally.blocker.total += 1;
      let derivedBlocker = "";
      try {
        // Doc-request fidelity: production derives documentRequestBlocker from the fact ledger.
        // Feed ONLY doc-lane request/resolution events (never dispatch/arrival noise, which
        // regressed blocker fidelity when the full event stream was fed).
        const docEvents = (derived.events || []).filter((event) =>
          (event.type === "exception" && ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "movement-split-offload"].includes(event.exceptionType)) ||
          event.type === "customs-release-received");
        const packet = buildOperatorTruthPacket({
          awb: expected.awb,
          stage: derivedPhase,
          opsState: { phase: derivedPhase, gates: derived.gates || {} },
          facts: docEvents,
          factLedger: docEvents,
        }, {});
        derivedBlocker = String(packet.operationalBlocker?.type || "").toLowerCase();
      } catch { derivedBlocker = "derivation-error"; }
      const ok = derivedBlocker === String(expected.expectedOperationalBlocker).toLowerCase();
      if (ok) tally.blocker.ok += 1;
      dims.blocker = { ok, expected: expected.expectedOperationalBlocker, derived: derivedBlocker };
    }

    const gateResults = [];
    for (const gateName of KEY_GATES) {
      const allowed = (expected.expectedGates || {})[gateName];
      if (!allowed) continue;
      tally.gates.total += 1;
      const status = String(derived?.gates?.[gateName]?.status || "");
      const ok = allowed.includes(status);
      if (ok) tally.gates.ok += 1;
      gateResults.push({ gate: gateName, ok, derived: status, allowed });
    }
    dims.gates = gateResults;

    const relationHaystack = JSON.stringify({
      dispatch: derived?.gates?.dispatch || {},
      freightBroker: derived?.freightBroker || proof.freightBroker || {},
      customsBroker: derived?.customsBroker || proof.customsBroker || {},
      summary: derived?.summary || "",
    }).toLowerCase();
    const expectedPickup = expected.expectedDispatch?.contactEmail || expected.expectedDispatch?.broker;
    if (expectedPickup) {
      tally.relations.total += 1;
      const ok = relationMatch(expectedPickup, relationHaystack) === true;
      if (ok) tally.relations.ok += 1;
      dims.pickupRelation = { ok, expected: expectedPickup };
    }
    const expectedCustoms = expected.expectedCustomsBroker?.contactEmail ||
      expected.expectedCustomsBroker?.broker ||
      (typeof expected.expectedCustomsBroker === "string" ? expected.expectedCustomsBroker : "");
    if (expectedCustoms) {
      tally.relations.total += 1;
      const ok = relationMatch(expectedCustoms, relationHaystack) === true;
      if (ok) tally.relations.ok += 1;
      dims.customsRelation = { ok, expected: expectedCustoms };
    }

    if ((expected.expectedNextActionTerms || []).length) {
      tally.actions.total += 1;
      const derivedAction = String(derived?.nextAction || "").toLowerCase();
      const ok = (expected.expectedNextActionTerms || []).some((term) => derivedAction.includes(String(term).toLowerCase()));
      if (ok) tally.actions.ok += 1;
      dims.action = { ok, derived: derived?.nextAction || "", terms: expected.expectedNextActionTerms };
    }
    if (expected.expectedActionThreadId || expected.expectedActionRecipient) {
      tally.actions.total += 1;
      const haystack = JSON.stringify(derived || {}).toLowerCase();
      const ok = [expected.expectedActionThreadId, expected.expectedActionRecipient]
        .filter(Boolean)
        .some((value) => haystack.includes(String(value).toLowerCase()));
      if (ok) tally.actions.ok += 1;
      dims.actionTarget = { ok, expectedThread: expected.expectedActionThreadId || null, expectedRecipient: expected.expectedActionRecipient || null };
    }

    const dimFailures = [
      !phaseOk && "phase",
      dims.lifecycle && !dims.lifecycle.ok && "lifecycle",
      dims.blocker && !dims.blocker.ok && "blocker",
      gateResults.some((gate) => !gate.ok) && "gates",
      dims.pickupRelation && !dims.pickupRelation.ok && "pickup-relation",
      dims.customsRelation && !dims.customsRelation.ok && "customs-relation",
      dims.action && !dims.action.ok && "action",
      dims.actionTarget && !dims.actionTarget.ok && "action-target",
    ].filter(Boolean);

    rows.push({
      awb: expected.awb,
      verdict: dimFailures.length ? "dimension-disagreement" : "agreed",
      failedDimensions: dimFailures,
      expectedPhase: expected.expectedPhase,
      derivedPhase,
      proofLatestEventAt: proof.latestEventAt || null,
      dims,
    });
  }

  for (const expected of terminalFixtures) {
    const awb = normalizeAwb(expected.awb);
    const proof = proofsByAwb.get(awb) || null;
    if (!proof) continue;
    tally.terminal.total += 1;
    let derivedPhase = "";
    try { derivedPhase = String(_test.shipmentStateFromProof(proof, now)?.phase || "").toLowerCase(); } catch { continue; }
    const terminalOk = !derivedPhase || ["delivered", "completed", "closed", "delivered-pod-pending"].includes(derivedPhase);
    if (terminalOk) tally.terminal.ok += 1;
    else {
      rows.push({
        awb: expected.awb,
        verdict: "resurrected-terminal",
        expectedPhase: "delivered",
        derivedPhase,
        detail: "Pipeline re-derives an ACTIVE phase for a shipment whose reviewed truth is terminal — terminal durability failure.",
      });
    }
  }

  const rate = (bucket) => (bucket.total ? Number((bucket.ok / bucket.total).toFixed(3)) : null);
  const scores = {
    phaseAgreement: rate(tally.phase),
    lifecycleAgreement: rate(tally.lifecycle),
    blockerAgreement: rate(tally.blocker),
    gateAgreement: rate(tally.gates),
    relationAgreement: rate(tally.relations),
    actionAgreement: rate(tally.actions),
    terminalDurability: rate(tally.terminal),
    coverageAgreement: rate(tally.coverage),
  };
  const available = Object.values(scores).filter((value) => value !== null);
  const overallAgreement = available.length ? Number((available.reduce((sum, value) => sum + value, 0) / available.length).toFixed(3)) : 0;
  const agreed = rows.filter((row) => row.verdict === "agreed").length;

  const report = {
    ok: !strict || overallAgreement >= minAgreement,
    mode: strict ? "strict" : "report-only",
    checkedAt: now.toISOString(),
    referee: "data/manual-gmail-truth/current-awbs.json",
    pipelineEvidence: proofPath,
    proofSnapshotTime: proofSnapshot.snapshotTime || null,
    activeReviewed: activeFixtures.length,
    terminalReviewed: terminalFixtures.length,
    agreed,
    ...scores,
    overallAgreement,
    // legacy consumers read agreementRate; keep it aligned with phase agreement
    agreementRate: scores.phaseAgreement ?? 0,
    minAgreement,
    rows,
  };

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined, artifact: "artifacts/truth-agreement/latest.json" }, null, 2));
  if (strict && overallAgreement < minAgreement) process.exit(1);
}

main();

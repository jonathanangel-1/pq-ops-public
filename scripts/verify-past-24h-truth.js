#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT_DIR = path.resolve(__dirname, "..");

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, fileName), "utf8"));
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function rowAwb(row) {
  return normalizeAwb(row?.awb || row?.id || row?.shipmentId || row?.normalizedAwb);
}

function gateStatus(row, gate) {
  return String(
    row.opsState?.gates?.[gate]?.status ||
      row.canonicalState?.gates?.[gate]?.status ||
      row.truthPacket?.gates?.find?.((item) => String(item.gate || "").toLowerCase() === gate)?.rawStatus ||
      row.truthPacket?.gates?.find?.((item) => String(item.gate || "").toLowerCase() === gate)?.status ||
      "",
  ).toLowerCase();
}

function rowText(row) {
  return JSON.stringify(row || {});
}

function timeMs(value = "") {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function assertCoverageDoesNotHideStaleProof(row, label) {
  const coverage = row.gmailCoverage || {};
  const latestReadAtMs = timeMs(coverage.latestReadMessageAt);
  const latestProofAtMs = timeMs(coverage.latestProofMessageAt);
  if (!latestReadAtMs || !latestProofAtMs || latestReadAtMs <= latestProofAtMs + 60 * 1000) return;
  assert.equal(
    coverage.problem,
    true,
    `${label} must not mark Gmail coverage clean when latestReadMessageAt is newer than latestProofMessageAt`,
    { coverage, row },
  );
}

function assertTerms(text, terms, message, details = {}) {
  for (const term of terms || []) {
    assert.match(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), message, details);
  }
}

function assertForbidden(text, terms, message, details = {}) {
  for (const term of terms || []) {
    assert.doesNotMatch(text, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), message, details);
  }
}

function expectedLegacyArrivalStatusFromLifecycle(lifecycle = "") {
  const status = String(lifecycle || "").toLowerCase();
  if (["closed", "delivered", "out_for_delivery", "picked_up", "pickup_scheduled", "arrived"].includes(status)) return "arrived";
  if (["in_transit", "pre_arrival", "not_arrived", "arrival_watch"].includes(status)) return "not-arrived";
  return "";
}

function assertExpectedTruthPacketDimensions(row = {}, expected = {}, label = "truth packet") {
  if (expected.expectedPhysicalLifecycle) {
    const actual = String(row.truthPacket?.physicalLifecycle?.status || "").toLowerCase();
    assert.equal(
      actual,
      String(expected.expectedPhysicalLifecycle).toLowerCase(),
      `${label} physical lifecycle must match the past-24h audit`,
      { expected: expected.expectedPhysicalLifecycle, actual, row, item: expected },
    );
    const expectedArrivalStatus = expectedLegacyArrivalStatusFromLifecycle(expected.expectedPhysicalLifecycle);
    if (expectedArrivalStatus) {
      assert.equal(
        String(row.arrivalStatus || "").toLowerCase(),
        expectedArrivalStatus,
        `${label} legacy arrivalStatus must agree with physical lifecycle`,
        { expected: expectedArrivalStatus, actual: row.arrivalStatus, row, item: expected },
      );
    }
  }
  if (expected.expectedOperationalBlocker) {
    const actual = String(row.truthPacket?.operationalBlocker?.type || "").toLowerCase();
    assert.equal(
      actual,
      String(expected.expectedOperationalBlocker).toLowerCase(),
      `${label} operational blocker must match the past-24h audit`,
      { expected: expected.expectedOperationalBlocker, actual, row, item: expected },
    );
  }
}

function main() {
  const audit = readJson("data/manual-gmail-truth/past-24h-state-changing-emails.json");
  const fixtures = readJson("data/manual-gmail-truth/current-awbs.json");
  const packets = readJson("shipment-truth-packets.json");
  const byAwb = new Map((packets.shipments || []).map((row) => [rowAwb(row), row]));
  const fixtureByAwb = new Map((fixtures.shipments || []).map((fixture) => [normalizeAwb(fixture.awb), fixture]));
  const activeAwbs = new Set((packets.activeAwbs || []).map(normalizeAwb));
  const completedAwbs = new Set((packets.completedAwbs || []).map(normalizeAwb));
  const reviewedAwbs = (audit.activeAwbsReviewedFromPacket || []).map(normalizeAwb).filter(Boolean);

  for (const awb of reviewedAwbs) {
    assert.ok(
      byAwb.has(awb) || activeAwbs.has(awb) || completedAwbs.has(awb),
      `${awb} from the reviewed active inventory must still be represented in active/completed canonical truth`,
      { awb },
    );
  }

  for (const item of audit.reviewedActiveRowsWithoutManualTerminalChange || []) {
    const awb = normalizeAwb(item.awb);
    const row = byAwb.get(awb);
    assert.ok(row, `${item.awb} reviewed active row must have a packet row`, { item });
    assert.equal(String(row.truthPacketRole || "active").toLowerCase(), "active", `${item.awb} must remain active because no reviewed terminal email closed it`, { row, item });
    assert.equal(activeAwbs.has(awb), true, `${item.awb} must remain in activeAwbs`, { activeAwbs: [...activeAwbs] });
    const actualPhase = String(row.opsState?.phase || row.stage || row.phase || "").toLowerCase();
    assert.equal(actualPhase, item.expectedPhase, `${item.awb} active packet phase must match the past-24h audit`, { expected: item.expectedPhase, actual: actualPhase, row, item });
    for (const [gateName, allowed] of Object.entries(item.expectedGates || {})) {
      const actualGate = gateStatus(row, gateName);
      assert.ok(
        (allowed || []).map((status) => String(status).toLowerCase()).includes(actualGate),
        `${item.awb} active packet gate ${gateName} must match the past-24h audit`,
        { expected: allowed, actual: actualGate, row, item },
      );
    }
    assertExpectedTruthPacketDimensions(row, item, `${item.awb} active packet`);
    const activeText = rowText(row);
    assertCoverageDoesNotHideStaleProof(row, item.awb);
    if (!item.latestReadMessageAt) {
      assert.notEqual(
        String(row.gmailCoverage?.status || "").toLowerCase(),
        "manual-review-stale-proof",
        `${item.awb} must not use the manual review timestamp as a fake newer Gmail message timestamp`,
        { row, item },
      );
    }
    assertTerms(activeText, item.requiredTerms || [], `${item.awb} active packet missing required past-24h audit term`, { row, item });
    assertForbidden(activeText, item.forbiddenTerms || [], `${item.awb} active packet leaked stale past-24h audit term`, { row, item });
  }

  for (const item of audit.decisiveStateChangingEmails || []) {
    const awb = normalizeAwb(item.awb);
    const fixture = fixtureByAwb.get(awb);
    assert.ok(fixture, `${item.awb} decisive email must have a current manual-truth fixture`, { item });
    assert.equal(fixture.expectedPhase, item.expectedPhase, `${item.awb} fixture phase must match past-24h decisive email`, { fixture, item });
    const row = byAwb.get(awb);
    assert.ok(row, `${item.awb} decisive email must produce a canonical packet row`, { item });
    assert.equal(String(row.truthPacketRole || "").toLowerCase(), item.expectedPacketRole, `${item.awb} decisive email must set the expected packet role`, { row, item });
    assert.equal(activeAwbs.has(awb), false, `${item.awb} decisive terminal email must remove the AWB from activeAwbs`, { row, item });
    assert.equal(completedAwbs.has(awb), true, `${item.awb} decisive terminal email must add the AWB to completedAwbs`, { row, item });
    assert.equal(String(row.opsState?.phase || row.stage || row.phase || "").toLowerCase(), item.expectedPhase, `${item.awb} packet phase must match decisive email`, { row, item });
    assert.ok(["delivered", "done"].includes(gateStatus(row, "delivery")), `${item.awb} delivery gate must be delivered/done`, { row, item });
    assert.ok(["received", "done", "pod-found", "found"].includes(gateStatus(row, "pod")), `${item.awb} POD gate must be received/done`, { row, item });
    const text = rowText(row);
    assertTerms(text, item.requiredTerms || [], `${item.awb} completed packet missing required decisive-email term`, { row, item });
    assertForbidden(text, item.forbiddenTerms || [], `${item.awb} completed packet leaked stale active-work term`, { row, item });
    for (const email of item.emails || []) {
      assert.match(text, new RegExp(email.messageId), `${item.awb} completed packet must cite decisive Gmail message ${email.messageId}`, { row, item, email });
      assert.match(text, new RegExp(email.threadId), `${item.awb} completed packet must cite decisive Gmail thread ${email.threadId}`, { row, item, email });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    checked: {
      reviewedActiveInventory: reviewedAwbs.length,
      reviewedActiveWithoutTerminalChange: (audit.reviewedActiveRowsWithoutManualTerminalChange || []).length,
      decisiveStateChangingEmails: (audit.decisiveStateChangingEmails || []).length,
      packetShipments: (packets.shipments || []).length,
      activeAwbs: activeAwbs.size,
      completedAwbs: completedAwbs.size,
    },
  }, null, 2));
}

main();

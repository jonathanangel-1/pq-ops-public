#!/usr/bin/env node
"use strict";

// Alert cadence verifier: interrupt once, then follow the schedule — never a
// toast per refresh.

const { nextAlertState, acknowledgeAlert, cadenceLabel } = require("../lib/alert-cadence");
const { assessShipmentSeverity } = require("../lib/urgent-interrupts");

let checks = 0;
function ok(condition, label) {
  checks += 1;
  if (!condition) {
    console.error(`FAIL - ${label}`);
    process.exit(1);
  }
  console.log(`ok - ${label}`);
}

const T0 = "2026-07-04T12:00:00.000Z";
const plus = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString();
const issue = (over = {}) => ({ id: "ui:1:driver-stuck:fees", kind: "driver-stuck", cause: "fees", message: "driver on site, fees due", resolved: false, ...over });

// 1. First critical event alerts immediately.
const first = nextAlertState(issue(), null, T0);
ok(first.shouldToast === true && first.alertCount === 1 && first.firstSeenAt === T0,
  "cadence: first event toasts immediately");

// 2. Same event on the next refresh does NOT alert again.
const refresh = nextAlertState(issue(), first, plus(2));
ok(refresh.shouldToast === false && refresh.alertCount === 1,
  "cadence: the same event 2m later does not toast again");

// 3. Reminder fires after the configured interval.
const reminder = nextAlertState(issue(), first, plus(31));
ok(reminder.shouldToast === true && reminder.alertCount === 2,
  "cadence: unresolved event reminds after the reminder interval");

// 4. After the escalation threshold: wording escalates, pinned, no more toasts.
const escalated = nextAlertState(issue(), reminder, plus(65));
ok(escalated.escalationLevel >= 1 && escalated.pinned === true,
  "cadence: still unresolved escalates and stays pinned");
const postEscalation = nextAlertState(issue(), { ...escalated, nextAlertAt: plus(66) }, plus(120));
ok(postEscalation.shouldToast === false && postEscalation.pinned === true,
  "cadence: after escalation it stays pinned but stops repeating toasts (El Paso rule)");

// 5. A material change re-alerts even after escalation.
const changed = nextAlertState(issue({ message: "driver left; station now says cargo is missing", cause: "cargo-unavailable" }), escalated, plus(130));
ok(changed.shouldToast === true && changed.escalationLevel === 0,
  "cadence: a materially different fact re-alerts");

// 6. Acknowledge suppresses toasts until nextAlertAt.
const acked = acknowledgeAlert(first, plus(3));
const suppressed = nextAlertState(issue(), acked, plus(20));
ok(suppressed.shouldToast === false, "cadence: acknowledged issue stays quiet before nextAlertAt");
const ackExpired = nextAlertState(issue(), acked, plus(40));
ok(ackExpired.shouldToast === true, "cadence: reminders resume after the acknowledged window passes");

// 7. Resolution clears the schedule.
const resolved = nextAlertState(issue({ resolved: true }), reminder, plus(45));
ok(resolved.shouldToast === false && resolved.nextAlertAt === "" && Boolean(resolved.resolvedAt),
  "cadence: resolution clears all future alerts");

// 8. Waiting-on-outside-party issues don't re-alert before the SLA.
const waitingBefore = nextAlertState(issue({ waitingOnExternal: true }), first, plus(40));
ok(waitingBefore.shouldToast === false, "cadence: waiting-on-external stays quiet before the SLA");
const waitingAfter = nextAlertState(issue({ waitingOnExternal: true }), { ...first, nextAlertAt: plus(30) }, plus(125));
ok(waitingAfter.shouldToast === true, "cadence: waiting-on-external re-alerts once the SLA expires");

// 9. Plain-language age line.
ok(/Open 31m/.test(cadenceLabel(reminder, plus(31))) || /Open /.test(cadenceLabel(reminder, plus(31))),
  `cadence: label shows plain age (got "${cadenceLabel(reminder, plus(31))}")`);
ok(/^Escalated · waiting /.test(cadenceLabel(escalated, plus(70))),
  `cadence: escalated label reads "Escalated · waiting …" (got "${cadenceLabel(escalated, plus(70))}")`);

// ---------------------------------------------------------------------------
// Severity model spot checks.
// ---------------------------------------------------------------------------
const fact = (id, claim, at) => ({ id, type: "gmail-proof", claim, observedAt: at, at, sourceSystem: "gmail" });
const critical = assessShipmentSeverity({
  awb: "016-1", evidencePacket: { sourceFacts: [fact("f1", "Driver is on site but cannot pick up because fees are due.", T0)] },
  truthPacket: { resolvedCurrentState: "ready_for_pickup", operationalBlocker: { type: "none" }, contradictions: [] },
}, { now: T0 });
ok(critical.level === "critical" && critical.interrupt, `severity: driver-stuck is critical (got ${critical.level})`);

const quiet = assessShipmentSeverity({
  awb: "016-2", evidencePacket: { sourceFacts: [] },
  operatorAgency: { agency: "not_import_scope_yet", countsAsWork: false, reason: "Export-side delay." },
  truthPacket: { resolvedCurrentState: "in_transit", operationalBlocker: { type: "movement_split" } },
}, { now: T0 });
ok(quiet.level === "quiet", `severity: export-side delay is quiet, never an interrupt (got ${quiet.level})`);

const high = assessShipmentSeverity({
  awb: "016-3", evidencePacket: { sourceFacts: [] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "arrived_not_available", operationalBlocker: { type: "customs_hold" }, feeLedger: {}, gates: [], contradictions: [] },
}, { now: T0 });
ok(high.level === "high", `severity: arrived + hard blocker (no LFD burn) is high, not screaming (got ${high.level})`);

const criticalLfd = assessShipmentSeverity({
  awb: "016-4", evidencePacket: { sourceFacts: [fact("f4", "Storage has started; last free day passed yesterday.", T0)] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "customs_hold", operationalBlocker: { type: "customs_hold" }, feeLedger: {}, gates: [], contradictions: [] },
}, { now: T0 });
ok(criticalLfd.level === "critical", `severity: arrived + hard blocker + LFD burning is critical (got ${criticalLfd.level})`);

const eta = assessShipmentSeverity({
  awb: "016-5", eta: plus(10 * 60),
  evidencePacket: { sourceFacts: [fact("f5", "Departed TLV on LY007.", T0)] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "in_transit", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(eta.level === "high", `severity: arriving within 24h without release/pickup path is high (got ${eta.level})`);

// ---------------------------------------------------------------------------
// Severity recency/supersession (live anchor 016-80000156: an aged
// wrong-consignee mention must not keep a picked-up shipment critical).
// ---------------------------------------------------------------------------
const daysAgo = (days) => new Date(Date.parse(T0) - days * 24 * 3600000).toISOString();

// Anchor: old failed-delivery mention + later pickup fact + picked_up state.
const anchor281 = assessShipmentSeverity({
  awb: "016-80000156",
  evidencePacket: { sourceFacts: [
    fact("f-old", "Wrong consignee delivery reported by the station; receiver refused the freight.", daysAgo(3)),
    fact("f-newer", "Driver picked up the cargo; loaded and on the way.", daysAgo(1)),
  ] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "picked_up", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(anchor281.level !== "critical",
  `recency: 016-80000156 anchor — aged, superseded failed-delivery mention is not critical (got ${anchor281.level})`);

// Old failed-delivery superseded by a delivery update (still recent) = not critical.
const supersededDelivery = assessShipmentSeverity({
  awb: "016-6",
  evidencePacket: { sourceFacts: [
    fact("f-fail", "Delivery failed — receiver closed.", plus(-300)),
    fact("f-fix", "Re-delivered this morning; POD received.", plus(-60)),
  ] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "out_for_delivery", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(supersededDelivery.level !== "critical",
  `supersession: failed delivery followed by a delivery/POD update is not critical (got ${supersededDelivery.level})`);

// Unresolved, recent wrong delivery = still critical.
const unresolvedWrong = assessShipmentSeverity({
  awb: "016-7",
  evidencePacket: { sourceFacts: [fact("f-wrong", "Cargo was delivered by mistake to the wrong consignee.", plus(-120))] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "out_for_delivery", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(unresolvedWrong.level === "critical",
  `unresolved: a recent wrong delivery with no later resolution stays critical (got ${unresolvedWrong.level})`);

// A stale (out-of-window) failed-delivery mention alone never drives severity.
const staleMention = assessShipmentSeverity({
  awb: "016-8",
  evidencePacket: { sourceFacts: [fact("f-stale", "Delivery refused by receiver.", daysAgo(5))] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "ready_for_pickup", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(staleMention.level !== "critical",
  `recency window: a ${5}-day-old mention alone never drives critical (got ${staleMention.level})`);

// An operator record supersedes the signal too.
const operatorSuperseded = assessShipmentSeverity({
  awb: "016-9",
  evidencePacket: { sourceFacts: [
    fact("f-fail2", "Failed delivery — facility closed.", plus(-200)),
    { id: "f-op", type: "operator_record", operatorEvent: "delivered", claim: "Operator record: delivered.", observedAt: plus(-30), at: plus(-30) },
  ] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "out_for_delivery", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(operatorSuperseded.level !== "critical",
  `supersession: an operator record (delivered) supersedes the failed-delivery signal (got ${operatorSuperseded.level})`);

// Old storage warning after delivery/POD = quiet history.
const storageAfterDelivery = assessShipmentSeverity({
  awb: "016-10",
  evidencePacket: { sourceFacts: [fact("f-storage", "Storage has started; last free day passed.", daysAgo(4))] },
  operatorAgency: { agency: "monitor_only", countsAsWork: false, reason: "Delivered and closed — history only." },
  truthPacket: { resolvedCurrentState: "delivered", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(storageAfterDelivery.level === "quiet",
  `history: an old storage warning after delivery stays quiet (got ${storageAfterDelivery.level})`);

// Pickup confirmed after a failed-pickup/driver-stuck message = resolved.
const stuckThenPicked = assessShipmentSeverity({
  awb: "016-12",
  evidencePacket: { sourceFacts: [
    fact("f-stuck2", "Driver on site but cannot pick up — no release in the system.", plus(-90)),
    fact("f-picked", "Pickup confirmed — driver loaded and gone.", plus(-20)),
  ] },
  operatorAgency: { agency: "actionable_by_us_now", countsAsWork: true },
  truthPacket: { resolvedCurrentState: "picked_up", operationalBlocker: { type: "none" }, gates: [], contradictions: [] },
}, { now: T0 });
ok(stuckThenPicked.level !== "critical" && !stuckThenPicked.interrupt,
  `resolution: pickup confirmation after a failed-pickup message clears critical (got ${stuckThenPicked.level})`);

// Fresh driver-stuck message remains critical (control).
const freshStuck = assessShipmentSeverity({
  awb: "016-11",
  evidencePacket: { sourceFacts: [fact("f-stuck", "Driver is on site but cannot pick up because fees are due.", plus(-5))] },
  truthPacket: { resolvedCurrentState: "ready_for_pickup", operationalBlocker: { type: "none" }, contradictions: [] },
}, { now: T0 });
ok(freshStuck.level === "critical" && Boolean(freshStuck.interrupt),
  `control: a fresh driver-stuck message is still critical (got ${freshStuck.level})`);

console.log(JSON.stringify({ ok: true, checks }, null, 0));

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..");
const MIN_AUDITED_SHIPMENTS = 15;

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...details }, null, 2));
  process.exit(1);
}

function assert(condition, message, details = {}) {
  if (!condition) fail(message, details);
}

function readJson(fileName, fallback = {}) {
  const filePath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonLines(fileName) {
  const filePath = path.join(ROOT_DIR, fileName);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").trim();
  return content ? content.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function evidenceText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (Array.isArray(item)) return item.map(evidenceText).filter(Boolean).join(" ");
  if (typeof item !== "object") return String(item);
  return [
    item.label,
    item.note,
    item.summary,
    item.detail,
    item.status,
    item.source,
    item.threadId,
    evidenceText(item.evidence),
  ].filter(Boolean).join(" ");
}

function currentOperatorRows(shipment) {
  return [
    ["detail", shipment.detail],
    ["email.summary", shipment.emailValidation?.summary],
    ["email.nextAction", shipment.emailValidation?.nextAction],
    ["ops.phase", shipment.opsState?.phase],
    ["ops.summary", shipment.opsState?.summary],
    ["ops.nextAction", shipment.opsState?.nextAction],
    ...(shipment.opsState?.evidence || []).map((item) => [
      `ops.evidence.${item.source || item.label || "unknown"}`,
      `${item.status || ""} ${item.note || ""}`,
    ]),
    ...(shipment.opsState?.blockers || []).map((blocker) => ["ops.blocker", blocker]),
    ...(shipment.recommendedActions || []).flatMap((action) => [
      [`action.${action.type}.reason`, action.reason],
      [`action.${action.type}.body`, action.body],
      [`action.${action.type}.evidence`, (action.evidence || []).join(" | ")],
    ]),
    ...(shipment.operationalMemory?.pod?.evidence || []).map((text) => ["memory.pod", text]),
    ...(shipment.operationalMemory?.money?.evidence || []).map((text) => ["memory.money", text]),
  ].filter(([, value]) => value);
}

function allShipmentRows(shipment) {
  return [
    ...currentOperatorRows(shipment),
    ...(shipment.emailValidation?.proof || []).map((item) => ["email.proof", evidenceText(item)]),
    ...(shipment.customsBroker?.evidence || []).map((item) => ["customs.evidence", evidenceText(item)]),
    ...(shipment.freightBroker?.evidence || []).map((item) => ["freight.evidence", evidenceText(item)]),
    ...(shipment.eodFacts || []).map((item) => ["eod.fact", evidenceText(item)]),
    ...(shipment.factLedger || []).map((item) => ["factLedger", evidenceText(item)]),
  ].filter(([, value]) => value);
}

function isCustomsResolved(shipment) {
  const clearance = String(shipment.clearanceStatus || "").trim().toLowerCase();
  if (clearance === "not-cleared" || clearance === "not cleared" || clearance === "hold") return false;
  return ["released", "cleared"].includes(clearance) ||
    /\b(customs[-\s]?(cleared|released)|released[-\s]?do|release[-\s]?do|do[-\s]?received|98[-\s]?released)\b/i.test(
      shipment.customsBroker?.status || "",
    );
}

function isCustomsHold(shipment) {
  return /\b(hold|exam|examination)\b/i.test(`${shipment.clearanceStatus || ""} ${shipment.customsBroker?.status || ""}`);
}

function positiveCustomsProof(text) {
  const value = String(text || "");
  if (/\b(no|not|missing|pending|awaiting|without|needed|need|find|not proven|not included|not received|status)\b.{0,80}\b(release proof|customs proof|customs release|release\/?d\.?o\.?|delivery order|d\.?\s*\/\s*o\.?|d\.o\.?|clearance)\b|\b(release proof|customs proof|customs release|release\/?d\.?o\.?|delivery order|d\.?\s*\/\s*o\.?|d\.o\.?|clearance)\b.{0,80}\b(no|not|missing|pending|awaiting|without|needed|need|find|not proven|not included|not received|status)\b/i.test(value)) {
    return false;
  }
  return (
    /\b(98\s+RELEASED|disposition\s+98|customs (?:is )?(?:released|cleared)|custom cleared|customs\s*rel|ACE cargo release|release attached|attached release|release PDF|CBP release)\b/i.test(value) ||
    /\brelease\/?d\.?o\.?\s+(?:is\s+)?confirmed\b|\brelease\/?d\.?o\.?\b.{0,80}\b(received|attached|preserved|present)\b|\b(received|attached|preserved|present)\b.{0,80}\brelease\/?d\.?o\.?\b/i.test(value) ||
    /\b(delivery order|d\.?\s*\/\s*o\.?|d\.o\.?)\b.{0,80}\b(issued|attached|received|sent|provided)\b/i.test(value) ||
    /\b(issued|attached|received|sent|provided)\b.{0,80}\b(delivery order|d\.?\s*\/\s*o\.?|d\.o\.?)\b/i.test(value)
  );
}

function staleCustomsGap(text) {
  const value = String(text || "").replace(/\bPOD\b.{0,50}\b(?:pending|needed|missing|not found|not received)\b/gi, "POD_OPEN");
  const nonCustomsOperationalRelease =
    /\b(?:freight|station|terminal|warehouse|isc|payment|pickup|availability)\b.{0,50}\brelease\b|\brelease\b.{0,50}\b(?:freight|station|terminal|warehouse|isc|payment|pickup|availability)\b/i.test(value) &&
    !/\b(customs|d\.?\/?o\.?|delivery order|clearance|release proof|customs proof)\b/i.test(value);
  if (nonCustomsOperationalRelease) return false;
  if (/after (?:station )?availability\/release|after availability and customs release|release\/DO is confirmed|customs release\/DO is confirmed/i.test(value)) {
    return false;
  }
  if (/\b(?:release\/?d\.?o\.?|delivery order|d\.?\s*\/\s*o\.?|d\.o\.?|clearance)\b.{0,80}\b(?:no longer unknown|not unknown|is no longer missing)\b/i.test(value)) {
    return false;
  }
  if (/\bnot because\b.{0,80}\b(customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b.{0,80}\b(missing|pending|needed|not proven)\b/i.test(value)) {
    return false;
  }
  if (/\bdo not keep (?:pushing|chasing)\b.{0,80}\b(customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b/i.test(value)) {
    return false;
  }
  if (
    /\bfees needed\b/i.test(value) &&
    (
      /\b(?:forwarded|sent|provided|attached)\b.{0,120}\b(?:customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b/i.test(value) ||
      /\b(?:customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b.{0,120}\bpackage\b/i.test(value)
    )
  ) {
    return false;
  }
  if (
    /\b(?:forwarded|sent|provided|attached)\b.{0,100}\b(?:customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b|\b(?:customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b.{0,100}\b(?:package|forwarded|sent|provided|attached)\b/i.test(value) &&
    !/\b(?:no|not|missing|pending|awaiting|waiting|without|needed|need|find|not proven|not included|not received)\b.{0,50}\b(?:customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b/i.test(value)
  ) {
    return false;
  }
  return /\b(no|not|missing|pending|awaiting|without|needed|need|find|not proven|not included|not received)\b.{0,80}\b(customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b|\b(customs release|release\/?DO|release proof|customs proof|d\.?\s*\/\s*o\.?|d\.o\.?|delivery order|clearance)\b.{0,80}\b(no|not|missing|pending|awaiting|without|needed|need|find|not proven|not included|not received)\b/i.test(value);
}

function stationPaymentOnly(text) {
  return /\b(?:payment|receipt|station charge|terminal fee|CargoSprint|Choice Guest Payments)\b.{0,120}\b(?:delivered|paid|payment)\b/i.test(
    String(text || ""),
  );
}

function finalDeliveryOrPodProof(text) {
  const value = String(text || "");
  if (
    /\bno\s+(?:final\s+)?(?:pickup\s+completion|pickup\s+completion\s+or\s+pod|delivery\s+completion|delivery\s+completion\s+or\s+pod|pod|delivery|closeout)\b/i.test(value) ||
    /\bno\b.{0,90}\b(?:pickup|delivery|pod|proof of delivery)\b.{0,40}\b(?:found|received|confirmed|complete|completed|attached)\b/i.test(value) ||
    /\b(?:payment|receipt|station charge|terminal fee|CargoSprint|release|d\.?\/?o\.?|delivery order|documents?)\b.{0,80}\bdelivered\s+to\s+(?:united|airline|cargo|station|warehouse|wfs|swissport|choice|prosegur)\b/i.test(value) ||
    /\b(?:delivered|delivery)\s+(?:address|to:)\b/i.test(value) ||
    /\bnot\s+(?:pickup|delivery|pod)\s+proof\b/i.test(value)
  ) {
    return false;
  }
  if (/\b(?:signed\s+)?POD\b.{0,100}\b(?:will follow|to follow|expected|pending|not yet|will be sent)\b/i.test(value)) {
    return false;
  }
  if (/\b(?:POD|delivery|closeout)\b.{0,80}\b(?:missing|needed|requested|pending|not found|not received)\b/i.test(value)) {
    return false;
  }
  return (
    /\b(POD|proof of delivery)\b.{0,60}\b(attached|received|sent|provided|uploaded|found)\b/i.test(value) ||
    /\b(delivery completed|delivered successfully|successfully delivered|final delivery confirmed)\b/i.test(value) ||
    /\b(?:delivered|delivery completed)\s+to\s+[A-Z][A-Za-z .'-]{1,60}\b.{0,80}\b(?:\d{1,2}:\d{2}|20\d{2}|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(value) ||
    /\b(signed|received)\s+by\s+[A-Z][A-Za-z.'-]+/i.test(value)
  );
}

function pickupCompletionProof(text) {
  const value = String(text || "");
  if (/\b(?:customs\s+)?broker identity recovered\b|\bidentity recovered from gmail customs evidence\b/i.test(value)) {
    return false;
  }
  if (/\b(?:carrier|tracking|cargo)\s+page\s+(?:loaded|opened)\b/i.test(value)) {
    return false;
  }
  if (
    /\b(?:claim(?:s|ed)?|said|says|told)\b[^.;\n]{0,140}\b(?:driver|someone|they|carrier)\b[^.;\n]{0,100}\b(?:picked up|recovered|took|loaded)\b/i.test(value) &&
    /\b(?:driver did not pick|did not pick up|didn'?t pick up|not picked up|can'?t locate|cannot locate|cant locate|not locate|cannot find|not found)\b/i.test(value)
  ) {
    return false;
  }
  const completionCore = /\b(?:picked\s+up|loaded|pickup\s+(?:completed|complete|confirmed)|recovery\s+(?:completed|complete|confirmed))\b/i.test(value) ||
    /\brecovered\b(?!\s+from\s+(?:gmail|email|evidence|customs|memory)|\s+(?:customs\s+)?broker\s+identity)/i.test(value);
  if (!completionCore && /\b(?:ready|available|earliest|scheduled|pending|confirm|confirmation|quote)\b.{0,80}\bpickup\b|\bpickup\b.{0,80}\b(?:ready|available|earliest|scheduled|pending|confirm|confirmation|quote)\b/i.test(value)) {
    return false;
  }
  if (
    /\bno\s+(?:final\s+)?(?:pickup\s+completion|pickup\s+confirmation|pickup\s+completion\s+or\s+pod)\b/i.test(value) ||
    /\bpickup\s+(?:is\s+)?(?:pending|requested|scheduled|not\s+(?:complete|completed|confirmed|done|found))\b/i.test(value) ||
    /\b(?:must|needs?\s+to|should|has\s+to)\s+be\s+(?:recovered|picked\s+up)\b/i.test(value) ||
    /\b(?:can|could|will|would|may|schedule|scheduled|asked|asking|request|requested|confirm|checking|waiting|awaiting)\b.{0,80}\bpicked\s+up\b/i.test(value) ||
    /\b(?:can|could|will|would|may|schedule|scheduled|asked|asking|request|requested|confirm|checking|waiting|awaiting)\b.{0,80}\brecovered\b/i.test(value) ||
    /\b(driver|broker|carrier)\b.{0,80}\b(waiting|onsite|checking|scheduled|appointment|will|can|requested|confirming)\b/i.test(value) ||
    /\b(?:driver\s+standby|standby\s+driver|not\s+loaded\s+yet|no\s+loaded|loading\s+pending)\b/i.test(value) ||
    /\b(?:pickup|recovery|loading|loaded|delivery|pod)[-\s]+pending\b/i.test(value) ||
    /\bpending\b.{0,60}\b(?:pickup|recovery|loading|loaded|delivery|pod)\b/i.test(value) ||
    /\b(?:dispatch|dispatched)\b.{0,80}\b(?:loading|pickup|recovery)\s+pending\b/i.test(value) ||
    /\b(?:will|should|can|please)\b.{0,80}\bfollow up\b.{0,80}\bonce\b.{0,40}\bdriver\b.{0,40}\bloaded\b/i.test(value) ||
    /\bonce\b.{0,40}\bdriver\b.{0,40}\bloaded\b/i.test(value) ||
    /\bafter\b.{0,40}\b(?:he|she|driver|truck|carrier)\b.{0,40}\b(?:is\s+)?loaded\b/i.test(value) ||
    /\bnot\s+final\s+(?:delivery|pickup|pod)\b/i.test(value) ||
    /\bnot\s+pickup\s+proof\b/i.test(value)
  ) {
    return false;
  }
  return /\b(?:pickup|recovery)\s+(?:completed|complete|confirmed)\b/i.test(value) ||
    /\b(?:was|has\s+been|is|got)\s+(?:picked\s+up|recovered)\b/i.test(value) ||
    /\b(?:picked\s+up|loaded\s+out)\s+(?:from|at|by)\b/i.test(value) ||
    /\brecovered\s+(?:from|at|by)\b(?!\s+(?:gmail|email|evidence|customs|memory)\b)/i.test(value) ||
    /\b(?:driver|truck|carrier|broker)\b.{0,60}\b(?:is\s+)?(?:loaded|loaded\s+out|recovered|picked\s+up)\b/i.test(value);
}

function matchingStorageFact(shipment) {
  const storage = shipment.operationalMemory?.storage;
  if (!storage || storage.status !== "known") return true;
  const currentAwb = normalizeAwb(shipment.awb);
  const sourceAwb = normalizeAwb(storage.sourceAwb);
  const evidence = (storage.evidence || []).join(" ");
  const mentionedAwbs = [...evidence.matchAll(/\b\d{3}[- ]?\d{8}\b/g)].map((match) => normalizeAwb(match[0]));
  if (sourceAwb && sourceAwb !== currentAwb) return false;
  return !mentionedAwbs.length || mentionedAwbs.includes(currentAwb);
}

function audit() {
  const active = (readJson("shipment-truth-packets.json", { shipments: [] }).shipments || [])
    .filter((shipment) => !shipment.truthPacketRole || shipment.truthPacketRole === "active");
  const completed = readJsonLines("completed-shipments.jsonl");
  const gmailProofs = readJson("gmail-proof-snapshot.json", { proofs: [] }).proofs || [];
  const issues = [];
  const audited = active.filter((shipment) =>
    shipment.emailValidation?.status && shipment.emailValidation.status !== "email-missing"
  );
  const rawAuditedProofs = gmailProofs.filter((proof) =>
    normalizeAwb(proof.awb) &&
      ((proof.proof || []).length || (proof.events || []).length || proof.emailValidation?.summary)
  );
  const activeAwbs = new Set(active.map((shipment) => normalizeAwb(shipment.awb)).filter(Boolean));
  const rawActiveProofAwbs = new Set(
    rawAuditedProofs
      .map((proof) => normalizeAwb(proof.awb))
      .filter((awb) => awb && activeAwbs.has(awb)),
  );

  for (const shipment of active) {
    const awb = normalizeAwb(shipment.awb);
    if (rawActiveProofAwbs.has(awb) && (!shipment.emailValidation?.status || shipment.emailValidation.status === "email-missing")) {
      issues.push({
        awb: shipment.awb,
        type: "raw-gmail-proof-not-projected",
        emailValidation: shipment.emailValidation,
      });
    }
    const resolved = isCustomsResolved(shipment);
    const rows = allShipmentRows(shipment);
    const currentRows = currentOperatorRows(shipment);

    for (const [kind, value] of currentRows) {
      if (/\[object Object\]/.test(String(value))) {
        issues.push({ awb: shipment.awb, type: "object-string-leak", kind, sample: String(value).slice(0, 240) });
      }
      if (resolved && staleCustomsGap(value) && !positiveCustomsProof(value)) {
        issues.push({ awb: shipment.awb, type: "resolved-customs-current-gap", kind, sample: String(value).slice(0, 240) });
      }
      if (!resolved && !isCustomsHold(shipment) && !/^ops\.evidence\.tms$/.test(kind) && positiveCustomsProof(value)) {
        issues.push({
          awb: shipment.awb,
          type: "customs-proof-not-reflected",
          kind,
          customsStatus: shipment.customsBroker?.status,
          sample: String(value).slice(0, 240),
        });
      }
    }

    if (rows.some(([, value]) => pickupCompletionProof(value)) && !["airport-picked-up", "picked up", "done", "delivered"].includes(shipment.pickupStatus)) {
      issues.push({
        awb: shipment.awb,
        type: "pickup-proof-not-reflected",
        pickupStatus: shipment.pickupStatus,
        freightStatus: shipment.freightBroker?.status,
      });
    }

    const terminalDeliveryPhase = ["completed", "delivered"].includes(shipment.opsState?.phase);
    if (currentRows.some(([, value]) => finalDeliveryOrPodProof(value)) && !terminalDeliveryPhase) {
      const podPending = /\b(?:signed\s+)?POD\b.{0,100}\b(?:will follow|to follow|expected|pending|will be sent)\b/i.test(
        currentRows.map(([, value]) => value).join(" "),
      );
      if (!podPending) {
        issues.push({
          awb: shipment.awb,
          type: "delivery-proof-still-active",
          phase: shipment.opsState?.phase,
          podStatus: shipment.operationalMemory?.pod?.status,
        });
      }
    }

    if (!matchingStorageFact(shipment)) {
      issues.push({
        awb: shipment.awb,
        type: "storage-awb-contamination",
        storage: shipment.operationalMemory?.storage,
      });
    }
  }

  for (const shipment of completed) {
    if (shipment.podStatus === "pod-found") continue;
    const text = JSON.stringify(shipment);
    const hasFinalProof = finalDeliveryOrPodProof(text);
    const paymentOnly = stationPaymentOnly(text) && !finalDeliveryOrPodProof(text);
    const negativePod = /\b(?:no|not|missing|pending|awaiting|without|needed|need|requested)\b.{0,80}\b(POD|delivery|proof of delivery|closeout)\b/i.test(text);
    if ((paymentOnly || (negativePod && !hasFinalProof)) && !/signed-pod-pending|detention-pending/i.test(`${shipment.podStatus || ""} ${shipment.closeoutStatus || ""}`)) {
      issues.push({
        awb: shipment.awb,
        type: "completed-record-with-open-proof",
        podStatus: shipment.podStatus,
        closeoutStatus: shipment.closeoutStatus,
      });
    }
  }

  assert(rawAuditedProofs.length >= MIN_AUDITED_SHIPMENTS, "Stored Gmail snapshot audit must cover at least 15 shipments", {
    auditedShipments: audited.length,
    rawAuditedProofs: rawAuditedProofs.length,
    minimum: MIN_AUDITED_SHIPMENTS,
  });
  assert(!issues.length, "Email contamination audit found layer contradictions", { issues });

  return {
    ok: true,
    auditedShipments: audited.length,
    rawAuditedProofs: rawAuditedProofs.length,
    activeShipments: active.length,
    completedShipments: completed.length,
    checks: [
      "resolved customs has no current missing-release text",
      "customs proof is reflected unless a hold overrides it",
      "pickup proof advances pickup state",
      "delivery/POD proof does not remain active",
      "station payment alone cannot close POD",
      "storage dates stay scoped to the current AWB",
      "no raw object stringification leaks",
    ],
  };
}

console.log(JSON.stringify(audit(), null, 2));

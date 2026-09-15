"use strict";

const { normalizeAwb } = require("./awb");
const { classifyOperatorAgency } = require("./operator-agency");
const { deliveryWaitFromFacts, deliveryWaitMessage, waitingCostMatch } = require("./delivery-wait");
const { hasExternalSourceCoordinates, sourceFactEligible } = require("./source-fact-contract");

const GATE_NAMES = ["arrival", "customs", "fees", "dispatch", "pickup", "delivery", "pod"];
const SOURCE_FACT_LIMIT = 40;
const TERMINAL_NO_ACTION = "No action; POD is in memory.";
const DELIVERY_RECOVERY_ACTION = "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  const seen = new Set();
  return (values || []).filter((value) => {
    const key = clean(typeof value === "string" ? value : JSON.stringify(value || {})).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function first(...values) {
  return values.find((value) => clean(value)) || "";
}

function dateOrEmpty(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function sourceRef(row = {}) {
  return {
    threadId: clean(row.threadId || row.sourceRef?.threadId),
    messageId: clean(row.messageId || row.sourceRef?.messageId),
    attachmentId: clean(row.attachmentId || row.sourceRef?.attachmentId),
    filename: clean(row.filename || row.sourceRef?.filename),
    source: clean(row.source || row.sourceRef?.source),
  };
}

function sourceSystemFor(row = {}) {
  const explicitSourceSystem = clean(row.sourceSystem).toLowerCase();
  if (["automation", "unknown"].includes(explicitSourceSystem)) return explicitSourceSystem;
  const text = clean(`${row.sourceSystem || ""} ${row.source || row.sourceRef?.source || ""} ${row.type || ""} ${row.label || ""}`).toLowerCase();
  if (/operator|phone/.test(text)) return "operator_phone";
  if (/attachment|pdf|file/.test(text)) return "gmail_attachment";
  if (/gmail|email|thread/.test(text) || row.threadId || row.messageId) return "gmail";
  if (/tms|couriercloud/.test(text)) return "tms";
  if (/tracking|carrier/.test(text)) return "tracking";
  if (/canonical|shipment-state|active/.test(text)) return "automation";
  return clean(row.source) || "unknown";
}

function factClaim(row = {}) {
  const primary = clean(row.claim || row.summary || row.note || row.label || row.type);
  const evidence = clean(row.evidence || row.evidenceText);
  const typedText = clean(`${row.type || ""} ${row.exceptionType || ""} ${primary}`);
  const terminalFact = /\b(?:pod[-_\s]?received|delivered[-_\s]?pod[-_\s]?received|delivered[-_\s]?reported|delivery[-_\s]?reported|delivery|pod)\b/i.test(
    `${row.type || ""} ${row.label || ""} ${row.status || ""}`,
  );
  const concreteTerminalEvidence = /\b(?:your shipment has been delivered to|shipment (?:has been |was )?delivered to|delivered successfully|successfully delivered|delivery completed|pod attached|pod received|proof of delivery attached|proof of delivery received|signed delivery receipt|receiver signature|signature\s*:|actual\s*:)\b/i.test(evidence);
  const primaryIsGenericTerminal = /\b(?:delivery\s*\/\s*pod evidence was received|pod(?:,\s*[^:]+)? evidence found in gmail thread|delivery was reported; verify and collect the signed pod)\b/i.test(primary);
  if (
    evidence &&
    primary &&
    (
      /\b(?:movement[-_\s]?split[-_\s]?offload|split\/offloaded|piece[-_\s]?count|flight[-_\s]?split)\b/i.test(typedText) ||
        (terminalFact && concreteTerminalEvidence && primaryIsGenericTerminal)
    ) &&
    !primary.toLowerCase().includes(evidence.toLowerCase())
  ) {
    return clean(`${primary}: ${evidence}`);
  }
  return clean(primary || evidence);
}

function sourceFactFromRow(row = {}, shipment = {}, index = 0) {
  if (!sourceFactEligible(row)) return null;
  const claim = factClaim(row);
  if (!claim) return null;
  const awb = normalizeAwb(row.awb || shipment.awb || shipment.id);
  return {
    id: unique([
      [
        awb,
        clean(row.type || row.label || "fact").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        clean(row.threadId || row.messageId || row.attachmentId || row.at || index).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      ].filter(Boolean).join(":"),
    ])[0],
    awbs: awb ? [awb] : [],
    type: clean(row.type || row.label || "source_fact"),
    sourceSystem: sourceSystemFor(row),
    sourceRef: sourceRef(row),
    observedAt: dateOrEmpty(row.at || row.observedAt || row.occurredAt || row.updatedAt),
    capturedAt: dateOrEmpty(row.capturedAt || row.updatedAt || row.at),
    actor: clean(row.actor || row.broker || row.targetName || row.label),
    claim,
    confidenceInput: clean(row.confidence || row.confidenceLabel || shipment.opsState?.confidence || shipment.confidence || "medium"),
    rawSnippet: clean(row.rawSnippet || row.evidence || row.evidenceText || claim).slice(0, 500),
  };
}

function factAppliesToAwb(fact = {}, awb = "", workgroupAwbs = []) {
  const key = normalizeAwb(awb);
  if (!key) return false;
  if (normalizeAwb(fact.awb) === key) return true;
  if ((fact.payload?.appliesToAwbs || []).some((item) => normalizeAwb(item) === key)) return true;
  return workgroupAwbs.some((item) => normalizeAwb(item) === key);
}

function ledgerRowsForShipment(shipment = {}, memory = {}) {
  const awb = normalizeAwb(shipment.awb || shipment.id);
  const ledger = memory.operationalFactLedger || memory.opsFactLedger || {};
  const workgroups = (ledger.workgroups || []).filter((workgroup) =>
    (workgroup.awbs || []).some((item) => normalizeAwb(item) === awb),
  );
  const workgroupById = new Map(workgroups.map((workgroup) => [workgroup.workgroupId, workgroup]));
  return (ledger.facts || [])
    .filter((fact) => factAppliesToAwb(fact, awb, workgroupById.get(fact.workgroupId)?.awbs || []))
    .map((fact) => ({
      type: fact.factType || fact.type || fact.gate || "ops_fact",
      label: fact.actorName || fact.actorRole || fact.sourceType || "Operational fact ledger",
      summary: fact.summary || fact.evidenceText || fact.evidence,
      evidence: fact.evidenceText || fact.evidence || fact.summary,
      threadId: fact.threadId || "",
      messageId: fact.messageId || "",
      attachmentId: fact.attachmentId || "",
      source: fact.sourceType || "ops-fact-ledger",
      at: fact.occurredAt || fact.observedAt || "",
      confidence: fact.confidenceLabel || "",
    }));
}

function evidenceRows(shipment = {}, memory = {}) {
  return [
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.evidencePacket?.sourceFacts || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.opsState?.exceptions || []),
    ...(shipment.statusAudit?.evidence || []),
    ...ledgerRowsForShipment(shipment, memory),
  ].filter(sourceFactEligible);
}

function sourceFactsForShipment(shipment = {}, memory = {}) {
  const rows = evidenceRows(shipment, memory)
    .map((row, index) => sourceFactFromRow(row, shipment, index))
    .filter(Boolean);
  const deduped = unique(rows.map((row) => row.id))
    .map((id) => rows.find((row) => row.id === id));
  const gateCitations = new Set(
    Object.values(shipment.opsState?.gates || {})
      .flatMap((gate) => Array.isArray(gate?.sourceFactIds) ? gate.sourceFactIds : [])
      .filter(Boolean),
  );
  const citedFacts = deduped.filter((fact) => gateCitations.has(fact.id));
  const uncitedBudget = Math.max(0, SOURCE_FACT_LIMIT - citedFacts.length);
  return [
    ...citedFacts,
    ...deduped.filter((fact) => !gateCitations.has(fact.id)).slice(0, uncitedBudget),
  ];
}

function normalizeGateStatus(status, gateName = "") {
  const value = clean(status).toLowerCase();
  if (gateName === "arrival" && ["arrived", "available", "on-hand"].includes(value)) return "true";
  if (["done", "released", "cleared", "paid", "received", "found", "picked-up", "picked up", "loaded", "recovered", "delivered"].includes(value)) return "true";
  if (["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem", "incomplete", "partial"].includes(value)) return "blocked";
  if (["pending", "waiting", "missing", "needed", "unknown", "not-arrived", "not arrived"].includes(value)) return "unknown";
  if (["contradicted", "conflict", "conflicted"].includes(value)) return "contradicted";
  if (!value) return "unknown";
  return value;
}

function gateState(name, gate = {}, shipment = {}, memory = {}) {
  const sourceFacts = sourceFactsForShipment(shipment, memory);
  const matching = sourceFacts.filter((fact) =>
    new RegExp(`\\b${name}\\b`, "i").test(`${fact.type || ""} ${fact.claim || ""}`),
  );
  const explicitSourceFactIds = Array.isArray(gate.sourceFactIds) ? gate.sourceFactIds.filter(Boolean) : [];
  return {
    gate: name,
    status: normalizeGateStatus(gate.status, name),
    rawStatus: clean(gate.status),
    confidence: clean(gate.confidence || shipment.opsState?.confidence || shipment.confidence || "medium"),
    sourceFactIds: unique([...explicitSourceFactIds, ...matching.map((fact) => fact.id)]).slice(0, 8),
    reason: clean(gate.evidence || gate.summary || gate.label || gate.status || "unknown"),
    updatedAt: dateOrEmpty(gate.at || shipment.opsState?.updatedAt || shipment.updatedAt),
  };
}

function freshnessForShipment(shipment = {}, memory = {}) {
  const proofAt = dateOrEmpty(shipment.emailValidation?.latestEventAt || shipment.lastEmail?.at || memory.gmailProof?.snapshotTime);
  const activeAt = dateOrEmpty(memory.active?.snapshotTime || shipment._mergeSourceSnapshotTime || shipment.updatedAt);
  const stateAt = dateOrEmpty(shipment.opsState?.updatedAt || memory.shipmentState?.snapshotTime);
  const sourceFacts = sourceFactsForShipment(shipment, memory);
  const hasGmailFact = sourceFacts.some((fact) => fact.sourceSystem === "gmail" || fact.sourceSystem === "gmail_attachment");
  const staleSources = [
    hasGmailFact ? "" : "gmail",
    activeAt ? "" : "tms",
  ].filter(Boolean);
  return {
    gmailSyncedAt: proofAt,
    trackingSyncedAt: dateOrEmpty(shipment.liveTracking?.checkedAt || shipment.tracking?.checkedAt),
    tmsSyncedAt: activeAt,
    operatorEventsSyncedAt: dateOrEmpty(memory.companionMemory?.snapshotTime),
    shipmentStateSyncedAt: stateAt,
    staleSources,
    hasGmailEvidence: hasGmailFact,
  };
}

function unknownsForShipment(shipment = {}, gates = [], freshness = {}) {
  const unknowns = gates
    .filter((gate) => ["unknown", "pending", "waiting", "missing"].includes(clean(gate.rawStatus).toLowerCase()) || gate.status === "unknown")
    .map((gate) => ({
      gate: gate.gate,
      reason: gate.reason || "No source fact proves this gate yet.",
    }));
  if (!freshness.hasGmailEvidence) {
    unknowns.unshift({
      gate: "source_coverage",
      reason: "No durable Gmail source fact is attached to this shipment truth packet.",
    });
  }
  return unknowns.slice(0, 12);
}

function customsContestExceptionText(exception = {}) {
  return clean([
    exception.type,
    exception.exceptionType,
    exception.where,
    exception.impact,
    exception.summary,
    exception.evidence,
    exception.claim,
    exception.rawSnippet,
    exception.nextAction,
  ].filter(Boolean).join(" "));
}

// This predicate is intentionally contest-only. Do not reuse it in customs
// gate reduction: "not custom released" is current ground-truth conflict, but
// this incident's contract is additive surfacing, never a gate flip.
function explicitCustomsNotReleasedText(text = "") {
  const value = clean(text);
  return (
    /\bnot\s+(?:yet\s+)?(?:be(?:en)?\s+)?(?:custom(?:s)?\s+)?released\b/i.test(value) ||
    /\bnot\s+(?:yet\s+)?(?:be(?:en)?\s+)?(?:custom(?:s)?\s+)?cleared\b/i.test(value) ||
    /\b(?:cargo|freight|shipment)\b[^.;\n]{0,40}\b(?:has\s+not|hasn['’]t|cannot|can['’]t|is\s+not|isn['’]t|was\s+not|wasn['’]t)\s+(?:yet\s+)?(?:be(?:en)?\s+)?(?:custom(?:s)?\s+)?(?:released|cleared)\b/i.test(value) ||
    /\b(?:airline|station|broker|handler)\b[^.;\n]{0,60}\b(?:has\s+not|hasn['’]t|did\s+not|didn['’]t|cannot|can['’]t|will\s+not|won['’]t)\s+(?:yet\s+)?(?:release|released|clear|cleared)\b/i.test(value) ||
    /\brelease\b[^.;\n]{0,25}\b(?:is\s+)?not\s+visible\b/i.test(value) ||
    /\b(?:airline|station|broker|handler)\b[^.;\n]{0,60}\b(?:cannot|can['’]t|does\s+not|doesn['’]t)\s+(?:see|find|locate)\b[^.;\n]{0,35}\brelease\b/i.test(value) ||
    /\b(?:customs\s+)?clearance\b[^.;\n]{0,35}\b(?:is\s+)?blocked\b/i.test(value)
  );
}

function openException(exception = {}) {
  const status = clean(exception.status).toLowerCase();
  return !/\b(?:closed|resolved|cleared|done|completed|superseded|dismissed|cancelled|canceled|inactive)\b/i.test(status);
}

function currentDriverOnsiteText(text = "") {
  const value = clean(text);
  const driverNoLongerOnsite = (
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,60}\b(?:is\s+)?no\s+longer\s+(?:on[-\s]?site|at\s+(?:the\s+)?(?:airline|airport|station|terminal|warehouse|pickup)|waiting)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,60}\b(?:has|had|already|just)\s+(?:left|departed)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,40}\b(?:left|departed)\s+(?:the\s+)?(?:site|airline|airport|station|terminal|warehouse|pickup)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,40}\bwas\s+(?:on[-\s]?site|at\s+(?:the\s+)?(?:airline|airport|station|terminal|warehouse|pickup))\b[^.;\n]{0,60}\b(?:left|departed|gone)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,40}\bis\s+not\s+(?:on[-\s]?site|at\s+(?:the\s+)?(?:airline|airport|station|terminal|warehouse|pickup))\b/i.test(value)
  );
  if (driverNoLongerOnsite) return false;
  return (
    /\bdriver[-_\s]?(?:on[-_\s]?site|onsite)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b\s+(?:is\s+)?(?:(?:currently|still|already|now)\s+)?on[-\s]?site\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b\s+(?:is\s+)?(?:(?:currently|still|already|now)\s+)?at\s+(?:the\s+)?(?:airline|airport|station|terminal|warehouse|cargo\s+facility|pickup(?:\s+location)?)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b\s+(?:is\s+)?(?:waiting|stuck)\s+at\s+(?:the\s+)?(?:airline|airport|station|terminal|warehouse|cargo\s+facility|pickup(?:\s+location)?)\b/i.test(value) ||
    /\bon[-\s]?site\b[^.;\n]{0,60}\b(?:driver|trucker|truck)\b/i.test(value) ||
    /\b(?:driver|trucker|truck)\b[^.;\n]{0,100}\b(?:cannot|can['’]t|unable\s+to)\s+(?:pick\s*up|load|recover)\b/i.test(value)
  );
}

function driverOnsiteCustomsContestException(exception = {}) {
  if (!openException(exception)) return false;
  const text = customsContestExceptionText(exception);
  const structuredDriverOrPickupException = (
    /\b(?:driver[-_\s]?(?:waiting|on[-_\s]?site|onsite)|pickup[-_\s]?(?:blocked|on[-_\s]?site|onsite))\b/i.test(`${exception.type || ""} ${exception.exceptionType || ""}`) ||
    (/\bpickup\b/i.test(clean(exception.where)) && /\b(?:blocked|waiting|on[-\s]?site|onsite)\b/i.test(text))
  );
  return structuredDriverOrPickupException &&
    currentDriverOnsiteText(text) &&
    explicitCustomsNotReleasedText(text);
}

function exceptionTimeMs(exception = {}) {
  const parsed = Date.parse(exception.at || exception.observedAt || exception.occurredAt || exception.updatedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function finalHumanCustomsReleaseFact(fact = {}) {
  const sourceSystem = clean(fact.sourceSystem).toLowerCase();
  if (!["gmail", "gmail_attachment", "operator_phone"].includes(sourceSystem)) return false;
  const text = sourceFactText(fact);
  if (!text) return false;
  const normalizedText = text.replace(/\bd\s*[/.]\s*o\.?(?![a-z])/gi, "DO");
  const typedFinalRelease = /^customs[-_\s]?release[-_\s]?received$/i.test(clean(fact.type));
  if (typedFinalRelease && !explicitCustomsNotReleasedText(normalizedText)) return true;

  const clauses = normalizedText.match(/[^.;\n?]+\??/g) || [];
  return clauses.some((rawClause) => {
    const clause = clean(rawClause);
    if (!clause || explicitCustomsNotReleasedText(clause)) return false;
    if (
      /\b(?:release|clearance|delivery\s+order|d\.?o\.?)\b[^?\n]{0,50}\b(?:pending|missing|requested|needed|awaiting|not\s+(?:yet\s+)?(?:been\s+)?received|not\s+(?:yet\s+)?confirmed|not\s+visible|blocked|unconfirmed)\b/i.test(clause) ||
      /\b(?:pending|missing|awaiting|without)\b[^?\n]{0,50}\b(?:release|clearance|delivery\s+order|d\.?o\.?)\b/i.test(clause) ||
      /\b(?:please|pls|can\s+you|could\s+you|would\s+you|do\s+you|did\s+you|have\s+you)\b[^?\n]{0,100}\b(?:release|released|clear|cleared|delivery\s+order|d\.?o\.?|received)\b/i.test(clause) ||
      /\b(?:confirm|verify|advise)\s+(?:whether|if)\b[^?\n]{0,100}\b(?:release|released|clear|cleared|delivery\s+order|d\.?o\.?|received)\b/i.test(clause) ||
      /\b(?:checking|check|confirming|confirm|verifying|verify)\s+(?:whether|if)\b[^?\n]{0,100}\b(?:release|released|clear|cleared|delivery\s+order|d\.?o\.?|received)\b/i.test(clause) ||
      /\b(?:can|could|would)\s+(?:someone|anyone|you|the\s+(?:airline|station|broker|handler))\b[^?\n]{0,100}\b(?:confirm|verify|advise)\b[^?\n]{0,80}\b(?:release|released|clear|cleared|delivery\s+order|d\.?o\.?|received)\b/i.test(clause) ||
      /\b(?:is|was|has|have|did|do)\s+(?:the\s+)?(?:airline|station|broker|handler|customs|cargo|freight|shipment)\b[^?\n]{0,80}\b(?:release|released|clear|cleared)\b/i.test(clause) ||
      /\b(?:has|have|is|was|did)\s+(?:the\s+)?(?:airline|station|broker|handler|customs|cargo|freight|shipment)\b[^?\n]{0,80}\b(?:release|released|clear|cleared)\b[^?\n]*\?$/i.test(clause) ||
      (/\?$/i.test(clause) && /\b(?:release|released|clearance|cleared|delivery\s+order|d\.?o\.?)\b/i.test(clause))
    ) {
      return false;
    }
    return (
      /\b(?:cargo|freight|shipment)\b[^?\n]{0,60}\b(?:is|was|has\s+been|is\s+now|was\s+finally)?\s*(?:released|cleared)\b/i.test(clause) ||
      /\b(?:finally\s+)?custom(?:s)?\s+(?:has\s+)?(?:released|cleared)\b/i.test(clause) ||
      /\b(?:released|cleared)\s+by\s+customs\b/i.test(clause) ||
      /\b(?:airline|station|broker|handler)\b[^?\n]{0,70}\b(?:confirmed|confirms|advised|reports?|says?)\b[^?\n]{0,60}\b(?:released|cleared|release|clearance)\b/i.test(clause) ||
      /\bconfirmed\b[^?\n]{0,80}\bcustoms\b[^?\n]{0,40}\b(?:released|cleared)\b/i.test(clause) ||
      /\bconfirmed\b[^?\n]{0,60}\brelease\s*\/\s*d\.?o\.?\b/i.test(clause) ||
      /\b(?:delivery\s+order|d\.?o\.?)\b[^?\n]{0,35}\b(?:received|issued|available|confirmed)\b/i.test(clause) ||
      /\brelease\s*\/\s*d\.?o\.?\b[^?\n]{0,35}\bconfirmed\b/i.test(clause) ||
      /\brelease\b[^?\n]{0,30}\b(?:is\s+|was\s+)?(?:visible|confirmed)\b/i.test(clause)
    );
  });
}

function sourceFactIdsForException(exception = {}, sourceFacts = []) {
  const messageId = clean(exception.messageId || exception.sourceRef?.messageId);
  const threadId = clean(exception.threadId || exception.sourceRef?.threadId);
  const at = exceptionTimeMs(exception);
  return sourceFacts
    .filter((fact) => {
      if (messageId && clean(fact.sourceRef?.messageId) === messageId) return true;
      if (threadId && clean(fact.sourceRef?.threadId) === threadId &&
          currentDriverOnsiteText(sourceFactText(fact)) && explicitCustomsNotReleasedText(sourceFactText(fact))) {
        return true;
      }
      return Boolean(at && sourceFactTimeMs(fact) === at &&
        currentDriverOnsiteText(sourceFactText(fact)) && explicitCustomsNotReleasedText(sourceFactText(fact)));
    })
    .map((fact) => fact.id)
    .filter(Boolean)
    .slice(0, 6);
}

function customsContestedOnsite(shipment = {}, sourceFacts = []) {
  const exceptions = [
    ...(shipment.opsState?.exceptions || []),
    ...(shipment.exceptions || []),
  ].filter(driverOnsiteCustomsContestException);
  if (!exceptions.length) return null;

  // Unknown chronology fails closed. Otherwise, the newest still-open contest
  // controls. A re-emitted TMS release never participates in supersession.
  const contest = exceptions.find((exception) => !exceptionTimeMs(exception)) ||
    [...exceptions].sort((a, b) => exceptionTimeMs(b) - exceptionTimeMs(a))[0];
  const contestAt = exceptionTimeMs(contest);
  // Inspect raw rows as well as the bounded/deduped packet facts. Multiple
  // messages of the same type can share one Gmail thread; a later release in
  // that thread must still supersede an older contest.
  const rawSourceFacts = evidenceRows(shipment)
    .map((row, index) => sourceFactFromRow(row, shipment, index))
    .filter(Boolean);
  const humanRelease = latestSourceFact(
    [...sourceFacts, ...rawSourceFacts],
    finalHumanCustomsReleaseFact,
  );
  const humanReleaseAt = sourceFactTimeMs(humanRelease);
  if (contestAt && humanReleaseAt && humanReleaseAt > contestAt) return null;

  return {
    exception: contest,
    sourceFactIds: sourceFactIdsForException(contest, sourceFacts),
  };
}

function contradictionsForShipment(shipment = {}, gates = [], sourceFacts = []) {
  const contradictions = [];
  const byGate = Object.fromEntries(gates.map((gate) => [gate.gate, gate]));
  const arrivalConflict = arrivalConflictForShipment(shipment, gates, sourceFacts);
  if (arrivalConflict) {
    contradictions.push({
      id: `${normalizeAwb(shipment.awb)}:arrival-source-conflict`,
      claim: arrivalConflict.reason,
      severity: "critical",
      operatorMessage: "Do not treat this shipment as arrived until newer AWB-scoped arrival/on-hand proof exists.",
      resolutionAction: "source_backfill_or_operator_truth",
      sourceFactIds: arrivalConflict.sourceFactIds,
    });
  }
  if (byGate.customs?.status === "true") {
    const contest = customsContestedOnsite(shipment, sourceFacts);
    if (contest) {
      contradictions.push({
        id: `${normalizeAwb(shipment.awb)}:customs-contested-onsite`,
        dimension: "customs",
        claim: "Canonical customs shows released/done, but an open driver-onsite exception says the airline has not released the cargo.",
        severity: "attention",
        requiresAction: true,
        operatorMessage: "Customs is contested — TMS shows released, but a driver is onsite and the airline hasn't released. Confirm the release/DO with the airline before dispatch.",
        sourceFactIds: unique([
          ...(byGate.customs.sourceFactIds || []),
          ...(contest.sourceFactIds || []),
        ]).slice(0, 8),
      });
    }
  }
  if (byGate.dispatch?.status === "true" && byGate.customs?.status === "unknown") {
    contradictions.push({
      id: `${normalizeAwb(shipment.awb)}:dispatch-with-customs-unknown`,
      claim: "Dispatch is present while customs/release proof is still unknown.",
      severity: "attention",
      operatorMessage: "Do not treat missing release proof as missing real-world release. Repair Gmail proof or record phone truth.",
      resolutionAction: "source_backfill_or_operator_truth",
    });
  }
  // A missing delivery/pod gate is unknown, not fine — a shipment picked up
  // with no delivery proof always owes the operator a POD follow-up. BUT when
  // the evidence says WHY delivery waits (receiver closed until Monday /
  // holiday / driver waiting to unload), a POD request is premature: the row
  // becomes a scheduled delivery wait with the real plan, auto-resolved by a
  // later delivery/POD proof.
  if (byGate.pickup?.status === "true" &&
      (byGate.delivery?.status ?? "unknown") !== "true" &&
      (byGate.pod?.status ?? "unknown") !== "true") {
    const wait = deliveryWaitFromFacts(sourceFacts, shipment.currentState || shipment.opsState?.phase || "");
    if (wait) {
      contradictions.push({
        id: `${normalizeAwb(shipment.awb)}:delivery-wait-${wait.kind}`,
        claim: `Picked up; delivery is waiting (${wait.kind.replace(/-/g, " ")}${wait.untilWeekday ? ` until ${wait.untilWeekday}` : ""}).`,
        severity: "attention",
        operatorMessage: deliveryWaitMessage(wait),
        resolutionAction: "monitor_delivery",
        deliveryWait: {
          kind: wait.kind,
          untilWeekday: wait.untilWeekday,
          untilDate: wait.untilDate,
          holiday: wait.holiday,
          waitingCostDays: wait.waitingCost?.days ?? null,
          sourceFactId: wait.sourceFactId,
        },
      });
    } else {
      contradictions.push({
        id: `${normalizeAwb(shipment.awb)}:pickup-with-delivery-unknown`,
        claim: "Pickup is complete but final delivery/POD is still unknown.",
        severity: "attention",
        operatorMessage: "Follow broker/driver for delivery status and POD.",
        resolutionAction: "ask_broker",
      });
    }
  }
  return contradictions;
}

function sourceFactIdsMatching(sourceFacts = [], pattern) {
  return sourceFacts
    .filter((fact) => pattern.test(`${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""}`))
    .map((fact) => fact.id)
    .slice(0, 8);
}

function sourceFactIdsMatchingFinalPod(sourceFacts = [], pattern) {
  return sourceFacts
    .filter((fact) => {
      const text = `${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""}`;
      return pattern.test(text) && !podRequestOrPendingText(text);
    })
    .map((fact) => fact.id)
    .slice(0, 8);
}

function podRequestOrPendingText(text = "") {
  const value = clean(text);
  return /\b(?:collect|request|ask|follow[-\s]?up|verify|waiting for|need|needs|needed|pending|missing|not received|not found|no pod)\b[^.;\n]{0,90}\b(?:pod|proof of delivery|signed pod)\b/i.test(value) ||
    /\b(?:pod|proof of delivery|signed pod)\b[^.;\n]{0,90}\b(?:to follow|will follow|pending|missing|needed|not received|not found|request|collect|follow[-\s]?up|verify)\b/i.test(value);
}

function terminalRecoveryText(shipment = {}, sourceFacts = []) {
  const exceptions = shipment.opsState?.exceptions || shipment.exceptions || [];
  return clean([
    shipment.currentState,
    shipment.stage,
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.label,
    shipment.opsState?.nextAction,
    shipment.nextAction,
    exceptions.map((item) => `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.impact || ""}`).join(" "),
    sourceFacts.map((fact) => `${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""}`).join(" "),
  ].join(" "));
}

function hasTerminalRecoveryResolution(text = "") {
  const value = clean(text);
  if (/\b(?:please|pls|kindly|can you|could you)\s+confirm\b|\bconfirm that\b/i.test(value)) return false;
  return /\b(?:wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)[^.;\n]{0,120}(?:resolved|cleared|fixed)|(?:confirmed|confirming|has been|was|successfully)\s+(?:returned|recovered|redelivered)|recovered from (?:the )?wrong (?:consignee|customer|recipient|receiver)|redelivered to (?:the )?(?:correct|intended) (?:consignee|customer|recipient|receiver)|delivered to (?:the )?(?:correct|intended) (?:consignee|customer|recipient|receiver))\b/i.test(value);
}

function hasTerminalRecoveryBlocker(text = "") {
  return /\b(?:delivery[-\s]?blocked|wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)|mis[-\s]?deliver(?:ed|y)?|delivered by mistake|delivered to (?:an? )?(?:another|different|wrong) (?:consignee|cnee|customer|recipient|receiver)|other than (?:the )?(?:correct|intended)?\s*(?:consignee|cnee|customer|recipient|receiver|northstar components)|return(?:ed)? to (?:el al|airline|station|you)|send (?:it|shipment|cargo)?\s*back|bring (?:it|shipment|cargo)?\s*back)\b/i.test(clean(text));
}

function hasUnresolvedTerminalRecoveryBlocker(shipment = {}, sourceFacts = []) {
  const latestBlocker = latestSourceFact(sourceFacts, (fact) => hasTerminalRecoveryBlocker(sourceFactText(fact)));
  if (latestBlocker) {
    const latestResolution = latestSourceFact(sourceFacts, (fact) => hasTerminalRecoveryResolution(sourceFactText(fact)));
    if (!latestResolution) return true;
    const blockerAt = sourceFactTimeMs(latestBlocker);
    const resolutionAt = sourceFactTimeMs(latestResolution);
    if (!blockerAt || !resolutionAt) return true;
    return blockerAt > resolutionAt;
  }
  const text = terminalRecoveryText(shipment, sourceFacts);
  return hasTerminalRecoveryBlocker(text) && !hasTerminalRecoveryResolution(text);
}

function terminalRecoveryBlockerOverlay(shipment = {}, gates = [], sourceFacts = []) {
  if (!hasUnresolvedTerminalRecoveryBlocker(shipment, sourceFacts)) return null;
  const deliveryIds = sourceFactIdsMatching(
    sourceFacts,
    /\b(?:delivery[-\s]?blocked|wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)|mis[-\s]?deliver(?:ed|y)?|delivered by mistake|delivered to (?:an? )?(?:another|different|wrong) (?:consignee|cnee|customer|recipient|receiver)|other than (?:the )?(?:correct|intended)?\s*(?:consignee|cnee|customer|recipient|receiver|northstar components)|return(?:ed)? to (?:el al|airline|station|you))\b/i,
  );
  let next = gates;
  next = replaceGate(
    next,
    "delivery",
    "blocked",
    "Wrong-consignee/recovery evidence blocks normal delivery closeout.",
    deliveryIds,
    shipment,
  );
  next = replaceGate(
    next,
    "pod",
    "blocked",
    "Normal POD closeout is blocked until recovery/redelivery to the correct consignee is confirmed.",
    deliveryIds,
    shipment,
  );
  return next;
}

function handlerReceiptOnlyText(value) {
  const text = clean(value);
  if (!text) return false;
  const handlerReceipt =
    /\b(?:shipment|cargo|freight)\s+(?:was\s+|has been\s+)?received\b/i.test(text) ||
    /\breceived by\s+(?:ground\s+handler|handler|station|warehouse|airline|carrier|terminal|cargo(?:\s+facility)?|destination\s+ground\s+handler)\b/i.test(text) ||
    /\breceived at\s+(?:the\s+)?(?:station|warehouse|terminal|ground\s+handler|cargo(?:\s+facility)?)\b/i.test(text);
  if (!handlerReceipt) return false;
  return !/\b(?:pod attached|pod found|pod received|proof of delivery|signed pod|signed delivery receipt|receiver signature|delivered to|delivery completed|successfully delivered)\b/i.test(text) &&
    !/\breceived by\s+(?!(?:ground\s+handler|handler|station|warehouse|airline|carrier|terminal|cargo(?:\s+facility)?|destination\s+ground\s+handler)\b)[A-Z][A-Za-z .'-]{1,40}\b/.test(text);
}

function paymentDeliveryOnlyText(value = "") {
  const text = clean(value);
  if (!text) return false;
  return /\b(?:cargosprint|payment|receipt|fees?|charges?|invoice|ground[-\s]?handling|station)\b[^.;\n]{0,120}\b(?:delivered|paid|posted|processed|received)\b/i.test(text) &&
    !/\b(?:shipment|cargo|freight|load)\b[^.;\n]{0,80}\b(?:delivered|successfully delivered|delivery completed)\b/i.test(text) &&
    !/\b(?:pod attached|pod found|pod received|proof of delivery|signed pod|signed delivery receipt|receiver signature|delivered to receiver)\b/i.test(text);
}

function replaceGate(gates = [], name, rawStatus, reason, sourceFactIds = [], shipment = {}, winningAt = "", options = {}) {
  return gates.map((gate) => {
    if (gate.gate !== name) return gate;
    return {
      ...gate,
      status: normalizeGateStatus(rawStatus, name),
      rawStatus,
      confidence: gate.confidence || clean(shipment.opsState?.confidence || shipment.confidence || "medium"),
      sourceFactIds: options.clearSourceFactIds ? [] : sourceFactIds.length ? sourceFactIds : gate.sourceFactIds,
      reason: clean(reason || gate.reason || rawStatus),
      updatedAt: dateOrEmpty(winningAt) || gate.updatedAt || dateOrEmpty(shipment.opsState?.updatedAt || shipment.updatedAt),
    };
  });
}

function terminalDeliveryOverlay(shipment = {}, gates = [], sourceFacts = []) {
  if (hasUnresolvedTerminalRecoveryBlocker(shipment, sourceFacts)) return terminalRecoveryBlockerOverlay(shipment, gates, sourceFacts) || gates;
  const decisiveDeliveryPattern = /\b(?:delivered to|successfully delivered|load was successfully delivered|was delivered|has been delivered|delivery reported|delivery confirmed|delivery completed|proof of delivery|pod found|signed pod|attached is the pod|attached pod|pod is in memory)\b/i;
  const decisivePodPattern = /\b(?:pod (?:attached|found|received)|attached (?:is )?(?:the )?pod|proof of delivery (?:attached|received)|signed delivery receipt|receiver signature|signature\s*[:#-]?\s*[A-Z][A-Za-z .'-]{1,40}|signed by\s+[A-Z][A-Za-z .'-]{1,40}|received by\s+[A-Z][A-Za-z .'-]{1,40}|pod is in memory)\b/i;
  const sourceDeliveryFacts = sourceFacts.filter((fact) => {
    const text = clean(`${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""}`);
    return !paymentDeliveryOnlyText(text);
  });
  const sourceFactText = clean(sourceDeliveryFacts.map((fact) => `${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""}`).join(" "));
  const stateText = clean([
    shipment.completed ? "completed" : "",
    shipment.currentState,
    shipment.stage,
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.label,
    shipment.pod?.status,
    shipment.pod?.deliveredAt,
  ].join(" "));
  const text = clean([
    stateText,
    sourceFactText,
  ].join(" "));
  const deliveredIds = sourceFactIdsMatching(sourceDeliveryFacts, decisiveDeliveryPattern);
  const podIds = sourceFactIdsMatchingFinalPod(sourceDeliveryFacts, decisivePodPattern);
  const sourceTerminalProof = Boolean(
    deliveredIds.length ||
      podIds.length ||
      decisiveDeliveryPattern.test(sourceFactText) ||
      (decisivePodPattern.test(sourceFactText) && !podRequestOrPendingText(sourceFactText))
  );
  if (!sourceTerminalProof && handlerReceiptOnlyText(sourceFactText)) return gates;
  const delivered = Boolean(
    (shipment.completed && sourceTerminalProof) ||
    decisiveDeliveryPattern.test(text) && (sourceTerminalProof || decisiveDeliveryPattern.test(sourceFactText)) ||
    deliveredIds.length,
  );
  if (!delivered) return gates;
  const podDone = Boolean(
    (decisivePodPattern.test(text) && !podRequestOrPendingText(text)) ||
    podIds.length ||
    ["done", "received", "found", "pod-found"].includes(clean(shipment.pod?.status).toLowerCase())
  );
  const closeoutIds = podIds.length ? podIds : deliveredIds;
  let next = gates;
  next = replaceGate(next, "arrival", "done", "Delivery/POD proof confirms the shipment reached destination execution.", deliveredIds, shipment);
  next = replaceGate(next, "customs", "done", "Delivery/POD proof means release/DO did not remain blocking.", deliveredIds, shipment);
  next = replaceGate(next, "fees", "done", "Delivery/POD proof means ground fees did not remain blocking.", deliveredIds, shipment);
  next = replaceGate(next, "dispatch", "done", "Delivery/POD proof means dispatch was completed.", deliveredIds, shipment);
  next = replaceGate(next, "pickup", "done", "Delivery/POD proof means pickup/recovery was completed.", deliveredIds, shipment);
  next = replaceGate(next, "delivery", "delivered", "Delivery is confirmed.", deliveredIds, shipment);
  next = replaceGate(
    next,
    "pod",
    podDone ? "done" : "pending",
    podDone ? "POD/proof of delivery is in memory." : "Delivery is confirmed; signed POD still needs proof.",
    closeoutIds,
    shipment,
  );
  return next;
}

function operatorGatesForShipment(shipment = {}, memory = {}) {
  const sourceFacts = sourceFactsForShipment(shipment, memory);
  let gates = GATE_NAMES.map((name) => gateState(name, shipment.opsState?.gates?.[name] || {}, shipment, memory));
  const positiveArrival = positiveArrivalFactWins(sourceFacts);
  const topLevelArrivalArrived = /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(clean(shipment.arrivalStatus));
  const currentArrivalGate = gates.find((gate) => gate.gate === "arrival") || {};
  const arrivalGateSaysNotArrived = currentArrivalGate.status !== "true" &&
    /\b(?:not[-\s]?arrived|in[-\s]?transit|departed|waiting|pending|destination delivery is not proven|onward[-\s]?flight|handler transfer)\b/i.test(
      `${currentArrivalGate.rawStatus || ""} ${currentArrivalGate.reason || ""}`,
    );
  // Authority ordering: the canonical pipeline evaluates arrival each cycle
  // with full proof visibility and its false-positive scrubbers. This
  // override may FILL an undecided gate, never overrule a substantive
  // canonical verdict — otherwise the previous cycle's own echo fact
  // ("station_arrival_confirmed: Arrival/on-hand evidence was received")
  // re-mints a healed false arrival forever (2026-07-06, 016-80000165:
  // a question minted arrival; re-extraction healed the pipeline gate but
  // this override kept resurrecting it from the inherited echo).
  const arrivalGateUndecided = ["", "unknown", "missing", "none"].includes(
    String(currentArrivalGate.status || "").toLowerCase(),
  );
  if ((positiveArrival || topLevelArrivalArrived) && !arrivalGateSaysNotArrived && arrivalGateUndecided) {
    gates = replaceGate(
      gates,
      "arrival",
      "done",
      positiveArrival?.claim || "Arrival/on-hand evidence was received.",
      positiveArrival?.id ? [positiveArrival.id] : [],
      shipment,
    );
  }
  const arrivalConflict = arrivalConflictForShipment(shipment, gates, sourceFacts);
  if (arrivalConflict) {
    gates = replaceGate(
      gates,
      "arrival",
      "not-arrived",
      arrivalConflict.reason,
      arrivalConflict.sourceFactIds,
      shipment,
    );
  }
  const currentCustomsGate = gates.find((gate) => gate.gate === "customs") || {};
  const customsHold = holdReopensResolvedCustomsGate(customsHoldFactWins(sourceFacts), currentCustomsGate, sourceFacts);
  const customsRelease = latestSourceFact(sourceFacts, customsReleaseSourceFact);
  const currentCustomsGateAt = Date.parse(currentCustomsGate.updatedAt || "");
  const customsReleaseAt = sourceFactTimeMs(customsRelease);
  if (customsHold) {
    gates = replaceGate(
      gates,
      "customs",
      "blocked",
      customsHold.claim || "Customs/government hold is active.",
      [customsHold.id].filter(Boolean),
      shipment,
      customsHold.observedAt || customsHold.capturedAt || "",
    );
  } else if (
    !customsHold &&
    customsRelease &&
    customsReleaseAt &&
    (!Number.isFinite(currentCustomsGateAt) || customsReleaseAt >= currentCustomsGateAt)
  ) {
    gates = replaceGate(
      gates,
      "customs",
      "done",
      customsRelease.claim || "Customs/release evidence supersedes the older hold.",
      [customsRelease.id].filter(Boolean),
      shipment,
      customsRelease.observedAt || customsRelease.capturedAt || "",
    );
  } else if (!customsHold && currentCustomsGate.status === "blocked") {
    gates = replaceGate(
      gates,
      "customs",
      "unknown",
      "No current source fact in this evidence cut proves a customs/government hold.",
      [],
      shipment,
      "",
      { clearSourceFactIds: true },
    );
  }
  gates = monotonicGateClosure(gates, shipment, sourceFacts, customsHold);
  return {
    sourceFacts,
    gates: terminalDeliveryOverlay(shipment, gates, sourceFacts),
  };
}

function sourceFactText(fact = {}) {
  return clean(`${fact.type || ""} ${fact.actor || ""} ${fact.claim || ""} ${fact.rawSnippet || ""}`);
}

function sourceFactTimeMs(fact = {}) {
  fact = fact || {};
  const parsed = Date.parse(fact.observedAt || fact.capturedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestSourceFact(sourceFacts = [], predicate = () => false) {
  return [...sourceFacts]
    .filter(predicate)
    .sort((a, b) => sourceFactTimeMs(b) - sourceFactTimeMs(a))[0] || null;
}

function arrivalRequestOrPendingText(text = "") {
  // A counterparty presenting an already-attached arrival document is not
  // asking us to obtain/confirm one. Strip only that presentation phrase;
  // any separate "confirm on hand" request in the same sentence remains and
  // is still classified by the request patterns below.
  const value = clean(text).replace(
    /\b(?:please\s+)?(?:see|find|review)\s+(?:the\s+)?(?:attached|enclosed)\s+(?:arrival notice|notice of arrival|noa)\b/gi,
    "arrival document provided",
  );
  return /\b(?:please|pls|request(?:ed|ing)?|ask(?:ed|ing)?|need(?:ed)?|await(?:ing)?|waiting for|missing|pending|not received|not provided|send|share|provide|confirm)\b[^.;\n]{0,120}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available|availability|arrival)\b/i.test(value) ||
    /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available|availability|arrival)\b[^.;\n]{0,120}\b(?:requested|needed|missing|pending|not received|not provided|please|awaiting|waiting)\b/i.test(value) ||
    /\b(?:once|when|after)\b[^.;\n]{0,80}\b(?:arrives?|arrival|on[-\s]?hand|available)\b/i.test(value);
}

function arrivalNegativeText(text = "") {
  const value = clean(text);
  return /\b(?:not[-\s]?arrived|not at destination|no arrival|arrival pending|pending arrival|scheduled arrival|future arrival|eta only|destination arrival is not proven|not in (?:our|the|their) system|not yet in (?:our|the|their) system|not on[-\s]?hand|not available|cargo not on[-\s]?hand|freight not on[-\s]?hand|at origin|still at origin|in[-\s]?transit|in transit to [A-Z]{3}|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d]))\b/i.test(value);
}

function onwardTransferSourceText(text = "") {
  const value = clean(text);
  if (!value) return false;
  if (/\b(?:pod attached|pod found|pod received|proof of delivery|signed pod|delivered to|delivery completed|successfully delivered)\b/i.test(value)) {
    return false;
  }
  return /\b(?:connection[-_\s]?transfer[-_\s]?resolved|handler transfer|onward[-\s]?flight|continues? to [A-Z]{3}|continued to [A-Z]{3}|continue to [A-Z]{3}|will be loaded|loaded for flight|flight\s+ua\s*\d+|transferred (?:to|at) (?:ua|united))\b/i.test(value);
}

function sourceFactTypeToken(fact = {}) {
  return clean(fact.type || "").toLowerCase().replace(/[_\s]+/g, "-");
}

function externallyBoundSourceFact(fact = {}) {
  const sourceSystem = clean(fact.sourceSystem).toLowerCase();
  return sourceFactEligible(fact) && !["automation", "unknown"].includes(sourceSystem) && hasExternalSourceCoordinates(fact);
}

function sourceBackedTypedArrivalFact(fact = {}) {
  const type = sourceFactTypeToken(fact);
  if (!["arrival-notice-received", "station-arrival-confirmed"].includes(type)) return false;
  if (!externallyBoundSourceFact(fact)) return false;
  const sourceText = sourceFactText(fact);
  const rawEvidence = clean(fact.rawSnippet);
  if (!rawEvidence || arrivalRequestOrPendingText(sourceText) || arrivalNegativeText(sourceText) || onwardTransferSourceText(sourceText)) {
    return false;
  }
  const concreteArrival = /\b(?:shipment|cargo|freight|truck|load)\s+(?:(?:has|was|is|just)\s+)?arrived\b/i.test(rawEvidence);
  const concreteAvailability = /\b(?:shipment|cargo|freight|load)\s+(?:is\s+|now\s+)?(?:on[-\s]?hand|available|ready\s+for\s+pickup)\b|\b(?:on[-\s]?hand|available|ready\s+for\s+pickup)\s+at\s+(?:the\s+)?(?:station|terminal|warehouse)\b/i.test(rawEvidence);
  return concreteArrival || concreteAvailability;
}

function positiveArrivalSourceFact(fact = {}) {
  const text = sourceFactText(fact);
  if (fact.sourceSystem === "automation" || /\b(?:canonical[-_\s]?arrival|state[-_\s]?arrival)\b/i.test(`${fact.type || ""} ${fact.actor || ""}`)) {
    return false;
  }
  if (fact.sourceSystem === "tms" && /\b(?:280[-\s]?ARR@DEST|ARR@DEST|arrived?\s+at\s+dest|destination arrival confirmed)\b/i.test(text)) {
    return true;
  }
  if (sourceBackedTypedArrivalFact(fact)) return true;
  // Pipeline echo tokens (our own event/fact boilerplate: "station arrival
  // confirmed", "arrival/on-hand evidence was received", "arrival evidence
  // found") are NOT source evidence — accepting them let a healed false
  // arrival resurrect from the previous cycle's own facts forever
  // (2026-07-06, 016-80000165). Only real-world arrival phrasing counts.
  const echoOnly = /\b(?:station[-_\s]?arrival[-_\s]?confirmed|arrival[-_\s]?notice[-_\s]?received|arrival\/on[-\s]?hand evidence|arrival (?:evidence|proof) (?:found|received|confirmed))\b/i.test(text) &&
    !/\b(?:shipment (?:has )?arrived|has arrived|arrived at|arrival date|notice of arrival attached|freight (?:is )?on[-\s]?hand|available for pickup|at (?:the )?(?:terminal|station|warehouse))\b/i.test(text);
  if (echoOnly) return false;
  return /\b(?:shipment (?:has )?arrived|has arrived|arrived at|arrival date|notice of arrival|on[-\s]?hand|available for pickup|at (?:the )?(?:terminal|station|warehouse))\b/i.test(text) &&
    !arrivalRequestOrPendingText(text) &&
    !arrivalNegativeText(text) &&
    !onwardTransferSourceText(text);
}

function negativeArrivalSourceFact(fact = {}) {
  const text = sourceFactText(fact);
  return arrivalNegativeText(text) || arrivalRequestOrPendingText(text) || onwardTransferSourceText(text);
}

function tmsArrivalStatusText(shipment = {}) {
  return clean([
    shipment.tms?.status,
    shipment.tms?.tmsStatus,
    shipment.tms?.statusDescription,
    shipment.tms?.nextTask,
    shipment.tmsStatus,
    shipment.status,
    shipment.statusDescription,
    shipment.nextTask,
    shipment.flightDetails?.recoveryHint,
    shipment.flightDetails?.etaHint,
  ].join(" "));
}

function tmsArrivalStatusCode(text = "") {
  const match = clean(text).match(/\b(\d{3})(?=\s*[-/A-Z@])/i);
  const code = match ? Number(match[1]) : 0;
  return Number.isFinite(code) ? code : 0;
}

function tmsProvesArrival(shipment = {}) {
  const text = tmsArrivalStatusText(shipment);
  const code = tmsArrivalStatusCode(text);
  return code >= 280 ||
    /\b(?:arr\s*@\s*dest|arrived?\s+at\s+dest|available|on[-\s]?hand|ready\s*for\s*pickup)\b/i.test(text);
}

function tmsArrivalSnapshotTimeMs(shipment = {}) {
  const parsed = Date.parse(
    shipment.tms?.snapshotTime ||
    shipment.tmsSnapshotTime ||
    shipment.tms?.updatedAt ||
    shipment.tmsUpdatedAt ||
    "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function tmsContradictsArrival(shipment = {}) {
  const text = tmsArrivalStatusText(shipment);
  if (!text || tmsProvesArrival(shipment)) return false;
  const code = tmsArrivalStatusCode(text);
  return (code > 0 && code < 280) ||
    /\b(?:conf\s*onboar|conf(?:irmed)?\s+on\s+board|in[-\s]?transit|arrive\s+(?:mon|tue|wed|thu|fri|sat|sun|\d{1,2}[:\d]))\b/i.test(text);
}

function arrivalConflictForShipment(shipment = {}, gates = [], sourceFacts = []) {
  const byGate = Object.fromEntries(gates.map((gate) => [gate.gate, gate]));
  const arrivalClaimed = byGate.arrival?.status === "true" ||
    /^(?:arrived|available|on[-\s]?hand|ready|done)$/i.test(clean(shipment.arrivalStatus)) ||
    /^(?:arrived|arrival|station|available)$/i.test(clean(shipment.truthPacket?.physicalLifecycle?.status || "").replace(/_/g, "-"));
  if (!arrivalClaimed) return null;
  const positive = latestSourceFact(sourceFacts, positiveArrivalSourceFact);
  const negative = latestSourceFact(sourceFacts, negativeArrivalSourceFact);
  const positiveAt = sourceFactTimeMs(positive);
  const negativeAt = sourceFactTimeMs(negative);
  const newerTmsArrivalProof = Boolean(
    negative &&
    negativeAt &&
    tmsProvesArrival(shipment) &&
    tmsArrivalSnapshotTimeMs(shipment) > negativeAt
  );
  if (negative && !newerTmsArrivalProof && (!positive || !positiveAt || !negativeAt || negativeAt >= positiveAt)) {
    return {
      reason: negative.claim || "Arrival is marked complete, but current source evidence says destination arrival is not proven.",
      sourceFactIds: [negative.id].filter(Boolean),
    };
  }
  if (tmsContradictsArrival(shipment) && !positive) {
    return {
      reason: "Arrival is marked complete, but current TMS is still pre-arrival/in-transit.",
      sourceFactIds: byGate.arrival?.sourceFactIds || [],
    };
  }
  return null;
}

function positiveArrivalFactWins(sourceFacts = []) {
  const positive = latestSourceFact(sourceFacts, positiveArrivalSourceFact);
  if (!positive) return null;
  const negative = latestSourceFact(sourceFacts, negativeArrivalSourceFact);
  const positiveAt = sourceFactTimeMs(positive);
  const negativeAt = sourceFactTimeMs(negative);
  if (!negative || !positiveAt || !negativeAt || positiveAt > negativeAt) return positive;
  return null;
}

function hardCustomsHoldSourceText(text = "") {
  const clauses = clean(text)
    .replace(/\b(?:but|however|subsequently)\b/gi, ".")
    .split(/[.;\n]+/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let active = null;
  for (const clause of clauses) {
    const holdContext = /\b(?:customs|cbp|fda|government|exam|hold|\b1[-\s]?h\b)\b/i.test(clause);
    if (!holdContext) continue;
    const explicitlyNoHold = /\bno\s+(?:active\s+)?(?:customs|government|cbp|fda|exam)?\s*hold\b|\b(?:not|never)\s+(?:currently\s+)?(?:on|under)\s+(?:an?\s+)?(?:customs|government|cbp|fda|exam)\s+hold\b|\b(?:customs|government|cbp|fda|exam)\s+hold\b[^.;\n]{0,30}\bnot\s+active\b/i.test(clause);
    const explicitlyUnresolved = /\b(?:hold|exam)\b[^.;\n]{0,50}\b(?:not|never|hasn't|isn't|wasn't)\b[^.;\n]{0,40}\b(?:removed|released|lifted|cleared|resolved)\b/i.test(clause);
    const conditionallyUnresolved = /\b(?:until|unless)\b[^.;\n]{0,100}(?:\bhold\b[^.;\n]{0,50}\b(?:removed|released|lifted|cleared)|\b(?:remove|release|lift|clear)\b[^.;\n]{0,50}\bhold\b)/i.test(clause);
    const explicitlyResolved = /\b(?:hold|exam)\b[^.;\n]{0,60}\b(?:removed|released|lifted|cleared|resolved)\b|\b(?:removed|released|lifted|cleared|resolved)\b[^.;\n]{0,60}\b(?:hold|exam)\b/i.test(clause);
    if (explicitlyNoHold || explicitlyResolved && !explicitlyUnresolved && !conditionallyUnresolved) {
      active = false;
      continue;
    }
    if (
      explicitlyUnresolved ||
      conditionallyUnresolved ||
      /\b(?:customs hold|government hold|u\.?s\.? customs hold|cbp hold|fda hold|exam hold|intensive exam|hold remains active|\b1[-\s]?h\b)\b/i.test(clause) ||
      /\b(?:u\.?s\.?\s*)?(?:customs|cbp|fda|government)\b[^.;\n]{0,140}\b(?:hold|exam|examine|inspection|cannot pick up|can't pick up|can not pick up|unable to pick up)\b/i.test(clause) ||
      /\b(?:shipment|cargo|freight)\b[^.;\n]{0,100}\b(?:on|under)\s+(?:a\s+)?(?:customs|government|cbp|fda|exam)\s+hold\b/i.test(clause)
    ) {
      active = true;
    }
  }
  return active === true;
}

function customsHoldSourceFact(fact = {}) {
  const text = sourceFactText(fact);
  return hardCustomsHoldSourceText(text) ||
    /\b(?:unless|until)\b[^.;\n]{0,80}\b(?:remove|release|lift)\b[^.;\n]{0,80}\bhold\b/i.test(text);
}

function customsReleaseSourceFact(fact = {}) {
  const text = sourceFactText(fact);
  return /\b(?:customs[-_\s]?release[-_\s]?received|hold (?:removed|released|lifted|cleared)|exam (?:cleared|released)|customs (?:released|cleared)|cleared (?:by )?customs|customs clearance (?:is )?(?:complete|completed|cleared)|release\/?d\.?o confirmed|release confirmed|\b1c\b|cargo release)\b/i.test(text) &&
    !/\b(?:not released|release pending|not (?:yet )?cleared(?: by)? customs|has(?: not|n't) cleared customs|customs clearance (?:is |was )?(?:not complete|incomplete|pending)|unless .*hold|until .*hold|cannot pick up|can't pick up|can not pick up|customs wants? to examine|government hold|exam hold)\b/i.test(text);
}

function customsHoldFactWins(sourceFacts = []) {
  const hold = latestSourceFact(sourceFacts, customsHoldSourceFact);
  if (!hold) return null;
  const release = latestSourceFact(sourceFacts, customsReleaseSourceFact);
  const holdAt = sourceFactTimeMs(hold);
  const releaseAt = sourceFactTimeMs(release);
  if (!release || !holdAt || !releaseAt || holdAt >= releaseAt) return hold;
  return null;
}

function resolvedCustomsGate(gate = {}) {
  const status = clean(gate.status).toLowerCase();
  const rawStatus = clean(gate.rawStatus).toLowerCase();
  const reason = clean(gate.reason).toLowerCase();
  if (
    customsHoldSourceFact({ claim: reason }) ||
    /\b(?:not|cannot|can't|can not|unable to|pending|without)\b[^.;\n]{0,80}\b(?:released|cleared|release|clearance)\b|\b(?:released|cleared|release|clearance)\b[^.;\n]{0,80}\b(?:not|pending|blocked|missing|unconfirmed)\b/.test(reason)
  ) {
    return false;
  }
  return status === "true" ||
    ["done", "released", "cleared"].includes(rawStatus) ||
    /\b(?:released|cleared|1c|1i cbp hold removed|hold removed|release\/?d\.?o confirmed)\b/.test(reason);
}

function holdReopensResolvedCustomsGate(hold = {}, gate = {}, sourceFacts = []) {
  if (!hold) return null;
  if (!resolvedCustomsGate(gate)) return hold;
  const holdAt = sourceFactTimeMs(hold);
  const releaseAt = Date.parse(gate.updatedAt || "");
  if (!holdAt || !Number.isFinite(releaseAt) || holdAt <= releaseAt) return null;
  const laterRelease = latestSourceFact(
    sourceFacts,
    (fact) => customsReleaseSourceFact(fact) && sourceFactTimeMs(fact) >= holdAt,
  );
  return laterRelease ? null : hold;
}

const UPSTREAM_CLOSURE_EVENT_TYPES = Object.freeze({
  award: new Set(["broker-awarded", "pickup-broker-awarded"]),
  documents: new Set(["pickup-docs-sent"]),
  fees: new Set(["ground-fees-paid"]),
  deliverySchedule: new Set(["delivery-scheduled"]),
});

function latestCurrentCutFactByTypes(sourceFacts = [], acceptedTypes = new Set()) {
  return latestSourceFact(
    sourceFacts,
    (fact) => externallyBoundSourceFact(fact) && acceptedTypes.has(sourceFactTypeToken(fact)),
  );
}

function downstreamUpstreamClosureEvidence(sourceFacts = []) {
  const facts = [
    latestCurrentCutFactByTypes(sourceFacts, UPSTREAM_CLOSURE_EVENT_TYPES.award),
    latestCurrentCutFactByTypes(sourceFacts, UPSTREAM_CLOSURE_EVENT_TYPES.documents),
    latestCurrentCutFactByTypes(sourceFacts, UPSTREAM_CLOSURE_EVENT_TYPES.fees),
    latestCurrentCutFactByTypes(sourceFacts, UPSTREAM_CLOSURE_EVENT_TYPES.deliverySchedule),
  ];
  if (facts.some((fact) => !fact)) return null;
  const latestAtMs = Math.max(...facts.map(sourceFactTimeMs));
  return {
    facts,
    sourceFactIds: facts.map((fact) => fact.id).filter(Boolean),
    observedAt: Number.isFinite(latestAtMs) && latestAtMs > 0 ? new Date(latestAtMs).toISOString() : "",
  };
}

function monotonicGateClosure(gates = [], shipment = {}, sourceFacts = [], customsHold = null) {
  const closure = downstreamUpstreamClosureEvidence(sourceFacts);
  if (!closure) return gates;
  const byGate = gateByName(gates);
  const closureAt = Date.parse(closure.observedAt || "");
  const laterArrivalContradiction = latestSourceFact(sourceFacts, (fact) => {
    if (!negativeArrivalSourceFact(fact)) return false;
    const negativeAt = sourceFactTimeMs(fact);
    return !Number.isFinite(closureAt) || !negativeAt || negativeAt >= closureAt;
  });
  let next = gates;
  if (!laterArrivalContradiction && byGate.arrival?.status !== "true") {
    next = replaceGate(
      next,
      "arrival",
      "done",
      "Broker award, pickup-document handoff, fee payment, and scheduled delivery prove destination arrival was operationally passed.",
      closure.sourceFactIds,
      shipment,
      closure.observedAt,
    );
  }
  if (!customsHold && gateByName(next).customs?.status !== "true") {
    next = replaceGate(
      next,
      "customs",
      "done",
      "Broker award, pickup-document handoff, fee payment, and scheduled delivery prove the customs/release path was operationally passed.",
      closure.sourceFactIds,
      shipment,
      closure.observedAt,
    );
  }
  return next;
}

function sourceFactIds(sourceFacts = []) {
  return sourceFacts.map((fact) => fact.id).filter(Boolean).slice(0, 10);
}

function shipmentEvidenceText(shipment = {}, sourceFacts = []) {
  const exceptions = shipment.opsState?.exceptions || shipment.exceptions || [];
  return clean([
    shipment.currentState,
    shipment.stage,
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.label,
    shipment.opsState?.nextAction,
    shipment.nextAction,
    shipment.arrivalStatus,
    shipment.pickupStatus,
    shipment.deliveryStatus,
    shipment.pod?.status,
    exceptions.map((item) => `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`).join(" "),
    sourceFacts.map(sourceFactText).join(" "),
  ].join(" "));
}

function gateByName(gates = []) {
  return Object.fromEntries(gates.map((gate) => [gate.gate, gate]));
}

function gateStatusText(gate = {}) {
  return clean(`${gate.rawStatus || ""} ${gate.status || ""} ${gate.reason || ""}`).toLowerCase();
}

function gateResolvedStatusIs(gate = {}, accepted = []) {
  const resolved = clean(gate.rawStatus || gate.status).toLowerCase();
  return accepted.includes(resolved);
}

function pickupExecutionNegatedText(text = "") {
  const value = clean(text);
  return /\b(?:not|no|without|pending|waiting|still|unconfirmed|not confirmed|not proven|not complete|not completed|not done|needed|need|needs|collect|get|verify|confirm)\b[^.;\n]{0,120}\b(?:picked up|pickup|pick[-\s]?up|loaded|loading proof|loaded proof|pickup proof|proof\/pod|pod)\b/i.test(value) ||
    /\b(?:picked up|pickup|pick[-\s]?up|loaded|loading proof|loaded proof|pickup proof|proof\/pod|pod)\b[^.;\n]{0,120}\b(?:not|no|pending|waiting|still|unconfirmed|not confirmed|not proven|not complete|not completed|not done|needed|need|needs|collect|get|verify|confirm)\b/i.test(value);
}

function dispatchGateResolved(gate = {}) {
  const text = gateStatusText(gate);
  return /\b(?:true|done|sent|dispatched|broker-awarded|awarded|assigned|confirmed)\b/.test(text);
}

// Granular dispatch state. The old boolean collapsed every unresolved-dispatch shipment into
// one "Pickup broker needed" label even when the broker was already alerted or had already
// quoted — semantically wrong and it generated rediscovery actions for proven relationships.
// Distinguishes: broker_missing, broker_alerted_ack_needed, broker_quoted_award_needed,
// broker_confirmed_pickup_execution_needed, pickup_scheduled_wait_execution,
// picked_up_delivery_or_pod_needed.
function dispatchBlockerSubtype(byGate = {}) {
  const dispatchText = gateStatusText(byGate.dispatch);
  const pickupText = gateStatusText(byGate.pickup);
  if (/\b(?:picked-up|picked up|loaded|recovered)\b/.test(pickupText)) {
    return { subtype: "picked_up_delivery_or_pod_needed", label: "Picked up; delivery/POD needed" };
  }
  if (/\b(?:scheduled|onsite|driver-onsite)\b/.test(pickupText)) {
    return { subtype: "pickup_scheduled_wait_execution", label: "Pickup scheduled; awaiting execution" };
  }
  if (dispatchGateResolved(byGate.dispatch)) {
    return { subtype: "broker_confirmed_pickup_execution_needed", label: "Broker confirmed; pickup execution needed" };
  }
  if (/\b(?:quote-received|quotes-in|quoted)\b/.test(dispatchText)) {
    return { subtype: "broker_quoted_award_needed", label: "Pickup quote received; award decision needed" };
  }
  if (/\b(?:broker-alerted|alert-sent|alerted)\b/.test(dispatchText)) {
    return { subtype: "broker_alerted_ack_needed", label: "Broker alerted; acknowledgment needed" };
  }
  return { subtype: "broker_missing", label: "Pickup broker needed" };
}

function amountValuesFromText(value = "") {
  const amounts = [];
  const text = String(value || "");
  const pattern = /(?:USD\s*)?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)|\bUSD\s+([0-9][0-9,]*(?:\.\d{1,2})?)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1] || match[2] || "";
    const amount = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(amount)) amounts.push(amount);
  }
  return amounts;
}

function amountKey(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "";
}

function parseUsDateOnlyMs(value = "") {
  const match = String(value || "").match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function factReferenceDayMs(fact = {}) {
  const parsed = Date.parse(fact.observedAt || fact.capturedAt || fact.at || "");
  const date = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12, 0, 0);
}

function currentStorageDueEvidence(text = "") {
  const value = String(text || "");
  return /\b(?:storage\s+(?:is\s+)?(?:due|unpaid|outstanding|accru(?:e|ed|ing))|storage\s+(?:has\s+)?(?:started|begun)|storage\s+balance|outstanding\s+storage|remaining\s+balance|balance\s+due|still\s+due|pay\s+storage|kindly\s+pay\s+storage|storage\s+as\s+well)\b/i.test(value);
}

function futureStorageChargeAmountsFromText(text = "", referenceDayMs = factReferenceDayMs()) {
  const value = String(text || "");
  if (!/\bstorage\s+start\s+date\b/i.test(value) || currentStorageDueEvidence(value)) return [];
  const startDateMatch = value.match(/\bstorage\s+start\s+date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const storageStartMs = parseUsDateOnlyMs(startDateMatch?.[1] || "");
  if (!Number.isFinite(storageStartMs) || storageStartMs <= referenceDayMs) return [];
  const match = value.match(/\bdaily\s+storage\s+charge\b[\s\S]{0,320}?(?:USD\s*)?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (!match) return [];
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? [amount] : [];
}

function currentFeeAmountValuesFromFact(fact = {}) {
  const text = sourceFactText(fact);
  const amounts = amountValuesFromText(text);
  const excluded = futureStorageChargeAmountsFromText(text, factReferenceDayMs(fact));
  if (!excluded.length) return amounts;
  const excludedKeys = new Set(excluded.map(amountKey));
  return amounts.filter((amount) => !excludedKeys.has(amountKey(amount)));
}

function futureStorageChargeOnlyFact(fact = {}) {
  const amounts = amountValuesFromText(sourceFactText(fact));
  return amounts.length > 0 &&
    currentFeeAmountValuesFromFact(fact).length === 0 &&
    futureStorageChargeAmountsFromText(sourceFactText(fact), factReferenceDayMs(fact)).length > 0;
}

function payeeActorAcceptable(actor = "") {
  const value = clean(actor);
  if (!value) return false;
  // Fact-type slugs, pipeline process labels, gate echoes ("fees: done") and
  // raw email addresses are not payees.
  if (/[_@]/.test(value)) return false;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value)) return false;
  if (/^(?:arrival|customs|fees|dispatch|pickup|delivery|pod)\s*:/i.test(value)) return false;
  if (/^(?:done|pending|blocked|unknown|true|false)\b/i.test(value)) return false;
  return !/^(?:station|broker|carrier|operator|unknown|gmail|storage|fees?|charge|manual gmail review|operational fact ledger|storage memory|station memory|ops fact ledger|automation|canonical risk|system)$/i.test(value);
}

function payeeFromFeeFact(fact = {}, text = "") {
  // An explicit "paid to X" in the evidence text beats the actor field, which
  // often carries the fact-type label instead of a real counterparty.
  const paidToMatch = String(text || "").match(/\b(?:paid to|payment delivered to|payable to)\s+([A-Z][A-Za-z0-9 &./'-]{2,60}?)(?:\s+for\b|\s+on\b|\s+regarding\b|[,.;]|$)/);
  if (paidToMatch) return clean(paidToMatch[1]);
  const actor = clean(fact.actor);
  if (payeeActorAcceptable(actor)) return actor;
  const toMatch = String(text || "").match(/\b(?:to|for)\s+([A-Z][A-Za-z0-9 &./'-]{2,60})(?:\s+for|\s+on|\s+regarding|[,.;]|$)/);
  return clean(toMatch?.[1] || "");
}

function feeFactLooksLikePickupQuote(fact = {}) {
  const text = sourceFactText(fact);
  const stationFeeContext = /\b(?:cargosprint|cargo sprint|station|terminal|ground|handling|warehouse|forward air|wfs|swissport|air general|import service charge|storage|lfd|last free|payment delivered|receipt|invoice)\b/i.test(text);
  const pickupQuoteContext = /\b(?:pickup|broker|carrier|driver|truck|jd direct|sd direct|rapid|flitepak|quote|rate|award|approved)\b/i.test(text);
  return pickupQuoteContext && amountValuesFromText(text).length > 0 && !stationFeeContext;
}

function storageRateAmountsFromText(text = "") {
  // "$40/day" or "rate: $40 per day" is a storage RATE rule, not an accrued
  // charge. Rate amounts stay out of the charge ledger unless the same fact
  // proves storage is actually due/accruing.
  const value = String(text || "");
  if (currentStorageDueEvidence(value)) return [];
  const amounts = [];
  const pattern = /\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:\/\s*|\s+per\s+)day\b/gi;
  for (const match of value.matchAll(pattern)) {
    const amount = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(amount)) amounts.push(amount);
  }
  return amounts;
}

function storageRateOnlyFact(fact = {}) {
  const text = sourceFactText(fact);
  const rateAmounts = storageRateAmountsFromText(text);
  if (!rateAmounts.length) return false;
  const rateKeys = new Set(rateAmounts.map(amountKey));
  return currentFeeAmountValuesFromFact(fact).every((amount) => rateKeys.has(amountKey(amount)));
}

function feeChargeFact(fact = {}) {
  const text = sourceFactText(fact);
  if (feeFactLooksLikePickupQuote(fact)) return false;
  // Generated canonical narratives quote amounts from context ("the arrival
  // notice created the $100 CVF charge…") — our own summaries never MINT
  // charges; a real charge has a real source fact (016-80000154: the
  // canonical-arrival story kept a phantom $100 due after the receipt).
  if (/^canonical-/i.test(String(fact.type || ""))) return false;
  if (storageRateOnlyFact(fact)) return false;
  // Post-pickup waiting/detention/layover cost is a cost RISK (storageRisk),
  // never an unpaid ground-handler release fee.
  if (waitingCostMatch(text)) return false;
  const feeContext = /\b(?:station|terminal|ground|handling|warehouse|storage|lfd|last free|import service charge|charges?|invoice|balance due|pay(?:ment)? due|cargosprint|cargo sprint|forward air|wfs|swissport|air general|cvf)\b/i.test(text);
  const dueContext = /\b(?:due|unpaid|outstanding|balance|invoice|charge|charges|pay\b|needs? payment|storage accru|storage begins|no\s+(?:\w+\s+){0,3}receipt|fee status (?:is )?open)\b/i.test(text);
  // A TARIFF ANNOUNCEMENT ("CVF will increase to $100 per MAWB effective
  // Jan 19, 2026") is a rate rule, never an accrued charge on this shipment —
  // boilerplate inside arrival notices minted phantom $100 charges
  // (016-80000154).
  const tariffAnnouncement =
    /\bwill (?:increase|change|rise|be adjusted|go up)\b[^.;\n]{0,80}\beffective\b/i.test(text) ||
    (/\bper\s+(?:mawb|awb|hawb|shipment|kg|unit)\b/i.test(text) && /\beffective\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i.test(text));
  if (tariffAnnouncement) return false;
  return feeContext && dueContext && !futureStorageChargeOnlyFact(fact);
}

function feePaymentSentenceEvidence(text = "") {
  // Payment truth is sentence-scoped: one sentence with executed-payment vocab
  // and no negation in that sentence. A vendor name (CargoSprint) or the word
  // "receipt" inside "no receipt exists yet" is not payment proof
  // (live case 016-80000154: a doc-request escalation flipped fees to paid).
  const sentences = String(text || "").split(/(?<=[.!?;])\s+/);
  return sentences.some((sentence) =>
    /\b(?:payments? (?:was |were |is |are )?(?:delivered|sent|confirmed|received|completed|processed)|payment confirm(?:ation|ed)|receipt (?:is )?(?:attached|received|issued|enclosed)|paid)\b/i.test(sentence) &&
    !/\b(?:no|not|without|missing|awaiting|pending|need(?:s|ed)?|must be|to be|hasn'?t|has not|isn'?t|never|before|until|unless|once)\b/i.test(sentence));
}

function feePaymentFact(fact = {}) {
  const text = sourceFactText(fact);
  if (feeFactLooksLikePickupQuote(fact)) return false;
  // A TYPED fees-paid fact came through the payment-gated extractor (real
  // receipt evidence); re-litigating its generic summary with sentence regex
  // dropped real payments (016-80000154: "Ground handling fees/payment were
  // confirmed" — passive plural missed the pattern, ledger said due, gate said
  // paid, contradiction shipped).
  const type = String(fact.type || "").toLowerCase();
  if (/^ground[-_\s]?fees[-_\s]?paid$/.test(type)) return true;
  if (/^canonical-fees$/.test(type) && /\b(?:done|paid|confirmed)\b/i.test(String(fact.claim || fact.summary || ""))) return true;
  const stationContext = /\b(?:station|terminal|ground|handling|warehouse|storage|import service|cargosprint|cargo sprint|forward air|wfs|swissport|air general|payment delivered)\b/i.test(text);
  return stationContext && feePaymentSentenceEvidence(text);
}

function remainingBalanceFromFact(fact = {}) {
  const text = sourceFactText(fact);
  const match = text.match(/\b(?:remaining balance|balance due|still due|outstanding)\b[^$]{0,90}(?:USD\s*)?\$\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

function normalizedFeeClaimKey(text = "") {
  // One real-world assertion often arrives with its sentences doubled or
  // echoed across facts; sentence-deduped normalized text identifies it.
  const sentences = String(text || "")
    .toLowerCase()
    .split(/(?<=[.!?;])\s+/)
    // Gate-status echoes prefix the same claim with "done:"/"pending:"; strip
    // the prefix so the echo collapses with the original.
    .map((sentence) => sentence.trim().replace(/^(?:done|pending|blocked|unknown|true|false)\s*:\s*/, "").replace(/\s+/g, " "))
    .filter(Boolean);
  return unique(sentences).join(" ").slice(0, 160);
}

function feeMessageRef(fact = {}) {
  const ref = fact.sourceRef || {};
  return clean(ref.messageId || ref.threadId) ||
    (String(fact.id || "").match(/\b[0-9a-f]{16}\b/i)?.[0] || "");
}

function feeFactCitesForeignAwbOnly(fact = {}, shipmentAwbKey = "") {
  if (!shipmentAwbKey) return false;
  const text = sourceFactText(fact);
  const cited = [];
  for (const match of text.matchAll(/\b(\d{3})[-\s](\d{8})\b/g)) {
    const key = normalizeAwb(`${match[1]}-${match[2]}`);
    if (key) cited.push(key);
  }
  // Suffix-only citations ("Payment delivered for 43985141") are how
  // CargoSprint and stations reference the AWB — the bare suffix of THIS
  // shipment is an own-citation, never foreign.
  const suffix = shipmentAwbKey.slice(3);
  for (const match of text.matchAll(/\b(\d{8})\b/g)) {
    if (match[1] === suffix) cited.push(shipmentAwbKey);
  }
  return cited.length > 0 && !cited.includes(shipmentAwbKey);
}

function feeLedgerEntry(fact = {}, kind = "", shipmentAwb = "") {
  const text = sourceFactText(fact);
  const excludedFutureStorageAmounts = futureStorageChargeAmountsFromText(text, factReferenceDayMs(fact));
  const rawAmounts = kind === "charge_notice" ? currentFeeAmountValuesFromFact(fact) : amountValuesFromText(text);
  return {
    id: fact.id,
    kind,
    awb: shipmentAwb || "",
    payee: payeeFromFeeFact(fact, text),
    // A repeated identical amount inside one fact is an echo, not a second fee.
    amounts: unique(rawAmounts.map(amountKey)).filter(Boolean).map(Number),
    excludedFutureStorageAmounts: excludedFutureStorageAmounts.map(amountKey).filter(Boolean),
    observedAt: fact.observedAt || fact.capturedAt || "",
    sourceSystem: fact.sourceSystem || "",
    messageRef: feeMessageRef(fact),
    // Identity comes from the claim itself — type/actor prefixes vary across
    // pipelines that echo the same real-world assertion.
    claimKey: normalizedFeeClaimKey(clean(fact.claim || fact.rawSnippet || "")),
    snippet: clean(fact.claim || fact.rawSnippet).slice(0, 180),
  };
}

function collapseFeeEntries(entries = []) {
  // Same normalized claim (or same source message when the claim is empty)
  // means the same real-world fee event, however many fact types echo it.
  // An entry matches a group when EITHER its source message or its normalized
  // claim matches — echoes arrive both as multi-type facts off one message and
  // as message-less ledger rows with the same claim text.
  const groups = [];
  const byKey = new Map();
  for (const entry of entries) {
    const keys = [
      entry.messageRef ? `m:${entry.messageRef}` : "",
      entry.claimKey ? `c:${entry.claimKey}` : "",
    ].filter(Boolean);
    if (!keys.length) keys.push(`i:${entry.id}`);
    let group = keys.map((key) => byKey.get(key)).find(Boolean);
    if (!group) {
      group = { ...entry, duplicateFactIds: [] };
      groups.push(group);
    } else {
      group.duplicateFactIds.push(entry.id);
      if (!group.payee && entry.payee) group.payee = entry.payee;
      if (!group.messageRef && entry.messageRef) group.messageRef = entry.messageRef;
      if (!group.claimKey && entry.claimKey) group.claimKey = entry.claimKey;
      group.amounts = unique([...group.amounts, ...entry.amounts].map(amountKey)).filter(Boolean).map(Number);
    }
    for (const key of keys) byKey.set(key, group);
    if (group.messageRef) byKey.set(`m:${group.messageRef}`, group);
    if (group.claimKey) byKey.set(`c:${group.claimKey}`, group);
  }
  return groups;
}

function feeLedgerReconciliation(shipment = {}, gates = [], sourceFacts = []) {
  const byGate = gateByName(gates);
  const shipmentAwbKey = normalizeAwb(shipment.awb || shipment.id);
  // A fee amount observed on another AWB's paperwork must never enter this
  // shipment's ledger (live case: 016-80000120's $40/day storage rule counted
  // as a charge on 016-80000154). EXCEPTION: group-movement facts ("both
  // shipments", "2 המטענים") cite sibling AWBs by nature — a propagated group
  // fact is never foreign (live case: the sibling's AWB in a retained quote
  // got 114-80000270's storage risk excluded while 342 kept it).
  const { groupMovementReference } = require("./delivery-wait");
  const foreignAwbFacts = sourceFacts.filter((fact) =>
    feeFactCitesForeignAwbOnly(fact, shipmentAwbKey) &&
    !groupMovementReference(sourceFactText(fact)).together);
  const foreignAwbFactIds = new Set(foreignAwbFacts.map((fact) => fact.id));
  const eligibleFacts = sourceFacts.filter((fact) => !foreignAwbFactIds.has(fact.id));
  const paymentFacts = eligibleFacts.filter(feePaymentFact);
  // Later REAL payment proof supersedes stale narrative text: a charge whose
  // only source is a manual/narrative story older than the newest typed
  // payment is history, not an open balance (016-80000154: the Jul-2 manual
  // narrative kept a $100 due after the Jul-3 CargoSprint receipt).
  const latestTypedPaymentAt = paymentFacts
    .filter((fact) => /^(?:ground[-_\s]?fees[-_\s]?paid|canonical-fees)$/i.test(String(fact.type || "")))
    .map((fact) => Date.parse(fact.observedAt || fact.capturedAt || "") || 0)
    .sort((a, b) => b - a)[0] || 0;
  const chargeFacts = eligibleFacts.filter(feeChargeFact).filter((fact) => {
    if (!latestTypedPaymentAt) return true;
    const narrative = /^(?:manual-gmail-truth|manual|note)$/i.test(String(fact.type || ""));
    const factAt = Date.parse(fact.observedAt || fact.capturedAt || "") || 0;
    return !(narrative && factAt && factAt < latestTypedPaymentAt);
  });
  const storageRiskFacts = eligibleFacts.filter((fact) => storageRateOnlyFact(fact) || Boolean(waitingCostMatch(sourceFactText(fact))));
  const chargeNotices = collapseFeeEntries(chargeFacts.map((fact) => feeLedgerEntry(fact, "charge_notice", shipmentAwbKey)));
  const payments = collapseFeeEntries(paymentFacts.map((fact) => feeLedgerEntry(fact, "payment", shipmentAwbKey)));
  const remainingBalances = eligibleFacts
    .map((fact) => {
      const amount = remainingBalanceFromFact(fact);
      return amount == null ? null : { factId: fact.id, amount, observedAt: fact.observedAt || fact.capturedAt || "" };
    })
    .filter(Boolean);
  // One real-world charge often appears in several source facts (charge notice,
  // payment-context echo, storage summary). Counting each mention doubles the
  // balance, so identical amount+payee pairs collapse to one charge.
  const chargeAmounts = [];
  const seenCharges = new Set();
  for (const entry of chargeNotices) {
    for (const amount of entry.amounts) {
      const key = `${amountKey(amount)}|${(entry.payee || "").toLowerCase()}`;
      if (seenCharges.has(key)) continue;
      seenCharges.add(key);
      chargeAmounts.push({ amount, entry });
    }
  }
  // Payments collapse the same way: identical amount+payee across echoed facts
  // is one payment, not several (live case: one $230 CargoSprint payment on
  // 114-80000269 echoed as seven ledger rows).
  const paymentAmounts = [];
  const seenPayments = new Set();
  for (const entry of payments) {
    for (const amount of entry.amounts) {
      const key = `${amountKey(amount)}|${(entry.payee || "").toLowerCase()}`;
      if (seenPayments.has(key)) continue;
      seenPayments.add(key);
      paymentAmounts.push({ amount, entry });
    }
  }
  const matches = [];
  for (const payment of paymentAmounts) {
    const matchedCharge = chargeAmounts.find((charge) =>
      amountKey(charge.amount) === amountKey(payment.amount) &&
        (!charge.entry.payee || !payment.entry.payee || charge.entry.payee.toLowerCase() === payment.entry.payee.toLowerCase())
    ) || chargeAmounts.find((charge) => amountKey(charge.amount) === amountKey(payment.amount));
    matches.push({
      paymentFactId: payment.entry.id,
      chargeFactId: matchedCharge?.entry?.id || "",
      amount: payment.amount,
      payee: payment.entry.payee || matchedCharge?.entry?.payee || "",
      basis: matchedCharge ? "amount-payee" : "payment-only",
    });
  }
  const chargedTotal = chargeAmounts.reduce((sum, row) => sum + row.amount, 0);
  const paidTotal = paymentAmounts.reduce((sum, row) => sum + row.amount, 0);
  const remainingBalance = remainingBalances.length
    ? remainingBalances.sort((a, b) => Date.parse(b.observedAt || "") - Date.parse(a.observedAt || ""))[0].amount
    : chargedTotal && paidTotal < chargedTotal
      ? Number((chargedTotal - paidTotal).toFixed(2))
      : null;
  const gateText = gateStatusText(byGate.fees);
  const gateAcceptedPayment = /\b(?:done|paid|true|received|confirmed)\b/.test(gateText);
  const explicitBalanceProven = remainingBalances.length > 0;
  let status = "unknown";
  if (explicitBalanceProven && remainingBalance != null && remainingBalance > 0) status = paidTotal > 0 ? "partial" : "due";
  else if (paymentFacts.length && (!chargeFacts.length || !chargedTotal || paidTotal >= chargedTotal)) status = "paid";
  // A hard "due" requires a proven unpaid balance. Payment evidence whose amount
  // could not be machine-read, corroborated by an accepted fees gate, downgrades
  // to "verify" instead of blocking the shipment on arithmetic we cannot do.
  else if (chargeAmounts.length && paymentFacts.length && gateAcceptedPayment) status = "verify";
  else if (chargeAmounts.length && !paymentFacts.length) status = "due";
  else if (chargeAmounts.length) status = "verify";
  else if (gateAcceptedPayment) status = "paid";
  // A merely "pending" gate with no visible charge is not a proven debt.
  else if (/\b(?:due|unpaid|invoice|balance)\b/.test(gateText)) status = "due";
  return {
    status,
    chargeNotices,
    payments,
    matches,
    remainingBalance,
    // Storage rate rules are exposure risk, not accrued charges.
    storageRisk: collapseFeeEntries(storageRiskFacts.map((fact) => {
      const entry = feeLedgerEntry(fact, "storage_rate_rule", shipmentAwbKey);
      return { ...entry, amounts: unique(storageRateAmountsFromText(sourceFactText(fact)).map(amountKey)).filter(Boolean).map(Number) };
    })),
    excludedForeignAwbFactIds: [...foreignAwbFactIds],
    payees: unique([...chargeNotices, ...payments].map((entry) => entry.payee).filter(Boolean)),
    amounts: unique([...chargeAmounts, ...paymentAmounts].map((row) => amountKey(row.amount)).filter(Boolean)),
    sourceFactIds: sourceFactIds([...chargeFacts, ...paymentFacts, ...remainingBalances.map((row) => sourceFacts.find((fact) => fact.id === row.factId)).filter(Boolean)]),
    reason: status === "paid"
      ? "Station/ground fee payment proof is matched or gate is paid."
      : status === "partial"
        ? "Payment proof exists but a remaining balance is still visible."
        : status === "due"
          ? "Station/ground fee charge or unpaid balance is visible."
          : status === "verify"
            ? "Payment is reported but the amount could not be verified against the visible charge."
            : "No station-fee charge/payment proof is visible.",
  };
}

function documentRequestFact(fact = {}) {
  const text = sourceFactText(fact);
  // `gmail-proof` rows summarize every signal seen anywhere in one thread.
  // Combined labels such as "Release/DO, Quote, Status request evidence found"
  // are context, not an event-level request, and must never reopen a resolved
  // document blocker when their timestamp is refreshed by unrelated movement.
  const aggregateProofSummary = /^gmail-proof$/i.test(String(fact.type || "")) &&
    /\bevidence found in Gmail thread\b/i.test(text);
  if (aggregateProofSummary) return false;
  const docContext = /\b(?:3461|7501|delivery order|d\/?o|d\.?o\.?|release packet|pickup docs?|documents?|docs?|awb copy)\b/i.test(text);
  const requestContext = /\b(?:ask(?:s|ed|ing)?|need|needs|needed|required|please send|pls send|kindly send|send us|send over|provide|request|waiting for|missing|not received|generate\/send|generate and send)\b/i.test(text);
  const preAlertRequestContext = /\bsent\s+(?:a\s+)?(?:customs\/)?pre[-\s]?alert\b[\s\S]{0,180}\b(?:ask(?:s|ed)?|request(?:s|ed)?|need(?:s|ed)?|please|send|provide)\b/i.test(text);
  const resolutionContext = !preAlertRequestContext &&
    /\b(?:sent|attached|forwarded|received|broker received|released|cleared|issued|banked|1c|1i cbp hold removed)\b/i.test(text);
  return docContext && requestContext && !resolutionContext;
}

function documentResolutionFact(fact = {}) {
  const text = sourceFactText(fact);
  const docContext = /\b(?:3461|7501|delivery order|d\/?o|d\.?o\.?|release\/?d\.?o|release\/?do|release packet|pickup docs?|documents?|docs?|awb copy|clearance|customs release)\b/i.test(text);
  const preAlertRequestContext = /\b(?:sent\s+(?:a\s+)?(?:customs\/)?pre[-\s]?alert|pre[-\s]?alert\b[\s\S]{0,140}\bask(?:s|ed)?)\b[\s\S]{0,180}\b(?:send|provide|3461|7501|documents?|docs?|delivery order|d\/?o)\b/i.test(text);
  const negatedResolutionContext = /\b(?:does not|doesn't|not)\s+(?:resolve|satisfy|complete|close)\b[\s\S]{0,80}\b(?:document|docs?|request|delivery order|d\/?o)\b/i.test(text);
  const resolutionContext = !preAlertRequestContext &&
    !negatedResolutionContext &&
    /\b(?:sent|attached|forwarded|provided|broker received|received by broker|received|released|cleared|issued|banked|1c|1i cbp hold removed|cargo is now released|delivery order and release|deli order and release)\b/i.test(text);
  const preAlertOnly = /\b(?:pre[-\s]?alert|customs\/pre[-\s]?alert|pre[-\s]?alert documents?)\b/i.test(text) &&
    !/\b(?:3461|7501|delivery order|d\/?o|d\.?o\.?|release\/?d\.?o|release\/?do|release packet|pickup docs?|awb copy|1c|released|cleared)\b/i.test(text);
  const staleRequestOnly = /\b(?:please send|need|needs|needed|required|waiting for|missing|not received)\b/i.test(text) &&
    !/\b(?:sent|attached|forwarded|provided|broker received|released|cleared|issued|banked|1c|1i cbp hold removed)\b/i.test(text);
  return docContext && resolutionContext && !staleRequestOnly && !preAlertOnly;
}

function documentRequestBlocker(shipment = {}, sourceFacts = []) {
  const requests = sourceFacts.filter(documentRequestFact);
  const resolutions = sourceFacts.filter(documentResolutionFact);
  const latestRequest = latestSourceFact(requests, () => true);
  const latestResolution = latestSourceFact(resolutions, () => true);
  if (!latestRequest) {
    return {
      status: "none",
      active: false,
      sourceFactIds: [],
      supersededBySourceFactIds: sourceFactIds(latestResolution ? [latestResolution] : []),
      reason: "No active document request source fact is visible.",
    };
  }
  const requestAt = sourceFactTimeMs(latestRequest);
  const resolutionAt = sourceFactTimeMs(latestResolution);
  const resolved = Boolean(latestResolution && (!requestAt || !resolutionAt || resolutionAt >= requestAt));
  return {
    status: resolved ? "resolved" : "active",
    active: !resolved,
    latestRequestAt: latestRequest.observedAt || latestRequest.capturedAt || "",
    latestResolutionAt: latestResolution?.observedAt || latestResolution?.capturedAt || "",
    sourceFactIds: sourceFactIds([latestRequest]),
    supersededBySourceFactIds: sourceFactIds(resolved ? [latestResolution] : []),
    reason: resolved
      ? "Later sent-docs/release/DO/broker-received proof supersedes the older document request."
      : "Latest document request has no later sent-docs/release/DO/broker-received proof.",
  };
}

function movementSplitSpecificity(fact = {}) {
  const text = sourceFactText(fact);
  let score = 0;
  if (/manual[-_\s]?gmail[-_\s]?truth|gmail/i.test(`${fact.type || ""} ${fact.sourceSystem || ""} ${fact.sourceRef?.source || ""}`)) score += 20;
  if (/\b(?:another split|only\s+\d+\s*(?:pcs?|pieces?)|\d+\s*(?:pcs?|pieces?)\s+(?:were\s+)?built|LY\d+(?:\/\d+)?)\b/i.test(text)) score += 50;
  if (/canonical[-_\s]?risk|automation/i.test(`${fact.type || ""} ${fact.sourceSystem || ""} ${fact.sourceRef?.source || ""}`)) score -= 30;
  return score;
}

function latestMovementSplitFact(sourceFacts = []) {
  return sourceFacts
    .filter((fact) => /\b(?:movement[-_\s]?split[-_\s]?offload|another split|split\/offloaded|split shipment|\d+\s*(?:pcs?|pieces?)\s+(?:were\s+)?built)\b/i.test(sourceFactText(fact)))
    .sort((a, b) => movementSplitSpecificity(b) - movementSplitSpecificity(a) || sourceFactTimeMs(b) - sourceFactTimeMs(a))[0] || null;
}

function physicalLifecycleFromShipment(shipment = {}, gates = [], sourceFacts = []) {
  const byGate = gateByName(gates);
  const phase = clean(shipment.opsState?.phase || shipment.stage || shipment.currentState).toLowerCase().replace(/_/g, "-");
  const text = shipmentEvidenceText(shipment, sourceFacts);
  const idsFor = (pattern) => sourceFactIdsMatching(sourceFacts, pattern);
  const pickupExecutionText = /\b(?:picked[-\s]?up|driver (?:is )?(?:now )?loaded|driver loaded|loaded and (?:will|en route|departed)|cargo (?:was |is )?loaded|recovered|driver left|airport-picked-up)\b/i.test(text) &&
    !pickupExecutionNegatedText(text) &&
    !/\b(?:collect|get|need|needs|needed|pending|waiting for|verify|confirm)\b[^.;\n]{0,90}\b(?:loaded proof|pickup proof|proof\/pod|proof|pod)\b/i.test(text);
  const positiveArrival = positiveArrivalFactWins(sourceFacts);
  const positiveArrivalAt = sourceFactTimeMs(positiveArrival);
  const onwardTransfer = latestSourceFact(sourceFacts, (fact) => {
    const factTextValue = sourceFactText(fact);
    if (!onwardTransferSourceText(factTextValue)) return false;
    const proofSummaryEcho = /^gmail-proof$/i.test(String(fact.type || "")) &&
      /\b(?:handler transfer|onward[-\s]?flight|will be loaded|loaded for flight)\b/i.test(factTextValue);
    return !(positiveArrival && proofSummaryEcho && sourceFactTimeMs(fact) >= positiveArrivalAt);
  });
  const onwardTransferAt = sourceFactTimeMs(onwardTransfer);
  const gateSaysNotArrived = byGate.arrival?.status !== "true" &&
    /\b(?:not[-\s]?arrived|in[-\s]?transit|departed|waiting|pending|destination delivery is not proven|onward[-\s]?flight|handler transfer|continues? to [A-Z]{3})\b/i.test(
      `${byGate.arrival?.rawStatus || ""} ${byGate.arrival?.reason || ""}`,
    );
  if (hasUnresolvedTerminalRecoveryBlocker(shipment, sourceFacts) || /delivery[-\s]?blocked|wrong-consignee/.test(phase)) {
    return { status: "delivery_blocked", label: "Delivery blocked", sourceFactIds: idsFor(/\b(?:wrong[-\s]?consignee|delivery[-\s]?blocked|mis[-\s]?deliver|delivered by mistake)\b/i), reason: "Delivery/recovery blocker is the latest physical truth." };
  }
  if (byGate.pod?.status === "true" || /^(?:completed|closed|closeout)$/.test(phase)) {
    return { status: "closed", label: "Closed", sourceFactIds: byGate.pod?.sourceFactIds || [], reason: "POD/closeout proof is complete." };
  }
  if (byGate.delivery?.status === "true" || /^delivered/.test(phase)) {
    return { status: "delivered", label: "Delivered", sourceFactIds: byGate.delivery?.sourceFactIds || [], reason: "Delivery is confirmed; POD may still be pending." };
  }
  const explicitOutForDelivery =
    /\b(?:out[-\s]?for[-\s]?delivery|out for del|\bofd\b)\b/i.test(text) ||
    /out-for-delivery/.test(phase) ||
    /^(?:out[-_\s]?for[-_\s]?delivery|ofd)$/i.test(clean(byGate.delivery?.rawStatus || byGate.delivery?.status));
  if (explicitOutForDelivery && byGate.arrival?.status === "true" && byGate.pickup?.status === "true") {
    return { status: "out_for_delivery", label: "Out for delivery", sourceFactIds: idsFor(/\b(?:out[-\s]?for[-\s]?delivery|delivery[-\s]?scheduled|deliver(?:y)? tomorrow|delivery today)\b/i), reason: "Post-pickup delivery movement is visible." };
  }
  if (byGate.pickup?.status === "true" || pickupExecutionText || /picked-up|loaded|recovered|pod-needed/.test(phase)) {
    return { status: "picked_up", label: "Picked up", sourceFactIds: byGate.pickup?.sourceFactIds || idsFor(/\b(?:picked[-\s]?up|loaded|recovered|driver left)\b/i), reason: "Pickup/recovery proof is visible." };
  }
  if (/\b(?:pickup[-\s]?scheduled|pickup[-\s]?dispatched|driver[-\s]?onsite|driver onsite|on site picking up)\b/i.test(text) || /pickup-scheduled|pickup-dispatched|driver-onsite/.test(phase)) {
    return { status: "pickup_scheduled", label: "Pickup scheduled", sourceFactIds: idsFor(/\b(?:pickup[-\s]?scheduled|pickup[-\s]?dispatched|driver[-\s]?onsite|on site picking up)\b/i), reason: "Pickup execution is scheduled or onsite." };
  }
  const hardTransit =
    byGate.arrival?.rawStatus && /\b(?:not[-\s]?arrived|in[-\s]?transit|departed|waiting|pending)\b/i.test(byGate.arrival.rawStatus) ||
    /\b(?:pre[-\s]?arrival|in[-\s]?transit|not[-\s]?arrived|not at destination|not in (?:our|the|their) system|destination arrival is not proven|onward[-\s]?flight|continues? to [A-Z]{3}|scheduled arrival)\b/i.test(text) ||
    /pre-arrival|in-transit|not-arrived|arrival-watch/.test(phase);
  if (
    onwardTransfer &&
    (!positiveArrival || !positiveArrivalAt || !onwardTransferAt || onwardTransferAt >= positiveArrivalAt) &&
    byGate.delivery?.status !== "true"
  ) {
    return {
      status: "in_transit",
      label: "In transit",
      sourceFactIds: [onwardTransfer.id].filter(Boolean),
      reason: onwardTransfer.claim || "Connection/handler transfer continues to the destination; destination arrival is not proven yet.",
    };
  }
  if (hardTransit && byGate.arrival?.status !== "true" && (!positiveArrival || gateSaysNotArrived)) {
    return { status: "in_transit", label: "In transit", sourceFactIds: byGate.arrival?.sourceFactIds || idsFor(/\b(?:pre[-\s]?arrival|in[-\s]?transit|not[-\s]?arrived|eta|scheduled arrival|onward[-\s]?flight|continues? to [A-Z]{3})\b/i), reason: "Physical destination arrival is not proven yet." };
  }
  if (positiveArrival || byGate.arrival?.status === "true" || /\b(?:arrived|arrival|on[-\s]?hand|available for pickup|at station|at terminal)\b/i.test(text) || /arrived|arrival|station|available/.test(phase)) {
    return {
      status: "arrived",
      label: "Arrived",
      sourceFactIds: positiveArrival?.id ? [positiveArrival.id] : byGate.arrival?.sourceFactIds || idsFor(/\b(?:arrived|arrival|on[-\s]?hand|available for pickup|at station|at terminal)\b/i),
      reason: positiveArrival?.claim || "Destination station/arrival proof is visible.",
    };
  }
  if (/release-needed|fees-needed|customs|pickup-docs-needed|awb-copy-needed|pickup-location-requested/.test(phase) && byGate.arrival?.status !== "true") {
    return { status: "in_transit", label: "In transit", sourceFactIds: byGate.arrival?.sourceFactIds || [], reason: "Operational blocker exists, but physical destination arrival is not proven." };
  }
  // Departure/rebooking movement evidence (split sagas: "departed on LY843", "rebooked on",
  // "offloaded from") proves the freight is moving even when the operator lane is an
  // exception — without arrival proof that is in-transit, not unknown.
  if (byGate.arrival?.status !== "true" &&
    /\b(?:departed on|rebooked on|offloaded from|booked on\s+[A-Z]{2}\s*\d|pieces? departed)\b/i.test(text)) {
    return { status: "in_transit", label: "In transit", sourceFactIds: idsFor(/\b(?:departed|rebooked|offloaded|booked on)\b/i), reason: "Departure/rebooking evidence shows the freight moving; destination arrival is not proven." };
  }
  return { status: "unknown", label: "Unknown", sourceFactIds: [], reason: "No decisive physical lifecycle proof is visible." };
}

function operationalBlockerFromShipment(shipment = {}, gates = [], sourceFacts = [], feeLedger = {}, docBlocker = {}, physicalLifecycle = {}) {
  const byGate = gateByName(gates);
  const phase = clean(shipment.opsState?.phase || shipment.stage || shipment.currentState).toLowerCase();
  const none = {
    type: "none",
    status: "clear",
    label: "No operational blocker",
    severity: "none",
    sourceFactIds: [],
    reason: "No active blocker is visible after reconciliation.",
  };
  if (hasUnresolvedTerminalRecoveryBlocker(shipment, sourceFacts) || byGate.delivery?.status === "blocked" || byGate.pod?.status === "blocked") {
    return {
      type: "delivery_recovery",
      status: "blocked",
      label: "Delivery recovery needed",
      severity: "critical",
      sourceFactIds: sourceFactIdsMatching(sourceFacts, /\b(?:wrong[-\s]?consignee|delivery[-\s]?blocked|mis[-\s]?deliver|delivered by mistake)\b/i),
      reason: "Normal delivery/POD closeout is blocked by recovery evidence.",
    };
  }
  const terminal = ["delivered", "completed", "closed"].includes(String(physicalLifecycle.status || "").toLowerCase()) ||
    gateResolvedStatusIs(byGate.delivery, ["true", "done", "delivered", "completed", "closed"]) ||
    gateResolvedStatusIs(byGate.pod, ["true", "done", "received", "pod-found", "found"]) ||
    /^(?:delivered|completed|closed)$/.test(phase);
  if (terminal) return none;
  const movementSplit = latestMovementSplitFact(sourceFacts);
  if (movementSplit && physicalLifecycle.status === "in_transit") {
    return {
      type: "movement_split",
      status: "blocked",
      label: "Movement split",
      severity: "attention",
      sourceFactIds: [movementSplit.id].filter(Boolean),
      reason: movementSplit.claim || "Shipment split/offloaded/rebooked; revised arrival or piece availability is needed.",
    };
  }
  // The reconciled customs gate outranks a stale hold-phase echo: an explicit
  // "done" (e.g. an operator-recorded release) means the hold is over even if
  // the phase string hasn't caught up yet.
  if ((/customs[-\s]?hold/.test(phase) && byGate.customs?.status !== "true") || byGate.customs?.status === "blocked") {
    return {
      type: "customs_hold",
      status: "blocked",
      label: "Customs hold",
      severity: "critical",
      sourceFactIds: byGate.customs?.sourceFactIds || [],
      reason: byGate.customs?.reason || "Customs/release gate is blocked.",
    };
  }
  if (docBlocker.active || /pickup-docs-needed|awb-copy-needed|pickup-location-requested/.test(phase) && docBlocker.status !== "resolved") {
    return {
      type: "document_request",
      status: "blocked",
      label: "Documents needed",
      severity: "attention",
      sourceFactIds: docBlocker.sourceFactIds || [],
      reason: docBlocker.reason || "Document request is still open.",
    };
  }
  if (byGate.pickup?.status === "blocked" || /pickup[-\s]?blocked|loading[-\s]?blocked|cargo[-\s]?not[-\s]?found/.test(phase)) {
    return {
      type: "pickup_blocked",
      status: "blocked",
      label: "Pickup blocked",
      severity: "critical",
      sourceFactIds: byGate.pickup?.sourceFactIds || [],
      reason: byGate.pickup?.reason || "Pickup/station availability is blocked.",
    };
  }
  if (["due", "partial"].includes(feeLedger.status) || byGate.fees?.status === "due" || /fees-needed/.test(phase) && !["paid", "verify"].includes(feeLedger.status)) {
    return {
      type: "fees_due",
      status: feeLedger.status === "partial" ? "partial" : "blocked",
      label: feeLedger.status === "partial" ? "Fee balance due" : "Fees due",
      severity: "attention",
      sourceFactIds: feeLedger.sourceFactIds || byGate.fees?.sourceFactIds || [],
      reason: feeLedger.reason || byGate.fees?.reason || "Ground/station fee is not reconciled as paid.",
      remainingBalance: feeLedger.remainingBalance,
    };
  }
  if (feeLedger.status === "verify") {
    // Advisory: payment evidence exists (gate accepted it) but the amount could
    // not be verified. This must not hard-block a ready shipment; it rides along
    // as a verify task and is recorded in the packet's state derivation.
    return {
      type: "fee_verification",
      status: "advisory",
      label: "Verify fee payment",
      severity: "info",
      sourceFactIds: feeLedger.sourceFactIds || byGate.fees?.sourceFactIds || [],
      reason: feeLedger.reason,
      remainingBalance: feeLedger.remainingBalance,
    };
  }
  if (byGate.customs?.status !== "true" && (/release-needed|customs/.test(phase) || physicalLifecycle.status === "arrived")) {
    return {
      type: "release_needed",
      status: "blocked",
      label: "Release/DO needed",
      severity: "attention",
      sourceFactIds: byGate.customs?.sourceFactIds || [],
      reason: byGate.customs?.reason || "Release/DO is not proven.",
    };
  }
  if (!dispatchGateResolved(byGate.dispatch) && physicalLifecycle.status === "arrived" && byGate.customs?.status === "true" && feeLedger.status !== "due") {
    const granular = dispatchBlockerSubtype(byGate);
    return {
      type: "dispatch_needed",
      subtype: granular.subtype,
      status: "blocked",
      label: granular.label,
      severity: "attention",
      sourceFactIds: byGate.dispatch?.sourceFactIds || [],
      reason: byGate.dispatch?.reason ||
        (granular.subtype === "broker_alerted_ack_needed"
          ? "The pickup alert was sent; the broker has not acknowledged/accepted yet."
          : granular.subtype === "broker_quoted_award_needed"
            ? "A pickup quote is in; the award decision has not been recorded."
            : "Pickup owner/dispatch path is not proven."),
    };
  }
  // Execution-phase granularity: dispatch is resolved but pickup/delivery is not finished.
  // Not a blocker (fixture semantics keep type none), but the subtype/label lets the UI and
  // planner say exactly what is being waited on instead of a generic ready state.
  const terminalDelivery = gateResolvedStatusIs(byGate.delivery, ["true", "done", "delivered", "completed", "closed"]) ||
    gateResolvedStatusIs(byGate.pod, ["true", "done", "received", "pod-found", "found"]) ||
    /\b(?:delivered|closed)\b/.test(String(physicalLifecycle.status || ""));
  const executionPhaseEligible = ["arrived", "pickup_scheduled", "picked_up", "out_for_delivery"]
    .includes(String(physicalLifecycle.status || "").toLowerCase());
  if (dispatchGateResolved(byGate.dispatch) && executionPhaseEligible && !terminalDelivery) {
    const granular = dispatchBlockerSubtype(byGate);
    if (granular.subtype !== "broker_missing") {
      return {
        ...none,
        subtype: granular.subtype,
        label: granular.label,
      };
    }
  }
  return none;
}

function truthStateFromShipment(shipment = {}, gates = [], sourceFacts = [], physicalLifecycle = null, operationalBlocker = null) {
  const phase = clean(shipment.opsState?.phase || shipment.stage || shipment.currentState).toLowerCase();
  const byGate = gateByName(gates);
  const physical = physicalLifecycle || physicalLifecycleFromShipment(shipment, gates, sourceFacts);
  const blocker = operationalBlocker || { type: "none" };
  if (physical.status === "delivery_blocked") return "delivery_blocked";
  if (physical.status === "closed") return "closed";
  if (physical.status === "delivered") return "delivered";
  if (physical.status === "out_for_delivery") return "out_for_delivery";
  if (physical.status === "picked_up") return "picked_up";
  if (physical.status === "pickup_scheduled") return "pickup_scheduled";
  if (physical.status === "in_transit") return "in_transit";
  if (blocker.type === "customs_hold") return "customs_hold";
  // Cargo readiness and pickup-dispatch readiness are separate dimensions.
  // A broker-alert/award acknowledgment can remain actionable without
  // demoting current destination availability or manufacturing a sibling
  // state contradiction.
  if (phaseSaysReadyOrDispatch(phase) && blocker.type === "dispatch_needed") return "ready_for_pickup";
  const blockerBlocks = blocker.type && blocker.type !== "none" && blocker.status !== "advisory" && blocker.status !== "clear";
  if ((phaseSaysReadyOrDispatch(phase) || dispatchGateResolved(byGate.dispatch)) && !blockerBlocks) return "ready_for_pickup";
  if (physical.status === "arrived" && blockerBlocks) return "arrived_not_available";
  if (physical.status === "arrived") return "arrived_not_available";
  return "unknown";
}

function phaseSaysReadyOrDispatch(input) {
  const phase = clean(input).toLowerCase().replace(/_/g, "-").trim();
  if (!phase) return false;
  if (/\bnot-ready\b|\bnot ready\b/.test(phase)) return false;
  return [
    "ready",
    "ready-for-pickup",
    "ready-for-dispatch",
    "dispatch-ready",
    "pickup-ready",
  ].includes(phase);
}

// Publish-time reconciliation: no packet may leave the writer with unreconciled
// sibling verdicts (INC-2026-07-04-PACKET-SIBLING-VERDICT-CONTRADICTION).
// Either a conflict resolves by explicit precedence (recorded in
// stateDerivation) or it becomes a machine-readable contradictions[] entry that
// planner and UI must respect.
function reconcileSiblingVerdicts(shipment, gates, feeLedger, operationalBlocker, currentState) {
  const byGate = gateByName(gates);
  const contradictions = [];
  const stateDerivation = [];
  const feesGateAccepted = /\b(?:done|paid|true|received|confirmed)\b/.test(gateStatusText(byGate.fees));
  if (feeLedger.status === "verify") {
    stateDerivation.push({
      dimension: "fees",
      resolution: "precedence",
      kept: "fees gate (payment evidence accepted)",
      downgraded: "fee ledger arithmetic (amount not machine-readable)",
      reason: "Payment evidence accepted by the fees gate outranks unverifiable ledger arithmetic; a verify-fee advisory rides along instead of a hard blocker.",
    });
  }
  if (feesGateAccepted && ["due", "partial"].includes(feeLedger.status)) {
    contradictions.push({
      id: `${normalizeAwb(shipment.awb)}:fees-gate-vs-ledger`,
      dimension: "fees",
      claim: "The fees gate accepted payment evidence while the fee ledger still shows a proven unpaid balance.",
      severity: "attention",
      operatorMessage: "Conflicting fee info — confirm the payment and remaining balance before acting on fees.",
    });
  }
  const phase = clean(shipment.opsState?.phase || shipment.stage || shipment.currentState).toLowerCase();
  if (phaseSaysReadyOrDispatch(phase) && currentState === "arrived_not_available") {
    contradictions.push({
      id: `${normalizeAwb(shipment.awb)}:state-family-split`,
      dimension: "state",
      claim: `Canonical phase "${phase}" says pickup-ready while the packet state resolved to arrived_not_available.`,
      severity: "attention",
      operatorMessage: "Shipment readiness is contested — confirm station availability before acting.",
    });
  }
  return { contradictions, stateDerivation };
}

function buildOperatorTruthPacket(shipment = {}, memory = {}) {
  const { gates, sourceFacts } = operatorGatesForShipment(shipment, memory);
  const freshness = freshnessForShipment(shipment, memory);
  const unknowns = unknownsForShipment(shipment, gates, freshness);
  const contradictions = contradictionsForShipment(shipment, gates, sourceFacts);
  const physicalLifecycle = physicalLifecycleFromShipment(shipment, gates, sourceFacts);
  const feeLedger = feeLedgerReconciliation(shipment, gates, sourceFacts);
  const documentRequest = documentRequestBlocker(shipment, sourceFacts);
  const operationalBlocker = operationalBlockerFromShipment(shipment, gates, sourceFacts, feeLedger, documentRequest, physicalLifecycle);
  const preliminaryState = truthStateFromShipment(shipment, gates, sourceFacts, physicalLifecycle, operationalBlocker);
  const reconciliation = reconcileSiblingVerdicts(shipment, gates, feeLedger, operationalBlocker, preliminaryState);
  contradictions.push(...reconciliation.contradictions);
  return {
    shipmentId: clean(shipment.id || shipment.shipmentId || shipment.awb),
    awbs: [normalizeAwb(shipment.awb || shipment.id)].filter(Boolean),
    groupId: clean(shipment.groupId || shipment.canonical?.groupId),
    compiledAt: new Date().toISOString(),
    currentState: preliminaryState,
    resolvedCurrentState: preliminaryState,
    stateDerivation: reconciliation.stateDerivation,
    stateConfidence: freshness.hasGmailEvidence || sourceFacts.some((fact) => fact.sourceSystem === "operator_phone") ? "medium" : "low",
    stateReason: first(shipment.stateReason, shipment.currentState, shipment.opsState?.summary, shipment.opsState?.label, shipment.stage),
    physicalLifecycle,
    operationalBlocker,
    feeLedger,
    documentRequestBlocker: documentRequest,
    gates,
    exceptions: shipment.opsState?.exceptions || [],
    nextAction: (() => {
      const sourceFactIds = sourceFacts.slice(0, 6).map((fact) => fact.id);
      if (operationalBlocker.type === "delivery_recovery") {
        return {
          label: DELIVERY_RECOVERY_ACTION,
          sourceFactIds,
        };
      }
      const closeoutComplete = operationalBlocker.type === "none" && (
        shipment.completed === true ||
        String(physicalLifecycle.status || "").toLowerCase() === "closed" ||
        ["completed", "closed"].includes(String(preliminaryState || "").toLowerCase())
      );
      if (closeoutComplete) {
        return {
          label: TERMINAL_NO_ACTION,
          sourceFactIds,
        };
      }
      const wait = deliveryWaitFromFacts(sourceFacts, preliminaryState);
      return {
        label: wait ? deliveryWaitMessage(wait) : clean(shipment.opsState?.nextAction || shipment.nextAction),
        sourceFactIds,
        ...(wait ? { deliveryWait: true } : {}),
      };
    })(),
    sourceFactIds: unique([
      ...sourceFacts.map((fact) => fact.id),
      ...gates.flatMap((gate) => gate.sourceFactIds || []),
    ]),
    contradictions,
    unknowns,
    freshness,
    mustAskHuman: Boolean(contradictions.length || unknowns.some((item) => item.gate === "source_coverage")),
    // Import-desk agency: whether this shipment is OUR move right now, or
    // export-side/waiting/monitor. Consumed by the work board and desktop.
    operatorAgency: classifyOperatorAgency({
      state: preliminaryState,
      phase: shipment.opsState?.phase,
      blockerType: (operationalBlocker || {}).type,
      blockerStatus: (operationalBlocker || {}).status,
      mustAskHuman: Boolean(contradictions.length || unknowns.some((item) => item.gate === "source_coverage")),
      contradictions,
      factsText: [
        ...sourceFacts.map((fact) => `${fact.claim || ""} ${fact.rawSnippet || ""}`),
        (operationalBlocker || {}).reason || "",
        clean(shipment.opsState?.nextAction || shipment.nextAction),
      ].join(" "),
    }),
  };
}

function buildEvidencePacket(shipment = {}, memory = {}) {
  const sourceFacts = sourceFactsForShipment(shipment, memory);
  const freshness = freshnessForShipment(shipment, memory);
  const { gates } = operatorGatesForShipment(shipment, memory);
  const tmsRecords = shipment.tms && Object.keys(shipment.tms).length
    ? [{
        order: clean(shipment.tms.order || shipment.tmsOrderId),
        status: clean(shipment.tms.status || shipment.tms.tmsStatus),
        tmsStatus: clean(shipment.tms.tmsStatus || shipment.tms.status),
        nextTask: clean(shipment.tms.nextTask || shipment.flightDetails?.recoveryHint || shipment.flightDetails?.etaHint),
        snapshotTime: dateOrEmpty(shipment.tms.snapshotTime || memory.active?.snapshotTime),
        source: clean(shipment.tms.source || "tms-detail"),
      }]
    : [];
  return {
    shipmentId: clean(shipment.id || shipment.shipmentId || shipment.awb),
    awbs: [normalizeAwb(shipment.awb || shipment.id)].filter(Boolean),
    groupId: clean(shipment.groupId || shipment.canonical?.groupId),
    compiledAt: new Date().toISOString(),
    freshness,
    sourceFacts,
    threads: unique(sourceFacts
      .filter((fact) => fact.sourceRef.threadId)
      .map((fact) => ({ threadId: fact.sourceRef.threadId, messageId: fact.sourceRef.messageId }))),
    attachments: unique(sourceFacts
      .filter((fact) => fact.sourceRef.attachmentId || fact.sourceRef.filename)
      .map((fact) => ({ attachmentId: fact.sourceRef.attachmentId, filename: fact.sourceRef.filename }))),
    trackingEvents: [],
    tmsRecords,
    operatorEvents: sourceFacts.filter((fact) => fact.sourceSystem === "operator_phone"),
    contradictions: contradictionsForShipment(shipment, gates, sourceFacts),
    unknowns: [],
  };
}

function attachOperatorPackets(shipments = [], memory = {}) {
  return shipments.map((shipment) => ({
    ...shipment,
    evidencePacket: buildEvidencePacket(shipment, memory),
    truthPacket: buildOperatorTruthPacket(shipment, memory),
  }));
}

function compactTruthPacket(packet = {}) {
  return {
    shipmentId: packet.shipmentId || "",
    awbs: packet.awbs || [],
    currentState: packet.currentState || "",
    resolvedCurrentState: packet.resolvedCurrentState || packet.currentState || "",
    stateDerivation: (packet.stateDerivation || []).slice(0, 4),
    stateConfidence: packet.stateConfidence || "",
    stateReason: packet.stateReason || "",
    physicalLifecycle: packet.physicalLifecycle || null,
    operationalBlocker: packet.operationalBlocker || null,
    feeLedger: packet.feeLedger || null,
    documentRequestBlocker: packet.documentRequestBlocker || null,
    gates: (packet.gates || []).map((gate) => ({
      gate: gate.gate,
      status: gate.status,
      rawStatus: gate.rawStatus,
      reason: gate.reason,
      confidence: gate.confidence,
    })),
    nextAction: packet.nextAction || {},
    unknowns: (packet.unknowns || []).slice(0, 8),
    contradictions: (packet.contradictions || []).slice(0, 6),
    freshness: packet.freshness || {},
    mustAskHuman: Boolean(packet.mustAskHuman),
    operatorAgency: packet.operatorAgency || null,
  };
}

function compactEvidencePacket(packet = {}) {
  return {
    shipmentId: packet.shipmentId || "",
    awbs: packet.awbs || [],
    freshness: packet.freshness || {},
    sourceFacts: (packet.sourceFacts || []).map((fact) => ({
      id: fact.id,
      type: fact.type,
      sourceSystem: fact.sourceSystem,
      sourceRef: fact.sourceRef,
      observedAt: fact.observedAt,
      actor: fact.actor,
      claim: fact.claim,
      rawSnippet: fact.rawSnippet,
      confidenceInput: fact.confidenceInput,
    })).slice(0, 20),
    threads: (packet.threads || []).slice(0, 10),
    attachments: (packet.attachments || []).slice(0, 10),
    contradictions: (packet.contradictions || []).slice(0, 6),
    unknowns: (packet.unknowns || []).slice(0, 8),
  };
}

module.exports = {
  attachOperatorPackets,
  buildEvidencePacket,
  buildOperatorTruthPacket,
  compactEvidencePacket,
  compactTruthPacket,
  sourceFactsForShipment,
  _test: { feeLedgerReconciliation, feeChargeFact, feePaymentFact, feeFactCitesForeignAwbOnly },
};

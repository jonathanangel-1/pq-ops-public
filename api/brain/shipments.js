"use strict";

const path = require("node:path");
const { buildShipmentReasoningNode, readOpsBrainMemory } = require("../../lib/ops-brain-companion");
const { compactEvidencePacket, compactTruthPacket } = require("../../lib/operator-truth-packet");
const { authorized, sendJson } = require("../../lib/supabase-agent");
const { buildRowCertification } = require("../../lib/truth-health");
const { buildWorkItems } = require("../../lib/work-items");
const { deriveSyncRequestState } = require("../../lib/sync-observability");
const { classifyOperatorAgencyForRow } = require("../../lib/operator-agency");
const { classifyUrgentInterrupt, assessShipmentSeverity } = require("../../lib/urgent-interrupts");
const { buildPlanningAhead, planningStatus } = require("../../lib/planning-ahead");
const { platformExecutableAction } = require("../../lib/platform-action");
const {
  gmailDirectAvailable,
  runDirectGmailRefresh,
} = require("../../lib/gmail-direct-ingest");

const PUBLIC_TRUTH_MAX_AGE_MINUTES = Math.max(
  1,
  Number(process.env.PQ_PUBLIC_TRUTH_MAX_AGE_MINUTES || process.env.PQ_TRUTH_HEALTH_STALE_MINUTES || 15) || 15,
);
const DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES = 24 * 60;
const TMS_INVENTORY_MAX_AGE_MINUTES = Math.max(
  PUBLIC_TRUTH_MAX_AGE_MINUTES,
  Number(process.env.PQ_TMS_INVENTORY_MAX_AGE_MINUTES || DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES) || DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES,
);

function shipmentAwbKey(row = {}) {
  if (typeof row === "string" || typeof row === "number") return String(row || "").replace(/\D/g, "");
  return String(row.awb || row.trackingNumber || row.id || row.shipmentId || "").replace(/\D/g, "");
}

function requestUrl(request) {
  return new URL(request.url || "/", "http://localhost");
}

function liveGmailOverlayRequested(request) {
  const url = requestUrl(request);
  return ["1", "true", "yes"].includes(String(url.searchParams.get("liveGmail") || url.searchParams.get("gmailOverlay") || "").toLowerCase());
}

function liveGmailSnapshotBundleRequested(request) {
  const url = requestUrl(request);
  return ["1", "true", "yes"].includes(String(url.searchParams.get("snapshotBundle") || "").toLowerCase());
}

function requestedAwbs(request) {
  const url = requestUrl(request);
  return [...new Set(String(url.searchParams.get("awbs") || "")
    .split(/[,\s]+/)
    .map((awb) => awb.replace(/\D/g, ""))
    .filter(Boolean))];
}

function numericQueryParam(request, name, fallback, min, max) {
  const url = requestUrl(request);
  const value = Number(url.searchParams.get(name) || fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cleanGateEvidence(value = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const cleaned = text.replace(/^(?:done\s*:\s*){2,}/i, "").trim();
  return cleaned || text;
}

function publicGateMap(gates = {}) {
  return Object.fromEntries(
    Object.entries(gates || {}).map(([name, gate]) => [
      name,
      {
        name: gate?.name || name,
        status: gate?.status || "",
        label: gate?.label || name,
        evidence: cleanGateEvidence(gate?.evidence || gate?.summary || ""),
        confidence: gate?.confidence || "",
        source: gate?.source || "",
        at: gate?.at || "",
        broker: gate?.broker || gate?.selectedBroker || "",
        selectedBroker: gate?.selectedBroker || gate?.broker || "",
        contactEmail: gate?.contactEmail || "",
        contactPhone: gate?.contactPhone || "",
        amount: gate?.amount || "",
      },
    ]),
  );
}

function gateStatus(row = {}, name) {
  return String(row.opsState?.gates?.[name]?.status || "").toLowerCase();
}

function gateBroker(row = {}, name) {
  const gate = row.opsState?.gates?.[name] || {};
  return gate.selectedBroker || gate.broker || "";
}

function gateDone(status = "") {
  return ["done", "released", "cleared", "paid", "sent", "broker-alerted", "broker-awarded", "dispatched"].includes(
    String(status || "").toLowerCase(),
  );
}

function publicCustomsBroker(row = {}) {
  const customs = row.customsBroker || {};
  const status = gateStatus(row, "customs");
  const gate = row.opsState?.gates?.customs || {};
  const broker = customs.broker || customs.name || gateBroker(row, "customs") || "";
  if (!broker && !status && !customs.status) return null;
  const resolvedStatus = customs.status ||
    (["done", "released", "cleared"].includes(status) ? "customs-cleared" : "") ||
    (["blocked", "customs-hold", "hold", "exam-hold"].includes(status) ? "customs-hold" : "") ||
    (["pending", "waiting"].includes(status) ? "customs-pending" : "") ||
    status;
  return {
    broker,
    status: resolvedStatus || "",
    nextAction: customs.nextAction || row.nextAction || row.opsState?.nextAction || "",
    contactEmail: customs.contactEmail || customs.email || gate.contactEmail || "",
    brokerStatus: customs.brokerStatus || cleanGateEvidence(gate.evidence || gate.summary || ""),
  };
}

function cleanPickupBrokerName(value = "") {
  const broker = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
    .replace(/^(?:so|then|now)\s+/i, "")
    .replace(/\b(?:broker|carrier|dispatch|pickup|quote|rate)\b$/i, "")
    .trim();
  if (!broker || /^(?:broker|carrier|pickup broker|dispatch|unknown|not found|alex(?: angel)?|jordan(?: reed)?|operations piki|piki(?:io)?|piki operations)$/i.test(broker)) return "";
  return broker;
}

function pickupBrokerFromRoleEvidence(row = {}) {
  const text = [
    row.opsState?.gates?.dispatch?.broker,
    row.opsState?.gates?.dispatch?.selectedBroker,
    row.opsState?.gates?.dispatch?.evidence,
    row.opsState?.gates?.dispatch?.summary,
    row.opsState?.gates?.arrival?.evidence,
    row.opsState?.gates?.arrival?.summary,
    row.currentState,
    row.opsState?.summary,
    row.nextAction,
    row.emailValidation?.summary,
    row.truthPacket?.physicalLifecycle?.reason,
    row.truthPacket?.operationalBlocker?.reason,
  ].filter(Boolean).join(" ");
  const patterns = [
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+is\s+the\s+active\s+pickup\s+broker\s+path\b/i,
    /\btold\s+[A-Z][A-Za-z.' -]{1,40}\/([A-Z][A-Za-z0-9&.' -]{1,70})\b[^.;\n]{0,140}\b(?:pick\s*up|pickup|recover|recovery)\b/i,
    /\basked\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+to\s+(?:pick\s*up|recover)\b/i,
    /\b([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+(?:was\s+)?(?:approved|awarded|selected|confirmed)\s+for\s+pickup\b/i,
    /\b(?:approved|awarded|selected|confirmed)\s+([A-Z][A-Za-z0-9&.' -]{1,70}?)\s+for\s+pickup\b/i,
  ];
  for (const pattern of patterns) {
    const broker = cleanPickupBrokerName(text.match(pattern)?.[1] || "");
    if (broker) return broker;
  }
  return "";
}

function normalizedBrokerIdentity(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:inc|llc|ltd|co|corp|corporation|customs|brokerage|brokers?|logistics|solutions?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function freightLooksLikeCustomsBroker(row = {}, broker = "", email = "") {
  const customs = row.customsBroker || {};
  const customsEmail = String(customs.contactEmail || customs.email || row.opsState?.gates?.customs?.contactEmail || "").trim().toLowerCase();
  const freightEmail = String(email || "").trim().toLowerCase();
  if (customsEmail && freightEmail && customsEmail === freightEmail) return true;
  const customsName = normalizedBrokerIdentity(customs.broker || customs.name || row.opsState?.gates?.customs?.broker || "");
  const freightName = normalizedBrokerIdentity(broker);
  return Boolean(customsName && freightName && customsName === freightName);
}

function publicFreightBroker(row = {}) {
  const freight = row.freightBroker || {};
  const status = gateStatus(row, "dispatch");
  const gate = row.opsState?.gates?.dispatch || {};
  const roleBroker = pickupBrokerFromRoleEvidence(row);
  const rawBroker = freight.broker || freight.name || gateBroker(row, "dispatch") || "";
  const rawEmail = freight.contactEmail || freight.email || gate.contactEmail || "";
  const broker = roleBroker || (freightLooksLikeCustomsBroker(row, rawBroker, rawEmail) && !gateBroker(row, "dispatch") ? "" : rawBroker);
  if (!broker && !status && !freight.status) return null;
  const resolvedStatus = freight.status ||
    (["done", "broker-awarded", "dispatched"].includes(status) ? "freight-awarded" : "") ||
    (["sent", "broker-alerted"].includes(status) ? "freight-requested" : "") ||
    status;
  const contactEmail = roleBroker && freightLooksLikeCustomsBroker(row, rawBroker, rawEmail) ? gate.contactEmail || "" : rawEmail;
  return {
    broker,
    status: resolvedStatus || "",
    nextAction: freight.nextAction || row.nextAction || row.opsState?.nextAction || "",
    contactEmail,
    contactPhone: freight.contactPhone || freight.phone || gate.contactPhone || "",
    rate: freight.rate || gate.amount || "",
    brokerStatus: freight.brokerStatus || cleanGateEvidence(gate.evidence || gate.summary || ""),
    pickupPlan: freight.pickupPlan || cleanGateEvidence(gate.evidence || gate.summary || ""),
  };
}

function minutesSince(timestamp = "") {
  const parsed = Date.parse(timestamp || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 60000));
}

function tmsInventoryAuditFreshness(truthPackets = {}) {
  const sourceAudit = truthPackets.sourceAudit || {};
  const activeAwbs = Array.isArray(sourceAudit.tmsActiveAwbs)
    ? sourceAudit.tmsActiveAwbs.map(shipmentAwbKey).filter(Boolean)
    : [];
  const snapshotTime = sourceAudit.tmsSnapshotTime || truthPackets.tmsSnapshotTime || "";
  const ageMinutes = minutesSince(snapshotTime);
  return {
    activeAwbCount: activeAwbs.length,
    snapshotTime,
    ageMinutes,
    maxAgeMinutes: TMS_INVENTORY_MAX_AGE_MINUTES,
    stale: activeAwbs.length > 0 && (ageMinutes === null || ageMinutes > TMS_INVENTORY_MAX_AGE_MINUTES),
  };
}

function truthSourceHealth(memory = {}) {
  const warnings = Array.isArray(memory.truthPackets?.sourceTruthWarnings)
    ? memory.truthPackets.sourceTruthWarnings.filter(Boolean).map((warning) => String(warning || ""))
    : [];
  const snapshotTime = memory.truthPackets?.snapshotTime || "";
  // Quiet cron cycles skip the unchanged truth-packet write, so snapshotTime freezes
  // while the truth stays verified-current. A successful refresh whose verified
  // signature matches the stored packet proves freshness at the run time.
  const refreshHealth = memory.refreshHealth || {};
  const truthSignature = String(memory.truthPackets?.contentSignature || "");
  const verifiedAt = String(refreshHealth.status || "") === "success" &&
    truthSignature &&
    String(refreshHealth.truthPacketContentSignature || "") === truthSignature
    ? String(refreshHealth.completedAt || refreshHealth.snapshotTime || "")
    : "";
  const freshAt = [snapshotTime, verifiedAt].filter(Boolean).sort().pop() || "";
  const ageMinutes = minutesSince(freshAt || snapshotTime);
  // A bundled-fallback read is never "live", whatever the bundled file's age:
  // the operator is looking at a backup copy and must be told so.
  if (memory.hostedReadFallback) {
    return {
      status: "bundled-fallback",
      degraded: true,
      sourceGapRequired: true,
      sourceGapScope: "fleet",
      sourceGapAwbKeys: [],
      bundledFallback: true,
      emergencyBundledFresh: false,
      reason: `Live shipment data could not be read (${memory.hostedReadFallback.error || "hosted read failed"}); serving the bundled backup snapshot${snapshotTime ? ` from ${snapshotTime}` : ""}. Actions must stay locked.`,
      warnings,
      snapshotTime,
      ageMinutes,
      persisted: false,
    };
  }
  const hostedUnavailable = warnings.some((warning) =>
    /\b(?:hosted|supabase|persistence|snapshot)\b/i.test(warning) &&
      /\b(?:unavailable|timeout|timed out|aborted|using local bundled|fallback|degraded)\b/i.test(warning)
  );
  const stale = ageMinutes === null || ageMinutes > PUBLIC_TRUTH_MAX_AGE_MINUTES;
  const rowCertification = buildRowCertification(memory.truthPackets || {});
  const tmsInventoryMissing = rowCertification.activeRowsChecked > 0 &&
    rowCertification.tmsActiveInventoryAwbsChecked === 0;
  const tmsInventoryFreshness = tmsInventoryAuditFreshness(memory.truthPackets || {});
  const tmsInventoryStale = !tmsInventoryMissing &&
    rowCertification.activeRowsChecked > 0 &&
    tmsInventoryFreshness.stale;
  if (tmsInventoryMissing) {
    warnings.push("TMS active inventory audit is missing from shipment-truth-packets; active shipment membership cannot be certified.");
  } else if (tmsInventoryStale) {
    warnings.push(`TMS active inventory audit is stale (${tmsInventoryFreshness.ageMinutes === null ? "unknown age" : `${tmsInventoryFreshness.ageMinutes}m old`}); active shipment membership cannot be certified.`);
  }
  const emergencyBundledFresh = hostedUnavailable &&
    !stale &&
    !tmsInventoryMissing &&
    !tmsInventoryStale &&
    rowCertification.problemCount === 0 &&
    rowCertification.activeRowsChecked > 0;
  const degraded = hostedUnavailable || stale || tmsInventoryMissing || tmsInventoryStale || rowCertification.problemCount > 0;
  const sourceGapRequired = degraded && !emergencyBundledFresh;
  // One row's missing per-AWB coverage must not silence the certified fleet:
  // when freshness and hosted reads are healthy and the ONLY problem is row
  // certification, the gap is row-scoped. Fleet scope stays for global
  // freshness/pipeline failure.
  const sourceGapScope = sourceGapRequired && !hostedUnavailable && !stale && !tmsInventoryStale && rowCertification.problemCount > 0
    ? "rows"
    : "fleet";
  const sourceGapAwbKeys = sourceGapScope === "rows"
    ? rowCertification.problemAwbs.map((awb) => String(awb || "").replace(/\D/g, "")).filter(Boolean)
    : [];
  const reason = tmsInventoryMissing
    ? "TMS active inventory audit is missing from the canonical packet; publish fresh TMS snapshots and rebuild shipment truth before acting."
    : tmsInventoryStale
    ? `TMS active inventory audit is stale (${tmsInventoryFreshness.ageMinutes === null ? "unknown age" : `${tmsInventoryFreshness.ageMinutes}m old`}); publish fresh TMS snapshots and rebuild shipment truth before acting.`
    : rowCertification.problemCount
    ? `${rowCertification.problemCount} active shipment truth certification problem(s): ${rowCertification.problemAwbs.slice(0, 8).join(", ")}.`
    : hostedUnavailable
    ? warnings[0] || "Hosted shipment truth persistence is unavailable."
    : stale
      ? `Canonical shipment truth is stale (${ageMinutes === null ? "unknown age" : `${ageMinutes}m old`}).`
      : "";
  return {
    status: degraded ? (emergencyBundledFresh ? "degraded-emergency-bundled" : "degraded") : "live",
    degraded,
    sourceGapRequired,
    sourceGapScope,
    sourceGapAwbKeys,
    emergencyBundledFresh,
    reason,
    snapshotTime,
    verifiedAt,
    ageMinutes,
    maxAgeMinutes: PUBLIC_TRUTH_MAX_AGE_MINUTES,
    rowCertification,
    tmsInventoryMissing,
    tmsInventoryStale,
    tmsInventoryFreshness,
    warnings,
  };
}

function rowSourceHealthProblem(row = {}, sourceHealth = {}) {
  const rowKey = shipmentAwbKey(row);
  if (!rowKey) return null;
  const problems = Array.isArray(sourceHealth?.rowCertification?.problems)
    ? sourceHealth.rowCertification.problems
    : [];
  return problems.find((problem) => {
    const problemKey = shipmentAwbKey({ awb: problem.awb || problem.displayAwb || "" });
    return problemKey && problemKey === rowKey;
  }) || null;
}

function sourceGapCategoryForProblem(problem = {}, sourceHealth = {}) {
  const problemText = [
    problem.code,
    problem.phase,
    problem.reason,
    problem.terminalEvidence?.reason,
  ].filter(Boolean).join(" ");
  if (/\b(?:terminal-evidence-uncertified|tms-active-terminal-evidence-uncertified|terminal delivery\/pod|final-delivery\/pod|pod proof)\b/i.test(problemText)) {
    return "terminal";
  }
  if (/\b(?:missing-gmail-coverage|gmail-coverage-problem|missing-gmail-source-fact|gmail|email|per-awb)\b/i.test(problemText)) {
    return "email";
  }
  if (sourceHealth.bundledFallback) return "backup";
  if (sourceHealth.tmsInventoryMissing || sourceHealth.tmsInventoryStale) return "tms";
  if (/\b(?:supabase|hosted|cloud|persistence)\b/i.test(String(sourceHealth.reason || ""))) return "cloud";
  return "source";
}

function sourceGapReasoning(reasoning = {}, sourceHealth = {}, rowProblem = null) {
  const category = sourceGapCategoryForProblem(rowProblem || {}, sourceHealth || {});
  const reason = category === "terminal"
    ? `Terminal shipment state is not certified: ${rowProblem?.reason || rowProblem?.terminalEvidence?.reason || "concrete external arrival/delivery/POD evidence is missing."}`
    : rowProblem?.reason || sourceHealth.reason || "Shipment truth source health is degraded.";
  const nextAction = category === "terminal"
    ? "Verify direct arrival, pickup, delivery, and POD evidence before treating this shipment as delivered or closed."
    : sourceHealth.bundledFallback
      ? "Restore the hosted shipment truth read path, then reload live data before acting on this backup copy."
      : sourceHealth.tmsInventoryMissing || sourceHealth.tmsInventoryStale
        ? "Publish fresh TMS active inventory snapshots and rebuild shipment truth before acting on this shipment state."
        : category === "email"
          ? "Restore Gmail/Supabase ingestion health, then refresh Gmail truth before acting on this shipment state."
          : "Restore source ingestion health, then reload live shipment truth before acting on this shipment state.";
  return {
    ...(reasoning || {}),
    phase: "source-gap",
    underlyingPhase: reasoning?.phase || reasoning?.underlyingPhase || "",
    className: "source-gap",
    label: "Source gap",
    reason,
    nextAction,
    sourceGapCategory: category,
    sourceCoverage: {
      ...(reasoning?.sourceCoverage || {}),
      globalSourceHealth: sourceHealth.status || "degraded",
      globalSourceHealthReason: reason,
    },
  };
}

function terminalSourceGapOperatorAgency(reason = "") {
  return sourceGapOperatorAgency(reason || "Terminal shipment state is not certified.");
}

function sourceGapOperatorAgency(reason = "") {
  return {
    agency: "truth_repair",
    reason: reason || "Shipment truth is not certified.",
    countsAsWork: true,
  };
}

function publicOperatorAgencyForRow(row = {}, shipment = {}) {
  const packet = row.truthPacket || {};
  if (shipment.sourceCertification?.status === "source-gap") {
    return shipment.operatorAgency || sourceGapOperatorAgency(shipment.currentState || "Shipment truth is not certified.");
  }
  const action = row.primaryAction && typeof row.primaryAction === "object" && row.primaryAction.type
    ? row.primaryAction
    : null;
  // The packet is built before the planner. When the planner later produces a
  // primary, recompute agency with it so a provisional monitor verdict cannot
  // coexist with an executable action in the public response.
  if (action) return classifyOperatorAgencyForRow(row, packet, action);
  return shipment.operatorAgency || packet.operatorAgency || classifyOperatorAgencyForRow(row, packet, null);
}

function terminalSourceGapGateLabel(gateName = "") {
  const key = String(gateName || "").toLowerCase();
  return {
    arrival: "arrival/on-hand",
    customs: "customs/release",
    fees: "fee/payment",
    groundfees: "fee/payment",
    dispatch: "dispatch",
    pickup: "pickup/recovery",
    delivery: "delivery",
    pod: "POD",
  }[key] || key || "gate";
}

function terminalSourceGapGateReason(gateName = "", reason = "") {
  return `${reason || "Terminal shipment state is not certified."} This ${terminalSourceGapGateLabel(gateName)} gate was inferred from the rejected terminal premise and needs direct source proof.`;
}

function gateDependsOnRejectedTerminalPremise(gate = {}) {
  const text = [
    gate?.status,
    gate?.rawStatus,
    gate?.reason,
    gate?.evidence,
    gate?.summary,
    gate?.source,
    gate?.sourceSystem,
  ].filter(Boolean).join(" ");
  return /\b(?:delivery\/pod proof|final delivery\/pod proof|shipment was delivered|delivery is confirmed|pod\/proof of delivery is in memory|pod is in memory|proof implies|pickup\/delivery happened after|did not remain blocking|not the active blocker)\b/i.test(text);
}

function terminalSourceGapGate(gateName = "", gate = {}, reason = "") {
  const key = String(gateName || "").toLowerCase();
  const directTerminalGate = ["delivery", "pod"].includes(key);
  const gateReason = directTerminalGate
    ? reason || "Terminal shipment state is not certified."
    : terminalSourceGapGateReason(key, reason);
  return {
    ...(gate || {}),
    rawStatus: gate?.rawStatus || gate?.status || "",
    status: "waiting",
    evidence: gateReason,
    reason: gateReason,
    priorTerminalEvidence: gate?.evidence || gate?.summary || gate?.reason || "",
    priorSource: gate?.source || gate?.sourceSystem || "",
    source: "terminal-evidence-certification",
  };
}

function terminalSourceGapGateMap(gates = {}, reason = "") {
  const next = { ...(gates || {}) };
  for (const [name, gate] of Object.entries(next)) {
    const key = String(name || "").toLowerCase();
    if (["delivery", "pod"].includes(key) || gateDependsOnRejectedTerminalPremise(gate)) {
      next[name] = terminalSourceGapGate(key, gate, reason);
    }
  }
  return next;
}

function terminalSourceGapTruthPacket(packet = {}, reason = "", nextAction = "") {
  if (!packet || typeof packet !== "object") return packet;
  const gates = Array.isArray(packet.gates)
    ? packet.gates.map((gate = {}) => {
        const name = String(gate.gate || gate.name || "").toLowerCase();
        if (!["delivery", "pod"].includes(name) && !gateDependsOnRejectedTerminalPremise(gate)) return gate;
        return terminalSourceGapGate(name, gate, reason);
      })
    : terminalSourceGapGateMap(packet.gates || {}, reason);
  return {
    ...packet,
    currentState: "source_gap",
    resolvedCurrentState: "source_gap",
    stateReason: reason || packet.stateReason || "Terminal shipment state is not certified.",
    physicalLifecycle: {
      ...(packet.physicalLifecycle || {}),
      label: "Terminal state under review",
      reason: reason || "Terminal shipment state is not certified.",
      status: "source-gap",
      sourceFactIds: [],
    },
    operationalBlocker: {
      ...(packet.operationalBlocker || {}),
      type: "source-gap",
      label: "Terminal state under review",
      reason: reason || "Terminal shipment state is not certified.",
      status: "blocked",
      severity: "attention",
      sourceFactIds: [],
    },
    nextAction: {
      ...(packet.nextAction || {}),
      label: nextAction || "Verify direct arrival, pickup, delivery, and POD evidence before treating this shipment as delivered or closed.",
      sourceFactIds: [],
    },
    operatorAgency: terminalSourceGapOperatorAgency(reason),
    mustAskHuman: true,
    gates,
    unknowns: [
      ...(Array.isArray(packet.unknowns) ? packet.unknowns : []),
      { gate: "terminal_evidence", reason: reason || "Terminal shipment state is not certified." },
    ],
  };
}

function arrivalConflictGateMap(gates = {}, reason = "") {
  const next = { ...(gates || {}) };
  next.arrival = {
    ...(next.arrival || {}),
    name: "arrival",
    status: "waiting",
    evidence: reason || "Arrival certification conflicts with current source evidence.",
    reason: reason || "Arrival certification conflicts with current source evidence.",
    source: "truth-health-certification",
  };
  return next;
}

function arrivalConflictTruthPacket(packet = {}, reason = "", nextAction = "") {
  if (!packet || typeof packet !== "object") return packet;
  const gates = Array.isArray(packet.gates)
    ? packet.gates.map((gate = {}) => {
        const name = String(gate.gate || gate.name || "").toLowerCase();
        if (name !== "arrival") return gate;
        return {
          ...gate,
          status: "unknown",
          rawStatus: "not-arrived",
          reason: reason || "Arrival certification conflicts with current source evidence.",
          source: "truth-health-certification",
        };
      })
    : arrivalConflictGateMap(packet.gates || {}, reason);
  return {
    ...packet,
    currentState: "source_gap",
    resolvedCurrentState: "source_gap",
    stateReason: reason || packet.stateReason || "Arrival certification conflicts with current source evidence.",
    physicalLifecycle: {
      ...(packet.physicalLifecycle || {}),
      label: "In transit",
      reason: reason || "Destination arrival is not certified.",
      status: "in_transit",
      sourceFactIds: [],
    },
    operationalBlocker: {
      ...(packet.operationalBlocker || {}),
      type: "source-gap",
      label: "Arrival truth conflict",
      reason: reason || "Destination arrival is not certified.",
      status: "blocked",
      severity: "critical",
      sourceFactIds: [],
    },
    nextAction: {
      ...(packet.nextAction || {}),
      label: nextAction || "Repair source truth before acting on this shipment state.",
      sourceFactIds: [],
    },
    gates,
  };
}

function misleadingUncertifiedTerminalEvidenceText(value = "") {
  return /\b(?:Delivery\/POD evidence was received|Final delivery\/POD proof implies|Delivered; POD is in memory|No action; POD is in memory|POD\/delivery proof accepted|POD found|POD received)\b/i.test(String(value || ""));
}

function terminalEvidenceWarning(row = {}) {
  const certification = row.terminalEvidenceCertification || row._terminalEvidenceCertification || null;
  if (certification?.status !== "uncertified") return "";
  return `Terminal delivery/POD proof is not certified: ${certification.reason || "concrete external final-delivery/POD evidence is missing."}`;
}

function sanitizeTerminalUncertifiedReasoning(reasoning = {}, row = {}) {
  const warning = terminalEvidenceWarning(row);
  if (!warning) return reasoning;
  const evidence = Array.isArray(reasoning?.evidence) ? reasoning.evidence : [];
  const filtered = evidence
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => !misleadingUncertifiedTerminalEvidenceText(item));
  return {
    ...(reasoning || {}),
    evidence: [warning, ...filtered].slice(0, Math.max(1, evidence.length || 1)),
  };
}

function bundledFallbackResponse(memory = {}, sourceHealth = truthSourceHealth(memory)) {
  const truthRows = Array.isArray(memory.truthPackets?.shipments) ? memory.truthPackets.shipments : [];
  const fallbackActiveAwbs = [...activeAwbSetFromTruthPackets(memory.truthPackets || {})];
  return {
    ok: true,
    snapshotTime: memory.truthPackets?.snapshotTime || new Date().toISOString(),
    source: "shipment-truth-packets-bundled-backup",
    sourceOfTruth: "Hosted shipment truth could not be read. Bundled backup rows are diagnostic only and are not operational active shipments.",
    writerVersion: memory.truthPackets?.writerVersion || "shipment-truth-packets-v1",
    sourceTruthWarnings: Array.isArray(memory.truthPackets?.sourceTruthWarnings)
      ? memory.truthPackets.sourceTruthWarnings
      : [],
    sourceHealth,
    syncState: deriveSyncRequestState({
      hostedReadFallback: memory.hostedReadFallback,
      bundledSnapshotTime: memory.truthPackets?.snapshotTime || "",
    }),
    bundledFallback: {
      diagnosticOnly: true,
      source: memory.hostedReadFallback?.source || "bundled-repo-files",
      error: memory.hostedReadFallback?.error || "",
      at: memory.hostedReadFallback?.at || "",
      snapshotTime: memory.truthPackets?.snapshotTime || "",
      shipmentCount: truthRows.length,
      activeAwbCount: fallbackActiveAwbs.length,
    },
    activeCount: 0,
    shipments: [],
    workBoard: { items: [], lanes: [], counts: {} },
    planningAhead: [],
    planningStatus: {},
  };
}

function publicShipment(row = {}, memory = {}, sourceHealth = truthSourceHealth(memory)) {
  const opsState = row.opsState || {};
  const reasoning = sanitizeTerminalUncertifiedReasoning(buildShipmentReasoningNode(row, memory), row);
  const sourceGapRequired = Object.prototype.hasOwnProperty.call(sourceHealth || {}, "sourceGapRequired")
    ? Boolean(sourceHealth.sourceGapRequired)
    : Boolean(sourceHealth?.degraded);
  const rowAwbKey = String(row.awb || row.id || "").replace(/\D/g, "");
  const gapAppliesToRow = String(sourceHealth?.sourceGapScope || "fleet") !== "rows" ||
    (sourceHealth?.sourceGapAwbKeys || []).includes(rowAwbKey);
  const globalSourceGap = Boolean(sourceGapRequired && gapAppliesToRow && !row.completed && String(row.truthPacketRole || "active").toLowerCase() !== "completed");
  const rowProblem = globalSourceGap ? rowSourceHealthProblem(row, sourceHealth) : null;
  const publicReasoning = globalSourceGap ? sourceGapReasoning(reasoning, sourceHealth, rowProblem) : reasoning;
  const sourceGap = publicReasoning?.className === "source-gap" || publicReasoning?.phase === "source-gap";
  const primaryAction = sourceGap || !row.primaryAction
    ? null
    : platformExecutableAction(row.primaryAction, row);
  const primaryActionNextAction = String(primaryAction?.nextAction || primaryAction?.label || "").trim();
  const publicCurrentState = sourceGap
    ? publicReasoning.reason || "Source gap"
    : publicReasoning?.label || row.currentState || opsState.summary || "";
  const publicNextAction = sourceGap
    ? publicReasoning.nextAction || "Repair source truth for this AWB."
    : primaryActionNextAction || publicReasoning?.nextAction || row.nextAction || opsState.nextAction || "";
  const actionAlignedReasoning = !sourceGap && primaryActionNextAction
    ? { ...(publicReasoning || {}), nextAction: publicNextAction }
    : publicReasoning;
  const sourceGapCategory = sourceGap ? publicReasoning.sourceGapCategory || sourceGapCategoryForProblem(rowProblem || {}, sourceHealth || {}) : "";
  const terminalSourceGap = sourceGapCategory === "terminal";
  const arrivalConflictSourceGap = sourceGap && rowProblem?.code === "arrival-gate-conflict";
  const publicOpsGates = terminalSourceGap
    ? terminalSourceGapGateMap(publicGateMap(opsState.gates || {}), publicCurrentState)
    : arrivalConflictSourceGap
      ? arrivalConflictGateMap(publicGateMap(opsState.gates || {}), publicCurrentState)
    : publicGateMap(opsState.gates || {});
  const publicTruthPacket = terminalSourceGap
    ? terminalSourceGapTruthPacket(row.truthPacket, publicCurrentState, publicNextAction)
    : arrivalConflictSourceGap
      ? arrivalConflictTruthPacket(row.truthPacket, publicCurrentState, publicNextAction)
    : row.truthPacket;
  const customsBroker = publicCustomsBroker(row);
  const freightBroker = publicFreightBroker(row);
  return {
    id: row.id || row.shipmentId || row.awb || "",
    awb: row.awb || row.trackingNumber || "",
    primaryAction,
    station: row.station || "",
    airline: row.airline || row.handler || row.tms?.carrier || "",
    client: row.client || row.consignee || row.delivery?.consignee || "",
    consignee: row.consignee || row.delivery?.consignee || row.client || "",
    eta: row.eta || "",
    etaSource: row.etaSource || "",
    etaConflict: row.etaConflict || "",
    etaUnresolvedRelative: Boolean(row.etaUnresolvedRelative),
    stationEmail: row.stationEmail || "",
    stationPhone: row.stationPhone || "",
    stationContext: row.stationContext || null,
    contacts: row.contacts || null,
    cargo: row.cargo || {},
    flightDetails: row.flightDetails || {},
    route: row.route || row.flightDetails?.route || row.tms?.route || "",
    origin: row.origin || row.flightDetails?.origin || row.tms?.origin || "",
    destination: row.destination || row.flightDetails?.destination || row.tms?.destination || row.station || "",
    delivery: row.delivery
      ? {
          consignee: row.delivery.consignee || row.consignee || row.client || "",
          fullAddress: row.delivery.fullAddress || "",
          address1: row.delivery.address1 || "",
          address2: row.delivery.address2 || "",
          city: row.delivery.city || "",
          state: row.delivery.state || "",
          country: row.delivery.country || "",
          airport: row.delivery.airport || row.station || "",
          courier: row.delivery.courier || row.tms?.deliveryCourier || "",
          contactPhone: row.delivery.contactPhone || row.tms?.consigneePhone || "",
          contactEmail: row.delivery.contactEmail || "",
        }
      : null,
    shipper: row.shipper || null,
    commercial: row.commercial || {},
    tms: row.tms
      ? {
          order: row.tms.order || "",
          pieces: row.tms.pieces || row.cargo?.pieces || "",
          pallets: row.tms.pallets || row.cargo?.pallets || "",
          weight: row.tms.weight || row.cargo?.weight || "",
          weightUom: row.tms.weightUom || row.cargo?.weightUom || "",
          dims: row.tms.dims || row.cargo?.dims || "",
          dimensions: row.tms.dimensions || row.cargo?.dimensions || "",
          commodity: row.tms.commodity || row.cargo?.commodity || "",
          contents: row.tms.contents || row.cargo?.contents || "",
          flight: row.tms.flight || row.flightDetails?.primaryFlight || "",
          flightNumber: row.tms.flightNumber || row.flightDetails?.primaryFlight || "",
          tmsFlight: row.tms.tmsFlight || row.flightDetails?.tmsFlight || "",
          dep: row.tms.dep || row.flightDetails?.departureLeg || "",
          arr: row.tms.arr || row.flightDetails?.arrivalLeg || "",
          route: row.tms.route || row.flightDetails?.route || row.route || "",
          origin: row.tms.origin || row.flightDetails?.origin || row.origin || "",
          destination: row.tms.destination || row.flightDetails?.destination || row.destination || "",
          deliveryCourier: row.tms.deliveryCourier || row.delivery?.courier || "",
          consigneePhone: row.tms.consigneePhone || row.delivery?.contactPhone || "",
          customerCharge: row.tms.customerCharge || row.commercial?.customerCharge || "",
          vendorCost: row.tms.vendorCost || row.commercial?.vendorCost || "",
        }
      : null,
    completed: Boolean(row.completed || opsState.phase === "completed" || opsState.phase === "delivered"),
    arrivalStatus: arrivalConflictSourceGap ? "not-arrived" : row.arrivalStatus || "",
    pickupStatus: row.pickupStatus || "",
    clearanceStatus: row.clearanceStatus || "",
    currentState: publicCurrentState,
    nextAction: publicNextAction,
    sourceGapCategory,
    operatorAgency: sourceGap ? sourceGapOperatorAgency(publicCurrentState) : null,
    opsState: {
      phase: sourceGap ? "source-gap" : publicReasoning?.phase || opsState.phase || "",
      label: sourceGap ? "Source gap" : publicReasoning?.label || opsState.label || "",
      summary: publicCurrentState,
      nextAction: publicNextAction,
      source: opsState.source || "",
      priority: opsState.priority || "",
      urgency: opsState.urgency || "",
      needsHuman: terminalSourceGap || Boolean(opsState.needsHuman),
      gates: publicOpsGates,
    },
    emailValidation: row.emailValidation
      ? {
          status: row.emailValidation.status || "",
          summary: row.emailValidation.summary || "",
          nextAction: row.emailValidation.nextAction || "",
        }
      : null,
    customsBroker,
    freightBroker,
    pod: row.pod
      ? {
          status: row.pod.status || "",
          deliveredAt: row.pod.deliveredAt || row.pod.at || "",
        }
      : null,
    gmailCoverage: row.gmailCoverage || null,
    sourceCertification: {
      status: sourceGap
        ? "source-gap"
        : sourceHealth?.readOnlyGmailOverlay
          ? "read-only-gmail-overlay"
          : sourceHealth?.emergencyBundledFresh
            ? "emergency-bundled"
            : "certified",
      globalSourceHealth: sourceHealth?.status || "unknown",
      reason: sourceGap ? publicCurrentState : "",
      code: sourceGap ? rowProblem?.code || "" : "",
      category: sourceGap ? publicReasoning.sourceGapCategory || sourceGapCategoryForProblem(rowProblem || {}, sourceHealth || {}) : "",
      snapshotTime: sourceHealth?.snapshotTime || "",
      ageMinutes: sourceHealth?.ageMinutes ?? null,
      persisted: sourceHealth?.persisted !== false,
    },
    sourceTruthWarnings: [
      ...(Array.isArray(row.sourceTruthWarnings) ? row.sourceTruthWarnings : []),
      ...(sourceHealth?.warnings || []),
    ],
    truthPacket: compactTruthPacket(publicTruthPacket),
    evidencePacket: compactEvidencePacket(row.evidencePacket),
    reasoning: actionAlignedReasoning,
  };
}

function activeAwbSetFromTruthPackets(truthPackets = {}) {
  const packetActiveAwbs = new Set((truthPackets.activeAwbs || []).map(shipmentAwbKey).filter(Boolean));
  if (packetActiveAwbs.size) return packetActiveAwbs;
  return new Set(
    (truthPackets.shipments || [])
      .filter((shipment) => !shipment.truthPacketRole || shipment.truthPacketRole === "active")
      .map(shipmentAwbKey)
      .filter(Boolean),
  );
}

function allAwbSetFromTruthPackets(truthPackets = {}) {
  return new Set(
    (truthPackets.shipments || [])
      .map(shipmentAwbKey)
      .filter(Boolean),
  );
}

function liveGmailOverlayAwbScope(truthPackets = {}, requested = []) {
  const activeAwbs = activeAwbSetFromTruthPackets(truthPackets || {});
  const canonicalAwbs = allAwbSetFromTruthPackets(truthPackets || {});
  const normalizedRequested = [...new Set((requested || []).map((awb) => String(awb || "").replace(/\D/g, "")).filter(Boolean))];
  const selectedAwbs = normalizedRequested.length
    ? normalizedRequested.filter((awb) => canonicalAwbs.has(awb))
    : [...activeAwbs];
  return {
    projectionScope: normalizedRequested.length ? "requested-awbs" : "active-awbs",
    selectedAwbs,
    requestedAwbs: normalizedRequested,
    activeAwbCount: activeAwbs.size,
    canonicalAwbCount: canonicalAwbs.size,
  };
}

function shipmentsFromTruthPackets(truthPackets = {}, activeAwbs = activeAwbSetFromTruthPackets(truthPackets)) {
  return (truthPackets.shipments || []).filter((shipment) => {
    const key = shipmentAwbKey(shipment);
    return key && (!activeAwbs.size || activeAwbs.has(key));
  });
}

function readOnlyGmailOverlaySourceHealth(truthPackets = {}, directResult = {}, now = new Date()) {
  const rowCertification = buildRowCertification(truthPackets || {});
  const coverageProblemCount = Number(directResult.gmailCoverageProblemCount || 0);
  const degraded = rowCertification.problemCount > 0 || coverageProblemCount > 0;
  const snapshotTime = truthPackets.snapshotTime || now.toISOString();
  const reason = rowCertification.problemCount
    ? `${rowCertification.problemCount} active shipment truth certification problem(s): ${rowCertification.problemAwbs.slice(0, 8).join(", ")}.`
    : coverageProblemCount
      ? `${coverageProblemCount} active AWB(s) have live Gmail coverage problems.`
      : "Read-only Gmail overlay generated from live Gmail; not persisted to hosted Supabase.";
  return {
    status: degraded ? "degraded-read-only-gmail-overlay" : "read-only-gmail-overlay",
    degraded,
    sourceGapRequired: rowCertification.problemCount > 0,
    emergencyBundledFresh: false,
    readOnlyGmailOverlay: true,
    persisted: false,
    reason,
    snapshotTime,
    ageMinutes: minutesSince(snapshotTime),
    maxAgeMinutes: PUBLIC_TRUTH_MAX_AGE_MINUTES,
    rowCertification,
    warnings: [
      "Read-only Gmail overlay generated from live Gmail; not persisted because hosted Supabase persistence is unavailable.",
    ],
  };
}

async function liveGmailOverlayPayload(request, memory, truthRows, options = {}) {
  if (!gmailDirectAvailable(process.env)) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: "Direct Gmail OAuth ingestion is not configured.",
        source: "live-gmail-overlay",
        shipments: [],
      },
    };
  }
  const now = new Date();
  const requested = options.forceActiveAwbs ? [] : requestedAwbs(request);
  const overlayScope = liveGmailOverlayAwbScope(memory.truthPackets || {}, requested);
  const awbs = overlayScope.selectedAwbs;
  const maxAwbs = Math.max(1, Number(process.env.PQ_LIVE_GMAIL_OVERLAY_MAX_AWBS || 25) || 25);
  if (!awbs.length) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: overlayScope.requestedAwbs.length ? "Requested AWBs are not present in the current canonical truth packet." : "No active AWBs available for Gmail overlay.",
        requestedAwbs: overlayScope.requestedAwbs,
        activeAwbCount: overlayScope.activeAwbCount,
        canonicalAwbCount: overlayScope.canonicalAwbCount,
        shipments: [],
      },
    };
  }
  if (awbs.length > maxAwbs) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: `Live Gmail overlay is capped at ${maxAwbs} AWBs per request.`,
        requestedAwbCount: awbs.length,
        maxAwbs,
        shipments: [],
      },
    };
  }
  const directResult = await runDirectGmailRefresh({
    awbs,
    now,
    lookbackDays: numericQueryParam(request, "lookbackDays", Number(process.env.PQ_LIVE_GMAIL_OVERLAY_LOOKBACK_DAYS || 7) || 7, 1, 30),
    maxThreads: numericQueryParam(request, "maxThreads", Number(process.env.PQ_LIVE_GMAIL_OVERLAY_MAX_THREADS || 60) || 60, 1, 240),
    maxAttachmentPdfs: numericQueryParam(request, "maxAttachmentPdfs", Number(process.env.PQ_LIVE_GMAIL_OVERLAY_MAX_PDF_ATTACHMENTS || 1) || 1, 0, 10),
    memorySnapshots: {
      active: memory.truthPackets || { shipments: truthRows || [] },
      brain: memory.brain,
      companionMemory: memory.companionMemory,
    },
    write: false,
    returnMergedSnapshots: true,
    skipHostedSnapshotReads: true,
    includeTruthPackets: true,
  });
  const overlayTruthPackets = directResult.truthPackets || null;
  if (!overlayTruthPackets?.shipments?.length) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        error: "Live Gmail overlay did not produce canonical truth packets.",
        source: "live-gmail-overlay",
        persisted: false,
        direct: {
          ok: directResult.ok,
          updated: directResult.updated || 0,
          threadCount: directResult.threadCount || 0,
          queryCount: directResult.queryCount || 0,
          gmailCoverageStatus: directResult.gmailCoverageStatus || "",
          gmailCoverageProblemCount: directResult.gmailCoverageProblemCount || 0,
        },
        shipments: [],
      },
    };
  }
  const overlayProjectionAwbs = overlayScope.projectionScope === "requested-awbs" ? new Set(awbs) : activeAwbSetFromTruthPackets(overlayTruthPackets);
  const overlayMemory = {
    ...memory,
    truthPackets: {
      ...overlayTruthPackets,
      sourceTruthWarnings: [
        "Read-only Gmail overlay generated from live Gmail; not persisted because hosted Supabase persistence is unavailable.",
      ],
    },
  };
  const sourceHealth = readOnlyGmailOverlaySourceHealth(overlayMemory.truthPackets, directResult, now);
  const shipments = shipmentsFromTruthPackets(overlayMemory.truthPackets, overlayProjectionAwbs)
    .map((shipment) => publicShipment(shipment, overlayMemory, sourceHealth));
  const snapshotBundle = options.includeSnapshotBundle
    ? {
        source: "read-only-live-gmail-overlay-snapshot-bundle",
        persisted: false,
        finalReadiness: "does-not-satisfy-production-readiness-without-hosted-persistence",
        files: {
          "gmail-direct-state.json": directResult.gmailDirectState || null,
          "gmail-proof-snapshot.json": directResult.gmailProofSnapshot || null,
          "shipment-events.json": directResult.shipmentEvents || null,
          "shipment-state.json": directResult.shipmentState || null,
          "operator-notifications.json": directResult.operatorNotifications || null,
          "operational-fact-ledger.json": directResult.operationalFactLedger || null,
          "shipment-truth-packets.json": overlayMemory.truthPackets || null,
          "active-awb-index.json": directResult.activeAwbIndex || null,
          "action-queue.json": directResult.actionQueue || null,
        },
      }
    : null;
  return {
    statusCode: 200,
    body: {
      ok: true,
      snapshotTime: overlayMemory.truthPackets.snapshotTime || now.toISOString(),
      source: "shipment-truth-packets+live-gmail-overlay",
      sourceOfTruth: "Canonical shipment truth packets with a read-only live Gmail overlay. Overlay is not persisted.",
      writerVersion: overlayMemory.truthPackets.writerVersion || "shipment-truth-packets-v1",
      liveGmailOverlay: true,
      persisted: false,
      projectionScope: overlayScope.projectionScope,
      requestedAwbs: overlayScope.requestedAwbs,
      selectedAwbCount: awbs.length,
      requestedAwbCount: awbs.length,
      activeAwbCount: overlayScope.activeAwbCount,
      canonicalAwbCount: overlayScope.canonicalAwbCount,
      sourceTruthWarnings: overlayMemory.truthPackets.sourceTruthWarnings,
      sourceHealth,
      snapshotBundle,
      direct: {
        ok: directResult.ok,
        updated: directResult.updated || 0,
        threadCount: directResult.threadCount || 0,
        queryCount: directResult.queryCount || 0,
        gmailCoverageStatus: directResult.gmailCoverageStatus || "",
        gmailCoverageProblemCount: directResult.gmailCoverageProblemCount || 0,
        shipmentEventCount: directResult.shipmentEventCount || 0,
        shipmentStateCount: directResult.shipmentStateCount || 0,
        operationalFactCount: directResult.operationalFactCount || 0,
        truthPacketActiveShipmentCount: directResult.truthPacketActiveShipmentCount || 0,
        truthPacketGmailPromotedActiveShipmentCount: directResult.truthPacketGmailPromotedActiveShipmentCount || 0,
        updatedAwbs: directResult.updatedAwbs || [],
      },
      shipments,
    },
  };
}

async function liveGmailOverlayResponse(request, response, memory, truthRows) {
  if (!authorized(request)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return true;
  }
  const result = await liveGmailOverlayPayload(request, memory, truthRows, {
    includeSnapshotBundle: liveGmailSnapshotBundleRequested(request),
  });
  sendJson(response, result.statusCode, result.body);
  return true;
}

async function handler(request, response) {
  if (request.method !== "GET") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  try {
    const rootDir = path.join(__dirname, "../..");
    // The board render never reads Gmail proof bodies; skipping the multi-MB proof payload
    // keeps this hot path off the heaviest hosted snapshot (IO-exhaustion mitigation).
    const memory = await readOpsBrainMemory(rootDir, process.env, { includeGmailProof: false });
    const truthRows = Array.isArray(memory.truthPackets?.shipments) ? memory.truthPackets.shipments : [];
    if (!truthRows.length) {
      sendJson(response, 503, {
        ok: false,
        error: "Canonical shipment truth packets are unavailable",
        source: "shipment-truth-packets",
        shipments: [],
      });
      return;
    }
    if (liveGmailOverlayRequested(request) && await liveGmailOverlayResponse(request, response, memory, truthRows)) return;
    const activeAwbs = activeAwbSetFromTruthPackets(memory.truthPackets || {});
    const sourceHealth = truthSourceHealth(memory);
    if (sourceHealth.bundledFallback) {
      sendJson(response, 200, bundledFallbackResponse(memory, sourceHealth));
      return;
    }
    const activeRows = shipmentsFromTruthPackets(memory.truthPackets || { shipments: truthRows }, activeAwbs);
    const shipments = activeRows.map((row) => {
      const shipment = publicShipment(row, memory, sourceHealth);
      // Import-desk agency, computed request-time so pre-agency packets get it
      // too; a packet-published classification wins when present.
      shipment.operatorAgency = publicOperatorAgencyForRow(row, shipment);
      // Urgent interrupts (driver stuck at pickup): top work + toast material.
      shipment.urgentInterrupt = classifyUrgentInterrupt(row);
      shipment.severity = assessShipmentSeverity({
        ...row,
        arrivalStatus: shipment.arrivalStatus,
        currentState: shipment.currentState,
        nextAction: shipment.nextAction,
        opsState: shipment.opsState,
        operatorAgency: shipment.operatorAgency,
      });
      return shipment;
    });
    const certifiedActiveRows = activeRows.filter((_row, index) => shipments[index]?.sourceCertification?.status !== "source-gap");
    // Canonical work items (additive): ONE derived array whose countIdentity is
    // the only legitimate source for the badge / Today's Work / inbox tray.
    const workBoard = buildWorkItems(certifiedActiveRows, {
      plans: Object.fromEntries(certifiedActiveRows
        .filter((row) => row.primaryAction && typeof row.primaryAction === "object" && row.primaryAction.type)
        .map((row) => [shipmentAwbKey(row), platformExecutableAction(row.primaryAction, row)])),
      now: memory.truthPackets?.snapshotTime || new Date().toISOString(),
    });
    sendJson(response, 200, {
      ok: true,
      snapshotTime: memory.truthPackets?.snapshotTime || new Date().toISOString(),
      source: "shipment-truth-packets",
      sourceOfTruth: memory.truthPackets?.sourceOfTruth || "Canonical shipment truth packets are the only operational state authority.",
      writerVersion: memory.truthPackets?.writerVersion || "shipment-truth-packets-v1",
      sourceTruthWarnings: Array.isArray(memory.truthPackets?.sourceTruthWarnings)
        ? memory.truthPackets.sourceTruthWarnings
        : [],
      sourceHealth,
      // Bundled-fallback is per-request truth about THIS payload; the fuller
      // sync-request observability (queued/claimed/stuck) lives on
      // /api/truth/health, which owns those snapshots.
      syncState: memory.hostedReadFallback
        ? deriveSyncRequestState({
            hostedReadFallback: memory.hostedReadFallback,
            bundledSnapshotTime: memory.truthPackets?.snapshotTime || "",
          })
        : null,
      workBoard,
      // Planning ahead: tomorrow's arrivals with no pickup path yet. Station
      // metadata (broker rosters) plugs in via lib/station-metadata.js; until
      // it exists, planning items honestly ask to confirm the roster first.
      planningAhead: buildPlanningAhead(certifiedActiveRows.map((row) => ({ ...row, operatorAgency: shipments[activeRows.indexOf(row)]?.operatorAgency })), {
        now: memory.truthPackets?.snapshotTime || new Date().toISOString(),
        stationMetadataByCode: {},
      }),
      planningStatus: planningStatus(certifiedActiveRows.map((row) => ({ ...row, operatorAgency: shipments[activeRows.indexOf(row)]?.operatorAgency })), {
        now: memory.truthPackets?.snapshotTime || new Date().toISOString(),
        stationMetadataByCode: {},
      }),
      shipments,
    });
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

module.exports = handler;
module.exports._test = {
  truthSourceHealth,
  tmsInventoryAuditFreshness,
  activeAwbSetFromTruthPackets,
  allAwbSetFromTruthPackets,
  liveGmailOverlayAwbScope,
  pickupBrokerFromRoleEvidence,
  publicFreightBroker,
  publicShipment,
  bundledFallbackResponse,
  misleadingUncertifiedTerminalEvidenceText,
  sanitizeTerminalUncertifiedReasoning,
  shipmentsFromTruthPackets,
  publicOperatorAgencyForRow,
};

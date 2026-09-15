const fs = require("node:fs/promises");
const path = require("node:path");
const { autonomyForChannel, betaDraftModeContract, safetyForChannel } = require("./lib/action-safety");
const { runOpsSync } = require("./ops-sync");

const ROOT_DIR = __dirname;
const REPORTS_DIR = path.join(ROOT_DIR, "reports");
const OUTBOX_PATH = path.join(ROOT_DIR, "outbox-requests.json");
const REPORT_FACTS_PATH = path.join(ROOT_DIR, "eod-report-facts.json");
const TIME_ZONE = "America/New_York";
const REPORT_EMAIL_TO = process.env.PQ_EOD_REPORT_EMAIL_TO || "";

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return {
    iso: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
  };
}

function localDateLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function isFreightAssigned(status) {
  return Boolean(status && !["freight-missing", "freight-requested", "freight-unknown"].includes(status));
}

function shipmentText(shipment) {
  return [
    shipment.eta,
    shipment.nextAction,
    shipment.detail,
    shipment.tms?.tmsStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
    shipment.freightBroker?.rate,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.timeline || []).flat(),
    ...(shipment.freightBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].join(" ");
}

function dayTokens(date) {
  const parts = localDateParts(date);
  const shortMonthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(date);
  const paddedMonthDay = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "2-digit",
  }).format(date);
  return [
    parts.iso,
    shortMonthDay,
    paddedMonthDay,
    parts.weekday,
    parts.weekday.toUpperCase(),
    parts.weekday.toLowerCase(),
  ];
}

function textMentionsDay(text, date) {
  const haystack = String(text || "");
  return dayTokens(date).some((token) => haystack.includes(token));
}

function tomorrowArrivals(shipments, tomorrowDate) {
  return shipments.filter((shipment) => {
    const scheduledArrival = shipment.liveTracking?.scheduledArrival || "";
    if (/\bdepart\b/i.test(scheduledArrival)) return false;
    if (textMentionsDay(scheduledArrival, tomorrowDate)) return true;
    if (shipment.arrivalStatus === "arrived") return false;
    const eta = shipment.eta || "";
    if (/\bdepart\b/i.test(eta)) return false;
    return textMentionsDay(eta, tomorrowDate) && /\b(arrive|arrival|recover|eta)\b/i.test(eta);
  });
}

function isFreightUnconfirmed(status) {
  const value = String(status || "").toLowerCase();
  return (
    !value ||
    [
      "freight-missing",
      "freight-requested",
      "freight-unknown",
      "freight-blocked-customs",
      "quote-received-award-needed-pickup-pod-pending",
      "identity-confirmed-rebook-to-iad-clt-requested",
    ].includes(value) ||
    /award-needed|not awarded|unconfirmed|pending|requested/.test(value)
  );
}

function isArrivedOrAvailable(shipment) {
  return (
    shipment.arrivalStatus === "arrived" ||
    ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus)
  );
}

function dispatchedShipments(shipments, tomorrowDate) {
  return shipments.filter((shipment) => {
    const freightStatus = shipment.freightBroker?.status || "freight-missing";
    const hasDispatch = isFreightAssigned(freightStatus) && !isFreightUnconfirmed(freightStatus);
    const text = shipmentText(shipment);
    return (
      hasDispatch &&
      (textMentionsDay(text, tomorrowDate) || /\b(pickup|recover|loaded|delivery tomorrow)\b/i.test(text)) &&
      !/\bquote|rate requested|award needed|not awarded\b/i.test(text)
    );
  });
}

function arrivedNotHandled(shipments, tomorrowDate) {
  return shipments.filter((shipment) => {
    const customsStatus = shipment.customsBroker?.status || "customs-unknown";
    const freightStatus = shipment.freightBroker?.status || "freight-missing";
    const text = shipmentText(shipment);
    const trackedStation = String(
      shipment.liveTracking?.finalArrivalEvent?.station ||
        shipment.liveTracking?.latestEvent?.station ||
        "",
    ).toUpperCase();
    const shipmentStation = String(shipment.station || "").toUpperCase();
    const atFinalStation =
      shipment.pickupStatus === "ready" ||
      shipment.pickupStatus === "airport-picked-up" ||
      !trackedStation ||
      !shipmentStation ||
      trackedStation === shipmentStation;
    const relevantTomorrow =
      textMentionsDay(text, tomorrowDate) ||
      isArrivedOrAvailable(shipment);
    return (
      relevantTomorrow &&
      atFinalStation &&
      isArrivedOrAvailable(shipment) &&
      (shipment.emailValidation?.status === "email-conflict" ||
        customsStatus === "customs-hold" ||
        (shipment.arrivalStatus === "arrived" && customsStatus !== "customs-cleared") ||
        ["freight-missing", "freight-requested", "freight-unknown"].includes(freightStatus))
    );
  });
}

function groupedTomorrowBlockers(groups, blockers) {
  const blockerIds = new Set(blockers.map((shipment) => shipment.id));
  const groupedIds = new Set();
  const grouped = groups
    .map((group) => {
      const ids = (group.shipmentIds || []).filter((id) => blockerIds.has(id));
      if (!ids.length) return null;
      ids.forEach((id) => groupedIds.add(id));
      return {
        group,
        blockedCount: ids.length,
        shipments: blockers.filter((shipment) => ids.includes(shipment.id)),
      };
    })
    .filter(Boolean);

  const singles = blockers
    .filter((shipment) => !groupedIds.has(shipment.id))
    .map((shipment) => ({ shipment }));

  return [...grouped, ...singles];
}

function oneLine(value, fallback = "No detail") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function compactAwbs(awbs) {
  if (!awbs?.length) return "AWB unknown";
  return awbs.length === 1 ? awbs[0] : `${awbs[0]} +${awbs.length - 1}`;
}

function groupBySummary(items, keyForItem) {
  const groups = new Map();
  for (const item of items) {
    const key = keyForItem(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

function compactAction(value, fallback) {
  return oneLine(value, fallback)
    .replace(/^Confirm /i, "confirm ")
    .replace(/^Track /i, "track ")
    .replace(/^Obtain /i, "obtain ")
    .replace(/\.$/, "");
}

function compactText(value, fallback, maxLength = 150) {
  const text = oneLine(value, fallback);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trim()}...` : text;
}

function compactRate(freightBroker) {
  const rate = freightBroker?.rate;
  if (!rate || rate === "Not found") return "";
  if (/;|preserve other quote|prior quote stack|reviewed thread/i.test(rate)) return "";
  return compactText(rate, "", 34);
}

function compactPlan(shipment, maxLength = 110) {
  const broker = shipment.freightBroker || {};
  const plan = broker.pickupPlan && broker.pickupPlan !== "Not found" ? broker.pickupPlan : "";
  if (plan) return compactText(plan, "", maxLength);
  return compactText(compactAction(broker.nextAction || shipment.nextAction, "confirm pickup/delivery plan"), "", maxLength);
}

function arrivalTiming(shipment) {
  const scheduled = shipment.liveTracking?.scheduledArrival || "";
  const eta = shipment.eta || "";
  const value = oneLine(scheduled || eta, "ETA not found");
  if (/\b(arrive|arrival|recover|eta)\b/i.test(value)) return value;
  if (/\bdepart\b/i.test(value)) return `${value}; arrival ETA not found`;
  return value;
}

function emailBrief(shipment) {
  const validation = shipment.emailValidation || {};
  const summary = validation.summary || "";
  if (/pre-alert/i.test(summary) && /3461|7501|firms|noa/i.test(summary)) {
    return "email: pre-alert/customs setup only; no release or pickup award yet";
  }
  if (/offload|offloaded|rebook|planned move/i.test(summary)) {
    return "email: rebook/offload context found; no destination arrival proof yet";
  }
  if (validation.status === "email-confirmed") return compactText(summary, "email confirmed", 125);
  if (validation.status === "email-pending") return compactText(summary, "email pending", 125);
  if (validation.status === "email-conflict") return compactText(summary, "email conflict", 125);
  return "email: no current operational proof found";
}

function lineForArrival(shipment) {
  return `- ${shipment.awb} ${shipment.station || ""} - ${compactText(arrivalTiming(shipment), "ETA not found", 72)}; ${compactText(emailBrief(shipment), "email status unknown", 80)}`;
}

function deliveryCloseoutText(record) {
  const parts = [];
  if (record.freightBroker && record.freightBroker !== "Not found") parts.push(record.freightBroker);
  if (record.podStatus === "pod-found") parts.push("POD received");
  else if (record.podStatus === "signed-pod-pending") parts.push("signed POD pending");
  if (record.plan && record.plan !== "Not found") parts.push(compactText(record.plan, "completed today", 88));
  return parts.length ? joinParts(parts) : "completed today";
}

function proofBrief(shipment) {
  const tracking = shipment.liveTracking || {};
  const emailStatus = shipment.emailValidation?.status || "email-missing";
  const email =
    emailStatus === "email-confirmed"
      ? "email confirmed"
      : emailStatus === "email-pending"
      ? "email pending"
      : emailStatus === "email-conflict"
      ? "email conflict"
      : "email missing";

  if (tracking.source === "Gmail" || tracking.code === "EMAIL-AVAILABLE") {
    return `arrival proof: email available/released; carrier proof missing; ${email}`;
  }

  if (tracking.finalArrivalEvent) {
    const arrivalTime =
      tracking.finalArrivalEvent.actualArrival ||
      tracking.finalArrivalEvent.timeLocal ||
      tracking.latestEvent?.actualArrival ||
      "";
    return `arrival proof: carrier ${tracking.status || "arrived"}${arrivalTime ? ` ${arrivalTime}` : ""}; ${email}`;
  }

  if (/ready|available|arrived/i.test(`${tracking.status || ""} ${tracking.latestEvent?.description || ""}`)) {
    return `arrival proof: carrier ${tracking.status || "available"}; ${email}`;
  }

  if (shipment.trackingException?.type === "eta-passed-no-arrival-proof") {
    return `arrival proof: ETA passed only; no carrier arrival event; ${email}`;
  }

  if (shipment.arrivalStatus === "arrived") {
    return `arrival proof: TMS/email inferred; carrier event missing; ${email}`;
  }

  return `arrival proof: not arrived; ${email}`;
}

function lineForExpectedFact(fact) {
  const detail = [fact.action, fact.summary]
    .map((item) => oneLine(item))
    .filter((item) => item !== "No detail");
  return `- ${fact.awb} ${fact.station || ""}${detail.length ? ` - ${detail.join("; ")}` : ""}`;
}

function joinParts(parts) {
  return parts.filter(Boolean).join("; ");
}

function limitLines(lines, total, max = 8) {
  const visible = lines.slice(0, max);
  if (total > max) visible.push(`- +${total - max} more`);
  return visible.join("\n");
}

function dispatchTimingBrief(shipment, tomorrowDate) {
  const text = shipmentText(shipment);
  if (textMentionsDay(text, tomorrowDate) && /\b(deliver|delivery|pod)\b/i.test(text)) return "delivery tomorrow";
  if (textMentionsDay(text, tomorrowDate) && /\b(pickup|recover|dispatch)\b/i.test(text)) return "pickup/recovery tomorrow";
  if (isArrivedOrAvailable(shipment)) return "ready for pickup/delivery";
  return "track until arrival";
}

function lineForDispatch(shipment, tomorrowDate) {
  const broker = shipment.freightBroker || {};
  const brokerText = broker.broker && broker.broker !== "Not found" ? broker.broker : "broker TBD";
  return `- ${shipment.awb} ${shipment.station || ""} - ${joinParts([dispatchTimingBrief(shipment, tomorrowDate), brokerText, compactRate(broker), compactPlan(shipment, 90)])}`;
}

function lineForDispatchGroup(shipments, tomorrowDate) {
  if (shipments.length === 1) return lineForDispatch(shipments[0], tomorrowDate);
  const first = shipments[0];
  const broker = first.freightBroker || {};
  const brokerText = broker.broker && broker.broker !== "Not found" ? broker.broker : "broker TBD";
  const timing = shipments.some((shipment) => /delivery tomorrow|pickup\/recovery tomorrow/.test(dispatchTimingBrief(shipment, tomorrowDate)))
    ? dispatchTimingBrief(shipments.find((shipment) => /delivery tomorrow|pickup\/recovery tomorrow/.test(dispatchTimingBrief(shipment, tomorrowDate))), tomorrowDate)
    : dispatchTimingBrief(first, tomorrowDate);
  return `- ${compactAwbs(shipments.map((shipment) => shipment.awb))} ${first.station || ""} - ${joinParts([timing, brokerText, compactRate(broker), compactPlan(first, 90)])}`;
}

function blockerReason(shipment) {
  const broker = shipment.freightBroker || {};
  const customs = shipment.customsBroker || {};
  if (broker.status === "freight-requested" || isFreightUnconfirmed(broker.status)) return "broker unconfirmed";
  if (broker.status === "freight-missing") return "broker unconfirmed";
  if (customs.status === "customs-hold") return "customs hold";
  if (customs.status === "customs-pending") return "await customs release";
  if (shipment.emailValidation?.status !== "email-confirmed") return "confirm station/arrival proof";
  return "review handling";
}

function lineForBlocker(shipment) {
  const issue = blockerReason(shipment);
  return `- ${shipment.awb} ${shipment.station || ""} - ${proofBrief(shipment)}; ${compactText(compactAction(shipment.nextAction, issue), issue, 84)}`;
}

function lineForBlockerGroup(item) {
  if (item.shipment) return lineForBlocker(item.shipment);
  if (item.shipments?.length) return item.shipments.map(lineForBlocker).join("\n");
  const { group } = item;
  return `- ${compactAwbs(group.awbs)} ${group.station || ""} - ${compactAction(group.action, "review handling")}`;
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function readJsonLines(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function completedToday(records, reportDate) {
  return records.filter((record) => String(record.completedAt || "").startsWith(reportDate.iso));
}

function textMentionsReportDate(text, reportDate) {
  const haystack = String(text || "");
  return [reportDate.iso, `${reportDate.weekday},`, reportDate.weekday].some((token) => haystack.includes(token));
}

function todaySignal(text) {
  return /\b(arrived|available|recovered|released|customs released|payment delivered|receipt|delivery order|d\/?o\b|quote|quoted|awarded|approved|pickup|picked up|loaded|delivered|delivery completed|pod|invoice)\b/i.test(
    String(text || ""),
  );
}

function todayFacts(reportFacts, reportDate) {
  return (reportFacts.todayEvents || []).filter((fact) => {
    if (!fact.date) return true;
    return String(fact.date).startsWith(reportDate.iso);
  });
}

function shipmentTodayEvents(shipments, reportDate) {
  const events = [];
  for (const shipment of shipments) {
    for (const row of shipment.timeline || []) {
      const text = row.filter(Boolean).join(" - ");
      if (textMentionsReportDate(text, reportDate) && todaySignal(text)) {
        events.push({
          awb: shipment.awb,
          station: shipment.station,
          summary: oneLine(text),
        });
      }
    }
    for (const item of shipment.emailValidation?.proof || []) {
      const text = [item.label, item.note].filter(Boolean).join(" - ");
      if (textMentionsReportDate(text, reportDate) && todaySignal(text)) {
        events.push({
          awb: shipment.awb,
          station: shipment.station,
          summary: oneLine(text),
        });
      }
    }
  }
  return events;
}

function dedupeTodayEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.awb, event.station, event.summary].map((item) => String(item || "").toLowerCase()).join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function lineForTodayEvent(event) {
  return `- ${event.awb} ${event.station || ""} - ${oneLine(event.summary || event.action, "status changed today")}`;
}

function completedFactEvents(reportFacts, reportDate) {
  return todayFacts(reportFacts, reportDate).filter((event) => {
    const category = String(event.category || "");
    const summary = String(event.summary || "");
    return (
      /\bcompleted\b/i.test(category) ||
      /\b(delivery completed|delivered to consignee|pod|invoice)\b/i.test(summary)
    );
  });
}

function lineForCompletedRecord(record) {
  return `- ${record.awb} ${record.station || ""} - ${deliveryCloseoutText(record)}`;
}

async function writeReportEmailRequest(subject, body) {
  const now = new Date().toISOString();
  const outbox = await readJson(OUTBOX_PATH, {
    sourceOfTruth:
      "Dashboard-created outbox requests are draft intents. The agent/Gmail transport must create drafts and mark them ready for human approval.",
    requests: [],
  });
  const id = `eod-report-${Date.parse(now)}`;
  const request = {
    id,
    actionId: id,
    shipmentId: "",
    awb: "",
    type: "eod-report",
    label: "Draft EOD report",
    channel: "gmail",
    originalChannel: "gmail",
    originalExecution: "draft-only",
    execution: "draft-only",
    autonomy: autonomyForChannel("gmail"),
    status: "suggested",
    createdAt: now,
    queuedAt: "",
    targetName: "PQ EOD draft inbox",
    to: REPORT_EMAIL_TO,
    cc: "",
    bcc: "",
    subject,
    body,
    orderLink: "",
    reason: "Daily end-of-day tomorrow plan report.",
    safety: safetyForChannel("gmail"),
    betaContract: betaDraftModeContract(),
  };

  const existingRequests = (outbox.requests || []).filter(
    (item) => !(item.actionId || "").startsWith("eod-report-"),
  );
  await fs.writeFile(
    OUTBOX_PATH,
    `${JSON.stringify(
      {
        ...outbox,
        snapshotTime: now,
        requests: [request, ...existingRequests].slice(0, 200),
      },
      null,
      2,
    )}\n`,
  );
  return request;
}

async function generateEodReport() {
  await runOpsSync({ rootDir: ROOT_DIR });

  const truthPacketsPath = path.join(ROOT_DIR, "shipment-truth-packets.json");
  const groupsPath = path.join(ROOT_DIR, "shipment-groups.json");
  const completedPath = path.join(ROOT_DIR, "completed-shipments.jsonl");
  const stationContextPath = path.join(ROOT_DIR, "station-context.json");
  const reportFacts = await readJson(REPORT_FACTS_PATH, {});
  const truthPackets = JSON.parse(await fs.readFile(truthPacketsPath, "utf8"));
  const groupData = JSON.parse(await fs.readFile(groupsPath, "utf8").catch(() => "{\"groups\":[]}"));
  const completedRecords = await readJsonLines(completedPath);
  const stationContext = JSON.parse(await fs.readFile(stationContextPath, "utf8").catch(() => "{}"));
  const shipments = truthPackets.shipments || [];
  const groups = groupData.groups || [];
  const stationFacts = (stationContext.stations || []).flatMap((station) => station.facts || []);
  const tomorrowDate = addDays(new Date(), 1);
  const tomorrowLabel = localDateLabel(tomorrowDate);
  const reportDate = localDateParts();
  const reportLabel = localDateLabel(new Date());
  const tomorrow = tomorrowArrivals(shipments, tomorrowDate);
  const completedRecordsToday = completedToday(completedRecords, reportDate);
  const completedAwbs = new Set(completedRecordsToday.map((record) => record.awb));
  const dispatches = dispatchedShipments(
    shipments.filter((shipment) => !completedAwbs.has(shipment.awb)),
    tomorrowDate,
  );
  const dispatchGroups = groupBySummary(dispatches, (shipment) =>
    [
      shipment.station,
      shipment.freightBroker?.broker,
      shipment.freightBroker?.rate,
      compactPlan(shipment),
    ].join("|"),
  );
  const blockers = arrivedNotHandled(
    shipments.filter((shipment) => !completedAwbs.has(shipment.awb) && !dispatches.find((item) => item.awb === shipment.awb)),
    tomorrowDate,
  );
  const blockerItems = groupedTomorrowBlockers(groups, blockers);
  const subject = `PQ EOD ${reportLabel} - tomorrow ${tomorrowLabel}`;
  const completedLines = completedRecordsToday.map(lineForCompletedRecord);
  const openLines = blockerItems.map(lineForBlockerGroup);
  const arrivalLines = tomorrow.map(lineForArrival);
  const dispatchLines = dispatchGroups.map((group) => lineForDispatchGroup(group, tomorrowDate));

  const report = [
    `PQ EOD ${reportLabel}`,
    `Tomorrow: ${tomorrowLabel}`,
    "",
    `Completed today (${completedRecordsToday.length})`,
    limitLines(completedLines, completedLines.length) || "- None found.",
    "",
    `Arrivals tomorrow (${tomorrow.length})`,
    limitLines(arrivalLines, arrivalLines.length) || "- None found.",
    "",
    `Dispatched / pickup tomorrow (${dispatches.length})`,
    limitLines(dispatchLines, dispatchLines.length) || "- None found.",
    "",
    `Arrived, needs handling (${blockers.length})`,
    limitLines(openLines, openLines.length) || "- None found.",
  ]
    .join("\n");

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const datedPath = path.join(REPORTS_DIR, `eod-report-${reportDate.iso}.md`);
  const latestPath = path.join(REPORTS_DIR, "eod-report-latest.md");
  await fs.writeFile(datedPath, report);
  await fs.writeFile(latestPath, report);
  const emailRequest = await writeReportEmailRequest(subject, report);

  return {
    path: datedPath,
    latestPath,
    emailRequestId: emailRequest.id,
    emailTo: emailRequest.to,
    activeShipments: shipments.length,
    deliveryGroups: groups.length,
    tomorrowArrivals: tomorrow.length,
    dispatchFollowUps: dispatches.length,
    completedToday: completedRecordsToday.length,
    arrivedNeedsHandlingShipments: blockers.length,
    arrivedNeedsHandlingItems: blockerItems.length,
    emailGaps: shipments.filter((shipment) => shipment.emailValidation?.status !== "email-confirmed").length,
    customsMissing: shipments.filter((shipment) => shipment.customsBroker?.broker === "Not found").length,
    customsHolds: shipments.filter((shipment) => shipment.customsBroker?.status === "customs-hold").length,
    freightMissing: shipments.filter((shipment) => shipment.freightBroker?.status === "freight-missing").length,
    stationMemoryFacts: stationFacts.length,
    stationMemoryMatchedShipments: truthPackets.counts?.stationMemoryMatches || 0,
  };
}

if (require.main === module) {
  generateEodReport()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { generateEodReport };

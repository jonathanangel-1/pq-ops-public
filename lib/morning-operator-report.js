"use strict";

const path = require("node:path");
const {
  deterministicAnswer,
  publicBrainAnswer,
  readOpsBrainMemory,
} = require("./ops-brain-companion");

const TIME_ZONE = "America/New_York";
const MORNING_REPORT_AWB = "MORNING-REPORT";
const MORNING_REPORT_EVENT_TYPE = "morning-report";

function localDateParts(date = new Date(), timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
}

function localDateKey(date = new Date(), timeZone = TIME_ZONE) {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function countAnswerItems(answer) {
  if (Array.isArray(answer?.allItems)) return answer.allItems.length;
  if (Array.isArray(answer?.items)) return answer.items.length;
  return 0;
}

function compactReportItems(answer, limit = 12) {
  const rows = Array.isArray(answer?.allItems) && answer.allItems.length ? answer.allItems : answer?.items || [];
  return rows.slice(0, limit).map((item) => ({
    id: item.id || item.awb || "",
    awb: item.awb || "",
    context: item.context || "",
    action: item.action || "Open shipment",
    signals: Array.isArray(item.signals) ? item.signals.slice(0, 3) : [],
  })).filter((item) => item.awb || item.id);
}

function uniqueRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = String(row.awb || row.id || "").replace(/\D/g, "") || String(row.awb || row.id || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function compactReportActions(answer, limit = 3) {
  return (answer?.actions || [])
    .filter((action) => action && action.channel !== "platform")
    .slice(0, limit);
}

function plural(count, singular, pluralValue = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralValue}`;
}

function morningReportSummary(counts) {
  const parts = [
    `${plural(counts.deliveryToday, "delivery", "deliveries")} today`,
    `${plural(counts.arrivalsToHandle, "arrival")} to handle`,
  ];
  if (counts.priorityItems) parts.push(`${plural(counts.priorityItems, "priority item")} total`);
  return parts.join(" · ");
}

async function buildMorningOperatorReport(options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const now = options.now instanceof Date ? options.now : new Date();
  const timeZone = options.timeZone || TIME_ZONE;
  const localDate = options.localDate || localDateKey(now, timeZone);
  const memory = options.memory || await readOpsBrainMemory(rootDir, options.env || process.env);

  const delivery = publicBrainAnswer(deterministicAnswer("What is out for delivery today?", memory, []));
  const arrivals = publicBrainAnswer(deterministicAnswer("What arrived today and still needs to be handled?", memory, []));
  const priority = publicBrainAnswer(deterministicAnswer("Good morning. What needs my attention?", memory, []));

  const counts = {
    deliveryToday: countAnswerItems(delivery),
    arrivalsToHandle: countAnswerItems(arrivals),
    priorityItems: countAnswerItems(priority),
  };
  const rows = uniqueRows([
    ...compactReportItems(delivery, 8),
    ...compactReportItems(arrivals, 8),
    ...compactReportItems(priority, 8),
  ]).slice(0, 12);
  const actions = compactReportActions(priority);
  const summary = morningReportSummary(counts);
  const title = "Morning report";
  const message = `${summary}.`;
  const nextAction = rows.length
    ? "Open Rowan, review the top rows, then ask follow-up questions or tap a shipment."
    : "Open Rowan if you want to double-check the shipment memory.";

  const report = {
    localDate,
    timeZone,
    generatedAt: now.toISOString(),
    counts,
    summary,
    delivery: {
      title: delivery.title || "Out for delivery",
      answer: delivery.answer || "",
      items: compactReportItems(delivery, 20),
    },
    arrivals: {
      title: arrivals.title || "Arrivals",
      answer: arrivals.answer || "",
      items: compactReportItems(arrivals, 20),
    },
    priority: {
      title: priority.title || "What needs action",
      answer: priority.answer || "",
      items: compactReportItems(priority, 20),
    },
    rows,
    actions,
  };

  return {
    localDate,
    report,
    event: {
      eventId: `${MORNING_REPORT_EVENT_TYPE}:${localDate}`,
      id: `${MORNING_REPORT_EVENT_TYPE}:${localDate}`,
      awb: MORNING_REPORT_AWB,
      normalizedAwb: "",
      eventType: MORNING_REPORT_EVENT_TYPE,
      type: MORNING_REPORT_EVENT_TYPE,
      severity: "today",
      status: "active",
      title,
      subtitle: `7:00 AM · ${localDate}`,
      message,
      nextAction,
      occurredAt: now.toISOString(),
      createdAt: now.toISOString(),
      source: {
        kind: MORNING_REPORT_EVENT_TYPE,
        localDate,
        timeZone,
        report,
      },
      pushAllowed: true,
    },
  };
}

module.exports = {
  MORNING_REPORT_AWB,
  MORNING_REPORT_EVENT_TYPE,
  TIME_ZONE,
  buildMorningOperatorReport,
  localDateKey,
  morningReportSummary,
};

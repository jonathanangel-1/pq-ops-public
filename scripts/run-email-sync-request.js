#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  gmailDirectEnv,
  runDirectGmailRefresh,
} = require("../lib/gmail-direct-ingest");
const {
  assertLegacyGmailIngestionAllowed,
  legacyGmailIngestionChildEnv,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");
const QUEUE_PATH = path.join(ROOT_DIR, "email-sync-requests.json");
const DEFAULT_RESULT_PATH = "gmail-enrichment-update.json";

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function loadDotEnvLocal() {
  try {
    const content = await fs.readFile(path.join(ROOT_DIR, ".env.local"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    // Env can be supplied by the caller.
  }
}

async function readJson(fileName, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(fileName, value) {
  await fs.writeFile(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function relativePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.relative(ROOT_DIR, raw) : raw.replace(/^[/\\]+/, "");
}

function resolveLocalArtifactPath(fileName) {
  const relative = relativePath(fileName);
  const resolved = path.resolve(ROOT_DIR, relative);
  if (resolved !== ROOT_DIR && !resolved.startsWith(`${ROOT_DIR}${path.sep}`)) {
    throw new Error("Email proof context path is outside the app workspace");
  }
  return resolved;
}

async function readQueue() {
  return readJson("email-sync-requests.json", {
    sourceOfTruth:
      "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
    requests: [],
  });
}

async function writeQueue(queue) {
  await fs.writeFile(QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`);
}

async function patchRequest(requestId, patch) {
  const queue = await readQueue();
  const now = new Date().toISOString();
  const requests = (queue.requests || []).map((request) =>
    request?.id === requestId ? { ...request, ...patch } : request
  );
  await writeQueue({ ...queue, snapshotTime: now, requests });
  return requests.find((request) => request?.id === requestId) || null;
}

function findRequest(queue, requestId) {
  return (queue.requests || []).find((request) => request?.id === requestId) || null;
}

async function readContextForRequest(request) {
  if (!request?.contextFile) return null;
  return JSON.parse(await fs.readFile(resolveLocalArtifactPath(request.contextFile), "utf8"));
}

function requestedAwbs(request = {}, context = {}) {
  return [...new Set([
    request.awb,
    ...(request.awbs || []),
    context.request?.awb,
    ...(context.request?.awbs || []),
    ...(context.job?.payload?.awbs || []),
    ...(context.queries || []).map((query) => query.awb),
  ].map(normalizeAwb).filter(Boolean))];
}

function packetQueries(context = {}) {
  return [...new Set((context.queries || [])
    .flatMap((shipment) => shipment.suggestedQueries || [])
    .map((query) => String(query || "").trim())
    .filter(Boolean))];
}

function packetRequiredThreadIds(context = {}) {
  return [...new Set((context.queries || [])
    .flatMap((shipment) => [
      ...(shipment.knownThreadIds || []),
      ...(shipment.requiredThreadReads || []).map((read) => read.threadId || read.id),
    ])
    .map((threadId) => String(threadId || "").trim())
    .filter(Boolean))];
}

async function localMemorySnapshots() {
  return {
    active: await readJson("shipment-truth-packets.json", { shipments: [] }),
    brain: await readJson("ops-brain-memory.json", null),
    companionMemory: await readJson("companion-memory.json", null),
    stationMemory: await readJson("station-memory.json", { contacts: [] }),
    carrierTrackingSnapshots: [
      await readJson("united-tracking-snapshot.json", { tracking: [] }),
      await readJson("elal-tracking-snapshot.json", { tracking: [] }),
      await readJson("other-tracking-snapshot.json", { tracking: [] }),
    ],
  };
}

function skippedAwbsFor(requestAwbs, proofs, context = {}) {
  const covered = new Set((proofs || []).map((proof) => normalizeAwb(proof?.awb)).filter(Boolean));
  const queriesByAwb = new Map();
  for (const shipment of context.queries || []) {
    const key = normalizeAwb(shipment.awb);
    if (key) queriesByAwb.set(key, shipment.suggestedQueries || []);
  }
  return requestAwbs
    .filter((awb) => !covered.has(normalizeAwb(awb)))
    .map((awb) => ({
      awb,
      reason: "Direct Gmail packet execution did not find durable proof for this requested AWB.",
      searchedQueries: queriesByAwb.get(normalizeAwb(awb)) || [],
    }));
}

function latestEvent(events = [], predicate = () => true) {
  return (events || [])
    .filter(predicate)
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0] || null;
}

function firstUseful(...values) {
  return values.find((value) => {
    const text = String(value || "").trim();
    return text && !/^(not found|unknown|n\/a|none|-+)$/i.test(text);
  }) || "";
}

function eventEvidence(event = {}, label = "") {
  return {
    label: label || event.summary || event.type || "Gmail source",
    note: event.evidence || event.summary || "",
    threadId: event.threadId || "",
    messageId: event.messageId || "",
  };
}

function recordsByKey(records = [], keyFor = () => "") {
  const map = new Map();
  for (const record of records || []) {
    const key = keyFor(record);
    if (key) map.set(key, record);
  }
  return [...map.values()];
}

function brokerRecordsFromProofs(proofs = []) {
  return recordsByKey((proofs || []).flatMap((proof) => {
    const events = proof.events || [];
    const release = latestEvent(events, (event) => event.type === "customs-release-received");
    const inferred = latestEvent(events, (event) => event.type === "customs-broker-inferred");
    if (!release && !inferred) return [];
    const award = latestEvent(events, (event) => event.type === "broker-awarded");
    const contact = inferred || award || {};
    const broker = firstUseful(contact.broker, contact.selectedBroker, award?.selectedBroker, award?.broker, proof.customsBroker?.broker);
    const contactEmail = firstUseful(contact.contactEmail, award?.contactEmail, proof.customsBroker?.contactEmail);
    const evidenceEvent = release || inferred;
    return [{
      awb: proof.awb || evidenceEvent?.awb || "",
      status: release ? "customs-released-do-received" : "customs-pending",
      broker: broker || "Not found",
      contactName: firstUseful(contact.contactName, broker) || "Not found",
      contactEmail: contactEmail || "Not found",
      contactPhone: firstUseful(contact.contactPhone, award?.contactPhone) || "Not found",
      confidence: release?.confidence || inferred?.confidence || "medium",
      releaseProof: release ? release.summary || release.evidence || "Customs release/DO evidence was received." : "Customs broker/source thread was identified; release still needs confirmation.",
      nextAction: release
        ? "No customs action from this source; continue station/payment/pickup execution from the refreshed shipment state."
        : inferred?.nextAction || "Use this broker contact/thread for release/DO follow-up.",
      evidence: [eventEvidence(evidenceEvent, release ? "Customs release confirmation" : "Customs broker source")],
    }];
  }), (record) => [normalizeAwb(record.awb), record.status, record.contactEmail, record.releaseProof].join("|"));
}

function dispatchRecordsFromProofs(proofs = []) {
  return recordsByKey((proofs || []).flatMap((proof) => {
    const events = proof.events || [];
    const quotes = events
      .filter((event) => event.type === "pickup-quote-received")
      .map((event) => ({
        broker: event.broker || "Unknown broker",
        contactEmail: event.contactEmail || "",
        amount: event.amount || "",
        currency: event.currency || "USD",
        rate: event.amount || "",
        service: event.service || "pickup quote",
        quotedAt: event.at || "",
        evidence: [eventEvidence(event, "Pickup quote")],
      }));
    const award = latestEvent(events, (event) => event.type === "broker-awarded");
    if (!award && !quotes.length) return [];
    const broker = firstUseful(award?.selectedBroker, award?.broker, quotes[0]?.broker);
    return [{
      awb: proof.awb || award?.awb || "",
      broker: broker || "Not found",
      awardedBroker: award ? broker || "Not found" : "",
      selectedBroker: award ? broker || "Not found" : "",
      status: award ? "freight-awarded" : "quotes-in",
      rate: award?.amount || quotes[0]?.rate || "Not found",
      pickupPlan: award
        ? `${broker || "Pickup broker"} acknowledged or was approved for pickup; confirm physical pickup proof before POD.`
        : "Pickup quotes were found; choose/confirm the broker before release packet dispatch.",
      contactEmail: firstUseful(award?.contactEmail, quotes[0]?.contactEmail),
      contactPhone: firstUseful(award?.contactPhone),
      brokerStatus: award ? "Broker award/approval found in Gmail source backfill." : "Pickup quotes found in Gmail source backfill.",
      cargoAvailable: Boolean(award),
      cargoReleased: Boolean(award || latestEvent(events, (event) => event.type === "customs-release-received")),
      latestEventAt: award?.at || quotes[0]?.quotedAt || proof.latestEventAt || "",
      evidence: award ? [eventEvidence(award, "Pickup broker award")] : quotes.flatMap((quote) => quote.evidence || []),
      quotes,
      nextAction: award
        ? `Confirm pickup timing/status with ${broker || "the pickup broker"} and collect pickup proof.`
        : "Review quotes and approve the pickup broker.",
    }];
  }), (record) => [normalizeAwb(record.awb), record.status, record.broker, record.latestEventAt].join("|"));
}

function factRecordsFromProofs(proofs = [], request = {}) {
  return recordsByKey((proofs || []).flatMap((proof) => {
    const sourceBackfillFact = request.type === "source-backfill" && proof.summary
      ? [{
          awb: proof.awb || "",
          section: "source-backfill",
          summary: proof.summary,
          threadId: proof.proof?.[0]?.threadId || proof.events?.[0]?.threadId || "",
          messageId: proof.proof?.[0]?.messageId || proof.events?.[0]?.messageId || "",
          evidence: (proof.proof || []).slice(0, 3).map((item) => ({
            label: item.label || "Gmail proof",
            note: item.note || item.summary || "",
            threadId: item.threadId || "",
            messageId: item.messageId || "",
          })),
        }]
      : [];
    const eventFacts = (proof.events || [])
      .filter((event) =>
        event.type === "exception" ||
        ["ground-fees-paid", "arrival-notice-received", "customs-broker-inferred"].includes(event.type)
      )
      .map((event) => ({
        awb: proof.awb || event.awb || "",
        section: event.type === "exception"
          ? [event.where || "ops", event.exceptionType || "exception"].filter(Boolean).join("-")
          : event.type.replace(/-/g, "_"),
        summary: event.summary || event.evidence || "",
        threadId: event.threadId || "",
        messageId: event.messageId || "",
        evidence: [eventEvidence(event)],
      }));
    return [...sourceBackfillFact, ...eventFacts];
  }), (record) => [normalizeAwb(record.awb), record.section, record.threadId, record.messageId, record.summary].join("|"));
}

function promoteProofsToEnrichment(proofs = [], request = {}) {
  return {
    dispatches: dispatchRecordsFromProofs(proofs),
    brokers: brokerRecordsFromProofs(proofs),
    facts: factRecordsFromProofs(proofs, request),
  };
}

function runComplete(request, outputFile, workerId) {
  const args = [
    "--job-id",
    request.id,
    "--result",
    outputFile,
    "--worker-id",
    workerId,
  ];
  if (!(process.env.PQ_SUPABASE_URL && (process.env.PQ_SUPABASE_SERVICE_ROLE_KEY || process.env.PQ_SUPABASE_ANON_KEY))) {
    args.push("--skip-sync");
  }
  const output = execFileSync(process.execPath, [path.join(ROOT_DIR, "scripts", "complete-gmail-refresh.js"), ...args], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    env: legacyGmailIngestionChildEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output || "{}");
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/run-email-sync-request.js");
  await loadDotEnvLocal();
  const requestId = argValue("--request-id");
  const queue = await readQueue();
  const request = findRequest(queue, requestId);
  if (!request) {
    console.log(JSON.stringify({ ok: true, executed: false, blocked: true, reason: "Email proof request not found" }, null, 2));
    return;
  }
  if (!request.contextFile) {
    console.log(JSON.stringify({ ok: true, executed: false, blocked: true, request, reason: "Claim the email proof request before running Gmail" }, null, 2));
    return;
  }

  const context = await readContextForRequest(request);
  const awbs = requestedAwbs(request, context);
  const queries = packetQueries(context);
  const requiredThreadIds = packetRequiredThreadIds(context);
  const workerId = `${os.hostname()}-direct-gmail-packet-${process.pid}`;
  const outputFile = relativePath(argValue("--result", request.outputFile || DEFAULT_RESULT_PATH)) || DEFAULT_RESULT_PATH;
  const gmailConfig = gmailDirectEnv(process.env);

  if (!gmailConfig.available) {
    const missing = [
      gmailConfig.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
      gmailConfig.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
      gmailConfig.refreshToken ? "" : "GMAIL_REFRESH_TOKEN or GOOGLE_GMAIL_REFRESH_TOKEN",
    ].filter(Boolean);
    const patched = await patchRequest(request.id, {
      runStatus: "blocked",
      lastRunAt: new Date().toISOString(),
      lastRunError: `Direct Gmail OAuth env is incomplete: ${missing.join(", ")}`,
      gmailConfig: {
        available: false,
        user: gmailConfig.user,
        missing,
      },
    });
    console.log(JSON.stringify({
      ok: true,
      executed: false,
      blocked: true,
      request: patched,
      reason: "Direct Gmail OAuth env is incomplete",
      gmailConfig: {
        available: false,
        user: gmailConfig.user,
        missing,
      },
    }, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  await patchRequest(request.id, {
    runStatus: "running",
    runStartedAt: startedAt,
    runWorkerId: workerId,
    lastRunError: "",
    outputFile,
  });

  const directResult = await runDirectGmailRefresh({
    awbs,
    queries,
    requiredThreadIds,
    lookbackDays: Number(context.job?.payload?.lookbackDays || request.lookbackDays || process.env.PQ_GMAIL_DIRECT_LOOKBACK_DAYS || 30),
    maxThreads: Number(process.env.PQ_GMAIL_DIRECT_MAX_THREADS || 80),
    maxAttachmentPdfs: Number(process.env.PQ_GMAIL_DIRECT_MAX_PDF_ATTACHMENTS || 4),
    includeProofs: true,
    memorySnapshots: await localMemorySnapshots(),
    write: false,
  });

  const proofs = directResult.proofs || [];
  const skippedAwbs = skippedAwbsFor(awbs, proofs, context);
  const promoted = promoteProofsToEnrichment(proofs, request);
  const update = {
    source: "gmail-direct-local-packet",
    jobId: request.id,
    workerId,
    generatedAt: new Date().toISOString(),
    proofs,
    dispatches: promoted.dispatches,
    brokers: promoted.brokers,
    facts: promoted.facts,
    audit: {
      requestId: request.id,
      contextFile: request.contextFile,
      searchedQueries: directResult.searchedQueries || queries,
      readThreadIds: directResult.readThreadIds || [],
      skippedAwbs,
      promotedCounts: {
        dispatches: promoted.dispatches.length,
        brokers: promoted.brokers.length,
        facts: promoted.facts.length,
      },
      directResult: {
        updated: directResult.updated || 0,
        threadCount: directResult.threadCount || 0,
        queryCount: directResult.queryCount || queries.length,
        attachmentAuditCount: directResult.attachmentAuditCount || 0,
        shipmentEventCount: directResult.shipmentEventCount || 0,
        shipmentStateCount: directResult.shipmentStateCount || 0,
        operatorNotificationCount: directResult.operatorNotificationCount || 0,
      },
    },
  };
  await writeJson(outputFile, update);

  const completed = hasFlag("--complete") && proofs.length
    ? runComplete(request, outputFile, workerId)
    : null;
  const patched = await patchRequest(request.id, {
    runStatus: completed ? "completed" : proofs.length ? "output-ready" : "blocked",
    runCompletedAt: new Date().toISOString(),
    runWorkerId: workerId,
    outputFile,
    lastRunError: proofs.length ? "" : "Direct Gmail packet execution found no durable shipment proof.",
    directGmailResult: {
      updated: directResult.updated || 0,
      threadCount: directResult.threadCount || 0,
      queryCount: directResult.queryCount || queries.length,
      attachmentAuditCount: directResult.attachmentAuditCount || 0,
      skippedAwbCount: skippedAwbs.length,
    },
  });

  console.log(JSON.stringify({
    ok: true,
    executed: true,
    blocked: !proofs.length,
    completed: Boolean(completed),
    request: patched,
    outputFile,
    workerId,
    counts: {
      proofs: proofs.length,
      dispatches: promoted.dispatches.length,
      brokers: promoted.brokers.length,
      facts: promoted.facts.length,
      skippedAwbs: skippedAwbs.length,
    },
    directResult: {
      updated: directResult.updated || 0,
      threadCount: directResult.threadCount || 0,
      queryCount: directResult.queryCount || queries.length,
      attachmentAuditCount: directResult.attachmentAuditCount || 0,
      shipmentEventCount: directResult.shipmentEventCount || 0,
      shipmentStateCount: directResult.shipmentStateCount || 0,
      operatorNotificationCount: directResult.operatorNotificationCount || 0,
    },
    completedResult: completed,
  }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  brokerRecordsFromProofs,
  dispatchRecordsFromProofs,
  factRecordsFromProofs,
  promoteProofsToEnrichment,
};

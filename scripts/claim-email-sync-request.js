#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { context } = require("./gmail-job");
const {
  assertLegacyGmailIngestionAllowed,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");
const QUEUE_PATH = path.join(ROOT_DIR, "email-sync-requests.json");
const DEFAULT_CONTEXT_DIR = path.join("artifacts", "email-sync-requests");
const CLAIMABLE_STATUSES = new Set(["queued", "waiting_external"]);
const SUPPORTED_REQUEST_TYPES = new Set(["gmail-proof-refresh", "source-backfill"]);

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

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

async function readQueue() {
  try {
    return JSON.parse(await fs.readFile(QUEUE_PATH, "utf8"));
  } catch {
    return {
      sourceOfTruth:
        "Dashboard-created email sync requests are work intents. Codex/Gmail automation must read Gmail and mark them complete.",
      requests: [],
    };
  }
}

async function writeQueue(queue) {
  await fs.writeFile(QUEUE_PATH, `${JSON.stringify(queue, null, 2)}\n`);
}

function requestSortTime(request) {
  const parsed = Date.parse(request.queuedAt || request.requestedAt || request.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function nextClaimableRequest(queue, explicitId = "") {
  return (queue.requests || [])
    .filter((request) => {
      if (!request?.id) return false;
      if (explicitId && request.id !== explicitId) return false;
      if (!SUPPORTED_REQUEST_TYPES.has(request.type)) return false;
      return CLAIMABLE_STATUSES.has(String(request.status || "").toLowerCase());
    })
    .sort((a, b) => requestSortTime(a) - requestSortTime(b))[0] || null;
}

function jobForRequest(request) {
  if (request.type === "source-backfill") {
    return {
      id: request.id,
      job_type: "email_refresh",
      status: "running",
      priority: 1,
      attempts: Number(request.attempts || 0),
      max_attempts: 2,
      created_at: request.queuedAt || request.requestedAt || new Date().toISOString(),
      payload: {
        source: "local-email-sync-request",
        actionId: request.actionId || "",
        awbs: [request.awb].filter(Boolean),
        sourceBackfill: true,
        lookbackDays: request.lookbackDays || 120,
        missingStages: request.missingStages || [],
        requestedAt: request.requestedAt || request.queuedAt || new Date().toISOString(),
        expectedOutput: request.expectedOutput || [],
      },
    };
  }
  return {
    id: request.id,
    job_type: "email_refresh",
    status: "running",
    priority: Number(request.priority || 5),
    attempts: Number(request.attempts || 0),
    max_attempts: 2,
    created_at: request.queuedAt || request.requestedAt || new Date().toISOString(),
    payload: {
      source: "local-email-sync-request",
      awbs: request.awbs || [],
      proofSnapshotTime: request.proofSnapshotTime || null,
      proofAgeMinutes: request.proofAgeMinutes ?? null,
      requestedAt: request.requestedAt || request.queuedAt || new Date().toISOString(),
      expectedOutput: request.expectedOutput || [],
    },
  };
}

function relativePath(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? path.relative(ROOT_DIR, value) : value;
}

async function writeContextArtifact(fileName, claim) {
  const relative = relativePath(fileName) || path.join(DEFAULT_CONTEXT_DIR, `${claim.request.id}-claim-context.json`);
  const outputPath = path.join(ROOT_DIR, relative);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(claim, null, 2)}\n`);
  return relative;
}

function completionCommand(requestId, workerId) {
  return [
    "node scripts/complete-gmail-refresh.js --allow-legacy-gmail-ingestion",
    `--job-id ${requestId}`,
    `--worker-id ${workerId}`,
    "--result gmail-enrichment-update.json",
  ].join(" ");
}

function summarizeClaim(claim, contextFile = null) {
  const queryCount = Array.isArray(claim.queries)
    ? claim.queries.reduce((count, shipment) => count + (shipment.suggestedQueries?.length || 0), 0)
    : 0;
  return {
    ok: true,
    claimed: true,
    request: {
      id: claim.request.id,
      type: claim.request.type,
      status: "running",
      awbs: claim.request.awbs || [claim.request.awb].filter(Boolean),
      proofSnapshotTime: claim.request.proofSnapshotTime || null,
    },
    workerId: claim.workerId,
    shipmentCount: claim.shipmentCount || 0,
    activeShipmentCount: claim.activeShipmentCount || 0,
    sourceBackfillShipmentCount: claim.sourceBackfillShipmentCount || 0,
    queryCount,
    outputFile: claim.outputContract?.file || null,
    completionCommand: claim.outputContract?.completionCommand || null,
    contextFile,
  };
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/claim-email-sync-request.js");
  const queue = await readQueue();
  const request = nextClaimableRequest(queue, argValue("--request-id"));
  if (!request) {
    console.log(JSON.stringify({
      ok: true,
      claimed: false,
      reason: "No claimable local email sync request",
      pendingRequestCount: (queue.requests || []).filter((item) =>
        CLAIMABLE_STATUSES.has(String(item.status || "").toLowerCase())
      ).length,
    }, null, 2));
    return;
  }

  const workerId = `${os.hostname()}-local-email-sync-${process.pid}`;
  const now = new Date().toISOString();
  const job = jobForRequest(request);
  const claimContext = await context(job);
  const completion = completionCommand(request.id, workerId);
  const claimedRequest = {
    ...request,
    status: "running",
    claimedAt: now,
    lockedAt: now,
    lockedBy: workerId,
  };
  claimContext.workerId = workerId;
  claimContext.request = claimedRequest;
  claimContext.outputContract = {
    ...(claimContext.outputContract || {}),
    completionCommand: completion,
  };
  claimContext.request.outputFile = claimContext.outputContract?.file || "gmail-enrichment-update.json";
  claimContext.request.completionCommand = claimContext.outputContract?.completionCommand || completion;
  claimContext.queries = (claimContext.queries || []).map((shipment) => ({
    ...shipment,
    normalizedAwb: normalizeAwb(shipment.awb),
  }));
  const contextFile = await writeContextArtifact(argValue("--context-file"), claimContext);

  if (!hasFlag("--dry-run")) {
    const requests = (queue.requests || []).map((item) =>
      item.id === request.id
        ? {
            ...claimedRequest,
            contextFile,
            outputFile: claimContext.outputContract?.file || "gmail-enrichment-update.json",
            completionCommand: claimContext.outputContract?.completionCommand || completion,
          }
        : item
    );
    await writeQueue({ ...queue, snapshotTime: now, requests });
  }

  console.log(JSON.stringify(
    hasFlag("--summary") ? summarizeClaim(claimContext, contextFile) : { ok: true, claimed: true, contextFile, ...claimContext },
    null,
    2
  ));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

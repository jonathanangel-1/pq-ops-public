#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createGmailApiClient } = require("../lib/gmail-api-client");
const { callSupabaseRpc } = require("../lib/supabase-agent");

const ROOT = path.resolve(__dirname, "..");
const WORKSPACE_KEY = "primary";
const CONNECTION_KEY = "primary";
const PARKED_BATCH_ID = "118506f6-7c7b-4bb9-8f62-9a743513a8ca";
const PERSISTED_ANCHOR_HISTORY_ID = "19571223";
const RECOVERY_ANCHOR_HISTORY_ID = "19640268";
const WINDOW_START = "2026-07-13T00:42:00.000Z";
const WINDOW_END = "2026-07-18T18:03:00.000Z";
const FALLBACK_QUERY = "after:1783903319 before:1784397781";
const PLAN_SCHEMA_VERSION = "truth-gmail-cutover-delta-plan-input-v1";
const PLAN_AUTHORITY = "truth-gmail-cutover-delta-reconciliation-v1";
const DEFAULT_WORKER_ID = "truth-gmail-cutover-delta:operator";
const DEFAULT_CHUNK_LIMIT = 20;
const DEFAULT_MAX_CHUNKS = 25;
const DEFAULT_MAX_NONTERMINAL_JOBS = 250;
const MAX_SCAN_PAGES = 100;
const MAX_SCAN_MESSAGES = 5_000;
const METADATA_CONCURRENCY = 5;
const HISTORY_TYPES = Object.freeze([
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
]);
const CRITICAL_MESSAGE_IDS = Object.freeze([
  "1aa0000000000043",
  "1aa0000000000044",
  "1aa0000000000045",
  "1aa0000000000046",
  "1aa0000000000047",
  "1aa0000000000048",
  "1aa0000000000049",
  "1aa000000000004a",
]);
const EVENT_SPECS = Object.freeze([
  Object.freeze({ field: "messagesDeleted", sourceEventType: "message_deleted", precedence: 5, providerDeleted: true }),
  Object.freeze({ field: "labelsRemoved", sourceEventType: "labels_removed", precedence: 4, providerDeleted: false }),
  Object.freeze({ field: "labelsAdded", sourceEventType: "labels_added", precedence: 3, providerDeleted: false }),
  Object.freeze({ field: "messagesAdded", sourceEventType: "message_added", precedence: 2, providerDeleted: false }),
]);

function loadLocalEnv(env = process.env) {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(ROOT, fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || env[match[1]]) continue;
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, "").trim();
    }
  }
}

function requiredEnv(name, env = process.env) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing required environment ${name}`);
  return value;
}

function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON cannot contain a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") {
    throw new Error("Canonical JSON must contain only JSON-compatible values");
  }
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256Json(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function decimalHistoryId(value, field) {
  const result = String(value === undefined || value === null ? "" : value);
  if (!/^[0-9]+$/.test(result)) throw new Error(`${field} must be a decimal Gmail history ID`);
  return result;
}

function compareDecimalIds(left, right) {
  const normalizedLeft = decimalHistoryId(left, "left history ID").replace(/^0+(?=\d)/, "");
  const normalizedRight = decimalHistoryId(right, "right history ID").replace(/^0+(?=\d)/, "");
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1;
  }
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function integerOption(argv, name, fallback, { minimum, maximum }) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  const parsed = Number(argument ? argument.slice(prefix.length) : fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function stringOption(argv, name, fallback) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  const result = String(argument ? argument.slice(prefix.length) : fallback || "").trim();
  if (!result) throw new Error(`--${name} must not be empty`);
  return result;
}

function safeAccountEmail(value, field) {
  const result = String(value || "").trim().toLowerCase();
  if (!result || !result.includes("@")) throw new Error(`${field} must be an email address`);
  return result;
}

function exactHistoryExpired(error) {
  return error?.code === "GMAIL_HISTORY_CURSOR_EXPIRED" ||
    (Number(error?.status) === 404 && String(error?.operation || "") === "history.list");
}

function safeHistoryFailure(error) {
  return {
    errorCode: "GMAIL_HISTORY_CURSOR_EXPIRED",
    observedErrorCode: String(error?.code || "GMAIL_HISTORY_CURSOR_EXPIRED"),
    errorStatus: Number(error?.status || 404),
    errorOperation: String(error?.operation || "history.list"),
  };
}

function assertScope(frontier) {
  const workspaceKey = String(frontier?.workspaceKey || "");
  const connectionKey = String(frontier?.connectionKey || "");
  const persistedAnchor = String(frontier?.priorCursorValue || "");
  const recoveryAnchor = String(frontier?.recoveryAnchorValue || "");
  if (frontier?.ok !== true || workspaceKey !== WORKSPACE_KEY || connectionKey !== CONNECTION_KEY ||
      String(frontier?.parkedBatchId || "") !== PARKED_BATCH_ID ||
      persistedAnchor !== PERSISTED_ANCHOR_HISTORY_ID ||
      recoveryAnchor !== RECOVERY_ANCHOR_HISTORY_ID) {
    throw new Error("Cutover-delta frontier differs from the exact primary authority");
  }
  if (frontier?.productionPublicationAttempted !== false) {
    throw new Error("Cutover-delta frontier omitted the shadow-only publication fence");
  }
}

function assertPlanMembers(members) {
  if (!Array.isArray(members) || members.length < 1 || members.length > MAX_SCAN_MESSAGES) {
    throw new Error("Cutover-delta member manifest is outside its bounded nonempty authority");
  }
  const byMessageId = new Map();
  members.forEach((member, ordinal) => {
    if (member?.memberOrdinal !== ordinal || !member?.messageId || byMessageId.has(member.messageId)) {
      throw new Error("Cutover-delta member manifest is not a unique contiguous sequence");
    }
    byMessageId.set(member.messageId, member);
  });
  for (const messageId of CRITICAL_MESSAGE_IDS) {
    const member = byMessageId.get(messageId);
    if (!member || member.providerDeleted !== false) {
      throw new Error(`Cutover-delta plan omits required live backtest message ${messageId}`);
    }
  }
}

function providerAccountEmail(frontier) {
  const candidates = [
    frontier?.providerAccountEmail,
    frontier?.parkingReceipt?.providerAccountEmail,
    frontier?.reconciliation?.providerAccountEmail,
  ];
  const result = candidates.find((value) => String(value || "").trim());
  return result ? safeAccountEmail(result, "frontier provider account") : "";
}

function normalizeProfileEvidence(profile, expectedAccountEmail, frontier) {
  const configured = safeAccountEmail(expectedAccountEmail, "GMAIL_USER_EMAIL");
  const actual = safeAccountEmail(profile?.emailAddress, "Gmail profile emailAddress");
  const parked = providerAccountEmail(frontier);
  if (actual !== configured) {
    throw new Error("Gmail profile account does not match GMAIL_USER_EMAIL");
  }
  if (parked && actual !== parked) {
    throw new Error("Gmail profile account does not match the immutable parking receipt");
  }
  const historyId = decimalHistoryId(profile?.historyId, "Gmail profile historyId");
  if (compareDecimalIds(historyId, RECOVERY_ANCHOR_HISTORY_ID) < 0) {
    throw new Error("Gmail profile history ID regressed behind the recovery anchor");
  }
  const messagesTotal = Number(profile?.messagesTotal);
  const threadsTotal = Number(profile?.threadsTotal);
  if (!Number.isSafeInteger(messagesTotal) || messagesTotal < 0 ||
      !Number.isSafeInteger(threadsTotal) || threadsTotal < 0) {
    throw new Error("Gmail profile totals are invalid");
  }
  const body = {
    emailAddress: actual,
    historyId,
    messagesTotal,
    threadsTotal,
  };
  return { ...body, profileHash: sha256Json(body) };
}

function historyCandidateIsNewer(candidate, existing) {
  if (!existing) return true;
  const historyOrder = compareDecimalIds(candidate.providerHistoryId, existing.providerHistoryId);
  if (historyOrder !== 0) return historyOrder > 0;
  if (candidate.precedence !== existing.precedence) return candidate.precedence > existing.precedence;
  if (candidate.sourceEventType !== existing.sourceEventType) {
    return candidate.sourceEventType > existing.sourceEventType;
  }
  return candidate.threadId > existing.threadId;
}

function deriveHistoryMembers(scanPages) {
  const latestByMessage = new Map();
  for (const page of scanPages) {
    const history = Array.isArray(page?.providerResponse?.history)
      ? page.providerResponse.history
      : [];
    for (const entry of history) {
      const providerHistoryId = decimalHistoryId(entry?.id, "history entry id");
      if (compareDecimalIds(providerHistoryId, PERSISTED_ANCHOR_HISTORY_ID) <= 0 ||
          compareDecimalIds(providerHistoryId, RECOVERY_ANCHOR_HISTORY_ID) > 0) {
        continue;
      }
      for (const spec of EVENT_SPECS) {
        const events = entry?.[spec.field] === undefined || entry?.[spec.field] === null
          ? []
          : entry[spec.field];
        if (!Array.isArray(events)) throw new Error(`history entry ${spec.field} must be an array`);
        for (const event of events) {
          const message = event?.message;
          const messageId = String(message?.id || "").trim();
          if (!messageId) throw new Error(`history ${spec.field} event omitted message.id`);
          const candidate = {
            messageId,
            threadId: String(message?.threadId || "").trim(),
            providerHistoryId,
            sourceEventType: spec.sourceEventType,
            providerDeleted: spec.providerDeleted,
            precedence: spec.precedence,
          };
          if (historyCandidateIsNewer(candidate, latestByMessage.get(messageId))) {
            latestByMessage.set(messageId, candidate);
          }
        }
      }
    }
  }
  if (latestByMessage.size > MAX_SCAN_MESSAGES) {
    throw new Error(`Cutover delta exceeds the ${MAX_SCAN_MESSAGES}-message safety bound`);
  }
  return [...latestByMessage.values()]
    .sort((left, right) => left.messageId.localeCompare(right.messageId))
    .map(({ precedence: _precedence, ...member }, memberOrdinal) => ({ memberOrdinal, ...member }));
}

function metadataInternalDate(metadata) {
  const value = String(metadata?.internalDate || "");
  if (!/^[0-9]+$/.test(value)) throw new Error("Gmail message metadata internalDate must be epoch milliseconds");
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new Error("Gmail message metadata internalDate is outside the safe integer range");
  }
  return milliseconds;
}

function deriveDateScopedMembers(messageMetadata) {
  const startMs = Date.parse(WINDOW_START);
  const endMs = Date.parse(WINDOW_END);
  return messageMetadata
    .filter((item) => {
      const internalDate = metadataInternalDate(item);
      return internalDate >= startMs && internalDate < endMs;
    })
    .map((item) => ({
      messageId: String(item.messageId || "").trim(),
      threadId: String(item.threadId || "").trim(),
      providerHistoryId: decimalHistoryId(
        item.providerHistoryId,
        `message ${item.messageId} historyId`,
      ),
      sourceEventType: "message_discovered",
      providerDeleted: false,
    }))
    .sort((left, right) => left.messageId.localeCompare(right.messageId))
    .map((member, memberOrdinal) => ({ memberOrdinal, ...member }));
}

function basePlan({
  frontier,
  strategy,
  historyAttempt,
  profileEvidence,
  scanPages,
  messageMetadata,
  members,
}) {
  assertPlanMembers(members);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    authorityVersion: PLAN_AUTHORITY,
    workspaceKey: WORKSPACE_KEY,
    connectionKey: CONNECTION_KEY,
    parkingReceiptId: String(frontier?.parkingReceiptId || ""),
    parkingReceiptHash: String(frontier?.parkingReceiptHash || ""),
    parkedBatchId: PARKED_BATCH_ID,
    priorCursorValue: PERSISTED_ANCHOR_HISTORY_ID,
    recoveryAnchorValue: RECOVERY_ANCHOR_HISTORY_ID,
    windowStartInclusive: WINDOW_START,
    windowEndExclusive: WINDOW_END,
    accountEmail: profileEvidence.emailAddress,
    strategy,
    historyAttempt,
    profileEvidence,
    scanPages,
    messageMetadata,
    members,
    criticalMessageIds: [...CRITICAL_MESSAGE_IDS],
    dateQuery: strategy === "date_scoped_current_mailbox" ? FALLBACK_QUERY : "",
    includeSpamTrash: strategy === "date_scoped_current_mailbox",
    productionPublicationAttempted: false,
  };
}

async function readReconciliation(syncToken, rpc = callSupabaseRpc) {
  return rpc("read_truth_gmail_cutover_delta_reconciliation", {
    p_sync_token: syncToken,
  }, {
    timeoutMs: 30_000,
    retryDelaysMs: [],
  });
}

async function scanRetainedHistory(gmailClient) {
  const scanPages = [];
  const seenPageTokens = new Set();
  let pageToken = "";
  while (true) {
    if (scanPages.length >= MAX_SCAN_PAGES) {
      throw new Error(`Gmail history scan exceeds the ${MAX_SCAN_PAGES}-page safety bound`);
    }
    if (seenPageTokens.has(pageToken)) throw new Error("Gmail history pagination repeated a page token");
    seenPageTokens.add(pageToken);
    const response = await gmailClient.listHistory({
      startHistoryId: PERSISTED_ANCHOR_HISTORY_ID,
      ...(pageToken ? { pageToken } : {}),
      maxResults: 500,
      historyTypes: HISTORY_TYPES,
    });
    const responseHistoryId = decimalHistoryId(response?.historyId, "history response historyId");
    if (compareDecimalIds(responseHistoryId, PERSISTED_ANCHOR_HISTORY_ID) < 0) {
      throw new Error("Gmail history response regressed behind its requested anchor");
    }
    const responseNextPageToken = String(response?.nextPageToken || "");
    scanPages.push({
      pageOrdinal: scanPages.length,
      requestPageToken: pageToken,
      responseNextPageToken,
      isFinal: !responseNextPageToken,
      providerResponseHash: sha256Json(response),
      providerResponse: canonicalize(response),
    });
    if (!responseNextPageToken) break;
    pageToken = responseNextPageToken;
  }
  const terminalHistoryId = String(
    scanPages[scanPages.length - 1]?.providerResponse?.historyId || "",
  );
  if (compareDecimalIds(terminalHistoryId, RECOVERY_ANCHOR_HISTORY_ID) < 0) {
    throw new Error("Terminal Gmail history response does not reach the recovery anchor");
  }
  return {
    scanPages,
    terminalHistoryId,
    members: deriveHistoryMembers(scanPages),
  };
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      result[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

async function scanDateScopedMailbox(gmailClient) {
  const scanPages = [];
  const messageIds = new Set();
  const seenPageTokens = new Set();
  let pageToken = "";
  while (true) {
    if (scanPages.length >= MAX_SCAN_PAGES) {
      throw new Error(`Gmail date-scoped scan exceeds the ${MAX_SCAN_PAGES}-page safety bound`);
    }
    if (seenPageTokens.has(pageToken)) throw new Error("Gmail message pagination repeated a page token");
    seenPageTokens.add(pageToken);
    const response = await gmailClient.listMessages({
      ...(pageToken ? { pageToken } : {}),
      maxResults: 500,
      q: FALLBACK_QUERY,
      includeSpamTrash: true,
    });
    for (const message of Array.isArray(response?.messages) ? response.messages : []) {
      const messageId = String(message?.id || "").trim();
      if (!messageId) throw new Error("Gmail message list returned an item without an ID");
      messageIds.add(messageId);
      if (messageIds.size > MAX_SCAN_MESSAGES) {
        throw new Error(`Cutover delta exceeds the ${MAX_SCAN_MESSAGES}-message safety bound`);
      }
    }
    const responseNextPageToken = String(response?.nextPageToken || "");
    scanPages.push({
      pageOrdinal: scanPages.length,
      requestPageToken: pageToken,
      responseNextPageToken,
      isFinal: !responseNextPageToken,
      providerResponseHash: sha256Json(response),
      providerResponse: canonicalize(response),
    });
    if (!responseNextPageToken) break;
    pageToken = responseNextPageToken;
  }

  const sortedMessageIds = [...messageIds].sort();
  const rawMetadata = await mapConcurrent(
    sortedMessageIds,
    METADATA_CONCURRENCY,
    (messageId) => gmailClient.getMessageMetadata(messageId, { metadataHeaders: [] }),
  );
  const messageMetadata = rawMetadata.map((response, metadataOrdinal) => {
    const messageId = sortedMessageIds[metadataOrdinal];
    if (String(response?.id || "") !== messageId) {
      throw new Error(`Gmail metadata identity differs from listed message ${messageId}`);
    }
    const metadata = {
      messageId,
      threadId: String(response?.threadId || ""),
      providerHistoryId: decimalHistoryId(response?.historyId, `message ${messageId} historyId`),
      internalDate: String(response?.internalDate || ""),
    };
    metadataInternalDate(metadata);
    return { ...metadata, metadataHash: sha256Json(metadata) };
  });
  return {
    scanPages,
    messageMetadata,
    members: deriveDateScopedMembers(messageMetadata),
  };
}

async function buildProviderPlan({ gmailClient, frontier, expectedAccountEmail }) {
  assertScope(frontier);
  const profile = await gmailClient.getProfile();
  const profileEvidence = normalizeProfileEvidence(profile, expectedAccountEmail, frontier);
  try {
    const retained = await scanRetainedHistory(gmailClient);
    return basePlan({
      frontier,
      strategy: "history_retained",
      historyAttempt: {
        status: "complete",
        startHistoryId: PERSISTED_ANCHOR_HISTORY_ID,
        recoveryAnchorHistoryId: RECOVERY_ANCHOR_HISTORY_ID,
        terminalHistoryId: retained.terminalHistoryId,
        pageCount: retained.scanPages.length,
        historyTypes: [...HISTORY_TYPES],
      },
      profileEvidence,
      scanPages: retained.scanPages,
      messageMetadata: [],
      members: retained.members,
    });
  } catch (error) {
    if (!exactHistoryExpired(error)) throw error;
    const fallback = await scanDateScopedMailbox(gmailClient);
    return basePlan({
      frontier,
      strategy: "date_scoped_current_mailbox",
      historyAttempt: {
        status: "expired",
        startHistoryId: PERSISTED_ANCHOR_HISTORY_ID,
        recoveryAnchorHistoryId: RECOVERY_ANCHOR_HISTORY_ID,
        terminalHistoryId: profileEvidence.historyId,
        pageCount: 0,
        historyTypes: [...HISTORY_TYPES],
        ...safeHistoryFailure(error),
      },
      profileEvidence,
      scanPages: fallback.scanPages,
      messageMetadata: fallback.messageMetadata,
      members: fallback.members,
    });
  }
}

async function openPlan({ frontier, syncToken, gmailClient, expectedAccountEmail, rpc = callSupabaseRpc }) {
  const plan = await buildProviderPlan({ gmailClient, frontier, expectedAccountEmail });
  const receipt = await rpc("open_truth_gmail_cutover_delta_reconciliation", {
    p_plan: plan,
    p_sync_token: syncToken,
  }, {
    timeoutMs: 70_000,
    retryDelaysMs: [],
    outcomeUnknownOnTransportFailure: true,
  });
  if (!receipt?.ok || !receipt?.planId ||
      !["planned", "already_planned", "open"].includes(String(receipt?.status || ""))) {
    const error = new Error(`Cutover-delta plan authority returned an invalid receipt: ${JSON.stringify(receipt)}`);
    error.code = "TRUTH_GMAIL_CUTOVER_DELTA_PLAN_REFUSED";
    error.receipt = receipt;
    throw error;
  }
  return { plan, receipt };
}

function hasPlan(frontier) {
  return Boolean(String(frontier?.planId || "").trim());
}

function isChunkingComplete(frontier) {
  if (["ready_to_finalize", "complete", "sealed", "finalized"].includes(String(frontier?.status || ""))) return true;
  const memberCount = Number(frontier?.memberCount);
  const adoptedCount = Number(frontier?.adoptedMemberCount ?? frontier?.chunkedMemberCount);
  return Number.isSafeInteger(memberCount) && memberCount >= 0 && adoptedCount === memberCount;
}

async function executeChunks({
  frontier,
  syncToken,
  workerId,
  chunkLimit,
  maxChunks,
  maxNonterminalJobs,
  rpc = callSupabaseRpc,
}) {
  const receipts = [];
  let current = frontier;
  for (let chunkIndex = 0; chunkIndex < maxChunks && !isChunkingComplete(current); chunkIndex += 1) {
    const expectedMemberOrdinal = Number(current?.nextMemberOrdinal);
    if (!Number.isSafeInteger(expectedMemberOrdinal) || expectedMemberOrdinal < 0) {
      throw new Error("Cutover-delta frontier omitted a valid nextMemberOrdinal");
    }
    const receipt = await rpc("run_truth_gmail_cutover_delta_reconciliation_chunk", {
      p_plan_id: String(current.planId),
      p_expected_member_ordinal: expectedMemberOrdinal,
      p_limit: chunkLimit,
      p_worker_id: workerId,
      p_max_nonterminal_jobs: maxNonterminalJobs,
      p_sync_token: syncToken,
    }, {
      timeoutMs: 60_000,
      retryDelaysMs: [],
      outcomeUnknownOnTransportFailure: true,
    });
    receipts.push(receipt);
    if (["busy", "backpressure", "not_ready", "ready_to_finalize", "already_finalized"].includes(
      String(receipt?.status || ""),
    )) break;
    if (!receipt?.ok || !["chunk_committed", "already_committed", "complete"].includes(String(receipt?.status || ""))) {
      const error = new Error(`Cutover-delta chunk authority returned an invalid receipt: ${JSON.stringify(receipt)}`);
      error.code = "TRUTH_GMAIL_CUTOVER_DELTA_CHUNK_REFUSED";
      error.receipt = receipt;
      throw error;
    }
    const next = await readReconciliation(syncToken, rpc);
    assertScope(next);
    if (String(next?.planId || "") !== String(current?.planId || "")) {
      throw new Error("Cutover-delta plan identity changed during bounded execution");
    }
    if (Number(next?.nextMemberOrdinal) <= expectedMemberOrdinal && !isChunkingComplete(next)) {
      throw new Error("Cutover-delta chunk made no durable member progress");
    }
    current = next;
  }
  return { receipts, frontier: current };
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node scripts/run-truth-gmail-cutover-delta-reconciliation.js",
    "  node scripts/run-truth-gmail-cutover-delta-reconciliation.js --plan",
    "  node scripts/run-truth-gmail-cutover-delta-reconciliation.js --execute [--chunk-limit=20] [--max-chunks=25] [--max-nonterminal=250]",
    "  node scripts/run-truth-gmail-cutover-delta-reconciliation.js --finalize",
    "",
    "Default mode is read-only. --plan seals the immutable provider scan only.",
    "--execute creates the plan if absent, then adopts bounded small batches.",
    "--finalize closes only GMAIL_CUTOVER_DELTA_RECONCILIATION after downstream proof is ready.",
    "The parked 218,989-observation backfill and its historical gap remain untouched.",
    "No mode publishes or invokes a model.",
    "",
  ].join("\n"));
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  loadLocalEnv();
  requiredEnv("PQ_SUPABASE_URL");
  requiredEnv("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const syncToken = requiredEnv("PQ_SUPABASE_SYNC_TOKEN");
  const requestedModes = ["--plan", "--execute", "--finalize"].filter((flag) => argv.includes(flag));
  if (requestedModes.length > 1) throw new Error("Choose exactly one of --plan, --execute, or --finalize");
  const mode = requestedModes[0] || "read";
  const workerId = stringOption(
    argv,
    "worker-id",
    process.env.PQ_TRUTH_GMAIL_CUTOVER_DELTA_WORKER_ID || DEFAULT_WORKER_ID,
  );
  const chunkLimit = integerOption(argv, "chunk-limit", DEFAULT_CHUNK_LIMIT, { minimum: 1, maximum: 20 });
  const maxChunks = integerOption(argv, "max-chunks", DEFAULT_MAX_CHUNKS, { minimum: 1, maximum: 100 });
  const maxNonterminalJobs = integerOption(
    argv,
    "max-nonterminal",
    DEFAULT_MAX_NONTERMINAL_JOBS,
    { minimum: 1, maximum: 500 },
  );
  const rpc = dependencies.callSupabaseRpc || callSupabaseRpc;
  const createClient = dependencies.createGmailApiClient || createGmailApiClient;

  let before = await readReconciliation(syncToken, rpc);
  assertScope(before);
  let plan = null;
  let planReceipt = null;
  let chunkReceipts = [];
  let finalizeReceipt = null;

  if (mode === "--plan" || (mode === "--execute" && !hasPlan(before))) {
    const expectedAccountEmail = requiredEnv("GMAIL_USER_EMAIL");
    const gmailClient = createClient({
      env: process.env,
      connectionKey: CONNECTION_KEY,
      user: "me",
      maxRetries: 3,
      timeoutMs: 30_000,
    });
    const opened = await openPlan({
      frontier: before,
      syncToken,
      gmailClient,
      expectedAccountEmail,
      rpc,
    });
    plan = opened.plan;
    planReceipt = opened.receipt;
    before = await readReconciliation(syncToken, rpc);
    assertScope(before);
  }

  let after = before;
  if (mode === "--execute") {
    if (!hasPlan(before)) throw new Error("Cutover-delta plan was not durably available after planning");
    const executed = await executeChunks({
      frontier: before,
      syncToken,
      workerId,
      chunkLimit,
      maxChunks,
      maxNonterminalJobs,
      rpc,
    });
    chunkReceipts = executed.receipts;
    after = executed.frontier;
  } else if (mode === "--finalize") {
    if (!hasPlan(before)) throw new Error("Cutover-delta reconciliation has no immutable plan to finalize");
    finalizeReceipt = await rpc("finalize_truth_gmail_cutover_delta_reconciliation", {
      p_plan_id: String(before.planId),
      p_sync_token: syncToken,
    }, {
      timeoutMs: 70_000,
      retryDelaysMs: [],
      outcomeUnknownOnTransportFailure: true,
    });
    if (!finalizeReceipt?.ok || ![
      "finalized",
      "already_finalized",
      "busy",
      "not_ready",
      "link_retry_authorized",
    ].includes(String(finalizeReceipt?.status || ""))) {
      const error = new Error(`Cutover-delta finalizer returned an invalid receipt: ${JSON.stringify(finalizeReceipt)}`);
      error.code = "TRUTH_GMAIL_CUTOVER_DELTA_FINALIZE_REFUSED";
      error.receipt = finalizeReceipt;
      throw error;
    }
    after = await readReconciliation(syncToken, rpc);
    assertScope(after);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: mode === "read" ? "read_only" : mode.slice(2),
    workspaceKey: WORKSPACE_KEY,
    connectionKey: CONNECTION_KEY,
    persistedAnchorHistoryId: PERSISTED_ANCHOR_HISTORY_ID,
    recoveryAnchorHistoryId: RECOVERY_ANCHOR_HISTORY_ID,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    workerId,
    chunkLimit,
    maxChunks,
    maxNonterminalJobs,
    before,
    planSummary: plan ? {
      strategy: plan.strategy,
      planHash: sha256Json(plan),
      scanPageCount: plan.scanPages.length,
      metadataCount: plan.messageMetadata.length,
      memberCount: plan.members.length,
    } : null,
    planReceipt,
    chunkReceipts,
    finalizeReceipt,
    after,
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.code || "TRUTH_GMAIL_CUTOVER_DELTA_RUNNER_FAILED"),
      message: String(error?.message || error),
      receipt: error?.receipt || null,
      productionPublicationAttempted: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONNECTION_KEY,
  CRITICAL_MESSAGE_IDS,
  DEFAULT_CHUNK_LIMIT,
  DEFAULT_MAX_CHUNKS,
  DEFAULT_MAX_NONTERMINAL_JOBS,
  DEFAULT_WORKER_ID,
  EVENT_SPECS,
  FALLBACK_QUERY,
  HISTORY_TYPES,
  PARKED_BATCH_ID,
  PERSISTED_ANCHOR_HISTORY_ID,
  PLAN_AUTHORITY,
  PLAN_SCHEMA_VERSION,
  RECOVERY_ANCHOR_HISTORY_ID,
  WINDOW_END,
  WINDOW_START,
  WORKSPACE_KEY,
  assertScope,
  assertPlanMembers,
  basePlan,
  buildProviderPlan,
  canonicalize,
  compareDecimalIds,
  deriveDateScopedMembers,
  deriveHistoryMembers,
  exactHistoryExpired,
  executeChunks,
  integerOption,
  main,
  mapConcurrent,
  metadataInternalDate,
  normalizeProfileEvidence,
  openPlan,
  scanDateScopedMailbox,
  scanRetainedHistory,
  sha256Json,
};

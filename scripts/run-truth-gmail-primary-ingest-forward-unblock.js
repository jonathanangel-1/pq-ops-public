#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createGmailApiClient } = require("../lib/gmail-api-client");
const { normalizeHistoryPage } = require("../lib/gmail-incremental-sync");
const { callSupabaseRpc } = require("../lib/supabase-agent");

const ROOT = path.resolve(__dirname, "..");
const BATCH_ID = "118506f6-7c7b-4bb9-8f62-9a743513a8ca";
const CONNECTION_KEY = "primary";
const HISTORY_TYPES = Object.freeze([
  "messageAdded",
  "messageDeleted",
  "labelAdded",
  "labelRemoved",
]);
const MAX_CHECKPOINT_PAGES = 5;
const MAX_CHECKPOINT_EVENTS = 1000;
const MAX_CHECKPOINT_MESSAGES = 500;
const ACCOUNT_BINDING_AUTHORITY = "execution-env-plus-live-gmail-profile-v1";

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
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sha256Json(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function decimalHistoryId(value, field) {
  const result = String(value || "");
  if (!/^[0-9]+$/.test(result)) throw new Error(`${field} must be a decimal Gmail history ID`);
  return result;
}

function compareDecimalIds(left, right) {
  const a = String(left).replace(/^0+(?=\d)/, "");
  const b = String(right).replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

async function readCandidate(syncToken) {
  return callSupabaseRpc("read_truth_gmail_backfill_forward_unblock", {
    p_batch_id: BATCH_ID,
    p_sync_token: syncToken,
  }, {
    timeoutMs: 30_000,
    retryDelaysMs: [],
  });
}

async function buildProviderProbe({ gmailClient, candidate, expectedAccountEmail }) {
  const anchor = decimalHistoryId(
    candidate?.persistedAnchorHistoryId,
    "candidate.persistedAnchorHistoryId",
  );
  if (candidate?.requiredAccountEmailEnvironmentVariable !== "GMAIL_USER_EMAIL" ||
      candidate?.requiredAccountBindingAuthority !== ACCOUNT_BINDING_AUTHORITY) {
    throw new Error("Forward-unblock account-binding contract differs from the runner");
  }
  const configuredAccountEmail = String(expectedAccountEmail || "").trim();
  if (!configuredAccountEmail) {
    throw new Error("Configured GMAIL_USER_EMAIL is required for mailbox identity binding");
  }
  const profile = await gmailClient.getProfile();
  const profileHistoryId = decimalHistoryId(profile?.historyId, "profile.historyId");
  if (compareDecimalIds(profileHistoryId, anchor) < 0) {
    throw new Error("Gmail profile history ID regressed behind the immutable backfill anchor");
  }
  const accountEmail = String(profile?.emailAddress || "").trim();
  if (!accountEmail ||
      accountEmail.toLowerCase() !== configuredAccountEmail.toLowerCase()) {
    throw new Error("Gmail profile account does not match configured GMAIL_USER_EMAIL");
  }
  const normalizedAccountEmail = accountEmail.toLowerCase();
  const accountIdentityBody = {
    schemaVersion: "truth-gmail-env-profile-account-binding-v1",
    authority: ACCOUNT_BINDING_AUTHORITY,
    environmentVariable: "GMAIL_USER_EMAIL",
    expectedAccountEmail: configuredAccountEmail.toLowerCase(),
    profileAccountEmail: normalizedAccountEmail,
  };
  const accountIdentity = {
    ...accountIdentityBody,
    bindingHash: sha256Json(accountIdentityBody),
  };
  const profileEvidence = {
    emailAddress: accountEmail,
    historyId: profileHistoryId,
    messagesTotal: Number(profile?.messagesTotal),
    threadsTotal: Number(profile?.threadsTotal),
  };
  if (!Number.isSafeInteger(profileEvidence.messagesTotal) ||
      profileEvidence.messagesTotal < 0 ||
      !Number.isSafeInteger(profileEvidence.threadsTotal) ||
      profileEvidence.threadsTotal < 0) {
    throw new Error("Gmail profile totals are invalid");
  }

  const recent = await gmailClient.listMessages({
    maxResults: 1,
    includeSpamTrash: true,
  });
  const recentMessageId = String(recent?.messages?.[0]?.id || "");
  if (!recentMessageId) throw new Error("Gmail mailbox has no recent message checkpoint");
  const recentMessage = await gmailClient.getMessageMetadata(recentMessageId, {
    metadataHeaders: [],
  });
  const startHistoryId = decimalHistoryId(
    recentMessage?.historyId,
    "recentMessage.historyId",
  );
  if (compareDecimalIds(startHistoryId, anchor) < 0) {
    throw new Error("Recent Gmail message history ID regressed behind the immutable backfill anchor");
  }
  if (compareDecimalIds(profileHistoryId, startHistoryId) < 0) {
    throw new Error("Recent Gmail message history ID is ahead of the profile checkpoint");
  }

  const pageManifest = [];
  const eventIds = new Set();
  const messageIds = new Set();
  let pageToken = "";
  let cutoverHistoryId = startHistoryId;
  while (true) {
    if (pageManifest.length >= MAX_CHECKPOINT_PAGES) {
      throw new Error("Gmail current-checkpoint validation exceeds the bounded page budget");
    }
    const response = await gmailClient.listHistory({
      startHistoryId,
      ...(pageToken ? { pageToken } : {}),
      maxResults: 500,
      historyTypes: HISTORY_TYPES,
    });
    const normalized = normalizeHistoryPage(response, {
      workspaceKey: "primary",
      connectionKey: CONNECTION_KEY,
    });
    if (compareDecimalIds(normalized.responseMailboxHistoryId, startHistoryId) < 0) {
      throw new Error("Gmail checkpoint history response regressed behind its recent message");
    }
    for (const event of normalized.providerEvents) {
      eventIds.add(event.eventId);
      messageIds.add(event.messageId);
    }
    const nextPageToken = normalized.responseNextPageToken;
    pageManifest.push({
      pageOrdinal: pageManifest.length,
      requestPageTokenHash: sha256(pageToken),
      responseNextPageTokenHash: sha256(nextPageToken),
      providerResponseHash: sha256Json(normalized.providerResponse),
      responseHistoryId: normalized.responseMailboxHistoryId,
      eventManifest: normalized.providerEvents,
      nextPageTokenPresent: Boolean(nextPageToken),
    });
    if (eventIds.size > MAX_CHECKPOINT_EVENTS || messageIds.size > MAX_CHECKPOINT_MESSAGES) {
      throw new Error("Gmail current-checkpoint validation exceeds the bounded event budget");
    }
    cutoverHistoryId = normalized.responseMailboxHistoryId;
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  const body = {
    schemaVersion: "truth-gmail-current-profile-checkpoint-probe-v1",
    workspaceKey: "primary",
    connectionKey: CONNECTION_KEY,
    batchId: BATCH_ID,
    persistedAnchorHistoryId: anchor,
    cutoverHistoryId,
    accountIdentity,
    profileEvidence,
    profileResponseHash: sha256Json(profileEvidence),
    checkpointEvidence: {
      checkpointKind: "recent-message-to-terminal-history-list-v1",
      startMessageId: recentMessageId,
      startHistoryId,
      terminalHistoryId: cutoverHistoryId,
      historyTypes: HISTORY_TYPES,
      pageCount: pageManifest.length,
      eventCount: eventIds.size,
      distinctMessageCount: messageIds.size,
      pageManifest,
    },
    observedAt: new Date().toISOString(),
    productionPublicationAttempted: false,
  };
  return { ...body, probeHash: sha256Json(body) };
}

async function main() {
  loadLocalEnv();
  const execute = process.argv.includes("--execute");
  const syncToken = requiredEnv("PQ_SUPABASE_SYNC_TOKEN");
  requiredEnv("PQ_SUPABASE_URL");
  requiredEnv("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const candidate = await readCandidate(syncToken);
  if (candidate?.status === "already_parked") {
    process.stdout.write(`${JSON.stringify({ candidate, execute, probe: null }, null, 2)}\n`);
    return;
  }
  if (candidate?.status !== "candidate") {
    throw new Error(`Forward-unblock candidate is unavailable: ${JSON.stringify(candidate)}`);
  }
  const expectedAccountEmail = requiredEnv("GMAIL_USER_EMAIL");

  const gmailClient = createGmailApiClient({
    env: process.env,
    connectionKey: CONNECTION_KEY,
    user: "me",
    maxRetries: 3,
    timeoutMs: 30_000,
  });
  const probe = await buildProviderProbe({
    gmailClient,
    candidate,
    expectedAccountEmail,
  });

  let receipt = null;
  if (execute) {
    receipt = await callSupabaseRpc("run_truth_gmail_backfill_forward_unblock", {
      p_batch_id: BATCH_ID,
      p_provider_probe: probe,
      p_sync_token: syncToken,
    }, {
      timeoutMs: 60_000,
      retryDelaysMs: [],
      outcomeUnknownOnTransportFailure: true,
    });
    if (receipt?.status === "busy") {
      const error = new Error("Forward-unblock authority is busy with the hosted cron; retry the same command");
      error.code = "GMAIL_FORWARD_UNBLOCK_BUSY";
      error.receipt = receipt;
      throw error;
    }
    if (receipt?.status !== "parked" && receipt?.status !== "already_parked") {
      throw new Error(`Forward-unblock authority returned an invalid receipt: ${JSON.stringify(receipt)}`);
    }
  }

  process.stdout.write(`${JSON.stringify({
    mode: execute ? "execute" : "probe_only",
    candidate,
    probe,
    receipt,
    nextStep: execute
      ? "Wait for one hosted truth-shadow tick, then verify the cursor has a real committed history-batch witness."
      : "Re-run with --execute only if the current Gmail profile checkpoint is acceptable.",
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.code || "GMAIL_FORWARD_UNBLOCK_FAILED"),
      message: String(error?.message || error),
      receipt: error?.receipt || null,
      productionPublicationAttempted: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BATCH_ID,
  ACCOUNT_BINDING_AUTHORITY,
  buildProviderProbe,
  canonicalize,
  compareDecimalIds,
  sha256Json,
};

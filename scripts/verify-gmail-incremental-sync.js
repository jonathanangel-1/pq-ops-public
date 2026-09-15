#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const {
  HISTORY_TYPES,
  normalizeHistoryPage,
  runGmailIncrementalSync,
  _test: { stableJson },
} = require("../lib/gmail-incremental-sync");
const { createGmailMailboxLedger, RPC } = require("../lib/gmail-mailbox-ledger");

const checks = [];

async function check(name, fn) {
  await fn();
  checks.push(name);
}

function baseLease(overrides = {}) {
  return {
    ok: true,
    leaseFence: 7,
    cursorValue: "100",
    cursorVersion: 4,
    status: "live",
    ...overrides,
  };
}

function baseBatch(overrides = {}) {
  return {
    ok: true,
    batchId: "00000000-0000-4000-8000-000000000001",
    startCursorValue: "100",
    startCursorVersion: 4,
    pageCount: 0,
    resumePageToken: "",
    responseMailboxHistoryId: "",
    finalPagePersisted: false,
    ...overrides,
  };
}

function materializationRoutes({ materializationCount = 0, deletedCount = 0, idempotent = false } = {}) {
  const sealHash = "9".repeat(64);
  return {
    ok: true,
    idempotent,
    sealId: `gmail-materialization-route-seal:v1:${sealHash}`,
    sealHash,
    routeManifestHash: "8".repeat(64),
    routeCount: materializationCount + deletedCount,
    materializationCount,
    deletedCount,
  };
}

function createHarness(options = {}) {
  const calls = [];
  const appends = [];
  const gaps = [];
  const pages = [...(options.pages || [])];
  const lease = options.lease || baseLease();
  const batch = options.batch || baseBatch({ startCursorValue: lease.cursorValue });
  let renewCount = 0;
  let listCount = 0;
  let commitCount = 0;

  const gmailClient = {
    async listHistory(input) {
      calls.push({ op: "gmail.listHistory", input: structuredClone(input) });
      listCount += 1;
      if (typeof options.listHistory === "function") return options.listHistory(input, listCount);
      if (pages.length === 0) throw new Error("Unexpected Gmail History call");
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return structuredClone(page);
    },
    async getProfile() {
      calls.push({ op: "gmail.getProfile" });
      return structuredClone(options.profile || { historyId: "999" });
    },
    async listMessages() {
      throw new Error("Incremental History sync must never run an active-AWB/message query");
    },
  };

  const ledger = {
    scope: { workspaceKey: "primary", sourceSystem: "gmail", connectionKey: "conn-test" },
    async acquireLease(input) {
      calls.push({ op: "ledger.acquireLease", input: structuredClone(input) });
      if (options.acquireError) throw options.acquireError;
      return structuredClone(lease);
    },
    async beginBatch(input) {
      calls.push({ op: "ledger.beginBatch", input: structuredClone(input) });
      if (options.beginError) throw options.beginError;
      return structuredClone(batch);
    },
    async renewLease(input) {
      calls.push({ op: "ledger.renewLease", input: structuredClone(input) });
      renewCount += 1;
      if (options.renewErrorAt === renewCount) {
        const error = new Error("source sync lease lost");
        error.code = "40001";
        throw error;
      }
      return { ok: true, leaseFence: lease.leaseFence, leaseExpiresAt: "2030-01-01T00:00:00Z" };
    },
    async appendPage(input) {
      calls.push({ op: "ledger.appendPage", input: structuredClone(input) });
      appends.push(structuredClone(input));
      if (options.appendError) throw options.appendError;
      return {
        ok: true,
        batchId: input.batchId,
        pageOrdinal: input.page.pageOrdinal,
        eventDigest: input.page.eventDigest,
        observationCount: input.observations.length,
        jobCount: input.jobs.length,
      };
    },
    async commitBatch(input) {
      calls.push({ op: "ledger.commitBatch", input: structuredClone(input) });
      commitCount += 1;
      const last = appends[appends.length - 1];
      assert.ok(batch.finalPagePersisted || last?.page?.isFinal, "cursor commit requires a persisted final page");
      return {
        ok: true,
        batchId: input.batchId,
        batchHash: "a".repeat(64),
        committedCursorValue: last?.page?.responseMailboxHistoryId || batch.responseMailboxHistoryId,
        committedCursorVersion: batch.startCursorVersion + 1,
        pageCount: batch.pageCount + appends.length,
        observationCount: appends.reduce((sum, row) => sum + row.observations.length, 0),
        jobCount: appends.reduce((sum, row) => sum + row.jobs.length, 0),
        materializationRoutes: options.materializationRoutes || materializationRoutes(),
      };
    },
    async markHistoryExpired(input) {
      calls.push({ op: "ledger.markHistoryExpired", input: structuredClone(input) });
      gaps.push(structuredClone(input));
      return {
        ok: true,
        code: "HISTORY_EXPIRED",
        gapId: "00000000-0000-4000-8000-000000000099",
        cursorValue: input.priorCursorValue,
        cursorVersion: lease.cursorVersion,
        recoveryAnchorValue: input.recoveryAnchorValue,
        status: "reconcile_required",
      };
    },
  };

  return {
    calls,
    appends,
    gaps,
    gmailClient,
    ledger,
    get commitCount() { return commitCount; },
    get listCount() { return listCount; },
    get renewCount() { return renewCount; },
  };
}

function run(harness, options = {}) {
  return runGmailIncrementalSync({
    gmailClient: harness.gmailClient,
    ledger: harness.ledger,
    ownerId: "verifier-worker",
    ...options,
  });
}

async function main() {
  await check("two pages persist before the next Gmail call, dedupe events, and commit only final", async () => {
    const hugeCursor = "900719925474099300000";
    const hugeMessageId = "900719925474099312345";
    const duplicateAdded = {
      message: {
        id: hugeMessageId,
        threadId: "900719925474099399999",
        labelIds: ["UNREAD", "INBOX", "UNREAD"],
      },
    };
    const harness = createHarness({
      lease: baseLease({ cursorValue: hugeCursor }),
      batch: baseBatch({ startCursorValue: hugeCursor }),
      pages: [
        {
          historyId: "900719925474099300105",
          nextPageToken: "page-two",
          history: [{
            id: "900719925474099300101",
            messagesAdded: [duplicateAdded, structuredClone(duplicateAdded)],
            labelsAdded: [{
              message: duplicateAdded.message,
              labelIds: ["STARRED", "IMPORTANT", "STARRED"],
            }],
          }],
        },
        {
          historyId: "900719925474099300110",
          history: [{
            id: 42,
            messagesDeleted: [{ message: { id: 77, threadId: 88 } }],
          }],
        },
      ],
      materializationRoutes: materializationRoutes({ materializationCount: 1, deletedCount: 1 }),
    });

    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.cursorAdvanced, true);
    assert.equal(result.committedCursorValue, "900719925474099300110");
    assert.equal(result.pagesPersistedThisRun, 2);
    assert.equal(harness.commitCount, 1);
    assert.deepEqual(result.materializationRoutes,
      materializationRoutes({ materializationCount: 1, deletedCount: 1 }));
    assert.equal(harness.appends.length, 2);
    assert.equal(harness.appends[0].observations.length, 2);
    assert.equal(harness.appends[0].jobs.length, 0,
      "provider materialization routes seal once at committed-root scope, not per page event");
    assert.equal(harness.appends[1].observations.length, 1);
    assert.equal(harness.appends[1].jobs.length, 0);
    assert.equal(harness.appends[0].page.isFinal, false);
    assert.equal(harness.appends[1].page.isFinal, true);
    assert.equal(harness.appends[1].page.requestPageToken, "page-two");
    assert.equal(harness.appends[1].page.firstHistoryId, "42");

    const addObservation = harness.appends[0].observations.find(
      (row) => row.normalizedPayload.eventType === "message_added",
    );
    const labelsObservation = harness.appends[0].observations.find(
      (row) => row.normalizedPayload.eventType === "labels_added",
    );
    assert.match(addObservation.observationId, /^obs:v1:[0-9a-f]{64}$/);
    assert.equal(addObservation.sourceObjectId, hugeMessageId);
    assert.equal(typeof addObservation.sourceObjectId, "string");
    assert.deepEqual(addObservation.normalizedPayload.messageLabelIds, ["INBOX", "UNREAD"]);
    assert.deepEqual(labelsObservation.normalizedPayload.changedLabelIds, ["IMPORTANT", "STARRED"]);
    assert.equal(typeof harness.appends[1].observations[0].sourceObjectId, "string");
    assert.equal(harness.appends[1].observations[0].sourceObjectId, "77");

    const firstListIndex = harness.calls.findIndex((row) => row.op === "gmail.listHistory");
    const firstAppendIndex = harness.calls.findIndex((row) => row.op === "ledger.appendPage");
    const secondListIndex = harness.calls.findIndex(
      (row, index) => row.op === "gmail.listHistory" && index > firstListIndex,
    );
    assert.ok(firstListIndex < firstAppendIndex && firstAppendIndex < secondListIndex);
    const listInputs = harness.calls.filter((row) => row.op === "gmail.listHistory").map((row) => row.input);
    assert.equal(listInputs[0].startHistoryId, hugeCursor);
    assert.equal(typeof listInputs[0].startHistoryId, "string");
    assert.deepEqual(listInputs[0].historyTypes, HISTORY_TYPES);
    assert.equal(Object.hasOwn(listInputs[0], "q"), false);
  });

  await check("normalization is deterministic across unordered history rows, events, and labels", async () => {
    const firstEntry = {
      id: "103",
      labelsAdded: [{
        message: { id: "m-2", threadId: "t-2", labelIds: ["UNREAD", "INBOX"] },
        labelIds: ["STARRED", "IMPORTANT"],
      }],
    };
    const secondEntry = {
      id: "101",
      messagesAdded: [{ message: { id: "m-1", threadId: "t-1", labelIds: ["INBOX", "UNREAD"] } }],
    };
    const forward = normalizeHistoryPage({ historyId: "110", history: [firstEntry, secondEntry] }, {
      workspaceKey: "primary",
      connectionKey: "conn-test",
    });
    const reversed = normalizeHistoryPage({
      historyId: "110",
      history: [
        secondEntry,
        {
          ...firstEntry,
          labelsAdded: [{
            message: { id: "m-2", threadId: "t-2", labelIds: ["INBOX", "UNREAD"] },
            labelIds: ["IMPORTANT", "STARRED"],
          }],
        },
      ],
    }, { workspaceKey: "primary", connectionKey: "conn-test" });
    assert.equal(stableJson(forward), stableJson(reversed));
    assert.equal(forward.firstHistoryId, "101");
    assert.equal(forward.lastHistoryId, "103");
  });

  await check("an empty History window is durably recorded and advances to the mailbox history ID", async () => {
    const harness = createHarness({ pages: [{ historyId: "101", history: [] }] });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.committedCursorValue, "101");
    assert.equal(harness.appends.length, 1);
    assert.deepEqual(harness.appends[0].observations, []);
    assert.deepEqual(harness.appends[0].jobs, []);
    assert.equal(harness.appends[0].page.isFinal, true);
    assert.equal(harness.commitCount, 1);
  });

  await check("page budget yields a resumable partial batch without advancing the cursor", async () => {
    const harness = createHarness({
      pages: [{
        historyId: "105",
        nextPageToken: "resume-me",
        history: [{ id: "104", messagesAdded: [{ message: { id: "m-1", threadId: "t-1" } }] }],
      }],
    });
    const result = await run(harness, { maxPages: 1 });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "page_budget");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(result.resumePageToken, "resume-me");
    assert.equal(harness.appends.length, 1);
    assert.equal(harness.commitCount, 0);
    assert.equal(harness.listCount, 1);
  });

  await check("deadline yields only after the fetched page is durable and never commits a non-final page", async () => {
    const harness = createHarness({
      pages: [{ historyId: "105", nextPageToken: "resume-deadline", history: [] }],
    });
    const timestamps = [0, 0, 0, 0, 0, 0, 0, 100];
    const result = await run(harness, {
      deadlineAtMs: 50,
      now: () => timestamps.length ? timestamps.shift() : 100,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "deadline");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.appends.length, 1);
    assert.equal(harness.commitCount, 0);
    assert.equal(harness.listCount, 1);
  });

  await check("a running batch resumes from pageCount and resumePageToken", async () => {
    const harness = createHarness({
      batch: baseBatch({ pageCount: 1, resumePageToken: "page-two", responseMailboxHistoryId: "105" }),
      pages: [{ historyId: "110", history: [] }],
    });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.resumed, true);
    assert.equal(result.pageCount, 2);
    assert.equal(harness.listCount, 1);
    assert.equal(harness.appends[0].page.pageOrdinal, 1);
    assert.equal(harness.appends[0].page.requestPageToken, "page-two");
  });

  await check("a resumed batch with a persisted final page commits without another Gmail request", async () => {
    const harness = createHarness({
      batch: baseBatch({
        pageCount: 2,
        resumePageToken: "",
        responseMailboxHistoryId: "120",
        finalPagePersisted: true,
      }),
    });
    const result = await run(harness, { maxPages: 0, deadlineAtMs: 100, now: () => 0 });
    assert.equal(result.status, "committed");
    assert.equal(result.committedCursorValue, "120");
    assert.equal(result.pagesPersistedThisRun, 0);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 1);
  });

  await check("lease contention exits before beginning a batch or calling Gmail", async () => {
    const harness = createHarness({
      lease: baseLease({
        ok: false,
        code: "LEASE_BUSY",
        leaseOwner: "other-worker",
        leaseExpiresAt: "2030-01-01T00:00:00Z",
      }),
    });
    const result = await run(harness);
    assert.equal(result.status, "lease_busy");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.calls.some((row) => row.op === "ledger.beginBatch"), false);
  });

  await check("a lost lease after Gmail fetch prevents page persistence and cursor commit", async () => {
    const harness = createHarness({
      renewErrorAt: 1,
      pages: [{ historyId: "101", history: [] }],
    });
    const result = await run(harness);
    assert.equal(result.status, "lease_lost");
    assert.equal(result.stage, "renew_before_append");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.listCount, 1);
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 0);
  });

  await check("expired Gmail history records a gap using the profile recovery anchor", async () => {
    const expired = new Error("History ID is too old");
    expired.code = "GMAIL_HISTORY_CURSOR_EXPIRED";
    expired.kind = "history-gap";
    expired.status = 404;
    expired.operation = "history.list";
    const harness = createHarness({
      pages: [expired],
      profile: { historyId: "900719925474099399999" },
    });
    const result = await run(harness);
    assert.equal(result.status, "reconcile_required");
    assert.equal(result.reason, "history_expired");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(result.recoveryAnchorValue, "900719925474099399999");
    assert.equal(harness.gaps.length, 1);
    assert.equal(harness.gaps[0].priorCursorValue, "100");
    assert.equal(harness.gaps[0].recoveryAnchorValue, "900719925474099399999");
    assert.equal(typeof harness.gaps[0].recoveryAnchorValue, "string");
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 0);
  });

  await check("a missing cursor routes to backfill and never queries active shipment identifiers", async () => {
    const harness = createHarness({ lease: baseLease({ cursorValue: "", status: "backfill_required" }) });
    const result = await run(harness);
    assert.equal(result.status, "backfill_required");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.calls.some((row) => row.op === "ledger.beginBatch"), false);
  });

  await check("orchestrator payloads pass the real mailbox-ledger wrapper contract", async () => {
    const rpcCalls = [];
    const batchId = "00000000-0000-4000-8000-000000000777";
    const callRpc = async (rpc, body) => {
      rpcCalls.push({ rpc, body: structuredClone(body) });
      if (rpc === RPC.acquireLease) {
        return { ok: true, leaseFence: 12, cursorValue: "700", cursorVersion: 2, status: "live" };
      }
      if (rpc === RPC.beginBatch) {
        return {
          ok: true,
          batchId,
          startCursorValue: "700",
          startCursorVersion: 2,
          pageCount: 0,
          resumePageToken: "",
          responseMailboxHistoryId: "",
          finalPagePersisted: false,
        };
      }
      if (rpc === RPC.renewLease) {
        return { ok: true, leaseFence: 12, leaseExpiresAt: "2030-01-01T00:00:00Z" };
      }
      if (rpc === RPC.appendPage) {
        return {
          ok: true,
          batchId,
          pageOrdinal: body.p_page.pageOrdinal,
          eventDigest: body.p_page.eventDigest,
          observationCount: body.p_observations.length,
          jobCount: body.p_jobs.length,
        };
      }
      if (rpc === RPC.commitBatch) {
        return {
          ok: true,
          batchId,
          batchHash: "b".repeat(64),
          committedCursorValue: "701",
          committedCursorVersion: 3,
          pageCount: 1,
          observationCount: 1,
          jobCount: 0,
          materializationRoutes: materializationRoutes({ materializationCount: 1 }),
        };
      }
      throw new Error(`Unexpected RPC ${rpc}`);
    };
    const ledger = createGmailMailboxLedger({
      connectionKey: "wrapper-contract",
      syncToken: "verifier-sync-token",
      callRpc,
    });
    const gmailClient = {
      async listHistory() {
        return {
          historyId: "701",
          history: [{ id: "701", messagesAdded: [{ message: { id: "message-701", threadId: "thread-7" } }] }],
        };
      },
      async getProfile() {
        throw new Error("Profile is only valid on History expiration");
      },
    };
    const result = await runGmailIncrementalSync({ gmailClient, ledger, ownerId: "wrapper-worker" });
    assert.equal(result.status, "committed");
    assert.deepEqual(rpcCalls.map((row) => row.rpc), [
      RPC.acquireLease,
      RPC.beginBatch,
      RPC.renewLease,
      RPC.appendPage,
      RPC.renewLease,
      RPC.commitBatch,
    ]);
    const appendBody = rpcCalls.find((row) => row.rpc === RPC.appendPage).body;
    assert.match(appendBody.p_observations[0].observationId, /^obs:v1:[0-9a-f]{64}$/);
    assert.equal(appendBody.p_observations[0].sourceObjectId, "message-701");
    assert.deepEqual(appendBody.p_jobs, [],
      "the commit-time server route sealer is the only materialization-job publisher");
  });

  process.stdout.write(`${JSON.stringify({ ok: true, checks }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});

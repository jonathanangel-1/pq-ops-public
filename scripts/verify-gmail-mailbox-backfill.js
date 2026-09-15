#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  normalizeMessageDiscoveryPage,
  runGmailMailboxBackfill,
  _test: { stableJson },
} = require("../lib/gmail-mailbox-backfill");
const { createGmailMailboxLedger, RPC } = require("../lib/gmail-mailbox-ledger");

const checks = [];

async function check(name, fn) {
  await fn();
  checks.push(name);
}

function leaseFor(mode, overrides = {}) {
  return {
    ok: true,
    leaseFence: 9,
    cursorValue: mode === "backfill" ? "" : "100",
    cursorVersion: 3,
    recoveryAnchorValue: mode === "reconciliation" ? "150" : "",
    status: mode === "backfill" ? "backfill_required" : "reconcile_required",
    ...overrides,
  };
}

function batchFor(mode, lease, overrides = {}) {
  return {
    ok: true,
    batchId: "00000000-0000-4000-8000-000000000401",
    mode,
    status: "running",
    startCursorValue: lease.cursorValue,
    startCursorVersion: lease.cursorVersion,
    pageCount: 0,
    resumePageToken: "",
    responseMailboxHistoryId: "",
    recoveryAnchorValue: mode === "reconciliation" ? lease.recoveryAnchorValue : "",
    finalPagePersisted: false,
    ...overrides,
  };
}

function materializationRoutes({ materializationCount = 0, deletedCount = 0, idempotent = false } = {}) {
  const sealHash = "7".repeat(64);
  return {
    ok: true,
    idempotent,
    sealId: `gmail-materialization-route-seal:v1:${sealHash}`,
    sealHash,
    routeManifestHash: "6".repeat(64),
    routeCount: materializationCount + deletedCount,
    materializationCount,
    deletedCount,
  };
}

function createHarness(options = {}) {
  const mode = options.mode || "backfill";
  const lease = options.lease || leaseFor(mode);
  const batch = options.batch || batchFor(mode, lease);
  const pages = [...(options.pages || [])];
  const calls = [];
  const appends = [];
  let profileCount = 0;
  let listCount = 0;
  let renewCount = 0;
  let commitCount = 0;

  const gmailClient = {
    async getProfile() {
      calls.push({ op: "gmail.getProfile" });
      profileCount += 1;
      if (options.profileError) throw options.profileError;
      return structuredClone(options.profile || { historyId: "200" });
    },
    async listMessages(input) {
      calls.push({ op: "gmail.listMessages", input: structuredClone(input) });
      listCount += 1;
      if (typeof options.listMessages === "function") return options.listMessages(input, listCount);
      if (!pages.length) throw new Error("Unexpected Gmail messages.list call");
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return structuredClone(page);
    },
    async listHistory() {
      throw new Error("Full mailbox scan must never use History or active-shipment queries");
    },
  };

  const ledger = {
    scope: { workspaceKey: "primary", sourceSystem: "gmail", connectionKey: "mailbox-test" },
    async acquireLease(input) {
      calls.push({ op: "ledger.acquireLease", input: structuredClone(input) });
      return structuredClone(lease);
    },
    async beginBatch(input) {
      calls.push({ op: "ledger.beginBatch", input: structuredClone(input) });
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
      const last = appends.at(-1);
      assert.ok(batch.finalPagePersisted || last?.page?.isFinal, "commit requires a durable final mailbox page");
      return {
        ok: true,
        batchId: input.batchId,
        batchHash: "c".repeat(64),
        committedCursorValue: last?.page?.responseMailboxHistoryId || batch.responseMailboxHistoryId,
        committedCursorVersion: batch.startCursorVersion + 1,
        pageCount: batch.pageCount + appends.length,
        observationCount: appends.reduce((sum, row) => sum + row.observations.length, 0),
        jobCount: appends.reduce((sum, row) => sum + row.jobs.length, 0),
        materializationRoutes: options.materializationRoutes || materializationRoutes(),
      };
    },
  };
  return {
    mode,
    gmailClient,
    ledger,
    calls,
    appends,
    get profileCount() { return profileCount; },
    get listCount() { return listCount; },
    get renewCount() { return renewCount; },
    get commitCount() { return commitCount; },
  };
}

function run(harness, options = {}) {
  return runGmailMailboxBackfill({
    mode: harness.mode,
    gmailClient: harness.gmailClient,
    ledger: harness.ledger,
    ownerId: "mailbox-backfill-verifier",
    ...options,
  });
}

async function rejectsCode(promise, code) {
  let caught;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code);
  return caught;
}

async function main() {
  await check("initial backfill captures one pre-scan anchor and durably maps every message on every page", async () => {
    const anchor = "900719925474099399999";
    const hugeMessage = "19f900719925474099399999";
    const duplicate = { id: hugeMessage, threadId: "thread-z" };
    const harness = createHarness({
      profile: { historyId: anchor },
      pages: [
        {
          nextPageToken: "page-two",
          resultSizeEstimate: 3,
          messages: [
            { id: "message-b", threadId: "thread-b" },
            duplicate,
            structuredClone(duplicate),
          ],
        },
        {
          resultSizeEstimate: 3,
          messages: [{ id: 42, threadId: 84 }],
        },
      ],
      materializationRoutes: materializationRoutes({ materializationCount: 3 }),
    });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.mode, "backfill");
    assert.equal(result.anchorHistoryId, anchor);
    assert.equal(result.committedCursorValue, anchor);
    assert.equal(result.cursorAdvanced, true);
    assert.equal(harness.profileCount, 1);
    assert.equal(harness.listCount, 2);
    assert.equal(harness.appends.length, 2);
    assert.equal(harness.commitCount, 1);
    assert.deepEqual(result.materializationRoutes,
      materializationRoutes({ materializationCount: 3 }));
    assert.equal(harness.appends[0].observations.length, 2, "duplicate message refs must collapse");
    assert.equal(harness.appends[0].jobs.length, 0);
    assert.equal(harness.appends[1].observations.length, 1);
    assert.equal(harness.appends[1].jobs.length, 0);
    assert.equal(harness.appends[0].page.responseMailboxHistoryId, anchor);
    assert.equal(harness.appends[1].page.responseMailboxHistoryId, anchor);
    assert.equal(harness.appends[0].page.isFinal, false);
    assert.equal(harness.appends[1].page.isFinal, true);
    assert.equal(harness.appends[1].page.requestPageToken, "page-two");

    for (const append of harness.appends) {
      assert.equal(append.page.providerResponse.historyId, anchor);
      assert.deepEqual(append.page.providerResponse.history, []);
      assert.equal(append.page.providerEvents.length, append.observations.length);
      assert.deepEqual(append.jobs, [],
        "the committed-root route sealer, not a mailbox page, creates materialization jobs");
      append.page.providerEvents.forEach((event) => {
        assert.match(event.eventId, /^gmail-event:v1:[0-9a-f]{64}$/);
        assert.equal(event.eventType, "message_discovered");
        assert.equal(event.historyId, anchor);
      });
      append.observations.forEach((observation) => {
        assert.match(observation.observationId, /^obs:v1:[0-9a-f]{64}$/);
        assert.equal(observation.normalizedPayload.eventType, "message_discovered");
      });
    }
    const numericObservation = harness.appends[1].observations[0];
    assert.equal(numericObservation.sourceObjectId, "42");
    assert.equal(typeof numericObservation.sourceObjectId, "string");
    assert.equal(numericObservation.normalizedPayload.threadId, "84");

    const listCalls = harness.calls.filter((row) => row.op === "gmail.listMessages");
    listCalls.forEach((row) => {
      assert.equal(row.input.includeSpamTrash, true);
      assert.equal(Object.hasOwn(row.input, "q"), false);
      assert.equal(Object.hasOwn(row.input, "labelIds"), false);
    });
    const profileIndex = harness.calls.findIndex((row) => row.op === "gmail.getProfile");
    const firstListIndex = harness.calls.findIndex((row) => row.op === "gmail.listMessages");
    const firstAppendIndex = harness.calls.findIndex((row) => row.op === "ledger.appendPage");
    const secondListIndex = harness.calls.findIndex(
      (row, index) => row.op === "gmail.listMessages" && index > firstListIndex,
    );
    assert.ok(profileIndex < firstListIndex);
    assert.ok(firstListIndex < firstAppendIndex && firstAppendIndex < secondListIndex);
  });

  await check("unordered message references canonicalize to identical events, observations, jobs, and provider pages", async () => {
    const context = {
      mode: "backfill",
      anchorHistoryId: "700",
      scope: { workspaceKey: "primary", connectionKey: "mailbox-test" },
    };
    const forward = normalizeMessageDiscoveryPage({
      nextPageToken: "next",
      resultSizeEstimate: 2,
      messages: [{ id: "b", threadId: "tb" }, { id: "a", threadId: "ta" }],
    }, context);
    const reverse = normalizeMessageDiscoveryPage({
      resultSizeEstimate: 2,
      messages: [{ id: "a", threadId: "ta" }, { id: "b", threadId: "tb" }],
      nextPageToken: "next",
    }, context);
    assert.equal(stableJson(forward), stableJson(reverse));
    assert.deepEqual(forward.providerResponse.messages.map((row) => row.id), ["a", "b"]);
  });

  await check("empty mailbox persists one final provider page and commits the pre-scan anchor", async () => {
    const harness = createHarness({ profile: { historyId: "301" }, pages: [{ messages: [] }] });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.committedCursorValue, "301");
    assert.equal(harness.appends.length, 1);
    assert.equal(harness.appends[0].page.isFinal, true);
    assert.deepEqual(harness.appends[0].page.providerResponse.messages, []);
    assert.deepEqual(harness.appends[0].page.providerEvents, []);
    assert.deepEqual(harness.appends[0].observations, []);
    assert.deepEqual(harness.appends[0].jobs, []);
    assert.equal(harness.commitCount, 1);
  });

  await check("page budget yields after a durable non-final page without committing the anchor", async () => {
    const harness = createHarness({
      profile: { historyId: "400" },
      pages: [{ nextPageToken: "resume-page", messages: [{ id: "m1", threadId: "t1" }] }],
    });
    const result = await run(harness, { maxPages: 1 });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "page_budget");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(result.anchorHistoryId, "400");
    assert.equal(result.resumePageToken, "resume-page");
    assert.equal(harness.appends.length, 1);
    assert.equal(harness.commitCount, 0);
    assert.equal(harness.listCount, 1);
  });

  await check("zero page budget never captures an anchor that cannot be persisted", async () => {
    const harness = createHarness();
    const result = await run(harness, { maxPages: 0 });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "page_budget");
    assert.equal(result.anchorHistoryId, "");
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 0);
  });

  await check("deadline yields after the fetched page is durable and leaves the cursor unchanged", async () => {
    const harness = createHarness({
      profile: { historyId: "500" },
      pages: [{ nextPageToken: "resume-deadline", messages: [] }],
    });
    const timestamps = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
    const result = await run(harness, {
      deadlineAtMs: 50,
      now: () => timestamps.length ? timestamps.shift() : 100,
    });
    assert.equal(result.status, "partial");
    assert.equal(result.reason, "deadline");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.appends.length, 1);
    assert.equal(harness.commitCount, 0);
  });

  await check("backfill resume uses the persisted page token and anchor without calling profile again", async () => {
    const lease = leaseFor("backfill");
    const harness = createHarness({
      lease,
      batch: batchFor("backfill", lease, {
        pageCount: 1,
        resumePageToken: "page-two",
        responseMailboxHistoryId: "600",
      }),
      pages: [{ messages: [] }],
      profileError: new Error("profile must not be called during resume"),
    });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.resumed, true);
    assert.equal(result.anchorHistoryId, "600");
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 1);
    assert.equal(harness.appends[0].page.pageOrdinal, 1);
    assert.equal(harness.appends[0].page.requestPageToken, "page-two");
  });

  await check("persisted final page commits directly without profile or messages.list refetch", async () => {
    const lease = leaseFor("backfill");
    const harness = createHarness({
      lease,
      batch: batchFor("backfill", lease, {
        pageCount: 2,
        responseMailboxHistoryId: "650",
        finalPagePersisted: true,
      }),
    });
    const result = await run(harness, { maxPages: 0, deadlineAtMs: 100, now: () => 0 });
    assert.equal(result.status, "committed");
    assert.equal(result.committedCursorValue, "650");
    assert.equal(result.pagesPersistedThisRun, 0);
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.commitCount, 1);
  });

  await check("reconciliation uses only the immutable open-gap recovery anchor and never calls profile", async () => {
    const mode = "reconciliation";
    const lease = leaseFor(mode, {
      cursorValue: "700",
      recoveryAnchorValue: "900719925474099399999",
    });
    const harness = createHarness({
      mode,
      lease,
      batch: batchFor(mode, lease),
      pages: [{ messages: [{ id: "reconcile-message", threadId: "reconcile-thread" }] }],
      profileError: new Error("reconciliation must never create a new profile anchor"),
    });
    const result = await run(harness);
    assert.equal(result.status, "committed");
    assert.equal(result.mode, mode);
    assert.equal(result.anchorHistoryId, lease.recoveryAnchorValue);
    assert.equal(result.committedCursorValue, lease.recoveryAnchorValue);
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 1);
    assert.equal(harness.appends[0].page.responseMailboxHistoryId, lease.recoveryAnchorValue);
    assert.equal(harness.appends[0].page.providerEvents[0].discoveryMode, mode);
    assert.equal(harness.calls.find((row) => row.op === "ledger.beginBatch").input.mode, mode);
  });

  await check("disagreement between open-gap lease and batch recovery anchors fails before Gmail scan", async () => {
    const mode = "reconciliation";
    const lease = leaseFor(mode, { recoveryAnchorValue: "900" });
    const harness = createHarness({
      mode,
      lease,
      batch: batchFor(mode, lease, { recoveryAnchorValue: "901" }),
    });
    await rejectsCode(run(harness), "GMAIL_MAILBOX_RECONCILIATION_ANCHOR_MISMATCH");
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 0);
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 0);
  });

  await check("lease contention exits before batch creation and Gmail reads", async () => {
    const harness = createHarness({
      lease: leaseFor("backfill", {
        ok: false,
        code: "LEASE_BUSY",
        leaseOwner: "other-worker",
        leaseExpiresAt: "2030-01-01T00:00:00Z",
      }),
    });
    const result = await run(harness);
    assert.equal(result.status, "lease_busy");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.calls.some((row) => row.op === "ledger.beginBatch"), false);
    assert.equal(harness.profileCount, 0);
    assert.equal(harness.listCount, 0);
  });

  await check("lost lease after provider read prevents page append and cursor commit", async () => {
    const harness = createHarness({
      renewErrorAt: 2,
      profile: { historyId: "999" },
      pages: [{ messages: [] }],
    });
    const result = await run(harness);
    assert.equal(result.status, "lease_lost");
    assert.equal(result.stage, "renew_before_append");
    assert.equal(result.cursorAdvanced, false);
    assert.equal(harness.profileCount, 1);
    assert.equal(harness.listCount, 1);
    assert.equal(harness.appends.length, 0);
    assert.equal(harness.commitCount, 0);
  });

  await check("provider page shape passes the real mailbox-ledger wrapper contract", async () => {
    const rpcCalls = [];
    const batchId = "00000000-0000-4000-8000-000000000499";
    const callRpc = async (rpc, body) => {
      rpcCalls.push({ rpc, body: structuredClone(body) });
      if (rpc === RPC.acquireLease) {
        return {
          ok: true,
          leaseFence: 22,
          cursorValue: "",
          cursorVersion: 0,
          recoveryAnchorValue: "",
          status: "backfill_required",
        };
      }
      if (rpc === RPC.beginBatch) {
        return {
          ok: true,
          batchId,
          startCursorValue: "",
          startCursorVersion: 0,
          pageCount: 0,
          resumePageToken: "",
          responseMailboxHistoryId: "",
          recoveryAnchorValue: "",
          finalPagePersisted: false,
        };
      }
      if (rpc === RPC.renewLease) {
        return { ok: true, leaseFence: 22, leaseExpiresAt: "2030-01-01T00:00:00Z" };
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
          batchHash: "d".repeat(64),
          committedCursorValue: "1001",
          committedCursorVersion: 1,
          pageCount: 1,
          observationCount: 1,
          jobCount: 0,
          materializationRoutes: materializationRoutes({ materializationCount: 1 }),
        };
      }
      throw new Error(`Unexpected RPC ${rpc}`);
    };
    const ledger = createGmailMailboxLedger({
      connectionKey: "wrapper-backfill",
      syncToken: "verifier-sync-token",
      callRpc,
    });
    const gmailClient = {
      async getProfile() { return { historyId: "1001" }; },
      async listMessages() { return { messages: [{ id: "message-1001", threadId: "thread-1001" }] }; },
    };
    const result = await runGmailMailboxBackfill({
      mode: "backfill",
      gmailClient,
      ledger,
      ownerId: "wrapper-backfill-worker",
    });
    assert.equal(result.status, "committed");
    const append = rpcCalls.find((row) => row.rpc === RPC.appendPage).body;
    assert.equal(append.p_page.providerResponse.historyId, "1001");
    assert.equal(append.p_page.providerResponse.messages[0].id, "message-1001");
    assert.equal(append.p_page.providerEvents[0].eventType, "message_discovered");
    assert.equal(append.p_observations[0].normalizedPayload.eventId, append.p_page.providerEvents[0].eventId);
    assert.deepEqual(append.p_jobs, []);
    assert.deepEqual(rpcCalls.map((row) => row.rpc), [
      RPC.acquireLease,
      RPC.beginBatch,
      RPC.renewLease,
      RPC.renewLease,
      RPC.appendPage,
      RPC.renewLease,
      RPC.commitBatch,
    ]);
  });

  process.stdout.write(`${JSON.stringify({ ok: true, checks, liveCalls: 0 }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});

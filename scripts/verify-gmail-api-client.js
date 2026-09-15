#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  GMAIL_ERROR_KINDS,
  GmailApiError,
  createGmailApiClient,
  parseRetryAfterMs,
} = require("../lib/gmail-api-client");

function fakeResponse(status, payload = {}, headers = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders.get(String(name).toLowerCase()) || null;
      },
    },
    async text() {
      return payload === null ? "" : JSON.stringify(payload);
    },
  };
}

function googleError(status, reason, message = "request failed", headers = {}) {
  return fakeResponse(status, {
    error: {
      code: status,
      message,
      errors: [{ reason }],
    },
  }, headers);
}

async function rejectsGmail(promise, check) {
  try {
    await promise;
  } catch (error) {
    assert(error instanceof GmailApiError, `Expected GmailApiError, received ${error?.constructor?.name || typeof error}`);
    check(error);
    return error;
  }
  assert.fail("Expected GmailApiError rejection");
}

async function verifyResourceMethodsAndStringIds() {
  const seen = [];
  const client = createGmailApiClient({
    initialAccessToken: "access-one",
    maxRetries: 0,
    fetchImpl: async (requestUrl, init) => {
      const url = new URL(String(requestUrl));
      seen.push({ url, init });
      assert.equal(init.headers.authorization, "Bearer access-one");
      if (url.pathname.endsWith("/profile")) {
        return fakeResponse(200, {
          emailAddress: "operator@example.test",
          messagesTotal: 10,
          threadsTotal: 5,
          historyId: 12345,
        });
      }
      if (url.pathname.endsWith("/history")) {
        assert.equal(url.searchParams.get("startHistoryId"), "99999999999999999999");
        assert.deepEqual(url.searchParams.getAll("historyTypes"), ["messageAdded", "labelAdded"]);
        return fakeResponse(200, {
          historyId: "100000000000000000001",
          nextPageToken: "page-two",
          history: [{
            id: 456,
            messages: [{ id: 7, threadId: 8 }],
            messagesAdded: [{ message: { id: 9, threadId: 10 } }],
            messagesDeleted: [{ message: { id: 11, threadId: 12 } }],
            labelsAdded: [{ message: { id: 13, threadId: 14 }, labelIds: ["INBOX"] }],
            labelsRemoved: [{ message: { id: 15, threadId: 16 }, labelIds: ["UNREAD"] }],
          }],
        });
      }
      if (url.pathname.endsWith("/messages") && !url.searchParams.has("format")) {
        assert.deepEqual(url.searchParams.getAll("labelIds"), ["INBOX", "IMPORTANT"]);
        assert.equal(url.searchParams.get("includeSpamTrash"), "false");
        return fakeResponse(200, { messages: [{ id: 21, threadId: 22 }], nextPageToken: "next" });
      }
      if (url.pathname.endsWith("/messages/raw-id") && url.searchParams.get("format") === "raw") {
        return fakeResponse(200, {
          id: 31,
          threadId: 32,
          historyId: 33,
          internalDate: 34,
          raw: "UkZDODIy",
        });
      }
      if (url.pathname.endsWith("/messages/meta-id") && url.searchParams.get("format") === "metadata") {
        assert.deepEqual(url.searchParams.getAll("metadataHeaders"), ["Message-ID", "References"]);
        return fakeResponse(200, {
          id: 41,
          threadId: 42,
          historyId: 43,
          internalDate: 44,
          payload: {
            headers: [],
            body: { attachmentId: 45 },
            parts: [{ body: { attachmentId: 46 } }],
          },
        });
      }
      if (url.pathname.endsWith("/messages/msg-id/attachments/attachment-id")) {
        return fakeResponse(200, { attachmentId: 51, size: 3, data: "YWJj" });
      }
      throw new Error(`Unexpected fake request: ${url}`);
    },
  });

  const profile = await client.getProfile();
  assert.equal(profile.historyId, "12345");

  const history = await client.listHistory({
    startHistoryId: "99999999999999999999",
    historyTypes: ["messageAdded", "labelAdded"],
  });
  assert.equal(history.historyId, "100000000000000000001");
  assert.equal(history.history[0].id, "456");
  assert.equal(history.history[0].messages[0].id, "7");
  assert.equal(history.history[0].messagesAdded[0].message.threadId, "10");
  assert.equal(history.history[0].messagesDeleted[0].message.id, "11");
  assert.equal(history.history[0].labelsAdded[0].message.threadId, "14");
  assert.equal(history.history[0].labelsRemoved[0].message.id, "15");

  const listed = await client.listMessages({ labelIds: ["INBOX", "IMPORTANT"], includeSpamTrash: false });
  assert.equal(listed.messages[0].id, "21");
  assert.equal(listed.messages[0].threadId, "22");

  const raw = await client.getMessageRaw("raw-id");
  assert.deepEqual(
    [raw.id, raw.threadId, raw.historyId, raw.internalDate],
    ["31", "32", "33", "34"],
  );

  const metadata = await client.getMessageMetadata("meta-id", { metadataHeaders: ["Message-ID", "References"] });
  assert.deepEqual(
    [metadata.id, metadata.threadId, metadata.historyId, metadata.internalDate],
    ["41", "42", "43", "44"],
  );
  assert.equal(metadata.payload.body.attachmentId, "45");
  assert.equal(metadata.payload.parts[0].body.attachmentId, "46");

  const attachment = await client.getAttachment("msg-id", "attachment-id");
  assert.equal(attachment.data, "YWJj");
  assert.equal(attachment.attachmentId, "51");
  assert.equal(seen.length, 6);
}

async function verify401RefreshExactlyOnce() {
  let refreshCalls = 0;
  let apiCalls = 0;
  const client = createGmailApiClient({
    initialAccessToken: "stale-token",
    maxRetries: 0,
    refreshAccessToken: async ({ reason }) => {
      refreshCalls += 1;
      assert.equal(reason, "unauthorized");
      return { accessToken: "fresh-token" };
    },
    fetchImpl: async (_url, init) => {
      apiCalls += 1;
      return init.headers.authorization === "Bearer stale-token"
        ? googleError(401, "authError", "expired stale-token")
        : fakeResponse(200, { historyId: "7" });
    },
  });
  assert.equal((await client.getProfile()).historyId, "7");
  assert.equal(refreshCalls, 1);
  assert.equal(apiCalls, 2);

  refreshCalls = 0;
  apiCalls = 0;
  const rejected = createGmailApiClient({
    initialAccessToken: "old-token",
    maxRetries: 5,
    refreshAccessToken: async () => {
      refreshCalls += 1;
      return "still-rejected";
    },
    fetchImpl: async () => {
      apiCalls += 1;
      return googleError(401, "authError", "Bearer old-token is invalid");
    },
  });
  await rejectsGmail(rejected.getProfile(), (error) => {
    assert.equal(error.code, "GMAIL_UNAUTHORIZED");
    assert.equal(error.kind, GMAIL_ERROR_KINDS.AUTH);
    assert.equal(error.retryable, false);
    assert.equal(error.authRefreshUsed, true);
    assert.equal(error.attempts, 2);
    assert(!JSON.stringify(error).includes("old-token"));
  });
  assert.equal(refreshCalls, 1, "A request must never refresh twice after repeated 401 responses");
  assert.equal(apiCalls, 2, "401 is not part of the generic retry loop");
}

async function verifyRetryAfterAndFullJitter() {
  const sleeps = [];
  let calls = 0;
  const client = createGmailApiClient({
    initialAccessToken: "token",
    maxRetries: 1,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    random: () => 0.5,
    sleep: async (delay) => sleeps.push(delay),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? googleError(429, "rateLimitExceeded", "slow down", { "Retry-After": "2" })
        : fakeResponse(200, { historyId: "9" });
    },
  });
  assert.equal((await client.getProfile()).historyId, "9");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2_050], "Retry-After must be honored in addition to full-jitter backoff");

  const now = Date.parse("2026-07-09T12:00:00Z");
  assert.equal(parseRetryAfterMs("3", now), 3_000);
  assert.equal(parseRetryAfterMs("Thu, 09 Jul 2026 12:00:04 GMT", now), 4_000);
}

async function verify403TaxonomyAndRedaction() {
  const retrySleeps = [];
  let retryableCalls = 0;
  const retryable = createGmailApiClient({
    initialAccessToken: "quota-token",
    maxRetries: 1,
    baseBackoffMs: 100,
    random: () => 0.5,
    sleep: async (delay) => retrySleeps.push(delay),
    fetchImpl: async () => {
      retryableCalls += 1;
      return retryableCalls === 1
        ? googleError(403, "userRateLimitExceeded", "temporary quota")
        : fakeResponse(200, { historyId: "10" });
    },
  });
  await retryable.getProfile();
  assert.equal(retryableCalls, 2);
  assert.deepEqual(retrySleeps, [50]);

  let permanentCalls = 0;
  const permanent = createGmailApiClient({
    initialAccessToken: "permission-token",
    maxRetries: 5,
    fetchImpl: async () => {
      permanentCalls += 1;
      return googleError(
        403,
        "domainPolicy",
        "domain blocked access_token=secret-value Bearer permission-token",
      );
    },
  });
  await rejectsGmail(permanent.getProfile(), (error) => {
    assert.equal(error.code, "GMAIL_FORBIDDEN");
    assert.equal(error.kind, GMAIL_ERROR_KINDS.FORBIDDEN);
    assert.equal(error.reason, "domainPolicy");
    assert.equal(error.retryable, false);
    const serialized = JSON.stringify(error);
    assert(!serialized.includes("secret-value"));
    assert(!serialized.includes("permission-token"));
  });
  assert.equal(permanentCalls, 1, "Policy denials must not be retried");

  const dailyLimit = createGmailApiClient({
    initialAccessToken: "token",
    maxRetries: 5,
    fetchImpl: async () => googleError(403, "dailyLimitExceeded", "daily allocation exhausted"),
  });
  await rejectsGmail(dailyLimit.getProfile(), (error) => {
    assert.equal(error.retryable, false);
    assert.equal(error.reason, "dailyLimitExceeded");
  });
}

async function verify5xxBoundedRetries() {
  const sleeps = [];
  const randomValues = [0.25, 0.75];
  let calls = 0;
  const client = createGmailApiClient({
    initialAccessToken: "token",
    maxRetries: 2,
    baseBackoffMs: 100,
    random: () => randomValues.shift(),
    sleep: async (delay) => sleeps.push(delay),
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? googleError(503, "backendError", "temporary backend failure")
        : fakeResponse(200, { historyId: "11" });
    },
  });
  await client.getProfile();
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 150]);

  let defaultCalls = 0;
  const defaultBound = createGmailApiClient({
    initialAccessToken: "token",
    baseBackoffMs: 0,
    maxBackoffMs: 0,
    fetchImpl: async () => {
      defaultCalls += 1;
      return googleError(500, "backendError", "still down");
    },
  });
  await rejectsGmail(defaultBound.getProfile(), (error) => {
    assert.equal(error.code, "GMAIL_SERVER_ERROR");
    assert.equal(error.retries, DEFAULT_MAX_RETRIES);
    assert.equal(error.attempts, DEFAULT_MAX_RETRIES + 1);
  });
  assert.equal(defaultCalls, DEFAULT_MAX_RETRIES + 1, "Default five retries must remain bounded");
}

async function verifyTimeoutClassification() {
  const sleeps = [];
  let calls = 0;
  const client = createGmailApiClient({
    initialAccessToken: "token",
    maxRetries: 1,
    baseBackoffMs: 10,
    random: () => 0.5,
    sleep: async (delay) => sleeps.push(delay),
    setTimeoutImpl: (callback) => {
      callback();
      return 1;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init.signal.aborted, true);
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await rejectsGmail(client.getProfile(), (error) => {
    assert.equal(error.code, "GMAIL_TIMEOUT");
    assert.equal(error.kind, GMAIL_ERROR_KINDS.TIMEOUT);
    assert.equal(error.retryable, true);
    assert.equal(error.details.timeoutMs, DEFAULT_TIMEOUT_MS);
    assert.equal(error.attempts, 2);
    assert.equal(error.retries, 1);
  });
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
}

async function verifyHistoryCursorGapClassification() {
  const client = createGmailApiClient({
    initialAccessToken: "token",
    maxRetries: 5,
    fetchImpl: async () => googleError(404, "notFound", "Requested entity was not found"),
  });
  await rejectsGmail(client.listHistory({ startHistoryId: "123" }), (error) => {
    assert.equal(error.code, "GMAIL_HISTORY_CURSOR_EXPIRED");
    assert.equal(error.kind, GMAIL_ERROR_KINDS.HISTORY_GAP);
    assert.equal(error.retryable, false);
    assert.equal(error.attempts, 1);
  });
}

async function verifyStoredOAuthContract() {
  const recordCalls = [];
  let loaderCalls = 0;
  let tokenCalls = 0;
  let profileCalls = 0;
  const client = createGmailApiClient({
    env: {
      GMAIL_CLIENT_ID: "client-id",
      GMAIL_CLIENT_SECRET: "client-secret",
      GMAIL_OAUTH_CONNECTION_KEY: "primary",
    },
    maxRetries: 0,
    loadStoredGmailRefreshToken: async ({ connectionKey }) => {
      loaderCalls += 1;
      assert.equal(connectionKey, "primary");
      return { refreshToken: "stored-refresh-token", accountEmail: "operator@example.test" };
    },
    recordGmailOAuthRefreshResult: async (input) => recordCalls.push(input),
    fetchImpl: async (requestUrl, init) => {
      const url = new URL(String(requestUrl));
      if (url.hostname === "oauth2.googleapis.com") {
        tokenCalls += 1;
        const body = new URLSearchParams(String(init.body));
        assert.equal(body.get("refresh_token"), "stored-refresh-token");
        assert.equal(body.get("client_secret"), "client-secret");
        return fakeResponse(200, { access_token: "stored-access-token", expires_in: 3600 });
      }
      profileCalls += 1;
      assert.equal(init.headers.authorization, "Bearer stored-access-token");
      return fakeResponse(200, { historyId: "900" });
    },
  });
  assert.equal((await client.getProfile()).historyId, "900");
  assert.equal(loaderCalls, 1);
  assert.equal(tokenCalls, 1);
  assert.equal(profileCalls, 1);
  assert.equal(recordCalls.length, 1);
  assert.equal(recordCalls[0].ok, true);
  assert.equal(recordCalls[0].connectionKey, "primary");
}

async function main() {
  await verifyResourceMethodsAndStringIds();
  await verify401RefreshExactlyOnce();
  await verifyRetryAfterAndFullJitter();
  await verify403TaxonomyAndRedaction();
  await verify5xxBoundedRetries();
  await verifyTimeoutClassification();
  await verifyHistoryCursorGapClassification();
  await verifyStoredOAuthContract();
  console.log(JSON.stringify({
    ok: true,
    verifier: "gmail-api-client",
    checks: [
      "profile/history/messages/raw/metadata/attachment resources",
      "Gmail identifiers remain strings",
      "401 refreshes exactly once",
      "Retry-After plus deterministic full jitter",
      "retryable and permanent 403 reasons",
      "bounded 5xx retries",
      "20 second timeout classification",
      "expired history cursor classification",
      "stored OAuth token contract",
      "redacted structured errors",
    ],
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

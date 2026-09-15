#!/usr/bin/env node
"use strict";

const {
  DEFAULT_BASE_URL,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  loadLocalTmsExpectations,
  waitForRelationalMorningPublication,
} = require("../lib/morning-relational-publication");

async function main() {
  const expected = await loadLocalTmsExpectations();
  const result = await waitForRelationalMorningPublication({
    expected,
    baseUrl: process.env.PQ_PRODUCTION_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(process.env.PQ_MORNING_RELATIONAL_WAIT_MS || DEFAULT_WAIT_TIMEOUT_MS),
    pollIntervalMs: Number(process.env.PQ_MORNING_RELATIONAL_POLL_MS || DEFAULT_POLL_INTERVAL_MS),
    httpTimeoutMs: Number(process.env.PQ_MORNING_RELATIONAL_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS),
    onAttempt: ({ attempt, assessment, error }) => {
      console.log(JSON.stringify({
        event: "morning-relational-publication-poll",
        attempt,
        ready: assessment?.ok === true,
        reasons: assessment?.reasons || [],
        truthSnapshotTime: assessment?.summary?.truthSnapshotTime || "",
        packetEmbeddedTmsSnapshotTime:
          assessment?.summary?.packetEmbeddedTmsSnapshotTime || "",
        error: error || "",
        mutatesState: false,
      }));
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify(error?.receipt || {
      ok: false,
      status: "failed",
      code: error?.code || "MORNING_RELATIONAL_PUBLICATION_FAILED",
      error: error instanceof Error ? error.message : String(error),
      mutatesState: false,
    }, null, 2));
    process.exit(1);
  });
}

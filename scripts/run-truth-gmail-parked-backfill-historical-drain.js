#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { callSupabaseRpc } = require("../lib/supabase-agent");

const ROOT = path.resolve(__dirname, "..");
const BATCH_ID = "118506f6-7c7b-4bb9-8f62-9a743513a8ca";
const DEFAULT_WORKER_ID = "truth-gmail-historical-drain:operator";
const DEFAULT_MAX_NONTERMINAL_JOBS = 250;

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

function integerOption(argv, name, fallback, { minimum, maximum }) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  const value = argument ? Number(argument.slice(prefix.length)) : fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function stringOption(argv, name, fallback) {
  const prefix = `--${name}=`;
  const argument = argv.find((value) => value.startsWith(prefix));
  const value = String(argument ? argument.slice(prefix.length) : fallback || "").trim();
  if (!value) throw new Error(`--${name} must not be empty`);
  return value;
}

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  node scripts/run-truth-gmail-parked-backfill-historical-drain.js",
    "  node scripts/run-truth-gmail-parked-backfill-historical-drain.js --execute [--expected-page=N] [--max-nonterminal=250]",
    "  node scripts/run-truth-gmail-parked-backfill-historical-drain.js --finalize",
    "",
    "The default is read-only. --execute adopts at most one immutable provider page.",
    "--finalize closes only the parked-history gap after every page and descendant is terminal.",
    "No mode publishes or calls the live board.",
    "",
  ].join("\n"));
}

async function readProgress(syncToken) {
  return callSupabaseRpc("read_truth_gmail_parked_backfill_historical_drain", {
    p_batch_id: BATCH_ID,
    p_sync_token: syncToken,
  }, {
    timeoutMs: 30_000,
    retryDelaysMs: [],
  });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  loadLocalEnv();
  requiredEnv("PQ_SUPABASE_URL");
  requiredEnv("PQ_SUPABASE_SERVICE_ROLE_KEY");
  const syncToken = requiredEnv("PQ_SUPABASE_SYNC_TOKEN");
  const execute = argv.includes("--execute");
  const finalize = argv.includes("--finalize");
  if (execute && finalize) throw new Error("Choose either --execute or --finalize");
  const workerId = stringOption(
    argv,
    "worker-id",
    process.env.PQ_TRUTH_GMAIL_HISTORICAL_DRAIN_WORKER_ID || DEFAULT_WORKER_ID,
  );
  const maxNonterminalJobs = integerOption(
    argv,
    "max-nonterminal",
    DEFAULT_MAX_NONTERMINAL_JOBS,
    { minimum: 1, maximum: 500 },
  );

  const before = await readProgress(syncToken);
  let receipt = null;
  if (execute) {
    if (before?.status === "complete") {
      receipt = before;
    } else {
      const expectedPageOrdinal = integerOption(
        argv,
        "expected-page",
        Number(before?.nextPageOrdinal),
        { minimum: 0, maximum: 2189 },
      );
      receipt = await callSupabaseRpc(
        "run_truth_gmail_parked_backfill_historical_drain_chunk",
        {
          p_batch_id: BATCH_ID,
          p_expected_page_ordinal: expectedPageOrdinal,
          p_worker_id: workerId,
          p_max_nonterminal_jobs: maxNonterminalJobs,
          p_sync_token: syncToken,
        },
        {
          timeoutMs: 45_000,
          retryDelaysMs: [],
          outcomeUnknownOnTransportFailure: true,
        },
      );
    }
  } else if (finalize) {
    receipt = await callSupabaseRpc(
      "finalize_truth_gmail_parked_backfill_historical_drain",
      {
        p_batch_id: BATCH_ID,
        p_worker_id: workerId,
        p_sync_token: syncToken,
      },
      {
        timeoutMs: 70_000,
        retryDelaysMs: [],
        outcomeUnknownOnTransportFailure: true,
      },
    );
  }
  const after = execute || finalize ? await readProgress(syncToken) : before;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: finalize ? "finalize" : execute ? "execute_one_page" : "read_only",
    batchId: BATCH_ID,
    workerId,
    maxNonterminalJobs,
    before,
    receipt,
    after,
    productionPublicationAttempted: false,
  }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.code || "TRUTH_GMAIL_HISTORICAL_DRAIN_FAILED"),
      message: String(error?.message || error),
      receipt: error?.receipt || null,
      productionPublicationAttempted: false,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BATCH_ID,
  DEFAULT_MAX_NONTERMINAL_JOBS,
  DEFAULT_WORKER_ID,
  integerOption,
  main,
};

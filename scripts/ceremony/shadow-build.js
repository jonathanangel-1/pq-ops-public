"use strict";
// Shadow-channel relational build for a sealed cut (no publication).
// Usage: node scripts/ceremony/shadow-build.js <cut:v1:hash> [key-suffix]
// Failed build pairs are terminal-idempotent, so a retry after a code fix
// needs a fresh key-suffix (e.g. r2).
const path = require("path");
const { REPO, WORKSPACE, createHybridRpc } = require("./config");
const { createTruthBuildLedger } = require(path.join(REPO, "lib/truth-build-ledger"));
const { runRelationalTruthBuild } = require(path.join(REPO, "lib/relational-truth-build-runner"));
const { DEFAULT_PROCESSING_CONFIG } = require(path.join(REPO, "lib/truth-processing-watermark"));

(async () => {
  const cut = process.argv[2];
  const suffix = process.argv[3] ? `:${process.argv[3]}` : "";
  if (!/^cut:v1:[0-9a-f]{64}$/.test(cut || "")) {
    throw new Error("usage: shadow-build.js <cut:v1:hash> [key-suffix]");
  }
  const hybrid = createHybridRpc();
  const ledger = createTruthBuildLedger({
    workspaceKey: WORKSPACE,
    syncToken: process.env.PQ_SUPABASE_SYNC_TOKEN,
    callRpc: hybrid,
  });
  const receipt = await runRelationalTruthBuild({
    ledger,
    workerId: "ceremony:shadow-build",
    sourceCutId: cut,
    buildChannel: "shadow",
    triggerName: "ceremony:shadow-build",
    idempotencyKey: `ceremony:shadow-build${suffix}:${cut}`,
    model: "gpt-5.2",
    modelProvider: "openai-responses",
    promptVersion: "n/a",
    processingConfig: DEFAULT_PROCESSING_CONFIG,
    leaseSeconds: 900,
    bundleRowLimit: 100000,
    deadlineAtMs: Date.now() + 35 * 60 * 1000,
  });
  console.log("BUILD:", JSON.stringify({
    status: receipt?.status,
    pair: receipt?.pair && {
      buildPairId: receipt.pair.buildPairId,
      status: receipt.pair.status,
      packetHash: receipt.pair.packetHash,
    },
  }).slice(0, 500));
  await hybrid.end();
  if (receipt?.status !== "succeeded") process.exitCode = 2;
})().catch((e) => { console.error("BUILD ERR:", String(e && (e.code ? `${e.code} ` : "") + e.message).slice(0, 400)); process.exit(1); });

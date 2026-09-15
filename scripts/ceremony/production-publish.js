"use strict";
// Candidate-channel build + one-time production approval + CAS publication
// for a cut that is STILL the live source vector (run in-freeze only —
// commit_truth_publication_runtime refuses stale vectors with 40001).
// Mirrors hosted-truth-shadow-runtime's env-gated flow, same request keys,
// so hosted recovery recognizes the head.
// Usage: node scripts/ceremony/production-publish.js <cut:v1:hash> [key-suffix]
const path = require("path");
const crypto = require("crypto");
const { REPO, WORKSPACE, createHybridRpc, directClient, issuerToken } = require("./config");
const { createTruthBuildLedger } = require(path.join(REPO, "lib/truth-build-ledger"));
const { runRelationalTruthBuild } = require(path.join(REPO, "lib/relational-truth-build-runner"));
const { DEFAULT_PROCESSING_CONFIG } = require(path.join(REPO, "lib/truth-processing-watermark"));

(async () => {
  const cut = process.argv[2];
  const keySuffix = String(process.argv[3] || "").trim();
  if (!/^cut:v1:[0-9a-f]{64}$/.test(cut || "")) {
    throw new Error("usage: production-publish.js <cut:v1:hash> [key-suffix]");
  }
  if (keySuffix && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(keySuffix)) {
    throw new Error("key-suffix must be a lowercase alphanumeric/hyphen token");
  }
  const suffix = keySuffix ? `:${keySuffix}` : "";
  const preflight = await directClient();
  try {
    const { rows } = await preflight.query(`
      select
        exists(select 1 from public.truth_shadow_root_source_cuts
          where workspace_key=$1 and source_cut_id=$2) shadow_root,
        exists(select 1 from public.truth_production_cut_acceptance_bridges
          where workspace_key=$1 and production_source_cut_id=$2
            and production_eligible=true
            and production_publication_attempted=false) bridged
    `, [WORKSPACE, cut]);
    if (rows[0]?.shadow_root || !rows[0]?.bridged) {
      throw new Error("production publication requires a bridged non-shadow required-source cut");
    }
  } finally {
    await preflight.end();
  }
  const issuer = issuerToken();
  if (issuer.length < 32) throw new Error("issuer token too short");
  const hybrid = createHybridRpc();
  const ledger = createTruthBuildLedger({
    workspaceKey: WORKSPACE,
    syncToken: process.env.PQ_SUPABASE_SYNC_TOKEN,
    callRpc: hybrid,
  });
  const receipt = await runRelationalTruthBuild({
    ledger,
    workerId: "truth-production:build",
    sourceCutId: cut,
    buildChannel: "candidate",
    triggerName: "ceremony:production-cutover",
    idempotencyKey: `candidate${suffix}:${cut}`,
    model: "gpt-5.2",
    modelProvider: "openai-responses",
    promptVersion: "n/a",
    processingConfig: DEFAULT_PROCESSING_CONFIG,
    leaseSeconds: 900,
    bundleRowLimit: 100000,
    publication: {
      publicationRequestKey: `production-publication${suffix}:${cut}`,
      publicationReason: "normal",
      publisherVersion: "hosted-truth-shadow-runtime-v2:build-v1",
      publishedBy: "truth-production:build",
      issueProductionApproval: async (authority) => {
        const credential = crypto.randomBytes(32).toString("base64url");
        const approval = await ledger.issueProductionApproval({
          buildPairId: authority.pair.buildPairId,
          approvalRequestKey: `ceremony-production:${cut}:${crypto.randomUUID()}`,
          publicationRequestKey: authority.publicationRequestKey,
          expectedHeadVersion: authority.expectedHeadVersion,
          expectedHeadPacketHash: authority.expectedHeadPacketHash,
          publicationReason: authority.publicationReason,
          publisherVersion: authority.publisherVersion,
          publishedBy: authority.publishedBy,
          approvedBy: "operator-ceremony-runtime",
          approvalReason: "env-gated compressed cutover publication",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          credential,
          issuerToken: issuer,
        });
        return { approvalId: approval.approvalId, credential };
      },
    },
    deadlineAtMs: Date.now() + 35 * 60 * 1000,
  });
  console.log("PUBLISH:", JSON.stringify({
    status: receipt?.status,
    pair: receipt?.pair && {
      buildPairId: receipt.pair.buildPairId,
      status: receipt.pair.status,
      packetHash: receipt.pair.packetHash,
    },
    publication: receipt?.publication && {
      publicationId: receipt.publication.publicationId,
      channel: receipt.publication.channel,
      packetHash: receipt.publication.packetHash,
      publicationVersion: receipt.publication.publicationVersion,
    },
  }).slice(0, 700));
  await hybrid.end();
  if (receipt?.status !== "succeeded") process.exitCode = 2;
})().catch((e) => { console.error("PUBLISH ERR:", String(e && (e.code ? `${e.code} ` : "") + e.message).slice(0, 400)); process.exit(1); });

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createServerProtectedOriginClient } = require("../lib/server-protected-origin-client");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_BASE_URL = "https://pq-ops-demo.example";

function loadLocalEnv(env = process.env) {
  for (const fileName of [".env.local", ".env"]) {
    const filePath = path.join(ROOT_DIR, fileName);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match || env[match[1]]) continue;
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

async function runHostedCanonicalRefresh({
  env = process.env,
  baseUrl = env.PQ_PRODUCTION_BASE_URL || DEFAULT_BASE_URL,
  trigger = "morning-source-sync",
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const routeAuthorizationToken = String(env.PQ_EMAIL_REFRESH_RUN_NOW_TOKEN || "");
  const productionProtectionBypassSecret = String(
    env.PQ_TRUTH_PROTECTION_BYPASS_SECRET || env.VERCEL_AUTOMATION_BYPASS_SECRET || "",
  );
  const client = createServerProtectedOriginClient({
    origin: root,
    protectionBypassSecret: productionProtectionBypassSecret,
    fetchImpl,
    timeoutMs: 300000,
    maxResponseBytes: 1024 * 1024,
    clientVersion: "hosted-canonical-refresh-v2",
  });
  const startedAt = now().toISOString();
  const refreshResponse = await client.requestJson({
    pathname: `/api/email-refresh/run-now?force=1&trigger=${encodeURIComponent(trigger)}`,
    method: "POST",
    authorizationToken: routeAuthorizationToken,
    body: {},
    timeoutMs: 300000,
  });
  const refresh = refreshResponse.body;
  if (!refreshResponse.ok) {
    const error = new Error(`Hosted canonical refresh returned ${refreshResponse.status}: ${String(refresh?.code || refresh?.reason || refresh?.error || "request rejected")}`);
    error.code = "HOSTED_CANONICAL_REFRESH_HTTP_FAILED";
    error.refresh = refresh;
    throw error;
  }
  if (!refresh?.ok || ["failed", "blocked"].includes(refresh.outcome)) {
    const error = new Error(refresh?.reason || "Hosted canonical refresh failed or was blocked.");
    error.code = "HOSTED_CANONICAL_REFRESH_FAILED";
    error.refresh = refresh;
    throw error;
  }

  const metadataResponse = await client.requestJson({
    pathname: "/api/snapshots?keys=shipment-truth-packets&metadata=1",
    method: "GET",
    authorizationToken: routeAuthorizationToken,
    timeoutMs: 30000,
  });
  const metadata = metadataResponse.body;
  if (!metadataResponse.ok) {
    const error = new Error(`Hosted canonical read-back returned ${metadataResponse.status}: ${String(metadata?.error || "request rejected")}`);
    error.code = "HOSTED_CANONICAL_READBACK_HTTP_FAILED";
    error.metadata = metadata;
    throw error;
  }
  const packet = metadata?.metadata?.["shipment-truth-packets"];
  if (!packet || !String(packet.writerVersion || "").includes("canonical-publisher-v1")) {
    const error = new Error("Hosted read-back did not return the canonical publisher packet metadata.");
    error.code = "HOSTED_CANONICAL_READBACK_FAILED";
    error.metadata = metadata;
    throw error;
  }
  if (Date.parse(packet.snapshotTime || "") < Date.parse(startedAt)) {
    const error = new Error(`Hosted canonical packet predates the forced refresh (${packet.snapshotTime || "missing"} < ${startedAt}).`);
    error.code = "HOSTED_CANONICAL_READBACK_STALE";
    error.packet = packet;
    throw error;
  }

  return {
    ok: true,
    trigger,
    startedAt,
    finishedAt: now().toISOString(),
    refresh,
    packet,
  };
}

if (require.main === module) {
  loadLocalEnv();
  runHostedCanonicalRefresh()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        code: error.code || "HOSTED_CANONICAL_REFRESH_ERROR",
        error: error instanceof Error ? error.message : String(error),
        refresh: error.refresh || null,
        packet: error.packet || null,
      }, null, 2));
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_BASE_URL,
  loadLocalEnv,
  runHostedCanonicalRefresh,
};

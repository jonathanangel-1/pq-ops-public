"use strict";
// Shared configuration for the production flip ceremony
// (YLYI/05_Agent_Runbooks/Production_Flip_Ceremony.md).
//
// Secrets are never stored in the repo. Resolution order:
//   direct DB connection : PQ_CEREMONY_PGCONN (URI) or PQ_CEREMONY_PGCONN_FILE
//   approval issuer token: PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN or
//                          PQ_CEREMONY_ISSUER_TOKEN_FILE
//   sync token           : PQ_SUPABASE_SYNC_TOKEN (loaded from .env.local)
// Artifacts (captures, parity reports, cut ids) go to PQ_CEREMONY_ARTIFACT_DIR.
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");

function loadRepoEnv() {
  const file = path.join(REPO, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"|"$/g, "");
    }
  }
}
loadRepoEnv();
process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED = process.env.PQ_TRUTH_MODEL_RUNTIME_ENABLED || "0";

function readSecretFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  // Accept either a raw value or a single KEY=value line.
  if (/^[A-Z0-9_]+=/.test(raw)) return raw.split("=").slice(1).join("=").trim();
  return raw;
}

function connectionString() {
  if (process.env.PQ_CEREMONY_PGCONN) return process.env.PQ_CEREMONY_PGCONN.trim();
  if (process.env.PQ_CEREMONY_PGCONN_FILE) return readSecretFile(process.env.PQ_CEREMONY_PGCONN_FILE);
  throw new Error("PQ_CEREMONY_PGCONN or PQ_CEREMONY_PGCONN_FILE is required");
}

// Manual parse: URI parsing breaks on '!' in passwords.
function parseConn(s) {
  const m = s.replace(/^postgres(ql)?:\/\//, "");
  const at = m.lastIndexOf("@");
  const up = m.slice(0, at);
  const hp0 = m.slice(at + 1);
  const uc = up.indexOf(":");
  const sl = hp0.indexOf("/");
  const hp = hp0.slice(0, sl);
  const co = hp.lastIndexOf(":");
  return {
    user: up.slice(0, uc),
    password: up.slice(uc + 1),
    host: hp.slice(0, co),
    port: parseInt(hp.slice(co + 1), 10),
    database: hp0.slice(sl + 1).split("?")[0],
    ssl: { rejectUnauthorized: false },
  };
}

function issuerToken() {
  if (process.env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN) {
    return process.env.PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN.trim();
  }
  if (process.env.PQ_CEREMONY_ISSUER_TOKEN_FILE) {
    return readSecretFile(process.env.PQ_CEREMONY_ISSUER_TOKEN_FILE);
  }
  throw new Error("PQ_TRUTH_PRODUCTION_APPROVAL_ISSUER_TOKEN or PQ_CEREMONY_ISSUER_TOKEN_FILE is required");
}

function artifactDir() {
  const dir = process.env.PQ_CEREMONY_ARTIFACT_DIR || path.join(REPO, ".ceremony-artifacts");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function directClient() {
  const { Client } = require(path.join(REPO, "node_modules/pg"));
  const client = new Client(parseConn(connectionString()));
  await client.connect();
  await client.query("set statement_timeout=0");
  return client;
}

// Heavy build RPCs exceed both the authenticator statement budget and the
// Cloudflare edge (~100s) — they must ride the direct connection. Everything
// else stays on the audited HTTP path.
const HEAVY_RPCS = new Set(["claim_truth_build_pair", "complete_truth_build"]);

function createHybridRpc() {
  const { callSupabaseRpc } = require(path.join(REPO, "lib/supabase-agent"));
  let pg = null;
  const hybrid = async (rpc, body, options = {}) => {
    if (HEAVY_RPCS.has(rpc)) {
      if (!pg) pg = await directClient();
      const args = Object.keys(body).sort();
      const named = args.map((k, i) => `${k} => $${i + 1}`).join(", ");
      const vals = args.map((k) => {
        const v = body[k];
        return (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
      });
      const t0 = Date.now();
      const { rows } = await pg.query(`select public.${rpc}(${named}) as r`, vals);
      console.log(`[direct] ${rpc} in ${Math.round((Date.now() - t0) / 1000)}s`);
      return rows[0].r;
    }
    return callSupabaseRpc(rpc, body, { ...options, timeoutMs: options.timeoutMs || 120000, retryDelaysMs: [] });
  };
  hybrid.end = async () => { if (pg) await pg.end().catch(() => {}); pg = null; };
  return hybrid;
}

module.exports = {
  REPO,
  WORKSPACE: "primary",
  parseConn,
  connectionString,
  issuerToken,
  artifactDir,
  directClient,
  createHybridRpc,
};

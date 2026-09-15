#!/usr/bin/env node
"use strict";

const { randomUUID } = require("node:crypto");
const { loadLocalEnv } = require("./run-hosted-canonical-refresh");

const REQUEST_URL = "/api/cron/gmail-refresh?force=1";

function configureLocalEnvironment(env = process.env) {
  loadLocalEnv(env);

  env.PQ_GMAIL_DIRECT_ENABLED = "1";
  env.PQ_GMAIL_REFRESH_DISABLED = "0";
  env.PQ_CRON_SUPABASE_PAUSED = "0";
  env.PQ_GMAIL_REFRESH_ACTIVE_HOURS = "0";

  const cronSecret = String(env.CRON_SECRET || "").trim() || `local-truth-refresh-${randomUUID()}`;
  env.CRON_SECRET = cronSecret;
  return { cronSecret };
}

function invokeHandler(handler, cronSecret) {
  const request = {
    method: "GET",
    url: REQUEST_URL,
    headers: {
      authorization: `Bearer ${cronSecret}`,
    },
  };

  return new Promise((resolve, reject) => {
    let ended = false;
    const response = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[String(name).toLowerCase()] = value;
      },
      end(content) {
        if (ended) return;
        ended = true;
        try {
          resolve({
            statusCode: this.statusCode,
            body: content ? JSON.parse(String(content)) : {},
          });
        } catch (error) {
          reject(error);
        }
      },
    };

    Promise.resolve(handler(request, response)).then(() => {
      if (!ended) reject(new Error("Gmail refresh handler completed without a JSON response"));
    }, reject);
  });
}

function resultSummary({ statusCode = 0, body = {} } = {}) {
  const ok = statusCode >= 200 && statusCode < 300 &&
    body?.ok === true &&
    body?.paused !== true &&
    body?.persistencePaused !== true;
  const error = ok
    ? null
    : String(
      body?.error ||
      body?.reason ||
      body?.persistence?.error ||
      body?.refreshHealth?.error ||
      (statusCode ? `Gmail refresh returned HTTP ${statusCode}` : "Gmail refresh did not return a response"),
    );

  return {
    ok,
    truthPacketsChanged: Boolean(body?.truthPacketsChanged),
    gmailCoverageStatus: String(body?.gmailCoverageStatus || ""),
    updated: Number.isFinite(Number(body?.updated)) ? Number(body.updated) : 0,
    error,
  };
}

async function runLocalTruthRefresh() {
  const { cronSecret } = configureLocalEnvironment();
  // Load the handler only after .env.local and the local on-demand gates are set.
  const handler = require("../api/cron/gmail-refresh");
  return resultSummary(await invokeHandler(handler, cronSecret));
}

if (require.main === module) {
  runLocalTruthRefresh()
    .then((result) => {
      const output = JSON.stringify(result);
      if (result.ok) console.log(output);
      else {
        console.error(output);
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        truthPacketsChanged: false,
        gmailCoverageStatus: "",
        updated: 0,
        error: error instanceof Error ? error.message : String(error),
      }));
      process.exitCode = 1;
    });
}

module.exports = {
  configureLocalEnvironment,
  invokeHandler,
  resultSummary,
  runLocalTruthRefresh,
};

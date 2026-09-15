#!/usr/bin/env node
"use strict";

const {
  canonicalGmailIngestionPolicy,
} = require("../lib/gmail-ingestion-authority");

const policy = canonicalGmailIngestionPolicy();
const command = process.argv[2] || "legacy Gmail ingestion";

console.error(JSON.stringify({
  ok: false,
  command,
  error: "legacy-gmail-ingestion-quarantined",
  canonicalPipeline: policy.canonicalPipeline,
  rule: policy.rule,
  developmentBackfill:
    `Run the underlying script directly with ${policy.legacyFlag} or ${policy.legacyEnv}=1 only for a deliberate local backfill.`,
}, null, 2));
process.exit(1);

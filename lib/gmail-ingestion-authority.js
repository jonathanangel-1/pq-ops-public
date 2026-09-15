"use strict";

const CANONICAL_GMAIL_INGESTION_PIPELINE = "gmail-direct-oauth-cron";
const LEGACY_GMAIL_INGESTION_ENV = "PQ_ALLOW_LEGACY_GMAIL_INGESTION";
const LEGACY_GMAIL_INGESTION_FLAG = "--allow-legacy-gmail-ingestion";

function legacyGmailIngestionAllowed({ env = process.env, argv = process.argv } = {}) {
  return env[LEGACY_GMAIL_INGESTION_ENV] === "1" || (argv || []).includes(LEGACY_GMAIL_INGESTION_FLAG);
}

function canonicalGmailIngestionPolicy() {
  return {
    canonicalPipeline: CANONICAL_GMAIL_INGESTION_PIPELINE,
    legacyEnv: LEGACY_GMAIL_INGESTION_ENV,
    legacyFlag: LEGACY_GMAIL_INGESTION_FLAG,
    rule:
      "Hosted Gmail OAuth direct ingestion is the only unattended shipment-truth writer. Local Gmail enrichment/job scripts are quarantined for deliberate development backfills only.",
  };
}

function assertLegacyGmailIngestionAllowed(toolName, options = {}) {
  if (legacyGmailIngestionAllowed(options)) return true;
  const policy = canonicalGmailIngestionPolicy();
  throw new Error(
    `${toolName || "legacy Gmail ingestion"} is quarantined. ` +
      `Use ${policy.canonicalPipeline} for production truth, or set ${policy.legacyEnv}=1 / pass ${policy.legacyFlag} for a deliberate development backfill.`,
  );
}

function legacyGmailIngestionChildEnv(env = process.env) {
  return {
    ...env,
    [LEGACY_GMAIL_INGESTION_ENV]: "1",
  };
}

module.exports = {
  CANONICAL_GMAIL_INGESTION_PIPELINE,
  LEGACY_GMAIL_INGESTION_ENV,
  LEGACY_GMAIL_INGESTION_FLAG,
  assertLegacyGmailIngestionAllowed,
  canonicalGmailIngestionPolicy,
  legacyGmailIngestionAllowed,
  legacyGmailIngestionChildEnv,
};

"use strict";

const { evidenceEligible, isStatusRequest } = require("./speech-acts");

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pruneActionQueueAgainstTruthPackets } = require("./action-queue-sanitizer");
const { buildActiveAwbIndexSnapshot } = require("./active-awb-index");
const {
  loadAppSnapshot,
  loadAppSnapshotMetadataRows,
  upsertAppSnapshot,
  upsertOpsFactLedger,
} = require("./supabase-agent");
const { contentSignature, postgresSafeJson, withContentSignature } = require("./content-signature");
const { prepareCanonicalTruthPackets, publishHostedCanonicalTruth } = require("./canonical-truth-publisher");
const { classifyAttachmentEvidence, classifyAttachmentTriage, normalizeAwb } = require("./ops-brain-companion");
const {
  buildCanonicalShipments,
  canonicalPhaseSummary,
  canonicalShipmentAsCompanionShipment,
  carrierTrackingIndex,
  nextPhaseFromGates,
} = require("./canonical-shipment-pipeline");
const { attachOperatorPackets } = require("./operator-truth-packet");
const { attachPrimaryPlatformActions } = require("./platform-action");
const {
  deliverPendingOperatorPushes,
  operatorEventsFromNotificationsSnapshot,
  upsertOperatorEventsFromNotificationsSnapshot,
} = require("./operator-events");
const {
  classifyPdfOperationalEvidence,
  decodeBase64UrlBuffer,
  extractPdfTextFromBuffer,
} = require("./pdf-evidence");
const {
  buildDurableOperationalFactLedger,
  mergePreviousExtractionResults,
  runAiExtractionForLedger,
} = require("./ops-fact-ledger");
const { terminalEvidenceCertification } = require("./terminal-evidence-certification");
const { createPodVisionOcr } = require("./pod-vision-ocr");
const { createArrivalNoticeVisionOcr } = require("./arrival-notice-vision");
const { createMessageModelClassifier } = require("./message-model-classifier");
const {
  gmailOAuthStoreConfigured,
  loadStoredGmailRefreshToken,
  recordGmailOAuthRefreshResult,
} = require("./gmail-oauth-store");

let bundledTmsDetailSnapshot = null;
let bundledTmsGridSnapshot = null;
try {
  bundledTmsDetailSnapshot = require("../tms-detail-snapshot.json");
} catch {
  bundledTmsDetailSnapshot = null;
}
try {
  bundledTmsGridSnapshot = require("../tms-grid-snapshot.json");
} catch {
  bundledTmsGridSnapshot = null;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_LOOKBACK_DAYS = 7;
const OPERATOR_TIME_ZONE = "America/New_York";
const DEFAULT_LEDGER_NOTIFICATION_MAX_AGE_HOURS = 36;
const REFRESH_SNAPSHOT_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_SNAPSHOT_TIMEOUT_MS || 4000);
const REFRESH_WRITE_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_WRITE_TIMEOUT_MS || 6000);
const REFRESH_LEDGER_WRITE_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_LEDGER_WRITE_TIMEOUT_MS || 30000);
const REFRESH_TRUTH_WRITE_TIMEOUT_MS = Number(process.env.PQ_GMAIL_REFRESH_TRUTH_WRITE_TIMEOUT_MS || 30000);
const TMS_SOURCE_SNAPSHOT_KEYS = ["tms-detail-snapshot", "tms-grid-snapshot"];
const DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES = 24 * 60;
const DEFAULT_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES = 180;
const ENGLISH_OPERATIONAL_TERMS = [
  "loaded",
  "\"driver loaded\"",
  "\"picked up\"",
  "\"pickup complete\"",
  "\"pickup tomorrow\"",
  "\"pick up tomorrow\"",
  "\"pickup scheduled\"",
  "\"recover tomorrow\"",
  "\"recovery tomorrow\"",
  "\"try tomorrow\"",
  "\"tomorrow morning\"",
  "\"arriving tonight\"",
  "\"pieces arriving\"",
  "\"pcs arriving\"",
  "recovered",
  "\"will deliver\"",
  "\"delivery tomorrow\"",
  "\"deliver was completed\"",
  "\"has been delivered\"",
  "\"offloaded the cargo\"",
  "\"delivered by mistake\"",
  "\"another customer\"",
  "\"another cnee\"",
  "\"wrong customer\"",
  "\"wrong cnee\"",
  "\"wrong consignee\"",
  "\"wrong recipient\"",
  "\"wrong receiver\"",
  "\"different customer\"",
  "\"different cnee\"",
  "\"other than Northstar Components\"",
  "\"returned to you\"",
  "\"confirm returned\"",
  "\"return to El Al\"",
  "\"return to airline\"",
  "\"return to station\"",
  "\"send back\"",
  "\"bring back\"",
  "\"POD\"",
  "\"proof of delivery\"",
  "\"driver is on site\"",
  "\"driver onsite\"",
  "detention",
  "\"cannot see\"",
  "\"cannot find\"",
  "\"not found\"",
  "\"can't locate\"",
  "\"cargo missing\"",
  "\"not released\"",
  "\"cancel their entry\"",
  "\"nominate\"",
  "\"transfer is done\"",
  "\"transfer done\"",
  "\"shipment received\"",
  "\"loaded for flight\"",
  "\"will be loaded\"",
];
const RELEASE_OPERATIONAL_TERMS = [
  "\"delivery order\"",
  "\"deli order\"",
  "\"d/o\"",
  "\"do + ace\"",
  "\"d/o + ace\"",
  "\"do and ace\"",
  "\"d/o and ace\"",
  "\"delivery order and release\"",
  "\"deli order and release\"",
  "\"release and delivery order\"",
  "\"customs release\"",
  "\"customs clearance\"",
  "\"release attached\"",
  "\"d/o attached\"",
  "\"delivery order attached\"",
  "release",
  "released",
  "clearance",
  "cleared",
  "customs",
  "ACE",
];
const HEBREW_OPERATIONAL_TERMS = [
  "\"נאסף\"",
  "\"נאספה\"",
  "\"נלקח\"",
  "\"הועמס\"",
  "\"הנהג אסף\"",
  "\"הנהג העמיס\"",
  "\"יימסר\"",
  "\"ימסר\"",
  "\"מסירה מחר\"",
  "\"נמסר\"",
  "\"תעודת מסירה\"",
  "\"אישור מסירה\"",
  "\"פוד\"",
  "\"שוחרר מהמכס\"",
  "\"הודעת הגעה\"",
  "\"זמין לאיסוף\"",
  "\"לא שוחרר\"",
  "\"אחסנה\"",
  "\"זמן המתנה\"",
  "\"בעיית שידור\"",
  "\"כמות חבילות\"",
  "\"לא מוצאים\"",
  "\"לא נמצא\"",
  "\"מטען חסר\"",
  "\"להחזיר את המשלוח\"",
  "\"שיחזור בהקדם\"",
  "\"מוחזר\"",
];
const GMAIL_DIRECT_WRITER_VERSION = "gmail-direct-io-v6";
const MAX_PROOF_EVIDENCE_ITEMS = 40;
const MAX_HISTORICAL_PROOF_ITEMS = 50;
const MAX_OPERATIONAL_ATTACHMENT_AUDIT_ITEMS = 40;
const MAX_CONTEXT_ATTACHMENT_AUDIT_ITEMS = 10;
const MAX_IGNORED_ATTACHMENT_AUDIT_ITEMS = 10;
const MAX_NEAR_MISS_AWB_ALERTS_PER_REFRESH = 25;
const MAX_NEAR_MISS_AWB_ALERTS_PER_ACTIVE_AWB = 3;
const WRONG_CONSIGNEE_DELIVERY_PATTERN = /\b(?:shipment|freight|cargo|load|it)?\b[^.;\n]{0,80}\b(?:delivered|delivery(?:\s+made)?)\b[^.;\n]{0,180}\b(?:by mistake|mistakenly|wrong\s+(?:consignee|cnee|customer|receiver|recipient|party|address)|another\s+(?:consignee|cnee|customer|receiver|recipient|party)|different\s+(?:consignee|cnee|customer|receiver|recipient|party)|other than\s+(?:northstar components|the\s+(?:correct|intended)\s+(?:consignee|cnee|customer|receiver|recipient|party)|(?:the\s+)?(?:consignee|cnee|customer|receiver|recipient|party)))\b|\b(?:wrong|another|different)\s+(?:consignee|cnee|customer|receiver|recipient|party)\b[^.;\n]{0,160}\b(?:delivered|delivery|received|return(?:ed)?|send back)\b|\b(?:whoever|customer|consignee|cnee|receiver|recipient|party)\b[^.;\n]{0,120}\b(?:received|got|has)\b[^.;\n]{0,120}\b(?:return|send back|bring back)\b/i;

function envValue(value) {
  const raw = String(value || "").trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function strictBooleanEnv(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  throw new Error("Boolean environment value must be 1, 0, true, or false");
}

function gmailDirectEnv(env = process.env) {
  const clientIdSource = env.GMAIL_CLIENT_ID ? "GMAIL_CLIENT_ID" : env.GOOGLE_CLIENT_ID ? "GOOGLE_CLIENT_ID" : "";
  const clientSecretSource = env.GMAIL_CLIENT_SECRET ? "GMAIL_CLIENT_SECRET" : env.GOOGLE_CLIENT_SECRET ? "GOOGLE_CLIENT_SECRET" : "";
  const refreshTokenSource = env.GMAIL_REFRESH_TOKEN ? "GMAIL_REFRESH_TOKEN" : env.GOOGLE_GMAIL_REFRESH_TOKEN ? "GOOGLE_GMAIL_REFRESH_TOKEN" : "";
  const clientId = envValue(env.GMAIL_CLIENT_ID || env.GOOGLE_CLIENT_ID);
  const clientSecret = envValue(env.GMAIL_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET);
  const refreshToken = envValue(env.GMAIL_REFRESH_TOKEN || env.GOOGLE_GMAIL_REFRESH_TOKEN);
  const user = envValue(env.GMAIL_USER || env.GMAIL_USER_EMAIL) || "me";
  const storedOAuthAvailable = Boolean(clientId && clientSecret && gmailOAuthStoreConfigured(env));
  const tokenSource = refreshToken ? "static-env" : storedOAuthAvailable ? "stored-oauth" : "";
  return {
    clientId,
    clientSecret,
    refreshToken,
    clientIdSource,
    clientSecretSource,
    refreshTokenSource,
    storedOAuthAvailable,
    tokenSource,
    user,
    available: Boolean(clientId && clientSecret && (refreshToken || storedOAuthAvailable)),
  };
}

function gmailDirectAvailable(env = process.env) {
  return gmailDirectEnv(env).available;
}

function gmailDirectEnabled(env = process.env) {
  return env.PQ_GMAIL_DIRECT_ENABLED === "1" && gmailDirectAvailable(env);
}

async function refreshAccessToken(env = process.env) {
  const cfg = gmailDirectEnv(env);
  if (!cfg.available) throw new Error("Missing Gmail OAuth env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN or stored OAuth connection");
  let refreshToken = cfg.refreshToken;
  let tokenSource = cfg.tokenSource || "static-env";
  if (!refreshToken && cfg.storedOAuthAvailable) {
    const stored = await loadStoredGmailRefreshToken({
      env,
      connectionKey: envValue(env.GMAIL_OAUTH_CONNECTION_KEY || env.PQ_GMAIL_OAUTH_CONNECTION_KEY) || "primary",
    });
    refreshToken = stored.refreshToken;
    tokenSource = "stored-oauth";
  }
  if (!refreshToken) throw new Error("Missing Gmail OAuth refresh token");
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok || !payload.access_token) {
      const googleError = [payload.error, payload.error_description].filter(Boolean).join(": ");
      throw new Error(`Google OAuth ${response.status}${googleError ? ` ${googleError}` : ""}`);
    }
    if (tokenSource === "stored-oauth") {
      await recordGmailOAuthRefreshResult({ ok: true, env });
    }
    return { accessToken: payload.access_token, user: cfg.user, tokenSource };
  } catch (error) {
    if (tokenSource === "stored-oauth") {
      await recordGmailOAuthRefreshResult({
        ok: false,
        env,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
}

async function checkDirectGmailAuth(env = process.env) {
  const cfg = gmailDirectEnv(env);
  if (!cfg.available) {
    return {
      ok: false,
      phase: "gmail-config",
      error: "Direct Gmail OAuth env is incomplete.",
      user: cfg.user,
      missing: [
        cfg.clientId ? "" : "GMAIL_CLIENT_ID or GOOGLE_CLIENT_ID",
        cfg.clientSecret ? "" : "GMAIL_CLIENT_SECRET or GOOGLE_CLIENT_SECRET",
        cfg.refreshToken || cfg.storedOAuthAvailable ? "" : "GMAIL_REFRESH_TOKEN, GOOGLE_GMAIL_REFRESH_TOKEN, or stored Gmail OAuth connection",
      ].filter(Boolean),
    };
  }
  try {
    const access = await refreshAccessToken(env);
    const profile = await gmailFetch(access, "/profile");
    return {
      ok: true,
      phase: "gmail-profile",
      user: access.user,
      emailAddress: profile.emailAddress || "",
      messagesTotal: Number(profile.messagesTotal || 0),
      threadsTotal: Number(profile.threadsTotal || 0),
    };
  } catch (error) {
    return {
      ok: false,
      phase: "gmail-auth",
      user: cfg.user,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function gmailFetch(access, pathname, query = {}) {
  const url = new URL(`${GMAIL_API}/${encodeURIComponent(access.user)}${pathname}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${access.accessToken}` },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error?.message || `Gmail API failed: ${response.status}`);
  return payload;
}

async function gmailPost(access, pathname, body) {
  const url = `${GMAIL_API}/${encodeURIComponent(access.user)}${pathname}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error?.message || `Gmail API failed: ${response.status}`);
  return payload;
}

function awbSearchTerms(awb) {
  const normalized = normalizeAwb(awb);
  if (!normalized) return [];
  const noPrefix = normalized.length > 3 ? normalized.slice(3) : normalized;
  const dashed = normalized.length > 3 ? `${normalized.slice(0, 3)}-${normalized.slice(3)}` : normalized;
  return [...new Set([awb, normalized, noPrefix, dashed].filter(Boolean))];
}

function isSingleEditAwbReference(candidate, activeAwb) {
  const left = String(candidate || "");
  const right = String(activeAwb || "");
  if (!left || !right || left === right || Math.abs(left.length - right.length) > 1) return false;
  if (left.length === right.length) {
    const mismatches = [];
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) mismatches.push(index);
      if (mismatches.length > 2) return false;
    }
    if (mismatches.length === 1) return true;
    if (mismatches.length !== 2 || mismatches[1] !== mismatches[0] + 1) return false;
    const [first, second] = mismatches;
    return left[first] === right[second] && left[second] === right[first];
  }

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let shorterIndex = 0;
  let longerIndex = 0;
  let skipped = false;
  while (shorterIndex < shorter.length && longerIndex < longer.length) {
    if (shorter[shorterIndex] === longer[longerIndex]) {
      shorterIndex += 1;
      longerIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longerIndex += 1;
  }
  return true;
}

function awbShapedCandidatePattern() {
  return /(?<!\d)(?:\d{3}[-/\s]?\d{7,10}|(?:014|016|114|238|700|932)(?:[-/\s]?\d){9,10})(?!\d)/g;
}

function awbShapedCandidateTokens(text) {
  return [...String(text || "").matchAll(awbShapedCandidatePattern())]
    .map((match) => match[0]);
}

function maskNonExactActiveAwbCandidates(text, activeAwbs) {
  const activeAwbSet = new Set(
    (activeAwbs || []).map((awb) => normalizeAwb(awb)).filter(Boolean),
  );
  return String(text || "").replace(awbShapedCandidatePattern(), (token) => {
    const resolved = normalizeAwb(token);
    return resolved && activeAwbSet.has(resolved) ? token : " ".repeat(token.length);
  });
}

function maskMalformedAwbCandidates(text) {
  return String(text || "").replace(awbShapedCandidatePattern(), (token) =>
    normalizeAwb(token) ? token : " ".repeat(token.length)
  );
}

function editDistanceOneActiveAwbReferences(text, activeAwbs) {
  const normalizedActiveAwbs = [...new Set(
    (activeAwbs || [])
      .map((awb) => normalizeAwb(awb))
      .filter((awb) => /^\d{11}$/.test(awb)),
  )];
  if (!normalizedActiveAwbs.length) return [];
  const references = [];
  for (const token of awbShapedCandidateTokens(text)) {
    const digits = token.replace(/\D/g, "");
    const resolved = normalizeAwb(token);
    if (/^\d{11}$/.test(resolved)) continue;
    const activeAwbsAtDistanceOne = normalizedActiveAwbs.filter((activeAwb) =>
      digits !== activeAwb && isSingleEditAwbReference(digits, activeAwb)
    );
    if (activeAwbsAtDistanceOne.length) references.push({ token, activeAwbs: activeAwbsAtDistanceOne });
  }
  return references;
}

function detectNearMissAwbReferences(text, activeAwbs) {
  const seen = new Set();
  const references = [];
  for (const candidate of editDistanceOneActiveAwbReferences(text, activeAwbs)) {
    if (candidate.activeAwbs.length !== 1) continue;
    const reference = { token: candidate.token, activeAwb: candidate.activeAwbs[0] };
    const key = reference.token + "\u0000" + reference.activeAwb;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return references;
}

function nearMissAwbReferencesInMessage(message, activeAwbs) {
  const references = [];
  const seen = new Set();
  const parts = [message?.subject || "", normalizeBodyText(message?.text || "")].filter(Boolean);
  for (const part of parts) {
    for (const reference of detectNearMissAwbReferences(part, activeAwbs)) {
      const key = reference.token + "\u0000" + reference.activeAwb;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(reference);
    }
  }
  return references;
}

function nearMissActiveAwbsInMessage(message, activeAwbs) {
  return [...new Set(
    [message?.subject || "", normalizeBodyText(message?.text || "")].filter(Boolean)
      .flatMap((part) => editDistanceOneActiveAwbReferences(part, activeAwbs))
      .flatMap((reference) => reference.activeAwbs)
      .map(normalizeAwb)
      .filter(Boolean),
  )];
}

function differentAwbMentions(text, awb) {
  const target = normalizeAwb(awb);
  if (!target) return [];
  return [...new Set(
    [...String(text || "").matchAll(/\b\d{3}[-/\s]?\d{8}\b/g)]
      .map((match) => normalizeAwb(match[0]))
      .filter((item) => item && item !== target)
  )];
}

function extractMentionedAwbs(text) {
  return [...new Set(
    [...String(text || "").matchAll(/\b\d{3}[-/\s]?\d{8}\b/g)]
      .map((match) => normalizeAwb(match[0]))
      .filter(Boolean)
  )];
}

// Resolve suffix-only AWB references ("85336 and 85340") against a known AWB list. Operators
// routinely drop the 3-digit prefix inside a thread whose context already fixes it; the prefix
// requirement made such siblings invisible to group inference. Only known AWBs can match, so a
// stray 8-digit number can never invent a shipment.
function extractMentionedAwbsWithKnown(text, knownAwbs = []) {
  // A malformed AWB candidate can contain a valid active suffix (for example
  // `016-4 14198015`). Mask the whole unresolved candidate before either full-AWB or
  // suffix resolution so a near miss can never establish a shipment/workgroup link.
  const value = maskMalformedAwbCandidates(text);
  const mentioned = new Set(extractMentionedAwbs(value));
  if (value && (knownAwbs || []).length) {
    // Full AWBs were resolved above. Hide every full candidate before suffix-only
    // resolution so `999 14198015` cannot alias active `01614198015` through its serial.
    const suffixValue = value.replace(awbShapedCandidatePattern(), (token) => " ".repeat(token.length));
    const suffixOwners = new Map();
    for (const known of knownAwbs) {
      const normalized = normalizeAwb(known);
      if (!normalized || normalized.length <= 3) continue;
      const suffix = normalized.slice(3);
      // A suffix shared by two known AWBs is ambiguous — never resolve it.
      suffixOwners.set(suffix, suffixOwners.has(suffix) ? null : normalized);
    }
    for (const match of suffixValue.matchAll(/(?<![\d-])(\d{8})\b/g)) {
      const owner = suffixOwners.get(match[1]);
      if (owner) mentioned.add(owner);
    }
    // Short suffix form (5-6 digits, e.g. "85336") — require word boundaries and a known owner.
    for (const match of suffixValue.matchAll(/(?<![\d-])(\d{5,7})\b/g)) {
      for (const known of knownAwbs) {
        const normalized = normalizeAwb(known);
        if (normalized && normalized.length === 11 && normalized.endsWith(match[1])) {
          const owners = knownAwbs.filter((item) => {
            const candidate = normalizeAwb(item);
            return candidate && candidate.length === 11 && candidate.endsWith(match[1]);
          });
          if (owners.length === 1) mentioned.add(normalized);
        }
      }
    }
  }
  return [...mentioned];
}

function buildSearchQueries(awbs, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  return [...new Set((awbs || []).filter((awb) => normalizeAwb(awb)))].map((awb) => {
    const terms = awbSearchTerms(awb);
    return `(${terms.map((term) => `"${term}"`).join(" OR ")}) newer_than:${lookbackDays}d -in:spam -in:trash`;
  });
}

function buildOperationalSearchQueries(awbs, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  const operationalTerms = [...ENGLISH_OPERATIONAL_TERMS, ...HEBREW_OPERATIONAL_TERMS];
  return [...new Set((awbs || []).filter((awb) => normalizeAwb(awb)))].map((awb) => {
    const terms = awbSearchTerms(awb);
    return `(${terms.map((term) => `"${term}"`).join(" OR ")}) (${operationalTerms.join(" OR ")}) newer_than:${lookbackDays}d -in:spam -in:trash`;
  });
}

function buildReleaseSearchQueries(awbs, lookbackDays = DEFAULT_LOOKBACK_DAYS) {
  return [...new Set((awbs || []).filter((awb) => normalizeAwb(awb)))].map((awb) => {
    const terms = awbSearchTerms(awb);
    return `(${terms.map((term) => `"${term}"`).join(" OR ")}) (${RELEASE_OPERATIONAL_TERMS.join(" OR ")}) newer_than:${lookbackDays}d -in:spam -in:trash`;
  });
}

// Discovery lane: non-AWB-scoped queries that catch operational truth the per-AWB text
// searches can miss entirely — courier/status-update senders and TRACK# subjects. Without
// this lane a delivered-status email is only found if an AWB text query happens to surface
// its thread inside the per-AWB cap (how the 114-80000250 delivery was missed).
const DEFAULT_DISCOVERY_SENDERS = ["contact-067@demo-freight.example", "contact-095@demo-freight.example"];

function buildDiscoverySearchQueries(lookbackDays = DEFAULT_LOOKBACK_DAYS, env = process.env) {
  if (String(env.PQ_GMAIL_DISCOVERY_DISABLED || "") === "1") return [];
  const suffix = `newer_than:${lookbackDays}d -in:spam -in:trash`;
  const custom = String(env.PQ_GMAIL_DISCOVERY_QUERIES || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  if (custom.length) return custom.map((query) => `${query} ${suffix}`);
  return [
    `from:(${DEFAULT_DISCOVERY_SENDERS.join(" OR ")}) ${suffix}`,
    `subject:("STATUS UPDATE" "TRACK#") ${suffix}`,
  ];
}

function buildGmailSearchPlans(awbs, lookbackDays = DEFAULT_LOOKBACK_DAYS, providedQueries = [], options = {}) {
  const plans = [];
  const seen = new Set();
  const addPlan = (plan) => {
    const query = String(plan.query || "").trim();
    if (!query || seen.has(query)) return;
    seen.add(query);
    plans.push({
      query,
      awb: normalizeAwb(plan.awb || ""),
      family: plan.family || "search",
    });
  };
  for (const query of providedQueries || []) addPlan({ query, family: "provided" });
  for (const query of options.discoveryQueries || []) addPlan({ query, family: "discovery" });
  for (const awb of [...new Set((awbs || []).filter((item) => normalizeAwb(item)))]) {
    const terms = awbSearchTerms(awb);
    const awbClause = `(${terms.map((term) => `"${term}"`).join(" OR ")})`;
    addPlan({
      awb,
      family: "release",
      query: `${awbClause} (${RELEASE_OPERATIONAL_TERMS.join(" OR ")}) newer_than:${lookbackDays}d -in:spam -in:trash`,
    });
    addPlan({
      awb,
      family: "base",
      query: `${awbClause} newer_than:${lookbackDays}d -in:spam -in:trash`,
    });
    addPlan({
      awb,
      family: "operational",
      query: `${awbClause} (${[...ENGLISH_OPERATIONAL_TERMS, ...HEBREW_OPERATIONAL_TERMS].join(" OR ")}) newer_than:${lookbackDays}d -in:spam -in:trash`,
    });
  }
  return plans;
}

async function listThreadIdsForQuery(access, q, maxResults = 50) {
  const detailed = await listThreadIdsForQueryDetailed(access, q, maxResults);
  return detailed.threadIds;
}

// Paginated thread-id listing with truncation visibility. The previous implementation read a
// single page and silently discarded nextPageToken, so a capped query could drop newer/older
// threads with no trace. moreAvailable=true means the query matched more threads than the cap.
async function listThreadIdsForQueryDetailed(access, q, maxResults = 50, fetcher = gmailFetch) {
  const limit = Math.max(1, Number(maxResults) || 50);
  const threadIds = [];
  const seen = new Set();
  let pageToken = "";
  let truncated = false;
  do {
    const params = { q, maxResults: String(Math.min(limit, 500)) };
    if (pageToken) params.pageToken = pageToken;
    const result = await fetcher(access, "/messages", params);
    for (const message of result.messages || []) {
      const threadId = message && message.threadId;
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      if (threadIds.length < limit) threadIds.push(threadId);
      else truncated = true;
    }
    pageToken = result.nextPageToken || "";
    if (pageToken && threadIds.length >= limit) {
      truncated = true;
      break;
    }
  } while (pageToken);
  return { threadIds, moreAvailable: truncated };
}

async function readThreads(access, threadIds) {
  const threads = [];
  for (const threadId of threadIds) {
    threads.push(await gmailFetch(access, `/threads/${encodeURIComponent(threadId)}`, { format: "full" }));
  }
  return threads;
}

function selectThreadIdsByQuery(threadIdsByQuery, maxThreadCount) {
  const limit = Math.max(0, Number(maxThreadCount || 0));
  const selected = [];
  const seen = new Set();
  const maxDepth = Math.max(0, ...(threadIdsByQuery || []).map((items) => items.length));
  for (let index = 0; index < maxDepth && selected.length < limit; index += 1) {
    for (const ids of threadIdsByQuery || []) {
      if (selected.length >= limit) break;
      const threadId = ids[index];
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      selected.push(threadId);
    }
  }
  return selected;
}

function selectThreadIdsBySearchPlan(searchResults, maxThreadCount, options = {}) {
  const perAwbMinimum = Math.max(0, Number(options.perAwbMinimum || 0));
  const awbOrder = [...new Set((searchResults || []).map((result) => result.awb).filter(Boolean))];
  const requestedLimit = Math.max(0, Number(maxThreadCount || 0));
  const configuredHardLimit = Math.max(0, Number(options.hardLimit || 0));
  const minimumLimit = perAwbMinimum ? awbOrder.length * perAwbMinimum : requestedLimit;
  const hardLimit = configuredHardLimit
    ? Math.max(requestedLimit, configuredHardLimit, awbOrder.length)
    : Math.max(requestedLimit, minimumLimit, awbOrder.length);
  const effectiveLimit = perAwbMinimum
    ? Math.min(Math.max(requestedLimit, awbOrder.length * perAwbMinimum), hardLimit)
    : requestedLimit;
  const selected = [];
  const seen = new Set();
  const pushThread = (threadId) => {
    if (!threadId || seen.has(threadId) || selected.length >= effectiveLimit) return false;
    seen.add(threadId);
    selected.push(threadId);
    return true;
  };
  for (const result of searchResults || []) {
    if (!result.awb) {
      for (const threadId of result.threadIds || []) pushThread(threadId);
    }
  }
  if (perAwbMinimum) {
    const perAwbQueues = new Map(awbOrder.map((awb) => [awb, []]));
    const perAwbSeen = new Map(awbOrder.map((awb) => [awb, new Set()]));
    for (const result of searchResults || []) {
      if (!result.awb || !perAwbQueues.has(result.awb)) continue;
      const queue = perAwbQueues.get(result.awb);
      const queueSeen = perAwbSeen.get(result.awb);
      for (const threadId of result.threadIds || []) {
        if (!threadId || queueSeen.has(threadId)) continue;
        queueSeen.add(threadId);
        queue.push(threadId);
      }
    }
    for (let depth = 0; depth < perAwbMinimum && selected.length < effectiveLimit; depth += 1) {
      for (const awb of awbOrder) {
        if (selected.length >= effectiveLimit) break;
        pushThread(perAwbQueues.get(awb)?.[depth]);
      }
    }
  }
  const byQuery = (searchResults || []).map((result) => result.threadIds || []);
  for (const threadId of selectThreadIdsByQuery(byQuery, effectiveLimit)) pushThread(threadId);
  return selected;
}

function headerValue(message, name) {
  const header = (message.payload?.headers || []).find((item) => item.name?.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

function decodeBase64Url(value) {
  if (!value) return "";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeBodyText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function walkParts(part, visitor) {
  if (!part) return;
  visitor(part);
  for (const child of part.parts || []) walkParts(child, visitor);
}

function parseMessage(message) {
  const bodies = [];
  const attachments = [];
  walkParts(message.payload, (part) => {
    const mimeType = part.mimeType || "";
    const filename = part.filename || "";
    const body = part.body || {};
    if (filename || body.attachmentId) {
      const triage = classifyAttachmentTriage(`${filename} ${mimeType}`);
      const headers = part.headers || [];
      const headerValue = (name) => (headers.find((h) => String(h.name || "").toLowerCase() === name) || {}).value || "";
      const disposition = headerValue("content-disposition");
      const contentId = headerValue("content-id") || headerValue("x-attachment-id");
      // Inline images (Content-ID / disposition:inline) are email chrome — signature logos
      // and banners — not proof-of-delivery files. A real POD is an "attachment" disposition.
      const inline = /inline/i.test(disposition) || (!!contentId && !/attachment/i.test(disposition));
      attachments.push({
        attachmentId: body.attachmentId || "",
        messageId: message.id,
        filename,
        mimeType,
        size: body.size || 0,
        inline,
        kind: triage.kind,
        triageReason: triage.reason,
      });
    }
    if (body.data && /^text\/plain/i.test(mimeType)) bodies.push(decodeBase64Url(body.data));
    if (body.data && /^text\/html/i.test(mimeType)) bodies.push(stripHtml(decodeBase64Url(body.data)));
  });
  const bodyText = bodies.map(normalizeBodyText).filter(Boolean).join("\n\n");
  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId || "",
    from: headerValue(message, "from"),
    to: headerValue(message, "to"),
    cc: headerValue(message, "cc"),
    subject: headerValue(message, "subject"),
    date: headerValue(message, "date"),
    internalDate: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : "",
    snippet: message.snippet || "",
    text: bodyText || normalizeBodyText(message.snippet || ""),
    attachments,
  };
}

function base64Url(value) {
  return Buffer.from(String(value || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function splitEmailList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function addressEmail(value) {
  return String(value || "").match(/<([^>]+)>/)?.[1] || String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function addressName(value) {
  const name = String(value || "").replace(/<[^>]+>/g, "").replace(/["']/g, "").trim();
  const email = addressEmail(value);
  return name && name.toLowerCase() !== email.toLowerCase() ? name : email.split("@")[0] || "";
}

function knownBrokerNameFromEmail(email) {
  const value = String(email || "").toLowerCase();
  if (value.includes("hillcrestjfk")) return "Cedar Dispatch Customs Brokerage";
  if (value.includes("maplegi")) return "Maple Brokerage";
  if (value.includes("wwllmail") || value.includes("worldwidelogistics")) return "Meadow Logistics";
  if (value.includes("portairexpress")) return "Maple Air Express";
  if (value.includes("translinkshipping")) return "Translink Shipping";
  if (value.includes("jddirect")) return "JD Direct";
  if (value.includes("btxglobal")) return "BTX Global";
  if (value.includes("freightflex")) return "Meadow Freight";
  if (value.includes("rapidlogistics")) return "Juniper Logistics Solutions";
  if (value.includes("binationallogisticsep")) return "Rivergate Logistics ELP / Norman";
  if (value.includes("sddirect")) return "SD Direct";
  if (value.includes("tql")) return "TQL";
  return "";
}

function isPikiSender(message) {
  return /@(demo-freight\.example|harbor-forwarding\.example)|alex|jordan/i.test(message.from || "");
}

function externalRecipients(message) {
  return splitEmailList(`${message.to || ""},${message.cc || ""}`)
    .map((entry) => ({ name: addressName(entry), email: addressEmail(entry) }))
    .filter((entry) => entry.email && !/@(demo-freight\.example|harbor-forwarding\.example)$/i.test(entry.email));
}

function eventId(awb, type, message) {
  return [normalizeAwb(awb), type, message.threadId || "", message.id || ""].filter(Boolean).join(":");
}

function compactEventText(text, limit = 180) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function finalDeliveryEvidenceSnippet(text, limit = 320) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const patterns = [
    /\b(?:status\s*:\s*)?your shipment has been delivered to\b.{0,220}/i,
    /\bshipment (?:has been |was )?delivered to\b.{0,220}/i,
    /\b(?:delivery completed|completed (?:the )?delivery|delivered successfully|successfully delivered)\b.{0,220}/i,
    /\b(?:pod attached|pod received|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature)\b.{0,220}/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return compactEventText(match[0], limit);
  }
  return "";
}

function currentMessageText(text) {
  let value = normalizeBodyText(text);
  const stopPatterns = [
    /\bsignature[_-]?\d+\b/i,
    /\bOutlook[-_ ]signature\b/i,
    /\bOn\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?[\s\S]{0,220}?\bwrote:/i,
    /\b-{2,}\s*Original Message\s*-{2,}/i,
    /\b-{2,}\s*Forwarded message\s*-{2,}/i,
    /\bFrom:\s*[\s\S]{0,180}?\bSent:\s*/i,
  ];
  const stopAt = stopPatterns
    .map((pattern) => {
      const match = value.match(pattern);
      return match?.index ?? -1;
    })
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  if (stopAt) value = value.slice(0, stopAt).trim();
  const lines = value.split("\n");
  const kept = [];
  for (const line of lines) {
    if (
      /^\s*(?:On .+ wrote:|From:|Sent:|To:|Subject:|-{2,}\s*Original Message\s*-{2,}|-{2,}\s*Forwarded message\s*-{2,}|_{5,}|Best regards,?|Regards,?)/i.test(line)
    ) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return normalizeBodyText(kept.join("\n"));
}

function attachmentCanMintOperationalEvidence(item) {
  if (!item || item.kind === "trash" || item.pdfEvidence?.kind === "trash") return false;
  return String(item.pdfEvidence?.status || "").trim().toLowerCase() !== "pdf-unreadable";
}

function usefulAttachmentText(message) {
  return (message.attachments || [])
    .filter(attachmentCanMintOperationalEvidence)
    .map((item) =>
      [
        item.filename,
        item.mimeType,
        item.extractedText,
        item.pdfEvidence?.label,
        item.pdfEvidence?.note,
        item.pdfEvidence?.status,
      ].filter(Boolean).join(" ")
    )
    .join(" ");
}

function messageClassificationText(message) {
  return [
    message.subject || "",
    currentMessageText(message.text || ""),
    usefulAttachmentText(message),
  ].filter(Boolean).join(" ");
}

function messageAwbScopeText(message) {
  return [
    message.subject || "",
    currentMessageText(message.text || ""),
    usefulAttachmentText(message),
    ...(message.attachments || []).map((attachment) => attachment.filename || ""),
  ].filter(Boolean).join(" ");
}

function awbLocalText(awb, text, { currentOnly = true } = {}) {
  const value = currentOnly ? currentMessageText(text || "") : normalizeBodyText(text || "");
  const terms = awbSearchTerms(awb).filter(Boolean);
  if (!value || !terms.length) return value;
  const awbPattern = new RegExp(terms.map(escapeRegExp).join("|"), "ig");
  const matches = [...value.matchAll(awbPattern)];
  const foreignAwbs = differentAwbMentions(value, awb);
  if (!matches.length && foreignAwbs.length) return "";
  if (!foreignAwbs.length) return value;
  const chunks = [];
  const boundaries = [0];
  const separatorPattern = /(?:\r?\n|[.;]|(?=\b\d{3}[-\s]?\d{8}\b)|(?<![-/\d])(?=\b\d{8}\b))/g;
  for (const match of value.matchAll(separatorPattern)) boundaries.push(match.index);
  boundaries.push(value.length);
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  for (const match of matches) {
    const index = match.index ?? 0;
    let start = 0;
    let end = value.length;
    for (const boundary of sorted) {
      if (boundary <= index) start = boundary;
      if (boundary > index) {
        end = boundary;
        break;
      }
    }
    const fallbackStart = Math.max(0, index - 140);
    const fallbackEnd = Math.min(value.length, index + (currentOnly ? 180 : 700));
    const slice = value.slice(start, end).trim();
    chunks.push((slice && slice.length <= 360 && currentOnly ? slice : value.slice(fallbackStart, fallbackEnd)).trim());
  }
  return normalizeBodyText(chunks.filter(Boolean).join("\n"));
}

function awbLocalMessageText(awb, text) {
  return awbLocalText(awb, text, { currentOnly: true });
}

function awbLocalFullMessageText(awb, text) {
  return awbLocalText(awb, text, { currentOnly: false });
}

function messageMentionsAwb(awb, message) {
  // A different full AWB can carry the same 8-digit serial as the target. Preserve
  // genuine suffix-only shorthand, but mask non-target full candidates before matching.
  const text = maskNonExactActiveAwbCandidates(messageAwbScopeText(message), [awb]);
  return awbSearchTerms(awb).some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text));
}

function messageBelongsToAwb(awb, message, options = {}) {
  const threadAwbCount = Number(options.threadAwbCount || 1);
  return threadAwbCount <= 1 || messageMentionsAwb(awb, message);
}

function courierCloudTerminalTextForAwb(awb, message = {}, currentBody = "") {
  const body = currentMessageText(currentBody || message.text || "");
  const haystack = `${message.subject || ""}\n${body}`;
  if (!hasCourierCloudDeliveredStatusText(haystack)) return "";
  const subjectAwbs = extractMentionedAwbs(message.subject || "").map(normalizeAwb).filter(Boolean);
  const target = normalizeAwb(awb);
  if (subjectAwbs.length && !subjectAwbs.includes(target)) return "";
  return messageMentionsAwb(awb, { ...message, text: body }) ? body : "";
}

function hasPickupGroupInstructionEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  // Sibling references arrive as full AWBs, 8-digit serials, or suffixes; the actual AWB
  // resolution happens against the known active set, so the wording guard only needs an
  // AWB-shaped token (5+ digits keeps piece counts and times out).
  return /\b(?:pick\s*up|pickup|recover|recovery|inbound alert|release package|delivery order|d\/?o)\b/i.test(value) &&
    /\b(?:with|together|same|both|all|also)\b[^.;\n]{0,80}\b(?:\d{3}[-/\s]?\d{8}|\d{5,11})\b|\b(?:\d{3}[-/\s]?\d{8}|\d{5,11})\b[^.;\n]{0,80}\b(?:with|together|same|both|all|also)\b/i.test(value);
}

// Coordination wording that binds another AWB into an already-established dispatch thread
// ("Pleas arrange with 64356353", "combine with 114-80000269", "also recover 85340").
// Deliberately accepts REQUEST speech acts: an operator instruction can never mint state
// truth, but it is exactly what establishes that shipments are handled together — group
// membership is work scoping, not evidence, so it must not sit behind evidence-eligibility.
function hasGroupCoordinationInstructionEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  const awbToken = "(?:\\d{3}[-/\\s]?\\d{8}|\\d{5,11})";
  return new RegExp(
    `\\b(?:arrange|coordinate|combine|consolidate|group|handle|add|include|pick\\s*up|pickup|recover|deliver|load)\\b[^.;\\n]{0,60}\\b(?:with|together(?:\\s+with)?|along\\s+with|\\+)?\\s*(?:awb|mawb|hawb|#)?\\s*${awbToken}\\b`,
    "i",
  ).test(value) ||
    new RegExp(`\\b${awbToken}\\b[^.;\\n]{0,60}\\b(?:together|as\\s+well|same\\s+(?:truck|driver|run|pickup|delivery))\\b`, "i").test(value);
}

function hasInboundAlertDispatchPayloadEvidence(text) {
  const value = String(text || "");
  const pickupInstruction = /\b(?:inbound alert|pickup packet|please\s+(?:pick\s*up|recover)|pick\s*up with|recover with|pick\s*up asap|pickup asap|recover asap|arrange (?:pickup|recovery)|recover from|pickup from)\b/i.test(value);
  const pickupDocumentInstruction = /\b(?:delivery order|d\/?o|release package)\b/i.test(value) &&
    /\b(?:pickup|pick\s*up|recover|recovery|carrier|driver|truck|cartage|inbound alert)\b/i.test(value);
  return pickupInstruction || pickupDocumentInstruction;
}

function hasInboundAlertDispatchEvidence(text) {
  return hasInboundAlertDispatchPayloadEvidence(currentMessageText(String(text || "")));
}

function hasPikiForwardedDispatchEvidence(awb, message = {}, fullBody = "") {
  if (!isPikiSender(message) || !externalRecipients(message).length) return false;
  const subject = String(message.subject || "");
  const full = String(fullBody || message.text || "");
  const scopedFull = awbLocalFullMessageText(awb, full);
  const target = normalizeAwb(awb);
  const subjectMentionsTarget = Boolean(target) && awbSearchTerms(target).some((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(subject)
  );
  const forwardedShape = /\b(?:From|Sent|To|Subject):\s*/i.test(full) ||
    /\b(?:forwarded message|original message)\b/i.test(full) ||
    /\bFW:/i.test(subject);
  const dispatchPayload = [subject, scopedFull || full].filter(Boolean).join("\n");
  const payloadMentionsTarget = !target || awbSearchTerms(target).some((term) =>
    new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(dispatchPayload)
  );
  return forwardedShape &&
    payloadMentionsTarget &&
    (subjectMentionsTarget || /\b(?:waybill|mawb|awb|track#?)\b/i.test(dispatchPayload)) &&
    hasInboundAlertDispatchPayloadEvidence(dispatchPayload);
}

function pikiBrokerDispatchEvidenceText(awb, message = {}, currentBody = "", rawCurrentBody = "", fullBody = "") {
  const direct = [message.subject || "", currentBody || rawCurrentBody || ""].filter(Boolean).join("\n");
  if (hasInboundAlertDispatchPayloadEvidence(direct)) return direct;
  if (!hasPikiForwardedDispatchEvidence(awb, message, fullBody)) return "";
  return [
    message.subject || "",
    awbLocalFullMessageText(awb, fullBody || message.text || "") || fullBody || message.text || "",
  ].filter(Boolean).join("\n");
}

function hasBrokerAcknowledgementEvidence(text) {
  const current = currentMessageText(String(text || ""));
  const firstLine = current.split(/\n+/).map((line) => line.trim()).find(Boolean) || "";
  const value = current.replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (customsDispositionStatusBlockText(value)) return false;
  if (hasPickupConfirmedPositiveText(value) || hasPickupOnsiteEvidence(value) || hasPickupArrangementOnlyEvidence(value)) return false;
  return /^(?:received|rcvd|recv'?d|got it|copy|copied|acknowledged|confirmed|ok|okay|10-4|will do|we will|on it)[.! ]*$/i.test(firstLine) ||
    /^(?:received|rcvd|recv'?d|got it|copy|copied|acknowledged|confirmed|ok|okay|10-4|will do|we will|on it)[.! ]*$/i.test(value) ||
    /\b(?:received|acknowledged|confirmed|will do|we will handle|we can handle|on it)\b/i.test(value) &&
      !/\b(?:lines received|quantity received|payment received|pod received|release received|arrival notice received|documents received|received by|shipment received)\b/i.test(value);
}

function hasBrokerDisregardEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  return /\b(?:disregard|cancel|cancelled|canceled|do not proceed|do not pick\s*up|do not recover|stand down|please hold off|no longer needed|awarded to another|we went with another|remove this|ignore this)\b/i.test(value) ||
    /(?:לבטל|ביטול|אל תתקדמ|לא להתקדמ|לא לאסופ)/.test(normalizedHebrewLogisticsText(value));
}

function pickupThreadContextLooksActive(message = {}, threadContext = "") {
  return hasPickupThreadContext(message, threadContext) ||
    hasInboundAlertDispatchEvidence(`${message.subject || ""}\n${threadContext || ""}`);
}

function pickupBrokerAcknowledgementContextLooksActive(message = {}, threadContext = "") {
  const context = `${threadContext || ""}\n${message.subject || ""}`;
  return /\b(?:pickup|pick up|recover|recovery|inbound alert|recover from|cartage|carrier|driver|truck|load|loading)\b/i.test(context) ||
    hasInboundAlertDispatchEvidence(context);
}

function inferPickupThreadGroupScope(awb, thread, options = {}) {
  const target = normalizeAwb(awb);
  if (!target) return null;
  const rawMessages = (thread.messages || []).slice().sort((a, b) => Date.parse(a.internalDate || "") - Date.parse(b.internalDate || ""));
  // Suffix-only sibling references resolve against the known active AWB set, so a pickup
  // instruction like "85336 and 85340 go together" links the real siblings.
  const knownAwbs = options.knownAwbs || [];
  const subjectAwbs = extractMentionedAwbsWithKnown(rawMessages.map((message) => message.subject || "").join("\n"), knownAwbs);
  const directThreadAwbs = extractMentionedAwbsWithKnown(rawMessages.map((message) => messageAwbScopeText(message)).join("\n"), knownAwbs);
  const threadAwbs = new Set([...subjectAwbs, ...directThreadAwbs]);
  let groupAwbs = new Set([target]);
  let groupInstructionAt = 0;
  let groupInstructionMessageId = "";
  let groupBroker = null;
  // Workgroup establishment can be SPLIT across messages: the opening Piki forward carries
  // the dispatch semantics (often subject-only — the body is the forwarded block) and a
  // later Piki instruction binds the sibling ("Pleas arrange with 64356353"). Track whether
  // the thread is dispatch-established so the binding message does not have to restate the
  // pickup wording (INC-2026-07-06-THREAD-WORKGROUP-POD-EVIDENCE).
  let threadDispatchEstablishedAt = 0;
  for (const message of rawMessages) {
    const scopeText = messageAwbScopeText(message);
    const current = currentMessageText(message.text || "");
    const mentioned = extractMentionedAwbsWithKnown(scopeText, knownAwbs);
    const targetMentioned = mentioned.includes(target);
    const instructionAwbs = new Set([...subjectAwbs, ...mentioned]);
    if (
      isPikiSender(message) &&
      instructionAwbs.has(target) &&
      instructionAwbs.size > 1 &&
      (hasPickupGroupInstructionEvidence(current) || hasInboundAlertDispatchEvidence(current))
    ) {
      groupAwbs = instructionAwbs;
      groupInstructionAt = Date.parse(message.internalDate || "") || 0;
      groupInstructionMessageId = message.id || "";
      groupBroker = inferBrokerFromMessage(message);
    } else if (
      isPikiSender(message) &&
      threadDispatchEstablishedAt &&
      instructionAwbs.has(target) &&
      instructionAwbs.size > 1 &&
      hasGroupCoordinationInstructionEvidence(current)
    ) {
      // Group extension inside an established dispatch thread: a Piki-side coordination
      // instruction naming additional known AWBs in CURRENT text (quoted history never
      // establishes — currentMessageText already stripped it) extends the workgroup even
      // though the message repeats no pickup keyword; the thread context carries those
      // semantics. Requests are valid here by design: instructions create workgroups,
      // they just never mint state truth.
      groupAwbs = new Set([...groupAwbs, ...instructionAwbs]);
      groupInstructionAt = Date.parse(message.internalDate || "") || threadDispatchEstablishedAt;
      groupInstructionMessageId = message.id || "";
      groupBroker = groupBroker || inferBrokerFromMessage(message);
    } else if (
      isPikiSender(message) &&
      targetMentioned &&
      hasInboundAlertDispatchEvidence(current) &&
      (externalRecipients(message).length || subjectAwbs.includes(target))
    ) {
      groupInstructionAt = groupInstructionAt || Date.parse(message.internalDate || "") || 0;
      groupInstructionMessageId = groupInstructionMessageId || message.id || "";
      groupBroker = groupBroker || inferBrokerFromMessage(message);
    }
    if (
      isPikiSender(message) &&
      externalRecipients(message).length &&
      // Dispatch establishment is a THREAD property, not a target property: the opening
      // forward makes this a dispatch thread even for a sibling the forward never names
      // (the sibling gets bound by a later coordination instruction). Passing an empty
      // AWB checks the forwarded payload's dispatch shape without a target-mention gate.
      (hasInboundAlertDispatchEvidence(current) || hasPikiForwardedDispatchEvidence("", message, message.text || ""))
    ) {
      threadDispatchEstablishedAt = threadDispatchEstablishedAt || Date.parse(message.internalDate || "") || 0;
    }
  }
  const hasMultiAwbGroup = groupAwbs.has(target) && groupAwbs.size > 1;
  if (!groupInstructionAt && !hasMultiAwbGroup) return null;
  const brokerId = brokerIdentity(groupBroker?.email || groupBroker?.broker || "");
  const applies = (message) => {
    if (messageBelongsToAwb(awb, message, options)) return true;
    if (!hasMultiAwbGroup) return false;
    const messageTime = Date.parse(message.internalDate || "") || 0;
    if (groupInstructionAt && messageTime < groupInstructionAt) return false;
    const current = currentMessageText(message.text || "");
    const mentioned = extractMentionedAwbsWithKnown(messageAwbScopeText(message), knownAwbs);
    if (mentioned.some((item) => !groupAwbs.has(item))) return false;
    if (isPikiSender(message)) return hasBrokerDisregardEvidence(current) || hasInboundAlertDispatchEvidence(current);
    const fromBroker = inferBrokerFromMessage(message);
    const fromId = brokerIdentity(fromBroker.email || fromBroker.broker || "");
    return Boolean(!brokerId || !fromId || brokerId === fromId || brokerId.includes(fromId) || fromId.includes(brokerId));
  };
  return {
    groupAwbs: [...groupAwbs],
    groupInstructionAt,
    groupInstructionMessageId,
    broker: groupBroker || null,
    applies,
  };
}

function normalizedHebrewLogisticsText(value) {
  const raw = String(value || "");
  if (!/[\u0590-\u05FF]/.test(raw)) return "";
  return raw
    .replace(/[ך]/g, "כ")
    .replace(/[ם]/g, "מ")
    .replace(/[ן]/g, "נ")
    .replace(/[ף]/g, "פ")
    .replace(/[ץ]/g, "צ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasHebrewPickupFutureOrNegativeEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:^|[\s.,;:])(?:לא|טרמ|עדיינ לא|בלי|חסר)(?:$|[\s.,;:]).{0,24}(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ)|(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ).{0,24}(?:לא|טרמ|עדיינ|חסר|ממתינ|בהמתנה)/.test(value) ||
    /(?:יאספ|ייאספ|להיאספ|אמור להיאספ|צפוי להיאספ|מתוכננ.{0,20}איסופ|בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|נהג בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|איסופ מחר|יאספו|ייאספו)/.test(value);
}

function hasHebrewPickupConfirmedEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value || hasHebrewPickupFutureOrNegativeEvidence(value)) return false;
  if (/המטענ.{0,12}המריא|פרי אלרט|פריאלרט|תעבירו/.test(value)) return false;
  return /(?:נהג|הנהג|משאית|המשאית|טרק|הטרק).{0,36}(?:אספ|לקח|העמיס|נטענ)|(?:מטענ|המשלוח|סחורה|קרגו|משטח).{0,36}(?:נאספ|נאספה|נאספו|נלקח|הועמס|נטענ)|(?:נאספ|נאספה|נאספו|נלקח|הועמס|נטענ).{0,56}(?:מהתחנה|מהמסופ|מהקרגו|מהמחסנ|משדה|מהשדה|מהאיירפורט)|(?:יצא|יצאה|יצאו).{0,28}(?:מהתחנה|מהמסופ|מהקרגו|מהמחסנ).{0,36}(?:למסירה|ללקוח|בדרכ|עם הנהג)|(?:^|[\s.,;:])נאספ(?:ה|ו)?(?:$|[\s.,;:])/.test(value);
}

function hasHebrewDeliveryScheduledEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  if (/(?:לא|טרמ|עדיינ לא).{0,24}(?:ימסר|יימסר|מסירה|להימסר)/.test(value)) return false;
  return /(?:ימסר|יימסר|תימסר|תמסר|ימסור|יימסור|להימסר).{0,36}(?:מחר|היומ|בהמשכ|בבוקר|אחר הצהריימ)|(?:נמסר).{0,24}מחר|מחר.{0,24}(?:נמסר)|(?:מסירה|המסירה).{0,36}(?:מחר|היומ|מתוכננת|מתוכננ|צפויה|צפוי)|(?:צפוי|אמור|מתוכננ).{0,40}(?:להימסר|מסירה)/.test(value);
}

function hasHebrewDeliveredNegativeEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:לא|טרמ|עדיינ לא|בלי).{0,28}(?:נמסר|מסירה|נפרק)|(?:נמסר|מסירה|נפרק).{0,28}(?:לא|טרמ|עדיינ|חסר|ממתינ|בהמתנה)/.test(value);
}

function hasHebrewDeliveredReportedEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value || hasHebrewDeliveredNegativeEvidence(value) || hasHebrewDeliveryScheduledEvidence(value)) return false;
  return /(?:משלוח|המטענ|סחורה|קרגו).{0,36}(?:נמסר|נפרק)|(?:נמסר|נמסרה|נמסרו).{0,48}(?:ללקוח|למקבל|לנמען|בכתובת|אצל)|(?:מסירה|המסירה).{0,24}(?:בוצעה|הושלמה|הסתיימה)|(?:בוצעה|הושלמה).{0,24}מסירה/.test(value);
}

function hasHebrewPodPendingEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:אינ|אין|חסר|חסרה|טרמ התקבל|עדיינ לא התקבל|ממתינ ל|לא רואה).{0,24}(?:pod|פוד|תעודת מסירה|אישור מסירה)|(?:pod|פוד|תעודת מסירה|אישור מסירה).{0,36}(?:חסר|חסרה|בהמשכ|יישלח|ישלח|נשלח בהמשכ|טרמ|עדיינ לא|ממתינ|בהמתנה|לא רואה)/i.test(value);
}

function hasHebrewStorageOrDetentionEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  if (hasHebrewCargoNotFoundEvidence(value)) return false;
  return /(?:אחסנה|אחסונ|דמי אחסנה|זמנ המתנה|זמן המתנה|תוספת חיוב).{0,60}(?:\$|\d|חיוב|עלות|שעה|שעות|פר שעה)?|(?:המתינ|המתינה|המתינו).{0,60}(?:שעה|שעות|\d|חיוב|תוספת|מסופ|טרמינל)|(?:\$|\d).{0,40}(?:אחסנה|זמנ המתנה|זמן המתנה)/.test(value);
}

function hasHebrewCargoNotFoundEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:לא|אינ|אין|טרמ|עדיינ לא).{0,28}(?:מוצאימ|מצאנו|מצאו|נמצא|נמצאה|נמצאו|מאתרימ|איתרו).{0,36}(?:מטענ|המשלוח|סחורה|קרגו)|(?:מטענ|המשלוח|סחורה|קרגו).{0,36}(?:לא נמצא|לא נמצאה|לא נמצאו|לא מוצאימ|חסר|חסרה|missing)|(?:נהג|הנהג).{0,60}(?:לא מוצאימ|לא מצאו|מטענ חסר|load is missing)/i.test(value);
}

function hasHebrewOperationalBlockerEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:בעיית שידור|בעיה שידור|כמות חבילות|כמות חלקימ|כמות יחידות|מבטל.{0,24}entry|לבטל.{0,24}entry|צריך.{0,32}לבטל.{0,20}entry|nominate|נומינייט|לא מראה שחרור|לא רואימ שחרור|שחרור לא מופיע|לא תואמ).{0,80}/i.test(value);
}

function hasHebrewPodReceivedEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value || hasHebrewPodPendingEvidence(value)) return false;
  return /(?:מצורפ|מצורפת|צורפ|צירפתי|שלחתי|התקבל).{0,48}(?:pod|פוד|תעודת מסירה|אישור מסירה)|(?:pod|פוד|תעודת מסירה|אישור מסירה).{0,56}(?:מצורפ|צורפ|התקבל|חתומ|חתומה|חתימ)|(?:חתומ|חתומה|חתימ).{0,32}(?:pod|פוד|תעודת מסירה|אישור מסירה)/i.test(value);
}

function hasHebrewArrivalPositiveEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  if (/המטענ.{0,12}המריא|(?:לא|טרמ|עדיינ לא|ממתינ|מחכה|צריך|צריכ|ביקש|מבקש).{0,28}(?:הגיע|הגעה|הודעת הגעה|זמינ|אונ האנד|on hand)/i.test(value)) return false;
  return /(?:הודעת הגעה|נוטיס אוף ארייבל|אונ האנד|on hand)|(?:הגיע|הגיעה|הגיעו).{0,32}(?:לתחנה|למסופ|לקרגו|למחסנ|לשדה|לאיירפורט|ל[A-Z]{3})|(?:זמינ|זמינה|זמינימ).{0,24}(?:לאיסופ|pickup|פיקאפ)|(?:נמצא|נמצאת).{0,28}(?:בתחנה|במסופ|בקרגו|במחסנ)/i.test(value);
}

function hasHebrewCustomsReleaseNegativeEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value) return false;
  return /(?:לא|טרמ|עדיינ לא|אינ|אין|חסר).{0,32}(?:שחרור|שוחרר|מכס|דו|d\/?o|delivery order)|(?:שחרור|מכס|דו|d\/?o|delivery order).{0,32}(?:חסר|לא התקבל|טרמ|עדיינ לא|בהמתנה)/i.test(value);
}

function hasHebrewCustomsReleasePositiveEvidence(text) {
  const value = normalizedHebrewLogisticsText(text);
  if (!value || hasHebrewCustomsReleaseNegativeEvidence(value)) return false;
  return /(?:שוחרר|שוחררה|שוחררו).{0,28}(?:מהמכס|ממכס|ע"י מכס)|(?:שחרור|שחרור מכס|אישור מכס).{0,36}(?:התקבל|קיבלנו|מצורפ|אושר|בוצע)|(?:קיבלנו|התקבל|אושר).{0,32}(?:שחרור|אישור מכס|customs release|d\/?o|delivery order)/i.test(value);
}

function hasDeliveryScheduledEvidence(text) {
  const value = String(text || "");
  return /\b(?:will deliver|delivery tomorrow|deliver tomorrow|scheduled (?:for )?delivery|out for delivery|delivering today)\b/i.test(value) ||
    hasHebrewDeliveryScheduledEvidence(value);
}

function hasTerseDeliveryScheduleReplyEvidence(text, threadContext = "") {
  const current = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!current) return false;
  const affirmativeTimeReply = /^(?:yes|yeah|yep|correct|confirmed|confirm|ok|okay|sure)[,.\s-]*(?:tomorrow(?:\s+morning|\s+afternoon|\s+evening)?|today(?:\s+morning|\s+afternoon|\s+evening)?|this\s+(?:morning|afternoon|evening))\.?$/i.test(current);
  if (!affirmativeTimeReply) return false;
  return /\b(?:deliver|delivery|drop[-\s]?off|consignee|receiver)\b[^?\n]{0,120}\b(?:tomorrow|today|this\s+(?:morning|afternoon|evening))\b/i.test(threadContext);
}

function hasPodPendingEvidence(text) {
  const value = String(text || "");
  if (hasWrongConsigneeDeliveryEvidence(value)) return false;
  return /\b(?:pod pending|pod needed|pod missing|no pod|without pod|await(?:ing)? pod|proof of delivery pending|delivery proof missing|pod to follow|pod will follow|pod follows|will send (?:the )?pod|send (?:the )?pod (?:as soon|later|shortly)|driver will send (?:the )?pod|pod (?:is )?(?:still )?(?:pending|not available|not ready))\b/i.test(value) ||
    /\bwaiting for\b[^.;\n]{0,80}\bsend\b[^.;\n]{0,40}\b(?:pod|proof of delivery|signed pod)\b/i.test(value) ||
    hasHebrewPodPendingEvidence(value);
}

function hasTerseDeliveredPodEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (hasDeliveredNegativeEvidence(value)) return false;
  if (hasFutureOrConditionalDeliveryEvidence(value)) return false;
  if (hasStationPaymentDeliveryOnlyEvidence(value)) return false;
  // Delivery and POD are separate claims. A sentence may truthfully report final
  // delivery while promising the POD later ("delivered ... will send POD after
  // unloading"). The broad terse matcher below must never turn that future POD
  // clause into receipt merely because both words occur in one sentence.
  if (hasPodPendingEvidence(value)) return false;
  if (/\b(?:pod|p\.?\s*o\.?\s*d\.?)\b[^.;\n]{0,40}\b(?:to follow|will follow|later|shortly|pending|not ready|not available)\b/i.test(value)) return false;
  return /\bdelivered\b\s*(?:[-–—:;,.\/]|\s+)?\s*(?:with\s+)?(?:signed\s+)?(?:pod|p\.?\s*o\.?\s*d\.?)\b(?:\s+(?:to|by|for)?\s*[A-Z][A-Za-z .'-]{1,40})?(?:\s+(?:at\s*)?\d{1,2}:?\d{2}\b)?/i.test(value) ||
    /\bdelivered\b[^.;\n]{0,50}\b(?:pod|p\.?\s*o\.?\s*d\.?)\b[^.;\n]{0,80}\b(?:signed|received|receiver|[A-Z][A-Za-z .'-]{1,40}|\d{1,2}:?\d{2})\b/i.test(value);
}

function hasStationFacilityArrivalReceiptEvidence(text) {
  const value = String(text || "");
  if (!value) return false;
  const finalDeliveryContext = /\b(?:pods?\s+(?:are\s+)?attached|pods?\s+(?:were\s+)?(?:found|received|provided|uploaded)|pod\s+found|pod\s+received|attached\s+pod|attached\s+is\s+(?:the\s+)?pod|proofs?\s+of\s+delivery|delivered(?:\s+successfully)?|successfully\s+delivered|delivered\s+to|delivery\s+completed|completed\s+(?:the\s+)?delivery|drop[-\s]?off|final\s+delivery|signed\s+pod|signed\s+delivery\s+receipt|receiver\s+signature|consignee\s+received)\b/i.test(value);
  if (finalDeliveryContext) return false;
  const facilityArrival =
    /\barrived\s*:\s*destination\s+facility\b/i.test(value) ||
    /\barrived\b[^.;\n]{0,80}\b(?:destination\s+facility|destination\s+station|airport\s+facility|station|terminal|handler|warehouse)\b/i.test(value);
  const stationStatusBlock =
    /\bstatus\s*:\s*[A-Z]{3}\b/i.test(value) &&
    (
      /\bmanifest\s*#?\s*:?\s*[A-Z0-9-]+\b/i.test(value) ||
      (/\bweight\s*:\s*\d/i.test(value) && /\bpieces\s*:\s*\d/i.test(value))
    );
  const handlerSignature = /\b(?:signed|received)\s+by\s*:?\s*[A-Z][A-Za-z .'-]{1,40}\b/i.test(value);
  return Boolean(facilityArrival && stationStatusBlock && handlerSignature);
}

function hasPodReceivedEvidence(text) {
  if (!evidenceEligible(String(text || ""), "delivery")) return false;
  const value = String(text || "");
  if (hasWrongConsigneeDeliveryEvidence(value)) return false;
  if (hasStationFacilityArrivalReceiptEvidence(value)) return false;
  if (hasTerseDeliveredPodEvidence(value)) return true;
  if (hasHebrewPodPendingEvidence(value)) return false;
  const poaSignatureOnly =
    /\b(?:poa|power of attorney)\b[^.;\n]{0,120}\bsign(?:ed|ature)?\b/i.test(value) ||
    /\bsign(?:ed|ature)?\b[^.;\n]{0,120}\b(?:poa|power of attorney)\b/i.test(value);
  if (
    poaSignatureOnly &&
    !/\b(?:pods?\s+(?:are\s+)?attached|pod found|pod received|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|delivery completed|delivered successfully|successfully delivered|delivered to)\b/i.test(value)
  ) return false;
  if (/\b(?:collect|get|request|ask|follow up|follow-up|send|will send|waiting for|need|needs|needed)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed pod)\b/i.test(value)) return false;
  // Inability/negation is the OPPOSITE of provision: "I don't see the POD", "unable to
  // find the POD", "please resend the POD", "POD is missing". This MUST run before the
  // provision matcher below, which would otherwise read "see/find … POD" as delivery
  // (INC-2026-07-12b follow-up: the provision clause had no negation look-back).
  if (
    /\b(?:do(?:es)?\s*n'?t|do not|does not|can\s*not|can'?t|could\s*n'?t|did\s*n'?t|have\s*n'?t|has\s*n'?t|had\s*n'?t|unable to|failed to|never|not)\b[^.;\n]{0,30}\b(?:see|find|locate|receiv\w*|get|got|have|attach\w*)\b[^.;\n]{0,30}\b(?:pod|proof of delivery|delivery receipt)\b/i.test(value) ||
    /\b(?:pods?|proof of delivery|delivery receipt)\b[^.;\n]{0,30}\b(?:missing|not (?:attached|received|here|found|available)|never (?:sent|received|attached))\b/i.test(value) ||
    /\b(?:re[-\s]?send|resend|send (?:it |the pod |them )?again)\b[^.;\n]{0,25}\b(?:pod|proof of delivery)\b/i.test(value) ||
    /\b(?:pod|proof of delivery)\b[^.;\n]{0,25}\b(?:again\b|re[-\s]?send|resend)\b/i.test(value)
  ) return false;
  // A sender who is PROVIDING the POD is asserting delivery in their own words —
  // "please see POD", "see attached POD", "here is the POD", "POD is enclosed/below".
  // The literal-verb lists below ("attached/found/received/provided/uploaded") missed
  // the whole provision class (INC-2026-07-12b: 016-80000091 "Please see POD" landed as
  // pod-attachment-unverified because the POD came as an unreadable image and no wording
  // matched). The request/pending filter above already excludes "collect/need/send POD",
  // so this is provision, not a to-do. It counts even when the attached POD is an
  // unreadable image, because the human's statement — not the pixels — is the evidence.
  if (
    /\b(?:please\s+)?(?:see|find|sharing|enclosing|here\s+(?:is|are))\s+(?:the\s+|an?\s+|your\s+|our\s+|attached\s+|enclosed\s+|signed\s+)*(?:pods?|proof of delivery|delivery receipt|signed (?:pod|delivery receipt|bol))\b/i.test(value) ||
    /\b(?:pods?|proof of delivery|delivery receipt)\b\s+(?:is|are)\s+(?:attached|enclosed|below|here)\b/i.test(value)
  ) return true;
  return /\b(?:pods?\s+(?:are\s+)?attached|pods?\s+(?:were\s+)?(?:found|received|provided|uploaded)|attached\s+(?:are\s+)?(?:the\s+)?pods?|provided\s+(?:the\s+)?pods?|uploaded\s+(?:the\s+)?pods?|empty\s+pods?\s+attached|pod found|pod received|attached pod|attached is (?:the )?pod|proof of delivery attached|proofs? of delivery attached|proof of delivery received|signed pod|signed delivery receipt|signed by|received by|receiver signature|delivered with pod|pod is attached)\b/i.test(value) ||
    hasHebrewPodReceivedEvidence(value);
}

function hasWrongConsigneeDeliveryEvidence(text) {
  return WRONG_CONSIGNEE_DELIVERY_PATTERN.test(String(text || ""));
}

function hasDeliveredReportedEvidence(text) {
  if (!evidenceEligible(String(text || ""), "delivery")) return false;
  const value = String(text || "");
  if (hasWrongConsigneeDeliveryEvidence(value)) return false;
  if (hasDeliveredNegativeEvidence(value)) return false;
  if (hasFutureOrConditionalDeliveryEvidence(value)) return false;
  if (hasStationPaymentDeliveryOnlyEvidence(value)) return false;
  const offloadedWithPodContext = /\b(?:offloaded|unloaded)\b[^.;\n]{0,80}\b(?:cargo|freight|shipment)\b/i.test(value) &&
    /\b(?:pod|proof of delivery|signed)\b/i.test(value);
  return /\b(?:(?:shipment|freight|load|cargo) (?:has been |was |is )?(?:successfully )?delivered|delivered successfully|successfully delivered|delivered to|deliver was completed|delivery completed|completed (?:the )?delivery|was delivered)\b/i.test(value) ||
    /\b(?:all\s+)?\d+\s*(?:pcs?|pieces?)\s+(?:have been |were |are )?(?:successfully )?delivered\b/i.test(value) ||
    hasTerseDeliveredPodEvidence(value) ||
    offloadedWithPodContext ||
    hasHebrewDeliveredReportedEvidence(value);
}

function hasStationPaymentDeliveryOnlyEvidence(text) {
  const value = String(text || "");
  if (/\b(?:shipment|freight|cargo|load)\b[^.;\n]{0,80}\bdelivered\b|\b(?:delivery completed|completed (?:the )?delivery)\b/i.test(value)) return false;
  return /\byour payment has been delivered to\b/i.test(value) ||
    /\bpayment (?:has been )?delivered(?:\s+to|\s+for)?\b/i.test(value) ||
    (
      /\b(?:cargosprint|cargo sprint|station payment|ground handling payment|terminal payment|amount paid|reference number)\b/i.test(value) &&
      /\bdelivered to\b/i.test(value) &&
      /\b(?:airlines?|airways?|worldwide flight services|\bwfs\b|station|terminal|building|c\/o)\b/i.test(value)
    );
}

function hasDeliveredNegativeEvidence(text) {
  const value = String(text || "");
  return /\b(?:not|never|no|hasn'?t|haven'?t|have not|has not)\b[^.;\n]{0,80}\b(?:delivered|delivery completed|completed delivery)\b/i.test(value) ||
    /\b(?:delivery|delivered)\b[^.;\n]{0,80}\b(?:pending|not complete|not completed|not done|not yet|still needed|still pending)\b/i.test(value) ||
    hasHebrewDeliveredNegativeEvidence(value);
}

function hasFutureOrConditionalDeliveryEvidence(text) {
  const value = String(text || "");
  return /\b(?:will deliver|will be delivered|will get delivered|delivery tomorrow|scheduled (?:for )?delivery|out for delivery|delivering today)\b/i.test(value) ||
    /\b(?:to be|expected to be|scheduled to be|going to be|planned to be)\b[^.;\n]{0,80}\bdelivered\b/i.test(value) ||
    /\bdelivery\b[^.;\n]{0,60}\b(?:scheduled|planned|expected)\b/i.test(value) ||
    /\b(?:once|when|if|after|until|upon|before|as soon as)\b[^.;\n]{0,120}\b(?:shipment|freight|cargo|it|load)?\b[^.;\n]{0,30}\b(?:is |has been |was |gets? )?delivered\b/i.test(value) ||
    /\b(?:once|when|if|after|until|upon|before|as soon as)\b[^.;\n]{0,120}\bdelivery\b/i.test(value) ||
    /\b(?:keep|hold)\b[^.;\n]{0,120}\b(?:accessible|intact|available)\b[^.;\n]{0,120}\b(?:once|when|after|until)\b[^.;\n]{0,120}\b(?:delivered|delivery)\b/i.test(value) ||
    hasHebrewDeliveryScheduledEvidence(value) ||
    /(?:ברגע|כאשר|כש|אם|אחרי|לאחר|עד).{0,80}(?:ימסר|יימסר|נמסר|מסירה|להימסר)/.test(normalizedHebrewLogisticsText(value));
}

function hasCourierCloudDeliveredStatusText(text) {
  const value = String(text || "");
  if (hasWrongConsigneeDeliveryEvidence(value)) return false;
  if (hasStationPaymentDeliveryOnlyEvidence(value)) return false;
  return /(?:\b(?:courier\s*cloud|couriercloud|demo operations inc\.?\s*-\s*track#|track#\s*:?\s*\d{3}[-\s]?\d{8}|status update)\b|\bstatus\s*:)/i.test(value) &&
    /\byour shipment has been delivered to\b|\bshipment (?:has been |was )?delivered to\b/i.test(value);
}

function hasPqAcceptedPodEvidence(text, message) {
  const from = String(message?.from || "");
  const value = String(text || "");
  return (/(?:operations|status).+@demo-freight\.example|@demo-freight\.example/i.test(from) ||
      /\b(?:courier\s*cloud|couriercloud|demo operations inc\.?)\b/i.test(value)) &&
    hasCourierCloudDeliveredStatusText(value);
}

function podAttachmentHasFinalProof(attachment) {
  if (!attachmentCanMintOperationalEvidence(attachment)) return false;
  const filename = String(attachment.filename || "");
  const extracted = [
    attachment.extractedText,
    attachment.pdfEvidence?.textPreview,
  ].filter(Boolean).join(" ");
  if (hasStationFacilityArrivalReceiptEvidence(`${filename} ${extracted}`)) return false;
  const explicitFilename = /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery[-\s]?receipt)\b/i.test(filename);
  const explicitText = /\b(?:pod attached|attached is (?:the )?pod|pod received|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|delivery completed|delivered successfully|successfully delivered)\b/i.test(extracted) ||
    /\b(?:signed by|received by)\s+[A-Za-z][A-Za-z .'-]{1,40}\b/i.test(extracted);
  const poaInstructionOnly = /\b(?:poa|power of attorney)\b/i.test(`${filename} ${extracted}`) &&
    !explicitFilename &&
    !/\b(?:pod attached|pod received|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|delivery completed|delivered successfully|successfully delivered|delivered to)\b/i.test(extracted);
  if (poaInstructionOnly) return false;
  const instructionOnly = /\b(?:pre[-\s]?alert|full set of documents|clearance instructions|contact consignee|delivery order|d\/?o\b|deliver to|ship to|shipment detail|poa|power of attorney)\b/i.test(`${filename} ${extracted}`) &&
    !explicitFilename &&
    !explicitText;
  return (explicitFilename || explicitText) && !instructionOnly;
}

function hasUsefulPodAttachment(message) {
  return (message.attachments || []).some((item) => {
    return podAttachmentHasFinalProof(item);
  });
}

// POD-class attachment that could NOT be verified: named like a POD (or an image sent in a
// delivery/pickup context) but with no extractable text and no explicit POD wording. These
// must surface for human review instead of disappearing from truth.
function hasUnverifiedPodClassAttachment(message = {}) {
  const text = String(message.text || "");
  const deliveryContext = /\b(?:pod|proof of delivery|deliver(?:y|ed)?|drop(?:ped)? off|signed|receipt)\b/i.test(`${message.subject || ""} ${text}`);
  return (message.attachments || []).some((attachment) => {
    if (!attachment || attachment.kind === "trash") return false;
    if (podAttachmentHasFinalProof(attachment)) return false;
    const filename = String(attachment.filename || "");
    const mimeType = String(attachment.mimeType || "");
    const podNamed = /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery[-\s]?receipt)\b/i.test(filename);
    const image = /^image\//i.test(mimeType) || /\.(?:heic|heif|jpe?g|png)$/i.test(filename);
    if (podNamed) return true;
    return image && deliveryContext;
  });
}

// POD-class files for group-assignment arithmetic: phone photos (the HEIC/JPEG class),
// POD-named files, and attachments whose extracted text already proves final delivery.
// Deliberately excludes generic PDFs so an invoice riding along never inflates the count.
function podClassAttachmentCount(message = {}) {
  return (message.attachments || []).filter((attachment) => {
    if (!attachment || attachment.kind === "trash") return false;
    const filename = String(attachment.filename || "");
    const mimeType = String(attachment.mimeType || "");
    return /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery[-\s]?receipt)\b/i.test(filename) ||
      /^image\//i.test(mimeType) ||
      /\.(?:heic|heif|jpe?g|png)$/i.test(filename) ||
      podAttachmentHasFinalProof(attachment);
  }).length;
}

function hasPluralPodWording(text) {
  return /\b(?:pods|p\.?o\.?d\.?'?s|proofs\s+of\s+delivery|empty\s+pods)\b/i.test(String(text || ""));
}

function hasPickupArrangementOnlyEvidence(text) {
  const value = String(text || "");
  if (/\b(?:driver (?:is )?(?:now )?loaded|driver loaded|(?:was|has been|got)\s+picked\s+(?:it\s+)?up|picked\s+(?:it\s+)?up\s+already|recovered from|recovery complete|pickup complete|loaded and will deliver|loaded and (?:is )?(?:en route|rolling)|loaded as of)\b/i.test(value)) {
    return false;
  }
  return /\b(?:can|could|will|would|should|able to|available to|going to|scheduled to|planning to|plan to|trying to|try to|need to|needs to|set up to|arrange to)\b[^.;\n]{0,90}\b(?:get\s+)?(?:pick(?:ed)?\s*up|pickup|recover(?:ed)?|recovery|load(?:ed)?)\b/i.test(value) ||
    /\b(?:do you have|can you send|please send|need|needs|needed|provide)\b[^.;\n]{0,100}\b(?:pickup location|pick[-\s]?up location|delivery order|d\/?o|remaining docs?|necessary docs?|release package)\b/i.test(value);
}

function hasPickupThreadContext(message = {}, threadContext = "") {
  const context = `${threadContext || ""}\n${message.subject || ""}`;
  return /\b(?:pickup|pick up|recover|recovery|inbound alert|recover from|cartage|delivery order|d\/?o|release package|carrier)\b/i.test(context);
}

function hasFuturePickupScheduleText(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (hasPickupConfirmedPositiveText(value) || hasPickupOnsiteEvidence(value)) return false;
  const explicitPickup =
    /\b(?:pickup|pick up|recover|recovery|load|loading)\b[^.;\n]{0,120}\b(?:today|tonight|tomorrow|tomorrow morning|tomorrow afternoon|this morning|this afternoon|this evening|later today)\b/i.test(value) ||
    /\b(?:today|tonight|tomorrow|tomorrow morning|tomorrow afternoon|this morning|this afternoon|this evening|later today)\b[^.;\n]{0,120}\b(?:pickup|pick up|recover|recovery|load|loading)\b/i.test(value);
  const plannedAttempt =
    /\b(?:i\s*(?:will|[’']ll)|we\s*(?:will|[’']ll)|will|can|could|should|planning|plan|scheduled|schedule|trying|try|attempt|able)\b[^.;\n]{0,100}\b(?:today|tonight|tomorrow|tomorrow morning|tomorrow afternoon|this morning|this afternoon|this evening|later today)\b/i.test(value);
  const partialArrival =
    /\b\d+\s*(?:pcs?|pieces?|pallets?|skids?)\b[^.;\n]{0,90}\b(?:arriv(?:e|ing|al)|coming|due)\b[^.;\n]{0,70}\b(?:today|tonight|tomorrow|tomorrow morning|this evening)\b/i.test(value) ||
    /\b(?:arriv(?:e|ing|al)|coming|due)\b[^.;\n]{0,90}\b\d+\s*(?:pcs?|pieces?|pallets?|skids?)\b[^.;\n]{0,70}\b(?:today|tonight|tomorrow|tomorrow morning|this evening)?\b/i.test(value);
  return explicitPickup || plannedAttempt && partialArrival || /\b(?:i\s*(?:will|[’']ll)|we\s*(?:will|[’']ll)|try|attempt)\b[^.;\n]{0,70}\btomorrow\b/i.test(value);
}

function hasPickupScheduledEvidence(text, message = {}, threadContext = "") {
  if (isPikiSender(message)) return false;
  return hasPickupThreadContext(message, threadContext) && hasFuturePickupScheduleText(text);
}

function hasContextualPickupScheduleReplyEvidence(text, message = {}, threadContext = "") {
  const currentText = currentMessageText(String(text || ""));
  const current = currentText.replace(/\s+/g, " ").trim();
  const firstLine = currentText.split(/\n+/).map((line) => line.trim()).find(Boolean) || "";
  const context = String(threadContext || "");
  const loadScheduleQuestion = /\bwhen\s+should\s+we\s+load\b/i.test(context) &&
    /\bdeliver(?:y)?\b[^?\n]{0,80}\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\d{1,2}[/-]\d{1,2})\b/i.test(context);
  if (!loadScheduleQuestion) return false;
  if (/^(?:i\s+think\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)(?:\s+is\s+best)?[.! ]*$/i.test(current)) {
    return true;
  }
  return !isPikiSender(message) && /^(?:10-4|received|got it|ok|okay|will do)[.! ]*$/i.test(firstLine) &&
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\s+is\s+best\b/i.test(context);
}

function hasPickupConfirmedPositiveText(text) {
  const value = String(text || "");
  const negatedOrFuturePickup =
    /\b(?:not|no|never|pending|requested|scheduled|will|can|could|should|try|trying|attempt|awaiting|waiting|checking|hold|blocked|cannot|can't|won't)\b[^.;\n]{0,90}\b(?:pick(?:ed)?\s*up|pickup|recover(?:ed)?|recovery|load(?:ed)?)\b/i.test(value) ||
    /\b(?:pick(?:ed)?\s*up|pickup|recover(?:ed)?|recovery|load(?:ed)?)\b[^.;\n]{0,90}\b(?:not|no|never|pending|requested|scheduled|will|can|could|should|try|trying|attempt|awaiting|waiting|checking|hold|blocked|cannot|can't|won't)\b/i.test(value);
  if (negatedOrFuturePickup) return false;
  return /\b(?:truck (?:is )?(?:now )?loaded|driver (?:is )?(?:now )?loaded|driver loaded|driver left (?:with )?(?:cargo|freight|shipment)?|cargo (?:is )?(?:now )?loaded|freight (?:is )?(?:now )?loaded|shipment (?:is )?(?:now )?loaded|(?:was|has been|got)\s+picked\s+(?:it\s+)?up|picked\s+(?:it\s+)?up\s+already|recovered from|recovery complete|pickup complete|loaded and will deliver|loaded and (?:is )?(?:en route|rolling)|loaded as of|loaded\s+eta\b)\b/i.test(value) ||
    /\b(?:yes[,.\s]*)?(?:both|all|the\s+(?:two|2)|both\s+awbs?|all\s+awbs?|both\s+shipments?|all\s+shipments?)\s+(?:are|were|have been|got|are now|were now)?\s*(?:recovered|loaded|picked\s*up)\b/i.test(value) ||
    /\b(?:recovered|loaded|picked\s*up)\b[^.;\n]{0,40}\b(?:both|all|both\s+awbs?|all\s+awbs?|both\s+shipments?|all\s+shipments?)\b/i.test(value);
}

function executionProgressClauses(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return [];
  return [...new Set([
    value,
    ...value.split(/[.;\n]+/).map((part) => part.trim()).filter(Boolean),
  ])];
}

function positiveExecutionProgressText(text) {
  const hardBlocker =
    /\b(?:not (?:loaded|picked up|recovered|delivered)|waiting to be loaded|driver waiting|driver on[-\s]?site|driver onsite|detention|cannot|can't|unable|blocked|stuck|not found|can't locate|cannot locate|wrong (?:consignee|cnee|customer|recipient|receiver)|delivered by mistake|receiver closed|consignee closed|facility closed|refused|storage|hold overnight|customs hold|government hold|exam hold)\b/i;
  const progress =
    /\b(?:truck|driver|carrier|cargo|freight|shipment|load)\b[^.;\n]{0,80}\b(?:is |was |now |has been |got )?(?:loaded|picked\s*up|recovered)\b/i;
  const movement =
    /\b(?:heading|headed|en route|rolling|on (?:the )?way)\b[^.;\n]{0,80}\b(?:drop[-\s]?off|delivery|receiver|consignee|cnee|destination)\b/i;
  const outForDelivery = /\b(?:out[-\s]?for[-\s]?delivery|\bofd\b|will deliver by|eta(?:\s+to)?\s+(?:cnee|receiver|consignee|delivery|drop[-\s]?off))\b/i;
  return executionProgressClauses(text).some((clause) =>
    (progress.test(clause) || movement.test(clause) || outForDelivery.test(clause)) &&
      !hardBlocker.test(clause)
  );
}

function benignExecutionScheduleText(text) {
  const hardBlocker =
    /\b(?:missed|failed|cancel(?:led|ed)?|reschedul(?:e|ed|ing)|not booked|no appointment|no appt|appointment (?:problem|issue|blocked)|cannot|can't|unable|blocked|stuck|not found|can't locate|cannot locate|wrong (?:consignee|cnee|customer|recipient|receiver)|delivered by mistake|receiver closed|consignee closed|facility closed|refused|storage|hold overnight|detention|customs hold|government hold|exam hold)\b/i;
  const scheduledPickup =
    /\b(?:driver|carrier|truck|trucker|we|they)\b[^.;\n]{0,100}\b(?:will|is going to|scheduled to|set to)\b[^.;\n]{0,80}\b(?:pick\s*up|pickup|recover|load)\b/i;
  const appointmentBooked =
    /\b(?:appointment|appt)\b[^.;\n]{0,120}\b(?:booked|scheduled|confirmed|set|for\s+\d{1,2}(?::?\d{2})?\s*(?:am|pm)?)\b/i ||
    /\b(?:booked|scheduled|confirmed|set)\b[^.;\n]{0,120}\b(?:appointment|appt)\b/i;
  const etaChase =
    /\b(?:please|pls)?\s*(?:urgently\s+)?(?:advise|confirm|share|send)\b[^.;\n]{0,80}\b(?:eta|delivery eta|arrival eta)\b/i;
  return executionProgressClauses(text).some((clause) =>
    (scheduledPickup.test(clause) || appointmentBooked.test(clause) || etaChase.test(clause)) &&
      !hardBlocker.test(clause)
  );
}

function nonExceptionExecutionUpdateText(text) {
  return positiveExecutionProgressText(text) || benignExecutionScheduleText(text);
}

function hasPickupConfirmedEvidence(text, message = {}, threadContext = "") {
  if (!evidenceEligible(String(text || ""), "pickup")) return false;
  const value = String(text || "");
  const current = currentMessageText(value).replace(/\s+/g, " ").trim();
  if (current && hasPickupConfirmedPositiveText(current) && !hasPickupArrangementOnlyEvidence(current) && !hasHebrewPickupFutureOrNegativeEvidence(current)) {
    return true;
  }
  if (/\b(?:not picked up|not loaded|waiting to be loaded|driver on[-\s]?site|driver onsite|driver waiting|detention|pickup pending|pickup not complete)\b/i.test(value) ||
    hasPickupArrangementOnlyEvidence(value) ||
    hasHebrewPickupFutureOrNegativeEvidence(value)) {
    return false;
  }
  if (hasPickupConfirmedPositiveText(value)) return true;
  if (hasHebrewPickupConfirmedEvidence(value)) return true;
  const terseLoaded = /^(?:loaded[.!]?|loaded and rolling|loaded\/rolling)(?:\s+loaded[.!]?){0,2}$/i.test(current) ||
    /^loaded[.!]?\s+(?:get\s+\[?outlook|outlook for ios|from:|sent:|to:|subject:|\[external\])/i.test(current) ||
    /^loaded[,.\s]+(?:he|she|they|driver|truck|trucker|carrier|we)\b[^.;\n]{0,180}$/i.test(current);
  if (!terseLoaded || isPikiSender(message)) return false;
  const fromEmail = addressEmail(message.from || "");
  const fromBroker = knownBrokerNameFromEmail(fromEmail) || knownBrokerNameFromEmail(message.from || "");
  const context = `${threadContext || ""} ${message.subject || ""}`;
  return Boolean(fromBroker || fromEmail) && /\b(?:pickup|pick up|recover|recovery|inbound alert|delivery order|d\/?o|release|quote|rate|driver)\b/i.test(context);
}

function hasPickupOnsiteEvidence(text) {
  const value = currentMessageText(String(text || ""));
  if (hasPickupConfirmedPositiveText(value) || hasPickupArrangementOnlyEvidence(value)) return false;
  return /\b(?:driver|truck|trucker|carrier)\b[^.\n;]{0,120}\b(?:on[-\s]?site|onsite|at (?:the )?(?:airport|station|terminal|cargo|warehouse|pick[-\s]?up location|pickup address|pickup facility)|at pick[-\s]?up|waiting|standby|sitting)\b/i.test(value) ||
    /\bon[-\s]?site\b[^.\n;]{0,80}\b(?:picking\s*up|pickup|recovering|recovery|loading|waiting)\b/i.test(value);
}

function hasPickupLocationRequestEvidence(text) {
  const value = currentMessageText(String(text || ""));
  return /\b(?:do you have|can you send|could you send|please send|need|needs|needed|provide|share)\b[^.;\n]{0,100}\b(?:exact\s+)?(?:pick[-\s]?up|pickup)\s+(?:location|address)\b/i.test(value) ||
    /\b(?:where|what)\b[^?;\n]{0,100}\b(?:exact\s+)?(?:pick[-\s]?up|pickup)\s+(?:location|address)\b/i.test(value) ||
    /\b(?:airport|station|terminal|warehouse)\s+(?:address|location)\b[^?;\n]{0,80}\?/i.test(value);
}

function pickupCarrierNameFromText(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  const match =
    value.match(/\bcarrier\s+(?:will\s+(?:once\s+again\s+)?be|is|will be|:)\s+([A-Z][A-Za-z0-9& ./'-]{2,60}?)(?:[.;,\n\-\u2013\u2014]|$)/i) ||
    value.match(/\b(?:using|use|with)\s+carrier\s+([A-Z][A-Za-z0-9& ./'-]{2,60}?)(?:[.;,\n\-\u2013\u2014]|$)/i);
  if (!match) return "";
  const candidate = match[1]
    .replace(/\b(?:again|for pickup|for recovery|to pick up|will|please|thanks?|thank you)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/[.;:, -]+$/g, "")
    .trim();
  if (
    !candidate ||
    /\b(?:onsite|on site|checked in|made the following request|at the|waiting|standby|sitting|pickup|pick up)\b/i.test(candidate)
  ) {
    return "";
  }
  return candidate;
}

function hasPickupDocsNeededEvidence(text) {
  const value = currentMessageText(String(text || ""));
  if (hasOperationalClearEvidence(value)) return false;
  if (
    /\b(?:pre[-\s]?alert|3461|7501|full set of documents|clearance instructions)\b/i.test(value) &&
    !/\b(?:driver|carrier|pickup|pick\s*up|recover|recovery|delivery order|d\/?o)\b/i.test(value)
  ) {
    return false;
  }
  const explicitDocsRequest =
    /\b(?:please send|send|need|needs|needed|provide|missing|remaining|necessary|awaiting|waiting for|assist)\b[^.;\n]{0,140}\b(?:docs?|documents?|delivery order|d\/?o|release package|release docs?|clearance docs?|airway bill(?: number)?|awb)\b/i.test(value) ||
    /\b(?:shipper|carrier|driver)\b[^.;\n]{0,120}\b(?:need|needs|needed|request|requested|asking for|asked for)\b[^.;\n]{0,140}\b(?:airway bill(?: number)?|awb|delivery order|d\/?o|docs?|documents?)\b/i.test(value);
  if (explicitDocsRequest) return true;
  if (hasPickupOnsiteEvidence(value) && !/\b(?:docs?|documents?|delivery order|d\/?o|release package|release docs?|clearance docs?|airway bill(?: number)?|awb)\b/i.test(value)) {
    return false;
  }
  return /\b(?:please send|send|need|needs|needed|provide|missing|remaining|necessary|awaiting|waiting for)\b[^.;\n]{0,120}\b(?:docs?|documents?|delivery order|d\/?o|release package|release docs?|clearance docs?)\b/i.test(value) ||
    /\b(?:remaining|necessary)\s+docs?\b/i.test(value) ||
    (/\bcarrier\s+(?:will\s+(?:once\s+again\s+)?be|will be)\b/i.test(value) && /\b(?:docs?|documents?|delivery order|d\/?o|release)\b/i.test(value));
}

function hasAwbCopyNeededEvidence(text) {
  const value = currentMessageText(String(text || ""));
  if (hasOperationalClearEvidence(value)) return false;
  const asksForAwb = /\b(?:could you|can you|please|pls|kindly|need|needs|needed|request|requested|asking for|asked for|send|provide|share)\b[^.;\n]{0,140}\b(?:copy of (?:the )?)?(?:air\s*waybill|airway bill|awb|mawb)(?:\s+copy)?\b/i.test(value) ||
    /\b(?:copy of (?:the )?)?(?:air\s*waybill|airway bill|awb|mawb)(?:\s+copy)?\b[^.;\n]{0,120}\b(?:needed|requested|missing|send|provide|share)\b/i.test(value);
  if (!asksForAwb) return false;
  if (/\b(?:delivery order|d\/?o|docs?|documents?|release package|release docs?|clearance docs?)\b/i.test(value)) return false;
  return /\b(?:copy|pdf|scan|attached|attachment|send|provide|share)\b/i.test(value);
}

function hasPickupLocationReplyEvidence(text) {
  const value = currentMessageText(String(text || ""));
  return /\b(?:main cargo facility|cargo (?:rd|road)|cargo terminal|terminal address|pickup location|pick[-\s]?up location|cleveland,\s*oh|south cargo)\b/i.test(value) &&
    /\b(?:facility|terminal|cargo|address|rd\.?|road|oh|cleveland)\b/i.test(value);
}

function hasPickupDocsSentEvidence(text, message = {}) {
  const value = currentMessageText(String(text || ""));
  const attachmentText = (message.attachments || [])
    .filter(attachmentCanMintOperationalEvidence)
    .map((item) => [item.filename, item.mimeType, item.extractedText, item.pdfEvidence?.label, item.pdfEvidence?.note].filter(Boolean).join(" "))
    .join(" ");
  return /\b(?:attached|see attached|sent|sending)\b/i.test(value) &&
    /\b(?:delivery[-\s]?order|d\/?o|payment confirmation|release|docs?|documents?)\b/i.test(`${value} ${attachmentText}`);
}

function pickupRequestStationFromText(text) {
  const value = currentMessageText(String(text || ""));
  const match = value.match(/\b(?:at|in|from)\s+([A-Z]{3})\b/) || value.match(/\b([A-Z]{3})\s+(?:pickup|station|airport|terminal)\b/i);
  return match ? String(match[1] || "").toUpperCase() : "";
}

function hasArrivalPositiveEvidence(text) {
  const value = String(text || "");
  // Speech-act contract: questions/requests/futures about arrival never mint arrival truth.
  if (!evidenceEligible(value, "arrival")) return false;
  if (/\b(?:no arrival|not arrived|has not arrived|without arrival|arrival pending|no arrival notice|arrival notice missing|not\s+on\s+hand|is not on hand|not available at|eta|expected)\b/i.test(value)) return false;
  if (/\b(?:await|awaiting|will await|waiting for|wait for|wait on|will wait on|need|needs|needed|request|requested|please provide|provide|send|looking for|missing)\b[^.;\n]{0,100}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability)\b/i.test(value)) return false;
  // "Please confirm on hand and share the arrival notice" is a QUESTION, not arrival proof —
  // asks (including the common "pleas" typo) must never mint arrival evidence.
  if (/\b(?:pleas?e?|pls|kindly|can you|could you)\b[^.;\n]{0,60}\b(?:confirm|advise|share|update)\b[^.;\n]{0,100}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability|arrival)\b/i.test(value)) return false;
  // Origin transfer sagas ("shipment received", "transferred", "will be loaded for flight X")
  // speak about the ORIGIN handoff: a bare past-tense "arrived" mention there is transit
  // progress, not destination arrival, unless strong on-hand wording is also present.
  const onwardLoadingContext = /\b(?:will be loaded (?:for|on) flight|loaded for flight|reserving [^.;\n]{0,40}for flight|transfer (?:is )?(?:done|in progress)|transferred this|for loading)\b/i.test(value);
  const destinationPickupPending =
    /\b(?:cargo|freight|shipment)\b[^.;\n]{0,80}\b(?:still\s+)?pending\s+(?:pickup|pick\s*up|recovery|recover)\s+from\s+(?:united|united airlines|ua|airline|carrier|station|terminal|warehouse|cargo|handler)\b/i.test(value) ||
    /\bpending\s+(?:pickup|pick\s*up|recovery|recover)\s+from\s+(?:united|united airlines|ua|airline|carrier|station|terminal|warehouse|cargo|handler)\b/i.test(value);
  const strongDestinationArrival = /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|available for pickup|landed|flight (?:has )?arrived|arrival(?:\s+date)?[:\s]+\d{6})\b/i.test(value) ||
    destinationPickupPending;
  if (onwardLoadingContext && !strongDestinationArrival) return false;
  if (hasFutureOrConditionalDeliveryEvidence(value)) return false;
  if (/\bpre[-\s]?alert\b/i.test(value) && !/\b(?:arrival notice|notice of arrival|\bnoa\b|arrived at|arrived on|arrived\b|on[-\s]?hand|available for pickup)\b/i.test(value)) return false;
  return /\b(?:arrival notice|notice of arrival|\bnoa\b|arrived at|arrived on|arrived\b|on[-\s]?hand|available for pickup|landed|after landing|arrival(?:\s+date)?[:\s]+\d{6}|flight (?:has )?arrived)\b/i.test(value) ||
    destinationPickupPending ||
    hasHebrewArrivalPositiveEvidence(value);
}

// Explicit NOT-arrived wording from a station/handler is hard negative arrival evidence:
// it must beat any older arrival claim and every soft inference. "At origin", "not in our
// system yet", ETA-only status lines keep the shipment physically pre-arrival.
function hasArrivalNegativeEvidence(text) {
  const value = String(text || "");
  // "IT / inbond / entry / document not arrived" is a paperwork-transmission status, never
  // freight non-arrival — exclude those subjects before testing freight wording.
  const stripped = value.replace(/\b(?:i\.?t\.?|in-?bond|entry|document|release|transmission)\b[^.;\n]{0,40}\bnot\s+(?:yet\s+)?arrived\b/gi, " ");
  return /\b(?:at\s+origin|not\s+in\s+(?:our|the)\s+system(?:\s+yet)?|not\s+on\s+hand|not\s+(?:yet\s+)?arrived|has\s+not\s+arrived|arrival\s+not\s+confirmed|no\s+arrival\s+(?:notice|record)\s+(?:yet|found)?)\b/i.test(stripped);
}

function hasCustomsReleaseNegativeEvidence(text) {
  // A promised FUTURE release is not a release: "I will email the release once the shipment
  // is available in ABI" must keep customs pending.
  if (/\b(?:will\s+(?:email|send)\s+(?:you\s+)?(?:the\s+)?release|release\s+(?:will|to)\s+be\s+(?:emailed|sent)|email\s+the\s+release\s+once|once\s+(?:the\s+)?shipment\s+is\s+available)\b/i.test(String(text || ""))) return true;
  const value = String(text || "");
  if (hasCustomsReleaseResolutionEvidence(value)) return false;
  return /\b(?:not released|not cleared|release pending|clearance pending|customs hold|exam hold|hold not removed|cannot release|can'?t release|wrong d\/?o|wrong delivery order|no release|no d\/?o|no delivery order|d\/?o (?:is )?(?:missing|pending|wrong|incorrect)|delivery order (?:is )?(?:missing|pending|wrong|incorrect))\b/i.test(value) ||
    hasHebrewCustomsReleaseNegativeEvidence(value);
}

function hasCustomsReleasePositiveEvidence(text) {
  if (!evidenceEligible(String(text || ""), "release")) return false;
  const value = String(text || "");
  if (hasCustomsReleaseNegativeEvidence(value)) return false;
  if (hasCustomsReleaseResolutionEvidence(value)) return true;
  return /\b(?:customs released|customs cleared|released by|cleared by|release\s*\+\s*d\/?o|release\/d\/?o|d\/?o\s*(?:and|&|\+)\s*(?:clearance|ace|release)|(?:delivery|deli)\s+order\s*(?:and|&|\+)\s*(?:release|clearance|ace)|release\s*(?:and|&|\+)\s*(?:delivery|deli)\s+order|delivery order attached|d\/?o attached|ace cargo release|customs release|customs?\s+clearance\s+(?:received|confirmed|approved|obtained)|(?:got|received|confirmed)\s+(?:the\s+)?customs?\s+clearance|shipment (?:is|was) release(?:d)?|98\s+released|release\s+attached|release\s+and\s+d\/?o\s+attached|1c\s+(?:entered|confirmed|posted)|confirmed\s+1c|terminal confirmed\s+1c|1c\s+enter(?:ed)?\s+and\s+released)\b/i.test(value) ||
    /(?:^|[\s:>])1c(?:[\s.!,]|$)/im.test(value) ||
    hasHebrewCustomsReleasePositiveEvidence(value);
}

function hasCustomsReleaseResolutionEvidence(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/\b(?:hold not removed|not released|not cleared|release pending|clearance pending|cannot release|can'?t release)\b/i.test(value)) return false;
  if (/\b(?:can you|could you|please|pls)\b[^.?\n;]{0,100}\b(?:confirm|check|advise|verify)\b[^.?\n;]{0,100}\b(?:released|cleared|all set|good (?:now|to go)|able to generate)\b/i.test(value)) return false;
  if (/\b(?:can|could|would)\s+you\b[^.?\n;]{0,120}\b(?:generate|issue|send|provide|share)\b[^.?\n;]{0,80}\b(?:t\s*&?\s*e|i\s*e\s*\/\s*t\s*e|release|d\/?o|delivery order)\b/i.test(value)) return false;
  // "after/once the shipment is cleared..." (DDP boilerplate, promises) is a CONDITION,
  // not a clearance statement — only unconditional cleared/released wording resolves.
  const clearedMatch = /\b(?:cargo|freight|shipment)\b[^.;\n]{0,80}\b(?:is|was|now|has been)\b[^.;\n]{0,40}\b(?:released|cleared)\b/i.exec(value);
  // The conditional window must cross line breaks: HTML-derived text splits "after <br><br>
  // shipment is cleared" across newlines (DHL DDP boilerplate).
  const clearedConditional = clearedMatch &&
    /\b(?:after|once|when|if|upon|until|before|in case)\b[^.;]{0,80}$/i.test(value.slice(Math.max(0, clearedMatch.index - 90), clearedMatch.index));
  const activeReleaseContext = /\b(?:customs?|release|released|clearance|cleared|in-?bond|entry|t\s*&?\s*e|i\s*e\s*\/\s*t\s*e|7512|pedimento|d\/?o|delivery order|cbp|1c)\b/i.test(value);
  const shortResolution = /\b(?:(?:finally|successfully)\s+released|released\s+now|now\s+released|cleared\s+now|now\s+cleared|all\s+set(?:\s+now)?|good\s+(?:now|to\s+go)|resolved\s+now|entry\s+accepted|in-?bond\s+accepted|(?:able\s+to|can)\s+generate(?:\s+the)?\s+(?:t\s*&?\s*e|i\s*e\s*\/\s*t\s*e)|(?:t\s*&?\s*e|i\s*e\s*\/\s*t\s*e)\s+generated)\b/i.test(value);
  const personReleaseNoise = /\b(?:driver|trucker|person|employee|team|staff|agent)\b[^.;\n]{0,50}\b(?:released|cleared)\b/i.test(value) ||
    /\b(?:released|cleared)\b[^.;\n]{0,50}\b(?:from work|from the call|from duty)\b/i.test(value);
  return Boolean(clearedMatch && !clearedConditional) ||
    Boolean(activeReleaseContext && shortResolution && !personReleaseNoise) ||
    /\b(?:1[-\s]?i|1i)\b[^.;\n]{0,120}\b(?:cbp\s+)?hold\s+removed\b/i.test(value) ||
    /\b(?:cbp\s+)?hold\s+removed\b[^.;\n]{0,120}\b(?:1[-\s]?i|1i)\b/i.test(value) ||
    /\b(?:1[-\s]?c|1c)\b[^.;\n]{0,140}\b(?:enter(?:ed)?\s+and\s+released|released\b)/i.test(value) ||
    /\b(?:enter(?:ed)?\s+and\s+released|released\s+general\s+exam|hold\s+removed|customs\s+hold\s+removed|cbp\s+hold\s+removed)\b/i.test(value);
}

function customsDispositionStatusBlockText(text) {
  const value = String(text || "");
  return /\b(?:disposition code|carrier:|vessel:|voyage\/flight|lines received|quantity received|entry no\.?|master b\/l|house b\/l)\b/i.test(value) &&
    /\b(?:1[-\s]?[chi]|cbp hold|enter(?:ed)? and released|hold removed|cargo is now released|shipment is now released)\b/i.test(value);
}

function hasGroundFeesPaidEvidence(text) {
  const value = String(text || "");
  if (/\b(?:not paid|payment pending|payment due|due via station|need(?:s)? payment|need(?:s)? to pay|unpaid)\b/i.test(value)) return false;
  if (/\b(?:terminal confirmed\s+1c|1c\s+(?:entered|confirmed|posted)|confirmed\s+1c)\b/i.test(value)) return false;
  return /\b(?:cargosprint|ground handling|station fee|payment|receipt|cargo sprint)\b/i.test(value) &&
    /\b(?:paid|payment confirmation|payment delivered|receipt|approved|confirmed|charged|delivered)\b/i.test(value);
}

// A genuine fee DEMAND: a charge/invoice presented to us with an amount by a station/handler
// payee, unpaid. Quotes, arrival-notice fee banners, future storage exposure, and origin
// storage questions are mentions, not demands — they must never create fees_due.
function hasGroundFeesDemandEvidence(text) {
  const value = String(text || "");
  if (hasGroundFeesPaidEvidence(value)) return false;
  if (/\b(?:quote|quoted|rate for pickup|pickup rate|per\s+hawb|storage (?:won'?t|will not) apply|future storage|storage (?:begins|starts|would|exposure)|last free day|no storage)\b/i.test(value)) return false;
  const payeeContext = /\b(?:cargosprint|ground handling|station fee|import service charge|isc\b|terminal charge|thc\b|storage (?:due|charge[sd]?|invoice)|handling charge)\b/i.test(value);
  const demandContext = /\b(?:please pay|payment (?:is )?(?:due|required)|must be paid|kindly pay|pay (?:the )?(?:storage|fees?|charges?)|total due|amount due|balance due|invoice attached|charges? (?:due|apply|outstanding))\b/i.test(value);
  const amountContext = /(?:\$|USD\s*)\s*\d/.test(value);
  return payeeContext && demandContext && amountContext;
}

function hasForwarderAirPriceEvidence(text) {
  const value = String(text || "");
  const hebrew = normalizedHebrewLogisticsText(value);
  return /\b(?:air\s*freight|airfreight|flight rate|airline rate|linehaul|international freight|forwarder rate|terminal charge|airline charge)\b/i.test(value) ||
    /(?:מחיר הטסה|תעריפ.{0,12}הטסה|עלות הטסה|פקודת מסירה|דמי מסירה|חיוב הינה|חיוב הוא|תוספת חיוב|עד\s+[A-Z]{3}\b)/i.test(hebrew);
}

function hasPickupQuoteEvidence(text) {
  const value = String(text || "");
  if (hasForwarderAirPriceEvidence(value)) return false;
  const hebrew = normalizedHebrewLogisticsText(value);
  return /\b(?:quote|quoted|rate|pickup rate|recovery rate|cartage rate|can recover|can pick\s*up|pickup|recover|cartage)\b/i.test(value) ||
    /(?:הצעת מחיר|איסופ|פיקאפ|יכול לאסופ|יכולים לאסופ|יכולה לאסופ)/.test(hebrew);
}

function hasTersePickupQuoteReplyEvidence(text, message = {}, threadContext = "") {
  const current = currentMessageText(String(text || ""));
  const firstLine = current
    .split(/\n+/)
    .map((line) => line.trim())
    .find(Boolean) || "";
  if (!/^\$?\s*\d[\d,]*(?:\.\d+)?\s*(?:usd|all[-\s]?in)?[.!]?$/i.test(firstLine)) return false;
  if (isPikiSender(message)) return false;
  const fromEmail = addressEmail(message.from || "");
  const fromBroker = knownBrokerNameFromEmail(fromEmail) || knownBrokerNameFromEmail(message.from || "");
  if (!fromBroker && !fromEmail) return false;
  const context = `${message.subject || ""}\n${threadContext || ""}`;
  return /\b(?:rate\?|rate request|quote request|pickup quote|recovery quote|inbound alert|recover from|pickup|pick up|recover|recovery|cartage)\b/i.test(context);
}

function hasCustomsReleaseQuoteNoise(text) {
  const value = String(text || "");
  if (/\b(?:can recover|can pick\s*up|pickup rate|recovery rate|cartage rate|driver|truck|sprinter|box truck|straight truck)\b/i.test(value)) {
    return false;
  }
  return /\b(?:cargo release update|entry no\.?|entry type|broker ref\.?|master b\/l|house b\/l|customs release|d\/?o and clearance|delivery order attached|entered value|quantity unit|1c\s+(?:entered|confirmed|posted))\b/i.test(value) &&
    (/\b(?:rate quote constitutes acceptance|receipt of this rate quote|booking of cargo after receipt)\b/i.test(value) ||
      /\b(?:entered value|total entered value|importer|broker ref\.?|quantity unit)\b/i.test(value) ||
      /\$\s*\d{2,3},\d{3}(?:\.\d+)?/.test(value));
}

function hasStationConfirmationRequestEvidence(text) {
  const value = String(text || "");
  return /\b(?:please\s+)?confirm\b[^.\n;]{0,120}\b(?:on[-\s]?hand|arrival notice|notice of arrival|\bnoa\b|availability|available|pieces?|storage|ground fees?)\b/i.test(value) ||
    /\bshare\b[^.\n;]{0,80}\b(?:arrival notice|notice of arrival|\bnoa\b)\b/i.test(value);
}

function hasConnectionTransferResolvedEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  return /\b(?:transfer (?:is )?(?:done|completed)|transferred (?:to|at) (?:ua|united)|handoff (?:is )?(?:done|completed))\b/i.test(value) ||
    /\b(?:continues?|continued)\s+to\s+[A-Z]{3}\b/i.test(value) ||
    /\bshipment (?:was )?received\b[\s\S]{0,180}\b(?:will be loaded|loaded for flight|ua\s*\d+|united\s*\d+)\b/i.test(value);
}

function addThreadEvent(events, awb, type, message, summary, extra = {}) {
  const nearMissAwbs = [...new Set(
    (message.nearMissAwbs || []).map(normalizeAwb).filter(Boolean),
  )];
  const target = normalizeAwb(awb);
  if (target && nearMissAwbs.includes(target)) return;
  const scopedExtra = { ...extra };
  if (nearMissAwbs.length) {
    for (const field of ["groupAwbs", "appliesToAwbs", "awbs"]) {
      if (!Array.isArray(scopedExtra[field])) continue;
      scopedExtra[field] = scopedExtra[field]
        .map(normalizeAwb)
        .filter((item) => item && !nearMissAwbs.includes(item));
    }
    scopedExtra.nearMissAwbs = nearMissAwbs;
  }
  events.push({
    id: eventId(awb, type, message),
    type,
    awb,
    at: message.internalDate || "",
    threadId: message.threadId || "",
    messageId: message.id || "",
    from: message.from || "",
    to: message.to || "",
    cc: message.cc || "",
    subject: message.subject || "",
    summary: compactEventText(summary),
    evidence: compactEventText(scopedExtra.evidence || message.text, 260),
    evidenceKind: scopedExtra.evidenceKind || "actual",
    confidence: scopedExtra.confidence || "medium",
    ...scopedExtra,
  });
}

function operationalExceptionRules() {
  return [
    {
      type: "station-cargo-not-found",
      severity: "immediate",
      where: "station",
      impact: "cargo-not-located",
      pattern: /\b(?:station|airport|terminal|airline|warehouse|driver|truck|trucker)\b[^.\n;]{0,160}\b(?:can'?t|cant|cannot|doesn'?t|does not|don'?t|do not|not|unable)\b[^.\n;]{0,120}\b(?:find|locate|see|recover)\b[^.\n;]{0,100}\b(?:cargo|freight|shipment|load|pieces?|pcs?|awb)?\b|\b(?:cargo|freight|shipment|load|pieces?|pcs?)\b[^.\n;]{0,120}\b(?:missing(?!\s+(?:copy|copies|docs?|documents?|paperwork|its?\b|the copy))|not found|cannot be found|can'?t be found|cant be found|not located|can'?t locate|cant locate|cannot locate|short)\b|\bdriver\b[^.\n;]{0,100}\btold\b[^.\n;]{0,100}\b(?:they|station|airport|terminal|warehouse)?\b[^.\n;]{0,40}\b(?:can'?t|cant|cannot|couldn'?t|couldnt)\s+locate\b|(?:לא מוצאים|לא נמצא|לא נמצאה|לא נמצאו|מטען חסר|המטענ חסר|לא מאתרים|לא איתרו)/i,
      summary: "Station/pickup side cannot locate the cargo.",
      nextAction: "Call the station and pickup broker now; do not re-dispatch or keep the driver waiting until the freight is physically located.",
    },
    {
      type: "wrong-consignee-delivery",
      severity: "immediate",
      where: "delivery",
      impact: "misdelivered-wrong-consignee",
      pattern: WRONG_CONSIGNEE_DELIVERY_PATTERN,
      summary: "Shipment appears delivered to the wrong consignee/customer.",
      nextAction: "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.",
    },
    {
      type: "delivery-facility-closed",
      severity: "immediate",
      where: "delivery",
      impact: "delivery-blocked",
      pattern: /\b(?:consignee|receiver|facility|warehouse|delivery location|site)\b[^.\n;]{0,120}\b(?:closed|not open|no one|nobody|not available|cannot receive|can't receive|refused)\b|\b(?:closed facility|facility closed|receiver closed|consignee closed)\b|\b(?:driver|truck|trucker)\b[^.\n;]{0,120}\b(?:on[-\s]?site|onsite|at (?:the )?(?:receiver|consignee|delivery|dock|facility))\b[^.\n;]{0,180}\b(?:for delivery|delivery|receiver|consignee|facility|dock|unload|offload)\b[^.\n;]{0,180}\b(?:closed|not open|cannot receive|can't receive|no one|nobody|not available)\b|(?:הלקוח|לקוח|המקבל|הנמענ)[^.\n;]{0,24}סגור|סגור(?:ה)?\s+עד\s+(?:יומ|יום)|\b(?:receiver|consignee|customer)\b[^.\n;]{0,40}\bclosed until\b/i,
      summary: "Delivery is blocked because the consignee/facility cannot receive.",
      nextAction: "Call the broker/driver and decide storage, redelivery, or receiver instructions now.",
    },
    {
      type: "storage-needed-after-delivery-blocker",
      severity: "immediate",
      where: "delivery",
      impact: "storage-needed",
      pattern: /\b(?:need|needs|must|will|have to)\b[^.\n;]{0,100}\b(?:store|storage|hold overnight|warehouse|local hub)\b|\b(?:local hub|incur additional fees|incur addition fees|additional storage|redelivery fees|extra fees)\b/i,
      // Pre-arrival storage EXPOSURE ("subject to storage if it arrives...", free-day math,
      // booking-change asks) is storage-or-detention-cost risk, not a blocked delivery.
      unless: /\b(?:if it arrives?|coming in on|change (?:the )?booking|rebook|before (?:it )?arriv\w*|prior to arrival|free day)\b/i,
      summary: "Shipment may need storage because delivery cannot complete.",
      nextAction: "Confirm where the freight will be stored, who approved it, and expected redelivery timing.",
    },
    {
      type: "station-release-not-visible",
      severity: "immediate",
      where: "station",
      impact: "release-not-visible",
      pattern: /\b(?:station|airport|terminal|airline|warehouse)\b[^.\n;]{0,140}\b(?:can'?t|cannot|doesn'?t|does not|don'?t|do not|not)\b[^.\n;]{0,120}\b(?:see|show|have|find)\b[^.\n;]{0,80}\b(?:release|clearance|clear|d\/?o|delivery order|load)\b/i,
      summary: "Station cannot see clearance/release.",
      nextAction: "Call the station and broker now; clear the clearance/release visibility problem before pickup waits longer.",
    },
    {
      type: "piece-count-mismatch",
      severity: "urgent",
      where: "station",
      impact: "piece-count-mismatch",
      pattern: /\b(?:piece[-\s]?count|pieces?|pcs?|skids?|pallets?)\b[^.\n;]{0,140}\b(?:mismatch|discrepanc|wrong|short|missing|not match|difference|only \d+)\b|\b\d+\s*(?:pcs?|pieces?|pallets?|skids?)\b[^.\n;]{0,80}\b(?:instead of|vs\.?|versus|but)\b[^.\n;]{0,80}\b\d+\s*(?:pcs?|pieces?|pallets?|skids?)\b/i,
      summary: "Piece count or freight availability does not match.",
      nextAction: "Confirm actual pieces with station and update the broker before pickup continues.",
    },
    {
      type: "movement-split-offload",
      // A carrier movement split is the ACTIVE blocker when it happens pre-arrival — it must
      // surface as the exception lane instead of being shadowed by a co-fired customs-hold
      // classification (customs is not even involved before US arrival).
      severity: "immediate",
      where: "movement",
      impact: "flight-split-rebooked",
      pattern: /\b(?:shipment split|split shipment|another split|pieces? offloaded|pcs? offloaded|offloaded from|rebooked on|rebooked to)\b[^.\n;]{0,180}\b(?:flight|ly\d+|due to|weight|space|next flight|rebooked|built)\b|\b(?:only\s+)?\d+\s*(?:pcs?|pieces?)\s+(?:were\s+)?built\s+(?:for|on)\s+[A-Z]{2}\d+(?:\/\d+)?\b|\b(?:weight and space problem|space problem)\b[^.\n;]{0,120}\b(?:offloaded|rebooked|split)\b/i,
      summary: "Shipment split/offloaded/rebooked; movement timing or piece availability changed.",
      nextAction: "Confirm revised flight/arrival and affected pieces before planning pickup.",
    },
    {
      type: "airline-transmission-blocker",
      severity: "urgent",
      where: "station",
      impact: "release-or-piece-transmission-blocked",
      pattern: /\b(?:customer|broker|consignee|shipper)?[^.\n;]{0,80}\bneeds? to cancel (?:their |the )?entry\b|\bentry\b[^.\n;]{0,80}\b(?:needs? to be |must be |should be )?cancel(?:led|ed)?\b|\bneeds? to nominate\b[^.\n;]{0,80}\b(?:\d+\s*)?(?:pcs?|pieces?|pallets?|skids?)\b|\b(?:nominate|nomination)\b[^.\n;]{0,80}\b(?:airline|carrier|ua|united|pcs?|pieces?)\b|\b(?:transmission|nomination)\b[^.\n;]{0,80}\b(?:problem|issue|mismatch|wrong|missing)\b|(?:בעיית שידור|בעיה בשידור|כמות חבילות|כמות חלקים|כמות יחידות|לא תואם|לא תואמת)/i,
      summary: "Airline/station transmission or entry nomination is blocking pickup.",
      nextAction: "Have the broker/airline correct the entry nomination or piece transmission before dispatch continues.",
    },
    {
      type: "inbond-rejected",
      severity: "urgent",
      where: "customs",
      impact: "inbond-entry-rejected",
      pattern: /\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b[^.\n;]{0,160}\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b|\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b[^.\n;]{0,160}\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b|\barriv(?:e|ed)\s+i\.?t\.?\s+to\s+port\b/i,
      summary: "Inbond/customs entry is rejected or not accepted.",
      nextAction: "Escalate the inbond rejection with UPS/Align customs and do not dispatch pickup until the IT/entry is accepted.",
    },
    {
      type: "connection-transfer-exception",
      severity: "urgent",
      where: "movement",
      impact: "connection-transfer-blocked",
      pattern: /\b(?:not in (?:the )?(?:ua|united) area|flight (?:was )?deleted in uc360|deleted in uc360|connection transfer exception|transfer exception)\b/i,
      summary: "Connection transfer/handoff exception is active.",
      nextAction: "Follow WFS/CDG transfer and confirm UA handoff before treating this as normal pre-arrival.",
    },
    {
      type: "storage-or-detention-cost",
      severity: "urgent",
      where: "storage",
      impact: "storage-or-detention-cost",
      pattern: /\b(?:storage|detention|waiting time|demurrage|last free|lfd)\b[^.\n;]{0,120}\b(?:charges?|costs?|fees?|due|owed|accru(?:e|ing|ed)|started|starts?|incur(?:red|ring)?|\$\s*\d|\d+\s*(?:\/\s*day|per day|hours?))\b|\b(?:charges?|costs?|fees?|due|owed|accru(?:e|ing|ed)|incur(?:red|ring)?|\$\s*\d)\b[^.\n;]{0,120}\b(?:storage|detention|waiting time|demurrage)\b|(?:אחסנה|אחסון|דמי אחסנה|זמן המתנה|זמני המתנה|המתין|המתינה|המתינו|תוספת חיוב).{0,80}(?:\$|\d|חיוב|עלות|שעה|שעות)?/i,
      unless: /\b(?:cargo|freight|shipment|load|pieces?|pcs?)\b[^.\n;]{0,120}\b(?:missing|not found|cannot be found|can'?t be found|not located|can'?t locate|cannot locate|short)\b|(?:לא מוצאים|לא נמצא|לא נמצאה|לא נמצאו|מטען חסר|המטענ חסר|לא מאתרים|לא איתרו)/i,
      summary: "Storage or detention cost is being reported.",
      nextAction: "Confirm who approved the charge, whether pickup/delivery can still proceed, and whether the cost is recoverable.",
    },
    {
      type: "loading-problem",
      severity: "immediate",
      where: "loading",
      impact: "loading-blocked",
      pattern: /\b(?:doesn'?t fit|won'?t fit|cannot load|can'?t load|loading problem|load problem|too (?:big|wide|tall|heavy)|liftgate required|dock problem|forklift problem)\b/i,
      summary: "Driver has a loading problem.",
      nextAction: "Call the broker/driver and confirm equipment or loading plan immediately.",
    },
    {
      type: "driver-waiting",
      severity: "immediate",
      where: "pickup",
      impact: "driver-waiting",
      pattern: /\b(?:driver|truck|trucker)\b[^.\n;]{0,120}\b(?:waiting|standby|sitting|detention|on[-\s]?site|onsite)\b/i,
      unless: /\b(?:has been delivered|was delivered|delivery completed|completed delivery|will send (?:the )?pod|driver will send (?:the )?pod|pod shortly|for delivery|delivery location|consignee|receiver|facility|unload|offload|closed today|local hub)\b/i,
      summary: "Driver is waiting or onsite.",
      nextAction: "Find the blocker now so detention does not grow.",
    },
    {
      type: "customs-hold",
      severity: "watch",
      where: "customs",
      impact: "government-hold",
      pattern: /\b(?:u\.?s\.? customs (?:hold|exam|wants? to examine)|customs (?:hold|exam|wants? to examine)|cbp hold|\b1[-\s]?h\b|exam hold|government hold|fda hold|intensive exam|hold not removed|remove th?e?\s+hold|in-?bond[^.\n]{0,60}rejected|rejected[^.\n]{0,60}(?:in-?bond|arrive[d]?\s+it)|arrive[d]?\s+it\s+to\s+port|ams\s+(?:issue|mismatch|record|split)|customer cannot release (?:the )?shipment until)\b/i,
      // Origin pre-alert/air-export document packages carry customs-instruction boilerplate
      // (attachment text) that is not an active hold report.
      unless: /\bpre alert for mawb\b|air[\s_]?export[\s_]?(?:file|job)|dep\.?\s*pre alert/i,
      summary: "Shipment appears to be on a true customs/government hold.",
      nextAction: "Reply on the hold thread to the customs/inbond desk about the hold or inbond rejection: confirm the corrected record (AMS/IT) and ask them to retransmit/clear; do not dispatch until accepted; expect an acceptance or hold-removed confirmation.",
    },
    {
      type: "broker-release-pending",
      severity: "urgent",
      where: "customs-broker",
      impact: "release-pending",
      pattern: /\b(?:release|clearance|d\/?o|delivery order)\b[^.\n;]{0,100}\b(?:pending|missing|not received|not released|not cleared|needed|need|waiting)\b|\b(?:not released|not cleared|release pending|clearance pending|no release|no d\/?o|no delivery order)\b/i,
      summary: "Release/DO is not confirmed yet.",
      nextAction: "Push the customs broker for release/DO before dispatch.",
    },
  ];
}

function hasMisdeliveryRecoveryFollowUpEvidence(text) {
  const value = String(text || "");
  const hebrew = normalizedHebrewLogisticsText(value);
  return /\b(?:confirm (?:that )?(?:the )?shipment was returned|shipment was returned|returned to you|return(?:ed)? to (?:el al|airline|station|airport|field)|send back to (?:el al|airline|station|airport)|bring back to (?:el al|airline|station|airport)|who received (?:it|this|the shipment)|whoever received|wrong customer|wrong consignee|wrong cnee|another customer|another cnee|delivered by mistake)\b/i.test(value) ||
    /(?:להחזיר.{0,20}משלוח|שיחזור.{0,24}(?:שדה|מסופ|אל על)|מוחזר.{0,24}(?:למסור|שדה|מסופ|אל על)|מי שקבל.{0,24}להחזיר)/.test(hebrew);
}

function hasWrongConsigneeRecoveryContext(currentText, fullText) {
  const full = String(fullText || "");
  if (!full || !WRONG_CONSIGNEE_DELIVERY_PATTERN.test(full)) return false;
  return hasMisdeliveryRecoveryFollowUpEvidence(currentText);
}

function addWrongConsigneeRecoveryEvent(events, awb, message, evidenceText) {
  addThreadEvent(events, awb, "exception", { ...message, text: evidenceText || message.text || "" }, "Shipment appears delivered to the wrong consignee/customer.", {
    id: [normalizeAwb(awb), "exception", "wrong-consignee-delivery", message.threadId || "", message.id || ""].filter(Boolean).join(":"),
    exceptionType: "wrong-consignee-delivery",
    severity: "immediate",
    where: "delivery",
    impact: "misdelivered-wrong-consignee",
    status: "open",
    evidenceKind: "quoted-context-current-recovery",
    confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
    nextAction: "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.",
  });
}

function inferExceptionWhere(text) {
  const value = String(text || "");
  if (/\b(?:receiver|consignee|dock|delivery|unload|offload|address)\b/i.test(value)) return "delivery";
  if (/\b(?:driver|truck|pickup|pick up|recovery|load|loading)\b/i.test(value)) return "pickup";
  if (/\b(?:station|airport|terminal|airline|warehouse|agent)\b/i.test(value)) return "station";
  if (/\b(?:customs|broker|release|clearance|d\/?o|delivery order|entry)\b/i.test(value)) return "customs";
  if (/\b(?:storage|hold overnight|warehouse overnight)\b/i.test(value)) return "storage";
  return "unknown";
}

function unclassifiedExceptionSignal(text) {
  const value = String(text || "");
  if (/\b(?:no issue|no problem|resolved|all good|ok to proceed|please quote|quote request|rate request)\b/i.test(value)) return false;
  const hasOperationalSubject = /\b(?:shipment|awb|mawb|cargo|freight|driver|truck|pickup|delivery|receiver|consignee|station|airport|terminal|warehouse|broker|customs|release|clearance|d\/?o|delivery order|storage|appointment|dock|load|unload)\b/i.test(value);
  const hasProblem = /\b(?:problem|issue|blocked|stuck|cannot|can'?t|unable|refus(?:e|ed|ing)|failed|delay(?:ed)?|detention|shortage|missing|wrong|closed|not available|missed appointment|appointment (?:problem|issue|blocked|failed|missed)|reschedule|hold overnight)\b/i.test(value);
  return hasOperationalSubject && hasProblem;
}

function hasOperationalClearEvidence(text) {
  const value = currentMessageText(String(text || "")).replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (/\b(?:not|still|remains?|remain|waiting|pending|cannot|can't|unable|blocked|problem|issue)\b[^.;\n]{0,80}\b(?:resolved|clear|cleared|closed|all good|ok to proceed)\b/i.test(value)) return false;
  return /\b(?:resolved|all good|case closed|ok to proceed|good to proceed|cleared to proceed|clear to proceed|no further action|no action needed|nothing (?:else )?(?:needed|required)|no need to do anything|do(?:es)?n'?t need to do anything|you do(?:n'?t| not) need to do anything|we do(?:n'?t| not) need to do anything|we all did our part|all did our part|shipment all good)\b/i.test(value);
}

function stationDeskFromRecipients(recipientsText) {
  const recipients = String(recipientsText || "").split(/[,;]+/)
    .map((item) => addressEmail(item)).filter(Boolean)
    .filter((email) => !/@(demo-freight\.example|harbor-forwarding\.example)\b/i.test(email));
  if (!recipients.length) return "";
  // Prefer the station group/imports desk inbox over individuals.
  return recipients.find((email) => /^(?:grp[-.]|imports?[-.]|.*imports?@|.*cargo@|.*station@)/i.test(email)) ||
    recipients.find((email) => /\.aero$|@united(?:hq)?\.com$|@aa\.com$|@delta\.com$/i.test(email)) ||
    recipients[0];
}

function contactLooksLikeAirlineOrOriginStaff(contact = {}) {
  const text = `${contact.broker || contact.name || ""} ${contact.email || ""}`.toLowerCase();
  return /@(?:united(?:hq)?\.com|aa\.com|delta\.com|fritz\.co\.il)\b|\.aero\b|\bairline\b/i.test(text);
}

function addExceptionEvents(events, awb, message, text) {
  if (hasOperationalClearEvidence(text)) return;
  let matched = false;
  const matchedTypes = new Set();
  for (const rule of operationalExceptionRules()) {
    if (!rule.pattern.test(text)) continue;
    if (rule.unless?.test(text)) continue;
    if (rule.type === "customs-hold" && hasCustomsReleaseResolutionEvidence(text)) continue;
    // Specificity: an inbond rejection IS the customs hold — do not double-classify the same
    // message with the generic hold rule (same-source exceptions merge and lose the specific one).
    if (rule.type === "customs-hold" && matchedTypes.has("inbond-rejected")) continue;
    matchedTypes.add(rule.type);
    matched = true;
    // Retain a windowed quote of the matched source text: downstream
    // classifiers need the detail ("closed until Monday", "3 days storage"),
    // not just the canned classification.
    const patternMatch = text.match(rule.pattern);
    const quote = patternMatch
      ? (() => {
          // Snap the left edge to a whitespace boundary: a mid-token cut once
          // truncated a sibling AWB and made a group fact look foreign.
          let start = Math.max(0, (patternMatch.index || 0) - 40);
          while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
          const end = Math.min(text.length, (patternMatch.index || 0) + patternMatch[0].length + 100);
          const window = text.slice(start, end).replace(/\s+/g, " ").trim();
          return window ? ` — "${window.slice(0, 180)}"` : "";
        })()
      : "";
    if (
      rule.type === "broker-release-pending" &&
      quote &&
      differentAwbMentions(quote, awb).length &&
      !extractMentionedAwbs(quote).includes(normalizeAwb(awb))
    ) {
      continue;
    }
    addThreadEvent(events, awb, "exception", message, `${rule.summary}${quote}`, {
      id: [normalizeAwb(awb), "exception", rule.type, message.threadId || "", message.id || ""].filter(Boolean).join(":"),
      exceptionType: rule.type,
      severity: rule.severity,
      where: rule.where || "unknown",
      impact: rule.impact || rule.type,
      status: "open",
      nextAction: rule.nextAction,
    });
  }
  if (!matched && nonExceptionExecutionUpdateText(text)) return;
  if (matched || !unclassifiedExceptionSignal(text)) return;
  const where = inferExceptionWhere(text);
  addThreadEvent(events, awb, "exception", message, "Operational exception was reported, but it does not match a named exception yet.", {
    id: [normalizeAwb(awb), "exception", "unclassified-operational-exception", message.threadId || "", message.id || ""].filter(Boolean).join(":"),
    exceptionType: "unclassified-operational-exception",
    severity: "urgent",
    where,
    impact: "unknown-blocker",
    status: "open",
    nextAction: "Review the thread, identify the blocker, and decide the operator move.",
  });
}

function extractQuoteAmount(text) {
  const match = String(text || "").match(/\$\s*\d+(?:,\d{3})*(?:\.\d+)?|\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:usd|all[-\s]?in)\b/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function inferBrokerFromMessage(message, fallback = "") {
  const fromEmail = addressEmail(message.from || "");
  const knownFrom = knownBrokerNameFromEmail(fromEmail);
  if (!isPikiSender(message)) {
    const fromContact = { name: addressName(message.from || ""), email: fromEmail };
    // Sender role check: a forwarder desk / origin agent / consignee sending a pre-alert is
    // NOT the broker just because it hit "send". When the sender looks like a non-broker
    // party, prefer a broker-looking recipient from the same message (the party the routing
    // instruction is addressed TO), before falling back to the sender.
    if (!knownFrom && contactLooksLikeNonBrokerRecipient(fromContact)) {
      const recipients = externalRecipients(message);
      const brokerRecipient = recipients.find((contact) => contactLooksLikeCustomsBroker(contact)) ||
        recipients.find((contact) => !contactLooksLikeNonBrokerRecipient(contact));
      if (brokerRecipient?.email || brokerRecipient?.name) {
        return {
          broker: knownBrokerNameFromEmail(brokerRecipient.email) || brokerRecipient.name || brokerRecipient.email,
          email: brokerRecipient.email || "",
        };
      }
    }
    return {
      broker: knownFrom || fallback || fromContact.name || fromEmail,
      email: fromEmail,
    };
  }
  const external = externalRecipients(message).find((contact) => !contactLooksLikeNonBrokerRecipient(contact)) || externalRecipients(message)[0];
  const knownExternal = knownBrokerNameFromEmail(external?.email);
  if (external?.name || external?.email) return { broker: knownExternal || external.name || external.email, email: external.email || "" };
  return {
    broker: knownFrom || fallback || addressName(message.from || "") || fromEmail,
    email: fromEmail,
  };
}

function contactLooksLikeNonBrokerRecipient(contact = {}) {
  const text = `${contact.name || ""} ${contact.email || ""}`.toLowerCase();
  return /@(northstar-components\.example|cedar-energy\.example|cedar-dental\.example|dhl\.com|kuehne-nagel\.com|juniper-logistics\.example)\b/i.test(text) ||
    /\b(?:northstar components|enercon|align|dhl|kuehne|consignee|customer|importer|forwarder|export operations?|operation ?team)\b/i.test(text);
}

function contactLooksLikeCustomsBroker(contact = {}) {
  const text = `${contact.name || ""} ${contact.email || ""}`;
  return Boolean(knownBrokerNameFromEmail(contact.email)) ||
    /\b(?:customs|broker|clearance|cedar dispatch|maple|port air|translink)\b/i.test(text);
}

function hasCustomsBrokerRoutingEvidence(text) {
  return /\b(?:pre[-\s]?alert|3461|7501|full set(?: of)? documents?|customs docs?|clearance docs?|release package|airway bill|awb docs?|commercial invoice|packing list)\b/i.test(String(text || ""));
}

function inferCustomsBrokerFromRoutingMessage(message) {
  const recipient = externalRecipients(message).find(contactLooksLikeCustomsBroker);
  if (recipient) {
    return {
      broker: knownBrokerNameFromEmail(recipient.email) || recipient.name || recipient.email,
      email: recipient.email || "",
    };
  }
  const from = { name: addressName(message.from || ""), email: addressEmail(message.from || "") };
  if (!isPikiSender(message) && contactLooksLikeCustomsBroker(from)) {
    return {
      broker: knownBrokerNameFromEmail(from.email) || from.name || from.email,
      email: from.email || "",
    };
  }
  return null;
}

function brokerIdentity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\b(?:inc|llc|ltd|co|company|corp|corporation|freight|logistics|solutions|services|brokerage|brokers?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function quoteMatchesBroker(quote, broker) {
  const quoteEmail = addressEmail(quote?.email || quote?.contactEmail || "");
  const brokerEmail = addressEmail(broker?.email || broker?.contactEmail || "");
  if (quoteEmail && brokerEmail && quoteEmail.toLowerCase() === brokerEmail.toLowerCase()) return true;
  const quoteKnown = knownBrokerNameFromEmail(quoteEmail);
  const brokerKnown = knownBrokerNameFromEmail(brokerEmail);
  const quoteName = brokerIdentity(quoteKnown || quote?.broker || quoteEmail);
  const brokerName = brokerIdentity(brokerKnown || broker?.broker || brokerEmail);
  if (!quoteName || !brokerName) return false;
  return quoteName === brokerName ||
    (quoteName.length >= 5 && brokerName.includes(quoteName)) ||
    (brokerName.length >= 5 && quoteName.includes(brokerName));
}

function scopedThreadMessages(awb, thread, options = {}) {
  const groupScope = inferPickupThreadGroupScope(awb, thread, options);
  const target = normalizeAwb(awb);
  const activeAwbs = (options.knownAwbs || []).length ? options.knownAwbs : [target];
  return (thread.messages || []).filter((message) =>
    !nearMissActiveAwbsInMessage(message, activeAwbs).includes(target) &&
    (groupScope?.applies ? groupScope.applies(message) : messageBelongsToAwb(awb, message, options))
  );
}

function scopedThreadText(awb, thread, options = {}) {
  return scopedThreadMessages(awb, thread, options)
    .map((message) => [message.subject, currentMessageText(message.text)].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n");
}

function scopedThreadAttachments(awb, thread, options = {}) {
  return scopedThreadMessages(awb, thread, options)
    .flatMap((message) => message.attachments.map((attachment) => ({
      ...attachment,
      messageId: attachment.messageId || message.id,
      at: attachment.at || message.internalDate || "",
    })));
}

function extractOperationalEvents(awb, thread, options = {}) {
  const events = [];
  const groupScope = inferPickupThreadGroupScope(awb, thread, options);
  const messages = scopedThreadMessages(awb, thread, options).slice().sort((a, b) => Date.parse(a.internalDate || "") - Date.parse(b.internalDate || ""));
  const threadContext = scopedThreadText(awb, thread, options);
  let latestQuoteBroker = null;
  let latestPickupCarrierName = "";
  const quoteBrokerHistory = [];
  for (const sourceMessage of messages) {
    const nearMissAwbs = nearMissActiveAwbsInMessage(sourceMessage, options.knownAwbs || []);
    const message = nearMissAwbs.length ? { ...sourceMessage, nearMissAwbs } : sourceMessage;
    const currentBody = awbLocalMessageText(awb, message.text || "");
    const fullBody = awbLocalFullMessageText(awb, message.text || "");
    const rawCurrentBody = currentMessageText(message.text || "");
    const attachmentText = usefulAttachmentText(message);
    const text = [currentBody, attachmentText].filter(Boolean).join(" ");
    const terminalText = [
      text,
      courierCloudTerminalTextForAwb(awb, message, rawCurrentBody),
    ].filter(Boolean).join(" ");
    const brokerDispatchText = pikiBrokerDispatchEvidenceText(awb, message, currentBody, rawCurrentBody, fullBody);
    const eventMessage = { ...message, text: text || currentBody || message.subject || "" };
    for (const attachment of message.attachments || []) {
      if (!attachment.arrivalVisionConfirmed) continue;
      const scopedAwbs = (attachment.arrivalVisionAwbs || []).map(normalizeAwb).filter(Boolean);
      if (!scopedAwbs.includes(normalizeAwb(awb))) continue;
      const vision = attachment.arrivalNoticeVisionEvidence || {};
      // carrier-arrival-confirmed is certifying by type downstream. Recheck the exact
      // fail-closed boundary here so a malformed/stale attachment marker can never mint it.
      if (!arrivalVisionResultCertifies(vision)) continue;
      const visionConfidence = vision.confidence;
      const evidence = [
        vision.reason.trim(),
        vision.station ? `Station: ${vision.station}.` : "",
        vision.arrivalDate ? `Document arrival date: ${vision.arrivalDate}.` : "",
      ].filter(Boolean).join(" ");
      addThreadEvent(events, awb, "carrier-arrival-confirmed", eventMessage,
        `Arrival-notice document confirms physical destination arrival${vision.onHand ? "/on-hand" : ""}.`, {
          source: "arrival-notice-vision",
          sourceSystem: "gmail_attachment",
          attachmentId: attachment.attachmentId || "",
          filename: attachment.filename || "",
          mimeType: attachment.mimeType || "",
          station: vision.station || "",
          arrivalDate: vision.arrivalDate || "",
          visionConfidence,
          evidence,
          evidenceKind: "actual",
          confidence: "high",
        });
    }
    // Dispatch-family events (broker alerted/confirmed/awarded) must not fire on customs
    // coordination threads: inbond/AMS/clearance/duty subjects are customs work even when a
    // reply is just "Confirm". True pickup threads say inbound alert/pickup/truck/recover.
    const customsCoordinationContext = (() => {
      const contextText = `${message.subject || ""}\n${threadContext || ""}`;
      return /\b(?:in-?bond|ams issue|ams\b|customs? clearance|custom clearance|clearance|pedimento|dut(?:y|ies)|3461|7501|entry)\b/i.test(contextText) &&
        !/\binbound alert\b/i.test(contextText) &&
        !/\b(?:pickup|pick up|truck|cartage|recover|delivery order)\b/i.test(`${message.subject || ""}`);
    })();
    const dispatchEventMessage = brokerDispatchText
      ? { ...message, text: brokerDispatchText }
      : eventMessage;
    const announcedPickupCarrier = !isPikiSender(message) ? pickupCarrierNameFromText(currentBody) : "";
    const customsRoutingBroker = hasCustomsBrokerRoutingEvidence(text)
      ? inferCustomsBrokerFromRoutingMessage(message)
      : null;
    if (groupScope?.groupInstructionMessageId && message.id === groupScope.groupInstructionMessageId && groupScope.groupAwbs?.length > 1) {
      const broker = groupScope.broker || inferBrokerFromMessage(message);
      addThreadEvent(events, awb, "shipment-group-linked", eventMessage, `Pickup thread links ${groupScope.groupAwbs.join(", ")} for shared broker execution.`, {
        groupAwbs: groupScope.groupAwbs,
        appliesToAwbs: groupScope.groupAwbs,
        broker: broker?.broker || "",
        contactEmail: broker?.email || "",
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Propagate later broker replies in this scoped thread to every linked AWB unless a newer message narrows or cancels the scope.",
      });
    }
    if (hasOperationalClearEvidence(currentBody)) {
      addThreadEvent(events, awb, "operational-clear", eventMessage, "Operational blocker was reported resolved/closed.", {
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Continue from current TMS/station state; do not keep older email blockers open without newer contrary evidence.",
      });
    }
    if (customsRoutingBroker?.broker || customsRoutingBroker?.email) {
      addThreadEvent(events, awb, "customs-broker-inferred", eventMessage, `${customsRoutingBroker.broker || "Customs broker"} received customs/pre-alert documents.`, {
        broker: customsRoutingBroker.broker || "",
        contactEmail: customsRoutingBroker.email || "",
        where: "customs",
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Use this broker contact for release/DO follow-up; document routing alone does not prove release.",
      });
    }
    if (isPikiSender(message) && hasBrokerDisregardEvidence(rawCurrentBody || currentBody)) {
      const broker = inferBrokerFromMessage(message, groupScope?.broker?.broker || latestQuoteBroker?.broker || "");
      addThreadEvent(events, awb, "broker-disregarded", eventMessage, `${broker.broker || "Broker"} was canceled/disregarded for pickup.`, {
        broker: broker.broker || "",
        selectedBroker: broker.broker || "",
        contactEmail: broker.email || "",
        groupAwbs: groupScope?.groupAwbs || [],
        appliesToAwbs: groupScope?.groupAwbs || [normalizeAwb(awb)].filter(Boolean),
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Do not treat this broker as the active pickup owner unless a newer award/confirmation supersedes the cancellation.",
      });
    }
    if (isPikiSender(message) && brokerDispatchText && externalRecipients(message).length) {
      const broker = inferBrokerFromMessage(message, groupScope?.broker?.broker || "");
      if (customsCoordinationContext || contactLooksLikeAirlineOrOriginStaff(broker)) { /* customs/station coordination, not pickup dispatch */ } else
      addThreadEvent(events, awb, "broker-alerted", dispatchEventMessage, `${broker.broker || "Broker"} received the pickup/inbound alert.`, {
        broker: broker.broker || "",
        selectedBroker: broker.broker || "",
        contactEmail: broker.email || "",
        groupAwbs: groupScope?.groupAwbs || [],
        appliesToAwbs: groupScope?.groupAwbs || [normalizeAwb(awb)].filter(Boolean),
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Wait for broker acknowledgement or pickup execution proof; do not ask who the pickup broker is unless this path is canceled.",
      });
    }
    if (!isPikiSender(message) && pickupBrokerAcknowledgementContextLooksActive(message, threadContext) && hasBrokerAcknowledgementEvidence(currentBody || rawCurrentBody)) {
      const broker = inferBrokerFromMessage(message, groupScope?.broker?.broker || "");
      if (customsCoordinationContext) { /* customs coordination, not pickup dispatch */ } else
      addThreadEvent(events, awb, "broker-confirmed", eventMessage, `${broker.broker || "Broker"} acknowledged the pickup/inbound alert.`, {
        broker: broker.broker || "",
        selectedBroker: broker.broker || "",
        contactEmail: broker.email || "",
        groupAwbs: groupScope?.groupAwbs || [],
        appliesToAwbs: groupScope?.groupAwbs || [normalizeAwb(awb)].filter(Boolean),
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Track pickup execution with this broker; collect loaded proof/POD rather than rediscovering the pickup owner.",
      });
    }
    if (announcedPickupCarrier) {
      latestPickupCarrierName = announcedPickupCarrier;
      for (const event of events) {
        if (
          event.type === "exception" &&
          event.exceptionType === "pickup-docs-needed" &&
          !event.carrierName &&
          (!event.threadId || !message.threadId || event.threadId === message.threadId)
        ) {
          event.carrierName = announcedPickupCarrier;
          event.nextAction = `Generate/send the delivery order for ${announcedPickupCarrier}, then reply in the pickup thread.`;
        }
      }
    }
    if (hasWrongConsigneeRecoveryContext(currentBody, fullBody) && !WRONG_CONSIGNEE_DELIVERY_PATTERN.test(text)) {
      addWrongConsigneeRecoveryEvent(events, awb, message, fullBody);
    }
    addExceptionEvents(events, awb, eventMessage, [message.subject || "", text].filter(Boolean).join("\n"));
    if (hasConnectionTransferResolvedEvidence(currentBody || text)) {
      addThreadEvent(events, awb, "connection-transfer-resolved", eventMessage, "Connection transfer/UA handoff was resolved for onward flight.", {
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Monitor destination arrival; do not keep the old transfer exception open.",
      });
    }
    if (!isPikiSender(message) && hasPickupLocationRequestEvidence(currentBody)) {
      const station = pickupRequestStationFromText(currentBody || message.subject || "");
      addThreadEvent(events, awb, "exception", eventMessage, "Pickup broker asked for the airport pickup location.", {
        id: [normalizeAwb(awb), "exception", "pickup-location-requested", message.threadId || "", message.id || ""].filter(Boolean).join(":"),
        exceptionType: "pickup-location-requested",
        severity: "immediate",
        where: "pickup",
        impact: "pickup-location-needed",
        status: "open",
        requestedStation: station,
        nextAction: `Reply in the pickup thread with the ${station || "airport"} pickup location.`,
      });
    }
    if (!isPikiSender(message) && hasPickupDocsNeededEvidence(currentBody)) {
      const carrierName = pickupCarrierNameFromText(currentBody) || latestPickupCarrierName;
      const awbCopyNeeded = hasAwbCopyNeededEvidence(currentBody);
      addThreadEvent(events, awb, "exception", eventMessage, "Pickup broker needs remaining pickup docs or delivery order.", {
        id: [normalizeAwb(awb), "exception", awbCopyNeeded ? "awb-copy-needed" : "pickup-docs-needed", message.threadId || "", message.id || ""].filter(Boolean).join(":"),
        exceptionType: awbCopyNeeded ? "awb-copy-needed" : "pickup-docs-needed",
        severity: "immediate",
        where: "pickup",
        impact: awbCopyNeeded ? "awb-copy-needed" : "pickup-docs-needed",
        status: "open",
        carrierName,
        nextAction: awbCopyNeeded
          ? "Send the AWB copy/air waybill in the existing pickup thread."
          : carrierName
          ? `Generate/send the delivery order for ${carrierName}, then reply in the pickup thread.`
          : "Generate/send the delivery order or missing docs, then reply in the pickup thread.",
      });
    }
    if (isPikiSender(message) &&
      /\b(?:confirm[^.?\n;]{0,40}on[-\s]?hand|on[-\s]?hand[^.?\n;]{0,40}confirm|share (?:the )?arrival notice|send (?:the )?arrival notice|confirm (?:if|whether)[^.?\n;]{0,60}(?:on hand|arrived|received))\b/i.test(currentBody)) {
      // Our own on-hand/arrival ask is not truth, but its RECIPIENTS are the live station
      // contacts — recorded as a pending signal so relations and actions can name the desk.
      addThreadEvent(events, awb, "station-ask-sent", eventMessage, "We asked the station/handler to confirm on-hand and share the arrival notice.", {
        evidenceKind: "pending",
        confidence: messageMentionsAwb(awb, message) ? "medium" : "low",
        // The station desk is often only CC'd and the compacted to-field truncates at 160
        // chars — choose the desk here and store it in contactEmail, which always survives.
        contactEmail: stationDeskFromRecipients([message.to, message.cc].filter(Boolean).join(", ")),
        to: [message.to, message.cc].filter(Boolean).join(", "),
      });
    }
    if (isPikiSender(message) && hasPickupLocationReplyEvidence(currentBody)) {
      addThreadEvent(events, awb, "pickup-location-replied", eventMessage, "Airport pickup location was sent to the pickup broker.", {
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
      });
    }
    if (isPikiSender(message) && hasPickupDocsSentEvidence(currentBody, message)) {
      addThreadEvent(events, awb, "pickup-docs-sent", eventMessage, "Pickup docs/delivery order were sent to the pickup broker.", {
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
      });
    }
    const amount = extractQuoteAmount(currentBody);
    const quoteLike = (hasPickupQuoteEvidence(currentBody) || hasTersePickupQuoteReplyEvidence(currentBody, message, threadContext)) && amount &&
      !hasCustomsReleaseQuoteNoise(currentBody) &&
      !hasDeliveredReportedEvidence(currentBody) &&
      !hasPodPendingEvidence(currentBody);
    if (quoteLike && !isPikiSender(message)) {
      latestQuoteBroker = {
        ...inferBrokerFromMessage(message),
        amount,
      };
      quoteBrokerHistory.push(latestQuoteBroker);
      addThreadEvent(events, awb, "pickup-quote-received", eventMessage, `${latestQuoteBroker.broker || "Broker"} quoted ${amount}.`, {
        ...latestQuoteBroker,
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
      });
    }

    if (
      isPikiSender(message) &&
      (/\b(?:approved|approve|confirmed|confirm|please proceed|go ahead|award(?:ed)?)\b/i.test(currentBody) ||
        /(?:מאושר|אושר|אישרתי|תאשר|אפשר להתקדמ|תתקדמו|תמשיכו|תוציאו)/.test(normalizedHebrewLogisticsText(currentBody))) &&
      !(/\b(?:not approved|do not proceed|cancel)\b/i.test(currentBody) ||
        /(?:לא מאושר|אל תתקדמ|לבטל|ביטול)/.test(normalizedHebrewLogisticsText(currentBody)))
    ) {
      // Approving duties/inbond/customs coordination is NOT a pickup award: the award event
      // requires trucking/dispatch context and must never fire from a customs-work approval —
      // and a bare "Confirm" on a customs-coordination THREAD is customs work too.
      if (customsCoordinationContext) continue;
      if (/\b(?:duty|duties|in-?bond|retransmit|3461|7501|customs entry|pedimento)\b/i.test(currentBody) &&
        !/\b(?:pickup|pick up|inbound alert|truck|recover|dispatch|cartage|delivery order)\b/i.test(currentBody)) {
        continue;
      }
      // "Can you please confirm all good from your side?" is an ASK, not an award — without
      // explicit approval/award/proceed language, ask-form confirm never dispatches a broker.
      const approvalAskOnly = !/\b(?:approved?|award(?:ed)?|go ahead|please proceed)\b/i.test(currentBody) &&
        /\b(?:can you|could you|pls|please)\b[^.?\n;]{0,50}\b(?:check and\s+)?(?:confirm|advise)\b/i.test(currentBody);
      if (approvalAskOnly) continue;
      const broker = inferBrokerFromMessage(message, latestQuoteBroker?.broker || "");
      if (contactLooksLikeAirlineOrOriginStaff(broker)) continue;
      const explicitAmount = extractQuoteAmount(currentBody);
      const matchedQuote = quoteBrokerHistory.slice().reverse().find((quote) => quoteMatchesBroker(quote, broker));
      if (hasStationConfirmationRequestEvidence(currentBody) && !matchedQuote) continue;
      if (hasMisdeliveryRecoveryFollowUpEvidence(currentBody)) continue;
      const selectedAmount = explicitAmount || matchedQuote?.amount || "";
      addThreadEvent(
        events,
        awb,
        "broker-awarded",
        eventMessage,
        `${broker.broker || "Broker"} was approved for pickup${selectedAmount ? ` at ${selectedAmount}` : ""}.`,
        {
          broker: broker.broker || matchedQuote?.broker || "",
          contactEmail: broker.email || matchedQuote?.email || "",
          amount: selectedAmount,
          selectedBroker: broker.broker || matchedQuote?.broker || "",
          confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        },
      );
    }

    if (
      /\b(?:driver|truck|trucker)\b[^.\n;]{0,120}\b(?:on[-\s]?site|onsite|at (?:the )?(?:airport|station|terminal)|waiting|standby|sitting)\b/i.test(text) &&
      /\b(?:airport|station|terminal|airline|warehouse)\b[^.\n;]{0,140}\b(?:can'?t|cannot|doesn'?t|does not|don'?t|do not|not)\b[^.\n;]{0,120}\b(?:see|show|have|find|release|clearance|clear|d\/?o|delivery order|load)\b/i.test(text)
    ) {
      addThreadEvent(events, awb, "pickup-blocker", eventMessage, "Driver is onsite, but the station cannot see release/DO or will not load.", {
        urgency: "immediate",
        problem: "driver onsite; station cannot see release/DO",
      });
    }

    const pickupConfirmed = hasPickupConfirmedEvidence(currentBody || text, message, threadContext);
    const contextualPickupSchedule = hasContextualPickupScheduleReplyEvidence(currentBody || text, message, threadContext);
    const pickupScheduled = !pickupConfirmed &&
      (hasPickupScheduledEvidence(currentBody || text, message, threadContext) || contextualPickupSchedule);
    if (pickupScheduled) {
      const priorPickupSchedule = latestEvent(events, ["pickup-scheduled"]);
      const currentFirstLine = currentMessageText(String(currentBody || text || ""))
        .split(/\n+/).map((line) => line.trim()).find(Boolean) || "";
      const terseAcceptance = contextualPickupSchedule && /^(?:10-4|received|got it|ok|okay|will do)[.! ]*$/i.test(currentFirstLine);
      const scheduledDate = terseAcceptance && priorPickupSchedule?.pickupScheduledDate
        ? priorPickupSchedule.pickupScheduledDate
        : pickupDateFromThreadText(
          contextualPickupSchedule ? `${currentBody || text}\n${threadContext}` : currentBody || text,
          message.internalDate,
        );
      addThreadEvent(events, awb, "pickup-scheduled", eventMessage, scheduledDate
        ? `Pickup is scheduled/deferred for ${scheduledDate}; wait for actual pickup proof.`
        : "Pickup is scheduled/deferred; wait for actual pickup proof.", {
        pickupScheduledDate: scheduledDate,
        scheduledDate,
        evidenceKind: "future",
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Do not treat pickup as complete; follow up at the scheduled pickup time and collect loaded proof/POD after pickup.",
      });
    }
    if (!pickupConfirmed && !isPikiSender(message) && hasPickupOnsiteEvidence(currentBody)) {
      addThreadEvent(events, awb, "pickup-onsite", eventMessage, "Carrier/driver is onsite for pickup; loading proof is still needed.", {
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
        nextAction: "Watch for loaded proof; if it stalls, find the airport blocker before detention grows.",
      });
    }

    if (pickupConfirmed) {
      addThreadEvent(events, awb, "pickup-confirmed", eventMessage, "Pickup is confirmed; track delivery and POD.", {
        deliveryScheduledDate: deliveryDateFromThreadText(currentBody || text, message.internalDate),
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
      });
    }

    const deliveryScheduled = hasDeliveryScheduledEvidence(text) ||
      (!isPikiSender(message) && hasTerseDeliveryScheduleReplyEvidence(currentBody || text, threadContext));
    if (deliveryScheduled) {
      const deliveryScheduledDate = deliveryDateFromThreadText(text, message.internalDate) ||
        deliveryDateFromThreadText(`delivery ${currentBody || text}`, message.internalDate);
      const deliveryBroker = !isPikiSender(message) && pickupBrokerAcknowledgementContextLooksActive(message, threadContext)
        ? inferBrokerFromMessage(message, groupScope?.broker?.broker || "")
        : null;
      addThreadEvent(events, awb, "delivery-scheduled", eventMessage, "Delivery is scheduled; collect POD after completion.", {
        deliveryScheduledDate,
        evidenceKind: "future",
        broker: deliveryBroker?.broker || "",
        selectedBroker: deliveryBroker?.broker || "",
        contactEmail: deliveryBroker?.email || "",
        confidence: messageMentionsAwb(awb, message) ? "high" : "medium",
      });
    }

    const groundFeeText = [message.subject, text].filter(Boolean).join(" ");
    if (hasGroundFeesPaidEvidence(groundFeeText)) {
      addThreadEvent(events, awb, "ground-fees-paid", eventMessage, "Ground handling fees/payment were confirmed.");
    }

    const releasePdfAttachment = (message.attachments || []).find((attachment) =>
      /(?:-DO\b|delivery[-_ ]?order|release)/i.test(String(attachment.filename || "")) &&
      /\.pdf$/i.test(String(attachment.filename || "")));
    if (releasePdfAttachment && !isPikiSender(message) &&
      !hasCustomsReleaseNegativeEvidence(text) &&
      !/\bpre[-\s]?alert\b/i.test(`${message.subject || ""} ${text}`)) {
      addThreadEvent(events, awb, "customs-release-received", eventMessage,
        `Release/Delivery Order document received as attachment (${releasePdfAttachment.filename}).`, {
          confidence: "medium",
        });
    }

    if (hasArrivalNegativeEvidence(text) && !hasArrivalPositiveEvidence(text)) {
      addThreadEvent(events, awb, "arrival-negative-reported", eventMessage, "Station/handler reports the freight is not on hand (at origin / not in system / not arrived).", {
        evidenceKind: "pending",
      });
    }

    if (hasGroundFeesDemandEvidence(text) && !hasGroundFeesPaidEvidence(text)) {
      addThreadEvent(events, awb, "ground-fees-demanded", eventMessage, "A station/handler fee demand with an amount was presented and is unpaid.", {
        evidenceKind: "pending",
      });
    }

    // A counterparty asking about state / requesting an update is a
    // COMMUNICATION work item, never truth: it mints its own typed event so
    // the planner can draft a safe reply and the companion can explain it.
    if (!isPikiSender(message) && isStatusRequest(text)) {
      const fromRaw = String(message.from || "").trim();
      const requester = (fromRaw.match(/^"?([^"<]+?)"?\s*</) || [])[1] || fromRaw;
      addThreadEvent(events, awb, "status-update-requested", eventMessage, `${requester || "A counterparty"} asked for a status update; a reply is owed.`, {
        evidenceKind: "pending",
      });
    }

    if (hasArrivalPositiveEvidence(text)) {
      addThreadEvent(events, awb, "arrival-notice-received", eventMessage, "Arrival/on-hand evidence was received.");
    }

    const customsReleaseEvidenceText = [message.subject || "", text].filter(Boolean).join("\n");
    if (hasCustomsReleasePositiveEvidence(customsReleaseEvidenceText)) {
      addThreadEvent(events, awb, "customs-release-received", eventMessage, "Customs release/DO evidence was received.");
    } else {
      const rawMentions = extractMentionedAwbs(rawCurrentBody);
      const target = normalizeAwb(awb);
      const mentionsOtherAwbOnly = rawMentions.length && !rawMentions.includes(target) && rawMentions.some((item) => item !== target);
      if (mentionsOtherAwbOnly && hasCustomsReleasePositiveEvidence(rawCurrentBody)) {
        addThreadEvent(events, awb, "exception", eventMessage, "Clearance/release reply quoted a different MAWB, so this AWB's release scope is not proven.", {
          id: [normalizeAwb(awb), "exception", "clearance-scope-ambiguous", message.threadId || "", message.id || ""].filter(Boolean).join(":"),
          exceptionType: "clearance-scope-ambiguous",
          severity: "urgent",
          where: "customs",
          impact: "release-scope-unknown",
          status: "open",
          mentionedAwbs: rawMentions,
          confidence: "high",
          nextAction: "Ask the broker/operator to confirm release/DO for this exact AWB; keep any broker pickup relation visible while release scope is verified.",
        });
      }
    }

    const podReceived = hasPqAcceptedPodEvidence(terminalText || text, message) ||
      hasUsefulPodAttachment(message) ||
      hasPodReceivedEvidence(terminalText || text) ||
      hasCourierCloudDeliveredStatusText(terminalText);
    const podPending = hasPodPendingEvidence(text) && !podReceived;
    const finalDeliveryEvidence = finalDeliveryEvidenceSnippet(terminalText) ||
      finalDeliveryEvidenceSnippet(text) ||
      finalDeliveryEvidenceSnippet(currentBody);
    if (hasDeliveredReportedEvidence(terminalText || text) || hasCourierCloudDeliveredStatusText(terminalText)) {
      addThreadEvent(events, awb, "delivered-reported", eventMessage, "Delivery was reported; verify and collect the signed POD.", {
        confidence: messageMentionsAwb(awb, message) || hasPqAcceptedPodEvidence(text, message) || hasUsefulPodAttachment(message) ? "high" : "medium",
        ...(finalDeliveryEvidence ? { evidence: finalDeliveryEvidence } : {}),
      });
    }

    if (podPending) {
      addThreadEvent(events, awb, "pod-pending", eventMessage, "Delivery or pickup update says POD is still pending.", {
        evidenceKind: "pending",
      });
    }

    if (podReceived) {
      const groupAwbsList = (groupScope?.groupAwbs || []).map(normalizeAwb).filter(Boolean);
      const groupSize = groupAwbsList.length;
      const nativePodMessage = messageBelongsToAwb(awb, message, options);
      // Plural POD wording whose POD-class attachment count covers the whole workgroup
      // applies to every member; narrowing wording ("only 342", "this one only") vetoes.
      const groupCoveringPod = groupSize > 1 &&
        hasPluralPodWording(text) &&
        podClassAttachmentCount(message) >= groupSize &&
        !hasGroupScopeNarrowingText(text);
      if (nativePodMessage || groupCoveringPod) {
        addThreadEvent(events, awb, "pod-received", eventMessage, "Delivery/POD evidence was received.", {
          confidence: messageMentionsAwb(awb, message) || hasPqAcceptedPodEvidence(text, message) || hasUsefulPodAttachment(message) || groupCoveringPod ? "high" : "medium",
          ...(finalDeliveryEvidence ? { evidence: finalDeliveryEvidence } : {}),
          ...(groupCoveringPod ? { groupAwbs: groupAwbsList, appliesToAwbs: groupAwbsList } : {}),
        });
      } else {
        // The message reached this AWB only through the thread workgroup and the POD
        // statement cannot be confidently assigned to this sibling (singular wording or
        // fewer POD files than grouped shipments): surface a review/assignment item —
        // never a silent sibling close, never a silent drop.
        addThreadEvent(events, awb, "pod-attachment-unverified", eventMessage,
          "POD evidence arrived in the linked group thread but needs review/assignment for this AWB (singular wording or fewer POD files than grouped shipments).", {
            evidenceKind: "pending",
            confidence: "medium",
            ...(groupSize > 1 ? { groupAwbs: groupAwbsList } : {}),
          });
      }
    }

    // A POD-named or image attachment that cannot be verified (no extractable content, no POD
    // wording) must not vanish: surface it as present-but-unread so the operator reviews it
    // instead of the shipment silently staying POD-less (or worse, silently closing out).
    if (!podReceived && hasUnverifiedPodClassAttachment(message)) {
      addThreadEvent(events, awb, "pod-attachment-unverified", eventMessage,
        "A POD-class attachment (image/unreadable file) is present but its content could not be verified in this refresh; human review needed.", {
          evidenceKind: "pending",
          confidence: "medium",
        });
    }
  }
  return mergeEvents(events);
}

function deliveryDateFromThreadText(text, at = "") {
  const base = Number.isFinite(Date.parse(at)) ? new Date(at) : new Date();
  const hebrew = normalizedHebrewLogisticsText(text);
  if (/\b(?:deliver|delivery|delivering|out for delivery)\b.{0,80}\btomorrow\b/i.test(text) ||
    /(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר).{0,60}מחר|מחר.{0,60}(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר)/.test(hebrew)) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + 1, 12));
    return date.toISOString().slice(0, 10);
  }
  if (/\b(?:deliver|delivery|delivering|out for delivery)\b.{0,80}\btoday\b/i.test(text) ||
    /(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר).{0,60}היומ|היומ.{0,60}(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר)/.test(hebrew)) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 12));
    return date.toISOString().slice(0, 10);
  }
  const match = String(text || "").match(/\b(?:deliver|delivery|delivering|appointment|appt|eta)\b[^.;\n]{0,80}\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  if (!match) return "";
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function dateKeyFromDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function operatorDateParts(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: OPERATOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

function addDaysOperatorDateKey(base = new Date(), days = 0) {
  const parts = operatorDateParts(base);
  if (!parts) return dateKeyFromDate(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 12)));
  return dateKeyFromDate(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12)));
}

function pickupDateFromThreadText(text, at = "") {
  const base = Number.isFinite(Date.parse(at)) ? new Date(at) : new Date();
  const value = String(text || "");
  if (/\btomorrow(?:\s+(?:morning|afternoon|evening|night))?\b/i.test(value)) return addDaysOperatorDateKey(base, 1);
  if (/\b(?:today|tonight|later today|this morning|this afternoon|this evening)\b/i.test(value)) return addDaysOperatorDateKey(base, 0);
  const weekdayMatch = value.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (weekdayMatch) {
    const targetDay = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
      .indexOf(weekdayMatch[1].toLowerCase());
    const delta = (targetDay - base.getUTCDay() + 7) % 7;
    return addDaysOperatorDateKey(base, delta);
  }
  const match = value.match(/\b(?:pickup|pick up|recover|recovery|load|loading|appointment|appt)\b[^.;\n]{0,100}\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  if (!match) return "";
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function mergeEvents(events) {
  const map = new Map();
  for (const event of events || []) {
    const key = event.id || [event.awb, event.type, event.threadId, event.messageId, event.summary].join("|");
    if (key.replace(/\|/g, "")) map.set(key, event);
  }
  return [...map.values()].sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
}

function shipmentGroupKey(awbs = []) {
  const values = [...new Set((awbs || []).map(normalizeAwb).filter(Boolean))].sort();
  return values.length > 1 ? values.join("|") : "";
}

function recordEvents(record = {}) {
  return mergeEvents([
    ...(record.events || []),
    ...(record.emailValidation?.events || []),
  ]);
}

function collectShipmentGroups(recordsByAwb = new Map()) {
  const groups = new Map();
  for (const record of recordsByAwb.values()) {
    for (const event of recordEvents(record)) {
      const groupAwbs = Array.isArray(event.groupAwbs) ? event.groupAwbs : [];
      const key = shipmentGroupKey(groupAwbs);
      if (!key) continue;
      const current = groups.get(key) || new Set();
      for (const awb of groupAwbs.map(normalizeAwb).filter(Boolean)) current.add(awb);
      groups.set(key, current);
    }
  }
  return groups;
}

function eventLooksGroupScopedCompletion(event = {}) {
  if (!["pickup-confirmed", "delivered-reported", "pod-received"].includes(event.type)) return false;
  if (isPikiSender(event)) return false;
  // An event already stamped as applying to 2+ AWBs was group-qualified at emission time
  // (plural POD wording with attachment coverage of the workgroup): group-scoped by
  // construction — no wording re-check needed.
  const stampedApplies = new Set((event.appliesToAwbs || []).map(normalizeAwb).filter(Boolean));
  if (stampedApplies.size >= 2) return true;
  const text = `${event.summary || ""} ${event.evidence || ""} ${event.subject || ""}`.replace(/\s+/g, " ").trim();
  if (/\b(?:both|all|the\s+(?:two|2)|both\s+awbs?|all\s+awbs?|both\s+shipments?|all\s+shipments?)\b/i.test(text)) return true;
  if (require("./delivery-wait").groupMovementReference(text).together) return true;
  // Explicit enumeration also counts: the completion statement itself names 2+ AWBs of the
  // already-linked pickup group ("114-80000263 and 114-80000264 loaded"). Requires an existing
  // thread-level group (groupAwbs) so an unrelated AWB mention can never create propagation.
  const evidenceText = `${event.summary || ""} ${event.evidence || ""}`;
  const group = new Set((event.groupAwbs || []).map(normalizeAwb).filter(Boolean));
  if (group.size < 2) return false;
  const mentionedInGroup = [...new Set(extractMentionedAwbs(evidenceText).map(normalizeAwb).filter(Boolean))]
    .filter((awb) => group.has(awb));
  return mentionedInGroup.length >= 2;
}

// Scope-narrowing wording inside a group thread ("only 165", "except the second one",
// "just this AWB") means the statement must NOT propagate to siblings.
function hasGroupScopeNarrowingText(value = "") {
  return /\b(?:only|just|except|excluding|not the other|other (?:one|awb|shipment) (?:is|stays|remains)|this (?:awb|one|shipment) only|separately)\b/i.test(String(value || ""));
}

// Dispatch/paperwork events that apply group-wide when the thread itself is a linked pickup
// group: broker alert/award/disregard (Piki-sent by nature), release/DO and fee payment.
// Guards: an existing multi-AWB group, no scope-narrowing wording, and no out-of-group AWB
// contamination in the statement itself.
function eventLooksGroupScopedDispatch(event = {}) {
  if (![
    "broker-alerted",
    "broker-awarded",
    "broker-confirmed",
    "broker-disregarded",
    "customs-release-received",
    "ground-fees-paid",
  ].includes(event.type)) return false;
  const group = new Set((event.groupAwbs || []).map(normalizeAwb).filter(Boolean));
  if (group.size < 2) return false;
  const text = `${event.summary || ""} ${event.evidence || ""}`;
  if (hasGroupScopeNarrowingText(text)) return false;
  const mentioned = [...new Set(extractMentionedAwbs(text).map(normalizeAwb).filter(Boolean))];
  if (mentioned.some((awb) => !group.has(awb))) return false;
  // If the statement singles out exactly one group member by full AWB while the group is
  // larger, treat it as narrowed to that member — do not propagate.
  if (mentioned.length === 1 && group.size > 1 && mentioned[0] === normalizeAwb(event.awb)) return false;
  return true;
}

function cloneGroupScopedEvent(event = {}, targetRecord = {}, groupAwbs = []) {
  const targetAwb = targetRecord.awb || targetRecord.normalizedAwb || "";
  const nearMissAwbs = new Set((event.nearMissAwbs || []).map(normalizeAwb).filter(Boolean));
  const safeGroupAwbs = groupAwbs.map(normalizeAwb).filter((awb) => awb && !nearMissAwbs.has(awb));
  return {
    ...event,
    id: [
      normalizeAwb(targetAwb),
      event.type || "",
      "group-propagated",
      event.threadId || "",
      event.messageId || "",
    ].filter(Boolean).join(":"),
    awb: targetAwb,
    confidence: event.confidence === "high" ? "high" : "medium",
    evidenceKind: event.evidenceKind || "group-scoped",
    groupAwbs: safeGroupAwbs,
    appliesToAwbs: safeGroupAwbs,
  };
}

function applyPropagatedEventToRecord(record = {}, event = {}) {
  const events = mergeEvents([...(record.events || []), event]);
  const latestEventAt = newestIso(record.latestEventAt, event.at || "");
  const updated = {
    ...record,
    events,
    latestEventAt,
  };
  if (event.type === "pickup-confirmed" && eventTimestamp(event) >= recordTimestamp(record)) {
    updated.status = "pickup-evidence";
    updated.summary = "Pickup evidence found in a linked Gmail group thread.";
    updated.nextAction = "Track delivery/POD and detention if the driver waited.";
  }
  if (updated.emailValidation) {
    updated.emailValidation = {
      ...updated.emailValidation,
      events: mergeEvents([...(updated.emailValidation.events || []), event]),
      ...(event.type === "pickup-confirmed" && eventTimestamp(event) >= recordTimestamp(record)
        ? {
            status: "pickup-evidence",
            summary: "Pickup evidence found in a linked Gmail group thread.",
            nextAction: "Track delivery/POD and detention if the driver waited.",
          }
        : {}),
    };
  }
  return updated;
}

// Delivery-wait exceptions (facility closed / detention / storage cost) whose
// text says the shipments move together ("both shipments", "2 המטענים",
// "all three") apply to every AWB in the thread group.
function eventLooksGroupScopedException(event = {}) {
  if (event.type !== "exception") return false;
  if (!["delivery-facility-closed", "storage-or-detention-cost", "driver-waiting", "storage-needed-after-delivery-blocker"].includes(String(event.exceptionType || ""))) return false;
  const { groupMovementReference } = require("./delivery-wait");
  const text = `${event.summary || ""} ${event.evidence || ""} ${event.subject || ""}`;
  return groupMovementReference(text).together;
}

function propagateScopedGroupEvents(recordsByAwb = new Map()) {
  const groups = collectShipmentGroups(recordsByAwb);
  if (!groups.size) return recordsByAwb;
  for (const groupAwbsSet of groups.values()) {
    const groupAwbs = [...groupAwbsSet];
    const allGroupEvents = groupAwbs.flatMap((awb) => recordEvents(recordsByAwb.get(awb) || {}));
    const groupEvents = allGroupEvents.filter((event) =>
      eventLooksGroupScopedCompletion(event) || eventLooksGroupScopedDispatch(event) || eventLooksGroupScopedException(event));
    for (const event of groupEvents) {
      const eventAtMs = Date.parse(event.at || "") || 0;
      const nearMissAwbs = new Set((event.nearMissAwbs || []).map(normalizeAwb).filter(Boolean));
      for (const awb of groupAwbs) {
        if (nearMissAwbs.has(normalizeAwb(awb))) continue;
        const targetRecord = recordsByAwb.get(awb);
        if (!targetRecord) continue;
        const targetEvents = recordEvents(targetRecord);
        const alreadyHasEvent = targetEvents.some((existing) =>
          existing.type === event.type &&
          existing.threadId === event.threadId &&
          existing.messageId === event.messageId
        );
        if (alreadyHasEvent) continue;
        // Never propagate over a NEWER narrowing/cancellation on the target: a later
        // broker-disregarded or a later own-thread dispatch decision wins for that sibling.
        const newerTargetOverride = targetEvents.some((existing) =>
          ["broker-disregarded", "broker-awarded", "broker-confirmed"].includes(existing.type) &&
          (Date.parse(existing.at || "") || 0) > eventAtMs &&
          ["broker-alerted", "broker-awarded", "broker-confirmed", "broker-disregarded"].includes(event.type)
        );
        if (newerTargetOverride) continue;
        recordsByAwb.set(awb, applyPropagatedEventToRecord(
          targetRecord,
          cloneGroupScopedEvent(event, targetRecord, groupAwbs),
        ));
      }
    }
  }
  return recordsByAwb;
}

function normalizeHeaderValue(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

function normalizeDraftAttachment(attachment) {
  if (!attachment) return null;
  const entry = typeof attachment === "string" ? { path: attachment } : attachment;
  const filePath = String(entry.path || entry.filePath || "").trim();
  const fileName = normalizeHeaderValue(entry.fileName || entry.filename || (filePath ? path.basename(filePath) : "attachment"));
  const contentType = normalizeHeaderValue(entry.contentType || entry.mimeType || "application/octet-stream") || "application/octet-stream";
  let contentBase64 = String(entry.contentBase64 || entry.base64 || "").replace(/\s+/g, "");
  let size = Number(entry.size || 0) || 0;
  if (!contentBase64 && filePath) {
    const buffer = fs.readFileSync(filePath);
    contentBase64 = buffer.toString("base64");
    size = buffer.length;
  }
  if (!contentBase64) return null;
  return {
    fileName: fileName || "attachment",
    contentType,
    contentBase64,
    size,
  };
}

function wrapBase64(value) {
  return String(value || "").replace(/\s+/g, "").replace(/.{1,76}/g, "$&\r\n").trim();
}

function buildMimeMessage({ to, cc = "", bcc = "", subject = "", body = "", inReplyTo = "", references = "", attachments = [] }) {
  const normalizedAttachments = (attachments || []).map(normalizeDraftAttachment).filter(Boolean);
  const headers = [
    `To: ${normalizeHeaderValue(to)}`,
    cc ? `Cc: ${normalizeHeaderValue(cc)}` : "",
    bcc ? `Bcc: ${normalizeHeaderValue(bcc)}` : "",
    `Subject: ${normalizeHeaderValue(subject)}`,
    "MIME-Version: 1.0",
    normalizedAttachments.length
      ? `Content-Type: multipart/mixed; boundary="pikiio-${crypto.randomBytes(12).toString("hex")}"`
      : "Content-Type: text/plain; charset=UTF-8",
    inReplyTo ? `In-Reply-To: ${normalizeHeaderValue(inReplyTo)}` : "",
    references || inReplyTo ? `References: ${normalizeHeaderValue([references, inReplyTo].filter(Boolean).join(" "))}` : "",
  ].filter(Boolean);
  const contentTypeHeader = headers.find((header) => /^Content-Type:\s*multipart\/mixed/i.test(header)) || "";
  const boundary = contentTypeHeader.match(/boundary="([^"]+)"/)?.[1] || "";
  if (!boundary) return `${headers.join("\r\n")}\r\n\r\n${String(body || "")}`;
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    String(body || ""),
    ...normalizedAttachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.fileName}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      "",
      wrapBase64(attachment.contentBase64),
    ]),
    `--${boundary}--`,
    "",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
}

function messageHeader(headers, name) {
  return (headers || []).find((item) => String(item.name || "").toLowerCase() === name.toLowerCase())?.value || "";
}

async function parentMessageContext(access, messageId) {
  if (!messageId) return {};
  try {
    const message = await gmailFetch(access, `/messages/${encodeURIComponent(messageId)}`, {
      format: "metadata",
    });
    const headers = message.payload?.headers || [];
    return {
      threadId: message.threadId || "",
      messageIdHeader: messageHeader(headers, "Message-ID"),
      references: messageHeader(headers, "References"),
      subject: messageHeader(headers, "Subject"),
    };
  } catch {
    return {};
  }
}

async function createGmailDraft(draftRequest, env = process.env) {
  const access = await refreshAccessToken(env);
  const conversation = draftRequest.conversation || {};
  const parent = await parentMessageContext(access, draftRequest.replyMessageId || conversation.replyMessageId || "");
  const threadId = conversation.threadId || parent.threadId || "";
  const raw = base64Url(buildMimeMessage({
    to: draftRequest.to,
    cc: draftRequest.cc,
    bcc: draftRequest.bcc,
    subject: draftRequest.subject || parent.subject || "",
    body: draftRequest.body,
    inReplyTo: parent.messageIdHeader,
    references: parent.references,
    attachments: draftRequest.attachmentFiles || draftRequest.attachments || [],
  }));
  const payload = await gmailPost(access, "/drafts", {
    message: {
      raw,
      ...(threadId ? { threadId } : {}),
    },
  });
  return {
    draftId: payload.id || "",
    messageId: payload.message?.id || "",
    threadId: payload.message?.threadId || threadId || "",
  };
}

async function sendGmailDraftById(draftId, env = process.env) {
  // Live-send transport for the platform approve/send lane. Callable ONLY
  // through lib/platform-send.js, which fail-closes unless
  // PIKIIO_PLATFORM_SEND_ENABLED is explicitly "true" AND the reviewed-draft
  // hash and server rechecks pass. Uses the existing gmail.compose grant
  // (drafts.send needs no new consent).
  const access = await refreshAccessToken(env);
  const payload = await gmailPost(access, "/drafts/send", { id: draftId });
  return {
    messageId: payload.id || "",
    threadId: payload.threadId || "",
    labelIds: payload.labelIds || [],
  };
}

function threadAwbTextParts(thread) {
  return (thread.messages || []).flatMap((message) => [
    message.subject || "",
    currentMessageText(message.text),
  ]).filter(Boolean);
}

function threadAttachments(thread) {
  return (thread.messages || []).flatMap((message) => message.attachments.map((attachment) => ({ ...attachment, messageId: attachment.messageId || message.id })));
}

function findAwbsInThread(thread, activeAwbs) {
  const text = [
    ...threadAwbTextParts(thread),
    ...threadAttachments(thread).map((attachment) => attachment.filename),
  ].map((part) => maskNonExactActiveAwbCandidates(part, activeAwbs)).join("\n");
  return activeAwbs.filter((awb) => awbSearchTerms(awb).some((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i").test(text)));
}

function scanThreadForActiveAwbReferences(thread, activeAwbs) {
  const matchedAwbs = findAwbsInThread(thread, activeAwbs);
  const nearMisses = [];
  const seen = new Set();
  const messages = (thread?.messages || []).slice().sort((left, right) =>
    Date.parse(right?.internalDate || "") - Date.parse(left?.internalDate || "")
  );
  for (const message of messages) {
    for (const reference of nearMissAwbReferencesInMessage(message, activeAwbs)) {
      const key = reference.token + "\u0000" + reference.activeAwb;
      if (seen.has(key)) continue;
      seen.add(key);
      nearMisses.push({
        ...reference,
        threadId: thread?.id || message?.threadId || "",
        messageId: message?.id || "",
        subject: message?.subject || "",
        from: message?.from || "",
        occurredAt: message?.internalDate || "",
      });
    }
  }
  return { matchedAwbs, nearMisses };
}

function nearMissAlertLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function collectNearMissAwbReferencesForThreads(threads, activeAwbs, options = {}) {
  const maxTotal = nearMissAlertLimit(options.maxTotal, MAX_NEAR_MISS_AWB_ALERTS_PER_REFRESH);
  const maxPerActiveAwb = nearMissAlertLimit(
    options.maxPerActiveAwb,
    MAX_NEAR_MISS_AWB_ALERTS_PER_ACTIVE_AWB,
  );
  const log = typeof options.log === "function" ? options.log : console.log;
  const byActiveAwb = new Map();
  const references = [];
  const seen = new Set();
  const droppedByActiveAwb = new Map();
  let droppedCount = 0;

  for (const thread of threads || []) {
    for (const reference of scanThreadForActiveAwbReferences(thread, activeAwbs).nearMisses) {
      const key = reference.token + "\u0000" + reference.activeAwb;
      if (seen.has(key)) continue;
      seen.add(key);
      const activeAwbReferences = byActiveAwb.get(reference.activeAwb) || [];
      if (references.length >= maxTotal || activeAwbReferences.length >= maxPerActiveAwb) {
        droppedCount += 1;
        droppedByActiveAwb.set(
          reference.activeAwb,
          (droppedByActiveAwb.get(reference.activeAwb) || 0) + 1,
        );
        continue;
      }
      activeAwbReferences.push(reference);
      byActiveAwb.set(reference.activeAwb, activeAwbReferences);
      references.push(reference);
    }
  }

  if (droppedCount > 0) {
    log(JSON.stringify({
      route: "gmail-refresh",
      event: "awb-near-miss-cap",
      droppedCount,
      maxTotal,
      maxPerActiveAwb,
      droppedByActiveAwb: Object.fromEntries(
        [...droppedByActiveAwb.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    }));
  }
  return { references, byActiveAwb, droppedCount };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function operationalSignals(text, attachments) {
  const value = String(text || "");
  const attachmentText = attachments
    .filter(attachmentCanMintOperationalEvidence)
    .map((item) => {
      const untrustedPodMetadata = /pod/i.test(`${item.kind || ""} ${item.pdfEvidence?.kind || ""} ${item.pdfEvidence?.label || ""}`) &&
        !podAttachmentHasFinalProof(item);
      return [
        item.filename,
        item.mimeType,
        item.extractedText || "",
        untrustedPodMetadata ? "" : item.pdfEvidence?.note || "",
        untrustedPodMetadata ? "" : item.pdfEvidence?.status || "",
      ].filter(Boolean).join(" ");
    }).join(" ");
  const combined = `${value} ${attachmentText}`;
  const podPending = hasPodPendingEvidence(combined);
  const podReceived = !podPending && (hasPodReceivedEvidence(combined) || hasCourierCloudDeliveredStatusText(combined));
  const deliveredReported = hasDeliveredReportedEvidence(combined);
  const delivered = podReceived || deliveredReported;
  const pickedUp = hasPickupConfirmedEvidence(combined);
  const negatedRelease = hasCustomsReleaseNegativeEvidence(combined);
  const release = hasCustomsReleasePositiveEvidence(combined);
  const arrival = hasArrivalPositiveEvidence(combined);
  const storage = /\b(?:storage|last free|lfd|demurrage|go begins|\$\s*\d+(?:\.\d+)?\s*\/\s*day)\b/i.test(combined) ||
    hasHebrewStorageOrDetentionEvidence(combined);
  const payment = /\b(?:cargosprint|payment|paid|receipt|ground handling|station fee|total due|cvf|thc)\b/i.test(combined);
  const quote = hasPickupQuoteEvidence(combined);
  const statusRequest = /\b(?:status|update|please advise|any update|alex)\b/i.test(combined);
  return { delivered, deliveredReported, podPending, podReceived, pickedUp, release, negatedRelease, arrival, storage, payment, quote, statusRequest };
}

function summarizeThreadForAwb(awb, thread, options = {}) {
  const text = scopedThreadText(awb, thread, options);
  const attachments = scopedThreadAttachments(awb, thread, options);
  const signals = operationalSignals(text, attachments);
  const events = extractOperationalEvents(awb, thread, options);
  // Fold in model-read residual events (INC: 016-80000142 "carrier relayed a delivery ETA")
  // computed by enrichThreadsWithModelSignals — same event types, so they flow identically.
  const modelEvents = options.modelEventsByKey && options.modelEventsByKey.get(`${thread.id || (thread.messages && thread.messages[0] && thread.messages[0].threadId)}::${normalizeAwb(awb)}`);
  if (Array.isArray(modelEvents) && modelEvents.length) events.push(...modelEvents);
  const labels = [];
  if (signals.podReceived) labels.push("POD");
  if (signals.deliveredReported && !signals.podReceived) labels.push("Delivery reported");
  if (signals.podPending) labels.push("POD pending");
  if (signals.pickedUp) labels.push("Pickup");
  if (signals.release) labels.push("Release/DO");
  if (signals.arrival) labels.push("Arrival");
  if (signals.storage) labels.push("Storage");
  if (signals.payment) labels.push("Ground fees");
  if (signals.quote) labels.push("Quote");
  if (signals.statusRequest) labels.push("Status request");
  const scopedMessages = scopedThreadMessages(awb, thread, options);
  // A release label must come from someone who can grant release: if the only message(s)
  // carrying release wording are our own (quoting older threads), the signal is an echo of
  // our ask, not release evidence.
  if (signals.release) {
    const nonPikiText = scopedMessages
      .filter((message) => !isPikiSender(message))
      .map((message) => [message.subject, message.text].filter(Boolean).join(" "))
      .join(" ");
    const nonPikiAttachmentText = attachments
      .filter(attachmentCanMintOperationalEvidence)
      .map((item) => [item.filename, item.pdfEvidence?.label, item.pdfEvidence?.note].filter(Boolean).join(" "))
      .join(" ");
    if (!hasCustomsReleasePositiveEvidence(`${nonPikiText} ${nonPikiAttachmentText}`)) {
      signals.release = false;
      const releaseLabelIndex = labels.indexOf("Release/DO");
      if (releaseLabelIndex !== -1) labels.splice(releaseLabelIndex, 1);
    }
  }
  const latest = scopedMessages.slice().sort((a, b) => Date.parse(b.internalDate || "") - Date.parse(a.internalDate || ""))[0] || {};
  const usefulAttachments = attachments.filter((attachment) =>
    attachment.kind !== "trash" &&
    (!/pod/i.test(`${attachment.kind || ""} ${attachment.pdfEvidence?.kind || ""} ${attachment.pdfEvidence?.label || ""}`) ||
      podAttachmentHasFinalProof(attachment))
  );
  const ignoredAttachments = attachments.filter((attachment) => attachment.kind === "trash");
  const summary = labels.length
    ? `${labels.join(", ")} evidence found in Gmail thread.`
    : "Gmail thread mentions this AWB; no operational status change detected.";
  const nextAction = nextActionFromSignals(signals);
  return {
    awb,
    status: statusFromSignals(signals),
    summary,
    nextAction,
    latestEventAt: latest.internalDate || "",
    threads: [
      {
        threadId: thread.id,
        messageId: latest.id || "",
        subject: latest.subject || "",
        summary: compactThreadText(text),
      },
    ],
    proof: [
      {
        label: labels[0] || "Gmail thread",
        threadId: thread.id,
        messageId: latest.id || "",
        at: latest.internalDate || "",
        note: summary,
      },
      ...usefulAttachments.slice(0, 5).map((attachment) => ({
        label: attachment.pdfEvidence?.label || `${attachment.kind} attachment`,
        threadId: thread.id,
        messageId: attachment.messageId || latest.id || "",
        at: attachment.at || "",
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        note: attachment.pdfEvidence?.note ||
          "Attachment metadata indicates operational evidence; PDF text was not available in this refresh.",
        extractedText: attachment.extractedText || "",
        pdfEvidence: attachment.pdfEvidence || null,
      })),
    ],
    events,
    attachmentAudit: [
      ...usefulAttachments.map((attachment) => ({
        ...attachment,
        threadId: thread.id,
        reviewed: Boolean(attachment.pdfReviewed),
        reason: attachment.pdfReviewed ? "PDF text parsed by direct Gmail ingestion" : "metadata-only direct Gmail ingestion",
      })),
      ...ignoredAttachments.map((attachment) => ({ ...attachment, threadId: thread.id, reviewed: true, ignored: true, reason: "logo/signature/disclaimer-like attachment" })),
    ],
  };
}

function statusFromSignals(signals) {
  if (signals.podReceived) return "pod-evidence";
  if (signals.deliveredReported) return "delivery-reported-pod-pending";
  if (signals.pickedUp) return "pickup-evidence";
  if (signals.release && signals.arrival) return "arrival-and-release-evidence";
  if (signals.release) return "release-evidence";
  if (signals.arrival) return "arrival-evidence";
  if (signals.quote) return "quote-evidence";
  return "gmail-mentioned";
}

function nextActionFromSignals(signals) {
  if (signals.delivered) return "Review POD/signature details before TMS closeout approval.";
  if (signals.pickedUp) return "Track delivery/POD and detention if driver waited.";
  if (signals.arrival && signals.negatedRelease) return "Follow customs broker for release/DO before dispatch.";
  if (signals.release && signals.arrival && !signals.payment) return "Confirm ground handling fees, then release files to pickup broker.";
  if (signals.release) return "Confirm arrival/station readiness and ground fees before pickup.";
  if (signals.arrival) return "Confirm release/DO, ground fees, and pickup broker.";
  if (signals.statusRequest) return "Confirm whether Jordan/Alex answered the status request.";
  return "No action from direct Gmail scan.";
}

function isPdfAttachment(attachment) {
  return /\.pdf$/i.test(attachment.filename || "") || /application\/pdf/i.test(attachment.mimeType || "");
}

async function enrichPdfAttachments(access, threads, env = process.env, options = {}) {
  const maxAttachments = Number(options.maxAttachmentPdfs || env.PQ_GMAIL_DIRECT_MAX_PDF_ATTACHMENTS || 50);
  const maxBytes = Number(env.PQ_GMAIL_DIRECT_MAX_PDF_BYTES || 8 * 1024 * 1024);
  let reviewed = 0;
  for (const thread of threads || []) {
    for (const message of thread.messages || []) {
      for (const attachment of message.attachments || []) {
        if (reviewed >= maxAttachments) return;
        if (!attachment.attachmentId || attachment.kind === "trash" || !isPdfAttachment(attachment)) continue;
        if (Number(attachment.size || 0) > maxBytes) {
          attachment.pdfReviewed = false;
          attachment.pdfError = `PDF too large for direct extraction (${attachment.size} bytes)`;
          continue;
        }
        reviewed += 1;
        try {
          const payload = await gmailFetch(
            access,
            `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
          );
          const buffer = decodeBase64UrlBuffer(payload.data || "");
          const extractedText = await extractPdfTextFromBuffer(buffer);
          const pdfEvidence = classifyPdfOperationalEvidence({
            filename: attachment.filename,
            text: extractedText,
          });
          attachment.extractedText = extractedText;
          attachment.pdfEvidence = pdfEvidence;
          attachment.pdfReviewed = true;
          if (pdfEvidence.kind === "trash") {
            attachment.kind = "trash";
            attachment.ignored = true;
            attachment.reason = pdfEvidence.note;
          } else if (pdfEvidence.kind && pdfEvidence.kind !== "context") {
            attachment.kind = pdfEvidence.kind;
          }
        } catch (error) {
          attachment.pdfReviewed = false;
          attachment.pdfError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  }
}

// A POD-class IMAGE attachment the deterministic path could not resolve (no final proof,
// no extractable text) — the exact residual vision OCR exists for (INC-2026-07-12b).
function isUnresolvedPodClassImage(attachment, message) {
  if (!attachment || attachment.kind === "trash" || !attachment.attachmentId) return false;
  if (podAttachmentHasFinalProof(attachment)) return false;
  const filename = String(attachment.filename || "");
  const mimeType = String(attachment.mimeType || "");
  const image = /^image\//i.test(mimeType) || /\.(?:heic|heif|jpe?g|png)$/i.test(filename);
  if (!image) return false;
  const podNamed = /\b(?:pod|proof[-\s]?of[-\s]?delivery|signed[-\s]?delivery[-\s]?receipt)\b/i.test(filename);
  const deliveryContext = /\b(?:pod|proof of delivery|deliver(?:y|ed)?|drop(?:ped)? off|signed|receipt)\b/i
    .test(`${message.subject || ""} ${message.text || ""}`);
  return podNamed || deliveryContext;
}

// Read POD-class image attachments with a vision model and, when the image itself
// evidences a completed/signed delivery, stamp concrete POD text so the normal POD /
// delivery classifiers and the terminal-evidence certification pick it up. Deterministic-
// first and fully guarded inside createPodVisionOcr (budget, kill-switch, bounded retries);
// any skip/uncertain result leaves the attachment as-is (unverified) — never a false POD.
async function enrichImagePodAttachments(access, threads, env = process.env, options = {}) {
  const ocr = options.podVisionOcr;
  if (!ocr) return { attempted: 0, confirmed: 0 };
  const maxBytes = Number(env.PQ_POD_VISION_MAX_IMAGE_BYTES || 12 * 1024 * 1024);
  // A real POD is a genuine file attachment of photo/scan size. Skip email chrome:
  // inline images (signatures/banners) and anything under the min size. Inline images are
  // only reconsidered when large enough to plausibly be a pasted POD screenshot.
  const minBytes = Number(env.PQ_POD_VISION_MIN_IMAGE_BYTES || 50 * 1024);
  const inlineKeepBytes = Number(env.PQ_POD_VISION_INLINE_MIN_BYTES || 300 * 1024);
  let attempted = 0;
  let confirmed = 0;
  for (const thread of threads || []) {
    for (const message of thread.messages || []) {
      for (const attachment of message.attachments || []) {
        // Stop before any Gmail download once the reader can no longer attempt a call
        // (disabled / no key / per-run cap reached) — don't fetch bytes we won't read.
        if (typeof ocr.canAttempt === "function" && !ocr.canAttempt()) return { attempted, confirmed };
        if (!isUnresolvedPodClassImage(attachment, message)) continue;
        const size = Number(attachment.size || 0);
        if (size > maxBytes) continue;
        if (size && size < minBytes) continue;
        if (attachment.inline && size && size < inlineKeepBytes) continue;
        let base64 = "";
        try {
          const payload = await gmailFetch(
            access,
            `/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.attachmentId)}`,
          );
          base64 = Buffer.from(decodeBase64UrlBuffer(payload.data || "")).toString("base64");
        } catch (error) {
          attachment.podVisionError = error instanceof Error ? error.message : String(error);
          continue;
        }
        if (!base64) continue;
        attempted += 1;
        // Image-only decision (no email text passed) so the model reads the picture,
        // not the sender's "please see POD" wording.
        const result = await ocr.extractPodEvidence({
          base64,
          mimeType: attachment.mimeType || "image/png",
          filename: attachment.filename,
        });
        attachment.podVisionEvidence = result;
        if (result && result.skipped == null && result.isPod && (result.delivered || result.hasSignature)) {
          attachment.podVisionConfirmed = true;
          attachment.extractedText = [
            attachment.extractedText || "",
            "Proof of delivery received; signed delivery receipt.",
            `POD image read by vision OCR: ${result.summary || "delivered/signed"}.`,
          ].filter(Boolean).join(" ").trim();
          confirmed += 1;
        }
      }
    }
  }
  return { attempted, confirmed };
}

// Persistent per-UTC-day token ledger for POD vision spend (a Supabase snapshot), so the
// daily budget survives across cron runs. Read/write failures degrade quietly — a ledger
// hiccup must never block ingestion nor open unbounded spend (the per-run cap still holds).
function createPodVisionSpendStore(env, writeOptions) {
  const key = "pod-vision-spend";
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    async get() {
      try {
        const snap = await loadAppSnapshot(key, { date: today(), tokens: 0 });
        const data = (snap && (snap.data || snap.value || snap.payload || snap)) || {};
        return data.date === today() ? { tokens: Number(data.tokens || 0) } : { tokens: 0 };
      } catch {
        return { tokens: 0 };
      }
    },
    async add(tokens) {
      try {
        const current = await this.get();
        await upsertAppSnapshot(key, postgresSafeJson({
          date: today(),
          tokens: current.tokens + Number(tokens || 0),
          updatedAt: new Date().toISOString(),
        }), writeOptions);
      } catch {
        /* best-effort */
      }
    },
  };
}

const ARRIVAL_VISION_RESULT_CACHE_LIMIT = 2000;
const ARRIVAL_VISION_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
]);

function arrivalVisionAttachmentFormat(attachment = {}) {
  const filename = String(attachment.filename || "");
  const mimeType = String(attachment.mimeType || "").split(";")[0].trim().toLowerCase();
  const pdf = mimeType === "application/pdf" || /\.pdf$/i.test(filename);
  const image = ARRIVAL_VISION_IMAGE_MIME_TYPES.has(mimeType) || /\.(?:heic|heif|jpe?g|png)$/i.test(filename);
  return { supported: pdf || image, pdf };
}

function arrivalVisionByteLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function arrivalVisionResultForCache(result) {
  if (!result || result.skipped != null) return null;
  if (
    typeof result.arrived !== "boolean" ||
    typeof result.onHand !== "boolean" ||
    typeof result.station !== "string" ||
    typeof result.arrivalDate !== "string" ||
    !Number.isFinite(result.confidence) ||
    result.confidence < 0 || result.confidence > 1 ||
    typeof result.reason !== "string" || !result.reason.trim()
  ) return null;
  return {
    arrived: result.arrived,
    onHand: result.onHand,
    station: result.station,
    arrivalDate: result.arrivalDate,
    confidence: result.confidence,
    reason: result.reason,
  };
}

function pruneArrivalVisionResults(results = {}, threads = [], maxEntries = ARRIVAL_VISION_RESULT_CACHE_LIMIT) {
  const limit = Number.isFinite(Number(maxEntries)) && Number(maxEntries) >= 0
    ? Math.floor(Number(maxEntries))
    : ARRIVAL_VISION_RESULT_CACHE_LIMIT;
  if (limit === 0) return {};
  const entries = [];
  const seen = new Set();
  for (const thread of threads || []) {
    for (const message of thread?.messages || []) {
      for (const attachment of message?.attachments || []) {
        const attachmentId = String(attachment?.attachmentId || "");
        if (!attachmentId || seen.has(attachmentId)) continue;
        seen.add(attachmentId);
        if (!Object.prototype.hasOwnProperty.call(results, attachmentId)) continue;
        const cached = arrivalVisionResultForCache(results[attachmentId]);
        if (!cached) continue;
        entries.push([attachmentId, cached]);
        if (entries.length >= limit) return Object.fromEntries(entries);
      }
    }
  }
  return Object.fromEntries(entries);
}

function arrivalVisionResultCertifies(result) {
  return result?.skipped == null &&
    result.arrived === true &&
    typeof result.onHand === "boolean" &&
    typeof result.station === "string" &&
    typeof result.arrivalDate === "string" &&
    Number.isFinite(result.confidence) &&
    result.confidence >= 0.7 &&
    result.confidence <= 1 &&
    typeof result.reason === "string" &&
    Boolean(result.reason.trim());
}

// Liberal READ, conservative CERTIFY: any real supported document may reach vision for a
// pre-arrival shipment. Filename/email keywords never decide eligibility or truth; only the
// unchanged arrivalVisionResultCertifies boundary may turn the document result into arrival.
function isVisionEligibleArrivalCandidate(attachment, shipmentIsPreArrival, options = {}) {
  if (!shipmentIsPreArrival || !attachment || attachment.kind === "trash" || !attachment.attachmentId) return false;
  if (attachment.arrivalVisionConfirmed) return false;
  const { supported, pdf } = arrivalVisionAttachmentFormat(attachment);
  if (!supported) return false;
  if (pdf && attachment.pdfReviewed !== true) return false;

  // Only actual extracted document text can resolve the residual. pdfEvidence labels/notes
  // are partly filename-derived ("Arrival notice PDF" / "arrival/on-hand proof") and are
  // routing metadata, not proof that the document says the cargo physically arrived.
  if (hasArrivalPositiveEvidence(attachment.extractedText || "")) return false;
  const size = Number(attachment.size);
  const minBytes = arrivalVisionByteLimit(options.minBytes, 50 * 1024);
  const maxBytes = arrivalVisionByteLimit(options.maxBytes, 12 * 1024 * 1024);
  const inlineKeepBytes = arrivalVisionByteLimit(options.inlineKeepBytes, 300 * 1024);
  if (!Number.isFinite(size) || size < minBytes || size > maxBytes) return false;
  if (attachment.inline && size < inlineKeepBytes) return false;
  return true;
}

function shipmentHasCertifiedArrival(shipment = {}) {
  const arrivalGate = shipment?.opsState?.gates?.arrival || shipment?.truthPacket?.gates?.arrival || {};
  const arrivalStatus = String(shipment.arrivalStatus || "").toLowerCase();
  const gateStatus = String(arrivalGate.status || "").toLowerCase();
  const physicalStatus = String(
    shipment?.physicalLifecycle?.status || shipment?.truthPacket?.physicalLifecycle?.status || "",
  ).toLowerCase();
  const phase = String(shipment?.opsState?.phase || shipment.stage || shipment.phase || "").toLowerCase();
  const currentState = String(shipment.currentState || "").toLowerCase();
  return shipment.completed === true ||
    arrivalStatus === "arrived" ||
    ["done", "arrived", "on-hand", "on_hand", "available"].includes(gateStatus) ||
    ["arrived", "on-hand", "on_hand", "available", "picked-up", "picked_up", "out-for-delivery", "out_for_delivery", "delivered", "completed", "closed"].includes(physicalStatus) ||
    ["arrived", "ready-for-pickup", "pickup-in-progress", "picked-up", "out-for-delivery", "delivered", "completed"].includes(phase) ||
    ["arrived", "arrived_not_available", "available", "ready_for_pickup", "picked_up", "out_for_delivery", "delivered", "completed"].includes(currentState.replace(/[\s-]+/g, "_"));
}

function arrivalCertifiedAwbsFromSnapshot(snapshot = {}) {
  return new Set((snapshot.shipments || [])
    .filter(shipmentHasCertifiedArrival)
    .map((shipment) => normalizeAwb(shipment.awb || shipment.id || ""))
    .filter(Boolean));
}

function arrivalNoticeTargetAwbs(message, threadAwbs = [], attachment = {}) {
  const known = [...new Set(threadAwbs.map(normalizeAwb).filter(Boolean))];
  if (!known.length) return [];
  const attachmentScope = [
    attachment.filename || "",
    attachmentCanMintOperationalEvidence(attachment) ? attachment.extractedText || "" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const attachmentMentions = extractMentionedAwbsWithKnown(attachmentScope, known)
    .map(normalizeAwb)
    .filter((awb) => known.includes(awb));
  // An attachment that identifies its own AWB has stronger scope than the surrounding
  // message. If it names only a different/unknown AWB, never inherit the thread AWB.
  if (extractMentionedAwbs(attachmentScope).length || attachmentMentions.length) {
    const exactAttachmentAwbs = [...new Set(attachmentMentions)];
    return exactAttachmentAwbs.length === 1 ? exactAttachmentAwbs : [];
  }

  const messageScope = [message?.subject || "", currentMessageText(message?.text || "")]
    .filter(Boolean)
    .join(" ");
  const messageMentions = extractMentionedAwbsWithKnown(messageScope, known)
    .map(normalizeAwb)
    .filter((awb) => known.includes(awb));
  if (messageMentions.length) {
    const exactMessageAwbs = [...new Set(messageMentions)];
    // The model result has no document-AWB field. Never fan one certifying document
    // decision across multiple shipments, even when one message names a group.
    return exactMessageAwbs.length === 1 ? exactMessageAwbs : [];
  }
  if (extractMentionedAwbs(messageScope).length) return [];
  return known.length === 1 ? known : [];
}

// Read every eligible document, but certify only through arrivalVisionResultCertifies. Two
// passes keep cache replay free even when new attachments exhaust the call budget: pass 1
// replays every attachment-ID hit without canAttempt/download/model work; pass 2 reads only
// genuine misses. Skips are not cached, so a later refresh can retry them.
async function enrichArrivalNoticeAttachments(access, threads, env = process.env, options = {}) {
  const arrivalNoticeVision = options.arrivalNoticeVision;
  const priorVisionResults = options.priorVisionResults || {};
  const allowNewReads = options.allowNewReads !== false;
  const visionResults = { ...priorVisionResults };
  const emptyResult = () => ({
    attempted: 0,
    replayed: 0,
    confirmed: 0,
    events: 0,
    visionResults,
  });
  if (!arrivalNoticeVision) return emptyResult();
  const activeAwbs = [...new Set((options.activeAwbs || []).map(normalizeAwb).filter(Boolean))];
  if (!activeAwbs.length) return emptyResult();
  const arrivalCertifiedAwbs = new Set(
    [...(options.arrivalCertifiedAwbs || [])].map(normalizeAwb).filter(Boolean),
  );
  const fetchAttachment = options.fetchAttachment || gmailFetch;
  const maxBytes = arrivalVisionByteLimit(env.PQ_ARRIVAL_VISION_MAX_ATTACHMENT_BYTES, 12 * 1024 * 1024);
  const minBytes = arrivalVisionByteLimit(env.PQ_ARRIVAL_VISION_MIN_ATTACHMENT_BYTES, 50 * 1024);
  const inlineKeepBytes = arrivalVisionByteLimit(env.PQ_ARRIVAL_VISION_INLINE_MIN_BYTES, 300 * 1024);
  const confirmedAwbs = new Set(arrivalCertifiedAwbs);
  const candidates = [];
  const candidateAttachmentIds = new Set();
  let attempted = 0;
  let replayed = 0;
  let confirmed = 0;
  let events = 0;

  for (const thread of threads || []) {
    const threadAwbs = findAwbsInThread(thread, activeAwbs)
      .map(normalizeAwb)
      .filter((awb) => awb && !confirmedAwbs.has(awb));
    if (!threadAwbs.length) continue;
    for (const message of thread.messages || []) {
      const nearMissAwbs = new Set(nearMissActiveAwbsInMessage(message, activeAwbs));
      for (const attachment of message.attachments || []) {
        const targetAwbs = arrivalNoticeTargetAwbs(message, threadAwbs, attachment)
          .filter((awb) => !nearMissAwbs.has(awb) && !confirmedAwbs.has(awb));
        if (!targetAwbs.length) continue;
        if (!isVisionEligibleArrivalCandidate(attachment, true, {
          minBytes,
          maxBytes,
          inlineKeepBytes,
        })) continue;
        const attachmentId = String(attachment.attachmentId);
        if (candidateAttachmentIds.has(attachmentId)) continue;
        candidateAttachmentIds.add(attachmentId);
        candidates.push({
          message,
          attachment,
          targetAwbs,
          attachmentId,
          at: messageTimeMs(message),
        });
      }
    }
  }

  const applyResult = (candidate, result) => {
    candidate.attachment.arrivalNoticeVisionEvidence = result;
    if (!arrivalVisionResultCertifies(result)) return;
    const scopedAwbs = candidate.targetAwbs.filter((awb) => !confirmedAwbs.has(awb));
    if (!scopedAwbs.length) return;
    candidate.attachment.arrivalVisionConfirmed = true;
    candidate.attachment.arrivalVisionAwbs = scopedAwbs;
    confirmed += 1;
    events += scopedAwbs.length;
    scopedAwbs.forEach((awb) => confirmedAwbs.add(awb));
  };

  // Pass 1 — replay every usable cache hit for free. Do not consult canAttempt here.
  const misses = [];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(priorVisionResults, candidate.attachmentId)) {
      const cached = arrivalVisionResultForCache(priorVisionResults[candidate.attachmentId]);
      if (cached) {
        visionResults[candidate.attachmentId] = cached;
        applyResult(candidate, { skipped: null, ...cached });
        replayed += 1;
        continue;
      }
    }
    misses.push(candidate);
  }

  // A non-persisting refresh may replay cached results, but it must not spend on a miss
  // that cannot be written back to gmail-direct-state. The next write-enabled refresh
  // will read that attachment once and make it replayable.
  if (!allowNewReads) return { attempted, replayed, confirmed, events, visionResults };

  // Pass 2 — spend only on new attachment IDs, newest message first.
  misses.sort((left, right) => right.at - left.at);
  for (const candidate of misses) {
    if (!candidate.targetAwbs.some((awb) => !confirmedAwbs.has(awb))) continue;
    if (
      typeof arrivalNoticeVision.canAttempt === "function" &&
      !arrivalNoticeVision.canAttempt()
    ) break;

    let base64 = "";
    try {
      const payload = await fetchAttachment(
        access,
        `/messages/${encodeURIComponent(candidate.message.id)}/attachments/${encodeURIComponent(candidate.attachmentId)}`,
      );
      base64 = Buffer.from(decodeBase64UrlBuffer(payload.data || "")).toString("base64");
    } catch (error) {
      candidate.attachment.arrivalVisionError = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!base64) continue;

    attempted += 1;
    let result;
    try {
      result = await arrivalNoticeVision.extractArrivalNoticeEvidence({
        base64,
        mimeType: candidate.attachment.mimeType ||
          (/\.pdf$/i.test(candidate.attachment.filename || "") ? "application/pdf" : "image/png"),
        filename: candidate.attachment.filename,
      });
    } catch (error) {
      candidate.attachment.arrivalVisionError = error instanceof Error ? error.message : String(error);
      continue;
    }
    candidate.attachment.arrivalNoticeVisionEvidence = result;
    const cacheable = arrivalVisionResultForCache(result);
    if (cacheable) visionResults[candidate.attachmentId] = cacheable;
    applyResult(candidate, result);
  }
  return { attempted, replayed, confirmed, events, visionResults };
}

// Persistent per-UTC-day ledger, separate from POD/model spend so this safety boundary has
// its own independently configurable budget while reusing the same OPENAI_API_KEY.
function createArrivalNoticeVisionSpendStore(env, writeOptions) {
  const key = "arrival-notice-vision-spend";
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    async get() {
      try {
        const snap = await loadAppSnapshot(key, { date: today(), tokens: 0 });
        const data = (snap && (snap.data || snap.value || snap.payload || snap)) || {};
        return data.date === today() ? { tokens: Number(data.tokens || 0) } : { tokens: 0 };
      } catch {
        return { tokens: 0 };
      }
    },
    async add(tokens) {
      try {
        const current = await this.get();
        await upsertAppSnapshot(key, postgresSafeJson({
          date: today(),
          tokens: current.tokens + Number(tokens || 0),
          updatedAt: new Date().toISOString(),
        }), writeOptions);
      } catch {
        /* best-effort */
      }
    },
  };
}

// Model signals map to the SAME event types the deterministic layer emits, so a model
// reading flows through facts → reducer → gates identically to a keyword match. Exceptions
// are intentionally NOT synthesized from the model (they drive blockers and need
// deterministic care); the model only fills in positive-progress residuals.
const MODEL_SIGNAL_TO_EVENTS = {
  customs_released: [{ type: "customs-release-received", summary: "Customs release/DO recognized from the broker's message." }],
  picked_up: [{ type: "pickup-confirmed", summary: "Carrier loaded/collected the cargo (read from the message)." }],
  // Out-for-delivery implies the cargo was picked up AND is moving to the consignee.
  out_for_delivery: [
    { type: "pickup-confirmed", summary: "Carrier has the cargo (implied by an out-for-delivery update)." },
    { type: "delivery-scheduled", summary: "Carrier is out for delivery / relayed a delivery ETA (read from the message)." },
  ],
  delivered: [{ type: "delivered-reported", summary: "Delivery was reported (read from the message); verify and collect the POD." }],
  arrival: [{ type: "arrival-notice-received", summary: "Arrival/on-hand evidence recognized from the message." }],
};
const MODEL_MIN_CONFIDENCE = 0.7;
const WIDEN_MAX = 8;

function isSubstantiveMessage(message = {}) {
  const text = String(message.text || "").trim();
  if (text.length < 12) return false;
  if (/^(?:automatic reply|out of office|auto[-\s]?reply)/i.test(message.subject || "")) return false;
  if (/\b(?:out of office|automatic reply|do not reply)\b/i.test(text.slice(0, 140))) return false;
  return true;
}

function pruneMessageClassifications(classifications = {}, threads = []) {
  const currentMessageIds = new Set();
  for (const thread of threads || []) {
    for (const message of thread?.messages || []) {
      if (message?.id) currentMessageIds.add(String(message.id));
    }
  }
  const entries = Object.entries(classifications || {})
    .filter(([key]) => currentMessageIds.has(String(key).split("::")[0]))
    .map(([key, value]) => [key, {
      signal: value?.signal || "none",
      confidence: Number(value?.confidence || 0),
      ...(value?.at ? { at: String(value.at).slice(0, 24) } : {}),
    }]);
  if (entries.length > 2000) {
    entries.sort(([, left], [, right]) =>
      (Date.parse(right.at || "") || 0) - (Date.parse(left.at || "") || 0));
  }
  return Object.fromEntries(entries.slice(0, 2000));
}

function validatedModelSignal(candidate = {}, signal = "none") {
  if (signal !== "arrival") return signal;
  const text = currentMessageText(candidate.message?.text || "");
  // Cached model reads are durable and replay without another provider call. A
  // departure/onward-movement message must therefore be vetoed here as well as
  // in the prompt; otherwise one bad historical classification mints
  // destination arrival forever (016-80000101: "Departed on LY005/19 TLV-LAX").
  const departureOnly = /\b(?:departed|departing|left origin|en[-\s]?route|in[-\s]?transit|onward[-\s]?flight|will be loaded|loaded (?:for|on|to) (?:flight|truck))\b/i.test(text) &&
    !hasArrivalPositiveEvidence(text);
  return departureOnly || hasArrivalNegativeEvidence(text) ? "none" : signal;
}

// Model the deterministic residual — up to the eight newest substantive messages per thread+AWB
// whose own target-only extraction produced no operational event. TWO PASSES so persistence is
// durable regardless of the budget cap: pass 1 REPLAYS every cached classification for free (the
// whole point — a message modeled on a past refresh regenerates its signal every refresh at zero
// cost, so the ephemeral truth packet keeps the gate filled); pass 2 spends the model budget only
// on genuinely new (uncached) residuals, newest-first so the most decision-relevant message reads
// first. A single interleaved pass would let new messages burn the cap and skip past older cached
// entries, leaving durable state unreplayed. Low confidence or "none" never synthesizes an event.
async function enrichThreadsWithModelSignals(access, threads, env = process.env, options = {}) {
  const classifier = options.messageModelClassifier;
  const modelEventsByKey = new Map(); // `${threadId}::${awb}` -> [events]
  if (!classifier) return { modelEventsByKey, attempted: 0, applied: 0, replayed: 0, classifications: {} };
  const activeAwbs = options.activeAwbs || [];
  const knownStageByAwb = options.knownStageByAwb || new Map();
  const destinationByAwb = options.destinationByAwb || new Map();
  const priorClassifications = options.priorClassifications || {};
  const classifications = {};
  let attempted = 0;
  let applied = 0;
  let replayed = 0;

  // Collect every residual candidate across all threads/AWBs first, so replay (pass 1) and
  // budgeted modeling (pass 2) can be ordered independently of thread iteration order.
  const candidates = []; // { thread, awb, message, cacheKey, at, prior }
  for (const thread of threads || []) {
    const awbs = [...new Set(findAwbsInThread(thread, activeAwbs).map(normalizeAwb).filter(Boolean))];
    if (!awbs.length) continue;
    const messages = [...(thread.messages || [])].filter(isSubstantiveMessage).sort((a, b) => messageTimeMs(a) - messageTimeMs(b));
    if (!messages.length) continue;
    for (const awb of awbs) {
      const awbMessages = messages.filter((message) =>
        !nearMissActiveAwbsInMessage(message, activeAwbs).includes(awb)
      );
      const residualCandidates = [...awbMessages]
        .sort((a, b) => messageTimeMs(b) - messageTimeMs(a))
        .filter((message) => {
          const targetOnlyEvents = extractOperationalEvents(awb, { id: thread.id || message.threadId, messages: [message] });
          return !(targetOnlyEvents || []).some((event) =>
            event && event.type &&
            event.type !== "unclassified-operational-exception" &&
            event.type !== "exception_unclassified_operational_exception");
        })
        .slice(0, WIDEN_MAX);
      for (const message of residualCandidates) {
        const messageId = message.id || "";
        if (!messageId) continue;
        const messageIndex = awbMessages.indexOf(message);
        const prior = awbMessages.slice(0, messageIndex).slice(-6)
          .map((item) => ({ at: String(item.internalDate || "").slice(0, 10), from: item.from, text: item.text }));
        candidates.push({ thread, awb, message, cacheKey: `${messageId}::${awb}`, at: messageTimeMs(message), prior });
      }
    }
  }

  const synthesize = (candidate, signal, confidence, modelReason) => {
    const acceptedSignal = validatedModelSignal(candidate, signal);
    classifications[candidate.cacheKey] = {
      signal: acceptedSignal,
      confidence,
      at: String(candidate.message.internalDate || "").slice(0, 24),
    };
    const specs = MODEL_SIGNAL_TO_EVENTS[acceptedSignal];
    if (!specs || confidence < MODEL_MIN_CONFIDENCE) return;
    const key = `${candidate.thread.id || candidate.message.threadId}::${candidate.awb}`;
    const nearMissAwbs = nearMissActiveAwbsInMessage(candidate.message, activeAwbs);
    const events = specs.map((spec) => ({
      id: eventId(candidate.awb, spec.type, candidate.message),
      type: spec.type,
      awb: candidate.awb,
      at: candidate.message.internalDate || "",
      threadId: candidate.message.threadId || candidate.thread.id || "",
      messageId: candidate.message.id || "",
      summary: spec.summary,
      source: "message-model",
      confidence,
      modelReason,
      evidenceKind: acceptedSignal === "delivered" ? "reported" : "positive",
      ...(nearMissAwbs.length ? { nearMissAwbs } : {}),
    }));
    if (!modelEventsByKey.has(key)) modelEventsByKey.set(key, []);
    modelEventsByKey.get(key).push(...events);
    applied += 1;
  };

  // Pass 1 — replay every cached classification, FREE (no canAttempt / budget consulted).
  const misses = [];
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(priorClassifications, candidate.cacheKey)) {
      const cached = priorClassifications[candidate.cacheKey] || {};
      synthesize(candidate, cached.signal || "none", Number(cached.confidence || 0), undefined);
      replayed += 1;
    } else {
      misses.push(candidate);
    }
  }

  // Pass 2 — model genuinely new residuals, newest-first, within budget.
  misses.sort((a, b) => b.at - a.at);
  for (const candidate of misses) {
    if (typeof classifier.canAttempt === "function" && classifier.canAttempt() === false) break;
    let result;
    try {
      result = await classifier.classifyMessage({
        awb: candidate.awb,
        destination: destinationByAwb.get(candidate.awb) || "",
        subject: candidate.message.subject || (candidate.thread.messages && candidate.thread.messages[0] && candidate.thread.messages[0].subject) || "",
        priorMessages: candidate.prior,
        target: { from: candidate.message.from, text: candidate.message.text },
        knownStage: knownStageByAwb.get(candidate.awb) || "",
      });
    } catch (error) {
      continue;
    }
    // A skipped read (daily-budget, provider-unavailable, unparseable, ...) is NOT a genuine
    // "model read it and found nothing" — caching it would replay a permanent false negative
    // that never gets modeled once budget/provider recovers. Leave it uncached so a later
    // refresh reads it for real. (canAttempt already breaks for no-key / kill-switch / run-cap;
    // daily-budget slips past canAttempt to here.)
    if (result?.skipped) continue;
    synthesize(candidate, result?.signal || "none", Number(result?.confidence || 0), result?.reason);
    attempted += 1;
  }
  return { modelEventsByKey, attempted, applied, replayed, classifications };
}

// Persistent per-UTC-day token ledger for message-model spend (mirrors the POD-vision one).
function createMessageModelSpendStore(env, writeOptions) {
  const key = "message-model-spend";
  const today = () => new Date().toISOString().slice(0, 10);
  return {
    async get() {
      try {
        const snap = await loadAppSnapshot(key, { date: today(), tokens: 0 });
        const data = (snap && (snap.data || snap.value || snap.payload || snap)) || {};
        return data.date === today() ? { tokens: Number(data.tokens || 0) } : { tokens: 0 };
      } catch { return { tokens: 0 }; }
    },
    async add(tokens) {
      try {
        const current = await this.get();
        await upsertAppSnapshot(key, postgresSafeJson({ date: today(), tokens: current.tokens + Number(tokens || 0), updatedAt: new Date().toISOString() }), writeOptions);
      } catch { /* best-effort */ }
    },
  };
}

function compactThreadText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function mergeByAwb(existing, incoming) {
  const map = new Map();
  for (const record of existing || []) {
    const key = normalizeAwb(record.awb) || String(record.awb || "");
    if (key) map.set(key, record);
  }
  for (const record of incoming || []) {
    const key = normalizeAwb(record.awb) || String(record.awb || "");
    if (!key) continue;
    const previous = map.get(key);
    map.set(key, previous ? mergeProofRecord(previous, record) : record);
  }
  return [...map.values()].sort((a, b) => String(a.awb || "").localeCompare(String(b.awb || "")));
}

function replaceRefreshedProofs(existing, incoming) {
  const incomingKeys = new Set((incoming || []).map((record) => normalizeAwb(record.awb)).filter(Boolean));
  const existingByKey = new Map();
  for (const record of existing || []) {
    const key = normalizeAwb(record.awb) || String(record.awb || "");
    if (key) existingByKey.set(key, record);
  }
  const map = new Map();
  for (const record of existing || []) {
    const key = normalizeAwb(record.awb) || String(record.awb || "");
    if (!key || incomingKeys.has(key)) continue;
    map.set(key, record);
  }
  for (const record of incoming || []) {
    const key = normalizeAwb(record.awb) || String(record.awb || "");
    if (!key) continue;
    const previous = existingByKey.get(key);
    map.set(key, previous ? refreshedProofWithHistory(previous, record) : record);
  }
  return [...map.values()].sort((a, b) => String(a.awb || "").localeCompare(String(b.awb || "")));
}

function refreshedProofWithHistory(previous, incoming) {
  const mergedAttachmentAudit = mergeEvidence(previous.gmailAttachmentAudit || [], incoming.gmailAttachmentAudit || []);
  const compactedAttachmentAudit = compactAttachmentAudit(mergedAttachmentAudit);
  return {
    ...incoming,
    gmailSearchAudit: {
      searchedQueries: [...new Set([...(previous.gmailSearchAudit?.searchedQueries || []), ...(incoming.gmailSearchAudit?.searchedQueries || [])])],
      readThreadIds: [...new Set([...(previous.gmailSearchAudit?.readThreadIds || []), ...(incoming.gmailSearchAudit?.readThreadIds || [])])],
      coverage: incoming.gmailSearchAudit?.coverage || previous.gmailSearchAudit?.coverage || null,
    },
    sourceFreshness: incoming.sourceFreshness || previous.sourceFreshness || null,
    gmailAttachmentAudit: compactedAttachmentAudit,
    gmailAttachmentAuditCount: mergedAttachmentAudit.length,
    gmailAttachmentAuditPersistedCount: compactedAttachmentAudit.length,
    historicalProof: compactHistoricalProof(
      mergeEvidence(previous.historicalProof || previous.proof || [], incoming.historicalProof || incoming.proof || []),
    ),
    historicalEvents: mergeEvents([
      ...(previous.historicalEvents || []),
      ...allProofEvents(previous),
      ...(incoming.historicalEvents || []),
      ...allProofEvents(incoming),
    ]),
    latestEventAt: newestIso(previous.latestEventAt, incoming.latestEventAt),
  };
}

function compactPdfEvidence(pdfEvidence) {
  if (!pdfEvidence) return null;
  return {
    kind: pdfEvidence.kind || "",
    label: pdfEvidence.label || "",
    status: pdfEvidence.status || "",
    note: compactEventText(pdfEvidence.note || "", 500),
  };
}

function compactProofEvidence(proof, { includeTextPreview = true, maxItems = MAX_PROOF_EVIDENCE_ITEMS } = {}) {
  const map = new Map();
  for (const entry of proof || []) {
    const extractedText = String(entry.extractedText || "");
    const compacted = {
      label: entry.label || "",
      threadId: entry.threadId || "",
      messageId: entry.messageId || "",
      at: entry.at || entry.receivedAt || entry.date || "",
      attachmentId: entry.attachmentId || "",
      filename: entry.filename || "",
      mimeType: entry.mimeType || "",
      note: compactEventText(entry.note || "", 500),
      extractedTextLength: extractedText.length,
      extractedTextPreview: includeTextPreview ? compactEventText(extractedText, 500) : "",
      pdfEvidence: compactPdfEvidence(entry.pdfEvidence),
    };
    const key = [
      compacted.threadId,
      compacted.messageId,
      compacted.attachmentId,
      compacted.filename,
      compacted.label,
      compacted.pdfEvidence?.kind || "",
      compacted.pdfEvidence?.label || "",
    ].join("|");
    if (key.replace(/\|/g, "")) map.set(key, compacted);
  }
  return [...map.values()].slice(-maxItems);
}

function compactHistoricalProof(proof) {
  return compactProofEvidence(proof, { includeTextPreview: false, maxItems: MAX_HISTORICAL_PROOF_ITEMS });
}

function compactAttachmentAudit(attachments) {
  const compacted = (attachments || []).map((attachment) => {
    const extractedText = String(attachment.extractedText || "");
    return {
      threadId: attachment.threadId || "",
      messageId: attachment.messageId || "",
      at: attachment.at || attachment.receivedAt || attachment.date || "",
      attachmentId: attachment.attachmentId || "",
      filename: attachment.filename || "",
      mimeType: attachment.mimeType || "",
      kind: attachment.kind || "",
      size: attachment.size || 0,
      reviewed: Boolean(attachment.reviewed || attachment.pdfReviewed),
      pdfReviewed: Boolean(attachment.pdfReviewed),
      ignored: Boolean(attachment.ignored),
      reason: compactEventText(attachment.reason || "", 500),
      extractedTextLength: extractedText.length,
      extractedTextPreview: compactEventText(extractedText, 500),
      pdfEvidence: compactPdfEvidence(attachment.pdfEvidence),
    };
  });
  const isOperational = (attachment) => {
    const kind = String(attachment.kind || "").toLowerCase();
    const pdfKind = String(attachment.pdfEvidence?.kind || "").toLowerCase();
    return !attachment.ignored &&
      ((kind && kind !== "trash" && kind !== "context") ||
        (pdfKind && pdfKind !== "trash" && pdfKind !== "context"));
  };
  const operational = compacted.filter(isOperational).slice(-MAX_OPERATIONAL_ATTACHMENT_AUDIT_ITEMS);
  const context = compacted
    .filter((attachment) => !isOperational(attachment) && String(attachment.kind || "").toLowerCase() === "context")
    .slice(-MAX_CONTEXT_ATTACHMENT_AUDIT_ITEMS);
  const ignored = compacted
    .filter((attachment) => !isOperational(attachment) && String(attachment.kind || "").toLowerCase() !== "context")
    .slice(-MAX_IGNORED_ATTACHMENT_AUDIT_ITEMS);
  return [...operational, ...context, ...ignored];
}

function compactProofRecordForSnapshot(record = {}) {
  const proof = compactProofEvidence(
    mergeEvidence(record.proof || [], record.emailValidation?.proof || []),
    { maxItems: MAX_PROOF_EVIDENCE_ITEMS },
  );
  const events = mergeEvents([
    ...(record.events || []),
    ...(record.emailValidation?.events || []),
  ]);
  const attachmentAudit = compactAttachmentAudit(record.gmailAttachmentAudit || []);
  const compactEvents = (items = []) => mergeEvents(items).slice(-80).map((event) => ({
    id: event.id || "",
    type: event.type || "",
    at: event.at || "",
    awb: event.awb || record.awb || "",
    from: compactEventText(event.from || "", 160),
    // Recipient rosters feed recipient/cc resolution for actions; 160 was cutting
    // multi-party threads mid-address (INC-2026-07-02 noted the station desk often
    // lives only in the truncated tail). 480 holds ~8 addressed participants.
    to: compactEventText(event.to || "", 480),
    cc: compactEventText(event.cc || "", 480),
    subject: compactEventText(event.subject || "", 180),
    summary: compactEventText(event.summary || "", 300),
    evidence: compactEventText(event.evidence || "", 300),
    threadId: event.threadId || "",
    messageId: event.messageId || "",
    ...(event.source ? { source: compactEventText(event.source, 80) } : {}),
    ...(event.sourceSystem ? { sourceSystem: compactEventText(event.sourceSystem, 80) } : {}),
    ...(event.attachmentId ? { attachmentId: event.attachmentId } : {}),
    ...(event.filename ? { filename: compactEventText(event.filename, 180) } : {}),
    ...(event.mimeType ? { mimeType: compactEventText(event.mimeType, 100) } : {}),
    ...(event.station ? { station: compactEventText(event.station, 80) } : {}),
    ...(event.arrivalDate ? { arrivalDate: compactEventText(event.arrivalDate, 40) } : {}),
    ...(Number.isFinite(event.visionConfidence) ? { visionConfidence: event.visionConfidence } : {}),
    confidence: event.confidence || "",
    evidenceKind: event.evidenceKind || "",
    broker: compactEventText(event.broker || "", 160),
    selectedBroker: compactEventText(event.selectedBroker || "", 160),
    contactEmail: event.contactEmail || "",
    amount: event.amount || "",
    carrierName: compactEventText(event.carrierName || "", 160),
    requestedStation: compactEventText(event.requestedStation || "", 80),
    deliveryScheduledDate: event.deliveryScheduledDate || "",
    pickupScheduledDate: event.pickupScheduledDate || "",
    scheduledDate: event.scheduledDate || "",
    groupAwbs: Array.isArray(event.groupAwbs) ? event.groupAwbs.map(normalizeAwb).filter(Boolean) : [],
    appliesToAwbs: Array.isArray(event.appliesToAwbs) ? event.appliesToAwbs.map(normalizeAwb).filter(Boolean) : [],
    ...(Array.isArray(event.nearMissAwbs) && event.nearMissAwbs.length
      ? { nearMissAwbs: event.nearMissAwbs.map(normalizeAwb).filter(Boolean) }
      : {}),
    exceptionType: event.exceptionType || "",
    severity: event.severity || "",
    where: event.where || "",
    impact: event.impact || "",
    status: event.status || "",
    nextAction: compactEventText(event.nextAction || "", 300),
    mentionedAwbs: Array.isArray(event.mentionedAwbs) ? event.mentionedAwbs.map(normalizeAwb).filter(Boolean) : [],
  }));
  return {
    awb: record.awb || "",
    normalizedAwb: normalizeAwb(record.awb || record.normalizedAwb || ""),
    sources: Array.isArray(record.sources) ? record.sources.slice(-20) : [],
    latestEventAt: record.latestEventAt || "",
    summary: compactEventText(record.summary || record.emailValidation?.summary || "", 500),
    nextAction: compactEventText(record.nextAction || record.emailValidation?.nextAction || "", 500),
    proof,
    events: compactEvents(events),
    emailValidation: {
      ...(record.emailValidation || {}),
      summary: compactEventText(record.emailValidation?.summary || "", 500),
      nextAction: compactEventText(record.emailValidation?.nextAction || "", 500),
      proof,
      events: compactEvents(events),
    },
    gmailSearchAudit: {
      searchedQueries: [...new Set(record.gmailSearchAudit?.searchedQueries || [])].slice(-20),
      readThreadIds: [...new Set(record.gmailSearchAudit?.readThreadIds || [])].slice(-60),
      coverage: record.gmailSearchAudit?.coverage
        ? {
            awb: record.gmailSearchAudit.coverage.awb || normalizeAwb(record.awb || ""),
            status: record.gmailSearchAudit.coverage.status || "",
            problem: Boolean(record.gmailSearchAudit.coverage.problem),
            reason: compactEventText(record.gmailSearchAudit.coverage.reason || "", 300),
            latestReadMessageAt: record.gmailSearchAudit.coverage.latestReadMessageAt || "",
            latestProofMessageAt: record.gmailSearchAudit.coverage.latestProofMessageAt || "",
            requiredEventTypes: record.gmailSearchAudit.coverage.requiredEventTypes || [],
            signalNames: record.gmailSearchAudit.coverage.signalNames || [],
            // Keep the newest-message reference (ids + 180-char snippet): when
            // coverage flags unrepresented signals, the audit must show WHICH
            // message said what, or the gap is undiagnosable from production.
            latestReadMessage: record.gmailSearchAudit.coverage.latestReadMessage || null,
            missingTopSearchThreadIds: (record.gmailSearchAudit.coverage.missingTopSearchThreadIds || []).slice(0, 3),
          }
        : null,
    },
    sourceFreshness: record.sourceFreshness || null,
    gmailAttachmentAudit: attachmentAudit,
    gmailAttachmentAuditCount: Number(record.gmailAttachmentAuditCount || attachmentAudit.length) || attachmentAudit.length,
    gmailAttachmentAuditPersistedCount: attachmentAudit.length,
    historicalProof: compactHistoricalProof(record.historicalProof || []),
    historicalEvents: compactEvents(record.historicalEvents || []).slice(-80),
  };
}

function recordTimestamp(record) {
  const direct = Date.parse(record?.latestEventAt || "");
  if (Number.isFinite(direct)) return direct;
  return Math.max(0, ...allProofEvents(record).map(eventTimestamp));
}

function preferredRecord(previous, incoming) {
  return recordTimestamp(incoming) >= recordTimestamp(previous) ? incoming : previous;
}

function mergeProofRecord(previous, incoming) {
  const current = preferredRecord(previous, incoming);
  const older = current === incoming ? previous : incoming;
  const mergedProof = mergeEvidence(
    mergeEvidence(previous.proof || [], previous.emailValidation?.proof || []),
    mergeEvidence(incoming.proof || [], incoming.emailValidation?.proof || []),
  );
  const compactProof = compactProofEvidence(mergedProof);
  const mergedAttachmentAudit = mergeEvidence(previous.gmailAttachmentAudit || [], incoming.gmailAttachmentAudit || []);
  const compactedAttachmentAudit = compactAttachmentAudit(mergedAttachmentAudit);
  return {
    ...older,
    ...current,
    sources: [...new Set([...(previous.sources || []), ...(incoming.sources || [])])],
    timeline: [...(previous.timeline || []), ...(incoming.timeline || [])],
    proof: compactProof,
    emailValidation: {
      ...(older.emailValidation || {}),
      ...(current.emailValidation || {}),
      proof: compactProof,
      events: mergeEvents([...(previous.emailValidation?.events || []), ...(incoming.emailValidation?.events || [])]),
    },
    events: mergeEvents([...(previous.events || []), ...(incoming.events || [])]),
    gmailSearchAudit: {
      searchedQueries: [...new Set([...(previous.gmailSearchAudit?.searchedQueries || []), ...(incoming.gmailSearchAudit?.searchedQueries || [])])],
      readThreadIds: [...new Set([...(previous.gmailSearchAudit?.readThreadIds || []), ...(incoming.gmailSearchAudit?.readThreadIds || [])])],
      coverage: current.gmailSearchAudit?.coverage || incoming.gmailSearchAudit?.coverage || previous.gmailSearchAudit?.coverage || null,
    },
    sourceFreshness: current.sourceFreshness || incoming.sourceFreshness || previous.sourceFreshness || null,
    gmailAttachmentAudit: compactedAttachmentAudit,
    gmailAttachmentAuditCount: mergedAttachmentAudit.length,
    gmailAttachmentAuditPersistedCount: compactedAttachmentAudit.length,
    latestEventAt: newestIso(previous.latestEventAt, incoming.latestEventAt),
  };
}

function filterProofsByAwbs(proofs, awbs) {
  const active = new Set((awbs || []).map(normalizeAwb).filter(Boolean));
  return (proofs || [])
    .filter((proof) => active.has(normalizeAwb(proof?.awb)))
    .map(compactProofRecordForSnapshot);
}

function mergeEvidence(existing, incoming) {
  const map = new Map();
  for (const item of [...existing, ...incoming]) {
    const key = [
      item.threadId || "",
      item.messageId || "",
      item.attachmentId || "",
      item.filename || "",
      item.label || "",
      item.note || "",
    ].join("|");
    if (key.replace(/\|/g, "")) map.set(key, item);
  }
  return [...map.values()];
}

function newestIso(a, b) {
  const aTime = Date.parse(a || "");
  const bTime = Date.parse(b || "");
  if (!Number.isFinite(aTime)) return b || a || "";
  if (!Number.isFinite(bTime)) return a || b || "";
  return bTime > aTime ? b : a;
}

function gmailRefreshWriteOptions(env = process.env) {
  const timeoutMs = Number(env.PQ_GMAIL_REFRESH_WRITE_TIMEOUT_MS || REFRESH_WRITE_TIMEOUT_MS);
  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : REFRESH_WRITE_TIMEOUT_MS,
    retryDelaysMs: [],
  };
}

function gmailRefreshProofWriteOptions(env = process.env) {
  const base = gmailRefreshWriteOptions(env);
  const timeoutMs = Number(env.PQ_GMAIL_REFRESH_PROOF_WRITE_TIMEOUT_MS || Math.max(base.timeoutMs, 20000));
  return {
    ...base,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : Math.max(base.timeoutMs, 20000),
  };
}

function gmailRefreshLedgerWriteOptions(env = process.env) {
  const base = gmailRefreshWriteOptions(env);
  const timeoutMs = Number(env.PQ_GMAIL_REFRESH_LEDGER_WRITE_TIMEOUT_MS || REFRESH_LEDGER_WRITE_TIMEOUT_MS);
  return {
    ...base,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : REFRESH_LEDGER_WRITE_TIMEOUT_MS,
  };
}

function gmailRefreshTruthWriteOptions(env = process.env) {
  const base = gmailRefreshWriteOptions(env);
  const timeoutMs = Number(env.PQ_GMAIL_REFRESH_TRUTH_WRITE_TIMEOUT_MS || REFRESH_TRUTH_WRITE_TIMEOUT_MS);
  return {
    ...base,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : REFRESH_TRUTH_WRITE_TIMEOUT_MS,
  };
}

function assertCanonicalTmsWatermarkCurrent(snapshot = {}, metadataRows = [], options = {}) {
  const candidateTime = String(snapshot?.sourceAudit?.tmsSnapshotTime || "").trim();
  const candidateMs = Date.parse(candidateTime);
  if (!Number.isFinite(candidateMs)) {
    const error = new Error("Canonical truth publication requires a valid candidate TMS source watermark.");
    error.code = "CANONICAL_TMS_WATERMARK_STALE";
    throw error;
  }
  const byKey = new Map((metadataRows || []).map((row) => [
    String(row?.snapshot_key || row?.snapshotKey || ""),
    String(row?.snapshot_time || row?.snapshotTime || ""),
  ]));
  const missingKeys = TMS_SOURCE_SNAPSHOT_KEYS.filter((key) => !Number.isFinite(Date.parse(byKey.get(key) || "")));
  if (missingKeys.length) {
    const error = new Error(`Canonical truth publication requires current hosted TMS metadata: missing ${missingKeys.join(", ")}.`);
    error.code = "CANONICAL_TMS_METADATA_UNAVAILABLE";
    error.missingKeys = missingKeys;
    throw error;
  }
  const mismatches = TMS_SOURCE_SNAPSHOT_KEYS
    .map((key) => ({ key, snapshotTime: byKey.get(key) }))
    .filter((row) => Date.parse(row.snapshotTime) !== candidateMs);
  if (mismatches.length) {
    const error = new Error(
      `Canonical candidate TMS watermark ${candidateTime} does not match current hosted TMS source metadata (${mismatches.map((row) => `${row.key}=${row.snapshotTime}`).join(", ")}).`,
    );
    error.code = "CANONICAL_TMS_WATERMARK_STALE";
    error.candidateTmsSnapshotTime = candidateTime;
    error.hostedTmsSnapshotTimes = Object.fromEntries(TMS_SOURCE_SNAPSHOT_KEYS.map((key) => [key, byKey.get(key)]));
    throw error;
  }
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime())
    ? options.now
    : new Date();
  const configuredMaxAgeMinutes = Number(
    options.maxAgeMinutes ?? process.env.PQ_TMS_INVENTORY_MAX_AGE_MINUTES ?? DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES,
  );
  const maxAgeMinutes = Number.isFinite(configuredMaxAgeMinutes) && configuredMaxAgeMinutes > 0
    ? configuredMaxAgeMinutes
    : DEFAULT_TMS_INVENTORY_MAX_AGE_MINUTES;
  const ageMinutes = Math.max(0, Math.round((now.getTime() - candidateMs) / 60000));
  if (ageMinutes > maxAgeMinutes) {
    const error = new Error(
      `Canonical candidate TMS watermark ${candidateTime} is stale (${ageMinutes}m old; max ${maxAgeMinutes}m).`,
    );
    error.code = "CANONICAL_TMS_WATERMARK_STALE";
    error.candidateTmsSnapshotTime = candidateTime;
    error.ageMinutes = ageMinutes;
    error.maxAgeMinutes = maxAgeMinutes;
    throw error;
  }
  return { candidateTmsSnapshotTime: candidateTime, ageMinutes, maxAgeMinutes };
}

function snapshotLoadWarning(snapshotKey, error, fallbackSource) {
  return {
    type: "snapshot-load-failed",
    snapshotKey,
    fallbackSource,
    message: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  };
}

function readLocalSnapshotForGmailRefresh(snapshotKey, fallback) {
  if (snapshotKey === "tms-detail-snapshot" && bundledTmsDetailSnapshot) return bundledTmsDetailSnapshot;
  if (snapshotKey === "tms-grid-snapshot" && bundledTmsGridSnapshot) return bundledTmsGridSnapshot;
  const filePath = path.join(__dirname, "..", `${snapshotKey}.json`);
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function snapshotReadSkippedWarning(snapshotKey, fallbackSource) {
  return {
    type: "snapshot-read-skipped",
    snapshotKey,
    fallbackSource,
    message: "Hosted snapshot read skipped after hosted persistence preflight failed; using bundled/local fallback as the reducer base.",
    at: new Date().toISOString(),
  };
}

async function loadSnapshotForGmailRefresh(snapshotKey, fallback, warnings, fallbackSource = "provided-fallback", options = {}) {
  if (options.skipHostedRead) {
    const localFallback = readLocalSnapshotForGmailRefresh(snapshotKey, fallback);
    warnings.push(snapshotReadSkippedWarning(
      snapshotKey,
      localFallback === fallback ? fallbackSource : `bundled-${snapshotKey}.json`,
    ));
    return localFallback;
  }
  try {
    return await loadAppSnapshot(snapshotKey, fallback, {
      timeoutMs: REFRESH_SNAPSHOT_TIMEOUT_MS,
      retryDelaysMs: [],
    });
  } catch (error) {
    warnings.push(snapshotLoadWarning(snapshotKey, error, fallbackSource));
    return fallback;
  }
}

function activeTruthPacketRows(snapshot = {}) {
  return (snapshot?.shipments || []).filter((shipment) => {
    const role = String(shipment?.truthPacketRole || "active").toLowerCase();
    return role === "active";
  });
}

function truthPacketSnapshotTimeMs(snapshot = {}) {
  const time = Date.parse(String(snapshot?.snapshotTime || ""));
  return Number.isFinite(time) ? time : 0;
}

function truthPacketRowAwb(row = {}) {
  return normalizeAwb(row.awb || row.id || row.shipmentId || row.trackingNumber || "");
}

function mergeTruthPacketSnapshotsForPromotion(...snapshots) {
  const usable = snapshots.filter((snapshot) => Array.isArray(snapshot?.shipments) && snapshot.shipments.length);
  if (!usable.length) return { shipments: [] };
  const base = usable.reduce((winner, snapshot) => {
    if (!winner) return snapshot;
    const winnerActiveCount = activeTruthPacketRows(winner).length;
    const snapshotActiveCount = activeTruthPacketRows(snapshot).length;
    if (snapshotActiveCount > winnerActiveCount) return snapshot;
    if (snapshotActiveCount < winnerActiveCount) return winner;
    return truthPacketSnapshotTimeMs(snapshot) >= truthPacketSnapshotTimeMs(winner) ? snapshot : winner;
  }, null);
  const byAwb = new Map();
  const withoutAwb = [];
  for (const snapshot of usable.slice().sort((a, b) => truthPacketSnapshotTimeMs(a) - truthPacketSnapshotTimeMs(b))) {
    for (const row of snapshot.shipments || []) {
      const awb = truthPacketRowAwb(row);
      if (!awb) {
        withoutAwb.push(row);
        continue;
      }
      byAwb.set(awb, row);
    }
  }
  const activeAwbs = new Set(
    usable.flatMap((snapshot) => [
      ...(snapshot.activeAwbs || []),
      ...activeTruthPacketRows(snapshot).map((shipment) => shipment.awb || shipment.id || shipment.shipmentId),
    ]).map(normalizeAwb).filter(Boolean),
  );
  const completedAwbs = new Set(
    usable.flatMap((snapshot) => snapshot.completedAwbs || [])
      .map(normalizeAwb)
      .filter(Boolean),
  );
  return {
    ...base,
    shipments: [...byAwb.values(), ...withoutAwb].sort((a, b) =>
      String(a.awb || a.id || "").localeCompare(String(b.awb || b.id || "")),
    ),
    activeAwbs: [...activeAwbs].sort(),
    completedAwbs: completedAwbs.size ? [...completedAwbs].sort() : base.completedAwbs,
  };
}

function truthPacketActiveAwbs(snapshot = {}) {
  const rows = activeTruthPacketRows(snapshot);
  return new Set(
    [
      ...(snapshot.activeAwbs || []),
      ...rows.map((shipment) => shipment.awb || shipment.id || shipment.shipmentId),
    ]
      .map(normalizeAwb)
      .filter(Boolean),
  );
}

function gmailRefreshedAwbs(snapshot = {}) {
  const values = [
    ...(snapshot.proofs || []).map((proof) => proof.awb || proof.normalizedAwb),
    ...((snapshot.gmailCoverageAudit || snapshot.coverage || {}).awbs || [])
      .filter((row) => row.latestReadMessageAt || (row.readThreadIds || []).length)
      .map((row) => row.awb),
  ];
  return new Set(values.map(normalizeAwb).filter(Boolean));
}

function terminalCertificationFeedbackRow(row = {}) {
  const text = [
    row.stage,
    row.phase,
    row.currentState,
    row.nextAction,
    row.opsState?.source,
    row.opsState?.phase,
    row.truthPacket?.currentState,
    row.truthPacket?.resolvedCurrentState,
    row.truthPacket?.physicalLifecycle?.status,
    row.truthPacket?.operationalBlocker?.type,
    row.terminalEvidenceCertification?.status,
    row._terminalEvidenceCertification?.status,
  ].filter(Boolean).join(" ");
  return /\b(?:terminal-evidence-certification|terminal evidence|terminal-state|source-gap|uncertified)\b/i.test(text);
}

function stripTerminalCertificationFeedback(row = {}) {
  const next = {
    ...row,
    completed: false,
    truthPacketRole: "active",
  };
  for (const key of [
    "stage",
    "phase",
    "currentState",
    "nextAction",
    "opsState",
    "truthPacket",
    "evidencePacket",
    "sourceFacts",
    "facts",
    "factLedger",
    "events",
    "proof",
    "proofs",
    "emailValidation",
    "pod",
    "gmailCoverage",
    "terminalEvidenceCertification",
    "_terminalEvidenceCertification",
  ]) {
    delete next[key];
  }
  return next;
}

function sanitizePreviousTruthPacketsForGmailRefresh(previousTruthPackets = {}, gmailProofSnapshot = {}) {
  const refreshedAwbs = gmailRefreshedAwbs(gmailProofSnapshot);
  if (!refreshedAwbs.size || !Array.isArray(previousTruthPackets.shipments)) return previousTruthPackets;
  return {
    ...previousTruthPackets,
    shipments: previousTruthPackets.shipments.map((shipment) => {
      const awb = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
      if (!awb || !refreshedAwbs.has(awb)) return shipment;
      const role = String(shipment?.truthPacketRole || "active").toLowerCase();
      // A refreshed active row is an output/cache, never a source input. Keep
      // stable TMS/control-room metadata, but rebuild every operational field
      // from the current Gmail/TMS/tracking/operator source bundle. Otherwise
      // a corrected classifier cannot retire a false fact already serialized
      // into the previous packet (packet feedback/self-laundering).
      if (role === "active" || terminalCertificationFeedbackRow(shipment)) {
        return stripTerminalCertificationFeedback(shipment);
      }
      return shipment;
    }),
  };
}

function tmsSnapshotRows(tmsDetailSnapshot = {}, tmsGridSnapshot = {}) {
  const detailRows = Array.isArray(tmsDetailSnapshot?.shipments) ? tmsDetailSnapshot.shipments : [];
  if (detailRows.length) return detailRows;
  return Array.isArray(tmsGridSnapshot?.rows) ? tmsGridSnapshot.rows : [];
}

function tmsSnapshotActiveAwbs(tmsDetailSnapshot = {}, tmsGridSnapshot = {}) {
  return new Set(tmsSnapshotRows(tmsDetailSnapshot, tmsGridSnapshot)
    .map((row) => normalizeAwb(row?.trackingNumber || row?.awb || row?.id || row?.shipmentId || ""))
    .filter(Boolean));
}

function tmsSnapshotTime(tmsDetailSnapshot = {}, tmsGridSnapshot = {}) {
  return tmsDetailSnapshot?.snapshotTime || tmsGridSnapshot?.snapshotTime || "";
}

function gmailPromotionSourceAudit({
  previousTruthPackets = {},
  gmailProofSnapshot = {},
  gmailProofSnapshotTime = "",
  gmailProofIdentity = "",
  tmsActiveAwbs = new Set(),
  currentTmsSnapshotTime = "",
  trackingSnapshotTime = "",
  operatorEventSequence = "",
  factLedgerSnapshotTime = "",
  extractorVersion = "",
} = {}) {
  const sortedTmsActiveAwbs = [...tmsActiveAwbs].map(normalizeAwb).filter(Boolean).sort();
  const previousTruthSnapshotTime = previousTruthPackets.snapshotTime || "";
  const previousTruthWriter = String(previousTruthPackets.writerVersion || "");
  const gmailProofCount = Array.isArray(gmailProofSnapshot.proofs) ? gmailProofSnapshot.proofs.length : 0;
  const configuredMaxLagMinutes = Number(process.env.PQ_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES || "");
  const maxLagMinutes = Number.isFinite(configuredMaxLagMinutes) && configuredMaxLagMinutes > 0
    ? configuredMaxLagMinutes
    : DEFAULT_CANONICAL_GMAIL_PROOF_MAX_LAG_MINUTES;
  const tmsSnapshotMs = Date.parse(currentTmsSnapshotTime || "");
  const gmailProofMs = Date.parse(gmailProofSnapshotTime || "");
  const previousTruthMs = Date.parse(previousTruthSnapshotTime || "");
  const blockers = [];

  if (sortedTmsActiveAwbs.length && !Number.isFinite(gmailProofMs)) {
    blockers.push({
      type: "missing-gmail-proof-snapshot-time",
      message: "Fresh TMS inventory cannot publish active canonical truth without a timestamped Gmail proof snapshot.",
    });
  }
  if (
    sortedTmsActiveAwbs.length &&
    Number.isFinite(tmsSnapshotMs) &&
    Number.isFinite(gmailProofMs) &&
    tmsSnapshotMs - gmailProofMs > maxLagMinutes * 60 * 1000
  ) {
    blockers.push({
      type: "gmail-proof-stale-for-tms-inventory",
      message: "Gmail proof snapshot is too old for the TMS inventory being reduced.",
      maxLagMinutes,
    });
  }
  if (
    Number.isFinite(gmailProofMs) &&
    Number.isFinite(previousTruthMs) &&
    previousTruthMs > gmailProofMs &&
    /\+(?:manual-current-gmail-truth|gmail-direct)/.test(previousTruthWriter)
  ) {
    blockers.push({
      type: "gmail-proof-older-than-existing-canonical-truth",
      message: "Existing Gmail-direct/manual-current canonical truth is newer than the Gmail proof input.",
    });
  }

  const sourceBundle = {
    status: blockers.length ? "blocked" : "current",
    blockers,
    sources: {
      tms: {
        snapshotTime: currentTmsSnapshotTime,
        activeAwbs: sortedTmsActiveAwbs,
        activeAwbCount: sortedTmsActiveAwbs.length,
      },
      gmailProof: {
        snapshotTime: gmailProofSnapshotTime,
        proofCount: gmailProofCount,
        maxLagMinutes,
      },
      previousTruth: {
        snapshotTime: previousTruthSnapshotTime,
        writerVersion: previousTruthWriter,
      },
    },
  };

  return {
    tmsSnapshotTime: currentTmsSnapshotTime,
    tmsActiveAwbs: sortedTmsActiveAwbs,
    gmailProofSnapshotTime,
    gmailHistoryId: gmailProofIdentity,
    gmailProofCount,
    previousTruthSnapshotTime,
    previousTruthWriter,
    sourceBundle,
    trackingSnapshotTime,
    operatorEventSequence,
    factLedgerSnapshotTime,
    extractorVersion,
  };
}

function promotedTruthPacketRole(shipment = {}) {
  const phase = String(
    shipment.truthPacket?.resolvedCurrentState ||
      shipment.truthPacket?.currentState ||
      shipment.truthPacket?.physicalLifecycle?.status ||
      shipment.stage ||
      shipment.phase ||
      shipment.opsState?.phase ||
      "",
  ).toLowerCase().replace(/_/g, "-");
  const podStatus = String(
    shipment.opsState?.gates?.pod?.status ||
      shipment.truthPacket?.gates?.find?.((gate) => String(gate.gate || "").toLowerCase() === "pod")?.status ||
      "",
  ).toLowerCase();
  const hasConcretePodEvent = recordEvents(shipment).some((event) =>
    event.type === "pod-received" && podReceivedEventHasFinalProof(event)
  );
  const podClosed = hasConcretePodEvent || ["true", "done", "received", "pod-found", "found"].includes(podStatus);
  const podStillOpen = ["pending", "waiting", "missing", "needed", "not-received", "unknown"].includes(podStatus);
  // A TMS-active delivered shipment is still operational work until the signed
  // POD closes independently. Historical completed rows are preserved elsewhere;
  // this projection governs the freshly rebuilt active inventory only.
  if (podClosed) return "completed";
  if (podStillOpen) return "active";
  if (
    shipment.completed ||
    ["delivered", "completed", "closed"].includes(phase)
  ) {
    return "completed";
  }
  return "active";
}

function terminalGateReviewGate(gateValue = {}, reason = "") {
  const gate = gateValue && typeof gateValue === "object" ? gateValue : {};
  return {
    ...gate,
    rawStatus: gate.rawStatus || gate.status || "",
    status: "waiting",
    evidence: reason || gate.evidence || "Final delivery/POD evidence is not certified.",
    priorTerminalEvidence: gate.evidence || gate.summary || gate.reason || "",
    priorSource: gate.source || gate.sourceSystem || "",
    source: "terminal-evidence-certification",
  };
}

function terminalDerivedGateReason(gateName = "", reason = "") {
  const gate = String(gateName || "").toLowerCase();
  const prefix = reason || "Terminal delivery/POD evidence is not certified.";
  const labels = {
    arrival: "arrival/on-hand",
    customs: "customs/release",
    fees: "fee/payment",
    groundfees: "fee/payment",
    dispatch: "dispatch",
    pickup: "pickup/recovery",
  };
  return `${prefix} This ${labels[gate] || gate || "gate"} gate was inferred from that rejected terminal premise and needs direct source proof.`;
}

function gateDependsOnUncertifiedTerminal(gateValue = {}) {
  const gate = gateValue && typeof gateValue === "object" ? gateValue : {};
  const text = [
    gate.status,
    gate.rawStatus,
    gate.reason,
    gate.evidence,
    gate.summary,
    gate.source,
    gate.sourceSystem,
  ].filter(Boolean).join(" ");
  return /\b(?:delivery\/pod proof|final delivery\/pod proof|shipment was delivered|delivery is confirmed|pod\/proof of delivery is in memory|pod is in memory|proof implies|pickup\/delivery happened after|did not remain blocking|not the active blocker)\b/i.test(text);
}

function terminalDerivedGateReviewGate(gateName = "", gateValue = {}, reason = "") {
  const gate = gateValue && typeof gateValue === "object" ? gateValue : {};
  return {
    ...gate,
    rawStatus: gate.rawStatus || gate.status || "",
    status: "waiting",
    evidence: terminalDerivedGateReason(gateName, reason),
    reason: terminalDerivedGateReason(gateName, reason),
    priorTerminalEvidence: gate.evidence || gate.summary || gate.reason || "",
    priorSource: gate.source || gate.sourceSystem || "",
    source: "terminal-evidence-certification",
  };
}

function terminalGateReviewOverlay(gates = {}, reason = "") {
  const next = { ...(gates || {}) };
  for (const [name, gate] of Object.entries(next)) {
    const key = String(name || "").toLowerCase();
    if (["delivery", "pod"].includes(key)) {
      next[name] = terminalGateReviewGate(gate, reason);
    } else if (gateDependsOnUncertifiedTerminal(gate)) {
      next[name] = terminalDerivedGateReviewGate(key, gate, reason);
    }
  }
  if (!next.delivery) next.delivery = terminalGateReviewGate({}, reason);
  if (!next.pod) next.pod = terminalGateReviewGate({}, reason);
  return next;
}

function terminalTruthPacketGateReview(gates, reason = "") {
  if (Array.isArray(gates)) {
    return gates.map((gate = {}) => {
      const name = String(gate.gate || gate.name || "").toLowerCase();
      if (!["delivery", "pod"].includes(name) && !gateDependsOnUncertifiedTerminal(gate)) return gate;
      if (!["delivery", "pod"].includes(name)) return terminalDerivedGateReviewGate(name, gate, reason);
      return {
        ...gate,
        rawStatus: gate.rawStatus || gate.status || "",
        status: "waiting",
        reason: reason || gate.reason || "Final delivery/POD evidence is not certified.",
        evidence: reason || gate.evidence || "Final delivery/POD evidence is not certified.",
        priorTerminalEvidence: gate.evidence || gate.summary || gate.reason || "",
        priorSource: gate.source || gate.sourceSystem || "",
        source: "terminal-evidence-certification",
      };
    });
  }
  if (gates && typeof gates === "object") return terminalGateReviewOverlay(gates, reason);
  return gates;
}

function terminalReviewOperatorAgency(reason = "") {
  return {
    agency: "truth_repair",
    reason: reason || "Terminal delivery/POD evidence is not certified.",
    countsAsWork: true,
  };
}

function sourceGapForUncertifiedTerminalShipment(shipment = {}, certification = {}) {
  const reason = certification.reason || "Terminal delivery/POD evidence is not certified.";
  const nextAction = "Verify direct arrival, pickup, delivery, and POD evidence before treating this shipment as delivered or closed.";
  const warning = `TMS-active completion blocked: ${reason}`;
  return {
    ...shipment,
    completed: false,
    truthPacketRole: "active",
    stage: "source-gap",
    gates: shipment.gates ? terminalGateReviewOverlay(shipment.gates, reason) : shipment.gates,
    currentState: reason,
    nextAction,
    sourceTruthWarnings: [...new Set([...(shipment.sourceTruthWarnings || []), warning])],
    terminalEvidenceCertification: certification,
    _terminalEvidenceCertification: certification,
    opsState: {
      ...(shipment.opsState || {}),
      phase: "source-gap",
      label: "Terminal evidence uncertified",
      summary: reason,
      nextAction,
      needsHuman: true,
      source: shipment.opsState?.source || "terminal-evidence-certification",
      gates: terminalGateReviewOverlay(shipment.opsState?.gates || {}, reason),
    },
    truthPacket: shipment.truthPacket
      ? {
      ...shipment.truthPacket,
      currentState: "source_gap",
      resolvedCurrentState: "source_gap",
      stateReason: reason,
      physicalLifecycle: {
        ...(shipment.truthPacket.physicalLifecycle || {}),
        label: "Terminal state under review",
        reason,
        status: "source-gap",
        sourceFactIds: [],
      },
      operationalBlocker: {
        ...(shipment.truthPacket.operationalBlocker || {}),
        type: "source-gap",
        label: "Terminal state under review",
        reason,
        status: "blocked",
        severity: "attention",
        sourceFactIds: [],
      },
      nextAction: {
        ...(shipment.truthPacket.nextAction || {}),
        label: nextAction,
        sourceFactIds: [],
      },
      operatorAgency: terminalReviewOperatorAgency(reason),
      mustAskHuman: true,
      gates: terminalTruthPacketGateReview(shipment.truthPacket.gates, reason),
      unknowns: [
            ...(Array.isArray(shipment.truthPacket.unknowns) ? shipment.truthPacket.unknowns : []),
            { gate: "terminal_evidence", reason },
          ],
        }
      : shipment.truthPacket,
    evidencePacket: shipment.evidencePacket
      ? {
          ...shipment.evidencePacket,
          contradictions: [
            ...(Array.isArray(shipment.evidencePacket.contradictions) ? shipment.evidencePacket.contradictions : []),
            {
              type: "terminal-evidence-uncertified",
              severity: "source-gap",
              reason,
              evidence: certification.evidence || "",
              threadId: certification.threadId || "",
              messageId: certification.messageId || "",
            },
          ],
        }
      : shipment.evidencePacket,
  };
}

function normalizedPublishedPhase(value = "") {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}

function truthPacketGateMap(shipment = {}, truthPacket = {}) {
  const existingGates = shipment.opsState?.gates && typeof shipment.opsState.gates === "object"
    ? shipment.opsState.gates
    : {};
  const gates = { ...existingGates };
  for (const packetGate of Array.isArray(truthPacket.gates) ? truthPacket.gates : []) {
    const name = normalizedPublishedPhase(packetGate?.gate || packetGate?.name);
    if (!name) continue;
    const existing = existingGates[name] && typeof existingGates[name] === "object"
      ? existingGates[name]
      : {};
    const status = String(packetGate.rawStatus || packetGate.status || existing.status || "").trim().toLowerCase();
    const evidence = String(packetGate.reason || existing.evidence || existing.reason || "").trim();
    const at = packetGate.updatedAt || existing.at || existing.updatedAt || "";
    const changed = status !== String(existing.status || "").trim().toLowerCase() ||
      evidence !== String(existing.evidence || existing.reason || "").trim() ||
      at !== (existing.at || existing.updatedAt || "");
    gates[name] = {
      ...existing,
      name: existing.name || name,
      status,
      rawStatus: String(packetGate.rawStatus || existing.rawStatus || packetGate.status || "").trim().toLowerCase(),
      label: existing.label || name,
      evidence,
      reason: evidence,
      confidence: packetGate.confidence || existing.confidence || "",
      sourceFactIds: Array.isArray(packetGate.sourceFactIds) ? packetGate.sourceFactIds : existing.sourceFactIds,
      source: changed ? "operator-truth-packet" : existing.source || "operator-truth-packet",
      at,
    };
  }
  return gates;
}

function publishedGateStatusIs(gate = {}, accepted = []) {
  const values = new Set([
    String(gate.status || "").trim().toLowerCase(),
    String(gate.rawStatus || "").trim().toLowerCase(),
  ]);
  return accepted.some((value) => values.has(String(value || "").toLowerCase()));
}

function intentionalSourceGapShipment(shipment = {}) {
  const phase = normalizedPublishedPhase(shipment.opsState?.phase || shipment.stage || shipment.phase);
  const blocker = normalizedPublishedPhase(shipment.truthPacket?.operationalBlocker?.type);
  const certification = normalizedPublishedPhase(
    shipment.terminalEvidenceCertification?.status || shipment._terminalEvidenceCertification?.status,
  );
  return phase === "source-gap" || blocker === "source-gap" || certification === "uncertified";
}

function phaseFromPublishedTruth(shipment = {}, truthPacket = {}, gates = {}) {
  const currentPhase = normalizedPublishedPhase(shipment.opsState?.phase || shipment.stage || shipment.phase) || "unknown";
  const priorBlocker = normalizedPublishedPhase(shipment.truthPacket?.operationalBlocker?.type);
  const blocker = normalizedPublishedPhase(truthPacket.operationalBlocker?.type);
  const physical = normalizedPublishedPhase(truthPacket.physicalLifecycle?.status);
  const packetState = normalizedPublishedPhase(truthPacket.resolvedCurrentState || truthPacket.currentState);
  if (blocker === "delivery-recovery" || physical === "delivery-blocked" || packetState === "delivery-blocked") {
    return "delivery-blocked";
  }
  const deliveryCompleted = [physical, packetState].some((value) => ["delivered", "completed", "closed"].includes(value)) ||
    publishedGateStatusIs(gates.delivery, ["true", "done", "delivered", "completed", "closed"]);
  const podCompleted = publishedGateStatusIs(gates.pod, ["true", "done", "received", "pod-found", "found"]);
  const activeRole = String(shipment.truthPacketRole || "active").toLowerCase() === "active";
  if (activeRole && deliveryCompleted && !podCompleted) return "delivered-pod-pending";
  const terminal = deliveryCompleted || podCompleted;
  if (terminal) {
    return ["delivered", "completed", "closed"].includes(currentPhase) ? currentPhase : "delivered";
  }
  const releaseBlockers = new Set(["customs-hold", "release-needed"]);
  const priorReleasePhase = releaseBlockers.has(currentPhase) ? currentPhase : "";
  const priorReleaseType = releaseBlockers.has(priorBlocker) ? priorBlocker : "";
  const derivedReleaseType = releaseBlockers.has(blocker) ? blocker : "";
  if (priorReleasePhase !== derivedReleaseType || priorReleaseType !== derivedReleaseType) {
    return nextPhaseFromGates(gates);
  }
  return currentPhase;
}

function deriveGmailPublishedShipment(shipment = {}, canonicalMemory = {}, { rederivePackets = false } = {}) {
  if (intentionalSourceGapShipment(shipment)) {
    const phase = "source-gap";
    const label = canonicalPhaseSummary(phase);
    const stateReason = shipment.truthPacket?.stateReason || shipment.stateReason || shipment.currentState || shipment.opsState?.summary || "";
    return {
      ...shipment,
      stage: phase,
      phase,
      currentState: label,
      stateReason,
      opsState: {
        ...(shipment.opsState || {}),
        phase,
        label,
        summary: label,
      },
      emailValidation: shipment.emailValidation
        ? {
            ...shipment.emailValidation,
            status: phase,
            summary: label,
          }
        : shipment.emailValidation,
    };
  }
  const rederived = rederivePackets || !shipment.truthPacket || !shipment.evidencePacket
    ? attachOperatorPackets([shipment], canonicalMemory)[0]
    : shipment;
  const truthPacket = {
    ...rederived.truthPacket,
    freshness: {
      ...(rederived.truthPacket?.freshness || {}),
      ...(shipment.truthPacket?.freshness || {}),
    },
  };
  const evidencePacket = {
    ...rederived.evidencePacket,
    freshness: {
      ...(rederived.evidencePacket?.freshness || {}),
      ...(shipment.evidencePacket?.freshness || {}),
    },
  };
  const gates = truthPacketGateMap(shipment, truthPacket);
  const phase = phaseFromPublishedTruth(shipment, truthPacket, gates);
  const label = canonicalPhaseSummary(phase);
  const arrivalOverdue = shipment.operationalRisk?.type === "arrival-unverified";
  const nextAction = truthPacket.nextAction?.label || shipment.nextAction || shipment.opsState?.nextAction || "";
  const stateReason = shipment.stateReason || truthPacket.stateReason || shipment.currentState || shipment.opsState?.summary || label;
  return {
    ...shipment,
    stage: phase,
    phase,
    currentState: arrivalOverdue ? "Arrival overdue — confirm with station." : label,
    ...(arrivalOverdue ? { needsHuman: true } : {}),
    stateReason,
    nextAction,
    opsState: {
      ...(shipment.opsState || {}),
      phase,
      label: arrivalOverdue ? "Arrival overdue — confirm with station." : label,
      summary: arrivalOverdue ? "Arrival overdue — confirm with station." : label,
      nextAction,
      ...(arrivalOverdue ? { needsHuman: true, urgency: "urgent" } : {}),
      gates,
    },
    emailValidation: shipment.emailValidation
      ? {
          ...shipment.emailValidation,
          status: phase,
          summary: label,
          nextAction,
        }
      : shipment.emailValidation,
    evidencePacket,
    truthPacket,
  };
}

function buildGmailPromotedTruthPackets({
  previousTruthPackets = {},
  brainSnapshot = {},
  gmailProofSnapshot = {},
  shipmentStateSnapshot = {},
  shipmentEventsSnapshot = {},
  operatorNotificationsSnapshot = {},
  companionMemorySnapshot = {},
  operationalFactLedgerSnapshot = {},
  stationMemorySnapshot = {},
  tmsDetailSnapshot = {},
  tmsGridSnapshot = {},
  carrierTrackingSnapshots = [],
  extraSourceTruthWarnings = [],
  now = new Date(),
} = {}) {
  const sanitizedPreviousTruthPackets = sanitizePreviousTruthPacketsForGmailRefresh(previousTruthPackets, gmailProofSnapshot);
  const activeRows = activeTruthPacketRows(sanitizedPreviousTruthPackets);
  const tmsActiveAwbs = tmsSnapshotActiveAwbs(tmsDetailSnapshot, tmsGridSnapshot);
  if (!activeRows.length && !tmsActiveAwbs.size) return null;
  const activeAwbs = tmsActiveAwbs.size
    ? new Set(tmsActiveAwbs)
    : truthPacketActiveAwbs(sanitizedPreviousTruthPackets);
  // Email-discovered active workstreams: an AWB in this refresh's active universe with real
  // Gmail operational evidence but NO hosted packet row must be BORN into the authority
  // store — otherwise Gmail-only shipments stay invisible to the control room forever.
  // Completed AWBs never resurrect (terminal durability).
  const completedAwbGuard = new Set(
    (sanitizedPreviousTruthPackets.completedAwbs || []).map(normalizeAwb).filter(Boolean),
  );
  for (const proof of gmailProofSnapshot.proofs || []) {
    const proofAwb = normalizeAwb(proof.awb);
    if (!proofAwb || activeAwbs.has(proofAwb) || completedAwbGuard.has(proofAwb)) continue;
    const hasOperationalEvidence = (proof.events || []).length > 0 || (proof.proof || []).length > 0;
    if (hasOperationalEvidence) activeAwbs.add(proofAwb);
  }
  const snapshotTime = now.toISOString();
  const gmailProofSnapshotTime = gmailProofSnapshot.snapshotTime || snapshotTime;
  const gmailProofIdentity = gmailProofSnapshot.gmailHistoryId || gmailProofSnapshot.historyId ||
    `legacy-search:${gmailProofSnapshot.contentSignature || contentSignature(gmailProofSnapshot)}`;
  const trackingSnapshotTime = (carrierTrackingSnapshots || [])
    .map((snapshot) => snapshot?.snapshotTime || snapshot?.updatedAt || "")
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "none";
  const operatorEventSequence = companionMemorySnapshot.operatorEventSequence || companionMemorySnapshot.contentSignature ||
    `snapshot:${contentSignature(companionMemorySnapshot || {})}`;
  const canonicalMemory = {
    active: {
      ...sanitizedPreviousTruthPackets,
      shipments: activeRows,
    },
    brain: brainSnapshot || {},
    gmailProof: gmailProofSnapshot || {},
    shipmentState: shipmentStateSnapshot || {},
    shipmentEvents: shipmentEventsSnapshot || {},
    operatorNotifications: operatorNotificationsSnapshot || {},
    companionMemory: companionMemorySnapshot || {},
    operationalFactLedger: operationalFactLedgerSnapshot || {},
    tmsDetail: tmsDetailSnapshot || {},
    tmsGrid: tmsGridSnapshot || {},
    // Operator-taught station contacts and carrier tracking ETAs must reach
    // the HOSTED rebuild too, or saves never retire actions and carrier truth
    // stays local-only (INC-2026-07-05, both incidents).
    stationMemory: stationMemorySnapshot || {},
    carrierTracking: carrierTrackingIndex(carrierTrackingSnapshots || []),
  };
  const gmailCoverageRowsByAwb = coverageByAwb(gmailProofSnapshot.gmailCoverageAudit || gmailProofSnapshot.coverage || {});
  const promotedGmailProofByAwb = new Map(
    (gmailProofSnapshot?.proofs || []).map((proof) => [normalizeAwb(proof.awb || proof.normalizedAwb), proof]),
  );
  const promotedShipments = attachPrimaryPlatformActions(attachOperatorPackets(
    buildCanonicalShipments(canonicalMemory)
      .filter((record) => activeAwbs.has(normalizeAwb(record.awb)))
      .map((record) => canonicalShipmentAsCompanionShipment(record)),
    canonicalMemory,
  ), { gmailProofByAwb: promotedGmailProofByAwb }).map((shipment) => {
    const awb = normalizeAwb(shipment.awb);
    const initialTruthPacketRole = promotedTruthPacketRole(shipment);
    const terminalCertification = terminalEvidenceCertification(shipment);
    const hasUncertifiedTerminalState = tmsActiveAwbs.has(awb) &&
      terminalCertification.status === "uncertified";
    const truthPacketRole = hasUncertifiedTerminalState ? "active" : initialTruthPacketRole;
    const withRole = {
      ...shipment,
      canonicalAuthority: true,
      _truthPacketSource: "shipment-truth-packets",
      _truthPacketSnapshotTime: snapshotTime,
      truthPacketRole,
      terminalEvidenceCertification: terminalCertification,
      _terminalEvidenceCertification: terminalCertification,
      recommendedActions: [],
      actionHistory: [],
    };
    const certifiedRole = hasUncertifiedTerminalState
      ? sourceGapForUncertifiedTerminalShipment(withRole, terminalCertification)
      : withRole;
    return attachGmailCoverageToShipment(certifiedRole, gmailCoverageRowsByAwb.get(awb));
  });
  const promotedByAwb = new Set(promotedShipments.map((shipment) => normalizeAwb(shipment.awb)).filter(Boolean));
  const preservedRows = (sanitizedPreviousTruthPackets.shipments || []).filter((shipment) => {
    const awb = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
    if (!awb) return false;
    return !promotedByAwb.has(awb);
  }).map((shipment) => {
    if (!tmsActiveAwbs.size) return shipment;
    const awb = normalizeAwb(shipment?.awb || shipment?.id || shipment?.shipmentId);
    const role = String(shipment?.truthPacketRole || "active").toLowerCase();
    if (role !== "active" || activeAwbs.has(awb)) return shipment;
    return {
      ...shipment,
      truthPacketRole: "evidence-only",
      _truthPacketRetiredReason: "not-present-in-current-tms-active-inventory",
      completed: false,
    };
  });
  const shipments = [
    ...promotedShipments.map((shipment) => deriveGmailPublishedShipment(shipment, canonicalMemory)),
    ...preservedRows.map((shipment) => deriveGmailPublishedShipment(
      shipment,
      canonicalMemory,
      { rederivePackets: true },
    )),
  ]
    .sort((a, b) =>
      String(a.awb || a.id || "").localeCompare(String(b.awb || b.id || "")),
    );
  const activeShipments = shipments.filter((shipment) => String(shipment.truthPacketRole || "active").toLowerCase() === "active");
  const completedShipments = shipments.filter((shipment) => String(shipment.truthPacketRole || "").toLowerCase() === "completed");
  const evidenceOnlyShipments = shipments.filter((shipment) => String(shipment.truthPacketRole || "").toLowerCase() === "evidence-only");
  const completedAwbs = new Set(
    completedShipments.map((shipment) => normalizeAwb(shipment.awb)).filter(Boolean),
  );
  const sourceTruthWarnings = [...new Set([
    ...(extraSourceTruthWarnings || []),
    ...promotedShipments
      .flatMap((shipment) => shipment.sourceTruthWarnings || [])
      .filter((warning) => !/^TMS-active completion blocked:/i.test(String(warning || ""))),
  ])]
    .filter(Boolean);
  return prepareCanonicalTruthPackets({
    snapshotTime,
    sourceOfTruth:
      "Canonical shipment truth packets are the only operational state authority. Hosted Gmail refresh may promote newer Gmail/state/fact-ledger evidence for known active AWBs without waiting for a TMS refresh.",
    counts: {
      shipments: shipments.length,
      activeShipments: activeShipments.length,
      completedShipments: completedShipments.length,
      evidenceOnlyShipments: evidenceOnlyShipments.length,
      gmailPromotedActiveShipments: promotedShipments.filter((shipment) => String(shipment.truthPacketRole || "active").toLowerCase() === "active").length,
    },
    activeAwbs: activeShipments.map((shipment) => normalizeAwb(shipment.awb)).filter(Boolean).sort(),
    completedAwbs: [...completedAwbs].sort(),
    sourceAudit: gmailPromotionSourceAudit({
      previousTruthPackets,
      gmailProofSnapshot,
      gmailProofSnapshotTime,
      gmailProofIdentity,
      tmsActiveAwbs,
      currentTmsSnapshotTime: tmsSnapshotTime(tmsDetailSnapshot, tmsGridSnapshot),
      trackingSnapshotTime,
      operatorEventSequence,
      factLedgerSnapshotTime: operationalFactLedgerSnapshot.snapshotTime || snapshotTime,
      extractorVersion: operationalFactLedgerSnapshot.writerVersion || "ops-fact-ledger-v1",
    }),
    sourceTruthWarnings,
    shipments,
  }, { trigger: "gmail-direct" });
}

function proofEntryEventText(entry) {
  if (!attachmentCanMintOperationalEvidence(entry)) return "";
  return [
    entry?.label,
    entry?.note,
    entry?.extractedTextPreview,
    entry?.pdfEvidence?.label,
    entry?.pdfEvidence?.note,
    entry?.pdfEvidence?.status,
  ].filter(Boolean).join(" ");
}

function proofEntryTime(entry, fallback = "") {
  return entry?.at || entry?.receivedAt || entry?.date || fallback || "";
}

function proofSignalEvent(awb, entry, type, summary, latestEventAt) {
  if (!entry) return null;
  return {
    id: [normalizeAwb(awb), type, entry.threadId || "", entry.messageId || "", entry.label || ""].filter(Boolean).join(":"),
    awb,
    type,
    at: proofEntryTime(entry, latestEventAt),
    threadId: entry.threadId || "",
    messageId: entry.messageId || "",
    subject: entry.subject || "",
    summary,
    evidence: compactEventText(entry.note || entry.label || summary, 260),
    evidenceKind: "actual",
    confidence: entry.messageId ? "medium" : "low",
  };
}

function proofSignalEventsFromProof(awb, proof = [], latestEventAt = "") {
  const events = [];
  for (const entry of proof || []) {
    const text = proofEntryEventText(entry);
    const hasPendingPodText = hasPodPendingEvidence(text);
    const stationArrivalReceipt = hasStationFacilityArrivalReceiptEvidence(text);
    if ((hasPodReceivedEvidence(text) || hasCourierCloudDeliveredStatusText(text)) && !hasPendingPodText && !stationArrivalReceipt) {
      events.push(proofSignalEvent(awb, entry, "pod-received", "Delivery/POD evidence was received.", latestEventAt));
    }
    if (
      /^delivery reported$/i.test(entry?.label || "") ||
      /\bdelivery reported\b/i.test(text) ||
      hasDeliveredReportedEvidence(text)
    ) {
      events.push(proofSignalEvent(awb, entry, "delivered-reported", "Delivery was reported; verify and collect the signed POD.", latestEventAt));
    }
    if (/^arrival$/i.test(entry?.label || "") && /\barrival\b/i.test(text) && !/no arrival|not arrived|missing|pending|requested|waiting/i.test(text)) {
      events.push(proofSignalEvent(awb, entry, "arrival-notice-received", "Arrival/on-hand evidence was received.", latestEventAt));
    }
    if (/\b(?:customs|release|clearance|d\/?o|delivery order|1c)\b/i.test(text) && hasCustomsReleasePositiveEvidence(text)) {
      events.push(proofSignalEvent(awb, entry, "customs-release-received", "Customs release/DO evidence was received.", latestEventAt));
    }
    if (/\b(?:ground fees?|handling fees?|station fees?|payment)\b/i.test(text) && hasGroundFeesPaidEvidence(text)) {
      events.push(proofSignalEvent(awb, entry, "ground-fees-paid", "Ground handling fees/payment were confirmed.", latestEventAt));
    }
    if (/\b(?:3461|7501|please send[^.;\n]{0,60}documents?|send[^.;\n]{0,40}(?:3461|7501))\b/i.test(text) &&
      !hasCustomsReleasePositiveEvidence(text)) {
      // Retained history: an entry-doc demand (3461/7501) recorded before subject-matching
      // existed must still surface as the open doc-request exception until release proof.
      events.push({
        ...proofSignalEvent(awb, entry, "exception", "Entry documents (3461/7501) were requested and remain open.", latestEventAt),
        exceptionType: "pickup-docs-needed",
        where: "pickup",
        severity: "urgent",
        status: "open",
        nextAction: "Chase the broker/forwarder desk to confirm clearance and return the requested entry documents (3461/7501); expect clearance confirmation or the entry docs.",
      });
    }
  }
  return events.filter(Boolean);
}

function directRecordToGmailProof(record, audit) {
  const events = mergeEvents([
    ...(record.events || []),
    ...proofSignalEventsFromProof(record.awb, record.proof, record.latestEventAt),
  ]);
  const compactProof = compactProofEvidence(record.proof);
  const compactedAttachmentAudit = compactAttachmentAudit(record.attachmentAudit);
  return {
    awb: record.awb,
    sources: ["Gmail"],
    proof: compactProof,
    timeline: [],
    emailValidation: {
      status: record.status,
      summary: record.summary,
      nextAction: record.nextAction,
      proof: compactProof,
      events,
    },
    events,
    gmailSearchAudit: audit,
    gmailAttachmentAudit: compactedAttachmentAudit,
    gmailAttachmentAuditCount: (record.attachmentAudit || []).length,
    gmailAttachmentAuditPersistedCount: compactedAttachmentAudit.length,
    latestEventAt: record.latestEventAt,
  };
}

function allProofEvents(proof) {
  return mergeEvents([
    ...(proof?.events || []),
    ...(proof?.emailValidation?.events || []),
  ]);
}

function messageTimeMs(message = {}) {
  const parsed = Date.parse(message.internalDate || message.date || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestCoverageTime(entries = []) {
  return entries
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0] || 0;
}

function latestProofTimeMs(proof = {}) {
  const eventTimes = allProofEvents(proof).map((event) => event.at || event.date || "");
  const proofTimes = (proof.proof || []).map((entry) => entry.at || entry.receivedAt || entry.date || "");
  return latestCoverageTime([proof.latestEventAt, ...eventTimes, ...proofTimes]);
}

function proofReferencesMessage(proof = {}, message = {}) {
  const messageId = String(message.id || "").trim();
  if (!messageId) return false;
  const scan = (value) => {
    if (!value) return false;
    if (Array.isArray(value)) return value.some(scan);
    if (typeof value !== "object") return false;
    if (String(value.messageId || value.id || "").trim() === messageId) return true;
    return Object.values(value).some(scan);
  };
  return scan(proof);
}

function coverageMessageText(message = {}) {
  return [
    message.subject || "",
    currentMessageText(message.text || ""),
    usefulAttachmentText(message),
  ].filter(Boolean).join(" ");
}

function requiredCoverageEventTypes(signals = {}) {
  const required = [];
  if (signals.podReceived) required.push("pod-received");
  else if (signals.deliveredReported) required.push("delivered-reported");
  if (signals.podPending) required.push("pod-pending");
  if (signals.pickedUp) required.push("pickup-confirmed");
  if (signals.release) required.push("customs-release-received");
  if (signals.arrival) required.push("arrival-notice-received");
  if (
    signals.quote &&
    !signals.podReceived &&
    !signals.deliveredReported &&
    !signals.pickedUp &&
    !signals.release &&
    !signals.arrival
  ) {
    required.push("pickup-quote-received");
  }
  return [...new Set(required)];
}

function proofCoversRequiredEvents(proof = {}, requiredTypes = []) {
  if (!requiredTypes.length) return true;
  const events = allProofEvents(proof);
  const eventTypes = new Set(events.map((event) => event.type).filter(Boolean));
  const proofText = JSON.stringify(proof.proof || []);
  return requiredTypes.every((type) => {
    if (eventTypes.has(type)) return true;
    if (type === "pod-received") return hasPodReceivedEvidence(proofText);
    if (type === "delivered-reported") return hasDeliveredReportedEvidence(proofText);
    if (type === "pickup-confirmed") return hasPickupConfirmedEvidence(proofText);
    if (type === "customs-release-received") return hasCustomsReleasePositiveEvidence(proofText);
    // Arrival-class evidence is REPRESENTED either way: a positive notice event, or a negative
    // (not-arrived / not-on-hand) event that extraction rightly refused to promote to arrival.
    if (type === "arrival-notice-received") {
      return eventTypes.has("carrier-arrival-confirmed") || eventTypes.has("arrival-negative-reported") || hasArrivalPositiveEvidence(proofText);
    }
    return false;
  });
}

// A multi-AWB status rundown attributes each sentence to the AWB token that
// precedes it ("…43985141 elp 27655574 elp still not released… 64356353+6342
// picked up Thursday…"). Signals for THIS awb must come from its own segments —
// a pickup about the Boston pair must never demand pickup events on an ELP
// customs hold. Falls back to the whole text for single-AWB messages or when
// this AWB is not named.
function awbScopedMessageText(text, awb) {
  const clean = String(text || "");
  const key = normalizeAwb(awb || "");
  if (!key) return clean;
  const tokenRe = /\b(?:\d{3}[- ]?)?\d{8}\b/g;
  const hits = [];
  let match;
  while ((match = tokenRe.exec(clean))) {
    hits.push({ index: match.index, end: match.index + match[0].length, digits: match[0].replace(/\D/g, "") });
  }
  const tails = new Set(hits.map((hit) => hit.digits.slice(-8)));
  if (hits.length < 2 || tails.size < 2) return clean;
  // Consecutive tokens with no words between them ("353+64356342",
  // "342, 353") are a GROUP mention sharing the sentence that follows.
  const groups = [];
  for (const hit of hits) {
    const current = groups[groups.length - 1];
    const gapText = current ? clean.slice(current.end, hit.index) : "";
    if (current && !/[a-zA-Z\u0590-\u05ea]/.test(gapText)) {
      current.tails.add(hit.digits.slice(-8));
      current.end = hit.end;
    } else {
      groups.push({ start: hit.index, end: hit.end, tails: new Set([hit.digits.slice(-8)]) });
    }
  }
  const myTail = key.slice(-8);
  const segments = [];
  for (let i = 0; i < groups.length; i += 1) {
    if (!groups[i].tails.has(myTail)) continue;
    const segmentEnd = i + 1 < groups.length ? groups[i + 1].start : clean.length;
    segments.push(clean.slice(groups[i].start, segmentEnd));
  }
  if (!segments.length) return clean;
  return segments.join(" ");
}

function coverageSignalsForMessage(message = {}, awb = "") {
  const bodyEvidenceText = [
    currentMessageText(message.text || ""),
    usefulAttachmentText(message),
  ].filter(Boolean).join(" ");
  // Scope only the body/attachment evidence. Subjects often contain AWB plus
  // customer/reference numbers; scoping the whole subject+body blob can clip
  // away the current message body and make a read operational reply vanish
  // from coverage accounting.
  const scopedBodyText = awbScopedMessageText(bodyEvidenceText || coverageMessageText(message), awb);
  const text = [message.subject || "", scopedBodyText].filter(Boolean).join("\n");
  const signals = operationalSignals(text, message.attachments || []);
  // Keep read-to-truth obligations aligned with the event extractor. Arrival
  // extraction reads current body/usable attachment evidence, not a recycled
  // thread subject. Otherwise an inherited `ARRIVAL NOTICE` subject plus a
  // routing reply such as `Please assist.` demands an arrival event that the
  // extractor correctly cannot emit and falsely source-gaps the row.
  signals.arrival = hasArrivalPositiveEvidence(scopedBodyText);
  const releaseEvidenceText = [message.subject || "", text].filter(Boolean).join("\n");
  if (!signals.release && hasCustomsReleasePositiveEvidence(releaseEvidenceText)) {
    signals.release = true;
  }
  // The auditor must never demand an event the extractor cannot emit:
  // pickup-quote-received only exists when a quote AMOUNT is present, so a
  // bare "pickup/rate" mention (any coordination email) must not convert the
  // quote signal into a required event (production 016-80000165: a delivery-
  // coordination request locked the row waiting for a quote event forever).
  const requiredEventTypes = requiredCoverageEventTypes({
    ...signals,
    quote: signals.quote && Boolean(extractQuoteAmount(text)),
  });
  return {
    signals,
    requiredEventTypes,
    signalNames: Object.entries(signals)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key),
  };
}

function latestReadMessageForAwb(awb, threads = [], activeAwbs = []) {
  const candidates = [];
  for (const thread of threads || []) {
    const matchedAwbs = findAwbsInThread(thread, activeAwbs.length ? activeAwbs : [awb]);
    if (!matchedAwbs.map(normalizeAwb).includes(normalizeAwb(awb))) continue;
    const options = {
      threadAwbCount: Math.max(1, matchedAwbs.length),
      knownAwbs: activeAwbs,
    };
    for (const message of scopedThreadMessages(awb, thread, options)) {
      candidates.push({ ...message, threadId: message.threadId || thread.id });
    }
  }
  return candidates.sort((a, b) => messageTimeMs(b) - messageTimeMs(a))[0] || null;
}

function compactCoverageMessage(message = null) {
  if (!message) return null;
  return {
    messageId: message.id || "",
    threadId: message.threadId || "",
    at: message.internalDate || "",
    from: message.from || "",
    subject: message.subject || "",
    snippet: compactEventText(currentMessageText(message.text || message.snippet || ""), 180),
  };
}

function coverageProblemStatus(status) {
  return [
    "unread-search-hit",
    "read-without-proof",
    "stale-proof",
    "unclassified-operational-signal",
  ].includes(status);
}

// AWBs mentioned in read threads that are not in the active set. These are email-only /
// not-yet-tracked shipments (or recently completed ones) — surfaced as first-class coverage
// data instead of silently dropped, so a shipment that exists only in Gmail is visible.
function collectUnknownAwbMentions(threads = [], activeAwbSet = new Set(), knownAwbSet = new Set()) {
  const mentions = new Map();
  for (const thread of threads || []) {
    for (const message of thread.messages || []) {
      const text = `${message.subject || ""}\n${message.text || ""}`;
      for (const mention of extractMentionedAwbs(text)) {
        const normalized = normalizeAwb(mention);
        if (!normalized || activeAwbSet.has(normalized) || knownAwbSet.has(normalized)) continue;
        const entry = mentions.get(normalized) || { awb: normalized, threadIds: new Set(), latestMessageAt: "" };
        if (thread.id) entry.threadIds.add(thread.id);
        const at = message.internalDate || "";
        if (at && (!entry.latestMessageAt || at > entry.latestMessageAt)) entry.latestMessageAt = at;
        mentions.set(normalized, entry);
      }
    }
  }
  return [...mentions.values()]
    .map((entry) => ({ awb: entry.awb, threadIds: [...entry.threadIds], latestMessageAt: entry.latestMessageAt }))
    .sort((a, b) => String(b.latestMessageAt).localeCompare(String(a.latestMessageAt)))
    .slice(0, 20);
}

function buildGmailCoverageAudit({ activeAwbs = [], searchResults = [], threads = [], proofs = [], knownAwbs = [], now = new Date() } = {}) {
  const normalizedAwbs = [...new Set((activeAwbs || []).map(normalizeAwb).filter(Boolean))];
  const knownAwbSet = new Set((knownAwbs || []).map(normalizeAwb).filter(Boolean));
  const readThreadIds = new Set((threads || []).map((thread) => thread.id).filter(Boolean));
  const proofByAwb = new Map((proofs || []).map((proof) => [normalizeAwb(proof.awb), proof]).filter(([awb]) => awb));
  const rows = normalizedAwbs.map((awb) => {
    const plans = (searchResults || []).filter((plan) => normalizeAwb(plan.awb) === awb);
    const searchedQueries = [...new Set(plans.map((plan) => plan.query).filter(Boolean))];
    const searchTruncated = plans.some((plan) => plan.moreAvailable);
    const searchedThreadIds = [...new Set(plans.flatMap((plan) => plan.threadIds || []).filter(Boolean))];
    const topSearchThreadIds = [...new Set(plans.flatMap((plan) => (plan.threadIds || []).slice(0, 1)).filter(Boolean))];
    const missingTopSearchThreadIds = topSearchThreadIds.filter((threadId) => !readThreadIds.has(threadId));
    const matchingReadThreadIds = (threads || [])
      .filter((thread) => findAwbsInThread(thread, normalizedAwbs).map(normalizeAwb).includes(awb))
      .map((thread) => thread.id)
      .filter(Boolean);
    const readThreadIdsForAwb = [...new Set([
      ...searchedThreadIds.filter((threadId) => readThreadIds.has(threadId)),
      ...matchingReadThreadIds,
    ])];
    const latestReadMessage = latestReadMessageForAwb(awb, threads, normalizedAwbs);
    const latestReadMessageAtMs = messageTimeMs(latestReadMessage || {});
    const proof = proofByAwb.get(awb) || null;
    const latestProofAtMs = latestProofTimeMs(proof || {});
    const signalCoverage = latestReadMessage ? coverageSignalsForMessage(latestReadMessage, awb) : {
      signals: {},
      requiredEventTypes: [],
      signalNames: [],
    };
    const proofHasLatestMessage = proofReferencesMessage(proof || {}, latestReadMessage || {});
    const requiredEventsCovered = proofCoversRequiredEvents(proof || {}, signalCoverage.requiredEventTypes);

    let status = "search-empty";
    let reason = searchedThreadIds.length
      ? "Gmail search returned threads, but no matching message was read for this AWB."
      : "Gmail search returned no thread for this AWB in the configured window.";
    if (missingTopSearchThreadIds.length) {
      status = "unread-search-hit";
      reason = "Gmail search returned a top thread that was not read before state reduction.";
    } else if (latestReadMessage && !proof) {
      status = "read-without-proof";
      reason = "A Gmail thread/message was read for this AWB but no durable proof record was produced.";
    } else if (latestReadMessage && proof && latestReadMessageAtMs > latestProofAtMs + 60 * 1000 && !proofHasLatestMessage) {
      status = "stale-proof";
      reason = "A newer Gmail message was read than the newest proof/event represented in shipment truth.";
    } else if (latestReadMessage && proof && signalCoverage.requiredEventTypes.length && !requiredEventsCovered) {
      status = "unclassified-operational-signal";
      reason = `The newest Gmail message contains operational signals (${signalCoverage.signalNames.join(", ")}) that were not represented as proof events.`;
    } else if (latestReadMessage && proof) {
      status = "covered";
      reason = "Newest read Gmail evidence is represented in the proof/state reduction.";
    } else if (searchedThreadIds.length && !latestReadMessage) {
      status = "searched-not-matched";
      reason = "Gmail search returned threads, but none scoped to this AWB after full-thread parsing.";
    }

    return {
      awb,
      status,
      problem: coverageProblemStatus(status),
      // Truncation context stays on the reason EXCEPT for
      // unclassified-operational-signal with no missing threads: there the
      // newest message was read and the gap is extraction, not fetching —
      // blaming the cap sent the fix the wrong way in production.
      reason: searchTruncated && (missingTopSearchThreadIds.length || status !== "unclassified-operational-signal")
        ? `${reason} Search results were truncated by the per-AWB thread cap; older matching threads were not fetched.`
        : reason,
      searchedQueries,
      searchTruncated,
      searchedThreadIds,
      readThreadIds: readThreadIdsForAwb,
      missingTopSearchThreadIds,
      latestReadMessage: compactCoverageMessage(latestReadMessage),
      latestReadMessageAt: latestReadMessage?.internalDate || "",
      latestProofMessageAt: latestProofAtMs ? new Date(latestProofAtMs).toISOString() : "",
      proofHasLatestMessage,
      requiredEventTypes: signalCoverage.requiredEventTypes,
      signalNames: signalCoverage.signalNames,
    };
  });
  const problems = rows.filter((row) => row.problem);
  const activeAwbSet = new Set(normalizedAwbs);
  const unknownAwbMentions = collectUnknownAwbMentions(threads, activeAwbSet, knownAwbSet);
  return {
    snapshotTime: now.toISOString(),
    policy: "per-awb-newest-gmail-message-and-signal-coverage",
    status: problems.length ? "needs-attention" : "covered",
    activeAwbCount: normalizedAwbs.length,
    truncatedAwbCount: rows.filter((row) => row.searchTruncated).length,
    discovery: {
      policy: "non-awb-scoped-discovery-and-unknown-awb-surfacing",
      unknownAwbCount: unknownAwbMentions.length,
      unknownAwbs: unknownAwbMentions,
    },
    problemCount: problems.length,
    problems: problems.map((row) => ({
      awb: row.awb,
      status: row.status,
      reason: row.reason,
      latestReadMessageAt: row.latestReadMessageAt,
      latestProofMessageAt: row.latestProofMessageAt,
      missingTopSearchThreadIds: row.missingTopSearchThreadIds,
      requiredEventTypes: row.requiredEventTypes,
    })),
    awbs: rows,
  };
}

function coverageByAwb(coverageAudit = {}) {
  return new Map((coverageAudit.awbs || []).map((row) => [normalizeAwb(row.awb), row]).filter(([awb]) => awb));
}

function coverageWarningText(row = {}) {
  if (!row.problem) return "";
  return `${row.awb}: ${row.reason}`;
}

function attachGmailCoverageToProof(proof = {}, coverage = null) {
  if (!coverage) return proof;
  return {
    ...proof,
    gmailSearchAudit: {
      ...(proof.gmailSearchAudit || {}),
      coverage,
    },
    sourceFreshness: {
      ...(proof.sourceFreshness || {}),
      gmailCoverageStatus: coverage.status,
      gmailCoverageProblem: Boolean(coverage.problem),
      latestReadMessageAt: coverage.latestReadMessageAt || "",
      latestProofMessageAt: coverage.latestProofMessageAt || "",
      reason: coverage.problem ? coverage.reason : "",
    },
  };
}

function attachGmailCoverageToProofs(proofs = [], coverageAudit = {}) {
  const byAwb = coverageByAwb(coverageAudit);
  return (proofs || []).map((proof) => attachGmailCoverageToProof(proof, byAwb.get(normalizeAwb(proof.awb))));
}

function attachGmailCoverageToShipment(shipment = {}, coverage = null) {
  if (!coverage) return shipment;
  const problemText = coverageWarningText(coverage);
  const freshnessPatch = {
    gmailCoverageStatus: coverage.status,
    gmailCoverageProblem: Boolean(coverage.problem),
    gmailCoverageReason: coverage.problem ? coverage.reason : "",
    gmailLatestReadMessageAt: coverage.latestReadMessageAt || "",
    gmailLatestProofMessageAt: coverage.latestProofMessageAt || "",
    ...(coverage.problem ? { staleSources: [...new Set([...(shipment.evidencePacket?.freshness?.staleSources || []), "gmail"])] } : {}),
  };
  return {
    ...shipment,
    gmailCoverage: {
      awb: coverage.awb,
      status: coverage.status,
      problem: Boolean(coverage.problem),
      reason: coverage.reason,
      latestReadMessageAt: coverage.latestReadMessageAt || "",
      latestProofMessageAt: coverage.latestProofMessageAt || "",
      requiredEventTypes: coverage.requiredEventTypes || [],
      // The exact unread threads the audit flagged — the next cron cycle
      // force-reads these (self-heal) so a thread cap can never starve the
      // newest truth twice. Capped: identifiers only, never heavy payload.
      missingTopSearchThreadIds: (coverage.missingTopSearchThreadIds || []).slice(0, 3),
    },
    sourceTruthWarnings: problemText
      ? [...new Set([...(shipment.sourceTruthWarnings || []), problemText])]
      : shipment.sourceTruthWarnings || [],
    truthPacket: shipment.truthPacket
      ? {
          ...shipment.truthPacket,
          freshness: {
            ...(shipment.truthPacket.freshness || {}),
            ...freshnessPatch,
          },
        }
      : shipment.truthPacket,
    evidencePacket: shipment.evidencePacket
      ? {
          ...shipment.evidencePacket,
          freshness: {
            ...(shipment.evidencePacket.freshness || {}),
            ...freshnessPatch,
          },
        }
      : shipment.evidencePacket,
  };
}

function podReceivedEventHasFinalProof(event = {}) {
  if (event.type !== "pod-received") return true;
  const evidence = String(event.evidence || "");
  const subject = String(event.subject || "");
  const from = String(event.from || "");
  const proofText = `${evidence} ${subject}`;
  if (hasPqAcceptedPodEvidence(evidence, { from })) return true;
  if (hasPodReceivedEvidence(evidence)) return true;
  if (/\b(?:pod|proof of delivery|signed delivery receipt|receiver signature)\b/i.test(proofText) &&
    /\b(?:attached|received|signed|signature|receiver|completed|delivered successfully)\b/i.test(proofText)) {
    return true;
  }
  if (/\b(?:pre[-\s]?alert|full set of documents|shipment details?|contact consignee|clearance instructions|delivery order|d\/?o\b|deliver to|ship to|consignee|cnee)\b/i.test(proofText)) {
    return false;
  }
  return false;
}

function latestEvent(events, types = []) {
  const wanted = new Set(types);
  return (events || [])
    .filter((event) => !wanted.size || wanted.has(event.type))
    .slice()
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0] || null;
}

function dispatchBrokerKey(event = {}) {
  return brokerIdentity(event.contactEmail || event.email || event.selectedBroker || event.broker || event.from || event.to || "");
}

function brokerLifecycleMatch(left = {}, right = {}) {
  const leftKey = dispatchBrokerKey(left);
  const rightKey = dispatchBrokerKey(right);
  if (!leftKey || !rightKey) return true;
  return leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey);
}

function brokerLifecycleRank(event = {}) {
  if (event.type === "broker-awarded") return 3;
  if (event.type === "broker-confirmed") return 2;
  if (event.type === "broker-alerted") return 1;
  return 0;
}

// A dispatch event whose own evidence is customs work (duty/inbond/entry approval) is a
// legacy misclassification — old snapshots merged forward can still carry them, so the guard
// must live at consumption, not only at extraction.
function brokerDispatchEventLooksCustomsContext(event = {}) {
  const text = `${event.summary || ""} ${event.evidence || ""} ${event.subject || ""}`;
  return /\b(?:duty|duties|in-?bond|retransmit|3461|7501|customs entry|pedimento)\b/i.test(text) &&
    !/\b(?:pickup|pick up|inbound alert|truck|recover|dispatch|cartage|delivery order|rate|quote)\b/i.test(text);
}

function latestActiveBrokerDispatchEvent(events = []) {
  const ordered = (events || [])
    .filter((event) => ["broker-awarded", "broker-confirmed", "broker-alerted", "broker-disregarded"].includes(event.type))
    .filter((event) => event.type === "broker-disregarded" || !brokerDispatchEventLooksCustomsContext(event))
    .slice()
    .sort((a, b) => Date.parse(a.at || "") - Date.parse(b.at || ""));
  const active = [];
  const removeBroker = (event) => {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (brokerLifecycleMatch(active[index], event)) active.splice(index, 1);
    }
  };
  for (const event of ordered) {
    if (event.type === "broker-disregarded") {
      removeBroker(event);
      continue;
    }
    const existingIndex = active.findIndex((item) => brokerLifecycleMatch(item, event));
    if (existingIndex === -1) {
      active.push(event);
      continue;
    }
    const existing = active[existingIndex];
    const eventTimeValue = Date.parse(event.at || "") || 0;
    const existingTimeValue = Date.parse(existing.at || "") || 0;
    if (brokerLifecycleRank(event) > brokerLifecycleRank(existing) || eventTimeValue > existingTimeValue && brokerLifecycleRank(event) === brokerLifecycleRank(existing)) {
      active[existingIndex] = event;
    }
  }
  return active
    .slice()
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0] || null;
}

function gate(status, event, details = {}) {
  return {
    status,
    at: event?.at || "",
    evidence: event?.summary || event?.evidence || "",
    threadId: event?.threadId || "",
    messageId: event?.messageId || "",
    ...details,
  };
}

function softGate(status, event, evidence, details = {}) {
  return gate(status, event, {
    evidence,
    inferred: true,
    missingDirectProof: true,
    ...details,
  });
}

function gateStatusIn(gateValue, statuses) {
  return statuses.includes(String(gateValue?.status || "").toLowerCase());
}

function eventTimestamp(event) {
  const parsed = Date.parse(event?.at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestResolvingEventForException(exception, events) {
  const where = String(exception.where || "").toLowerCase();
  const type = String(exception.type || "").toLowerCase();
  const resolvers = new Set(["operational-clear"]);
  if (where === "customs" || where === "customs-broker" || type.includes("broker-release") || type.includes("customs")) {
    resolvers.add("customs-release-received");
  }
  if (type.includes("pickup-docs-needed") || type.includes("pickup-location-requested")) {
    resolvers.add("customs-release-received");
  }
  if (type.includes("pickup-docs-needed")) {
    resolvers.add("pickup-docs-sent");
  }
  if (type.includes("pickup-location-requested")) {
    resolvers.add("pickup-location-replied");
  }
  if (where === "pickup" || where === "station" || where === "loading" || type.includes("driver") || type.includes("piece-count") || type.includes("release-not-visible")) {
    resolvers.add("operational-clear");
    resolvers.add("pickup-confirmed");
    resolvers.add("delivered-reported");
    resolvers.add("pod-received");
  }
  // A station arrival notice directly refutes "cargo not found": the freight was located.
  if (type.includes("cargo-not-found")) {
    resolvers.add("arrival-notice-received");
    resolvers.add("carrier-arrival-confirmed");
  }
  if (where === "delivery" || type.includes("delivery")) {
    resolvers.add("delivered-reported");
    resolvers.add("pod-received");
  }
  if (where === "movement" || type.includes("connection-transfer") || type.includes("awb-copy")) {
    resolvers.add("connection-transfer-resolved");
    resolvers.add("pickup-docs-sent");
    resolvers.add("operational-clear");
  }
  if (where === "unknown" || type.includes("unknown") || type.includes("unclassified")) {
    resolvers.add("operational-clear");
    resolvers.add("customs-release-received");
    resolvers.add("pickup-confirmed");
    resolvers.add("delivered-reported");
    resolvers.add("pod-received");
  }
  if (!resolvers.size) return null;
  return (events || [])
    .filter((event) =>
      resolvers.has(event.type) ||
      (event.type === "exception" && hasOperationalClearEvidence(`${event.summary || ""} ${event.evidence || ""}`))
    )
    .slice()
    .sort((a, b) => eventTimestamp(b) - eventTimestamp(a))[0] || null;
}

function shipmentExceptionsFromEvents(events) {
  const exceptions = (events || [])
    .filter((event) => event.type === "exception" && !hasOperationalClearEvidence(`${event.summary || ""} ${event.evidence || ""}`))
    .map((event) => ({
      type: event.exceptionType || "unknown-operational-exception",
      severity: event.severity || "watch",
      where: event.where || "unknown",
      impact: event.impact || event.exceptionType || "unknown-operational-exception",
      status: event.status || "open",
      summary: event.summary || event.evidence || "Operational exception found in email.",
      nextAction: event.nextAction || "Review the thread and decide the operator move.",
      at: event.at || "",
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      evidence: event.evidence || "",
      carrierName: event.carrierName || "",
      requestedStation: event.requestedStation || "",
      from: event.from || "",
      to: event.to || "",
      subject: event.subject || "",
    }));
  return mergeEvidence(exceptions, [])
    .filter((exception) => {
      const resolving = latestResolvingEventForException(exception, events);
      if (!resolving) return true;
      const exceptionTime = eventTimestamp(exception);
      const resolvingTime = eventTimestamp(resolving);
      return !exceptionTime || !resolvingTime || exceptionTime > resolvingTime;
    })
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
}

function urgencyFromState({ gates, exceptions }) {
  if ((exceptions || []).some((item) => item.severity === "immediate")) return "immediate";
  if ((exceptions || []).some((item) => item.severity === "urgent")) return "urgent";
  if (gates.pickup.status === "onsite") return "immediate";
  if (gates.pickup.status === "scheduled") return "watch";
  if (gates.delivery.status === "scheduled" || gates.pickup.status === "picked-up") return "today";
  if (gateStatusIn(gates.arrival, ["arrived", "inferred"]) && !gateStatusIn(gates.customs, ["released", "unknown-offline"])) return "today";
  return "watch";
}

function docTokensFromException(exception) {
  const text = [exception?.evidence, exception?.summary, exception?.subject].filter(Boolean).join(" ");
  const tokens = [];
  if (/\b3461\b/.test(text) || /\b7501\b/.test(text)) tokens.push("entry documents (3461/7501)");
  if (/\b(?:i\.?t\.?|in-?bond)\b[^.;\n]{0,40}\b(?:copy|docs?|documents?)\b|\b(?:copy|missing)[^.;\n]{0,30}\bof\s+IT\b/i.test(text)) tokens.push("the IT/in-bond copy");
  if (/\bpedimento\b/i.test(text)) tokens.push("the pedimento reference");
  if (/\b(?:awb|air\s?waybill|airway bill)\b[^.;\n]{0,30}\bcopy\b|\bcopy of (?:the )?(?:awb|air\s?waybill)\b/i.test(text)) tokens.push("the AWB copy");
  if (/\bdelivery order\b|\bd\/?o\b/i.test(text)) tokens.push("the delivery order");
  return [...new Set(tokens)];
}

function partyFromEventFrom(from) {
  const raw = String(from || "").trim();
  if (!raw) return "";
  const match = raw.match(/^"?([^"<]+?)"?\s*<([^>]+)>/);
  if (match) return `${match[1].trim()} (${match[2].trim()})`;
  return raw.replace(/[<>]/g, "");
}

function nextActionFromState({ gates, exceptions }) {
  const exception = (exceptions || [])[0];
  const customsHoldException = (exceptions || []).find((item) => ["customs-hold", "inbond-rejected"].includes(item?.type));
  if (customsHoldException && gates.customs.status === "customs-hold") return customsHoldException.nextAction;
  // Named doc-request lanes fall through to the relations-aware composer below — their raw
  // extraction-time nextAction is generic and never names the requester or the document.
  const namedDocLaneTypes = ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"];
  if ((exception?.severity === "immediate" || exception?.severity === "urgent") && !namedDocLaneTypes.includes(exception?.type)) {
    const asker = partyFromEventFrom(exception.from || "");
    const quote = compactEventText(exception.evidence || "", 170);
    if (!asker && !quote) return exception.nextAction;
    return [
      asker ? `Reply to ${asker} on their thread:` : "",
      exception.nextAction || "decide the operator move.",
      quote ? `They wrote: "${quote}".` : "",
      "Expect the decision recorded on the thread.",
    ].filter(Boolean).join(" ");
  }
  if (gates.pod.status === "received") return "No action; signed POD is in memory.";
  if (gates.delivery.status === "delivered") return "Delivery was reported; collect the signed POD.";
  if (gates.pod.status === "pending") return "Follow up for signed POD/proof of delivery.";
  if (gates.delivery.status === "scheduled") return "Track delivery and collect POD after completion.";
  if (gates.pickup.status === "onsite") return "Carrier/driver is onsite; get loaded proof or clear the airport blocker now.";
  if (gates.pickup.status === "scheduled") {
    const scheduled = gates.pickup.pickupScheduledDate || gates.pickup.scheduledDate || "";
    return scheduled
      ? `Pickup is scheduled/deferred for ${scheduled}; follow up then and collect loaded proof/POD after pickup.`
      : "Pickup is scheduled/deferred; follow up at pickup time and collect loaded proof/POD after pickup.";
  }
  if (gateStatusIn(gates.pickup, ["picked-up", "inferred"])) return "Track delivery/POD and detention if the driver waited.";
  // Executable composition: verb + target party (from enriched relations) + why now + the
  // fact expected after the action. Generic "monitor/push/confirm" wording is banned.
  const relations = arguments[0]?.relations || {};
  const partyText = (relation, fallback) => relation && (relation.name || relation.email)
    ? `${relation.name || relation.email}${relation.email && relation.name ? ` (${relation.email})` : ""}`
    : fallback;
  const docsException = (exceptions || []).find((item) =>
    ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"].includes(item.type));
  if (docsException && !gateStatusIn(gates.customs, ["released", "unknown-offline"])) {
    const docTokens = docTokensFromException(docsException);
    const docText = docTokens.length ? docTokens.join(" and ") : "the requested entry documents (3461/7501/DO)";
    const requester = partyText(relations.customsBroker, "") || partyFromEventFrom(docsException.from) || "the customs broker/forwarder desk";
    return `Chase ${requester} on the request thread to confirm clearance and send ${docText} — clearance/pickup is blocked on them; expect the docs or clearance confirmation.`;
  }
  if (!gateStatusIn(gates.arrival, ["arrived", "inferred"])) {
    const releaseBanked = gateStatusIn(gates.customs, ["released", "unknown-offline"]);
    return `Ask ${partyText(relations.station, "the destination station/handler")} to confirm on-hand and send the arrival notice — ${releaseBanked ? "release/DO is already banked, so tender pickup and schedule delivery as soon as it lands" : "clearance work follows arrival"}; expect an on-hand/arrival confirmation.`;
  }
  if (!gateStatusIn(gates.customs, ["released", "unknown-offline"])) {
    return `Chase ${partyText(relations.customsBroker, "the customs broker")} on the clearance thread for release/DO — freight is on hand and waiting on customs; expect release/DO or ACE proof.`;
  }
  if (gates.fees.status === "due") {
    return `Answer the fee/duty request from ${partyText(relations.customsBroker || relations.station, "the station/handler")} and record the payment or approval decision — pickup is blocked on it; expect a receipt or recorded approval.`;
  }
  if (!gateStatusIn(gates.fees, ["paid", "unknown-offline"])) {
    return `Confirm ground-handling fees with ${partyText(relations.station, "the station")} before dispatch; expect a fee amount or paid confirmation.`;
  }
  if (gates.dispatch.status === "broker-awarded") {
    return `Follow ${partyText(relations.pickupBroker, "the awarded pickup broker")} on the dispatch thread for pickup execution — collect loaded proof and POD; expect loaded/delivered/POD.`;
  }
  if (gates.dispatch.status === "broker-alerted") {
    return `Chase ${partyText(relations.pickupBroker, "the alerted pickup broker")} to acknowledge/accept the pickup alert; expect an acceptance or pickup schedule.`;
  }
  if (gates.dispatch.status === "quotes-in") return "Approve the best pickup quote and award the pickup owner, then send the release package; expect an award confirmation.";
  return `Select and alert a pickup broker for recovery${relations.station ? ` from ${partyText(relations.station, "the station")}` : ""}; expect a pickup acceptance.`;
}

function phaseFromState({ gates, exceptions }) {
  // Named doc-request lanes stay named: an immediate-severity docs exception is still a doc
  // chase, not a generic "exception" lane the operator has to re-triage.
  const namedDocLaneTypes = ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"];
  if ((exceptions || []).some((item) => item.severity === "immediate" && !namedDocLaneTypes.includes(item.type))) return "exception";
  if (gates.pod.status === "received") return "delivered";
  if (gates.delivery.status === "delivered") return "delivered-pod-pending";
  if (gates.delivery.status === "scheduled") return "delivery-scheduled";
  if (gates.pickup.status === "onsite") return "pickup-onsite";
  if (gates.pickup.status === "scheduled") return "pickup-scheduled";
  if (gateStatusIn(gates.pickup, ["picked-up", "inferred"])) return "picked-up";
  // An ACTIVE customs hold outranks dispatch noise: alerting/awarding a broker does not clear
  // the hold, so the operator lane stays customs-hold until the hold actually resolves.
  if (gates.customs.status === "customs-hold") return "customs-hold";
  // Open pickup-side document/location requests are their own operator lane (chase the doc
  // request), not a generic release-needed. Release/DO or docs-sent proof resolves these
  // exceptions upstream, so only genuinely open requests reach this branch.
  // Dispatch phases require proven arrival: brokering a pickup for freight that has not
  // landed must not promote the shipment past its physical lifecycle.
  const arrivalProven = gateStatusIn(gates.arrival, ["arrived", "inferred"]);
  const openDocsException = (exceptions || []).find((item) => namedDocLaneTypes.includes(item.type));
  if (!gateStatusIn(gates.customs, ["released", "unknown-offline"]) && openDocsException) {
    // Entry/inbond doc requests on ARRIVED freight block the RELEASE, not the pickup — the
    // operator lane is release-needed (send the customs docs), not a pickup-side doc chase.
    const docsContext = [openDocsException.evidence, openDocsException.summary, openDocsException.subject].filter(Boolean).join(" ");
    const customsContextDocs = /\b(?:3461|7501|in-?bond|entry|pedimento)\b/i.test(docsContext) || /\bIT\b/.test(docsContext);
    if (!(customsContextDocs && arrivalProven)) return "pickup-docs-needed";
  }
  if (gates.dispatch.status === "broker-awarded") return arrivalProven ? "broker-awarded" : "in-transit";
  if (gates.dispatch.status === "broker-alerted") return arrivalProven ? "broker-alerted" : "in-transit";
  if (!arrivalProven) return "in-transit";
  if (!gateStatusIn(gates.customs, ["released", "unknown-offline"])) return "release-needed";
  // Fees block only on a genuine demand (or paid-history absence after physical handling is
  // covered by unknown-offline). A fee MENTION — arrival-notice banner, quote, future storage
  // exposure — never creates fees-needed.
  if (gates.fees.status === "due") return "fees-needed";
  return "ready-for-pickup";
}

function summarizeCanonicalState(state) {
  const parts = [];
  if (state.gates.arrival.status === "arrived") parts.push("arrived");
  if (state.gates.arrival.status === "inferred") parts.push("arrival inferred");
  if (state.gates.customs.status === "released") parts.push("released");
  if (state.gates.customs.status === "unknown-offline") parts.push("release proof missing/offline");
  if (state.gates.fees.status === "paid") parts.push("fees paid");
  if (state.gates.fees.status === "unknown-offline") parts.push("fees proof missing/offline");
  if (state.gates.pickup.status === "picked-up") parts.push("picked up");
  if (state.gates.pickup.status === "onsite") parts.push("carrier onsite");
  if (state.gates.pickup.status === "scheduled") parts.push("pickup scheduled");
  if (state.gates.pickup.status === "inferred") parts.push("pickup inferred");
  if (state.gates.delivery.status === "scheduled") parts.push("delivery scheduled");
  if (state.gates.delivery.status === "delivered" && state.gates.pod.status !== "received") parts.push("delivered, POD pending");
  if (state.gates.pod.status === "received") parts.push("delivered/POD");
  if (state.exceptions.length) parts.push(`${state.exceptions.length} exception${state.exceptions.length === 1 ? "" : "s"}`);
  return parts.length ? `${parts.join(", ")}.` : "Gmail has shipment context, but no decisive state yet.";
}

function shipmentStateFromProof(proof, now = new Date()) {
  const events = allProofEvents(proof);
  const arrival = latestEvent(events, ["carrier-arrival-confirmed", "arrival-notice-received"]);
  const arrivalNegative = latestEvent(events, ["arrival-negative-reported"]);
  const eventTime2 = (value) => Date.parse(value || "") || 0;
  const release = latestEvent(events, ["customs-release-received"]);
  const feesPaid = latestEvent(events, ["ground-fees-paid"]);
  const feesDemanded = latestEvent(events, ["ground-fees-demanded"]);
  const quote = latestEvent(events, ["pickup-quote-received"]);
  const pickupOnsite = latestEvent(events, ["pickup-onsite"]);
  const pickupScheduled = latestEvent(events, ["pickup-scheduled"]);
  const pickup = latestEvent(events, ["pickup-confirmed"]);
  const deliveryScheduled = latestEvent(events, ["delivery-scheduled"]);
  const delivered = latestEvent(events, ["delivered-reported"]);
  const podPending = latestEvent(events, ["pod-pending"]);
  const pod = latestEvent(events.filter((event) => podReceivedEventHasFinalProof(event)), ["pod-received"]);
  const exceptions = shipmentExceptionsFromEvents(events);
  const physicalHandling = pod || delivered || pickup;
  const deliveryProof = pod || delivered;
  const activePickupOnsite = pickupOnsite && (!pickupScheduled || eventIsAfter(pickupOnsite, pickupScheduled)) ? pickupOnsite : null;
  const activePickupScheduled = pickupScheduled &&
    (!pickup || eventIsAfter(pickupScheduled, pickup)) &&
    (!pickupOnsite || eventIsAfter(pickupScheduled, pickupOnsite)) &&
    (!deliveryProof || eventIsAfter(pickupScheduled, deliveryProof))
    ? pickupScheduled
    : null;
  const brokerDispatch = latestActiveBrokerDispatchEvent(events);
  // A pickup-side broker cannot schedule delivery without accepting the execution path.
  // When that proof is newer than an alert-only event, promote it to confirmed dispatch so
  // the reducer does not keep chasing a stale broker for acknowledgement.
  const scheduledDispatchAcceptance = deliveryScheduled &&
    (deliveryScheduled.broker || deliveryScheduled.contactEmail) &&
    (!brokerDispatch || eventIsAfter(deliveryScheduled, brokerDispatch))
    ? { ...deliveryScheduled, type: "broker-confirmed" }
    : null;
  const activeDispatch = scheduledDispatchAcceptance || brokerDispatch || activePickupOnsite || pickup || null;
  const openCustomsHold = exceptions.find((exception) => ["customs-hold", "inbond-rejected"].includes(exception.type));
  const customsHoldAfterRelease = openCustomsHold && (!release || eventIsAfter(openCustomsHold, release));
  const gates = {
    arrival: arrivalNegative && (!arrival || eventTime2(arrivalNegative.at) >= eventTime2(arrival.at)) && !physicalHandling
      ? gate("not-arrived", arrivalNegative)
      : arrival
        ? gate("arrived", arrival)
        : physicalHandling
          ? softGate("inferred", physicalHandling, "Later pickup/delivery evidence implies cargo was on hand; direct arrival proof is missing.")
          : openCustomsHold
            ? softGate("inferred", openCustomsHold, "Customs hold evidence implies destination customs control; direct arrival proof is missing.")
          : gate("unknown", null),
    customs: customsHoldAfterRelease
      ? gate("customs-hold", openCustomsHold)
      : release
      ? gate("released", release)
      : openCustomsHold
        ? gate("customs-hold", openCustomsHold)
        : physicalHandling
          ? softGate("unknown-offline", physicalHandling, "Pickup/delivery happened, but release/DO proof was not found in Gmail.", {
            offlinePossible: true,
          })
          : gate("unknown", null),
    fees: feesPaid
      ? gate("paid", feesPaid)
      : feesDemanded
        ? gate("due", feesDemanded)
        : physicalHandling
          ? softGate("unknown-offline", physicalHandling, "Pickup/delivery happened, but ground-handling payment proof was not found in Gmail.", {
            offlinePossible: true,
          })
          : gate("unknown", null),
    dispatch: activeDispatch
      ? gate(["broker-alerted"].includes(activeDispatch.type) ? "broker-alerted" : "broker-awarded", activeDispatch, {
        broker: activeDispatch.selectedBroker || activeDispatch.broker || "",
        contactEmail: activeDispatch.contactEmail || "",
        amount: activeDispatch.amount || "",
        lifecycleEvent: activeDispatch.type || "",
        groupAwbs: activeDispatch.groupAwbs || [],
      })
      : quote
        ? gate("quotes-in", quote, {
          broker: quote.broker || "",
          contactEmail: quote.contactEmail || "",
          amount: quote.amount || "",
        })
        : physicalHandling
          ? softGate("offline-inferred", physicalHandling, "Pickup/delivery evidence exists, but broker award/dispatch proof was not found in Gmail.", {
            offlinePossible: true,
          })
          : gate("unknown", null),
    pickup: pickup
      ? gate("picked-up", pickup, { deliveryScheduledDate: pickup.deliveryScheduledDate || "" })
      : activePickupOnsite
        ? gate("onsite", activePickupOnsite)
      : activePickupScheduled
        ? gate("scheduled", activePickupScheduled, {
          pickupScheduledDate: activePickupScheduled.pickupScheduledDate || activePickupScheduled.scheduledDate || "",
          scheduledDate: activePickupScheduled.scheduledDate || activePickupScheduled.pickupScheduledDate || "",
        })
      : deliveryProof
        ? softGate("inferred", deliveryProof, "Delivery/POD evidence implies pickup happened; direct pickup proof is missing.")
        : exceptions.some((item) => ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"].includes(item.type))
          ? softGate("waiting", null, "Pickup waits on the open document/location request.")
          : gate("unknown", null),
    delivery: pod
      ? gate("delivered", pod)
      : delivered
        ? gate("delivered", delivered)
      : deliveryScheduled
        ? gate("scheduled", deliveryScheduled, { deliveryScheduledDate: deliveryScheduled.deliveryScheduledDate || "" })
        : gate("unknown", null),
    pod: pod ? gate("received", pod) : podPending || delivered ? gate("pending", podPending || delivered) : gate("unknown", null),
  };
  // Relation enrichment: the reduced state carries who the customs broker, station, and
  // pickup broker ARE, even pre-arrival / un-awarded — operators and the referee score
  // relations independently of dispatch progress. Senders of release/arrival evidence are
  // the authoritative role holders; Piki-internal senders never become relations.
  const relationFromEvent = (event) => {
    if (!event || isPikiSender(event)) return null;
    let source = event;
    // Proof-signal events reconstructed from snapshot rows can lack a sender; borrow the
    // sender from a same-thread event that has one (and is not Piki-internal).
    if (!addressEmail(event.from || "") && event.threadId) {
      source = events.find((item) => item.threadId === event.threadId &&
        addressEmail(item.from || "") && !isPikiSender(item)) || event;
    }
    const email = addressEmail(source.from || "");
    const displayName = addressName(source.from || "");
    // A "name" that is just the email local part is not a display name — the broker
    // registry (domain -> company) is more truthful there.
    const localPartOnly = displayName && email &&
      displayName.toLowerCase().replace(/[^a-z0-9]/g, "") === email.split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
    const name = (localPartOnly ? "" : displayName) || knownBrokerNameFromEmail(email) || displayName || email;
    if (!name && !email) return null;
    // Consignee/forwarder-side contacts are never the customs broker even when their address
    // contains the word customs (contact-055@demo-freight.example class).
    if (contactLooksLikeNonBrokerRecipient({ name, email })) return null;
    return { broker: name, name, email };
  };
  const releaseEvent = latestEvent(events, ["customs-release-received"]);
  const docsExceptionEvent = [...events].reverse().find((event) =>
    event.type === "exception" && ["pickup-docs-needed", "awb-copy-needed"].includes(event.exceptionType));
  const arrivalEvidenceEvent = arrival || arrivalNegative || null;
  const brokerInferredEvent = latestEvent(events, ["customs-broker-inferred"]);
  const relationFromBrokerFields = (event) => {
    if (!event) return null;
    const email = event.contactEmail || "";
    const name = event.broker || event.selectedBroker || knownBrokerNameFromEmail(email) || "";
    if (!name && !email) return null;
    if (contactLooksLikeNonBrokerRecipient({ name, email })) return null;
    return { broker: name || email, name: name || email, email };
  };
  // The newest hold message is often our own chase; the relation is the newest hold-thread
  // sender who is actually a plausible broker (Piki/consignee/forwarder-side senders skip).
  const holdExceptionEvent = [...events].reverse().find((event) =>
    event.type === "exception" && ["customs-hold", "inbond-rejected"].includes(event.exceptionType) &&
    relationFromEvent(event) !== null);
  // Docs-request/hold messages are routinely SENT by the origin forwarder desk
  // while the actual brokerage sits in the recipients. A known-broker roster
  // recipient therefore beats the sender (INC class: DGFIL forwarder desk stored
  // as customs broker for WWL-brokered shipments).
  const relationFromRosterBroker = (event) => {
    if (!event) return null;
    const rosterEntry = splitEmailList(`${event.to || ""},${event.cc || ""}`)
      .map((entry) => ({ name: addressName(entry), email: addressEmail(entry) }))
      .find((entry) => entry.email && knownBrokerNameFromEmail(entry.email));
    if (!rosterEntry) return null;
    const brokerName = knownBrokerNameFromEmail(rosterEntry.email);
    return { broker: brokerName, name: rosterEntry.name || brokerName, email: rosterEntry.email };
  };
  const customsBrokerRelation = relationFromBrokerFields(brokerInferredEvent) ||
    relationFromEvent(releaseEvent) ||
    relationFromRosterBroker(docsExceptionEvent) ||
    relationFromEvent(docsExceptionEvent) ||
    relationFromRosterBroker(holdExceptionEvent) ||
    relationFromEvent(holdExceptionEvent);
  const stationAskEvent = latestEvent(events, ["station-ask-sent"]);
  const relationFromAskRecipients = (event) => {
    if (!event) return null;
    const desk = event.contactEmail || stationDeskFromRecipients(event.to || "");
    if (!desk) return null;
    return { broker: desk, name: "", email: desk };
  };
  const stationRelation = relationFromEvent(arrivalEvidenceEvent) || relationFromAskRecipients(stationAskEvent);
  const pickupBrokerRelation = activeDispatch
    ? { broker: activeDispatch.broker || "", name: activeDispatch.broker || "", email: activeDispatch.contactEmail || "" }
    : null;
  const base = {
    awb: proof.awb,
    source: "gmail-direct-ingest",
    updatedAt: now.toISOString(),
    latestEventAt: proof.latestEventAt || latestEvent(events)?.at || "",
    gates,
    exceptions,
    events,
    customsBroker: customsBrokerRelation,
    station: stationRelation,
    pickupBroker: pickupBrokerRelation,
    relations: { customsBroker: customsBrokerRelation, station: stationRelation, pickupBroker: pickupBrokerRelation },
  };
  const state = {
    ...base,
    urgency: urgencyFromState(base),
    nextAction: nextActionFromState(base),
    phase: phaseFromState(base),
  };
  return {
    ...state,
    summary: summarizeCanonicalState(state),
  };
}

function buildShipmentEventsSnapshot(proofs, now = new Date()) {
  const events = mergeEvents((proofs || []).flatMap((proof) => allProofEvents(proof)));
  return {
    snapshotTime: now.toISOString(),
    source: "gmail-direct-ingest",
    events,
  };
}

function buildShipmentStateSnapshot(proofs, now = new Date()) {
  const shipments = (proofs || [])
    .filter((proof) => proof?.awb)
    .map((proof) => shipmentStateFromProof(proof, now));
  return {
    snapshotTime: now.toISOString(),
    source: "gmail-direct-ingest",
    shipments,
  };
}

function eventIsAfter(candidate, reference) {
  const candidateTime = eventTimestamp(candidate);
  const referenceTime = eventTimestamp(reference);
  if (!candidateTime || !referenceTime) return Boolean(candidateTime && !referenceTime);
  return candidateTime > referenceTime;
}

function notificationSubtitle(state, event = {}) {
  return [event.requestedStation || state.station, event.broker || event.selectedBroker, state.awb]
    .filter(Boolean)
    .join(" · ");
}

function notificationContactName(event = {}) {
  return addressName(event.from || "") || addressEmail(event.from || "") || "Pickup broker";
}

function notificationTimeMs(notification) {
  const parsed = Date.parse(notification?.occurredAt || notification?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function operatorNotificationConditionKey(notification) {
  const explicit = String(notification?.conditionKey || notification?.source?.conditionKey || "").trim();
  if (explicit) return explicit;
  const awb = normalizeAwb(notification?.awb || notification?.source?.awb || "");
  const type = String(notification?.type || notification?.eventType || "operator-event").toLowerCase().trim();
  return awb && type ? `${awb}:${type}` : String(notification?.id || "");
}

function mergeOperatorNotificationCondition(previous, incoming) {
  if (!previous) return incoming;
  const previousTime = notificationTimeMs(previous);
  const incomingTime = notificationTimeMs(incoming);
  const first = previousTime && incomingTime && incomingTime < previousTime ? incoming : previous;
  const latest = incomingTime >= previousTime ? incoming : previous;
  return {
    ...first,
    ...latest,
    id: first.id || latest.id,
    eventId: first.eventId || first.id || latest.eventId || latest.id,
    source: latest.source || first.source || {},
  };
}

function collapseOperatorNotifications(notifications) {
  const byCondition = new Map();
  for (const notification of notifications || []) {
    if (!notification?.id) continue;
    const key = operatorNotificationConditionKey(notification);
    if (!key) continue;
    byCondition.set(key, mergeOperatorNotificationCondition(byCondition.get(key), notification));
  }
  return [...byCondition.values()];
}

const NOTIFIABLE_EXCEPTION_TYPES = new Set([
  "wrong-consignee-delivery",
  "delivery-facility-closed",
  "storage-needed-after-delivery-blocker",
  "station-cargo-not-found",
  "station-release-not-visible",
  "piece-count-mismatch",
  "airline-transmission-blocker",
  "storage-or-detention-cost",
  "loading-problem",
  "driver-waiting",
  "broker-release-pending",
  "pickup-location-requested",
  "pickup-docs-needed",
  "awb-copy-needed",
  "inbond-rejected",
  "customs-hold",
]);

function exceptionNotificationTitle(exception) {
  if (exception.type === "pickup-location-requested") return "Pickup location needed";
  if (exception.type === "awb-copy-needed") return "AWB copy needed";
  if (exception.type === "pickup-docs-needed") return "Delivery order/docs needed";
  if (exception.type === "driver-waiting") return "Driver waiting at airport";
  if (exception.type === "station-cargo-not-found") return "Cargo not found at station";
  if (exception.type === "wrong-consignee-delivery") return "Wrong consignee delivery";
  if (exception.type === "station-release-not-visible" || exception.type === "airline-transmission-blocker") return "Airport release blocker";
  if (exception.type === "piece-count-mismatch") return "Piece count mismatch";
  if (exception.type === "storage-or-detention-cost") return "Storage/detention cost";
  if (exception.type === "delivery-facility-closed") return "Delivery blocked";
  if (exception.type === "storage-needed-after-delivery-blocker") return "Storage decision needed";
  if (exception.type === "loading-problem") return "Loading problem";
  if (exception.type === "broker-release-pending") return "Release/DO needed";
  return "Shipment needs attention";
}

function exceptionNotificationMessage(state, exception) {
  const contact = notificationContactName(exception);
  if (exception.type === "pickup-location-requested") {
    const station = exception.requestedStation || state.station || "airport";
    return `${contact} asked for the ${station} pickup location.`;
  }
  if (exception.type === "pickup-docs-needed") {
    return exception.carrierName
      ? `${contact} needs the delivery order/docs for ${exception.carrierName}.`
      : `${contact} needs the remaining pickup docs or delivery order.`;
  }
  if (exception.type === "awb-copy-needed") return `${contact} asked for a copy of the AWB.`;
  if (exception.type === "piece-count-mismatch") return "Piece count or freight availability does not match.";
  if (exception.type === "station-cargo-not-found") return "Station/pickup side cannot locate the cargo.";
  if (exception.type === "wrong-consignee-delivery") return "Shipment appears delivered to the wrong consignee/customer.";
  if (exception.type === "storage-or-detention-cost") return "Storage or detention cost is being reported.";
  return exception.summary || "An operational exception needs attention.";
}

function buildExceptionNotification(state, exception, now) {
  return {
    id: [normalizeAwb(state.awb), "operator", exception.type, exception.threadId || "", exception.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: exception.type,
    severity: exception.severity || "urgent",
    status: "active",
    title: exceptionNotificationTitle(exception),
    subtitle: notificationSubtitle(state, exception),
    message: exceptionNotificationMessage(state, exception),
    nextAction: exception.nextAction || state.nextAction || "Review the thread and decide the operator move.",
    occurredAt: exception.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: exception.threadId || "",
      messageId: exception.messageId || "",
      from: exception.from || "",
      subject: exception.subject || "",
    },
  };
}

function buildPickupOnsiteNotification(state, event, now) {
  const contact = notificationContactName(event);
  return {
    id: [normalizeAwb(state.awb), "operator", "pickup-onsite", event.threadId || "", event.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: "pickup-onsite",
    severity: "immediate",
    status: "active",
    title: "Carrier onsite",
    subtitle: notificationSubtitle(state, event),
    message: `${contact} says the carrier is onsite for pickup.`,
    nextAction: event.nextAction || "Get loaded proof; if loading stalls, clear the airport blocker now.",
    occurredAt: event.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      from: event.from || "",
      subject: event.subject || "",
    },
  };
}

function buildPickupLoadedNotification(state, event, now) {
  const contact = notificationContactName(event);
  return {
    id: [normalizeAwb(state.awb), "operator", "pickup-loaded", event.threadId || "", event.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: "pickup-loaded",
    severity: "work",
    status: "active",
    title: "Truck loaded",
    subtitle: notificationSubtitle(state, event),
    message: `${contact} says the truck is loaded.`,
    nextAction: "Track final delivery and collect POD from the pickup thread.",
    occurredAt: event.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      from: event.from || "",
      subject: event.subject || "",
    },
  };
}

function buildDeliveredPodMissingNotification(state, event, now) {
  const contact = notificationContactName(event);
  return {
    id: [normalizeAwb(state.awb), "operator", "delivered-pod-missing", event.threadId || "", event.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: "delivered-pod-missing",
    severity: "today",
    status: "active",
    title: "Delivered; POD missing",
    subtitle: notificationSubtitle(state, event),
    message: `${contact} reported delivery, but POD is still missing.`,
    nextAction: "Request the signed POD in the delivery/pickup thread.",
    occurredAt: event.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      from: event.from || "",
      subject: event.subject || "",
    },
  };
}

function buildDeliveredPodReceivedNotification(state, event, now) {
  const contact = notificationContactName(event);
  return {
    id: [normalizeAwb(state.awb), "operator", "delivered-pod-received", event.threadId || "", event.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: "delivered-pod-received",
    severity: "work",
    status: "active",
    title: "Delivered; POD found",
    subtitle: notificationSubtitle(state, event),
    message: `${contact} sent delivery/POD proof.`,
    nextAction: "No action needed unless TMS still needs POD closeout.",
    occurredAt: event.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      from: event.from || "",
      subject: event.subject || "",
    },
  };
}

function ledgerFactTimeMs(fact = {}) {
  const item = fact || {};
  const parsed = Date.parse(item.occurredAt || item.observedAt || item.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function ledgerNotificationMaxAgeMs(env = process.env) {
  const hours = Number(env.PQ_LEDGER_OPERATOR_NOTIFICATION_MAX_AGE_HOURS || DEFAULT_LEDGER_NOTIFICATION_MAX_AGE_HOURS);
  return Math.max(1, Number.isFinite(hours) ? hours : DEFAULT_LEDGER_NOTIFICATION_MAX_AGE_HOURS) * 60 * 60 * 1000;
}

function ledgerFactIsFreshForNotification(fact = {}, now = new Date(), env = process.env) {
  const factTime = ledgerFactTimeMs(fact);
  if (!factTime) return false;
  return now.getTime() - factTime <= ledgerNotificationMaxAgeMs(env);
}

function latestLedgerFact(facts = [], predicate = () => true) {
  return (facts || [])
    .filter(predicate)
    .sort((a, b) => ledgerFactTimeMs(b) - ledgerFactTimeMs(a))[0] || null;
}

function ledgerFactMatches(fact = {}, patterns = []) {
  const text = `${fact.factType || fact.type || ""} ${fact.summary || ""} ${fact.evidenceText || ""} ${fact.evidence || ""}`;
  return patterns.some((pattern) => pattern.test(text));
}

function ledgerNotificationSource(fact = {}, workgroup = {}) {
  return {
    source: "operational-fact-ledger",
    factId: fact.factId || "",
    workgroupId: fact.workgroupId || workgroup.workgroupId || "",
    evidenceId: fact.evidenceId || "",
    threadId: fact.threadId || workgroup.threadId || "",
    messageId: fact.messageId || "",
    sourceType: fact.sourceType || "",
    sourceId: fact.sourceId || "",
    extractionMethod: fact.extractionMethod || "",
  };
}

function ledgerNotificationSubtitle(fact = {}, workgroup = {}) {
  return [
    workgroup.stationCode || fact.payload?.requestedStation || "",
    workgroup.brokerName || fact.payload?.broker || fact.actorName || "",
    fact.awb,
  ].filter(Boolean).join(" · ");
}

function ledgerNotificationId(fact = {}, type = "operator-event") {
  return [normalizeAwb(fact.awb), "operator", type, "ledger"].filter(Boolean).join(":");
}

function buildLedgerNotification(fact = {}, workgroup = {}, type, fields = {}, now = new Date()) {
  if (!normalizeAwb(fact.awb)) return null;
  return {
    id: ledgerNotificationId(fact, type),
    awb: fact.awb,
    type,
    severity: fields.severity || "work",
    status: "active",
    title: fields.title || "Shipment update",
    subtitle: fields.subtitle || ledgerNotificationSubtitle(fact, workgroup),
    message: fields.message || fact.summary || fact.evidenceText || "Shipment needs attention.",
    nextAction: fields.nextAction || workgroup.nextAction || fact.payload?.nextAction || "Open the shipment and decide the next operator move.",
    occurredAt: fact.occurredAt || fact.observedAt || now.toISOString(),
    createdAt: now.toISOString(),
    source: ledgerNotificationSource(fact, workgroup),
  };
}

function ledgerFactNotificationType(fact = {}) {
  const factType = String(fact.factType || fact.type || "").toLowerCase();
  if (factType === "delivered_pod_received" || factType === "pod_received") return "delivered-pod-received";
  if (factType === "delivered_pod_missing" || factType === "pod_missing_or_requested") return "delivered-pod-missing";
  if (factType === "pickup_loaded" || factType === "pickup_confirmed") return "pickup-loaded";
  if (factType === "driver_onsite") return "pickup-onsite";
  if (factType === "exception_pickup_docs_needed") return "pickup-docs-needed";
  if (factType === "exception_awb_copy_needed") return "awb-copy-needed";
  if (factType === "exception_pickup_location_requested") return "pickup-location-requested";
  if (factType === "exception_station_cargo_not_found") return "station-cargo-not-found";
  if (factType === "exception_wrong_consignee_delivery") return "wrong-consignee-delivery";
  if (factType === "exception_station_release_not_visible") return "station-release-not-visible";
  if (factType === "exception_airline_transmission_blocker") return "airline-transmission-blocker";
  if (factType === "exception_piece_count_mismatch") return "piece-count-mismatch";
  if (factType === "exception_storage_or_detention_cost") return "storage-or-detention-cost";
  if (factType === "exception_storage_needed_after_delivery_blocker") return "storage-needed-after-delivery-blocker";
  if (factType === "exception_delivery_facility_closed") return "delivery-facility-closed";
  if (factType === "exception_loading_problem") return "loading-problem";
  if (factType === "exception_driver_waiting" || factType === "pickup_blocked") return "driver-waiting";
  if (factType === "exception_broker_release_pending") return "broker-release-pending";
  if (fact.gate === "customs" && fact.polarity === "negative") return "station-release-not-visible";
  if (fact.gate === "storage" && ["negative", "requested"].includes(fact.polarity || "")) return "storage-or-detention-cost";
  if (fact.gate === "pod" && ["negative", "requested"].includes(fact.polarity || "")) return "delivered-pod-missing";
  if (fact.gate === "dispatch" && ["negative", "requested"].includes(fact.polarity || "")) {
    if (ledgerFactMatches(fact, [/location|address|pickup\s+place/i])) return "pickup-location-requested";
    if (ledgerFactMatches(fact, [/\b(?:air\s*waybill|airway\s*bill|awb|mawb)\b/i])) return "awb-copy-needed";
    if (ledgerFactMatches(fact, [/delivery\s+order|d\/?o|docs?|document|release/i])) return "pickup-docs-needed";
  }
  return "";
}

function ledgerNotificationFields(type, fact = {}, workgroup = {}) {
  const contact = fact.actorName || workgroup.brokerName || "The thread";
  if (type === "delivered-pod-received") {
    return {
      severity: "work",
      title: "Delivered; POD found",
      message: `${contact} sent delivery/POD proof.`,
      nextAction: "No action needed unless TMS still needs POD closeout.",
    };
  }
  if (type === "delivered-pod-missing") {
    return {
      severity: "today",
      title: "Delivered; POD missing",
      message: "Delivery/POD is still open in the fact ledger.",
      nextAction: "Request signed POD in the delivery or pickup thread.",
    };
  }
  if (type === "pickup-loaded") {
    return {
      severity: "work",
      title: "Truck loaded",
      message: `${contact} says the truck is loaded/picked up.`,
      nextAction: "Track final delivery and collect POD from the pickup thread.",
    };
  }
  if (type === "pickup-onsite") {
    return {
      severity: "immediate",
      title: "Carrier onsite",
      message: `${contact} says the carrier is onsite for pickup.`,
      nextAction: "Get loaded proof; if loading stalls, clear the airport blocker now.",
    };
  }
  if (type === "pickup-location-requested") {
    return {
      severity: "urgent",
      title: "Pickup location needed",
      message: `${contact} asked for the pickup location.`,
      nextAction: "Reply in the pickup thread with the station pickup location.",
    };
  }
  if (type === "pickup-docs-needed") {
    return {
      severity: "immediate",
      title: "Delivery order/docs needed",
      message: `${contact} needs the delivery order or pickup docs.`,
      nextAction: "Generate/send the delivery order, then reply in the pickup thread.",
    };
  }
  if (type === "awb-copy-needed") {
    return {
      severity: "immediate",
      title: "AWB copy needed",
      message: `${contact} asked for a copy of the AWB.`,
      nextAction: "Send the AWB copy/air waybill in the existing pickup thread.",
    };
  }
  if (type === "station-cargo-not-found") {
    return {
      severity: "immediate",
      title: "Cargo not found at station",
      message: fact.summary || "Station/pickup side cannot locate the cargo.",
      nextAction: fact.payload?.nextAction || workgroup.nextAction || "Call the station and pickup broker now; hold dispatch until the freight is physically located.",
    };
  }
  if (type === "wrong-consignee-delivery") {
    return {
      severity: "immediate",
      title: "Wrong consignee delivery",
      message: fact.summary || "Shipment appears delivered to the wrong consignee/customer.",
      nextAction: fact.payload?.nextAction || workgroup.nextAction || "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.",
    };
  }
  if (type === "station-release-not-visible" || type === "airline-transmission-blocker") {
    return {
      severity: "immediate",
      title: "Airport release blocker",
      message: fact.summary || "The station/airport cannot see release or pickup authorization.",
      nextAction: "Clear release/DO visibility with the customs broker or station before pickup.",
    };
  }
  if (type === "driver-waiting" || type === "loading-problem") {
    return {
      severity: "immediate",
      title: type === "loading-problem" ? "Loading problem" : "Driver waiting at airport",
      message: fact.summary || "Pickup is blocked while the driver/carrier is at the station.",
      nextAction: fact.payload?.nextAction || workgroup.nextAction || "Call the station/broker now and clear the pickup blocker.",
    };
  }
  if (type === "storage-or-detention-cost") {
    return {
      severity: "urgent",
      title: "Storage/detention cost",
      message: fact.summary || "Storage or detention cost is being reported.",
      nextAction: fact.payload?.nextAction || workgroup.nextAction || "Clear the blocker and stop additional storage/detention exposure.",
    };
  }
  return {
    severity: "urgent",
    title: exceptionNotificationTitle({ type }),
    message: fact.summary || "Shipment needs attention.",
    nextAction: fact.payload?.nextAction || workgroup.nextAction || "Review the evidence thread and decide the operator move.",
  };
}

function buildLedgerOperatorNotificationsSnapshot(factLedgerSnapshot = {}, now = new Date(), options = {}) {
  const notifications = [];
  const env = options.env || process.env;
  const workgroupsById = new Map((factLedgerSnapshot.workgroups || []).map((workgroup) => [workgroup.workgroupId, workgroup]));
  const factsByAwb = new Map();
  for (const fact of factLedgerSnapshot.facts || []) {
    const key = normalizeAwb(fact.awb);
    if (!key) continue;
    const list = factsByAwb.get(key) || [];
    list.push(fact);
    factsByAwb.set(key, list);
  }

  for (const facts of factsByAwb.values()) {
    const podReceived = latestLedgerFact(facts, (fact) =>
      ["pod_received", "delivered_pod_received"].includes(String(fact.factType || fact.type || "").toLowerCase()) &&
      fact.polarity === "positive"
    );
    const delivered = latestLedgerFact(facts, (fact) =>
      ["delivery_reported", "delivered_pod_missing"].includes(String(fact.factType || fact.type || "").toLowerCase()) ||
      (fact.gate === "delivery" && fact.polarity === "positive")
    );
    const pickupComplete = latestLedgerFact(facts, (fact) =>
      ["pickup_loaded", "pickup_confirmed"].includes(String(fact.factType || fact.type || "").toLowerCase()) &&
      fact.polarity === "positive"
    );
    const completedAt = Math.max(ledgerFactTimeMs(podReceived), ledgerFactTimeMs(delivered));
    const pickupCompleteAt = Math.max(ledgerFactTimeMs(pickupComplete), completedAt);

    for (const fact of facts) {
      if (!ledgerFactIsFreshForNotification(fact, now, env)) continue;
      const type = ledgerFactNotificationType(fact);
      if (!type) continue;
      const factAt = ledgerFactTimeMs(fact);
      if (type === "delivered-pod-missing" && podReceived) continue;
      if (["pickup-onsite", "pickup-loaded", "driver-waiting", "loading-problem", "pickup-docs-needed", "pickup-location-requested", "station-release-not-visible", "airline-transmission-blocker"].includes(type) && completedAt && factAt && factAt <= completedAt) continue;
      if (["pickup-onsite", "driver-waiting", "loading-problem"].includes(type) && pickupCompleteAt && factAt && factAt <= pickupCompleteAt) continue;
      if (type === "pickup-loaded" && completedAt && factAt && factAt <= completedAt) continue;
      const workgroup = workgroupsById.get(fact.workgroupId) || {};
      const notification = buildLedgerNotification(fact, workgroup, type, ledgerNotificationFields(type, fact, workgroup), now);
      if (notification) notifications.push(notification);
    }
  }

  return {
    snapshotTime: now.toISOString(),
    source: "operational-fact-ledger",
    notifications: collapseOperatorNotifications(notifications)
      .sort((a, b) => Date.parse(a.occurredAt || "") - Date.parse(b.occurredAt || "")),
  };
}

function mergeOperatorNotificationsSnapshots(snapshots = [], now = new Date()) {
  const notifications = collapseOperatorNotifications(
    (snapshots || []).flatMap((snapshot) => snapshot?.notifications || []),
  );
  return {
    snapshotTime: now.toISOString(),
    source: "gmail-direct-ingest+operational-fact-ledger",
    sources: (snapshots || []).map((snapshot) => snapshot?.source).filter(Boolean),
    notifications: notifications.sort((a, b) => Date.parse(a.occurredAt || "") - Date.parse(b.occurredAt || "")),
  };
}

const TRANSITION_NOTIFICATION_MAX_AGE_HOURS = 48;

function transitionEventFresh(event, now) {
  const at = Date.parse(event?.at || "");
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= TRANSITION_NOTIFICATION_MAX_AGE_HOURS * 3600000;
}

function buildTransitionNotification(state, event, now, fields) {
  const contact = notificationContactName(event);
  return {
    id: [normalizeAwb(state.awb), "operator", fields.type, event.threadId || "", event.messageId || ""].filter(Boolean).join(":"),
    awb: state.awb,
    type: fields.type,
    severity: fields.severity,
    status: "active",
    title: fields.title,
    subtitle: notificationSubtitle(state, event),
    message: fields.message(contact, event),
    nextAction: fields.nextAction,
    occurredAt: event.at || "",
    createdAt: now.toISOString(),
    source: {
      threadId: event.threadId || "",
      messageId: event.messageId || "",
      from: event.from || "",
      subject: event.subject || "",
    },
  };
}

function dashedAwbReference(awb) {
  const normalized = normalizeAwb(awb);
  return normalized.length === 11
    ? normalized.slice(0, 3) + "-" + normalized.slice(3)
    : normalized;
}

const CAUGHT_CONTRADICTION_NOTIFICATION_TYPES = Object.freeze({
  "customs-contested-onsite": {
    type: "caught-customs-contested",
    label: "release contested on-site",
  },
  "arrival-source-conflict": {
    type: "caught-arrival-source-conflict",
    label: "arrival sources conflict",
  },
  "dispatch-with-customs-unknown": {
    type: "caught-dispatch-customs-unknown",
    label: "dispatch release unverified",
  },
});

function operatorActionText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(
    value.nextAction ||
    value.label ||
    value.action ||
    value.summary ||
    "",
  ).trim();
}

function packetNextAction(packet = {}, preferred = "") {
  return [
    preferred,
    packet.primaryAction,
    packet.truthPacket?.nextAction,
    packet.opsState?.nextAction,
    packet.nextAction,
  ].map(operatorActionText).find(Boolean) || "";
}

function groundedCaughtMessage(message, nextAction) {
  const groundedMessage = String(message || "").trim();
  const groundedNextAction = String(nextAction || "").trim();
  if (!groundedNextAction) return groundedMessage;
  if (groundedMessage.toLowerCase().includes(groundedNextAction.toLowerCase())) {
    return groundedMessage;
  }
  return `${groundedMessage} Next: ${groundedNextAction}`;
}

function caughtNotificationSource(packet, condition, conditionKey, kind) {
  return {
    source: "shipment-truth-packet",
    conditionKey,
    awb: normalizeAwb(packet?.awb),
    conditionId: condition?.id || conditionKey,
    conditionType: kind,
    sourceFactIds: Array.isArray(condition?.sourceFactIds)
      ? condition.sourceFactIds.filter(Boolean)
      : [],
    evidence: condition?.evidence || "",
    conditionLevel: condition?.level || condition?.severity || "",
    conditionSource: condition?.source || "",
    packetCompiledAt: packet?.truthPacket?.compiledAt || packet?._truthPacketSnapshotTime || "",
  };
}

function caughtConditionOccurredAt(packet, condition, fallback) {
  const sourceFactIds = new Set(
    (Array.isArray(condition?.sourceFactIds) ? condition.sourceFactIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const matchingSourceTimes = (packet?.evidencePacket?.sourceFacts || [])
    .filter((fact) => sourceFactIds.has(String(fact?.id || "").trim()))
    .map((fact) => fact?.observedAt || fact?.occurredAt || fact?.at || fact?.capturedAt || "")
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left));
  return matchingSourceTimes[0] ||
    condition?.observedAt ||
    condition?.occurredAt ||
    condition?.at ||
    packet?.opsState?.updatedAt ||
    packet?.updatedAt ||
    packet?.latestEventAt ||
    packet?._truthPacketSnapshotTime ||
    packet?.truthPacket?.compiledAt ||
    fallback;
}

function buildCaughtContradictionNotification(packet, contradiction, now = new Date()) {
  const awb = normalizeAwb(packet?.awb);
  const rawId = String(contradiction?.id || "").trim();
  const kind = rawId.split(":").filter(Boolean).at(-1) || "";
  const mapping = CAUGHT_CONTRADICTION_NOTIFICATION_TYPES[kind];
  const operatorMessage = String(contradiction?.operatorMessage || "").trim();
  if (!awb || !mapping || !operatorMessage) return null;
  const conditionKey = `${awb}:${kind}`;
  if (rawId !== conditionKey) return null;
  const nextAction = packetNextAction(packet);
  return {
    id: conditionKey,
    eventId: conditionKey,
    conditionKey,
    awb,
    type: mapping.type,
    severity: "immediate",
    status: "active",
    title: `⚠ ${dashedAwbReference(awb)} — ${mapping.label}`,
    subtitle: [packet.station, packet.freightBroker?.broker, packet.customsBroker?.broker]
      .filter(Boolean)
      .join(" · ") || dashedAwbReference(awb),
    message: groundedCaughtMessage(operatorMessage, nextAction),
    nextAction,
    occurredAt: caughtConditionOccurredAt(packet, contradiction, now.toISOString()),
    createdAt: now.toISOString(),
    source: caughtNotificationSource(packet, contradiction, conditionKey, kind),
  };
}

function buildCaughtArrivalUnverifiedNotification(packet, now = new Date()) {
  const awb = normalizeAwb(packet?.awb);
  const risk = packet?.operationalRisk;
  const reason = String(risk?.reason || "").trim();
  if (!awb || risk?.type !== "arrival-unverified" || !reason) return null;
  const kind = "arrival-unverified";
  const conditionKey = `${awb}:${kind}`;
  const nextAction = packetNextAction(packet, risk.action);
  return {
    id: conditionKey,
    eventId: conditionKey,
    conditionKey,
    awb,
    type: "caught-arrival-unverified",
    severity: "immediate",
    status: "active",
    title: `⚠ ${dashedAwbReference(awb)} — arrival overdue and unverified`,
    subtitle: [packet.station, packet.airline].filter(Boolean).join(" · ") || dashedAwbReference(awb),
    message: groundedCaughtMessage(reason, nextAction),
    nextAction,
    occurredAt: caughtConditionOccurredAt(packet, risk, now.toISOString()),
    createdAt: now.toISOString(),
    source: caughtNotificationSource(packet, risk, conditionKey, kind),
  };
}

function buildCaughtExceptionNotifications(truthPackets, now = new Date()) {
  const notifications = [];
  for (const packet of activeTruthPacketRows(truthPackets)) {
    for (const contradiction of packet?.truthPacket?.contradictions || []) {
      const notification = buildCaughtContradictionNotification(packet, contradiction, now);
      if (notification) notifications.push(notification);
    }
    const arrivalUnverified = buildCaughtArrivalUnverifiedNotification(packet, now);
    if (arrivalUnverified) notifications.push(arrivalUnverified);
  }
  return notifications;
}

function buildAwbNearMissNotification(reference, now = new Date()) {
  const activeAwb = normalizeAwb(reference?.activeAwb);
  const token = String(reference?.token || "").trim();
  if (!activeAwb || !token) return null;
  const quote = String.fromCharCode(96);
  const summary = "Possible mistyped reference to this shipment";
  const detail = "An email referenced " + quote + token + quote +
    ", which looks like a typo of " + quote + dashedAwbReference(activeAwb) + quote +
    " — open it and confirm before trusting";
  const id = [
    activeAwb,
    "operator",
    "awb-near-miss",
    base64Url(token),
    reference.threadId || "",
    reference.messageId || "",
  ].filter(Boolean).join(":");
  return {
    id,
    conditionKey: id,
    awb: activeAwb,
    type: "awb-near-miss",
    severity: "needs-action",
    status: "active",
    summary,
    detail,
    title: summary,
    subtitle: activeAwb,
    message: detail,
    nextAction: "Open the email thread and confirm the AWB before trusting it.",
    occurredAt: reference.occurredAt || now.toISOString(),
    createdAt: now.toISOString(),
    source: {
      source: "gmail-near-miss-detector",
      conditionKey: id,
      awb: activeAwb,
      token,
      threadId: reference.threadId || "",
      messageId: reference.messageId || "",
      from: reference.from || "",
      subject: reference.subject || "",
      evidencePointer: [reference.threadId, reference.messageId].filter(Boolean).join(":"),
    },
  };
}

function buildOperatorNotificationsSnapshot(proofs, now = new Date(), options = {}) {
  const notifications = buildCaughtExceptionNotifications(options.truthPackets, now);
  for (const reference of options.nearMisses || []) {
    const notification = buildAwbNearMissNotification(reference, now);
    if (notification) notifications.push(notification);
  }
  for (const proof of proofs || []) {
    if (!proof?.awb) continue;
    const state = shipmentStateFromProof(proof, now);
    const events = allProofEvents(proof);
    const pickupOnsite = latestEvent(events, ["pickup-onsite"]);
    const pickupConfirmed = latestEvent(events, ["pickup-confirmed"]);
    const delivered = latestEvent(events, ["delivered-reported"]);
    const pod = latestEvent(events, ["pod-received"]);
    const newerPickupBlocker = (state.exceptions || []).some((exception) =>
      ["pickup-docs-needed", "pickup-location-requested", "station-release-not-visible", "airline-transmission-blocker"].includes(exception.type || "") &&
      (!pickupOnsite || eventTimestamp(exception) >= eventTimestamp(pickupOnsite))
    );
    for (const exception of state.exceptions || []) {
      if (!["immediate", "urgent"].includes(exception.severity || "")) continue;
      if (!NOTIFIABLE_EXCEPTION_TYPES.has(exception.type || "")) continue;
      if (exception.type === "driver-waiting" && pickupOnsite && !eventIsAfter(pickupConfirmed, pickupOnsite)) continue;
      notifications.push(buildExceptionNotification(state, exception, now));
    }
    if (pickupOnsite && !newerPickupBlocker && !eventIsAfter(pickupConfirmed, pickupOnsite) && !delivered && !pod) {
      notifications.push(buildPickupOnsiteNotification(state, pickupOnsite, now));
    }
    if (pickupConfirmed && !delivered && !pod) {
      notifications.push(buildPickupLoadedNotification(state, pickupConfirmed, now));
    }
    if (delivered && !pod) {
      notifications.push(buildDeliveredPodMissingNotification(state, delivered, now));
    }
    if (pod) {
      notifications.push(buildDeliveredPodReceivedNotification(state, pod, now));
    }
    const release = latestEvent(events, ["customs-release-received"]);
    if (release && transitionEventFresh(release, now) && !pod && !delivered) {
      notifications.push(buildTransitionNotification(state, release, now, {
        type: "release-received",
        severity: "today",
        title: "Release/DO received",
        message: (contact) => `${contact} sent customs release/DO proof.`,
        nextAction: "Tender pickup with the release banked; expect dispatch/loaded proof next.",
      }));
    }
    const feesDemanded = latestEvent(events, ["ground-fees-demanded"]);
    const feesPaid = latestEvent(events, ["ground-fees-paid"]);
    if (feesDemanded && transitionEventFresh(feesDemanded, now) && !eventIsAfter(feesPaid, feesDemanded) && !pod && !delivered) {
      notifications.push(buildTransitionNotification(state, feesDemanded, now, {
        type: "fees-due",
        severity: "urgent",
        title: "Fees due",
        message: (contact) => `${contact} presented a fee demand that is unpaid.`,
        nextAction: "Confirm/pay the fee and record the receipt; pickup is blocked on it.",
      }));
    }
    if (feesPaid && transitionEventFresh(feesPaid, now) && eventIsAfter(feesPaid, feesDemanded) && !pod && !delivered) {
      notifications.push(buildTransitionNotification(state, feesPaid, now, {
        type: "fees-paid",
        severity: "work",
        title: "Fees paid",
        message: (contact) => `${contact} confirmed the ground/handling fees are paid.`,
        nextAction: "Fee gate cleared; continue to pickup execution.",
      }));
    }
  }
  const byId = new Map();
  for (const notification of collapseOperatorNotifications(notifications)) {
    if (notification.id) byId.set(notification.id, { ...notification, immediateAttention: notification.severity === "immediate" });
  }
  return {
    snapshotTime: now.toISOString(),
    source: "gmail-direct-ingest",
    notifications: [...byId.values()].sort((a, b) => Date.parse(a.occurredAt || "") - Date.parse(b.occurredAt || "")),
  };
}

async function runDirectGmailRefresh({
  awbs,
  queries: providedQueries,
  requiredThreadIds = [],
  now = new Date(),
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  env = process.env,
  maxThreads,
  maxAttachmentPdfs,
  includeProofs = false,
  includeTruthPackets = false,
  memorySnapshots = {},
  write = true,
  returnMergedSnapshots = false,
  skipHostedSnapshotReads = false,
  knownAwbs = [],
  sourceTruthWarnings = [],
}) {
  let phase = "normalize-awbs";
  const snapshotLoadWarnings = [];
  try {
    const memoryTmsDetailSnapshot = memorySnapshots.tmsDetail ||
      readLocalSnapshotForGmailRefresh("tms-detail-snapshot", { shipments: [] });
    const memoryTmsGridSnapshot = memorySnapshots.tmsGrid ||
      readLocalSnapshotForGmailRefresh("tms-grid-snapshot", { rows: [] });
    let tmsDetailSnapshot = memoryTmsDetailSnapshot;
    let tmsGridSnapshot = memoryTmsGridSnapshot;
    if (includeTruthPackets || write) {
      phase = "load-tms-active-inventory";
      tmsDetailSnapshot = await loadSnapshotForGmailRefresh(
        "tms-detail-snapshot",
        memoryTmsDetailSnapshot,
        snapshotLoadWarnings,
        "memory-or-local-tms-detail-snapshot",
        { skipHostedRead: skipHostedSnapshotReads },
      );
      tmsGridSnapshot = await loadSnapshotForGmailRefresh(
        "tms-grid-snapshot",
        memoryTmsGridSnapshot,
        snapshotLoadWarnings,
        "memory-or-local-tms-grid-snapshot",
        { skipHostedRead: skipHostedSnapshotReads },
      );
    }
    const activeAwbSet = new Set((awbs || []).map(normalizeAwb).filter(Boolean));
    for (const awb of tmsSnapshotActiveAwbs(tmsDetailSnapshot, tmsGridSnapshot)) activeAwbSet.add(awb);
    const activeAwbs = [...activeAwbSet];
    if (!activeAwbs.length) return { ok: true, direct: true, updated: 0, reason: "No active AWBs" };

    phase = "gmail-token-refresh";
    const access = await refreshAccessToken(env);
    const packetQueries = [...new Set((providedQueries || [])
      .map((query) => String(query || "").trim())
      .filter(Boolean))];
    const discoveryQueries = buildDiscoverySearchQueries(lookbackDays, env);
    const searchPlans = buildGmailSearchPlans(activeAwbs, lookbackDays, packetQueries, { discoveryQueries });
    const queries = searchPlans.map((plan) => plan.query);
    const mandatoryThreadIds = [...new Set((requiredThreadIds || [])
      .map((threadId) => String(threadId || "").trim())
      .filter(Boolean))];
    const perAwbMaxResults = Number(env.PQ_GMAIL_DIRECT_MAX_THREADS_PER_AWB || 4);
    const discoveryMaxResults = Number(env.PQ_GMAIL_DISCOVERY_MAX_THREADS || 10);
    const maxThreadCount = Number(maxThreads || env.PQ_GMAIL_DIRECT_MAX_THREADS || 60);
    const perAwbMinimumThreads = Number(env.PQ_GMAIL_DIRECT_MIN_THREADS_PER_AWB || 3);
    const hardMaxThreadCount = Number(env.PQ_GMAIL_DIRECT_HARD_MAX_THREADS || 240);
    phase = "gmail-search";
    const searchResults = [];
    for (const plan of searchPlans) {
      const detailed = await listThreadIdsForQueryDetailed(
        access,
        plan.query,
        plan.family === "discovery" ? discoveryMaxResults : perAwbMaxResults,
      );
      searchResults.push({
        ...plan,
        threadIds: detailed.threadIds,
        moreAvailable: detailed.moreAvailable,
      });
    }
    // Guarantee every per-AWB search query's TOP thread is read. The coverage audit
    // ("unread-search-hit") flags any AWB whose query-top thread was dropped by the
    // thread-selection cap, which intermittently degraded the board with a different
    // shipment each run. Selection only guarantees per-AWB depth, not per-query tops;
    // pin the query tops explicitly (bounded by the finite number of search plans).
    const topPerQueryThreadIds = [...new Set((searchResults || [])
      .filter((result) => result.awb)
      .map((result) => (result.threadIds || [])[0])
      .filter(Boolean))];
    const uniqueThreadIds = [
      ...mandatoryThreadIds,
      ...topPerQueryThreadIds,
      ...selectThreadIdsBySearchPlan(searchResults, maxThreadCount, {
        perAwbMinimum: perAwbMinimumThreads,
        hardLimit: hardMaxThreadCount,
      }),
    ].filter((threadId, index, items) => threadId && items.indexOf(threadId) === index)
      .slice(0, hardMaxThreadCount);
    phase = "gmail-read-threads";
    const rawThreads = await readThreads(access, uniqueThreadIds);
    const threads = rawThreads.map((thread) => ({
      id: thread.id,
      historyId: thread.historyId || "",
      messages: (thread.messages || []).map(parseMessage),
    }));
    const priorDirectStateForCache = await loadSnapshotForGmailRefresh(
      "gmail-direct-state", {}, snapshotLoadWarnings, "empty-direct-state",
      { skipHostedRead: skipHostedSnapshotReads },
    );
    let arrivalVisionResults =
      (priorDirectStateForCache && priorDirectStateForCache.arrivalVisionResults) || {};
    phase = "gmail-attachment-enrichment";
    await enrichPdfAttachments(access, threads, env, { maxAttachmentPdfs });
    // Liberal READ, conservative CERTIFY (INC-2026-07-13e): any eligible real document may
    // be read for a pre-arrival AWB, while only the strict result boundary may stamp arrival.
    // Durable attachment-ID results replay before budget checks; skipped reads retry later.
    try {
      const arrivalNoticeVision = createArrivalNoticeVisionOcr({
        env,
        spendStore: createArrivalNoticeVisionSpendStore(env, gmailRefreshWriteOptions(env)),
      });
      const arrivalVisionResult = await enrichArrivalNoticeAttachments(access, threads, env, {
        arrivalNoticeVision,
        activeAwbs,
        arrivalCertifiedAwbs: arrivalCertifiedAwbsFromSnapshot(memorySnapshots.active || {}),
        priorVisionResults: arrivalVisionResults,
        allowNewReads: write,
      });
      arrivalVisionResults = arrivalVisionResult.visionResults || arrivalVisionResults;
      if (arrivalVisionResult.attempted || arrivalVisionResult.replayed || arrivalVisionResult.confirmed) {
        console.log(JSON.stringify({
          route: "gmail-refresh",
          event: "arrival-notice-vision",
          attempted: arrivalVisionResult.attempted,
          replayed: arrivalVisionResult.replayed,
          confirmed: arrivalVisionResult.confirmed,
          events: arrivalVisionResult.events,
          cached: Object.keys(arrivalVisionResults).length,
        }));
      }
    } catch (error) {
      console.log(JSON.stringify({ route: "gmail-refresh", event: "arrival-notice-vision-error", error: error instanceof Error ? error.message : String(error) }));
    }
    // Read POD-class image attachments the deterministic path could not resolve
    // (INC-2026-07-12b). Guarded, deterministic-first, budget-capped; skips cleanly when
    // no key / disabled / over budget, leaving unresolved PODs as "unverified".
    try {
      const podVisionOcr = createPodVisionOcr({
        env,
        spendStore: createPodVisionSpendStore(env, gmailRefreshWriteOptions(env)),
      });
      const podVisionResult = await enrichImagePodAttachments(access, threads, env, { podVisionOcr });
      if (podVisionResult.attempted) {
        console.log(JSON.stringify({ route: "gmail-refresh", event: "pod-vision", ...podVisionResult }));
      }
    } catch (error) {
      console.log(JSON.stringify({ route: "gmail-refresh", event: "pod-vision-error", error: error instanceof Error ? error.message : String(error) }));
    }

    // Model reads the deterministic residual — messages the keyword classifier left
    // unclassified (e.g. "carrier relayed a delivery ETA in Fresno" -> out_for_delivery),
    // with thread context. Guarded/deterministic-first; cleanly no-ops without a key.
    let modelEventsByKey = new Map();
    let modelClassifications = {};
    try {
      const priorClassifications =
        (priorDirectStateForCache && priorDirectStateForCache.messageClassifications) || {};
      const messageModelClassifier = createMessageModelClassifier({
        env,
        spendStore: createMessageModelSpendStore(env, gmailRefreshWriteOptions(env)),
      });
      const modelResult = await enrichThreadsWithModelSignals(access, threads, env, {
        messageModelClassifier,
        activeAwbs,
        priorClassifications,
      });
      modelEventsByKey = modelResult.modelEventsByKey;
      modelClassifications = modelResult.classifications || {};
      if (modelResult.attempted || modelResult.replayed) {
        console.log(JSON.stringify({ route: "gmail-refresh", event: "message-model", attempted: modelResult.attempted, replayed: modelResult.replayed, applied: modelResult.applied }));
      }
    } catch (error) {
      console.log(JSON.stringify({ route: "gmail-refresh", event: "message-model-error", error: error instanceof Error ? error.message : String(error) }));
    }

    phase = "gmail-summarize";
    const nearMissAwbReferences = collectNearMissAwbReferencesForThreads(
      threads,
      activeAwbs,
    ).references;
    const records = [];
    for (const thread of threads) {
      const matchedAwbs = findAwbsInThread(thread, activeAwbs);
      for (const awb of matchedAwbs) records.push(summarizeThreadForAwb(awb, thread, { threadAwbCount: matchedAwbs.length, knownAwbs: activeAwbs, modelEventsByKey }));
    }

    const grouped = new Map();
    for (const record of records) {
      const key = normalizeAwb(record.awb);
      if (!key) continue;
      const previous = grouped.get(key);
      grouped.set(key, previous ? mergeDirectRecords(previous, record) : record);
    }
    propagateScopedGroupEvents(grouped);

    let incomingProofs = [...grouped.values()].map((record) =>
      directRecordToGmailProof(record, {
        searchedQueries: queries,
        readThreadIds: uniqueThreadIds,
      })
    );
    const coverageAudit = buildGmailCoverageAudit({
      activeAwbs,
      searchResults,
      threads,
      proofs: incomingProofs,
      knownAwbs,
      now,
    });
    incomingProofs = attachGmailCoverageToProofs(incomingProofs, coverageAudit);
    if (!write && !returnMergedSnapshots) {
      const proofSnapshot = withContentSignature({
        snapshotTime: now.toISOString(),
        source: "gmail-direct-ingest",
        writerVersion: GMAIL_DIRECT_WRITER_VERSION,
        window: {
          lookbackDays,
          maxThreads: Number(maxThreads || env.PQ_GMAIL_DIRECT_MAX_THREADS || 12),
        },
        gmailCoverageAudit: coverageAudit,
        proofs: incomingProofs.map(compactProofRecordForSnapshot),
      });
      const eventsSnapshot = withContentSignature({
        ...buildShipmentEventsSnapshot(proofSnapshot.proofs || [], now),
        writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      });
      const stateSnapshot = withContentSignature({
        ...buildShipmentStateSnapshot(proofSnapshot.proofs || [], now),
        writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      });
      const proofNotificationsSnapshot = buildOperatorNotificationsSnapshot(incomingProofs, now, {
        nearMisses: nearMissAwbReferences,
      });
      const factLedgerSnapshot = buildDurableOperationalFactLedger({
        shipmentEvents: eventsSnapshot,
        shipmentState: stateSnapshot,
        active: memorySnapshots.active,
        brain: memorySnapshots.brain,
        companionMemory: memorySnapshots.companionMemory,
      }, now);
      const ledgerNotificationsSnapshot = buildLedgerOperatorNotificationsSnapshot(factLedgerSnapshot, now, { env });
      const baseNotificationsSnapshot = mergeOperatorNotificationsSnapshots([
        proofNotificationsSnapshot,
        ledgerNotificationsSnapshot,
      ], now);
      const promotedTruthPacketsSnapshot = includeTruthPackets
        ? buildGmailPromotedTruthPackets({
            previousTruthPackets: memorySnapshots.active || { shipments: [] },
            brainSnapshot: memorySnapshots.brain,
            gmailProofSnapshot: proofSnapshot,
            shipmentStateSnapshot: stateSnapshot,
            shipmentEventsSnapshot: eventsSnapshot,
            operatorNotificationsSnapshot: baseNotificationsSnapshot,
            companionMemorySnapshot: memorySnapshots.companionMemory,
            stationMemorySnapshot: memorySnapshots.stationMemory,
            tmsDetailSnapshot,
            tmsGridSnapshot,
            carrierTrackingSnapshots: memorySnapshots.carrierTrackingSnapshots,
            extraSourceTruthWarnings: sourceTruthWarnings || [],
            operationalFactLedgerSnapshot: factLedgerSnapshot,
            now,
          })
        : null;
      const caughtNotificationsSnapshot = buildOperatorNotificationsSnapshot([], now, {
        truthPackets: promotedTruthPacketsSnapshot,
      });
      const notificationsSnapshot = mergeOperatorNotificationsSnapshots([
        baseNotificationsSnapshot,
        caughtNotificationsSnapshot,
      ], now);
      const operatorEvents = operatorEventsFromNotificationsSnapshot(notificationsSnapshot, now);
      const activeAwbIndexSnapshot = promotedTruthPacketsSnapshot
        ? withContentSignature(buildActiveAwbIndexSnapshot(promotedTruthPacketsSnapshot, now))
        : null;
      return {
        ok: true,
        direct: true,
        dryRun: true,
        updated: incomingProofs.length,
        threadCount: uniqueThreadIds.length,
        queryCount: queries.length,
        searchedQueries: queries,
        readThreadIds: uniqueThreadIds,
        gmailCoverageAudit: coverageAudit,
        gmailCoverageStatus: coverageAudit.status,
        gmailCoverageProblemCount: coverageAudit.problemCount,
        attachmentAuditCount: incomingProofs.reduce((sum, proof) => sum + (proof.gmailAttachmentAudit?.length || 0), 0),
        shipmentEventCount: eventsSnapshot.events.length,
        shipmentStateCount: stateSnapshot.shipments.length,
        operatorNotificationCount: notificationsSnapshot.notifications.length,
        ledgerOperatorNotificationCount: ledgerNotificationsSnapshot.notifications.length,
        caughtOperatorNotificationCount: caughtNotificationsSnapshot.notifications.length,
        operationalFactCount: factLedgerSnapshot.facts.length,
        operationalWorkgroupCount: factLedgerSnapshot.workgroups.length,
        operatorEventCount: operatorEvents.length,
        truthPacketsChanged: Boolean(promotedTruthPacketsSnapshot),
        truthPacketActiveShipmentCount: promotedTruthPacketsSnapshot?.counts?.activeShipments || 0,
        truthPacketGmailPromotedActiveShipmentCount: promotedTruthPacketsSnapshot?.counts?.gmailPromotedActiveShipments || 0,
        updatedAwbs: incomingProofs.map((proof) => proof.awb),
        ...(includeProofs
          ? {
              proofs: incomingProofs,
              gmailProofSnapshot: proofSnapshot,
              shipmentEvents: eventsSnapshot,
              shipmentState: stateSnapshot,
              operatorNotifications: notificationsSnapshot,
              proofOperatorNotifications: proofNotificationsSnapshot,
              ledgerOperatorNotifications: ledgerNotificationsSnapshot,
              caughtOperatorNotifications: caughtNotificationsSnapshot,
              operationalFactLedger: factLedgerSnapshot,
              operatorEvents,
            }
          : {}),
        ...(includeTruthPackets
          ? {
              truthPackets: promotedTruthPacketsSnapshot,
              activeAwbIndex: activeAwbIndexSnapshot,
            }
          : {}),
      };
    }
    phase = "load-existing-gmail-proof";
    const previousSnapshot = await loadSnapshotForGmailRefresh(
      "gmail-proof-snapshot",
      { proofs: [] },
      snapshotLoadWarnings,
      "empty-gmail-proof-snapshot",
      { skipHostedRead: skipHostedSnapshotReads },
    );
    const memoryTruthPacketsSnapshot = Array.isArray(memorySnapshots.active?.shipments)
      ? memorySnapshots.active
      : { shipments: [] };
    const latestTruthPacketsSnapshot = await loadSnapshotForGmailRefresh(
      "shipment-truth-packets",
      memoryTruthPacketsSnapshot,
      snapshotLoadWarnings,
      "memory-truth-packets",
      { skipHostedRead: skipHostedSnapshotReads },
    );
    const previousTruthPacketsSnapshot = mergeTruthPacketSnapshotsForPromotion(
      memoryTruthPacketsSnapshot,
      latestTruthPacketsSnapshot,
    );
    phase = "merge-gmail-proof";
    const retainedProofs = filterProofsByAwbs(previousSnapshot.proofs || [], activeAwbs);
    const mergedProofs = replaceRefreshedProofs(retainedProofs, incomingProofs).map(compactProofRecordForSnapshot);

    const next = withContentSignature({
      snapshotTime: now.toISOString(),
      source: "gmail-direct-ingest",
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      window: {
        lookbackDays,
        maxThreads: Number(maxThreads || env.PQ_GMAIL_DIRECT_MAX_THREADS || 12),
      },
      gmailCoverageAudit: coverageAudit,
      proofs: mergedProofs,
    });
    const previousContentSignature = previousSnapshot.contentSignature || contentSignature(previousSnapshot || {});
    const proofChanged = next.contentSignature !== previousContentSignature;
    const eventsSnapshot = withContentSignature({
      ...buildShipmentEventsSnapshot(next.proofs || [], now),
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
    });
    const stateSnapshot = withContentSignature({
      ...buildShipmentStateSnapshot(next.proofs || [], now),
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
    });
    const proofNotificationsSnapshot = buildOperatorNotificationsSnapshot(next.proofs || [], now, {
      nearMisses: nearMissAwbReferences,
    });
    const previousDerivedSnapshots = {
      "shipment-events": await loadSnapshotForGmailRefresh("shipment-events", {}, snapshotLoadWarnings, "empty-derived-snapshot", { skipHostedRead: skipHostedSnapshotReads }),
      "shipment-state": await loadSnapshotForGmailRefresh("shipment-state", {}, snapshotLoadWarnings, "empty-derived-snapshot", { skipHostedRead: skipHostedSnapshotReads }),
      "operator-notifications": await loadSnapshotForGmailRefresh("operator-notifications", {}, snapshotLoadWarnings, "empty-derived-snapshot", { skipHostedRead: skipHostedSnapshotReads }),
      "operational-fact-ledger": await loadSnapshotForGmailRefresh("operational-fact-ledger", {}, snapshotLoadWarnings, "empty-derived-snapshot", { skipHostedRead: skipHostedSnapshotReads }),
    };
    const baseFactLedgerSnapshot = buildDurableOperationalFactLedger({
      shipmentEvents: eventsSnapshot,
      shipmentState: stateSnapshot,
      active: memorySnapshots.active,
      brain: memorySnapshots.brain,
      companionMemory: memorySnapshots.companionMemory,
    }, now);
    const mergedFactLedgerSnapshot = mergePreviousExtractionResults(
      baseFactLedgerSnapshot,
      previousDerivedSnapshots["operational-fact-ledger"],
    );
    const aiFactLedgerSnapshot = await runAiExtractionForLedger(mergedFactLedgerSnapshot, { env, now });
    const factLedgerSnapshot = withContentSignature({
      ...aiFactLedgerSnapshot,
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
    });
    const ledgerNotificationsSnapshot = buildLedgerOperatorNotificationsSnapshot(factLedgerSnapshot, now, { env });
    const baseNotificationsSnapshot = withContentSignature({
      ...mergeOperatorNotificationsSnapshots([
        proofNotificationsSnapshot,
        ledgerNotificationsSnapshot,
      ], now),
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      ledgerNotificationCount: ledgerNotificationsSnapshot.notifications.length,
      proofNotificationCount: proofNotificationsSnapshot.notifications.length,
    });
    const promotedTruthPacketsSnapshot = buildGmailPromotedTruthPackets({
      previousTruthPackets: previousTruthPacketsSnapshot,
      brainSnapshot: memorySnapshots.brain,
      gmailProofSnapshot: next,
      shipmentStateSnapshot: stateSnapshot,
      shipmentEventsSnapshot: eventsSnapshot,
      operatorNotificationsSnapshot: baseNotificationsSnapshot,
      companionMemorySnapshot: memorySnapshots.companionMemory,
      stationMemorySnapshot: memorySnapshots.stationMemory,
      tmsDetailSnapshot,
      tmsGridSnapshot,
      carrierTrackingSnapshots: memorySnapshots.carrierTrackingSnapshots,
      extraSourceTruthWarnings: sourceTruthWarnings || [],
      operationalFactLedgerSnapshot: factLedgerSnapshot,
      now,
    });
    const caughtNotificationsSnapshot = buildOperatorNotificationsSnapshot([], now, {
      truthPackets: promotedTruthPacketsSnapshot,
    });
    const notificationsSnapshot = withContentSignature({
      ...mergeOperatorNotificationsSnapshots([
        baseNotificationsSnapshot,
        caughtNotificationsSnapshot,
      ], now),
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      ledgerNotificationCount: ledgerNotificationsSnapshot.notifications.length,
      proofNotificationCount: proofNotificationsSnapshot.notifications.length,
      caughtNotificationCount: caughtNotificationsSnapshot.notifications.length,
    });
    const previousActionQueueSnapshot = promotedTruthPacketsSnapshot
      ? await loadSnapshotForGmailRefresh("action-queue", { actions: [] }, snapshotLoadWarnings, "empty-action-queue", { skipHostedRead: skipHostedSnapshotReads })
      : { actions: [] };
    const actionQueuePruneResult = promotedTruthPacketsSnapshot
      ? pruneActionQueueAgainstTruthPackets(previousActionQueueSnapshot, promotedTruthPacketsSnapshot, now)
      : { changed: false, payload: previousActionQueueSnapshot, prunedActionIds: [], prunedAwbs: [] };
    const previousTruthPacketsContentSignature =
      previousTruthPacketsSnapshot.contentSignature || contentSignature(previousTruthPacketsSnapshot || {});
    const truthPacketsChanged = Boolean(
      promotedTruthPacketsSnapshot &&
        promotedTruthPacketsSnapshot.contentSignature !== previousTruthPacketsContentSignature,
    );
    const derivedSnapshots = {
      "shipment-events": eventsSnapshot,
      "shipment-state": stateSnapshot,
      "operator-notifications": notificationsSnapshot,
      "operational-fact-ledger": factLedgerSnapshot,
    };
    // Write a derived snapshot only when its own content changed. proofChanged used to force
    // all of them (~1.4MB) even when byte-identical — the signature already proves equality,
    // so an unchanged derived snapshot never needs to travel.
    const derivedSnapshotWrites = Object.entries(derivedSnapshots)
      .filter(([key, snapshot]) =>
        snapshot.contentSignature !== (
          previousDerivedSnapshots[key]?.contentSignature ||
          contentSignature(previousDerivedSnapshots[key] || {})
        )
      )
      .map(([key]) => key);
    const skippedDerivedSnapshotWrites = Object.keys(derivedSnapshots)
      .filter((key) => !derivedSnapshotWrites.includes(key));
    const actionQueueChanged = Boolean(actionQueuePruneResult.changed);
    const legacyTruthPublishDisabled = strictBooleanEnv(env.PQ_LEGACY_TRUTH_PUBLISH_DISABLED, false);
    const changed = proofChanged || derivedSnapshotWrites.length > 0 || truthPacketsChanged || actionQueueChanged;
    const activeAwbIndexSnapshot = promotedTruthPacketsSnapshot
      ? withContentSignature(buildActiveAwbIndexSnapshot(promotedTruthPacketsSnapshot, now))
      : null;
    const actionQueueSnapshot = withContentSignature(actionQueuePruneResult.payload || { actions: [] });
    // TMS source keys have one writer: the sequential source-sync phase. Gmail
    // reduction may consume them, but persisting a snapshot held in memory can
    // roll back a newer source cut when the scheduled and manual triggers race.
    const tmsSnapshotWrites = [];
    const state = {
      snapshotTime: now.toISOString(),
      source: "gmail-direct-ingest",
      writerVersion: GMAIL_DIRECT_WRITER_VERSION,
      changed,
      proofChanged,
      lookbackDays,
      messageClassifications: pruneMessageClassifications(modelClassifications, threads),
      arrivalVisionResults: pruneArrivalVisionResults(arrivalVisionResults, threads),
      searchedQueries: queries,
      readThreadIds: uniqueThreadIds,
      gmailCoverageStatus: coverageAudit.status,
      gmailCoverageProblemCount: coverageAudit.problemCount,
      gmailCoverageProblems: coverageAudit.problems || [],
      updatedAwbs: incomingProofs.map((proof) => proof.awb),
      retainedAwbs: retainedProofs.map((proof) => proof.awb),
      mergedAwbs: mergedProofs.map((proof) => proof.awb),
      attachmentAuditCount: incomingProofs.reduce((sum, proof) => sum + (proof.gmailAttachmentAudit?.length || 0), 0),
      shipmentEventCount: eventsSnapshot.events.length,
      shipmentStateCount: stateSnapshot.shipments.length,
      operatorNotificationCount: notificationsSnapshot.notifications.length,
      ledgerOperatorNotificationCount: ledgerNotificationsSnapshot.notifications.length,
      proofOperatorNotificationCount: proofNotificationsSnapshot.notifications.length,
      caughtOperatorNotificationCount: caughtNotificationsSnapshot.notifications.length,
      operationalFactCount: factLedgerSnapshot.facts.length,
      operationalWorkgroupCount: factLedgerSnapshot.workgroups.length,
      truthPacketsChanged,
      // Signature of the truth this run built and verified — even when the write is
      // skipped as unchanged, a fresh run with a matching signature proves the stored
      // packet is current. Freshness readers use this instead of forcing rewrites.
      truthPacketContentSignature: promotedTruthPacketsSnapshot?.contentSignature || "",
      actionQueueChanged,
      prunedActionQueueActionCount: actionQueuePruneResult.prunedActionIds?.length || 0,
      prunedActionQueueAwbs: actionQueuePruneResult.prunedAwbs || [],
      truthPacketActiveShipmentCount: promotedTruthPacketsSnapshot?.counts?.activeShipments || 0,
      truthPacketGmailPromotedActiveShipmentCount: promotedTruthPacketsSnapshot?.counts?.gmailPromotedActiveShipments || 0,
      activeAwbIndexChanged: truthPacketsChanged,
      activeAwbIndexActiveShipmentCount: activeAwbIndexSnapshot?.counts?.activeShipments || 0,
      ...(legacyTruthPublishDisabled ? { legacyTruthPublicationDisabled: true } : {}),
      tmsSnapshotWrites,
      snapshotLoadWarnings,
      hostedSnapshotReadsSkipped: Boolean(skipHostedSnapshotReads),
      contentSignature: next.contentSignature,
      previousContentSignature,
      derivedSnapshotWrites,
      skippedDerivedSnapshotWrites,
      heavySnapshotWrites: [
        ...(proofChanged ? ["gmail-proof-snapshot"] : []),
        ...tmsSnapshotWrites,
        ...derivedSnapshotWrites,
        ...(truthPacketsChanged && !legacyTruthPublishDisabled ? ["shipment-truth-packets"] : []),
        ...(truthPacketsChanged && !legacyTruthPublishDisabled ? ["active-awb-index"] : []),
        ...(actionQueueChanged ? ["action-queue"] : []),
      ],
      skippedHeavySnapshotWrites: [
        ...(proofChanged ? [] : ["gmail-proof-snapshot"]),
        ...(tmsSnapshotWrites.includes("tms-detail-snapshot") ? [] : ["tms-detail-snapshot"]),
        ...(tmsSnapshotWrites.includes("tms-grid-snapshot") ? [] : ["tms-grid-snapshot"]),
        ...skippedDerivedSnapshotWrites,
        ...(truthPacketsChanged && !legacyTruthPublishDisabled ? [] : ["shipment-truth-packets"]),
        ...(truthPacketsChanged && !legacyTruthPublishDisabled ? [] : ["active-awb-index"]),
        ...(actionQueueChanged ? [] : ["action-queue"]),
      ],
    };
    const writeOptions = gmailRefreshWriteOptions(env);
    const ledgerWriteOptions = gmailRefreshLedgerWriteOptions(env);
    const truthWriteOptions = gmailRefreshTruthWriteOptions(env);
    state.snapshotWriteTimeoutMs = writeOptions.timeoutMs;
    state.factLedgerWriteTimeoutMs = ledgerWriteOptions.timeoutMs;
    state.proofSnapshotWriteTimeoutMs = gmailRefreshProofWriteOptions(env).timeoutMs;
    state.truthPacketWriteTimeoutMs = truthWriteOptions.timeoutMs;

    if (!write && returnMergedSnapshots) {
      const operatorEvents = operatorEventsFromNotificationsSnapshot(notificationsSnapshot, now);
      return {
        ok: true,
        direct: true,
        dryRun: true,
        snapshotOnly: true,
        changed: state.changed,
        proofChanged: state.proofChanged,
        updated: incomingProofs.length,
        threadCount: uniqueThreadIds.length,
        queryCount: queries.length,
        attachmentAuditCount: state.attachmentAuditCount,
        gmailCoverageStatus: state.gmailCoverageStatus,
        gmailCoverageProblemCount: state.gmailCoverageProblemCount,
        gmailCoverageProblems: state.gmailCoverageProblems,
        shipmentEventCount: state.shipmentEventCount,
        shipmentStateCount: state.shipmentStateCount,
        operatorNotificationCount: state.operatorNotificationCount,
        operationalFactCount: state.operationalFactCount,
        operationalWorkgroupCount: state.operationalWorkgroupCount,
        truthPacketsChanged,
        actionQueueChanged,
        truthPacketActiveShipmentCount: state.truthPacketActiveShipmentCount,
        truthPacketGmailPromotedActiveShipmentCount: state.truthPacketGmailPromotedActiveShipmentCount,
        updatedAwbs: state.updatedAwbs,
        snapshotLoadWarnings: state.snapshotLoadWarnings,
        hostedSnapshotReadsSkipped: state.hostedSnapshotReadsSkipped,
        heavySnapshotWrites: state.heavySnapshotWrites,
        skippedHeavySnapshotWrites: state.skippedHeavySnapshotWrites,
        searchedQueries: queries,
        readThreadIds: uniqueThreadIds,
        gmailCoverageAudit: coverageAudit,
        gmailDirectState: state,
        gmailProofSnapshot: next,
        shipmentEvents: eventsSnapshot,
        shipmentState: stateSnapshot,
        operatorNotifications: notificationsSnapshot,
        proofOperatorNotifications: proofNotificationsSnapshot,
        ledgerOperatorNotifications: ledgerNotificationsSnapshot,
        caughtOperatorNotifications: caughtNotificationsSnapshot,
        operationalFactLedger: factLedgerSnapshot,
        operatorEvents,
        truthPackets: promotedTruthPacketsSnapshot,
        activeAwbIndex: activeAwbIndexSnapshot,
        actionQueue: actionQueueSnapshot,
      };
    }

    phase = "upsert-operational-fact-ledger";
    const operationalFactLedgerResult = await upsertOpsFactLedger(factLedgerSnapshot, ledgerWriteOptions);

    phase = "upsert-gmail-proof";
    const proofWriteOptions = gmailRefreshProofWriteOptions(env);
    if (proofChanged) {
      await upsertAppSnapshot("gmail-proof-snapshot", postgresSafeJson(next), proofWriteOptions);
    }
    for (const snapshotKey of derivedSnapshotWrites) {
      await upsertAppSnapshot(snapshotKey, postgresSafeJson(derivedSnapshots[snapshotKey]), writeOptions);
    }
    if (truthPacketsChanged) {
      phase = "verify-tms-source-watermark";
      const currentTmsMetadata = await loadAppSnapshotMetadataRows(TMS_SOURCE_SNAPSHOT_KEYS, {
        timeoutMs: REFRESH_SNAPSHOT_TIMEOUT_MS,
        retryDelaysMs: [],
      });
      assertCanonicalTmsWatermarkCurrent(promotedTruthPacketsSnapshot, currentTmsMetadata);
      if (!legacyTruthPublishDisabled) {
        phase = "upsert-truth-packets";
        await publishHostedCanonicalTruth(postgresSafeJson(promotedTruthPacketsSnapshot), {
          upsertAppSnapshot,
          writeOptions: truthWriteOptions,
          trigger: "gmail-direct",
        });
        await upsertAppSnapshot("active-awb-index", postgresSafeJson(activeAwbIndexSnapshot), writeOptions);
      }
    }
    phase = "upsert-action-queue";
    if (actionQueueChanged) {
      await upsertAppSnapshot("action-queue", postgresSafeJson(actionQueueSnapshot), writeOptions);
    }
    phase = "upsert-gmail-direct-state";
    await upsertAppSnapshot("gmail-direct-state", postgresSafeJson(state), writeOptions);

    let operatorEventsResult = null;
    let operatorPushResult = null;
    try {
      operatorEventsResult = await upsertOperatorEventsFromNotificationsSnapshot(notificationsSnapshot, now, {
        previousSnapshot: previousDerivedSnapshots["operator-notifications"],
      });
      operatorPushResult = await deliverPendingOperatorPushes({ limit: 20 });
    } catch (error) {
      operatorEventsResult = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      direct: true,
      changed: state.changed,
      updated: incomingProofs.length,
      threadCount: uniqueThreadIds.length,
      queryCount: queries.length,
      attachmentAuditCount: state.attachmentAuditCount,
      gmailCoverageStatus: state.gmailCoverageStatus,
      gmailCoverageProblemCount: state.gmailCoverageProblemCount,
      gmailCoverageProblems: state.gmailCoverageProblems,
      shipmentEventCount: state.shipmentEventCount,
      shipmentStateCount: state.shipmentStateCount,
      operatorNotificationCount: state.operatorNotificationCount,
      operationalFactCount: state.operationalFactCount,
      operationalWorkgroupCount: state.operationalWorkgroupCount,
      operationalFactLedger: operationalFactLedgerResult,
      operatorEvents: operatorEventsResult,
      operatorPush: operatorPushResult,
      truthPacketsChanged,
      truthPacketContentSignature: state.truthPacketContentSignature,
      truthPacketActiveShipmentCount: state.truthPacketActiveShipmentCount,
      truthPacketGmailPromotedActiveShipmentCount: state.truthPacketGmailPromotedActiveShipmentCount,
      tmsSnapshotWrites: state.tmsSnapshotWrites,
      updatedAwbs: state.updatedAwbs,
      snapshotLoadWarnings: state.snapshotLoadWarnings,
      hostedSnapshotReadsSkipped: state.hostedSnapshotReadsSkipped,
      heavySnapshotWrites: state.heavySnapshotWrites,
      skippedHeavySnapshotWrites: state.skippedHeavySnapshotWrites,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${phase}: ${message}`);
  }
}

function mergeDirectRecords(previous, incoming) {
  const current = preferredRecord(previous, incoming);
  const older = current === incoming ? previous : incoming;
  const proof = mergeEvidence(previous.proof || [], incoming.proof || []);
  const events = mergeEvents([...(previous.events || []), ...(incoming.events || [])]);
  return {
    ...older,
    ...current,
    proof,
    events,
    attachmentAudit: mergeEvidence(previous.attachmentAudit || [], incoming.attachmentAudit || []),
    latestEventAt: newestIso(previous.latestEventAt, incoming.latestEventAt),
    summary: current.summary || older.summary,
    nextAction: current.nextAction || older.nextAction,
  };
}

module.exports = {
  buildSearchQueries,
  buildOperationalSearchQueries,
  buildReleaseSearchQueries,
  checkDirectGmailAuth,
  createGmailDraft,
  sendGmailDraftById,
  gmailDirectAvailable,
  gmailDirectEnabled,
  gmailDirectEnv,
  runDirectGmailRefresh,
  _test: {
    strictBooleanEnv,
    extractOperationalEvents,
    isVisionEligibleArrivalCandidate,
    arrivalVisionResultCertifies,
    pruneArrivalVisionResults,
    enrichArrivalNoticeAttachments,
    createArrivalNoticeVisionSpendStore,
    shipmentHasCertifiedArrival,
    arrivalCertifiedAwbsFromSnapshot,
    enrichThreadsWithModelSignals,
    isSubstantiveMessage,
    hasGroupCoordinationInstructionEvidence,
    podClassAttachmentCount,
    hasPluralPodWording,
    buildOperationalSearchQueries,
    buildReleaseSearchQueries,
    buildGmailSearchPlans,
    buildDiscoverySearchQueries,
    listThreadIdsForQueryDetailed,
    detectNearMissAwbReferences,
    nearMissActiveAwbsInMessage,
    scanThreadForActiveAwbReferences,
    collectNearMissAwbReferencesForThreads,
    findAwbsInThread,
    messageBelongsToAwb,
    collectUnknownAwbMentions,
    extractMentionedAwbsWithKnown,
    inferPickupThreadGroupScope,
    inferBrokerFromMessage,
    selectThreadIdsBySearchPlan,
    buildShipmentEventsSnapshot,
    buildShipmentStateSnapshot,
    buildGmailCoverageAudit,
    buildOperatorNotificationsSnapshot,
    buildLedgerOperatorNotificationsSnapshot,
    mergeOperatorNotificationsSnapshots,
    buildMimeMessage,
    directRecordToGmailProof,
    mergeProofRecord,
    compactProofRecordForSnapshot,
    replaceRefreshedProofs,
    mergeTruthPacketSnapshotsForPromotion,
    deriveGmailPublishedShipment,
    buildGmailPromotedTruthPackets,
    tmsSnapshotActiveAwbs,
    summarizeThreadForAwb,
    buildOperatorNotificationsSnapshot,
    propagateScopedGroupEvents,
    eventLooksGroupScopedException,
    contentSignature,
    GMAIL_DIRECT_WRITER_VERSION,
    selectThreadIdsByQuery,
    operationalSignals,
    coverageSignalsForMessage,
    awbScopedMessageText,
    requiredCoverageEventTypes,
    attachGmailCoverageToProofs,
    shipmentStateFromProof,
    assertCanonicalTmsWatermarkCurrent,
    gmailRefreshWriteOptions,
    gmailRefreshLedgerWriteOptions,
    gmailRefreshTruthWriteOptions,
  },
};

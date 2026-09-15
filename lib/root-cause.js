"use strict";

// Root-cause extraction — the difference between a STATE and a REASON.
//
// "Customs hold: still blocking" is a state echo; it tells the operator
// nothing to solve. "Inbond entry rejected — AMS shows 1 pc, AWB shows 4"
// is a cause: it names the thing that must be fixed. This module reads a
// shipment's evidence (blocked gate detail, blocker record, fact ledger,
// email events) and returns the best CAUSAL explanation plus what has been
// done about it since — or an explicit "unexplained" so callers say "the
// evidence never states why" instead of emitting a circular answer.
//
// Used across the cycle: blocker explanations, focus ranking whys, customs/
// status answers — one extractor, one honesty rule.

const { normalizeAwb } = require("./awb");

// Language that names something to SOLVE.
const CAUSAL_RE = /\breject(?:ed|ion)?\b|\bdenied\b|not accepted|refus(?:ed|al)|\bmissing\b|mismatch|incorrect|\bwrong\b|discrepan|\brequires?\b|\bneeds?\b|awaiting|pending (?:correction|entry|docs?|paperwork|refil)|\bexam\b|damaged|short[- ]?ship|cannot locate|can'?t locate|unable to (?:locate|clear|release|process)|\bfailed\b|amend(?:ment)?|piece ?count|\bams\b|\b7501\b|manifest|in[- ]?bond (?:reject|issue|problem)|does not match|no (?:entry|delivery order|d\/o) (?:on file|found)|unpaid|outstanding (?:balance|fee)/i;

// Language that reports PROGRESS on the cause (what happened since).
const PROGRESS_RE = /corrected|\bfixed\b|resubmitt?ed|refil(?:ed|ing)|escalat(?:ed|ion)|amended|root cause|updated the|sent the correct|re-?sent|now shows/i;

// Pure state echoes — never a cause on their own.
const ECHO_RE = /still block|continues|remains (?:on hold|blocked)|hold (?:at|active)|is on hold|status unchanged|no update/i;

function cleanEvidenceText(value, max = 200) {
  const text = String(value || "")
    .replace(/<https?:[^>]*>?/gi, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/["“”]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:blocked|waiting|pending|hold|exception|done|scheduled|open)\s*:\s*/i, "")
    .replace(/\s*[—-]\s*$/, "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function factAt(fact = {}) {
  return Date.parse(fact.at || fact.observedAt || "") || 0;
}

function candidateTexts(row = {}) {
  const gate = (row.truthPacket?.gates || []).find((g) =>
    ["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem"].includes(String(g.status || "").toLowerCase()));
  const blocker = row.truthPacket?.operationalBlocker || {};
  const rows = [
    gate ? { text: `${gate.reason || ""} ${gate.evidence || ""}`, at: factAt(gate), from: "blocked-gate" } : null,
    blocker.reason ? { text: blocker.reason, at: factAt(blocker), from: "blocker" } : null,
    ...[...(row.facts || []), ...(row.evidencePacket?.sourceFacts || []), ...(row.emailValidation?.events || [])]
      .map((fact) => ({
        text: `${fact.summary || fact.claim || fact.evidence || ""}`,
        at: factAt(fact),
        from: String(fact.type || "fact"),
      })),
  ].filter((item) => item && item.text.trim().length >= 15);
  return rows;
}

// Best causal explanation for why the shipment is not moving, or unexplained.
function shipmentRootCause(row = {}) {
  const candidates = candidateTexts(row);
  const causal = [];
  const progress = [];
  for (const item of candidates) {
    const text = item.text;
    const isEcho = ECHO_RE.test(text) && !CAUSAL_RE.test(text);
    if (isEcho) continue;
    if (CAUSAL_RE.test(text)) {
      // Score: how many distinct causal markers + mild recency preference.
      const markers = (text.match(new RegExp(CAUSAL_RE.source, "gi")) || []).length;
      causal.push({ ...item, score: markers * 10 + (item.at ? 1 : 0) });
    }
    if (PROGRESS_RE.test(text)) progress.push(item);
  }
  // Progress must be about the SAME problem: a customs cause only carries
  // customs-family progress, a fee cause fee-family progress — unrelated
  // notes (attachment audits, delivery chatter) are noise, not progress.
  const topical = (cause, items) => {
    if (!cause) return items;
    const families = [
      /customs|inbond|entry|ams|release|clearan|manifest|7501|exam/i,
      /fee|storage|payment|balance|cargosprint|lfd/i,
      /pickup|dispatch|driver|broker/i,
      /deliver|pod|receiver/i,
    ];
    const family = families.find((re) => re.test(cause));
    return family ? items.filter((item) => family.test(item.text)) : items;
  };
  causal.sort((a, b) => b.score - a.score || b.at - a.at);
  const best = causal[0] || null;
  const progressTopical = topical(best ? best.text : "", progress);
  progressTopical.sort((a, b) => b.at - a.at);
  // Dedupe on CLEANED text: the same fact often appears with and without a
  // state-word prefix ("done: …").
  const seen = new Set(best ? [cleanEvidenceText(best.text, 170)] : []);
  const progressLines = progressTopical
    .map((item) => ({ text: cleanEvidenceText(item.text, 170), at: item.at }))
    .filter((item) => item.text && !seen.has(item.text) && (seen.add(item.text), true))
    .slice(0, 2);
  return {
    awb: normalizeAwb(row.awb || ""),
    cause: best ? cleanEvidenceText(best.text, 190) : "",
    causeAt: best ? best.at : 0,
    causeSource: best ? best.from : "",
    progress: progressLines,
    unexplained: !best,
  };
}

module.exports = { shipmentRootCause, cleanEvidenceText, _test: { CAUSAL_RE, PROGRESS_RE, ECHO_RE } };

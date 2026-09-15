"use strict";

// Recipient, thread, and contact resolution for the canonical action planner.
//
// The Action Registry requires every email action to show the thread being used,
// to/cc/excluded recipients, and why each recipient is included. This module owns
// those decisions so builders in lib/action-planner.js stay declarative.
//
// Evidence constraints (INC-2026-07-02 + snapshot audit 2026-07-04):
// - events carry from/to (and cc after the roster-retention fix) as raw header
//   strings; older snapshots truncate rosters at 160 chars, so a roster may be
//   partial. Resolution must therefore degrade to relation/contact memory and
//   must say when the roster is incomplete rather than pretend certainty.
// - Generated summaries are not evidence; supersede/OOO detection reads the
//   summary/evidence text of real message events only.

const OPERATOR_DOMAINS = ["partner-116.example"];
const OPERATOR_ADDRESSES = new Set([
  "contact-053@demo-freight.example",
  String(process.env.PIKIIO_OPERATOR_REVIEW_EMAIL || "").toLowerCase(),
].filter(Boolean));

// A display name is valid only when it is attached to an angle-bracketed
// address. Making the display-name group optional in front of a bare address
// let it steal the first character (`alexdemo@...` -> `lexdemo@...`), which
// could also evade the operator-party guard.
const ADDRESS_PATTERN = /(?:"([^"]{1,60})"|([^"<>,;]{1,60}?))\s*<\s*([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\s*>|([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function parseAddressList(value) {
  const out = [];
  const seen = new Set();
  let match;
  const text = String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  ADDRESS_PATTERN.lastIndex = 0;
  while ((match = ADDRESS_PATTERN.exec(text))) {
    const email = normalizeEmail(match[3] || match[4]);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const name = String(match[1] || match[2] || "").replace(/\s+/g, " ").trim().replace(/^[,;]+|[,;]+$/g, "");
    out.push({ email, name });
  }
  return out;
}

function isOperatorParty(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (OPERATOR_ADDRESSES.has(normalized)) return true;
  return OPERATOR_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
}

const NON_PERSON_GREETING_TOKEN = /^(?:accounting|airline|airport|broker|building|cargo|carrier|contact|customer|customs|delivery|department|desk|dispatch|driver|freight|group|handler|imports?|exports?|logistics?|manager|operations?|ops|pickup|quotes?|rate|sales|service|station|support|team|terminal|unknown|warehouse)$/i;

// External greetings should personalize only when the input is already a
// plausible single given name. Organizations, buildings, desks, role slugs,
// email local-parts, and ambiguous multi-word labels get a neutral greeting.
function counterpartyGivenName(value) {
  const name = String(value || "")
    .replace(/["<>]/g, "")
    .trim()
    .replace(/,+$/, "");
  if (!name || /[@/\d\s]/.test(name)) return "";
  if (!/^[A-Z][a-z]{1,24}(?:[-'][A-Z]?[a-z]{1,24})?$/.test(name)) return "";
  if (NON_PERSON_GREETING_TOKEN.test(name)) return "";
  return name;
}

function counterpartyGreeting(value) {
  const givenName = counterpartyGivenName(value);
  return givenName ? `Hi ${givenName},` : "Hello,";
}

function evidenceRowsForShipment(shipment = {}) {
  return [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.factLedger || []),
    ...(shipment.facts || []),
    // Message-level rosters (from/to/cc) live in the gmail proof record, not in
    // the truth packet. buildCanonicalActionPlan enriches the shipment with
    // gmailProofEvents from its context so recipient/thread resolution can see
    // who is actually on each thread instead of guessing.
    ...(shipment.gmailProofEvents || []),
  ].filter(Boolean);
}

function rowTimestamp(row = {}) {
  return Date.parse(row.at || row.date || row.observedAt || "") || 0;
}

// --- Thread participants -----------------------------------------------------

// Harvest every named participant of a thread from stored message events, and
// find the newest message so replies land on the live end of the conversation,
// not on whichever old row happened to match a scoring regex.
// Every mailbox-verified participant across ALL of the shipment's threads —
// used to resolve directive-named cc people ("cc Riley Jordan") whose
// address lives on a different thread (e.g. the arrival-notice issuer) than
// the reply target. Addresses come only from real message rosters.
function allShipmentParticipants(shipment = {}) {
  const participants = new Map();
  for (const row of evidenceRowsForShipment(shipment)) {
    const roster = [
      ...parseAddressList(row.from),
      ...parseAddressList(row.to),
      ...parseAddressList(row.cc),
    ];
    const at = rowTimestamp(row);
    for (const entry of roster) {
      const existing = participants.get(entry.email);
      if (!existing || at > existing.lastSeenAt) {
        participants.set(entry.email, {
          email: entry.email,
          name: entry.name || existing?.name || "",
          lastSeenAt: at,
          operator: isOperatorParty(entry.email),
        });
      } else if (!existing.name && entry.name) {
        existing.name = entry.name;
      }
    }
  }
  return [...participants.values()];
}

function threadParticipants(shipment = {}, threadId = "") {
  const wanted = String(threadId || "").trim();
  const participants = new Map();
  let latestMessageId = "";
  let latestAt = 0;
  let latestFrom = "";
  let latestOutbound = null;
  let latestSubject = "";
  let latestSubjectAt = 0;
  let rosterMayBeTruncated = false;
  if (!wanted) return { participants: [], latestMessageId, latestAt: 0, latestFrom, latestOutbound, latestSubject, rosterMayBeTruncated };
  for (const row of evidenceRowsForShipment(shipment)) {
    if (String(row.threadId || "") !== wanted) continue;
    const at = rowTimestamp(row);
    const roster = [
      ...parseAddressList(row.from).map((entry) => ({ ...entry, direction: "from" })),
      ...parseAddressList(row.to).map((entry) => ({ ...entry, direction: "to" })),
      ...parseAddressList(row.cc).map((entry) => ({ ...entry, direction: "cc" })),
    ];
    // A roster string that ends mid-address (no closing bracket/quote and cut at a
    // compaction boundary) means older snapshots dropped participants silently.
    for (const field of [row.to, row.cc]) {
      const text = String(field || "");
      if (text.length >= 155 && !/[>\s"']$/.test(text.trim().slice(-1)) && !text.trim().endsWith(">")) {
        rosterMayBeTruncated = true;
      }
    }
    for (const entry of roster) {
      const existing = participants.get(entry.email);
      if (!existing || at > existing.lastSeenAt) {
        participants.set(entry.email, {
          email: entry.email,
          name: entry.name || existing?.name || "",
          lastSeenAt: at,
          lastDirection: entry.direction,
          operator: isOperatorParty(entry.email),
        });
      } else if (!existing.name && entry.name) {
        existing.name = entry.name;
      }
    }
    if (row.messageId && at >= latestAt) {
      latestAt = at;
      latestMessageId = String(row.messageId);
      latestFrom = String(row.from || "");
      const fromParsed = parseAddressList(row.from)[0];
      latestOutbound = fromParsed ? isOperatorParty(fromParsed.email) : null;
    }
    if (row.subject && at >= latestSubjectAt) {
      latestSubjectAt = at;
      latestSubject = String(row.subject);
    }
  }
  return {
    participants: [...participants.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt),
    latestMessageId,
    latestAt,
    latestFrom,
    latestOutbound,
    latestSubject,
    rosterMayBeTruncated,
  };
}

// --- Supersede / out-of-office detection -------------------------------------

// Absence signals only. Replacement phrasings ("on behalf of", "covering for",
// "instead of") name the LIVE person next to the signal and flagged the wrong
// party (Taylor Morgan covering for an OOO colleague was excluded while the OOO
// colleague survived) — keep them out of this pattern.
const SUPERSEDE_PATTERN = /\b(?:out of office|ooo\b|no email access|on leave|on vacation|auto[-\s]?reply|away until|disregard|please ignore|no longer (?:with|handling|on|at)|retired from)\b/i;

// Scan evidence text for signals that a named person/address is not the live
// counterparty (OOO auto-reply, explicit disregard, replacement wording).
// Returns Map(email -> reason). Detection is conservative: the signal text must
// mention the address or the person's name.
function supersededParties(shipment = {}) {
  const flagged = new Map();
  const rows = evidenceRowsForShipment(shipment);
  const texts = [
    ...rows.map((row) => ({
      at: rowTimestamp(row),
      text: [row.summary, row.evidence, row.note, row.label].filter(Boolean).join(" "),
      from: String(row.from || ""),
    })),
    ...[shipment.contacts?.customs?.brokerStatus, shipment.contacts?.customs?.status,
        shipment.customsBroker?.status, shipment.opsState?.summary, shipment.manualTruth]
      .filter(Boolean)
      .map((text) => ({ at: 0, text: String(text), from: "" })),
  ];
  const known = new Map();
  for (const row of rows) {
    for (const entry of [...parseAddressList(row.from), ...parseAddressList(row.to), ...parseAddressList(row.cc)]) {
      if (entry.email && !known.has(entry.email)) known.set(entry.email, entry.name || "");
    }
  }
  for (const contact of [shipment.contacts?.customs, shipment.contacts?.station, shipment.customsBroker]) {
    const email = normalizeEmail(contact?.contactEmail || contact?.email);
    if (email && !known.has(email)) known.set(email, contact?.contactName || contact?.name || "");
  }
  for (const { text } of texts) {
    if (!SUPERSEDE_PATTERN.test(text)) continue;
    // Proximity matters: "ycastillo OOO (auto-reply); JMata actively re-submitting"
    // must flag ycastillo only. Test each sentence-ish segment independently so an
    // absence signal never taints the colleague named in the next clause.
    const segments = String(text).split(/[.;\n]+/);
    for (const segment of segments) {
      if (!SUPERSEDE_PATTERN.test(segment)) continue;
      for (const [email, name] of known) {
        if (isOperatorParty(email) || flagged.has(email)) continue;
        const localPart = email.split("@")[0];
        const mentioned =
          segment.toLowerCase().includes(email) ||
          (localPart.length >= 4 && segment.toLowerCase().includes(localPart.toLowerCase())) ||
          (name && name.length >= 4 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(segment));
        if (!mentioned) continue;
        const signal = segment.match(SUPERSEDE_PATTERN)?.[0] || "superseded";
        flagged.set(email, `Evidence marks this contact as "${signal}" — not the live counterparty.`);
      }
    }
  }
  return flagged;
}

// --- Recipient resolution -----------------------------------------------------

// Decide to/cc/excluded for an email action. `relation` is the planner's resolved
// relationship (station/pickup/customs). `thread` is the threadParticipants()
// result for the chosen thread (may be empty for start_new).
function resolveRecipients(shipment = {}, relation = {}, thread = null, options = {}) {
  const superseded = supersededParties(shipment);
  const to = [];
  const cc = [];
  const excluded = [];
  const notes = [];
  const seen = new Set();
  const push = (bucket, email, name, reason, confidence) => {
    const normalized = normalizeEmail(email);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    bucket.push({ email: normalized, name: name || "", reason, ...(confidence ? { confidence } : {}) });
  };

  const relationEmail = normalizeEmail(relation.email);
  const relationSuperseded = relationEmail && superseded.get(relationEmail);
  const relationIsOperator = relationEmail && isOperatorParty(relationEmail);

  // 1. Primary: the relation contact, unless evidence says that person is gone.
  if (relationEmail && !relationSuperseded && !relationIsOperator) {
    push(to, relationEmail, relation.name, options.toReason || `${relation.type || "counterparty"} of record for this shipment.`, "high");
  } else if (relationEmail && relationSuperseded) {
    push(excluded, relationEmail, relation.name, relationSuperseded);
    notes.push(`Relation contact ${relationEmail} is superseded; using the live thread counterparty instead.`);
  } else if (relationIsOperator) {
    push(excluded, relationEmail, relation.name, "Operator address cannot be the counterparty recipient.");
    notes.push(`Relation contact ${relationEmail} is an operator address; using the live counterparty instead.`);
  }

  // 2. Live thread counterparty: newest non-operator sender in the thread.
  if (thread?.participants?.length) {
    const liveCounterparty = thread.participants.find((p) => !p.operator && !superseded.has(p.email) && p.lastDirection === "from");
    if (liveCounterparty && !seen.has(liveCounterparty.email)) {
      const reason = "Most recent counterparty to write in the operational thread.";
      if (to.length === 0) push(to, liveCounterparty.email, liveCounterparty.name, reason, "medium");
      else push(cc, liveCounterparty.email, liveCounterparty.name, reason);
    }
    // 3. Remaining thread participants keep their seat as cc (operational context),
    //    except operator addresses and superseded parties.
    for (const p of thread.participants) {
      if (seen.has(p.email)) continue;
      if (p.operator) continue;
      const supersededReason = superseded.get(p.email);
      if (supersededReason) { push(excluded, p.email, p.name, supersededReason); continue; }
      push(cc, p.email, p.name, "Participant in the operational thread; kept for context.");
    }
    if (thread.rosterMayBeTruncated) {
      notes.push("Stored thread roster was truncated by an older snapshot; cc list may be incomplete. Reply-all from the thread preserves anyone missing here.");
    }
  }

  const confidence = to.length && to[0].confidence === "high"
    ? "high"
    : to.length
    ? "medium"
    : "low";
  if (!to.length) notes.push("No confident recipient — action must be framed as confirm-recipient, not send.");
  return { to, cc, excluded, confidence, notes };
}

// --- Phone contacts -----------------------------------------------------------

function usablePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 7 && !/\b(?:unknown|missing|n\/a)\b/i.test(String(value || ""));
}

// Resolve a named, dialable contact for a call action. Never returns a bare
// "call broker" — either a name+number, or an explicit missing state with the
// next step to repair it.
function resolvePhoneContact(shipment = {}, relation = {}) {
  const candidates = [
    { name: relation.name, phone: relation.phone, role: relation.type || "contact" },
    { name: shipment.contacts?.station?.name, phone: shipment.contacts?.station?.phone || shipment.contacts?.station?.stationPhone, role: "station" },
    { name: shipment.customsBroker?.contactName || shipment.contacts?.customs?.broker, phone: shipment.customsBroker?.contactPhone || shipment.contacts?.customs?.phone, role: "customs-broker" },
    { name: shipment.contacts?.freight?.broker, phone: shipment.contacts?.freight?.phone, role: "pickup-broker" },
    { name: shipment.delivery?.contactName, phone: shipment.delivery?.contactPhone, role: "delivery-contact" },
  ];
  for (const candidate of candidates) {
    if (usablePhone(candidate.phone)) {
      return {
        available: true,
        name: String(candidate.name || "").trim() || candidate.role,
        phone: String(candidate.phone).trim(),
        role: candidate.role,
      };
    }
  }
  return {
    available: false,
    name: String(relation.name || "").trim() || "contact",
    phone: "",
    role: relation.type || "contact",
    missing: "phone number missing",
    nextStep: "Find the contact's phone number (station memory, broker snapshot, or thread signature) and save it, then the call action becomes dialable.",
  };
}

// --- Person-name to roster matching -------------------------------------------

// Rosters often carry bare addresses ("<contact-021@demo-freight.example>") while truth
// prose names the person ("Avery Blake"). Match by display name or by the
// standard local-part conventions (ablake, avery.blake, blake...).
// The returned address is always verbatim from the roster — never composed.
function participantMatchesName(participant = {}, fullName = "") {
  const parts = String(fullName || "").toLowerCase().split(/\s+/).filter((word) => word.length >= 2);
  if (!parts.length || !participant.email) return false;
  const displayName = String(participant.name || "").toLowerCase();
  if (displayName && parts.every((part) => displayName.includes(part))) return true;
  const local = participant.email.split("@")[0].toLowerCase().replace(/[^a-z0-9.]/g, "");
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (parts.length >= 2) {
    if (local === `${first[0]}${last}` || local === `${first}.${last}` || local === `${first}${last}` || local === `${last}${first[0]}` || local === `${first}_${last}`) {
      return true;
    }
  }
  return last.length >= 5 && local.includes(last);
}

function matchParticipantsToNames(participants = [], names = []) {
  const matched = [];
  const seen = new Set();
  for (const name of names) {
    const hit = (participants || []).find((p) => !p.operator && !seen.has(p.email) && participantMatchesName(p, name));
    if (hit) {
      seen.add(hit.email);
      matched.push({ ...hit, matchedName: name });
    }
  }
  return matched;
}

module.exports = {
  allShipmentParticipants,
  counterpartyGivenName,
  counterpartyGreeting,
  parseAddressList,
  isOperatorParty,
  threadParticipants,
  supersededParties,
  resolveRecipients,
  resolvePhoneContact,
  participantMatchesName,
  matchParticipantsToNames,
};

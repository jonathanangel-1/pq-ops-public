"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const {
  classifyOperatorUpdate,
  emptyCompanionMemory,
  isOperatorUpdateText: durableIsOperatorUpdateText,
  operatorFactsFromText: durableOperatorFactsFromText,
} = require("./companion-memory-store");
const {
  actionPreflight,
  autonomyForInternalAction,
  operatorApprovedInternalContract,
  safetyForInternalAction,
} = require("./action-safety");
const {
  attachOperatorPackets,
  compactEvidencePacket,
  compactTruthPacket,
} = require("./operator-truth-packet");
const {
  buildCanonicalActionPlan,
  isCanonicalPlannerAction,
} = require("./action-planner");
const { counterpartyGreeting } = require("./action-recipients");
const {
  callSupabaseRpc,
  loadAppSnapshot,
} = require("./supabase-agent");
const { contentSignature } = require("./content-signature");
const {
  CANONICAL_GMAIL_INGESTION_PIPELINE,
} = require("./gmail-ingestion-authority");
const BUNDLED_TRUTH_PACKETS = require("../shipment-truth-packets.json");
const customerComm = require("./customer-communication");
const opsQuery = require("./ops-query");
const { normalizeAwb, normalizeAwbFrom } = require("./awb");
const { coworkerAnswer, coworkerIntent, coworkerIntentIsFleet } = require("./operator-coworker");
const { createOpsBrainModelRuntime, looksLikeRealKey } = require("./ops-brain-model-runtime");
const { shipmentRootCause } = require("./root-cause");

const PICKUP_BROKER_PATTERN =
  /\b(?:jd direct|j&d|meadow freight|btx|birch cartage|rapid|meadow logistics|binational|cedar brokerage|port air|sd direct|atlantic freight|maple|chart|casey|mw transport|kuehne|choice)\b/i;
const AIR_BOOKING_PATTERN = /\b(?:air booking|air export|export booking|air[-\s]?freight|harbor forwarding|global forwarding|agent dhl| dap | tlv | ath |\/kg|per kg|iata|fuel surcharge)\b/i;
const OPERATOR_EMAIL = "contact-052@demo-freight.example";
const OPERATOR_TIME_ZONE = "America/New_York";
const HOSTED_SNAPSHOT_TIMEOUT_MS = Number(process.env.PIKIIO_HOSTED_SNAPSHOT_TIMEOUT_MS || 900);
const HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS = Math.max(
  HOSTED_SNAPSHOT_TIMEOUT_MS,
  Number(process.env.PIKIIO_HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS || 6000),
);
const mergedShipmentsCache = new WeakMap();
const ELP_PICKUP_BROKER = {
  name: "Rivergate Logistics ELP / Norman",
  email: "contact-064@demo-freight.example",
};
const NY_PICKUP_DRIVER = {
  name: "Casey Hart / driver",
  email: "contact-054@demo-freight.example",
};
const WRONG_CONSIGNEE_RECOVERY_ACTION =
  "Escalate with the airline, station, and broker now; identify who received it, confirm return timing, and keep POD/closeout blocked until recovery is confirmed.";
const APPROVED_PICKUP_BROKERS = [
  { name: "JD Direct", email: "contact-072@demo-freight.example" },
  { name: "Meadow Freight", email: "contact-014@demo-freight.example" },
  { name: "BTX Global", email: "contact-102@demo-freight.example" },
  { name: "Juniper Logistics", email: "contact-088@demo-freight.example" },
];
const STATION_ALIASES = {
  atlanta: "ATL",
  atl: "ATL",
  boston: "BOS",
  bos: "BOS",
  cleveland: "CLE",
  cleavland: "CLE",
  cle: "CLE",
  columbus: "CMH",
  cmh: "CMH",
  charlotte: "CLT",
  clt: "CLT",
  denver: "DEN",
  den: "DEN",
  dallas: "DFW",
  dfw: "DFW",
  detroit: "DTW",
  dtw: "DTW",
  "el paso": "ELP",
  elp: "ELP",
  houston: "IAH",
  iah: "IAH",
  jfk: "JFK",
  "new york": "JFK",
  nyc: "JFK",
  "los angeles": "LAX",
  la: "LAX",
  lax: "LAX",
  newark: "EWR",
  ewr: "EWR",
  chicago: "ORD",
  ord: "ORD",
  toronto: "YYZ",
  yyz: "YYZ",
};
const CUSTOMS_HOLD_PATTERN = /\b(?:u\.?s\.? customs (?:hold|exam|wants? to examine)|customs (?:exam|wants? to examine)|exam hold|\b1[-\s]?h\b|hold not removed|remove th?e?\s+hold|cbp hold|government hold|fda hold|agri(?:culture)? hold|intensive exam)\b/i;
const EXPLICIT_CUSTOMS_BLOCKER_PATTERN = /\b(?:u\.?s\.?\s+customs\s+(?:hold|exam|wants? to examine)|customs\s+(?:hold|exam|wants? to examine)|exam(?:ination)?|exam\s+hold|\b1[-\s]?h\b|intensive(?:\s+exam)?|release denied|cannot pick(?:\s+up)?|can'?t pick(?:\s+up)?|blocked by customs|cbp hold|government hold|fda hold|agri(?:culture)? hold|hold remains active|hold not removed|remove th?e?\s+hold)\b|\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b.{0,160}\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b|\b(?:reject(?:ed|ion)?|not accepted|refused|denied)\b.{0,160}\b(?:in[-\s]?bond|inbond|i\.?t\.?|entry|shipment)\b|\barriv(?:e|ed)\s+i\.?t\.?\s+to\s+port\b/i;
const BROKER_RELEASE_DELAY_PATTERN = /\b(?:broker|customs broker|maple|cedar dispatch|worldwide|port air|translink|clearance broker)\b.{0,120}\b(?:hasn'?t|has not|not|no|still|pending|waiting|missing|needs?|asked|question|firm'?s? code|firms code|entry|clearance|release|d\/?o|delivery order)\b/i;
const CARGO_NOT_FOUND_PATTERN = /\b(?:cargo|freight|shipment|load|pieces?|pcs?)\b[^.;\n]{0,120}\b(?:missing|not found|cannot be found|can'?t be found|not located|can'?t locate|cannot locate|short)\b|\b(?:station|airport|terminal|airline|warehouse|driver|truck|trucker)\b[^.;\n]{0,160}\b(?:can'?t|cannot|doesn'?t|does not|don'?t|do not|not|unable)\b[^.;\n]{0,120}\b(?:find|locate|see|recover)\b[^.;\n]{0,80}\b(?:cargo|freight|shipment|load|pieces?|pcs?|awb)\b|(?:לא מוצאים|לא נמצא|לא נמצאה|לא נמצאו|מטען חסר|המטענ חסר|לא מאתרים|לא איתרו)/i;
const ARRIVAL_NOT_AVAILABLE_PATTERN = /\b(?:short|partial|not all|only \d+\s+(?:pcs?|pieces?)|pieces? missing|missing pieces?|not offloaded|not unloaded|not available|not on hand|cargo missing|cargo not found|freight missing|freight not found|cannot locate|can't locate|not located|split shipment)\b|(?:לא מוצאים|לא נמצא|לא נמצאה|לא נמצאו|מטען חסר|המטענ חסר|לא מאתרים|לא איתרו)/i;
const ARRIVAL_NEGATIVE_PATTERN =
  /\b(?:not[-\s]?arrived|has not arrived|not at destination|arrival pending|pending arrival|no arrival proof|arrival proof missing|no arrival notice|without arrival notice|no notice of arrival|no \bnoa\b|no on[-\s]?hand proof|not on[-\s]?hand|departed(?: from)?|in transit|arrival expected|expected (?:arrival|to arrive))\b/i;
const ARRIVAL_POSITIVE_PATTERN =
  /\b(?:arrival notice|notice of arrival|\bnoa\b|arrival date|arr\/dept|arr dept|arr-dept|arrived at|arrived on|confirms? arrival|confirmed arrival|arrival[-\s]?confirmed|confirmed arrived|confirms? arrived|on[-\s]?hand|available for pickup|ready[-\s]?for[-\s]?pickup|pickup[-\s]?ready|cargo (?:is )?available|station confirms? freight|station confirmed availability)\b/i;
const LOADING_PROBLEM_PATTERN = /\b(?:doesn'?t fit|won'?t fit|cannot load|can'?t load|refus(?:e|ed|ing) load|loading problem|load problem|too (?:big|wide|tall|heavy)|pallets? do not fit|skids? do not fit|forklift problem|dock problem|liftgate required)\b/i;
const DELIVERY_PROBLEM_PATTERN = /\b(?:receiver|consignee|dock|offload|unload).{0,80}\b(?:closed|refus(?:e|ed|ing)|not available|no one|nobody|cannot|can'?t|problem|blocked)\b|\b(?:closed|refus(?:e|ed|ing)|not available|no one|nobody|cannot deliver|can'?t deliver|cannot offload|can'?t offload|dock[-\s]?to[-\s]?dock|residential|liftgate required)\b/i;
const POD_NEGATIVE_PATTERN = /\b(?:no|not|without|missing|pending|awaiting|need|needs|needed)\b[^.;\n]{0,40}\b(?:pod|proof of delivery|delivery proof)\b|\b(?:pod|proof of delivery|delivery proof)\b[^.;\n]{0,40}\b(?:not|missing|pending|needed|not found)\b/i;
const POD_PENDING_PATTERN = /\b(?:pod pending|pod needed|pod missing|no pod|without pod|await(?:ing)? pod|proof of delivery pending|delivery proof missing|pod to follow|pod will follow|pod follows|will send (?:the )?pod|send (?:the )?pod (?:as soon|later|shortly)|driver will send (?:the )?pod|pod (?:is )?(?:still )?(?:pending|not available|not ready))\b/i;
const POD_RECEIVED_PATTERN = /\b(?:pod attached|pod found|pod received|attached pod|proof of delivery attached|proof of delivery received|signed pod|signed delivery receipt|signed by|received by|receiver signature|delivered with pod|pod is attached)\b/i;
const POD_REQUEST_PATTERN = /\b(?:collect|get|request|ask|follow up|follow-up|send|will send|waiting for|need|needs|needed)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed pod)\b/i;
const DELIVERY_REPORTED_PATTERN = /\b(?:shipment (?:has been |was |is )?delivered|freight (?:has been |was |is )?delivered|delivered successfully|delivered to|delivery completed|completed delivery|was delivered)\b/i;
const PICKUP_NEGATIVE_PATTERN = /\b(?:no|not|without|missing|pending|awaiting|need|needs|needed|did not|does not|do not|don'?t|keep|hold)\b[^.;\n]{0,80}\b(?:pickup|picked up|pick up|recovery|recovered|pod|proof of delivery|delivered|delivery proof)\b|\b(?:pickup|picked up|pick up|recovery|recovered|pod|proof of delivery|delivered|delivery proof)\b[^.;\n]{0,80}\b(?:not|missing|pending|needed|not found|blocked|remains blocked|not complete|should not|do not|don'?t|hold)\b/i;
const PICKUP_COMPLETION_PATTERN =
  /\b(?:picked(?: it)? up|pickup complete|recovered from|airport picked up|driver (?:is )?(?:now )?loaded|driver loaded|driver left|loaded at|is loaded|loaded and will deliver|loaded and (?:is )?(?:en route|rolling)|loaded as of)\b/i;
const PICKUP_BLOCKER_PATTERN = /\b(?:pickup|pick up|recovery|dispatch|driver|station)\b[^.;\n]{0,120}\b(?:blocked|hold|not complete|should not|do not|don'?t|cannot|can'?t|mismatch|discrepanc|wrong pieces?|piece[-\s]?count|3[-\s]?v(?:s|ersus)[-\s]?4|3[-\s]?vs[-\s]?4|fixing)\b|\b(?:piece[-\s]?count|3[-\s]?v(?:s|ersus)[-\s]?4|3[-\s]?vs[-\s]?4)\b[^.;\n]{0,140}\b(?:mismatch|discrepanc|issue|fixing|wrong|told|blocked|hold|pending)\b|\bpieces?\b[^.;\n]{0,140}\b(?:mismatch|discrepanc|fixing|wrong|told)\b|\bhold pickup until\b/i;

function explicitCustomsStatusLooksBlocked(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status || genericReleasePendingCustomsHoldText(status)) return false;
  if (/^pdf[-_\s]?customs[-_\s]?hold$/i.test(status)) return false;
  if (/\bcustoms[-_\s]?pending\b/i.test(status) && !/\b(?:reject|rejected|rejection|exam|1[-_\s]?h|government|cbp|in[-_\s]?bond)\b/i.test(status)) {
    return false;
  }
  return (
    /^(?:customs[-_\s]?hold(?:[-_\s].*)?|exam[-_\s]?hold|hold|blocked)$/i.test(status) ||
    /\b(?:customs[-_\s]?hold|exam[-_\s]?hold|1[-_\s]?h|cbp[-_\s]?hold|government[-_\s]?hold)\b/i.test(status) ||
    EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(status)
  );
}

function explicitCustomsStatusLooksReleased(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return false;
  if (/\b(?:not|no-release|pending|missing|needed|hasn'?t|has not|hold|exam)\b/i.test(status)) return false;
  return /\b(?:released|cleared|customs-release|customs-cleared|release-attachment)\b/i.test(status);
}
const COMPANY_SCOPE_PATTERN =
  /\b(?:awb|mawb|shipment|load|cargo|exception|exceptions|attention|board|control room|dashboard|active|state|truth|stale|compromised|station|airport|airline|carrier|united|el al|forward air|choice|swissport|virgin|delta|broker|driver|pickup|pick up|pods?|proof of delivery|delivered|delivery|out for delivery|customs|release|clearance|d\/?o|delivery order|arrive|arrives|arrived|arriving|arrival|arrivals|coming in|notice of arrival|noa|eta|scheduled|weekend|tomorrow|on hand|available|storage|last free|lfd|ground fees?|handling fees?|cargosprint|couriercloud|tms|quote|rate|price|cost|client|customer|consignee|jordan|alex|skyler|harbor forwarding|piki|pikiio|maple|worldwide|cedar dispatch|rapid|btx|dash|meadow freight|jd direct|sd direct|norman|binational)\b/i;
const FOLLOW_UP_PATTERN =
  /\b(?:status|what|who|where|when|why|how|next|now|do|draft|send|email|call|phone|contact|details|price|quote|rate|paid|released|cleared|picked|delivered|pod|station|broker|driver|storage|fees?|last email|latest|again|it|this|them|there)\b/i;

function stationPaymentDeliveryOnlyText(text) {
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

function displayAwb(value) {
  const awb = normalizeAwb(value);
  return awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb;
}

function compact(value, max = 140) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function sentence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function hasPickupBlockingText(value) {
  const text = String(value || "");
  return PICKUP_BLOCKER_PATTERN.test(text) ||
    /\b(?:keep|hold|do not|don'?t|should not)\b[^.;\n]{0,100}\b(?:pickup|pick up|picked up|recovery|recovered|delivered|delivery|pod)\b/i.test(text) ||
    /\b(?:pickup|pick up|picked up|recovery|recovered|delivered|delivery|pod)\b[^.;\n]{0,100}\b(?:keep open|hold|should not|do not|don'?t|not complete)\b/i.test(text);
}

function pickupArrangementOnlyText(value) {
  const text = String(value || "");
  if (/\b(?:driver (?:is )?(?:now )?loaded|driver loaded|(?:was|has been|got)\s+picked\s+(?:it\s+)?up|picked\s+(?:it\s+)?up\s+already|recovered from|recovery complete|pickup complete|loaded and will deliver|loaded and (?:is )?(?:en route|rolling)|loaded as of)\b/i.test(text)) {
    return false;
  }
  return /\b(?:can|could|will|would|should|able to|available to|going to|scheduled to|planning to|plan to|trying to|try to|need to|needs to|set up to|arrange to)\b[^.;\n]{0,90}\b(?:get\s+)?(?:pick(?:ed)?\s*up|pickup|recover(?:ed)?|recovery|load(?:ed)?)\b/i.test(text) ||
    /\b(?:do you have|can you send|please send|need|needs|needed|provide)\b[^.;\n]{0,100}\b(?:pickup location|pick[-\s]?up location|delivery order|d\/?o|remaining docs?|necessary docs?|release package)\b/i.test(text);
}

function hasFutureOrConditionalDeliveryEvidence(value) {
  const text = String(value || "");
  return /\b(?:will deliver|will be delivered|will get delivered|delivery tomorrow|scheduled (?:for )?delivery|out for delivery|delivering today)\b/i.test(text) ||
    /\b(?:to be|expected to be|scheduled to be|going to be|planned to be)\b[^.;\n]{0,80}\bdelivered\b/i.test(text) ||
    /\bdelivery\b[^.;\n]{0,60}\b(?:scheduled|planned|expected)\b/i.test(text) ||
    /\b(?:once|when|if|after|until|upon|before|as soon as)\b[^.;\n]{0,120}\b(?:shipment|freight|cargo|it|load)?\b[^.;\n]{0,30}\b(?:is |has been |was |gets? )?delivered\b/i.test(text) ||
    /\b(?:once|when|if|after|until|upon|before|as soon as)\b[^.;\n]{0,120}\bdelivery\b/i.test(text) ||
    /\b(?:keep|hold)\b[^.;\n]{0,120}\b(?:accessible|intact|available)\b[^.;\n]{0,120}\b(?:once|when|after|until)\b[^.;\n]{0,120}\b(?:delivered|delivery)\b/i.test(text);
}

function factLooksPlanningOnly(text) {
  const value = String(text || "");
  const hasPlanningSignal = /\b(?:pre[-\s]?alert|in[-\s]?bond|flight plan|planned routing|scheduled arrival|estimated arrival|expected (?:arrival|to arrive)|eta|departed|booking|awb (?:issued|document|pdf)|documents? attached|full documents|route|routing)\b/i.test(value);
  if (!hasPlanningSignal) return false;
  return !/\b(?:arrived at|arrived on|arrival notice confirms|confirmed arrival|confirmed arrived|confirms? arrived|on[-\s]?hand|available for pickup|cargo (?:is )?available|98\s+released|marked\s+released|customs released|release\s+\+\s+d\/?o)\b/i.test(value);
}

function factLooksNonFinalCustomsRelease(text) {
  const value = String(text || "");
  return factLooksReleaseRequest(value) ||
    /\b(?:security release|released from security|security\/release|released from export security)\b/i.test(value) ||
    /\b(?:not|no|without|missing|pending|waiting|unconfirmed)\b[^.;\n]{0,100}\b(?:customs release|release|released|clearance|cleared|d\/?o|delivery order)\b|\b(?:customs release|release|released|clearance|cleared|d\/?o|delivery order)\b[^.;\n]{0,100}\b(?:not|no|missing|pending|waiting|unconfirmed)\b/i.test(value) ||
    /\b(?:clearance|entry confirmation|release confirmation|cargo release|customs release|release|released|clear|cleared|d\/?o|delivery order|1c)\b[^.;\n]{0,140}\b(?:will follow|to follow|pending|missing|needed|not received|not found|not proven|not provided|not parsed|not confirmed|remain(?:s)? pending|still pending|once (?:it )?(?:is )?(?:in|wheels)|when (?:it )?(?:is )?(?:in|wheels)|after (?:it )?(?:is )?(?:in|wheels)|before pickup|before dispatch)\b/i.test(value) ||
    /\b(?:will follow|to follow|pending|missing|needed|not received|not found|not proven|not provided|not parsed|not confirmed|remain(?:s)? pending|still pending)\b[^.;\n]{0,140}\b(?:clearance|entry confirmation|release confirmation|cargo release|customs release|release|released|clear|cleared|d\/?o|delivery order|1c)\b/i.test(value) ||
    /\b(?:parsed|attached|revised|corrected)?\s*(?:d\/?o|delivery order)\b[^.;\n]{0,140}\b(?:routes?|directs?|shows arr\/dept|forwards?|attached)\b/i.test(value) &&
	      !/\b(?:98\s+released|marked\s+released|customs released|release\s+\+\s+d\/?o|released by|cleared by|do and ace|d\/?o and ace)\b/i.test(value);
}

function factLooksProofOnlyArrivalSummary(text) {
  return /\b(?:arrival evidence found in gmail thread|arrival\/on[-\s]?hand evidence was received)\b/i.test(String(text || ""));
}

function hasStrongCustomsReleaseText(text) {
  const value = String(text || "");
  return !textLooksTmsOnlyCustomsRelease(value) &&
    /\b(?:98\s+released|marked\s+released|customs[-_\s]?released|customs[-_\s]?cleared|customs[-_\s]?release[-_\s]?attachment|customs[-_\s]?released[-_\s]?do[-_\s]?received|customs[-_\s]?cleared[-_\s]?do[-_\s]?received|customs release\/?d\.?o evidence was received|customs release evidence|release\/?d\.?o evidence was received|release\/?d\.?o (?:is )?confirmed|ace status confirms?[^.;\n]{0,80}release|international freight release|release\s+\+\s+d\/?o|released by|cleared by|do and ace|d\/?o and ace|release attachments? (?:are )?present|release\/d\/?o attachment (?:is )?present|customs layer is resolved|customs (?:are )?released|customs released|do\/ace attached|terminal confirmed\s+1c|1c\s+(?:entered|confirmed|posted)|confirmed\s+1c|(?:got|received|confirmed)\s+(?:the\s+)?customs?\s+clearance|customs?\s+clearance\s+(?:received|confirmed|approved|obtained)|(?:revised|corrected)\s*d\/?o[^.;\n]{0,140}(?:delivery order|carrier location|arr\/dept)|(?:delivery order|d\/?o)(?:\s+was)?[^.;\n]{0,140}(?:attached|issued|received|ready|marked\s+released|released)|released[^.;\n]{0,80}(?:delivery order|d\/?o))\b/i.test(value);
}

function textLooksTmsOnlyCustomsRelease(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  const tmsSignal = /\b(?:tms|couriercloud|295[-\s]*(?:customs\s*)?rel|customs rel|active\/?tms|fresh tms|carrier tracking)\b/i.test(value);
  if (!tmsSignal) return false;
  return !/\b(?:gmail|email|thread|message|operator|broker|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight|abi|ace|98\s+released|attached|delivery order|d\/?o)\b/i.test(value);
}

function directCustomsReleaseEvidenceRows(shipment) {
  return [
    shipment.emailValidation?.status,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.proof || []).map(factRowText),
    ...(shipment.emailValidation?.events || []).map(factRowText),
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.summary,
    shipment.customsBroker?.nextAction,
    ...(shipment.customsBroker?.evidence || []).map(factRowText),
    shipment.canonicalState?.gates?.customs?.summary,
    shipment.canonicalState?.gates?.customs?.evidence,
    shipment.canonical?.gates?.customs?.summary,
    shipment.canonical?.gates?.customs?.evidence,
    ...(shipment.gmailEvents || []).map(factRowText),
    ...(shipment.events || []).map(factRowText),
    ...(shipment.operatorNotes || []).map(factRowText),
    ...(shipment.facts || [])
      .filter((fact) => !/\b(?:tms|couriercloud|tracking)\b/i.test(`${fact?.source || ""} ${fact?.type || ""} ${fact?.label || ""}`))
      .map(factRowText),
    ...(shipment.factLedger || [])
      .filter((fact) => !/\b(?:tms|couriercloud|tracking)\b/i.test(`${fact?.source || ""} ${fact?.sourceSystem || ""} ${fact?.type || ""} ${fact?.label || ""}`))
      .map(factRowText),
    ...(shipment.opsState?.events || [])
      .filter((event) => !/\b(?:tms|couriercloud|tracking)\b/i.test(`${event?.source || ""} ${event?.type || ""} ${event?.label || ""}`))
      .map(factRowText),
  ].filter(Boolean);
}

function releaseEvidenceRowIsStatusOnly(row) {
  const normalized = String(row || "").replace(/[.!]+$/g, "").replace(/[_\s]+/g, "-").trim().toLowerCase();
  return /^(?:customs-cleared|customs-released|released|cleared|done)$/.test(normalized);
}

function hasDirectCustomsReleaseEvidence(shipment) {
  return directCustomsReleaseEvidenceRows(shipment).some((row) =>
    !releaseEvidenceRowIsStatusOnly(row) &&
    (
      hasStrongCustomsReleaseText(row) ||
      /\b(?:operator[-\s]?note|operator resolved blocker|exception[-\s]?resolved|resolved)\b[^.;\n]{0,180}\b(?:station confirmed cargo is available|cargo is available|available for pickup|pickup blocker (?:is )?handled|release (?:is )?(?:visible|handled|resolved|confirmed))\b/i.test(row)
    ) &&
    !factLooksNonFinalCustomsRelease(row) &&
    !EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(row)
  );
}

function hasRequestedArrivalEvidence(value) {
  const text = String(value || "");
  return /\b(?:await|awaiting|will await|waiting for|wait for|wait on|will wait on|watch for|monitor for|need|needs|needed|request|requested|please provide|provide|send|looking for|missing)\b[^.;\n]{0,100}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability)\b/i.test(text) ||
    /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability)\b[^.;\n]{0,100}\b(?:awaited|waiting|needed|requested|missing|not received|not found|not available)\b/i.test(text);
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function approvedPickupBrokerForName(value = "") {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  return APPROVED_PICKUP_BROKERS.find((broker) => {
    const name = broker.name.toLowerCase();
    const email = broker.email.toLowerCase();
    return text.includes(name) ||
      name.includes(text) ||
      text.includes(email) ||
      /\bbtx\b|birch cartage/i.test(text) && /\bbtx\b/i.test(name) ||
      /meadow freight/i.test(text) && /meadow freight/i.test(name) ||
      /rapid/i.test(text) && /rapid/i.test(name) ||
      /\bjd direct\b|j&d/i.test(text) && /jd direct/i.test(name);
  }) || null;
}

function readJsonFile(rootDir, fileName, fallback) {
  return fs.readFile(path.join(rootDir, fileName), "utf8")
    .then((content) => JSON.parse(content))
    .catch(() => fallback);
}

function bundledTruthPackets() {
  return JSON.parse(JSON.stringify(BUNDLED_TRUTH_PACKETS || { shipments: [] }));
}

// Durable companion memory is operator context, never shipment authority.
// Only annotations attached to an AWB already present in the canonical packet
// snapshot are admitted; they are not promoted into gates, facts, or state.
function companionMemoryForTruthPackets(snapshot = {}, truthPackets = {}) {
  const allowed = new Set((truthPackets.shipments || []).map((row) => normalizeAwb(row.awb || row.id)).filter(Boolean));
  const withinPacketScope = (entry) => allowed.has(normalizeAwbFrom(
    entry?.awb,
    entry?.shipmentAwb,
    entry?.shipmentId,
    entry?.text,
    entry?.summary,
  ));
  return {
    ...emptyCompanionMemory(snapshot.snapshotTime || ""),
    snapshotTime: snapshot.snapshotTime || "",
    source: snapshot.source || "operator-companion-memory",
    contextOnly: true,
    operatorNotes: (Array.isArray(snapshot.operatorNotes) ? snapshot.operatorNotes : []).filter(withinPacketScope),
    resolvedConflicts: (Array.isArray(snapshot.resolvedConflicts) ? snapshot.resolvedConflicts : []).filter(withinPacketScope),
    alertStates: (Array.isArray(snapshot.alertStates) ? snapshot.alertStates : []).filter(withinPacketScope),
  };
}

async function readLocalMemory(rootDir) {
  const [brain, truthPackets, outbox, actionQueue, stationMemory, gmailProof, operationalFactLedger, companionMemorySnapshot, truthAudit] = await Promise.all([
    readJsonFile(rootDir, "ops-brain-memory.json", {}),
    readJsonFile(rootDir, "shipment-truth-packets.json", bundledTruthPackets()),
    readJsonFile(rootDir, "outbox-requests.json", { requests: [] }),
    readJsonFile(rootDir, "action-queue.json", { actions: [] }),
    readJsonFile(rootDir, "station-memory.json", { contacts: [] }),
    readJsonFile(rootDir, "gmail-proof-snapshot.json", { proofs: [] }),
    readJsonFile(rootDir, "operational-fact-ledger.json", { facts: [], evidenceDocuments: [], workgroups: [], disputes: [] }),
    readJsonFile(rootDir, "companion-memory.json", emptyCompanionMemory("")),
    readJsonFile(rootDir, "data/shipment-truth-audit.json", { shipments: [] }),
  ]);
  return {
    brain,
    active: { shipments: [] },
    truthPackets,
    actions: {
      actions: actionQueue.actions || [],
      actionQueue,
      outbox,
      outboxRequests: outbox.requests || [],
    },
    outbox,
    stationMemory,
    gmailProof,
    shipmentState: { shipments: [] },
    shipmentEvents: { events: [] },
    operatorNotifications: { notifications: [] },
    operationalFactLedger,
    companionMemory: companionMemoryForTruthPackets(companionMemorySnapshot, truthPackets),
    truthAudit,
  };
}

async function readHostedSupabaseConfig(rootDir, env = process.env) {
  if (env.PQ_SUPABASE_URL && (env.PQ_SUPABASE_SERVICE_ROLE_KEY || env.PQ_SUPABASE_ANON_KEY)) {
    return {
      url: env.PQ_SUPABASE_URL,
      key: env.PQ_SUPABASE_SERVICE_ROLE_KEY || env.PQ_SUPABASE_ANON_KEY,
      table: env.PQ_SNAPSHOT_TABLE || "app_snapshots",
    };
  }
  return null;
}

async function loadHostedSnapshot(config, snapshotKey, options = {}) {
  if (!config) throw new Error("Hosted snapshot config missing");
  return loadAppSnapshot(snapshotKey, {}, {
    timeoutMs: Number(options.timeoutMs || HOSTED_SNAPSHOT_TIMEOUT_MS),
    retryDelaysMs: [],
  });
}

function hostedSnapshotLoadWarning(snapshotKey, error, fallbackSource) {
  const message = error instanceof Error ? error.message : String(error);
  return `Hosted ${snapshotKey} snapshot unavailable (${message}); using ${fallbackSource}.`;
}

function hostedWarningText(warning) {
  if (typeof warning === "string") return warning;
  if (!warning || typeof warning !== "object") return String(warning || "");
  return [
    warning.type,
    warning.snapshotKey,
    warning.fallbackSource,
    warning.reason,
    warning.message,
  ].filter(Boolean).join(" ");
}

async function loadHostedSnapshotOrFallback(config, snapshotKey, fallback, warnings, fallbackSource) {
  try {
    return await loadHostedSnapshot(config, snapshotKey);
  } catch (error) {
    warnings.push(hostedSnapshotLoadWarning(snapshotKey, error, fallbackSource));
    return fallback;
  }
}

async function loadHostedTruthPackets(config, rootDir, warnings = []) {
  try {
    const hosted = await loadHostedSnapshot(config, "shipment-truth-packets", { timeoutMs: HOSTED_TRUTH_SNAPSHOT_TIMEOUT_MS });
    return sanitizeTruthPacketSnapshot(hosted).snapshot;
  } catch (error) {
    warnings.push(hostedSnapshotLoadWarning("shipment-truth-packets", error, "no-truth-fallback"));
    return {
      shipments: [],
      activeAwbs: [],
      sourceTruthUnavailable: true,
      sourceTruthWarnings: [...warnings],
    };
  }
}

function emptyMemory(truthPackets = { shipments: [] }) {
  return {
    brain: { shipments: [], completed: [] },
    active: { shipments: [] },
    truthPackets,
    actions: { actions: [], actionQueue: { actions: [] }, outbox: { requests: [] }, outboxRequests: [] },
    outbox: { requests: [] },
    stationMemory: { contacts: [] },
    gmailProof: { proofs: [] },
    shipmentState: { shipments: [] },
    shipmentEvents: { events: [] },
    operatorNotifications: { notifications: [] },
    operationalFactLedger: { facts: [], evidenceDocuments: [], workgroups: [], disputes: [] },
    companionMemory: emptyCompanionMemory(""),
    truthAudit: { shipments: [] },
  };
}

async function readHostedMemory(rootDir, env = process.env, options = {}) {
  // includeGmailProof=false skips the multi-MB gmail-proof-snapshot payload for callers that
  // never read proofs (the board render path). Companion answers keep the default eager read.
  const includeGmailProof = options.includeGmailProof !== false;
  const config = await readHostedSupabaseConfig(rootDir, env);
  if (!config) throw new Error("Hosted snapshot config missing");
  const hostedWarnings = [];
  const companionContextWarnings = [];
  const truthPackets = await loadHostedTruthPackets(config, rootDir, hostedWarnings);
  const hostedTruthUnavailable = truthPackets.sourceTruthUnavailable || !(truthPackets.shipments || []).length;
  if (hostedTruthUnavailable) {
    return {
      ...emptyMemory(),
      truthPackets: {
        ...truthPackets,
        sourceTruthWarnings: [
          ...(Array.isArray(truthPackets.sourceTruthWarnings) ? truthPackets.sourceTruthWarnings : []),
          ...hostedWarnings,
        ],
      },
    };
  }
  const [brain, outbox, actionQueue, stationMemory, gmailProof, operationalFactLedger, companionMemorySnapshot, truthAudit, refreshHealth] = await Promise.all([
    loadHostedSnapshotOrFallback(config, "ops-brain-memory", { shipments: [], completed: [] }, hostedWarnings, "empty diagnostic fallback"),
    loadHostedSnapshotOrFallback(config, "outbox-requests", { requests: [] }, hostedWarnings, "empty diagnostic fallback"),
    loadHostedSnapshotOrFallback(config, "action-queue", { actions: [] }, hostedWarnings, "empty diagnostic fallback"),
    loadHostedSnapshotOrFallback(config, "station-memory", { contacts: [] }, hostedWarnings, "empty diagnostic fallback"),
    includeGmailProof
      ? loadHostedSnapshotOrFallback(config, "gmail-proof-snapshot", { proofs: [] }, hostedWarnings, "empty diagnostic fallback")
      : Promise.resolve({ proofs: [], snapshotTime: "", skipped: "gmail-proof-lazy" }),
    loadHostedSnapshotOrFallback(config, "operational-fact-ledger", { facts: [], evidenceDocuments: [], workgroups: [], disputes: [] }, hostedWarnings, "empty diagnostic fallback"),
    loadHostedSnapshotOrFallback(config, "companion-memory", emptyCompanionMemory(""), companionContextWarnings, "empty operator-context fallback"),
    loadHostedSnapshotOrFallback(config, "shipment-truth-audit", { shipments: [] }, hostedWarnings, "empty diagnostic fallback"),
    // Tiny per-run cron record. When quiet cycles skip the unchanged truth-packet
    // write, this row's verified signature is what proves the stored truth is
    // current — without it the board would call verified truth stale.
    loadHostedSnapshotOrFallback(config, "gmail-refresh-health", {}, [], "no refresh-health snapshot"),
  ]);
  const truthPacketsWithWarnings = hostedWarnings.length
    ? {
        ...truthPackets,
        sourceTruthWarnings: [
          ...(Array.isArray(truthPackets.sourceTruthWarnings) ? truthPackets.sourceTruthWarnings : []),
          ...hostedWarnings,
        ],
      }
    : truthPackets;
  return {
    brain,
    active: { shipments: [] },
    truthPackets: truthPacketsWithWarnings,
    actions: {
      actions: actionQueue.actions || [],
      actionQueue,
      outbox,
      outboxRequests: outbox.requests || [],
    },
    outbox,
    stationMemory,
    gmailProof,
    shipmentState: { shipments: [] },
    shipmentEvents: { events: [] },
    operatorNotifications: { notifications: [] },
    operationalFactLedger,
    companionMemory: companionMemoryForTruthPackets(companionMemorySnapshot, truthPackets),
    companionMemoryWarnings: companionContextWarnings,
    truthAudit,
    refreshHealth,
  };
}

let opsBrainMemoryCache = null;
const opsBrainAnswerCache = new Map();
let localOpsBrainSpend = { date: "", tokens: 0 };
const opsBrainSpendHealth = { healthy: true };

function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function compactSnapshotIdentity(snapshot = {}, kind = "snapshot") {
  if (snapshot.contentSignature) return String(snapshot.contentSignature);
  if (kind === "truth") {
    return contentSignature({
      snapshotTime: snapshot.snapshotTime || snapshot.refreshedAt || snapshot.generatedAt || "",
      shipments: (snapshot.shipments || []).map((row) => ({
        awb: normalizeAwb(row.awb || row.id),
        role: row.truthPacketRole || "active",
        state: row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || row.opsState?.phase || "",
        gates: row.truthPacket?.gates || row.opsState?.gates || [],
        blocker: row.truthPacket?.operationalBlocker || null,
        nextAction: row.truthPacket?.nextAction || row.nextAction || "",
        sourceFacts: (row.evidencePacket?.sourceFacts || []).map((fact) => ({
          id: fact.id || fact.factId || fact.messageId || "",
          claim: fact.claim || fact.summary || fact.evidence || fact.text || fact.label || "",
          observedAt: fact.observedAt || fact.at || fact.receivedAt || "",
          sourceType: fact.sourceType || fact.source || fact.type || "",
          sourceName: fact.sourceName || fact.sourceRef || fact.subject || fact.messageId || "",
        })),
      })),
    });
  }
  if (kind === "gmail") {
    return contentSignature({
      snapshotTime: snapshot.snapshotTime || "",
      proofs: (snapshot.proofs || []).map((proof) => ({
        awb: normalizeAwb(proof.awb || proof.normalizedAwb),
        latestEventAt: proof.latestEventAt || "",
        events: (proof.events || []).slice(-8).map((event) => ({ id: event.messageId || event.id || "", at: event.at || "", type: event.type || "", from: event.from || "", summary: event.summary || "" })),
      })),
    });
  }
  const rows = kind === "companion"
    ? [
        ...(snapshot.operatorNotes || []).map((row) => ({ ...row, _memoryKind: "note" })),
        ...(snapshot.resolvedConflicts || []).map((row) => ({ ...row, _memoryKind: "resolved-conflict" })),
        ...(snapshot.alertStates || []).map((row) => ({ ...row, _memoryKind: "alert-state" })),
      ]
    : kind === "station"
      ? snapshot.contacts || []
      : snapshot.requests || snapshot.actions || snapshot.operatorNotes || [];
  return contentSignature({
    snapshotTime: snapshot.snapshotTime || "",
    rows: rows.map((row) => ({
      id: row.id || row.actionId || "",
      awb: normalizeAwbFrom(row.awb, row.shipmentAwb, row.shipmentId, row.text, row.summary),
      status: row.status || "",
      type: row.type || "",
      text: row.label || row.subject || row.summary || row.text || row._memoryKind || [
        row.airport,
        row.station,
        row.airline,
        row.handlerName,
        row.name,
        row.stationEmail,
        row.email,
        row.stationPhone,
        row.phone,
      ].filter(Boolean).join("|"),
      at: row.sentAt || row.queuedAt || row.createdAt || row.updatedAt || "",
    })),
  });
}

function opsBrainTruthSignature(memory = {}, env = process.env) {
  const freshness = analyticalSourceFreshness(memory, memory.truthPackets?.shipments || [], env);
  return contentSignature({
    truth: compactSnapshotIdentity(memory.truthPackets || {}, "truth"),
    gmail: compactSnapshotIdentity(memory.gmailProof || {}, "gmail"),
    outbox: compactSnapshotIdentity(memory.outbox || {}, "outbox"),
    actions: compactSnapshotIdentity(memory.actions?.actionQueue || { actions: memory.actions?.actions || [] }, "actions"),
    companion: compactSnapshotIdentity(memory.companionMemory || {}, "companion"),
    station: compactSnapshotIdentity(memory.stationMemory || {}, "station"),
    freshness: {
      status: freshness.status,
      staleSources: freshness.staleSources,
      warnings: freshness.warnings,
    },
  });
}

function normalizedQuestionKey(question) {
  return String(question || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function resolvedScopeKey(question, context = {}, memory = {}) {
  const explicitAwbs = explicitAwbsFromText(question);
  if (explicitAwbs.length > 1) return `group:${explicitAwbs.sort().join(",")}`;
  const explicitAwb = explicitAwbs[0] || normalizeAwb(context.awb || "");
  if (explicitAwb) return `shipment:${explicitAwb}`;
  const station = stationFromQuestion(question, memory.truthPackets?.shipments || []) || String(context.station || "").toUpperCase();
  if (station) return `station:${station}`;
  const ids = Array.isArray(context.shipmentIds) ? context.shipmentIds.map(normalizeAwb).filter(Boolean).sort() : [];
  return ids.length ? `group:${ids.join(",")}` : "fleet";
}

function modelCacheAllowed(env = process.env, modelRuntime = null) {
  const killed = env.PIKIIO_OPS_BRAIN_AI_DISABLED === "1" ||
    env.PQ_OPS_BRAIN_AI_DISABLED === "1" ||
    env.PQ_SUPABASE_WRITES_DISABLED === "1";
  if (killed) return false;
  if (modelRuntime) {
    return Boolean(env.OPENAI_API_KEY) && !modelRuntime.disabled() && modelRuntime.keyAllowed();
  }
  return looksLikeRealKey(env.OPENAI_API_KEY || "");
}

function opsBrainAnswerCacheKey(question, context, memory, history = [], env = process.env) {
  const historyScope = contextFromHistory(history, mergeShipments(memory, { attachPackets: false }), context);
  const scopedContext = {
    ...context,
    awb: context.awb || historyScope.shipment?.awb || "",
    station: context.station || historyScope.station || "",
    shipmentIds: context.shipmentIds?.length ? context.shipmentIds : historyScope.listShipments?.map((row) => row.awb) || [],
  };
  return [normalizedQuestionKey(question), resolvedScopeKey(question, scopedContext, memory), opsBrainTruthSignature(memory, env)].join("|");
}

function modelCacheGet(cacheKey, env = process.env) {
  const entry = opsBrainAnswerCache.get(cacheKey);
  if (!entry) return null;
  const ttl = Number(env.PIKIIO_OPS_BRAIN_ANSWER_CACHE_MS || 30 * 60 * 1000);
  if (!Number.isFinite(ttl) || ttl < 0 || Date.now() - entry.at > ttl) {
    opsBrainAnswerCache.delete(cacheKey);
    return null;
  }
  opsBrainAnswerCache.delete(cacheKey);
  opsBrainAnswerCache.set(cacheKey, entry);
  return cloneJson(entry.value);
}

function modelCacheSet(cacheKey, value) {
  opsBrainAnswerCache.set(cacheKey, {
    at: Date.now(),
    value: cloneJson(value),
  });
  while (opsBrainAnswerCache.size > 200) opsBrainAnswerCache.delete(opsBrainAnswerCache.keys().next().value);
}

function answerCacheGet(cacheKey, env = process.env) {
  return modelCacheGet(cacheKey, env);
}

function answerCacheSet(cacheKey, value) {
  modelCacheSet(cacheKey, { ...value, answer: publicBrainAnswer(value.answer) });
}

function defaultOpsBrainSpendStore(env = process.env, rpcImpl = callSupabaseRpc) {
  const persistent = env === process.env && Boolean(env.PQ_SUPABASE_URL && env.PQ_SUPABASE_SYNC_TOKEN);
  const readAtomicTotal = async (tokens) => {
    const date = utcDateKey();
    const increment = Math.max(0, Math.ceil(Number(tokens || 0)));
    if (!Number.isFinite(increment)) throw new Error("Invalid ops-brain spend increment");
    const payload = await rpcImpl("increment_ops_brain_model_spend", {
      p_date: date,
      p_tokens: increment,
      p_sync_token: env.PQ_SUPABASE_SYNC_TOKEN,
    }, { retryDelaysMs: [], timeoutMs: 900 });
    const data = Array.isArray(payload) ? payload[0] || {} : payload || {};
    const total = Number(data.tokens);
    if (data.date !== date || !Number.isFinite(total) || total < 0) throw new Error("Invalid ops-brain spend total");
    return { date, tokens: total };
  };
  return {
    async get() {
      const date = utcDateKey();
      if (!persistent) {
        if (localOpsBrainSpend.date !== date) localOpsBrainSpend = { date, tokens: 0 };
        return localOpsBrainSpend;
      }
      return readAtomicTotal(0);
    },
    async add(tokens) {
      const date = utcDateKey();
      if (!persistent) {
        if (localOpsBrainSpend.date !== date) localOpsBrainSpend = { date, tokens: 0 };
        localOpsBrainSpend.tokens += Number(tokens || 0);
        return localOpsBrainSpend;
      }
      return readAtomicTotal(tokens);
    },
  };
}

function isRealVercelRuntime(env = process.env) {
  return Boolean(env.VERCEL_URL || env.VERCEL_REGION);
}

function memoryCacheKey(rootDir, env = process.env) {
  const hostedOnly = isRealVercelRuntime(env);
  return [
    path.resolve(rootDir || "."),
    hostedOnly ? "hosted" : "merged",
    env.PQ_SUPABASE_URL || "",
    env.PQ_SNAPSHOT_TABLE || "app_snapshots",
  ].join("|");
}

function memoryCacheTtlMs(env = process.env) {
  const fallback = 45000;
  const configured = String(env.PIKIIO_OPS_BRAIN_MEMORY_CACHE_MS ?? "").trim();
  const value = configured ? Number(configured) : fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.min(60000, value);
}

function snapshotTimeMs(snapshot = {}) {
  const parsed = Date.parse(snapshot?.snapshotTime || snapshot?.updatedAt || snapshot?.finishedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function truthPacketRuntimePhase(row = {}) {
  return String(row.opsState?.phase || row.phase || row.stage || row.truthPacket?.phase || "").toLowerCase();
}

function truthPacketHasOpenPodObligation(row = {}) {
  const podGate = row.opsState?.gates?.pod || row.gates?.pod || row.truthPacket?.gates?.pod || row.pod || {};
  const podStatus = String(podGate.status || "").toLowerCase().replace(/_/g, "-");
  const nextAction = String(row.nextAction || row.opsState?.nextAction || row.truthPacket?.nextAction || "").trim();
  const resolvedPodStatuses = new Set([
    "done", "complete", "completed", "received", "found", "pod-found", "pod-received", "true",
  ]);
  const unresolvedPodStatuses = new Set([
    "unknown", "pending", "needed", "missing", "open", "waiting", "verify", "pod-needed", "pod-pending",
  ]);
  return unresolvedPodStatuses.has(podStatus) &&
    !resolvedPodStatuses.has(podStatus) &&
    /\bpod\b|proof of delivery/i.test(nextAction) &&
    !/\bno action\b|pod (?:is )?in (?:memory|the packet)|pod (?:is )?(?:received|complete|found)/i.test(nextAction);
}

function truthPacketRuntimeIssue(row = {}) {
  const role = String(row.truthPacketRole || "active").toLowerCase();
  if (role !== "active") return null;
  const phase = truthPacketRuntimePhase(row);
  if (row.completed) {
    return {
      code: "active-completed-flag",
      reason: "Active truth packet row is marked completed.",
      phase,
    };
  }
  if (["delivered", "completed", "closed"].includes(phase)) {
    if (phase === "delivered" && truthPacketHasOpenPodObligation(row)) return null;
    return {
      code: "active-terminal-phase",
      reason: "Terminal shipment phase is still marked active.",
      phase,
    };
  }
  return null;
}

function activeAwbsFromTruthRows(rows = []) {
  return unique(
    rows
      .filter((row) => String(row.truthPacketRole || "active").toLowerCase() === "active")
      .map((row) => normalizeAwb(row.awb || row.id || row.shipmentId))
      .filter(Boolean),
  ).sort();
}

function sanitizeTruthPacketSnapshot(snapshot = {}) {
  const rows = Array.isArray(snapshot?.shipments) ? snapshot.shipments : [];
  if (!rows.length) {
    return {
      snapshot: { ...(snapshot || {}), shipments: [] },
      quarantinedRows: [],
    };
  }
  const quarantinedRows = [];
  const safeRows = [];
  for (const row of rows) {
    const issue = truthPacketRuntimeIssue(row);
    if (issue) {
      quarantinedRows.push({
        awb: normalizeAwb(row.awb || row.id || row.shipmentId),
        displayAwb: row.awb || row.id || row.shipmentId || "",
        ...issue,
      });
      continue;
    }
    safeRows.push(row);
  }
  const activeRows = safeRows.filter((row) => String(row.truthPacketRole || "active").toLowerCase() === "active");
  const completedRows = safeRows.filter((row) => String(row.truthPacketRole || "").toLowerCase() === "completed");
  const sanitized = {
    ...(snapshot || {}),
    shipments: safeRows,
    activeAwbs: activeAwbsFromTruthRows(safeRows),
    completedAwbs: snapshot.completedAwbs || completedRows.map((row) => normalizeAwb(row.awb || row.id || row.shipmentId)).filter(Boolean).sort(),
    counts: {
      ...(snapshot.counts || {}),
      shipments: safeRows.length,
      activeShipments: activeRows.length,
      quarantinedShipments: quarantinedRows.length,
    },
  };
  if (quarantinedRows.length) {
    sanitized.runtimeQuarantine = {
      reason: "Unsafe active truth-packet rows were removed per shipment; healthy hosted truth remains live.",
      quarantinedRows,
    };
    sanitized.sourceTruthWarnings = [
      ...(Array.isArray(snapshot.sourceTruthWarnings) ? snapshot.sourceTruthWarnings : []),
      `Quarantined ${quarantinedRows.length} unsafe active truth row${quarantinedRows.length === 1 ? "" : "s"} instead of falling back to stale local truth.`,
    ];
  }
  return { snapshot: sanitized, quarantinedRows };
}

function truthPacketsRuntimeSafe(snapshot = {}) {
  const rows = Array.isArray(snapshot?.shipments) ? snapshot.shipments : [];
  if (!rows.length) return false;
  return !rows.some((row) => truthPacketRuntimeIssue(row));
}

async function readOpsBrainMemory(rootDir, env = process.env, options = {}) {
  const cacheTtlMs = memoryCacheTtlMs(env);
  // The proof-less variant must never satisfy a caller that needs proofs (and vice versa),
  // so the lazy flag is part of the cache identity.
  const cacheKey = `${memoryCacheKey(rootDir, env)}|proof:${options.includeGmailProof === false ? "lazy" : "eager"}`;
  const now = Date.now();
  if (cacheTtlMs > 0 && opsBrainMemoryCache?.key === cacheKey && opsBrainMemoryCache.expiresAt > now) {
    return opsBrainMemoryCache.value;
  }
  const hostedOnly = isRealVercelRuntime(env);
  let memory;
  if (hostedOnly) {
    try {
      memory = await readHostedMemory(rootDir, env, options);
      if (cacheTtlMs > 0) opsBrainMemoryCache = { key: cacheKey, expiresAt: Date.now() + cacheTtlMs, value: memory };
      return memory;
    } catch (error) {
      // A real hosted runtime must never serve bundled packet truth as current.
      // Return an empty, explicitly unavailable authority so every consumer
      // fails closed and the next request retries hosted storage.
      const fallback = emptyMemory({
        shipments: [],
        activeAwbs: [],
        sourceTruthUnavailable: true,
        sourceTruthWarnings: [error instanceof Error ? error.message : String(error || "hosted read failed")],
      });
      fallback.hostedReadFallback = {
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error || "hosted read failed"),
        source: "no-truth-fallback",
        snapshotTime: "",
      };
      return fallback;
    }
  }
  memory = env.PQ_USE_HOSTED_MEMORY === "1"
    ? await readHostedMemory(rootDir, env, options)
    : await readLocalMemory(rootDir);
  if (cacheTtlMs > 0) opsBrainMemoryCache = { key: cacheKey, expiresAt: Date.now() + cacheTtlMs, value: memory };
  return memory;
}

function statusText(shipment) {
  return [
    shipment.awb,
    shipment.station,
    shipment.airline,
    shipment.client,
    shipment.consignee,
    shipment.stage,
    shipment.currentState,
    shipment.nextAction,
    shipment.eta,
    shipment.arrivalStatus,
    shipment.clearanceStatus,
    shipment.pickupStatus,
    shipment.lastEmail?.summary,
    shipment.customsBroker?.broker,
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.nextAction,
    shipment.freightBroker?.broker,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.deliveryPlan,
    shipment.freightBroker?.nextAction,
    shipment.storage?.lastFreeDay,
    shipment.storage?.storageStartsAt,
    shipment.storage?.storageAccruingSince,
    shipment.storage?.dailyStorageRate,
    shipment.pod?.status,
    shipment.pod?.recipient,
    shipment.pod?.deliveredAt,
    shipment.completion?.deliveredAt,
    ...(shipment.facts || []).map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`),
    ...(shipment.factLedger || []).map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || fact.note || ""}`),
    ...(shipment.storage?.evidence || []),
    ...(shipment.pod?.evidence || []),
    ...(shipment.emailValidation?.events || []).map((event) => `${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`),
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    ...(shipment.opsState?.exceptions || []).map((item) => `${item.type || ""} ${item.summary || ""} ${item.nextAction || ""} ${item.evidence || ""}`),
    ...(shipment.opsState?.events || []).map((event) => `${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`),
  ]
    .filter(Boolean)
    .join(" ");
}

function evidenceText(shipment, pattern = /./) {
  return [
    shipment.lastEmail?.summary,
    ...(shipment.facts || [])
      .filter((fact) => pattern.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`))
      .map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || fact.note || ""}`),
    ...(shipment.factLedger || [])
      .filter((fact) => pattern.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || fact.note || ""}`))
      .map((fact) => `${fact.type || ""} ${fact.label || ""} ${fact.summary || fact.note || ""}`),
    ...(shipment.storage?.evidence || []).filter((item) => pattern.test(String(item || ""))),
    ...(shipment.pod?.evidence || []).filter((item) => pattern.test(String(item || ""))),
  ].filter(Boolean).join(" ");
}

function hasActualArrivalEvidence(text) {
  const value = String(text || "");
  if (factLooksPlanningOnly(value)) return false;
  if (hasRequestedArrivalEvidence(value)) return false;
  if (/\b(?:not[-\s]?arrived|has not arrived|not at destination|arrival pending|pending arrival|no arrival proof|arrival proof missing|no arrival notice|without arrival notice|no notice of arrival|no \bnoa\b|no on[-\s]?hand proof|not on[-\s]?hand)\b/i.test(value)) {
    return false;
  }
  if (hasArrivalPendingLanguage(value)) {
    return false;
  }
  if (/\b(?:after|once|when|until|if|before)\b[^.;\n]{0,80}\b(?:arrival|notice of arrival|\bnoa\b|delivered to|delivery to|arrives? at|on[-\s]?hand|available)\b/i.test(value)) {
    return false;
  }
  if (/\barr\s*[/ -]\s*dept\b/i.test(value)) {
    const arrDeptMatch = value.match(/\barr\s*[/ -]\s*dept\b[^.;\n]{0,80}\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i);
    const arrDeptDate = arrDeptMatch ? parsedDateKey(arrDeptMatch[1], new Date()) : "";
    const hasStationArrivalContext = /\b(?:arrival notice|station[-\s]?arrival|carrier location|terminal|handler|station|wfs|air general|agi)\b/i.test(value);
    if (!hasStationArrivalContext) return false;
    if (arrDeptDate && arrDeptDate > operatorDateKey(new Date())) return false;
  }
  if (/\b(?:after|when|until|if)\b[^.;\n]{0,50}\b(?:station|carrier|airline)\b[^.;\n]{0,80}\b(?:confirms?|confirms? freight|available|on[-\s]?hand)\b/i.test(value)) {
    return false;
  }
  return (
    (
      ARRIVAL_POSITIVE_PATTERN.test(value) &&
      !/\b(?:no|without|missing|pending|awaiting|need|needs|needed)\b[^.;\n]{0,30}\b(?:arrival notice|notice of arrival|\bnoa\b|arrival proof|on[-\s]?hand proof)\b/i.test(value)
    ) ||
    /\barrival evidence (?:was )?found\b/i.test(value)
  );
}

function stripAttachmentExtractionUnavailableText(text) {
  return String(text || "")
    .replace(/\battachment metadata indicates operational evidence\b/ig, "attachment metadata")
    .replace(/\bpdf text (?:was )?not available\b/ig, "pdf text unavailable")
    .replace(/\btext was not available in this refresh\b/ig, "text unavailable in this refresh")
    .replace(/\bextracted text (?:was )?not available\b/ig, "extracted text unavailable");
}

function hasNegativeArrivalEvidence(text) {
  const value = String(text || "");
  return (
    ARRIVAL_NEGATIVE_PATTERN.test(value) ||
    hasArrivalPendingLanguage(value)
  ) && !hasActualArrivalEvidence(value);
}

function hasHardNegativeArrivalEvidence(text) {
  const value = String(text || "");
  return /\b(?:not[-\s]?arrived|has not arrived|not at destination|arrival pending|pending arrival|no arrival proof|arrival proof missing|no arrival notice|without arrival notice|no notice of arrival|no \bnoa\b|no on[-\s]?hand proof|not on[-\s]?hand)\b/i.test(value) ||
    hasArrivalPendingLanguage(value);
}

function hasArrivalPendingLanguage(value) {
  const text = String(value || "");
  if (/\bdo not dispatch until\b[^.;\n]{0,140}\b(?:proof|arrival|on[-\s]?hand|availability)\b/i.test(text)) {
    return false;
  }
  if (
    /\b(?:arrival date|arrived at|arrived on|on[-\s]?hand|available for pickup|cargo (?:is )?available|confirmed arrival|confirmed arrived)\b/i.test(text) &&
    /\b(?:release|clearance|customs)\b[^.;\n]{0,30}\b(?:pending|missing|needed|not received|not found|blocking)\b/i.test(text)
  ) {
    return false;
  }
  return /\b(?:await(?:ing)?|will await|wait(?:ing)? for|wait on|will wait on|pending|missing|needed|need|no|not received|not found|still pending)\b[^.;\n]{0,80}\b(?:arrival|notice of arrival|\bnoa\b|on[-\s]?hand proof)\b|\b(?:arrival|notice of arrival|\bnoa\b|on[-\s]?hand proof)\b[^.;\n]{0,80}\b(?:pending|missing|not received|not found|not available|needed|still pending)\b/i.test(text);
}

function hasStrongArrivalEvidence(shipment) {
  const facts = shipmentStateFacts(shipment);
  const arrivalFacts = facts
    .filter((fact) =>
      /arrival|notice|station|tracking|email|gmail|inbound|available|on[-\s]?hand|release/i.test(fact.text) &&
      !["current-state", "next-action"].includes(fact.source) &&
      !factLooksProofOnlyArrivalSummary(fact.text) &&
      !factLooksGenericCanonicalArrival(fact.text) &&
      !factLooksUnreadableAttachmentNoise(fact.text)
    );
  const text = arrivalFacts.map((fact) => fact.text).join(" ");
  const latestConcreteArrival = arrivalFacts
    .filter((fact) => hasActualArrivalEvidence(fact.text))
    .sort((a, b) => b.time - a.time)[0] || null;
  const latestHardNegativeArrival = arrivalFacts
    .filter((fact) => hasHardNegativeArrivalEvidence(fact.text) || hasRequestedArrivalEvidence(fact.text))
    .sort((a, b) => b.time - a.time)[0] || null;
  const fullText = statusText(shipment);
  const proofOnlyArrival = facts.some((fact) => factLooksProofOnlyArrivalSummary(fact.text)) &&
    !hasHardNegativeArrivalEvidence(fullText) &&
    !hasRequestedArrivalEvidence(fullText);
  if (latestHardNegativeArrival && (!latestConcreteArrival || latestHardNegativeArrival.time > latestConcreteArrival.time)) {
    return false;
  }
  if ((hasNegativeArrivalEvidence(fullText) || hasRequestedArrivalEvidence(fullText)) && !latestConcreteArrival && !hasActualArrivalEvidence(text)) return false;
  if (/\b(?:after|when|until|if)\b[^.;\n]{0,50}\b(?:station|carrier|airline)\b[^.;\n]{0,80}\b(?:confirms?|confirms? freight|available|on[-\s]?hand)\b/i.test(text)) {
    return false;
  }
  return (
    shipment.arrivalStatus === "arrived" ||
    ["ready", "airport-picked-up", "delivered"].includes(shipment.pickupStatus) ||
    Boolean(latestConcreteArrival) ||
    hasActualArrivalEvidence(text) ||
    proofOnlyArrival
  );
}

function hasStationOnHandProofText(text) {
  const value = String(text || "");
  if (!value || !hasActualArrivalEvidence(value)) return false;
  if (stationConfirmationRequestText(value) || hasRequestedArrivalEvidence(value)) return false;
  if (factLooksProofOnlyArrivalSummary(value) || /\barrival\/on[-\s]?hand evidence was received\b/i.test(value)) return false;
  const hasHandlerContext = /\b(?:arrival notice|notice of arrival|\bnoa\b|station[-\s]?arrival|handler|terminal|warehouse|wfs|air general|agi|forward air|swissport|choice|serviceimport)\b/i.test(value);
  const trackingOnly =
    /\b(?:carrier tracking|tracking|united cargo|latest ready for pickup|airline website|tms)\b/i.test(value) &&
    !hasHandlerContext;
  if (trackingOnly) return false;
  const customsOrEntryOnly =
    /\b(?:ace|customs|entry port|firms?|release status|98\s*-\s*released)\b/i.test(value) &&
    !hasHandlerContext;
  if (customsOrEntryOnly) return false;
  return /\b(?:arrival notice|notice of arrival|\bnoa\b|station[-\s]?arrival|on[-\s]?hand|available for pickup|cargo (?:is )?available|freight (?:is )?available|ready[-\s]?for[-\s]?pickup|pickup[-\s]?ready|confirmed arrival|arrival[-\s]?confirmed|confirmed arrived|arrived at)\b/i.test(value);
}

function hasStationOnHandProof(shipment) {
  return shipmentStateFacts(shipment)
    .filter((fact) => !["current-state", "next-action", "arrival-status", "pickup-status"].includes(fact.source))
    .some((fact) => hasStationOnHandProofText(fact.text));
}

function pickupExecutionText(shipment) {
  return [
    shipment.pickupStatus,
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.deliveryPlan,
    shipment.freightBroker?.nextAction,
    ...(shipment.freightBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || item}`),
    ...(shipment.operatorNotes || []).map(factRowText),
    evidenceText(shipment, /pickup|dispatch|driver|truck|trucker|loading|loaded|detention|delivery|pod|broker/i),
  ].filter(Boolean).join(" ");
}

function factRowText(fact) {
  if (!fact) return "";
  if (typeof fact === "string") return fact;
  return [
    fact.type,
    fact.label,
    fact.summary,
    fact.note,
    fact.evidence,
    fact.status,
    fact.nextAction,
    fact.broker,
    fact.selectedBroker,
    fact.contactEmail,
    fact.amount,
    fact.extractedText,
  ].filter(Boolean).join(" ");
}

function factRowAt(fact, fallback = "") {
  if (!fact || typeof fact === "string") return fallback;
  return fact.at || fact.latestEventAt || fact.createdAt || fact.receivedAt || fact.timestamp || fallback || "";
}

function factTime(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function shipmentStateFacts(shipment) {
  const rows = [];
  const add = (text, at = "", source = "") => {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return;
    rows.push({ text: value, at, source, time: factTime(at) });
  };
  add(shipment.currentState, "", "current-state");
  add(shipment.nextAction, "", "next-action");
  add(shipment.pickupStatus, "", "pickup-status");
  add(shipment.arrivalStatus, "", "arrival-status");
  add(shipment.lastEmail?.summary, shipment.lastEmail?.at, "latest-email");
  add(shipment.emailValidation?.summary, shipment.emailValidation?.latestEventAt || shipment.lastEmail?.at, "email-validation");
  add(shipment.emailValidation?.nextAction, shipment.emailValidation?.latestEventAt || shipment.lastEmail?.at, "email-validation");
  for (const proof of shipment.emailValidation?.proof || []) add(factRowText(proof), factRowAt(proof, shipment.lastEmail?.at), "email-proof");
  for (const event of shipment.emailValidation?.events || []) add(factRowText(event), factRowAt(event, shipment.lastEmail?.at), "email-event");
  for (const fact of shipment.facts || []) add(factRowText(fact), factRowAt(fact, shipment.lastEmail?.at), "fact");
  for (const fact of shipment.factLedger || []) add(factRowText(fact), factRowAt(fact, shipment.lastEmail?.at), "ledger");
  for (const item of shipment.storage?.evidence || []) add(item, shipment.lastEmail?.at, "storage");
  for (const item of shipment.pod?.evidence || []) add(item, shipment.lastEmail?.at, "pod");
  for (const item of shipment.operatorNotes || []) add(factRowText(item), factRowAt(item), "operator-note");
  add(shipment.customsBroker?.brokerStatus, shipment.lastEmail?.at, "customs");
  add(shipment.customsBroker?.nextAction, shipment.lastEmail?.at, "customs");
  add(shipment.freightBroker?.brokerStatus, shipment.lastEmail?.at, "pickup");
  add(shipment.freightBroker?.pickupPlan, shipment.lastEmail?.at, "pickup");
  add(shipment.freightBroker?.deliveryPlan, shipment.lastEmail?.at, "delivery");
  add(shipment.freightBroker?.nextAction, shipment.lastEmail?.at, "pickup");
  return rows;
}

function latestFact(facts, pattern) {
  return facts
    .filter((fact) => pattern.test(fact.text))
    .sort((a, b) => b.time - a.time)[0] || null;
}

function latestOperatorNoteLine(shipment) {
  const note = (shipment.operatorNotes || [])
    .map((item) => ({
      text: item?.summary || item?.text || item?.note || factRowText(item),
      at: factRowAt(item),
      time: factTime(factRowAt(item)),
    }))
    .filter((item) => item.text)
    .sort((a, b) => b.time - a.time)[0];
  return note ? `Operator note: ${compact(note.text, 105)}.` : "";
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

function operatorDateKey(date = new Date()) {
  const parts = operatorDateParts(date);
  if (!parts) return dateKeyFromDate(date);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function addDaysOperatorDateKey(base = new Date(), days = 0) {
  const parts = operatorDateParts(base);
  if (!parts) return addDaysDateKey(base, days);
  return dateKeyFromDate(new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12)));
}

function eventDateKey(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const embeddedIsoDate = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (embeddedIsoDate) return embeddedIsoDate[1];
  const date = new Date(value);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return "";
  return operatorDateKey(date);
}

function operatorWeekday(date = new Date()) {
  const key = operatorDateKey(date);
  if (!key) return date.getUTCDay();
  return new Date(`${key}T12:00:00Z`).getUTCDay();
}

function parsedDateKey(value, base = new Date()) {
  const parsed = parseOperationalDate(value, base);
  if (!parsed) return "";
  return dateKeyFromDate(new Date(Date.UTC(parsed.year, parsed.month, parsed.day, 12)));
}

function deliveryDateFromText(text, at = "") {
  const value = String(text || "");
  const base = Number.isFinite(Date.parse(at)) ? new Date(at) : new Date();
  if (/\b(?:deliver|delivery|delivering|out for delivery)\b.{0,80}\btomorrow\b/i.test(value)) {
    return addDaysOperatorDateKey(base, 1);
  }
  if (/\b(?:deliver|delivery|delivering|out for delivery)\b.{0,80}\btoday\b/i.test(value)) {
    return addDaysOperatorDateKey(base, 0);
  }
  const explicit = value.match(/\b(?:deliver|delivery|delivering|appointment|appt|eta)\b[^.;\n]{0,80}\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  return explicit ? parsedDateKey(explicit[1], base) : "";
}

function addDaysDateKey(base, days) {
  return dateKeyFromDate(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days, 12)));
}

function questionDateWindow(question, now = new Date()) {
  const text = String(question || "").toLowerCase();
  if (/\btomorrow\b/.test(text)) {
    const day = addDaysOperatorDateKey(now, 1);
    return { start: day, end: day, label: "tomorrow" };
  }
  if (/\b(?:weekend|this weekend|coming weekend)\b/.test(text)) {
    const day = operatorWeekday(now);
    const daysUntilSaturday = (6 - day + 7) % 7;
    const saturdayOffset = daysUntilSaturday === 0 ? 0 : daysUntilSaturday;
    return {
      start: addDaysOperatorDateKey(now, saturdayOffset),
      end: addDaysOperatorDateKey(now, saturdayOffset + 1),
      label: "this weekend",
    };
  }
  if (/\bnext week\b/.test(text)) {
    const day = operatorWeekday(now);
    const daysUntilMonday = (8 - day) % 7 || 7;
    return {
      start: addDaysOperatorDateKey(now, daysUntilMonday),
      end: addDaysOperatorDateKey(now, daysUntilMonday + 6),
      label: "next week",
    };
  }
  if (/\btoday\b/.test(text)) {
    const day = addDaysOperatorDateKey(now, 0);
    return { start: day, end: day, label: "today" };
  }
  const explicit = String(question || "").match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  if (explicit) {
    const day = parsedDateKey(explicit[1], now);
    if (day) return { start: day, end: day, label: formatDate(day) };
  }
  return null;
}

function dateKeyInWindow(dateKey, window) {
  if (!dateKey || !window?.start || !window?.end) return false;
  return dateKey >= window.start && dateKey <= window.end;
}

function dateKeyIsTodayOrFuture(dateKey, now = new Date()) {
  if (!dateKey) return false;
  return dateKey >= operatorDateKey(now);
}

function dateKeyWithinPastDays(dateKey, days, now = new Date()) {
  if (!dateKey) return false;
  const today = operatorDateKey(now);
  const floor = addDaysOperatorDateKey(now, -Math.max(0, Number(days) || 0));
  return Boolean(today && floor && dateKey >= floor && dateKey <= today);
}

function canonicalState(shipment) {
  const state = shipment.opsState || null;
  if (state?.gates && typeof state.gates === "object") return state;
  if (Array.isArray(shipment.truthPacket?.gates) && shipment.truthPacket.gates.length) {
    return {
      phase: String(shipment.truthPacket.currentState || "").toLowerCase().replace(/_/g, "-"),
      label: shipment.truthPacket.stateReason || shipment.truthPacket.currentState || "",
      summary: shipment.truthPacket.stateReason || shipment.truthPacket.currentState || "",
      nextAction: shipment.truthPacket.nextAction?.label || shipment.nextAction || "",
      gates: truthPacketGateMap(shipment),
      source: "operator-truth-packet",
      updatedAt: shipment.truthPacket.compiledAt || "",
    };
  }
  return null;
}

function canonicalGate(shipment, name) {
  return canonicalState(shipment)?.gates?.[name] || null;
}

function canonicalGateIs(shipment, name, statuses) {
  const status = String(canonicalGate(shipment, name)?.status || "").toLowerCase();
  return statuses.includes(status);
}

function canonicalArrivalStillPending(shipment) {
  const state = canonicalState(shipment);
  if (!state) return false;
  const phase = String(state.phase || "").toLowerCase();
  const arrivalStatus = String(state.gates?.arrival?.status || "").toLowerCase();
  return (
    phase === "in-transit" &&
    !["arrived", "confirmed", "done", "complete", "completed"].includes(arrivalStatus)
  );
}

function canonicalReleaseBeforeArrival(shipment) {
  const state = canonicalState(shipment);
  if (!state) return false;
  const phase = String(state.phase || "").toLowerCase();
  const arrivalStatus = String(state.gates?.arrival?.status || "").toLowerCase();
  const customsStatus = String(state.gates?.customs?.status || "").toLowerCase();
  const text = [state.summary, state.nextAction, state.gates?.arrival?.evidence, state.gates?.customs?.evidence]
    .filter(Boolean)
    .join(" ");
  return (
    phase === "pre-arrival" &&
    ["unknown", "waiting", "pending", "missing", "not-arrived"].includes(arrivalStatus) &&
    ["done", "released", "cleared"].includes(customsStatus) &&
    /\b(?:release|released|d\/?o|delivery order|customs)\b/i.test(text) &&
    /\b(?:monitor arrival|do not dispatch|until (?:station|on[-\s]?hand|arrival)|station\/on[-\s]?hand proof)\b/i.test(text)
  );
}

function canonicalGateDate(shipment, names, fields) {
  for (const name of names) {
    const gate = canonicalGate(shipment, name);
    if (!gate) continue;
    for (const field of fields) {
      const raw = gate[field] || "";
      const key = parsedDateKey(raw, new Date()) || dateKeyFromDate(new Date(raw));
      if (key) return key;
    }
  }
  return "";
}

function resolveShipmentState(shipment) {
  const facts = shipmentStateFacts(shipment);
  const text = statusText(shipment);
  const pickupText = pickupExecutionText(shipment);
  const combinedFacts = facts.map((fact) => fact.text).join(" ");
  const arrivalFact = facts
    .filter((fact) =>
      hasActualArrivalEvidence(fact.text) &&
      !hasNegativeArrivalEvidence(fact.text) &&
      !factLooksGenericCanonicalArrival(fact.text) &&
      !factLooksUnreadableAttachmentNoise(fact.text) &&
      !(factLooksProofOnlyArrivalSummary(fact.text) && (hasRequestedArrivalEvidence(text) || hasHardNegativeArrivalEvidence(text))) &&
      !["current-state", "next-action"].includes(fact.source) &&
      !/\b(?:after|when|until|if)\b[^.;\n]{0,50}\b(?:station|carrier|airline)\b[^.;\n]{0,80}\b(?:confirms?|confirms? freight|available|on[-\s]?hand)\b/i.test(fact.text)
    )
    .sort((a, b) => b.time - a.time)[0] || null;
  const pickedUpFact = latestFact(
    facts.filter((fact) => (!PICKUP_NEGATIVE_PATTERN.test(fact.text) || PICKUP_COMPLETION_PATTERN.test(fact.text)) && !pickupArrangementOnlyText(fact.text)),
    PICKUP_COMPLETION_PATTERN,
  );
  const podReceivedFact = facts
    .filter((fact) =>
      POD_RECEIVED_PATTERN.test(fact.text) &&
      !POD_NEGATIVE_PATTERN.test(fact.text) &&
      !POD_PENDING_PATTERN.test(fact.text) &&
      !POD_REQUEST_PATTERN.test(fact.text) &&
      !PICKUP_NEGATIVE_PATTERN.test(fact.text)
    )
    .sort((a, b) => b.time - a.time)[0] || null;
  const deliveredFact = facts
    .filter((fact) =>
      (DELIVERY_REPORTED_PATTERN.test(fact.text) || /\b(?:delivered-reported|delivery (?:was )?reported)\b/i.test(fact.text)) &&
      !hasFutureOrConditionalDeliveryEvidence(fact.text) &&
      !stationPaymentDeliveryOnlyText(fact.text)
    )
    .sort((a, b) => b.time - a.time)[0] || null;
  const podPendingFact = latestFact(facts, POD_PENDING_PATTERN);
  const releaseFact = latestFact(
    facts.filter((fact) => !factLooksNonFinalCustomsRelease(fact.text)),
    /\b(?:98\s+released|marked\s+released|release\s+\+\s+d\/?o|released by|cleared by|customs released|release\/do confirmed|release\/d\/?o attachment (?:is )?present|customs layer is resolved|do and ace|delivery order issued|(?:revised|corrected)\s*d\/?o[^.;\n]{0,140}(?:delivery order|carrier location|arr\/dept)|corrected do shows.*released)\b/i,
  );
  const releaseBlockerFact = latestFact(
    facts,
    /\b(?:not released|not cleared|release pending|clearance pending|station cannot see|cannot see release|does not see.*(?:release|d\/?o|delivery order)|wrong d\/?o|corrected d\/?o|do is wrong|delivery order.*wrong|driver standby|driver waiting|waiting on corrected d\/?o)\b/i,
  );
  const groundPaidFact = latestFact(
    facts.filter((fact) => !/\b(?:payment status not proven|not proven|not confirmed|unpaid|pending|due|verify)\b/i.test(fact.text)),
    /\b(?:ground fees?|station fees?|handling fees?|cargosprint|payment|receipt).{0,100}\b(?:paid|confirmed|receipt)\b|\b(?:paid|confirmed).{0,100}\b(?:ground fees?|station fees?|handling fees?|cargosprint|payment|receipt)\b/i,
  );
  const deliveryFact = latestFact(
    facts,
    /\b(?:deliver tomorrow|deliver today|delivery tomorrow|delivery today|will deliver|scheduled (?:for )?delivery|out for delivery|delivering today)\b/i,
  );
  const deliveryScheduledDate = deliveryFact ? deliveryDateFromText(deliveryFact.text, deliveryFact.at) : "";
  const todayKey = operatorDateKey(new Date());
  const preArrivalText = [
    shipment.arrivalStatus,
    shipment.stage,
    shipment.currentState,
    shipment.eta,
    text,
    combinedFacts,
  ].filter(Boolean).join(" ");
  const explicitPreArrival = !arrivalFact && hasNegativeArrivalEvidence(preArrivalText);
  const staleBlockerResolved =
    Boolean(pickedUpFact) &&
    Boolean(releaseBlockerFact) &&
    pickedUpFact.time >= releaseBlockerFact.time;
  const pickupBlockerText = releaseBlockerFact?.text || "";
  const releaseVisibilityBlocker = /\b(?:station|airport|carrier|airline|warehouse|agent|terminal)\b[^.;\n]{0,100}\b(?:not|does not|doesn'?t|cannot|can'?t|won'?t|will not|refus(?:e|ed|ing))\b[^.;\n]{0,100}\b(?:see|show|have|find|release|clearance|clear|d\/?o|delivery order)\b|\b(?:release|clearance|customs release|d\/?o|delivery order)[^.;\n]{0,100}\b(?:not|isn'?t|is not|does not|doesn'?t|cannot|can'?t|missing|pending)[^.;\n]{0,70}\b(?:system|visible|show|showing|seen|found|available|accepted|released|cleared)\b|\b(?:wrong|incorrect|bad|invalid|missing|corrected|reissue|resend|re-send|driver name)\b[^.;\n]{0,100}\b(?:d\/?o|delivery order)\b|\b(?:d\/?o|delivery order)\b[^.;\n]{0,100}\b(?:wrong|incorrect|bad|invalid|missing|corrected|reissue|resend|re-send|driver name)\b/i.test(pickupBlockerText);
  const activePickupBlocker =
    Boolean(releaseBlockerFact) &&
    !staleBlockerResolved &&
    !deliveredFact &&
    releaseVisibilityBlocker &&
    /\b(?:driver|station|airport|carrier|airline|warehouse|terminal|d\/?o|delivery order)\b/i.test(pickupBlockerText) &&
    /\b(?:waiting|standby|onsite|on[-\s]?site|cannot see|does not see|wrong|corrected|missing|blocked|not loaded|refused)\b/i.test(pickupBlockerText);
  const driverOnsiteFact = latestFact(
    facts,
    /\b(?:driver|truck|trucker)\b[^.;\n]{0,100}\b(?:on[-\s]?site|at (?:airport|station|warehouse|pickup)|checked[-\s]?in|waiting|standby|sitting|detention|cannot pickup|can'?t pickup|pickup blocked|not loaded|loading blocked|refused (?:to )?(?:load|pickup))\b/i,
  );
  const activeDriverOnsite =
    Boolean(driverOnsiteFact) &&
    !pickedUpFact &&
    !deliveredFact &&
    !/\b(?:not arrived|pending arrival|no arrival proof)\b/i.test(combinedFacts);
  return {
    facts,
    arrived: !explicitPreArrival && (Boolean(arrivalFact) || hasStrongArrivalEvidence(shipment)),
    arrivedAt: arrivalFact?.at || shipment.arrivedAt || "",
    customsReleased: Boolean(releaseFact),
    customsReleasedAt: releaseFact?.at || "",
    groundPaid: Boolean(groundPaidFact),
    groundPaidAt: groundPaidFact?.at || "",
    pickedUp: !hasPickupBlockingText(pickupText) &&
      (Boolean(pickedUpFact) || ((!PICKUP_NEGATIVE_PATTERN.test(pickupText) || PICKUP_COMPLETION_PATTERN.test(pickupText)) && PICKUP_COMPLETION_PATTERN.test(pickupText))),
    pickedUpAt: pickedUpFact?.at || "",
    delivered: Boolean(deliveredFact || podReceivedFact),
    deliveredAt: (podReceivedFact || deliveredFact)?.at || shipment.pod?.deliveredAt || shipment.completion?.deliveredAt || "",
    podReceived: Boolean(podReceivedFact),
    podPending: Boolean(podPendingFact || (deliveredFact && !podReceivedFact)),
    podPendingFact: podPendingFact || (!podReceivedFact ? deliveredFact : null),
    deliveryScheduledDate,
    deliveryScheduledToday: Boolean(deliveryScheduledDate && deliveryScheduledDate === todayKey),
    deliveryScheduledFact: deliveryFact,
    activePickupBlocker,
    pickupBlockerFact: activePickupBlocker ? releaseBlockerFact : null,
    driverOnsite: activeDriverOnsite,
    driverOnsiteFact: activeDriverOnsite ? driverOnsiteFact : null,
    latestPickupFact: pickedUpFact,
  };
}

function shipmentId(shipment) {
  return shipment.id || shipment.shipmentId || shipment.awb || normalizeAwb(shipment.awb);
}

function hasContactValue(contact) {
  return Boolean(contact && Object.values(contact).some((value) => String(value || "").trim()));
}

function mergeContactGroups(existing = {}, incoming = {}) {
  const merged = { ...(existing || {}) };
  for (const key of new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})])) {
    const current = existing?.[key];
    const next = incoming?.[key];
    if (!hasContactValue(next)) {
      if (hasContactValue(current)) merged[key] = current;
      continue;
    }
    merged[key] = {
      ...(hasContactValue(current) ? current : {}),
      ...next,
    };
  }
  return merged;
}

function mergeCustomsBrokerContact(existingBroker = null, incomingBroker = null, contacts = {}) {
  const contact = contacts?.customs || {};
  const merged = {
    ...(existingBroker || {}),
    ...(incomingBroker || {}),
  };
  const existingBrokerStatus = String(existingBroker?.brokerStatus || "").trim();
  const incomingBrokerStatus = String(incomingBroker?.brokerStatus || "").trim();
  if (
    existingBrokerStatus &&
    incomingBrokerStatus &&
    !releaseEvidenceRowIsStatusOnly(existingBrokerStatus) &&
    releaseEvidenceRowIsStatusOnly(incomingBrokerStatus)
  ) {
    merged.brokerStatus = existingBrokerStatus;
  }
  const contactBrokerName = contact.broker || contact.name || contact.contactName || "";
  const contactBrokerEmail = contact.email || contact.contactEmail || contact.stationEmail || "";
  const contactBrokerPhone = contact.phone || contact.contactPhone || "";
  if (!merged.broker && contactBrokerName) merged.broker = contactBrokerName;
  if (!merged.contactName && contactBrokerName) merged.contactName = contactBrokerName;
  if (!merged.contactEmail && contactBrokerEmail) merged.contactEmail = contactBrokerEmail;
  if (!merged.email && contactBrokerEmail) merged.email = contactBrokerEmail;
  if (!merged.contactPhone && contactBrokerPhone) merged.contactPhone = contactBrokerPhone;
  if (!merged.phone && contactBrokerPhone) merged.phone = contactBrokerPhone;
  if (!merged.status && contact.status) merged.status = contact.status;
  if (!merged.brokerStatus && contact.brokerStatus) merged.brokerStatus = contact.brokerStatus;
  return Object.keys(merged).length ? merged : null;
}

function customsBrokerStatusResolved(value) {
  const status = String(value || "");
  return explicitCustomsStatusLooksReleased(status) ||
    /\b(?:customs[-_\s]?released|customs[-_\s]?cleared|release\/?d\.?o confirmed|release\/?do confirmed|released|cleared)\b/i.test(status);
}

function canonicalReleaseBlockerLooksSpecific(phase, customsStatus, value) {
  const text = String(value || "");
  if (["customs-hold"].includes(phase)) return true;
  if (["blocked", "customs-hold", "hold", "exam-hold"].includes(customsStatus) && !/^(?:blocked|hold|pending|waiting|missing|unknown)$/i.test(text.trim())) return true;
  return /\b(?:not released|no release|release\/?d\.?o (?:is )?(?:not|missing|pending|needed)|release\/?do (?:is )?(?:not|missing|pending|needed)|customs hold|government hold|exam hold|inbond rejected|in-bond rejected|rejected|hold remains|current email|broker says|thread says|email says)\b/i.test(text);
}

function unsupportedCustomsGateText(value) {
  const text = String(value || "");
  return factLooksUnreadableAttachmentNoise(text) ||
    generatedCustomsHoldSummaryWithoutSourceText(text) ||
    /\bcustoms hold in control-room inventory\b/i.test(text);
}

function sanitizeUnsupportedCustomsGate(shipment = {}) {
  const customsGate = shipment.opsState?.gates?.customs;
  if (!customsGate || !["blocked", "customs-hold", "hold", "exam-hold"].includes(String(customsGate.status || "").toLowerCase())) {
    return shipment;
  }
  const gateText = [
    customsGate.status,
    customsGate.summary,
    customsGate.evidence,
    ...(shipment.opsState?.events || [])
      .filter((event) => /customs|release|clearance|hold|exam/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map(factRowText),
  ].filter(Boolean).join(" ");
  if (!unsupportedCustomsGateText(gateText)) return shipment;
  return {
    ...shipment,
    opsState: {
      ...shipment.opsState,
      gates: {
        ...(shipment.opsState?.gates || {}),
        customs: {
          ...customsGate,
          status: "pending",
          evidence: "Release/DO is not confirmed yet.",
          source: customsGate.source || "shipment-state-sanity",
        },
      },
    },
  };
}

function reconcileCustomsBrokerWithCanonicalState(shipment = {}) {
  shipment = sanitizeUnsupportedCustomsGate(shipment);
  const broker = shipment.customsBroker;
  if (!broker) return shipment;
  const phase = String(shipment.opsState?.phase || shipment.phase || "").toLowerCase();
  const customsGate = shipment.opsState?.gates?.customs || {};
  const customsStatus = String(customsGate.status || "").toLowerCase();
  const customsEvidence = String(customsGate.evidence || shipment.opsState?.summary || "").trim();
  const topLevelNextAction = String(shipment.opsState?.nextAction || shipment.nextAction || "").trim();
  const completed = Boolean(
    shipment.completed ||
      ["delivered", "completed"].includes(phase) ||
      ["done", "received", "pod-found", "found"].includes(String(shipment.opsState?.gates?.pod?.status || "").toLowerCase()),
  );

  const staleBrokerWorkText = [broker.brokerStatus, broker.nextAction]
    .filter(Boolean)
    .join(" ");
  if (completed && (!customsBrokerStatusResolved(broker.status) || /find|missing|unknown|pending|not released|no release|confirm release|release\/?d\.?o/i.test(staleBrokerWorkText))) {
    return {
      ...shipment,
      customsBroker: {
        ...broker,
        status: customsBrokerStatusResolved(broker.status) ? broker.status : "execution-complete",
        brokerStatus: broker.brokerStatus && !/find|missing|unknown|pending/i.test(broker.brokerStatus)
          ? broker.brokerStatus
          : "Execution reached delivered/POD; no active customs action.",
        nextAction: "No customs action; shipment delivered/POD is in memory.",
      },
    };
  }

  const releaseBlockedByCanonicalState =
    ["release-needed", "customs-hold"].includes(phase) ||
    ["blocked", "pending", "waiting", "missing"].includes(customsStatus);
  const staleBrokerHold =
    phase === "pre-arrival" &&
    ["pending", "waiting", "unknown"].includes(customsStatus) &&
    /\b(?:customs[-_\s]?hold|exam[-_\s]?hold|blocked|hold)\b/i.test(`${broker.status || ""} ${broker.brokerStatus || ""} ${broker.nextAction || ""}`);
  if (!releaseBlockedByCanonicalState && !staleBrokerHold) return shipment;
  if (!staleBrokerHold && !customsBrokerStatusResolved(broker.status)) return shipment;
  if (
    !staleBrokerHold &&
    customsBrokerStatusResolved(broker.status) &&
    !canonicalReleaseBlockerLooksSpecific(phase, customsStatus, `${customsEvidence} ${topLevelNextAction}`)
  ) {
    return shipment;
  }

  const hold = phase === "customs-hold" || ["blocked", "customs-hold", "hold", "exam-hold"].includes(customsStatus);
  const nextAction = topLevelNextAction ||
    (hold ? "Monitor customs hold; do not dispatch pickup until release/DO is visible." : "Confirm release/DO before dispatch.");
  return {
    ...shipment,
    customsBroker: {
      ...broker,
      status: hold ? "customs-hold" : "customs-pending",
      brokerStatus: customsEvidence || (hold ? "Customs hold remains unresolved." : "Release/DO still needs confirmation."),
      nextAction,
      evidence: unique([
        ...((broker.evidence || []).map(factRowText)),
        customsEvidence,
        topLevelNextAction,
      ].filter(Boolean)),
    },
  };
}

function strongerArrivalStatus(existing, incoming) {
  const rank = (value) => {
    const text = String(value || "").toLowerCase().trim();
    if (/^(?:arrived|available|on[-\s]?hand|ready|done)$/.test(text)) return 3;
    if (/^(?:incomplete|partial|blocked)$/.test(text)) return 2;
    if (/^(?:not[-\s]?arrived|pending|waiting|missing|unknown)$/.test(text)) return 1;
    return text ? 1 : 0;
  };
  return rank(existing) > rank(incoming) ? existing : incoming || existing || "";
}

function strongerClearanceStatus(existing, incoming) {
  const rank = (value) => {
    const text = String(value || "").toLowerCase().trim();
    if (/^(?:not[-\s]?cleared|hold|customs-hold|exam-hold|blocked)$/.test(text)) return 4;
    if (/^(?:released|cleared|done)$/.test(text)) return 3;
    if (/^(?:pending|waiting|missing|unknown)$/.test(text)) return 1;
    return text ? 1 : 0;
  };
  return rank(existing) > rank(incoming) ? existing : incoming || existing || "";
}

function strongerPickupStatus(existing, incoming) {
  const rank = (value) => {
    const text = String(value || "").toLowerCase().trim();
    if (/^(?:delivered|picked[-\s]?up|loaded|recovered|done)$/.test(text)) return 4;
    if (/^(?:blocked|driver-onsite|onsite|waiting)$/.test(text)) return 3;
    if (/^(?:scheduled|planned|ready|pending)$/.test(text)) return 2;
    if (/^(?:unknown|missing)$/.test(text)) return 1;
    return text ? 1 : 0;
  };
  return rank(existing) > rank(incoming) ? existing : incoming || existing || "";
}

function canonicalAnchorTime(shipment = {}) {
  return factTime(
    shipment.opsState?.latestEventAt ||
      shipment.opsState?.updatedAt ||
      shipment.emailValidation?.latestEventAt ||
      shipment.lastEmail?.at ||
      shipment.updatedAt,
  );
}

function rowAnchorTime(shipment = {}) {
  return factTime(
    shipment._mergeSourceSnapshotTime ||
      shipment.latestEventAt ||
      shipment.updatedAt ||
      shipment.emailValidation?.latestEventAt ||
      shipment.lastEmail?.at,
  );
}

function canonicalHasDecisiveAnchor(shipment = {}) {
  const text = [
    shipment.arrivalStatus,
    shipment.clearanceStatus,
    shipment.pickupStatus,
    shipment.stage,
    shipment.currentState,
    shipment.nextAction,
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    ...(shipment.facts || []).map(factRowText),
  ].filter(Boolean).join(" ");
  return /\b(?:not[-\s]?arrived|pre[-\s]?arrival|in[-\s]?transit|departed|scheduled arrival|arrival .*requested, not|no station|picked[-\s]?up|loaded|recovered|delivered|pod[-\s]?(?:needed|pending|found|received)|(?:driver|pickup)[-\s]?onsite|customs hold|pickup blocked)\b/i.test(text);
}

function canonicalGateStatus(shipment = {}, gateName = "") {
  return String(shipment.opsState?.gates?.[gateName]?.status || "").toLowerCase().trim();
}

function canonicalGatePromotesActiveState(shipment = {}) {
  if (shipment.opsState?.source !== "canonical-shipment-pipeline") return false;
  const phase = String(shipment.opsState?.phase || "").toLowerCase().trim();
  const arrival = canonicalGateStatus(shipment, "arrival");
  const customs = canonicalGateStatus(shipment, "customs");
  const pickup = canonicalGateStatus(shipment, "pickup");
  const delivery = canonicalGateStatus(shipment, "delivery");
  const pod = canonicalGateStatus(shipment, "pod");
  const finalPod = ["delivered", "completed"].includes(phase) ||
    ["done", "received", "pod-found", "found"].includes(pod);
  if (finalPod) return true;
  if (["scheduled", "planned", "deferred"].includes(pickup)) return true;
  const unsafeHistoricalGate =
    ["customs-hold", "hold", "exam-hold", "blocked"].includes(customs) ||
    ["picked-up", "loaded", "done", "inferred", "blocked", "onsite"].includes(pickup) ||
    ["delivered", "reported", "done", "completed"].includes(delivery) ||
    ["pending", "missing", "needed"].includes(pod);
  if (unsafeHistoricalGate) return false;
  return (
    ["released", "cleared", "done"].includes(customs) ||
    ["arrived", "available", "on-hand", "done", "inferred"].includes(arrival) ||
    ["in-transit", "pre-arrival"].includes(phase)
  );
}

function activeContextForCanonicalPromotion(existing = {}, shipment = {}) {
  if (!existing?._activeAuthoritative || shipment.opsState?.source !== "canonical-shipment-pipeline") return {};
  return {
    id: shipment.id || existing.id || "",
    station: shipment.station || existing.station || "",
    airline: shipment.airline || existing.airline || "",
    client: shipment.client || existing.client || "",
    consignee: shipment.consignee || existing.consignee || "",
    eta: shipment.eta || existing.eta || "",
    detail: shipment.detail || existing.detail || "",
    tms: { ...(existing.tms || {}), ...(shipment.tms || {}) },
    timeline: (shipment.timeline || []).length ? shipment.timeline : existing.timeline,
    delivery: { ...(existing.delivery || {}), ...(shipment.delivery || {}) },
    handler: shipment.handler || existing.handler || "",
    stationEmail: shipment.stationEmail || existing.stationEmail || "",
    stationPhone: shipment.stationPhone || existing.stationPhone || "",
    sources: unique([...(existing.sources || []), ...(shipment.sources || [])]),
  };
}

function shouldPreserveActiveAnchors(existing, incoming) {
  if (!existing) return false;
  if (incoming?.opsState?.source === "canonical-shipment-pipeline") return false;
  if (existing?._activeAuthoritative && canonicalGatePromotesActiveState(incoming)) return false;
  const incomingTime = canonicalAnchorTime(incoming);
  const existingTime = rowAnchorTime(existing);
  if (existingTime && (!incomingTime || existingTime >= incomingTime)) return true;
  return !canonicalHasDecisiveAnchor(incoming);
}

function shouldCarryActiveAuthority(existing, shipment, activeIncoming, canonicalPipelineIncoming, preserveActiveAnchor) {
  if (activeIncoming) return true;
  if (canonicalPipelineIncoming) return Boolean(preserveActiveAnchor && existing?._activeAuthoritative);
  return Boolean(existing?._activeAuthoritative || shipment?._activeAuthoritative);
}

function mergeShipments(memory, options = {}) {
  const attachPackets = options.attachPackets !== false;
  if (memory && typeof memory === "object") {
    const cached = mergedShipmentsCache.get(memory)?.[attachPackets ? "rich" : "light"];
    if (cached) return cached;
  }
  const rows = [];
  const companionContextByAwb = new Map();
  for (const [field, entries] of Object.entries({
    operatorNotes: memory.companionMemory?.operatorNotes || [],
    resolvedConflicts: memory.companionMemory?.resolvedConflicts || [],
    alertStates: memory.companionMemory?.alertStates || [],
  })) {
    for (const entry of entries) {
      const key = normalizeAwbFrom(entry?.awb, entry?.shipmentAwb, entry?.shipmentId, entry?.text, entry?.summary);
      if (!key) continue;
      const current = companionContextByAwb.get(key) || { operatorNotes: [], resolvedConflicts: [], alertStates: [] };
      current[field].push(entry);
      companionContextByAwb.set(key, current);
    }
  }
  const withCompanionContext = (shipment) => {
    const key = normalizeAwb(shipment?.awb || shipment?.id || "");
    const companionContext = companionContextByAwb.get(key);
    if (!companionContext) return shipment;
    return {
      ...shipment,
      companionContext: {
        source: memory.companionMemory?.source || "operator-companion-memory",
        snapshotTime: memory.companionMemory?.snapshotTime || "",
        contextOnly: true,
        ...companionContext,
      },
    };
  };
  const add = (shipment, completed = false, mergeSource = "", sourceSnapshotTime = "") => {
    const awb = displayAwb(shipment?.awb || shipment?.trackingNumber || shipment?.id || shipment?.shipmentId || "");
    if (!awb) return;
    rows.push({
      ...shipment,
      awb,
      id: displayAwb(shipment.id || shipment.shipmentId || shipment.awb || shipment.trackingNumber) || shipmentId({ ...shipment, awb }),
      _mergeSource: mergeSource,
      _mergeSourceSnapshotTime: sourceSnapshotTime || shipment?._mergeSourceSnapshotTime || "",
      completed: completed || shipment.completed || shipment.opsState?.phase === "completed",
    });
  };
  (memory.brain?.shipments || []).forEach((shipment) => add(withCompanionContext(shipment), shipment.completed, "brain-active", memory.brain?.snapshotTime || ""));
  (memory.brain?.completed || []).forEach((shipment) => add(shipment, true, "brain-completed", memory.brain?.snapshotTime || ""));
  (memory.truthPackets?.shipments || []).forEach((shipment) => add(withCompanionContext(shipment), shipment.completed, "truth-packet", memory.truthPackets?.snapshotTime || ""));

  const byAwb = new Map();
  for (const shipment of rows) {
    const key = normalizeAwb(shipment.awb);
    const existing = byAwb.get(key);
    const truthPacketIncoming = shipment._mergeSource === "truth-packet";
    const canonicalIncoming = Boolean(shipment.opsState?.gates);
    const canonicalPipelineIncoming = shipment.opsState?.source === "canonical-shipment-pipeline" && !truthPacketIncoming;
    const activeIncoming = shipment._mergeSource === "active";
    const preserveActiveAnchor = canonicalPipelineIncoming && shouldPreserveActiveAnchors(existing, shipment);
    const activeAuthoritative = shouldCarryActiveAuthority(
      existing,
      shipment,
      activeIncoming,
      canonicalPipelineIncoming,
      preserveActiveAnchor,
    );
    const keepExistingActiveState = Boolean(preserveActiveAnchor && existing?._activeAuthoritative);
    const activeAnchor = preserveActiveAnchor ? {
      arrivalStatus: keepExistingActiveState ? existing.arrivalStatus : strongerArrivalStatus(existing.arrivalStatus, shipment.arrivalStatus),
      clearanceStatus: keepExistingActiveState ? existing.clearanceStatus : strongerClearanceStatus(existing.clearanceStatus, shipment.clearanceStatus),
      pickupStatus: keepExistingActiveState ? existing.pickupStatus : strongerPickupStatus(existing.pickupStatus, shipment.pickupStatus),
      stage: existing.stage || shipment.stage || "",
      currentState: existing.currentState || shipment.currentState || "",
      nextAction: existing.nextAction || shipment.nextAction || "",
      opsState: existing.opsState || shipment.opsState || null,
      customsBroker: existing.customsBroker || shipment.customsBroker || null,
      freightBroker: existing.freightBroker || shipment.freightBroker || null,
      detail: shipment.detail || existing.detail || "",
      tms: { ...(shipment.tms || {}), ...(existing.tms || {}) },
      timeline: (shipment.timeline || []).length ? shipment.timeline : existing.timeline,
      delivery: { ...(shipment.delivery || {}), ...(existing.delivery || {}) },
      handler: shipment.handler || existing.handler || "",
      stationEmail: shipment.stationEmail || existing.stationEmail || "",
      stationPhone: shipment.stationPhone || existing.stationPhone || "",
      sources: unique([...(existing.sources || []), ...(shipment.sources || [])]),
    } : {};
    const mergedContacts = mergeContactGroups(existing?.contacts, shipment.contacts);
    const mergedCustomsBroker = mergeCustomsBrokerContact(
      existing?.customsBroker,
      activeAnchor.customsBroker || shipment.customsBroker,
      mergedContacts,
    );
    const activePromotionContext = !preserveActiveAnchor
      ? activeContextForCanonicalPromotion(existing, shipment)
      : {};
    const truthPacketSourceGates = shipment.opsState?.gates || shipment.gates || {};
    const truthPacketGates = Object.fromEntries(Object.entries(truthPacketSourceGates).map(([name, gate]) => {
      const status = String(gate?.status || "").toLowerCase();
      return [
        name,
        {
          ...(gate || {}),
          status: name === "pod" && ["received", "pod-found", "found"].includes(status) ? "done" : gate?.status,
        },
      ];
    }));
    const truthPacketGateStatus = (gateName) => String(truthPacketGates?.[gateName]?.status || "").toLowerCase();
    const truthPacketFieldReset = truthPacketIncoming
      ? {
          currentState: shipment.currentState || shipment.summary || shipment.opsState?.summary || shipment.phase || "",
          nextAction: shipment.nextAction || shipment.opsState?.nextAction || "",
          arrivalStatus: shipment.arrivalStatus || (["done", "arrived"].includes(truthPacketGateStatus("arrival")) ? "arrived" : ""),
          clearanceStatus: shipment.clearanceStatus || (["done", "released", "cleared"].includes(truthPacketGateStatus("customs")) ? "released" : ""),
          pickupStatus: shipment.pickupStatus || (["done", "picked-up", "airport-picked-up"].includes(truthPacketGateStatus("pickup")) ? "airport-picked-up" : truthPacketGateStatus("pickup")),
          deliveryStatus: shipment.deliveryStatus || (["done", "delivered"].includes(truthPacketGateStatus("delivery")) ? "delivered" : truthPacketGateStatus("delivery")),
          opsState: shipment.opsState
            ? { ...shipment.opsState, gates: truthPacketGates }
            : (shipment.phase || shipment.gates
              ? {
                phase: shipment.phase || "",
                label: shipment.currentState || shipment.phase || "",
                summary: shipment.currentState || shipment.summary || "",
                nextAction: shipment.nextAction || "",
                gates: truthPacketGates,
                source: shipment._truthPacketSource || "shipment-truth-packets",
                updatedAt: shipment.updatedAt || shipment.latestEventAt || "",
              }
              : null),
        }
      : {};
    const mergedShipment = {
      ...(existing || {}),
      ...shipment,
      ...activePromotionContext,
      ...activeAnchor,
      ...truthPacketFieldReset,
      customsBroker: mergedCustomsBroker,
      _activeAuthoritative: activeAuthoritative,
      facts: canonicalPipelineIncoming
        ? uniqueFactRows(preserveActiveAnchor ? existing?.facts || [] : shipment.facts || [])
        : truthPacketIncoming
          ? uniqueFactRows(shipment.facts || [])
        : uniqueFactRows([...(existing?.facts || []), ...(shipment.facts || [])]),
      factLedger: canonicalPipelineIncoming
        ? uniqueFactRows(preserveActiveAnchor ? existing?.factLedger || [] : shipment.factLedger || [])
        : truthPacketIncoming
          ? uniqueFactRows(shipment.factLedger || [])
        : uniqueFactRows([...(existing?.factLedger || []), ...(shipment.factLedger || [])]),
      operatorNotes: uniqueFactRows([...(existing?.operatorNotes || []), ...(shipment.operatorNotes || [])]),
      completed: truthPacketIncoming ? Boolean(shipment.completed) : canonicalIncoming ? Boolean(shipment.completed) : existing?.completed || shipment.completed,
      emailValidation: truthPacketIncoming
        ? shipment.emailValidation || existing?.emailValidation
        : preserveActiveAnchor
        ? existing?.emailValidation || shipment.emailValidation
        : mergeEmailValidation(existing?.emailValidation, shipment.emailValidation),
      lastEmail: truthPacketIncoming
        ? shipment.lastEmail || existing?.lastEmail
        : preserveActiveAnchor
        ? existing?.lastEmail || shipment.lastEmail
        : canonicalPipelineIncoming ? shipment.lastEmail : newerEmail(existing?.lastEmail, shipment.lastEmail),
      contacts: mergedContacts,
      storage: truthPacketIncoming ? shipment.storage || null : shipment.storage || existing?.storage || null,
      pod: truthPacketIncoming ? shipment.pod || null : shipment.pod || existing?.pod || null,
    };
    byAwb.set(key, reconcileCustomsBrokerWithCanonicalState(mergedShipment));
  }
  for (const [key, threadFacts] of threadFactsByAwb(memory)) {
    const shipment = byAwb.get(key);
    if (!shipment) continue;
    if (shipment._mergeSource === "truth-packet") continue;
    const factRows = threadFacts.map((fact) => ({
      type: fact.type || "email",
      label: fact.label || "Thread memory",
      summary: fact.summary || fact.note || fact.evidence || "",
      threadId: fact.threadId || "",
      messageId: fact.messageId || "",
      at: fact.at || "",
      confidence: fact.confidence || "thread-memory",
    }));
    byAwb.set(key, {
      ...shipment,
      facts: uniqueFactRows([...(shipment.facts || []), ...factRows]),
      factLedger: uniqueFactRows([...(shipment.factLedger || []), ...factRows]),
    });
  }
  const merged = [...byAwb.values()];
  const result = attachPackets ? attachOperatorPackets(merged, memory) : merged;
  if (memory && typeof memory === "object") {
    const existing = mergedShipmentsCache.get(memory) || {};
    mergedShipmentsCache.set(memory, {
      ...existing,
      [attachPackets ? "rich" : "light"]: result,
    });
  }
  return result;
}

function currentActiveAwbSet(memory = {}) {
  const activeRows = Array.isArray(memory.truthPackets?.shipments)
    ? memory.truthPackets.shipments.filter((shipment) =>
        (!shipment.truthPacketRole || shipment.truthPacketRole === "active" || shipment.truthPacketRole === "completed") &&
          (!shipment.completed || completedDateKey(shipment) === operatorDateKey(new Date()))
      )
    : [];
  return new Set(activeRows
    .map((shipment) => normalizeAwb(shipment.awb || shipment.trackingNumber || shipment.id || shipment.shipmentId))
    .filter(Boolean));
}

function threadFactsByAwb(memory) {
  const byAwb = new Map();
  const threads = [...(memory.brain?.threads || []), ...(memory.threads || [])];
  const addFact = (awb, fact, thread) => {
    const key = normalizeAwb(awb);
    const summary = fact.summary || fact.note || fact.evidence || "";
    if (!key || !summary) return;
    const rows = byAwb.get(key) || [];
    rows.push({
      ...fact,
      threadId: fact.threadId || thread.threadId || thread.id || "",
      messageId: fact.messageId || "",
      at: fact.at || thread.latestAt || thread.updatedAt || "",
      summary,
    });
    byAwb.set(key, rows);
  };
  for (const thread of threads) {
    const awbs = new Set([
      ...(thread.awbs || []),
      ...(thread.shipmentIds || []),
      ...(thread.facts || []).map((fact) => fact.awb || fact.shipmentAwb || ""),
    ].map(normalizeAwb).filter(Boolean));
    if (!awbs.size) continue;
    const facts = [
      ...(thread.facts || []),
      ...(thread.unresolved || []).map((summary) => ({ type: "unresolved", label: "Thread unresolved", summary })),
      thread.summary ? { type: "thread-summary", label: thread.subject || "Thread summary", summary: thread.summary } : null,
    ].filter(Boolean);
    for (const awb of awbs) {
      for (const fact of facts) addFact(awb, fact, thread);
    }
  }
  return byAwb;
}

function mergeEmailValidation(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const incomingAt = Date.parse(incoming.latestEventAt || newestProofAt(incoming.proof));
  const existingAt = Date.parse(existing.latestEventAt || newestProofAt(existing.proof));
  const preferIncoming = Number.isFinite(incomingAt) && (!Number.isFinite(existingAt) || incomingAt >= existingAt);
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    ...secondary,
    ...primary,
    proof: uniqueProofRows([...(secondary.proof || []), ...(primary.proof || [])]),
    events: uniqueFactRows([...(secondary.events || []), ...(primary.events || [])]),
  };
}

function newestProofAt(proofs = []) {
  return (proofs || [])
    .map((proof) => proof.at || proof.date || "")
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

function uniqueProofRows(rows) {
  const seen = new Set();
  return (rows || []).filter((proof) => {
    const key = [
      proof.threadId || "",
      proof.messageId || "",
      proof.attachmentId || "",
      proof.filename || "",
      proof.label || "",
      proof.note || proof.evidence || proof.summary || "",
    ].join("|").toLowerCase();
    if (!key.replace(/\|/g, "").trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function newerEmail(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const incomingAt = Date.parse(incoming.at || "");
  const existingAt = Date.parse(existing.at || "");
  return Number.isFinite(incomingAt) && (!Number.isFinite(existingAt) || incomingAt >= existingAt) ? incoming : existing;
}

function uniqueFactRows(rows) {
  const seen = new Set();
  return rows.filter((fact) => {
    const key = `${fact.type || ""}|${fact.label || ""}|${fact.summary || fact.note || ""}`.toLowerCase();
    if (!key.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findShipment(memory, question, options = {}) {
  const key = normalizeAwb(question);
  if (!key) return null;
  const shipments = Array.isArray(options.shipments)
    ? options.shipments
    : mergeShipments(memory, { attachPackets: options.attachPackets !== false });
  return shipments.find((shipment) => normalizeAwb(shipment.awb) === key || normalizeAwb(shipment.id) === key) || null;
}

function findShipmentByAwb(shipments, awb) {
  const key = normalizeAwb(awb);
  if (!key) return null;
  return shipments.find((shipment) => normalizeAwb(shipment.awb) === key || normalizeAwb(shipment.id) === key) || null;
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return [
    message.role,
    message.title,
    message.subtitle,
    message.content,
    message.answer,
    ...(message.items || []).map((item) => `${item.awb || ""} ${item.action || ""} ${item.context || ""}`),
  ].filter(Boolean).join(" ");
}

function contactRoleFromText(value = "") {
  const text = String(value || "").toLowerCase();
  if (/\b(?:customs broker|customs contact|broker for customs|release contact|clearance contact|customs phone|customs email|release phone|release email|clearance phone|clearance email)\b/.test(text)) return "customs";
  if (/\b(?:station contact|station phone|station email|station details|cargo station|terminal contact|terminal phone|warehouse contact)\b/.test(text)) return "station";
  if (/\b(?:pickup broker|pickup contact|truck(?:er)? contact|driver contact|driver phone|pickup phone|delivery broker|delivery contact|pod contact|quote broker|selected broker)\b/.test(text)) return "pickup";
  if (/\bcustoms\b|\brelease\b|\bclearance\b|\bd\/?o\b|\bdelivery order\b/.test(text)) return "customs";
  if (/\bstation\b|\bterminal\b|\bwarehouse\b/.test(text)) return "station";
  if (/\bpickup\b|\bdriver\b|\btruck(?:er)?\b|\bpod\b|\bdelivery\b|\bquote\b|\bnorman\b/.test(text)) return "pickup";
  return "";
}

function contactRoleFromHistory(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    const contextRole = contactRoleFromText(message.context?.contactRole || message.context?.role || "");
    if (contextRole) return contextRole;
    const topicRole = contactRoleFromText(message.context?.topic || "");
    if (topicRole) return topicRole;
    const textRole = contactRoleFromText(messageText(message));
    if (textRole) return textRole;
  }
  return "";
}

function contextFromHistory(history, shipments, context = {}) {
  const messages = Array.isArray(history) ? history : [];
  const contactRole = contactRoleFromText(context?.contactRole || context?.role || "") || contactRoleFromHistory(messages);
  const directContextAwb = context?.awb || "";
  const directShipmentId = !context?.list && Array.isArray(context?.shipmentIds) ? context.shipmentIds.find(Boolean) : "";
  const directShipment =
    findShipmentByAwb(shipments, directContextAwb) ||
    findShipmentByAwb(shipments, directShipmentId);
  if (directShipment) {
    return {
      shipment: directShipment,
      awb: normalizeAwb(directShipment.awb),
      station: directShipment.station || context.station || "",
      topic: context.topic || "",
      contactRole,
    };
  }
  if (context?.station) {
    return {
      shipment: null,
      awb: "",
      station: String(context.station || "").toUpperCase(),
      topic: context.topic || "",
      contactRole,
    };
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] || {};
    const contextShipmentIds = Array.isArray(message.context?.shipmentIds) ? message.context.shipmentIds : [];
    const messageShipmentIds = Array.isArray(message.shipmentIds) ? message.shipmentIds : [];
    const listShipmentIds = unique([...contextShipmentIds, ...messageShipmentIds].map(normalizeAwb).filter(Boolean));
    if ((message.context?.list || listShipmentIds.length > 1) && listShipmentIds.length) {
      const listShipments = listShipmentIds.map((awb) => findShipmentByAwb(shipments, awb)).filter(Boolean);
      if (listShipments.length) {
        return {
          shipment: null,
          awb: "",
          station: message.context?.station || "",
          topic: message.context?.topic || "",
          contactRole,
          list: true,
          listShipments,
          shipmentIds: listShipments.map((shipment) => normalizeAwb(shipment.awb)),
          dateWindow: message.context?.dateWindow || null,
        };
      }
    }
    const contextAwb = message.context?.awb || message.awb || "";
    const shipmentId = (message.shipmentIds || []).find(Boolean) || "";
    const textAwb = normalizeAwb(messageText(message));
    const shipment =
      findShipmentByAwb(shipments, contextAwb) ||
      findShipmentByAwb(shipments, shipmentId) ||
      findShipmentByAwb(shipments, textAwb);
    if (shipment) {
      return {
        shipment,
        awb: normalizeAwb(shipment.awb),
        station: shipment.station || message.context?.station || "",
        topic: message.context?.topic || "",
        contactRole,
      };
    }
    if (message.context?.station) {
      return {
        shipment: null,
        awb: "",
        station: String(message.context.station || "").toUpperCase(),
        topic: message.context.topic || "",
        contactRole,
      };
    }
  }
  return { shipment: null, awb: "", station: "", topic: "", contactRole };
}

function operatorFactsFromText(text, awb, at = new Date().toISOString()) {
  return uniqueFactRows(durableOperatorFactsFromText(text, awb, at));
}

function isOperatorUpdateText(text) {
  return durableIsOperatorUpdateText(text);
}

function operatorUpdateIntent(question, history, memory, context = {}) {
  // A request to DRAFT something is never an operator state note — "draft a
  // customer update" must reach the drafting layer, not become memory.
  if (/\bdraft\b|\bwrite (?:me )?(?:a|an|the)\b/i.test(String(question || ""))) return null;
  // Interrogative / listing questions are QUERIES, not truth-change attempts.
  // "which update requests went unanswered", "what's outstanding" must reach the
  // router / coverage, not the protected-truth refusal. Only imperative or
  // declarative truth ASSERTIONS ("016… is delivered", "mark … picked up") are
  // guarded — those never lead with an interrogative and never carry these
  // waiting/unanswered query terms, so real truth changes stay protected.
  const questionText = String(question || "");
  if (
    /^\s*(?:which(?:\s+of)?|what|who|whose|how\s+many|how\s+long|when|where|why|is\s+there|are\s+there|any\b|list|show|do\s+we|are\s+we|have\s+we|has\s+any)\b/i.test(questionText) ||
    /\b(?:unanswered|unreplied|outstanding|unfulfilled|went\s+unanswered|no\s+reply|without\s+(?:a\s+)?reply|awaiting\s+(?:a\s+)?reply|still\s+waiting)\b/i.test(questionText)
  ) {
    return null;
  }
  const shipments = mergeShipments(memory, { attachPackets: false });
  const explicitAwb = normalizeAwb(question);
  const historyContext = contextFromHistory(history, shipments, context);
  const awb = explicitAwb || historyContext.awb || "";
  const update = classifyOperatorUpdate(question, { awb, station: historyContext.station });
  if (update.kind === "operator-update") return update;
  if (update.kind === "needs-awb") return update;
  return null;
}

function withOperatorNotes(memory, history = [], question = "", context = {}) {
  const messages = [
    ...(Array.isArray(history) ? history.filter((message) => message?.role === "user").map((message) => message.content || "") : []),
    question,
  ];
  const operatorMessages = messages.filter(isOperatorUpdateText);
  if (!operatorMessages.length) return memory;
  const cloned = JSON.parse(JSON.stringify(memory || {}));
  const shipments = mergeShipments(cloned, { attachPackets: false });
  const historyContext = contextFromHistory(history, shipments, context);
  const notesByAwb = new Map();
  for (const message of operatorMessages) {
    const explicitAwb = normalizeAwb(message);
    const awb = explicitAwb || historyContext.awb || "";
    const facts = operatorFactsFromText(message, awb);
    if (!facts.length) continue;
    notesByAwb.set(awb, uniqueFactRows([...(notesByAwb.get(awb) || []), ...facts]));
  }
  if (!notesByAwb.size) return cloned;
  const apply = (shipment) => {
    const key = normalizeAwb(shipment?.awb || shipment?.id || "");
    const facts = notesByAwb.get(key);
    if (!facts?.length) return shipment;
    return {
      ...shipment,
      facts: uniqueFactRows([...(shipment.facts || []), ...facts]),
      operatorNotes: uniqueFactRows([...(shipment.operatorNotes || []), ...facts]),
      lastEmail: shipment.lastEmail || { summary: facts[0].summary, at: facts[0].at },
    };
  };
  cloned.brain = {
    ...(cloned.brain || {}),
    shipments: (cloned.brain?.shipments || []).map(apply),
    completed: (cloned.brain?.completed || []).map(apply),
  };
  cloned.truthPackets = {
    ...(cloned.truthPackets || {}),
    shipments: (cloned.truthPackets?.shipments || []).map(apply),
  };
  mergedShipmentsCache.delete(cloned);
  return cloned;
}

function factLooksObsolete(text) {
  return /\b(?:older|earlier|stale|previous|overridden|superseded|resolved by|now shows|current(?:ly)? shows)\b/i.test(String(text || ""));
}

function hasOperatorConflictResolution(shipment) {
  return (shipment.operatorNotes || []).some((note) => {
    const text = factRowText(note);
    return note.purpose === "conflict-resolution" ||
      /\b(?:actually|correction|correct|treat|use this|ignore previous|resolved?|not delivered|not arrived|not picked up|wrong)\b/i.test(text);
  });
}

function factLooksConditionalArrival(text) {
  return /\b(?:after|when|once|if|until|before|wait(?:ing)? for)\b[^.;\n]{0,100}\b(?:arrival|arrived|on[-\s]?hand|available|station confirms?|station confirmed)\b/i.test(String(text || ""));
}

function factLooksTimelineArrivalUpdate(text) {
  return /\b(?:then|now|later|afterward|afterwards|subsequently)\b[^.;\n]{0,100}\b(?:confirmed arrived|confirms? arrival|arrived|arrival notice|notice of arrival|on[-\s]?hand|available)\b/i.test(String(text || ""));
}

function factLooksUnreadableAttachmentNoise(text) {
  const value = String(text || "");
  return /\b(?:canon i[ r-]*adv|read_attachment_supported=false|no embedded text|visual\/ocr extraction did not reliably confirm|attachment listed by gmail|returned page images|pdf[-\s]?unreadable|unreadable\/binary|text extraction was unreadable|without OCR\/manual review)\b/i.test(value) ||
    (
      /\b(?:customs hold pdf|customs\/release still blocking|appears to be on a true customs\/government hold)\b/i.test(value) &&
      /[ÿþ�Â]|[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) &&
      !/\b(?:u\.?s\.? customs wants? to examine|customs wants? to examine|u\.?s\.? customs hold|cbp hold|fda hold|government hold|exam hold|hold remains active|hold not removed|intensive exam)\b/i.test(value)
    );
}

function factLooksGenericCanonicalArrival(text) {
  return /^(?:state-arrival|arrival-notice-received)\b/i.test(String(text || "")) &&
    /\b(?:arrival\/on[-\s]?hand evidence was received|arrived)\b/i.test(String(text || ""));
}

function factLooksGenericCanonicalCustomsHold(text) {
  const value = String(text || "");
  return /^(?:state-customs|exception(?: customs-hold)?)\b/i.test(value) &&
    (
      /\b(?:customs-hold|true customs\/government hold|customs\/government hold|appears to be on a true customs|customs hold in control-room inventory)\b/i.test(value) ||
      factLooksUnreadableAttachmentNoise(value)
    );
}

function generatedCustomsHoldSummaryWithoutSourceText(value) {
  const text = String(value || "");
  return /\bshipment appears to be on a true customs\/government hold\b/i.test(text) &&
    !/\b(?:u\.?s\.? customs hold|u\.?s\.? customs wants? to examine|customs wants? to examine|exam hold|\b1[-\s]?h\b|hold remains active|hold not removed|cbp hold|fda hold|intensive exam|in[-\s]?bond[^.;\n]{0,120}reject(?:ed|ion)?)\b/i.test(text);
}

function factLooksReleaseRequest(text) {
  const value = String(text || "");
  if (/\b(?:release\/?d\.?o (?:is )?confirmed|release\/?do (?:is )?confirmed|customs release (?:is )?confirmed|customs released|clearance (?:is )?confirmed)\b/i.test(value)) {
    return false;
  }
  return /\bstatus request evidence found\b/i.test(value) ||
    /\b(?:push|ask|request|follow(?:ed)? up|follow-up|waiting for|await(?:ing)?|need|needs|needed|confirm|verify|check|checking|before dispatch|before pickup)\b[^.;\n]{0,100}\b(?:release|clearance|cleared|d\/?o|delivery order)\b/i.test(value) ||
    /\b(?:release|clearance|cleared|d\/?o|delivery order)\b[^.;\n]{0,100}\b(?:status request|pending|missing|needed|not received|not found|not confirmed|confirm|verify|check|checking|before dispatch|before pickup)\b/i.test(value);
}

function shipmentConflicts(shipment) {
  if (!shipment || hasOperatorConflictResolution(shipment)) return [];
  if (shipment.opsState?.source === "canonical-shipment-pipeline") {
    return (shipment.opsState.exceptions || [])
      .filter((item) => /conflict/i.test(item.type || ""))
      .map((item, index) => ({
        id: `${normalizeAwb(shipment.awb || shipment.id)}:canonical-conflict:${index}`,
        type: item.type || "canonical-conflict",
        summary: item.summary || "Shipment memory has conflicting canonical evidence.",
        left: item.left || "",
        right: item.right || "",
        at: Date.parse(item.at || "") || 0,
      }));
  }
  const facts = shipmentStateFacts(shipment);
  const conflicts = [];
  const add = (type, summary, left, right) => {
    const id = [
      normalizeAwb(shipment.awb || shipment.id),
      type,
      compact(left?.text || "", 80),
      compact(right?.text || "", 80),
    ].join(":").toLowerCase().replace(/\s+/g, "-");
    conflicts.push({
      id,
      type,
      summary,
      left: left?.text || "",
      right: right?.text || "",
      at: [left?.time || 0, right?.time || 0].filter(Boolean).sort((a, b) => b - a)[0] || 0,
    });
  };

  const positiveArrival = facts
    .filter((fact) =>
      hasActualArrivalEvidence(fact.text) &&
      !factLooksPlanningOnly(fact.text) &&
      !hasRequestedArrivalEvidence(fact.text) &&
      !factLooksConditionalArrival(fact.text) &&
      !factLooksGenericCanonicalArrival(fact.text) &&
      !["current-state", "next-action"].includes(fact.source)
    )
    .sort((a, b) => b.time - a.time)[0] || null;
  const negativeArrival = facts
    .filter((fact) => hasNegativeArrivalEvidence(fact.text) && !factLooksTimelineArrivalUpdate(fact.text))
    .sort((a, b) => b.time - a.time)[0] || null;
  if (
    positiveArrival &&
    negativeArrival &&
    !factLooksObsolete(positiveArrival.text) &&
    !factLooksObsolete(negativeArrival.text) &&
    !(positiveArrival.time && negativeArrival.time && positiveArrival.time >= negativeArrival.time) &&
    positiveArrival.text !== negativeArrival.text &&
    !/\bemail[-\s]?not[-\s]?arrived\b/i.test(negativeArrival.text) &&
    !/\b(?:no arrival notice|without arrival notice|no arrival proof|arrival proof missing)\b/i.test(negativeArrival.text)
  ) {
    add(
      "arrival-conflict",
      "Arrival conflict: one source says cargo is on hand, another says it has not arrived.",
      positiveArrival,
      negativeArrival,
    );
  }

  const customsHold = latestFact(
    facts.filter((fact) =>
      !factLooksUnreadableAttachmentNoise(fact.text) &&
      !factLooksGenericCanonicalCustomsHold(fact.text)
    ),
    CUSTOMS_HOLD_PATTERN,
  );
  const customsRelease = latestFact(
    facts.filter((fact) =>
      !["current-state", "next-action"].includes(fact.source) &&
      !factLooksNonFinalCustomsRelease(fact.text)
    ),
    /\b(?:released|release\/?d\/?o|delivery order|d\/o|98\s*-\s*released|cleared)\b/i,
  );
  if (
    customsHold &&
    customsRelease &&
    !factLooksObsolete(customsHold.text) &&
    !factLooksObsolete(customsRelease.text) &&
    !/\b(?:no|not|without|missing|pending|awaiting)\b[^.;\n]{0,50}\b(?:release|released|clearance|cleared|d\/?o|delivery order)\b/i.test(customsRelease.text) &&
    !/\b(?:do not dispatch|no release yet|hold remains active|not released)\b/i.test(customsRelease.text)
  ) {
    add(
      "customs-conflict",
      "Customs conflict: one source shows release/DO, another says customs hold is still active.",
      customsRelease,
      customsHold,
    );
  }

  const pickedUp = latestFact(facts, PICKUP_COMPLETION_PATTERN);
  const notArrived = latestFact(facts, /\b(?:not arrived|not at destination|no on[-\s]?hand|not on[-\s]?hand|departed and has not arrived)\b/i);
  if (pickedUp && notArrived && !factLooksObsolete(pickedUp.text) && !factLooksObsolete(notArrived.text)) {
    add(
      "pickup-arrival-conflict",
      "Pickup conflict: one source says the shipment was picked up, another says it was not on hand/arrived.",
      pickedUp,
      notArrived,
    );
  }

  return conflicts;
}

function isCompanyScopedQuestion(question, shipments, context) {
  const text = String(question || "").trim();
  if (!text) return true;
  if (normalizeAwb(text)) return true;
  if (countIntent(text)) return true;
  if (COMPANY_SCOPE_PATTERN.test(text)) return true;
  if (/\b(?:urgent|today|needs action|what needs|open work|problems?|issues?|priority|prioritize|morning|tasks?|focus|blocked|waiting|customers?|changed|changes|proof|evidence|drafts?|updates?|together|deliver|pickup|release)\b/i.test(text)) return true;
  if (stationFromQuestion(text, shipments)) return true;
  if (context?.shipment && FOLLOW_UP_PATTERN.test(text)) return true;
  if (context?.station && /\b(?:there|station|open|urgent|action|phone|email|contact|call|shipments?|loads?|work)\b/i.test(text)) return true;
  return false;
}

function outOfScopeAnswer() {
  return {
    title: "I only know Pikiio ops",
    subtitle: "Company memory",
    answer: "I do not know that from Pikiio operational memory. Ask me about an AWB, station, broker, quote, release, pickup, POD, storage, email thread, or what needs action.",
    facts: [],
    actions: [],
    items: [],
    shipments: [],
    context: { topic: "out-of-scope" },
  };
}

function threadMemoryRowsForAwb(memory, awb) {
  const key = normalizeAwb(awb);
  if (!key) return [];
  return (memory.brain?.threads || []).filter((thread) =>
    (thread.awbs || []).some((value) => normalizeAwb(value) === key) ||
    normalizeAwb(`${thread.summary || ""} ${(thread.facts || []).map((fact) => fact.summary || "").join(" ")}`).includes(key)
  );
}

function threadMemoryShipmentAnswer(question, memory) {
  const awb = normalizeAwb(question);
  const displayAwb = awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb || "that AWB";
  const threads = threadMemoryRowsForAwb(memory, awb);
  if (!threads.length) return null;
  const facts = unique(
    threads.flatMap((thread) => [
      thread.summary,
      ...(thread.facts || []).map((fact) => fact.summary || fact.label),
      ...(thread.unresolved || []),
    ]).filter(Boolean).map((value) => compact(value, 130)),
  ).slice(0, 4);
  const unresolved = unique(threads.flatMap((thread) => thread.unresolved || [])).find(Boolean) || "";
  const latestAt = threads.find((thread) => thread.latestAt)?.latestAt || "";
  return {
    title: displayAwb,
    subtitle: "Seen in email history",
    answer: unique([
      "I only see this AWB in older email context, not on the active board.",
      facts[0] ? sentence(`Latest: ${facts[0]}`) : "",
      unresolved ? sentence(`Next: ${compact(unresolved, 130)}`) : "",
    ].filter(Boolean)).join("\n"),
    facts,
    actions: [],
    items: [],
    shipments: [],
    context: { awb, topic: "thread-memory", latestAt },
  };
}

function unknownShipmentAnswer(question, memory = {}) {
  const awb = normalizeAwb(question);
  const displayAwb = awb.length === 11 ? `${awb.slice(0, 3)}-${awb.slice(3)}` : awb || "that AWB";
  const threadAnswer = threadMemoryShipmentAnswer(question, memory);
  if (threadAnswer) return threadAnswer;
  return {
    title: displayAwb,
    subtitle: "Not found",
    answer: `I do not see ${displayAwb} in active shipments or recent email evidence. It may be completed, not synced yet, or written under a different AWB format.`,
    facts: [],
    actions: [],
    items: [],
    shipments: [],
    context: { awb, topic: "unknown-shipment" },
  };
}

function isTrashAttachmentEvidence(text) {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  const trash = /\b(?:logo|image00\d|signature|facebook|linkedin|twitter|instagram|privacy|disclaimer|terms|banner|profile photo|cid:|unsubscribe|pixel|spacer|tracking[-_ ]?pixel|divider|icon|footer)\b/.test(value) ||
    /\.ics\b|text\/calendar/.test(value);
  const operational =
    /\b(?:pod|proof of delivery|signed|receiver|delivered|arrival notice|notice of arrival|noa|release|d\/?o|delivery order|clearance|cargo release|cargosprint|payment|paid|receipt|invoice|storage|last free|lfd|on hand|available|awb|air ?way ?bill|mawb|hawb|bill of lading|bol\b|loaded)\b/.test(value);
  return trash && !operational;
}

// Triage with a REASON CODE, so every keep/ignore decision is explainable in
// the attachment audit. classifyAttachmentEvidence stays as the compat shim.
function classifyAttachmentTriage(evidence) {
  // Filenames arrive hyphen/underscore-joined ("proof-of-delivery-016.pdf");
  // normalize separators so vocabulary matches them.
  const text = String(evidence || "").replace(/[-_]+/g, " ");
  if (!text.trim()) return { kind: "none", reason: "empty-evidence" };
  if (isTrashAttachmentEvidence(text)) return { kind: "trash", reason: "decorative-or-footer-token" };
  if (/\b(?:pod|proof of delivery|signed|receiver|delivered)\b/i.test(text)) return { kind: "pod", reason: "pod-vocabulary" };
  if (/\b(?:loaded(?:\s+proof)?|pickup proof|driver photo|bill of lading|bol)\b/i.test(text)) return { kind: "pickup-proof", reason: "pickup-proof-vocabulary" };
  if (/\b(?:arrival notice|notice of arrival|noa|on hand|available)\b/i.test(text)) return { kind: "arrival", reason: "arrival-vocabulary" };
  if (/\b(?:release|d\/?o|delivery order|clearance|cargo release)\b/i.test(text)) return { kind: "release", reason: "release-vocabulary" };
  if (/\b(?:cargosprint|payment|paid|receipt|ground handling|station fee|invoice)\b/i.test(text)) return { kind: "payment", reason: "payment-vocabulary" };
  if (/\b(?:storage|last free|lfd|demurrage|detention)\b/i.test(text)) return { kind: "storage", reason: "storage-vocabulary" };
  if (/\b(?:awb|air ?way ?bill|mawb|hawb)\b/i.test(text)) return { kind: "awb-copy", reason: "awb-vocabulary" };
  // Camera photos (HEIC/JPG with no vocabulary) can be delivery/pickup proof —
  // downstream POD logic weighs thread context; never discard them as trash.
  if (/\.(?:heic|heif|jpe?g|png)\b/i.test(text) && /\b(?:img|photo|whatsapp image|\d{8}[_ ]\d{6})\b/i.test(text)) {
    return { kind: "photo", reason: "camera-photo-needs-context" };
  }
  return { kind: "context", reason: "no-decisive-vocabulary" };
}

function classifyAttachmentEvidence(evidence) {
  return classifyAttachmentTriage(evidence).kind;
}

function releaseFactLooksFinal(value) {
  const text = String(value || "");
  if (!text.trim()) return false;
  if (/\b(?:thread unresolved|unresolved)\b/i.test(text)) return false;
  if (/\b(?:request|requested|asking|asked|status request|confirm|verify|check|pending|missing|needed?|waiting|not released|not cleared|to follow)\b/i.test(text)) {
    return false;
  }
  return /\b(?:done|released|cleared|clearance released|98 released|release\/?d\/?o evidence was received|release\/?d\/?o attachment (?:is )?present|customs layer is resolved|delivery order (?:was )?(?:attached|issued|received|ready)|d\/?o (?:was )?(?:attached|issued|received|ready))\b/i.test(text);
}

function staleReleaseBlockerInstruction(value) {
  const text = String(value || "");
  if (!text.trim()) return false;
  return (
    /\b(?:customs|government|cbp|exam)\b[^.;\n]{0,100}\b(?:hold|blocked|not released|not cleared|pending|missing|not visible|cannot see|can't see|does not see|doesn't see)\b/i.test(text) ||
    /\b(?:hold|blocked|not released|not cleared|pending|missing|not visible|cannot see|can't see|does not see|doesn't see)\b[^.;\n]{0,100}\b(?:customs|clearance|release|d\/?o|delivery order|hold removal)\b/i.test(text) ||
    /\bpickup remains blocked\b[^.;\n]{0,120}\b(?:hold|release|clearance|d\/?o|delivery order)\b/i.test(text) ||
    /\b(?:no|not|without|missing|pending|awaiting)\b[^.;\n]{0,80}\b(?:release|released|clearance|cleared|d\/?o|delivery order)\b/i.test(text) ||
    /\b(?:release|released|clearance|cleared|d\/?o|delivery order)\b[^.;\n]{0,80}\b(?:no|not|without|missing|pending|awaiting|not visible|cannot see|can't see)\b/i.test(text)
  );
}

function genericReleasePendingCustomsHoldText(value) {
  const text = String(value || "");
  if (!/\b(?:customs hold pdf|customs\/release still blocking|release pending|release\/?d\.?o (?:is )?not confirmed|release\/?do (?:is )?not confirmed)\b/i.test(text)) {
    return false;
  }
  return !/\b(?:government hold|u\.?s\.? customs hold|u\.?s\.? customs wants? to examine|customs wants? to examine|exam hold|\b1[-\s]?h\b|hold remains active|hold not removed|cbp hold|fda hold|intensive exam)\b/i.test(text);
}

function releaseBlockerSourceLooksTmsOrTracking(row) {
  const source = String(row?.source || "");
  const value = `${source} ${row?.text || ""}`;
  return /\b(?:tms|couriercloud|carrier tracking|tracking)\b/i.test(value) &&
    !/\b(?:gmail|email|thread|operator|companion|broker|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight)\b/i.test(value);
}

function releaseBlockerSourceLooksEmailOrOperator(row) {
  const source = String(row?.source || "");
  const value = `${source} ${row?.text || ""}`;
  if (/\b(?:current-state|next-action|arrival-status|pickup-status|shipment-state|canonical-shipment-pipeline|active-shipment)\b/i.test(source)) {
    return false;
  }
  return /\b(?:gmail|email|thread|operator|companion|broker|email-validation|email-proof|email-event|latest-email|operator-note|fact|ledger|cedar dispatch|maple|cedar brokerage|worldwide|atlantic freight)\b/i.test(value);
}

function releaseBlockerRowLooksRelevant(row) {
  const text = String(row?.text || "");
  if (factLooksUnreadableAttachmentNoise(text)) return false;
  if (generatedCustomsHoldSummaryWithoutSourceText(text)) {
    return false;
  }
  if (/\bcanonical-risk\b/i.test(text)) return false;
  const hasReleaseContext =
    /\b(?:customs|clearance|release|released|delivery order|d[/.]\s*o|\b1[-\s]?h\b|exam|hold)\b/i.test(text) ||
    /\bDO\b/.test(text);
  if (!hasReleaseContext) return false;
  if (/\b(?:not picked up|pickup pending|not delivered|not applicable before delivery|do not dispatch pickup yet|monitor arrival|track final delivery|pod pending|pod missing)\b/i.test(text)) {
    return /\b(?:customs|clearance|release|d[/.]\s*o|delivery order|hold|exam)\b.{0,80}\b(?:blocked|pending|missing|not|no|without|awaiting|cannot|can't)\b/i.test(text) ||
      /\bDO\b.{0,80}\b(?:blocked|pending|missing|not|no|without|awaiting|cannot|can't)\b/.test(text);
  }
  return true;
}

function releaseBlockerRowMirrorsGeneratedState(shipment, row) {
  if (!/\b(?:email-validation|latest-email)\b/i.test(String(row?.source || ""))) return false;
  if (shipment?.opsState?.source !== "canonical-shipment-pipeline") return false;
  const text = String(row?.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!text) return false;
  return [
    shipment.opsState?.summary,
    shipment.opsState?.nextAction,
    shipment.currentState,
    shipment.nextAction,
  ]
    .map((item) => String(item || "").replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean)
    .includes(text);
}

function releaseBlockerRowGateStatus(row) {
  if (genericReleasePendingCustomsHoldText(row?.text)) return "pending";
  return /\b(?:customs hold|government hold|u\.?s\.? customs hold|\b1[-\s]?h\b|exam hold|hold remains active|hold not removed)\b/i.test(String(row?.text || ""))
    ? "blocked"
    : "pending";
}

function authoritativeEmailReleaseBlocker(shipment) {
  const emailOrOperatorRows = shipmentStateFacts(shipment)
    .filter((row) =>
      !releaseBlockerRowMirrorsGeneratedState(shipment, row) &&
      releaseBlockerSourceLooksEmailOrOperator(row) &&
      !releaseBlockerSourceLooksTmsOrTracking(row)
    );
  const emailRows = emailOrOperatorRows
    .filter((row) =>
      releaseBlockerRowLooksRelevant(row)
    );
  const blocker = emailRows
    .filter((row) => !releaseFactLooksFinal(row.text) && staleReleaseBlockerInstruction(row.text))
    .sort((a, b) => b.time - a.time)[0] || null;
  if (!blocker) return null;
  if (hasDirectCustomsReleaseEvidence(shipment) && releaseBlockerRowGateStatus(blocker) === "pending") return null;
  const laterFinal = emailRows
    .filter((row) => releaseFactLooksFinal(row.text) && row.time >= blocker.time)
    .sort((a, b) => b.time - a.time)[0] || null;
  const laterResolvedPickupBlocker = emailOrOperatorRows
    .filter((row) => resolvedPickupBlockerInstruction(row.text) && row.time >= blocker.time)
    .sort((a, b) => b.time - a.time)[0] || null;
  return laterFinal || laterResolvedPickupBlocker ? null : blocker;
}

function resolvedPickupBlockerInstruction(value) {
  const text = String(value || "");
  if (!text.trim()) return false;
  return (
    /\b(?:resolved|handled|cleared|fixed)\b[^.;\n]{0,120}\b(?:pickup blocker|pickup block|driver wait|station issue|release visibility|cannot see release)\b/i.test(text) ||
    /\b(?:pickup blocker|pickup block|driver wait|station issue|release visibility|cannot see release)\b[^.;\n]{0,120}\b(?:resolved|handled|cleared|fixed)\b/i.test(text)
  );
}

function valuableFacts(shipment, topic = "") {
  const typed = (shipment.facts || []).map((fact) => fact.summary || fact.note || fact.label || "");
  const ledger = (shipment.factLedger || []).map((fact) => fact.summary || fact.note || fact.label || "");
  const cargoMissing = cargoNotFoundEvidenceText(shipment);
  const evidence = [
    cargoMissing ? "Station/pickup side cannot locate the cargo." : "",
    shipment.lastEmail?.summary,
    ...(shipment.opsState?.exceptions || []).map((item) => item.evidence || item.summary || item.nextAction || ""),
    ...(shipment.opsState?.events || []).map((item) => item.evidence || item.summary || item.nextAction || ""),
    ...(shipment.storage?.evidence || []),
    ...(shipment.pod?.evidence || []),
    ...typed,
    ...ledger,
  ].filter(Boolean);
  return unique(evidence)
    .filter((item) => classifyAttachmentEvidence(item) !== "trash")
    .filter((item) => !(cargoMissing && /\bstorage evidence found\b|\bstorage\/detention|storage or detention cost/i.test(String(item || ""))))
    .filter((item) => {
      if (!topic) return true;
      const kind = classifyAttachmentEvidence(item);
      if (topic === "pod") return kind === "pod" || /\bdelivered|driver|loaded|picked up\b/i.test(item);
      if (topic === "release") {
        const gates = gateState(shipment);
        if (gates.customsBrokerRelease) {
          return (
            (kind === "release" || /\bcustoms|clear|broker|release|d\/?o|delivery order\b/i.test(item)) &&
            !staleReleaseBlockerInstruction(item) &&
            !factLooksNonFinalCustomsRelease(item)
          );
        }
        if (!gates.customsBrokerRelease && releaseFactLooksFinal(item)) return false;
        return kind === "release" || /\bcustoms|clear|broker\b/i.test(item);
      }
      if (topic === "payment") return kind === "payment" || /\bground|handling|station fee\b/i.test(item);
      if (topic === "storage") return kind === "storage";
      if (topic === "arrival") return kind === "arrival" || /\barrived|station\b/i.test(item);
      return true;
    })
    .slice(0, 5);
}

function activeAuthoritativeProofRows(shipment) {
  return [
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
    ...(shipment.emailValidation?.events || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.opsState?.exceptions || []),
  ].map((item) => ({
    identity: `${item?.type || ""} ${item?.label || ""} ${item?.kind || ""}`,
    text: factRowText(item),
  }));
}

function freightBrokerStatusHasFinalPod(value) {
  return /\b(?:delivered[-_\s]?pod[-_\s]?(?:found|received)|pod[-_\s]?(?:found|received|attached))\b/i.test(String(value || ""));
}

function activeAuthoritativeFinalProof(shipment) {
  if (freightBrokerStatusHasFinalPod(shipment.freightBroker?.status)) {
    return { completed: true, deliveryReported: true, podReceived: true };
  }
  const topLevelText = [
    shipment.stage,
    shipment.currentState,
    shipment.pickupStatus,
    shipment.pod?.status,
    shipment.pod?.recipient,
    shipment.pod?.deliveredAt,
    shipment.completion?.deliveredAt,
  ].filter(Boolean).join(" ");
  const topLevelPodReceived =
    /^(?:pod-found|completed|pod-received|received|done)$/i.test(String(shipment.pod?.status || "").trim()) ||
    (
      POD_RECEIVED_PATTERN.test(topLevelText) &&
      !POD_NEGATIVE_PATTERN.test(topLevelText) &&
      !POD_PENDING_PATTERN.test(topLevelText) &&
      !POD_REQUEST_PATTERN.test(topLevelText)
    );
  if (topLevelPodReceived) {
    return { completed: true, deliveryReported: true, podReceived: true };
  }
  const rows = activeAuthoritativeProofRows(shipment);
  const podReceived = rows.some((row) =>
    /\b(?:pod|proof[-\s]?of[-\s]?delivery|delivery[-_\s]?proof)\b/i.test(`${row.identity} ${row.text}`) &&
    POD_RECEIVED_PATTERN.test(row.text) &&
    !POD_NEGATIVE_PATTERN.test(row.text) &&
    !POD_PENDING_PATTERN.test(row.text) &&
    !POD_REQUEST_PATTERN.test(row.text) &&
    !PICKUP_NEGATIVE_PATTERN.test(row.text)
  );
  const deliveryReported = podReceived || rows.some((row) =>
    /\b(?:delivery|delivered|pod|proof[-\s]?of[-\s]?delivery)\b/i.test(`${row.identity} ${row.text}`) &&
    (DELIVERY_REPORTED_PATTERN.test(row.text) || /\b(?:delivered[-_\s]?reported|delivery (?:was )?reported)\b/i.test(row.text)) &&
    !hasFutureOrConditionalDeliveryEvidence(row.text) &&
    !stationPaymentDeliveryOnlyText(row.text) &&
    !POD_PENDING_PATTERN.test(row.text)
  );
  return { completed: podReceived, deliveryReported, podReceived };
}

function activeAuthoritativeGateState(shipment) {
  if (!shipment?._activeAuthoritative) return null;
  if (shipment.opsState?.source === "canonical-shipment-pipeline") return null;
  const phase = String(shipment.opsState?.phase || "").trim().toLowerCase();
  if (!phase) return null;
  if (["in-transit", "pre-arrival", "unknown"].includes(phase)) return null;
  const phaseText = [
    phase,
    shipment.stage,
    shipment.currentState,
    shipment.nextAction,
    shipment.arrivalStatus,
    shipment.clearanceStatus,
    shipment.pickupStatus,
    shipment.customsBroker?.status,
    shipment.opsState?.label,
    shipment.opsState?.summary,
  ].filter(Boolean).join(" ");
  const finalProof = activeAuthoritativeFinalProof(shipment);
  const directReleaseEvidence = hasDirectCustomsReleaseEvidence(shipment);
  const directCustomsEvidenceText = directCustomsReleaseEvidenceRows(shipment).join(" ");
  const customsStatusValues = [shipment.clearanceStatus, shipment.customsBroker?.status]
    .map((value) => String(value || "").toLowerCase())
    .filter(Boolean);
  const explicitCustomsReleasedStatus = customsStatusValues.some(explicitCustomsStatusLooksReleased);
  const explicitCustomsBlockedStatus = customsStatusValues.some(explicitCustomsStatusLooksBlocked);
  const directCustomsBlockerEvidence =
    !genericReleasePendingCustomsHoldText(directCustomsEvidenceText) &&
    EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(directCustomsEvidenceText);
  const hardCustomsBlocker = !explicitCustomsReleasedStatus && (
    explicitCustomsBlockedStatus ||
    directCustomsBlockerEvidence ||
    (!genericReleasePendingCustomsHoldText(phaseText) && EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(phaseText))
  );
  const phaseExecutionReached = [
    "out-for-delivery",
    "delivery-scheduled",
    "delivered-pod-pending",
    "delivered",
    "completed",
  ].includes(phase) || /^(?:airport[-\s]?picked[-\s]?up|picked[-\s]?up|loaded|recovered|done|delivered)$/i.test(String(shipment.pickupStatus || "").trim());
  const currentCustomsReleased =
    !hardCustomsBlocker &&
    (explicitCustomsReleasedStatus || directReleaseEvidence || finalProof.deliveryReported || finalProof.podReceived || phaseExecutionReached) &&
    !/\b(?:not released|not cleared|release pending|clearance pending|customs hold|exam hold|hold not removed)\b/i.test(
      `${shipment.clearanceStatus || ""} ${shipment.customsBroker?.status || ""}`,
    );
  const currentCustomsHold =
    (hardCustomsBlocker || /\b(?:customs[-\s]?hold|exam[-\s]?hold|government[-\s]?hold|cbp[-\s]?hold)\b/i.test(`${phaseText} ${directCustomsEvidenceText}`)) &&
    !currentCustomsReleased;
  const arrived =
    !["pre-arrival", "in-transit"].includes(phase) &&
    !/\bnot[-\s]?arrived\b/i.test(String(shipment.arrivalStatus || ""));
  const pickupDone =
    finalProof.deliveryReported ||
    ["out-for-delivery", "delivery-scheduled", "delivered-pod-pending", "delivered", "completed"].includes(phase) ||
    /^(?:airport[-\s]?picked[-\s]?up|picked[-\s]?up|loaded|recovered|done|delivered)$/i.test(String(shipment.pickupStatus || "").trim());
  const deliveryScheduledDate = parsedDateKey(
    shipment.delivery?.scheduledDate ||
    shipment.freightBroker?.deliveryScheduledDate ||
    shipment.opsState?.deliveryScheduledDate ||
    "",
    new Date(),
  );
  return {
    completed: finalProof.completed || ["delivered", "completed"].includes(phase),
    arrived,
    arrivalIncomplete: ["arrival-incomplete", "station-confirmation-needed"].includes(phase),
    customsHold: currentCustomsHold,
    brokerReleasePending: ["release-needed"].includes(phase) && !currentCustomsReleased && !currentCustomsHold,
    customsBrokerRelease: currentCustomsHold ? false : currentCustomsReleased,
    stationReleaseReady: currentCustomsReleased && ["not-ready", "ready-for-pickup", "approval-needed", "dispatch-ready", "pickup-scheduled"].includes(phase),
    groundPaid: !["fees-needed", "not-ready"].includes(phase),
    groundDue: ["fees-needed"].includes(phase),
    pickedUp: pickupDone,
    pickupBlocked: ["pickup-blocked", "loading-blocked"].includes(phase),
    dispatchDone: ["dispatch-ready", "pickup-scheduled", "out-for-delivery", "delivery-scheduled", "delivered-pod-pending", "delivered", "completed"].includes(phase),
    pickupScheduled: phase === "pickup-scheduled" && !pickupDone,
    pickupScheduledDate: parsedDateKey(
      shipment.freightBroker?.pickupScheduledDate ||
      shipment.opsState?.pickupScheduledDate ||
      "",
      new Date(),
    ),
    driverOnsite: phase === "driver-onsite" || phase === "pickup-onsite",
    loadingProblem: phase === "loading-blocked",
    deliveryProblem: phase === "delivery-blocked",
    releasePackageReady: currentCustomsReleased && ["not-ready", "ready-for-pickup", "approval-needed", "dispatch-ready", "pickup-scheduled"].includes(phase),
    deliveryOutForDelivery: phase === "out-for-delivery",
    deliveryReported: finalProof.deliveryReported || ["delivered-pod-pending", "delivered", "completed"].includes(phase),
    podReceived: finalProof.podReceived || ["delivered", "completed"].includes(phase),
    podPending: !finalProof.podReceived && phase === "delivered-pod-pending",
    deliveryScheduledToday: Boolean(deliveryScheduledDate && deliveryScheduledDate === operatorDateKey(new Date())),
    deliveryScheduledDate,
  };
}

function gateState(shipment) {
  const resolved = resolveShipmentState(shipment);
  const text = statusText(shipment);
  const podStatus = String(shipment.pod?.status || "").toLowerCase();
  const canonical = canonicalState(shipment);
  const canonicalPhase = canonical?.phase || "";
  const activeGates = activeAuthoritativeGateState(shipment);
  if (activeGates) return activeGates;
  if (canonical && (
    canonical.source === "canonical-shipment-pipeline" ||
    canonical.source === "shipment-truth-packets" ||
    shipment._mergeSource === "truth-packet"
  )) {
    return strictCanonicalGateState(shipment);
  }
  const canonicalArrivalArrivedRaw = canonicalGateIs(shipment, "arrival", ["arrived", "available", "on-hand", "done", "inferred"]);
  const canonicalArrivalWaiting = canonicalGateIs(shipment, "arrival", ["waiting", "pending", "not-arrived", "missing"]);
  const canonicalArrivalBlocked = canonicalGateIs(shipment, "arrival", ["blocked", "partial", "incomplete"]);
  const canonicalCustomsReleasedRaw = canonicalGateIs(shipment, "customs", ["released", "cleared", "done"]);
  const canonicalCustomsHoldRaw = canonicalGateIs(shipment, "customs", ["customs-hold", "hold", "exam-hold", "blocked"]);
  const canonicalGroundPaid = canonicalGateIs(shipment, "fees", ["paid", "done"]);
  const canonicalGroundDue = canonicalGateIs(shipment, "fees", ["due", "pending", "unpaid"]);
  const canonicalDispatchDone = canonicalGateIs(shipment, "dispatch", ["done", "sent", "broker-awarded", "awarded", "dispatched"]);
  const canonicalPickupEvidenceText = [
    canonicalGate(shipment, "pickup")?.status,
    canonicalGate(shipment, "pickup")?.summary,
    canonicalGate(shipment, "pickup")?.evidence,
    ...(shipment.opsState?.events || [])
      .filter((event) => /pickup|picked[-\s]?up|loaded|recovered/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
  ].filter(Boolean).join(" ");
  const canonicalPickedUp = canonicalGateIs(shipment, "pickup", ["picked-up", "loaded", "done", "inferred"]) && !pickupArrangementOnlyText(canonicalPickupEvidenceText);
  const canonicalPickupPending = canonicalGateIs(shipment, "pickup", ["pending", "waiting", "missing", "not-picked-up"]);
  const canonicalPickupBlocked = canonicalGateIs(shipment, "pickup", ["blocked", "waiting", "pending"]);
  const canonicalDeliveryReported = canonicalGateIs(shipment, "delivery", ["delivered", "reported"]);
  const canonicalDeliveryOutForDelivery = canonicalGateIs(shipment, "delivery", ["out-for-delivery"]);
  const canonicalDeliveryWaiting = canonicalGateIs(shipment, "delivery", ["waiting", "pending", "not-delivered", "missing"]);
  const canonicalDeliveryProblem = canonicalGateIs(shipment, "delivery", ["blocked", "exception", "problem"]);
  const canonicalPodReceived = canonicalGateIs(shipment, "pod", ["received", "pod-found", "found", "done"]);
  const canonicalPodPending = canonicalGateIs(shipment, "pod", ["pending", "missing", "needed"]);
  const canonicalOpen = Boolean(canonicalPhase && !["delivered", "completed"].includes(canonicalPhase) && !canonicalPodReceived);
  const canonicalDeliveryScheduledDate =
    canonicalGateDate(shipment, ["delivery"], ["deliveryScheduledDate", "scheduledDate", "deliveryDate", "appointmentDate"]) ||
    canonicalGateDate(shipment, ["pickup", "dispatch"], ["deliveryScheduledDate", "deliveryDate"]);
  const canonicalPickupScheduled = canonicalGateIs(shipment, "pickup", ["scheduled", "planned", "deferred"]);
  const canonicalPickupScheduledDate = canonicalPickupScheduled
    ? canonicalGateDate(shipment, ["pickup"], ["pickupScheduledDate", "scheduledDate", "appointmentDate", "deliveryScheduledDate"])
    : "";
  const clearanceStatus = String(shipment.clearanceStatus || "").toLowerCase();
  const brokerCustomsStatus = String(shipment.customsBroker?.status || "").toLowerCase();
  const freightBrokerFinalPod = freightBrokerStatusHasFinalPod(shipment.freightBroker?.status);
  const customsStatusEvidenceText = [clearanceStatus, brokerCustomsStatus].filter(Boolean).join(" ");
  const customsEvidence = [
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.nextAction,
    ...(shipment.customsBroker?.evidence || []).map((item) => `${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean).join(" ");
  const explicitCustomsStatusBlocked = [clearanceStatus, brokerCustomsStatus].some(explicitCustomsStatusLooksBlocked);
  const explicitPodPending = !freightBrokerFinalPod && (canonicalPodPending ||
    resolved.podPending ||
    /\b(?:pending|missing|needed|not[-\s]?received|not[-\s]?found|no[-\s]?pod)\b/i.test(podStatus) ||
    POD_PENDING_PATTERN.test(text));
  const completedEvidence = canonical
    ? ["delivered", "completed"].includes(canonicalPhase) || canonicalPodReceived
    : shipment.completed ||
      shipment.opsState?.phase === "completed" ||
      freightBrokerFinalPod ||
      resolved.podReceived ||
      /^(?:pod-found|completed)$/.test(podStatus) ||
      (!explicitPodPending && /^(?:delivered)$/.test(podStatus)) ||
      (!explicitPodPending && POD_RECEIVED_PATTERN.test(`${shipment.pickupStatus || ""} ${shipment.stage || ""} ${shipment.currentState || ""}`));
  const completed = Boolean(canonicalPodReceived || (!explicitPodPending && completedEvidence)) && !canonicalOpen;
  const topLevelArrivalText = [
    shipment.arrivalStatus,
    shipment.stage,
    shipment.currentState,
    shipment.eta,
  ].filter(Boolean).join(" ");
  const arrivalStatusValue = String(shipment.arrivalStatus || "").trim().toLowerCase();
  const explicitArrivalStatusArrived = /^(?:arrived|available|on[-\s]?hand|ready|done)$/.test(arrivalStatusValue);
  const explicitArrivalStatusWaiting = /^(?:not[-\s]?arrived|pending|waiting|missing|unknown)$/.test(arrivalStatusValue);
  const factLevelArrival = hasStrongArrivalEvidence(shipment);
  const topLevelPreArrival =
    !explicitArrivalStatusArrived &&
    ARRIVAL_NEGATIVE_PATTERN.test(topLevelArrivalText) ||
    !explicitArrivalStatusArrived &&
      /\b(?:in transit|not[-\s]?arrived|not at destination|actual departure|\bdep\b)\b/i.test(topLevelArrivalText);
  const canonicalArrivalEvidenceText = [
    canonicalGate(shipment, "arrival")?.evidence,
    canonicalGate(shipment, "arrival")?.summary,
    ...(shipment.opsState?.events || [])
      .filter((event) => /arrival|notice|noa|on[-\s]?hand|availability/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => `${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`),
  ].filter(Boolean).join(" ");
  const canonicalArrivalLooksRequested =
    hasRequestedArrivalEvidence(canonicalArrivalEvidenceText) ||
    hasArrivalPendingLanguage(canonicalArrivalEvidenceText) ||
    factLooksPlanningOnly(canonicalArrivalEvidenceText) ||
    hasNegativeArrivalEvidence(canonicalArrivalEvidenceText);
  const canonicalArrivalArrived =
    canonicalArrivalArrivedRaw &&
    !canonicalArrivalLooksRequested;
  const customsHoldEvidenceText = `${customsStatusEvidenceText} ${text} ${customsEvidence}`;
  const customsHoldEvidenceIsGeneric = genericReleasePendingCustomsHoldText(customsHoldEvidenceText);
  const currentCustomsHoldEvidence = explicitCustomsStatusBlocked || (!generatedCustomsHoldSummaryWithoutSourceText(customsHoldEvidenceText) && !factLooksUnreadableAttachmentNoise(customsHoldEvidenceText) && !customsHoldEvidenceIsGeneric && (
    EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(customsHoldEvidenceText) ||
    CUSTOMS_HOLD_PATTERN.test(`${customsStatusEvidenceText} ${customsEvidence}`) ||
    CUSTOMS_HOLD_PATTERN.test(customsHoldEvidenceText) && /\b(?:cannot|can'?t|we cannot|can not|unable|blocked|hold|examine|storage)\b/i.test(customsHoldEvidenceText) ||
    /\b(?:hold remains active|customs hold still active|release is still blocked by customs|u\.?s\.? customs hold|exam hold|government hold)\b/i.test(`${customsStatusEvidenceText} ${customsEvidence}`)
  ));
  const customsHoldImpliesArrival =
    currentCustomsHoldEvidence &&
    /\b(?:cannot|can'?t|we cannot|can not|unable|blocked|pick\s*up|storage|accruing|examine)\b/i.test(customsHoldEvidenceText);
  const shipmentLevelPreArrival =
    !explicitArrivalStatusArrived &&
    !factLevelArrival &&
    topLevelPreArrival &&
    !hasActualArrivalEvidence(topLevelArrivalText);
  const explicitlyNotArrived =
    (explicitArrivalStatusWaiting && !factLevelArrival) ||
    shipmentLevelPreArrival ||
    (!factLevelArrival &&
      (ARRIVAL_NEGATIVE_PATTERN.test(topLevelArrivalText) || hasNegativeArrivalEvidence(text)));
  const arrived = canonicalArrivalWaiting && !factLevelArrival && !explicitArrivalStatusArrived ? false :
    explicitArrivalStatusArrived ||
    canonicalArrivalArrived ||
    customsHoldImpliesArrival ||
    (!shipmentLevelPreArrival && !explicitlyNotArrived && (resolved.arrived || factLevelArrival));
  const arrivalIncomplete = arrived && (canonicalArrivalBlocked || (!canonicalArrivalArrived && ARRIVAL_NOT_AVAILABLE_PATTERN.test(stripAttachmentExtractionUnavailableText(text))));
  const emailReleaseBlocker = authoritativeEmailReleaseBlocker(shipment);
  const directReleaseEvidence = hasDirectCustomsReleaseEvidence(shipment);
  const blockingReleaseText = Boolean(emailReleaseBlocker) || currentCustomsHoldEvidence || /\b(?:not released|not cleared|release pending|clearance pending|customs hold|\b1[-\s]?h\b|exam hold|hold not removed|cannot release|pickup remains blocked|no release yet|nothing yet)\b/i.test(
    `${customsStatusEvidenceText} ${text} ${customsEvidence}`,
  );
  const explicitReleasedStatus = directReleaseEvidence && [clearanceStatus, brokerCustomsStatus].some(explicitCustomsStatusLooksReleased);
  const releaseStatusEvidence =
    explicitReleasedStatus ||
    (
      !/\b(?:not|no-release|pending|missing|needed|hasn'?t|has not|hold|exam)\b/i.test(clearanceStatus) &&
      /\b(?:released|cleared|customs-release|release-attachment)\b/i.test(clearanceStatus) &&
      !factLooksNonFinalCustomsRelease(`${clearanceStatus} ${customsEvidence}`)
    );
  const releaseEvidenceText = `${text} ${customsEvidence}`;
  const strongReleaseRows = [
    customsEvidence,
    ...(shipment.opsState?.events || [])
      .filter((event) => /customs|release|clearance|d\/?o|delivery order|1c/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
    ...(shipment.emailValidation?.events || [])
      .filter((event) => /customs|release|clearance|d\/?o|delivery order|1c/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
  ].filter(Boolean);
  const strongReleaseRowEvidence = strongReleaseRows.some((row) =>
    hasStrongCustomsReleaseText(row) &&
    !factLooksNonFinalCustomsRelease(row)
  );
  const strongReleaseTextEvidence =
    strongReleaseRowEvidence ||
    !blockingReleaseText &&
      !factLooksNonFinalCustomsRelease(releaseEvidenceText) &&
      hasStrongCustomsReleaseText(releaseEvidenceText);
  const weakReleaseTextEvidence = !blockingReleaseText &&
    !factLooksNonFinalCustomsRelease(releaseEvidenceText) &&
    /\b(?:customs.*(?:released|cleared)|d\/?o(?: and)? clearance|cargo release|delivery order)\b/i.test(releaseEvidenceText);
  const releaseEvidence = !emailReleaseBlocker && directReleaseEvidence && (releaseStatusEvidence || strongReleaseTextEvidence || (!explicitlyNotArrived && weakReleaseTextEvidence) || directReleaseEvidence);
  const canonicalCustomsGateText = [
    canonicalGate(shipment, "customs")?.status,
    canonicalGate(shipment, "customs")?.summary,
    canonicalGate(shipment, "customs")?.evidence,
  ].filter(Boolean).join(" ");
  const canonicalCustomsReleaseEvidenceText = [
    canonicalCustomsGateText,
    ...(shipment.opsState?.events || [])
      .filter((event) => /customs|release|clearance|d\/?o|delivery order|1c/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
  ].filter(Boolean).join(" ");
  const canonicalCustomsReleaseLooksNonFinal =
    canonicalCustomsReleasedRaw &&
    factLooksNonFinalCustomsRelease(canonicalCustomsGateText || canonicalCustomsReleaseEvidenceText) &&
    !/\b(?:attached|received|issued|provided|98\s+released|1c|release\s+\+\s+d\/?o|marked released)\b/i.test(canonicalCustomsGateText || canonicalCustomsReleaseEvidenceText);
  const canonicalCustomsReleased = canonicalCustomsReleasedRaw && !blockingReleaseText && !canonicalCustomsReleaseLooksNonFinal;
  const canonicalCustomsHoldEvidenceText = [
    canonicalGate(shipment, "customs")?.status,
    canonicalGate(shipment, "customs")?.summary,
    canonicalGate(shipment, "customs")?.evidence,
    ...(shipment.opsState?.exceptions || [])
      .filter((item) => /customs|hold|exam|release|clearance/i.test(`${item.type || ""} ${item.summary || ""} ${item.evidence || ""}`))
      .map((item) => `${item.type || ""} ${item.summary || ""} ${item.evidence || ""}`),
  ].filter(Boolean).join(" ");
  const unsupportedCanonicalCustomsHold =
    factLooksUnreadableAttachmentNoise(canonicalCustomsHoldEvidenceText) ||
    /\bcustoms hold in control-room inventory\b/i.test(canonicalCustomsHoldEvidenceText);
  const canonicalCustomsHold =
    canonicalCustomsHoldRaw &&
    !unsupportedCanonicalCustomsHold;
  let customsHold = !releaseEvidence && (currentCustomsHoldEvidence || canonicalCustomsHold || (
    !canonicalCustomsReleased &&
    !releaseEvidence &&
    !factLooksUnreadableAttachmentNoise(customsHoldEvidenceText) &&
    !generatedCustomsHoldSummaryWithoutSourceText(customsHoldEvidenceText) &&
    !/\bcustoms hold in control-room inventory\b/i.test(customsHoldEvidenceText) &&
    CUSTOMS_HOLD_PATTERN.test(customsHoldEvidenceText)
  ));
  let brokerReleasePending = !explicitlyNotArrived && !customsHold && !releaseEvidence && (
    blockingReleaseText ||
    BROKER_RELEASE_DELAY_PATTERN.test(`${clearanceStatus} ${text} ${customsEvidence}`)
  );
  let customsBrokerRelease = customsHold ? false : canonicalCustomsReleased || resolved.customsReleased || releaseEvidence;
  const stationReleaseReady = /\b(?:ready[-\s]?for[-\s]?pickup|pickup[-\s]?ready|available for pickup|cleared and ready)\b/i.test(text);
  const feeLine = groundFeeLine(shipment);
  let groundPaid = !canonicalGroundDue && (canonicalGroundPaid || resolved.groundPaid || /\bpaid|confirmed\b/i.test(feeLine));
  let groundDue = !groundPaid && (canonicalGroundDue || /\bdue|not confirmed\b/i.test(feeLine));
  const pickupText = pickupExecutionText(shipment);
  const pickupStatusDone = /^(?:airport[-\s]?picked[-\s]?up|picked[-\s]?up|loaded|recovered|done)$/i.test(String(shipment.pickupStatus || "").trim());
  const pickupCompletion = !pickupArrangementOnlyText(pickupText) && !hasPickupBlockingText(pickupText) && (resolved.pickedUp || pickupStatusDone || PICKUP_COMPLETION_PATTERN.test(pickupText));
  const pickupIncomplete = !pickupCompletion && (
    PICKUP_NEGATIVE_PATTERN.test(pickupText) ||
    PICKUP_BLOCKER_PATTERN.test(pickupText) ||
    /\b(?:waiting (?:in line )?(?:to be loaded|for loading)|to be loaded|not loaded|cannot load|can'?t load|loading blocked|pickup is not complete|recovery is not complete|not complete yet)\b/i.test(pickupText)
  );
  const rawPickedUp = !pickupIncomplete && (
    pickupCompletion
  );
  const pickedUp = !canonicalPickupPending && !arrivalIncomplete && (canonicalPickedUp || rawPickedUp);
  const airportExecutionReached = pickedUp || canonicalDeliveryReported || canonicalPodReceived || resolved.delivered || resolved.podReceived;
  if (airportExecutionReached) {
    customsHold = false;
    brokerReleasePending = false;
    customsBrokerRelease = true;
    groundPaid = true;
    groundDue = false;
  }
  const driverReleased = /\b(?:driver|drivers?)\b[^.;\n]{0,80}\b(?:released|left|stood down|sent away)\b|\b(?:release|released|stand down|stood down)\b[^.;\n]{0,80}\b(?:driver|drivers?)\b|\bdo not dispatch\b|\bdo not send (?:the )?driver\b/i.test(pickupText);
  const livePickupCanMatter = arrived && !arrivalIncomplete && !customsHold && !completed;
  const driverOnsite = livePickupCanMatter && !pickedUp && !driverReleased &&
    /\b(?:driver|truck|trucker)\b[^.;\n]{0,100}\b(?:on[-\s]?site|at (?:airport|station|warehouse|pickup)|checked[-\s]?in|waiting|standby|sitting|detention|cannot pickup|can'?t pickup|pickup blocked|not loaded|loading blocked|refused (?:to )?(?:load|pickup))\b|\b(?:on[-\s]?site|checked[-\s]?in|waiting in line|waiting to be loaded|still onsite|detention)\b[^.;\n]{0,100}\b(?:driver|truck|trucker)\b/i.test(pickupText);
  const loadingProblem = driverOnsite && LOADING_PROBLEM_PATTERN.test(pickupText);
  const deliveryProblem = (pickedUp || /\bout for delivery|at delivery|delivery point\b/i.test(pickupText)) && DELIVERY_PROBLEM_PATTERN.test(pickupText);
  const pickupBlocked = !pickedUp && !completed && (canonicalPickupBlocked || PICKUP_BLOCKER_PATTERN.test(pickupText));
  const releasePackageReady = arrived && !arrivalIncomplete && customsBrokerRelease && stationReleaseReady && !pickupBlocked && (groundPaid || !groundDue);
  const deliveryOutForDelivery = canonicalDeliveryOutForDelivery || canonicalPhase === "out-for-delivery";
  const finalPodReceived = canonicalPodReceived || freightBrokerFinalPod || resolved.podReceived;
  const deliveryReported = !canonicalDeliveryWaiting && (canonicalDeliveryReported || resolved.delivered || finalPodReceived || completed);
  const pickupPathCompleted = pickedUp || deliveryReported || finalPodReceived || completed;
  const podPendingHasPhysicalContext =
    deliveryReported ||
    canonicalPodReceived ||
    resolved.podReceived ||
    canonicalPickedUp ||
    resolved.pickedUp ||
    Boolean(canonicalDeliveryScheduledDate || resolved.deliveryScheduledDate);
  return {
    completed,
    arrived,
    arrivalIncomplete,
    customsHold,
    brokerReleasePending,
    customsBrokerRelease,
    stationReleaseReady,
    groundPaid,
    groundDue,
    pickedUp: pickupPathCompleted,
    pickupBlocked,
    dispatchDone: canonicalDispatchDone,
    pickupScheduled: canonicalPickupScheduled && !pickedUp,
    pickupScheduledDate: canonicalPickupScheduledDate,
    driverOnsite,
    loadingProblem,
    deliveryProblem: canonicalDeliveryProblem || deliveryProblem,
    deliveryOutForDelivery,
    releasePackageReady,
    deliveryReported,
    podReceived: finalPodReceived,
    podPending: !finalPodReceived && !completed && !canonicalDeliveryWaiting && (canonicalPodPending || resolved.podPending) && podPendingHasPhysicalContext,
    deliveryScheduledToday: Boolean((canonicalDeliveryScheduledDate || resolved.deliveryScheduledDate) === operatorDateKey(new Date())),
    deliveryScheduledDate: canonicalDeliveryScheduledDate || resolved.deliveryScheduledDate,
  };
}

function strictCanonicalGateState(shipment) {
  const phase = String(shipment.opsState?.phase || "").toLowerCase();
  const status = (name) => String(canonicalGate(shipment, name)?.status || "").toLowerCase();
  const arrival = status("arrival");
  const customs = status("customs");
  const fees = status("fees");
  const dispatch = status("dispatch");
  const pickup = status("pickup");
  const delivery = status("delivery");
  const pod = status("pod");
  const completed = ["completed", "delivered"].includes(phase) || pod === "done" || pod === "received";
  const deliveryOutForDelivery = delivery === "out-for-delivery" || phase === "out-for-delivery";
  const podReceived = ["done", "received", "pod-found", "found"].includes(pod);
  const deliveryReported = delivery === "delivered" || delivery === "reported" || podReceived || completed;
  const podPending = !podReceived && ["pending", "missing", "needed"].includes(pod) && deliveryReported;
  const pickedUp = deliveryOutForDelivery || deliveryReported || ["done", "picked-up", "loaded", "recovered"].includes(pickup);
  const driverOnsite = !pickedUp && ["driver-onsite", "onsite"].includes(pickup);
  const storage = shipment.storage || shipment.opsState?.storage || shipment.canonical?.storage || {};
  const arrivalGate = {
    status: arrival,
    rawStatus: canonicalGate(shipment, "arrival")?.rawStatus || arrival,
    evidence: canonicalGate(shipment, "arrival")?.evidence || "",
    summary: canonicalGate(shipment, "arrival")?.summary || "",
    reason: canonicalGate(shipment, "arrival")?.reason || "",
  };
  const canonicalArrivalMissing = canonicalArrivalHardMissing(shipment, { arrival: arrivalGate });
  const storageImpliesArrival = !canonicalArrivalMissing && Boolean(
    storage.storageAccruingSince ||
    storage.storageStartsAt ||
    storage.lastFreeDay ||
    String(storage.status || "").toLowerCase() === "accruing" ||
    String(shipment.operationalRisk?.type || shipment.opsState?.operationalRisk?.type || "").toLowerCase() === "storage-accruing"
  );
  const explicitCustomsStatuses = [
    shipment.clearanceStatus,
    shipment.customsBroker?.status,
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  const directReleaseRowsPresent = hasDirectCustomsReleaseEvidence(shipment);
  const explicitCustomsStatusBlocked = explicitCustomsStatuses.some(explicitCustomsStatusLooksBlocked);
  const activeCustomsHoldEvidence = explicitCustomsStatusBlocked || [
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.nextAction,
    ...(shipment.facts || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.opsState?.exceptions || []),
  ].some((item) => {
    const text = typeof item === "string" ? item : factRowText(item);
    if (genericReleasePendingCustomsHoldText(text)) return false;
    return (EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(text) ||
      /\b(?:true customs\/government hold|customs\/government hold|u\.?s\.? customs wants? to examine|customs wants? to examine|government hold|exam hold|hold not removed|remove th?e?\s+hold|cannot pick up|can'?t pick up)\b/i.test(text)) &&
      !/\b(?:hold removed|hold released|exam cleared|customs hold cleared|released after hold|hold lifted)\b/i.test(text);
  });
  const arrivalProofLooksRequestedOrFuture = (text) =>
    /\b(?:await|awaiting|will await|wait(?:ing)? for|wait on|need|needs|needed|request(?:ed)?|please (?:send|provide|confirm)|looking for|missing|pending)\b[^.\n;]{0,120}\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability|available)\b/i.test(text) ||
    /\b(?:arrival notice|notice of arrival|\bnoa\b|on[-\s]?hand|availability|available)\b[^.\n;]{0,120}\b(?:needed|requested|missing|pending|not received|not yet received|not provided)\b/i.test(text) ||
    /\b(?:once|when|after)\b[^.\n;]{0,80}\b(?:delivered to|arrives? at|arrival|on[-\s]?hand|available)\b/i.test(text);
  const directArrivalEvidenceText = [
    shipment.detail,
    shipment.tms?.tmsStatus,
    ...(shipment.timeline || []).flatMap((item) => Array.isArray(item) ? item : [item]),
    shipment.tracking?.status,
    shipment.tracking?.summary,
    shipment.tracking?.latestEvent,
    shipment.tracking?.details,
    ...(shipment.statusAudit?.evidence || [])
      .filter((item) => /\b(?:tms|tracking|carrier|cargo|united|forward air|airline)\b/i.test(`${item.source || ""} ${item.label || ""}`))
      .map((item) => `${item.source || ""} ${item.label || ""} ${item.note || ""}`),
  ].filter(Boolean).join(" ");
  const positiveArrivalEventRows = [
    ...(shipment.opsState?.events || []),
    ...(shipment.facts || []),
  ]
    .filter((item) => {
      const text = factRowText(item);
      const identity = `${item?.type || ""} ${item?.label || ""}`;
      return /\b(?:arrival[-_\s]?notice[-_\s]?received|station[-_\s]?arrival[-_\s]?confirmed|arrival[-_\s]?confirmed)\b/i.test(identity) &&
        /\b(?:arrival[-_\s]?notice[-_\s]?received|station[-_\s]?arrival[-_\s]?confirmed|arrival\/on[-\s]?hand evidence was received|arrival evidence found|notice of arrival|arrival notice confirms|available for pickup)\b/i.test(text) &&
        !arrivalProofLooksRequestedOrFuture(text) &&
        !/\b(?:requested, not proven|not proven|not[-\s]?arrived|arrival pending|pending arrival|eta only|scheduled arrival|future arrival|no (?:station\/)?on[-\s]?hand proof|missing (?:station\/)?on[-\s]?hand proof)\b/i.test(text);
    })
    .map(factRowText);
  const positiveArrivalEventEvidence = positiveArrivalEventRows.some((row) =>
    /\b(?:arrival[-_\s]?notice[-_\s]?received|station[-_\s]?arrival[-_\s]?confirmed|arrival\/on[-\s]?hand evidence was received|arrival evidence found|notice of arrival|arrival notice confirms|available for pickup)\b/i.test(row),
  );
  const directArrivalEvidence =
    positiveArrivalEventEvidence ||
    (!canonicalArrivalMissing &&
    (
      /\b(?:arrived|arr@dest|ready for pickup|available for pickup|on[-\s]?hand|recover(?:ed)?|recovery complete)\b/i.test(directArrivalEvidenceText) &&
      !/\b(?:not[-\s]?arrived|not arrived|arrival pending|pending arrival|depart(?:ed|ure)?|scheduled|eta only|no reliable arrival|not available)\b/i.test(directArrivalEvidenceText)
    ));
  const canonicalCustomsEvidenceText = [
    customs,
    canonicalGate(shipment, "customs")?.summary,
    canonicalGate(shipment, "customs")?.evidence,
    shipment.customsBroker?.status,
    shipment.customsBroker?.brokerStatus,
    ...(shipment.opsState?.events || [])
      .filter((event) => /customs|release|clearance|d\/?o|delivery order|status request|1c/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
  ].filter(Boolean).join(" ");
  const explicitCustomsReleasedStatus = directReleaseRowsPresent && explicitCustomsStatuses.some(explicitCustomsStatusLooksReleased);
  const releaseEvidenceRows = [
    customs,
    canonicalGate(shipment, "customs")?.summary,
    canonicalGate(shipment, "customs")?.evidence,
    shipment.clearanceStatus,
    shipment.customsBroker?.status,
    shipment.customsBroker?.brokerStatus,
    shipment.customsBroker?.nextAction,
    ...(shipment.customsBroker?.evidence || [])
      .map((item) => typeof item === "string" ? item : `${item.label || ""} ${item.note || ""} ${item.summary || ""} ${item.status || ""}`),
    shipment.detail,
    shipment.tms?.tmsStatus,
    ...(shipment.timeline || []).flatMap((item) => Array.isArray(item) ? item : [item]),
    ...(shipment.facts || [])
      .filter((fact) => /customs|release|clearance|d\/?o|delivery order|1c|tms|tracking/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`))
      .map((fact) => factRowText(fact)),
    ...(shipment.opsState?.events || [])
      .filter((event) => /customs|release|clearance|d\/?o|delivery order|1c/i.test(`${event.type || ""} ${event.summary || ""} ${event.evidence || ""}`))
      .map((event) => factRowText(event)),
  ].filter(Boolean);
  const canonicalGateDirectReleaseEvidence =
    ["done", "released", "cleared"].includes(customs) &&
    /\b(?:gmail-proof|gmail-message|operator-note|canonical-shipment-pipeline)\b/i.test(
      `${canonicalGate(shipment, "customs")?.source || ""} ${canonicalCustomsEvidenceText}`,
    ) &&
    (
      hasStrongCustomsReleaseText(canonicalCustomsEvidenceText) ||
      /\b(?:release\/?d\.?o|customs release|delivery order|d\/?o)\b/i.test(canonicalCustomsEvidenceText)
    ) &&
    !staleReleaseBlockerInstruction(canonicalCustomsEvidenceText) &&
    !/\b(?:not released|not cleared|release pending|clearance pending|release missing|d\/?o missing|delivery order missing|awaiting release|waiting for release|unconfirmed release)\b/i.test(canonicalCustomsEvidenceText);
  const releaseRowsPresent = directReleaseRowsPresent || canonicalGateDirectReleaseEvidence;
  const rowHasFinalCustomsRelease = (row) =>
    releaseRowsPresent &&
    (/^(?:released|cleared|done)$/i.test(String(row || "")) || hasStrongCustomsReleaseText(row)) &&
    !factLooksNonFinalCustomsRelease(row) &&
    !/\b(?:not released|release pending|customs hold|exam hold|hold not removed|cannot release)\b/i.test(String(row || ""));
  const strongFinalReleaseRow = releaseEvidenceRows.some(rowHasFinalCustomsRelease);
  const canonicalCustomsLooksNonFinal =
    !strongFinalReleaseRow &&
    factLooksNonFinalCustomsRelease(canonicalCustomsEvidenceText);
  const emailReleaseBlocker = authoritativeEmailReleaseBlocker(shipment);
  const unsupportedCustomsBlockerEvidence =
    factLooksUnreadableAttachmentNoise(canonicalCustomsEvidenceText) ||
    /\bcustoms hold in control-room inventory\b/i.test(canonicalCustomsEvidenceText);
  const explicitBlockerRows = [canonicalCustomsEvidenceText, ...releaseEvidenceRows]
    .filter((row) => !genericReleasePendingCustomsHoldText(row) && !factLooksUnreadableAttachmentNoise(row) && !generatedCustomsHoldSummaryWithoutSourceText(row) && !/\bcustoms hold in control-room inventory\b/i.test(row));
  const rawExplicitCustomsBlockerEvidence =
    explicitCustomsStatusBlocked ||
    explicitBlockerRows.some((row) => EXPLICIT_CUSTOMS_BLOCKER_PATTERN.test(row));
  const customsBlockerOverridesRelease = !explicitCustomsReleasedStatus;
  const explicitCustomsBlockerEvidence = rawExplicitCustomsBlockerEvidence && customsBlockerOverridesRelease;
  const canonicalCustomsDoneStatus = releaseRowsPresent && ["done", "released", "cleared"].includes(customs) && !emailReleaseBlocker && !explicitCustomsBlockerEvidence;
  const directCustomsReleaseEvidence = releaseRowsPresent && !emailReleaseBlocker && !explicitCustomsBlockerEvidence && (explicitCustomsReleasedStatus || strongFinalReleaseRow || canonicalGateDirectReleaseEvidence);
  const arrived =
    deliveryReported ||
    pickedUp ||
    driverOnsite ||
    storageImpliesArrival ||
    directArrivalEvidence ||
    (!canonicalArrivalMissing && ["done", "arrived", "available", "on-hand", "incomplete"].includes(arrival));
  const arrivalIncomplete = arrived && ["incomplete", "blocked", "partial"].includes(arrival);
  const airportExecutionReached = pickedUp || deliveryReported || podReceived || completed;
  const emailReleaseBlockerIsHold = emailReleaseBlocker && releaseBlockerRowGateStatus(emailReleaseBlocker) === "blocked";
  const customsHold = !airportExecutionReached && !canonicalCustomsDoneStatus && !directCustomsReleaseEvidence && (explicitCustomsBlockerEvidence || emailReleaseBlockerIsHold || (customsBlockerOverridesRelease && activeCustomsHoldEvidence) || (!unsupportedCustomsBlockerEvidence && ["blocked", "hold", "customs-hold", "exam-hold"].includes(customs)));
  const canonicalCustomsDone =
    canonicalCustomsDoneStatus ||
    (releaseRowsPresent && !emailReleaseBlocker && !explicitCustomsBlockerEvidence && (
      explicitCustomsReleasedStatus ||
      (["done", "released", "cleared"].includes(customs) && (!canonicalCustomsLooksNonFinal || strongFinalReleaseRow))
    ));
  const customsBrokerRelease = airportExecutionReached || (!customsHold && (directCustomsReleaseEvidence || canonicalCustomsDone));
  const brokerReleasePending = !airportExecutionReached && arrived && !customsBrokerRelease && !customsHold && ["pending", "waiting", "missing"].includes(customs);
  const groundPaid = airportExecutionReached || ["done", "paid"].includes(fees);
  const groundDue = !airportExecutionReached && !groundPaid && ["due", "pending", "unpaid"].includes(fees);
  const stationReleaseReady = arrived && customsBrokerRelease && !arrivalIncomplete;
  const pickupBlocked = !pickedUp && ["blocked", "exception"].includes(pickup);
  const dispatchDone = ["done", "sent", "broker-awarded", "awarded", "dispatched"].includes(dispatch);
  const pickupEvidence = [
    canonicalGate(shipment, "pickup")?.evidence,
    canonicalGate(shipment, "pickup")?.summary,
  ].filter(Boolean).join(" ");
  const loadingProblem = pickupBlocked && /\b(?:loading|load|pallets? do not fit|cannot load|can'?t load|not loaded|refused? load|doesn'?t fit|won'?t fit)\b/i.test(pickupEvidence);
  const releasePackageReady =
    arrived &&
    !arrivalIncomplete &&
    customsBrokerRelease &&
    !customsHold &&
    !pickupBlocked &&
    (groundPaid || !groundDue);
  const deliveryScheduledDate =
    canonicalGateDate(shipment, ["delivery"], ["deliveryScheduledDate", "scheduledDate", "deliveryDate", "appointmentDate"]) ||
    canonicalGateDate(shipment, ["pickup", "dispatch"], ["deliveryScheduledDate", "deliveryDate"]);
  const pickupScheduled = !pickedUp && ["scheduled", "planned", "deferred"].includes(pickup);
  const pickupScheduledDate = pickupScheduled
    ? canonicalGateDate(shipment, ["pickup"], ["pickupScheduledDate", "scheduledDate", "appointmentDate", "deliveryScheduledDate"])
    : "";
  return {
    completed,
    arrived,
    arrivalIncomplete,
    customsHold,
    brokerReleasePending,
    customsBrokerRelease,
    stationReleaseReady,
    groundPaid,
    groundDue,
    pickedUp,
    pickupBlocked,
    dispatchDone,
    pickupScheduled,
    pickupScheduledDate,
    driverOnsite,
    loadingProblem,
    deliveryProblem: ["blocked", "exception", "problem"].includes(delivery),
    deliveryOutForDelivery,
    releasePackageReady,
    deliveryReported,
    podReceived,
    podPending,
    deliveryScheduledToday: Boolean(deliveryScheduledDate && deliveryScheduledDate === operatorDateKey(new Date())),
    deliveryScheduledDate,
  };
}

function pickupProblemReason(shipment) {
  const gates = gateState(shipment);
  if (!gates.arrived || gates.arrivalIncomplete || gates.customsHold || gates.completed) return "";
  if (shipmentStateFacts(shipment).some((row) => resolvedPickupBlockerInstruction(row.text))) return "";
  if (shipment.opsState?.source === "canonical-shipment-pipeline") {
    const pickup = String(canonicalGate(shipment, "pickup")?.status || "").toLowerCase();
    if (!["blocked", "exception"].includes(pickup)) return "";
    return canonicalGate(shipment, "pickup")?.evidence || "pickup is blocked at the station";
  }
  const resolved = resolveShipmentState(shipment);
  const text = pickupExecutionText(shipment);
  if (resolved.pickedUp || resolved.delivered || resolved.deliveryScheduledToday) return "";
  if (PICKUP_BLOCKER_PATTERN.test(text)) {
    if (/\b(?:piece[-\s]?count|pieces?|3[-\s]?v(?:s|ersus)[-\s]?4|3[-\s]?vs[-\s]?4)\b/i.test(text)) {
      return "pickup is blocked by a station piece-count mismatch";
    }
    return "pickup is blocked at the station";
  }
  if (resolved.activePickupBlocker) return "driver is waiting because the station cannot release/clear the shipment";
  const driverReleased = /\b(?:driver|drivers?)\b[^.;\n]{0,80}\b(?:released|left|stood down|sent away)\b|\b(?:release|released|stand down|stood down)\b[^.;\n]{0,80}\b(?:driver|drivers?)\b|\bdo not dispatch\b|\bdo not send (?:the )?driver\b/i.test(text);
  if (driverReleased) return "";
  const driverLive = /\b(?:driver|truck|trucker)\b[^.;\n]{0,100}\b(?:on[-\s]?site|at (?:airport|station|warehouse|pickup)|checked[-\s]?in|waiting|standby|sitting|detention|cannot pickup|can'?t pickup|pickup blocked|not loaded|loading blocked|refused (?:to )?(?:load|pickup))\b|\b(?:on[-\s]?site|checked[-\s]?in|waiting in line|waiting to be loaded|standby|detention)\b[^.;\n]{0,100}\b(?:driver|truck|trucker)\b/i.test(text);
  if (!driverLive) return "";
  const stationCannotSeeRelease = /\b(?:station|carrier|airline|warehouse|agent|terminal)\b[^.;\n]{0,100}\b(?:not|does not|doesn'?t|cannot|can'?t|won'?t|will not|refus(?:e|ed|ing))\b[^.;\n]{0,100}\b(?:see|show|have|find|release|clearance|clear|d\/?o|delivery order)\b/i.test(text);
  const releaseNotVisible = /\b(?:release|clearance|customs release|d\/?o|delivery order)[^.;\n]{0,100}\b(?:not|isn'?t|is not|does not|doesn'?t|cannot|can'?t|missing|pending)[^.;\n]{0,70}\b(?:system|visible|show|showing|seen|found|available|accepted|released|cleared)\b/i.test(text);
  const holdBlocking = /\b(?:customs hold|\b1[-\s]?h\b|hold not removed|not released|not cleared|release pending|clearance pending)\b/i.test(text);
  const doProblem = /\b(?:d\/?o|delivery order)[^.;\n]{0,100}\b(?:wrong|incorrect|bad|invalid|missing|does not state|doesn'?t state|no driver name|wrong driver|driver name missing|needs? (?:to be )?corrected|needs? correction|please correct|must correct|reissue|re-send|resend)\b|\b(?:wrong|incorrect|bad|invalid|missing|no driver name|wrong driver|driver name missing|needs? (?:to be )?corrected|needs? correction|please correct|must correct|reissue|re-send|resend)[^.;\n]{0,100}\b(?:d\/?o|delivery order)\b/i.test(text);
  if (doProblem) return "driver is waiting because the DO is wrong or missing driver details";
  if (gates.customsBrokerRelease && !stationCannotSeeRelease) return "";
  if (stationCannotSeeRelease || releaseNotVisible || holdBlocking) return "driver is waiting because the station cannot release/clear the shipment";
  return "";
}

function storageLine(shipment, memory = null) {
  return storageTiming(shipment, memory).line;
}

function shipmentStorageMemory(shipment, memory) {
  const awb = normalizeAwb(shipment?.awb);
  if (!awb) return null;
  const matchesAwb = (value) => normalizeAwb(value).includes(awb) || String(value || "").replace(/\D/g, "").includes(awb);
  return (memory?.stationMemory?.contacts || []).find((contact) => {
    const storage = contact.storage || {};
    return [storage.lastFreeDayRule, storage.dailyStorageRate, storage.source, contact.source]
      .some((value) => matchesAwb(value));
  })?.storage || null;
}

function storageTiming(shipment, memory = null) {
  const storage = shipment.storage || {};
  const remembered = shipmentStorageMemory(shipment, memory);
  const rememberedText = remembered ? [remembered.lastFreeDayRule, remembered.dailyStorageRate, remembered.source].filter(Boolean).join(" ") : "";
  const text = [statusText(shipment), rememberedText].filter(Boolean).join(" ");
  const starts = storage.storageStartsAt || findDate(rememberedText, /storage starts?(?: at| on)?/i) || findDate(text, /storage starts?(?: at| on)?/i);
  const lfd = storage.lastFreeDay || findDate(text, /last free(?: day)?/i);
  const accruing = storage.storageAccruingSince || findDate(text, /storage accru(?:ing|es)? since/i);
  const rate = storage.dailyStorageRate || findRate(remembered?.dailyStorageRate) || remembered?.dailyStorageRate || findRate(text);
  const startsDays = daysUntilDate(starts);
  const lfdDays = daysUntilDate(lfd);
  const active = Boolean(accruing) || (Number.isFinite(startsDays) && startsDays <= 0) || (Number.isFinite(lfdDays) && lfdDays < 0);
  const dueSoon = !active && ((Number.isFinite(startsDays) && startsDays <= 1) || (Number.isFinite(lfdDays) && lfdDays <= 0));
  let detail = "";
  if (accruing) detail = `accruing since ${formatDate(accruing)}`;
  else if (starts) detail = relativeStorageDate("starts", starts, startsDays);
  else if (lfd) detail = relativeStorageDate("LFD", lfd, lfdDays);
  else if (rate) detail = `${rate}; start date not confirmed`;
  return {
    line: detail ? `Storage: ${detail}${rate && !detail.includes(rate) ? ` · ${rate}` : ""}.` : "",
    starts,
    lfd,
    accruing,
    rate,
    active,
    dueSoon,
    daysUntilStart: startsDays,
    daysUntilLastFreeDay: lfdDays,
    daysSinceAccruing: Number.isFinite(daysUntilDate(accruing)) ? Math.max(0, -daysUntilDate(accruing)) : Infinity,
  };
}

function storageListCandidate(shipment, memory) {
  const gates = gateState(shipment);
  if (gates.completed || gates.deliveryReported || gates.pickedUp) return false;
  const storage = storageTiming(shipment, memory);
  return Boolean(storage.line && (storage.active || storage.dueSoon));
}

function shipmentOperationalRisk(shipment) {
  const risk = shipment.operationalRisk || shipment.opsState?.operationalRisk || shipment.canonical?.operationalRisk || null;
  const canonicalRisk = risk && typeof risk === "object" ? {
    level: String(risk.level || "none").toLowerCase(),
    type: risk.type || "",
    reason: risk.reason || "",
    action: risk.action || "",
    evidence: risk.evidence || "",
  } : { level: "none", type: "", reason: "", action: "", evidence: "" };
  if (canonicalRisk.level !== "none") return canonicalRisk;
  const state = shipmentExecutionState(shipment, { actions: [], outboxRequests: [] });
  const fallbackByPhase = {
    "storage-risk": ["high", "storage-risk"],
    "pickup-blocked": ["critical", "pickup-blocked"],
    "loading-blocked": ["critical", "loading-blocked"],
    "delivery-blocked": ["critical", "delivery-blocked"],
    "arrival-incomplete": ["high", "arrival-incomplete"],
    "release-needed": [state.pingLevel === "urgent" ? "high" : "none", "release-delay"],
    "fees-needed": ["medium", "fees-due"],
  };
  const [level = "none", type = ""] = fallbackByPhase[state.phase] || [];
  if (level === "none") return canonicalRisk;
  return {
    level,
    type,
    reason: state.problem || state.label || "",
    action: state.nextAction || "",
    evidence: state.problem || "",
  };
}

function operationalRiskCandidate(shipment, memory = null) {
  const gates = gateState(shipment);
  if (gates.completed) return false;
  if (!gates.deliveryReported && !gates.pickedUp && storageListCandidate(shipment, memory)) return true;
  const risk = shipmentOperationalRisk(shipment);
  if (risk.level === "none") return false;
  if (gates.deliveryReported || gates.pickedUp) return risk.type === "delivery-blocked";
  return true;
}

function operationalRiskScore(shipment) {
  const risk = shipmentOperationalRisk(shipment);
  const severity = { critical: 120, high: 90, medium: 60, low: 30 };
  return severity[risk.level] || 0;
}

function storagePingLevel(storageInfo) {
  if (!storageInfo?.active && !storageInfo?.dueSoon) return "quiet";
  if (storageInfo.dueSoon) return "urgent";
  const activeDays = [
    storageInfo.daysSinceAccruing,
    Number.isFinite(storageInfo.daysUntilStart) ? Math.max(0, -storageInfo.daysUntilStart) : Infinity,
    Number.isFinite(storageInfo.daysUntilLastFreeDay) ? Math.max(0, -storageInfo.daysUntilLastFreeDay) : Infinity,
  ].filter(Number.isFinite);
  const youngestActiveDays = activeDays.length ? Math.min(...activeDays) : 0;
  return youngestActiveDays <= 1 ? "urgent" : "quiet";
}

function cargoLine(shipment) {
  const tms = shipment.tms || {};
  const cargo = shipment.cargo || {};
  const flightDetails = shipment.flightDetails || {};
  const text = statusText(shipment);
  const pieces =
    cargo.pieces ||
    tms.pieces ||
    String(text).match(/\b(\d+)\s*(?:pcs?|pieces?)\b/i)?.[1] ||
    "";
  const weightWithUom = (value, uom) => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/\b(?:kg|kgs|lb|lbs)\b/i.test(raw)) return raw;
    const parsed = Number(raw.replace(/,/g, ""));
    return Number.isFinite(parsed) && uom
      ? `${parsed.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${uom}`
      : raw;
  };
  const weight =
    cargo.weight && cargo.weightUom && !/\b(?:kg|kgs|lb|lbs)\b/i.test(cargo.weight)
      ? weightWithUom(cargo.weight, cargo.weightUom)
      : tms.weight && tms.weightUom && !/\b(?:kg|kgs|lb|lbs)\b/i.test(tms.weight)
        ? weightWithUom(tms.weight, tms.weightUom)
        : cargo.weight || tms.weight || String(text).match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:kg|kgs|lb|lbs)\b/i)?.[0] || "";
  const dims = cargo.dims || cargo.dimensions || tms.dims || tms.dimensions || String(text).match(/\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?:\s*(?:in|cm))?\b/i)?.[0] || "";
  const cargoParts = [
    pieces ? `${pieces} pc${String(pieces) === "1" ? "" : "s"}` : "",
    weight,
    dims ? `dims ${dims}` : "",
  ].filter(Boolean);
  const flightValue = unique([
    flightDetails.primaryFlight,
    ...(Array.isArray(flightDetails.flights) ? flightDetails.flights.map((item) => typeof item === "string" ? item : item?.flight) : []),
    tms.flight,
    tms.flightNumber,
    flightDetails.tmsFlight,
    tms.tmsFlight,
  ]).filter(Boolean).join(", ");
  const route = flightDetails.route || shipment.route || tms.route || [shipment.origin || tms.origin, shipment.destination || tms.destination || shipment.station].filter(Boolean).join("-");
  const deliveryAddress = shipment.delivery?.fullAddress || "";
  const lines = [
    cargoParts.length ? `Cargo: ${cargoParts.join(" · ")}.` : "",
    flightValue ? `Flight: ${flightValue}.` : "",
    route ? `Route: ${route}.` : "",
    deliveryAddress ? `Deliver to: ${compact(deliveryAddress, 110)}.` : "",
  ].filter(Boolean);
  return lines.join(" ");
}

function formatCargoWeight(value, uom) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/\b(?:kg|kgs|lb|lbs)\b/i.test(raw)) return raw.replace(/\bkgs\b/i, "KG").replace(/\blbs\b/i, "LB");
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) && uom
    ? `${parsed.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${String(uom).toUpperCase()}`
    : raw;
}

function shipmentCargoFacts(shipment = {}) {
  const tms = shipment.tms || {};
  const cargo = shipment.cargo || {};
  const flightDetails = shipment.flightDetails || {};
  const text = statusText(shipment);
  const pieces = cargo.pieces || tms.pieces || String(text).match(/\b(\d+)\s*(?:pcs?|pieces?)\b/i)?.[1] || "";
  const weight = cargo.weight
    ? formatCargoWeight(cargo.weight, cargo.weightUom || tms.weightUom)
    : tms.weight
      ? formatCargoWeight(tms.weight, tms.weightUom || cargo.weightUom)
      : String(text).match(/\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:kg|kgs|lb|lbs)\b/i)?.[0] || "";
  const dims = cargo.dims || cargo.dimensions || tms.dims || tms.dimensions || String(text).match(/\b\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?(?:\s*(?:in|cm))?\b/i)?.[0] || "";
  const flightValues = unique([
    flightDetails.primaryFlight,
    ...(Array.isArray(flightDetails.flights) ? flightDetails.flights.map((item) => typeof item === "string" ? item : item?.flight) : []),
    tms.flight,
    tms.flightNumber,
    flightDetails.tmsFlight,
    tms.tmsFlight,
  ].filter(Boolean));
  const flightTokens = unique(flightValues.flatMap((value) =>
    String(value || "").match(/\b[A-Z0-9]{2}\s?\d{2,4}[A-Z]?\b/gi) || [String(value || "").trim()]
  ).map((value) => value.replace(/\s+/g, "").toUpperCase()).filter(Boolean));
  const route = flightDetails.route || shipment.route || tms.route || [shipment.origin || tms.origin, shipment.destination || tms.destination || shipment.station].filter(Boolean).join("-");
  return {
    pieces: String(pieces || "").trim(),
    weight: String(weight || "").trim(),
    dims: String(dims || "").trim(),
    flight: flightTokens.join(" / "),
    route: String(route || "").trim(),
    origin: String(shipment.origin || tms.origin || "").trim(),
    destination: String(shipment.destination || tms.destination || shipment.station || "").trim(),
    deliveryAddress: String(shipment.delivery?.fullAddress || shipment.delivery?.address || tms.deliveryAddress || "").trim(),
    shipper: String(shipment.shipper?.name || shipment.shipper || tms.shipper || "").trim(),
    consignee: String(shipment.consignee || shipment.client || tms.consignee || "").trim(),
  };
}

function findDate(text, prefixPattern) {
  const value = String(text || "");
  const prefix = value.match(new RegExp(`${prefixPattern.source}\\s*(?:is|:)?\\s*([A-Z][a-z]{2,8}\\.?\\s+\\d{1,2}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?)`, "i"));
  return prefix?.[1] || "";
}

function formatDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const date = new Date(`${text.slice(0, 10)}T12:00:00Z`);
    if (Number.isFinite(date.getTime())) {
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    }
  }
  return text.replace(/,\s*\d{4}\b/, "");
}

function etaPassedArrivalLine(shipment) {
  const key = etaDateKey(shipment);
  return key
    ? `ETA passed; no station arrival confirmation yet. ETA ${formatDate(key)}.`
    : "ETA passed; no station arrival confirmation yet.";
}

function relativeStorageDate(label, value, days) {
  if (!value) return "";
  if (!Number.isFinite(days)) return `${label} ${formatDate(value)}`;
  if (days < 0) return `${label} passed ${formatDate(value)}`;
  if (days === 0) return `${label} today`;
  if (days === 1) return `${label} tomorrow`;
  return `${label} ${formatDate(value)}`;
}

function daysUntilDate(value, now = new Date()) {
  const parsed = parseOperationalDate(value, now);
  if (!parsed) return Infinity;
  const todayParts = operatorDateParts(now);
  const today = todayParts
    ? Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day)
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = Date.UTC(parsed.year, parsed.month, parsed.day);
  return Math.round((target - today) / 86400000);
}

function parseOperationalDate(value, now = new Date()) {
  const text = String(value || "").trim();
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) };
  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (slash) {
    const rawYear = slash[3] ? Number(slash[3]) : operatorDateParts(now)?.year || now.getUTCFullYear();
    return {
      year: rawYear < 100 ? 2000 + rawYear : rawYear,
      month: Number(slash[1]) - 1,
      day: Number(slash[2]),
    };
  }
  const month = text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (!month) return null;
  const monthIndex = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(month[1].slice(0, 3).toLowerCase());
  if (monthIndex < 0) return null;
  return {
    year: month[3] ? Number(month[3]) : operatorDateParts(now)?.year || now.getUTCFullYear(),
    month: monthIndex,
    day: Number(month[2]),
  };
}

function findRate(text) {
  const match = String(text || "").match(/(?:USD\s*)?\$?\d[\d,]*(?:\.\d+)?\s*\/\s*(?:day|d)\b/i);
  if (!match) return "";
  return match[0].replace(/\s+/g, "").replace(/USD/i, "$").replace(/^\$\$/, "$");
}

function groundFeeFactRowText(fact = {}) {
  return [
    fact.type,
    fact.label,
    fact.summary,
    fact.note,
    fact.evidence,
    fact.claim,
    fact.rawSnippet,
  ].filter(Boolean).join(" ");
}

function groundFeeFactRowLooksRelevant(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/\b(?:pickup[_-\s]?quote|pickup quote|broker[-_\s]?awarded|pickup[_-\s]?broker[_-\s]?awarded|broker award|dispatch|pickup rate|recovery rate)\b/i.test(value)) {
    return false;
  }
  return /\b(?:total due|amount paid|payment delivered|ground fees?|station fees?|terminal fees?|handling fees?|warehouse fees?|cvf\/thc|cargosprint|cargo sprint|payment|receipt|invoice)\b/i.test(value);
}

function groundFeeAmountFromRow(text) {
  const value = String(text || "");
  for (const match of value.matchAll(/\$\s*\d[\d,]*(?:\.\d+)?/g)) {
    const amount = match[0].replace(/\s+/g, "");
    const before = value.slice(Math.max(0, match.index - 80), match.index);
    const around = value.slice(Math.max(0, match.index - 100), Math.min(value.length, match.index + match[0].length + 100));
    if (/\b(?:quote|quoted|rate is|pickup rate|recovery rate|approved for pickup|broker[-_\s]?awarded|dispatch)\b/i.test(before)) continue;
    if (/\b(?:total due|amount paid|payment delivered|ground fees?|station fees?|terminal fees?|handling fees?|warehouse fees?|cvf\/thc|cargosprint|cargo sprint|payment|receipt|invoice)\b/i.test(around)) {
      return amount;
    }
  }
  return "";
}

function groundFeeRowsForShipment(shipment) {
  return [
    shipment.lastEmail ? groundFeeFactRowText({ summary: shipment.lastEmail.summary }) : "",
    ...(shipment.facts || []).map(groundFeeFactRowText),
    ...(shipment.factLedger || []).map(groundFeeFactRowText),
    ...(shipment.evidencePacket?.sourceFacts || []).map(groundFeeFactRowText),
    ...Object.values(shipment.opsState?.gates || {})
      .filter((gate) => String(gate?.name || gate?.gate || "").toLowerCase() === "fees")
      .map(groundFeeFactRowText),
  ].filter(groundFeeFactRowLooksRelevant);
}

function groundFeeLine(shipment) {
  const feeRows = groundFeeRowsForShipment(shipment);
  const factText = feeRows.join(" ");
  const amount = feeRows.map(groundFeeAmountFromRow).find(Boolean) || "";
  if (/\b(?:payment status not proven|not proven|not confirmed|unpaid|pending|due|verify)\b.{0,100}\b(?:ground fees?|station fees?|handling fees?|isc|cargosprint|payment)\b|\b(?:ground fees?|station fees?|handling fees?|isc|cargosprint|payment)\b.{0,100}\b(?:not proven|not confirmed|unpaid|pending|due|verify)\b/i.test(factText)) {
    return `Ground fees: ${amount ? `${amount} ` : ""}due.`;
  }
  if (/\b(?:ground fees?|station fees?|handling fees?|cargosprint|payment|receipt).{0,80}(?:paid|confirmed|receipt)\b/i.test(factText)) {
    return `Ground fees: ${amount ? `${amount} paid` : "paid/confirmed"}.`;
  }
  if (/\b(?:total due|ground fees?|station fees?|handling fees?|cvf\/thc|cargosprint|payment).{0,80}(?:due|needed|pending|unpaid|before freight release)\b/i.test(factText)) {
    return `Ground fees: ${amount ? `${amount} ` : ""}due.`;
  }
  return "";
}

function pickupQuoteRows(shipment) {
  return [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
  ];
}

function pickupBrokerFromQuoteText(text) {
  const value = String(text || "");
  const profiles = [
    ["JD Direct", /\b(?:jd direct|j&d|jdirect|jddirect|alex rivers|ops@demo-direct\.example)\b/i],
    ["Meadow Freight", /\b(?:meadow freight|freightflex|jamie brooks|\bbroker@demo-freight\.example)\b/i],
    ["BTX Global", /\b(?:btx global|\bbtx\b|imports@demo-global\.example)\b/i],
    ["Juniper Logistics", /\b(?:juniper logistics?|juniper logistic solutions)\b/i],
  ];
  return (profiles.find(([, pattern]) => pattern.test(value)) || [])[0] || "";
}

function customsReleaseOnlyQuoteText(text) {
  const value = String(text || "");
  const hasPickupContext = /\b(?:can recover|can pick\s*up|pickup rate|recovery rate|cartage rate|driver|truck|sprinter|box truck|straight truck|pickup quote|pickup\/delivery|recover today|recover tomorrow)\b/i.test(value);
  if (hasPickupContext) return false;
  const hasCustomsReleaseContext =
    /\b(?:cargo release update|entry no\.?|entry type|broker ref\.?|master b\/l|house b\/l|customs release|d\/?o and clearance|delivery order attached|entered value|quantity unit|1c\s+(?:entered|confirmed|posted))\b/i.test(value);
  if (!hasCustomsReleaseContext) return false;
  return /\b(?:rate quote constitutes acceptance|receipt of this rate quote|booking of cargo after receipt|entered value|total entered value|importer|broker ref\.?|quantity unit)\b/i.test(value) ||
    /\$\s*\d{2,3},\d{3}(?:\.\d+)?/.test(value);
}

function stationConfirmationRequestText(text) {
  const value = String(text || "");
  return /\b(?:please\s+)?confirm\b[^.\n;]{0,120}\b(?:on[-\s]?hand|arrival notice|notice of arrival|\bnoa\b|availability|available|pieces?|storage|ground fees?)\b/i.test(value) ||
    /\bshare\b[^.\n;]{0,80}\b(?:arrival notice|notice of arrival|\bnoa\b)\b/i.test(value);
}

function stationOrAirlineAwardNoise(text, broker = "", email = "") {
  const value = String(text || "");
  const identity = `${broker || ""} ${email || ""} ${value}`;
  if (/\b(?:izjfk|izimportjfk|izexportjfk|wfs|worldwide flight services|united cargo|forward air|air general)\b/i.test(identity) &&
    !PICKUP_BROKER_PATTERN.test(String(broker || ""))) {
    return true;
  }
  if (/@(?:wfs\.aero|unitedhq\.com|united\.com|airgeneral\.com|forwardair\.com)\b/i.test(identity) &&
    !PICKUP_BROKER_PATTERN.test(String(broker || ""))) {
    return true;
  }
  return /\b(?:piece[-\s]?count|pieces?|mismatch|availability|on[-\s]?hand|arrival notice|notice of arrival|\bnoa\b)\b/i.test(value) &&
    !/\b(?:quote|rate|approved rate|please proceed|go ahead|award|awarded)\b/i.test(value);
}

function pickupQuoteFacts(shipment) {
  return pickupQuoteRows(shipment)
    .map((row) => {
      const text = factRowText(row);
      const quoteText = `${row?.type || ""} ${row?.label || ""} ${text}`;
      if (!/\b(?:pickup[-\s]?quote[-\s]?received|quoted|quote|rate)\b/i.test(quoteText)) return null;
      if (customsReleaseOnlyQuoteText(quoteText)) return null;
      const broker = row?.broker || pickupBrokerFromQuoteText(quoteText);
      const amount = row?.amount || row?.rate || quoteText.match(/\$\s*\d[\d,]*(?:\.\d+)?/)?.[0] || "";
      const email = row?.contactEmail || row?.email || quoteText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
      if (!broker || !amount) return null;
      return {
        broker,
        amount: String(amount || "").trim(),
        email,
        contactEmail: email,
        service: row?.service || row?.summary || "",
        quotedAt: row?.at || row?.quotedAt || "",
        text: quoteText,
      };
    })
    .filter(Boolean);
}

function pickupQuotes(shipment) {
  const quotes = [
    ...(shipment.freightBroker?.quotes || []),
    ...(shipment.brokerDispatch?.quotes || []),
    ...(shipment.quotes || []),
    ...pickupQuoteFacts(shipment),
  ];
  const seen = new Set();
  return quotes
    .map((quote) => {
      const broker = quote.broker || quote.name || quote.targetName || "";
      const amount = quote.amount || quote.rate || quote.price || quote.quote || "";
      const email = quote.email || quote.contactEmail || quote.targetEmail || "";
      const text = `${broker} ${amount} ${quote.service || ""} ${quote.context || ""}`;
      return { broker, amount: String(amount || "").trim(), email, contactEmail: email, text };
    })
    .filter((quote) => quote.broker || quote.amount)
    .filter((quote) => PICKUP_BROKER_PATTERN.test(quote.text) || !AIR_BOOKING_PATTERN.test(` ${quote.text} `))
    .filter((quote) => !AIR_BOOKING_PATTERN.test(` ${quote.text} `) || PICKUP_BROKER_PATTERN.test(quote.text))
    .filter((quote) => {
      const key = `${String(quote.broker || "").toLowerCase()}|${String(quote.amount || "").replace(/\s+/g, "")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanSelectedBrokerName(value) {
  return String(value || "")
    .replace(/\b(?:unless|if|but|when|after)\b.*$/i, "")
    .replace(/\b(?:was|is|has been)?\s*(?:approved|awarded|selected|chosen)\s+(?:for|to)\s+(?:pickup|recover|recovery|dispatch)\b.*$/i, "")
    .replace(/\b(?:approved|awarded|selected|chosen)\s+(?:pickup|broker|carrier)\b.*$/i, "")
    .replace(/\b(?:alex|jordan|moria|skyler|operator|team)\b\s*$/i, "")
    .replace(/\s+\$\s*\d+(?:,\d{3})*(?:\.\d+)?\b.*$/i, "")
    .replace(/\s+\d+(?:,\d{3})*(?:\.\d+)?\s*(?:usd|dollars?)\b.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[.;:, -]+$/g, "")
    .trim();
}

function selectedBrokerFromFact(text) {
  const value = String(text || "");
  const patterns = [
    /\b(?:award remains|selected broker|awarded broker)\s+([A-Z][A-Za-z0-9& ./'-]{2,55}?)(?:\s+unless|\s+if|\s+but|\s+when|\s+after|\s+\$|\s+\d+(?:,\d{3})*(?:\.\d+)?\s*(?:usd|dollars?)?\b|[.;]|$)/i,
    /\b(?:alex|jordan|moria|skyler|operator|team)\s+(?:approved|awarded|selected)\s+([A-Z][A-Za-z0-9& ./'-]{2,55}?)(?:\s+\$|\s+\d+(?:,\d{3})*(?:\.\d+)?\s*(?:usd|dollars?)?\b|[.;]|$)/i,
    /\b(?:approved|awarded|selected)\s+([A-Z][A-Za-z0-9& ./'-]{2,55}?)(?:\s+\$|\s+\d+(?:,\d{3})*(?:\.\d+)?\s*(?:usd|dollars?)?\b|[.;]|$)/i,
    /\b([A-Z][A-Za-z0-9& ./'-]{2,55}?)\s+(?:was\s+)?(?:approved|awarded|selected)\b/i,
  ];
  for (const pattern of patterns) {
    const broker = cleanSelectedBrokerName(value.match(pattern)?.[1] || "");
    if (!broker || /^(?:alex|jordan|moria|skyler|operator|team|broker|award|selected)$/i.test(broker)) continue;
    if (!PICKUP_BROKER_PATTERN.test(broker)) continue;
    return broker;
  }
  return "";
}

function pickupAwardAmountFromText(text) {
  return String(text || "").match(/\$\s*\d+(?:,\d{3})*(?:\.\d+)?/)?.[0] || "";
}

function activeQueuedAction(row) {
  const text = [
    row?.status,
    row?.queuedAt,
    row?.draftedAt,
    row?.sentAt,
    row?.agentJobId,
  ].filter(Boolean).join(" ");
  if (/\b(?:failed|blocked|cancelled|canceled|dismissed|expired)\b/i.test(text)) return false;
  return /\b(?:queued|drafted|sent|approved|running|done|completed|created|ready)\b/i.test(text) ||
    Boolean(row?.queuedAt || row?.draftedAt || row?.sentAt || row?.agentJobId);
}

function selectedPickupAwardFromActions(shipment, actions = {}) {
  const rows = queuedActionRowsForShipment(shipment, actions)
    .filter((row) => activeQueuedAction(row))
    .filter((row) => {
      const text = [
        row.type,
        row.label,
        row.subject,
        row.reason,
        row.body,
        row.execution,
      ].filter(Boolean).join(" ");
      return /\bbroker-award\b|\bpickup award\b|\baward\b[^.\n]{0,60}\b(?:pickup|broker)\b|\b(?:pickup|broker)\b[^.\n]{0,60}\baward\b/i.test(text);
    })
    .sort((a, b) => factTime(b.sentAt || b.draftedAt || b.queuedAt || b.createdAt) - factTime(a.sentAt || a.draftedAt || a.queuedAt || a.createdAt));
  for (const row of rows) {
    const email = row.targetEmail || row.to || row.originalTargetEmail || "";
    const broker = cleanSelectedBrokerName(row.targetName || row.originalTargetName || row.brokerName || "");
    const fallbackBroker = broker || (email && !isOperatorEmail(email) ? email : "");
    if (!fallbackBroker || isOperatorContactName(fallbackBroker)) continue;
    const at = row.sentAt || row.draftedAt || row.queuedAt || row.createdAt || "";
    return {
      broker: fallbackBroker,
      email: isOperatorEmail(email) ? "" : email,
      amount: row.amount || row.quoteAmount || pickupAwardAmountFromText(`${row.label || ""} ${row.subject || ""} ${row.body || ""}`),
      reason: `${fallbackBroker} already has a queued/drafted pickup award.`,
      source: "outbox-status",
      at,
    };
  }
  return null;
}

function selectedPickupAward(shipment, actions = null) {
  const actionAward = actions ? selectedPickupAwardFromActions(shipment, actions) : null;
  const candidates = actionAward ? [actionAward] : [];
  const facts = shipmentStateFacts(shipment)
    .filter((fact) => /\b(?:broker-awarded|selected broker|awarded broker|award remains|approved|please proceed|go ahead)\b/i.test(fact.text))
    .filter((fact) => !stationConfirmationRequestText(fact.text))
    .sort((a, b) => b.time - a.time);
  const event = (shipment.emailValidation?.events || [])
    .filter((item) => {
      if (item.type !== "broker-awarded") return false;
      const broker = item.selectedBroker || item.broker || "";
      const email = item.contactEmail || "";
      const text = [item.subject, item.summary, item.evidence, item.from, item.to].filter(Boolean).join(" ");
      if (isOperatorEmail(email) && isOperatorContactName(broker || item.from || item.to)) return false;
      if (stationConfirmationRequestText(text)) return false;
      if (stationOrAirlineAwardNoise(text, broker, email)) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""))[0] || null;
  const eventBroker = event?.selectedBroker || event?.broker || "";
  const eventEmail = event?.contactEmail || "";
  const eventAmount = event?.amount || "";
  if (eventBroker || eventEmail) {
    candidates.push({
      broker: eventBroker || eventEmail,
      email: eventEmail,
      amount: eventAmount,
      reason: `${eventBroker || "Broker"} was already approved by the team${eventAmount ? ` at ${eventAmount}` : ""}.`,
      source: "shipment-events",
      at: event?.at || "",
    });
  }
  for (const fact of facts) {
    const text = fact.text;
    const quoteSelectedByName = pickupQuotes(shipment).find((quote) => {
      const brokerName = quote.broker || "";
      if (!brokerName) return false;
      const broker = escapeRegExp(brokerName);
      return new RegExp(
        `(?:${broker}.{0,35}\\b(?:approved|awarded|selected)\\b|\\b(?:approved|awarded|selected)\\b.{0,35}${broker}|\\baward remains\\s+${broker}|\\b(?:please proceed|go ahead)\\b.{0,60}${broker})`,
        "i",
      ).test(text);
    });
    const broker = quoteSelectedByName?.broker || selectedBrokerFromFact(text);
    if (!broker) continue;
    const quote = pickupQuotes(shipment).find((item) => new RegExp(escapeRegExp(broker), "i").test(item.broker || ""));
    candidates.push({
      broker,
      email: quote?.email || quote?.contactEmail || "",
      amount: quote?.amount || pickupAwardAmountFromText(text),
      reason: `${broker} was already approved by the team.`,
      source: "shipment-facts",
      at: fact.date || fact.at || "",
      time: fact.time || 0,
    });
    break;
  }
  const selected = candidates
    .sort((a, b) => (factTime(b.at) || b.time || 0) - (factTime(a.at) || a.time || 0))[0] || null;
  return selected ? scrubCrossBrokerAwardAmount(shipment, selected) : null;
}

function normalizedContactIdentity(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9@.]+/g, " ")
    .replace(/\b(?:inc|llc|ltd|co|company|corp|corporation|freight|brokers?|brokerage|logistics|services?)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameContactIdentity(left, right) {
  const a = normalizedContactIdentity(left);
  const b = normalizedContactIdentity(right);
  if (!a || !b) return false;
  if (a.includes("@") || b.includes("@")) return a === b;
  return a === b || (a.length >= 7 && b.includes(a)) || (b.length >= 7 && a.includes(b));
}

function quoteMatchesAwardBroker(quote, award) {
  return sameContactIdentity(quote?.broker, award?.broker) ||
    sameContactIdentity(quote?.email || quote?.contactEmail, award?.email || award?.contactEmail);
}

function quoteAmountMatchesAward(quote, award) {
  const quoteValue = quoteAmountValue(quote);
  const awardValue = quoteAmountValue({ amount: award?.amount });
  return Number.isFinite(quoteValue) && Number.isFinite(awardValue) && Math.abs(quoteValue - awardValue) < 0.01;
}

function scrubCrossBrokerAwardAmount(shipment, award) {
  if (!award?.amount) return award;
  const quotes = pickupQuotes(shipment);
  if (!quotes.length) return award;
  const brokerQuotes = quotes.filter((quote) => quoteMatchesAwardBroker(quote, award));
  if (brokerQuotes.some((quote) => quoteAmountMatchesAward(quote, award))) return award;
  const reason = String(award.reason || "")
    .replace(/\s+at\s+\$\s*\d[\d,]*(?:\.\d+)?/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { ...award, amount: "", reason, amountUnverified: true };
}

function textHasContactIdentity(text, name = "", email = "") {
  const value = String(text || "");
  if (email && new RegExp(`\\b${escapeRegExp(email)}\\b`, "i").test(value)) return true;
  if (!name) return false;
  return new RegExp(`\\b${escapeRegExp(name).replace(/\s+/g, "\\s+")}\\b`, "i").test(value);
}

function pickupEvidenceForContact(shipment, name = "", email = "", actions = null) {
  const actionAward = actions ? selectedPickupAwardFromActions(shipment, actions) : null;
  if (actionAward && (sameContactIdentity(actionAward.broker, name) || sameContactIdentity(actionAward.email, email))) return true;
  const quotes = pickupQuotes(shipment);
  if (quotes.some((quote) =>
    sameContactIdentity(quote.broker, name) ||
    sameContactIdentity(quote.email || quote.contactEmail, email)
  )) return true;
  const rows = [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.shipmentEvents?.events || []),
    ...(shipment.events || []),
  ];
  if (rows.some((row) => {
    const type = String(row.type || row.label || "");
    if (!/\b(?:pickup-quote-received|broker-awarded|pickup-award|broker-award|pickup-dispatched|pickup-confirmed)\b/i.test(type)) return false;
    const text = [row.broker, row.selectedBroker, row.contactEmail, row.targetEmail, row.from, row.to, row.summary, row.evidence].filter(Boolean).join(" ");
    if (stationConfirmationRequestText(text)) return false;
    return textHasContactIdentity(text, name, email);
  })) return true;
  const identity = [name, email].filter(Boolean).map(escapeRegExp).join("|");
  if (!identity) return false;
  const pickupFact = shipmentStateFacts(shipment).some((fact) => {
    const text = fact.text;
    if (!new RegExp(identity, "i").test(text)) return false;
    if (/\b(?:customs|ace|entry|clearance|release|d\/?o|delivery order)\b/i.test(text) &&
      !/\b(?:quote|rate|award|selected|please proceed|go ahead|dispatch|driver|recover|recovery|pickup|pick up|picked up)\b/i.test(text)) {
      return false;
    }
    return /\b(?:pickup quote|quote|rate|award|selected|please proceed|go ahead|dispatch|driver|recover|recovery|pickup|pick up|picked up)\b/i.test(text);
  });
  return pickupFact;
}

function contactLooksCustomsOnly(shipment, name = "", email = "", actions = null) {
  const customs = customsBrokerContact(shipment);
  const customsName = customs.name || shipment.customsBroker?.broker || "";
  const customsEmail = customs.email || shipment.customsBroker?.email || shipment.customsBroker?.contactEmail || "";
  const sameAsCustoms = sameContactIdentity(name, customsName) || sameContactIdentity(email, customsEmail);
  if (!sameAsCustoms) return false;
  return !pickupEvidenceForContact(shipment, name, email, actions);
}

function freightBrokerLooksAirBooking(shipment) {
  const broker = shipment.freightBroker || {};
  const identityText = [
    broker.broker,
    broker.quoteDecision?.summary,
    ...(broker.quotes || []).flatMap((quote) => [quote.broker, quote.service, quote.category, quote.rate, ...(quote.evidence || [])]),
  ].filter(Boolean).join(" ");
  const pickupIdentityText = [
    broker.broker,
    ...(broker.quotes || []).map((quote) => quote.broker || ""),
  ].filter(Boolean).join(" ");
  return AIR_BOOKING_PATTERN.test(` ${identityText} `) && !PICKUP_BROKER_PATTERN.test(pickupIdentityText);
}

function nameLooksAirBookingOnly(value) {
  const text = String(value || "");
  return AIR_BOOKING_PATTERN.test(` ${text} `) && !PICKUP_BROKER_PATTERN.test(text);
}

function knownPickupBroker(shipment, actions = null) {
  const selected = selectedPickupAward(shipment, actions);
  if (selected?.broker) return selected.broker;
  const airportCarrier = airportDwellCarrierName(shipment);
  if (airportCarrier) return airportCarrier;
  if (/\b(?:driver@demo-freight\.example|casey(?:\s+hart)?(?:\s+\/\s*driver|\s+the\s+driver)?|chart)\b/i.test(statusText(shipment))) return NY_PICKUP_DRIVER.name;
  const freightBroker = freightBrokerLooksAirBooking(shipment) ? "" : shipment.freightBroker?.broker || "";
  const rawPickupName = shipment.contacts?.pickup?.name || "";
  const pickupName = nameLooksAirBookingOnly(rawPickupName) ? "" : rawPickupName;
  const broker = freightBroker || pickupName || "";
  if (
    broker &&
    !/not awarded|not found|pending|unknown|no pickup quote/i.test(broker) &&
    !contactLooksCustomsOnly(shipment, broker, shipment.freightBroker?.email || shipment.freightBroker?.contactEmail || shipment.contacts?.pickup?.email || "", actions)
  ) return broker;
  if (String(shipment.station || "").toUpperCase() === "ELP") return "Rivergate Logistics ELP / Norman";
  return "";
}

function publicPickupOwnerConfirmed(shipment) {
  const broker = shipment.freightBroker || {};
  const name = String(broker.broker || broker.name || "").trim();
  if (!name || /^(?:not found|unknown|none|n\/a)$/i.test(name)) return false;
  const statusText = [
    broker.status,
    broker.brokerStatus,
  ].filter(Boolean).join(" ");
  return /\b(?:freight-awarded|pickup-owner-confirmed|broker-awarded|dispatch owner)\b/i.test(statusText);
}

function quoteLine(shipment, actions) {
  if (publicPickupOwnerConfirmed(shipment)) {
    const broker = shipment.freightBroker || {};
    const amount = broker.rate || broker.amount || "";
    return `Pickup broker: ${compact(broker.broker || broker.name || "pickup broker", 34)}${amount ? ` approved ${amount}` : " approved"}.`;
  }
  const selected = selectedPickupAward(shipment, actions);
  if (selected) return `Pickup broker: ${compact(selected.broker, 34)}${selected.amount ? ` approved ${selected.amount}` : " approved"}.`;
  const quotes = pickupQuotes(shipment);
  if (quotes.length) {
    return `Pickup quotes: ${quotes.slice(0, 3).map((quote) => compact(`${quote.broker}${quote.amount ? ` ${quote.amount}` : ""}`, 34)).join(", ")}.`;
  }
  const broker = knownPickupBroker(shipment, actions);
  if (broker) {
    const gates = gateState(shipment);
    if (!gates.arrived && !gates.pickedUp && !gates.deliveryReported) {
      return `Pickup path after arrival/release: ${compact(broker, 40)}.`;
    }
    return `Pickup broker: ${compact(broker, 48)}.`;
  }
  const key = normalizeAwb(shipment.awb);
  const quoteActions = (actions.actions || []).filter((action) => normalizeAwb(action.awb) === key && /quote/i.test(action.type || action.label || ""));
  if (quoteActions.length) {
    const names = unique(quoteActions.map((action) => action.targetName || action.targetEmail || "").filter(Boolean)).slice(0, 3);
    return `Quote blast: ${names.length ? `sent/drafted to ${names.join(", ")}` : "sent/drafted"}; waiting for pickup prices.`;
  }
  return "Pickup quotes: none yet.";
}

function actionMemoryText(shipment, actions) {
  const key = normalizeAwb(shipment.awb);
  return [
    statusText(shipment),
    ...(actions.actions || [])
      .filter((action) => normalizeAwb(action.awb) === key)
      .map((action) => `${action.type || ""} ${action.label || ""} ${action.targetName || ""} ${action.status || ""} ${action.queuedAt || ""} ${action.draftedAt || ""} ${action.sentAt || ""}`),
    ...(actions.outbox?.requests || actions.outboxRequests || [])
      .filter((request) => normalizeAwb(request.awb) === key)
      .map((request) => `${request.type || ""} ${request.label || ""} ${request.targetName || ""} ${request.to || ""} ${request.status || ""} ${request.subject || ""}`),
  ].filter(Boolean).join(" ");
}

function tmsAlertSent(shipment, actions) {
  return /\b(?:tms|couriercloud|agt|alert).{0,90}\b(?:sent|queued|drafted)\b/i.test(actionMemoryText(shipment, actions)) ||
    /\b(?:inbound alert|agent alert).{0,90}\b(?:sent|forwarded)\b/i.test(actionMemoryText(shipment, actions));
}

function emailAlreadyRequested(shipment, actions, typePattern) {
  const pattern = typePattern instanceof RegExp ? typePattern : new RegExp(typePattern, "i");
  return pattern.test(actionMemoryText(shipment, actions));
}

function queuedActionMemoryText(shipment, actions) {
  const key = normalizeAwb(shipment.awb);
  return [
    ...(actions.actions || [])
      .filter((action) => normalizeAwb(action.awb) === key)
      .map((action) => [
        action.type,
        action.label,
        action.targetName,
        action.status,
        action.subject,
        action.queuedAt,
        action.draftedAt,
        action.sentAt,
      ].filter(Boolean).join(" ")),
    ...(actions.outbox?.requests || actions.outboxRequests || [])
      .filter((request) => normalizeAwb(request.awb) === key)
      .map((request) => [
        request.type,
        request.label,
        request.targetName,
        request.to,
        request.status,
        request.subject,
        request.queuedAt,
        request.draftedAt,
        request.sentAt,
      ].filter(Boolean).join(" ")),
  ].filter(Boolean).join(" ");
}

function queuedActionRowsForShipment(shipment, actions = {}) {
  const key = normalizeAwb(shipment.awb);
  return [
    ...(actions.actions || []),
    ...(actions.outbox?.requests || actions.outboxRequests || []),
  ].filter((row) => normalizeAwb(row.awb || row.shipmentAwb || row.payload?.awb) === key);
}

function queuedActionAlreadyRequested(shipment, actions, typePattern) {
  const pattern = typePattern instanceof RegExp ? typePattern : new RegExp(typePattern, "i");
  return pattern.test(queuedActionMemoryText(shipment, actions));
}

function queuedPodFollowupAlreadyRequested(shipment, actions = {}) {
  return queuedActionRowsForShipment(shipment, actions).some((row) => {
    const text = [
      row.type,
      row.label,
      row.targetName,
      row.to,
      row.targetEmail,
      row.status,
      row.subject,
      row.body,
      row.queuedAt,
      row.draftedAt,
      row.sentAt,
    ].filter(Boolean).join(" ");
    if (/\bbroker-status-followup\b|\bpickup status\b/i.test(`${row.type || ""} ${row.label || ""} ${row.subject || ""}`) &&
      /\bsend\s+pod\s+once\s+delivered\b/i.test(text)) {
      return false;
    }
    return /\bpod-followup\b|\bpod request\b|\bpod\/delivery\b|\bdelivery confirmation\b|\bproof of delivery\b|\bsigned pod\b/i.test(text);
  });
}

function contactName(contact) {
  if (!contact) return "";
  return contact.name || contact.broker || contact.handlerName || "";
}

function contactEmail(contact) {
  if (!contact) return "";
  return contact.email || contact.stationEmail || contact.contactEmail || "";
}

function contactEmailList(value) {
  return [...new Set(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])]
    .map((email) => email.toLowerCase());
}

function addressName(value) {
  const text = String(value || "").trim();
  const email = contactEmailList(text)[0] || "";
  const bracketName = text.match(/^"?([^"<]+?)"?\s*</)?.[1] || "";
  return (bracketName || text.replace(email, ""))
    .replace(/[<>()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isOperatorEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return Boolean(email && (email === OPERATOR_EMAIL.toLowerCase() || email === "contact-053@demo-freight.example" || /@demo-freight\.example$/.test(email)));
}

function isOperatorContactName(value) {
  return /\b(?:alex morgan|operations piki|piki ops|pikiio ops|operator)\b/i.test(String(value || ""));
}

function airportDwellRows(shipment) {
  return [
    ...(shipment.emailValidation?.events || []),
    ...(shipment.emailValidation?.proof || []),
    ...(shipment.shipmentEvents?.events || []),
    ...(shipment.events || []),
    ...(shipment.opsState?.events || []),
    ...(shipment.opsState?.exceptions || []),
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
  ].filter(Boolean);
}

function airportDwellRowText(row) {
  return [
    row?.type,
    row?.exceptionType,
    row?.label,
    row?.summary,
    row?.evidence,
    row?.nextAction,
    row?.carrierName,
    row?.requestedStation,
    row?.from,
    row?.to,
  ].filter(Boolean).join(" ");
}

function airportDwellCarrierNameFromText(text) {
  const match = String(text || "").match(/\bcarrier\s+(?:will\s+(?:once\s+again\s+)?be|is|will be|:)\s+([A-Z][A-Za-z0-9& ./'-]{2,60}?)(?:[.;,\n\-\u2013\u2014]|$)/i);
  const carrier = cleanSelectedBrokerName(match?.[1] || "");
  if (/\b(?:onsite|on site|checked in|made the following request|at the|waiting|standby|sitting|pickup|pick up)\b/i.test(carrier)) return "";
  return carrier;
}

function airportDwellLatestRow(shipment, pattern) {
  return airportDwellRows(shipment)
    .filter((row) => pattern.test(airportDwellRowText(row)))
    .sort((a, b) => factTime(b.at || b.updatedAt || b.createdAt) - factTime(a.at || a.updatedAt || a.createdAt))[0] || null;
}

function cargoNotFoundEvidenceText(shipment) {
  const row = airportDwellLatestRow(shipment, CARGO_NOT_FOUND_PATTERN);
  if (row) return airportDwellRowText(row);
  const text = statusText(shipment);
  return CARGO_NOT_FOUND_PATTERN.test(text) ? text : "";
}

function airportDwellCarrierName(shipment) {
  const row = airportDwellLatestRow(shipment, /\bpickup-docs-needed\b|\bremaining pickup docs\b|\bremaining necessary docs\b|\bcarrier will\b/i);
  const carrierName = cleanSelectedBrokerName(row?.carrierName || airportDwellCarrierNameFromText(airportDwellRowText(row)) || "");
  return nameLooksAirBookingOnly(carrierName) ? "" : carrierName;
}

const AIRPORT_DWELL_LOCATION_PATTERN =
  /\bpickup-location-requested\b|\bpickup broker asked\b|\bexact pick[-\s]?up location\b|\bpickup location open question\b|\basked[^.\n]{0,80}\b(?:pickup|pick[-\s]?up) location\b|\bconfirm[^.\n]{0,80}\b(?:correct )?(?:pickup|pick[-\s]?up) location\b/i;

const AIRPORT_DWELL_DOCS_PATTERN =
  /\bpickup-docs-needed\b|\bremaining pickup docs\b|\bremaining necessary docs\b|\bneeds remaining docs\b|\bcarrier will (?:once again )?be\b|\bcarrier is checked in\b|\bshipper needs\b[^.\n]{0,120}\b(?:airway bill|air waybill|awb|delivery order|d\/?o)\b|\b(?:could you|can you|please|pls|need|needs|needed|provide|send)\b[^.\n]{0,80}\b(?:copy|pdf|document)\b[^.\n]{0,60}\b(?:of (?:the )?)?(?:airway bill|air waybill|awb)\b|\b(?:airway bill|air waybill|awb)\b[^.\n]{0,80}\b(?:copy|pdf|document|delivery order|d\/?o)\b/i;

const AWB_COPY_ONLY_DOCS_PATTERN =
  /\b(?:could you|can you|please|pls|need|needs|needed|provide|send)\b[^.\n]{0,80}\b(?:copy|pdf|document)\b[^.\n]{0,60}\b(?:of (?:the )?)?(?:airway bill|air waybill|awb)\b|\b(?:airway bill|air waybill|awb)\b[^.\n]{0,80}\b(?:copy|pdf|document)\b/i;

function airportDwellConversation(row) {
  if (!row?.threadId && !row?.messageId) return null;
  return {
    threadId: row.threadId || "",
    replyMessageId: row.messageId || "",
    source: "gmail-airport-dwell",
    summary: row.summary || row.evidence || row.nextAction || "",
  };
}

function shipmentEndpointStation(shipment) {
  return String(
    shipment?.station ||
      shipment?.stationCode ||
      shipment?.destinationAirport ||
      shipment?.airport ||
      shipment?.destination ||
      "",
  ).toUpperCase();
}

function airportStationCodesInText(text) {
  const raw = String(text || "");
  const codes = new Set();
  for (const [alias, code] of Object.entries(STATION_ALIASES)) {
    if (new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(raw)) {
      codes.add(code);
    }
  }
  for (const match of raw.matchAll(/\b[A-Z]{3}\b/g)) {
    if (Object.values(STATION_ALIASES).includes(match[0])) codes.add(match[0]);
  }
  return codes;
}

function airportDwellMatchesEndpointStation(shipment, text) {
  const endpoint = shipmentEndpointStation(shipment);
  if (!endpoint) return false;
  const stationCodes = airportStationCodesInText(text);
  return stationCodes.has(endpoint);
}

function stationEvidenceMatchesEndpointStation(shipment, text, options = {}) {
  const endpoint = shipmentEndpointStation(shipment);
  if (!endpoint) return !options.requireExplicitStation;
  const stationCodes = airportStationCodesInText(text);
  if (!stationCodes.size) return !options.requireExplicitStation;
  return stationCodes.has(endpoint);
}

function rejectNonEndpointStationEvidence(shipment, text) {
  return !stationEvidenceMatchesEndpointStation(shipment, text);
}

function endpointStationScopedText(shipment, text) {
  return stationEvidenceMatchesEndpointStation(shipment, text, { requireExplicitStation: true });
}

function airportDwellPickupContact(shipment) {
  const row = airportDwellLatestRow(shipment, new RegExp(`${AIRPORT_DWELL_DOCS_PATTERN.source}|${AIRPORT_DWELL_LOCATION_PATTERN.source}`, "i"));
  if (!row) return null;
  const text = airportDwellRowText(row);
  if (stationConfirmationRequestText(text)) return null;
  if (!endpointStationScopedText(shipment, text)) return null;
  const carrierName = cleanSelectedBrokerName(row.carrierName || airportDwellCarrierNameFromText(airportDwellRowText(row)) || "");
  const pickupCarrierName = nameLooksAirBookingOnly(carrierName) ? "" : carrierName;
  const email = contactEmailList([row.from, row.to, row.contactEmail, row.email].filter(Boolean).join(" "))
    .find((item) => !isOperatorEmail(item)) || "";
  const senderName = addressName(row.from || "");
  const requestor = text.match(/\b(Jamie(?:\s+Brooks)?|TQL|Total Quality Logistics|Birch Enterprises)\b/i)?.[1] || "";
  const rawName = senderName || row.broker || row.targetName || requestor || pickupCarrierName || "pickup broker";
  const name = nameLooksAirBookingOnly(rawName) ? requestor || "pickup broker" : rawName;
  return { name, email, phone: "" };
}

function stationLocationLine(shipment) {
  const station = stationContact(shipment);
  const text = [
    shipment.stationContext?.terminalAddress,
    shipment.stationContext?.address,
    shipment.stationContext?.stations?.[0]?.terminalAddress,
    shipment.stationContext?.stations?.[0]?.address,
    shipment.stationContext?.stations?.[0]?.stationAddress,
    ...(shipment.facts || []).map((fact) => fact.summary || fact.note || fact.evidence || ""),
    ...(shipment.emailValidation?.proof || []).map((fact) => fact.summary || fact.note || fact.evidence || ""),
  ].filter(Boolean).join(" ");
  const normalizedText = text.replace(/\s+/g, " ");
  const airportAddress =
    normalizedText.match(/\b(Main Cargo Facility\s+\d{2,6}\s+[^.;]{3,80}?(?:Rd|Road|Ave|Avenue|St|Street|Blvd|Boulevard|Dr|Drive)\.?\s+[^.;]{2,50}?,?\s+[A-Z]{2}\s+\d{5}(?:\s+US)?)/i)?.[1] ||
    normalizedText.match(/\b(\d{2,6}\s+South Cargo Rd\.?\s+Cleveland,?\s+OH\s+44135(?:\s+US)?)/i)?.[1] ||
    "";
  const address =
    airportAddress ||
    text.match(/\bterminal address:\s*([^.\n;]{8,120})/i)?.[1] ||
    text.match(/\b(?:address|location):\s*([^.\n;]{8,120})/i)?.[1] ||
    "";
  return [station.name, address, station.email ? `Email ${station.email}` : "", station.phone ? `Phone ${station.phone}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function hasAirportDwellReplyTarget(contact, conversation = null) {
  return Boolean(
    contact?.email &&
      !isOperatorEmail(contact.email) &&
      (conversation?.threadId || conversation?.replyMessageId)
  );
}

function contactPhone(contact) {
  if (!contact) return "";
  return contact.phone || contact.stationPhone || contact.contactPhone || "";
}

function usableContactValue(value, shipment = null) {
  const text = String(value || "").trim();
  if (!text || /\b(?:unknown|not found|missing|confirm station|station import desk|station line)\b/i.test(text)) return "";
  const digits = text.replace(/\D/g, "");
  if (shipment && digits && digits === String(shipment.awb || shipment.id || "").replace(/\D/g, "")) return "";
  if (/^20\d{6,}/.test(digits)) return "";
  if (digits && digits.length > 11 && !text.startsWith("+")) return "";
  return text;
}

function meaningfulStationToken(value, station = "") {
  const token = String(value || "").trim().toLowerCase();
  if (!token || token.length < 4) return false;
  if (token === String(station || "").trim().toLowerCase()) return false;
  return !/^(?:carrier|station|cargo|imports?|exports?|email|phone|jfk|ewr|lax|bos|elp|cle|den|dfw|ord|atl|dtw)$/i.test(token);
}

function stationMemoryScore(contact, shipment) {
  if (!contact || !shipment) return 0;
  const station = String(shipment.station || "").toUpperCase();
  if (String(contact.airport || "").toUpperCase() !== station) return -1;
  const text = statusText(shipment).toLowerCase();
  const tokens = [
    contact.airline,
    contact.handlerName,
    contact.stationEmail,
    contact.source,
    ...(Array.isArray(contact.aliases) ? contact.aliases : []),
  ].filter((value) => meaningfulStationToken(value, station));
  return unique(tokens)
    .reduce((score, token) => score + (text.includes(String(token).toLowerCase()) ? 1 : 0), 0);
}

function stationMemoryContact(shipment, memory) {
  const station = String(shipment?.station || "").toUpperCase();
  if (!station) return null;
  const candidates = (memory?.stationMemory?.contacts || [])
    .filter((contact) => String(contact.airport || "").toUpperCase() === station)
    .map((contact) => ({ contact, score: stationMemoryScore(contact, shipment) }))
    .sort((left, right) => right.score - left.score);
  const match = candidates.find((candidate) => candidate.score > 0)?.contact || null;
  if (!match) return null;
  return {
    name: match.handlerName || [match.airline, match.airport].filter(Boolean).join(" "),
    email: match.stationEmail || "",
    phone: match.stationPhone || "",
  };
}

function pickupBrokerContact(shipment, actions = null) {
  const pickup = shipment.contacts?.pickup || {};
  const broker = shipment.freightBroker || {};
  const selected = selectedPickupAward(shipment, actions);
  const airportContact = airportDwellPickupContact(shipment);
  const rawPickupName = usableContactName(contactName(pickup));
  const rawBrokerName = usableContactName(broker.broker || "");
  const pickupName = nameLooksAirBookingOnly(rawPickupName) ? "" : rawPickupName;
  const pickupEmail = pickupName ? contactEmail(pickup) : "";
  const brokerName = freightBrokerLooksAirBooking(shipment) || nameLooksAirBookingOnly(rawBrokerName) ? "" : rawBrokerName;
  const brokerEmail = brokerName ? broker.email || broker.contactEmail || "" : "";
  const airportName = airportContact?.name && !nameLooksAirBookingOnly(airportContact.name) && !/^pickup broker$/i.test(airportContact.name)
    ? airportContact.name
    : "";
  const airportEmail = airportName ? airportContact?.email || "" : "";
  const pickupLooksCustomsOnly = !selected && contactLooksCustomsOnly(shipment, pickupName || brokerName, pickupEmail || brokerEmail, actions);
  const knownBrokerName = knownPickupBroker(shipment, actions);
  const approved = approvedPickupBrokerForName(selected?.broker || airportName || pickupName || brokerName || knownBrokerName);
  const name = selected?.broker || airportName || (pickupLooksCustomsOnly ? "" : pickupName || brokerName) || approved?.name || knownBrokerName;
  let email = usableContactValue(selected?.email || airportEmail || (pickupLooksCustomsOnly ? "" : pickupEmail || brokerEmail) || approved?.email || "", shipment);
  if (isOperatorEmail(email)) email = "";
  if (String(shipment.station || "").toUpperCase() === "ELP" || /binational|norman/i.test(name)) {
    return { name: ELP_PICKUP_BROKER.name, email: ELP_PICKUP_BROKER.email, phone: usableContactValue(broker.phone || pickup.phone || "", shipment) };
  }
  if (/chart|casey hart|casey/i.test(`${name} ${email}`) ||
    /\b(?:driver@demo-freight\.example|casey(?:\s+hart)?(?:\s+\/\s*driver|\s+the\s+driver)?|chart)\b/i.test(statusText(shipment))) {
    return { name: NY_PICKUP_DRIVER.name, email: NY_PICKUP_DRIVER.email, phone: usableContactValue(broker.phone || broker.contactPhone || pickup.phone || "", shipment) };
  }
  return { name, email, phone: usableContactValue(broker.phone || broker.contactPhone || pickup.phone || "", shipment) };
}

function customsBrokerContact(shipment) {
  const customs = shipment.contacts?.customs || {};
  const broker = shipment.customsBroker || {};
  return {
    name: usableContactName(contactName(customs)) || usableContactName(broker.broker) || "",
    email: usableContactValue(contactEmail(customs) || broker.email || broker.contactEmail || "", shipment),
    phone: usableContactValue(broker.phone || broker.contactPhone || customs.phone || "", shipment),
  };
}

function contactLooksLikeCustomsOrInbond(contact) {
  const text = [
    contactName(contact),
    contactEmail(contact),
    contactPhone(contact),
    contact?.source,
    contact?.label,
  ].filter(Boolean).join(" ");
  return /\b(?:customs|inbond|broker|entry|clearance|juarez|ups scs|align)\b/i.test(text);
}

function textLooksLikeCustomsOrInbond(text) {
  return /\b(?:customs|inbond|in-bond|broker|entry|clearance|juarez|ups scs|align|government|cbp|exam)\b/i.test(String(text || ""));
}

function operationalEndpointStationText(shipment, text, options = {}) {
  const value = String(text || "");
  if (!value.trim()) return !options.requireExplicitStation;
  if (textLooksLikeCustomsOrInbond(value)) return false;
  return stationEvidenceMatchesEndpointStation(shipment, value, options);
}

function stationContact(shipment, memory = null) {
  const station = shipment.contacts?.station || {};
  const remembered = stationMemoryContact(shipment, memory);
  const context = shipment.stationContext || {};
  const contextMemory = context.stationMemory || {};
  const stationRow = (context.stations || []).find((row) =>
    row?.stationName || row?.stationEmail || row?.stationPhone
  ) || {};
  const stationContactText = [
    contactName(station),
    contactEmail(station),
    contactPhone(station),
    station.source,
    station.label,
  ].filter(Boolean).join(" ");
  const stationContactIsOperational =
    !contactLooksLikeCustomsOrInbond(station) &&
    (!stationContactText || !rejectNonEndpointStationEvidence(shipment, stationContactText));
  const contextText = [
    context.handler,
    context.email,
    context.stationEmail,
    context.phone,
    context.stationPhone,
    context.source,
    context.label,
  ].filter(Boolean).join(" ");
  const contextIsEndpointScoped = operationalEndpointStationText(shipment, contextText);
  const contextMemoryText = [
    contextMemory.handler,
    contextMemory.name,
    contextMemory.email,
    contextMemory.phone,
    contextMemory.source,
    contextMemory.label,
  ].filter(Boolean).join(" ");
  const contextMemoryIsEndpointScoped = operationalEndpointStationText(shipment, contextMemoryText);
  const rowText = [
    stationRow.stationName,
    stationRow.stationEmail,
    stationRow.stationPhone,
    stationRow.source,
    stationRow.label,
  ].filter(Boolean).join(" ");
  const stationRowIsEndpointScoped = operationalEndpointStationText(shipment, rowText);
  const fallbackName = [shipment.airline, shipment.station].filter(Boolean).join(" ");
  const name =
    (contextIsEndpointScoped ? context.handler : "") ||
    (contextMemoryIsEndpointScoped ? contextMemory.handler : "") ||
    (contextMemoryIsEndpointScoped ? contextMemory.name : "") ||
    shipment.handler ||
    remembered?.name ||
    (stationRowIsEndpointScoped ? stationRow.stationName : "") ||
    (stationContactIsOperational ? contactName(station) : "") ||
    fallbackName;
  const email = usableContactValue(
    (contextIsEndpointScoped ? context.email : "") ||
      (contextIsEndpointScoped ? context.stationEmail : "") ||
      shipment.stationEmail ||
      (contextMemoryIsEndpointScoped ? contextMemory.email : "") ||
      remembered?.email ||
      (stationRowIsEndpointScoped ? stationRow.stationEmail : "") ||
      (stationContactIsOperational ? contactEmail(station) : ""),
    shipment,
  );
  const phone = usableContactValue(
    (contextIsEndpointScoped ? context.phone : "") ||
      (contextIsEndpointScoped ? context.stationPhone : "") ||
      shipment.stationPhone ||
      (contextMemoryIsEndpointScoped ? contextMemory.phone : "") ||
      remembered?.phone ||
      (stationRowIsEndpointScoped ? stationRow.stationPhone : "") ||
      (stationContactIsOperational ? contactPhone(station) : ""),
    shipment,
  );
  return {
    name,
    email: email || "",
    phone: phone || "",
  };
}

function customerContact(shipment) {
  const delivery = shipment.delivery || {};
  const customer = shipment.customer || shipment.clientContact || shipment.contacts?.customer || {};
  const email = contactEmailList([
    delivery.contactEmail,
    customer.email,
    customer.contactEmail,
    shipment.customerEmail,
    shipment.clientEmail,
    shipment.tms?.contactEmail,
    shipment.tms?.consigneeEmail,
  ].filter(Boolean).join(" "))[0] || "";
  const name = contactName(customer) || shipment.client || shipment.consignee || delivery.consignee || "customer";
  return { name, email, phone: contactPhone(customer) || delivery.contactPhone || "" };
}

function operatorTo(targetEmail) {
  return unique([targetEmail, OPERATOR_EMAIL]).join(", ");
}

function conversationRow(row, source = "", fallbackAt = "") {
  if (!row || typeof row !== "object") return null;
  const thread = Array.isArray(row.threads) ? row.threads.find((item) => item?.threadId || item?.messageId) || {} : {};
  const threadId = row.threadId || row.gmailThreadId || row.conversationThreadId || thread.threadId || "";
  const replyMessageId = row.messageId || row.gmailMessageId || row.replyMessageId || thread.messageId || "";
  if (!threadId && !replyMessageId) return null;
  return {
    replyMessageId,
    threadId,
    source: row.source || source || row.label || row.type || "shipment-memory",
    summary: row.summary || row.note || row.nextAction || factRowText(row),
    at: factRowAt(row, fallbackAt),
    complete: Boolean(threadId && replyMessageId),
  };
}

function threadTopicPattern(topic) {
  switch (String(topic || "").toLowerCase()) {
    case "customer":
      return /\b(?:customer|client|consignee|skyler|status update|shipment update)\b/i;
    case "customs":
      return /\b(?:customs|clearance|release|released|d\/?o|delivery order|broker|maple|cedar dispatch|worldwide|port air|translink)\b/i;
    case "pickup":
      return /\b(?:pickup|pick up|picked up|recover|recovery|driver|pod|proof of delivery|delivery proof|delivered|btx|jd direct|binational|rapid|cedar brokerage|meadow freight|tql|sd direct|mw transport)\b/i;
    case "station":
      return /\b(?:station|arrival notice|notice of arrival|noa|on[-\s]?hand|available|availability|ground fees?|handling fees?|storage|last free|lfd|cargosprint|united cargo|forward air|wfs|choice|swissport|air general)\b/i;
    case "quote":
      return /\b(?:quote|rate|price|pickup quote|blast|award|lowest)\b/i;
    default:
      return null;
  }
}

function threadRowMatchesTopic(row, topic) {
  const pattern = threadTopicPattern(topic);
  if (!pattern) return true;
  const text = [
    row?.source,
    row?.label,
    row?.type,
    row?.summary,
    row?.note,
    row?.nextAction,
    row?.subject,
    factRowText(row),
  ].filter(Boolean).join(" ");
  return pattern.test(text);
}

function threadTopicForActionKind(kind) {
  switch (kind) {
    case "customer-update":
      return "customer";
    case "customs-followup":
      return "customs";
    case "broker-status-followup":
    case "broker-award":
    case "pod-followup":
      return "pickup";
    case "station-fee-confirmation":
      return "station";
    case "quote-request":
      return "quote";
    default:
      return "shipment";
  }
}

function finalizeAction(action) {
  const channel = String(action.channel || "").toLowerCase();
  if (["platform", "document"].includes(channel)) {
    return {
      ...action,
      readiness: "ready",
      preflight: {
        status: "ready",
        ready: true,
        missing: action.missing || [],
        errors: [],
        threadPolicy: channel === "document" ? "unavailable" : action.threadPolicy || "unavailable",
        reason: "",
      },
    };
  }
  const preflight = actionPreflight(action.id, action);
  return {
    ...action,
    readiness: preflight.status,
    preflight,
    missing: preflight.missing,
    blockedReason: preflight.reason,
  };
}

function threadContext(shipment, topic = "shipment") {
  const candidates = [];
  const add = (row, source = "", fallbackAt = "") => {
    const candidate = conversationRow(row, source, fallbackAt);
    if (candidate) {
      const rowText = airportDwellRowText(row);
      if (
        ["pickup", "station"].includes(String(topic || "").toLowerCase()) &&
        !stationEvidenceMatchesEndpointStation(shipment, rowText)
      ) {
        return;
      }
      if (
        (AIRPORT_DWELL_DOCS_PATTERN.test(rowText) || AIRPORT_DWELL_LOCATION_PATTERN.test(rowText)) &&
        !stationEvidenceMatchesEndpointStation(shipment, rowText, { requireExplicitStation: true })
      ) {
        return;
      }
      candidate.topicMatched = threadRowMatchesTopic(row, topic);
      candidates.push(candidate);
    }
  };
  add(shipment.lastEmail, "latest-email");
  add(shipment.emailValidation, "email-validation", shipment.lastEmail?.at);
  for (const event of shipment.emailValidation?.events || []) add(event, "email-event", shipment.emailValidation?.latestEventAt || shipment.lastEmail?.at);
  for (const proof of shipment.emailValidation?.proof || []) add(proof, "email-proof", shipment.emailValidation?.latestEventAt || shipment.lastEmail?.at);
  for (const fact of shipment.facts || []) add(fact, "fact", shipment.lastEmail?.at);
  for (const fact of shipment.factLedger || []) add(fact, "ledger", shipment.lastEmail?.at);
  for (const proof of shipment.proofs || []) add(proof, "proof", shipment.lastEmail?.at);
  const topicSpecific = topic && topic !== "shipment" ? candidates.filter((candidate) => candidate.topicMatched) : candidates;
  const pool = topicSpecific.length ? topicSpecific : candidates;
  const selected = pool
    .sort((a, b) => Number(b.complete) - Number(a.complete) || factTime(b.at) - factTime(a.at))[0] || {};
  const matched = Boolean(selected.threadId || selected.replyMessageId);
  return {
    replyMessageId: selected.replyMessageId || "",
    matched,
    topic,
    conversation: {
      threadId: selected.threadId || "",
      replyMessageId: selected.replyMessageId || "",
      source: selected.source || "shipment-memory",
      summary: selected.summary || "",
    },
  };
}

function actionId(shipment, kind, target = "") {
  return `brain-${normalizeAwb(shipment.awb)}-${kind}-${String(target || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "target"}`;
}

function baseAction(shipment, kind, label, target, body, extra = {}) {
  const threadTopic = extra.threadTopic || threadTopicForActionKind(kind);
  const explicitThreadPolicy = extra.threadPolicy || "";
  const thread = threadContext(shipment, threadTopic);
  const explicitConversation = extra.conversation || null;
  const hasExplicitConversation = Boolean(explicitConversation?.threadId || explicitConversation?.replyMessageId);
  const channel = extra.channel || "gmail";
  const platformAlert = channel === "platform";
  const tmsAction = channel === "couriercloud";
  const documentAction = channel === "document";
  const threadPolicy = platformAlert || tmsAction || documentAction
    ? "unavailable"
    : explicitThreadPolicy || (hasExplicitConversation ? "reply_existing" : kind === "quote-request" ? "start_new" : thread.matched && thread.conversation.threadId ? "reply_existing" : "start_new");
  const conversation = threadPolicy === "reply_existing"
    ? hasExplicitConversation
      ? {
          threadId: explicitConversation.threadId || "",
          replyMessageId: explicitConversation.replyMessageId || "",
          source: explicitConversation.source || "explicit-thread",
          summary: explicitConversation.summary || "",
        }
      : thread.conversation
    : null;
  const action = {
    id: actionId(shipment, kind, target.email || target.name || kind),
    shipmentId: shipment.id || shipmentId(shipment),
    awb: shipment.awb,
    type: kind,
    label,
    channel,
    execution: extra.execution || (platformAlert ? "platform-alert" : "draft-only"),
    status: "suggested",
    priority: extra.priority || "high",
    targetRole: extra.targetRole || "",
    targetName: target.name || "",
    targetEmail: platformAlert ? "" : tmsAction ? operatorTo(target.email) : target.email || "",
    cc: "",
    bcc: "",
    subject: extra.subject || `${shipment.awb} - ${label.toLowerCase()}`,
    body,
    replyMessageId: threadPolicy === "reply_existing" ? conversation?.replyMessageId || thread.replyMessageId : "",
    conversation,
    threadPolicy,
    threadTopic,
    threadSource: conversation?.source || "",
    threadSummary: conversation?.summary || "",
    orderLink: extra.orderLink || shipment.tms?.orderLink || "",
    tmsIntent: extra.tmsIntent || null,
    reason: extra.reason || label,
    problem: extra.problem || "",
    nextAction: extra.nextAction || "",
    contactLines: extra.contactLines || [],
    missing: target.email || tmsAction || platformAlert ? [] : ["recipient email"],
    documentIntent: extra.documentIntent || null,
    attachmentIntent: extra.attachmentIntent || null,
    attachmentIntents: Array.isArray(extra.attachmentIntents)
      ? extra.attachmentIntents
      : extra.attachmentIntent
        ? [extra.attachmentIntent]
        : [],
    carrierName: extra.carrierName || extra.documentIntent?.carrierName || extra.attachmentIntent?.carrierName || "",
    autonomy: {
      level: "L2",
      mode: platformAlert ? "platform-alert" : tmsAction ? "operator-approved-tms" : "draft-only",
      requiresHumanApproval: true,
      liveExecution: tmsAction,
      transport: platformAlert ? "in-platform-alert" : tmsAction ? "couriercloud-live-action" : "gmail-draft",
    },
    safety: {
      mode: platformAlert ? "platform-alert" : tmsAction ? "operator-approved-tms" : "draft-only",
      originalChannel: channel,
      note: platformAlert
        ? "Brain-proposed platform alert. Shown inside Ops Brain; no email or TMS job is queued."
        : "Brain-proposed action. Operator must preview and approve.",
    },
    betaContract: extra.betaContract || null,
  };
  if (extra.autonomy) action.autonomy = extra.autonomy;
  if (extra.safety) action.safety = extra.safety;
  return finalizeAction(action);
}

function terminalRecoveryBlockerForShipment(shipment = {}) {
  const truthGates = Array.isArray(shipment.truthPacket?.gates) ? shipment.truthPacket.gates : [];
  const truthDeliveryBlocked = truthGates.some((gate) =>
    ["delivery", "pod"].includes(String(gate.gate || "").toLowerCase()) &&
    ["blocked", "exception", "problem"].includes(String(gate.status || gate.rawStatus || "").toLowerCase())
  );
  const exceptions = shipment.opsState?.exceptions || shipment.exceptions || [];
  const text = [
    shipment.currentState,
    shipment.nextAction,
    shipment.stage,
    shipment.opsState?.phase,
    shipment.opsState?.summary,
    shipment.opsState?.label,
    shipment.opsState?.nextAction,
    shipment.truthPacket?.currentState,
    shipment.truthPacket?.stateReason,
    shipment.truthPacket?.nextAction?.label,
    ...exceptions.map((item) => `${item.type || ""} ${item.summary || ""} ${item.evidence || ""} ${item.impact || ""}`),
  ].filter(Boolean).join(" ");
  const phase = canonicalShipmentPhase(shipment);
  const terminalBlocked =
    phase === "delivery-blocked" ||
    String(shipment.truthPacket?.currentState || "").toLowerCase() === "delivery_blocked" ||
    truthDeliveryBlocked;
  const wrongConsignee = /\b(?:wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)|mis[-\s]?deliver(?:ed|y)?|delivered by mistake|delivered to (?:an? )?(?:another|different|wrong) (?:consignee|cnee|customer|recipient|receiver)|other than (?:the )?(?:correct|intended)?\s*(?:consignee|cnee|customer|recipient|receiver|northstar components)|return(?:ed)? to (?:el al|airline|station|you))\b/i.test(text);
  if (!terminalBlocked && !wrongConsignee) return null;
  if (
    !/\b(?:please|pls|kindly|can you|could you)\s+confirm\b|\bconfirm that\b/i.test(text) &&
    /\b(?:wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)[^.;\n]{0,120}(?:resolved|cleared|fixed)|(?:confirmed|confirming|has been|was|successfully)\s+(?:returned|recovered|redelivered)|recovered from (?:the )?wrong (?:consignee|customer|recipient|receiver)|redelivered to (?:the )?(?:correct|intended) (?:consignee|customer|recipient|receiver)|delivered to (?:the )?(?:correct|intended) (?:consignee|customer|recipient|receiver))\b/i.test(text)
  ) {
    return null;
  }
  const defaultProblem = wrongConsignee
    ? "Shipment appears delivered to the wrong consignee/customer."
    : "Delivery/recovery is blocked.";
  const defaultNextAction = wrongConsignee
    ? WRONG_CONSIGNEE_RECOVERY_ACTION
    : "Confirm the delivery blocker and recovery path before advancing closeout.";
  const candidateNextActions = [
    shipment.nextAction,
    shipment.opsState?.nextAction,
    shipment.truthPacket?.nextAction?.label,
  ].filter((item) =>
    item &&
    !/\b(?:do not treat this as normal delivered\/POD closeout|normal delivered\/POD closeout)\b/i.test(item)
  );
  const terminalNextAction = candidateNextActions.find((item) =>
    /\b(?:wrong[-\s]?(?:consignee|cnee|customer|recipient|receiver)|mis[-\s]?deliver|recovery|recover|return|returned|redeliver|who received|delivery blocker)\b/i.test(item)
  );
  return {
    wrongConsignee,
    problem: shipment.currentState || shipment.opsState?.summary || shipment.opsState?.label || shipment.truthPacket?.stateReason || defaultProblem,
    nextAction: terminalNextAction || defaultNextAction,
  };
}

function operatorPingAction(shipment, ping) {
  const reason = ping?.reason || "urgent exception";
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  const station = stationContact(shipment);
  const pickup = pickupBrokerContact(shipment);
  const customs = customsBrokerContact(shipment);
  const contacts = unique([
    contactLine("Station", station),
    contactLine("Pickup broker", pickup),
    contactLine("Customs broker", customs),
  ].filter(Boolean));
  const nextSteps = unique([
    ping?.nextAction,
    !terminalRecovery && pickupProblemReason(shipment) ? "Call the station first if the driver is onsite or waiting." : "",
    !terminalRecovery && pickupProblemReason(shipment) ? "Email/call the broker only after confirming whether the station sees the release/DO." : "",
    /\b(?:delivery order|d\/?o|release packet)\b[^.;\n]{0,80}\b(?:incorrect|wrong|bad|invalid|correct|correction)\b|\b(?:incorrect|wrong|bad|invalid|correct|correction)\b[^.;\n]{0,80}\b(?:delivery order|d\/?o|release packet)\b/i.test(reason) ? "Correct and resend the delivery order/release packet." : "",
    terminalRecovery ? "" : actionRecommendation(shipment, { actions: [], outboxRequests: [] }),
  ].filter(Boolean));
  const primaryStep = nextSteps[0] || "Review the shipment and decide the next operator move.";
  const targetRole = actionTargetRole(`${reason} ${primaryStep}`);
  return baseAction(
    shipment,
    "operator-ping",
    primaryStep,
    { name: "Ops Brain", email: "" },
    [
      `${shipment.awb} needs attention.`,
      `Problem: ${reason}.`,
      `State: ${shipment.opsState?.label || shipment.operationalUnderstanding?.label || shipment.stage || "open"}.`,
      contacts.length ? "Contacts:" : "",
      ...contacts.map((line) => `- ${line.replace(/\.$/, "")}`),
      "Recommended next steps:",
      ...nextSteps.map((line) => `- ${line.replace(/\.$/, "")}`),
    ].join("\n"),
    {
      channel: "platform",
      execution: "platform-alert",
      subject: "",
      reason,
      problem: reason,
      nextAction: primaryStep,
      targetRole,
      contactLines: contacts,
      priority: "high",
    },
  );
}

function actionTargetRole(text) {
  const value = String(text || "");
  if (/\bcall\b[^.;\n]{0,80}\bstation\b|\bstation\b[^.;\n]{0,80}\b(?:cannot|can't|does not|doesn't|not)\b[^.;\n]{0,80}\b(?:see|have|show)\b/i.test(value)) return "station";
  if (/\b(customs|release|clearance|d\/?o|delivery order)\b/i.test(value)) return "customs";
  if (/\b(pickup|driver|carrier|pod|delivery)\b/i.test(value)) return "pickup";
  if (/\b(station|cargo|handler|warehouse|availability|fees)\b/i.test(value)) return "station";
  return "";
}

function conciseStatusBody(shipment, opening) {
  return [
    "Hi,",
    "",
    opening,
    "",
    "Thank you,",
    "Alex",
  ].join("\n");
}

function customerUpdateOpening(shipment) {
  const gates = gateState(shipment);
  // The packet's customs verdict outranks the derived gate view: telling a
  // customer "still in customs" after release is false (production audit
  // 2026-07-05: 016-80000154 released, draft claimed customs).
  const safeTruth = customerComm.customerSafeTruth(shipment);
  if (gates.completed || safeTruth.delivered) return `AWB ${shipment.awb} has been delivered.`;
  if (gates.deliveryScheduledToday) return `AWB ${shipment.awb} is scheduled for delivery today.`;
  if (gates.deliveryProblem) return `AWB ${shipment.awb} has a delivery issue. We are checking and will update shortly.`;
  if (safeTruth.pickedUp && safeTruth.receiverClosed) {
    return `AWB ${shipment.awb} was picked up; the receiving site is currently closed, so delivery will complete on the first open business day.`;
  }
  if (gates.pickedUp || safeTruth.pickedUp) return `AWB ${shipment.awb} has been picked up. We are checking final delivery timing and will update shortly.`;
  if (safeTruth.released) return `AWB ${shipment.awb} has cleared customs and we are arranging pickup and delivery.`;
  if (gates.customsHold || (gates.arrived && !gates.customsBrokerRelease)) {
    return `AWB ${shipment.awb} is still in customs. We are checking and will update shortly.`;
  }
  if (gates.arrived || safeTruth.arrived) return `AWB ${shipment.awb} has arrived. We are checking delivery timing and will update shortly.`;
  // Route the ETA through the external-safe filter: internal TMS shorthand
  // ("RECOVER WED 06:45") must never reach a customer draft.
  const eta = customerComm.customerSafeTruth({ ...shipment, eta: shipment.eta || shipment.expectedAt || shipment.tms?.eta || "" }).eta;
  if (eta) return `AWB ${shipment.awb} is expected ${eta}. We will update you if anything changes.`;
  return `We are checking AWB ${shipment.awb} and will update shortly.`;
}

function customerUpdateAction(shipment) {
  const customer = customerContact(shipment);
  // Policy net: if the composed body ever picks up internal vocabulary
  // (fees, brokers, quotes, customs internals), fall back to the neutral
  // opening alone rather than exposing it.
  const opening = customerUpdateOpening(shipment);
  const fullBody = conciseStatusBody(shipment, opening);
  const safeBody = customerComm.assertCustomerSafe(fullBody) ? fullBody : opening;
  return baseAction(
    shipment,
    "customer-update",
    "Draft customer update",
    customer,
    safeBody,
    {
      subject: `${shipment.awb} - shipment update`,
      reason: "Customer/client status reply requested by operator.",
      priority: "normal",
      threadTopic: "customer",
    },
  );
}

function tmsAlertAction(shipment, broker) {
  const email = broker.email || "";
  return baseAction(
    shipment,
    "tms-broker-award-experience",
    `Send TMS alert to ${broker.name || "broker"}`,
    { ...broker, email },
    `Send CourierCloud AGT alert for AWB ${shipment.awb} to ${broker.name || "broker"}.`,
    {
      channel: "couriercloud",
      execution: "operator-approved-tms",
      orderLink: shipment.tms?.orderLink || "",
      subject: `${shipment.awb} - pickup alert`,
      reason: "Release package is ready and broker needs the TMS alert.",
      tmsIntent: {
        kind: "agent-alert",
        brokerName: broker.name || "",
        brokerEmail: email,
        copyEmail: OPERATOR_EMAIL,
        contactedEmails: [email, OPERATOR_EMAIL].filter(Boolean),
      },
    },
  );
}

function followPickupAction(shipment, broker) {
  return baseAction(
    shipment,
    "broker-status-followup",
    `Confirm pickup with ${broker.name || "broker"}`,
    broker,
    conciseStatusBody(
      shipment,
      `Can you please confirm pickup/recovery status for AWB ${shipment.awb} and send POD once delivered?`,
    ),
    {
      subject: `${shipment.awb} - pickup status`,
      reason: "Pickup broker should confirm recovery and POD path.",
      threadTopic: "pickup",
    },
  );
}

function customsFollowupAction(shipment, broker) {
  return baseAction(
    shipment,
    "customs-followup",
    `Ask ${broker.name || "customs broker"} for release`,
    broker,
    conciseStatusBody(
      shipment,
      `Can you please confirm release/DO status for AWB ${shipment.awb}?`,
    ),
    {
      subject: `${shipment.awb} - release / DO status`,
      reason: "Shipment arrived but release/DO is not confirmed.",
      threadTopic: "customs",
    },
  );
}

function stationFeeAction(shipment, station) {
  return baseAction(
    shipment,
    "station-fee-confirmation",
    `Confirm station availability with ${station.name || shipment.station || "station"}`,
    station,
    conciseStatusBody(
      shipment,
      `Can you please confirm AWB ${shipment.awb} is physically on hand and available for pickup, the piece count, and any ground handling/storage charges due?`,
    ),
    {
      subject: `${shipment.awb} - availability / ground fees`,
      reason: "Carrier tracking is not enough; station must confirm on-hand availability, pieces, and fees before dispatch.",
      threadTopic: "station",
    },
  );
}

function stationArrivalAction(shipment, station) {
  if (!station.email) {
    return baseAction(
      shipment,
      "station-contact-needed",
      `Add ${station.name || shipment.station || "station"} arrival contact`,
      { name: "Ops Brain", email: "" },
      `Station arrival proof is needed for AWB ${shipment.awb}, but the station import email is missing.`,
      {
        channel: "platform",
        priority: "high",
        subject: `${shipment.awb} - station contact needed`,
        reason: "ETA has passed, but station arrival/on-hand proof is missing and no station email is saved.",
        nextAction: `Find/save the ${station.name || shipment.station || "station"} import email, then ask for on-hand status and arrival notice.`,
      },
    );
  }
  return baseAction(
    shipment,
    "station-confirmation",
    `Ask ${station.name || shipment.station || "station"} for arrival notice`,
    station,
    conciseStatusBody(
      shipment,
      `Can you please confirm if AWB ${shipment.awb} is on hand and share the arrival notice?`,
    ),
    {
      subject: `${shipment.awb} - status check`,
      reason: "ETA has passed, but station arrival/on-hand proof is still missing.",
      threadTopic: "station",
    },
  );
}

function hasExplicitStationReleaseReady(shipment) {
  const text = [
    shipment.freightBroker?.status,
    shipment.freightBroker?.brokerStatus,
    shipment.freightBroker?.pickupPlan,
    shipment.freightBroker?.nextAction,
    shipment.emailValidation?.summary,
    shipment.emailValidation?.nextAction,
    ...(shipment.emailValidation?.events || []).map(factRowText),
    ...(shipment.facts || []).map(factRowText),
  ].filter(Boolean).join(" ");
  if (/\b(?:not|no|without|missing|pending|awaiting|need|needs|needed)\b[^.;\n]{0,80}\b(?:ready for pickup|pickup-ready|available for pickup|on hand|release ready)\b/i.test(text)) {
    return false;
  }
  return /\b(?:ready[-\s]?for[-\s]?pickup|pickup[-\s]?ready|available[-\s]?for[-\s]?pickup|cargo (?:is )?available|freight (?:is )?available)\b/i.test(text);
}

function stationConfirmationNeeded(shipment, gates = gateState(shipment)) {
  if (gates.completed || gates.pickedUp || gates.deliveryReported) return false;
  if (gates.dispatchDone) return false;
  if (!gates.arrived || !gates.customsBrokerRelease || gates.customsHold) return false;
  if (hasExplicitStationReleaseReady(shipment)) return false;
  return !hasStationOnHandProof(shipment);
}

function stationArrivalConfirmationNeeded(shipment, gates = gateState(shipment)) {
  if (gates.completed || gates.arrived || gates.pickedUp || gates.deliveryReported) return false;
  const hours = hoursUntilEta(shipment);
  return Number.isFinite(hours) && hours <= 0 && hours >= -96;
}

function quoteAmountValue(quote) {
  const match = String(quote.amount || quote.rate || quote.price || quote.quote || quote.text || "").match(/\$?\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return Infinity;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : Infinity;
}

function lowestPickupQuote(shipment) {
  return pickupQuotes(shipment)
    .map((quote) => ({ ...quote, value: quoteAmountValue(quote) }))
    .filter((quote) => Number.isFinite(quote.value))
    .sort((a, b) => a.value - b.value)[0] || null;
}

function quoteDecisionAction(shipment, actions = null) {
  const selected = selectedPickupAward(shipment, actions);
  const quote = selected
    ? {
      broker: selected.broker,
      email: selected.email,
      contactEmail: selected.email,
      amount: selected.amount,
      selected: true,
      reason: selected.reason,
    }
    : lowestPickupQuote(shipment);
  if (!quote) return null;
  const approved = approvedPickupBrokerForName(quote.broker || quote.email || quote.contactEmail || "");
  const brokerName = approved?.name || cleanSelectedBrokerName(quote.broker || "") || quote.broker || "";
  const brokerEmail = quote.email || quote.contactEmail || approved?.email || "";
  return baseAction(
    shipment,
    "broker-award",
    `${quote.selected ? "Confirm" : "Award"} ${brokerName || "pickup broker"} ${quote.amount || ""}`.trim(),
    { name: brokerName || "", email: brokerEmail },
    conciseStatusBody(
      shipment,
      `Please confirm you can proceed with pickup/delivery for AWB ${shipment.awb} at ${quote.amount || "your quoted rate"}.`,
    ),
    {
      subject: `${shipment.awb} - pickup award`,
      reason: quote.reason || `${brokerName || "This broker"} is the lowest last-mile pickup option found.`,
      threadTopic: "quote",
    },
  );
}

function hoursUntilEta(shipment) {
  const eta =
    shipment.eta ||
    shipment.expectedAt ||
    shipment.recoverAt ||
    shipment.tms?.eta ||
    String(statusText(shipment)).match(/\b(?:eta|expected|recover|arrive)[^0-9A-Z]{0,20}([A-Z][a-z]{2,8}\.? \d{1,2}(?:, \d{4})?(?:\s*\/\s*\d{1,2}:\d{2}\s*(?:AM|PM)?)?|\d{4}-\d{2}-\d{2}(?:T[0-9:.Z-]+)?)\b/i)?.[1] ||
    "";
  if (!eta) return Infinity;
  const normalizedEta = String(eta)
    .replace(/\s*\/\s*/g, " ")
    .replace(/\s+\b[A-Z]{3}\b\s*$/i, "")
    .trim();
  let timestamp = Date.parse(normalizedEta);
  if (!Number.isFinite(timestamp) && /^[A-Z][a-z]{2,8}\.? \d{1,2}/.test(String(eta))) {
    timestamp = Date.parse(`${normalizedEta} ${new Date().getUTCFullYear()}`);
  }
  if (!Number.isFinite(timestamp)) return Infinity;
  return (timestamp - Date.now()) / 36e5;
}

function quoteRequestRowsForShipment(shipment, actions = {}) {
  return queuedActionRowsForShipment(shipment, actions)
    .filter((row) => !/\b(?:failed|blocked|cancelled|canceled|dismissed)\b/i.test(String(row.status || "")))
    .filter((row) => /\b(?:quote-request|quote request|pickup quote|rate request)\b/i.test(
      `${row.type || ""} ${row.label || ""} ${row.subject || ""}`,
    ));
}

function quoteBlastAlreadyExists(shipment, actions = {}, brokerEmail = "") {
  const requestedEmails = new Set(
    quoteRequestRowsForShipment(shipment, actions)
      .flatMap((row) => contactEmailList([
        row.targetEmail,
        row.to,
        row.originalTargetEmail,
      ].filter(Boolean).join(" "))),
  );
  const requestedBroker = String(brokerEmail || "").trim().toLowerCase();
  if (requestedBroker) return requestedEmails.has(requestedBroker);
  if (APPROVED_PICKUP_BROKERS.every((broker) => requestedEmails.has(broker.email.toLowerCase()))) {
    return true;
  }
  // Preserve old shipment-level history that proves a blast already happened,
  // even when it predates per-broker action rows.
  return /\b(?:quote blast (?:sent|drafted|requested)|requested pickup rates|asked for rates|quote asked|rate request (?:sent|drafted)|sent\/drafted to)\b/i.test(statusText(shipment));
}

function quoteBlastNeeded(shipment, actions) {
  const gates = gateState(shipment);
  if (gates.completed || gates.pickedUp) return false;
  if (gates.dispatchDone || gates.pickupScheduled) return false;
  if (gates.groundDue) return false;
  if (stationArrivalConfirmationNeeded(shipment, gates)) return false;
  if (stationConfirmationNeeded(shipment, gates)) return false;
  if (pickupQuotes(shipment).length) return false;
  if (quoteBlastAlreadyExists(shipment, actions)) return false;
  const pickup = pickupBrokerContact(shipment, actions);
  if (
    gates.arrived &&
    gates.customsBrokerRelease &&
    !gates.customsHold &&
    !gates.arrivalIncomplete &&
    !gates.pickupBlocked &&
    !knownPickupBroker(shipment, actions) &&
    !pickup.name &&
    !pickup.email
  ) {
    return true;
  }
  const hours = hoursUntilEta(shipment);
  return Number.isFinite(hours) && hours <= 48 && hours >= -12;
}

function preArrivalQuoteBlastNeeded(shipment, actions) {
  const gates = gateState(shipment);
  if (gates.completed || gates.pickedUp || gates.dispatchDone || gates.pickupScheduled || gates.groundDue) return false;
  if (pickupQuotes(shipment).length) return false;
  if (quoteBlastAlreadyExists(shipment, actions)) return false;
  const hours = hoursUntilEta(shipment);
  return Number.isFinite(hours) && hours <= 48 && hours >= -12;
}

function questionRequestsCustomerUpdate(question) {
  const text = String(question || "").toLowerCase();
  return /\b(?:customer|client|consignee|skyler)\b.{0,80}\b(?:update|reply|status|email|draft|answer)\b/i.test(text) ||
    /\b(?:draft|send|write|reply)\b.{0,80}\b(?:customer|client|consignee|skyler)\b/i.test(text);
}

function questionRequestsDeliveryOrder(question) {
  const text = String(question || "").toLowerCase();
  return /\b(?:generate|create|make|prepare|need|needs?|send|draft)\b.{0,80}\b(?:delivery order|d\/?o|do pdf)\b/i.test(text) ||
    /\b(?:delivery order|d\/?o|do pdf)\b.{0,80}\b(?:generate|create|make|prepare|pdf)\b/i.test(text);
}

function postPickupOrPodWorkOwnsShipment(shipment) {
  if (!shipment) return false;
  if (shipment.completed || String(shipment.truthPacketRole || "").toLowerCase() === "completed") return true;
  const gates = gateState(shipment);
  const phase = String(shipment.opsState?.phase || shipment.canonicalState?.phase || shipment.phase || "").toLowerCase();
  if ([
    "picked-up",
    "out-for-delivery",
    "delivery-scheduled",
    "pod-needed",
    "delivered-pod-pending",
    "delivered",
    "completed",
  ].includes(phase)) {
    return true;
  }
  if (gates.completed || gates.pickedUp || gates.deliveryReported || gates.podReceived || gates.podPending || gates.deliveryOutForDelivery) {
    return true;
  }
  return false;
}

function deliveryOrderGenerationAllowed(shipment) {
  if (!shipment || shipment.completed || String(shipment.truthPacketRole || "").toLowerCase() === "completed") return false;
  if (postPickupOrPodWorkOwnsShipment(shipment)) return false;
  return true;
}

function deliveryOrderAction(shipment, options = {}) {
  const carrierName = cleanSelectedBrokerName(options.carrierName || airportDwellCarrierName(shipment) || "");
  const action = baseAction(
    shipment,
    "delivery-order",
    carrierName ? `Generate DO for ${carrierName}` : "Generate delivery order",
    { name: "Delivery order PDF", email: "contact-e984b9fd@company-864595a8.example" },
    `Generate a delivery order PDF for AWB ${shipment.awb}${carrierName ? ` with carrier ${carrierName}` : ""}.`,
    {
      channel: "document",
      execution: "document-generation",
      reason: carrierName
        ? `Pickup broker asked for remaining docs; generate the delivery order for ${carrierName}.`
        : "Operator requested a delivery order PDF. This generates a file only.",
      subject: `${shipment.awb} - delivery order`,
      priority: "normal",
    },
  );
  return {
    ...action,
    targetEmail: "",
    cc: "",
    missing: [],
    documentIntent: {
      kind: "delivery-order",
      awb: shipment.awb,
      carrierName,
    },
    autonomy: {
      level: "L2",
      mode: "document-generation",
      requiresHumanApproval: true,
      liveExecution: true,
      transport: "local-pdf-generation",
    },
    safety: {
      mode: "document-generation",
      originalChannel: "document",
      note: "Generates a delivery order PDF only. No Gmail draft, email, or TMS job is created.",
    },
  };
}

function deliveryOrderEmailAction(shipment, contact, conversation = null, options = {}) {
  const carrierName = cleanSelectedBrokerName(options.carrierName || airportDwellCarrierName(shipment) || "");
  return baseAction(
    shipment,
    "delivery-order-email",
    "Reply with delivery order attached",
    contact,
    conciseStatusBody(
      shipment,
      `Attached is the delivery order for AWB ${shipment.awb}.`,
    ),
    {
      subject: `${shipment.awb} - delivery order`,
      reason: carrierName
        ? `Reply in the pickup thread with the delivery order attached for ${carrierName}.`
        : "Reply in the pickup thread with the delivery order attached.",
      threadTopic: "pickup",
      conversation,
      documentIntent: { kind: "delivery-order", awb: shipment.awb, carrierName },
      attachmentIntent: { kind: "delivery-order", awb: shipment.awb, carrierName },
      carrierName,
    },
  );
}

function pickupLocationReplyAction(shipment, contact, conversation = null) {
  const stationLine = stationLocationLine(shipment) || [shipment.airline, shipment.station, "cargo terminal"].filter(Boolean).join(" ");
  return baseAction(
    shipment,
    "pickup-location-reply",
    `Reply with ${shipment.station || "airport"} pickup location`,
    contact,
    conciseStatusBody(
      shipment,
      `Pickup location for AWB ${shipment.awb}: ${stationLine}.`,
    ),
    {
      subject: `${shipment.awb} - pickup location`,
      reason: "Pickup broker asked for the exact airport pickup location.",
      threadTopic: "pickup",
      conversation,
    },
  );
}

function physicalPickupCheckAction(shipment, contact, conversation = null) {
  const station = [shipment.station, shipment.airline].filter(Boolean).join(" / ") || "the airport";
  return baseAction(
    shipment,
    "broker-status-followup",
    `Ask ${contact.name || "broker"} if pickup happened`,
    contact,
    conciseStatusBody(
      shipment,
      `Can you please confirm whether AWB ${shipment.awb} has physically been picked up from ${station}? If yes, please send the pickup time and POD once delivered.`,
    ),
    {
      subject: `${shipment.awb} - physical pickup status`,
      reason: "Pickup docs/location path exists, but physical pickup is not proven yet.",
      threadTopic: "pickup",
      conversation,
    },
  );
}

function airportDwellActionsForShipment(shipment, actions = {}) {
  const gates = gateState(shipment);
  if (gates.completed || gates.pickedUp || gates.deliveryReported) return [];
  if (activeOperationalException(shipment) && canonicalShipmentPhase(shipment) === "exception") return [];
  const airportContact = airportDwellPickupContact(shipment);
  const explicitAirportCarrier = airportDwellCarrierName(shipment);
  const locationRow = airportDwellLatestRow(shipment, AIRPORT_DWELL_LOCATION_PATTERN);
  const docsRow = airportDwellLatestRow(shipment, AIRPORT_DWELL_DOCS_PATTERN);
  const docsResolvedRow = airportDwellLatestRow(shipment, /\bpickup-docs-sent\b|\bpickup docs\/delivery order were sent\b|\bdelivery order (?:was )?sent\b|\battached\b[^.\n]{0,80}\b(?:delivery order|d\/?o|docs?)\b/i);
  const docsStillOpen = docsRow && (!docsResolvedRow ||
    factTime(docsRow.at || docsRow.updatedAt || docsRow.createdAt) > factTime(docsResolvedRow.at || docsResolvedRow.updatedAt || docsResolvedRow.createdAt));
  const docsRowText = airportDwellRowText(docsRow);
  const docsSpecificText = [
    docsRow?.evidence,
    docsRow?.note,
    docsRow?.body,
    docsRow?.text,
    docsRow?.rawText,
    docsRow?.messageText,
  ].filter(Boolean).join(" ") || docsRow?.summary || docsRow?.nextAction || "";
  const awbCopyOnlyOpen = Boolean(
    docsStillOpen &&
      AWB_COPY_ONLY_DOCS_PATTERN.test(docsSpecificText || docsRowText) &&
      !/\b(?:delivery order|d\/?o|remaining pickup docs|remaining necessary docs|release package)\b/i.test(docsSpecificText || docsRowText)
  );
  const releaseVisibleProblem = airportDwellLatestRow(shipment, /\bstation-release-not-visible\b|\bstation-cargo-not-found\b|\bcargo-not-located\b|\bcargo not found\b|\bfreight not found\b|\brelease-not-visible\b|\bstation cannot see clearance\b|\bstation cannot see release\b|\bcannot see clearance\b|(?:לא מוצאים|לא נמצא|לא נמצאה|לא נמצאו|מטען חסר|המטענ חסר|לא מאתרים|לא איתרו)/i);
  const dwellRow = docsRow || locationRow || releaseVisibleProblem;
  const conversation = airportDwellConversation(dwellRow);
  const fallbackContact = pickupBrokerContact(shipment, actions);
  const contact = airportContact || fallbackContact;
  const carrierName = cleanSelectedBrokerName(explicitAirportCarrier || "");
  const rows = [];

  const addPing = (reason, nextAction) => {
    if (emailAlreadyRequested(shipment, actions, /operator-ping|urgent ops exception|urgent operator ping/i)) return;
    rows.push(operatorPingAction(shipment, { level: "immediate", reason, nextAction }));
  };

  if (docsStillOpen && !gates.customsBrokerRelease) {
    if (awbCopyOnlyOpen) {
      addPing(
        `${contact?.name || "Airport document thread"} needs a copy of the AWB.`,
        "Reply in the same thread with the AWB/air waybill copy; do not treat this as a customs hold.",
      );
      return rows.slice(0, 2);
    }
    addPing(
      carrierName ? `${contact?.name || "Pickup broker"} needs remaining docs for ${carrierName}.` : `${contact?.name || "Pickup broker"} needs remaining pickup docs.`,
      carrierName ? `Generate the delivery order for ${carrierName}, then reply in the pickup thread.` : "Generate the delivery order, then reply in the pickup thread.",
    );
    rows.push(deliveryOrderAction(shipment, { carrierName }));
    if (hasAirportDwellReplyTarget(airportContact, conversation) && !emailAlreadyRequested(shipment, actions, /delivery-order-email|delivery order attached|pickup docs\/delivery order were sent|attached[^.\n]{0,80}(?:delivery order|d\/?o|docs?)/i)) {
      rows.push(deliveryOrderEmailAction(shipment, airportContact, conversation, { carrierName }));
    }
    return rows.slice(0, 3);
  }

  if (locationRow && !gates.customsBrokerRelease) {
    addPing(
      `${contact.name || "Pickup broker"} needs the airport pickup location.`,
      `Reply in the same pickup thread with the ${shipment.station || "airport"} pickup location.`,
    );
    if (hasAirportDwellReplyTarget(airportContact, conversation) && !emailAlreadyRequested(shipment, actions, /pickup-location-reply|pickup location/i)) {
      rows.push(pickupLocationReplyAction(shipment, airportContact, conversation));
    }
    return rows.slice(0, 3);
  }

  if (releaseVisibleProblem && !gates.pickedUp) {
    const cargoMissing = CARGO_NOT_FOUND_PATTERN.test(airportDwellRowText(releaseVisibleProblem));
    addPing(
      cargoMissing
        ? "Airport pickup is blocked because the station/pickup side cannot locate the cargo."
        : "Airport pickup is blocked because clearance/release is not visible at the station.",
      cargoMissing
        ? "Call the station and pickup broker now; do not re-dispatch or keep the driver waiting until the freight is physically located."
        : "Call the station and broker now; clear release visibility before the driver waits longer.",
    );
    return rows.slice(0, 3);
  }

  if ((locationRow || docsRow || explicitAirportCarrier) && gates.arrived && gates.customsBrokerRelease && !gates.pickedUp) {
    addPing(
      carrierName ? `${carrierName} has the pickup path, but physical pickup is not proven.` : "Pickup path exists, but physical pickup is not proven.",
      `Ask ${contact.name || carrierName || "the pickup broker"} if the freight physically left the airport.`,
    );
    if (hasAirportDwellReplyTarget(airportContact, conversation) && !emailAlreadyRequested(shipment, actions, /physical pickup status|broker-status-followup|pickup status/i)) {
      rows.push(physicalPickupCheckAction(shipment, airportContact, conversation));
    }
    return rows.slice(0, 3);
  }

  return rows.slice(0, 3);
}

function quoteBlastActions(shipment, actions = {}) {
  const cargo = cargoLine(shipment);
  return APPROVED_PICKUP_BROKERS
    .filter((broker) => !quoteBlastAlreadyExists(shipment, actions, broker.email))
    .map((broker) => baseAction(
      shipment,
      "quote-request",
      `Request pickup quote from ${broker.name}`,
      { name: broker.name, email: broker.email },
      [
        counterpartyGreeting(broker.name),
        "",
        `Can you please quote pickup/delivery for AWB ${shipment.awb}?`,
        shipment.station ? `Pickup from: ${shipment.station}` : "",
        shipment.consignee || shipment.client ? `Deliver to: ${shipment.consignee || shipment.client}` : "",
        cargo ? cargo.replace(/^Cargo:\s*/i, "Cargo:") : "",
        "",
        "Thank you,",
        "Alex",
      ].filter((line) => line !== "").join("\n"),
      {
        subject: `${shipment.awb} - pickup quote request`,
        reason: `ETA is close and no last-mile pickup price is in memory. Ask ${broker.name} for a pickup/delivery rate.`,
        priority: "normal",
        threadTopic: "quote",
        threadPolicy: "start_new",
      },
    ));
}

function existingActionPacketsForShipment(shipment, actions = {}) {
  const key = normalizeAwb(shipment.awb || shipment.id);
  if (!key) return [];
  const rows = [
    ...(actions.actions || []),
    ...((actions.outbox?.requests || actions.outboxRequests || []).map((request) => ({
      ...request,
      id: request.actionId || request.id,
      targetEmail: request.targetEmail || request.to || "",
      targetName: request.targetName || request.originalTargetName || "",
      channel: request.channel || request.originalChannel || "",
    }))),
  ];
  const seen = new Set();
  return rows
    .filter((action) => normalizeAwb(action.awb || action.shipmentAwb) === key)
    .filter((action) => action.channel && !/\b(?:failed|blocked|cancelled|canceled|dismissed)\b/i.test(String(action.status || "")))
    .map((action) => {
      const actionType = String(action.type || "");
      const fallbackThreadPolicy = /quote-request/i.test(actionType) ? "start_new" : "";
      const threadPolicy = action.threadPolicy || action.preflight?.threadPolicy || (action.replyMessageId || action.conversation?.replyMessageId || action.conversation?.threadId ? "reply_existing" : fallbackThreadPolicy);
      return {
        ...action,
        id: action.id || `${key}-${actionType || action.channel || "action"}`,
        targetEmail: action.targetEmail || action.to || "",
        targetName: action.targetName || action.originalTargetName || "",
        execution: action.execution || action.originalExecution || "",
        threadPolicy,
        replyMessageId: action.replyMessageId || action.conversation?.replyMessageId || "",
        conversation: action.conversation || null,
        readiness: action.readiness || action.preflight?.status || "ready",
        preflight: action.preflight || {
          status: "ready",
          ready: true,
          missing: [],
          errors: [],
          threadPolicy,
          reason: "",
        },
        missing: Array.isArray(action.missing) ? action.missing : [],
        blockedReason: action.blockedReason || "",
      };
    })
    .filter((action) => existingActionStillValidForShipment(shipment, action, actions))
    .filter((action) => {
      const id = [
        action.actionId || action.id,
        action.type,
        normalizeAwb(action.awb || action.shipmentAwb),
        action.targetEmail || action.to || "",
        action.subject || "",
      ].filter(Boolean).join(":").toLowerCase();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
}

function shipmentRecommendedActionPacketsForShipment(shipment, actions = {}) {
  const key = normalizeAwb(shipment.awb || shipment.id);
  if (!key || !Array.isArray(shipment.recommendedActions)) return [];
  const gates = gateState(shipment);
  return shipment.recommendedActions
    .filter((action) => normalizeAwb(action.awb || action.shipmentAwb || shipment.awb) === key)
    .filter((action) => action.channel && !/\b(?:failed|blocked|cancelled|canceled|dismissed)\b/i.test(String(action.status || "")))
    .filter((action) => existingActionStillValidForShipment(shipment, action))
    .filter((action) => {
      const text = `${action.type || ""} ${action.label || ""} ${action.subject || ""}`;
      if (gates.completed) return false;
      if (/quote-request|quote/i.test(text)) {
        if (gates.pickedUp || gates.dispatchDone || gates.pickupScheduled) return false;
        if (stationArrivalConfirmationNeeded(shipment, gates) || stationConfirmationNeeded(shipment, gates)) return false;
      }
      return true;
    })
    .map((action) => {
      const actionType = String(action.type || "");
      const fallbackThreadPolicy = /quote-request/i.test(actionType) ? "start_new" : "";
      const threadPolicy = action.threadPolicy || action.preflight?.threadPolicy || (action.replyMessageId || action.conversation?.replyMessageId || action.conversation?.threadId ? "reply_existing" : fallbackThreadPolicy);
      return {
        ...action,
        id: action.id || `${key}-${actionType || action.channel || "action"}`,
        awb: action.awb || shipment.awb,
        shipmentId: action.shipmentId || shipment.id || shipment.awb,
        targetEmail: action.targetEmail || action.to || "",
        targetName: action.targetName || action.originalTargetName || "",
        execution: action.execution || action.originalExecution || "",
        threadPolicy,
        replyMessageId: action.replyMessageId || action.conversation?.replyMessageId || "",
        conversation: action.conversation || null,
        readiness: action.readiness || action.preflight?.status || "ready",
        preflight: action.preflight || {
          status: "ready",
          ready: true,
          missing: Array.isArray(action.missing) ? action.missing : [],
          errors: [],
          threadPolicy,
          reason: "",
        },
        missing: Array.isArray(action.missing) ? action.missing : [],
        blockedReason: action.blockedReason || "",
      };
    });
}

function currentRecommendedActionsForOperator(shipment) {
  const key = normalizeAwb(shipment?.awb || shipment?.id);
  if (!key || !Array.isArray(shipment?.recommendedActions)) return [];
  const gates = gateState(shipment);
  if (gates.completed) return [];
  return shipment.recommendedActions
    .filter((action) => normalizeAwb(action.awb || action.shipmentAwb || shipment.awb) === key)
    .filter((action) => action.channel && !/\b(?:failed|blocked|cancelled|canceled|dismissed)\b/i.test(String(action.status || "")))
    .filter((action) => existingActionStillValidForShipment(shipment, action))
    .filter((action) => {
      const text = `${action.type || ""} ${action.label || ""} ${action.subject || ""}`;
      if (/quote-request|quote/i.test(text)) {
        if (gates.pickedUp || gates.dispatchDone || gates.pickupScheduled) return false;
        if (stationArrivalConfirmationNeeded(shipment, gates) || stationConfirmationNeeded(shipment, gates)) return false;
      }
      return true;
    })
    .map((action) => {
      const actionType = String(action.type || "");
      const fallbackThreadPolicy = /quote-request/i.test(actionType) ? "start_new" : "";
      const threadPolicy = action.threadPolicy || action.preflight?.threadPolicy || (action.replyMessageId || action.conversation?.replyMessageId || action.conversation?.threadId ? "reply_existing" : fallbackThreadPolicy);
      return {
        ...action,
        id: action.id || `${key}-${actionType || action.channel || "action"}`,
        awb: action.awb || shipment.awb,
        shipmentId: action.shipmentId || shipment.id || shipment.awb,
        targetEmail: action.targetEmail || action.to || "",
        targetName: action.targetName || action.originalTargetName || "",
        threadPolicy,
        readiness: action.readiness || action.preflight?.status || "ready",
        preflight: action.preflight || {
          status: "ready",
          ready: true,
          missing: Array.isArray(action.missing) ? action.missing : [],
          errors: [],
          threadPolicy,
          reason: "",
        },
        missing: Array.isArray(action.missing) ? action.missing : [],
        blockedReason: action.blockedReason || "",
      };
    })
    .slice(0, 3);
}

function answerActionsForShipment(shipment, actionContext) {
  const proposed = proposedActionsForShipment(shipment, actionContext);
  const stationNeeded = stationConfirmationNeeded(shipment, gateState(shipment)) || stationArrivalConfirmationNeeded(shipment, gateState(shipment));
  const station = stationNeeded ? stationContact(shipment) : {};
  const stationAction = stationNeeded && station.email ? stationFeeAction(shipment, station) : null;
  if (proposed.length) {
    if (stationAction && !proposed.some((action) => /station-(?:fee-)?confirmation/i.test(action.type || ""))) {
      return [stationAction, ...proposed].slice(0, 3);
    }
    return proposed;
  }
  const recommended = currentRecommendedActionsForOperator(shipment);
  if (recommended.length) {
    if (stationAction && !recommended.some((action) => /station-(?:fee-)?confirmation/i.test(action.type || ""))) {
      return [stationAction, ...recommended].slice(0, 3);
    }
    return recommended;
  }
  if (stationAction) return [stationAction];
  return [];
}

function existingActionStillValidForShipment(shipment, action, actions = {}) {
  const gates = gateState(shipment);
  const type = String(action.type || "");
  const status = String(action.status || "");
  const actionText = `${type} ${action.label || ""} ${action.subject || ""} ${action.title || ""}`;
  if (/\b(?:failed|blocked|cancelled|canceled|dismissed)\b/i.test(status)) return false;
  if (/station-confirmation|station-fee-confirmation/i.test(type)) {
    return stationConfirmationNeeded(shipment, gates) || stationArrivalConfirmationNeeded(shipment, gates);
  }
  if (/tms-pod-closeout|pod-closeout/i.test(type)) {
    return Boolean(gates.completed);
  }
  if (/pod-followup|pod request/i.test(`${type} ${action.label || ""} ${action.subject || ""}`)) {
    return Boolean(gates.pickedUp || gates.deliveryReported) && !gates.completed;
  }
  if (/quote-request|quote/i.test(actionText)) {
    if (gates.completed || gates.pickedUp || gates.dispatchDone || gates.pickupScheduled || gates.driverOnsite || gates.customsHold || gates.pickupBlocked || gates.groundDue) return false;
    if (stationArrivalConfirmationNeeded(shipment, gates) || stationConfirmationNeeded(shipment, gates)) return false;
    if (selectedPickupAward(shipment, actions)) return false;
    return true;
  }
  if (/delivery-order-email|release-packet|source-backfill|send.*release|send.*delivery order|generate.*delivery order/i.test(actionText)) {
    if (gates.completed || gates.pickedUp || gates.deliveryReported || gates.driverOnsite || gates.pickupBlocked || gates.customsHold) return false;
    if (stationArrivalConfirmationNeeded(shipment, gates) || stationConfirmationNeeded(shipment, gates)) return false;
  }
  if (/broker-status-followup/i.test(type)) {
    if (gates.completed || gates.pickedUp || gates.deliveryReported || gates.driverOnsite || gates.pickupBlocked || gates.customsHold) return false;
    if (pickupQuotes(shipment).length && !selectedPickupAward(shipment, actions)) return false;
    if (gates.pickupScheduled && gates.pickupScheduledDate && gates.pickupScheduledDate >= operatorDateKey(new Date())) return false;
    const pickup = pickupBrokerContact(shipment, actions);
    return Boolean(gates.arrived && gates.customsBrokerRelease && pickup.name && pickup.email && !gates.pickedUp);
  }
  if (/broker-award|tms-broker-award/i.test(type)) {
    return Boolean(gates.arrived && gates.customsBrokerRelease && !gates.pickedUp && !gates.driverOnsite && !gates.pickupBlocked && !gates.customsHold);
  }
  return true;
}

function missingPodContactAction(shipment, pickup = {}) {
  const brokerName = pickup.name || knownPickupBroker(shipment) || "pickup/POD contact";
  return operatorPingAction(shipment, {
    level: "explicit",
    reason: `POD is pending, but ${brokerName} has no usable email in memory.`,
    nextAction: "Find the pickup/POD contact or open the existing pickup thread before drafting a POD request.",
  });
}

function actionConditionKey(action) {
  const awb = normalizeAwb(action?.awb || action?.shipmentAwb || action?.shipmentId || "");
  const text = `${action?.type || ""} ${action?.targetRole || ""} ${action?.label || ""} ${action?.reason || ""} ${action?.problem || ""} ${action?.nextAction || ""}`.toLowerCase();
  if (/operator-ping/.test(text) && /\b(customs|release|clearance|d\/?o|delivery order)\b/.test(text)) return `${awb}:operator-ping:customs-release`;
  if (/operator-ping/.test(text) && /\b(pod|proof of delivery|delivery proof)\b/.test(text)) return `${awb}:operator-ping:pod-contact`;
  if (/operator-ping/.test(text) && /\b(pickup|driver|carrier|loaded|onsite|waiting)\b/.test(text)) return `${awb}:operator-ping:pickup`;
  if (/operator-ping/.test(text) && /\b(station|availability|fees|cargo|handler)\b/.test(text)) return `${awb}:operator-ping:station`;
  return `${awb}:${action?.type || ""}:${action?.id || action?.label || ""}`.toLowerCase();
}

function dedupeProposedActions(actions = []) {
  const seen = new Set();
  return actions.filter((action) => {
    const key = actionConditionKey(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitActionsWithCompleteQuoteFanout(actions = [], limit = 3) {
  const visible = dedupeProposedActions(actions);
  const limited = visible.slice(0, limit);
  return dedupeProposedActions([
    ...limited,
    ...visible.filter((action) => action.type === "quote-request"),
  ]);
}

function canonicalPlannerActionMatchesShipment(action = {}, shipment = {}) {
  if (!isCanonicalPlannerAction(action)) return false;
  const gates = truthPacketGateMap(shipment);
  const phase = canonicalTruthPhase(shipment, gates) || shipment.opsState?.phase || shipment.stage || "";
  if (!phase) return true;
  const planId = String(action.actionPlanId || "");
  if (!planId) return true;
  return planId.includes(`-${phase}-action-plan`);
}

function proposedActionsForShipment(shipment, actions) {
  const gates = gateState(shipment);
  const text = statusText(shipment);
  if (gates.completed) {
    const backfill = completedSourceBackfillAction(shipment);
    return backfill ? [backfill] : [];
  }
  const rawPhase = String(shipment.opsState?.phase || shipment.phase || "").toLowerCase();
  const resolvedCanonicalPhase = canonicalTruthPlanEligible(shipment)
    ? canonicalTruthPhase(shipment, truthPacketGateMap(shipment))
    : "";
  const plannerShipment = resolvedCanonicalPhase && resolvedCanonicalPhase !== rawPhase
    ? {
      ...shipment,
      opsState: {
        ...(shipment.opsState || {}),
        phase: resolvedCanonicalPhase,
        nextAction: resolvedCanonicalPhase === "dispatch-ready"
          ? "Create or confirm the pickup broker relationship, then dispatch pickup."
          : shipment.opsState?.nextAction || shipment.nextAction || "",
      },
    }
    : shipment;
  const proposals = [];
  const existingActions = existingActionPacketsForShipment(shipment, actions);
  const shipmentRecommendedActions = shipmentRecommendedActionPacketsForShipment(shipment, actions);
  const storedMatchingActions = dedupeProposedActions([
    ...existingActions,
    ...shipmentRecommendedActions,
  ].filter((action) => canonicalPlannerActionMatchesShipment(action, plannerShipment)));
  // ONE source of "next move": the canonical planner's primary action leads —
  // it is exactly what the cockpit shows. Stored/recommended packets from
  // earlier refreshes follow as alternates; they must never outrank it
  // (production 2026-07-06: chat named a station AWB-copy recipient while the
  // cockpit's primary was the customs follow-up).
  if (canonicalTruthPlanEligible(plannerShipment)) {
    const plan = buildCanonicalActionPlan(plannerShipment, [...existingActions, ...shipmentRecommendedActions], {
      stationMemory: actions?.stationMemory,
      gmailProofByAwb: new Map(
        (actions?.gmailProof?.proofs || []).map((proof) => [String(proof.awb || proof.normalizedAwb || "").replace(/\D/g, ""), proof]),
      ),
    });
    const plannerActions = dedupeProposedActions(plan.actions || []).filter(isCanonicalPlannerAction);
    const plannerPhase = String(plannerShipment.opsState?.phase || plannerShipment.phase || "").toLowerCase();
    if (["pre-arrival", "in-transit"].includes(plannerPhase) && preArrivalQuoteBlastNeeded(plannerShipment, actions)) {
      return limitActionsWithCompleteQuoteFanout([
        ...quoteBlastActions(plannerShipment, actions),
        ...plannerActions.filter((action) => action.type !== "station-contact-research"),
        ...plannerActions,
      ]);
    }
    if (plannerActions.length) {
      return dedupeProposedActions([...plannerActions, ...storedMatchingActions]).slice(0, 3);
    }
  }
  if (storedMatchingActions.length) return storedMatchingActions.slice(0, 3);
  const finish = (rows = proposals, limit = 3) => {
    const visible = dedupeProposedActions(rows);
    if (visible.length) return limitActionsWithCompleteQuoteFanout(visible, limit);
    return dedupeProposedActions(shipmentRecommendedActions).slice(0, limit);
  };
  const pickup = pickupBrokerContact(shipment, actions);
  const customs = customsBrokerContact(shipment);
  const station = stationContact(shipment);
  const queuedPickupAward = selectedPickupAwardFromActions(shipment, actions);
  const quoteDecision = selectedPickupAward(shipment, actions) || lowestPickupQuote(shipment);
  const explicitFeeBlocked = ["fees-needed", "ground-fees-needed"].includes(String(
    shipment.canonicalState?.phase || shipment.opsState?.phase || shipment.phase || "",
  ).toLowerCase());
  const pickupProblem = pickupProblemReason(shipment);
  const quoteDecisionReady = Boolean(
    quoteDecision &&
    gates.arrived &&
    gates.customsBrokerRelease &&
    !explicitFeeBlocked &&
    !gates.pickedUp &&
    !pickupProblem &&
    !gates.driverOnsite &&
    !gates.loadingProblem &&
    !gates.deliveryProblem &&
    !gates.arrivalIncomplete
  );
  const ping = pingPolicyForShipment(shipment, actions);
  const state = shipmentExecutionState(shipment, actions);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  if (terminalRecovery) {
    return finish([operatorPingAction(shipment, {
      level: "urgent",
      reason: terminalRecovery.problem,
      nextAction: terminalRecovery.nextAction,
    })], 1);
  }
  const explicitActionQuestion = /\b(?:what should|what do|next action|needs action|handle|resolve|do on|draft next action)\b/i.test(String(actions?.question || ""));
  const shipmentDetailQuestion = normalizeAwb(actions?.question || "") === normalizeAwb(shipment.awb);
  const scheduledDeliveryDate = gates.deliveryScheduledDate || resolveShipmentState(shipment).deliveryScheduledDate;
  const deliveryStillInWindow = (
    gates.deliveryScheduledToday ||
    deliveryListCandidate(shipment, "today") ||
    dateKeyIsTodayOrFuture(scheduledDeliveryDate)
  ) && !gates.deliveryProblem && !gates.podPending && state.phase !== "pod-needed";
  const explicitPlatformPhases = new Set([
    "conflict",
    "exception",
    "arrival-unverified",
    "storage-risk",
    "release-needed",
    "arrival-incomplete",
    "pickup-blocked",
    "loading-blocked",
    "delivery-blocked",
  ]);
  const activeException = activeOperationalException(shipment);
  if (
    activeException &&
    state.phase === "exception"
  ) {
    return finish([operatorPingAction(shipment, {
      level: "urgent",
      reason: activeException.summary || activeException.evidence || state.problem || "Open operational exception.",
      nextAction: state.nextAction || activeException.nextAction || "Resolve the exception before advancing the shipment.",
    })], 1);
  }
  const airportDwellActions = airportDwellActionsForShipment(shipment, actions);
  if (airportDwellActions.length) {
    return finish(airportDwellActions, 3);
  }

  if (!quoteDecisionReady && ping.level !== "quiet" && !emailAlreadyRequested(shipment, actions, /operator-ping|urgent ops exception|urgent operator ping/i)) {
    proposals.push(operatorPingAction(shipment, ping));
  } else if (
    explicitActionQuestion &&
    state.actionRequired &&
    explicitPlatformPhases.has(state.phase) &&
    !emailAlreadyRequested(shipment, actions, /operator-ping|urgent ops exception|urgent operator ping/i)
  ) {
    proposals.push(operatorPingAction(shipment, {
      level: "explicit",
      reason: state.problem || state.label,
      nextAction: state.nextAction,
    }));
  }

  if ((gates.loadingProblem || gates.deliveryProblem || gates.arrivalIncomplete || gates.driverOnsite) && proposals.some((action) => action.type === "operator-ping")) {
    return finish(proposals, 1);
  }

  if (pickupProblem) {
    if (!proposals.some((action) => action.type === "operator-ping")) {
      proposals.push(operatorPingAction(shipment, {
        level: "urgent",
        reason: pickupProblem,
        nextAction: state.nextAction || "Call the station/broker now and clear the pickup blocker.",
      }));
    }
    const releaseVisibilityPickupProblem =
      /\b(?:release|clearance|clear|d\/?o|delivery order)\b/i.test(pickupProblem) ||
      /\b(?:station|carrier|airline|warehouse|agent|terminal)\b[^.;\n]{0,120}\b(?:cannot|can'?t|does not|doesn'?t|not)\b[^.;\n]{0,120}\b(?:see|show|have|find|release|clearance|clear|d\/?o|delivery order)\b/i.test(text);
    if (releaseVisibilityPickupProblem) return finish(proposals, 1);
    if (station.email && !emailAlreadyRequested(shipment, actions, /station-fee-confirmation|availability \/ ground fees|physically on hand|piece count|piece-count|pickup blocker/i)) {
      proposals.push(stationFeeAction(shipment, station));
    }
    return finish(proposals, 3);
  }

  if (gates.deliveryReported) {
    if (deliveryStillInWindow && !gates.completed) return finish(proposals, 1);
    if (shipmentDetailQuestion || explicitActionQuestion || !queuedPodFollowupAlreadyRequested(shipment, actions)) {
      if (!pickup.email) {
        proposals.push(missingPodContactAction(shipment, pickup));
      } else {
        proposals.push(baseAction(
          shipment,
          "pod-followup",
          `Request POD from ${pickup.name || "broker"}`,
          pickup,
          conciseStatusBody(shipment, `Can you please send POD/delivery confirmation for AWB ${shipment.awb}?`),
          {
            subject: `${shipment.awb} - POD request`,
            reason: "Delivery is reported, but signed POD is not complete.",
            threadTopic: "pickup",
          },
        ));
      }
    }
    return finish(proposals, 1);
  }

  if (stationArrivalConfirmationNeeded(shipment, gates) && !existingActions.some((action) => /station-confirmation|station-fee-confirmation/i.test(action.type || ""))) {
    if (station.email) {
      proposals.push(stationArrivalAction(shipment, station));
    } else if ((state.actionRequired || explicitActionQuestion) && !proposals.some((action) => action.type === "operator-ping")) {
      proposals.push(operatorPingAction(shipment, {
        level: "explicit",
        reason: `${station.name || shipment.station || "Station"} email is missing for arrival/on-hand confirmation.`,
        nextAction: `Find/save the ${station.name || shipment.station || "station"} import email, then confirm on-hand availability, piece count, and fees.`,
      }));
    }
  }

  if (!gates.dispatchDone && !gates.pickupScheduled && quoteBlastNeeded(shipment, actions)) {
    proposals.push(...quoteBlastActions(shipment, actions));
  }

  const customsAlreadyReleased =
    gates.customsBrokerRelease ||
    canonicalGateIs(shipment, "customs", ["released", "cleared", "done"]) ||
    [shipment.clearanceStatus, shipment.customsBroker?.status, shipment.customsBroker?.brokerStatus]
      .some((value) => explicitCustomsStatusLooksReleased(value));
  if (gates.arrived && !customsAlreadyReleased && !gates.customsHold && !gates.arrivalIncomplete && !emailAlreadyRequested(shipment, actions, /customs-followup|release \/ do status|release\/DO status/i)) {
    if (!customs.email) {
      const brokerName = customs.name || "customs broker";
      const missingContactPing = operatorPingAction(shipment, {
        level: "explicit",
        reason: `Release/DO is missing, but ${brokerName} email is not known.`,
        nextAction: `Find ${brokerName} email or the release thread before drafting a release follow-up.`,
      });
      const existingPingIndex = proposals.findIndex((action) => action.type === "operator-ping");
      if (existingPingIndex >= 0) {
        proposals[existingPingIndex] = missingContactPing;
      } else {
        proposals.push(missingContactPing);
      }
      return finish(proposals, 3);
    }
    proposals.push(customsFollowupAction(shipment, customs));
  }

  if (stationConfirmationNeeded(shipment, gates) && !emailAlreadyRequested(shipment, actions, /station-fee-confirmation|availability \/ ground fees|physically on hand/i)) {
    if (station.email) {
      proposals.push(stationFeeAction(shipment, station));
    }
    if (!station.email && !pickup.email && (state.actionRequired || explicitActionQuestion) && !proposals.some((action) => action.type === "operator-ping")) {
      proposals.push(operatorPingAction(shipment, {
        level: "explicit",
        reason: `${station.name || shipment.station || "Station"} email is missing for availability/fee confirmation.`,
        nextAction: `Find/save the ${station.name || shipment.station || "station"} import email, then confirm on-hand availability, piece count, and fees.`,
      }));
    }
  }

  if (quoteDecision && gates.arrived && gates.customsBrokerRelease && !explicitFeeBlocked && !publicPickupOwnerConfirmed(shipment) && !gates.pickedUp && !queuedPickupAward) {
    proposals.push(quoteDecisionAction(shipment, actions));
  }

  if (
    gates.pickupScheduled &&
    !gates.pickedUp &&
    !proposals.some((action) => action.type === "operator-ping") &&
    !emailAlreadyRequested(shipment, actions, /operator-ping|urgent ops exception|urgent operator ping/i)
  ) {
    const brokerName = pickup.name || knownPickupBroker(shipment, actions) || "pickup broker";
    const pickupDate = gates.pickupScheduledDate ? formatDate(gates.pickupScheduledDate) : "";
    proposals.push(operatorPingAction(shipment, {
      level: "explicit",
      reason: `${brokerName} is scheduled for pickup${pickupDate ? ` ${pickupDate}` : ""}, but physical pickup proof is not in memory.`,
      nextAction: `Check scheduled pickup with ${brokerName}${pickupDate ? ` ${pickupDate}` : ""}; collect loaded proof/POD after physical pickup.`,
    }));
  }

  const pickupFollowupDue = !gates.pickupScheduled || !gates.pickupScheduledDate || gates.pickupScheduledDate < operatorDateKey(new Date());
  if (gates.arrived && gates.customsBrokerRelease && pickup.name && pickup.email && !gates.pickedUp && !queuedPickupAward && !quoteDecision && pickupFollowupDue) {
    if (!emailAlreadyRequested(shipment, actions, /broker-status-followup|pickup status|pod-followup/i)) {
      proposals.push(followPickupAction(shipment, pickup));
    }
  }

  if (state.actionRequired && gates.arrived && gates.customsBrokerRelease && !(pickup.name && pickup.email) && !quoteDecision && !gates.pickedUp && !proposals.length && !resolvedPickupBlockerInstruction(text)) {
    proposals.push(operatorPingAction(shipment, {
      level: "explicit",
      reason: "Release is ready, but no pickup broker award is confirmed.",
      nextAction: "Choose or confirm the pickup broker before drafting pickup follow-up.",
    }));
  }

  const hasScheduledDeliveryPath = Boolean(scheduledDeliveryDate);
  if (gates.pickedUp && !gates.deliveryReported && hasScheduledDeliveryPath && deliveryStillInWindow) return finish(proposals, 3);
  if ((gates.pickedUp || gates.deliveryReported) && !deliveryStillInWindow && !gates.completed && !queuedPodFollowupAlreadyRequested(shipment, actions)) {
    if (!pickup.email) {
      proposals.push(missingPodContactAction(shipment, pickup));
    } else {
      proposals.push(baseAction(
        shipment,
        "pod-followup",
        `Request POD from ${pickup.name || "broker"}`,
        pickup,
        conciseStatusBody(shipment, `Can you please send POD/delivery confirmation for AWB ${shipment.awb}?`),
        {
          subject: `${shipment.awb} - POD request`,
          reason: "Pickup is in memory, but delivery/POD is not complete.",
          threadTopic: "pickup",
        },
      ));
    }
  }

  const displayExistingActions = proposals.length ? [] : [...existingActions, ...shipmentRecommendedActions];
  return finish([...proposals, ...displayExistingActions], 3);
}

function isConflictClarificationAction(action) {
  if (!action || action.type !== "operator-ping") return false;
  const text = `${action.label || ""} ${action.reason || ""} ${action.problem || ""} ${action.body || ""}`;
  return /\b(?:conflict|conflicting evidence|which source is correct|operator note|what actually happened)\b/i.test(text);
}

function podLine(shipment) {
  const text = statusText(shipment);
  const gates = gateState(shipment);
  const recipient = shipment.pod?.recipient || String(text).match(/\b(?:signed by|received by|delivered to)\s+([A-Za-z][A-Za-z .'-]{1,40})/i)?.[1] || "";
  const deliveredAt = shipment.pod?.deliveredAt || shipment.completion?.deliveredAt || "";
  if (gates.completed) {
    return `Delivered${recipient ? ` to ${compact(recipient, 34)}` : ""}${deliveredAt ? ` · ${compact(deliveredAt, 42)}` : ""}. POD found.`;
  }
  if (gates.deliveryReported) return "Delivered; POD pending.";
  if (POD_PENDING_PATTERN.test(text)) return "POD: pending.";
  return "";
}

function sourceCoverageForShipment(shipment = {}) {
  return shipment.sourceCoverage || shipment.completion?.sourceCoverage || null;
}

function sourceCoverageNeedsBackfill(shipment = {}) {
  const coverage = sourceCoverageForShipment(shipment);
  const unresolved = Array.isArray(coverage?.unresolvedMissingPreDeliveryStages)
    ? coverage.unresolvedMissingPreDeliveryStages
    : coverage?.missingPreDeliveryStages || [];
  return Boolean(coverage?.needsHistoricalBackfill || coverage?.completeness === "final-proof-only" || unresolved.length);
}

function sourceCoverageLabel(completeness = "") {
  if (completeness === "full-cycle") return "full cycle";
  if (completeness === "explained-cycle") return "explained cycle";
  if (completeness === "partial-cycle") return "partial cycle";
  if (completeness === "final-proof-only") return "final proof only";
  return String(completeness || "unknown").replace(/-/g, " ");
}

function sourceCoverageMissingStages(shipment = {}) {
  const coverage = sourceCoverageForShipment(shipment);
  const unresolved = Array.isArray(coverage?.unresolvedMissingPreDeliveryStages)
    ? coverage.unresolvedMissingPreDeliveryStages
    : coverage?.missingPreDeliveryStages || [];
  return unique(unresolved).slice(0, 5);
}

function sourceCoverageLine(shipment = {}) {
  const coverage = sourceCoverageForShipment(shipment);
  if (!coverage?.completeness) return "";
  const label = sourceCoverageLabel(coverage.completeness);
  const missing = sourceCoverageMissingStages(shipment);
  if (!sourceCoverageNeedsBackfill(shipment)) {
    return coverage.explanation ? `Source trail: ${label}; ${coverage.explanation}` : `Source trail: ${label}.`;
  }
  return `Source gap: ${label}; missing ${missing.length ? missing.join(", ") : "earlier lifecycle"} proof before final POD.`;
}

function completedSourceBackfillAction(shipment = {}) {
  if (!sourceCoverageNeedsBackfill(shipment)) return null;
  const missing = sourceCoverageMissingStages(shipment);
  const coverage = sourceCoverageForShipment(shipment) || {};
  const nextAction = `Backfill Gmail/TMS source trail for ${shipment.awb}: ${missing.length ? `find ${missing.join(", ")} proof` : "find missing lifecycle proof"}.`;
  return baseAction(
    shipment,
    "source-backfill",
    "Backfill shipment source trail",
    { name: "Ops Brain", email: "" },
    [
      `${shipment.awb} is delivered, but the control room does not have the full lifecycle source trail.`,
      `Coverage: ${sourceCoverageLabel(coverage.completeness)}.`,
      missing.length ? `Missing stages: ${missing.join(", ")}.` : "",
      "Search exact AWB, undashed AWB, and suffix-only AWB in Gmail/TMS history. Attach arrival, release/DO, fee/payment, dispatch/award, pickup, delivery, and POD evidence by stage.",
      "Do not send an outbound email from this action; use it to repair the shipment truth source.",
    ].filter(Boolean).join("\n"),
    {
      channel: "platform",
      execution: "operator-approved-internal",
      subject: "",
      priority: coverage.completeness === "final-proof-only" ? "medium" : "normal",
      targetRole: "source-truth",
      reason: coverage.backfillReason || `Completed shipment source trail is ${sourceCoverageLabel(coverage.completeness)}.`,
      problem: sourceCoverageLine(shipment),
      nextAction,
      autonomy: autonomyForInternalAction(CANONICAL_GMAIL_INGESTION_PIPELINE, "Record source proof debt"),
      safety: safetyForInternalAction(
        CANONICAL_GMAIL_INGESTION_PIPELINE,
        "Operator-approved internal source repair. The dashboard records Gmail/TMS proof debt for canonical direct ingestion; no outbound email or CourierCloud mutation is performed.",
      ),
      betaContract: operatorApprovedInternalContract(CANONICAL_GMAIL_INGESTION_PIPELINE),
    },
  );
}

function actionRecommendation(shipment, actions) {
  const gates = gateState(shipment);
  const text = statusText(shipment);
  const cargoNotFoundProblem = cargoNotFoundEvidenceText(shipment);
  const pickupProblem = pickupProblemReason(shipment);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  const conflicts = shipmentConflicts(shipment);
  if (conflicts.length) return "Resolve shipment memory conflict before acting.";
  if (gates.completed) {
    return sourceCoverageNeedsBackfill(shipment)
      ? "No external shipment action; backfill missing source trail before treating this as full-cycle memory."
      : "No action; delivered/POD is in memory.";
  }
  if (terminalRecovery) return terminalRecovery.nextAction;
  if (gates.deliveryReported) return "Delivery was reported; collect the signed POD.";
  if (gates.deliveryProblem) return "Call broker/driver now; delivery/offload is blocked.";
  if (gates.loadingProblem) return "Call station/broker now; driver is stuck during pickup/loading.";
  if (cargoNotFoundProblem && !gates.pickedUp) return "Call the station and pickup broker now; the cargo is not physically located.";
  if (gates.customsHold) return "Monitor customs hold; confirm arrival/on-hand if needed, and do not dispatch pickup until release/DO is visible.";
  if (gates.arrivalIncomplete) return stationCallInstruction(shipment);
  if (!gates.arrived && /\b(?:in transit|departed|expected|eta)\b/i.test(text)) return "Wait for arrival notice; prep quotes if ETA is within two days.";
  if (pickupProblem && !(gates.customsBrokerRelease && staleReleaseBlockerInstruction(pickupProblem))) {
    return `Ping Alex; ${pickupProblem}. Recommend calling the station and checking broker/release visibility before sending another draft.`;
  }
  if (gates.arrived && !gates.customsBrokerRelease) return "Ask customs broker for release/DO; do not dispatch pickup yet.";
  if (gates.arrived && gates.customsBrokerRelease && !gates.groundPaid && groundFeeLine(shipment)) {
    const broker = knownPickupBroker(shipment, actions);
    return `Verify/pay ground fees${broker ? `, then confirm pickup/recovery with ${broker}` : ", then release files to the pickup broker"}.`;
  }
  if (gates.arrived && gates.customsBrokerRelease && !gates.groundPaid && !gates.dispatchDone && !knownPickupBroker(shipment, actions) && !pickupBrokerContact(shipment, actions).name && /fee|payment|cargosprint|station/i.test(text)) {
    return "Pay/confirm ground handling fees, then release files to pickup broker.";
  }
  if (gates.deliveryScheduledToday) return "Let delivery run; collect POD after delivery confirmation.";
  if (gates.driverOnsite) return "Monitor loading; capture detention time and pickup proof.";
  if (gates.pickedUp) return "Track final delivery and collect POD.";
  const quote = quoteLine(shipment, actions);
  if (/^Pickup broker:/i.test(quote)) return `Send release/notice to ${knownPickupBroker(shipment, actions)}, then confirm pickup/POD.`;
  if (/none yet|waiting for pickup prices/i.test(quote)) return "Get pickup quote or confirm awarded broker before dispatch.";
  return "Approve pickup execution only after arrival, release, and station fees are clear.";
}

function canonicalShipmentPhase(shipment = {}) {
  return String(shipment.canonicalState?.phase || shipment.opsState?.phase || shipment.phase || "").toLowerCase();
}

function quietCustomsHoldException(item = {}) {
  const text = `${item.type || ""} ${item.label || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  return /\b(?:customs[-\s]?hold|government[-\s]?hold|exam[-\s]?hold|u\.?s\.? customs hold)\b/i.test(text) &&
    !/\b(?:driver|pickup|delivery|storage|detention|not locate|cannot locate|can't locate|cant locate|not found|flight deleted|deleted in uc360|not in (?:the )?ua area|connection transfer|transfer)\b/i.test(text);
}

function genericPickupDocsException(item = {}) {
  const text = `${item.type || ""} ${item.label || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
  return /\b(?:pickup-docs-needed|remaining pickup docs?|remaining necessary docs?|pickup docs?.*delivery order|delivery order|d\/?o|awb copy only|airway bill copy)\b/i.test(text) &&
    !/\b(?:not locate|cannot locate|can't locate|cant locate|not found|flight deleted|deleted in uc360|not in (?:the )?ua area|connection transfer|transfer|driver|onsite|on[-\s]?site|storage|detention)\b/i.test(text);
}

function activeOperationalException(shipment = {}) {
  const rows = [
    ...(shipment.opsState?.exceptions || []),
    ...(shipment.canonicalState?.exceptions || []),
    ...(shipment.canonical?.exceptions || []),
    ...(shipment.exceptions || []),
  ];
  return rows
    .filter(Boolean)
    .filter((item) => !/^(?:closed|resolved|cleared|done)$/i.test(String(item.status || "").trim()))
    .filter((item) => {
      const text = `${item.type || ""} ${item.label || ""} ${item.summary || ""} ${item.evidence || ""} ${item.nextAction || ""}`;
      const severity = String(item.severity || "").toLowerCase();
      if (quietCustomsHoldException(item) || genericPickupDocsException(item)) return false;
      return ["needs-action", "needs-decision", "critical", "urgent"].includes(severity) ||
        /\b(?:connection transfer|transfer exception|flight deleted|deleted in uc360|not in (?:the )?ua area|not locate|cannot locate|can't locate|cant locate|not found|rejected|reject|not accepted)\b/i.test(text);
    })
    .sort((a, b) => {
      const score = (item) => {
        const text = `${item.type || ""} ${item.severity || ""} ${item.summary || ""} ${item.evidence || ""}`;
        let value = 0;
        if (/\b(?:critical|urgent|immediate)\b/i.test(text)) value += 40;
        if (/\b(?:needs-action|needs-decision)\b/i.test(text)) value += 30;
        if (item.nextAction) value += 20;
        if (/^(?:active|gmail-proof|email|gmail)$/i.test(String(item.type || ""))) value -= 20;
        if (/\b(?:connection-transfer-exception|awb-copy-requested|station-cargo-not-found|pickup-blocked|delivery-blocked|customs-hold)\b/i.test(String(item.type || ""))) value += 20;
        if (/\b(?:connection transfer|flight deleted|deleted in uc360|not in (?:the )?ua area|wfs|cdg|not locate|cannot locate|can't locate|cant locate|not found)\b/i.test(text)) value += 30;
        return value + factTime(item.at || item.updatedAt || item.createdAt) / 1e13;
      };
      return score(b) - score(a);
    })[0] || null;
}

function exceptionLabelForShipment(exception = {}) {
  const text = `${exception.type || ""} ${exception.summary || ""} ${exception.evidence || ""}`;
  if (/\b(?:connection transfer|flight deleted|deleted in uc360|not in (?:the )?ua area|wfs|cdg)\b/i.test(text)) return "Transfer exception";
  if (/\b(?:not locate|cannot locate|can't locate|cant locate|not found)\b/i.test(text)) return "Cargo not found";
  if (/\brejected|reject|not accepted\b/i.test(text)) return "Customs exception";
  return "Exception";
}

function pingPolicyForShipment(shipment, actions) {
  const state = shipmentExecutionState(shipment, actions);
  return {
    level: state.pingLevel,
    reason: state.pingReason || "review in Brain/Action tab",
    nextAction: state.nextAction,
  };
}

function hoursSinceArrival(shipment) {
  const text = statusText(shipment);
  const dateText =
    shipment.arrivedAt ||
    shipment.lastEmail?.at ||
    String(text).match(/\b(?:arrived|arrival notice|available).*?(\d{4}-\d{2}-\d{2}T[0-9:.Z-]+)/i)?.[1] ||
    "";
  const timestamp = Date.parse(dateText);
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, (Date.now() - timestamp) / 36e5);
}

function shipmentExecutionState(shipment, actions) {
  const gates = gateState(shipment);
  const canonicalPhase = canonicalShipmentPhase(shipment);
  const explicitFeeBlocked = ["fees-needed", "ground-fees-needed"].includes(canonicalPhase);
  const resolved = resolveShipmentState(shipment);
  const text = statusText(shipment);
  const storage = storageLine(shipment);
  const storageTimingInfo = storageTiming(shipment);
  const groundFees = groundFeeLine(shipment);
  const pickupProblem = pickupProblemReason(shipment);
  const cargoNotFoundProblem = cargoNotFoundEvidenceText(shipment);
  const quote = quoteLine(shipment, actions);
  const quoteDetails = pickupQuoteDetailsLine(shipment, actions);
  const pickupBroker = pickupBrokerContact(shipment, actions);
  const customsBroker = customsBrokerContact(shipment);
  const station = stationContact(shipment);
  const shipmentSpecificNextAction = String(shipment.nextAction || "").trim();
  const signals = chipsForShipment(shipment).slice(0, 4);
  const preArrivalPlanningText = [
    shipment.arrivalStatus,
    shipment.stage,
    shipment.currentState,
    shipment.nextAction,
    shipment.eta,
    text,
  ].filter(Boolean).join(" ");
  const etaHours = hoursUntilEta(shipment);
  const etaPassedWithoutArrival = Number.isFinite(etaHours) && etaHours <= 0 && !gates.arrived;
  const base = {
    phase: "open",
    label: "Open",
    urgency: 0,
    pingLevel: "quiet",
    pingReason: "",
    problem: "",
    nextAction: "Review shipment memory and confirm the next operational step.",
    signals,
    storage,
    groundFees,
    quote: quoteDetails || quote,
    contacts: { station, pickupBroker, customsBroker },
    actionRequired: false,
  };
  const conflicts = shipmentConflicts(shipment);
  base.conflicts = conflicts;
  const activeException = activeOperationalException(shipment);

  if (conflicts.length) {
    return {
      ...base,
      phase: "conflict",
      label: "Conflict",
      urgency: 95,
      pingLevel: "urgent",
      pingReason: "shipment memory has conflicting evidence",
      problem: conflicts[0].summary,
      nextAction: "Tell me which source is correct, or add an operator note with what actually happened.",
      signals: unique(["Conflict", ...signals]),
      actionRequired: true,
    };
  }

  if (activeException && canonicalPhase === "exception" && !gates.pickedUp && !gates.deliveryReported && !gates.completed) {
    const label = exceptionLabelForShipment(activeException);
    const summary = activeException.summary || activeException.evidence || "Open operational exception in shipment memory.";
    const nextAction = activeException.nextAction || "Resolve the exception before advancing the shipment.";
    return {
      ...base,
      phase: "exception",
      label,
      urgency: /needs-decision/i.test(String(activeException.severity || "")) ? 85 : 100,
      pingLevel: "urgent",
      pingReason: summary,
      problem: summary,
      nextAction: safeShipmentInstruction(nextAction, "Resolve the exception before advancing the shipment."),
      signals: unique([label, "Exception", ...signals]),
      actionRequired: true,
    };
  }

  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  if (terminalRecovery) {
    return {
      ...base,
      phase: "delivery-blocked",
      label: "Delivery blocked",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: terminalRecovery.problem,
      problem: terminalRecovery.problem,
      nextAction: safeShipmentInstruction(
        terminalRecovery.nextAction,
        "Confirm the delivery blocker and recovery path before advancing closeout.",
      ),
      signals: unique(["Delivery blocked", terminalRecovery.wrongConsignee ? "Wrong consignee" : "", ...signals].filter(Boolean)),
      actionRequired: true,
    };
  }

  if (gates.completed) {
    return {
      ...base,
      phase: "delivered",
      label: "Delivered",
      problem: podLine(shipment) || "Delivered/POD is in memory.",
      nextAction: "No action; delivered/POD is in memory.",
      signals: unique(["Delivered", ...signals]),
    };
  }

  if (gates.deliveryReported) {
    return {
      ...base,
      phase: "delivered-pod-pending",
      label: "Delivered, POD pending",
      urgency: 70,
      pingLevel: "quiet",
      problem: podLine(shipment) || "Delivery was reported, but signed POD is not in memory.",
      nextAction: "Collect the signed POD/proof of delivery.",
      signals: unique(["Delivered", "POD pending", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.deliveryProblem) {
    return {
      ...base,
      phase: "delivery-blocked",
      label: "Delivery blocked",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: "delivery/offload problem while driver is out",
      problem: "Driver is at or near delivery and there is an offload/receiver problem.",
      nextAction: "Call the broker/driver now, confirm the delivery blocker, and coordinate receiver instructions.",
      signals: unique(["Delivery blocked", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.deliveryOutForDelivery) {
    return {
      ...base,
      phase: "out-for-delivery",
      label: "Out for delivery",
      urgency: 45,
      pingLevel: "quiet",
      problem: "Shipment is out for delivery; delivery completion is not confirmed yet.",
      nextAction: "Track delivery completion and collect POD.",
      signals: unique(["Out for delivery", "Picked up", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.loadingProblem) {
    return {
      ...base,
      phase: "loading-blocked",
      label: "Loading blocked",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: "driver is at pickup and loading is blocked",
      problem: "Driver is at the station and loading is blocked or delayed.",
      nextAction: "Call the station/broker now, confirm the loading issue, and capture detention time.",
      signals: unique(["Loading blocked", "Driver onsite", ...signals]),
      actionRequired: true,
    };
  }

  const canonicalRisk = shipment.operationalRisk || shipment.opsState?.operationalRisk || shipment.canonical?.operationalRisk || null;
  const arrivalRiskCompatiblePhase = ["", "pre-arrival", "in-transit", "arrival-unverified"].includes(canonicalPhase);
  if (
    canonicalRisk &&
    String(canonicalRisk.level || "none").toLowerCase() !== "none" &&
    canonicalRisk.type === "arrival-unverified" &&
    arrivalRiskCompatiblePhase &&
    !activeException &&
    !canonicalArrivalStillPending(shipment) &&
    !canonicalReleaseBeforeArrival(shipment) &&
    !gates.arrived &&
    !gates.driverOnsite &&
    !gates.pickedUp &&
    !gates.deliveryReported
  ) {
    return {
      ...base,
      phase: "arrival-unverified",
      label: "Arrival unverified",
      urgency: canonicalRisk.level === "critical" ? 85 : canonicalRisk.level === "high" ? 70 : 50,
      pingLevel: canonicalRisk.level === "critical" || canonicalRisk.level === "high" ? "urgent" : "quiet",
      pingReason: canonicalRisk.reason || "ETA/recovery passed without station proof",
      problem: canonicalRisk.reason || "ETA/recovery passed, but station/on-hand proof is missing.",
      nextAction: safeShipmentInstruction(canonicalRisk.action, stationCallInstruction(shipment)),
      signals: unique(["ETA passed", "Arrival unverified", ...signals]),
      actionRequired: true,
    };
  }

  const canonicalPickupBlockerPhase = ["pickup-blocked", "loading-blocked", "station-cargo-not-found"].includes(
    String(shipment.canonicalState?.phase || shipment.opsState?.phase || shipment.phase || "").toLowerCase(),
  );
  const pickupBlockerResolved = shipmentStateFacts(shipment).some((row) => resolvedPickupBlockerInstruction(row.text));
  if ((cargoNotFoundProblem || canonicalPickupBlockerPhase) && !pickupBlockerResolved && !gates.pickedUp && !gates.deliveryReported) {
    const pieceMismatchBlocker = /\b(?:piece[-\s]?count|pieces?|pcs?|3[-\s]?v(?:s|ersus)[-\s]?4|3[-\s]?vs[-\s]?4|mismatch|discrepanc)\b/i.test(text);
    return {
      ...base,
      phase: "pickup-blocked",
      label: cargoNotFoundProblem ? "Cargo not found" : pieceMismatchBlocker ? "Piece-count mismatch" : "Pickup blocked",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: cargoNotFoundProblem
        ? "station/pickup side cannot locate the cargo"
        : pieceMismatchBlocker
        ? "station piece-count mismatch blocks pickup"
        : "pickup execution is blocked",
      problem: cargoNotFoundProblem
        ? "Station/pickup side cannot locate the cargo."
        : pieceMismatchBlocker
        ? "Pickup is blocked by a station piece-count mismatch."
        : "Pickup execution is blocked by current source truth.",
      nextAction: cargoNotFoundProblem
        ? "Call the station and pickup broker now; do not re-dispatch or keep the driver waiting until the freight is physically located."
        : pieceMismatchBlocker
        ? `Pickup is blocked by a piece-count mismatch. ${stationCallInstruction(shipment)} Then release pickup to the broker.`
        : "Call the station and pickup broker now; clear the pickup blocker before dispatch continues.",
      signals: unique([cargoNotFoundProblem ? "Cargo not found" : pieceMismatchBlocker ? "Piece mismatch" : "Pickup blocked", "Pickup blocker", ...signals]),
      actionRequired: true,
    };
  }

  if (!gates.pickedUp && (storageTimingInfo.active || storageTimingInfo.dueSoon)) {
    const storagePing = storagePingLevel(storageTimingInfo);
    const knownBroker = knownPickupBroker(shipment, actions);
    const shipmentNextActionIsStale =
      gates.arrived &&
      (/\b(?:monitor arrival|not arrived|arrival notice\/on[-\s]?hand proof missing|do not dispatch pickup yet)\b/i.test(shipmentSpecificNextAction) ||
        gates.customsBrokerRelease && staleReleaseBlockerInstruction(shipmentSpecificNextAction));
    const storageNextAction = (() => {
      if (gates.customsHold) return "Monitor customs hold/release with broker; do not dispatch pickup";
      if (!gates.arrived) return stationCallInstruction(shipment);
      if (!gates.customsBrokerRelease) return "Confirm release/DO before dispatch.";
      if (gates.arrivalIncomplete) return stationCallInstruction(shipment);
      if (!gates.groundPaid && groundFees) {
        return `Verify/pay ground fees${knownBroker ? `, then confirm pickup/recovery with ${knownBroker}` : ", then release files to the pickup broker"}.`;
      }
      if (gates.pickupScheduled) {
        const broker = knownBroker || pickupBroker.name || "pickup broker";
        return `Follow up with ${broker} at pickup time; collect loaded proof/POD after physical pickup.`;
      }
      if (knownBroker) return `Confirm pickup/recovery with ${knownBroker}; collect pickup proof/POD after physical pickup.`;
      if (pickupBroker.name || pickupBroker.email || pickupBroker.phone) {
        return `Confirm pickup/recovery with ${pickupBroker.name || pickupBroker.email || "pickup broker"}; collect pickup proof/POD after physical pickup.`;
      }
      if (/Pickup quotes:/i.test(quote) && !/none yet|waiting/i.test(quote)) return "Pick/approve the pickup broker, then send the release packet.";
      if (shipmentSpecificNextAction && !shipmentNextActionIsStale && /\b(?:storage|pickup|pick\s*up|recover|recovery|ground|handling|isc|fee|broker|dispatch)\b/i.test(shipmentSpecificNextAction)) {
        return shipmentSpecificNextAction;
      }
      return "Get pickup quote or confirm awarded broker before dispatch.";
    })();
    return {
      ...base,
      phase: "storage-risk",
      label: storageTimingInfo.active ? "Storage accruing" : "Storage due",
      urgency: storageTimingInfo.active ? 75 : 65,
      pingLevel: storagePing,
      pingReason: storagePing === "quiet" ? "" : storage.replace(/^Storage:\s*/i, "").replace(/\.$/, ""),
      problem: storage.replace(/\.$/, ""),
      nextAction: pickupProblem
        ? `${pickupProblem}; clear that before dispatch.`
        : safeShipmentInstruction(storageNextAction, stationCallInstruction(shipment)),
      signals: unique([storage.replace(/^Storage:\s*/i, "").replace(/\.$/, ""), ...signals]),
      actionRequired: true,
    };
  }

  if (!gates.arrived && gates.pickupScheduled && !gates.pickedUp && !gates.deliveryReported) {
    const broker = knownPickupBroker(shipment, actions) || pickupBroker.name || "pickup broker";
    const date = gates.pickupScheduledDate ? formatDate(gates.pickupScheduledDate) : "";
    return {
      ...base,
      phase: "pickup-scheduled",
      label: "Pickup scheduled",
      urgency: 25,
      problem: `${broker} is scheduled to try pickup${date ? ` ${date}` : ""}; arrival/pieces still need confirmation.`,
      nextAction: `Monitor arrival/pieces, then follow up with ${broker}${date ? ` ${date}` : " at pickup time"} and collect loaded proof/POD after pickup.`,
      signals: unique(["Pickup scheduled", "Arrival not fully confirmed", ...signals]),
      actionRequired: false,
    };
  }

  if (gates.customsHold && !gates.completed && !gates.pickedUp && !gates.deliveryReported) {
    return {
      ...base,
      phase: "customs-hold",
      label: "Customs hold",
      urgency: gates.arrived ? 30 : 35,
      pingLevel: "quiet",
      problem: gates.arrived
        ? "Shipment is under customs/government hold, not just waiting on broker release."
        : "Customs/government hold is active; arrival/on-hand proof is still not complete.",
      nextAction: gates.arrived
        ? "Monitor the customs broker thread; do not dispatch pickup until release/DO is visible."
        : "Monitor the customs broker thread and confirm arrival/on-hand; do not dispatch pickup until release/DO is visible.",
      signals: unique(["Customs hold", ...signals]),
      actionRequired: false,
    };
  }

  if (!gates.arrived && !gates.pickedUp && !gates.deliveryReported) {
    return {
      ...base,
      phase: "pre-arrival",
      label: "Pre-arrival",
      urgency: etaPassedWithoutArrival ? 45 : /\b(?:tomorrow|within 24|next day)\b/i.test(preArrivalPlanningText) ? 30 : 10,
      problem: "Shipment has not arrived in memory yet.",
      nextAction: etaPassedWithoutArrival
        ? "Ask the station to confirm on-hand status and share arrival notice."
        : "Prep pickup quotes only if ETA is within two days; otherwise monitor arrival.",
      signals: unique(["In transit", ...signals]),
      actionRequired: etaPassedWithoutArrival,
    };
  }

  if (pickupProblem) {
    return {
      ...base,
      phase: "pickup-blocked",
      label: "Pickup blocked",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: pickupProblem,
      problem: pickupProblem,
      nextAction: /piece[-\s]?count|pieces?|mismatch/i.test(pickupProblem)
        ? `Pickup is blocked by a piece-count mismatch. ${stationCallInstruction(shipment)} Then release pickup to the broker.`
        : `Pickup is blocked. ${stationCallInstruction(shipment)} Verify release/DO visibility, then tell the broker exactly what to fix.`,
      signals: unique([/piece[-\s]?count|pieces?|mismatch/i.test(pickupProblem) ? "Piece mismatch" : "Driver waiting", "Pickup blocker", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrivalIncomplete) {
    return {
      ...base,
      phase: "arrival-incomplete",
      label: "Not fully available",
      urgency: 50,
      pingLevel: hoursSinceArrival(shipment) >= 6 ? "urgent" : "quiet",
      pingReason: hoursSinceArrival(shipment) >= 6 ? "arrival/on-hand is incomplete or not offloaded" : "",
      problem: "Station/tracking does not prove all pieces are available for pickup yet.",
      nextAction: stationCallInstruction(shipment),
      signals: unique(["Availability not confirmed", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.driverOnsite && !pickupBlockerResolved && !gates.pickedUp) {
    const driverDelayProblem = /\b(?:detention|cannot|can'?t|refused|blocked|problem|not available|still onsite|waiting (?:more than|over|\d)|waiting for \d|hours?|driver waiting)\b/i.test(text);
    return {
      ...base,
      phase: "driver-onsite",
      label: "Driver onsite",
      urgency: driverDelayProblem ? 80 : 35,
      pingLevel: driverDelayProblem ? "urgent" : "quiet",
      pingReason: driverDelayProblem ? "driver onsite; pickup/loading not complete" : "",
      problem: "Driver is onsite or waiting; pickup/loading is not complete.",
      nextAction: "Monitor loading, capture detention time if it waits, then collect pickup proof.",
      signals: unique(["Driver onsite", ...signals]),
      actionRequired: driverDelayProblem,
    };
  }

  if (gates.pickedUp && resolved.deliveryScheduledToday && !gates.deliveryProblem) {
    return {
      ...base,
      phase: "out-for-delivery",
      label: "Out for delivery",
      urgency: 35,
      problem: "Shipment was picked up and is scheduled for delivery today.",
      nextAction: "Let delivery run; collect POD after delivery confirmation.",
      signals: unique(["Out for delivery", "Picked up", ...signals]),
      actionRequired: true,
    };
  }

	  if (gates.arrived && !gates.customsBrokerRelease) {
	    if (gates.customsHold) {
	      return {
        ...base,
        phase: "customs-hold",
        label: "Customs hold",
        urgency: 30,
        pingLevel: "quiet",
        problem: "Shipment is under customs/government hold, not just waiting on broker release.",
        nextAction: "Monitor the customs broker thread; do not dispatch pickup until release/DO is visible.",
        signals: unique(["Customs hold", ...signals]),
	        actionRequired: false,
	      };
	    }
	    const airportDwellActions = airportDwellActionsForShipment(shipment, actions);
	    if (airportDwellActions.length) {
	      const actionText = airportDwellActions
	        .map((action) => `${action.type || ""} ${action.label || ""} ${action.reason || ""} ${action.problem || ""} ${action.nextAction || ""}`)
	        .join(" ");
	      const docsPhase = /pickup[-\s]?location/i.test(actionText)
	        ? "pickup-location-requested"
	        : /\b(?:awb|air waybill|airway bill)\b/i.test(actionText) && !/delivery order|d\/?o|missing docs|remaining docs/i.test(actionText)
	        ? "awb-copy-needed"
	        : "pickup-docs-needed";
	      const firstAction = airportDwellActions[0] || {};
	      const problem = firstAction.problem || firstAction.reason || firstAction.label || "Pickup broker needs airport pickup documents.";
	      return {
	        ...base,
	        phase: docsPhase,
	        label: docsPhase === "pickup-location-requested" ? "Pickup location requested" : docsPhase === "awb-copy-needed" ? "AWB copy needed" : "Delivery order/docs needed",
	        urgency: 85,
	        pingLevel: "urgent",
	        pingReason: compact(problem, 100),
	        problem,
	        nextAction: firstAction.nextAction || firstAction.label || "Reply in the pickup thread with the missing airport pickup documents.",
	        signals: unique(["Pickup docs needed", ...signals]),
	        actionRequired: true,
	      };
	    }
	    const aged = hoursSinceArrival(shipment) >= 24;
	    return {
      ...base,
      phase: "release-needed",
      label: gates.brokerReleasePending ? "Broker release needed" : "Release needed",
      urgency: aged ? 70 : 45,
      pingLevel: aged ? "urgent" : "quiet",
      pingReason: aged ? "arrived 24h+ without release/DO" : "",
      problem: gates.brokerReleasePending
        ? "Shipment arrived; customs broker has not released/issued DO yet."
        : "Shipment arrived, but release/DO is not confirmed.",
      nextAction: gates.brokerReleasePending
        ? "Push the customs broker for release/DO or missing entry details; do not dispatch pickup yet."
        : "Ask the customs broker for release/DO; do not dispatch pickup yet.",
      signals: unique([gates.brokerReleasePending ? "Broker not released" : "No release", ...signals]),
      actionRequired: true,
    };
  }

  if (cargoNotFoundProblem && !gates.pickedUp && !gates.deliveryReported) {
    return {
      ...base,
      phase: "pickup-blocked",
      label: "Cargo not found",
      urgency: 100,
      pingLevel: "immediate",
      pingReason: "station/pickup side cannot locate the cargo",
      problem: "Station/pickup side cannot locate the cargo.",
      nextAction: "Call the station and pickup broker now; do not re-dispatch or keep the driver waiting until the freight is physically located.",
      signals: unique(["Cargo not found", "Pickup blocker", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && gates.pickupScheduled && !gates.pickedUp) {
    const broker = knownPickupBroker(shipment, actions) || pickupBroker.name || "pickup broker";
    const date = gates.pickupScheduledDate ? formatDate(gates.pickupScheduledDate) : "";
    return {
      ...base,
      phase: "pickup-scheduled",
      label: "Pickup scheduled",
      urgency: date && gates.pickupScheduledDate === operatorDateKey(new Date()) ? 40 : 25,
      problem: `${broker} is scheduled to pick up${date ? ` ${date}` : ""}.`,
      nextAction: `Do not treat pickup as complete; follow up with ${broker}${date ? ` ${date}` : " at pickup time"} and collect loaded proof/POD after pickup.`,
      signals: unique(["Pickup scheduled", "Released", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && !gates.groundPaid && (explicitFeeBlocked || groundFees) && !gates.dispatchDone && !gates.driverOnsite) {
    const feeProblem = groundFees || "Ground handling fees are due or not confirmed.";
    return {
      ...base,
      phase: "fees-needed",
      label: "Ground fees",
      urgency: 55,
      pingLevel: "quiet",
      problem: feeProblem.replace(/\.$/, ""),
      nextAction: "Pay or confirm ground handling fees, then release files to the pickup broker.",
      signals: unique([feeProblem.replace(/^Ground fees:\s*/i, "").replace(/\.$/, ""), ...signals]),
      actionRequired: true,
    };
  }

  if (stationConfirmationNeeded(shipment, gates)) {
    return {
      ...base,
      phase: "station-confirmation-needed",
      label: "Confirm station",
      urgency: 50,
      pingLevel: "quiet",
      problem: "Shipment is arrived/released, but the station has not confirmed freight is physically on hand.",
      nextAction: "Ask the station to confirm on-hand availability, piece count, and any ground handling/storage charges before dispatch.",
      signals: unique(["Station confirmation needed", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && !gates.groundPaid && (explicitFeeBlocked || groundFees) && !gates.dispatchDone && !gates.driverOnsite) {
    const feeProblem = groundFees || "Ground handling fees are due or not confirmed.";
    return {
      ...base,
      phase: "fees-needed",
      label: "Ground fees",
      urgency: 55,
      pingLevel: "quiet",
      problem: feeProblem.replace(/\.$/, ""),
      nextAction: "Pay or confirm ground handling fees, then release files to the pickup broker.",
      signals: unique([feeProblem.replace(/^Ground fees:\s*/i, "").replace(/\.$/, ""), ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && !pickupProblem && /Pickup quotes:/i.test(quote) && !/none yet|waiting/i.test(quote) && !publicPickupOwnerConfirmed(shipment) && !gates.pickedUp) {
    return {
      ...base,
      phase: "approval-needed",
      label: "Approval needed",
      urgency: 60,
      pingLevel: "urgent",
      pingReason: "ready with pickup prices; approval needed",
      problem: "Shipment is ready and pickup prices are in; broker award/dispatch needs approval.",
	      nextAction: "Pick the broker, approve the pickup award, then send the release packet.",
      signals: unique(["Quotes in", "Ready to dispatch", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && gates.dispatchDone && !gates.pickedUp) {
    const broker = knownPickupBroker(shipment, actions) || pickupBroker.name || "pickup broker";
    const ownerConfirmed = publicPickupOwnerConfirmed(shipment);
    return {
      ...base,
      phase: "dispatch-ready",
      label: "Dispatch ready",
      urgency: 40,
      problem: `Release is ready and ${broker} is the pickup path; physical pickup is not confirmed.`,
      nextAction: ownerConfirmed
        ? `Confirm pickup execution with ${broker}; collect loaded proof and POD after physical pickup.`
        : `Send/confirm the release packet with ${broker}, then get pickup time/status and collect pickup proof after physical pickup.`,
      signals: unique(["Dispatch ready", "Released", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && knownPickupBroker(shipment, actions) && !gates.pickedUp) {
    return {
      ...base,
      phase: "dispatch-ready",
      label: "Dispatch ready",
      urgency: 50,
      problem: `Release is ready; ${knownPickupBroker(shipment, actions)} should recover it.`,
      nextAction: `Send release/notice to ${knownPickupBroker(shipment, actions)}, then confirm pickup/POD.`,
      signals: unique(["Released", "Broker known", ...signals]),
      actionRequired: true,
    };
  }

  if (gates.arrived && gates.customsBrokerRelease && !gates.pickedUp) {
    const stationName = station.name || `${shipment.station || "station"} ${shipment.airline || ""}`.trim() || "station";
    return {
      ...base,
      phase: "dispatch-ready",
      label: "Dispatch ready",
      urgency: 45,
      problem: "Arrival and release are visible, but pickup execution is not confirmed.",
      nextAction: `Confirm ground fees and pickup handoff with ${stationName}; then send the release packet or assign the pickup broker.`,
      signals: unique(["Arrived", "Released", "Pickup not confirmed", ...signals]),
      actionRequired: true,
    };
  }

  const scheduledDeliveryDate = gates.deliveryScheduledDate || resolved.deliveryScheduledDate || "";
  if (gates.pickedUp && scheduledDeliveryDate && dateKeyIsTodayOrFuture(scheduledDeliveryDate) && !gates.podPending) {
    return {
      ...base,
      phase: "delivery-scheduled",
      label: "Delivery scheduled",
      urgency: 30,
      problem: `Shipment was picked up; delivery is scheduled ${formatDate(scheduledDeliveryDate)}.`,
      nextAction: "Track delivery, then collect POD after delivery confirmation.",
      signals: unique(["Picked up", `Delivery ${formatDate(scheduledDeliveryDate)}`, ...signals]),
      actionRequired: false,
    };
  }

  if (gates.pickedUp) {
    const podTarget = pickupBroker.name || knownPickupBroker(shipment, actions) || "pickup broker";
    return {
      ...base,
      phase: "pod-needed",
      label: "POD needed",
      urgency: 45,
      problem: "Shipment was picked up; delivery/POD is not complete in memory.",
      nextAction: `Request POD from ${podTarget}.`,
      signals: unique(["Picked up", "POD pending", ...signals]),
      actionRequired: true,
    };
  }

  if (
    !gates.arrived &&
    (
      Boolean(shipment.eta) ||
      /\b(?:in transit|departed|expected|eta|not[-\s]?arrived|not at destination|arrival pending|no arrival notice|await(?:ing)? \bnoa\b)\b/i.test(preArrivalPlanningText) ||
      hasNegativeArrivalEvidence(preArrivalPlanningText)
    )
  ) {
    return {
      ...base,
      phase: "pre-arrival",
      label: "Pre-arrival",
      urgency: etaPassedWithoutArrival ? 45 : /\b(?:tomorrow|within 24|next day)\b/i.test(text) ? 30 : 10,
      problem: "Shipment has not arrived in memory yet.",
      nextAction: etaPassedWithoutArrival
        ? "Ask the station to confirm on-hand status and share arrival notice."
        : "Prep pickup quotes only if ETA is within two days; otherwise monitor arrival.",
      signals: unique(["In transit", ...signals]),
      actionRequired: etaPassedWithoutArrival,
    };
  }

  return base;
}

function controlRoomActionPacket(action) {
  return {
    id: action.id,
    shipmentId: action.shipmentId || "",
    awb: action.awb || "",
    type: action.type,
    label: action.label,
    channel: action.channel,
    execution: action.execution || "",
    status: action.status || "",
    priority: action.priority || "",
    targetName: action.targetName || "",
    targetEmail: action.targetEmail || "",
    cc: action.cc || "",
    subject: action.subject || "",
    body: action.body || "",
    reason: action.reason || "",
    nextAction: action.nextAction || "",
    threadPolicy: action.threadPolicy || "",
    threadTopic: action.threadTopic || "",
    replyMessageId: action.replyMessageId || "",
    conversation: action.conversation || null,
    readiness: action.readiness || "",
    preflight: action.preflight || null,
    missing: Array.isArray(action.missing) ? action.missing : [],
    blockedReason: action.blockedReason || "",
    orderLink: action.orderLink || "",
    documentIntent: action.documentIntent || null,
    attachmentIntent: action.attachmentIntent || null,
    attachmentIntents: action.attachmentIntents || [],
    carrierName: action.carrierName || "",
    tmsIntent: action.tmsIntent || null,
    autonomy: action.autonomy || null,
    safety: action.safety || null,
    canonicalPlannerVersion: action.canonicalPlannerVersion || "",
    actionPlanId: action.actionPlanId || "",
    actionPlanRole: action.actionPlanRole || "",
    eligibility: action.eligibility || "",
    actionEligibility: action.actionEligibility || "",
    sourceFactIds: Array.isArray(action.sourceFactIds) ? action.sourceFactIds : [],
    idempotencyKey: action.idempotencyKey || "",
    postActionExpectedFact: action.postActionExpectedFact || "",
    relationshipsUsed: Array.isArray(action.relationshipsUsed) ? action.relationshipsUsed : [],
  };
}

function truthPacketGateMap(shipment = {}) {
  const byName = {};
  for (const [name, gate] of Object.entries(shipment.opsState?.gates || {})) {
    if (!name || !gate) continue;
    byName[String(name).toLowerCase()] = { ...(gate || {}) };
  }
  for (const gate of shipment.truthPacket?.gates || []) {
    const name = String(gate?.gate || gate?.name || "").toLowerCase();
    if (!name) continue;
    const packetRawStatus = String(gate.rawStatus || "").trim();
    const packetReason = String(gate.reason || "").trim();
    byName[name] = {
      ...(byName[name] || {}),
      ...(gate || {}),
      status: packetRawStatus && !/^(?:unknown|waiting|pending|missing)$/i.test(packetRawStatus)
        ? packetRawStatus
        : byName[name]?.status || gate.rawStatus || gate.status,
      truthStatus: gate.status || "",
      reason: packetReason && !/^(?:unknown|waiting|pending|missing)$/i.test(packetReason)
        ? packetReason
        : byName[name]?.reason || "",
    };
  }
  return byName;
}

function hasOperatorMovementOverride(shipment = {}) {
  const rows = [
    ...(shipment.operatorNotes || []),
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
  ];
  return rows.some((row) => {
    const identity = `${row?.source || ""} ${row?.confidence || ""} ${row?.type || ""} ${row?.label || ""}`;
    if (!/\boperator[-\s]?note|operator[-\s]?confirmed|phone\b/i.test(identity)) return false;
    const text = factRowText(row);
    return /\b(?:picked[-\s]?up|loaded|recovered|driver)\b/i.test(text) &&
      /\b(?:deliver(?:ing|y)? today|out for delivery|picked[-\s]?up|loaded|recovered)\b/i.test(text);
  });
}

function hasCanonicalPositiveArrivalEvent(shipment = {}) {
  const rows = [
    ...(shipment.opsState?.events || []),
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
  ];
  return rows.some((row) => {
    const identity = `${row?.type || ""} ${row?.label || ""} ${row?.source || ""}`;
    if (!/\b(?:arrival[-_\s]?notice[-_\s]?received|station[-_\s]?arrival[-_\s]?confirmed|arrival[-_\s]?confirmed)\b/i.test(identity)) return false;
    const text = factRowText(row);
    if (/\b(?:handler transfer|connection\/handler transfer|onward[-\s]?flight|ua\s*\d+|will be loaded|destination (?:arrival|delivery) is not proven|not consignee delivery|airline\/handler transfer)\b/i.test(text)) return false;
    return /\b(?:arrival\/on[-\s]?hand evidence was received|arrival evidence found|station confirmed|available for pickup|on[-\s]?hand)\b/i.test(text) &&
      !hasNegativeArrivalEvidence(text) &&
      !hasRequestedArrivalEvidence(text);
  });
}

function canonicalStationOnHandProof(shipment = {}, gates = {}) {
  const arrivalRaw = String(gates.arrival?.status || gates.arrival?.rawStatus || "").toLowerCase().trim();
  const arrivalExplicitlyMissing = ["not-arrived", "not arrived", "unknown", "waiting", "pending", "missing"].includes(arrivalRaw);
  const canonicalPositive = hasCanonicalPositiveArrivalEvent(shipment);
  if (canonicalArrivalHardMissing(shipment, gates)) return false;
  return arrivalExplicitlyMissing
    ? canonicalPositive
    : hasStationOnHandProof(shipment) || canonicalPositive;
}

function canonicalTruthPlanEligible(shipment = {}) {
  if (hasOperatorMovementOverride(shipment)) return false;
  const sourceRows = [
    ...(shipment.facts || []),
    ...(shipment.factLedger || []),
    ...(shipment.opsState?.events || []),
  ];
  if (sourceRows.some((row) => /\blegacy-fixture-packetizer\b/i.test(String(row?.source || "")))) return false;
  const source = String(shipment.opsState?.source || shipment._truthPacketSource || shipment._mergeSource || "").toLowerCase();
  const gates = truthPacketGateMap(shipment);
  const packetHasDecisiveGate = (shipment.truthPacket?.gates || []).some((gate) => {
    const raw = String(gate?.rawStatus || gate?.status || "").toLowerCase().trim();
    const reason = String(gate?.reason || "").toLowerCase().trim();
    return Boolean(
      raw && !["unknown", "waiting", "pending", "missing"].includes(raw) ||
        reason && reason !== "unknown"
    );
  });
  return Boolean(
    Object.keys(gates).length &&
      (
        packetHasDecisiveGate ||
        source.includes("canonical-shipment-pipeline") ||
        source.includes("shipment-truth-packets")
      )
  );
}

function truthPlanGateStatus(gates = {}, name = "") {
  const gate = gates[name] || {};
  const raw = String(gate.status || gate.rawStatus || "").toLowerCase().trim();
  const truth = String(gate.truthStatus || gate.truth || "").toLowerCase().trim();
  const detail = `${gate.evidence || ""} ${gate.summary || ""} ${gate.reason || ""} ${gate.label || ""}`;
  const releaseBlockedDetail = /\b(?:not|no|without|missing|pending|awaiting|blocked|hold|exam|not confirmed|not proven)\b[^.;\n]{0,90}\b(?:release|released|clearance|cleared|d\/?o|delivery order)\b|\b(?:release|released|clearance|cleared|d\/?o|delivery order)\b[^.;\n]{0,90}\b(?:not|no|without|missing|pending|awaiting|blocked|hold|exam|not confirmed|not proven)\b/i.test(detail);
  if (["true"].includes(truth) && !["waiting", "pending", "missing", "unknown", "not-arrived", "not arrived", "blocked"].includes(raw)) return "done";
  if (["done", "released", "cleared", "paid", "received", "found", "picked-up", "picked up", "loaded", "recovered", "delivered", "arrived", "available", "on-hand", "sent", "broker-awarded", "awarded", "dispatched"].includes(raw)) return "done";
  if (name === "customs" && !["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem"].includes(raw) && hasStrongCustomsReleaseText(detail) && !releaseBlockedDetail) return "done";
  if (["blocked", "hold", "customs-hold", "exam-hold", "exception", "problem", "incomplete", "partial"].includes(raw) || truth === "blocked") return "blocked";
  if (["due", "unpaid"].includes(raw)) return "due";
  if (["scheduled", "planned", "deferred", "quotes-in", "quote-in", "quotes-received", "quote-received"].includes(raw)) return "ready";
  return "waiting";
}

function cleanReasoningEvidenceText(value = "", maxLength = 130) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const stripped = text.replace(
    /^(?:(?:unknown[-\s]?offline|offline[-\s]?inferred|done|waiting|pending|unknown|blocked|ready|due|delivered|released|cleared)\s*:\s*)+/i,
    "",
  ).trim();
  const cleaned = stripped || text.replace(/^(?:done\s*:\s*){2,}/i, "").trim() || text;
  const detail = compact(cleaned, maxLength);
  const bareStatus = detail.toLowerCase().replace(/[:.\s…-]+/g, "");
  if (["done", "waiting", "pending", "unknown", "blocked", "ready", "due", "delivered", "released", "cleared", "unknownoffline", "offlineinferred"].includes(bareStatus)) {
    return "";
  }
  return detail;
}

function truthPlanGateDetail(gates = {}, name = "", fallback = "") {
  const gate = gates[name] || {};
  const descriptive = gate.evidence || gate.summary || gate.reason || gate.label || "";
  if (descriptive && !/^(?:unknown|waiting|pending|missing|blocked)$/i.test(String(descriptive).trim())) {
    const detail = cleanReasoningEvidenceText(descriptive, 100);
    if (detail) {
      return detail;
    }
  }
  const raw = String(gate.status || gate.rawStatus || "").toLowerCase().trim();
  if (name === "customs" && ["blocked", "hold", "customs-hold", "exam-hold"].includes(raw)) return "Customs/government hold";
  return compact(fallback || gate.status || "unknown", 100);
}

function canonicalArrivalHardMissing(shipment = {}, gates = null) {
  const map = gates || truthPacketGateMap(shipment);
  const gate = map.arrival || {};
  const raw = String(gate.status || gate.rawStatus || "").toLowerCase().replace(/_/g, "-").trim();
  const phase = String(shipment.opsState?.phase || shipment.truthPacket?.stateReason || shipment.phase || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .trim();
  const detail = `${gate.evidence || ""} ${gate.summary || ""} ${gate.reason || ""}`;
  const hardNegativeDetail = /\b(?:destination (?:arrival|delivery) is not proven|does not prove destination arrival|not consignee delivery|onward[-\s]?flight|handler transfer|connection\/handler transfer|will be loaded|not at destination)\b/i.test(detail);
  return hardNegativeDetail && (
    ["not-arrived", "not arrived", "unknown", "waiting", "pending", "missing"].includes(raw) ||
    ["pre-arrival", "in-transit"].includes(phase)
  );
}

function normalizedTruthPacketState(shipment = {}) {
  return String(shipment.truthPacket?.resolvedCurrentState || shipment.truthPacket?.currentState || "")
    .toLowerCase()
    .replace(/_/g, "-")
    .trim();
}

function truthPacketBlockerBlocks(blocker = {}) {
  const type = String(blocker.type || "").toLowerCase().replace(/_/g, "-");
  const status = String(blocker.status || "").toLowerCase();
  if (!type || type === "none" || type === "clear") return false;
  return !["clear", "cleared", "advisory", "info"].includes(status);
}

function phaseFromBlockingTruthPacket(shipment = {}, fallbackPhase = "") {
  const packetState = normalizedTruthPacketState(shipment);
  if (packetState !== "arrived-not-available") return "";
  const blocker = shipment.truthPacket?.operationalBlocker || {};
  if (!truthPacketBlockerBlocks(blocker)) return "";
  const fallback = String(fallbackPhase || "").toLowerCase().replace(/_/g, "-").trim();
  if (["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "delivery-blocked", "storage-risk"].includes(fallback)) {
    return fallback;
  }
  const type = String(blocker.type || "").toLowerCase().replace(/_/g, "-");
  if (type === "release-needed") return "release-needed";
  if (type === "customs-hold") return "customs-hold";
  if (type === "fees-due") return "fees-needed";
  if (type === "document-request") return "pickup-docs-needed";
  if (type === "pickup-blocked") return "pickup-blocked";
  if (type === "delivery-recovery") return "delivery-blocked";
  if (type === "dispatch-needed") return "not-ready";
  return "not-ready";
}

function labelForCanonicalTruthPhase(shipment = {}, phase = "") {
  const blocker = shipment.truthPacket?.operationalBlocker || {};
  const blockerLabel = compact(blocker.label || "", 80);
  if (phase === "not-ready" && blockerLabel) return blockerLabel;
  if (phase === "pre-arrival" || phase === "in-transit") return "Pre-arrival";
  if (phase === "release-needed") return "Release needed";
  if (phase === "customs-hold") return "Customs hold";
  if (phase === "fees-needed") return "Fees needed";
  if (phase === "pickup-docs-needed") return blockerLabel || "Pickup documents needed";
  if (phase === "awb-copy-needed") return blockerLabel || "AWB copy needed";
  if (phase === "pickup-location-requested") return blockerLabel || "Pickup location needed";
  if (phase === "pickup-blocked") return blockerLabel || "Pickup blocked";
  if (phase === "delivery-blocked") return blockerLabel || "Delivery blocked";
  if (phase === "arrival-incomplete") return "Arrival incomplete";
  return blockerLabel || phase.replace(/-/g, " ");
}

function blockerProblemText(blocker = {}) {
  const reason = compact(blocker.reason || "", 160);
  if (reason && !/^unknown$/i.test(reason)) return reason;
  return compact(blocker.label || "", 160);
}

function canonicalTruthPhase(shipment = {}, gates = {}) {
  const rawPhase = String(shipment.opsState?.phase || shipment.phase || "").toLowerCase().replace(/_/g, "-").trim();
  const packetState = normalizedTruthPacketState(shipment);
  const phase = rawPhase || packetState;
  const arrival = truthPlanGateStatus(gates, "arrival");
  const customs = truthPlanGateStatus(gates, "customs");
  const fees = truthPlanGateStatus(gates, "fees");
  const dispatch = truthPlanGateStatus(gates, "dispatch");
  const pickup = truthPlanGateStatus(gates, "pickup");
  const delivery = truthPlanGateStatus(gates, "delivery");
  const pod = truthPlanGateStatus(gates, "pod");
  const dispatchRaw = String(gates.dispatch?.status || gates.dispatch?.rawStatus || "").toLowerCase().trim();
  const storage = storageTiming(shipment);
  const stationOnHandProof = canonicalStationOnHandProof(shipment, gates);
  const text = statusText(shipment);
  const scheduledDeliveryText =
    /\b(?:out[-\s]?for[-\s]?delivery|delivery scheduled|scheduled for delivery|will deliver|deliver tomorrow|delivery today|eta(?:\s+to)?\s+(?:receiver|consignee|cnee|delivery|drop[-\s]?off))\b/i.test(text) &&
    !/\b(?:delivered|pod received|pod attached|signed pod|proof of delivery attached|proof of delivery received)\b/i.test(text);
  if (["done"].includes(pod) || ["delivered", "completed"].includes(phase)) return "delivered";
  const blockingPacketPhase = phaseFromBlockingTruthPacket(shipment, phase);
  if (blockingPacketPhase) return blockingPacketPhase;
  if (["conflict", "exception", "not-ready", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "delivery-blocked", "storage-risk", "arrival-unverified", "station-confirmation-needed"].includes(phase)) return phase;
  if (delivery === "done") return "delivered-pod-pending";
  if (["blocked"].includes(delivery) || ["delivery-blocked"].includes(phase)) return "delivery-blocked";
  if (/out-for-delivery/.test(phase) || String(gates.delivery?.status || "").toLowerCase() === "out-for-delivery") return "out-for-delivery";
  if (pickup === "done" && (delivery === "ready" || phase === "delivery-scheduled")) return "delivery-scheduled";
  if (pickup === "done" && scheduledDeliveryText) return "delivery-scheduled";
  if (pickup === "done") return "pod-needed";
  if (String(gates.pickup?.status || "").toLowerCase().includes("onsite") || phase === "driver-onsite") return "driver-onsite";
  if (storage.active || storage.dueSoon) return "storage-risk";
  if (customs === "blocked" || phase === "customs-hold") return "customs-hold";
  if (pickup === "blocked" || ["pickup-blocked", "loading-blocked", "station-cargo-not-found"].includes(phase)) return phase === "loading-blocked" ? "loading-blocked" : "pickup-blocked";
  if (arrival === "blocked" || ["arrival-incomplete", "arrived-not-available"].includes(phase)) return "arrival-incomplete";
  if (canonicalArrivalHardMissing(shipment, gates)) return "pre-arrival";
  if (arrival !== "done" && !stationOnHandProof) return "pre-arrival";
  if (customs !== "done") return "release-needed";
  if (fees === "due") return "fees-needed";
  if (pickup === "ready" || phase === "pickup-scheduled") return "pickup-scheduled";
  if (stationConfirmationNeeded(shipment, gateState(shipment))) return "station-confirmation-needed";
  if (/quotes?-in|quotes?-received/.test(dispatchRaw)) return "approval-needed";
  if (dispatch === "done" || ["ready-for-pickup", "dispatch-ready", "approval-needed"].includes(phase)) return "dispatch-ready";
  return phase || "open";
}

function canonicalTruthPlanProblem(shipment = {}, phase = "", label = "") {
  const exception = activeOperationalException(shipment);
  if (exception && ["conflict", "exception", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "delivery-blocked"].includes(phase)) {
    return exception.summary || exception.evidence || exception.nextAction || label || phase;
  }
  if (["dispatch-ready", "approval-needed", "pickup-scheduled", "pod-needed", "delivered"].includes(phase)) {
    return label || phase.replace(/-/g, " ");
  }
  return shipment.opsState?.summary || shipment.truthPacket?.stateReason || shipment.currentState || label || phase.replace(/-/g, " ");
}

function canonicalTruthPlan(shipment, actions = { actions: [], outboxRequests: [] }) {
  if (!canonicalTruthPlanEligible(shipment)) return null;
  const gates = truthPacketGateMap(shipment);
  const rawOpsPhase = String(shipment.opsState?.phase || shipment.phase || "").toLowerCase().replace(/_/g, "-").trim();
  const phase = canonicalTruthPhase(shipment, gates);
  const station = stationContact(shipment);
  const pickupBroker = pickupBrokerContact(shipment, actions);
  const customsBroker = customsBrokerContact(shipment);
  const phaseOverrodeOpsState = Boolean(phase && rawOpsPhase && phase !== rawOpsPhase);
  const packetBlockerLabel = truthPacketBlockerBlocks(shipment.truthPacket?.operationalBlocker)
    ? labelForCanonicalTruthPhase(shipment, phase)
    : "";
  const label = phaseOverrodeOpsState || (phase === "not-ready" && packetBlockerLabel)
    ? labelForCanonicalTruthPhase(shipment, phase)
    : shipment.opsState?.label || shipment.truthPacket?.stateReason || labelForCanonicalTruthPhase(shipment, phase);
  const dispatchBroker = gates.dispatch?.broker || knownPickupBroker(shipment, actions) || pickupBroker.name || "";
  const stationOnHandProof = canonicalStationOnHandProof(shipment, gates);
  const rawNextAction = shipment.truthPacket?.nextAction?.label || shipment.opsState?.nextAction || shipment.nextAction || "";
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  const staleMonitorArrivalAction = stationOnHandProof &&
    /\b(?:monitor arrival|do not dispatch pickup yet|prep pickup quotes only if eta|arrival\/on[-\s]?hand proof)\b/i.test(rawNextAction);
  const nextAction = terminalRecovery
    ? terminalRecovery.nextAction
    : phase === "dispatch-ready" && dispatchBroker
    ? `Confirm pickup execution with ${dispatchBroker}; collect loaded proof and POD after physical pickup.`
    : phase === "pod-needed"
    ? `Request POD from ${dispatchBroker || pickupBroker.name || "pickup broker"}.`
    : phase === "delivery-scheduled"
    ? "Track delivery, then collect POD after delivery confirmation."
    : phase === "arrival-incomplete"
    ? "Confirm station availability/piece count before dispatch."
    : staleMonitorArrivalAction
    ? "Review shipment memory and confirm the next operational step."
    : rawNextAction || "Review shipment memory and confirm the next operational step.";
  const problem = phaseOverrodeOpsState
    ? blockerProblemText(shipment.truthPacket?.operationalBlocker) || shipment.truthPacket?.stateReason || label
    : canonicalTruthPlanProblem(shipment, phase, label);
  const arrivalStatus = stationOnHandProof ? "done" : truthPlanGateStatus(gates, "arrival");
  const customsStatus = ["customs-hold", "release-needed"].includes(phase) ? "blocked" : truthPlanGateStatus(gates, "customs");
  const feeStatus = truthPlanGateStatus(gates, "fees");
  const dispatchStatus = ["arrival-incomplete", "customs-hold", "release-needed", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested", "pickup-blocked", "loading-blocked", "station-confirmation-needed"].includes(phase)
    ? "blocked"
    : truthPlanGateStatus(gates, "dispatch");
  const pickupStatus = truthPlanGateStatus(gates, "pickup");
  const deliveryStatus = truthPlanGateStatus(gates, "delivery");
  const podStatus = truthPlanGateStatus(gates, "pod");
  const actionShipment = phase && phase !== String(shipment.opsState?.phase || shipment.phase || "").toLowerCase()
    ? {
      ...shipment,
      opsState: {
        ...(shipment.opsState || {}),
        phase,
        label,
        summary: problem,
        nextAction,
      },
    }
    : shipment;
  const rawProposals = phase === "delivered" ? [] : proposedActionsForShipment(actionShipment, actions);
  const proposals = phase === "pre-arrival"
    ? rawProposals.filter((action) =>
      action.type === "quote-request" ||
      action.type === "operator-ping" &&
        /\b(?:awb|air waybill|transfer|flight|arrival|handoff|exception|ua area|uc360)\b/i.test(`${action.label || ""} ${action.reason || ""} ${action.problem || ""} ${action.nextAction || ""}`)
    )
    : rawProposals;
  const visibleActions = proposals.length
    ? proposals
    : ["pre-arrival", "delivered"].includes(phase)
    ? []
    : currentRecommendedActionsForOperator(shipment);
  const actionRequired = !["delivered", "pre-arrival"].includes(phase) || Boolean(shipment.truthPacket?.mustAskHuman);
  const urgency = phase === "delivery-blocked" || phase === "pickup-blocked" || phase === "loading-blocked"
    ? 100
    : phase === "driver-onsite"
    ? 65
    : actionRequired
    ? 45
    : 10;
  const groundFeesDetail = groundFeeLine(shipment).replace(/^Ground fees:\s*/i, "").replace(/\.$/, "");
  return {
    phase,
    label: compact(label || phase, 80),
    urgency,
    pingLevel: urgency >= 85 ? "urgent" : "quiet",
    pingReason: urgency >= 85 ? compact(problem, 100) : "",
    headline: problem,
	    blocker: phase === "pre-arrival"
	      ? "Arrival/on-hand proof is not current yet."
	      : phase === "release-needed"
	      ? "Release/DO is not confirmed."
	      : ["pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"].includes(phase)
	      ? problem
	      : phase === "fees-needed"
      ? truthPlanGateDetail(gates, "fees", "Ground fees need confirmation.")
      : phase.includes("blocked")
      ? problem
      : "",
    nextAction,
    storage: storageLine(shipment),
    quote: pickupQuoteDetailsLine(shipment, actions),
    conflicts: [],
    checks: [
      {
        key: "arrival",
        label: "Arrival",
        status: arrivalStatus,
        detail: truthPlanGateDetail(gates, "arrival", arrivalStatus === "done" ? "Arrived/on hand in source truth" : "Arrival notice/on-hand proof missing"),
      },
      {
        key: "customs",
        label: "Customs",
        status: customsStatus,
        detail: truthPlanGateDetail(
          gates,
          "customs",
          customsStatus === "done"
            ? "Release/DO confirmed"
            : phase === "release-needed"
            ? "Broker has not released/issued DO"
            : "Release/DO not confirmed",
        ),
      },
      {
        key: "groundFees",
        label: "Ground fees",
        status: feeStatus,
        detail: truthPlanGateDetail(gates, "fees", feeStatus === "done" ? groundFeesDetail || "Paid/confirmed" : groundFeesDetail || "Not confirmed"),
      },
      {
        key: "dispatch",
        label: "Dispatch",
        status: dispatchStatus,
        detail: truthPlanGateDetail(gates, "dispatch", dispatchStatus === "done" ? "Pickup path sent/awarded" : "Broker/quote path not settled"),
      },
    ],
    contacts: { station, pickupBroker, customsBroker },
    actionsReady: visibleActions.map(controlRoomActionPacket),
    truthGateStatuses: { arrivalStatus, customsStatus, feeStatus, dispatchStatus, pickupStatus, deliveryStatus, podStatus },
  };
}

function gateLabel(status) {
  if (status === "done") return "done";
  if (status === "blocked") return "blocked";
  if (status === "due") return "due";
  if (status === "ready") return "ready";
  return "waiting";
}

function controlRoomPlan(shipment, actions = { actions: [], outboxRequests: [] }) {
  const truthPlan = canonicalTruthPlan(shipment, actions);
  if (truthPlan) return truthPlan;
  const gates = gateState(shipment);
  const state = shipmentExecutionState(shipment, actions);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  const proposals = proposedActionsForShipment(shipment, actions);
  const visibleActions = proposals.length ? proposals : currentRecommendedActionsForOperator(shipment);
  const quoteDetails = pickupQuoteDetailsLine(shipment, actions);
  const storage = storageLine(shipment);
  const groundFees = groundFeeLine(shipment);
  const pickupBroker = pickupBrokerContact(shipment, actions);
  const customsBroker = customsBrokerContact(shipment);
  const station = stationContact(shipment);
  const deliveryReached = !terminalRecovery && (gates.completed || gates.deliveryReported);
  const pickupPathKnown =
    gates.dispatchDone ||
    state.phase === "pickup-scheduled" ||
    Boolean(knownPickupBroker(shipment, actions)) ||
    Boolean(pickupBroker.name) ||
    /^Pickup broker:/i.test(quoteDetails);
  const arrivalStatus = deliveryReached ? "done" : gates.arrivalIncomplete ? "blocked" : gates.arrived ? "done" : "waiting";
  const customsStatus = terminalRecovery
    ? gates.customsBrokerRelease
      ? "done"
      : "waiting"
    : deliveryReached && !gates.customsHold ? "done" : gates.customsHold ? "blocked" : gates.customsBrokerRelease ? "done" : gates.arrived ? "blocked" : "waiting";
  const genericStaleFeeMissing =
    pickupPathKnown &&
    !gates.groundPaid &&
    (
      !groundFees ||
      /\b(?:due|not confirmed)\b/i.test(groundFees) &&
        !/\$\s*\d/i.test(groundFees) &&
        !/\b(?:payment due|amount due|total due|due at station|please pay|unpaid|before freight release|need(?:s)? payment|station fee|ground fees? due at)\b/i.test(groundFees)
    );
  const feeStatus = terminalRecovery ? "waiting" : deliveryReached ? "done" : gates.groundPaid ? "done" : genericStaleFeeMissing ? "waiting" : gates.groundDue || groundFees ? "due" : "waiting";
  const feeDetail = feeStatus === "due"
    ? groundFees && !/\bpaid\/confirmed\b|\bpaid\b/i.test(groundFees)
      ? groundFees.replace(/^Ground fees:\s*/i, "").replace(/\.$/, "")
      : "Due/not confirmed"
    : deliveryReached && !groundFees
    ? "Passed delivery path"
    : gates.groundPaid
    ? groundFees && /\bpaid\/confirmed\b|\bpaid\b/i.test(groundFees)
      ? groundFees.replace(/^Ground fees:\s*/i, "").replace(/\.$/, "")
      : "paid/confirmed"
    : groundFees
    ? groundFees.replace(/^Ground fees:\s*/i, "").replace(/\.$/, "")
    : "Not confirmed";
  const dispatchStatus = terminalRecovery
    ? "blocked"
    : deliveryReached
    ? "done"
    : gates.pickedUp
    ? "done"
    : gates.arrivalIncomplete || gates.customsHold || gates.pickupBlocked || !gates.customsBrokerRelease
    ? "blocked"
    : gates.releasePackageReady || lowestPickupQuote(shipment) || knownPickupBroker(shipment, actions)
    ? "ready"
    : "waiting";
  const blocker =
    state.problem ||
    (arrivalStatus === "blocked" ? "Arrival/on-hand is incomplete." : "") ||
    (customsStatus === "blocked" ? (gates.customsHold ? "Customs/government hold." : "Release/DO is not confirmed.") : "") ||
    (feeStatus === "due" ? groundFees : "") ||
    (dispatchStatus === "waiting" ? "Pickup broker/quote path is not settled." : "");
  return {
    phase: state.phase,
    label: state.label,
    urgency: state.urgency,
    pingLevel: state.pingLevel,
    pingReason: state.pingReason,
    headline: state.problem || state.nextAction,
    blocker,
    nextAction: state.nextAction,
    storage,
    quote: quoteDetails,
    conflicts: state.conflicts || [],
    checks: [
      {
        key: "arrival",
        label: "Arrival",
        status: arrivalStatus,
        detail: deliveryReached ? "Delivery reported" : gates.arrivalIncomplete ? "Arrived but not fully available/offloaded" : gates.arrived ? "Arrived/on hand in memory" : "Arrival notice/on-hand proof missing",
      },
      {
        key: "customs",
        label: "Customs",
        status: customsStatus,
        detail: deliveryReached && !gates.customsBrokerRelease
          ? "Passed delivery path"
          : gates.customsBrokerRelease
          ? "Release/DO confirmed"
          : gates.customsHold
          ? "Customs/government hold"
          : gates.brokerReleasePending
          ? "Broker has not released/issued DO"
          : "Release/DO not confirmed",
      },
      {
        key: "groundFees",
        label: "Ground fees",
        status: feeStatus,
        detail: feeDetail,
      },
      {
        key: "dispatch",
        label: "Dispatch",
        status: dispatchStatus,
        detail: gates.completed
          ? "Delivered/POD complete"
          : gates.deliveryReported
          ? "Delivered; POD pending"
          : gates.pickedUp
          ? "Picked up; POD pending"
          : gates.arrivalIncomplete
          ? "Wait for all pieces/availability"
          : gates.pickupBlocked
          ? "Clear pickup blocker before dispatch"
          : knownPickupBroker(shipment, actions)
          ? `${knownPickupBroker(shipment, actions)} is the pickup path`
          : quoteDetails.replace(/^Pickup quotes:\s*/i, "") || "Broker/quote path not settled",
      },
    ],
    contacts: { station, pickupBroker, customsBroker },
    actionsReady: visibleActions.map(controlRoomActionPacket),
  };
}

function controlPlanLines(plan) {
  const checks = Array.isArray(plan.checks) ? plan.checks : [];
  const firstAction = plan.actionsReady?.[0] || null;
  const gateSummary = checks
    .map((check) => `${check.label} ${gateLabel(check.status)}`)
    .join(" · ");
  const customs = checks.find((check) => check.key === "customs");
  const groundFees = checks.find((check) => check.key === "groundFees");
  const dispatch = checks.find((check) => check.key === "dispatch");
  const customsDetail = customs?.detail && !/not confirmed/i.test(customs.detail)
    ? ` - ${compact(customs.detail, 64)}`
    : "";
  const groundDetail = groundFees?.detail && !/not confirmed/i.test(groundFees.detail)
    ? ` - ${compact(groundFees.detail, 64)}`
    : "";
  const dispatchDetail = dispatch?.detail && !/broker\/quote path not settled/i.test(dispatch.detail)
    ? ` - ${compact(dispatch.detail, 72)}`
    : "";
  return unique([
    plan.headline ? sentence(`State: ${compact(plan.headline, 120)}`) : "",
    gateSummary ? sentence(`Plan: ${gateSummary}`) : "",
    plan.storage ? plan.storage : "",
    customs ? sentence(`Customs: ${customs.status === "done" ? "released" : gateLabel(customs.status)}${customsDetail}`) : "",
    groundFees ? sentence(`Ground fees: ${gateLabel(groundFees.status)}${groundDetail}`) : "",
    plan.quote ? plan.quote : "",
    dispatch ? sentence(`Dispatch: ${gateLabel(dispatch.status)}${dispatchDetail}`) : "",
    plan.nextAction ? sentence(`Now: ${compact(plan.nextAction, 130)}`) : "",
    firstAction ? sentence(`${firstAction.channel === "platform" ? "Platform alert" : "Action ready"}: ${firstAction.label}`) : "",
    plan.pingLevel && plan.pingLevel !== "quiet" ? sentence(`Ping: ${compact(plan.pingReason, 100)}`) : "",
  ].filter(Boolean));
}

function shipmentBrief(shipment, actions) {
  const gates = gateState(shipment);
  const resolved = resolveShipmentState(shipment);
  const plan = controlRoomPlan(shipment, actions);
  if (plan.phase === "conflict") {
    return unique([
      plan.conflicts?.[0]?.summary ? `Conflict: ${compact(plan.conflicts[0].summary, 120)}.` : "Conflict in shipment memory.",
      plan.conflicts?.[0]?.left ? `Source A: ${compact(plan.conflicts[0].left, 90)}.` : "",
      plan.conflicts?.[0]?.right ? `Source B: ${compact(plan.conflicts[0].right, 90)}.` : "",
      `Now: ${plan.nextAction}`,
    ].filter(Boolean)).slice(0, 4).join("\n");
  }
  if (gates.completed) {
    const broker = knownPickupBroker(shipment, actions);
    return unique([
      podLine(shipment),
      sourceCoverageLine(shipment),
      broker ? `Broker: ${compact(broker, 48)}.` : "",
      `Now: ${actionRecommendation(shipment, actions)}.`,
    ].filter(Boolean)).join("\n");
  }
  const lines = [
    plan.phase === "out-for-delivery"
      ? "Picked up; scheduled for delivery today."
      : plan.phase === "delivered-pod-pending"
      ? "Delivered; POD is still pending."
      : plan.phase === "exception"
      ? compact(plan.headline || "Open operational exception.", 120)
      : gates.pickedUp
      ? "Picked up; delivery/POD is still open."
      : plan.phase === "customs-hold"
      ? gates.arrived
        ? "Arrived, but under customs/government hold."
        : "Customs/government hold active; arrival proof is still incomplete."
      : plan.phase === "release-needed"
      ? "Arrived; release/DO is not confirmed."
      : plan.phase === "fees-needed"
      ? "Arrived and released; ground fees need confirmation."
      : plan.phase === "arrival-incomplete"
      ? "Arrived, but station availability/pieces are not fully available."
      : plan.phase === "pickup-scheduled"
      ? `${knownPickupBroker(shipment, actions) || pickupBrokerContact(shipment, actions).name || "Pickup broker"} is ${gates.pickupScheduled ? "scheduled" : "assigned"} for pickup${gates.pickupScheduledDate ? ` ${formatDate(gates.pickupScheduledDate)}` : ""}.`
      : plan.phase === "dispatch-ready" || plan.phase === "approval-needed"
      ? "Arrived/released; pickup dispatch is next."
      : plan.phase === "pre-arrival"
      ? "Not arrived yet."
      : plan.phase === "arrival-unverified"
      ? etaPassedArrivalLine(shipment)
      : gates.releasePackageReady
      ? "Release package ready."
      : gates.arrived
      ? "Arrived."
      : "Not fully arrived.",
  ];
  if (/\b(?:pcs?|pieces?|weight|dims?|dimensions?|details|cargo)\b/i.test(actions.question || "")) lines.push(cargoLine(shipment));
  const arrivalEvidence = valuableFacts(shipment, "arrival").find(usefulArrivalEvidenceText);
  if (arrivalEvidence && !gates.completed && !gates.pickedUp) lines.push(compact(arrivalEvidence, 92));
  const pickupProblem = pickupProblemReason(shipment);
  if (pickupProblem) lines.push(sentence(`Pickup: ${pickupProblem}`));
  const pickupEvidence = resolved.latestPickupFact?.text || valuableFacts(shipment, "pod")
    .find((fact) =>
      /\b(?:picked up|driver (?:is )?(?:now )?loaded|loaded|deliver tomorrow|out for delivery|delivery tomorrow|detention)\b/i.test(fact)
    );
  if (pickupEvidence && gates.arrived && !pickupProblem && !gates.completed && !resolved.deliveryScheduledToday) {
    lines.push(compact(pickupEvidence.replace(/^(?:email|gmail|gmail-eod|pickup|dispatch|broker|pod|fact|ledger)\s+(?:gmail-eod\s+)?/i, ""), 100));
  }
  if (resolved.deliveryScheduledDate && !lines.some((line) => /scheduled for delivery|scheduled delivery|delivery today/i.test(line))) {
    lines.push(`Scheduled delivery ${formatDate(resolved.deliveryScheduledDate)}.`);
  }
  if (plan.storage) lines.push(plan.storage);
  const operatorNote = latestOperatorNoteLine(shipment);
  if (operatorNote) lines.push(operatorNote);
  if (plan.nextAction) lines.push(sentence(`Now: ${compact(plan.nextAction, 110)}`));
  const customs = plan.checks?.find((check) => check.key === "customs");
  if (customs) {
    const detail = customs.detail && !/not confirmed/i.test(customs.detail) ? ` - ${compact(customs.detail, 62)}` : "";
    lines.push(`Customs: ${customs.status === "done" ? "released" : gateLabel(customs.status)}${detail}.`);
  }
  const groundFees = plan.checks?.find((check) => check.key === "groundFees");
  if (groundFees && groundFees.status !== "waiting") {
    const detail = groundFees.detail && !/not confirmed/i.test(groundFees.detail) ? ` - ${compact(groundFees.detail, 58)}` : "";
    lines.push(`Ground fees: ${gateLabel(groundFees.status)}${detail}.`);
  }
  if (plan.quote && !/none yet/i.test(plan.quote)) lines.push(plan.quote);
  const proposals = proposedActionsForShipment(shipment, actions);
  const approvalAction = proposals.find((action) => action.channel !== "platform");
  if (approvalAction && !lines.some((line) => /Action ready:/i.test(line))) {
    lines.push(`Action ready: ${approvalAction.label}.`);
  }
  return unique(lines.filter(Boolean)).slice(0, 5).join("\n");
}

function usefulArrivalEvidenceText(fact) {
  const text = String(fact || "");
  if (!text.trim()) return false;
  if (/^(?:re|fw|fwd):\s/i.test(text)) return false;
  if (/\b(?:email[-\s]?not[-\s]?arrived|not[-\s]?arrived|has not arrived|not at destination|pending arrival|arrival pending|no arrival proof|arrival proof missing|departed|departure only|pre[-\s]?alert)\b/i.test(text)) return false;
  if (/\b(?:storage|last free|lfd|rate|g\.?o\.?|ground fees?)\b/i.test(text)) return false;
  return /\b(?:arrival notice|notice of arrival|inbound alert|arrived|arrival date|on[-\s]?hand|available|98\s*-\s*released)\b/i.test(text);
}

function customsReleaseLine(shipment) {
  const fact = valuableFacts(shipment, "release")[0] || shipment.customsBroker?.brokerStatus || shipment.clearanceStatus || "";
  const broker = shipment.customsBroker?.broker || shipment.contacts?.customs?.name || "";
  if (broker) return `Customs: released by ${compact(broker, 44)}.`;
  return fact ? `Customs: ${compact(fact, 88)}.` : "Customs: released.";
}

function contactAnswer(station, memory) {
  const stationUpper = String(station || "").toUpperCase();
  const contact = (memory.stationMemory?.contacts || []).find((item) => String(item.airport || "").toUpperCase() === stationUpper) || null;
  if (!contact) {
    return {
      title: `Station details ${stationUpper}`,
      subtitle: "Memory gap",
      answer: `I do not have confirmed station contact details for ${stationUpper} yet.`,
      facts: [],
      items: [],
      shipments: [],
      context: { station: stationUpper, topic: "station" },
    };
  }
  return {
    title: `Station details ${stationUpper}`,
    subtitle: [contact.airline, contact.handlerName].filter(Boolean).join(" · "),
    answer: unique([
      contact.handlerName,
      contact.stationEmail ? `Email: ${contact.stationEmail}` : "",
      contact.stationPhone ? `Phone: ${contact.stationPhone}` : "",
    ]).join("\n"),
    facts: [],
    items: [],
    shipments: [],
    context: { station: stationUpper, topic: "station" },
  };
}

function stationFromQuestion(question, shipments) {
  const text = String(question || "");
  const stations = unique([
    ...Object.values(STATION_ALIASES),
    ...shipments.map((shipment) => shipment.station).filter(Boolean),
  ]);
  const direct = stations.find((station) => new RegExp(`\\b${escapeRegExp(station)}\\b`, "i").test(text));
  if (direct) return String(direct).toUpperCase();
  const alias = Object.entries(STATION_ALIASES)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([name]) => new RegExp(`\\b${escapeRegExp(name).replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
  return alias ? alias[1] : "";
}

function listIntent(question) {
  const text = String(question || "").toLowerCase();
  if (/\b(?:completed|complete|closed|finished|done|delivered)\b.{0,40}\b(?:today|now|shipments?|loads?|awbs?)\b|\b(?:what'?s|whats|what|which)\b.{0,40}\b(?:completed|complete|closed|finished|done)\b/i.test(text)) return "completed";
  if (/\b(?:out for delivery|delivery (?:today|tomorrow)|scheduled (?:for )?delivery|delivering (?:today|tomorrow)|final delivery)\b/.test(text)) return "delivery";
  if (/\b(?:scheduled|schedule|ready|planned|assigned|confirmed).{0,40}\bpickups?\b|\bpickups?\b.{0,40}\b(?:scheduled|today|tomorrow|ready|planned|assigned|confirmed)\b|\bwho\b.{0,40}\bpick(?:up)?\b/.test(text)) return "pickup";
  if (/\b(?:arrive|arrives|arrived|arriving|arrival|arrivals|coming in|notice of arrival|\bnoa\b|on hand|on-hand|available)\b/.test(text)) return "arrival";
  if (/\b(?:release|d\/?o|delivery order|customs|clearance|cleared)\b/.test(text)) return "release";
  if (/\b(?:storage|last free|lfd)\b/.test(text)) return "storage";
  if (/\b(?:at risk|risk|risks|risky|operational risk|operationally at risk)\b/.test(text)) return "risk";
  if (/\b(?:quote|quotes|price|prices|rate|rates|cost|lowest|award|broker options)\b/.test(text)) return "quotes";
  if (/\b(?:pods?|proof of delivery)\b/.test(text)) return "pod";
  return "urgent";
}

function countIntent(question) {
  const text = String(question || "").toLowerCase();
  if (!/\b(?:how many|count|number of)\b/i.test(text)) return "";
  if (/\b(?:waiting|needs?|need|pending|missing|blocked)\b/.test(text) && /\b(?:release|d\/?o|delivery order|customs|clearance)\b/.test(text)) return "release";
  if (/\b(?:released|cleared|customs)\b/.test(text)) return "released";
  if (/\b(?:arrived|arrival|arrivals|on[-\s]?hand|available)\b/.test(text)) return "arrival";
  if (/\b(?:storage|last free|lfd)\b/.test(text)) return "storage";
  if (/\b(?:pickup|pickups|recover|recovery|driver|truck)\b/.test(text)) return "pickup";
  if (/\b(?:out for delivery|delivery|delivering|delivered|pod|proof of delivery)\b/.test(text)) return "delivery";
  if (/\b(?:risk|urgent|attention|action|problem|issue)\b/.test(text)) return "urgent";
  if (/\b(?:open|active|shipments?|loads?|awbs?)\b/.test(text)) return "open";
  return "";
}

function questionAsksForPriorList(question) {
  const text = String(question || "").toLowerCase();
  if (!text || normalizeAwb(text)) return false;
  return Boolean(
    /\b(?:give|show|send|list|pull)\b.{0,50}\b(?:list|them|those|their|dates?|arrival dates?|etas?|details)\b/i.test(text) ||
      /\b(?:their|those|them)\b.{0,40}\b(?:dates?|arrival dates?|etas?|details|status|statuses)\b/i.test(text) ||
      /\b(?:same list|that list|the list|arrival dates?|dates of arrival)\b/i.test(text),
  );
}

function listCopy(mode, station, count) {
  const where = station ? `${station} ` : "";
  const copies = {
    delivery: {
      title: `${where}Out for delivery`,
      empty: `No ${where.toLowerCase()}shipments are out for delivery in current truth.`,
      answer: `${count} shipment${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} delivery/POD tracking.`,
    },
    pickup: {
      title: `${where}Pickup schedule`,
      empty: `No ${where.toLowerCase()}recovery is ready or booked in current truth.`,
      answer: `${count} shipment${count === 1 ? " is" : "s are"} in the recovery lane.`,
    },
    arrival: {
      title: `${where}Arrivals`,
      empty: `No ${where.toLowerCase()}arrivals match in current truth.`,
      answer: `${count} shipment${count === 1 ? " is" : "s are"} in the arrival lane.`,
    },
    release: {
      title: `${where}Release / DO`,
      empty: `No ${where.toLowerCase()}shipments are waiting on release/D/O in current truth.`,
      answer: `${count} shipment${count === 1 ? " is" : "s are"} waiting on release/D/O.`,
    },
    storage: {
      title: `${where}Storage risk`,
      empty: `No ${where.toLowerCase()}storage risk is in current truth.`,
      answer: `${count} shipment${count === 1 ? " has" : "s have"} storage context.`,
    },
    risk: {
      title: `${where}Operational risk`,
      empty: `No ${where.toLowerCase()}shipment can worsen without operator action.`,
      answer: `${count} shipment${count === 1 ? " can" : "s can"} worsen without action.`,
    },
    quotes: {
      title: `${where}Pickup quotes`,
      empty: `No ${where.toLowerCase()}shipments are waiting on recovery quotes in current truth.`,
      answer: `${count} shipment${count === 1 ? " needs" : "s need"} quote/award attention.`,
    },
    pod: {
      title: `${where}POD follow-up`,
      empty: `No ${where.toLowerCase()}POD follow-up is open in current truth.`,
      answer: `${count} shipment${count === 1 ? " needs" : "s need"} POD follow-up.`,
    },
    completed: {
      title: `${where}Completed today`,
      empty: `No ${where.toLowerCase()}deliveries are complete today in current truth.`,
      answer: `${count} shipment${count === 1 ? " is" : "s are"} complete today.`,
    },
    "station-open": {
      title: station ? `${station} shipments` : "Shipments",
      empty: `No ${where.toLowerCase()}shipments match in current truth.`,
      answer: `${count} shipment${count === 1 ? "" : "s"} matched.`,
    },
    urgent: {
      title: station ? `${station} work` : "What needs action",
      empty: "No urgent shipment exceptions are in current truth.",
      answer: `${count} shipment${count === 1 ? " needs" : "s need"} action.`,
    },
  };
  return copies[mode] || copies.urgent;
}

function companionListLead(mode, sorted, station = "") {
  const first = sorted[0];
  if (!first) return "";
  const firstAwb = first.shipment.awb || "the first shipment";
  const action = compact(itemActionLine(first.shipment, first.state, mode), 96);
  const prefix = station ? `For ${station}, ` : "";
  const hidden = sorted.length > 1 ? `; ${sorted.length - 1} more follow` : "";
  if (mode === "delivery") return `${prefix}${firstAwb}: ${action}${hidden}.`;
  if (mode === "pickup") return `${prefix}${firstAwb}: ${action}${hidden}.`;
  if (mode === "arrival") return `${prefix}${firstAwb}: ${action}${hidden}.`;
  if (mode === "release") return `${prefix}${firstAwb} is still blocked on release/DO. ${action}${hidden}`;
  if (mode === "storage") return `${prefix}${firstAwb} has storage exposure. ${action}${hidden}`;
  if (mode === "risk") return `${prefix}${firstAwb} is the highest operational risk. ${action}${hidden}`;
  if (mode === "quotes") return `${prefix}${firstAwb} needs pickup pricing/award attention. ${action}${hidden}`;
  if (mode === "pod") return `${prefix}${firstAwb} needs closeout proof. ${action}${hidden}`;
  if (mode === "completed") return `${prefix}${firstAwb} is complete. ${action}${hidden}`;
  if (mode === "station-open") return `${prefix}${firstAwb}: ${action}${hidden}.`;
  return `${prefix}${firstAwb}: ${action}${hidden}.`;
}

function listDateLabel(shipment, mode) {
  const gates = gateState(shipment);
  const resolved = resolveShipmentState(shipment);
  if (mode === "arrival") {
    const state = shipmentExecutionState(shipment, { actions: [], outboxRequests: [] });
    const date = arrivalPlanningDateKey(shipment);
    if (!date) return "";
    if (state.phase === "arrival-unverified") return `ETA passed ${formatDate(date)}`;
    return gates.arrived ? `Arrived ${formatDate(date)}` : `ETA ${formatDate(date)}`;
  }
  if (mode === "delivery") {
    const date = gates.deliveryScheduledDate || resolved.deliveryScheduledDate;
    return date ? `Delivery ${formatDate(date)}` : "";
  }
  if (mode === "pickup") {
    const date = pickupDateKey(shipment);
    return date ? `Pickup ${formatDate(date)}` : "";
  }
  if (mode === "risk") {
    const risk = shipmentOperationalRisk(shipment);
    return risk.type ? compact(risk.type.replace(/-/g, " "), 28) : "";
  }
  if (mode === "completed") {
    const date = completedDateKey(shipment);
    return date ? `Delivered ${formatDate(date)}` : "";
  }
  const storage = storageTiming(shipment);
  if (mode === "storage" && storage?.label) return storage.label;
  return "";
}

function listQuestionLabel(question, mode, window = null) {
  window = window || questionDateWindow(question);
  if (mode === "arrival" && window?.label) return `arrivals for ${window.label}`;
  if (mode === "delivery" && window?.label) return `deliveries for ${window.label}`;
  if (mode === "pickup" && window?.label) return `pickups for ${window.label}`;
  if (mode === "station-open") return "shipments";
  if (mode === "release") return "shipments waiting on release/DO";
  if (mode === "risk") return "operational risk shipments";
  return `${mode} shipments`;
}

function singularListQuestionLabel(label) {
  return String(label || "")
    .replace(/^arrivals\b/i, "arrival")
    .replace(/^deliveries\b/i, "delivery")
    .replace(/^pickups\b/i, "pickup")
    .replace(/^open shipments\b/i, "open shipment")
    .replace(/^shipments\b/i, "shipment");
}

function usableContactName(name) {
  const value = String(name || "").trim();
  if (!value || /^(?:not found|unknown|none|n\/a|not awarded)$/i.test(value)) return "";
  return value;
}

function listAnswerLine(shipment, state, mode, memory = null) {
  const date = listDateLabel(shipment, mode);
  const station = shipment.station ? ` · ${shipment.station}` : "";
  const action = compact(itemActionLine(shipment, state, mode, memory), 92);
  return `${shipment.awb}${station}${date ? ` · ${date}` : ""}: ${action}`;
}

function companionListAnswerText(mode, sorted, station, question, window = null, memory = null) {
  const copy = listCopy(mode, station, sorted.length);
  if (!sorted.length) return copy.empty;
  const visibleLimit = mode === "station-open" ? Math.min(8, sorted.length) : Math.min(3, sorted.length);
  return sorted.slice(0, visibleLimit)
    .map(({ shipment, state }) => listAnswerLine(shipment, state, mode, memory))
    .join("\n");
}

function countLabel(kind) {
  return {
    release: "waiting on release/DO",
    released: "released",
    arrival: "arrived/on-hand",
    storage: "storage-risk",
    pickup: "pickup-lane",
    delivery: "delivery/POD",
    urgent: "attention-needed",
    open: "open",
  }[kind] || "matched";
}

function countCandidate(shipment, kind, question, memory) {
  const gates = gateState(shipment);
  if (kind !== "open" && kind !== "delivery" && gates.completed) return false;
  if (kind === "release") return releaseListCandidate(shipment);
  if (kind === "released") return Boolean(!gates.completed && gates.customsBrokerRelease);
  if (kind === "arrival") return Boolean(!gates.completed && gates.arrived);
  if (kind === "storage") return storageListCandidate(shipment, memory);
  if (kind === "pickup") return pickupListCandidate(shipment, question, memory.actions);
  if (kind === "delivery") return deliveryListCandidate(shipment, question) || completedListCandidate(shipment, question);
  if (kind === "urgent") return morningPriorityCandidate(shipment, memory.actions);
  return !gates.completed;
}

function answerCount(question, memory) {
  const kind = countIntent(question);
  if (!kind) return null;
  const allShipments = mergeShipments(memory, { attachPackets: false });
  const activeAwbs = currentActiveAwbSet(memory);
  const activeShipments = activeAwbs.size
    ? allShipments.filter((shipment) => activeAwbs.has(normalizeAwb(shipment.awb)))
    : allShipments;
  const station = stationFromQuestion(question, allShipments);
  const scoped = station ? activeShipments.filter((shipment) => String(shipment.station || "").toUpperCase() === station) : activeShipments;
  const matches = scoped.filter((shipment) => countCandidate(shipment, kind, question, memory));
  const label = countLabel(kind);
  const sample = matches.slice(0, 6).map((shipment) => displayAwb(shipment.awb)).filter(Boolean).join(", ");
  const answer = [
    `${matches.length} ${label} shipment${matches.length === 1 ? "" : "s"}${station ? ` at ${station}` : ""}.`,
    sample ? `AWBs: ${sample}${matches.length > 6 ? ` +${matches.length - 6} more` : ""}.` : "",
  ].filter(Boolean).join("\n");
  return {
    title: "Shipment count",
    subtitle: station || "Active PQ shipments",
    answer,
    facts: [],
    actions: [],
    items: [],
    allItems: [],
    hiddenCount: 0,
    shipments: [],
    context: { station, topic: `count-${kind}`, countKind: kind },
  };
}

function questionAsksForBoardReasoning(question) {
  const text = String(question || "").toLowerCase();
  if (!text || normalizeAwb(text)) return false;
  return Boolean(
    /\bwhy\b.{0,80}\b(?:so many|many|all|the)?\s*(?:exceptions?|attention|urgent|needs action|problems?|issues?|not ready|ready|stale|wrong|compromised|false|lying)\b/i.test(text) ||
      /\b(?:explain|audit|reason|diagnose|summarize|break down|breakdown)\b.{0,80}\b(?:board|control room|dashboard|active shipments?|exceptions?|attention|urgent|state|truth)\b/i.test(text) ||
      /\b(?:are we|why are we|how are we)\b.{0,80}\b(?:compromised|stale|wrong|missing|failing)\b/i.test(text)
  );
}

function sourceFactObservedAt(fact = {}) {
  const parsed = Date.parse(fact.observedAt || fact.capturedAt || fact.at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestSourceFactAt(sourceFacts = []) {
  const latest = Math.max(0, ...sourceFacts.map(sourceFactObservedAt));
  return latest ? new Date(latest).toISOString() : "";
}

function workgroupsForAwb(memory = {}, awb = "") {
  const key = normalizeAwb(awb);
  if (!key) return [];
  return (memory.operationalFactLedger?.workgroups || [])
    .filter((workgroup) => (workgroup.awbs || []).some((item) => normalizeAwb(item) === key));
}

function reasoningGateSummary(plan = {}) {
  return (plan.checks || []).map((check) => ({
    key: check.key || "",
    status: check.status || "",
    detail: cleanReasoningEvidenceText(check.detail || "", 100),
  })).filter((check) => check.key);
}

function relationshipCoverageForShipment(shipment = {}, memory = {}) {
  const customs = customsBrokerContact(shipment);
  const pickup = pickupBrokerContact(shipment, memory.actions || {});
  const groups = workgroupsForAwb(memory, shipment.awb);
  const sourceFacts = shipment.evidencePacket?.sourceFacts || [];
  const threads = unique([
    ...(shipment.evidencePacket?.threads || []).map((thread) => thread.threadId),
    ...sourceFacts.map((fact) => fact.sourceRef?.threadId),
    ...groups.map((group) => group.threadId),
  ].filter(Boolean)).slice(0, 8);
  const linkedAwbs = unique(groups
    .flatMap((group) => group.awbs || [])
    .map(displayAwb)
    .filter((item) => item && normalizeAwb(item) !== normalizeAwb(shipment.awb)))
    .slice(0, 8);
  return {
    station: shipment.station || "",
    customer: compact(shipment.client || shipment.consignee || shipment.delivery?.consignee || "", 60),
    consignee: compact(shipment.consignee || shipment.delivery?.consignee || shipment.client || "", 60),
    customsBroker: customs.name || customs.email || shipment.customsBroker?.broker || shipment.customsBroker?.contactEmail || "",
    pickupBroker: pickup.name || pickup.email || shipment.freightBroker?.broker || shipment.freightBroker?.contactEmail || "",
    linkedAwbs,
    workgroups: groups.map((group) => ({
      id: group.workgroupId || "",
      type: group.workgroupType || "",
      broker: group.brokerName || group.brokerEmail || "",
      threadId: group.threadId || "",
      awbs: (group.awbs || []).map(displayAwb).filter(Boolean).slice(0, 8),
    })).slice(0, 6),
    threads,
  };
}

function sourceCoverageForReasoning(shipment = {}) {
  const sourceFacts = shipment.evidencePacket?.sourceFacts || [];
  const sourceSystems = unique(sourceFacts.map((fact) => fact.sourceSystem).filter(Boolean));
  const gmailFacts = sourceFacts.filter((fact) => fact.sourceSystem === "gmail" || fact.sourceSystem === "gmail_attachment");
  const staleSources = unique([
    ...(shipment.evidencePacket?.freshness?.staleSources || []),
    ...(shipment.truthPacket?.freshness?.staleSources || []),
  ]).slice(0, 5);
  return {
    sourceFactCount: sourceFacts.length,
    gmailFactCount: gmailFacts.length,
    hasGmailEvidence: Boolean(shipment.evidencePacket?.freshness?.hasGmailEvidence || shipment.truthPacket?.freshness?.hasGmailEvidence || gmailFacts.length),
    latestSourceAt: latestSourceFactAt(sourceFacts),
    staleSources,
    gmailCoverageStatus: shipment.gmailCoverage?.status || shipment.evidencePacket?.freshness?.gmailCoverageStatus || shipment.truthPacket?.freshness?.gmailCoverageStatus || "",
    gmailCoverageProblem: Boolean(shipment.gmailCoverage?.problem || shipment.evidencePacket?.freshness?.gmailCoverageProblem || shipment.truthPacket?.freshness?.gmailCoverageProblem || staleSources.includes("gmail")),
    gmailCoverageReason: shipment.gmailCoverage?.reason || shipment.evidencePacket?.freshness?.gmailCoverageReason || shipment.truthPacket?.freshness?.gmailCoverageReason || "",
    gmailLatestReadMessageAt: shipment.gmailCoverage?.latestReadMessageAt || shipment.evidencePacket?.freshness?.gmailLatestReadMessageAt || shipment.truthPacket?.freshness?.gmailLatestReadMessageAt || "",
    gmailLatestProofMessageAt: shipment.gmailCoverage?.latestProofMessageAt || shipment.evidencePacket?.freshness?.gmailLatestProofMessageAt || shipment.truthPacket?.freshness?.gmailLatestProofMessageAt || "",
    manualTruthSyncedAt: shipment.evidencePacket?.freshness?.manualTruthSyncedAt || shipment.truthPacket?.freshness?.manualTruthSyncedAt || "",
    manualReviewSyncedAt: shipment.evidencePacket?.freshness?.manualReviewSyncedAt || shipment.truthPacket?.freshness?.manualReviewSyncedAt || "",
    systems: sourceSystems.slice(0, 5),
  };
}

function operationalClassForPhase(phase = "") {
  if (phase === "source-gap") return "source-gap";
  if (["delivered", "completed"].includes(phase)) return "closed";
  if (["delivery-blocked", "pickup-blocked", "loading-blocked", "arrival-incomplete", "storage-risk", "exception"].includes(phase)) return "true-exception";
  if (["customs-hold", "pickup-docs-needed", "awb-copy-needed", "pickup-location-requested"].includes(phase)) return "blocked-work";
  if (["ready-for-pickup", "dispatch-ready", "approval-needed", "pickup-scheduled"].includes(phase)) return "ready-execution";
  if (["pod-needed", "delivered-pod-pending", "out-for-delivery", "delivery-scheduled"].includes(phase)) return "post-pickup";
  if (["release-needed", "fees-needed", "station-confirmation-needed"].includes(phase)) return "not-ready";
  if (["pre-arrival", "in-transit", "arrival-unverified"].includes(phase)) return "arrival-watch";
  return "open";
}

function phaseDependsOnEmailTruth(phase = "") {
  return [
    "approval-needed",
    "broker-awarded",
    "broker-alerted",
    "customs-hold",
    "delivery-blocked",
    "delivered-pod-pending",
    "dispatch-ready",
    "fees-needed",
    "pickup-blocked",
    "pickup-docs-needed",
    "pickup-location-requested",
    "pickup-scheduled",
    "pod-needed",
    "ready-for-pickup",
    "release-needed",
  ].includes(String(phase || "").toLowerCase());
}

function sourceGapForReasoning(shipment = {}, phase = "", coverage = {}) {
  const role = String(shipment.truthPacketRole || "active").toLowerCase();
  const normalizedPhase = String(phase || "").toLowerCase();
  if (role === "completed" || ["delivered", "completed"].includes(normalizedPhase)) return null;
  if (role === "active" && normalizedPhase !== "source-gap") {
    const hasCurrentGmailCoverage = Boolean(
      coverage.gmailCoverageStatus ||
        coverage.manualTruthSyncedAt ||
        coverage.manualReviewSyncedAt
    );
    if (!hasCurrentGmailCoverage) {
      return {
        reason: "No per-AWB newest-Gmail coverage audit is attached to this active truth packet.",
        nextAction: "Refresh Gmail truth for this AWB before trusting release, broker, pickup, delivery, or POD state.",
      };
    }
  }
  if (!phaseDependsOnEmailTruth(phase)) return null;
  if (coverage.gmailCoverageProblem || coverage.staleSources?.includes?.("gmail")) {
    return {
      reason: coverage.gmailCoverageReason || "Gmail evidence is stale/incomplete for this AWB.",
      nextAction: "Refresh Gmail truth for this AWB before trusting release, broker, pickup, delivery, or POD state.",
    };
  }
  if (!coverage.hasGmailEvidence) {
    return {
      reason: "No durable Gmail source fact is attached to this shipment truth packet.",
      nextAction: "Ingest/read the full Gmail thread for this AWB before showing a confident operational state.",
    };
  }
  return null;
}

function missingRelationshipReasons(shipment = {}, plan = {}, relationships = {}, coverage = {}) {
  const phase = String(plan.phase || "").toLowerCase();
  const reasons = [];
  const hasCustomsBroker = Boolean(relationships.customsBroker);
  const hasPickupBroker = Boolean(relationships.pickupBroker);
  if (["release-needed", "customs-hold"].includes(phase) && !hasCustomsBroker) {
    reasons.push("customs broker relation missing");
  }
  if (["ready-for-pickup", "dispatch-ready", "approval-needed", "pickup-scheduled"].includes(phase) && !hasPickupBroker) {
    reasons.push("pickup broker relation missing");
  }
  if (["pod-needed", "delivered-pod-pending", "out-for-delivery"].includes(phase) && !hasPickupBroker) {
    reasons.push("POD owner / pickup broker relation missing");
  }
  if (!coverage.hasGmailEvidence) reasons.push("no durable Gmail source fact attached");
  if (coverage.gmailCoverageProblem) reasons.push(`gmail coverage: ${compact(coverage.gmailCoverageReason || coverage.gmailCoverageStatus || "stale/incomplete", 70)}`);
  if ((shipment.truthPacket?.unknowns || []).length) {
    reasons.push(...(shipment.truthPacket.unknowns || []).map((item) => `${item.gate}: ${compact(item.reason, 70)}`));
  }
  return unique(reasons).slice(0, 8);
}

function topReasoningEvidence(shipment = {}, topic = "") {
  const sourceFacts = shipment.evidencePacket?.sourceFacts || [];
  const factClaims = sourceFacts
    .slice()
    .sort((a, b) => sourceFactObservedAt(b) - sourceFactObservedAt(a))
    .map((fact) => cleanReasoningEvidenceText(fact.claim || fact.rawSnippet || "", 130))
    .filter(Boolean);
  return unique([
    ...factClaims,
    ...valuableFacts(shipment, topic).map((fact) => cleanReasoningEvidenceText(fact, 130)),
  ]).slice(0, 5);
}

function buildShipmentReasoningNode(shipment = {}, memory = {}) {
  const plan = controlRoomPlan(shipment, memory.actions || { actions: [], outboxRequests: [] });
  const state = shipmentExecutionState(shipment, memory.actions || { actions: [], outboxRequests: [] });
  const phase = plan.phase || state.phase || shipment.opsState?.phase || "";
  const relationships = relationshipCoverageForShipment(shipment, memory);
  const coverage = sourceCoverageForReasoning(shipment);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  const sourceGap = terminalRecovery ? null : sourceGapForReasoning(shipment, phase, coverage);
  const missing = missingRelationshipReasons(shipment, plan, relationships, coverage);
  const effectivePhase = sourceGap ? "source-gap" : phase;
  const className = sourceGap ? "source-gap" : operationalClassForPhase(phase);
  const action = sourceGap?.nextAction || terminalRecovery?.nextAction || plan.nextAction || state.nextAction || shipment.nextAction || "";
  const reason = sourceGap?.reason || terminalRecovery?.problem || plan.blocker || plan.headline || state.problem || shipment.currentState || shipment.opsState?.summary || "";
  return {
    awb: displayAwb(shipment.awb || shipment.id),
    station: shipment.station || "",
    customer: relationships.customer || relationships.consignee || "",
    phase: effectivePhase,
    underlyingPhase: sourceGap ? phase : "",
    className,
    label: sourceGap ? "Gmail source gap" : plan.label || state.label || phase,
    reason: compact(reason, 160),
    nextAction: compact(action, 180),
    urgency: Number.isFinite(plan.urgency) ? plan.urgency : state.urgency || 0,
    pingLevel: plan.pingLevel || state.pingLevel || "quiet",
    gates: reasoningGateSummary(plan),
    relationships,
    missing,
    sourceCoverage: coverage,
    contradictions: [
      ...(shipment.truthPacket?.contradictions || []),
      ...(shipment.evidencePacket?.contradictions || []),
      ...(plan.conflicts || []),
    ].map((item) => ({
      type: item.type || item.id || "contradiction",
      summary: compact(item.summary || item.claim || item.operatorMessage || "", 150),
    })).filter((item) => item.summary).slice(0, 6),
    evidence: topReasoningEvidence(shipment),
  };
}

function boardPhaseLabel(phase = "") {
  return String(phase || "unknown").replace(/-/g, " ");
}

function boardPhaseCounts(nodes = []) {
  return nodes.reduce((acc, node) => {
    const key = node.phase || "unknown";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function buildActiveShipmentReasoning(memory = {}) {
  const allShipments = mergeShipments(memory, { attachPackets: true });
  const activeAwbs = currentActiveAwbSet(memory);
  const activeShipments = activeAwbs.size
    ? allShipments.filter((shipment) => activeAwbs.has(normalizeAwb(shipment.awb)))
    : allShipments.filter((shipment) => !gateState(shipment).completed);
  const nodes = activeShipments.map((shipment) => buildShipmentReasoningNode(shipment, memory));
  const byClass = nodes.reduce((acc, node) => {
    acc[node.className] = (acc[node.className] || 0) + 1;
    return acc;
  }, {});
  const phaseCounts = boardPhaseCounts(nodes);
  const priority = nodes.slice().sort((a, b) => {
    const classScore = {
      "true-exception": 120,
      "blocked-work": 100,
      "post-pickup": 80,
      "ready-execution": 70,
      "not-ready": 50,
      "arrival-watch": 20,
      closed: 0,
      open: 10,
    };
    return (classScore[b.className] || 0) + (b.urgency || 0) - ((classScore[a.className] || 0) + (a.urgency || 0));
  });
  const sourceGaps = nodes.filter((node) => !node.sourceCoverage.hasGmailEvidence || node.missing.some((item) => /relation missing|source fact/i.test(item)));
  return {
    snapshotTime: memory.truthPackets?.snapshotTime || "",
    total: nodes.length,
    phaseCounts,
    classCounts: byClass,
    trueExceptionCount: nodes.filter((node) => node.className === "true-exception").length,
    blockedWorkCount: nodes.filter((node) => node.className === "blocked-work").length,
    readyExecutionCount: nodes.filter((node) => node.className === "ready-execution").length,
    notReadyCount: nodes.filter((node) => node.className === "not-ready").length,
    postPickupCount: nodes.filter((node) => node.className === "post-pickup").length,
    sourceGapCount: sourceGaps.length,
    shipments: nodes,
    priority,
    sourceGaps,
  };
}

function formatPhaseCounts(phaseCounts = {}) {
  return Object.entries(phaseCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phase, count]) => `${count} ${boardPhaseLabel(phase)}`)
    .join(", ");
}

function boardReasonLine(node = {}) {
  const relationGap = node.missing.find((item) => /relation missing|source fact/i.test(item));
  const parts = [
    node.awb,
    node.station,
    boardPhaseLabel(node.phase),
    node.reason || node.label,
    relationGap ? `gap: ${relationGap}` : "",
  ].filter(Boolean);
  return compact(parts.join(" · "), 180);
}

function boardReasoningAnswer(question, memory) {
  const graph = buildActiveShipmentReasoning(memory);
  const trueExceptions = graph.priority.filter((node) => node.className === "true-exception");
  const blockedWork = graph.priority.filter((node) => node.className === "blocked-work");
  const readyExecution = graph.priority.filter((node) => node.className === "ready-execution");
  const notReady = graph.priority.filter((node) => node.className === "not-ready");
  const postPickup = graph.priority.filter((node) => node.className === "post-pickup");
  const topRows = graph.priority.slice(0, 8);
  const answerLines = unique([
    `The board has ${graph.total} active shipments. They are not all true exceptions: ${graph.trueExceptionCount} true exception${graph.trueExceptionCount === 1 ? "" : "s"}, ${graph.blockedWorkCount} blocked-work row${graph.blockedWorkCount === 1 ? "" : "s"}, ${graph.readyExecutionCount} ready-execution row${graph.readyExecutionCount === 1 ? "" : "s"}, ${graph.notReadyCount} not-ready row${graph.notReadyCount === 1 ? "" : "s"}, and ${graph.postPickupCount} post-pickup closeout row${graph.postPickupCount === 1 ? "" : "s"}.`,
    `Phase breakdown: ${formatPhaseCounts(graph.phaseCounts)}.`,
    trueExceptions.length ? `True exceptions: ${trueExceptions.slice(0, 4).map(boardReasonLine).join(" | ")}.` : "No true exception rows are currently leading the board.",
    blockedWork.length ? `Blocked work: ${blockedWork.slice(0, 4).map(boardReasonLine).join(" | ")}.` : "",
    readyExecution.length ? `Ready execution: ${readyExecution.slice(0, 4).map((node) => `${node.awb}${node.relationships.pickupBroker ? ` via ${compact(node.relationships.pickupBroker, 32)}` : " needs pickup owner"}: ${compact(node.nextAction, 80)}`).join(" | ")}.` : "",
    notReady.length ? `Not ready: ${notReady.slice(0, 4).map((node) => `${node.awb}: ${compact(node.nextAction, 90)}`).join(" | ")}.` : "",
    graph.sourceGapCount ? `Source/relation gaps remain on ${graph.sourceGapCount} active shipment${graph.sourceGapCount === 1 ? "" : "s"}; those should show as unknowns or repair work, not fake certainty.` : "",
  ].filter(Boolean));
  const itemForNode = (node) => ({
    id: normalizeAwb(node.awb) || node.awb,
    awb: node.awb,
    context: [node.station, boardPhaseLabel(node.phase), compact(node.customer, 22)].filter(Boolean).join(" · "),
    action: compact(node.nextAction || node.reason || node.label, 110),
    signals: unique([
      node.className.replace(/-/g, " "),
      node.sourceCoverage.hasGmailEvidence ? "Gmail-backed" : "Gmail gap",
      node.relationships.pickupBroker ? `pickup ${compact(node.relationships.pickupBroker, 18)}` : "",
      node.relationships.customsBroker ? `customs ${compact(node.relationships.customsBroker, 18)}` : "",
    ].filter(Boolean)).slice(0, 4),
  });
  return {
    title: "Active shipment truth",
    subtitle: `${graph.total} active shipments · ${graph.trueExceptionCount} true exceptions`,
    answer: answerLines.join("\n"),
    facts: [],
    actions: [],
    items: topRows.slice(0, 3).map(itemForNode),
    allItems: graph.priority.map(itemForNode),
    hiddenCount: Math.max(0, graph.priority.length - 3),
    shipments: mergeShipments(memory, { attachPackets: false })
      .filter((shipment) => graph.priority.slice(0, 8).some((node) => normalizeAwb(node.awb) === normalizeAwb(shipment.awb))),
    reasoning: {
      snapshotTime: graph.snapshotTime,
      total: graph.total,
      phaseCounts: graph.phaseCounts,
      classCounts: graph.classCounts,
      sourceGapCount: graph.sourceGapCount,
      shipments: graph.shipments.slice(0, 40),
    },
    context: {
      topic: "board-reasoning",
      list: true,
      question: compact(question, 180),
      shipmentIds: graph.priority.map((node) => normalizeAwb(node.awb)).filter(Boolean),
    },
  };
}

function pickupDateKey(shipment) {
  const gates = gateState(shipment);
  if (gates.pickupScheduledDate) return gates.pickupScheduledDate;
  const text = pickupExecutionText(shipment);
  const base = Number.isFinite(Date.parse(shipment.lastEmail?.at || "")) ? new Date(shipment.lastEmail.at) : new Date();
  if (operatorPickupScheduledToday(shipment)) return operatorDateKey(new Date());
  if (/\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt)\b[^.;\n]{0,100}\btomorrow\b|\btomorrow\b[^.;\n]{0,100}\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt)\b/i.test(text)) {
    return addDaysOperatorDateKey(base, 1);
  }
  if (pickupScheduledToday(shipment)) return addDaysOperatorDateKey(base, 0);
  const explicit = text.match(/\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt)\b[^.;\n]{0,100}\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  return explicit ? parsedDateKey(explicit[1], base) : "";
}

function pickupListCandidate(shipment, question = "", actions = { actions: [], outboxRequests: [] }) {
  const gates = gateState(shipment);
  const resolved = resolveShipmentState(shipment);
  if (gates.completed) return false;
  if (gates.pickedUp || resolved.deliveryScheduledToday || resolved.deliveryScheduledDate) return false;
  const window = questionDateWindow(question);
  const pickupProblem = pickupProblemReason(shipment);
  const scheduleQuestion = /\b(?:scheduled|schedule|today|tomorrow|ready|planned|assigned|confirmed)\b/i.test(String(question || ""));
  if (scheduleQuestion && pickupProblem) return false;
  if (gates.driverOnsite || gates.loadingProblem) return true;
  const scheduledPickupDate = pickupDateKey(shipment);
  if (scheduleQuestion && window && scheduledPickupDate && dateKeyInWindow(scheduledPickupDate, window)) return true;
  if (!gates.arrived || gates.arrivalIncomplete || !gates.customsBrokerRelease) return false;
  if (pickupProblem) return true;
  if (window?.label === "today") {
    const scheduled = scheduledPickupDate;
    const award = selectedPickupAward(shipment, actions);
    const hasActionableAward = Boolean(award && (award.email || pickupQuotes(shipment).length));
    if (!scheduled && !hasActionableAward) return false;
    if (scheduled && !dateKeyInWindow(scheduled, window)) return false;
  }
  if (window && window.label !== "today") return dateKeyInWindow(pickupDateKey(shipment), window);
  return Boolean(pickupScheduledToday(shipment) || gates.releasePackageReady || knownPickupBroker(shipment, actions) || pickupQuotes(shipment).length);
}

function deliveryListCandidate(shipment, question = "") {
  const gates = gateState(shipment);
  const resolved = resolveShipmentState(shipment);
  if (gates.completed) return false;
  const window = questionDateWindow(question);
  if (window) return dateKeyInWindow(gates.deliveryScheduledDate || resolved.deliveryScheduledDate, window);
  const text = statusText(shipment);
  return Boolean(
    gates.deliveryProblem ||
      resolved.deliveryScheduledToday ||
      /\b(?:out for delivery|delivery appointment|scheduled (?:for )?delivery today|delivering today|en route to consignee)\b/i.test(text),
  );
}

function pickupScheduledToday(shipment) {
  const gates = gateState(shipment);
  if (gates.completed) return false;
  if (gates.pickupScheduledDate) return gates.pickupScheduledDate === operatorDateKey(new Date());
  if (gates.pickupScheduled) return false;
  const text = pickupExecutionText(shipment);
  return /\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt)\b[^.;\n]{0,100}\b(?:today|this morning|this afternoon|this evening)\b|\b(?:today|this morning|this afternoon|this evening)\b[^.;\n]{0,100}\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt)\b/i.test(text);
}

function operatorPickupScheduledToday(shipment) {
  if (gateState(shipment).completed) return false;
  const text = (shipment.operatorNotes || []).map(factRowText).join(" ");
  return /\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt|picks?\s*up)\b[^.;\n]{0,100}\b(?:today|this morning|this afternoon|this evening)\b|\b(?:today|this morning|this afternoon|this evening)\b[^.;\n]{0,100}\b(?:pickup|pick up|recover|recovery|driver|truck|appointment|appt|picks?\s*up)\b/i.test(text);
}

function dateKeyNearText(text, cuePattern, base = new Date()) {
  const sentences = String(text || "").split(/(?<=[.;\n])\s+/).filter(Boolean);
  for (const sentence of sentences) {
    if (!cuePattern.test(sentence)) continue;
    const match = sentence.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
    const dateKey = match ? parsedDateKey(match[1], base) : "";
    if (dateKey) return dateKey;
  }
  return "";
}

function arrivalDateKey(shipment) {
  const resolved = resolveShipmentState(shipment);
  const evidenceDate = dateKeyNearText(statusText(shipment), /\b(?:arrived|arrival|available|on hand|on-hand)\b/i, new Date(shipment.lastEmail?.at || Date.now()));
  if (evidenceDate) return evidenceDate;
  const candidates = [
    resolved.arrivedAt,
    shipment.arrivedAt,
    shipment.lastEmail?.at,
  ].filter(Boolean);
  return candidates.map(eventDateKey).find(Boolean) || "";
}

function etaDateKey(shipment) {
  const candidates = [
    shipment.eta,
    shipment.tms?.eta,
    shipment.tms?.etaDate,
    shipment.expectedArrival,
    shipment.arrivalEta,
  ].filter(Boolean);
  const direct = candidates.map((value) => parsedDateKey(value, new Date()) || dateKeyFromDate(new Date(value))).find(Boolean);
  if (direct) return direct;
  const text = statusText(shipment);
  const match = text.match(/\b(?:eta|expected|scheduled|arrives?|arrival)\b[^.;\n]{0,80}\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\b/i);
  return match ? parsedDateKey(match[1], new Date()) : "";
}

function arrivalPlanningDateKey(shipment) {
  const gates = gateState(shipment);
  return gates.arrived ? arrivalDateKey(shipment) : etaDateKey(shipment);
}

function arrivalListCandidate(shipment, question) {
  const gates = gateState(shipment);
  if (gates.completed) return false;
  const state = shipmentExecutionState(shipment, { actions: [], outboxRequests: [] });
  if (gates.deliveryReported || gates.pickedUp) return false;
  const arrivalRelevant = gates.arrived || state.phase === "arrival-unverified";
  const text = String(question || "");
  const wantsUnhandled =
    /\b(?:hasn'?t been handled|has not been handled|not handled|unhandled|still open|not fully handled|needs handling|needs to be handled)\b/i.test(
      text,
    );
  if (wantsUnhandled) {
    return Boolean(arrivalRelevant && !gates.podPending);
  }
  const window = questionDateWindow(question);
  if (window) {
    const asksPlannedArrival = /\b(?:supposed|expected|scheduled|eta|arriving|arrive(?:s)?|coming in)\b/i.test(text) && !/\barrived\b/i.test(text);
    const dateMatches = dateKeyInWindow(arrivalPlanningDateKey(shipment), window);
    return dateMatches && (arrivalRelevant || asksPlannedArrival);
  }
  return arrivalRelevant;
}

function releaseListCandidate(shipment) {
  const gates = gateState(shipment);
  if (gates.completed) return false;
  return Boolean((gates.arrived || gates.driverOnsite || pickupProblemReason(shipment)) && !gates.customsBrokerRelease);
}

function quoteListCandidate(shipment, actions) {
  const gates = gateState(shipment);
  if (gates.completed || gates.pickedUp) return false;
  const text = actionMemoryText(shipment, actions);
  return Boolean(quoteBlastNeeded(shipment, actions) || pickupQuotes(shipment).length || /\b(?:quote blast|quote request|requested pickup rates|asked for rates|waiting for pickup prices)\b/i.test(text));
}

function podListCandidate(shipment) {
  const gates = gateState(shipment);
  if (gates.completed) return false;
  if (gates.deliveryReported) return true;
  if (gates.pickedUp && !gates.pickupBlocked && !gates.arrivalIncomplete) return true;
  return Boolean(
    (gates.deliveryReported || gates.pickedUp) &&
    /\b(?:pod pending|pod needed|proof of delivery pending|delivery proof missing)\b/i.test(statusText(shipment))
  );
}

function completedDateKey(shipment) {
  const resolved = resolveShipmentState(shipment);
  const candidates = [
    resolved.deliveredAt,
    shipment.pod?.deliveredAt,
    shipment.completion?.deliveredAt,
    shipment.lastEmail?.at,
  ].filter(Boolean);
  return candidates.map(eventDateKey).find(Boolean) || "";
}

function completedListCandidate(shipment, question) {
  const gates = gateState(shipment);
  if (!gates.completed) return false;
  if (!/\btoday\b/i.test(question)) return true;
  return completedDateKey(shipment) === operatorDateKey(new Date());
}

function stationOpenListCandidate(shipment, question = "") {
  const gates = gateState(shipment);
  if (!gates.completed) return true;
  const completedKey = completedDateKey(shipment);
  const window = questionDateWindow(question);
  if (window) return dateKeyInWindow(completedKey, window);
  if (!completedKey) return true;
  return dateKeyWithinPastDays(completedKey, 7);
}

function itemActionLine(shipment, state, mode, memory = null) {
  const gates = gateState(shipment);
  const resolved = resolveShipmentState(shipment);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  if (terminalRecovery && ["urgent", "delivery", "risk", "station-open"].includes(mode)) {
    return terminalRecovery.nextAction;
  }
  if (gates.completed && ["station-open", "completed"].includes(mode)) {
    return unique([podLine(shipment) || "Delivered/POD is in memory.", sourceCoverageLine(shipment)].filter(Boolean)).join(" ");
  }
  const airportDwellPing = airportDwellActionsForShipment(shipment, memory?.actions || { actions: [], outboxRequests: [] })
    .find((action) => action.channel === "platform");
  if (airportDwellPing && ["urgent", "pickup", "arrival", "release", "station-open"].includes(mode)) {
    const reason = airportDwellPing.reason || airportDwellPing.problem || "";
    const label = /location/i.test(reason)
      ? "Pickup location needed"
      : /docs?|delivery order|d\/?o/i.test(reason)
      ? "Pickup docs needed"
      : "Pickup blocked";
    return compact(
      [`${label}: ${reason}`, airportDwellPing.nextAction || airportDwellPing.label]
        .filter(Boolean)
        .join(" "),
      120,
    );
  }
  const pickup = pickupBrokerContact(shipment, memory?.actions || null);
  const pickupName = usableContactName(pickup.name);
  const customs = customsBrokerContact(shipment);
  if (mode === "risk") {
    const risk = shipmentOperationalRisk(shipment);
    if (risk.level === "none" && storageListCandidate(shipment, memory)) {
      const storage = storageTiming(shipment, memory);
      const storageText = storage.line.replace(/^Storage:\s*/i, "").replace(/\.$/, "");
      return `${storageText}: confirm pickup before charges grow.`;
    }
    return risk.action || risk.reason || state.nextAction;
  }
  if (mode === "storage") {
    const storage = storageTiming(shipment, memory);
    const storageText = storage.line.replace(/^Storage:\s*/i, "").replace(/\.$/, "");
    return `${storageText}: confirm pickup before charges grow.`;
  }
  if (mode === "delivery") {
    if (gates.deliveryProblem) return "Delivery blocked; call broker/driver now.";
    if (resolved.deliveryScheduledToday) return "Delivery scheduled today; collect POD after delivery.";
    return "Track final delivery and collect POD.";
  }
  if (mode === "pickup") {
    const pickupProblem = pickupProblemReason(shipment);
    if (pickupProblem) return "Driver waiting; call station/broker now.";
    if (gates.driverOnsite) return "Driver onsite; monitor loading and detention.";
    if (gates.pickupScheduled) return `Pickup scheduled${gates.pickupScheduledDate ? ` ${formatDate(gates.pickupScheduledDate)}` : ""}; collect proof after pickup.`;
    if (pickupScheduledToday(shipment)) return "Pickup scheduled today; monitor recovery and pickup proof.";
    if (pickupName) return `${compact(pickupName, 32)} should recover it; confirm pickup/POD.`;
    return state.nextAction;
  }
  if (mode === "arrival") {
    if (state.phase === "arrival-unverified") return etaPassedArrivalLine(shipment);
    if (gates.deliveryReported) return "Delivered; POD pending.";
    if (gates.arrivalIncomplete) return "Arrived, but station availability/pieces still need confirmation.";
    if (!gates.customsBrokerRelease) return gates.customsHold ? "Arrived under customs hold; monitor broker thread." : "Arrived; release/DO still needs confirmation.";
    if (!gates.groundPaid && groundFeeLine(shipment)) return "Arrived and released; confirm/pay ground fees.";
    if (gates.pickupScheduled) return `Pickup scheduled${gates.pickupScheduledDate ? ` ${formatDate(gates.pickupScheduledDate)}` : ""}; wait for pickup proof.`;
    if (!gates.pickedUp) return pickupName ? `Arrived/released; dispatch ${compact(pickupName, 28)}.` : "Arrived/released; assign pickup broker.";
    return "Arrived and picked up; track delivery/POD.";
  }
  if (mode === "release") {
    if (gates.customsHold) return "Customs hold; monitor the broker thread.";
    if (pickupProblemReason(shipment)) return "Driver waiting; station cannot see release/DO.";
    return `Push ${compact(customs.name || "customs broker", 32)} for release/DO.`;
  }
  if (mode === "quotes") return pickupQuoteDetailsLine(shipment, { actions: [], outboxRequests: [] }).replace(/^Pickup quotes:\s*/i, "Quotes: ");
  if (mode === "pod") return gates.pickedUp ? "Picked up; collect delivery/POD proof." : state.nextAction;
  if (mode === "completed") return unique([podLine(shipment) || "Delivered/POD is in memory.", sourceCoverageLine(shipment)].filter(Boolean)).join(" ");
  if (state.phase === "delivered-pod-pending") return "Delivered. POD missing.";
  if (state.phase === "arrival-unverified") return "ETA passed. Confirm arrival/storage.";
  if (state.phase === "pickup-blocked") return "Pickup blocked. Call station/broker.";
  if (state.phase === "storage-risk") return "Storage active. Clear blocker.";
  return `${state.label}: ${state.nextAction}`;
}

function compactShipmentAnswer(shipment, actionContext) {
  const gates = gateState(shipment);
  const plan = controlRoomPlan(shipment, actionContext);
  const terminalRecovery = terminalRecoveryBlockerForShipment(shipment);
  if (plan.phase === "conflict") return shipmentBrief(shipment, actionContext);
  const scheduledDeliveryDate = gates.deliveryScheduledDate || resolveShipmentState(shipment).deliveryScheduledDate || "";
  const scheduledDeliveryToday = gates.deliveryScheduledToday || (scheduledDeliveryDate && scheduledDeliveryDate === operatorDateKey(new Date()));
  const scheduledDeliveryCurrent = dateKeyIsTodayOrFuture(scheduledDeliveryDate);
  const terminalRecoveryLine =
    shipment.currentState ||
    shipment.opsState?.summary ||
    shipment.opsState?.label ||
    shipment.truthPacket?.stateReason ||
    terminalRecovery?.problem ||
    plan.headline ||
    plan.problem ||
    "Delivery/recovery is blocked.";
  const stateLine = gates.completed
    ? podLine(shipment) || "Delivered. POD is in memory."
    : plan.phase === "delivered-pod-pending"
    ? "Delivered; POD is still pending."
    : plan.phase === "exception"
    ? plan.headline || "Open operational exception."
    : plan.phase === "arrival-unverified"
    ? etaPassedArrivalLine(shipment)
    : plan.phase === "delivery-blocked"
    ? terminalRecoveryLine
    : plan.phase === "customs-hold"
    ? gates.arrived
      ? "Arrived, but customs hold is still blocking pickup."
      : "Customs hold is active; arrival proof is still incomplete."
    : plan.phase === "release-needed"
    ? "Arrived. Release/DO is still missing."
    : plan.phase === "fees-needed"
    ? "Arrived and released. Ground fees need confirmation."
    : plan.phase === "pickup-scheduled"
    ? `${knownPickupBroker(shipment, actionContext) || pickupBrokerContact(shipment, actionContext).name || "Pickup broker"} is ${gates.pickupScheduled ? "scheduled" : "assigned"} for pickup${gates.pickupScheduledDate ? ` ${formatDate(gates.pickupScheduledDate)}` : ""}.`
    : plan.phase === "dispatch-ready" || plan.phase === "approval-needed"
    ? "Arrived and released. Dispatch is next."
    : plan.phase === "out-for-delivery"
    ? `${gates.pickedUp ? "Picked up; " : ""}${scheduledDeliveryToday ? "scheduled for delivery today" : `scheduled delivery${scheduledDeliveryDate ? ` ${formatDate(scheduledDeliveryDate)}` : ""}`}.`
    : gates.pickedUp && scheduledDeliveryDate && scheduledDeliveryCurrent && !gates.podPending
    ? `Picked up; ${scheduledDeliveryToday ? "scheduled for delivery today" : `scheduled delivery ${formatDate(scheduledDeliveryDate)}`}.`
    : gates.pickedUp && plan.phase === "pod-needed"
    ? "Picked up; POD missing."
    : gates.pickedUp
    ? "Picked up. Track delivery/POD."
    : plan.phase === "pre-arrival"
    ? "Not arrived yet."
    : gates.arrived
    ? "Arrived."
    : plan.headline || shipmentBrief(shipment, actionContext).split(/\n/)[0] || "I have shipment memory for this AWB.";
  const storage = plan.storage && !gates.completed ? plan.storage.replace(/^Storage:\s*/i, "Storage: ") : "";
  const customsCheck = Array.isArray(plan.checks) ? plan.checks.find((check) => check.key === "customs") : null;
  const customs = customsCheck?.status === "done" && !gates.completed
    ? terminalRecovery ? "" : sentence(`Customs: released${customsCheck.detail && !/passed delivery path|not confirmed/i.test(customsCheck.detail) ? ` - ${compact(customsCheck.detail, 72)}` : ""}`)
    : customsCheck?.status === "blocked" && !gates.completed && !terminalRecovery
    ? sentence(`Customs: blocked${customsCheck.detail ? ` - ${compact(customsCheck.detail, 72)}` : ""}`)
    : "";
  const groundFeeCheck = Array.isArray(plan.checks) ? plan.checks.find((check) => check.key === "groundFees") : null;
  const staleGenericFeeDue =
    groundFeeCheck?.status === "due" &&
    plan.phase === "pickup-scheduled" &&
    !/\$\s*\d|payment due|amount due|total due|due at station|please pay|unpaid|before freight release|need(?:s)? payment|station fee|ground fees? due at/i.test(`${groundFeeCheck.detail || ""}`);
  const groundFees = !terminalRecovery && groundFeeCheck?.status === "due" && !staleGenericFeeDue
    ? sentence(`Ground fees: due${groundFeeCheck.detail && !/not confirmed/i.test(groundFeeCheck.detail) ? ` - ${compact(groundFeeCheck.detail, 72)}` : ""}`)
    : !terminalRecovery && groundFeeCheck?.status === "done" && !gates.completed && groundFeeCheck.detail && !/passed delivery path|not confirmed/i.test(groundFeeCheck.detail)
    ? sentence(`Ground fees: done - ${compact(groundFeeCheck.detail, 72)}`)
    : "";
  const quote = plan.quote && !gates.completed && !terminalRecovery ? compact(plan.quote, 100) : "";
  const approvalActions = Array.isArray(plan.actionsReady) ? plan.actionsReady.filter((action) => action.channel !== "platform") : [];
  const firstAction = approvalActions[0] || null;
  const secondAction = approvalActions[1] || null;
  const actionLine = firstAction ? `Action: ${compact(firstAction.label || "Approve action", 90)}.` : "";
  const nextActionLine = secondAction ? `Then: ${compact(secondAction.label || "Approve action", 90)}.` : "";
  const next = gates.completed ? "" : plan.nextAction ? `Now: ${compact(plan.nextAction, 110)}` : "";
  return unique([
    sentence(stateLine),
    gates.completed ? sourceCoverageLine(shipment) : "",
    storage,
    customs,
    groundFees,
    quote,
    next,
    actionLine,
    nextActionLine,
  ].filter(Boolean)).join("\n");
}

function answerList(question, memory, options = {}) {
  let mode = options.mode || listIntent(question);
  const allShipments = mergeShipments(memory, { attachPackets: false });
  const activeAwbs = currentActiveAwbSet(memory);
  const activeShipments = activeAwbs.size
    ? allShipments.filter((shipment) => activeAwbs.has(normalizeAwb(shipment.awb)))
    : allShipments;
  const questionText = String(question || "");
  const station = options.station || stationFromQuestion(questionText, allShipments);
  const stationActionQuestion = /\b(?:urgent|action|now|need|needs|problem|issue|risk|storage|pod|quote|release|customs|delivery|pickup)\b/i.test(questionText);
  const stationOpenQuestion = station && (
    /\b(?:is there|are there|any|open|working|work|shipments?|loads?)\b.{0,80}\b(?:in|at|for)?\b/i.test(questionText) ||
    /\b(?:what about|show|list|status)\b.{0,80}\b/i.test(questionText) ||
    new RegExp(`\\b${escapeRegExp(station)}\\b`, "i").test(questionText)
  ) && !normalizeAwb(questionText) && !stationActionQuestion;
  if (mode === "urgent" && stationOpenQuestion) mode = "station-open";
  const shipments = mode === "completed"
    ? allShipments
    : mode === "station-open"
    ? activeShipments
    : activeShipments.filter((shipment) => !gateState(shipment).completed);
  const scoped = station ? shipments.filter((shipment) => String(shipment.station || "").toUpperCase() === station) : shipments;
  let rows = Array.isArray(options.rows) ? options.rows : scoped;
  if (Array.isArray(options.rows) && mode !== "completed" && activeAwbs.size) {
    rows = rows.filter((shipment) => activeAwbs.has(normalizeAwb(shipment.awb)));
  }
  if (!Array.isArray(options.rows)) {
    if (mode === "storage") rows = scoped.filter((shipment) => storageListCandidate(shipment, memory));
    else if (mode === "release") rows = scoped.filter(releaseListCandidate);
    else if (mode === "delivery") rows = scoped.filter((shipment) => deliveryListCandidate(shipment, question));
    else if (mode === "pickup") rows = scoped.filter((shipment) => pickupListCandidate(shipment, question, memory.actions));
    else if (mode === "arrival") rows = scoped.filter((shipment) => arrivalListCandidate(shipment, question));
    else if (mode === "risk") rows = scoped.filter((shipment) => operationalRiskCandidate(shipment, memory));
    else if (mode === "quotes") rows = scoped.filter((shipment) => quoteListCandidate(shipment, memory.actions));
    else if (mode === "pod") rows = scoped.filter(podListCandidate);
    else if (mode === "completed") rows = scoped.filter((shipment) => completedListCandidate(shipment, question));
    else if (mode === "station-open") rows = scoped.filter((shipment) => stationOpenListCandidate(shipment, question));
    else rows = scoped.filter((shipment) => morningPriorityCandidate(shipment, memory.actions));
  }

  const sorted = rows
    .map((shipment) => ({ shipment, state: shipmentExecutionState(shipment, memory.actions), score: actionScore(shipment, memory.actions, mode, memory) }))
    .sort((a, b) => b.score - a.score)
    .map(({ shipment, state }) => ({ shipment, state }));
  const topActions = [];
  const seenActions = new Set();
  const allowPlatformListActions = new Set(["urgent", "release", "pickup", "arrival", "delivery", "pod", "quotes", "station-open"]);
  const rowActionLimit = 12;
  for (const { shipment } of sorted.slice(0, rowActionLimit)) {
    const proposed = proposedActionsForShipment(shipment, memory.actions);
    const action = proposed.find((item) => item.channel !== "platform") || (allowPlatformListActions.has(mode) ? proposed[0] : null);
    if (!action) continue;
    if (mode !== "urgent" && isConflictClarificationAction(action)) {
      continue;
    }
    const actionKey = (action.id || `${normalizeAwb(action.awb || shipment.awb)}:${action.type || ""}:${action.label || ""}:${action.targetEmail || action.targetName || ""}`).toLowerCase();
    if (seenActions.has(actionKey)) continue;
    seenActions.add(actionKey);
    topActions.push(action);
  }
  const copy = listCopy(mode, station, sorted.length);
  const dateWindow = options.dateWindow || questionDateWindow(question);
  const answer = companionListAnswerText(mode, sorted, station, question, dateWindow, memory);
  const shipmentIds = sorted.slice(0, 12).map(({ shipment }) => normalizeAwb(shipment.awb)).filter(Boolean);
  const visibleItemLimit = mode === "station-open" ? 8 : 3;
  const itemForShipment = ({ shipment, state }) => {
    const stateCode = shipment.truthPacket?.resolvedCurrentState || shipment.truthPacket?.currentState || shipment.opsState?.phase || "";
    return {
      id: shipment.id || shipment.awb,
      awb: shipment.awb,
      context: [shipment.station, shipment.airline, compact(shipment.consignee || shipment.client, 22)].filter(Boolean).join(" · "),
      state: opsQuery.statePhrase(stateCode),
      stateCode,
      action: compact([listDateLabel(shipment, mode), itemActionLine(shipment, state, mode, memory)].filter(Boolean).join(" · "), 90),
      source: "shipment-truth-packets",
      signals: mode === "risk"
        ? unique([
          shipmentOperationalRisk(shipment).level,
          shipmentOperationalRisk(shipment).type.replace(/-/g, " "),
          ...chipsForShipment(shipment, memory),
        ]).filter((signal) => signal && signal !== "none").slice(0, 3)
        : mode === "storage" ? chipsForShipment(shipment, memory).slice(0, 3) : state.signals.slice(0, 3),
    };
  };
  return {
    title: copy.title,
    subtitle: "",
    answer: sorted.length ? answer || copy.answer : copy.empty,
    items: sorted.slice(0, visibleItemLimit).map(itemForShipment),
    allItems: sorted.map(itemForShipment),
    hiddenCount: Math.max(0, sorted.length - visibleItemLimit),
    facts: [],
    actions: topActions.slice(0, rowActionLimit),
    shipments: sorted.slice(0, 8).map(({ shipment }) => shipment),
    context: {
      station,
      topic: mode,
      list: true,
      shipmentIds,
      dateWindow,
    },
  };
}

function morningPriorityCandidate(shipment, actions = { actions: [], outboxRequests: [] }) {
  const state = shipmentExecutionState(shipment, actions);
  const gates = gateState(shipment);
  const storage = storageTiming(shipment);
  const pickupProblem = pickupProblemReason(shipment);
  const airportDwellPing = airportDwellActionsForShipment(shipment, actions).some((action) => action.channel === "platform");
  const actionReadyPhases = new Set([
    "approval-needed",
    "delivered-pod-pending",
    "pod-needed",
  ]);
  if (gates.completed) return false;
  if (state.phase === "pre-arrival") return false;
  if (airportDwellPing) return true;
  if (storage.active || storage.dueSoon) return true;
  if (gates.deliveryProblem || pickupProblem) return true;
  if (deliveryListCandidate(shipment, "today")) return true;
  if (gates.deliveryScheduledToday) return true;
  if (pickupScheduledToday(shipment)) return true;
  if (arrivalListCandidate(shipment, "today")) return true;
  if (state.actionRequired && state.phase === "dispatch-ready" && selectedPickupAward(shipment, actions)) return true;
  if (state.actionRequired && actionReadyPhases.has(state.phase)) return true;
  return state.actionRequired && state.urgency >= 55;
}

function actionScore(shipment, actions = { actions: [], outboxRequests: [] }, mode = "", memory = null) {
  const state = shipmentExecutionState(shipment, actions);
  const text = statusText(shipment);
  const gates = gateState(shipment);
  const storage = storageTiming(shipment);
  const airportDwellPing = airportDwellActionsForShipment(shipment, actions).some((action) => action.channel === "platform");
  if (mode === "risk") {
    const memoryStorage = storageListCandidate(shipment, memory) ? 95 : 0;
    return Math.max(operationalRiskScore(shipment), memoryStorage) + state.urgency;
  }
  const todayBoost = mode === "urgent" ? [
    airportDwellPing ? 60 : 0,
    gates.deliveryProblem || gates.loadingProblem || pickupProblemReason(shipment) ? 45 : 0,
    storage.active ? 40 : storage.dueSoon ? 25 : 0,
    gates.deliveryScheduledToday ? 35 : 0,
    pickupScheduledToday(shipment) ? 30 : 0,
    arrivalListCandidate(shipment, "today") ? 20 : 0,
  ].reduce((sum, value) => sum + value, 0) : 0;
  return state.urgency + todayBoost + [
    /detention/i.test(text) ? 15 : 0,
    /no reply|ignored|waiting/i.test(text) ? 10 : 0,
    state.phase === "storage-risk" ? 20 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

function chipsForShipment(shipment, memory = null) {
  const gates = gateState(shipment);
  return [
    gates.completed ? "Delivered" : "",
    gates.deliveryProblem ? "Delivery blocked" : "",
    gates.loadingProblem ? "Loading blocked" : "",
    gates.driverOnsite ? "Driver onsite" : "",
    gates.pickedUp ? "Picked up" : "",
    gates.arrivalIncomplete ? "Availability issue" : "",
    gates.arrived ? "Arrived" : "",
    gates.customsBrokerRelease ? "Released" : gates.customsHold ? "Customs hold" : gates.brokerReleasePending ? "Broker not released" : "No release",
    gates.groundPaid ? "Ground fees paid" : "",
    storageLine(shipment, memory).replace(/^Storage:\s*/i, "").replace(/\.$/, ""),
  ].filter(Boolean);
}

function questionTopic(question, context = {}) {
  const text = String(question || "").toLowerCase();
  if (questionRequestsDeliveryOrder(text)) return "action";
  if (questionRequestsCustomerUpdate(text)) return "action";
  if (/\b(?:draft|send|follow ?up|approve|alert|what should|next action|do now|take action)\b/.test(text)) return "action";
  if (/\b(?:what exactly is the problem|what is the problem|what did you see|caused (?:this |the )?problem|why (?:is|was)|evidence|source)\b/.test(text)) return "problem";
  if (/\b(?:pcs?|pieces?|weight|dims?|dimensions?|cargo details|shipment details)\b/.test(text)) return "cargo";
  if (/\b(?:station details|station contact|station phone|station email|who.*(?:call|contact|pick|broker|driver)|phone|contact|call)\b/.test(text)) return "contact";
  if (/\b(?:what|which)\b.{0,24}\bstation\b|\bstation\b.{0,24}\b(?:is|in|at)\b|\bwhere\b.{0,24}\b(?:is|at)\b/i.test(text)) return "station";
  if (/\b(?:quote|quotes|price|prices|rate|rates|cost|lowest|award|broker options)\b/.test(text)) return "quotes";
  if (/\b(?:last email|latest email|latest update|what did .*say|jordan|alex|skyler|reply|replied)\b/.test(text)) return "latest";
  if (/\b(?:at risk|risk|risks|risky|operational risk|operationally at risk)\b/.test(text)) return "risk";
  if (/\b(?:pods?|proof of delivery|delivered|delivery|signed|receiver)\b/.test(text)) return "pod";
  if (/\b(?:pickup|picked up|driver|truck|loaded|onsite|detention|broker)\b/.test(text)) return "pickup";
  if (/\b(?:storage|last free|lfd|ground fee|ground fees|handling fee|station fee|cargosprint|paid|payment)\b/.test(text)) return "fees";
  if (/\b(?:customs|release|released|clearance|cleared|d\/?o|delivery order|hold|exam)\b/.test(text)) return "customs";
  if (/\b(?:arrival|arrived|notice of arrival|noa|on hand|available|availability|eta|expected)\b/.test(text)) return "arrival";
  if (/\b(?:urgent|today|needs action|problem|issue|open|what.*need)\b/.test(text)) return "urgent";
  if (context?.shipment && FOLLOW_UP_PATTERN.test(text)) return context.topic || "shipment";
  return "shipment";
}

function questionAsksForShipmentList(question) {
  const text = String(question || "").toLowerCase();
  if (!text || normalizeAwb(text)) return false;
  return Boolean(
    /\b(?:good morning|start(?:ing)? today|handle first|work first|focus first|what should i handle|what should i do today)\b/i.test(text) ||
      /\b(?:what'?s|whats|what|which)\b.{0,80}\b(?:shipments?|loads?|awbs?|pickups?)\b/i.test(text) ||
      /\b(?:what'?s|whats|what|which)\b.{0,80}\b(?:urgent|needs action|need action|at risk|risks?|risky|operational risk|out for delivery|scheduled (?:for )?delivery|delivery today|arrived|arriving|arrivals?|arrival|coming in|scheduled pickup|pickup schedule|storage|release\/?d\/?o|customs|quotes?|pods?)\b/i.test(text) ||
      /\bwho\b.{0,80}\b(?:waiting|needs?|has|is stuck|is blocked)\b/i.test(text),
  );
}

function questionHasSupportedDeterministicListIntent(question) {
  const text = String(question || "").toLowerCase();
  if (!questionAsksForShipmentList(text)) return false;
  return /\b(?:good morning|start(?:ing)? today|handle first|work first|focus first|priorit(?:y|ize)|urgent|needs? action|at risk|operational risk|open shipments?|active shipments?|arriv(?:e|es|ed|ing|al|als)|notice of arrival|on[- ]hand|available|release|released|clearance|customs|d\/?o|delivery order|pickup|picked up|driver|out for delivery|deliver(?:y|ed|ing)|pod|proof of delivery|storage|last free|lfd|quote|quotes|rate|rates|completed|closed|finished)\b/i.test(text);
}

function questionHasFleetIntent(question) {
  const text = String(question || "").trim();
  if (!text || normalizeAwb(text)) return false;
  if (questionHasSupportedDeterministicListIntent(text)) return true;
  if (opsQuery.parseOperatorQuery(text)) return true;
  if (coworkerIntentIsFleet(coworkerIntent(text))) return true;
  return /\b(?:whole|entire)\s+(?:board|fleet|operation)\b|\b(?:all|every)\s+(?:open\s+|active\s+)?(?:shipments?|loads?|awbs?)\b|\b(?:needs?|need)\s+(?:a\s+)?reply\b/i.test(text);
}

function quoteBlastLine(shipment, actions) {
  const key = normalizeAwb(shipment.awb);
  const memory = actionMemoryText(shipment, actions);
  const actionNames = unique([
    ...(actions.actions || [])
      .filter((action) => normalizeAwb(action.awb) === key && /quote/i.test(`${action.type || ""} ${action.label || ""} ${action.subject || ""}`))
      .map((action) => action.targetName || action.targetEmail || ""),
    ...(actions.outbox?.requests || actions.outboxRequests || [])
      .filter((request) => normalizeAwb(request.awb) === key && /quote/i.test(`${request.type || ""} ${request.label || ""} ${request.subject || ""}`))
      .map((request) => request.targetName || request.to || ""),
  ].filter(Boolean)).slice(0, 4);
  if (/\b(?:jordan|alex).{0,120}(?:requested rates|quote blast|asked for rates|requested quotes)\b/i.test(memory)) {
    return `Quote blast: Jordan/Alex requested pickup rates${actionNames.length ? ` from ${actionNames.join(", ")}` : ""}.`;
  }
  if (actionNames.length) return `Quote blast: sent/drafted to ${actionNames.join(", ")}.`;
  return "";
}

function pickupQuoteDetailsLine(shipment, actions) {
  if (publicPickupOwnerConfirmed(shipment)) return quoteLine(shipment, actions);
  const quotes = pickupQuotes(shipment);
  if (!quotes.length) return quoteLine(shipment, actions);
  const sorted = quotes
    .map((quote) => ({ ...quote, value: quoteAmountValue(quote) }))
    .sort((a, b) => a.value - b.value);
  const rendered = sorted.slice(0, 4).map((quote, index) => {
    const amount = quote.amount || quote.rate || quote.price || "";
    return `${quote.broker || "Broker"}${amount ? ` ${amount}` : ""}${index === 0 && Number.isFinite(quote.value) ? " lowest" : ""}`;
  });
  return `Pickup quotes: ${rendered.join(", ")}.`;
}

function contactLine(label, contact) {
  const name = contact?.name || "";
  const email = contact?.email || "";
  const phone = contact?.phone || "";
  if (!name && !email && !phone) return "";
  return `${label}: ${[name, email, phone].filter(Boolean).join(" · ")}.`;
}

function stationDetailLines(shipment, station) {
  const stationName = station?.name || [shipment.airline, shipment.station].filter(Boolean).join(" ") || shipment.station || "station";
  return [
    `Station: ${stationName}.`,
    station?.email ? `Email: ${station.email}.` : "Email: not in memory.",
    station?.phone ? `Phone: ${station.phone}.` : "Phone: not in memory.",
  ];
}

function stationCallInstruction(shipment, memory = null) {
  const station = stationContact(shipment, memory);
  const stationName = station.name || [shipment.airline, shipment.station].filter(Boolean).join(" ") || "station";
  const phone = station.phone || "";
  const email = station.email || "";
  const request = "confirm station availability, on-hand status, storage, piece count, and pickup availability";
  if (phone) return `Call ${stationName} at ${phone} to ${request}.${email ? ` If they do not answer, email ${email}.` : ""}`;
  if (email) return `Email ${stationName} at ${email} to ${request}; add the station phone when you get it.`;
  return `Station contact is missing for ${[shipment.station, shipment.airline].filter(Boolean).join(" / ") || shipment.awb}; add phone/email, then ${request}.`;
}

function instructionHasInvalidStationContact(value) {
  const text = String(value || "");
  if (!text) return false;
  return (
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+20\d{2}[-/]\d{1,2}[-/]\d{1,2}(?:\D|$)/i.test(text) ||
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+\d{4}[-/]\d{1,2}[-/]\d{1,2}\s*[.,;:]?\s*\d{1,5}\b/i.test(text) ||
    /\b(?:call|phone)\b[^.\n]{0,90}\bat\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\s*[.,;:]?\s*\d{1,5}\b/i.test(text)
  );
}

function safeShipmentInstruction(value, fallback) {
  const text = String(value || "").trim();
  if (!text || instructionHasInvalidStationContact(text)) return fallback;
  return text;
}

function shipmentContactAnswer(shipment, question, memory, roleHint = "") {
  const text = String(question || "");
  const gates = gateState(shipment);
  const role = contactRoleFromText(text) || contactRoleFromText(roleHint);
  let label = "Best contact";
  let contact = stationContact(shipment);
  if (role === "station" || /station details|station contact|station phone|station email/i.test(text)) {
    label = "Station";
    contact = stationContact(shipment, memory);
  } else if (role === "customs" || /customs|release|clear|d\/?o|delivery order/i.test(text) || (gates.arrived && !gates.customsBrokerRelease)) {
    label = "Customs broker";
    contact = customsBrokerContact(shipment);
  } else if (role === "pickup" || /pickup|broker|driver|truck|pod|delivery|quote|alert|norman/i.test(text) || gates.customsBrokerRelease) {
    label = "Pickup broker";
    contact = pickupBrokerContact(shipment, memory.actions);
  }
  const station = stationContact(shipment, memory);
  const stationMemory = contactAnswer(shipment.station, memory);
  const stationInfo = station.email || station.phone ? contactLine("Station", station) : stationMemory.answer;
  const primaryContact = label === "Station"
    ? stationDetailLines(shipment, contact)
    : [contactLine(label, contact) || "I do not have a confirmed contact for that role yet."];
  return {
    title: shipment.awb,
    subtitle: [shipment.station, label].filter(Boolean).join(" · "),
    answer: unique([
      ...primaryContact,
      stationInfo && label !== "Station" ? stationInfo : "",
      `Now: ${actionRecommendation(shipment, memory.actions)}`,
    ].filter(Boolean)).join("\n"),
    facts: [],
    actions: proposedActionsForShipment(shipment, memory.actions),
    items: [],
    plan: controlRoomPlan(shipment, memory.actions),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "contact", contactRole: role || contactRoleFromText(label) },
  };
}

function shipmentStationAnswer(shipment, memory) {
  const station = stationContact(shipment, memory);
  const stationName = station.name || [shipment.airline, shipment.station].filter(Boolean).join(" ") || shipment.station || "station";
  return {
    title: shipment.awb,
    subtitle: [shipment.station, shipment.airline, "station"].filter(Boolean).join(" · "),
    answer: unique([
      ...stationDetailLines(shipment, station),
      `Now: ${actionRecommendation(shipment, memory.actions)}`,
    ].filter(Boolean)).join("\n"),
    facts: [],
    actions: proposedActionsForShipment(shipment, memory.actions),
    items: [],
    plan: controlRoomPlan(shipment, memory.actions),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "station" },
  };
}

function shipmentPickupAnswer(shipment, memory, question = "") {
  const gates = gateState(shipment);
  const pickupEvidence = valuableFacts(shipment, "pickup")[0] || shipment.pickupStatus || shipment.freightBroker?.pickupPlan || "";
  const problem = pickupProblemReason(shipment);
  let line = "Pickup is not proven yet.";
  if (gates.pickedUp) {
    line = "Picked up / recovered is confirmed.";
  } else if (gates.driverOnsite) {
    line = "Not fully picked up yet. Driver is onsite/loading; wait for loaded proof.";
  } else if (gates.pickupScheduled) {
    line = "Not picked up yet. Pickup is scheduled/planned.";
  }
  return {
    title: shipment.awb,
    subtitle: [shipment.station, shipment.airline, "pickup"].filter(Boolean).join(" · "),
    answer: unique([
      line,
      problem && !gates.pickedUp ? `Blocker: ${problem}.` : "",
      pickupEvidence ? `Evidence: ${compact(pickupEvidence, 120)}.` : "",
      `Now: ${actionRecommendation(shipment, { ...memory.actions, question })}`,
    ].filter(Boolean)).join("\n"),
    facts: valuableFacts(shipment, "pickup").slice(0, 3).map((item) => compact(item, 120)),
    actions: proposedActionsForShipment(shipment, { ...memory.actions, question }),
    items: [],
    plan: controlRoomPlan(shipment, { ...memory.actions, question }),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "pickup" },
  };
}

function shipmentCustomsAnswer(shipment, memory, question = "") {
  const gates = gateState(shipment);
  const broker = customsBrokerContact(shipment);
  const releaseFacts = valuableFacts(shipment, "release");
  const currentReleaseEvidence = gates.customsBrokerRelease
    ? (shipment.customsBroker?.evidence || [])
      .map((item) => `${item.label || ""}${item.note ? `: ${item.note}` : ""}`.trim())
      .find((item) => hasStrongCustomsReleaseText(item) || /\b(?:tms customs release|customs release\/DO is confirmed|release\/DO is confirmed|customs-cleared|customs released)\b/i.test(item))
    : "";
  const evidence = currentReleaseEvidence || releaseFacts[0] || shipment.customsBroker?.brokerStatus || shipment.clearanceStatus || "";
  let line = "Release/DO is not confirmed yet.";
  if (gates.customsBrokerRelease) {
    line = "Release/DO is confirmed.";
  } else if (gates.customsHold) {
    line = "Not released. Customs/government hold is still the blocker.";
  } else if (gates.brokerReleasePending) {
    line = "Not released yet. Broker release/DO is still pending.";
  }
  // A hold answer must say WHY — the state alone gives the operator nothing
  // to solve. Root cause comes from evidence; when it is genuinely absent the
  // gap itself is the answer.
  if (!gates.customsBrokerRelease) {
    const rootCause = shipmentRootCause(shipment);
    if (rootCause.cause) {
      line += ` Why: ${rootCause.cause}`;
    } else if (gates.customsHold) {
      line += " Why: not captured in evidence — the thread/PDF never states the reason; get the exact reject/hold reason from the broker.";
    }
  }
  return {
    title: shipment.awb,
    subtitle: [shipment.station, shipment.airline, "release"].filter(Boolean).join(" · "),
    answer: unique([
      line,
      broker.name || broker.email || broker.phone ? `Broker: ${[broker.name, broker.email, broker.phone].filter(Boolean).join(" · ")}.` : "",
      evidence ? `Evidence: ${compact(evidence, 120)}.` : "",
      `Now: ${actionRecommendation(shipment, { ...memory.actions, question })}`,
    ].filter(Boolean)).join("\n"),
    facts: releaseFacts.slice(0, 3).map((item) => compact(item, 120)),
    actions: proposedActionsForShipment(shipment, { ...memory.actions, question }),
    items: [],
    plan: controlRoomPlan(shipment, { ...memory.actions, question }),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "customs" },
  };
}

function shipmentLatestAnswer(shipment, memory) {
  const facts = unique([
    shipment.lastEmail?.summary,
    ...valuableFacts(shipment),
  ].filter(Boolean)).slice(0, 4);
  return {
    title: shipment.awb,
    subtitle: "Latest email memory",
    answer: unique([
      facts[0] ? `Latest: ${compact(facts[0], 130)}.` : "I do not see a latest email summary for this shipment yet.",
      facts[1] ? `Also: ${compact(facts[1], 120)}.` : "",
      `Now: ${actionRecommendation(shipment, memory.actions)}`,
    ].filter(Boolean)).join("\n"),
    facts: facts.slice(0, 3).map((item) => compact(item, 120)),
    actions: proposedActionsForShipment(shipment, memory.actions),
    items: [],
    plan: controlRoomPlan(shipment, memory.actions),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "latest" },
  };
}

function shipmentQuotesAnswer(shipment, memory) {
  const quoteDecision = quoteDecisionAction(shipment);
  const blast = quoteBlastLine(shipment, memory.actions);
  return {
    title: shipment.awb,
    subtitle: [shipment.station, "Last-mile pickup quotes"].filter(Boolean).join(" · "),
    answer: unique([
      blast,
      pickupQuoteDetailsLine(shipment, memory.actions),
      `Now: ${actionRecommendation(shipment, memory.actions)}`,
    ].filter(Boolean)).join("\n"),
    facts: (shipment.facts || [])
      .filter((fact) => /quote/i.test(`${fact.type || ""} ${fact.label || ""} ${fact.summary || ""}`))
      .slice(0, 3)
      .map((fact) => compact(`${fact.label || "Quote"} ${fact.summary || ""}`, 120)),
    actions: quoteDecision ? [quoteDecision] : proposedActionsForShipment(shipment, memory.actions),
    items: [],
    plan: controlRoomPlan(shipment, memory.actions),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "quotes" },
  };
}

function shipmentProblemEvidence(shipment) {
  const timeline = (shipment.timeline || [])
    .map((item) => Array.isArray(item) ? item.filter(Boolean).join(" ") : String(item || ""))
    .filter(Boolean);
  return unique([
    shipment.tms?.tmsStatus ? `TMS status ${shipment.tms.tmsStatus}${shipment.eta ? `; ETA ${shipment.eta}` : ""}` : "",
    shipment.detail || "",
    shipment.lastEmail?.summary ? `Latest memory: ${shipment.lastEmail.summary}` : "",
    ...timeline.map((line) => `Timeline: ${line}`),
    ...valuableFacts(shipment).slice(0, 3),
  ].filter(Boolean))
    .filter((item) => !/^\s*(?:unknown|waiting|not-arrived|pending):?\s*(?:unknown|waiting|not-arrived|pending)?\s*$/i.test(item))
    .slice(0, 4);
}

function shipmentProblemAnswer(shipment, memory, question = "") {
  const actionContext = { ...memory.actions, question };
  const plan = controlRoomPlan(shipment, actionContext);
  const evidence = shipmentProblemEvidence(shipment);
  return {
    title: shipment.awb,
    subtitle: [shipment.station, shipment.airline, compact(shipment.consignee || shipment.client, 46)].filter(Boolean).join(" · "),
    answer: unique([
      plan.problem || compactShipmentAnswer(shipment, actionContext),
      ...evidence.map((item) => `Evidence: ${compact(item, 150)}.`),
      `Now: ${plan.nextAction || actionRecommendation(shipment, actionContext)}`,
    ].filter(Boolean)).join("\n"),
    facts: evidence.map((item) => compact(item, 150)),
    actions: proposedActionsForShipment(shipment, actionContext),
    items: [],
    plan,
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "problem" },
  };
}

function shipmentActionAnswer(shipment, memory, question = "") {
  const actionContext = { ...memory.actions, question };
  if (questionRequestsDeliveryOrder(question)) {
    if (!deliveryOrderGenerationAllowed(shipment)) {
      const plan = controlRoomPlan(shipment, actionContext);
      return {
        title: shipment.awb,
        subtitle: "Delivery/POD work owns this shipment",
        answer: unique([
          compactShipmentAnswer(shipment, actionContext),
          "I will not generate a new delivery order because this shipment is already in pickup/delivery/POD follow-up.",
          `Now: ${plan.nextAction || actionRecommendation(shipment, actionContext) || "Track final delivery and collect POD."}`,
        ].filter(Boolean)).join("\n"),
        facts: [],
        actions: [],
        items: [],
        plan,
        shipments: [shipment],
        context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "action" },
      };
    }
    const action = deliveryOrderAction(shipment);
    return {
      title: shipment.awb,
      subtitle: "Delivery order PDF",
      answer: `I can generate the delivery order for ${displayAwb(shipment.awb)}.`,
      facts: [],
      actions: [action],
      items: [],
      plan: null,
      shipments: [shipment],
      context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "action" },
    };
  }
  if (questionRequestsCustomerUpdate(question)) {
    const action = customerUpdateAction(shipment);
    return {
      title: shipment.awb,
      subtitle: action.missing.length ? "Customer contact missing" : "Customer update draft",
      answer: unique([
        compactShipmentAnswer(shipment, actionContext),
        action.missing.length
          ? "I can draft this once we have the customer email."
          : "Ready to approve: Draft customer update.",
      ].filter(Boolean)).join("\n"),
      facts: [],
      actions: [action],
      items: [],
      plan: controlRoomPlan(shipment, actionContext),
      shipments: [shipment],
      context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "action" },
    };
  }
  if (gateState(shipment).completed) {
    const actions = proposedActionsForShipment(shipment, actionContext);
    return {
      title: shipment.awb,
      subtitle: actions.length ? "Delivered · Source backfill needed" : "Delivered",
      answer: compactShipmentAnswer(shipment, actionContext),
      facts: [],
      actions,
      items: [],
      plan: controlRoomPlan(shipment, actionContext),
      shipments: [shipment],
      context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "action" },
    };
  }
  const actions = proposedActionsForShipment(shipment, actionContext);
  const approvalActions = actions.filter((action) => action.channel !== "platform");
  const platformAlerts = actions.filter((action) => action.channel === "platform");
  const actionLine = approvalActions[0]
    ? `Ready to approve: ${approvalActions[0].label}.`
    : platformAlerts[0]
    ? `Needs operator attention: ${platformAlerts[0].label}. No email/TMS approval is queued from this ping.`
    : "I do not see a safe outbound action ready from memory right now.";
  return {
    title: shipment.awb,
    subtitle: approvalActions.length ? "Approval-ready action" : platformAlerts.length ? "Ops Brain alert" : "No action ready",
    answer: unique([
      compactShipmentAnswer(shipment, actionContext),
      actionLine,
    ].filter(Boolean)).join("\n"),
    facts: [],
    actions,
    items: [],
    plan: controlRoomPlan(shipment, actionContext),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "action" },
  };
}

function shipmentTopicAnswer(shipment, question, memory, topic, roleHint = "") {
  const actionContext = { ...memory.actions, question };
  if (topic === "contact") return shipmentContactAnswer(shipment, question, memory, roleHint);
  if (topic === "station") return shipmentStationAnswer(shipment, memory);
  if (topic === "pickup") return shipmentPickupAnswer(shipment, memory, question);
  if (topic === "customs") return shipmentCustomsAnswer(shipment, memory, question);
  if (topic === "latest") return shipmentLatestAnswer(shipment, memory);
  if (topic === "quotes") return shipmentQuotesAnswer(shipment, memory);
  if (topic === "problem") return shipmentProblemAnswer(shipment, memory, question);
  if (topic === "action") return shipmentActionAnswer(shipment, memory, question);
  if (topic === "cargo") {
    return {
      title: shipment.awb,
      subtitle: [shipment.station, shipment.airline, "Cargo details"].filter(Boolean).join(" · "),
      answer: unique([cargoLine(shipment) || "I do not have confirmed pieces/weight/dims in memory yet.", `Now: ${actionRecommendation(shipment, actionContext)}`]).join("\n"),
      facts: valuableFacts(shipment).slice(0, 2).map((item) => compact(item, 120)),
      actions: proposedActionsForShipment(shipment, actionContext),
      items: [],
      plan: controlRoomPlan(shipment, actionContext),
      shipments: [shipment],
      context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic: "cargo" },
    };
  }
  const actions = answerActionsForShipment(shipment, actionContext);
  const visibleActions = actions.length ? actions : currentRecommendedActionsForOperator(shipment);
  return {
    title: shipment.awb,
    subtitle: [shipment.station, shipment.airline, compact(shipment.consignee || shipment.client, 46)].filter(Boolean).join(" · "),
    answer: compactShipmentAnswer(shipment, actionContext),
    facts: valuableFacts(shipment, topic === "shipment" ? "" : topic).slice(0, 3).map((item) => compact(item, 120)),
    actions: visibleActions,
    items: [],
    plan: controlRoomPlan(shipment, actionContext),
    shipments: [shipment],
    context: { awb: normalizeAwb(shipment.awb), station: shipment.station || "", topic },
  };
}

function withShipmentPackets(answer, shipment, memory) {
  if (!shipment || !answer || typeof answer !== "object") return answer;
  const packetShipment = shipment.truthPacket && shipment.evidencePacket
    ? shipment
    : memory
      ? attachOperatorPackets([shipment], memory)[0] || shipment
      : shipment;
  return {
    ...answer,
    truthPacket: packetShipment.truthPacket || answer.truthPacket || null,
    evidencePacket: packetShipment.evidencePacket || answer.evidencePacket || null,
  };
}

function withAnswerQuestion(answer, question) {
  if (!answer || typeof answer !== "object") return answer;
  return {
    ...answer,
    context: {
      ...(answer.context || {}),
      question: compact(question, 180),
    },
  };
}

function companionMemoryRecordedLabel(entry = {}, now = new Date()) {
  const raw = entry.updatedAt || entry.createdAt || "";
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return "recorded time unknown";
  const ageHours = Math.max(0, (now.getTime() - at) / (60 * 60 * 1000));
  const age = ageHours < 1
    ? "less than 1h old"
    : ageHours < 48
      ? `${Math.round(ageHours)}h old`
      : `${Math.round(ageHours / 24)}d old`;
  return `recorded ${new Date(at).toISOString()} (${age})`;
}

function companionMemoryWarning(memory = {}) {
  const warnings = Array.isArray(memory.companionMemoryWarnings) ? memory.companionMemoryWarnings : [];
  if (!warnings.length) return "";
  return "Operator-context warning: companion-memory snapshot was unavailable; durable notes may be missing.";
}

function withCompanionMemoryContext(answer, shipment, memory = {}) {
  const context = shipment?.companionContext;
  if (!answer) return answer;
  const rows = context ? [
    ...(context.operatorNotes || []).map((entry) => ({ kind: "operator note", entry })),
    ...(context.resolvedConflicts || []).map((entry) => ({ kind: "resolved conflict", entry })),
    ...(context.alertStates || []).map((entry) => ({ kind: "alert state", entry })),
  ].slice(0, 3) : [];
  const warning = companionMemoryWarning(memory);
  if (!rows.length && !warning) return answer;
  const cited = rows.map(({ kind, entry }) => {
    const text = compact(entry.text || entry.summary || entry.reason || entry.status || kind, 150);
    return `${kind}: ${text} (${companionMemoryRecordedLabel(entry)})`;
  });
  return {
    ...answer,
    answer: [
      answer.answer,
      cited.length ? `Operator context (not a canonical-state override): ${cited.join(" · ")}` : "",
      warning,
    ].filter(Boolean).join("\n"),
    companionContext: {
      source: "companion-memory",
      snapshotTime: context?.snapshotTime || "",
      contextOnly: true,
      warning: warning || "",
      entries: rows.map(({ kind, entry }) => ({
        kind,
        id: entry.id || "",
        text: compact(entry.text || entry.summary || entry.reason || entry.status || "", 180),
        recordedAt: entry.updatedAt || entry.createdAt || "",
      })),
    },
  };
}

function shipmentAnswerWithQuestion(shipment, question, memory, topic, roleHint = "") {
  return withShipmentPackets(
    withCompanionMemoryContext(
      withAnswerQuestion(shipmentTopicAnswer(shipment, question, memory, topic, roleHint), question),
      shipment,
      memory,
    ),
    shipment,
    memory,
  );
}

function companyMemoryAnswer(question, memory) {
  const text = String(question || "");
  if (/\bnorman\b|bination/i.test(text)) {
    return {
      title: "Norman / Binational",
      subtitle: "ELP pickup memory",
      answer: `For ELP shipments, Norman/Binational handles pickup. Email ${ELP_PICKUP_BROKER.email}. Jordan usually sends him the alert/DO and often gets status by phone.`,
      facts: [],
      actions: [],
      items: [],
      shipments: [],
      context: { station: "ELP", topic: "company-memory" },
    };
  }
  if (/station details|station contact|phone|email|call/i.test(text)) {
    const station = stationFromQuestion(text, mergeShipments(memory, { attachPackets: false }));
    if (station) return contactAnswer(station, memory);
  }
  return null;
}

function deterministicAnswer(question, memory, history = [], context = {}) {
  const shipments = mergeShipments(memory, { attachPackets: false });
  const historyContext = contextFromHistory(history, shipments, context);
  const awbShipment = findShipment(memory, question, { shipments, attachPackets: false });
  const contextShipment = awbShipment || historyContext.shipment;
  const fleetIntent = questionHasFleetIntent(question);
  if (!fleetIntent && !isCompanyScopedQuestion(question, shipments, historyContext)) return outOfScopeAnswer();
  if (normalizeAwb(question) && !contextShipment) return unknownShipmentAnswer(question, memory);
  const companyAnswer = companyMemoryAnswer(question, memory);
  if (companyAnswer && !contextShipment) return companyAnswer;
  const topic = questionTopic(question, historyContext);
  const contactRoleHint = topic === "contact"
    ? contactRoleFromText(question) || historyContext.contactRole || ""
    : "";
  const directContextAwb = normalizeAwb(context?.awb || (!context?.list && Array.isArray(context?.shipmentIds) ? context.shipmentIds[0] : ""));
  const scopedShipmentQuestion = Boolean(
    contextShipment &&
      !awbShipment &&
      directContextAwb &&
      !fleetIntent
  );
  if (scopedShipmentQuestion) {
    return shipmentAnswerWithQuestion(contextShipment, question, memory, topic, contactRoleHint);
  }
  if (!awbShipment && historyContext.list && questionAsksForPriorList(question)) {
    return answerList(question, memory, {
      mode: historyContext.topic || listIntent(question),
      rows: historyContext.listShipments || [],
      station: historyContext.station || "",
      dateWindow: historyContext.dateWindow || null,
    });
  }
  if (!awbShipment && questionAsksForBoardReasoning(question)) {
    return boardReasoningAnswer(question, memory);
  }
  const countAnswer = !awbShipment ? answerCount(question, memory) : null;
  if (countAnswer) return countAnswer;
  if (!awbShipment && questionAsksForShipmentList(question)) return answerList(question, memory);
  if (topic === "contact" || /station details|station contact/i.test(question)) {
    const explicitStation = stationFromQuestion(question, shipments);
    if (contextShipment && !explicitStation) return shipmentAnswerWithQuestion(contextShipment, question, memory, topic, contactRoleHint);
    const station = explicitStation || contextShipment?.station || historyContext.station || "";
    if (station) return contactAnswer(station, memory);
  }
  // Explicitly fleet-shaped questions that do not belong to one of the
  // specialized branches above still resolve against the board. Without this
  // terminal guard, "whole board" / "all shipments" could fall through and
  // inherit historyContext.shipment despite defeating the first scope gate.
  if (!awbShipment && fleetIntent) return answerList(question, memory);
  if (contextShipment) {
    return shipmentAnswerWithQuestion(contextShipment, question, memory, topic, contactRoleHint);
  }
  return answerList(question, memory);
}

function requestRecordsFromMemory(memory = {}) {
  return {
    outbox: memory.outbox || memory.actions?.outbox || { requests: [] },
    outboxRequests: memory.actions?.outboxRequests || memory.outbox?.requests || [],
    actionQueue: memory.actions?.actionQueue || { actions: memory.actions?.actions || [] },
  };
}

function renderOperatorQueryAnswer(result) {
  if (!result) return null;
  if (result.kind === "handle-together") {
    const groups = result.groups || [];
    return {
      title: "Handle together",
      subtitle: "",
      answer: groups.length
        ? groups.map((group) => `${group.consignee || "Same consignee"} · ${group.station}: ${group.awbs.map(displayAwb).join(", ")} — one operational move.`).join("\n")
        : "No two active shipments currently share a consignee and station.",
      facts: [], actions: [],
      items: groups.flatMap((group) => (group.results || []).map((item) => ({
        awb: item.awb,
        station: item.station,
        consignee: item.consignee || "",
        state: item.state || "",
        stateCode: item.stateCode || "",
        reason: item.reason || "",
        action: item.nextMove || item.reason,
        freshness: item.freshness || "",
        source: item.source || "shipment-truth-packets",
      }))).slice(0, 12),
      shipments: groups.flatMap((group) => group.shipments).slice(0, 12),
      context: { topic: "query-handle-together", station: result.station || "", list: true, shipmentIds: groups.flatMap((group) => group.awbs.map((awb) => normalizeAwb(awb))).slice(0, 24) },
    };
  }
  const count = result.results?.length || 0;
  const unknownLine = result.unknown
    ? `I don't know — ${result.undatedCount} arrived shipment${result.undatedCount === 1 ? " has" : "s have"} no arrival timestamp in the evidence, so I can't place them in that window.`
    : "";
  const lineFor = (item) =>
    `${displayAwb(item.awb)} · ${item.station}${item.consignee ? ` · ${item.consignee}` : ""} — ${String(item.reason || "").replace(/[.\s]+$/g, "")}` +
    `${item.nextMove ? `; ${item.nextMove}` : ""} (${item.freshness})`;
  const title = result.kind === "station-inventory" ? `${result.station || "Across stations"} — ${count} shipment${count === 1 ? "" : "s"}`
    : result.kind === "stuck" ? `Stuck / blocked — ${count}`
    : result.kind === "arrived-window" ? `Arrivals — ${result.window} (${count})`
    : result.kind === "pod-missing" ? `Picked up, POD missing — ${count}`
    : `Arrived without a pickup broker — ${count}`;
  return {
    title,
    subtitle: "",
    answer: unknownLine || (!count ? "Nothing matches that in current truth." : result.results.map(lineFor).join("\n")),
    facts: [], actions: [],
    items: (result.results || []).map((item) => ({
      awb: item.awb,
      station: item.station,
      consignee: item.consignee || "",
      state: item.state || "",
      stateCode: item.stateCode || "",
      reason: item.reason || "",
      action: item.nextMove || item.reason,
      freshness: item.freshness || "",
      source: item.source || "shipment-truth-packets",
    })),
    shipments: (result.shipments || []).slice(0, 12),
    context: { topic: `query-${result.kind}`, station: result.station || "", list: true, shipmentIds: (result.results || []).map((item) => normalizeAwb(item.awb)).filter(Boolean).slice(0, 24) },
  };
}

function routedClarification(route = {}) {
  const scope = route.scope === "station" ? "station" : route.scope === "shipment" ? "AWB" : "operational slice";
  return {
    title: "One detail needed",
    subtitle: "Low-confidence semantic route",
    answer: `Which ${scope} do you mean, and are you asking for status, blockers, requests, or a comparison?`,
    facts: [], actions: [], items: [], shipments: [],
    context: { topic: "router-clarification" },
  };
}

function routedShipment(memory, route, context = {}) {
  const awb = normalizeAwb(route.awb || context.awb || (!context.list && context.shipmentIds?.[0]) || "");
  if (!awb) return null;
  const packetExists = (memory.truthPackets?.shipments || []).some((row) => normalizeAwb(row.awb || row.id) === awb);
  return packetExists ? findShipment(memory, awb, { attachPackets: false }) : null;
}

function explicitAwbsFromText(value) {
  return unique([...String(value || "").matchAll(/\b\d{3}[-\s]?\d{8}\b/g)].map((match) => normalizeAwb(match[0])).filter(Boolean));
}

function trustedRouteParameters(route, question, history, context, memory) {
  const packetRows = memory.truthPackets?.shipments || [];
  const historyContext = contextFromHistory(history, mergeShipments(memory, { attachPackets: false }), context);
  const questionAwbs = explicitAwbsFromText(question);
  const fleetIntent = questionHasFleetIntent(question);
  const directContextAwb = fleetIntent ? "" : normalizeAwb(context?.awb || (!context?.list && context?.shipmentIds?.[0]) || "");
  const historyAwb = fleetIntent ? "" : normalizeAwb(historyContext.awb || historyContext.shipment?.awb || "");
  const trustedAwbs = unique([...questionAwbs, directContextAwb, historyAwb].filter(Boolean));
  const requestedAwb = normalizeAwb(route.awb || "");
  const awb = requestedAwb
    ? (trustedAwbs.includes(requestedAwb) ? requestedAwb : trustedAwbs.length === 1 ? trustedAwbs[0] : "")
    : (route.scope === "shipment" && trustedAwbs.length === 1 ? trustedAwbs[0] : "");

  const questionStation = stationFromQuestion(question, packetRows);
  const contextStation = fleetIntent ? "" : String(context?.station || "").toUpperCase();
  const historyStation = fleetIntent ? "" : String(historyContext.station || "").toUpperCase();
  const trustedStations = unique([questionStation, contextStation, historyStation].filter(Boolean));
  const requestedStation = String(route.station || "").toUpperCase();
  const station = requestedStation
    ? (trustedStations.includes(requestedStation) ? requestedStation : trustedStations.length === 1 ? trustedStations[0] : "")
    // Backfill the station whenever the question unambiguously names exactly one,
    // regardless of route.scope — a fleet/open-analytical question ("which LA
    // shipments…") is still station-scoped. Trust-gating above still blocks a
    // model-invented station not grounded in the question/context/history.
    : (trustedStations.length === 1 ? trustedStations[0] : "");
  const contextualShipmentIds = fleetIntent ? [] : unique([
    ...(Array.isArray(context?.shipmentIds) ? context.shipmentIds : []),
    ...(Array.isArray(historyContext.shipmentIds) ? historyContext.shipmentIds : []),
  ].map(normalizeAwb).filter(Boolean));
  const refersToGroup = questionAwbs.length > 1 || /\b(?:compare|between|among|both|those|these|them|the\s+two)\b/i.test(question);
  const authoritativeGroup = questionAwbs.length > 1
    ? questionAwbs
    : refersToGroup && contextualShipmentIds.length > 1
      ? contextualShipmentIds
      : [];
  const shipmentIds = authoritativeGroup.length
    ? authoritativeGroup
    : unique([...contextualShipmentIds, ...questionAwbs]);
  const scope = fleetIntent
    ? (questionStation ? "station" : "fleet")
    : authoritativeGroup.length > 1
      ? "group"
      : route.scope;
  const filters = trustedRouteFilters(route.filters, question, history);
  return { ...route, scope, awb, station, shipmentIds, filters };
}

function rowsForRoute(rows, route = {}) {
  let scoped = Array.isArray(rows) ? rows : [];
  if (route.scope === "shipment" && route.awb) {
    scoped = scoped.filter((row) => normalizeAwb(row.awb || row.id) === normalizeAwb(route.awb));
  }
  if (route.station) {
    const station = String(route.station).toUpperCase();
    scoped = scoped.filter((row) => String(row.station || "").toUpperCase() === station);
  }
  if (route.scope === "group") {
    const wanted = new Set((route.shipmentIds || []).map(normalizeAwb).filter(Boolean));
    scoped = scoped.filter((row) => wanted.has(normalizeAwb(row.awb || row.id)));
  }
  return scoped;
}

function routedStructuredSpec(route = {}) {
  switch (route.intent) {
    case "stuck": return { kind: "stuck", station: route.station || "" };
    case "arrived-window": return { kind: "arrived-window", window: route.filters?.window || route.filters?.timeWindow || "today", station: route.station || "" };
    case "pod-missing": return { kind: "pod-missing", station: route.station || "" };
    case "arrived-no-broker": return { kind: "arrived-no-broker", station: route.station || "" };
    case "handle-together": return { kind: "handle-together", station: route.station || "" };
    default: return null;
  }
}

function executeRoutedDeterministic(route, question, memory, history, context) {
  const rows = memory.truthPackets?.shipments || [];
  const scopedRows = rowsForRoute(rows, route);
  const structured = routedStructuredSpec(route);
  if (structured) return renderOperatorQueryAnswer(opsQuery.runOperatorQuery(structured, scopedRows, new Date()));
  if (route.intent === "out-of-scope") return outOfScopeAnswer();
  const shipment = route.scope === "shipment" ? routedShipment(memory, route, context) : null;
  if (["status", "next-action", "blocker-why", "contacts", "eta", "pod", "cargo", "last-outbound"].includes(route.intent) && route.scope === "shipment" && !shipment) {
    return routedClarification(route);
  }
  if (["waiting-on", "unanswered-requests", "needs-customer-update", "last-outbound", "what-changed", "blocker-why"].includes(route.intent)) {
    const forced = {
      "needs-customer-update": "customer-needed",
      "what-changed": "changed",
    }[route.intent] || route.intent;
    const answer = coworkerAnswer({
      question,
      rows: scopedRows,
      gmailProof: memory.gmailProof,
      requestRecords: requestRecordsFromMemory(memory),
      shipment,
      intent: forced,
      now: new Date(),
    });
    return answer && route.station
      ? { ...answer, context: { ...(answer.context || {}), station: route.station } }
      : answer;
  }
  if (route.intent === "contacts" && route.scope === "station") {
    return route.station ? contactAnswer(route.station, memory) : routedClarification(route);
  }
  if (shipment) {
    const topic = {
      status: "shipment",
      "next-action": "action",
      contacts: "contact",
      eta: "arrival",
      pod: "pod",
      cargo: "cargo",
      "storage-risk": "fees",
      quotes: "quotes",
    }[route.intent] || "shipment";
    return shipmentAnswerWithQuestion(shipment, question, memory, topic);
  }
  const listMode = {
    urgent: "urgent",
    "out-for-delivery": "delivery",
    eta: "arrival",
    pod: "pod",
    "storage-risk": "storage",
    quotes: "quotes",
  }[route.intent];
  if (listMode) {
    const windowText = route.filters?.window || (route.intent === "urgent" ? "today" : question);
    return answerList(question, memory, {
      mode: listMode,
      rows: route.scope === "fleet" && !route.station ? undefined : scopedRows,
      station: route.station || "",
      dateWindow: questionDateWindow(windowText),
    });
  }
  if (["status", "next-action"].includes(route.intent) && route.scope !== "shipment") {
    return answerList(question, memory, {
      mode: route.station && route.intent === "status" ? "station-open" : "urgent",
      rows: scopedRows,
      station: route.station || "",
    });
  }
  if (route.intent === "status") return deterministicAnswer(question, memory, history, context);
  return routedClarification(route);
}

function normalizedRouteFilter(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function trustedRouteFilters(filters = {}, question = "", history = []) {
  const sourceText = normalizedRouteFilter([
    question,
    ...(Array.isArray(history) ? history.slice(-4).map((message) => messageText(message)) : []),
  ].join(" "));
  const paddedSource = ` ${sourceText} `;
  const trusted = {};
  for (const key of ["window", "state", "risk", "client", "consignee"]) {
    const raw = typeof filters?.[key] === "string" ? filters[key] : "";
    const value = normalizedRouteFilter(raw);
    if (!value) continue;
    const aliases = key === "risk" && value === "blocked"
      ? ["blocked", "stuck", "jammed", "on hold"]
      : key === "state" && value === "customs hold"
        ? ["customs hold", "held at customs"]
        : [value];
    if (aliases.some((alias) => paddedSource.includes(` ${alias} `))) trusted[key] = raw;
  }
  return trusted;
}

function analyticalDateWindow(value, now = new Date()) {
  const text = normalizedRouteFilter(value);
  if (!text) return null;
  const standard = questionDateWindow(text, now);
  if (standard) return standard;
  if (text === "yesterday") {
    const day = addDaysOperatorDateKey(now, -1);
    return { start: day, end: day, label: "yesterday" };
  }
  if (text === "week" || text === "this week" || text === "current week") {
    const daysSinceMonday = (operatorWeekday(now) + 6) % 7;
    return {
      start: addDaysOperatorDateKey(now, -daysSinceMonday),
      end: addDaysOperatorDateKey(now, 6 - daysSinceMonday),
      label: "this week",
    };
  }
  return null;
}

function analyticalWindowMatches(row, windowValue, riskValue, memory, now = new Date()) {
  const window = analyticalDateWindow(windowValue, now);
  if (!window) return true;
  const storage = storageTiming(row, memory);
  const risk = normalizedRouteFilter(riskValue);
  if (/storage/.test(risk)) {
    if (!storageListCandidate(row, memory)) return false;
    const storageKeys = [storage.starts, storage.lfd, storage.accruing].map((value) => parsedDateKey(value, now)).filter(Boolean);
    return storage.active || storage.dueSoon || !storageKeys.length || storageKeys.some((key) => dateKeyInWindow(key, window));
  }
  const state = normalizedRouteFilter(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || row.opsState?.phase || "");
  if (!/arriv|pickup|delivery|delivered/.test(state)) return true;
  const gates = gateState(row);
  const keys = unique([
    arrivalPlanningDateKey(row),
    pickupDateKey(row),
    gates.deliveryScheduledDate,
    resolveShipmentState(row).deliveryScheduledDate,
  ].filter(Boolean));
  return keys.some((key) => dateKeyInWindow(key, window));
}

function analyticalFilterMatches(row, filters = {}, memory, now = new Date()) {
  const state = normalizedRouteFilter(filters.state);
  const client = normalizedRouteFilter(filters.client);
  const consignee = normalizedRouteFilter(filters.consignee);
  const risk = normalizedRouteFilter(filters.risk);
  const canonicalState = normalizedRouteFilter(row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || row.opsState?.phase || "");
  const clientValues = [row.client, row.customer, row.account].map(normalizedRouteFilter).filter(Boolean);
  const consigneeValues = [row.consignee, row.delivery?.consignee].map(normalizedRouteFilter).filter(Boolean);
  if (state) {
    const matchesState = /^(?:blocked|stuck)$/.test(state) ? opsQuery.rowBlocked(row) : canonicalState === state;
    if (!matchesState) return false;
  }
  if (client && !clientValues.includes(client)) return false;
  if (consignee && !consigneeValues.includes(consignee)) return false;
  if (risk) {
    const canonicalRisk = shipmentOperationalRisk(row);
    const matchesRisk = /storage/.test(risk)
      ? storageListCandidate(row, memory)
      : /stuck|blocked/.test(risk)
        ? opsQuery.rowBlocked(row)
        : /urgent|high|critical/.test(risk)
          ? operationalRiskCandidate(row, memory)
          : [canonicalRisk.level, canonicalRisk.type].map(normalizedRouteFilter).includes(risk);
    if (!matchesRisk) return false;
  }
  return analyticalWindowMatches(row, filters.window, risk, memory, now);
}

function retrieveAnalyticalRows(route, question, memory, context = {}) {
  const packetRows = (memory.truthPackets?.shipments || []).filter((row) => !row.truthPacketRole || row.truthPacketRole === "active");
  let rows = rowsForRoute(packetRows, route);
  const explicitAwbs = explicitAwbsFromText(question);
  if (explicitAwbs.length) {
    const wanted = new Set(explicitAwbs);
    rows = rows.filter((row) => wanted.has(normalizeAwb(row.awb || row.id)));
  }
  return rows
    .filter((row) => analyticalFilterMatches(row, route.filters || {}, memory))
    .slice(0, 12);
}

function analyticalEvidence(rows, memory) {
  const citations = [];
  const actions = [];
  let sequence = 1;
  const add = (row, text, sourceType, sourceName) => {
    const value = compact(text, 260);
    if (!value || citations.length >= 48) return;
    citations.push({ id: `C${sequence++}`, awb: displayAwb(row.awb), text: value, sourceType, sourceName });
  };
  // Reserve one canonical-state citation for every retrieved row before the
  // shared cap is spent on richer detail. A 12-row answer must never contain
  // uncitable rows merely because earlier rows had many gates/facts.
  for (const row of rows) {
    const packet = row.truthPacket || {};
    add(row, `Current packet state: ${opsQuery.statePhrase(packet.resolvedCurrentState || packet.currentState || row.currentState || row.opsState?.phase || "unknown")}.`, "shipment-truth-packet", `shipment-truth-packets/${displayAwb(row.awb)}`);
  }
  for (const row of rows) {
    const blocker = row.truthPacket?.operationalBlocker;
    if (!blocker) continue;
    add(
      row,
      `Operational blocker: ${opsQuery.statePhrase(blocker.type || blocker.status || "active")}. ${blocker.reason || blocker.summary || blocker.evidence || ""}`,
      "shipment-truth-packet-blocker",
      `shipment-truth-packets/${displayAwb(row.awb)}/operational-blocker`,
    );
  }
  const asEvidenceList = (value) => Array.isArray(value) ? value : value == null ? [] : [value];
  const uncertaintyFor = (row) => [
    ...asEvidenceList(row.truthPacket?.unknowns),
    ...asEvidenceList(row.evidencePacket?.unknowns),
  ];
  const contradictionsFor = (row) => [
    ...asEvidenceList(row.truthPacket?.contradictions),
    ...asEvidenceList(row.evidencePacket?.contradictions),
  ];
  const evidenceText = (value) => typeof value === "string"
    ? value
    : value?.summary || value?.reason || value?.claim || value?.text || value?.description || JSON.stringify(value || "");
  for (let index = 0; index < 2; index += 1) {
    for (const row of rows) {
      const unknown = uncertaintyFor(row)[index];
      if (unknown == null) continue;
      add(row, `Named uncertainty: ${evidenceText(unknown)}`, "shipment-truth-packet-unknown", `shipment-truth-packets/${displayAwb(row.awb)}/unknown-${index + 1}`);
    }
  }
  for (let index = 0; index < 2; index += 1) {
    for (const row of rows) {
      const contradiction = contradictionsFor(row)[index];
      if (contradiction == null) continue;
      add(row, `Named contradiction: ${evidenceText(contradiction)}`, "shipment-truth-packet-contradiction", `shipment-truth-packets/${displayAwb(row.awb)}/contradiction-${index + 1}`);
    }
  }
  for (let index = 0; index < 4; index += 1) {
    for (const row of rows) {
      const gate = (row.truthPacket?.gates || [])[index];
      if (!gate) continue;
      add(row, `${gate.gate}: ${gate.status || "unknown"}. ${gate.reason || gate.evidence || gate.summary || ""}`, "shipment-truth-packet-gate", `shipment-truth-packets/${displayAwb(row.awb)}/${gate.gate}`);
    }
  }
  for (let index = 0; index < 4; index += 1) {
    for (const row of rows) {
      const fact = (row.evidencePacket?.sourceFacts || [])[index];
      if (!fact) continue;
      const type = fact.sourceType || fact.source || fact.type || "packet-derived-proof";
      const name = fact.sourceName || fact.sourceRef || fact.subject || fact.label || fact.messageId || `${displayAwb(row.awb)} evidence`;
      add(row, fact.claim || fact.summary || fact.evidence || fact.text || fact.label, type, compact(name, 100));
    }
  }
  for (const row of rows) {
    for (const action of proposedActionsForShipment(row, memory.actions).filter(isCanonicalPlannerAction).slice(0, 3)) {
      if (!actions.some((item) => item.id === action.id)) actions.push(action);
    }
  }
  return { citations, actions: actions.slice(0, 12) };
}

const ANALYTICAL_STOP_WORDS = new Set("a an and are as at awb be being by current evidence for from has have in into is it its of on or packet source state the this to us was we were with shipment shipments about after again against also among because before between could just more most other over same should some such than that their them then there these they those through under very what when where which while will would your".split(" "));

function significantWords(value) {
  return new Set(String(value || "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)?.filter((word) => !ANALYTICAL_STOP_WORDS.has(word)) || []);
}

function analyticalClaimLooksLikeAction(value) {
  const text = String(value || "").trim();
  if (/\b(?:should|must|recommend|next\s+(?:move|step|action)|need(?:s)?\s+to|have\s+to)\b/i.test(text)) return true;
  if (/\b(?:will|can|could|may)\s+(?:call|send|chase|pay|book|escalate|draft|ask|follow|notify|contact|email|message|request|reply|dispatch|reach|coordinate|pursue|check|confirm|obtain|provide|schedule|arrange|push|monitor|review|verify|wait)\b/i.test(text)) return true;
  if (/\b(?:follow[- ]?up|call|email|message|request|reply|dispatch|review|check)\b.{0,24}\b(?:needed|required|recommended|next)\b/i.test(text)) return true;
  if (/^(?:please\s+)?(?:call|send|chase|pay|book|escalate|draft|ask|follow(?:\s+up)?|notify|reach\s+out|coordinate|pursue|check\s+with|confirm|ensure|obtain|provide|schedule|arrange|push|monitor|review|verify|wait)\b/i.test(text)) return true;
  return /^(?:please\s+)?(?:contact|email|message|request|reply|dispatch)\s+(?!(?:is|was|were|has|have|remains?|appears?|shows?)\b)/i.test(text);
}

function directionalClaimSupported(claimText, cited) {
  const normalizedClaim = normalizedRouteFilter(claimText);
  const evidenceText = cited.map((citation) => `${citation.awb} ${citation.text}`).join(" ");
  if (normalizedRouteFilter(evidenceText).includes(normalizedClaim)) return true;
  const claimAwbs = explicitAwbsFromText(claimText);
  if (claimAwbs.length !== 2) return false;
  const evidenceFor = (awb) => cited
    .filter((citation) => normalizeAwb(citation.awb) === awb)
    .map((citation) => citation.text)
    .join(" ");
  const leftEvidence = evidenceFor(claimAwbs[0]);
  const rightEvidence = evidenceFor(claimAwbs[1]);
  if (!leftEvidence || !rightEvidence) return false;
  const wantsHigher = /\b(?:higher|more|most|likelier|likely)\b/i.test(claimText);
  const wantsLower = /\b(?:lower|less|least)\b/i.test(claimText);
  if (wantsHigher === wantsLower) return false;
  const storageDate = (value) => {
    const match = String(value || "").match(/\b(?:storage(?:\s+risk)?\s+(?:starts?|begins?|accrues?)|last\s+free(?:\s+day)?|lfd)\b[^\d]{0,24}(\d{4}-\d{2}-\d{2})/i);
    const parsed = match ? Date.parse(`${match[1]}T00:00:00Z`) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const leftStorageDate = storageDate(leftEvidence);
  const rightStorageDate = storageDate(rightEvidence);
  if (leftStorageDate != null && rightStorageDate != null && leftStorageDate !== rightStorageDate) {
    return wantsHigher ? leftStorageDate < rightStorageDate : leftStorageDate > rightStorageDate;
  }
  const score = (value) => {
    const match = String(value || "").match(/\b(?:urgency|risk\s+score)\b[^\d]{0,16}(\d+(?:\.\d+)?)/i);
    const number = match ? Number(match[1]) : NaN;
    return Number.isFinite(number) ? number : null;
  };
  const leftScore = score(leftEvidence);
  const rightScore = score(rightEvidence);
  if (leftScore != null && rightScore != null && leftScore !== rightScore) {
    return wantsHigher ? leftScore > rightScore : leftScore < rightScore;
  }
  return false;
}

function groundedSentenceRows(sentences = []) {
  return (Array.isArray(sentences) ? sentences : []).flatMap((item) => {
    const text = String(item?.text || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const parts = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    return (parts.length ? parts : [text]).map((part) => ({
      ...item,
      text: part,
      citationIds: Array.isArray(item?.citationIds) ? item.citationIds : [],
    }));
  });
}

function verifyGroundedProse(sentences, citations = [], options = {}) {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  const accepted = [];
  const submitted = options.splitSentences === false
    ? (Array.isArray(sentences) ? sentences : []).filter((item) => String(item?.text || "").trim())
    : groundedSentenceRows(sentences);
  for (const claim of submitted) {
    const citationIds = Array.isArray(claim.citationIds) ? claim.citationIds.filter(Boolean) : [];
    const cited = citationIds.map((id) => byId.get(id)).filter(Boolean);
    const rawClaimText = String(claim.text || "").replace(/\s+/g, " ").trim();
    const claimText = stripProviderLeakText(claim.text);
    if (!rawClaimText || !claimText || !cited.length || cited.length !== citationIds.length) continue;
    if (/\b(?:openai|chatgpt|gpt-\w*|provider|system prompt|api key|ai|assistant|language model)\b/i.test(rawClaimText)) continue;
    if (analyticalClaimLooksLikeAction(claimText)) continue;
    const evidenceText = cited.map((citation) => `${citation.awb} ${citation.text}`).join(" ");
    const claimNegates = /\b(?:no|not|never|without|cannot|can't|isn't|aren't|wasn't|weren't|doesn't|didn't|won't)\b/i.test(claimText);
    // A negative claim is public only when its normalized text is stated
    // verbatim in cited evidence. This binds polarity to the same predicate;
    // a different negative sentence in that citation cannot authorize it.
    const normalizedNegativeClaim = normalizedRouteFilter(claimText.replace(/\b\d{3}[-\s]?\d{8}\b/g, ""));
    if (claimNegates && (!normalizedNegativeClaim || !normalizedRouteFilter(evidenceText).includes(normalizedNegativeClaim))) continue;
    const unsupportedNumber = (claimText.match(/\b\d+(?:\.\d+)?\b/g) || []).some((number) => !evidenceText.includes(number));
    const claimWords = significantWords(claimText);
    const evidenceWords = significantWords(evidenceText);
    const overlap = [...claimWords].filter((word) => evidenceWords.has(word)).length;
    const directionalClaim = /\b(?:higher|lower|more|less|most|least|likelier|likely|compared|versus|than)\b/i.test(claimText);
    const directionalEvidence = directionalClaim && directionalClaimSupported(claimText, cited);
    if (directionalClaim && !directionalEvidence) continue;
    const analyticalWords = new Set(["because", "remains", "currently"]);
    if (directionalClaim && directionalEvidence) {
      for (const word of ["higher", "lower", "more", "less", "most", "least", "likelier", "likely", "compared", "versus", "than"]) analyticalWords.add(word);
    }
    const unsupportedWords = [...claimWords].filter((word) => !evidenceWords.has(word) && !analyticalWords.has(word));
    if (unsupportedNumber || (claimWords.size >= 2 && overlap < 2) || unsupportedWords.length > 0) continue;
    accepted.push({ ...claim, text: claimText, citations: cited });
  }
  return accepted;
}

function validatedAnalyticalClaims(synthesis, citations) {
  const submitted = (Array.isArray(synthesis?.claims) ? synthesis.claims : []).filter((item) => String(item?.text || "").trim());
  const accepted = verifyGroundedProse(submitted, citations, { splitSentences: false });
  return { accepted, rejected: Math.max(0, submitted.length - accepted.length) };
}

const COMPANION_NARRATIVE_SCOPES = new Set(["shipment", "fleet", "station", "group"]);
const COMPANION_NARRATIVE_CACHE_VERSION = "companion-narrative-v1";

function companionNarrativeFeatureRequested(env = process.env) {
  return env.PIKIIO_OPS_BRAIN_NARRATIVE_ENABLED === "1" || env.PQ_OPS_BRAIN_NARRATIVE_ENABLED === "1";
}

function companionNarrativeScope(answer = {}, override = "") {
  const explicit = String(override || "").trim().toLowerCase();
  if (COMPANION_NARRATIVE_SCOPES.has(explicit)) return explicit;
  const context = answer.context || {};
  const answerAwb = normalizeAwb(context.awb || "");
  const itemAwbs = unique((answer.items || []).map((item) => normalizeAwb(item?.awb || item?.id)).filter(Boolean));
  const shipmentAwbs = unique((answer.shipments || []).map((shipment) => normalizeAwb(shipment?.awb || shipment?.id)).filter(Boolean));
  const awbs = unique([answerAwb, ...itemAwbs, ...shipmentAwbs].filter(Boolean));
  if (answerAwb || (!context.list && awbs.length === 1)) return "shipment";
  if (context.station) return "station";
  if (context.scope === "group" || context.groupId) return "group";
  return "fleet";
}

function companionNarrativeScopeKeys(answer = {}, scope = companionNarrativeScope(answer)) {
  const keys = [scope];
  const answerAwbs = companionNarrativeAnswerAwbs(answer);
  const awb = normalizeAwb(answer.context?.awb || (answerAwbs.length === 1 ? answerAwbs[0] : ""));
  const station = String(answer.context?.station || "").trim().toLowerCase();
  if (scope === "shipment" && awb) keys.push(`shipment:${awb}`);
  if (scope === "station" && station) keys.push(`station:${station}`);
  return unique(keys);
}

function companionNarrativeEnabled(answer = {}, env = process.env, scopeOverride = "") {
  if (!companionNarrativeFeatureRequested(env)) return false;
  const rawAllowlist = String(env.PIKIIO_OPS_BRAIN_NARRATIVE_SCOPES || env.PQ_OPS_BRAIN_NARRATIVE_SCOPES || "").trim();
  if (!rawAllowlist) return true;
  const allowed = new Set(rawAllowlist.split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (allowed.has("all") || allowed.has("*")) return true;
  const scope = companionNarrativeScope(answer, scopeOverride);
  return companionNarrativeScopeKeys(answer, scope).some((key) => allowed.has(key));
}

function companionNarrativeAnswerAwbs(answer = {}) {
  const itemAwbs = unique((answer.items || []).map((item) => normalizeAwb(item?.awb || item?.id)).filter(Boolean));
  if (itemAwbs.length) return itemAwbs.slice(0, 12);
  return unique([
    normalizeAwb(answer.context?.awb || ""),
    ...(answer.shipments || []).map((shipment) => normalizeAwb(shipment?.awb || shipment?.id)),
  ].filter(Boolean)).slice(0, 12);
}

function companionNarrativeRows(answer = {}, memory = {}) {
  const wanted = new Set(companionNarrativeAnswerAwbs(answer));
  if (!wanted.size) return [];
  return (memory.truthPackets?.shipments || [])
    .filter((row) => wanted.has(normalizeAwb(row.awb || row.id)))
    .slice(0, 12);
}

function companionNarrativeCounterpartyRole(answer = {}) {
  const explicit = compact(answer.context?.contactRole || answer.context?.counterpartyRole || "", 60);
  if (explicit) return explicit;
  const topic = String(answer.context?.topic || "").toLowerCase();
  if (/customs|release|clearance/.test(topic)) return "customs broker";
  if (/pickup|quote|dispatch|delivery|pod/.test(topic)) return "pickup broker";
  if (/station|arrival|contact/.test(topic)) return "station";
  return "";
}

function companionNarrativeStructuredFacts(answer = {}) {
  const publicAnswer = publicBrainAnswer(answer);
  const itemByAwb = new Map((publicAnswer.items || []).map((item) => [normalizeAwb(item?.awb || item?.id), item]));
  const shipmentByAwb = new Map((publicAnswer.shipments || []).map((shipment) => [normalizeAwb(shipment?.awb || shipment?.id), shipment]));
  const answerAwbs = companionNarrativeAnswerAwbs(publicAnswer);
  const role = companionNarrativeCounterpartyRole(publicAnswer);
  return answerAwbs.map((awbKey) => {
    const item = itemByAwb.get(awbKey) || {};
    const shipment = shipmentByAwb.get(awbKey) || {};
    const answerPacket = normalizeAwb(publicAnswer.context?.awb || "") === awbKey ? publicAnswer.truthPacket || {} : {};
    const packet = Object.keys(answerPacket).length ? answerPacket : shipment.truthPacket || {};
    const stateCode = item.stateCode || packet.resolvedCurrentState || packet.currentState || (answerAwbs.length === 1 ? publicAnswer.plan?.phase : "") || "";
    const nextMove = item.action || (answerAwbs.length === 1
      ? publicAnswer.plan?.nextAction || publicAnswer.nextAction || packet.nextAction?.summary || packet.nextAction?.label || ""
      : "");
    return {
      awb: displayAwb(awbKey),
      state: compact(item.state || opsQuery.statePhrase(stateCode), 100),
      counterpartyRole: compact(item.counterpartyRole || item.owner || role, 60),
      nextMove: compact(nextMove, 140),
      age: compact(item.age || item.freshness || "", 80),
      source: compact(item.source || "shipment-truth-packets", 80),
    };
  }).filter((fact) => fact.awb && fact.state);
}

function companionNarrativeCitations(answer = {}, memory = {}, rows = [], facts = []) {
  const structured = facts.map((fact, index) => ({
    id: `N${index + 1}`,
    awb: fact.awb,
    text: [
      `AWB ${fact.awb}.`,
      `State: ${fact.state}.`,
      fact.counterpartyRole ? `Counterparty role: ${fact.counterpartyRole}.` : "",
      fact.nextMove ? `Next move: ${fact.nextMove}.` : "",
      fact.age ? `Age: ${fact.age}.` : "",
      fact.source ? `Source: ${fact.source}.` : "",
    ].filter(Boolean).join(" "),
    sourceType: "deterministic-companion-answer",
    sourceName: fact.source || "shipment-truth-packets",
  }));
  const evidenceBudget = Math.max(0, 48 - structured.length);
  const evidence = analyticalEvidence(rows, memory).citations.slice(0, evidenceBudget);
  return [...structured, ...evidence];
}

function companionNarrativePrompt(facts = [], citations = []) {
  return {
    task: "Write optional non-load-bearing framing for an already-computed deterministic operations answer.",
    voice: {
      style: "sharp ops colleague",
      cadence: "terse, freight-fluent, present tense",
      length: "one to three short sentences",
    },
    facts,
    citations: citations.map((citation) => ({
      id: citation.id,
      awb: citation.awb || "",
      text: compact(citation.text, 260),
      sourceType: compact(citation.sourceType, 80),
      sourceName: compact(citation.sourceName, 100),
    })),
    rules: [
      "Use only the supplied facts and citations; do not infer or add any operational fact.",
      "Cite every sentence with one or more citation IDs that directly prove every word in that sentence.",
      "Add no AWB, number, amount, date, time, age, or negation unless it appears in the cited text.",
      "Do not issue an instruction, action, recommendation, promise, or next step.",
      "Reuse the citations' operational wording instead of introducing synonyms.",
      "Return an empty sentences array if one to three fully supported sentences cannot be written.",
    ],
  };
}

async function composeCompanionNarrative(deterministicAnswer, citations, opts = {}) {
  const env = opts.env || process.env;
  const scope = companionNarrativeScope(deterministicAnswer, opts.scope);
  if (!companionNarrativeEnabled(deterministicAnswer, env, scope)) return { narrative: "", skipped: "feature-off", rejected: 0 };
  const facts = Array.isArray(opts.facts) ? opts.facts : [];
  if (!facts.length || !Array.isArray(citations) || !citations.length) return { narrative: "", skipped: "no-evidence", rejected: 0 };
  const runtime = opts.modelRuntime || createOpsBrainModelRuntime({
    env,
    spendStore: defaultOpsBrainSpendStore(env),
    spendHealth: opsBrainSpendHealth,
  });
  if (!runtime || typeof runtime.composeNarrative !== "function" || typeof runtime.createQuestionBudget !== "function") {
    return { narrative: "", skipped: "runtime-unavailable", rejected: 0 };
  }
  const budget = opts.modelBudget || runtime.createQuestionBudget();
  const baseCacheKey = String(opts.cacheKey || "");
  const cacheKey = baseCacheKey ? `${COMPANION_NARRATIVE_CACHE_VERSION}|${scope}|${baseCacheKey}` : "";
  const cacheAllowed = modelCacheAllowed(env, runtime);
  if (cacheKey && cacheAllowed) {
    const cached = modelCacheGet(cacheKey, env);
    if (cached && typeof cached.narrative === "string") {
      return { narrative: cached.narrative, skipped: cached.narrative ? "" : "fully-rejected", rejected: Number(cached.rejected || 0), cacheHit: true };
    }
  }
  const callsBefore = Number(budget.calls || 0);
  try {
    const result = await runtime.composeNarrative(companionNarrativePrompt(facts, citations), budget);
    if (result.skipped) {
      if (cacheKey && cacheAllowed && Number(budget.calls || 0) > callsBefore) modelCacheSet(cacheKey, { narrative: "", rejected: 0 });
      return { narrative: "", skipped: result.skipped, rejected: 0 };
    }
    const submitted = groundedSentenceRows(result.narrative?.sentences || []);
    const accepted = verifyGroundedProse(submitted, citations);
    const narrative = unique(accepted.map((sentenceRow) => sentenceRow.text).filter(Boolean)).slice(0, 3).join(" ");
    const rejected = Math.max(0, submitted.length - accepted.length);
    if (cacheKey && cacheAllowed) modelCacheSet(cacheKey, { narrative, rejected });
    return { narrative, skipped: narrative ? "" : "fully-rejected", rejected, model: result.model || "" };
  } catch {
    return { narrative: "", skipped: "composer-error", rejected: 0 };
  }
}

async function answerWithCompanionNarrative({ answer, question, history, context, memory, env, modelRuntime, modelBudget }) {
  if (!companionNarrativeFeatureRequested(env) || !companionNarrativeEnabled(answer, env)) return answer;
  if (answer.clarification || /(?:clarification|operator-truth-not-recorded|unknown-shipment|out-of-scope|local-error)/i.test(String(answer.context?.topic || ""))) return answer;
  const rows = companionNarrativeRows(answer, memory);
  const facts = companionNarrativeStructuredFacts(answer);
  const citations = companionNarrativeCitations(answer, memory, rows, facts);
  if (!facts.length || !citations.length) return answer;
  const composed = await composeCompanionNarrative(answer, citations, {
    env,
    facts,
    modelRuntime,
    modelBudget,
    cacheKey: opsBrainAnswerCacheKey(question, context, memory, history, env),
  });
  return composed.narrative ? { ...answer, narrative: composed.narrative } : answer;
}

function analyticalSourceFreshness(memory = {}, rows = [], env = process.env, now = new Date()) {
  const warnings = unique((memory.truthPackets?.sourceTruthWarnings || []).map(hostedWarningText).map((item) => compact(item, 100)).filter(Boolean));
  const staleSources = unique(rows.flatMap((row) => [
    ...(row.truthPacket?.freshness?.staleSources || []),
    ...(row.evidencePacket?.freshness?.staleSources || []),
  ]).map((item) => compact(item, 80)).filter(Boolean));
  const snapshotTime = memory.truthPackets?.snapshotTime || "";
  const truthSignature = String(memory.truthPackets?.contentSignature || "");
  const refreshHealth = memory.refreshHealth || {};
  const verifiedAt = String(refreshHealth.status || "") === "success" && truthSignature &&
    String(refreshHealth.truthPacketContentSignature || "") === truthSignature
    ? String(refreshHealth.completedAt || refreshHealth.snapshotTime || "")
    : "";
  const freshAt = [snapshotTime, verifiedAt].filter((value) => Number.isFinite(Date.parse(value))).sort().pop() || "";
  const ageMinutes = freshAt ? Math.max(0, (now.getTime() - Date.parse(freshAt)) / 60000) : null;
  const maxAgeMinutes = Math.max(1, Number(env.PQ_PUBLIC_TRUTH_MAX_AGE_MINUTES || env.PQ_TRUTH_HEALTH_STALE_MINUTES || 15) || 15);
  const status = warnings.length || staleSources.length || ageMinutes === null || ageMinutes > maxAgeMinutes
    ? (ageMinutes === null ? "unknown" : "stale")
    : "fresh";
  const details = unique([
    ...warnings,
    staleSources.length ? `stale sources: ${staleSources.join(", ")}` : "",
    ageMinutes === null ? "truth snapshot time missing" : ageMinutes > maxAgeMinutes ? `truth snapshot ${Math.round(ageMinutes)}m old` : "",
  ].filter(Boolean));
  return {
    status,
    ageMinutes,
    staleSources,
    warnings,
    warning: status === "fresh" ? "" : `Packet evidence is stale or incomplete (${details.join("; ")}); check the source detail before acting.`,
  };
}

function analyticalFallback(question, rows, citations, reason = "", sourceWarning = "") {
  const stateCitations = citations.filter((citation) => /Current packet state/.test(citation.text));
  return {
    title: `Grounded analysis — ${rows.length} shipment${rows.length === 1 ? "" : "s"}`,
    subtitle: "",
    answer: [
      sourceWarning,
      "I don't know enough from the retrieved packet evidence to answer the analytical part safely.",
      stateCitations.slice(0, 12).map((citation) => `${citation.awb} — ${citation.text}`).join("\n"),
    ].filter(Boolean).join("\n"),
    facts: [], actions: [],
    items: rows.map((row) => {
      const stateCode = row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || "unknown";
      return { awb: displayAwb(row.awb), station: row.station || "", state: opsQuery.statePhrase(stateCode), stateCode, reason: "Canonical packet state", action: "", freshness: "", source: "shipment-truth-packets" };
    }),
    shipments: rows,
    context: { topic: "open-analytical", list: true, question: compact(question, 180), modelDegraded: Boolean(reason), shipmentIds: rows.map((row) => normalizeAwb(row.awb)).slice(0, 24) },
  };
}

async function synthesizeAnalyticalQuestion(route, question, memory, context, runtime, budget, env = process.env) {
  const rows = retrieveAnalyticalRows(route, question, memory, context);
  const { citations, actions } = analyticalEvidence(rows, memory);
  const freshness = analyticalSourceFreshness(memory, rows, env);
  if (!rows.length || !citations.length) return { answer: analyticalFallback(question, rows, citations, "no-evidence", freshness.warning), usedModel: false };
  const prompt = {
    question: compact(question, 500),
    retrievedRows: rows.map((row) => ({ awb: displayAwb(row.awb), station: row.station || "", client: row.client || row.consignee || "" })),
    citedFacts: citations,
    plannerStampedActions: actions.map((action) => ({ id: action.id, awb: action.awb || "", label: action.label || action.type || "" })),
    rules: [
      "Reason only from citedFacts. Every claim must cite one or more citation IDs that directly support it.",
      "If a requested comparison or fact is unsupported, put it in unknowns; never guess.",
      "Do not write action prose. Select an action only by exact plannerStampedActions ID.",
      "Do not infer that a missing or stale source proves an event did not happen.",
    ],
  };
  const result = await runtime.synthesizeGrounded(prompt, budget);
  if (result.skipped) return { answer: analyticalFallback(question, rows, citations, result.skipped, freshness.warning), usedModel: false };
  const { accepted, rejected } = validatedAnalyticalClaims(result.synthesis, citations);
  const allowedActionIds = new Set(actions.map((action) => action.id));
  const selectedActions = (result.synthesis.actionIds || []).filter((id) => allowedActionIds.has(id)).map((id) => actions.find((action) => action.id === id)).filter(Boolean);
  const lines = accepted.map((claim) => claim.text);
  if (!lines.length || rejected || result.synthesis.unknowns?.length) lines.push("I don't know from the retrieved packet evidence for any unsupported part of that question.");
  return {
    usedModel: true,
    answer: {
      title: `Grounded analysis — ${rows.length} shipment${rows.length === 1 ? "" : "s"}`,
      subtitle: "",
      answer: [freshness.warning, ...lines].filter(Boolean).join("\n"),
      facts: [], actions: selectedActions,
      items: rows.map((row) => {
        const stateCode = row.truthPacket?.resolvedCurrentState || row.truthPacket?.currentState || row.currentState || "unknown";
        return { awb: displayAwb(row.awb), station: row.station || "", state: opsQuery.statePhrase(stateCode), stateCode, reason: "Canonical packet state", action: "", freshness: "", source: "shipment-truth-packets" };
      }),
      shipments: rows,
      context: { topic: "open-analytical", list: true, question: compact(question, 180), shipmentIds: rows.map((row) => normalizeAwb(row.awb)).slice(0, 24) },
      source: "openai",
      modelUsed: result.model || "",
    },
  };
}

function explicitShipmentQuestion(question, fallback) {
  const askedAwbs = explicitAwbsFromText(question);
  if (askedAwbs.length !== 1) return false;
  const askedAwb = askedAwbs[0];
  if (!askedAwb || !fallback?.shipments?.length) return false;
  return fallback.shipments.some((shipment) => normalizeAwb(shipment.awb) === askedAwb || normalizeAwb(shipment.id) === askedAwb);
}

function answerRejectsKnownShipment(answer) {
  return /\b(?:no matching|not found|no open shipment|not present|no shipment record|verify shipment id)\b/i.test(
    `${answer?.title || ""} ${answer?.answer || answer?.content || ""} ${(answer?.facts || []).join(" ")}`,
  );
}

function stripProviderLeakText(value) {
  return String(value || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => !/^(?:source\s*:\s*)?(?:openai|deterministic)(?:\s+model)?$/i.test(line))
    .join("\n");
}

async function routeResidualQuestion({ question, history, context, memory, env, modelRuntime, modelBudget = null }) {
  const runtime = modelRuntime || createOpsBrainModelRuntime({
    env,
    spendStore: defaultOpsBrainSpendStore(env),
    spendHealth: opsBrainSpendHealth,
  });
  const budget = modelBudget || runtime.createQuestionBudget();
  const routed = await runtime.routeQuestion(question, history, budget);
  if (routed.skipped || !routed.route) return { skipped: routed.skipped || "no-route", usedModel: budget.calls > 0 };
  const route = trustedRouteParameters(routed.route, question, history, context, memory);
  const minimumConfidence = Number(env.PIKIIO_OPS_BRAIN_ROUTER_MIN_CONFIDENCE || 0.68);
  if (route.confidence < (Number.isFinite(minimumConfidence) ? minimumConfidence : 0.68)) {
    return { answer: routedClarification(route), usedModel: true, route };
  }
  const untrustedScope = route.intent !== "out-of-scope" && (
    (route.scope === "shipment" && !route.awb) ||
    (route.scope === "station" && !route.station) ||
    (route.scope === "group" && !route.shipmentIds?.length)
  );
  if (untrustedScope) return { answer: routedClarification(route), usedModel: true, route };
  if (route.intent === "open-analytical") {
    const analytical = await synthesizeAnalyticalQuestion(route, question, memory, context, runtime, budget, env);
    return { ...analytical, usedModel: true, route };
  }
  const answer = executeRoutedDeterministic(route, question, memory, history, context);
  return answer
    ? { answer, usedModel: true, route }
    : { answer: routedClarification(route), usedModel: true, route };
}

const CONVERSATION_SESSION_SCHEMA = "ops-conversation-session-v1";
const CONVERSATION_SESSION_INTENTS = new Set([
  "status",
  "next-action",
  "blocker-why",
  "contacts",
  "eta",
  "pod",
  "cargo",
  "urgent",
  "stuck",
  "waiting-on",
  "arrived-window",
  "last-outbound",
]);
const CONVERSATION_COUNTERPARTY_ROLES = new Set([
  "station",
  "customs-broker",
  "pickup-broker",
  "consignee",
  "carrier",
  "driver",
]);
const CONVERSATION_CLARIFICATION_KINDS = new Set(["scope", "reference", "router"]);
const CONVERSATION_OPTION_SCOPES = new Set(["fleet", "shipment", "station"]);

function conversationActiveRows(memory = {}) {
  const packets = memory.truthPackets || {};
  const indexedAwbs = new Set((packets.activeAwbs || []).map(normalizeAwb).filter(Boolean));
  return (packets.shipments || []).filter((row) => {
    const awb = normalizeAwb(row.awb || row.id);
    const role = String(row.truthPacketRole || "active").toLowerCase();
    return Boolean(awb && role === "active" && (!indexedAwbs.size || indexedAwbs.has(awb)));
  });
}

function conversationStation(value = "") {
  const station = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{2,5}$/.test(station) ? station : "";
}

function conversationOptionId(value = "") {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9:_-]{1,80}$/.test(id) ? id : "";
}

function publicConversationOption(option = {}) {
  const scope = CONVERSATION_OPTION_SCOPES.has(option.scope) ? option.scope : "";
  const id = conversationOptionId(option.id);
  if (!scope || !id) return null;
  const awb = scope === "shipment" ? normalizeAwb(option.awb || "") : "";
  const station = scope === "station" || scope === "shipment" ? conversationStation(option.station) : "";
  if (scope === "shipment" && !awb) return null;
  if (scope === "station" && !station) return null;
  return { id, scope, awb, station };
}

function publicConversationSessionState(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  const lastIntent = CONVERSATION_SESSION_INTENTS.has(input.lastIntent) ? input.lastIntent : "";
  const lastCounterpartyRole = CONVERSATION_COUNTERPARTY_ROLES.has(input.lastCounterpartyRole)
    ? input.lastCounterpartyRole
    : "";
  const pendingInput = input.pendingClarification && typeof input.pendingClarification === "object"
    ? input.pendingClarification
    : null;
  const pendingOptions = pendingInput
    ? (pendingInput.options || []).map(publicConversationOption).filter(Boolean).slice(0, 2)
    : [];
  const pendingClarification = pendingInput &&
    CONVERSATION_CLARIFICATION_KINDS.has(pendingInput.kind) &&
    pendingOptions.length
    ? {
        kind: pendingInput.kind,
        intent: CONVERSATION_SESSION_INTENTS.has(pendingInput.intent) ? pendingInput.intent : "status",
        options: pendingOptions,
      }
    : null;
  return {
    schema: CONVERSATION_SESSION_SCHEMA,
    focusedAwb: normalizeAwb(input.focusedAwb || ""),
    focusedStation: conversationStation(input.focusedStation),
    lastResultItemIds: unique((input.lastResultItemIds || []).map(normalizeAwb).filter(Boolean)).slice(0, 12),
    lastIntent,
    lastCounterpartyRole,
    pendingClarification,
  };
}

function groundedConversationSessionState(value, memory) {
  const state = publicConversationSessionState(value);
  const rows = conversationActiveRows(memory);
  const rowsByAwb = new Map(rows.map((row) => [normalizeAwb(row.awb || row.id), row]));
  const stations = new Set(rows.map((row) => conversationStation(row.station)).filter(Boolean));
  const focusedRow = rowsByAwb.get(state.focusedAwb) || null;
  state.focusedAwb = focusedRow ? normalizeAwb(focusedRow.awb || focusedRow.id) : "";
  state.focusedStation = state.focusedAwb
    ? conversationStation(focusedRow.station)
    : stations.has(state.focusedStation) ? state.focusedStation : "";
  state.lastResultItemIds = state.lastResultItemIds.filter((awb) => rowsByAwb.has(awb));
  if (state.pendingClarification) {
    state.pendingClarification.options = state.pendingClarification.options.map((option) => {
      if (option.scope !== "shipment") return option;
      const row = rowsByAwb.get(option.awb);
      return row ? { ...option, station: conversationStation(row.station) } : null;
    }).filter((option) => {
      if (!option) return false;
      if (option.scope === "fleet") return true;
      if (option.scope === "shipment") return rowsByAwb.has(option.awb);
      return stations.has(option.station);
    });
    if (!state.pendingClarification.options.length) state.pendingClarification = null;
  }
  return state;
}

function conversationCounterpartyRole(question, fallback = "") {
  const text = String(question || "").toLowerCase();
  if (/\bcustoms\b/.test(text)) return "customs-broker";
  if (/\b(?:pickup broker|cartage|trucker)\b/.test(text)) return "pickup-broker";
  if (/\b(?:station|handler|terminal)\b/.test(text)) return "station";
  if (/\b(?:driver|courier)\b/.test(text)) return "driver";
  if (/\b(?:customer|client|consignee)\b/.test(text)) return "consignee";
  if (/\b(?:airline|carrier)\b/.test(text)) return "carrier";
  return CONVERSATION_COUNTERPARTY_ROLES.has(fallback) ? fallback : "";
}

function conversationIntentFromQuestion(question, fallback = "") {
  const text = String(question || "").toLowerCase();
  if (/\bwhy\b|\b(?:blocker|blocked because|problem)\b/.test(text)) return "blocker-why";
  if (/\b(?:what should (?:i|we) do|next action|next move|what next|needs? action)\b/.test(text)) return "next-action";
  if (/\b(?:contact|phone|email|call|station details)\b/.test(text)) return "contacts";
  if (/\b(?:eta|when.*arriv|arrival time)\b/.test(text)) return "eta";
  if (/\b(?:pod|proof of delivery)\b/.test(text)) return "pod";
  if (/\b(?:pieces?|pcs?|weight|dimensions?|cargo)\b/.test(text)) return "cargo";
  if (/\b(?:urgent|priorit|focus on|at risk)\b/.test(text)) return "urgent";
  if (/\b(?:stuck|blocked|jammed)\b/.test(text)) return "stuck";
  if (/\b(?:waiting on|hasn'?t replied|unanswered)\b/.test(text)) return "waiting-on";
  if (/\b(?:arrived|arriving|arrival|landed|touched down)\b/.test(text)) return "arrived-window";
  if (/\b(?:last email|latest email|last outbound)\b/.test(text)) return "last-outbound";
  if (/\b(?:status|going on|happening|deal with|looking)\b/.test(text)) return "status";
  return CONVERSATION_SESSION_INTENTS.has(fallback) ? fallback : "status";
}

function conversationIntentFromAnswer(answer = {}, fallback = "") {
  const topic = String(answer.context?.topic || "").toLowerCase();
  if (/stuck|blocker|problem/.test(topic)) return "blocker-why";
  if (/arriv/.test(topic)) return "arrived-window";
  if (/waiting|unanswered/.test(topic)) return "waiting-on";
  if (/contact|station/.test(topic)) return "contacts";
  if (/pod/.test(topic)) return "pod";
  if (/cargo/.test(topic)) return "cargo";
  if (/latest|outbound/.test(topic)) return "last-outbound";
  if (/urgent|focus|action|risk/.test(topic)) return "urgent";
  if (/shipment|result-set|status|selection/.test(topic)) return "status";
  return conversationIntentFromQuestion(answer.context?.question || "", fallback);
}

function conversationCompanyMention(question, rows = []) {
  const text = String(question || "").toLowerCase();
  if (/\b(?:norman|binational)\b/i.test(text)) return true;
  const names = unique(rows.flatMap((row) => [
    row.client,
    row.consignee,
    row.delivery?.consignee,
    row.customer,
  ]).map((name) => String(name || "").trim()).filter((name) => name.length >= 3));
  return names.some((name) => new RegExp(`\\b${escapeRegExp(name).replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
}

function conversationBareWhy(question) {
  return /^(?:and\s+)?why(?:\s+(?:is that|though))?[?.!]*$/i.test(String(question || "").trim());
}

function conversationDeicticReference(question) {
  return /^(?:and\s+)?(?:that one|this one|it|open it|open that|open this|what about that one|how about that one)[?.!]*$/i.test(String(question || "").trim());
}

function conversationScopeAmbiguous(question) {
  return /^(?:so\s+)?(?:what(?:'s| is) going on|what should (?:i|we) do|what now|what next|what(?:'s| is) the status|how(?:'s| is) it going)[?.!]*$/i.test(String(question || "").trim());
}

function conversationContextForOption(context = {}, option = {}, resultIds = []) {
  const next = { ...context };
  delete next.awb;
  delete next.selectedId;
  delete next.shipmentIds;
  delete next.station;
  delete next.list;
  if (option.scope === "shipment") {
    next.awb = option.awb;
    next.selectedId = option.awb;
    next.shipmentIds = resultIds.length ? resultIds : [option.awb];
    next.topic = "conversation-reference";
  } else if (option.scope === "station") {
    next.station = option.station;
    next.list = true;
    next.topic = "conversation-station";
  } else {
    next.list = true;
    next.topic = "conversation-fleet";
  }
  return next;
}

function conversationQuestionForOption(intent, option) {
  if (option.scope === "shipment") {
    if (intent === "blocker-why" || intent === "stuck") return `why is ${option.awb} blocked?`;
    if (intent === "next-action" || intent === "urgent") return `what should I do for ${option.awb}?`;
    if (intent === "contacts") return `station contact for ${option.awb}`;
    if (intent === "eta") return `what is the ETA for ${option.awb}?`;
    if (intent === "pod") return `POD status for ${option.awb}`;
    if (intent === "cargo") return `cargo details for ${option.awb}`;
    if (intent === "last-outbound") return `what was the last email for ${option.awb}?`;
    return `status ${option.awb}`;
  }
  const suffix = option.scope === "station" ? ` at ${option.station}` : "";
  if (intent === "stuck" || intent === "blocker-why") return `what's stuck${suffix}?`;
  if (intent === "waiting-on") return `who are we waiting on${suffix}?`;
  if (intent === "arrived-window") return `what arrived today${suffix}?`;
  if (intent === "urgent" || intent === "next-action") return `what needs action${suffix}?`;
  return option.scope === "station" ? `show all shipments at ${option.station}` : "show all shipments";
}

function conversationOption(kind, scope, value = "") {
  const awb = scope === "shipment" ? normalizeAwb(value) : "";
  const station = scope === "station" ? conversationStation(value) : "";
  return publicConversationOption({
    id: `${kind}:${scope}${awb ? `:${awb}` : station ? `:${station.toLowerCase()}` : ""}`,
    scope,
    awb,
    station,
  });
}

function conversationClarification({ kind, intent, options, session, memory, topic = "conversation-clarification" }) {
  const rows = conversationActiveRows(memory);
  const rowsByAwb = new Map(rows.map((row) => [normalizeAwb(row.awb || row.id), row]));
  const safeOptions = (options || []).map(publicConversationOption).filter(Boolean).slice(0, 2);
  const pendingClarification = {
    kind: CONVERSATION_CLARIFICATION_KINDS.has(kind) ? kind : "router",
    intent: CONVERSATION_SESSION_INTENTS.has(intent) ? intent : "status",
    options: safeOptions,
  };
  const nextSession = groundedConversationSessionState({ ...session, pendingClarification }, memory);
  const displayOptions = (nextSession.pendingClarification?.options || []).map((option) => {
    if (option.scope === "fleet") {
      return { ...option, label: "Whole board", question: "The whole board" };
    }
    if (option.scope === "station") {
      return { ...option, label: `${option.station} shipments`, question: `${option.station}` };
    }
    const row = rowsByAwb.get(option.awb);
    const station = conversationStation(row?.station || option.station);
    const label = `${station ? `${station} shipment ` : "Shipment "}(${displayAwb(option.awb)})`;
    return { ...option, station, label, question: station ? `The ${station} shipment` : `Shipment ${displayAwb(option.awb)}` };
  });
  const line = displayOptions.length === 2
    ? `${displayOptions[0].label}, or ${displayOptions[1].label.toLowerCase()}?`
    : displayOptions.length === 1
      ? `Do you mean ${displayOptions[0].label.toLowerCase()}?`
      : "Which shipment or operational slice do you mean?";
  return {
    answer: {
      title: "Which one?",
      subtitle: "One detail needed",
      answer: line,
      facts: [],
      actions: [],
      items: [],
      shipments: [],
      clarification: { kind: pendingClarification.kind, options: displayOptions },
      context: { topic },
      sessionState: nextSession,
    },
    session: nextSession,
  };
}

function resolveConversationOption({ question, clarificationOptionId, pending, explicitStation }) {
  const options = pending?.options || [];
  const tapped = conversationOptionId(clarificationOptionId);
  if (tapped) return options.find((option) => option.id === tapped) || null;
  const text = String(question || "").trim();
  const explicitAwb = normalizeAwb(text);
  if (explicitAwb) return options.find((option) => option.scope === "shipment" && option.awb === explicitAwb) || null;
  if (/\b(?:the )?(?:fleet|whole board|all shipments|everything)\b/i.test(text)) {
    return options.find((option) => option.scope === "fleet") || null;
  }
  if (explicitStation) {
    const byStation = options.filter((option) => option.station === explicitStation);
    if (byStation.length === 1) return byStation[0];
  }
  const ordinal = String(text).toLowerCase().match(/\b(first|second|1st|2nd)\b/);
  if (ordinal) return options[/^(?:second|2nd)$/.test(ordinal[1]) ? 1 : 0] || null;
  const shipmentOptions = options.filter((option) => option.scope === "shipment");
  if (shipmentOptions.length === 1 && /\b(?:the shipment|this one|that one|the [a-z0-9]{2,5} one)\b/i.test(text)) {
    return shipmentOptions[0];
  }
  return null;
}

function conversationOptionsFromResultIds(kind, ids) {
  return (ids || []).slice(0, 2).map((awb) => conversationOption(kind, "shipment", awb)).filter(Boolean);
}

function prepareConversationTurn({ question, context, sessionState, clarificationOptionId, memory }) {
  const rows = conversationActiveRows(memory);
  const rowsByAwb = new Map(rows.map((row) => [normalizeAwb(row.awb || row.id), row]));
  const sessionProvided = Boolean(sessionState && typeof sessionState === "object");
  let session = groundedConversationSessionState(sessionState, memory);
  const originalQuestion = String(question || "").trim();
  const explicitAwb = normalizeAwb(originalQuestion);
  const explicitStation = stationFromQuestion(originalQuestion, rows);
  const explicitCompany = conversationCompanyMention(originalQuestion, rows);
  const fleetIntent = questionHasFleetIntent(originalQuestion);
  const intent = conversationIntentFromQuestion(originalQuestion, session.lastIntent);
  let nextContext = { ...(context || {}) };

  if (session.pendingClarification) {
    const resolved = resolveConversationOption({
      question: originalQuestion,
      clarificationOptionId,
      pending: session.pendingClarification,
      explicitStation,
    });
    if (resolved) {
      const pendingIntent = session.pendingClarification.intent;
      session.pendingClarification = null;
      session.focusedAwb = resolved.scope === "shipment" ? resolved.awb : "";
      session.focusedStation = resolved.scope === "station"
        ? resolved.station
        : resolved.scope === "shipment" ? conversationStation(rowsByAwb.get(resolved.awb)?.station) : "";
      return {
        question: conversationQuestionForOption(pendingIntent, resolved),
        context: conversationContextForOption(nextContext, resolved, session.lastResultItemIds),
        session,
        intent: pendingIntent,
      };
    }
    if (!explicitAwb && !explicitStation && !explicitCompany && !fleetIntent &&
      /^(?:the|this|that|it|one|which|shipment|station|fleet|board|first|second|last)\b/i.test(originalQuestion)) {
      const repeated = conversationClarification({
        kind: session.pendingClarification.kind,
        intent: session.pendingClarification.intent,
        options: session.pendingClarification.options,
        session,
        memory,
      });
      return { clarification: repeated.answer, session: repeated.session, intent: session.pendingClarification.intent };
    }
    session.pendingClarification = null;
  }

  if (explicitAwb) {
    const row = rowsByAwb.get(explicitAwb) || null;
    session.focusedAwb = row ? explicitAwb : "";
    session.focusedStation = row ? conversationStation(row.station) : "";
    delete nextContext.station;
    delete nextContext.list;
    delete nextContext.selectedId;
    delete nextContext.shipmentIds;
    nextContext.awb = explicitAwb;
    return { question: originalQuestion, context: nextContext, session, intent };
  }

  if (explicitStation) {
    session.focusedAwb = "";
    session.focusedStation = explicitStation;
    nextContext = conversationContextForOption(nextContext, { scope: "station", station: explicitStation }, session.lastResultItemIds);
    return {
      question: originalQuestion,
      context: nextContext,
      session,
      intent,
    };
  }

  if (explicitCompany) {
    session.focusedAwb = "";
    session.focusedStation = "";
    nextContext = conversationContextForOption(nextContext, { scope: "fleet" }, session.lastResultItemIds);
    return { question: originalQuestion, context: nextContext, session, intent };
  }

  if (fleetIntent) {
    session.focusedAwb = "";
    session.focusedStation = "";
    nextContext = conversationContextForOption(nextContext, { scope: "fleet" }, session.lastResultItemIds);
    return { question: originalQuestion, context: nextContext, session, intent };
  }

  const parsedFollowUp = opsQuery.parseFollowUp(originalQuestion);
  if (parsedFollowUp?.kind === "open-nth" && session.lastResultItemIds.length) {
    const index = parsedFollowUp.index === -1 ? session.lastResultItemIds.length - 1 : parsedFollowUp.index;
    const awb = session.lastResultItemIds[index] || "";
    if (awb) {
      session.focusedAwb = awb;
      session.focusedStation = conversationStation(rowsByAwb.get(awb)?.station);
      return {
        question: originalQuestion,
        context: {
          ...nextContext,
          awb: "",
          selectedId: "",
          shipmentIds: session.lastResultItemIds,
          list: true,
          topic: "result-set",
        },
        session,
        intent: "status",
      };
    }
  }

  const isReference = conversationBareWhy(originalQuestion) || conversationDeicticReference(originalQuestion);
  if (isReference) {
    const awb = session.focusedAwb || (session.lastResultItemIds.length === 1 ? session.lastResultItemIds[0] : "");
    if (awb) {
      const option = conversationOption("reference", "shipment", awb);
      const referenceIntent = conversationBareWhy(originalQuestion) ? "blocker-why" : "status";
      session.focusedAwb = awb;
      session.focusedStation = conversationStation(rowsByAwb.get(awb)?.station);
      return {
        question: conversationQuestionForOption(referenceIntent, option),
        context: conversationContextForOption(nextContext, option, session.lastResultItemIds),
        session,
        intent: referenceIntent,
      };
    }
    if (session.lastResultItemIds.length > 1) {
      const clarified = conversationClarification({
        kind: "reference",
        intent: conversationBareWhy(originalQuestion) ? "blocker-why" : "status",
        options: conversationOptionsFromResultIds("reference", session.lastResultItemIds),
        session,
        memory,
      });
      return { clarification: clarified.answer, session: clarified.session, intent };
    }
  }

  if (parsedFollowUp && session.lastResultItemIds.length) {
    nextContext = {
      ...nextContext,
      awb: "",
      list: true,
      shipmentIds: session.lastResultItemIds,
      topic: "result-set",
    };
    return { question: originalQuestion, context: nextContext, session, intent };
  }

  if (sessionProvided && session.focusedAwb && conversationScopeAmbiguous(originalQuestion)) {
    const clarified = conversationClarification({
      kind: "scope",
      intent,
      options: [
        conversationOption("scope", "shipment", session.focusedAwb),
        conversationOption("scope", "fleet"),
      ],
      session,
      memory,
    });
    return { clarification: clarified.answer, session: clarified.session, intent };
  }

  if (sessionProvided && session.focusedAwb) {
    nextContext = conversationContextForOption(
      nextContext,
      { scope: "shipment", awb: session.focusedAwb },
      session.lastResultItemIds,
    );
  } else if (sessionProvided && session.focusedStation) {
    nextContext = conversationContextForOption(
      nextContext,
      { scope: "station", station: session.focusedStation },
      session.lastResultItemIds,
    );
  }
  return { question: originalQuestion, context: nextContext, session, intent };
}

function nextConversationSessionState({ previous, answer, memory, question, intent }) {
  const state = groundedConversationSessionState(previous, memory);
  const rows = conversationActiveRows(memory);
  const rowsByAwb = new Map(rows.map((row) => [normalizeAwb(row.awb || row.id), row]));
  const stations = new Set(rows.map((row) => conversationStation(row.station)).filter(Boolean));
  const listAnswer = Boolean(answer.context?.list);
  if (listAnswer) {
    state.lastResultItemIds = unique((answer.items || [])
      .map((item) => normalizeAwb(item.awb || item.id))
      .filter((awb) => rowsByAwb.has(awb)))
      .slice(0, 12);
    state.focusedAwb = state.lastResultItemIds.length === 1 ? state.lastResultItemIds[0] : "";
    const answerStation = conversationStation(answer.context?.station);
    state.focusedStation = stations.has(answerStation)
      ? answerStation
      : state.focusedAwb ? conversationStation(rowsByAwb.get(state.focusedAwb)?.station) : "";
  } else {
    const answerAwb = normalizeAwb(
      answer.context?.awb ||
      ((answer.shipments || []).length === 1 ? answer.shipments[0]?.awb || answer.shipments[0]?.id : ""),
    );
    if (rowsByAwb.has(answerAwb)) {
      state.focusedAwb = answerAwb;
      state.focusedStation = conversationStation(rowsByAwb.get(answerAwb)?.station);
    } else {
      const answerStation = conversationStation(answer.context?.station);
      if (stations.has(answerStation)) state.focusedStation = answerStation;
    }
  }
  state.lastIntent = conversationIntentFromAnswer(answer, intent);
  state.lastCounterpartyRole = conversationCounterpartyRole(question, state.lastCounterpartyRole);
  state.pendingClarification = null;
  return groundedConversationSessionState(state, memory);
}

async function answerOpsBrainQuestionCore({ rootDir, question, history = [], context = {}, memory = null, env = process.env, modelRuntime = null, modelBudget = null }) {
  const loaded = memory || await readOpsBrainMemory(rootDir, env);
  const operatorUpdate = operatorUpdateIntent(question, history, loaded, context);
  const fallback = deterministicAnswer(question, loaded, history, context);
  if (operatorUpdate?.kind === "needs-awb") {
    return {
      ok: true,
      source: "deterministic",
      answer: {
        title: "Shipment fact not recorded",
        subtitle: "Structured phone truth required",
        answer: "Free text cannot change shipment truth. Open the shipment and use a protected structured phone-truth control with the AWB and contact provenance.",
        facts: [],
        actions: [],
        items: [],
        shipments: [],
        context: { topic: "operator-truth-not-recorded" },
      },
    };
  }
  if (operatorUpdate?.kind === "operator-update") {
    const shipment = findShipment(loaded, operatorUpdate.awb);
    return {
      ok: true,
      source: "deterministic",
      answer: {
        title: shipment?.awb || operatorUpdate.awb,
        subtitle: "Shipment fact not recorded",
        answer: "I did not change shipment truth from that free-text message. Use a protected structured phone-truth control so the event enters the canonical evidence ledger with contact, time, and an exact predicate.",
        nextAction: "Open the shipment's structured state or fee control and record only the fact confirmed by phone.",
        facts: [],
        actions: [],
        items: [],
        shipments: shipment ? [shipment] : [],
        context: {
          awb: normalizeAwb(shipment?.awb || operatorUpdate.awb),
          station: shipment?.station || fallback.context?.station || "",
          topic: "operator-truth-not-recorded",
        },
      },
    };
  }
  // Structured operational queries answer from packet STRUCTURE, never from
  // freeform summaries: station inventory, arrived-in-window, POD-missing,
  // arrived-without-broker, handle-together groups. Anything unmatched falls
  // through to the existing intent router untouched.
  // Conversation memory: broad answers store their result set in
  // context.shipmentIds; follow-ups ("which ones?", "open the second one",
  // "what should I do for them?") act on it against CURRENT truth.
  const contextResultSet = Array.isArray(context.shipmentIds) ? context.shipmentIds.filter(Boolean) : [];
  const followUp = contextResultSet.length ? opsQuery.parseFollowUp(question) : null;
  if (followUp) {
    const rows = loaded.truthPackets?.shipments || [];
    const set = opsQuery.listForAwbs(rows, contextResultSet);
    if (followUp.kind === "open-nth") {
      const index = followUp.index === -1 ? set.shipments.length - 1 : followUp.index;
      const target = set.shipments[index];
      if (!target) {
        return { ok: true, source: "deterministic", answer: {
          title: "Not that many", subtitle: "Conversation results",
          answer: `The last list has ${set.shipments.length} shipment${set.shipments.length === 1 ? "" : "s"}.`,
          facts: [], actions: [], items: [], shipments: set.shipments.slice(0, 12),
          context: { ...context, topic: "result-set" },
        } };
      }
      const opened = withShipmentPackets(shipmentTopicAnswer(target, `status ${target.awb}`, loaded, "shipment"), target, loaded);
      return { ok: true, source: "deterministic", answer: {
        ...opened,
        title: target.awb,
        subtitle: "Opened from your last list",
        context: { ...(opened.context || {}), awb: normalizeAwb(target.awb || ""), selectedId: target.id || target.awb || "", shipmentIds: contextResultSet, topic: "result-set-open" },
      } };
    }
    const lineFor = (item) =>
      `${displayAwb(item.awb)} · ${item.station}${item.consignee ? ` · ${item.consignee}` : ""} — ${String(item.reason || "").replace(/[.\s]+$/g, "")}` +
      `${item.nextMove ? `; ${item.nextMove}` : ""}`;
    const body = followUp.kind === "next-moves"
      ? set.results.map((item) => `${displayAwb(item.awb)}: ${item.nextMove || "review the shipment"}`).join("\n")
      : set.results.map(lineFor).join("\n");
    return { ok: true, source: "deterministic", answer: {
      title: followUp.kind === "next-moves" ? "Next moves for those" : `Those ${set.results.length} shipments`,
      subtitle: "From your last list · current truth",
      answer: body || "None of those shipments are active anymore.",
      facts: [], actions: [],
      items: set.results.map((item) => ({
        awb: item.awb,
        station: item.station,
        consignee: item.consignee || "",
        state: item.state || "",
        stateCode: item.stateCode || "",
        reason: item.reason || "",
        action: item.nextMove || item.reason,
        freshness: item.freshness || "",
        source: item.source || "shipment-truth-packets",
      })),
      shipments: set.shipments.slice(0, 12),
      context: { ...context, shipmentIds: contextResultSet, topic: "result-set", list: true },
    } };
  }
  // Operator-coworker layer: focus ranking, change summaries, customer
  // updates, waiting-on, last-outbound, missing-proof — grounded in packet
  // rows + Gmail proof rosters. Runs before the intent router so operational
  // questions never dead-end in "I only know Pikiio ops".
  {
    const rows = loaded.truthPackets?.shipments || [];
    const historyScope = contextFromHistory(history, mergeShipments(loaded, { attachPackets: false }), context);
    const detectedCoworkerIntent = coworkerIntent(question);
    const coworkerFleetIntent = coworkerIntentIsFleet(detectedCoworkerIntent) && !normalizeAwb(question);
    const coworkerStation = stationFromQuestion(question, rows) || (coworkerFleetIntent ? "" : String(context?.station || historyScope.station || "").toUpperCase());
    const coworkerRows = coworkerStation
      ? rows.filter((row) => String(row.station || "").toUpperCase() === coworkerStation)
      : rows;
    const explicitCoworkerAwb = normalizeAwb(question);
    const scopedAwb = explicitCoworkerAwb || (coworkerFleetIntent
      ? ""
      : normalizeAwb(context?.awb || (Array.isArray(context?.shipmentIds) && !context?.list ? context.shipmentIds[0] : "")));
    const scopedRow = scopedAwb ? rows.find((row) => normalizeAwb(row.awb) === scopedAwb) || null : null;
    const coworker = coworkerAnswer({
      question,
      rows: coworkerRows,
      gmailProof: loaded.gmailProof,
      requestRecords: requestRecordsFromMemory(loaded),
      shipment: scopedRow,
      intent: detectedCoworkerIntent,
      now: new Date(),
    });
    if (coworker) {
      const answer = coworkerStation
        ? { ...coworker, context: { ...(coworker.context || {}), station: coworkerStation } }
        : coworker;
      return { ok: true, source: "deterministic", answer };
    }
  }
  const querySpec = opsQuery.parseOperatorQuery(question);
  if (querySpec) {
    const rows = (loaded.truthPackets?.shipments || []);
    const result = opsQuery.runOperatorQuery(querySpec, rows, new Date());
    const rendered = renderOperatorQueryAnswer(result);
    if (rendered) return { ok: true, source: "deterministic", answer: rendered };
  }
  if (fallback.context?.topic === "unknown-shipment") {
    return { ok: true, source: "deterministic", answer: fallback };
  }
  if (fallback.context?.countKind || /^count-/i.test(String(fallback.context?.topic || ""))) {
    return { ok: true, source: "deterministic", answer: fallback };
  }
  if (operatorFactOnlyLine(fallback, operatorAnswerShipment(fallback))) {
    return { ok: true, source: "deterministic", answer: fallback };
  }
  if (explicitShipmentQuestion(question, fallback)) {
    return { ok: true, source: "deterministic", answer: fallback };
  }
  const asksNovelAnalysis = /\b(?:compare|rank|likeliest|most likely|correlat|trade-?off|analy[sz]e|reason across|explain which)\b/i.test(question);
  const unconfidentFallback = fallback.context?.topic === "out-of-scope" || (
    fallback.context?.list &&
    !questionAsksForBoardReasoning(question) &&
    (asksNovelAnalysis || !questionHasSupportedDeterministicListIntent(question))
  );
  const guardedDefault = fallback.context?.topic === "out-of-scope" || fallback.context?.list;
  if (guardedDefault && !unconfidentFallback) return { ok: true, source: "deterministic", answer: fallback };
  const cacheKey = opsBrainAnswerCacheKey(question, context, loaded, history, env);
  const cached = modelCacheAllowed(env, modelRuntime) ? answerCacheGet(cacheKey, env) : null;
  if (cached) return { ...cached, cacheHit: true };
  try {
    const routed = await routeResidualQuestion({ question, history, context, memory: loaded, env, modelRuntime, modelBudget });
    if (!routed.answer) {
      const degraded = { ok: true, source: "deterministic", modelSkipped: routed.skipped || "", answer: fallback };
      if (routed.usedModel) answerCacheSet(cacheKey, degraded);
      return degraded;
    }
    const response = {
      ok: true,
      source: routed.answer.source === "openai" ? "openai" : "openai-router",
      route: routed.route,
      answer: routed.answer,
    };
    if (routed.usedModel) answerCacheSet(cacheKey, response);
    return response;
  } catch (error) {
    return {
      ok: true,
      source: "deterministic",
      modelError: error instanceof Error ? error.message : String(error),
      answer: fallback,
    };
  }
}

async function answerOpsBrainQuestion({
  rootDir,
  question,
  history = [],
  context = {},
  sessionState = null,
  clarificationOptionId = "",
  memory = null,
  env = process.env,
  modelRuntime = null,
}) {
  const loaded = memory || await readOpsBrainMemory(rootDir, env);
  const prepared = prepareConversationTurn({
    question,
    context,
    sessionState,
    clarificationOptionId,
    memory: loaded,
  });
  if (prepared.clarification) {
    return { ok: true, source: "deterministic", answer: prepared.clarification };
  }
  const narrativeRequested = companionNarrativeFeatureRequested(env);
  const sharedModelRuntime = narrativeRequested
    ? modelRuntime || createOpsBrainModelRuntime({
        env,
        spendStore: defaultOpsBrainSpendStore(env),
        spendHealth: opsBrainSpendHealth,
      })
    : modelRuntime;
  const sharedModelBudget = narrativeRequested && typeof sharedModelRuntime?.createQuestionBudget === "function"
    ? sharedModelRuntime.createQuestionBudget()
    : null;
  const result = await answerOpsBrainQuestionCore({
    rootDir,
    question: prepared.question,
    history,
    context: prepared.context,
    memory: loaded,
    env,
    modelRuntime: sharedModelRuntime,
    modelBudget: sharedModelBudget,
  });
  let answer = result.answer || outOfScopeAnswer();
  if (answer.context?.topic === "router-clarification" && !answer.clarification) {
    const session = groundedConversationSessionState(prepared.session, loaded);
    let options = [];
    if (session.focusedAwb) {
      options = [
        conversationOption("router", "shipment", session.focusedAwb),
        conversationOption("router", "fleet"),
      ];
    } else if (session.lastResultItemIds.length) {
      options = conversationOptionsFromResultIds("router", session.lastResultItemIds);
    } else if (session.focusedStation) {
      options = [
        conversationOption("router", "station", session.focusedStation),
        conversationOption("router", "fleet"),
      ];
    } else {
      options = [conversationOption("router", "fleet")];
    }
    const clarified = conversationClarification({
      kind: "router",
      intent: CONVERSATION_SESSION_INTENTS.has(result.route?.intent) ? result.route.intent : prepared.intent,
      options,
      session,
      memory: loaded,
      topic: "router-clarification",
    });
    answer = { ...answer, ...clarified.answer, context: { ...(answer.context || {}), topic: "router-clarification" } };
  } else {
    answer = {
      ...answer,
      sessionState: nextConversationSessionState({
        previous: prepared.session,
        answer,
        memory: loaded,
        question,
        intent: prepared.intent,
      }),
    };
  }
  answer = await answerWithCompanionNarrative({
    answer,
    question: prepared.question,
    history,
    context: prepared.context,
    memory: loaded,
    env,
    modelRuntime: sharedModelRuntime,
    modelBudget: sharedModelBudget,
  });
  return { ...result, answer };
}

function normalizeAnswer(answer, fallback) {
  const fallbackHasItems = Array.isArray(fallback.items) && fallback.items.length > 0;
  const fallbackHasActions = Array.isArray(fallback.actions) && fallback.actions.length > 0;
  const fallbackHasFacts = Array.isArray(fallback.facts) && fallback.facts.length > 0;
  const fallbackHasContext = Boolean(fallback.context?.awb || fallback.context?.station || fallback.context?.topic);
  const fallbackIsAnchored = fallbackHasItems || fallbackHasActions || fallbackHasContext || (fallback.shipments || []).length > 0;
  const answerText = String(answer.answer || answer.content || "");
  const answerContradictsAnchors =
    fallbackHasItems &&
    /\b(?:0 shipments|no matching|nothing urgent|no urgent|not found|no open shipment|verify shipment)\b/i.test(answerText);
  return {
    title: fallbackIsAnchored ? fallback.title : answer.title || fallback.title,
    subtitle: fallbackIsAnchored ? fallback.subtitle || "" : answer.subtitle || fallback.subtitle || "",
    answer: stripProviderLeakText(answerContradictsAnchors ? fallback.answer : answer.answer || answer.content || fallback.answer),
    nextAction: stripProviderLeakText(answer.nextAction || fallback.nextAction || ""),
    facts: fallbackHasFacts ? fallback.facts || [] : Array.isArray(answer.facts) ? answer.facts.slice(0, 3) : fallback.facts || [],
    actions: fallbackIsAnchored ? fallback.actions || [] : Array.isArray(answer.actions) && answer.actions.length ? answer.actions.slice(0, 3) : fallback.actions || [],
    items: fallbackIsAnchored ? fallback.items || [] : Array.isArray(answer.items) && answer.items.length ? answer.items.slice(0, 3) : fallback.items || [],
    hiddenCount: fallbackIsAnchored ? fallback.hiddenCount || 0 : Number.isFinite(answer.hiddenCount) ? answer.hiddenCount : fallback.hiddenCount || 0,
    plan: fallbackIsAnchored ? fallback.plan || null : fallback.plan || answer.plan || null,
    shipments: fallback.shipments || [],
    context: fallbackHasContext ? fallback.context || {} : answer.context || fallback.context || {},
    truthPacket: fallback.truthPacket || answer.truthPacket || null,
    evidencePacket: fallback.evidencePacket || answer.evidencePacket || null,
    source: answer.source || "openai",
    modelUsed: answer.modelUsed || "",
  };
}

function compactShipmentForBrainAnswer(shipment) {
  if (!shipment || typeof shipment !== "object") return null;
  return {
    id: shipment.id || "",
    awb: shipment.awb || "",
    station: shipment.station || "",
    airline: shipment.airline || "",
    client: shipment.client || shipment.consignee || "",
    completed: Boolean(shipment.completed),
    truthPacket: compactTruthPacket(shipment.truthPacket),
  };
}

function compactBrainPlan(plan) {
  if (!plan || typeof plan !== "object") return null;
  return {
    phase: plan.phase || "",
    label: plan.label || "",
    urgency: Number.isFinite(plan.urgency) ? plan.urgency : 0,
    pingLevel: plan.pingLevel || "quiet",
    pingReason: plan.pingReason || "",
    headline: plan.headline || "",
    blocker: plan.blocker || "",
    nextAction: plan.nextAction || "",
    storage: plan.storage || "",
    quote: plan.quote || "",
    conflicts: Array.isArray(plan.conflicts)
      ? plan.conflicts.map((conflict) => ({
          id: conflict.id || "",
          type: conflict.type || "",
          summary: conflict.summary || "",
        })).slice(0, 2)
      : [],
    checks: Array.isArray(plan.checks)
      ? plan.checks.map((check) => ({
          key: check.key || "",
          label: check.label || "",
          status: check.status || "",
          detail: check.detail || "",
        })).slice(0, 4)
      : [],
    actionsReady: Array.isArray(plan.actionsReady)
      ? plan.actionsReady.map((action) => ({
          id: action.id || "",
          type: action.type || "",
          label: action.label || "",
          channel: action.channel || "",
          targetName: action.targetName || "",
          execution: action.execution || "",
          status: action.status || "",
          priority: action.priority || "",
          readiness: action.readiness || action.preflight?.status || "",
          threadPolicy: action.threadPolicy || "",
          threadTopic: action.threadTopic || "",
          missing: Array.isArray(action.missing) ? action.missing.slice(0, 3) : [],
          blockedReason: action.blockedReason || action.preflight?.reason || "",
        })).slice(0, 3)
      : [],
  };
}

function operatorAnswerShipment(answer = {}) {
  const shipments = Array.isArray(answer.shipments) ? answer.shipments.filter(Boolean) : [];
  if (shipments.length === 1) return shipments[0];
  return null;
}

function operatorAnswerRole(answer = {}, shipment = {}) {
  const topic = String(answer.context?.topic || "").toLowerCase();
  const subtitle = String(answer.subtitle || "");
  if (/station/.test(topic) || /\bstation\b/i.test(subtitle)) return "Station";
  if (/customs|release/.test(topic) || /customs broker/i.test(subtitle)) return "Customs broker";
  if (/pickup|broker|quote|pod|delivery/.test(topic) || /pickup broker/i.test(subtitle)) return "Pickup broker";
  return shipment.airline || shipment.handler || "";
}

function operatorAnswerHeader(answer = {}, shipment = {}) {
  const awb = displayAwb(shipment.awb || answer.title || answer.context?.awb || "");
  const station = shipment.station || answer.context?.station || "";
  const role = operatorAnswerRole(answer, shipment);
  const client = /^(?:Station|Customs broker|Pickup broker)$/i.test(role)
    ? ""
    : compact(shipment.client || shipment.consignee || "", 48);
  return unique([awb, station, role, client].filter(Boolean)).join(" · ");
}

function operatorAnswerBodyLines(answer = {}) {
  const topic = String(answer.context?.topic || "").toLowerCase();
  const stationLike = /station|contact/.test(topic);
  return String(answer.answer || answer.content || "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => stationLike || !/^Evidence:/i.test(line))
    .filter((line) => !/^Source [AB]:/i.test(line))
    .filter((line) => !/^Plan:/i.test(line))
    .slice(0, stationLike ? 6 : 7)
    .map((line) => sentence(compact(line, stationLike ? 140 : 128)));
}

function operatorAnswerQuestion(answer = {}) {
  return String(answer.context?.question || "").replace(/\s+/g, " ").trim();
}

function answerPrefixedLine(answer = {}, label = "") {
  const matcher = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "i");
  const line = String(answer.answer || answer.content || "")
    .split(/\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .find((item) => matcher.test(item));
  const value = line?.match(matcher)?.[1] || "";
  return value.replace(/[.]+$/g, "").trim();
}

function valueIsKnown(value) {
  const text = String(value || "").trim();
  return Boolean(text && !/^(?:unknown|n\/a|not in memory|not found|missing)$/i.test(text));
}

function textHasPhoneNumber(value) {
  const withoutEmails = String(value || "").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
  return /\+?\d[\d\s().-]{6,}\d/.test(withoutEmails);
}

function textHasEmail(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(String(value || ""));
}

function piecePhrase(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = Number(text.replace(/,/g, ""));
  const noun = numeric === 1 ? "piece" : "pieces";
  return `${text} ${noun}`;
}

function stationFactOnlyLine(answer = {}, shipment = {}, question = "") {
  const text = String(question || "").toLowerCase();
  const topic = String(answer.context?.topic || "").toLowerCase();
  const asksContact = /(?:station|contact|phone|email|call|broker|driver)/.test(text) || /(?:station|contact)/.test(topic);
  if (!asksContact) return "";
  const role = contactRoleFromText(text) || contactRoleFromText(answer.context?.contactRole || "") || contactRoleFromText(operatorAnswerRole(answer, shipment));
  const label = role === "customs"
    ? "Customs broker"
    : role === "pickup"
      ? "Pickup broker"
      : "Station";
  if (label !== "Station") {
    const roleLine = answerPrefixedLine(answer, label);
    if (!roleLine) return `${label} contact not in memory.`;
    if (/\b(?:phone|number|call)\b/.test(text) && !textHasPhoneNumber(roleLine)) {
      return `No ${label.toLowerCase()} phone number in memory. ${label}: ${roleLine}.`;
    }
    if (/\bemail\b/.test(text) && !textHasEmail(roleLine)) {
      return `No ${label.toLowerCase()} email in memory. ${label}: ${roleLine}.`;
    }
    return sentence(roleLine);
  }
  const station = answerPrefixedLine(answer, "Station") || [shipment.airline, shipment.station].filter(Boolean).join(" ");
  const email = answerPrefixedLine(answer, "Email");
  const phone = answerPrefixedLine(answer, "Phone");
  const values = unique([
    valueIsKnown(station) ? station : "",
    valueIsKnown(email) ? email : "",
    valueIsKnown(phone) ? phone : "",
  ].filter(Boolean));
  if (values.length) return sentence(values.join(" · "));
  return "Station contact not in memory.";
}

function cargoFactOnlyLine(answer = {}, shipment = {}, question = "") {
  const text = String(question || "").toLowerCase();
  const facts = shipmentCargoFacts(shipment);
  if (/\b(?:pcs?|pieces?)\b/.test(text)) {
    const pieces = piecePhrase(facts.pieces);
    if (!pieces) return "Piece count not in memory.";
    if (/\b(?:pickup|pick up|picked up|recover|recovered|load|loaded)\b/.test(text)) {
      const gates = gateState(shipment);
      return `${pieces} ${gates.completed || gates.pickedUp ? "picked up" : "needs pickup"}.`;
    }
    return `${pieces}.`;
  }
  if (/\bweight\b/.test(text)) return facts.weight ? sentence(facts.weight) : "Weight not in memory.";
  if (/\b(?:dims?|dimensions?|measurements?)\b/.test(text)) return facts.dims ? sentence(facts.dims) : "Dimensions not in memory.";
  if (/\b(?:flight|mawb flight|airline flight)\b/.test(text)) return facts.flight ? sentence(facts.flight) : "Flight not in memory.";
  if (/\b(?:route|origin|destination)\b/.test(text)) {
    if (facts.route) return sentence(facts.route);
    const route = [facts.origin, facts.destination].filter(Boolean).join("-");
    return route ? sentence(route) : "Route not in memory.";
  }
  if (/\b(?:delivery address|deliver to|address)\b/.test(text)) return facts.deliveryAddress ? sentence(facts.deliveryAddress) : "Delivery address not in memory.";
  if (/\bshipper\b/.test(text)) return facts.shipper ? sentence(facts.shipper) : "Shipper not in memory.";
  if (/\b(?:consignee|client|customer)\b/.test(text)) return facts.consignee ? sentence(facts.consignee) : "Consignee not in memory.";
  if (/\b(?:how big|cargo details|dry details|shipment details)\b/.test(text)) return cargoLine(shipment) || "Cargo details not in memory.";
  return "";
}

function etaFactOnlyLine(shipment = {}, question = "") {
  const text = String(question || "").toLowerCase();
  if (!/\b(?:eta|arrival time|arrive|arrives|arriving|when.*arrival|when.*arrive)\b/.test(text)) return "";
  const tms = shipment.tms || {};
  const flightDetails = shipment.flightDetails || {};
  const eta = shipment.eta || flightDetails.eta || flightDetails.arrivalTime || tms.eta || tms.arrivalTime || "";
  if (eta) {
    if (shipment.etaConflict) return sentence(`ETA ${eta} (${shipment.etaConflict})`);
    if (shipment.etaUnresolvedRelative) {
      return sentence(`The only ETA signal in memory is the TMS task label "${eta}", which has no date; current dated ETA is not confirmed`);
    }
    return sentence(`ETA ${eta}`);
  }
  const gates = gateState(shipment);
  if (gates.arrived) return "Arrived.";
  return "ETA not in memory.";
}

function operatorFactOnlyLine(answer = {}, shipment = null) {
  if (!shipment) return "";
  const question = operatorAnswerQuestion(answer);
  if (!question) return "";
  if (/\b(?:status|what'?s happening|what is happening|what is stopping|blocking|blocker|problem|urgent|next action|what should|draft|send|approve|evidence|why)\b/i.test(question)) {
    return "";
  }
  return stationFactOnlyLine(answer, shipment, question) ||
    cargoFactOnlyLine(answer, shipment, question) ||
    etaFactOnlyLine(shipment, question);
}

function compactOperatorAnswer(answer = {}) {
  if (!answer || typeof answer !== "object") return answer;
  if (Array.isArray(answer.items) && answer.items.length) return answer;
  const shipment = operatorAnswerShipment(answer);
  if (!shipment) return answer;
  const contextAwb = normalizeAwb(answer.context?.awb || shipment.awb || "");
  if (!contextAwb) return answer;
  const factOnlyLine = operatorFactOnlyLine(answer, shipment);
  if (factOnlyLine) {
    return {
      ...answer,
      answer: compact(factOnlyLine, 220),
      facts: [],
      actions: [],
      operatorCompact: true,
      operatorFactOnly: true,
    };
  }
  const header = operatorAnswerHeader(answer, shipment);
  const body = unique(operatorAnswerBodyLines(answer)).join(" ");
  if (!header || !body) return answer;
  return {
    ...answer,
    answer: compact(`${header} · ${body}`, 560),
    facts: [],
    operatorCompact: true,
  };
}

function publicConversationClarification(value) {
  if (!value || typeof value !== "object" || !CONVERSATION_CLARIFICATION_KINDS.has(value.kind)) return undefined;
  const options = (value.options || []).map((option) => {
    const safe = publicConversationOption(option);
    if (!safe) return null;
    return {
      ...safe,
      label: compact(option.label || "", 80),
      question: compact(option.question || "", 80),
    };
  }).filter(Boolean).slice(0, 2);
  return options.length ? { kind: value.kind, options } : undefined;
}

function publicBrainAnswer(answer) {
  if (!answer || typeof answer !== "object") return answer;
  const compactAnswer = compactOperatorAnswer(answer);
  const { source: _source, modelUsed: _modelUsed, narrative: rawNarrative, ...safeCompactAnswer } = compactAnswer;
  const clarification = publicConversationClarification(compactAnswer.clarification);
  const narrative = compact(stripProviderLeakText(rawNarrative), 900);
  return {
    ...safeCompactAnswer,
    ...(narrative ? { narrative } : {}),
    plan: compactBrainPlan(compactAnswer.plan),
    facts: compactAnswer.operatorCompact ? [] : Array.isArray(compactAnswer.facts) ? compactAnswer.facts.slice(0, 3) : [],
    // A LIST answer's items ARE the answer — a count with 3 of 6 rows is a
    // production acceptance failure. Lists keep up to 12; single-topic
    // answers stay compact at 3.
    items: Array.isArray(compactAnswer.items) ? compactAnswer.items.slice(0, compactAnswer.context?.list ? 12 : 3) : [],
    allItems: Array.isArray(compactAnswer.allItems) ? compactAnswer.allItems.slice(0, 40) : Array.isArray(compactAnswer.items) ? compactAnswer.items.slice(0, compactAnswer.context?.list ? 12 : 3) : [],
    actions: Array.isArray(compactAnswer.actions) ? compactAnswer.actions.slice(0, 12) : [],
    shipments: Array.isArray(compactAnswer.shipments) ? compactAnswer.shipments.map(compactShipmentForBrainAnswer).filter(Boolean).slice(0, compactAnswer.context?.list ? 12 : 8) : [],
    truthPacket: compactTruthPacket(compactAnswer.truthPacket),
    evidencePacket: compactEvidencePacket(compactAnswer.evidencePacket),
    ...(compactAnswer.sessionState ? { sessionState: publicConversationSessionState(compactAnswer.sessionState) } : {}),
    ...(clarification ? { clarification } : {}),
  };
}

module.exports = {
  answerOpsBrainQuestion,
  buildActiveShipmentReasoning,
  buildShipmentReasoningNode,
  classifyAttachmentEvidence,
  classifyAttachmentTriage,
  composeCompanionNarrative,
  controlRoomPlan,
  deterministicAnswer,
  gateState,
  mergeShipments,
  normalizeAwb,
  publicBrainAnswer,
  readLocalMemory,
  readOpsBrainMemory,
  sanitizeTruthPacketSnapshot,
  truthPacketsRuntimeSafe,
  verifyGroundedProse,
  _test: {
    approvedPickupBrokers: APPROVED_PICKUP_BROKERS.map((broker) => ({ ...broker })),
    analyticalEvidence,
    analyticalFilterMatches,
    analyticalSourceFreshness,
    companionNarrativeCitations,
    companionNarrativeEnabled,
    companionNarrativePrompt,
    companionNarrativeRows,
    companionNarrativeStructuredFacts,
    composeCompanionNarrative,
    defaultOpsBrainSpendStore,
    executeRoutedDeterministic,
    memoryCacheTtlMs,
    questionHasFleetIntent,
    opsBrainAnswerCacheKey,
    quoteBlastActions,
    quoteBlastAlreadyExists,
    renderOperatorQueryAnswer,
    requestRecordsFromMemory,
    retrieveAnalyticalRows,
    rowsForRoute,
    routeResidualQuestion,
    trustedRouteParameters,
    validatedAnalyticalClaims,
    verifyGroundedProse,
    clearAnswerCache: () => opsBrainAnswerCache.clear(),
  },
};

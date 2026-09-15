#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  betaDraftModeContract,
  DEFAULT_TMS_REVIEW_EMAIL,
} = require("../lib/action-safety");
const {
  assertLegacyGmailIngestionAllowed,
} = require("../lib/gmail-ingestion-authority");

const ROOT_DIR = path.resolve(__dirname, "..");
const workerId = `${os.hostname()}-gmail-${process.pid}`;

function argValue(name, fallback = "") {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function loadDotEnvLocal() {
  try {
    const content = await fs.readFile(path.join(ROOT_DIR, ".env.local"), "utf8");
    content.split(/\r?\n/).forEach((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
    });
  } catch {
    // Env can be supplied by the caller.
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function headers() {
  const key = requireEnv("PQ_SUPABASE_ANON_KEY");
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

async function rest(pathname, searchParams = {}) {
  const url = new URL(`${requireEnv("PQ_SUPABASE_URL")}/rest/v1/${pathname}`);
  Object.entries(searchParams).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  });
  const response = await fetch(url, { headers: headers() });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${pathname} lookup failed: ${response.status} ${text}`);
  return payload;
}

async function rpc(name, body) {
  const response = await fetch(`${requireEnv("PQ_SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${name} failed: ${response.status} ${text}`);
  return payload;
}

async function readJson(fileName, fallback) {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT_DIR, fileName), "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeAwb(value) {
  return String(value || "").replace(/\D/g, "");
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function datePlusDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeGmailBeforeDate(endDate, now = new Date()) {
  const tomorrow = toIsoDate(datePlusDays(now, 1));
  if (!endDate) return tomorrow;
  return String(endDate) < tomorrow ? tomorrow : String(endDate);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function awbSearchTerms(awb) {
  const normalized = normalizeAwb(awb);
  const suffix = normalized.length > 3 ? normalized.slice(3) : "";
  return unique([
    awb,
    normalized,
    normalized.length > 3 ? `${normalized.slice(0, 3)}-${suffix}` : "",
    suffix,
  ]).filter((term) => term.length >= 7);
}

function termsForShipment(shipment) {
  const awb = shipment.awb || "";
  const tms = shipment.tms || {};
  const delivery = shipment.delivery || { consignee: shipment.consignee || "" };
  return unique([
    ...awbSearchTerms(awb),
    tms.reference,
    tms.order,
    tms.shipmentGuid,
    shipment.client,
    delivery.consignee,
    shipment.station,
  ]).slice(0, 8);
}

function needsFullContextAudit(shipment) {
  if (shipment.syncPlan?.gmail?.sourceBackfill || shipment.sourceCoverage?.needsHistoricalBackfill) return true;
  const customsStatus = shipment.customsBroker?.status || "customs-unknown";
  const freightStatus = shipment.freightBroker?.status || "freight-missing";
  const emailStatus = shipment.emailValidation?.status || "email-missing";
  return Boolean(
    shipment.arrivalStatus === "arrived" ||
      shipment.pickupStatus === "ready" ||
      shipment.trackingException ||
      emailStatus !== "email-confirmed" ||
      ["customs-pending", "customs-unknown", "customs-hold"].includes(customsStatus) ||
      ["freight-missing", "freight-requested", "freight-unknown"].includes(freightStatus) ||
      /\baudit-only\b|awb-mismatch|mismatch-paperwork/i.test(freightStatus),
  );
}

const ATTACHMENT_EXTRACTION_INSTRUCTIONS = [
  "If any relevant Gmail message has attachments or inline_images, call read_attachment for each operational PDF/image/document before deciding status.",
  "For scanned PDFs with no embedded text, use the returned page images as OCR/vision evidence; do not mark the attachment as reviewed just because text extraction is empty.",
  "Arrival notice attachments must be inspected for station/handler, AWB, pieces, weight, dims/pallets, availability/on-hand date, last free day/storage start, storage rate/charges, payment requirements, consignee, and station contact.",
  "If an arrival notice exists but last free day/storage details cannot be extracted, create an explicit station/LFD follow-up fact/action instead of leaving storage silent.",
  "Release/DO attachments must be inspected for released/cleared status, broker, delivery order/release proof, payment restrictions, and station recovery authority.",
  "POD/delivery attachments must be inspected for delivered/received/signed-by name, delivery date/time, driver loaded/onsite/left times, and detention hours/cost when present.",
  "Every attachment-derived fact must cite threadId, messageId, attachmentId, filename, mimeType, page when known, and a short visual/text evidence note.",
  "If an attachment exists but is unreadable or irrelevant, include that message id, attachment id, filename, and reason in audit coverage.",
];

function evidenceQueries(queryTerms, dateQuery, shipment) {
  const awbTerms = awbSearchTerms(shipment.awb);
  const evidenceWords = [
    "release",
    "released",
    "cleared",
    "\"delivery order\"",
    "\"D/O\"",
    "\"D.O.\"",
    "\"attached release\"",
    "\"release and DO\"",
    "\"98 RELEASED\"",
    "\"CUSTOMS REL\"",
    "ACE",
    "CargoSprint",
    "payment",
    "\"payment delivered\"",
    "customs",
    "\"Arrival Notification\"",
    "\"Last Free Day\"",
    "\"Storage Start Date\"",
    "\"Daily Storage Charge\"",
    "\"notice of arrival\"",
    "storage",
    "LFD",
    shipment.customsBroker?.broker,
    shipment.delivery?.consignee,
  ];
  const attachmentWords = [
    "\"arrival notice\"",
    "\"arrival notification\"",
    "\"notice of arrival\"",
    "NOA",
    "release",
    "\"delivery order\"",
    "\"D/O\"",
    "\"98 RELEASED\"",
    "\"last free\"",
    "storage",
    "POD",
    "\"proof of delivery\"",
    "invoice",
    "payment",
  ];
  const closingWords = [
    "\"STATUS UPDATE\"",
    "\"has been delivered\"",
    "\"delivered to RECEIVER\"",
    "\"proof of delivery\"",
    "POD",
    "delivered",
  ];
  return awbTerms.flatMap((term) => [
    [`"${term}"`, dateQuery, "-in:spam", "-in:trash"].filter(Boolean).join(" "),
    [`"${term}"`, "has:attachment", dateQuery, "-in:spam", "-in:trash"].filter(Boolean).join(" "),
    [
      `"${term}"`,
      `(${unique(attachmentWords).join(" OR ")})`,
      "has:attachment",
      dateQuery,
      "-in:spam",
      "-in:trash",
    ].filter(Boolean).join(" "),
    [
      `"${term}"`,
      `(${unique(evidenceWords).join(" OR ")})`,
      dateQuery,
      "-in:spam",
      "-in:trash",
    ].filter(Boolean).join(" "),
    [
      `"${term}"`,
      `(${closingWords.join(" OR ")})`,
      dateQuery,
      "-in:spam",
      "-in:trash",
    ].filter(Boolean).join(" "),
  ]);
}

function collectKnownThreadIdsForAwb(existing, awb) {
  const normalized = normalizeAwb(awb);
  const threadIds = [];
  const scan = (value, parentMatches = false) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach((item) => scan(item, parentMatches));
    if (typeof value !== "object") return;
    const currentMatches = parentMatches || normalizeAwb(value.awb) === normalized;
    if (currentMatches) {
      if (value.threadId) threadIds.push(value.threadId);
      if (value.evidence?.threadId) threadIds.push(value.evidence.threadId);
    }
    if (value.proof) scan(value.proof, currentMatches);
    if (value.evidence) scan(value.evidence, currentMatches);
    if (value.threads) scan(value.threads, currentMatches);
    if (value.facts) scan(value.facts, currentMatches);
  };
  scan(existing.gmailProof?.proofs || []);
  scan(existing.brokerDispatch?.dispatches || []);
  scan(existing.customsBroker?.brokers || []);
  scan(existing.eodFacts?.facts || []);
  return unique(threadIds).slice(0, 12);
}

function buildGmailQueries(job, shipments, existing = {}) {
  const requestedAwbs = new Set((job.payload?.awbs || []).map((awb) => normalizeAwb(awb)));
  return shipments
    .filter((shipment) => !requestedAwbs.size || requestedAwbs.has(normalizeAwb(shipment.awb)))
    .map((shipment) => {
      const syncPlan = shipment.syncPlan?.gmail || {};
      const window = syncPlan.window || {};
      const terms = unique([...(syncPlan.queryTerms || []), ...termsForShipment(shipment)]);
      const exactTerms = awbSearchTerms(shipment.awb);
      const queryTerms = exactTerms.length ? exactTerms : terms.slice(0, 3);
      const fullContextRequired = needsFullContextAudit(shipment);
      const inclusiveEndDate = normalizeGmailBeforeDate();
      const dateQuery = [
        window.startDate ? `after:${window.startDate}` : "",
        // Gmail's before: date is exclusive. Always search through tomorrow so stale
        // active snapshots cannot exclude same-day POD/release/status emails.
        `before:${inclusiveEndDate}`,
      ].filter(Boolean).join(" ");
      const suggestedQueries = fullContextRequired
        ? evidenceQueries(queryTerms, dateQuery, shipment)
        : queryTerms.map((term) =>
          [`"${term}"`, dateQuery, "-in:spam", "-in:trash"].filter(Boolean).join(" ")
        );
      const knownThreadIds = collectKnownThreadIdsForAwb(existing, shipment.awb);
      const requiredThreadReads = knownThreadIds.map((threadId) => ({
        threadId,
        idType: "thread",
        reason: "Known prior AWB thread; reread before deciding release, payment, pickup, delivery, POD, or storage did not change.",
      }));

      return {
        awb: shipment.awb,
        station: shipment.station,
        client: shipment.client,
        consignee: shipment.delivery?.consignee || "",
        fullContextRequired,
        currentState: {
          arrivalStatus: shipment.arrivalStatus || "unknown",
          pickupStatus: shipment.pickupStatus || "unknown",
          emailStatus: shipment.emailValidation?.status || "email-missing",
          customsStatus: shipment.customsBroker?.status || "customs-unknown",
          freightStatus: shipment.freightBroker?.status || "freight-missing",
        },
        queryTerms,
        supportTerms: terms,
        dateQuery,
        knownThreadIds,
        requiredThreadReads,
        suggestedQueries,
        extractionInstructions: fullContextRequired
	          ? [
	              "Read full Gmail threads in the 30-day window, not only same-day delta results.",
	              "Reread every knownThreadIds entry for this AWB before deciding nothing changed; later release/DO/payment/POD replies often land on old pre-alert threads.",
	              "Treat requiredThreadReads as mandatory full-thread reads in addition to the suggestedQueries search set.",
	              "Extract separate customs broker/release proof, freight dispatch/quote proof, station arrival/NOA proof, POD proof, station free-storage/last-free-day, and payment/cost proof.",
	              "Never collapse layers: release/DO, station payment, station arrival, quote, broker award, pickup, delivery, and POD are different facts.",
	              "For customs, distinguish exact proof, missing proof, and contradiction: 98 RELEASED/attached release/DO received is release proof; no release found is audit coverage only; station/broker says release is not visible or not in system is a release-mismatch/blocked-pickup fact.",
	              "CargoSprint/FlitePak/Choice/airline payment delivered to a station is station-payment proof only; it is not pickup, delivery, or POD proof.",
	              "A delivery address, delivery order, or 'deliver to' instruction is not delivered cargo. Only final-delivery/POD language such as POD attached/received, proof of delivery, delivered successfully, signed by, or delivery completed can close delivery.",
	            "If a broker/carrier says the cargo was picked up, recovered, loaded, or recovery is complete, create a broker dispatch record with status containing pickup-confirmed or picked-up and keep POD/delivery pending unless final-delivery/POD proof is also present.",
	            "Do not infer pickup completion from driver onsite, checking with driver, pickup requested, pickup scheduled, appointment set, rate confirmed, or can make it; those are dispatch/scheduling facts until a later message says picked up/recovered/loaded.",
	            "If a thread says no pickup completion, no delivery completion, POD pending, POD missing, or ask/send/collect POD, the dispatch record must stay pickup/delivery pending and must not use delivered, completed, pod-found, or freight-delivered-pod-found statuses.",
	            "For freight quote threads, capture every broker quote separately with broker name, email if known, amount, currency, service/context, quotedAt, and evidence. Preserve Jordan-sent quote requests and each broker reply.",
	            "A newer station or tracking thread must not erase older release/DO/customs proof for the same AWB.",
	            "If old summary text conflicts with newer layer facts, output the newer facts and include the contradiction in audit coverage rather than repeating stale negative wording.",
	              ...ATTACHMENT_EXTRACTION_INSTRUCTIONS,
	            ]
	          : [
	              "Read the relevant full thread and preserve any operational evidence by layer.",
	              "Do not treat station payment, delivery address, D/O, or pickup scheduling as final delivery/POD proof.",
	              ...ATTACHMENT_EXTRACTION_INSTRUCTIONS,
	            ],
      };
    });
}

async function context(job) {
  if (job.job_type === "send_gmail_email") {
    return draftEmailContext(job, {
      legacySendJob: true,
      note: "Beta draft mode converted this legacy send_gmail_email job into a Gmail draft request. Do not send it.",
    });
  }
  if (job.job_type === "draft_gmail_email") return draftEmailContext(job);

  const active = await readJson("shipment-truth-packets.json", { shipments: [] });
  const brain = await readJson("ops-brain-memory.json", { completed: [] });
  const existing = {
    gmailProof: await readJson("gmail-proof-snapshot.json", { proofs: [] }),
    brokerDispatch: await readJson("broker-dispatch-snapshot.json", { dispatches: [] }),
    customsBroker: await readJson("customs-broker-snapshot.json", { brokers: [] }),
    eodFacts: await readJson("eod-report-facts.json", { facts: [] }),
  };
  const requestedAwbs = new Set((job.payload?.awbs || []).map((awb) => normalizeAwb(awb)).filter(Boolean));
  const sourceBackfill = job.payload?.sourceBackfill === true;
  const lookbackDays = Math.max(7, Math.min(365, Number(job.payload?.lookbackDays || process.env.PQ_GMAIL_SOURCE_BACKFILL_LOOKBACK_DAYS || 120) || 120));
  const sourceBackfillStartDate = toIsoDate(datePlusDays(new Date(), -lookbackDays));
  const completedBackfillShipments = sourceBackfill
    ? (brain.completed || [])
      .filter((shipment) => requestedAwbs.has(normalizeAwb(shipment.awb)))
      .map((shipment) => ({
        ...shipment,
        delivery: shipment.delivery || { consignee: shipment.consignee || "" },
        arrivalStatus: "arrived",
        pickupStatus: shipment.pickupStatus || "delivered",
        syncPlan: {
          ...(shipment.syncPlan || {}),
          gmail: {
            ...(shipment.syncPlan?.gmail || {}),
            sourceBackfill: true,
            window: {
              ...(shipment.syncPlan?.gmail?.window || {}),
              startDate: shipment.syncPlan?.gmail?.window?.startDate || sourceBackfillStartDate,
            },
            queryTerms: unique([
              ...(shipment.syncPlan?.gmail?.queryTerms || []),
              ...awbSearchTerms(shipment.awb),
            ]),
          },
        },
      }))
    : [];
  const activeTruthRows = (active.shipments || []).filter((shipment) =>
    !shipment.truthPacketRole || shipment.truthPacketRole === "active"
  );
  const shipmentRows = [
    ...activeTruthRows,
    ...completedBackfillShipments.filter((shipment) =>
      !activeTruthRows.some((activeShipment) => normalizeAwb(activeShipment.awb) === normalizeAwb(shipment.awb))
    ),
  ];
  return {
    job,
    mailbox: "contact-052@demo-freight.example",
    activeSnapshotTime: active.snapshotTime || null,
    shipmentCount: shipmentRows.length,
    activeShipmentCount: activeTruthRows.length,
    sourceBackfillShipmentCount: completedBackfillShipments.length,
    sourceBackfillLookbackDays: sourceBackfill ? lookbackDays : null,
    queries: buildGmailQueries(job, shipmentRows, existing),
    existingCounts: {
      proofs: existing.gmailProof.proofs?.length || 0,
      dispatches: existing.brokerDispatch.dispatches?.length || 0,
      customsBrokers: existing.customsBroker.brokers?.length || 0,
      eodFacts: existing.eodFacts.facts?.length || 0,
    },
    outputContract: {
      file: "gmail-enrichment-update.json",
      completionCommand: [
        "node scripts/complete-gmail-refresh.js --allow-legacy-gmail-ingestion",
        `--job-id ${job.id}`,
        `--worker-id ${workerId}`,
        "--result gmail-enrichment-update.json",
      ].join(" "),
      shape: {
        jobId: job.id,
        proofs: "array of gmail-proof-snapshot proof records",
        dispatches: "array of broker-dispatch-snapshot dispatch records",
        brokers: "array of customs-broker-snapshot broker records",
        facts: "array of eod-report-facts facts",
        audit: "coverage, searched queries, read thread ids, skipped AWBs with reasons",
        attachmentEvidence: "attachment-derived facts embedded in proofs, dispatches, brokers, or facts with threadId/messageId/attachmentId/filename/page",
      },
      rules: [
	        "Use the suggestedQueries exactly as the base search set; they already include the shipment's 30-day window.",
	        "The suggestedQueries intentionally include full AWB, undashed AWB, and prefixless MAWB suffix terms. Search/read suffix-only results for ground handling, station payment, CargoSprint/Choice/handler receipt, storage, and arrival notice evidence because stations often reference only the shipment number without the three-digit airline prefix.",
	        "Station, handler, pickup-counter, and airport-contact facts may drive station/pickup actions only when they match the shipment endpoint/destination station. The endpoint station is the shipment's destination station, not an origin, transit, airline office, or named contact's station. Keep non-endpoint station evidence as context/audit only; never use it as the shipment's station contact, pickup path, reply target, or action owner.",
	        "Do not replace a customs release/DO fact with a newer station-only update. Preserve facts by operational layer.",
	        "Broker dispatch records may include quotes: [{ broker, contactEmail, amount, currency, rate, service, quotedAt, evidence }], awardedBroker, and selectedBroker. Include all broker quote replies, not only the lowest quote.",
	        "For ELP shipments, preserve the standing pickup broker/driver memory: Norman / Rivergate Logistics EP at contact-064@demo-freight.example. Do not downgrade ELP to pickup broker pending just because no quote thread exists; use the alert-to-Norman workflow once arrival/release are ready.",
	        "For fullContextRequired shipments, search and read the customs/release thread even when the newest email is only a station, carrier, or bounce update.",
	        "For every requiredThreadReads entry, call read_email_thread by thread id and include the thread id in audit coverage whether or not the status changes.",
	        "Customs release proof requires explicit positive evidence such as 98 RELEASED, attached release, release PDF, CBP/ACE release, or D/O received. 'No release proof found' belongs in audit coverage, while station/broker not seeing release is a release-mismatch fact.",
	        "Payment delivered to an airline/station is station-payment evidence only. It must not create delivered, completed, pod-found, or freight-delivered-pod-found status.",
	        "Delivery address, delivery order, and delivery instruction text must not be interpreted as final delivery.",
	        "Broker pickup/recovery confirmation is a middle state: output pickup-confirmed or picked-up with POD/delivery pending, not delivered.",
	        "Driver onsite/checking, pickup scheduled/requested, appointment set, rate confirmed, or can-make-it wording is not pickup completion.",
	        "If any read thread says no POD, POD pending/missing/requested, no pickup completion, or no delivery completion, the output must keep pickup/delivery/POD pending unless a later explicit POD/final-delivery message is read and cited.",
	        "When a relevant message has attachments or inline_images, call read_attachment and cite attachmentId, filename, mimeType, and page. Scanned PDFs with empty text must be reviewed from page images.",
	        "Arrival notice, release/DO, POD, storage, invoice, payment, quote, and delivery attachments are operational evidence; if they are not read, audit coverage must say exactly why.",
	      ],
    },
  };
}

function draftEmailContext(job, options = {}) {
  const payload = job.payload || {};
  const betaContract = {
    ...betaDraftModeContract(),
    ...(payload.betaContract || {}),
  };
  const required = ["to", "subject", "body"].filter((field) => !String(payload[field] || "").trim());
  const tmsExperienceDraft = payload.source === "dashboard-tms-experience" ||
    payload.transport === "tms-experience-draft" ||
    payload.originalChannel === "couriercloud" ||
    payload.originalChannel === "tms" ||
    payload.originalChannel === "couriercloud-tms";
  const contractViolations = [];
  if (tmsExperienceDraft && String(payload.to || "").toLowerCase() !== DEFAULT_TMS_REVIEW_EMAIL) {
    contractViolations.push("tms-experience-recipient-violation");
  }
  if (betaContract.mode !== "draft-only" || betaContract.liveExecution !== false || betaContract.requiresHumanApproval !== true) {
    contractViolations.push("beta-contract-violation");
  }
  if (betaContract.tmsReviewEmail !== DEFAULT_TMS_REVIEW_EMAIL) {
    contractViolations.push("tms-review-inbox-violation");
  }
  return {
    job,
    mailbox: "contact-052@demo-freight.example",
    betaDraftMode: {
      ...betaContract,
      legacySendJob: Boolean(options.legacySendJob),
      convertedFrom: options.legacySendJob ? "send_gmail_email" : "",
      note: options.note || "Create a Gmail draft only; do not send.",
    },
    draftRequest: {
      actionId: payload.actionId || "",
      shipmentId: payload.shipmentId || "",
      awb: payload.awb || "",
      to: payload.to || "",
      cc: payload.cc || "",
      bcc: payload.bcc || "",
      subject: payload.subject || "",
      body: payload.body || "",
      replyMessageId: payload.replyMessageId || null,
      attachmentFiles: payload.attachmentFiles || [],
      attachments: payload.attachments || [],
      outboxRequestId: payload.outboxRequestId || "",
      betaContract,
    },
    tmsExperienceDraft,
    outputContract: {
      file: "gmail-draft-result.json",
      shape: {
        jobId: job.id,
        drafted: "boolean",
        gmailDraftId: "draft id returned by Gmail connector when available",
        createdAt: "ISO timestamp",
        actionId: payload.actionId || "",
        awb: payload.awb || "",
        outboxRequestId: payload.outboxRequestId || "",
        betaContract,
      },
      rules: [
        "Create a Gmail draft only; do not send it.",
        "Use exactly the to, cc, bcc, subject, and body in draftRequest.",
        `If tmsExperienceDraft is true, draftRequest.to must be exactly ${DEFAULT_TMS_REVIEW_EMAIL}. Otherwise fail the job with tms-experience-recipient-violation.`,
        "betaDraftMode.mode must be draft-only, liveExecution must be false, and requiresHumanApproval must be true. Otherwise fail the job with beta-contract-violation.",
        "Do not add attachments unless attachment file paths or explicit base64 attachment payloads are present in draftRequest.attachmentFiles.",
        "Do not archive, label, delete, or otherwise mutate mailbox state beyond creating this draft.",
        "If required fields are missing or contractViolations is not empty, fail the job instead of creating a partial draft.",
      ],
      missingRequiredFields: required,
      contractViolations,
    },
  };
}

async function writeJson(fileName, value) {
  await fs.writeFile(path.join(ROOT_DIR, fileName), `${JSON.stringify(value, null, 2)}\n`);
}

function gmailResultStatus(result) {
  if (result?.drafted) return "drafted";
  if (result?.sent) return "sent";
  return "";
}

function betaDraftJob(job) {
  return ["draft_gmail_email", "send_gmail_email"].includes(job?.job_type);
}

function betaDraftContractEnabled(contract) {
  return contract?.mode === "draft-only" ||
    contract?.liveExecution === false ||
    contract?.requiresHumanApproval === true;
}

function betaDraftRecord(record) {
  return betaDraftContractEnabled(record?.betaContract) ||
    String(record?.execution || "").toLowerCase().includes("draft") ||
    String(record?.transport || "").toLowerCase().includes("draft") ||
    ["draft-only", "tms-experience"].includes(String(record?.safety?.mode || "").toLowerCase()) ||
    ["gmail", "couriercloud", "tms", "couriercloud-tms"].includes(String(record?.channel || "").toLowerCase());
}

function betaDraftSentViolation(record, result) {
  return Boolean(result?.sent && (betaDraftRecord(record) || betaDraftContractEnabled(result?.betaContract)));
}

function payloadForJob(job) {
  return job?.payload && typeof job.payload === "object" ? job.payload : {};
}

function metadataFromJob(job) {
  const payload = payloadForJob(job);
  return {
    jobId: job?.id || payload.jobId || "",
    actionId: payload.actionId || payload.action?.id || "",
    awb: payload.awb || payload.action?.awb || "",
    outboxRequestId: payload.outboxRequestId || payload.requestId || "",
  };
}

function resultWithJobMetadata(result, job) {
  const metadata = metadataFromJob(job);
  return {
    ...(result || {}),
    betaContract: result?.betaContract || payloadForJob(job).betaContract || (betaDraftJob(job) ? betaDraftModeContract() : undefined),
    jobId: result?.jobId || metadata.jobId,
    actionId: result?.actionId || metadata.actionId,
    awb: result?.awb || metadata.awb,
    outboxRequestId: result?.outboxRequestId || result?.requestId || metadata.outboxRequestId,
  };
}

function validateBetaDraftCompletion(job, result) {
  if (!betaDraftJob(job)) return;
  if (result?.sent) {
    throw new Error("beta-draft-completion-sent-violation");
  }
  if (result?.drafted !== true) {
    throw new Error("beta-draft-completion-missing-drafted");
  }
  const contract = result?.betaContract || payloadForJob(job).betaContract || betaDraftModeContract();
  if (contract.mode !== "draft-only" || contract.liveExecution !== false || contract.requiresHumanApproval !== true) {
    throw new Error("beta-draft-completion-contract-violation");
  }
}

function failureResultForJob(job, error, now = new Date().toISOString()) {
  return {
    ...metadataFromJob(job),
    failed: true,
    failedAt: now,
    completedAt: now,
    lastError: error,
  };
}

function applyGmailResultToOutbox(outbox, result, now = new Date().toISOString()) {
  const status = gmailResultStatus(result);
  if (!status) return { changed: false, outbox };
  const outboxRequestId = result.outboxRequestId || result.requestId || "";
  const actionId = result.actionId || "";
  if (!outboxRequestId && !actionId) return { changed: false, outbox };

  let changed = false;
  const requests = (outbox.requests || []).map((request) => {
    const matches =
      (outboxRequestId && request.id === outboxRequestId) ||
      (actionId && request.actionId === actionId);
    if (!matches) return request;
    changed = true;
    if (betaDraftSentViolation(request, result)) {
      return {
        ...request,
        status: "failed",
        failedAt: result.sentAt || now,
        completedAt: result.sentAt || now,
        lastError: "beta-draft-completion-sent-violation",
      };
    }
    return {
      ...request,
      status,
      draftedAt: status === "drafted" ? result.createdAt || now : request.draftedAt || "",
      sentAt: status === "sent" ? result.sentAt || now : request.sentAt || "",
      completedAt: result.createdAt || result.sentAt || now,
      gmailMessageId: result.gmailMessageId || result.messageId || request.gmailMessageId || "",
      gmailDraftId: result.gmailDraftId || result.draftId || request.gmailDraftId || "",
      failedAt: "",
      lastError: "",
    };
  });
  return {
    changed,
    outbox: {
      ...outbox,
      snapshotTime: changed ? now : outbox.snapshotTime,
      requests,
    },
  };
}

function applyGmailFailureToOutbox(outbox, result, now = new Date().toISOString()) {
  const outboxRequestId = result?.outboxRequestId || result?.requestId || "";
  const actionId = result?.actionId || "";
  if (!outboxRequestId && !actionId) return { changed: false, outbox };

  let changed = false;
  const requests = (outbox.requests || []).map((request) => {
    const matches =
      (outboxRequestId && request.id === outboxRequestId) ||
      (actionId && request.actionId === actionId);
    if (!matches) return request;
    changed = true;
    return {
      ...request,
      status: "failed",
      failedAt: result.failedAt || now,
      completedAt: result.completedAt || result.failedAt || now,
      lastError: result.lastError || result.error || request.lastError || "Gmail job failed",
    };
  });
  return {
    changed,
    outbox: {
      ...outbox,
      snapshotTime: changed ? now : outbox.snapshotTime,
      requests,
    },
  };
}

function applyGmailResultToActionQueue(actionQueue, result, now = new Date().toISOString()) {
  const status = gmailResultStatus(result);
  const actionId = result?.actionId || "";
  if (!status || !actionId) return { changed: false, actionQueue };
  let changed = false;
  const actions = (actionQueue.actions || []).map((action) => {
    if (action.id !== actionId) return action;
    changed = true;
    if (betaDraftSentViolation(action, result)) {
      return {
        ...action,
        status: "failed",
        failedAt: result.sentAt || now,
        completedAt: result.sentAt || now,
        lastError: "beta-draft-completion-sent-violation",
        outboxRequestId: result.outboxRequestId || result.requestId || action.outboxRequestId || "",
      };
    }
    return {
      ...action,
      status,
      draftedAt: status === "drafted" ? result.createdAt || now : action.draftedAt || "",
      sentAt: status === "sent" ? result.sentAt || now : action.sentAt || "",
      completedAt: result.createdAt || result.sentAt || now,
      gmailDraftId: result.gmailDraftId || result.draftId || action.gmailDraftId || "",
      gmailMessageId: result.gmailMessageId || result.messageId || action.gmailMessageId || "",
      outboxRequestId: result.outboxRequestId || result.requestId || action.outboxRequestId || "",
      failedAt: "",
      lastError: "",
    };
  });
  return {
    changed,
    actionQueue: {
      ...actionQueue,
      snapshotTime: changed ? now : actionQueue.snapshotTime,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actions.filter((action) => action.status === "queued").length,
        drafted: actions.filter((action) => action.status === "drafted").length,
        sent: actions.filter((action) => action.status === "sent").length,
        failed: actions.filter((action) => action.status === "failed").length,
      },
      actions,
    },
  };
}

function applyGmailFailureToActionQueue(actionQueue, result, now = new Date().toISOString()) {
  const actionId = result?.actionId || "";
  if (!actionId) return { changed: false, actionQueue };
  let changed = false;
  const actions = (actionQueue.actions || []).map((action) => {
    if (action.id !== actionId) return action;
    changed = true;
    return {
      ...action,
      status: "failed",
      failedAt: result.failedAt || now,
      completedAt: result.completedAt || result.failedAt || now,
      lastError: result.lastError || result.error || action.lastError || "Gmail job failed",
      outboxRequestId: result.outboxRequestId || result.requestId || action.outboxRequestId || "",
    };
  });
  return {
    changed,
    actionQueue: {
      ...actionQueue,
      snapshotTime: changed ? now : actionQueue.snapshotTime,
      counts: {
        ...(actionQueue.counts || {}),
        queued: actions.filter((action) => action.status === "queued").length,
        drafted: actions.filter((action) => action.status === "drafted").length,
        sent: actions.filter((action) => action.status === "sent").length,
        failed: actions.filter((action) => action.status === "failed").length,
      },
      actions,
    },
  };
}

async function syncSnapshot(snapshotKey, payload) {
  if (!process.env.PQ_SUPABASE_URL || !process.env.PQ_SUPABASE_ANON_KEY || !process.env.PQ_SUPABASE_SYNC_TOKEN) return false;
  const response = await fetch(`${process.env.PQ_SUPABASE_URL}/rest/v1/rpc/upsert_app_snapshot`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      p_snapshot_key: snapshotKey,
      p_payload: payload,
      p_sync_token: process.env.PQ_SUPABASE_SYNC_TOKEN,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Hosted snapshot sync failed for ${snapshotKey}: ${response.status} ${detail}`);
  }
  return true;
}

async function syncSnapshotBestEffort(snapshotKey, payload) {
  try {
    return await syncSnapshot(snapshotKey, payload);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function markOutboxFromGmailResult(result) {
  if (!gmailResultStatus(result)) return;
  const now = new Date().toISOString();
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const actionQueue = await readJson("action-queue.json", { actions: [] });
  const outboxResult = applyGmailResultToOutbox(outbox, result, now);
  const actionQueueResult = applyGmailResultToActionQueue(actionQueue, result, now);

  if (outboxResult.changed) {
    await writeJson("outbox-requests.json", outboxResult.outbox);
    await syncSnapshotBestEffort("outbox-requests", outboxResult.outbox);
  }

  if (actionQueueResult.changed) {
    await writeJson("action-queue.json", actionQueueResult.actionQueue);
    await syncSnapshotBestEffort("action-queue", actionQueueResult.actionQueue);
  }
}

async function markOutboxFromGmailFailure(job, error) {
  const failure = failureResultForJob(job, error);
  if (!failure.outboxRequestId && !failure.actionId) return;
  const now = failure.failedAt;
  const outbox = await readJson("outbox-requests.json", { requests: [] });
  const actionQueue = await readJson("action-queue.json", { actions: [] });
  const outboxResult = applyGmailFailureToOutbox(outbox, failure, now);
  const actionQueueResult = applyGmailFailureToActionQueue(actionQueue, failure, now);

  if (outboxResult.changed) {
    await writeJson("outbox-requests.json", outboxResult.outbox);
    await syncSnapshotBestEffort("outbox-requests", outboxResult.outbox);
  }

  if (actionQueueResult.changed) {
    await writeJson("action-queue.json", actionQueueResult.actionQueue);
    await syncSnapshotBestEffort("action-queue", actionQueueResult.actionQueue);
  }
}

async function claim() {
  const jobs = await rpc("claim_gmail_agent_job", {
    p_worker_id: workerId,
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
  });
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return { ok: true, claimed: false, workerId };
  return { ok: true, claimed: true, workerId, ...(await context(job)) };
}

async function status() {
  const limit = Number(argValue("--limit", "10"));
  const select = "id,job_type,status,priority,attempts,max_attempts,created_at,updated_at,available_at,locked_by,locked_at,completed_at,last_error";
  const jobs = await rest("agent_jobs", {
    select,
    job_type: "in.(email_refresh,send_gmail_email,draft_gmail_email)",
    order: "created_at.desc",
    limit: Number.isFinite(limit) && limit > 0 ? String(Math.min(limit, 50)) : "10",
  });
  const activeRefreshJobs = await rest("agent_jobs", {
    select,
    job_type: "eq.email_refresh",
    status: "in.(queued,running,waiting_external)",
    order: "created_at.desc",
    limit: "25",
  });
  const pendingById = new Map();
  [...(activeRefreshJobs || []), ...(jobs || [])]
    .filter((job) => ["queued", "running", "waiting_external"].includes(job.status))
    .forEach((job) => pendingById.set(job.id, job));
  return {
    ok: true,
    workerId,
    pending: [...pendingById.values()],
    activeRefreshJobs: activeRefreshJobs || [],
    recent: jobs || [],
  };
}

async function jobById(jobId) {
  if (!jobId) return null;
  const jobs = await rest("agent_jobs", {
    select: "id,job_type,payload",
    id: `eq.${jobId}`,
    limit: "1",
  });
  return Array.isArray(jobs) ? jobs[0] || null : null;
}

async function complete(jobId, result) {
  const job = await jobById(jobId);
  const projectedResult = resultWithJobMetadata(result || {}, job || { id: jobId });
  validateBetaDraftCompletion(job, projectedResult);
  const completion = await rpc("complete_agent_job", {
    p_job_id: jobId,
    p_worker_id: argValue("--worker-id", workerId),
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
    p_result: projectedResult,
  });
  await markOutboxFromGmailResult(projectedResult);
  return completion;
}

async function fail(jobId, error) {
  const job = await jobById(jobId);
  const failed = await rpc("fail_agent_job", {
    p_job_id: jobId,
    p_worker_id: argValue("--worker-id", workerId),
    p_sync_token: requireEnv("PQ_SUPABASE_SYNC_TOKEN"),
    p_error: error,
    p_retry_after_seconds: 300,
  });
  await markOutboxFromGmailFailure(job || { id: jobId }, error);
  return failed;
}

async function main() {
  assertLegacyGmailIngestionAllowed("scripts/gmail-job.js");
  await loadDotEnvLocal();
  const command = process.argv[2] || "claim";
  let result = null;
  if (command === "claim") result = await claim();
  else if (command === "status") result = await status();
  else if (command === "complete") {
    const jobId = argValue("--job-id");
    const resultPath = argValue("--result", "gmail-enrichment-update.json");
    result = await complete(jobId, await readJson(resultPath, {}));
  } else if (command === "fail") {
    result = await fail(argValue("--job-id"), argValue("--error", "Gmail processor failed"));
  } else {
    throw new Error("Usage: gmail-job.js claim|status|complete|fail");
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  applyGmailFailureToActionQueue,
  applyGmailFailureToOutbox,
  applyGmailResultToActionQueue,
  applyGmailResultToOutbox,
  context,
  draftEmailContext,
  failureResultForJob,
  resultWithJobMetadata,
  validateBetaDraftCompletion,
};

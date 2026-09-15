"use strict";

function clean(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedStatus(value = "") {
  return clean(value).toLowerCase().replace(/_/g, "-");
}

function gateFromMap(gates = {}, name = "") {
  if (!gates) return null;
  if (Array.isArray(gates)) {
    return gates.find((item) => String(item?.gate || item?.name || "").toLowerCase() === name) || null;
  }
  return gates?.[name] || null;
}

function gateText(gate = {}) {
  return clean([
    gate?.status,
    gate?.rawStatus,
    gate?.source,
    gate?.reason,
    gate?.evidence,
    gate?.summary,
    gate?.label,
  ].filter(Boolean).join(" "));
}

function terminalStatus(status = "") {
  return ["done", "true", "delivered", "received", "found", "pod-found", "completed", "closed"].includes(normalizedStatus(status));
}

function terminalPhase(row = {}) {
  const phase = normalizedStatus(
    row.opsState?.phase ||
      row.stage ||
      row.phase ||
      row.truthPacket?.currentState ||
      row.truthPacket?.resolvedCurrentState ||
      "",
  );
  return ["delivered", "completed", "closed"].includes(phase);
}

function terminalCandidate(row = {}) {
  const deliveryGate = gateFromMap(row.gates, "delivery") ||
    gateFromMap(row.opsState?.gates, "delivery") ||
    gateFromMap(row.truthPacket?.gates, "delivery");
  const podGate = gateFromMap(row.gates, "pod") ||
    gateFromMap(row.opsState?.gates, "pod") ||
    gateFromMap(row.truthPacket?.gates, "pod");
  return Boolean(
    row.completed ||
      normalizedStatus(row.truthPacketRole) === "completed" ||
      terminalPhase(row) ||
      terminalStatus(deliveryGate?.status || deliveryGate?.rawStatus) ||
      terminalStatus(podGate?.status || podGate?.rawStatus)
  );
}

function hasStationFacilityArrivalReceiptEvidence(text = "") {
  const value = clean(text);
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

function stationPaymentDeliveryOnly(text = "") {
  const value = clean(text);
  if (/\b(?:shipment|freight|cargo|load)\b[^.;\n]{0,80}\bdelivered\b|\b(?:delivery completed|completed (?:the )?delivery)\b/i.test(value)) return false;
  return /\byour payment has been delivered to\b/i.test(value) ||
    /\bpayment (?:has been )?delivered(?:\s+to|\s+for)?\b/i.test(value) ||
    (
      /\b(?:cargosprint|cargo sprint|station payment|ground handling payment|terminal payment|amount paid|reference number)\b/i.test(value) &&
      /\bdelivered to\b/i.test(value) &&
      /\b(?:airlines?|airways?|worldwide flight services|\bwfs\b|station|terminal|building|c\/o)\b/i.test(value)
    );
}

function negativeOrFutureDelivery(text = "") {
  const value = clean(text);
  return /\b(?:not|never|no|hasn'?t|haven'?t|have not|has not)\b[^.;\n]{0,80}\b(?:delivered|delivery completed|completed delivery)\b/i.test(value) ||
    /\b(?:delivery|delivered)\b[^.;\n]{0,80}\b(?:pending|not complete|not completed|not done|not yet|still needed|still pending)\b/i.test(value) ||
    /\b(?:will deliver|will be delivered|will get delivered|delivery tomorrow|scheduled (?:for )?delivery|out for delivery|delivering today)\b/i.test(value) ||
    /\b(?:to be|expected to be|scheduled to be|going to be|planned to be)\b[^.;\n]{0,80}\bdelivered\b/i.test(value) ||
    /\bdelivery\b[^.;\n]{0,60}\b(?:scheduled|planned|expected)\b/i.test(value);
}

function concretePodText(text = "") {
  const value = clean(text);
  if (!value || hasStationFacilityArrivalReceiptEvidence(value)) return false;
  if (/\b(?:collect|get|request|ask|follow up|follow-up|send|will send|waiting for|need|needs|needed)\b[^.;\n]{0,80}\b(?:pod|proof of delivery|delivery proof|signed pod)\b/i.test(value)) return false;
  return /\b(?:pods?\s+(?:are\s+)?attached|pods?\s+(?:were\s+)?(?:found|received|provided|uploaded)|attached\s+(?:are\s+)?(?:the\s+)?pods?|provided\s+(?:the\s+)?pods?|uploaded\s+(?:the\s+)?pods?|empty\s+pods?\s+attached|pod found|pod received|attached pod|attached is (?:the )?pod|proof of delivery attached|proofs? of delivery attached|proof of delivery received|signed pod|signed delivery receipt|receiver signature|delivered with pod|pod is attached)\b/i.test(value);
}

function concreteDeliveryText(text = "") {
  const value = clean(text);
  if (!value || hasStationFacilityArrivalReceiptEvidence(value)) return false;
  if (stationPaymentDeliveryOnly(value) || negativeOrFutureDelivery(value)) return false;
  return /\b(?:(?:shipment|freight|load|cargo) (?:has been |was |is )?(?:successfully )?delivered|delivered successfully|successfully delivered|delivered to|deliver was completed|delivery completed|completed (?:the )?delivery|was delivered)\b/i.test(value) ||
    /\b(?:all\s+)?\d+\s*(?:pcs?|pieces?)\s+(?:have been |were |are )?(?:successfully )?delivered\b/i.test(value);
}

function courierCloudDeliveredText(text = "") {
  const value = clean(text);
  if (!value || hasStationFacilityArrivalReceiptEvidence(value) || stationPaymentDeliveryOnly(value)) return false;
  return /(?:\b(?:courier\s*cloud|couriercloud|demo operations inc\.?\s*-\s*track#|track#\s*:?\s*\d{3}[-\s]?\d{8}|status update)\b|\bstatus\s*:)/i.test(value) &&
    /\byour shipment has been delivered to\b|\bshipment (?:has been |was )?delivered to\b/i.test(value);
}

function generatedSource(value = "") {
  return /\b(?:canonical-shipment-pipeline|canonical-|automation|generated|shipment-state|operator-truth-packet|companion|ai summary)\b/i.test(clean(value));
}

function sourceLooksExternal(item = {}) {
  const sourceText = clean([
    item.sourceSystem,
    item.source,
    item.sourceRef?.source,
    item.provenance,
    item.kind,
    item.pdfEvidence?.kind,
    item.label,
  ].filter(Boolean).join(" "));
  if (generatedSource(sourceText)) return false;
  return /\b(?:gmail|email|operator|manual|courier\s*cloud|couriercloud|piki|pq|pod pdf|pod attachment)\b/i.test(sourceText);
}

function factText(item = {}) {
  return clean([
    item.type,
    item.label,
    item.status,
    item.rawStatus,
    item.summary,
    item.text,
    item.evidence,
    item.claim,
    item.rawSnippet,
    item.note,
    item.reason,
    item.filename,
    item.extractedText,
    item.extractedTextPreview,
    item.pdfEvidence?.label,
    item.pdfEvidence?.status,
    item.pdfEvidence?.note,
    item.pdfEvidence?.textPreview,
    item.sourceRef?.source,
  ].filter(Boolean).join(" "));
}

function candidateFrom(item = {}, origin = "") {
  return {
    origin,
    type: item.type || item.eventType || item.label || item.status || "",
    sourceSystem: item.sourceSystem || item.source || item.sourceRef?.source || "",
    threadId: item.threadId || item.sourceRef?.threadId || "",
    messageId: item.messageId || item.sourceRef?.messageId || "",
    attachmentId: item.attachmentId || item.sourceRef?.attachmentId || "",
    filename: item.filename || item.sourceRef?.filename || "",
    at: item.at || item.observedAt || item.updatedAt || "",
    text: factText(item),
    external: sourceLooksExternal(item),
  };
}

function terminalEvidenceCandidates(row = {}) {
  const deliveryGate = gateFromMap(row.gates, "delivery") ||
    gateFromMap(row.opsState?.gates, "delivery") ||
    gateFromMap(row.truthPacket?.gates, "delivery");
  const podGate = gateFromMap(row.gates, "pod") ||
    gateFromMap(row.opsState?.gates, "pod") ||
    gateFromMap(row.truthPacket?.gates, "pod");
  return [
    candidateFrom({ ...deliveryGate, type: "delivery-gate", text: gateText(deliveryGate) }, "delivery-gate"),
    candidateFrom({ ...podGate, type: "pod-gate", text: gateText(podGate) }, "pod-gate"),
    ...(row.events || []).map((item) => candidateFrom(item, "events")),
    ...(row.emailValidation?.events || []).map((item) => candidateFrom(item, "emailValidation.events")),
    ...(row.historicalEvents || []).map((item) => candidateFrom(item, "historicalEvents")),
    ...(row.proof || []).map((item) => candidateFrom(item, "proof")),
    ...(row.emailValidation?.proof || []).map((item) => candidateFrom(item, "emailValidation.proof")),
    ...(row.historicalProof || []).map((item) => candidateFrom(item, "historicalProof")),
    ...(row.evidencePacket?.sourceFacts || []).map((item) => candidateFrom(item, "evidencePacket.sourceFacts")),
    ...(row.truthPacket?.sourceFacts || []).map((item) => candidateFrom(item, "truthPacket.sourceFacts")),
    ...(row.sourceFacts || []).map((item) => candidateFrom(item, "sourceFacts")),
  ].filter((item) => item.text);
}

function candidateCertifiesTerminal(candidate = {}) {
  const text = candidate.text || "";
  if (!candidate.external) return false;
  if (hasStationFacilityArrivalReceiptEvidence(text)) return false;
  const type = normalizedStatus(candidate.type);
  const podTyped = /\b(?:pod-received|pod-received|delivered-pod-received|pod_received|delivered_pod_received)\b/i.test(type);
  const deliveryTyped = /\b(?:delivered-reported|delivery-reported|delivered_reported|delivery_reported|delivered-pod-received)\b/i.test(type);
  const attachmentTyped = /\bpod\b/i.test(`${candidate.origin || ""} ${candidate.type || ""} ${candidate.filename || ""}`);
  if ((podTyped || attachmentTyped) && concretePodText(text)) return true;
  if (deliveryTyped && concreteDeliveryText(text)) return true;
  if (concretePodText(text) || concreteDeliveryText(text) || courierCloudDeliveredText(text)) return true;
  return false;
}

function terminalEvidenceCertification(row = {}) {
  if (!terminalCandidate(row)) {
    return {
      status: "not-terminal",
      certified: false,
      reason: "Shipment row is not projecting terminal delivery/POD state.",
      eventType: "",
      sourceSystem: "",
      threadId: "",
      messageId: "",
    };
  }
  const candidates = terminalEvidenceCandidates(row);
  const certified = candidates.find(candidateCertifiesTerminal);
  if (certified) {
    return {
      status: "certified",
      certified: true,
      reason: "Terminal delivery/POD state cites concrete external final-delivery evidence.",
      eventType: certified.type || "",
      sourceSystem: certified.sourceSystem || "",
      origin: certified.origin || "",
      threadId: certified.threadId || "",
      messageId: certified.messageId || "",
      attachmentId: certified.attachmentId || "",
      filename: certified.filename || "",
      evidence: certified.text.slice(0, 260),
    };
  }
  const stationReceipt = candidates.find((candidate) => hasStationFacilityArrivalReceiptEvidence(candidate.text));
  return {
    status: "uncertified",
    certified: false,
    reason: stationReceipt
      ? "Terminal delivery/POD state cites a station/destination-facility arrival receipt, not final consignee delivery or POD."
      : "Terminal delivery/POD state lacks concrete external final-delivery/POD evidence.",
    eventType: stationReceipt?.type || "",
    sourceSystem: stationReceipt?.sourceSystem || "",
    origin: stationReceipt?.origin || "",
    threadId: stationReceipt?.threadId || "",
    messageId: stationReceipt?.messageId || "",
    attachmentId: stationReceipt?.attachmentId || "",
    filename: stationReceipt?.filename || "",
    evidence: (stationReceipt?.text || candidates[0]?.text || "").slice(0, 260),
  };
}

module.exports = {
  terminalCandidate,
  terminalEvidenceCertification,
  terminalEvidenceCandidates,
  hasStationFacilityArrivalReceiptEvidence,
  concretePodText,
  concreteDeliveryText,
  courierCloudDeliveredText,
};

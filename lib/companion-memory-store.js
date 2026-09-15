"use strict";

const crypto = require("node:crypto");
const { normalizeAwb, normalizeAwbFrom } = require("./awb");

function compact(value, max = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function stableId(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.filter(Boolean).join("|").toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function uniqueFacts(facts) {
  const seen = new Set();
  return facts.filter((fact) => {
    const key = [fact.type, fact.label, fact.summary].filter(Boolean).join("|").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function contactEmailList(value) {
  return [...new Set(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])]
    .map((email) => email.toLowerCase());
}

function pickupBrokerContactName(value, email) {
  const beforeEmail = String(value || "").split(email)[0] || "";
  return beforeEmail
    .replace(/\b(?:saved|save|use|this|pickup|freight|release|broker|contact|email|for|awb|source)\b/gi, " ")
    .replace(/\d{3}[-\s]?\d{8}/g, " ")
    .replace(/[<>"':.,;()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-80)
    .trim();
}

function looksLikeQuestion(text) {
  const value = String(text || "").trim();
  const hebrew = hebrewLogisticsText(value);
  return Boolean(
    /\?\s*$/.test(value) ||
      /^(?:what|who|why|when|where|how|is|are|was|were|did|does|do|has|have|can|should|could|would|give|show|list|tell)\b/i.test(value) ||
      /^(?:מה|מי|למה|מתי|איפה|איך|האם|אפשר|תראה|תגיד|תן|כמה)(?:\s|$)/.test(hebrew) ||
      hasHebrewStatusRequestText(hebrew),
  );
}

function hebrewLogisticsText(value) {
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

function hasHebrewPickupFutureOrNegativeText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:^|[\s.,;:])(?:לא|טרמ|עדיינ לא|בלי|חסר)(?:$|[\s.,;:]).{0,24}(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ)|(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ).{0,24}(?:לא|טרמ|עדיינ|חסר|ממתינ|בהמתנה)/.test(value) ||
    /(?:יאספ|ייאספ|להיאספ|אמור להיאספ|צפוי להיאספ|מתוכננ.{0,20}איסופ|בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|נהג בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|איסופ מחר|יאספו|ייאספו)/.test(value);
}

function hasHebrewPickupScheduledText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  if (/(?:^|[\s.,;:])(?:לא|טרמ|עדיינ לא|בלי|חסר)(?:$|[\s.,;:]).{0,24}(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ)|(?:נאספ|נלקח|הועמס|איסופ|פיקאפ|טעינ).{0,24}(?:לא|טרמ|עדיינ|חסר|ממתינ|בהמתנה)/.test(value)) return false;
  return /(?:יאספ|ייאספ|להיאספ|אמור להיאספ|צפוי להיאספ|מתוכננ.{0,20}איסופ|בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|נהג בדרכ.{0,18}(?:לאיסופ|לפיקאפ)|איסופ מחר|יאספו|ייאספו)/.test(value);
}

function hasHebrewPickupConfirmedText(text) {
  const value = hebrewLogisticsText(text);
  if (!value || hasHebrewPickupFutureOrNegativeText(value)) return false;
  if (/המטענ.{0,12}המריא|פרי אלרט|פריאלרט|תעבירו/.test(value)) return false;
  return /(?:נהג|הנהג|משאית|המשאית|טרק|הטרק).{0,36}(?:אספ|לקח|העמיס|נטענ)|(?:מטענ|המשלוח|סחורה|קרגו|משטח).{0,36}(?:נאספ|נאספה|נאספו|נלקח|הועמס|נטענ)|(?:נאספ|נאספה|נאספו|נלקח|הועמס|נטענ).{0,56}(?:מהתחנה|מהמסופ|מהקרגו|מהמחסנ|משדה|מהשדה|מהאיירפורט)|(?:יצא|יצאה|יצאו).{0,28}(?:מהתחנה|מהמסופ|מהקרגו|מהמחסנ).{0,36}(?:למסירה|ללקוח|בדרכ|עם הנהג)|(?:^|[\s.,;:])נאספ(?:ה|ו)?(?:$|[\s.,;:])/.test(value);
}

function hasHebrewDeliveryScheduledText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  if (/(?:לא|טרמ|עדיינ לא).{0,24}(?:ימסר|יימסר|מסירה|להימסר)/.test(value)) return false;
  return /(?:ימסר|יימסר|תימסר|תמסר|ימסור|יימסור|להימסר).{0,36}(?:מחר|היומ|בהמשכ|בבוקר|אחר הצהריימ)|(?:נמסר).{0,24}מחר|מחר.{0,24}(?:נמסר)|(?:מסירה|המסירה).{0,36}(?:מחר|היומ|מתוכננת|מתוכננ|צפויה|צפוי)|(?:צפוי|אמור|מתוכננ).{0,40}(?:להימסר|מסירה)/.test(value);
}

function hasHebrewDeliveredNegativeText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:לא|טרמ|עדיינ לא|בלי).{0,28}(?:נמסר|מסירה|נפרק)|(?:נמסר|מסירה|נפרק).{0,28}(?:לא|טרמ|עדיינ|חסר|ממתינ|בהמתנה)/.test(value);
}

function hasHebrewDeliveredReportedText(text) {
  const value = hebrewLogisticsText(text);
  if (!value || hasHebrewDeliveredNegativeText(value) || hasHebrewDeliveryScheduledText(value)) return false;
  return /(?:משלוח|המטענ|סחורה|קרגו).{0,36}(?:נמסר|נפרק)|(?:נמסר|נמסרה|נמסרו).{0,48}(?:ללקוח|למקבל|לנמען|בכתובת|אצל)|(?:מסירה|המסירה).{0,24}(?:בוצעה|הושלמה|הסתיימה)|(?:בוצעה|הושלמה).{0,24}מסירה/.test(value);
}

function hasHebrewPodPendingText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:אינ|אין|חסר|חסרה|טרמ התקבל|עדיינ לא התקבל|ממתינ ל|לא רואה).{0,24}(?:pod|פוד|תעודת מסירה|אישור מסירה)|(?:pod|פוד|תעודת מסירה|אישור מסירה).{0,36}(?:חסר|חסרה|בהמשכ|יישלח|ישלח|נשלח בהמשכ|טרמ|עדיינ לא|ממתינ|בהמתנה|לא רואה)/i.test(value);
}

function hasHebrewPodReceivedText(text) {
  const value = hebrewLogisticsText(text);
  if (!value || hasHebrewPodPendingText(value)) return false;
  return /(?:מצורפ|מצורפת|צורפ|צירפתי|שלחתי|התקבל).{0,48}(?:pod|פוד|תעודת מסירה|אישור מסירה)|(?:pod|פוד|תעודת מסירה|אישור מסירה).{0,56}(?:מצורפ|צורפ|התקבל|חתומ|חתומה|חתימ)|(?:חתומ|חתומה|חתימ).{0,32}(?:pod|פוד|תעודת מסירה|אישור מסירה)/i.test(value);
}

function hasHebrewArrivalPositiveText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  if (/המטענ.{0,12}המריא|(?:לא|טרמ|עדיינ לא|ממתינ|מחכה|צריך|צריכ|ביקש|מבקש).{0,28}(?:הגיע|הגעה|הודעת הגעה|זמינ|אונ האנד|on hand)/i.test(value)) return false;
  return /(?:הודעת הגעה|נוטיס אוף ארייבל|אונ האנד|on hand)|(?:הגיע|הגיעה|הגיעו).{0,32}(?:לתחנה|למסופ|לקרגו|למחסנ|לשדה|לאיירפורט|ל[A-Z]{3})|(?:זמינ|זמינה|זמינימ).{0,24}(?:לאיסופ|pickup|פיקאפ)|(?:נמצא|נמצאת).{0,28}(?:בתחנה|במסופ|בקרגו|במחסנ)/i.test(value);
}

function hasHebrewReleaseText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  if (/(?:לא|טרמ|עדיינ לא|אינ|אין|חסר).{0,32}(?:שחרור|שוחרר|מכס|דו|d\/?o|delivery order)|(?:שחרור|מכס|דו|d\/?o|delivery order).{0,32}(?:חסר|לא התקבל|טרמ|עדיינ לא|בהמתנה)/i.test(value)) return false;
  return /(?:שוחרר|שוחררה|שוחררו).{0,28}(?:מהמכס|ממכס|ע"י מכס)|(?:שחרור|שחרור מכס|אישור מכס).{0,36}(?:התקבל|קיבלנו|מצורפ|אושר|בוצע)|(?:קיבלנו|התקבל|אושר).{0,32}(?:שחרור|אישור מכס|customs release|d\/?o|delivery order)/i.test(value);
}

function hasHebrewPaymentText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:דמי|תשלום|חיוב|אגרה|אגרות|תשלומ).{0,40}(?:שולמ|שולמה|שולמו|אושר|התקבל|קבלה)|(?:שולמ|שולמה|שולמו|אושר|התקבל|קבלה).{0,40}(?:דמי|תשלום|חיוב|אגרה|אגרות|קרגו ספרינט|cargosprint)/i.test(value);
}

function hasHebrewStatusRequestText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:מה עמ|אפשר עדכונ|אפשר עדכון|עדכנו סטטוס|עדכון על|יש פרטי טיסה|תשלחו.{0,20}פרטי טיסה|לא רואה.{0,24}(?:pod|פוד)|למה.{0,40}(?:עדיינ לא|לא).{0,24}(?:נמסר|הגיע|נאספ))/.test(value);
}

function hasHebrewStorageOrDetentionText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  // Incl. billed layover/dwell after pickup: "נחוייב על השכבה של 3 ימים".
  return /(?:אחסנה|אחסונ|דמי אחסנה|זמנ המתנה|זמן המתנה|תוספת חיוב).{0,60}(?:\$|\d|חיוב|עלות|שעה|שעות|פר שעה)?|(?:המתינ|המתינה|המתינו).{0,60}(?:שעה|שעות|\d|חיוב|תוספת|מסופ|טרמינל)|(?:\$|\d).{0,40}(?:אחסנה|זמנ המתנה|זמן המתנה)|(?:נחויב|נחוייב|יחויב|יחוייב).{0,40}(?:השהיה|השכבה|שהייה|המתנה|אחסנה)|(?:השהיה|השכבה|שהייה|המתנה|אחסנה).{0,24}(?:של\s*)?\d+\s*(?:ימימ|יומ|ימי)/.test(value);
}

function hasHebrewOperationalBlockerText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  return /(?:בעיית שידור|בעיה שידור|כמות חבילות|כמות חלקימ|כמות יחידות|מבטל.{0,24}entry|לבטל.{0,24}entry|צריך.{0,32}לבטל.{0,20}entry|nominate|נומינייט|לא מראה שחרור|לא רואימ שחרור|שחרור לא מופיע|לא תואמ).{0,80}/i.test(value);
}

function hebrewDeliveryTiming(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return "";
  if (/(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר).{0,60}מחר|מחר.{0,60}(?:ימסר|יימסר|תימסר|תמסר|נמסר|מסירה|המסירה|להימסר)/.test(value)) return "tomorrow";
  if (/(?:ימסר|יימסר|תימסר|תמסר|מסירה|המסירה|להימסר).{0,60}היומ|היומ.{0,60}(?:ימסר|יימסר|תימסר|תמסר|מסירה|המסירה|להימסר)/.test(value)) return "today";
  return "";
}

function hasHebrewOperatorUpdateText(text) {
  const value = hebrewLogisticsText(text);
  if (!value) return false;
  if (
    hasHebrewPickupConfirmedText(value) ||
    hasHebrewPickupScheduledText(value) ||
    hasHebrewDeliveryScheduledText(value) ||
    hasHebrewDeliveredReportedText(value) ||
    hasHebrewPodPendingText(value) ||
    hasHebrewPodReceivedText(value) ||
    hasHebrewArrivalPositiveText(value) ||
    hasHebrewReleaseText(value) ||
    hasHebrewPaymentText(value) ||
    hasHebrewStorageOrDetentionText(value) ||
    hasHebrewOperationalBlockerText(value)
  ) {
    return true;
  }
  return /(?:דיברתי|שוחחתי|התקשרתי|עדכונ|עדכון|קיבלתי|אישרו|אושר|תיקונ|תיקון|למעשה|טופל|סודר|בוצע|נסגר)/.test(value);
}

function isOperatorUpdateText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || looksLikeQuestion(value)) return false;
  if (/^(?:draft|send|write|reply|prepare|create)\b/i.test(value)) return false;
  if (
    contactEmailList(value).length &&
    /\b(?:saved|save|use this|contact|email)\b.{0,80}\b(?:pickup broker|freight broker|release contact|release packet|delivery order|d\/?o|broker email)\b|\b(?:pickup broker|freight broker|release contact|release packet|delivery order|d\/?o|broker email)\b.{0,80}\b(?:saved|save|use this|contact|email)\b/i.test(value)
  ) {
    return true;
  }
  const updateCue =
    /\b(?:spoke|talked|called|phone|driver said|broker said|station said|confirmed with|got confirmation|fyi|update|note|just got|just received|just spoke|just called|treat|use this|actually|correct|correction|resolve)\b/i.test(value);
  if (updateCue || hasHebrewOperatorUpdateText(value)) return true;
  return Boolean(
    normalizeAwb(value) &&
      /\b(?:picked(?: it)? up|pickup complete|driver (?:is )?(?:now )?loaded|driver loaded|loaded|driver dispatched|dispatch(?:ed)?|picking up|picks up|will pick up|on (?:his|her|their|the)?\s*way to pick(?:\s*up)?|heading to pick(?:\s*up)?|deliver(?:ing)? today|deliver(?:ing)? tomorrow|deliver was completed|delivery completed|delivered|offloaded|unloaded|pod|released|cleared|paid|blocked|closed|waiting|waited|detention|storage|problem|cancel (?:their |the )?entry|nominate|nomination)\b/i.test(value),
  );
}

function operatorFactsFromText(text, awb, at = new Date().toISOString(), options = {}) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || !awb) return [];
  const noteId = options.noteId || stableId(["operator-note", awb, value]);
  const base = {
    at,
    source: "operator-note",
    confidence: "operator-confirmed",
    operatorNoteId: noteId,
  };
  const facts = [];
  const add = (type, label, summary, extra = {}) => facts.push({ ...base, type, label, summary: compact(summary || value), ...extra });

  add("operator-note", "Operator update", value);
  const contactEmails = contactEmailList(value);
  const pickupBrokerContact =
    contactEmails[0] &&
    /\b(?:pickup broker|freight broker|release contact|release packet|delivery order|d\/?o|broker email|broker release contact)\b/i.test(value) &&
    (!/\bcustoms broker\b/i.test(value) || /\b(?:pickup|freight|release packet|delivery order|d\/?o)\b/i.test(value));
  if (pickupBrokerContact) {
    add("contact", "Pickup broker contact", value, {
      role: "pickup-broker",
      contactEmail: contactEmails[0],
      contactName: pickupBrokerContactName(value, contactEmails[0]) || "pickup broker",
    });
  }

  if (/\b(?:picked(?: it)? up|pickup complete|recovered|driver (?:is )?(?:now )?loaded|driver loaded|loaded)\b/i.test(value) || hasHebrewPickupConfirmedText(value)) {
    add("pickup", "Operator pickup", value);
  }
  if (
    /\b(?:driver|broker|truck|carrier|pickup broker)\b.{0,80}\b(?:dispatched|assigned|picking up|picks up|will pick up|on (?:his|her|their|the)?\s*way|heading|recovering)\b/i.test(value) ||
    /\b(?:dispatched|assigned|picking up|picks up|will pick up|on (?:his|her|their|the)?\s*way|heading|recovering)\b.{0,80}\b(?:driver|broker|truck|carrier|pickup broker)\b/i.test(value) ||
    /\b(?:tql|broker|driver|truck|carrier|pickup broker|norman|binational|jeff|chart|jd direct|btx|rapid|meadow freight|atlantic freight|sd direct)\b.{0,80}\b(?:picks up|picking up|will pick up|recovering|heading)\b/i.test(value) ||
    /\b(?:sent|send|issued|gave|emailed|forwarded)\b.{0,80}\b(?:alert|pickup alert|release|d\/?o|delivery order|docs?|paperwork|files?)\b.{0,80}\b(?:to|for)\b.{0,40}\b(?:tql|broker|driver|truck|carrier|pickup broker|norman|binational|jeff|chart|jd direct|btx|rapid|meadow freight|atlantic freight|sd direct)\b/i.test(value) ||
    /\b(?:alert|pickup alert|release|d\/?o|delivery order|docs?|paperwork|files?)\b.{0,80}\b(?:sent|issued|given|emailed|forwarded)\b.{0,80}\b(?:to|for)\b.{0,40}\b(?:tql|broker|driver|truck|carrier|pickup broker|norman|binational|jeff|chart|jd direct|btx|rapid|meadow freight|atlantic freight|sd direct)\b/i.test(value) ||
    hasHebrewPickupScheduledText(value)
  ) {
    add("dispatch", "Operator pickup scheduled", value);
  }
  if (/\b(?:arrived|arrival confirmed|on[-\s]?hand|available for pickup|station confirmed availability|cargo available)\b/i.test(value) || hasHebrewArrivalPositiveText(value)) {
    add("arrival", "Operator arrival", value);
  }
  const hebrewTiming = hebrewDeliveryTiming(value);
  if (/\b(?:deliver today|delivery today|delivering today|out for delivery today)\b/i.test(value) || hebrewTiming === "today") {
    add("delivery", "Delivery today", value, { deliveryTiming: "today" });
  } else if (/\b(?:deliver tomorrow|will be delivered tomorrow|delivery tomorrow|delivering tomorrow|delivery is tomorrow|delivery scheduled tomorrow)\b/i.test(value) || hebrewTiming === "tomorrow") {
    add("delivery", "Delivery tomorrow", value, { deliveryTiming: "tomorrow" });
  }

  const podPending = /\b(?:no pod|pod pending|pod not|without pod|waiting for pod|awaiting pod|pod will|will send (?:the )?pod|send pod later|driver will send)\b/i.test(value) ||
    /\bwaiting for\b[^.;\n]{0,80}\bsend\b[^.;\n]{0,40}\b(?:pod|proof of delivery|signed pod)\b/i.test(value) ||
    hasHebrewPodPendingText(value);
  const podPositive = /\b(?:pod attached|pod found|pod received|pod uploaded|pod provided|signed pod|proof of delivery attached|proof of delivery found|proof of delivery received|proof of delivery uploaded|signed by|received by|receiver signature)\b/i.test(value) || hasHebrewPodReceivedText(value);
  if (podPositive && !podPending) add("pod", "Operator POD", value);
  if (podPending) add("pod-pending", "Operator POD pending", value);

  const deliveredFuture = /\b(?:will deliver|delivering tomorrow|deliver tomorrow|delivery tomorrow|out for delivery)\b/i.test(value) || hasHebrewDeliveryScheduledText(value);
  const offloadedWithPodContext = /\b(?:offloaded|unloaded)\b[^.;\n]{0,80}\b(?:cargo|freight|shipment)\b/i.test(value) && /\b(?:pod|proof of delivery|signed)\b/i.test(value);
  if ((/\b(?:delivered|deliver was completed|delivery completed|completed delivery)\b/i.test(value) || offloadedWithPodContext || hasHebrewDeliveredReportedText(value)) && !deliveredFuture) {
    add("delivery", "Operator delivered", value);
  }
  if (/\b(?:released|cleared|release\/?d\/?o|d\/o|delivery order)\b/i.test(value) || hasHebrewReleaseText(value)) {
    add("customs", "Operator release", value);
  }
  if (/\b(?:ground|handling|station fee|cargosprint|fees?)\b.{0,80}\b(?:paid|confirmed|receipt)\b|\b(?:paid|confirmed)\b.{0,80}\b(?:ground|handling|station fee|cargosprint|fees?)\b/i.test(value) || hasHebrewPaymentText(value)) {
    add("payment", "Operator ground fees", value);
  }
  if (hasHebrewStorageOrDetentionText(value)) {
    add("exception", "Operator storage/detention", value, { severity: "needs-review", where: "storage" });
  }
  if (/\b(?:blocked|stuck|waiting|cannot|can'?t|problem|issue|closed|refused|not available|doesn'?t fit|piece mismatch|wrong pieces?|not released|cancel their entry|nominate .{0,30}\bpcs?\b)\b/i.test(value) ||
    /(?:תקוע|תקועה|ממתינ|מחכה|בעיה|חסר|חסרה|סגור|סגורה|לא זמין|לא זמינה|לא שוחרר|לא שוחררה|חסומ|מסורב)/.test(hebrewLogisticsText(value)) ||
    hasHebrewOperationalBlockerText(value)) {
    add("exception", "Operator exception", value, { severity: "needs-review", where: "operator-note" });
  }
  {
    const { classifyDeliveryWaitText } = require("./delivery-wait");
    const wait = classifyDeliveryWaitText(value, at);
    if (wait && (wait.closed || wait.driverWaiting || wait.scheduled)) {
      add("delivery-wait", "Delivery waits — receiver closed/scheduled", value, {
        severity: "needs-review",
        where: "delivery-wait",
        deliveryWaitKind: wait.kind,
        deliveryWaitUntil: wait.untilWeekday || "",
      });
    }
    if (wait && wait.waitingCost) {
      add("waiting-cost", "Waiting/storage cost risk", value, {
        severity: "needs-review",
        where: "waiting-cost",
        waitingCostDays: wait.waitingCost.days || null,
      });
    }
  }
  if (
    (/\b(?:resolved|handled|fixed|cleared up|took care|completed|done)\b/i.test(value) ||
      /(?:טופל|טופלה|סודר|סודרה|נפתר|נפתרה|בוצע|בוצעה|נסגר|נסגרה)/.test(hebrewLogisticsText(value))) &&
    (/\b(?:station|pickup|availability|available|piece|pieces|driver|blocker|ping|issue|problem|release visibility|d\/?o visibility)\b/i.test(value) ||
      /(?:תחנה|איסופ|זמינ|חתיכות|יחידות|נהג|בעיה|שחרור|דו|d\/?o)/i.test(hebrewLogisticsText(value)))
  ) {
    add("exception-resolved", "Operator resolved blocker", value, {
      severity: "handled",
      status: "resolved",
      where: "operator-note",
    });
  }

  return uniqueFacts(facts);
}

function purposeFromText(text) {
  const value = String(text || "");
  const hebrew = hebrewLogisticsText(value);
  if (/\b(?:actually|correction|correct|treat|use this|ignore previous|resolve|resolved|not delivered|not arrived|not picked up|wrong)\b/i.test(value) ||
    /(?:למעשה|תיקונ|תיקון|נכונ|תתייחס|תתיחס|תשתמש|תתעלמ|טופל|סודר|נפתר|לא נמסר|לא הגיע|לא נאספ|שגוי|טעות)/.test(hebrew)) {
    return "conflict-resolution";
  }
  return "operator-update";
}

function contextAwb(context = {}) {
  return normalizeAwb(
    context.awb ||
      context.shipmentAwb ||
      context.id ||
      context.context?.awb ||
      context.shipment?.awb ||
      "",
  );
}

function makeOperatorNote({ text, awb, at = new Date().toISOString(), purpose = "" }) {
  const normalizedAwb = normalizeAwb(awb);
  const value = compact(text, 800);
  const id = stableId(["operator-note", normalizedAwb, value]);
  const notePurpose = purpose || purposeFromText(value);
  return {
    id,
    awb: normalizedAwb,
    text: value,
    source: "operator-note",
    confidence: "operator-confirmed",
    purpose: notePurpose,
    createdAt: at,
    updatedAt: at,
    facts: operatorFactsFromText(value, normalizedAwb, at, { noteId: id }).map((fact) => ({ ...fact, purpose: notePurpose })),
    resolvedConflictIds: [],
  };
}

function operatorOutcomeFactsFromEntry(entry = {}, note = {}, at = new Date().toISOString()) {
  if (entry.decisionType !== "operator-state-check") return [];
  const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
    ? entry.metadata
    : {};
  const outcome = String(metadata.operatorOutcome || entry.decisionOutcome || "").trim();
  if (!outcome) return [];
  const summary = compact(note.text || entry.text || entry.note || "", 320);
  const base = {
    at,
    source: "operator-note",
    confidence: "operator-confirmed",
    operatorNoteId: note.id || "",
    purpose: note.purpose || entry.purpose || "operator-decision",
    operatorOutcome: outcome,
    sourceDetail: compact(metadata.source || "", 160),
    proof: compact(metadata.proof || "", 220),
  };
  const add = (type, label, extra = {}) => ({ ...base, type, label, summary, ...extra });
  if (outcome === "picked-up") return [add("pickup", "Operator pickup outcome")];
  if (outcome === "out-for-delivery") return [add("delivery", "Operator out for delivery", { deliveryTiming: "today" })];
  if (outcome === "delivered-pod-pending") {
    return [
      add("delivery", "Operator delivered"),
      add("pod-pending", "Operator POD pending"),
    ];
  }
  if (outcome === "delivered-with-pod") {
    return [
      add("delivery", "Operator delivered"),
      add("pod", "Operator POD"),
    ];
  }
  if (["still-waiting-station", "hold-pickup"].includes(outcome)) {
    return [add("exception", "Operator state blocker", { severity: "needs-review", where: "operator-state-check" })];
  }
  if (outcome === "no-movement-yet") {
    return [add("operator-state", "Operator confirmed no movement")];
  }
  if (outcome === "quote-requests-sent") {
    return [add("quote", "Operator quote requests sent")];
  }
  if (["broker-approved", "approved-recommended-broker", "approved-different-broker"].includes(outcome)) {
    return [add("broker-award", "Operator pickup broker approved")];
  }
  return [add("operator-state", "Operator state outcome")];
}

function classifyOperatorUpdate(text, context = {}, at = new Date().toISOString()) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || !isOperatorUpdateText(value)) return { kind: "question" };
  const awb = normalizeAwb(value) || contextAwb(context);
  if (!awb) return { kind: "needs-awb", text: value };
  const note = makeOperatorNote({ text: value, awb, at });
  return { kind: "operator-update", awb, note, facts: note.facts };
}

function operatorNoteFromEntry(entry = {}, at = new Date().toISOString()) {
  const text = String(entry.text || entry.note || entry.summary || "").replace(/\s+/g, " ").trim();
  const awb = normalizeAwb(entry.awb || entry.shipmentAwb || text);
  if (!awb) throw new Error("AWB is required for operator note memory");
  if (!text) throw new Error("Operator note text is required");
  const note = makeOperatorNote({
    text,
    awb,
    at,
    purpose: entry.purpose || "operator-decision",
  });
  const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata)
    ? entry.metadata
    : {};
  const outcomeFacts = operatorOutcomeFactsFromEntry(entry, note, at);
  return {
    ...note,
    facts: uniqueFacts([...outcomeFacts, ...(note.facts || [])]),
    origin: entry.origin || "control-room-action",
    actionId: entry.actionId || "",
    actionKey: entry.actionKey || "",
    actionType: entry.actionType || "",
    decisionType: entry.decisionType || "",
    decisionOutcome: entry.decisionOutcome || "",
    metadata,
  };
}

function emptyCompanionMemory(now = new Date().toISOString()) {
  return {
    snapshotTime: now,
    source: "operator-companion-memory",
    operatorNotes: [],
    resolvedConflicts: [],
    alertStates: [],
  };
}

function upsertOperatorNote(snapshot, note, now = new Date().toISOString()) {
  const base = {
    ...emptyCompanionMemory(now),
    ...(snapshot || {}),
  };
  const existing = Array.isArray(base.operatorNotes) ? base.operatorNotes : [];
  const nextNote = {
    ...note,
    updatedAt: now,
    createdAt: note.createdAt || now,
  };
  const notes = [nextNote, ...existing.filter((item) => item?.id !== nextNote.id)]
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
  return {
    ...base,
    snapshotTime: now,
    operatorNotes: notes,
  };
}

function operatorNoteShipment(note) {
  const awb = normalizeAwbFrom(note?.awb, note?.shipmentAwb, note?.text, note?.summary);
  if (!awb) return null;
  const at = note?.updatedAt || note?.createdAt || "";
  const reparsedFacts = operatorFactsFromText(note?.text || note?.summary || "", awb, at, { noteId: note?.id });
  const facts = uniqueFacts([...(note?.facts || []), ...reparsedFacts])
    .map((fact) => ({ ...fact, purpose: fact.purpose || note?.purpose || "operator-update" }));
  return {
    awb,
    id: awb,
    facts,
    operatorNotes: facts,
    lastEmail: {
      summary: note.text || "",
      at,
      source: "operator-note",
    },
  };
}

module.exports = {
  classifyOperatorUpdate,
  emptyCompanionMemory,
  isOperatorUpdateText,
  makeOperatorNote,
  normalizeAwb,
  operatorNoteFromEntry,
  operatorFactsFromText,
  operatorNoteShipment,
  upsertOperatorNote,
};

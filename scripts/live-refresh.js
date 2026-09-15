#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { parseUnitedText } = require("../lib/united-tracking-parser");
const {
  acquireNestedRunLock,
} = require("../lib/pikiio-live-refresh-lock");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PQ_TMS_CHROME_PORT || 9223);
const DEVTOOLS_HOSTS = ["127.0.0.1", "::1"];
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.PQ_TMS_CDP_COMMAND_TIMEOUT_MS || 120000);
const TMS_ACCESS_ATTEMPTS = Math.max(1, Number(process.env.PQ_TMS_ACCESS_ATTEMPTS || 3));
const OPS_LOG_URL =
  "https://tms.couriercloud.com/Secure/Core/Operations/OpsLog.aspx?CurrentTab=0";
const LOCK_PATH = path.join(ROOT, ".live-refresh.lock");
const LOCK_OPERATION_PATH = path.join(ROOT, ".live-refresh.lock.operation");
const LOCK_STALE_MS = 90 * 60 * 1000;

async function acquireRunLock() {
  return acquireNestedRunLock({
    lockPath: LOCK_PATH,
    operationPath: LOCK_OPERATION_PATH,
    staleMs: LOCK_STALE_MS,
  });
}

function requestJsonFromHost(host, method, requestPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: PORT, path: requestPath, method, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`DevTools ${method} ${requestPath} returned ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`DevTools response was not JSON: ${body.slice(0, 200)} (${error.message})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`DevTools timed out on ${method} ${requestPath}`)));
    req.on("error", reject);
    req.end();
  });
}

async function requestJson(method, requestPath, timeoutMs = 10000) {
  const errors = [];
  for (const host of DEVTOOLS_HOSTS) {
    try {
      return await requestJsonFromHost(host, method, requestPath, timeoutMs);
    } catch (error) {
      errors.push(`${host}: ${error.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

function connectCdp(webSocketDebuggerUrl) {
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (event) => {
      reject(new Error(`Chrome DevTools WebSocket failed for ${webSocketDebuggerUrl}: ${event.message || event.type || "unknown error"}`));
    }, { once: true });
  });

  ws.addEventListener("error", (event) => {
    rejectPending(new Error(`Chrome DevTools WebSocket error: ${event.message || event.type || "unknown error"}`));
  });
  ws.addEventListener("close", () => {
    rejectPending(new Error("Chrome DevTools WebSocket closed before command completed"));
  });

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id || !pending.has(payload.id)) return;
    const waiter = pending.get(payload.id);
    pending.delete(payload.id);
    clearTimeout(waiter.timer);
    if (payload.error) waiter.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    else waiter.resolve(payload.result);
  });

  return {
    async command(method, params = {}) {
      await opened;
      const id = nextId;
      nextId += 1;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chrome DevTools command timed out after ${CDP_COMMAND_TIMEOUT_MS}ms: ${method}`));
        }, CDP_COMMAND_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
      });
      ws.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    close() {
      ws.close();
    },
  };
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function openPage(url) {
  const encoded = encodeURIComponent(url);
  try {
    return await requestJson("PUT", `/json/new?${encoded}`, 15000);
  } catch {
    return requestJson("GET", `/json/new?${encoded}`, 15000);
  }
}

async function closeTab(tab) {
  if (!tab?.id) return;
  try {
    await requestJson("GET", `/json/close/${encodeURIComponent(tab.id)}`, 5000);
  } catch {
    // Best-effort cleanup; failed closes should not turn a good scrape into a failed refresh.
  }
}

async function cleanupAutomationTabs() {
  let tabs = [];
  try {
    tabs = await requestJson("GET", "/json", 10000);
  } catch {
    return { closed: 0 };
  }

  const automationUrl = /tms\.couriercloud\.com|unitedcargo\.com|elal\.com\/CargoApps|myvs\.virginatlanticcargo\.com|aircanada\.com\/cargo|challenge-group\.com\/air-cargo-tracking|arkia\.co\.il/i;
  const staleTabs = tabs.filter((tab) => automationUrl.test(tab.url || ""));
  for (const tab of staleTabs) {
    await closeTab(tab);
  }
  return { closed: staleTabs.length };
}

function runTmsAccessCheck() {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["scripts/tms-access.js", "--json"], { cwd: ROOT, timeout: 300000 }, (error, stdout, stderr) => {
      let payload = null;
      try {
        payload = JSON.parse(stdout || "{}");
      } catch {
        payload = null;
      }
      if (error || !payload?.ok) {
        const detail = payload?.reason || stderr?.toString?.().trim() || stdout?.toString?.().trim() || error?.message || "CourierCloud access check failed";
        reject(new Error(detail));
        return;
      }
      resolve(payload);
    });
  });
}

async function ensureTmsAccess() {
  let lastError = null;
  for (let attempt = 1; attempt <= TMS_ACCESS_ATTEMPTS; attempt += 1) {
    try {
      return await runTmsAccessCheck();
    } catch (error) {
      lastError = error;
      if (attempt < TMS_ACCESS_ATTEMPTS) {
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastError || new Error("CourierCloud access check failed");
}

function devToolsConnectionError(error) {
  return /\b(?:ECONNREFUSED|ECONNRESET|EPIPE|DevTools|WebSocket failed|socket hang up|Target closed|browser has been closed)\b/i
    .test(error?.message || String(error || ""));
}

async function ensureDevToolsAvailable({ force = false } = {}) {
  if (!force) {
    try {
      await requestJson("GET", "/json/version", 3000);
      return { restarted: false };
    } catch (error) {
      if (!devToolsConnectionError(error)) throw error;
    }
  }
  await ensureTmsAccess();
  return { restarted: true };
}

async function evalOnPage(tab, expression) {
  const cdp = connectCdp(tab.webSocketDebuggerUrl);
  try {
    await cdp.command("Runtime.enable");
    const result = await cdp.command("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const exception = result.exceptionDetails.exception || {};
      const details = [
        result.exceptionDetails.text,
        exception.description,
        exception.value,
      ].filter(Boolean).join(": ");
      throw new Error(details || "Runtime.evaluate failed");
    }
    return result.result.value;
  } finally {
    cdp.close();
  }
}

async function currentOpsTab() {
  const tabs = await requestJson("GET", "/json", 10000);
  let tab = tabs.find((item) => item.title === "Operations Log" && /OpsLog\.aspx\?CurrentTab=0/i.test(item.url));
  if (!tab) tab = tabs.find((item) => /OpsLog\.aspx\?CurrentTab=0/i.test(item.url));
  if (!tab) tab = await openPage(OPS_LOG_URL);
  await sleep(3000);
  return tab;
}

async function scrapeTmsGrid() {
  const tab = await currentOpsTab();
  return evalOnPage(
    tab,
    `(() => {
      const clean = (value) => String(value || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
      const text = document.body?.innerText || "";
      const numberOfTasks = Number((text.match(/NUMBER\\s+OF\\s+TASKS\\s*:?\\s*(\\d+)/i) || [])[1] || 0);
      const orderLinks = Array.from(document.querySelectorAll('a[href]'))
        .filter((a) => /Order[_-]?Edit.+ShipmentGUID/i.test(a.href));
      const table = Array.from(document.querySelectorAll("table")).find((candidate) =>
        /NEXT\\s+TASK\\s+NT\\s+PU\\s+DL\\s+OFC\\s+SVC\\s+ORDER#/i.test(clean(candidate.innerText))
      );
      if (!table) {
        const tableSummaries = Array.from(document.querySelectorAll("table"))
          .map((candidate, index) => ({
            index,
            rows: candidate.rows?.length || 0,
            text: clean(candidate.innerText).slice(0, 300),
          }))
          .filter((item) => item.rows || item.text)
          .slice(0, 12);
        throw new Error(JSON.stringify({
          code: "tms-grid-table-not-found",
          title: document.title,
          url: location.href,
          numberOfTasks,
          orderLinkCount: orderLinks.length,
          bodySample: clean(text).slice(0, 800),
          tableSummaries,
        }));
      }
      const headers = Array.from(table.rows[0].cells).map((cell) => clean(cell.innerText));
      const rows = Array.from(table.rows).slice(1).map((tr) => {
        const cells = Array.from(tr.cells).map((cell) => clean(cell.innerText));
        const link = Array.from(tr.querySelectorAll('a[href]')).find((a) => /Order[_-]?Edit.+ShipmentGUID/i.test(a.href));
        const href = link ? link.href : "";
        const guid = (href.match(/ShipmentGUID=([^&]+)/i) || [])[1] || "";
        return {
          nextTask: cells[0] || "",
          office: cells[4] || "",
          service: cells[5] || "",
          order: cells[6] || clean(link?.innerText),
          shipmentNumber: cells[6] || clean(link?.innerText),
          pickupFrom: cells[7] || "",
          readyTime: cells[8] || "",
          dep: cells[9] || "",
          arr: cells[10] || "",
          delTime: cells[11] || "",
          orig: cells[12] || "",
          dest: cells[13] || "",
          owner: cells[14] || "",
          status: cells[15] || "",
          tmsStatus: cells[15] || "",
          orderLink: href,
          shipmentGuid: guid,
        };
      }).filter((row) => row.order && row.orderLink);
      const inputs = Array.from(document.querySelectorAll("input,select,textarea")).map((el) => ({
        id: el.id || "",
        name: el.name || "",
        value: el.tagName === "SELECT" ? (el.options[el.selectedIndex]?.text || el.value || "") : (el.value || ""),
        text: el.innerText || "",
        placeholder: el.placeholder || "",
        title: el.title || "",
      }));
      const tabLinks = Array.from(document.querySelectorAll('a[href*="OpsLog.aspx?CurrentTab="]')).map((a) => ({
        href: a.href,
        text: clean(a.innerText),
      })).filter((item) => item.text);
      return {
        title: document.title,
        url: location.href,
        bodyText: text,
        numberOfTasks,
        orderLinkCount: orderLinks.length,
        headers,
        rows,
        filters: {
          order: inputs.find((item) => /order/i.test(item.id + item.name + item.placeholder + item.title))?.value || "",
          tracking: inputs.find((item) => /track/i.test(item.id + item.name + item.placeholder + item.title))?.value || "",
          pickup: inputs.find((item) => /pickup/i.test(item.id + item.name + item.placeholder + item.title))?.value || "",
          search: inputs.find((item) => /search/i.test(item.id + item.name + item.placeholder + item.title))?.value || "",
        },
        tabs: tabLinks,
        pageText: (text.match(/page\\s+\\d+\\s+of\\s+\\d+/i) || [])[0] || "",
      };
    })()`,
  );
}

async function scrapeTmsDetail(row) {
  const tab = await openPage(row.orderLink);
  try {
    await sleep(3500);
    const detailExpression = `(async () => {
      const clean = (value) => String(value || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();
      const get = (needle) => {
        const input = Array.from(document.querySelectorAll("input,textarea,select")).find((el) => el.id && el.id.includes(needle));
        if (!input) return "";
        return input.tagName === "SELECT" ? (input.options[input.selectedIndex]?.text || input.value || "") : (input.value || "");
      };
      const controlValue = (el) =>
        clean(el.tagName === "SELECT" ? (el.options[el.selectedIndex]?.text || el.value || "") : (el.value || el.innerText || ""));
      const compactLabel = (value, max = 180) => {
        const text = clean(value);
        return text.length > max ? text.slice(0, max - 3).trim() + "..." : text;
      };
      const moneyTextPattern = /customer|charge|billing|sell|revenue|vendor|cost|buy|agent|courier|amount|rate|invoice|total/i;
      const moneyAmountPattern = /\\$\\s*\\d[\\d,]*(?:\\.\\d{1,2})?|\\d[\\d,]*\\.\\d{2}/;
      const rowTextFor = (el) => compactLabel(
        el.closest("tr")?.innerText ||
          el.closest("[role='row']")?.innerText ||
          el.closest("li")?.innerText ||
          "",
        260,
      );
      const labelFor = (el) => {
        const forLabel = el.id ? document.querySelector(\`label[for="\${CSS.escape(el.id)}"]\`) : null;
        return compactLabel([
          el.id,
          el.name,
          el.title,
          el.placeholder,
          el.getAttribute("aria-label"),
          forLabel?.innerText,
        ].filter(Boolean).join(" "));
      };
      const collectControls = () => Array.from(document.querySelectorAll("input,textarea,select"))
        .map((el) => ({
          id: clean(el.id || ""),
          name: clean(el.name || ""),
          type: clean(el.type || el.tagName || ""),
          label: labelFor(el),
          value: controlValue(el),
          rowText: rowTextFor(el),
        }))
        .filter((item) => item.value);
      const collectMoneyRows = () => Array.from(document.querySelectorAll("tr,[role='row'],.dxgvDataRow,.dxgvFooter,.dxgvGroupFooter"))
        .map((el) => compactLabel(el.innerText, 500))
        .filter((text, index, rows) =>
          text &&
            rows.indexOf(text) === index &&
            moneyTextPattern.test(text) &&
            moneyAmountPattern.test(text)
        )
        .slice(0, 80);
      const collectMoneySnapshot = (tab) => ({
        tab,
        controls: collectControls(),
        rows: collectMoneyRows(),
      });
      const moneyTabControls = Array.from(document.querySelectorAll("a,button,input[type='button'],input[type='submit']"))
        .map((el) => ({
          element: el,
          label: clean(el.innerText || el.value || el.title || el.getAttribute("aria-label") || el.id || el.name || ""),
        }))
        .filter((item) => /^(?:charges?|costs?|billing)$/i.test(item.label));
      const moneySnapshots = [collectMoneySnapshot("initial")];
      for (const item of moneyTabControls.slice(0, 6)) {
        try {
          item.element.click();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          moneySnapshots.push(collectMoneySnapshot(item.label));
        } catch {
          moneySnapshots.push({ tab: item.label, controls: [], error: "click failed" });
        }
      }
      const controls = moneySnapshots.flatMap((snapshot) =>
        (snapshot.controls || []).map((item) => ({ ...item, tab: snapshot.tab }))
      );
      const moneyRows = moneySnapshots.flatMap((snapshot) =>
        (snapshot.rows || []).map((row) => ({ row, tab: snapshot.tab }))
      );
      const amountFrom = (value) => {
        const match = String(value || "").match(moneyAmountPattern);
        return match ? clean(match[0]).replace(/\\s+/g, "") : "";
      };
      const candidateSource = (candidate) => ({
        amount: candidate.amount || "",
        source: candidate.source || "",
        tab: candidate.tab || "",
        id: compactLabel(candidate.id || "", 80),
        name: compactLabel(candidate.name || "", 80),
        label: compactLabel(candidate.label || candidate.row || "", 140),
      });
      const moneyCandidate = (patterns, kind) => {
        const blocked = /customs|dut(?:y|ies)|declared|commodity|weight|pieces|pcs|currency|reference|account|tracking|shipmentguid|guid|phone|zip|airport|country|lastupdate|date|time|pager|page size/i;
        const wantedTab = kind === "customer" ? /charges?|billing/i : /costs?|vendor|agent|courier/i;
        const candidates = [];
        for (const item of controls) {
          const haystack = clean([item.id, item.name, item.label, item.rowText, item.tab].filter(Boolean).join(" "));
          const amount = amountFrom(item.value);
          if (!amount) continue;
          const patternMatch = patterns.some((pattern) => pattern.test(haystack));
          const tabMatch = wantedTab.test(haystack);
          if (!patternMatch && !tabMatch) continue;
          let score = 0;
          if (patternMatch) score += 4;
          if (tabMatch) score += 4;
          if (/total|amount|rate|charge|billing|cost|vendor|agent|courier/i.test(haystack)) score += 2;
          if (/hidden|guid|button|pager|page size|manifest|reference/i.test(haystack)) score -= 5;
          if (blocked.test(haystack) && !/wccCharges|wccCosts|wccBilling|charges?|costs?|billing/i.test(haystack)) score -= 8;
          if (score > 0) candidates.push({ ...item, amount, source: "field", score });
        }
        for (const item of moneyRows) {
          const haystack = clean([item.row, item.tab].filter(Boolean).join(" "));
          const amount = amountFrom(item.row);
          if (!amount) continue;
          const patternMatch = patterns.some((pattern) => pattern.test(haystack));
          const tabMatch = wantedTab.test(haystack);
          if (!patternMatch && !tabMatch) continue;
          let score = 0;
          if (patternMatch) score += 3;
          if (tabMatch) score += 4;
          if (/total|amount|rate|charge|billing|cost|vendor|agent|courier/i.test(haystack)) score += 2;
          if (blocked.test(haystack) && !/charges?|costs?|billing|vendor|agent|courier/i.test(haystack)) score -= 6;
          if (score > 0) candidates.push({ amount, source: "row", tab: item.tab, row: item.row, score });
        }
        const best = candidates.sort((left, right) =>
          right.score - left.score ||
            String(right.tab || "").localeCompare(String(left.tab || ""))
        )[0];
        return best ? candidateSource(best) : null;
      };
      const customerChargeCandidate = moneyCandidate(
        [/customer.{0,40}(charge|total|rate|amount)/i, /billing.{0,40}(total|amount|charge)/i, /sell.{0,40}(rate|amount|total)/i, /revenue/i, /charges?/i],
        "customer",
      );
      const vendorCostCandidate = moneyCandidate(
        [/vendor.{0,40}(cost|total|rate|amount)/i, /cost.{0,40}(total|amount|rate)/i, /buy.{0,40}(rate|amount|total)/i, /agent.{0,40}cost/i, /courier.{0,40}cost/i, /costs?/i],
        "vendor",
      );
      const moneyFields = {
        customerCharge: customerChargeCandidate?.amount || "",
        vendorCost: vendorCostCandidate?.amount || "",
      };
      const text = document.body?.innerText || "";
      return {
        detailPullStatus: "success",
        detailTitle: document.title,
        detailUrl: location.href,
        accountNumber: get("txtAccountNumber"),
        trackingNumber: get("txtTrackingNumber"),
        reference: get("txtReference") || "Other Reference",
        customerName: get("hiddenCustomerName"),
        shipmentNumber: get("hiddenShipmentNumber"),
        shipperName: get("txtShipperName"),
        shipperPhone: get("txtShipperPhone"),
        shipperEmail: get("txtShipperEmail"),
        tmsStatus: get("cbOrderStatus"),
        status: get("cbOrderStatus"),
        officeName: get("cbOfficeID"),
        pickupNumber: get("txtPickupNumber"),
        pickupCountry: get("txtPuCountryID"),
        pickupCountryName: get("txtPuCountryName"),
        pickupCompany: get("txtPuCompanyName"),
        pickupPhone: get("txtPuPhoneNumber"),
        pickupEmail: get("txtPuEmailAddress"),
        pickupAddress1: get("txtPuAddress1"),
        pickupAddress2: get("txtPuAddress2"),
        pickupAddress3: get("txtPuAddress3"),
        pickupReadyDate: get("txtPuReadyDate"),
        pickupReadyTime: get("txtPuReadyTime"),
        pickupCity: get("cbPuCityName"),
        pickupState: get("txtPuStateProvID"),
        pickupAirport: get("txtPuAirportID"),
        consigneeCompany: get("txtDelCompanyName"),
        consigneePhone: get("txtDelPhoneNumber"),
        consigneeEmail: get("txtDelEmailAddress"),
        deliveryAddress1: get("txtDelAddress1"),
        deliveryAddress2: get("txtDelAddress2"),
        deliveryAddress3: get("txtDelAddress3"),
        deliveryCity: get("cbDelCityName"),
        deliveryState: get("txtDelStateProvID"),
        deliveryCountry: get("txtDelCountryID"),
        deliveryCountryName: get("txtDelCountryName"),
        deliveryAirport: get("txtDelAirportID"),
        deliveryCourier: get("txtDelCourierName"),
        deliveryActualArrivalDate: get("txtDelActArrDate"),
        deliveryActualArrivalTime: get("txtDelActArrTime"),
        podSignature: get("txtPodSignature"),
        serviceCode: get("cbServiceID"),
        serviceName: get("txtServiceName"),
        pieces: get("txtPieces"),
        weight: get("txtWeight"),
        weightUom: get("cbWeightUOM"),
        contents: get("txtContents"),
        value: get("txtCustomsValue") || get("txtValueCurrencyID"),
        customsPortOfEntry: get("txtCustomsPortOfEntry"),
        customsActualRelease: get("deCustomsActualRelease"),
        customsBrokerName: get("txtCustomsBrokerName"),
        customerCharge: moneyFields.customerCharge,
        billingTotal: moneyFields.customerCharge,
        vendorCost: moneyFields.vendorCost,
        costTotal: moneyFields.vendorCost,
        moneyTabAudit: moneySnapshots.map((snapshot) => ({
          tab: snapshot.tab,
          fieldCount: (snapshot.controls || []).length,
          moneyRowCount: (snapshot.rows || []).length,
          error: snapshot.error || "",
        })),
        moneyFieldAudit: controls
          .filter((item) => moneyTextPattern.test([item.id, item.name, item.label, item.rowText, item.tab].filter(Boolean).join(" ")))
          .map((item) => ({
            tab: item.tab,
            id: compactLabel(item.id, 100),
            name: compactLabel(item.name, 100),
            label: compactLabel(item.label || item.rowText, 160),
            value: compactLabel(item.value, 80),
          }))
          .slice(0, 40),
        moneyExtractionAudit: {
          customerChargeCandidate,
          vendorCostCandidate,
          moneyRows: moneyRows.map((item) => ({
            tab: item.tab,
            row: compactLabel(item.row, 220),
          })).slice(0, 30),
        },
        attachments: Array.from(new Set(text.split(/\\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 120))),
      };
    })()`;
    let detail = await evalOnPage(tab, detailExpression);
    for (let attempt = 0; attempt < 3 && !detail.trackingNumber; attempt += 1) {
      await sleep(3000);
      detail = await evalOnPage(tab, detailExpression);
    }
    if (!detail.trackingNumber) {
      return { ...row, detailPullStatus: "failed", detailError: "Missing tracking number", detailTitle: detail.detailTitle, detailUrl: detail.detailUrl };
    }
    return {
      ...row,
      ...detail,
      order: row.order,
      shipmentNumber: detail.shipmentNumber || row.shipmentNumber,
      shipmentGuid: row.shipmentGuid,
      orderLink: row.orderLink,
      trackingNumber: detail.trackingNumber || row.trackingNumber,
      pickupFrom: row.pickupFrom,
      readyTime: row.readyTime,
      dep: row.dep,
      arr: row.arr,
      delTime: row.delTime,
      orig: row.orig,
      dest: row.dest,
      office: row.office,
      service: row.service,
      owner: row.owner,
      nextTask: row.nextTask,
      status: /-/.test(detail.status || detail.tmsStatus || "") ? (detail.status || detail.tmsStatus) : row.status,
      tmsStatus: /-/.test(detail.tmsStatus || detail.status || "") ? (detail.tmsStatus || detail.status) : row.tmsStatus,
    };
  } finally {
    await closeTab(tab);
  }
}

function scopeAudit(grid, detailRows) {
  return {
    source: "Chrome DevTools partner-116.example profile live CourierCloud Ops Log",
    url: grid.url,
    title: grid.title,
    activeTab: "OPS TLV-US / CurrentTab=0",
    activeTabText: grid.tabs.find((tab) => /CurrentTab=0/i.test(tab.href))?.text || "OPS TLV-US",
    visibleTaskCount: grid.numberOfTasks,
    orderLinkCount: grid.orderLinkCount,
    gridRows: grid.rows.length,
    detailRows: detailRows.length,
    filters: grid.filters,
    pageText: grid.pageText,
    tabs: grid.tabs,
    allRowsLgaAz: grid.rows.every((row) => row.office === "LGA" && row.owner === "AZ"),
    officeOwnerPairs: [...new Set(grid.rows.map((row) => `${row.office}/${row.owner}`))],
    note: "LGA/AZ rows are normal audited scope for PQ OPS TLV-US; TZ owner rows remain in live OPS TLV-US scope when present.",
  };
}

async function refreshTms() {
  const grid = await scrapeTmsGrid();
  if (grid.title !== "Operations Log") throw new Error(`Wrong TMS title: ${grid.title}`);
  if (!/CurrentTab=0/i.test(grid.url)) throw new Error(`Wrong TMS tab URL: ${grid.url}`);
  if (!/OPS\s+TLV-US/i.test(grid.bodyText)) throw new Error("OPS TLV-US tab text not visible");
  if (!/NUMBER\s+OF\s+TASKS/i.test(grid.bodyText)) throw new Error("NUMBER OF TASKS not visible");
  if (grid.rows.length !== grid.numberOfTasks) throw new Error(`Pagination/grid extraction mismatch: ${grid.rows.length} rows for ${grid.numberOfTasks} tasks`);

  const details = [];
  for (const row of grid.rows) {
    process.stderr.write(`TMS detail ${row.order} ${row.pickupFrom}\\n`);
    details.push(await scrapeTmsDetail(row));
  }
  const failures = details.filter((row) => row.detailPullStatus !== "success");
  if (failures.length) throw new Error(`TMS detail mismatch/failure: ${failures.map((row) => row.order).join(", ")}`);
  const now = new Date().toISOString();
  const audit = scopeAudit(grid, details);
  const rows = grid.rows.map((row) => {
    const detail = details.find((item) => item.order === row.order);
    return { ...row, trackingNumber: detail?.trackingNumber || row.trackingNumber || "" };
  });
  await fs.writeFile(path.join(ROOT, "tms-grid-snapshot.json"), `${JSON.stringify({
    snapshotTime: now,
    visibleTaskCount: grid.numberOfTasks,
    orderLinkCount: grid.orderLinkCount,
    scopeAudit: audit,
    rows,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(ROOT, "tms-detail-snapshot.json"), `${JSON.stringify({
    snapshotTime: now,
    visibleTaskCount: grid.numberOfTasks,
    orderLinkCount: grid.orderLinkCount,
    scopeAudit: audit,
    shipments: details,
  }, null, 2)}\n`);
  return { grid, details, audit };
}

async function trackUnited(awb) {
  const url = `https://www.unitedcargo.com/en/us/track/awb/${encodeURIComponent(awb)}`;
  const tab = await openPage(url);
  try {
    await sleep(7000);
    const page = await evalOnPage(tab, `({ title: document.title, url: location.href, text: document.body?.innerText || "" })`);
    const record = parseUnitedText(awb, page.url || url, page.title || "", page.text || "");
    if (!record.ok) {
      record.error = record.noResult
        ? "United Cargo returned an explicit no-result response for the queried AWB."
        : "United Cargo page loaded but no usable shipment movement was parsed.";
    }
    return record;
  } finally {
    await closeTab(tab);
  }
}

async function trackElal(awb, row) {
  const tab = await openPage("https://www.elal.com/CargoApps/AIR2.aspx?Lang=Eng");
  try {
    await sleep(5000);
    const page = await evalOnPage(
      tab,
      `(() => {
      const textInput = Array.from(document.querySelectorAll("input")).find((el) => /awb|air|way/i.test((el.id || "") + (el.name || "") + (el.title || "")) && el.type !== "hidden") || Array.from(document.querySelectorAll("input[type=text]"))[0];
      if (textInput) textInput.value = "${awb.replace(/[^0-9-]/g, "")}";
      const button = document.querySelector("#ImageButton1") || Array.from(document.querySelectorAll("input,button")).find((el) => /submit|track|search/i.test((el.value || "") + (el.innerText || "") + (el.id || "")));
      if (button) button.click();
      return true;
    })()`,
  );
    void page;
    await sleep(7000);
    const result = await evalOnPage(tab, `({ title: document.title, url: location.href, text: document.body?.innerText || "" })`);
    const text = result.text || "";
    const hasDetail = /ARR|RCF|AWD|DLV|delivered|arrived|received|manifest|flight/i.test(text) && text.length > 250;
    return {
      awb,
      ok: hasDetail,
      carrier: "EL AL Cargo",
      url: result.url,
      title: result.title,
      status: hasDetail ? "parsed-text" : "",
      eta: "",
      flight: row.dep || row.arr || "",
      error: hasDetail ? "" : "Official EL AL AIR2 form loaded/submitted, but no shipment detail was returned.",
      text,
    };
  } finally {
    await closeTab(tab);
  }
}

async function trackOther(awb, row) {
  const prefix = awb.replace(/\\D/g, "").slice(0, 3);
  const carrier =
    prefix === "932" ? "Virgin Atlantic Cargo" :
    prefix === "014" ? "Air Canada Cargo" :
    prefix === "700" ? "Challenge Cargo" :
    prefix === "238" ? "Arkia Israeli Airlines" :
    "Carrier tracking";
  const url =
    prefix === "932" ? `https://myvs.virginatlanticcargo.com/myVS/Tracking/Index?awb=${awb.replace(/\\D/g, "")}` :
    prefix === "014" ? `https://www.aircanada.com/cargo/en/shipping/tracking-results?awb=${awb.replace(/\\D/g, "")}` :
    prefix === "700" ? "https://www.challenge-group.com/air-cargo-tracking/" :
    prefix === "238" ? "https://www.arkia.co.il/" :
    "";
  if (!url) return { awb, carrier, ok: false, error: "No official carrier tracking URL configured.", status: "", eta: "" };
  try {
    const tab = await openPage(url);
    try {
      await sleep(8000);
      const result = await evalOnPage(tab, `({ title: document.title, url: location.href, text: document.body?.innerText || "" })`);
      const text = result.text || "";
      const ok = new RegExp(awb.replace(/[-]/g, "[- ]?")).test(text) && /ARR|RCF|AWD|DLV|arriv|available|ready|delivered/i.test(text);
      return {
        awb,
        carrier,
        ok,
        url: result.url || url,
        title: result.title || "",
        status: ok ? "parsed-text" : "",
        eta: "",
        error: ok ? "" : "Carrier tracking page opened, but no reliable arrival/ready tracking evidence was parsed.",
        text,
        tmsFlight: `${row.dep || ""} ${row.arr || ""}`.trim(),
      };
    } finally {
      await closeTab(tab);
    }
  } catch (error) {
    if (devToolsConnectionError(error)) throw error;
    return { awb, carrier, ok: false, url, title: "", status: "", eta: "", error: error.message, text: "" };
  }
}

function flightCandidatesFromRow(row = {}) {
  const fields = [
    row.dep,
    row.arr,
    row.flight,
    row.flights,
    row.route,
    row.routing,
    row.nextTask,
    row.orig,
    row.dest,
    row.service,
  ].filter(Boolean).map(cleanText);
  const seen = new Set();
  const flights = [];
  for (const value of fields) {
    if (/truck/i.test(value) && !/[A-Z0-9]{2}\d{2,4}/i.test(value)) continue;
    for (const match of value.matchAll(/\b([A-Z0-9]{2})\s?(\d{2,4})([A-Z])?\b/gi)) {
      const segment = cleanText(match[0]).toUpperCase().replace(/\s+/g, "");
      if (/TRUCK/i.test(segment)) continue;
      const flight = `${match[1]}${match[2]}`.toUpperCase();
      if (!flight || seen.has(flight)) continue;
      seen.add(flight);
      flights.push({
        flight,
        sourceSegment: segment,
        sourceField: value,
        suffix: match[3] || "",
      });
    }
  }
  return flights;
}

function flightDetailsFromRow(row = {}) {
  const flights = flightCandidatesFromRow(row);
  const tmsFlight = cleanText([row.dep, row.arr].filter(Boolean).join(" "));
  const route = cleanText([row.orig, row.dest].filter(Boolean).join("-"));
  const etaHint = cleanText(row.nextTask || row.delTime || row.deliveryActualArrivalDate || "");
  return {
    flights,
    primaryFlight: flights[0]?.flight || "",
    tmsFlight,
    route,
    origin: row.orig || "",
    destination: row.dest || "",
    etaHint,
    recoveryHint: etaHint,
  };
}

async function lookupPublicFlightStatus(flight, row = {}) {
  const query = [
    flight,
    "flight status",
    row.orig || "",
    row.dest || "",
    row.nextTask || "",
  ].filter(Boolean).join(" ");
  const url = `https://www.google.com/search?hl=en&q=${encodeURIComponent(query)}`;
  const tab = await openPage(url);
  try {
    await sleep(5000);
    const result = await evalOnPage(tab, `(() => {
      const text = document.body?.innerText || "";
      const lines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const wanted = new RegExp("${flight.replace(/[^A-Z0-9]/gi, "")}", "i");
      const movement = /\\b(?:landed|arrived|scheduled|estimated|departed|delayed|cancelled|on time|in air|gate|terminal|baggage|arrival|departure)\\b/i;
      const snippets = lines.filter((line) => wanted.test(line) || movement.test(line)).slice(0, 12);
      return { title: document.title, url: location.href, snippets };
    })()`);
    const snippets = Array.isArray(result.snippets) ? result.snippets.map(cleanText).filter(Boolean).slice(0, 8) : [];
    const movementLine = snippets.find((line) => /\b(?:landed|arrived|scheduled|estimated|departed|delayed|cancelled|on time|in air)\b/i.test(line)) || "";
    return {
      flight,
      ok: Boolean(movementLine),
      source: "public-flight-status-search",
      url: result.url || url,
      title: result.title || "",
      status: movementLine ? "public-status-snippet" : "no-parsed-public-status",
      summary: movementLine || snippets[0] || "",
      snippets,
    };
  } finally {
    await closeTab(tab);
  }
}

async function trackFlightIntelligence(awb, row) {
  const prefix = awb.replace(/\D/g, "").slice(0, 3);
  const carrier = carrierNameForPrefix(prefix);
  const flightDetails = flightDetailsFromRow(row);
  const checks = [];
  for (const candidate of flightDetails.flights.slice(0, 3)) {
    try {
      checks.push(await lookupPublicFlightStatus(candidate.flight, row));
    } catch (error) {
      if (devToolsConnectionError(error)) throw error;
      checks.push({
        flight: candidate.flight,
        ok: false,
        source: "public-flight-status-search",
        status: "lookup-failed",
        error: error.message || String(error),
      });
    }
  }
  const parsed = checks.find((check) => check.ok);
  const missingFlight = !flightDetails.flights.length;
  const error = missingFlight
    ? "No flight number was available in the TMS detail fields. Search Gmail/pre-alert for the flight before trusting movement state."
    : parsed
      ? "Flight status was researched, but station/on-hand proof is still required before treating the shipment as operationally ready."
      : "No reliable public flight-status movement was parsed. Search Gmail/pre-alert and confirm with the station or handler.";
  return {
    awb,
    ok: false,
    carrier,
    source: "flight-intelligence",
    status: parsed ? "flight-status-researched" : "flight-intelligence-needed",
    code: "FLIGHT_INTELLIGENCE_NEEDED",
    requiresFlightIntelligence: true,
    flightIntelligenceRequired: true,
    flightDetails,
    flights: flightDetails.flights.map((item) => item.flight),
    tmsFlight: flightDetails.tmsFlight,
    route: flightDetails.route,
    publicFlightStatus: {
      checked: checks.length > 0,
      checks,
      best: parsed || null,
    },
    eta: flightDetails.etaHint,
    scheduledArrival: flightDetails.etaHint,
    error,
    text: "",
  };
}

function carrierNameForPrefix(prefix) {
  if (prefix === "016") return "United Cargo";
  if (prefix === "114") return "EL AL Cargo";
  if (prefix === "932") return "Virgin Atlantic Cargo";
  if (prefix === "014") return "Air Canada Cargo";
  if (prefix === "700") return "Challenge Cargo";
  if (prefix === "238") return "Arkia Israeli Airlines";
  return "Carrier tracking";
}

async function trackCarrierRow(row) {
  const awb = row.trackingNumber;
  const prefix = awb.replace(/\D/g, "").slice(0, 3);
  if (prefix === "016") return trackUnited(awb);
  return trackFlightIntelligence(awb, row);
}

async function trackCarrierRowWithRecovery(row) {
  const awb = row.trackingNumber;
  const prefix = awb.replace(/\D/g, "").slice(0, 3);
  const flightDetails = prefix === "016" ? null : flightDetailsFromRow(row);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await ensureDevToolsAvailable({ force: attempt > 0 });
      const record = await trackCarrierRow(row);
      return attempt > 0 ? { ...record, recoveredDevTools: true } : record;
    } catch (error) {
      if (!devToolsConnectionError(error) || attempt > 0) {
        return {
          awb,
          ok: false,
          carrier: carrierNameForPrefix(prefix),
          status: prefix === "016" ? "" : "flight-intelligence-needed",
          code: prefix === "016" ? "" : "FLIGHT_INTELLIGENCE_NEEDED",
          eta: flightDetails?.etaHint || "",
          scheduledArrival: flightDetails?.etaHint || "",
          text: "",
          requiresFlightIntelligence: prefix !== "016",
          flightIntelligenceRequired: prefix !== "016",
          flightDetails,
          flights: flightDetails?.flights?.map((item) => item.flight) || [],
          tmsFlight: flightDetails?.tmsFlight || "",
          route: flightDetails?.route || "",
          recoveredDevTools: attempt > 0,
          error: error.message || String(error),
        };
      }
      process.stderr.write(`Tracking ${awb} lost Chrome DevTools; relaunching and retrying\n`);
      await cleanupAutomationTabs();
    }
  }
  return {
    awb,
    ok: false,
    carrier: carrierNameForPrefix(prefix),
    status: prefix === "016" ? "" : "flight-intelligence-needed",
    code: prefix === "016" ? "" : "FLIGHT_INTELLIGENCE_NEEDED",
    eta: "",
    scheduledArrival: flightDetails?.etaHint || "",
    text: "",
    requiresFlightIntelligence: prefix !== "016",
    flightIntelligenceRequired: prefix !== "016",
    flightDetails,
    flights: flightDetails?.flights?.map((item) => item.flight) || [],
    tmsFlight: flightDetails?.tmsFlight || "",
    route: flightDetails?.route || "",
    error: prefix === "016"
      ? "United tracking retry exhausted."
      : "Flight-status research retry exhausted. Confirm movement from Gmail/pre-alert and station or handler.",
  };
}

async function refreshTracking(details) {
  const now = new Date().toISOString();
  const united = [];
  const elal = [];
  const other = [];
  for (const row of details) {
    const awb = row.trackingNumber;
    if (!awb) continue;
    const prefix = awb.replace(/\\D/g, "").slice(0, 3);
    process.stderr.write(prefix === "016" ? `Tracking United ${awb}\\n` : `Checking flight intelligence ${awb}\\n`);
    const record = await trackCarrierRowWithRecovery(row);
    if (prefix === "016") united.push(record);
    else if (prefix === "114") elal.push(record);
    else other.push(record);
  }
  await fs.writeFile(path.join(ROOT, "united-tracking-snapshot.json"), `${JSON.stringify({
    snapshotTime: now,
    source: "United Cargo live tracking pages via Chrome DevTools partner-116.example profile",
    tracking: united.map((record) => ({ ...record, snapshotTime: now })),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(ROOT, "elal-tracking-snapshot.json"), `${JSON.stringify({
    snapshotTime: now,
    source: "EL AL movement via TMS/Gmail flight details plus public flight-status research; direct cargo page is not treated as primary truth",
    tracking: elal.map((record) => ({ ...record, snapshotTime: now })),
  }, null, 2)}\n`);
  await fs.writeFile(path.join(ROOT, "other-tracking-snapshot.json"), `${JSON.stringify({
    snapshotTime: now,
    source: "Non-United movement via TMS/Gmail flight details plus public flight-status research; weak cargo tracking pages are not treated as primary truth",
    tracking: other.map((record) => ({ ...record, snapshotTime: now })),
  }, null, 2)}\n`);
  return { united, elal, other };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.find((arg) => !arg.startsWith("--")) || "all";
  const skipAccessGate = process.env.PQ_TMS_SKIP_ACCESS_GATE === "1" || args.includes("--skip-access-gate");
  let cleanedUp = false;
  let releaseLock = null;
  try {
    releaseLock = await acquireRunLock();
    let details = [];
    let tms = null;
    if (mode === "all" || mode === "tms") {
      if (!skipAccessGate) await ensureTmsAccess();
      tms = await refreshTms();
      details = tms.details;
    } else {
      details = JSON.parse(await fs.readFile(path.join(ROOT, "tms-detail-snapshot.json"), "utf8")).shipments || [];
    }
    let tracking = null;
    if (mode === "all" || mode === "tracking") tracking = await refreshTracking(details);
    const cleanup = await cleanupAutomationTabs();
    cleanedUp = true;
    const attempted = tracking ? [...tracking.united, ...tracking.elal, ...tracking.other] : [];
    console.log(JSON.stringify({
      ok: true,
      tms: tms ? {
        visibleTaskCount: tms.grid.numberOfTasks,
        gridRows: tms.grid.rows.length,
        detailRows: tms.details.length,
        scopeAudit: tms.audit,
      } : null,
      tracking: tracking ? {
        attempted: attempted.length,
        succeeded: attempted.filter((record) => record.ok).length,
        failed: attempted.filter((record) => !record.ok).length,
        failures: attempted.filter((record) => !record.ok).map((record) => ({ awb: record.awb, carrier: record.carrier, error: record.error })),
      } : null,
      cleanup,
    }, null, 2));
  } finally {
    if (!cleanedUp && releaseLock) await cleanupAutomationTabs();
    if (releaseLock) await releaseLock();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  acquireRunLock,
  main,
};

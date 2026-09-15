#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CHROME_BIN =
  process.env.PQ_TMS_CHROME_BIN ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SOURCE_PROFILE =
  process.env.PQ_TMS_SOURCE_CHROME_PROFILE ||
  path.join(os.homedir(), "Library/Application Support/Google/Chrome");
const AUTOMATION_PROFILE =
  process.env.PQ_TMS_AUTOMATION_CHROME_PROFILE ||
  path.join(os.homedir(), ".pq-tms-chrome-profile");
const PORT = Number(process.env.PQ_TMS_CHROME_PORT || 9223);

const FIELD_IDS = {
  actualTime: "pl_ws_fv_tx_wccDelivery_txtDelActArrTime_I",
  actualDate: "pl_ws_fv_tx_wccDelivery_txtDelActArrDate_I",
  signed: "pl_ws_fv_tx_wccDelivery_txtPodSignature_I",
  status: "pl_ws_fv_rpOrderInfo_cbOrderStatus_I",
  saveNext: "pl_ws_bSaveAndNext_I",
};

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? fallback : process.argv[index + 1];
}

const dryRun = process.argv.includes("--dry-run");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, requestPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: requestPath, method, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Chrome DevTools ${method} ${requestPath} returned ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Chrome DevTools response was not JSON: ${error.message}`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Chrome DevTools timed out on ${method} ${requestPath}`)));
    req.on("error", reject);
    req.end();
  });
}

async function isDevToolsReady() {
  try {
    await requestJson("GET", "/json/version", 1000);
    return true;
  } catch {
    return false;
  }
}

function syncAutomationProfileIfNeeded() {
  const fsSync = require("node:fs");
  const prefs = path.join(AUTOMATION_PROFILE, "Default", "Preferences");
  if (fsSync.existsSync(prefs)) return;
  if (!fsSync.existsSync(SOURCE_PROFILE)) {
    throw new Error(`Source Chrome profile root is missing: ${SOURCE_PROFILE}`);
  }
  fsSync.mkdirSync(AUTOMATION_PROFILE, { recursive: true });
  const result = spawnSync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude=Singleton*",
      "--exclude=Crashpad",
      "--exclude=BrowserMetrics*",
      "--exclude=GrShaderCache",
      "--exclude=GraphiteDawnCache",
      "--exclude=ShaderCache",
      "--exclude=Default/Cache",
      "--exclude=Default/Code Cache",
      "--exclude=Default/GPUCache",
      "--exclude=Default/Service Worker/CacheStorage",
      `${SOURCE_PROFILE}/`,
      `${AUTOMATION_PROFILE}/`,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`rsync failed: ${result.stderr || result.stdout || result.status}`);
}

async function launchChromeIfNeeded() {
  if (await isDevToolsReady()) return;
  syncAutomationProfileIfNeeded();
  const logPath = "/tmp/pq-tms-chrome.log";
  const out = require("node:fs").openSync(logPath, "a");
  const child = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${AUTOMATION_PROFILE}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "about:blank",
    ],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  require("node:fs").closeSync(out);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isDevToolsReady()) return;
    await sleep(250);
  }
  throw new Error(`Chrome DevTools did not start on 127.0.0.1:${PORT}; see ${logPath}`);
}

async function openPage(url) {
  const encoded = encodeURIComponent(url);
  try {
    return await requestJson("PUT", `/json/new?${encoded}`);
  } catch {
    return await requestJson("GET", `/json/new?${encoded}`);
  }
}

async function closeTab(page) {
  if (!page?.id) return;
  await requestJson("GET", `/json/close/${encodeURIComponent(page.id)}`).catch(() => {});
}

function connectCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") throw new Error("This Node runtime does not expose WebSocket; use Node 22+.");
  const ws = new WebSocket(webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  let dialog = null;
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.method === "Page.javascriptDialogOpening") dialog = payload.params;
    const waiter = pending.get(payload.id);
    if (!waiter) return;
    pending.delete(payload.id);
    payload.error ? waiter.reject(new Error(payload.error.message || JSON.stringify(payload.error))) : waiter.resolve(payload.result);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return {
    async command(method, params = {}) {
      await opened;
      const id = nextId++;
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      ws.send(JSON.stringify({ id, method, params }));
      return promise;
    },
    get dialog() {
      return dialog;
    },
    async close() {
      await opened.catch(() => {});
      ws.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result.value;
}

async function typeInto(cdp, id, text) {
  const box = await evaluate(
    cdp,
    `(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
  if (!box) throw new Error(`CourierCloud field not found: ${id}`);
  await cdp.command("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await cdp.command("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await cdp.command("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await sleep(120);
  await cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
  await cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 4 });
  await cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await sleep(80);
  await cdp.command("Input.insertText", { text });
  await cdp.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await cdp.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await sleep(200);
  return evaluate(cdp, `document.getElementById(${JSON.stringify(id)})?.value || ""`);
}

async function readPodFields(cdp) {
  return evaluate(
    cdp,
    `(() => ({
      url: location.href,
      title: document.title,
      status: document.getElementById(${JSON.stringify(FIELD_IDS.status)})?.value || "",
      actualTime: document.getElementById(${JSON.stringify(FIELD_IDS.actualTime)})?.value || "",
      actualDate: document.getElementById(${JSON.stringify(FIELD_IDS.actualDate)})?.value || "",
      signedBy: document.getElementById(${JSON.stringify(FIELD_IDS.signed)})?.value || "",
      saveNextVisible: !!document.getElementById(${JSON.stringify(FIELD_IDS.saveNext)}),
    }))()`,
  );
}

function normalizeTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return "";
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2] || "00"}`;
}

function normalizeDate(value) {
  return String(value || "").trim();
}

function validatePayload(payload) {
  const actualTime = normalizeTime(payload.actualTime || payload.podProposal?.actualTime || "");
  const actualDate = normalizeDate(payload.actualDate || payload.podProposal?.actualDate || "");
  const signedBy = String(payload.signedBy || payload.podProposal?.signedBy || "Receiver").trim() || "Receiver";
  if (!payload.orderLink) throw new Error("Missing CourierCloud orderLink");
  if (!actualDate) throw new Error("Missing POD actualDate");
  if (!actualTime) throw new Error("Missing POD actualTime");
  if (!signedBy) throw new Error("Missing POD signedBy");
  if (payload.tmsIntent?.kind !== "pod-actual-signed-closeout") {
    throw new Error("Payload is not a POD closeout approval");
  }
  return { actualDate, actualTime, signedBy };
}

async function completePodCloseout(payload) {
  const values = validatePayload(payload);
  await launchChromeIfNeeded();
  const page = await openPage(payload.orderLink);
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    await sleep(2500);
    const before = await readPodFields(cdp);
    if (/Company ID|User ID|SIGN IN|Login/i.test(before.title) || /Login/i.test(before.url)) {
      throw new Error("CourierCloud is not signed in; open TMS access once before completing POD.");
    }
    if (dryRun) {
      return { ok: true, completed: false, dryRun: true, before, values, payload: safeResultPayload(payload) };
    }

    await typeInto(cdp, FIELD_IDS.actualTime, values.actualTime);
    await typeInto(cdp, FIELD_IDS.actualDate, values.actualDate);
    await typeInto(cdp, FIELD_IDS.signed, values.signedBy);
    const filled = await readPodFields(cdp);
    if (
      filled.actualTime !== values.actualTime ||
      filled.actualDate !== values.actualDate ||
      filled.signedBy !== values.signedBy
    ) {
      throw new Error(`CourierCloud POD fields did not hold before save: ${JSON.stringify(filled)}`);
    }

    const clicked = await evaluate(
      cdp,
      `(() => {
        const b = document.getElementById(${JSON.stringify(FIELD_IDS.saveNext)});
        if (!b) return false;
        b.scrollIntoView({ block: "center" });
        b.click();
        return true;
      })()`,
    );
    if (!clicked) throw new Error("CourierCloud Save & Next button was not found");
    await sleep(5000);
    if (cdp.dialog) {
      await cdp.command("Page.handleJavaScriptDialog", { accept: true });
      await sleep(3500);
    }

    const verifyPage = await openPage(payload.orderLink);
    const verifyCdp = connectCdp(verifyPage.webSocketDebuggerUrl);
    try {
      await verifyCdp.command("Page.enable");
      await verifyCdp.command("Runtime.enable");
      await sleep(2500);
      const verified = await readPodFields(verifyCdp);
      if (
        verified.actualTime !== values.actualTime ||
        verified.actualDate !== values.actualDate ||
        verified.signedBy !== values.signedBy
      ) {
        throw new Error(`CourierCloud POD closeout did not persist: ${JSON.stringify(verified)}`);
      }
      return {
        ok: true,
        completed: true,
        sent: true,
        actionId: payload.actionId || "",
        awb: payload.awb || "",
        completedAt: new Date().toISOString(),
        sentAt: new Date().toISOString(),
        values,
        before,
        verified,
        payload: safeResultPayload(payload),
      };
    } finally {
      await verifyCdp.close();
      await closeTab(verifyPage);
    }
  } finally {
    await cdp.close();
    await closeTab(page);
  }
}

function safeResultPayload(payload) {
  return {
    actionId: payload.actionId || "",
    awb: payload.awb || "",
    orderLink: payload.orderLink || "",
    actualDate: payload.actualDate || payload.podProposal?.actualDate || "",
    actualTime: payload.actualTime || payload.podProposal?.actualTime || "",
    signedBy: payload.signedBy || payload.podProposal?.signedBy || "",
    outboxRequestId: payload.outboxRequestId || "",
  };
}

async function main() {
  const payloadFile = argValue("--payload-file");
  if (!payloadFile) throw new Error("Missing --payload-file");
  const payload = JSON.parse(await fs.readFile(payloadFile, "utf8"));
  const result = await completePodCloseout(payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ completed: false, ok: false, error: error.message }, null, 2));
  process.exit(1);
});

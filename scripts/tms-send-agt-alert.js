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
  const prefs = path.join(AUTOMATION_PROFILE, "Default", "Preferences");
  if (require("node:fs").existsSync(prefs)) return;
  if (!require("node:fs").existsSync(SOURCE_PROFILE)) {
    throw new Error(`Source Chrome profile root is missing: ${SOURCE_PROFILE}`);
  }
  require("node:fs").mkdirSync(AUTOMATION_PROFILE, { recursive: true });
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
  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
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

async function readVisibleState(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const text = document.body ? document.body.innerText : "";
      const lines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      return { title: document.title, url: location.href, sample: lines.slice(0, 60).join(" | ").slice(0, 1600) };
    })()`,
  );
}

async function clickText(cdp, patternSource, flags = "i") {
  return evaluate(
    cdp,
    `(() => {
      const pattern = new RegExp(${JSON.stringify(patternSource)}, ${JSON.stringify(flags)});
      const nodes = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"],a,span,td,div'));
      const node = nodes.find((item) => pattern.test((item.innerText || item.value || item.textContent || '').trim()));
      if (!node) return false;
      node.click();
      return true;
    })()`,
  );
}

async function fillVisibleText(cdp, value) {
  return evaluate(
    cdp,
    `(() => {
      const value = ${JSON.stringify(value)};
      const input = Array.from(document.querySelectorAll('textarea,input:not([type="hidden"])'))
        .filter((node) => !node.disabled && node.offsetParent !== null)
        .find((node) => /email|contact|to|cc|message|body|note|subject/i.test([node.id, node.name, node.placeholder, node.getAttribute('aria-label')].join(' '))) ||
        Array.from(document.querySelectorAll('textarea,input:not([type="hidden"])')).find((node) => !node.disabled && node.offsetParent !== null);
      if (!input) return false;
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
  );
}

async function sendAgtAlert(payload) {
  if (!payload?.orderLink) throw new Error("Missing CourierCloud orderLink");
  if (!payload?.brokerEmail) throw new Error("Missing brokerEmail");
  await launchChromeIfNeeded();
  const page = await openPage(payload.orderLink);
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    await sleep(2500);
    let state = await readVisibleState(cdp);
    if (/Company ID|User ID|SIGN IN|Login/i.test(state.sample) && !/Order|Agents|Operations/i.test(state.sample)) {
      throw new Error("CourierCloud is not signed in; open TMS access once before sending alerts.");
    }
    if (dryRun) {
      return { sent: false, dryRun: true, state, payload: safeResultPayload(payload) };
    }
    if (!(await clickText(cdp, "\\\\bAgents?\\\\b|AGT"))) {
      throw new Error(`Agents tab/button not found on CourierCloud order. Visible: ${state.sample}`);
    }
    await sleep(700);
    await clickText(cdp, payload.brokerEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).catch(() => false);
    await sleep(300);
    if (!(await clickText(cdp, "⋯|\\.\\.\\.|Contacted|Email|Actions?|Menu"))) {
      throw new Error("Could not find broker row menu/contacted action in CourierCloud Agents tab.");
    }
    await sleep(500);
    await clickText(cdp, "Contacted").catch(() => false);
    await sleep(300);
    await clickText(cdp, "^Email$|Email").catch(() => false);
    await sleep(500);
    const message = [
      payload.contactedEmails?.filter(Boolean).join(", "),
      payload.subject,
      payload.body,
    ].filter(Boolean).join("\\n\\n");
    if (!(await fillVisibleText(cdp, message))) {
      throw new Error("Could not fill CourierCloud contacted/email dialog.");
    }
    if (!(await clickText(cdp, "^Send$|Send Alert|Save|OK"))) {
      throw new Error("Could not find CourierCloud send/save button for AGT alert.");
    }
    await sleep(1200);
    state = await readVisibleState(cdp);
    return {
      sent: true,
      actionId: payload.actionId || "",
      awb: payload.awb || "",
      sentAt: new Date().toISOString(),
      state,
      payload: safeResultPayload(payload),
    };
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
    brokerEmail: payload.brokerEmail || "",
    copyEmail: payload.copyEmail || "",
    contactedEmails: payload.contactedEmails || [],
  };
}

async function main() {
  const payloadFile = argValue("--payload-file");
  if (!payloadFile) throw new Error("Missing --payload-file");
  const payload = JSON.parse(await fs.readFile(payloadFile, "utf8"));
  const result = await sendAgtAlert(payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ sent: false, ok: false, error: error.message }, null, 2));
  process.exit(1);
});

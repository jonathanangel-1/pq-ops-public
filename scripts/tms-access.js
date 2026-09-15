#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
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
const CDP_COMMAND_TIMEOUT_MS = Number(process.env.PQ_TMS_CDP_COMMAND_TIMEOUT_MS || 45000);
const DEVTOOLS_HOSTS = ["127.0.0.1", "::1"];
const OPS_LOG_URL =
  "https://tms.couriercloud.com/Secure/Core/Operations/OpsLog.aspx?CurrentTab=0";
const COMPANY_ID = "16031";
const USER_ID = "PIKIIOINC";

const flags = new Set(process.argv.slice(2));
const jsonMode = flags.has("--json");
const forceSync = flags.has("--force-sync");

function log(message) {
  if (!jsonMode) console.log(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJsonFromHost(host, method, requestPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port: PORT,
        path: requestPath,
        method,
        timeout: timeoutMs,
      },
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
    req.on("timeout", () => {
      req.destroy(new Error(`Chrome DevTools timed out on ${method} ${requestPath}`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function requestJson(method, requestPath, timeoutMs = 5000) {
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

async function isDevToolsReady() {
  try {
    await requestJson("GET", "/json/version", 1000);
    return true;
  } catch {
    return false;
  }
}

function removeSingletonLocks() {
  if (!fs.existsSync(AUTOMATION_PROFILE)) return;
  for (const name of fs.readdirSync(AUTOMATION_PROFILE)) {
    if (name.startsWith("Singleton")) {
      fs.rmSync(path.join(AUTOMATION_PROFILE, name), { force: true, recursive: true });
    }
  }
}

function automationChromePids() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) =>
      line.includes("--remote-debugging-port=") &&
      line.includes(`--user-data-dir=${AUTOMATION_PROFILE}`))
    .map((line) => Number((line.match(/^(\d+)/) || [])[1]))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== process.pid);
}

async function stopAutomationChromeIfNeeded() {
  let pids = automationChromePids();
  if (!pids.length) return;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between ps and kill.
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(250);
    pids = automationChromePids();
    if (!pids.length) return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best-effort stale Chrome cleanup before relaunching the automation profile.
    }
  }
}

function syncAutomationProfileIfNeeded() {
  const hasProfile = fs.existsSync(path.join(AUTOMATION_PROFILE, "Default", "Preferences"));
  if (hasProfile && !forceSync) {
    removeSingletonLocks();
    return;
  }

  if (!fs.existsSync(SOURCE_PROFILE)) {
    throw new Error(`Source Chrome profile root is missing: ${SOURCE_PROFILE}`);
  }

  log(`Syncing Chrome automation profile to ${AUTOMATION_PROFILE}`);
  fs.mkdirSync(AUTOMATION_PROFILE, { recursive: true });
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
  if (result.status !== 0) {
    throw new Error(`rsync failed: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  removeSingletonLocks();
}

async function launchChromeIfNeeded() {
  if (await isDevToolsReady()) return;

  await stopAutomationChromeIfNeeded();
  syncAutomationProfileIfNeeded();

  const logPath = "/tmp/pq-tms-chrome.log";
  const out = fs.openSync(logPath, "a");
  const child = spawn(
    CHROME_BIN,
    [
      `--remote-debugging-port=${PORT}`,
      // Chrome 111+ rejects DevTools WebSocket connections whose Origin header
      // is not allow-listed; Node's WebSocket client sends one, so every CDP
      // page attach dies at the handshake without this (root cause of the
      // TMS scrape failing silently since 2026-07-12).
      "--remote-allow-origins=*",
      `--user-data-dir=${AUTOMATION_PROFILE}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "about:blank",
    ],
    {
      detached: true,
      stdio: ["ignore", out, out],
    },
  );
  child.unref();
  fs.closeSync(out);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isDevToolsReady()) return;
    await sleep(250);
  }

  throw new Error(`Chrome DevTools did not start on localhost port ${PORT}; see ${logPath}`);
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
  try {
    await requestJson("GET", `/json/close/${encodeURIComponent(page.id)}`);
  } catch {
    // Best-effort cleanup; access verification should report the real login result.
  }
}

function connectCdp(webSocketDebuggerUrl) {
  if (typeof WebSocket !== "function") {
    throw new Error("This Node runtime does not expose WebSocket; use Node 22+.");
  }

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

  ws.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id) return;
    const waiter = pending.get(payload.id);
    if (!waiter) return;
    pending.delete(payload.id);
    clearTimeout(waiter.timer);
    if (payload.error) {
      waiter.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
    } else {
      waiter.resolve(payload.result);
    }
  });

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  ws.addEventListener("error", (event) => {
    rejectPending(new Error(`Chrome DevTools WebSocket error: ${event.message || event.type || "unknown error"}`));
  });
  ws.addEventListener("close", () => {
    rejectPending(new Error("Chrome DevTools WebSocket closed before command completed"));
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
    async close() {
      await opened.catch(() => {});
      ws.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

async function dispatchKey(cdp, key, code, keyCode) {
  await cdp.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await cdp.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
}

async function readState(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const text = document.body ? document.body.innerText : "";
      const links = Array.from(document.querySelectorAll("a[href]"));
      const orderEditLinks = links
        .map((a) => ({ text: (a.innerText || "").trim(), href: a.href }))
        .filter((link) => /Order[_-]?Edit|Order_Edit/i.test(link.href));
      const orderLinks = orderEditLinks
        .filter((link) => /^100\\d{4}$/.test(link.text));
      const orders = Array.from(new Set(orderLinks.map((link) => link.text)));
      const numberOfTasksMatch = text.match(/NUMBER\\s+OF\\s+TASKS\\s*:?\\s*(\\d+)/i);
      const visibleLines = text.split(/\\n+/).map((line) => line.trim()).filter(Boolean);
      const activeScope =
        visibleLines.find((line) => /OPS\\s+TLV-US/i.test(line)) ||
        visibleLines.find((line) => /TLV-US/i.test(line)) ||
        "";
      const passwordInput = document.querySelector('input[type="password"]');
      const signedIn = /Sign-Out|Welcome,\\s*Alex|Operations Log|AppLanding/i.test(text + " " + location.href);
      const signIn = /Company ID|User ID|SIGN IN/i.test(text) && !/Operations Log/i.test(document.title);
      return {
        title: document.title,
        url: location.href,
        textSample: visibleLines.slice(0, 18).join(" | ").slice(0, 800),
        numberOfTasks: numberOfTasksMatch ? Number(numberOfTasksMatch[1]) : null,
        orderEditLinkCount: new Set(orderEditLinks.map((link) => link.href)).size,
        orders,
        orderLinks,
        activeScope,
        signedIn,
        signIn,
        passwordLength: passwordInput && passwordInput.value ? passwordInput.value.length : 0
      };
    })()`,
  );
}

async function prepareSignInForm(cdp) {
  await evaluate(
    cdp,
    `(() => {
      const inputs = Array.from(document.querySelectorAll("input"));
      function setValue(input, value) {
        if (!input) return;
        if (!input.value) {
          input.focus();
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      function byText(pattern) {
        return inputs.find((input) => {
          const id = input.id || "";
          const name = input.name || "";
          const placeholder = input.placeholder || "";
          const label = input.labels && input.labels[0] ? input.labels[0].innerText : "";
          return pattern.test([id, name, placeholder, label].join(" "));
        });
      }
      const company = byText(/company|companyid|company_id/i) || inputs[0];
      const user = byText(/user|logon|login/i) || inputs.find((input) => input !== company && input.type !== "password");
      setValue(company, ${JSON.stringify(COMPANY_ID)});
      setValue(user, ${JSON.stringify(USER_ID)});
      const password = inputs.find((input) => input.type === "password");
      if (password) password.focus();
      return true;
    })()`,
  );
}

async function triggerSavedCredentialPicker(cdp) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await prepareSignInForm(cdp);
    await dispatchKey(cdp, "ArrowDown", "ArrowDown", 40);
    await sleep(150);
    await dispatchKey(cdp, "Enter", "Enter", 13);
    await sleep(600);
    const state = await readState(cdp);
    if (state.passwordLength > 0) return state;

    await evaluate(
      cdp,
      `(() => {
        const password = document.querySelector('input[type="password"]');
        if (password) {
          password.click();
          password.focus();
        }
        return true;
      })()`,
    );
    await sleep(150);
  }
  return readState(cdp);
}

async function clickSignIn(cdp) {
  return evaluate(
    cdp,
    `(() => {
      const candidates = Array.from(document.querySelectorAll('button,input[type="submit"],input[type="button"],a'));
      const signIn = candidates.find((node) => /sign\\s*in/i.test(node.innerText || node.value || node.getAttribute("aria-label") || ""));
      if (!signIn) return false;
      signIn.click();
      return true;
    })()`,
  );
}

async function navigate(cdp, url) {
  await cdp.command("Page.navigate", { url });
  await sleep(1500);
}

async function ensureOpsLog() {
  await launchChromeIfNeeded();
  const page = await openPage(OPS_LOG_URL);
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  try {
    await cdp.command("Page.enable");
    await cdp.command("Runtime.enable");
    await sleep(2500);

    let state = await readState(cdp);
    if (state.signIn || /Default\\.aspx|Login|Sign/i.test(state.url)) {
      state = await triggerSavedCredentialPicker(cdp);
      if (state.passwordLength <= 0) {
        return {
          ok: false,
          reason: "Chrome saved credential did not autofill the CourierCloud password",
          ...sanitizeState(state),
        };
      }
      const clicked = await clickSignIn(cdp);
      if (!clicked) {
        return {
          ok: false,
          reason: "CourierCloud sign-in button was not found",
          ...sanitizeState(state),
        };
      }
      await sleep(3000);
    }

    await navigate(cdp, OPS_LOG_URL);
    state = await readState(cdp);
    const ok =
      /Operations Log/i.test(state.title) &&
      /OpsLog\.aspx/i.test(state.url) &&
      state.numberOfTasks !== null &&
      state.orderEditLinkCount > 0;

    return {
      ok,
      reason: ok ? "CourierCloud Ops Log verified" : "CourierCloud Ops Log verification failed",
      ...sanitizeState(state),
      devtoolsPort: PORT,
      automationProfile: AUTOMATION_PROFILE,
    };
  } finally {
    await cdp.close();
    await closeTab(page);
  }
}

function sanitizeState(state) {
  const { passwordLength, ...safe } = state;
  return safe;
}

async function main() {
  try {
    const result = await ensureOpsLog();
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(
        [
          "TMS access verified.",
          `Title: ${result.title}`,
          `URL: ${result.url}`,
          `Number of tasks: ${result.numberOfTasks}`,
          `Order edit links: ${result.orderEditLinkCount}`,
          `Chrome DevTools port: ${result.devtoolsPort}`,
        ].join("\n"),
      );
    } else {
      console.error(`TMS access failed: ${result.reason}`);
      console.error(JSON.stringify(result, null, 2));
    }
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    const result = {
      ok: false,
      reason: error.message,
      devtoolsPort: PORT,
      automationProfile: AUTOMATION_PROFILE,
    };
    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`TMS access failed: ${error.message}`);
    }
    process.exit(1);
  }
}

main();

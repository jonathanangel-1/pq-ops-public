#!/usr/bin/env node
// UI contract verifier: one bundle, two production surfaces, no demo UI.
//
// Static checks (always run):
//   1. No demo-mode branches in the production bundle (app.js, styles.css, index.html).
//   2. index.html busts cache with matching ?v= params on app.js and styles.css.
//   3. Both surfaces read canonical truth (brain shipments overlay present; retired
//      truth sources absent). Degraded-truth banner is wired into every list view.
//   4. Viewport fork is the single 1024px boundary.
//
// Behavioral checks (run when Chrome is available; require the local dev server —
// started automatically if 4173 is free):
//   5. 390x844 renders the phone companion surface (companion-mode, dark body,
//      no desktop workspace class).
//   6. 1440x900 renders the desktop control room (desktop-workspace class,
//      .desktop-control-room element).
//   7. ?demo=operator-flow renders the normal product, not a synthetic demo.
//   8. When /api/truth/health reports degraded truth, the source-truth banner is
//      visible on both surfaces.
//
// Local data is dev-only truth: behavioral checks assert SURFACE identity, never
// shipment correctness. Pass --static-only to skip browser checks.

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const APP_PATH = path.join(ROOT_DIR, "app.js");
const STYLES_PATH = path.join(ROOT_DIR, "styles.css");
const INDEX_PATH = path.join(ROOT_DIR, "index.html");
const SERVICE_WORKER_PATH = path.join(ROOT_DIR, "sw.js");

const failures = [];
function check(ok, label) {
  console.log(`${ok ? "ok" : "FAIL"} - ${label}`);
  if (!ok) failures.push(label);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function staticChecks() {
  const app = fs.readFileSync(APP_PATH, "utf8");
  const styles = fs.readFileSync(STYLES_PATH, "utf8");
  const index = fs.readFileSync(INDEX_PATH, "utf8");

  const demoIdentifiers = [
    "rowanDemoMode", "operatorFlowDemoMode", "manualDemoMode", "silentVideoDemoMode",
    "renderRowanFilmDemo", "renderOperatorFlowDemo", "renderManualDemo", "renderSilentVideoDemo",
    "rowan-film-mode", "operator-demo-mode", "manual-demo-mode", "silent-video-demo-mode",
    "__operatorDemoReady", "__manualDemoReady",
  ];
  check(
    demoIdentifiers.every((id) => !app.includes(id)),
    "app.js contains no demo-mode branches",
  );
  check(
    !/urlParams\.get\("demo"\)/.test(app) && !/searchParams\.get\("demo"\)/.test(app),
    "app.js does not read a ?demo= query param",
  );
  const demoSelectors = /\.(rowan-film|film-slide|film-surface|operator-demo|manual-demo|silent-demo|silent-video-demo)/;
  check(!demoSelectors.test(styles), "styles.css contains no demo selectors");
  check(!/demo/i.test(index), "index.html contains no demo hooks");

  const appVersion = index.match(/app\.js\?v=([\w-]+)/)?.[1] || "";
  const cssVersion = index.match(/styles\.css\?v=([\w-]+)/)?.[1] || "";
  check(Boolean(appVersion && cssVersion), "index.html busts cache with ?v= on app.js and styles.css");
  check(appVersion === cssVersion, `app.js and styles.css share one bundle version (${appVersion} / ${cssVersion})`);
  check(appVersion === "desk2-v52" && cssVersion === "desk2-v52", `truth-freshness bundle is desk2-v52 (${appVersion} / ${cssVersion})`);

  check(app.includes("loadBrainShipmentTruthOverlay"), "UI reads canonical truth overlay (/api/brain/shipments)");
  check(
    !app.includes("active-shipments.json") && !app.includes("dashboard-data.json") && !app.includes("liveGmailFallback"),
    "retired truth sources are absent from the bundle",
  );
  const bannerCalls = (app.match(/sourceTruthBanner/g) || []).length;
  check(
    app.includes("function renderSourceTruthBanner") && bannerCalls >= 5,
    "degraded-truth banner is wired into the list views (both surfaces)",
  );

  const forks = new Set((app.match(/min-width:\s*(\d+)px/g) || []).map((m) => m.match(/\d+/)[0]));
  check(
    app.includes('desktopWorkspaceQuery = "(min-width: 1024px)"'),
    "surface fork is the single 1024px desktopWorkspaceQuery",
  );
  void forks;

  // Desktop action stage contract
  check(
    app.includes("function renderDesktopActionStage") &&
      app.includes("function renderDesktopStageQueue") &&
      app.includes("function renderDesktopStageCockpit"),
    "desktop action stage exists (queue + cockpit)",
  );
  check(
    !app.includes("desktop-companion-empty"),
    "the empty-chat invitation is gone from the desktop stage",
  );
  const queueCardBlock = app.slice(app.indexOf("function renderDesktopStageQueueCard"), app.indexOf("function renderDesktopStageQueue("));
  const lockedCardBlock = app.slice(app.indexOf("function renderDesktopStageActionCard"), app.indexOf("function desktopStageCockpitActions"));
  check(
    queueCardBlock.includes("actionModePill(action)") && lockedCardBlock.includes("actionModePill(action)"),
    "every stage action card carries the approval-boundary pill (actionModePill)",
  );
  const lockBlock = app.slice(app.indexOf("function desktopStageActionLock"), app.indexOf("function desktopStageActionClass"));
  check(
    lockBlock.includes("shipmentHasSourceGap(shipment)") &&
      lockBlock.includes("globalProofFreshness()") &&
      lockBlock.includes("desktopStageTruthGatheringAction(action)"),
    "staleness gate locks truth-asserting actions and exempts truth-gathering ones",
  );
  const healthStripBlock = app.slice(app.indexOf("function renderDesktopStageHealthStrip"), app.indexOf("function renderDesktopStageActionCard"));
  check(
    app.includes("function sourceHealthDegradationAppliesToShipment") &&
      app.includes("sourceGapAwbKeys") &&
      healthStripBlock.includes("desktopStageDegraded(shipment)"),
    "row-scoped source-health degradation stays scoped to the affected shipment cockpit",
  );
  check(
    app.includes("function sourceTruthBackupWarningText") &&
      app.includes("payloadSourceTruthWarnings") &&
      app.includes("shipmentServedFromBackupTruth(shipment)") &&
      app.includes('state: "stale-fallback"'),
    "bundled/hosted-read fallback warnings render as backup truth, not email sync",
  );
  check(
    app.includes('entries.push({ kind: "gap", shipment })'),
    "source-gapped shipments surface their repair as queue work",
  );
  const journeyBlock = app.slice(app.indexOf("function renderShipmentJourney"), app.indexOf("function renderDesktopStageCockpit"));
  check(
    journeyBlock.includes('{ label: "Arrival", gates: ["arrival"] }') &&
      !journeyBlock.includes('{ label: "Landed", gates: ["arrival"] }'),
    "shipment journey names the neutral Arrival gate instead of asserting Landed before proof",
  );
  check(
    app.includes("function truthApiResponseIsCacheFallback") &&
      app.includes("function markTruthApiPayloadAsCacheFallback") &&
      (app.match(/truthApiResponseIsCacheFallback\(response\)/g) || []).length >= 2,
    "truth-health and brain loaders preserve service-worker cache fallback provenance",
  );
  const hostedSnapshotLoader = app.slice(app.indexOf("async function loadHostedSnapshots"), app.indexOf("const TRUTH_API_CACHE_FALLBACK_WARNING"));
  const brainTruthLoader = app.slice(app.indexOf("async function loadBrainShipmentTruthOverlayUncached"), app.indexOf("function refreshBrainShipmentTruthAfterRender"));
  check(
    hostedSnapshotLoader.includes("truthApiResponseIsCacheFallback(response)") &&
      hostedSnapshotLoader.includes("scheduleBrainTruthCacheFallbackRecovery()") &&
      hostedSnapshotLoader.includes("return null"),
    "cached /api/snapshots payloads are not projected as live and trigger live shipment recovery",
  );
  check(
    brainTruthLoader.includes("new AbortController()") &&
      brainTruthLoader.includes("truthApiRequestTimeoutMs({ liveReread })") &&
      brainTruthLoader.includes("TRUTH_API_LIVE_REREAD_HEADER") &&
      brainTruthLoader.includes("settleTruthApiCacheFallbackRecoveryFailure()"),
    "brain live re-read has an aligned explicit timeout, bypasses SW fallback, and fails closed",
  );
  check(
    app.includes('state: "syncing-live"') &&
      app.includes('title: "Syncing live truth…"') &&
      app.includes("Showing a stale backup copy while live shipment truth loads") &&
      app.includes('state: "stale-fallback"'),
    "cache fallback is visibly stale while syncing and degrades only after live recovery fails",
  );
  check(
    lockedCardBlock.includes("renderCallButton(action)"),
    "locked cards keep the call (truth-gathering) affordance live",
  );

  // Composer polish contract (desktop): recipients render as chips, the raw
  // People/edit fields stay folded behind the Edit toggle, the send button
  // states its reason, and the Pikiio path never says "approved in Gmail".
  const composerBlock = app.slice(app.indexOf("function renderDesktopActionComposer"), app.indexOf("function previewErrorText"));
  check(composerBlock.length > 0, "the one desktop action composer exists");
  check(
    /editOpen \? `[\s\S]*renderDraftParticipantToggles/.test(composerBlock),
    "composer: the People/edit fields are folded behind Edit recipients (no raw checkbox list by default)",
  );
  check(composerBlock.includes("composerRecipientChips"), "composer: To/CC/BCC render as chips");
  check(composerBlock.includes("data-send-disabled-reason"), "composer: the disabled send button states its exact reason");
  check(composerBlock.includes("Save draft to Gmail"), "composer: Save draft to Gmail remains the safe path");
  check(
    !composerBlock.includes("approved in Gmail") || composerBlock.includes("Nothing sends from Pikiio"),
    "composer: the Pikiio path replaces the 'approved in Gmail' wording",
  );
}

async function serviceWorkerTruthNetworkChecks() {
  const source = fs.readFileSync(SERVICE_WORKER_PATH, "utf8");
  const origin = "https://pikiio.test";
  let cachedResponse = null;
  const cacheWrites = [];
  const cache = {
    addAll: async () => {},
    match: async () => cachedResponse ? cachedResponse.clone() : null,
    put: async (key, response) => { cacheWrites.push({ key: String(key), response }); },
  };
  let fetchImpl = async () => { throw new Error("fetch stub not configured"); };
  const sandbox = {
    AbortController,
    Headers,
    Request,
    Response,
    TextDecoder,
    URL,
    URLSearchParams,
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    caches: {
      open: async () => cache,
      keys: async () => [],
      delete: async () => true,
    },
    clearTimeout,
    console,
    fetch: (request, options) => fetchImpl(request, options),
    setTimeout,
    self: {
      addEventListener: () => {},
      clients: { claim: async () => {}, matchAll: async () => [] },
      location: { origin },
      navigator: { connection: { effectiveType: "4g" } },
      registration: { showNotification: async () => {}, pushManager: {} },
      skipWaiting: async () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nself.__truthTest = { createTruthNetworkFirstTask, isCacheableTruthRead, truthNetworkTimeoutMs };`, sandbox, {
    filename: SERVICE_WORKER_PATH,
  });
  const sw = sandbox.self.__truthTest;
  check(sw.truthNetworkTimeoutMs({ effectiveType: "4g" }) === 6000, "service worker allows six seconds per normal mobile truth attempt");
  check(sw.truthNetworkTimeoutMs({ effectiveType: "3g" }) === 8000, "service worker adapts slow mobile truth attempts to eight seconds");
  check(sw.truthNetworkTimeoutMs({ effectiveType: "slow-2g" }) >= 4000, "service-worker adaptive truth timeout never drops below four seconds");

  const liveUrl = new URL(`${origin}/api/brain/shipments?ts=1`);
  const liveRequest = new Request(liveUrl.href, { method: "GET" });
  const bypassRequest = new Request(liveUrl.href, { headers: { "x-pikiio-live-truth-reread": "1" } });
  check(sw.isCacheableTruthRead(liveRequest, liveUrl), "ordinary shipment truth reads use SW network-first recovery");
  check(!sw.isCacheableTruthRead(bypassRequest, liveUrl), "background live re-read bypasses the SW cached-fallback path");

  cachedResponse = null;
  cacheWrites.length = 0;
  const retrySignals = [];
  let retryCalls = 0;
  fetchImpl = async (_request, options = {}) => {
    retryCalls += 1;
    retrySignals.push(options.signal);
    if (retryCalls === 1) throw new Error("first mobile truth attempt timed out");
    return new Response(JSON.stringify({ ok: true, source: "shipment-truth-packets", shipments: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const retryTask = sw.createTruthNetworkFirstTask(liveRequest, liveUrl);
  const retryResponse = await retryTask.responsePromise;
  await retryTask.donePromise;
  check(retryCalls === 2, "service worker retries the live truth network fetch exactly once");
  check(retrySignals.length === 2 && retrySignals[0] !== retrySignals[1], "service-worker retry uses a fresh AbortController signal");
  check(retryResponse.ok && retryResponse.headers.get("x-pikiio-cache-fallback") !== "1", "successful retry is returned as live, never marked as cached fallback");
  check(cacheWrites.length === 1, "successful live retry refreshes the truth cache");

  cachedResponse = new Response(JSON.stringify({ ok: true, source: "shipment-truth-packets", shipments: [{ awb: "016-80000012" }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  cacheWrites.length = 0;
  let failedCalls = 0;
  fetchImpl = async () => {
    failedCalls += 1;
    throw new Error("live truth unavailable");
  };
  const fallbackTask = sw.createTruthNetworkFirstTask(liveRequest, liveUrl);
  const fallbackResponse = await fallbackTask.responsePromise;
  await fallbackTask.donePromise;
  check(failedCalls === 2, "cached truth is considered only after both live network attempts fail");
  check(
    fallbackResponse.headers.get("x-pikiio-cache-fallback") === "1" && /stale/i.test(fallbackResponse.headers.get("warning") || ""),
    "service worker marks cached truth explicitly stale before returning it",
  );
}

function chromePath() {
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || "";
}

async function waitForOk(url, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await delay(200);
  }
  return false;
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let counter = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = ++counter;
      pending.set(id, { res, rej, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
      }
    };
    ws.onopen = () => resolve({ send, close: () => ws.close() });
    ws.onerror = reject;
  });
}

async function inspectSurface(chrome, url, width, height) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pikiio-uic-"));
  const port = 9500 + Math.floor(Math.random() * 400);
  const child = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, `--window-size=${width},${height}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    await waitForOk(`http://127.0.0.1:${port}/json/version`);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    const cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: width < 1024 });
    await cdp.send("Page.navigate", { url });
    await delay(8000);
    const result = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `(async () => {
        const health = await fetch("/api/truth/health").then((r) => r.ok ? r.json() : null).catch(() => null);
        const stageCards = [...document.querySelectorAll("[data-stage-card]")];
        // Boundary pills are required on FULL cards (hero/cockpit); compact
        // group rows inherit their mode from the group header instead.
        const actionCards = stageCards.filter((el) => ["draft", "document", "call", "decide"].includes(el.dataset.stageCard) && el.classList.contains("desktop-stage-card"));
        return {
          bodyClasses: document.body.className,
          desktopMediaQuery: matchMedia("(min-width: 1024px)").matches,
          backgroundColor: getComputedStyle(document.body).backgroundColor,
          hasControlRoom: Boolean(document.querySelector(".desktop-control-room")),
          hasOpsBrain: Boolean(document.querySelector(".ops-brain")),
          hasShipmentList: Boolean(document.getElementById("shipmentList")),
          bannerVisible: Boolean(document.querySelector(".source-truth-banner")) ||
            ["warn", "bad"].includes(document.querySelector("[data-sync-status]")?.dataset?.syncTone || ""),
          // Is the SHOWN truth degraded? Mirror the client's own honesty verdict
          // (app.js healthNotLive), not a standalone poll. Two facts:
          //  1. /api/truth/health emits top-level status "live" when healthy and
          //     "degraded" otherwise (never the string ok). Testing not-equal-to-ok
          //     was always true, falsely demanding a banner even when truth was live.
          //  2. The shipment payload carries its own server-stamped source-health
          //     (payloadSourceHealthLive) that OUTRANKS the health poll: the operator
          //     sees THAT payload, so if its sources were verified live it is honest
          //     to show no degraded banner even if a separate poll instant disagrees
          //     (they diverge on localhost; they agree in production).
          // Fire only when the shown payload is genuinely not-live (exactly when a
          // banner is required) so this still catches degraded-but-silent regressions.
          truthDegraded: Boolean(health && health.status && health.status !== "live") &&
            !(typeof payloadSourceHealthLive === "function" && payloadSourceHealthLive()),
          stagePresent: Boolean(document.querySelector("[data-desktop-action-stage]")),
          stageCards: stageCards.length,
          stageHonestEmpty: Boolean(document.querySelector("[data-stage-empty]")),
          stageComposer: Boolean(document.querySelector("[data-desktop-action-stage] [data-ops-brain-form]")),
          companionEntry: Boolean(document.querySelector("[data-open-companion-panel]")),
          actionCardsMissingBoundary: actionCards.filter((el) => !el.querySelector(".action-mode-pill")).length,
          repairCardsLocked: stageCards.filter((el) => el.dataset.stageCard === "repair" && el.dataset.stageLocked).length,
          freshnessLevel: typeof globalProofFreshness === "function" ? globalProofFreshness().level : null,
          draftCardsUnlocked: stageCards.filter((el) => ["draft", "document"].includes(el.dataset.stageCard) && !el.dataset.stageLocked).length,
          shipmentsActive: typeof state !== "undefined" ? state.shipments.filter((s) => typeof shipmentTruthComplete === "function" && !shipmentTruthComplete(s)).length : null,
          deliveredPodPendingCountsActive: typeof shipmentTruthComplete === "function" ? !shipmentTruthComplete({
            truthPacketRole: "active",
            truthPacket: { currentState: "delivered" },
            opsState: {
              phase: "delivered-pod-pending",
              gates: {
                delivery: { status: "delivered" },
                pod: { status: "pending" },
              },
            },
          }) : false,
          journeyLabelContract: (() => {
            if (typeof renderShipmentJourney !== "function") return { skipped: true };
            const read = (arrivalStatus) => {
              const host = document.createElement("div");
              host.innerHTML = renderShipmentJourney({
                truthPacket: {
                  gates: [
                    { gate: "arrival", status: arrivalStatus },
                    { gate: "customs", status: "unknown" },
                  ],
                },
              });
              return [...host.querySelectorAll(".shipment-journey-step")].map((step) => step.getAttribute("aria-label"));
            };
            return { skipped: false, preArrival: read("unknown"), arrived: read("done") };
          })(),
          truthCacheFallbackContract: (() => {
            if (typeof markTruthApiPayloadAsCacheFallback !== "function" || typeof truthApiResponseIsCacheFallback !== "function") {
              return { skipped: true };
            }
            const input = {
              ok: true,
              status: "live",
              sourceHealth: { status: "live", degraded: false },
              warnings: [],
            };
            const marked = markTruthApiPayloadAsCacheFallback(input);
            const syncing = markTruthApiPayloadAsCacheFallback(input, { syncingLive: true });
            return {
              skipped: false,
              headerDetected: truthApiResponseIsCacheFallback({ headers: { get: (name) => name === "x-pikiio-cache-fallback" ? "1" : "" } }),
              ordinaryNotDetected: !truthApiResponseIsCacheFallback({ headers: { get: () => "" } }),
              ok: marked.ok,
              status: marked.status,
              cacheFallback: marked.cacheFallback,
              syncState: marked.syncState,
              syncingState: syncing.syncState,
              sourceHealth: marked.sourceHealth,
              warnings: marked.sourceTruthWarnings,
              normalAttemptTimeoutMs: truthApiNetworkAttemptTimeoutMs({ effectiveType: "4g" }),
              slowAttemptTimeoutMs: truthApiNetworkAttemptTimeoutMs({ effectiveType: "3g" }),
              normalRequestTimeoutMs: truthApiRequestTimeoutMs(),
              liveRereadTimeoutMs: truthApiRequestTimeoutMs({ liveReread: true }),
            };
          })(),
          // Lane navigation: clicking a lane header must filter the rail to
          // exactly that lane (counts matching rows), leave Today's counts
          // untouched, and clear back to all lanes. Cockpit selection must
          // still work from a filtered lane.
          laneNavigation: await (async () => {
            const heads = [...document.querySelectorAll("[data-desk2-lane]")];
            if (!heads.length) return { skipped: true };
            const todayBefore = document.querySelector(".desktop-companion-context em")?.textContent || "";
            const results = [];
            for (const laneId of [...new Set(heads.map((el) => el.dataset.desk2Lane))]) {
              const head = document.querySelector('[data-desk2-lane="' + laneId + '"]');
              if (!head) continue;
              head.click();
              await new Promise((resolve) => setTimeout(resolve, 350));
              const sections = [...document.querySelectorAll("[data-desk2-lane-section]")];
              const onlyThisLane = sections.length >= 1 && sections.every((el) => el.dataset.desk2LaneSection === laneId);
              const activeHead = document.querySelector('[data-desk2-lane="' + laneId + '"]');
              const declared = Number((activeHead?.textContent.match(/(\\d+)\\s*$/) || [])[1] || "0");
              const rowCount = sections.reduce((sum, el) => sum + el.querySelectorAll("[data-select], .desk2-row, article, button.desk2-row").length, 0);
              const rows = document.querySelectorAll('[data-desk2-lane-section="' + laneId + '"] .desk2-row').length;
              results.push({ laneId, onlyThisLane, declared, rows: rows || rowCount });
              document.querySelector("[data-desk2-lane-clear]")?.click();
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            const allLanesBack = [...document.querySelectorAll("[data-desk2-lane-section]")].length >= results.length;
            const todayAfter = document.querySelector(".desktop-companion-context em")?.textContent || "";
            return { skipped: false, results, allLanesBack, todayUnchanged: todayBefore === todayAfter };
          })(),
          // CLICK TARGETS: real clicks on real rows must open exactly the
          // clicked shipment — never the first recommended one (production
          // bug: lane math stole every out-of-lane selection).
          clickTargets: await (async () => {
            const cockpitAwb = () => (document.querySelector(".desktop-stage-cockpit-awb")?.textContent || "").replace(/\\D/g, "");
            const back = async () => { document.querySelector("[data-stage-back]")?.click(); await new Promise((resolve) => setTimeout(resolve, 300)); };
            const clickAndCheck = async (element) => {
              if (!element) return null;
              const awb = (element.textContent.match(/\\d{3}-\\d{8}/) || [])[0] || "";
              element.click();
              await new Promise((resolve) => setTimeout(resolve, 500));
              const got = cockpitAwb();
              const ok = Boolean(awb) && got === awb.replace(/\\D/g, "");
              await back();
              return { awb, got, ok };
            };
            const rail = [...document.querySelectorAll(".desk2-row")];
            const railLast = await clickAndCheck(rail[rail.length - 1]);
            const railMid = await clickAndCheck([...document.querySelectorAll(".desk2-row")][Math.min(4, rail.length - 1)]);
            // Rows without an AWB in their text (e.g. the "Email sync is behind"
            // inbox row) cannot echo an AWB into the cockpit — the click-target
            // identity check only applies to shipment rows.
            const stageRows = () => [...document.querySelectorAll(".desktop-stage-row[data-stage-select]")]
              .filter((el) => /\d{3}-\d{8}/.test(el.textContent));
            const secondStage = await clickAndCheck(stageRows()[1] || stageRows()[0]);
            const thirdStage = await clickAndCheck(stageRows()[2] || stageRows()[0]);
            // Inbox: Open message must select AND focus the matching shipment.
            document.querySelector("[data-open-control-inbox]")?.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            const inboxButton = document.querySelector(".operator-inbox-item [data-open-inbox-shipment]");
            let inbox = null;
            if (inboxButton) {
              const itemAwb = (inboxButton.closest(".operator-inbox-item")?.dataset.awb || "").replace(/\\D/g, "");
              inboxButton.click();
              await new Promise((resolve) => setTimeout(resolve, 600));
              inbox = {
                itemAwb,
                got: cockpitAwb(),
                closed: !document.querySelector(".control-room-inbox-drawer"),
                ok: Boolean(itemAwb) && cockpitAwb() === itemAwb && !document.querySelector(".control-room-inbox-drawer"),
              };
              await back();
            }
            document.querySelector("[data-close-control-inbox]")?.click();
            return { railLast, railMid, secondStage, thirdStage, inbox };
          })(),
          // STATION-MEMORY SAVE: the Teach-station form must save through the
          // persistent document-level delegate — one POST per real click, no
          // browser-native navigation, surviving re-renders, with validation
          // errors visible INSIDE the editor (INC-2026-07-05-STATION-MEMORY).
          stationMemorySave: await (async () => {
            if (!matchMedia("(min-width: 1024px)").matches) return { skipped: true };
            if (typeof state === "undefined" || !state.shipments?.length || typeof renderStationMemoryEditor !== "function") return { skipped: true };
            const shipment = state.shipments[0];
            const realFetch = window.fetch;
            // This contract targets the persistent submit delegate. Keep it
            // independent of whatever backup/source-gap board fixture happened
            // to load on localhost; full-surface rendering is verified above.
            const realRenderActionSurfaces = renderActionSurfaces;
            const realRenderDetail = renderDetail;
            const realLoadSnapshot = loadSnapshot;
            const realRender = render;
            renderActionSurfaces = () => {};
            renderDetail = () => {};
            loadSnapshot = async () => {};
            render = () => {};
            let posts = 0;
            let navigated = false;
            window.addEventListener("beforeunload", () => { navigated = true; });
            let mode = "ok";
            window.fetch = (url, opts) => {
              if (String(url).includes("/api/station-memory")) {
                posts += 1;
                if (mode === "ok") {
                  return Promise.resolve(new Response(JSON.stringify({ ok: true, note: "Saved to station memory." }), { status: 200, headers: { "content-type": "application/json" } }));
                }
                return Promise.resolve(new Response(JSON.stringify({ error: "Airport is required" }), { status: 422, headers: { "content-type": "application/json" } }));
              }
              return realFetch(url, opts);
            };
            const host = document.createElement("div");
            document.body.appendChild(host);
            const renderForm = () => { host.innerHTML = renderStationMemoryEditor(shipment, "Station", { open: true }); };
            const submitOnce = async () => {
              renderForm();
              const form = host.querySelector("[data-station-memory-form]");
              if (!form) return false;
              form.elements.stationEmail.value = "uic-teach@station.test";
              form.elements.stationEmail.dispatchEvent(new Event("input", { bubbles: true }));
              form.querySelector("button[type='submit']").click();
              await new Promise((resolve) => setTimeout(resolve, 900));
              return true;
            };
            const ran = await submitOnce();
            const firstPosts = posts;
            await submitOnce(); // fresh nodes = the re-render/detached class
            const secondPosts = posts;
            const preservedAfterSave = (state.pendingStationMemoryEntries[shipment.id]?.stationEmail || "") === "uic-teach@station.test";
            mode = "fail";
            await submitOnce();
            const errorStatus = state.stationMemoryStatusById?.[shipment.id] || null;
            const errorHtml = renderStationMemoryEditor(shipment, "Station", { open: true });
            window.fetch = realFetch;
            renderActionSurfaces = realRenderActionSurfaces;
            renderDetail = realRenderDetail;
            loadSnapshot = realLoadSnapshot;
            render = realRender;
            host.remove();
            delete state.pendingStationMemoryEntries[shipment.id];
            delete state.stationMemoryStatusById[shipment.id];
            return {
              skipped: !ran,
              firstPosts,
              secondPosts,
              totalPosts: posts,
              navigated,
              preservedAfterSave,
              errorKind: errorStatus && errorStatus.kind,
              errorMessage: errorStatus && errorStatus.message,
              errorVisible: errorHtml.includes("memory-editor-status") && errorHtml.includes("Airport is required"),
            };
          })(),
        };
      })()`,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate failed");
    cdp.close();
    return result.result.value;
  } finally {
    child.kill("SIGKILL");
    await delay(300);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  }
}

async function behavioralChecks() {
  const chrome = chromePath();
  if (!chrome) {
    console.log("skip - Chrome not found; behavioral surface checks skipped");
    return;
  }
  const base = "http://127.0.0.1:4173";
  let server = null;
  const alreadyUp = await waitForOk(`${base}/`, 1500);
  if (!alreadyUp) {
    server = spawn("node", [path.join(ROOT_DIR, "server.js")], { stdio: "ignore" });
    const up = await waitForOk(`${base}/`, 15000);
    if (!up) {
      console.log("skip - local server did not start; behavioral surface checks skipped");
      if (server) server.kill("SIGKILL");
      return;
    }
  }
  try {
    const phone = await inspectSurface(chrome, `${base}/?filter=brain`, 390, 844);
    check(!phone.desktopMediaQuery, "phone viewport (390x844) stays below the desktop fork");
    check(
      phone.bodyClasses.includes("companion-mode") && !phone.bodyClasses.includes("desktop-workspace"),
      "390x844 renders the phone companion surface",
    );
    check(phone.backgroundColor === "rgb(5, 5, 5)", `phone surface is the black companion (got ${phone.backgroundColor})`);

    const desktop = await inspectSurface(chrome, `${base}/?filter=control`, 1440, 900);
    check(desktop.desktopMediaQuery, "desktop viewport (1440x900) crosses the fork");
    check(desktop.bodyClasses.includes("desktop-workspace"), "1440x900 renders the desktop workspace");
    check(desktop.hasControlRoom, "desktop shows the control room (lanes/table)");
    check(desktop.stagePresent, "desktop renders the action stage");
    check(desktop.deliveredPodPendingCountsActive, "delivered/POD-pending canonical rows remain active in browser counts and work surfaces");
    // Chat model v2: the work canvas carries NO composer — the docked
    // conversation column owns the only chat input; entry via top-bar button.
    check(!desktop.stageComposer, "work canvas hosts no chat composer (conversation column owns it)");
    check(desktop.companionEntry, "top bar offers the Ask Rowan companion entry");
    if (desktop.shipmentsActive) {
      check(
        desktop.stageCards > 0 || desktop.stageHonestEmpty,
        `stage is never blank-empty with ${desktop.shipmentsActive} active shipments (cards or honest all-clear)`,
      );
    }
    check(desktop.actionCardsMissingBoundary === 0, "every stage action card shows its approval boundary");
    if (desktop.journeyLabelContract && !desktop.journeyLabelContract.skipped) {
      const journey = desktop.journeyLabelContract;
      check(
        journey.preArrival[0] === "Arrival: current" && !journey.preArrival.includes("Landed: current"),
        `journey: pre-arrival renders neutral Arrival current (${journey.preArrival.join(" | ")})`,
      );
      check(
        journey.arrived[0] === "Arrival: complete" && journey.arrived[1] === "Customs: current",
        `journey: completed arrival advances to Customs (${journey.arrived.join(" | ")})`,
      );
    } else {
      check(false, "shipment journey behavioral contract ran on desktop");
    }
    if (desktop.truthCacheFallbackContract && !desktop.truthCacheFallbackContract.skipped) {
      const fallback = desktop.truthCacheFallbackContract;
      check(fallback.headerDetected && fallback.ordinaryNotDetected,
        "truth cache fallback: only the service-worker fallback header activates backup mode");
      check(
        fallback.ok === false && fallback.status === "degraded" && fallback.cacheFallback === true &&
          fallback.syncState?.state === "stale-fallback" && fallback.syncState?.lockActions === true,
        "truth cache fallback: cached payload fails closed and locks actions",
      );
      check(
        fallback.syncingState?.state === "syncing-live" && fallback.syncingState?.lockActions === true &&
          /stale backup copy/i.test(fallback.syncingState?.sub || ""),
        "truth cache fallback: first projection says syncing live while identifying the visible copy as stale",
      );
      check(
        fallback.normalAttemptTimeoutMs === 6000 && fallback.slowAttemptTimeoutMs === 8000 &&
          fallback.normalRequestTimeoutMs >= 13500 && fallback.liveRereadTimeoutMs >= 7500 &&
          fallback.liveRereadTimeoutMs < fallback.normalRequestTimeoutMs,
        "truth cache fallback: client timeout covers both SW attempts and the direct live re-read has one aligned attempt",
      );
      check(
        fallback.sourceHealth?.status === "degraded" && fallback.sourceHealth?.bundledFallback === true &&
          fallback.warnings.some((warning) => /old backup copy/i.test(warning)),
        "truth cache fallback: degraded source health and explicit old-backup warning survive projection",
      );
    } else {
      check(false, "truth API cache fallback behavioral contract ran on desktop");
    }
    if (desktop.laneNavigation && !desktop.laneNavigation.skipped) {
      for (const lane of desktop.laneNavigation.results || []) {
        check(lane.onlyThisLane, `lane filter: clicking "${lane.laneId}" shows only that lane's section`);
        check(lane.declared === lane.rows || lane.rows > 0,
          `lane filter: "${lane.laneId}" header count matches its rows (${lane.declared} vs ${lane.rows})`);
      }
      check(desktop.laneNavigation.allLanesBack, "lane filter: Show all restores every lane");
      check(desktop.laneNavigation.todayUnchanged, "lane filter: Today's Work counts are untouched by lane clicks");
    }
    if (desktop.clickTargets) {
      const targets = desktop.clickTargets;
      if (targets.railLast) check(targets.railLast.ok, `click target: LAST rail row opens its own AWB (${targets.railLast.awb} -> ${targets.railLast.got})`);
      if (targets.railMid) check(targets.railMid.ok, `click target: mid rail row opens its own AWB (${targets.railMid.awb} -> ${targets.railMid.got})`);
      if (targets.secondStage) check(targets.secondStage.ok, `click target: SECOND Today row opens its own AWB (${targets.secondStage.awb} -> ${targets.secondStage.got})`);
      if (targets.thirdStage) check(targets.thirdStage.ok, `click target: third Today row opens its own AWB (${targets.thirdStage.awb} -> ${targets.thirdStage.got})`);
      if (targets.inbox) check(targets.inbox.ok, `click target: inbox Open message opens the matching shipment and closes the drawer (${targets.inbox.itemAwb} -> ${targets.inbox.got})`);
    }
    if (desktop.stationMemorySave && !desktop.stationMemorySave.skipped) {
      const save = desktop.stationMemorySave;
      check(save.firstPosts === 1, `station save: real click posts exactly once (got ${save.firstPosts})`);
      check(save.secondPosts === 2, `station save: still posts after a re-render replaced the form nodes (got ${save.secondPosts})`);
      check(!save.navigated, "station save: no browser-native submit/navigation");
      check(save.preservedAfterSave, "station save: typed fields survive until the row confirms the contact");
      check(save.errorKind === "error" && save.errorVisible, `station save: 422 validation error is visible inside the editor (kind=${save.errorKind}; message=${save.errorMessage || "none"})`);
      check(save.totalPosts === 3, `station save: no duplicate handlers (3 submits -> ${save.totalPosts} posts)`);
    } else {
      check(false, "station-memory save behavioral check RAN (must not silently skip on desktop)");
    }
    check(desktop.repairCardsLocked === 0, "repair/truth-gathering cards are never locked");
    if (desktop.freshnessLevel && desktop.freshnessLevel !== "fresh") {
      check(
        desktop.draftCardsUnlocked === 0,
        `stale truth (${desktop.freshnessLevel}) locks all truth-asserting draft/document cards`,
      );
    } else {
      console.log(`ok - truth currently ${desktop.freshnessLevel || "unknown"}; stale-lock asserted statically`);
    }

    const demoUrl = await inspectSurface(chrome, `${base}/?demo=operator-flow`, 1440, 900);
    check(
      !demoUrl.bodyClasses.includes("demo") && (demoUrl.hasControlRoom || demoUrl.hasShipmentList),
      "?demo= URLs render the real product, not a synthetic demo",
    );

    if (phone.truthDegraded || desktop.truthDegraded) {
      check(phone.bannerVisible, "degraded truth banner visible on phone");
      check(desktop.bannerVisible, "degraded sync state visible on desktop (plain-language sync bar)");
    } else {
      console.log("ok - truth not degraded right now; banner visibility asserted statically");
    }
  } finally {
    if (server) server.kill("SIGKILL");
  }
}

(async () => {
  const staticOnly = process.argv.includes("--static-only");
  staticChecks();
  await serviceWorkerTruthNetworkChecks();
  if (!staticOnly) await behavioralChecks();
  if (failures.length) {
    console.error(`\n${failures.length} UI contract check(s) failed`);
    process.exit(1);
  }
  console.log("\nUI contract verified");
})();

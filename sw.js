"use strict";

const PIKIIO_SW_VERSION = "ops-loop-sw-v5";
const VERSIONED_APP_ASSET = "/app.min.js?v=desk2-v52";
const PIKIIO_BUILD = new URL(VERSIONED_APP_ASSET, self.location.origin).searchParams.get("v") || "unversioned";
const VERSIONED_STYLE_ASSET = `/styles.min.css?v=${encodeURIComponent(PIKIIO_BUILD)}`;
const SHELL_CACHE_NAME = `elai-shell-${PIKIIO_BUILD}`;
const TRUTH_CACHE_NAME = "elai-truth-api-v1";
const NAVIGATION_TIMEOUT_MS = 3500;
const TRUTH_NETWORK_TIMEOUT_MIN_MS = 4000;
const TRUTH_NETWORK_TIMEOUT_MS = 6000;
const TRUTH_SLOW_NETWORK_TIMEOUT_MS = 8000;
const TRUTH_NETWORK_ATTEMPTS = 2;
const TRUTH_LIVE_REREAD_HEADER = "x-pikiio-live-truth-reread";
const BLOCKED_BROWSER_SUPABASE_REST_REASON = "blocked-browser-supabase-rest";
const APP_SHELL_ASSETS = Object.freeze([
  "/",
  "/index.html",
  VERSIONED_APP_ASSET,
  VERSIONED_STYLE_ASSET,
  "/config.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/assets/elai-icon-192.png",
  "/assets/elai-icon-512.png",
  "/assets/li-logo-mark.png",
]);
const STATIC_ASSET_PATHS = new Set(APP_SHELL_ASSETS
  .map((asset) => new URL(asset, self.location.origin).pathname)
  .filter((pathname) => pathname !== "/" && pathname !== "/index.html"));

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE_NAME);
    const requests = APP_SHELL_ASSETS.map((asset) => new Request(
      new URL(asset, self.location.origin).href,
    ));
    await cache.addAll(requests);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames
      .filter((cacheName) => cacheName.startsWith("elai-shell-") && cacheName !== SHELL_CACHE_NAME)
      .map((cacheName) => caches.delete(cacheName)));
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    await Promise.all(clients.map(async (client) => {
      client.postMessage({ type: "app-runtime-refresh", version: PIKIIO_SW_VERSION });
      try {
        const url = new URL(client.url || "/", self.location.origin);
        if (url.origin === self.location.origin && "navigate" in client) await client.navigate(url.href);
      } catch {
        // Best effort only; the next navigation will still use the current shell.
      }
    }));
  })());
});

function isBlockedBrowserSupabaseRestRequest(request) {
  try {
    const url = new URL(request.url);
    return /\.supabase\.co$/i.test(url.hostname) && url.pathname.startsWith("/rest/v1/");
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  if (!isBlockedBrowserSupabaseRestRequest(event.request)) return;
  event.respondWith(new Response(JSON.stringify({
    ok: false,
    error: BLOCKED_BROWSER_SUPABASE_REST_REASON,
    guidance: "Browser Supabase REST reads are disabled. Use the server API wrappers.",
  }), {
    status: 410,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  }));
});

self.addEventListener("fetch", (event) => {
  if (isBlockedBrowserSupabaseRestRequest(event.request)) return;
  const url = requestUrl(event.request);
  if (!url) return;

  if (isCacheableTruthRead(event.request, url)) {
    const task = createTruthNetworkFirstTask(event.request, url);
    event.respondWith(task.responsePromise);
    event.waitUntil(task.donePromise);
    return;
  }

  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(navigationNetworkFirst(event.request));
    return;
  }

  if (isStaticAssetRequest(event.request, url)) {
    const task = createStaticStaleWhileRevalidateTask(event.request);
    event.respondWith(task.responsePromise);
    event.waitUntil(task.donePromise);
  }
});

function requestUrl(request) {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

function hasOnlyQueryKeys(url, allowedKeys) {
  return [...new Set(url.searchParams.keys())].every((key) => allowedKeys.has(key));
}

function isCacheableTruthRead(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (request.headers.has("authorization")) return false;
  if (request.headers.has(TRUTH_LIVE_REREAD_HEADER)) return false;

  if (url.pathname === "/api/brain/shipments") {
    return hasOnlyQueryKeys(url, new Set(["ts"]));
  }
  if (url.pathname === "/api/truth/health") {
    return hasOnlyQueryKeys(url, new Set(["ts"]));
  }
  if (url.pathname === "/api/snapshots") {
    return hasOnlyQueryKeys(url, new Set(["keys", "slim", "metadata", "ts"]));
  }
  return false;
}

function normalizedTruthCacheKey(url) {
  const normalized = new URL(url.href);
  normalized.searchParams.delete("ts");
  normalized.searchParams.sort();
  normalized.hash = "";
  return normalized.href;
}

function isRetriableNetworkStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function responseWithHeaders(response, extraHeaders) {
  const headers = new Headers(response.headers);
  Object.entries(extraHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function truthResponseForCache(response) {
  return responseWithHeaders(response, {
    "x-pikiio-cached-at": new Date().toISOString(),
  });
}

function truthCacheFallbackResponse(response) {
  return responseWithHeaders(response, {
    "cache-control": "no-store",
    "warning": '110 - "Response is stale"',
    "x-pikiio-cache-fallback": "1",
    "x-pikiio-cache-source": "truth-api",
  });
}

async function responsePrefix(response, maxCharacters = 512) {
  const body = response.clone().body;
  if (!body || typeof body.getReader !== "function") return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let prefix = "";
  try {
    while (prefix.length < maxCharacters) {
      const { done, value } = await reader.read();
      if (value) prefix += decoder.decode(value, { stream: !done });
      if (done || prefix.length >= maxCharacters) break;
    }
    return prefix.slice(0, maxCharacters);
  } catch {
    return "";
  } finally {
    reader.cancel().catch(() => {});
  }
}

function fetchWithTimeout(request, timeoutMs, cacheMode = "no-store") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, {
    cache: cacheMode,
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
}

function truthNetworkTimeoutMs(connection = self.navigator?.connection) {
  const effectiveType = String(connection?.effectiveType || "").toLowerCase();
  const timeoutMs = ["slow-2g", "2g", "3g"].includes(effectiveType)
    ? TRUTH_SLOW_NETWORK_TIMEOUT_MS
    : TRUTH_NETWORK_TIMEOUT_MS;
  return Math.max(TRUTH_NETWORK_TIMEOUT_MIN_MS, timeoutMs);
}

async function fetchTruthNetworkAttempt(request, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), truthNetworkTimeoutMs());
  try {
    const response = await fetch(request, {
      cache: "no-store",
      signal: controller.signal,
    });
    let prefix = "";
    if (url.pathname === "/api/snapshots" || url.pathname === "/api/brain/shipments") {
      prefix = await responsePrefix(response);
    }
    if (controller.signal.aborted) {
      const timeoutError = new Error("Truth network attempt timed out");
      timeoutError.name = "AbortError";
      throw timeoutError;
    }
    const snapshotUnavailable = url.pathname === "/api/snapshots" &&
      /^\s*\{\s*"ok"\s*:\s*false(?:\s*[,}])/.test(prefix);
    const bundledBrainFallback = url.pathname === "/api/brain/shipments" &&
      prefix.includes('"source":"shipment-truth-packets-bundled-backup"');
    return {
      response,
      retryable: isRetriableNetworkStatus(response.status) || snapshotUnavailable || bundledBrainFallback,
      cacheable: response.ok && !bundledBrainFallback,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function cachedTruthFallback(cache, cacheKey) {
  const cached = await cache.match(cacheKey);
  return cached ? truthCacheFallbackResponse(cached) : null;
}

function createTruthNetworkFirstTask(request, url) {
  let cacheWritePromise = Promise.resolve();
  const responsePromise = (async () => {
    const cache = await caches.open(TRUTH_CACHE_NAME);
    const cacheKey = normalizedTruthCacheKey(url);
    let lastResponse = null;
    let lastError = null;
    for (let attempt = 0; attempt < TRUTH_NETWORK_ATTEMPTS; attempt += 1) {
      try {
        const result = await fetchTruthNetworkAttempt(request, url);
        lastResponse = result.response;
        if (result.retryable) continue;
        if (result.cacheable) {
          cacheWritePromise = cache.put(cacheKey, truthResponseForCache(result.response.clone()));
        }
        return result.response;
      } catch (error) {
        lastError = error;
      }
    }
    const cached = await cachedTruthFallback(cache, cacheKey);
    if (cached) return cached;
    if (lastResponse) return lastResponse;
    throw lastError || new Error("Truth network read failed");
  })();

  return {
    responsePromise,
    donePromise: responsePromise.then(() => cacheWritePromise).catch(() => {}),
  };
}

async function navigationNetworkFirst(request) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
    if (!isRetriableNetworkStatus(response.status)) return response;
    const cached = await cache.match("/index.html") || await cache.match("/");
    return cached ? responseWithHeaders(cached, { "x-pikiio-cache-fallback": "shell" }) : response;
  } catch (error) {
    const cached = await cache.match("/index.html") || await cache.match("/");
    if (cached) return responseWithHeaders(cached, { "x-pikiio-cache-fallback": "shell" });
    throw error;
  }
}

function createStaticStaleWhileRevalidateTask(request) {
  const cachePromise = caches.open(SHELL_CACHE_NAME);
  const refreshPromise = cachePromise.then(async (cache) => {
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok && response.type !== "opaque") await cache.put(request, response.clone());
    return response;
  });
  const responsePromise = cachePromise.then(async (cache) => {
    const cached = await cache.match(request);
    return cached || refreshPromise;
  });
  return {
    responsePromise,
    donePromise: refreshPromise.then(() => {}).catch(() => {}),
  };
}

function isStaticAssetRequest(request, url) {
  return request.method === "GET" &&
    url.origin === self.location.origin &&
    !request.headers.has("range") &&
    STATIC_ASSET_PATHS.has(url.pathname);
}

function pushApplicationServerKey(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const raw = atob(padded);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output;
}

async function resubscribeChangedOperatorPush(newSubscription = null) {
  const configResponse = await fetch("/api/operator/push/config", { cache: "no-store" });
  const config = await configResponse.json().catch(() => ({}));
  if (!configResponse.ok || !config.enabled || !config.publicKey) {
    throw new Error(`Operator push resubscribe is not ready: ${(config.missing || []).join(", ")}`);
  }
  const subscription = newSubscription ||
    await self.registration.pushManager.getSubscription() ||
    await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: pushApplicationServerKey(config.publicKey),
    });
  const response = await fetch("/api/operator/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      label: "Yael PWA",
    }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || "Unable to restore operator push subscription");
  }
}

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribeChangedOperatorPush(event.newSubscription || null));
});

function pushPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { body: event.data.text() };
  }
}

async function notifyOpenClients(payload) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "operator-push", payload });
  }
}

self.addEventListener("push", (event) => {
  const payload = pushPayload(event);
  const title = payload.title || "Yael";
  const options = {
    body: payload.body || "Shipment needs attention.",
    tag: payload.tag || payload.eventId || "operator-event",
    renotify: true,
    icon: "/assets/elai-icon-192.png",
    badge: "/assets/elai-icon-192.png",
    data: {
      url: payload.url || "/",
      eventId: payload.eventId || "",
      awb: payload.awb || "",
      payload,
    },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    notifyOpenClients(payload),
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if ("focus" in client) {
        client.postMessage({ type: "operator-notification-click", payload: event.notification.data?.payload || {} });
        await client.focus();
        if ("navigate" in client) return client.navigate(targetUrl);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});

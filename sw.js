/* 무명 서비스 워커: 오프라인 셸 + 푸시 알림 */
const CACHE = "mumyeong-v2";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 앱 파일은 네트워크 우선(항상 최신), 실패하면 캐시
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      return (await caches.match(req)) || (await caches.match("index.html")) || Response.error();
    }
  })());
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "무명", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "무명";
  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body: d.body || "",
      tag: d.tag || "mumyeong",
      renotify: true,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: d.url || "./" },
    });
    if (self.navigator && self.navigator.setAppBadge && typeof d.badge === "number") {
      try { await self.navigator.setAppBadge(d.badge || 1); } catch { /* noop */ }
    }
  })());
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  const tab = url.includes("tab=letters") ? "letters" : "chat";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) { c.postMessage({ type: "open", tab }); return c.focus(); }
    }
    return self.clients.openWindow(url);
  })());
});

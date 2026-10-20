// JSH Expenses service worker: app shell offline + Android share target
const SHELL = "jsh-shell-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/expenses/", "/expenses/manifest.webmanifest", "/expenses/icon.svg"])).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("jsh-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/expenses/share-target") {
    e.respondWith((async () => {
      const form = await e.request.formData();
      const cache = await caches.open("share-inbox");
      let n = 0;
      for (const f of form.getAll("files")) {
        if (!(f instanceof File)) continue;
        await cache.put(`/shared/${Date.now()}-${n++}`, new Response(f, { headers: { "content-type": f.type, "x-name": encodeURIComponent(f.name || "shared") } }));
      }
      return Response.redirect("/expenses/?shared=" + n + "#capture", 303);
    })());
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/expenses/")) return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(SHELL).then((x) => x.put("/expenses/", c)); return r; }).catch(() => caches.match("/expenses/")));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

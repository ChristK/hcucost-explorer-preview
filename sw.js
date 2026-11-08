// =============================================================================
// web/sw.js - service worker of the hcucost web explorer (2026-11-08): keeps the page, webR's main files
// (webr/: R.wasm, 12 MB, its worker and libraries) and the R packages (repo/) in the browser's cache, so
// repeat visits start without downloading them again. Same-origin GET requests only. It cannot make the
// page work offline: webR reads R's base library (webr/vfs/) through synchronous requests from its
// worker, which service workers do not see (checked with test/sw_cache_probe.mjs); those files use the
// browser's ordinary HTTP cache.
// Strategy "stale while revalidate": answer from the cache when possible and refresh the cached copy
// from the network in the background (so a rebuilt package reaches the visitor on the next visit).
// Bump CACHE when the cached layout changes; old caches are deleted on activation.
// =============================================================================
const CACHE = 'hcucost-web-v1';
const CORE = ['./', 'index.html', 'app.js', 'style.css', 'hcucost_web.R'];

self.addEventListener('install', (event) => {
  // each file on its own: a missing one (e.g. the preview's encrypted app.js) must not stop the install
  event.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();   // control the page that registered us, so its first visit is cached too
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: false });
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => undefined);
    if (cached) {
      event.waitUntil(network);   // refresh in the background
      return cached;
    }
    const res = await network;
    return res || new Response('offline and not cached', { status: 503, statusText: 'offline' });
  })());
});

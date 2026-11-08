// =============================================================================
// web-fast/sw.js - service worker of the R-free explorer (2026-11-08; adapted from web/sw.js): keeps the page,
// the calculation engine (hcucore.wasm, engine.js, worker.js) and the models it has used in the browser's
// cache, so repeat visits start at once and the page works offline once it has been opened (every request
// is an ordinary fetch, which the service worker sees; the webR page could not do this). Same-origin GET
// requests only; "stale while revalidate": answer from the cache and refresh it in the background.
// Its caches are named hcucost-web-fast-*: it deletes only its own old ones.
// =============================================================================
const CACHE = 'hcucost-web-fast-v1';
const CORE = ['./', 'index.html', 'app.js', 'style.css', 'worker.js', 'engine.js', 'rng_r.js', 'hcucore.mjs', 'hcucore.wasm',
              'models/CY/index.json', 'models/CY/A.json', 'models/CY/A.bin'];

self.addEventListener('install', (event) => {
  // each file on its own: a missing one (e.g. the preview's encrypted app.js) must not stop the install
  event.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('hcucost-web-fast-') && k !== CACHE) await caches.delete(k);
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

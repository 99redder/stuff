const CACHE_PREFIX = 'mom-budget-phone-';
const CACHE_NAME = `${CACHE_PREFIX}v23`;
const BASE = new URL('./', self.location.href);
const EXPECTED_SCOPE = new URL('./mom-budget-phone.html', self.location.href).href;
const LEGACY = self.registration.scope !== EXPECTED_SCOPE;
// Cache only the empty app shell and icons. Never cache API responses or private
// information. This explicit allowlist excludes arbitrary same-origin GETs.
const STATIC_ASSETS = [
  './', './mom-budget-phone.html', './mom-budget-manifest.webmanifest',
  './mom-budget-icon.svg', './mom-budget-icon-192.png', './mom-budget-icon-512.png'
].map(path => new URL(path, BASE).href);

self.addEventListener('install', event => {
  self.skipWaiting();
  if (!LEGACY) event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(CACHE_PREFIX) && (LEGACY || key !== CACHE_NAME)) await caches.delete(key);
    }
    if (LEGACY) await self.registration.unregister();
    else await self.clients.claim();
    for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      const url = new URL(client.url);
      const isPhone = LEGACY ? url.pathname.endsWith('/mom-budget-phone.html') : (url.origin === BASE.origin && url.pathname.startsWith(BASE.pathname));
      // Reload the former phone page, which now redirects to the private app.
      // Clients on unrelated desktop/mobile pages remain untouched. Leave setup
      // links alone so an activation cannot interrupt an enrollment in progress.
      if (LEGACY && isPhone) await client.navigate(client.url).catch(() => {});
    }
  })());
});

self.addEventListener('fetch', event => {
  if (LEGACY || event.request.method !== 'GET' || !STATIC_ASSETS.includes(event.request.url)) return;
  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request, { cache: 'no-store' });
      if (fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, fresh.clone());
      }
      return fresh;
    } catch {
      return await caches.match(event.request) || Response.error();
    }
  })());
});

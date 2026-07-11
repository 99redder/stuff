const CACHE_PREFIX = 'mom-budget-phone-';
const CACHE_NAME = `${CACHE_PREFIX}v11`;
const APP_SCOPE = new URL('./mom-budget-phone.html', self.location.href).href;
const STATIC_ASSETS = [
  './mom-budget-phone.html',
  './mom-budget-manifest.webmanifest',
  './mom-budget-icon.svg',
  './mom-budget-icon-192.png',
  './mom-budget-icon-512.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Retire the broad repository-root registration used by older releases.
    // A retired worker may control an existing tab until its next navigation,
    // so the fetch handler below also refuses to intercept outside APP_SCOPE.
    if (self.registration.scope !== APP_SCOPE) {
      await self.registration.unregister();
      return;
    }

    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (self.registration.scope !== APP_SCOPE || event.request.method !== 'GET') return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request, { cache: 'no-store' });
      if (fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(event.request, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(event.request);
      return cached || Response.error();
    }
  })());
});

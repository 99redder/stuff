const CACHE_NAME = 'mom-budget-phone-v3';
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
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith((async () => {
    try {
      const fresh = await fetch(event.request, { cache: 'no-store' });
      const cache = await caches.open(CACHE_NAME);
      cache.put(event.request, fresh.clone());
      return fresh;
    } catch {
      const cached = await caches.match(event.request);
      return cached || Response.error();
    }
  })());
});

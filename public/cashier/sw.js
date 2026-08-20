const CACHE_NAME = 'mutia-cashier-v1';
const ASSETS_TO_CACHE = ['./', './index.html'];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS_TO_CACHE)));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(r => r || caches.match('./index.html'))));
});
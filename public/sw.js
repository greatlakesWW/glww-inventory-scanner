const CACHE = 'glww-scanner-v3';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
});
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) { e.respondWith(fetch(e.request)); return; }
  e.respondWith(
    fetch(e.request).then(r => {
      // Don't cache chrome-extension requests or non-HTTP schemas
      if (!e.request.url.startsWith('http')) return r;

      const c = r.clone();
      caches.open(CACHE).then(cache => cache.put(e.request, c)).catch(() => {});
      return r;
    }).catch(() => caches.match(e.request))
  );
});

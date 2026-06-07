// Minimal service worker — its presence (plus the manifest) makes the app
// installable and satisfies the PWA criteria. We deliberately keep caching
// network-first so the single-page app shell always reflects the latest deploy;
// the agent data itself is fetched live from each team's server and must never
// be served stale.
const CACHE = 'cicy-shell-v1';

self.addEventListener('install', (event) => {
  // Activate this worker immediately on first install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop any older shell caches.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle GET navigations/assets from our own origin. Everything else
  // (the agent API calls to remote team servers) passes straight through.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        // Network-first: always try the live deploy, fall back to cache offline.
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        // Last resort for navigations: the cached index shell.
        if (req.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        throw new Error('offline and not cached');
      }
    })(),
  );
});

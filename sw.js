/* Event Picks service worker.
   - App files: served from a versioned cache, so the app opens offline.
   - data/*.json: network first, saved copy when offline.
   - Other sites (Ticketmaster): not touched.
   - A new version waits until the page asks it to take over (update banner). */
'use strict';
const VERSION = '0.6.0';             // keep equal to BUILD in js/events.js
const CACHE = 'event-picks-' + VERSION;
const DATA = 'event-picks-data';
const SHELL = [
  './', 'index.html', 'css/styles.css',
  'js/events.js', 'js/store.js', 'js/api.js', 'js/rank.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];

const DATA_FILES = ['data/venues.json', 'data/events.json'];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache so a new version never stores old files
  event.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))),
    // listings too, so the very first visit already works offline (best effort: never blocks the install)
    caches.open(DATA).then(c => Promise.all(DATA_FILES.map(u => {
      const key = new URL(u, self.registration.scope).href;
      return fetch(new Request(u, { cache: 'reload' })).then(r => (r.ok ? c.put(key, r) : null)).catch(() => null);
    })))
  ]));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('event-picks-') && k !== CACHE && k !== DATA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

async function networkFirst(request) {
  const cache = await caches.open(DATA);
  const key = new URL(request.url);
  key.search = '';
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(key.href, res.clone());
    return res;
  } catch (err) {
    const saved = await cache.match(key.href);
    if (saved) return saved;
    throw err;
  }
}

async function shellFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = request.mode === 'navigate'
    ? await cache.match('index.html')
    : await cache.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) event.respondWith(networkFirst(req));
  else event.respondWith(shellFirst(req));
});

// Glassy service worker. Bump VERSION whenever shell files change.
const VERSION = 'glassy-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = 'glassy-api-v1';
const TERRAIN_CACHE = 'glassy-terrain-v1';
const CDN_CACHE = 'glassy-cdn-v1';
const BASEMAP_CACHE = 'glassy-basemap-v1';
const KEEP = [SHELL_CACHE, API_CACHE, TERRAIN_CACHE, CDN_CACHE, BASEMAP_CACHE];

const LIMITS = { [API_CACHE]: 80, [TERRAIN_CACHE]: 400, [BASEMAP_CACHE]: 500, [CDN_CACHE]: 20 };

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'css/charts.css',
  'js/main.js',
  'js/spots.js',
  'js/net.js',
  'js/api.js',
  'js/geo.js',
  'js/geo.worker.js',
  'js/terrain.js',
  'js/model.js',
  'js/report.js',
  'js/charts.js',
  'js/map.js',
  'js/scene3d.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // Add individually so one missing file doesn't abort the install.
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('glassy-') && !KEEP.includes(n)).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

async function trim(cacheName) {
  const max = LIMITS[cacheName];
  if (!max) return;
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  // keys() is in insertion order: drop the oldest
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await fetch(event.request);
  if (cacheable(res)) {
    event.waitUntil(cache.put(event.request, res.clone()).then(() => trim(cacheName)).catch(() => {}));
  }
  return res;
}

async function networkFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(event.request);
    if (res.ok) event.waitUntil(cache.put(event.request, res.clone()).then(() => trim(cacheName)).catch(() => {}));
    return res;
  } catch (err) {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(event.request, { ignoreSearch: cacheName === SHELL_CACHE });
  const net = fetch(event.request).then((res) => {
    if (cacheable(res)) {
      return cache.put(event.request, res.clone()).then(() => trim(cacheName)).catch(() => {}).then(() => res);
    }
    return res;
  });
  if (hit) {
    event.waitUntil(net.catch(() => {}));
    return hit;
  }
  return net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(event, SHELL_CACHE).catch(async () => (await caches.match('index.html')) || Response.error()));
      return;
    }
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
    return;
  }

  // Bathymetry tiles never change
  if (url.hostname === 's3.amazonaws.com' && url.pathname.startsWith('/elevation-tiles-prod/')) {
    event.respondWith(cacheFirst(event, TERRAIN_CACHE));
    return;
  }
  // Versioned libraries
  if (url.hostname === 'cdnjs.cloudflare.com') {
    event.respondWith(cacheFirst(event, CDN_CACHE));
    return;
  }
  // Forecast / geocoding: fresh when online, last known when offline
  if (url.hostname.endsWith('open-meteo.com') || url.hostname === 'nominatim.openstreetmap.org') {
    event.respondWith(networkFirst(event, API_CACHE));
    return;
  }
  // Basemap tiles (Esri)
  if (url.hostname.endsWith('arcgisonline.com') && url.pathname.includes('/MapServer/tile/')) {
    event.respondWith(staleWhileRevalidate(event, BASEMAP_CACHE));
  }
});

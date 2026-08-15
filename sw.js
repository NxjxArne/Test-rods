// sw.js — caches the app shell so the app opens instantly and the drive
// screen keeps working with no signal once a route has been loaded.
const CACHE = 'copilot-shell-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/geo.js',
  './js/api.js',
  './js/app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Only shell-cache same-origin GETs; let API calls (Nominatim/OSRM) hit the network directly.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

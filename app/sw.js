// NAVI service worker: offline shell only.
// - Precaches the app shell, campus data, fonts and Leaflet under a versioned cache.
// - Handles GET requests for this origin only. Anything under /api/ and every non-GET request
//   (guide requests, actions, samples) goes straight to the network: control requests are never
//   cached, queued or replayed later.
// - Map tiles from other origins are not intercepted and are never bulk-cached.
const VERSION = 'navi-shell-0.1.0';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/campus.js', 'js/config.js', 'js/filter.js', 'js/geo.js', 'js/map.js', 'js/sensors.js', 'js/ui.js',
  'js/providers/demo.js', 'js/providers/emitter.js', 'js/providers/live.js', 'js/sim/groundstation.js', 'js/sim/walker.js',
  'data/campus.v1.json', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2', 'fonts/inter-latin-600-normal.woff2',
  'fonts/space-grotesk-latin-500-normal.woff2', 'fonts/space-grotesk-latin-700-normal.woff2',
  'fonts/jetbrains-mono-latin-500-normal.woff2', 'fonts/jetbrains-mono-latin-600-normal.woff2',
  'icons/icon.svg', 'icons/icon-192.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('navi-shell-') && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/')) return;
  // Network first for the shell so updates arrive promptly; the cached copy is the offline fallback.
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        const scope = new URL(self.registration.scope);
        const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
        if (rel !== null && (rel === '' || SHELL.includes(rel) || rel.startsWith('img/') || rel.startsWith('icons/'))) {
          caches.open(VERSION).then(c => c.put(req, copy));
        }
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});

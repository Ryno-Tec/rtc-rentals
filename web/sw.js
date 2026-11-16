// RTC Rentals service worker: makes the app installable and keeps the screens
// available on a weak or dropped connection. Data always comes live from Supabase;
// nothing from the database is cached here.
const VERSION = 'rtc-rentals-v1';
const SHELL = ['./', 'index.html', 'dashboard.html', 'properties.html', 'tenants.html', 'rent.html', 'tenant.html',
  'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png',
  'js/config.js', 'js/data.js', 'js/shell.js', 'js/ledger.js', 'js/dashboard.js', 'js/properties.js',
  'js/tenants.js', 'js/rent.js', 'js/tenant.js', 'js/tenant-data.js', 'js/pwa.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The Supabase client library is versioned on the CDN: cache it once.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
      return res;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return; // Supabase and everything else: straight to the network
  // Our own files: network first so updates arrive at once, cached copy when offline.
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});

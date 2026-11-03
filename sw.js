const CACHE = 'rsq-rasp-field-d1f86cde675b';
const SHELL = ["./","index.html","config.json","app.js","vault.mjs","transport.mjs","ops.mjs","app.css","ops-modules.js","ops-modules.css","offline.mjs","codec.mjs","catalog.json","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png"];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('rsq-rasp-field-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const base = new URL('./', self.registration.scope).pathname;
  if (!url.pathname.startsWith(base)) return;
  let rel = url.pathname.slice(base.length) || './';
  if (req.mode === 'navigate') rel = './';
  if (!SHELL.includes(rel)) return;
  e.respondWith(caches.open(CACHE).then((c) => c.match(rel === './' ? './' : rel).then((hit) => hit || fetch(req))));
});

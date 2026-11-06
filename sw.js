const CACHE = 'rsq-rasp-field-24969b8d2113';
const SHELL = ["./","index.html","config.json","app.js","vault.mjs","transport.mjs","ops.mjs","app.css","ops-modules.js","ops-modules.css","offline.mjs","tssExport.mjs","tssFile.mjs","raspPhotos.mjs","codec-photos.mjs","raspChunks.mjs","photoTransport.mjs","pwaPhotos.mjs","codec.mjs","catalog.json","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png"];
const TILES = 'rsq-rasp-tiles-v1', TILE_ORIGIN = 'https://tile.openstreetmap.org', TILE_PATH = /^\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/, TILE_MAX = 4000, TILE_WAIT_MS = 4000;
async function trimTiles(c) { try { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - TILE_MAX))) await c.delete(k); } catch {} }
async function tile(href) {
  const c = await caches.open(TILES);
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), TILE_WAIT_MS);
  try {
    const r = await fetch(href, { mode: 'cors', credentials: 'omit', signal: ac.signal });
    if (r.ok) { await c.put(href, r.clone()); trimTiles(c); return r; }
    return (await c.match(href)) || r;
  } catch { return (await c.match(href)) || Response.error(); } finally { clearTimeout(t); }
}
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
  if (url.origin === TILE_ORIGIN && TILE_PATH.test(url.pathname)) { e.respondWith(tile(url.href)); return; }
  if (url.origin !== self.location.origin) return;
  const base = new URL('./', self.registration.scope).pathname;
  if (!url.pathname.startsWith(base)) return;
  let rel = url.pathname.slice(base.length) || './';
  if (req.mode === 'navigate') rel = './';
  if (!SHELL.includes(rel)) return;
  e.respondWith(caches.open(CACHE).then((c) => c.match(rel === './' ? './' : rel).then((hit) => hit || fetch(req))));
});

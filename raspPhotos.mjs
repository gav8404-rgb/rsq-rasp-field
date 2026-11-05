// rasp-photos/1: field photos for the RASP TSS client (Wix HTML iframe). Standalone ES module, no dependencies.
// photos-r2: + optional location tag `place` {zone, floor, room} per photo (TSS "By location" view); sent on the link only
// when set (an untagged link body is byte-identical to photos-r1).
//
// Flow: capture (camera or gallery) -> downscale + re-encode JPEG (max 2048 px, q 0.8) -> strip all metadata (EXIF/GPS,
// XMP, ICC, comments) -> queue {photo, cell tag} in the local store (IndexedDB, or the encrypted TSS vault) ->
// "save to folder" = local download -> on sync: PUT /api/beta/originals/:mediaId (existing verified Drive route) ->
// POST /api/beta/records/:recordId/photos (author-append cell link, attributed by the server-derived actor).
//
// photo-tag-r1 (2026-11-04): already-taken photos.
//   - intakeBatch(files, {assign}) processes many library photos ONE AT A TIME (serialized), with progress, and keeps a
//     batch record in the store so an interrupted batch (reload, lock) reports which photos were not added yet.
//     With `assign` the photos go to that question (like capture); without it they go to this site's UNASSIGNED tray.
//   - Tray items are stripped and stored exactly like captured photos, but are NEVER uploaded or linked until the member
//     assigns them to a record + question (assign). unassign / remove work until the photo is linked.
//   - The original's EXIF capture time (DateTimeOriginal) is read before stripping and kept on this device only, for
//     display; it is never sent. GPS: a tray photo keeps its EXIF location in the store (deviceLocation, never sent) only
//     until it is assigned: if the question asks for coordinates (photos-r2 F7) it becomes the link's location,
//     otherwise it is deleted. A duplicate of a photo already on this device is skipped (sha256 of the source bytes).
//   - Decode failure (e.g. HEIC in a browser without HEIC support) -> PHOTO_DECODE_FAILED; above 5 MB at the lowest
//     quality the photo is re-rendered smaller (2048 -> 1600 -> 1280 -> 1024 px) before PHOTO_TOO_LARGE.
//   The upload body, the link body and the server routes are unchanged from photos-r2.
//
// Location is never kept in the image bytes. Only when the caller says the cell asks for location
// (wantsLocation: true) is the original's EXIF GPS read and sent as a separate, explicit field on the link.
// All network calls go through the bound bridge `fetcher` (same one OfflineWorkspace uses); nothing talks to Wix or
// Google directly and no provider URL is ever returned to this module.

export const PHOTOS_VERSION = 'rasp-photos/1';
export const MAX_DIM = 2048;
export const JPEG_QUALITY = 0.8;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;          // server cap on PUT /api/beta/originals
const MIN_QUALITY = 0.45;
export const DOWNSCALE_STEPS = [1600, 1280, 1024];       // photo-tag-r1: tried in order when MAX_DIM is still > 5 MB
export const BATCH_VERSION = 'rasp-photo-batch/1';
const CELL = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const PLACE_ZONE = /^(Z(0[1-9]|1[0-9])|FLOOR|R-[A-Z]{2,10})$/, PLACE_FLOOR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, PLACE_ROOM = /^R-[A-Z]{2,10}$/;
const PLACE_DEVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/;
// Same rule as the server (photoPlace): null, or {zone, floor, room}; floor = the stable floor id (never the label).
export function checkPlace(p) {
  if (p === null || p === undefined) return null;
  const ok = p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).every((k) => ['zone', 'floor', 'room', 'device'].includes(k))
    && typeof p.zone === 'string' && PLACE_ZONE.test(p.zone)
    && (p.floor == null || (typeof p.floor === 'string' && PLACE_FLOOR.test(p.floor)))
    && (p.room == null || (typeof p.room === 'string' && PLACE_ROOM.test(p.room)))
    // a drawing-register device (photos-r2 update 5): only on a floor, never in a room card
    && (p.device == null || (p.zone === 'FLOOR' && typeof p.floor === 'string' && p.room == null && typeof p.device === 'string' && PLACE_DEVICE.test(p.device)));
  if (!ok) fail('PHOTO_PLACE_INVALID');
  return p.device == null ? { zone: p.zone, floor: p.floor ?? null, room: p.room ?? null } : { zone: p.zone, floor: p.floor, room: null, device: p.device };
}

export class PhotoError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new PhotoError(code, status); };

// ---------------------------------------------------------------------------------------------------------------
// JPEG metadata

export const isJpeg = (b) => b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8;

// Marker segments before the first SOS. Yields {marker, start, end, data}; the last item is {marker: 'scan', start}.
function* segments(b) {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xFF) fail('JPEG_STRUCTURE_INVALID');
    while (b[i + 1] === 0xFF) i++;                         // fill bytes
    const m = b[i + 1];
    if (m === undefined) fail('JPEG_STRUCTURE_INVALID');
    if (m === 0xD9) return;
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (i + 4 > b.length) fail('JPEG_STRUCTURE_INVALID');
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) fail('JPEG_STRUCTURE_INVALID');
    yield { marker: m, start: i, end: i + 2 + len, data: b.subarray(i + 4, i + 2 + len) };
    if (m === 0xDA) { yield { marker: 'scan', start: i + 2 + len }; return; }
    i += 2 + len;
  }
}
const ascii = (d, n) => String.fromCharCode(...d.subarray(0, n));
function metadataSegment(s) {
  if (s.marker === 0xFE) return true;                                   // COM
  if (s.marker >= 0xE1 && s.marker <= 0xEF) return true;                // APP1..APP15: EXIF/GPS, XMP, ICC, IPTC, MPF...
  if (s.marker === 0xE0) return !(ascii(s.data, 5) === 'JFIF\0' && s.data.length >= 14 && s.data[12] === 0 && s.data[13] === 0); // keep thumbnail-free JFIF only
  return false;
}
// Remove every metadata segment; image segments (DQT, SOF, DHT, DRI, SOS + entropy data) are copied byte-exact.
export function stripJpegMetadata(bytes) {
  if (!isJpeg(bytes)) fail('JPEG_REQUIRED');
  const parts = [bytes.subarray(0, 2)];
  let scanned = false;
  for (const s of segments(bytes)) {
    if (s.marker === 'scan') { parts.push(bytes.subarray(s.start)); scanned = true; break; }
    if (!metadataSegment(s)) parts.push(bytes.subarray(s.start, s.end));
  }
  if (!scanned) fail('JPEG_SCAN_MISSING');
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export function jpegMetadataMarkers(bytes) {
  const found = [];
  for (const s of segments(bytes)) { if (s.marker !== 'scan' && metadataSegment(s)) found.push(s.marker); }
  return found;
}

// photo-tag-r1: the EXIF TIFF block of a JPEG (APP1 "Exif") or a HEIF/HEIC file (meta > iinf item "Exif" > iloc), or null.
export function exifTiff(bytes) {
  try {
    if (isJpeg(bytes)) {
      for (const s of segments(bytes)) if (s.marker === 0xE1 && ascii(s.data, 6) === 'Exif\0\0') return s.data.subarray(6);
      return null;
    }
    return heifExif(bytes);
  } catch { return null; }
}
function heifExif(b) {
  const u = (o, n) => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + b[o + k]; return v; };
  const boxes = function* (start, end) {
    let i = start;
    while (i + 8 <= end) {
      let size = u(i, 4), hdr = 8;
      const type = ascii(b.subarray(i + 4), 4);
      if (size === 1) { size = u(i + 8, 8); hdr = 16; } else if (size === 0) size = end - i;
      if (size < hdr || i + size > end) return;
      yield { type, s: i + hdr, e: i + size };
      i += size;
    }
  };
  if (b.length < 12 || ascii(b.subarray(4), 4) !== 'ftyp') return null;
  let meta = null;
  for (const x of boxes(0, b.length)) if (x.type === 'meta') { meta = x; break; }
  if (!meta) return null;
  const ids = new Set();
  let iloc = null, idat = null;
  for (const x of boxes(meta.s + 4, meta.e)) {
    if (x.type === 'iinf') {
      const v = b[x.s];
      for (const it of boxes(x.s + 4 + (v === 0 ? 2 : 4), x.e)) {
        if (it.type !== 'infe' || b[it.s] < 2) continue;
        const w = b[it.s] === 2 ? 2 : 4, q = it.s + 4;
        if (ascii(b.subarray(q + w + 2), 4) === 'Exif') ids.add(u(q, w));
      }
    } else if (x.type === 'iloc') iloc = x; else if (x.type === 'idat') idat = x;
  }
  if (!ids.size || !iloc) return null;
  const v = b[iloc.s];
  let p = iloc.s + 4;
  const os = b[p] >> 4, ls = b[p] & 15, bs = b[p + 1] >> 4, xs = v === 1 || v === 2 ? b[p + 1] & 15 : 0;
  p += 2;
  const w = v < 2 ? 2 : 4, n = u(p, w); p += w;
  for (let k = 0; k < n; k++) {
    const id = u(p, w); p += w;
    let method = 0;
    if (v === 1 || v === 2) { method = u(p, 2) & 15; p += 2; }
    p += 2;
    const base = u(p, bs); p += bs;
    const ne = u(p, 2); p += 2;
    const parts = [];
    for (let e = 0; e < ne; e++) { p += xs; const eo = u(p, os); p += os; const el = u(p, ls); p += ls; parts.push([eo, el]); }
    if (!ids.has(id)) continue;
    if (method > 1) return null;
    const origin = method === 1 && idat ? idat.s : 0;
    const blob = new Uint8Array(parts.reduce((a, [, el]) => a + el, 0));
    let o = 0;
    for (const [eo, el] of parts) { const st = origin + base + eo; if (st + el > b.length) return null; blob.set(b.subarray(st, st + el), o); o += el; }
    if (blob.length < 4) return null;
    const skip = blob[0] * 16777216 + (blob[1] << 16) + (blob[2] << 8) + blob[3];
    const isTiff = (x) => x.length >= 8 && ((x[0] === 0x49 && x[1] === 0x49 && x[2] === 42 && x[3] === 0) || (x[0] === 0x4D && x[1] === 0x4D && x[2] === 0 && x[3] === 42));
    let t = blob.subarray(Math.min(blob.length, 4 + skip));
    if (!isTiff(t)) { for (let k = 4; k + 8 <= blob.length && k < 64; k++) if (isTiff(blob.subarray(k))) { t = blob.subarray(k); break; } }   // writers that mis-set the offset
    return isTiff(t) ? t : null;
  }
  return null;
}
function tiffReader(t) {
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4D && t[1] === 0x4D)) return null;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
  const entries = (ifd) => { const n = u16(ifd), out = new Map(); for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; out.set(u16(e), e); } return out; };
  const str = (e) => { const n = u32(e + 4), o = n <= 4 ? e + 8 : u32(e + 8); let r = ''; for (let k = 0; k < n && t[o + k]; k++) r += String.fromCharCode(t[o + k]); return r.trim(); };
  return { u16, u32, entries, str };
}
// EXIF capture time -> {local: 'YYYY-MM-DDTHH:MM:SS', offset: '+01:00' | null} or null. Local display only (never sent).
export function readExifTime(bytes) {
  try {
    const t = exifTiff(bytes), r = t && tiffReader(t);
    if (!r) return null;
    const ifd0 = r.entries(r.u32(4));
    let raw = null, off = null;
    if (ifd0.has(0x8769)) {
      const ex = r.entries(r.u32(ifd0.get(0x8769) + 8));
      if (ex.has(0x9003)) raw = r.str(ex.get(0x9003));
      if (ex.has(0x9011)) off = r.str(ex.get(0x9011));
    }
    if (!raw && ifd0.has(0x0132)) raw = r.str(ifd0.get(0x0132));
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw ?? '');
    if (!m) return null;
    return { local: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, offset: /^[+-]\d{2}:\d{2}$/.test(off ?? '') ? off : null };
  } catch { return null; }
}

// EXIF GPS -> {lat, lon, accuracyM} or null. Bounds-checked; any malformed structure yields null.
// photo-tag-r1: also reads HEIF/HEIC (same TIFF parsing; the JPEG path is unchanged).
export function readExifGps(bytes) {
  try {
    if (!isJpeg(bytes)) { const t = heifExif(bytes); return t ? gpsOfTiff(t) : null; }
    for (const s of segments(bytes)) {
      if (s.marker !== 0xE1 || ascii(s.data, 6) !== 'Exif\0\0') continue;
      return gpsOfTiff(s.data.subarray(6));
    }
  } catch { /* malformed -> no location */ }
  return null;
}
function gpsOfTiff(t) {
  try {
    {
      const le = t[0] === 0x49 && t[1] === 0x49;
      if (!le && !(t[0] === 0x4D && t[1] === 0x4D)) return null;
      const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
      const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
      const entries = (ifd) => { const n = u16(ifd), out = new Map(); for (let k = 0; k < n; k++) { const e = ifd + 2 + k * 12; out.set(u16(e), e); } return out; };
      const gpsPtr = entries(u32(4)).get(0x8825);
      if (gpsPtr === undefined) return null;
      const gps = entries(u32(gpsPtr + 8));
      const ref = (tag) => gps.has(tag) ? String.fromCharCode(t[gps.get(tag) + 8]) : null;
      const rat = (o) => { const d = u32(o + 4); return d ? u32(o) / d : NaN; };
      const dms = (tag) => { if (!gps.has(tag)) return NaN; const o = u32(gps.get(tag) + 8); return rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600; };
      let lat = dms(2), lon = dms(4);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      if (ref(1) === 'S') lat = -lat;
      if (ref(3) === 'W') lon = -lon;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      const acc = gps.has(0x1F) ? rat(u32(gps.get(0x1F) + 8)) : NaN;
      return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6, accuracyM: Number.isFinite(acc) && acc >= 0 && acc <= 1e5 ? acc : null };
    }
  } catch { /* malformed -> no location */ }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Image processing

export function browserImaging(g = globalThis) {
  return {
    async render(file, maxDim) {
      const bmp = await g.createImageBitmap(file, { imageOrientation: 'from-image' });  // applies EXIF orientation before it is stripped
      const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const width = Math.max(1, Math.round(bmp.width * scale)), height = Math.max(1, Math.round(bmp.height * scale));
      let canvas;
      if (typeof g.OffscreenCanvas === 'function') canvas = new g.OffscreenCanvas(width, height);
      else { canvas = g.document.createElement('canvas'); canvas.width = width; canvas.height = height; }
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bmp, 0, 0, width, height);
      bmp.close?.();
      const encode = (quality) => canvas.convertToBlob
        ? canvas.convertToBlob({ type: 'image/jpeg', quality })
        : new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new PhotoError('ENCODE_FAILED')), 'image/jpeg', quality));
      return { width, height, encode };
    }
  };
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes) { return hex(await crypto.subtle.digest('SHA-256', bytes)); }

export async function processPhoto(file, { keepLocation = false, maxDim = MAX_DIM, quality = JPEG_QUALITY, imaging = browserImaging() } = {}) {
  if (!file || typeof file.arrayBuffer !== 'function') fail('PHOTO_FILE_REQUIRED');
  if (file.type && !file.type.startsWith('image/')) fail('PHOTO_TYPE_DENIED');
  const source = new Uint8Array(await file.arrayBuffer());
  const location = keepLocation ? readExifGps(source) : null;
  const takenAt = readExifTime(source);                     // photo-tag-r1: this device only (display), never sent
  const sourceSha256 = await sha256Hex(source);             // photo-tag-r1: duplicate check on this device only
  let r, q, bytes;
  for (const dim of [maxDim, ...DOWNSCALE_STEPS.filter((d) => d < maxDim)]) {   // photo-tag-r1: downscale before giving up
    try { r = await imaging.render(file, dim); } catch (e) { if (e instanceof PhotoError) throw e; fail('PHOTO_DECODE_FAILED'); }
    q = quality;
    for (;;) {
      bytes = stripJpegMetadata(new Uint8Array(await (await r.encode(q)).arrayBuffer()));
      if (bytes.length <= MAX_UPLOAD_BYTES || q <= MIN_QUALITY) break;
      q = Math.max(MIN_QUALITY, q - 0.15);
    }
    if (bytes.length <= MAX_UPLOAD_BYTES) break;
  }
  if (bytes.length > MAX_UPLOAD_BYTES) fail('PHOTO_TOO_LARGE');
  if (jpegMetadataMarkers(bytes).length) fail('PHOTO_METADATA_NOT_STRIPPED');
  return { blob: new Blob([bytes], { type: 'image/jpeg' }), size: bytes.length, sha256: await sha256Hex(bytes), width: r.width, height: r.height, quality: q, location, takenAt, sourceSha256 };
}

// ---------------------------------------------------------------------------------------------------------------
// Local store: {get(key), update(key, fn)}. Pass the TSS encrypted vault in production (same interface as
// OfflineWorkspace's `database`); idbStore() is a plain IndexedDB fallback.

export function idbStore(indexedDB = globalThis.indexedDB, name = 'rasp-photos-r1') {
  if (!indexedDB) fail('INDEXEDDB_UNAVAILABLE');
  let opening = null;
  const open = () => opening ??= new Promise((res, rej) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error ?? new PhotoError('INDEXEDDB_OPEN_FAILED'));
  });
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', mode), os = tx.objectStore('kv');
      let out;
      fn(os, (v) => { out = v; });
      tx.oncomplete = () => res(out);
      tx.onerror = tx.onabort = () => rej(tx.error ?? new PhotoError('INDEXEDDB_TX_FAILED'));
    });
  };
  return {
    get: (key) => run('readonly', (os, set) => { const r = os.get(key); r.onsuccess = () => set(r.result); }),
    update: (key, fn) => run('readwrite', (os, set) => {
      const r = os.get(key);
      r.onsuccess = () => { const next = fn(r.result === undefined ? undefined : r.result); os.put(next, key); set(next); };
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Queue + sync

const newPhotoId = () => 'ph_' + crypto.randomUUID().replaceAll('-', '');
const transient = (e) => !(e instanceof PhotoError) || e.status === undefined || e.status >= 500 || e.status === 408 || e.status === 429;

export class PhotoQueue {
  #store; #fetcher; #session; #now; #newId; #imaging; #online; #syncing = null; #intaking = Promise.resolve();
  constructor({ store, fetcher, session, now = () => Date.now(), newId = newPhotoId, imaging = undefined, online = () => globalThis.navigator?.onLine !== false }) {
    if (!store || typeof store.get !== 'function' || typeof store.update !== 'function') fail('PHOTO_STORE_REQUIRED');
    if (!session?.actor || !session.selected?.projectId || !session.selected.siteId) fail('PREVIOUS_AUTHORIZED_WORKSPACE_REQUIRED');
    this.#store = store; this.#fetcher = fetcher; this.#session = structuredClone(session);
    this.#now = now; this.#newId = newId; this.#imaging = imaging; this.#online = online;
    this.partition = JSON.stringify([session.actor, session.selected.projectId, session.selected.siteId]);
  }
  #indexKey() { return this.partition + ':@photos'; }
  #blobKey(id) { return this.partition + ':@photo:' + id; }
  #batchKey() { return this.partition + ':@photo-batch'; }
  async #index() { return (await this.#store.get(this.#indexKey())) ?? { version: 1, items: {} }; }
  async #patch(id, fn) {
    await this.#store.update(this.#indexKey(), (prev) => {
      const idx = prev ?? { version: 1, items: {} };
      if (!idx.items[id]) fail('PHOTO_NOT_QUEUED');
      idx.items[id] = { ...idx.items[id], ...fn(idx.items[id]) };
      return idx;
    });
  }
  async #request(path, init = {}) {
    if (typeof this.#fetcher !== 'function') fail('BRIDGE_REQUIRED');
    const s = this.#session;
    const headers = { 'x-rasp-csrf': s.csrf, 'x-rasp-actor': s.actor, 'x-rasp-project': s.selected.projectId, 'x-rasp-site': s.selected.siteId, ...init.headers };
    const r = await this.#fetcher('/api/beta/' + path, { ...init, credentials: 'same-origin', cache: 'no-store', headers });
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON */ }
    if (!r.ok) fail(body?.error ?? 'HTTP_' + r.status, r.status);
    return body;
  }

  // Capture: process, then persist bytes + tagged metadata. Works offline.
  async capture(file, { recordId, cell, wantsLocation = false, place = null }) {
    if (!ID.test(recordId ?? '')) fail('INVALID_RECORD_ID');
    if (!CELL.test(cell ?? '')) fail('PHOTO_CELL_INVALID');
    const tag = checkPlace(place);
    const p = await processPhoto(file, { keepLocation: wantsLocation === true, ...(this.#imaging ? { imaging: this.#imaging } : {}) });
    const id = this.#newId(), linkId = this.#newId();
    const item = { version: 1, id, linkId, recordId, cell, mimeType: 'image/jpeg', sha256: p.sha256, size: p.size, width: p.width, height: p.height,
      location: wantsLocation === true ? p.location : null, place: tag, state: 'queued', createdAt: new Date(this.#now()).toISOString(), receipt: null, link: null, error: null,
      takenAt: p.takenAt ?? null, sourceSha256: p.sourceSha256 ?? null, sourceName: sourceNameOf(file), fileDate: fileDateOf(file) };
    await this.#store.update(this.#blobKey(id), () => ({ blob: p.blob, sha256: p.sha256 }));
    await this.#store.update(this.#indexKey(), (prev) => { const idx = prev ?? { version: 1, items: {} }; idx.items[id] = item; return idx; });
    return structuredClone(item);
  }
  async list({ recordId, cell } = {}) {
    const items = Object.values((await this.#index()).items).filter((i) => (!recordId || i.recordId === recordId) && (!cell || i.cell === cell));
    return items.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1).map(publicItem);
  }

  // ---- photo-tag-r1: already-taken photos ---------------------------------------------------------------------------
  // Tray intake: stripped + stored like a capture, state 'unassigned', no record / cell; never uploaded until assigned.
  async intake(file) {
    const p = await processPhoto(file, { keepLocation: true, ...(this.#imaging ? { imaging: this.#imaging } : {}) });
    const dup = Object.values((await this.#index()).items).find((i) => i.sourceSha256 === p.sourceSha256 && i.state !== 'failed');
    if (dup) return { duplicate: true, item: publicItem(dup) };
    const id = this.#newId(), linkId = this.#newId();
    const item = { version: 1, id, linkId, recordId: null, cell: null, mimeType: 'image/jpeg', sha256: p.sha256, size: p.size, width: p.width, height: p.height,
      location: null, deviceLocation: p.location ?? null, place: null, state: 'unassigned', createdAt: new Date(this.#now()).toISOString(), receipt: null, link: null, error: null,
      takenAt: p.takenAt ?? null, sourceSha256: p.sourceSha256, sourceName: sourceNameOf(file), fileDate: fileDateOf(file) };
    await this.#store.update(this.#blobKey(id), () => ({ blob: p.blob, sha256: p.sha256 }));
    await this.#store.update(this.#indexKey(), (prev) => { const idx = prev ?? { version: 1, items: {} }; idx.items[id] = item; return idx; });
    return { duplicate: false, item: publicItem(item) };
  }
  // Edit one item that is not linked yet. Validated on the LATEST stored item inside the write (never throws inside the
  // store callback), so a concurrent sync that linked it wins and this edit is refused.
  async #edit(id, fn) {
    if (!(await this.#index()).items[id]) fail('PHOTO_NOT_QUEUED');
    let refused = null, result;
    await this.#store.update(this.#indexKey(), (prev) => {
      const idx = prev ?? { version: 1, items: {} }, cur = idx.items[id];
      if (!cur) { refused = 'PHOTO_NOT_QUEUED'; return idx; }
      if (cur.link || cur.state === 'linked') { refused = 'PHOTO_ALREADY_LINKED'; return idx; }
      result = fn(cur);
      if (result) idx.items[id] = result; else delete idx.items[id];
      return idx;
    });
    if (refused) fail(refused);
    return result;
  }
  // Assign (tray -> question) or move (question -> another question) a photo that is not linked yet. Location: the tray
  // photo's EXIF location becomes the link location ONLY when the question asks for coordinates; it is deleted either way.
  async assign(id, { recordId, cell, wantsLocation = false, place = null } = {}) {
    if (!ID.test(recordId ?? '')) fail('INVALID_RECORD_ID');
    if (!CELL.test(cell ?? '')) fail('PHOTO_CELL_INVALID');
    const tag = checkPlace(place);
    return publicItem(await this.#edit(id, (cur) => {
      const location = wantsLocation === true ? (cur.state === 'unassigned' ? cur.deviceLocation ?? null : cur.location ?? null) : null;
      const { deviceLocation, ...rest } = cur;
      return { ...rest, recordId, cell, place: tag, location, state: cur.receipt ? 'uploaded' : 'queued', error: null };
    }));
  }
  // Back to the tray (not linked yet). The location (if any) is dropped; it is not restored.
  async unassign(id) {
    return publicItem(await this.#edit(id, (cur) => {
      const { deviceLocation, ...rest } = cur;
      return { ...rest, recordId: null, cell: null, place: null, location: null, state: 'unassigned', error: null };
    }));
  }
  // Remove from this device (not linked yet). If its original was already uploaded, the Drive copy stays (driveCopy: true).
  async remove(id) {
    let gone;
    await this.#edit(id, (cur) => { gone = cur; return null; });
    await this.#store.update(this.#blobKey(id), () => ({ removed: true }));
    return { id, driveCopy: Boolean(gone.receipt) };
  }
  // Many files, one at a time (never two decodes at once), with progress and a batch record in the store.
  // assign = {recordId, cell, wantsLocation, place}: each photo goes to that question (a photo already on that question
  // is skipped); otherwise each goes to the tray (a photo already anywhere on this device is skipped).
  intakeBatch(files, { assign = null, onProgress = null } = {}) {
    const run = this.#intaking.then(() => this.#intakeBatch([...(files ?? [])], assign, onProgress));
    this.#intaking = run.catch(() => {});
    return run;
  }
  async #intakeBatch(files, assign, onProgress) {
    if (assign) { if (!ID.test(assign.recordId ?? '')) fail('INVALID_RECORD_ID'); if (!CELL.test(assign.cell ?? '')) fail('PHOTO_CELL_INVALID'); checkPlace(assign.place); }
    const batch = { version: BATCH_VERSION, id: this.#newId(), startedAt: new Date(this.#now()).toISOString(), target: assign ? { recordId: assign.recordId, cell: assign.cell } : 'tray',
      total: files.length, names: files.map(sourceNameOf), added: 0, duplicates: 0, failed: [], done: [], finished: false };
    await this.#store.update(this.#batchKey(), () => batch);
    const report = () => ({ total: batch.total, done: batch.done.length, added: batch.added, duplicates: batch.duplicates, failed: batch.failed.length });
    onProgress?.(report());
    for (let k = 0; k < files.length; k++) {
      const file = files[k];
      try {
        if (assign) {
          const src = await sha256Hex(new Uint8Array(await file.arrayBuffer()));
          const there = Object.values((await this.#index()).items).some((i) => i.recordId === assign.recordId && i.cell === assign.cell && i.sourceSha256 === src && i.state !== 'failed');
          if (there) batch.duplicates++; else { await this.capture(file, assign); batch.added++; }
        } else {
          const r = await this.intake(file);
          if (r.duplicate) batch.duplicates++; else batch.added++;
        }
      } catch (e) {
        if (e?.code === 'LOCAL_UNLOCK_REQUIRED' || e?.code === 'LOCAL_UNLOCK_OR_INTEGRITY_FAILED') throw e;   // vault locked: stop, batch stays open
        batch.failed.push({ name: batch.names[k], code: e?.code ?? e?.message ?? String(e) });
      }
      batch.done.push(k);
      await this.#store.update(this.#batchKey(), () => batch);
      onProgress?.(report());
    }
    batch.finished = true;
    await this.#store.update(this.#batchKey(), () => batch);
    return { ...report(), failedItems: batch.failed.map((f) => ({ ...f })) };
  }
  // The last batch (null if none). interrupted = it did not finish (reload / lock): `notAdded` = file names to pick again.
  async batch() {
    const b = await this.#store.get(this.#batchKey());
    if (!b || b.version !== BATCH_VERSION || b.cleared) return null;
    const done = new Set(b.done);
    return { total: b.total, done: b.done.length, added: b.added, duplicates: b.duplicates, failed: b.failed.length, failedItems: b.failed.map((f) => ({ ...f })),
      target: b.target, startedAt: b.startedAt, finished: b.finished, interrupted: !b.finished, notAdded: b.finished ? [] : b.names.filter((_, k) => !done.has(k)) };
  }
  async clearBatch() { await this.#store.update(this.#batchKey(), () => ({ version: BATCH_VERSION, cleared: true })); }
  async blob(id) {
    const row = await this.#store.get(this.#blobKey(id));
    if (!row?.blob) fail('PHOTO_NOT_QUEUED');
    return row.blob;
  }
  // "Save to a folder": a local download the user keeps (Files / Downloads). Returns the file name.
  async saveToFolder(id, doc = globalThis.document) {
    const item = (await this.list()).find((i) => i.id === id);
    if (!item) fail('PHOTO_NOT_QUEUED');
    const name = photoFileName(item, this.#session);
    downloadBlob(await this.blob(id), name, doc);
    return name;
  }

  // Upload then link every pending item, oldest first. Serialized; safe to call repeatedly (server is idempotent).
  // photo-tag-r1: tray photos (state 'unassigned') are skipped; onProgress({done, total}) after each item.
  sync({ onProgress = null } = {}) { return this.#syncing ??= this.#sync(onProgress).finally(() => { this.#syncing = null; }); }
  async #sync(onProgress) {
    const s = this.#session, out = { state: 'done', uploaded: 0, linked: 0, failed: 0, pending: 0 };
    const pending = (await this.list()).filter((i) => i.state !== 'linked' && i.state !== 'unassigned');
    if (!pending.length) return out;
    if (!this.#online()) return { ...out, state: 'offline', pending: pending.length };
    let n = 0;
    onProgress?.({ done: 0, total: pending.length });
    for (const item of pending) {
      try {
        if (!item.receipt) {
          const res = await this.#request('originals/' + item.id, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'x-content-sha256': item.sha256 }, body: await this.blob(item.id) });
          const o = res?.original;
          if (!(o && o.mediaId === item.id && o.sha256 === item.sha256 && o.actor === s.actor && o.projectId === s.selected.projectId && o.siteId === s.selected.siteId && o.state === 'verified_original' && o.mimeType === 'image/jpeg')) fail('UPLOAD_RECEIPT_INVALID');
          await this.#patch(item.id, () => ({ receipt: o, state: 'uploaded', error: null }));
          out.uploaded++;
        }
        const cur = (await this.#index()).items[item.id];   // photo-tag-r1: moved / sent back to the tray meanwhile?
        if (!cur || cur.state === 'unassigned' || cur.link) continue;
        Object.assign(item, { recordId: cur.recordId, cell: cur.cell, location: cur.location, place: cur.place });
        const res = await this.#request('records/' + item.recordId + '/photos', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ linkId: item.linkId, cell: item.cell, mediaId: item.id, location: item.location, ...(item.place ? { place: item.place } : {}) }) });
        const l = res?.link;
        if (!(l && l.linkId === item.linkId && l.mediaId === item.id && l.cell === item.cell && l.recordId === item.recordId && l.actor === s.actor && l.mine === true && l.sha256 === item.sha256 && /^[a-f0-9]{64}$/.test(l.receiptId)
          && JSON.stringify(l.place ?? null) === JSON.stringify(item.place ?? null))) fail('LINK_RECEIPT_INVALID');
        await this.#patch(item.id, () => ({ link: l, state: 'linked', error: null }));
        out.linked++;
        onProgress?.({ done: ++n, total: pending.length });
      } catch (e) {
        const code = e?.code ?? e?.message ?? String(e);
        await this.#patch(item.id, () => ({ error: code }));
        if (transient(e) || e.status === 401 || e.status === 403) { out.state = e.status === 401 || e.status === 403 ? 'denied' : 'retry'; out.code = code; break; }
        await this.#patch(item.id, () => ({ state: 'failed' }));
        out.failed++;
      }
    }
    out.pending = (await this.list()).filter((i) => i.state !== 'linked' && i.state !== 'failed' && i.state !== 'unassigned').length;
    return out;
  }

  // Every author's photo links for one record, grouped by cell (server view; never edited here).
  async links(recordId) {
    if (!ID.test(recordId ?? '')) fail('INVALID_RECORD_ID');
    return this.#request('records/' + recordId + '/photos', { method: 'GET' });
  }
  // Bytes of a linked photo (any author in this workspace), verified against the server's sha256.
  async fetchPhoto(mediaId, expectedSha256 = null) {
    if (!ID.test(mediaId ?? '')) fail('INVALID_MEDIA_ID');
    const r = await this.#request('originals/' + mediaId, { method: 'GET' });
    if (!(r?.version === 1 && r.encoding === 'base64url' && typeof r.data === 'string' && r.original?.mediaId === mediaId && /^image\/(jpeg|png)$/.test(r.original.mimeType))) fail('ORIGINAL_REPLY_INVALID');
    const bytes = fromB64url(r.data);
    const digest = await sha256Hex(bytes);
    if (digest !== r.original.sha256 || (expectedSha256 && digest !== expectedSha256)) fail('ORIGINAL_HASH_MISMATCH');
    return new Blob([bytes], { type: r.original.mimeType });
  }
}

// photo-tag-r1: list() / UI never see the tray location, only whether there is one.
function publicItem(i) {
  const { deviceLocation, ...rest } = structuredClone(i);
  return { ...rest, hasDeviceLocation: deviceLocation != null };
}
const sourceNameOf = (f) => String(f?.name ?? 'photo').replace(/[\u0000-\u001f]/g, '').slice(0, 120);
const fileDateOf = (f) => (Number.isFinite(f?.lastModified) && f.lastModified > 0 ? new Date(f.lastModified).toISOString() : null);

function fromB64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) fail('ORIGINAL_REPLY_INVALID');
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function photoFileName(item, session) {
  const safe = (v) => String(v).replace(/[^A-Za-z0-9_-]/g, '-');
  return `RASP_${safe(session.selected.projectId)}_${safe(item.recordId)}_cell-${safe(item.cell)}_${safe(item.id)}.jpg`;
}
export function downloadBlob(blob, name, doc = globalThis.document) {
  const url = URL.createObjectURL(blob);
  try {
    const a = doc.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    doc.body.append(a); a.click(); a.remove();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
}

// Two inputs: camera (capture=environment) and library (no capture attribute, multiple). onFile(file) is called once per file.
export function mountPhotoInputs(container, { onFile, disabled = false, doc = globalThis.document }) {
  const make = (label, capture) => {
    const input = doc.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment');
    else input.multiple = true;
    input.disabled = disabled;
    input.addEventListener('change', () => { for (const f of input.files ?? []) onFile(f); input.value = ''; });
    const wrap = doc.createElement('label');
    wrap.className = 'rg-photo-input';
    wrap.append(doc.createTextNode(label + ' '), input);
    return { wrap, input };
  };
  const camera = make('Take photo', true), gallery = make('Add from library', false);
  container.append(camera.wrap, gallery.wrap);
  return { camera: camera.input, gallery: gallery.input };
}

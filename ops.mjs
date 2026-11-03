export const OPS_STALE_MS = 6 * 3600e3;
export const OPS_RESYNC_MS = 15 * 60e3;
export const OPS_CACHE_SCHEMA = 'rsq-rasp-ops-cache/1';
export const OPS_WIPE_CODES = new Set(['NOT_AUTHORIZED', 'DEVICE_TOKEN_REQUIRED', 'DEVICE_UNKNOWN', 'DEVICE_EXPIRED', 'DEVICE_REVOKED', 'SIGNATURE_INVALID', 'DEVICE_ACCESS_DISABLED']);
const OP_RE = /^[A-Za-z0-9_-]{1,32}$/;
const keyOf = (op) => 'ops:' + op;
const DB = 'rsq-rasp-field', STORE = 'kv';
export function idbDelete(key) {
  return new Promise((res, rej) => {
    const o = indexedDB.open(DB, 1);
    o.onupgradeneeded = () => o.result.createObjectStore(STORE);
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const db = o.result;
      try {
        const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(key);
        t.oncomplete = () => { db.close(); res(); };
        t.onerror = t.onabort = () => { db.close(); rej(t.error); };
      } catch (e) { db.close(); rej(e); }
    };
  });
}
const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function acceptablePayload(p, op) {
  return obj(p) && obj(p.meta) && p.meta.project === op && p.meta.role === 'restricted' && !('signals' in p) && Array.isArray(p.sections) && Array.isArray(p.tasks);
}

export function createOpsFeed({ vault, transport, now = () => Date.now(), rawDelete = idbDelete }) {
  async function load(op) {
    if (!OP_RE.test(String(op ?? ''))) return null;
    const r = await vault.getJSON(keyOf(op));
    return obj(r) && r.schema === OPS_CACHE_SCHEMA && r.op === op && Number.isFinite(r.receivedAt) && acceptablePayload(r.payload, op) ? r : null;
  }
  async function wipe(op) { if (OP_RE.test(String(op ?? ''))) await rawDelete('enc:' + keyOf(op)); }
  async function wipeAll() { for (const n of await vault.names('ops:')) if (n !== 'ops:last') await rawDelete('enc:' + n); }
  async function sync(op) {
    if (!OP_RE.test(String(op ?? ''))) return { rec: null, error: 'OP_UNKNOWN', wiped: false };
    try {
      const payload = await transport.ops(op);
      if (!acceptablePayload(payload, op)) return { rec: await load(op), error: 'OPS_REPLY_REFUSED', wiped: false };
      const rec = { schema: OPS_CACHE_SCHEMA, op, payload, receivedAt: now() };
      await vault.putJSON(keyOf(op), rec);
      await vault.putJSON('ops:last', op);
      return { rec, error: null, wiped: false };
    } catch (e) {
      const code = e?.code ?? 'OPS_FAILED';
      if (OPS_WIPE_CODES.has(code)) { await wipe(op); return { rec: null, error: code, wiped: true }; }
      return { rec: await load(op), error: code, wiped: false };
    }
  }
  async function lastOp() { const v = await vault.getJSON('ops:last'); return typeof v === 'string' && OP_RE.test(v) ? v : null; }
  return Object.freeze({ load, sync, wipe, wipeAll, lastOp });
}

const pad = (n) => String(n).padStart(2, '0');
export function freshness(rec, t = Date.now()) {
  if (!rec || !Number.isFinite(rec.receivedAt)) return { text: 'Not loaded yet', stale: true, ageMs: Infinity, staleText: 'No operation data on this device yet: connect once to load it.' };
  const d = new Date(rec.receivedAt), n = new Date(t), age = t - rec.receivedAt;
  const same = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const text = 'Updated ' + (same ? hm : d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'short' }) + ' ' + hm);
  const stale = age > OPS_STALE_MS;
  const h = Math.floor(age / 3600e3);
  return { text, stale, ageMs: age, staleText: stale ? `Stale: last update ${h >= 48 ? Math.floor(h / 24) + ' days' : h + ' h'} ago. Connect to refresh.` : '' };
}

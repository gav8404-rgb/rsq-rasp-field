const DB = 'rsq-rasp-field', STORE = 'kv', ITERATIONS = 600000;
export const UNLOCK_MS = 12 * 3600e3;
export const MIN_PASSPHRASE = 12;
export const AUTO_LOCK_HIDDEN_MS = 5 * 60e3, AUTO_LOCK_IDLE_MS = 15 * 60e3;
export const CLOCK_BACK_MS = 60e3;
const perfNow = () => (globalThis.performance?.now ? globalThis.performance.now() : Date.now());
const enc = new TextEncoder(), dec = new TextDecoder();

function open() {
  return new Promise((res, rej) => {
    const o = indexedDB.open(DB, 1);
    o.onupgradeneeded = () => o.result.createObjectStore(STORE);
    o.onerror = () => rej(o.error);
    o.onsuccess = () => res(o.result);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), q = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(q ? q.result : undefined); };
    t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  });
}
function derive(pass, salt, iterations = ITERATIONS) {
  return crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey'])
    .then((material) => crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
}
const rawGet = (k) => tx('readonly', (s) => s.get(k));
const rawPut = (k, v) => tx('readwrite', (s) => s.put(v, k));
const rawKeys = () => tx('readonly', (s) => s.getAllKeys());
export const rawDeleteAll = () => tx('readwrite', (s) => s.clear());

export class VaultError extends Error { constructor(code) { super(code); this.code = code; } }

export class Vault {
  #key = null;
  #until = 0;
  #at = null;
  constructor({ now = () => Date.now(), mono = perfNow } = {}) { this.now = now; this.mono = mono; }
  async exists() { return !!(await rawGet('vault:meta')); }
  unlocked() {
    if (!this.#key || !this.#at) return false;
    const w = this.now() - this.#at.wall;
    return w >= -CLOCK_BACK_MS && w < UNLOCK_MS && this.mono() - this.#at.mono < UNLOCK_MS;
  }
  expiresAt() { return this.#key ? this.#until : 0; }
  lock() { this.#key = null; this.#until = 0; this.#at = null; }
  #hold(key) { this.#key = key; this.#at = { wall: this.now(), mono: this.mono() }; this.#until = this.#at.wall + UNLOCK_MS; }
  #derive(pass, salt) { return derive(pass, salt); }
  async create(pass) {
    if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new VaultError('PASSPHRASE_TOO_SHORT');
    if (await this.exists()) throw new VaultError('VAULT_EXISTS');
    const salt = crypto.getRandomValues(new Uint8Array(32)), key = await this.#derive(pass, salt);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const check = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('vault:check') }, key, enc.encode('rsq-vault-ok'));
    await rawPut('vault:meta', { v: 1, salt, iterations: ITERATIONS, iv, check });
    this.#hold(key);
  }
  async #check(pass) {
    const meta = await rawGet('vault:meta');
    if (!meta) throw new VaultError('VAULT_NOT_FOUND');
    const key = await this.#derive(String(pass ?? ''), meta.salt);
    try {
      const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: meta.iv, additionalData: enc.encode('vault:check') }, key, meta.check);
      if (dec.decode(out) !== 'rsq-vault-ok') throw Error();
    } catch { throw new VaultError('PASSPHRASE_WRONG'); }
    return key;
  }
  async unlock(pass) {
    const key = await this.#check(pass);
    this.#hold(key);
  }
  async verifyPassphrase(pass) { await this.#check(pass); return true; }
  #need() { if (!this.unlocked()) { this.lock(); throw new VaultError('LOCAL_UNLOCK_REQUIRED'); } }
  async getJSON(name) {
    this.#need();
    const box = await rawGet('enc:' + name);
    if (!box) return undefined;
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: enc.encode('enc:' + name) }, this.#key, box.ct);
    return JSON.parse(dec.decode(out));
  }
  async putJSON(name, value) {
    this.#need();
    const text = JSON.stringify(value);
    if (text === undefined) throw new VaultError('VALUE_NOT_SERIALIZABLE');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('enc:' + name) }, this.#key, enc.encode(text));
    await rawPut('enc:' + name, { iv, ct });
  }
  async names(prefix) { return (await rawKeys()).filter((k) => typeof k === 'string' && k.startsWith('enc:' + prefix)).map((k) => k.slice(4)); }
  async deviceKey() {
    let pair = await rawGet('device:keypair');
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      await rawPut('device:keypair', pair);
    }
    return pair;
  }
  database() {
    const self = this;
    const row = (k) => 'row:' + k;
    return Object.freeze({
      isUnlocked: () => self.unlocked(),
      get: (k) => self.getJSON(row(k)),
      async update(k, fn, opts = {}) {
        const run = async () => {
          const prev = await self.getJSON(row(k));
          const next = fn(prev === undefined ? undefined : prev);
          if (opts.guard) opts.guard();
          await self.putJSON(row(k), next);
          return structuredClone(next);
        };
        return globalThis.navigator?.locks ? navigator.locks.request('rsq-row:' + k, run) : run();
      },
      async keys(prefix) { return (await self.names('row:' + prefix)).map((n) => n.slice(4)); }
    });
  }
}

export const BACKUP_SCHEMA = 'rsq-rasp-field-backup-enc/1';
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const headerAad = (h) => enc.encode(JSON.stringify([h.schema, h.kdf.name, h.kdf.hash, h.kdf.iterations, h.kdf.salt, h.cipher.name, h.cipher.iv]));
export async function encryptBackup(pass, value) {
  if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new VaultError('PASSPHRASE_TOO_SHORT');
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { schema: BACKUP_SCHEMA, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv) } };
  const key = await derive(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerAad(header) }, key, enc.encode(JSON.stringify(value)));
  return JSON.stringify({ ...header, ct: b64(new Uint8Array(ct)) });
}
export async function decryptBackup(pass, text) {
  let f; try { f = JSON.parse(text); } catch { throw new VaultError('BACKUP_FORMAT_UNSUPPORTED'); }
  const ok = f && f.schema === BACKUP_SCHEMA && f.kdf?.name === 'PBKDF2' && f.kdf.hash === 'SHA-256' && f.kdf.iterations === ITERATIONS
    && f.cipher?.name === 'AES-GCM' && typeof f.kdf.salt === 'string' && typeof f.cipher.iv === 'string' && typeof f.ct === 'string';
  if (!ok) throw new VaultError('BACKUP_FORMAT_UNSUPPORTED');
  let salt, iv, ct;
  try { salt = unb64(f.kdf.salt); iv = unb64(f.cipher.iv); ct = unb64(f.ct); } catch { throw new VaultError('BACKUP_FORMAT_UNSUPPORTED'); }
  if (salt.length !== 32 || iv.length !== 12) throw new VaultError('BACKUP_FORMAT_UNSUPPORTED');
  const key = await derive(String(pass ?? ''), salt);
  let out;
  try { out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: headerAad(f) }, key, ct); }
  catch { throw new VaultError('BACKUP_PASSPHRASE_WRONG'); }
  return JSON.parse(dec.decode(out));
}

export function createAutoLock({ lock, isUnlocked, onLock = () => {}, capAt = null, doc = globalThis.document, win = globalThis.window, hiddenMs = AUTO_LOCK_HIDDEN_MS, idleMs = AUTO_LOCK_IDLE_MS, now = () => Date.now(), mono = perfNow, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) }) {
  const mark = () => ({ wall: now(), mono: mono() });
  const since = (m) => { const w = now() - m.wall; return w < -CLOCK_BACK_MS ? Infinity : Math.max(w, mono() - m.mono); };
  let armed = false, lastInput = mark(), hiddenAt = null, idleT = null, hiddenT = null, capT = null;
  const clearAll = () => { clearTimer(idleT); clearTimer(hiddenT); clearTimer(capT); idleT = hiddenT = capT = null; };
  const fire = (reason) => {
    clearAll();
    if (!armed) return;
    armed = false;
    lock(); onLock(reason);
  };
  const capPassed = () => typeof capAt === 'function' && Number.isFinite(capAt()) && now() >= capAt();
  const check = () => {
    if (!armed) return false;
    if (!isUnlocked() || capPassed()) { fire('cap'); return true; }
    if (hiddenAt !== null && since(hiddenAt) >= hiddenMs) { fire(since(hiddenAt) === Infinity ? 'clock' : 'hidden'); return true; }
    if (since(lastInput) >= idleMs) { fire(since(lastInput) === Infinity ? 'clock' : 'idle'); return true; }
    return false;
  };
  const armIdle = () => {
    clearTimer(idleT); idleT = null;
    if (!armed || hiddenAt !== null || check()) return;
    idleT = setTimer(() => { idleT = null; armIdle(); }, Math.max(1, idleMs - since(lastInput)));
  };
  const armCap = () => {
    clearTimer(capT); capT = null;
    if (!armed || typeof capAt !== 'function' || !Number.isFinite(capAt())) return;
    capT = setTimer(() => { capT = null; if (!check()) armCap(); }, Math.max(1, capAt() - now()));
  };
  const onVisibility = () => {
    if (!armed) return;
    if (doc.visibilityState === 'hidden') {
      if (hiddenAt === null) hiddenAt = mark();
      clearTimer(idleT); idleT = null; clearTimer(hiddenT);
      hiddenT = setTimer(() => { hiddenT = null; check(); }, Math.max(1, hiddenMs - since(hiddenAt)));
    } else {
      clearTimer(hiddenT); hiddenT = null;
      if (check()) return;
      hiddenAt = null;
      armIdle();
    }
  };
  const onActivity = () => {
    if (!armed || hiddenAt !== null) return;
    if (check()) return;
    lastInput = mark();
    if (idleT === null) armIdle();
  };
  const ACTIVITY = ['pointerdown', 'keydown', 'input', 'touchstart', 'wheel'];
  doc?.addEventListener?.('visibilitychange', onVisibility);
  win?.addEventListener?.('pageshow', () => check());
  win?.addEventListener?.('focus', () => check());
  for (const t of ACTIVITY) win?.addEventListener?.(t, onActivity, { capture: true, passive: true });
  return Object.freeze({
    started() { clearAll(); armed = true; lastInput = mark(); hiddenAt = doc?.visibilityState === 'hidden' ? mark() : null; armIdle(); armCap(); if (hiddenAt !== null) onVisibility(); },
    stop() { clearAll(); armed = false; },
    armed: () => armed,
    activity: onActivity, visibility: onVisibility, check,
  });
}

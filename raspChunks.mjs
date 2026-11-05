// rasp-chunks/1 (2026-11-04, photo-pwa-r1 + release-r1 chunks patch): ONE request that is too large for one transport call
// is sent as parts of a staged upload, verified, then forwarded as ONE ordinary request to the unchanged photos-r2 core.
//   Why: Wix HTTP functions accept a request body of at most 512 KB
//   (https://dev.wix.com/docs/velo/api-reference/wix-http-functions/wix-http-function-request/wix-http-function-request-body/introduction);
//   webMethod requests have no documented limit but fail around 1 MB in practice
//   (https://forum.wixstudio.com/t/sending-a-4mb-file-to-backend-via-webmethod/60119). A photo or a TSS export may be 5 MiB.
// Targets (the requests that may be staged): originals.put (photo / document / TSS export, <= 5 MiB, the core's own cap)
// and records.write (one TSS save, <= 256 KiB = the core's own records.write cap, jsonBody 262144).
// The core still decides everything (session, CSRF, scope, IR2611 allowlist, size, sha, MIME, Drive write).
//
// Same bytes everywhere, no imports, WebCrypto + btoa/atob + TextDecoder only (Wix backend, browsers, node):
//   backend/raspChunks.js (Wix backend: webMethod path + device route raspPhoto), the TSS bundle public/tss/ui/raspChunks.mjs,
//   the field app raspChunks.mjs.
// Wire format = ordinary bridge requests {op, method, path, headers, body}, so both transports carry them unchanged:
//   uploads.begin   POST /api/beta/uploads                          utf8 JSON {op, target, size, sha256, mimeType}
//   uploads.put     PUT  /api/beta/uploads/{uploadId}/parts/{index}  base64url part bytes, x-content-sha256 = part sha
//   uploads.commit  POST /api/beta/uploads/{uploadId}/commit         utf8 JSON {op, path, headers} = the target request
//                                                                    without its body (the server rebuilds the body)
// Server: createChunkStore (rows) + handleUploadRequest (the three operations, replies like the core: {status, body}).
//   Every call is bound to an OWNER the caller authenticated ('device:<token hash>' / 'member:<Wix member id>'); another
//   owner's upload looks exactly like an unknown one. Staging needs authorizeStage() (APPROVED member + active grant).
// Client: chunkingFetcher(fetcher) wraps a bridge fetcher (path, init) -> {ok, status, json()}: large originals.put /
//   records.write calls go through begin / put x N / commit; everything else passes through untouched.
// Store: two Admin-only collections (suppressAuth). A part row holds <= 256 KiB as base64url (< 512 KB Wix Data item).
// Rows are removed after a successful commit and, when abandoned, after the TTL (on every begin + scheduled job).

export const CHUNK_PROTOCOL = 'rasp-chunks/1';
export const DEVICE_CHUNK_BYTES = 256 * 1024;   // device route raspPhoto: request cap 480 KiB (< 512 KB HTTP function body)
export const WEB_CHUNK_BYTES = 160 * 1024;      // webMethod path: one put request stays < 256 KiB serialized
export const CHUNK_SIZES = Object.freeze([WEB_CHUNK_BYTES, DEVICE_CHUNK_BYTES]);
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const UPLOAD_TTL_MS = 2 * 3600e3;          // an abandoned upload is purged 2 h after begin
export const MAX_OPEN_UPLOADS = 6;                // per owner, unexpired and not finished
export const PURGE_BATCH = 25;                    // uploads per purge pass (bounded work per request)
export const CHUNK_TABLES = Object.freeze({ uploads: 'RaspChunkUploads', parts: 'RaspChunkParts' });
const ID = '([A-Za-z0-9_-]{1,80})';
// The requests that may be staged. maxBytes = the core's own cap for that request (nothing larger is ever staged).
export const TARGETS = Object.freeze({
  'originals.put': Object.freeze({ method: 'PUT', path: new RegExp('^/api/beta/originals/' + ID + '$'), encoding: 'base64url', shaHeader: true, maxBytes: MAX_UPLOAD_BYTES,
    mime: Object.freeze(['image/jpeg', 'image/png', 'application/pdf', 'audio/mpeg', 'video/mp4', 'application/octet-stream', 'text/html']) }),
  'records.write': Object.freeze({ method: 'POST', path: new RegExp('^/api/beta/records/' + ID + '$'), encoding: 'utf8', shaHeader: false, maxBytes: 262144,
    mime: Object.freeze(['application/json']) }),
});
export const UPLOAD_OPERATIONS = Object.freeze([
  ['uploads.begin', 'POST', /^\/api\/beta\/uploads$/],
  ['uploads.put', 'PUT', /^\/api\/beta\/uploads\/([A-Za-z0-9_-]{22})\/parts\/([0-9]{1,2})$/],
  ['uploads.commit', 'POST', /^\/api\/beta\/uploads\/([A-Za-z0-9_-]{22})\/commit$/],
].map(([op, method, path]) => Object.freeze({ op, method, path })));

const READ = { suppressAuth: true, consistentRead: true };
const WRITE = { suppressAuth: true };
const HEX64 = /^[0-9a-f]{64}$/, UPLOAD_ID = /^[A-Za-z0-9_-]{22}$/, B64U = /^[A-Za-z0-9_-]*$/, OWNER = /^[A-Za-z0-9:_-]{8,120}$/, TARGET_ID = /^[A-Za-z0-9_-]{1,80}$/;
const HEADER_NAMES = ['content-type', 'x-rasp-csrf', 'x-rasp-actor', 'x-rasp-project', 'x-rasp-site', 'x-rasp-context', 'x-content-sha256'];

export class ChunkError extends Error {
  constructor(status, code, extra = {}) { super(code); this.status = status; this.code = code; Object.assign(this, extra); }
}
const need = (cond, status, code, extra) => { if (!cond) throw new ChunkError(status, code, extra); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

export function toB64u(bytes) {
  let s = '';
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function fromB64u(s) {
  need(typeof s === 'string' && B64U.test(s) && s.length % 4 !== 1, 400, 'CHUNK_ENCODING');
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let h = ''; for (const b of d) h += b.toString(16).padStart(2, '0');
  return h;
}
export const partsFor = (size, chunk) => Math.ceil(size / chunk);
export const partLength = (size, chunk, index) => (index < partsFor(size, chunk) - 1 ? chunk : size - chunk * (partsFor(size, chunk) - 1));
const headerValues = (headers, name) => (Array.isArray(headers) ? headers.filter((h) => Array.isArray(h) && h[0] === name).map((h) => h[1]) : []);
export function uploadOperationOf(path, method) {
  if (typeof path !== 'string' || /[?#%\\]/.test(path)) return null;
  return UPLOAD_OPERATIONS.find((o) => o.method === String(method ?? 'GET').toUpperCase() && o.path.test(path))?.op ?? null;
}
export const isUploadRequest = (request) => !!request && typeof request === 'object' && typeof request.op === 'string' && request.op.startsWith('uploads.');

// ---------------------------------------------------------------------------------------------------- server: store
export function createChunkStore({ wixData, now = () => Date.now(), random = (n) => crypto.getRandomValues(new Uint8Array(n)), chunkBytes = DEVICE_CHUNK_BYTES, tables = CHUNK_TABLES }) {
  need(typeof wixData?.query === 'function' && typeof wixData?.insert === 'function' && typeof wixData?.remove === 'function', 503, 'CHUNK_BINDINGS_REQUIRED');
  need(CHUNK_SIZES.includes(chunkBytes), 503, 'CHUNK_SIZE_INVALID');
  const partId = (uploadId, index) => uploadId + '.' + index;
  async function get(table, id) {
    const r = await wixData.query(table).eq('_id', id).limit(1).find(READ);
    need(Array.isArray(r?.items) && r.items.length <= 1 && (!r.items[0] || r.items[0]._id === id), 502, 'CHUNK_STORE_INVALID');
    return r.items[0] ?? null;
  }
  const quietRemove = (table, id) => Promise.resolve().then(() => wixData.remove(table, id, WRITE)).then(() => true, () => false);
  async function owned(owner, uploadId) {
    need(typeof uploadId === 'string' && UPLOAD_ID.test(uploadId), 400, 'UPLOAD_ID_INVALID');
    const row = await get(tables.uploads, uploadId);
    need(row && row.owner === owner && row.protocol === CHUNK_PROTOCOL, 404, 'UPLOAD_UNKNOWN');
    need(row.expiresAt > now(), 410, 'UPLOAD_EXPIRED');
    return row;
  }
  // begin: {op, target, size, sha256, mimeType} -> {protocol, uploadId, chunkBytes, parts, expiresAt}
  async function begin(owner, input) {
    need(typeof owner === 'string' && OWNER.test(owner), 401, 'UPLOAD_OWNER_REQUIRED');
    need(exact(input, ['op', 'target', 'size', 'sha256', 'mimeType']), 400, 'BEGIN_INVALID');
    const t = Object.hasOwn(TARGETS, input.op) ? TARGETS[input.op] : null;
    need(t, 400, 'UPLOAD_TARGET_DENIED');
    need(typeof input.target === 'string' && TARGET_ID.test(input.target), 400, 'TARGET_ID_INVALID');
    need(Number.isSafeInteger(input.size) && input.size > 0, 400, 'SIZE_INVALID');
    need(input.size <= t.maxBytes, 413, 'UPLOAD_TOO_LARGE');
    need(typeof input.sha256 === 'string' && HEX64.test(input.sha256), 400, 'SHA256_INVALID');
    need(t.mime.includes(input.mimeType), 415, 'MIME_DENIED');
    await purgeExpired().catch(() => null);   // opportunistic, bounded; never blocks a begin
    const at = now();
    const open = await wixData.query(tables.uploads).eq('owner', owner).gt('expiresAt', at).limit(MAX_OPEN_UPLOADS + 1).find(READ);
    need(Array.isArray(open?.items), 502, 'CHUNK_STORE_INVALID');
    need(open.items.filter((r) => r.owner === owner).length < MAX_OPEN_UPLOADS, 429, 'TOO_MANY_OPEN_UPLOADS');
    const uploadId = toB64u(random(16));
    need(UPLOAD_ID.test(uploadId), 503, 'RANDOM_UNAVAILABLE');
    const row = { _id: uploadId, protocol: CHUNK_PROTOCOL, owner, op: input.op, target: input.target, size: input.size, sha256: input.sha256, mimeType: input.mimeType, chunkBytes, parts: partsFor(input.size, chunkBytes), createdAt: at, expiresAt: at + UPLOAD_TTL_MS };
    await wixData.insert(tables.uploads, row, WRITE);
    return { protocol: CHUNK_PROTOCOL, uploadId, chunkBytes, parts: row.parts, expiresAt: row.expiresAt };
  }
  // put: {uploadId, index, sha256, data}. The same part again is accepted; a different part under the same index: 409.
  async function put(owner, input) {
    need(exact(input, ['uploadId', 'index', 'sha256', 'data']), 400, 'PART_INVALID');
    const up = await owned(owner, input.uploadId);
    need(Number.isSafeInteger(input.index) && input.index >= 0 && input.index < up.parts, 400, 'PART_INDEX_INVALID');
    need(typeof input.sha256 === 'string' && HEX64.test(input.sha256), 400, 'SHA256_INVALID');
    need(typeof input.data === 'string' && input.data.length <= Math.ceil((up.chunkBytes * 4) / 3), 413, 'PART_TOO_LARGE');
    const bytes = fromB64u(input.data);
    need(bytes.length === partLength(up.size, up.chunkBytes, input.index), 400, 'PART_LENGTH_INVALID');
    need((await sha256Hex(bytes)) === input.sha256, 422, 'PART_SHA_MISMATCH');
    const row = { _id: partId(up._id, input.index), uploadId: up._id, owner, index: input.index, sha256: input.sha256, data: toB64u(bytes), expiresAt: up.expiresAt };
    try { await wixData.insert(tables.parts, row, WRITE); }
    catch {
      const prev = await get(tables.parts, row._id);
      need(prev && prev.owner === owner && prev.uploadId === up._id && prev.index === input.index, 503, 'PART_WRITE_FAILED');
      need(prev.sha256 === input.sha256, 409, 'PART_CONFLICT');
    }
    return { uploadId: up._id, index: input.index };
  }
  // assemble: every part present and intact, total length = size, total sha256 = the sha256 declared at begin.
  async function assemble(owner, uploadId) {
    const up = await owned(owner, uploadId);
    const rows = await Promise.all(Array.from({ length: up.parts }, (_, i) => get(tables.parts, partId(up._id, i))));
    const missing = rows.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
    need(!missing.length, 409, 'UPLOAD_INCOMPLETE', { missing });
    const out = new Uint8Array(up.size);
    let at = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      need(r.owner === owner && r.uploadId === up._id && r.index === i, 502, 'CHUNK_STORE_INVALID');
      const b = fromB64u(r.data);
      need(b.length === partLength(up.size, up.chunkBytes, i) && (await sha256Hex(b)) === r.sha256, 502, 'PART_CORRUPT');
      out.set(b, at); at += b.length;
    }
    need(at === up.size, 422, 'UPLOAD_SIZE_MISMATCH');
    need((await sha256Hex(out)) === up.sha256, 422, 'UPLOAD_SHA_MISMATCH');
    return { bytes: out, upload: { uploadId: up._id, op: up.op, target: up.target, size: up.size, sha256: up.sha256, mimeType: up.mimeType } };
  }
  // finish: drop the staged copy (after the core accepted). Best effort: what is left expires and is purged.
  async function finish(owner, uploadId) {
    let up = null;
    try { up = await get(tables.uploads, uploadId); } catch { return { removed: 0 }; }
    if (!up || up.owner !== owner) return { removed: 0 };
    let removed = 0;
    for (let i = 0; i < up.parts; i++) if (await quietRemove(tables.parts, partId(up._id, i))) removed++;
    if (await quietRemove(tables.uploads, up._id)) removed++;
    return { removed };
  }
  // purgeExpired: up to PURGE_BATCH expired uploads with their parts, then up to PURGE_BATCH expired orphan parts.
  async function purgeExpired({ limit = PURGE_BATCH } = {}) {
    const at = now();
    let uploads = 0, parts = 0;
    const ups = await wixData.query(tables.uploads).lt('expiresAt', at).limit(limit).find(READ);
    for (const up of Array.isArray(ups?.items) ? ups.items : []) {
      if (!(up.expiresAt < at) || typeof up._id !== 'string') continue;
      const n = Number.isSafeInteger(up.parts) && up.parts <= partsFor(MAX_UPLOAD_BYTES, WEB_CHUNK_BYTES) ? up.parts : partsFor(MAX_UPLOAD_BYTES, WEB_CHUNK_BYTES);
      for (let i = 0; i < n; i++) if (await quietRemove(tables.parts, partId(up._id, i))) parts++;
      if (await quietRemove(tables.uploads, up._id)) uploads++;
    }
    const orphans = await wixData.query(tables.parts).lt('expiresAt', at).limit(limit).find(READ);
    for (const p of Array.isArray(orphans?.items) ? orphans.items : []) if (p.expiresAt < at && typeof p._id === 'string' && (await quietRemove(tables.parts, p._id))) parts++;
    return { uploads, parts };
  }
  return Object.freeze({ begin, put, assemble, finish, purgeExpired, chunkBytes });
}

// ---------------------------------------------------------------------------------------------------- server: operations
// One uploads.* bridge request -> {reply: {status, body}, appReference}. Never throws for a refusal (the reply carries it,
// like the core's own replies). The caller supplies:
//   resolveOwner()  -> the authenticated owner string (throws ChunkError 401/403 to refuse); called for every operation
//   authorizeStage() -> resolves when the caller may STAGE (begin / put): APPROVED member + active grant
//   forward(request) -> {reply, appReference} from the unchanged core (commit only)
export async function handleUploadRequest({ store, request, appReference = null, resolveOwner, authorizeStage, forward }) {
  const out = (status, body) => ({ reply: { status, body }, appReference });
  try {
    need(exact(request, ['op', 'method', 'path', 'headers', 'body']) && isUploadRequest(request), 400, 'UPLOAD_REQUEST_INVALID');
    const op = uploadOperationOf(request.path, request.method);
    need(op && op === request.op, 403, 'UPLOAD_OPERATION_DENIED');
    need(Array.isArray(request.headers) && request.headers.every((h) => Array.isArray(h) && h.length === 2 && HEADER_NAMES.includes(h[0]) && typeof h[1] === 'string'), 400, 'UPLOAD_HEADERS_INVALID');
    need(exact(request.body, ['encoding', 'data']) && typeof request.body.data === 'string', 400, 'UPLOAD_BODY_INVALID');
    const owner = await resolveOwner();
    need(typeof owner === 'string' && OWNER.test(owner), 401, 'UPLOAD_OWNER_REQUIRED');
    const m = UPLOAD_OPERATIONS.find((o) => o.op === op).path.exec(request.path);
    const json = () => { need(request.body.encoding === 'utf8', 400, 'UPLOAD_BODY_INVALID'); try { return JSON.parse(request.body.data); } catch { throw new ChunkError(400, 'UPLOAD_BODY_INVALID'); } };
    if (op === 'uploads.begin') {
      await authorizeStage();
      return out(200, { version: 1, ...(await store.begin(owner, json())) });
    }
    if (op === 'uploads.put') {
      await authorizeStage();
      need(request.body.encoding === 'base64url', 400, 'UPLOAD_BODY_INVALID');
      const sha = headerValues(request.headers, 'x-content-sha256');
      need(sha.length === 1, 400, 'SHA256_INVALID');
      return out(200, { version: 1, ...(await store.put(owner, { uploadId: m[1], index: Number(m[2]), sha256: sha[0], data: request.body.data })) });
    }
    // uploads.commit: the target request (no body) must describe exactly the verified bytes; then ONE forward.
    const c = json();
    need(exact(c, ['op', 'path', 'headers']), 400, 'COMMIT_REQUEST_INVALID');
    const t = Object.hasOwn(TARGETS, c.op) ? TARGETS[c.op] : null;
    need(t && typeof c.path === 'string' && Array.isArray(c.headers) && c.headers.every((h) => Array.isArray(h) && h.length === 2 && HEADER_NAMES.includes(h[0]) && typeof h[1] === 'string' && !/[\r\n]/.test(h[1]))
      && new Set(c.headers.map((h) => h[0])).size === c.headers.length, 400, 'COMMIT_REQUEST_INVALID');
    const staged = await store.assemble(owner, m[1]);
    const u = staged.upload, id = t.path.exec(c.path)?.[1];
    const type = headerValues(c.headers, 'content-type'), sha = headerValues(c.headers, 'x-content-sha256');
    need(c.op === u.op && id === u.target && type.length === 1 && type[0] === u.mimeType && (t.shaHeader ? sha.length === 1 && sha[0] === u.sha256 : sha.length === 0 || (sha.length === 1 && sha[0] === u.sha256)), 400, 'COMMIT_MISMATCH');
    let data;
    if (t.encoding === 'utf8') { try { data = new TextDecoder('utf-8', { fatal: true }).decode(staged.bytes); } catch { throw new ChunkError(400, 'UPLOAD_ENCODING_INVALID'); } }
    else data = toB64u(staged.bytes);
    const res = await forward({ op: c.op, method: t.method, path: c.path, headers: c.headers, body: { encoding: t.encoding, data } });
    need(res && res.reply && Number.isInteger(res.reply.status), 502, 'FORWARD_REPLY_INVALID');
    if (res.reply.status >= 200 && res.reply.status < 300) await store.finish(owner, m[1]).catch(() => null);
    return { reply: res.reply, appReference: res.appReference === undefined ? appReference : res.appReference };
  } catch (e) {
    if (e instanceof ChunkError || (Number.isInteger(e?.status) && typeof e?.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(e.code))) return out(e.status, { error: e.code, ...(Array.isArray(e.missing) ? { missing: e.missing } : {}) });
    return out(503, { error: 'UPLOAD_UNAVAILABLE' });
  }
}

// Webmethod wiring (backend/raspMain.web.js): the existing `request` web method, with uploads.* answered here and every
// other request dispatched to the core exactly as before. Owner = 'member:' + the current Wix member id; staging needs the
// member APPROVED and an active RaspAccessGrants row (the same rule as the device gateway).
export function createWebRequest({ wixData, dispatch, readCurrentMember, now, random, chunkBytes = WEB_CHUNK_BYTES }) {
  const store = createChunkStore({ wixData, now, random, chunkBytes });
  return async function request(input) {
    if (!isUploadRequest(input?.request)) return dispatch(input);
    let member = null;
    const resolveOwner = async () => {
      try { member = await readCurrentMember(); } catch { member = null; }
      need(member && typeof member.id === 'string' && member.id && member.approved === true, 401, 'WIX_MEMBER_REQUIRED');
      return 'member:' + member.id;
    };
    const authorizeStage = async () => {
      const g = await wixData.query('RaspAccessGrants').eq('memberId', member.id).eq('active', true).limit(1).find(READ);
      need(Array.isArray(g?.items) && g.items.some((r) => r.memberId === member.id && r.active === true), 403, 'MEMBER_DENIED');
    };
    return handleUploadRequest({ store, request: input.request, appReference: input.appReference ?? null, resolveOwner, authorizeStage, forward: (rq) => dispatch({ request: rq, appReference: input.appReference ?? null }) });
  };
}

// ---------------------------------------------------------------------------------------------------- client
// chunkingFetcher(fetcher, {directBytes}) -> fetcher(path, init). originals.put / records.write whose body costs more than
// directBytes[op] ON THE WIRE (bridge request: a utf8 body as its JSON string, escapes included; binary as base64url) go
// through uploads.begin / put / commit on the SAME fetcher; the commit reply is the core's reply for
// the target request (drop-in: same {ok, status, json()}). A records.write over the core's 256 KiB cap is answered here
// with 413 RECORD_TOO_LARGE (nothing sent; the caller keeps it on the device, as for any refused save).
export const DIRECT_BYTES = Object.freeze({ 'originals.put': 160 * 1024, 'records.write': 200 * 1024 });   // wire bytes; one request stays < 256 KiB
export const wireBytes = (body) => (typeof body === 'string' ? new TextEncoder().encode(JSON.stringify(body)).length : Math.ceil(((body instanceof Blob ? body.size : body.byteLength) * 4) / 3));
const local = (status, body) => Object.freeze({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });
function targetOf(path, method) {
  for (const [op, t] of Object.entries(TARGETS)) if (t.method === String(method ?? 'GET').toUpperCase() && typeof path === 'string' && t.path.test(path)) return op;
  return null;
}
async function bodyBytes(body) {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  return null;
}
const plainHeaders = (h) => (h == null ? {} : h instanceof Headers ? Object.fromEntries(h.entries()) : Array.isArray(h) ? Object.fromEntries(h) : { ...h });
// commitFetcher: the fetcher for the commit call (default: fetcher), e.g. one with the longer upload deadline, since the
// commit carries the whole target request server-side (the core's Drive write of up to 5 MiB).
export function chunkingFetcher(fetcher, { directBytes = DIRECT_BYTES, onPart = null, commitFetcher = fetcher } = {}) {
  if (typeof fetcher !== 'function' || typeof commitFetcher !== 'function') throw new TypeError('FETCHER_REQUIRED');
  const chunked = function chunked(path, init = {}) {
    const op = targetOf(path, init.method);
    if (!op || init.body == null) return fetcher(path, init);
    if (!(wireBytes(init.body) > (directBytes[op] ?? Infinity))) return fetcher(path, init);
    return uploadChunked(fetcher, path, init, { op, onPart, commitFetcher });
  };
  if (fetcher.memberId !== undefined) chunked.memberId = fetcher.memberId;
  return chunked;
}
// The staged equivalent of fetcher(path, init) for one target request. Throws only what the fetcher throws (network);
// a refusal on the way comes back as that reply (e.g. 413 UPLOAD_TOO_LARGE, 409 UPLOAD_INCOMPLETE).
export async function uploadChunked(fetcher, path, init = {}, { op = targetOf(path, init.method), onPart = null, commitFetcher = fetcher } = {}) {
  const t = op && TARGETS[op];
  if (!t) return local(400, { error: 'UPLOAD_TARGET_DENIED' });
  const bytes = await bodyBytes(init.body);
  if (!bytes || !bytes.length) return local(400, { error: 'UPLOAD_BODY_INVALID' });
  if (bytes.length > t.maxBytes) return local(413, { error: op === 'records.write' ? 'RECORD_TOO_LARGE' : 'UPLOAD_TOO_LARGE' });
  const headers = plainHeaders(init.headers), lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const mimeType = (lower['content-type'] ?? '').split(';')[0].trim() || (init.body instanceof Blob ? init.body.type : '');
  const sha256 = lower['x-content-sha256'] ?? (await sha256Hex(bytes));
  const session = Object.fromEntries(Object.entries(lower).filter(([k]) => k.startsWith('x-rasp-')));
  const json = () => ({ ...session, 'content-type': 'application/json' });
  const read = async (r) => { let body = null; try { body = await r.json(); } catch { body = null; } return { r, body }; };
  const { r: b, body: bb } = await read(await fetcher('/api/beta/uploads', { method: 'POST', headers: json(), body: JSON.stringify({ op, target: t.path.exec(path)[1], size: bytes.length, sha256, mimeType }) }));
  if (!b.ok) return local(b.status, bb ?? { error: 'UPLOAD_BEGIN_FAILED' });
  if (!(bb && bb.protocol === CHUNK_PROTOCOL && UPLOAD_ID.test(bb.uploadId ?? '') && CHUNK_SIZES.includes(bb.chunkBytes) && bb.parts === partsFor(bytes.length, bb.chunkBytes))) return local(502, { error: 'BEGIN_REPLY_INVALID' });
  for (let i = 0; i < bb.parts; i++) {
    const part = bytes.subarray(i * bb.chunkBytes, i * bb.chunkBytes + partLength(bytes.length, bb.chunkBytes, i));
    const { r: p, body: pb } = await read(await fetcher(`/api/beta/uploads/${bb.uploadId}/parts/${i}`, { method: 'PUT', headers: { ...session, 'content-type': 'application/octet-stream', 'x-content-sha256': await sha256Hex(part) }, body: part }));
    if (!p.ok) return local(p.status, pb ?? { error: 'UPLOAD_PART_FAILED' });
    if (!(pb && pb.uploadId === bb.uploadId && pb.index === i)) return local(502, { error: 'PUT_REPLY_INVALID' });
    onPart?.({ index: i, parts: bb.parts });
  }
  const target = Object.entries({ ...lower, 'content-type': mimeType, ...(t.shaHeader || lower['x-content-sha256'] ? { 'x-content-sha256': sha256 } : {}) }).filter(([k]) => HEADER_NAMES.includes(k));
  return commitFetcher(`/api/beta/uploads/${bb.uploadId}/commit`, { method: 'POST', headers: json(), body: JSON.stringify({ op, path, headers: target }) });
}

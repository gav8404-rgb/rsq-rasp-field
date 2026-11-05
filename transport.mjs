import { encodeRequest, decodeResponse } from './codec.mjs';

const enc = new TextEncoder();
const b64u = (bytes) => { let s = ''; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); };
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
async function sha(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join(''); }

export class GatewayError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status; } }
export const REPAIR_CODES = new Set(['DEVICE_TOKEN_REQUIRED', 'DEVICE_UNKNOWN', 'DEVICE_EXPIRED', 'DEVICE_REVOKED', 'SIGNATURE_INVALID']);

export function createTransport({ apiBase, appOrigin = globalThis.location?.origin, device, appRef, fetchImpl = (...a) => fetch(...a) }) {
  async function post(fn, bodyObj, signed) {
    const body = JSON.stringify(bodyObj), headers = { 'content-type': 'application/json' };
    if (signed) {
      const { token, privateKey } = await device();
      if (!token || !privateKey) throw new GatewayError('DEVICE_TOKEN_REQUIRED', 401);
      const ts = Date.now();
      const input = canonical(['rsq-device-req/1', appOrigin, fn, ts, await sha(body)]);
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(input));
      Object.assign(headers, { authorization: 'RSQDevice ' + token, 'x-rsq-ts': String(ts), 'x-rsq-sig': b64u(sig) });
    }
    let res;
    try {
      res = await fetchImpl(apiBase + '/' + fn, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers, body });
    } catch { throw new GatewayError('NETWORK_UNAVAILABLE', 0); }
    let json;
    try { json = await res.json(); } catch { throw new GatewayError('GATEWAY_REPLY_INVALID', res.status); }
    if (!res.ok) throw new GatewayError(json?.error ?? 'GATEWAY_FAILED', res.status);
    return json;
  }
  async function pair({ code, publicKey, label }) {
    const out = await post('raspPair', { code, publicKey, label }, false);
    if (!out || typeof out.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(out.token)) throw new GatewayError('GATEWAY_REPLY_INVALID', 200);
    return out;
  }
  async function fetcher(url, init = {}) {
    const request = await encodeRequest(url, init);
    let ref = await appRef.get();
    let out = await post('raspApp', { request, appReference: ref }, true);
    if (request.op === 'session.get' && ref && out.reply?.status === 401) {
      await appRef.set(null);
      out = await post('raspApp', { request, appReference: null }, true);
    }
    await appRef.set(out.appReference ?? null);
    return decodeResponse(out.reply);
  }
  async function ops(op) {
    const out = await post('raspOps', { op }, true);
    if (!out || out.version !== 1 || out.op !== op || !out.payload || typeof out.payload !== 'object' || Array.isArray(out.payload)) throw new GatewayError('GATEWAY_REPLY_INVALID', 200);
    return out.payload;
  }
  async function photo(bodyObj) { return post('raspPhoto', bodyObj, true); }
  return Object.freeze({ pair, fetcher, ops, photo });
}

// photo-pwa-r1: the photo queue's fetcher for the field app. Same contract as the Wix bridge fetcher that raspPhotos.mjs
// PhotoQueue uses ((path, init) -> {ok, status, json()}); every call is a bridge request {op, method, path, headers, body}
// sent with the session reference to the device route raspPhoto (transport.photo = signed POST, device token + ECDSA):
//   PUT  /api/beta/originals/:id         -> always staged (raspChunks.mjs rasp-chunks/1, the module the Wix webMethod
//                                           path uses): uploads.begin, uploads.put x N, uploads.commit
//   POST /api/beta/records/:rid/photos   -> photos.link, forwarded unchanged
//   GET  /api/beta/records/:rid/photos   -> photos.list, forwarded unchanged
// Anything else is refused here (and by the gateway). The session reference (appReference) is the app's own.
import { encodeRequest, decodeResponse } from './codec-photos.mjs';
import { chunkingFetcher, uploadOperationOf, toB64u } from './raspChunks.mjs';

const denied = () => Object.assign(Error('PHOTO_OP_DENIED'), { code: 'PHOTO_OP_DENIED' });
function encodeUpload(op, path, init) {
  const headers = [...new Headers(init.headers ?? {}).entries()];
  const b = init.body;
  const body = b == null ? { encoding: 'empty', data: '' } : typeof b === 'string' ? { encoding: 'utf8', data: b }
    : ArrayBuffer.isView(b) ? { encoding: 'base64url', data: toB64u(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)) } : null;
  if (!body) throw denied();
  return { op, method: String(init.method ?? 'GET').toUpperCase(), path, headers, body };
}
export function createPhotoFetcher({ photo, appRef }) {
  if (typeof photo !== 'function' || typeof appRef?.get !== 'function' || typeof appRef?.set !== 'function') throw Error('PHOTO_TRANSPORT_REQUIRED');
  async function raw(path, init = {}) {
    const up = uploadOperationOf(path, init.method);
    let request;
    if (up) request = encodeUpload(up, path, init);
    else {
      const { credentials, cache, ...rest } = init;
      void credentials; void cache;
      request = await encodeRequest(path, rest);
      if (request.op !== 'photos.link' && request.op !== 'photos.list') throw denied();
    }
    const out = await photo({ request, appReference: await appRef.get() });
    if (!out || out.version !== 1 || !out.reply) throw Object.assign(Error('GATEWAY_REPLY_INVALID'), { code: 'GATEWAY_REPLY_INVALID', status: 502 });
    await appRef.set(out.appReference ?? null);
    return decodeResponse(out.reply);
  }
  // every originals.put is staged (the device route never takes a photo in one request)
  return chunkingFetcher(raw, { directBytes: { 'originals.put': 0 } });
}

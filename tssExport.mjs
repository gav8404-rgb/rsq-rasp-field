// photos-r2 E (operator 2026-11-03): "Save TSS to a folder" / "Share TSS file" / "Restore from file".
// The ENTIRE TSS of the selected site as ONE self-contained HTML file, built in the page from this device's data only
// (encrypted vault: saved surveys, unsent saves, unsaved drafts, layout, photo list). Building it never awaits the network.
// The file carries a CONFIDENTIAL / PII banner and title, readable sections (status, by location, by form, photos) and the
// same data as a JSON block (schema rasp-tss-export/1) that "Restore from file" reads back into UNSAVED drafts (the normal
// review -> local-first save path). The file runs no script; it opens offline in any browser.
export const EXPORT_SCHEMA = 'rasp-tss-export/1';
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_EXPORT = 5 * 1024 * 1024;
// "<" built at run time: this module is bundled into a page script, which must not contain a literal script tag.
const LT = String.fromCharCode(60);   // the Drive copy goes through the originals route (5 MB)

const pad = (n) => String(n).padStart(2, '0');
const clean = (s, max) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, max);
// File stem: CONFIDENTIAL_<PROJECT>_<SITE>_TSS_<YYMMDD-HHMMZ> (SITE = the site id without the "<PROJECT>-" prefix).
export function exportName(projectId, siteId, at) {
  const d = new Date(at), p = clean(projectId, 16) || 'PROJECT';
  let s = String(siteId ?? '');
  if (s.toUpperCase().startsWith(String(projectId).toUpperCase() + '-')) s = s.slice(String(projectId).length + 1);
  s = clean(s, 40) || 'SITE';
  return `CONFIDENTIAL_${p}_${s}_TSS_${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const jsonBlock = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const hhmm = (at) => { const d = new Date(at ?? NaN); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(11, 16) + 'Z'; };
export function statusText(st) {
  if (!st) return 'On this device';
  if (st.state === 'sent') return 'Sent to server ' + hhmm(st.at);
  if (st.state === 'draft') return 'Unsaved draft on this device';
  if (st.state === 'refused') return 'On this device; not sent (' + (st.code ?? 'REFUSED') + ')';
  if (st.state === 'retry') return 'On this device; not sent yet';
  return 'On this device (encrypted)';
}

// data = {projectId, siteId, generatedAt, catalogSha256, records:[{recordId, formId, revision, saved:{answers,counts},
//   draft:{answers,counts}|null, status:{state, at, code}}], layout, photos:[{mediaId, recordId, cell, place, state}]}
// order = [{id, label, groups:[{formId, gi, title}]}] (location walk order of the view), optional.
export function buildExport(catalog, data, order = null) {
  const name = exportName(data.projectId, data.siteId, data.generatedAt);
  const title = `CONFIDENTIAL — ${data.projectId} — contains PII · TSS ${data.siteId} · ${new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ')}Z`;
  const banner = `CONFIDENTIAL — ${data.projectId} — contains PII`;
  const recs = data.records.filter((r) => catalog.form(r.formId));
  const valueRows = (r, gi) => {
    const form = catalog.form(r.formId), g = form.groups[gi], cur = r.draft ?? r.saved, out = [];
    if (!g) return out;
    const rows = g.repeatable ? Math.max(1, Number(cur.counts?.[gi] ?? 1)) : 1;
    for (let ri = 0; ri < rows; ri++) for (const f of g.fields) {
      const k = `${gi}.${ri}.${f.index}`, v = cur.answers?.[k], sv = r.saved.answers?.[k];
      if (v == null || v === '') continue;
      out.push({ k, label: (g.repeatable ? `Row ${ri + 1} · ` : '') + f.label, v, unsent: r.draft != null && v !== sv, tag: data.layout?.rowTags?.[`${r.formId}|${gi}|${ri}`] ?? null });
    }
    return out;
  };
  const dl = (items) => items.length ? '<dl>' + items.map((x) => `<dt>${esc(x.label)}${x.tag ? ` <small>(${esc(floorName(data.layout, x.tag))})</small>` : ''}</dt><dd${x.unsent ? ' class="unsent"' : ''}>${esc(x.v)}${x.unsent ? ' <small>(unsaved draft)</small>' : ''}</dd>`).join('') + '</dl>' : '';
  const status = '<table><thead><tr><th>Form</th><th>Survey</th><th>Status</th></tr></thead><tbody>' + recs.map((r) =>
    `<tr><td>${esc(catalog.form(r.formId).title)}</td><td><code>${esc(r.recordId.slice(0, 8))}</code></td><td>${esc(statusText(r.status))}${r.draft ? ' · has unsaved draft' : ''}</td></tr>`).join('') + '</tbody></table>';
  const byForm = catalog.forms.map((f) => {
    const mine = recs.filter((r) => r.formId === f.id);
    const body = mine.map((r) => f.groups.map((g) => { const items = valueRows(r, g.index); return items.length ? `<h4>${esc(g.title)}</h4>${dl(items)}` : ''; }).join('')).join('');
    return `<section class="form"><h3>${esc(f.title)}</h3>${body || '<p class="muted">No answers.</p>'}</section>`;
  }).join('');
  const byLoc = (order ?? []).map((s) => {
    const body = s.groups.map((g) => {
      const items = recs.filter((r) => r.formId === g.formId).flatMap((r) => valueRows(r, g.gi));
      return items.length ? `<h4>${esc(g.title)} <small>· ${esc(catalog.form(g.formId).title)}</small></h4>${dl(items)}` : '';
    }).join('');
    return `<section class="zone"><h3>${esc(s.label)}</h3>${body || '<p class="muted">No answers.</p>'}</section>`;
  }).join('');
  const floors = (data.layout?.floors ?? []).map((f) => `<li>${esc(f.label)}${f.provisional ? ' (provisional)' : ''}${data.layout.notes?.['FLOOR/' + f.id] ? ' — ' + esc(data.layout.notes['FLOOR/' + f.id]) : ''}</li>`).join('');
  const devices = Object.values(data.layout?.devices ?? {}).map((d) => `<li><code>${esc(d.deviceId)}</code> · ${esc(floorName(data.layout, d.floor))} · ${esc(d.status || 'not checked')}${d.room ? ' · room ' + esc(d.room) : ''}${d.note ? ' — ' + esc(d.note) : ''}</li>`).join('');
  const photos = (data.photos ?? []).map((p) => `<li><code>${esc(p.mediaId)}</code> · ${esc(catalog.form(recs.find((r) => r.recordId === p.recordId)?.formId)?.title ?? 'survey')} · cell ${esc(p.cell)}${p.place ? ' · ' + esc([p.place.zone, p.place.floor && floorName(data.layout, p.place.floor), p.place.room, p.place.device].filter(Boolean).join(' / ')) : ''} · ${esc(p.state ?? '')}</li>`).join('');
  const html = LT + '!doctype html>\n' + LT + 'html lang="en">' + LT + 'head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>` +
    'body{font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0 auto;max-width:960px;padding:0 16px 48px;color:#1c1c1c;background:#fff}' +
    '.banner{position:sticky;top:0;background:#8b0000;color:#fff;font-weight:700;padding:10px 16px;margin:0 -16px 16px;letter-spacing:.02em}' +
    'h1{font-size:1.4em}h3{border-top:1px solid #ccc;padding-top:12px}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:4px 16px}' +
    'dt{color:#444}dd{margin:0;overflow-wrap:anywhere}dd.unsent{background:#fff4ce}.muted{color:#666}table{border-collapse:collapse;width:100%}' +
    'th,td{border-bottom:1px solid #ddd;text-align:left;padding:4px 6px;vertical-align:top}code{font-size:.9em}' +
    '@media (max-width:600px){dl{grid-template-columns:1fr}dd{margin-bottom:8px}}</style>' + LT + '/head>' + LT + 'body>' +
    `<div class="banner" role="note">${esc(banner)}</div>` +
    `<h1>Site survey (TSS) · ${esc(data.siteId)}</h1><p class="muted">Exported ${esc(new Date(data.generatedAt).toISOString().slice(0, 16).replace('T', ' '))}Z from this device. ` +
    'Includes answers saved on this device and not yet sent, and unsaved drafts (highlighted). Keep this file in the designated confidential location only.</p>' +
    `<h2>Status per survey</h2>${status}` +
    (byLoc ? `<h2>By location (walk order)</h2>${byLoc}` : '') +
    `<h2>By form</h2>${byForm}` +
    (floors ? `<h2>Floors</h2><ul>${floors}</ul>` : '') + (devices ? `<h2>Devices checked</h2><ul>${devices}</ul>` : '') +
    `<h2>Photos</h2>${photos ? `<p class="muted">Listed by media id (the photos stay on the device / in the Drive folder).</p><ul>${photos}</ul>` : '<p class="muted">None.</p>'}` +
    `${LT}script type="application/json" id="rasp-tss-export">${jsonBlock({ schema: EXPORT_SCHEMA, ...data })}${LT}/script>` +
    LT + '/body>' + LT + '/html>\n';
  return { name, fileName: name + '.html', title, html, bytes: new TextEncoder().encode(html).length };
}
const floorName = (layout, id) => layout?.floors?.find((f) => f.id === id)?.label ?? id ?? '';

// Reads the JSON block back. Fails closed on anything that is not a well-formed rasp-tss-export/1 document.
export function parseExport(text) {
  const fail = (c) => { throw Object.assign(new Error(c), { code: c }); };
  if (typeof text !== 'string' || text.length > 4 * MAX_EXPORT) fail('EXPORT_FILE_INVALID');
  const m = new RegExp(LT + 'script type="application/json" id="rasp-tss-export">([\\s\\S]*?)' + LT + '/script>').exec(text);
  if (!m) fail('EXPORT_FILE_INVALID');
  let d;
  try { d = JSON.parse(m[1]); } catch { fail('EXPORT_FILE_INVALID'); }
  if (!d || d.schema !== EXPORT_SCHEMA || typeof d.projectId !== 'string' || typeof d.siteId !== 'string' || !Array.isArray(d.records)) fail('EXPORT_FILE_INVALID');
  const ans = (o) => o && typeof o === 'object' && !Array.isArray(o) && Object.entries(o).every(([k, v]) => KEY_RE.test(k) && typeof v === 'string');
  const cnt = (o) => o == null || (typeof o === 'object' && !Array.isArray(o) && Object.values(o).every((v) => Number.isSafeInteger(v) && v >= 1));
  for (const r of d.records) {
    if (!r || !ID_RE.test(r.recordId ?? '') || typeof r.formId !== 'string' || !r.saved || !ans(r.saved.answers) || !cnt(r.saved.counts) || (r.draft != null && (!ans(r.draft.answers) || !cnt(r.draft.counts)))) fail('EXPORT_FILE_INVALID');
  }
  return d;
}

// ---- delivery: folder (File System Access), share sheet, download ------------------------------------------------------
// Every browser API is reached through FILE_ENV so the page can be tested; nothing here calls fetch.
const FOLDER_DB = 'rasp-tss-folder', FOLDER_STORE = 'handles';
function idb(op) {
  return new Promise((resolve, reject) => {
    const req = globalThis.indexedDB.open(FOLDER_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FOLDER_STORE);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(FOLDER_STORE, op.write ? 'readwrite' : 'readonly'), st = tx.objectStore(FOLDER_STORE);
      const r = op.write ? st.put(op.value, op.key) : st.get(op.key);
      tx.oncomplete = () => { req.result.close(); resolve(op.write ? true : r.result ?? null); };
      tx.onerror = () => { req.result.close(); reject(tx.error); };
    };
  });
}
export const FILE_ENV = {
  hasFolderPicker: () => typeof globalThis.showDirectoryPicker === 'function',
  pickFolder: () => globalThis.showDirectoryPicker({ id: 'rasp-tss', mode: 'readwrite' }),
  // The folder handle (not the data) is kept in this browser's IndexedDB, per workspace.
  loadFolder: (key) => (globalThis.indexedDB ? idb({ key }).catch(() => null) : Promise.resolve(null)),
  saveFolder: (key, handle) => (globalThis.indexedDB ? idb({ key, value: handle, write: true }).catch(() => false) : Promise.resolve(false)),
  isIOS: () => { const n = globalThis.navigator; return Boolean(n) && (/iPad|iPhone|iPod/.test(n.userAgent ?? '') || (n.platform === 'MacIntel' && n.maxTouchPoints > 1)); },
  canShareFiles: (files) => typeof globalThis.navigator?.share === 'function' && typeof globalThis.navigator?.canShare === 'function' && globalThis.navigator.canShare({ files }) === true,
  share: (data) => globalThis.navigator.share(data),
  makeFile: (html, fileName) => new File([html], fileName, { type: 'text/html' }),
  download: (file) => {
    const url = URL.createObjectURL(file), a = globalThis.document.createElement('a');
    a.href = url; a.download = file.name; a.rel = 'noopener'; a.style.display = 'none';
    globalThis.document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};
export function setFileEnv(patch) { const prev = { ...FILE_ENV }; Object.assign(FILE_ENV, patch ?? {}); return () => Object.assign(FILE_ENV, prev); }
async function writeTo(dir, file) {
  const fh = await dir.getFileHandle(file.name, { create: true });
  const w = await fh.createWritable();
  await w.write(file); await w.close();
}
async function permitted(dir, ask) {
  const o = { mode: 'readwrite' };
  if (typeof dir.queryPermission === 'function' && (await dir.queryPermission(o)) === 'granted') return true;
  return ask && typeof dir.requestPermission === 'function' ? (await dir.requestPermission(o)) === 'granted' : !dir.queryPermission;
}
// "Save TSS to a folder" (a user tap). Chrome/Edge: the chosen folder (picked once, kept, permission re-asked) gets the
// file. Others: iOS share sheet (Save to Files) or a normal download ("Your browser will ask where to save").
// Returns {how: 'folder'|'share'|'download'|'cancelled', folder?}.
export async function saveToFolder(file, key) {
  if (FILE_ENV.hasFolderPicker()) {
    let dir = await FILE_ENV.loadFolder(key);
    if (dir && !(await permitted(dir, true).catch(() => false))) dir = null;
    if (!dir) {
      try { dir = await FILE_ENV.pickFolder(); } catch (e) { if (e?.name === 'AbortError') return { how: 'cancelled' }; throw e; }
      await FILE_ENV.saveFolder(key, dir);
    }
    await writeTo(dir, file);
    return { how: 'folder', folder: dir.name ?? '' };
  }
  if (FILE_ENV.isIOS() && FILE_ENV.canShareFiles([file])) {
    try { await FILE_ENV.share({ files: [file], title: file.name }); return { how: 'share' }; }
    catch (e) { if (e?.name === 'AbortError') return { how: 'cancelled' }; }
  }
  FILE_ENV.download(file);
  return { how: 'download' };
}
// The autosave copy: only into a folder already chosen AND still permitted (no prompt without a tap).
export async function autosaveToFolder(file, key) {
  if (!FILE_ENV.hasFolderPicker()) return null;
  const dir = await FILE_ENV.loadFolder(key);
  if (!dir || !(await permitted(dir, false).catch(() => false))) return null;
  await writeTo(dir, file);
  return { how: 'folder', folder: dir.name ?? '' };
}
// "Share TSS file": the device share sheet (AirDrop, Messages, Mail, Files, ...). User-initiated only. Without file
// sharing: a download + "Saved to Downloads; share it from there". Nothing here awaits the network.
export async function shareFile(file, title) {
  if (FILE_ENV.canShareFiles([file])) {
    try { await FILE_ENV.share({ files: [file], title }); return { how: 'share' }; }
    catch (e) { if (e?.name === 'AbortError') return { how: 'cancelled' }; if (e?.name !== 'NotAllowedError') throw e; return { how: 'needs-tap' }; }
  }
  FILE_ENV.download(file);
  return { how: 'download' };
}
export const EXPORT_LIMIT = MAX_EXPORT;

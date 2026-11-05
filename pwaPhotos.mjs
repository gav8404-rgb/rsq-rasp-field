// photo-pwa-r1: photos in the field app TSS (same pipeline as the Wix TSS: raspPhotos.mjs PhotoQueue, photo-tag-r1 r3).
//   - every question of the edit screen: "Take photo" (camera, capture=environment) and "Add from library" (no capture,
//     several at once, processed one at a time)
//   - this site's "Upload existing photos" tray on the TSS home screen: photos stay on this device until the member picks
//     a form + question (searchable) and one of this device's records of that form; then they upload and link
//   - each photo is re-encoded on this device, EXIF/GPS/XMP stripped and asserted; location is kept (as a separate field,
//     never in the image) only for a question that asks for GPS coordinates
//   - stored in the encrypted vault (AES-GCM, the app's own key), so photos survive offline use, reloads and locks; they
//     upload with the app's sync (online event, Sync now, the 60 s timer) through the device route raspPhoto
// DOM is built with textContent only. Nothing here talks to the network except through the bound photo fetcher.
import { PhotoQueue } from './raspPhotos.mjs';

export const PHOTO_LOCATION = /\b(gps|latitude|longitude|coordinates?)\b/i;
const RECORD_ID = /^[A-Za-z0-9_-]{1,80}$/;
const BLOB_KEY = ':@photo:';

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
// The vault database stores JSON. Photo rows hold a Blob: stored as base64 inside the same AES-GCM record.
export function photoStore(db) {
  const decode = (v) => (v && v.blob && typeof v.blob.b64 === 'string' ? { ...v, blob: new Blob([unb64(v.blob.b64)], { type: v.blob.type || 'image/jpeg' }) } : v);
  const encode = async (v) => (v && v.blob instanceof Blob ? { ...v, blob: { type: v.blob.type, b64: b64(new Uint8Array(await v.blob.arrayBuffer())) } } : v);
  return Object.freeze({
    get: async (k) => decode(await db.get(k)),
    async update(k, fn) {
      if (!String(k).includes(BLOB_KEY)) return db.update(k, fn);
      const next = await encode(fn(decode(await db.get(k))));   // one writer per photo id: computed outside the row lock
      return decode(await db.update(k, () => next));
    },
  });
}

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c);
  return e;
}
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const short = (id) => String(id ?? '').slice(0, 8);
const stateText = (i) => (i.state === 'linked' ? 'linked' : i.state === 'uploaded' ? 'uploaded, linking on sync' : i.state === 'failed' ? 'refused: ' + (i.error ?? '') : 'on this device, uploads on sync');
const timeText = (i) => (i.takenAt ? `${i.takenAt.local.replace('T', ' ')} · taken` : i.fileDate ? `${i.fileDate.slice(0, 16).replace('T', ' ')} UTC · file date` : 'time not known');

/**
 * @param db        the vault database (vault.database(): get / update)
 * @param fetcher   photo fetcher (photoTransport.mjs createPhotoFetcher)
 * @param catalog   the app's catalog.json ({forms:[{id,title,groups:[{title,repeatable,fields:[{label}]}]}]})
 * @param records   async () => [{id, formId, counts}] this workspace's records on this device
 * @param onChange  () => void, after photos were added / assigned / removed (the app syncs if online)
 * @param say       (text, bad) => void, one status line
 */
export function createPwaPhotos({ db, fetcher, catalog, records, onChange = () => {}, say = () => {}, imaging }) {
  let queue = null, items = [], gen = 0, batch = null, links = new Map(), openPart = null;
  const boxes = new Set(), thumbs = new Map(), trayUi = { root: null, open: null, q: '', pick: null, rec: null, row: 0 };
  let index = null;
  const questions = () => index ??= catalog.forms.flatMap((f) => f.groups.flatMap((g, gi) => g.fields.map((x, fi) => ({ key: `${f.id}|${gi}|${fi}`, formId: f.id, gi, fi, repeatable: !!g.repeatable, form: f.title, group: g.title, label: x.label || x.id, hay: norm(`${f.id} ${f.title} ${g.title} ${x.label}`) }))));
  const matches = (q) => { const w = norm(q).split(/\s+/).filter(Boolean); return w.length ? questions().filter((x) => w.every((t) => x.hay.includes(t))).slice(0, 40) : []; };

  async function refresh() {
    const g = gen;
    let next = [];
    try { next = queue ? await queue.list() : []; } catch { next = items; }
    if (g !== gen) return;
    items = next;
    for (const b of [...boxes]) { if (!b.el.isConnected) boxes.delete(b); else paintBox(b); }
    paintTray();
  }
  function thumb(id) {
    const img = h('img', { alt: 'Photo ' + short(id), width: '72', height: '72', class: 'photo-thumb' });
    if (thumbs.has(id)) img.src = thumbs.get(id);
    else if (queue) { const g = gen; queue.blob(id).then((b) => { if (g !== gen) return; const u = URL.createObjectURL(b); thumbs.set(id, u); img.src = u; }, () => {}); }
    return img;
  }
  const busy = () => !queue;

  // ---- per question --------------------------------------------------------------------------------------------
  function fieldBox(recordIdOf, cell, field) {
    const wantsLocation = PHOTO_LOCATION.test(field?.label ?? '');
    const list = h('ul', { class: 'photo-list', 'data-photo-list': cell });
    const pick = (label, camera) => h('label', { class: 'photo-btn' }, label,
      h('input', { type: 'file', accept: 'image/*', 'aria-label': label, ...(camera ? { capture: 'environment' } : { multiple: true }), onchange: (e) => {
        const files = [...(e.target.files ?? [])]; e.target.value = '';
        if (!files.length || busy()) return;
        const recordId = recordIdOf();
        if (!RECORD_ID.test(recordId ?? '')) { say('Enter a valid Record ID first (letters, digits, - and _).', true); return; }
        addTo(files, { recordId, cell, wantsLocation, camera });
      } }));
    const el = h('div', { class: 'photos', 'data-photo-cell': cell },
      h('div', { class: 'photo-pick' }, pick('Take photo', true), pick('Add from library', false)),
      wantsLocation ? h('small', { class: 'hint', text: 'GPS question: the photo location is kept as a separate field.' }) : null, list);
    const box = { el, list, cell, recordIdOf };
    boxes.add(box); paintBox(box);
    const rid = recordIdOf();
    if (queue && RECORD_ID.test(rid ?? '') && globalThis.navigator?.onLine !== false && !links.has(rid)) {
      links.set(rid, null);
      const g = gen;
      queue.links(rid).then((v) => { if (g === gen) { links.set(rid, v); refresh(); } }, () => { if (g === gen) links.delete(rid); });
    }
    return el;
  }
  function paintBox(b) {
    const rid = b.recordIdOf();
    const mine = items.filter((i) => i.recordId === rid && i.cell === b.cell);
    const others = (links.get(rid)?.cells?.[b.cell] ?? []).filter((l) => !l.mine && !mine.some((i) => i.id === l.mediaId));
    // replaceChildren() renders a null argument as the text "null", so the optional note is spread in only when present.
    b.list.replaceChildren(...mine.map((i) => h('li', { 'data-photo-item': i.id, 'data-state': i.state }, thumb(i.id), h('span', { text: `You · photo ${short(i.id)} · ${stateText(i)}${i.location ? ' · location kept' : ''}` }))),
      ...(others.length ? [h('li', { class: 'note', text: `${others.length} photo${others.length === 1 ? '' : 's'} by other members linked here` })] : []));
  }
  async function addTo(files, { recordId, cell, wantsLocation, camera }) {
    const g = gen;
    try {
      if (camera) for (const f of files) await queue.capture(f, { recordId, cell, wantsLocation, place: null });
      else {
        const r = await queue.intakeBatch(files, { assign: { recordId, cell, wantsLocation, place: null }, onProgress: (p) => { if (g === gen) say(`Adding photos: ${p.done} / ${p.total}`); } });
        say(`${r.added} photo${r.added === 1 ? '' : 's'} saved on this device${r.duplicates ? ` · ${r.duplicates} already here` : ''}${r.failed ? ` · ${r.failed} not kept` : ''}. ${globalThis.navigator?.onLine === false ? 'They upload when online.' : 'Uploading…'}`, r.failed > 0);
      }
    } catch (e) { if (g === gen) say('Photo not kept: ' + (e?.code ?? e?.message ?? e), true); }
    if (g !== gen) return;
    await refresh(); onChange();
  }

  // ---- this site's tray ------------------------------------------------------------------------------------------
  function paintTray() {
    const root = trayUi.root;
    if (!root || !root.isConnected) return;
    if (!queue) { root.replaceChildren(); return; }
    const tray = items.filter((i) => i.state === 'unassigned');
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, 'aria-label': 'Upload existing photos', 'data-tray-input': '', disabled: batch?.running, onchange: (e) => {
      const files = [...(e.target.files ?? [])]; e.target.value = '';
      if (files.length) toTray(files);
    } });
    const b = batch;
    const line = !b ? null : b.running ? h('p', { class: 'msg', role: 'status', 'data-tray-progress': `${b.done}/${b.total}`, text: `Adding photos: ${b.done} / ${b.total}. Keep the app open.` })
      : b.interrupted ? h('div', { class: 'banner warn', 'data-tray-interrupted': String(b.notAdded.length) }, h('p', { text: `The last batch stopped after ${b.done} of ${b.total}. Pick these again (photos already added are skipped):` }), h('ul', {}, b.notAdded.slice(0, 50).map((n) => h('li', { text: n }))), h('button', { type: 'button', class: 'ghost', text: 'Dismiss', onclick: () => clearBatch() }))
        : b.failed ? h('div', { class: 'banner warn', 'data-tray-failed': String(b.failed) }, h('p', { text: `${b.failed} not kept:` }), h('ul', {}, (b.failedItems ?? []).slice(0, 50).map((f) => h('li', { text: `${f.name}: ${f.code === 'PHOTO_DECODE_FAILED' ? 'this browser cannot open this format (HEIC: use Safari, or export as JPEG)' : f.code}` }))), h('button', { type: 'button', class: 'ghost', text: 'Dismiss', onclick: () => clearBatch() })) : null;
    root.replaceChildren(h('details', { class: 'photo-tray', 'data-photo-tray': String(tray.length), open: trayUi.show || tray.length > 0 || b?.running || b?.interrupted, ontoggle: (e) => { trayUi.show = e.target.open; } },
      h('summary', { text: `Upload existing photos${tray.length ? ` · ${tray.length} unassigned` : ''}` }),
      h('p', { class: 'note', text: 'Pick photos you already took (several at once). They are saved encrypted on this device and stay here until you assign each one to a question; then they upload and link. Location is removed from every photo and kept only for a question that asks for GPS coordinates.' }),
      h('label', { class: 'photo-btn' }, 'Add photos', input), line,
      tray.length ? h('ul', { class: 'photo-list', 'data-tray-list': '' }, tray.map(trayItem)) : h('p', { class: 'note', text: 'No unassigned photos on this device.' })));
  }
  function trayItem(i) {
    return h('li', { 'data-tray-item': i.id }, thumb(i.id),
      h('div', { class: 'photo-meta' }, h('div', { text: i.sourceName ?? 'photo ' + short(i.id) }), h('small', { text: timeText(i) + (i.hasDeviceLocation ? ' · has a location (used only for a GPS question)' : '') }),
        h('div', { class: 'actions small' }, h('button', { type: 'button', class: 'ghost', 'data-tray-assign': i.id, text: 'Assign to a question', onclick: () => { Object.assign(trayUi, { open: i.id, q: '', pick: null, rec: null, row: 0 }); paintTray(); } }),
          h('button', { type: 'button', class: 'ghost', 'data-tray-remove': i.id, text: 'Remove', onclick: () => remove(i.id) })),
        trayUi.open === i.id ? picker(i) : null));
  }
  function picker(item) {
    const chosen = questions().find((x) => x.key === trayUi.pick) ?? null;
    const host = h('div', { class: 'tray-results', 'data-tray-results': item.id });
    const fill = () => host.replaceChildren(...matches(trayUi.q).map((x) => h('button', { type: 'button', class: 'ghost tray-q', 'data-tray-q': x.key, text: `${x.formId} · ${x.form} — ${x.group ? x.group + ' — ' : ''}${x.label}`, onclick: () => { Object.assign(trayUi, { pick: x.key, rec: null, row: 0 }); paintTray(); } })));
    const search = h('input', { type: 'search', 'data-tray-search': item.id, 'aria-label': 'Search questions', placeholder: 'Search questions (form number or words)', value: trayUi.q, oninput: (e) => { trayUi.q = e.target.value; fill(); } });
    fill();
    const out = h('div', { class: 'tray-picker', 'data-tray-picker': item.id }, search, chosen ? null : host);
    if (chosen) {
      const recBox = h('div', { 'data-tray-chosen': chosen.key }, h('strong', { text: `${chosen.formId} · ${chosen.form}` }), h('div', { text: chosen.label }));
      out.append(recBox);
      records().then((all) => {
        const mine = all.filter((r) => r.formId === chosen.formId);
        if (!mine.length) { recBox.append(h('p', { class: 'msg bad', 'data-tray-norecord': '', text: 'No record of this form on this device yet: start one (New record), then assign.' })); return; }
        if (!mine.some((r) => r.id === trayUi.rec)) trayUi.rec = mine[0].id;
        const rec = () => mine.find((r) => r.id === trayUi.rec);
        const rowSel = h('span');
        const paintRow = () => {
          rowSel.replaceChildren();
          if (!chosen.repeatable) { trayUi.row = 0; return; }
          const n = Math.max(1, Number(rec()?.counts?.[String(chosen.gi)] ?? 1));
          trayUi.row = Math.min(trayUi.row, n - 1);
          rowSel.append(h('label', {}, 'Entry ', h('select', { 'data-tray-row': item.id, onchange: (e) => { trayUi.row = Number(e.target.value); } }, Array.from({ length: n }, (_, r) => h('option', { value: String(r), selected: r === trayUi.row, text: String(r + 1) })))));
        };
        recBox.append(h('label', {}, 'Record ', h('select', { 'data-tray-record': item.id, onchange: (e) => { trayUi.rec = e.target.value; trayUi.row = 0; paintRow(); } }, mine.map((r) => h('option', { value: r.id, selected: r.id === trayUi.rec, text: r.id })))), rowSel,
          h('div', { class: 'actions small' }, h('button', { type: 'button', 'data-tray-confirm': item.id, text: 'Assign to this question', onclick: () => assign(item.id, chosen) }),
            h('button', { type: 'button', class: 'ghost', text: 'Choose another question', onclick: () => { trayUi.pick = null; paintTray(); } })));
        paintRow();
      }, () => {});
    }
    out.append(h('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => { Object.assign(trayUi, { open: null, q: '', pick: null, rec: null, row: 0 }); paintTray(); } }));
    return out;
  }
  async function toTray(files) {
    const g = gen;
    trayUi.show = true;
    batch = { running: true, total: files.length, done: 0 };
    paintTray();
    try {
      const r = await queue.intakeBatch(files, { onProgress: (p) => { if (g === gen) { batch = { running: true, ...p }; paintTray(); } } });
      if (g !== gen) return;
      batch = { running: false, ...r };
      say(`${r.added} photo${r.added === 1 ? '' : 's'} kept on this device${r.duplicates ? ` · ${r.duplicates} already here` : ''}${r.failed ? ` · ${r.failed} not kept` : ''}. Assign each one to a question to upload it.`, r.failed > 0);
    } catch (e) { if (g === gen) { batch = null; say('Photos not kept: ' + (e?.code ?? e?.message ?? e), true); } }
    if (g === gen) await refresh();
  }
  async function assign(id, q) {
    const g = gen;
    const label = catalog.forms.find((f) => f.id === q.formId)?.groups[q.gi]?.fields[q.fi]?.label ?? '';
    const target = { recordId: trayUi.rec, cell: `${q.gi}.${q.repeatable ? trayUi.row : 0}.${q.fi}`, wantsLocation: PHOTO_LOCATION.test(label), place: null };
    Object.assign(trayUi, { open: null, q: '', pick: null, rec: null, row: 0 });
    try { await queue.assign(id, target); say('Photo assigned. It uploads and links on sync.'); }
    catch (e) { if (g === gen) say('Not changed: ' + (e?.code ?? e?.message ?? e), true); }
    if (g !== gen) return;
    await refresh(); onChange();
  }
  async function remove(id) {
    const g = gen;
    try { await queue.remove(id); say('Photo removed from this device.'); } catch (e) { if (g === gen) say('Not changed: ' + (e?.code ?? e?.message ?? e), true); }
    const u = thumbs.get(id); if (u) { URL.revokeObjectURL(u); thumbs.delete(id); }
    if (g === gen) await refresh();
  }
  async function clearBatch() { try { await queue?.clearBatch(); } catch { /* kept */ } batch = null; paintTray(); }

  const make = (session) => new PhotoQueue({ store: photoStore(db), fetcher, session, ...(imaging ? { imaging } : {}) });
  const api = Object.freeze({
    // open this workspace's queue (after unlock / workspace change / every session refresh). Same workspace: the queue is
    // re-bound to the fresh session (CSRF) and the screen state is kept; another workspace: everything is reset.
    async open(session) {
      let part = null;
      try { part = JSON.stringify([session.actor, session.selected.projectId, session.selected.siteId]); } catch { part = null; }
      if (queue && part && part === openPart) { try { queue = make(session); } catch { /* keep the previous binding */ } return; }
      api.close();
      openPart = part;
      const g = gen;
      try { queue = make(session); } catch { queue = null; return; }
      try { const last = await queue.batch(); if (g === gen) batch = last ? { running: false, ...last } : null; } catch { batch = null; }
      if (g === gen) await refresh();
    },
    close() {
      gen++; queue = null; openPart = null; items = []; batch = null; links = new Map(); index = null;
      for (const u of thumbs.values()) URL.revokeObjectURL(u);
      thumbs.clear(); boxes.clear();
      Object.assign(trayUi, { open: null, q: '', pick: null, rec: null, row: 0, show: false });
      trayUi.root?.replaceChildren();
    },
    fieldBox,
    mountTray(root) { trayUi.root = root; paintTray(); },
    // upload + link every pending photo (not the tray); returns the PhotoQueue sync result
    async sync() {
      if (!queue) return { state: 'closed' };
      const g = gen;
      const r = await queue.sync({ onProgress: (p) => { if (g === gen && p.total) say(`Uploading photos: ${p.done} / ${p.total}`); } }).catch((e) => ({ state: 'retry', code: e?.code ?? String(e) }));
      if (g !== gen) return r;
      for (const rid of new Set(items.map((i) => i.recordId).filter(Boolean))) links.delete(rid);
      await refresh();
      if (r.state === 'retry' || r.state === 'denied') say('Photo upload: ' + (r.code ?? r.state) + ' (kept on this device, retried on the next sync).', true);
      else if (r.linked) say(`${r.linked} photo${r.linked === 1 ? '' : 's'} uploaded and linked.`);
      return r;
    },
    pending: () => items.filter((i) => i.state !== 'linked' && i.state !== 'unassigned' && i.state !== 'failed').length,
    items: () => items.slice(),
  });
  return api;
}

import { OfflineWorkspace } from './offline.mjs';
import { Vault, VaultError, MIN_PASSPHRASE, createAutoLock } from './vault.mjs';
import { createTransport, GatewayError, REPAIR_CODES } from './transport.mjs';
import { createOpsFeed, freshness, OPS_RESYNC_MS } from './ops.mjs';
import { catalogModel, wireTssFile, autosaveCopy } from './tssFile.mjs';
import { createPhotoFetcher } from './photoTransport.mjs';
import { createPwaPhotos } from './pwaPhotos.mjs';

const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
const vault = new Vault();
const db = vault.database();
let cfg, catalog, transport, autoLock, lockChannel = null, session = null, ws = null, current = null, syncing = false, lastSync = null, lastError = null;
let opsFeed = null, opsRec = null, opsOp = null, opsError = null, opsSyncing = false, opsVersion = 0, tab = 'map', tssScreen = 'workspace';
let repairCode = null;
let photos = null;
const REPAIR_OR_OFF = (c) => REPAIR_CODES.has(c) || c === 'DEVICE_ACCESS_DISABLED';
const rendered = { map: -1, sitrep: -1, conop: -1 };
const SYNC_EVERY_MS = 60000;
const TABS = ['map', 'sitrep', 'conop', 'tss'], TSS_SCREENS = ['workspace', 'home', 'edit'];
const pref = { get: (k) => { try { return localStorage.getItem('rsq-pref:' + k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem('rsq-pref:' + k, v); } catch {   } } };

const appRef = { get: () => vault.getJSON('appReference').then((v) => v ?? null), set: (v) => vault.putJSON('appReference', v ?? null) };
async function device() {
  const d = await vault.getJSON('device');
  const pair = await vault.deviceKey();
  return { token: d?.token ?? null, privateKey: pair.privateKey };
}
function show(id) {
  const outer = id === 'pair' || id === 'unlock';
  if (!outer) tssScreen = id;
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = TSS_SCREENS.includes(s.dataset.screen) ? s.dataset.screen !== tssScreen : s.dataset.screen !== id;
  $('#tabs').hidden = outer; $('#lock').hidden = outer;
  if (outer) { for (const v of document.querySelectorAll('[data-view]')) v.hidden = true; $('#opsStale').hidden = true; $('#repair').hidden = true; return; }
  setTab('tss');
}
function setTab(name) {
  if (!TABS.includes(name)) name = 'map';
  tab = name; pref.set('tab', name);
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== name;
  for (const b of document.querySelectorAll('#tabs [data-tab]')) { if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  if (name !== 'tss') renderView(name);
  opsStatus();
}
function say(sel, text, bad = false) { const n = $(sel); n.textContent = text; n.classList.toggle('bad', bad); }
const partition = () => JSON.stringify([session.actor, session.selected.projectId, session.selected.siteId]);
const codeOf = (e) => e?.code ?? (e instanceof Error ? e.message : String(e));

async function refreshSession() {
  const r = await transport.fetcher('/api/beta/session', { method: 'GET', headers: { 'content-type': 'application/json' } });
  let s = await r.json();
  if (!r.ok) throw new GatewayError(s.error ?? 'SESSION_FAILED', r.status);
  const want = (await vault.getJSON('selection')) ?? null;
  if (want && (!s.selected || s.selected.projectId !== want.projectId || s.selected.siteId !== want.siteId) && s.workspaces.some((w) => w.projectId === want.projectId && w.siteId === want.siteId)) {
    const r2 = await transport.fetcher('/api/beta/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rasp-csrf': s.csrf }, body: JSON.stringify(want) });
    const s2 = await r2.json();
    if (!r2.ok) throw new GatewayError(s2.error ?? 'SESSION_SELECT_FAILED', r2.status);
    s = s2;
  }
  await vault.putJSON('session', s);
  return s;
}
async function selectWorkspace(projectId, siteId) {
  await vault.putJSON('selection', { projectId, siteId });
  session = await refreshSession();
  openWorkspace();
}
function openWorkspace() {
  ws?.close();
  ws = null;
  if (!session?.selected) return;
  ws = new OfflineWorkspace({ database: db, session, fetcher: transport.fetcher, baseURL: '' });
  void photos?.open(session);
}

async function localRecords() {
  if (!session?.selected) return [];
  const p = partition() + ':';
  const ids = (await db.keys(p)).map((k) => k.slice(p.length)).filter((id) => !id.startsWith('@'));
  const out = [];
  for (const id of ids) { const row = await db.get(p + id); out.push({ id, queued: row?.queue?.length ?? 0, conflicts: row?.conflicts?.length ?? 0, revision: row?.head?.revision ?? 0, formId: row?.draft?.formId ?? row?.head?.formId, others: row?.authors?.others ?? 0 }); }
  return out.sort((a, b) => a.id < b.id ? -1 : 1);
}
async function photoRecords() {
  if (!session?.selected) return [];
  const p = partition() + ':', out = [];
  for (const k of await db.keys(p)) {
    const id = k.slice(p.length); if (id.startsWith('@')) continue;
    const row = await db.get(k), d = row?.queue?.length || row?.conflicts?.length ? row.draft : (row?.head?.revision ? row.head : row?.draft);
    const formId = d?.formId ?? row?.head?.formId; if (formId) out.push({ id, formId, counts: d?.counts ?? {} });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
async function queuedTotal() { return (await localRecords()).reduce((n, r) => n + r.queued, 0); }

async function syncAll(reason = 'auto') {
  if (syncing || !navigator.onLine || !vault.unlocked()) return;
  const g = lockGen;
  syncing = true; lastError = null; await status();
  try {
    session = await refreshSession();
    openWorkspace();
    if (!ws) return;
    try { await ws.discover(); } catch (e) { if (e instanceof GatewayError) throw e; }
    for (const r of await localRecords()) {
      if (!r.queued || r.conflicts) continue;
      try { await ws.sync(r.id); } catch (e) { lastError = r.id + ': ' + codeOf(e); if (e instanceof GatewayError) throw e; }
    }
    if (photos) { const pr = await photos.sync(); if (REPAIR_OR_OFF(pr?.code)) throw new GatewayError(pr.code, 401); }
    lastSync = new Date();
  } catch (e) {
    lastError = codeOf(e);
    if (REPAIR_CODES.has(e?.code)) lastError += ' — this device must be paired again (saved data stays on the device).';
    if (g === lockGen && REPAIR_OR_OFF(e?.code)) await enterRepair(e.code);
  } finally {
    syncing = false;
    if (g !== lockGen || !vault.unlocked()) { if (!vault.unlocked()) { ws?.close(); ws = null; session = null; } return; }
    try {
      await status(); await renderRecords();
      if (current && ws && !document.querySelector('[data-screen="edit"]').hidden) { try { recordNote(await ws.read(current.id)); } catch {   } }
    } catch {   }
  }
}
async function status() {
  let q = 0;
  try { q = vault.unlocked() && session?.selected ? await queuedTotal() : 0; } catch { q = 0; }
  const online = navigator.onLine;
  const chip = $('#net');
  chip.textContent = online ? 'ONLINE' : 'OFFLINE';
  chip.className = 'chip ' + (online ? 'ok' : 'off');
  const pq = vault.unlocked() && photos ? photos.pending() : 0;
  $('#queued').textContent = (q ? `${q} waiting to sync` : 'All saved entries synced') + (pq ? ` · ${pq} photo${pq === 1 ? '' : 's'} waiting` : '');
  $('#queued').dataset.count = String(q);
  $('#syncinfo').textContent = syncing ? 'Syncing…' : lastError ? 'Last sync problem: ' + lastError : lastSync ? 'Last sync ' + lastSync.toISOString().slice(11, 16) + 'Z' : '';
  $('#syncinfo').classList.toggle('bad', !!lastError && !syncing);
  $('#ws').textContent = session?.selected ? `${session.selected.projectId} · ${session.selected.siteId}` : 'No workspace';
}

const formById = (id) => catalog.forms.find((f) => f.id === id);
function renderForm(form, draft) {
  const host = $('#fields'); host.replaceChildren();
  const counts = { ...Object.fromEntries(form.groups.map((_, i) => [String(i), 1])), ...(draft?.counts ?? {}) };
  current.counts = counts;
  form.groups.forEach((g, gi) => {
    const fs = el('fieldset', { class: 'group' }); fs.append(el('legend', {}, g.title || 'Section ' + (gi + 1)));
    for (let row = 0; row < counts[gi]; row++) {
      const box = el('div', { class: 'row' });
      if (g.repeatable) box.append(el('div', { class: 'rowlabel' }, 'Entry ' + (row + 1)));
      g.fields.forEach((f, fi) => {
        const key = `${gi}.${row}.${fi}`, id = 'f_' + key.replaceAll('.', '_'), lab = el('label', { for: id }, f.label || f.id);
        let input;
        if (f.type === 'choice') { input = el('select', { id, 'data-key': key }); input.append(el('option', { value: '' }, '—')); for (const o of f.options) input.append(el('option', { value: o }, o)); }
        else { input = el('textarea', { id, 'data-key': key, rows: '2', maxlength: '20000' }); }
        input.value = draft?.answers?.[key] ?? '';
        box.append(lab, input);
        if (photos) box.append(photos.fieldBox(() => $('#recordId').value.trim(), key, f));
      });
      fs.append(box);
    }
    if (g.repeatable) {
      const add = el('button', { type: 'button', class: 'ghost', 'data-addrow': String(gi) }, '+ Add entry');
      fs.append(add);
    }
    host.append(fs);
  });
}
function collect() {
  const answers = {};
  for (const n of document.querySelectorAll('#fields [data-key]')) if (n.value !== '') answers[n.dataset.key] = n.value;
  const form = formById(current.formId);
  return { formId: form.id, formSourceSha256: form.source_sha256, catalogSha256: catalog.catalogSha256, counts: { ...current.counts }, answers, sourceIds: current.sourceIds ?? [] };
}
async function loadRecord(id, keepScroll = false) {
  const row = await ws.read(id);
  const draft = row.queue.length || row.conflicts.length ? row.draft : (row.head.revision ? row.head : row.draft);
  const formId = draft?.formId ?? $('#formPick').value;
  current = { id, formId, sourceIds: draft?.sourceIds ?? [] };
  $('#recordId').value = id; $('#formPick').value = formId; $('#formPick').disabled = !!(row.head.revision || row.queue.length);
  const y = scrollY;
  renderForm(formById(formId), draft);
  recordNote(row);
  show('edit'); if (keepScroll) scrollTo(0, y); else scrollTo(0, 0);
}
function recordNote(row) {
  const notes = [];
  if (row.queue.length) notes.push(`${row.queue.length} saved change(s) waiting to sync`);
  if (row.head.revision) notes.push(`server revision ${row.head.revision}`);
  if (row.authors?.others) notes.push(`${row.authors.others} other member entr${row.authors.others === 1 ? 'y' : 'ies'} on the server`);
  say('#recordNote', notes.join(' · '));
  $('#conflict').hidden = !row.conflicts.length;
  if (row.conflicts.length) $('#conflictFields').textContent = row.conflicts[0].fields.join(', ');
}
async function saveCurrent() {
  const id = $('#recordId').value.trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) { say('#saveMsg', 'Record ID: letters, digits, - and _ only (max 80).', true); return; }
  if (!current || current.id !== id) current = { ...(current ?? {}), id, formId: $('#formPick').value };
  try {
    await ws.save(id, collect());
    say('#saveMsg', `Saved on this device ${new Date().toISOString().slice(11, 19)}Z` + (navigator.onLine ? ' — syncing…' : ' — will sync when online.'));
    await status(); await renderRecords();
    if (navigator.onLine) syncAll('save');
    void autosaveCopy(tssApp);
  } catch (e) { say('#saveMsg', 'Not saved: ' + codeOf(e), true); }
}

async function renderRecords() {
  if (!ws) { $('#records').replaceChildren(); return; }
  const g = lockGen, list = $('#records'); list.replaceChildren();
  const local = await localRecords(), known = new Set(local.map((r) => r.id));
  let dir = {};
  try { dir = (await ws.directory()).records ?? {}; } catch { dir = {}; }
  if (g !== lockGen || !vault.unlocked()) return;
  const rows = [...local, ...Object.values(dir).filter((d) => !known.has(d.recordId)).map((d) => ({ id: d.recordId, queued: 0, conflicts: 0, revision: d.revision, formId: d.formId, remoteOnly: true }))];
  if (!rows.length) list.append(el('li', { class: 'empty' }, 'No records yet. Start a new one above.'));
  for (const r of rows) {
    const b = el('button', { type: 'button', 'data-open': r.id, class: 'rec' });
    b.append(el('strong', {}, r.id), el('span', {}, (formById(r.formId)?.title ?? 'form ' + (r.formId ?? '?')).slice(0, 60)));
    const tag = r.conflicts ? ['CONFLICT', 'bad'] : r.queued ? [`${r.queued} QUEUED`, 'warn'] : r.remoteOnly ? ['ON SERVER', ''] : r.revision ? ['SYNCED', 'ok'] : ['LOCAL', 'warn'];
    b.append(el('em', { class: 'tag ' + tag[1] }, tag[0]));
    const li = el('li'); li.append(b); list.append(li);
  }
}

const LOCK_TEXT = { manual: 'Locked.', hidden: 'Locked: the app was in the background for 5 minutes or more.', idle: 'Locked after 15 minutes without activity.', cap: 'Locked: the 12-hour unlock limit was reached.', clock: 'Locked: the device clock changed.', remote: 'Locked from another window of this app.' };
let lockGen = 0;
function lockNow(reason = 'manual', { broadcast = true } = {}) {
  lockGen++;
  autoLock?.stop();
  vault.lock();
  ws?.close(); ws = null; session = null; current = null; lastError = null; repairCode = null;
  photos?.close();
  for (const sel of ['#fields', '#records', '#wsPick', '#tssRestoreList']) $(sel).replaceChildren();
  clearOpsViews(); opsRec = null; opsOp = null; opsError = null;
  try { raspOpsForget(document.querySelectorAll('[data-view]')); } catch {   }
  closeExternal();
  for (const sel of ['#recordId']) $(sel).value = '';
  for (const sel of ['#saveMsg', '#homeMsg', '#recordNote', '#syncinfo', '#wsMsg', '#deviceInfo', '#tssFileMsg', '#photoMsg', '#photoEditMsg']) say(sel, '');
  $('#conflict').hidden = true;
  show('unlock');
  say('#unlockMsg', LOCK_TEXT[reason] ?? 'Locked.');
  status().catch(() => {}); opsStatus();
  if (broadcast) { try { lockChannel?.postMessage({ type: 'lock' }); } catch {   } }
}
async function showDevice() {
  const g = lockGen, d = await vault.getJSON('device');
  if (g !== lockGen) return;
  $('#deviceInfo').textContent = d?.deviceId ? `This device: ${d.label || 'unnamed device'} [${String(d.deviceId).slice(0, 6)}] (same name and code as on the members page)` : '';
}

const currentOp = () => session?.selected?.projectId ?? null;
const opCandidates = () => [...new Set([currentOp(), opsOp, ...(session?.workspaces ?? []).map((w) => w?.projectId)].filter((x) => typeof x === 'string' && x))];
const opsStale = (ms) => !opsRec || Date.now() - opsRec.receivedAt > ms;
const OPS_TEXT = { NOT_AUTHORIZED: 'No operation data is authorized for this member (any copy on this device was removed).', DEVICE_ACCESS_DISABLED: 'Device access is switched off by RSQ. Operation data was removed from this device.', OPS_REPLY_REFUSED: 'The server reply was not a member view and was not stored.' };
async function syncOps(reason = 'auto') {
  if (opsSyncing || !navigator.onLine || !vault.unlocked()) return;
  const cands = opCandidates(); if (!cands.length) { opsStatus(); return; }
  const g = lockGen;
  opsSyncing = true; opsStatus();
  try {
    let last = null;
    for (const op of cands) {
      const r = await opsFeed.sync(op);
      if (g !== lockGen || !vault.unlocked()) return;
      if (r.wiped && opsRec?.op === op) { opsRec = null; opsVersion++; }
      last = { op, r };
      if (r.error !== 'NOT_AUTHORIZED') break;
    }
    opsError = last.r.error;
    const rec = last.r.rec;
    if (rec && (!opsRec || rec.op !== opsRec.op || rec.receivedAt !== opsRec.receivedAt)) { opsRec = rec; opsVersion++; }
    if (rec) opsOp = last.op;
    if (REPAIR_OR_OFF(opsError)) await enterRepair(opsError);
    else if (!opsError && repairCode) repairCode = null;
  } catch (e) {
    if (g === lockGen && vault.unlocked()) opsError = codeOf(e);
  } finally {
    opsSyncing = false;
    if (g === lockGen && vault.unlocked()) { opsStatus(); if (tab !== 'tss') renderView(tab); }
  }
}
async function enterRepair(code) {
  repairCode = code;
  try { await opsFeed.wipeAll(); } catch {   }
  if (opsRec) { opsRec = null; opsVersion++; }
  opsError = code;
  opsStatus(); if (tab !== 'tss') renderView(tab);
}
async function pairAgain() {
  let q = null;
  try { q = session?.selected ? await queuedTotal() : null; } catch { q = null; }
  lockNow('repair');
  show('pair'); $('#pairCancel').hidden = false; $('#pairNote').hidden = false;
  say('#pairNote', 'Pair again: on the members page tap Pair a phone/tablet, then enter the new code and the SAME device passphrase. ' +
    (q ? `${q} saved TSS ${q === 1 ? 'entry has' : 'entries have'} not synced yet: ${q === 1 ? 'it stays' : 'they stay'} on this device (encrypted) and ${q === 1 ? 'syncs' : 'sync'} after pairing.` : 'Saved TSS entries stay on this device.'));
}
function opsStatus() {
  const f = freshness(opsRec);
  $('#opsUpdated').textContent = !vault.unlocked() ? '' : opsSyncing ? 'Updating…' : (opsRec ? f.text : 'No ops data yet') + (opsRec?.payload?.meta?.project ? ' · ' + opsRec.payload.meta.project : '');
  const err = opsError && opsError !== 'NETWORK_UNAVAILABLE' ? (OPS_TEXT[opsError] ?? (REPAIR_CODES.has(opsError) ? 'This device must be paired again. Operation data was removed from this device.' : 'Last update failed: ' + opsError)) : '';
  const rep = vault.unlocked() && repairCode ? (repairCode === 'DEVICE_ACCESS_DISABLED' ? OPS_TEXT.DEVICE_ACCESS_DISABLED : 'This device must be paired again. Operation data was removed from this device.') + ' Saved TSS entries stay on this device.' : '';
  $('#repairText').textContent = rep; $('#repair').hidden = !rep;
  const warn = !rep && vault.unlocked() && tab !== 'tss' ? (err || (opsRec && f.stale ? f.staleText : '')) : '';
  $('#opsStale').textContent = warn; $('#opsStale').hidden = !warn;
}
function clearOpsViews() { for (const v of document.querySelectorAll('[data-view]:not([data-view="tss"])')) v.replaceChildren(); for (const k of Object.keys(rendered)) rendered[k] = -1; }
function emptyView(root, text) { root.replaceChildren(el('p', { class: 'empty-ops' }, text)); }
function renderView(name) {
  const root = document.querySelector(`[data-view="${name}"]`);
  if (!root || !vault.unlocked() || rendered[name] === opsVersion) return;
  rendered[name] = opsVersion;
  const D = opsRec?.payload ?? null;
  if (!D) { emptyView(root, opsSyncing ? 'Loading operation data…' : navigator.onLine ? 'No operation data yet. It loads automatically when online; or tap Refresh ops data on the TSS tab.' : 'No operation data on this device yet. Connect once to load it; after that it works offline.'); return; }
  try {
    if (name === 'map') { root.innerHTML = raspBoardV2(D, new Date(), { shackled: false }); raspBoardV2Bind(root, D); }
    else if (name === 'sitrep') renderSitrep(root, D);
    else if (name === 'conop') renderConop(root, D);
  } catch (e) { emptyView(root, 'This view could not be drawn: ' + codeOf(e)); }
}
function renderSitrep(root, D) {
  const now = new Date();
  root.innerHTML = sitrepV2Strip(D, sr_state, now) + sitrepV2(D, sr_state, now);
  sitrepV2Bind(root, D, () => renderSitrep(root, D));
  const tag = (t) => { const m = /^([A-Z]{3})\s+(\d{1,2})(\s*\/\s*[A-Z][A-Z0-9+:-]{1,9})?$/i.exec(t.trim()); return m && m[1].toUpperCase() + ' ' + Number(m[2]); };
  const cardDay = (t) => { const m = /^([A-Z]{3})\s+(\d{1,2})$/i.exec(t.trim()); return m && m[1].toUpperCase() + ' ' + Number(m[2]); };
  const headDay = (t) => { const m = /^(\d{1,2})\s+[A-Z]{3}\s+\d{4}\s+\(([A-Z]{3})\)$/i.exec(t.trim()); return m && m[2].toUpperCase() + ' ' + Number(m[1]); };
  for (const lab of root.querySelectorAll('.sr-tl-lab')) { const b = lab.closest('.sr-tl-card')?.querySelector('.sr-tl-date b'); if (b && tag(lab.textContent) && tag(lab.textContent) === cardDay(b.textContent)) lab.remove(); }
  for (const lab of root.querySelectorAll('.sr-dayhead .sr-daylabel')) { const d = lab.closest('.sr-dayhead').querySelector('.sr-daydate'); if (d && tag(lab.textContent) && tag(lab.textContent) === headDay(d.textContent)) lab.remove(); }
  if (!navigator.onLine) for (const f of root.querySelectorAll('iframe')) f.replaceWith(el('p', { class: 'note' }, 'Map preview needs a connection. Use the MAP tab: pins, place cards and Directions work offline.'));
}
function renderConop(root, D) {
  const c = D.conop && typeof D.conop === 'object' ? { ...D.conop } : D.conop;
  if (c && typeof c === 'object') { delete c.pdf; delete c.pdfNight; }
  const Dc = { ...D, warno: null, conop: c };
  root.innerHTML = conopV2(Dc);
  for (const f of root.querySelectorAll('iframe[data-cp-frame]')) { f.setAttribute('sandbox', 'allow-same-origin'); f.addEventListener('load', () => bindFrameLinks(f)); }
  conopV2Bind(root, Dc);
}
function bindFrameLinks(f) {
  let doc; try { doc = f.contentDocument; } catch { return; }
  if (!doc || doc.raspBound) return;
  doc.raspBound = true;
  for (const n of doc.querySelectorAll('iframe, frame, object, embed, link, meta, base, form, area, script, foreignObject')) n.remove();
  for (const a of doc.querySelectorAll('a[href]')) if (!/^#[A-Za-z0-9_-]*$/.test(a.getAttribute('href').trim())) a.replaceWith(doc.createTextNode(a.textContent));
  const act = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Enter') return;
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-rasp-tel], [data-rasp-ext]') : null;
    if (!t) return;
    ev.preventDefault();
    const tel = t.getAttribute('data-rasp-tel');
    if (tel !== null) { const h = raspTelHref(tel.slice(4)); if (h) location.href = h; return; }
    const u = raspHttpsUrl(t.getAttribute('data-rasp-ext') || '');
    if (u) askOpenExternal(u);
  };
  doc.addEventListener('click', act); doc.addEventListener('keydown', act);
}
let extPending = null;
function askOpenExternal(u) {
  extPending = u;
  $('#extHost').textContent = new URL(u).hostname;
  $('#extUrl').textContent = u;
  $('#extSheet').hidden = false;
  $('#extCancel').focus();
}
function closeExternal() { extPending = null; $('#extSheet').hidden = true; $('#extHost').textContent = ''; $('#extUrl').textContent = ''; }
function applyTheme(t, save) {
  const night = t === 'night';
  document.body.classList.toggle('rasp-night', night);
  globalThis.raspTheme = night ? 'night' : 'day';
  $('#themeBtn').textContent = night ? '☀' : '☾';
  $('#themeBtn').setAttribute('aria-pressed', String(night));
  $('#themeBtn').setAttribute('aria-label', night ? 'Switch to day theme' : 'Switch to night theme');
  document.querySelector('meta[name="theme-color"]').setAttribute('content', night ? '#080e12' : '#173d51');
  if (save) pref.set('theme', night ? 'night' : 'day');
  rendered.conop = -1;
  if (tab === 'conop') renderView('conop');
}

async function afterUnlock() {
  const g = lockGen, live = () => g === lockGen && vault.unlocked();
  autoLock?.started();
  const dev = await vault.getJSON('device'); if (!live()) return;
  const expired = !!dev?.token && Number.isFinite(dev.expiresAt) && dev.expiresAt <= Date.now();
  if (!dev?.token) { say('#pairMsg', 'Unlocked. This device is not paired yet: enter a pairing code (and the same passphrase).'); show('pair'); return; }
  const saved = (await vault.getJSON('session')) ?? null; if (!live()) return;
  session = saved;
  await showDevice(); if (!live()) return;
  if (navigator.onLine) { let fresh = null, err = null; try { fresh = await refreshSession(); } catch (e) { err = codeOf(e); } if (!live()) return; if (err) lastError = err; else session = fresh; }
  openWorkspace();
  await fillWorkspaces(); if (!live()) return;
  let op = currentOp() ?? (await opsFeed.lastOp()), rec = op ? await opsFeed.load(op) : null;
  if (!rec) { const last = await opsFeed.lastOp(); if (last && last !== op) { const r2 = await opsFeed.load(last); if (r2) { rec = r2; op = last; } } }
  if (!live()) return;
  opsOp = op; opsRec = rec; opsVersion++;
  const want = pref.get('tab') ?? 'map';
  tssScreen = session?.selected ? 'home' : 'workspace';
  show(tssScreen);
  setTab(want);
  await status(); await renderRecords(); if (!live()) return;
  if (expired) { await enterRepair('DEVICE_EXPIRED'); return; }
  if (navigator.onLine) { syncAll('unlock'); await syncOps('unlock'); }
}
async function fillWorkspaces() {
  const pick = $('#wsPick'); pick.replaceChildren();
  for (const w of session?.workspaces ?? []) pick.append(el('option', { value: w.projectId + '|' + w.siteId }, `${w.projectId} · ${w.siteId}`));
}

// photos-r2 E2: the TSS file (Save to a folder / Share / Restore). Local reads only; a restore opens unsaved values in the
// editor (the file's answers over this device's latest save) and the member saves them with the normal Save.
let tssCat = null;
const tssApp = {
  db,
  partition: () => partition(),
  selected: () => (vault.unlocked() && ws ? session?.selected ?? null : null),
  catalog: () => (tssCat ??= catalog ? catalogModel(catalog) : null),
  editing: () => (current && $('#fields').childElementCount && formById(current.formId) ? { id: current.id, ...collect() } : null),
  say: (t, bad = false) => say('#tssFileMsg', t, bad),
  openFromFile: async (it) => {
    const row = await ws.read(it.recordId);
    const known = row.draft?.formId ?? row.head?.formId;
    if (known && known !== it.formId) throw Object.assign(new Error('EXPORT_FORM_MISMATCH'), { code: 'EXPORT_FORM_MISMATCH' });
    const base = row.queue.length || row.conflicts.length ? row.draft : (row.head.revision ? row.head : row.draft);
    const counts = { ...(base?.counts ?? {}) };
    for (const [gi, n] of Object.entries(it.counts)) counts[gi] = Math.max(counts[gi] ?? 1, n);
    current = { id: it.recordId, formId: it.formId, sourceIds: base?.sourceIds ?? [] };
    $('#recordId').value = it.recordId; $('#formPick').value = it.formId; $('#formPick').disabled = !!(row.head.revision || row.queue.length);
    renderForm(formById(it.formId), { answers: { ...(base?.answers ?? {}), ...it.answers }, counts });
    recordNote(row); $('#conflict').hidden = true;
    say('#saveMsg', 'Restored from file: NOT saved yet. Review the answers, then tap Save (saved encrypted on this device first).');
    show('edit'); scrollTo(0, 0);
  },
};
function wire() {
  wireTssFile(tssApp, $);
  $('#pairForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const p1 = $('#pass1').value, p2 = $('#pass2').value;
    if (p1.length < MIN_PASSPHRASE || p1 !== p2) { say('#pairMsg', `Passphrase: use 4 or more random words (at least ${MIN_PASSPHRASE} characters), typed the same twice.`, true); return; }
    if (!navigator.onLine) { say('#pairMsg', 'Pairing needs a connection.', true); return; }
    say('#pairMsg', 'Pairing…');
    try {
      if (!(await vault.exists())) await vault.create(p1); else await vault.unlock(p1);
      const pair = await vault.deviceKey();
      const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
      const label = ($('#label').value || 'device').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40);
      const out = await transport.pair({ code: $('#pairCode').value, publicKey: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, label });
      await vault.putJSON('device', { token: out.token, deviceId: out.deviceId, expiresAt: out.expiresAt, label });
      await vault.putJSON('appReference', null);
      try { await navigator.storage?.persist?.(); } catch {   }
      $('#pass1').value = $('#pass2').value = $('#pairCode').value = '';
      $('#pairCancel').hidden = true; $('#pairNote').hidden = true; say('#pairMsg', '');
      await afterUnlock();
    } catch (e) { say('#pairMsg', 'Pairing failed: ' + codeOf(e), true); }
  });
  $('#unlockForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    say('#unlockMsg', 'Unlocking…');
    const g = lockGen;
    try { await vault.unlock($('#unlockPass').value); $('#unlockPass').value = ''; say('#unlockMsg', ''); await afterUnlock(); }
    catch (e) { if (g !== lockGen) return;
      say('#unlockMsg', e instanceof VaultError && e.code === 'PASSPHRASE_WRONG' ? 'Wrong passphrase.' : 'Unlock failed: ' + codeOf(e), true); }
  });
  $('#wsGo').addEventListener('click', async () => {
    const [p, s] = $('#wsPick').value.split('|');
    try { await selectWorkspace(p, s); show('home'); await status(); await renderRecords(); if (currentOp() !== opsOp) syncOps('workspace'); } catch (e) { say('#wsMsg', 'Could not open workspace: ' + codeOf(e), true); }
  });
  $('#newRec').addEventListener('click', async () => {
    const id = 'R-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 5).toUpperCase();
    current = { id, formId: $('#formNew').value, sourceIds: [] };
    $('#recordId').value = id; $('#formPick').value = current.formId; $('#formPick').disabled = false;
    renderForm(formById(current.formId), null); say('#recordNote', 'New record (not saved yet)'); say('#saveMsg', ''); $('#conflict').hidden = true; show('edit'); scrollTo(0, 0);
  });
  $('#formPick').addEventListener('change', () => { current.formId = $('#formPick').value; renderForm(formById(current.formId), null); });
  $('#records').addEventListener('click', (ev) => { const b = ev.target.closest('[data-open]'); if (b) loadRecord(b.dataset.open).catch((e) => say('#homeMsg', codeOf(e), true)); });
  $('#fields').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-addrow]'); if (!b) return;
    const draft = collect(); draft.counts[b.dataset.addrow] = (draft.counts[b.dataset.addrow] ?? 1) + 1; renderForm(formById(current.formId), draft);
  });
  $('#save').addEventListener('click', saveCurrent);
  $('#back').addEventListener('click', async () => { show('home'); await renderRecords(); });
  $('#keepMine').addEventListener('click', async () => { await ws.resolveConflict(current.id, collect()); await loadRecord(current.id, true); if (navigator.onLine) syncAll('resolve'); });
  $('#syncNow').addEventListener('click', () => syncAll('manual'));
  $('#lock').addEventListener('click', () => lockNow('manual'));
  $('#switchWs').addEventListener('click', async () => { await fillWorkspaces(); show('workspace'); });
  $('#opsRefresh').addEventListener('click', () => syncOps('manual'));
  $('#pairAgain').addEventListener('click', () => { pairAgain().catch(() => {}); });
  $('#extOpen').addEventListener('click', () => { const u = extPending; closeExternal(); if (u && raspHttpsUrl(u)) window.open(u, '_blank', 'noopener,noreferrer'); });
  $('#extCancel').addEventListener('click', closeExternal);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('#extSheet').hidden) closeExternal(); });
  $('#pairCancel').addEventListener('click', () => { $('#pairCancel').hidden = true; $('#pairNote').hidden = true; say('#pairMsg', ''); show('unlock'); say('#unlockMsg', 'Locked.'); });
  $('#tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) { setTab(b.dataset.tab); scrollTo(0, 0); } });
  $('#themeBtn').addEventListener('click', () => applyTheme(document.body.classList.contains('rasp-night') ? 'day' : 'night', true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && vault.unlocked() && navigator.onLine && opsStale(OPS_RESYNC_MS)) syncOps('visible'); });
  autoLock = createAutoLock({ lock: () => vault.lock(), isUnlocked: () => vault.unlocked(), capAt: () => vault.expiresAt(), onLock: (reason) => lockNow(reason) });
  if ('BroadcastChannel' in globalThis) {
    lockChannel = new BroadcastChannel('rsq-lock');
    lockChannel.onmessage = (ev) => { if (ev.data?.type !== 'lock') return; if (vault.unlocked() || autoLock.armed()) lockNow('remote', { broadcast: false }); else vault.lock(); };
  }
  window.addEventListener('online', () => { status(); syncAll('online'); syncOps('online'); });
  window.addEventListener('offline', () => { status(); opsStatus(); rendered.sitrep = -1; if (tab === 'sitrep') renderView('sitrep'); });
  setInterval(() => { if (navigator.onLine && vault.unlocked()) queuedTotal().then((q) => { if (q || photos?.pending()) syncAll('timer'); }).catch(() => {}); }, SYNC_EVERY_MS);
  setInterval(() => { opsStatus(); if (navigator.onLine && vault.unlocked() && opsStale(OPS_RESYNC_MS)) syncOps('timer'); }, SYNC_EVERY_MS);
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); prompt = e; $('#installBtn').hidden = false; });
  $('#installBtn').addEventListener('click', async () => { if (prompt) { await prompt.prompt(); prompt = null; $('#installBtn').hidden = true; } });
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('#iosHint').hidden = !(ios && !standalone);
}

async function boot() {
  [cfg, catalog] = await Promise.all([fetch('config.json').then((r) => r.json()), fetch('catalog.json').then((r) => r.json())]);
  transport = createTransport({ apiBase: cfg.apiBase, device, appRef });
  opsFeed = createOpsFeed({ vault, transport });
  photos = createPwaPhotos({ db, fetcher: createPhotoFetcher({ photo: transport.photo, appRef }), catalog, records: photoRecords,
    onChange: () => { status().catch(() => {}); if (navigator.onLine) syncAll('photo'); },
    say: (t, bad = false) => { say('#photoMsg', t, bad); say('#photoEditMsg', t, bad); } });
  photos.mountTray($('#photoTray'));
  applyTheme(pref.get('theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'), false);
  for (const sel of ['#formNew', '#formPick']) for (const f of catalog.forms) $(sel).append(el('option', { value: f.id }, `${f.id} · ${f.title}`));
  $('#build').textContent = 'build ' + cfg.build;
  wire();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => say('#swMsg', 'Offline install unavailable in this browser.', true));
    let had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) $('#update').hidden = false; had = true; });
  }
  $('#reload').addEventListener('click', () => location.reload());
  show((await vault.exists()) ? 'unlock' : 'pair');
  await status();
}
boot().catch((e) => { document.body.prepend(el('p', { class: 'fatal' }, 'App failed to start: ' + codeOf(e))); });

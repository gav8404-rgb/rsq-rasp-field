// photos-r2 E2 (operator 2026-11-03), offline field app port: "Save TSS to a folder" / "Share TSS file" /
// "Restore from file" for the RSQ RASP home-screen app. Same file format as the Ops Center TSS page (tssExport.mjs,
// schema rasp-tss-export/1, byte-identical module). Everything here reads this device's encrypted store only and never
// calls fetch: the file can be built, saved and shared with no network. Every action is a user tap.
// A restore never saves: it opens the file's answers in the editor as unsaved values; the member reviews and taps Save,
// which is the app's normal local-first save (encrypted on this device first, synced later).
import { buildExport, parseExport, saveToFolder, autosaveToFolder, shareFile, FILE_ENV, EXPORT_LIMIT } from './tssExport.mjs';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KEY_RE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
const MAX_ROWS = 200;

// The app's catalog.json as the model tssExport.mjs reads (form(id), group/field index).
export function catalogModel(raw) {
  const forms = (raw?.forms ?? []).map((f) => ({ id: f.id, title: f.title, sourceSha256: f.source_sha256,
    groups: f.groups.map((g, gi) => ({ index: gi, title: g.title, repeatable: g.repeatable === true, fields: g.fields.map((x, fi) => ({ ...x, index: fi })) })) }));
  const byId = new Map(forms.map((f) => [f.id, f]));
  return { sha256: raw?.catalogSha256 ?? null, forms, form: (id) => byId.get(id) ?? null };
}
const strings = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => KEY_RE.test(k) && typeof v === 'string' && v !== ''));
const counts = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 1));
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Everything of the open workspace on THIS device: each survey's latest local save (sent or not), its status, and the
// values typed in the open editor and not saved yet (as an unsaved draft). Local reads only.
export async function exportData({ db, partition, selected, catalog, editing = null, now = Date.now() }) {
  const p = partition + ':';
  const ids = (await db.keys(p)).map((k) => k.slice(p.length)).filter((id) => !id.startsWith('@') && ID_RE.test(id)).sort();
  const records = [];
  for (const id of ids) {
    const row = await db.get(p + id);
    if (!row) continue;
    const queued = row.queue?.length ?? 0, conflicts = row.conflicts?.length ?? 0, rev = row.head?.revision ?? 0;
    const local = queued || conflicts ? row.draft : rev ? row.head : row.draft;
    const formId = row.draft?.formId ?? row.head?.formId ?? local?.formId;
    if (!catalog.form(formId)) continue;
    const saved = { answers: strings(local?.answers), counts: counts(local?.counts) };
    let draft = null;
    if (editing?.id === id && editing.formId === formId) {
      const d = { answers: strings(editing.answers), counts: counts(editing.counts) };
      if (!same(d.answers, saved.answers)) draft = d;
    }
    if (!rev && !queued && !Object.keys(saved.answers).length && !draft) continue;
    const status = conflicts ? { state: 'refused', at: null, code: 'CONFLICT' } : queued ? { state: 'saved', at: null, code: null } : rev ? { state: 'sent', at: row.head?.createdAt ?? null, code: null } : { state: 'draft', at: null, code: null };
    records.push({ recordId: id, formId, revision: rev, saved, draft, others: {}, status });
  }
  if (editing && ID_RE.test(editing.id ?? '') && !ids.includes(editing.id) && catalog.form(editing.formId)) {
    const answers = strings(editing.answers);
    if (Object.keys(answers).length) records.push({ recordId: editing.id, formId: editing.formId, revision: 0, saved: { answers: {}, counts: {} }, draft: { answers, counts: counts(editing.counts) }, others: {}, status: { state: 'draft', at: null, code: null } });
  }
  return { projectId: selected.projectId, siteId: selected.siteId, generatedAt: new Date(now).toISOString(), catalogSha256: catalog.sha256, records, layout: null, photos: [] };
}
export async function buildFile(ctx) {
  const data = await exportData(ctx);
  const built = buildExport(ctx.catalog, data);
  if (built.bytes > EXPORT_LIMIT) throw Object.assign(new Error('EXPORT_TOO_LARGE'), { code: 'EXPORT_TOO_LARGE' });
  return { built, file: FILE_ENV.makeFile(built.html, built.fileName), records: data.records.length };
}

// "Restore from file": only the open workspace's own file. Returns the surveys of the file with the answers that fit
// their form (keys outside the form, or rows past the limit, are dropped). Nothing is written.
export function restoreItems(text, { selected, catalog }) {
  const d = parseExport(text);
  if (d.projectId !== selected.projectId || d.siteId !== selected.siteId) throw Object.assign(new Error('EXPORT_OTHER_WORKSPACE'), { code: 'EXPORT_OTHER_WORKSPACE' });
  const out = [];
  for (const r of d.records) {
    const form = catalog.form(r.formId);
    if (!form || !ID_RE.test(r.recordId)) continue;
    const want = r.draft ?? r.saved;
    const answers = Object.fromEntries(Object.entries(strings(want.answers)).filter(([k]) => {
      const [, gi, ri, fi] = KEY_RE.exec(k).map(Number), g = form.groups[gi];
      return Boolean(g?.fields[fi]) && (g.repeatable ? ri < MAX_ROWS : ri === 0);
    }));
    const c = Object.fromEntries(Object.entries(counts(want.counts)).filter(([gi]) => form.groups[gi]?.repeatable).map(([gi, n]) => [gi, Math.min(n, MAX_ROWS)]));
    out.push({ recordId: r.recordId, formId: r.formId, title: form.title, answers, counts: c, n: Object.keys(answers).length, unsavedInFile: r.draft != null });
  }
  return { generatedAt: d.generatedAt, items: out };
}

// Labels say what each browser really does (no folder picker outside Chrome/Edge).
export function saveLabel() {
  if (FILE_ENV.hasFolderPicker()) return 'Save TSS to a folder';
  if (FILE_ENV.isIOS()) return 'Save TSS to Files (share sheet)';
  return 'Download TSS file';
}
const HOW = {
  folder: (r, f) => `Saved to the folder "${r.folder}" as ${f}. Each later save on this device updates a copy there.`,
  share: (r, f) => `Handed to the share sheet: ${f}.`,
  download: (r, f) => `Downloaded ${f} to this browser's download location.`,
  cancelled: () => 'Cancelled. Nothing was saved.',
};

// Wires the buttons. `app` gives the app's state: db, partition(), selected(), catalog(), editing(), openFromFile(item),
// say(text, bad).
export function wireTssFile(app, $) {
  const folderKey = () => 'field-app|' + app.partition();
  const ready = () => app.selected() && app.catalog();
  $('#tssSave').textContent = saveLabel();
  let busy = false;
  const run = (fn) => async () => {
    if (busy) return;
    if (!ready()) { app.say('Open a workspace first.', true); return; }
    busy = true;
    try { await fn(); } catch (e) { app.say('TSS file not saved: ' + (e?.code ?? e?.name ?? 'ERROR'), true); } finally { busy = false; }
  };
  const ctx = () => ({ db: app.db, partition: app.partition(), selected: app.selected(), catalog: app.catalog(), editing: app.editing() });
  $('#tssSave').addEventListener('click', run(async () => {
    const { file, records } = await buildFile(ctx());
    const r = await saveToFolder(file, folderKey());
    app.say((HOW[r.how] ?? HOW.download)(r, file.name) + (r.how === 'cancelled' ? '' : ` (${records} survey${records === 1 ? '' : 's'}; CONFIDENTIAL, contains PII)`));
  }));
  $('#tssShare').addEventListener('click', run(async () => {
    const { file, records } = await buildFile(ctx());
    const r = await shareFile(file, file.name);
    if (r.how === 'share') app.say(`Shared ${file.name} (${records} survey${records === 1 ? '' : 's'}). No connection was needed.`);
    else if (r.how === 'download') app.say(`This browser cannot share files: downloaded ${file.name} instead; share it from your downloads.`);
    else if (r.how === 'needs-tap') app.say('Tap "Share TSS file" again to open the share sheet.', true);
    else app.say(HOW.cancelled());
  }));
  $('#tssRestore').addEventListener('click', () => { if (!ready()) { app.say('Open a workspace first.', true); return; } $('#tssRestoreFile').value = ''; $('#tssRestoreFile').click(); });
  $('#tssRestoreFile').addEventListener('change', async () => {
    const f = $('#tssRestoreFile').files?.[0], list = $('#tssRestoreList');
    list.replaceChildren();
    if (!f) return;
    try {
      const { items, generatedAt } = restoreItems(await f.text(), { selected: app.selected(), catalog: app.catalog() });
      app.say(`File from ${String(generatedAt).slice(0, 16).replace('T', ' ')}Z: ${items.length} survey${items.length === 1 ? '' : 's'}. Open one, review, then tap Save. Nothing is saved until you do.`);
      for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ghost';
        b.textContent = `Open from file: ${it.recordId} · ${String(it.title ?? it.formId).slice(0, 50)} (${it.n} answer${it.n === 1 ? '' : 's'})`;
        b.addEventListener('click', () => { app.openFromFile(it).catch((e) => app.say('Could not open: ' + (e?.code ?? e?.message ?? 'ERROR'), true)); });
        const li = document.createElement('li'); li.append(b); list.append(li);
      }
    } catch (e) { app.say('Not restored: ' + (e?.code ?? 'EXPORT_FILE_INVALID'), true); }
  });
}
// After each local save: the folder copy, only into a folder already chosen and still permitted (no prompt).
export async function autosaveCopy(app) {
  if (!app.selected() || !app.catalog()) return null;
  try { const { file } = await buildFile({ db: app.db, partition: app.partition(), selected: app.selected(), catalog: app.catalog(), editing: null }); return await autosaveToFolder(file, 'field-app|' + app.partition()); }
  catch { return null; }
}

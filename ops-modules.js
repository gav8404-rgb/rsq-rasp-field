const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = u => (typeof u === 'string' && /^https:\/\/(docs|drive)\.google\.com\//.test(u)) ? u : null;
const shackled = false;
const lockedText = 'Locked. Unlock to show operation data.';
const raspDefaultTz = 'UTC';
var raspTheme = 'day';
function raspIsApple() {
  const n = typeof navigator !== 'undefined' ? navigator : {};
  return /iPad|iPhone|iPod/.test(n.userAgent || '') || (n.platform === 'MacIntel' && n.maxTouchPoints > 1);
}
const RASP_DIR_RE = /^https:\/\/(?:maps\.apple\.com\/\?daddr=[^"'<>\s&]+&dirflg=d|www\.google\.com\/maps\/dir\/\?api=1&destination=[^"'<>\s&]+)$/;
function raspDirUrl(q) {
  const s = String(q || '').slice(0, 300).trim();
  if (!s) return null;
  const u = raspIsApple() ? 'https://maps.apple.com/?daddr=' + encodeURIComponent(s) + '&dirflg=d' : 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(s);
  return RASP_DIR_RE.test(u) ? u : null;
}
function raspTelHref(t) {
  const raw = String(t || '').trim(), plus = raw.startsWith('+'), d = raw.replace(/\D/g, '');
  if (raw.includes('%')) return null;
  return /^\d{3,15}$/.test(d) ? 'tel:' + (plus ? '+' : '') + d : null;
}
const RASP_TEL_RE = /^tel:\+?[0-9][0-9 ().-]{1,30}$/i;
function raspHttpsUrl(h) {
  try { const u = new URL(h); return u.protocol === 'https:' && !u.username && !u.password && u.hostname ? u.href : null; } catch (e) { return null; }
}
function raspConopSanitize(html) {
  if (typeof DOMParser !== 'function') return '<!doctype html><html><body></body></html>';
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('template, [shadowrootmode], [shadowroot]').forEach((n) => n.remove());
  doc.querySelectorAll('iframe, frame, frameset, object, embed, applet, portal, link, meta, base, form, area, script, foreignObject, set, animate, animateMotion, animateTransform').forEach((n) => n.remove());
  doc.querySelectorAll('use, image, feImage').forEach((n) => {
    const h = (n.getAttribute('href') || n.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').trim();
    if (h && !h.startsWith('#')) n.remove();
  });
  const XL = 'http://www.w3.org/1999/xlink', HTMLNS = 'http://www.w3.org/1999/xhtml';
  const cssNorm = (t) => String(t).replace(/\r\n?|\f/g, '\n');
  const cssDecode = (t) => cssNorm(t).replace(/\\([0-9a-fA-F]{1,6})\s?/g, (m, x) => { try { return String.fromCodePoint(parseInt(x, 16)); } catch (e) { return ''; } }).replace(/\\(.)/g, '$1');
  const cssFetch = (t) => /url\s*\(|image-set\s*\(|@import|\bsrc\s*\(/i.test(cssDecode(t));
  const cssClean = (t) => { if (String(t).includes('\\')) return null; const c = cssNorm(t).replace(/@import[^;]*;?/gi, '').replace(/url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, 'none'); return cssFetch(c) ? null : c; };
  doc.querySelectorAll('style').forEach((n) => { const c = cssClean(n.textContent); if (c === null) n.remove(); else n.textContent = c; });
  doc.querySelectorAll('*').forEach((n) => {
    const isA = n.namespaceURI === HTMLNS && n.localName === 'a', localRef = /^(use|image|feImage)$/.test(n.localName);
    for (const at of [...n.attributes]) {
      const name = at.name.toLowerCase(), v = at.value.trim();
      if (at.value.includes('\\')) { n.removeAttributeNode(at); continue; }
      if (name === 'href' || (at.namespaceURI === XL && at.localName === 'href') || name === 'xlink:href') { if (!isA && !(localRef && v.startsWith('#'))) n.removeAttributeNode(at); continue; }
      if (name === 'src' || name === 'srcset' || name === 'srcdoc' || name === 'poster' || name === 'background' || name === 'lowsrc' || name === 'dynsrc') { n.removeAttributeNode(at); continue; }
      if (name === 'style') { const c = cssClean(at.value); if (c === null) n.removeAttributeNode(at); else at.value = c; continue; }
      if (/url\s*\(\s*["']?\s*[^#\s"')]|image-set\s*\(|@import/i.test(cssDecode(v))) n.removeAttributeNode(at);
    }
  });
  doc.querySelectorAll('a').forEach((a) => {
    const h = (a.getAttribute('href') || '').trim();
    const keep = (attr, v) => {
      const b = doc.createElement('a');
      b.setAttribute(attr, v); b.setAttribute('role', 'link'); b.setAttribute('tabindex', '0');
      if (a.getAttribute('class')) b.setAttribute('class', a.getAttribute('class'));
      b.textContent = a.textContent; a.replaceWith(b);
    };
    if (/^#[A-Za-z0-9_-]*$/.test(h) && a.hasAttribute('href')) { ['target', 'download', 'ping', 'rel'].forEach((x) => a.removeAttribute(x)); return; }
    if (RASP_TEL_RE.test(h)) return keep('data-rasp-tel', h);
    const u = /^https:\/\//i.test(h) ? raspHttpsUrl(h) : null;
    if (u) return keep('data-rasp-ext', u);
    a.replaceWith(doc.createTextNode(a.textContent));
  });
  return '<!doctype html>' + doc.documentElement.outerHTML;
}

/* ---- rasp-board.js (pinned fe2b8128, r2 host patches, comments stripped) ---- */

const RB_MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const RB_TYPES = ['site', 'rally', 'lodging', 'hospital', 'police', 'airport', 'other'];
const RB_TYPE_LABEL = { site: 'Site', rally: 'Rally point', lodging: 'Lodging', hospital: 'Hospital', police: 'Police', airport: 'Airport', other: 'Point' };
const RB_EMBED_RE = /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=[-\d.%C]+&layer=mapnik(&marker=[-\d.%C]+)?$/;
const RB_GMAP_RE = /^https:\/\/www\.google\.com\/maps\/(search|dir)\/\?api=1&/;
const RB_CLOSED_RE = /^(complete|completed|done|closed|reported|cancel+ed|historical record|historical proposal)$/i;
const RB_SEC_RE = /\(\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\s*\)|^\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b[\s:·/\u2010\u2011\u2013\u2014-]*|\b[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\s*:\s*|(?<!\s)\s*[·/|]\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b/g;
let rb_timer = 0;

const rb_arr = (v) => Array.isArray(v) ? v : [];
const rb_obj = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const rb_str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').replace(RB_SEC_RE, '').trim();
const rb_embedOk = (u) => typeof u === 'string' && RB_EMBED_RE.test(u) ? u : null;
const rb_gmapOk = (u) => typeof u === 'string' && RB_GMAP_RE.test(u) ? u : null;
const rb_digits = (t) => { const d = rb_str(t).replace(/[^+\d]/g, ''); return d.replace(/\D/g, '').length >= 3 ? d : ''; };
const RB_CLEAN_MAX = 2000;
const RB_TBD_RE = /\b(?:address\s+)?TBD\b/gi, RB_FILL1 = /[\s,;:·–-]/, RB_WS1 = /\s/;
function rb_cap(s) {
  if (s.length <= RB_CLEAN_MAX) return s;
  let n = RB_CLEAN_MAX - 1; const c = s.charCodeAt(n - 1); if (c >= 0xd800 && c <= 0xdbff) n--;
  return s.slice(0, n) + '…';
}
function rb_brackets(s) {
  const out = [], st = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i), k = c === ')' ? '(' : c === ']' ? '[' : '';
    if (c === '(' || c === '[') { st.push(out.length); out.push(c); continue; }
    if (k) {
      if (st.length && out[st[st.length - 1]] === k) { out.length = st.pop(); continue; }
      out.push(c); st.length = 0; continue;
    }
    out.push(c);
    if (st.length && !(out[st[st.length - 1]] === '(' ? RB_FILL1 : RB_WS1).test(c)) st.length = 0;
  }
  return out.join('');
}
function rb_clean(v) {
  const s0 = rb_cap(rb_str(v)).replace(RB_TBD_RE, ''), s1 = rb_brackets(s0);
  const s = s1 === s0 ? s1 : rb_brackets(s1.replace(RB_TBD_RE, ''));
  return s.replace(/\s{2,}/g, ' ').replace(/^[\s,;:·–-]+|(?<![\s,;:·–-])[\s,;:·–-]+$/g, '').trim();
}
const RB_GENERIC_OWNER_RE = /^(?:site|main|main line|phone|tel|telephone|office|reception|switchboard|desk|front desk|general|line)$|\b(?:main line|switchboard|reception|front desk|general enquir\w*)\b/i;
function rb_owner(o, type, label) {
  const ok = (v) => { const s = rb_clean(v); return /[A-Za-z]/.test(s) && !/@/.test(s) && !RB_GENERIC_OWNER_RE.test(s) ? s : ''; };
  return ok(o.phoneOwner) || ok(o.contact);
}
const rb_phone = (tel, owner) => owner && rb_digits(tel) ? { phone: rb_str(tel), phoneOwner: owner } : { phone: '', phoneOwner: '' };
const rb_telText = (e) => e.phone ? e.phone + (e.phoneOwner ? ' · ' + e.phoneOwner : '') : '';
const rb_pad = (n) => (n < 10 ? '0' : '') + n;
const rb_n2 = (n) => n < 10 ? '0' + n : String(n);
const rb_isDate = (d) => Object.prototype.toString.call(d) === '[object Date]' && !isNaN(d.getTime());

function rb_tz(D) {
  const tz = rb_str(D && D.meta && D.meta.timezone);
  if (!tz) return '';
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return tz; } catch (e) { return ''; }
}
function rb_wallS(now, tz) {
  const d = rb_isDate(now) ? now : new Date();
  try {
    const o = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };
    if (tz) o.timeZone = tz;
    const p = {}; new Intl.DateTimeFormat('en-CA', o).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day + 'T' + (p.hour === '24' ? '00' : p.hour) + ':' + p.minute + ':' + p.second;
  } catch (e) {
    return d.getFullYear() + '-' + rb_pad(d.getMonth() + 1) + '-' + rb_pad(d.getDate()) + 'T' + rb_pad(d.getHours()) + ':' + rb_pad(d.getMinutes()) + ':' + rb_pad(d.getSeconds());
  }
}
const rb_wall = (now, tz) => rb_wallS(now, tz).slice(0, 16);
const rb_utc = (now) => (rb_isDate(now) ? now : new Date()).toISOString().slice(11, 19) + 'Z';
function rb_normWall(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(rb_str(v));
  if (!m) return '';
  return m[4] ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}
const rb_mins = (w) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(w); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN; };
function rb_until(nowWall, atWall) {
  const diff = rb_mins(atWall) - rb_mins(nowWall);
  if (!Number.isFinite(diff)) return '';
  if (diff <= 0) return 'now';
  const d = Math.floor(diff / 1440), h = Math.floor((diff % 1440) / 60), m = Math.floor(diff % 60);
  return 'in ' + (d ? d + 'd ' + h + 'h' : h ? h + 'h ' + rb_pad(m) + 'm' : m + 'm');
}
function rb_fmtDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day || ''); if (!m) return '';
  return +m[3] + ' ' + Object.keys(RB_MON)[+m[2] - 1] + ' ' + m[1];
}
const rb_shortDay = (day) => rb_fmtDay(day).replace(/ \d{4}$/, '');

function rb_timelineDates(e) {
  const year = Number(rb_str(e.year)); if (!year) return null;
  const m = /^(\d{1,2})(?:\s+([A-Za-z]{3}))?(?:\s*[–-]\s*(\d{1,2})(?:\s+([A-Za-z]{3}))?)?$/.exec(rb_str(e.date));
  if (!m) return null;
  const m1 = RB_MON[(m[2] || m[4] || '').toUpperCase()], m2 = RB_MON[(m[4] || m[2] || '').toUpperCase()];
  if (!m1 || !m2) return null;
  const s = `${year}-${rb_pad(m1)}-${rb_pad(+m[1])}`, en = `${m2 < m1 ? year + 1 : year}-${rb_pad(m2)}-${rb_pad(+(m[3] || m[1]))}`;
  return { start: s + 'T00:00', end: en + 'T23:59' };
}
function rb_items(D) {
  const out = [];
  rb_arr(D.schedule).forEach((e) => {
    if (!rb_obj(e)) return;
    const s = rb_normWall(e.start); if (!s) return;
    const allDay = s.length === 10, en = rb_normWall(e.end);
    out.push({ start: allDay ? s + 'T00:00' : s, end: en ? (en.length === 10 ? en + 'T23:59' : en) : (allDay ? s + 'T23:59' : ''), allDay,
      title: rb_str(e.title), lead: rb_str(e.lead), location: rb_str(e.location), placeId: rb_str(e.placeId), note: rb_str(e.notes), status: rb_str(e.status) });
  });
  if (!out.length) rb_arr(D.sitrep && D.sitrep.days).forEach((d) => {
    if (!rb_obj(d)) return;
    const s = rb_normWall(d.date); if (!s) return;
    const day = s.slice(0, 10);
    out.push({ start: day + 'T00:00', end: day + 'T23:59', allDay: true, title: rb_str(d.title), lead: rb_str(d.lead), location: rb_str(d.location), placeId: '', note: rb_str(d.note), status: '' });
  });
  if (!out.length) rb_arr(D.timeline && D.timeline.events).forEach((e) => {
    if (!rb_obj(e)) return;
    const r = rb_timelineDates(e); if (!r) return;
    out.push({ start: r.start, end: r.end, allDay: true, title: rb_str(e.title), lead: rb_str(e.lead), location: rb_str(e.location), placeId: '', note: rb_str(e.detail), status: '' });
  });
  out.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  out.forEach((it, i) => {
    if (it.end) return;
    const nxt = out.slice(i + 1).find((o) => o.start > it.start), eod = it.start.slice(0, 10) + 'T23:59';
    it.end = nxt && nxt.start < eod ? nxt.start : eod;
  });
  return out;
}
function rb_nowNext(items, nowWall) {
  const active = items.filter((it) => it.start <= nowWall && nowWall < it.end);
  const timed = active.filter((it) => !it.allDay);
  const now = (timed.length ? timed : active).slice(-1)[0] || null;
  const next = items.find((it) => it.start > nowWall && it !== now) || null;
  return { now, next, active };
}


function rb_type(v) {
  const s = rb_str(v).toLowerCase();
  if (RB_TYPES.includes(s)) return s;
  if (/hospital|medical|\bmed\b|clinic|a&e|emergency room/.test(s)) return 'hospital';
  if (/rally|muster|assembly|\brv\b/.test(s)) return 'rally';
  if (/police|garda|gendarm|constab/.test(s)) return 'police';
  if (/hotel|lodg|accommodation|billet/.test(s)) return 'lodging';
  if (/airport|airfield|aerodrome/.test(s)) return 'airport';
  if (/site|target|venue|objective|facility/.test(s)) return 'site';
  return 'other';
}
function rb_names(label, type) {
  const i = label.indexOf(' · '), pre = i > 0 ? label.slice(0, i).trim() : '', rest = i > 0 ? label.slice(i + 3).trim() : '';
  if (!pre || !rest) return { name: label, kind: RB_TYPE_LABEL[type] };
  return { name: rest, kind: rb_type(pre) === type ? pre : RB_TYPE_LABEL[type] + ' · ' + pre };
}
const rb_short = (name) => name.replace(/\s*\([^()]*\)\s*$/, '') || name;
function rb_split(v) {
  const s = rb_str(v), m = /\bsources?\s*:\s*/i.exec(s);
  if (!m) return { text: s, cites: [] };
  const cites = [], tail = s.slice(m.index + m[0].length); let depth = 0, cur = '';
  for (const ch of tail) {
    depth += ch === '(' ? 1 : ch === ')' && depth > 0 ? -1 : 0;
    if (ch === ';' && depth === 0) { cites.push(cur); cur = ''; } else cur += ch;
  }
  cites.push(cur);
  return { text: s.slice(0, m.index).trim(), cites: cites.map((c) => c.trim().replace(/\.$/, '')).filter(Boolean) };
}
function rb_place(o, i, idp, label0, type0, addr, tel, hours, notes, extraCites) {
  const label = rb_clean(label0); if (!label) return null;
  const ty = rb_type(type0 || label0), nm = rb_names(label, ty), n = rb_split(notes);
  const lat = Number(o.lat), lon = Number(o.lon);
  const geo = o.lat != null && o.lon != null && o.lat !== '' && o.lon !== '' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const hrs = rb_clean(hours), ed = ty === 'hospital' && /\b24\s*\/\s*7\b|\b24\s*hours?\b|\b24h\b/i.test([label, hrs, n.text].join(' '));
  return { id: rb_str(o.id) || idp + i, type: ty, label, name: nm.name, kind: nm.kind, short: rb_short(nm.name), address: rb_clean(addr), ...rb_phone(tel, rb_owner(o, ty, label)),
    open: ed ? '24/7 ED' : hrs, text: n.text, cites: n.cites.concat(extraCites || []), lat: geo ? lat : null, lon: geo ? lon : null };
}
function rb_points(D, today) {
  const pts = [], seen = new Map();
  const add = (p) => { if (!p) return; const k = p.label.toLowerCase(); if (seen.has(k)) { const q = seen.get(k); p.cites.forEach((c) => { if (!q.cites.includes(c)) q.cites.push(c); }); return; } seen.set(k, p); pts.push(p); };
  rb_arr(D.places).forEach((p, i) => {
    if (!rb_obj(p)) return;
    const days = rb_arr(p.days).map(rb_normWall).filter(Boolean);
    if (days.length && !days.includes(today)) return;
    add(rb_place(p, i, 'place-', p.label, p.type, p.address, p.phone, p.hours, p.notes));
  });
  rb_arr(D.sitrep && D.sitrep.addresses).forEach((a, i) => {
    if (!rb_obj(a)) return;
    add(rb_place({ ...a, lat: null, lon: null }, i, 'addr-', a.label, a.type, a.value, a.tel, '', '', rb_split('Source: ' + rb_str(a.source)).cites));
  });
  if (!pts.some((p) => p.type === 'lodging')) rb_arr(D.lodging).forEach((h, i) => {
    if (!rb_obj(h)) return;
    add(rb_place({ ...h, lat: null, lon: null }, i, 'lodging-', h.name, 'lodging', h.address || h.small, h.phone, h.checkIn, ''));
  });
  pts.sort((a, b) => RB_TYPES.indexOf(a.type) - RB_TYPES.indexOf(b.type));
  return pts;
}
function rb_km(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function rb_fromSite(p, pts) {
  if (p.type === 'site' || p.lat == null) return '';
  let best = null, km = null;
  pts.filter((s) => s.type === 'site' && s.lat != null).forEach((s) => { const k = rb_km(s, p); if (km === null || k < km) { km = k; best = s; } });
  return best ? km.toFixed(1) + ' km from ' + best.short + ' (straight line)' : '';
}
const RB_SOS = new Set(['112', '999', '911', '000', '110', '113', '115', '118', '119', '122', '133', '144', '155', '190', '192', '193']);
function rb_emergency(D, pts) {
  const out = [], take = (n) => { if (RB_SOS.has(n) && !out.includes(n)) out.push(n); };
  const m = D.meta && D.meta.emergency;
  (Array.isArray(m) ? m : [m]).forEach((v) => { const s = rb_str(v); if (/^\d{3}$/.test(s)) take(s); });
  if (!out.length) pts.forEach((p) => {
    for (const c of p.text.split(/[.;](?:\s|$)/)) { const e = /emergenc/i.exec(c); if (e) (c.slice(e.index).match(/\b\d{3}\b/g) || []).forEach(take); }
  });
  return out;
}
const rb_q = (p) => p.lat != null ? rb_fix(p.lat) + ',' + rb_fix(p.lon) : [p.name, p.address].filter(Boolean).join(', ');
const rb_dir = (p) => (typeof raspDirUrl === 'function' && raspDirUrl(rb_q(p))) || rb_gmapOk('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(rb_q(p)));
const rb_fix = (n) => Number(n).toFixed(5);

const RB_TILE = 256, RB_ZMIN = 2, RB_ZMAX = 18, RB_ZFIT = 16, RB_ZPLACE = 14;
const RB_TILE_RE = /^https:\/\/tile\.openstreetmap\.org\/\d{1,2}\/\d{1,6}\/\d{1,6}\.png$/;
const RB_MAPS = new WeakMap();
let rb_mem = null;
function rb_world(lat, lon, z) {
  const s = RB_TILE * Math.pow(2, z), sn = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return [(lon + 180) / 360 * s, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * s];
}
function rb_tileUrl(z, x, y) {
  if (![z, x, y].every(Number.isInteger)) return null;
  const u = 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png';
  return RB_TILE_RE.test(u) ? u : null;
}
function rb_ll(s) {
  const v = String(s || '').split(',').map(Number);
  return v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? v : null;
}
function rb_box(g) {
  const lats = g.map((p) => p.lat), lons = g.map((p) => p.lon);
  return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
}
function rb_parseBox(s) {
  const v = String(s || '').split(',').map(Number);
  return v.length === 4 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[2]) <= 90 && Math.abs(v[1]) <= 180 && Math.abs(v[3]) <= 180 && v[0] <= v[2] && v[1] <= v[3] ? v : null;
}
function rb_fit(box, w, h, pad) {
  for (let z = RB_ZFIT; z >= RB_ZMIN; z--) {
    const a = rb_world(box[2], box[1], z), b = rb_world(box[0], box[3], z);
    if ((b[0] - a[0] <= w - pad[1] - pad[3] && b[1] - a[1] <= h - pad[0] - pad[2]) || z === RB_ZMIN)
      return { z, cx: (a[0] + b[0]) / 2 - (pad[3] - pad[1]) / 2, cy: (a[1] + b[1]) / 2 - (pad[0] - pad[2]) / 2 };
  }
  return null;
}
function rb_alerts(D, today) {
  const open = rb_arr(D.tasks).filter((t) => rb_obj(t) && !t.historyOnly && !RB_CLOSED_RE.test(rb_str(t.status)));
  const flagged = open.some((t) => 'priority' in t || 'blocking' in t);
  const due = (t) => { const d = rb_normWall(t.due).slice(0, 10); return d && d <= today ? d : ''; };
  return open.filter((t) => due(t) && (!flagged || t.blocking === true || /^(high|critical|urgent|p0|p1)$/i.test(rb_str(t.priority))))
    .sort((a, b) => due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : 0)
    .map((t) => ({ title: rb_str(t.title), owner: rb_str(t.owner), due: due(t) }));
}
function rb_feeds(D, now) {
  const src = rb_arr(rb_obj(D.raspProfile) && D.raspProfile.sources).filter(rb_obj);
  const find = (re) => { const s = src.find((x) => re.test(rb_str(x.adapter) + ' ' + rb_str(x.name))); return s ? (rb_str(s.state) || rb_str(s.status)) : ''; };
  return [{ label: 'TAK / CoT', state: find(/\b(tak|cot)\b/i) }, { label: 'Signals', state: rb_sigState(D, now) || find(/signal|nomad|kismet|sentinel|\brf\b/i) }];
}
function rb_sigState(D, now) {
  const S = rb_obj(D.signals);
  if (!S || S.schema !== 'rasp-signals-summary/1') return '';
  const t = typeof S.relayedAt === 'string' ? Date.parse(S.relayedAt) : NaN, n = rb_isDate(now) ? now.getTime() : Date.now();
  return Number.isFinite(t) && n - t <= 15 * 60000 ? 'relayed' : 'stale';
}
function rb_signals(D, now, shk) {
  if (typeof raspSignalsV2 !== 'function' || D.signals == null) return '';
  let h = '';
  try { h = raspSignalsV2(D, now, { shackled: shk }); } catch (e) { h = ''; }
  return typeof h === 'string' && h ? `<div class="rb-sig" id="rb-signals">${h}</div>` : '';
}

function rb_header(D, meta, tz, now, shk) {
  const project = rb_str(meta.project), label = '';
  const fresh = (rb_obj(meta.freshness) && rb_str(meta.freshness.state)) || rb_str(meta.snapshotLabel) || rb_str(meta.status).toUpperCase();
  const stale = /stale|fail/i.test(rb_str(meta.status));
  const ws = rb_wallS(now, tz);
  return `<div class="rb-top" role="banner"><div class="rb-brand"><span class="rb-logo" aria-hidden="true"><i></i></span><span class="rb-word">RASP</span><div class="rb-brandtx"><h1 class="rb-h1">${esc(project || 'RASP')}</h1><small class="rb-sub">COMMON OPERATING PICTURE</small></div></div>` +
    `<div class="rb-topmeta">${fresh ? `<span class="rb-badge${stale ? ' rb-warn' : ''}">${esc(fresh)}</span>` : ''}${shk ? '<span class="rb-badge rb-warn">SHACKLE ON</span>' : ''}${label ? `<small class="rb-node">${esc(label)}</small>` : ''}` +
    `<div class="rb-clock" role="timer" aria-label="Operation local time and UTC"><span class="rb-lt"><b data-rb-lt>${esc(ws.slice(11))}</b> <small>${esc(tz || 'device time')}</small></span><span class="rb-utc">${esc(rb_fmtDay(ws.slice(0, 10)))} · <span data-rb-utc>${esc(rb_utc(now))}</span></span></div></div></div>`;
}
function rb_blockRow(hits, today) {
  if (!hits.length) return '';
  const rows = hits.slice(0, 5).map((t) => `<li class="rb-blk"><b>${esc(t.title || '—')}</b><span>${t.due < today ? 'OVERDUE ' + esc(rb_shortDay(t.due)) : 'DUE TODAY'}${t.owner ? ' · ' + esc(t.owner) : ''}</span></li>`).join('');
  return `<section class="rb-block" aria-label="Blocking alerts"><span class="rb-eyebrow rb-amber">Blocking · ${esc(rb_n2(hits.length))}</span><ul class="rb-blist">${rows}</ul>${hits.length > 5 ? `<span class="rb-mini">+${hits.length - 5} more</span>` : ''}</section>`;
}
const RB_VEH_RE = /\b(?:rental|hire|hired|shared|pool|team)?\s*(?:car|van|minibus|bus|suv|truck|4x4|vehicle)\b/i;
function rb_vehLine(v) {
  const desc = rb_clean(v.desc), plate = rb_clean(v.plate);
  let kind = rb_clean(v.kind || v.type);
  if (!kind) { const m = desc.length <= 40 && !/[(;]/.test(desc) ? null : RB_VEH_RE.exec(desc); kind = m ? m[0].replace(/^(shared|pool|team)\s+/i, '').trim() : desc; }
  kind = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : '';
  let where = rb_clean(v.pickup || v.location);
  if (!where) { const m = /\(([^()]{0,200}\b\d{1,2}:\d{2}[^()]{0,200})\)/.exec([rb_str(v.small), rb_str(v.desc)].join(' ')); where = m ? m[1] : ''; }
  where = where.replace(/\s+in the\s+/gi, ', ').replace(/\b(?:hall|daily|terminal building)\b/gi, '').replace(/\s+,/g, ',').replace(/,\s*(?=\d{1,2}:\d{2})/g, ' ').replace(/\s{2,}/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '');
  const b = rb_str(v.badge) + ' ' + rb_str(v.status);
  const status = /not confirmed|unconfirmed|estimate|pending|tbc/i.test(b) ? 'unconfirmed' : /confirmed|booked/i.test(b) ? 'confirmed' : '';
  return [kind, plate && plate !== kind ? plate : '', where, status].filter(Boolean).join(' · ');
}
function rb_travelSec(D, today, shk) {
  const v = rb_obj(D.vehicle), line = v ? rb_vehLine(v) : '';
  if (!line) return '';
  if (shk) return '<section class="rb-section rb-trav" aria-label="Vehicle"><p class="rb-shk">SHACKLE · VEHICLE HIDDEN</p></section>';
  return `<section class="rb-section rb-trav" aria-label="Vehicle"><span class="rb-veh">${esc(line)}</span></section>`;
}
function rb_healthSec(meta, feeds) {
  const st = rb_str(meta.status).toUpperCase() || 'UNKNOWN', ok = st === 'OK';
  const row = (l, v, cls) => `<div class="rb-src"><span>${esc(l)}</span><span class="${cls}">${esc(v)}</span></div>`;
  return `<section class="rb-section rb-health" aria-label="Source health"><div class="rb-eyebrow">Source health</div>${row('Payload', st, ok ? 'rb-ok' : 'rb-amber')}` +
    feeds.map((f) => row(f.label, f.state ? f.state.toUpperCase() : 'NOT CONNECTED', f.state && !/stale|error|fail|pending/i.test(f.state) ? 'rb-ok' : 'rb-amber')).join('') + '</section>';
}
const RB_VIEWS = [
  { id: 'map', label: 'COP MAP', attrs: [['data-action', 'go'], ['data-arg', '-1']], need: '#nav [data-page="-1"]' },
  { id: 'sitrep', label: 'SITREP', attrs: [['data-action', 'go'], ['data-arg', '0']], need: '#nav [data-page="0"]' },
  { id: 'conop', label: 'CONOP', attrs: [['data-rasp-pane', 'conop']], need: '#nav [data-rasp-pane="conop"]' },
  { id: 'tss', label: 'TSS / FIELD', attrs: [['data-rasp-pane', 'tss']], need: '#nav [data-rasp-pane="tss"]' },
];
const rb_activeView = (pane, page) => pane === 'data' ? (page === -1 ? 'map' : page === 0 ? 'sitrep' : '') : pane === 'conop' || pane === 'tss' ? pane : '';
function raspBoardV2Tabs(doc, pane, page, shk) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d || typeof d.createElement !== 'function' || typeof d.querySelector !== 'function') return null;
  const main = d.querySelector('main'); if (!main) return null;
  let bar = d.querySelector('#rb-viewtabs');
  if (!bar) {
    bar = d.createElement('div'); bar.setAttribute('id', 'rb-viewtabs'); bar.setAttribute('class', 'rb rb-viewtabs');
    bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Views');
    main.insertBefore(bar, main.firstChild || null);
    bar.addEventListener('click', (ev) => {
      const tg = ev.target && ev.target.closest ? ev.target : null; if (!tg) return;
      if (tg.closest('[data-rb-more]')) { rb_menu(d, !rb_menuOpen(d)); return; }
      const b = tg.closest('[data-rb-jump]'), t = b && d.querySelector('#view .rb-sig');
      if (t && typeof t.scrollIntoView === 'function') t.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }
  while (bar.firstChild) bar.removeChild(bar.firstChild);
  const cur = rb_activeView(pane, page);
  const add = (label, attrs, on, cls) => {
    const b = d.createElement('button'); b.setAttribute('type', 'button'); b.setAttribute('class', 'rb-tab' + (on ? ' rb-on' : '') + (cls ? ' ' + cls : ''));
    attrs.forEach((a) => b.setAttribute(a[0], a[1])); if (on) b.setAttribute('aria-current', 'page');
    b.textContent = label; bar.appendChild(b);
  };
  RB_VIEWS.forEach((v) => { if (d.querySelector(v.need)) add(v.label, v.attrs, v.id === cur); });
  if (cur === 'map' && !shk && d.querySelector('#view .rb-sig')) add('SIGNALS', [['data-rb-jump', 'signals']], false);
  const side = d.querySelector(RB_SIDE);
  if (side) {
    if (!side.getAttribute('id')) side.setAttribute('id', 'rb-sheet');
    add('⋯', [['data-rb-more', '1'], ['aria-label', 'More controls'], ['aria-haspopup', 'dialog'], ['aria-controls', side.getAttribute('id')], ['aria-expanded', String(rb_menuOpen(d))]], false, 'rb-more');
  }
  bar.hidden = !bar.firstChild;
  return bar;
}
const RB_SIDE = '.shell aside';
function rb_menuOpen(d) { return !!(d && d.documentElement && d.documentElement.classList && d.documentElement.classList.contains('rb-menu-open')); }
function rb_menu(d, on) {
  const side = d && d.querySelector(RB_SIDE), root = d && d.documentElement;
  if (!side || !root || !root.classList) return false;
  on = !!on;
  root.classList.toggle('rb-menu-open', on);
  let scrim = d.querySelector('#rb-scrim');
  if (on && !scrim && d.body) { scrim = d.createElement('div'); scrim.setAttribute('id', 'rb-scrim'); scrim.setAttribute('class', 'rb-scrim'); d.body.appendChild(scrim); }
  if (scrim) scrim.hidden = !on;
  const more = d.querySelector('#rb-viewtabs [data-rb-more]');
  if (more) more.setAttribute('aria-expanded', String(on));
  if (on) {
    side.setAttribute('role', 'dialog'); side.setAttribute('aria-label', 'Controls');
    const first = [...side.querySelectorAll('button')].find((b) => !b.disabled && !b.hidden && (typeof b.getClientRects !== 'function' || b.getClientRects().length > 0));
    if (first && typeof first.focus === 'function') first.focus();
  } else { side.removeAttribute('role'); side.removeAttribute('aria-label'); }
  return on;
}
function rb_menuClicks(d, ev) {
  if (!rb_menuOpen(d)) return;
  const t = ev && ev.target && ev.target.closest ? ev.target : null; if (!t) return;
  const side = d.querySelector(RB_SIDE), ctl = t.closest('button,a');
  if (t.closest('#rb-scrim') || (ctl && side && side.contains(ctl))) rb_menu(d, false);
}
function rb_menuKeys(d, ev) {
  if (!rb_menuOpen(d) || !ev || ev.key !== 'Escape') return;
  rb_menu(d, false);
  const more = d.querySelector('#rb-viewtabs [data-rb-more]'); if (more && typeof more.focus === 'function') more.focus();
}
function raspBoardV2HostHook() {
  if (typeof raspShow !== 'function' || raspShow.rbTabs) return false;
  const prev = raspShow;
  raspShow = function (pane) {
    prev(pane);
    if (typeof document !== 'undefined' && rb_menuOpen(document)) rb_menu(document, false);
    raspBoardV2Tabs(null, pane, typeof currentPage !== 'undefined' ? currentPage : -1, typeof shackled !== 'undefined' && !!shackled);
  };
  raspShow.rbTabs = true;
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', (ev) => rb_menuClicks(document, ev));
    document.addEventListener('keydown', (ev) => rb_menuKeys(document, ev));
  }
  return true;
}
const RB_MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function rb_day(d, withYear) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? +m[3] + ' ' + RB_MONS[+m[2] - 1] + (withYear ? ' ' + m[1] : '') : ''; }
function rb_opName(meta) {
  const project = rb_str(meta.project);
  const name = [rb_str(meta.opName), rb_str(meta.opLabel), rb_str(meta.projectLabel)].find((v) => v && !/workbook|snapshot/i.test(v)) || '';
  return !name ? project : project && !name.includes(project) ? project + ' · ' + name : name;
}
function rb_opDates(meta, today) {
  const a = rb_normWall(meta.opStart).slice(0, 10), b = rb_normWall(meta.opEnd).slice(0, 10);
  const day = (x) => Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)) / 864e5;
  if (a.length === 10 && b.length === 10 && a <= b) {
    const span = a === b ? rb_day(a, true) : rb_day(a, a.slice(0, 4) !== b.slice(0, 4)) + ' – ' + rb_day(b, true);
    const n = day(today) - day(a) + 1, tot = day(b) - day(a) + 1;
    return span + (today >= a && today <= b ? ' · Day ' + n + ' of ' + tot : '');
  }
  return a.length === 10 ? 'From ' + rb_day(a, true) : rb_day(today, true);
}
function rb_stagehead(meta, today, note) {
  const name = rb_opName(meta);
  return `<div class="rb-stagehead">${name ? `<h2 class="rb-h2">${esc(name)}</h2>` : ''}<div class="rb-mini">${esc(rb_opDates(meta, today))}</div>${note ? `<div class="rb-mini">${esc(note)}</div>` : ''}</div>`;
}

function rb_card(p, i, shk, ctx) {
  const dir = shk ? null : rb_dir(p), dist = rb_fromSite(p, ctx.pts);
  const li = (k, v) => v ? `<li class="rb-c-${k}">${v}</li>` : '';
  const phone = !shk && p.phone ? (raspTelHref(p.phone) ? `<a class="rb-tel" href="${esc(raspTelHref(p.phone))}"><b>${esc(p.phone)}</b></a>` : `<b>${esc(p.phone)}</b>`) + ` · ${esc(p.phoneOwner)}` : '';
  const cites = ctx.staff && !shk && p.cites.length;
  return `<section class="rb-card" data-rb-card="${i}" hidden aria-label="${esc(p.name)}"><div class="rb-chead"><span class="rb-sym rb-t-${esc(p.type)}" aria-hidden="true"></span>` +
    `<div class="rb-ctitle"><h3 class="rb-cname">${esc(p.name)}</h3><small class="rb-ctype">${esc(p.kind)}</small></div><button type="button" class="rb-cclose" data-rb-close aria-label="Close">×</button></div>` +
    `<ul class="rb-clines">${li('noll', ctx.geo && p.lat == null ? 'Location not set' : '')}${li('addr', esc(p.address))}${li('tel', phone)}${li('open', esc(p.open))}${li('dist', esc(dist))}` +
    `${li('sos', ctx.sos.length ? 'Emergency ' + ctx.sos.map((n) => raspTelHref(n) ? `<a class="rb-tel rb-sos" href="${esc(raspTelHref(n))}"><b>${esc(n)}</b></a>` : `<b>${esc(n)}</b>`).join(' / ') : '')}</ul>` +
    (dir || cites ? `<div class="rb-cfoot">${dir ? `<a class="rb-plink" target="_blank" rel="noopener" href="${esc(dir)}">Directions</a>` : ''}${cites ? `<button type="button" class="rb-srcbtn" data-rb-src="${i}" aria-expanded="false">source</button>` : ''}</div>` : '') +
    (cites ? `<ul class="rb-cites" data-rb-cites="${i}" hidden>${p.cites.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '') + '</section>';
}
function rb_stage(D, pts, shk, today) {
  const meta = rb_obj(D.meta) || {}, staff = meta.role === 'full';
  const g = shk ? [] : pts.filter((p) => p.lat != null);
  const box = g.length ? rb_box(g) : null;
  const embed = !box && !shk ? (rb_arr(D.sitrep && D.sitrep.maps).find((x) => rb_obj(x) && x.kind === 'map' && rb_embedOk(x.embed)) || {}).embed || null : null;
  const geo = !!box, mode = geo || embed ? 'rb-geo' : 'rb-schem';
  const ctx = { pts, staff, sos: rb_emergency(D, pts), geo };
  const ll = (p) => geo ? (p.lat != null ? ` data-rb-ll="${esc(rb_fix(p.lat) + ',' + rb_fix(p.lon))}"` : ' data-rb-noll') : '';
  const pins = g.map((p) => `<button type="button" class="rb-pin rb-t-${esc(p.type)}" data-rb-sel="${pts.indexOf(p)}"${ll(p)} aria-pressed="false" aria-label="${esc(p.name + ', ' + p.kind)}" title="${esc(p.name)}"><span class="rb-sym" aria-hidden="true"></span></button>`).join('');
  const map = geo ? `<div class="rb-map" data-rb-map data-rb-fit="${esc(box.map((n) => Number(n).toFixed(6)).join(','))}"><div class="rb-tiles" aria-hidden="true"></div><div class="rb-pins" role="group" aria-label="Places on the map">${pins}</div></div>`
    : embed ? `<iframe class="rb-frame" title="Operation map" src="${esc(embed)}" referrerpolicy="no-referrer" loading="lazy"></iframe>` : '';
  const finds = pts.length ? '<ul class="rb-finds" aria-label="Places">' +
    pts.map((p, i) => `<li><button type="button" class="rb-find" data-rb-find data-rb-sel="${i}"${ll(p)} aria-pressed="false" title="${esc(p.name)}"><span class="rb-sym rb-t-${esc(p.type)}" aria-hidden="true"></span><span class="rb-findname">${esc(p.short)}</span></button></li>`).join('') + '</ul>' : '';
  const note = shk ? '' : geo || embed ? '' : 'No coordinates in this snapshot';
  const zoom = geo ? '<div class="rb-zoom" role="group" aria-label="Zoom"><button type="button" data-rb-zoom="in" aria-label="Zoom in">＋</button><button type="button" data-rb-zoom="out" aria-label="Zoom out">−</button><button type="button" data-rb-zoom="home" aria-label="Show all places">↺</button></div>' : '';
  const attr = geo ? '<div class="rb-attr"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a></div>' : '';
  const cards = pts.length ? `<div class="rb-cards">${pts.map((p, i) => rb_card(p, i, shk, ctx)).join('')}</div>` : '';
  const body = map ? `<div class="rb-mapbox">${map}${cards}${zoom}${attr}</div>` : cards;
  return `<section class="rb-stage ${mode}" aria-label="Map">${rb_stagehead(meta, today, note)}${body}${finds}</section>`;
}
function rb_timelineSec(items, nowWall, pts) {
  const today = nowWall.slice(0, 10);
  const nn = rb_nowNext(items, nowWall);
  const loc = (it) => it.location || (it.placeId ? ((pts.find((x) => x.id === it.placeId) || {}).label || '') : '');
  const state = (it) => it.status || (it === nn.now ? 'Now' : nn.active.includes(it) ? 'Active' : it === nn.next ? 'Next' : it.end <= nowWall ? 'Past' : 'Later');
  const when = (it) => {
    const d = it.start.slice(0, 10), pre = d !== today ? rb_shortDay(d) + ' · ' : '';
    if (!it.allDay) return pre + it.start.slice(11);
    return it.end.slice(0, 10) !== d ? rb_shortDay(d) + '–' + rb_shortDay(it.end) : pre + 'ALL DAY';
  };
  const sel = Math.max(0, items.indexOf(nn.now) >= 0 ? items.indexOf(nn.now) : items.indexOf(nn.next) >= 0 ? items.indexOf(nn.next) : items.length - 1);
  const detail = (it, i) => {
    const nx = items[i + 1];
    return [it.title || '—', state(it), it.lead ? 'Lead ' + it.lead : '', loc(it), it.note, nx ? 'Next: ' + (nx.title || '—') : ''].filter(Boolean).join(' · ');
  };
  const cards = items.map((it, i) => `<button type="button" class="rb-ev${it === nn.now ? ' rb-now' : ''}${it.end <= nowWall && it !== nn.now ? ' rb-past' : ''}" data-rb-ev="${i}" aria-pressed="${i === sel}" data-rb-detail="${esc(detail(it, i))}">` +
    `<b>${esc(when(it))} · ${esc(it.title || '—')}</b><small>${esc([loc(it), state(it)].filter(Boolean).join(' / '))}</small></button>`).join('');
  const ctx = items.map((it, i) => `<dl class="rb-tlctx" data-rb-ctx="${i}" hidden><dt>Window</dt><dd>${esc(it.allDay ? when(it) : rb_fmtDay(it.start) + ' ' + it.start.slice(11) + (it.end ? '–' + (it.end.slice(0, 10) === it.start.slice(0, 10) ? it.end.slice(11) : rb_shortDay(it.end) + ' ' + it.end.slice(11)) : ''))}</dd>` +
    (it.lead ? `<dt>Lead</dt><dd>${esc(it.lead)}</dd>` : '') + (loc(it) ? `<dt>Location</dt><dd>${esc(loc(it))}</dd>` : '') + `<dt>State</dt><dd>${esc(state(it))}</dd>` + (it.note ? `<dt>Notes</dt><dd>${esc(it.note)}</dd>` : '') + '</dl>').join('');
  const cd = nn.next ? `<span class="rb-cd">NEXT <b data-rb-at="${esc(nn.next.start)}">${esc(rb_until(nowWall, nn.next.start))}</b></span>` : '';
  if (!items.length) return `<section class="rb-tl rb-tlempty" aria-label="Operational timeline"><div class="rb-tltitle"><h2 class="rb-h3">OPERATIONAL TIMELINE</h2></div><p class="rb-mini">No schedule in this snapshot.</p></section>`;
  return `<section class="rb-tl" id="rb-timeline" aria-label="Operational timeline"><div class="rb-tltitle"><h2 class="rb-h3">OPERATIONAL TIMELINE <span class="rb-chan">/ ${esc(rb_fmtDay(today))}</span></h2>${cd}` +
    `<span class="rb-tlbtns"><button type="button" data-rb-details aria-expanded="false">Details</button><button type="button" data-rb-scroll="-1" aria-label="Earlier milestones">‹</button><button type="button" data-rb-scroll="1" aria-label="Later milestones">›</button></span></div>` +
    `<div class="rb-tlscroll" role="group" aria-label="Scrollable milestones">${cards}</div><div class="rb-tldetail" data-rb-tldetail aria-live="polite">${esc(detail(items[sel], sel))}</div><div class="rb-tlctxs">${ctx}</div></section>`;
}
function rb_footer(meta, project) {
  const fetched = rb_str(meta.fetchedAt) || rb_str(meta.lastSuccessAt), badge = rb_obj(meta.freshness) && rb_str(meta.freshness.state);
  return `<div class="rb-foot" role="contentinfo">${badge ? '' : `<span><span class="rb-sdot">●</span> ${fetched ? 'SNAPSHOT ' + esc(fetched) : 'SNAPSHOT TIME UNKNOWN'}</span>`}<span>RASP COP · ${esc(project || 'OPERATION')}</span></div>`;
}

function raspBoardV2(D, now, opts) {
  if (!rb_obj(D)) return '';
  const o = rb_obj(opts) || {};
  const shk = 'shackled' in o ? !!o.shackled : (typeof shackled !== 'undefined' && !!shackled);
  const meta = rb_obj(D.meta) || {}, tz = rb_tz(D), nowWall = rb_wall(now, tz), today = nowWall.slice(0, 10);
  const pts = rb_points(D, today);
  const sig = rb_signals(D, now, shk);
  return `<article class="rb" aria-label="${esc(rb_str(meta.project))} RASP common operating picture" data-rb-tz="${esc(tz)}">${rb_header(D, meta, tz, now, shk)}` +
    `<div class="rb-cols"><div class="rb-strip">${rb_healthSec(meta, rb_feeds(D, now))}${rb_travelSec(D, today, shk)}</div>` +
    `<div class="rb-main">${rb_stage(D, pts, shk, today)}${sig}</div></div>${rb_footer(meta, rb_str(meta.project))}</article>`;
}

let rb_ro = null;
const rb_narrow = (rootEl) => { const b = rootEl.querySelector('.rb'); const w = b && b.clientWidth; return typeof w === 'number' && w > 0 && w < 700; };
function rb_draw(st) {
  const m = st.el, w = m.clientWidth || 0, h = m.clientHeight || 0;
  if (!w || !h || !st.z) return;
  const n = Math.pow(2, st.z), x0 = st.cx - w / 2, y0 = st.cy - h / 2, want = new Set();
  const mk = typeof document !== 'undefined' && document && typeof document.createElement === 'function' && st.tiles && typeof st.tiles.appendChild === 'function';
  if (mk) for (let ty = Math.floor(y0 / RB_TILE); ty <= Math.floor((y0 + h) / RB_TILE); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / RB_TILE); tx <= Math.floor((x0 + w) / RB_TILE); tx++) {
      const k = st.z + '/' + tx + '/' + ty; let img = st.imgs.get(k);
      if (!img) {
        const u = rb_tileUrl(st.z, ((tx % n) + n) % n, ty); if (!u) continue;
        img = document.createElement('img');
        img.setAttribute('alt', ''); img.setAttribute('draggable', 'false'); img.setAttribute('decoding', 'async');
        img.setAttribute('referrerpolicy', 'strict-origin');
        img.className = 'rb-tile';
        if (typeof img.addEventListener === 'function') img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
        img.setAttribute('src', u); st.tiles.appendChild(img); st.imgs.set(k, img);
      }
      want.add(k); img.style.transform = 'translate(' + Math.round(tx * RB_TILE - x0) + 'px,' + Math.round(ty * RB_TILE - y0) + 'px)';
    }
  }
  st.imgs.forEach((img, k) => { if (!want.has(k)) { if (typeof img.remove === 'function') img.remove(); st.imgs.delete(k); } });
  st.pins.forEach((p) => { const xy = rb_world(p.ll[0], p.ll[1], st.z); if (p.el.style) p.el.style.transform = 'translate(' + Math.round(xy[0] - x0) + 'px,' + Math.round(xy[1] - y0) + 'px)'; });
  rb_mem = { ...(rb_mem && rb_mem.key === st.key ? rb_mem : { key: st.key }), z: st.z, cx: st.cx, cy: st.cy, w };
}
function rb_home(st, rootEl) {
  const m = st.el, w = m.clientWidth || 0, h = m.clientHeight || 0;
  if (!w || !h) { st.z = 0; return; }
  const pad = [36, 64, 40, 36];
  const f = rb_fit(st.box, w, h, pad);
  if (f) { st.z = f.z; st.cx = f.cx; st.cy = f.cy; }
  rb_draw(st);
}
function rb_mapBind(rootEl) {
  const m = rootEl.querySelector('[data-rb-map]'); if (!m) return null;
  const box = rb_parseBox(m.getAttribute('data-rb-fit')); if (!box) return null;
  let st = RB_MAPS.get(m);
  if (st) return st;
  st = { el: m, box, key: m.getAttribute('data-rb-fit'), z: 0, cx: 0, cy: 0, tiles: m.querySelector('.rb-tiles'), imgs: new Map(), pins: [] };
  m.querySelectorAll('.rb-pin').forEach((el) => { const ll = rb_ll(el.getAttribute('data-rb-ll')); if (ll) st.pins.push({ el, ll }); });
  RB_MAPS.set(m, st);
  if (typeof m.addEventListener === 'function') {
    let drag = null;
    m.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || !st.z || (e.target && e.target.closest && e.target.closest('button,a'))) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      try { if (typeof m.setPointerCapture === 'function') m.setPointerCapture(e.pointerId); } catch (x) {   }
    });
    m.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      st.cx -= e.clientX - drag.x; st.cy = Math.min(Math.max(st.cy - (e.clientY - drag.y), 0), RB_TILE * Math.pow(2, st.z));
      drag.x = e.clientX; drag.y = e.clientY; rb_draw(st);
    });
    const end = () => { drag = null; };
    m.addEventListener('pointerup', end); m.addEventListener('pointercancel', end);
  }
  if (rb_ro) rb_ro.disconnect();
  rb_ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (m.isConnected === false) return; if (!st.z) rb_home(st, rootEl); else rb_draw(st); }) : null;
  if (rb_ro) rb_ro.observe(m);
  return st;
}
function rb_centre(st, ll, rootEl, zoom) {
  if (!st || !st.z) return;
  if (zoom) st.z = Math.max(st.z, RB_ZPLACE);
  else if (!rb_narrow(rootEl)) return;
  const xy = rb_world(ll[0], ll[1], st.z), h = st.el.clientHeight || 0;
  st.cx = xy[0]; st.cy = xy[1] + (rb_narrow(rootEl) ? h * 0.3 : 0);
  rb_draw(st);
}
function rb_select(rootEl, sel, attr, idx) {
  rootEl.querySelectorAll(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === idx)));
}
function rb_open(rootEl, i) {
  rb_select(rootEl, '[data-rb-sel]', 'data-rb-sel', i);
  let open = null;
  rootEl.querySelectorAll('[data-rb-card]').forEach((c) => { c.hidden = c.getAttribute('data-rb-card') !== i; if (!c.hidden) open = c; });
  if (rb_mem) rb_mem.sel = i;
  return open;
}
function rb_onClick(rootEl, ev) {
  const t = ev.target && ev.target.closest ? ev.target : null;
  if (!t) return;
  const hit = (s) => { const e = t.closest(s); return e && rootEl.contains(e) ? e : null; };
  const m = rootEl.querySelector('[data-rb-map]'), st = m ? RB_MAPS.get(m) : null;
  let e;
  if ((e = hit('[data-rb-sel]'))) {
    const i = e.getAttribute('data-rb-sel');
    const card = rb_open(rootEl, i);
    const ll = rb_ll(e.getAttribute('data-rb-ll'));
    if (m && ll) rb_centre(st, ll, rootEl, !e.classList.contains('rb-pin'));
    else if (m && st) rb_home(st, rootEl);
    if (e.hasAttribute('data-rb-find')) {
      const box = rootEl.querySelector('.rb-mapbox') || card;
      if (box && typeof box.scrollIntoView === 'function') box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return;
  }
  if ((e = hit('[data-rb-close]'))) {
    rb_select(rootEl, '[data-rb-sel]', 'data-rb-sel', '');
    rootEl.querySelectorAll('[data-rb-card]').forEach((c) => { c.hidden = true; });
    if (rb_mem) rb_mem.sel = null;
    return;
  }
  if ((e = hit('[data-rb-src]'))) {
    const i = e.getAttribute('data-rb-src'), on = e.getAttribute('aria-expanded') !== 'true';
    e.setAttribute('aria-expanded', String(on));
    rootEl.querySelectorAll('[data-rb-cites]').forEach((c) => { if (c.getAttribute('data-rb-cites') === i) c.hidden = !on; });
    return;
  }
  if ((e = hit('[data-rb-zoom]'))) {
    if (!st || !st.z) return;
    const z = e.getAttribute('data-rb-zoom');
    if (z === 'home') { rb_home(st, rootEl); return; }
    const nz = Math.min(Math.max(st.z + (z === 'in' ? 1 : -1), RB_ZMIN), RB_ZMAX), k = Math.pow(2, nz - st.z);
    st.z = nz; st.cx *= k; st.cy *= k; rb_draw(st);
    return;
  }
  if ((e = hit('[data-rb-jump]'))) {
    const target = rootEl.querySelector('.rb-sig');
    if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}
function raspBoardV2Bind(rootEl, D) {
  if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
  if (!rootEl.hasAttribute('data-rb-bound')) {
    rootEl.setAttribute('data-rb-bound', '1');
    rootEl.addEventListener('click', (ev) => rb_onClick(rootEl, ev));
  }
  if (typeof raspSignalsV2Bind === 'function') raspSignalsV2Bind(rootEl, D);
  const st0 = rootEl.querySelector('[data-rb-map]');
  const mem = st0 && rb_mem && rb_mem.key === st0.getAttribute('data-rb-fit') ? rb_mem : null;
  const st = rb_mapBind(rootEl);
  if (st) {
    if (mem && mem.z && mem.w === (st.el.clientWidth || 0)) { st.z = mem.z; st.cx = mem.cx; st.cy = mem.cy; rb_draw(st); } else rb_home(st, rootEl);
  }
  if (!st0) rb_mem = null;
  if (mem && mem.sel != null && rootEl.querySelector('[data-rb-card="' + mem.sel + '"]')) rb_open(rootEl, mem.sel);
  if (rb_timer) clearInterval(rb_timer);
  const tz = rb_tz(D);
  const tick = () => {
    const board = rootEl.querySelector('.rb');
    if (!board || rootEl.isConnected === false) { clearInterval(rb_timer); rb_timer = 0; return; }
    if (rootEl.hidden) return;
    const n = new Date(), ws = rb_wallS(n, tz);
    const lt = board.querySelector('[data-rb-lt]'), ut = board.querySelector('[data-rb-utc]');
    if (lt) lt.textContent = ws.slice(11);
    if (ut) ut.textContent = rb_utc(n);
    board.querySelectorAll('[data-rb-at]').forEach((el) => { el.textContent = rb_until(ws.slice(0, 16), el.getAttribute('data-rb-at')); });
  };
  rb_timer = setInterval(tick, 1000);
}

/* ---- sitrep.js (pinned f1395445, r2 host patches, comments stripped) ---- */
const SR_BUCKETS = [
  { id: 'morning', label: 'MORNING', quick: 'AM', from: 0, to: 12 },
  { id: 'afternoon', label: 'AFTERNOON', quick: 'PM', from: 12, to: 17 },
  { id: 'evening', label: 'EVENING', quick: 'EVE', from: 17, to: 24 },
];
const SR_QUICK = [{ id: 'all', label: 'ALL', from: 0, to: 24 }].concat(SR_BUCKETS.map((b) => ({ id: b.id, label: b.quick, from: b.from, to: b.to })));
const SR_MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SR_WDAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const SR_MAX_SPAN = 400;
const SR_STRIP_MAX = 61;
const SR_WORD_TIMES = [
  [/^(early\s+am|early\s+morning|early)$/i, 300], [/^(am|morning|a\.m\.)$/i, 480], [/^(midday|noon|lunch)$/i, 720],
  [/^(pm|afternoon|p\.m\.)$/i, 840], [/^(evening|eve|end of day|eod|cob)$/i, 1080], [/^(night|late|overnight|ron)$/i, 1260],
];
const sr_state = { day: null, from: 0, to: 24 };
let sr_ctx = { D: null, rerender: null };
const sr_bound = new WeakSet();

const sr_isIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && sr_utcToIso(sr_isoToUtc(s)) === s;
const sr_str = (v) => (v == null ? '' : String(v));
const sr_arr = (v) => (Array.isArray(v) ? v : []);
const sr_pad = (n) => (n < 10 ? '0' : '') + n;
const sr_hhmm = (m) => sr_pad(Math.floor(m / 60)) + sr_pad(m % 60);
function sr_safeUrl(u) {
  if (typeof safeUrl === 'function') return safeUrl(u);
  return typeof u === 'string' && /^https:\/\/(docs|drive)\.google\.com\//.test(u) ? u : null;
}
const sr_mapUrl = (u) => (typeof u === 'string' && /^https:\/\/www\.google\.com\/maps\/(search|dir)\/\?api=1&/.test(u) ? u : sr_safeUrl(u));
const sr_embedUrl = (u) => (typeof u === 'string' && /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=[-\d.%C]+&layer=mapnik(&marker=[-\d.%C]+)?$/.test(u) ? u : null);
function sr_link(url, label, cls) { const u = sr_mapUrl(url); return u ? `<a class="${cls || 'sr-link'}" target="_blank" rel="noopener" href="${esc(u)}">${esc(label)} ↗</a>` : esc(label); }

function sr_isoToUtc(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function sr_utcToIso(t) { const d = new Date(t); return d.getUTCFullYear() + '-' + sr_pad(d.getUTCMonth() + 1) + '-' + sr_pad(d.getUTCDate()); }
function sr_dayHead(iso) { const d = new Date(sr_isoToUtc(iso)); return sr_pad(d.getUTCDate()) + ' ' + SR_MON[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' (' + SR_WDAY[d.getUTCDay()] + ')'; }
function sr_dm(iso) { const [, m, d] = iso.split('-').map(Number); return { d, mon: SR_MON[m - 1], y: Number(iso.slice(0, 4)) }; }
function sr_tzOk(tz) { if (typeof tz !== 'string' || !tz.trim()) return false; try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (e) { return false; } }
function sr_tz(D) {
  const m = (D && D.meta) || {}, s = (D && D.sitrep) || {};
  const hit = [m.timezone, m.tz, s.timezone].find(sr_tzOk);
  if (hit) return hit;
  let host = null; try { host = typeof raspDefaultTz === 'string' ? raspDefaultTz : null; } catch (e) { host = null; }
  return sr_tzOk(host) ? host : 'UTC';
}
function sr_zoned(now, tz) {
  const t = now && typeof now.getTime === 'function' && !isNaN(now.getTime()) ? new Date(now.getTime()) : new Date();
  try {
    const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(t).forEach((x) => { p[x.type] = x.value; });
    return { date: p.year + '-' + p.month + '-' + p.day, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
  } catch (e) { return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes() }; }
}
function sr_parseTime(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = /T(\d{2}):(\d{2})/.exec(s) || /^(\d{1,2}):?(\d{2})\s*[A-Z]?$/i.exec(s);
  if (m) { const h = Number(m[1]), mi = Number(m[2]); if ((h < 24 && mi < 60) || (h === 24 && mi === 0)) return { min: h * 60 + mi, label: sr_hhmm(h * 60 + mi), word: false }; }
  for (const [re, min] of SR_WORD_TIMES) if (re.test(s)) return { min, label: s.toUpperCase(), word: true };
  return null;
}

function sr_schedule(D) {
  return sr_arr(D.schedule).concat(sr_arr(D.sitrep && D.sitrep.schedule), sr_arr(D.conop && D.conop.schedule)).filter((x) => x && typeof x === 'object');
}
function sr_places(D) {
  const map = {};
  sr_arr(D.places).concat(sr_arr(D.sitrep && D.sitrep.places)).forEach((p) => { if (p && p.id != null) map[String(p.id)] = p; });
  return map;
}
function sr_window1(list, center, n) {
  if (list.length <= n) return list;
  let i = center ? list.findIndex((d) => d >= center) : 0; if (i < 0) i = list.length - 1;
  const from = Math.max(0, Math.min(list.length - n, i - Math.floor(n / 2)));
  return list.slice(from, from + n);
}
function sr_bounds(D) {
  const m = D.meta || {}, r = m.dates || {};
  let a = [m.opStart, m.startDate, r.start].find(sr_isoToOk), b = [m.opEnd, m.endDate, r.end].find(sr_isoToOk);
  if (!a || !b) {
    const all = sr_arr(D.sitrep && D.sitrep.days).map((d) => d && d.date).concat(sr_schedule(D).map((e) => e.date), sr_timelineIsos(D)).filter(sr_isIso).sort();
    if (!all.length) return null;
    a = all[0]; b = all[all.length - 1];
    if ((sr_isoToUtc(b) - sr_isoToUtc(a)) / 864e5 > SR_MAX_SPAN) return { list: Array.from(new Set(all)) };
  }
  return b < a ? { a: b, b: a } : { a, b };
}
function sr_isOpDay(D, iso) {
  if (!D || typeof D !== 'object' || !sr_isIso(iso)) return false;
  const k = sr_bounds(D);
  return !!k && (k.list ? k.list.indexOf(iso) >= 0 : iso >= k.a && iso <= k.b);
}
function sr_center(D, st, z) {
  if (st && st.day != null && sr_isOpDay(D, st.day)) return st.day;
  if (st && st === sr_state && st.day != null) sr_state.day = null;
  return z.date;
}
function sr_days(D, center) {
  const cap = SR_MAX_SPAN + 1, c = sr_isIso(center) ? center : null, k = sr_bounds(D);
  if (!k) return [];
  if (k.list) return sr_window1(k.list, c, cap);
  const a = k.a, b = k.b;
  let t0 = sr_isoToUtc(a); const end = sr_isoToUtc(b), n = Math.round((end - t0) / 864e5) + 1;
  if (n > cap && c) { const ci = Math.round((sr_isoToUtc(c) - t0) / 864e5); t0 += Math.max(0, Math.min(n - cap, ci - Math.floor(cap / 2))) * 864e5; }
  const out = []; for (let t = t0; t <= end && out.length < cap; t += 864e5) out.push(sr_utcToIso(t));
  return out;
}
function sr_isoToOk(s) { return sr_isIso(s); }
function sr_tlRange(e) {
  const y = Number(e && e.year); if (!y) return null;
  const s = sr_str(e.date).toUpperCase().replace(/\s+/g, ' ').trim();
  const mo = (x) => SR_MON.indexOf(x) + 1, iso = (d, mm) => y + '-' + sr_pad(mm) + '-' + sr_pad(d);
  let m = /^(\d{1,2}) ([A-Z]{3})$/.exec(s);
  if (m && mo(m[2])) return [iso(+m[1], mo(m[2])), iso(+m[1], mo(m[2]))];
  m = /^(\d{1,2})(?: ([A-Z]{3}))? ?[–—-] ?(\d{1,2}) ([A-Z]{3})$/.exec(s);
  if (m && mo(m[4])) return [iso(+m[1], mo(m[2] || m[4])), iso(+m[3], mo(m[4]))];
  return null;
}
function sr_timelineIsos(D) { const o = []; sr_arr(D.timeline && D.timeline.events).forEach((e) => { const r = sr_tlRange(e); if (r) o.push(r[0], r[1]); }); return o; }
function sr_ev(o) {
  const st = sr_parseTime(o.start), en = sr_parseTime(o.end);
  let s = st ? st.min : null, e = en && st ? en.min : null;
  if (s != null && e != null && e <= s) e = 1440;
  return { s, e, timeLabel: st ? st.label : /^\d{4}-\d{2}-\d{2}$/.test(sr_str(o.start)) ? '' : sr_str(o.start).toUpperCase(), endLabel: en && st ? en.label : '', title: sr_tidy(o.title), place: o.place || null,
    lead: sr_str(o.lead), status: sr_str(o.status), note: sr_note(o.note), src: o.src };
}
function sr_events(D, iso) {
  const sd = sr_arr(D.sitrep && D.sitrep.days).find((d) => d && d.date === iso);
  const plan = sd && (sd.title || sd.note) ? [sr_ev({ start: '', title: sr_noSec(sd.title) || 'Day plan', lead: '', status: '', note: sr_noSec(sd.note), src: 'dayplan' })] : [];
  plan.forEach((e) => { e.timeLabel = 'DAY PLAN'; });
  return plan.concat(sr_eventIndex(D)(iso));
}
function sr_eventIndex(D) {
  const places = sr_places(D), sched = sr_schedule(D);
  const place = (x) => {
    const p = x.placeId != null ? places[String(x.placeId)] : null;
    const label = sr_str((p && (p.label || p.name)) || x.location || x.place || '');
    return label ? { label, url: (p && p.mapUrl) || x.mapUrl || null } : null;
  };
  const group = (rows, key) => { const g = new Map(); rows.forEach((x) => { const k = key(x); if (k == null) return; if (!g.has(k)) g.set(k, []); g.get(k).push(x); }); return g; };
  if (sched.length) {
    const by = group(sched, (x) => (typeof x.date === 'string' ? x.date : null));
    return (iso) => (by.get(iso) || []).map((x) => sr_ev({ start: x.start, end: x.end, title: x.title, place: place(x), lead: x.lead, status: x.status, note: x.note, src: 'schedule' }));
  }
  const fl = group(sr_arr((D.flights && D.flights.segments) || []).filter(Boolean), (g) => sr_str(g.date).toUpperCase().trim());
  const tl = sr_arr(D.timeline && D.timeline.events).map((e) => ({ e, r: sr_tlRange(e) })).filter((x) => x.r);
  return (iso) => {
    const out = [], dm = sr_dm(iso), tag = sr_pad(dm.d) + ' ' + dm.mon;
    (fl.get(tag) || []).forEach((g) => {
      out.push(sr_ev({ start: g.fromTime, end: g.toTime, title: [g.flight, sr_str(g.from) + ' → ' + sr_str(g.to)].filter(Boolean).join(' · '), lead: '', status: g.status, note: g.note, src: 'flights' }));
    });
    tl.forEach(({ e, r }) => {
      if (iso < r[0] || iso > r[1]) return;
      const single = r[0] === r[1], tm = single ? /(?:^|\b(?:from|at|@)\s*)([01]\d|2[0-3])([0-5]\d)\b/i.exec(sr_str(e.detail)) : null;
      out.push(sr_ev({ start: tm ? tm[1] + tm[2] : (single ? '' : 'ONGOING'), title: e.title, lead: '', status: '', note: e.detail, src: 'timeline' }));
    });
    return out;
  };
}
function sr_sort(a, b) { return (a.s - b.s) || ((a.e == null ? a.s : a.e) - (b.e == null ? b.s : b.e)) || a.title.localeCompare(b.title); }
function sr_bucket(min) { return SR_BUCKETS.find((b) => min >= b.from * 60 && min < b.to * 60) || SR_BUCKETS[SR_BUCKETS.length - 1]; }
function sr_inWindow(ev, from, to) {
  if (ev.s == null) return true;
  const e = ev.e == null ? ev.s + 1 : ev.e;
  return ev.s < to * 60 && e > from * 60;
}
function sr_window(state) {
  let f = Math.max(0, Math.min(23, Math.floor(Number(state && state.from) || 0)));
  let t = Math.max(1, Math.min(24, Math.floor(Number(state && state.to)))); if (!(t > 0)) t = 24;
  if (t <= f) t = Math.min(24, f + 1);
  return { from: f, to: t };
}
function sr_defaultDay(days, today) { return days.indexOf(today) >= 0 ? today : days.find((d) => d > today) || days[0] || null; }
function sr_pickDay(days, st, z) { return st && days.indexOf(st.day) >= 0 ? st.day : sr_defaultDay(days, z.date); }
function sr_statusCls(s) {
  return /done|complete|closed|arrived|landed/i.test(s) ? 'sr-st-done' : /cancel|abort|fail|delay|denied/i.test(s) ? 'sr-st-bad'
    : /confirm|booked|on ?time|ok|ready|green/i.test(s) ? 'sr-st-ok' : /pending|tbd|tentative|planned|unconfirmed|hold/i.test(s) ? 'sr-st-warn' : '';
}

function sr_nowEv(timed, z) {
  let n = null;
  timed.forEach((e) => { if (e.s <= z.min && (e.e == null || z.min < e.e) && (!n || e.s >= n.s)) n = e; });
  return n;
}

const SR_SEC_RE = /\(\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\s*\)|^\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b[\s:·/\u2010\u2011\u2013\u2014-]*|\b[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\s*:\s*|(?<!\s)\s*[·/|]\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b/g;
const SR_STRIP_LINES = 3;
const SR_PROV_RE = /coordinates from|snapshot|workbook|recorded in|source row|reconcil/i;
const SR_NOISE_RE = /\b(historical receipt|receipt supplied|vendor state not refreshed|not refreshed|from the (snapshot|workbook)|recorded in the|source row|reconcil\w*|coordinates from)\b/i;
const SR_ADMIN_OWNER_RE = /^(RSO Master|System|Automation|Bot)$/i;
const SR_ANCHOR_TOK = /^(?:[Ss][-\u2010\u2011\u2013\u2014\uFF0D][1-8]|D\d[-\u2013]D\d(?:\.(?:xlsx|txt|md|csv))?|EX\d{2,4}|\x52BCS[-\u2013]\x4CIM[-\u2013]\d{2,5})$/;
const SR_SUB_TOK = /^(?:LOGS|T[-\u2013]\d|D\d|Q\d|RD\d{1,3}|[A-Z]{1,3}\d{1,4}(?::[A-Z]{1,3}\d{1,4})?|\d{1,5})$/;
function sr_codes(v) {
  return String(v).replace(/\(([^()]*)\)/g, (m, inner) => {
    const toks = inner.split(/[\s/,;·]+/).filter(Boolean);
    if (!toks.some((t) => SR_ANCHOR_TOK.test(t))) return m;
    const keep = inner.split(/[;,]/).map((g) => g.split(/([\s/]+)/).filter((x) => !(SR_ANCHOR_TOK.test(x) || (SR_SUB_TOK.test(x) && /[A-Za-z]/.test(x)))).join('').replace(/^[\s/]+|(?<![\s/])[\s/]+$/g, '')).filter((g) => /[A-Za-z0-9]/.test(g));
    return keep.length ? '(' + keep.join(inner.includes(';') ? '; ' : ', ') + ')' : '';
  });
}
const SR_META_TASK_RE = /source coverage|folder organi[sz]ation/i;
const SR_TIDY_MAX = 2000;
const SR_LEAD_Y = /\s*[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b[\s:·/\u2010\u2011\u2013\u2014-]*/y;
const SR_EMPTY_PAIR = /^\([\s,;:·–-]*\)$/, SR_WS1 = /\s/;
function sr_cap(s) {
  if (s.length <= SR_TIDY_MAX) return s;
  let n = SR_TIDY_MAX - 1; const c = s.charCodeAt(n - 1); if (c >= 0xd800 && c <= 0xdbff) n--;
  return s.slice(0, n) + '…';
}
function sr_secOff(s) {
  s = s.replace(SR_SEC_RE, '');
  let i = 0;
  for (;;) { SR_LEAD_Y.lastIndex = i; if (!SR_LEAD_Y.test(s) || SR_LEAD_Y.lastIndex === i) break; i = SR_LEAD_Y.lastIndex; }
  return i ? s.slice(i) : s;
}
function sr_group(g, leaf) {
  if (SR_EMPTY_PAIR.test(g)) return '';
  let r = leaf ? g : g.replace(SR_SEC_RE, ''); if (!r) return '';
  r = sr_codes(r);
  if (SR_EMPTY_PAIR.test(r)) return '';
  const r2 = r.replace(/\[\s*\]/g, '');
  return r2 === r || !leaf ? r2 : sr_group(r2, false);
}
function sr_brackets(s) {
  const out = [], st = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === '(' || c === '[') {
      const top = st[st.length - 1], pp = top ? (top.k === '(' ? top : top.pp) : null;
      if (c === '(' && pp) pp.kid = true;
      st.push({ k: c, at: out.length, src: i, pp, kid: false }); out.push(c); continue;
    }
    if (c === ')') {
      while (st.length && st[st.length - 1].k === '[') st.pop();
      const t = st.pop();
      if (!t) { out.push(c); continue; }
      const body = out.splice(t.at).join('');
      const r = t.kid ? sr_group(body + ')', false) : sr_group(s.slice(t.src, i + 1), true);
      if (r) { out.push(r); st.length = 0; }
      continue;
    }
    if (c === ']') {
      const t = st[st.length - 1];
      if (t && t.k === '[') { out.length = t.at; st.pop(); } else out.push(c);
      continue;
    }
    out.push(c);
    if (!SR_WS1.test(c)) while (st.length && st[st.length - 1].k === '[') st.pop();
  }
  return out.join('');
}
function sr_tidy(v) {
  const s0 = sr_cap(sr_str(v)).replace(SR_SEC_RE, ''), s1 = sr_secOff(sr_brackets(s0));
  const s = s1 === s0 ? s1 : sr_secOff(sr_brackets(s1));
  return s.replace(/(?<!\s)\s+([,;.])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
function sr_note(v) { return sr_tidy(v).split(/(?<=[.;!?])\s+/).filter((x) => x && !SR_NOISE_RE.test(x)).join(' ').replace(/[;,]\s*$/, '').trim(); }
const sr_isAdminTask = (t) => SR_ADMIN_OWNER_RE.test(sr_str(t.owner).trim()) || SR_META_TASK_RE.test(sr_str(t.title));
const sr_noSec = (s) => sr_tidy(s);
function sr_stripDate(iso) { const d = new Date(sr_isoToUtc(iso)); return { wd: SR_WDAY[d.getUTCDay()], d: sr_pad(d.getUTCDate()), mon: SR_MON[d.getUTCMonth()], y: d.getUTCFullYear() }; }
function sr_stripTime(e) { return e.s != null ? e.timeLabel : e.src === 'timeline' && e.timeLabel === 'ONGOING' ? 'ONGOING' : '—'; }
function sr_strip(D, allDays, day, z, shackled) {
  if (!allDays.length) return '';
  const days = sr_window1(allDays, day || z.date, SR_STRIP_MAX);
  const sdays = sr_arr(D.sitrep && D.sitrep.days), evAt = sr_eventIndex(D);
  const cards = days.map((iso) => {
    const evs = evAt(iso);
    const list = evs.filter((e) => e.s != null).sort(sr_sort).concat(evs.filter((e) => e.s == null));
    const isToday = iso === z.date, sel = iso === day, past = iso < z.date;
    const nowEv = isToday ? sr_nowEv(list.filter((e) => e.s != null), z) : null;
    const k = sr_stripDate(iso), sd = sdays.find((x) => x && x.date === iso), label = sd ? sr_noSec(sd.label) : '', head = sd ? sr_noSec(sd.title) : '';
    const shown = list.slice(0, SR_STRIP_LINES), extra = list.length - shown.length;
    const title = (e) => sr_noSec(e.title) || '—';
    const lines = shown.map((e) => `<span class="sr-tl-ev${e === nowEv ? ' sr-tl-evnow' : ''}"><span class="sr-tl-t">${esc(sr_stripTime(e))}</span><span class="sr-tl-x">${esc(title(e))}</span></span>`).join('');
    const count = list.length ? list.length + (list.length === 1 ? ' event' : ' events') : head ? '' : 'no events';
    const aria = [k.wd + ' ' + k.d + ' ' + k.mon + ' ' + k.y].concat(shackled ? [list.length + (list.length === 1 ? ' event' : ' events')] : [label, head, count].concat(shown.map(title), extra > 0 ? ['plus ' + extra + ' more'] : []),
      isToday ? ['today'] : [], nowEv ? ['event in progress'] : [], sel ? ['selected'] : [])
      .filter(Boolean).join(', ');
    const cls = 'sr-tl-card' + (isToday ? ' sr-tl-today' : '') + (past ? ' sr-tl-past' : '') + (nowEv ? ' sr-tl-now' : '');
    return `<li class="sr-tl-item"><button type="button" class="${cls}" data-sr-stripday="${esc(iso)}" aria-pressed="${sel}"${isToday ? ' aria-current="date"' : ''} aria-label="${esc(aria)}">` +
      `<span class="sr-tl-top"><span class="sr-tl-date"><b>${esc(k.wd)} ${esc(k.d)}</b> ${esc(k.mon)}</span>${isToday ? `<span class="sr-badge">${nowEv ? 'NOW' : 'TODAY'}</span>` : ''}</span>` +
      (label ? `<span class="sr-tl-lab">${esc(label)}</span>` : '') +
      (head ? `<span class="sr-tl-hl">${esc(head)}</span>` : '') + (count ? `<span class="sr-tl-count">${esc(count.toUpperCase())}</span>` : '') + `${lines}${extra > 0 ? `<span class="sr-tl-more">+${extra}</span>` : ''}</button></li>`;
  }).join('');
  const a = sr_stripDate(days[0]), b = sr_stripDate(days[days.length - 1]);
  const span = a.d + ' ' + a.mon + (a.y !== b.y ? ' ' + a.y : '') + ' – ' + b.d + ' ' + b.mon + ' ' + b.y;
  const more = allDays.length > days.length ? ' shown' : '';
  return `<section class="sr-tl" aria-label="Operation days timeline"><div class="sr-tl-head"><span class="sr-lbl">OPERATION DAYS</span><span class="sr-tl-span">${esc(span)} · ${days.length} ${days.length === 1 ? 'day' : 'days'}${more}</span></div>` +
    `<ol class="sr-tl-strip" data-sr-tlscroll aria-label="Operation days, scroll sideways">${cards}</ol></section>`;
}
function sr_stripScroll(root, focusDay) {
  if (!root || typeof root.querySelector !== 'function') return;
  const sc = root.querySelector('[data-sr-tlscroll]'); if (!sc || typeof sc.querySelector !== 'function') return;
  const cur = (focusDay && sr_isIso(focusDay) && sc.querySelector('[data-sr-stripday="' + focusDay + '"]')) || sc.querySelector('[aria-pressed="true"]') || sc.querySelector('[aria-current="date"]');
  if (!cur) return;
  if (typeof cur.offsetLeft === 'number') {
    const x = Math.max(0, cur.offsetLeft - Math.round(((sc.clientWidth || 0) - (cur.offsetWidth || 0)) / 2));
    if (typeof sc.scrollTo === 'function') sc.scrollTo({ left: x, behavior: 'instant' }); else sc.scrollLeft = x;
  }
  if (focusDay && typeof cur.focus === 'function') cur.focus({ preventScroll: true });
}

function sr_panel(title, body, sub) { return `<section class="panel"><div class="panelhead"><h2>${esc(title)}</h2>${sub ? `<small>${esc(sub)}</small>` : ''}</div>${body}</section>`; }
function sr_row(ev, mark) {
  const vis = ev.vis, t = ev.s == null ? (ev.timeLabel || '—') : ev.timeLabel;
  const sub = [ev.place ? sr_link(ev.place.url, ev.place.label, 'sr-link') : '', ev.lead ? esc(ev.lead) : ''].filter(Boolean).join('<span class="sr-dot"> · </span>');
  return `<li class="sr-ev${mark === 'now' ? ' sr-now' : mark === 'next' ? ' sr-next' : ''}" data-sr-t="${ev.s == null ? '' : esc(ev.s)}" data-sr-e="${ev.e == null ? '' : esc(ev.e)}"${vis ? '' : ' hidden'}>` +
    `<span class="sr-time">${esc(t)}${ev.endLabel ? `<small>–${esc(ev.endLabel)}</small>` : ''}</span>` +
    `<span class="sr-body"><b class="sr-h">${esc(ev.title)}</b>${sub ? `<span class="sr-sub">${sub}</span>` : ''}${ev.note ? `<small class="sr-note">${esc(ev.note)}</small>` : ''}</span>` +
    `<span class="sr-right">${mark === 'now' ? '<span class="sr-badge">NOW</span>' : mark === 'next' ? '<span class="sr-badge sr-badge-next">NEXT</span>' : ''}${ev.status ? `<span class="sr-st ${sr_statusCls(ev.status)}">${esc(ev.status)}</span>` : ''}</span></li>`;
}
function sr_mapPanel(m, D, shackled) {
  if (!m || typeof m !== 'object') return '';
  if (m.kind === 'notsourced' || /NOT SOURCED|GAPS\.md/i.test(sr_str(m.label) + ' ' + sr_str(m.caption))) return '';
  if (m.kind === 'wx') return /no forecast/i.test(sr_str(m.head)) ? '' : `<div class="s5-panel s5-wx"><div class="s5-plabel">${esc(sr_tidy(m.label))}</div><div class="s5-wxrow"><b class="s5-wxicon">${esc(m.icon)}</b><b class="s5-h">${esc(m.head)}</b></div>${sr_tidy(m.caption) ? `<p class="s5-cap">${esc(sr_tidy(m.caption))}</p>` : ''}</div>`;
  if (m.kind === 'photos') {
    const ph = (D.sitrep && D.sitrep.photos) || {};
    const links = sr_arr(ph.items).map((x) => x && sr_mapUrl(x.url) ? sr_link(x.url, x.label, 's5-link') : '').concat([sr_mapUrl(ph.folder) ? sr_link(ph.folder, 'Site image folder', 's5-link') : '', sr_mapUrl(ph.isrFolder) ? sr_link(ph.isrFolder, 'ISR folder', 's5-link') : '']).filter(Boolean);
    return links.length ? `<div class="s5-panel s5-photos"><div class="s5-plabel">Photos</div><div class="s5-links">${links.join('')}</div></div>` : '';
  }
  if (m.kind === 'map') {
    const src = shackled ? null : sr_embedUrl(m.embed);
    return `<div class="s5-panel s5-map"><div class="s5-plabel">${esc(sr_tidy(m.label))}</div>${src ? `<iframe class="s5-frame" title="${esc(sr_tidy(m.label))}" src="${esc(src)}" referrerpolicy="no-referrer"></iframe>` : ''}${sr_tidy(m.caption) ? `<p class="s5-cap">${esc(sr_tidy(m.caption))}</p>` : ''}<div class="s5-links">${sr_arr(m.links).map((l) => l && sr_mapUrl(l.url) ? sr_link(l.url, l.label, 's5-link') : '').join('')}</div></div>`;
  }
  return '';
}
function sr_reference(D, day, today, shackled) {
  const S = D.sitrep || {}, days = sr_arr(S.days);
  const L = (u, label) => (sr_safeUrl(u) ? `<a target="_blank" rel="noopener" href="${esc(u)}">${esc(label)} ↗</a>` : esc(label));
  const cards = [].map((c) => c ? `<button type="button" class="op-card"${c.action ? ` data-action="${esc(c.action.type)}" data-arg="${esc(c.action.arg == null ? '' : c.action.arg)}"` : ''}><span class="micro">${esc(c.micro)}</span><h2>${esc(c.title)}</h2><p>${esc(c.detail)}</p><small>${esc(c.small)}</small></button>` : '').join('');
  const open = sr_arr(D.tasks).filter((t) => t && /^in progress$/i.test(t.status || '') && !sr_isAdminTask(t));
  const due = (t) => { const d = sr_str(t.due).slice(0, 10); return sr_isIso(d) && today && d < today ? 'OVERDUE since ' + d : t.dueLabel ? sr_tidy(t.dueLabel) : 'Due ' + sr_str(t.due); };
  const taskBtn = (t) => `<button type="button" class="task" data-action="task" data-arg="${esc(t.id)}"><span class="sec-icon">OPEN</span><span><b>${esc(sr_tidy(t.title))}</b><small>${[sr_tidy(t.owner), sr_str(t.status), due(t)].filter(Boolean).map(esc).join(' · ')}</small></span><span class="arrow">↗</span></button>`;
  const cur = days.find((d) => d && d.date === day);
  const current = (cur || open.length) ? sr_panel('Current activity', (cur ? `<div class="pad"><div class="micro">${day === today ? 'TODAY' : esc(sr_dayHead(day))} · ${esc(cur.label)}</div><h3>${esc(sr_tidy(cur.title))}</h3>${sr_note(cur.note) ? `<p>${esc(sr_note(cur.note))}</p>` : ''}</div>` : '') + open.map(taskBtn).join('')) : '';
  const maps = sr_arr(S.maps).map((m) => sr_mapPanel(m, D, shackled)).join('');
  const hk = sr_arr(S.hotkeys).filter(Boolean);
  const keys = hk.length ? sr_panel('Source data · hot keys', `<div class="pad sitrep-keys">${hk.map((k) => `<a class="btn" data-hotkey="${esc(k.key)}" target="_blank" rel="noopener" href="${esc(sr_safeUrl(k.url) || '#')}"><b>${esc(k.key)}</b> ${esc(sr_tidy(k.label))}</a>`).join(' ')}</div>`, 'Press the key or tap') : '';
  const ph = S.photos || {};
  const photos = (sr_arr(ph.items).length || ph.folder || ph.isrFolder) ? sr_panel('Photos', `<div class="pad">${sr_arr(ph.items).map((x) => L(x && x.url, x && x.label)).join(' · ')}<p>${L(ph.folder, 'Site image folder')} · ${L(ph.isrFolder, 'ISR folder')}</p></div>`) : '';
  const di = sr_arr(S.distances).filter((d) => d && sr_tidy(d.value) && !/^TBD\b/i.test(sr_tidy(d.value)));
  const dist = di.length ? sr_panel('Distances', `<div class="tablewrap"><table><tbody>${di.map((d) => `<tr><td>${esc(sr_tidy(d.from))} → ${esc(sr_tidy(d.to))}</td><td><b>${esc(sr_tidy(d.value))}</b></td></tr>`).join('')}</tbody></table></div>`) : '';
  const cal = days.length ? sr_panel('Calendar', days.filter(Boolean).map((d) => `<div class="task${d.date === today ? ' active' : ''}${d.date === day ? ' sr-cal-sel' : ''}"><span class="sec-icon">${esc(d.label)}</span><span><b>${esc(sr_tidy(d.title))}</b><small>${esc(sr_note(d.note))}</small></span></div>`).join(''), 'Today highlighted') : '';
  const left = keys + dist, right = photos + cal;
  return (cards ? `<div class="operational-grid">${cards}</div>` : '') + current + (maps ? `<div class="s5-grid">${maps}</div>` : '') + (left || right ? `<div class="grid"><div>${left}</div><div>${right}</div></div>` : '');
}

function sitrepV2(D, state, now) {
  if (!D || typeof D !== 'object') return '';
  const tz = sr_tz(D), z = sr_zoned(now, tz);
  const st = state || sr_state, win = sr_window(st);
  const days = sr_days(D, sr_center(D, st, z));
  if (!days.length) return sr_reference(D, null, z.date, !!(st && st.shackled));
  const day = sr_pickDay(days, st, z);
  const project = sr_str(D.meta && D.meta.project), shackled = !!(st && st.shackled);
  const evs = day ? sr_events(D, day) : [];
  evs.forEach((e) => { e.vis = sr_inWindow(e, win.from, win.to); });
  const timed = evs.filter((e) => e.s != null).sort(sr_sort), untimed = evs.filter((e) => e.s == null);
  let nowEv = null, nextEv = null;
  if (day && day === z.date) {
    nowEv = sr_nowEv(timed, z);
    nextEv = timed.find((e) => e.s > z.min) || null;
  }
  const mark = (e) => (e === nowEv ? 'now' : e === nextEv ? 'next' : '');
  const di = days.indexOf(day), cur = sr_arr(D.sitrep && D.sitrep.days).find((d) => d && d.date === day);
  const shown = evs.filter((e) => e.vis).length;
  const opt = days.map((d) => `<option value="${esc(d)}"${d === day ? ' selected' : ''}>${esc(sr_dayHead(d))}${d === z.date ? ' · TODAY' : ''}</option>`).join('');
  const quick = SR_QUICK.map((q) => `<button type="button" class="sr-q" data-sr-quick="${esc(q.id)}" aria-pressed="${q.from === win.from && q.to === win.to}">${esc(q.label)}</button>`).join('');
  const groups = SR_BUCKETS.map((b) => {
    const rows = timed.filter((e) => sr_bucket(e.s) === b);
    const vis = rows.filter((e) => e.vis).length;
    return `<section class="sr-group" data-sr-bucket="${esc(b.id)}"${rows.length ? '' : ' data-sr-none=""'}><h2 class="sr-gh"><span>${esc(b.label)}</span><span class="sr-gr">${sr_hhmm(b.from * 60)}–${sr_hhmm(b.to * 60 - 1)}</span></h2>` +
      `<ol class="sr-list">${rows.map((e) => sr_row(e, mark(e))).join('')}<li class="sr-empty"${rows.length && !vis ? '' : ' hidden'}>No events in the selected window</li>${rows.length ? '' : '<li class="sr-empty sr-none">No events scheduled</li>'}</ol></section>`;
  }).join('');
  const untimedHtml = untimed.length ? `<section class="sr-group sr-untimed"><h2 class="sr-gh"><span>ALL DAY / TIME NOT SET</span></h2><ol class="sr-list">${untimed.map((e) => sr_row(e, '')).join('')}</ol></section>` : '';
  const runWhen = (z.date === day ? 'NOW ' + sr_hhmm(z.min) + ' · ' : '') + tz;
  const article = `<article class="sr-page" aria-label="${esc(project)} SITREP">` +
    `<div class="sr-run"><span class="sr-brand">${esc(project)} / SITREP</span><span class="sr-when">${esc(runWhen)}</span></div>` +
    `<h1 class="sr-title">SITREP</h1>` +
    (day ? `<div class="sr-dayhead"><span class="sr-daydate">${esc(sr_dayHead(day))}</span>${day === z.date ? '<span class="sr-badge">TODAY</span>' : ''}${cur && cur.label ? `<span class="sr-daylabel">${esc(cur.label)}</span>` : ''}</div>` +
      (cur && (sr_tidy(cur.title) || sr_note(cur.note)) ? `<div class="sr-daysub">${sr_tidy(cur.title) ? `<b>${esc(sr_tidy(cur.title))}</b>` : ''}${sr_note(cur.note) ? ` <span>${esc(sr_note(cur.note))}</span>` : ''}</div>` : '') : '') +
    `<div class="sr-controls">` +
      (days.length ? `<div class="sr-daypick"><button type="button" class="sr-step" data-sr-daystep="-1" aria-label="Previous day"${di <= 0 ? ' disabled' : ''}>‹</button><label class="sr-daysel"><span class="sr-lbl">DAY</span><select data-sr-day aria-label="Operation day">${opt}</select></label><button type="button" class="sr-step" data-sr-daystep="1" aria-label="Next day"${di >= days.length - 1 ? ' disabled' : ''}>›</button></div>` : '') +
      `<div class="sr-quick" role="group" aria-label="Time window">${quick}</div>` +
      `<div class="sr-range"><label><span class="sr-lbl">FROM <output data-sr-out="from">${sr_hhmm(win.from * 60)}</output></span><input type="range" data-sr-range="from" min="0" max="23" step="1" value="${win.from}" aria-label="Window start hour"></label>` +
      `<label><span class="sr-lbl">TO <output data-sr-out="to">${sr_hhmm(win.to * 60 - 1)}</output></span><input type="range" data-sr-range="to" min="1" max="24" step="1" value="${win.to}" aria-label="Window end hour"></label></div>` +
    `</div>` +
    `<div class="sr-total"><span>EVENTS</span><b data-sr-count>${shown} of ${evs.length} shown</b></div>` +
    (evs.length ? untimedHtml + groups : `<p class="sr-nodata">No events for this day in the snapshot.</p>`) +
    `<div class="sr-foot"><span>${sr_arr(D.meta && D.meta.footer).map(esc).join(' / ')}</span></div></article>`;
  return article + sr_reference(D, day, z.date, shackled);
}

function sitrepV2Strip(D, state, now) {
  if (!D || typeof D !== 'object') return '';
  const z = sr_zoned(now, sr_tz(D)), st = state || sr_state, days = sr_days(D, sr_center(D, st, z));
  return days.length ? sr_strip(D, days, sr_pickDay(days, st, z), z, !!(st && st.shackled)) : '';
}

function sr_applyWindow(root) {
  const win = sr_window(sr_state);
  const fromEl = root.querySelector('[data-sr-range="from"]'), toEl = root.querySelector('[data-sr-range="to"]');
  if (fromEl) fromEl.value = String(win.from); if (toEl) toEl.value = String(win.to);
  const o1 = root.querySelector('[data-sr-out="from"]'), o2 = root.querySelector('[data-sr-out="to"]');
  if (o1) o1.textContent = sr_hhmm(win.from * 60); if (o2) o2.textContent = sr_hhmm(win.to * 60 - 1);
  let shown = 0, total = 0;
  root.querySelectorAll('.sr-ev').forEach((li) => {
    const t = li.getAttribute('data-sr-t'), e = li.getAttribute('data-sr-e');
    const v = sr_inWindow({ s: t === '' ? null : Number(t), e: e === '' ? null : Number(e) }, win.from, win.to);
    li.hidden = !v; total++; if (v) shown++;
  });
  root.querySelectorAll('.sr-group[data-sr-bucket]').forEach((g) => {
    const rows = g.querySelectorAll('.sr-ev'), vis = g.querySelectorAll('.sr-ev:not([hidden])').length, em = g.querySelector('.sr-empty:not(.sr-none)');
    if (em) em.hidden = !(rows.length && !vis);
  });
  const c = root.querySelector('[data-sr-count]'); if (c) c.textContent = shown + ' of ' + total + ' shown';
  root.querySelectorAll('[data-sr-quick]').forEach((b) => { const q = SR_QUICK.find((x) => x.id === b.getAttribute('data-sr-quick')); b.setAttribute('aria-pressed', String(!!q && q.from === win.from && q.to === win.to)); });
}
function sitrepV2Bind(rootEl, D, rerender) {
  if (!rootEl) return;
  sr_ctx = { D, rerender: typeof rerender === 'function' ? rerender : null };
  sr_stripScroll(rootEl, null);
  if (sr_bound.has(rootEl)) return;
  sr_bound.add(rootEl);
  const redraw = () => { if (sr_ctx.rerender) sr_ctx.rerender(); else sr_applyWindow(rootEl); };
  rootEl.addEventListener('change', (ev) => {
    const sel = ev.target && ev.target.closest && ev.target.closest('[data-sr-day]');
    if (sel && rootEl.contains(sel)) { sr_state.day = sel.value; redraw(); }
  });
  rootEl.addEventListener('input', (ev) => {
    const r = ev.target && ev.target.closest && ev.target.closest('[data-sr-range]'); if (!r || !rootEl.contains(r)) return;
    const v = Number(r.value);
    if (r.getAttribute('data-sr-range') === 'from') { sr_state.from = v; if (sr_state.to <= v) sr_state.to = Math.min(24, v + 1); }
    else { sr_state.to = v; if (sr_state.from >= v) sr_state.from = Math.max(0, v - 1); }
    sr_applyWindow(rootEl);
  });
  rootEl.addEventListener('click', (ev) => {
    const q = ev.target && ev.target.closest && ev.target.closest('[data-sr-quick]');
    if (q && rootEl.contains(q)) { const w = SR_QUICK.find((x) => x.id === q.getAttribute('data-sr-quick')); if (w) { sr_state.from = w.from; sr_state.to = w.to; sr_applyWindow(rootEl); } return; }
    const s = ev.target && ev.target.closest && ev.target.closest('[data-sr-daystep]');
    if (s && rootEl.contains(s)) {
      const sel = rootEl.querySelector('[data-sr-day]'), cur = sel ? sel.value : sr_state.day, days = sr_days(sr_ctx.D || {}, cur);
      const i = days.indexOf(cur), n = i + Number(s.getAttribute('data-sr-daystep'));
      if (i >= 0 && n >= 0 && n < days.length) { sr_state.day = days[n]; redraw(); }
      return;
    }
    const k = ev.target && ev.target.closest && ev.target.closest('[data-sr-stripday]');
    if (k && rootEl.contains(k)) {
      const iso = k.getAttribute('data-sr-stripday');
      if (sr_isIso(iso) && sr_days(sr_ctx.D || {}, iso).indexOf(iso) >= 0) { sr_state.day = iso; redraw(); sr_stripScroll(rootEl, iso); }
    }
  });
}

/* ---- conop.js (pinned 015cdadb, r2 host patches, comments stripped) ---- */

const CP_ORDER = ['Situation', 'Mission', 'Execution', 'Phases', 'Actions on', 'Sustainment', 'Command & Signal', 'Medical'];
const CP_HEAD = {
  'Situation': 'SITUATION',
  'Mission': 'MISSION',
  'Execution': 'EXECUTION',
  'Phases': 'PHASES AND UPCOMING MOVES',
  'Actions on': 'ACTIONS ON CONTINGENCIES',
  'Sustainment': 'TRAVEL, LODGING AND SUSTAINMENT',
  'Command & Signal': 'VEHICLE AND COMMUNICATIONS / COMMAND & SIGNAL',
  'Medical': 'MEDICAL',
};
const CP_WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CP_MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CP_STAFF = /^\s*S\s*(?:-\s*)?[1-8]\b/i;
const CP_MAXDAYS = 370;
const CP_STRIP_MAX = 61;

function cp_str(v) { return Array.isArray(v) ? v.map((x) => (x == null ? '' : String(x))).join('') : (v == null ? '' : String(v)); }
function cp_t(v) { return cp_str(v).trim(); }
function cp_key(s) { return cp_t(s).toLowerCase().replace(/\s+/g, ' ').replace(/\band\b/g, '&').replace(/(?<!\s)\s*&\s*/g, ' & '); }
function cp_canon(name, list) { const k = cp_key(name); return list.find((x) => cp_key(x) === k) || null; }
function cp_flag(name) { try { if (name === 'shackled') return typeof shackled !== 'undefined' && !!shackled; if (name === 'night') return typeof raspTheme !== 'undefined' && raspTheme === 'night'; } catch (e) {   } return false; }
function cp_list(v, key) { if (Array.isArray(v)) return v; if (v && typeof v === 'object' && Array.isArray(v[key])) return v[key]; return []; }
function cp_latest(rows) {
  const out = [], byId = new Map();
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const id = r.id == null ? null : String(r.id);
    if (id === null) { out.push({ r, i }); return; }
    const prev = byId.get(id), rev = Number(r.rev) || 0;
    if (!prev || rev >= (Number(prev.r.rev) || 0)) byId.set(id, { r, i: prev ? prev.i : i });
  });
  byId.forEach((v) => out.push(v));
  return out.sort((a, b) => a.i - b.i).map((v) => v.r).filter((r) => !r.deleted);
}

function cp_ymd(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cp_t(v)); return m && cp_valid(m[0]) ? m[0] : ''; }
function cp_dt(ymd) { const p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); }
function cp_valid(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = cp_dt(ymd); return d.toISOString().slice(0, 10) === ymd;
}
function cp_add(ymd, n) { const d = cp_dt(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function cp_hm(v) {
  const s = cp_t(v);
  const m = /T(\d{2}):?(\d{2})/.exec(s) || /^(\d{2}):?(\d{2})$/.exec(s) || /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return '';
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 23 || mi > 59 ? '' : String(h).padStart(2, '0') + String(mi).padStart(2, '0');
}
function cp_wd(ymd) { return CP_WD[cp_dt(ymd).getUTCDay()]; }
function cp_long(ymd) { const d = cp_dt(ymd); return `${CP_WD[d.getUTCDay()]}, ${CP_MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`; }
function cp_short(ymd) { const d = cp_dt(ymd); return `${CP_WD[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${CP_MO[d.getUTCMonth()].slice(0, 3)}`; }
function cp_tzOk(tz) { if (typeof tz !== 'string' || !tz.trim()) return false; try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); return true; } catch (e) { return false; } }
function cp_tzFound(D) { const m = (D && D.meta) || {}, s = (D && D.sitrep) || {}; return [m.timezone, m.tz, s.timezone].find(cp_tzOk) || ''; }
function cp_tz(D) {
  const hit = cp_tzFound(D); if (hit) return hit;
  let host = null; try { host = typeof raspDefaultTz === 'string' ? raspDefaultTz : null; } catch (e) { host = null; }
  return cp_tzOk(host) ? host : 'UTC';
}
function cp_today(tz, now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    const s = `${p.year}-${p.month}-${p.day}`; if (cp_valid(s)) return s;
  } catch (e) {   }
  return d.toISOString().slice(0, 10);
}
function cp_tzName(tz, ymd, style) {
  if (!tz) return '';
  const d = ymd ? cp_dt(ymd) : new Date();
  for (const s of (style === 'long' ? ['longGeneric', 'long'] : ['short'])) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: s }).formatToParts(d).find((x) => x.type === 'timeZoneName');
      if (p && p.value) return s === 'long' ? p.value.replace(/(?<!\s)\s+(Standard|Daylight|Summer)\s+/, ' ') : p.value.replace(/^GMT\+0$/, 'GMT');
    } catch (e) {   }
  }
  return '';
}
function cp_stamp(v, tz) {
  const s = cp_t(v); if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s;
  const d = new Date(s); if (isNaN(d.getTime())) return s;
  try {
    const p = {}; new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return `${p.month} ${p.day}, ${p.hour}:${p.minute} ${(p.timeZoneName || '').replace(/^GMT\+0$/, 'GMT')}`.trim();
  } catch (e) { return s; }
}
function cp_range(a, b) {
  if (!a) return '';
  const x = cp_dt(a), y = cp_dt(b || a), M = (d) => CP_MO[d.getUTCMonth()].toUpperCase();
  if (a === (b || a)) return `${x.getUTCDate()} ${M(x)} ${x.getUTCFullYear()}`;
  if (x.getUTCFullYear() !== y.getUTCFullYear()) return `${x.getUTCDate()} ${M(x)} ${x.getUTCFullYear()} - ${y.getUTCDate()} ${M(y)} ${y.getUTCFullYear()}`;
  if (x.getUTCMonth() !== y.getUTCMonth()) return `${x.getUTCDate()} ${M(x)} - ${y.getUTCDate()} ${M(y)} ${y.getUTCFullYear()}`;
  return `${x.getUTCDate()}-${y.getUTCDate()} ${M(x)} ${x.getUTCFullYear()}`;
}

function cp_paras(D) {
  const c = D && D.conop;
  return cp_latest(cp_list(c && c.paragraphs, 'rows'))
    .map((r, i) => ({ r, i, sec: cp_canon(r.section, CP_ORDER) || cp_t(r.section) || 'Notes', ord: Number.isFinite(Number(r.order)) && cp_t(r.order) !== '' ? Number(r.order) : Infinity }))
    .filter((x) => !CP_STAFF.test(x.sec) && cp_t(x.r.text))
    .sort((a, b) => a.ord - b.ord || a.i - b.i)
    .map((x) => ({ section: x.sec, text: cp_str(x.r.text), date: cp_ymd(x.r.date) }));
}
function cp_sched(D) {
  const c = D && D.conop, a = cp_list(c && c.schedule, 'rows');
  const src = a.length ? a : cp_list(D && D.schedule, 'rows');
  return cp_latest(src).map((r, i) => ({ r, i, date: cp_ymd(r.date) || cp_ymd(r.start), hm: cp_hm(r.start), end: cp_hm(r.end) }))
    .filter((x) => x.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.hm && b.hm ? (a.hm < b.hm ? -1 : a.hm > b.hm ? 1 : 0) : (a.hm ? 1 : b.hm ? -1 : 0)) || a.i - b.i);
}
function cp_places(D) { return cp_latest(cp_list(D && D.places, 'rows')); }
function cp_days(p) { const v = p && p.days; return (Array.isArray(v) ? v : cp_str(v).split(/[;,|\s]+/)).map(cp_ymd).filter(Boolean); }
function cp_place(P, id) { const k = cp_t(id); return k ? P.find((p) => cp_t(p.id) === k) || null : null; }
function cp_type(p) { return cp_key(p && p.type); }
function cp_lodging(P, day) { return P.filter((p) => cp_type(p) === 'lodging' && cp_days(p).includes(day)); }
function cp_opDays(D, S, center) {
  const set = new Set(S.map((x) => x.date)), m = (D && D.meta) || {}, c = cp_valid(center || '') ? center : '';
  const a = cp_ymd(m.opStart), b = cp_ymd(m.opEnd);
  if (a && b && a <= b) {
    const n = cp_diff(a, b) + 1;
    const start = n > CP_MAXDAYS && c ? cp_add(a, Math.max(0, Math.min(n - CP_MAXDAYS, cp_diff(a, c) - Math.floor(CP_MAXDAYS / 2)))) : a;
    for (let d = start, k = 0; d <= b && k < CP_MAXDAYS; d = cp_add(d, 1), k++) set.add(d);
  } else { if (a) set.add(a); if (b) set.add(b); }
  return cp_window1(Array.from(set).sort(), c, CP_MAXDAYS);
}
function cp_defaultDay(days, today) { return days.length ? Math.max(0, days.findIndex((d) => d >= today)) : -1; }
function cp_team(m) {
  const v = m && m.team;
  const a = (Array.isArray(v) ? v.map(cp_t) : [cp_t(v)]).filter(Boolean);
  return a.length <= 2 ? a.join(' and ') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
}
function cp_where(x, P) { const p = cp_place(P, x.r.placeId); return cp_t(x.r.location) || (p ? cp_t(p.label) : ''); }
function cp_site(items, P, day) {
  const bySite = items.find((x) => cp_type(cp_place(P, x.r.placeId)) === 'site');
  if (bySite) return { item: bySite, place: cp_place(P, bySite.r.placeId) };
  const place = P.find((p) => cp_type(p) === 'site' && cp_days(p).includes(day)) || null;
  return { item: items[0] || null, place };
}
function cp_mapUrl(addr) {
  const a = cp_t(addr); if (!a) return '';
  const u = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a);
  return /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=[^"'<>\s]+$/.test(u) ? u : '';
}

function cp_h(text) { return `<h3 class="cp-sh">${esc(text)}</h3>`; }
function cp_p(text) { return `<p class="cp-p">${esc(text)}</p>`; }
const CP_GENERIC_OWNER = /^(?:site|main|main line|phone|tel|telephone|office|reception|switchboard|desk|front desk|general|line)$|\b(?:main line|switchboard|reception|front desk)\b/i;
function cp_owned(p) { const o = cp_t(p.phoneOwner); return cp_t(p.phone) && /[A-Za-z]/.test(o) && !/@/.test(o) && !CP_GENERIC_OWNER.test(o) ? cp_t(p.phone) + ' · ' + o : ''; }
function cp_addr(p) { return [cp_t(p.address), cp_owned(p)].filter(Boolean).join(' / '); }
function cp_foot(op, stamp, pg) {
  const left = ['RSQ' + (op ? ' / ' + op : ''), 'REVIEW COPY', 'Updated ' + (stamp || 'TBD')].join(' | ');
  return `<footer class="cp-foot"><span>${esc(left)}</span>${pg ? `<span class="cp-pg">${esc(pg)}</span>` : ''}</footer>`;
}
function cp_head(D, sub, pdf) {
  const proj = D && D.meta ? cp_t(D.meta.project) : '';
  return `<div class="pagehead cp-head"><div><div class="micro">${esc(proj)}${proj ? ' / ' : ''}CONCEPT OF OPERATIONS</div><h1>CONOP</h1>${sub ? `<div class="muted">${esc(sub)}</div>` : ''}</div>` +
    (pdf ? '<div class="actions cp-noprint"><button class="btn primary" type="button" id="raspConopPdf">↓ Save CONOP PDF</button></div>' : '') + '</div>';
}
function cp_row(x, P) {
  const when = x.hm ? x.hm + (x.end && x.end !== x.hm ? '-' + x.end : '') : 'ALL DAY';
  const where = cp_where(x, P), title = cp_t(x.r.title) || 'TBD';
  const meta = [cp_t(x.r.lead) && 'Lead: ' + cp_t(x.r.lead), cp_t(x.r.status)].filter(Boolean).join(' | ');
  const note = cp_t(x.r.note) || cp_t(x.r.notes);
  return `<tr class="${x.hm ? '' : 'cp-allday'}"><th scope="row">${esc(when)}</th><td>${esc(title)}${where ? `: ${esc(where)}` : ''}` +
    (meta ? `<span class="cp-rmeta">${esc(meta)}</span>` : '') + (note ? `<span class="cp-rnote">${esc(note)}</span>` : '') + '</td></tr>';
}
function cp_itemLine(x, P) { const w = cp_where(x, P); return `${x.hm || 'All day'} ${cp_t(x.r.title) || 'TBD'}${w ? ': ' + w : ''}`; }

function cp_brief(ctx, day, idx) {
  const { D, P, S, days, paras, op, tz, stamp, team, status } = ctx;
  const items = day ? S.filter((x) => x.date === day) : [];
  const untimed = items.filter((x) => !x.hm), timed = items.filter((x) => x.hm);
  const abbr = day ? cp_tzName(tz, day, 'short') : '';
  const times = day ? `All ${cp_wd(day)} times ${abbr || 'TBD'}` : '';
  const line = [team, times].filter(Boolean).join(' | ');
  const table = items.length ? `<table class="cp-times"><tbody>${untimed.concat(timed).map((x) => cp_row(x, P)).join('')}</tbody></table>` :
    (day ? '<div class="cp-none">No scheduled items for this day.</div>' : '');
  const site = day ? cp_site(items, P, day) : { place: null };
  const url = site.place ? cp_mapUrl(site.place.address) : '';
  const map = url ? `<a class="cp-map" target="_blank" rel="noopener" href="${esc(url)}">OPEN ${esc((cp_t(site.place.label) || 'SITE').toUpperCase())} MAP</a>` : '';
  const mine = paras.filter((r) => !r.date || r.date === day);
  const groups = CP_ORDER.concat(mine.map((r) => r.section).filter((s, i, a) => !CP_ORDER.includes(s) && a.indexOf(s) === i));
  let mapPlaced = false;
  const body = groups.map((g) => {
    const rows = mine.filter((r) => r.section === g); if (!rows.length) return '';
    const extra = g === 'Sustainment' && map ? (mapPlaced = true, map) : '';
    return `<section class="cp-sec">${cp_h(CP_HEAD[g] || g.toUpperCase())}${rows.map((r) => cp_p(r.text)).join('')}${extra}</section>`;
  }).join('');
  const lod = day ? cp_lodging(P, day) : [];
  const lodHtml = lod.length ? `<section class="cp-sec">${cp_h('OVERNIGHT LODGING')}${lod.map((p) => cp_p([cp_t(p.label) || 'TBD', cp_addr(p)].filter(Boolean).join(', ')) + (cp_t(p.notes) ? cp_p(cp_t(p.notes)) : '')).join('')}</section>` : '';
  let look = '';
  if (day) {
    const next = days.slice(idx + 1, idx + 3);
    let prevKey = lod.map((p) => cp_t(p.id) || cp_t(p.label)).join('|');
    const blocks = next.map((d) => {
      const its = S.filter((x) => x.date === d).map((x) => cp_itemLine(x, P));
      const ld = cp_lodging(P, d), key = ld.map((p) => cp_t(p.id) || cp_t(p.label)).join('|');
      const lines = its.slice(), changed = ld.length && key !== prevKey;
      prevKey = key;
      if (changed) lines.push('Lodging change: ' + ld.map((p) => [cp_t(p.label) || 'TBD', cp_addr(p)].filter(Boolean).join(', ')).join('; '));
      return `<div class="cp-look"><div class="cp-lookd">${esc(cp_long(d))}</div>${lines.length ? lines.map((l) => cp_p(l)).join('') : cp_p('No scheduled items.')}</div>`;
    }).join('');
    look = `<section class="cp-sec">${cp_h('LODGING CHANGES AND LOOKAHEAD')}${blocks || cp_p('No further op days.')}</section>`;
  }
  return `<article class="cp-brief" data-cp-day="${esc(day)}" data-cp-label="${esc(day ? cp_short(day) : 'Date TBD')}"${idx === ctx.cur ? '' : ' hidden'}>` +
    `<div class="cp-kicker">${esc(op ? op + ' | ' : '')}OPERATIONAL BRIEF</div>` +
    `<h2 class="cp-date">${esc(day ? cp_long(day) : 'Date TBD')}</h2>` +
    (line ? `<div class="cp-team">${esc(line)}</div>` : '') +
    (status ? `<div class="cp-status">${esc(status)}</div>` : '') +
    table + (map && !mapPlaced ? map : '') + body + lodHtml + look +
    cp_foot(op, stamp, days.length ? `${idx + 1} / ${days.length}` : '') + '</article>';
}

function cp_card(ctx, day, i) {
  const { P, S, days, tz } = ctx;
  const items = S.filter((x) => x.date === day), site = cp_site(items, P, day);
  const siteName = (site.place && cp_t(site.place.label)) || (site.item && (cp_where(site.item, P) || cp_t(site.item.r.title))) || 'TBD';
  const zone = cp_tzName(tz, day, 'long');
  const dt = cp_dt(day);
  const k = `${CP_WD[dt.getUTCDay()].toUpperCase()} ${dt.getUTCDate()}${zone ? ' / ' + zone.toUpperCase() : ''}`;
  const lod = cp_lodging(P, day);
  const lodHtml = lod.length ? lod.map((p) => `<div class="cp-hotel">${esc(cp_t(p.label) || 'TBD')}</div>${cp_addr(p) ? `<div class="cp-addr">${esc(cp_addr(p))}</div>` : ''}${cp_t(p.notes) ? `<p class="cp-cnote">${esc(cp_t(p.notes))}</p>` : ''}`).join('')
    : '<div class="cp-hotel cp-tbd">TBD</div>';
  const plan = items.map((x) => cp_itemLine(x, P)).join('; ');
  const notes = items.map((x) => cp_t(x.r.note) || cp_t(x.r.notes)).filter(Boolean);
  let nextLine = '';
  for (let j = i + 1; j < days.length; j++) {
    const its = S.filter((x) => x.date === days[j]); if (!its.length) continue;
    const s2 = cp_site(its, P, days[j]);
    const nm = (s2.place && cp_t(s2.place.label)) || (s2.item && (cp_where(s2.item, P) || cp_t(s2.item.r.title))) || 'TBD';
    const tl = its.filter((x) => x.hm).map((x) => `${cp_t(x.r.title) || 'TBD'} ${x.hm}`).join('; ');
    nextLine = `Next: ${cp_wd(days[j])}, ${nm}.${tl ? ' ' + tl + '.' : ''}`; break;
  }
  return `<article class="cp-card"><div class="cp-ck">${esc(k)}</div><h3 class="cp-site">${esc(siteName)}</h3>` +
    `<div class="cp-cl">OVERNIGHT LODGING</div>${lodHtml}` +
    (plan ? `<p class="cp-cnote">${esc(plan)}</p>` : '') + notes.map((n) => `<p class="cp-cnote">${esc(n)}</p>`).join('') +
    (nextLine ? `<p class="cp-next">${esc(nextLine)}</p>` : '') + '</article>';
}
function cp_week(ctx) {
  const { days, op, c, team, stamp } = ctx;
  const range = cp_range(days[0], days[days.length - 1]);
  const kick2 = [range, cp_t(c.sub).toUpperCase()].filter(Boolean).join(' / ');
  const sub = [team, cp_t(c.asOf) && 'As of ' + cp_t(c.asOf)].filter(Boolean).join(' / ');
  return `<section class="cp-week"><div class="cp-wk">RSQ${op ? ' / ' + esc(op) : ''}</div>` +
    (kick2 ? `<div class="cp-wr">${esc(kick2)}</div>` : '') +
    (cp_t(c.headline) ? `<h2 class="cp-wh">${esc(cp_t(c.headline))}</h2>` : '') +
    (sub ? `<p class="cp-ws">${esc(sub)}</p>` : '') +
    days.map((d, i) => cp_card(ctx, d, i)).join('') + cp_foot(op, stamp, '') + '</section>';
}

const CP_SEC_RE = /\b[Ss]\s*[-\u2010\u2011\u2013\u2014\uFF0D]\s*[1-8]\b[\s:·/\u2010\u2011\u2013\u2014-]*/g;
const CP_TL_LINES = 3;
const CP_WD3 = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const CP_ANCH = /^(?:[Ss][-‐‑–—－][1-8]|D\d[-–]D\d|EX\d{2,4}|\x52BCS[-–]\x4CIM[-–]\d{2,5})$/;
const CP_REF_TOK = /^(?:[Ss][-‐‑–—－][1-8]|D\d[-–]D\d|EX\d{2,4}|\x52BCS[-–]\x4CIM[-–]\d{2,5}|RD\d{1,3}|[A-Z]{1,2}\d{2,4}|LOGS|D\d|Q\d)$/;
function cp_noSec(v) {
  let s = cp_t(v).replace(/\(([^()]*)\)/g, (m, inner) => {
    if (!inner.split(/[\s/,;·]+/).some((x) => CP_ANCH.test(x))) return m;
    const keep = inner.split(/[;,]/).map((g) => g.split(/([\s/]+)/).filter((x) => !CP_REF_TOK.test(x)).join('').replace(/^[\s/]+|(?<![\s/])[\s/]+$/g, '')).filter((g) => /[A-Za-z0-9]/.test(g));
    return keep.length ? '(' + keep.join(', ') + ')' : '';
  });
  s = s.replace(/\b[A-Z]{1,2}\d{2}(?:[ \t]{0,2}[-‐‑–][ \t]{0,2}[A-Z]{1,2}\d{2}[ \t]{1,3}(?=(?:dates?|TBD)\b)|[ \t]{1,3}(?=dates?\b))/g, '');
  return s.replace(CP_SEC_RE, '').replace(/(?<!\s)\s+([.,;)])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
function cp_mon3(i) { return CP_MO[i].slice(0, 3).toUpperCase(); }
function cp_nowMin(tz, now) {
  const d = now instanceof Date ? now : (now ? new Date(now) : new Date());
  if (isNaN(d.getTime())) return -1;
  try {
    const p = {}; new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    const v = (Number(p.hour) % 24) * 60 + Number(p.minute); if (v >= 0) return v;
  } catch (e) {   }
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}
const cp_min = (hm) => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2)) : null);
function cp_tlEvents(D, S, P) {
  const map = new Map(), add = (iso, ev) => { if (!map.has(iso)) map.set(iso, []); map.get(iso).push(ev); };
  if (S.length) {
    S.forEach((x) => { const s = cp_min(x.hm), e0 = cp_min(x.end); add(x.date, { s, e: s != null && e0 != null ? (e0 <= s ? 1440 : e0) : null, t: x.hm || 'ALL DAY', title: cp_noSec(x.r.title) || 'TBD', where: cp_noSec(cp_where(x, P)) }); });
  }
  map.forEach((list, k) => { const timed = list.filter((x) => x.s != null).sort((a, b) => a.s - b.s); map.set(k, timed.concat(list.filter((x) => x.s == null))); });
  return map;
}
function cp_window1(list, center, n) {
  if (list.length <= n) return list;
  let i = center ? list.findIndex((d) => d >= center) : 0; if (i < 0) i = list.length - 1;
  const from = Math.max(0, Math.min(list.length - n, i - Math.floor(n / 2)));
  return list.slice(from, from + n);
}
const cp_diff = (a, b) => Math.round((cp_dt(b) - cp_dt(a)) / 864e5);
function cp_tlDays(D, S, evMap, center) {
  const m = (D && D.meta) || {}, c = cp_valid(center || '') ? center : '';
  let a = cp_ymd(m.opStart), b = cp_ymd(m.opEnd);
  if (!a || !b || a > b) {
    const sd = cp_list(D && D.sitrep && D.sitrep.days, 'rows').map((x) => cp_ymd(x && x.date));
    const all = Array.from(new Set(Array.from(evMap.keys()).concat(S.map((x) => x.date), sd).filter(Boolean))).sort();
    if (!all.length) return [];
    if (cp_diff(all[0], all[all.length - 1]) > CP_MAXDAYS) return cp_window1(all, c, CP_STRIP_MAX);
    a = all[0]; b = all[all.length - 1];
  }
  const n = cp_diff(a, b) + 1;
  let start = a;
  if (n > CP_STRIP_MAX && c) start = cp_add(a, Math.max(0, Math.min(n - CP_STRIP_MAX, cp_diff(a, c) - Math.floor(CP_STRIP_MAX / 2))));
  const out = []; for (let d = start; d <= b && out.length < CP_STRIP_MAX; d = cp_add(d, 1)) out.push(d);
  return out;
}
function cp_strip(ctx, now) {
  const { D, S, P, tz } = ctx;
  const zone = ctx.zone || cp_tz(D), today = cp_today(zone, now), nm = cp_nowMin(zone, now);
  const evMap = cp_tlEvents(D, S, P), days = cp_tlDays(D, S, evMap, ctx.briefDay || today);
  if (!days.length) return '';
  const sel = ctx.briefDay && days.includes(ctx.briefDay) ? ctx.briefDay : '';
  const focus = sel || (days.includes(today) ? today : days.find((d) => d >= today) || days[0]);
  const sdays = cp_list(D.sitrep && D.sitrep.days, 'rows');
  const cards = days.map((iso) => {
    const list = evMap.get(iso) || [], isToday = iso === today;
    let nowEv = null;
    if (isToday && nm >= 0) list.forEach((x) => { if (x.s != null && x.s <= nm && (x.e == null || nm < x.e) && (!nowEv || x.s >= nowEv.s)) nowEv = x; });
    const dt = cp_dt(iso), wd = CP_WD3[dt.getUTCDay()], dd = String(dt.getUTCDate()).padStart(2, '0'), mon = cp_mon3(dt.getUTCMonth());
    const sd = sdays.find((x) => x && cp_ymd(x.date) === iso), label = sd ? cp_noSec(sd.label) : '', head = sd ? cp_noSec(sd.title) : '';
    const shown = list.slice(0, CP_TL_LINES), extra = list.length - shown.length;
    const count = list.length ? list.length + (list.length === 1 ? ' event' : ' events') : head ? '' : 'no events';
    const aria = [wd + ' ' + dd + ' ' + mon + ' ' + dt.getUTCFullYear(), label, head, count].concat(shown.map((x) => x.title), extra > 0 ? ['plus ' + extra + ' more'] : [],
      isToday ? ['today'] : [], nowEv ? ['event in progress'] : [], iso === sel ? ['selected'] : []).filter(Boolean).join(', ');
    const cls = 'cp-tl-card' + (isToday ? ' cp-tl-today' : '') + (iso < today ? ' cp-tl-past' : '') + (nowEv ? ' cp-tl-now' : '');
    return `<li class="cp-tl-item"><button type="button" class="${cls}" data-cp-tlday="${esc(iso)}" aria-pressed="${iso === sel}"${isToday ? ' aria-current="date"' : ''}${iso === focus ? ' data-cp-tlfocus="1"' : ''} aria-controls="cp-tlp-${esc(iso)}" aria-label="${esc(aria)}">` +
      `<span class="cp-tl-top"><span class="cp-tl-date"><b>${esc(wd)} ${esc(dd)}</b> ${esc(mon)}</span>${isToday ? `<span class="cp-tl-badge">${nowEv ? 'NOW' : 'TODAY'}</span>` : ''}</span>` +
      (label ? `<span class="cp-tl-lab">${esc(label)}</span>` : '') + (head ? `<span class="cp-tl-hl">${esc(head)}</span>` : '') + (count ? `<span class="cp-tl-count">${esc(count.toUpperCase())}</span>` : '') +
      shown.map((x) => `<span class="cp-tl-ev${x === nowEv ? ' cp-tl-evnow' : ''}"><span class="cp-tl-t">${esc(x.t)}</span><span class="cp-tl-x">${esc(x.title)}</span></span>`).join('') +
      (extra > 0 ? `<span class="cp-tl-more">+${extra}</span>` : '') + '</button></li>';
  }).join('');
  const panels = days.map((iso) => {
    const list = evMap.get(iso) || [], sd = sdays.find((x) => x && cp_ymd(x.date) === iso), head = sd ? cp_noSec(sd.title) : '', note = sd ? cp_noSec(sd.note) : '';
    return `<div class="cp-tl-panel" id="cp-tlp-${esc(iso)}" data-cp-tlpanel="${esc(iso)}" role="region" aria-label="${esc(cp_long(iso))}" hidden><div class="cp-tl-ph">${esc(cp_long(iso))}</div>` +
      (head ? `<p class="cp-p cp-tl-phl">${esc(head)}</p>` : '') + (note ? `<p class="cp-p">${esc(note)}</p>` : '') +
      (list.length ? `<ol class="cp-tl-list">${list.map((x) => `<li><span class="cp-tl-t">${esc(x.t)}</span><span class="cp-tl-x2">${esc(x.title)}${x.where ? `: ${esc(x.where)}` : ''}</span></li>`).join('')}</ol>` : (head || note ? '' : '<div class="cp-none">No scheduled items for this day.</div>')) + '</div>';
  }).join('');
  return `<section class="cp-tl cp-noprint" data-cp-tlroot="1" aria-label="Operation days timeline"><div class="cp-tl-head"><span class="cp-tl-h">OPERATION DAYS</span><span class="cp-tl-span">${esc(cp_range(days[0], days[days.length - 1]))} · ${days.length} ${days.length === 1 ? 'day' : 'days'}</span></div>` +
    `<ol class="cp-tl-strip" data-cp-tlscroll="1" aria-label="Operation days, scroll sideways">${cards}</ol><div class="cp-tl-panels" aria-live="polite">${panels}</div></section>`;
}
function cp_tlScroll(root, focusEl) {
  const sc = root.querySelector('[data-cp-tlscroll]'); if (!sc || typeof sc.querySelector !== 'function') return;
  const cur = focusEl || sc.querySelector('[aria-pressed="true"]') || sc.querySelector('[data-cp-tlfocus]'); if (!cur) return;
  if (typeof cur.offsetLeft === 'number') {
    const x = Math.max(0, cur.offsetLeft - Math.round(((sc.clientWidth || 0) - (cur.offsetWidth || 0)) / 2));
    if (typeof sc.scrollTo === 'function') sc.scrollTo({ left: x, behavior: 'instant' }); else sc.scrollLeft = x;
  }
}
function cp_tlSync(root, iso) { root.querySelectorAll('[data-cp-tlday]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-cp-tlday') === iso))); }
function cp_tlPats(iso) {
  const [, m, d] = iso.split('-').map(Number), full = CP_MO[m - 1], ab = full.slice(0, 3);
  const mn = '(?:' + [ab, ab.toUpperCase()].concat(full.length > 3 ? [full, full.toUpperCase()] : []).join('|') + ')\\.?', sx = '(?:st|nd|rd|th|ST|ND|RD|TH)?';
  return [new RegExp('\\b' + iso + '\\b'), new RegExp('\\b0?' + d + sx + '\\s+' + mn + '(?![A-Za-z])'), new RegExp('\\b' + mn + '\\s+0?' + d + sx + '(?![\\w-])')];
}
function cp_tlFind(doc, iso, days) {
  if (!doc || typeof doc.querySelectorAll !== 'function' || !cp_valid(iso)) return null;
  const heads = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
  const idRe = new RegExp('^(?:[A-Za-z]+[-_])?' + iso + '$');
  const byId = heads.find((el) => idRe.test(cp_t(el.id)));
  if (byId) return byId;
  const mine = cp_tlPats(iso), others = days.filter((d) => d !== iso).map((d) => ({ d, p: cp_tlPats(d) })), y = iso.slice(0, 4);
  const hits = (p, s) => p.some((re) => re.test(s));
  return heads.find((el) => {
    const s = cp_t(el.textContent).replace(/\s+/g, ' ');
    if (!s || s.length > 200 || !hits(mine, s)) return false;
    const years = s.match(/\b(?:19|20)\d\d\b/g);
    if (years && !years.includes(y)) return false;
    return !others.some((o) => hits(o.p, s) && (!years || years.includes(o.d.slice(0, 4))));
  }) || null;
}
function cp_tlSelect(root, card) {
  const iso = card.getAttribute('data-cp-tlday'); if (!cp_valid(iso || '')) return;
  const panels = Array.from(root.querySelectorAll('[data-cp-tlpanel]'));
  const briefs = Array.from(root.querySelectorAll('[data-cp-day]')), bi = briefs.findIndex((b) => b.getAttribute('data-cp-day') === iso);
  cp_tlSync(root, iso);
  if (bi >= 0) {
    panels.forEach((p) => { p.hidden = true; });
    root.querySelectorAll('[data-cp-pane]').forEach((p) => { p.hidden = p.getAttribute('data-cp-pane') !== 'daily'; });
    root.querySelectorAll('[data-cp-view]').forEach((x) => x.setAttribute('aria-pressed', String(x.getAttribute('data-cp-view') === 'daily')));
    const cur = Math.max(0, briefs.findIndex((b) => !b.hidden));
    cp_step(root, bi - cur);
    return;
  }
  let target = null;
  const f = root.querySelector('[data-cp-frame]');
  if (f) { try { target = cp_tlFind(f.contentDocument, iso, Array.from(root.querySelectorAll('[data-cp-tlday]')).map((b) => b.getAttribute('data-cp-tlday'))); } catch (e) { target = null; } }
  if (target && typeof target.scrollIntoView === 'function') {
    panels.forEach((p) => { p.hidden = true; });
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  panels.forEach((p) => { p.hidden = p.getAttribute('data-cp-tlpanel') === iso ? !p.hidden : true; });
}

function conopV2(D, opts) {
  if (!D || typeof D !== 'object') return cp_head(null, typeof lockedText === 'string' ? lockedText : 'Waiting for authorized data.', false);
  const c = D.conop && typeof D.conop === 'object' ? D.conop : {};
  const m = D.meta && typeof D.meta === 'object' ? D.meta : {};
  const paras = cp_paras(D), S = cp_sched(D), P = cp_places(D), days = cp_opDays(D, S, cp_today(cp_tz(D), opts && opts.now));
  const hasHtml = cp_str(c.html).length > 0, hasPdf = !!(c.pdf && cp_str(c.pdf.b64).length);
  const shk = cp_flag('shackled');
  const sub = [cp_t(c.sub), cp_t(c.asOf)].filter(Boolean).join(' · ');
  if (!paras.length && !S.length && !hasHtml && !hasPdf) return `<div class="cp-root">${cp_head(D, 'No CONOP in this snapshot.', false)}</div>`;
  if (shk) return `<div class="cp-root">${cp_head(D, sub, false)}<div class="notice">CONOP is hidden in SHACKLE presentation mode.</div></div>`;
  const tz = cp_tzFound(D), zone = cp_tz(D), op = cp_t(m.project);
  if (hasHtml) {
    const pdf = hasPdf ? '<div class="cp-bar cp-noprint"><button class="btn primary cp-pdf" type="button" id="raspConopPdf">↓ Save CONOP PDF</button></div>' : '';
    const strip = cp_strip({ D, S, P, tz, zone, briefDay: '' }, opts && opts.now);
    return `<div class="cp-root cp-s5doc">${pdf}${strip}<iframe class="cp-frame cp-frame-full" data-cp-frame="1" title="${esc(op)} CONOP" sandbox="allow-same-origin"></iframe></div>`;
  }
  const ctx = { D, c, P, S, days, paras, op, tz, team: cp_team(m), status: cp_t(c.status),
    stamp: cp_stamp(m.lastSuccessAt, tz) || cp_t(m.snapshotLabel), zone, cur: cp_defaultDay(days, cp_today(zone, opts && opts.now)) };
  const showBrief = days.length > 0 || paras.length > 0;
  const week = days.length > 0;
  const toggle = week ? '<div class="cp-tog" role="group" aria-label="Daily or week view"><button type="button" class="cp-tb" data-cp-view="daily" aria-pressed="true">DAILY</button><button type="button" class="cp-tb" data-cp-view="week" aria-pressed="false">WEEK</button></div>' : '';
  const pdfBtn = hasPdf ? '<button class="btn primary cp-pdf" type="button" id="raspConopPdf">↓ Save CONOP PDF</button>' : '';
  const bar = toggle || pdfBtn ? `<div class="cp-bar cp-noprint">${toggle}${pdfBtn}</div>` : '';
  let daily = '';
  if (showBrief) {
    const n = days.length, cur = ctx.cur;
    const pick = n > 1 ? `<div class="cp-pick cp-noprint"><button type="button" class="cp-step" data-cp-step="-1" aria-label="Previous day"${cur <= 0 ? ' disabled' : ''}>‹</button>` +
      `<span class="cp-dl" data-cp-daylabel="1" aria-live="polite">${esc(cp_short(days[cur]))}</span>` +
      `<button type="button" class="cp-step" data-cp-step="1" aria-label="Next day"${cur >= n - 1 ? ' disabled' : ''}>›</button></div>` : '';
    const briefs = n ? days.map((d, i) => cp_brief(ctx, d, i)).join('') : cp_brief(Object.assign({}, ctx, { cur: -1 }), '', -1);
    daily = `<div class="cp-view" data-cp-pane="daily">${pick}${briefs}</div>`;
  }
  const weekPane = week ? `<div class="cp-view" data-cp-pane="week" hidden>${cp_week(ctx)}</div>` : '';
  const frame = hasHtml ? `<section class="cp-pub">${cp_h('PUBLISHED S5 PLAN')}${cp_t(c.asOf) ? `<div class="cp-status">${esc(cp_t(c.asOf))}</div>` : ''}` +
    `<iframe class="cp-frame" data-cp-frame="1" title="${esc(op)} S5 plan" sandbox="allow-same-origin"></iframe></section>` : '';
  const head = !showBrief ? cp_head(D, sub, false) : '';
  const strip = cp_strip(Object.assign({}, ctx, { briefDay: days[ctx.cur] || '' }), opts && opts.now);
  return `<div class="cp-root">${head}${bar}${strip}${daily}${weekPane}${frame}</div>`;
}

function cp_step(root, n) {
  const days = Array.from(root.querySelectorAll('[data-cp-day]')); if (!days.length) return;
  let i = days.findIndex((d) => !d.hidden); if (i < 0) i = 0;
  const j = Math.min(days.length - 1, Math.max(0, i + n));
  days.forEach((d, k) => { d.hidden = k !== j; });
  const lab = root.querySelector('[data-cp-daylabel]'); if (lab) lab.textContent = days[j].getAttribute('data-cp-label') || '';
  root.querySelectorAll('[data-cp-step]').forEach((b) => { b.disabled = Number(b.getAttribute('data-cp-step')) < 0 ? j === 0 : j === days.length - 1; });
  const iso = days[j].getAttribute('data-cp-day') || '';
  cp_tlSync(root, iso);
  if (cp_valid(iso) && !root.querySelector('[data-cp-tlday="' + iso + '"]')) cp_tlRebuild(root, iso);
  cp_tlScroll(root, null);
}
function cp_tlRebuild(root, iso) {
  const sec = root.querySelector('[data-cp-tlroot]'), bound = root.cpCtx;
  if (!sec || !bound || !bound.D || typeof sec.insertAdjacentHTML !== 'function') return;
  const D = bound.D, html = cp_strip({ D, S: cp_sched(D), P: cp_places(D), tz: cp_tzFound(D), zone: cp_tz(D), briefDay: iso }, bound.now);
  sec.insertAdjacentHTML('afterend', html);
  sec.remove();
  cp_tlScroll(root, null);
}
function conopV2Bind(rootEl, D, opts) {
  if (!rootEl || typeof rootEl.querySelector !== 'function') return;
  const c = D && D.conop;
  const f = rootEl.querySelector('[data-cp-frame]');
  if (f && c) {
    f.addEventListener('load', () => { try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 24) + 'px'; } catch (e) {   } });
    f.srcdoc = raspConopSanitize(cpd_clean(cp_flag('night') && cp_str(c.htmlNight).length ? cp_str(c.htmlNight) : cp_str(c.html), cpd_owners(D), !!(D && D.meta && D.meta.role === 'restricted')));
  }
  cp_tlScroll(rootEl, null);
  rootEl.cpCtx = { D, now: opts && opts.now };
  if (rootEl.cpBound) return;
  rootEl.cpBound = true;
  rootEl.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target : null; if (!t) return;
    const b = t.closest('[data-cp-view]');
    if (b) {
      const v = b.getAttribute('data-cp-view');
      rootEl.querySelectorAll('[data-cp-pane]').forEach((p) => { p.hidden = p.getAttribute('data-cp-pane') !== v; });
      rootEl.querySelectorAll('[data-cp-view]').forEach((x) => x.setAttribute('aria-pressed', String(x.getAttribute('data-cp-view') === v)));
      return;
    }
    const s = t.closest('[data-cp-step]');
    if (s) { if (!s.disabled) cp_step(rootEl, Number(s.getAttribute('data-cp-step')) || 0); return; }
    const k = t.closest('[data-cp-tlday]');
    if (k) cp_tlSelect(rootEl, k);
  });
}

/* ---- conop-declutter.js (pinned b5bdb554, r2 host patches, comments stripped) ---- */

const CPD_MAX = 400000;
const CPD_MAX_DEPTH = 64;
const CPD_H = '[-\\u2010\\u2011\\u2012\\u2013\\u2014\\uFF0D]';
const CPD_ANCHOR_TOK = new RegExp('^(?:S' + CPD_H + '[1-8]|D\\d' + CPD_H + 'D\\d(?:\\.(?:xlsx|txt|md|csv))?|EX\\d{2,4}|\\x52BCS' + CPD_H + '\\x4CIM' + CPD_H + '\\d{2,5})$');
const CPD_SUB_TOK = new RegExp('^(?:LOGS|T' + CPD_H + '\\d|D\\d|Q\\d|RD\\d{1,3}|[A-Z]{1,3}\\d{1,4}(?:(?::|' + CPD_H + ')[A-Z]{1,3}\\d{1,4})?|\\d{1,5})$');
const CPD_FILE_TOK = /^(?:[\w-]+\.(?:md|xlsx|xls|csv|json|txt)|GAPS(?:\.md)?)$/;
const CPD_PROSE_SEC = new RegExp('\\bS' + CPD_H + '([1-8])\\b', 'g');
const CPD_PLACE_WORD = /^(?:unit|building|block|room|suite|terminal|gate|level|floor|bay|hangar|hall|wing|zone|pier|lot|road|route|exit|dock|door|stand|apartment|flat|area|sector)$/i;
const CPD_OWNER_PREP = /^(?:until|by|from|with|to|per|awaiting|pending|via|ask|and|or|for|once|when|if|after|before)$/i;
const CPD_OWNER_OK = /^[A-Za-z .'\u2019,()&-]{1,60}$/;
const CPD_GENERIC_WORDS = new Set(['site', 'main', 'line', 'phone', 'tel', 'telephone', 'office', 'reception', 'switchboard', 'desk', 'front', 'general', 'number', 'no', 'facility', 'hotel', 'call', 'enquiries', 'inquiries']);
const CPD_GENERIC_IN = /\b(?:main line|switchboard|reception|front desk|general enquir\w*)\b/i;
const CPD_PHONE_SENT = /\b(?:site|main|reception|switchboard|office|front desk|facility)\s(?:phone|line|tel|telephone|number|no)\b/i;
const CPD_ACCT_CTX = /\b(?:accounts?|allow-?lists?|allow-?listed|usernames?|user ?ids?|logins?)\b/i;
const CPD_MEMBER_CLAUSE = /\b(?:assignment ID|never inferred|project code)\b/i;
const CPD_SRC_LABEL = /^(?:sources?|source basis|sourcing|refs?|references?|provenance|evidence basis)$|\b(?:source|provenance)$/i;
const CPD_RAW_TAGS = ['scr' + 'ipt', 'style', 'textarea'];
const CPD_BLOCK = new Set(['p', 'div', 'li', 'ul', 'ol', 'td', 'th', 'tr', 'table', 'thead', 'tbody', 'dd', 'dt', 'dl', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'details', 'summary', 'body', 'html', 'head', 'br', 'hr', 'figure', 'figcaption', 'blockquote', 'pre', 'form', 'fieldset', 'label', 'button', 'textarea', 'select', 'option', 'img', 'iframe', 'video', 'svg', 'canvas']);
const CPD_INLINE = new Set(['b', 'strong', 'i', 'em', 'u', 'span', 'small', 'a', 'code', 'mark', 'sub', 'sup', 'abbr', 'time', 'font', 'q', 's', 'cite']);
const CPD_WRAP = new Set(['p', 'li', 'span', 'div', 'a', 'b', 'strong', 'small', 'em', 'i']);
const CPD_CMT = '<' + '!--';
const CPD_GONE = '\u0000';
const CPD_GONE2 = '\uE003';
const CPD_CUT = '\uE002';
const CPD_FAIL_DOC = '<!doctype html><html><head><meta charset="utf-8"><title>CONOP</title></head><body><p>CONOP view unavailable on this device.</p></body></html>';

function cpd_counts() {
  return { tokens: 0, sourceTails: 0, gapsNotes: 0, placeholders: 0, notSourcedBlocks: 0, sourceBlocks: 0, emptyLines: 0, emptyBlocks: 0, statRowsCollapsed: 0, phonesRemoved: 0, ownersNamed: 0, accounts: 0, emails: 0, links: 0, memberBlocks: 0 };
}

function cpd_isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function cpd_lex(s) {
  const out = [], L = s.length;
  let i = 0, t0 = 0;
  const flush = (to) => { if (to > t0) out.push({ k: 't', v: s.slice(t0, to) }); };
  while (i < L) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    if (s.startsWith(CPD_CMT, lt)) {
      flush(lt);
      const e = s.indexOf('-->', lt + 4), end = e < 0 ? L : e + 3;
      out.push({ k: 'c', v: s.slice(lt, end) }); i = t0 = end; continue;
    }
    const c = s.charCodeAt(lt + 1), close = c === 47;
    if (!(cpd_isAlpha(c) || (close && cpd_isAlpha(s.charCodeAt(lt + 2))) || c === 33 || c === 63)) { i = lt + 1; continue; }
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) break;
    flush(lt);
    const v = s.slice(lt, gt + 1);
    let j = close ? 2 : 1, nm = '';
    if (cpd_isAlpha(v.charCodeAt(j))) { const st = j; let c2 = v.charCodeAt(j); while (j < v.length && (cpd_isAlpha(c2) || (c2 >= 48 && c2 <= 57) || c2 === 45 || c2 === 95)) c2 = v.charCodeAt(++j); nm = v.slice(st, j).toLowerCase(); }
    const tok = { k: 'g', v, name: nm, close, self: v.endsWith('/>') };
    out.push(tok); i = t0 = gt + 1;
    if (!close && nm && CPD_RAW_TAGS.includes(nm) && !tok.self) {
      const re = new RegExp('</' + nm + '(?=[\\s/>])', 'ig'); re.lastIndex = i;
      const m = re.exec(s), end = m ? m.index : L;
      if (end > i) out.push({ k: 'r', v: s.slice(i, end) });
      i = t0 = end;
    }
  }
  flush(L);
  return out;
}
const cpd_join = (toks) => { let o = ''; for (const t of toks) if (t) o += t.v; return o; };
function cpd_plain(html) {
  let o = '';
  for (const t of cpd_lex(String(html))) if (t.k === 't') o += t.v + ' '; else if (t.k === 'g') o += ' ';
  return o.replace(/&nbsp;|&#160;/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim();
}
const CPD_ATTR_RE = {};
function cpd_attr(tag, name) {
  const re = CPD_ATTR_RE[name] || (CPD_ATTR_RE[name] = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  const m = re.exec(tag);
  return m ? (m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : null;
}
function cpd_hasClass(open, cls) { const v = cpd_attr(open, 'class'); return v != null && v.split(/\s+/).includes(cls); }
function cpd_decode(s) {
  return String(s).replace(/&#0*64;|&#x0*40;|&commat;/gi, '@').replace(/&#0*46;|&#x0*2e;|&period;/gi, '.').replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}
const cpd_esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const cpd_isCode = (t) => CPD_ANCHOR_TOK.test(t) || CPD_SUB_TOK.test(t);
const cpd_isCodeW = (t) => CPD_ANCHOR_TOK.test(t) || (CPD_SUB_TOK.test(t) && /[A-Za-z]/.test(t)) || CPD_FILE_TOK.test(t);
const cpd_toks = (s) => s.split(/[\s/,·;]+/).filter(Boolean);
function cpd_trimP(t) {
  let a = 0, b = t.length;
  while (a < b && '([{"\''.includes(t.charAt(a))) a++;
  while (b > a && ')]}"\'.,:;'.includes(t.charAt(b - 1))) b--;
  return t.slice(a, b);
}
function cpd_rtrimSet(s, set) { let b = s.length; while (b > 0 && set.includes(s.charAt(b - 1))) b--; return s.slice(0, b); }
function cpd_ltrimSet(s, set) { let a = 0; while (a < s.length && set.includes(s.charAt(a))) a++; return s.slice(a); }
const CPD_WS = ' \t\r\n';
const cpd_cut = (s) => s.replace(/[ \t]+|\uE002/g, (m, off, str) => (m === CPD_CUT || str.charAt(off + m.length) === CPD_CUT ? '' : m));
function cpd_trail(t) { let i = t.length; while (i > 0 && CPD_WS.includes(t.charAt(i - 1))) i--; return t.slice(i); }
function cpd_lead(t) { let i = 0; while (i < t.length && CPD_WS.includes(t.charAt(i))) i++; return t.slice(0, i); }
function cpd_hasPhone(x) {
  const re = /\+?\(?\d[\d ().-]{5,24}\d/g;
  let m;
  while ((m = re.exec(x))) {
    const v = m[0], d = v.replace(/\D/g, '');
    if (d.length < 7 || d.length > 15 || /^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    if (v.charAt(0) === '+' || /\d[ ().-]{1,3}\d/.test(v)) return true;
  }
  return false;
}
function cpd_genericLabel(lab) {
  const s = cpd_trimP(cpd_rtrimSet(String(lab).trim(), ' :-–—|/·')).trim();
  if (!/[A-Za-z]/.test(s)) return true;
  if (CPD_GENERIC_IN.test(s)) return true;
  const w = s.toLowerCase().split(/[\s/:.,()-]+/).filter(Boolean);
  return w.length > 0 && w.every((x) => CPD_GENERIC_WORDS.has(x));
}
function cpd_isId(x) {
  if (/^[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+$/.test(x)) return true;
  if (!/^[A-Za-z][A-Za-z0-9._-]{1,31}$/.test(x)) return false;
  return /^[a-z0-9._-]+$/.test(x) || /[0-9._]/.test(x) || (/[a-z]/.test(x) && (x.match(/[A-Z]/g) || []).length >= 2);
}

function cpd_tidy(t) {
  let s = t;
  s = s.replace(/\([ \t\r\n,;:/·]*\)/g, '');
  for (let k = 0; k < 4; k++) s = s.replace(/([,;:/·])[ \t\r\n]*(?=[,;:/·.)]|$)/g, '');
  s = s.replace(/\([ \t\r\n,;:/·]+/g, '(');
  s = s.replace(/[ \t\r\n]+/g, (m, off, str) => (/[.,;:)!?]/.test(str.charAt(off + m.length)) ? '' : m));
  s = s.replace(/^[ \t\r\n]*[,;:/·]+[ \t\r\n]*/, '').replace(/[ \t]{2,}/g, ' ');
  return s;
}
function cpd_group(g, before, n, runHasAnchor, member) {
  if (!/[A-Za-z0-9]/.test(g.dir)) return '(' + g.full + ')';
  const toks = cpd_toks(g.dir).map(cpd_trimP).filter(Boolean);
  const anchor = toks.some((t) => CPD_ANCHOR_TOK.test(t)), file = toks.some((t) => CPD_FILE_TOK.test(t));
  const keep = '(' + g.full + ')';
  if (!anchor && !file) {
    if (!toks.length || !toks.every((t) => /^[A-Z]{1,2}\d{2}$/.test(t))) return keep;
    if (runHasAnchor) { n.tokens++; return CPD_CUT; }
    if (member && toks.length === 1 && /^P\d{2,3}$/.test(toks[0])) {
      const w = (/([A-Za-z][A-Za-z'\u2019-]{0,30})[ \t]{0,3}$/.exec(before) || [])[1] || '';
      if (/^[A-Z]/.test(w) && !CPD_PLACE_WORD.test(w)) { n.tokens++; return CPD_CUT; }
    }
    return keep;
  }
  if (toks.every((t) => cpd_isCode(t) || CPD_FILE_TOK.test(t))) { n.tokens++; return CPD_CUT; }
  if (g.kept) return keep;
  const segs = g.full.split(/[;,]/);
  const kept = segs.filter((x) => { const t = cpd_toks(x).map(cpd_trimP).filter(Boolean); return !(t.length && t.every((y) => cpd_isCode(y) || CPD_FILE_TOK.test(y))); })
    .map((x) => cpd_rtrimSet(cpd_ltrimSet(x.split(/([\s/]+)/).filter((y) => !cpd_isCodeW(cpd_trimP(y))).join(''), ' \t\r\n/'), ' \t\r\n/'))
    .filter(Boolean);
  n.tokens++;
  if (!kept.length) return CPD_CUT;
  return '(' + kept.join(g.full.includes(';') ? '; ' : ', ') + ')';
}
function cpd_parens(s, n, runHasAnchor, member) {
  if (s.indexOf('(') < 0 || s.indexOf(')') < 0) return s;
  const re = /[()]/g, st = [];
  let cur = { full: '', dir: '', tail: '', kept: false }, last = 0, m;
  const put = (f, piece) => { f.full += piece; f.dir += piece; f.tail = (f.tail + piece).slice(-40); };
  while ((m = re.exec(s))) {
    put(cur, s.slice(last, m.index)); last = m.index + 1;
    if (m[0] === '(') { st.push(cur); cur = { full: '', dir: '', tail: '', kept: false }; continue; }
    if (!st.length) { put(cur, ')'); continue; }
    const g = cur; cur = st.pop();
    const rep = cpd_group(g, cur.tail, n, runHasAnchor, member);
    const repTail = rep === CPD_CUT || rep.length < 80 ? rep : (g.tail + ')').slice(-40);
    cur.full += rep; cur.dir += ' '; cur.tail = (cur.tail + repTail).slice(-40);
    if (rep !== CPD_CUT) cur.kept = true;
  }
  put(cur, s.slice(last));
  while (st.length) { const g = cur; cur = st.pop(); cur.full += '(' + g.full; }
  return cur.full;
}
const CPD_TAG_SN = new RegExp('\\bS' + CPD_H + '[1-8][ \\t]{0,8}:[ \\t]{0,8}', 'g');
const CPD_TAG_TRAIL = new RegExp('[·/|][ \\t]{0,8}S' + CPD_H + '[1-8](?=[ \\t]{0,8}(?:$|[.;,)]))', 'g');
const CPD_MEMBER_CLAUSE_G = new RegExp(CPD_MEMBER_CLAUSE.source, 'gi');
function cpd_tags(s, n) {
  const c = s.indexOf(':');
  if (c > 0) {
    const head = s.slice(0, c), toks = cpd_toks(head);
    if (toks.length && toks.every(cpd_isCode) && toks.some((t) => CPD_ANCHOR_TOK.test(t))) { n.tokens++; s = cpd_ltrimSet(s.slice(c + 1), ' \t'); }
  }
  s = s.replace(CPD_TAG_SN, () => { n.tokens++; return ''; });
  s = s.replace(CPD_TAG_TRAIL, () => { n.tokens++; return CPD_CUT; });
  return s;
}
function cpd_sentStart(s, at) { let i = at; while (i > 0 && CPD_WS.includes(s.charAt(i - 1))) i--; return i === 0 || '.;!?'.includes(s.charAt(i - 1)); }
function cpd_sources(s, n) {
  const re = /(^|[\s.;(])((?:Sources?|Refs?|References?)[ \t]{0,8}:[ \t]{0,8})/gi, dot = /\.(?=\s|$)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    const at = m.index + m[1].length, from = at + m[2].length;
    dot.lastIndex = from; const d = dot.exec(s), end = d ? d.index : s.length;
    const clause = s.slice(from, end);
    const toks = cpd_toks(clause.replace(/\([^()]*\)/g, ' ').replace(/;/g, ' ')).map(cpd_trimP);
    if (!toks.some(cpd_isCodeW)) { out += s.slice(last, end); last = end; re.lastIndex = end; continue; }
    const kept = clause.split(';').map((g) => {
      const t = cpd_toks(g.replace(/\([^()]*\)/g, ' ')).map(cpd_trimP).filter(Boolean);
      if (t.some(cpd_isCodeW) && t.every((x) => cpd_isCode(x) || CPD_FILE_TOK.test(x) || /^(?:rows?|section|clause|claims?|item|para(?:graph)?|and|or|&)$/i.test(x))) return '';
      let r = g.split(/([\s/,·]+)/).filter((x) => !cpd_isCodeW(cpd_trimP(x))).join('').replace(/\([ \t,;:/]*\)/g, '');
      r = cpd_ltrimSet(r, ' \t\r\n,/');
      r = r.replace(/^(?:and|or|&)[ \t]+/i, '');
      return r.trim();
    }).filter((g) => /[A-Za-z0-9]/.test(g)).join('; ');
    n.sourceTails++;
    out += s.slice(last, at) + (kept ? m[2] : '') + kept;
    last = end; re.lastIndex = end;
    if (!kept && s.charAt(end) === '.' && cpd_sentStart(s, at)) { last = end + 1; re.lastIndex = end + 1; }
  }
  return out + s.slice(last);
}
function cpd_prose(s, n, owners) {
  return s.replace(CPD_PROSE_SEC, (m, k, off, str) => {
    const before = str.slice(Math.max(0, off - 48), off), prev = (/([A-Za-z]{1,30})[ \t]{0,8}$/.exec(before) || [])[1] || '';
    if (CPD_PLACE_WORD.test(prev)) return m;
    const next = str.slice(off + m.length, off + m.length + 8), subj = /^[ \t]{1,4}[a-z]/.test(next);
    const startSent = /[.;!?:][ \t]{0,8}$/.test(before) || (off <= 8 && /^[ \t\r\n]*$/.test(before));
    if (before && !CPD_WS.includes(before.charAt(before.length - 1))) return m;
    if (!CPD_OWNER_PREP.test(prev) && !(subj && startSent)) return m;
    const raw = owners && typeof owners[k] === 'string' ? owners[k].trim() : '';
    const o = raw && CPD_OWNER_OK.test(raw) && /[A-Za-z]/.test(raw) ? cpd_esc(raw) : 'the section owner';
    n.ownersNamed++;
    return startSent ? o.charAt(0).toUpperCase() + o.slice(1) : o;
  });
}
const cpd_tailTok = (t) => /^(?:RD\d{1,3}|[A-Z]\d{1,4}|[A-Z]{2}\d{2}|LOGS|Q\d)$/.test(t) || /^[A-Z]{1,2}\d{1,4}[:\-–][A-Z]{1,2}\d{1,4}$/.test(t);
const cpd_rideTok = (t) => /^\d{2,5}$/.test(t) || CPD_FILE_TOK.test(t) || /^[A-Z][a-z]+(?:[A-Z][a-z]+){2,}$/.test(t);
function cpd_tailrefs(s, n) {
  const parts = s.split(/([\s,;/·]+|\([^()]{0,80}\))/);
  let i = parts.length - 1, k = 0, strong = false, lc = false;
  while (i >= 0) {
    const p = parts[i];
    if (!p || /^[\s,;/·]+$/.test(p)) { i--; continue; }
    if (p.charAt(0) === '(' && p.charAt(p.length - 1) === ')') { if (/[a-z]{2}/.test(p)) lc = true; else if (/^\(\s*\)$/.test(p)) strong = true; i--; continue; }
    if (CPD_ANCHOR_TOK.test(p)) { k++; strong = true; i--; continue; }
    if (cpd_rideTok(p)) { i--; continue; }
    if (!cpd_tailTok(p)) break;
    k++; if (/^RD\d/.test(p)) strong = true; i--;
  }
  if (!k || !strong || (lc && k < 3)) return s;
  const head = parts.slice(0, i + 1).join(''), h = cpd_rtrimSet(head, CPD_WS);
  if (h && !'.!?'.includes(h.charAt(h.length - 1))) return s;
  n.tokens++;
  return cpd_rtrimSet(head, ' \t\r\n,;/·');
}
function cpd_ranges(s, n, runHasAnchor) {
  if (runHasAnchor) return s.replace(/\b[A-Z]{1,2}\d{2}(?:[ \t]{0,2}[-‐‑–][ \t]{0,2}[A-Z]{1,2}\d{2}[ \t]{1,3}(?=(?:dates?|TBD)\b)|[ \t]{1,3}(?=dates?\b))/g, () => { n.tokens++; return ''; });
  const m = /^([ \t\r\n]{0,8})[A-Z]{1,2}\d{2}[ \t]{0,2}[-‐‑–][ \t]{0,2}[A-Z]{1,2}\d{2}[ \t]{1,3}(?=(?:dates?|TBD)\b)/.exec(s);
  if (!m) return s;
  n.tokens++;
  const r = s.slice(m[0].length);
  return m[1] + r.charAt(0).toUpperCase() + r.slice(1);
}
function cpd_accounts(s, n) {
  if (!CPD_ACCT_CTX.test(s)) return s;
  s = s.replace(/\(([^()]{0,400})\)/g, (m, inner) => {
    const items = inner.split(/[,;]|\band\b/).map((x) => x.trim()).filter(Boolean);
    const ids = items.filter(cpd_isId);
    if (!ids.length) return m;
    n.accounts++;
    const rest = items.filter((x) => !cpd_isId(x));
    return rest.length ? '(' + rest.join(inner.includes(';') ? '; ' : ', ') + ')' : CPD_CUT;
  });
  return s.replace(/\b(accounts?|allow-?lists?|usernames?|logins?)[ \t]{0,4}:[ \t]{0,4}((?:[^.;:()]|\.(?=\w)){1,400})(\.?)/gi, (m, lab, list, dot, off, str) => {
    const items = list.split(/,|\band\b/).map((x) => x.trim()).filter(Boolean);
    if (!items.length || !items.every(cpd_isId)) return m;
    n.accounts++;
    return cpd_sentStart(str, off) ? CPD_CUT : lab + dot;
  });
}
function cpd_emails(s, n) {
  return s.replace(/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g, () => { n.emails++; return CPD_CUT; })
    .replace(/(?<![\w.+-])[\w.+-]{1,64}[ \t]?[[(][ \t]?at[ \t]?[\])][ \t]?[\w-]{1,63}(?:[ \t]?(?:[[(][ \t]?dot[ \t]?[\])]|\.)[ \t]?[\w-]{1,63})+/gi, () => { n.emails++; return CPD_CUT; });
}
const cpd_hasEmail = (s) => { const d = cpd_decode(s); return /[\w.+-]@[\w-]{1,63}\.[\w-]/.test(d) || /\w[ \t]?[[(][ \t]?at[ \t]?[\])][ \t]?[\w-]{1,63}[ \t]?(?:[[(][ \t]?dot[ \t]?[\])]|\.)[ \t]?\w/i.test(d); };
function cpd_memberClauses(s, n) {
  const re = CPD_MEMBER_CLAUSE_G; re.lastIndex = 0;
  let out = '', last = 0, m;
  while ((m = re.exec(s))) {
    let a = m.index; while (a > last && !'.;!?'.includes(s.charAt(a - 1))) a--;
    let b = m.index + m[0].length; while (b < s.length && !'.;!?'.includes(s.charAt(b))) b++;
    out += s.slice(last, a) + CPD_CUT; last = b; re.lastIndex = b; n.tokens++;
  }
  return out + s.slice(last);
}
function cpd_phoneSent(s, n) {
  const ctx = (x) => CPD_PHONE_SENT.test(x) || CPD_GENERIC_IN.test(x);
  if (!ctx(s) || !cpd_hasPhone(s)) return s;
  return s.split(/(?<=[.;!?])[ \t]+/).filter((x) => { const hit = ctx(x) && cpd_hasPhone(x); if (hit) n.phonesRemoved++; return !hit; }).join(' ');
}
const CPD_TRIGGER = /[\d(@[&:]|\b(?:Sources?|Refs?|References?|GAPS|accounts?|allow-?list\w*|usernames?|user ?ids?|logins?|assignment|inferred|project code)\b/i;
function cpd_text(t, n, owners, member) {
  if (!t || !/\S/.test(t) || !CPD_TRIGGER.test(t)) return t;
  const ents = [];
  const lead = cpd_lead(t), trail = cpd_trail(t);
  let s = member ? t.replace(/&#0*64;|&#x0*40;|&commat;/gi, '@').replace(/&#0*46;|&#x0*2e;|&period;/gi, '.') : t;
  const nbspEnt = /&nbsp;|&#160;|&#xa0;/i.test(s);
  s = s.replace(/&#(?:820[89]|821[012]|x201[0-4]);|&(?:hyphen|dash|ndash|mdash);/gi, (e) => ({ hyphen: '\u2010', dash: '\u2010', ndash: '\u2013', mdash: '\u2014' }[e.slice(1, -1).toLowerCase()] || String.fromCharCode(e.charAt(2).toLowerCase() === 'x' ? parseInt(e.slice(3, -1), 16) : +e.slice(2, -1))))
    .replace(/&nbsp;|&#160;|&#xa0;/gi, '\u00A0');
  s = s.replace(/&(?:#\d{1,7}|#x[0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/g, (e) => { ents.push(e); return '\uE000' + (ents.length - 1) + '\uE001'; });
  const before = s, sum = () => n.tokens + n.sourceTails + n.gapsNotes + n.ownersNamed + n.phonesRemoved + n.accounts + n.emails, c0 = sum();
  s = cpd_accounts(s, n);
  if (member) { s = cpd_emails(s, n); s = cpd_memberClauses(s, n); }
  s = cpd_phoneSent(s, n);
  s = s.replace(/\bSee GAPS\.md\b[^.]{0,400}\.?/g, () => { n.gapsNotes++; return CPD_CUT; });
  const runHasAnchor = cpd_toks(s.replace(/[()]/g, ' ')).some((x) => CPD_ANCHOR_TOK.test(cpd_trimP(x)));
  for (let r = 0, q = null; r < 4 && q !== s; r++) {
    q = s;
    s = cpd_cut(cpd_parens(s, n, runHasAnchor, member));
    s = cpd_sources(s, n);
    s = cpd_tags(s, n);
    s = cpd_ranges(s, n, runHasAnchor);
    s = cpd_cut(s);
    s = cpd_tailrefs(s, n);
    s = cpd_prose(s, n, owners);
    s = cpd_cut(s);
    if (s !== q) s = cpd_tidy(s);
  }
  if (s === before && c0 === sum()) return t;
  s = cpd_tidy(s).trim().replace(/\uE000(\d+)\uE001/g, (m, i) => ents[+i]);
  if (nbspEnt) s = s.replace(/\u00A0/g, '&nbsp;');
  return s ? lead + s + trail : CPD_GONE;
}
function cpd_texts(html, n, owners, member) {
  const t = cpd_lex(html);
  for (const k of t) if (k.k === 't') k.v = cpd_text(k.v, n, owners, member);
  return cpd_join(t);
}

function cpd_elements(s, n, member) {
  const t = cpd_lex(s);
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    if (!k || k.k !== 'g' || k.close) continue;
    if (k.name === 'meta' && /^\s*refresh\s*$/i.test(cpd_attr(k.v, 'http-equiv') || '')) { t[i] = null; n.links++; continue; }
    if (!member) continue;
    if (k.name === 'a') {
      let j = i + 1; while (j < t.length && j < i + 4000 && !(t[j] && t[j].k === 'g' && t[j].name === 'a')) j++;
      const end = j < t.length && t[j] && t[j].k === 'g' && t[j].name === 'a' && t[j].close ? j : -1;
      const href = (cpd_attr(k.v, 'href') || '').trim();
      let txt = ''; if (end > 0) for (let x = i + 1; x < end; x++) if (t[x] && t[x].k === 't') txt += t[x].v;
      const mail = /^mailto:/i.test(cpd_decode(href)), gdoc = /^(?:https?:)?\/\/(?:docs|drive|sheets)\.google\.com(?:[/?#:]|$)/i.test(href), internal = /\(\s*internal\s*\)/i.test(cpd_decode(txt));
      if (mail || gdoc || internal) {
        if (mail) n.emails++; else n.links++;
        const to = end > 0 ? end : i;
        for (let x = i; x <= to; x++) t[x] = null;
        t[i] = { k: 't', v: CPD_GONE2 };
        i = to; continue;
      }
    }
    if (/@|&#0*64;|&#x0*40;|&commat;/i.test(k.v) && cpd_hasEmail(k.v)) {
      const head = k.v.slice(0, Math.min(1 + k.name.length, k.v.length)), body = k.v.slice(head.length);
      const nb = body.replace(/(?<!\s)(\s+)([^\s"'>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g, (m, sp, nm, val) => (val && cpd_hasEmail(val) ? (n.emails++, '') : m));
      k.v = head + nb;
    }
  }
  return cpd_join(t);
}
function cpd_tels(s, n) {
  const t = cpd_lex(s);
  const isBound = (k) => k.k === 'g' && (CPD_BLOCK.has(k.name) || k.name === 'a' || !CPD_INLINE.has(k.name));
  for (let i = 0; i < t.length; i++) {
    const k = t[i];
    if (!k || k.k !== 'g' || k.close || k.name !== 'a' || !/^\s*tel:/i.test(cpd_attr(k.v, 'href') || '')) continue;
    let j = i + 1; while (j < t.length && j < i + 200 && !(t[j] && t[j].k === 'g' && t[j].name === 'a')) j++;
    const end = j < t.length && t[j] && t[j].k === 'g' && t[j].name === 'a' && t[j].close ? j : i;
    let own = ''; for (let x = i + 1; x < end; x++) if (t[x] && t[x].k === 't') own += t[x].v;
    let a = i - 1, lab = '';
    for (; a >= 0 && a > i - 200; a--) { const p = t[a]; if (!p) continue; if (p.k === 'c') continue; if (p.k !== 't' && isBound(p)) break; if (p.k === 't') lab = p.v + lab; }
    const labStart = a + 1;
    const plainLab = cpd_decode(lab).replace(/[\u0000\uE003]/g, ' ');
    const cut = Math.max(plainLab.lastIndexOf('. '), plainLab.lastIndexOf('; '), plainLab.lastIndexOf('! '), plainLab.lastIndexOf('? '));
    const clause = cut >= 0 ? plainLab.slice(cut + 2) : plainLab;
    const label = /[A-Za-z]/.test(cpd_decode(own)) ? clause + ' ' + cpd_decode(own) : clause;
    if (/[A-Za-z]/.test(cpd_decode(own)) && !cpd_genericLabel(cpd_decode(own))) continue;
    if (!cpd_genericLabel(label)) continue;
    n.phonesRemoved++;
    for (let x = i; x <= end; x++) t[x] = null;
    if (cut < 0) { for (let x = labStart; x < i; x++) if (t[x] && t[x].k !== 'c') t[x] = null; }
    else {
      for (let x = i - 1; x >= labStart; x--) {
        if (!t[x] || t[x].k !== 't') continue;
        const v = t[x].v, c2 = Math.max(v.lastIndexOf('. '), v.lastIndexOf('; '), v.lastIndexOf('! '), v.lastIndexOf('? '));
        if (c2 >= 0) { t[x].v = v.slice(0, c2 + 1); break; }
        t[x] = null;
      }
    }
    t[i] = { k: 't', v: CPD_GONE2 };
    i = end;
  }
  return cpd_join(t);
}
function cpd_runs(s, n, owners, member) {
  const t = cpd_lex(s), out = [];
  let run = [];
  const flushRun = () => {
    if (run.length > 1 && run.some((x) => x.k === 'g')) {
      let raw = ''; for (const x of run) if (x.k === 't') raw += x.v;
      const plain = cpd_decode(raw);
      const acct = CPD_ACCT_CTX.test(plain) && cpd_accounts(plain, cpd_counts()) !== plain;
      if (acct || (member && cpd_hasEmail(plain))) {
        const c = cpd_text(cpd_esc(plain), n, owners, member);
        out.push({ k: 't', v: c === CPD_GONE ? CPD_GONE2 : c });
        run = []; return;
      }
    }
    for (const x of run) out.push(x);
    run = [];
  };
  for (const k of t) {
    if (k.k === 't' || (k.k === 'g' && CPD_INLINE.has(k.name))) { run.push(k); continue; }
    flushRun(); out.push(k);
  }
  flushRun();
  return cpd_join(out);
}
function cpd_dropEmpty(s, n, textFn) {
  const t = cpd_lex(s), root = { name: '', open: '', body: '', mark: false, other: false }, st = [root];
  const finish = (f, close) => {
    const p = st[st.length - 1];
    if (!f.other && (f.mark || (f.name === 'a' && close))) { n.emptyLines++; p.mark = true; return; }
    p.body += f.open + f.body + close; p.other = true;
  };
  for (const k of t) {
    const f = st[st.length - 1];
    if (k.k === 't' && textFn) k.v = textFn(k.v);
    if (k.k === 't') { f.body += k.v; if (k.v.indexOf(CPD_GONE) >= 0 || k.v.indexOf(CPD_GONE2) >= 0) f.mark = true; if (/[^\s\u0000\uE003]/.test(k.v)) f.other = true; continue; }
    if (k.k === 'g' && k.name && CPD_WRAP.has(k.name) && !k.self) {
      if (!k.close) {
        if ((k.name === 'p' || k.name === 'li') && f.name === k.name) finish(st.pop(), '');
        st.push({ name: k.name, open: k.v, body: '', mark: false, other: false }); continue;
      }
      let d = st.length - 1; const lim = Math.max(1, st.length - 64);
      while (d >= lim && st[d].name !== k.name) d--;
      if (d < lim) { f.body += k.v; f.other = true; continue; }
      while (st.length - 1 > d) finish(st.pop(), '');
      finish(st.pop(), k.v); continue;
    }
    f.body += k.v; f.other = true;
  }
  while (st.length > 1) finish(st.pop(), '');
  return root.body.replace(/\u0000/g, ' ').replace(/\uE003/g, '');
}

function cpd_blocks(html, tag, fn) {
  const s = html, toks = cpd_lex(s), root = { kids: [] }, stack = [root];
  let pos = 0;
  for (const k of toks) {
    const at = pos; pos += k.v.length;
    if (k.k !== 'g' || k.name !== tag || k.self) continue;
    if (!k.close) {
      if (stack.length > CPD_MAX_DEPTH) throw new Error('cpd: nesting');
      stack.push({ start: at, openEnd: pos, kids: [], parent: stack[stack.length - 1] });
    } else if (stack.length > 1) { const node = stack.pop(); node.innerEnd = at; node.end = pos; node.parent.kids.push(node); }
  }
  while (stack.length > 1) { const node = stack.pop(); for (const c of node.kids) node.parent.kids.push(c); }
  const out = [], work = [{ at: 0, to: s.length, kids: root.kids.sort((a, b) => a.start - b.start), i: 0, close: '' }];
  while (work.length) {
    const f = work[work.length - 1];
    if (f.i >= f.kids.length) { out.push(s.slice(f.at, f.to), f.close); work.pop(); continue; }
    const k = f.kids[f.i++];
    if (k.start < f.at) continue;
    out.push(s.slice(f.at, k.start)); f.at = k.end;
    const rep = fn(s.slice(k.start, k.openEnd), s.slice(k.openEnd, k.innerEnd), k.start, k.end);
    if (rep != null) { out.push(rep); continue; }
    out.push(s.slice(k.start, k.openEnd));
    work.push({ at: k.openEnd, to: k.innerEnd, kids: k.kids.sort((a, b) => a.start - b.start), i: 0, close: s.slice(k.innerEnd, k.end) });
  }
  return out.join('');
}
function cpd_summary(inner) {
  const st = /^\s*<summary\b[^>]*>/i.exec(inner);
  if (!st) return { label: '', hasB: false, body: inner };
  const e = inner.toLowerCase().indexOf('</summary>', st[0].length);
  if (e < 0) return { label: '', hasB: false, body: inner };
  const sum = inner.slice(st[0].length, e), body = inner.slice(e + 10);
  const b = sum.length <= 2000 ? /^\s*<(b|strong)\b[^>]*>([\s\S]{0,400}?)<\/\1>/i.exec(sum) || /<(b|strong)\b[^>]{0,200}>([^<]{0,400})<\/\1>/i.exec(sum) : null;
  return { label: b ? cpd_rtrimSet(cpd_plain(b[2]), ' +') : '', hasB: !!b, body };
}
function cpd_onlyRefs(body) {
  const t = cpd_toks(cpd_plain(body).replace(/\([^()]*\)/g, ' ').replace(/\b(?:Sources?|Refs?|References?)\s{0,4}:/gi, ' ').replace(/[;:+]|\.(?=\s|$)/g, ' ')).map(cpd_trimP).filter(Boolean);
  return t.length > 0 && t.every((x) => cpd_isCode(x) || CPD_FILE_TOK.test(x) || /^(?:rows?|section|clause|claims?|item|para(?:graph)?|and|or|&|[-–])$/i.test(x));
}
function cpd_cites(body) { return cpd_toks(cpd_plain(body)).map(cpd_trimP).some((x) => CPD_ANCHOR_TOK.test(x) || CPD_FILE_TOK.test(x) || /^[\w-]+\.(?:xlsx|xls|csv|json|md|txt)$/i.test(x)); }
function cpd_owners(D) {
  const o = {};
  const m = D && D.sectionOwners && typeof D.sectionOwners === 'object' ? D.sectionOwners : null;
  for (let k = 1; k <= 8; k++) {
    const v = m ? m[k] : (D && Array.isArray(D.sections) && D.sections[k] && D.sections[k].owner);
    if (typeof v === 'string' && /[A-Za-z]/.test(v) && CPD_OWNER_OK.test(v.trim())) o[k] = v.trim();
  }
  return o;
}

function cpd_report(html, owners, member) {
  const n = cpd_counts();
  let s = typeof html === 'string' ? html : (Array.isArray(html) ? html.join('') : (html == null ? '' : String(html)));
  if (!s) return { html: s, counts: n };
  if (s.length > CPD_MAX) throw new Error('cpd: input too large');
  s = s.replace(/[\u0000\uE000-\uE003]/g, (c) => (c === '\u0000' ? '' : '&#x' + c.charCodeAt(0).toString(16).toUpperCase() + ';'));
  member = !!member;
  if (/<meta\b/i.test(s) || (member && /<a\b|@|&#0*64;|&#x0*40;|&commat;/i.test(s))) s = cpd_elements(s, n, member);
  if (/placeholder|NOT SOURCED/i.test(s)) s = cpd_blocks(s, 'div', (open, inner) => {
    const b = /^\s*<(b|strong)\b[^>]*>([\s\S]{0,400}?)<\/\1>/i.exec(inner);
    if (cpd_hasClass(open, 'placeholder') || (b && /\/\s*NOT SOURCED\s*$/i.test(cpd_plain(b[2])))) { n.placeholders++; return ''; }
    return null;
  });
  const hasDetails = /<details\b/i.test(s);
  if (hasDetails) s = cpd_blocks(s, 'details', (open, inner) => {
    const x = cpd_summary(inner);
    if (x.hasB && CPD_SRC_LABEL.test(x.label) && (member || cpd_onlyRefs(x.body))) { n.sourceBlocks++; return ''; }
    if (/^NOT SOURCED\b/i.test(cpd_plain(x.body.slice(0, 600)))) { n.notSourcedBlocks++; return ''; }
    return null;
  });
  if (/statrow/i.test(s)) s = cpd_blocks(s, 'div', (open, inner) => {
    if (!cpd_hasClass(open, 'statrow')) return null;
    const cells = [];
    cpd_blocks(inner, 'div', (o2, in2) => { const v = /^\s*<(b|strong)\b[^>]*>([\s\S]{0,400}?)<\/\1>([\s\S]*)$/i.exec(in2); cells.push(v ? { v: cpd_plain(v[2]), l: cpd_plain(v[3]) } : { v: cpd_plain(in2), l: '' }); return ''; });
    if (!cells.length || !cells.every((c) => c.v === 'TBD')) return null;
    const labels = cells.map((c) => c.l.toLowerCase()).filter(Boolean).join(' / ');
    n.statRowsCollapsed++;
    return '<p class="cpd-tbd">' + (labels ? labels.charAt(0).toUpperCase() + labels.slice(1) + ' dates' : 'Dates') + ': TBD</p>';
  });
  const needRuns = CPD_ACCT_CTX.test(s) || (member && /@|&#0*64;|&#x0*40;|&commat;|[[(][ \t]?at[ \t]?[\])]/i.test(s)), needTels = /tel:/i.test(s);
  if (needRuns || needTels) {
    s = cpd_texts(s, n, owners, member);
    if (needRuns) s = cpd_runs(s, n, owners, member);
    if (needTels) s = cpd_tels(s, n);
    s = cpd_dropEmpty(s, n);
  } else s = cpd_dropEmpty(s, n, (v) => cpd_text(v, n, owners, member));
  if (hasDetails) s = cpd_blocks(s, 'details', (open, inner) => {
    const x = cpd_summary(inner);
    if (!/[A-Za-z0-9]/.test(cpd_plain(x.body))) { n.emptyBlocks++; return ''; }
    if (member && cpd_cites(x.body)) { n.memberBlocks++; return ''; }
    return null;
  });
  if (member && cpd_hasEmail(s)) throw new Error('cpd: member email left');
  return { html: s, counts: n };
}
let cpd_memo = { k: null, o: '', v: '' };
function cpd_clean(html, owners, member) {
  const k = typeof html === 'string' ? html : null, ok = (owners ? JSON.stringify(owners) : '') + (member ? '|m' : '');
  if (k !== null && cpd_memo.k === k && cpd_memo.o === ok) return cpd_memo.v;
  let v;
  try { v = cpd_report(html, owners, member).html; }
  catch (e) { v = member ? CPD_FAIL_DOC : (typeof html === 'string' ? html : Array.isArray(html) ? html.join('') : ''); }
  if (k !== null) cpd_memo = { k, o: ok, v };
  return v;
}

/* ---- host-forget.js (r2 host, lock clears module state, comments stripped) ---- */
function raspOpsForget(roots) {
  sr_ctx = { D: null, rerender: null };
  sr_state.day = null; sr_state.from = 0; sr_state.to = 24;
  rb_mem = null;
  if (rb_timer) clearInterval(rb_timer);
  rb_timer = 0;
  if (rb_ro) { try { rb_ro.disconnect(); } catch (e) {   } }
  rb_ro = null;
  cpd_memo = { k: null, o: '', v: '' };
  for (const r of roots || []) if (r) r.cpCtx = null;
  /./.exec(' ');
}

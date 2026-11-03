// src/primitives.mjs
var encoder = new TextEncoder();
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
async function sha(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// client/offline.mjs
var clone = (value) => structuredClone(value);
var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function surveyOnly(input) {
  const { formId, formSourceSha256, catalogSha256, counts, answers, sourceIds } = input;
  return clone({ formId, formSourceSha256, catalogSha256, counts, answers, sourceIds });
}
function mergeMap(base, local, remote) {
  const merged = { ...remote };
  const conflicts = [];
  for (const key of /* @__PURE__ */ new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (same(base[key], local[key])) continue;
    if (!same(base[key], remote[key]) && !same(local[key], remote[key])) {
      conflicts.push(key);
      continue;
    }
    if (Object.hasOwn(local, key)) merged[key] = local[key];
    else delete merged[key];
  }
  return { merged, conflicts };
}
function mergeRecord(base, local, remote) {
  const { merged, conflicts } = mergeMap(base.answers, local.answers, remote.answers);
  const countMerge = mergeMap(base.counts ?? {}, local.counts ?? {}, remote.counts ?? {});
  conflicts.push(...countMerge.conflicts.map((key) => "counts." + key));
  for (const field of ["formId", "formSourceSha256", "catalogSha256"]) if (local[field] !== remote[field]) conflicts.push(field);
  let sourceIds = remote.sourceIds;
  if (!same(base.sourceIds, local.sourceIds)) {
    if (!same(base.sourceIds, remote.sourceIds) && !same(local.sourceIds, remote.sourceIds)) conflicts.push("sourceIds");
    else sourceIds = local.sourceIds;
  }
  return { answers: merged, counts: countMerge.merged, sourceIds, conflicts };
}
function state() {
  return { head: { revision: 0, counts: {}, answers: {}, sourceIds: [] }, draft: { counts: {}, answers: {}, sourceIds: [] }, queue: [], conflicts: [], receipts: [], originals: {} };
}
var ENTRY_MODEL = "author-append/1";
var emptyHead = () => ({ revision: 0, counts: {}, answers: {}, sourceIds: [] });
var remoteOf = (record) => ({ ...record, sourceIds: record.provenance.map((p) => p.mediaId) });
// R1 (review RECORDS-APPEND-R2-CLIENT): this item's OWN changes (local vs its base), applied onto `onto`. Used when the
// member has no own entry yet (record:null), so values the item did not change (another member's pre-install answers in
// the shared legacy head) are never re-attributed to this member. Deletions remove the key; sourceIds: own adds/removes.
function ownDelta(base, local, onto) {
  const apply = (b = {}, l = {}, o = {}) => {
    const out = { ...o };
    for (const k of /* @__PURE__ */ new Set([...Object.keys(b), ...Object.keys(l)])) {
      if (same(b[k], l[k])) continue;
      if (Object.hasOwn(l, k)) out[k] = l[k];
      else delete out[k];
    }
    return out;
  };
  const b = base.sourceIds ?? [], l = local.sourceIds ?? [], o = onto.sourceIds ?? [];
  const sourceIds = [...o.filter((id) => !b.includes(id) || l.includes(id)), ...l.filter((id) => !b.includes(id) && !o.includes(id))];
  return { answers: apply(base.answers, local.answers, onto.answers), counts: apply(base.counts, local.counts, onto.counts), sourceIds, conflicts: [] };
}
// F1 (client-r2 fix review): an answer on row r >= 1 of group g needs counts[g] >= r + 1 (server: CATALOG_FIELD_UNKNOWN
// otherwise). ownDelta drops an UNCHANGED count, and a merge can take a smaller remote count; raise it to fit the answers.
function fitCounts(answers, counts) {
  const out = { ...counts };
  for (const key of Object.keys(answers ?? {})) {
    const [g, r] = key.split(".").map(Number);
    if (Number.isSafeInteger(g) && Number.isSafeInteger(r) && r >= 1 && (out[g] ?? 1) < r + 1) out[g] = r + 1;
  }
  return out;
}
// Re-base queued items in order onto `remote` (the member's own head) or, when null, onto an empty own entry (ownDelta).
// Item i is merged from its ORIGINAL base onto its re-based predecessor. Item 0 with a remote always gets a new id; any
// other item gets a new id only when its content changed. Returns the re-based prefix and the first conflict (if any).
function rebaseQueue(queue, remote) {
  const newBase = remote?.revision ?? 0, next = [];
  let prev = remote ?? emptyHead(), conflict = null;
  for (const item of queue) {
    const merge = remote ? mergeRecord(item.base, item.payload, prev) : ownDelta(item.base, item.payload, prev);
    if (merge.conflicts.length) { conflict = merge; break; }
    const merged = { answers: merge.answers, counts: fitCounts(merge.answers, merge.counts), sourceIds: merge.sourceIds };
    const changed = canonical(merged) !== canonical({ answers: item.payload.answers, counts: item.payload.counts, sourceIds: item.payload.sourceIds });
    const payload = { ...item.payload, baseRevision: newBase + next.length, ...merged, ...(changed || remote && !next.length ? { mutationId: crypto.randomUUID() } : {}) };
    next.push({ base: clone(prev), payload });
    prev = payload;
  }
  return { next, conflict };
}
var SyncError = class extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
};
var OfflineWorkspace = class {
  constructor({ database, session, fetcher = fetch, baseURL = "", now = () => Date.now() }) {
    if (!session?.selected?.projectId || !session.selected.siteId || !session.actor) throw new SyncError("PREVIOUS_AUTHORIZED_WORKSPACE_REQUIRED");
    const partition = JSON.stringify([session.actor, session.selected.projectId, session.selected.siteId]);
    if (!(session.offlineUntil > now()) && !database.isUnlocked?.(partition)) throw new SyncError("LOCAL_UNLOCK_REQUIRED");
    this.db = database;
    this.session = clone(session);
    Object.freeze(this.session.selected);
    Object.freeze(this.session);
    this.fetcher = (...args) => fetcher(...args);
    this.baseURL = baseURL;
    this.now = now;
    this.generation = 0;
    this.closed = false;
    this.partition = JSON.stringify([session.actor, session.selected.projectId, session.selected.siteId]);
  }
  close() {
    this.closed = true;
    this.generation++;
  }
  check(generation = this.generation, online = false) {
    if (this.closed || this.generation !== generation) throw new SyncError("WORKSPACE_CHANGED");
    if (this.now() >= this.session.offlineUntil && (online || !this.db.isUnlocked?.(this.partition))) throw new SyncError(online ? "ONLINE_REAUTHENTICATION_REQUIRED" : "LOCAL_UNLOCK_REQUIRED");
  }
  key(recordId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(recordId)) throw new SyncError("INVALID_RECORD_ID");
    return this.partition + ":" + recordId;
  }
  async read(recordId) {
    const generation = this.generation;
    this.check(generation);
    const row = await this.db.get(this.key(recordId));
    this.check(generation);
    return row ?? state();
  }
  async directory() {
    const generation = this.generation;
    this.check(generation);
    const row = await this.db.get(this.partition + ":@record-directory");
    this.check(generation);
    return row ?? { records: {} };
  }
  async discover(cursor = null) {
    const generation = this.generation;
    const page = await this.request("record-directory", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cursor }) }, generation);
    if (page.projectId !== this.session.selected.projectId || page.siteId !== this.session.selected.siteId || page.scopeHash !== this.session.selected.scopeHash || !Array.isArray(page.records)) throw new SyncError("RESPONSE_SCOPE_MISMATCH");
    for (const ref of page.records) if (!/^[A-Za-z0-9_-]{1,80}$/.test(ref.recordId) || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || ref.actors !== void 0 && (!Array.isArray(ref.actors) || !ref.actors.every((a) => typeof a === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a))) || ref.latestAt !== void 0 && typeof ref.latestAt !== "string") throw new SyncError("DIRECTORY_RESPONSE_INVALID");
    await this.db.update(this.partition + ":@record-directory", (previous) => {
      this.check(generation);
      const row = previous ?? { records: {} };
      for (const ref of page.records) {
        const prev = row.records[ref.recordId];
        if (!prev || (prev.revision ?? 0) < ref.revision || (ref.latestAt ?? "") > (prev.latestAt ?? "") || (ref.actors?.length ?? 0) > (prev.actors?.length ?? 0)) row.records[ref.recordId] = ref;
      }
      return row;
    }, { guard: () => this.check(generation) });
    this.check(generation);
    return page;
  }
  async save(recordId, survey) {
    const generation = this.generation;
    this.check(generation);
    const { actor, selected } = this.session;
    return this.db.update(this.key(recordId), (previous) => {
      this.check(generation);
      const row = previous ?? state();
      // R5: a save that lands while a conflict is pending would be discarded by resolveConflict; refuse it (draft kept).
      if (row.conflicts?.length) throw new SyncError("CONFLICT_PENDING");
      const base = row.queue.at(-1)?.payload ?? row.head;
      const payload = { projectId: selected.projectId, siteId: selected.siteId, actor, recordId, mutationId: crypto.randomUUID(), baseRevision: row.head.revision + row.queue.length, ...surveyOnly(survey) };
      row.queue.push({ payload, base: clone(base) });
      row.draft = clone(survey);
      return row;
    }, { guard: () => this.check(generation) });
  }
  async stageOriginal(recordId, mediaId, blob) {
    const generation = this.generation;
    this.check(generation);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(mediaId) || blob.size > 5 * 1024 * 1024) throw new SyncError("INVALID_ORIGINAL");
    const bytes = await blob.arrayBuffer();
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.check(generation);
    return this.db.update(this.key(recordId), (previous) => {
      this.check(generation);
      const row = previous ?? state();
      if (row.originals[mediaId] && row.originals[mediaId].sha256 !== sha256) throw new SyncError("MEDIA_ID_CONFLICT");
      row.originals[mediaId] ??= { blob, sha256, receipt: null };
      return row;
    }, { guard: () => this.check(generation) });
  }
  headers() {
    return { "x-rasp-csrf": this.session.csrf, "x-rasp-actor": this.session.actor, "x-rasp-project": this.session.selected.projectId, "x-rasp-site": this.session.selected.siteId };
  }
  async request(path, init, generation) {
    this.check(generation, true);
    const response = await this.fetcher(this.baseURL + "/api/beta/" + path, { ...init, credentials: "same-origin", cache: "no-store", headers: { ...this.headers(), ...init?.headers } });
    this.check(generation);
    const body = await response.json();
    this.check(generation);
    if (!response.ok) throw new SyncError(body.error ?? "SYNC_FAILED", response.status);
    return body;
  }
  checkRecord(recordId, record) {
    const { projectId, siteId } = this.session.selected;
    if (record && (record.recordId !== recordId || record.projectId !== projectId || record.siteId !== siteId || record.scopeHash !== this.session.selected.scopeHash || !Number.isSafeInteger(record.revision))) throw new SyncError("RESPONSE_SCOPE_MISMATCH");
  }
  // Author-append read shape: `record` is the caller's OWN head (or null); `entries`/`cells` carry every author's head.
  checkOwn(recordId, latest) {
    this.checkRecord(recordId, latest.record);
    if (latest.record && latest.record.actor !== this.session.actor) throw new SyncError("RESPONSE_SCOPE_MISMATCH");
  }
  // A stored head that is not this member's own author-append entry (pre-install shared-chain head, or legacy replay).
  foreignHead(head) {
    return (head?.revision ?? 0) > 0 && (head.actor !== this.session.actor || head.entryModel !== ENTRY_MODEL);
  }
  // R2: only an r2 (author-append) server may be written through this client; an old shared-chain server fails closed.
  requireModel(latest) {
    if (latest?.entryModel !== ENTRY_MODEL) throw new SyncError("SERVER_MODEL_MISMATCH");
  }
  authorsOf(recordId, latest) {
    if (latest.entries === void 0 && latest.cells === void 0) return null;
    const actor = this.session.actor, okActor = (a) => typeof a === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(a);
    if (!Array.isArray(latest.entries) || !latest.cells || typeof latest.cells !== "object" || Array.isArray(latest.cells)) throw new SyncError("RESPONSE_AUTHORS_INVALID");
    for (const e of latest.entries) {
      this.checkRecord(recordId, e);
      if (!e || !okActor(e.actor) || e.mine !== (e.actor === actor) || e.chain !== "author" && e.chain !== "legacy") throw new SyncError("RESPONSE_AUTHORS_INVALID");
    }
    for (const [field, list] of Object.entries(latest.cells)) {
      if (!Array.isArray(list) || !list.every((c) => c && okActor(c.actor) && c.mine === (c.actor === actor) && Number.isSafeInteger(c.revision) && (typeof c.value === "string" || typeof c.value === "number" || typeof c.value === "boolean"))) throw new SyncError("RESPONSE_AUTHORS_INVALID");
    }
    const entries = latest.entries.map((e) => ({ actor: e.actor, mine: e.mine, chain: e.chain, revision: e.revision, createdAt: e.createdAt, receiptId: e.receiptId, formId: e.formId, formSourceSha256: e.formSourceSha256, catalogSha256: e.catalogSha256 }));
    return { entryModel: latest.entryModel ?? null, entries, cells: clone(latest.cells), others: entries.filter((e) => !e.mine).length };
  }
  async sync(recordId) {
    this.check();
    const run = () => this.syncLocked(recordId);
    if (globalThis.navigator?.locks) return navigator.locks.request(this.key(recordId), run);
    if (this.running) throw new SyncError("SYNC_ALREADY_RUNNING");
    this.running = true;
    try {
      return await run();
    } finally {
      this.running = false;
    }
  }
  async syncLocked(recordId) {
    const generation = this.generation;
    let snapshot = await this.read(recordId);
    for (const [mediaId, original] of Object.entries(snapshot.originals)) {
      if (original.receipt) continue;
      const result = await this.request("originals/" + mediaId, { method: "PUT", headers: { "content-type": original.blob.type || "application/octet-stream", "x-content-sha256": original.sha256 }, body: original.blob }, generation);
      const receipt = result.original;
      if (receipt.mediaId !== mediaId || receipt.sha256 !== original.sha256 || receipt.actor !== this.session.actor || receipt.projectId !== this.session.selected.projectId || receipt.siteId !== this.session.selected.siteId) throw new SyncError("RESPONSE_SCOPE_MISMATCH");
      await this.db.update(this.key(recordId), (row) => {
        this.check(generation);
        row.originals[mediaId].receipt = receipt;
        return row;
      }, { guard: () => this.check(generation) });
    }
    let rebases = 0;
    for (; ; ) {
      this.check(generation);
      snapshot = await this.read(recordId);
      const queued = snapshot.queue[0];
      if (!queued || snapshot.conflicts.length) break;
      try {
        // G1 (client-r2 fix review round 2): a queue built on a head that is NOT this member's own author-chain entry
        // (pre-install shared head) carries a legacy baseRevision. Never POST it: if that number happens to equal the
        // member's own-chain revision the r2 server would accept it (no 409) and store the legacy snapshot as the
        // member's own entry. Take the C2 migration path (GET + own-delta re-base) directly instead.
        if (this.foreignHead(snapshot.head)) throw new SyncError("BASE_REVISION_MISSING");
        const result = await this.request("records/" + recordId, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(queued.payload) }, generation);
        if (!result.record) throw new SyncError("RECEIPT_PAYLOAD_MISMATCH");
        this.checkRecord(recordId, result.record);
        if (result.record.mutationId !== queued.payload.mutationId || result.record.actor !== this.session.actor) throw new SyncError("RESPONSE_MUTATION_MISMATCH");
        const expectedRevision = queued.payload.baseRevision + 1;
        // C1: author-append entries are keyed per author; a replayed pre-install commit keeps the legacy receipt (r2 F3).
        const expectedReceipt = result.record.entryModel === ENTRY_MODEL ? await sha(canonical(["rasp-author-entry/1", this.session.selected.scopeHash, recordId, this.session.actor, expectedRevision])) : await sha(canonical([this.session.selected.scopeHash, recordId, expectedRevision]));
        const sourceIds = result.record.provenance?.map((p) => p.mediaId);
        if (result.record.version !== 1 || result.record.revision !== expectedRevision || result.record.receiptId !== expectedReceipt || result.record.classification !== "attributed_unverified_observation" || result.record.mutationHash !== await sha(canonical(queued.payload)) || canonical(result.record.answers) !== canonical(queued.payload.answers) || canonical(result.record.counts) !== canonical(queued.payload.counts) || canonical(sourceIds) !== canonical(queued.payload.sourceIds) || ["formId", "formSourceSha256", "catalogSha256"].some((key) => result.record[key] !== queued.payload[key]) || !result.record.provenance.every((p) => p.scopeHash === this.session.selected.scopeHash && /^[a-f0-9]{64}$/.test(p.sha256))) throw new SyncError("RECEIPT_PAYLOAD_MISMATCH");
        // R2: a reply without entryModel is accepted (legacy receipt, a replayed pre-install commit) only once a GET
        // proves the server is r2. The old server's own receipt is identical, so without this check it would pass.
        if (result.record.entryModel !== ENTRY_MODEL) this.requireModel(await this.request("records/" + recordId, { method: "GET" }, generation));
        this.check(generation);
        await this.db.update(this.key(recordId), (row) => {
          this.check(generation);
          if (row.queue[0]?.payload.mutationId !== queued.payload.mutationId) throw new SyncError("LOCAL_QUEUE_CHANGED");
          row.head = { ...result.record, sourceIds: result.record.provenance.map((p) => p.mediaId) };
          row.receipts.push(result.record.receiptId);
          row.queue.shift();
          return row;
        }, { guard: () => this.check(generation) });
      } catch (error) {
        if (error.code !== "REVISION_CONFLICT" && error.code !== "BASE_REVISION_MISSING" && error.code !== "MUTATION_ID_CONFLICT") throw error;
        const latest = await this.request("records/" + recordId, { method: "GET" }, generation);
        this.requireModel(latest);
        this.checkOwn(recordId, latest);
        const authors = this.authorsOf(recordId, latest);
        if (error.code === "REVISION_CONFLICT") {
          if (!latest.record || latest.record.revision <= queued.payload.baseRevision) throw new SyncError("SERVER_HEAD_NOT_CURRENT");
          const remote = remoteOf(latest.record);
          await this.db.update(this.key(recordId), (row) => {
            this.check(generation);
            if (row.queue[0]?.payload.mutationId !== queued.payload.mutationId) throw new SyncError("LOCAL_QUEUE_CHANGED");
            if (authors) row.authors = authors;
            // R4: re-base queue[0] AND the later items onto their re-based predecessor (one 409 for the whole queue).
            // A conflict on queue[0] is shown as before; a conflict first raised by a later item stops the rebase there:
            // that item and the rest keep their bases and get their own 409 + three-way merge later (old behaviour).
            const { next, conflict } = rebaseQueue(row.queue, remote);
            if (!next.length) {
              // As in C2: the one conflict shown carries the device's LAST snapshot (cumulative three-way from queue[0]'s
              // base), so resolving it (which replaces the queue) never drops a later queued answer. Single item: unchanged.
              // G2: if queue[0] was built on a non-own (legacy) head, offer only the member's own changes (as F5).
              const full = row.queue.at(-1).payload, own = this.foreignHead(queued.base) ? ownDelta(queued.base, full, remote) : null;
              const last = own ? { ...full, answers: own.answers, counts: fitCounts(own.answers, own.counts), sourceIds: own.sourceIds } : full;
              const cumulative = mergeRecord(queued.base, last, remote);
              row.conflicts = [{ fields: cumulative.conflicts.length ? cumulative.conflicts : conflict.conflicts, base: queued.base, local: last, remote }];
              return row;
            }
            row.queue = [...next, ...row.queue.slice(next.length)];
            if (!conflict) { const last = next.at(-1).payload; row.draft = { ...row.draft, answers: clone(last.answers), counts: clone(last.counts), sourceIds: clone(last.sourceIds) }; }
            return row;
          }, { guard: () => this.check(generation) });
        } else if (error.code === "MUTATION_ID_CONFLICT") {
          // C2a: the id is bound to other content on the server. Committed already (lost reply) -> adopt it as the head and
          // shift it off; otherwise resend the same content under a NEW id.
          await this.db.update(this.key(recordId), (row) => {
            this.check(generation);
            if (row.queue[0]?.payload.mutationId !== queued.payload.mutationId) throw new SyncError("LOCAL_QUEUE_CHANGED");
            if (authors) row.authors = authors;
            if (latest.record && latest.record.mutationId === queued.payload.mutationId) {
              row.head = remoteOf(latest.record);
              row.receipts.push(latest.record.receiptId);
              row.queue.shift();
            } else row.queue[0] = { base: queued.base, payload: { ...queued.payload, mutationId: crypto.randomUUID() } };
            return row;
          }, { guard: () => this.check(generation) });
        } else {
          // C2 (migration to author-scoped chains, records-append r2 INSTALL C2): the stored head/base is not in this
          // member's own chain (pre-install shared-chain head, or another member's revision). Re-base EVERY queued item,
          // in order, onto the member's own head, or 0 when the member has no entry yet. Remote null (R1): each item
          // carries only the member's OWN changes from its old base (unchanged legacy values, which may be another
          // member's answers, stay in the legacy entry and are never re-attributed); new id only where content changed.
          // Own head present: the C3 merge + conflict step, and NEW ids for changed content. Later items are merged
          // onto their re-based predecessor too, so a stale device never silently replaces the member's newer edits from
          // another device (review F4). No queued answer is dropped: on any conflict the device's last snapshot is the
          // `local` side of the one conflict shown.
          const remote = latest.record ? remoteOf(latest.record) : null;
          await this.db.update(this.key(recordId), (row) => {
            this.check(generation);
            if (row.queue.length !== snapshot.queue.length || row.queue.some((q, i) => q.payload.mutationId !== snapshot.queue[i].payload.mutationId)) throw new SyncError("LOCAL_QUEUE_CHANGED");
            if (authors) row.authors = authors;
            const { next, conflict } = rebaseQueue(row.queue, remote);
            if (conflict) {
              // F5: the `local` side shown is the member's OWN changes (from the old shared base) over their own head, so
              // choosing "This device" can never import another member's legacy answers or photo ids.
              const full = row.queue.at(-1).payload, own = ownDelta(row.queue[0].base, full, remote);
              const last = { ...full, answers: own.answers, counts: fitCounts(own.answers, own.counts), sourceIds: own.sourceIds };
              const cumulative = mergeRecord(row.queue[0].base, last, remote);
              row.conflicts = [{ fields: cumulative.conflicts.length ? cumulative.conflicts : conflict.conflicts, base: row.queue[0].base, local: last, remote }];
              row.head = clone(remote);
              return row;
            }
            row.queue = next;
            row.head = remote ? clone(remote) : emptyHead();
            const last = next.at(-1).payload;
            row.draft = { ...row.draft, formId: last.formId, formSourceSha256: last.formSourceSha256, catalogSha256: last.catalogSha256, answers: clone(last.answers), counts: clone(last.counts), sourceIds: clone(last.sourceIds) };
            return row;
          }, { guard: () => this.check(generation) });
        }
        if (++rebases >= 3) throw new SyncError("CONCURRENT_EDITS_RETRY_REQUIRED");
      }
    }
    if (!snapshot.queue.length && !snapshot.conflicts.length) {
      const latest = await this.request("records/" + recordId, { method: "GET" }, generation);
      if (latest.projectId !== this.session.selected.projectId || latest.siteId !== this.session.selected.siteId) throw new SyncError("RESPONSE_SCOPE_MISMATCH");
      this.requireModel(latest);   // F4: never adopt an old-server shared head as the member's own
      this.checkOwn(recordId, latest);
      const authors = this.authorsOf(recordId, latest);
      if (latest.record || authors) await this.db.update(this.key(recordId), (previous) => {
        this.check(generation);
        const row = previous ?? state();
        if (authors) row.authors = authors;
        // A local head that is not this member's own author-chain entry (pre-install shared head) never outranks the
        // member's own server head, and is never shown as the member's own answers.
        const foreign = row.head.revision > 0 && (row.head.actor !== this.session.actor || row.head.entryModel !== ENTRY_MODEL);
        if (!row.queue.length && latest.record && (latest.record.revision >= row.head.revision || foreign)) {
          row.head = remoteOf(latest.record);
          row.draft = { formId: row.head.formId, formSourceSha256: row.head.formSourceSha256, catalogSha256: row.head.catalogSha256, counts: row.head.counts, answers: row.head.answers, sourceIds: row.head.sourceIds };
        } else if (!row.queue.length && !latest.record && (foreign || row.head.revision === 0 && authors?.entries.length)) {
          // C4: record:null = this member has no entry yet. Other members' entries live in row.authors (shown side by
          // side); the member's own draft starts empty, bound to the same instrument as the shared entries.
          const first = authors?.entries[0];
          row.head = emptyHead();
          row.draft = { counts: {}, answers: {}, sourceIds: [], ...(first ? { formId: first.formId, formSourceSha256: first.formSourceSha256, catalogSha256: first.catalogSha256 } : {}) };
        }
        return row;
      }, { guard: () => this.check(generation) });
    }
    this.check(generation);
    return this.read(recordId);
  }
  async resolveConflict(recordId, survey) {
    const generation = this.generation;
    this.check(generation);
    return this.db.update(this.key(recordId), (row) => {
      this.check(generation);
      if (row?.conflicts.length !== 1) throw new SyncError("NO_CONFLICT");
      const remote = row.conflicts[0].remote;
      row.resolvedConflicts ??= [];
      row.resolvedConflicts.push(clone(row.conflicts[0]));
      row.queue = [{ base: clone(remote), payload: { projectId: this.session.selected.projectId, siteId: this.session.selected.siteId, actor: this.session.actor, recordId, mutationId: crypto.randomUUID(), baseRevision: remote.revision, ...surveyOnly(survey) } }];
      row.conflicts = [];
      row.draft = clone(survey);
      return row;
    }, { guard: () => this.check(generation) });
  }
};
export {
  OfflineWorkspace,
  SyncError,
  mergeRecord
};

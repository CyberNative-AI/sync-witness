const { Plugin, Modal, Notice, PluginSettingTab, Setting, TFile, TFolder, TextFileView, setIcon } = require('obsidian');
const core = require('./core');
const { Store } = require('./store');
const { installWritePatches } = require('./patch');

const INTENT_TTL_MS = 15000;
const CREATION_TTL_MS = 30000;
const SOURCE_LABEL = {
  outside: 'outside Obsidian',
  plugin: 'by a plugin, not by you',
  closed: 'while Obsidian was closed',
};
const KIND_LABEL = {
  removed: 'Removed',
  emptied: 'Emptied',
  'rolled-back': 'Older version',
  shrunk: 'Text lost',
};

async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayTimeOf(ms) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? timeOf(ms) : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${timeOf(ms)}`;
}

class RestoreRace extends Error {}

module.exports = class SyncWitness extends Plugin {
  async onload() {
    this.settings = Object.assign({}, core.DEFAULTS, await this.loadData());
    this.store = new Store(`sync-witness-${this.app.appId}`);
    await this.store.open();
    this.files = new Map();
    this.incidents = [];
    this.activity = [];
    this.intents = [];
    this.writeSources = {};
    this.userDeletes = [];
    this.restoring = new Map();
    this.pendingRemovals = new Map();
    this.pendingObservations = [];
    this.recentCreations = new Map();
    this.queue = Promise.resolve();
    this.ready = false;
    this.openModals = new Set();
    this.unpatches = [];

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('sync-witness-status');
    this.statusEl.addEventListener('click', () => this.openLatestOrLog());
    this.renderStatus('Starting');
    this.addRibbonIcon('shield-check', 'Sync Witness: incidents and activity', () => this.openLog());
    this.addCommand({ id: 'show-log', name: 'Show incidents and activity', callback: () => this.openLog() });
    this.addCommand({ id: 'check-now', name: 'Check the vault now', callback: () => {
      if (this.stopped) new Notice('Sync Witness is off until Obsidian restarts: stored copies were cleared.');
      else this.enqueue(() => this.reconcile('manual'));
    } });
    this.addSettingTab(new SyncWitnessSettings(this.app, this));

    this.patchWrites();
    this.app.workspace.onLayoutReady(() => this.enqueue(() => this.start()));
  }

  onunload() {
    for (const undo of this.unpatches.reverse()) undo();
    for (const m of [...this.openModals]) m.close();
    clearTimeout(this.judgeTimer);
    if (this.ready && !this.stopped) this.store.setMeta('lastSeenAt', Date.now()).finally(() => this.store.close());
    else this.store.close();
  }

  enqueue(task) {
    this.queue = this.queue.then(() => (this.stopped ? null : task())).catch((e) => console.error('Sync Witness', e));
    return this.queue;
  }

  // ---- Attribution: remember what this app itself wrote or deleted, and why. -----------------

  patchWrites() {
    const writeSource = (path, data) => {
      if (this.restoring.has(path)) return 'restore';
      if (typeof data === 'string' && this.editorIsSaving(path, data)) return 'editor';
      return 'plugin';
    };
    // Every hook runs inside a guard: a failure here is logged and the user's own call still runs.
    this.unpatches.push(...installWritePatches(this.app.vault.adapter, this.app.fileManager, {
      write: (path, data) => this.noteWrite(path, writeSource(path, data), data),
      append: (path) => this.noteWrite(path, 'plugin', null),
      remove: (path) => this.noteDelete(path),
      rename: (from, to) => this.intents.push({ path: from, to, kind: 'rename', source: 'plugin', at: Date.now() }),
      userDelete: (file) => { if (file && file.path) this.userDeletes.push({ path: file.path, at: Date.now() }); },
      onError: (e) => console.error('Sync Witness: bookkeeping failed; the original call still ran.', e),
    }));
  }

  editorIsSaving(path, data) {
    let hit = false;
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      if (v instanceof TextFileView && v.file && v.file.path === path && v.saving && v.lastSavedData === data) hit = true;
    });
    return hit;
  }

  noteWrite(path, source, data) {
    this.writeSources[source] = (this.writeSources[source] || 0) + 1;
    const intent = { path, kind: 'write', source, at: Date.now(), hash: data == null ? null : sha256(data) };
    intent.hash && intent.hash.catch(() => {});
    this.intents.push(intent);
    this.pruneIntents();
  }

  noteDelete(path) {
    const now = Date.now();
    const user = this.userDeletes.some((u) => now - u.at < INTENT_TTL_MS && (u.path === path || path.startsWith(u.path + '/') || u.path.startsWith(path + '/')));
    this.intents.push({ path, kind: 'delete', source: user ? 'user' : 'plugin', at: now });
    this.pruneIntents();
  }

  pruneIntents() {
    const cutoff = Date.now() - INTENT_TTL_MS;
    this.intents = this.intents.filter((i) => i.at >= cutoff);
    this.userDeletes = this.userDeletes.filter((i) => i.at >= cutoff);
  }

  async writeSourceFor(path, hash) {
    this.pruneIntents();
    let fallback = null;
    for (let i = this.intents.length - 1; i >= 0; i--) {
      const it = this.intents[i];
      if (it.kind !== 'write' || it.path !== path) continue;
      if (it.hash == null) { fallback = fallback || it.source; continue; }
      if ((await it.hash) === hash) return it.source;
    }
    return fallback || 'outside';
  }

  deleteSourceFor(path) {
    this.pruneIntents();
    const now = Date.now();
    for (let i = this.intents.length - 1; i >= 0; i--) {
      const it = this.intents[i];
      if (it.kind !== 'delete') continue;
      if (it.path === path || path.startsWith(it.path + '/')) return it.source;
    }
    // A delete through the file explorer that did not reach the adapter patch (other adapters).
    if (this.userDeletes.some((u) => now - u.at < INTENT_TTL_MS && (u.path === path || path.startsWith(u.path + '/')))) return 'user';
    return 'outside';
  }

  // ---- Inventory --------------------------------------------------------------------------------

  async start() {
    for (const row of await this.store.all('files')) this.files.set(row.path, row);
    this.incidents = (await this.store.all('incidents')).sort((a, b) => a.startedAt - b.startedAt);
    this.activity = await this.store.getMeta('activity', []);
    const initialized = await this.store.getMeta('initialized', false);
    if (!initialized) await this.firstInventory();
    else await this.reconcile('startup');
    this.ready = true;
    this.registerEvent(this.app.vault.on('create', (f) => f instanceof TFile && this.enqueue(() => this.onCreate(f))));
    this.registerEvent(this.app.vault.on('modify', (f) => f instanceof TFile && this.enqueue(() => this.onModify(f))));
    this.registerEvent(this.app.vault.on('delete', (f) => this.onDeleteEvent(f)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.enqueue(() => this.onRename(f, old))));
    this.registerInterval(window.setInterval(() => this.store.setMeta('lastSeenAt', Date.now()), 60000));
    this.registerInterval(window.setInterval(() => this.enqueue(() => this.collectGarbage()), 10 * 60000));
    await this.store.setMeta('lastSeenAt', Date.now());
    await this.collectGarbage();
    this.renderStatus();
    const unseen = this.incidents.filter((i) => !i.seen && i.severity === 'high' && this.openItems(i).length);
    if (unseen.length) this.showIncident(unseen[unseen.length - 1]);
  }

  // ---- Stored copies ----------------------------------------------------------------------------
  // Every copy this device holds, by hash: current versions, copies waiting to be judged and copies
  // kept for incidents. The attachment space limit covers all attachment copies among them.

  referencedCopies() {
    const copies = new Map();
    const add = (hash, size, path, holder) => {
      if (!hash) return;
      const c = copies.get(hash) || { size, text: core.isText(path), holders: [] };
      c.holders.push(holder);
      copies.set(hash, c);
    };
    for (const e of this.files.values()) if (e.copied) add(e.hash, e.size, e.path, 'current');
    for (const r of this.pendingRemovals.values()) if (r.entry.copied) add(r.entry.hash, r.entry.size, r.entry.path, 'pending');
    for (const o of this.pendingObservations) add(o.restoreHash, o.size, o.path, 'pending');
    for (const inc of this.incidents) {
      for (const it of inc.items) add(it.restoreHash, it.size, it.path, it.resolved ? 'resolved' : inc.dismissed ? 'dismissed' : 'open');
    }
    return copies;
  }

  attachmentBytes() {
    let n = 0;
    for (const c of this.referencedCopies().values()) if (!c.text) n += c.size;
    return n;
  }

  // Frees attachment space by dropping copies that only dismissed incidents (or already restored
  // items) still hold, oldest dismissal first, until `needed` bytes fit. Open incidents keep theirs.
  // Then, only when `evictCurrent` (the limit was lowered), copies of current attachment versions,
  // least recently changed first. Every dropped copy is marked, so nothing claims it is still safe.
  async makeRoom(needed, evictCurrent) {
    const cap = this.settings.attachmentTotalCapMB * 1024 * 1024;
    const copies = this.referencedCopies();
    let used = 0;
    for (const c of copies.values()) if (!c.text) used += c.size;
    if (used + needed <= cap) return true;
    const freeable = (c) => !c.text && c.holders.every((h) => h === 'dismissed' || h === 'resolved');
    const items = [];
    for (const inc of this.incidents) {
      for (const it of inc.items) {
        const c = it.restoreHash && copies.get(it.restoreHash);
        if (c && freeable(c)) items.push({ inc, it, order: inc.dismissed || inc.lastAt });
      }
    }
    items.sort((a, b) => a.order - b.order);
    const drop = new Set();
    const touched = new Set();
    let fromIncidents = 0;
    for (const { inc, it } of items) {
      if (used + needed <= cap) break;
      if (!drop.has(it.restoreHash)) { drop.add(it.restoreHash); used -= copies.get(it.restoreHash).size; fromIncidents++; }
    }
    for (const { inc, it } of items) {
      if (!drop.has(it.restoreHash)) continue;
      it.restoreHash = null;
      it.evicted = Date.now();
      touched.add(inc);
    }
    const uncopied = [];
    if (evictCurrent && used + needed > cap) {
      const current = [...this.files.values()].filter((e) => e.copied && !core.isText(e.path) && copies.get(e.hash).holders.every((h) => h !== 'open' && h !== 'pending'));
      for (const e of current.sort((a, b) => a.mtime - b.mtime)) {
        if (used + needed <= cap) break;
        e.copied = false;
        uncopied.push(e);
        if (!drop.has(e.hash)) { drop.add(e.hash); used -= copies.get(e.hash).size; }
      }
      for (const inc of this.incidents) for (const it of inc.items) {
        if (it.restoreHash && drop.has(it.restoreHash)) { it.restoreHash = null; it.evicted = Date.now(); touched.add(inc); }
      }
    }
    if (!drop.size) return false;
    await this.store.putMany('incidents', [...touched]);
    await this.store.putMany('files', uncopied);
    await this.store.deleteMany('blobs', [...drop]);
    if (fromIncidents) this.logActivity(`Removed ${core.plural(fromIncidents, 'copy', 'copies')} from dismissed incidents to make space`);
    if (uncopied.length) this.logActivity(`Over the attachment limit: stopped keeping copies of ${core.plural(uncopied.length, 'attachment')}`);
    this.refreshModals();
    return used + needed <= cap;
  }

  // Deletes the copies of earlier versions that nothing refers to any more.
  async releaseCopies(hashes) {
    const copies = this.referencedCopies();
    const stale = hashes.filter((h) => h && !copies.has(h));
    if (stale.length) await this.store.deleteMany('blobs', stale);
  }

  async capture(file, previous) {
    const data = await this.app.vault.adapter.readBinary(file.path);
    const hash = await sha256(data);
    const size = data.byteLength;
    const entry = {
      path: file.path,
      size,
      mtime: file.stat ? file.stat.mtime : Date.now(),
      hash,
      copied: false,
      history: previous ? (previous.history || []).slice() : [],
      settled: previous ? (previous.settled || []).slice() : [],
      local: previous ? (previous.local || []).slice() : [],
      since: previous && previous.hash === hash ? previous.since : Date.now(),
      origin: previous && previous.hash === hash ? previous.origin : null,
    };
    if (previous && previous.hash !== hash) Object.assign(entry, core.rememberVersion(previous, hash, Date.now(), this.settings));
    const copies = this.referencedCopies();
    let inUse = 0;
    for (const c of copies.values()) if (!c.text) inUse += c.size;
    if (copies.has(hash)) inUse -= size; // the same bytes are already stored: no extra space
    // Temporary allowance: the version this replaces does not count while only this file holds it,
    // because it is released once judged. If it becomes an incident's copy instead, the limit is
    // enforced again as soon as the incident is recorded (makeRoom after record).
    const prev = previous && previous.copied && previous.hash !== hash ? copies.get(previous.hash) : null;
    if (prev && !prev.text && prev.holders.length === 1 && prev.holders[0] === 'current') inUse -= prev.size;
    let keep = core.shouldKeepCopy(file.path, size, this.settings, inUse);
    if (!keep && !core.isText(file.path) && core.shouldKeepCopy(file.path, size, this.settings, 0)) keep = await this.makeRoom(size, false);
    if (keep) {
      await this.store.putBlob(hash, data);
      entry.copied = true;
    }
    return { entry, data };
  }

  async firstInventory() {
    const files = this.app.vault.getFiles();
    const notice = files.length > 200 ? new Notice(`Sync Witness is taking a first inventory of ${files.length} files…`, 0) : null;
    const batch = [];
    for (const f of files) {
      const { entry } = await this.capture(f, null);
      this.files.set(f.path, entry);
      batch.push(entry);
      if (batch.length >= 100) await this.store.putMany('files', batch.splice(0));
    }
    await this.store.putMany('files', batch);
    await this.store.setMeta('initialized', true);
    if (notice) notice.hide();
    this.logActivity(`First inventory: ${core.plural(files.length, 'file')}, copies kept on this device`);
  }

  // Compare the inventory with the vault as it is now: catches what happened while the app was closed.
  async reconcile(reason) {
    const lastSeenAt = await this.store.getMeta('lastSeenAt', null);
    const present = new Map(this.app.vault.getFiles().map((f) => [f.path, f]));
    const observations = [];
    const created = [];
    const saves = [];
    const replaced = [];
    for (const [path, f] of present) {
      const old = this.files.get(path);
      if (!old) {
        const { entry } = await this.capture(f, null);
        this.files.set(path, entry);
        saves.push(entry);
        created.push(entry);
        continue;
      }
      if (old.size === f.stat.size && old.mtime === f.stat.mtime) continue;
      const { entry, data } = await this.capture(f, old);
      if (entry.hash !== old.hash) {
        entry.origin = 'closed';
        replaced.push(old.hash);
        const obs = await this.judge(old, entry, data, 'closed');
        if (obs) observations.push(obs);
      }
      this.files.set(path, entry);
      saves.push(entry);
    }
    const missing = [];
    for (const [path, entry] of this.files) if (!present.has(path)) missing.push(entry);
    const { moves, unpaired } = core.pairMoves(missing.filter((e) => e.size > 0), created.filter((e) => e.size > 0));
    for (const m of moves) this.logActivity(`Moved while closed: ${m.from} → ${m.to}`);
    const unpairedEmpty = missing.filter((e) => e.size === 0);
    for (const entry of unpaired.concat(unpairedEmpty)) observations.push(this.removalObservation(entry, 'closed'));
    for (const entry of missing) this.files.delete(entry.path);
    await this.store.putMany('files', saves);
    await this.store.deleteMany('files', missing.map((e) => e.path));
    if (observations.length) {
      const label = reason === 'startup' ? 'closed' : 'outside';
      for (const o of observations) o.source = label;
      this.record(observations, { window: lastSeenAt ? [lastSeenAt, Date.now()] : null, fresh: true });
      await this.makeRoom(0, true);
    } else if (reason === 'manual') {
      new Notice(`Sync Witness checked ${core.plural(present.size, 'file')}: nothing missing.`);
    }
    await this.releaseCopies(replaced.concat(missing.map((e) => e.hash)));
  }

  // ---- Live events ------------------------------------------------------------------------------

  async onCreate(file) {
    const pending = this.pendingRemovals.get(file.path);
    if (pending) {
      // Removed and written again (atomic saves, sync re-downloads): judge it as a content change.
      this.pendingRemovals.delete(file.path);
      this.files.set(file.path, pending.entry);
      return this.onModify(file, pending.source);
    }
    const old = this.files.get(file.path);
    const { entry } = await this.capture(file, old || null);
    this.files.set(file.path, entry);
    await this.store.put('files', entry);
    if (!this.restoring.has(file.path)) this.recentCreations.set(file.path, { entry, at: Date.now() });
    this.scheduleJudge();
  }

  async onModify(file, forcedSource) {
    const old = this.files.get(file.path);
    if (!old) return this.onCreate(file);
    const { entry, data } = await this.capture(file, old);
    if (entry.hash === old.hash) {
      if (entry.mtime !== old.mtime) { old.mtime = entry.mtime; await this.store.put('files', old); }
      return;
    }
    const source = forcedSource || (await this.writeSourceFor(file.path, entry.hash));
    entry.origin = source;
    if (source === 'restore' || source === 'editor') {
      entry.local = entry.local.filter((h) => h !== entry.hash).concat(entry.hash).slice(-this.settings.settledDepth);
    }
    this.files.set(file.path, entry);
    await this.store.put('files', entry);
    if (source === 'restore' || source === 'editor') {
      if (source === 'editor') this.logActivity(`Edited in Obsidian: ${file.path}`);
      await this.releaseCopies([old.hash]);
      return;
    }
    const obs = await this.judge(old, entry, data, source);
    if (obs) {
      // Hold it for the quiet window so one burst of changes becomes one complete alert.
      this.pendingObservations.push(obs);
      this.scheduleJudge();
    }
    await this.releaseCopies([old.hash]);
  }

  onDeleteEvent(file) {
    // Classify synchronously, while the delete intent is still fresh.
    const paths = file instanceof TFolder
      ? [...this.files.keys()].filter((p) => p.startsWith(file.path + '/'))
      : [file.path];
    const sources = paths.map((p) => [p, this.deleteSourceFor(p)]);
    this.enqueue(async () => {
      for (const [path, source] of sources) {
        const entry = this.files.get(path);
        if (!entry) continue;
        this.files.delete(path);
        await this.store.deleteMany('files', [path]);
        if (source === 'user') {
          this.logActivity(`You deleted ${path}`);
          await this.releaseCopies([entry.hash]);
          continue;
        }
        this.pendingRemovals.set(path, { entry, source, at: Date.now() });
      }
      this.scheduleJudge();
    });
  }

  async onRename(file, oldPath) {
    const moves = file instanceof TFolder
      ? [...this.files.keys()].filter((p) => p.startsWith(oldPath + '/')).map((p) => [p, file.path + p.slice(oldPath.length)])
      : [[oldPath, file.path]];
    for (const [from, to] of moves) {
      const entry = this.files.get(from);
      if (!entry) continue;
      this.files.delete(from);
      entry.path = to;
      this.files.set(to, entry);
      await this.store.deleteMany('files', [from]);
      await this.store.put('files', entry);
    }
    if (moves.length) this.logActivity(`Renamed ${oldPath} → ${file.path}`);
  }

  scheduleJudge() {
    clearTimeout(this.judgeTimer);
    this.judgeTimer = setTimeout(() => this.enqueue(() => this.judgeRemovals()), this.settings.quietSeconds * 1000);
  }

  async judgeRemovals() {
    const now = Date.now();
    for (const [p, c] of this.recentCreations) if (now - c.at > CREATION_TTL_MS) this.recentCreations.delete(p);
    const changed = this.pendingObservations.splice(0);
    if (!this.pendingRemovals.size) {
      if (changed.length) {
        this.record(changed, {});
        await this.makeRoom(0, true);
      }
      return;
    }
    const removed = [...this.pendingRemovals.values()];
    this.pendingRemovals.clear();
    const created = [...this.recentCreations.values()].map((c) => c.entry).filter((e) => e.size > 0 && this.files.get(e.path) === e);
    const { moves, unpaired } = core.pairMoves(removed.map((r) => r.entry).filter((e) => e.size > 0), created);
    for (const m of moves) {
      this.recentCreations.delete(m.to);
      this.logActivity(`Moved outside Obsidian: ${m.from} → ${m.to}`);
    }
    const lost = new Set(unpaired.map((e) => e.path));
    const observations = removed
      .filter((r) => r.entry.size === 0 || lost.has(r.entry.path))
      .map((r) => this.removalObservation(r.entry, r.source, r.at))
      .concat(changed);
    if (observations.length) {
      this.record(observations, {});
      await this.makeRoom(0, true);
    }
    await this.releaseCopies(removed.map((r) => r.entry.hash));
  }

  removalObservation(entry, source, at) {
    return {
      path: entry.path,
      kind: 'removed',
      severity: 'high',
      source,
      at: at || Date.now(),
      size: entry.size,
      mtime: entry.mtime,
      lostBytes: entry.size,
      lostLines: 0,
      restoreHash: entry.copied ? entry.hash : null,
    };
  }

  async judge(old, entry, data, source) {
    const decode = (buf) => new TextDecoder().decode(buf);
    const text = core.isText(entry.path);
    let beforeText = null;
    if (text && old.copied) {
      const blob = await this.store.getBlob(old.hash);
      if (blob) beforeText = decode(blob);
    }
    const before = { hash: old.hash, size: old.size, text: beforeText };
    const after = { hash: entry.hash, size: entry.size, text: text && beforeText != null ? decode(data) : null };
    let known = core.knownVersions(old);
    if (core.isUndoStep(old, entry.hash)) {
      known = known.filter((h) => h !== entry.hash);
      entry.history = entry.history.filter((h) => h !== old.hash);
      await this.store.put('files', entry);
    }
    const verdict = core.judgeChange(before, after, known, source);
    if (!verdict) {
      this.logActivity(`Changed ${SOURCE_LABEL[source] || source}: ${entry.path}`);
      return null;
    }
    return {
      path: entry.path,
      kind: verdict.kind,
      severity: verdict.severity,
      source,
      at: Date.now(),
      size: old.size,
      mtime: old.mtime,
      lostBytes: verdict.lostBytes,
      lostLines: verdict.lostLines,
      restoreHash: old.copied ? old.hash : null,
      afterHash: entry.hash, // what replaced it: restore writes in place only while the file still holds this
    };
  }

  // ---- Incidents --------------------------------------------------------------------------------

  openItems(incident) {
    return incident.items.filter((i) => !i.resolved);
  }

  record(observations, { window, fresh }) {
    const now = Date.now();
    let incident = this.incidents[this.incidents.length - 1];
    const gap = this.settings.incidentGapSeconds * 1000;
    if (fresh || !incident || incident.dismissed || incident.window || !this.openItems(incident).length || now - incident.lastAt > gap) {
      incident = { id: `${now}`, startedAt: Math.min(...observations.map((o) => o.at)), lastAt: now, items: [], severity: 'medium', seen: false, window: window || null };
      this.incidents.push(incident);
    }
    for (const o of observations) {
      incident.items = incident.items.filter((i) => i.path !== o.path || i.resolved);
      incident.items.push(o);
    }
    incident.lastAt = now;
    if (observations.some((o) => o.severity === 'high')) {
      incident.severity = 'high';
      incident.seen = false;
    }
    this.store.put('incidents', incident);
    this.renderStatus();
    this.refreshModals();
    if (incident.severity === 'high') {
      if (![...this.openModals].some((m) => m.incident === incident)) this.showIncident(incident);
    } else {
      const n = new Notice(`Sync Witness: ${core.describeIncident(incident.items).text} ${SOURCE_LABEL[observations[0].source] || ''}. Click to review.`, 12000);
      n.noticeEl.addEventListener('click', () => this.showIncident(incident));
    }
  }

  // Writes the copy back in place only while the file still holds exactly what the incident saw
  // replace it (or is gone). If anything changed since, the copy comes back beside it and the
  // newer version stays untouched.
  async restoreItem(item) {
    if (item.resolved) return true;
    const data = item.restoreHash ? await this.store.getBlob(item.restoreHash) : null;
    if (!data) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const plan = await this.restoreTarget(item);
      if (plan.done) return true;
      try {
        return await this.writeRestore(item, plan, data);
      } catch (e) {
        // The path changed between our check and the write (created or edited meanwhile): look again.
        if (!(e instanceof RestoreRace)) throw e;
      }
    }
    return false;
  }

  async restoreTarget(item) {
    const existing = this.app.vault.getAbstractFileByPath(item.path);
    if (!existing) return { path: item.path, create: true };
    if (!(existing instanceof TFile)) return { path: this.besidePath(item.path), create: true, beside: true };
    const stat = { mtime: existing.stat.mtime, size: existing.stat.size };
    const current = await sha256(await this.app.vault.adapter.readBinary(item.path));
    if (current === item.restoreHash) {
      item.resolved = { at: Date.now(), path: item.path, verified: true, note: 'already back' };
      return { done: true };
    }
    const replaced = item.afterHash || item.replacedHash;
    if (item.kind !== 'removed' && replaced && current === replaced) return { path: item.path, file: existing, stat };
    return { path: this.besidePath(item.path), create: true, beside: true };
  }

  besidePath(path) {
    const dot = path.lastIndexOf('.');
    const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
    const ext = dot > path.lastIndexOf('/') ? path.slice(dot) : '';
    let n = 1;
    let target;
    do { target = `${stem} (restored${n > 1 ? ' ' + n : ''})${ext}`; n++; } while (this.app.vault.getAbstractFileByPath(target));
    return target;
  }

  async writeRestore(item, plan, data) {
    const target = plan.path;
    const folder = core.folderOf(target);
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      const parts = folder.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (!this.app.vault.getAbstractFileByPath(p)) {
          try { await this.app.vault.createFolder(p); } catch (e) { /* created concurrently */ }
        }
      }
    }
    // Last check right before the write, with no await in between: the file must still be exactly
    // as we read it (in place) or still absent (create).
    const now = this.app.vault.getAbstractFileByPath(target);
    if (plan.create ? now : now !== plan.file || now.stat.mtime !== plan.stat.mtime || now.stat.size !== plan.stat.size) throw new RestoreRace();
    this.restoring.set(target, item.restoreHash);
    try {
      const options = item.mtime ? { mtime: item.mtime } : undefined;
      if (plan.create) {
        try {
          await this.app.vault.createBinary(target, data, options);
        } catch (e) {
          if (this.app.vault.getAbstractFileByPath(target)) throw new RestoreRace();
          throw e;
        }
      } else {
        await this.app.vault.modifyBinary(plan.file, data, options);
      }
      const verified = (await sha256(await this.app.vault.adapter.readBinary(target))) === item.restoreHash;
      if (!verified) return false;
      item.resolved = { at: Date.now(), path: target, verified };
      if (plan.beside && item.kind !== 'removed') item.resolved.note = 'beside newer';
      return true;
    } finally {
      setTimeout(() => this.restoring.delete(target), INTENT_TTL_MS);
    }
  }

  async restore(incident, items) {
    let ok = 0;
    let failed = 0;
    let beside = 0;
    for (const item of items) {
      if (await this.enqueueResult(() => this.restoreItem(item))) {
        ok++;
        if (item.resolved.path !== item.path) beside++;
      } else failed++;
    }
    await this.store.put('incidents', incident);
    this.logActivity(`Restored ${core.plural(ok, 'file')}${beside ? `, ${beside} beside a newer version` : ''}${failed ? `, ${failed} could not be restored` : ''}`);
    this.renderStatus();
    this.refreshModals();
    return { ok, failed, beside };
  }

  enqueueResult(task) {
    let result;
    return this.enqueue(async () => { result = await task(); }).then(() => result);
  }

  async dismiss(incident) {
    incident.dismissed = Date.now();
    incident.seen = true;
    await this.store.put('incidents', incident);
    this.logActivity(`Dismissed: ${core.describeIncident(incident.items).text}`);
    this.renderStatus();
    this.refreshModals();
  }

  needsReview() {
    return this.incidents.filter((i) => !i.dismissed && this.openItems(i).length);
  }

  // Retention: open incidents keep their copies until you restore or dismiss them. Dismissed
  // incidents are deleted 30 days after dismissal, fully restored ones 30 days after their last
  // change; their copies can be removed earlier to make space (makeRoom). Then the attachment
  // limit is enforced over everything that is left, and unreferenced copies are deleted.
  async collectGarbage() {
    const now = Date.now();
    const keepFor = 30 * 24 * 3600 * 1000;
    const incidents = this.incidents.filter((inc) => (inc.dismissed
      ? now - inc.dismissed <= keepFor
      : this.openItems(inc).length || now - inc.lastAt <= keepFor));
    const dropped = this.incidents.filter((i) => !incidents.includes(i)).map((i) => i.id);
    this.incidents = incidents;
    await this.store.deleteMany('incidents', dropped);
    await this.makeRoom(0, true);
    const keep = this.referencedCopies();
    const stale = (await this.store.blobKeys()).filter((k) => !keep.has(k));
    await this.store.deleteMany('blobs', stale);
  }

  logActivity(text) {
    // Repeated saves of one note (typing) update a single line instead of filling the log.
    const last = this.activity[this.activity.length - 1];
    if (last && last.text === text) last.at = Date.now();
    else this.activity.push({ at: Date.now(), text });
    this.activity = this.activity.slice(-200);
    this.store.setMeta('activity', this.activity);
  }

  // ---- Clear stored copies ---------------------------------------------------------------------

  async storedUsage() {
    return (await this.enqueueResult(() => this.store.usage())) || { bytes: 0, copies: 0 };
  }

  // Deletes this vault's copies and record on this device, then stays off until the next start,
  // so nothing refills the store before an uninstall. The vault itself is not touched.
  async clearStoredCopies() {
    let error = null;
    await this.enqueue(async () => {
      this.stopped = true;
      clearTimeout(this.judgeTimer);
      for (const undo of this.unpatches.splice(0).reverse()) undo();
      try { await this.store.destroy(); } catch (e) { error = e; }
    });
    this.files.clear();
    this.incidents = [];
    this.activity = [];
    this.intents = [];
    this.userDeletes = [];
    this.pendingRemovals.clear();
    this.pendingObservations = [];
    this.recentCreations.clear();
    for (const m of [...this.openModals]) m.close();
    this.renderStatus();
    if (error) throw error;
  }

  // ---- Interface --------------------------------------------------------------------------------

  renderStatus(text) {
    const el = this.statusEl;
    el.empty();
    el.removeClass('is-alert');
    const icon = el.createSpan({ cls: 'sync-witness-status-icon' });
    if (this.stopped) {
      setIcon(icon, 'shield-off');
      el.createSpan({ text: 'Off' });
      el.setAttr('aria-label', 'Sync Witness is off: stored copies were cleared. It starts a new record when Obsidian restarts.');
      return;
    }
    const open = this.ready ? this.needsReview() : [];
    const count = open.reduce((n, i) => n + this.openItems(i).length, 0);
    if (count) {
      el.addClass('is-alert');
      setIcon(icon, 'shield-alert');
      el.createSpan({ text: `${core.plural(count, 'file')} to review` });
      el.setAttr('aria-label', 'Sync Witness found missing or rolled-back files. Click to review.');
    } else {
      setIcon(icon, 'shield-check');
      el.createSpan({ text: text || `${this.files.size} watched` });
      el.setAttr('aria-label', 'Sync Witness: nothing missing');
    }
  }

  openLatestOrLog() {
    const open = this.needsReview();
    if (open.length) this.showIncident(open[open.length - 1]);
    else this.openLog();
  }

  showIncident(incident) {
    incident.seen = true;
    this.store.put('incidents', incident);
    new IncidentModal(this.app, this, incident).open();
  }

  openLog() {
    new LogModal(this.app, this).open();
  }

  refreshModals() {
    for (const m of this.openModals) m.render();
  }
};

class IncidentModal extends Modal {
  constructor(app, plugin, incident) {
    super(app);
    this.plugin = plugin;
    this.incident = incident;
    this.busy = false;
  }

  onOpen() {
    this.plugin.openModals.add(this);
    this.modalEl.addClass('sync-witness-modal');
    this.render();
  }

  onClose() {
    this.plugin.openModals.delete(this);
    this.contentEl.empty();
  }

  render() {
    const { contentEl: el, incident, plugin } = this;
    el.empty();
    const items = incident.items;
    const open = plugin.openItems(incident);
    const restorable = open.filter((i) => i.restoreHash);

    const head = el.createDiv({ cls: 'sw-head' });
    const badge = head.createDiv({ cls: `sw-badge ${open.length ? 'is-open' : 'is-clear'}` });
    setIcon(badge, open.length ? 'shield-alert' : 'shield-check');
    const titles = head.createDiv();
    titles.createDiv({ cls: 'sw-eyebrow', text: 'Sync Witness' });
    titles.createEl('h2', { cls: 'sw-title', text: core.headline(items) });

    const sources = [...new Set(items.map((i) => i.source))];
    const first = Math.min(...items.map((i) => i.at));
    const last = Math.max(...items.map((i) => i.at));
    const meta = el.createDiv({ cls: 'sw-meta' });
    if (incident.window) {
      meta.createSpan({ text: 'While Obsidian was closed' });
      meta.createSpan({ text: `found at ${dayTimeOf(incident.window[1])}` });
    } else {
      meta.createSpan({ text: timeOf(first) === timeOf(last) ? `At ${dayTimeOf(first)}` : `Between ${dayTimeOf(first)} and ${timeOf(last)}` });
      meta.createSpan({ text: sources.map((s) => SOURCE_LABEL[s] || s).join(', ') });
    }
    const shownItems = open.length ? open : items;
    const lost = shownItems.reduce((n, i) => n + (i.lostBytes || 0), 0);
    const folders = new Set(shownItems.map((i) => core.folderOf(i.path))).size;
    const extent = [folders > 1 ? `${folders} folders` : '', lost ? core.formatBytes(lost) : ''].filter(Boolean).join(' · ');
    if (extent) meta.createSpan({ text: extent });

    if (open.length) {
      const calm = el.createDiv({ cls: `sw-callout ${restorable.length === open.length ? 'is-safe' : 'is-partial'}` });
      calm.createDiv({
        cls: 'sw-callout-title',
        text: restorable.length === open.length
          ? `${open.length === 1 ? 'A copy is' : open.length === 2 ? 'Copies of both are' : `Copies of all ${open.length} are`} safe on this device.`
          : !restorable.length
            ? `No copy of ${open.length === 1 ? 'this file' : 'these files'} is kept on this device.`
            : `Copies of ${restorable.length} of ${open.length} are safe on this device.`,
      });
      calm.createDiv({
        text: restorable.length
          ? 'Restoring writes back the exact bytes and checks them afterwards. If a file has changed since, the copy comes back beside it and your newer version stays. Nothing else in your vault is touched.'
          : 'Sync Witness cannot restore it. Your sync tool’s version history or a backup may still have it.',
      });
      el.createEl('p', {
        cls: 'sw-context',
        text: incident.window
          ? 'These changed while Obsidian was closed. A sync tool may have applied an old state from another device. If you made these changes yourself, you can dismiss this.'
          : 'Nothing you did in Obsidian caused this. Sync tools sometimes apply an old state from another device. If you made these changes elsewhere on purpose, you can dismiss this.',
      });
    } else {
      el.createEl('p', { cls: 'sw-context', text: 'Everything here is back as it was.' });
    }

    const list = el.createDiv({ cls: 'sw-list' });
    const byFolder = new Map();
    for (const it of items) {
      const f = core.folderOf(it.path) || '/';
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(it);
    }
    for (const [folder, group] of [...byFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
      list.createDiv({ cls: 'sw-folder', text: folder === '/' ? 'Vault root' : folder });
      for (const it of group) this.renderItem(list, it);
    }

    const actions = el.createDiv({ cls: 'sw-actions' });
    if (open.length) {
      const dismiss = actions.createEl('button', { text: 'Dismiss' });
      dismiss.addEventListener('click', async () => { await plugin.dismiss(incident); this.close(); });
      const later = actions.createEl('button', { text: 'Decide later' });
      later.addEventListener('click', () => this.close());
      if (restorable.length) {
        const all = actions.createEl('button', { cls: 'mod-cta', text: restorable.length === 1 ? 'Restore it' : `Restore all ${restorable.length}` });
        all.disabled = this.busy;
        window.setTimeout(() => all.focus(), 0);
        all.addEventListener('click', async () => {
          this.busy = true;
          all.setText('Restoring…');
          const { ok, failed, beside } = await plugin.restore(incident, restorable);
          this.busy = false;
          const kept = beside ? ` ${beside === 1 ? 'One had' : `${beside} had`} changed since, so ${beside === 1 ? 'its copy is' : 'their copies are'} beside the newer version.` : '';
          new Notice(`Sync Witness restored ${core.plural(ok, 'file')}${failed ? `; ${failed} failed` : ''}. Each was checked byte for byte.${kept}`);
          this.render();
        });
      }
    } else {
      const close = actions.createEl('button', { cls: 'mod-cta', text: 'Done' });
      close.addEventListener('click', () => this.close());
    }
  }

  renderItem(list, it) {
    const row = list.createDiv({ cls: `sw-item ${it.resolved ? 'is-resolved' : ''}` });
    const icon = row.createDiv({ cls: 'sw-item-icon' });
    setIcon(icon, it.resolved ? 'check' : core.isText(it.path) ? 'file-text' : 'file-image');
    const body = row.createDiv({ cls: 'sw-item-body' });
    body.createDiv({ cls: 'sw-item-name', text: it.path.slice(it.path.lastIndexOf('/') + 1) });
    const detail = body.createDiv({ cls: 'sw-item-detail' });
    if (it.resolved) {
      const moved = it.resolved.path !== it.path ? ` as ${it.resolved.path.slice(it.resolved.path.lastIndexOf('/') + 1)}` : '';
      const newer = it.resolved.note === 'beside newer' ? ' · your newer version kept' : '';
      detail.setText(`Restored${moved} · byte-exact, checked${newer}`);
    } else {
      const kind = detail.createSpan({ cls: `sw-kind kind-${it.kind}`, text: KIND_LABEL[it.kind] || it.kind });
      kind.setAttr('aria-label', it.kind);
      const bits = [];
      if (it.kind === 'removed') bits.push(it.size ? core.formatBytes(it.size) : 'empty note');
      else if (it.lostLines) bits.push(`${core.plural(it.lostLines, 'line')} lost`);
      if (it.kind !== 'removed' && it.lostBytes) bits.push(`${core.formatBytes(it.lostBytes)} gone`);
      bits.push(timeOf(it.at));
      detail.createSpan({ text: ` · ${bits.join(' · ')}` });
    }
    if (!it.resolved) {
      if (it.restoreHash) {
        const b = row.createEl('button', { cls: 'sw-item-restore', text: 'Restore' });
        b.addEventListener('click', async () => {
          b.disabled = true;
          b.setText('…');
          await this.plugin.restore(this.incident, [it]);
          this.render();
        });
      } else {
        row.createDiv({ cls: 'sw-item-note', text: it.evicted ? 'Copy removed to make space' : 'No copy (over the size limit)' });
      }
    }
  }
}

class LogModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.plugin.openModals.add(this);
    this.modalEl.addClass('sync-witness-modal');
    this.render();
  }

  onClose() {
    this.plugin.openModals.delete(this);
    this.contentEl.empty();
  }

  render() {
    const { contentEl: el, plugin } = this;
    el.empty();
    const head = el.createDiv({ cls: 'sw-head' });
    const open = plugin.needsReview();
    const badge = head.createDiv({ cls: `sw-badge ${open.length ? 'is-open' : 'is-clear'}` });
    setIcon(badge, open.length ? 'shield-alert' : 'shield-check');
    const titles = head.createDiv();
    titles.createDiv({ cls: 'sw-eyebrow', text: 'Sync Witness' });
    if (plugin.stopped) {
      setIcon(badge, 'shield-off');
      titles.createEl('h2', { cls: 'sw-title', text: 'Sync Witness is off' });
      el.createEl('p', { cls: 'sw-context', text: 'Stored copies and the record for this vault were cleared from this device. Sync Witness starts a new record when Obsidian restarts or when you turn the plugin off and on again.' });
      return;
    }
    titles.createEl('h2', { cls: 'sw-title', text: open.length ? 'Some files need a look' : 'Nothing missing' });
    const copies = [...plugin.files.values()].filter((e) => e.copied).length;
    el.createDiv({ cls: 'sw-meta' }).createSpan({ text: `Watching ${core.plural(plugin.files.size, 'file')} · copies of ${copies} kept on this device` });

    if (plugin.incidents.length) {
      el.createDiv({ cls: 'sw-section', text: 'Incidents' });
      const list = el.createDiv({ cls: 'sw-list' });
      for (const inc of [...plugin.incidents].reverse()) {
        const row = list.createDiv({ cls: 'sw-item is-link' });
        const openItems = plugin.openItems(inc);
        setIcon(row.createDiv({ cls: 'sw-item-icon' }), openItems.length && !inc.dismissed ? 'shield-alert' : 'shield-check');
        const body = row.createDiv({ cls: 'sw-item-body' });
        body.createDiv({ cls: 'sw-item-name', text: core.headline(inc.items) });
        const state = !openItems.length ? 'restored' : inc.dismissed ? 'dismissed' : 'needs review';
        body.createDiv({ cls: 'sw-item-detail', text: `${dayTimeOf(inc.startedAt)} · ${state}` });
        row.addEventListener('click', () => { this.close(); plugin.showIncident(inc); });
      }
    }
    el.createDiv({ cls: 'sw-section', text: 'Recent activity judged normal' });
    const act = el.createDiv({ cls: 'sw-activity' });
    const recent = plugin.activity.slice(-12).reverse();
    if (!recent.length) act.createDiv({ text: 'Nothing yet.' });
    for (const a of recent) act.createDiv({ text: `${dayTimeOf(a.at)}  ${a.text}` });
  }
}

class SyncWitnessSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl: el, plugin } = this;
    el.empty();
    el.createEl('p', {
      text: 'Sync Witness keeps a record of your files and copies of them in this device’s app storage, not in the vault. It never uses the network. Notes are always copied; attachments are copied up to the limits below.',
    });
    const num = (name, desc, key) => new Setting(el).setName(name).setDesc(desc).addText((t) => t
      .setValue(String(plugin.settings[key]))
      .onChange(async (v) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return;
        plugin.settings[key] = n;
        await plugin.saveData(plugin.settings);
      }));
    num('Largest attachment to copy (MB)', 'Bigger files are still watched, but cannot be restored.', 'attachmentFileCapMB');
    num('Total space for attachment copies (MB)', 'Counts every attachment copy, including copies kept for incidents. When it is full, copies from dismissed incidents are removed first; after that, new attachment versions are watched without a copy. Copies for files waiting for review are never removed.', 'attachmentTotalCapMB');
    let notes = 0;
    let attachments = 0;
    for (const c of plugin.referencedCopies().values()) c.text ? (notes += c.size) : (attachments += c.size);
    new Setting(el).setName('Space used on this device').setDesc(plugin.stopped
      ? 'Nothing stored.'
      : `Notes: ${core.formatBytes(notes)}. Attachments: ${core.formatBytes(attachments)} of ${core.formatBytes(plugin.settings.attachmentTotalCapMB * 1024 * 1024)}, including copies kept for incidents.`);
    const clear = new Setting(el).setName('Clear stored copies');
    if (plugin.stopped) {
      clear.setDesc('Cleared. Sync Witness is off until Obsidian restarts.');
      return;
    }
    clear.setDesc('Deletes the copies and the record for this vault from this device. Your vault files are not touched. Use this before you uninstall.')
      .addButton((b) => b.setButtonText('Clear…').onClick(async () => {
        b.setDisabled(true).setButtonText('Measuring…');
        let usage;
        try {
          usage = await plugin.storedUsage();
        } finally {
          b.setDisabled(false).setButtonText('Clear…');
        }
        new ClearCopiesModal(this.app, plugin, usage, () => this.display()).open();
      }));
  }
}

class ClearCopiesModal extends Modal {
  constructor(app, plugin, usage, onDone) {
    super(app);
    this.plugin = plugin;
    this.usage = usage;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl: el, plugin, usage } = this;
    this.modalEl.addClass('sync-witness-modal');
    const size = core.formatBytes(usage.bytes);
    const waiting = plugin.needsReview().reduce((n, i) => n + plugin.openItems(i).length, 0);
    el.createEl('h2', { cls: 'sw-title', text: 'Clear stored copies?' });
    el.createEl('p', {
      cls: 'sw-context',
      text: `This deletes ${core.plural(usage.copies, 'stored copy', 'stored copies')} (${size}) and the record of ${core.plural(plugin.files.size, 'file')} for this vault on this device. Your vault files are not touched.`,
    });
    if (waiting) {
      el.createDiv({ cls: 'sw-callout is-partial' }).createDiv({
        cls: 'sw-callout-title',
        text: `${core.plural(waiting, 'file')} waiting for review can no longer be restored.`,
      });
    }
    el.createEl('p', {
      cls: 'sw-context',
      text: 'Sync Witness then stops watching. It starts a new record when Obsidian restarts or when you turn the plugin off and on again.',
    });
    const actions = el.createDiv({ cls: 'sw-actions' });
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
    const go = actions.createEl('button', { cls: 'mod-warning', text: `Delete ${size}` });
    window.setTimeout(() => cancel.focus(), 0);
    go.addEventListener('click', async () => {
      go.disabled = true;
      cancel.disabled = true;
      go.setText('Deleting…');
      try {
        await plugin.clearStoredCopies();
        new Notice(`Sync Witness deleted ${size} of stored copies. It is off until Obsidian restarts.`);
      } catch (e) {
        console.error('Sync Witness', e);
        new Notice(`Sync Witness could not delete the stored copies: ${e.message}. Restart Obsidian and try again.`);
      }
      this.close();
      this.onDone();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

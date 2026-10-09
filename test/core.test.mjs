import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../src/core.js');
const { installWritePatches } = require('../src/patch.js');

const note = (text, hash) => ({ text, hash: hash || text, size: Buffer.byteLength(text) });

test('emptied file is high severity', () => {
  const v = core.judgeChange(note('a\nb\n'), note(''), [], 'outside');
  assert.equal(v.kind, 'emptied'); assert.equal(v.severity, 'high');
});

test('rollback to an earlier version this device saw is high severity', () => {
  const v0 = '# Plan\nline one\n';
  const v1 = v0 + 'new paragraph written today\nand another line\n';
  const v = core.judgeChange(note(v1), note(v0), [v0], 'outside');
  assert.equal(v.kind, 'rolled-back'); assert.equal(v.severity, 'high'); assert.equal(v.lostLines, 2);
});

test('rollback that only reverts an edited line is still a rollback', () => {
  const v = core.judgeChange(note('title\nnew wording\n'), note('title\nold wording\n'), ['title\nold wording\n'], 'plugin');
  assert.equal(v.kind, 'rolled-back');
});

test('find-replace across lines is not loss', () => {
  const before = 'the project is late\nproject notes\nother\n';
  const after = 'the initiative is late\ninitiative notes\nother\n';
  assert.equal(core.judgeChange(note(before), note(after), [], 'outside'), null);
  assert.equal(core.judgeChange(note(before), note(after), [], 'plugin'), null);
});

test('appending text is not loss', () => {
  assert.equal(core.judgeChange(note('a\n'), note('a\nb\n'), [], 'outside'), null);
});

test('small in-app removal (property deleted) is not loss', () => {
  const before = '---\ntags: x\nstatus: open\n---\nbody line one\nbody line two\nbody line three\n';
  const after = '---\ntags: x\n---\nbody line one\nbody line two\nbody line three\n';
  assert.equal(core.judgeChange(note(before), note(after), [], 'plugin'), null);
});

test('large outside truncation without a known version is flagged', () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
  const after = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
  const v = core.judgeChange(note(before), note(after), [], 'outside');
  assert.equal(v.kind, 'shrunk'); assert.equal(v.severity, 'high');
});

test('moves are paired by content', () => {
  const r = core.pairMoves([{ path: 'a/x.md', hash: 'h1' }, { path: 'a/y.md', hash: 'h2' }], [{ path: 'b/x.md', hash: 'h1' }]);
  assert.deepEqual(r.moves, [{ from: 'a/x.md', to: 'b/x.md' }]);
  assert.equal(r.unpaired.length, 1);
});

test('attachment cap', () => {
  const s = core.DEFAULTS; const mb = 1024 * 1024;
  assert.equal(core.shouldKeepCopy('a.md', 50 * mb, s, 0), false);
  assert.equal(core.shouldKeepCopy('a.md', 1 * mb, s, 0), true);
  assert.equal(core.shouldKeepCopy('a.png', 21 * mb, s, 0), false);
  assert.equal(core.shouldKeepCopy('a.png', 5 * mb, s, 1020 * mb), false);
  assert.equal(core.shouldKeepCopy('a.png', 5 * mb, s, 0), true);
});

test('headline and description', () => {
  const items = [{ path: 'a/1.md', kind: 'removed', lostBytes: 10 }, { path: 'b/2.png', kind: 'removed', lostBytes: 20 }];
  assert.equal(core.headline(items), '2 files went missing from this vault');
  assert.equal(core.describeIncident(items).text, '1 note removed, 1 attachment removed');
});

test('byte sizes read naturally', () => {
  assert.equal(core.formatBytes(512), '512 B');
  assert.equal(core.formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(core.formatBytes(1024 * 1024 * 1024), '1.00 GB');
});

// A fake vault adapter and file manager that really store and delete, like Obsidian's do.
function fakeVault() {
  const disk = new Map();
  const adapter = {
    async write(p, data) { disk.set(p, data); return 'wrote'; },
    async writeBinary(p, data) { disk.set(p, data); },
    async append(p, data) { disk.set(p, (disk.get(p) || '') + data); },
    async appendBinary(p, data) { disk.set(p, data); },
    async process(p, fn) { const out = fn(disk.get(p)); disk.set(p, out); return out; },
    async remove(p) { disk.delete(p); },
    async trashSystem(p) { disk.delete(p); return true; },
    async trashLocal(p) { disk.delete(p); },
    async rmdir(p) { for (const k of [...disk.keys()]) if (k.startsWith(p + '/')) disk.delete(k); },
    async rename(a, b) { disk.set(b, disk.get(a)); disk.delete(a); },
  };
  const fileManager = {
    async trashFile(file) { await adapter.trashSystem(file.path); },
    async promptForDeletion(file) { await adapter.remove(file.path); },
  };
  return { disk, adapter, fileManager };
}

const throwingHooks = (errors) => {
  const boom = () => { throw new Error('bookkeeping failed'); };
  return { write: boom, append: boom, remove: boom, rename: boom, userDelete: boom, onError: (e) => errors.push(e.message) };
};

test('guard: every save and delete still completes when the bookkeeping throws', async () => {
  const { disk, adapter, fileManager } = fakeVault();
  const errors = [];
  installWritePatches(adapter, fileManager, throwingHooks(errors));
  assert.equal(await adapter.write('a.md', 'saved text'), 'wrote');
  assert.equal(disk.get('a.md'), 'saved text');
  await adapter.writeBinary('b.png', 'png bytes');
  assert.equal(disk.get('b.png'), 'png bytes');
  await adapter.append('a.md', ' more');
  assert.equal(disk.get('a.md'), 'saved text more');
  assert.equal(await adapter.process('a.md', (s) => s.toUpperCase()), 'SAVED TEXT MORE');
  assert.equal(disk.get('a.md'), 'SAVED TEXT MORE');
  await adapter.rename('a.md', 'c.md');
  assert.equal(disk.get('c.md'), 'SAVED TEXT MORE');
  assert.equal(disk.has('a.md'), false);
  disk.set('d/e.md', 'x');
  await adapter.rmdir('d', true);
  assert.equal(disk.has('d/e.md'), false);
  await fileManager.trashFile({ path: 'c.md' });
  assert.equal(disk.has('c.md'), false);
  await fileManager.promptForDeletion({ path: 'b.png' });
  assert.equal(disk.size, 0);
  // trashFile reaches trashSystem through the wrapper too: both hooks failed, both calls ran.
  assert.ok(errors.length >= 9);
  assert.ok(errors.every((m) => m === 'bookkeeping failed'));
});

test('guard: a failing error reporter does not block the save either', async () => {
  const { disk, adapter, fileManager } = fakeVault();
  installWritePatches(adapter, fileManager, { ...throwingHooks([]), onError: () => { throw new Error('report failed'); } });
  await adapter.write('a.md', 'kept');
  assert.equal(disk.get('a.md'), 'kept');
});

test('guard: errors from the caller itself are not swallowed', async () => {
  const { adapter, fileManager } = fakeVault();
  installWritePatches(adapter, fileManager, throwingHooks([]));
  await assert.rejects(adapter.process('a.md', () => { throw new Error('caller bug'); }), /caller bug/);
});

test('guard: bookkeeping sees each call, and undo restores the originals', async () => {
  const { adapter, fileManager } = fakeVault();
  const originals = { ...adapter, ...fileManager };
  const seen = [];
  const undo = installWritePatches(adapter, fileManager, {
    write: (p, d) => seen.push(['write', p, d]),
    append: (p) => seen.push(['append', p]),
    remove: (p) => seen.push(['remove', p]),
    rename: (a, b) => seen.push(['rename', a, b]),
    userDelete: (f) => seen.push(['user', f.path]),
    onError: (e) => { throw e; },
  });
  await adapter.write('a.md', 'one');
  await adapter.process('a.md', (s) => s + ' two');
  await adapter.rename('a.md', 'b.md');
  await fileManager.trashFile({ path: 'b.md' });
  assert.deepEqual(seen, [['write', 'a.md', 'one'], ['write', 'a.md', 'one two'], ['rename', 'a.md', 'b.md'], ['user', 'b.md'], ['remove', 'b.md']]);
  for (const u of undo) u();
  for (const k of Object.keys(adapter)) assert.equal(adapter[k], originals[k], k);
  for (const k of Object.keys(fileManager)) assert.equal(fileManager[k], originals[k], k);
});

// ---- Restore and stored copies: the plugin itself, on a fake vault and a fake copy store. ----

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function loadPlugin() {
  class TFile { constructor(p, size) { this.path = p; this.stat = { size, mtime: 0 }; } }
  class Stub {}
  const obsidian = { Plugin: Stub, Modal: Stub, Notice: Stub, PluginSettingTab: Stub, Setting: Stub, TFile, TFolder: class {}, TextFileView: class {}, setIcon() {} };
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const src = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  const module = { exports: {} };
  const req = (n) => (n === 'obsidian' ? obsidian : require(path.join(dir, n.replace('./', '') + '.js')));
  new Function('module', 'exports', 'require', src)(module, module.exports, req);
  return { Plugin: module.exports, TFile };
}

const bytes = (t) => new Uint8Array(Buffer.from(t)).buffer;
const sum = (b) => createHash('sha256').update(new Uint8Array(b)).digest('hex');
const text = (b) => Buffer.from(new Uint8Array(b)).toString();

function lab(settings = {}) {
  const { Plugin, TFile } = loadPlugin();
  const p = Object.create(Plugin.prototype);
  const disk = new Map();
  const objects = new Map();
  const blobs = new Map();
  let clock = 1;
  const hooks = { beforeCreate: null, beforeModify: null };
  const put = (file, b) => { disk.set(file, b); const o = objects.get(file) || new TFile(file, 0); o.stat = { size: b.byteLength, mtime: clock++ }; objects.set(file, o); return o; };
  Object.assign(p, {
    settings: { ...core.DEFAULTS, ...settings }, files: new Map(), incidents: [], activity: [], restoring: new Map(), intents: [], userDeletes: [],
    writeSources: {}, pendingRemovals: new Map(), pendingObservations: [], recentCreations: new Map(), openModals: new Set(), queue: Promise.resolve(),
  });
  p.renderStatus = () => {};
  p.scheduleJudge = () => {};
  p.showIncident = () => {};
  p.store = {
    getBlob: async (h) => (blobs.has(h) ? blobs.get(h).data : null),
    putBlob: async (h, d) => { if (!blobs.has(h)) blobs.set(h, { size: d.byteLength, data: d }); },
    put: async () => {}, putMany: async () => {}, setMeta: async () => {},
    deleteMany: async (store, keys) => { if (store === 'blobs') for (const k of keys) blobs.delete(k); },
    blobKeys: async () => [...blobs.keys()],
  };
  p.app = { vault: {
    adapter: { readBinary: async (f) => disk.get(f).slice(0) },
    getAbstractFileByPath: (f) => objects.get(f) || null,
    createFolder: async () => {},
    createBinary: async (f, b) => {
      if (hooks.beforeCreate) { const h = hooks.beforeCreate; hooks.beforeCreate = null; await h(f); }
      if (objects.has(f)) throw new Error('File already exists.');
      p.noteWrite(f, p.restoring.has(f) ? 'restore' : 'plugin', b); return put(f, b);
    },
    modifyBinary: async (file, b) => { p.noteWrite(file.path, p.restoring.has(file.path) ? 'restore' : 'plugin', b); put(file.path, b); },
  } };
  // An outside program (a sync tool, or the user in another editor) changes the disk.
  const outside = (f, t) => put(f, bytes(t));
  const remove = (f) => { disk.delete(f); objects.delete(f); };
  const track = async (f) => { const { entry } = await p.capture(objects.get(f), p.files.get(f) || null); p.files.set(f, entry); return entry; };
  const storedBytes = () => [...blobs.values()].reduce((n, b) => n + b.size, 0);
  return { p, disk, objects, blobs, hooks, outside, write: put, remove, track, storedBytes };
}

// A note rolled back by a sync tool: v2 (the user's) was replaced by v1 (older).
async function rolledBack(L, kind = 'rolled-back') {
  const v1 = 'Plan\nfirst line\n';
  const v2 = 'Plan\nfirst line\nwork written today\nmore work\n';
  L.outside('note.md', v1); await L.track('note.md');
  L.outside('note.md', v2); await L.track('note.md');
  const after = kind === 'emptied' ? '' : kind === 'shrunk' ? 'Plan\n' : v1;
  L.outside('note.md', after);
  await L.p.onModify(L.objects.get('note.md'));
  const item = L.p.pendingObservations.splice(0)[0];
  assert.equal(item.kind, kind);
  const incident = { id: 'i1', items: [item], lastAt: Date.now(), severity: 'high' };
  L.p.incidents.push(incident);
  return { item, incident, v2 };
}

test('restore: a note edited after the alert keeps the newer text; the copy comes back beside it', async () => {
  for (const kind of ['rolled-back', 'emptied', 'shrunk']) {
    const L = lab();
    const { item, v2 } = await rolledBack(L, kind);
    L.outside('note.md', 'Plan\nnew work typed after the alert\n');
    await L.p.onModify(L.objects.get('note.md'));
    assert.equal(await L.p.restoreItem(item), true, kind);
    assert.equal(text(L.disk.get('note.md')), 'Plan\nnew work typed after the alert\n', kind);
    assert.equal(text(L.disk.get('note (restored).md')), v2, kind);
    assert.deepEqual([item.resolved.path, item.resolved.note], ['note (restored).md', 'beside newer']);
    await L.p.onCreate(L.objects.get('note (restored).md'));
    await L.p.collectGarbage();
    assert.equal(text(L.disk.get('note.md')), 'Plan\nnew work typed after the alert\n', kind);
  }
});

test('restore all: unchanged files come back in place, changed ones beside the newer version', async () => {
  const L = lab();
  const { item: a, incident } = await rolledBack(L);
  L.outside('b.md', 'B\none\ntwo\nthree\n'); await L.track('b.md');
  L.outside('b.md', '');
  await L.p.onModify(L.objects.get('b.md'));
  const b = L.p.pendingObservations.splice(0)[0];
  incident.items.push(b);
  L.outside('note.md', 'Plan\nfirst line\nnewer\n');
  const r = await L.p.restore(incident, [a, b]);
  assert.deepEqual(r, { ok: 2, failed: 0, beside: 1 });
  assert.equal(text(L.disk.get('note.md')), 'Plan\nfirst line\nnewer\n');
  assert.equal(text(L.disk.get('b.md')), 'B\none\ntwo\nthree\n');
  assert.equal(b.resolved.path, 'b.md');
});

test('restore: unchanged since the alert is restored in place; already restored is left alone', async () => {
  const L = lab();
  const { item, v2 } = await rolledBack(L);
  assert.equal(await L.p.restoreItem(item), true);
  assert.equal(text(L.disk.get('note.md')), v2);
  assert.equal(L.disk.has('note (restored).md'), false);
  const L2 = lab();
  const r2 = await rolledBack(L2);
  L2.outside('note.md', r2.v2);
  const mtime = L2.objects.get('note.md').stat.mtime;
  assert.equal(await L2.p.restoreItem(r2.item), true);
  assert.equal(r2.item.resolved.note, 'already back');
  assert.equal(L2.objects.get('note.md').stat.mtime, mtime);
});

test('restore race: a file created or edited between the check and the write is never overwritten', async () => {
  const L = lab();
  L.outside('gone.md', 'kept text\n'); const e = await L.track('gone.md');
  L.remove('gone.md');
  const item = L.p.removalObservation(e, 'outside');
  L.hooks.beforeCreate = async () => { L.outside('gone.md', 'arrived meanwhile\n'); };
  assert.equal(await L.p.restoreItem(item), true);
  assert.equal(text(L.disk.get('gone.md')), 'arrived meanwhile\n');
  assert.equal(text(L.disk.get('gone (restored).md')), 'kept text\n');

  const M = lab();
  const { item: rb, v2 } = await rolledBack(M);
  const read = M.p.app.vault.adapter.readBinary;
  let once = true;
  M.p.app.vault.adapter.readBinary = async (f) => { const d = await read(f); if (once && f === 'note.md') { once = false; M.outside('note.md', 'typed during restore\n'); } return d; };
  assert.equal(await M.p.restoreItem(rb), true);
  assert.equal(text(M.disk.get('note.md')), 'typed during restore\n');
  assert.equal(text(M.disk.get('note (restored).md')), v2);
});

test('stored copies: the attachment limit covers copies kept for incidents', async () => {
  const L = lab({ attachmentTotalCapMB: 1, attachmentFileCapMB: 1 });
  const cap = 1024 * 1024;
  const kb = (n, fill) => new Uint8Array(n * 1024).fill(fill).buffer;
  // Repeated capture → outside delete (an open incident keeps the copy) → a new attachment.
  for (let i = 1; i <= 4; i++) {
    L.disk.set(`a${i}.bin`, kb(400, i)); L.outside(`a${i}.bin`, ''); L.disk.set(`a${i}.bin`, kb(400, i)); L.objects.get(`a${i}.bin`).stat.size = 400 * 1024;
    const e = await L.track(`a${i}.bin`);
    if (e.copied) {
      L.remove(`a${i}.bin`); L.p.files.delete(`a${i}.bin`);
      L.p.incidents.push({ id: `d${i}`, lastAt: Date.now(), items: [L.p.removalObservation(e, 'outside')] });
    }
    await L.p.collectGarbage();
    assert.ok(L.storedBytes() <= cap, `round ${i}: ${L.storedBytes()} stored`);
    assert.equal(L.p.attachmentBytes(), L.storedBytes());
  }
  // Two open incidents fill the space; the third and fourth attachments are watched without a copy.
  assert.equal(L.p.incidents.length, 2);
  assert.equal(L.p.files.get('a3.bin').copied, false);
  // Open incidents keep their copies. Dismissing one lets a new attachment take its space.
  L.p.incidents[0].dismissed = Date.now();
  L.disk.set('a5.bin', kb(400, 5)); L.outside('a5.bin', ''); L.disk.set('a5.bin', kb(400, 5)); L.objects.get('a5.bin').stat.size = 400 * 1024;
  assert.equal((await L.track('a5.bin')).copied, true);
  const evicted = L.p.incidents[0].items[0];
  assert.equal(evicted.restoreHash, null);
  assert.ok(evicted.evicted);
  assert.equal(await L.p.restoreItem(evicted), false);
  assert.ok(L.p.incidents[1].items[0].restoreHash);
  await L.p.collectGarbage();
  assert.ok(L.storedBytes() <= cap);
  // Restoring an attachment stores no second copy of the same bytes.
  assert.equal(await L.p.restoreItem(L.p.incidents[1].items[0]), true);
  await L.p.onCreate(L.objects.get('a2.bin'));
  assert.equal(L.p.files.get('a2.bin').copied, true);
  assert.ok(L.storedBytes() <= cap);
});

test('stored copies: a lowered limit is enforced; dismissed incidents go after 30 days', async () => {
  const L = lab();
  const day = 24 * 3600 * 1000;
  for (const [n, fill] of [['x.bin', 1], ['y.bin', 2]]) { L.disk.set(n, new Uint8Array(300 * 1024).fill(fill).buffer); L.outside(n, ''); L.disk.set(n, new Uint8Array(300 * 1024).fill(fill).buffer); L.objects.get(n).stat.size = 300 * 1024; await L.track(n); }
  L.outside('old.md', 'old text\n'); const e = await L.track('old.md');
  L.remove('old.md'); L.p.files.delete('old.md');
  L.p.incidents.push({ id: 'old', lastAt: Date.now() - 31 * day, dismissed: Date.now() - 31 * day, items: [L.p.removalObservation(e, 'outside')] });
  L.p.incidents.push({ id: 'recent', lastAt: Date.now() - 31 * day, dismissed: Date.now() - 2 * day, items: [L.p.removalObservation(e, 'outside')] });
  L.p.settings.attachmentTotalCapMB = 0.5;
  await L.p.collectGarbage();
  assert.deepEqual(L.p.incidents.map((i) => i.id), ['recent']);
  assert.ok(L.p.attachmentBytes() <= 0.5 * 1024 * 1024);
  assert.equal([...L.p.files.values()].filter((f) => f.copied && f.path.endsWith('.bin')).length, 1);
  assert.equal(L.storedBytes(), L.p.attachmentBytes() + Buffer.byteLength('old text\n'));
});

test('stored copies: replacing an attachment near the limit still keeps a copy of the new version', async () => {
  const L = lab({ attachmentTotalCapMB: 1 });
  L.write('scan.bin', new Uint8Array(600 * 1024).fill(1).buffer); await L.track('scan.bin');
  L.write('scan.bin', new Uint8Array(600 * 1024).fill(2).buffer);
  await L.p.onModify(L.objects.get('scan.bin'));
  assert.equal(L.p.files.get('scan.bin').copied, true);
  assert.equal(L.storedBytes(), 600 * 1024);
});

test('stored copies: an attachment rolled back near the limit keeps the lost version; the limit holds once recorded', async () => {
  const L = lab({ attachmentTotalCapMB: 1 });
  const v = (n, fill) => new Uint8Array(n * 1024).fill(fill).buffer;
  L.write('older.bin', v(300, 9)); await L.track('older.bin');
  L.write('photo.bin', v(400, 1)); await L.track('photo.bin');
  L.write('photo.bin', v(400, 2)); await L.p.onModify(L.objects.get('photo.bin'));
  L.write('photo.bin', v(400, 1)); await L.p.onModify(L.objects.get('photo.bin')); // a sync tool puts the old photo back
  await L.p.judgeRemovals();
  const item = L.p.incidents[0].items[0];
  assert.equal(item.kind, 'rolled-back');
  assert.equal(sum(L.blobs.get(item.restoreHash).data), sum(v(400, 2)));
  assert.ok(L.storedBytes() <= 1024 * 1024, `${L.storedBytes()} stored`);
  assert.equal(L.p.files.get('older.bin').copied, false); // least recently changed copy made the room
  assert.equal(L.p.attachmentBytes(), L.storedBytes());
});

// ---- Rollback recognition does not depend on how many autosaves happened since. ----

const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n';

// The user types in one session: each autosave is an editor write of the next version.
async function typeSession(L, file, saves) {
  let t = text(L.disk.get(file));
  for (let i = 1; i <= saves; i++) {
    t += `typed ${i}\n`;
    const b = bytes(t);
    L.p.noteWrite(file, 'editor', b);
    L.write(file, b);
    await L.p.onModify(L.objects.get(file));
  }
  return t;
}

async function writeBack(L, file, t, source) {
  const b = bytes(t);
  L.p.intents = []; // later than the 15 s write records of the session
  if (source === 'plugin') L.p.noteWrite(file, 'plugin', b);
  L.write(file, b);
  await L.p.onModify(L.objects.get(file));
  return L.p.pendingObservations.splice(0)[0] || null;
}

test('rollback: a version a sync tool wrote, then 30 autosaves, then written back → rolled-back high', async () => {
  for (const source of ['plugin', 'outside']) {
    const L = lab();
    L.outside('note.md', 'start\n'); await L.track('note.md');
    const stale = lines(30, 'synced');
    assert.equal(await writeBack(L, 'note.md', stale, 'plugin'), null); // the sync tool brings this version in
    await typeSession(L, 'note.md', 30);
    assert.equal(L.p.files.get('note.md').history.includes(sum(bytes(stale))), false); // aged out of the recent list
    const o = await writeBack(L, 'note.md', stale, source);
    assert.ok(o, source);
    assert.equal(o.source, source);
    assert.deepEqual([o.kind, o.severity, o.lostLines], ['rolled-back', 'high', 30], source);
  }
});

test('rollback: a version current for minutes, then 30+ editor saves, then a plugin writes it back → rolled-back high', async () => {
  const L = lab();
  const stale = lines(30, 'mine');
  L.outside('note.md', stale); await L.track('note.md');
  L.p.files.get('note.md').origin = 'editor'; // typed here, so only time can settle it
  L.p.files.get('note.md').since = Date.now() - 5 * 60 * 1000;
  await typeSession(L, 'note.md', 35);
  const o = await writeBack(L, 'note.md', stale, 'plugin');
  assert.deepEqual([o.kind, o.severity, o.source], ['rolled-back', 'high', 'plugin']);
});

test('rollback: settled versions survive many typing sessions; the list is bounded', async () => {
  const s = core.DEFAULTS;
  let entry = { hash: 'v0', history: [], settled: [], origin: 'plugin', since: 0 };
  let now = 1e9;
  for (let i = 1; i <= 200; i++) { // 200 quick autosaves after a synced version
    const next = core.rememberVersion(entry, `v${i}`, now, s);
    entry = { hash: `v${i}`, ...next, origin: 'editor', since: now };
    now += 2000;
  }
  assert.ok(core.knownVersions(entry).includes('v0'));
  assert.equal(entry.history.length, s.historyDepth);
  for (let i = 201; i <= 260; i++) { // 60 pauses of over a minute each
    now += 61000;
    const next = core.rememberVersion(entry, `v${i}`, now, s);
    entry = { hash: `v${i}`, ...next, origin: 'editor', since: now };
  }
  assert.equal(entry.settled.length, s.settledDepth);
  assert.equal(entry.settled.includes('v0'), false); // the limit: the last 32 settled versions
});

test('rollback limit: a version that existed only for seconds while typing is judged as a cut, by source', async () => {
  const seen = {};
  for (const source of ['outside', 'plugin']) {
    const L = lab();
    L.outside('note.md', lines(30, 'base')); await L.track('note.md');
    await typeSession(L, 'note.md', 2);
    const brief = text(L.disk.get('note.md'));
    await typeSession(L, 'note.md', 30);
    const o = await writeBack(L, 'note.md', brief, source);
    seen[source] = o && [o.kind, o.severity];
  }
  // 30 short lines lost from a 62-line note: under half of it.
  assert.deepEqual(seen, { outside: ['shrunk', 'medium'], plugin: null }); // a plugin's smaller cut is logged, not alerted
});

// ---- The other device undoing its own last change (candidate, private test) ----

async function outsideWrite(L, file, t) {
  L.p.intents = [];
  L.outside(file, t);
  await L.p.onModify(L.objects.get(file));
  return L.p.pendingObservations.splice(0)[0] || null;
}

test('undo elsewhere: a note the other device returns to the version just before (checkbox unticked, line removed) is ordinary editing', async () => {
  const L = lab();
  const body = lines(20, 'week'); // a real note: one line is well under the shrink thresholds
  L.outside('tasks.md', body + '- [ ] call the printer\n'); await L.track('tasks.md');
  assert.equal(await outsideWrite(L, 'tasks.md', body + '- [x] call the printer\n'), null);
  assert.equal(await outsideWrite(L, 'tasks.md', body + '- [ ] call the printer\n'), null);
  assert.equal(await outsideWrite(L, 'tasks.md', body + '- [ ] call the printer\n- draft idea\n'), null);
  assert.equal(await outsideWrite(L, 'tasks.md', body + '- [ ] call the printer\n'), null);
});

test('undo elsewhere: the previous version written over one typed here is still a rollback', async () => {
  const L = lab();
  L.outside('note.md', 'Plan\nfirst line\n'); await L.track('note.md');
  L.outside('note.md', 'Plan\nfirst line\ntyped here\n'); await L.track('note.md');
  L.p.files.get('note.md').origin = 'editor';
  const o = await outsideWrite(L, 'note.md', 'Plan\nfirst line\n');
  assert.deepEqual([o.kind, o.severity], ['rolled-back', 'high']);
});

test('undo elsewhere: an older copy written over several later outside versions is still a rollback', async () => {
  const L = lab();
  L.outside('note.md', 'Plan\nfirst line\n'); await L.track('note.md');
  for (const t of ['Plan\nfirst line\nsecond\n', 'Plan\nfirst line\nsecond\nthird\n']) assert.equal(await outsideWrite(L, 'note.md', t), null);
  const o = await outsideWrite(L, 'note.md', 'Plan\nfirst line\n');
  assert.deepEqual([o.kind, o.severity], ['rolled-back', 'high']);
});

test('undo elsewhere: the other device undoes two synced changes one step at a time (v2, then v1, then v0) → ordinary editing', async () => {
  const L = lab();
  const body = lines(20, 'week');
  const v = [body, body + '- draft X\n', body + '- draft X\n- draft Y\n'];
  L.outside('note.md', v[0]); await L.track('note.md');
  for (const t of [v[1], v[2], v[1], v[0]]) assert.equal(await outsideWrite(L, 'note.md', t), null);
});

test('undo elsewhere: an older copy that skips versions (v3 back to v0) is still a rollback', async () => {
  const L = lab();
  const body = lines(20, 'week');
  L.outside('note.md', body); await L.track('note.md');
  for (const t of [body + 'one\n', body + 'one\ntwo\n', body + 'one\ntwo\nthree\n']) assert.equal(await outsideWrite(L, 'note.md', t), null);
  const o = await outsideWrite(L, 'note.md', body);
  assert.deepEqual([o.kind, o.severity, o.lostLines], ['rolled-back', 'high', 3]);
});

test('undo elsewhere: a version typed here breaks the chain, and a later step back over it is a rollback', async () => {
  // Typed here on top of the undone version: going back further discards it.
  const L = lab();
  const body = lines(20, 'week');
  L.outside('note.md', body); await L.track('note.md');
  for (const t of [body + 'X\n', body + 'X\nY\n', body + 'X\n']) assert.equal(await outsideWrite(L, 'note.md', t), null);
  await typeSession(L, 'note.md', 1);
  const broken = await outsideWrite(L, 'note.md', body + 'X\n');
  assert.deepEqual([broken.kind, broken.severity], ['rolled-back', 'high']);
  // Typed here, then the other device's change undone back to it: the typed version stays protected.
  const M = lab();
  M.outside('note.md', body); await M.track('note.md');
  assert.equal(await outsideWrite(M, 'note.md', body + 'X\n'), null);
  await typeSession(M, 'note.md', 1);
  assert.equal(await outsideWrite(M, 'note.md', body + 'X\ntyped 1\nY\n'), null);
  assert.equal(await outsideWrite(M, 'note.md', body + 'X\ntyped 1\n'), null); // undo of Y: discards an outside version
  const o = await outsideWrite(M, 'note.md', body + 'X\n'); // next step back discards the typed line
  assert.deepEqual([o.kind, o.severity], ['rolled-back', 'high']);
});

test('undo elsewhere: a change found at startup, then undone by the other device → ordinary editing', async () => {
  const L = lab();
  L.p.store.getMeta = async (k, d) => d;
  L.p.app.vault.getFiles = () => [...L.objects.values()];
  const body = lines(20, 'week');
  L.outside('note.md', body + '- [ ] call the printer\n'); await L.track('note.md');
  L.outside('note.md', body + '- [x] call the printer\n'); // ticked on the other device while this app was closed
  await L.p.reconcile('startup');
  assert.equal(L.p.incidents.length, 0);
  assert.equal(L.p.files.get('note.md').origin, 'closed');
  assert.equal(await outsideWrite(L, 'note.md', body + '- [ ] call the printer\n'), null);
});

test('undo elsewhere: an attachment put back to its previous bytes (A, B, A) is still a rollback', async () => {
  const L = lab();
  const v = (fill) => new Uint8Array(64 * 1024).fill(fill).buffer;
  L.write('photo.png', v(1)); await L.track('photo.png');
  L.write('photo.png', v(2)); await L.p.onModify(L.objects.get('photo.png'));
  assert.deepEqual(L.p.pendingObservations.splice(0), []);
  L.write('photo.png', v(1)); await L.p.onModify(L.objects.get('photo.png'));
  const o = L.p.pendingObservations.splice(0)[0];
  assert.deepEqual([o.kind, o.severity], ['rolled-back', 'high']);
});

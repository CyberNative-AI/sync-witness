// Pure detection logic. No Obsidian or DOM imports, so it runs under plain Node for tests.

const TEXT_EXTENSIONS = new Set(['md', 'canvas', 'base', 'txt', 'csv', 'json', 'yaml', 'yml', 'org', 'tex']);

const DEFAULTS = {
  attachmentFileCapMB: 20, // largest attachment we keep a copy of
  attachmentTotalCapMB: 1024, // total budget for attachment copies on this device
  textFileCapMB: 10, // notes are always copied; this only guards against pathological files
  quietSeconds: 3, // wait this long after the last change before judging a burst
  incidentGapSeconds: 120, // changes closer together than this join the same incident
  historyDepth: 12, // the most recent earlier hashes per file, to recognise rollbacks
  settleSeconds: 60, // a version unchanged this long is one another device may hold
  settledDepth: 32, // settled versions remembered per file; typing never pushes these out
};

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function isText(path) {
  return TEXT_EXTENSIONS.has(extensionOf(path));
}

function shouldKeepCopy(path, size, settings, attachmentBytesInUse) {
  const mb = 1024 * 1024;
  if (isText(path)) return size <= settings.textFileCapMB * mb;
  if (size > settings.attachmentFileCapMB * mb) return false;
  return attachmentBytesInUse + size <= settings.attachmentTotalCapMB * mb;
}

function splitLines(text) {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').split('\n');
}

// Earlier versions remembered when `previous` is replaced by `hash`. `history` keeps the last few
// saved versions. Autosaves fill it quickly, so `settled` separately keeps the versions another
// device is likely to hold and write back: any version that stayed unchanged for settleSeconds,
// and any version not typed here (written by a sync tool, another program, a plugin, or found at
// inventory or startup).
function rememberVersion(previous, hash, now, settings) {
  const history = (previous.history || []).filter((h) => h !== previous.hash && h !== hash);
  history.push(previous.hash);
  let settled = (previous.settled || []).slice();
  const since = previous.since != null ? previous.since : previous.mtime;
  if (previous.origin !== 'editor' || now - since >= settings.settleSeconds * 1000) {
    settled = settled.filter((h) => h !== previous.hash);
    settled.push(previous.hash);
  }
  return { history: history.slice(-settings.historyDepth), settled: settled.slice(-settings.settledDepth) };
}

function knownVersions(entry) {
  return (entry.history || []).concat(entry.settled || []);
}

// The other device undoing its own last change (a checkbox unticked, a line typed and removed)
// returns a note to the version just before the current one. When the current version came from
// outside and was never typed or restored here, that step is ordinary editing there: it is judged
// by the cut rules only, and the version it discards stops being the reference, so the next step
// back is judged the same way. A version typed or restored here (`local`) stays protected, and an
// older copy that skips versions is still a rollback. Notes only: an attachment put back to its
// previous bytes stays a rollback.
function isUndoStep(entry, hash) {
  const history = entry.history || [];
  return isText(entry.path) && ['outside', 'plugin', 'closed'].includes(entry.origin)
    && !(entry.local || []).includes(entry.hash) && history.length > 0 && history[history.length - 1] === hash;
}

// Multiset line difference: which lines vanished and which appeared.
function lineDelta(before, after) {
  const counts = new Map();
  for (const line of splitLines(before)) counts.set(line, (counts.get(line) || 0) + 1);
  const added = [];
  for (const line of splitLines(after)) {
    const n = counts.get(line) || 0;
    if (n > 0) counts.set(line, n - 1);
    else added.push(line);
  }
  const removed = [];
  for (const [line, n] of counts) for (let i = 0; i < n; i++) removed.push(line);
  const bytes = (lines) => lines.reduce((s, l) => s + l.length + 1, 0);
  const meaningful = (lines) => lines.filter((l) => l.trim() !== '');
  return {
    removedLines: meaningful(removed).length,
    addedLines: meaningful(added).length,
    removedBytes: bytes(removed),
    addedBytes: bytes(added),
  };
}

// Judge a content change that did not come from typing in this window or from the user's own
// action here. Returns null when the change looks like ordinary editing.
//   before/after: {hash, size, text?}  (text only for notes)
//   history: earlier hashes this device has seen for the path (knownVersions)
//   source: 'outside' | 'plugin' | 'closed'
function judgeChange(before, after, history, source) {
  if (before.hash === after.hash) return null;
  if (before.size > 0 && after.size === 0) {
    return { kind: 'emptied', severity: 'high', lostBytes: before.size, lostLines: before.text ? lineDelta(before.text, '').removedLines : 0 };
  }
  const olderVersion = history.includes(after.hash);
  if (before.text != null && after.text != null) {
    const d = lineDelta(before.text, after.text);
    const lostLines = Math.max(0, d.removedLines - d.addedLines);
    const lostBytes = Math.max(0, d.removedBytes - d.addedBytes);
    if (lostLines === 0 && !(olderVersion && d.removedLines > 0)) return null;
    if (olderVersion) return { kind: 'rolled-back', severity: 'high', lostBytes, lostLines: Math.max(lostLines, d.removedLines) };
    const share = before.size ? lostBytes / before.size : 0;
    if (share >= 0.5 && lostLines >= 2) return { kind: 'shrunk', severity: 'high', lostBytes, lostLines };
    // Inside the app (plugins, properties panel) small removals are ordinary housekeeping.
    if (source === 'plugin') return null;
    if (share >= 0.25 || lostLines >= 10) return { kind: 'shrunk', severity: 'medium', lostBytes, lostLines };
    return null;
  }
  // Attachments: only an exact earlier version counts; other replacements are ordinary updates.
  if (olderVersion) return { kind: 'rolled-back', severity: 'high', lostBytes: Math.max(0, before.size - after.size), lostLines: 0 };
  return null;
}

// Pair vanished files with files that appeared elsewhere holding the same bytes: those are moves.
function pairMoves(removed, created) {
  const byHash = new Map();
  for (const c of created) {
    if (!byHash.has(c.hash)) byHash.set(c.hash, []);
    byHash.get(c.hash).push(c);
  }
  const moves = [];
  const unpaired = [];
  for (const r of removed) {
    const list = byHash.get(r.hash);
    if (list && list.length) moves.push({ from: r.path, to: list.shift().path });
    else unpaired.push(r);
  }
  return { moves, unpaired };
}

function folderOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

// One-line human summary of an incident's open items.
function describeIncident(items) {
  const open = items.filter((i) => !i.resolved);
  const removed = open.filter((i) => i.kind === 'removed');
  const notes = removed.filter((i) => isText(i.path)).length;
  const files = removed.length - notes;
  const changed = open.filter((i) => i.kind !== 'removed');
  const parts = [];
  if (notes) parts.push(`${plural(notes, 'note')} removed`);
  if (files) parts.push(`${plural(files, 'attachment')} removed`);
  const rolled = changed.filter((i) => i.kind === 'rolled-back').length;
  const emptied = changed.filter((i) => i.kind === 'emptied').length;
  const shrunk = changed.filter((i) => i.kind === 'shrunk').length;
  if (rolled) parts.push(`${plural(rolled, 'note')} replaced by an older version`);
  if (emptied) parts.push(`${plural(emptied, 'file')} emptied`);
  if (shrunk) parts.push(`${plural(shrunk, 'note')} lost text`);
  const folders = new Set(open.map((i) => folderOf(i.path))).size;
  const bytes = open.reduce((s, i) => s + (i.lostBytes || 0), 0);
  return { text: parts.join(', '), folders, bytes, count: open.length };
}

function headline(items) {
  const open = items.filter((i) => !i.resolved);
  const removed = open.filter((i) => i.kind === 'removed').length;
  if (open.length === 0) return 'Everything in this incident is back';
  if (removed === open.length) return removed === 1 ? '1 file went missing from this vault' : `${removed} files went missing from this vault`;
  if (removed === 0 && open.length === 1) {
    const k = open[0].kind;
    if (k === 'rolled-back') return 'A note was replaced by an older version';
    if (k === 'emptied') return 'A file was emptied';
    return 'A note lost some of its text';
  }
  return `${open.length} files were removed or lost content`;
}

module.exports = { DEFAULTS, TEXT_EXTENSIONS, extensionOf, isText, shouldKeepCopy, rememberVersion, knownVersions, isUndoStep, lineDelta, judgeChange, pairMoves, folderOf, formatBytes, plural, describeIncident, headline };

// Wraps the vault adapter and the file manager so Sync Witness learns what this app itself wrote,
// renamed or deleted. The original call always runs with the same arguments and its result is
// returned unchanged: if our bookkeeping fails, the save or delete still happens exactly as it
// would without the plugin. No Obsidian imports, so it runs under plain Node for tests.

const ADAPTER_WRITES = ['write', 'writeBinary'];
const ADAPTER_APPENDS = ['append', 'appendBinary'];
const ADAPTER_DELETES = ['remove', 'trashSystem', 'trashLocal', 'rmdir'];
const USER_DELETES = ['trashFile', 'promptForDeletion'];

//   hooks: { write(path, data), append(path), remove(path), rename(from, to), userDelete(file), onError(e) }
// Returns undo functions that put the originals back.
function installWritePatches(adapter, fileManager, hooks) {
  const unpatches = [];
  const safely = (name, ...args) => {
    try {
      hooks[name](...args);
    } catch (e) {
      try { hooks.onError(e); } catch { /* reporting must not block the call either */ }
    }
  };
  const wrap = (obj, name, make) => {
    const original = obj && obj[name];
    if (typeof original !== 'function') return;
    const replacement = make(original);
    try { obj[name] = replacement; } catch { return; }
    unpatches.push(() => { if (obj[name] === replacement) obj[name] = original; });
  };

  for (const name of ADAPTER_WRITES) {
    wrap(adapter, name, (orig) => function (path, data, ...rest) {
      safely('write', path, data);
      return orig.call(this, path, data, ...rest);
    });
  }
  for (const name of ADAPTER_APPENDS) {
    wrap(adapter, name, (orig) => function (path, ...rest) {
      safely('append', path);
      return orig.call(this, path, ...rest);
    });
  }
  wrap(adapter, 'process', (orig) => function (path, fn, ...rest) {
    if (typeof fn !== 'function') return orig.call(this, path, fn, ...rest);
    return orig.call(this, path, function (...args) {
      const out = fn.apply(this, args);
      safely('write', path, out);
      return out;
    }, ...rest);
  });
  for (const name of ADAPTER_DELETES) {
    wrap(adapter, name, (orig) => function (path, ...rest) {
      safely('remove', path);
      return orig.call(this, path, ...rest);
    });
  }
  wrap(adapter, 'rename', (orig) => function (from, to, ...rest) {
    safely('rename', from, to);
    return orig.call(this, from, to, ...rest);
  });
  // Deleting through the file explorer, the command palette or a delete key ends here.
  for (const name of USER_DELETES) {
    wrap(fileManager, name, (orig) => function (file, ...rest) {
      safely('userDelete', file);
      return orig.call(this, file, ...rest);
    });
  }
  return unpatches;
}

module.exports = { installWritePatches };

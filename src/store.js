// Device-local storage in IndexedDB. Nothing here is written into the vault, so sync tools
// never carry it to another device and it cannot be deleted by the same failure it watches for.

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

class Store {
  constructor(name) {
    this.name = name;
    this.db = null;
  }

  async open() {
    const req = indexedDB.open(this.name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('files', { keyPath: 'path' });
      db.createObjectStore('blobs', { keyPath: 'hash' });
      db.createObjectStore('incidents', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    this.db = await promisify(req);
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  // After destroy() every call is a no-op, so late timers cannot recreate the store.
  async all(store) {
    if (!this.db) return [];
    const tx = this.db.transaction(store, 'readonly');
    return promisify(tx.objectStore(store).getAll());
  }

  async get(store, key) {
    if (!this.db) return undefined;
    const tx = this.db.transaction(store, 'readonly');
    return promisify(tx.objectStore(store).get(key));
  }

  async put(store, value) {
    if (!this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await done(tx);
  }

  async putMany(store, values) {
    if (!values.length || !this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const v of values) os.put(v);
    await done(tx);
  }

  async deleteMany(store, keys) {
    if (!keys.length || !this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const k of keys) os.delete(k);
    await done(tx);
  }

  async hasBlob(hash) {
    if (!this.db) return false;
    const tx = this.db.transaction('blobs', 'readonly');
    const key = await promisify(tx.objectStore('blobs').getKey(hash));
    return key !== undefined;
  }

  async putBlob(hash, data) {
    if (await this.hasBlob(hash)) return;
    await this.put('blobs', { hash, size: data.byteLength, data });
  }

  async getBlob(hash) {
    const row = await this.get('blobs', hash);
    return row ? row.data : null;
  }

  async blobKeys() {
    if (!this.db) return [];
    const tx = this.db.transaction('blobs', 'readonly');
    return promisify(tx.objectStore('blobs').getAllKeys());
  }

  async getMeta(key, fallback) {
    const row = await this.get('meta', key);
    return row ? row.value : fallback;
  }

  async setMeta(key, value) {
    await this.put('meta', { key, value });
  }

  // Bytes held by stored copies, read one copy at a time.
  async usage() {
    if (!this.db) return { bytes: 0, copies: 0 };
    const tx = this.db.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').openCursor();
    let bytes = 0;
    let copies = 0;
    return new Promise((resolve, reject) => {
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve({ bytes, copies });
        bytes += cursor.value.size || 0;
        copies++;
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Deletes this vault's database on this device: every copy, the record and the incident log.
  async destroy() {
    this.close();
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(this.name);
      let timer = null;
      req.onsuccess = () => { clearTimeout(timer); resolve(); };
      req.onerror = () => { clearTimeout(timer); reject(req.error); };
      req.onblocked = () => {
        timer = setTimeout(() => reject(new Error('Another window still has the stored copies open.')), 10000);
      };
    });
  }
}

module.exports = { Store };

/**
 * DesInspect — IndexedDB layer.
 *
 * Single store: `changes`, keyed by a synthetic id derived from
 * (urlPattern, selector, property). Snapshots use a separate store.
 *
 * urlPattern = origin + pathname (query/hash stripped) so edits on
 * /dashboard?tab=1 and /dashboard?tab=2 share state.
 */

const PersistDB = (() => {
  const DB_NAME = 'desinspect';
  const DB_VERSION = 2;
  const STORE_CHANGES = 'changes';
  const STORE_SNAPSHOTS = 'snapshots';

  let _dbPromise = null;
  let _dbInstance = null; // cached handle for synchronous transactions (unload flush)

  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_CHANGES)) {
          const s = db.createObjectStore(STORE_CHANGES, { keyPath: 'id' });
          s.createIndex('byUrl', 'urlPattern', { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          const s = db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id', autoIncrement: true });
          s.createIndex('byUrl', 'urlPattern', { unique: false });
        }
      };
      req.onsuccess = (e) => {
        _dbInstance = e.target.result;
        resolve(_dbInstance);
      };
      req.onerror = (e) => reject(e.target.error);
    });
    return _dbPromise;
  }

  /**
   * Fire-and-forget write that starts its transaction synchronously (for
   * unload handlers). Needs the DB to be open already; no-op otherwise.
   */
  function putChangesSync(records) {
    if (!_dbInstance) return;
    try {
      const store = _dbInstance.transaction(STORE_CHANGES, 'readwrite').objectStore(STORE_CHANGES);
      for (const r of records) store.put(r);
    } catch (err) {
      console.warn('[DesInspect] unload flush failed:', err);
    }
  }

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url;
    }
  }

  function wrap(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(store, mode = 'readonly') {
    const db = await open();
    return db.transaction(store, mode).objectStore(store);
  }

  // ─── Changes ───────────────────────────────────────────────────────────────

  /**
   * @param {{
   *   urlPattern: string,
   *   selector: string,
   *   selectorType?: string,
   *   property: string,       // CSS prop, or '__html__', or '__remove__'
   *   value: string,
   *   originalValue?: string,
   *   disabled?: boolean,
   *   elementTag?: string,
   *   elementLabel?: string,
   * }} c
   */
  async function putChange(c) {
    const id = c.id || `${c.urlPattern}::${c.selector}::${c.property}`;
    // Preserve the caller's timestamp — undo/redo and snapshot restore write
    // historical records, and structural replay order depends on creation
    // time. Only stamp when the caller didn't.
    const record = { ...c, id, timestamp: c.timestamp ?? Date.now() };
    const store = await tx(STORE_CHANGES, 'readwrite');
    await wrap(store.put(record));
    return record;
  }

  async function deleteChange(id) {
    const store = await tx(STORE_CHANGES, 'readwrite');
    return wrap(store.delete(id));
  }

  async function getChange(id) {
    const store = await tx(STORE_CHANGES);
    return wrap(store.get(id));
  }

  async function getChangesForUrl(url) {
    const store = await tx(STORE_CHANGES);
    const idx = store.index('byUrl');
    return wrap(idx.getAll(normalizeUrl(url)));
  }

  async function clearChangesForUrl(url) {
    const changes = await getChangesForUrl(url);
    const store = await tx(STORE_CHANGES, 'readwrite');
    await Promise.all(changes.map((c) => wrap(store.delete(c.id))));
    return changes.length;
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────────

  async function createSnapshot(url, name) {
    const urlPattern = normalizeUrl(url);
    const changes = await getChangesForUrl(url);
    const store = await tx(STORE_SNAPSHOTS, 'readwrite');
    const id = await wrap(
      store.add({
        urlPattern,
        name: name || `Snapshot ${new Date().toLocaleString()}`,
        changes,
        timestamp: Date.now(),
      })
    );
    return id;
  }

  async function getSnapshotsForUrl(url) {
    const store = await tx(STORE_SNAPSHOTS);
    const idx = store.index('byUrl');
    const all = await wrap(idx.getAll(normalizeUrl(url)));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  async function deleteSnapshot(id) {
    const store = await tx(STORE_SNAPSHOTS, 'readwrite');
    return wrap(store.delete(id));
  }

  return {
    open,
    putChangesSync,
    normalizeUrl,
    putChange,
    deleteChange,
    getChange,
    getChangesForUrl,
    clearChangesForUrl,
    createSnapshot,
    getSnapshotsForUrl,
    deleteSnapshot,
  };
})();

if (typeof window !== 'undefined') window.PersistDB = PersistDB;

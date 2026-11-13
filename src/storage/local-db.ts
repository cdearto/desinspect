/**
 * DesInspect — IndexedDB layer.
 *
 * Two stores: `changes` (see ChangeRecord) and `snapshots`, both indexed by
 * urlPattern = origin + pathname, so /dashboard?tab=1 and /dashboard?tab=2
 * share their edits.
 */

const PersistDB = (() => {
  const DB_NAME = 'desinspect';
  const DB_VERSION = 2;
  const STORE_CHANGES = 'changes';
  const STORE_SNAPSHOTS = 'snapshots';

  let _dbPromise: Promise<IDBDatabase> | null = null;
  let _db: IDBDatabase | null = null; // set once open() resolves; used by putChangesSync

  function open(): Promise<IDBDatabase> {
    _dbPromise ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_CHANGES)) {
          db.createObjectStore(STORE_CHANGES, { keyPath: 'id' }).createIndex('byUrl', 'urlPattern');
        }
        if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
          db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'id', autoIncrement: true })
            .createIndex('byUrl', 'urlPattern');
        }
      };
      req.onsuccess = () => {
        _db = req.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`;
    } catch {
      return url;
    }
  }

  function wrap<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function store(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  // ─── Changes ───────────────────────────────────────────────────────────────

  async function putChange(record: ChangeRecord): Promise<void> {
    await wrap((await store(STORE_CHANGES, 'readwrite')).put(record));
  }

  /**
   * Fire-and-forget write that starts its transaction synchronously (for
   * unload handlers). Needs the DB to be open already; no-op otherwise.
   */
  function putChangesSync(records: ChangeRecord[]): void {
    if (!_db) return;
    try {
      const changes = _db.transaction(STORE_CHANGES, 'readwrite').objectStore(STORE_CHANGES);
      for (const r of records) changes.put(r);
    } catch (err) {
      console.warn('[DesInspect] unload flush failed:', err);
    }
  }

  async function deleteChange(id: string): Promise<void> {
    await wrap((await store(STORE_CHANGES, 'readwrite')).delete(id));
  }

  async function getChange(id: string): Promise<ChangeRecord | undefined> {
    return wrap((await store(STORE_CHANGES)).get(id));
  }

  async function getChangesForUrl(url: string): Promise<ChangeRecord[]> {
    return wrap((await store(STORE_CHANGES)).index('byUrl').getAll(normalizeUrl(url)));
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────────

  /** Save the URL's current changes as a named snapshot; returns its id. */
  async function createSnapshot(url: string, name: string): Promise<number> {
    const changes = await getChangesForUrl(url);
    const s = await store(STORE_SNAPSHOTS, 'readwrite');
    const id = await wrap(
      s.add({
        urlPattern: normalizeUrl(url),
        name: name || `Snapshot ${new Date().toLocaleString()}`,
        changes,
        timestamp: Date.now(),
      })
    );
    return id as number;
  }

  /** Snapshots for a URL, newest first. */
  async function getSnapshotsForUrl(url: string): Promise<Snapshot[]> {
    const all: Snapshot[] = await wrap((await store(STORE_SNAPSHOTS)).index('byUrl').getAll(normalizeUrl(url)));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  async function deleteSnapshot(id: number): Promise<void> {
    await wrap((await store(STORE_SNAPSHOTS, 'readwrite')).delete(id));
  }

  return {
    open,
    normalizeUrl,
    putChange,
    putChangesSync,
    deleteChange,
    getChange,
    getChangesForUrl,
    createSnapshot,
    getSnapshotsForUrl,
    deleteSnapshot,
  };
})();

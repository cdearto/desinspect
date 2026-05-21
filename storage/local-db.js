/**
 * DesInspect — IndexedDB Storage Layer
 * 
 * Provides async CRUD operations for:
 * - Changes (individual CSS/HTML edits, keyed by URL + selector)
 * - Snapshots (manual save points)
 * - Version history (timestamped change entries)
 * 
 * All data is scoped to a normalized URL pattern so edits on
 * /dashboard don't bleed into /settings.
 */

const PersistDB = (() => {
  const DB_NAME = 'desinspect';
  const DB_VERSION = 1;

  // Store names
  const STORES = {
    CHANGES: 'changes',       // Active changes per element per URL
    HISTORY: 'history',       // Full version history log
    SNAPSHOTS: 'snapshots',   // Manual save points
  };

  let _db = null;

  // ─── Database Initialization ──────────────────────────────────────────────

  /**
   * Open (or create) the database. Returns a promise that resolves
   * with the IDBDatabase instance.
   */
  function open() {
    if (_db) return Promise.resolve(_db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Changes store: keyed by compound key [urlPattern, selector]
        if (!db.objectStoreNames.contains(STORES.CHANGES)) {
          const changeStore = db.createObjectStore(STORES.CHANGES, { keyPath: 'id' });
          changeStore.createIndex('byUrl', 'urlPattern', { unique: false });
          changeStore.createIndex('bySelector', 'selector', { unique: false });
          changeStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        }

        // History store: append-only log of every edit
        if (!db.objectStoreNames.contains(STORES.HISTORY)) {
          const historyStore = db.createObjectStore(STORES.HISTORY, {
            keyPath: 'id',
            autoIncrement: true
          });
          historyStore.createIndex('byUrl', 'urlPattern', { unique: false });
          historyStore.createIndex('byChangeId', 'changeId', { unique: false });
          historyStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        }

        // Snapshots store: named save points
        if (!db.objectStoreNames.contains(STORES.SNAPSHOTS)) {
          const snapshotStore = db.createObjectStore(STORES.SNAPSHOTS, {
            keyPath: 'id',
            autoIncrement: true
          });
          snapshotStore.createIndex('byUrl', 'urlPattern', { unique: false });
          snapshotStore.createIndex('byTimestamp', 'timestamp', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        _db = event.target.result;
        resolve(_db);
      };

      request.onerror = (event) => {
        console.error('[DesInspect] IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // ─── URL Normalization ────────────────────────────────────────────────────

  /**
   * Normalize a URL to a pattern suitable for scoping changes.
   * Strips query params and hash, keeps origin + pathname.
   * e.g. "https://app.example.com/dashboard?tab=1#section" → "https://app.example.com/dashboard"
   */
  function normalizeUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  // ─── Generic Transaction Helper ───────────────────────────────────────────

  function transaction(storeName, mode = 'readonly') {
    return _db.transaction(storeName, mode).objectStore(storeName);
  }

  function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ─── Changes CRUD ─────────────────────────────────────────────────────────

  /**
   * Save or update a change record.
   * @param {Object} change - { urlPattern, selector, property, value, originalValue, elementTag, annotation? }
   * @returns {Promise<string>} The change ID
   */
  async function saveChange(change) {
    await open();
    const id = change.id || `${change.urlPattern}::${change.selector}::${change.property}`;
    const record = {
      ...change,
      id,
      urlPattern: change.urlPattern,
      timestamp: Date.now(),
    };

    const store = transaction(STORES.CHANGES, 'readwrite');
    await promisifyRequest(store.put(record));

    // Also append to history log
    await appendHistory({
      changeId: id,
      urlPattern: change.urlPattern,
      selector: change.selector,
      property: change.property,
      value: change.value,
      previousValue: change.previousValue || change.originalValue,
      timestamp: Date.now(),
      type: 'css_edit',
    });

    return id;
  }

  /**
   * Get all active changes for a given URL.
   * @param {string} url - The page URL
   * @returns {Promise<Array>} Array of change records
   */
  async function getChangesForUrl(url) {
    await open();
    const urlPattern = normalizeUrl(url);
    const store = transaction(STORES.CHANGES);
    const index = store.index('byUrl');
    return promisifyRequest(index.getAll(urlPattern));
  }

  /**
   * Get a specific change by ID.
   */
  async function getChange(id) {
    await open();
    const store = transaction(STORES.CHANGES);
    return promisifyRequest(store.get(id));
  }

  /**
   * Delete a specific change (revert).
   */
  async function deleteChange(id) {
    await open();
    const store = transaction(STORES.CHANGES, 'readwrite');
    return promisifyRequest(store.delete(id));
  }

  /**
   * Delete all changes for a URL.
   */
  async function clearChangesForUrl(url) {
    await open();
    const urlPattern = normalizeUrl(url);
    const changes = await getChangesForUrl(url);
    const store = transaction(STORES.CHANGES, 'readwrite');
    const promises = changes.map(c => promisifyRequest(store.delete(c.id)));
    return Promise.all(promises);
  }

  // ─── History Log ──────────────────────────────────────────────────────────

  /**
   * Append an entry to the history log.
   */
  async function appendHistory(entry) {
    await open();
    const store = transaction(STORES.HISTORY, 'readwrite');
    return promisifyRequest(store.add({
      ...entry,
      timestamp: entry.timestamp || Date.now(),
    }));
  }

  /**
   * Get history entries for a URL, ordered by timestamp.
   * @param {string} url 
   * @param {number} limit - Max entries to return (default 50)
   */
  async function getHistoryForUrl(url, limit = 50) {
    await open();
    const urlPattern = normalizeUrl(url);
    const store = transaction(STORES.HISTORY);
    const index = store.index('byUrl');
    const all = await promisifyRequest(index.getAll(urlPattern));
    // Sort newest first and limit
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /**
   * Get history for a specific change ID.
   */
  async function getHistoryForChange(changeId) {
    await open();
    const store = transaction(STORES.HISTORY);
    const index = store.index('byChangeId');
    return promisifyRequest(index.getAll(changeId));
  }

  // ─── Snapshots ────────────────────────────────────────────────────────────

  /**
   * Create a named snapshot of all current changes for a URL.
   * @param {string} url 
   * @param {string} name - User-provided snapshot name
   */
  async function createSnapshot(url, name = '') {
    await open();
    const urlPattern = normalizeUrl(url);
    const changes = await getChangesForUrl(url);
    const store = transaction(STORES.SNAPSHOTS, 'readwrite');
    return promisifyRequest(store.add({
      urlPattern,
      name: name || `Snapshot ${new Date().toLocaleString()}`,
      changes: JSON.parse(JSON.stringify(changes)),
      timestamp: Date.now(),
    }));
  }

  /**
   * Get all snapshots for a URL.
   */
  async function getSnapshotsForUrl(url) {
    await open();
    const urlPattern = normalizeUrl(url);
    const store = transaction(STORES.SNAPSHOTS);
    const index = store.index('byUrl');
    const all = await promisifyRequest(index.getAll(urlPattern));
    return all.sort((a, b) => b.timestamp - a.timestamp);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    open,
    normalizeUrl,
    // Changes
    saveChange,
    getChangesForUrl,
    getChange,
    deleteChange,
    clearChangesForUrl,
    // History
    appendHistory,
    getHistoryForUrl,
    getHistoryForChange,
    // Snapshots
    createSnapshot,
    getSnapshotsForUrl,
  };
})();

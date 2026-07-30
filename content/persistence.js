/**
 * DesInspect — Persistence runtime.
 *
 * Wraps PersistDB with: re-apply on load, debounced writes, SPA navigation
 * handling, a single "user-overrides" stylesheet that holds every CSS edit,
 * and a record-level edit history powering undo/redo.
 *
 * History model: every mutation is a set of record transitions
 *   op = { id, before: record|null, after: record|null }
 * saveChange, deleteChange, clearAll, and restoreSnapshot all reduce to ops,
 * so undo/redo uniformly rolls records back/forward and re-applies the DOM.
 */

const Persistence = (() => {
  const DEBOUNCE_MS = 300;
  const STYLESHEET_ID = 'desinspect-overrides';
  let _currentUrl = location.href;
  let _saveTimers = new Map();
  let _cache = new Map(); // id → record (in-memory mirror of IDB for this URL)

  // Live-element registry for HTML-edited nodes. After an outerHTML replace
  // the stored selector may no longer resolve (e.g. span → button), so we
  // remember which live node each __html__ record currently owns.
  const _liveEls = new Map(); // record id → Element

  // When we mutate the DOM ourselves, the MutationObserver would otherwise
  // re-fire reapply() in a loop. Mark a settle window after destructive
  // applies and let the MO ignore anything within it.
  let _suppressUntil = 0;
  function markOurMutation(ms = 800) {
    _suppressUntil = Math.max(_suppressUntil, Date.now() + ms);
  }

  // ─── Edit history ──────────────────────────────────────────────────────────

  const MAX_HISTORY = 100;
  const COALESCE_MS = 1000;
  let _undoStack = []; // Array<{ label, ops: [{id, before, after}], at }>
  let _redoStack = [];

  function pushHistory(label, ops) {
    if (!ops.length) return;
    const now = Date.now();
    // Coalesce rapid edits to the same single record (live typing, color
    // dragging) into one undoable step: keep the original `before`, roll
    // `after` forward.
    const top = _undoStack[_undoStack.length - 1];
    if (
      top &&
      ops.length === 1 &&
      top.ops.length === 1 &&
      top.ops[0].id === ops[0].id &&
      now - top.at < COALESCE_MS
    ) {
      top.ops[0].after = ops[0].after;
      top.label = label;
      top.at = now;
      _redoStack = [];
      broadcastUndoState();
      return;
    }
    _undoStack.push({ label, ops, at: now });
    if (_undoStack.length > MAX_HISTORY) _undoStack.shift();
    _redoStack = [];
    broadcastUndoState();
  }

  function broadcastUndoState() {
    notifyPanel('UNDO_STATE', {
      canUndo: _undoStack.length > 0,
      canRedo: _redoStack.length > 0,
    });
  }

  async function applyOpDirection(op, useBefore) {
    const target = useBefore ? op.before : op.after;
    const other = useBefore ? op.after : op.before;
    if (target) {
      _cache.set(op.id, target);
      await PersistDB.putChange({ ...target });
      applyRecord(target);
    } else if (other) {
      // Record is being removed in this direction → unapply from DOM + IDB.
      _cache.delete(op.id);
      await PersistDB.deleteChange(op.id);
      unapplyRecord(other);
    }
  }

  async function undo() {
    const entry = _undoStack.pop();
    if (!entry) return { done: false };
    for (const op of [...entry.ops].reverse()) {
      await applyOpDirection(op, true);
    }
    _redoStack.push(entry);
    broadcastUndoState();
    notifyPanel('HISTORY_APPLIED', { direction: 'undo', label: entry.label });
    return { done: true, label: entry.label };
  }

  async function redo() {
    const entry = _redoStack.pop();
    if (!entry) return { done: false };
    for (const op of entry.ops) {
      await applyOpDirection(op, false);
    }
    _undoStack.push(entry);
    broadcastUndoState();
    notifyPanel('HISTORY_APPLIED', { direction: 'redo', label: entry.label });
    return { done: true, label: entry.label };
  }

  function getUndoState() {
    return { canUndo: _undoStack.length > 0, canRedo: _redoStack.length > 0 };
  }

  // ─── Override stylesheet ───────────────────────────────────────────────────

  function getStylesheet() {
    let el = document.getElementById(STYLESHEET_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLESHEET_ID;
      el.setAttribute('data-desinspect', 'true');
      // Last in document order so we win specificity ties.
      document.documentElement.appendChild(el);
    }
    return el.sheet;
  }

  function applyRuleToSheet(record) {
    const sheet = getStylesheet();
    const ruleSelector = record.selector;
    // Disabled records override with `revert` so the property actually turns
    // off; otherwise the author rule keeps applying under our checkbox.
    const value = record.disabled ? 'revert' : record.value;
    const cssText = `${ruleSelector} { ${record.property}: ${value} !important; }`;

    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (
        r.selectorText === ruleSelector &&
        r.style.length === 1 &&
        r.style[0] === record.property
      ) {
        sheet.deleteRule(i);
      }
    }

    try {
      sheet.insertRule(cssText, sheet.cssRules.length);
    } catch (err) {
      console.warn('[DesInspect] insertRule failed:', cssText, err);
    }
  }

  function removeRuleFromSheet(selector, property) {
    const sheet = getStylesheet();
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (
        r.selectorText === selector &&
        r.style.length === 1 &&
        r.style[0] === property
      ) {
        sheet.deleteRule(i);
      }
    }
  }

  // ─── Record application ────────────────────────────────────────────────────

  function findLive(record) {
    const live = _liveEls.get(record.id);
    if (live && live.isConnected) return live;
    return SelectorEngine.find({ type: record.selectorType, value: record.selector });
  }

  function parseFirstElement(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    return tmpl.content.firstElementChild;
  }

  function applyHtmlChange(record) {
    const el = findLive(record);
    if (!el) return false;
    // Idempotence: silent reapplies (MutationObserver settles) must not
    // re-replace an already-applied subtree — that would reset focus and
    // listeners every time the SPA re-renders elsewhere.
    if (el.outerHTML === record.value) {
      _liveEls.set(record.id, el);
      return true;
    }
    markOurMutation();
    const newEl = parseFirstElement(record.value);
    if (newEl) {
      el.replaceWith(newEl);
      _liveEls.set(record.id, newEl);
    } else {
      el.innerHTML = record.value;
      _liveEls.set(record.id, el);
    }
    return true;
  }

  function unapplyHtmlChange(record) {
    const el = findLive(record);
    if (!el || record.originalValue == null) return false;
    markOurMutation();
    const restored = parseFirstElement(record.originalValue);
    if (restored) {
      el.replaceWith(restored);
    } else {
      el.innerHTML = record.originalValue;
    }
    _liveEls.delete(record.id);
    return true;
  }

  function applyRemoveChange(record) {
    const el = findLive(record);
    if (!el) return false;
    markOurMutation();
    el.remove();
    return true;
  }

  function unapplyRemoveChange(record) {
    // Re-insert from stored restore info.
    if (!record.originalValue || !record.parentSelector) return false;
    const parent = SelectorEngine.find({
      type: record.parentSelectorType || 'css',
      value: record.parentSelector,
    });
    if (!parent) return false;
    markOurMutation();
    const restored = parseFirstElement(record.originalValue);
    if (!restored) return false;
    const children = Array.from(parent.children);
    const idx = typeof record.childIndex === 'number' ? record.childIndex : children.length;
    if (idx >= 0 && idx < children.length) {
      parent.insertBefore(restored, children[idx]);
    } else {
      parent.appendChild(restored);
    }
    return true;
  }

  function applyRecord(record) {
    if (record.property === '__html__') return applyHtmlChange(record);
    if (record.property === '__remove__') return applyRemoveChange(record);
    // CSS rule selectors only work in stylesheets; XPath goes inline.
    if (record.selectorType === 'xpath') return applyInlineStyle(record);
    applyRuleToSheet(record);
    return true;
  }

  function unapplyRecord(record) {
    if (record.property === '__html__') return unapplyHtmlChange(record);
    if (record.property === '__remove__') return unapplyRemoveChange(record);
    if (record.selectorType === 'xpath') {
      const el = SelectorEngine.find({ type: 'xpath', value: record.selector });
      if (el) el.style.removeProperty(record.property);
      return !!el;
    }
    removeRuleFromSheet(record.selector, record.property);
    return true;
  }

  function applyInlineStyle(record) {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (!el) return false;
    if (record.disabled || record.value === '' || record.value == null) {
      el.style.removeProperty(record.property);
    } else {
      el.style.setProperty(record.property, record.value, 'important');
    }
    return true;
  }

  // ─── Init / reapply ────────────────────────────────────────────────────────

  async function init() {
    await PersistDB.open();
    _currentUrl = location.href;
    await reapply();

    const onNav = () => {
      const newUrl = location.href;
      if (PersistDB.normalizeUrl(newUrl) === PersistDB.normalizeUrl(_currentUrl)) return;
      _currentUrl = newUrl;
      _liveEls.clear();
      _undoStack = [];
      _redoStack = [];
      broadcastUndoState();
      // Wait for SPA frameworks to finish their re-render.
      setTimeout(reapply, 50);
      setTimeout(reapply, 300);
    };
    const _push = history.pushState;
    history.pushState = function () {
      const r = _push.apply(this, arguments);
      onNav();
      return r;
    };
    const _replace = history.replaceState;
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      onNav();
      return r;
    };
    window.addEventListener('popstate', onNav);

    // Re-apply after SPA DOM churn settles — but ignore our own mutations.
    const mo = new MutationObserver(
      debounce(() => {
        if (Date.now() < _suppressUntil) return;
        reapply({ silent: true });
      }, 500)
    );
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Flush pending debounced CSS writes if the page is being left.
    window.addEventListener('pagehide', flushPendingSaves);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingSaves();
    });
  }

  function flushPendingSaves() {
    for (const [id, timer] of _saveTimers.entries()) {
      clearTimeout(timer);
      const record = _cache.get(id);
      if (record) {
        // Fire-and-forget: IDB writes started before unload usually complete.
        PersistDB.putChange(record).catch(() => {});
      }
    }
    _saveTimers.clear();
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /**
   * Deterministic apply order: CSS rules first (order-independent), then
   * structural edits oldest-first so nested HTML edits replay the way they
   * were made, then removals last.
   */
  function orderRecords(records) {
    const css = [];
    const html = [];
    const removes = [];
    for (const r of records) {
      if (r.property === '__html__') html.push(r);
      else if (r.property === '__remove__') removes.push(r);
      else css.push(r);
    }
    html.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    removes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    return [...css, ...html, ...removes];
  }

  async function reapply({ silent } = {}) {
    try {
      const records = await PersistDB.getChangesForUrl(_currentUrl);
      _cache.clear();
      const sheet = getStylesheet();
      while (sheet.cssRules.length) sheet.deleteRule(0);

      for (const r of orderRecords(records)) {
        _cache.set(r.id, r);
        applyRecord(r);
      }
      if (!silent) {
        notifyPanel('CHANGES_LOADED', { url: _currentUrl, changes: records });
      }
    } catch (err) {
      console.error('[DesInspect] reapply failed:', err);
    }
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  /**
   * Save and apply. CSS edits debounce their IDB write (they fire per
   * keystroke); structural edits (__html__/__remove__) are awaited so the
   * caller only resolves once the change is durable.
   *
   * opts.recordHistory=false lets undo/redo replay without re-recording.
   */
  async function saveChange(input, opts = {}) {
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const id = input.id || `${urlPattern}::${input.selector}::${input.property}`;
    const before = _cache.get(id) || null;
    const record = {
      ...input,
      id,
      urlPattern,
      timestamp: Date.now(),
    };
    _cache.set(id, record);
    applyRecord(record);

    if (opts.recordHistory !== false) {
      pushHistory(historyLabel(record), [
        { id, before: before ? { ...before } : null, after: { ...record } },
      ]);
    }

    const flushImmediately =
      input.property === '__html__' || input.property === '__remove__';
    if (flushImmediately) {
      if (_saveTimers.has(id)) {
        clearTimeout(_saveTimers.get(id));
        _saveTimers.delete(id);
      }
      await PersistDB.putChange(record);
      notifyPanel('CHANGE_SAVED', { id });
      return record;
    }

    if (_saveTimers.has(id)) clearTimeout(_saveTimers.get(id));
    _saveTimers.set(
      id,
      setTimeout(async () => {
        try {
          await PersistDB.putChange(record);
          _saveTimers.delete(id);
          notifyPanel('CHANGE_SAVED', { id });
        } catch (err) {
          console.error('[DesInspect] save failed:', err);
        }
      }, DEBOUNCE_MS)
    );
    return record;
  }

  function historyLabel(record) {
    if (record.property === '__html__') return 'Edit HTML';
    if (record.property === '__remove__') return 'Delete element';
    return `${record.property}: ${record.disabled ? '(off)' : record.value}`;
  }

  async function deleteChange(id, opts = {}) {
    // Cancel any in-flight debounced save so it can't resurrect the record.
    if (_saveTimers.has(id)) {
      clearTimeout(_saveTimers.get(id));
      _saveTimers.delete(id);
    }
    const record = _cache.get(id) || (await PersistDB.getChange(id));
    if (!record) return;
    _cache.delete(id);
    unapplyRecord(record);
    await PersistDB.deleteChange(id);

    if (opts.recordHistory !== false) {
      pushHistory(`Revert ${record.property}`, [{ id, before: { ...record }, after: null }]);
    }
    notifyPanel('CHANGE_DELETED', { id });
  }

  /**
   * Delete by (selector, property) — used by the panel when it doesn't have
   * a record id (e.g. cancelling a live-preview edit that created one).
   */
  async function deleteChangeByProp(selector, property, opts = {}) {
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const id = `${urlPattern}::${selector}::${property}`;
    return deleteChange(id, opts);
  }

  async function clearAll() {
    for (const t of _saveTimers.values()) clearTimeout(t);
    _saveTimers.clear();
    const records = Array.from(_cache.values());
    const ops = records.map((r) => ({ id: r.id, before: { ...r }, after: null }));

    // Unapply structural edits (restore original DOM), then wipe the sheet.
    for (const r of orderRecords(records).reverse()) {
      if (r.property === '__html__' || r.property === '__remove__') {
        unapplyRecord(r);
      }
    }
    const sheet = getStylesheet();
    while (sheet.cssRules.length) sheet.deleteRule(0);

    await PersistDB.clearChangesForUrl(_currentUrl);
    _cache.clear();
    pushHistory('Revert all', ops);
    notifyPanel('ALL_CLEARED', { count: records.length });
  }

  async function restoreSnapshot(snapshotChanges) {
    const current = Array.from(_cache.values());
    const ops = [];
    for (const r of current) ops.push({ id: r.id, before: { ...r }, after: null });

    // Roll back current structural edits first.
    for (const r of orderRecords(current).reverse()) {
      if (r.property === '__html__' || r.property === '__remove__') unapplyRecord(r);
    }
    const sheet = getStylesheet();
    while (sheet.cssRules.length) sheet.deleteRule(0);
    await PersistDB.clearChangesForUrl(_currentUrl);
    _cache.clear();

    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    for (const c of snapshotChanges) {
      const record = { ...c, urlPattern, timestamp: c.timestamp || Date.now() };
      const existing = ops.find((o) => o.id === record.id);
      if (existing) existing.after = { ...record };
      else ops.push({ id: record.id, before: null, after: { ...record } });
      await PersistDB.putChange(record);
      _cache.set(record.id, record);
    }
    for (const r of orderRecords(Array.from(_cache.values()))) {
      applyRecord(r);
    }
    pushHistory('Restore snapshot', ops);
    notifyPanel('CHANGES_LOADED', { url: _currentUrl, changes: Array.from(_cache.values()) });
  }

  function getCurrentChanges() {
    return Array.from(_cache.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  function notifyPanel(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {});
  }

  return {
    init,
    saveChange,
    deleteChange,
    deleteChangeByProp,
    clearAll,
    restoreSnapshot,
    reapply,
    getCurrentChanges,
    undo,
    redo,
    getUndoState,
    markOurMutation,
  };
})();

if (typeof window !== 'undefined') window.Persistence = Persistence;

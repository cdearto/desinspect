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
  let _saveTimers = new Map(); // id → { t: timeoutId, record } — record kept so flush works even if _cache was rebuilt
  let _cache = new Map(); // id → record (in-memory mirror of IDB for this URL)

  // Which __remove__ records have already been applied this page generation.
  // Without this, positional selectors (li:nth-of-type(2)) would match a NEW
  // sibling after each apply and every reapply would delete one more element.
  const _appliedRemoves = new Set();

  // Live-node registry for HTML-edited records. After an outerHTML replace
  // the stored selector may no longer resolve (e.g. span → button), so we
  // remember which live nodes each __html__ record currently owns. A record
  // can own multiple roots (the user replaced one element with several).
  const _liveEls = new Map(); // record id → Node[] (element roots + text nodes)

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

  function isNoopOp(op) {
    if (!op.before && !op.after) return true;
    if (op.before && op.after) {
      try {
        return JSON.stringify(op.before) === JSON.stringify(op.after);
      } catch {
        return false;
      }
    }
    return false;
  }

  function pushHistory(label, ops) {
    ops = ops.filter((op) => !isNoopOp(op));
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
      // Coalescing can neutralize an entry (create → delete within the
      // window nets to before:null after:null) — drop it so ⌘Z doesn't
      // "undo" nothing.
      if (isNoopOp(top.ops[0])) _undoStack.pop();
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
    // Cancel any pending debounced save for this id — otherwise its timer
    // fires after the rollback and resurrects the undone value in IDB.
    const pending = _saveTimers.get(op.id);
    if (pending) {
      clearTimeout(pending.t);
      _saveTimers.delete(op.id);
    }
    const target = useBefore ? op.before : op.after;
    const other = useBefore ? op.after : op.before;
    if (target) {
      _cache.set(op.id, target);
      await PersistDB.putChange({ ...target });
      applyRecord(target);
    } else if (other) {
      // Record is being removed in this direction → unapply from DOM first;
      // a failed structural unapply means the record still holds the only
      // copy of the original markup — keep it rather than orphaning the DOM.
      const ok = unapplyRecord(other);
      if (!ok && (other.property === '__html__' || other.property === '__remove__')) {
        notifyPanel('REVERT_FAILED', {
          id: op.id,
          reason: 'Element could not be restored (page may have re-rendered). The change record was kept.',
        });
        return;
      }
      _cache.delete(op.id);
      await PersistDB.deleteChange(op.id);
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

  // (selector::property) → CSSRule ref. Shorthands (margin, background…)
  // expand to longhands in CSSOM, so "the rule for this property" cannot be
  // recovered from r.style — track inserted rules explicitly instead.
  const _sheetRules = new Map();

  function sheetRuleKey(selector, property) {
    return `${selector}::${property}`;
  }

  function deleteTrackedRule(selector, property) {
    const sheet = getStylesheet();
    const key = sheetRuleKey(selector, property);
    const tracked = _sheetRules.get(key);
    if (tracked) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        if (sheet.cssRules[i] === tracked) {
          sheet.deleteRule(i);
          break;
        }
      }
      _sheetRules.delete(key);
    }
  }

  function applyRuleToSheet(record) {
    const sheet = getStylesheet();
    const ruleSelector = record.selector;
    // Disabled records override with `revert` so the property actually turns
    // off; otherwise the author rule keeps applying under our checkbox.
    const value = record.disabled ? 'revert' : record.value;
    const cssText = `${ruleSelector} { ${record.property}: ${value} !important; }`;

    deleteTrackedRule(ruleSelector, record.property);
    try {
      const idx = sheet.insertRule(cssText, sheet.cssRules.length);
      _sheetRules.set(sheetRuleKey(ruleSelector, record.property), sheet.cssRules[idx]);
    } catch (err) {
      console.warn('[DesInspect] insertRule failed:', cssText, err);
    }
  }

  function removeRuleFromSheet(selector, property) {
    deleteTrackedRule(selector, property);
  }

  function wipeSheet() {
    const sheet = getStylesheet();
    while (sheet.cssRules.length) sheet.deleteRule(0);
    _sheetRules.clear();
  }

  // ─── Record application ────────────────────────────────────────────────────

  function liveNodes(record) {
    const nodes = _liveEls.get(record.id);
    if (nodes && nodes.length && nodes.every((n) => n.isConnected)) return nodes;
    return null;
  }

  function findLive(record) {
    const nodes = liveNodes(record);
    if (nodes) {
      const firstEl = nodes.find((n) => n.nodeType === 1);
      if (firstEl) return firstEl;
    }
    return SelectorEngine.find({ type: record.selectorType, value: record.selector });
  }

  function parseTemplate(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    return tmpl.content;
  }

  /**
   * Canonicalize markup: parse and re-serialize so it compares reliably
   * against live DOM serializations (attribute quoting, entity encoding,
   * boolean attributes, tag case all normalize).
   */
  function normalizeHtml(html) {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    const div = document.createElement('div');
    div.appendChild(tmpl.content.cloneNode(true));
    return div.innerHTML;
  }

  function serializeNodes(nodes) {
    const div = document.createElement('div');
    for (const n of nodes) div.appendChild(n.cloneNode(true));
    return div.innerHTML;
  }

  /**
   * Swap `el` (plus optional extra tracked roots) for the parsed markup.
   * Handles multi-root markup (all nodes inserted and tracked) and
   * html/body/head targets, which cannot be replaceWith()'d — for those,
   * copy attributes + children from a DOMParser parse (template parsers
   * silently drop html/body/head tags).
   */
  function swapElementWithMarkup(el, html, recordId, extraRoots = []) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'head') {
      const looksWrapped = new RegExp(`<${tag}[\\s>]`, 'i').test(html);
      const doc = new DOMParser().parseFromString(
        looksWrapped ? html : `<${tag}>${html}</${tag}>`,
        'text/html'
      );
      const parsedSame = doc.querySelector(tag);
      if (!parsedSame) return el; // parse failed — leave the DOM alone
      while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
      for (const a of Array.from(parsedSame.attributes)) el.setAttribute(a.name, a.value);
      el.innerHTML = '';
      el.append(...Array.from(parsedSame.childNodes));
      if (recordId) _liveEls.set(recordId, [el]);
      return el;
    }
    const frag = parseTemplate(html);
    const first = frag.firstElementChild;
    // Remove any additional roots a previous multi-root apply inserted.
    for (const extra of extraRoots) {
      if (extra !== el && extra.isConnected) extra.remove();
    }
    if (!first) {
      // Text-only replacement — keep the element, swap contents.
      el.innerHTML = html;
      if (recordId) _liveEls.set(recordId, [el]);
      return el;
    }
    const nodes = Array.from(frag.childNodes);
    el.replaceWith(...nodes);
    if (recordId) _liveEls.set(recordId, nodes);
    return first;
  }

  function applyHtmlChange(record) {
    const tracked = liveNodes(record);
    // Idempotence: silent reapplies (MutationObserver settles) must not
    // re-replace an already-applied subtree — that would reset focus and
    // listeners on every unrelated SPA re-render. Compare canonical
    // serializations of ALL tracked roots (record.value is normalized at
    // save time, so byte-equality is meaningful).
    if (tracked && serializeNodes(tracked) === record.value) return true;
    const el = findLive(record);
    if (!el) return false;
    if (!tracked && el.outerHTML === record.value) {
      _liveEls.set(record.id, [el]);
      return true;
    }
    markOurMutation();
    swapElementWithMarkup(el, record.value, record.id, tracked || []);
    return true;
  }

  function unapplyHtmlChange(record) {
    if (record.originalValue == null) return false;
    const tracked = liveNodes(record);
    const el = findLive(record);
    if (!el) return false;
    markOurMutation();
    // Multi-root edits: every tracked root must go, not just the first.
    swapElementWithMarkup(el, record.originalValue, null, tracked || []);
    _liveEls.delete(record.id);
    return true;
  }

  function applyRemoveChange(record) {
    // One removal per record per page generation — positional selectors
    // (li:nth-of-type(2)) match a NEW sibling after the first removal, and
    // repeated silent reapplies would otherwise eat the whole list.
    if (_appliedRemoves.has(record.id)) return true;
    const el = findLive(record);
    if (!el) return false;
    // Identity check: don't remove something that clearly isn't the element
    // this record described.
    if (record.elementTag && el.tagName.toLowerCase() !== record.elementTag) return false;
    markOurMutation();
    el.remove();
    _appliedRemoves.add(record.id);
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
    const restored = parseTemplate(record.originalValue).firstElementChild;
    if (!restored) return false;
    const children = Array.from(parent.children);
    const idx = typeof record.childIndex === 'number' ? record.childIndex : children.length;
    if (idx >= 0 && idx < children.length) {
      parent.insertBefore(restored, children[idx]);
    } else {
      parent.appendChild(restored);
    }
    _appliedRemoves.delete(record.id);
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
      if (el) {
        if (record.inlinePrior) {
          el.style.setProperty(record.property, record.inlinePrior);
        } else {
          el.style.removeProperty(record.property);
        }
      }
      return !!el;
    }
    removeRuleFromSheet(record.selector, record.property);
    return true;
  }

  function applyInlineStyle(record) {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (!el) return false;
    // Capture the page's own inline declaration once so disable/revert can
    // restore it instead of deleting it. Mutating the record here is fine —
    // it's the same object the debounced save persists.
    if (record.inlinePrior === undefined) {
      record.inlinePrior = el.style.getPropertyValue(record.property) || '';
    }
    if (record.disabled || record.value === '' || record.value == null) {
      if (record.inlinePrior) {
        el.style.setProperty(record.property, record.inlinePrior);
      } else {
        el.style.removeProperty(record.property);
      }
    } else {
      el.style.setProperty(record.property, record.value, 'important');
    }
    return true;
  }

  // ─── Init / reapply ────────────────────────────────────────────────────────

  /**
   * Handle a (possible) URL change. Content scripts run in an isolated
   * world, so patching history.pushState never sees the page's own SPA
   * navigations — detection is: popstate, a URL poll, the MutationObserver
   * callback, and URL_CHANGED pushes from the service worker.
   */
  function handleNavigation() {
    const newUrl = location.href;
    if (PersistDB.normalizeUrl(newUrl) === PersistDB.normalizeUrl(_currentUrl)) {
      _currentUrl = newUrl;
      return false;
    }
    // Real navigation: flush pending writes for the OLD url before switching.
    flushPendingSaves();
    _currentUrl = newUrl;
    _liveEls.clear();
    _appliedRemoves.clear();
    _undoStack = [];
    _redoStack = [];
    broadcastUndoState();
    // Wait for SPA frameworks to finish their re-render.
    setTimeout(() => reapply(), 50);
    setTimeout(() => reapply(), 300);
    return true;
  }

  async function init() {
    await PersistDB.open();
    _currentUrl = location.href;
    await reapply();

    window.addEventListener('popstate', handleNavigation);
    // URL poll: cheap, catches pushState/replaceState from the page world.
    setInterval(handleNavigation, 500);

    // Re-apply after SPA DOM churn settles — but ignore our own mutations.
    // A suppressed tick re-arms itself for just after the window expires
    // (otherwise a framework re-render inside the window is never replayed),
    // and maxWait bounds starvation on continuously-mutating pages.
    const scheduleReapply = debounce(
      () => {
        if (handleNavigation()) return; // nav path already schedules reapply
        if (Date.now() < _suppressUntil) {
          setTimeout(() => scheduleReapply(), _suppressUntil - Date.now() + 50);
          return;
        }
        reapply({ silent: true });
      },
      500,
      2000
    );
    const mo = new MutationObserver(scheduleReapply);
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // Flush pending debounced CSS writes if the page is being left.
    window.addEventListener('pagehide', flushPendingSaves);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPendingSaves();
    });
  }

  /**
   * Write all pending records NOW. Uses a synchronous transaction on the
   * cached DB handle so the write starts inside the pagehide handler (an
   * awaited open() would only run after the handler returns, when the
   * page may already be tearing down).
   */
  function flushPendingSaves() {
    if (!_saveTimers.size) return;
    const records = [];
    for (const [, entry] of _saveTimers.entries()) {
      clearTimeout(entry.t);
      if (entry.record) records.push(entry.record);
    }
    _saveTimers.clear();
    const db = PersistDB.dbSync?.();
    if (db) {
      try {
        const tx = db.transaction('changes', 'readwrite');
        const store = tx.objectStore('changes');
        for (const r of records) store.put(r);
        return;
      } catch {
        /* fall through to async path */
      }
    }
    for (const r of records) PersistDB.putChange(r).catch(() => {});
  }

  /** Awaited flush for snapshot creation and other must-be-durable moments. */
  async function flushNow() {
    const records = [];
    for (const [, entry] of _saveTimers.entries()) {
      clearTimeout(entry.t);
      if (entry.record) records.push(entry.record);
    }
    _saveTimers.clear();
    await Promise.all(records.map((r) => PersistDB.putChange(r).catch(() => {})));
  }

  function debounce(fn, ms, maxWait) {
    let t = null;
    let firstCall = 0;
    return (...args) => {
      const now = Date.now();
      if (!firstCall) firstCall = now;
      clearTimeout(t);
      const elapsed = now - firstCall;
      const wait = maxWait && elapsed >= maxWait ? 0 : ms;
      t = setTimeout(() => {
        firstCall = 0;
        fn(...args);
      }, wait);
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
      // Edits saved during the await above exist only in _cache + pending
      // timers (their IDB write is still debounced) — a blind clear would
      // evict them and the flush path would lose them entirely. Overlay
      // pending records on top of the fetched snapshot.
      const pending = new Map();
      for (const [id, entry] of _saveTimers.entries()) {
        if (entry.record) pending.set(id, entry.record);
      }
      _cache.clear();
      wipeSheet();

      const byId = new Map(records.map((r) => [r.id, r]));
      for (const [id, r] of pending.entries()) byId.set(id, r);

      for (const r of orderRecords(Array.from(byId.values()))) {
        _cache.set(r.id, r);
        applyRecord(r);
      }
      if (!silent) {
        notifyPanel('CHANGES_LOADED', { url: _currentUrl, changes: Array.from(byId.values()) });
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
    // Canonicalize HTML values so the idempotence check (serialization vs
    // serialization) holds — raw textarea text with unquoted attributes or
    // bare '&' would never byte-match the DOM and cause endless re-swaps.
    const value =
      input.property === '__html__' ? normalizeHtml(input.value) : input.value;
    const record = {
      ...input,
      value,
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
    const prior = _saveTimers.get(id);
    if (prior) {
      clearTimeout(prior.t);
      _saveTimers.delete(id);
    }
    if (flushImmediately) {
      await PersistDB.putChange(record);
      notifyPanel('CHANGE_SAVED', { id });
      return record;
    }

    const t = setTimeout(async () => {
      try {
        await PersistDB.putChange(record);
        _saveTimers.delete(id);
        notifyPanel('CHANGE_SAVED', { id });
      } catch (err) {
        console.error('[DesInspect] save failed:', err);
      }
    }, DEBOUNCE_MS);
    _saveTimers.set(id, { t, record });
    return record;
  }

  function historyLabel(record) {
    if (record.property === '__html__') return 'Edit HTML';
    if (record.property === '__remove__') return 'Delete element';
    return `${record.property}: ${record.disabled ? '(off)' : record.value}`;
  }

  async function deleteChange(id, opts = {}) {
    // Cancel any in-flight debounced save so it can't resurrect the record.
    const pending = _saveTimers.get(id);
    if (pending) {
      clearTimeout(pending.t);
      _saveTimers.delete(id);
    }
    const record = _cache.get(id) || (await PersistDB.getChange(id));
    if (!record) return { ok: true };

    const unapplied = unapplyRecord(record);
    // A structural record whose unapply failed holds the ONLY copy of the
    // original markup/position — deleting it would strand the DOM in the
    // edited state with no way back. Keep the record and tell the panel.
    if (!unapplied && (record.property === '__html__' || record.property === '__remove__')) {
      notifyPanel('REVERT_FAILED', {
        id,
        reason: 'Element could not be restored (page may have re-rendered). The change record was kept.',
      });
      return { ok: false, error: 'unapply failed; record kept' };
    }

    _cache.delete(id);
    await PersistDB.deleteChange(id);

    if (opts.recordHistory !== false) {
      pushHistory(`Revert ${record.property}`, [{ id, before: { ...record }, after: null }]);
    }
    notifyPanel('CHANGE_DELETED', { id });
    return { ok: true };
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

  function cancelAllTimers() {
    for (const entry of _saveTimers.values()) clearTimeout(entry.t);
    _saveTimers.clear();
  }

  /**
   * Roll back every applied record in reverse-apply order: removals get
   * re-inserted, HTML edits restored newest-first, and non-sheet CSS
   * (xpath → inline styles) removed. The override sheet is wiped wholesale.
   */
  function unapplyAllRecords(records) {
    for (const r of orderRecords(records).reverse()) {
      if (
        r.property === '__html__' ||
        r.property === '__remove__' ||
        r.selectorType === 'xpath'
      ) {
        unapplyRecord(r);
      }
    }
    wipeSheet();
  }

  async function clearAll() {
    cancelAllTimers();
    // Ops in apply order so undo (which replays them reversed) restores
    // removals first, then HTML newest-first, then CSS.
    const records = orderRecords(Array.from(_cache.values()));
    const ops = records.map((r) => ({ id: r.id, before: { ...r }, after: null }));

    unapplyAllRecords(records);

    await PersistDB.clearChangesForUrl(_currentUrl);
    _cache.clear();
    pushHistory('Revert all', ops);
    notifyPanel('ALL_CLEARED', { count: records.length });
  }

  async function restoreSnapshot(snapshotChanges) {
    cancelAllTimers();
    const current = orderRecords(Array.from(_cache.values()));
    const ops = [];
    for (const r of current) ops.push({ id: r.id, before: { ...r }, after: null });

    unapplyAllRecords(current);
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

  function getLiveElement(id) {
    const nodes = _liveEls.get(id);
    if (!nodes || !nodes.length) return null;
    const firstEl = nodes.find((n) => n.nodeType === 1);
    return firstEl && firstEl.isConnected ? firstEl : null;
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
    handleNavigation,
    flushNow,
    getLiveElement,
  };
})();

if (typeof window !== 'undefined') window.Persistence = Persistence;

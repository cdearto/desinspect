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

type HistoryOp = { id: string; before: ChangeRecord | null; after: ChangeRecord | null };
type HistoryEntry = { label: string; ops: HistoryOp[]; at: number };

/** Push a message to the side panel (dropped silently if it isn't open). */
function notifyPanel<T extends ContentPush['type']>(
  type: T,
  data: Extract<ContentPush, { type: T }>['data']
): void {
  chrome.runtime.sendMessage({ type, data }).catch(() => {});
}

const Persistence = (() => {
  const DEBOUNCE_MS = 300;
  const STYLESHEET_ID = 'desinspect-overrides';
  let _currentUrl = location.href;
  // Debounced CSS writes. The record rides along so a flush never depends on _cache.
  const _saveTimers = new Map<string, { t: number; record: ChangeRecord }>();
  // In-memory mirror of IndexedDB for the current URL.
  const _cache = new Map<string, ChangeRecord>();

  // Records applied at most once per page generation: removals (positional
  // selectors like li:nth-of-type(2) would match a NEW sibling after each
  // apply) and HTML edits of <html>/<head>/<body> (the page keeps changing
  // those, and re-swapping them would wipe its listeners on every re-apply).
  const _appliedOnce = new Set<string>();

  // Elements we changed, so a revert or navigation can undo exactly what we
  // did: the element an inline (xpath) style went on, or the parent a
  // removed element was taken from.
  const _touched = new Map<string, Element>();

  // Bumped on every change to the record set; reapply() restarts when it sees
  // the set change while it was reading IndexedDB.
  let _epoch = 0;

  // Live-node registry for HTML-edited records. After an outerHTML replace
  // the stored selector may no longer resolve (e.g. span → button), so we
  // remember which live nodes each __html__ record currently owns. A record
  // can own multiple roots (the user replaced one element with several).
  const _liveEls = new Map<string, ChildNode[]>(); // record id → root nodes (elements + text)

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
  let _undoStack: HistoryEntry[] = [];
  let _redoStack: HistoryEntry[] = [];

  function isNoopOp(op: HistoryOp): boolean {
    if (!op.before && !op.after) return true;
    return !!op.before && !!op.after && JSON.stringify(op.before) === JSON.stringify(op.after);
  }

  function pushHistory(label: string, ops: HistoryOp[]): void {
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

  function getUndoState(): UndoState {
    return { canUndo: _undoStack.length > 0, canRedo: _redoStack.length > 0 };
  }

  function broadcastUndoState(): void {
    notifyPanel('UNDO_STATE', getUndoState());
  }

  /** Cancel a pending debounced save so its timer can't resurrect a record. */
  function cancelTimer(id: string): void {
    const pending = _saveTimers.get(id);
    if (pending) {
      clearTimeout(pending.t);
      _saveTimers.delete(id);
    }
  }

  /** HTML replacements and removals change the DOM; everything else is CSS. */
  const isStructural = (record: ChangeRecord): boolean =>
    record.property === '__html__' || record.property === '__remove__';

  const REVERT_FAILED_REASON =
    'Element could not be restored (page may have re-rendered). The change record was kept.';

  /** Move one record to its `before` (undo) or `after` (redo) state. */
  async function applyOpDirection(op: HistoryOp, useBefore: boolean): Promise<void> {
    _epoch++;
    cancelTimer(op.id);
    const target = useBefore ? op.before : op.after;
    const other = useBefore ? op.after : op.before;
    if (target) {
      _cache.set(op.id, target);
      await PersistDB.putChange(target);
      applyRecord(target);
    } else if (other) {
      // Record is being removed in this direction → unapply from DOM first;
      // a failed structural unapply means the record still holds the only
      // copy of the original markup — keep it rather than orphaning the DOM.
      const ok = unapplyRecord(other);
      if (!ok && isStructural(other)) {
        notifyPanel('REVERT_FAILED', { id: op.id, reason: REVERT_FAILED_REASON });
        return;
      }
      _cache.delete(op.id);
      await PersistDB.deleteChange(op.id);
    }
  }

  async function undo(): Promise<{ done: boolean }> {
    const entry = _undoStack.pop();
    if (!entry) return { done: false };
    for (const op of [...entry.ops].reverse()) {
      await applyOpDirection(op, true);
    }
    _redoStack.push(entry);
    broadcastUndoState();
    notifyPanel('HISTORY_APPLIED', { direction: 'undo', label: entry.label });
    return { done: true };
  }

  async function redo(): Promise<{ done: boolean }> {
    const entry = _redoStack.pop();
    if (!entry) return { done: false };
    for (const op of entry.ops) {
      await applyOpDirection(op, false);
    }
    _undoStack.push(entry);
    broadcastUndoState();
    notifyPanel('HISTORY_APPLIED', { direction: 'redo', label: entry.label });
    return { done: true };
  }

  // ─── Override stylesheet ───────────────────────────────────────────────────

  function getStylesheet(): CSSStyleSheet {
    let el = document.getElementById(STYLESHEET_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLESHEET_ID;
      el.setAttribute('data-desinspect', 'true');
      // Last in document order so we win specificity ties.
      document.documentElement.appendChild(el);
    }
    return el.sheet!;
  }

  // (selector::property) → CSSRule ref. Shorthands (margin, background…)
  // expand to longhands in CSSOM, so "the rule for this property" cannot be
  // recovered from r.style — track inserted rules explicitly instead.
  const _sheetRules = new Map<string, CSSRule>();

  const sheetRuleKey = (selector: string, property: string) => `${selector}::${property}`;

  function removeRuleFromSheet(selector: string, property: string): void {
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

  function applyRuleToSheet(record: ChangeRecord): void {
    const sheet = getStylesheet();
    const ruleSelector = record.selector;
    removeRuleFromSheet(ruleSelector, record.property);
    // A disabled property the page never declared just stops applying. One
    // the page does declare needs `revert` to actually turn off — which rolls
    // the property back to browser defaults (CSS can't remove a single
    // declaration from someone else's stylesheet).
    if (record.disabled && record.added) return;
    const value = record.disabled ? 'revert' : record.value;
    const cssText = `${ruleSelector} { ${record.property}: ${value} !important; }`;
    try {
      const idx = sheet.insertRule(cssText, sheet.cssRules.length);
      _sheetRules.set(sheetRuleKey(ruleSelector, record.property), sheet.cssRules[idx]);
    } catch (err) {
      console.warn('[DesInspect] insertRule failed:', cssText, err);
    }
  }

  function wipeSheet(): void {
    const sheet = getStylesheet();
    while (sheet.cssRules.length) sheet.deleteRule(0);
    _sheetRules.clear();
  }

  // ─── Record application ────────────────────────────────────────────────────

  /** The nodes an __html__ record currently owns, if they're all still in the page. */
  function liveNodes(id: string): ChildNode[] | null {
    const nodes = _liveEls.get(id);
    if (nodes && nodes.length && nodes.every((n) => n.isConnected)) return nodes;
    return null;
  }

  /** First live element root a record owns, or null. */
  function getLiveElement(id: string): Element | null {
    return liveNodes(id)?.find((n) => n instanceof Element) ?? null;
  }

  function findLive(record: ChangeRecord): Element | null {
    return (
      getLiveElement(record.id) ||
      SelectorEngine.find({ type: record.selectorType, value: record.selector })
    );
  }

  function parseTemplate(html: string): DocumentFragment {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html;
    return tmpl.content;
  }

  const ROOT_TAGS = new Set(['html', 'head', 'body']);

  /**
   * Parse markup for <html>/<head>/<body> into that element. A <template>
   * silently drops these tags, so use a full-document parse. Markup without
   * the wrapper tag is taken as the element's contents.
   */
  function parseRootElement(tag: string, html: string): Element | null {
    const wrapped = new RegExp(`^\\s*<${tag}[\\s>]`, 'i').test(html);
    const doc = new DOMParser().parseFromString(wrapped ? html : `<${tag}>${html}</${tag}>`, 'text/html');
    return doc.querySelector(tag);
  }

  /**
   * Canonicalize markup: parse and re-serialize so it compares reliably
   * against live DOM serializations (attribute quoting, entity encoding,
   * boolean attributes, tag case all normalize). `tag` is the edited
   * element's tag, which decides how <html>/<head>/<body> edits are parsed.
   */
  function normalizeHtml(html: string, tag?: string | null): string {
    if (tag && ROOT_TAGS.has(tag)) return parseRootElement(tag, html)?.outerHTML ?? html;
    return serializeNodes(parseTemplate(html).childNodes);
  }

  function serializeNodes(nodes: Iterable<Node>): string {
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
  function swapElementWithMarkup(
    el: Element,
    html: string,
    recordId: string | null,
    extraRoots: ChildNode[] = []
  ): void {
    const tag = el.tagName.toLowerCase();
    if (ROOT_TAGS.has(tag)) {
      const parsedSame = parseRootElement(tag, html);
      if (!parsedSame) return; // parse failed — leave the DOM alone
      while (el.attributes.length) el.removeAttribute(el.attributes[0].name);
      for (const a of Array.from(parsedSame.attributes)) el.setAttribute(a.name, a.value);
      el.innerHTML = '';
      el.append(...Array.from(parsedSame.childNodes));
      if (recordId) _liveEls.set(recordId, [el]);
      return;
    }
    const frag = parseTemplate(html);
    // Remove any additional roots a previous multi-root apply inserted.
    for (const extra of extraRoots) {
      if (extra !== el && extra.isConnected) extra.remove();
    }
    if (!frag.firstElementChild) {
      // Text-only replacement — keep the element, swap contents.
      el.innerHTML = html;
      if (recordId) _liveEls.set(recordId, [el]);
      return;
    }
    const nodes = Array.from(frag.childNodes);
    el.replaceWith(...nodes);
    if (recordId) _liveEls.set(recordId, nodes);
  }

  function applyHtmlChange(record: ChangeRecord): boolean {
    const tracked = liveNodes(record.id);
    if (tracked && _appliedOnce.has(record.id)) return true;
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
    if (ROOT_TAGS.has(el.tagName.toLowerCase())) _appliedOnce.add(record.id);
    return true;
  }

  function unapplyHtmlChange(record: ChangeRecord): boolean {
    if (record.originalValue == null) return false;
    const tracked = liveNodes(record.id);
    const el = findLive(record);
    if (!el) return false;
    markOurMutation();
    // Multi-root edits: every tracked root must go, not just the first.
    swapElementWithMarkup(el, record.originalValue, null, tracked || []);
    _liveEls.delete(record.id);
    _appliedOnce.delete(record.id);
    return true;
  }

  function applyRemoveChange(record: ChangeRecord): boolean {
    // One removal per record per page generation — positional selectors
    // (li:nth-of-type(2)) match a NEW sibling after the first removal, and
    // repeated silent reapplies would otherwise eat the whole list.
    if (_appliedOnce.has(record.id)) return true;
    const el = findLive(record);
    if (!el?.parentElement) return false;
    // Identity check: don't remove something that clearly isn't the element
    // this record described.
    if (record.elementTag && el.tagName.toLowerCase() !== record.elementTag) return false;
    markOurMutation();
    _touched.set(record.id, el.parentElement);
    el.remove();
    _appliedOnce.add(record.id);
    return true;
  }

  /** The element we last applied `record` to, if it's still in the page. */
  function touched(record: ChangeRecord): Element | null {
    const el = _touched.get(record.id);
    return el?.isConnected ? el : null;
  }

  function unapplyRemoveChange(record: ChangeRecord): boolean {
    // Re-insert from stored restore info — into the parent we removed it
    // from if that's still around, else wherever the stored selector points.
    if (!record.originalValue) return false;
    const parent =
      touched(record) ??
      (record.parentSelector
        ? SelectorEngine.find({ type: record.parentSelectorType || 'css', value: record.parentSelector })
        : null);
    if (!parent) return false;
    const restored = parseTemplate(record.originalValue).firstElementChild;
    if (!restored) return false;
    markOurMutation();
    // Falls back to appending when the index is past the end (or missing).
    parent.insertBefore(restored, parent.children[record.childIndex ?? -1] ?? null);
    _appliedOnce.delete(record.id);
    _touched.delete(record.id);
    return true;
  }

  /** Apply a record to the page. False if its target element couldn't be found. */
  function applyRecord(record: ChangeRecord): boolean {
    if (record.property === '__html__') return applyHtmlChange(record);
    if (record.property === '__remove__') return applyRemoveChange(record);
    // CSS rule selectors only work in stylesheets; XPath goes inline.
    if (record.selectorType === 'xpath') return applyInlineStyle(record);
    applyRuleToSheet(record);
    return true;
  }

  /** Undo a record's effect on the page. False if the DOM couldn't be restored. */
  function unapplyRecord(record: ChangeRecord): boolean {
    if (record.property === '__html__') return unapplyHtmlChange(record);
    if (record.property === '__remove__') return unapplyRemoveChange(record);
    if (record.selectorType === 'xpath') {
      const el = touched(record) ?? SelectorEngine.find({ type: 'xpath', value: record.selector });
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
      restoreInlinePrior(el, record);
      _touched.delete(record.id);
      return true;
    }
    removeRuleFromSheet(record.selector, record.property);
    return true;
  }

  function applyInlineStyle(record: ChangeRecord): boolean {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) return false;
    // Capture the page's own inline declaration once so disable/revert can
    // restore it instead of deleting it. saveChange carries it over from the
    // previous record, so this only runs before our first edit of the
    // property. Mutating the record here is fine — it's the same object the
    // debounced save persists.
    if (record.inlinePrior === undefined) {
      record.inlinePrior = el.style.getPropertyValue(record.property) || '';
    }
    _touched.set(record.id, el);
    if (record.disabled || !record.value) {
      restoreInlinePrior(el, record);
    } else {
      el.style.setProperty(record.property, record.value, 'important');
    }
    return true;
  }

  function restoreInlinePrior(el: HTMLElement | SVGElement, record: ChangeRecord): void {
    if (record.inlinePrior) el.style.setProperty(record.property, record.inlinePrior);
    else el.style.removeProperty(record.property);
  }

  // ─── Init / reapply ────────────────────────────────────────────────────────

  /**
   * Handle a (possible) URL change. Content scripts run in an isolated
   * world, so patching history.pushState never sees the page's own SPA
   * navigations — instead we poll location.href (and check it whenever
   * the DOM changes). Returns true when the URL pattern actually changed.
   */
  function handleNavigation(): boolean {
    const newUrl = location.href;
    if (PersistDB.normalizeUrl(newUrl) === PersistDB.normalizeUrl(_currentUrl)) {
      _currentUrl = newUrl;
      return false;
    }
    // Real navigation: flush pending writes for the OLD url, and take its
    // edits back off whatever part of the page survived the route change.
    flushPendingSaves();
    unapplyForNavigation();
    _currentUrl = newUrl;
    _cache.clear();
    _liveEls.clear();
    _appliedOnce.clear();
    _touched.clear();
    _undoStack = [];
    _redoStack = [];
    broadcastUndoState();
    // The MutationObserver re-applies again once the SPA's render settles.
    reapply();
    return true;
  }

  /**
   * Undo the old route's structural and inline edits — but only on nodes we
   * know we changed. A selector lookup could hit a look-alike element the
   * new route rendered, so anything we can't verify is left alone.
   */
  function unapplyForNavigation(): void {
    _epoch++;
    for (const r of orderRecords(Array.from(_cache.values())).reverse()) {
      const verified =
        r.property === '__html__' ? !!liveNodes(r.id)
        : r.property === '__remove__' || r.selectorType === 'xpath' ? !!touched(r)
        : false; // stylesheet rules are wiped wholesale by reapply()
      if (verified) unapplyRecord(r);
    }
  }

  async function init(): Promise<void> {
    await PersistDB.open();
    _currentUrl = location.href;
    await reapply();

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

  /** Cancel every pending save timer and return the records they held. */
  function takePendingRecords(): ChangeRecord[] {
    const records: ChangeRecord[] = [];
    for (const entry of _saveTimers.values()) {
      clearTimeout(entry.t);
      records.push(entry.record);
    }
    _saveTimers.clear();
    return records;
  }

  /**
   * Write pending records as the page is being left. PersistDB.putChangesSync
   * starts the transaction synchronously — an awaited write would only begin
   * after the pagehide handler returns, when the page may be tearing down.
   */
  function flushPendingSaves(): void {
    const records = takePendingRecords();
    if (records.length) PersistDB.putChangesSync(records);
  }

  /** Awaited flush, for moments that must be durable (snapshot creation). */
  async function flushNow(): Promise<void> {
    await Promise.all(takePendingRecords().map((r) => PersistDB.putChange(r)));
  }

  /** Trailing debounce that still fires at least every `maxWait` ms under constant calls. */
  function debounce(fn: () => void, ms: number, maxWait: number): () => void {
    let t: number | undefined;
    let firstCall = 0;
    return () => {
      const now = Date.now();
      firstCall ||= now;
      clearTimeout(t);
      t = setTimeout(
        () => {
          firstCall = 0;
          fn();
        },
        now - firstCall >= maxWait ? 0 : ms
      );
    };
  }

  /**
   * Deterministic apply order: CSS rules first (order-independent), then
   * structural edits oldest-first so nested HTML edits replay the way they
   * were made, then removals last.
   */
  function orderRecords(records: ChangeRecord[]): ChangeRecord[] {
    const css: ChangeRecord[] = [];
    const html: ChangeRecord[] = [];
    const removes: ChangeRecord[] = [];
    for (const r of records) {
      if (r.property === '__html__') html.push(r);
      else if (r.property === '__remove__') removes.push(r);
      else css.push(r);
    }
    html.sort((a, b) => a.timestamp - b.timestamp);
    removes.sort((a, b) => a.timestamp - b.timestamp);
    return [...css, ...html, ...removes];
  }

  /** Load this URL's records and (re)apply them. `silent` skips notifying the panel. */
  async function reapply({ silent = false } = {}): Promise<void> {
    try {
      const epoch = _epoch;
      const records = await PersistDB.getChangesForUrl(_currentUrl);
      // A change landed while we were reading: the list may be stale (e.g. a
      // reverted record would come back). Read again.
      if (epoch !== _epoch) return reapply({ silent });
      // Edits saved during the await above exist only in _cache + pending
      // timers (their IDB write is still debounced) — a blind clear would
      // evict them and the flush path would lose them entirely. Overlay
      // pending records on top of the fetched snapshot.
      const byId = new Map(records.map((r) => [r.id, r]));
      for (const [id, entry] of _saveTimers) byId.set(id, entry.record);
      _cache.clear();
      wipeSheet();

      for (const r of orderRecords(Array.from(byId.values()))) {
        _cache.set(r.id, r);
        applyRecord(r);
      }
      if (!silent) {
        notifyPanel('CHANGES_LOADED', { changes: Array.from(byId.values()) });
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
   */
  async function saveChange(input: ChangeInput): Promise<ChangeRecord> {
    _epoch++;
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const id = `${urlPattern}::${input.selector}::${input.property}`;
    const before = _cache.get(id) || null;
    const record: ChangeRecord = {
      ...input,
      value: cleanValue(input),
      id,
      urlPattern,
      timestamp: Date.now(),
    };
    // Re-editing keeps what the page originally had, so Revert goes all the
    // way back rather than to the previous edit.
    if (record.property === '__html__' && before?.originalValue !== undefined) {
      record.originalValue = before.originalValue;
    }
    if (before?.inlinePrior !== undefined) record.inlinePrior = before.inlinePrior;
    _cache.set(id, record);
    applyRecord(record);

    pushHistory(historyLabel(record), [
      { id, before: before ? { ...before } : null, after: { ...record } },
    ]);

    cancelTimer(id);
    if (isStructural(record)) {
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

  function cleanValue(input: ChangeInput): string {
    // Canonicalize HTML so the idempotence check (serialization vs
    // serialization) holds — raw textarea text with unquoted attributes or
    // bare '&' would never byte-match the DOM and cause endless re-swaps.
    if (input.property === '__html__') return normalizeHtml(input.value, input.elementTag);
    if (input.property === '__remove__') return input.value;
    // Every override is applied as !important already; a typed one would
    // double up and make the browser drop the declaration.
    return input.value.replace(/\s*!important\s*$/i, '').trim();
  }

  /**
   * The __html__ record whose inserted nodes include `el`, if any. Editing
   * such a node again updates that record instead of stacking a new one.
   */
  function htmlRecordOwning(el: Element): ChangeRecord | null {
    for (const r of _cache.values()) {
      if (r.property === '__html__' && liveNodes(r.id)?.includes(el)) return r;
    }
    return null;
  }

  /**
   * Replace `el` with `markup`, persisted. When `el` was itself inserted by
   * an earlier HTML edit, that record is updated (its other nodes kept), so a
   * single Revert returns to the page's original markup.
   */
  function saveHtmlEdit(el: Element, markup: string, selector: Selector, elementLabel?: string | null): Promise<ChangeRecord> {
    const owner = htmlRecordOwning(el);
    if (owner) {
      const roots = liveNodes(owner.id)!;
      return saveChange({
        ...owner,
        value: roots.map((n) => (n === el ? markup : serializeNodes([n]))).join(''),
      });
    }
    return saveChange({
      selector: selector.value,
      selectorType: selector.type,
      property: '__html__',
      value: markup,
      originalValue: el.outerHTML,
      elementTag: el.tagName.toLowerCase(),
      elementLabel: elementLabel ?? null,
    });
  }

  function historyLabel(record: ChangeRecord): string {
    if (record.property === '__html__') return 'Edit HTML';
    if (record.property === '__remove__') return 'Delete element';
    return `${record.property}: ${record.disabled ? '(off)' : record.value}`;
  }

  /** Revert one change. Fails (keeping the record) if a structural edit can't be undone on the page. */
  async function deleteChange(id: string): Promise<Ok> {
    _epoch++;
    cancelTimer(id);
    const record = _cache.get(id) || (await PersistDB.getChange(id));
    if (!record) return { ok: true };

    const unapplied = unapplyRecord(record);
    // A structural record whose unapply failed holds the ONLY copy of the
    // original markup/position — deleting it would strand the DOM in the
    // edited state with no way back. Keep the record and tell the panel.
    if (!unapplied && isStructural(record)) {
      notifyPanel('REVERT_FAILED', { id, reason: REVERT_FAILED_REASON });
      return { ok: false, error: 'unapply failed; record kept' };
    }

    _cache.delete(id);
    await PersistDB.deleteChange(id);

    pushHistory(`Revert ${record.property}`, [{ id, before: { ...record }, after: null }]);
    notifyPanel('CHANGE_DELETED', { id });
    return { ok: true };
  }

  /**
   * Delete by (selector, property) — used by the panel when it doesn't have
   * a record id (e.g. cancelling a live-preview edit that created one).
   */
  function deleteChangeByProp(selector: string, property: string): Promise<Ok> {
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    return deleteChange(`${urlPattern}::${selector}::${property}`);
  }

  /**
   * Revert every current record, in reverse-apply order: removals get
   * re-inserted, HTML edits restored newest-first, inline (xpath) styles
   * removed, and the override sheet wiped. Structural records whose page
   * state couldn't be restored are kept (they hold the only copy of the
   * original markup); the rest are deleted. Returns history ops for the
   * deleted ones, in apply order.
   */
  async function revertAllRecords(): Promise<HistoryOp[]> {
    _epoch++;
    takePendingRecords();
    const ops: HistoryOp[] = [];
    let failed = false;
    for (const r of orderRecords(Array.from(_cache.values())).reverse()) {
      const sheetRule = !isStructural(r) && r.selectorType !== 'xpath';
      if (!sheetRule && !unapplyRecord(r) && isStructural(r)) {
        failed = true;
        continue;
      }
      _cache.delete(r.id);
      await PersistDB.deleteChange(r.id);
      ops.unshift({ id: r.id, before: { ...r }, after: null });
    }
    wipeSheet();
    if (failed) notifyPanel('REVERT_FAILED', { id: '', reason: REVERT_FAILED_REASON });
    return ops;
  }

  async function clearAll(): Promise<void> {
    pushHistory('Revert all', await revertAllRecords());
    notifyPanel('ALL_CLEARED', {});
  }

  /** Replace the URL's current changes with a snapshot's. */
  async function restoreSnapshot(snapshotChanges: ChangeRecord[]): Promise<void> {
    const ops = await revertAllRecords();

    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    for (const c of snapshotChanges) {
      const record = { ...c, urlPattern };
      const existing = ops.find((o) => o.id === record.id);
      if (existing) existing.after = { ...record };
      else ops.push({ id: record.id, before: null, after: { ...record } });
      await PersistDB.putChange(record);
      _cache.set(record.id, record);
    }
    for (const r of orderRecords(Array.from(_cache.values()))) applyRecord(r);
    _epoch++; // restarts any reapply() that read IndexedDB mid-restore
    pushHistory('Restore snapshot', ops);
    notifyPanel('CHANGES_LOADED', { changes: Array.from(_cache.values()) });
  }

  function getCurrentChanges(): ChangeRecord[] {
    return Array.from(_cache.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  return {
    init,
    saveChange,
    saveHtmlEdit,
    deleteChange,
    deleteChangeByProp,
    clearAll,
    restoreSnapshot,
    getCurrentChanges,
    undo,
    redo,
    getUndoState,
    markOurMutation,
    flushNow,
    getLiveElement,
  };
})();


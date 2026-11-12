/**
 * DesInspect — Inspector (content script entry).
 *
 * Page side of the inspector: picker mode, DOM-tree serialization,
 * element info, edits (style/HTML/delete/duplicate), forced states,
 * undo/redo, and the message router for the sidepanel.
 */

(() => {
  let _pickerActive = false;
  let _selected: Element | null = null;

  // Forced-state marker classes (see StylesEngine.forceStates) are ours, not
  // the page's — keep them out of everything we show or save.
  const MARKER_PREFIX = 'desinspect-fs-';

  function cleanClasses(el: Element): string[] {
    return Array.from(el.classList).filter((c) => !c.startsWith(MARKER_PREFIX));
  }

  /** el.outerHTML without our injected nodes or forced-state marker classes. */
  function cleanOuterHTML(el: Element): string {
    const ours = `[data-desinspect], [class*="${MARKER_PREFIX}"]`;
    if (!el.matches(ours) && !el.querySelector(ours)) return el.outerHTML;
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[data-desinspect]').forEach((n) => n.remove());
    for (const n of [clone, ...clone.querySelectorAll(`[class*="${MARKER_PREFIX}"]`)]) {
      const classes = cleanClasses(n);
      if (classes.length) n.className = classes.join(' ');
      else n.removeAttribute('class');
    }
    return clone.outerHTML;
  }

  // ─── Picker ────────────────────────────────────────────────────────────────

  function onMouseOver(e: MouseEvent): void {
    if (isPickable(e.target)) Overlay.showHover(e.target);
  }

  function onMouseOut(): void {
    Overlay.showHover(null);
  }

  function onClick(e: MouseEvent): void {
    if (!isPickable(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(e.target);
    stopPicker();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      stopPicker();
      e.preventDefault();
    }
  }

  /** A page element (not part of our own overlay). */
  function isPickable(target: EventTarget | null): target is Element {
    return target instanceof Element && !target.closest('[data-desinspect]');
  }

  function startPicker(): void {
    if (_pickerActive) return;
    _pickerActive = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    notifyPanel('PICKER_STATE', { active: true });
  }

  function stopPicker(): void {
    if (!_pickerActive) return;
    _pickerActive = false;
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    Overlay.showHover(null);
    notifyPanel('PICKER_STATE', { active: false });
  }

  // ─── Selection ─────────────────────────────────────────────────────────────

  function selectElement(el: Element | null): void {
    // Any (re-)selection clears forced pseudo-states — the panel resets its
    // :hov checkboxes on every ELEMENT_SELECTED, so the page must match.
    StylesEngine.forceStates(null, []);
    _selected = el;
    Overlay.showSelected(el);
    notifyPanel('ELEMENT_SELECTED', { selector: el ? SelectorEngine.generate(el) : null });
  }

  function describeElement(el: Element): ElementDescription {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: cleanClasses(el),
      attributes: Array.from(el.attributes)
        .map((a) => ({
          name: a.name,
          value: a.name === 'class' ? cleanClasses(el).join(' ') : a.value,
        }))
        .filter((a) => !(a.name === 'class' && !a.value)),
    };
  }

  // ─── DOM tree serialization ────────────────────────────────────────────────

  /** Child elements, minus the nodes we inject (overlay, style sheets). */
  function visibleChildren(el: Element): Element[] {
    return Array.from(el.children).filter((c) => !c.hasAttribute('data-desinspect'));
  }

  function serializeNode(el: Element): TreeNode {
    const childElements = visibleChildren(el);
    const d = describeElement(el);
    const text = (el.textContent || '').trim();
    return {
      selector: SelectorEngine.generate(el),
      tag: d.tag,
      id: d.id,
      classes: d.classes,
      attrs: d.attributes,
      childCount: childElements.length,
      hasText: childElements.length === 0 && text && text.length < 200 ? text : null,
    };
  }

  function getChildren(selectorObj: Selector | null): TreeNode[] {
    const root = selectorObj ? SelectorEngine.find(selectorObj) : document.documentElement;
    if (!root) return [];
    return visibleChildren(root).map(serializeNode);
  }

  /** Ancestors of the element from <body> down to its parent (the tree's roots are <html>'s children). */
  function getAncestors(selectorObj: Selector): TreeNode[] {
    const out: TreeNode[] = [];
    let cur = SelectorEngine.find(selectorObj)?.parentElement;
    while (cur && cur !== document.documentElement) {
      out.unshift(serializeNode(cur));
      cur = cur.parentElement;
    }
    return out;
  }

  // ─── Element info ──────────────────────────────────────────────────────────

  const MAX_HTML_LENGTH = 50000; // larger subtrees aren't offered for Edit as HTML

  async function elementInfo(selectorObj: Selector): Promise<ElementInfo | null> {
    const el = SelectorEngine.find(selectorObj);
    if (!el) return null;

    // Which persisted CSS-change selectors actually match this element —
    // the panel uses this to avoid rendering unrelated elements' edits as
    // orphan rules under the wrong selection.
    const matchingChangeSelectors: string[] = [];
    for (const c of Persistence.getCurrentChanges()) {
      if (c.property === '__html__' || c.property === '__remove__') continue;
      try {
        const matches =
          c.selectorType === 'xpath'
            ? SelectorEngine.find({ type: 'xpath', value: c.selector }) === el
            : el.matches(c.selector);
        if (matches && !matchingChangeSelectors.includes(c.selector)) {
          matchingChangeSelectors.push(c.selector);
        }
      } catch {
        /* invalid selector — not a match */
      }
    }

    return {
      describe: describeElement(el),
      inline: StylesEngine.inlineRule(el),
      matched: await StylesEngine.matchedRules(el),
      computed: StylesEngine.computedSnapshot(el),
      box: StylesEngine.boxModel(el),
      matchingChangeSelectors,
      outerHTML: el.outerHTML.length < MAX_HTML_LENGTH ? cleanOuterHTML(el) : null,
    };
  }

  // ─── Edits ─────────────────────────────────────────────────────────────────

  function applyStyleEdit({ selector, property, value, disabled, authorDisable, elementLabel }: StyleEditPayload) {
    return Persistence.saveChange({
      selector: selector.value,
      selectorType: selector.type,
      property,
      value,
      disabled: !!disabled,
      // Marks records that exist ONLY because the user unchecked an author
      // property — re-checking those should delete the record, while
      // re-checking a real edit should restore its value.
      authorDisable: !!authorDisable,
      elementTag: _selected?.tagName?.toLowerCase() || null,
      elementLabel: elementLabel || null,
    });
  }

  async function applyHtmlEdit({ selector, value, originalValue, elementLabel }: HtmlEditPayload) {
    // Remember whether the edit target IS the current selection — a
    // descendant of the edited node also gets disconnected, and adopting
    // the ancestor in that case would desync overlay vs Styles pane.
    const target = SelectorEngine.find(selector);
    const editedWasSelection = !!target && target === _selected;

    const record = await Persistence.saveChange({
      selector: selector.value,
      selectorType: selector.type,
      property: '__html__',
      value,
      originalValue,
      elementTag: target?.tagName?.toLowerCase() || null,
      elementLabel: elementLabel || null,
    });
    // The replacement element may have a different tag/id/class, so the old
    // selector can be stale. Hand the panel a fresh one, and re-point the
    // page-side selection if it was the node that just got replaced.
    const live = Persistence.getLiveElement(record.id);
    let newSelector: Selector | null = null;
    if (live) {
      newSelector = SelectorEngine.generate(live);
      if (editedWasSelection) {
        _selected = live;
        Overlay.showSelected(live);
      }
    }
    if (_selected && !_selected.isConnected) {
      // Selection was inside the replaced subtree — clear it honestly.
      selectElement(null);
    }
    return { record, newSelector };
  }

  /**
   * Delete an element from the DOM, persisted. Stores restore info
   * (parent selector + child index + outerHTML) so revert/undo can
   * re-insert it at the same position.
   */
  async function deleteElement(selectorObj: Selector): Promise<Ok> {
    // Clear forced states so marker classes can't end up in the saved HTML.
    await StylesEngine.forceStates(null, []);
    const el = SelectorEngine.find(selectorObj);
    if (!el || !el.parentElement) return { ok: false, error: 'element not found' };
    const parent = el.parentElement;
    const parentSel = SelectorEngine.generate(parent);
    const childIndex = Array.from(parent.children).indexOf(el);
    if (_selected === el) selectElement(null);
    await Persistence.saveChange({
      selector: selectorObj.value,
      selectorType: selectorObj.type,
      property: '__remove__',
      value: '1',
      originalValue: el.outerHTML,
      parentSelector: parentSel.value,
      parentSelectorType: parentSel.type,
      childIndex,
      elementTag: el.tagName.toLowerCase(),
    });
    return { ok: true };
  }

  /**
   * Duplicate an element: insert a clone after it, persisted as an
   * __html__ edit on the parent (its outerHTML captures the duplication).
   */
  async function duplicateElement(selectorObj: Selector): Promise<Ok> {
    // Clear forced states so marker classes can't end up in the saved HTML.
    await StylesEngine.forceStates(null, []);
    const el = SelectorEngine.find(selectorObj);
    if (!el || !el.parentElement) return { ok: false, error: 'element not found' };
    const parent = el.parentElement;
    const parentSel = SelectorEngine.generate(parent);
    const before = parent.outerHTML;
    Persistence.markOurMutation();
    el.insertAdjacentHTML('afterend', el.outerHTML);
    await Persistence.saveChange({
      selector: parentSel.value,
      selectorType: parentSel.type,
      property: '__html__',
      value: parent.outerHTML,
      originalValue: before,
      elementTag: parent.tagName.toLowerCase(),
    });
    return { ok: true };
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  // Replies are wrapped as { ok: true, data } or { ok: false, error }.
  chrome.runtime.onMessage.addListener((msg: PanelRequest, _sender, sendResponse) => {
    handleMessage(msg).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => {
        console.error('[DesInspect] handler error:', err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    );
    return true; // async response
  });

  async function handleMessage(msg: PanelRequest): Promise<unknown> {
    switch (msg.type) {
      case 'START_PICKER':
        startPicker();
        return { ok: true };
      case 'STOP_PICKER':
        stopPicker();
        // Always broadcast — stopPicker early-returns when already inactive,
        // and a panel that got out of sync (tab switch) needs the correction.
        notifyPanel('PICKER_STATE', { active: _pickerActive });
        return { ok: true };
      case 'GET_TREE_CHILDREN':
        return { nodes: getChildren(msg.selector) };
      case 'GET_TREE_ANCESTORS':
        return { ancestors: getAncestors(msg.selector) };
      case 'HIGHLIGHT':
        Overlay.showHover(SelectorEngine.find(msg.selector));
        return { ok: true };
      case 'UNHIGHLIGHT':
        Overlay.showHover(null);
        return { ok: true };
      case 'SELECT': {
        const el = SelectorEngine.find(msg.selector);
        if (el) selectElement(el);
        return { ok: !!el };
      }
      case 'GET_ELEMENT_INFO':
        return elementInfo(msg.selector);
      case 'APPLY_STYLE':
        return applyStyleEdit(msg.payload);
      case 'APPLY_HTML':
        return applyHtmlEdit(msg.payload);
      case 'DELETE_ELEMENT':
        return deleteElement(msg.selector);
      case 'DUPLICATE_ELEMENT':
        return duplicateElement(msg.selector);
      case 'FORCE_STATE': {
        await StylesEngine.forceStates(SelectorEngine.find(msg.selector), msg.states);
        return { ok: true };
      }
      case 'UNDO':
        return Persistence.undo();
      case 'REDO':
        return Persistence.redo();
      case 'GET_UNDO_STATE':
        return Persistence.getUndoState();
      case 'REVERT_CHANGE':
        return Persistence.deleteChange(msg.id);
      case 'REVERT_PROP':
        return Persistence.deleteChangeByProp(msg.selector, msg.property);
      case 'REVERT_ALL':
        await Persistence.clearAll();
        return { ok: true };
      case 'GET_CHANGES':
        return { changes: Persistence.getCurrentChanges() };
      case 'CREATE_SNAPSHOT':
        // Flush debounced CSS writes first — a snapshot taken from raw IDB
        // would silently miss the newest keystrokes.
        await Persistence.flushNow();
        return { id: await PersistDB.createSnapshot(location.href, msg.name) };
      case 'GET_SNAPSHOTS':
        return { snapshots: await PersistDB.getSnapshotsForUrl(location.href) };
      case 'DELETE_SNAPSHOT':
        await PersistDB.deleteSnapshot(msg.id);
        return { ok: true };
      case 'RESTORE_SNAPSHOT': {
        const snaps = await PersistDB.getSnapshotsForUrl(location.href);
        const snap = snaps.find((s) => s.id === msg.id);
        if (!snap) throw new Error('snapshot not found');
        await Persistence.restoreSnapshot(snap.changes);
        return { ok: true };
      }
      default:
        // Messages meant for the service worker or side panel also arrive here.
        return null;
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  Persistence.init();
})();

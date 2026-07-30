/**
 * DesInspect — Inspector (content script entry).
 *
 * Page side of the inspector: picker mode, DOM-tree serialization,
 * element info, edits (style/HTML/delete/duplicate), forced states,
 * undo/redo, and the message router for the sidepanel.
 */

(() => {
  let _pickerActive = false;
  let _selected = null;
  let _selectedSelector = null;

  const MARKER_CLASS_RE = /desinspect-fs-[a-z-]+/g;

  function stripMarkers(s) {
    if (!s) return s;
    return s
      .replace(/class="([^"]*)"/g, (full, cls) => {
        const cleaned = cls.replace(MARKER_CLASS_RE, '').replace(/\s+/g, ' ').trim();
        return cleaned ? `class="${cleaned}"` : '';
      })
      .replace(/\s+>/g, '>');
  }

  function cleanClasses(el) {
    return Array.from(el.classList || []).filter((c) => !c.startsWith('desinspect-fs-'));
  }

  // ─── Picker ────────────────────────────────────────────────────────────────

  function onMouseOver(e) {
    if (!_pickerActive || isOurs(e.target)) return;
    Overlay.showHover(e.target);
  }

  function onMouseOut() {
    if (!_pickerActive) return;
    Overlay.showHover(null);
  }

  function onClick(e) {
    if (!_pickerActive || isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(e.target);
    stopPicker();
  }

  function onKeyDown(e) {
    if (_pickerActive && e.key === 'Escape') {
      stopPicker();
      e.preventDefault();
    }
  }

  function isOurs(el) {
    return el && el.closest && el.closest('[data-desinspect]');
  }

  function startPicker() {
    if (_pickerActive) return;
    _pickerActive = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseout', onMouseOut, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    notifyPanel('PICKER_STATE', { active: true });
  }

  function stopPicker() {
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

  function selectElement(el) {
    // Any (re-)selection clears forced pseudo-states — the panel resets its
    // :hov checkboxes on every ELEMENT_SELECTED, so the page must match.
    StylesEngine.forceStates(null, []);
    if (!el) {
      _selected = null;
      _selectedSelector = null;
      Overlay.showSelected(null);
      notifyPanel('ELEMENT_SELECTED', { selector: null });
      return;
    }
    _selected = el;
    _selectedSelector = SelectorEngine.generate(el);
    Overlay.showSelected(el);
    notifyPanel('ELEMENT_SELECTED', {
      selector: _selectedSelector,
      info: describeElement(el),
    });
  }

  function describeElement(el) {
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: cleanClasses(el),
      attributes: Array.from(el.attributes || [])
        .filter((a) => !a.name.startsWith('data-desinspect'))
        .map((a) => ({
          name: a.name,
          value: a.name === 'class'
            ? a.value.replace(MARKER_CLASS_RE, '').replace(/\s+/g, ' ').trim()
            : a.value,
        }))
        .filter((a) => !(a.name === 'class' && !a.value)),
      text: (el.textContent || '').trim().slice(0, 120),
    };
  }

  // ─── DOM tree serialization ────────────────────────────────────────────────

  function isOurNode(el) {
    return el && el.nodeType === 1 && el.hasAttribute('data-desinspect');
  }

  function visibleChildren(el) {
    return Array.from(el.children).filter((c) => !isOurNode(c));
  }

  function serializeNode(el) {
    if (!(el instanceof Element)) return null;
    const sel = SelectorEngine.generate(el);
    const childElements = visibleChildren(el);
    const d = describeElement(el);
    return {
      selector: sel,
      tag: d.tag,
      id: d.id,
      classes: d.classes,
      attrs: d.attributes,
      childCount: childElements.length,
      hasText:
        childElements.length === 0 &&
        !!(el.textContent || '').trim() &&
        (el.textContent || '').length < 200
          ? el.textContent.trim()
          : null,
    };
  }

  function getChildren(selectorObj) {
    const root = selectorObj ? SelectorEngine.find(selectorObj) : document.documentElement;
    if (!root) return [];
    return visibleChildren(root).map(serializeNode).filter(Boolean);
  }

  function getAncestors(selectorObj) {
    const start = SelectorEngine.find(selectorObj);
    if (!start) return [];
    const out = [];
    let cur = start.parentElement;
    while (cur && cur !== document.documentElement) {
      if (!isOurNode(cur)) out.push(serializeNode(cur));
      cur = cur.parentElement;
    }
    return out.reverse();
  }

  // ─── Element info ──────────────────────────────────────────────────────────

  async function elementInfo(selectorObj) {
    const el = selectorObj ? SelectorEngine.find(selectorObj) : _selected;
    if (!el) return null;

    // Which persisted CSS-change selectors actually match this element —
    // the panel uses this to avoid rendering unrelated elements' edits as
    // orphan rules under the wrong selection.
    const matchingChangeSelectors = [];
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
      selector: SelectorEngine.generate(el),
      describe: describeElement(el),
      inline: StylesEngine.inlineRule(el),
      matched: await StylesEngine.matchedRules(el),
      computed: StylesEngine.computedSnapshot(el),
      box: StylesEngine.boxModel(el),
      matchingChangeSelectors,
      outerHTML: el.outerHTML.length < 50000 ? stripMarkers(el.outerHTML) : null,
      innerHTML: el.innerHTML.length < 50000 ? stripMarkers(el.innerHTML) : null,
    };
  }

  // ─── Edits ─────────────────────────────────────────────────────────────────

  function applyStyleEdit({ selector, property, value, disabled, authorDisable, elementLabel }) {
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

  async function applyHtmlEdit({ selector, value, originalValue, elementLabel }) {
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
    let newSelector = null;
    if (live) {
      newSelector = SelectorEngine.generate(live);
      if (editedWasSelection) {
        _selected = live;
        _selectedSelector = newSelector;
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
  async function deleteElement(selectorObj) {
    // Marker classes must not end up in captured outerHTML (they'd diverge
    // from the stripped record value and confuse the idempotence check).
    await StylesEngine.forceStates(null, []);
    const el = SelectorEngine.find(selectorObj);
    if (!el || !el.parentElement) return { ok: false, error: 'element not found' };
    const parent = el.parentElement;
    const parentSel = SelectorEngine.generate(parent);
    const childIndex = Array.from(parent.children).indexOf(el);
    if (_selected === el) selectElement(null);
    return Persistence.saveChange({
      selector: selectorObj.value,
      selectorType: selectorObj.type,
      property: '__remove__',
      value: '1',
      originalValue: stripMarkers(el.outerHTML),
      parentSelector: parentSel.value,
      parentSelectorType: parentSel.type,
      childIndex,
      elementTag: el.tagName.toLowerCase(),
    });
  }

  /**
   * Duplicate an element: insert a clone after it, persisted as an
   * __html__ edit on the parent (its outerHTML captures the duplication).
   */
  async function duplicateElement(selectorObj) {
    // Clear forced-state marker classes first — capturing parent.outerHTML
    // with markers present would diverge from the stripped record value and
    // trigger an immediate destructive parent re-swap.
    await StylesEngine.forceStates(null, []);
    const el = SelectorEngine.find(selectorObj);
    if (!el || !el.parentElement) return { ok: false, error: 'element not found' };
    const parent = el.parentElement;
    const parentSel = SelectorEngine.generate(parent);
    const before = stripMarkers(parent.outerHTML);
    Persistence.markOurMutation();
    el.insertAdjacentHTML('afterend', stripMarkers(el.outerHTML));
    const after = stripMarkers(parent.outerHTML);
    return Persistence.saveChange({
      selector: parentSel.value,
      selectorType: parentSel.type,
      property: '__html__',
      value: after,
      originalValue: before,
      elementTag: parent.tagName.toLowerCase(),
    });
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────

  function notifyPanel(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        const r = await handleMessage(msg);
        sendResponse({ ok: true, data: r });
      } catch (err) {
        console.error('[DesInspect] handler error:', err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  });

  async function handleMessage(msg) {
    switch (msg?.type) {
      case 'PING':
        return { url: location.href, hasSelection: !!_selected };
      case 'START_PICKER':
        startPicker();
        return { ok: true };
      case 'STOP_PICKER':
        stopPicker();
        // Always broadcast — stopPicker early-returns when already inactive,
        // and a panel that got out of sync (tab switch) needs the correction.
        notifyPanel('PICKER_STATE', { active: _pickerActive });
        return { ok: true, active: _pickerActive };
      case 'GET_TREE_CHILDREN':
        return { nodes: getChildren(msg.selector) };
      case 'GET_TREE_ANCESTORS':
        return { ancestors: getAncestors(msg.selector) };
      case 'HIGHLIGHT': {
        const el = SelectorEngine.find(msg.selector);
        Overlay.showHover(el);
        return { ok: true };
      }
      case 'UNHIGHLIGHT':
        Overlay.showHover(null);
        return { ok: true };
      case 'SELECT': {
        const el = SelectorEngine.find(msg.selector);
        if (el) selectElement(el);
        return { ok: !!el };
      }
      case 'GET_ELEMENT_INFO':
        return await elementInfo(msg.selector);
      case 'APPLY_STYLE':
        return await applyStyleEdit(msg.payload);
      case 'APPLY_HTML':
        return await applyHtmlEdit(msg.payload);
      case 'DELETE_ELEMENT':
        return await deleteElement(msg.selector);
      case 'DUPLICATE_ELEMENT':
        return await duplicateElement(msg.selector);
      case 'FORCE_STATE': {
        const el = SelectorEngine.find(msg.selector) || _selected;
        return await StylesEngine.forceStates(el, msg.states || []);
      }
      case 'UNDO':
        return await Persistence.undo();
      case 'REDO':
        return await Persistence.redo();
      case 'GET_UNDO_STATE':
        return Persistence.getUndoState();
      case 'REVERT_CHANGE':
        await Persistence.deleteChange(msg.id);
        return { ok: true };
      case 'REVERT_PROP':
        await Persistence.deleteChangeByProp(msg.selector, msg.property);
        return { ok: true };
      case 'REVERT_ALL':
        await Persistence.clearAll();
        return { ok: true };
      case 'URL_CHANGED':
        Persistence.handleNavigation();
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
        await Persistence.restoreSnapshot(snap.changes || []);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown message: ' + msg?.type };
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  Persistence.init();

  const ro = new ResizeObserver(() => Overlay.refreshSelected());
  ro.observe(document.documentElement);
  setInterval(() => Overlay.refreshSelected(), 1000);

  console.log('[DesInspect] inspector loaded on', location.href);
})();

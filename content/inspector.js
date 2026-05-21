/**
 * DesInspect — Inspector (content script entry).
 *
 * Drives the page side of the inspector: picker mode (hover-to-highlight,
 * click-to-select), DOM-tree serialization for the sidepanel, applying
 * edits, and routing messages from the sidepanel via the SW.
 *
 * The selected element is tracked here so subsequent style edits target
 * the right node without re-resolving every message.
 */

(() => {
  let _pickerActive = false;
  let _selected = null;
  let _selectedSelector = null;

  // ─── Picker ────────────────────────────────────────────────────────────────

  function onMouseOver(e) {
    if (!_pickerActive) return;
    if (isOurs(e.target)) return;
    Overlay.showHover(e.target);
  }

  function onMouseOut(e) {
    if (!_pickerActive) return;
    Overlay.showHover(null);
  }

  function onClick(e) {
    if (!_pickerActive) return;
    if (isOurs(e.target)) return;
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
      classes: Array.from(el.classList || []),
      attributes: Array.from(el.attributes || []).map((a) => ({ name: a.name, value: a.value })),
      text: (el.textContent || '').trim().slice(0, 120),
    };
  }

  // ─── DOM tree serialization ────────────────────────────────────────────────

  /**
   * Serialize an element and one level of children for the sidepanel tree.
   * Each node has: { selector, tag, id, classes, childCount, hasContent }.
   *
   * The sidepanel lazily expands deeper nodes.
   */
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
    return {
      selector: sel,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []),
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

  // ─── Element info for sidepanel ────────────────────────────────────────────

  function elementInfo(selectorObj) {
    const el = selectorObj ? SelectorEngine.find(selectorObj) : _selected;
    if (!el) return null;
    return {
      selector: SelectorEngine.generate(el),
      describe: describeElement(el),
      inline: StylesEngine.inlineRule(el),
      matched: StylesEngine.matchedRules(el),
      computed: StylesEngine.computedSnapshot(el),
      box: StylesEngine.boxModel(el),
      outerHTML: el.outerHTML.length < 50000 ? el.outerHTML : null,
      innerHTML: el.innerHTML.length < 50000 ? el.innerHTML : null,
    };
  }

  // ─── Edits ─────────────────────────────────────────────────────────────────

  function applyStyleEdit({ selector, property, value, disabled, elementLabel }) {
    return Persistence.saveChange({
      selector: selector.value,
      selectorType: selector.type,
      property,
      value,
      disabled: !!disabled,
      elementTag: _selected?.tagName?.toLowerCase() || null,
      elementLabel: elementLabel || null,
    });
  }

  function applyHtmlEdit({ selector, value, originalValue, elementLabel }) {
    return Persistence.saveChange({
      selector: selector.value,
      selectorType: selector.type,
      property: '__html__',
      value,
      originalValue,
      elementTag: _selected?.tagName?.toLowerCase() || null,
      elementLabel: elementLabel || null,
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
        return { ok: true };
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
        return elementInfo(msg.selector);
      case 'APPLY_STYLE':
        return applyStyleEdit(msg.payload);
      case 'APPLY_HTML':
        return applyHtmlEdit(msg.payload);
      case 'REVERT_CHANGE':
        await Persistence.deleteChange(msg.id);
        return { ok: true };
      case 'REVERT_ALL':
        await Persistence.clearAll();
        return { ok: true };
      case 'GET_CHANGES':
        return { changes: Persistence.getCurrentChanges() };
      case 'CREATE_SNAPSHOT':
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
        await Persistence.clearAll();
        for (const c of snap.changes) {
          await PersistDB.putChange({ ...c, urlPattern: PersistDB.normalizeUrl(location.href) });
        }
        await Persistence.reapply();
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown message: ' + msg?.type };
    }
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  Persistence.init();

  // Reposition overlays on layout shifts of the selected element
  const ro = new ResizeObserver(() => Overlay.refreshSelected());
  ro.observe(document.documentElement);

  // Periodic redraw — cheap insurance against transitions
  setInterval(() => Overlay.refreshSelected(), 1000);

  console.log('[DesInspect] inspector loaded on', location.href);
})();

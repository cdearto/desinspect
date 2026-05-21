/**
 * DesInspect — Side panel UI controller.
 *
 * Drives a DevTools-Elements-like UI: collapsible DOM tree, Styles tab with
 * inline-editable rules, Computed tab, Box-model diagram, HTML editor,
 * Changes list, and Snapshots.
 *
 * Communication: every page-side action goes through `send(type, payload)`,
 * which posts a runtime message that's forwarded to the active tab's content
 * script by the service worker. Page → panel pushes (PICKER_STATE,
 * ELEMENT_SELECTED, CHANGES_LOADED, CHANGE_SAVED…) are received via
 * chrome.runtime.onMessage.
 */

(() => {
  // ─── State ──────────────────────────────────────────────────────────────

  const state = {
    pickerActive: false,
    selected: null,             // { type, value }
    selectedInfo: null,         // full info object from page
    tree: { rootChildren: [], expanded: new Map(), nodesBySelector: new Map() },
    changes: [],                // current URL's persisted changes
    snapshots: [],
    activeTab: 'styles',
    pendingHtmlOriginal: null,
    undoStack: [],              // panel-side; mirrors changes for ⌘Z
    redoStack: [],
  };

  // ─── Messaging ──────────────────────────────────────────────────────────

  async function send(type, payload = {}) {
    const r = await chrome.runtime
      .sendMessage({ target: 'content', payload: { type, ...payload } })
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!r) return null;
    if (!r.ok) {
      console.warn('[DesInspect panel] send failed:', type, r.error);
      return null;
    }
    return r.response?.data || null;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'PICKER_STATE':
        state.pickerActive = msg.data.active;
        document.getElementById('btn-pick').classList.toggle('active', state.pickerActive);
        if (state.pickerActive) setStatus('Pick an element on the page…');
        else if (!state.selected) setStatus('No element selected');
        break;
      case 'ELEMENT_SELECTED':
        if (msg.data.selector) {
          state.selected = msg.data.selector;
          loadElementInfo();
          revealInTree(state.selected);
        }
        break;
      case 'CHANGES_LOADED':
        state.changes = msg.data.changes || [];
        renderChanges();
        annotateTreeWithChanges();
        break;
      case 'CHANGE_SAVED':
      case 'CHANGE_DELETED':
      case 'ALL_CLEARED':
        loadChanges();
        break;
      case 'URL_CHANGED':
        // page navigated — reload everything
        setTimeout(initFromTab, 200);
        break;
    }
  });

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  // ─── Init ────────────────────────────────────────────────────────────────

  async function initFromTab() {
    state.selected = null;
    state.selectedInfo = null;
    state.tree.expanded.clear();
    state.tree.nodesBySelector.clear();
    state.undoStack = [];
    state.redoStack = [];

    // Render skeleton tree (html → body)
    await refreshTreeRoot();
    await loadChanges();
    await loadSnapshots();
    setStatus('No element selected');
  }

  async function refreshTreeRoot() {
    const r = await send('GET_TREE_CHILDREN', { selector: null });
    state.tree.rootChildren = r?.nodes || [];
    renderTree();
  }

  async function loadChanges() {
    const r = await send('GET_CHANGES');
    state.changes = r?.changes || [];
    renderChanges();
    annotateTreeWithChanges();
  }

  async function loadSnapshots() {
    const r = await send('GET_SNAPSHOTS');
    state.snapshots = r?.snapshots || [];
    renderSnapshots();
  }

  // ─── Tree rendering ─────────────────────────────────────────────────────

  function renderTree() {
    const root = document.getElementById('tree');
    if (!state.tree.rootChildren.length) {
      root.innerHTML = '<div class="tree-empty">No elements loaded.</div>';
      return;
    }
    root.innerHTML = '';
    for (const node of state.tree.rootChildren) {
      root.appendChild(renderTreeNode(node, 0));
    }
    annotateTreeWithChanges();
    highlightTreeSelection();
  }

  function renderTreeNode(node, depth) {
    const key = selKey(node.selector);
    state.tree.nodesBySelector.set(key, node);

    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.selectorKey = key;

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.selectorKey = key;

    const indent = document.createElement('span');
    indent.className = 'tree-indent';
    indent.style.width = depth * 12 + 'px';
    row.appendChild(indent);

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    const hasChildren = node.childCount > 0;
    const expanded = state.tree.expanded.get(key);
    if (hasChildren) {
      toggle.classList.add('has-children');
      toggle.classList.add(expanded ? 'expanded' : 'collapsed');
    }
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!hasChildren) return;
      toggleNode(node, wrap, toggle, depth);
    });
    row.appendChild(toggle);

    row.appendChild(renderOpenTag(node));

    if (!hasChildren && node.hasText) {
      const txt = document.createElement('span');
      txt.className = 'tree-text';
      txt.textContent = truncate(node.hasText, 40);
      row.appendChild(txt);
      row.appendChild(renderCloseTag(node));
    } else if (!hasChildren) {
      row.appendChild(renderCloseTag(node));
    } else if (!expanded) {
      const dots = document.createElement('span');
      dots.className = 'tree-close';
      dots.textContent = '…';
      row.appendChild(dots);
      row.appendChild(renderCloseTag(node));
    }

    // Modified marker placeholder
    const dot = document.createElement('span');
    dot.className = 'tree-modified-marker';
    row.appendChild(dot);

    row.addEventListener('mouseenter', () => send('HIGHLIGHT', { selector: node.selector }));
    row.addEventListener('mouseleave', () => send('UNHIGHLIGHT'));
    row.addEventListener('click', () => {
      send('SELECT', { selector: node.selector });
      state.selected = node.selector;
      loadElementInfo();
      highlightTreeSelection();
    });

    wrap.appendChild(row);

    if (expanded && hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      wrap.appendChild(childContainer);
      // children may already be loaded
      const cached = state.tree.expanded.get(key);
      if (Array.isArray(cached)) {
        for (const c of cached) childContainer.appendChild(renderTreeNode(c, depth + 1));
      } else {
        // load asynchronously
        send('GET_TREE_CHILDREN', { selector: node.selector }).then((r) => {
          const children = r?.nodes || [];
          state.tree.expanded.set(key, children);
          childContainer.innerHTML = '';
          for (const c of children) childContainer.appendChild(renderTreeNode(c, depth + 1));
          annotateTreeWithChanges();
        });
      }
      // After children, the closing tag at parent's indent level
      const closingRow = document.createElement('div');
      closingRow.className = 'tree-row tree-close-row';
      const ind = document.createElement('span');
      ind.className = 'tree-indent';
      ind.style.width = depth * 12 + 'px';
      const sp = document.createElement('span');
      sp.className = 'tree-toggle';
      closingRow.appendChild(ind);
      closingRow.appendChild(sp);
      closingRow.appendChild(renderCloseTag(node));
      wrap.appendChild(closingRow);
    }

    return wrap;
  }

  async function toggleNode(node, wrap, toggle, depth) {
    const key = selKey(node.selector);
    const isExpanded = toggle.classList.contains('expanded');
    if (isExpanded) {
      state.tree.expanded.delete(key);
      toggle.classList.remove('expanded');
      toggle.classList.add('collapsed');
      // remove children container + closing row
      const children = wrap.querySelector('.tree-children');
      if (children) children.remove();
      const closeRow = wrap.querySelector('.tree-close-row');
      if (closeRow) closeRow.remove();
      // restore inline "…</tag>" on the row
      const row = wrap.querySelector('.tree-row');
      row.querySelector('.tree-close')?.remove();
      const dots = document.createElement('span');
      dots.className = 'tree-close';
      dots.textContent = '…';
      row.appendChild(dots);
      row.appendChild(renderCloseTag(node));
    } else {
      // expand
      state.tree.expanded.set(key, true);
      toggle.classList.remove('collapsed');
      toggle.classList.add('expanded');
      // remove the inline "…</tag>" on the row
      const row = wrap.querySelector('.tree-row');
      row.querySelector('.tree-close')?.remove();
      const closes = row.querySelectorAll('.tree-close');
      closes.forEach((n) => n.remove());

      // ensure no duplicate child container
      let cc = wrap.querySelector('.tree-children');
      if (cc) cc.remove();
      cc = document.createElement('div');
      cc.className = 'tree-children';
      wrap.appendChild(cc);

      const r = await send('GET_TREE_CHILDREN', { selector: node.selector });
      const children = r?.nodes || [];
      state.tree.expanded.set(key, children);
      cc.innerHTML = '';
      for (const c of children) cc.appendChild(renderTreeNode(c, depth + 1));

      // append closing row
      const closingRow = document.createElement('div');
      closingRow.className = 'tree-row tree-close-row';
      const ind = document.createElement('span');
      ind.className = 'tree-indent';
      ind.style.width = depth * 12 + 'px';
      const sp = document.createElement('span');
      sp.className = 'tree-toggle';
      closingRow.appendChild(ind);
      closingRow.appendChild(sp);
      closingRow.appendChild(renderCloseTag(node));
      wrap.appendChild(closingRow);

      annotateTreeWithChanges();
    }
  }

  function renderOpenTag(node) {
    const span = document.createElement('span');
    span.innerHTML =
      `<span class="tree-open">&lt;</span>` +
      `<span class="tree-tag">${node.tag}</span>` +
      (node.id ? ` <span class="tree-attr-name">id</span>=<span class="tree-attr-value">"${escapeHtml(node.id)}"</span>` : '') +
      (node.classes && node.classes.length
        ? ` <span class="tree-attr-name">class</span>=<span class="tree-attr-value">"${escapeHtml(node.classes.join(' '))}"</span>`
        : '') +
      `<span class="tree-open">&gt;</span>`;
    return span;
  }

  function renderCloseTag(node) {
    const span = document.createElement('span');
    span.innerHTML = `<span class="tree-close">&lt;/</span><span class="tree-tag">${node.tag}</span><span class="tree-close">&gt;</span>`;
    return span;
  }

  function highlightTreeSelection() {
    document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    if (!state.selected) return;
    const key = selKey(state.selected);
    // Linear scan: CSS.escape over-escapes for attribute values, and dataset
    // matching keeps things straightforward.
    document.querySelectorAll('.tree-row[data-selector-key]').forEach((row) => {
      if (row.dataset.selectorKey === key) row.classList.add('selected');
    });
  }

  function findTreeNodeWrap(key) {
    let found = null;
    document.querySelectorAll('.tree-node[data-selector-key]').forEach((w) => {
      if (w.dataset.selectorKey === key) found = w;
    });
    return found;
  }

  async function expandTreeNode(node) {
    const key = selKey(node.selector);
    const wrap = findTreeNodeWrap(key);
    if (!wrap) return false;
    const toggle = wrap.querySelector(':scope > .tree-row > .tree-toggle');
    if (!toggle || !toggle.classList.contains('has-children')) return false;
    if (toggle.classList.contains('expanded')) return true;
    const indent = wrap.querySelector(':scope > .tree-row > .tree-indent');
    const depth = indent ? Math.round(parseInt(indent.style.width || '0', 10) / 12) : 0;
    await toggleNode(node, wrap, toggle, depth);
    return true;
  }

  /**
   * Expand the tree down to the given selector and scroll it into view.
   * Walks ancestors top-down, expanding each, then highlights the row.
   */
  async function revealInTree(selector) {
    if (!selector) return;
    const r = await send('GET_TREE_ANCESTORS', { selector });
    const ancestors = r?.ancestors || [];
    for (const anc of ancestors) {
      await expandTreeNode(anc);
    }
    highlightTreeSelection();
    const key = selKey(selector);
    const row = (() => {
      let f = null;
      document.querySelectorAll('.tree-row[data-selector-key]').forEach((r2) => {
        if (r2.dataset.selectorKey === key) f = r2;
      });
      return f;
    })();
    if (row) row.scrollIntoView({ block: 'center' });
  }

  function annotateTreeWithChanges() {
    document.querySelectorAll('.tree-modified-marker').forEach((m) => (m.innerHTML = ''));
    const sels = new Set(state.changes.map((c) => c.selector));
    for (const sel of sels) {
      // selector strings only — find rows matching by selector.value
      document.querySelectorAll('.tree-row[data-selector-key]').forEach((row) => {
        const k = row.dataset.selectorKey;
        const parsed = parseSelKey(k);
        if (parsed && parsed.value === sel) {
          const marker = row.querySelector('.tree-modified-marker');
          if (marker && !marker.innerHTML) {
            marker.innerHTML = '<span class="tree-modified-dot" title="Has saved edits"></span>';
          }
        }
      });
    }
  }

  // ─── Selected element info → render Styles/Computed/Box/HTML ────────────

  async function loadElementInfo() {
    if (!state.selected) {
      state.selectedInfo = null;
      renderStyles();
      renderComputed();
      renderBox();
      renderHtml();
      return;
    }
    setStatus(state.selected.value);
    const info = await send('GET_ELEMENT_INFO', { selector: state.selected });
    state.selectedInfo = info;
    renderStyles();
    renderComputed();
    renderBox();
    renderHtml();
  }

  // ─── Styles tab ─────────────────────────────────────────────────────────

  function renderStyles() {
    const root = document.getElementById('styles');
    if (!state.selectedInfo) {
      root.innerHTML = '<div class="empty">Select an element to view its styles.</div>';
      return;
    }

    const filter = (document.getElementById('style-filter').value || '').toLowerCase();
    const info = state.selectedInfo;

    // 1. element.style (inline) + DesInspect edits for this selector
    const myEdits = state.changes.filter(
      (c) => c.selector === state.selected.value && c.property !== '__html__' && c.property !== '__remove__'
    );

    const rules = [];

    // Inline rule (combines page's inline style + my edits)
    const inlineProps = [...info.inline.properties];
    for (const e of myEdits) {
      // overlay/override inline
      const i = inlineProps.findIndex((p) => p.name === e.property);
      if (i >= 0) {
        inlineProps[i] = { name: e.property, value: e.value, important: true, edited: true, id: e.id, disabled: e.disabled };
      } else {
        inlineProps.push({ name: e.property, value: e.value, important: true, edited: true, id: e.id, disabled: e.disabled });
      }
    }
    rules.push({
      kind: 'inline',
      selector: 'element.style',
      source: '',
      properties: inlineProps,
      editable: true,
      targetSelector: state.selected.value,
    });

    // Author rules (matched)
    for (const r of info.matched) {
      // skip our own override sheet — it's already rolled up in inline
      if (r.origin === 'desinspect') continue;
      rules.push({
        kind: 'rule',
        selector: r.selector,
        source: r.source,
        properties: r.properties,
        editable: true,
        targetSelector: r.selector,
      });
    }

    // Compute "overridden" by walking from top: first occurrence of a prop wins
    const seen = new Set();
    for (const r of rules) {
      for (const p of r.properties) {
        if (!filter || p.name.includes(filter) || p.value.toLowerCase().includes(filter)) {
          if (seen.has(p.name)) p._overridden = true;
          else seen.add(p.name);
        }
      }
    }

    root.innerHTML = '';
    for (const r of rules) {
      root.appendChild(renderStyleRule(r, filter));
    }
  }

  function renderStyleRule(rule, filter) {
    const el = document.createElement('div');
    el.className = 'style-rule';

    const head = document.createElement('div');
    head.className = 'rule-header';
    const selSpan = document.createElement('span');
    selSpan.className = 'rule-selector' + (rule.kind === 'inline' ? ' inline' : '');
    selSpan.textContent = rule.selector;
    head.appendChild(selSpan);
    if (rule.source) {
      const src = document.createElement('span');
      src.className = 'rule-source';
      src.textContent = rule.source;
      head.appendChild(src);
    }
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'rule-body';

    const visibleProps = rule.properties.filter(
      (p) => !filter || p.name.includes(filter) || (p.value || '').toLowerCase().includes(filter)
    );
    for (const p of visibleProps) {
      body.appendChild(renderPropRow(p, rule));
    }

    // Add-property row
    const add = document.createElement('div');
    add.className = 'prop-add';
    add.textContent = '+ add property';
    add.addEventListener('click', () => startAddProperty(add, rule));
    body.appendChild(add);

    el.appendChild(body);
    return el;
  }

  function renderPropRow(p, rule) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    if (p.disabled) row.classList.add('disabled');
    if (p._overridden) row.classList.add('overridden');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'prop-checkbox';
    cb.checked = !p.disabled;
    cb.title = 'Toggle property';
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleProp(rule, p, !cb.checked);
    });
    row.appendChild(cb);

    if (p.edited) {
      const dot = document.createElement('span');
      dot.className = 'prop-modified-dot';
      dot.title = 'Saved edit';
      row.appendChild(dot);
    }

    // color swatch
    const swatch = makeColorSwatch(p.value);
    if (swatch) {
      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        openColorPicker(p, rule, swatch);
      });
      row.appendChild(swatch);
    }

    const name = document.createElement('span');
    name.className = 'prop-name';
    name.textContent = p.name;
    name.addEventListener('click', () => editPropName(name, p, rule));
    row.appendChild(name);

    const colon = document.createElement('span');
    colon.className = 'prop-colon';
    colon.textContent = ': ';
    row.appendChild(colon);

    const val = document.createElement('span');
    val.className = 'prop-value';
    val.textContent = p.value;
    val.addEventListener('click', () => editPropValue(val, p, rule));
    row.appendChild(val);

    if (p.important) {
      const imp = document.createElement('span');
      imp.className = 'prop-important';
      imp.textContent = ' !important';
      row.appendChild(imp);
    }

    return row;
  }

  function editPropName(span, p, rule) {
    const oldName = p.name;
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const commit = () => {
      span.contentEditable = 'false';
      const newName = (span.textContent || '').trim().toLowerCase();
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      if (newName === oldName || !newName) { span.textContent = oldName; return; }
      // delete old, save new
      saveStyleEdit(rule, oldName, '', /* delete */ true).then(() => {
        saveStyleEdit(rule, newName, p.value, false);
      });
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        span.blur();
        // focus the value
        const valEl = span.parentElement.querySelector('.prop-value');
        if (valEl) editPropValue(valEl, p, rule);
      }
      if (e.key === 'Escape') { span.textContent = oldName; span.blur(); }
    };
    span.addEventListener('blur', commit);
    span.addEventListener('keydown', onKey);
  }

  function editPropValue(span, p, rule) {
    const oldVal = p.value;
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      span.contentEditable = 'false';
      const newVal = (span.textContent || '').trim();
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      span.removeEventListener('input', live);
      if (newVal === oldVal) return;
      saveStyleEdit(rule, p.name, newVal, false);
    };
    const live = () => {
      // live preview without persisting yet (debounced save happens server-side)
      const v = (span.textContent || '').trim();
      send('APPLY_STYLE', { payload: {
        selector: { type: 'css', value: rule.targetSelector },
        property: p.name, value: v, elementLabel: state.selected?.value
      }});
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { span.textContent = oldVal; span.blur(); }
    };
    span.addEventListener('blur', commit);
    span.addEventListener('keydown', onKey);
    span.addEventListener('input', live);
  }

  function startAddProperty(addRow, rule) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'prop-checkbox';
    cb.checked = true;
    row.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'prop-name';
    name.contentEditable = 'true';
    name.textContent = 'property';
    row.appendChild(name);

    const colon = document.createElement('span');
    colon.className = 'prop-colon';
    colon.textContent = ': ';
    row.appendChild(colon);

    const val = document.createElement('span');
    val.className = 'prop-value';
    val.contentEditable = 'true';
    val.textContent = 'value';
    row.appendChild(val);

    addRow.parentElement.insertBefore(row, addRow);
    name.focus();
    document.execCommand('selectAll', false, null);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const n = (name.textContent || '').trim().toLowerCase();
      const v = (val.textContent || '').trim();
      if (!n || !v || n === 'property') { row.remove(); return; }
      saveStyleEdit(rule, n, v, false);
    };
    const onNameKey = (e) => {
      if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); val.focus(); document.execCommand('selectAll', false, null); }
      if (e.key === 'Escape') { row.remove(); }
    };
    const onValueKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); val.blur(); commit(); }
      if (e.key === 'Escape') { row.remove(); }
    };
    name.addEventListener('keydown', onNameKey);
    val.addEventListener('keydown', onValueKey);
    val.addEventListener('blur', () => setTimeout(commit, 0));
  }

  async function saveStyleEdit(rule, property, value, isDelete) {
    if (!state.selected) return;
    if (isDelete) {
      const id = changeIdFor(rule.targetSelector, property);
      await send('REVERT_CHANGE', { id });
    } else {
      const sel =
        rule.kind === 'inline'
          ? state.selected
          : { type: 'css', value: rule.targetSelector };
      await send('APPLY_STYLE', {
        payload: { selector: sel, property, value, elementLabel: state.selected.value },
      });
    }
    await loadElementInfo();
    await loadChanges();
  }

  async function toggleProp(rule, p, disabled) {
    if (rule.kind === 'inline' && p.edited) {
      // It's a persisted edit — toggle its disabled flag
      const sel = state.selected;
      await send('APPLY_STYLE', {
        payload: {
          selector: sel,
          property: p.name,
          value: p.value,
          disabled,
          elementLabel: state.selected.value,
        },
      });
    } else {
      // Author rule property: persist a disabled marker so we override-remove it,
      // or persist the value so toggling back restores it.
      const sel = { type: 'css', value: rule.targetSelector };
      if (disabled) {
        // To "disable" an author rule's property we override it to its initial value.
        // Simpler: persist value with disabled=true; on re-apply this removes our rule
        // and the author rule still applies. To truly disable, we'd need a userAgent
        // hack. For now we just override with `revert`.
        await send('APPLY_STYLE', {
          payload: { selector: sel, property: p.name, value: 'revert', elementLabel: state.selected.value },
        });
      } else {
        // un-disable: remove our override entirely
        const id = changeIdFor(rule.targetSelector, p.name);
        await send('REVERT_CHANGE', { id });
      }
    }
    await loadElementInfo();
    await loadChanges();
  }

  function changeIdFor(selector, property) {
    // Mirror PersistDB.normalizeUrl(location.href) — but we don't have it here.
    // The content script will resolve; we instead read from state.changes.
    const m = state.changes.find((c) => c.selector === selector && c.property === property);
    return m?.id;
  }

  function makeColorSwatch(value) {
    if (!value) return null;
    const colorRe = /(#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|\b(?:red|blue|green|black|white|gray|grey|orange|purple|pink|yellow|cyan|magenta|transparent)\b)/i;
    const m = value.match(colorRe);
    if (!m) return null;
    const s = document.createElement('span');
    s.className = 'prop-color-swatch';
    s.style.background = m[0];
    return s;
  }

  function openColorPicker(p, rule, swatch) {
    const input = document.createElement('input');
    input.type = 'color';
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    const initial = parseColorToHex(p.value) || '#000000';
    input.value = initial;
    input.click();
    input.addEventListener('input', () => {
      send('APPLY_STYLE', {
        payload: {
          selector: rule.kind === 'inline' ? state.selected : { type: 'css', value: rule.targetSelector },
          property: p.name,
          value: input.value,
          elementLabel: state.selected.value,
        },
      });
    });
    input.addEventListener('change', () => {
      saveStyleEdit(rule, p.name, input.value, false);
      input.remove();
    });
  }

  function parseColorToHex(value) {
    if (!value) return null;
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) {
      return '#' + value.slice(1).split('').map((c) => c + c).join('');
    }
    return null;
  }

  // ─── Computed tab ───────────────────────────────────────────────────────

  function renderComputed() {
    const root = document.getElementById('computed');
    if (!state.selectedInfo) {
      root.innerHTML = '<div class="empty">No selection.</div>';
      return;
    }
    const filter = (document.getElementById('computed-filter').value || '').toLowerCase();
    const showAll = document.getElementById('computed-show-all').checked;
    const entries = Object.entries(state.selectedInfo.computed).sort();
    root.innerHTML = '';
    for (const [k, v] of entries) {
      if (!showAll && (v === 'normal' || v === 'none' || v === 'auto' || v === 'initial')) continue;
      if (filter && !k.includes(filter) && !v.toLowerCase().includes(filter)) continue;
      const row = document.createElement('div');
      row.className = 'computed-row';
      const n = document.createElement('span');
      n.className = 'computed-name';
      n.textContent = k;
      const val = document.createElement('span');
      val.className = 'computed-value';
      val.textContent = v;
      row.appendChild(n);
      row.appendChild(val);
      root.appendChild(row);
    }
  }

  // ─── Box model ──────────────────────────────────────────────────────────

  function renderBox() {
    const root = document.getElementById('box');
    if (!state.selectedInfo) {
      root.innerHTML = '<div class="empty">No selection.</div>';
      return;
    }
    const b = state.selectedInfo.box;
    const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
    root.innerHTML = `
      <div class="box-diagram">
        <div class="box-layer margin">
          <span class="layer-label">margin</span>
          <div class="box-edge">${fmt(b.margin.top)}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="box-edge">${fmt(b.margin.left)}</span>
            <div class="box-layer border">
              <span class="layer-label">border</span>
              <div class="box-edge">${fmt(b.border.top)}</div>
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="box-edge">${fmt(b.border.left)}</span>
                <div class="box-layer padding">
                  <span class="layer-label">padding</span>
                  <div class="box-edge">${fmt(b.padding.top)}</div>
                  <div style="display:flex;align-items:center;gap:6px;">
                    <span class="box-edge">${fmt(b.padding.left)}</span>
                    <div class="box-layer content">
                      <span class="layer-label">content</span>
                      ${fmt(Math.max(0, b.content.width))} × ${fmt(Math.max(0, b.content.height))}
                    </div>
                    <span class="box-edge">${fmt(b.padding.right)}</span>
                  </div>
                  <div class="box-edge">${fmt(b.padding.bottom)}</div>
                </div>
                <span class="box-edge">${fmt(b.border.right)}</span>
              </div>
              <div class="box-edge">${fmt(b.border.bottom)}</div>
            </div>
            <span class="box-edge">${fmt(b.margin.right)}</span>
          </div>
          <div class="box-edge">${fmt(b.margin.bottom)}</div>
        </div>
      </div>
    `;
  }

  // ─── HTML tab ───────────────────────────────────────────────────────────

  function renderHtml() {
    const ta = document.getElementById('html-editor');
    if (!state.selectedInfo) {
      ta.value = '';
      ta.placeholder = 'Select an element to edit its HTML.';
      ta.disabled = true;
      return;
    }
    ta.disabled = false;
    ta.value = state.selectedInfo.innerHTML || '';
    state.pendingHtmlOriginal = state.selectedInfo.innerHTML || '';
  }

  async function applyHtml() {
    const ta = document.getElementById('html-editor');
    if (!state.selected) return;
    const v = ta.value;
    await send('APPLY_HTML', {
      payload: {
        selector: state.selected,
        value: v,
        originalValue: state.pendingHtmlOriginal,
        elementLabel: state.selected.value,
      },
    });
    await loadChanges();
    // Refresh element info — innerHTML changed, child tree may differ
    await loadElementInfo();
    setStatus('HTML applied');
  }

  // ─── Changes tab ────────────────────────────────────────────────────────

  function renderChanges() {
    const root = document.getElementById('changes');
    const badge = document.getElementById('changes-badge');
    badge.textContent = state.changes.length ? String(state.changes.length) : '';
    if (!state.changes.length) {
      root.innerHTML = '<div class="empty">No persisted edits yet.</div>';
      return;
    }
    root.innerHTML = '';
    const sorted = [...state.changes].sort((a, b) => b.timestamp - a.timestamp);
    for (const c of sorted) {
      const row = document.createElement('div');
      row.className = 'change-row';

      const head = document.createElement('div');
      head.className = 'change-head';
      const sel = document.createElement('span');
      sel.className = 'change-selector';
      sel.textContent = c.selector;
      sel.title = 'Click to select this element';
      sel.addEventListener('click', async () => {
        state.selected = { type: c.selectorType || 'css', value: c.selector };
        await send('SELECT', { selector: state.selected });
        await loadElementInfo();
      });
      head.appendChild(sel);

      const actions = document.createElement('div');
      actions.className = 'change-actions';
      const x = document.createElement('button');
      x.className = 'btn-x';
      x.textContent = '×';
      x.title = 'Revert this change';
      x.addEventListener('click', async () => {
        await send('REVERT_CHANGE', { id: c.id });
        await loadChanges();
        if (state.selected) await loadElementInfo();
      });
      actions.appendChild(x);
      head.appendChild(actions);
      row.appendChild(head);

      const body = document.createElement('div');
      body.className = 'change-body';
      if (c.property === '__html__') {
        body.innerHTML = `<span class="change-prop">html</span>: <span class="change-value">${truncate(escapeHtml(c.value || ''), 80)}</span>`;
      } else if (c.property === '__remove__') {
        body.innerHTML = `<span class="change-prop">removed from DOM</span>`;
      } else {
        body.innerHTML = `<span class="change-prop">${escapeHtml(c.property)}</span>: <span class="change-value">${escapeHtml(c.value || '')}</span>` + (c.disabled ? ' <span class="muted">(disabled)</span>' : '');
      }
      row.appendChild(body);
      root.appendChild(row);
    }
  }

  // ─── Snapshots tab ──────────────────────────────────────────────────────

  function renderSnapshots() {
    const root = document.getElementById('snapshots');
    if (!state.snapshots.length) {
      root.innerHTML = '<div class="empty">No snapshots saved.</div>';
      return;
    }
    root.innerHTML = '';
    for (const s of state.snapshots) {
      const row = document.createElement('div');
      row.className = 'snapshot-row';
      const head = document.createElement('div');
      head.className = 'snapshot-head';
      const name = document.createElement('span');
      name.className = 'snapshot-name';
      name.textContent = s.name;
      head.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'snapshot-meta';
      meta.textContent = `${(s.changes || []).length} edits · ${new Date(s.timestamp).toLocaleString()}`;
      head.appendChild(meta);
      row.appendChild(head);

      const acts = document.createElement('div');
      acts.className = 'snap-actions';
      const restore = document.createElement('button');
      restore.textContent = 'Restore';
      restore.addEventListener('click', async () => {
        if (!confirm(`Restore "${s.name}"? This will replace current edits.`)) return;
        await send('RESTORE_SNAPSHOT', { id: s.id });
        await loadChanges();
        if (state.selected) await loadElementInfo();
      });
      const del = document.createElement('button');
      del.textContent = 'Delete';
      del.className = 'danger';
      del.addEventListener('click', async () => {
        await send('DELETE_SNAPSHOT', { id: s.id });
        await loadSnapshots();
      });
      acts.appendChild(restore);
      acts.appendChild(del);
      row.appendChild(acts);

      root.appendChild(row);
    }
  }

  // ─── Toolbar / tab wiring ───────────────────────────────────────────────

  document.getElementById('btn-pick').addEventListener('click', async () => {
    if (state.pickerActive) await send('STOP_PICKER');
    else await send('START_PICKER');
  });

  document.getElementById('btn-refresh-tree').addEventListener('click', () => {
    state.tree.expanded.clear();
    refreshTreeRoot();
  });

  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (!confirm('Revert ALL edits on this page?')) return;
    await send('REVERT_ALL');
    await loadChanges();
    if (state.selected) await loadElementInfo();
  });

  document.getElementById('btn-snapshot').addEventListener('click', async () => {
    document.querySelector('[data-tab="snapshots"]').click();
    document.getElementById('snapshot-name').focus();
  });

  document.getElementById('btn-create-snapshot').addEventListener('click', async () => {
    const inp = document.getElementById('snapshot-name');
    await send('CREATE_SNAPSHOT', { name: inp.value || '' });
    inp.value = '';
    await loadSnapshots();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      state.activeTab = name;
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
      if (name === 'snapshots') loadSnapshots();
    });
  });

  document.getElementById('style-filter').addEventListener('input', renderStyles);
  document.getElementById('computed-filter').addEventListener('input', renderComputed);
  document.getElementById('computed-show-all').addEventListener('change', renderComputed);
  document.getElementById('btn-apply-html').addEventListener('click', applyHtml);

  // ⌘↵ in HTML editor
  document.getElementById('html-editor').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      applyHtml();
    }
  });

  // Resizable split
  const resizer = document.getElementById('resizer');
  const treePane = document.querySelector('.pane-tree');
  let dragging = false;
  let startY = 0;
  let startH = 0;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = treePane.offsetHeight;
    resizer.classList.add('active');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const h = startH + (e.clientY - startY);
    treePane.style.flex = `0 0 ${Math.max(80, Math.min(window.innerHeight - 200, h))}px`;
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('active');
    document.body.style.cursor = '';
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function selKey(selector) {
    if (!selector) return 'null';
    return `${selector.type}:${selector.value}`;
  }
  function parseSelKey(key) {
    if (!key) return null;
    const i = key.indexOf(':');
    if (i < 0) return null;
    return { type: key.slice(0, i), value: key.slice(i + 1) };
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────

  initFromTab();
})();

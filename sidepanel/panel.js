/**
 * DesInspect — Side panel UI controller.
 *
 * DevTools-Elements-style UI: collapsible DOM tree with keyboard navigation,
 * context menu, and breadcrumbs; Styles tab with inline-editable rules and
 * forced element states (:hov); Computed tab with box model; Changes and
 * Snapshots tabs; undo/redo over every persisted edit.
 *
 * All page-side actions go through `send(type, payload)` → service worker →
 * content script. Page → panel pushes arrive via chrome.runtime.onMessage.
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
    forcedStates: [],           // active :hov forced states
    ancestors: [],              // breadcrumb chain for current selection
    tabId: null,                // the inspected tab — URL_CHANGED for other tabs is noise
  };

  let _infoToken = 0;           // discards stale GET_ELEMENT_INFO responses
  let _reinitTimer = null;      // de-dupes double URL_CHANGED (onCommitted + onHistoryStateUpdated)
  const _childLoads = new Map(); // selectorKey → pending children fetch (revealInTree awaits these)

  const CSS_PROPS = [
    'align-content','align-items','align-self','animation','appearance','aspect-ratio',
    'backdrop-filter','background','background-color','background-image','background-position',
    'background-repeat','background-size','border','border-bottom','border-color','border-left',
    'border-radius','border-right','border-style','border-top','border-width','bottom',
    'box-shadow','box-sizing','clip-path','color','column-gap','content','cursor','display',
    'filter','flex','flex-basis','flex-direction','flex-grow','flex-shrink','flex-wrap','float',
    'font','font-family','font-size','font-style','font-weight','gap','grid','grid-area',
    'grid-column','grid-gap','grid-row','grid-template-columns','grid-template-rows','height',
    'inset','justify-content','justify-items','justify-self','left','letter-spacing',
    'line-height','list-style','margin','margin-bottom','margin-left','margin-right',
    'margin-top','max-height','max-width','min-height','min-width','object-fit','opacity',
    'order','outline','overflow','overflow-x','overflow-y','padding','padding-bottom',
    'padding-left','padding-right','padding-top','pointer-events','position','right',
    'row-gap','text-align','text-decoration','text-overflow','text-shadow','text-transform',
    'top','transform','transform-origin','transition','user-select','vertical-align',
    'visibility','white-space','width','word-break','z-index',
  ];

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

  chrome.runtime.onMessage.addListener((msg, sender) => {
    // Content scripts in EVERY tab push messages (CHANGES_LOADED on load,
    // UNDO_STATE on SPA nav, …). Only the inspected tab's pushes matter —
    // a background tab reloading must not clobber this panel's state.
    if (sender?.tab && state.tabId != null && sender.tab.id !== state.tabId) return;
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
          state.forcedStates = [];
          syncHovUI();
          loadElementInfo();
          if (!state.tree.rootChildren.length) {
            refreshTreeRoot().then(() => revealInTree(state.selected));
          } else {
            revealInTree(state.selected);
          }
        } else {
          // Page-side deselection (e.g. selection was inside a replaced
          // subtree) — reflect it instead of showing stale panes.
          state.selected = null;
          state.selectedInfo = null;
          state.forcedStates = [];
          syncHovUI();
          renderStyles();
          renderComputed();
          renderBox();
          renderBreadcrumbs();
          highlightTreeSelection();
          setStatus('No element selected');
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
      case 'UNDO_STATE':
        setUndoButtons(msg.data.canUndo, msg.data.canRedo);
        break;
      case 'HISTORY_APPLIED':
        setStatus(`${msg.data.direction === 'undo' ? 'Undid' : 'Redid'}: ${msg.data.label}`);
        refreshAfterMutation();
        break;
      case 'URL_CHANGED':
        // Only react to the tab we're inspecting — the SW broadcasts for
        // every tab, and a pinned tab auto-refreshing shouldn't wipe the
        // panel. onCommitted + onHistoryStateUpdated also double-fire for
        // one navigation, so coalesce.
        if (state.tabId != null && msg.tabId != null && msg.tabId !== state.tabId) break;
        clearTimeout(_reinitTimer);
        _reinitTimer = setTimeout(initFromTab, 250);
        break;
      case 'REVERT_FAILED':
        setStatus(msg.data?.reason || 'Revert failed — change kept.');
        loadChanges();
        break;
    }
  });

  // Track which tab the panel is inspecting; re-init when the user switches.
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id != null) state.tabId = tab.id;
  }).catch(() => {});
  chrome.tabs.onActivated?.addListener((info) => {
    state.tabId = info.tabId;
    clearTimeout(_reinitTimer);
    _reinitTimer = setTimeout(initFromTab, 250);
  });

  function setStatus(text) {
    document.getElementById('status').textContent = text;
  }

  function setUndoButtons(canUndo, canRedo) {
    document.getElementById('btn-undo').disabled = !canUndo;
    document.getElementById('btn-redo').disabled = !canRedo;
  }

  /** Everything that needs re-syncing after a page-side mutation. */
  async function refreshAfterMutation() {
    await loadChanges();
    await refreshTreeRoot();
    if (state.selected) {
      await loadElementInfo();
      await revealInTree(state.selected, { scroll: false });
    }
  }

  // ─── Init ────────────────────────────────────────────────────────────────

  async function initFromTab() {
    state.selected = null;
    state.selectedInfo = null;
    state.tree.expanded.clear();
    state.tree.nodesBySelector.clear();
    state.forcedStates = [];
    state.ancestors = [];
    // A tab switch strands picker state — the new tab's content script has
    // its own (inactive) picker, so reset ours instead of wedging on a
    // STOP_PICKER that will never broadcast back.
    state.pickerActive = false;
    document.getElementById('btn-pick').classList.remove('active');
    syncHovUI();
    renderBreadcrumbs();

    await refreshTreeRoot();
    await loadChanges();
    await loadSnapshots();
    const u = await send('GET_UNDO_STATE');
    if (u) setUndoButtons(u.canUndo, u.canRedo);
    setStatus('No element selected');
  }

  async function refreshTreeRoot({ invalidateCache = true } = {}) {
    // The content script may not be live yet when the panel first opens.
    let r = null;
    for (let i = 0; i < 5; i++) {
      r = await send('GET_TREE_CHILDREN', { selector: null });
      if (r?.nodes?.length) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    if (invalidateCache) {
      // Keep which nodes are expanded but drop their cached child lists so
      // HTML edits show up without a manual refresh.
      for (const key of Array.from(state.tree.expanded.keys())) {
        if (Array.isArray(state.tree.expanded.get(key))) {
          state.tree.expanded.set(key, true);
        }
      }
    }
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
      root.innerHTML =
        '<div class="tree-empty">No elements yet — try clicking <strong>Pick</strong>, or reload the page if it just loaded.</div>';
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

    const dot = document.createElement('span');
    dot.className = 'tree-modified-marker';
    row.appendChild(dot);

    row.addEventListener('mouseenter', () => send('HIGHLIGHT', { selector: node.selector }));
    row.addEventListener('mouseleave', () => send('UNHIGHLIGHT'));
    row.addEventListener('click', () => selectNode(node));
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      startInlineHtmlEdit(node, row);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      selectNode(node);
      openContextMenu(e.clientX, e.clientY, node, row);
    });

    wrap.appendChild(row);

    if (expanded && hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      wrap.appendChild(childContainer);
      const cached = state.tree.expanded.get(key);
      if (Array.isArray(cached)) {
        for (const c of cached) childContainer.appendChild(renderTreeNode(c, depth + 1));
      } else {
        // Track the pending fetch so revealInTree can await it instead of
        // walking past a not-yet-rendered subtree.
        const load = send('GET_TREE_CHILDREN', { selector: node.selector }).then((r) => {
          _childLoads.delete(key);
          if (!state.tree.expanded.has(key)) return; // collapsed meanwhile
          const children = r?.nodes || [];
          state.tree.expanded.set(key, children);
          childContainer.innerHTML = '';
          for (const c of children) childContainer.appendChild(renderTreeNode(c, depth + 1));
          annotateTreeWithChanges();
          highlightTreeSelection();
        });
        _childLoads.set(key, load);
      }
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

  function selectNode(node) {
    send('SELECT', { selector: node.selector });
    state.selected = node.selector;
    state.forcedStates = [];
    syncHovUI();
    loadElementInfo();
    highlightTreeSelection();
    loadBreadcrumbs();
  }

  async function toggleNode(node, wrap, toggle, depth) {
    const key = selKey(node.selector);
    const isExpanded = toggle.classList.contains('expanded');
    if (isExpanded) {
      state.tree.expanded.delete(key);
      toggle.classList.remove('expanded');
      toggle.classList.add('collapsed');
      const children = wrap.querySelector('.tree-children');
      if (children) children.remove();
      const closeRow = wrap.querySelector('.tree-close-row');
      if (closeRow) closeRow.remove();
      const row = wrap.querySelector('.tree-row');
      row.querySelector('.tree-close')?.remove();
      const dots = document.createElement('span');
      dots.className = 'tree-close';
      dots.textContent = '…';
      row.appendChild(dots);
      row.appendChild(renderCloseTag(node));
    } else {
      state.tree.expanded.set(key, true);
      toggle.classList.remove('collapsed');
      toggle.classList.add('expanded');
      const row = wrap.querySelector('.tree-row');
      row.querySelectorAll('.tree-close').forEach((n) => n.remove());

      let cc = wrap.querySelector('.tree-children');
      if (cc) cc.remove();
      cc = document.createElement('div');
      cc.className = 'tree-children';
      wrap.appendChild(cc);

      const load = (async () => {
        const r = await send('GET_TREE_CHILDREN', { selector: node.selector });
        // Bail if the user collapsed the node while the fetch was in
        // flight — applying anyway would resurrect it as expanded and
        // leave a stray closing-tag row.
        if (!state.tree.expanded.has(key) || !toggle.classList.contains('expanded')) return;
        const children = r?.nodes || [];
        state.tree.expanded.set(key, children);
        cc.innerHTML = '';
        for (const c of children) cc.appendChild(renderTreeNode(c, depth + 1));

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
        highlightTreeSelection();
      })().finally(() => _childLoads.delete(key));
      _childLoads.set(key, load);
      await load;
    }
  }

  function renderOpenTag(node) {
    const span = document.createElement('span');
    let html = `<span class="tree-open">&lt;</span><span class="tree-tag">${node.tag}</span>`;
    const attrs = node.attrs && node.attrs.length
      ? node.attrs
      : [
          ...(node.id ? [{ name: 'id', value: node.id }] : []),
          ...(node.classes && node.classes.length ? [{ name: 'class', value: node.classes.join(' ') }] : []),
        ];
    for (const a of attrs) {
      html += ` <span class="tree-attr-name">${escapeHtml(a.name)}</span>`;
      if (a.value !== '' || a.name === 'class' || a.name === 'id') {
        html += `=<span class="tree-attr-value">"${escapeHtml(truncate(a.value, 50))}"</span>`;
      }
    }
    html += `<span class="tree-open">&gt;</span>`;
    span.innerHTML = html;
    return span;
  }

  function renderCloseTag(node) {
    const span = document.createElement('span');
    span.innerHTML = `<span class="tree-close">&lt;/</span><span class="tree-tag">${node.tag}</span><span class="tree-close">&gt;</span>`;
    return span;
  }

  // ─── Inline HTML editor (double-click / F2) ─────────────────────────────

  async function startInlineHtmlEdit(node, row) {
    if (row.classList.contains('editing')) return;

    const info = await send('GET_ELEMENT_INFO', { selector: node.selector });
    if (!info || !info.outerHTML) {
      setStatus("Couldn't load outerHTML for this element.");
      return;
    }
    const raw = info.outerHTML;
    const pretty = prettyHtml(raw);

    // Keep the actual child nodes (not an innerHTML snapshot) so their
    // event listeners — the expand/collapse toggle's click handler in
    // particular — survive a cancel.
    const originalNodes = Array.from(row.childNodes);
    const restoreRow = () => {
      row.classList.remove('editing');
      row.innerHTML = '';
      row.append(...originalNodes);
    };
    row.classList.add('editing');
    row.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'tree-edit-wrap';
    const ta = document.createElement('textarea');
    ta.className = 'tree-edit-textarea';
    ta.value = pretty;
    ta.spellcheck = false;
    ta.rows = Math.min(20, Math.max(3, pretty.split('\n').length));
    wrap.appendChild(ta);

    const actions = document.createElement('div');
    actions.className = 'tree-edit-actions';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'link-btn primary';
    applyBtn.textContent = 'Apply (⌘↵)';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'link-btn';
    cancelBtn.textContent = 'Cancel (Esc)';
    actions.appendChild(applyBtn);
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);
    row.appendChild(wrap);

    ta.focus();
    ta.select();

    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      restoreRow();
    };
    const commit = async () => {
      if (done) return;
      done = true;
      const newHtml = ta.value;
      restoreRow();
      if (newHtml.trim() === pretty.trim() || newHtml.trim() === raw.trim()) return;
      const r = await send('APPLY_HTML', {
        payload: {
          selector: node.selector,
          value: newHtml,
          originalValue: raw,
          elementLabel: node.selector.value,
        },
      });
      // The replacement element may have a different tag/id/class — adopt
      // the fresh selector so selection/highlight/styles keep working.
      if (r?.newSelector && state.selected && selKey(state.selected) === selKey(node.selector)) {
        state.selected = r.newSelector;
      }
      await refreshAfterMutation();
      setStatus('HTML applied');
    };

    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep tree keyboard nav out of the editor
      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = start + 2;
      }
    });
    applyBtn.addEventListener('click', (e) => { e.stopPropagation(); commit(); });
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
    const onDocClick = (e) => {
      if (done) {
        document.removeEventListener('mousedown', onDocClick, true);
        return;
      }
      if (!row.contains(e.target)) {
        document.removeEventListener('mousedown', onDocClick, true);
        cancel();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
  }

  // ─── Tree helpers ───────────────────────────────────────────────────────

  function highlightTreeSelection() {
    document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    if (!state.selected) return;
    const key = selKey(state.selected);
    document.querySelectorAll('.tree-row[data-selector-key]').forEach((row) => {
      if (row.dataset.selectorKey === key && !row.classList.contains('tree-close-row')) {
        row.classList.add('selected');
      }
    });
  }

  function findTreeNodeWrap(key) {
    let found = null;
    document.querySelectorAll('.tree-node[data-selector-key]').forEach((w) => {
      if (w.dataset.selectorKey === key) found = w;
    });
    return found;
  }

  function findTreeRow(key) {
    let found = null;
    document.querySelectorAll('.tree-row[data-selector-key]').forEach((r) => {
      if (r.dataset.selectorKey === key && !r.classList.contains('tree-close-row')) found = r;
    });
    return found;
  }

  async function expandTreeNode(node) {
    const key = selKey(node.selector);
    // If this node's children are being fetched (e.g. renderTree after cache
    // invalidation), wait — otherwise the reveal walk stops mid-way because
    // the next ancestor's row isn't in the DOM yet.
    const pending = _childLoads.get(key);
    if (pending) await pending;
    const wrap = findTreeNodeWrap(key);
    if (!wrap) return false;
    const toggle = wrap.querySelector(':scope > .tree-row > .tree-toggle');
    if (!toggle || !toggle.classList.contains('has-children')) return false;
    if (toggle.classList.contains('expanded')) {
      const stillPending = _childLoads.get(key);
      if (stillPending) await stillPending;
      return true;
    }
    const indent = wrap.querySelector(':scope > .tree-row > .tree-indent');
    const depth = indent ? Math.round(parseInt(indent.style.width || '0', 10) / 12) : 0;
    await toggleNode(node, wrap, toggle, depth);
    return true;
  }

  async function revealInTree(selector, { scroll = true } = {}) {
    if (!selector) return;
    const r = await send('GET_TREE_ANCESTORS', { selector });
    const ancestors = r?.ancestors || [];
    state.ancestors = ancestors;
    renderBreadcrumbs();
    for (const anc of ancestors) {
      await expandTreeNode(anc);
    }
    highlightTreeSelection();
    if (scroll) {
      const row = findTreeRow(selKey(selector));
      if (row) row.scrollIntoView({ block: 'center' });
    }
  }

  async function loadBreadcrumbs() {
    if (!state.selected) {
      state.ancestors = [];
      renderBreadcrumbs();
      return;
    }
    const r = await send('GET_TREE_ANCESTORS', { selector: state.selected });
    state.ancestors = r?.ancestors || [];
    renderBreadcrumbs();
  }

  function crumbLabel(node) {
    let label = node.tag;
    if (node.id) label += `#${node.id}`;
    else if (node.classes && node.classes.length) label += `.${node.classes[0]}`;
    return label;
  }

  function renderBreadcrumbs() {
    const bar = document.getElementById('breadcrumbs');
    bar.innerHTML = '';
    if (!state.selected) return;
    const chain = [...state.ancestors];
    const selfNode = state.tree.nodesBySelector.get(selKey(state.selected)) || {
      selector: state.selected,
      tag: state.selectedInfo?.describe?.tag || state.selected.value,
      id: state.selectedInfo?.describe?.id || null,
      classes: state.selectedInfo?.describe?.classes || [],
    };
    chain.push(selfNode);
    chain.forEach((node, i) => {
      const crumb = document.createElement('span');
      crumb.className = 'crumb' + (i === chain.length - 1 ? ' current' : '');
      crumb.textContent = crumbLabel(node);
      crumb.addEventListener('click', () => selectNode(node));
      crumb.addEventListener('mouseenter', () => send('HIGHLIGHT', { selector: node.selector }));
      crumb.addEventListener('mouseleave', () => send('UNHIGHLIGHT'));
      bar.appendChild(crumb);
      if (i < chain.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = ' › ';
        bar.appendChild(sep);
      }
    });
    bar.scrollLeft = bar.scrollWidth;
  }

  function annotateTreeWithChanges() {
    document.querySelectorAll('.tree-modified-marker').forEach((m) => (m.innerHTML = ''));
    const sels = new Set(state.changes.map((c) => c.selector));
    for (const sel of sels) {
      document.querySelectorAll('.tree-row[data-selector-key]').forEach((row) => {
        const parsed = parseSelKey(row.dataset.selectorKey);
        if (parsed && parsed.value === sel) {
          const marker = row.querySelector('.tree-modified-marker');
          if (marker && !marker.innerHTML) {
            marker.innerHTML = '<span class="tree-modified-dot" title="Has saved edits"></span>';
          }
        }
      });
    }
  }

  // ─── DOM control actions ────────────────────────────────────────────────

  async function deleteSelectedElement(selector) {
    const target = selector || state.selected;
    if (!target) return;
    const r = await send('DELETE_ELEMENT', { selector: target });
    if (r && r.ok === false) {
      setStatus(`Delete failed: ${r.error || 'element not found'}`);
      return;
    }
    if (state.selected && selKey(state.selected) === selKey(target)) {
      state.selected = null;
      state.selectedInfo = null;
      renderStyles();
      renderComputed();
      renderBox();
    }
    await refreshAfterMutation();
    setStatus('Element deleted (undo with ⌘Z)');
  }

  async function duplicateElement(selector) {
    const target = selector || state.selected;
    if (!target) return;
    const r = await send('DUPLICATE_ELEMENT', { selector: target });
    if (r && r.ok === false) {
      setStatus(`Duplicate failed: ${r.error || 'element not found'}`);
      return;
    }
    await refreshAfterMutation();
    setStatus('Element duplicated');
  }

  function isHidden(selector) {
    return state.changes.some(
      (c) => c.selector === selector.value && c.property === 'visibility' && c.value === 'hidden' && !c.disabled
    );
  }

  async function toggleHideElement(selector) {
    const target = selector || state.selected;
    if (!target) return;
    if (isHidden(target)) {
      await send('REVERT_PROP', { selector: target.value, property: 'visibility' });
      setStatus('Element shown');
    } else {
      await send('APPLY_STYLE', {
        payload: { selector: target, property: 'visibility', value: 'hidden', elementLabel: target.value },
      });
      setStatus('Element hidden (H to show)');
    }
    await loadChanges();
    if (state.selected) await loadElementInfo();
  }

  // ─── Context menu ───────────────────────────────────────────────────────

  function openContextMenu(x, y, node, row) {
    const menu = document.getElementById('ctx-menu');
    menu.innerHTML = '';
    const hidden = isHidden(node.selector);

    const items = [
      { label: 'Edit as HTML', key: 'F2', act: () => startInlineHtmlEdit(node, row) },
      { label: 'Duplicate element', key: '', act: () => duplicateElement(node.selector) },
      { label: hidden ? 'Show element' : 'Hide element', key: 'H', act: () => toggleHideElement(node.selector) },
      { label: 'Delete element', key: '⌫', danger: true, act: () => deleteSelectedElement(node.selector) },
      { sep: true },
      { label: 'Copy selector', key: '', act: () => copyText(node.selector.value) },
      { label: 'Copy outerHTML', key: '', act: async () => {
          const info = await send('GET_ELEMENT_INFO', { selector: node.selector });
          if (info?.outerHTML) copyText(info.outerHTML);
        } },
    ];

    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `<span>${item.label}</span><span class="ctx-key">${item.key}</span>`;
      btn.addEventListener('click', () => {
        closeContextMenu();
        item.act();
      });
      menu.appendChild(btn);
    }

    menu.hidden = false;
    // Keep on-screen.
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }

  function closeContextMenu() {
    document.getElementById('ctx-menu').hidden = true;
  }

  document.addEventListener('mousedown', (e) => {
    const menu = document.getElementById('ctx-menu');
    if (!menu.hidden && !menu.contains(e.target)) closeContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
  });

  function copyText(text) {
    navigator.clipboard.writeText(text).then(
      () => setStatus('Copied'),
      () => setStatus('Copy failed')
    );
  }

  // ─── Tree keyboard navigation ───────────────────────────────────────────

  function visibleTreeRows() {
    return Array.from(document.querySelectorAll('#tree .tree-row:not(.tree-close-row)'));
  }

  function nodeForRow(row) {
    return state.tree.nodesBySelector.get(row.dataset.selectorKey) || null;
  }

  document.getElementById('tree').addEventListener('keydown', async (e) => {
    if (e.target.closest('.tree-edit-wrap')) return; // inline editor owns keys
    const rows = visibleTreeRows();
    if (!rows.length) return;
    const selectedKey = state.selected ? selKey(state.selected) : null;
    let idx = rows.findIndex((r) => r.dataset.selectorKey === selectedKey);

    const selectRowAt = (i) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))];
      const node = nodeForRow(row);
      if (node) {
        selectNode(node);
        row.scrollIntoView({ block: 'nearest' });
      }
    };

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectRowAt(idx < 0 ? 0 : idx + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectRowAt(idx < 0 ? 0 : idx - 1);
        break;
      case 'ArrowRight': {
        e.preventDefault();
        if (idx < 0) return;
        const row = rows[idx];
        const node = nodeForRow(row);
        const toggle = row.querySelector('.tree-toggle');
        if (node && toggle?.classList.contains('collapsed')) {
          const wrap = row.closest('.tree-node');
          const indent = row.querySelector('.tree-indent');
          const depth = indent ? Math.round(parseInt(indent.style.width || '0', 10) / 12) : 0;
          await toggleNode(node, wrap, toggle, depth);
        } else {
          selectRowAt(idx + 1);
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        if (idx < 0) return;
        const row = rows[idx];
        const node = nodeForRow(row);
        const toggle = row.querySelector('.tree-toggle');
        if (node && toggle?.classList.contains('expanded')) {
          const wrap = row.closest('.tree-node');
          const indent = row.querySelector('.tree-indent');
          const depth = indent ? Math.round(parseInt(indent.style.width || '0', 10) / 12) : 0;
          await toggleNode(node, wrap, toggle, depth);
        } else {
          // Move to parent row.
          const wrap = row.closest('.tree-node');
          const parentWrap = wrap?.parentElement?.closest('.tree-node');
          if (parentWrap) {
            const parentRow = parentWrap.querySelector(':scope > .tree-row');
            const parentNode = nodeForRow(parentRow);
            if (parentNode) selectNode(parentNode);
          }
        }
        break;
      }
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (state.selected) deleteSelectedElement(state.selected);
        break;
      case 'h':
      case 'H':
        e.preventDefault();
        if (state.selected) toggleHideElement(state.selected);
        break;
      case 'F2':
      case 'Enter': {
        e.preventDefault();
        if (idx < 0) return;
        const row = rows[idx];
        const node = nodeForRow(row);
        if (node) startInlineHtmlEdit(node, row);
        break;
      }
    }
  });

  // ─── Selected element info ──────────────────────────────────────────────

  async function loadElementInfo() {
    if (!state.selected) {
      state.selectedInfo = null;
      renderStyles();
      renderComputed();
      renderBox();
      renderBreadcrumbs();
      return;
    }
    setStatus(state.selected.value);
    // Token guard: GET_ELEMENT_INFO latency varies wildly (cross-origin CSS
    // fetch vs instant null). A stale slow response must not clobber the
    // info for a newer selection.
    const token = ++_infoToken;
    const requestedKey = selKey(state.selected);
    const info = await send('GET_ELEMENT_INFO', { selector: state.selected });
    if (token !== _infoToken) return;
    if (!state.selected || selKey(state.selected) !== requestedKey) return;
    state.selectedInfo = info;
    renderStyles();
    renderComputed();
    renderBox();
    renderBreadcrumbs();
  }

  // ─── Styles tab ─────────────────────────────────────────────────────────

  function renderStyles() {
    const root = document.getElementById('styles');
    if (!state.selectedInfo) {
      if (state.selected) {
        root.innerHTML =
          `<div class="empty">Couldn't resolve <code>${escapeHtml(state.selected.value)}</code> on the page.<br>` +
          `It may have been re-rendered or replaced. Try picking again.</div>`;
      } else {
        root.innerHTML = '<div class="empty">Select an element to view its styles.</div>';
      }
      return;
    }
    if (!state.selectedInfo.inline || !state.selectedInfo.matched) {
      root.innerHTML = '<div class="empty">Styles data missing — try clicking refresh.</div>';
      return;
    }

    const filter = (document.getElementById('style-filter').value || '').toLowerCase();
    const info = state.selectedInfo;

    // Index CSS changes by (selector, property); fold each into the rule
    // that owns it so checkbox toggles never spawn duplicate rows.
    const changesByKey = new Map();
    for (const c of state.changes) {
      if (c.property === '__html__' || c.property === '__remove__') continue;
      changesByKey.set(`${c.selector}::${c.property}`, c);
    }
    const consumedKeys = new Set();

    function mergeChangesIntoProps(originalProps, selector, { skipConsumed = false } = {}) {
      const merged = originalProps.map((p) => ({ ...p }));
      for (const [key, e] of changesByKey.entries()) {
        if (e.selector !== selector) continue;
        if (skipConsumed && consumedKeys.has(key)) continue;
        const idx = merged.findIndex((p) => p.name === e.property);
        if (idx >= 0) {
          merged[idx] = {
            ...merged[idx],
            value: e.value,
            important: true,
            edited: true,
            disabled: !!e.disabled,
            authorDisable: !!e.authorDisable,
            id: e.id,
          };
        } else {
          merged.push({
            name: e.property,
            value: e.value,
            important: true,
            edited: true,
            disabled: !!e.disabled,
            authorDisable: !!e.authorDisable,
            id: e.id,
            _added: true,
          });
        }
        consumedKeys.add(key);
      }
      return merged;
    }

    // Author rules consume their changes FIRST so a change made on an author
    // rule whose selector happens to equal the element's own generated
    // selector (e.g. '#hero') doesn't also appear as a phantom row under
    // element.style.
    const authorRules = [];
    for (const r of info.matched) {
      if (r.origin === 'desinspect') continue;
      authorRules.push({
        kind: 'rule',
        selector: r.selector,
        pseudo: r.pseudo || null,
        source: r.source,
        properties: mergeChangesIntoProps(r.properties, r.selector),
        editable: true,
        targetSelector: r.selector,
      });
    }

    const inlineSelector = state.selected.value;
    const rules = [
      {
        kind: 'inline',
        selector: 'element.style',
        source: '',
        properties: mergeChangesIntoProps(info.inline.properties, inlineSelector, { skipConsumed: true }),
        editable: true,
        targetSelector: inlineSelector,
      },
      ...authorRules,
    ];

    // Orphan edits — selector doesn't match any rendered rule, but DOES
    // match the selected element (content script verifies via el.matches /
    // xpath resolution). Without this filter, every page-wide edit would
    // show up under every selection, and its controls would silently
    // mutate a different element's record.
    const matchingSet = new Set(info.matchingChangeSelectors || []);
    const orphans = new Map();
    for (const [key, e] of changesByKey.entries()) {
      if (consumedKeys.has(key)) continue;
      if (!matchingSet.has(e.selector)) continue;
      if (!orphans.has(e.selector)) orphans.set(e.selector, []);
      orphans.get(e.selector).push({
        name: e.property,
        value: e.value,
        important: true,
        edited: true,
        disabled: !!e.disabled,
        authorDisable: !!e.authorDisable,
        id: e.id,
        _added: true,
      });
      if (!orphans.get(e.selector).targetType) {
        orphans.get(e.selector).targetType = e.selectorType || 'css';
      }
    }
    for (const [sel, props] of orphans.entries()) {
      rules.push({
        kind: 'rule',
        selector: sel,
        pseudo: null,
        source: 'DesInspect edit',
        properties: props,
        editable: true,
        targetSelector: sel,
        targetType: props.targetType || 'css',
      });
    }

    // Overridden: first (topmost) non-disabled occurrence of a name wins.
    const seen = new Set();
    for (const r of rules) {
      for (const p of r.properties) {
        if (!filter || p.name.includes(filter) || (p.value || '').toLowerCase().includes(filter)) {
          if (p.disabled) continue;
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
    if (rule.pseudo) {
      const pseudo = document.createElement('span');
      pseudo.className = 'rule-pseudo';
      pseudo.textContent = rule.pseudo;
      pseudo.title = 'Applies only in this state';
      head.appendChild(pseudo);
    }
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

  function selectorFor(rule) {
    return rule.kind === 'inline'
      ? state.selected
      : { type: rule.targetType || 'css', value: rule.targetSelector };
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

    const commit = async () => {
      span.contentEditable = 'false';
      const newName = (span.textContent || '').trim().toLowerCase();
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      if (newName === oldName || !newName) { span.textContent = oldName; return; }
      if (p.edited) {
        // Our own change record — genuinely delete the old one.
        await send('REVERT_PROP', { selector: rule.targetSelector, property: oldName });
      } else {
        // Author CSS can't be deleted; renaming means "turn the old
        // declaration off, add the new one" — persist a disabled override.
        await send('APPLY_STYLE', {
          payload: { selector: selectorFor(rule), property: oldName, value: p.value, disabled: true, elementLabel: state.selected?.value },
        });
      }
      await saveStyleEdit(rule, newName, p.value, false);
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        span.blur();
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
    // Whether a change record existed before this edit session started —
    // Escape must restore that exact state, not just the visual text.
    const hadRecord = !!p.edited;
    const priorDisabled = !!p.disabled;
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let finished = false;
    const cleanup = () => {
      span.contentEditable = 'false';
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      span.removeEventListener('input', live);
    };
    const commit = () => {
      if (finished) return;
      finished = true;
      cleanup();
      const newVal = (span.textContent || '').trim();
      if (newVal === oldVal) return;
      saveStyleEdit(rule, p.name, newVal, false);
    };
    const cancel = async () => {
      if (finished) return;
      finished = true;
      cleanup();
      span.textContent = oldVal;
      // Live preview already persisted intermediate values — undo that.
      if (hadRecord) {
        await send('APPLY_STYLE', {
          payload: {
            selector: selectorFor(rule),
            property: p.name,
            value: oldVal,
            disabled: priorDisabled,
            elementLabel: state.selected?.value,
          },
        });
      } else {
        await send('REVERT_PROP', { selector: rule.targetSelector, property: p.name });
      }
      await loadChanges();
      await loadElementInfo();
    };
    const live = () => {
      const v = (span.textContent || '').trim();
      if (!v) return;
      send('APPLY_STYLE', {
        payload: {
          selector: selectorFor(rule),
          property: p.name,
          value: v,
          elementLabel: state.selected?.value,
        },
      });
    };
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      // Chrome-style numeric stepping: ↑/↓ ±1, ⇧ ±10, ⌥ ±0.1.
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const stepped = stepNumericValue(
          span.textContent || '',
          (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)
        );
        if (stepped !== null) {
          e.preventDefault();
          span.textContent = stepped;
          // caret to end
          const r2 = document.createRange();
          r2.selectNodeContents(span);
          r2.collapse(false);
          const s2 = window.getSelection();
          s2.removeAllRanges();
          s2.addRange(r2);
          live();
        }
      }
    };
    span.addEventListener('blur', commit);
    span.addEventListener('keydown', onKey);
    span.addEventListener('input', live);
  }

  /**
   * Step the first number in a CSS value by delta, preserving the unit.
   * Returns null when the value has no number (arrow keys then do nothing).
   */
  function stepNumericValue(value, delta) {
    const m = value.match(/-?\d*\.?\d+/);
    if (!m) return null;
    const num = parseFloat(m[0]);
    const stepped = Math.round((num + delta) * 100) / 100;
    return value.slice(0, m.index) + String(stepped) + value.slice(m.index + m[0].length);
  }

  function startAddProperty(addRow, rule) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'prop-checkbox';
    cb.checked = true;
    row.appendChild(cb);

    const nameIn = document.createElement('input');
    nameIn.className = 'prop-name prop-edit-input';
    nameIn.placeholder = 'property';
    nameIn.spellcheck = false;
    nameIn.autocomplete = 'off';
    nameIn.setAttribute('list', 'css-props');
    row.appendChild(nameIn);

    const colon = document.createElement('span');
    colon.className = 'prop-colon';
    colon.textContent = ': ';
    row.appendChild(colon);

    const valIn = document.createElement('input');
    valIn.className = 'prop-value prop-edit-input';
    valIn.placeholder = 'value';
    valIn.spellcheck = false;
    valIn.autocomplete = 'off';
    row.appendChild(valIn);

    addRow.parentElement.insertBefore(row, addRow);
    nameIn.focus();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const n = nameIn.value.trim().toLowerCase();
      const v = valIn.value.trim();
      if (!n || !v) { row.remove(); return; }
      saveStyleEdit(rule, n, v, false);
    };
    const cancel = () => { committed = true; row.remove(); };

    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Enter' || e.key === ':') {
        e.preventDefault();
        valIn.focus();
        valIn.select();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    valIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        commit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      }
    });
    const onBlur = () => {
      setTimeout(() => {
        if (committed) return;
        if (document.activeElement === nameIn || document.activeElement === valIn) return;
        if (nameIn.value.trim() && valIn.value.trim()) commit();
        else cancel();
      }, 0);
    };
    nameIn.addEventListener('blur', onBlur);
    valIn.addEventListener('blur', onBlur);
  }

  /** "+ New rule": selector input first, then properties under it. */
  function startNewRule() {
    if (!state.selected) {
      setStatus('Select an element first');
      return;
    }
    const root = document.getElementById('styles');
    const block = document.createElement('div');
    block.className = 'style-rule';

    const head = document.createElement('div');
    head.className = 'rule-header';
    const selIn = document.createElement('input');
    selIn.className = 'new-rule-selector';
    selIn.value = state.selected.value;
    selIn.spellcheck = false;
    head.appendChild(selIn);
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'rule-body';
    const add = document.createElement('div');
    add.className = 'prop-add';
    add.textContent = '+ add property';
    body.appendChild(add);
    block.appendChild(body);

    // New rule goes right under element.style (index 0).
    const first = root.querySelector('.style-rule');
    if (first && first.nextSibling) root.insertBefore(block, first.nextSibling);
    else root.appendChild(block);

    selIn.focus();
    selIn.select();

    const ruleRef = { kind: 'rule', targetSelector: selIn.value };
    selIn.addEventListener('input', () => {
      ruleRef.targetSelector = selIn.value.trim() || state.selected.value;
    });
    selIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        startAddProperty(add, ruleRef);
      } else if (e.key === 'Escape') {
        block.remove();
      }
    });
    add.addEventListener('click', () => startAddProperty(add, ruleRef));
  }

  async function saveStyleEdit(rule, property, value, isDelete) {
    if (!state.selected) return;
    if (isDelete) {
      await send('REVERT_PROP', { selector: rule.targetSelector, property });
    } else {
      await send('APPLY_STYLE', {
        payload: { selector: selectorFor(rule), property, value, elementLabel: state.selected.value },
      });
    }
    await loadElementInfo();
    await loadChanges();
  }

  /**
   * Checkbox toggle. Unchecking persists a disabled change (revert
   * !important). Re-checking an author property deletes the change so the
   * cascade resumes; re-checking an added property clears its flag.
   */
  async function toggleProp(rule, p, disabled) {
    if (!state.selected) return;
    const sel = selectorFor(rule);

    if (!disabled) {
      // Re-check. Only records that exist purely because the user unchecked
      // an author property (authorDisable) should be deleted so the author
      // cascade resumes — a record holding a REAL edit must be re-enabled
      // with its value intact, or edit → uncheck → recheck loses the edit.
      if (p.edited && p.authorDisable && p.id) {
        await send('REVERT_CHANGE', { id: p.id });
      } else {
        await send('APPLY_STYLE', {
          payload: { selector: sel, property: p.name, value: p.value, disabled: false, elementLabel: state.selected.value },
        });
      }
    } else {
      // Uncheck. Tag records created by disabling a never-edited author
      // property so the re-check branch can tell them apart from edits.
      await send('APPLY_STYLE', {
        payload: {
          selector: sel,
          property: p.name,
          value: p.value,
          disabled: true,
          authorDisable: !p.edited,
          elementLabel: state.selected.value,
        },
      });
    }
    await loadElementInfo();
    await loadChanges();
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

  function openColorPicker(p, rule) {
    const input = document.createElement('input');
    input.type = 'color';
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.value = parseColorToHex(p.value) || '#000000';
    input.click();
    input.addEventListener('input', () => {
      send('APPLY_STYLE', {
        payload: { selector: selectorFor(rule), property: p.name, value: input.value, elementLabel: state.selected.value },
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

  // ─── Force element state (:hov) ─────────────────────────────────────────

  function syncHovUI() {
    const row = document.getElementById('hov-row');
    row.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = state.forcedStates.includes(cb.dataset.state);
    });
    document.getElementById('btn-hov').classList.toggle('active', state.forcedStates.length > 0);
  }

  document.getElementById('btn-hov').addEventListener('click', () => {
    const row = document.getElementById('hov-row');
    row.hidden = !row.hidden;
  });

  document.getElementById('hov-row').addEventListener('change', async () => {
    if (!state.selected) return;
    const states = Array.from(
      document.querySelectorAll('#hov-row input[type="checkbox"]:checked')
    ).map((cb) => cb.dataset.state);
    state.forcedStates = states;
    await send('FORCE_STATE', { selector: state.selected, states });
    syncHovUI();
    await loadElementInfo();
  });

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

  // ─── HTML pretty-printer ────────────────────────────────────────────────

  function prettyHtml(html, indent = '  ') {
    if (!html) return '';
    const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
    const INLINE_SHORT = 80;
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html.trim();
    function attrs(el) {
      return Array.from(el.attributes)
        .map((a) => ` ${a.name}="${(a.value || '').replace(/"/g, '&quot;')}"`)
        .join('');
    }
    function emit(node, depth) {
      const pad = indent.repeat(depth);
      if (node.nodeType === 3) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        return t ? pad + t + '\n' : '';
      }
      if (node.nodeType === 8) {
        return pad + '<!--' + node.nodeValue + '-->\n';
      }
      if (node.nodeType !== 1) return '';
      const tag = node.tagName.toLowerCase();
      const a = attrs(node);
      if (VOID.has(tag)) return `${pad}<${tag}${a}>\n`;
      const children = Array.from(node.childNodes);
      if (children.length === 0) return `${pad}<${tag}${a}></${tag}>\n`;
      if (
        children.length === 1 &&
        children[0].nodeType === 3 &&
        (children[0].textContent || '').replace(/\s+/g, ' ').trim().length < INLINE_SHORT &&
        !children[0].textContent.includes('\n')
      ) {
        const text = (children[0].textContent || '').replace(/\s+/g, ' ').trim();
        return `${pad}<${tag}${a}>${text}</${tag}>\n`;
      }
      let out = `${pad}<${tag}${a}>\n`;
      for (const c of children) out += emit(c, depth + 1);
      out += `${pad}</${tag}>\n`;
      return out;
    }
    let out = '';
    for (const c of tmpl.content.childNodes) out += emit(c, 0);
    return out.trimEnd();
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
        await revealInTree(state.selected);
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
        await refreshAfterMutation();
      });
      actions.appendChild(x);
      head.appendChild(actions);
      row.appendChild(head);

      const body = document.createElement('div');
      body.className = 'change-body';
      if (c.property === '__html__') {
        body.innerHTML = `<span class="change-prop">html</span>: <span class="change-value">${truncate(escapeHtml(c.value || ''), 80)}</span>`;
      } else if (c.property === '__remove__') {
        body.innerHTML = `<span class="change-prop">deleted:</span> <span class="change-value">${truncate(escapeHtml(c.originalValue || ''), 60)}</span>`;
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
        if (!confirm(`Restore "${s.name}"? This will replace current edits (undoable with ⌘Z).`)) return;
        await send('RESTORE_SNAPSHOT', { id: s.id });
        await refreshAfterMutation();
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

  // ─── Undo / redo ────────────────────────────────────────────────────────

  async function doUndo() {
    const r = await send('UNDO');
    if (r?.done) await refreshAfterMutation();
  }

  async function doRedo() {
    const r = await send('REDO');
    if (r?.done) await refreshAfterMutation();
  }

  document.getElementById('btn-undo').addEventListener('click', doUndo);
  document.getElementById('btn-redo').addEventListener('click', doRedo);

  document.addEventListener('keydown', (e) => {
    // Don't hijack ⌘Z while typing in inputs/editables.
    const t = e.target;
    const typing =
      t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z' || typing) return;
    e.preventDefault();
    if (e.shiftKey) doRedo();
    else doUndo();
  });

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
    if (!confirm('Revert ALL edits on this page? (undoable with ⌘Z)')) return;
    await send('REVERT_ALL');
    await refreshAfterMutation();
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

  document.getElementById('btn-add-rule').addEventListener('click', startNewRule);

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

  // Populate CSS property autocomplete.
  const dl = document.getElementById('css-props');
  for (const prop of CSS_PROPS) {
    const opt = document.createElement('option');
    opt.value = prop;
    dl.appendChild(opt);
  }

  initFromTab();
})();

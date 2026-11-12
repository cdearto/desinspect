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
  /** A Styles-tab property: an author declaration, possibly with a saved edit merged in. */
  interface PanelProp extends StyleProp {
    /** A saved change is merged into this row (`id` is the record's). */
    edited?: boolean;
    id?: string;
    disabled?: boolean;
    authorDisable?: boolean;
    /** Exists only as a saved change — not in the page's own CSS. */
    added?: boolean;
    /** Loses to a same-named property in a rule listed above. */
    overridden?: boolean;
  }

  /** Where an edit made in a rule block is saved: `inline` targets the selected element itself. */
  interface RuleTarget {
    kind: 'inline' | 'rule';
    targetSelector: string;
    targetType?: Selector['type'];
  }

  interface PanelRule extends RuleTarget {
    selector: string;
    pseudo?: string | null;
    source: string;
    properties: PanelProp[];
  }

  type Crumb = Pick<TreeNode, 'selector' | 'tag' | 'id' | 'classes'>;

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  /** Create an element with a class name and optional text. */
  function el(tag: string, className: string, text = ''): HTMLElement {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  // ─── State ──────────────────────────────────────────────────────────────

  const state = {
    pickerActive: false,
    selected: null as Selector | null,
    selectedInfo: null as ElementInfo | null, // null while loading, or if `selected` no longer resolves
    tree: {
      rootChildren: [] as TreeNode[],
      expanded: new Set<string>(), // selector keys of expanded nodes
      nodesBySelector: new Map<string, TreeNode>(), // every node rendered so far, by selector key
    },
    changes: [] as ChangeRecord[], // the inspected URL's persisted edits
    snapshots: [] as Snapshot[],
    forcedStates: [] as string[], // active :hov states
    ancestors: [] as TreeNode[], // breadcrumb chain for the selection
    tabId: null as number | null, // the inspected tab; pushes from other tabs are ignored
    windowId: null as number | null, // the window this panel lives in
  };

  let _infoToken = 0; // discards stale GET_ELEMENT_INFO responses
  let _reinitTimer: number | undefined;
  // Selector key → in-flight children fetch, so revealInTree can wait for it.
  const _childLoads = new Map<string, Promise<void>>();

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

  // The tab this panel inspects: the active tab of the panel's own window.
  const tabReady = chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    state.tabId = tab?.id ?? null;
    state.windowId = tab?.windowId ?? null;
  });

  /** Send a message to the inspected tab's content script; null on failure. */
  async function send<K extends keyof RequestMap>(
    type: K,
    ...[payload]: {} extends RequestMap[K]['req'] ? [] : [RequestMap[K]['req']]
  ): Promise<RequestMap[K]['res'] | null> {
    await tabReady;
    if (state.tabId == null) return null;
    try {
      const request = { type, ...payload } as PanelRequest;
      const r = await chrome.tabs.sendMessage(state.tabId, request);
      if (r?.ok) return r.data ?? null;
      console.warn('[DesInspect panel]', type, 'failed:', r?.error);
    } catch {
      // No content script in this tab (chrome:// pages, or still loading).
    }
    return null;
  }

  // Coalesces bursts: one navigation fires several URL_CHANGED events.
  function scheduleReinit() {
    clearTimeout(_reinitTimer);
    _reinitTimer = setTimeout(initFromTab, 250);
  }

  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId !== state.windowId) return;
    state.tabId = info.tabId;
    scheduleReinit();
  });

  chrome.runtime.onMessage.addListener((msg: PanelPush, sender) => {
    // Content scripts in every tab push messages; only the inspected tab's
    // matter. (URL_CHANGED comes from the service worker and carries tabId.)
    const fromTab = msg.type === 'URL_CHANGED' ? msg.tabId : sender.tab?.id;
    if (fromTab != null && fromTab !== state.tabId) return;
    switch (msg.type) {
      case 'PICKER_STATE':
        state.pickerActive = msg.data.active;
        $('btn-pick').classList.toggle('active', state.pickerActive);
        if (state.pickerActive) setStatus('Pick an element on the page…');
        else if (!state.selected) setStatus('No element selected');
        break;
      case 'ELEMENT_SELECTED':
        state.selected = msg.data.selector;
        state.forcedStates = [];
        syncHovUI();
        loadElementInfo();
        if (!state.selected) {
          // Page-side deselection (e.g. the selection was deleted/replaced).
          state.ancestors = [];
          highlightTreeSelection();
          setStatus('No element selected');
        } else if (!state.tree.rootChildren.length) {
          // The initial tree fetch raced the content script — retry now.
          refreshTreeRoot().then(() => revealInTree(state.selected));
        } else {
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
      case 'UNDO_STATE':
        setUndoButtons(msg.data);
        break;
      case 'HISTORY_APPLIED':
        setStatus(`${msg.data.direction === 'undo' ? 'Undid' : 'Redid'}: ${msg.data.label}`);
        refreshAfterMutation();
        break;
      case 'URL_CHANGED':
        scheduleReinit();
        break;
      case 'REVERT_FAILED':
        setStatus(msg.data.reason);
        loadChanges();
        break;
    }
  });

  function setStatus(text: string): void {
    $('status').textContent = text;
  }

  function setUndoButtons({ canUndo, canRedo }: UndoState): void {
    $<HTMLButtonElement>('btn-undo').disabled = !canUndo;
    $<HTMLButtonElement>('btn-redo').disabled = !canRedo;
  }

  /**
   * Re-sync after a style edit. Changes load first: the Styles tab merges
   * them into the rules it renders.
   */
  async function refreshStyles() {
    await loadChanges();
    await loadElementInfo();
  }

  /** Re-sync everything after an edit that may have changed the DOM. */
  async function refreshAfterMutation() {
    await refreshTreeRoot();
    await refreshStyles();
    await revealInTree(state.selected);
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
    $('btn-pick').classList.remove('active');
    syncHovUI();

    await refreshTreeRoot();
    await refreshStyles(); // also clears the panes of the previous page's selection
    await loadSnapshots();
    const u = await send('GET_UNDO_STATE');
    if (u) setUndoButtons(u);
    setStatus('No element selected');
  }

  /** Re-fetch the tree from the page; expanded nodes stay expanded. */
  async function refreshTreeRoot() {
    // The content script may not be live yet when the panel first opens.
    let r = null;
    for (let i = 0; i < 5; i++) {
      r = await send('GET_TREE_CHILDREN', { selector: null });
      if (r?.nodes?.length) break;
      await new Promise((res) => setTimeout(res, 200));
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
    const root = $('tree');
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

  function renderTreeNode(node: TreeNode, depth: number): HTMLElement {
    const key = selKey(node.selector);
    state.tree.nodesBySelector.set(key, node);
    const hasChildren = node.childCount > 0;
    const expanded = hasChildren && state.tree.expanded.has(key);

    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    wrap.dataset.depth = String(depth);

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.selectorKey = key;
    row.appendChild(makeIndent(depth));

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (hasChildren) {
      toggle.classList.add('has-children', expanded ? 'expanded' : 'collapsed');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleNode(node, wrap);
      });
    }
    row.appendChild(toggle);
    row.appendChild(renderOpenTag(node));

    if (!hasChildren && node.hasText) {
      const txt = document.createElement('span');
      txt.className = 'tree-text';
      txt.textContent = truncate(node.hasText, 40);
      row.appendChild(txt);
    }
    if (!expanded) row.appendChild(renderCloseTag(node, hasChildren));

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
    if (expanded) renderChildren(node, wrap);
    return wrap;
  }

  function makeIndent(depth: number): HTMLElement {
    const indent = document.createElement('span');
    indent.className = 'tree-indent';
    indent.style.width = depth * 12 + 'px';
    return indent;
  }

  /**
   * Fill in an expanded node: its children (fetched from the page) and the
   * closing-tag row. The fetch is tracked in _childLoads so revealInTree can
   * wait for it instead of walking past a not-yet-rendered subtree.
   */
  function renderChildren(node: TreeNode, wrap: HTMLElement): Promise<void> {
    const key = selKey(node.selector);
    const depth = Number(wrap.dataset.depth);

    const container = document.createElement('div');
    container.className = 'tree-children';
    const closingRow = document.createElement('div');
    closingRow.className = 'tree-row tree-close-row';
    const spacer = document.createElement('span');
    spacer.className = 'tree-toggle';
    closingRow.append(makeIndent(depth), spacer, renderCloseTag(node, false));
    wrap.append(container, closingRow);

    const load = send('GET_TREE_CHILDREN', { selector: node.selector })
      .then((r) => {
        // Skip if the node was collapsed (or re-rendered) while fetching.
        if (!container.isConnected) return;
        for (const c of r?.nodes || []) container.appendChild(renderTreeNode(c, depth + 1));
        annotateTreeWithChanges();
        highlightTreeSelection();
      })
      .finally(() => {
        if (_childLoads.get(key) === load) _childLoads.delete(key);
      });
    _childLoads.set(key, load);
    return load;
  }

  /** Select a node from the panel side (tree row, breadcrumb, change row). */
  async function selectNode(node: Pick<TreeNode, 'selector'>): Promise<void> {
    state.selected = node.selector;
    highlightTreeSelection();
    // On success the page answers with ELEMENT_SELECTED, which loads the rest.
    const r = await send('SELECT', { selector: node.selector });
    if (!r?.ok) loadElementInfo(); // renders the "couldn't resolve" state
  }

  /** Expand or collapse a node. Resolves once its children are rendered. */
  async function toggleNode(node: TreeNode, wrap: HTMLElement): Promise<void> {
    const key = selKey(node.selector);
    const row = wrap.querySelector(':scope > .tree-row')!;
    const toggle = row.querySelector('.tree-toggle')!;
    const expand = toggle.classList.contains('collapsed');
    toggle.classList.toggle('expanded', expand);
    toggle.classList.toggle('collapsed', !expand);

    if (expand) {
      state.tree.expanded.add(key);
      row.querySelector('.tree-close-tag')!.remove();
      await renderChildren(node, wrap);
    } else {
      state.tree.expanded.delete(key);
      wrap.querySelector(':scope > .tree-children')!.remove();
      wrap.querySelector(':scope > .tree-close-row')!.remove();
      row.querySelector('.tree-modified-marker')!.before(renderCloseTag(node, true));
    }
  }

  function renderOpenTag(node: TreeNode): HTMLElement {
    const span = document.createElement('span');
    let html = `<span class="tree-open">&lt;</span><span class="tree-tag">${node.tag}</span>`;
    for (const a of node.attrs) {
      html += ` <span class="tree-attr-name">${escapeHtml(a.name)}</span>`;
      if (a.value !== '' || a.name === 'class' || a.name === 'id') {
        html += `=<span class="tree-attr-value">"${escapeHtml(truncate(a.value, 50))}"</span>`;
      }
    }
    html += `<span class="tree-open">&gt;</span>`;
    span.innerHTML = html;
    return span;
  }

  /** `</tag>`, preceded by an ellipsis when it stands in for hidden children. */
  function renderCloseTag(node: TreeNode, withEllipsis: boolean): HTMLElement {
    const span = document.createElement('span');
    span.className = 'tree-close-tag';
    span.innerHTML =
      (withEllipsis ? '<span class="tree-close">…</span>' : '') +
      `<span class="tree-close">&lt;/</span><span class="tree-tag">${node.tag}</span><span class="tree-close">&gt;</span>`;
    return span;
  }

  // ─── Inline HTML editor (double-click / F2) ─────────────────────────────

  async function startInlineHtmlEdit(node: TreeNode, row: HTMLElement): Promise<void> {
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
    const onDocClick = (e: MouseEvent) => {
      if (done) {
        document.removeEventListener('mousedown', onDocClick, true);
        return;
      }
      if (!row.contains(e.target as Node)) {
        document.removeEventListener('mousedown', onDocClick, true);
        cancel();
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDocClick, true), 0);
  }

  // ─── Tree helpers ───────────────────────────────────────────────────────

  function findTreeRow(key: string): HTMLElement | null {
    return document.querySelector(`#tree .tree-row[data-selector-key="${CSS.escape(key)}"]`);
  }

  function highlightTreeSelection() {
    document.querySelector('#tree .tree-row.selected')?.classList.remove('selected');
    if (state.selected) findTreeRow(selKey(state.selected))?.classList.add('selected');
  }

  /** Expand the tree down to `selector`, refresh breadcrumbs, and scroll to it. */
  async function revealInTree(selector: Selector | null): Promise<void> {
    const r = selector ? await send('GET_TREE_ANCESTORS', { selector }) : null;
    state.ancestors = r?.ancestors || [];
    renderBreadcrumbs();
    for (const anc of state.ancestors) {
      const key = selKey(anc.selector);
      await _childLoads.get(key); // children may still be loading after a refresh
      const row = findTreeRow(key);
      if (!row) break;
      if (row.querySelector('.tree-toggle.collapsed')) await toggleNode(anc, row.parentElement!);
    }
    highlightTreeSelection();
    if (selector) findTreeRow(selKey(selector))?.scrollIntoView({ block: 'nearest' });
  }

  function crumbLabel(node: Crumb): string {
    let label = node.tag;
    if (node.id) label += `#${node.id}`;
    else if (node.classes && node.classes.length) label += `.${node.classes[0]}`;
    return label;
  }

  function renderBreadcrumbs() {
    const bar = $('breadcrumbs');
    bar.innerHTML = '';
    if (!state.selected) return;
    const self: Crumb | undefined =
      state.tree.nodesBySelector.get(selKey(state.selected)) ??
      (state.selectedInfo ? { selector: state.selected, ...state.selectedInfo.describe } : undefined);
    const chain: Crumb[] = self ? [...state.ancestors, self] : state.ancestors;
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

  /** Mark tree rows whose element has saved edits. */
  function annotateTreeWithChanges() {
    const edited = new Set(state.changes.map((c) => c.selector));
    document.querySelectorAll<HTMLElement>('#tree .tree-row[data-selector-key]').forEach((row) => {
      row.querySelector('.tree-modified-marker')!.innerHTML = edited.has(nodeForRow(row).selector.value)
        ? '<span class="tree-modified-dot" title="Has saved edits"></span>'
        : '';
    });
  }

  // ─── DOM control actions ────────────────────────────────────────────────

  async function deleteElement(target: Selector): Promise<void> {
    const r = await send('DELETE_ELEMENT', { selector: target });
    if (r && r.ok === false) {
      setStatus(`Delete failed: ${r.error || 'element not found'}`);
      return;
    }
    if (state.selected && selKey(state.selected) === selKey(target)) state.selected = null;
    await refreshAfterMutation();
    setStatus('Element deleted (undo with ⌘Z)');
  }

  async function duplicateElement(target: Selector): Promise<void> {
    const r = await send('DUPLICATE_ELEMENT', { selector: target });
    if (r && r.ok === false) {
      setStatus(`Duplicate failed: ${r.error || 'element not found'}`);
      return;
    }
    await refreshAfterMutation();
    setStatus('Element duplicated');
  }

  function isHidden(selector: Selector): boolean {
    return state.changes.some(
      (c) => c.selector === selector.value && c.property === 'visibility' && c.value === 'hidden' && !c.disabled
    );
  }

  async function toggleHideElement(target: Selector): Promise<void> {
    if (isHidden(target)) {
      await send('REVERT_PROP', { selector: target.value, property: 'visibility' });
      setStatus('Element shown');
    } else {
      await send('APPLY_STYLE', {
        payload: { selector: target, property: 'visibility', value: 'hidden', elementLabel: target.value },
      });
      setStatus('Element hidden (H to show)');
    }
    await refreshStyles();
  }

  // ─── Context menu ───────────────────────────────────────────────────────

  function openContextMenu(x: number, y: number, node: TreeNode, row: HTMLElement): void {
    const menu = $('ctx-menu');
    menu.innerHTML = '';
    const hidden = isHidden(node.selector);

    type MenuItem = { label: string; key?: string; danger?: boolean; act: () => void };
    const items: (MenuItem | 'separator')[] = [
      { label: 'Edit as HTML', key: 'F2', act: () => startInlineHtmlEdit(node, row) },
      { label: 'Duplicate element', act: () => duplicateElement(node.selector) },
      { label: hidden ? 'Show element' : 'Hide element', key: 'H', act: () => toggleHideElement(node.selector) },
      { label: 'Delete element', key: '⌫', danger: true, act: () => deleteElement(node.selector) },
      'separator',
      { label: 'Copy selector', act: () => copyText(node.selector.value) },
      {
        label: 'Copy outerHTML',
        act: async () => {
          const info = await send('GET_ELEMENT_INFO', { selector: node.selector });
          if (info?.outerHTML) copyText(info.outerHTML);
        },
      },
    ];

    for (const item of items) {
      if (item === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `<span>${item.label}</span><span class="ctx-key">${item.key ?? ''}</span>`;
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
    $('ctx-menu').hidden = true;
  }

  document.addEventListener('mousedown', (e) => {
    const menu = $('ctx-menu');
    if (!menu.hidden && !menu.contains(e.target as Node)) closeContextMenu();
  });

  function copyText(text: string): void {
    navigator.clipboard.writeText(text).then(
      () => setStatus('Copied'),
      () => setStatus('Copy failed')
    );
  }

  // ─── Tree keyboard navigation ───────────────────────────────────────────

  function nodeForRow(row: HTMLElement): TreeNode {
    return state.tree.nodesBySelector.get(row.dataset.selectorKey!)!;
  }

  $('tree').addEventListener('keydown', async (e) => {
    if ((e.target as Element).closest('.tree-edit-wrap')) return; // the inline editor owns its keys
    const rows = Array.from(document.querySelectorAll<HTMLElement>('#tree .tree-row[data-selector-key]'));
    if (!rows.length) return;
    const selectedRow = state.selected && findTreeRow(selKey(state.selected));
    const idx = selectedRow ? rows.indexOf(selectedRow) : -1;
    const row: HTMLElement | undefined = rows[idx];
    const wrap = row?.parentElement as HTMLElement | undefined; // the row's .tree-node
    const selectRowAt = (i: number) => selectNode(nodeForRow(rows[Math.max(0, Math.min(rows.length - 1, i))]));
    const toggleIs = (cls: string) => !!row?.querySelector(`.tree-toggle.${cls}`);

    switch (e.key) {
      case 'ArrowDown':
        selectRowAt(idx + 1);
        break;
      case 'ArrowUp':
        selectRowAt(idx - 1);
        break;
      case 'ArrowRight':
        if (row && wrap && toggleIs('collapsed')) await toggleNode(nodeForRow(row), wrap);
        else if (row) selectRowAt(idx + 1);
        break;
      case 'ArrowLeft': {
        if (row && wrap && toggleIs('expanded')) {
          await toggleNode(nodeForRow(row), wrap);
          break;
        }
        const parentRow = wrap?.parentElement
          ?.closest('.tree-node')
          ?.querySelector<HTMLElement>(':scope > .tree-row');
        if (parentRow) selectNode(nodeForRow(parentRow));
        break;
      }
      case 'Delete':
      case 'Backspace':
        if (state.selected) deleteElement(state.selected);
        break;
      case 'h':
      case 'H':
        if (state.selected) toggleHideElement(state.selected);
        break;
      case 'F2':
      case 'Enter':
        if (row) startInlineHtmlEdit(nodeForRow(row), row);
        break;
      default:
        return; // not ours — leave the event alone
    }
    e.preventDefault();
  });

  // ─── Selected element info ──────────────────────────────────────────────

  async function loadElementInfo() {
    // GET_ELEMENT_INFO latency varies wildly (cross-origin CSS fetch vs an
    // instant null), so a stale response must not clobber a newer selection.
    const token = ++_infoToken;
    let info = null;
    if (state.selected) {
      setStatus(state.selected.value);
      info = await send('GET_ELEMENT_INFO', { selector: state.selected });
      if (token !== _infoToken) return;
    }
    state.selectedInfo = info;
    renderStyles();
    renderComputed();
    renderBox();
    renderBreadcrumbs();
  }

  // ─── Styles tab ─────────────────────────────────────────────────────────

  function renderStyles(): void {
    const root = $('styles');
    const info = state.selectedInfo;
    if (!state.selected) {
      root.innerHTML = '<div class="empty">Select an element to view its styles.</div>';
      return;
    }
    if (!info) {
      root.innerHTML =
        `<div class="empty">Couldn't resolve <code>${escapeHtml(state.selected.value)}</code> on the page.<br>` +
        `It may have been re-rendered or replaced. Try picking again.</div>`;
      return;
    }

    // element.style first, then the page's matching rules.
    const rules: PanelRule[] = [
      {
        kind: 'inline',
        selector: 'element.style',
        source: '',
        properties: info.inline.properties.map((p) => ({ ...p })),
        targetSelector: state.selected.value,
      },
      ...info.matched.map((r): PanelRule => ({
        kind: 'rule',
        selector: r.selector,
        pseudo: r.pseudo,
        source: r.source,
        properties: r.properties.map((p) => ({ ...p })),
        targetSelector: r.selector,
      })),
    ];

    // Fold each saved CSS change into the rule it was made on, so an edit
    // shows up in place instead of as a duplicate row.
    const matching = new Set(info.matchingChangeSelectors);
    for (const c of state.changes) {
      if (c.property === '__html__' || c.property === '__remove__') continue;
      const candidates = rules.filter((r) => r.targetSelector === c.selector);
      // Prefer the rule that declares the property, then any author rule
      // (the element's own selector can equal an author selector, e.g. '#hero').
      let rule =
        candidates.find((r) => r.properties.some((p) => p.name === c.property)) ??
        candidates.find((r) => r.kind === 'rule') ??
        candidates[0];
      if (!rule) {
        // A change under a selector the page has no rule for (made via "+").
        // Other elements' changes are not this element's business.
        if (!matching.has(c.selector)) continue;
        rule = {
          kind: 'rule',
          selector: c.selector,
          source: 'DesInspect edit',
          properties: [],
          targetSelector: c.selector,
          targetType: c.selectorType,
        };
        rules.push(rule);
      }
      const merged: PanelProp = {
        name: c.property,
        value: c.value,
        important: true,
        edited: true,
        id: c.id,
        disabled: !!c.disabled,
        authorDisable: !!c.authorDisable,
      };
      const i = rule.properties.findIndex((p) => p.name === c.property);
      if (i >= 0) rule.properties[i] = merged;
      else rule.properties.push({ ...merged, added: true });
    }

    // Approximate the cascade: the topmost enabled occurrence of a property
    // wins, later ones are struck through.
    const seen = new Set<string>();
    for (const p of rules.flatMap((r) => r.properties)) {
      if (p.disabled) continue;
      if (seen.has(p.name)) p.overridden = true;
      else seen.add(p.name);
    }

    const filter = $<HTMLInputElement>('style-filter').value.toLowerCase();
    root.replaceChildren(...rules.map((r) => renderStyleRule(r, filter)));
  }

  function matchesFilter(p: StyleProp, filter: string): boolean {
    return !filter || p.name.includes(filter) || p.value.toLowerCase().includes(filter);
  }

  function renderStyleRule(rule: PanelRule, filter: string): HTMLElement {
    const head = el('div', 'rule-header');
    head.append(el('span', rule.kind === 'inline' ? 'rule-selector inline' : 'rule-selector', rule.selector));
    if (rule.pseudo) {
      const pseudo = el('span', 'rule-pseudo', rule.pseudo);
      pseudo.title = 'Applies only in this state';
      head.append(pseudo);
    }
    if (rule.source) head.append(el('span', 'rule-source', rule.source));

    const body = el('div', 'rule-body');
    for (const p of rule.properties) {
      if (matchesFilter(p, filter)) body.append(renderPropRow(p, rule));
    }
    body.append(makeAddPropertyRow(rule));

    const block = el('div', 'style-rule');
    block.append(head, body);
    return block;
  }

  function makeAddPropertyRow(rule: RuleTarget): HTMLElement {
    const add = el('div', 'prop-add', '+ add property');
    add.addEventListener('click', () => startAddProperty(add, rule));
    return add;
  }

  function makeCheckbox(checked: boolean): HTMLInputElement {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'prop-checkbox';
    cb.checked = checked;
    return cb;
  }

  function renderPropRow(p: PanelProp, rule: PanelRule): HTMLElement {
    const row = el('div', 'prop-row');
    row.classList.toggle('disabled', !!p.disabled);
    row.classList.toggle('overridden', !!p.overridden);

    const cb = makeCheckbox(!p.disabled);
    cb.title = 'Toggle property';
    cb.addEventListener('click', () => toggleProp(rule, p, !cb.checked));
    row.append(cb);

    if (p.edited) {
      const dot = el('span', 'prop-modified-dot');
      dot.title = 'Saved edit';
      row.append(dot);
    }

    const swatch = makeColorSwatch(p.value);
    if (swatch) {
      swatch.addEventListener('click', () => openColorPicker(p, rule));
      row.append(swatch);
    }

    const name = el('span', 'prop-name', p.name);
    name.addEventListener('click', () => editPropName(name, val, p, rule));
    const val = el('span', 'prop-value', p.value);
    val.addEventListener('click', () => editPropValue(val, p, rule));
    row.append(name, el('span', 'prop-colon', ': '), val);

    if (p.important) row.append(el('span', 'prop-important', ' !important'));
    return row;
  }

  /** The selector an edit made in `rule` is saved under. */
  function selectorFor(rule: RuleTarget): Selector {
    return rule.kind === 'inline'
      ? state.selected!
      : { type: rule.targetType || 'css', value: rule.targetSelector };
  }

  function applyStyle(rule: RuleTarget, property: string, value: string, flags: { disabled?: boolean; authorDisable?: boolean } = {}) {
    return send('APPLY_STYLE', {
      payload: { selector: selectorFor(rule), property, value, elementLabel: state.selected?.value, ...flags },
    });
  }

  /** Make a span editable in place, with its text selected (or the caret at the end). */
  function beginEdit(span: HTMLElement, caretAtEnd = false): void {
    span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    if (caretAtEnd) range.collapse(false);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function editPropName(span: HTMLElement, valueSpan: HTMLElement, p: PanelProp, rule: RuleTarget): void {
    const oldName = p.name;
    beginEdit(span);

    const commit = async () => {
      span.contentEditable = 'false';
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      const newName = (span.textContent || '').trim().toLowerCase();
      if (newName === oldName || !newName) {
        span.textContent = oldName;
        return;
      }
      if (p.edited) {
        // Our own change record — genuinely delete the old one.
        await send('REVERT_PROP', { selector: rule.targetSelector, property: oldName });
      } else {
        // Author CSS can't be deleted; renaming means "turn the old
        // declaration off, add the new one".
        await applyStyle(rule, oldName, p.value, { disabled: true, authorDisable: true });
      }
      await saveStyleEdit(rule, newName, p.value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        span.blur();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        span.blur();
        editPropValue(valueSpan, p, rule);
      } else if (e.key === 'Escape') {
        span.textContent = oldName;
        span.blur();
      }
    };
    span.addEventListener('blur', commit);
    span.addEventListener('keydown', onKey);
  }

  /**
   * Edit a value in place. The page previews every keystroke (each one is a
   * saved change), so Escape has to put the previous state back explicitly.
   */
  function editPropValue(span: HTMLElement, p: PanelProp, rule: RuleTarget): void {
    const oldVal = p.value;
    beginEdit(span);

    let finished = false;
    const finish = () => {
      finished = true;
      span.contentEditable = 'false';
      span.removeEventListener('blur', commit);
      span.removeEventListener('keydown', onKey);
      span.removeEventListener('input', preview);
    };
    const commit = () => {
      if (finished) return;
      finish();
      const newVal = (span.textContent || '').trim();
      if (newVal !== oldVal) saveStyleEdit(rule, p.name, newVal);
    };
    const cancel = async () => {
      if (finished) return;
      finish();
      span.textContent = oldVal;
      if (p.edited) {
        // There was a saved change before this edit — restore it as it was.
        await applyStyle(rule, p.name, oldVal, { disabled: p.disabled, authorDisable: p.authorDisable });
      } else {
        await send('REVERT_PROP', { selector: rule.targetSelector, property: p.name });
      }
      await refreshStyles();
    };
    const preview = () => {
      const v = (span.textContent || '').trim();
      if (v) applyStyle(rule, p.name, v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        span.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Chrome-style numeric stepping: ↑/↓ ±1, ⇧ ±10, ⌥ ±0.1.
        const step = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
        const stepped = stepNumericValue(span.textContent || '', step);
        if (stepped === null) return;
        e.preventDefault();
        span.textContent = stepped;
        beginEdit(span, true);
        preview();
      }
    };
    span.addEventListener('blur', commit);
    span.addEventListener('keydown', onKey);
    span.addEventListener('input', preview);
  }

  /**
   * Step the first number in a CSS value by delta, preserving the unit.
   * Returns null when the value has no number.
   */
  function stepNumericValue(value: string, delta: number): string | null {
    const m = /-?\d*\.?\d+/.exec(value);
    if (!m) return null;
    const stepped = Math.round((parseFloat(m[0]) + delta) * 100) / 100;
    return value.slice(0, m.index) + stepped + value.slice(m.index + m[0].length);
  }

  /** Insert an empty name/value row above `addRow` and save it once both are filled in. */
  function startAddProperty(addRow: HTMLElement, rule: RuleTarget): void {
    const makeInput = (className: string, placeholder: string) => {
      const input = document.createElement('input');
      input.className = `${className} prop-edit-input`;
      input.placeholder = placeholder;
      input.spellcheck = false;
      input.autocomplete = 'off';
      return input;
    };
    const nameIn = makeInput('prop-name', 'property');
    nameIn.setAttribute('list', 'css-props');
    const valIn = makeInput('prop-value', 'value');

    const row = el('div', 'prop-row');
    row.append(makeCheckbox(true), nameIn, el('span', 'prop-colon', ': '), valIn);
    addRow.before(row);
    nameIn.focus();

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const name = nameIn.value.trim().toLowerCase();
      const value = valIn.value.trim();
      if (save && name && value) saveStyleEdit(rule, name, value);
      else row.remove();
    };

    nameIn.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' || e.key === 'Enter' || e.key === ':') {
        e.preventDefault();
        valIn.focus();
      } else if (e.key === 'Escape') {
        finish(false);
      }
    });
    valIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        finish(false);
      }
    });
    // Clicking away saves a completed row and discards an incomplete one.
    row.addEventListener('focusout', (e) => {
      if (!row.contains(e.relatedTarget as Node | null)) finish(true);
    });
  }

  /** "+" new rule: a selector input (defaulting to the selection), then properties under it. */
  function startNewRule(): void {
    if (!state.selected) {
      setStatus('Select an element first');
      return;
    }
    const target: RuleTarget = { kind: 'rule', targetSelector: state.selected.value };

    const selIn = document.createElement('input');
    selIn.className = 'new-rule-selector';
    selIn.value = target.targetSelector;
    selIn.spellcheck = false;
    selIn.addEventListener('input', () => {
      target.targetSelector = selIn.value.trim() || state.selected!.value;
    });

    const head = el('div', 'rule-header');
    head.append(selIn);
    const add = makeAddPropertyRow(target);
    const body = el('div', 'rule-body');
    body.append(add);
    const block = el('div', 'style-rule');
    block.append(head, body);

    selIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        startAddProperty(add, target);
      } else if (e.key === 'Escape') {
        block.remove();
      }
    });

    // Right under element.style.
    $('styles').firstElementChild?.after(block);
    selIn.select();
  }

  async function saveStyleEdit(rule: RuleTarget, property: string, value: string): Promise<void> {
    await applyStyle(rule, property, value);
    await refreshStyles();
  }

  /**
   * Checkbox toggle. Unchecking saves a disabled change (applied as `revert`,
   * so the property really turns off). Re-checking restores the value —
   * unless the change only existed to switch off an author property, in
   * which case it is simply removed and the page's own CSS takes over again.
   */
  async function toggleProp(rule: RuleTarget, p: PanelProp, disabled: boolean): Promise<void> {
    if (disabled) {
      await applyStyle(rule, p.name, p.value, { disabled: true, authorDisable: !p.edited });
    } else if (p.authorDisable && p.id) {
      await send('REVERT_CHANGE', { id: p.id });
    } else {
      await applyStyle(rule, p.name, p.value);
    }
    await refreshStyles();
  }

  const COLOR_RE =
    /#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|\b(?:red|blue|green|black|white|gray|grey|orange|purple|pink|yellow|cyan|magenta|transparent)\b/i;

  function makeColorSwatch(value: string): HTMLElement | null {
    const color = COLOR_RE.exec(value)?.[0];
    if (!color) return null;
    const swatch = el('span', 'prop-color-swatch');
    swatch.style.background = color;
    return swatch;
  }

  /** Open the native color picker for a property, previewing as the user drags. */
  function openColorPicker(p: PanelProp, rule: RuleTarget): void {
    const input = document.createElement('input');
    input.type = 'color';
    input.style.cssText = 'position:fixed; opacity:0;';
    input.value = toHexColor(p.value) ?? '#000000';
    document.body.append(input);
    input.addEventListener('input', () => applyStyle(rule, p.name, input.value));
    input.addEventListener('change', () => {
      saveStyleEdit(rule, p.name, input.value);
      input.remove();
    });
    input.addEventListener('cancel', () => input.remove());
    input.click();
  }

  /** '#abc' / '#aabbcc' → '#aabbcc' (the only format <input type=color> accepts); else null. */
  function toHexColor(value: string): string | null {
    if (/^#[0-9a-f]{6}$/i.test(value)) return value;
    if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((c) => c + c).join('');
    return null;
  }

  // ─── Force element state (:hov) ─────────────────────────────────────────

  const hovCheckboxes = () => Array.from(document.querySelectorAll<HTMLInputElement>('#hov-row input'));

  function syncHovUI(): void {
    for (const cb of hovCheckboxes()) cb.checked = state.forcedStates.includes(cb.dataset.state!);
    $('btn-hov').classList.toggle('active', state.forcedStates.length > 0);
  }

  $('btn-hov').addEventListener('click', () => {
    $('hov-row').hidden = !$('hov-row').hidden;
  });

  $('hov-row').addEventListener('change', async () => {
    if (!state.selected) return;
    state.forcedStates = hovCheckboxes().filter((cb) => cb.checked).map((cb) => cb.dataset.state!);
    syncHovUI();
    await send('FORCE_STATE', { selector: state.selected, states: state.forcedStates });
    await loadElementInfo();
  });

  // ─── Computed tab ───────────────────────────────────────────────────────

  // Values that say "nothing set" — hidden unless "show all" is ticked.
  const DEFAULT_VALUES = new Set(['normal', 'none', 'auto', 'initial']);

  function renderComputed(): void {
    const root = $('computed');
    if (!state.selectedInfo) {
      root.innerHTML = '<div class="empty">No selection.</div>';
      return;
    }
    const filter = $<HTMLInputElement>('computed-filter').value.toLowerCase();
    const showAll = $<HTMLInputElement>('computed-show-all').checked;
    root.innerHTML = '';
    for (const [name, value] of Object.entries(state.selectedInfo.computed).sort()) {
      if (!showAll && DEFAULT_VALUES.has(value)) continue;
      if (filter && !name.includes(filter) && !value.toLowerCase().includes(filter)) continue;
      const row = el('div', 'computed-row');
      row.append(el('span', 'computed-name', name), el('span', 'computed-value', value));
      root.append(row);
    }
  }

  // ─── Box model ──────────────────────────────────────────────────────────

  function renderBox(): void {
    const root = $('box');
    if (!state.selectedInfo) {
      root.innerHTML = '<div class="empty">No selection.</div>';
      return;
    }
    const { margin, border, padding, content } = state.selectedInfo.box;
    const fmt = (n: number) => String(Math.round(Math.max(0, n) * 10) / 10);
    /** One nested layer: its four edge sizes around `inner`. */
    const layer = (name: string, edges: Edges, inner: string) => `
      <div class="box-layer ${name}">
        <span class="layer-label">${name}</span>
        <div class="box-edge">${fmt(edges.top)}</div>
        <div class="box-row">
          <span class="box-edge">${fmt(edges.left)}</span>
          ${inner}
          <span class="box-edge">${fmt(edges.right)}</span>
        </div>
        <div class="box-edge">${fmt(edges.bottom)}</div>
      </div>`;
    const contentBox = `
      <div class="box-layer content">
        <span class="layer-label">content</span>
        ${fmt(content.width)} × ${fmt(content.height)}
      </div>`;
    root.innerHTML = `<div class="box-diagram">${layer('margin', margin, layer('border', border, layer('padding', padding, contentBox)))}</div>`;
  }

  // ─── HTML pretty-printer ────────────────────────────────────────────────

  const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  /** Re-indent markup for the HTML editor: one element per line, short text kept inline. */
  function prettyHtml(html: string): string {
    const tmpl = document.createElement('template');
    tmpl.innerHTML = html.trim();
    const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
    const escapeText = (text: string) => text.replace(/[&<>]/g, (c) => HTML_ESCAPES[c]);

    function emit(node: Node, depth: number): string {
      const pad = '  '.repeat(depth);
      if (node instanceof Text) {
        const text = squash(node.data);
        return text ? `${pad}${escapeText(text)}\n` : '';
      }
      if (node instanceof Comment) return `${pad}<!--${node.data}-->\n`;
      if (!(node instanceof Element)) return '';

      const tag = node.tagName.toLowerCase();
      const attrs = Array.from(node.attributes, (a) => ` ${a.name}="${escapeHtml(a.value)}"`).join('');
      const open = `${pad}<${tag}${attrs}>`;
      if (VOID_TAGS.has(tag)) return `${open}\n`;

      const children = Array.from(node.childNodes);
      const onlyText = children.length === 1 && children[0] instanceof Text ? squash(children[0].data) : null;
      if (!children.length) return `${open}</${tag}>\n`;
      if (onlyText !== null && onlyText.length < 80) return `${open}${escapeText(onlyText)}</${tag}>\n`;
      return `${open}\n${children.map((c) => emit(c, depth + 1)).join('')}${pad}</${tag}>\n`;
    }

    return Array.from(tmpl.content.childNodes, (c) => emit(c, 0)).join('').trimEnd();
  }

  // ─── Changes tab ────────────────────────────────────────────────────────

  function describeChange(c: ChangeRecord): string {
    const prop = (text: string) => `<span class="change-prop">${escapeHtml(text)}</span>`;
    const value = (text: string, max: number) => `<span class="change-value">${escapeHtml(truncate(text, max))}</span>`;
    if (c.property === '__html__') return `${prop('html')}: ${value(c.value, 80)}`;
    if (c.property === '__remove__') return `${prop('deleted')}: ${value(c.originalValue || '', 60)}`;
    return `${prop(c.property)}: ${value(c.value, 200)}${c.disabled ? ' <span class="muted">(disabled)</span>' : ''}`;
  }

  function renderChanges(): void {
    const root = $('changes');
    $('changes-badge').textContent = state.changes.length ? String(state.changes.length) : '';
    if (!state.changes.length) {
      root.innerHTML = '<div class="empty">No persisted edits yet.</div>';
      return;
    }
    root.innerHTML = '';
    for (const c of [...state.changes].sort((a, b) => b.timestamp - a.timestamp)) {
      const selector = el('span', 'change-selector', c.selector);
      selector.title = 'Click to select this element';
      selector.addEventListener('click', () => selectNode({ selector: { type: c.selectorType, value: c.selector } }));

      const revert = el('button', 'btn-x', '×');
      revert.title = 'Revert this change';
      revert.addEventListener('click', async () => {
        await send('REVERT_CHANGE', { id: c.id });
        await refreshAfterMutation();
      });

      const head = el('div', 'change-head');
      head.append(selector, revert);
      const body = el('div', 'change-body');
      body.innerHTML = describeChange(c);
      const row = el('div', 'change-row');
      row.append(head, body);
      root.append(row);
    }
  }

  // ─── Snapshots tab ──────────────────────────────────────────────────────

  function renderSnapshots(): void {
    const root = $('snapshots');
    if (!state.snapshots.length) {
      root.innerHTML = '<div class="empty">No snapshots saved.</div>';
      return;
    }
    root.innerHTML = '';
    for (const snap of state.snapshots) {
      const restore = el('button', '', 'Restore');
      restore.addEventListener('click', async () => {
        if (!confirm(`Restore "${snap.name}"? This will replace current edits (undoable with ⌘Z).`)) return;
        await send('RESTORE_SNAPSHOT', { id: snap.id });
        await refreshAfterMutation();
      });
      const del = el('button', 'danger', 'Delete');
      del.addEventListener('click', async () => {
        await send('DELETE_SNAPSHOT', { id: snap.id });
        await loadSnapshots();
      });

      const head = el('div', 'snapshot-head');
      head.append(
        el('span', 'snapshot-name', snap.name),
        el('span', 'snapshot-meta', `${snap.changes.length} edits · ${new Date(snap.timestamp).toLocaleString()}`)
      );
      const actions = el('div', 'snap-actions');
      actions.append(restore, del);
      const row = el('div', 'snapshot-row');
      row.append(head, actions);
      root.append(row);
    }
  }

  // ─── Toolbar, tabs, shortcuts ───────────────────────────────────────────

  // The page pushes HISTORY_APPLIED after an undo/redo, which refreshes the panel.
  $('btn-undo').addEventListener('click', () => send('UNDO'));
  $('btn-redo').addEventListener('click', () => send('REDO'));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeContextMenu();
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
    // Leave ⌘Z alone while typing — text fields have their own undo.
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
    e.preventDefault();
    send(e.shiftKey ? 'REDO' : 'UNDO');
  });

  $('btn-pick').addEventListener('click', () => send(state.pickerActive ? 'STOP_PICKER' : 'START_PICKER'));

  $('btn-refresh-tree').addEventListener('click', () => {
    state.tree.expanded.clear();
    refreshTreeRoot();
  });

  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('Revert ALL edits on this page? (undoable with ⌘Z)')) return;
    await send('REVERT_ALL');
    await refreshAfterMutation();
  });

  $('btn-add-rule').addEventListener('click', startNewRule);

  function showTab(name: string): void {
    for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll<HTMLElement>('.tab-panel')) {
      panel.classList.toggle('active', panel.dataset.panel === name);
    }
    if (name === 'snapshots') loadSnapshots();
  }

  for (const tab of document.querySelectorAll<HTMLElement>('.tab')) {
    tab.addEventListener('click', () => showTab(tab.dataset.tab!));
  }

  $('btn-snapshot').addEventListener('click', () => {
    showTab('snapshots');
    $('snapshot-name').focus();
  });

  $('btn-create-snapshot').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('snapshot-name');
    await send('CREATE_SNAPSHOT', { name: input.value });
    input.value = '';
    await loadSnapshots();
  });

  $('style-filter').addEventListener('input', renderStyles);
  $('computed-filter').addEventListener('input', renderComputed);
  $('computed-show-all').addEventListener('change', renderComputed);

  // Drag the divider to resize the tree pane.
  $('resizer').addEventListener('pointerdown', (down) => {
    const resizer = $('resizer');
    const treePane = document.querySelector<HTMLElement>('.pane-tree')!;
    const startHeight = treePane.offsetHeight;
    resizer.setPointerCapture(down.pointerId);
    resizer.classList.add('active');
    const onMove = (move: PointerEvent) => {
      const height = startHeight + move.clientY - down.clientY;
      treePane.style.flex = `0 0 ${Math.max(80, Math.min(innerHeight - 200, height))}px`;
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener(
      'pointerup',
      () => {
        resizer.removeEventListener('pointermove', onMove);
        resizer.classList.remove('active');
      },
      { once: true }
    );
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  /** A selector as a string key (for Maps, Sets, and data attributes). */
  function selKey(selector: Selector): string {
    return `${selector.type}:${selector.value}`;
  }

  const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
  }

  function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ─── Boot ───────────────────────────────────────────────────────────────

  $('css-props').append(...CSS_PROPS.map((prop) => Object.assign(document.createElement('option'), { value: prop })));

  initFromTab();
})();

/**
 * DesInspect — Side Panel Controller
 * 
 * Manages all UI interactions in the side panel:
 * - Tab switching
 * - Editor: displays selected element, sends CSS edits to content script
 * - Changes: lists all modifications, export, revert
 * - History: shows version timeline
 * - Communication with content scripts via chrome.runtime messaging
 */

(() => {
  'use strict';

  // ─── DOM References ─────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    // Header
    btnInspector: $('#btn-inspector'),
    btnSnapshot: $('#btn-snapshot'),
    btnHelp: $('#btn-help'),
    helpPanel: $('#help-panel'),
    btnHelpClose: $('#btn-help-close'),
    // Status
    statusBar: $('#status-bar'),
    statusText: $('#status-text'),
    // Tabs
    tabs: $$('.pi-tab'),
    // Editor
    editorEmpty: $('#editor-empty'),
    editorContent: $('#editor-content'),
    elementSelector: $('#element-selector'),
    elementTagPill: $('#element-tag-pill'),
    selectorWarning: $('#selector-warning'),
    // DevTools Styles clone
    dtFilter: $('#dt-filter'),
    dtClsToggle: $('#dt-cls-toggle'),
    dtAddRule: $('#dt-add-rule'),
    dtClsPanel: $('#dt-cls-panel'),
    dtClsInput: $('#dt-cls-input'),
    dtClsList: $('#dt-cls-list'),
    dtStyles: $('#dt-styles'),
    // Box model
    boxmodel: $('#boxmodel'),
    bmMarginTop: $('#bm-margin-top'),
    bmMarginRight: $('#bm-margin-right'),
    bmMarginBottom: $('#bm-margin-bottom'),
    bmMarginLeft: $('#bm-margin-left'),
    bmBorderTop: $('#bm-border-top'),
    bmBorderRight: $('#bm-border-right'),
    bmBorderBottom: $('#bm-border-bottom'),
    bmBorderLeft: $('#bm-border-left'),
    bmPaddingTop: $('#bm-padding-top'),
    bmPaddingRight: $('#bm-padding-right'),
    bmPaddingBottom: $('#bm-padding-bottom'),
    bmPaddingLeft: $('#bm-padding-left'),
    bmContentSize: $('#bm-content-size'),
    bmPositionText: $('#bm-position-text'),
    // Mode toggle
    modeToggles: $$('.pi-mode-toggle__btn'),
    modeCss: $('#mode-css'),
    modeHtml: $('#mode-html'),
    // Quick edit
    // (Quick Edit removed — replaced by DevTools Styles clone)
    // HTML editor
    htmlTextarea: $('#html-textarea'),
    htmlGutter: $('#html-gutter'),
    htmlCharCount: $('#html-char-count'),
    htmlStatus: $('#html-status'),
    btnHtmlApply: $('#btn-html-apply'),
    btnHtmlReset: $('#btn-html-reset'),
    btnUndo: $('#btn-undo'),
    btnRedo: $('#btn-redo'),
    outerHtmlTree: $('#outer-html-tree'),
    btnOuterCopy: $('#btn-outer-copy'),
    // DOM navigator
    domNavigator: $('#dom-navigator'),
    domTree: $('#dom-tree'),
    btnNavParent: $('#btn-nav-parent'),
    btnNavPrev: $('#btn-nav-prev'),
    btnNavNext: $('#btn-nav-next'),
    btnNavChild: $('#btn-nav-child'),
    // Changes panel
    changesEmpty: $('#changes-empty'),
    changesList: $('#changes-list'),
    changesActions: $('#changes-actions'),
    changesCount: $('#changes-count'),
    btnExportCSS: $('#btn-export-css'),
    btnExportJSON: $('#btn-export-json'),
    btnRevertAll: $('#btn-revert-all'),
    btnDiffToggle: $('#btn-diff-toggle'),
    btnEditorDiff: $('#btn-editor-diff'),
    // History panel
    historyEmpty: $('#history-empty'),
    historyList: $('#history-list'),
    // Audit panel
    auditSetup: $('#audit-setup'),
    auditApiKeyInput: $('#audit-api-key'),
    btnSaveKey: $('#btn-save-key'),
    btnTestMode: $('#btn-test-mode'),
    auditControls: $('#audit-controls'),
    btnAuditElement: $('#btn-audit-element'),
    btnAuditPage: $('#btn-audit-page'),
    btnCheckImpact: $('#btn-check-impact'),
    btnRemoveKey: $('#btn-remove-key'),
    auditLoading: $('#audit-loading'),
    auditResults: $('#audit-results'),
    auditSummary: $('#audit-summary'),
    auditFindings: $('#audit-findings'),
    auditEmpty: $('#audit-empty'),
    // Copilot
    copilotInput: $('#copilot-input'),
    btnCopilotSend: $('#btn-copilot-send'),
    copilotResults: $('#copilot-results'),
    copilotLoading: $('#copilot-loading'),
    copilotError: $('#copilot-error'),
    // Toast
    toast: $('#toast'),
  };

  // ─── State ──────────────────────────────────────────────────────────────

  let state = {
    inspectorActive: false,
    selectedElement: null,  // Element data from content script
    changes: [],            // All changes for current URL
    history: [],            // History entries
    editorMode: 'css',      // 'css' or 'html'
    originalInnerHTML: '',   // Original innerHTML before any edits
    htmlDirty: false,        // Whether the HTML textarea has unsaved changes
    navTargets: null,        // Cached targets for arrow key navigation
    diffMode: false,         // Whether diff mode is active (showing originals)
    _changesRefreshTimer: null, // Debounce timer for changes panel refresh
    _pendingPageAudit: false,   // Waiting for page data to run audit
    lastInlineProps: null,       // Track inline props for removal detection
  };

  // ─── Tabs ───────────────────────────────────────────────────────────────

  els.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetPanel = tab.dataset.tab;

      // Update tab states
      els.tabs.forEach(t => {
        t.classList.toggle('pi-tab--active', t === tab);
        t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
      });

      // Update panel visibility
      $$('.pi-panel').forEach(panel => {
        const isTarget = panel.id === `panel-${targetPanel}`;
        panel.hidden = !isTarget;
        panel.classList.toggle('pi-panel--active', isTarget);
      });

      // Load data for the panel
      if (targetPanel === 'changes') requestChanges();
      if (targetPanel === 'history') requestHistory();
    });
  });

  /**
   * Programmatically switch to a tab by name ('editor', 'changes', 'history').
   */
  function switchToTab(tabName) {
    const targetTab = $(`.pi-tab[data-tab="${tabName}"]`);
    if (targetTab) targetTab.click();
  }

  // ─── Inspector Toggle ───────────────────────────────────────────────────

  els.btnInspector.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_INSPECTOR' });
  });

  // ─── Snapshot ───────────────────────────────────────────────────────────

  els.btnSnapshot.addEventListener('click', () => {
    const name = prompt('Snapshot name (optional):') || '';
    chrome.runtime.sendMessage({
      type: 'CREATE_SNAPSHOT',
      data: { name }
    });
    showToast('Snapshot saved');
  });

  // ─── Help Panel ─────────────────────────────────────────────────────────

  els.btnHelp.addEventListener('click', () => {
    els.helpPanel.hidden = !els.helpPanel.hidden;
  });

  els.btnHelpClose.addEventListener('click', () => {
    els.helpPanel.hidden = true;
  });

  // ─── Undo / Redo ──────────────────────────────────────────────────────

  els.btnUndo.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'UNDO' });
  });

  els.btnRedo.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REDO' });
  });

  // Request initial undo state when panel opens
  chrome.runtime.sendMessage({ type: 'GET_UNDO_STATE' });

  // ─── Mode Toggle (CSS / HTML) ─────────────────────────────────────────

  els.modeToggles.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      state.editorMode = mode;

      // Update toggle button states
      els.modeToggles.forEach(b => {
        b.classList.toggle('pi-mode-toggle__btn--active', b === btn);
      });

      // Show/hide panels
      els.modeCss.hidden = (mode !== 'css');
      els.modeHtml.hidden = (mode !== 'html');

      // When switching to HTML mode, populate the textarea and show page highlight
      if (mode === 'html' && state.selectedElement) {
        populateHTMLEditor(state.selectedElement);
        chrome.runtime.sendMessage({
          type: 'SHOW_PERSISTENT_HIGHLIGHT',
          data: { selector: state.selectedElement.selector, selectorType: state.selectedElement.selectorType }
        });
      } else {
        // Leaving HTML mode — clear the persistent highlight
        chrome.runtime.sendMessage({ type: 'HIDE_PERSISTENT_HIGHLIGHT' });
      }
    });
  });

  // ─── Inspect Row Resize Handle ──────────────────────────────────────
  {
    const handle = document.getElementById('inspect-row-handle');
    const row = document.querySelector('.pi-inspect-row');
    const domNav = document.getElementById('dom-navigator');
    const boxModel = document.getElementById('boxmodel');

    if (handle && row && domNav && boxModel) {
      let dragging = false;
      let startX = 0;
      let startNavWidth = 0;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        dragging = true;
        startX = e.clientX;
        startNavWidth = domNav.getBoundingClientRect().width;
        handle.classList.add('pi-inspect-row__handle--active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const rowWidth = row.getBoundingClientRect().width;
        const handleWidth = 6;
        const newNavWidth = Math.max(80, Math.min(rowWidth - handleWidth - 100, startNavWidth + dx));
        const navPct = (newNavWidth / rowWidth) * 100;

        domNav.style.flex = 'none';
        domNav.style.width = navPct + '%';
        boxModel.style.flex = '1';
        boxModel.style.minWidth = '100px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('pi-inspect-row__handle--active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    }
  }

  // ─── HTML Editor ──────────────────────────────────────────────────────

  /**
   * Populate the HTML textarea with the selected element's innerHTML.
   * Formats the HTML with basic indentation for readability.
   * Builds an interactive outerHTML tree for element selection.
   */
  function populateHTMLEditor(elementData) {
    const html = elementData.innerHTML || '';
    const formatted = formatHTML(html);

    els.htmlTextarea.value = formatted;
    state.originalInnerHTML = html;
    state.htmlDirty = false;

    updateLineNumbers();
    updateHTMLCharCount();
    setHTMLStatus('', '');

    // Build interactive outer HTML tree
    buildOuterHtmlTree(elementData);
  }

  /**
   * Build an interactive outer HTML tree from the selected element's outerHTML.
   * Each element tag is hoverable (highlights on page) and clickable (selects it).
   * Works like Chrome DevTools Elements panel.
   */
  function buildOuterHtmlTree(elementData) {
    const container = els.outerHtmlTree;
    container.innerHTML = '';

    // Use parent's outerHTML so we show siblings in context.
    // If no parent, fall back to the element's own outerHTML.
    const useParent = elementData.parentOuterHTML && elementData.parentSelector;
    const outerHTML = useParent ? elementData.parentOuterHTML : (elementData.outerHTML || '');
    if (!outerHTML) {
      container.textContent = '(no HTML available)';
      return;
    }

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(outerHTML, 'text/html');
      const root = doc.body.firstElementChild || doc.head.firstElementChild;
      if (!root) {
        container.textContent = outerHTML.substring(0, 500);
        return;
      }

      // If showing parent context, the root is the parent element.
      // The selected element is at childIndex within the parent.
      const rootData = useParent
        ? { selector: elementData.parentSelector.selector, selectorType: elementData.parentSelector.type }
        : { selector: elementData.selector, selectorType: elementData.selectorType };

      const selectedChildIndex = useParent ? elementData.childIndex : -1;

      renderNode(container, root, 0, [], rootData, selectedChildIndex);

      // Scroll the selected element into view
      const selectedLine = container.querySelector('.pi-outer-tree__line--selected');
      if (selectedLine) {
        setTimeout(() => selectedLine.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
      }
    } catch (err) {
      console.error('[DesInspect] Error building outer HTML tree:', err);
      container.textContent = outerHTML.substring(0, 500);
    }
  }

  /**
   * Recursively render a DOM node as an interactive tree line.
   * @param {HTMLElement} container - Where to append the rendered line
   * @param {Node} node - The parsed DOM node
   * @param {number} depth - Indentation depth
   * @param {number[]} indexPath - Path of child indices from root
   * @param {object} rootElementData - Root element data (for selector)
   * @param {number} selectedChildIndex - Index of selected child at depth 1 (-1 if none)
   */
  function renderNode(container, node, depth, indexPath, rootElementData, selectedChildIndex) {
    // Cap depth to avoid huge renders
    if (depth > 4) return;

    const indent = '  '.repeat(depth);

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (text) {
        const line = document.createElement('div');
        line.className = 'pi-outer-tree__line';
        line.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span><span class="pi-outer-tree__text">${escHtml(truncateText(text, 120))}</span>`;
        container.appendChild(line);
      }
      return;
    }

    if (node.nodeType === Node.COMMENT_NODE) {
      const line = document.createElement('div');
      line.className = 'pi-outer-tree__line';
      line.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span><span class="pi-outer-tree__comment">&lt;!-- ${escHtml(truncateText(node.textContent.trim(), 80))} --&gt;</span>`;
      container.appendChild(line);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    const hasChildren = node.childNodes.length > 0;
    const hasOnlyText = node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.TEXT_NODE;

    // Check if this node is the currently selected element
    const isSelected = (depth === 1 && indexPath.length === 1 && indexPath[0] === selectedChildIndex);

    // Build the opening tag HTML
    let openTag = `<span class="pi-outer-tree__tag">&lt;${escHtml(tag)}</span>`;

    // Attributes
    for (const attr of node.attributes) {
      openTag += `<span class="pi-outer-tree__attr"> ${escHtml(attr.name)}</span>`;
      if (attr.value) {
        openTag += `<span class="pi-outer-tree__attr">=</span><span class="pi-outer-tree__val">"${escHtml(truncateText(attr.value, 60))}"</span>`;
      }
    }
    openTag += `<span class="pi-outer-tree__tag">&gt;</span>`;

    // Create the line element
    const line = document.createElement('div');
    line.className = 'pi-outer-tree__line pi-outer-tree__line--element';
    if (isSelected) line.classList.add('pi-outer-tree__line--selected');
    line.dataset.indexPath = JSON.stringify(indexPath);

    // Hover → highlight element on page
    line.addEventListener('mouseenter', () => {
      chrome.runtime.sendMessage({
        type: 'HIGHLIGHT_BY_PATH',
        data: {
          rootSelector: rootElementData.selector,
          rootSelectorType: rootElementData.selectorType,
          indexPath,
        }
      });
      line.classList.add('pi-outer-tree__line--hover');
    });
    line.addEventListener('mouseleave', () => {
      chrome.runtime.sendMessage({
        type: 'HIGHLIGHT_BY_PATH',
        data: {
          rootSelector: rootElementData.selector,
          rootSelectorType: rootElementData.selectorType,
          indexPath: [], // root = parent element
        }
      });
      line.classList.remove('pi-outer-tree__line--hover');
    });

    // Click → select this element
    line.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({
        type: 'SELECT_BY_PATH',
        data: {
          rootSelector: rootElementData.selector,
          rootSelectorType: rootElementData.selectorType,
          indexPath,
        }
      });
    });

    if (hasOnlyText && node.textContent.trim().length < 80) {
      // Inline: <tag>text</tag> on one line
      const text = node.textContent.trim();
      line.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span>${openTag}<span class="pi-outer-tree__text">${escHtml(text)}</span><span class="pi-outer-tree__tag">&lt;/${escHtml(tag)}&gt;</span>`;
      container.appendChild(line);
    } else if (hasChildren) {
      const wrapper = document.createElement('div');
      wrapper.className = 'pi-outer-tree__group';

      line.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span><span class="pi-outer-tree__toggle">▼</span>${openTag}`;
      wrapper.appendChild(line);

      // Children container
      const childContainer = document.createElement('div');
      childContainer.className = 'pi-outer-tree__children';

      // Render children (cap at 30 element children)
      let childElementIndex = 0;
      let rendered = 0;
      for (const child of node.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (rendered < 30) {
            renderNode(childContainer, child, depth + 1, [...indexPath, childElementIndex], rootElementData, selectedChildIndex);
            rendered++;
          }
          childElementIndex++;
        } else if (rendered < 30) {
          renderNode(childContainer, child, depth + 1, indexPath, rootElementData, selectedChildIndex);
        }
      }

      if (childElementIndex > 30) {
        const more = document.createElement('div');
        more.className = 'pi-outer-tree__line';
        more.innerHTML = `<span class="pi-outer-tree__indent">${escHtml('  '.repeat(depth + 1))}</span><span class="pi-outer-tree__text" style="opacity:0.5">… ${childElementIndex - 30} more children</span>`;
        childContainer.appendChild(more);
      }

      wrapper.appendChild(childContainer);

      // Closing tag
      const closeLine = document.createElement('div');
      closeLine.className = 'pi-outer-tree__line';
      closeLine.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span><span class="pi-outer-tree__tag">&lt;/${escHtml(tag)}&gt;</span>`;
      wrapper.appendChild(closeLine);

      // Toggle collapse
      const toggleSpan = line.querySelector('.pi-outer-tree__toggle');
      toggleSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = childContainer.hidden;
        childContainer.hidden = !collapsed;
        toggleSpan.textContent = collapsed ? '▼' : '▶';
      });

      container.appendChild(wrapper);
    } else {
      // Self-closing or empty element
      line.innerHTML = `<span class="pi-outer-tree__indent">${escHtml(indent)}</span>${openTag}`;
      if (!isVoidElement(`<${tag}`)) {
        line.innerHTML += `<span class="pi-outer-tree__tag">&lt;/${escHtml(tag)}&gt;</span>`;
      }
      container.appendChild(line);
    }
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function truncateText(text, max) {
    return text.length > max ? text.substring(0, max) + '…' : text;
  }

  /**
   * Basic HTML formatter — adds newlines and indentation for readability.
   * Not a full pretty-printer, but enough to make innerHTML scannable.
   */
  function formatHTML(html) {
    if (!html || html.length < 80) return html;

    let formatted = '';
    let indent = 0;
    const tab = '  ';

    // Split on tags while preserving them
    const tokens = html.split(/(<\/?[^>]+>)/g).filter(Boolean);

    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('</')) {
        // Closing tag — decrease indent
        indent = Math.max(0, indent - 1);
        formatted += tab.repeat(indent) + trimmed + '\n';
      } else if (trimmed.startsWith('<') && !trimmed.startsWith('<!') &&
                 !trimmed.endsWith('/>') && !isVoidElement(trimmed)) {
        // Opening tag — add then increase indent
        formatted += tab.repeat(indent) + trimmed + '\n';
        indent++;
      } else if (trimmed.startsWith('<')) {
        // Self-closing, void, or comment — same indent
        formatted += tab.repeat(indent) + trimmed + '\n';
      } else {
        // Text content
        formatted += tab.repeat(indent) + trimmed + '\n';
      }
    }

    return formatted.trimEnd();
  }

  function isVoidElement(tag) {
    const voidTags = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                      'link', 'meta', 'param', 'source', 'track', 'wbr'];
    const match = tag.match(/^<(\w+)/);
    return match && voidTags.includes(match[1].toLowerCase());
  }

  // Track changes in the textarea
  els.htmlTextarea.addEventListener('input', () => {
    state.htmlDirty = true;
    updateLineNumbers();
    updateHTMLCharCount();
    setHTMLStatus('Modified', 'modified');
  });

  // Support Tab key for indentation inside the textarea
  els.htmlTextarea.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = els.htmlTextarea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;

      if (e.shiftKey) {
        // Shift+Tab: remove leading two spaces on selected lines
        const before = ta.value.substring(0, start);
        const selected = ta.value.substring(start, end);
        const after = ta.value.substring(end);
        const lines = selected.split('\n');
        const dedented = lines.map(line => line.startsWith('  ') ? line.substring(2) : line);
        ta.value = before + dedented.join('\n') + after;
        ta.selectionStart = start;
        ta.selectionEnd = start + dedented.join('\n').length;
      } else {
        // Tab: insert two spaces
        ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + 2;
      }

      state.htmlDirty = true;
      updateLineNumbers();
      updateHTMLCharCount();
      setHTMLStatus('Modified', 'modified');
    }

    // Cmd/Ctrl+Enter: apply HTML
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      applyHTMLEdit();
    }
  });

  // Sync scroll between gutter and textarea
  els.htmlTextarea.addEventListener('scroll', () => {
    els.htmlGutter.scrollTop = els.htmlTextarea.scrollTop;
  });

  // Apply HTML button
  els.btnHtmlApply.addEventListener('click', () => {
    applyHTMLEdit();
  });

  // Reset HTML button
  els.btnHtmlReset.addEventListener('click', () => {
    if (!state.htmlDirty && els.htmlTextarea.value === formatHTML(state.originalInnerHTML)) {
      showToast('Nothing to reset');
      return;
    }
    els.htmlTextarea.value = formatHTML(state.originalInnerHTML);
    state.htmlDirty = false;
    updateLineNumbers();
    updateHTMLCharCount();
    setHTMLStatus('Reset to original', 'applied');
    setTimeout(() => setHTMLStatus('', ''), 2000);
  });

  // Copy outer HTML
  els.btnOuterCopy.addEventListener('click', () => {
    if (state.selectedElement?.outerHTML) {
      copyToClipboard(state.selectedElement.outerHTML);
      showToast('Outer HTML copied');
    }
  });

  /**
   * Send the current HTML textarea content to the content script.
   */
  function applyHTMLEdit() {
    const newHTML = els.htmlTextarea.value;

    chrome.runtime.sendMessage({
      type: 'APPLY_HTML_EDIT',
      data: { html: newHTML }
    });

    state.htmlDirty = false;
    setHTMLStatus('Applied ✓', 'applied');
    showToast('HTML applied to page');
    setTimeout(() => setHTMLStatus('', ''), 2000);
  }

  function updateLineNumbers() {
    const lines = els.htmlTextarea.value.split('\n').length;
    let gutterHTML = '';
    for (let i = 1; i <= lines; i++) {
      gutterHTML += `<span>${i}</span>`;
    }
    els.htmlGutter.innerHTML = gutterHTML;
  }

  function updateHTMLCharCount() {
    const len = els.htmlTextarea.value.length;
    els.htmlCharCount.textContent = `${len.toLocaleString()} char${len !== 1 ? 's' : ''}`;
  }

  function setHTMLStatus(text, type) {
    els.htmlStatus.textContent = text;
    els.htmlStatus.className = 'pi-html-info__status';
    if (type) {
      els.htmlStatus.classList.add(`pi-html-info__status--${type}`);
    }
  }

  // ─── Styles Editor (textarea-based, reliable) ─────────────────────────

  /**
   * Render the CSS styles panel.
   * Uses textareas for editing — simple, reliable, no contentEditable bugs.
   */
  function renderDevToolsStyles(data) {
    const container = els.dtStyles;
    if (!container) return;
    container.innerHTML = '';

    // ── 1. element.style block — editable textarea ──────────────────
    const inlineSection = document.createElement('div');
    inlineSection.className = 'dt-rule';

    const inlineHeader = document.createElement('div');
    inlineHeader.className = 'dt-rule__head';
    inlineHeader.innerHTML = '<span class="dt-rule__sel dt-rule__sel--inline">element.style</span> <span class="dt-rule__brace">{</span>';
    inlineSection.appendChild(inlineHeader);

    const inlineTA = document.createElement('textarea');
    inlineTA.className = 'dt-rule__editor';
    inlineTA.spellcheck = false;
    inlineTA.placeholder = '  /* click here to add styles */\n  color: red;\n  padding: 10px;';

    // Populate with current inline styles
    const inlineStyles = data.inlineStyles || {};
    const inlineText = Object.entries(inlineStyles)
      .map(([p, v]) => `  ${p}: ${v};`)
      .join('\n');
    inlineTA.value = inlineText;

    // Apply on every change (debounced)
    let inlineTimer = null;
    inlineTA.addEventListener('input', () => {
      clearTimeout(inlineTimer);
      inlineTimer = setTimeout(() => {
        applyInlineFromTextarea(inlineTA.value);
      }, 300);
    });

    // Auto-resize textarea
    const autoResize = (ta) => {
      ta.style.height = 'auto';
      ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
    };
    inlineTA.addEventListener('input', () => autoResize(inlineTA));

    inlineSection.appendChild(inlineTA);

    const inlineClose = document.createElement('div');
    inlineClose.className = 'dt-rule__close';
    inlineClose.textContent = '}';
    inlineSection.appendChild(inlineClose);

    container.appendChild(inlineSection);

    // Auto-resize after render
    requestAnimationFrame(() => autoResize(inlineTA));

    // ── 2. Matched CSS rules — read-only with edit button ───────────
    const rules = data.matchedRules || [];
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i];
      const ruleBlock = createMatchedRuleBlock(rule);
      container.appendChild(ruleBlock);
    }

    // ── 3. Key computed styles — collapsible ────────────────────────
    if (data.computedStyles) {
      const compBlock = createComputedBlock(data.computedStyles);
      container.appendChild(compBlock);
    }

    // Apply filter if active
    const fv = els.dtFilter ? els.dtFilter.value.trim() : '';
    if (fv) dtApplyFilter(fv);
  }

  /**
   * Parse textarea CSS text and apply as inline styles on the selected element.
   * Sends one message per property. Clears properties that were removed.
   */
  function applyInlineFromTextarea(text) {
    console.log("[DesInspect Panel] applyInlineFromTextarea called, text length:", text.length);
    // Parse "property: value;" lines
    const newProps = {};
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx < 1) continue;
      const prop = trimmed.substring(0, colonIdx).trim();
      let val = trimmed.substring(colonIdx + 1).trim();
      if (val.endsWith(';')) val = val.slice(0, -1).trim();
      if (prop && val) newProps[prop] = val;
    }

    // Apply each property
    for (const [p, v] of Object.entries(newProps)) {
      sendCSSEdit(p, v);
    }

    // Clear properties that are no longer in the textarea
    // (compare against state.lastInlineProps)
    if (state.lastInlineProps) {
      for (const oldProp of Object.keys(state.lastInlineProps)) {
        if (!(oldProp in newProps)) {
          sendCSSEdit(oldProp, '');
        }
      }
    }
    state.lastInlineProps = newProps;
  }

  /**
   * Create a single editable property line using <input> elements.
   * Works for matched rules, computed styles, etc.
   * @param {string} prop - CSS property name
   * @param {string} val - CSS value
   * @param {string} selector - Rule selector (for rule-level edits) or null for inline
   * @param {boolean} isReadOnly - If true, values can't be edited (just displayed)
   */
  function createPropLine(prop, val, selector, isReadOnly) {
    const line = document.createElement('div');
    line.className = 'dt-prop';
    line.dataset.prop = prop;

    // Checkbox — toggles property on/off
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.className = 'dt-prop__cb';
    line.appendChild(cb);

    // Color swatch + picker (if value is a color)
    if (isColorValue(val)) {
      const swatchWrap = document.createElement('span');
      swatchWrap.className = 'dt-prop__swatch-wrap';

      const swatch = document.createElement('span');
      swatch.className = 'dt-prop__swatch';
      swatch.style.backgroundColor = val;

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.className = 'dt-prop__picker';
      try { picker.value = rgbToHex(val); } catch { picker.value = '#000000'; }

      swatch.addEventListener('click', (e) => {
        e.stopPropagation();
        picker.click();
      });

      picker.addEventListener('input', () => {
        const hex = picker.value;
        valInput.value = hex;
        swatch.style.backgroundColor = hex;
        if (selector) {
          sendRuleEdit(selector, prop, hex);
        } else {
          sendCSSEdit(prop, hex);
        }
      });

      swatchWrap.appendChild(swatch);
      swatchWrap.appendChild(picker);
      line.appendChild(swatchWrap);
    }

    // Property name (static text)
    const nameEl = document.createElement('span');
    nameEl.className = 'dt-prop__name';
    nameEl.textContent = prop;
    line.appendChild(nameEl);

    // Separator
    const sep = document.createElement('span');
    sep.className = 'dt-prop__sep';
    sep.textContent = ': ';
    line.appendChild(sep);

    // Value input
    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.className = 'dt-prop__val-input';
    valInput.value = val;
    valInput.spellcheck = false;
    if (isReadOnly) valInput.readOnly = true;
    line.appendChild(valInput);

    // Semicolon
    const semi = document.createElement('span');
    semi.className = 'dt-prop__semi';
    semi.textContent = ';';
    line.appendChild(semi);

    // ── Value editing ──
    if (!isReadOnly) {
      const applyValue = () => {
        const v = valInput.value.trim();
        if (!v) return;
        if (selector) {
          sendRuleEdit(selector, prop, v);
        } else {
          sendCSSEdit(prop, v);
        }
        // Update swatch if color
        const sw = line.querySelector('.dt-prop__swatch');
        if (sw) {
          if (isColorValue(v)) {
            sw.style.backgroundColor = v;
            const pk = line.querySelector('.dt-prop__picker');
            if (pk) try { pk.value = rgbToHex(v); } catch {}
          }
        }
      };

      valInput.addEventListener('change', applyValue);
      valInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { valInput.blur(); }
        // Arrow up/down for numbers
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const text = valInput.value.trim();
          const numMatch = text.match(/^(-?\d+(?:\.\d+)?)(.*)/);
          if (numMatch) {
            e.preventDefault();
            const delta = e.shiftKey ? 10 : (e.altKey ? 0.1 : 1);
            const newNum = parseFloat(numMatch[1]) + (e.key === 'ArrowUp' ? delta : -delta);
            valInput.value = (Math.round(newNum * 10) / 10) + numMatch[2];
            applyValue();
          }
        }
      });
    }

    // ── Checkbox toggle ──
    cb.addEventListener('change', () => {
      if (!cb.checked) {
        line.classList.add('dt-prop--disabled');
        if (selector) {
          // Add override: property: unset !important (overrides the stylesheet rule)
          sendRuleEdit(selector, prop, 'unset');
        } else {
          // Remove inline style
          sendCSSEdit(prop, '');
        }
      } else {
        line.classList.remove('dt-prop--disabled');
        if (selector) {
          // Remove the unset override so original stylesheet value comes back
          sendRuleEdit(selector, prop, '');
        } else {
          // Re-apply inline style
          const v = valInput.value.trim();
          if (v) sendCSSEdit(prop, v);
        }
      }
    });

    return line;
  }

  /**
   * Create a matched rule block with editable property lines.
   */
  function createMatchedRuleBlock(rule) {
    const block = document.createElement('div');
    block.className = 'dt-rule';
    block.dataset.selector = rule.selector;

    // Header
    const header = document.createElement('div');
    header.className = 'dt-rule__head';

    const selSpan = document.createElement('span');
    selSpan.className = 'dt-rule__sel';
    selSpan.textContent = rule.selector;

    const braceSpan = document.createElement('span');
    braceSpan.className = 'dt-rule__brace';
    braceSpan.textContent = ' {';

    const srcSpan = document.createElement('span');
    srcSpan.className = 'dt-rule__src';
    srcSpan.textContent = rule.source || '';

    header.appendChild(selSpan);
    header.appendChild(braceSpan);
    header.appendChild(srcSpan);
    block.appendChild(header);

    // Property lines
    const propsDiv = document.createElement('div');
    propsDiv.className = 'dt-rule__props';

    for (const [prop, val] of Object.entries(rule.properties || {})) {
      const line = createPropLine(prop, val, rule.selector, false);
      propsDiv.appendChild(line);
    }

    // Add property row
    const addRow = document.createElement('div');
    addRow.className = 'dt-rule__add-row';

    const addName = document.createElement('input');
    addName.type = 'text';
    addName.className = 'dt-rule__add-input';
    addName.placeholder = 'property';
    addName.spellcheck = false;

    const addSep = document.createElement('span');
    addSep.className = 'dt-prop__sep';
    addSep.textContent = ': ';

    const addVal = document.createElement('input');
    addVal.type = 'text';
    addVal.className = 'dt-rule__add-input';
    addVal.placeholder = 'value';
    addVal.spellcheck = false;

    addName.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); addVal.focus(); }
      if (e.key === 'Enter') { addVal.focus(); }
    });

    addVal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const p = addName.value.trim();
        const v = addVal.value.trim();
        if (p && v) {
          sendRuleEdit(rule.selector, p, v);
          // Add as a real prop line
          const newLine = createPropLine(p, v, rule.selector, false);
          propsDiv.insertBefore(newLine, addRow);
          addName.value = '';
          addVal.value = '';
          addName.focus();
        }
      }
    });

    addRow.appendChild(addName);
    addRow.appendChild(addSep);
    addRow.appendChild(addVal);
    propsDiv.appendChild(addRow);

    block.appendChild(propsDiv);

    // Close brace
    const closeDiv = document.createElement('div');
    closeDiv.className = 'dt-rule__close';
    closeDiv.textContent = '}';
    block.appendChild(closeDiv);

    return block;
  }

  /**
   * Create collapsible computed styles block with editable property lines.
   */
  function createComputedBlock(computedStyles) {
    const important = [
      'display','position','top','right','bottom','left','z-index',
      'width','height','min-width','max-width','min-height','max-height',
      'margin-top','margin-right','margin-bottom','margin-left',
      'padding-top','padding-right','padding-bottom','padding-left',
      'border','border-radius','box-sizing','overflow',
      'color','background-color','background',
      'font-family','font-size','font-weight','font-style',
      'line-height','letter-spacing','text-align','text-decoration','text-transform',
      'opacity','visibility','cursor','box-shadow','transition','transform',
      'flex-direction','flex-wrap','justify-content','align-items','gap',
    ];

    const block = document.createElement('div');
    block.className = 'dt-rule dt-rule--computed';

    const header = document.createElement('div');
    header.className = 'dt-rule__head dt-rule__head--toggle';

    const arrow = document.createElement('span');
    arrow.className = 'dt-rule__arrow';
    arrow.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'dt-rule__sel dt-rule__sel--computed';
    label.textContent = ' Computed Styles';

    header.appendChild(arrow);
    header.appendChild(label);
    block.appendChild(header);

    const propsDiv = document.createElement('div');
    propsDiv.className = 'dt-rule__props';
    propsDiv.hidden = true;

    for (const prop of important) {
      const val = computedStyles[prop];
      if (!val) continue;
      // Computed props edit via inline style override
      const line = createPropLine(prop, val, null, false);
      propsDiv.appendChild(line);
    }

    block.appendChild(propsDiv);

    header.style.cursor = 'pointer';
    header.addEventListener('click', () => {
      propsDiv.hidden = !propsDiv.hidden;
      arrow.textContent = propsDiv.hidden ? '▶' : '▼';
    });

    return block;
  }

  /**
   * Color check helper.
   */
  function isColorValue(val) {
    if (!val || typeof val !== 'string') return false;
    const v = val.trim().toLowerCase();
    if (v.startsWith('#') || v.startsWith('rgb') || v.startsWith('hsl')) return true;
    const named = ['red','blue','green','white','black','orange','yellow','purple','pink',
      'gray','grey','cyan','magenta','transparent','currentcolor'];
    return named.includes(v);
  }

  /**
   * Filter styles panel.
   */
  function dtApplyFilter(text) {
    const f = text.toLowerCase();
    const rules = els.dtStyles.querySelectorAll('.dt-rule');
    rules.forEach(rule => {
      const allText = rule.textContent.toLowerCase();
      rule.style.display = (!f || allText.includes(f)) ? '' : 'none';
    });
  }

  /**
   * Render class toggle list.
   */
  function renderDevToolsClasses(data) {
    if (!els.dtClsList) return;
    els.dtClsList.innerHTML = '';
    const classes = data.classList || [];
    for (const cls of classes) {
      const row = document.createElement('label');
      row.className = 'dt-cls-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.addEventListener('change', () => {
        chrome.runtime.sendMessage({
          type: 'TOGGLE_CLASS',
          data: { className: cls, enabled: cb.checked }
        });
        row.classList.toggle('dt-cls-item--off', !cb.checked);
      });
      const name = document.createElement('span');
      name.textContent = cls;
      row.appendChild(cb);
      row.appendChild(name);
      els.dtClsList.appendChild(row);
    }
  }

  // ── Toolbar handlers ────────────────────────────────────────────────────

  if (els.dtFilter) {
    els.dtFilter.addEventListener('input', () => {
      dtApplyFilter(els.dtFilter.value);
    });
  }

  if (els.dtClsToggle) {
    els.dtClsToggle.addEventListener('click', () => {
      if (els.dtClsPanel) {
        els.dtClsPanel.hidden = !els.dtClsPanel.hidden;
        els.dtClsToggle.classList.toggle('dt-tool-btn--active', !els.dtClsPanel.hidden);
      }
    });
  }

  if (els.dtClsInput) {
    els.dtClsInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const cls = els.dtClsInput.value.trim().replace(/^\./, '');
        if (cls) {
          chrome.runtime.sendMessage({
            type: 'ADD_CLASS',
            data: { className: cls }
          });
          els.dtClsInput.value = '';
          showToast(`Added .${cls}`);
          setTimeout(() => {
            chrome.runtime.sendMessage({ type: 'RESELECT_ELEMENT' });
          }, 100);
        }
      }
    });
  }

  if (els.dtAddRule) {
    els.dtAddRule.addEventListener('click', () => {
      // Prompt for selector, create override textarea
      const sel = prompt('CSS Selector:', state.selectedElement?.selector || '.my-class');
      if (!sel) return;

      const block = document.createElement('div');
      block.className = 'dt-rule';

      const header = document.createElement('div');
      header.className = 'dt-rule__head';
      header.innerHTML = `<span class="dt-rule__sel">${escapeHTML(sel)}</span> <span class="dt-rule__brace">{</span><span class="dt-rule__src">new rule</span>`;
      block.appendChild(header);

      const ta = document.createElement('textarea');
      ta.className = 'dt-rule__editor dt-rule__editor--override';
      ta.spellcheck = false;
      ta.placeholder = '  property: value;';
      ta.value = '  ';

      let timer = null;
      ta.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          applyRuleOverrideFromTextarea(sel, ta.value, {});
        }, 400);
        ta.style.height = 'auto';
        ta.style.height = Math.max(ta.scrollHeight, 24) + 'px';
      });
      block.appendChild(ta);

      const close = document.createElement('div');
      close.className = 'dt-rule__close';
      close.textContent = '}';
      block.appendChild(close);

      // Insert after element.style
      const first = els.dtStyles.querySelector('.dt-rule');
      if (first && first.nextSibling) {
        els.dtStyles.insertBefore(block, first.nextSibling);
      } else {
        els.dtStyles.appendChild(block);
      }

      requestAnimationFrame(() => ta.focus());
    });
  }


  // ─── Changes Panel ──────────────────────────────────────────────────────

  function renderChanges(changes) {
    state.changes = changes;
    updateAuditButtons();

    if (!changes || changes.length === 0) {
      els.changesEmpty.hidden = false;
      els.changesList.hidden = true;
      els.changesActions.hidden = true;
      els.changesCount.hidden = true;
      return;
    }

    els.changesEmpty.hidden = true;
    els.changesList.hidden = false;
    els.changesActions.hidden = false;
    els.changesCount.hidden = false;
    els.changesCount.textContent = changes.length;

    els.changesList.innerHTML = '';

    for (const change of changes) {
      const item = document.createElement('div');
      item.className = 'pi-change-item';
      item.style.cursor = 'pointer';

      // Clicking anywhere on the change item focuses the correct tab
      // and highlights the element (unless user clicked a button)
      item.addEventListener('click', (e) => {
        if (e.target.closest('button')) return; // Let button handlers fire instead
        chrome.runtime.sendMessage({
          type: 'SELECT_ELEMENT',
          data: {
            selector: change.selector,
            selectorType: change.selectorType,
            urlPattern: change.urlPattern || null
          }
        });
      });

      const timeStr = new Date(change.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });

      const isHTML = change.property === '__html__';
      const propLabel = isHTML ? 'innerHTML' : change.property;
      const oldVal = change.originalValue || '';
      const newVal = change.value || '';

      // Truncated values for the summary line
      const oldShort = oldVal.length > 40 ? oldVal.substring(0, 40) + '…' : oldVal;
      const newShort = newVal.length > 40 ? newVal.substring(0, 40) + '…' : newVal;

      // Header row
      const header = document.createElement('div');
      header.className = 'pi-change-item__header';
      header.innerHTML = `
        <span class="pi-change-item__element">${escapeHTML(change.elementDescription)}</span>
        <span class="pi-change-item__time">${timeStr}</span>
      `;
      item.appendChild(header);

      // Inline diff view (always visible)
      const diff = document.createElement('div');
      diff.className = 'pi-change-item__diff';

      // Old value row
      const oldRow = document.createElement('div');
      oldRow.className = 'pi-change-item__diff-row pi-change-item__diff-row--old';
      oldRow.innerHTML = `
        <span class="pi-change-item__diff-prefix">−</span>
        <code class="pi-change-item__diff-value">${escapeHTML(propLabel)}: ${escapeHTML(oldShort) || '<em style="opacity:0.5">(empty)</em>'}</code>
      `;

      // New value row
      const newRow = document.createElement('div');
      newRow.className = 'pi-change-item__diff-row pi-change-item__diff-row--new';
      newRow.innerHTML = `
        <span class="pi-change-item__diff-prefix">+</span>
        <code class="pi-change-item__diff-value">${escapeHTML(propLabel)}: ${escapeHTML(newShort)}</code>
      `;

      diff.appendChild(oldRow);
      diff.appendChild(newRow);
      item.appendChild(diff);

      // Actions row
      const actions = document.createElement('div');
      actions.className = 'pi-change-item__actions';

      // Edit button — selects element and switches to Editor tab
      const editBtn = document.createElement('button');
      editBtn.className = 'pi-btn pi-btn--small pi-btn--primary';
      editBtn.textContent = '✎ Edit';
      editBtn.addEventListener('click', () => {
        // Select the element on the page
        chrome.runtime.sendMessage({
          type: 'SELECT_ELEMENT',
          data: {
            selector: change.selector,
            selectorType: change.selectorType,
            urlPattern: change.urlPattern || null
          }
        });
        // Switch to the Editor tab
        switchToTab('editor');
      });

      // Preview toggle button
      const previewBtn = document.createElement('button');
      previewBtn.className = 'pi-btn pi-btn--small';
      previewBtn.textContent = '👁 Preview Original';
      previewBtn.dataset.role = 'preview';
      let previewing = false;
      previewBtn.addEventListener('click', () => {
        previewing = !previewing;
        chrome.runtime.sendMessage({
          type: 'PREVIEW_CHANGE',
          data: {
            changeId: change.id,
            showOriginal: previewing
          }
        });
        previewBtn.textContent = previewing ? '👁 Preview Modified' : '👁 Preview Original';
        previewBtn.classList.toggle('pi-btn--preview-active', previewing);
      });

      // Revert button
      const revertBtn = document.createElement('button');
      revertBtn.className = 'pi-btn pi-btn--small pi-btn--danger';
      revertBtn.textContent = 'Revert';
      revertBtn.dataset.role = 'revert';

      // Re-apply button (hidden by default)
      const reapplyBtn = document.createElement('button');
      reapplyBtn.className = 'pi-btn pi-btn--small pi-btn--primary';
      reapplyBtn.textContent = '↻ Re-apply';
      reapplyBtn.hidden = true;
      reapplyBtn.dataset.role = 'reapply';

      revertBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'REVERT_CHANGE',
          data: { changeId: change.id }
        });
        // Dim the item instead of removing
        item.classList.add('pi-change-item--reverted');
        revertBtn.hidden = true;
        reapplyBtn.hidden = false;
        previewBtn.hidden = true;
        showToast('Change reverted');
      });

      reapplyBtn.addEventListener('click', () => {
        // Re-apply the CSS or HTML change
        if (isHTML) {
          chrome.runtime.sendMessage({
            type: 'REAPPLY_CHANGE',
            data: {
              selector: change.selector,
              selectorType: change.selectorType,
              property: change.property,
              value: change.value,
            }
          });
        } else {
          chrome.runtime.sendMessage({
            type: 'REAPPLY_CHANGE',
            data: {
              selector: change.selector,
              selectorType: change.selectorType,
              property: change.property,
              value: change.value,
            }
          });
        }
        // Restore active look
        item.classList.remove('pi-change-item--reverted');
        revertBtn.hidden = false;
        reapplyBtn.hidden = true;
        previewBtn.hidden = false;
        showToast('Change re-applied');
      });

      actions.appendChild(editBtn);
      actions.appendChild(previewBtn);
      actions.appendChild(revertBtn);
      actions.appendChild(reapplyBtn);
      item.appendChild(actions);

      els.changesList.appendChild(item);
    }
  }

  // Export handlers
  els.btnExportCSS.addEventListener('click', () => {
    const css = generateCSSDiff(state.changes);
    copyToClipboard(css);
    showToast('CSS diff copied to clipboard');
  });

  els.btnExportJSON.addEventListener('click', () => {
    const json = JSON.stringify(state.changes, null, 2);
    downloadAsFile('desinspect-changes.json', json, 'application/json');
    showToast('JSON exported');
  });

  els.btnRevertAll.addEventListener('click', () => {
    if (confirm('Revert all changes on this page?')) {
      chrome.runtime.sendMessage({ type: 'REVERT_ALL' });
      // Dim all change items like individual reverts
      els.changesList.querySelectorAll('.pi-change-item:not(.pi-change-item--reverted)').forEach(item => {
        item.classList.add('pi-change-item--reverted');
        const revertBtn = item.querySelector('[data-role="revert"]');
        const reapplyBtn = item.querySelector('[data-role="reapply"]');
        const previewBtn = item.querySelector('[data-role="preview"]');
        if (revertBtn) revertBtn.hidden = true;
        if (reapplyBtn) reapplyBtn.hidden = false;
        if (previewBtn) previewBtn.hidden = true;
      });
      showToast('All changes reverted');
    }
  });

  // Diff mode: toggle all changes between original ↔ modified on the page
  els.btnDiffToggle.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_DIFF_MODE' });
  });

  els.btnEditorDiff.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_DIFF_MODE' });
  });

  // ─── History Panel ──────────────────────────────────────────────────────

  function renderHistory(history) {
    state.history = history;

    if (!history || history.length === 0) {
      els.historyEmpty.hidden = false;
      els.historyList.hidden = true;
      return;
    }

    els.historyEmpty.hidden = true;
    els.historyList.hidden = false;
    els.historyList.innerHTML = '';

    for (const entry of history) {
      const item = document.createElement('div');

      const timeStr = new Date(entry.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });

      if (entry._type === 'snapshot') {
        // Snapshot entry
        item.className = 'pi-history-item pi-history-item--snapshot';
        const changeCount = entry.changes?.length || 0;

        item.innerHTML = `
          <span class="pi-history-item__time">${timeStr}</span>
          <span class="pi-history-item__desc">
            📸 <strong>${escapeHTML(entry.name)}</strong>
            <span class="pi-history-item__meta">${changeCount} change${changeCount !== 1 ? 's' : ''}</span>
          </span>
        `;

        const restoreBtn = document.createElement('button');
        restoreBtn.className = 'pi-btn pi-btn--small pi-btn--primary';
        restoreBtn.textContent = '↻ Restore';
        restoreBtn.addEventListener('click', () => {
          if (confirm(`Restore snapshot "${entry.name}"? This will revert current changes and apply the snapshot.`)) {
            chrome.runtime.sendMessage({
              type: 'RESTORE_SNAPSHOT',
              data: { changes: entry.changes }
            });
            showToast(`Restored: ${entry.name}`);
          }
        });
        item.appendChild(restoreBtn);
      } else {
        // Regular history entry
        item.className = 'pi-history-item';
        item.innerHTML = `
          <span class="pi-history-item__time">${timeStr}</span>
          <span class="pi-history-item__desc">
            <code>${escapeHTML(entry.property || '')}</code> → ${escapeHTML(entry.value?.substring(0, 30) || '')}
          </span>
        `;
      }

      els.historyList.appendChild(item);
    }
  }

  // ─── Message Handling ───────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {

      case 'ELEMENT_SELECTED':
        handleElementSelected(message.data);
        break;

      case 'INSPECTOR_STATE':
        updateInspectorState(message.data);
        break;

      case 'CHANGE_RECORDED':
        // A change was just saved — refresh after debounce settles (500ms save delay)
        clearTimeout(state._changesRefreshTimer);
        state._changesRefreshTimer = setTimeout(() => {
          requestChanges();
        }, 650);
        break;

      case 'CHANGES_LOADED':
        if (message.data?.changes) {
          renderChanges(message.data.changes);
        }
        break;

      case 'HISTORY_LOADED':
        if (message.data?.history) {
          renderHistory(message.data.history);
        }
        break;

      case 'ALL_CHANGES_REVERTED':
        // Dim all change items
        els.changesList.querySelectorAll('.pi-change-item:not(.pi-change-item--reverted)').forEach(item => {
          item.classList.add('pi-change-item--reverted');
          const revertBtn = item.querySelector('[data-role="revert"]');
          const reapplyBtn = item.querySelector('[data-role="reapply"]');
          const previewBtn = item.querySelector('[data-role="preview"]');
          if (revertBtn) revertBtn.hidden = true;
          if (reapplyBtn) reapplyBtn.hidden = false;
          if (previewBtn) previewBtn.hidden = true;
        });
        break;

      case 'SNAPSHOT_CREATED':
        showToast('Snapshot saved');
        break;

      case 'SNAPSHOT_RESTORED':
        showToast(`Snapshot restored (${message.data?.count || 0} changes)`);
        // Refresh changes list after re-apply settles
        setTimeout(() => requestChanges(), 500);
        break;

      case 'DIFF_MODE_STATE':
        state.diffMode = message.data.active;
        // Sync the Changes panel toggle
        els.btnDiffToggle.textContent = state.diffMode ? '⟲ Show Modified' : 'Show Original';
        els.btnDiffToggle.classList.toggle('pi-btn--diff-active', state.diffMode);
        // Sync the Editor panel toggle
        els.btnEditorDiff.classList.toggle('pi-btn--diff-active', state.diffMode);
        els.btnEditorDiff.innerHTML = state.diffMode
          ? '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-1px"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg> Original'
          : '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-1px"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg> Diff';
        break;

      case 'ELEMENT_DELETED':
        // Element was removed via Delete key — clear editor, update changes list
        state.selectedElement = null;
        els.editorEmpty.hidden = false;
        els.editorContent.hidden = true;
        els.copilotInput.disabled = true;
        els.btnCopilotSend.disabled = true;
        els.copilotResults.hidden = true;
        els.copilotError.hidden = true;
        els.statusText.textContent = 'Element deleted.';
        showToast('Element deleted (Ctrl+Z to undo)');
        chrome.runtime.sendMessage({ type: 'HIDE_PERSISTENT_HIGHLIGHT' });
        // Refresh changes list
        chrome.runtime.sendMessage({ type: 'GET_CHANGES' });
        break;

      case 'SPA_NAVIGATION':
        // SPA route changed — reset the editor and request fresh data
        state.selectedElement = null;
        state.diffMode = false;
        els.editorEmpty.hidden = false;
        els.editorContent.hidden = true;
        els.copilotInput.disabled = true;
        els.btnCopilotSend.disabled = true;
        els.copilotResults.hidden = true;
        els.copilotError.hidden = true;
        els.statusText.textContent = 'Page navigated. Inspector still active.';
        // Reset diff button states
        els.btnDiffToggle.textContent = 'Show Original';
        els.btnDiffToggle.classList.remove('pi-btn--diff-active');
        els.btnEditorDiff.classList.remove('pi-btn--diff-active');
        els.btnEditorDiff.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none" style="vertical-align:-1px"><rect x="1" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/><rect x="8" y="1" width="5" height="12" rx="1" stroke="currentColor" stroke-width="1.5" fill="none"/></svg> Diff';
        // Request changes for the new URL
        chrome.runtime.sendMessage({ type: 'GET_CHANGES' });
        chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
        showToast(`Navigated: ${message.data.newUrl.split('/').pop() || '/'}`);
        break;

      case 'UNDO_STATE':
        els.btnUndo.disabled = !message.data.canUndo;
        els.btnRedo.disabled = !message.data.canRedo;
        els.btnUndo.title = message.data.canUndo
          ? `Undo (${message.data.undoCount}) · Ctrl+Z`
          : 'Nothing to undo';
        els.btnRedo.title = message.data.canRedo
          ? `Redo (${message.data.redoCount}) · Ctrl+Shift+Z`
          : 'Nothing to redo';
        break;

      case 'UNDO_PERFORMED':
        showToast('Undone');
        // Refresh changes list after DB updates
        clearTimeout(state._changesRefreshTimer);
        state._changesRefreshTimer = setTimeout(() => requestChanges(), 100);
        break;

      case 'REDO_PERFORMED':
        showToast('Redone');
        clearTimeout(state._changesRefreshTimer);
        state._changesRefreshTimer = setTimeout(() => requestChanges(), 100);
        break;

      case 'PAGE_DATA':
        if (state._pendingPageAudit && message.data) {
          state._pendingPageAudit = false;
          runPageAudit(message.data);
        }
        break;
    }
  });

  function handleElementSelected(data) {
    state.selectedElement = data;
    state.originalInnerHTML = data.innerHTML || '';
    state.htmlDirty = false;

    // Show editor, hide empty prompt
    els.editorEmpty.hidden = true;
    els.editorContent.hidden = false;
    els.btnSnapshot.disabled = false;

    // Element header: tag pill + selector
    els.elementTagPill.textContent = data.description;
    els.elementSelector.textContent = data.selector;
    if (data.selectorWarning) {
      const tipEl = els.selectorWarning.querySelector('.pi-selector-warning-icon__tip');
      if (tipEl) tipEl.textContent = data.selectorWarning;
      els.selectorWarning.hidden = false;
    } else {
      els.selectorWarning.hidden = true;
    }

    // Box model diagram
    populateBoxModel(data);

    // Render DOM navigator tree
    renderDOMNavigator(data);

    // Render DevTools Styles panel
    renderDevToolsStyles(data);
    renderDevToolsClasses(data);

    // Populate HTML editor if in HTML mode
    if (state.editorMode === 'html') {
      populateHTMLEditor(data);
      // Show persistent highlight for the newly selected element
      chrome.runtime.sendMessage({
        type: 'SHOW_PERSISTENT_HIGHLIGHT',
        data: { selector: data.selector, selectorType: data.selectorType }
      });
    }

    // Update status
    setStatus(`Selected: ${data.description}`, true);

    // Update audit panel buttons
    updateAuditButtons();

    // Enable copilot input
    els.copilotInput.disabled = false;
    els.btnCopilotSend.disabled = false;
    // Clear previous copilot results
    els.copilotResults.hidden = true;
    els.copilotError.hidden = true;
    els.copilotResults.innerHTML = '';
  }

  // ─── Box Model ────────────────────────────────────────────────────────

  /**
   * Populate the Chrome-style box model diagram from computed styles.
   */
  function populateBoxModel(data) {
    const cs = data.computedStyles || {};
    const rect = data.boundingRect || {};

    // Helper: parse px value to number, show "0" or the integer
    function px(val) {
      if (!val) return '0';
      const n = parseFloat(val);
      if (isNaN(n)) return '0';
      return n === 0 ? '0' : Math.round(n).toString();
    }

    // Helper: set value + highlight non-zero
    function setVal(el, val) {
      const v = px(val);
      el.textContent = v;
      el.classList.toggle('pi-boxmodel__val--nonzero', v !== '0');
    }

    // Margin
    setVal(els.bmMarginTop, cs['margin-top']);
    setVal(els.bmMarginRight, cs['margin-right']);
    setVal(els.bmMarginBottom, cs['margin-bottom']);
    setVal(els.bmMarginLeft, cs['margin-left']);

    // Border
    setVal(els.bmBorderTop, cs['border-top-width']);
    setVal(els.bmBorderRight, cs['border-right-width']);
    setVal(els.bmBorderBottom, cs['border-bottom-width']);
    setVal(els.bmBorderLeft, cs['border-left-width']);

    // Padding
    setVal(els.bmPaddingTop, cs['padding-top']);
    setVal(els.bmPaddingRight, cs['padding-right']);
    setVal(els.bmPaddingBottom, cs['padding-bottom']);
    setVal(els.bmPaddingLeft, cs['padding-left']);

    // Content size (from bounding rect minus padding and border)
    const w = Math.round(rect.width || 0);
    const h = Math.round(rect.height || 0);
    els.bmContentSize.textContent = `${w} × ${h}`;

    // Position info
    const pos = cs['position'] || 'static';
    const parts = [`position: ${pos}`];
    if (pos !== 'static') {
      if (cs['top'] && cs['top'] !== 'auto') parts.push(`top: ${px(cs['top'])}`);
      if (cs['left'] && cs['left'] !== 'auto') parts.push(`left: ${px(cs['left'])}`);
      if (cs['right'] && cs['right'] !== 'auto') parts.push(`right: ${px(cs['right'])}`);
      if (cs['bottom'] && cs['bottom'] !== 'auto') parts.push(`bottom: ${px(cs['bottom'])}`);
    }
    if (cs['display']) parts.push(`display: ${cs['display']}`);
    els.bmPositionText.textContent = parts.join('  ·  ');
  }

  // ─── DOM Navigator ──────────────────────────────────────────────────────

  /**
   * Render the full DOM tree view:
   * - Ancestors (each as a row, indented, with siblings expandable)
   * - Selected element (highlighted)
   * - Children of selected element
   * 
   * This gives a DevTools-like tree where you can see exactly where
   * you are and click any level to re-select.
   */
  function renderDOMNavigator(data) {
    els.domTree.innerHTML = '';

    const ancestors = data.ancestors || [];
    const children = data.children || [];
    const siblings = data.siblings || [];

    // ── Render ancestor rows ──
    // Each ancestor is shown at its indent level.
    // We show siblings at each level collapsed behind a toggle.
    ancestors.forEach((ancestor, depth) => {
      const hasSiblings = ancestor.siblings && ancestor.siblings.length > 1;

      // If this ancestor has siblings, show them as a collapsible group
      if (hasSiblings) {
        renderSiblingGroup(ancestor.siblings, depth, ancestor);
      } else {
        // Single node at this level — just render it
        renderNode({
          tagName: ancestor.tagName,
          description: ancestor.description,
          selector: ancestor.selector,
          selectorType: ancestor.selectorType,
          childCount: ancestor.childCount,
        }, depth, 'ancestor');
      }
    });

    // ── Render selected element's sibling context ──
    // Show siblings of the selected element (the selected one is marked)
    const selectedDepth = ancestors.length;

    if (siblings.length > 1) {
      // Multiple siblings — render them all, with the selected one highlighted
      siblings.forEach((sib) => {
        if (sib.type === 'ellipsis') {
          renderEllipsis(sib.count, selectedDepth);
          return;
        }
        if (sib.isSelf) {
          // This is the selected element
          renderNode({
            tagName: data.tagName,
            description: data.description,
            selector: data.selector,
            selectorType: data.selectorType,
            childCount: data.childCount,
          }, selectedDepth, 'selected');

          // Show children nested under the selected element
          if (children.length > 0) {
            children.forEach((child) => {
              renderNode({
                tagName: child.tagName,
                description: child.description,
                selector: child.selector,
                selectorType: child.selectorType,
                childCount: child.childCount,
                textPreview: child.textPreview,
              }, selectedDepth + 1, 'child');
            });
            if (data.childCount > children.length) {
              renderEllipsis(data.childCount - children.length, selectedDepth + 1);
            }
          }
        } else {
          renderNode({
            tagName: sib.tagName,
            description: sib.description,
            selector: sib.selector,
            selectorType: sib.selectorType,
            childCount: sib.childCount,
            textPreview: sib.textPreview,
          }, selectedDepth, 'sibling');
        }
      });
    } else {
      // Only child — just render the selected element
      renderNode({
        tagName: data.tagName,
        description: data.description,
        selector: data.selector,
        selectorType: data.selectorType,
        childCount: data.childCount,
      }, selectedDepth, 'selected');

      // Show children
      if (children.length > 0) {
        children.forEach((child) => {
          renderNode({
            tagName: child.tagName,
            description: child.description,
            selector: child.selector,
            selectorType: child.selectorType,
            childCount: child.childCount,
            textPreview: child.textPreview,
          }, selectedDepth + 1, 'child');
        });
        if (data.childCount > children.length) {
          renderEllipsis(data.childCount - children.length, selectedDepth + 1);
        }
      }
    }

    // Scroll the selected node into view
    requestAnimationFrame(() => {
      const selectedRow = els.domTree.querySelector('.pi-domnav__node--selected');
      if (selectedRow) {
        selectedRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });

    // Update arrow button states
    updateNavButtons(data);
  }

  /**
   * Render a sibling group at an ancestor level.
   * Shows the ancestor node, and a clickable label to expand/show other siblings.
   */
  function renderSiblingGroup(siblings, depth, ancestorData) {
    const totalSiblings = siblings.filter(s => s.type === 'node').length;
    const nonSelfSiblings = siblings.filter(s => s.type === 'node' && !s.isSelf);

    // Create a wrapper for collapsible siblings
    const groupId = `sibling-group-${depth}`;

    // Render each sibling in the group
    siblings.forEach((sib) => {
      if (sib.type === 'ellipsis') {
        const row = renderEllipsis(sib.count, depth);
        row.classList.add(`${groupId}-sibling`);
        if (!sib.isSelf) row.style.display = 'none'; // hidden by default
        return;
      }

      if (sib.isSelf) {
        // The ancestor on the path — always visible
        const row = renderNode({
          tagName: sib.tagName,
          description: sib.description,
          selector: sib.selector,
          selectorType: sib.selectorType,
          childCount: sib.childCount,
        }, depth, 'ancestor');

        // Add a sibling count indicator if there are other siblings
        if (nonSelfSiblings.length > 0) {
          const badge = document.createElement('span');
          badge.className = 'pi-domnav__childcount';
          badge.textContent = `${nonSelfSiblings.length} sibling${nonSelfSiblings.length > 1 ? 's' : ''}`;
          badge.style.cursor = 'pointer';
          badge.title = `Click to show ${nonSelfSiblings.length} sibling element${nonSelfSiblings.length > 1 ? 's' : ''}`;

          badge.addEventListener('click', (e) => {
            e.stopPropagation();
            // Toggle visibility of sibling rows
            const sibRows = els.domTree.querySelectorAll(`.${groupId}-sibling`);
            const isHidden = sibRows[0]?.style.display === 'none';
            sibRows.forEach(r => r.style.display = isHidden ? '' : 'none');
            badge.textContent = isHidden
              ? `hide ${nonSelfSiblings.length}`
              : `${nonSelfSiblings.length} sibling${nonSelfSiblings.length > 1 ? 's' : ''}`;
          });

          row.appendChild(badge);
        }
      } else {
        // Non-path sibling — hidden by default, revealed on click
        const row = renderNode({
          tagName: sib.tagName,
          description: sib.description,
          selector: sib.selector,
          selectorType: sib.selectorType,
          childCount: sib.childCount,
          textPreview: sib.textPreview,
        }, depth, 'sibling');
        row.classList.add(`${groupId}-sibling`);
        row.style.display = 'none';
      }
    });
  }

  /**
   * Render a single node row in the tree.
   * Returns the created row element.
   */
  function renderNode(nodeData, depth, role) {
    const row = document.createElement('button');
    row.className = `pi-domnav__node pi-domnav__node--${role}`;

    // Indent guides
    for (let i = 0; i < depth; i++) {
      const indent = document.createElement('span');
      indent.className = 'pi-domnav__indent';
      row.appendChild(indent);
    }

    // Collapse toggle placeholder (keeps alignment consistent)
    const toggle = document.createElement('span');
    toggle.className = 'pi-domnav__toggle';
    if (nodeData.childCount > 0 && role !== 'selected') {
      toggle.textContent = '▸';
    } else if (role === 'selected' && nodeData.childCount > 0) {
      toggle.textContent = '▸';
      toggle.classList.add('pi-domnav__toggle--expanded');
    } else {
      toggle.classList.add('pi-domnav__toggle--empty');
    }
    row.appendChild(toggle);

    // Label
    const label = document.createElement('span');
    label.className = 'pi-domnav__label';

    // Parse description into colored parts
    const desc = nodeData.description || '';
    const parts = parseElementDescription(desc);

    const tagSpan = document.createElement('span');
    tagSpan.className = 'pi-domnav__tag';
    tagSpan.textContent = parts.tag;
    label.appendChild(tagSpan);

    if (parts.id) {
      const idSpan = document.createElement('span');
      idSpan.className = 'pi-domnav__id';
      idSpan.textContent = parts.id;
      label.appendChild(idSpan);
    }

    if (parts.classes) {
      const classSpan = document.createElement('span');
      classSpan.className = 'pi-domnav__class';
      classSpan.textContent = parts.classes;
      label.appendChild(classSpan);
    }

    row.appendChild(label);

    // Text preview for leaf-ish nodes
    if (nodeData.textPreview && nodeData.childCount === 0) {
      const text = document.createElement('span');
      text.className = 'pi-domnav__text';
      text.textContent = `"${nodeData.textPreview.substring(0, 30)}${nodeData.textPreview.length > 30 ? '…' : ''}"`;
      row.appendChild(text);
    }

    // Click to select (not on the currently selected node)
    if (role !== 'selected') {
      row.addEventListener('click', () => {
        navigateToElement(nodeData.selector, nodeData.selectorType);
      });
    }

    // Hover to highlight on page
    row.addEventListener('mouseenter', () => {
      if (nodeData.selector) {
        chrome.runtime.sendMessage({
          type: 'HIGHLIGHT_ELEMENT',
          data: { selector: nodeData.selector, selectorType: nodeData.selectorType }
        });
      }
    });

    els.domTree.appendChild(row);
    return row;
  }

  /**
   * Render an ellipsis row ("+ N more") for truncated sibling lists.
   */
  function renderEllipsis(count, depth) {
    const row = document.createElement('div');
    row.className = 'pi-domnav__collapsed-siblings';

    for (let i = 0; i < depth; i++) {
      const indent = document.createElement('span');
      indent.className = 'pi-domnav__indent';
      row.appendChild(indent);
    }

    // Spacer for toggle column
    const spacer = document.createElement('span');
    spacer.className = 'pi-domnav__toggle pi-domnav__toggle--empty';
    row.appendChild(spacer);

    const label = document.createElement('span');
    label.textContent = `… ${count} more`;
    row.appendChild(label);

    els.domTree.appendChild(row);
    return row;
  }

  /**
   * Parse an element description like "div#main.container.active" into parts.
   */
  function parseElementDescription(desc) {
    const idMatch = desc.match(/#([^.…]+)/);
    const classMatch = desc.match(/\.(.+)/);
    const tagMatch = desc.match(/^(\w+)/);

    return {
      tag: tagMatch ? tagMatch[1] : desc,
      id: idMatch ? `#${idMatch[1]}` : '',
      classes: classMatch ? `.${classMatch[1]}` : '',
    };
  }

  // ─── Arrow Key Navigation Buttons ─────────────────────────────────────

  function updateNavButtons(data) {
    const ancestors = data.ancestors || [];
    const siblings = data.siblings || [];
    const children = data.children || [];

    // Parent: enabled if there are ancestors
    els.btnNavParent.disabled = ancestors.length === 0;

    // Prev/Next sibling: check if there are siblings before/after self
    const selfIndex = siblings.findIndex(s => s.type === 'node' && s.isSelf);
    const prevSibling = siblings.slice(0, selfIndex).reverse().find(s => s.type === 'node');
    const nextSibling = siblings.slice(selfIndex + 1).find(s => s.type === 'node');
    els.btnNavPrev.disabled = !prevSibling;
    els.btnNavNext.disabled = !nextSibling;

    // Child: enabled if there are children
    els.btnNavChild.disabled = children.length === 0;

    // Store nav targets for button clicks
    state.navTargets = {
      parent: ancestors.length > 0 ? ancestors[ancestors.length - 1] : null,
      prev: prevSibling || null,
      next: nextSibling || null,
      child: children.length > 0 ? children[0] : null,
    };
  }

  // Wire up arrow buttons
  els.btnNavParent.addEventListener('click', () => {
    if (state.navTargets?.parent) {
      navigateToElement(state.navTargets.parent.selector, state.navTargets.parent.selectorType);
    }
  });

  els.btnNavPrev.addEventListener('click', () => {
    if (state.navTargets?.prev) {
      navigateToElement(state.navTargets.prev.selector, state.navTargets.prev.selectorType);
    }
  });

  els.btnNavNext.addEventListener('click', () => {
    if (state.navTargets?.next) {
      navigateToElement(state.navTargets.next.selector, state.navTargets.next.selectorType);
    }
  });

  els.btnNavChild.addEventListener('click', () => {
    if (state.navTargets?.child) {
      navigateToElement(state.navTargets.child.selector, state.navTargets.child.selectorType);
    }
  });

  /**
   * Ask the content script to select a different element by its selector.
   */
  function navigateToElement(selector, selectorType) {
    chrome.runtime.sendMessage({
      type: 'SELECT_ELEMENT',
      data: { selector, selectorType }
    });
  }

  // populateQuickEdit removed — replaced by DevTools Styles clone

  function updateInspectorState(data) {
    state.inspectorActive = data.active;
    els.btnInspector.classList.toggle('active', data.active);
    setStatus(
      data.active
        ? 'Inspector active — click any element to select it'
        : 'Inspector paused',
      data.active
    );
  }

  // ─── Communication Helpers ──────────────────────────────────────────────

  function sendCSSEdit(property, value) {
    console.log("[DesInspect Panel] sendCSSEdit:", property, value);
    chrome.runtime.sendMessage({
      type: 'APPLY_CSS_EDIT',
      data: { property, value }
    });
  }

  function sendRuleEdit(selector, property, value) {
    console.log("[DesInspect Panel] sendRuleEdit:", selector, property, value);
    chrome.runtime.sendMessage({
      type: 'APPLY_RULE_EDIT',
      data: { selector, property, value }
    });
  }

  function requestChanges() {
    chrome.runtime.sendMessage({ type: 'GET_CHANGES' });
  }

  function requestHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' });
  }

  // ─── AI UX Audit ────────────────────────────────────────────────────────

  // Initialize audit panel state
  async function initAuditPanel() {
    const hasKey = await AuditEngine.hasApiKey();
    els.auditSetup.hidden = hasKey;
    els.auditControls.hidden = !hasKey;
    if (hasKey) {
      updateAuditButtons();
    }
  }

  function updateAuditButtons() {
    const hasSelection = !!state.selectedElement;
    const hasChanges = state.changes && state.changes.length > 0;
    els.btnAuditPage.disabled = false; // Always available
    els.btnAuditElement.disabled = !hasSelection;
    els.btnCheckImpact.disabled = !hasSelection || !hasChanges;
  }

  // Save API key
  els.btnSaveKey.addEventListener('click', async () => {
    const key = els.auditApiKeyInput.value.trim();
    if (!key) {
      showToast('Please enter an API key');
      return;
    }
    if (!key.startsWith('sk-')) {
      showToast('Invalid API key format');
      return;
    }
    await AuditEngine.setApiKey(key);
    els.auditSetup.hidden = true;
    els.auditControls.hidden = false;
    els.auditApiKeyInput.value = '';
    updateAuditButtons();
    showToast('API key saved');
  });

  // Remove API key
  els.btnRemoveKey.addEventListener('click', async () => {
    if (!confirm('Remove your API key? You can add it back anytime.')) return;
    await AuditEngine.clearApiKey();
    AuditEngine.disableMockMode();
    els.auditSetup.hidden = false;
    els.auditControls.hidden = true;
    els.auditResults.hidden = true;
    els.auditLoading.hidden = true;
    showToast('API key removed');
  });

  // Test mode (mock data, no API key needed)
  els.btnTestMode.addEventListener('click', () => {
    AuditEngine.enableMockMode();
    els.auditSetup.hidden = true;
    els.auditControls.hidden = false;
    // Update key status to show test mode
    els.auditControls.querySelector('.pi-audit-controls__key-status').textContent = '🧪 Test mode (mock data)';
    els.btnRemoveKey.textContent = 'Exit Test Mode';
    updateAuditButtons();
    showToast('Test mode enabled — using mock data');
  });

  // Run Page Audit
  els.btnAuditPage.addEventListener('click', () => {
    // Show loading
    els.auditLoading.hidden = false;
    els.auditResults.hidden = true;
    els.auditEmpty.hidden = true;
    els.btnAuditPage.disabled = true;
    els.btnAuditElement.disabled = true;
    els.btnCheckImpact.disabled = true;

    // Request page data from content script — audit happens when PAGE_DATA arrives
    state._pendingPageAudit = true;
    chrome.runtime.sendMessage({ type: 'GET_PAGE_DATA' });
  });

  // Run Element Audit
  els.btnAuditElement.addEventListener('click', async () => {
    if (!state.selectedElement) {
      showToast('Select an element first');
      return;
    }

    // Show loading
    els.auditLoading.hidden = false;
    els.auditResults.hidden = true;
    els.auditEmpty.hidden = true;
    els.btnAuditElement.disabled = true;
    els.btnCheckImpact.disabled = true;

    try {
      const result = await AuditEngine.auditElement(
        state.selectedElement,
        state.selectedElement?.pageUrl || ''
      );
      renderAuditResults(result);
    } catch (err) {
      handleAuditError(err);
    } finally {
      els.auditLoading.hidden = true;
      updateAuditButtons();
    }
  });

  // Run Impact Check
  els.btnCheckImpact.addEventListener('click', async () => {
    if (!state.selectedElement || !state.changes?.length) {
      showToast('Make some changes first');
      return;
    }

    els.auditLoading.hidden = false;
    els.auditResults.hidden = true;
    els.auditEmpty.hidden = true;
    els.btnAuditElement.disabled = true;
    els.btnCheckImpact.disabled = true;

    try {
      const result = await AuditEngine.checkImpact(
        state.changes,
        state.selectedElement,
        state.selectedElement?.pageUrl || ''
      );
      renderImpactResults(result);
    } catch (err) {
      handleAuditError(err);
    } finally {
      els.auditLoading.hidden = true;
      updateAuditButtons();
    }
  });

  async function runPageAudit(pageData) {
    try {
      const result = await AuditEngine.auditPage(pageData);
      renderAuditResults(result);
    } catch (err) {
      handleAuditError(err);
    } finally {
      els.auditLoading.hidden = true;
      updateAuditButtons();
    }
  }

  function handleAuditError(err) {
    if (err.message === 'NO_API_KEY') {
      els.auditSetup.hidden = false;
      els.auditControls.hidden = true;
      showToast('Please add your API key');
    } else if (err.message === 'INVALID_API_KEY') {
      showToast('Invalid API key — please check and re-enter');
      els.auditSetup.hidden = false;
      els.auditControls.hidden = true;
    } else if (err.message === 'RATE_LIMITED') {
      showToast('Rate limited — wait a moment and try again');
    } else {
      showToast(`Audit failed: ${err.message}`);
      console.error('[DesInspect] Audit error:', err);
    }
  }

  /**
   * Render element audit results.
   */
  function renderAuditResults(result) {
    els.auditResults.hidden = false;

    // Summary
    const scoreClass = result.score === 'pass' ? 'pass' : result.score === 'warning' ? 'warning' : 'fail';
    const scoreIcon = result.score === 'pass' ? '✅' : result.score === 'warning' ? '⚠️' : '❌';
    els.auditSummary.className = `pi-audit-summary pi-audit-summary--${scoreClass}`;
    els.auditSummary.textContent = `${scoreIcon} ${result.summary || 'Audit complete'}`;

    // Findings
    els.auditFindings.innerHTML = '';
    const findings = result.findings || [];

    if (findings.length === 0) {
      els.auditFindings.innerHTML = '<p style="font-size:11px;color:#94a3b8;padding:8px 0">No issues found.</p>';
      return;
    }

    for (const finding of findings) {
      els.auditFindings.appendChild(createFindingCard(finding));
    }
  }

  /**
   * Render impact check results.
   */
  function renderImpactResults(result) {
    els.auditResults.hidden = false;

    // Summary
    const verdictMap = { positive: 'pass', neutral: 'warning', negative: 'fail', mixed: 'warning' };
    const iconMap = { positive: '✅', neutral: 'ℹ️', negative: '❌', mixed: '⚠️' };
    const cls = verdictMap[result.verdict] || 'warning';
    const icon = iconMap[result.verdict] || 'ℹ️';
    els.auditSummary.className = `pi-audit-summary pi-audit-summary--${cls}`;
    els.auditSummary.textContent = `${icon} ${result.summary || 'Impact check complete'}`;

    // Impacts rendered as findings
    els.auditFindings.innerHTML = '';
    const impacts = result.impacts || [];

    if (impacts.length === 0) {
      els.auditFindings.innerHTML = '<p style="font-size:11px;color:#94a3b8;padding:8px 0">No significant impact detected.</p>';
      return;
    }

    for (const impact of impacts) {
      els.auditFindings.appendChild(createFindingCard({
        severity: impact.severity,
        category: impact.property,
        title: impact.title,
        description: impact.description,
        suggestion: impact.recommendation,
        css_fix: null,
      }));
    }
  }

  /**
   * Create a finding card DOM element.
   */
  function createFindingCard(finding) {
    const card = document.createElement('div');
    card.className = 'pi-audit-finding';

    const severityIcons = { error: '✕', warning: '!', info: 'i', pass: '✓' };

    // Header
    const header = document.createElement('div');
    header.className = 'pi-audit-finding__header';
    header.innerHTML = `
      <span class="pi-audit-finding__severity pi-audit-finding__severity--${finding.severity}">
        ${severityIcons[finding.severity] || 'i'}
      </span>
      <span class="pi-audit-finding__title">${escapeHTML(finding.title)}</span>
      <span class="pi-audit-finding__category">${escapeHTML(finding.category || '')}</span>
    `;
    card.appendChild(header);

    // Description
    if (finding.description) {
      const desc = document.createElement('p');
      desc.className = 'pi-audit-finding__desc';
      desc.textContent = finding.description;
      card.appendChild(desc);
    }

    // Suggestion
    if (finding.suggestion) {
      const sugg = document.createElement('div');
      sugg.className = 'pi-audit-finding__suggestion';
      sugg.innerHTML = `<strong>Fix:</strong> ${escapeHTML(finding.suggestion)}`;
      card.appendChild(sugg);
    }

    // CSS Fix button (one-click apply)
    if (finding.css_fix && typeof finding.css_fix === 'object') {
      const fixEntries = Object.entries(finding.css_fix);
      if (fixEntries.length > 0) {
        const fixBtn = document.createElement('button');
        fixBtn.className = 'pi-audit-finding__fix-btn';
        fixBtn.textContent = `⚡ Apply Fix (${fixEntries.map(([p, v]) => `${p}: ${v}`).join('; ')})`;
        fixBtn.addEventListener('click', () => {
          for (const [prop, val] of fixEntries) {
            chrome.runtime.sendMessage({
              type: 'APPLY_CSS_EDIT',
              data: { property: prop, value: val }
            });
          }
          fixBtn.textContent = '✓ Applied';
          fixBtn.disabled = true;
          showToast('Fix applied');
        });
        card.appendChild(fixBtn);
      }
    }

    return card;
  }

  // Init audit panel on load
  initAuditPanel();

  // ─── Copilot ──────────────────────────────────────────────────────────

  /**
   * Handle copilot "Go" button or Enter key.
   * Sends the instruction + element context to Claude, renders suggestions.
   */
  async function runCopilot() {
    const instruction = els.copilotInput.value.trim();
    if (!instruction || !state.selectedElement) return;

    // Check for API key or mock mode
    const hasKey = await AuditEngine.hasApiKey();
    if (!hasKey && !AuditEngine.isMockMode()) {
      els.copilotError.textContent = 'Set up your API key in the AI UX Audit tab first, or enable Test Mode.';
      els.copilotError.hidden = false;
      return;
    }

    // Show loading, hide previous results
    els.copilotLoading.hidden = false;
    els.copilotResults.hidden = true;
    els.copilotError.hidden = true;
    els.btnCopilotSend.disabled = true;

    try {
      const result = await AuditEngine.copilotEdit(
        instruction,
        state.selectedElement,
        state.selectedElement.pageUrl || ''
      );
      renderCopilotResults(result);
    } catch (err) {
      console.error('[DesInspect Copilot]', err);
      els.copilotError.textContent = err.message === 'NO_API_KEY'
        ? 'Set up your API key in the AI UX Audit tab first.'
        : err.message === 'INVALID_API_KEY'
        ? 'Invalid API key — check your key in the AI UX Audit tab.'
        : err.message === 'RATE_LIMITED'
        ? 'Rate limited — please wait a moment and try again.'
        : `Error: ${err.message}`;
      els.copilotError.hidden = false;
    } finally {
      els.copilotLoading.hidden = true;
      els.btnCopilotSend.disabled = false;
    }
  }

  /**
   * Render copilot suggestions with Apply All / Dismiss actions.
   */
  function renderCopilotResults(result) {
    els.copilotResults.innerHTML = '';

    if (!result.changes || result.changes.length === 0) {
      els.copilotError.textContent = result.summary || 'No changes suggested.';
      els.copilotError.hidden = false;
      return;
    }

    // Summary
    const summary = document.createElement('div');
    summary.className = 'pi-copilot__summary';
    summary.textContent = result.summary;
    els.copilotResults.appendChild(summary);

    // Change list
    const changeList = document.createElement('div');
    changeList.className = 'pi-copilot__changes';

    for (const change of result.changes) {
      const row = document.createElement('div');
      row.className = 'pi-copilot__change';

      const prop = document.createElement('span');
      prop.className = 'pi-copilot__change-prop';
      prop.textContent = change.type === 'html' ? 'innerHTML' : change.property;

      const val = document.createElement('span');
      val.className = 'pi-copilot__change-value';
      val.textContent = change.type === 'html'
        ? (change.value.length > 60 ? change.value.substring(0, 60) + '…' : change.value)
        : change.value;

      row.appendChild(prop);
      row.appendChild(val);

      if (change.reason) {
        const reason = document.createElement('span');
        reason.className = 'pi-copilot__change-reason';
        reason.textContent = change.reason;
        reason.title = change.reason;
        row.appendChild(reason);
      }

      changeList.appendChild(row);
    }

    els.copilotResults.appendChild(changeList);

    // Actions: Apply All + Dismiss
    const actions = document.createElement('div');
    actions.className = 'pi-copilot__actions';

    const applyBtn = document.createElement('button');
    applyBtn.className = 'pi-btn pi-btn--primary pi-btn--small';
    applyBtn.textContent = '✓ Apply All';
    applyBtn.addEventListener('click', () => {
      applyCopilotChanges(result.changes);
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'pi-btn pi-btn--small';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      els.copilotResults.hidden = true;
      els.copilotInput.value = '';
    });

    actions.appendChild(applyBtn);
    actions.appendChild(dismissBtn);
    els.copilotResults.appendChild(actions);

    els.copilotResults.hidden = false;
  }

  /**
   * Apply copilot-suggested changes via the existing edit pipeline.
   */
  function applyCopilotChanges(changes) {
    for (const change of changes) {
      if (change.type === 'html') {
        chrome.runtime.sendMessage({
          type: 'APPLY_HTML_EDIT',
          data: { html: change.value }
        });
      } else {
        chrome.runtime.sendMessage({
          type: 'APPLY_CSS_EDIT',
          data: { property: change.property, value: change.value }
        });
      }
    }
    showToast(`Applied ${changes.length} copilot change${changes.length > 1 ? 's' : ''}`);
    els.copilotResults.hidden = true;
    els.copilotInput.value = '';
    // Refresh changes list
    requestChanges();
  }

  // Copilot event listeners
  els.btnCopilotSend.addEventListener('click', runCopilot);
  els.copilotInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runCopilot();
    }
  });

  // ─── UI Helpers ─────────────────────────────────────────────────────────

  function setStatus(text, active = false) {
    els.statusText.textContent = text;
    els.statusBar.classList.toggle('pi-status--active', active);
  }

  function showToast(message, duration = 2000) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    setTimeout(() => { els.toast.hidden = true; }, duration);
  }

  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function escapeAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function rgbToHex(rgb) {
    if (!rgb || rgb === 'transparent' || rgb === 'rgba(0, 0, 0, 0)') return '#000000';
    const match = rgb.match(/\d+/g);
    if (!match || match.length < 3) return '#000000';
    const [r, g, b] = match.map(Number);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  /**
   * Simple CSS diff generator (runs in the side panel context).
   */
  function generateCSSDiff(changes) {
    const cssChanges = changes.filter(c => c.property !== '__html__');
    if (cssChanges.length === 0) return '/* No CSS changes */';

    const grouped = {};
    for (const c of cssChanges) {
      if (!grouped[c.selector]) grouped[c.selector] = [];
      grouped[c.selector].push(c);
    }

    let output = `/* DesInspect CSS Diff — ${new Date().toISOString()} */\n\n`;
    for (const [selector, props] of Object.entries(grouped)) {
      output += `${selector} {\n`;
      for (const p of props) {
        output += `  ${p.property}: ${p.value}; /* was: ${p.originalValue || 'unset'} */\n`;
      }
      output += '}\n\n';
    }
    return output;
  }

  function copyToClipboard(text) {
    navigator.clipboard.writeText(text).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  function downloadAsFile(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Init ───────────────────────────────────────────────────────────────

  async function init() {
    // Request current state from content script
    chrome.runtime.sendMessage({ type: 'GET_INSPECTOR_STATE' });
  }

  init();
})();

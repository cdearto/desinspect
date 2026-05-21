/**
 * DesInspect — Inspector (Main Content Script)
 * 
 * Orchestrates the element inspection experience:
 * - Activates/deactivates inspector mode
 * - Handles mouse hover (highlight) and click (select) on page elements
 * - Sends selected element data to the side panel for editing
 * - Listens for edit commands from the side panel and applies them
 * - Initializes the change tracker on page load
 * 
 * This is the "brain" of the content-side logic.
 */

const Inspector = (() => {

  let _active = false;          // Is inspector mode on?
  let _selectedElement = null;  // Currently selected DOM element
  let _originalStyles = {};     // Cache of original computed styles for selected element
  let _persistentHighlightElement = null;  // Element with persistent highlight (HTML editor mode)
  let _persistentScrollHandler = null;     // Scroll listener for persistent highlight

  // ─── Initialization ─────────────────────────────────────────────────────

  /**
   * Boot up the inspector. Called once when the content script loads.
   * Re-applies any persisted changes immediately.
   */
  async function init() {
    await ChangeTracker.init();
    setupMessageListener();
    setupSPANavigationMonitor();
    setupUndoRedoShortcuts();
    setupTabFocusListener();
    console.log('[DesInspect] Content script initialized.');
  }

  // ─── Tab Focus / Return-to-Element ──────────────────────────────────────

  /**
   * Listen for tab visibility changes and window focus events.
   * When the user returns to this tab after switching away, re-highlight
   * and scroll to the selected element so they can pick up where they left off.
   */
  function setupTabFocusListener() {
    // Primary: visibilitychange fires when switching Chrome tabs
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && _selectedElement) {
        // Small delay to let the browser finish tab switch rendering
        setTimeout(() => {
          // Verify the element is still in the DOM (guards against SPA nav while away)
          if (!_selectedElement.isConnected) {
            deselectElement();
            return;
          }
          // Scroll back to the element and flash subtly to re-orient the user
          OverlayRenderer.flashHighlight(_selectedElement, 'subtle');
        }, 250);
      }
    });

    // Secondary: window focus fires for multi-window scenarios
    // (e.g. user clicked another browser window, then came back)
    window.addEventListener('focus', () => {
      if (_selectedElement && _selectedElement.isConnected) {
        // Just refresh the highlight position — element may have shifted
        // due to lazy-loading content or layout recalc while away
        requestAnimationFrame(() => {
          OverlayRenderer.refreshHighlight(_selectedElement);
        });
      }
    });
  }

  // ─── Undo/Redo Keyboard Shortcuts ──────────────────────────────────────────

  /**
   * Global keyboard listener for Cmd+Z / Ctrl+Z (undo) and
   * Cmd+Shift+Z / Ctrl+Shift+Z (redo). Always active regardless
   * of inspector mode so shortcuts work while editing in the side panel.
   */
  function setupUndoRedoShortcuts() {
    document.addEventListener('keydown', (event) => {
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.key.toLowerCase() !== 'z') return;

      // Don't intercept if user is typing in a page input/textarea
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;

      event.preventDefault();
      event.stopPropagation();

      if (event.shiftKey) {
        ChangeTracker.redo();
      } else {
        ChangeTracker.undo();
      }
    }, true);
  }

  // ─── SPA Navigation Detection ──────────────────────────────────────────────

  /**
   * Detect client-side navigation (pushState, replaceState, popstate).
   * SPAs change the URL without triggering a full page reload, so we
   * intercept the History API and re-apply changes for the new route.
   */
  function setupSPANavigationMonitor() {
    let _lastUrl = window.location.href;

    /**
     * Check if the URL changed and handle navigation if so.
     */
    function checkForNavigation() {
      const currentUrl = window.location.href;
      if (currentUrl !== _lastUrl) {
        const oldUrl = _lastUrl;
        _lastUrl = currentUrl;
        onSPANavigation(oldUrl, currentUrl);
      }
    }

    // Monkey-patch history.pushState
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      checkForNavigation();
    };

    // Monkey-patch history.replaceState
    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      checkForNavigation();
    };

    // Listen for popstate (browser back/forward buttons)
    window.addEventListener('popstate', () => {
      // popstate fires after the URL has already changed
      checkForNavigation();
    });

    // Fallback: periodic URL check for edge cases (hashchange, etc.)
    // Runs every 1s — lightweight, catches anything the patches miss
    setInterval(checkForNavigation, 1000);
  }

  /**
   * Called when a SPA navigation is detected.
   * Deselects the current element, cleans up overlays,
   * and re-applies changes for the new URL.
   */
  function onSPANavigation(oldUrl, newUrl) {
    console.log(`[DesInspect] SPA route change detected: ${oldUrl} → ${newUrl}`);

    // Deselect current element — it may no longer exist after navigation
    if (_selectedElement) {
      deselectElement();
      // Notify side panel that selection is gone
      chrome.runtime.sendMessage({
        type: 'SPA_NAVIGATION',
        data: { oldUrl, newUrl }
      }).catch(() => {});
    }

    // Tell the change tracker to switch URLs and re-apply
    ChangeTracker.handleNavigation(newUrl);

    // If inspector is active, wait for new DOM to settle then
    // let the user keep selecting on the new page
    if (_active) {
      // Brief delay to let SPA framework finish rendering
      setTimeout(() => {
        // Re-apply changes after DOM settles (frameworks like React
        // may render async after pushState)
        ChangeTracker.reapplyChanges();
      }, 500);
    }
  }

  // ─── Activate / Deactivate Inspector Mode ─────────────────────────────────

  function activate() {
    if (_active) return;
    _active = true;
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.body.style.cursor = 'crosshair';
    // Re-mark any elements that have saved changes
    ChangeTracker.reapplyModifiedMarkers();
    console.log('[DesInspect] Inspector activated.');
  }

  function deactivate() {
    if (!_active) return;
    _active = false;
    document.removeEventListener('mousemove', handleMouseMove, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    document.body.style.cursor = '';
    OverlayRenderer.hideHighlight();
    OverlayRenderer.clearAllModified();
    OverlayRenderer.clearSelection();
    _selectedElement = null;
    _originalStyles = {};
    _persistentHighlightElement = null;
    if (_persistentScrollHandler) {
      window.removeEventListener('scroll', _persistentScrollHandler, true);
      _persistentScrollHandler = null;
    }
    console.log('[DesInspect] Inspector deactivated.');
  }

  function toggle() {
    if (_active) {
      deactivate();
    } else {
      activate();
    }
    return _active;
  }

  // ─── Mouse / Keyboard Handlers ────────────────────────────────────────────

  function handleMouseMove(event) {
    if (!_active) return;

    const target = event.target;

    // Don't highlight our own UI elements
    if (isDesInspectElement(target)) return;

    OverlayRenderer.showHighlight(target, 'hover');
  }

  function handleClick(event) {
    if (!_active) return;

    const target = event.target;

    // Don't select our own UI elements
    if (isDesInspectElement(target)) return;

    // Prevent the click from doing anything on the page
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    selectElement(target);
  }

  function handleKeyDown(event) {
    // Escape → deactivate inspector
    if (event.key === 'Escape') {
      if (_selectedElement) {
        deselectElement();
      } else {
        deactivate();
        chrome.runtime.sendMessage({ type: 'INSPECTOR_STATE', data: { active: false } });
      }
    }

    // Delete / Backspace → remove selected element
    if ((event.key === 'Delete' || event.key === 'Backspace') && _selectedElement) {
      // Don't intercept if user is typing in a page input/textarea
      const tag = event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;

      // Don't allow deleting <html>, <body>, or <head>
      const nodeName = _selectedElement.tagName.toLowerCase();
      if (nodeName === 'html' || nodeName === 'body' || nodeName === 'head') return;

      event.preventDefault();
      event.stopPropagation();

      const element = _selectedElement;
      deselectElement();
      ChangeTracker.recordElementDeletion(element);
    }
  }

  // ─── Element Selection ────────────────────────────────────────────────────

  /**
   * Select an element for editing.
   * Captures its current styles and sends data to the side panel.
   * Includes ancestor chain + direct children for DOM navigation.
   * @param {HTMLElement} element
   */
  function selectElement(element) {
    _selectedElement = element;

    // Capture original computed styles (before any DesInspect changes)
    _originalStyles = DOMSerializer.getComputedStyleMap(element);

    // Generate selector
    const selectorInfo = SelectorEngine.generate(element);

    // Build ancestor chain (from <html> down to this element)
    const ancestors = buildAncestorChain(element);

    // Build direct children list
    const children = buildChildrenList(element);

    // Build siblings of the selected element
    const siblings = buildSelectedSiblings(element);

    // Build the data payload for the side panel
    const matchedRules = getMatchedCSSRules(element);
    const elementData = {
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      selectorFragile: selectorInfo.fragile,
      selectorWarning: selectorInfo.warning,
      tagName: element.tagName.toLowerCase(),
      tag: element.tagName.toLowerCase(),
      description: DOMSerializer.describeElement(element),
      id: element.id || null,
      classList: Array.from(element.classList),
      classes: Array.from(element.classList).join(' '),
      role: element.getAttribute('role') || null,
      aria: getAriaAttributes(element),
      textContent: (element.textContent || '').trim().substring(0, 500),
      parentTag: element.parentElement?.tagName.toLowerCase() || null,
      inlineStyles: DOMSerializer.getInlineStyles(element),
      computedStyles: _originalStyles,
      matchedRules,
      innerHTML: element.innerHTML,
      outerHTML: element.outerHTML.substring(0, 50000),
      parentOuterHTML: element.parentElement ? element.parentElement.outerHTML.substring(0, 50000) : '',
      parentSelector: element.parentElement ? SelectorEngine.generate(element.parentElement) : null,
      childIndex: element.parentElement ? Array.from(element.parentElement.children).indexOf(element) : 0,
      boundingRect: element.getBoundingClientRect().toJSON(),
      dimensions: {
        width: Math.round(element.getBoundingClientRect().width),
        height: Math.round(element.getBoundingClientRect().height),
      },
      pageUrl: window.location.href,
      // DOM navigation data
      ancestors,
      children,
      siblings,
      childCount: element.children.length,
      depth: ancestors.length,
    };

    // Show selection highlight
    OverlayRenderer.setSelected(element);

    // Send to side panel
    chrome.runtime.sendMessage({
      type: 'ELEMENT_SELECTED',
      data: elementData
    }).catch(() => {});

    console.log('[DesInspect] Selected:', selectorInfo.selector);
  }

  /**
   * Resolve a page element by walking a child index path from a root element.
   * indexPath [] = the root itself, [0] = first child element, [0, 2] = first child's third child, etc.
   * @param {string} rootSelector
   * @param {string} rootSelectorType
   * @param {number[]} indexPath
   * @returns {HTMLElement|null}
   */
  function resolveElementByPath(rootSelector, rootSelectorType, indexPath) {
    const root = SelectorEngine.find({ selector: rootSelector, type: rootSelectorType });
    if (!root) return null;
    if (!indexPath || indexPath.length === 0) return root;

    let current = root;
    for (const idx of indexPath) {
      const children = Array.from(current.children);
      if (idx < 0 || idx >= children.length) return null;
      current = children[idx];
    }
    return current;
  }

  /**
   * Build the ancestor chain from <html> down to (but not including) the element.
   * Each entry includes its own siblings so the tree can show context at every level.
   * @param {HTMLElement} element
   * @returns {Array<{ tagName, description, selector, selectorType, depth, siblings }>}
   */
  function buildAncestorChain(element) {
    const chain = [];
    let current = element.parentElement;

    while (current && current !== document.documentElement) {
      const sel = SelectorEngine.generate(current);
      chain.unshift({
        tagName: current.tagName.toLowerCase(),
        description: DOMSerializer.describeElement(current),
        selector: sel.selector,
        selectorType: sel.type,
        childCount: current.children.length,
        siblings: buildSiblingsList(current),
      });
      current = current.parentElement;
    }

    return chain;
  }

  /**
   * Build a compact list of an element's siblings (including itself, marked).
   * Only includes element nodes, caps at 8 before/after to avoid huge payloads.
   * @param {HTMLElement} element
   * @returns {Array<{ tagName, description, selector, selectorType, isSelf, childCount, textPreview }>}
   */
  function buildSiblingsList(element) {
    const parent = element.parentElement;
    if (!parent) return [];

    const allSiblings = Array.from(parent.children).filter(el => !isDesInspectElement(el));
    const selfIndex = allSiblings.indexOf(element);

    // If very many siblings, show a window around the current element
    const MAX_AROUND = 5;
    let start = 0;
    let end = allSiblings.length;
    let truncatedBefore = 0;
    let truncatedAfter = 0;

    if (allSiblings.length > MAX_AROUND * 2 + 1) {
      start = Math.max(0, selfIndex - MAX_AROUND);
      end = Math.min(allSiblings.length, selfIndex + MAX_AROUND + 1);
      truncatedBefore = start;
      truncatedAfter = allSiblings.length - end;
    }

    const result = [];

    if (truncatedBefore > 0) {
      result.push({ type: 'ellipsis', count: truncatedBefore });
    }

    for (let i = start; i < end; i++) {
      const sib = allSiblings[i];
      const sel = SelectorEngine.generate(sib);
      result.push({
        type: 'node',
        tagName: sib.tagName.toLowerCase(),
        description: DOMSerializer.describeElement(sib),
        selector: sel.selector,
        selectorType: sel.type,
        isSelf: sib === element,
        childCount: sib.children.length,
        textPreview: (sib.textContent || '').trim().substring(0, 50),
      });
    }

    if (truncatedAfter > 0) {
      result.push({ type: 'ellipsis', count: truncatedAfter });
    }

    return result;
  }

  /**
   * Build siblings list for the currently selected element.
   */
  function buildSelectedSiblings(element) {
    return buildSiblingsList(element);
  }

  /**
   * Build a list of direct children of the element.
   * Includes element children only (no text nodes).
   * @param {HTMLElement} element
   * @returns {Array<{ tagName, description, selector, selectorType, index, childCount }>}
   */
  function buildChildrenList(element) {
    const list = [];
    const kids = Array.from(element.children);

    // Cap at 50 children to avoid huge payloads
    const limit = Math.min(kids.length, 50);

    for (let i = 0; i < limit; i++) {
      const child = kids[i];
      // Skip our own overlay elements
      if (isDesInspectElement(child)) continue;

      const sel = SelectorEngine.generate(child);
      list.push({
        tagName: child.tagName.toLowerCase(),
        description: DOMSerializer.describeElement(child),
        selector: sel.selector,
        selectorType: sel.type,
        index: i,
        childCount: child.children.length,
        textPreview: (child.textContent || '').trim().substring(0, 60),
      });
    }

    return list;
  }

  function deselectElement() {
    _selectedElement = null;
    _originalStyles = {};
    OverlayRenderer.clearSelection();
  }

  // ─── Apply Edits from Side Panel ──────────────────────────────────────────

  /**
   * Apply a CSS property change to the currently selected element.
   * @param {string} property 
   * @param {string} value 
   */
  function applyCSSEdit(property, value) {
    console.log("[DesInspect] applyCSSEdit called:", property, value, "element:", !!_selectedElement);
    if (!_selectedElement) return;

    const originalValue = _originalStyles[property] || '';
    ChangeTracker.recordCSSChange(_selectedElement, property, value, originalValue);
  }

  /**
   * Apply a CSS rule-level edit.
   * Instead of setting inline style on a single element, this creates/updates
   * a <style> tag so the change applies to ALL elements matching the selector.
   */
  function applyRuleEdit(selector, property, value) {
    console.log("[DesInspect] applyRuleEdit called:", selector, property, value);
    // Get or create our override stylesheet
    let sheet = document.getElementById('desinspect-rule-overrides');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'desinspect-rule-overrides';
      sheet.setAttribute('data-desinspect', 'true');
      document.head.appendChild(sheet);
    }

    const styleSheet = sheet.sheet;
    const ruleKey = `${selector}::${property}`;

    // Check if we already have a rule for this selector+property
    // We store one rule per selector, merging properties
    let existingRuleIndex = -1;
    let existingRule = null;
    for (let i = 0; i < styleSheet.cssRules.length; i++) {
      const rule = styleSheet.cssRules[i];
      if (rule.selectorText === selector) {
        existingRuleIndex = i;
        existingRule = rule;
        break;
      }
    }

    if (value === '') {
      // Remove the property from the override rule
      if (existingRule) {
        existingRule.style.removeProperty(property);
        // If rule has no more properties, remove it entirely
        if (existingRule.style.length === 0) {
          styleSheet.deleteRule(existingRuleIndex);
        }
      }
    } else {
      // Set the property (includes 'unset', 'initial', 'inherit' as valid CSS values)
      if (existingRule) {
        // Update existing rule
        existingRule.style.setProperty(property, value, 'important');
      } else {
        // Create new rule
        const ruleText = `${selector} { ${property}: ${value} !important; }`;
        try {
          styleSheet.insertRule(ruleText, styleSheet.cssRules.length);
        } catch (e) {
          console.warn('[DesInspect] Could not insert rule:', ruleText, e);
          return;
        }
      }
    }

    // Record this as a rule-level change for persistence
    ChangeTracker.recordRuleChange(selector, property, value);

    // Notify side panel
    chrome.runtime.sendMessage({
      type: 'RULE_CHANGE_APPLIED',
      data: { selector, property, value }
    }).catch(() => {});
  }

  /**
   * Apply an HTML content change to the currently selected element.
   * @param {string} newHTML 
   */
  function applyHTMLEdit(newHTML) {
    if (!_selectedElement) return;

    const originalHTML = _selectedElement.innerHTML;
    ChangeTracker.recordHTMLChange(_selectedElement, newHTML, originalHTML);
  }

  // ─── Message Listener ─────────────────────────────────────────────────────

  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      switch (message.type) {

        case 'TOGGLE_INSPECTOR': {
          const isActive = toggle();
          chrome.runtime.sendMessage({
            type: 'INSPECTOR_STATE',
            data: { active: isActive }
          }).catch(() => {});
          break;
        }

        case 'APPLY_CSS_EDIT':
          console.log('[DesInspect] Received APPLY_CSS_EDIT', message.data);
          applyCSSEdit(message.data.property, message.data.value);
          break;

        case 'APPLY_RULE_EDIT':
          applyRuleEdit(message.data.selector, message.data.property, message.data.value);
          break;

        case 'TOGGLE_CLASS':
          if (_selectedElement) {
            if (message.data.enabled) {
              _selectedElement.classList.add(message.data.className);
            } else {
              _selectedElement.classList.remove(message.data.className);
            }
          }
          break;

        case 'ADD_CLASS':
          if (_selectedElement) {
            _selectedElement.classList.add(message.data.className);
          }
          break;

        case 'RESELECT_ELEMENT':
          if (_selectedElement) {
            selectElement(_selectedElement);
          }
          break;

        case 'APPLY_HTML_EDIT':
          applyHTMLEdit(message.data.html);
          break;

        case 'REVERT_CHANGE':
          ChangeTracker.revertChange(message.data.changeId);
          break;

        case 'REAPPLY_CHANGE': {
          // Re-apply a previously reverted change by selector
          const d = message.data;
          const el = d.selectorType === 'xpath'
            ? document.evaluate(d.selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
            : document.querySelector(d.selector);
          if (el) {
            if (d.property === '__html__') {
              el.innerHTML = d.value;
              ChangeTracker.recordHTMLChange(el, d.value);
            } else {
              el.style.setProperty(d.property, d.value, 'important');
              ChangeTracker.recordCSSChange(el, d.property, d.value);
            }
          }
          break;
        }

        case 'REVERT_ALL':
          ChangeTracker.revertAll();
          break;

        case 'RESTORE_SNAPSHOT': {
          // Revert everything first, then re-apply each change from the snapshot
          ChangeTracker.revertAll();
          const snapChanges = message.data?.changes || [];
          setTimeout(() => {
            for (const change of snapChanges) {
              const el = change.selectorType === 'xpath'
                ? document.evaluate(change.selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
                : document.querySelector(change.selector);
              if (!el) continue;
              if (change.property === '__html__') {
                el.innerHTML = change.value;
                ChangeTracker.recordHTMLChange(el, change.value);
              } else {
                el.style.setProperty(change.property, change.value, 'important');
                ChangeTracker.recordCSSChange(el, change.property, change.value);
              }
            }
            chrome.runtime.sendMessage({
              type: 'SNAPSHOT_RESTORED',
              data: { count: snapChanges.length }
            }).catch(() => {});
          }, 200);
          break;
        }

        case 'TOGGLE_DIFF_MODE': {
          ChangeTracker.toggleDiffMode().then((isDiff) => {
            chrome.runtime.sendMessage({
              type: 'DIFF_MODE_STATE',
              data: { active: isDiff }
            }).catch(() => {});
          });
          break;
        }

        case 'PREVIEW_CHANGE':
          ChangeTracker.previewChange(message.data.changeId, message.data.showOriginal);
          break;

        case 'UNDO':
          ChangeTracker.undo();
          break;

        case 'REDO':
          ChangeTracker.redo();
          break;

        case 'GET_UNDO_STATE':
          ChangeTracker.broadcastUndoState();
          break;

        case 'GET_STATE':
          sendElementState();
          break;

        case 'PAGE_LOADED':
          // Page navigated — re-apply changes
          ChangeTracker.reapplyChanges();
          break;

        case 'CREATE_SNAPSHOT':
          PersistDB.createSnapshot(
            window.location.href,
            message.data?.name || ''
          ).then(() => {
            chrome.runtime.sendMessage({
              type: 'SNAPSHOT_CREATED',
              data: { url: window.location.href }
            }).catch(() => {});
          });
          break;

        case 'GET_CHANGES':
          ChangeTracker.getCurrentChanges().then(changes => {
            chrome.runtime.sendMessage({
              type: 'CHANGES_LOADED',
              data: { changes }
            }).catch(() => {});
          });
          break;

        case 'GET_HISTORY': {
          const url = window.location.href;
          Promise.all([
            ChangeTracker.getHistory(),
            PersistDB.getSnapshotsForUrl(url)
          ]).then(([history, snapshots]) => {
            // Tag snapshots so the panel can distinguish them
            const taggedSnapshots = snapshots.map(s => ({
              ...s,
              _type: 'snapshot',
            }));
            // Merge and sort by timestamp, newest first
            const merged = [...history, ...taggedSnapshots]
              .sort((a, b) => b.timestamp - a.timestamp);
            chrome.runtime.sendMessage({
              type: 'HISTORY_LOADED',
              data: { history: merged }
            }).catch(() => {});
          });
          break;
        }

        case 'SELECT_ELEMENT': {
          // Side panel asked us to find and select an element by selector
          const el = SelectorEngine.find({
            selector: message.data.selector,
            type: message.data.selectorType
          });
          if (el) {
            // Scroll into view with flash-highlight to draw user's eye
            OverlayRenderer.flashHighlight(el, 'full');
            selectElement(el);
          }
          break;
        }

        case 'HIGHLIGHT_ELEMENT': {
          // Side panel hover on breadcrumb/child — highlight without selecting
          const hlEl = SelectorEngine.find({
            selector: message.data.selector,
            type: message.data.selectorType
          });
          if (hlEl) {
            OverlayRenderer.showHighlight(hlEl, 'hover');
          }
          break;
        }

        case 'SHOW_PERSISTENT_HIGHLIGHT': {
          // HTML editor mode — show a persistent DevTools-style highlight
          const phEl = SelectorEngine.find({
            selector: message.data.selector,
            type: message.data.selectorType
          });
          if (phEl) {
            _persistentHighlightElement = phEl;
            OverlayRenderer.showHighlight(phEl, 'selected');
            // Update on scroll so the overlay tracks the element
            if (!_persistentScrollHandler) {
              _persistentScrollHandler = () => {
                if (_persistentHighlightElement && _persistentHighlightElement.isConnected) {
                  OverlayRenderer.showHighlight(_persistentHighlightElement, 'selected');
                }
              };
              window.addEventListener('scroll', _persistentScrollHandler, true);
            }
          }
          break;
        }

        case 'HIDE_PERSISTENT_HIGHLIGHT': {
          _persistentHighlightElement = null;
          if (_persistentScrollHandler) {
            window.removeEventListener('scroll', _persistentScrollHandler, true);
            _persistentScrollHandler = null;
          }
          OverlayRenderer.hideHighlight();
          break;
        }

        case 'HIGHLIGHT_BY_PATH': {
          // Hover in outer HTML tree → highlight the element on page
          const hbpEl = resolveElementByPath(
            message.data.rootSelector,
            message.data.rootSelectorType,
            message.data.indexPath
          );
          if (hbpEl) {
            OverlayRenderer.showHighlight(hbpEl, 'hover');
          }
          break;
        }

        case 'SELECT_BY_PATH': {
          // Click in outer HTML tree → select this element for editing
          const sbpEl = resolveElementByPath(
            message.data.rootSelector,
            message.data.rootSelectorType,
            message.data.indexPath
          );
          if (sbpEl) {
            selectElement(sbpEl);
          }
          break;
        }

        case 'SPA_NAV_CHECK': {
          // Backup SPA detection from webNavigation API.
          // Only act if the URL actually differs from what ChangeTracker knows.
          const trackedUrl = ChangeTracker.getCurrentUrl();
          if (message.url && message.url !== trackedUrl) {
            onSPANavigation(trackedUrl, message.url);
          }
          break;
        }

        case 'GET_PAGE_DATA': {
          const pageData = gatherPageData();
          chrome.runtime.sendMessage({
            type: 'PAGE_DATA',
            data: pageData
          }).catch(() => {});
          break;
        }
      }
    });
  }

  function sendElementState() {
    chrome.runtime.sendMessage({
      type: 'INSPECTOR_STATE',
      data: {
        active: _active,
        hasSelection: !!_selectedElement,
        url: window.location.href,
      }
    }).catch(() => {});
  }

  // ─── Utility ──────────────────────────────────────────────────────────────

  /**
   * Check if an element belongs to DesInspect's UI (avoid self-selection).
   */
  function isDesInspectElement(element) {
    if (!element) return false;
    if (element.id === 'desinspect-highlight') return true;
    if (element.closest?.('[data-desinspect-ui]')) return true;
    return false;
  }

  /**
   * Extract all aria-* attributes from an element as a compact string.
   */
  function getAriaAttributes(element) {
    const attrs = [];
    for (const attr of element.attributes) {
      if (attr.name.startsWith('aria-')) {
        attrs.push(`${attr.name}="${attr.value}"`);
      }
    }
    return attrs.length > 0 ? attrs.join(', ') : null;
  }

  /**
   * Get all CSS rules from stylesheets that match this element.
   * Returns an array of { selector, properties: { prop: value }, source }.
   * Ordered from lowest to highest specificity (last wins).
   */
  function getMatchedCSSRules(element) {
    const matched = [];
    try {
      for (const sheet of document.styleSheets) {
        // Skip our own override stylesheet
        if (sheet.ownerNode && sheet.ownerNode.id === 'desinspect-rule-overrides') continue;
        if (sheet.ownerNode && sheet.ownerNode.hasAttribute('data-desinspect')) continue;

        let rules;
        try {
          rules = sheet.cssRules || sheet.rules;
        } catch (e) {
          // Cross-origin stylesheet — skip
          continue;
        }
        if (!rules) continue;

        const source = sheet.href
          ? sheet.href.split('/').pop().substring(0, 60)
          : 'inline <style>';

        for (const rule of rules) {
          if (rule.type !== CSSRule.STYLE_RULE) continue;
          try {
            if (!element.matches(rule.selectorText)) continue;
          } catch (e) {
            continue; // Invalid selector
          }

          const properties = {};
          const style = rule.style;
          for (let i = 0; i < style.length; i++) {
            const prop = style[i];
            properties[prop] = style.getPropertyValue(prop);
          }

          if (Object.keys(properties).length > 0) {
            matched.push({
              selector: rule.selectorText.substring(0, 200),
              properties,
              source,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[DesInspect] Error reading stylesheets:', e);
    }

    // Cap at 50 rules to avoid huge payloads
    // Deduplicate by selector — merge properties from same selector
    const deduped = [];
    const selectorMap = {};
    for (const rule of matched.slice(0, 50)) {
      if (selectorMap[rule.selector]) {
        Object.assign(selectorMap[rule.selector].properties, rule.properties);
      } else {
        selectorMap[rule.selector] = { ...rule };
        deduped.push(selectorMap[rule.selector]);
      }
    }
    return deduped;
  }

  /**
   * Gather a lightweight page-level snapshot for AI audit.
   */
  function gatherPageData() {
    // Headings
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .slice(0, 30)
      .map(h => `${h.tagName}: "${h.textContent.trim().substring(0, 80)}"`)
      .join('; ');

    // Landmarks
    const landmarkSelectors = 'header,nav,main,aside,footer,section[aria-label],div[role="banner"],div[role="navigation"],div[role="main"],div[role="complementary"],div[role="contentinfo"]';
    const landmarks = Array.from(document.querySelectorAll(landmarkSelectors))
      .slice(0, 20)
      .map(el => {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const label = el.getAttribute('aria-label') || '';
        return label ? `${role}("${label}")` : role;
      })
      .join(', ');

    // Images
    const allImages = document.querySelectorAll('img');
    const imagesWithoutAlt = Array.from(allImages).filter(img => !img.hasAttribute('alt') || img.alt === '').length;

    // Visible text
    const visibleText = document.body?.innerText?.substring(0, 3000) || '';

    // HTML snapshot (stripped of scripts/styles)
    const cloneBody = document.body.cloneNode(true);
    cloneBody.querySelectorAll('script,style,noscript,[data-desinspect-ui]').forEach(el => el.remove());
    const htmlSnapshot = cloneBody.innerHTML.substring(0, 5000);

    return {
      url: window.location.href,
      title: document.title,
      headings,
      landmarks,
      totalImages: allImages.length,
      imagesWithoutAlt,
      linkCount: document.querySelectorAll('a[href]').length,
      formCount: document.querySelectorAll('form').length,
      buttonCount: document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"]').length,
      visibleText: visibleText.substring(0, 2000),
      htmlSnapshot,
    };
  }

  return {
    init,
    activate,
    deactivate,
    toggle,
    selectElement,
    deselectElement,
  };
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────

Inspector.init();

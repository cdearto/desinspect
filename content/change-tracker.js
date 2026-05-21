/**
 * DesInspect — Change Tracker
 * 
 * Monitors DOM edits made through the extension, records them to IndexedDB,
 * and re-applies persisted changes when a page loads.
 * 
 * Responsibilities:
 * - Record CSS property changes with before/after values
 * - Debounce saves at 500ms
 * - Re-apply saved changes on page load/refresh
 * - Provide change data to the side panel
 * - Support revert (single change or all)
 */

const ChangeTracker = (() => {

  const DEBOUNCE_MS = 500;
  let _saveTimers = {};   // Debounce timers keyed by change ID
  let _currentUrl = null;

  // ─── Undo / Redo Stack ──────────────────────────────────────────────────────

  const MAX_UNDO = 100;
  let _undoStack = [];  // Array of { changeId, selector, selectorType, property, prevValue, newValue, type }
  let _redoStack = [];

  // ─── Initialization ─────────────────────────────────────────────────────

  /**
   * Initialize the tracker for the current page.
   * Opens the DB and re-applies any saved changes.
   */
  async function init() {
    _currentUrl = window.location.href;
    await PersistDB.open();
    await reapplyChanges();
  }

  /**
   * Handle a client-side navigation (SPA route change).
   * Clears modified indicators for the old URL and re-applies
   * saved changes for the new URL.
   * @param {string} newUrl
   */
  async function handleNavigation(newUrl) {
    const oldNormalized = PersistDB.normalizeUrl(_currentUrl);
    const newNormalized = PersistDB.normalizeUrl(newUrl);

    // If the normalized URL hasn't changed, skip (e.g. hash-only change)
    if (oldNormalized === newNormalized) return;

    console.log(`[DesInspect] SPA navigation: ${oldNormalized} → ${newNormalized}`);

    // Reset diff mode if active
    _diffMode = false;

    // Clear all modified indicators from old page elements
    OverlayRenderer.clearAllModified();

    // Update the tracked URL
    _currentUrl = newUrl;

    // Re-apply changes for the new URL
    await reapplyChanges();
  }

  /**
   * Get the current tracked URL.
   */
  function getCurrentUrl() {
    return _currentUrl;
  }

  // ─── Record a Change ──────────────────────────────────────────────────────

  /**
   * Record a CSS property change on an element.
   * Auto-saves to IndexedDB with debouncing.
   * 
   * @param {HTMLElement} element - The modified element
   * @param {string} property - CSS property name (e.g. 'color')
   * @param {string} value - New value
   * @param {string} originalValue - Value before any DesInspect changes
   * @param {string} [annotation] - Optional user note
   */
  function recordCSSChange(element, property, value, originalValue, annotation = '') {
    const selectorInfo = SelectorEngine.generate(element);
    if (!selectorInfo.selector) {
      console.warn('[DesInspect] Could not generate selector for element:', element);
      return;
    }

    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const changeId = `${urlPattern}::${selectorInfo.selector}::${property}`;

    // Capture the current applied value BEFORE we overwrite it (for undo)
    const prevApplied = element.style.getPropertyValue(property) || '';

    const change = {
      id: changeId,
      urlPattern,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      selectorFragile: selectorInfo.fragile,
      selectorWarning: selectorInfo.warning,
      property,
      value,
      originalValue,
      previousValue: value, // Will be updated on subsequent edits
      elementTag: element.tagName.toLowerCase(),
      elementDescription: DOMSerializer.describeElement(element),
      annotation,
      timestamp: Date.now(),
    };

    // Push onto undo stack (new edit clears redo)
    pushUndo({
      changeId,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      property,
      prevValue: prevApplied,
      newValue: value,
      originalValue,
      type: 'css',
    });

    // Apply the change immediately to the DOM
    if (value === '' || value === null) {
      element.style.removeProperty(property);
    } else {
      element.style.setProperty(property, value, 'important');
    }

    // Debounced save to IndexedDB
    debouncedSave(changeId, change);

    // Notify the side panel
    notifySidePanel('CHANGE_RECORDED', change);

    // Update overlay indicator
    OverlayRenderer.markModified(element);
  }

  /**
   * Record an HTML content change on an element.
   * 
   * @param {HTMLElement} element
   * @param {string} newHTML - New innerHTML
   * @param {string} originalHTML - Original innerHTML
   */
  function recordHTMLChange(element, newHTML, originalHTML) {
    const selectorInfo = SelectorEngine.generate(element);
    if (!selectorInfo.selector) return;

    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const changeId = `${urlPattern}::${selectorInfo.selector}::__html__`;

    // Capture current innerHTML BEFORE overwrite (for undo)
    const prevApplied = element.innerHTML;

    const change = {
      id: changeId,
      urlPattern,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      selectorFragile: selectorInfo.fragile,
      property: '__html__',
      value: newHTML,
      originalValue: originalHTML,
      elementTag: element.tagName.toLowerCase(),
      elementDescription: DOMSerializer.describeElement(element),
      timestamp: Date.now(),
      type: 'html_edit',
    };

    // Push onto undo stack
    pushUndo({
      changeId,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      property: '__html__',
      prevValue: prevApplied,
      newValue: newHTML,
      originalValue: originalHTML,
      type: 'html',
    });

    element.innerHTML = newHTML;
    debouncedSave(changeId, change);
    notifySidePanel('CHANGE_RECORDED', change);
    OverlayRenderer.markModified(element);
  }

  /**
   * Record the deletion of a DOM element.
   * Stores the element's outerHTML and its position (parent selector + child index)
   * so it can be restored via undo.
   * @param {HTMLElement} element - The element to delete
   */
  function recordElementDeletion(element) {
    const selectorInfo = SelectorEngine.generate(element);
    if (!selectorInfo.selector) return;

    const parent = element.parentElement;
    if (!parent) return;

    const parentSelectorInfo = SelectorEngine.generate(parent);
    if (!parentSelectorInfo.selector) return;

    // Find the child index so we can re-insert at the same position
    const childIndex = Array.from(parent.children).indexOf(element);

    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const changeId = `${urlPattern}::${selectorInfo.selector}::__delete__`;

    const outerHTML = element.outerHTML;

    const change = {
      id: changeId,
      urlPattern,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      selectorFragile: selectorInfo.fragile,
      property: '__delete__',
      value: '__deleted__',
      originalValue: outerHTML,
      elementTag: element.tagName.toLowerCase(),
      elementDescription: DOMSerializer.describeElement(element),
      timestamp: Date.now(),
      type: 'element_delete',
    };

    // Push onto undo stack with parent info for restoration
    pushUndo({
      changeId,
      selector: selectorInfo.selector,
      selectorType: selectorInfo.type,
      property: '__delete__',
      prevValue: outerHTML,
      newValue: '__deleted__',
      originalValue: outerHTML,
      type: 'delete',
      parentSelector: parentSelectorInfo.selector,
      parentSelectorType: parentSelectorInfo.type,
      childIndex,
    });

    // Remove the element from the DOM
    OverlayRenderer.unmarkModified(element);
    OverlayRenderer.clearSelection();
    element.remove();

    debouncedSave(changeId, change);
    notifySidePanel('ELEMENT_DELETED', change);
  }

  // ─── Debounced Save ───────────────────────────────────────────────────────

  function debouncedSave(changeId, change) {
    if (_saveTimers[changeId]) {
      clearTimeout(_saveTimers[changeId]);
    }
    _saveTimers[changeId] = setTimeout(async () => {
      try {
        await PersistDB.saveChange(change);
        delete _saveTimers[changeId];
      } catch (err) {
        console.error('[DesInspect] Save failed:', err);
      }
    }, DEBOUNCE_MS);
  }

  // ─── Re-apply Changes on Page Load ────────────────────────────────────────

  /**
   * Load saved changes for the current URL and re-apply them to the DOM.
   * Called on init and on page navigation.
   */
  async function reapplyChanges() {
    try {
      const changes = await PersistDB.getChangesForUrl(_currentUrl);

      if (changes.length === 0) return;

      let applied = 0;
      let failed = 0;

      for (const change of changes) {
        if (change.selectorType === 'rule') {
          // Rule-level change: add to override stylesheet
          let sheet = document.getElementById('desinspect-rule-overrides');
          if (!sheet) {
            sheet = document.createElement('style');
            sheet.id = 'desinspect-rule-overrides';
            sheet.setAttribute('data-desinspect', 'true');
            document.head.appendChild(sheet);
          }
          const ss = sheet.sheet;
          // Find existing rule for this selector
          let existingRule = null;
          for (let i = 0; i < ss.cssRules.length; i++) {
            if (ss.cssRules[i].selectorText === change.selector) {
              existingRule = ss.cssRules[i];
              break;
            }
          }
          if (existingRule) {
            existingRule.style.setProperty(change.property, change.value, 'important');
          } else {
            try {
              ss.insertRule(`${change.selector} { ${change.property}: ${change.value} !important; }`, ss.cssRules.length);
            } catch (e) {
              failed++;
              continue;
            }
          }
          applied++;
          continue;
        }

        const element = SelectorEngine.find({
          selector: change.selector,
          type: change.selectorType
        });

        if (element) {
          if (change.property === '__html__') {
            element.innerHTML = change.value;
          } else {
            element.style.setProperty(change.property, change.value);
          }
          OverlayRenderer.markModified(element);
          applied++;
        } else {
          failed++;
          console.warn(`[DesInspect] Could not find element for selector: ${change.selector}`);
        }
      }

      console.log(`[DesInspect] Re-applied ${applied} changes (${failed} failed) for ${PersistDB.normalizeUrl(_currentUrl)}`);

      // Send all changes to side panel
      notifySidePanel('CHANGES_LOADED', { changes, applied, failed });

    } catch (err) {
      console.error('[DesInspect] Error re-applying changes:', err);
    }
  }

  // ─── Revert ───────────────────────────────────────────────────────────────

  /**
   * Revert a single change back to its original value.
   * @param {string} changeId
   */
  async function revertChange(changeId) {
    const change = await PersistDB.getChange(changeId);
    if (!change) return;

    if (change.selectorType === 'rule') {
      // Rule-level change: remove from our override stylesheet
      const sheet = document.getElementById('desinspect-rule-overrides');
      if (sheet && sheet.sheet) {
        const ss = sheet.sheet;
        for (let i = 0; i < ss.cssRules.length; i++) {
          if (ss.cssRules[i].selectorText === change.selector) {
            ss.cssRules[i].style.removeProperty(change.property);
            if (ss.cssRules[i].style.length === 0) {
              ss.deleteRule(i);
            }
            break;
          }
        }
      }
    } else {
      const element = SelectorEngine.find({
        selector: change.selector,
        type: change.selectorType
      });

      if (element) {
        if (change.property === '__html__') {
          element.innerHTML = change.originalValue;
        } else {
          // Remove the inline style to fall back to original
          element.style.removeProperty(change.property);
        }
        OverlayRenderer.unmarkModified(element);
      }
    }

    await PersistDB.deleteChange(changeId);
    notifySidePanel('CHANGE_REVERTED', { changeId });
  }

  /**
   * Revert all changes for the current URL.
   */
  async function revertAll() {
    const changes = await PersistDB.getChangesForUrl(_currentUrl);

    for (const change of changes) {
      if (change.selectorType === 'rule') {
        // Rule-level: handled by removing the override stylesheet entirely
        continue;
      }
      const element = SelectorEngine.find({
        selector: change.selector,
        type: change.selectorType
      });

      if (element) {
        if (change.property === '__html__') {
          element.innerHTML = change.originalValue;
        } else {
          element.style.removeProperty(change.property);
        }
        OverlayRenderer.unmarkModified(element);
      }
    }

    // Remove the entire rule overrides stylesheet
    const sheet = document.getElementById('desinspect-rule-overrides');
    if (sheet) sheet.remove();

    await PersistDB.clearChangesForUrl(_currentUrl);
    notifySidePanel('ALL_CHANGES_REVERTED', {});
  }

  // ─── Undo / Redo Operations ──────────────────────────────────────────────

  const UNDO_COALESCE_MS = 1000; // Merge edits to same property within this window
  let _lastUndoPush = { changeId: null, timestamp: 0 };

  function pushUndo(entry) {
    const now = Date.now();

    // Coalesce: if the last undo entry targets the same changeId within
    // the coalesce window, update it in-place instead of adding a new one.
    // This groups rapid edits (e.g. color picker dragging, typing) into
    // a single undoable action.
    if (
      _undoStack.length > 0 &&
      _lastUndoPush.changeId === entry.changeId &&
      (now - _lastUndoPush.timestamp) < UNDO_COALESCE_MS
    ) {
      // Update the top entry's newValue but keep the original prevValue
      const top = _undoStack[_undoStack.length - 1];
      top.newValue = entry.newValue;
      _lastUndoPush.timestamp = now;
      // Still clear redo since the value changed
      _redoStack = [];
      broadcastUndoState();
      return;
    }

    _undoStack.push(entry);
    if (_undoStack.length > MAX_UNDO) _undoStack.shift();
    _redoStack = []; // New action invalidates redo history
    _lastUndoPush = { changeId: entry.changeId, timestamp: now };
    broadcastUndoState();
  }

  /**
   * Undo the most recent change.
   * Restores the element to its previous value and updates IndexedDB.
   */
  async function undo() {
    if (_undoStack.length === 0) return;

    const entry = _undoStack.pop();
    const element = SelectorEngine.find({
      selector: entry.selector,
      type: entry.selectorType
    });

    if (element) {
      if (entry.property === '__html__') {
        element.innerHTML = entry.prevValue;
      } else if (entry.property === '__delete__') {
        // Delete undo is handled below — element won't exist since it was removed
      } else {
        if (entry.prevValue) {
          element.style.setProperty(entry.property, entry.prevValue);
        } else {
          element.style.removeProperty(entry.property);
        }
      }
    }

    // Special handling for element deletion undo: re-insert the element
    if (entry.type === 'delete' && entry.parentSelector) {
      const parent = SelectorEngine.find({
        selector: entry.parentSelector,
        type: entry.parentSelectorType
      });
      if (parent && entry.prevValue) {
        // Create a temporary container to parse the outerHTML
        const temp = document.createElement('div');
        temp.innerHTML = entry.prevValue;
        const restored = temp.firstElementChild;
        if (restored) {
          // Re-insert at the original position
          const children = Array.from(parent.children);
          if (entry.childIndex >= 0 && entry.childIndex < children.length) {
            parent.insertBefore(restored, children[entry.childIndex]);
          } else {
            parent.appendChild(restored);
          }
          OverlayRenderer.markModified(restored);
        }
      }
      await PersistDB.deleteChange(entry.changeId);
      _redoStack.push(entry);
      broadcastUndoState();
      notifySidePanel('UNDO_PERFORMED', { entry });
      return;
    }

    // Update IndexedDB: if prevValue matches originalValue, delete the change
    // Otherwise update to the previous value
    if (entry.prevValue === '' || entry.prevValue === entry.originalValue) {
      await PersistDB.deleteChange(entry.changeId);
      if (element) OverlayRenderer.unmarkModified(element);
    } else {
      // Update the stored change to reflect the undo'd value
      const existing = await PersistDB.getChange(entry.changeId);
      if (existing) {
        existing.value = entry.prevValue;
        existing.timestamp = Date.now();
        await PersistDB.saveChange(existing);
      }
    }

    _redoStack.push(entry);
    broadcastUndoState();
    notifySidePanel('UNDO_PERFORMED', { entry });
  }

  /**
   * Redo the most recently undone change.
   */
  async function redo() {
    if (_redoStack.length === 0) return;

    const entry = _redoStack.pop();
    const element = SelectorEngine.find({
      selector: entry.selector,
      type: entry.selectorType
    });

    if (element) {
      if (entry.property === '__html__') {
        element.innerHTML = entry.newValue;
      } else if (entry.type === 'delete') {
        // Re-delete the element
        OverlayRenderer.unmarkModified(element);
        OverlayRenderer.clearSelection();
        element.remove();
        // Save deletion to IndexedDB
        const urlPattern = PersistDB.normalizeUrl(_currentUrl);
        const change = {
          id: entry.changeId,
          urlPattern,
          selector: entry.selector,
          selectorType: entry.selectorType,
          property: '__delete__',
          value: '__deleted__',
          originalValue: entry.originalValue,
          timestamp: Date.now(),
          type: 'element_delete',
        };
        await PersistDB.saveChange(change);
        _undoStack.push(entry);
        broadcastUndoState();
        notifySidePanel('REDO_PERFORMED', { entry });
        return;
      } else {
        element.style.setProperty(entry.property, entry.newValue);
      }
      OverlayRenderer.markModified(element);
    }

    // Save/update in IndexedDB
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const change = {
      id: entry.changeId,
      urlPattern,
      selector: entry.selector,
      selectorType: entry.selectorType,
      property: entry.property,
      value: entry.newValue,
      originalValue: entry.originalValue,
      timestamp: Date.now(),
    };
    await PersistDB.saveChange(change);

    _undoStack.push(entry);
    broadcastUndoState();
    notifySidePanel('REDO_PERFORMED', { entry });
  }

  /**
   * Broadcast current undo/redo availability to the side panel.
   */
  function broadcastUndoState() {
    notifySidePanel('UNDO_STATE', {
      canUndo: _undoStack.length > 0,
      canRedo: _redoStack.length > 0,
      undoCount: _undoStack.length,
      redoCount: _redoStack.length,
    });
  }

  // ─── Diff Mode ─────────────────────────────────────────────────────────────

  let _diffMode = false; // true = showing originals, false = showing modifications

  /**
   * Toggle diff mode: flip ALL changes between original and modified state.
   * Returns the new diff mode state.
   */
  async function toggleDiffMode() {
    _diffMode = !_diffMode;
    const changes = await PersistDB.getChangesForUrl(_currentUrl);

    for (const change of changes) {
      const element = SelectorEngine.find({
        selector: change.selector,
        type: change.selectorType
      });
      if (!element) continue;

      if (_diffMode) {
        // Show originals
        if (change.property === '__html__') {
          element.setAttribute('data-desinspect-modified-html', change.value);
          element.innerHTML = change.originalValue;
        } else {
          element.setAttribute(`data-desinspect-mod-${change.property}`, change.value);
          element.style.removeProperty(change.property);
        }
      } else {
        // Restore modifications
        if (change.property === '__html__') {
          element.innerHTML = change.value;
          element.removeAttribute('data-desinspect-modified-html');
        } else {
          element.style.setProperty(change.property, change.value);
          element.removeAttribute(`data-desinspect-mod-${change.property}`);
        }
      }
    }

    return _diffMode;
  }

  /**
   * Preview a single change in its original or modified state.
   * @param {string} changeId
   * @param {boolean} showOriginal - true to show original, false to show modified
   */
  async function previewChange(changeId, showOriginal) {
    const change = await PersistDB.getChange(changeId);
    if (!change) return;

    const element = SelectorEngine.find({
      selector: change.selector,
      type: change.selectorType
    });
    if (!element) return;

    if (showOriginal) {
      if (change.property === '__html__') {
        element.innerHTML = change.originalValue;
      } else {
        element.style.removeProperty(change.property);
      }
    } else {
      if (change.property === '__html__') {
        element.innerHTML = change.value;
      } else {
        element.style.setProperty(change.property, change.value);
      }
    }
  }

  /**
   * Get current diff mode state.
   */
  function isDiffMode() {
    return _diffMode;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  /**
   * Get all current changes for display in the side panel.
   */
  async function getCurrentChanges() {
    return PersistDB.getChangesForUrl(_currentUrl);
  }

  /**
   * Get version history for current URL.
   */
  async function getHistory(limit = 50) {
    return PersistDB.getHistoryForUrl(_currentUrl, limit);
  }

  // ─── Communication ────────────────────────────────────────────────────────

  function notifySidePanel(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {
      // Side panel may not be open — that's fine
    });
  }

  /**
   * Re-mark elements that have saved changes without re-applying the CSS.
   * Used when re-activating the inspector after deactivation cleared markers.
   */
  async function reapplyModifiedMarkers() {
    try {
      const changes = await PersistDB.getChangesForUrl(_currentUrl);
      for (const change of changes) {
        if (change.property === '__delete__') continue; // deleted elements aren't in DOM
        const element = SelectorEngine.find({
          selector: change.selector,
          type: change.selectorType
        });
        if (element) {
          OverlayRenderer.markModified(element);
        }
      }
    } catch (err) {
      console.warn('[DesInspect] Could not re-mark modified elements:', err);
    }
  }

  /**
   * Record a rule-level CSS change (applies to all elements matching a selector).
   * Stored separately from element-specific changes.
   */
  function recordRuleChange(selector, property, value) {
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const changeId = `${urlPattern}::rule::${selector}::${property}`;

    const change = {
      id: changeId,
      urlPattern,
      selector: selector,
      selectorType: 'rule',
      property,
      value,
      elementTag: 'rule',
      elementDescription: `Rule: ${selector}`,
      timestamp: Date.now(),
    };

    // Push undo entry
    pushUndo({
      changeId,
      selector,
      selectorType: 'rule',
      property,
      prevValue: '',
      newValue: value,
      type: 'rule',
    });

    // Debounced save
    debouncedSave(changeId, change);

    // Notify side panel
    notifySidePanel('CHANGE_RECORDED', change);
  }

  return {
    init,
    recordCSSChange,
    recordHTMLChange,
    recordRuleChange,
    recordElementDeletion,
    reapplyChanges,
    reapplyModifiedMarkers,
    revertChange,
    revertAll,
    undo,
    redo,
    broadcastUndoState,
    toggleDiffMode,
    previewChange,
    isDiffMode,
    handleNavigation,
    getCurrentUrl,
    getCurrentChanges,
    getHistory,
  };
})();

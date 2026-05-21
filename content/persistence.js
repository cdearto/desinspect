/**
 * DesInspect — Persistence runtime.
 *
 * Wraps PersistDB with: re-apply on load, debounced writes, SPA navigation
 * handling, and a single "user-overrides" stylesheet that holds every
 * applied edit so the page's own CSS can't fight us with !important.
 */

const Persistence = (() => {
  const DEBOUNCE_MS = 300;
  const STYLESHEET_ID = 'desinspect-overrides';
  let _currentUrl = location.href;
  let _saveTimers = new Map();
  let _cache = new Map(); // id → record (in-memory mirror)

  function getStylesheet() {
    let el = document.getElementById(STYLESHEET_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLESHEET_ID;
      el.setAttribute('data-desinspect', 'true');
      // Put it last so it wins specificity ties from other authors.
      document.documentElement.appendChild(el);
    }
    return el.sheet;
  }

  /**
   * One CSS rule per (selector, property) so toggling one property doesn't
   * affect others. We build a deterministic selector key by stuffing the
   * property name into a data-attribute we never read.
   *
   * The rule itself targets the user's selector with !important — that's
   * the whole point of the override sheet.
   */
  function applyRuleToSheet(record) {
    const sheet = getStylesheet();
    const ruleSelector = record.selector;
    const cssText = `${ruleSelector} { ${record.property}: ${record.value} !important; }`;

    // Find existing rule for this (selector, property)
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (
        r.selectorText === ruleSelector &&
        r.style.length === 1 &&
        r.style[0] === record.property
      ) {
        sheet.deleteRule(i);
      }
    }

    if (record.disabled) return;
    try {
      sheet.insertRule(cssText, sheet.cssRules.length);
    } catch (err) {
      console.warn('[DesInspect] insertRule failed:', cssText, err);
    }
  }

  function removeRuleFromSheet(selector, property) {
    const sheet = getStylesheet();
    for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
      const r = sheet.cssRules[i];
      if (
        r.selectorText === selector &&
        r.style.length === 1 &&
        r.style[0] === property
      ) {
        sheet.deleteRule(i);
      }
    }
  }

  function applyHtmlChange(record) {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (!el) return false;
    // The value is the outerHTML of the new element. outerHTML assignment
    // replaces the node entirely; if the new markup is a parse error,
    // fall back to innerHTML so we don't blow up the document.
    try {
      const tmpl = document.createElement('template');
      tmpl.innerHTML = record.value;
      const newEl = tmpl.content.firstElementChild;
      if (newEl) {
        el.replaceWith(newEl);
        return true;
      }
      el.innerHTML = record.value;
    } catch {
      el.innerHTML = record.value;
    }
    return true;
  }

  function applyRemoveChange(record) {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (el) el.remove();
    return !!el;
  }

  function applyInlineStyle(record) {
    const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
    if (!el) return false;
    if (record.disabled || record.value === '' || record.value == null) {
      el.style.removeProperty(record.property);
    } else {
      el.style.setProperty(record.property, record.value, 'important');
    }
    return true;
  }

  /**
   * Apply a saved record to the live DOM.
   */
  function applyRecord(record) {
    if (record.property === '__html__') return applyHtmlChange(record);
    if (record.property === '__remove__') return applyRemoveChange(record);
    // CSS rule selectors only work in stylesheets; XPath has to go inline.
    if (record.selectorType === 'xpath') return applyInlineStyle(record);
    applyRuleToSheet(record);
    return true;
  }

  async function init() {
    await PersistDB.open();
    _currentUrl = location.href;
    await reapply();

    // SPA navigation: monkey-patch history + listen to popstate/onHistoryStateUpdated
    const onNav = () => {
      const newUrl = location.href;
      if (PersistDB.normalizeUrl(newUrl) === PersistDB.normalizeUrl(_currentUrl)) return;
      _currentUrl = newUrl;
      // Wait one tick so SPA frameworks finish their re-render
      setTimeout(reapply, 50);
      setTimeout(reapply, 300);
    };
    const _push = history.pushState;
    history.pushState = function () {
      const r = _push.apply(this, arguments);
      onNav();
      return r;
    };
    const _replace = history.replaceState;
    history.replaceState = function () {
      const r = _replace.apply(this, arguments);
      onNav();
      return r;
    };
    window.addEventListener('popstate', onNav);

    // Watch for DOM mutations on persistent SPAs: if a selector wasn't
    // present at first re-apply, retry after the DOM settles.
    const mo = new MutationObserver(
      debounce(() => {
        reapply({ silent: true });
      }, 500)
    );
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  async function reapply({ silent } = {}) {
    try {
      const records = await PersistDB.getChangesForUrl(_currentUrl);
      _cache.clear();
      // Reset our stylesheet
      const sheet = getStylesheet();
      while (sheet.cssRules.length) sheet.deleteRule(0);

      for (const r of records) {
        _cache.set(r.id, r);
        applyRecord(r);
      }
      if (!silent) {
        notifyPanel('CHANGES_LOADED', { url: _currentUrl, changes: records });
      }
    } catch (err) {
      console.error('[DesInspect] reapply failed:', err);
    }
  }

  /**
   * Save (debounced) and apply immediately.
   */
  function saveChange(input) {
    const urlPattern = PersistDB.normalizeUrl(_currentUrl);
    const id = input.id || `${urlPattern}::${input.selector}::${input.property}`;
    const record = {
      ...input,
      id,
      urlPattern,
      timestamp: Date.now(),
    };
    _cache.set(id, record);
    applyRecord(record);

    if (_saveTimers.has(id)) clearTimeout(_saveTimers.get(id));
    _saveTimers.set(
      id,
      setTimeout(async () => {
        try {
          await PersistDB.putChange(record);
          _saveTimers.delete(id);
          notifyPanel('CHANGE_SAVED', { id });
        } catch (err) {
          console.error('[DesInspect] save failed:', err);
        }
      }, DEBOUNCE_MS)
    );
    return record;
  }

  async function deleteChange(id) {
    const record = _cache.get(id) || (await PersistDB.getChange(id));
    if (!record) return;
    _cache.delete(id);
    if (record.property === '__html__' || record.property === '__remove__') {
      // can't undo HTML edit without storing original; we stored originalValue
      const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
      if (el && record.property === '__html__' && record.originalValue != null) {
        el.innerHTML = record.originalValue;
      }
      // __remove__ revert is best-effort: we don't reinsert the node here
    } else if (record.selectorType === 'xpath') {
      const el = SelectorEngine.find({ type: record.selectorType, value: record.selector });
      if (el) el.style.removeProperty(record.property);
    } else {
      removeRuleFromSheet(record.selector, record.property);
    }
    await PersistDB.deleteChange(id);
    notifyPanel('CHANGE_DELETED', { id });
  }

  async function clearAll() {
    const n = await PersistDB.clearChangesForUrl(_currentUrl);
    const sheet = getStylesheet();
    while (sheet.cssRules.length) sheet.deleteRule(0);
    _cache.clear();
    notifyPanel('ALL_CLEARED', { count: n });
  }

  function getCurrentChanges() {
    return Array.from(_cache.values()).sort((a, b) => a.timestamp - b.timestamp);
  }

  function notifyPanel(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {});
  }

  return {
    init,
    saveChange,
    deleteChange,
    clearAll,
    reapply,
    getCurrentChanges,
  };
})();

if (typeof window !== 'undefined') window.Persistence = Persistence;

/**
 * DesInspect — Styles engine.
 *
 * Snapshots an element's matched CSS rules + computed values + box-model
 * for the side panel, and forces pseudo-states (:hov). Cross-origin
 * stylesheets throw on .cssRules access, so their text is fetched through
 * the service worker and replayed into a constructed CSSStyleSheet.
 */

const StylesEngine = (() => {
  function safeRules(sheet) {
    try {
      return sheet.cssRules;
    } catch {
      return null;
    }
  }

  function sheetSource(sheet) {
    if (!sheet) return 'unknown';
    if (sheet.href) {
      try {
        const u = new URL(sheet.href);
        return u.pathname.split('/').pop() || sheet.href;
      } catch {
        return sheet.href;
      }
    }
    return 'inline';
  }

  /** The declaration block of a rule's cssText (between the outer braces). */
  function ruleBody(cssText) {
    return cssText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '');
  }

  /**
   * Split a declaration block into { name, value, important } tuples.
   * Tracks quote state so `content: "a;b"` and quoted parens don't corrupt
   * the split; parens count only outside strings (url(data:…;base64) safe).
   */
  function parseProps(body) {
    const out = [];
    if (!body) return out;
    let depth = 0;
    let quote = null; // active quote char or null
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        cur += ch;
        if (ch === '\\') {
          // keep escaped char verbatim, don't let it terminate the string
          if (i + 1 < body.length) { cur += body[++i]; }
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        cur += ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ';' && depth === 0) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out
      .map((decl) => {
        const i = decl.indexOf(':');
        if (i < 0) return null;
        let value = decl.slice(i + 1).trim();
        const important = /!important\s*$/i.test(value);
        if (important) value = value.replace(/!important\s*$/i, '').trim();
        return {
          name: decl.slice(0, i).trim().toLowerCase(),
          value,
          important,
        };
      })
      .filter(Boolean);
  }

  function inlineRule(el) {
    return { properties: parseProps(el.getAttribute('style') || '') };
  }

  // Dynamic pseudo-classes / pseudo-elements that depend on user state and
  // shouldn't gate visibility in the Styles panel — DevTools shows these
  // rules even when the element isn't currently in that state.
  const DYNAMIC_PSEUDOS = [
    'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
    'link', 'disabled', 'enabled', 'checked', 'indeterminate', 'default',
    'placeholder-shown', 'autofill', 'read-only', 'read-write',
    'valid', 'invalid', 'in-range', 'out-of-range', 'required', 'optional',
    'user-invalid', 'target', 'scope', 'host', 'fullscreen',
  ];
  // Matches any dynamic pseudo-class or any pseudo-element. Longest-first +
  // boundary guard so ':focus' can't half-match ':focus-visible'.
  const STATE_PSEUDO_RE = new RegExp(
    `(?:::[\\w-]+|:(?:${[...DYNAMIC_PSEUDOS].sort((a, b) => b.length - a.length).join('|')})(?![\\w-]))(?:\\([^)]*\\))?`,
    'gi'
  );

  function tryMatch(el, selector) {
    try { return el.matches(selector); } catch { return false; }
  }

  /**
   * Does `el` match `selector`? Returns '' for a plain match, the stripped
   * state pseudos (e.g. ':hover', '::before') if it only matches without
   * them, or null for no match.
   */
  function matchPseudo(el, selector) {
    if (tryMatch(el, selector)) return '';
    const stripped = [];
    const base = selector.replace(STATE_PSEUDO_RE, (m) => (stripped.push(m), '')).trim();
    return stripped.length && base && tryMatch(el, base) ? stripped.join('') : null;
  }

  // Cross-origin stylesheets throw on .cssRules access. Fetch their text via
  // the service worker (content-script fetches are subject to the page's
  // CORS policy; the worker's are not) and replay it into a constructed
  // CSSStyleSheet whose rules we can walk.
  const FAIL_RETRY_MS = 15000;
  const _xoSheets = new Map(); // href → Promise<CSSStyleSheet | null>

  function fetchAsStylesheet(href) {
    if (!_xoSheets.has(href)) {
      const load = chrome.runtime
        .sendMessage({ type: 'FETCH_TEXT', url: href })
        .then((r) => {
          if (!r?.ok) throw new Error(r?.error || 'fetch failed');
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(r.text);
          return sheet;
        })
        .catch(() => {
          // Retry later rather than hiding the sheet for the page lifetime.
          setTimeout(() => _xoSheets.delete(href), FAIL_RETRY_MS);
          return null;
        });
      _xoSheets.set(href, load);
    }
    return _xoSheets.get(href);
  }

  // ─── Stylesheet walking ────────────────────────────────────────────────────

  function mediaApplies(media) {
    return !media?.mediaText || window.matchMedia(media.mediaText).matches;
  }

  /**
   * Visit every active CSSStyleRule under `rules`, descending into @media
   * and @supports blocks that currently apply, @layer/@container blocks,
   * and @imports. Sheets we can't read are pushed onto `unreadable`.
   */
  function walkRules(rules, visit, unreadable, source, media = '') {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        visit(rule, source, media);
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet && mediaApplies(rule.media)) walkSheet(rule.styleSheet, visit, unreadable);
      } else if (rule instanceof CSSMediaRule) {
        if (mediaApplies(rule.media)) {
          walkRules(rule.cssRules, visit, unreadable, source, `@media ${rule.media.mediaText}`);
        }
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) walkRules(rule.cssRules, visit, unreadable, source, media);
      } else if (rule.cssRules) {
        walkRules(rule.cssRules, visit, unreadable, source, media);
      }
    }
  }

  function walkSheet(sheet, visit, unreadable) {
    // Skip our own sheets (overrides, forced states) and inactive ones.
    if (sheet.ownerNode?.hasAttribute?.('data-desinspect')) return;
    if (sheet.disabled || !mediaApplies(sheet.media)) return;
    const rules = safeRules(sheet);
    if (rules) walkRules(rules, visit, unreadable, sheetSource(sheet));
    else if (sheet.href) unreadable.push(sheet);
  }

  /**
   * Call visit(rule, source, media) for every active author style rule on
   * the page, fetching cross-origin sheets as needed.
   */
  async function walkAllSheets(visit) {
    const unreadable = [];
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      walkSheet(sheet, visit, unreadable);
    }
    const fetched = await Promise.all(unreadable.map((sheet) => fetchAsStylesheet(sheet.href)));
    fetched.forEach((synth, i) => {
      // Constructed sheets drop @import rules, so there is nothing further to fetch.
      if (synth) walkRules(synth.cssRules, visit, [], `${sheetSource(unreadable[i])} (xo)`);
    });
  }

  async function matchedRules(el) {
    const out = [];
    await walkAllSheets((rule, source, media) => {
      const pseudo = matchPseudo(el, rule.selectorText);
      if (pseudo === null) return;
      out.push({
        selector: rule.selectorText,
        pseudo: pseudo || null,
        source: media ? `${source} ${media}` : source,
        properties: parseProps(ruleBody(rule.cssText)),
      });
    });
    return out;
  }

  // ─── Force element state (:hov) ────────────────────────────────────────────
  //
  // DevTools can force :hover/:focus/etc. through the CDP; from a content
  // script we approximate: collect every author rule whose selector uses a
  // forced pseudo, rewrite that pseudo to a marker class
  // (:hover → .desinspect-fs-hover), install the rewritten rules in an
  // ephemeral (never persisted) stylesheet, and add the marker classes to
  // the target element. Descendant rules like `.btn:hover .icon` work
  // naturally because the class lands on the element the pseudo targeted.

  const FORCEABLE = ['hover', 'focus', 'focus-within', 'focus-visible', 'active'];
  const FORCED_SHEET_ID = 'desinspect-forced-states';
  const forcedClass = (state) => `desinspect-fs-${state}`;
  let _forcedEl = null;

  /** `.btn:hover` → `.btn.desinspect-fs-hover`, or null if no forced pseudo is used. */
  function rewriteSelectorForStates(selector, states) {
    const re = new RegExp(`:(${states.join('|')})(?![\\w-])`, 'g');
    const out = selector.replace(re, (_, state) => `.${forcedClass(state)}`);
    return out === selector ? null : out;
  }

  function clearForcedClasses(el) {
    el.classList.remove(...FORCEABLE.map(forcedClass));
    // Don't leave an empty class="" behind — it would change the element's outerHTML.
    if (!el.classList.length) el.removeAttribute('class');
  }

  /**
   * Force pseudo-states on an element. `states` is the full desired set —
   * pass [] to clear. Only one element carries forced states at a time.
   */
  async function forceStates(el, states) {
    states = states.filter((s) => FORCEABLE.includes(s));
    if (_forcedEl) clearForcedClasses(_forcedEl);
    _forcedEl = el && states.length ? el : null;

    let sheetEl = document.getElementById(FORCED_SHEET_ID);
    if (!_forcedEl) {
      if (sheetEl) sheetEl.textContent = '';
      return;
    }
    if (!sheetEl) {
      sheetEl = document.createElement('style');
      sheetEl.id = FORCED_SHEET_ID;
      sheetEl.setAttribute('data-desinspect', 'true');
      document.documentElement.appendChild(sheetEl);
    }

    const css = [];
    await walkAllSheets((rule) => {
      const rewritten = rewriteSelectorForStates(rule.selectorText, states);
      if (rewritten) css.push(`${rewritten} { ${ruleBody(rule.cssText)} }`);
    });
    if (_forcedEl !== el) return; // selection changed while sheets were loading
    sheetEl.textContent = css.join('\n');
    el.classList.add(...states.map(forcedClass));
  }

  function computedSnapshot(el) {
    const cs = window.getComputedStyle(el);
    const out = {};
    for (let i = 0; i < cs.length; i++) {
      const p = cs[i];
      out[p] = cs.getPropertyValue(p);
    }
    return out;
  }

  function boxModel(el) {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const num = (s) => parseFloat(s) || 0;
    return {
      content: {
        width: rect.width - num(cs.paddingLeft) - num(cs.paddingRight) - num(cs.borderLeftWidth) - num(cs.borderRightWidth),
        height: rect.height - num(cs.paddingTop) - num(cs.paddingBottom) - num(cs.borderTopWidth) - num(cs.borderBottomWidth),
      },
      padding: {
        top: num(cs.paddingTop),
        right: num(cs.paddingRight),
        bottom: num(cs.paddingBottom),
        left: num(cs.paddingLeft),
      },
      border: {
        top: num(cs.borderTopWidth),
        right: num(cs.borderRightWidth),
        bottom: num(cs.borderBottomWidth),
        left: num(cs.borderLeftWidth),
      },
      margin: {
        top: num(cs.marginTop),
        right: num(cs.marginRight),
        bottom: num(cs.marginBottom),
        left: num(cs.marginLeft),
      },
      rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
    };
  }

  return {
    inlineRule,
    matchedRules,
    computedSnapshot,
    boxModel,
    forceStates,
  };
})();

if (typeof window !== 'undefined') window.StylesEngine = StylesEngine;

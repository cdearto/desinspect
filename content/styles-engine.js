/**
 * DesInspect — Styles engine.
 *
 * Snapshots an element's matched CSS rules + computed values + box-model
 * for the side panel. Iterates document.styleSheets to find rules whose
 * selectors match the element. Cross-origin stylesheets throw on
 * .cssRules access — we silently skip them.
 */

const StylesEngine = (() => {
  function safeRules(sheet) {
    try {
      return sheet.cssRules || sheet.rules || null;
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

  function parseProps(cssText) {
    // Split a rule body into individual { prop, value, important } tuples.
    const out = [];
    if (!cssText) return out;
    const body = cssText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '');
    // naive split on ; that isn't in parens
    let depth = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
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
    const props = parseProps('x{' + el.getAttribute('style') + '}');
    return {
      kind: 'inline',
      selector: 'element.style',
      source: 'inline',
      origin: 'inline',
      properties: props,
    };
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
  const DYNAMIC_RE = new RegExp(`:(?:${DYNAMIC_PSEUDOS.join('|')})(?:\\([^)]*\\))?`, 'gi');
  const PSEUDO_ELEMENT_RE = /::[a-zA-Z-]+(?:\([^)]*\))?/g;

  function stripDynamicPseudos(selector) {
    return selector.replace(DYNAMIC_RE, '').replace(PSEUDO_ELEMENT_RE, '').trim();
  }
  function pseudoLabelFor(selector) {
    const m = selector.match(/(:{1,2}[a-zA-Z-]+(?:\([^)]*\))?)/g);
    if (!m) return null;
    // Return only dynamic ones, joined
    const dyn = m.filter((p) => {
      const name = p.replace(/^:+/, '').replace(/\(.*$/, '');
      return DYNAMIC_PSEUDOS.includes(name) || p.startsWith('::');
    });
    return dyn.length ? dyn.join('') : null;
  }

  function tryMatch(el, selector) {
    try { return el.matches(selector); } catch { return false; }
  }

  /**
   * Does `el` match `selector` either directly, or with dynamic pseudos
   * stripped? Returns { match, pseudo } where pseudo is the stripped part
   * (e.g. ':hover', '::before') or null.
   */
  function matchPossiblyWithPseudo(el, selector) {
    if (tryMatch(el, selector)) return { match: true, pseudo: null };
    const stripped = stripDynamicPseudos(selector);
    if (!stripped || stripped === selector) return { match: false, pseudo: null };
    if (tryMatch(el, stripped)) {
      return { match: true, pseudo: pseudoLabelFor(selector) };
    }
    return { match: false, pseudo: null };
  }

  function pushStyleRule(out, rule, el, sheet, src, mediaSuffix) {
    const { match, pseudo } = matchPossiblyWithPseudo(el, rule.selectorText);
    if (!match) return;
    out.push({
      kind: 'rule',
      selector: rule.selectorText,
      pseudo,
      source: mediaSuffix ? `${src} ${mediaSuffix}` : src,
      origin: sheet.ownerNode?.id === 'desinspect-overrides' ? 'desinspect' : 'author',
      properties: parseProps(rule.cssText),
    });
  }

  // Cross-origin stylesheets throw on .cssRules access. Fetch the text
  // (the extension's host_permissions bypass CORS for content-script fetches)
  // and replay it into a constructible CSSStyleSheet so we can walk its rules.
  const _xoSheetCache = new Map();   // href → CSSStyleSheet (or null on failure)
  const _xoSheetPending = new Map(); // href → Promise

  // Try a same-origin fetch from the content script first (fastest, no SW
  // round-trip). For cross-origin sheets that the page's CORS policy forbids,
  // fall back to the service worker, which has extension-level fetch
  // privileges via the manifest's host_permissions.
  function fetchViaSW(url) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'FETCH_TEXT', url }, (r) => {
          if (chrome.runtime.lastError || !r?.ok) {
            resolve(null);
            return;
          }
          resolve(r.text);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function fetchStylesheetText(href) {
    try {
      const res = await fetch(href, { credentials: 'omit' });
      if (res.ok) return await res.text();
    } catch {
      /* CORS or network — fall through to SW */
    }
    return fetchViaSW(href);
  }

  async function fetchAsStylesheet(href) {
    if (_xoSheetCache.has(href)) return _xoSheetCache.get(href);
    if (_xoSheetPending.has(href)) return _xoSheetPending.get(href);
    const p = (async () => {
      const text = await fetchStylesheetText(href);
      if (!text) {
        _xoSheetCache.set(href, null);
        return null;
      }
      try {
        const synth = new CSSStyleSheet();
        synth.replaceSync(text);
        _xoSheetCache.set(href, synth);
        return synth;
      } catch {
        _xoSheetCache.set(href, null);
        return null;
      } finally {
        _xoSheetPending.delete(href);
      }
    })();
    _xoSheetPending.set(href, p);
    return p;
  }

  async function matchedRules(el) {
    const out = [];
    const sheets = Array.from(document.styleSheets);

    // First pass: same-origin sheets (sync).
    const xoTargets = [];
    for (const sheet of sheets) {
      const rules = safeRules(sheet);
      const src = sheetSource(sheet);
      if (rules) {
        walkRules(out, rules, el, sheet, src, '');
      } else if (sheet.href) {
        xoTargets.push({ sheet, src });
      }
    }

    // Second pass: cross-origin sheets, fetched in parallel.
    if (xoTargets.length) {
      const fetched = await Promise.all(
        xoTargets.map(({ sheet }) => fetchAsStylesheet(sheet.href))
      );
      for (let i = 0; i < xoTargets.length; i++) {
        const synth = fetched[i];
        if (!synth) continue;
        const { sheet, src } = xoTargets[i];
        walkRules(out, synth.cssRules, el, sheet, src + ' (xo)', '');
      }
    }
    return out;
  }

  function walkRules(out, rules, el, sheet, src, mediaSuffix) {
    for (const rule of Array.from(rules)) {
      // CSSStyleRule
      if (rule.type === 1 || rule.constructor.name === 'CSSStyleRule') {
        pushStyleRule(out, rule, el, sheet, src, mediaSuffix);
        continue;
      }
      // CSSMediaRule — recurse if it currently applies
      if (rule.type === 4 || rule.constructor.name === 'CSSMediaRule') {
        let media = null;
        try { media = rule.media?.mediaText; } catch {}
        if (media && !window.matchMedia(media).matches) continue;
        walkRules(out, rule.cssRules || [], el, sheet, src, media ? `@media ${media}` : mediaSuffix);
        continue;
      }
      // CSSSupportsRule — recurse if supported
      if (rule.constructor.name === 'CSSSupportsRule') {
        let cond = null;
        try { cond = rule.conditionText; } catch {}
        if (cond && typeof CSS !== 'undefined' && CSS.supports && !CSS.supports(cond)) continue;
        walkRules(out, rule.cssRules || [], el, sheet, src, mediaSuffix);
        continue;
      }
      // CSSLayerBlockRule, CSSContainerRule, etc. — recurse if they have nested rules
      if (rule.cssRules && rule.cssRules.length) {
        walkRules(out, rule.cssRules, el, sheet, src, mediaSuffix);
      }
    }
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
  let _forcedEl = null;

  function forcedClass(state) {
    return `desinspect-fs-${state}`;
  }

  function rewriteSelectorForStates(selector, states) {
    let out = selector;
    let touched = false;
    for (const s of states) {
      const re = new RegExp(`:${s}(?![\\w-])`, 'g');
      if (re.test(out)) {
        out = out.replace(re, `.${forcedClass(s)}`);
        touched = true;
      }
    }
    return touched ? out : null;
  }

  function collectRulesWithPseudos(rules, states, acc) {
    for (const rule of Array.from(rules || [])) {
      if (rule.type === 1 || rule.constructor.name === 'CSSStyleRule') {
        const rewritten = rewriteSelectorForStates(rule.selectorText, states);
        if (rewritten) {
          const body = rule.cssText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '');
          acc.push(`${rewritten} { ${body} }`);
        }
      } else if (rule.type === 4 || rule.constructor.name === 'CSSMediaRule') {
        let media = null;
        try { media = rule.media?.mediaText; } catch {}
        if (media && !window.matchMedia(media).matches) continue;
        collectRulesWithPseudos(rule.cssRules, states, acc);
      } else if (rule.cssRules && rule.cssRules.length) {
        collectRulesWithPseudos(rule.cssRules, states, acc);
      }
    }
  }

  /**
   * Force pseudo-states on an element. `states` is the full desired set —
   * pass [] to clear. Only one element carries forced states at a time.
   */
  async function forceStates(el, states) {
    // Clear previous target's classes.
    if (_forcedEl && _forcedEl !== el) {
      for (const s of FORCEABLE) _forcedEl.classList.remove(forcedClass(s));
    }
    _forcedEl = el || null;

    let sheetEl = document.getElementById(FORCED_SHEET_ID);
    if (!states.length || !el) {
      if (sheetEl) sheetEl.textContent = '';
      if (el) for (const s of FORCEABLE) el.classList.remove(forcedClass(s));
      return { forced: [] };
    }

    if (!sheetEl) {
      sheetEl = document.createElement('style');
      sheetEl.id = FORCED_SHEET_ID;
      sheetEl.setAttribute('data-desinspect', 'true');
      document.documentElement.appendChild(sheetEl);
    }

    const acc = [];
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.ownerNode?.id === FORCED_SHEET_ID) continue;
      const rules = safeRules(sheet);
      if (rules) {
        collectRulesWithPseudos(rules, states, acc);
      } else if (sheet.href) {
        const synth = await fetchAsStylesheet(sheet.href);
        if (synth) collectRulesWithPseudos(synth.cssRules, states, acc);
      }
    }
    sheetEl.textContent = acc.join('\n');

    for (const s of FORCEABLE) {
      el.classList.toggle(forcedClass(s), states.includes(s));
    }
    return { forced: states };
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
    parseProps,
    forceStates,
    FORCEABLE,
  };
})();

if (typeof window !== 'undefined') window.StylesEngine = StylesEngine;

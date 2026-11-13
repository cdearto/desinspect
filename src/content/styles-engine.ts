/**
 * DesInspect — Styles engine.
 *
 * Reads an element's matched CSS rules, computed values, and box model for
 * the side panel, and forces pseudo-states (:hov). Cross-origin stylesheets
 * throw on .cssRules access, so their text is fetched through the service
 * worker and replayed into a constructed CSSStyleSheet.
 */

const StylesEngine = (() => {
  // ─── Parsing ───────────────────────────────────────────────────────────────

  /** The declaration block of a rule's cssText (between the outer braces). */
  function ruleBody(cssText: string): string {
    return cssText.replace(/^[^{]*\{/, '').replace(/\}\s*$/, '');
  }

  /**
   * Split a declaration block into properties. Tracks quote state so
   * `content: "a;b"` and quoted parens don't corrupt the split; parens count
   * only outside strings (so `url(data:…;base64,…)` survives).
   */
  function parseProps(body: string): StyleProp[] {
    const decls: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let cur = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        cur += ch;
        if (ch === '\\' && i + 1 < body.length) cur += body[++i]; // escaped char can't end the string
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);

      if (ch === ';' && depth === 0) {
        decls.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    decls.push(cur);

    const props: StyleProp[] = [];
    for (const decl of decls) {
      const colon = decl.indexOf(':');
      if (colon < 0) continue;
      const raw = decl.slice(colon + 1).trim();
      const value = raw.replace(/\s*!important\s*$/i, '');
      props.push({
        name: decl.slice(0, colon).trim().toLowerCase(),
        value,
        important: value !== raw,
      });
    }
    return props;
  }

  function inlineRule(el: Element): { properties: StyleProp[] } {
    return { properties: parseProps(el.getAttribute('style') || '') };
  }

  // ─── Selector matching ─────────────────────────────────────────────────────

  // Pseudo-classes that depend on user/element state. Like DevTools, we list
  // rules using them even when the element isn't currently in that state.
  const DYNAMIC_PSEUDOS = [
    'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited',
    'link', 'disabled', 'enabled', 'checked', 'indeterminate', 'default',
    'placeholder-shown', 'autofill', 'read-only', 'read-write',
    'valid', 'invalid', 'in-range', 'out-of-range', 'required', 'optional',
    'user-invalid', 'target', 'scope', 'host', 'fullscreen',
  ];
  // Any dynamic pseudo-class or any pseudo-element. The boundary guard keeps
  // ':focus' from half-matching ':focus-visible'.
  const STATE_PSEUDO_RE = new RegExp(
    `(?:::[\\w-]+|:(?:${DYNAMIC_PSEUDOS.join('|')})(?![\\w-]))(?:\\([^)]*\\))?`,
    'gi'
  );

  function tryMatch(el: Element, selector: string): boolean {
    try {
      return el.matches(selector);
    } catch {
      return false;
    }
  }

  /**
   * Does `el` match `selector`? Returns '' for a plain match, the stripped
   * state pseudos (e.g. ':hover', '::before') if it only matches without
   * them, or null for no match.
   */
  function matchPseudo(el: Element, selector: string): string | null {
    if (tryMatch(el, selector)) return '';
    const stripped: string[] = [];
    const base = selector
      .replace(STATE_PSEUDO_RE, (m) => {
        stripped.push(m);
        return '';
      })
      .trim();
    return stripped.length && base && tryMatch(el, base) ? stripped.join('') : null;
  }

  // ─── Stylesheet walking ────────────────────────────────────────────────────

  type RuleVisitor = (rule: CSSStyleRule, source: string, media: string) => void;

  function safeRules(sheet: CSSStyleSheet): CSSRuleList | null {
    try {
      return sheet.cssRules;
    } catch {
      return null; // cross-origin
    }
  }

  /** Short display name for a stylesheet: its file name, or 'inline'. */
  function sheetSource(sheet: CSSStyleSheet): string {
    if (!sheet.href) return 'inline';
    try {
      return new URL(sheet.href).pathname.split('/').pop() || sheet.href;
    } catch {
      return sheet.href;
    }
  }

  function mediaApplies(media: MediaList | null): boolean {
    return !media?.mediaText || matchMedia(media.mediaText).matches;
  }

  // Cross-origin sheets: fetch the text via the service worker (content-script
  // fetches are subject to the page's CORS policy; the worker's are not).
  const FAIL_RETRY_MS = 15000;
  const _fetchedSheets = new Map<string, Promise<CSSStyleSheet | null>>();

  function fetchAsStylesheet(href: string): Promise<CSSStyleSheet | null> {
    let load = _fetchedSheets.get(href);
    if (!load) {
      load = chrome.runtime
        .sendMessage({ type: 'FETCH_TEXT', url: href })
        .then((r) => {
          if (!r?.ok) throw new Error(r?.error || 'fetch failed');
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(r.text);
          return sheet;
        })
        .catch(() => {
          // Retry later rather than hiding the sheet for the page lifetime.
          setTimeout(() => _fetchedSheets.delete(href), FAIL_RETRY_MS);
          return null;
        });
      _fetchedSheets.set(href, load);
    }
    return load;
  }

  /**
   * Visit every active CSSStyleRule under `rules`, descending into @media
   * and @supports blocks that currently apply, @layer/@container blocks,
   * and @imports. Sheets we can't read are pushed onto `unreadable`.
   */
  function walkRules(
    rules: CSSRuleList,
    visit: RuleVisitor,
    unreadable: CSSStyleSheet[],
    source: string,
    media = ''
  ): void {
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
      } else if (rule instanceof CSSGroupingRule) {
        walkRules(rule.cssRules, visit, unreadable, source, media);
      }
    }
  }

  function walkSheet(sheet: CSSStyleSheet, visit: RuleVisitor, unreadable: CSSStyleSheet[]): void {
    // Skip our own sheets (overrides, forced states) and inactive ones.
    if (sheet.ownerNode instanceof Element && sheet.ownerNode.hasAttribute('data-desinspect')) return;
    if (sheet.disabled || !mediaApplies(sheet.media)) return;
    const rules = safeRules(sheet);
    if (rules) walkRules(rules, visit, unreadable, sheetSource(sheet));
    else if (sheet.href) unreadable.push(sheet);
  }

  /** Visit every active author style rule on the page, fetching cross-origin sheets as needed. */
  async function walkAllSheets(visit: RuleVisitor): Promise<void> {
    const unreadable: CSSStyleSheet[] = [];
    for (const sheet of [...document.styleSheets, ...document.adoptedStyleSheets]) {
      walkSheet(sheet, visit, unreadable);
    }
    const fetched = await Promise.all(unreadable.map((sheet) => fetchAsStylesheet(sheet.href!)));
    fetched.forEach((sheet, i) => {
      // Constructed sheets drop @import rules, so there is nothing further to fetch.
      if (sheet) walkRules(sheet.cssRules, visit, [], `${sheetSource(unreadable[i])} (xo)`);
    });
  }

  /** Split a selector list on its top-level commas. */
  function splitSelectorList(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(list.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(list.slice(start));
    return parts.map((p) => p.trim());
  }

  /**
   * Approximate specificity of one complex selector as a single number
   * (ids, then classes/attributes/pseudo-classes, then types/pseudo-elements).
   * :where() counts zero; :is()/:not()/:has() count their contents.
   */
  function specificity(selector: string): number {
    const s = selector
      .replace(/\[[^\]]*\]/g, '[]') // attribute values can contain anything
      .replace(/:where\([^)]*\)/g, '');
    const ids = (s.match(/#[\w-]+/g) || []).length;
    const classes = (s.match(/\.[\w-]+|\[\]|(?<!:):(?!:|is\(|not\(|has\()[\w-]+/g) || []).length;
    const types = (s.match(/(?:^|[\s>+~(,])[a-zA-Z][\w-]*|::[\w-]+/g) || []).length;
    return ids * 1e6 + classes * 1e3 + types;
  }

  /**
   * Author rules matching `el`, in cascade order: highest specificity first,
   * later rules first among equals (a later rule beats an earlier one).
   * Specificity is that of the most specific selector in the list that matches.
   */
  async function matchedRules(el: Element): Promise<MatchedRule[]> {
    const found: { rule: MatchedRule; specificity: number }[] = [];
    await walkAllSheets((rule, source, media) => {
      const pseudo = matchPseudo(el, rule.selectorText);
      if (pseudo === null) return;
      const matching = splitSelectorList(rule.selectorText).filter((part) => matchPseudo(el, part) !== null);
      found.push({
        specificity: Math.max(0, ...matching.map(specificity)),
        rule: {
          selector: rule.selectorText,
          pseudo: pseudo || null,
          source: media ? `${source} ${media}` : source,
          properties: parseProps(ruleBody(rule.cssText)),
        },
      });
    });
    return found
      .reverse() // later rules first; the stable sort keeps that among equal specificity
      .sort((a, b) => b.specificity - a.specificity)
      .map((f) => f.rule);
  }

  // ─── Force element state (:hov) ────────────────────────────────────────────
  //
  // DevTools forces :hover/:focus/etc. through the debugger protocol; from a
  // content script we approximate: collect every author rule whose selector
  // uses a forced pseudo, rewrite that pseudo to a marker class
  // (:hover → .desinspect-fs-hover), install the rewritten rules in an
  // ephemeral (never persisted) stylesheet, and add the marker classes to
  // the target element. Descendant rules like `.btn:hover .icon` work
  // naturally because the class lands on the element the pseudo targeted.

  const FORCEABLE = ['hover', 'focus', 'focus-within', 'focus-visible', 'active'];
  const FORCED_SHEET_ID = 'desinspect-forced-states';
  const forcedClass = (state: string) => `desinspect-fs-${state}`;
  let _forcedEl: Element | null = null;

  /** `.btn:hover` → `.btn.desinspect-fs-hover`, or null if no forced pseudo is used. */
  function rewriteSelectorForStates(selector: string, states: string[]): string | null {
    const re = new RegExp(`:(${states.join('|')})(?![\\w-])`, 'g');
    const out = selector.replace(re, (_, state) => `.${forcedClass(state)}`);
    return out === selector ? null : out;
  }

  function clearForcedClasses(el: Element): void {
    el.classList.remove(...FORCEABLE.map(forcedClass));
    // Don't leave an empty class="" behind — it would change the element's outerHTML.
    if (!el.classList.length) el.removeAttribute('class');
  }

  /**
   * Force pseudo-states on an element. `states` is the full desired set —
   * pass [] to clear. Only one element carries forced states at a time.
   */
  async function forceStates(el: Element | null, states: string[]): Promise<void> {
    states = states.filter((s) => FORCEABLE.includes(s));
    if (_forcedEl) clearForcedClasses(_forcedEl);
    _forcedEl = el && states.length ? el : null;

    let sheetEl = document.getElementById(FORCED_SHEET_ID);
    if (!el || !_forcedEl) {
      if (sheetEl) sheetEl.textContent = '';
      return;
    }
    if (!sheetEl) {
      sheetEl = document.createElement('style');
      sheetEl.id = FORCED_SHEET_ID;
      sheetEl.setAttribute('data-desinspect', 'true');
      document.documentElement.appendChild(sheetEl);
    }

    const css: string[] = [];
    await walkAllSheets((rule) => {
      const rewritten = rewriteSelectorForStates(rule.selectorText, states);
      if (rewritten) css.push(`${rewritten} { ${ruleBody(rule.cssText)} }`);
    });
    if (_forcedEl !== el) return; // selection changed while sheets were loading
    sheetEl.textContent = css.join('\n');
    el.classList.add(...states.map(forcedClass));
  }

  // ─── Computed values ───────────────────────────────────────────────────────

  function computedSnapshot(el: Element): Record<string, string> {
    const cs = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const prop of cs) out[prop] = cs.getPropertyValue(prop);
    return out;
  }

  function boxModel(el: Element): BoxModel {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;
    const edges = (prop: (side: string) => string): Edges => ({
      top: px(cs.getPropertyValue(prop('top'))),
      right: px(cs.getPropertyValue(prop('right'))),
      bottom: px(cs.getPropertyValue(prop('bottom'))),
      left: px(cs.getPropertyValue(prop('left'))),
    });
    const padding = edges((side) => `padding-${side}`);
    const border = edges((side) => `border-${side}-width`);
    return {
      content: {
        width: rect.width - padding.left - padding.right - border.left - border.right,
        height: rect.height - padding.top - padding.bottom - border.top - border.bottom,
      },
      padding,
      border,
      margin: edges((side) => `margin-${side}`),
    };
  }

  return { inlineRule, matchedRules, computedSnapshot, boxModel, forceStates };
})();

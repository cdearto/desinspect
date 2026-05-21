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

  function matchedRules(el) {
    const out = [];
    for (const sheet of Array.from(document.styleSheets)) {
      const rules = safeRules(sheet);
      if (!rules) continue;
      const src = sheetSource(sheet);
      for (const rule of Array.from(rules)) {
        // Style rule
        if (rule.type === 1 || rule.constructor.name === 'CSSStyleRule') {
          let matches = false;
          try {
            matches = el.matches(rule.selectorText);
          } catch {
            matches = false;
          }
          if (matches) {
            out.push({
              kind: 'rule',
              selector: rule.selectorText,
              source: src,
              origin: sheet.ownerNode?.id === 'desinspect-rule-overrides' ? 'desinspect' : 'author',
              properties: parseProps(rule.cssText),
            });
          }
        } else if (rule.type === 4 || rule.constructor.name === 'CSSMediaRule') {
          // @media — only include if currently matching
          let media = null;
          try {
            media = rule.media?.mediaText;
          } catch {}
          if (media && !window.matchMedia(media).matches) continue;
          for (const inner of Array.from(rule.cssRules || [])) {
            if (inner.type === 1) {
              let m = false;
              try {
                m = el.matches(inner.selectorText);
              } catch {}
              if (m) {
                out.push({
                  kind: 'rule',
                  selector: inner.selectorText,
                  source: `${src} @media ${media}`,
                  origin: 'author',
                  properties: parseProps(inner.cssText),
                });
              }
            }
          }
        }
      }
    }
    return out;
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
  };
})();

if (typeof window !== 'undefined') window.StylesEngine = StylesEngine;

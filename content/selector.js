/**
 * DesInspect — Selector generator + resolver.
 *
 * Produces a string (CSS first, falls back to XPath) that uniquely
 * identifies an element. Stable enough to survive a page refresh and
 * common SPA re-renders.
 *
 * The selector is returned as { type: 'css' | 'xpath', value: string }.
 */

const SelectorEngine = (() => {
  const VOLATILE_CLASS_RE = /^(css-|sc-|jsx-|ng-|_|tw-|chakra-|mui-|desinspect-)/i;
  const VOLATILE_ID_RE = /^(ember|react|radix|headlessui|sn|__|sb-)/i;

  function isVolatileClass(c) {
    return VOLATILE_CLASS_RE.test(c) || /[0-9]{3,}/.test(c);
  }

  function isVolatileId(id) {
    return VOLATILE_ID_RE.test(id) || /[0-9]{4,}/.test(id) || id.length > 32;
  }

  function escape(s) {
    return CSS.escape ? CSS.escape(s) : s.replace(/(["\\#.:>+~()[\]^$|*=,])/g, '\\$1');
  }

  function elementSegment(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && !isVolatileId(el.id)) return `#${escape(el.id)}`;

    const classes = Array.from(el.classList)
      .filter((c) => !isVolatileClass(c))
      .slice(0, 2);
    let seg = tag;
    if (classes.length) seg += '.' + classes.map(escape).join('.');

    // disambiguate among siblings
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => {
        if (c.tagName.toLowerCase() !== tag) return false;
        if (!classes.length) return true;
        return classes.every((cls) => c.classList.contains(cls));
      });
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        seg += `:nth-of-type(${Array.from(parent.children).indexOf(el) + 1})`;
      }
    }
    return seg;
  }

  function generateCss(el) {
    if (!(el instanceof Element)) return null;
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    if (el.id && !isVolatileId(el.id)) return `#${escape(el.id)}`;

    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      const seg = elementSegment(cur);
      parts.unshift(seg);
      // Stop early if we have a unique anchor
      if (cur.id && !isVolatileId(cur.id)) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function generateXPath(el) {
    if (!(el instanceof Element)) return null;
    if (el.id && !isVolatileId(el.id)) return `//*[@id="${el.id}"]`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${cur.tagName.toLowerCase()}[${idx}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  /**
   * Generate the best selector for an element.
   * Tries CSS, validates uniqueness, falls back to XPath.
   */
  function generate(el) {
    const css = generateCss(el);
    if (css) {
      try {
        const matches = document.querySelectorAll(css);
        if (matches.length === 1 && matches[0] === el) {
          return { type: 'css', value: css };
        }
      } catch {
        /* invalid selector, fall through */
      }
    }
    const xp = generateXPath(el);
    return { type: 'xpath', value: xp };
  }

  function find(sel) {
    if (!sel || !sel.value) return null;
    try {
      if (sel.type === 'css') return document.querySelector(sel.value);
      if (sel.type === 'xpath') {
        const r = document.evaluate(
          sel.value,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        );
        return r.singleNodeValue;
      }
    } catch {
      return null;
    }
    return null;
  }

  return { generate, find };
})();

if (typeof window !== 'undefined') window.SelectorEngine = SelectorEngine;

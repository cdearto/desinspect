/**
 * DesInspect — Selector generator + resolver.
 *
 * Produces { type: 'css' | 'xpath', value } identifying an element, stable
 * enough to survive refresh and common SPA re-renders. Every generated
 * selector is validated to resolve back to the exact element before being
 * returned; on failure we fall through to the next strategy.
 */

const SelectorEngine = (() => {
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const VOLATILE_CLASS_RE = /^(css-|sc-|jsx-|ng-|_|tw-|chakra-|mui-|desinspect-)/i;
  const VOLATILE_ID_RE = /^(ember|react|radix|headlessui|sn|__|sb-)/i;

  function isVolatileClass(c) {
    return VOLATILE_CLASS_RE.test(c) || /[0-9]{3,}/.test(c);
  }

  function isVolatileId(id) {
    return VOLATILE_ID_RE.test(id) || /[0-9]{4,}/.test(id) || id.length > 32;
  }

  const escape = (s) => CSS.escape(s);

  /**
   * Tag name for CSS: lowercase for HTML-namespace elements, exact case for
   * SVG/MathML (type selectors match case-sensitively outside HTML).
   */
  function cssTag(el) {
    return el.namespaceURI === HTML_NS ? el.tagName.toLowerCase() : el.localName;
  }

  function usableId(el) {
    return el.id && !isVolatileId(el.id) &&
      document.querySelectorAll(`#${escape(el.id)}`).length === 1
      ? el.id
      : null;
  }

  function elementSegment(el) {
    const tag = cssTag(el);
    const id = usableId(el);
    if (id) return `#${escape(id)}`;

    const classes = Array.from(el.classList || [])
      .filter((c) => !isVolatileClass(c))
      .slice(0, 2);
    let seg = escape(tag);
    if (classes.length) seg += '.' + classes.map(escape).join('.');

    const parent = el.parentElement;
    if (parent) {
      const sameSeg = Array.from(parent.children).filter((c) => {
        if (cssTag(c) !== tag) return false;
        if (!classes.length) return true;
        return classes.every((cls) => c.classList.contains(cls));
      });
      if (sameSeg.length > 1) {
        // :nth-of-type counts same-tag siblings only — index among those,
        // not among all children.
        const sameTag = Array.from(parent.children).filter((c) => cssTag(c) === tag);
        const idx = sameTag.indexOf(el) + 1;
        seg = `${escape(tag)}:nth-of-type(${idx})`;
      }
    }
    return seg;
  }

  function generateCss(el) {
    if (!(el instanceof Element)) return null;
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';
    const id = usableId(el);
    if (id) return `#${escape(id)}`;

    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      parts.unshift(elementSegment(cur));
      if (usableId(cur)) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Positional XPath using local-name() so SVG/MathML elements resolve
   * (unprefixed name tests never match non-HTML namespaces in Chrome).
   */
  function generateXPath(el) {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1) {
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.localName === cur.localName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`*[local-name()='${cur.localName}'][${idx}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  function resolveCss(selector) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  function resolveXPath(xpath) {
    try {
      const r = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return r.singleNodeValue;
    } catch {
      return null;
    }
  }

  /**
   * Generate the best selector: CSS validated for unique resolution to `el`,
   * else positional XPath validated the same way.
   */
  function generate(el) {
    const css = generateCss(el);
    if (css && resolveCss(css) === el) {
      return { type: 'css', value: css };
    }
    const xp = generateXPath(el);
    if (xp && resolveXPath(xp) === el) {
      return { type: 'xpath', value: xp };
    }
    // Last resort: return the CSS anyway (may resolve after re-render).
    return css ? { type: 'css', value: css } : { type: 'xpath', value: xp };
  }

  function find(sel) {
    if (!sel || !sel.value) return null;
    if (sel.type === 'css') {
      try {
        return document.querySelector(sel.value);
      } catch {
        return null;
      }
    }
    if (sel.type === 'xpath') return resolveXPath(sel.value);
    return null;
  }

  return { generate, find };
})();

if (typeof window !== 'undefined') window.SelectorEngine = SelectorEngine;

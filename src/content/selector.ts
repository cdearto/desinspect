/**
 * DesInspect — Selector generator + resolver.
 *
 * Produces a Selector identifying an element, stable enough to survive a
 * refresh and common SPA re-renders. Every generated selector is checked to
 * resolve back to the exact element; on failure we fall through to the next
 * strategy (short CSS → positional XPath).
 */

const SelectorEngine = (() => {
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  // Framework-generated names change between builds/renders — never anchor on them.
  const VOLATILE_CLASS_RE = /^(css-|sc-|jsx-|ng-|_|tw-|chakra-|mui-|desinspect-)/i;
  const VOLATILE_ID_RE = /^(ember|react|radix|headlessui|sn|__|sb-)/i;

  function isVolatileClass(c: string): boolean {
    return VOLATILE_CLASS_RE.test(c) || /[0-9]{3,}/.test(c);
  }

  function isVolatileId(id: string): boolean {
    return VOLATILE_ID_RE.test(id) || /[0-9]{4,}/.test(id) || id.length > 32;
  }

  /**
   * Tag name for CSS: lowercase for HTML elements, exact case for SVG/MathML
   * (type selectors match case-sensitively outside the HTML namespace).
   */
  function cssTag(el: Element): string {
    return el.namespaceURI === HTML_NS ? el.tagName.toLowerCase() : el.localName;
  }

  /** The element's id if it is stable and unique in the document. */
  function usableId(el: Element): string | null {
    return el.id &&
      !isVolatileId(el.id) &&
      document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1
      ? el.id
      : null;
  }

  function elementSegment(el: Element): string {
    const id = usableId(el);
    if (id) return `#${CSS.escape(id)}`;

    const tag = cssTag(el);
    const classes = Array.from(el.classList)
      .filter((c) => !isVolatileClass(c))
      .slice(0, 2);
    const seg = CSS.escape(tag) + classes.map((c) => `.${CSS.escape(c)}`).join('');

    const siblings = Array.from(el.parentElement?.children ?? []);
    const ambiguous = siblings.filter(
      (c) => cssTag(c) === tag && classes.every((cls) => c.classList.contains(cls))
    );
    if (ambiguous.length <= 1) return seg;
    // :nth-of-type counts same-tag siblings only.
    const index = siblings.filter((c) => cssTag(c) === tag).indexOf(el) + 1;
    return `${CSS.escape(tag)}:nth-of-type(${index})`;
  }

  function generateCss(el: Element): string {
    if (el === document.documentElement) return 'html';
    if (el === document.body) return 'body';

    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      parts.unshift(elementSegment(cur));
      if (usableId(cur)) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  /**
   * Positional XPath. Uses local-name() so SVG/MathML elements resolve
   * (unprefixed name tests never match non-HTML namespaces).
   */
  function generateXPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur) {
      let index = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.localName === cur.localName) index++;
      }
      parts.unshift(`*[local-name()='${cur.localName}'][${index}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  }

  function resolveXPath(xpath: string): Element | null {
    try {
      const node = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
        .singleNodeValue;
      return node instanceof Element ? node : null;
    } catch {
      return null;
    }
  }

  function isUniqueMatch(css: string, el: Element): boolean {
    try {
      const matches = document.querySelectorAll(css);
      return matches.length === 1 && matches[0] === el;
    } catch {
      return false;
    }
  }

  function generate(el: Element): Selector {
    const css = generateCss(el);
    if (isUniqueMatch(css, el)) return { type: 'css', value: css };
    return { type: 'xpath', value: generateXPath(el) };
  }

  function find(sel: Selector | null | undefined): Element | null {
    if (!sel?.value) return null;
    if (sel.type === 'xpath') return resolveXPath(sel.value);
    try {
      return document.querySelector(sel.value);
    } catch {
      return null;
    }
  }

  return { generate, find };
})();

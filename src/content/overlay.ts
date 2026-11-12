/**
 * DesInspect — Page overlay.
 *
 * Chrome-DevTools-style highlight: tinted margin (orange), border (tan),
 * padding (green), and content (blue) layers over the target element, plus
 * a label badge showing tag#id.class and dimensions.
 */

const Overlay = (() => {
  // Chrome DevTools highlight palette.
  const COLORS = {
    content: 'rgba(111, 168, 220, 0.60)',
    padding: 'rgba(147, 196, 125, 0.55)',
    border: 'rgba(255, 229, 153, 0.60)',
    margin: 'rgba(246, 178, 107, 0.60)',
  };

  let _root: HTMLElement | null = null;
  let _hoverEl: Element | null = null;
  let _selectedEl: Element | null = null;

  /** The (cleared) layer to draw into; the overlay root is created on demand. */
  function freshLayer(name: 'hover' | 'selected'): HTMLElement {
    if (!_root?.isConnected) {
      _root = document.createElement('div');
      _root.id = 'desinspect-overlay-root';
      _root.setAttribute('data-desinspect', 'true');
      _root.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:2147483646;';
      _root.innerHTML = '<div data-layer="hover"></div><div data-layer="selected"></div>';
      document.documentElement.appendChild(_root);
    }
    const layer = _root.querySelector<HTMLElement>(`[data-layer="${name}"]`)!;
    layer.innerHTML = '';
    return layer;
  }

  function rect(x: number, y: number, w: number, h: number, background: string, extra = ''): HTMLElement {
    const d = document.createElement('div');
    d.style.cssText =
      `position:absolute; left:${x}px; top:${y}px; width:${Math.max(0, w)}px; height:${Math.max(0, h)}px; ` +
      `background:${background}; pointer-events:none; ${extra}`;
    return d;
  }

  /**
   * Draw the box-model layers and badge for `el` into `layer`. Each layer is
   * drawn as four non-overlapping strips so the tints don't stack.
   */
  function drawBoxModel(layer: HTMLElement, el: Element): void {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const px = (v: string) => parseFloat(v) || 0;

    /** Strips of thickness t/r/b/l just inside the box (x, y, w, h). */
    const frame = (x: number, y: number, w: number, h: number, t: number, rt: number, b: number, l: number, color: string) => {
      if (t) layer.appendChild(rect(x, y, w, t, color));
      if (b) layer.appendChild(rect(x, y + h - b, w, b, color));
      if (l) layer.appendChild(rect(x, y + t, l, h - t - b, color));
      if (rt) layer.appendChild(rect(x + w - rt, y + t, rt, h - t - b, color));
    };

    const m = { t: px(cs.marginTop), r: px(cs.marginRight), b: px(cs.marginBottom), l: px(cs.marginLeft) };
    const b = { t: px(cs.borderTopWidth), r: px(cs.borderRightWidth), b: px(cs.borderBottomWidth), l: px(cs.borderLeftWidth) };
    const p = { t: px(cs.paddingTop), r: px(cs.paddingRight), b: px(cs.paddingBottom), l: px(cs.paddingLeft) };

    // Margin box → border box → padding box → content box, outside in.
    let [x, y, w, h] = [r.x - m.l, r.y - m.t, r.width + m.l + m.r, r.height + m.t + m.b];
    const marginTop = y;
    const marginBottom = y + h;
    frame(x, y, w, h, m.t, m.r, m.b, m.l, COLORS.margin);
    [x, y, w, h] = [r.x, r.y, r.width, r.height];
    frame(x, y, w, h, b.t, b.r, b.b, b.l, COLORS.border);
    [x, y, w, h] = [x + b.l, y + b.t, w - b.l - b.r, h - b.t - b.b];
    frame(x, y, w, h, p.t, p.r, p.b, p.l, COLORS.padding);
    layer.appendChild(rect(x + p.l, y + p.t, w - p.l - p.r, h - p.t - p.b, COLORS.content));

    const badge = document.createElement('div');
    const id = el.id ? `#${el.id}` : '';
    const cls = el.classList[0] ? `.${el.classList[0]}` : '';
    badge.textContent = `${el.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    // Above the element, or below it when there's no room.
    const top = marginTop - 24 < 4 ? marginBottom + 4 : marginTop - 24;
    badge.style.cssText =
      `position:absolute; left:${Math.max(4, r.x - m.l)}px; top:${top}px; ` +
      'background:#1f1f1f; color:#8ab4f8; border:1px solid #3a3a3a; ' +
      'font:11px/1.4 "SF Mono", Menlo, Consolas, monospace; ' +
      'padding:2px 7px; border-radius:3px; white-space:nowrap; pointer-events:none;';
    layer.appendChild(badge);
  }

  function isDrawable(el: Element | null): el is Element {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }

  function showHover(el: Element | null): void {
    _hoverEl = el;
    const layer = freshLayer('hover');
    if (isDrawable(el) && el !== _selectedEl) drawBoxModel(layer, el);
  }

  function showSelected(el: Element | null): void {
    _selectedEl = el;
    const layer = freshLayer('selected');
    if (!isDrawable(el)) return;
    drawBoxModel(layer, el);
    // Selection ring, so the selection reads differently from a hover.
    const r = el.getBoundingClientRect();
    layer.appendChild(
      rect(r.x, r.y, r.width, r.height, 'transparent', 'outline: 1.5px solid #10b981; outline-offset: 1px;')
    );
  }

  // Keep the highlights glued to their elements. The interval covers layout
  // shifts that fire no event (transitions, late-loading content).
  function repaint(): void {
    if (_hoverEl) showHover(_hoverEl);
    if (_selectedEl) showSelected(_selectedEl);
  }
  window.addEventListener('scroll', repaint, true);
  window.addEventListener('resize', repaint);
  setInterval(() => _selectedEl && showSelected(_selectedEl), 1000);

  return { showHover, showSelected };
})();

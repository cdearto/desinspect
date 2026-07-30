/**
 * DesInspect — Page overlay.
 *
 * Chrome-DevTools-style highlight: tinted margin (orange), border (tan),
 * padding (green), and content (blue) layers over the target element, plus
 * a label badge showing tag#id.class and dimensions.
 */

const Overlay = (() => {
  let _root = null;
  let _hoverEl = null;
  let _selectedEl = null;

  // Chrome DevTools highlight palette.
  const COLORS = {
    content: 'rgba(111, 168, 220, 0.60)',
    padding: 'rgba(147, 196, 125, 0.55)',
    border: 'rgba(255, 229, 153, 0.60)',
    margin: 'rgba(246, 178, 107, 0.60)',
  };

  function ensureRoot() {
    if (_root && _root.isConnected) return _root;
    _root = document.createElement('div');
    _root.id = 'desinspect-overlay-root';
    _root.setAttribute('data-desinspect', 'true');
    _root.style.cssText = 'position:fixed; inset:0; pointer-events:none; z-index:2147483646;';
    for (const name of ['hover', 'selected']) {
      const layer = document.createElement('div');
      layer.dataset.layer = name;
      layer.style.cssText = 'position:absolute; inset:0; pointer-events:none;';
      _root.appendChild(layer);
    }
    document.documentElement.appendChild(_root);
    return _root;
  }

  function getLayer(name) {
    return ensureRoot().querySelector(`[data-layer="${name}"]`);
  }

  function clearLayer(name) {
    const l = getLayer(name);
    if (l) l.innerHTML = '';
  }

  function rect(x, y, w, h, background, extra = '') {
    const d = document.createElement('div');
    d.style.cssText = `position:absolute; left:${x}px; top:${y}px; width:${Math.max(0, w)}px; height:${Math.max(0, h)}px; background:${background}; pointer-events:none; ${extra}`;
    return d;
  }

  /**
   * Draw the four box-model layers for `el` into `layer`.
   * Uses non-overlapping strips so the tints don't stack.
   */
  function drawBoxModel(layer, el, withBadge) {
    const cs = window.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const n = (v) => parseFloat(v) || 0;

    const m = { t: n(cs.marginTop), r: n(cs.marginRight), b: n(cs.marginBottom), l: n(cs.marginLeft) };
    const b = { t: n(cs.borderTopWidth), r: n(cs.borderRightWidth), b: n(cs.borderBottomWidth), l: n(cs.borderLeftWidth) };
    const p = { t: n(cs.paddingTop), r: n(cs.paddingRight), b: n(cs.paddingBottom), l: n(cs.paddingLeft) };

    // Margin box (outer) — four strips around the border box.
    const mx = r.x - m.l;
    const my = r.y - m.t;
    const mw = r.width + m.l + m.r;
    const mh = r.height + m.t + m.b;
    if (m.t) layer.appendChild(rect(mx, my, mw, m.t, COLORS.margin));
    if (m.b) layer.appendChild(rect(mx, r.y + r.height, mw, m.b, COLORS.margin));
    if (m.l) layer.appendChild(rect(mx, r.y, m.l, r.height, COLORS.margin));
    if (m.r) layer.appendChild(rect(r.x + r.width, r.y, m.r, r.height, COLORS.margin));

    // Border strips.
    if (b.t) layer.appendChild(rect(r.x, r.y, r.width, b.t, COLORS.border));
    if (b.b) layer.appendChild(rect(r.x, r.y + r.height - b.b, r.width, b.b, COLORS.border));
    if (b.l) layer.appendChild(rect(r.x, r.y + b.t, b.l, r.height - b.t - b.b, COLORS.border));
    if (b.r) layer.appendChild(rect(r.x + r.width - b.r, r.y + b.t, b.r, r.height - b.t - b.b, COLORS.border));

    // Padding strips (inside border box).
    const ix = r.x + b.l;
    const iy = r.y + b.t;
    const iw = r.width - b.l - b.r;
    const ih = r.height - b.t - b.b;
    if (p.t) layer.appendChild(rect(ix, iy, iw, p.t, COLORS.padding));
    if (p.b) layer.appendChild(rect(ix, iy + ih - p.b, iw, p.b, COLORS.padding));
    if (p.l) layer.appendChild(rect(ix, iy + p.t, p.l, ih - p.t - p.b, COLORS.padding));
    if (p.r) layer.appendChild(rect(ix + iw - p.r, iy + p.t, p.r, ih - p.t - p.b, COLORS.padding));

    // Content box.
    layer.appendChild(
      rect(ix + p.l, iy + p.t, iw - p.l - p.r, ih - p.t - p.b, COLORS.content)
    );

    if (withBadge) {
      const badge = document.createElement('div');
      const tag = el.tagName.toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.classList && el.classList[0] ? `.${el.classList[0]}` : '';
      badge.textContent = `${tag}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      const top = my - 24;
      badge.style.cssText = `
        position:absolute; left:${Math.max(4, mx)}px;
        top:${top < 4 ? my + mh + 4 : top}px;
        background:#1f1f1f; color:#8ab4f8; border:1px solid #3a3a3a;
        font:11px/1.4 "SF Mono", Menlo, Consolas, monospace;
        padding:2px 7px; border-radius:3px; white-space:nowrap; pointer-events:none;
      `;
      layer.appendChild(badge);
    }
  }

  function showHover(el) {
    _hoverEl = el;
    clearLayer('hover');
    if (!el || el === _selectedEl || !(el instanceof Element)) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    drawBoxModel(getLayer('hover'), el, true);
  }

  function showSelected(el) {
    _selectedEl = el;
    clearLayer('selected');
    if (!el || !(el instanceof Element) || !el.isConnected) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    const layer = getLayer('selected');
    drawBoxModel(layer, el, true);
    // Selection ring so it stays visible after the hover tints fade.
    layer.appendChild(
      rect(r.x, r.y, r.width, r.height, 'transparent', 'outline: 1.5px solid #10b981; outline-offset: 1px;')
    );
  }

  function refreshSelected() {
    if (_selectedEl) showSelected(_selectedEl);
  }

  function hide() {
    clearLayer('hover');
    clearLayer('selected');
    _hoverEl = null;
    _selectedEl = null;
  }

  function destroy() {
    if (_root) _root.remove();
    _root = null;
    _hoverEl = null;
    _selectedEl = null;
  }

  function bindRepaint() {
    const repaint = () => {
      if (_hoverEl) showHover(_hoverEl);
      if (_selectedEl) showSelected(_selectedEl);
    };
    window.addEventListener('scroll', repaint, true);
    window.addEventListener('resize', repaint);
  }
  bindRepaint();

  return { showHover, showSelected, refreshSelected, hide, destroy };
})();

if (typeof window !== 'undefined') window.Overlay = Overlay;

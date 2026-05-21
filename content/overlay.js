/**
 * DesInspect — Page overlay (DevTools-style hover + selected highlight).
 *
 * Renders four absolutely-positioned rectangles (margin / border / padding /
 * content) over a target element, plus a label badge showing tag + size.
 */

const Overlay = (() => {
  let _root = null;
  let _hoverEl = null;
  let _selectedEl = null;

  function ensureRoot() {
    if (_root) return _root;
    _root = document.createElement('div');
    _root.id = 'desinspect-overlay-root';
    _root.setAttribute('data-desinspect', 'true');
    _root.style.cssText = `
      position: fixed; inset: 0; pointer-events: none;
      z-index: 2147483646;
    `;
    // Sub-layers
    const layers = ['hover', 'selected'];
    for (const name of layers) {
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

  function drawBox(layer, rect, color, label) {
    const div = document.createElement('div');
    div.style.cssText = `
      position: absolute;
      left: ${rect.x}px;
      top: ${rect.y}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 1px solid ${color};
      background: ${color}22;
      box-sizing: border-box;
      pointer-events: none;
    `;
    layer.appendChild(div);
    if (label) {
      const badge = document.createElement('div');
      badge.textContent = label;
      const top = rect.y - 22;
      badge.style.cssText = `
        position: absolute;
        left: ${rect.x}px;
        top: ${top < 4 ? rect.y + rect.height + 4 : top}px;
        background: ${color};
        color: #fff;
        font: 11px/1.4 -apple-system, "SF Pro Text", system-ui, sans-serif;
        padding: 2px 6px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
      `;
      layer.appendChild(badge);
    }
  }

  function label(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = (el.classList && el.classList[0]) ? `.${el.classList[0]}` : '';
    const r = el.getBoundingClientRect();
    return `${tag}${id}${cls} ${Math.round(r.width)}×${Math.round(r.height)}`;
  }

  function showHover(el) {
    _hoverEl = el;
    clearLayer('hover');
    if (!el || el === _selectedEl) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    drawBox(getLayer('hover'), rect, '#3b82f6', label(el));
  }

  function showSelected(el) {
    _selectedEl = el;
    clearLayer('selected');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    drawBox(getLayer('selected'), rect, '#10b981', label(el));
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

  // Reposition on scroll/resize
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

/**
 * DesInspect — Overlay Renderer
 * 
 * Renders Chrome DevTools-style visual overlays on the page:
 * - Highlight box over hovered/selected elements
 * - Compact info tooltip showing tag, classes, and dimensions
 *   (positioned just above the element like Chrome's inspector)
 * - Modified element dot indicators
 * - Flash-highlight for drawing attention on navigation/tab return
 * 
 * All overlay elements use a desinspect ID/attribute so they're
 * excluded from inspector selection.
 */

const OverlayRenderer = (() => {

  const ATTR_MODIFIED = 'data-desinspect-modified';
  const ATTR_SELECTED = 'data-desinspect-selected';

  const BLUE = '#4F8EF7';

  let _highlightBox = null;
  let _infoTooltip = null;

  // ─── Overlay Elements ───────────────────────────────────────────────────

  function ensureOverlays() {
    if (!_highlightBox) {
      _highlightBox = makeEl('desinspect-highlight', `
        position: fixed;
        pointer-events: none;
        z-index: 2147483646;
        border: 1.5px solid ${BLUE};
        background: rgba(79, 142, 247, 0.08);
        border-radius: 1px;
        transition: top 0.05s ease-out, left 0.05s ease-out,
                    width 0.05s ease-out, height 0.05s ease-out;
        display: none;
      `);
    }

    if (!_infoTooltip) {
      _infoTooltip = makeEl('desinspect-tooltip', `
        position: fixed;
        pointer-events: none;
        z-index: 2147483647;
        display: none;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
        font-size: 11px;
        line-height: 1;
        white-space: nowrap;
        padding: 4px 7px;
        border-radius: 3px;
        background: #1E293B;
        color: #E2E8F0;
        box-shadow: 0 2px 8px rgba(0,0,0,0.28);
        letter-spacing: 0.01em;
      `);
    }
  }

  function makeEl(id, css) {
    const el = document.createElement('div');
    el.id = id;
    el.setAttribute('data-desinspect-ui', 'true');
    el.style.cssText = css;
    document.documentElement.appendChild(el);
    return el;
  }

  // ─── Show / Hide ────────────────────────────────────────────────────────

  /**
   * Show highlight box + info tooltip over an element.
   * @param {HTMLElement} element
   * @param {'hover'|'selected'} mode
   */
  function showHighlight(element, mode = 'hover') {
    ensureOverlays();
    const rect = element.getBoundingClientRect();

    // ── Highlight box ──
    const hb = _highlightBox.style;
    hb.display = 'block';
    hb.top = rect.top + 'px';
    hb.left = rect.left + 'px';
    hb.width = rect.width + 'px';
    hb.height = rect.height + 'px';
    hb.borderWidth = mode === 'selected' ? '2px' : '1.5px';
    hb.background = mode === 'selected'
      ? 'rgba(79, 142, 247, 0.06)'
      : 'rgba(79, 142, 247, 0.08)';

    // ── Info tooltip ──
    buildTooltip(element, rect);
  }

  /**
   * Build the Chrome-style tooltip: `tag.class  W × H`
   * Positioned above the element; falls below or inside if no room.
   */
  function buildTooltip(element, rect) {
    const tt = _infoTooltip;
    tt.innerHTML = '';

    // Tag name
    const tag = element.tagName.toLowerCase();
    appendSpan(tt, tag, '#93C5FD', true);

    // ID
    if (element.id) {
      appendSpan(tt, '#' + element.id, '#FDBA74', false);
    }

    // Up to 2 stable class names
    const classes = Array.from(element.classList)
      .filter(c => !/^(css-|sc-|_[a-zA-Z0-9]{5}|jsx-|svelte-|[a-f0-9]{8,})/i.test(c))
      .slice(0, 2);
    if (classes.length > 0) {
      appendSpan(tt, '.' + classes.join('.'), '#94A3B8', false);
    }

    // Dimensions
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    appendSpan(tt, `${w}\u2009×\u2009${h}`, '#64748B', false, '7px');

    // Position
    tt.style.display = 'block';

    const ttRect = tt.getBoundingClientRect();
    const gap = 6;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    // Try above
    let top = rect.top - ttRect.height - gap;
    // Fall below if no room
    if (top < 2) top = rect.bottom + gap;
    // Fall inside if still no room
    if (top + ttRect.height > vpH - 2) top = rect.top + 4;

    // Horizontal: align left, clamp to viewport
    let left = rect.left;
    if (left + ttRect.width > vpW - 6) left = vpW - ttRect.width - 6;
    if (left < 4) left = 4;

    tt.style.top = top + 'px';
    tt.style.left = left + 'px';
  }

  function appendSpan(parent, text, color, bold, marginLeft) {
    const s = document.createElement('span');
    s.textContent = text;
    s.style.color = color;
    if (bold) s.style.fontWeight = '600';
    if (marginLeft) s.style.marginLeft = marginLeft;
    parent.appendChild(s);
  }

  /**
   * Hide highlight and tooltip.
   */
  function hideHighlight() {
    if (_highlightBox) _highlightBox.style.display = 'none';
    if (_infoTooltip) _infoTooltip.style.display = 'none';
  }

  // ─── Flash Highlight ────────────────────────────────────────────────────

  /**
   * Scroll an element into view and flash the highlight to draw attention.
   * Used when navigating to an element from the Changes panel or returning to tab.
   * 
   * @param {HTMLElement} element
   * @param {'full'|'subtle'} intensity
   *   - 'full': 2-pulse flash (navigating from Changes "Select" button)
   *   - 'subtle': single gentle pulse (returning to tab)
   */
  function flashHighlight(element, intensity = 'full') {
    // Scroll the element into the center of the viewport
    element.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });

    // Wait for scroll to settle, then show highlight with flash animation
    setTimeout(() => {
      showHighlight(element, 'selected');

      if (_highlightBox) {
        // Remove any existing animation class
        _highlightBox.classList.remove('desinspect-flash', 'desinspect-flash-subtle');

        // Force reflow to restart animation if it was already playing
        void _highlightBox.offsetWidth;

        // Add the appropriate flash class
        const cls = intensity === 'subtle' ? 'desinspect-flash-subtle' : 'desinspect-flash';
        _highlightBox.classList.add(cls);

        // Clean up the animation class after it finishes
        _highlightBox.addEventListener('animationend', () => {
          _highlightBox.classList.remove(cls);
        }, { once: true });
      }
    }, 150);
  }

  /**
   * Re-position the highlight overlay on the currently selected element.
   * Called when the tab regains focus — the element may have moved due to
   * scroll position changes or dynamic content loading while away.
   * 
   * @param {HTMLElement} element
   */
  function refreshHighlight(element) {
    if (!element) return;
    showHighlight(element, 'selected');
  }

  // ─── Modified Indicators ────────────────────────────────────────────────

  function markModified(element) {
    if (!element || element.hasAttribute(ATTR_MODIFIED)) return;
    element.setAttribute(ATTR_MODIFIED, 'true');
  }

  function unmarkModified(element) {
    if (!element) return;
    element.removeAttribute(ATTR_MODIFIED);
  }

  function clearAllModified() {
    document.querySelectorAll(`[${ATTR_MODIFIED}]`).forEach(el => {
      el.removeAttribute(ATTR_MODIFIED);
    });
  }

  // ─── Selection State ────────────────────────────────────────────────────

  function setSelected(element) {
    const prev = document.querySelector(`[${ATTR_SELECTED}]`);
    if (prev) prev.removeAttribute(ATTR_SELECTED);

    if (element) {
      element.setAttribute(ATTR_SELECTED, 'true');
      showHighlight(element, 'selected');
    }
  }

  function clearSelection() {
    const sel = document.querySelector(`[${ATTR_SELECTED}]`);
    if (sel) sel.removeAttribute(ATTR_SELECTED);
    hideHighlight();
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  function cleanup() {
    hideHighlight();
    [_highlightBox, _infoTooltip].forEach(el => {
      if (el?.parentNode) el.parentNode.removeChild(el);
    });
    _highlightBox = null;
    _infoTooltip = null;
    clearAllModified();
    clearSelection();
  }

  return {
    showHighlight,
    hideHighlight,
    markModified,
    unmarkModified,
    clearAllModified,
    setSelected,
    clearSelection,
    cleanup,
    flashHighlight,
    refreshHighlight,
  };
})();

/**
 * DesInspect — DOM Serializer
 * 
 * Utilities for capturing clean, storable representations of DOM elements.
 * Used by the change tracker and export system.
 */

const DOMSerializer = (() => {

  /**
   * Capture the computed styles of an element as a plain object.
   * Only captures properties that differ from the default (unmodified) state
   * of the same element type, or captures a specific set of common properties.
   * 
   * @param {HTMLElement} element
   * @param {string[]} properties - Specific properties to capture (optional, captures all if omitted)
   * @returns {Object} Key-value map of CSS properties
   */
  function getComputedStyleMap(element, properties = null) {
    const computed = window.getComputedStyle(element);
    const result = {};

    if (properties) {
      properties.forEach(prop => {
        result[prop] = computed.getPropertyValue(prop);
      });
    } else {
      // Capture ALL computed styles
      for (let i = 0; i < computed.length; i++) {
        const prop = computed[i];
        result[prop] = computed.getPropertyValue(prop);
      }
    }

    return result;
  }

  /**
   * Get the inline styles of an element as a plain object.
   * @param {HTMLElement} element
   * @returns {Object} Key-value map of inline CSS properties
   */
  function getInlineStyles(element) {
    const result = {};
    const style = element.style;
    for (let i = 0; i < style.length; i++) {
      const prop = style[i];
      result[prop] = style.getPropertyValue(prop);
    }
    return result;
  }

  /**
   * Capture a lightweight snapshot of an element for storage.
   * @param {HTMLElement} element
   * @returns {Object} Serialized element data
   */
  function serializeElement(element) {
    return {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      classList: Array.from(element.classList),
      attributes: getAttributes(element),
      inlineStyles: getInlineStyles(element),
      textContent: element.textContent?.substring(0, 200) || '', // Truncated for storage
      outerHTML: element.outerHTML?.substring(0, 2000) || '',    // Truncated for storage
      boundingRect: element.getBoundingClientRect().toJSON(),
    };
  }

  /**
   * Get all attributes of an element as a plain object.
   * @param {HTMLElement} element
   * @returns {Object}
   */
  function getAttributes(element) {
    const result = {};
    for (const attr of element.attributes) {
      result[attr.name] = attr.value;
    }
    return result;
  }

  /**
   * Create a human-readable description of an element.
   * e.g. "div.card.active#main-card"
   * @param {HTMLElement} element
   * @returns {string}
   */
  function describeElement(element) {
    let desc = element.tagName.toLowerCase();
    if (element.id) desc += `#${element.id}`;
    if (element.classList.length > 0) {
      desc += '.' + Array.from(element.classList).slice(0, 3).join('.');
      if (element.classList.length > 3) desc += `…`;
    }
    return desc;
  }

  return {
    getComputedStyleMap,
    getInlineStyles,
    serializeElement,
    getAttributes,
    describeElement,
  };
})();

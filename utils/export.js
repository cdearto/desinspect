/**
 * DesInspect — Export Utility
 * 
 * Generates exportable artifacts from recorded changes:
 * - CSS diff (clean, copy-paste ready)
 * - JSON changeset
 * - Full modified HTML snapshot (future)
 */

const ExportUtil = (() => {

  /**
   * Generate a clean CSS diff from a set of changes.
   * Groups changes by selector and outputs valid CSS.
   * 
   * @param {Array} changes - Array of change records from PersistDB
   * @returns {string} CSS text
   */
  function generateCSSDiff(changes) {
    // Filter to CSS-only changes
    const cssChanges = changes.filter(c => c.property !== '__html__');

    if (cssChanges.length === 0) return '/* No CSS changes recorded */';

    // Group by selector
    const grouped = {};
    for (const change of cssChanges) {
      if (!grouped[change.selector]) {
        grouped[change.selector] = [];
      }
      grouped[change.selector].push(change);
    }

    // Build CSS output
    const lines = [
      `/* DesInspect CSS Diff */`,
      `/* Generated: ${new Date().toISOString()} */`,
      `/* URL: ${cssChanges[0]?.urlPattern || 'unknown'} */`,
      `/* ${cssChanges.length} change(s) */`,
      '',
    ];

    for (const [selector, selectorChanges] of Object.entries(grouped)) {
      lines.push(`${selector} {`);
      for (const change of selectorChanges) {
        lines.push(`  ${change.property}: ${change.value};`);
        if (change.originalValue) {
          lines.push(`  /* was: ${change.originalValue} */`);
        }
      }
      lines.push('}');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate a JSON changeset for programmatic use.
   * 
   * @param {Array} changes
   * @returns {string} Formatted JSON string
   */
  function generateJSONChangeset(changes) {
    const changeset = {
      version: '1.0',
      generated: new Date().toISOString(),
      url: changes[0]?.urlPattern || 'unknown',
      totalChanges: changes.length,
      changes: changes.map(c => ({
        selector: c.selector,
        selectorType: c.selectorType,
        property: c.property,
        value: c.value,
        originalValue: c.originalValue,
        element: c.elementDescription,
        timestamp: c.timestamp,
        annotation: c.annotation || null,
      })),
    };

    return JSON.stringify(changeset, null, 2);
  }

  /**
   * Copy text to clipboard.
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for contexts where clipboard API isn't available
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;';
      document.body.appendChild(textarea);
      textarea.select();
      const result = document.execCommand('copy');
      document.body.removeChild(textarea);
      return result;
    }
  }

  /**
   * Trigger a file download in the browser.
   * @param {string} filename
   * @param {string} content
   * @param {string} mimeType
   */
  function downloadFile(filename, content, mimeType = 'text/css') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  return {
    generateCSSDiff,
    generateJSONChangeset,
    copyToClipboard,
    downloadFile,
  };
})();

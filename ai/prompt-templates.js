/**
 * DesInspect — Prompt Templates
 *
 * Structured prompts for Claude API calls.
 * Each template produces a system prompt and user message
 * optimized for accurate, actionable UX audit output.
 */

const PromptTemplates = (() => {

  // ─── Element Audit ────────────────────────────────────────────────────────

  function elementAuditSystem() {
    return `You are a senior UX auditor specializing in web accessibility and usability. You analyze HTML elements and their CSS styles to identify issues and suggest improvements.

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON.

Response schema:
{
  "summary": "One sentence overall assessment",
  "score": "pass" | "warning" | "fail",
  "findings": [
    {
      "severity": "error" | "warning" | "info" | "pass",
      "category": "accessibility" | "usability" | "visual" | "performance" | "semantics",
      "title": "Short issue title",
      "description": "What the problem is and why it matters",
      "suggestion": "Specific actionable fix",
      "css_fix": { "property": "value" } | null
    }
  ]
}

Rules:
- Check WCAG 2.1 AA compliance (contrast, font size, touch targets, focus, aria)
- Check semantic HTML (correct heading levels, landmark usage, button vs div)
- Check visual usability (spacing, readability, alignment, visual hierarchy)
- ALWAYS provide concrete CSS property/value pairs in css_fix when a CSS change could fix or improve the issue (e.g. font-size, color, padding, min-height, outline). Only set css_fix to null when the fix requires HTML changes or cannot be expressed as CSS.
- Limit to 3-8 most important findings, prioritized by severity
- Be specific — reference actual values from the element, not generic advice
- If the element is well-built, say so with "pass" severity findings`;
  }

  function elementAuditUser(elementData, pageUrl) {
    const parts = [
      `Audit this element from: ${pageUrl}`,
      '',
      `Tag: <${elementData.tag}>`,
      `Classes: ${elementData.classes || '(none)'}`,
      `ID: ${elementData.id || '(none)'}`,
      `Role: ${elementData.role || '(none)'}`,
      `Aria: ${elementData.aria || '(none)'}`,
      '',
      '── Outer HTML (truncated) ──',
      truncate(elementData.outerHTML || '', 1500),
      '',
      '── Computed Styles ──',
      formatStyles(elementData.computedStyles || {}),
      '',
      '── Inline Styles ──',
      formatStyles(elementData.inlineStyles || {}),
      '',
      `Text content: "${truncate(elementData.textContent || '', 200)}"`,
      `Dimensions: ${elementData.dimensions?.width || '?'}×${elementData.dimensions?.height || '?'}px`,
      `Parent tag: <${elementData.parentTag || 'unknown'}>`,
      `Children count: ${elementData.childCount ?? '?'}`,
    ];

    return parts.join('\n');
  }

  // ─── Change Impact Check ──────────────────────────────────────────────────

  function impactCheckSystem() {
    return `You are a UX auditor reviewing changes a designer made to a web element. Assess whether the changes improve or harm the user experience, focusing on accessibility and usability.

You MUST respond with valid JSON only.

Response schema:
{
  "summary": "Overall assessment of the changes",
  "verdict": "positive" | "neutral" | "negative" | "mixed",
  "impacts": [
    {
      "severity": "error" | "warning" | "info" | "pass",
      "property": "The CSS property or HTML attribute changed",
      "title": "Short impact title",
      "description": "What this change does to the UX",
      "recommendation": "What to do about it (keep, adjust, or revert)"
    }
  ]
}

Rules:
- Focus on concrete measurable impacts (contrast ratios, px values, WCAG thresholds)
- If a change improves things, mark as "pass" severity
- If removing an element, consider what UX value it provided
- Limit to the most significant impacts (max 6)
- Be constructive — suggest adjustments rather than just flagging problems`;
  }

  function impactCheckUser(changes, elementData, pageUrl) {
    const parts = [
      `Review these changes on: ${pageUrl}`,
      '',
      `Element: <${elementData?.tag || 'unknown'}> ${elementData?.classes || ''}`,
      '',
      '── Changes Made ──',
    ];

    for (const change of changes) {
      const prop = change.property === '__html__' ? 'innerHTML' : change.property;
      const oldVal = truncate(change.originalValue || '(empty)', 300);
      const newVal = truncate(change.value || '(empty)', 300);
      parts.push(`  ${prop}: "${oldVal}" → "${newVal}"`);
    }

    if (elementData) {
      parts.push('', '── Current Element State ──');
      parts.push(`Dimensions: ${elementData.dimensions?.width || '?'}×${elementData.dimensions?.height || '?'}px`);
      parts.push(`Computed styles: ${formatStyles(elementData.computedStyles || {})}`);
    }

    return parts.join('\n');
  }

  // ─── Page Audit ──────────────────────────────────────────────────────────

  function pageAuditSystem() {
    return `You are a senior UX auditor performing a full-page accessibility and usability review. You analyze the page structure, semantics, and key elements to identify the most impactful issues.

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON.

Response schema:
{
  "summary": "One sentence overall assessment",
  "score": "pass" | "warning" | "fail",
  "findings": [
    {
      "severity": "error" | "warning" | "info" | "pass",
      "category": "accessibility" | "usability" | "visual" | "performance" | "semantics",
      "title": "Short issue title",
      "description": "What the problem is and why it matters",
      "suggestion": "Specific actionable fix",
      "css_fix": { "property": "value" } | null
    }
  ]
}

Rules:
- Audit the full page structure, not just one element
- Check: heading hierarchy, landmark regions, alt text, link text, form labels, color contrast, font sizes, touch targets, focus management, semantic HTML
- Check usability: visual hierarchy, content density, navigation clarity, CTA prominence, whitespace
- Prioritize by impact — most severe issues first
- Limit to 5-8 most important findings
- Be specific with selectors or element descriptions so the user knows exactly what to fix
- ALWAYS provide concrete CSS property/value pairs in css_fix when a CSS change could fix or improve the issue (e.g. font-size, color, padding, min-height, outline). Only set css_fix to null when the fix requires HTML changes or cannot be expressed as CSS.
- If the page is well-built, acknowledge what's done right with "pass" findings`;
  }

  function pageAuditUser(pageData) {
    const parts = [
      `Full page audit for: ${pageData.url}`,
      `Title: ${pageData.title || '(none)'}`,
      '',
      '── Page Structure ──',
      `Headings: ${pageData.headings || '(none detected)'}`,
      `Landmarks: ${pageData.landmarks || '(none detected)'}`,
      `Images without alt: ${pageData.imagesWithoutAlt ?? '?'}`,
      `Total images: ${pageData.totalImages ?? '?'}`,
      `Links: ${pageData.linkCount ?? '?'}`,
      `Forms: ${pageData.formCount ?? '?'}`,
      `Buttons: ${pageData.buttonCount ?? '?'}`,
      '',
      '── Key Visible Text (first 2000 chars) ──',
      truncate(pageData.visibleText || '', 2000),
      '',
      '── HTML Snapshot (first 3000 chars) ──',
      truncate(pageData.htmlSnapshot || '', 3000),
    ];
    return parts.join('\n');
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function truncate(str, max) {
    if (str.length <= max) return str;
    return str.slice(0, max) + '…';
  }

  function formatStyles(styles) {
    const relevant = [
      'color', 'background-color', 'font-size', 'font-weight', 'font-family',
      'line-height', 'letter-spacing', 'padding', 'margin', 'border',
      'border-radius', 'display', 'position', 'width', 'height',
      'min-width', 'min-height', 'max-width', 'max-height',
      'opacity', 'visibility', 'overflow', 'text-align', 'text-decoration',
      'cursor', 'z-index', 'gap', 'flex-direction', 'align-items', 'justify-content',
    ];

    const entries = [];
    for (const prop of relevant) {
      if (styles[prop] && styles[prop] !== '' && styles[prop] !== 'none' && styles[prop] !== 'normal' && styles[prop] !== 'auto') {
        entries.push(`${prop}: ${styles[prop]}`);
      }
    }

    return entries.length > 0 ? entries.join('; ') : '(none)';
  }

  // ─── Copilot (Natural Language → CSS/HTML Changes) ─────────────────────────

  function copilotSystem() {
    return `You are a CSS/HTML copilot embedded in a browser inspector tool. The user has selected an element on a live web page and will give you a natural language instruction describing what they want to change.

You MUST respond with valid JSON only — no markdown, no explanation outside the JSON.

Response schema:
{
  "summary": "One sentence describing what you'll change",
  "changes": [
    {
      "type": "css",
      "property": "font-size",
      "value": "18px",
      "reason": "Brief reason for this specific change"
    }
  ]
}

Rules:
- Only return CSS property changes (type: "css") or a single HTML change (type: "html", with "value" as the new innerHTML)
- Use standard CSS property names (kebab-case)
- Provide concrete values — never vague or relative terms
- Keep changes minimal — only what the user asked for, plus directly related properties needed to achieve the intent
- If the instruction is ambiguous, make a reasonable design-informed choice and explain in "reason"
- Maximum 10 changes per response
- Consider the element's current computed styles when choosing values — don't blindly override things the user didn't ask about
- For color changes, use hex values
- For spacing/sizing, match the units already in use (px, rem, em, %) unless the user specifies otherwise`;
  }

  function copilotUser(instruction, elementData, pageUrl) {
    const parts = [
      `Instruction: "${instruction}"`,
      '',
      `Page: ${pageUrl}`,
      `Element: <${elementData.tag}> ${elementData.classes || '(no classes)'}`,
      `ID: ${elementData.id || '(none)'}`,
      `Dimensions: ${elementData.dimensions?.width || '?'}×${elementData.dimensions?.height || '?'}px`,
      `Text: "${truncate(elementData.textContent || '', 150)}"`,
      '',
      '── Current Computed Styles ──',
      formatStyles(elementData.computedStyles || {}),
      '',
      '── Inline Styles ──',
      formatStyles(elementData.inlineStyles || {}),
    ];
    return parts.join('\n');
  }

  return {
    elementAuditSystem,
    elementAuditUser,
    pageAuditSystem,
    pageAuditUser,
    impactCheckSystem,
    impactCheckUser,
    copilotSystem,
    copilotUser,
  };
})();

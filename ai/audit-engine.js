/**
 * DesInspect — AI Audit Engine
 *
 * Orchestrates Claude API calls for UX auditing.
 * Handles API key storage, request building, response parsing,
 * and rate limiting. All calls go direct from the extension
 * to the Anthropic API (BYOK model).
 */

const AuditEngine = (() => {

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const MODEL = 'claude-sonnet-4-5-20250929';
  const MAX_TOKENS = 2048;

  // ─── Mock Mode (for testing without API key) ───────────────────────────────

  let _mockMode = false;

  function enableMockMode() { _mockMode = true; }
  function disableMockMode() { _mockMode = false; }
  function isMockMode() { return _mockMode; }

  // ─── API Key Management ──────────────────────────────────────────────────

  async function getApiKey() {
    const result = await chrome.storage.local.get('desinspect_api_key');
    return result.desinspect_api_key || null;
  }

  async function setApiKey(key) {
    await chrome.storage.local.set({ desinspect_api_key: key });
  }

  async function clearApiKey() {
    await chrome.storage.local.remove('desinspect_api_key');
  }

  async function hasApiKey() {
    const key = await getApiKey();
    return !!key;
  }

  // ─── Core API Call ────────────────────────────────────────────────────────

  /**
   * Send a message to Claude API.
   * @param {string} systemPrompt
   * @param {string} userMessage
   * @returns {Promise<string>} Claude's response text
   */
  async function callClaude(systemPrompt, userMessage) {
    const apiKey = await getApiKey();
    if (!apiKey) {
      throw new Error('NO_API_KEY');
    }

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      console.error('[DesInspect] API error:', response.status, err);
      if (response.status === 401) {
        throw new Error('INVALID_API_KEY');
      }
      if (response.status === 429) {
        throw new Error('RATE_LIMITED');
      }
      const msg = err.error?.message || `API error ${response.status}`;
      throw new Error(msg);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  // ─── Element Audit ────────────────────────────────────────────────────────

  /**
   * Run a comprehensive UX audit on a selected element.
   * @param {object} elementData - Element info from the inspector
   * @param {string} pageUrl - Current page URL
   * @returns {Promise<object>} Parsed audit results
   */
  async function auditElement(elementData, pageUrl) {
    if (_mockMode) {
      await mockDelay();
      return generateMockAudit(elementData);
    }
    const systemPrompt = PromptTemplates.elementAuditSystem();
    const userMessage = PromptTemplates.elementAuditUser(elementData, pageUrl);
    const raw = await callClaude(systemPrompt, userMessage);
    return parseAuditResponse(raw);
  }

  /**
   * Run a full-page UX audit.
   * @param {object} pageData - Page snapshot from content script
   * @returns {Promise<object>} Parsed audit results
   */
  async function auditPage(pageData) {
    if (_mockMode) {
      await mockDelay();
      return generateMockPageAudit(pageData);
    }
    const systemPrompt = PromptTemplates.pageAuditSystem();
    const userMessage = PromptTemplates.pageAuditUser(pageData);
    const raw = await callClaude(systemPrompt, userMessage);
    return parseAuditResponse(raw);
  }

  /**
   * Check the impact of changes the user has made.
   * @param {Array} changes - Array of change objects
   * @param {object} elementData - Current element state
   * @param {string} pageUrl
   * @returns {Promise<object>} Parsed impact results
   */
  async function checkImpact(changes, elementData, pageUrl) {
    if (_mockMode) {
      await mockDelay();
      return generateMockImpact(changes);
    }
    const systemPrompt = PromptTemplates.impactCheckSystem();
    const userMessage = PromptTemplates.impactCheckUser(changes, elementData, pageUrl);
    const raw = await callClaude(systemPrompt, userMessage);
    return parseImpactResponse(raw);
  }

  // ─── Mock Data Generators ─────────────────────────────────────────────────

  function mockDelay() {
    return new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
  }

  function generateMockAudit(elementData) {
    const tag = elementData?.tag || 'div';
    const fontSize = elementData?.computedStyles?.['font-size'] || '14px';
    const color = elementData?.computedStyles?.['color'] || 'rgb(0,0,0)';
    const bg = elementData?.computedStyles?.['background-color'] || 'rgb(255,255,255)';

    return {
      summary: `The <${tag}> element has 2 accessibility issues and 1 usability improvement opportunity.`,
      score: 'warning',
      findings: [
        {
          severity: 'error',
          category: 'accessibility',
          title: 'Color contrast may be insufficient',
          description: `The text color ${color} on background ${bg} may not meet WCAG AA minimum contrast ratio of 4.5:1 for normal text.`,
          suggestion: 'Increase the contrast ratio to at least 4.5:1. Darken the text or lighten the background.',
          css_fix: { 'color': '#1a1a1a' },
        },
        {
          severity: 'warning',
          category: 'accessibility',
          title: `Font size is ${fontSize}`,
          description: `Current font size of ${fontSize} is below the recommended 16px minimum for body text. Small text reduces readability on mobile.`,
          suggestion: 'Increase font size to at least 16px for body text.',
          css_fix: { 'font-size': '16px' },
        },
        {
          severity: 'info',
          category: 'usability',
          title: 'Consider more vertical spacing',
          description: 'The element could benefit from more breathing room to improve scannability and visual hierarchy.',
          suggestion: 'Add padding of 12-16px and set line-height to 1.5.',
          css_fix: { 'padding': '12px', 'line-height': '1.5' },
        },
        {
          severity: 'warning',
          category: 'semantics',
          title: `<${tag}> may not be the best semantic choice`,
          description: `A generic <${tag}> where a more specific HTML5 element might better convey meaning to screen readers.`,
          suggestion: 'Consider <section>, <article>, <nav>, or <aside> if appropriate.',
          css_fix: null,
        },
        {
          severity: 'pass',
          category: 'visual',
          title: 'Dimensions are appropriate',
          description: `Element dimensions (${elementData?.dimensions?.width || '?'}×${elementData?.dimensions?.height || '?'}px) provide adequate touch target size.`,
          suggestion: null,
          css_fix: null,
        },
      ],
    };
  }

  function generateMockImpact(changes) {
    const impacts = changes.slice(0, 4).map(change => {
      const prop = change.property === '__html__' ? 'innerHTML' : change.property;
      const isColor = prop.includes('color') || prop.includes('background');
      const isSize = prop.includes('size') || prop.includes('padding') || prop.includes('margin');

      if (isColor) {
        return {
          severity: 'warning',
          property: prop,
          title: 'Color change may affect contrast',
          description: `Changing ${prop} from "${change.originalValue}" to "${change.value}" could impact WCAG contrast compliance.`,
          recommendation: 'Test with a contrast checker. Keep if ratio is ≥ 4.5:1.',
        };
      }
      if (isSize) {
        return {
          severity: 'pass',
          property: prop,
          title: 'Size adjustment looks good',
          description: `Changing ${prop} to "${change.value}" improves visual proportion.`,
          recommendation: 'Keep. Verify on mobile viewports.',
        };
      }
      return {
        severity: 'info',
        property: prop,
        title: `${prop} was modified`,
        description: `Changed from "${change.originalValue || '(none)'}" to "${change.value}". Minimal UX impact.`,
        recommendation: 'Keep — no accessibility concerns.',
      };
    });

    const hasWarnings = impacts.some(i => i.severity === 'warning' || i.severity === 'error');
    return {
      summary: hasWarnings
        ? 'Changes include items to review for accessibility compliance.'
        : 'Changes look good with no major accessibility concerns.',
      verdict: hasWarnings ? 'mixed' : 'positive',
      impacts,
    };
  }

  function generateMockPageAudit(pageData) {
    const url = pageData?.url || 'this page';
    return {
      summary: `Page audit found 3 accessibility issues and 2 usability improvements across ${url}.`,
      score: 'warning',
      findings: [
        {
          severity: 'error',
          category: 'accessibility',
          title: 'Missing skip navigation link',
          description: 'The page has no skip-to-content link, forcing keyboard and screen reader users to tab through the entire navigation on every page load.',
          suggestion: 'Add a visually hidden "Skip to main content" link as the first focusable element.',
          css_fix: null,
        },
        {
          severity: 'error',
          category: 'accessibility',
          title: 'Images without alt text',
          description: `Found ${2 + Math.floor(Math.random() * 4)} images missing alt attributes. Screen readers cannot convey the purpose of these images to visually impaired users.`,
          suggestion: 'Add descriptive alt text to all informational images. Use alt="" for decorative images.',
          css_fix: null,
        },
        {
          severity: 'warning',
          category: 'accessibility',
          title: 'Body text below minimum size',
          description: 'Several paragraph elements use font-size below 16px, reducing readability on mobile and for users with low vision.',
          suggestion: 'Set body text to at least 16px and ensure line-height is 1.5 or greater.',
          css_fix: { 'font-size': '16px', 'line-height': '1.5' },
        },
        {
          severity: 'warning',
          category: 'usability',
          title: 'Low tap target density on mobile',
          description: 'Several interactive elements (links, buttons) are smaller than the recommended 44×44px minimum touch target size at mobile viewport widths.',
          suggestion: 'Increase padding on small interactive elements to meet the 44px minimum.',
          css_fix: { 'min-height': '44px', 'padding': '10px 16px' },
        },
        {
          severity: 'info',
          category: 'usability',
          title: 'Consider adding focus indicators',
          description: 'Several interactive elements lose their visible focus outline, making keyboard navigation difficult to track.',
          suggestion: 'Add a visible focus ring using outline or box-shadow on :focus-visible for all interactive elements.',
          css_fix: { 'outline': '2px solid #2563eb', 'outline-offset': '2px' },
        },
        {
          severity: 'pass',
          category: 'semantics',
          title: 'Landmark regions present',
          description: 'The page uses <header>, <main>, and <footer> landmarks, which helps assistive technology users orient themselves.',
          suggestion: null,
          css_fix: null,
        },
      ],
    };
  }

  // ─── Response Parsing ─────────────────────────────────────────────────────

  /**
   * Parse Claude's element audit response.
   * Expected JSON structure from the prompt.
   */
  function parseAuditResponse(raw) {
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : raw;
      return JSON.parse(jsonStr);
    } catch {
      // Fallback: return raw text as a single finding
      return {
        summary: 'Audit complete',
        score: null,
        findings: [{
          severity: 'info',
          category: 'general',
          title: 'Audit Results',
          description: raw,
          suggestion: null,
          css_fix: null,
        }],
      };
    }
  }

  function parseImpactResponse(raw) {
    try {
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : raw;
      return JSON.parse(jsonStr);
    } catch {
      return {
        summary: raw,
        impacts: [],
      };
    }
  }

  // ─── Copilot Edit ──────────────────────────────────────────────────────────

  /**
   * Send a natural language instruction to Claude and get back CSS/HTML changes.
   * @param {string} instruction - User's natural language instruction
   * @param {object} elementData - Element info from the inspector
   * @param {string} pageUrl - Current page URL
   * @returns {Promise<object>} Parsed copilot result { summary, changes[] }
   */
  async function copilotEdit(instruction, elementData, pageUrl) {
    if (_mockMode) {
      await mockDelay();
      return generateMockCopilot(instruction, elementData);
    }
    const systemPrompt = PromptTemplates.copilotSystem();
    const userMessage = PromptTemplates.copilotUser(instruction, elementData, pageUrl);
    const raw = await callClaude(systemPrompt, userMessage);
    return parseCopilotResponse(raw);
  }

  function generateMockCopilot(instruction, elementData) {
    const lower = instruction.toLowerCase();
    const changes = [];

    if (lower.includes('bigger') || lower.includes('larger') || lower.includes('size')) {
      changes.push({ type: 'css', property: 'font-size', value: '20px', reason: 'Increased font size for better readability' });
      changes.push({ type: 'css', property: 'padding', value: '16px 24px', reason: 'More padding to match larger text' });
    } else if (lower.includes('color') || lower.includes('blue') || lower.includes('red') || lower.includes('dark')) {
      changes.push({ type: 'css', property: 'color', value: lower.includes('red') ? '#DC2626' : lower.includes('blue') ? '#2563EB' : '#1E293B', reason: 'Updated text color as requested' });
    } else if (lower.includes('padding') || lower.includes('spacing') || lower.includes('breathing')) {
      changes.push({ type: 'css', property: 'padding', value: '16px', reason: 'Added breathing room around content' });
      changes.push({ type: 'css', property: 'line-height', value: '1.6', reason: 'Improved line spacing for readability' });
    } else if (lower.includes('round') || lower.includes('radius')) {
      changes.push({ type: 'css', property: 'border-radius', value: '12px', reason: 'Added rounded corners' });
    } else if (lower.includes('bold') || lower.includes('strong') || lower.includes('heavier')) {
      changes.push({ type: 'css', property: 'font-weight', value: '700', reason: 'Made text bolder for emphasis' });
    } else if (lower.includes('center')) {
      changes.push({ type: 'css', property: 'text-align', value: 'center', reason: 'Centered text alignment' });
    } else if (lower.includes('hide') || lower.includes('invisible') || lower.includes('remove')) {
      changes.push({ type: 'css', property: 'display', value: 'none', reason: 'Hidden the element as requested' });
    } else {
      // Generic fallback
      changes.push({ type: 'css', property: 'font-size', value: '16px', reason: 'Adjusted to standard body size' });
      changes.push({ type: 'css', property: 'color', value: '#334155', reason: 'Improved text contrast' });
      changes.push({ type: 'css', property: 'line-height', value: '1.5', reason: 'Better readability' });
    }

    return {
      summary: `Applied ${changes.length} change${changes.length > 1 ? 's' : ''} based on: "${instruction}"`,
      changes,
    };
  }

  function parseCopilotResponse(raw) {
    try {
      const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/```\s*([\s\S]*?)\s*```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : raw;
      const parsed = JSON.parse(jsonStr);
      // Validate structure
      if (!parsed.changes || !Array.isArray(parsed.changes)) {
        throw new Error('Invalid copilot response structure');
      }
      return parsed;
    } catch {
      return {
        summary: 'Could not parse response — please try rephrasing your instruction.',
        changes: [],
      };
    }
  }

  return {
    getApiKey,
    setApiKey,
    clearApiKey,
    hasApiKey,
    enableMockMode,
    disableMockMode,
    isMockMode,
    auditElement,
    auditPage,
    checkImpact,
    copilotEdit,
  };
})();

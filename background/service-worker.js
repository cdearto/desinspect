/**
 * DesInspect — Background Service Worker
 * 
 * Responsibilities:
 * - Toggle inspector mode on/off via toolbar icon
 * - Open/close side panel
 * - Route messages between content scripts and side panel
 * - Handle session recovery signals
 */

// ─── State ──────────────────────────────────────────────────────────────────

let inspectorActive = false;
let lastInspectorTabId = null; // Track which tab has an active inspector session

// ─── Extension Icon Click → Toggle Inspector ────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  // Open the side panel for this tab
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn('[DesInspect] Could not open side panel:', err);
  }

  // Toggle inspector state in the content script
  inspectorActive = !inspectorActive;
  lastInspectorTabId = tab.id;

  chrome.tabs.sendMessage(tab.id, {
    type: 'TOGGLE_INSPECTOR',
    active: inspectorActive
  }).catch(() => {
    // Content script may not be loaded yet — inject it
    console.warn('[DesInspect] Content script not ready, will retry after injection.');
  });
});

// ─── Message Router ─────────────────────────────────────────────────────────
// Routes messages between content scripts ↔ side panel

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // Content script → Side panel: element selected, change recorded, etc.
    case 'ELEMENT_SELECTED':
      // Track which tab has an active selection
      if (sender.tab) lastInspectorTabId = sender.tab.id;
      // Fall through to forward
    case 'CHANGE_RECORDED':
    case 'CHANGES_LOADED':
    case 'HISTORY_LOADED':
    case 'CHANGE_REVERTED':
    case 'INSPECTOR_STATE':
    case 'DIFF_MODE_STATE':
    case 'SPA_NAVIGATION':
    case 'UNDO_STATE':
    case 'UNDO_PERFORMED':
    case 'REDO_PERFORMED':
    case 'PAGE_DATA':
    case 'SNAPSHOT_RESTORED':
    case 'SNAPSHOT_CREATED':
    case 'ELEMENT_DELETED':
    case 'ALL_CHANGES_REVERTED':
      // Forward to side panel (all extension pages)
      chrome.runtime.sendMessage(message).catch(() => {
        // Side panel may not be open — that's fine
      });
      break;

    // Side panel → Content script: SELECT_ELEMENT needs special handling.
    // 1. Find the right tab (by URL match, or last inspector tab, or active tab)
    // 2. If the tab is on a different page, navigate it to the correct URL first
    // 3. Focus the tab and forward the message to the content script
    case 'SELECT_ELEMENT': {
      if (sender.tab) break; // Came from content script — don't forward back

      const urlPattern = message.data?.urlPattern;

      /**
       * Normalize a tab URL the same way PersistDB does: origin + pathname.
       */
      const normalizeTabUrl = (url) => {
        try {
          const parsed = new URL(url);
          return `${parsed.origin}${parsed.pathname}`;
        } catch { return null; }
      };

      /**
       * Focus a tab, navigate to the correct URL if needed, then send message.
       */
      const focusAndSend = (tabId) => {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError || !tab) return;

          const tabNorm = normalizeTabUrl(tab.url);
          const needsNav = urlPattern && tabNorm !== urlPattern;

          // Focus the tab
          chrome.tabs.update(tabId, { active: true }, () => {
            if (needsNav) {
              // Navigate to the correct URL, then send message after page loads
              chrome.tabs.update(tabId, { url: urlPattern }, () => {
                // Wait for the page to finish loading before sending SELECT_ELEMENT.
                // The content script re-injects on document_idle, and PAGE_LOADED
                // triggers reapplyChanges — so the element should exist by then.
                const onComplete = (updatedTabId, changeInfo) => {
                  if (updatedTabId === tabId && changeInfo.status === 'complete') {
                    chrome.tabs.onUpdated.removeListener(onComplete);
                    // Small delay for content script to initialize + reapply changes
                    setTimeout(() => {
                      chrome.tabs.sendMessage(tabId, message).catch(() => {
                        console.warn('[DesInspect] Could not reach content script after navigation.');
                      });
                    }, 300);
                  }
                };
                chrome.tabs.onUpdated.addListener(onComplete);
              });
            } else {
              // Already on the right page — just send
              chrome.tabs.sendMessage(tabId, message).catch(() => {
                console.warn('[DesInspect] Could not reach content script.');
              });
            }
          });
        });
      };

      if (urlPattern) {
        // Try to find a tab already on the correct URL
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          const exactMatch = tabs.find(t => normalizeTabUrl(t.url) === urlPattern);

          if (exactMatch) {
            lastInspectorTabId = exactMatch.id;
            focusAndSend(exactMatch.id);
          } else if (lastInspectorTabId) {
            // No tab on that URL — navigate the last inspector tab there
            chrome.tabs.get(lastInspectorTabId, (tab) => {
              if (chrome.runtime.lastError || !tab) {
                // Last tab gone — use active tab
                chrome.tabs.query({ active: true, currentWindow: true }, (active) => {
                  if (active[0]) focusAndSend(active[0].id);
                });
              } else {
                focusAndSend(lastInspectorTabId);
              }
            });
          } else {
            // No tracked tab — use active tab
            chrome.tabs.query({ active: true, currentWindow: true }, (active) => {
              if (active[0]) focusAndSend(active[0].id);
            });
          }
        });
      } else if (lastInspectorTabId) {
        chrome.tabs.get(lastInspectorTabId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            chrome.tabs.query({ active: true, currentWindow: true }, (active) => {
              if (active[0]) focusAndSend(active[0].id);
            });
          } else {
            focusAndSend(lastInspectorTabId);
          }
        });
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (active) => {
          if (active[0]) focusAndSend(active[0].id);
        });
      }
      break;
    }

    // Side panel → Content script: apply edit, revert, highlight, diff
    case 'APPLY_CSS_EDIT':
    case 'APPLY_RULE_EDIT':
    case 'TOGGLE_CLASS':
    case 'ADD_CLASS':
    case 'RESELECT_ELEMENT':
    case 'APPLY_HTML_EDIT':
    case 'REVERT_CHANGE':
    case 'REAPPLY_CHANGE':
    case 'REVERT_ALL':
    case 'RESTORE_SNAPSHOT':
    case 'HIGHLIGHT_ELEMENT':
    case 'HIGHLIGHT_BY_PATH':
    case 'SELECT_BY_PATH':
    case 'SHOW_PERSISTENT_HIGHLIGHT':
    case 'HIDE_PERSISTENT_HIGHLIGHT':
    case 'TOGGLE_INSPECTOR':
    case 'TOGGLE_DIFF_MODE':
    case 'PREVIEW_CHANGE':
    case 'GET_CHANGES':
    case 'GET_HISTORY':
    case 'CREATE_SNAPSHOT':
    case 'UNDO':
    case 'REDO':
    case 'GET_UNDO_STATE':
    case 'GET_PAGE_DATA':
      // Forward to the active tab's content script
      if (sender.tab) {
        // Message came from content script — shouldn't forward back
        break;
      }
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {
            console.warn('[DesInspect] Could not reach content script.');
          });
        }
      });
      break;

    // Side panel requesting current state
    case 'GET_INSPECTOR_STATE':
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATE' }).catch(() => {});
        }
      });
      break;

    default:
      break;
  }

  // Return true if we need async response (not needed for forwarding)
  return false;
});

// ─── Tab Navigation → Re-apply Persisted Changes ───────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Tell the content script to re-apply any saved changes for this URL
    chrome.tabs.sendMessage(tabId, {
      type: 'PAGE_LOADED',
      url: tab.url
    }).catch(() => {
      // Content script may not be injected yet on this page
    });
  }
});

// ─── SPA Navigation Detection (Belt & Suspenders) ───────────────────────────
// Catches pushState/replaceState from the browser-level API.
// The content script also monitors these directly; this is a backup
// that fires even if the content script's patches are overwritten.

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  // Only care about top-level frame navigations
  if (details.frameId !== 0) return;

  chrome.tabs.sendMessage(details.tabId, {
    type: 'SPA_NAV_CHECK',
    url: details.url
  }).catch(() => {
    // Content script may not be ready
  });
});

// ─── Side Panel Behavior ────────────────────────────────────────────────────

// Enable side panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[DesInspect] Side panel behavior error:', err));

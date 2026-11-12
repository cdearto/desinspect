/**
 * DesInspect — Service Worker
 *
 * Opens the side panel from the toolbar icon, fetches cross-origin
 * stylesheets for content scripts, and tells the side panel when a tab
 * navigates.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[DesInspect] sidePanel.setPanelBehavior failed:', err));

// Content scripts are subject to the page's CORS policy; the service worker
// can fetch any URL the extension's host_permissions cover.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'FETCH_TEXT' || typeof msg.url !== 'string') return false;
  fetch(msg.url, { credentials: 'omit' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sendResponse({ ok: true, text: await res.text() });
    })
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

// Full loads and SPA (History API) navigations both reach the side panel.
function notifyUrlChange(details: { frameId: number; tabId: number; url: string }): void {
  if (details.frameId !== 0) return;
  const push: PanelPush = { type: 'URL_CHANGED', url: details.url, tabId: details.tabId };
  chrome.runtime.sendMessage(push).catch(() => {}); // panel not open
}

chrome.webNavigation.onHistoryStateUpdated.addListener(notifyUrlChange);
chrome.webNavigation.onCommitted.addListener(notifyUrlChange);

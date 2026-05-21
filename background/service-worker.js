/**
 * DesInspect — Service Worker
 *
 * Opens the side panel when the toolbar icon is clicked, and proxies a few
 * messages between the side panel and the active tab's content script.
 */

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.warn('[DesInspect] sidePanel.setPanelBehavior failed:', err));

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.warn('[DesInspect] sidePanel.open failed:', err);
  }
});

// Relay messages from sidepanel → content script (the sidepanel doesn't always
// know which tab is active, so it can send {target: 'content'} via the SW).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'content') return false;
  (async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: 'no active tab' });
        return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, msg.payload);
      sendResponse({ ok: true, response });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true; // async response
});

// Notify the sidepanel on SPA navigation so it can refresh its view.
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.runtime
    .sendMessage({ type: 'URL_CHANGED', url: details.url, tabId: details.tabId })
    .catch(() => {});
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  chrome.runtime
    .sendMessage({ type: 'URL_CHANGED', url: details.url, tabId: details.tabId })
    .catch(() => {});
});

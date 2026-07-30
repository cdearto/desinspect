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

// Service worker handles two kinds of messages:
// 1) Relays from sidepanel → content script (target: 'content').
// 2) Fetches initiated by content scripts that need CORS bypass — in MV3,
//    content scripts are subject to the page's CORS policy, but the service
//    worker can fetch any URL the extension's host_permissions cover.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FETCH_TEXT' && typeof msg.url === 'string') {
    (async () => {
      try {
        const res = await fetch(msg.url, { credentials: 'omit' });
        if (!res.ok) {
          sendResponse({ ok: false, error: `HTTP ${res.status}` });
          return;
        }
        const text = await res.text();
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  if (msg?.target === 'content') {
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
    return true;
  }
  return false;
});

// Notify BOTH sides on navigation. chrome.runtime.sendMessage reaches
// extension pages (the sidepanel) but never content scripts — those need
// chrome.tabs.sendMessage. The content script relies on this push (plus its
// own URL poll) because history monkey-patching doesn't work from the
// isolated world.
function broadcastUrlChange(details) {
  if (details.frameId !== 0) return;
  chrome.runtime
    .sendMessage({ type: 'URL_CHANGED', url: details.url, tabId: details.tabId })
    .catch(() => {});
  chrome.tabs
    .sendMessage(details.tabId, { type: 'URL_CHANGED', url: details.url })
    .catch(() => {});
}

chrome.webNavigation.onHistoryStateUpdated.addListener(broadcastUrlChange);
chrome.webNavigation.onCommitted.addListener(broadcastUrlChange);

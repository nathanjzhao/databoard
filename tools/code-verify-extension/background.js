/*
 * background.js — service worker. Owns the toolbar badge and per-tab state.
 *
 * The content script does the actual verification (it runs in the page origin,
 * where it can hash the loaded resources). This worker just receives the
 * verdict, paints the badge for that tab, and remembers the result so the
 * popup can show it.
 */

const COLORS = {
  green: "#1a7f37",
  red: "#cf222e",
  unavailable: "#6e7781",
};
const BADGE = {
  green: "OK",
  red: "!",
  unavailable: "?",
};

/** Store per-tab so switching tabs shows the right verdict. */
function keyFor(tabId) {
  return `tab:${tabId}`;
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "code-verify-result") return;
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  const result = msg.result || { status: "unavailable" };
  const status = result.status || "unavailable";

  chrome.action.setBadgeBackgroundColor({
    tabId,
    color: COLORS[status] || COLORS.unavailable,
  });
  chrome.action.setBadgeText({ tabId, text: BADGE[status] || "?" });

  try {
    chrome.storage.session.set({ [keyFor(tabId)]: result });
  } catch {
    chrome.storage.local.set({ [keyFor(tabId)]: result });
  }
});

// Clear stale state when a tab navigates away, so the badge never lies about a
// page that is no longer showing.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(keyFor(tabId)).catch(() => {});
});

"use strict";

const STORAGE_KEY = "huDiagnosticHistory";
const MAX_HISTORY = 500;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "HU_DIAG_SAVE_RESULTS") {
    void saveResults(message.results || []).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "HU_DIAG_GET_HISTORY") {
    void getHistory().then((history) => sendResponse({ ok: true, history }));
    return true;
  }

  if (message.type === "HU_DIAG_RUN_EXECUTESCRIPT") {
    void runExecuteScriptOnTab(sender.tab?.id).then((result) => sendResponse({ ok: true, result }));
    return true;
  }

  return false;
});

async function saveResults(results) {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  const history = Array.isArray(existing[STORAGE_KEY]) ? existing[STORAGE_KEY] : [];
  const merged = [...results, ...history].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [STORAGE_KEY]: merged });
}

async function getHistory() {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(existing[STORAGE_KEY]) ? existing[STORAGE_KEY] : [];
}

async function runExecuteScriptOnTab(senderTabId) {
  const tabId = senderTabId || (await getActiveTabId());
  if (!tabId) {
    return { methodName: "chrome.scripting.executeScript", success: false, error: "No active tab" };
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const text = (document.body && document.body.innerText) || "";
      const patterns = [/HU\s*['\"]?\d+['\"]?/i, /HU[\s:_-]*(\d+)/i, /HU\s*([0-9]{6,})/i];
      let hu = null;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          hu = (match[1] || match[0]).replace(/\D+/g, "");
          break;
        }
      }
      return {
        methodName: "chrome.scripting.executeScript",
        success: Boolean(hu),
        hu,
        charCount: text.length,
        url: location.href,
        title: document.title,
        timestamp: new Date().toISOString()
      };
    }
  });

  return injection?.result || { methodName: "chrome.scripting.executeScript", success: false, error: "No result" };
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

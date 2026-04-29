"use strict";

importScripts("shift-math.js", "page-status.js");

const STATE_KEY = "huCounterState";
const MAX_EVENT_LOG = 1000;
const { DEFAULT_SETTINGS, normalizeSettings } = globalThis.HuCounterShiftMath;
const { ICON_PATHS, getIconStateForUrl } = globalThis.HuCounterPageStatus;

let writeQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void updateActiveTabIcon().catch(ignoreTabIconError);
  chrome.storage.local.get(STATE_KEY).then((data) => {
    if (!data[STATE_KEY]) {
      return chrome.storage.local.set({ [STATE_KEY]: createEmptyState() });
    }
    return updateBadge(data[STATE_KEY].count || 0);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void updateActiveTabIcon().catch(ignoreTabIconError);
  chrome.storage.local.get(STATE_KEY).then((data) => {
    updateBadge(data[STATE_KEY]?.count || 0);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void updateTabIconById(activeInfo.tabId).catch(ignoreTabIconError);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    void updateTabIcon(tabId, tab.url || changeInfo.url || "").catch(ignoreTabIconError);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "HU_COUNTER_PAGE_STATUS") {
    if (sender.tab?.id != null) {
      void setTabIcon(sender.tab.id, message.iconState || "inactive").catch(ignoreTabIconError);
    }
    return false;
  }

  if (message.type !== "HU_COUNTER_RECORD") {
    return false;
  }

  writeQueue = writeQueue
    .then(() => recordHu(message.hu))
    .then((result) => {
      sendResponse(result);
    })
    .catch((error) => {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
    });

  return true;
});

async function recordHu(hu) {
  if (!/^\d+$/.test(String(hu || ""))) {
    return { ok: false, counted: false, reason: "invalid_hu" };
  }

  const huId = String(hu);
  const data = await chrome.storage.local.get(STATE_KEY);
  const state = normalizeState(data[STATE_KEY]);

  if (state.processedHus[huId]) {
    await updateBadge(state.count);
    return { ok: true, counted: false, reason: "duplicate", count: state.count };
  }

  const now = new Date().toISOString();
  state.processedHus[huId] = now;
  state.count += 1;
  state.lastHu = huId;
  state.lastCompletedAt = now;
  state.events = [{ hu: huId, at: now }, ...state.events].slice(0, MAX_EVENT_LOG);

  await chrome.storage.local.set({ [STATE_KEY]: state });
  await updateBadge(state.count);

  return { ok: true, counted: true, count: state.count };
}

function createEmptyState() {
  return {
    count: 0,
    processedHus: {},
    lastHu: null,
    lastCompletedAt: null,
    events: [],
    settings: DEFAULT_SETTINGS
  };
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...createEmptyState(),
    ...source,
    processedHus: source && typeof source.processedHus === "object" ? source.processedHus : {},
    events: Array.isArray(source.events) ? source.events : [],
    settings: normalizeSettings(source.settings)
  };
}

async function updateBadge(count) {
  const text = count > 0 ? String(count).slice(-4) : "";
  await chrome.action.setBadgeBackgroundColor({ color: "#107c10" });
  await chrome.action.setBadgeText({ text });
}

async function updateActiveTabIcon() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (activeTab?.id != null) {
    await updateTabIcon(activeTab.id, activeTab.url || "");
  }
}

async function updateTabIconById(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await updateTabIcon(tabId, tab.url || "");
}

async function updateTabIcon(tabId, url) {
  await setTabIcon(tabId, getIconStateForUrl(url));
}

async function setTabIcon(tabId, iconState) {
  const path = ICON_PATHS[iconState] || ICON_PATHS.inactive;
  await chrome.action.setIcon({ tabId, path });
}

function ignoreTabIconError() {
  // Tabs can disappear while Chrome is still delivering tab events.
}

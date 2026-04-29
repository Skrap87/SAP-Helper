(function () {
  "use strict";

  const {
    getIconStateForUrl,
    isTargetPageUrl
  } = globalThis.HuCounterPageStatus;
  const {
    extractHuCompletion,
    normalizeText
  } = globalThis.HuCounterDetector;

  const DEBUG = false;

  const SELECTORS = {
    pageRoot: "#application-ZEWMGIP-display-component---Packing",
    dynamicPage: "#application-ZEWMGIP-display-component---Packing--dynmicPagePacking",
    messageToolbar: "#application-ZEWMGIP-display-component---Packing--messageToolbar",
    scanInput: "#application-ZEWMGIP-display-component---Packing--inputScan",
    messageStrip: ".sapMMsgStrip.sapMMsgStripSuccess .sapMMsgStripMessage"
  };

  const BOOTSTRAP_TIMEOUT_MS = 30000;
  const seenInThisPage = new Set();
  let messageObserver = null;
  let bootstrapObserver = null;
  let bootstrapTimer = null;

  start();
  window.addEventListener("hashchange", restart, { passive: true });
  window.addEventListener("pagehide", stop, { once: true });

  function start() {
    reportPageStatus();

    if (!isTargetUrl(location)) {
      debug("Skipped: URL is not target dashboard route");
      return;
    }

    const toolbar = findMessageToolbar();
    if (toolbar) {
      watchMessageToolbar(toolbar);
      return;
    }

    watchForDashboardRoot();
  }

  function restart() {
    stop();
    seenInThisPage.clear();
    start();
  }

  function stop() {
    if (messageObserver) {
      messageObserver.disconnect();
      messageObserver = null;
    }

    if (bootstrapObserver) {
      bootstrapObserver.disconnect();
      bootstrapObserver = null;
    }

    if (bootstrapTimer) {
      window.clearTimeout(bootstrapTimer);
      bootstrapTimer = null;
    }
  }

  function isTargetUrl(url) {
    return isTargetPageUrl(url);
  }

  function reportPageStatus() {
    chrome.runtime.sendMessage({
      type: "HU_COUNTER_PAGE_STATUS",
      iconState: getIconStateForUrl(location)
    }, () => {
      if (chrome.runtime.lastError) {
        debug("Page status update skipped", chrome.runtime.lastError.message);
      }
    });
  }

  function hasDashboardSignature() {
    return Boolean(
      document.querySelector(SELECTORS.pageRoot)
      && document.querySelector(SELECTORS.dynamicPage)
      && document.querySelector(SELECTORS.scanInput)
    );
  }

  function findMessageToolbar() {
    if (!hasDashboardSignature()) {
      return null;
    }

    return document.querySelector(SELECTORS.messageToolbar);
  }

  function watchForDashboardRoot() {
    const root = document.querySelector("#canvas") || document.body || document.documentElement;

    bootstrapObserver = new MutationObserver(() => {
      const toolbar = findMessageToolbar();
      if (!toolbar) {
        return;
      }

      if (bootstrapObserver) {
        bootstrapObserver.disconnect();
        bootstrapObserver = null;
      }

      if (bootstrapTimer) {
        window.clearTimeout(bootstrapTimer);
        bootstrapTimer = null;
      }

      watchMessageToolbar(toolbar);
    });

    bootstrapObserver.observe(root, { childList: true, subtree: true });
    bootstrapTimer = window.setTimeout(() => {
      if (bootstrapObserver) {
        bootstrapObserver.disconnect();
        bootstrapObserver = null;
      }
      debug("Stopped bootstrap observer after timeout");
    }, BOOTSTRAP_TIMEOUT_MS);
  }

  function watchMessageToolbar(toolbar) {
    scanNode(toolbar);

    messageObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          scanNode(mutation.target.parentElement || toolbar);
          continue;
        }

        for (const node of mutation.addedNodes) {
          scanNode(node.nodeType === Node.ELEMENT_NODE ? node : toolbar);
        }
      }
    });

    messageObserver.observe(toolbar, {
      childList: true,
      characterData: true,
      subtree: true
    });

    debug("Watching message toolbar");
  }

  function scanNode(node) {
    if (!node) {
      return;
    }

    const candidates = node.matches?.(SELECTORS.messageStrip)
      ? [node]
      : Array.from(node.querySelectorAll?.(SELECTORS.messageStrip) || []);

    if (candidates.length === 0 && node === document.querySelector(SELECTORS.messageToolbar)) {
      candidates.push(node);
    }

    for (const candidate of candidates) {
      const hu = extractHuCompletion(normalizeText(candidate.textContent));
      if (hu) {
        recordHuOnce(hu);
      }
    }
  }

  function recordHuOnce(hu) {
    if (seenInThisPage.has(hu)) {
      return;
    }

    seenInThisPage.add(hu);
    chrome.runtime.sendMessage({ type: "HU_COUNTER_RECORD", hu }, (response) => {
      if (chrome.runtime.lastError) {
        debug("Record failed", chrome.runtime.lastError.message);
        seenInThisPage.delete(hu);
        return;
      }

      if (!response?.ok) {
        debug("Record rejected", response);
      }
    });
  }

  function debug(...args) {
    if (DEBUG) {
      console.debug("[HU Counter]", ...args);
    }
  }
})();

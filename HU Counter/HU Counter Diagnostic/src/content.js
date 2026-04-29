(function () {
  "use strict";

  const METHOD_TIMEOUTS = [500, 1500, 3000];
  const HISTORY_EVENT = "HU_DIAG_SAVE_RESULTS";
  const huPatterns = [
    /^HU '(\d+)' wurde erfolgreich abgeschlossen\.$/i,
    /HU\s*['\"]?(\d+)['\"]?/i,
    /HU[\s:_-]*(\d+)/i,
    /HU\s*([0-9]{6,})/i
  ];

  const selectorsFromLegacy = [
    ".sapMMsgStrip.sapMMsgStripSuccess .sapMMsgStripMessage",
    "#application-ZEWMGIP-display-component---Packing--messageToolbar",
    "#application-ZEWMGIP-display-component---Packing--inputScan"
  ];

  const pageSignatures = [
    "#application-ZEWMGIP-display-component---Packing",
    "#application-ZEWMGIP-display-component---Packing--dynmicPagePacking",
    "#application-ZEWMGIP-display-component---Packing--messageToolbar"
  ];

  if (window.__huDiagInstalled) {
    return;
  }
  window.__huDiagInstalled = true;

  const allResults = [];
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  ensureToastContainer();
  console.info("[HU-DIAG] content script started", { href: location.href, frame: window.top === window ? "top" : "iframe" });
  runDiagnostics("initial");

  window.addEventListener("hashchange", () => runDiagnostics("hashchange"), { passive: true });

  document.addEventListener("DOMContentLoaded", () => runDiagnostics("DOMContentLoaded"), { once: true });
  window.addEventListener("load", () => runDiagnostics("window.load"), { once: true });

  METHOD_TIMEOUTS.forEach((delay) => {
    window.setTimeout(() => runDiagnostics(`delay_${delay}ms`), delay);
  });

  // MutationObserver diagnostic mode for SPA pages.
  const observer = new MutationObserver(() => {
    observer.disconnect();
    runDiagnostics("MutationObserver");
  });
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

  async function runDiagnostics(trigger) {
    const methods = [
      () => checkPageByLocationHref(trigger),
      () => checkPageByHostname(trigger),
      () => checkPageByDocumentUrl(trigger),
      () => checkPageByDocumentLocation(trigger),
      () => checkPageByTitle(trigger),
      () => checkPageByDomSignature(trigger),
      () => checkPageByBodyText(trigger),
      () => findHuByInnerText(trigger),
      () => findHuByTextContent(trigger),
      () => findHuByInnerHtml(trigger),
      () => findHuBySelectors(trigger),
      () => findHuByTreeWalker(trigger),
      () => findHuByNormalizedText(trigger),
      () => runExecuteScriptMethod(trigger)
    ];

    for (const method of methods) {
      const result = await safeRun(method);
      allResults.push(result);
      showToast(result);
    }

    console.table(allResults.slice(-methods.length));
    chrome.runtime.sendMessage({ type: HISTORY_EVENT, results: allResults.slice(-methods.length) }, () => {
      if (chrome.runtime.lastError) {
        console.warn("[HU-DIAG] save results failed", chrome.runtime.lastError.message);
      }
    });
  }

  async function safeRun(fn) {
    const started = performance.now();
    try {
      const result = await fn();
      return {
        methodName: result.methodName,
        success: Boolean(result.success),
        hu: result.hu || null,
        durationMs: Math.round(performance.now() - started),
        nodeCount: result.nodeCount || 0,
        charCount: result.charCount || 0,
        url: location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        trigger: result.trigger,
        error: null,
        runId,
        frameType: window.top === window ? "top" : "iframe"
      };
    } catch (error) {
      return {
        methodName: fn.name || "unknown",
        success: false,
        hu: null,
        durationMs: Math.round(performance.now() - started),
        nodeCount: 0,
        charCount: 0,
        url: location.href,
        title: document.title,
        timestamp: new Date().toISOString(),
        trigger: "error",
        error: String(error?.message || error),
        runId,
        frameType: window.top === window ? "top" : "iframe"
      };
    }
  }

  function checkPageByLocationHref(trigger) {
    const href = window.location.href;
    return buildPageResult("Page detect: window.location.href", /\/sap\/bc\/ui2\/flp/i.test(href), null, 0, href.length, trigger);
  }

  function checkPageByHostname(trigger) {
    const host = window.location.hostname;
    return buildPageResult("Page detect: window.location.hostname", /sap\.ugfischer\.com$/i.test(host), null, 0, host.length, trigger);
  }

  function checkPageByDocumentUrl(trigger) {
    const url = document.URL;
    return buildPageResult("Page detect: document.URL", /\/sap\/bc\/ui2\/flp/i.test(url), null, 0, url.length, trigger);
  }

  function checkPageByDocumentLocation(trigger) {
    const asText = String(document.location);
    return buildPageResult("Page detect: document.location", /Packing|flp/i.test(asText), null, 0, asText.length, trigger);
  }

  function checkPageByTitle(trigger) {
    const title = document.title || "";
    return buildPageResult("Page detect: document.title", /pack|sap|ewm|packing/i.test(title), null, 0, title.length, trigger);
  }

  function checkPageByDomSignature(trigger) {
    let nodeCount = 0;
    const success = pageSignatures.some((selector) => {
      const hit = document.querySelector(selector);
      if (hit) {
        nodeCount += 1;
      }
      return Boolean(hit);
    });
    return buildPageResult("Page detect: DOM signatures", success, null, nodeCount, 0, trigger);
  }

  function checkPageByBodyText(trigger) {
    const text = document.body?.innerText || "";
    const success = /HU|Pack|erfolgreich abgeschlossen|SAP/i.test(text);
    return buildPageResult("Page detect: body.innerText", success, null, 0, text.length, trigger);
  }

  function findHuByInnerText(trigger) {
    const text = document.body?.innerText || "";
    return huFromText("HU detect: body.innerText + regex", text, 0, trigger);
  }

  function findHuByTextContent(trigger) {
    const text = document.body?.textContent || "";
    return huFromText("HU detect: body.textContent + regex", text, 0, trigger);
  }

  function findHuByInnerHtml(trigger) {
    const html = document.documentElement?.innerHTML || "";
    return huFromText("HU detect: documentElement.innerHTML + regex", html, 0, trigger);
  }

  function findHuBySelectors(trigger) {
    let scannedNodes = 0;
    let combined = "";
    selectorsFromLegacy.forEach((selector) => {
      const nodes = document.querySelectorAll(selector);
      scannedNodes += nodes.length;
      nodes.forEach((node) => {
        combined += ` ${node.textContent || ""}`;
      });
    });
    return huFromText("HU detect: legacy selectors + regex", combined, scannedNodes, trigger);
  }

  function findHuByTreeWalker(trigger) {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    let text = "";
    let nodeCount = 0;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue || "";
      if (value.trim().length === 0) {
        continue;
      }
      nodeCount += 1;
      text += ` ${value}`;
      if (nodeCount > 8000 || text.length > 350000) {
        break;
      }
    }
    return huFromText("HU detect: TreeWalker text nodes", text, nodeCount, trigger);
  }

  function findHuByNormalizedText(trigger) {
    const normalized = normalizeText(document.body?.innerText || "");
    return huFromText("HU detect: normalized text + regex set", normalized, 0, trigger);
  }

  async function runExecuteScriptMethod(trigger) {
    const response = await chrome.runtime.sendMessage({ type: "HU_DIAG_RUN_EXECUTESCRIPT" });
    const result = response?.result || {};
    return buildPageResult(
      "HU detect: chrome.scripting.executeScript",
      Boolean(result.success),
      result.hu || null,
      0,
      result.charCount || 0,
      trigger
    );
  }

  function huFromText(methodName, text, nodeCount, trigger) {
    const hit = extractHuByPatterns(text);
    return buildPageResult(methodName, Boolean(hit), hit, nodeCount, text.length, trigger);
  }

  function extractHuByPatterns(text) {
    const source = String(text || "");
    for (const pattern of huPatterns) {
      const match = source.match(pattern);
      if (!match) {
        continue;
      }
      const candidate = match[1] || match[0];
      const digits = String(candidate).replace(/\D+/g, "");
      if (digits) {
        return digits;
      }
    }
    return null;
  }

  function buildPageResult(methodName, success, hu, nodeCount, charCount, trigger) {
    return { methodName, success, hu, nodeCount, charCount, trigger };
  }

  function normalizeText(value) {
    return String(value || "").replace(/[\u00a0\u2000-\u200d]/g, " ").replace(/\s+/g, " ").trim();
  }

  function ensureToastContainer() {
    if (document.getElementById("hu-diag-toast-container")) {
      return;
    }
    const container = document.createElement("div");
    container.id = "hu-diag-toast-container";
    document.documentElement.appendChild(container);
  }

  function showToast(result) {
    const container = document.getElementById("hu-diag-toast-container");
    if (!container) {
      return;
    }

    const toast = document.createElement("div");
    toast.className = `hu-diag-toast ${result.success ? "success" : "fail"}`;
    toast.textContent = `Метод: ${result.methodName} | Успех: ${result.success ? "да" : "нет"} | HU: ${result.hu || "-"} | Время: ${result.durationMs} ms | Узлов: ${result.nodeCount} | Символов: ${result.charCount}`;

    container.appendChild(toast);
    window.setTimeout(() => toast.remove(), 5000);
  }
})();

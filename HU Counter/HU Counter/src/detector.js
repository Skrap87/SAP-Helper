(function (root) {
  "use strict";

  const HU_COMPLETION_PATTERN = /^HU '(\d+)' wurde erfolgreich abgeschlossen\.$/;

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function extractHuCompletion(text) {
    const match = normalizeText(text).match(HU_COMPLETION_PATTERN);
    return match ? match[1] : null;
  }

  const api = {
    HU_COMPLETION_PATTERN,
    extractHuCompletion,
    normalizeText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.HuCounterDetector = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

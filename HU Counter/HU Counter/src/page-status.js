(function (root) {
  "use strict";

  const TARGET = {
    protocol: "https:",
    hostname: "vhfiwp61ci.sap.ugfischer.com",
    port: "44300",
    pathname: "/sap/bc/ui2/flp",
    hashPrefix: "#ZEWMGIP-display"
  };

  const ICON_PATHS = {
    active: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    inactive: {
      "16": "icons/icon-16-disabled.png",
      "32": "icons/icon-32-disabled.png",
      "48": "icons/icon-48-disabled.png",
      "128": "icons/icon-128-disabled.png"
    }
  };

  function toUrl(value) {
    if (value && typeof value === "object" && typeof value.protocol === "string") {
      return value;
    }

    try {
      return new URL(String(value || ""));
    } catch (_error) {
      return null;
    }
  }

  function isTargetPageUrl(value) {
    const url = toUrl(value);
    return Boolean(
      url
      && url.protocol === TARGET.protocol
      && url.hostname === TARGET.hostname
      && url.port === TARGET.port
      && url.pathname === TARGET.pathname
      && url.hash.startsWith(TARGET.hashPrefix)
    );
  }

  function getIconStateForUrl(value) {
    return isTargetPageUrl(value) ? "active" : "inactive";
  }

  const api = {
    TARGET,
    ICON_PATHS,
    getIconStateForUrl,
    isTargetPageUrl
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.HuCounterPageStatus = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

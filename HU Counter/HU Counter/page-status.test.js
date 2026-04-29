const assert = require("assert");
const {
  isTargetPageUrl,
  getIconStateForUrl,
  ICON_PATHS
} = require("./src/page-status");

const targetUrl = "https://vhfiwp61ci.sap.ugfischer.com:44300/sap/bc/ui2/flp#ZEWMGIP-display&/packing";

assert.strictEqual(isTargetPageUrl(targetUrl), true, "accepts the Packplatz route");
assert.strictEqual(
  isTargetPageUrl("https://vhfiwp61ci.sap.ugfischer.com:44300/sap/bc/ui2/flp#ZEWMGIC-display"),
  false,
  "rejects a different SAP route"
);
assert.strictEqual(
  isTargetPageUrl("https://vhfiwp61ci.sap.ugfischer.com/sap/bc/ui2/flp#ZEWMGIP-display"),
  false,
  "rejects the same route on the wrong port"
);
assert.strictEqual(isTargetPageUrl("not a url"), false, "rejects invalid URL text");

assert.strictEqual(getIconStateForUrl(targetUrl), "active", "target URL uses active icon");
assert.strictEqual(getIconStateForUrl("https://example.com/"), "inactive", "other URL uses inactive icon");

for (const size of ["16", "32", "48", "128"]) {
  assert.strictEqual(
    ICON_PATHS.active[size],
    `icons/icon-${size}.png`,
    `active ${size}px path stays manifest-compatible`
  );
  assert.strictEqual(
    ICON_PATHS.inactive[size],
    `icons/icon-${size}-disabled.png`,
    `inactive ${size}px path points to disabled PNG`
  );
}

console.log("3 page status tests passed");

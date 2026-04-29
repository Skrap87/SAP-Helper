const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { DEFAULT_SETTINGS } = require("./src/shift-math");

const popupHtml = fs.readFileSync(path.join(__dirname, "popup", "popup.html"), "utf8");
const popupJs = fs.readFileSync(path.join(__dirname, "popup", "popup.js"), "utf8");

const visibleDefaults = JSON.stringify(DEFAULT_SETTINGS);

for (const outdatedText of ["Rueckstand", "Fruehschicht", "Spaetschicht", "Ausserhalb"]) {
  assert.ok(!visibleDefaults.includes(outdatedText), `default German text avoids "${outdatedText}"`);
}
assert.ok(!popupHtml.includes("resetButton"), "popup does not render a reset button");
assert.ok(!popupJs.includes("resetCounter"), "popup does not keep reset handler logic");
assert.ok(!popupHtml.includes("Arbeitszeit"), "popup does not render elapsed work-time metric");
assert.ok(!popupHtml.includes("workTime"), "popup does not keep work-time placeholder");
assert.ok(!popupHtml.includes("Plan jetzt"), "popup does not render current-plan legend");
assert.ok(!popupHtml.includes("delta"), "popup does not render plan delta placeholder");
assert.ok(!popupJs.includes("expectedNow"), "popup does not display current-plan expected values");

console.log("3 popup UI tests passed");

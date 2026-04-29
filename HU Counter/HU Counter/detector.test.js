const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractHuCompletion } = require("./src/detector");

const cases = [
  {
    name: "detects the exact completion message",
    text: "HU '140450442019611367' wurde erfolgreich abgeschlossen.",
    expected: "140450442019611367"
  },
  {
    name: "ignores label print success messages",
    text: "Druck des Labels 'SHIP - Versandlabel' fuer HU '140450442019611367' wurde angestossen.",
    expected: null
  },
  {
    name: "ignores non-numeric HU values",
    text: "HU 'ABC123' wurde erfolgreich abgeschlossen.",
    expected: null
  },
  {
    name: "detects message inside surrounding whitespace",
    text: "  HU '123456789' wurde erfolgreich abgeschlossen.  ",
    expected: "123456789"
  }
];

for (const testCase of cases) {
  assert.strictEqual(
    extractHuCompletion(testCase.text),
    testCase.expected,
    testCase.name
  );
}

const fixtureCases = [
  {
    name: "does not count the before-completion fixture",
    file: "../Packplatz-vor-abschluss.html",
    expected: []
  },
  {
    name: "counts the after-completion fixture",
    file: "../Packplatz-erfolgreich.html",
    expected: ["140450442019611367"]
  }
];

for (const fixtureCase of fixtureCases) {
  const html = fs.readFileSync(path.join(__dirname, fixtureCase.file), "utf8");
  const stripTexts = [...html.matchAll(/<div id="__strip\d+-content" class="sapMMsgStripMessage"><span[^>]*>([\s\S]*?)<\/span><\/div>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, "").trim());

  assert.deepStrictEqual(
    stripTexts.map(extractHuCompletion).filter(Boolean),
    fixtureCase.expected,
    fixtureCase.name
  );
}

console.log(`${cases.length + fixtureCases.length} detector tests passed`);

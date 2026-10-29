import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The desktop's local server keeps a copy of the safe scoring-formula
// evaluator (it can't import the cloud API's code). Both must score alike.
test("the desktop copy of the scoring-formula evaluator matches the cloud's", () => {
  const cloud = readFileSync(new URL("./safeFormula.ts", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../../../local-server/src/lib/safeFormula.ts", import.meta.url), "utf8");
  // The copy adds a 2-line note at the top.
  assert.equal(desktop.split("\n").slice(2).join("\n"), cloud);
});

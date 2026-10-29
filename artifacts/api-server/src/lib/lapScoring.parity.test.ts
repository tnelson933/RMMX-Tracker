import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// The desktop's local server keeps a copy of the lap scoring rules (it can't
// import the cloud API's code). Both must score a race the same way.
test("the desktop copy of the lap scoring rules matches the cloud's", () => {
  const cloud = readFileSync(new URL("./lapScoring.ts", import.meta.url), "utf8");
  const desktop = readFileSync(new URL("../../../local-server/src/lib/lapScoring.ts", import.meta.url), "utf8");
  // The copy adds a 3-line note at the top of the header comment.
  const desktopBody = desktop.split("\n").filter((_, i) => i < 1 || i > 3).join("\n");
  assert.equal(desktopBody, cloud);
});

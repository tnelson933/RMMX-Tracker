import assert from "node:assert/strict";
import test from "node:test";
import { formatLap, statsTableHtml } from "./raceDayStats";

test("lap times (stored in ms) read as minutes:seconds", () => {
  assert.equal(formatLap(28000), "0:28.000");
  assert.equal(formatLap(128450), "2:08.450");
  assert.equal(formatLap(0), "—");
});

test("stats table: finish, best lap highlighted, names escaped", () => {
  const html = statsTableHtml([{ motoName: "<b>Moto 1</b>", raceClass: "250 B", position: 2, totalTime: "8:42.310", lapTimesMs: [131200, 128450], points: 22, dnf: false, dns: false }]);
  assert.match(html, /2nd/);
  assert.match(html, /Best 2:08\.450/);
  assert.match(html, /&lt;b&gt;Moto 1&lt;\/b&gt;/);
  assert.match(statsTableHtml([{ motoName: "M", raceClass: "A", position: 0, totalTime: null, lapTimesMs: [], points: null, dnf: true, dns: false }]), /DNF/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
// @ts-expect-error Node's type-stripping runner requires the explicit extension.
import { WebmStreamParser, type WebmUnit } from "./webmStream.ts";

const fixture = JSON.parse(readFileSync(new URL("./__fixtures__/chrome-vp9-slices.json", import.meta.url), "utf8")) as { chunks: string[] };
const slices = fixture.chunks.map(c => Buffer.from(c, "base64"));
const whole = Buffer.concat(slices);

function run(parts: Buffer[]): WebmUnit[] {
  const p = new WebmStreamParser();
  return parts.flatMap(b => p.push(b));
}

test("Chrome's slices become an init segment then whole media units", () => {
  // Chrome's first slice is often a single byte: start mid-header too.
  const units = run([slices[0].subarray(0, 1), slices[0].subarray(1), ...slices.slice(1)]);
  assert.equal(units[0].kind, "init");
  assert.deepEqual([...units[0].data.subarray(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  const first = units[1];
  assert.ok(first.kind === "media" && first.clusterStart && first.keyframe, "first media unit opens on a keyframe");
  assert.deepEqual([...first.data.subarray(0, 4)], [0x1f, 0x43, 0xb6, 0x75]);
  const keyframes = units.filter(u => u.kind === "media" && u.keyframe).length;
  assert.ok(keyframes >= 2, `expected a periodic keyframe, got ${keyframes}`);
});

test("output is byte-identical to the input however it is sliced", () => {
  const units = run(slices);
  const out = Buffer.concat(units.map(u => u.data));
  // Everything up to the last complete element comes out, in order.
  assert.ok(out.length > whole.length - 64 * 1024);
  assert.ok(whole.subarray(0, out.length).equals(out));

  for (const size of [1, 7, 1000, 65536]) {
    const parts: Buffer[] = [];
    for (let i = 0; i < whole.length; i += size) parts.push(whole.subarray(i, i + size));
    const again = Buffer.concat(run(parts).map(u => u.data));
    assert.ok(again.equals(out), `slices of ${size} bytes`);
  }
});

test("a viewer can start at any keyframe unit: init plus everything from there", () => {
  const units = run(slices);
  const init = units[0].data;
  const lastKey = units.map(u => u.kind === "media" && u.keyframe).lastIndexOf(true);
  assert.ok(lastKey > 1);
  const joined = Buffer.concat([init, ...units.slice(lastKey).map(u => u.data)]);
  // Re-parsing what a late joiner receives yields a clean stream starting on a keyframe.
  const replay = run([joined]);
  assert.equal(replay[0].kind, "init");
  assert.ok(replay[1].kind === "media" && replay[1].keyframe);
});

test("a restarted recorder (new EBML header) starts a fresh init segment", () => {
  // The old recorder's unfinished tail is never sent, so the restart lands on an element boundary.
  const complete = Buffer.concat(run(slices.slice(0, 4)).map(u => u.data));
  const units = run([complete, ...slices.slice(0, 3)]);
  assert.equal(units.filter(u => u.kind === "init").length, 2);
});

test("garbage instead of an EBML header is rejected", () => {
  const p = new WebmStreamParser();
  assert.throws(() => p.push(Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x80, 0x00])));
});

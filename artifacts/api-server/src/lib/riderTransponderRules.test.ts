import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTransponderNumber,
  parseTransponderInput,
  toTransponderViews,
  transponderTakenMessage,
} from "./riderTransponderRules";

test("numbers are stored trimmed and lower-case", () => {
  assert.equal(normalizeTransponderNumber("  AB12F "), "ab12f");
  assert.equal(normalizeTransponderNumber("   "), null);
  assert.equal(normalizeTransponderNumber(null), null);
});

test("an RM TrackR is the default kind and must be an RM TrackR ID", () => {
  assert.deepEqual(parseTransponderInput({ number: " 1A2B3C " }), { ok: true, number: "1a2b3c", kind: "trackr", label: null });
  const bad = parseTransponderInput({ number: "XYZ" });
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /RM TrackR/);
  assert.equal(parseTransponderInput({ number: "1234567890" }).ok, false, "ten characters is too long for an RM TrackR");
});

test("an RFID sticker takes letters and numbers, with a label", () => {
  assert.deepEqual(
    parseTransponderInput({ number: "E200-ABC9", kind: "rfid", label: "  YZ250F  " }),
    { ok: true, number: "e200-abc9", kind: "rfid", label: "YZ250F" },
  );
  assert.equal(parseTransponderInput({ number: "E2 00", kind: "rfid" }).ok, false);
  assert.equal(parseTransponderInput({ number: "", kind: "rfid" }).ok, false);
  assert.equal(parseTransponderInput({ number: "1", kind: "bogus" }).ok, false);
});

test("the older transponderNumber field name is accepted", () => {
  assert.deepEqual(parseTransponderInput({ transponderNumber: "abc" }), { ok: true, number: "abc", kind: "trackr", label: null });
});

const owner = { riderId: 12, firstName: "Jane", lastName: "Doe", isPublic: true };

test("organizers are told exactly who has a taken number", () => {
  const msg = transponderTakenMessage("1a2b", "trackr", owner, "organizer");
  assert.match(msg, /RM TrackR 1A2B is already assigned to Jane Doe \(rider #12\)/);
});

test("a rider's own account manager sees the full name", () => {
  assert.match(transponderTakenMessage("1a2b", "trackr", owner, "manager"), /Jane Doe's profile/);
});

test("another rider sees a public profile's first name and initial only, and nothing for a private one", () => {
  const pub = transponderTakenMessage("e200", "rfid", owner, "rider");
  assert.match(pub, /RFID sticker E200 is already assigned to Jane D\. Check the number/);
  assert.doesNotMatch(pub, /Doe|#12/);
  const priv = transponderTakenMessage("e200", "rfid", { ...owner, isPublic: false }, "rider");
  assert.match(priv, /assigned to another rider/);
  assert.doesNotMatch(priv, /Jane/);
});

test("views are oldest first, upper-case, with the oldest of each kind as primary", () => {
  const views = toTransponderViews([
    { id: 7, transponderNumber: "bbb", kind: "trackr", label: "KX450" },
    { id: 3, transponderNumber: "aaa", kind: "trackr", label: null },
    { id: 5, transponderNumber: "e200", kind: "rfid", label: null },
  ]);
  assert.deepEqual(views.map(v => [v.number, v.kind, v.primary]), [
    ["AAA", "trackr", true],
    ["E200", "rfid", true],
    ["BBB", "trackr", false],
  ]);
  assert.equal(views[2].label, "KX450");
  assert.equal(views[0].kindName, "RM TrackR");
});

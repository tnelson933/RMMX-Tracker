import assert from "node:assert/strict";
import test from "node:test";
import { hasRequiredTags, splitRegistrationTag, timingTagsFromReaders, timingTagsLabel } from "./eventTimingTags";

test("the event's own readers decide which tags riders need", () => {
  assert.deepEqual(timingTagsFromReaders([["active_transponder", "rfid"], ["rfid"], []]), { transponder: true, rfid: true, fromReaders: true });
  assert.deepEqual(timingTagsFromReaders([["active_transponder"], ["rfid"], ["rfid"]]), { transponder: true, rfid: false, fromReaders: true });
});

test("falls back to the track's course map, then the club's readers", () => {
  assert.deepEqual(timingTagsFromReaders([[], ["rfid"], ["active_transponder"]]), { transponder: false, rfid: true, fromReaders: true });
  assert.deepEqual(timingTagsFromReaders([[], [], ["active_transponder"]]), { transponder: true, rfid: false, fromReaders: true });
});

test("with no readers set up, either kind may be used", () => {
  assert.deepEqual(timingTagsFromReaders([[], [], []]), { transponder: true, rfid: true, fromReaders: false });
});

test("a rider needs every kind the readers use, or any one when none are set up", () => {
  const both = { transponder: true, rfid: true, fromReaders: true };
  assert.equal(hasRequiredTags(both, { transponder: true, rfid: false }), false);
  assert.equal(hasRequiredTags(both, { transponder: true, rfid: true }), true);
  const loopOnly = { transponder: true, rfid: false, fromReaders: true };
  assert.equal(hasRequiredTags(loopOnly, { transponder: true, rfid: false }), true);
  assert.equal(hasRequiredTags(loopOnly, { transponder: false, rfid: true }), false);
  const none = { transponder: true, rfid: true, fromReaders: false };
  assert.equal(hasRequiredTags(none, { transponder: false, rfid: true }), true);
  assert.equal(hasRequiredTags(none, { transponder: false, rfid: false }), false);
});

test("labels", () => {
  assert.equal(timingTagsLabel({ transponder: true, rfid: true, fromReaders: true }), "RM TrackR + RFID");
  assert.equal(timingTagsLabel({ transponder: true, rfid: false, fromReaders: true }), "RM TrackR");
  assert.equal(timingTagsLabel({ transponder: false, rfid: true, fromReaders: true }), "RFID");
});

test("an old RFID sticker number in the transponder field is a sticker, not a bad transponder", () => {
  assert.deepEqual(splitRegistrationTag("E28011700000020A1B2C3D4E"), { transponder: null, sticker: "E28011700000020A1B2C3D4E" });
  assert.deepEqual(splitRegistrationTag("1a2b3c"), { transponder: "1a2b3c", sticker: null });
  assert.deepEqual(splitRegistrationTag("  "), { transponder: null, sticker: null });
  assert.deepEqual(splitRegistrationTag(null), { transponder: null, sticker: null });
});

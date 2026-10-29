import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUICK_CHECKIN_REQUIREMENTS,
  hasStickerBesidesTransponder,
  parseQuickCheckinRequirements,
  quickCheckinIneligibleReason,
  quickCheckinRequirements,
} from "./quickCheckinRequirements";

const LOOP_ONLY = { transponder: true, rfid: false, fromReaders: true };
const RFID_ONLY = { transponder: false, rfid: true, fromReaders: true };
const BOTH = { transponder: true, rfid: true, fromReaders: true };
const NO_READERS = { transponder: true, rfid: true, fromReaders: false };

const ready = {
  registrationConfirmed: true, tags: LOOP_ONLY, hasRfid: false, hasTransponder: true,
  waiverRequired: true, waiverSigned: true, needsPickup: false,
};

test("an unset or partial setting keeps every other requirement on", () => {
  assert.deepEqual(quickCheckinRequirements(null), DEFAULT_QUICK_CHECKIN_REQUIREMENTS);
  assert.deepEqual(quickCheckinRequirements({ paid: false }), { ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS, paid: false });
  assert.deepEqual(quickCheckinRequirements({ paid: "no" }), DEFAULT_QUICK_CHECKIN_REQUIREMENTS);
});

test("organizer input is validated", () => {
  assert.deepEqual(parseQuickCheckinRequirements({ waiver: false }), { value: { ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS, waiver: false } });
  assert.deepEqual(parseQuickCheckinRequirements(null), { value: null });
  assert.ok("error" in parseQuickCheckinRequirements({ bib: true }));
  assert.ok("error" in parseQuickCheckinRequirements({ paid: 1 }));
  assert.ok("error" in parseQuickCheckinRequirements([true]));
});

test("every requirement on: the first unmet one is reported", () => {
  const all = DEFAULT_QUICK_CHECKIN_REQUIREMENTS;
  assert.equal(quickCheckinIneligibleReason(all, ready), null);
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, registrationConfirmed: false }), "payment_required");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, hasTransponder: false }), "missing_transponder");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: RFID_ONLY }), "missing_rfid");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, waiverSigned: false }), "missing_waiver");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, waiverRequired: false, waiverSigned: false }), null);
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, needsPickup: true }), "pickup_required");
});

test("a requirement turned off is skipped", () => {
  const none = { paid: false, timing: false, waiver: false, pickup: false, atTrack: false };
  assert.equal(quickCheckinIneligibleReason(none, {
    registrationConfirmed: false, tags: RFID_ONLY, hasRfid: false, hasTransponder: false,
    waiverRequired: true, waiverSigned: false, needsPickup: true,
  }), null);
  assert.equal(
    quickCheckinIneligibleReason({ ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS, timing: false }, { ...ready, hasTransponder: false, waiverSigned: false }),
    "missing_waiver",
  );
});

test("mixed hardware: a rider needs a tag for each kind of reader on the course", () => {
  const all = DEFAULT_QUICK_CHECKIN_REQUIREMENTS;
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: BOTH, hasRfid: false }), "missing_rfid");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: BOTH, hasTransponder: false, hasRfid: true }), "missing_transponder");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: BOTH, hasRfid: true }), null);
  // No readers set up yet: either kind will do.
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: NO_READERS, hasTransponder: false, hasRfid: true }), null);
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, tags: NO_READERS, hasTransponder: false }), "missing_transponder");
});

test("an old sticker row holding the transponder number isn't a sticker", () => {
  assert.equal(hasStickerBesidesTransponder(["1A2B3C"], "1a2b3c"), false);
  assert.equal(hasStickerBesidesTransponder(["1A2B3C", "E280"], "1a2b3c"), true);
  assert.equal(hasStickerBesidesTransponder(["E280"], null), true);
  assert.equal(hasStickerBesidesTransponder([], "1a2b3c"), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUICK_CHECKIN_REQUIREMENTS,
  parseQuickCheckinRequirements,
  quickCheckinIneligibleReason,
  quickCheckinRequirements,
} from "./quickCheckinRequirements";

const ready = {
  registrationConfirmed: true, timingTechnology: "active_transponder", hasRfid: false, hasTransponder: true,
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
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, timingTechnology: "rfid" }), "missing_rfid");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, waiverSigned: false }), "missing_waiver");
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, waiverRequired: false, waiverSigned: false }), null);
  assert.equal(quickCheckinIneligibleReason(all, { ...ready, needsPickup: true }), "pickup_required");
});

test("a requirement turned off is skipped", () => {
  const none = { paid: false, timing: false, waiver: false, pickup: false, atTrack: false };
  assert.equal(quickCheckinIneligibleReason(none, {
    registrationConfirmed: false, timingTechnology: "rfid", hasRfid: false, hasTransponder: false,
    waiverRequired: true, waiverSigned: false, needsPickup: true,
  }), null);
  assert.equal(
    quickCheckinIneligibleReason({ ...DEFAULT_QUICK_CHECKIN_REQUIREMENTS, timing: false }, { ...ready, hasTransponder: false, waiverSigned: false }),
    "missing_waiver",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { quote, soloGearProblem, teamGearProblem, EMPTY_GEAR, type RegisterInfo, type Selection } from "./registration";

const base = {
  id: 1, clubId: 1, name: "Test", date: "2026-12-01", location: null, trackName: null, clubName: "Club", status: "registration_open",
  raceClasses: ["A", "B"], classDetails: null, entryFee: 40, currentEntryFee: 35, earlyBirdActive: true, earlyBirdFee: 35, earlyBirdEndsAt: "2026-12-30",
  paymentEnabled: true, requireAma: false, requireClubId: false, requireWaiver: false, requireLiabilityWaiver: false, requireTransponder: false,
  registrationOpen: null, registrationClose: null, transponderRentalEnabled: true, transponderRentalFee: 10, rfidStickerFee: 5,
  purchaseOptions: [{ id: "rm-trackr", name: "RM TrackR", amount: 120 }, { id: "shirt", name: "Shirt", amount: "20" }],
  contingencyBrands: null, noDuplicateBibs: false, groupRace: false, ridersPerGroup: null, timingTags: { transponder: true, rfid: true },
  waiverText: null, waiverPdfUrl: null, liabilityWaiverText: null, liabilityWaiverPdfUrl: null,
} satisfies RegisterInfo;
const sel = (p: Partial<Selection> = {}): Selection => ({ classes: ["A"], trackrChoice: "", rfidSticker: false, options: [], team: [], comp: null, ...p });

test("uses today's fee from the server, per class", () => {
  assert.equal(quote(base, sel({ classes: ["A", "B"] })).totalCents, 7000);
});

test("codes discount entry fees only, capped at the entry total", () => {
  const q = quote(base, sel({ trackrChoice: "rent", comp: { amount: 100, discountType: "fixed" } }));
  assert.equal(q.discountCents, 3500);
  assert.equal(q.totalCents, 1000);
  assert.equal(quote(base, sel({ comp: { amount: 10, discountType: "percentage" } })).totalCents, 3150);
});

test("buying an RM TrackR, a sticker and add-ons", () => {
  const q = quote(base, sel({ trackrChoice: "buy", rfidSticker: true, options: ["shirt"] }));
  assert.equal(q.totalCents, 3500 + 12000 + 500 + 2000);
});

test("the RM TrackR isn't also offered as a plain add-on", () => {
  assert.equal(quote(base, sel({ options: ["rm-trackr"] })).totalCents, 3500);
});

test("pay at the gate when online payment is off", () => {
  const q = quote({ ...base, paymentEnabled: false }, sel());
  assert.equal(q.payOnline, false);
  assert.equal(q.totalCents, 3500);
});

test("group race gear is counted per rider", () => {
  const info = { ...base, groupRace: true, ridersPerGroup: 3 };
  const team = [{ ...EMPTY_GEAR, trackrChoice: "rent" as const }, { ...EMPTY_GEAR, trackrChoice: "buy" as const, buyRfid: true }, { ...EMPTY_GEAR, buyRfid: true, rfidNumber: "X1" }];
  assert.equal(quote(info, sel({ team })).totalCents, 3500 + 1000 + 12000 + 500);
  assert.match(teamGearProblem({ ...info, requireTransponder: true }, team) ?? "", /rider 3/);
});

test("own transponder numbers must be valid", () => {
  assert.ok(soloGearProblem(base, "own", "xyz"));
  assert.equal(soloGearProblem(base, "own", "A1B2C3"), null);
  assert.ok(soloGearProblem({ ...base, requireTransponder: true }, "", ""));
});

// Run from scripts/: ./node_modules/.bin/tsx --test ../artifacts/rider-app/lib/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { riderBike, riderBikeLabel } from "./bike";

test("the main garage bike wins, then any garage bike, then the profile's own bike", () => {
  const garage = [
    { bikeYear: "2022", bikeManufacturer: "Yamaha", bikeModel: "YZ125", isDefault: false },
    { bikeYear: "2024", bikeManufacturer: "KTM", bikeModel: "250 SX-F", isDefault: true },
  ];
  assert.equal(riderBikeLabel({ bikeManufacturer: "Honda", bikes: garage }), "2024 KTM 250 SX-F");
  assert.equal(riderBikeLabel({ bikes: [garage[0]] }), "2022 Yamaha YZ125");
  // Entered in Edit profile or at registration only: the garage is empty.
  assert.equal(riderBikeLabel({ bikeYear: "2019", bikeManufacturer: "Honda", bikeModel: "CRF250R", bikes: [] }), "2019 Honda CRF250R");
  assert.equal(riderBikeLabel({ bikeManufacturer: "Honda", bikeModel: null, bikeYear: null }), "Honda");
});

test("no bike anywhere is empty, not a crash", () => {
  assert.equal(riderBike(null), null);
  assert.equal(riderBike(undefined), null);
  assert.equal(riderBikeLabel({ bikes: null }), "");
  assert.equal(riderBikeLabel({ bikeManufacturer: "", bikeModel: null, bikes: [] }), "");
  // An "Unnamed bike" row in the garage doesn't hide the bike on the profile.
  assert.equal(riderBikeLabel({ bikeManufacturer: "KTM", bikes: [{ bikeManufacturer: null, bikeModel: null, bikeYear: null, isDefault: true }] }), "KTM");
});

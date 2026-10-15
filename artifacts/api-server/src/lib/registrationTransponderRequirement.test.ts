import assert from "node:assert/strict";
import test from "node:test";

// Node's built-in type-stripping test runner requires the explicit extension.
// @ts-expect-error TypeScript's bundler resolution does not allow it by default.
import { isRegistrationTransponderRequirementSatisfied } from "./registrationTransponderRequirement.ts";

test("allows a blank transponder when the event setting is off", () => {
  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      {
        timingTechnology: "active_transponder",
        requireTransponder: false,
        transponderRentalEnabled: false,
      },
      { transponderNumber: "", rentTransponder: false },
    ),
    true,
  );
});

test("requires a personal transponder or available rental when the setting is on", () => {
  const requiredEvent = {
    timingTechnology: "active_transponder",
    requireTransponder: true,
    transponderRentalEnabled: true,
  };

  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      requiredEvent,
      { transponderNumber: "", rentTransponder: false },
    ),
    false,
  );
  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      requiredEvent,
      { transponderNumber: "1A420074", rentTransponder: false },
    ),
    true,
  );
  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      requiredEvent,
      { transponderNumber: "", rentTransponder: true },
    ),
    true,
  );
});

test("does not accept a rental that the event does not offer", () => {
  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      {
        timingTechnology: "mylaps",
        requireTransponder: true,
        transponderRentalEnabled: false,
      },
      { transponderNumber: "", rentTransponder: true },
    ),
    false,
  );
});

test("does not require active transponders for passive RFID events", () => {
  assert.equal(
    isRegistrationTransponderRequirementSatisfied(
      {
        timingTechnology: "rfid",
        requireTransponder: true,
        transponderRentalEnabled: false,
      },
      { transponderNumber: "", rentTransponder: false },
    ),
    true,
  );
});